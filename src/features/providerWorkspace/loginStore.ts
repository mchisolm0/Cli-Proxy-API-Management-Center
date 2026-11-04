import { create } from 'zustand';

/** Providers CLIProxyAPI can sign in to from the dashboard, in menu order. */
export const LOGIN_CHANNELS = ['claude', 'codex', 'meta', 'antigravity', 'kimi', 'xai', 'devin'];
export const canLogin = (channel: string) => LOGIN_CHANNELS.includes(channel);

/** `account` is set when repairing an existing credential rather than adding one. */
export type Login = { channel: string; account?: string; attempt: number };

/** The one sign-in in progress, shown inline above whichever page is open. */
export const useLogin = create<{
  login: Login | null;
  start: (channel: string, account?: string) => void;
  close: () => void;
}>()((set) => ({
  login: null,
  start: (channel, account) =>
    set((state) => ({ login: { channel, account, attempt: (state.login?.attempt ?? 0) + 1 } })),
  close: () => set({ login: null }),
}));
