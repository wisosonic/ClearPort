import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, request, setSessionLostHandler, tokens } from '@/lib/api-client';

const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => json(200, { success: true, data, meta });
const fail = (status: number, code: string, message = code) => json(status, { success: false, error: { code, message, details: [] } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  tokens.set(null);
  setSessionLostHandler(() => {});
});

describe('api client', () => {
  it('unwraps the envelope and sends the bearer token', async () => {
    tokens.set({ accessToken: 'A1', refreshToken: 'R1' });
    fetchMock.mockResolvedValueOnce(ok({ hello: 'world' }));
    expect(await api.get('/things', { page: 2, search: 'a b', empty: '', none: undefined })).toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/things?page=2&search=a+b'); // empty values are not sent
    expect(init.headers.Authorization).toBe('Bearer A1');
  });

  it('returns pages with their meta', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: 1 }], { page: 1, limit: 20, total: 41 }));
    const r = await api.list('/things');
    expect(r.data).toEqual([{ id: 1 }]);
    expect(r.meta.total).toBe(41);
  });

  it('turns an error envelope into an ApiError with the server code', async () => {
    fetchMock.mockResolvedValueOnce(fail(409, 'FILE_NOT_EDITABLE', 'File is closed'));
    await expect(api.post('/x', {})).rejects.toMatchObject({ status: 409, code: 'FILE_NOT_EDITABLE', message: 'File is closed' });
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('handles empty 204 responses', async () => {
    fetchMock.mockResolvedValueOnce(json(204, null));
    expect(await api.post('/auth/logout')).toBeNull();
  });

  it('refreshes an expired token once and replays the request', async () => {
    tokens.set({ accessToken: 'old', refreshToken: 'R1' });
    fetchMock
      .mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(ok({ accessToken: 'new', refreshToken: 'R2' }))
      .mockResolvedValueOnce(ok({ fine: true }));
    expect(await api.get('/clients')).toEqual({ fine: true });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/refresh');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ refreshToken: 'R1' });
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new');
    expect(tokens.refresh).toBe('R2'); // refresh tokens rotate
  });

  it('shares ONE refresh between simultaneous failing requests', async () => {
    tokens.set({ accessToken: 'old', refreshToken: 'R1' });
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.endsWith('/auth/refresh')) { refreshCalls++; await new Promise((r) => setTimeout(r, 20)); return ok({ accessToken: 'new', refreshToken: 'R2' }); }
      return init.headers.Authorization === 'Bearer new' ? ok({ url }) : fail(401, 'UNAUTHENTICATED');
    });
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c'), api.get('/d')]);
    expect(results).toHaveLength(4);
    expect(refreshCalls).toBe(1); // a second use of the same refresh token would revoke the whole session family
  });

  it('signs the user out when the session cannot be refreshed', async () => {
    const lost = vi.fn();
    setSessionLostHandler(lost);
    tokens.set({ accessToken: 'old', refreshToken: 'dead' });
    fetchMock.mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED')).mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED'));
    await expect(api.get('/clients')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledOnce();
    expect(tokens.access).toBeNull();
    expect(tokens.refresh).toBeNull();
  });

  it('does not sign the user out because the network blipped during refresh', async () => {
    const lost = vi.fn();
    setSessionLostHandler(lost);
    tokens.set({ accessToken: 'old', refreshToken: 'R1' });
    fetchMock.mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED')).mockRejectedValueOnce(new TypeError('network down'));
    await expect(api.get('/clients')).rejects.toBeInstanceOf(ApiError);
    expect(tokens.refresh).toBe('R1'); // still there for the next attempt
  });

  it('never tries to refresh a failed login, and sends no token for it', async () => {
    tokens.set({ accessToken: 'A', refreshToken: 'R' });
    fetchMock.mockResolvedValueOnce(fail(401, 'INVALID_CREDENTIALS', 'nope'));
    await expect(request('/auth/login', { method: 'POST', body: {}, anonymous: true })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('does not refresh on 403 (a permission refusal is not an expired session)', async () => {
    tokens.set({ accessToken: 'A', refreshToken: 'R' });
    fetchMock.mockResolvedValueOnce(fail(403, 'PERMISSION_DENIED'));
    await expect(api.get('/audit-logs')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
