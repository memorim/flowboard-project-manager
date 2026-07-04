import type { Dashboard, Member, Project, Status, Task } from './types';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || 'Ошибка запроса');
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  dashboard: () => request<Dashboard>('/api/dashboard'),
  meta: () => request<{ projects: Project[]; members: Member[] }>('/api/meta'),
  tasks: (search = '') => request<Task[]>(`/api/tasks${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  createTask: (body: object) => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  setStatus: (id: number, status: Status) => request(`/api/tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteTask: (id: number) => request(`/api/tasks/${id}`, { method: 'DELETE' }),
};

