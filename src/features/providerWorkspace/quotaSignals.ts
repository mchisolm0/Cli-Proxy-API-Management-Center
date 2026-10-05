import { isRecord } from '@/utils/helpers';
import { resolveResetMs } from '@/utils/quota/resetInstants';

export type QuotaWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
  rejected?: boolean;
  observedAt?: number | null;
  model?: string;
};

/** Passive credential observations only. Missing readings never mean zero usage. */
export function parseQuotaSignals(provider: string, observation: unknown): QuotaWindow[] {
  if (!isRecord(observation) || !isRecord(observation.signals)) return [];
  const signals = Object.fromEntries(
    Object.entries(observation.signals).map(([key, value]) => [key.toLowerCase(), value])
  );
  const number = (key: string) => {
    const value = signals[key];
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const observedAt = resolveResetMs([observation.observed_at]);
  if (provider === 'codex') {
    return ['primary', 'secondary'].flatMap((id) => {
      const prefix = `x-codex-${id}`;
      const usedPercent = number(`${prefix}-used-percent`);
      const resetAtMs = resolveResetMs([signals[`${prefix}-reset-at`]]);
      const minutes = number(`${prefix}-window-minutes`);
      if (usedPercent === null && resetAtMs === null) return [];
      return [
        {
          id,
          label: id,
          usedPercent,
          resetAtMs,
          periodHours: minutes && minutes > 0 ? minutes / 60 : null,
          observedAt,
        },
      ];
    });
  }
  if (provider === 'claude' || provider === 'anthropic') {
    return ['5h', '7d'].flatMap((id) => {
      const prefix = `anthropic-ratelimit-unified-${id}`;
      const utilization = number(`${prefix}-utilization`);
      const rejected = signals[`${prefix}-status`] === 'rejected';
      const resetAtMs = resolveResetMs([signals[`${prefix}-reset`]]);
      if (utilization === null && !rejected && resetAtMs === null) return [];
      return [
        {
          id,
          label: id,
          usedPercent: utilization === null ? null : utilization * 100,
          resetAtMs,
          periodHours: id === '5h' ? 5 : 168,
          rejected,
          observedAt,
        },
      ];
    });
  }
  return [];
}

export function parseCredentialQuota(
  provider: string,
  quota: unknown,
  modelQuotas?: unknown
): QuotaWindow[] {
  const windows = parseQuotaSignals(provider, quota);
  if (!isRecord(modelQuotas)) return windows;
  return [
    ...windows,
    ...Object.entries(modelQuotas).flatMap(([model, observation]) =>
      parseQuotaSignals(provider, observation).map((window) => ({
        ...window,
        id: `${model}:${window.id}`,
        model,
      }))
    ),
  ];
}

export function quotaIsCurrent(window: QuotaWindow, now: number): boolean {
  if (window.resetAtMs !== null && window.resetAtMs <= now) return false;
  // ponytail: observations without a reset expire after one day; add provider TTLs if needed.
  return !window.observedAt || now - window.observedAt < 86_400_000;
}

export function tightestQuota(windows: QuotaWindow[], now: number): QuotaWindow | undefined {
  return windows
    .filter((window) => quotaIsCurrent(window, now) && window.usedPercent !== null)
    .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
}
