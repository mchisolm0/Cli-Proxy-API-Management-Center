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
  providerTraffic,
  workspaceChannel,
  workspaceProviders,
  type WorkspaceProvider,
} from './model';
import { headlineQuota, windowLabel, type QuotaWindow } from './quotaSignals';
import { QuotaBar } from './QuotaBar';
import { ProviderTable } from './ProviderTable';
import { providerPaused, providerStatus } from './status';
import { SessionRows } from '@/features/shell/SessionRows';
import { formatCount, formatSeconds } from '@/features/shell/format';
import { ProblemRows } from './ProblemRows';
import { OAuthDialog } from './OAuthDialog';
import { confirmAccountLogin, confirmPoolChange } from './actions';
import styles from './Workspace.module.scss';

function lastReadings(windows: QuotaWindow[], now: number): QuotaWindow[] {
  const byPeriod = new Map<string, QuotaWindow>();
  for (const window of windows) {
    if (window.model || (window.resetAtMs !== null && window.resetAtMs <= now)) continue;
    const key = window.periodHours === null ? window.label : String(window.periodHours);
    const previous = byPeriod.get(key);
    if (!previous || (window.observedAt ?? 0) > (previous.observedAt ?? 0))
      byPeriod.set(key, window);
  }
  return [...byPeriod.values()];
}

/** Headline 5 hour / weekly bars; per-model windows stay one click away. */
function QuotaMeters({ windows, now }: { windows: QuotaWindow[]; now: number }) {
  const { t } = useTranslation();
  const current = headlineQuota(windows, now);
  // With nothing current, show the newest pre-reset reading per period, marked stale.
  // Windows past their reset have refilled, so their old readings would mislead.
  const headline = current.length ? current : lastReadings(windows, now);
  const perModel = windows.filter((window) => window.model);
  if (!headline.length && !perModel.length)
    return <p className={styles.muted}>{t('shell.quota_unknown')}</p>;
  return (
    <div className={styles.meters}>
      {headline.map((window, index) => (
        <QuotaBar key={`${window.id}:${index}`} window={window} now={now} />
      ))}
      {perModel.length > 0 && (
        <details className={styles.perModel}>
          <summary>{t('shell.per_model', { count: perModel.length })}</summary>
          {perModel.map((window, index) => (
            <QuotaBar
              key={`${window.id}:${index}`}
              window={window}
              now={now}
              label={`${window.model} · ${windowLabel(t, window, true)}`}
            />
          ))}
        </details>
      )}
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
        <div className={styles.actions}>
          <Link className={styles.quiet} to="/auth-files">
            {t('shell.upload_account')}
          </Link>
          <Link className={styles.action} to="/ai-providers">
            {t('shell.add_provider')}
          </Link>
        </div>
      </header>
      <ProviderTable known={pool.known} />
    </div>
  );
}

/** The OpenAI-compatible block of a provider merged from several blocks. */
function sharedResource(provider: WorkspaceProvider) {
  return provider.resources.length > 1
    ? provider.resources.find((resource) => resource.brand === 'openaiCompatibility')
    : undefined;
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
  const enabledAccounts = (provider?.files ?? [])
    .filter((file) => !file.disabled)
    .map((file) => file.name)
    .join('|');

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
    // Polling replaces the files array every minute; refetch only when the account set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.oauth, provider?.channel, enabledAccounts]);

  useEffect(() => {
    if (!provider || loadedAction.current) return;
    if ((params.get('edit') === 'models' || params.get('add') === '1') && provider.brand) {
      loadedAction.current = true;
      const resource = sharedResource(provider) ?? provider.resources[0] ?? null;
      setSheet(
        params.get('add') === '1' && !sharedResource(provider)
          ? { open: true, mode: 'create', brand: provider.brand, resource: null }
          : resource
            ? { open: true, mode: 'edit', brand: resource.brand, resource }
            : { open: true, mode: 'create', brand: provider.brand, resource: null }
      );
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
  // No matching traffic in a loaded health window means an idle provider, not an unknown one.
  const traffic =
    providerTraffic(provider, pool.health?.providers ?? []) ??
    (pool.health ? { requests: 0, failures: 0, tokens: 0, p50: null, ttft: null } : null);
  // Low quota already shows on the account's bars; alerts here are things to fix.
  const problems = pool.attention.filter(
    (item) => item.provider === provider.id && item.reason !== 'quota_high'
  );
  const paused = providerPaused(provider);
  const status = providerStatus(provider, pool.attention, pool.known);
  const exposed = new Set(
    provider.oauth ? models : provider.resources.flatMap((resource) => resource.models)
  );
  const recent = (pool.recent?.sessions ?? [])
    .filter(
      (session) =>
        (session.provider && provider.channels.includes(workspaceChannel(session.provider))) ||
        exposed.has(session.model)
    )
    .slice(0, 5);
  const loginSupported =
    provider.oauth &&
    ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(provider.channel);
  const shared = sharedResource(provider);
  const add = () => {
    if (loginSupported) setLogin(provider.channel);
    // A merged endpoint gets its new key in the OpenAI-compatible block's key list.
    else if (shared) setSheet({ open: true, brand: shared.brand, mode: 'edit', resource: shared });
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
            <span className={styles.dot} data-status={status} />
            {provider.name}
          </h1>
          <span>
            {t(
              {
                paused: 'shell.paused',
                error: 'shell.needs_review',
                warning: 'shell.quota_low',
                ok: 'shell.active',
                unknown: 'shell.health_unknown',
              }[status]
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
      <div className={styles.overviewStats}>
        {(
          [
            [traffic ? formatCount(traffic.requests) : '?', t('shell.requests_24h')],
            [
              traffic
                ? `${traffic.requests ? Math.round((traffic.failures / traffic.requests) * 100) : 0}%`
                : '?',
              t('shell.failed'),
            ],
            [formatSeconds(traffic?.p50 ?? null) ?? t('shell.none'), t('shell.p50_latency')],
            [formatSeconds(traffic?.ttft ?? null) ?? t('shell.none'), t('shell.first_token')],
            [traffic ? formatCount(traffic.tokens) : '?', t('shell.tokens')],
          ] as const
        ).map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {problems.length > 0 && (
        <section className={styles.section}>
          <ProblemRows items={problems} onLogin={setLogin} showProvider={false} />
        </section>
      )}
      {!provider.oauth && pool.quotaForProvider(provider).length > 0 && (
        <section className={styles.section}>
          <h2>{t('shell.quota')}</h2>
          <QuotaMeters windows={pool.quotaForProvider(provider)} now={pool.now} />
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
              {cooldown?.rows
                .filter((row) => row.remainingSeconds > 0)
                .map((row, index) => (
                  <p key={index} className={styles.cooldown}>
                    {t(cooldownReasonKey(row.record.reason))} · {row.record.modelKey} ·{' '}
                    {t('shell.cooldown_seconds', { count: row.remainingSeconds })}
                  </p>
                ))}
              {['codex', 'claude'].includes(provider.channel) && (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={pool.busy || file.disabled}
                  onClick={() => void refreshQuota(file)}
                >
                  {t('shell.refresh_quota')}
                </button>
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
                    {t('shell.edit')}
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
              // Several blocks: each block's Edit opens its own models.
              provider.resources.length === 1 && (
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
            <div className={styles.exposedList}>
              {[...exposed].map((model) => (
                <div className={styles.modelRow} key={model}>
                  {model}
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3>{t('shell.aliases')}</h3>
            {(provider.oauth
              ? aliases
              : provider.resources.flatMap(
                  (resource) => (resource.raw as ProviderKeyConfig).models ?? []
                )
            )
              // An alias equal to its model name changes nothing; repeated blocks repeat it.
              .filter(
                (alias, index, all) =>
                  alias.alias &&
                  alias.alias !== alias.name &&
                  all.findIndex(
                    (other) => other.alias === alias.alias && other.name === alias.name
                  ) === index
              )
              .map((alias) => (
                <div className={styles.modelRow} key={`${alias.alias}:${alias.name}`}>
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
      {recent.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>{t('shell.recent_sessions')}</h2>
            <Link className={styles.quiet} to="/sessions">
              {t('shell.all_sessions')}
            </Link>
          </div>
          <SessionRows sessions={recent} now={pool.now} />
        </section>
      )}
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
