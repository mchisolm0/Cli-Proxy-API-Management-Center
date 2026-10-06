import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { Attention } from '@/features/home/attention';
import { formatReset } from '@/features/shell/format';
import { usePool } from './PoolContext';
import { credentialLabel, providerPath } from './model';
import { windowLabel } from './quotaSignals';
import styles from './Workspace.module.scss';
import { confirmAccountLogin, confirmPoolChange } from './actions';

/** One line per alert: what happened, then the action that fixes it. */
export function ProblemRows({
  items,
  onLogin,
  showProvider = true,
}: {
  items: Attention[];
  onLogin: (provider: string) => void;
  showProvider?: boolean;
}) {
  const { t } = useTranslation();
  const pool = usePool();
  return (
    <div className={styles.alerts}>
      {items.map((item) => {
        const provider = pool.providers.find(
          (entry) => entry.id === item.provider || entry.channels.includes(item.provider)
        );
        const name = provider?.name || item.provider || t('shell.proxy');
        const login =
          provider?.oauth &&
          ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(
            provider.channel
          );
        const account =
          item.file && provider && provider.files.length > 1 ? credentialLabel(item.file) : '';
        const session = item.problem?.sessions[0];
        return (
          <div key={item.id} className={styles.alert} data-category={item.category}>
            <p>
              {showProvider && <strong>{name}</strong>}
              {account && <span className={styles.alertAccount}>{account}</span>}
              <span>
                {item.reason === 'quota_high' && item.window
                  ? t('shell.attention_quota_high', {
                      window: windowLabel(t, item.window).toLowerCase(),
                      percent: Math.round(item.window.usedPercent ?? 0),
                      when: item.window.resetAtMs
                        ? formatReset(item.window.resetAtMs, pool.now)
                        : t('shell.reset_unknown').toLowerCase(),
                    })
                  : t(`shell.attention_${item.reason}`, {
                      provider: name,
                      count: item.count ?? 0,
                      model: item.problem?.model || t('shell.unknown').toLowerCase(),
                      code: item.problem?.code || '',
                    })}
              </span>
            </p>
            <div className={styles.actions}>
              {item.category === 'auth' && login && !item.file?.runtimeOnly ? (
                <Button
                  size="sm"
                  onClick={() =>
                    confirmAccountLogin(item.file ? credentialLabel(item.file) : name, () =>
                      onLogin(provider.channel)
                    )
                  }
                >
                  {t('shell.relogin')}
                </Button>
              ) : (
                showProvider &&
                provider && (
                  <Link className={styles.action} to={providerPath(provider.id)}>
                    {t('shell.open_provider_named', { name })}
                  </Link>
                )
              )}
              {item.file &&
                item.reason !== 'quota_high' &&
                !item.file.disabled &&
                !item.file.runtimeOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pool.busy}
                    onClick={() =>
                      confirmPoolChange('disable', credentialLabel(item.file!), () =>
                        pool.run(() => pool.setCredential(item.file!, true))
                      )
                    }
                  >
                    {t('shell.disable')}
                  </Button>
                )}
              {item.problem && (
                <Link
                  className={styles.quiet}
                  to={session ? `/sessions?id=${session.id}` : '/problems'}
                >
                  {t(session ? 'shell.example_session' : 'shell.details')}
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
