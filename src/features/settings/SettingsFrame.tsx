import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores';
import styles from './Settings.module.scss';

const TABS = [
  ['/config', 'shell.settings_config'],
  ['/logs', 'shell.logs'],
  ['/system', 'shell.system'],
  ['/settings/advanced', 'shell.advanced'],
] as const;

/** Settings is one place: upstream Config, Logs and System pages share a tab strip. */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <nav className={styles.tabs} aria-label={t('shell.settings')}>
        {TABS.map(([path, label]) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => (isActive ? styles.active : '')}
          >
            {t(label)}
          </NavLink>
        ))}
      </nav>
      {children}
    </>
  );
}

/** Upstream tools kept reachable for rare jobs the provider pages do not cover. */
export function AdvancedPage() {
  const { t } = useTranslation();
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const tools: [string, string, string][] = [
    ['/auth-files', 'nav.auth_files', 'shell.advanced_auth_files'],
    ['/oauth', 'nav.oauth', 'shell.advanced_oauth'],
    ['/quota', 'nav.quota_management', 'shell.advanced_quota'],
    ['/ai-providers', 'nav.ai_providers', 'shell.advanced_ai_providers'],
    ['/problems', 'shell.problems', 'shell.advanced_problems'],
    ['/dashboard', 'nav.dashboard', 'shell.advanced_dashboard'],
    ...(supportsPlugin
      ? ([
          ['/plugins', 'nav.plugins', 'shell.advanced_plugins'],
          ['/plugin-store', 'nav.plugin_store', 'shell.advanced_plugin_store'],
        ] as [string, string, string][])
      : []),
  ];
  return (
    <div className={styles.advanced}>
      {tools.map(([path, label, hint]) => (
        <Link key={path} to={path}>
          <strong>{t(label)}</strong>
          <span>{t(hint)}</span>
        </Link>
      ))}
    </div>
  );
}
