import type { AuthFileItem, Config, OpenAIProviderConfig } from '@/types';
import type { ProviderHealth } from '@/services/history';
import { buildProviderGroups } from '@/features/providers/useProviderWorkbench';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';

export type WorkspaceProvider = {
  id: string;
  name: string;
  channel: string;
  oauth: boolean;
  brand: ProviderBrand | null;
  files: AuthFileItem[];
  resources: ProviderResource[];
};

export const providerPath = (id: string) => `/providers/${encodeURIComponent(id)}`;
export const credentialId = (file: AuthFileItem) => `${file.name}:${file.authIndex ?? ''}`;
export function credentialLabel(file: AuthFileItem) {
  return file.runtimeOnly ? String(file.authIndex ?? '') : file.email || file.name;
}
export const workspaceChannel = (value: string) => {
  const normalized = normalizeOAuthProviderKey(value);
  return normalized === 'anthropic' ? 'claude' : normalized;
};

export function workspaceProviders(
  config: Config | null,
  files: AuthFileItem[]
): WorkspaceProvider[] {
  const accounts = files.filter((file) => !file.runtimeOnly);
  const channels = new Set([
    'codex',
    'claude',
    ...accounts.map((file) => workspaceChannel(file.provider || file.type || 'unknown')),
  ]);
  const providers: WorkspaceProvider[] = [...channels].map((channel) => ({
    id: channel,
    name: channel === 'codex' ? 'Codex' : channel === 'claude' ? 'Claude' : channel,
    channel,
    oauth: true,
    brand: null,
    resources: [],
    files: accounts.filter(
      (file) => workspaceChannel(file.provider || file.type || '') === channel
    ),
  }));
  for (const group of config ? buildProviderGroups(config) : []) {
    if (!group.resources.length) continue;
    if (group.id === 'openaiCompatibility') {
      for (const resource of group.resources) {
        const id = `openai:${resource.name || resource.originalIndex}`;
        providers.push({
          id,
          name: resource.name || 'OpenAI',
          channel: workspaceChannel(resource.name || 'openai'),
          oauth: false,
          brand: group.id,
          files: [],
          resources: [resource],
        });
      }
    } else {
      providers.push({
        id: `${group.id}-api-key`,
        name: `${group.id} API`,
        channel: group.id,
        oauth: false,
        brand: group.id,
        files: [],
        resources: group.resources,
      });
    }
  }
  return providers;
}

export function resourceAuthIndices(resource: ProviderResource): string[] {
  if (resource.brand === 'openaiCompatibility') {
    return ((resource.raw as OpenAIProviderConfig).apiKeyEntries ?? [])
      .map((key) => key.authIndex ?? '')
      .filter(Boolean);
  }
  return resource.authIndex ? [resource.authIndex] : [];
}

/** Match configured API keys by auth index so OAuth traffic stays separate. */
export function providerTraffic(provider: WorkspaceProvider, health: ProviderHealth[]) {
  const indices = new Set(
    [
      ...provider.files.map((file) => String(file.authIndex ?? '')),
      ...provider.resources.flatMap(resourceAuthIndices),
    ].filter(Boolean)
  );
  const credentials = health
    .flatMap((item) => item.credentials)
    .filter((credential) => indices.has(credential.authIndex));
  const named = health.find((item) => workspaceChannel(item.provider) === provider.channel);
  if (credentials.length) {
    return {
      requests: credentials.reduce((sum, item) => sum + item.requests, 0),
      failures: credentials.reduce((sum, item) => sum + item.failures, 0),
      // Percentiles cannot be averaged across credential distributions.
      p50:
        named && named.credentials.every((credential) => indices.has(credential.authIndex))
          ? named.latency.p50
          : credentials.length === 1
            ? credentials[0].latency.p50
            : null,
    };
  }
  if (
    named &&
    !named.credentials.length &&
    (provider.oauth || provider.brand === 'openaiCompatibility')
  ) {
    return { requests: named.requests, failures: named.failures, p50: named.latency.p50 };
  }
  return null;
}
