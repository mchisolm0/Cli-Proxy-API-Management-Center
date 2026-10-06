import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';

/** Page refresh handlers can disappear on unmount; pool/config refresh is always required. */
export async function refreshShell(
  refreshPool: (forceConfig: boolean) => Promise<void>,
  refreshPage = triggerHeaderRefresh
) {
  await refreshPool(true);
  await refreshPage();
}
