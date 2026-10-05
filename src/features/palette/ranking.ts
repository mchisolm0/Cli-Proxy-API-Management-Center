export type SearchableCommand = { id: string; label: string; keywords?: string; group: string };

/** Prefer exact and prefix matches, then require every word to match. Stable on ties. */
export function rankCommands<T extends SearchableCommand>(commands: T[], query: string): T[] {
  const q = query.toLocaleLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  return commands
    .map((command, index) => {
      const label = command.label.toLocaleLowerCase();
      const haystack = `${label} ${command.keywords || ''} ${command.group}`.toLocaleLowerCase();
      const score = label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 3;
      return { command, index, score, matches: words.every((word) => haystack.includes(word)) };
    })
    .filter((item) => item.matches)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.command);
}

export type ScalarSetting = {
  path: string[];
  fallback: boolean | number | string;
  min?: number;
  max?: number;
};
export const INLINE_SETTINGS: Record<string, ScalarSetting> = {
  transientErrorCooldownSeconds: {
    path: ['routing', 'cooldown', 'transient-error-cooldown-seconds'],
    fallback: 0,
    min: -1,
  },
  requestRetry: { path: ['routing', 'retry', 'request-retry'], fallback: 3, min: 0 },
  maxRetryCredentials: { path: ['routing', 'retry', 'max-retry-credentials'], fallback: 0, min: 0 },
  maxRetryInterval: { path: ['routing', 'retry', 'max-retry-interval'], fallback: 30, min: 0 },
  wsAuth: { path: ['oauth', 'providers', 'aistudio', 'ws-auth'], fallback: true },
  debug: { path: ['observability', 'logs', 'debug'], fallback: false },
  loggingToFile: { path: ['observability', 'logs', 'logging-to-file'], fallback: false },
  logsMaxTotalSizeMb: {
    path: ['observability', 'logs', 'logs-max-total-size-mb'],
    fallback: 0,
    min: 0,
  },
  proxyUrl: { path: ['requests', 'proxy-url'], fallback: '' },
  passthroughHeaders: { path: ['requests', 'passthrough-headers'], fallback: false },
  errorLogsMaxFiles: {
    path: ['observability', 'logs', 'error-logs-max-files'],
    fallback: 10,
    min: 0,
  },
  redisUsageQueueRetentionSeconds: {
    path: ['observability', 'usage', 'redis-usage-queue-retention-seconds'],
    fallback: 60,
    min: 0,
  },
};

/** Only allowlisted settings can be edited inline. All others open the config editor. */
export function scalarSettingsFromConfig(
  raw: unknown,
  fields: readonly { fieldId: string; yamlKeys?: string[] }[]
): Record<string, ScalarSetting> {
  const settings = { ...INLINE_SETTINGS };
  for (const field of fields) {
    if (
      !Object.prototype.hasOwnProperty.call(INLINE_SETTINGS, field.fieldId) ||
      !field.yamlKeys?.length
    )
      continue;
    const value = field.yamlKeys.reduce<unknown>(
      (parent, key) =>
        parent !== null && typeof parent === 'object' && !Array.isArray(parent)
          ? (parent as Record<string, unknown>)[key]
          : undefined,
      raw
    );
    if (
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isSafeInteger(value))
    ) {
      settings[field.fieldId] = {
        ...settings[field.fieldId],
        path: field.yamlKeys,
        fallback: value,
      };
    }
  }
  return settings;
}

export function parseScalarValue(setting: ScalarSetting, draft: string | boolean) {
  if (typeof setting.fallback === 'boolean') {
    if (typeof draft !== 'boolean') throw new Error('Invalid boolean');
    return draft;
  }
  if (typeof setting.fallback === 'string') return String(draft);
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('Invalid number');
  const value = Number(draft);
  if (
    !Number.isSafeInteger(value) ||
    value < (setting.min ?? -Infinity) ||
    value > (setting.max ?? Infinity)
  )
    throw new Error('Invalid number');
  return value;
}

/** Compare parsed values so equivalent numeric drafts cannot trigger a config migration. */
export function scalarValueChanged(
  setting: ScalarSetting,
  draft: string | boolean,
  original: ScalarSetting['fallback'] | undefined
): boolean {
  if (original === undefined) return false;
  try {
    return parseScalarValue(setting, draft) !== original;
  } catch {
    return false;
  }
}
