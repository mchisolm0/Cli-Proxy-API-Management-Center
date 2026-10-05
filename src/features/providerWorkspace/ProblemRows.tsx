import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { Attention } from '@/features/home/attention';
import { usePool } from './PoolContext';
import { credentialLabel, providerPath } from './model';
import styles from './Workspace.module.scss';
import { confirmAccountLogin, confirmPoolChange } from './actions';

export function ProblemRows({
  items,
  onLogin,
}: {
  items: Attention[];
  onLogin: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const pool = usePool();
  return (
    <div className={styles.problemList}>
      {items.map((item) => {
        const provider = pool.providers.find(
          (entry) => entry.id === item.provider || entry.channel === item.provider
        );
        const name = provider?.name || item.provider || t('shell.proxy');
        const login =
          provider?.oauth &&
          ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(
            provider.channel
          );
        const alias =
          item.category === 'client' &&
          /model|alias|not_found|404/i.test(`${item.problem?.code} ${item.problem?.fix}`);
        const destination =
          alias && provider?.oauth
            ? `/auth-files/oauth-model-alias?provider=${encodeURIComponent(provider.channel)}`
            : provider
              ? `${providerPath(provider.id)}${alias ? '?edit=models' : ''}`
              : '/config';
        return (
          <div key={item.id} className={styles.problem} data-category={item.category}>
            <div>
              <strong>{item.file ? credentialLabel(item.file, provider) : name}</strong>
              <p>
                {t(`shell.attention_${item.reason}`, {
                  provider: name,
                  count: item.count ?? 0,
                  model: item.problem?.model || '',
                  code: item.problem?.code || '',
                })}
              </p>
              <span className={styles.failureClass}>{t(`shell.class_${item.category}`)}</span>
            </div>
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
                <Link className={styles.action} to={destination}>
                  {t(alias ? 'shell.add_alias' : 'shell.open_provider')}
                </Link>
              )}
              {item.file && !item.file.disabled && !item.file.runtimeOnly && (
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
                  to={
                    item.problem.sessions[0]
                      ? `/sessions?id=${item.problem.sessions[0].id}`
                      : '/problems'
                  }
                >
                  {t('shell.sessions')}
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
