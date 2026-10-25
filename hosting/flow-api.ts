import { json, HttpError, type Actor, type SqlDB, type Workspace } from './flow-http.js';
import { workspaceRoutes, workspaceWrites } from './flow-workspaces.js';
import { workspaceReads } from './flow-reads.js';
import { taskWrites } from './flow-tasks.js';
export { HttpError, tokenHash, body, operationKey } from './flow-http.js';
export type { Actor, SqlDB, Statement, Result } from './flow-http.js';

export async function flowApi(
  req: Request,
  db: SqlDB,
  actor: Actor | null,
  mode: 'local' | 'chatgpt' | 'authenticated',
) {
  try {
    return await handle(req, db, actor, mode);
  } catch (error) {
    if (String(error).includes('flow_access_denied'))
      return json({ message: 'Право на изменение отозвано' }, 403);
    if (String(error).includes('flow_assignee_missing'))
      return json({ message: 'Исполнитель больше не состоит в команде' }, 409);
    if (error instanceof HttpError) return json({ message: error.message }, error.status);
    return json({ message: 'Сервис временно недоступен. Повторите запрос.' }, 503);
  }
}
async function handle(req: Request, db: SqlDB, actor: Actor | null, mode: string) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method;
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  if (
    !['GET', 'HEAD'].includes(method) &&
    (req.headers.get('sec-fetch-site') === 'cross-site' ||
      (req.headers.get('origin') && req.headers.get('origin') !== url.origin))
  )
    throw new HttpError(403, 'Недопустимый источник запроса');
  if (path === '/api/health' && method === 'GET') return json({ status: 'ok' });
  // Only the public sandbox auto-enrols visitors. Other workspaces always require explicit membership.
  if (actor && mode !== 'authenticated')
    await q(
      "INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) VALUES (1,?,'editor')",
      actor.id,
    ).run();
  const globalRoute = await workspaceRoutes(req, db, actor);
  if (globalRoute) return globalRoute;
  const workspace = Number(url.searchParams.get('workspace') || 1);
  if (!Number.isSafeInteger(workspace) || workspace < 1)
    throw new HttpError(400, 'Некорректное пространство');
  const space = await q(
    `SELECT w.*,m.role access_role FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.member_id=? WHERE w.id=?`,
    actor?.id ?? -1,
    workspace,
  ).first<Workspace>();
  if (!space || (!space.is_public && !space.access_role))
    throw new HttpError(404, 'Пространство не найдено');
  const role = space.access_role || 'viewer';
  if (path === '/api/session' && method === 'GET')
    return json({
      mode,
      user: actor,
      workspace: { ...space, access_role: role },
      canWrite: !!actor && role !== 'viewer',
    });
  const read = await workspaceReads({ req, db, actor, workspace, space, role });
  if (read) return read;
  if (!actor) throw new HttpError(401, 'Войдите для изменения данных');
  if (role === 'viewer') throw new HttpError(403, 'Роль наблюдателя разрешает только просмотр');
  const recent = await q(
    'SELECT COUNT(*) n FROM activity WHERE member_id=? AND created_at>?',
    actor.id,
    new Date(Date.now() - 60000).toISOString(),
  ).first<{ n: number }>();
  const limited = (recent?.n || 0) >= 30;
  if (limited && !(path === '/api/tasks' && method === 'POST'))
    throw new HttpError(429, 'До 30 изменений в минуту. Повторите позднее.');
  const event = (text: string, conditional = false) =>
    q(
      `INSERT INTO activity(text,member_id,created_at,workspace_id) SELECT ?,?,?,? ${conditional ? 'WHERE changes()>0' : ''}`,
      text,
      actor.id,
      new Date().toISOString(),
      workspace,
    );
  const scope = { req, db, actor, workspace, role, event, limited };
  const changed = await workspaceWrites(scope);
  if (changed) return changed;
  return taskWrites(scope);
}
