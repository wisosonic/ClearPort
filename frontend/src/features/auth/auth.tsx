import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, refreshSession, request, setSessionLostHandler, tokens } from '@/lib/api-client';

export interface Me {
  user: { id: string; email: string; firstName: string; lastName: string };
  tenant: { id: string; slug: string; name: string; defaultCurrency: string; timezone: string; locale: string };
  branch: { id: string; code: string; name: string } | null;
  roles: { id: string; code: string; name: string }[];
  permissions: string[];
  availableTenants: { id: string; slug: string; name: string }[];
}

export type LoginResult = { status: 'ok' } | { status: 'choose-office'; offices: { id: string; slug: string; name: string }[] };
type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  me: Me | null;
  permissions: ReadonlySet<string>;
  /** set when a previously valid session was lost, so the login page can say why */
  sessionExpired: boolean;
  login(email: string, password: string, officeSlug?: string): Promise<LoginResult>;
  logout(): Promise<void>;
  switchOffice(slug: string): Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
const NO_PERMISSIONS: ReadonlySet<string> = new Set();

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadMe = useCallback(async () => {
    const m = await api.get<Me>('/auth/me');
    setMe(m);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    tokens.set(null);
    setMe(null);
    setStatus('anonymous');
    qc.clear(); // never keep one session's data around for the next sign-in
  }, [qc]);

  useEffect(() => {
    setSessionLostHandler(() => { setSessionExpired(true); clear(); });
    let cancelled = false;
    (async () => {
      if (!tokens.refresh) { setStatus('anonymous'); return; }
      try {
        if (!(await refreshSession())) { if (!cancelled) setStatus('anonymous'); return; }
        if (!cancelled) await loadMe();
      } catch { if (!cancelled) clear(); }
    })();
    return () => { cancelled = true; };
  }, [clear, loadMe]);

  const login = useCallback<AuthValue['login']>(async (email, password, officeSlug) => {
    const { data } = await request<any>('/auth/login', { method: 'POST', body: { email, password, tenantSlug: officeSlug || undefined }, anonymous: true });
    if (data?.tenantSelectionRequired) return { status: 'choose-office', offices: data.tenants };
    qc.clear();
    tokens.set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    setSessionExpired(false);
    await loadMe();
    return { status: 'ok' };
  }, [loadMe, qc]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    clear();
  }, [clear]);

  const switchOffice = useCallback(async (slug: string) => {
    const data = await api.post<{ accessToken: string; refreshToken: string }>('/auth/switch-tenant', { tenantSlug: slug });
    qc.clear();
    tokens.set(data);
    await loadMe();
  }, [loadMe, qc]);

  const value = useMemo<AuthValue>(() => ({
    status, me, sessionExpired, login, logout, switchOffice,
    permissions: me ? new Set(me.permissions) : NO_PERMISSIONS,
  }), [status, me, sessionExpired, login, logout, switchOffice]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
