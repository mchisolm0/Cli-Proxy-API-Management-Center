import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { historyApi, type HealthWindow, type Problem } from '@/services/history';
import styles from './ProblemsPage.module.scss';

const windows: HealthWindow[] = ['1h', '24h', '7d'];

function SeenTime({ time }: { time: number }) {
  return (
    <time dateTime={new Date(time).toISOString()}>
      {new Date(time).toLocaleString('en', {
        timeZone: 'UTC',
        dateStyle: 'short',
        timeStyle: 'short',
      })}
    </time>
  );
}

export function ProblemDetails({ problem, onClose }: { problem: Problem; onClose: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <section className={styles.detail}>
      <button ref={back} className={styles.back} onClick={onClose}>
        {t('problems.back')}
      </button>
      <h2 className={styles.category} data-class={problem.category}>
        {t(`problems.classes.${problem.category}`)}
      </h2>
      <h1>
        {problem.provider ||
          t(`problems.sources.${problem.source}`, { defaultValue: problem.source })}{' '}
        · {problem.code}
      </h1>
      {problem.model && <p>{problem.model}</p>}
      <p className={styles.explanation}>{t(`problems.explanations.${problem.category}`)}</p>
      <p className={styles.fix}>{problem.fix}</p>
      <dl className={styles.metrics}>
        <div>
          <dt>{t('problems.count')}</dt>
          <dd>{problem.count}</dd>
        </div>
        <div>
          <dt>{t('problems.sessions')}</dt>
          <dd>
            {problem.sessionCount}
            {problem.unindexedSessionCount > 0 &&
              ` + ${t('problems.unindexed', { count: problem.unindexedSessionCount })}`}
          </dd>
        </div>
        <div>
          <dt>{t('problems.retried')}</dt>
          <dd>{problem.retriedAttempts}</dd>
        </div>
        <div>
          <dt>{t('problems.inferred_final')}</dt>
          <dd>{problem.inferredFinalFailures}</dd>
        </div>
        <div>
          <dt>{t('problems.unresolved')}</dt>
          <dd>{problem.unresolvedAttempts}</dd>
        </div>
        <div>
          <dt>{t('problems.attempt_errors')}</dt>
          <dd>{problem.attemptErrors}</dd>
        </div>
        <div>
          <dt>{t('problems.last_seen')}</dt>
          <dd>
            <SeenTime time={problem.lastSeen} />
          </dd>
        </div>
      </dl>
      <p className={styles.note}>{t('problems.inference_note')}</p>
      <h2>{t('problems.examples')}</h2>
      <ul className={styles.examples}>
        {problem.examples.map((example, index) => (
          <li key={`${example.time}-${index}`}>
            <div className={styles.exampleHeading}>
              <SeenTime time={example.time} />
              <span>
                {t(`problems.outcomes.${example.outcome}`, { defaultValue: example.outcome })}
              </span>
            </div>
            <pre>{JSON.stringify(example.payload, null, 2)}</pre>
          </li>
        ))}
      </ul>
      {!problem.examples.length && <p>{t('problems.no_examples')}</p>}
      <h2>{t('problems.sessions')}</h2>
      <ul className={styles.sessions}>
        {problem.sessions.map((session) => (
          <li key={session.id}>
            <Link to={`/sessions?id=${session.id}`}>
              <span>{session.title || session.nativeId}</span>
              <span>{session.host}</span>
            </Link>
          </li>
        ))}
      </ul>
      {problem.sessionCount > problem.sessions.length && (
        <p>
          {t('problems.more_sessions', { count: problem.sessionCount - problem.sessions.length })}
        </p>
      )}
      {!problem.sessions.length && <p>{t('problems.no_sessions')}</p>}
    </section>
  );
}

export function ProblemsPage() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [window, setWindow] = useState<HealthWindow>('24h');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const closed = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelected(null);
    historyApi.problems(window, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setProblems(value.problems);
          setLoading(false);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : t('history.load_error'));
          setLoading(false);
        }
      }
    );
    return () => controller.abort();
  }, [window, refresh, t]);
  useEffect(() => {
    if (selected !== null || closed.current === null) return;
    rows.current.get(closed.current)?.focus();
    closed.current = null;
  }, [selected]);
  const problem = problems.find((problem) => problem.key === selected);
  return (
    <div className={styles.page}>
      {problem ? (
        <ProblemDetails
          problem={problem}
          onClose={() => {
            closed.current = problem.key;
            setSelected(null);
          }}
        />
      ) : (
        <>
          <header className={styles.header}>
            <h1>{t('problems.title')}</h1>
            <div className={styles.controls}>
              <div className={styles.windows} role="group" aria-label={t('problems.window')}>
                {windows.map((value) => (
                  <button
                    key={value}
                    aria-pressed={window === value}
                    onClick={() => setWindow(value)}
                  >
                    {t(`history.windows.${value}`)}
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => setRefresh((value) => value + 1)}
              >
                {t('history.refresh')}
              </Button>
            </div>
          </header>
          {loading && <p role="status">{t('history.loading')}</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && !problems.length && <p>{t('problems.empty')}</p>}
          {!error && (
            <ol className={styles.list} aria-busy={loading}>
              {problems.map((problem, index) => (
                <li key={problem.key}>
                  <button
                    className={styles.row}
                    data-class={problem.category}
                    disabled={loading}
                    ref={(node) => {
                      if (node) rows.current.set(problem.key, node);
                      else rows.current.delete(problem.key);
                    }}
                    onClick={() => setSelected(problem.key)}
                  >
                    <span className={styles.rank}>{index + 1}</span>
                    <span className={styles.description}>
                      <span className={styles.category} data-class={problem.category}>
                        {t(`problems.classes.${problem.category}`)}
                      </span>
                      <strong>
                        {[
                          problem.provider ||
                            t(`problems.sources.${problem.source}`, {
                              defaultValue: problem.source,
                            }),
                          problem.model,
                          problem.code,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </strong>
                      <span>{t(`problems.explanations.${problem.category}`)}</span>
                      <span className={styles.fix}>{problem.fix}</span>
                    </span>
                    <span className={styles.numbers}>
                      <span>{t('problems.failure_count', { count: problem.count })}</span>
                      <span>
                        {t('problems.session_count', { count: problem.affectedSessions })}
                      </span>
                      <span>
                        {t('problems.last_seen')} <SeenTime time={problem.lastSeen} />
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
