import type { Database } from 'bun:sqlite';
import { managementRetryAt } from './auth';
import { object, string, number } from './model';

/** One subscription window: percent used and when it resets (epoch ms, 0 unknown). */
export type Limit = { window: string; minutes: number; used: number; resetsAt: number };

// Providers whose limits never arrive in response headers, so the pool's own
// quota stays empty: each is asked through CPA's api-call, which swaps in the
// credential's token, so the token never reaches the dashboard.
type Probe = {
  method: 'GET' | 'POST';
  url: string;
  data?: string;
  read: (body: unknown) => Limit[];
};
const probes: Record<string, Probe> = {
  // Muse Code's key endpoint, as the Muse CLI's /usage reads it.
  meta: {
    method: 'POST',
    url: 'https://api.meta.ai/muse-code/key',
    data: '{}',
    read: (body) => {
      const usage = object(object(body).subs_usage);
      const session = object(usage.window),
        weekly = object(usage.weekly);
      const minutes = number(session.window_duration_mins) || 300;
      return [
        limit(`${minutes / 60}h`, minutes, session.used_percent, session.resets_at),
        limit('weekly', 10080, weekly.used_percent, weekly.resets_at),
      ].filter((l) => l !== null);
    },
  },
  // OpenCode Go's rolling, weekly and monthly meters.
  'openai-compatible-opencode-go': {
    method: 'GET',
    url: 'https://opencode.ai/zen/go/v1/usage',
    read: (body) => {
      const usage = object(object(body).usage);
      return (
        [
          ['5h', 300, 'rolling'],
          ['weekly', 10080, 'weekly'],
          ['monthly', 43200, 'monthly'],
        ] as const
      )
        .map(([window, minutes, key]) => {
          const meter = object(usage[key]);
          const used = string(meter.status) === 'rate-limited' ? 100 : meter.percent;
          return limit(window, minutes, used, meter.resetsAt);
        })
        .filter((l) => l !== null);
    },
  },
};

function limit(window: string, minutes: number, used: unknown, resetsAt: unknown): Limit | null {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  // Resets come as epoch seconds or milliseconds, or an ISO time.
  const reset =
    typeof resetsAt === 'number'
      ? resetsAt < 1e12
        ? resetsAt * 1000
        : resetsAt
      : Date.parse(string(resetsAt)) || 0;
  return { window, minutes, used: Math.max(0, Math.min(100, used)), resetsAt: reset };
}

export function limitTables(db: Database) {
  db.run(
    'CREATE TABLE IF NOT EXISTS probed_limit(key TEXT PRIMARY KEY,observed INTEGER NOT NULL,payload TEXT NOT NULL)'
  );
}

/** The last limits each credential answered with, keyed by provider and auth index. */
export function probedLimits(db: Database): Map<string, Limit[]> {
  return new Map(
    db
      .query<{ key: string; payload: string }, []>('SELECT key,payload FROM probed_limit')
      .all()
      .map((r) => [r.key, JSON.parse(r.payload) as Limit[]])
  );
}
export const limitKey = (provider: string, authIndex: string) =>
  JSON.stringify([provider, authIndex]);

// Every credential of a probed provider seen in the last week: an OAuth one is
// in auth_state, an API key only in its traffic.
function targets(db: Database, now: number) {
  const providers = Object.keys(probes);
  const marks = providers.map(() => '?').join(',');
  return db
    .query<{ provider: string; authIndex: string }, (string | number)[]>(
      `SELECT DISTINCT provider,authIndex FROM usage_event WHERE time>=? AND authIndex!='' AND provider IN (${marks})
       UNION SELECT json_extract(payload,'$.provider'),json_extract(payload,'$.authIndex') FROM auth_state
       WHERE json_extract(payload,'$.provider') IN (${marks}) AND json_extract(payload,'$.status')!='removed'
       AND json_extract(payload,'$.authIndex')!=''`
    )
    .all(now - 7 * 86400000, ...providers, ...providers);
}

/** Ask each probed credential for its limits, keeping the last answer when one fails. */
export async function probeLimits(
  db: Database,
  base: string,
  key: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
) {
  const url = new URL('/v8/management/requests/api-call', base);
  for (const { provider, authIndex } of targets(db, now)) {
    const probe = probes[provider];
    if (!probe) continue;
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          auth_index: authIndex,
          method: probe.method,
          url: probe.url,
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
            ...(probe.data ? { 'Content-Type': 'application/json' } : {}),
            // Cloudflare refuses Go's default user agent in front of opencode.ai.
            'User-Agent': 'ai-pool-dashboard',
          },
          ...(probe.data ? { data: probe.data } : {}),
        }),
      });
      if (!response.ok) continue;
      const answer = object(await response.json());
      if (number(answer.status_code) !== 200) continue;
      const limits = probe.read(JSON.parse(string(answer.body)));
      if (!limits.length) continue;
      db.query(
        'INSERT INTO probed_limit VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET observed=excluded.observed,payload=excluded.payload'
      ).run(limitKey(provider, authIndex), now, JSON.stringify(limits));
    } catch {
      /* The last answer stands; the next round asks again. */
    }
  }
}

export function startLimitPoller(
  db: Database,
  base: string,
  loadKey: () => string,
  intervalMs = 300000
) {
  let running = false;
  const run = async () => {
    if (running || Date.now() < managementRetryAt(db)) return;
    running = true;
    try {
      const key = loadKey();
      if (key) await probeLimits(db, base, key);
    } catch {
      console.warn('Limit probe failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => clearInterval(timer);
}
