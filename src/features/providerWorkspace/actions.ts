import i18n from '@/i18n';
import { useNotificationStore } from '@/stores/useNotificationStore';

/** Config mutations explicitly disclose the irreversible v8 layout migration. */
export function confirmPoolChange(
  action: 'enable' | 'disable' | 'pause' | 'resume',
  name: string,
  onConfirm: () => Promise<void>,
  configWrite = false
) {
  const label = i18n.t(`shell.${action}`);
  useNotificationStore.getState().showConfirmation({
    title: label,
    message: [
      i18n.t(
        action === 'pause' || action === 'resume'
          ? 'shell.pool_change_confirm'
          : 'shell.change_confirm',
        { action: label, name }
      ),
      configWrite ? i18n.t('shell.config_write_warning') : '',
    ]
      .filter(Boolean)
      .join(' '),
    confirmText: label,
    variant: action === 'disable' || action === 'pause' ? 'danger' : 'primary',
    onConfirm,
  });
}

/** Keep mutations in order; reads bypass pending mutations and never hold up later actions. */
export function createMutationQueue() {
  let pending = Promise.resolve();
  return (action: () => Promise<void>, mutation = true) => {
    if (!mutation) return action();
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
}
