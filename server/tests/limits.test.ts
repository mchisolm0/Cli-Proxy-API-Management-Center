import { expect, test } from 'bun:test';
import { openIndex } from '../db';
import { storeAuthFiles, parseAuthFiles } from '../auth';
import { health } from '../insights';
import { probeLimits } from '../limits';

const now = Date.parse('2026-11-19T12:00:00Z');

test('Muse and OpenCode Go limits are asked through CPA and kept when a probe fails', async () => {
  const db = openIndex(':memory:');
  try {
    storeAuthFiles(
      db,
      parseAuthFiles({ files: [{ name: 'meta-a.json', provider: 'meta', auth_index: 'muse-1' }] }),
      now
    );
    db.query(
      "INSERT INTO usage_event(received,time,provider,model,authIndex,transport,payload) VALUES(?,?,'openai-compatible-opencode-go','glm','go-1','http','{}')"
    ).run(now, now - 60000);
    const answers: Record<string, unknown> = {
      'muse-1': {
        subs_usage: {
          window: { used_percent: 12, resets_at: 1795075200, window_duration_mins: 300 },
          weekly: { used_percent: 40, resets_at: '2026-11-24T00:00:00Z' },
        },
      },
      'go-1': {
        usage: {
          rolling: { percent: 30, resetsAt: '2026-11-19T15:00:00Z' },
          weekly: { percent: 55, status: 'rate-limited', resetsAt: '2026-11-23T00:00:00Z' },
        },
      },
    };
    const calls: Record<string, unknown>[] = [];
    let up = true;
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('http://synthetic.invalid/v8/management/requests/api-call');
        const call = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(call);
        if (!up) return Response.json({ status_code: 502, body: '' });
        return Response.json({
          status_code: 200,
          body: JSON.stringify(answers[String(call.auth_index)]),
        });
      },
      { preconnect: () => {} }
    );
    await probeLimits(db, 'http://synthetic.invalid', 'synthetic-secret', fetcher, now);
    expect(calls.map((c) => [c.auth_index, c.method, c.url]).sort()).toEqual([
      ['go-1', 'GET', 'https://opencode.ai/zen/go/v1/usage'],
      ['muse-1', 'POST', 'https://api.meta.ai/muse-code/key'],
    ]);
    expect(calls[0]?.header).toMatchObject({ Authorization: 'Bearer $TOKEN$' });
    up = false;
    await probeLimits(db, 'http://synthetic.invalid', 'synthetic-secret', fetcher, now + 300000);
    const limits = (provider: string) =>
      health(db, '7d', now)
        .providers.find((p) => p.provider === provider)
        ?.credentials.map((c) => c.limits);
    expect(limits('meta')).toEqual([
      [
        { window: '5h', minutes: 300, used: 12, resetsAt: 1795075200000 },
        {
          window: 'weekly',
          minutes: 10080,
          used: 40,
          resetsAt: Date.parse('2026-11-24T00:00:00Z'),
        },
      ],
    ]);
    expect(limits('openai-compatible-opencode-go')).toEqual([
      [
        { window: '5h', minutes: 300, used: 30, resetsAt: Date.parse('2026-11-19T15:00:00Z') },
        {
          window: 'weekly',
          minutes: 10080,
          used: 100,
          resetsAt: Date.parse('2026-11-23T00:00:00Z'),
        },
      ],
    ]);
  } finally {
    db.close();
  }
});
