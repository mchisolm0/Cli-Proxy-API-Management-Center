import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatCount, formatSeconds } from '@/features/shell/format';
import { usePool } from './PoolContext';
import { providerPath, providerTraffic } from './model';
import { headlineQuota } from './quotaSignals';
import { providerStatus } from './status';
import { QuotaBar } from './QuotaBar';
import styles from './Workspace.module.scss';

/** Every provider on one row: status, quota windows and 24 hour traffic. */
export function ProviderTable({ known }: { known: boolean }) {
  const { t } = useTranslation();
  const pool = usePool();
  return (
    <div className={styles.providerTable}>
      {pool.providers.map((provider) => {
        const windows = headlineQuota(pool.quotaForProvider(provider), pool.now);
        // A loaded health window without matching traffic means idle, not unknown.
        const usage =
          providerTraffic(provider, pool.health?.providers ?? []) ??
          (pool.health ? { requests: 0, failures: 0, p50: null } : null);
        return (
          <Link key={provider.id} to={providerPath(provider.id)}>
            <span className={styles.providerName}>
              <span
                className={styles.dot}
                data-status={providerStatus(provider, pool.attention, known)}
              />
              {provider.name}
            </span>
            <span className={styles.providerQuota}>
              {windows.length ? (
                windows
                  .slice(0, 2)
                  .map((window) => (
                    <QuotaBar key={window.id} window={window} now={pool.now} compact />
                  ))
              ) : (
                <span className={styles.muted}>{t('shell.quota_not_reported')}</span>
              )}
            </span>
            <span className={styles.figure}>
              {usage ? formatCount(usage.requests) : '?'}
              <small>{t('shell.req_24h')}</small>
            </span>
            <span className={styles.figure}>
              {usage && usage.requests
                ? `${Math.round((usage.failures / usage.requests) * 100)}%`
                : '0%'}
              <small>{t('shell.failed')}</small>
            </span>
            <span className={styles.figure}>
              {formatSeconds(usage?.p50 ?? null) ?? t(usage ? 'shell.none' : 'shell.unknown')}
              <small>{t('shell.p50')}</small>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
