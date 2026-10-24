import express, { type Express } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Db } from './db.js';
import { taskSchema } from '../src/task-schema.js';

export function createApp(db: Db = createDatabase()): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const actor = (req: express.Request) => {
    const id = Number(req.get('X-Demo-Actor') || 4);
    return db.prepare('SELECT * FROM members WHERE id=?').get(id) as { id: number; name: string; role: string; initials: string; color: string } | undefined;
  };
  const record = (req: express.Request, text: string) => db.prepare('INSERT INTO activity(text,member_id,created_at) VALUES (?,?,?)').run(text, actor(req)?.id || 4, new Date().toISOString());
  app.get('/api/session', (req, res) => res.json({ mode: 'local', user: actor(req) || null }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/api/dashboard', (_req, res) => {
    const stats = db.prepare(`
      SELECT COUNT(*) total,
        COALESCE(SUM(status = 'done'),0) done,
        COALESCE(SUM(status = 'in_progress'),0) inProgress,
        COALESCE(SUM(status = 'review'),0) review
      FROM tasks
    `).get();
    const projects = db.prepare(`
      SELECT p.id,p.name,p.client,p.color,p.due_date,COUNT(t.id) task_count,COALESCE(SUM(t.status = 'done'),0) done_count,
      CASE WHEN COUNT(t.id)=0 THEN 0 ELSE ROUND(100.0*SUM(t.status='done')/COUNT(t.id)) END progress
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
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(task.projectId)) return res.status(404).json({ message: 'Проект не найден' });
    if (task.assigneeId !== null && !db.prepare('SELECT id FROM members WHERE id = ?').get(task.assigneeId)) return res.status(404).json({ message: 'Исполнитель не найден' });
    const result = db.prepare(`
      INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, due_date)
      VALUES ($title, $description, $status, $priority, $projectId, $assigneeId, $dueDate)
    `).run({
      $title: task.title, $description: task.description, $status: task.status,
      $priority: task.priority, $projectId: task.projectId,
      $assigneeId: task.assigneeId, $dueDate: task.dueDate,
    });
    record(req, `создал(а) задачу «${task.title}»`);
    res.status(201).json({ id: Number(result.lastInsertRowid), ...task });
  });

  app.patch('/api/tasks/:id/status', (req, res) => {
    const parsed = z.object({ status: z.enum(['todo', 'in_progress', 'review', 'done']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Недопустимый статус' });
    const old = db.prepare('SELECT title,status FROM tasks WHERE id=?').get(Number(req.params.id)) as { title: string; status: string } | undefined;
    if (!old) return res.status(404).json({ message: 'Задача не найдена' });
    const result = db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(parsed.data.status, Number(req.params.id));
    if (!result.changes) return res.status(404).json({ message: 'Задача не найдена' });
    if (old.status !== parsed.data.status) record(req, `изменил(а) статус «${old.title}» на ${parsed.data.status}`);
    res.json({ id: Number(req.params.id), status: parsed.data.status });
  });
  app.patch('/api/tasks/:id', (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Проверьте данные задачи' });
    const t = parsed.data;
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(t.projectId) || (t.assigneeId !== null && !db.prepare('SELECT id FROM members WHERE id=?').get(t.assigneeId))) return res.status(404).json({ message: 'Проект или исполнитель не найден' });
    const result = db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,project_id=?,assignee_id=?,due_date=? WHERE id=?').run(t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate,Number(req.params.id));
    if (!result.changes) return res.status(404).json({ message: 'Задача не найдена' });
    record(req, `отредактировал(а) задачу «${t.title}»`); res.json({ id: Number(req.params.id), ...t });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const old = db.prepare('SELECT title FROM tasks WHERE id=?').get(Number(req.params.id)) as { title: string } | undefined;
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ message: 'Задача не найдена' });
    record(req, `удалил(а) задачу «${old?.title}»`);
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
