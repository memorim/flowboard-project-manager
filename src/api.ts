import { demoApi } from './demo-api';
import type {
  Dashboard,
  Member,
  Project,
  Status,
  Task,
  Workspace,
  Session,
  Page,
  TaskFilters,
  HistoryEntry,
} from './types';
export const workspaceId = () => Number(localStorage.getItem('flowboard-workspace') || 1);
export const selectWorkspace = (id: number) =>
  localStorage.setItem('flowboard-workspace', String(id));
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(
    url + (url.includes('?') ? '&' : '?') + 'workspace=' + workspaceId(),
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Demo-Actor': localStorage.getItem('flowboard-actor') || '4',
        ...options?.headers,
      },
    },
  );
  if (!response.ok) {
    const e = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      (e?.message || 'Ошибка запроса') +
        (response.status >= 500 && response.headers.get('X-Request-Id')
          ? ' Код обращения: ' + response.headers.get('X-Request-Id')
          : ''),
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const serverApi = {
  directory: () =>
    request<{ enabled: boolean; configured: boolean; baseUrl: string }>(
      '/api/integrations/directory',
    ),
  createDirectoryToken: (password: string, role: string) =>
    request<{ token: string }>('/api/integrations/directory/token', {
      method: 'POST',
      body: JSON.stringify({ password, role }),
    }),
  revokeDirectoryToken: () => request('/api/integrations/directory/token', { method: 'DELETE' }),
  billing: () =>
    request<{
      enabled: boolean;
      testMode: boolean;
      amountCents: number;
      validUntil: number | null;
      payments: {
        id: string;
        amount_cents: number;
        status: string;
        created_at: number;
        is_test: number;
      }[];
    }>('/api/billing'),
  checkout: (key: string) =>
    request<{ id: string; status: string; confirmationUrl: string | null }>(
      '/api/billing/checkout',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ plan: 'team' }),
      },
    ),
  refreshPayment: (id: string) =>
    request('/api/billing/payments/' + id + '/refresh', { method: 'POST' }),
  authConfig: () =>
    request<{ registration: boolean; passwordReset: boolean; mfa: boolean }>('/api/auth/config'),
  register: (name: string, email: string, password: string) =>
    request<{ message: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),
  forgotPassword: (email: string) =>
    request<{ message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  verifyEmail: (token: string, password: string) =>
    request('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  resetPassword: (token: string, password: string) =>
    request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  verifyMfa: (challenge: string, code: string) =>
    request('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ challenge, code }) }),
  account: () =>
    request<{ id: number; name: string; email: string; mfaEnabled: boolean }>('/api/auth/account'),
  sessions: () =>
    request<
      {
        session_id: string;
        created_at: number;
        expires_at: number;
        device: string;
        current: boolean;
      }[]
    >('/api/auth/sessions'),
  revokeSession: (id: string) => request('/api/auth/sessions/' + id, { method: 'DELETE' }),
  revokeOtherSessions: () => request('/api/auth/sessions/revoke-others', { method: 'POST' }),
  setupMfa: (password: string) =>
    request<{ secret: string; uri: string; qr: string }>('/api/auth/mfa/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  enableMfa: (code: string) =>
    request<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  disableMfa: (password: string, code: string) =>
    request('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password, code }) }),
  login: (email: string, password: string) =>
    request<{ ok?: boolean; mfaRequired?: boolean; challenge?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  session: () => request<Session>('/api/session'),
  workspaces: () => request<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string) =>
    request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  createProject: (name: string) =>
    request('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  invite: (role: string) =>
    request<{ token: string; expiresAt: string }>('/api/invitations', {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),
  inviteByEmail: (role: string, email: string) =>
    request<{ email: string; expiresAt: string }>('/api/invitations/email', {
      method: 'POST',
      body: JSON.stringify({ role, email }),
    }),
  acceptInvite: (token: string) =>
    request<{ workspaceId: number }>('/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  changeRole: (id: number, role: string) =>
    request(`/api/members/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (id: number) => request(`/api/members/${id}`, { method: 'DELETE' }),
  exportWorkspace: () => request<object>('/api/export'),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  meta: () => request<{ projects: Project[]; members: Member[] }>('/api/meta'),
  history: (id: number) => request<HistoryEntry[]>(`/api/tasks/${id}/history`),
  restoreTask: (id: number, version: number) =>
    request(`/api/tasks/${id}/restore`, { method: 'PATCH', body: JSON.stringify({ version }) }),
  trashPage: (filters: TaskFilters = {}) =>
    request<Page<Task>>(
      '/api/tasks/trash?' +
        new URLSearchParams(
          Object.entries(filters)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)]),
        ),
    ),
  taskPage: (filters: TaskFilters = {}) =>
    request<Page<Task>>(
      '/api/tasks/page?' +
        new URLSearchParams(
          Object.entries(filters)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)]),
        ),
    ),
  tasks: (search = '') =>
    request<Task[]>('/api/tasks' + (search ? '?search=' + encodeURIComponent(search) : '')),
  createTask: (body: object, key?: string) =>
    request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: key ? { 'Idempotency-Key': key } : undefined,
    }),
  updateTask: (id: number, body: object) =>
    request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  setStatus: (id: number, status: Status, version: number) =>
    request(`/api/tasks/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, version }),
    }),
  deleteTask: (id: number, version: number) =>
    request(`/api/tasks/${id}`, { method: 'DELETE', body: JSON.stringify({ version }) }),
};
export const api = import.meta.env.VITE_DEMO_MODE === 'true' ? demoApi : serverApi;
