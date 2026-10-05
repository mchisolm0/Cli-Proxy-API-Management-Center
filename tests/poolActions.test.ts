import { describe, expect, test } from 'bun:test';
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

  test('canceling confirmation leaves the mutation untouched', () => {
    let calls = 0;
    confirmPoolChange('disable', 'Account', async () => {
      calls++;
    });
    useNotificationStore.getState().hideConfirmation();
    expect(calls).toBe(0);
    expect(useNotificationStore.getState().confirmation.isOpen).toBe(false);
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

  test('a hung quota read bypasses queued mutations without blocking later actions', async () => {
    const enqueue = createMutationQueue();
    const mutationGate = Promise.withResolvers<void>();
    const quotaGate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const first = enqueue(async () => {
      calls.push('toggle');
      await mutationGate.promise;
    });
    await Promise.resolve();
    const quota = enqueue(async () => {
      calls.push('quota');
      await quotaGate.promise;
    }, false);
    const next = enqueue(async () => {
      calls.push('delete');
    });
    expect(calls).toEqual(['toggle', 'quota']);
    mutationGate.resolve();
    await first;
    await next;
    expect(calls).toEqual(['toggle', 'quota', 'delete']);
    quotaGate.resolve();
    await quota;
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
});

test('sign-in action uses the English label in each fallback locale', () => {
  for (const lng of ['en', 'zh-CN', 'zh-TW', 'ru']) {
    expect(i18n.t('shell.open_signin', { lng })).toBe('Open sign-in link');
    expect(i18n.t('shell.oauth_waiting', { lng })).toBe(
      i18n.t('shell.oauth_waiting', { lng: 'en' })
    );
  }
});
