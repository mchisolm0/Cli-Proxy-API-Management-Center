import { describe, expect, test } from 'bun:test';
import {
  parseQuotaSignals,
  quotaIsCurrent,
  tightestQuota,
  parseCredentialQuota,
} from '../src/features/providerWorkspace/quotaSignals';
import { deriveAttention } from '../src/features/home/attention';
import {
  INLINE_SETTINGS,
  parseScalarValue,
  rankCommands,
  scalarSettingsFromConfig,
} from '../src/features/palette/ranking';
import {
  credentialLabel,
  workspaceProviders,
  providerTraffic,
} from '../src/features/providerWorkspace/model';
import type { Problem, ProviderHealth } from '../src/services/history';
import { CONFIG_FIELD_SEARCH_INDEX } from '../src/features/config/searchIndex';

const now = Date.parse('2026-10-05T12:00:00Z');
const problem = (overrides: Partial<Problem> = {}): Problem => ({
  key: 'auth:codex',
  source: 'proxy',
  provider: 'codex',
  model: 'gpt',
  category: 'auth',
  code: '401',
  count: 5,
  firstSeen: now - 1000,
  lastSeen: now,
  affectedSessions: 1,
  retriedAttempts: 0,
  inferredFinalFailures: 5,
  unresolvedAttempts: 0,
  attemptErrors: 5,
  fix: 're-login',
  examples: [],
  sessions: [],
  sessionCount: 0,
  unindexedSessionCount: 1,
  ...overrides,
});

describe('workspace quota observations', () => {
  test('keeps model-scoped quota limits separate from the credential window', () => {
    const quota = parseCredentialQuota('codex', null, {
      'gpt-6': {
        signals: {
          'X-Codex-Primary-Used-Percent': '100',
          'X-Codex-Primary-Window-Minutes': '300',
        },
      },
    });
    expect(quota[0]).toMatchObject({ id: 'gpt-6:primary', model: 'gpt-6', usedPercent: 100 });
  });
  test('reads case-insensitive Codex headers without assuming the primary duration', () => {
    const windows = parseQuotaSignals('codex', {
      signals: {
        'X-Codex-Primary-Used-Percent': '73',
        'x-codex-primary-window-minutes': '10080',
        'X-Codex-Primary-Reset-At': String((now + 3600000) / 1000),
        'X-Codex-Secondary-Used-Percent': '6',
        'X-Codex-Secondary-Window-Minutes': '300',
      },
    });
    expect(windows[0]).toMatchObject({
      usedPercent: 73,
      resetAtMs: now + 3600000,
      periodHours: 168,
    });
    expect(windows[1].periodHours).toBe(5);
    expect(tightestQuota(windows, now)?.usedPercent).toBe(73);
  });
  test('Claude utilization is fractional and rejection does not invent a percentage', () => {
    const windows = parseQuotaSignals('claude', {
      signals: {
        'Anthropic-Ratelimit-Unified-5h-Utilization': '0.35',
        'Anthropic-Ratelimit-Unified-5h-Reset': '2026-10-05T14:00:00Z',
        'Anthropic-Ratelimit-Unified-7d-Status': 'rejected',
      },
    });
    expect(windows[0]).toMatchObject({ usedPercent: 35, resetAtMs: now + 7200000 });
    expect(windows[1]).toMatchObject({ usedPercent: null, rejected: true });
  });
  test('invalid, missing and expired observations cannot become healthy zeroes or active limits', () => {
    expect(parseQuotaSignals('codex', { signals: { 'x-codex-primary-used-percent': '' } })).toEqual(
      []
    );
    expect(
      parseQuotaSignals('codex', { signals: { 'x-codex-primary-used-percent': 'NaN' } })
    ).toEqual([]);
    expect(parseQuotaSignals('codex', null)).toEqual([]);
    const expired = parseQuotaSignals('codex', {
      observed_at: '2026-10-04T10:00:00Z',
      signals: { 'x-codex-primary-used-percent': '100' },
    });
    expect(quotaIsCurrent(expired[0], now)).toBe(false);
    expect(tightestQuota(expired, now)).toBeUndefined();
  });
});

describe('home attention', () => {
  test('prefers credential actions, deduplicates auth aggregates, and keeps unrelated failures', () => {
    const attention = deriveAttention(
      [
        { name: 'login.json', type: 'codex', status: 'error', statusMessage: 'invalid_grant' },
        { name: 'paused.json', type: 'claude', disabled: true },
        { name: 'healthy.json', type: 'codex', status: 'active' },
      ],
      [
        problem(),
        problem({ key: 'transport', provider: 'claude', category: 'transport', code: 'timeout' }),
      ],
      [],
      now
    );
    expect(attention.map((item) => item.reason)).toEqual(['auth', 'disabled', 'problem']);
    expect(attention[2].category).toBe('transport');
  });
  test('uses live cooldown deadlines and distinguishes transient failures from quota', () => {
    const attention = deriveAttention(
      [
        {
          name: 'cooling.json',
          type: 'codex',
          cooldownSnapshot: {
            receivedAtMs: now - 15000,
            records: [
              { scope: 'model', reason: 'transient_error', retryAt: '', remainingSeconds: 30 },
            ],
          },
        },
        {
          name: 'reset.json',
          type: 'codex',
          quota: {
            signals: {
              'x-codex-primary-used-percent': '100',
              'x-codex-primary-reset-at': String((now - 1000) / 1000),
            },
          },
        },
      ],
      [],
      [],
      now
    );
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ reason: 'cooldown', category: 'upstream' });
    expect(deriveAttention([], [], [], now)).toEqual([]);
  });
  test('Claude rejected quota without a utilization still needs attention', () => {
    expect(
      deriveAttention(
        [
          {
            name: 'claude.json',
            type: 'claude',
            quota: {
              signals: {
                'anthropic-ratelimit-unified-5h-status': 'rejected',
              },
            },
          },
        ],
        [],
        [],
        now
      )[0]
    ).toMatchObject({ category: 'quota', reason: 'quota' });
  });
});

describe('palette matching and scalar edits', () => {
  test('detects configured scalars without replacing structured fields', () => {
    const settings = scalarSettingsFromConfig(
      { server: { port: 8317, 'trusted-proxies': [] }, routing: { strategy: 'round-robin' } },
      CONFIG_FIELD_SEARCH_INDEX
    );
    expect(settings.port).toMatchObject({ path: ['server', 'port'], fallback: 8317 });
    expect(settings.routingStrategy.fallback).toBe('round-robin');
    expect(settings.trustedProxies).toBeUndefined();
  });
  test('inline writes target the same v8 paths as the existing config editor', () => {
    for (const [fieldId, setting] of Object.entries(INLINE_SETTINGS)) {
      expect(
        CONFIG_FIELD_SEARCH_INDEX.find((field) => field.fieldId === fieldId)?.yamlKeys
      ).toEqual(setting.path);
    }
  });
  test('ranks exact and prefix matches first, matches every token, and preserves ties', () => {
    const commands = [
      { id: '1', label: 'Open Claude', group: 'Providers' },
      { id: '2', label: 'Claude', group: 'Providers' },
      { id: '3', label: 'Claude settings', group: 'Settings' },
      { id: '4', label: 'Re-login Codex', group: 'Actions', keywords: 'oauth' },
    ];
    expect(rankCommands(commands, 'claude').map((item) => item.id)).toEqual(['2', '3', '1']);
    expect(rankCommands(commands, 'oauth codex').map((item) => item.id)).toEqual(['4']);
    expect(rankCommands(commands, 'claude codex')).toEqual([]);
    expect(rankCommands(commands, '').map((item) => item.id)).toEqual(['1', '2', '3', '4']);
  });
  test('rejects empty, fractional, negative and overflowing retry values while preserving booleans', () => {
    const retry = INLINE_SETTINGS.requestRetry;
    expect(parseScalarValue(retry, '0')).toBe(0);
    for (const value of ['', ' ', '-1', '0.5', 'Infinity', '9007199254740992'])
      expect(() => parseScalarValue(retry, value)).toThrow();
    expect(parseScalarValue(INLINE_SETTINGS.wsAuth, false)).toBe(false);
    expect(parseScalarValue(INLINE_SETTINGS.transientErrorCooldownSeconds, '-1')).toBe(-1);
  });
});

describe('provider identity', () => {
  test('separates OAuth and API keys and never uses a runtime credential secret as a label', () => {
    const providers = workspaceProviders(
      {
        codexApiKeys: [{ apiKey: 'fixture-key' }],
        openaiCompatibility: [
          { name: 'OpenCode Go', baseUrl: 'https://example.invalid', apiKeyEntries: [] },
        ],
      },
      [
        { name: 'codex.json', provider: 'codex' },
        { name: 'sensitive-key', provider: 'codex', runtimeOnly: true },
      ]
    );
    expect(providers.map((provider) => provider.id)).toEqual([
      'codex',
      'claude',
      'codex-api-key',
      'openai:OpenCode Go',
    ]);
    expect(providers[0].files).toHaveLength(1);
    expect(
      credentialLabel({ name: 'secret', runtimeOnly: true, authIndex: '12', account: 'secret' })
    ).not.toContain('secret');
  });
  test('matches API traffic by auth index without borrowing OAuth totals', () => {
    const providers = workspaceProviders(
      { codexApiKeys: [{ apiKey: 'fixture', authIndex: 'key' }] },
      [{ name: 'oauth.json', provider: 'codex', authIndex: 'oauth' }]
    );
    const traffic: ProviderHealth = {
      provider: 'codex',
      requests: 150,
      failures: 10,
      failureRate: 10 / 150,
      latency: { p50: 120, p95: 200 },
      ttft: { p50: null, p95: null },
      tokens: 0,
      websocket: 0,
      http: 150,
      unknown: 0,
      errorCounts: { auth: 0, quota: 0, upstream: 10, transport: 0, client: 0, other: 0 },
      usageErrorCounts: { auth: 0, quota: 0, upstream: 0, transport: 0, client: 0, other: 0 },
      authSummary: {},
      credentials: [],
    };
    traffic.credentials = [
      { ...traffic, authIndex: 'oauth', observed: now, state: null, requests: 100, failures: 0 },
      { ...traffic, authIndex: 'key', observed: now, state: null, requests: 50, failures: 10 },
    ];
    expect(providerTraffic(providers[0], [traffic])).toMatchObject({ requests: 100, failures: 0 });
    expect(providerTraffic(providers[2], [traffic])).toMatchObject({ requests: 50, failures: 10 });
  });
});
