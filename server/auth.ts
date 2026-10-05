import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { array, object, string, number, timestamp } from './model';
import { classify, sanitize, type ErrorClass } from './telemetry/events';

export function managementKey(env = process.env): string {
  if (env.CPA_MANAGEMENT_KEY_FILE) {
    try {
      const key = readFileSync(env.CPA_MANAGEMENT_KEY_FILE, 'utf8').trim();
      if (key) return key;
    } catch {
      /* Never include filesystem errors or key contents in logs. */
    }
    throw new Error('Management key file is unreadable or empty');
  }
  return (env.CPA_MANAGEMENT_KEY || '').trim();
}

// Scoped to the connection's database lifetime; never persisted with auth states or events.
const clientKeyCache = new WeakMap<Database, string[]>();
export function redactionSecrets(db: Database, key: string): string[] {
  return [key, ...(clientKeyCache.get(db) || [])];
}

export async function fetchClientKeys(
  base: string,
  key: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string[]> {
  if (!key) throw new Error('Missing management key');
  const url = new URL('/v8/management/config', base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error('Invalid CPA_BASE_URL');
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw response;
  const config = object(await response.json());
  const keys = object(config.access)['api-keys'];
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || !keys.every((value): value is string => typeof value === 'string'))
    throw new Error('Invalid client API keys');
  return keys.filter(Boolean);
}
export type Cooldown = {
  scope: string;
  model: string;
  reason: string;
  retryAt: number;
  status: number;
};
export type AuthState = {
  provider: string;
  authIndex: string;
  name: string;
  status: string;
  message: string;
  unavailable: boolean;
  disabled: boolean;
  nextRetry: number;
  lastRefresh: number;
  cooldowns: Cooldown[] | null;
  quota: Record<string, unknown>;
  modelQuotas: Record<string, unknown>;
};
export type AuthRow = { key: string; observed: number; state: AuthState };
export function authTables(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS auth_state(key TEXT PRIMARY KEY,observed INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_state_event(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,provider TEXT NOT NULL,authIndex TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_event_time ON auth_state_event(time);
    CREATE TABLE IF NOT EXISTS dashboard_event(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,category TEXT NOT NULL,code TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS dashboard_event_time ON dashboard_event(time);
  `);
}
export function parseAuthFiles(value: unknown): AuthState[] {
  const response = object(value);
  if (!Array.isArray(response.files)) throw new Error('Invalid auth-files response');
  return response.files.map((value) => {
    const f = object(value),
      name = string(f.name) || string(f.id),
      authIndex = string(f.auth_index);
    if (!name && !authIndex) throw new Error('Auth file has no identity');
    if (f.cooldowns !== null && f.cooldowns !== undefined && !Array.isArray(f.cooldowns))
      throw new Error('Invalid auth cooldowns');
    return {
      provider: string(f.provider) || string(f.type),
      authIndex,
      name,
      status: string(f.status),
      message: string(f.status_message),
      unavailable: f.unavailable === true,
      disabled: f.disabled === true,
      nextRetry: timestamp(f.next_retry_after),
      lastRefresh: timestamp(f.last_refresh),
      cooldowns:
        f.cooldowns === null || f.cooldowns === undefined
          ? null
          : array(f.cooldowns)
              .map((value) => {
                const c = object(value);
                return {
                  scope: string(c.scope),
                  model: string(c.model_key),
                  reason: string(c.reason),
                  retryAt: timestamp(c.retry_at),
                  status: number(c.http_status),
                };
              })
              .sort((a, b) => a.scope.localeCompare(b.scope) || a.model.localeCompare(b.model)),
      quota: object(sanitize(f.quota)),
      modelQuotas: object(sanitize(f.model_quotas)),
    };
  });
}
export function authStates(db: Database): AuthRow[] {
  return db
    .query<{ key: string; observed: number; payload: string }, []>(
      'SELECT * FROM auth_state ORDER BY key'
    )
    .all()
    .map((r) => ({
      key: r.key,
      observed: r.observed,
      state: JSON.parse(r.payload) as AuthState,
    }));
}
function transitionState(state: AuthState) {
  return {
    provider: state.provider,
    authIndex: state.authIndex,
    name: state.name,
    status: state.status,
    message: state.message,
    unavailable: state.unavailable,
    disabled: state.disabled,
    cooldowns:
      state.cooldowns?.map(({ scope, model, reason, status }) => ({
        scope,
        model,
        reason,
        status,
      })) ?? null,
  };
}
export type AuthTransition = ReturnType<typeof transitionState>;
export function storeAuthFiles(db: Database, states: AuthState[], observed = Date.now()) {
  db.transaction(() => {
    const present = new Set<string>();
    for (const state of states) {
      const key = JSON.stringify([state.provider, state.authIndex || state.name]);
      present.add(key);
      const payload = JSON.stringify(state);
      const old = db
        .query<{ payload: string }, [string]>('SELECT payload FROM auth_state WHERE key=?')
        .get(key);
      if (
        !old ||
        JSON.stringify(transitionState(JSON.parse(old.payload) as AuthState)) !==
          JSON.stringify(transitionState(state))
      )
        db.query(
          'INSERT INTO auth_state_event(time,provider,authIndex,payload) VALUES(?,?,?,?)'
        ).run(
          observed,
          state.provider,
          state.authIndex,
          JSON.stringify({
            previous: old ? transitionState(JSON.parse(old.payload) as AuthState) : null,
            current: transitionState(state),
          })
        );
      db.query(
        'INSERT INTO auth_state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET observed=excluded.observed,payload=excluded.payload'
      ).run(key, observed, payload);
    }
    for (const row of authStates(db)) {
      if (present.has(row.key) || row.state.status === 'removed') continue;
      const current = {
        ...row.state,
        status: 'removed',
        message: 'Absent from latest auth-files response',
        unavailable: true,
        cooldowns: [],
        nextRetry: 0,
      };
      db.query('INSERT INTO auth_state_event(time,provider,authIndex,payload) VALUES(?,?,?,?)').run(
        observed,
        current.provider,
        current.authIndex,
        JSON.stringify({
          previous: transitionState(row.state),
          current: transitionState(current),
        })
      );
      db.query('UPDATE auth_state SET observed=?,payload=? WHERE key=?').run(
        observed,
        JSON.stringify(current),
        row.key
      );
    }
  }).immediate();
}
export function dashboardProblem(
  db: Database,
  category: ErrorClass,
  code: string,
  time = Date.now()
) {
  db.query('INSERT INTO dashboard_event(time,category,code,payload) VALUES(?,?,?,?)').run(
    time,
    category,
    code,
    JSON.stringify({ code, message: code.replaceAll('_', ' ') })
  );
}
// Both telemetry channels and the poller share CPA's management-login ban budget.
const managementStates = new WeakMap<Database, { until: number; rejected: Set<string> }>();
export function managementRetryAt(db: Database): number {
  return managementStates.get(db)?.until || 0;
}
export function managementRejected(db: Database, source: string, code: string) {
  let state = managementStates.get(db);
  if (!state) {
    state = { until: 0, rejected: new Set() };
    managementStates.set(db, state);
  }
  state.until = Date.now() + 10 * 60000;
  if (!state.rejected.has(source)) dashboardProblem(db, 'auth', code);
  state.rejected.add(source);
}
export function managementAccepted(db: Database, source: string) {
  managementStates.get(db)?.rejected.delete(source);
}
export async function pollAuth(
  db: Database,
  base: string,
  loadKey: () => string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
) {
  let category: ErrorClass = 'transport',
    code = 'auth_poll_failed';
  try {
    category = 'auth';
    code = 'management_key_unavailable';
    const key = loadKey();
    if (!key) throw new Error('Missing management key');
    category = 'transport';
    code = 'auth_poll_failed';
    const url = new URL('/v8/management/credentials', base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw new Error('Invalid CPA_BASE_URL');
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      category = response.status === 401 || response.status === 403 ? 'auth' : 'transport';
      code = `auth_poll_http_${response.status}`;
      if (category === 'auth') {
        if (!signal?.aborted) managementRejected(db, 'auth_poll', code);
        return;
      }
      throw new Error('Poll rejected');
    }
    const value: unknown = await response.json();
    try {
      const keys = await fetchClientKeys(base, key, fetcher, signal);
      if (!signal?.aborted) clientKeyCache.set(db, keys);
    } catch (error) {
      if (!signal?.aborted) {
        if (error instanceof Response && (error.status === 401 || error.status === 403))
          managementRejected(db, 'config_poll', `config_poll_http_${error.status}`);
        else dashboardProblem(db, 'transport', 'redaction_keys_refresh_failed');
      }
    }
    const states = parseAuthFiles(sanitize(value, redactionSecrets(db, key)));
    if (!signal?.aborted) {
      storeAuthFiles(db, states);
      managementAccepted(db, 'auth_poll');
    }
  } catch {
    if (!signal?.aborted) dashboardProblem(db, category, code);
  }
}
export function startAuthPoller(
  db: Database,
  base: string,
  loadKey: () => string,
  options: {
    fetcher?: typeof fetch;
    intervalMs?: number;
    now?: () => number;
  } = {}
) {
  const abort = new AbortController();
  let running = false;
  const run = async () => {
    if (running || abort.signal.aborted) return;
    running = true;
    try {
      if ((options.now || Date.now)() < managementRetryAt(db)) return;
      await pollAuth(db, base, loadKey, options.fetcher || fetch, abort.signal);
    } catch {
      console.warn('Auth poll could not be stored');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), options.intervalMs || 60000);
  return () => {
    clearInterval(timer);
    abort.abort();
  };
}
export function authIssues(state: AuthTransition) {
  const issues: { model: string; category: ErrorClass; code: string }[] = [];
  if (
    state.disabled ||
    state.unavailable ||
    ['error', 'disabled', 'removed'].includes(state.status)
  ) {
    const event = {
      code: state.status,
      body: state.message,
    };
    issues.push({
      model: '',
      category: state.disabled || state.status === 'removed' ? 'auth' : classify(event),
      code: state.disabled ? 'credential_disabled' : state.status || 'unavailable',
    });
  }
  for (const c of state.cooldowns || [])
    issues.push({
      model: c.model,
      category: classify({ code: c.reason, status_code: c.status }),
      code: c.reason,
    });
  return issues;
}
