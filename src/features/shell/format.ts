import type { SessionSummary } from '@/services/history';

// Time and number formatting shared by the ai-pool pages, so every page says
// "resets in 3h 12m" or "Fri 9:52 PM" the same way.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "42m", "3h 12m", "2d 4h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Relative inside a day ("in 3h 12m"), otherwise weekday and time ("Fri 9:52 PM"). */
export function formatReset(resetAtMs: number, now: number): string {
  const remaining = resetAtMs - now;
  if (remaining <= 0) return 'now';
  if (remaining < DAY) return `in ${formatDuration(remaining)}`;
  const weekday = new Date(resetAtMs).toLocaleDateString(undefined, { weekday: 'short' });
  return remaining < 6 * DAY
    ? `${weekday} ${time(resetAtMs)}`
    : `${new Date(resetAtMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(resetAtMs)}`;
}

/** "6:39 AM" today, "Yesterday", "Mon", then "Oct 3". */
export function formatWhen(ms: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return time(ms);
  if (ms >= startOfToday - DAY) return 'Yesterday';
  if (ms >= startOfToday - 6 * DAY)
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 1234 -> "1,234", 38_400_000 -> "38.4M". */
export function formatCount(value: number): string {
  if (value < 10_000) return value.toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

export const formatSeconds = (ms: number | null) =>
  ms === null ? null : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** Short project name: repo URL basename, T3 worktree project, or cwd basename. */
export function projectName(session: Pick<SessionSummary, 'repo' | 'cwd'>): string {
  const repo = session.repo.replace(/\.git$/, '').replace(/\/+$/, '');
  if (repo) return repo.split(/[/:]/).pop() || repo;
  const worktree = session.cwd.match(/\/\.t3\/worktrees\/([^/]+)/);
  if (worktree) return worktree[1];
  return session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd;
}
