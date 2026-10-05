import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n';
import { useNotificationStore } from '../src/stores/useNotificationStore';
import {
  confirmAccountLogin,
  confirmPoolChange,
  createMutationQueue,
} from '../src/features/providerWorkspace/actions';
import { refreshShell } from '../src/features/shell/refresh';

describe('deliberate pool actions', () => {
  test('pause and palette toggles wait for confirmation and disclose config migration', async () => {
    for (const action of ['pause', 'resume', 'disable', 'enable'] as const) {
      let calls = 0;
      confirmPoolChange(
        action,
        'Synthetic provider',
        async () => {
          calls++;
        },
        true
      );
      const { isOpen, options } = useNotificationStore.getState().confirmation;
      expect(isOpen).toBe(true);
      expect(calls).toBe(0);
      expect(options?.message).toContain('Synthetic provider');
      expect(options?.message).toContain(i18n.t('shell.config_write_warning'));
      expect(options?.confirmText).toBe(i18n.t(`shell.${action}`));
      if (action === 'pause' || action === 'resume')
        expect(options?.message).toContain(
          i18n.t('shell.pool_change_confirm', {
            action: i18n.t(`shell.${action}`),
            name: 'Synthetic provider',
          })
        );
      await options?.onConfirm();
      expect(calls).toBe(1);
      useNotificationStore.getState().hideConfirmation();
    }
    confirmPoolChange('disable', 'Account', async () => {}, false);
    expect(useNotificationStore.getState().confirmation.options?.message).not.toContain(
      i18n.t('shell.config_write_warning')
    );
    useNotificationStore.getState().hideConfirmation();
  });

  test('runtime-only attention rows have no credential toggles or account login', () => {
    const rows = readFileSync('src/features/providerWorkspace/ProblemRows.tsx', 'utf8');
    expect(rows).toContain('!item.file.runtimeOnly');
    expect(rows).toContain('!item.file?.runtimeOnly');
    expect(rows).not.toContain("item.reason === 'disabled'");
    const pool = readFileSync('src/features/providerWorkspace/PoolContext.tsx', 'utf8');
    expect(pool).toContain(
      "if (file.runtimeOnly) throw new Error(t('shell.runtime_credential_config'))"
    );
  });

  test('workspace, attention and palette mutations use the confirmation boundary', () => {
    const workspace = readFileSync(
      'src/features/providerWorkspace/ProviderWorkspacePage.tsx',
      'utf8'
    );
    const palette = readFileSync('src/features/palette/CommandPalette.tsx', 'utf8');
    const rows = readFileSync('src/features/providerWorkspace/ProblemRows.tsx', 'utf8');
    expect(workspace).toMatch(/confirmPoolChange\(\s*paused \? 'resume' : 'pause'/);
    for (const source of [workspace, palette]) {
      expect(source).toContain('confirmPoolChange(');
      expect(source).toContain("file.disabled ? 'enable' : 'disable'");
      expect(source).toContain("resource.disabled ? 'enable' : 'disable'");
    }
    expect(rows).toContain('confirmPoolChange(');
    expect(palette).toContain("t('shell.save_config')");
    expect(palette).toContain("t('shell.config_write_warning')");
  });

  test('confirmed deletes wait for pending mutations and the queue survives failures', async () => {
    const enqueue = createMutationQueue();
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const first = enqueue(async () => {
      calls.push('toggle');
      await gate.promise;
      throw new Error('synthetic failure');
    });
    const caught = first.catch((error: unknown) => error);
    const deletion = enqueue(async () => {
      calls.push('delete');
    });
    await Promise.resolve();
    expect(calls).toEqual(['toggle']);
    gate.resolve();
    expect(await caught).toBeInstanceOf(Error);
    await deletion;
    expect(calls).toEqual(['toggle', 'delete']);
  });

  test('account login names the account and explains that another account adds credentials', () => {
    let started = false;
    confirmAccountLogin('synthetic@example.invalid', () => {
      started = true;
    });
    const options = useNotificationStore.getState().confirmation.options;
    expect(started).toBe(false);
    expect(options?.message).toBe(
      i18n.t('shell.relogin_confirm', { name: 'synthetic@example.invalid' })
    );
    options?.onConfirm();
    expect(started).toBe(true);
    for (const path of ['ProblemRows.tsx', 'ProviderWorkspacePage.tsx'])
      expect(readFileSync(`src/features/providerWorkspace/${path}`, 'utf8')).toContain(
        'confirmAccountLogin('
      );
    expect(readFileSync('src/features/providerWorkspace/OAuthDialog.tsx', 'utf8')).toContain(
      "t('shell.oauth_account_hint')"
    );
    useNotificationStore.getState().hideConfirmation();
  });
});

test('shell refresh forces pool/config refresh even after the page handler disappears', async () => {
  const calls: string[] = [];
  const refresh = async (force: boolean) => {
    calls.push(`config:${force}`);
  };
  await refreshShell(refresh);
  expect(calls).toEqual(['config:true']);
  await refreshShell(refresh, async () => {
    calls.push('page');
  });
  expect(calls).toEqual(['config:true', 'config:true', 'page']);
  expect(readFileSync('src/features/shell/PoolLayout.tsx', 'utf8')).toContain(
    'refreshShell(pool.refresh)'
  );
  const pool = readFileSync('src/features/providerWorkspace/PoolContext.tsx', 'utf8');
  expect(pool).toContain('fetchConfig(forceConfig)');
  expect(pool).not.toContain('useHeaderRefresh(refresh)');
});
