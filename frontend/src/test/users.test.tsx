import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { tokens } from '@/lib/api-client';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });
const fail = (status: number, code: string, message: string) => res(status, { success: false, error: { code, message, details: [] } });

const R_OWNER = { id: 'r1', code: 'OWNER', name: 'Owner' };
const R_ACC = { id: 'r2', code: 'ACCOUNTANT', name: 'Accountant' };
const R_CUSTOM = { id: 'r3', code: 'SENIOR_CLERK', name: 'Senior clerk' };
const USERS = [
  { id: 'u1', email: 'sara@demo.test', firstName: 'Sara', lastName: 'Khoury', phone: null, isActive: true, lastLoginAt: '2026-11-04T08:00:00.000Z', joinedAt: '2026-10-01T00:00:00.000Z', branch: null, roles: [R_OWNER] },
  { id: 'u2', email: 'rami@demo.test', firstName: 'Rami', lastName: 'Haddad', phone: '+961 3 111222', isActive: true, lastLoginAt: null, joinedAt: '2026-10-02T00:00:00.000Z', branch: { id: 'b1', code: 'BEY', name: 'Beirut' }, roles: [R_ACC] },
  { id: 'u3', email: 'old@demo.test', firstName: 'Old', lastName: 'Timer', phone: null, isActive: false, lastLoginAt: null, joinedAt: '2026-09-01T00:00:00.000Z', branch: null, roles: [R_ACC] },
];
const ROLES = [
  { ...R_OWNER, description: 'Full tenant access', isSystem: true, permissionCodes: ['clients.view', 'users.manage', 'roles.manage'] },
  { ...R_ACC, description: 'Invoices and accounting', isSystem: true, permissionCodes: ['clients.view', 'invoices.view'] },
  { ...R_CUSTOM, description: 'Custom clerk', isSystem: false, permissionCodes: ['clients.view'] },
];
const PERMS = [
  { id: 'p1', code: 'clients.view', description: 'View clients and business parties' },
  { id: 'p2', code: 'invoices.view', description: 'View invoices' },
  { id: 'p3', code: 'users.manage', description: 'Manage users and role assignments' },
  { id: 'p4', code: 'roles.manage', description: 'Manage roles and permissions' },
];
const BRANCHES = [{ id: 'b1', code: 'BEY', name: 'Beirut', isActive: true }, { id: 'b2', code: 'OLD', name: 'Closed branch', isActive: false }];

let permissions: string[];
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['users.manage', 'roles.manage', 'clients.view', 'invoices.view'];
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [path, qs = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: new URLSearchParams(qs), body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'sara@demo.test', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/users' && method === 'GET') return ok(USERS, { page: 1, limit: 20, total: USERS.length });
    if (path === '/roles' && method === 'GET') return ok(ROLES);
    if (path === '/permissions') return ok(PERMS);
    if (path === '/branches') return ok(BRANCHES);
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = () => render(<App router={createTestRouter('/users') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('users', () => {
  it('lists users with roles, branch and last sign-in, marking the current user', async () => {
    mount();
    const row = (await screen.findByText('Rami Haddad')).closest('tr')!;
    expect(within(row).getByText('Accountant')).toBeInTheDocument();
    expect(within(row).getByText('Beirut')).toBeInTheDocument();
    expect(within(row).getByText('Never')).toBeInTheDocument();
    const me = screen.getAllByText('Sara Khoury').find((el) => el.closest('tr'))!.closest('tr')!;
    expect(within(me).getByText('You')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/users')!.query.get('isActive')).toBe('true');
  });

  it('cannot deactivate yourself, but can deactivate and reactivate others', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByText('Rami Haddad');
    expect(screen.queryByRole('button', { name: 'Deactivate Sara Khoury' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deactivate Rami Haddad' }));
    await waitFor(() => expect(sent('PATCH', '/users/u2/status')).toHaveLength(1));
    expect(sent('PATCH', '/users/u2/status')[0].body).toEqual({ isActive: false });
    await user.click(screen.getByRole('button', { name: 'Reactivate Old Timer' }));
    await waitFor(() => expect(sent('PATCH', '/users/u3/status')).toHaveLength(1));
    expect(sent('PATCH', '/users/u3/status')[0].body).toEqual({ isActive: true });
  });

  it('shows the server refusal, e.g. the last owner', async () => {
    failNext['PATCH /users/u2/status'] = fail(409, 'LAST_OWNER', 'The office must keep at least one active Owner');
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deactivate Rami Haddad' }));
    expect(await screen.findByText('The office must keep at least one active Owner')).toBeInTheDocument();
  });

  it('adds a user: needs e-mail, names and a role; the password is optional but must be long enough', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add user' }));
    const form = (await screen.findByRole('heading', { name: 'Add user', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Enter a valid email address')).toBeInTheDocument();
    expect(within(form).getByText('Enter a first name')).toBeInTheDocument();
    expect(within(form).getByText('Choose at least one role')).toBeInTheDocument();
    expect(sent('POST', '/users')).toHaveLength(0);

    await user.type(within(form).getByLabelText('Email'), 'new@demo.test');
    await user.type(within(form).getByLabelText('First name'), 'Nour');
    await user.type(within(form).getByLabelText('Last name'), 'Khalil');
    await user.type(within(form).getByLabelText('Password'), 'short');
    await user.click(within(form).getByRole('checkbox', { name: /Accountant/ }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Use at least 10 characters')).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Password'));
    await user.type(within(form).getByLabelText('Password'), 'long-enough-pass');
    await waitFor(() => expect(within(within(form).getByLabelText('Branch')).getByRole('option', { name: 'Beirut' })).toBeInTheDocument());
    expect(within(within(form).getByLabelText('Branch')).queryByRole('option', { name: 'Closed branch' })).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('Branch'), 'b1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/users')).toHaveLength(1));
    expect(sent('POST', '/users')[0].body).toEqual({ email: 'new@demo.test', firstName: 'Nour', lastName: 'Khalil', roleIds: ['r2'], password: 'long-enough-pass', branchId: 'b1' });
  });

  it('shows the server message, e.g. when the person is already a member', async () => {
    failNext['POST /users'] = fail(409, 'USER_ALREADY_MEMBER', 'This user already belongs to your office');
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add user' }));
    const form = (await screen.findByRole('heading', { name: 'Add user', level: 2 })).closest('form')!;
    await user.type(within(form).getByLabelText('Email'), 'rami@demo.test');
    await user.type(within(form).getByLabelText('First name'), 'R');
    await user.type(within(form).getByLabelText('Last name'), 'H');
    await user.click(within(form).getByRole('checkbox', { name: /Accountant/ }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This user already belongs to your office')).toBeInTheDocument();
  });

  it('edits roles and branch without touching the shared profile', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Rami Haddad' }));
    const form = (await screen.findByRole('heading', { name: 'Edit user', level: 2 })).closest('form')!;
    expect(within(form).queryByLabelText('Email')).not.toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: /Accountant/ })).toBeChecked();
    await user.click(within(form).getByRole('checkbox', { name: /Senior clerk/ }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/users/u2')).toHaveLength(1));
    expect(sent('PATCH', '/users/u2')[0].body).toEqual({ branchId: 'b1', roleIds: ['r2', 'r3'] }); // no name or phone: unchanged
  });

  it('sends the profile only when it changed', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Rami Haddad' }));
    const form = (await screen.findByRole('heading', { name: 'Edit user', level: 2 })).closest('form')!;
    await user.clear(within(form).getByLabelText('Phone'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/users/u2')).toHaveLength(1));
    expect(sent('PATCH', '/users/u2')[0].body).toMatchObject({ firstName: 'Rami', lastName: 'Haddad', phone: null });
  });

  it('is refused for users without users.manage nor roles.manage', async () => {
    permissions = ['clients.view'];
    mount();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });

  it('explains when only roles.manage is held', async () => {
    permissions = ['roles.manage'];
    mount();
    expect(await screen.findByText(/needs the "Manage users" permission/)).toBeInTheDocument();
  });
});

describe('roles', () => {
  const openRoles = async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Roles' }));
    return user;
  };

  it('lists roles as built-in or custom, with permission counts, and shows the permissions on request', async () => {
    const user = await openRoles();
    const owner = (await screen.findByText('Owner', { selector: 'h2' })).closest('.p-5')!;
    expect(within(owner as HTMLElement).getByText('Built-in')).toBeInTheDocument();
    expect(within(owner as HTMLElement).getByText('3 permissions')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('1 permission')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show permissions Accountant' }));
    expect(await screen.findByText('invoices.view')).toBeInTheDocument();
  });

  it('only custom roles can be edited, and only with roles.manage', async () => {
    await openRoles();
    await screen.findByText('Senior clerk');
    expect(screen.queryByRole('button', { name: 'Edit Owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Senior clerk' })).toBeInTheDocument();
  });

  it('creates a custom role with a valid code and chosen permissions', async () => {
    const user = await openRoles();
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const form = (await screen.findByRole('heading', { name: 'New role', level: 3 })).closest('form')!;
    await user.type(within(form).getByLabelText('Code'), '1bad');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Start with a letter/)).toBeInTheDocument();
    expect(sent('POST', '/roles')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Code'));
    await user.type(within(form).getByLabelText('Code'), 'billing_clerk');
    await user.type(within(form).getByLabelText('Name'), 'Billing clerk');
    await user.click(await within(form).findByRole('checkbox', { name: /invoices.view/ }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/roles')).toHaveLength(1));
    expect(sent('POST', '/roles')[0].body).toEqual({ code: 'billing_clerk', name: 'Billing clerk', permissionCodes: ['invoices.view'] });
  });

  it('cannot grant a permission the user does not hold', async () => {
    permissions = ['users.manage', 'roles.manage', 'clients.view'];
    const user = await openRoles();
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const form = (await screen.findByRole('heading', { name: 'New role', level: 3 })).closest('form')!;
    expect(await within(form).findByRole('checkbox', { name: /invoices.view/ })).toBeDisabled();
    expect(within(form).getByRole('checkbox', { name: /clients.view/ })).toBeEnabled();
  });

  it('replaces a custom role\'s permissions, and shows the server refusal', async () => {
    failNext['PUT /roles/r3/permissions'] = fail(403, 'PRIVILEGE_ESCALATION', 'You cannot grant permissions you do not hold: x');
    const user = await openRoles();
    await user.click(await screen.findByRole('button', { name: 'Edit Senior clerk' }));
    const form = (await screen.findByRole('heading', { name: 'Permissions of Senior clerk' })).closest('form')!;
    expect(await within(form).findByRole('checkbox', { name: /clients.view/ })).toBeChecked();
    await user.click(within(form).getByRole('checkbox', { name: /invoices.view/ }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/cannot grant permissions you do not hold/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/roles/r3/permissions')).toHaveLength(2));
    expect(sent('PUT', '/roles/r3/permissions')[1].body).toEqual({ permissionCodes: ['clients.view', 'invoices.view'] });
  });

  it('is read-only with only users.manage', async () => {
    permissions = ['users.manage'];
    await openRoles();
    await screen.findByText('Senior clerk');
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.getByText(/needs the "Manage roles" permission/)).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the page in Arabic', async () => {
    setLocale('ar');
    mount();
    expect(await screen.findByRole('heading', { name: 'المستخدمون والأدوار' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'الأدوار' })).toBeInTheDocument();
    expect(await screen.findByText('Rami Haddad')).toBeInTheDocument();
  });
});
