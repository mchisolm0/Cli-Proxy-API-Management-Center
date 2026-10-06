import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useDashboardOverview } from '@/features/dashboard/hooks/useDashboardOverview';
import { ThroughputChart } from '@/features/dashboard/components/ThroughputChart';
import { usePool } from '@/features/providerWorkspace/PoolContext';
import { ProviderTable } from '@/features/providerWorkspace/ProviderTable';
import { ProblemRows } from '@/features/providerWorkspace/ProblemRows';
import { OAuthDialog } from '@/features/providerWorkspace/OAuthDialog';
import { SessionRows } from '@/features/shell/SessionRows';
import { formatCount, formatDuration } from '@/features/shell/format';
import styles from '@/features/providerWorkspace/Workspace.module.scss';

/** Home: alerts only when something needs the user, then live traffic, providers and recent work. */
export function HomePage() {
  const { t } = useTranslation();
  const pool = usePool();
  const overview = useDashboardOverview();
  useHeaderRefresh(overview.refresh, overview.connected);
  const version = useAuthStore((state) => state.serverVersion);
  const [login, setLogin] = useState<string | null>(null);
  const { traffic, counts, credentials } = overview;
  const known = !pool.loading && !pool.errors.includes('credentials');
  const stats: [string, string][] = [
    [
      formatCount(traffic.total),
      t('shell.stat_requests', {
        window: traffic.windowMinutes ? formatDuration(traffic.windowMinutes * 60_000) : '3h',
      }),
    ],
    [
      traffic.successRate === null ? '?' : `${Math.round(traffic.successRate * 10) / 10}%`,
      t('shell.stat_success'),
    ],
    [formatCount(traffic.totalFailure), t('shell.stat_failures')],
    [credentials ? `${credentials.active}/${credentials.total}` : '?', t('shell.stat_accounts')],
    [counts.providerKeys === null ? '?' : String(counts.providerKeys), t('shell.stat_keys')],
    [counts.models === null ? '?' : String(counts.models), t('shell.stat_models')],
    [pool.recent ? formatCount(pool.recent.total) : '?', t('shell.stat_sessions')],
  ];
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('shell.overview')}</h1>
        {version && <span className={styles.headerMeta}>CLIProxyAPI {version}</span>}
      </header>
      {pool.errors.length > 0 && (
        <p className={styles.error} role="alert">
          {t('shell.load_failed', {
            sources: pool.errors.map((source) => t(`shell.${source}`)).join(', '),
          })}
        </p>
      )}
      <section aria-label={t('shell.alerts')}>
        {pool.attention.length > 0 ? (
          <ProblemRows items={pool.attention.slice(0, 5)} onLogin={setLogin} />
        ) : (
          <p className={styles.allClear}>
            <span className={styles.dot} data-status={known ? 'ok' : 'unknown'} />
            {t(pool.loading ? 'shell.loading' : known ? 'shell.all_clear' : 'shell.health_unknown')}
          </p>
        )}
        {pool.attention.length > 5 && (
          <Link className={styles.quiet} to="/problems">
            {t('shell.all_problems')}
          </Link>
        )}
      </section>
      <section className={styles.overviewStats} aria-label={t('shell.traffic')}>
        {stats.map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>{t('shell.throughput')}</h2>
          <span className={styles.headerMeta}>{t('shell.bucket_note')}</span>
        </div>
        <ThroughputChart traffic={traffic} />
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>{t('shell.providers')}</h2>
          <Link className={styles.quiet} to="/providers">
            {t('shell.manage')}
          </Link>
        </div>
        <ProviderTable known={known} />
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>{t('shell.recent_sessions')}</h2>
          <Link className={styles.quiet} to="/sessions">
            {t('shell.all_sessions')}
          </Link>
        </div>
        <SessionRows sessions={pool.recent?.sessions.slice(0, 6) ?? []} now={pool.now} />
        {!pool.loading && pool.recent?.sessions.length === 0 && <p>{t('shell.no_sessions')}</p>}
      </section>
      {login && <OAuthDialog key={login} provider={login} onClose={() => setLogin(null)} />}
    </div>
  );
}
