import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndex, pruneEvents } from '../db';
import {
  managementKey,
  parseAuthFiles,
  storeAuthFiles,
  authStates,
  pollAuth,
  startAuthPoller,
  managementRetryAt,
  dashboardProblem,
} from '../auth';
import { parseFriction, ingestFriction } from '../friction';
import {
  aggregate,
  failureOutcomes,
  parseRetryWindow,
  health,
  problems,
  problemSessionsSql,
  type EventRow,
} from '../insights';
import { appendEvent, sanitize } from '../telemetry/events';
import { handler } from '../server';

const now = Date.parse('2026-10-04T12:00:00Z');
function usage(id: number, event: Record<string, unknown> = {}, time = now - 120000): EventRow {
  return {
    id,
    received: time + 100,
    time,
    provider: 'synthetic',
    model: 'test',
    authIndex: 'account',
    transport: 'http',
    payload: JSON.stringify(event),
  };
}
const authFile = {
  provider: 'synthetic',
  name: 'test.json',
  auth_index: 'account',
  status: 'active',
  disabled: false,
  unavailable: false,
  cooldowns: [],
  quota: {
    observed_at: new Date(now).toISOString(),
    signals: { remaining: '50%' },
  },
};
const report = (at: string, expected: string, actual: string) =>
  `\n## ${at}\n\n### Expected\n\n    ${expected}\n\n### Actual\n\n    ${actual}\n\n### fleet doctor --agent --json\n\n    {"synthetic_doctor_blob":true}\n`;

test('management file takes precedence, trims, and never falls back after a file error', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-key-')),
    path = join(root, 'key');
  try {
    writeFileSync(path, '  synthetic-secret\n');
    expect(
      managementKey({
        CPA_MANAGEMENT_KEY_FILE: path,
        CPA_MANAGEMENT_KEY: 'fallback',
      })
    ).toBe('synthetic-secret');
    expect(managementKey({ CPA_MANAGEMENT_KEY: '  fallback\n' })).toBe('fallback');
    expect(managementKey({})).toBe('');
    writeFileSync(path, ' \n');
    expect(() =>
      managementKey({
        CPA_MANAGEMENT_KEY_FILE: path,
        CPA_MANAGEMENT_KEY: 'fallback',
      })
    ).toThrow('unreadable or empty');
    expect(() =>
      managementKey({
        CPA_MANAGEMENT_KEY_FILE: join(root, 'missing-secret-path'),
      })
    ).toThrow('unreadable or empty');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth parsing preserves passive quota, null cooldowns, timestamps and stable transitions', () => {
  const db = openIndex(':memory:');
  try {
    const cooldown = {
      scope: 'model',
      model_key: 'test',
      reason: 'quota',
      retry_at: new Date(now + 60000).toISOString(),
      remaining_seconds: 60,
      http_status: 429,
    };
    const value = {
      files: [
        {
          ...authFile,
          last_refresh: new Date(now - 1000).toISOString(),
          next_retry_after: cooldown.retry_at,
          cooldowns: [cooldown],
          quota: {
            signals: { remaining: '0%' },
            access_token: 'synthetic-token',
          },
        },
      ],
    };
    const states = parseAuthFiles(value);
    expect(states[0]?.lastRefresh).toBe(now - 1000);
    expect(states[0]?.nextRetry).toBe(now + 60000);
    expect(states[0]?.quota).toEqual({ signals: { remaining: '0%' } });
    storeAuthFiles(db, states, now);
    storeAuthFiles(
      db,
      parseAuthFiles({
        files: [
          {
            ...value.files[0],
            last_refresh: new Date(now + 20000).toISOString(),
            next_retry_after: new Date(now + 90000).toISOString(),
            model_quotas: { test: { signals: { remaining: '27%' } } },
            quota: {
              signals: { remaining: '27%' },
              observed_at: new Date(now + 30000).toISOString(),
            },
            cooldowns: [
              {
                ...cooldown,
                remaining_seconds: 30,
                retry_at: new Date(now + 90000).toISOString(),
              },
            ],
          },
        ],
      }),
      now + 30000
    );
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM auth_state_event').get()?.n).toBe(1);
    expect(authStates(db)[0]?.state.quota).toEqual({
      signals: { remaining: '27%' },
      observed_at: new Date(now + 30000).toISOString(),
    });
    expect(authStates(db)[0]?.state.modelQuotas).toEqual({
      test: { signals: { remaining: '27%' } },
    });
    expect(
      db.query<{ payload: string }, []>('SELECT payload FROM auth_state_event').get()?.payload
    ).not.toContain('signals');
    storeAuthFiles(
      db,
      parseAuthFiles({ files: [{ ...value.files[0], disabled: true }] }),
      now + 40000
    );
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM auth_state_event').get()?.n).toBe(2);
    storeAuthFiles(db, [], now + 50000);
    storeAuthFiles(db, [], now + 60000);
    expect(authStates(db)[0]?.state.status).toBe('removed');
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM auth_state_event').get()?.n).toBe(3);
    expect(
      parseAuthFiles({
        files: [{ name: 'disk.json', type: 'disk', cooldowns: null }],
      })[0]?.cooldowns
    ).toBeNull();
    expect(() => parseAuthFiles({ error: 'wrong shape' })).toThrow('Invalid auth-files');
    expect(() => parseAuthFiles({ files: [{}] })).toThrow('identity');
  } finally {
    db.close();
  }
});

test('polls send the Bearer key and store safe states, failures are dashboard problems', async () => {
  const db = openIndex(':memory:');
  try {
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/config')) return Response.json({ access: { 'api-keys': [] } });
        expect(String(input)).toBe('http://synthetic.invalid/v8/management/credentials');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-secret');
        expect(init?.redirect).toBe('error');
        return Response.json({
          files: [
            {
              ...authFile,
              status_message: 'synthetic-secret',
              id_token: 'omitted',
            },
          ],
        });
      },
      { preconnect: () => {} }
    );
    await pollAuth(db, 'http://synthetic.invalid', () => 'synthetic-secret', fetcher);
    expect(authStates(db)[0]?.state.message).toBe('[redacted]');
    for (const status of [401, 403, 503]) {
      const failed: typeof fetch = Object.assign(
        async () => Response.json({ error: 'synthetic-secret' }, { status }),
        { preconnect: () => {} }
      );
      await pollAuth(db, 'http://synthetic.invalid', () => 'synthetic-secret', failed);
    }
    const failed: typeof fetch = Object.assign(
      async () => {
        throw new Error('synthetic-secret');
      },
      { preconnect: () => {} }
    );
    await pollAuth(db, 'http://synthetic.invalid', () => 'synthetic-secret', failed);
    await pollAuth(
      db,
      'http://synthetic.invalid',
      () => {
        throw new Error('synthetic-secret');
      },
      failed
    );
    expect(
      db
        .query<{ category: string }, []>('SELECT category FROM dashboard_event ORDER BY id')
        .all()
        .map((r) => r.category)
    ).toEqual(['auth', 'transport', 'transport', 'auth']);
    expect(JSON.stringify(db.query('SELECT * FROM dashboard_event').all())).not.toContain(
      'synthetic-secret'
    );
    expect(authStates(db)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('usage failures distinguish proven retries, inferred terminal failures and unknown outcomes', () => {
  const rows = [
    usage(1, { request_id: 'retry', failed: true, latency_ms: 19000 }),
    usage(2, { request_id: 'retry', failed: false }, now - 100000),
    usage(3, { request_id: 'terminal', failed: true }),
    usage(4, { failed: true, retryable: false }),
    usage(5, { request_id: 'pending', failed: true }, now - 1000),
    usage(6, { request_id: 'side-model', failed: true }),
    usage(7, { request_id: 'side-model', failed: false }),
  ];
  expect([...failureOutcomes(rows, now)]).toEqual([
    [1, 'retried'],
    [3, 'inferred_final'],
    [4, 'unresolved'],
    [5, 'unresolved'],
    [6, 'unresolved'],
  ]);
});
test('websocket turns minutes apart are not retries, even when they share a request ID', () => {
  const rows = [
    usage(1, { request_id: 'socket', failed: true, latency_ms: 1000 }, now - 300000),
    usage(2, { request_id: 'socket', failed: false }, now - 120000),
    usage(3, { request_id: 'socket', failed: true, latency_ms: 80000 }, now - 100000),
    usage(4, { request_id: 'socket', failed: false }, now - 19000),
    usage(5, { request_id: 'new-socket', failed: true }, now - 30000),
    usage(6, { request_id: 'new-socket', failed: false }, now - 1000),
    usage(7, { request_id: 'boundary', failed: true, latency_ms: 1000 }, now - 120000),
    usage(8, { request_id: 'boundary', failed: false }, now - 84000),
    usage(9, { request_id: 'outside', failed: true, latency_ms: 1000 }, now - 120000),
    usage(10, { request_id: 'outside', failed: false }, now - 83999),
    usage(11, { request_id: 'overlap', failed: true, latency_ms: 10000 }, now - 120000),
    usage(12, { request_id: 'overlap', failed: false }, now - 119000),
  ];
  rows.forEach((row) => {
    row.transport = 'websocket';
  });
  expect([...failureOutcomes(rows, now)]).toEqual([
    [1, 'inferred_final'],
    [3, 'retried'],
    [5, 'retried'],
    [7, 'retried'],
    [9, 'inferred_final'],
    [11, 'inferred_final'],
  ]);
});
test('retry window controls correlation and keeps final inference beyond longer backoffs', () => {
  const rows = [
    usage(1, { request_id: 'retry', failed: true, latency_ms: 1000 }),
    usage(2, { request_id: 'retry', failed: false }, now - 79000),
  ];
  expect(parseRetryWindow(undefined)).toBe(35000);
  expect(failureOutcomes(rows, now).get(1)).toBe('inferred_final');
  expect(failureOutcomes(rows, now, parseRetryWindow('45')).get(1)).toBe('retried');
  const pending = usage(3, { request_id: 'pending', failed: true });
  pending.received = now - 70000;
  const window = parseRetryWindow('90');
  expect(failureOutcomes([pending], now).get(3)).toBe('inferred_final');
  expect(failureOutcomes([pending], now, window).get(3)).toBe('unresolved');
  expect(failureOutcomes([pending], pending.received + 94999, window).get(3)).toBe('unresolved');
  expect(failureOutcomes([pending], pending.received + 95000, window).get(3)).toBe(
    'inferred_final'
  );
  const retry = usage(4, { request_id: 'pending', failed: false }, pending.time + 90000);
  expect(failureOutcomes([pending, retry], now, window).get(3)).toBe('retried');
});
test('auth Problems count new issues, not unchanged issues in other transitions', () => {
  const db = openIndex(':memory:');
  const cooldown = {
    scope: 'model',
    model_key: 'test',
    reason: 'quota',
    http_status: 429,
  };
  const store = (files: unknown[], time: number) =>
    storeAuthFiles(db, parseAuthFiles({ files }), time);
  try {
    store([{ ...authFile, cooldowns: [cooldown] }], now - 5000);
    store([{ ...authFile, disabled: true, cooldowns: [cooldown] }], now - 4000);
    store(
      [
        {
          ...authFile,
          disabled: true,
          status_message: 'still disabled',
          cooldowns: [cooldown],
        },
      ],
      now - 3000
    );
    store([{ ...authFile, disabled: true, cooldowns: [] }], now - 2000);
    store([{ ...authFile, disabled: true, cooldowns: [cooldown] }], now - 1000);
    const result = problems(db, '1h', now).problems;
    expect(result.find((p) => p.code === 'quota')?.count).toBe(2);
    expect(result.find((p) => p.code === 'credential_disabled')?.count).toBe(1);
  } finally {
    db.close();
  }
});
test("auth poller pauses on 401/403 and shares telemetry's login backoff", async () => {
  for (const status of [401, 403]) {
    const db = openIndex(':memory:');
    let calls = 0,
      clock = Date.now();
    const fetcher: typeof fetch = Object.assign(
      async () => {
        calls++;
        return Response.json({}, { status });
      },
      { preconnect: () => {} }
    );
    const before = Date.now();
    const stop = startAuthPoller(db, 'http://synthetic.invalid', () => 'wrong-key', {
      fetcher,
      intervalMs: 5,
      now: () => clock,
    });
    try {
      await Bun.sleep(25);
      expect(calls).toBe(1);
      expect(managementRetryAt(db)).toBeGreaterThanOrEqual(before + 600000);
      clock = managementRetryAt(db) - 1;
      await Bun.sleep(10);
      expect(calls).toBe(1);
      clock = managementRetryAt(db);
      await Bun.sleep(10);
      expect(calls).toBe(2);
      expect(db.query<{ n: number }, []>('SELECT count(*) n FROM dashboard_event').get()?.n).toBe(
        1
      );
    } finally {
      stop();
      db.close();
    }
  }
});
test('retention prunes all five event tables at eight days and preserves current auth state', () => {
  const db = openIndex(':memory:');
  const cutoff = now - 8 * 86400000;
  try {
    for (const time of [cutoff - 1, cutoff, now]) {
      const event = JSON.stringify({ timestamp: time });
      appendEvent(db, 'usage', event);
      appendEvent(db, 'errors', event);
      storeAuthFiles(
        db,
        parseAuthFiles({ files: [{ ...authFile, auth_index: String(time) }] }),
        time
      );
      dashboardProblem(db, 'other', 'test', time);
      db.query('INSERT INTO friction_event VALUES(?,?,?,?,?)').run(
        String(time),
        time,
        'friction',
        'test',
        '{}'
      );
    }
    pruneEvents(db, now);
    for (const table of [
      'usage_event',
      'error_event',
      'auth_state_event',
      'dashboard_event',
      'friction_event',
    ]) {
      expect(
        db
          .query<{ n: number }, [number]>(`SELECT count(*) n FROM ${table} WHERE time<?`)
          .get(cutoff)?.n
      ).toBe(0);
      expect(
        db
          .query<{ n: number }, [number]>(`SELECT count(*) n FROM ${table} WHERE time=?`)
          .get(cutoff)?.n
      ).toBeGreaterThan(0);
      expect(
        db.query<{ n: number }, [number]>(`SELECT count(*) n FROM ${table} WHERE time=?`).get(now)
          ?.n
      ).toBeGreaterThan(0);
    }
    expect(authStates(db)).toHaveLength(3);
  } finally {
    db.close();
  }
});
test('ingest drops usage response headers and friction read failures are other problems', () => {
  const db = openIndex(':memory:');
  try {
    appendEvent(
      db,
      'usage',
      JSON.stringify({
        timestamp: now,
        response_headers: { 'x-secret': 'header-value' },
      })
    );
    const payload = db
      .query<{ payload: string }, []>('SELECT payload FROM usage_event')
      .get()?.payload;
    expect(payload).not.toContain('response_headers');
    expect(payload).not.toContain('header-value');
    ingestFriction(db, '/missing-synthetic-friction-path');
    const issue = problems(db, '1h').problems.find((p) => p.code === 'friction_read_failed');
    expect(issue?.category).toBe('other');
    expect(issue?.fix).toContain('FRICTION_PATHS');
  } finally {
    db.close();
  }
});
test('client cancellation gets a client fix and remains an uncorrelated error attempt', () => {
  const db = openIndex(':memory:');
  try {
    appendEvent(
      db,
      'errors',
      JSON.stringify({
        timestamp: now,
        code: 'connection_lifecycle',
        status_code: 500,
        body: 'context canceled',
        auth_status: { quota: { exceeded: true } },
      })
    );
    const issue = problems(db, '1h', now).problems[0]!;
    expect(issue.category).toBe('client');
    expect(issue.fix).not.toContain('proxy reachability');
    expect(issue.affectedSessions).toBe(0);
    expect(issue.attemptErrors).toBe(1);
  } finally {
    db.close();
  }
});
test('Problems cap unique indexed sessions at twenty and return their total', () => {
  const db = openIndex(':memory:');
  try {
    for (let i = 0; i < 25; i++) {
      const id = `native-${i}`;
      db.query(
        "INSERT INTO session(host,client,nativeId,title,cwd,repo,branch,model,provider,started,updated,tokens,parentId,kind,t3ThreadId,snapshot,snapshotTime,itemCount) VALUES('test','codex',?,'Session','','','','','',0,?,0,'','root',?,'',0,0)"
      ).run(id, i, `thread-${i}`);
      for (const session_id of [id, `thread-${i}`])
        appendEvent(
          db,
          'usage',
          JSON.stringify({
            timestamp: now - 120000,
            session_id,
            failed: true,
            fail: { status_code: 401 },
          })
        );
    }
    for (let i = 0; i < 7; i++)
      for (let repeat = 0; repeat < 2; repeat++)
        appendEvent(
          db,
          'usage',
          JSON.stringify({
            timestamp: now,
            session_id: `live-${i}`,
            failed: true,
            fail: { status_code: 401 },
          })
        );
    const issue = problems(db, '1h', now).problems[0]!;
    expect(issue.sessions).toHaveLength(20);
    expect(issue.sessionCount).toBe(25);
    expect(issue.unindexedSessionCount).toBe(7);
    expect(issue.affectedSessions).toBe(32);
    expect(new Set(issue.sessions.map((s) => s.id)).size).toBe(20);
    expect(issue.sessions[0]?.nativeId).toBe('native-24');
    const ids = JSON.stringify(['native-24', 'thread-24']);
    const plan = db
      .query<{ detail: string }, [string, string]>(
        `EXPLAIN QUERY PLAN SELECT id,nativeId,title,host ${problemSessionsSql} ORDER BY updated DESC,id DESC LIMIT 20`
      )
      .all(ids, ids)
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toContain('session_native_id');
    expect(plan).toContain('session_t3_thread_id');
  } finally {
    db.close();
  }
});

test('live problem sessions stay visible while the archive catches up', () => {
  const db = openIndex(':memory:');
  try {
    for (const session_id of ['native-live', 'thread-live', 'other-live', 'other-live'])
      appendEvent(
        db,
        'usage',
        JSON.stringify({
          timestamp: now,
          session_id,
          failed: true,
          fail: { status_code: 401 },
        })
      );
    const live = problems(db, '1h', now).problems[0]!;
    expect(live.sessionCount).toBe(0);
    expect(live.affectedSessions).toBe(3);
    expect(live.sessions).toEqual([]);
    db.query(
      "INSERT INTO session(host,client,nativeId,title,cwd,repo,branch,model,provider,started,updated,tokens,parentId,kind,t3ThreadId,snapshot,snapshotTime,itemCount) VALUES('test','codex','native-live','Live session','','','','','',0,0,0,'','root','thread-live','',0,0)"
    ).run();
    const indexed = problems(db, '1h', now).problems[0]!;
    expect(indexed.sessionCount).toBe(1);
    expect(indexed.unindexedSessionCount).toBe(1);
    expect(indexed.affectedSessions).toBe(2);
    expect(indexed.sessions).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('health math uses attempt failures, nearest-rank percentiles, positive TTFT and canonical total tokens', () => {
  const rows = [
    usage(1, {
      latency_ms: 10,
      ttft_ms: 0,
      tokens: { total_tokens: 900 },
      token_breakdown: { schema_version: 2, total_tokens: 100 },
      failed: true,
      fail: { status_code: 401 },
    }),
    usage(2, { latency_ms: 20, ttft_ms: 5, tokens: { total_tokens: 200 } }),
    usage(3, { latency_ms: 100, ttft_ms: 15, tokens: { total_tokens: 300 } }),
    usage(4, { latency_ms: 40, tokens: { total_tokens: 400 } }),
  ];
  rows[1]!.transport = 'websocket';
  rows[3]!.transport = 'unknown';
  const result = aggregate(rows, [usage(9, { status_code: 429 })]);
  expect(result.requests).toBe(4);
  expect(result.failureRate).toBe(0.25);
  expect(result.latency).toEqual({ p50: 20, p95: 100 });
  expect(result.ttft).toEqual({ p50: 5, p95: 15 });
  expect(result.tokens).toBe(1000);
  expect([result.websocket, result.http, result.unknown]).toEqual([1, 2, 1]);
  expect(result.errorCounts.quota).toBe(1);
  expect(result.usageErrorCounts.auth).toBe(1);
  expect(aggregate([], []).failureRate).toBe(0);
  expect(aggregate([], []).ttft).toEqual({ p50: null, p95: null });
});

test('friction groups paths and Sandpaper event IDs, strips doctor and historical metadata, and ingests idempotently', () => {
  const content =
    report(
      new Date(now - 4000).toISOString(),
      'Find synthetic config',
      'Missing /tmp/example-one'
    ) +
    report(
      new Date(now - 3000).toISOString(),
      'Find synthetic config',
      'Missing /tmp/example-two'
    ) +
    report(
      new Date(now - 2000).toISOString(),
      'synthetic: command succeeds',
      `Automatic observation: exit-7; event ${'a'.repeat(64)}. Tool input and output omitted.`
    ) +
    report(
      new Date(now - 1000).toISOString(),
      'synthetic: command succeeds',
      `Automatic observation: exit-7; event ${'b'.repeat(64)}. Tool input and output omitted.`
    );
  const parsed = parseFriction(content.replaceAll('\n', '\r\n'));
  expect(parsed).toHaveLength(4);
  expect(parsed[0]?.key).toBe(parsed[1]?.key);
  expect(parsed[2]?.key).toBe(parsed[3]?.key);
  expect(parsed.map((p) => p.source)).toEqual(['friction', 'friction', 'sandpaper', 'sandpaper']);
  expect(JSON.stringify(parsed)).not.toContain('synthetic_doctor_blob');
  const historical = report(
    new Date(now).toISOString(),
    'Synthetic import',
    'Missing command\n\n    Historical import. Synthetic metadata\n    Thread: should-be-omitted'
  );
  expect(parseFriction(historical)[0]?.actual).toBe('Missing command');
  const root = mkdtempSync(join(tmpdir(), 'dashboard-friction-')),
    db = openIndex(':memory:');
  try {
    const path = join(root, 'friction.md');
    writeFileSync(path, content);
    ingestFriction(db, root);
    ingestFriction(db, `${path}:${root}`);
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM friction_event').get()?.n).toBe(4);
    const result = problems(db, '1h', now);
    expect(result.problems.map((p) => p.count)).toEqual([2, 2]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Problems keeps sources separate, counts sessions, ranks issues and links indexed native IDs', () => {
  const db = openIndex(':memory:');
  try {
    const event = {
      timestamp: new Date(now - 120000).toISOString(),
      provider: 'synthetic',
      model: 'test',
      auth_index: 'account',
      request_id: 'request',
      session_id: 'native-test',
      failed: true,
      fail: { status_code: 401, body: '{"error":{"code":"invalid_grant"}}' },
    };
    appendEvent(db, 'usage', JSON.stringify(event), now - 119000);
    appendEvent(
      db,
      'errors',
      JSON.stringify({
        timestamp: event.timestamp,
        provider: event.provider,
        model: event.model,
        auth_index: event.auth_index,
        body: 'Credential refresh rejected',
        status_code: 401,
        code: 'invalid_grant',
        retryable: true,
      })
    );
    appendEvent(
      db,
      'errors',
      JSON.stringify({
        timestamp: event.timestamp,
        provider: event.provider,
        model: event.model,
        auth_index: event.auth_index,
        body: 'Credential refresh rejected',
        status_code: 401,
        code: 'invalid_grant',
        retryable: false,
      })
    );
    db.query(
      "INSERT INTO session(host,client,nativeId,title,cwd,repo,branch,model,provider,started,updated,tokens,parentId,kind,t3ThreadId,snapshot,snapshotTime,itemCount) VALUES('test','codex','native-test','Synthetic session','','','','','',0,0,0,'','root','','',0,0)"
    ).run();
    const result = problems(db, '1h', now).problems;
    expect(result.map((p) => p.source)).toEqual(['error_event', 'usage_event']);
    expect(result[0]?.count).toBe(2);
    expect(result[0]?.attemptErrors).toBe(2);
    expect(result[0]?.retriedAttempts).toBe(0);
    expect(result[0]?.inferredFinalFailures).toBe(0);
    expect(result[1]?.inferredFinalFailures).toBe(1);
    expect(result[0]?.affectedSessions).toBe(0);
    expect(result[0]?.sessions).toEqual([]);
    expect(result[1]?.affectedSessions).toBe(1);
    expect(result[1]?.sessions[0]?.title).toBe('Synthetic session');
    expect(result[0]?.fix).toBe('Re-authenticate the affected credential.');
    storeAuthFiles(db, parseAuthFiles({ files: [authFile] }), now);
    const overview = health(db, '1h', now);
    expect(overview.providers[0]?.requests).toBe(1);
    expect(overview.providers[0]?.credentials[0]?.state?.name).toBe('test.json');
    expect(health(db, '1h', now + 7200000).providers[0]?.requests).toBe(0);
  } finally {
    db.close();
  }
});

test('API validates windows and sanitization removes nested credentials and JSON error bodies', async () => {
  const db = openIndex(':memory:');
  try {
    const fetch = handler(db, '/tmp');
    expect((await fetch(new Request('http://synthetic.invalid/healthz'))).status).toBe(200);
    expect(
      (await fetch(new Request('http://synthetic.invalid/api/health?window=invalid'))).status
    ).toBe(400);
    expect(
      (await fetch(new Request('http://synthetic.invalid/api/problems?window=invalid'))).status
    ).toBe(400);
    expect(
      (await fetch(new Request('http://synthetic.invalid/api/health?window=toString'))).status
    ).toBe(400);
    appendEvent(db, 'usage', '{"support_refresh":true}');
    appendEvent(db, 'usage', '{"refresh":true}');
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM usage_event').get()?.n).toBe(0);
    const safe = JSON.stringify(
      sanitize({
        api_key: 'top-secret',
        nested: { Authorization: 'Bearer nested-secret' },
        body: '{"refresh_token":"body-secret","error":"Bearer plain-secret-12345678901234567890"}',
      })
    );
    for (const secret of ['top-secret', 'nested-secret', 'body-secret', 'plain-secret'])
      expect(safe).not.toContain(secret);
  } finally {
    db.close();
  }
});
