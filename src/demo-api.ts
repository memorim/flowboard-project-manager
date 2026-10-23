import { z } from 'zod';
import initial from './demo-data.json';
import type { Dashboard, Member, Project, Status, Task } from './types';

const key = 'flowboard-browser-demo-v1';
const schema = z.object({ title: z.string().trim().min(3).max(120), description: z.string().trim().max(500).default(''),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).default('todo'), priority: z.enum(['low', 'medium', 'high']),
  projectId: z.number().int().positive(), assigneeId: z.number().int().positive().nullable(), dueDate: z.string().date() });
const load = (): Task[] => JSON.parse(localStorage.getItem(key) || JSON.stringify(initial.tasks));
const save = (tasks: Task[]) => localStorage.setItem(key, JSON.stringify(tasks));
const statuses = ['todo', 'in_progress', 'review', 'done'];

// ponytail: this demo is private to one browser; team access and persistence require the Express API.
export const demoApi = {
  dashboard: async (): Promise<Dashboard> => {
    const tasks = load();
    return { stats: { total: tasks.length, done: tasks.filter(t => t.status === 'done').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length, review: tasks.filter(t => t.status === 'review').length },
      projects: initial.projects.map(p => { const subset = tasks.filter(t => t.project_id === p.id); return { ...p, task_count: subset.length,
        done_count: subset.filter(t => t.status === 'done').length }; }), activity: initial.activity };
  },
  meta: async (): Promise<{ projects: Project[]; members: Member[] }> => structuredClone({ projects: initial.projects, members: initial.members }),
  tasks: async (search = ''): Promise<Task[]> => load().filter(t => `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())),
  createTask: async (body: object): Promise<Task> => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error('Проверьте данные задачи');
    const data = parsed.data;
    const project = initial.projects.find(p => p.id === data.projectId);
    const member = initial.members.find(m => m.id === data.assigneeId);
    if (!project || (data.assigneeId !== null && !member)) throw new Error('Проект или исполнитель не найден');
    const task: Task = { id: Math.max(0, ...load().map(t => t.id)) + 1, title: data.title, description: data.description, status: data.status,
      priority: data.priority, due_date: data.dueDate, project_id: project.id, project_name: project.name, project_color: project.color,
      assignee_id: member?.id ?? null, assignee_name: member?.name ?? null, initials: member?.initials ?? null, assignee_color: member?.color ?? null };
    save([...load(), task]); return task;
  },
  setStatus: async (id: number, status: Status) => {
    if (!statuses.includes(status)) throw new Error('Недопустимый статус');
    const tasks = load(); const task = tasks.find(t => t.id === id);
    if (!task) throw new Error('Задача не найдена');
    task.status = status; save(tasks); return { id, status };
  },
  deleteTask: async (id: number) => {
    const tasks = load();
    if (!tasks.some(t => t.id === id)) throw new Error('Задача не найдена');
    save(tasks.filter(t => t.id !== id));
  },
};
