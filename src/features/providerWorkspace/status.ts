import type { Attention } from '@/features/home/attention';
import type { WorkspaceProvider } from './model';

export type ProviderStatus = 'ok' | 'warning' | 'error' | 'paused' | 'unknown';

export const providerPaused = (provider: WorkspaceProvider) =>
  provider.oauth
    ? provider.files.length > 0 && provider.files.every((file) => file.disabled)
    : provider.resources.length > 0 && provider.resources.every((resource) => resource.disabled);

/** Red when something is broken, amber when a quota is running low. */
export function providerStatus(
  provider: WorkspaceProvider,
  attention: Attention[],
  known: boolean
): ProviderStatus {
  if (providerPaused(provider)) return 'paused';
  const items = attention.filter((item) => item.provider === provider.id);
  if (items.some((item) => item.reason !== 'quota_high')) return 'error';
  if (items.length) return 'warning';
  return known ? 'ok' : 'unknown';
}
