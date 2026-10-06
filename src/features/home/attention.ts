import type { FailureClass, Problem, ProviderHealth } from '@/services/history';
import type { AuthFileItem } from '@/types';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import {
  parseCredentialQuota,
  QUOTA_WARNING_PERCENT,
  quotaIsCurrent,
} from '@/features/providerWorkspace/quotaSignals';
import { credentialId, workspaceChannel } from '@/features/providerWorkspace/model';
import type { QuotaWindow } from '@/features/providerWorkspace/quotaSignals';

export type Attention = {
  id: string;
  provider: string;
  category: FailureClass;
  reason: 'auth' | 'quota' | 'quota_high' | 'cooldown' | 'unavailable' | 'problem' | 'traffic';
  file?: AuthFileItem;
  /** The window behind a quota_high warning. */
  window?: QuotaWindow;
  problem?: Problem;
  count?: number;
};

/** Client cancels and unclassified errors are not something the pool owner can fix. */
const actionable = (category: FailureClass) => category !== 'client' && category !== 'other';

export function deriveAttention(
  files: AuthFileItem[],
  problems: Problem[],
  health: ProviderHealth[],
  now: number,
  quotaByCredential: Record<string, QuotaWindow[]> = {}
): Attention[] {
  const attention: Attention[] = [];
  for (const file of files) {
    if (file.disabled) continue;
    const provider = workspaceChannel(file.provider || file.type || 'unknown');
    const base = { id: `credential:${credentialId(file)}`, provider, file };
    const cooldown = file.cooldownSnapshot && summarizeCooldowns(file.cooldownSnapshot, now);
    const windows = (
      quotaByCredential[credentialId(file)] ??
      parseCredentialQuota(provider, file.quota, file.model_quotas)
    ).filter((window) => quotaIsCurrent(window, now));
    const quota = windows.some((window) => window.rejected || (window.usedPercent ?? 0) >= 100);
    const reason = quota
      ? 'quota'
      : cooldown?.earliestSeconds
        ? 'cooldown'
        : file.status === 'error'
          ? /401|unauthor|expired|invalid_grant|oauth|token/i.test(file.statusMessage || '')
            ? 'auth'
            : 'unavailable'
          : file.unavailable
            ? 'unavailable'
            : null;
    if (reason) {
      const cooldownReason = cooldown?.rows.find((row) => row.remainingSeconds > 0)?.record.reason;
      const category: FailureClass =
        reason === 'quota'
          ? 'quota'
          : reason === 'cooldown'
            ? cooldownReason?.includes('quota')
              ? 'quota'
              : ['invalid_grant', 'unauthorized'].includes(cooldownReason || '')
                ? 'auth'
                : 'upstream'
            : reason === 'unavailable'
              ? 'upstream'
              : 'auth';
      attention.push({ ...base, reason, category });
      continue;
    }
    const high = windows
      .filter((window) => (window.usedPercent ?? 0) >= QUOTA_WARNING_PERCENT)
      .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    if (high) attention.push({ ...base, reason: 'quota_high', category: 'quota', window: high });
  }
  for (const problem of problems) {
    if (problem.count <= 0 || !actionable(problem.category)) continue;
    const provider = workspaceChannel(problem.provider);
    // Credential state gives a more specific fix than an aggregate auth/quota group.
    if (
      ['auth', 'quota'].includes(problem.category) &&
      attention.some(
        (item) =>
          item.provider === provider &&
          item.category === problem.category &&
          item.reason !== 'quota_high'
      )
    )
      continue;
    attention.push({
      id: `problem:${problem.key}`,
      provider,
      category: problem.category,
      reason: 'problem',
      problem,
      count: problem.count,
    });
  }
  for (const traffic of health) {
    const provider = workspaceChannel(traffic.provider);
    if (
      !traffic.failures ||
      attention.some((item) => item.provider === provider && item.reason !== 'quota_high')
    )
      continue;
    const category = (Object.entries(traffic.errorCounts) as [FailureClass, number][])
      .filter(([key, count]) => count > 0 && actionable(key))
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!category) continue;
    attention.push({
      id: `traffic:${provider}`,
      provider,
      category,
      reason: 'traffic',
      count: traffic.errorCounts[category],
    });
  }
  // Blocking states first, early quota warnings last.
  const rank = (item: Attention) =>
    item.reason === 'quota_high' ? 2 : item.category === 'auth' ? 0 : 1;
  return attention.sort((a, b) => rank(a) - rank(b) || (b.count ?? 0) - (a.count ?? 0));
}
