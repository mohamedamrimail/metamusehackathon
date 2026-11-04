import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Iperson, type User } from './api.ts';

interface Session {
  loading: boolean;
  user: User | null;
  iperson: Iperson | null;
  refresh(): Promise<void>;
}

const Ctx = createContext<Session>({ loading: true, user: null, iperson: null, refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Session, 'refresh'>>({ loading: true, user: null, iperson: null });
  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; iperson: Iperson | null }>('/me');
      // Signed up from a personal invite link: link the account to it (once; the server checks it all).
      try {
        const join = localStorage.getItem('ip_join');
        if (join) { localStorage.removeItem('ip_join'); void api(`/invites/${encodeURIComponent(join)}/accept`, { method: 'POST' }).catch(() => {}); }
        // Impact §4: a gift code or family invite opened before signing up (pages/Pricing.tsx).
        const family = localStorage.getItem('ip_family');
        if (family) { localStorage.removeItem('ip_family'); void api(`/family-invites/${encodeURIComponent(family)}/accept`, { method: 'POST' }).catch(() => {}); }
        const gift = localStorage.getItem('ip_gift');
        if (gift) {
          localStorage.removeItem('ip_gift');
          // Redeeming adds the credit and approves a beta account, so read /me again.
          if (await api('/gifts/redeem', { body: { code: gift } }).then(() => true, () => false)) Object.assign(me, await api<typeof me>('/me'));
        }
      } catch { /* storage blocked */ }
      setState({ loading: false, user: me.user, iperson: me.iperson });
    } catch {
      setState({ loading: false, user: null, iperson: null });
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
