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
  scalarValueChanged,
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
  test('Codex relative resets expire attention and absolute resets take precedence', () => {
    const observation = {
      observed_at: new Date(now).toISOString(),
      signals: {
        'X-Codex-Primary-Used-Percent': '100',
        'X-Codex-Primary-Reset-After-Seconds': '60',
        'X-Codex-Limit-Reached': 'true',
      },
    };
    const windows = parseQuotaSignals('codex', observation);
    expect(windows[0]).toMatchObject({ resetAtMs: now + 60000, rejected: true });
    expect(quotaIsCurrent(windows[0], now + 59999)).toBe(true);
    expect(quotaIsCurrent(windows[0], now + 60000)).toBe(false);
    expect(
      deriveAttention([{ name: 'a', type: 'codex', quota: observation }], [], [], now + 60000)
    ).toEqual([]);
    expect(
      parseQuotaSignals('codex', {
        ...observation,
        signals: {
          ...observation.signals,
          'x-codex-primary-reset-at': String((now + 120000) / 1000),
        },
      })[0].resetAtMs
    ).toBe(now + 120000);
    expect(
      parseQuotaSignals('codex', { signals: { 'x-codex-limit-reached': 'true' } })[0]
    ).toMatchObject({ rejected: true, usedPercent: null, resetAtMs: null });
    expect(
      parseQuotaSignals('codex', { signals: { 'x-codex-primary-reset-after-seconds': '60' } })
    ).toEqual([]);
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
    expect(attention.map((item) => item.reason)).toEqual(['auth', 'problem']);
    expect(attention[1].category).toBe('transport');
  });
  test('a deliberately paused account does not hide another account or provider failures', () => {
    const paused = [
      {
        name: 'paused.json',
        type: 'codex',
        disabled: true,
        status: 'error',
        statusMessage: 'invalid_grant',
      },
    ];
    expect(deriveAttention(paused, [], [], now)).toEqual([]);
    expect(deriveAttention(paused, [problem()], [], now).map((item) => item.reason)).toEqual([
      'problem',
    ]);
    expect(
      deriveAttention(
        [
          ...paused,
          { name: 'broken.json', type: 'codex', status: 'error', statusMessage: 'invalid_grant' },
        ],
        [],
        [],
        now
      ).map((item) => item.file?.name)
    ).toEqual(['broken.json']);
    const traffic = { provider: 'codex', failures: 2, errorCounts: { auth: 2 } } as ProviderHealth;
    expect(deriveAttention(paused, [], [traffic], now)[0]).toMatchObject({
      reason: 'traffic',
      category: 'auth',
    });
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
  test('only explicit inline settings are editable, including when critical scalars exist', () => {
    const settings = scalarSettingsFromConfig(
      {
        management: { 'secret-key': 'synthetic', 'allow-remote': true },
        server: { host: '0.0.0.0', port: 8317, tls: { enable: true, cert: 'cert', key: 'key' } },
        oauth: { 'auth-dir': '/synthetic' },
        routing: { strategy: 'round-robin', retry: { 'request-retry': 7 } },
      },
      CONFIG_FIELD_SEARCH_INDEX
    );
    expect(Object.keys(settings).sort()).toEqual(Object.keys(INLINE_SETTINGS).sort());
    expect(settings.requestRetry).toMatchObject({
      path: ['routing', 'retry', 'request-retry'],
      fallback: 7,
      min: 0,
    });
    for (const field of CONFIG_FIELD_SEARCH_INDEX.filter((entry) =>
      /^(management\.|server\.(host|port|tls)|oauth\.auth-dir)/.test(
        entry.yamlKeys?.join('.') || ''
      )
    ))
      expect(settings[field.fieldId]).toBeUndefined();
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
  test('separates OAuth and API keys and hides runtime websocket credential names', () => {
    const providers = workspaceProviders(
      {
        codexApiKeys: [{ apiKey: 'fixture-key' }],
        openaiCompatibility: [
          { name: 'OpenCode Go', baseUrl: 'https://example.invalid', apiKeyEntries: [] },
        ],
      },
      [
        { name: 'codex.json', provider: 'codex' },
        { name: 'websocket-client', provider: 'aistudio', runtimeOnly: true },
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

test('palette scalar edits only save changed, valid values', () => {
  const number = INLINE_SETTINGS.requestRetry;
  expect(scalarValueChanged(number, '3', 3)).toBe(false);
  expect(scalarValueChanged(number, '03', 3)).toBe(false);
  expect(scalarValueChanged(number, '4', 3)).toBe(true);
  expect(scalarValueChanged(number, '', 3)).toBe(false);
  expect(scalarValueChanged(number, '-1', 3)).toBe(false);
  expect(scalarValueChanged(number, '4', undefined)).toBe(false);
  expect(scalarValueChanged(INLINE_SETTINGS.debug, false, false)).toBe(false);
  expect(scalarValueChanged(INLINE_SETTINGS.debug, true, false)).toBe(true);
  expect(scalarValueChanged(INLINE_SETTINGS.proxyUrl, '', '')).toBe(false);
  expect(scalarValueChanged(INLINE_SETTINGS.proxyUrl, 'http://localhost:8080', '')).toBe(true);
});
