import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '@/services/history';
import { formatWhen, projectName } from './format';
import styles from './SessionRows.module.scss';

export function SessionRows({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
  const { t } = useTranslation();
  return (
    <div className={styles.rows}>
      {sessions.map((session) => (
        <Link key={session.id} to={`/sessions?id=${session.id}`} className={styles.row}>
          <span className={styles.title}>{session.title || t('shell.untitled_session')}</span>
          <span className={styles.meta}>
            {[projectName(session), session.branch, session.client, session.model, session.host]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <time dateTime={new Date(session.updated).toISOString()}>
            {formatWhen(session.updated, now)}
          </time>
        </Link>
      ))}
    </div>
  );
}
