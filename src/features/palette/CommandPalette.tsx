import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { CONFIG_FIELD_SEARCH_INDEX } from '@/features/config/searchIndex';
import { apiClient } from '@/services/api/client';
import { getConfigValue } from '@/services/api/configValue';
import { applyConfigPatch } from '@/services/api/configPatch';
import { historyApi, type SessionSummary } from '@/services/history';
import { useConfigStore } from '@/stores';
import { usePool } from '@/features/providerWorkspace/PoolContext';
import { credentialId, credentialLabel, providerPath } from '@/features/providerWorkspace/model';
import {
  parseScalarValue,
  rankCommands,
  scalarSettingsFromConfig,
  type ScalarSetting,
} from './ranking';
import styles from '@/features/providerWorkspace/Workspace.module.scss';
import { confirmPoolChange } from '@/features/providerWorkspace/actions';

type Command = {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  run: () => void;
  setting?: ScalarSetting;
};

function SettingEditor({
  command,
  onBack,
}: {
  command: Command & { setting: ScalarSetting };
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const setting = command.setting;
  const [draft, setDraft] = useState<string | boolean>('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const revision = useRef(apiClient.getConnectionRevision());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void getConfigValue<unknown>(`/config/${setting.path.join('/')}`, setting.fallback)
      .then((value) => {
        if (!active.current || revision.current !== apiClient.getConnectionRevision()) return;
        if (typeof value !== typeof setting.fallback)
          throw new Error(t('shell.setting_type_error'));
        setDraft(typeof value === 'boolean' ? value : String(value));
        setReady(true);
      })
      .catch((cause) => {
        if (active.current)
          setError(cause instanceof Error ? cause.message : t('shell.load_error'));
      });
    return () => {
      active.current = false;
    };
  }, [setting, t]);
  return (
    <form
      className={styles.settingEditor}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        setMessage('');
        try {
          const value = parseScalarValue(setting, draft);
          const patch = setting.path.reduceRight<Record<string, unknown>>(
            (child, key, index) => ({ [key]: index === setting.path.length - 1 ? value : child }),
            {}
          );
          await applyConfigPatch({ patch, deletions: [] }, revision.current);
          useConfigStore.getState().clearCache();
          await useConfigStore.getState().fetchConfig(true);
          if (active.current) setMessage(t('shell.saved'));
        } catch (cause) {
          if (active.current)
            setError(cause instanceof Error ? cause.message : t('shell.save_failed'));
        } finally {
          if (active.current) setSaving(false);
        }
      }}
    >
      <label htmlFor="palette-setting">{command.label}</label>
      {typeof setting.fallback === 'boolean' ? (
        <input
          id="palette-setting"
          type="checkbox"
          checked={draft === true}
          disabled={!ready || saving}
          onChange={(event) => {
            setDraft(event.target.checked);
            setMessage('');
          }}
        />
      ) : (
        <input
          id="palette-setting"
          type={typeof setting.fallback === 'number' ? 'number' : 'text'}
          min={setting.min}
          max={setting.max}
          step={1}
          required={typeof setting.fallback === 'number'}
          value={String(draft)}
          disabled={!ready || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage('');
          }}
        />
      )}
      <p>{t('shell.config_write_warning')}</p>
      <div className={styles.actions}>
        <Button type="submit" disabled={!ready || saving}>
          {t('shell.save_config')}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onBack}>
          {t('shell.back')}
        </Button>
      </div>
      <p role="status">{message}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </form>
  );
}

export function CommandPalette({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pool = usePool();
  const config = useConfigStore((state) => state.config);
  const inlineSettings = useMemo(
    () => scalarSettingsFromConfig(config?.raw, CONFIG_FIELD_SEARCH_INDEX),
    [config?.raw]
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [searchError, setSearchError] = useState(false);
  const [searching, setSearching] = useState(true);
  const [editing, setEditing] = useState<(Command & { setting: ScalarSetting }) | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = setTimeout(() => searchRef.current?.focus(), 30);
    return () => {
      clearTimeout(timer);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const revision = apiClient.getConnectionRevision();
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(false);
      void historyApi
        .search({ q: query }, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted && revision === apiClient.getConnectionRevision())
            setSessions(result.sessions);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSessions([]);
            setSearchError(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const commands: Command[] = [
    ...pool.providers.flatMap((provider): Command[] => {
      const path = providerPath(provider.id);
      const commands: Command[] = [
        {
          id: `provider:${provider.id}`,
          group: t('shell.providers'),
          label: t('shell.open_named_provider', { provider: provider.name }),
          run: () => go(path),
        },
        {
          id: `add:${provider.id}`,
          group: t('shell.actions'),
          label: t(provider.oauth ? 'shell.add_named_account' : 'shell.add_named_key', {
            provider: provider.name,
          }),
          run: () =>
            provider.oauth &&
            ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(
              provider.channel
            )
              ? (onClose(), onLogin(provider.channel))
              : go(provider.oauth ? '/auth-files' : `${path}?add=1`),
        },
      ];
      if (
        provider.oauth &&
        ['codex', 'claude', 'antigravity', 'kimi', 'xai', 'devin', 'meta'].includes(
          provider.channel
        )
      )
        commands.push({
          id: `login:${provider.id}`,
          group: t('shell.actions'),
          label: t('shell.relogin_provider', { provider: provider.name }),
          keywords: 'oauth login',
          run: () => {
            onClose();
            onLogin(provider.channel);
          },
        });
      commands.push(
        ...provider.files.map((file) => ({
          id: `toggle:${credentialId(file)}`,
          label: `${t(file.disabled ? 'shell.enable' : 'shell.disable')} ${credentialLabel(file)}`,
          group: t('shell.actions'),
          run: () => {
            onClose();
            confirmPoolChange(file.disabled ? 'enable' : 'disable', credentialLabel(file), () =>
              pool.run(() => pool.setCredential(file, !file.disabled))
            );
          },
        }))
      );
      commands.push(
        ...provider.resources.map((resource) => ({
          id: `toggle:${resource.id}`,
          label: `${t(resource.disabled ? 'shell.enable' : 'shell.disable')} ${provider.name} ${resource.identifier}`,
          group: t('shell.actions'),
          run: () => {
            onClose();
            confirmPoolChange(
              resource.disabled ? 'enable' : 'disable',
              `${provider.name} ${resource.identifier}`,
              () => pool.run(() => pool.workbench.toggleDisabled(resource, !resource.disabled)),
              true
            );
          },
        }))
      );
      return commands;
    }),
    ...CONFIG_FIELD_SEARCH_INDEX.map((entry) => ({
      id: `setting:${entry.fieldId}`,
      group: t('shell.settings'),
      label: `${t(entry.labelKey)}${entry.qualifierKey ? ` · ${t(entry.qualifierKey)}` : ''}`,
      keywords: [...(entry.yamlKeys ?? []), ...(entry.keywords ?? [])].join(' '),
      setting: inlineSettings[entry.fieldId],
      run: () => go(`/config?field=${entry.fieldId}`),
    })),
    ...sessions.map((session) => ({
      id: `session:${session.id}`,
      group: t('shell.sessions'),
      label: session.title || t('shell.untitled_session'),
      keywords: `${session.host} ${session.repo} ${session.model}`,
      run: () => go(`/sessions?id=${session.id}`),
    })),
  ];
  const localCommands = commands.filter(
    (command) =>
      !command.id.startsWith('session:') &&
      (query.trim() || !command.id.startsWith('setting:') || command.setting)
  );
  // The server also searches transcripts; a returned session need not match its title.
  const ranked = [
    ...rankCommands(localCommands, query).slice(0, 40),
    ...commands.filter((command) => command.id.startsWith('session:')).slice(0, 12),
  ];
  const activeIndex = Math.min(selected, Math.max(0, ranked.length - 1));
  const activate = (command?: Command) => {
    if (!command || pool.busy) return;
    if (command.setting) setEditing({ ...command, setting: command.setting });
    else command.run();
  };
  const heading = useMemo(() => t('shell.palette'), [t]);
  return (
    <Modal open title={heading} onClose={onClose} width={700} className={styles.palette}>
      {editing ? (
        <SettingEditor
          key={editing.id}
          command={editing}
          onBack={() => {
            setEditing(null);
            setTimeout(() => searchRef.current?.focus(), 0);
          }}
        />
      ) : (
        <>
          <input
            ref={searchRef}
            className={styles.paletteSearch}
            role="combobox"
            aria-label={t('shell.search')}
            aria-autocomplete="list"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={ranked.length ? `palette-option-${activeIndex}` : undefined}
            placeholder={t('shell.search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setSessions([]);
              setSearching(true);
            }}
            onKeyDown={(event) => {
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                setSelected(
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? ranked.length - 1
                      : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + ranked.length) %
                        Math.max(1, ranked.length)
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                activate(ranked[activeIndex]);
              }
            }}
          />
          <div
            id="palette-results"
            role="listbox"
            aria-label={heading}
            className={styles.paletteResults}
          >
            {ranked.map((command, index) => (
              <div
                key={command.id}
                id={`palette-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={styles.paletteOption}
                onMouseMove={() => setSelected(index)}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={pool.busy}
                  onClick={() => activate(command)}
                  ref={(element) => {
                    if (index === activeIndex) element?.scrollIntoView({ block: 'nearest' });
                  }}
                >
                  <span>{command.label}</span>
                  <small>{command.group}</small>
                </button>
              </div>
            ))}
          </div>
          <p role="status">
            {searchError
              ? t('shell.sessions_unavailable')
              : searching
                ? t('shell.searching')
                : !ranked.length
                  ? t('shell.no_matches')
                  : t('shell.palette_keys')}
          </p>
        </>
      )}
    </Modal>
  );
}
