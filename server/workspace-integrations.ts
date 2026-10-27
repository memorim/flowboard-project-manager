import { z } from 'zod';
import type { Express, Request } from 'express';
import type { Store } from './sqlite-adapter.js';
import { input, requireActor, emailSchema, lockRows, type AuthSettings } from './auth.js';
import { HttpError } from '../src/flow-http.js';
import { digest, randomToken } from './account-crypto.js';
import type { MailQueue } from './mail.js';
import { takeBudget } from './rate-limit.js';

export function workspaceId(req: Request) {
  const value = Number(req.query.workspace);
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'Выберите пространство');
  return value;
}
export async function workspaceOwner(db: Store, req: Request) {
  const actor = await requireActor(db, req),
    workspace = workspaceId(req);
  const row = await db
    .prepare(
      "SELECT member_id FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner'" +
        lockRows(db),
    )
    .bind(workspace, actor.id)
    .first();
  if (!row) throw new HttpError(403, 'Действие доступно владельцу пространства');
  return { actor, workspace };
}
export function installMailInvitations(
  app: Express,
  db: Store,
  settings: AuthSettings,
  mail?: MailQueue,
) {
  app.post('/api/invitations/email', async (req, res) => {
    const data = input(
      req,
      z.object({ role: z.enum(['editor', 'viewer']), email: emailSchema }).strict(),
    );
    await takeBudget(db, 'email-invite:' + req.ip, 20, 600000);
    if (!mail?.enabled || !settings.publicOrigin)
      throw new HttpError(503, 'Отправка приглашений временно недоступна');
    const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
    await db.transaction(async () => {
      const { actor, workspace } = await workspaceOwner(db, req),
        token = randomToken();
      const count = await db
        .prepare(
          'SELECT COUNT(*) n FROM invitations WHERE workspace_id=? AND accepted_by IS NULL AND expires_at>?',
        )
        .bind(workspace, new Date().toISOString())
        .first<{ n: number }>();
      if ((count?.n || 0) >= (db.limits?.invitations ?? 20))
        throw new HttpError(429, 'Сначала используйте действующие приглашения');
      await db
        .prepare(
          'INSERT INTO invitations(workspace_id,token_hash,role,expires_at,created_by,email) VALUES(?,?,?,?,?,?)',
        )
        .bind(workspace, digest(token), data.role, expiresAt, actor.id, data.email)
        .run();
      await mail.enqueue({
        to: data.email,
        subject: 'Приглашение в команду Flowboard',
        text:
          actor.name +
          ' приглашает вас в рабочее пространство. Войдите с адресом ' +
          data.email +
          ' и примите приглашение:\n' +
          settings.publicOrigin +
          '/#invite=' +
          token +
          '\nСсылка действует 7 дней.',
      });
    });
    res.status(202).json({ email: data.email, expiresAt });
  });
  app.post('/api/invitations/accept', async (req, _res, next) => {
    const data = input(req, z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
    const invite = await db
      .prepare('SELECT email FROM invitations WHERE token_hash=?')
      .bind(digest(data.token))
      .first<{ email: string | null }>();
    if (invite?.email) {
      const actor = await requireActor(db, req);
      const account = await db
        .prepare('SELECT email FROM accounts WHERE member_id=? AND email_verified=1')
        .bind(actor.id)
        .first<{ email: string }>();
      if (account?.email !== invite.email)
        throw new HttpError(403, 'Приглашение отправлено на другой адрес');
    }
    next();
  });
}
