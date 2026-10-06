import type { AuthFileItem, Config, OpenAIProviderConfig } from '@/types';
import type { ProviderHealth } from '@/services/history';
import { buildProviderGroups } from '@/features/providers/useProviderWorkbench';
import type { ProviderBrand, ProviderResource } from '@/features/providers/types';
import { normalizeOAuthProviderKey } from '@/utils/providerKeys';

export type WorkspaceProvider = {
  id: string;
  name: string;
  channel: string;
  /** Every channel this provider answers to; merged providers collect several. */
  channels: string[];
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
    channels: [channel],
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
          channels: [workspaceChannel(resource.name || 'openai')],
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
        channels: [group.id],
        oauth: false,
        brand: group.id,
        files: [],
        resources: group.resources,
      });
    }
  }
  return mergeSharedEndpoints(providers);
}

/** Display names for endpoints that several provider blocks point at. */
const KNOWN_ENDPOINTS: Record<string, string> = { 'opencode.ai/zen/go': 'OpenCode Go' };

const endpointKey = (baseUrl: string | null) =>
  (baseUrl ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');

/**
 * One upstream configured as several CPA blocks (e.g. `meta` keys and an
 * OpenAI-compatible entry for the same OpenCode Go endpoint) shows as one provider.
 */
function mergeSharedEndpoints(providers: WorkspaceProvider[]): WorkspaceProvider[] {
  const merged: WorkspaceProvider[] = [];
  const byEndpoint = new Map<string, WorkspaceProvider>();
  for (const provider of providers) {
    const endpoints = new Set(provider.resources.map((resource) => endpointKey(resource.baseUrl)));
    const [endpoint] = endpoints;
    if (provider.oauth || endpoints.size !== 1 || !endpoint) {
      merged.push(provider);
      continue;
    }
    const existing = byEndpoint.get(endpoint);
    if (!existing) {
      const entry = { ...provider, name: KNOWN_ENDPOINTS[endpoint] ?? provider.name };
      byEndpoint.set(endpoint, entry);
      merged.push(entry);
      continue;
    }
    existing.resources = [...existing.resources, ...provider.resources];
    existing.channels = [...new Set([...existing.channels, ...provider.channels])];
    // Prefer the OpenAI-compatible identity: its key list is where Add key appends.
    if (provider.brand === 'openaiCompatibility') {
      existing.id = provider.id;
      existing.brand = provider.brand;
      existing.channel = provider.channel;
    }
  }
  return merged;
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
  const matches = health.filter((item) =>
    provider.channels.includes(workspaceChannel(item.provider))
  );
  // Name-level totals only stand in when exactly one health entry matches.
  const named = matches.length === 1 ? matches[0] : undefined;
  if (credentials.length) {
    // Percentiles cannot be averaged across credential distributions.
    const percentiles =
      named && named.credentials.every((credential) => indices.has(credential.authIndex))
        ? named
        : credentials.length === 1
          ? credentials[0]
          : null;
    return {
      requests: credentials.reduce((sum, item) => sum + item.requests, 0),
      failures: credentials.reduce((sum, item) => sum + item.failures, 0),
      tokens: credentials.reduce((sum, item) => sum + item.tokens, 0),
      p50: percentiles?.latency.p50 ?? null,
      ttft: percentiles?.ttft.p50 ?? null,
    };
  }
  // Health named after the provider with no per-credential rows; merged providers sum
  // every channel. API-key providers never borrow a same-named OAuth channel's totals.
  if (
    matches.length &&
    matches.every((item) => !item.credentials.length) &&
    (provider.oauth || provider.brand === 'openaiCompatibility')
  ) {
    return {
      requests: matches.reduce((sum, item) => sum + item.requests, 0),
      failures: matches.reduce((sum, item) => sum + item.failures, 0),
      tokens: matches.reduce((sum, item) => sum + item.tokens, 0),
      p50: named?.latency.p50 ?? null,
      ttft: named?.ttft.p50 ?? null,
    };
  }
  return null;
}
