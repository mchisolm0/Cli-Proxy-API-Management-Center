import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores';
import { usePool } from '@/features/providerWorkspace/PoolContext';
import { providerPath } from '@/features/providerWorkspace/model';
import { tightestQuota } from '@/features/providerWorkspace/quotaSignals';
import { ProblemRows } from '@/features/providerWorkspace/ProblemRows';
import { OAuthDialog } from '@/features/providerWorkspace/OAuthDialog';
import styles from '@/features/providerWorkspace/Workspace.module.scss';

export function HomePage() {
  const { t } = useTranslation();
  const pool = usePool();
  const version = useAuthStore((state) => state.serverVersion);
  const [login, setLogin] = useState<string | null>(null);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('shell.home')}</h1>
        <button
          type="button"
          className={styles.action}
          onClick={() => void pool.refresh()}
          disabled={pool.loading}
        >
          {t('shell.refresh')}
        </button>
      </header>
      {pool.errors.length > 0 && (
        <p className={styles.error} role="alert">
          {t('shell.load_failed', {
            sources: pool.errors.map((source) => t(`shell.${source}`)).join(', '),
          })}
        </p>
      )}
      <h2 className={styles.attentionHeading}>
        {pool.loading
          ? t('shell.loading')
          : pool.attention.length
            ? t('shell.needs_attention', { count: pool.attention.length })
            : pool.errors.length
              ? t('shell.health_unknown')
              : t('shell.all_clear')}
      </h2>
      <ProblemRows items={pool.attention.slice(0, 6)} onLogin={setLogin} />
      {pool.attention.length > 6 && (
        <Link className={styles.action} to="/problems">
          {t('shell.all_problems')}
        </Link>
      )}
      <section className={styles.fine} aria-label={t('shell.provider_status')}>
        {pool.providers.map((provider) => {
          const quota = tightestQuota(pool.quotaForProvider(provider), pool.now);
          const affected = pool.attention.some((item) => item.provider === provider.id);
          return (
            <Link to={providerPath(provider.id)} key={provider.id}>
              <strong>
                <span
                  className={styles.dot}
                  data-status={
                    affected
                      ? 'warning'
                      : pool.loading ||
                          pool.errors.includes('credentials') ||
                          pool.errors.includes('health')
                        ? 'unknown'
                        : 'ok'
                  }
                />
                {provider.name}
              </strong>
              <span>
                {quota
                  ? t('shell.quota_used', {
                      percent: Math.round(quota.usedPercent ?? 0),
                      window:
                        quota.periodHours === 5
                          ? t('shell.five_hour')
                          : quota.periodHours === 168
                            ? t('shell.weekly')
                            : quota.label,
                    })
                  : t(affected ? 'shell.needs_review' : 'shell.quota_unknown')}
              </span>
            </Link>
          );
        })}
        <div>
          <strong>{t('shell.proxy')}</strong>
          <span>{version || t('shell.version_unknown')}</span>
        </div>
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2>{t('shell.continue')}</h2>
          <Link to="/sessions">{t('shell.all_sessions')}</Link>
        </div>
        {pool.recent?.sessions.slice(0, 6).map((session) => (
          <Link key={session.id} to={`/sessions?id=${session.id}`} className={styles.session}>
            <div>
              <strong>{session.title || t('shell.untitled_session')}</strong>
              <span>
                {[session.repo || session.cwd, session.branch].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span>{[session.client, session.model].filter(Boolean).join(' · ')}</span>
            <span>{session.host}</span>
            <time dateTime={new Date(session.updated).toISOString()}>
              {new Date(session.updated).toLocaleDateString()}
            </time>
          </Link>
        ))}
        {!pool.loading && pool.recent?.sessions.length === 0 && <p>{t('shell.no_sessions')}</p>}
      </section>
      {login && <OAuthDialog key={login} provider={login} onClose={() => setLogin(null)} />}
    </div>
  );
}
