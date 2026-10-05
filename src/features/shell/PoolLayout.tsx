import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainRoutes } from '@/router/MainRoutes';
import { useAuthStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { pluginsApi } from '@/services/api';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  collectPluginResourceEntries,
  PLUGIN_RESOURCES_REFRESH_EVENT,
  type PluginResourceEntry,
} from '@/features/plugins/pluginResources';
import { PoolProvider, usePool } from '@/features/providerWorkspace/PoolContext';
import { providerPath } from '@/features/providerWorkspace/model';
import { tightestQuota } from '@/features/providerWorkspace/quotaSignals';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { OAuthDialog } from '@/features/providerWorkspace/OAuthDialog';
import styles from './Shell.module.scss';

export function PoolLayout() {
  const connection = useAuthStore(
    (state) => `${state.apiBase}:${state.connectionStatus}:${state.isAuthenticated}`
  );
  return (
    <PoolProvider key={`${connection}:${apiClient.getConnectionRevision()}`}>
      <Shell />
    </PoolProvider>
  );
}

function Shell() {
  const { t } = useTranslation();
  const pool = usePool();
  const location = useLocation();
  const [palette, setPalette] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginResourceEntry[]>([]);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const logout = useAuthStore((state) => state.logout);
  const version = useAuthStore((state) => state.serverVersion);
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    content.current?.scrollTo(0, 0);
    setMobileOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    let active = true;
    const revision = apiClient.getConnectionRevision();
    const load = async () => {
      if (!supportsPlugin) {
        setPlugins([]);
        return;
      }
      try {
        const result = await pluginsApi.list();
        if (active && revision === apiClient.getConnectionRevision())
          setPlugins(collectPluginResourceEntries(result.plugins));
      } catch {
        if (active) setPlugins([]);
      }
    };
    void load();
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, load);
    };
  }, [supportsPlugin]);
  const nav = (path: string, label: string) => (
    <NavLink
      key={path}
      to={path}
      end={path === '/'}
      className={({ isActive }) => (isActive ? styles.active : '')}
    >
      {label}
    </NavLink>
  );
  return (
    <div className={styles.shell}>
      <a href="#pool-content" className={styles.skip}>
        {t('shell.skip_content')}
      </a>
      <header className={styles.topbar}>
        <button
          type="button"
          className={styles.mobileToggle}
          aria-label={t('shell.navigation')}
          aria-expanded={mobileOpen}
          aria-controls="pool-navigation"
          onClick={() => setMobileOpen((open) => !open)}
        >
          ☰
        </button>
        <Link className={styles.brand} to="/">
          ai-pool
        </Link>
        <button
          className={styles.trigger}
          type="button"
          onClick={() => setPalette(true)}
          aria-keyshortcuts="Control+k Meta+k"
        >
          <span>{t('shell.search')}</span>
          <kbd>⌘ / Ctrl K</kbd>
        </button>
        <button
          type="button"
          className={styles.headerAction}
          onClick={() => void triggerHeaderRefresh()}
          disabled={pool.loading}
        >
          {t('shell.refresh')}
        </button>
        <button type="button" className={styles.headerAction} onClick={logout}>
          {t('header.logout')}
        </button>
      </header>
      {mobileOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label={t('common.close')}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`${styles.sidebar} ${mobileOpen ? styles.open : ''}`} id="pool-navigation">
        <nav aria-label={t('shell.navigation')}>
          {nav('/', t('shell.home'))}
          {nav('/providers', t('shell.providers'))}
          <div className={styles.providers}>
            {pool.providers.map((provider) => {
              const quota = tightestQuota(pool.quotaForProvider(provider), pool.now);
              const attention = pool.attention.some((item) => item.provider === provider.id);
              const paused = provider.oauth
                ? provider.files.length > 0 && provider.files.every((file) => file.disabled)
                : provider.resources.every((resource) => resource.disabled);
              return (
                <NavLink
                  key={provider.id}
                  to={providerPath(provider.id)}
                  className={({ isActive }) => (isActive ? styles.active : '')}
                >
                  <span
                    className={styles.dot}
                    data-status={
                      paused || pool.loading || pool.errors.length
                        ? 'unknown'
                        : attention
                          ? 'warning'
                          : 'ok'
                    }
                    aria-label={t(
                      paused
                        ? 'shell.paused'
                        : attention
                          ? 'shell.needs_review'
                          : pool.errors.length
                            ? 'shell.unknown'
                            : 'shell.active'
                    )}
                  />
                  <span>{provider.name}</span>
                  <small>
                    {quota ? `${Math.round(quota.usedPercent ?? 0)}%` : t('shell.unknown')}
                  </small>
                </NavLink>
              );
            })}
          </div>
          {nav('/sessions', t('shell.sessions'))}
          {nav('/problems', t('shell.problems'))}
          <div className={styles.divider} />
          {nav('/config', t('shell.settings'))}
          {nav('/logs', t('shell.logs'))}
          {nav('/system', t('shell.system'))}
          <details className={styles.advanced}>
            <summary>{t('shell.advanced')}</summary>
            {nav('/dashboard', t('nav.dashboard'))}
            {nav('/auth-files', t('nav.auth_files'))}
            {nav('/oauth', t('nav.oauth'))}
            {nav('/quota', t('nav.quota'))}
            {nav('/ai-providers', t('nav.ai_providers'))}
            {nav('/quick-start', t('nav.quick_start'))}
            {supportsPlugin && (
              <>
                {nav('/plugins', t('nav.plugins'))}
                {nav('/plugin-store', t('nav.plugin_store'))}
              </>
            )}
          </details>
          {supportsPlugin && plugins.map((plugin) => nav(plugin.route, plugin.label))}
        </nav>
        <div className={styles.version}>{version || t('shell.proxy')}</div>
      </aside>
      <main ref={content} id="pool-content" tabIndex={-1} className={`${styles.content} content`}>
        <MainRoutes />
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} onLogin={setLogin} />}
      {login && <OAuthDialog key={login} provider={login} onClose={() => setLogin(null)} />}
    </div>
  );
}
