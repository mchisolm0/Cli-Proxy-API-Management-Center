import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { oauthApi, type OAuthStartResponse } from '@/services/api/oauth';
import { apiClient } from '@/services/api/client';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { providerLabel } from '@/features/dashboard/utils';
import { useQuotaStore } from '@/stores';
import { useLogin, type Login } from './loginStore';
import styles from './Workspace.module.scss';

/**
 * Inline sign-in above the current page. Uses the same start/status/callback/cancel
 * endpoints as the upstream OAuth page; leaving it cancels an unfinished session.
 */
export function LoginPanel({ login }: { login: Login }) {
  const { t } = useTranslation();
  const { start: restart, close } = useLogin();
  const { channel, account } = login;
  const name = providerLabel(channel, channel);
  const [flow, setFlow] = useState<OAuthStartResponse | null>(null);
  const [status, setStatus] = useState('starting');
  const [error, setError] = useState('');
  const [callback, setCallback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const revision = useRef(apiClient.getConnectionRevision());
  const controller = useRef<AbortController | null>(null);
  const state = useRef<string | undefined>(undefined);
  const complete = useRef(false);

  useEffect(() => {
    const connectionRevision = revision.current;
    let active = true;
    const abort = new AbortController();
    controller.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && connectionRevision === apiClient.getConnectionRevision();
    const start = async () => {
      try {
        const response = await oauthApi.startAuth(channel, abort.signal);
        if (!current()) return;
        state.current = response.state;
        setFlow(response);
        if (!response.state) throw new Error(t('shell.oauth_missing_state'));
        setStatus('waiting');
        const deadline = Date.now() + (response.expires_in || 600) * 1000;
        const poll = async () => {
          if (!current()) return;
          try {
            if (Date.now() > deadline) throw new Error(t('shell.oauth_expired'));
            const result = await oauthApi.getAuthStatus(response.state!, abort.signal);
            if (!current()) return;
            if (result.status === 'ok') {
              complete.current = true;
              setStatus('done');
              useQuotaStore.getState().clearQuotaCache();
              notifyAuthFilesChanged();
            } else if (result.status === 'error') {
              throw new Error(result.error || t('shell.save_failed'));
            } else timer = setTimeout(poll, 1800);
          } catch (cause) {
            if (current()) {
              setError(cause instanceof Error ? cause.message : t('shell.save_failed'));
              setStatus('error');
            }
          }
        };
        void poll();
      } catch (cause) {
        if (current()) {
          setError(cause instanceof Error ? cause.message : t('shell.save_failed'));
          setStatus('error');
        }
      }
    };
    void start();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
      if (
        state.current &&
        !complete.current &&
        connectionRevision === apiClient.getConnectionRevision()
      ) {
        void oauthApi.cancelSession(state.current).catch(() => {});
      }
    };
  }, [channel, t]);

  return (
    <section className={styles.login} data-status={status} aria-live="polite">
      <div className={styles.loginHead}>
        <strong>
          {account
            ? t('shell.relogin_named', { provider: name, account })
            : t('shell.add_named_account', { provider: name })}
        </strong>
        <div className={styles.actions}>
          {status === 'error' && (
            <Button size="sm" onClick={() => restart(channel, account)}>
              {t('shell.try_again')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={close}>
            {t(status === 'done' ? 'common.close' : 'common.cancel')}
          </Button>
        </div>
      </div>
      {account && status !== 'done' && <p>{t('shell.relogin_confirm', { name: account })}</p>}
      <p role="status">{t(`shell.oauth_${status}`)}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {flow && status === 'waiting' && (
        <div className={styles.loginFlow}>
          <a className={styles.action} href={flow.url} target="_blank" rel="noreferrer">
            {t('shell.open_signin')}
          </a>
          {flow.user_code && <code className={styles.deviceCode}>{flow.user_code}</code>}
        </div>
      )}
      {/* Device-code flows finish on the provider's site; only redirect flows need a callback. */}
      {flow && status === 'waiting' && !flow.user_code && (
        <details>
          <summary>{t('shell.callback_url')}</summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (revision.current !== apiClient.getConnectionRevision()) return;
              setSubmitting(true);
              setError('');
              try {
                await oauthApi.submitCallback(channel, callback, controller.current?.signal);
              } catch (cause) {
                if (!controller.current?.signal.aborted)
                  setError(cause instanceof Error ? cause.message : t('shell.save_failed'));
              } finally {
                if (!controller.current?.signal.aborted) setSubmitting(false);
              }
            }}
          >
            <input
              aria-label={t('shell.callback_url')}
              type="url"
              required
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={submitting}>
              {t('shell.submit_callback')}
            </Button>
          </form>
        </details>
      )}
    </section>
  );
}
