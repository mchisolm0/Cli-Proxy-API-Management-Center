import type { FailureClass, Problem, ProviderHealth } from '@/services/history';
import type { AuthFileItem } from '@/types';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import { parseCredentialQuota, quotaIsCurrent } from '@/features/providerWorkspace/quotaSignals';
import { credentialId, workspaceChannel } from '@/features/providerWorkspace/model';
import type { QuotaWindow } from '@/features/providerWorkspace/quotaSignals';

export type Attention = {
  id: string;
  provider: string;
  category: FailureClass;
  reason: 'auth' | 'quota' | 'cooldown' | 'unavailable' | 'problem' | 'traffic';
  file?: AuthFileItem;
  problem?: Problem;
  count?: number;
};

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
    const quota = (
      quotaByCredential[credentialId(file)] ??
      parseCredentialQuota(provider, file.quota, file.model_quotas)
    ).some(
      (window) =>
        quotaIsCurrent(window, now) && (window.rejected || (window.usedPercent ?? 0) >= 100)
    );
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
    }
  }
  for (const problem of problems) {
    if (problem.count <= 0) continue;
    const provider = workspaceChannel(problem.provider);
    // Credential state gives a more specific fix than an aggregate auth/quota group.
    if (
      ['auth', 'quota'].includes(problem.category) &&
      attention.some((item) => item.provider === provider && item.category === problem.category)
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
    if (!traffic.failures || attention.some((item) => item.provider === provider)) continue;
    const category =
      (Object.entries(traffic.errorCounts) as [FailureClass, number][]).sort(
        (a, b) => b[1] - a[1]
      )[0]?.[0] ?? 'other';
    attention.push({
      id: `traffic:${provider}`,
      provider,
      category,
      reason: 'traffic',
      count: traffic.failures,
    });
  }
  return attention.sort(
    (a, b) =>
      (a.category === 'auth' ? 0 : 1) - (b.category === 'auth' ? 0 : 1) ||
      (b.count ?? 0) - (a.count ?? 0)
  );
}
