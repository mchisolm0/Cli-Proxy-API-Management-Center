import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { oauthApi, type OAuthStartResponse } from '@/services/api/oauth';
import { apiClient } from '@/services/api/client';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { useQuotaStore } from '@/stores';
import styles from './Workspace.module.scss';

/** Uses the same start/status/callback/cancel endpoints as the upstream OAuth page. */
export function OAuthDialog({ provider, onClose }: { provider: string; onClose: () => void }) {
  const { t } = useTranslation();
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
        const response = await oauthApi.startAuth(provider, abort.signal);
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
  }, [provider, t]);

  return (
    <Modal open title={t('shell.relogin_provider', { provider })} onClose={onClose}>
      <div className={styles.oauth}>
        <p role="status">{t(`shell.oauth_${status}`)}</p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {flow && status === 'waiting' && (
          <>
            <a className={styles.action} href={flow.url} target="_blank" rel="noreferrer">
              {t('shell.open_signin')}
            </a>
            {flow.user_code && <p>{t('shell.device_code', { code: flow.user_code })}</p>}
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (revision.current !== apiClient.getConnectionRevision()) return;
                setSubmitting(true);
                setError('');
                try {
                  await oauthApi.submitCallback(provider, callback, controller.current?.signal);
                } catch (cause) {
                  if (!controller.current?.signal.aborted)
                    setError(cause instanceof Error ? cause.message : t('shell.save_failed'));
                } finally {
                  if (!controller.current?.signal.aborted) setSubmitting(false);
                }
              }}
            >
              <label htmlFor="oauth-callback">{t('shell.callback_url')}</label>
              <input
                id="oauth-callback"
                type="url"
                required
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
              />
              <Button type="submit" disabled={submitting}>
                {t('shell.submit_callback')}
              </Button>
            </form>
          </>
        )}
        <Button variant="secondary" onClick={onClose}>
          {t(status === 'done' ? 'common.close' : 'common.cancel')}
        </Button>
      </div>
    </Modal>
  );
}
