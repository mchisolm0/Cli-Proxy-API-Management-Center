import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openIndex } from '../db';
import { handler } from '../server';
import { health, problems, failureOutcomes, type EventRow } from '../insights';
import { parseAuthFiles, storeAuthFiles } from '../auth';
import { appendEvent } from '../telemetry/events';
import { generate } from '../fixtures/generate';
import { buildIndex } from '../index';
import { search } from '../search';

const now = Date.parse('2026-10-05T12:00:00Z');

test('v8 usage preserves added metadata, prefers trace correlation, and never correlates execution IDs', () => {
  const db = openIndex(':memory:');
  const events = [
    { request_id: 'old-a', execution_id: 'exec-a', trace_id: 'trace', failed: true },
    { request_id: 'old-b', execution_id: 'exec-b', trace_id: 'trace', failed: false },
    { request_id: 'shared', execution_id: 'exec-c', trace_id: 'other-a', failed: true },
    { request_id: 'shared', execution_id: 'exec-c', trace_id: 'other-b', failed: false },
    { request_id: '', execution_id: 'exec-only', failed: true },
    { request_id: '', execution_id: 'exec-only', failed: false },
  ];
  try {
    events.forEach((event, index) =>
      appendEvent(
        db,
        'usage',
        JSON.stringify({
          ...event,
          timestamp: now - 120000 + index * 2000,
          latency_ms: 1000,
          session_id: 'native-id',
          parent_session_id: 'parent-id',
          node_kind: 'fork',
          is_fork: true,
          is_compaction: false,
          resolved_client_ip: '192.0.2.1',
          api_key: 'synthetic-client-key',
          source: 'synthetic-provider-key',
        }),
        now - 100000
      )
    );
    const rows = db.query<EventRow, []>('SELECT * FROM usage_event ORDER BY time').all();
    expect([...failureOutcomes(rows, now)]).toEqual([
      [1, 'retried'],
      [3, 'inferred_final'],
      [5, 'unresolved'],
    ]);
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
    expect(payload.trace_id).toBe('trace');
    expect(payload.execution_id).toBe('exec-a');
    expect(payload.node_kind).toBe('fork');
    expect(payload.is_fork).toBe(true);
    expect(payload.resolved_client_ip).toBe('192.0.2.1');
    expect(payload).not.toHaveProperty('api_key');
    expect(payload).not.toHaveProperty('source');
  } finally {
    db.close();
  }
});

test('health emits numeric defaults, array cooldowns and typed quota readings', () => {
  const db = openIndex(':memory:');
  try {
    storeAuthFiles(
      db,
      parseAuthFiles({
        files: [
          {
            name: 'disk.json',
            provider: 'codex',
            auth_index: 'disk',
            cooldowns: null,
            quota: null,
            model_quotas: {
              test: {
                observed_at: new Date(now).toISOString(),
                signals: { remaining: '0%', invalid: 3 },
              },
            },
          },
        ],
      }),
      now
    );
    appendEvent(db, 'usage', JSON.stringify({ timestamp: now, provider: 'other' }));
    const response = health(db, '24h', now);
    const observed = response.providers.find((provider) => provider.provider === 'codex')!;
    expect(observed.failureRate).toBe(0);
    expect(observed.credentials[0]!.observed).toBe(now);
    expect(observed.credentials[0]!.state?.cooldowns).toEqual([]);
    expect(observed.credentials[0]!.state?.quota).toBeNull();
    expect(observed.credentials[0]!.state?.modelQuotas.test).toEqual({
      observed_at: new Date(now).toISOString(),
      signals: { remaining: '0%' },
    });
    expect(
      response.providers.find((provider) => provider.provider === 'other')!.credentials[0]!.observed
    ).toBe(0);
  } finally {
    db.close();
  }
});

test('search returns plain matching snippets and problems return full session summaries', () => {
  const root = mkdtempSync('/tmp/cpa-contracts-');
  const archive = join(root, 'archive');
  const path = join(root, 'index.sqlite');
  generate(archive);
  buildIndex(archive, path);
  const db = openIndex(path);
  try {
    const result = search(db, new URLSearchParams({ q: '"lunar otters"', host: 'mac' }));
    expect(result.sessions).toHaveLength(1);
    expect(result.snippets?.[result.sessions[0]!.id]).toContain('lunar otters');
    expect(search(db, new URLSearchParams())).not.toHaveProperty('snippets');
    appendEvent(
      db,
      'usage',
      JSON.stringify({
        timestamp: now,
        session_id: result.sessions[0]!.nativeId,
        failed: true,
        fail: { status_code: 401 },
      })
    );
    const linked = problems(db, '24h', now).problems[0]!.sessions[0]!;
    expect(linked.repo).toBeTruthy();
    expect(linked.client).toBe('codex');
    expect(linked).toHaveProperty('itemCount');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP serves only the single-file root and leaves proxy paths unhandled', async () => {
  const root = mkdtempSync('/tmp/cpa-serving-');
  const assets = join(root, 'dist');
  mkdirSync(assets);
  writeFileSync(join(assets, 'index.html'), '<script>window.synthetic = true</script>');
  writeFileSync(join(assets, 'private.txt'), 'not served');
  const db = openIndex(':memory:');
  const serve = handler(db, root, assets);
  try {
    const response = await serve(new Request('http://synthetic.invalid/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('window.synthetic');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "script-src 'self' 'unsafe-inline'"
    );
    for (const path of [
      '/private.txt',
      '/index.html',
      '/sessions',
      '/v1/models',
      '/v8/management/credentials',
    ]) {
      expect((await serve(new Request(`http://synthetic.invalid${path}`))).status).toBe(404);
    }
    expect((await serve(new Request('http://synthetic.invalid/api/search'))).status).toBe(200);
    expect((await serve(new Request('http://synthetic.invalid/healthz'))).status).toBe(200);
    expect(
      (await handler(db, root, join(root, 'missing'))(new Request('http://synthetic.invalid/')))
        .status
    ).toBe(503);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid_grant remains an auth failure with OAuth 400 or the v8 error-channel fallback 500', () => {
  const db = openIndex(':memory:');
  try {
    appendEvent(
      db,
      'errors',
      JSON.stringify({
        timestamp: now,
        status_code: 500,
        body: 'OAuth refresh failed: invalid_grant',
        auth_status: { disabled: true, status: 'disabled' },
      })
    );
    appendEvent(
      db,
      'usage',
      JSON.stringify({
        timestamp: now,
        failed: true,
        fail: { status_code: 400, body: '{"error":{"code":"invalid_grant"}}' },
      })
    );
    const issues = problems(db, '24h', now).problems;
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.category === 'auth')).toBe(true);
    expect(issues.every((issue) => issue.fix.includes('authenticate'))).toBe(true);
  } finally {
    db.close();
  }
});
