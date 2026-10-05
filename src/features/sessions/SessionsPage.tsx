import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  historyApi,
  type FiltersResponse,
  type SearchResponse,
  type SessionDetail,
  type SessionItem,
} from '@/services/history';
import { groupSessions, searchTerms, transcriptEntries } from './transcript';
import styles from './SessionsPage.module.scss';

const clients = ['codex', 'claude', 'opencode', 't3'] as const;
const filterKeys = ['client', 'host', 'model', 'cwd', 'from', 'to'] as const;

function MatchSnippet({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  return text
    .split(pattern)
    .map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

function RawRecord({ item }: { item: SessionItem }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError('');
    historyApi.raw(item.id, controller.signal).then(
      ({ record }) => {
        if (!controller.signal.aborted) setRecord(JSON.stringify(record, null, 2));
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t('history.load_error'));
      }
    );
    return () => controller.abort();
  }, [open, item.id, t]);
  return (
    <details className={styles.raw} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('sessions.raw_record')}</summary>
      {error ? <p role="alert">{error}</p> : <pre>{record ?? t('history.loading')}</pre>}
    </details>
  );
}

function RecordBody({ item }: { item: SessionItem }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <>
      <pre className={styles.body}>{item.body}</pre>
      {item.bodyLength > item.body.length && (
        <p className={styles.meta}>{t('sessions.truncated', { count: item.bodyLength })}</p>
      )}
      <RawRecord item={item} />
    </>
  );
}

function SessionView({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [detail, setDetail] = useState<SessionDetail>();
  const [error, setError] = useState('');
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    back.current?.focus();
    historyApi.session(id, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setDetail(value);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t('history.load_error'));
      }
    );
    return () => controller.abort();
  }, [id, t]);
  return (
    <section className={styles.page} aria-label={t('sessions.transcript')}>
      <button ref={back} className={styles.back} onClick={onClose}>
        {t('sessions.back')}
      </button>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p role="status">{t('history.loading')}</p>}
      {detail && (
        <>
          <h1>{detail.session.title || detail.session.nativeId}</h1>
          <p className={styles.meta}>
            {[
              detail.session.repo || detail.session.cwd,
              detail.session.branch,
              t(`sessions.clients.${detail.session.client}`, {
                defaultValue: detail.session.client,
              }),
              detail.session.model,
              detail.session.host,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <ol className={styles.transcript}>
            {transcriptEntries(detail.items).map(({ item, outputs }) => (
              <li key={item.id} className={styles.message} data-role={item.role}>
                {item.role === 'tool_call' ? (
                  <details className={styles.tool}>
                    <summary>
                      {t('sessions.roles.tool_call')} · {item.tool || item.callId}
                      <time>
                        {item.time
                          ? new Date(item.time).toLocaleTimeString('en', { timeZone: 'UTC' })
                          : ''}
                      </time>
                    </summary>
                    <h3>{t('sessions.input')}</h3>
                    <RecordBody item={item} />
                    {outputs.map((output) => (
                      <div key={output.id}>
                        <h3>{t('sessions.output')}</h3>
                        <RecordBody item={output} />
                      </div>
                    ))}
                    {!outputs.length && <p className={styles.meta}>{t('sessions.no_output')}</p>}
                  </details>
                ) : (
                  <>
                    <div className={styles.role}>
                      <strong>
                        {t(`sessions.roles.${item.role}`, { defaultValue: item.role })}
                      </strong>
                      <time>
                        {item.time
                          ? new Date(item.time).toLocaleTimeString('en', { timeZone: 'UTC' })
                          : ''}
                      </time>
                    </div>
                    <RecordBody item={item} />
                  </>
                )}
              </li>
            ))}
          </ol>
          {!detail.items.length && <p>{t('sessions.no_items')}</p>}
        </>
      )}
    </section>
  );
}

export function SessionsPage() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<FiltersResponse>({ hosts: [], models: [] });
  const [data, setData] = useState<SearchResponse>({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<number, HTMLAnchorElement>());
  const closedId = useRef<number | null>(null);
  const idText = params.get('id');
  const id =
    idText && /^\d+$/.test(idText) && Number.isSafeInteger(Number(idText)) && Number(idText) > 0
      ? Number(idText)
      : null;
  const query = params.get('q') ?? '';
  const searchParams = new URLSearchParams(params);
  searchParams.delete('id');
  const searchKey = searchParams.toString();
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  useEffect(() => {
    const controller = new AbortController();
    historyApi.filters(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setFilters(value);
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t('history.load_error'));
      }
    );
    return () => controller.abort();
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      const values = new URLSearchParams(searchKey);
      historyApi
        .search(
          {
            q: values.get('q') ?? '',
            client: values.get('client') ?? '',
            host: values.get('host') ?? '',
            model: values.get('model') ?? '',
            cwd: values.get('cwd') ?? '',
            from: values.get('from') ?? '',
            to: values.get('to') ?? '',
            offset: Number(values.get('offset')) || 0,
          },
          controller.signal
        )
        .then(
          (value) => {
            if (!controller.signal.aborted) {
              setData(value);
              setSelected(0);
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
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchKey, t]);

  useEffect(() => {
    if (id !== null || closedId.current === null) return;
    const row = rows.current.get(closedId.current);
    if (row) row.focus();
    else searchInput.current?.focus();
    closedId.current = null;
  }, [id]);

  useEffect(() => {
    const close = () => {
      closedId.current = id;
      const next = new URLSearchParams(params);
      next.delete('id');
      setParams(next);
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      if (event.key === 'Escape' && id !== null) {
        event.preventDefault();
        close();
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input,textarea,select'))
      )
        return;
      if (event.key === '/' && id === null) {
        event.preventDefault();
        searchInput.current?.focus();
        return;
      }
      if (id !== null || loading || error || !data.sessions.length) return;
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const index = Math.max(
          0,
          Math.min(data.sessions.length - 1, selected + (event.key === 'j' ? 1 : -1))
        );
        setSelected(index);
        const row = rows.current.get(data.sessions[index].id);
        row?.focus();
        row?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } else if (
        event.key === 'Enter' &&
        !(target instanceof HTMLElement && target.closest('a,button,summary'))
      ) {
        event.preventDefault();
        const next = new URLSearchParams(params);
        next.set('id', String(data.sessions[selected].id));
        setParams(next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, params, setParams, selected, data.sessions, loading, error]);

  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'offset') next.delete('offset');
    setParams(next, { replace: true });
  }
  if (id !== null)
    return (
      <SessionView
        key={id}
        id={id}
        onClose={() => {
          closedId.current = id;
          const next = new URLSearchParams(params);
          next.delete('id');
          setParams(next);
        }}
      />
    );
  return (
    <section className={styles.page}>
      <h1>{t('sessions.title')}</h1>
      <input
        ref={searchInput}
        type="search"
        className={styles.search}
        aria-label={t('sessions.search')}
        placeholder={t('sessions.search')}
        maxLength={2000}
        value={query}
        onChange={(event) => update('q', event.target.value)}
      />
      <div className={styles.filters}>
        {filterKeys.map((key) => (
          <label key={key}>
            <span>{t(`sessions.filters.${key}`)}</span>
            {key === 'client' || key === 'host' || key === 'model' ? (
              <select
                value={params.get(key) ?? ''}
                onChange={(event) => update(key, event.target.value)}
              >
                <option value="">{t('sessions.any')}</option>
                {(key === 'client' ? clients : key === 'host' ? filters.hosts : filters.models).map(
                  (value) => (
                    <option key={value} value={value}>
                      {key === 'client' ? t(`sessions.clients.${value}`) : value}
                    </option>
                  )
                )}
              </select>
            ) : (
              <input
                type={key === 'cwd' ? 'text' : 'date'}
                value={params.get(key) ?? ''}
                onChange={(event) => update(key, event.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      <div className={styles.status} role="status">
        {loading ? t('history.loading') : t('sessions.count', { count: data.total })}
        <span>{t('sessions.shortcuts')}</span>
      </div>
      {idText && id === null && <p role="alert">{t('sessions.invalid_id')}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !data.sessions.length && <p>{t('sessions.empty')}</p>}
      {!error && (
        <div aria-busy={loading} className={loading ? styles.loading : ''}>
          {groupSessions(data.sessions).map(([day, sessions]) => (
            <section key={day} className={styles.day}>
              <h2>
                {day
                  ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })
                  : t('history.unknown_time')}
              </h2>
              <ul>
                {sessions.map((session) => {
                  const linkParams = new URLSearchParams(params);
                  linkParams.set('id', String(session.id));
                  const index = data.sessions.indexOf(session);
                  return (
                    <li key={session.id}>
                      <Link
                        to={`?${linkParams}`}
                        className={`${styles.row} ${selected === index ? styles.selected : ''}`}
                        ref={(node) => {
                          if (node) rows.current.set(session.id, node);
                          else rows.current.delete(session.id);
                        }}
                        onFocus={() => setSelected(index)}
                        aria-current={selected === index ? 'true' : undefined}
                        tabIndex={loading ? -1 : 0}
                      >
                        <div>
                          <strong>{session.title || session.nativeId}</strong>
                          <div className={styles.meta}>
                            {[
                              session.repo || session.cwd,
                              session.branch,
                              t(`sessions.clients.${session.client}`, {
                                defaultValue: session.client,
                              }),
                              session.model,
                              session.host,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          {query && data.snippets?.[session.id] && (
                            <p className={styles.snippet}>
                              <MatchSnippet text={data.snippets[session.id]} query={query} />
                            </p>
                          )}
                        </div>
                        <time
                          dateTime={
                            session.updated ? new Date(session.updated).toISOString() : undefined
                          }
                        >
                          {session.updated
                            ? new Date(session.updated).toLocaleTimeString('en', {
                                hour: '2-digit',
                                minute: '2-digit',
                                timeZone: 'UTC',
                              })
                            : ''}
                        </time>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!error && data.total > 100 && (
        <nav className={styles.pagination} aria-label={t('sessions.pagination')}>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || offset === 0}
            onClick={() => update('offset', String(Math.max(0, offset - 100)))}
          >
            {t('sessions.previous')}
          </Button>
          <span>
            {t('sessions.range', {
              from: offset + 1,
              to: offset + data.sessions.length,
              total: data.total,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || offset + 100 >= data.total}
            onClick={() => update('offset', String(offset + 100))}
          >
            {t('sessions.next')}
          </Button>
        </nav>
      )}
    </section>
  );
}
