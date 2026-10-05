import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { authFilesApi } from '@/services/api';
import { apiClient } from '@/services/api/client';
import {
  historyApi,
  type HealthResponse,
  type ProblemsResponse,
  type SearchResponse,
} from '@/services/history';
import { useAuthStore, useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  AUTH_FILES_CHANGED_EVENT,
  notifyAuthFilesChanged,
} from '@/features/authFiles/authFilesEvents';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useTranslation } from 'react-i18next';
import { deriveAttention } from '@/features/home/attention';
import {
  credentialId,
  resourceAuthIndices,
  workspaceProviders,
  type WorkspaceProvider,
} from './model';
import { parseCredentialQuota, type QuotaWindow } from './quotaSignals';
import { getQuotaCacheKey } from '@/utils/quota/identity';

type Snapshot = {
  files: AuthFileItem[];
  health: HealthResponse | null;
  problems: ProblemsResponse | null;
  recent: SearchResponse | null;
  errors: string[];
  loading: boolean;
};
const empty: Snapshot = {
  files: [],
  health: null,
  problems: null,
  recent: null,
  errors: [],
  loading: true,
};

function usePoolData() {
  const { t } = useTranslation();
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const workbench = useProviderWorkbench();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [data, setData] = useState(empty);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const connectionRevision = useRef(apiClient.getConnectionRevision());
  const mutationPending = useRef(false);
  const notification = useNotificationStore((state) => state.showNotification);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);

  const refresh = useCallback(async () => {
    if (!connected) return;
    const id = ++request.current;
    const revision = apiClient.getConnectionRevision();
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setData((previous) => ({ ...previous, loading: true }));
    const results = await Promise.allSettled([
      authFilesApi.list(),
      historyApi.health('24h', controller.signal),
      historyApi.problems('24h', controller.signal),
      historyApi.search({}, controller.signal),
      fetchConfig(),
    ]);
    if (!alive.current || id !== request.current || revision !== apiClient.getConnectionRevision())
      return;
    const [files, health, problems, recent] = results;
    const labels = ['credentials', 'health', 'problems', 'sessions', 'settings'];
    setData({
      files: files.status === 'fulfilled' ? files.value.files : [],
      health: health.status === 'fulfilled' ? health.value : null,
      problems: problems.status === 'fulfilled' ? problems.value : null,
      recent: recent.status === 'fulfilled' ? recent.value : null,
      errors: results.flatMap((result, index) =>
        result.status === 'rejected' ? [labels[index]] : []
      ),
      loading: false,
    });
  }, [connected, fetchConfig]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener(AUTH_FILES_CHANGED_EVENT, refresh);
    return () => {
      alive.current = false;
      abort.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener(AUTH_FILES_CHANGED_EVENT, refresh);
    };
  }, [refresh]);
  useHeaderRefresh(refresh);

  const run = async (action: () => Promise<unknown>) => {
    if (
      mutationPending.current ||
      !connected ||
      !alive.current ||
      connectionRevision.current !== apiClient.getConnectionRevision()
    )
      return;
    const revision = apiClient.getConnectionRevision();
    setBusy(true);
    mutationPending.current = true;
    try {
      await action();
      if (!alive.current || revision !== apiClient.getConnectionRevision()) return;
      notification(t('shell.saved'), 'success');
    } catch (error) {
      if (alive.current && revision === apiClient.getConnectionRevision()) {
        notification(error instanceof Error ? error.message : t('shell.save_failed'), 'error');
      }
    } finally {
      mutationPending.current = false;
      if (alive.current && revision === apiClient.getConnectionRevision()) {
        setBusy(false);
        await refresh();
      }
    }
  };
  const setCredential = async (file: AuthFileItem, disabled: boolean) => {
    if (connectionRevision.current !== apiClient.getConnectionRevision() || !alive.current)
      throw new DOMException('Connection changed', 'AbortError');
    await authFilesApi.setStatus(file.name, disabled, String(file.authIndex ?? '') || undefined);
    if (connectionRevision.current !== apiClient.getConnectionRevision() || !alive.current) return;
    useQuotaStore.getState().clearQuotaCache([file.name]);
    notifyAuthFilesChanged();
  };
  const quotaForFile = useCallback(
    (file: AuthFileItem): QuotaWindow[] => {
      const provider = file.provider || file.type;
      const cached =
        provider === 'codex'
          ? codexQuota[getQuotaCacheKey(file)]
          : provider === 'claude' || provider === 'anthropic'
            ? claudeQuota[getQuotaCacheKey(file)]
            : undefined;
      if (cached?.status === 'success')
        return cached.windows.map((window) => ({
          ...window,
          resetAtMs: window.resetAtMs ?? null,
          periodHours: window.periodHours ?? null,
        }));
      const live = parseCredentialQuota(String(provider), file.quota, file.model_quotas);
      if (live.length) return live;
      const historical = data.health?.providers
        .flatMap((item) => item.credentials)
        .find((item) => item.authIndex === String(file.authIndex))?.state;
      return parseCredentialQuota(String(provider), historical?.quota, historical?.modelQuotas);
    },
    [codexQuota, claudeQuota, data.health]
  );
  const quotaForProvider = (provider: WorkspaceProvider): QuotaWindow[] => {
    if (provider.oauth)
      return provider.files.filter((file) => !file.disabled).flatMap(quotaForFile);
    const indices = new Set(provider.resources.flatMap(resourceAuthIndices));
    const live = data.files.filter((file) => indices.has(String(file.authIndex)) && !file.disabled);
    const historical = data.health?.providers
      .flatMap((item) => item.credentials)
      .filter(
        (item) =>
          indices.has(item.authIndex) &&
          !live.some((file) => String(file.authIndex) === item.authIndex)
      );
    return [
      ...live.flatMap(quotaForFile),
      ...(historical ?? []).flatMap((item) =>
        parseCredentialQuota(
          item.state?.provider ?? provider.channel,
          item.state?.quota,
          item.state?.modelQuotas
        )
      ),
    ];
  };
  const providers = useMemo(() => workspaceProviders(config, data.files), [config, data.files]);
  const attention = useMemo(
    () =>
      deriveAttention(
        data.files,
        data.problems?.problems ?? [],
        data.health?.providers ?? [],
        now,
        Object.fromEntries(data.files.map((file) => [credentialId(file), quotaForFile(file)]))
      ).map((item) => {
        const matched = item.file?.runtimeOnly
          ? providers.find((provider) =>
              provider.resources.some((resource) =>
                resourceAuthIndices(resource).includes(String(item.file?.authIndex))
              )
            )
          : providers.find((provider) => provider.id === item.provider);
        const byModel =
          matched ??
          providers.find((provider) => provider.channel === item.provider) ??
          providers.find(
            (provider) =>
              item.problem?.model &&
              provider.resources.some((resource) => resource.models.includes(item.problem!.model))
          );
        return byModel ? { ...item, provider: byModel.id } : item;
      }),
    [data, now, providers, quotaForFile]
  );
  return {
    ...data,
    now,
    providers,
    attention,
    workbench,
    refresh,
    run,
    busy,
    connected,
    setCredential,
    quotaForFile,
    quotaForProvider,
  };
}

const PoolContext = createContext<ReturnType<typeof usePoolData> | null>(null);
export function PoolProvider({ children }: { children: ReactNode }) {
  const value = usePoolData();
  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>;
}
export function usePool() {
  const context = useContext(PoolContext);
  if (!context) throw new Error('PoolProvider is missing');
  return context;
}
