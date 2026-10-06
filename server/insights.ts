import type { Database } from 'bun:sqlite';
import type { HealthResponse, ProblemsResponse, Problem, QuotaObservation } from './api';
import type { SessionRow } from './db';
import { json, object, string, number } from './model';
import { authStates, authIssues, type AuthTransition } from './auth';
import { classify, sanitize, type ErrorClass } from './telemetry/events';

const windows = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
export type Window = keyof typeof windows;
export function windowStart(value: string | null, now: number): number {
  const window = value || '24h';
  if (!Object.hasOwn(windows, window)) throw new Error('Window must be 1h, 24h or 7d');
  return now - windows[window as Window];
}
export type EventRow = {
  id: number;
  received: number;
  time: number;
  provider: string;
  model: string;
  authIndex: string;
  transport: string;
  payload: string;
};
function events(db: Database, table: 'usage_event' | 'error_event', since: number, now: number) {
  // ponytail: one window in memory; move aggregation into SQL if telemetry volume outgrows it.
  return db
    .query<EventRow, [number, number]>(
      `SELECT * FROM ${table} WHERE time>=? AND time<=? ORDER BY time,id`
    )
    .all(since, now);
}
export function usageFailure(event: Record<string, unknown>) {
  const fail = object(event.fail);
  let body = {};
  try {
    body = json(string(fail.body));
  } catch {
    /* Some upstream errors are plain text. */
  }
  const error = object(object(body).error);
  return {
    status_code: number(fail.status_code),
    code: string(error.code) || string(error.type) || string(object(body).code),
    body: string(error.message) || string(fail.body),
  };
}
export type Outcome = 'retried' | 'inferred_final' | 'unresolved';
export function parseRetryWindow(value: string | undefined): number {
  const milliseconds = Number(value ?? 35) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw new Error('CPA_RETRY_WINDOW_SECONDS must be a finite positive number');
  return milliseconds;
}
// CPA reuses request IDs across websocket turns. A nearby attempt can indicate a retry.
export function failureOutcomes(
  rows: EventRow[],
  now: number,
  retryWindow = 35000
): Map<number, Outcome> {
  const finalThreshold = Math.max(60000, retryWindow + 5000);
  const outcomes = new Map<number, Outcome>(),
    attempts = new Map<string, number[]>();
  for (const row of rows) {
    const event = json(row.payload),
      id = string(event.trace_id) || string(event.request_id);
    if (id) {
      const times = attempts.get(id) || [];
      times.push(row.time);
      attempts.set(id, times);
    }
  }
  for (const row of rows) {
    const event = json(row.payload);
    if (event.failed !== true) continue;
    const id = string(event.trace_id) || string(event.request_id),
      times = attempts.get(id),
      end = row.time + Math.max(0, number(event.latency_ms));
    const retried = times?.some(
      (time) => time > row.time && time >= end && time <= end + retryWindow
    );
    outcomes.set(
      row.id,
      !id || !times
        ? 'unresolved'
        : retried
          ? 'retried'
          : times.filter((time) => time === row.time).length > 1
            ? 'unresolved'
            : now - row.received >= finalThreshold
              ? 'inferred_final'
              : 'unresolved'
    );
  }
  return outcomes;
}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
function metric(event: Record<string, unknown>, key: string): number[] {
  const value = event[key];
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    (key !== 'ttft_ms' || value > 0)
    ? [value]
    : [];
}
export function aggregate(usage: EventRow[], errors: EventRow[]) {
  const latency: number[] = [],
    ttft: number[] = [];
  const errorCounts: Record<ErrorClass, number> = {
    auth: 0,
    quota: 0,
    upstream: 0,
    transport: 0,
    client: 0,
    other: 0,
  };
  let failures = 0,
    tokens = 0,
    websocket = 0,
    http = 0,
    unknown = 0;
  for (const row of usage) {
    const event = json(row.payload);
    latency.push(...metric(event, 'latency_ms'));
    ttft.push(...metric(event, 'ttft_ms'));
    const breakdown = object(event.token_breakdown);
    tokens += Math.max(
      0,
      number(
        breakdown.schema_version === 2 && typeof breakdown.total_tokens === 'number'
          ? breakdown.total_tokens
          : object(event.tokens).total_tokens
      )
    );
    if (event.failed === true) failures++;
    if (row.transport === 'websocket') websocket++;
    else if (row.transport === 'http') http++;
    else unknown++;
  }
  // Channel counts stay separate because errors lack IDs for reliable deduplication.
  const usageErrorCounts = { ...errorCounts };
  for (const row of usage) {
    const event = json(row.payload);
    if (event.failed === true) usageErrorCounts[classify(usageFailure(event))]++;
  }
  for (const row of errors) errorCounts[classify(json(row.payload))]++;
  return {
    requests: usage.length,
    failures,
    failureRate: usage.length ? failures / usage.length : 0,
    latency: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    ttft: { p50: percentile(ttft, 0.5), p95: percentile(ttft, 0.95) },
    tokens,
    websocket,
    http,
    unknown,
    errorCounts,
    usageErrorCounts,
  };
}
// Keep only backend-declared quota readings at the API boundary.
function quotaObservation(value: unknown): QuotaObservation | null {
  const quota = object(value);
  if (!Object.keys(quota).length) return null;
  const signals = Object.fromEntries(
    Object.entries(object(quota.signals)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  return {
    ...(typeof quota.observed_at === 'string' ? { observed_at: quota.observed_at } : {}),
    ...(Object.keys(signals).length ? { signals } : {}),
  };
}
export function health(db: Database, window: string | null, now = Date.now()): HealthResponse {
  const since = windowStart(window, now),
    usage = events(db, 'usage_event', since, now),
    errors = events(db, 'error_event', since, now),
    states = authStates(db);
  const providers = [
    ...new Set([
      ...usage.map((e) => e.provider),
      ...errors.map((e) => e.provider),
      ...states.map((s) => s.state.provider),
    ]),
  ].sort();
  return {
    since,
    now,
    providers: providers.map((provider) => {
      const u = usage.filter((e) => e.provider === provider),
        e = errors.filter((e) => e.provider === provider),
        auth = states.filter((s) => s.state.provider === provider);
      const indices = [
        ...new Set([
          ...u.map((r) => r.authIndex),
          ...e.map((r) => r.authIndex),
          ...auth.map((r) => r.state.authIndex || r.state.name),
        ]),
      ].sort();
      const credentials = indices.map((authIndex) => {
        const state = auth.find((r) => (r.state.authIndex || r.state.name) === authIndex);
        return {
          authIndex,
          state: state
            ? {
                ...state.state,
                cooldowns: state.state.cooldowns ?? [],
                quota: quotaObservation(state.state.quota),
                modelQuotas: Object.fromEntries(
                  Object.entries(state.state.modelQuotas).flatMap(([model, value]) => {
                    const quota = quotaObservation(value);
                    return quota ? [[model, quota]] : [];
                  })
                ),
              }
            : null,
          observed: state?.observed || 0,
          ...aggregate(
            u.filter((r) => r.authIndex === authIndex),
            e.filter((r) => r.authIndex === authIndex)
          ),
        };
      });
      const authSummary: Record<string, number> = {};
      for (const credential of credentials) {
        const state = credential.state;
        const status = state?.disabled ? 'disabled' : state?.status || 'unobserved';
        authSummary[status] = (authSummary[status] || 0) + 1;
      }
      return { provider, authSummary, ...aggregate(u, e), credentials };
    }),
  };
}
export type Health = ReturnType<typeof health>;
export type { Problem } from './api';
const fixes: Record<ErrorClass, string> = {
  auth: 'Check credential refresh or re-authenticate. Check management access for dashboard polls.',
  quota: 'Wait for the retry time, check quota, or route to a credential with capacity.',
  upstream: 'Check provider status and retry with backoff.',
  transport: 'Check proxy reachability, DNS, TLS and websocket connectivity.',
  client: 'Check the request, model name and context length.',
  other: 'Review the recent examples and expected behavior.',
};
const codeFixes: Record<string, string> = {
  invalid_grant: 'Re-authenticate the affected credential.',
  credential_disabled: 'Review why the credential was disabled before enabling it.',
  management_key_unavailable: 'Mount a readable key file and set CPA_MANAGEMENT_KEY_FILE.',
  auth_poll_http_401: 'Check the dashboard management key.',
  auth_poll_http_403: 'Check the management key and management.allow-remote setting.',
  telemetry_auth_rejected:
    'Check the dashboard management key and management access. Authentication retries pause for ten minutes.',
  friction_read_failed: 'Check FRICTION_PATHS and file read permissions.',
  cloudflare_challenge: 'Check the upstream Cloudflare challenge and proxy egress.',
};
export const problemSessionsSql = `FROM session WHERE nativeId IN (SELECT value FROM json_each(?)) OR t3ThreadId IN (SELECT value FROM json_each(?))`;
export function problems(
  db: Database,
  window: string | null,
  now = Date.now(),
  retryWindow = 35000
): ProblemsResponse {
  const since = windowStart(window, now),
    usage = events(db, 'usage_event', since, now),
    outcomes = failureOutcomes(usage, now, retryWindow);
  const grouped = new Map<string, Problem>(),
    sessions = new Map<string, Set<string>>();
  const add = (
    source: string,
    provider: string,
    model: string,
    category: ErrorClass,
    code: string,
    time: number,
    payload: unknown,
    outcome = 'state',
    sessionId = ''
  ) => {
    const key = JSON.stringify([source, provider, model, category, code]);
    let p = grouped.get(key);
    if (!p) {
      p = {
        key,
        source,
        provider,
        model,
        category,
        code,
        count: 0,
        firstSeen: time,
        lastSeen: time,
        affectedSessions: 0,
        retriedAttempts: 0,
        inferredFinalFailures: 0,
        unresolvedAttempts: 0,
        attemptErrors: 0,
        fix: codeFixes[code] || fixes[category],
        examples: [],
        sessions: [],
        sessionCount: 0,
        unindexedSessionCount: 0,
      };
      grouped.set(key, p);
      sessions.set(key, new Set());
    }
    p.count++;
    p.firstSeen = Math.min(time, p.firstSeen);
    p.lastSeen = Math.max(time, p.lastSeen);
    if (outcome === 'retried') p.retriedAttempts++;
    if (outcome === 'inferred_final') p.inferredFinalFailures++;
    if (outcome === 'unresolved') p.unresolvedAttempts++;
    if (outcome === 'attempt_error') p.attemptErrors++;
    if (sessionId) sessions.get(key)!.add(sessionId);
    p.examples.push({ time, payload: object(sanitize(payload)), outcome });
    p.examples.sort((a, b) => b.time - a.time);
    p.examples.length = Math.min(5, p.examples.length);
  };
  for (const row of events(db, 'error_event', since, now)) {
    const event = json(row.payload);
    add(
      'error_event',
      row.provider,
      row.model,
      classify(event),
      string(event.code) || String(number(event.status_code) || 'error'),
      row.time,
      event,
      'attempt_error'
    );
  }
  for (const row of usage) {
    const event = json(row.payload);
    if (event.failed !== true) continue;
    delete event.source;
    const failure = usageFailure(event);
    add(
      'usage_event',
      row.provider,
      row.model,
      classify(failure),
      failure.code || String(failure.status_code || 'failed'),
      row.time,
      event,
      outcomes.get(row.id),
      string(event.session_id)
    );
  }
  for (const row of db
    .query<{ time: number; payload: string }, [number, number]>(
      'SELECT time,payload FROM auth_state_event WHERE time>=? AND time<=? ORDER BY time'
    )
    .all(since, now)) {
    const payload = json(row.payload),
      state = object(payload.current) as AuthTransition;
    const previous = payload.previous ? authIssues(object(payload.previous) as AuthTransition) : [];
    for (const issue of authIssues(state).filter(
      (issue) =>
        !previous.some(
          (old) =>
            old.model === issue.model && old.category === issue.category && old.code === issue.code
        )
    ))
      add('auth', state.provider, issue.model, issue.category, issue.code, row.time, payload);
  }
  for (const row of db
    .query<{ time: number; category: ErrorClass; code: string; payload: string }, [number, number]>(
      'SELECT * FROM dashboard_event WHERE time>=? AND time<=?'
    )
    .all(since, now))
    add('dashboard', '', '', row.category, row.code, row.time, json(row.payload));
  for (const row of db
    .query<{ time: number; source: string; issueKey: string; payload: string }, [number, number]>(
      'SELECT * FROM friction_event WHERE time>=? AND time<=?'
    )
    .all(since, now))
    add(row.source, '', '', 'other', row.issueKey, row.time, json(row.payload));
  for (const p of grouped.values()) {
    const ids = sessions.get(p.key)!;
    if (!ids.size) continue;
    const values = JSON.stringify([...ids]);
    p.sessionCount =
      db
        .query<{ n: number }, [string, string]>(`SELECT count(*) n ${problemSessionsSql}`)
        .get(values, values)?.n || 0;
    p.unindexedSessionCount =
      db
        .query<{ n: number }, [string]>(
          `SELECT count(*) n FROM json_each(?) raw
           WHERE NOT EXISTS (SELECT 1 FROM session WHERE nativeId=raw.value OR t3ThreadId=raw.value)`
        )
        .get(values)?.n || 0;
    p.affectedSessions = p.sessionCount + p.unindexedSessionCount;
    p.sessions = db
      .query<SessionRow, [string, string]>(
        `SELECT * ${problemSessionsSql} ORDER BY updated DESC,id DESC LIMIT 20`
      )
      .all(values, values);
  }
  return {
    since,
    now,
    problems: [...grouped.values()].sort(
      (a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key)
    ),
  };
}
