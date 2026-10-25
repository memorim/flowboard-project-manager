import { z } from 'zod';
import { taskSchema } from './task-schema.js';
import {
  body,
  parse,
  json,
  operationKey,
  replay,
  HttpError,
  type Statement,
  type WriteScope,
} from './flow-http.js';
const versionSchema = z.number().int().positive();
const editSchema = taskSchema.extend({ version: versionSchema });
const statusSchema = z
  .object({ status: taskSchema.shape.status.unwrap(), version: versionSchema })
  .strict();

export async function taskWrites({ req, db, actor, workspace, limited, event }: WriteScope) {
  const path = new URL(req.url).pathname,
    method = req.method;
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const match = path.match(/^\/api\/tasks\/(\d+)(\/status|\/restore)?$/),
    id = Number(match?.[1]);
  if (path === '/api/tasks' && method === 'POST') {
    const t = parse(taskSchema, await body(req)),
      payload = JSON.stringify(t),
      key = operationKey(req, actor.id + ':' + workspace);
    await references(t.projectId, t.assigneeId);
    if (key) {
      const previous = await q(
        'SELECT request_payload,create_result FROM tasks WHERE request_key=?',
        key,
      ).first<{ request_payload: string; create_result: string }>();
      if (previous) return replay(previous, payload);
    }
    if (limited) throw new HttpError(429, 'До 30 изменений в минуту. Повторите позднее.');
    const statements = [
      q(
        'INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date,request_key,request_payload,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING',
        t.title,
        t.description,
        t.status,
        t.priority,
        t.projectId,
        t.assigneeId,
        t.dueDate,
        key,
        key ? payload : null,
        actor.id,
      ),
      event(`создал(а) задачу «${t.title}»`, true),
    ];
    if (key)
      statements.push(
        q(
          "UPDATE tasks SET create_result=json_set(?, '$.id',id,'$.version',1) WHERE request_key=? AND create_result IS NULL",
          payload,
          key,
        ),
      );
    const [result] = await db.batch(statements);
    if (key) {
      const saved = await q(
        'SELECT request_payload,create_result FROM tasks WHERE request_key=?',
        key,
      ).first<{ request_payload: string; create_result: string }>();
      if (!saved) throw new HttpError(503, 'Не удалось сохранить результат операции');
      return replay(saved, payload);
    }
    return json({ id: result.meta.last_row_id, ...t, version: 1 }, 201);
  }
  if (match && ['PATCH', 'DELETE'].includes(method)) {
    const old = await q(
      'SELECT t.id,t.title,t.status,t.version,t.deleted_at FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=? AND ' +
        (match[2] === '/restore' ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL'),
      id,
      workspace,
    ).first<{
      id: number;
      title: string;
      status: string;
      version: number;
      deleted_at: string | null;
    }>();
    if (!old) throw new HttpError(404, 'Задача не найдена');
    const input = await body(req),
      expected = parse(z.object({ version: versionSchema }).passthrough(), input).version;
    if (expected !== old.version) return conflict();
    let statement: Statement, text: string;
    if (method === 'DELETE') {
      parse(z.object({ version: versionSchema }).strict(), input);
      statement = q(
        'UPDATE tasks SET deleted_at=?,version=version+1,changed_by=? WHERE id=? AND version=? AND deleted_at IS NULL',
        new Date().toISOString(),
        actor.id,
        id,
        expected,
      );
      text = `удалил(а) задачу «${old.title}»`;
    } else if (match[2] === '/restore') {
      parse(z.object({ version: versionSchema }).strict(), input);
      statement = q(
        'UPDATE tasks SET deleted_at=NULL,version=version+1,changed_by=? WHERE id=? AND version=? AND deleted_at IS NOT NULL',
        actor.id,
        id,
        expected,
      );
      text = `восстановил(а) задачу «${old.title}»`;
    } else if (match[2]) {
      const t = parse(statusSchema, input);
      if (old.status === t.status) return json({ id, status: t.status, version: old.version });
      statement = q(
        'UPDATE tasks SET status=?,version=version+1,changed_by=? WHERE id=? AND version=?',
        t.status,
        actor.id,
        id,
        expected,
      );
      text = `изменил(а) статус «${old.title}» на ${t.status}`;
    } else {
      const t = parse(editSchema, input);
      await references(t.projectId, t.assigneeId);
      statement = q(
        'UPDATE tasks SET title=?,description=?,status=?,priority=?,project_id=?,assignee_id=?,due_date=?,version=version+1,changed_by=? WHERE id=? AND version=?',
        t.title,
        t.description,
        t.status,
        t.priority,
        t.projectId,
        t.assigneeId,
        t.dueDate,
        actor.id,
        id,
        expected,
      );
      text = `отредактировал(а) задачу «${t.title}»`;
    }
    const [result] = await db.batch([statement, event(text, true)]);
    if (!result.meta.changes) return conflict();
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json({ id, ...(await q('SELECT status,version FROM tasks WHERE id=?', id).first()) });
  }
  throw new HttpError(404, 'Маршрут не найден');
  async function references(projectId: number, assigneeId: number | null) {
    if (
      !(await q(
        'SELECT id FROM projects WHERE id=? AND workspace_id=?',
        projectId,
        workspace,
      ).first())
    )
      throw new HttpError(404, 'Проект не найден в пространстве');
    if (
      assigneeId !== null &&
      !(await q(
        'SELECT member_id FROM memberships WHERE member_id=? AND workspace_id=?',
        assigneeId,
        workspace,
      ).first())
    )
      throw new HttpError(404, 'Исполнитель не найден в команде');
  }
  function conflict() {
    return json(
      {
        code: 'version_conflict',
        message:
          'Задача уже изменена другим участником. Обновите список и откройте её заново; введённый текст сохранён в форме.',
      },
      409,
    );
  }
}
