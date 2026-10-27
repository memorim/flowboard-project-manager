import { z } from 'zod';
import {
  body,
  parse,
  json,
  tokenHash,
  HttpError,
  type Actor,
  type SqlDB,
  type WriteScope,
} from './flow-http.js';
const nameSchema = z.object({ name: z.string().trim().min(2).max(80) }).strict();
const accessRole = z.enum(['editor', 'viewer']);

export async function workspaceRoutes(req: Request, db: SqlDB, actor: Actor | null) {
  const path = new URL(req.url).pathname,
    method = req.method;
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  if (path === '/api/workspaces' && method === 'GET')
    return json(
      (
        await q(
          `SELECT w.id,w.name,w.is_public,COALESCE(m.role,'viewer') access_role FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.member_id=? WHERE w.is_public=1 OR m.member_id IS NOT NULL ORDER BY w.id`,
          actor?.id ?? -1,
        ).all()
      ).results,
    );
  if (path === '/api/workspaces' && method === 'POST') {
    if (!actor) throw new HttpError(401, 'Войдите для создания пространства');
    const { name } = parse(nameSchema, await body(req));
    if (db.dialect === 'postgres')
      await q('SELECT id FROM members WHERE id=? FOR UPDATE', actor.id).first();
    const count = await q(
      "SELECT COUNT(*) n FROM memberships WHERE member_id=? AND role='owner'",
      actor.id,
    ).first<{ n: number }>();
    if ((count?.n ?? 0) >= (db.limits?.workspaces ?? 10))
      throw new HttpError(429, 'Достигнута квота пространств');
    const [created] = await db.batch([
      q('INSERT INTO workspaces(name,is_public) VALUES (?,0)', name),
      q(
        "INSERT INTO memberships(workspace_id,member_id,role) VALUES (last_insert_rowid(),?,'owner')",
        actor.id,
      ),
      q(
        "INSERT INTO projects(name,client,color,progress,due_date,workspace_id) SELECT 'Основной проект','Команда','#ff6b3d',0,?,workspace_id FROM memberships WHERE member_id=? AND role='owner'" +
          (db.dialect === 'postgres'
            ? ' AND workspace_id=last_insert_rowid()'
            : ' ORDER BY workspace_id DESC LIMIT 1'),
        new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        actor.id,
      ),
    ]);
    return json({ id: created.meta.last_row_id, name, is_public: 0, access_role: 'owner' }, 201);
  }
  if (path === '/api/invitations/accept' && method === 'POST') {
    if (!actor) throw new HttpError(401, 'Войдите для принятия приглашения');
    const { token } = parse(
      z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      await body(req),
    );
    const hash = await tokenHash(token),
      now = new Date().toISOString();
    const invitation = await q(
      'SELECT workspace_id,accepted_by,expires_at FROM invitations WHERE token_hash=?',
      hash,
    ).first<{ workspace_id: number; accepted_by: number | null; expires_at: string }>();
    if (!invitation || invitation.expires_at <= now || invitation.accepted_by !== null)
      throw new HttpError(410, 'Приглашение истекло или уже использовано');
    await db.batch([
      q(
        'SELECT token_hash FROM invitations WHERE token_hash=? AND accepted_by IS NULL' +
          (db.dialect === 'postgres' ? ' FOR UPDATE' : ''),
        hash,
      ),
      q(
        'INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) SELECT workspace_id,?,role FROM invitations WHERE token_hash=? AND expires_at>? AND accepted_by IS NULL',
        actor.id,
        hash,
        now,
      ),
      q(
        'UPDATE invitations SET accepted_by=? WHERE token_hash=? AND expires_at>? AND accepted_by IS NULL',
        actor.id,
        hash,
        now,
      ),
    ]);
    const accepted = await q('SELECT accepted_by FROM invitations WHERE token_hash=?', hash).first<{
      accepted_by: number;
    }>();
    if (accepted?.accepted_by !== actor.id)
      throw new HttpError(410, 'Приглашение уже использовано');
    return json({ workspaceId: invitation.workspace_id });
  }
}

export async function workspaceWrites({ req, db, actor, workspace, role, event }: WriteScope) {
  const path = new URL(req.url).pathname,
    method = req.method;
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  if (path === '/api/invitations' && method === 'POST') {
    if (role !== 'owner') throw new HttpError(403, 'Приглашать может только владелец');
    const input = parse(z.object({ role: accessRole }).strict(), await body(req));
    const count = await q(
      'SELECT COUNT(*) n FROM invitations WHERE workspace_id=? AND accepted_by IS NULL AND expires_at>?',
      workspace,
      new Date().toISOString(),
    ).first<{ n: number }>();
    if ((count?.n || 0) >= (db.limits?.invitations ?? 20))
      throw new HttpError(429, 'Сначала используйте действующие приглашения');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
        v.toString(16).padStart(2, '0'),
      ).join(''),
      expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    await q(
      'INSERT INTO invitations(workspace_id,token_hash,role,expires_at,created_by) VALUES (?,?,?,?,?)',
      workspace,
      await tokenHash(token),
      input.role,
      expiresAt,
      actor.id,
    ).run();
    return json({ token, expiresAt, role: input.role }, 201);
  }
  const memberMatch = path.match(/^\/api\/members\/(\d+)$/);
  if (memberMatch && ['PATCH', 'DELETE'].includes(method)) {
    if (role !== 'owner') throw new HttpError(403, 'Права меняет только владелец');
    const target = Number(memberMatch[1]);
    const member = await q(
      'SELECT role FROM memberships WHERE workspace_id=? AND member_id=?',
      workspace,
      target,
    ).first<{ role: string }>();
    if (!member) throw new HttpError(404, 'Участник не найден');
    if (member.role === 'owner') throw new HttpError(400, 'Нельзя удалить или понизить владельца');
    if (method === 'DELETE') {
      const [, removed] = await db.batch([
        q(
          "UPDATE tasks SET assignee_id=NULL,version=version+1,changed_by=? WHERE assignee_id=? AND project_id IN (SELECT id FROM projects WHERE workspace_id=?) AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",
          actor.id,
          target,
          workspace,
          workspace,
          actor.id,
        ),
        q(
          "DELETE FROM memberships WHERE workspace_id=? AND member_id=? AND role!='owner' AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",
          workspace,
          target,
          workspace,
          actor.id,
        ),
        event('удалил(а) участника из пространства', true),
      ]);
      if (!removed.meta.changes) throw new HttpError(403, 'Право на изменение отозвано');
      return new Response(null, { status: 204 });
    }
    const input = parse(z.object({ role: accessRole }).strict(), await body(req));
    const [changed] = await db.batch([
      q(
        "UPDATE memberships SET role=? WHERE workspace_id=? AND member_id=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",
        input.role,
        workspace,
        target,
        workspace,
        actor.id,
      ),
      event('изменил(а) права участника', true),
    ]);
    if (!changed.meta.changes) throw new HttpError(403, 'Право на изменение отозвано');
    return json({ id: target, role: input.role });
  }
  if (path === '/api/projects' && method === 'POST') {
    const { name } = parse(nameSchema, await body(req));
    const count = await q('SELECT COUNT(*) n FROM projects WHERE workspace_id=?', workspace).first<{
      n: number;
    }>();
    let quota = db.limits?.projects ?? 30;
    if (db.limits) {
      const plan = await q(
        'SELECT valid_until FROM workspace_plans WHERE workspace_id=?',
        workspace,
      ).first<{ valid_until: number }>();
      if (plan && plan.valid_until > Date.now()) quota = Math.min(10000, quota * 4);
    }
    if ((count?.n || 0) >= quota) throw new HttpError(429, 'Достигнута квота проектов');
    const [result] = await db.batch([
      q(
        "INSERT INTO projects(name,client,color,progress,due_date,workspace_id) SELECT ?,'Команда','#7c64e3',0,?,? WHERE EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role IN ('owner','editor'))",
        name,
        new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        workspace,
        workspace,
        actor.id,
      ),
      event(`создал(а) проект «${name}»`, true),
    ]);
    if (!result.meta.changes) throw new HttpError(403, 'Право на изменение отозвано');
    return json({ id: result.meta.last_row_id, name }, 201);
  }
}
