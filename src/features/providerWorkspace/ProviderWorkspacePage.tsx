import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { authFilesApi, providersApi } from '@/services/api';
import { apiClient } from '@/services/api/client';
import { useConfigStore, useNotificationStore, useQuotaStore } from '@/stores';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores/useQuotaStore';
import { ProviderSheet, type ProviderSheetState } from '@/features/providers/sheets/ProviderSheet';
import type {
  AuthFileItem,
  OpenAIProviderConfig,
  ProviderKeyConfig,
  OAuthModelAliasEntry,
} from '@/types';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { summarizeCooldowns, cooldownReasonKey } from '@/features/authFiles/cooldowns';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { maskApiKey } from '@/utils/format';
import { usePool } from './PoolContext';
import {
  credentialId,
  credentialLabel,
  providerPath,
  providerTraffic,
  workspaceProviders,
} from './model';
import { quotaIsCurrent, type QuotaWindow } from './quotaSignals';
import { ProblemRows } from './ProblemRows';
import { OAuthDialog } from './OAuthDialog';
import { confirmAccountLogin, confirmPoolChange } from './actions';
import styles from './Workspace.module.scss';

function QuotaMeters({ windows, now }: { windows: QuotaWindow[]; now: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.meters}>
      {windows.map((window, index) => {
        const current = quotaIsCurrent(window, now);
        const label =
          window.periodHours === 5
            ? t('shell.five_hour')
            : window.periodHours === 168
              ? t('shell.weekly')
              : window.label === 'primary' || window.label === 'secondary'
                ? t(`shell.${window.label}`)
                : window.label;
        const percent = window.usedPercent;
        return (
          <div
            className={styles.meter}
            key={`${window.id}:${index}`}
            data-stale={!current}
            data-level={
              window.rejected || (percent ?? 0) >= 90
                ? 'high'
                : (percent ?? 0) >= 70
                  ? 'medium'
                  : 'low'
            }
          >
            <span>{window.model ? `${window.model} · ${label}` : label}</span>
            {percent === null ? (
              <span className={styles.unknownMeter} aria-hidden />
            ) : (
              <meter
                min={0}
                max={100}
                low={70}
                high={90}
                optimum={0}
                value={Math.min(100, percent)}
                aria-label={label}
              />
            )}
            <strong>
              {window.rejected
                ? t('shell.exhausted')
                : percent === null
                  ? t('shell.unknown')
                  : `${Math.round(percent)}%`}
            </strong>
            <span>
              {window.resetAtMs
                ? t('shell.resets_at', { time: new Date(window.resetAtMs).toLocaleString() })
                : t('shell.reset_unknown')}
              {!current && ` · ${t('shell.stale')}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ProvidersPage() {
  const { t } = useTranslation();
  const pool = usePool();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('shell.providers')}</h1>
        <Link className={styles.action} to="/ai-providers">
          {t('shell.add_provider')}
        </Link>
      </header>
      {pool.providers.map((provider) => (
        <Link className={styles.providerRow} key={provider.id} to={providerPath(provider.id)}>
          <strong>{provider.name}</strong>
          <span>
            {t(provider.oauth ? 'shell.account_count' : 'shell.key_count', {
              count: provider.oauth
                ? provider.files.length
                : provider.resources.reduce(
                    (sum, resource) => sum + Math.max(1, resource.apiKeyEntryCount),
                    0
                  ),
            })}
          </span>
          <span>{t('shell.open_provider')}</span>
        </Link>
      ))}
    </div>
  );
}

export function ProviderWorkspacePage() {
  const { provider: id } = useParams();
  // Route changes remount drafts, details and pending reads.
  return <Workspace key={id} id={id || ''} />;
}

function Workspace({ id }: { id: string }) {
  const { t } = useTranslation();
  const pool = usePool();
  const [params, setParams] = useSearchParams();
  const provider = pool.providers.find((entry) => entry.id === id);
  const [login, setLogin] = useState<string | null>(null);
  const [details, setDetails] = useState<AuthFileItem | null>(null);
  const [sheet, setSheet] = useState<ProviderSheetState>({
    open: false,
    brand: 'openaiCompatibility',
    mode: 'create',
    resource: null,
  });
  const [models, setModels] = useState<string[]>([]);
  const [aliases, setAliases] = useState<OAuthModelAliasEntry[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState(false);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const loadedAction = useRef(false);

  useEffect(() => {
    if (!provider?.oauth) return;
    let active = true;
    const revision = apiClient.getConnectionRevision();
    setModelsError(false);
    const exposedModels = Promise.all(
      provider.files
        .filter((file) => !file.disabled)
        .map((file) => authFilesApi.getModelsForAuthFile(file.name))
    ).then((lists) => [...new Set(lists.flat().map((model) => model.id))]);
    void Promise.allSettled([
      exposedModels,
      authFilesApi.getOauthModelAlias(),
      authFilesApi.getOauthExcludedModels(),
    ]).then(([definitions, mapping, rules]) => {
      if (!active || revision !== apiClient.getConnectionRevision()) return;
      setModels(definitions.status === 'fulfilled' ? definitions.value : []);
      setAliases(mapping.status === 'fulfilled' ? (mapping.value[provider.channel] ?? []) : []);
      setExcluded(rules.status === 'fulfilled' ? (rules.value[provider.channel] ?? []) : []);
      setModelsError([definitions, mapping, rules].some((result) => result.status === 'rejected'));
    });
    return () => {
      active = false;
    };
  }, [provider?.oauth, provider?.channel, provider?.files]);

  useEffect(() => {
    if (!provider || loadedAction.current) return;
    if ((params.get('edit') === 'models' || params.get('add') === '1') && provider.brand) {
      loadedAction.current = true;
      const resource = provider.resources[0] ?? null;
      setSheet({
        open: true,
        mode: params.get('add') === '1' ? 'create' : 'edit',
        brand: provider.brand,
        resource: params.get('add') === '1' ? null : resource,
      });
      setParams({}, { replace: true });
    }
  }, [params, provider, setParams]);

  if (!provider)
    return (
      <div className={styles.page}>
        <h1>{t(pool.loading ? 'shell.loading' : 'shell.provider_missing')}</h1>
        <Link to="/providers">{t('shell.providers')}</Link>
      </div>
    );
  const traffic = providerTraffic(provider, pool.health?.providers ?? []);
  const problems = pool.attention.filter((item) => item.provider === provider.id);
  const paused = provider.oauth
    ? provider.files.length > 0 && provider.files.every((file) => file.disabled)
    : provider.resources.every((resource) => resource.disabled);
  const loginSupported =
    provider.oauth &&
    ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(provider.channel);
  const add = () => {
    if (loginSupported) setLogin(provider.channel);
    else if (provider.brand)
      setSheet({ open: true, brand: provider.brand, mode: 'create', resource: null });
  };
  const confirmDelete = (label: string, action: () => Promise<unknown>, configWrite = false) =>
    showConfirmation({
      title: t('shell.delete'),
      message: [
        t('shell.delete_confirm', { name: label }),
        configWrite ? t('shell.config_write_warning') : '',
      ]
        .filter(Boolean)
        .join(' '),
      variant: 'danger',
      confirmText: t('shell.delete'),
      onConfirm: () => pool.run(action),
    });
  const refreshQuota = (file: AuthFileItem) =>
    pool.run(async () => {
      const generation = captureQuotaCacheGeneration(file.name);
      const revision = apiClient.getConnectionRevision();
      if (provider.channel === 'codex') {
        const quota = await CODEX_CONFIG.fetchQuota(file, t);
        if (revision === apiClient.getConnectionRevision())
          commitIfQuotaCacheCurrent(generation, () =>
            useQuotaStore.getState().setCodexQuota((cache) => ({
              ...cache,
              [getQuotaCacheKey(file)]: CODEX_CONFIG.buildSuccessState(quota),
            }))
          );
      } else if (provider.channel === 'claude') {
        const quota = await CLAUDE_CONFIG.fetchQuota(file, t);
        if (revision === apiClient.getConnectionRevision())
          commitIfQuotaCacheCurrent(generation, () =>
            useQuotaStore.getState().setClaudeQuota((cache) => ({
              ...cache,
              [getQuotaCacheKey(file)]: CLAUDE_CONFIG.buildSuccessState(quota),
            }))
          );
      }
    }, false);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>
            <span
              className={styles.dot}
              data-status={
                paused
                  ? 'unknown'
                  : problems.length
                    ? 'warning'
                    : pool.loading || pool.errors.length
                      ? 'unknown'
                      : 'ok'
              }
            />
            {provider.name}
          </h1>
          <span>
            {t(
              paused
                ? 'shell.paused'
                : problems.length
                  ? 'shell.needs_review'
                  : pool.loading || pool.errors.length
                    ? 'shell.health_unknown'
                    : 'shell.active'
            )}
          </span>
        </div>
        <div className={styles.actions}>
          {loginSupported || provider.brand ? (
            <Button size="sm" onClick={add}>
              {t(provider.oauth ? 'shell.add_account' : 'shell.add_key')}
            </Button>
          ) : (
            <Link to="/auth-files">{t('shell.upload_account')}</Link>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={
              pool.busy || !pool.connected || (!provider.files.length && !provider.resources.length)
            }
            onClick={() =>
              confirmPoolChange(
                paused ? 'resume' : 'pause',
                provider.name,
                () =>
                  pool.run(async () => {
                    const revision = apiClient.getConnectionRevision();
                    for (const file of provider.files) await pool.setCredential(file, !paused);
                    for (const resource of provider.resources) {
                      if (revision !== apiClient.getConnectionRevision())
                        throw new DOMException('Connection changed', 'AbortError');
                      // Each write refreshes the v8 group snapshot used for conflict checks.
                      const latest = workspaceProviders(useConfigStore.getState().config, [])
                        .flatMap((entry) => entry.resources)
                        .find((entry) => entry.id === resource.id);
                      if (!latest) throw new Error(t('shell.provider_missing'));
                      await pool.workbench.toggleDisabled(latest, !paused);
                    }
                  }),
                !provider.oauth
              )
            }
          >
            {t(paused ? 'shell.resume' : 'shell.pause')}
          </Button>
        </div>
      </header>
      {pool.errors.length > 0 && (
        <p role="alert" className={styles.error}>
          {t('shell.load_failed', {
            sources: pool.errors.map((source) => t(`shell.${source}`)).join(', '),
          })}
        </p>
      )}
      <div className={styles.stats}>
        <div>
          <strong>{traffic?.requests.toLocaleString() ?? t('shell.unknown')}</strong>
          <span>{t('shell.requests_24h')}</span>
        </div>
        <div>
          <strong>
            {traffic
              ? `${traffic.requests ? Math.round((traffic.failures / traffic.requests) * 100) : 0}%`
              : t('shell.unknown')}
          </strong>
          <span>{t('shell.failed')}</span>
        </div>
        <div>
          <strong>
            {traffic?.p50 != null ? `${(traffic.p50 / 1000).toFixed(1)} s` : t('shell.unknown')}
          </strong>
          <span>{t('shell.p50_latency')}</span>
        </div>
        <Link
          to={
            provider.resources[0]?.models[0]
              ? `/sessions?model=${encodeURIComponent(provider.resources[0].models[0])}`
              : '/sessions'
          }
        >
          {t('shell.sessions')}
        </Link>
      </div>
      {!provider.oauth && (
        <section className={styles.section}>
          <h2>{t('shell.quota')}</h2>
          <QuotaMeters windows={pool.quotaForProvider(provider)} now={pool.now} />
          {!pool.quotaForProvider(provider).length && <p>{t('shell.quota_unknown')}</p>}
        </section>
      )}
      {problems.length > 0 && (
        <section className={styles.section}>
          <h2>{t('shell.problems')}</h2>
          <ProblemRows items={problems} onLogin={setLogin} />
        </section>
      )}
      <section className={styles.section}>
        <h2>{t(provider.oauth ? 'shell.accounts' : 'shell.keys')}</h2>
        {!provider.files.length && !provider.resources.length && <p>{t('shell.no_accounts')}</p>}
        {provider.files.map((file) => {
          const windows = pool.quotaForFile(file);
          const cooldown =
            file.cooldownSnapshot && summarizeCooldowns(file.cooldownSnapshot, pool.now);
          return (
            <div className={styles.account} key={credentialId(file)}>
              <div className={styles.accountHead}>
                <strong>{credentialLabel(file)}</strong>
                <span>
                  {t(
                    file.disabled
                      ? 'shell.disabled'
                      : file.unavailable || file.status === 'error'
                        ? 'shell.needs_review'
                        : 'shell.active'
                  )}
                </span>
                <div className={styles.actions}>
                  {loginSupported && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        confirmAccountLogin(credentialLabel(file), () => setLogin(provider.channel))
                      }
                    >
                      {t('shell.relogin')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pool.busy}
                    onClick={() =>
                      confirmPoolChange(
                        file.disabled ? 'enable' : 'disable',
                        credentialLabel(file),
                        () => pool.run(() => pool.setCredential(file, !file.disabled))
                      )
                    }
                  >
                    {t(file.disabled ? 'shell.enable' : 'shell.disable')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDetails(file)}>
                    {t('shell.details')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pool.busy}
                    onClick={() =>
                      confirmDelete(credentialLabel(file), async () => {
                        const result = await authFilesApi.deleteFile(file.name);
                        if (result.failed.length) throw new Error(result.failed[0].error);
                        useQuotaStore.getState().clearQuotaCache([file.name]);
                        notifyAuthFilesChanged();
                      })
                    }
                  >
                    {t('shell.delete')}
                  </Button>
                </div>
              </div>
              <QuotaMeters windows={windows} now={pool.now} />
              {!windows.length && <span>{t('shell.quota_unknown')}</span>}
              {cooldown?.rows
                .filter((row) => row.remainingSeconds > 0)
                .map((row, index) => (
                  <p key={index} className={styles.cooldown}>
                    {t(cooldownReasonKey(row.record.reason))} · {row.record.modelKey} ·{' '}
                    {t('shell.cooldown_seconds', { count: row.remainingSeconds })}
                  </p>
                ))}
              {['codex', 'claude'].includes(provider.channel) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pool.busy || file.disabled}
                  onClick={() => void refreshQuota(file)}
                >
                  {t('shell.refresh_quota')}
                </Button>
              )}
            </div>
          );
        })}
        {provider.resources.map((resource) => {
          const keys =
            resource.brand === 'openaiCompatibility'
              ? ((resource.raw as OpenAIProviderConfig).apiKeyEntries ?? [])
              : [{ apiKey: resource.apiKey || '' }];
          return (
            <div className={styles.account} key={resource.id}>
              <div className={styles.accountHead}>
                <strong>{resource.name || provider.name}</strong>
                <span>{t(resource.disabled ? 'shell.paused' : 'shell.active')}</span>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setSheet({ open: true, mode: 'edit', brand: resource.brand, resource })
                    }
                  >
                    {t('shell.replace')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pool.busy}
                    onClick={() =>
                      confirmPoolChange(
                        resource.disabled ? 'enable' : 'disable',
                        resource.name || provider.name,
                        () =>
                          pool.run(() =>
                            pool.workbench.toggleDisabled(resource, !resource.disabled)
                          ),
                        true
                      )
                    }
                  >
                    {t(resource.disabled ? 'shell.enable' : 'shell.disable')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setSheet({ open: true, mode: 'detail', brand: resource.brand, resource })
                    }
                  >
                    {t('shell.details')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pool.busy}
                    onClick={() =>
                      confirmDelete(
                        resource.name || provider.name,
                        () => pool.workbench.deleteProvider(resource),
                        true
                      )
                    }
                  >
                    {t('shell.remove')}
                  </Button>
                </div>
              </div>
              {keys.map((key, index) => (
                <div className={styles.keyRow} key={index}>
                  <code>{maskApiKey(key.apiKey)}</code>
                  {resource.brand === 'openaiCompatibility' && (
                    <div className={styles.actions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSheet({ open: true, mode: 'edit', brand: resource.brand, resource })
                        }
                      >
                        {t('shell.replace')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pool.busy}
                        onClick={() =>
                          confirmDelete(
                            maskApiKey(key.apiKey),
                            async () => {
                              const raw = resource.raw as OpenAIProviderConfig;
                              await providersApi.updateOpenAIProvider(
                                raw.name,
                                resource.originalIndex,
                                {
                                  ...raw,
                                  apiKeyEntries: raw.apiKeyEntries?.filter(
                                    (_, entryIndex) => entryIndex !== index
                                  ),
                                }
                              );
                              await pool.workbench.refetch();
                            },
                            true
                          )
                        }
                      >
                        {t('shell.remove')}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>{t('shell.models')}</h2>
          <div className={styles.actions}>
            {provider.oauth ? (
              <>
                <Link
                  className={styles.action}
                  to={`/auth-files/oauth-model-alias?provider=${encodeURIComponent(provider.channel)}`}
                >
                  {t('shell.edit_aliases')}
                </Link>
                <Link
                  className={styles.action}
                  to={`/auth-files/oauth-excluded?provider=${encodeURIComponent(provider.channel)}`}
                >
                  {t('shell.edit_excluded')}
                </Link>
              </>
            ) : (
              provider.resources[0] && (
                <Button
                  size="sm"
                  onClick={() =>
                    setSheet({
                      open: true,
                      mode: 'edit',
                      brand: provider.resources[0].brand,
                      resource: provider.resources[0],
                    })
                  }
                >
                  {t('shell.edit_models')}
                </Button>
              )
            )}
          </div>
        </div>
        {modelsError && (
          <p role="alert" className={styles.error}>
            {t('shell.models_unavailable')}
          </p>
        )}
        <div className={styles.modelColumns}>
          <div>
            <h3>{t('shell.exposed')}</h3>
            {[
              ...new Set(
                provider.oauth ? models : provider.resources.flatMap((resource) => resource.models)
              ),
            ].map((model) => (
              <div className={styles.modelRow} key={model}>
                {model}
              </div>
            ))}
          </div>
          <div>
            <h3>{t('shell.aliases')}</h3>
            {(provider.oauth
              ? aliases
              : provider.resources.flatMap(
                  (resource) => (resource.raw as ProviderKeyConfig).models ?? []
                )
            )
              .filter((alias) => alias.alias)
              .map((alias, index) => (
                <div className={styles.modelRow} key={index}>
                  {alias.alias} → {alias.name}
                </div>
              ))}
          </div>
          <div>
            <h3>{t('shell.excluded')}</h3>
            {[
              ...new Set(
                provider.oauth
                  ? excluded
                  : provider.resources
                      .flatMap(
                        (resource) => (resource.raw as ProviderKeyConfig).excludedModels ?? []
                      )
                      .filter((model) => model !== '*')
              ),
            ].map((model) => (
              <div className={styles.modelRow} key={model}>
                {model}
              </div>
            ))}
          </div>
        </div>
      </section>
      {details && (
        <Modal open title={credentialLabel(details)} onClose={() => setDetails(null)}>
          <dl className={styles.details}>
            <dt>{t('shell.status')}</dt>
            <dd>{details.status}</dd>
            <dt>{t('shell.auth_index')}</dt>
            <dd>{String(details.authIndex ?? '')}</dd>
            <dt>{t('shell.last_refresh')}</dt>
            <dd>
              {details.lastRefresh
                ? new Date(details.lastRefresh).toLocaleString()
                : t('shell.unknown')}
            </dd>
          </dl>
          <Link to="/auth-files">{t('shell.advanced_credentials')}</Link>
        </Modal>
      )}
      {sheet.open && (
        <ProviderSheet
          state={sheet}
          workbench={pool.workbench}
          mutationDisabled={pool.busy || !pool.connected}
          onClose={() => setSheet((state) => ({ ...state, open: false }))}
          onSwitchToEdit={() => setSheet((state) => ({ ...state, mode: 'edit' }))}
          onCreated={() => {
            setSheet((state) => ({ ...state, open: false }));
            void pool.refresh();
          }}
          onUpdated={() => {
            setSheet((state) => ({ ...state, open: false }));
            void pool.refresh();
          }}
        />
      )}
      {login && <OAuthDialog key={login} provider={login} onClose={() => setLogin(null)} />}
    </div>
  );
}
