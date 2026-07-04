import express, { type Express } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Db } from './db.js';

const taskSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).default(''),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high']),
  projectId: z.number().int().positive(),
  assigneeId: z.number().int().positive().nullable(),
  dueDate: z.string().date(),
});

export function createApp(db: Db = createDatabase()): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/api/dashboard', (_req, res) => {
    const stats = db.prepare(`
      SELECT COUNT(*) total,
        SUM(status = 'done') done,
        SUM(status = 'in_progress') inProgress,
        SUM(status = 'review') review
      FROM tasks
    `).get();
    const projects = db.prepare(`
      SELECT p.*, COUNT(t.id) task_count, SUM(t.status = 'done') done_count
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id GROUP BY p.id ORDER BY p.due_date
    `).all();
    const activity = db.prepare(`
      SELECT a.*, m.name, m.initials, m.color FROM activity a
      JOIN members m ON m.id = a.member_id ORDER BY a.created_at DESC LIMIT 5
    `).all();
    res.json({ stats, projects, activity });
  });

  app.get('/api/meta', (_req, res) => {
    const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
    const members = db.prepare('SELECT * FROM members ORDER BY name').all();
    res.json({ projects, members });
  });

  app.get('/api/tasks', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const project = Number(req.query.project || 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (status && status !== 'all') { conditions.push('t.status = $status'); params.$status = status; }
    if (project) { conditions.push('t.project_id = $project'); params.$project = project; }
    if (search) { conditions.push('(t.title LIKE $search OR t.description LIKE $search)'); params.$search = `%${search}%`; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const tasks = db.prepare(`
      SELECT t.*, p.name project_name, p.color project_color,
        m.name assignee_name, m.initials, m.color assignee_color
      FROM tasks t JOIN projects p ON p.id = t.project_id
      LEFT JOIN members m ON m.id = t.assignee_id
      ${where}
      ORDER BY CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.due_date
    `).all(params);
    res.json(tasks);
  });

  app.post('/api/tasks', (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Проверьте данные задачи', issues: parsed.error.flatten() });
    const task = parsed.data;
    const result = db.prepare(`
      INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, due_date)
      VALUES ($title, $description, $status, $priority, $projectId, $assigneeId, $dueDate)
    `).run({
      $title: task.title, $description: task.description, $status: task.status,
      $priority: task.priority, $projectId: task.projectId,
      $assigneeId: task.assigneeId, $dueDate: task.dueDate,
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), ...task });
  });

  app.patch('/api/tasks/:id/status', (req, res) => {
    const parsed = z.object({ status: z.enum(['todo', 'in_progress', 'review', 'done']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Недопустимый статус' });
    const result = db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(parsed.data.status, Number(req.params.id));
    if (!result.changes) return res.status(404).json({ message: 'Задача не найдена' });
    res.json({ id: Number(req.params.id), status: parsed.data.status });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ message: 'Задача не найдена' });
    res.status(204).end();
  });

  const dist = resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use((_req, res) => res.status(404).json({ message: 'Маршрут не найден' }));
  return app;
}
