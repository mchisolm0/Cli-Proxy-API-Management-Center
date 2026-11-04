import type { FailureClass, Problem } from '@/services/history';
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
  reason: 'auth' | 'quota' | 'quota_high' | 'cooldown' | 'unavailable' | 'problem';
  file?: AuthFileItem;
  /** The window behind a quota_high warning. */
  window?: QuotaWindow;
  problem?: Problem;
  count?: number;
};

/** Client cancels and unclassified errors are not something the pool owner can fix. */
const actionable = (category: FailureClass) => category !== 'client' && category !== 'other';

/** Failures older than this stay on the Problems page instead of the home alerts. */
export const ALERT_WINDOW_MS = 60 * 60 * 1000;

/** A failure the client saw (not retried away by the proxy) in the last hour. */
const stillFailing = (problem: Problem, now: number) =>
  problem.inferredFinalFailures + problem.unresolvedAttempts > 0 &&
  now - problem.lastSeen <= ALERT_WINDOW_MS;

export function deriveAttention(
  files: AuthFileItem[],
  problems: Problem[],
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
    if (!actionable(problem.category) || !stillFailing(problem, now)) continue;
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
      count: problem.inferredFinalFailures + problem.unresolvedAttempts,
    });
  }
  // Blocking states first, early quota warnings last.
  const rank = (item: Attention) =>
    item.reason === 'quota_high' ? 2 : item.category === 'auth' ? 0 : 1;
  return attention.sort((a, b) => rank(a) - rank(b) || (b.count ?? 0) - (a.count ?? 0));
}
