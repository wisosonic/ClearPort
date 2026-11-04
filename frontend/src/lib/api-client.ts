/**
 * The only place that talks to the backend. Handles the response envelope, the bearer token, and
 * transparent token refresh (single-flight: many requests failing at once trigger ONE refresh).
 *
 * Storage: the access token lives only in memory. The refresh token is kept in localStorage so a
 * reload or a second tab stays signed in; the trade-off (readable by script on this origin) is why the
 * backend rotates refresh tokens and revokes the whole family on reuse.
 */
export const API_BASE = '/api/v1';
const REFRESH_KEY = 'clearport.refresh';

export interface PageMeta { page: number; limit: number; total: number; [k: string]: unknown }
export interface Paged<T> { data: T[]; meta: PageMeta }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown[] = []) {
    super(message);
  }
}

interface Session { accessToken: string; refreshToken: string }

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: () => void = () => {};

export const tokens = {
  get access() { return accessToken; },
  get refresh() { try { return localStorage.getItem(REFRESH_KEY); } catch { return null; } },
  set(s: Session | null) {
    accessToken = s?.accessToken ?? null;
    try { if (s) localStorage.setItem(REFRESH_KEY, s.refreshToken); else localStorage.removeItem(REFRESH_KEY); } catch { /* storage unavailable */ }
  },
};

/** Called when the session can no longer be refreshed (expired, revoked, reuse detected). */
export function setSessionLostHandler(fn: () => void) { onSessionLost = fn; }

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function toError(res: Response, body: any): ApiError {
  const e = body?.error;
  return new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? res.statusText ?? 'Request failed', e?.details ?? []);
}

/** Exchanges the refresh token for a new pair. Resolves false when the session is gone. */
export function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  const rt = tokens.refresh;
  if (!rt) return Promise.resolve(false);
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      const body = await parse(res);
      if (!res.ok || !body?.data?.accessToken) { tokens.set(null); return false; }
      tokens.set(body.data);
      return true;
    } catch {
      return false; // network trouble is not a reason to sign the user out
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** skip the bearer token and the refresh-and-retry logic (login, refresh) */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function url(path: string, query?: RequestOptions['query']) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
}

async function send(path: string, o: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!o.anonymous && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(url(path, o.query), { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal });
}

/** Raw envelope: `{ data, meta? }`. */
export async function request<T = unknown>(path: string, o: RequestOptions = {}): Promise<{ data: T; meta?: PageMeta }> {
  let res = await send(path, o);
  if (res.status === 401 && !o.anonymous) {
    if (await refreshSession()) res = await send(path, o);
    else { onSessionLost(); }
  }
  const body = await parse(res);
  if (!res.ok) throw toError(res, body);
  return { data: (body?.data ?? null) as T, meta: body?.meta };
}

export const api = {
  get: async <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => (await request<T>(path, { query, signal })).data,
  list: async <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal): Promise<Paged<T>> => {
    const r = await request<T[]>(path, { query, signal });
    return { data: r.data ?? [], meta: r.meta ?? { page: 1, limit: r.data?.length ?? 0, total: r.data?.length ?? 0 } };
  },
  post: async <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) => (await request<T>(path, { ...o, method: 'POST', body: body ?? {} })).data,
  patch: async <T>(path: string, body: unknown) => (await request<T>(path, { method: 'PATCH', body })).data,
  put: async <T>(path: string, body: unknown) => (await request<T>(path, { method: 'PUT', body })).data,
  delete: async <T>(path: string) => (await request<T>(path, { method: 'DELETE' })).data,
};
