import initial from './demo-data.json';
import { taskSchema } from './task-schema';
import type {
  Activity,
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
const key = 'flowboard-browser-demo-v2';
type Data = {
  tasks: Task[];
  activity: Activity[];
  history?: Array<HistoryEntry & { task_id: number }>;
  requests?: Record<string, { payload: string; result: Task }>;
};
const current = () =>
  initial.members.find((m) => m.id === Number(localStorage.getItem('flowboard-actor') || 4)) ||
  initial.members[0];
const dateFromSample = (date: string) =>
  new Date(Date.now() + (new Date(date).getTime() - new Date('2026-07-04').getTime()))
    .toISOString()
    .slice(0, 10);
const projects = () =>
  initial.projects.map((p) => ({ ...p, due_date: dateFromSample(p.due_date) }));
const load = (): Data => {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const data = JSON.parse(stored);
      if (!Array.isArray(data.tasks) || !Array.isArray(data.activity)) throw new Error();
      return { ...data, tasks: data.tasks.map((t: Task) => ({ ...t, version: t.version || 1 })) };
    }
    const legacy = localStorage.getItem('flowboard-browser-demo-v1');
    return {
      tasks: (legacy
        ? JSON.parse(legacy)
        : initial.tasks.map((t) => ({ ...t, due_date: dateFromSample(t.due_date) }))
      ).map((t: Task) => ({ ...t, version: t.version || 1 })),
      activity: [],
    };
  } catch {
    throw new Error(
      'Данные браузера повреждены. Они сохранены без изменений; перед сбросом экспортируйте localStorage.',
    );
  }
};
const save = (data: Data) => localStorage.setItem(key, JSON.stringify(data));
const event = (data: Data, text: string) => {
  const user = current();
  data.activity.unshift({
    id: Math.max(0, ...data.activity.map((a) => a.id)) + 1,
    text,
    name: user.name,
    initials: user.initials,
    color: user.color,
    created_at: new Date().toISOString(),
  });
};
const snapshot = (t: Task) => ({
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  projectId: t.project_id,
  assigneeId: t.assignee_id,
  dueDate: t.due_date,
  deletedAt: t.deleted_at || null,
});
function history(data: Data, before: Task | null, after: Task, action: string) {
  data.history ??= [];
  data.history.push({
    id: data.history.length + 1,
    task_id: after.id,
    action,
    version: after.version,
    created_at: new Date().toISOString(),
    actor_name: current().name,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
  });
}
function makeTask(body: object, id: number, version = 1): Task {
  const parsed = taskSchema.safeParse(body);
  if (!parsed.success) throw new Error('Проверьте данные задачи');
  const t = parsed.data,
    p = initial.projects.find((p) => p.id === t.projectId),
    m = initial.members.find((m) => m.id === t.assigneeId);
  if (!p || (t.assigneeId !== null && !m)) throw new Error('Проект или исполнитель не найден');
  return {
    id,
    version,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    due_date: t.dueDate,
    project_id: p.id,
    project_name: p.name,
    project_color: p.color,
    assignee_id: m?.id ?? null,
    assignee_name: m?.name ?? null,
    initials: m?.initials ?? null,
    assignee_color: m?.color ?? null,
  };
}
// ponytail: localStorage is private to one browser; the hosted D1 API provides shared persistence.
export const demoApi = {
  session: async (): Promise<Session> => ({
    mode: 'browser',
    user: current() as Member | null,
    workspace: { id: 1, name: 'Демо в браузере', is_public: 1, access_role: 'owner' },
    canWrite: true,
  }),
  workspaces: async (): Promise<Workspace[]> => [
    { id: 1, name: 'Демо в браузере', is_public: 1, access_role: 'owner' },
  ],
  createWorkspace: async (_name: string): Promise<Workspace> => {
    throw new Error('Команды доступны в серверной версии');
  },
  createProject: async (_name: string) => {
    throw new Error('Проекты создаются в серверной версии');
  },
  invite: async (_role: string): Promise<{ token: string; expiresAt: string }> => {
    throw new Error('Приглашения доступны в серверной версии');
  },
  acceptInvite: async (_token: string): Promise<{ workspaceId: number }> => {
    throw new Error('Приглашения доступны в серверной версии');
  },
  changeRole: async (_id: number, _role: string) => {
    throw new Error('Роли доступны в серверной версии');
  },
  removeMember: async (_id: number) => {
    throw new Error('Команды доступны в серверной версии');
  },
  exportWorkspace: async (): Promise<object> => load(),
  dashboard: async (): Promise<Dashboard> => {
    const data = load(),
      tasks = data.tasks.filter((t) => !t.deleted_at),
      activity = data.activity;
    return {
      stats: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        inProgress: tasks.filter((t) => t.status === 'in_progress').length,
        review: tasks.filter((t) => t.status === 'review').length,
      },
      projects: projects().map((p) => {
        const subset = tasks.filter((t) => t.project_id === p.id),
          done = subset.filter((t) => t.status === 'done').length;
        return {
          ...p,
          task_count: subset.length,
          done_count: done,
          progress: subset.length ? Math.round((done / subset.length) * 100) : 0,
        };
      }),
      activity: activity.slice(0, 10),
    };
  },
  meta: async (): Promise<{ projects: Project[]; members: Member[] }> =>
    structuredClone({
      projects: projects(),
      members: initial.members.map((m) => ({
        ...m,
        task_count: load().tasks.filter((t) => !t.deleted_at && t.assignee_id === m.id).length,
      })),
    }),
  history: async (id: number): Promise<HistoryEntry[]> => {
    const data = load();
    if (!data.tasks.some((t) => t.id === id)) throw new Error('Задача не найдена');
    return (data.history || [])
      .filter((h) => h.task_id === id)
      .sort((a, b) => b.version - a.version)
      .slice(0, 100);
  },
  trashPage: async (filters: TaskFilters = {}): Promise<Page<Task>> => {
    const items = load()
      .tasks.filter((t) => t.deleted_at)
      .filter(
        (t) =>
          !filters.search ||
          `${t.title} ${t.description}`.toLowerCase().includes(filters.search.toLowerCase().trim()),
      );
    const limit = filters.limit || 40,
      offset = filters.offset || 0;
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  },
  restoreTask: async (id: number, version: number) => {
    const data = load(),
      task = data.tasks.find((t) => t.id === id && t.deleted_at);
    if (!task) throw new Error('Задача не найдена');
    if (task.version !== version) throw new Error('Задача уже изменена');
    const before = structuredClone(task);
    task.deleted_at = null;
    task.version++;
    history(data, before, task, 'restored');
    event(data, `восстановил(а) задачу «${task.title}»`);
    save(data);
    return task;
  },
  taskPage: async (filters: TaskFilters = {}): Promise<Page<Task>> => {
    const items = load()
      .tasks.filter((t) => !t.deleted_at)
      .filter(
        (t) =>
          (!filters.search ||
            `${t.title} ${t.description}`
              .toLowerCase()
              .includes(filters.search.toLowerCase().trim())) &&
          (!filters.project || t.project_id === Number(filters.project)) &&
          (!filters.assignee ||
            (filters.assignee === 'none'
              ? t.assignee_id === null
              : t.assignee_id === Number(filters.assignee))) &&
          (!filters.status || t.status === filters.status),
      )
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);
    const limit = filters.limit || 40,
      offset = filters.offset || 0;
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  },
  tasks: async (search = ''): Promise<Task[]> =>
    load()
      .tasks.filter((t) => !t.deleted_at)
      .filter((t) => `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())),
  createTask: async (body: object, key?: string): Promise<Task> => {
    const parsed = taskSchema.safeParse(body);
    if (!parsed.success) throw new Error('Проверьте данные задачи');
    const data = load(),
      payload = JSON.stringify(parsed.data),
      scope = current().id + ':' + key;
    const previous = key ? data.requests?.[scope] : undefined;
    if (previous) {
      if (previous.payload !== payload) throw new Error('Ключ уже использован с другими данными');
      return structuredClone(previous.result);
    }
    const t = makeTask(body, Math.max(0, ...data.tasks.map((t) => t.id)) + 1);
    data.tasks.push(t);
    history(data, null, t, 'created');
    if (key) {
      data.requests ??= {};
      data.requests[scope] = { payload, result: t };
    }
    event(data, `создал(а) задачу «${t.title}»`);
    save(data);
    return t;
  },
  updateTask: async (id: number, body: object) => {
    const data = load(),
      index = data.tasks.findIndex((t) => t.id === id && !t.deleted_at);
    if (index < 0) throw new Error('Задача не найдена');
    const { version, ...fields } = body as Record<string, unknown>;
    if (version !== data.tasks[index].version)
      throw new Error('Задача уже изменена. Обновите список.');
    const t = makeTask(fields, id, data.tasks[index].version + 1);
    history(data, data.tasks[index], t, 'updated');
    data.tasks[index] = t;
    event(data, `отредактировал(а) задачу «${t.title}»`);
    save(data);
    return t;
  },
  setStatus: async (id: number, status: Status, version: number) => {
    if (!['todo', 'in_progress', 'review', 'done'].includes(status))
      throw new Error('Недопустимый статус');
    const data = load(),
      t = data.tasks.find((t) => t.id === id && !t.deleted_at);
    if (!t) throw new Error('Задача не найдена');
    if (version !== t.version) throw new Error('Задача уже изменена. Обновите список.');
    if (t.status !== status) {
      const before = structuredClone(t);
      t.status = status;
      t.version++;
      history(data, before, t, 'updated');
      event(data, `изменил(а) статус «${t.title}» на ${status}`);
      save(data);
    }
    return { id, status };
  },
  deleteTask: async (id: number, version: number) => {
    const data = load(),
      t = data.tasks.find((t) => t.id === id && !t.deleted_at);
    if (!t) throw new Error('Задача не найдена');
    if (version !== t.version) throw new Error('Задача уже изменена. Обновите список.');
    const before = structuredClone(t);
    t.deleted_at = new Date().toISOString();
    t.version++;
    history(data, before, t, 'deleted');
    event(data, `удалил(а) задачу «${t.title}»`);
    save(data);
  },
};
