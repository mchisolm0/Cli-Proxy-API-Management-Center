import { useTranslation } from 'react-i18next';
import { formatReset } from '@/features/shell/format';
import {
  quotaIsCurrent,
  quotaLevel,
  remainingPercent,
  windowLabel,
  type QuotaWindow,
} from './quotaSignals';
import styles from './QuotaBar.module.scss';

/**
 * One quota window as label, bar, percent and reset. `compact` drops the reset
 * for tight spots such as the sidebar and table rows.
 */
export function QuotaBar({
  window,
  now,
  label,
  compact = false,
}: {
  window: QuotaWindow;
  now: number;
  label?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const name = label ?? windowLabel(t, window, compact);
  // Bars drain: they show what is left, like the providers' own usage pages.
  const left = remainingPercent(window);
  const stale = !quotaIsCurrent(window, now);
  return (
    <div
      className={styles.quota}
      data-level={quotaLevel(window)}
      data-compact={compact}
      data-stale={stale}
    >
      <span className={styles.label}>{name}</span>
      <span
        className={styles.track}
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left === null ? undefined : Math.round(left)}
        aria-valuetext={
          window.rejected
            ? t('shell.exhausted')
            : left === null
              ? undefined
              : t('shell.left', { percent: Math.round(left) })
        }
      >
        <i style={{ width: `${left ?? 0}%` }} />
      </span>
      <strong>
        {window.rejected
          ? t('shell.exhausted')
          : left === null
            ? '?'
            : t('shell.left', { percent: Math.round(left) })}
      </strong>
      {!compact && (
        <span className={styles.reset}>
          {window.resetAtMs
            ? t('shell.resets', { when: formatReset(window.resetAtMs, now) })
            : t('shell.reset_unknown')}
          {stale && ` · ${t('shell.stale')}`}
        </span>
      )}
    </div>
  );
}
