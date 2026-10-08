import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken } from './api.ts';
import type { PublicUser } from '../shared/types.ts';

interface SessionState {
  user: PublicUser | null;
  loading: boolean;
  cartCount: number;
  unreadNotifications: number;
  unreadMessages: number;
  refresh: () => Promise<void>;
  signIn: (token: string, user: PublicUser) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ cartCount: 0, unreadNotifications: 0, unreadMessages: 0 });

  const refresh = useCallback(async () => {
    try {
      const me = await api('/me');
      setUser(me.user);
      setCounts({ cartCount: me.cartCount ?? 0, unreadNotifications: me.unreadNotifications ?? 0, unreadMessages: me.unreadMessages ?? 0 });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const signIn = useCallback(
    (token: string, next: PublicUser) => {
      setToken(token);
      setUser(next);
      refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    setToken(null);
    setUser(null);
    setCounts({ cartCount: 0, unreadNotifications: 0, unreadMessages: 0 });
  }, []);

  return <SessionContext.Provider value={{ user, loading, ...counts, refresh, signIn, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
