import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Store } from './sqlite-adapter.js';
import {
  input,
  jsonInput,
  emailSchema,
  requireActor,
  confirmCredentials,
  lockRows,
  type AuthSettings,
} from './auth.js';
import { workspaceOwner } from './workspace-integrations.js';
import { queueAccountAction } from './account-routes.js';
import { digest, randomToken } from './account-crypto.js';
import { takeBudget } from './rate-limit.js';
import { HttpError } from '../src/flow-http.js';
import type { MailQueue } from './mail.js';

const userUrn = 'urn:ietf:params:scim:schemas:core:2.0:User',
  groupUrn = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const errorUrn = 'urn:ietf:params:scim:api:messages:2.0:Error';
const userSchema = z
  .object({
    userName: emailSchema,
    displayName: z.string().trim().min(2).max(80).optional(),
    name: z
      .object({ formatted: z.string().trim().min(2).max(80).optional() })
      .passthrough()
      .optional(),
    active: z.boolean().default(true),
    externalId: z.string().min(1).max(128).nullable().optional(),
  })
  .passthrough();
const membersSchema = z.array(z.object({ value: z.string().uuid() }).passthrough()).max(1000);
const groupSchema = z
  .object({
    displayName: z.string().trim().min(2).max(80),
    externalId: z.string().min(1).max(128).nullable().optional(),
    members: membersSchema.default([]),
  })
  .passthrough();
type User = {
  id: string;
  workspace_id: number;
  member_id: number;
  external_id: string | null;
  email: string;
  name: string;
  active: number;
  version: number;
  created_at: string;
  updated_at: string;
};
type Group = {
  id: string;
  workspace_id: number;
  external_id: string | null;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
};
type Directory = { workspace_id: number; created_by: number; default_role: string };
const etag = (row: { version: number }) => 'W/"' + row.version + '"';

export function installDirectory(
  app: Express,
  db: Store,
  settings: AuthSettings,
  mail?: MailQueue,
) {
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  app.use('/api/integrations', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/integrations/directory', async (req, res) => {
    const { workspace } = await workspaceOwner(db, req);
    const row = await q(
      'SELECT created_at,expires_at,default_role FROM directory_tokens WHERE workspace_id=?',
      workspace,
    ).first();
    res.json({
      enabled: Boolean(mail?.enabled && settings.publicOrigin),
      configured: Boolean(row),
      connected: row,
      baseUrl: settings.publicOrigin ? settings.publicOrigin + '/api/scim/v2' : null,
    });
  });
  app.post('/api/integrations/directory/token', async (req, res) => {
    if (!mail?.enabled || !settings.publicOrigin)
      throw new HttpError(503, 'Подключение каталога временно недоступно');
    const data = input(
      req,
      z
        .object({
          password: z.string().max(128).default(''),
          role: z.enum(['editor', 'viewer']).default('viewer'),
        })
        .strict(),
    );
    const actor = await requireActor(db, req);
    await takeBudget(db, 'directory-token:' + actor.id, 5, 600000);
    const credentials = await q(
      'SELECT member_id,password_enabled,password_salt,password_hash,password_version FROM accounts WHERE member_id=?',
      actor.id,
    ).first<{
      member_id: number;
      password_enabled: number;
      password_salt: string;
      password_hash: string;
      password_version: number;
    }>();
    if (!credentials || !(await confirmCredentials(db, req, credentials, data.password)))
      throw new HttpError(401, 'Подтвердите пароль или повторно войдите через провайдера');
    const token = randomToken(),
      created = Date.now(),
      expires = created + 90 * 86400000;
    await db.transaction(async () => {
      const { workspace } = await workspaceOwner(db, req);
      const current = await q(
        'SELECT password_version FROM accounts WHERE member_id=?' + lockRows(db),
        actor.id,
      ).first<{ password_version: number }>();
      if (current?.password_version !== credentials.password_version)
        throw new HttpError(409, 'Учётные данные изменились');
      await q(
        'INSERT INTO directory_tokens(workspace_id,token_hash,created_by,default_role,created_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET token_hash=excluded.token_hash,created_by=excluded.created_by,default_role=excluded.default_role,created_at=excluded.created_at,expires_at=excluded.expires_at',
        workspace,
        digest(token),
        actor.id,
        data.role,
        created,
        expires,
      ).run();
    });
    res
      .status(201)
      .json({ token, expiresAt: expires, baseUrl: settings.publicOrigin + '/api/scim/v2' });
  });
  app.delete('/api/integrations/directory/token', async (req, res) => {
    await db.transaction(async () => {
      const { workspace } = await workspaceOwner(db, req);
      await q('DELETE FROM directory_tokens WHERE workspace_id=?', workspace).run();
    });
    res.status(204).end();
  });
  app.use('/api/scim/v2', async (req, res) => {
    res.type('application/scim+json').set('Cache-Control', 'no-store');
    try {
      const token = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new HttpError(401, 'Требуется токен каталога');
      const directory = await q(
        "SELECT d.workspace_id,d.created_by,d.default_role FROM directory_tokens d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.member_id=d.created_by WHERE d.token_hash=? AND d.expires_at>? AND m.role='owner'",
        digest(token),
        Date.now(),
      ).first<Directory>();
      if (!directory) throw new HttpError(401, 'Токен недействителен');
      await takeBudget(db, 'scim:' + digest(token), 120, 60000);
      const base = settings.publicOrigin + '/api/scim/v2';
      const meta = (row: User | Group, type: string) => ({
        resourceType: type,
        created: row.created_at,
        lastModified: row.updated_at,
        version: etag(row),
        location: base + '/' + type + 's/' + row.id,
      });
      const userResource = (row: User) => ({
        schemas: [userUrn],
        id: row.id,
        externalId: row.external_id,
        userName: row.email,
        displayName: row.name,
        active: Boolean(row.active),
        emails: [{ value: row.email, type: 'work', primary: true }],
        meta: meta(row, 'User'),
      });
      const groupResource = async (row: Group) => ({
        schemas: [groupUrn],
        id: row.id,
        externalId: row.external_id,
        displayName: row.name,
        meta: meta(row, 'Group'),
        members: (
          await q(
            'SELECT u.id,u.name FROM directory_group_members m JOIN directory_users u ON u.id=m.user_id WHERE m.group_id=? AND u.workspace_id=? AND u.deleted_at IS NULL',
            row.id,
            directory.workspace_id,
          ).all<{ id: string; name: string }>()
        ).results.map((u) => ({ value: u.id, display: u.name, $ref: base + '/Users/' + u.id })),
      });
      if (req.method === 'GET' && req.path === '/ServiceProviderConfig')
        return res.json({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: 100 },
          sort: { supported: false },
          changePassword: { supported: false },
          etag: { supported: true },
          authenticationSchemes: [
            {
              type: 'oauthbearertoken',
              name: 'Workspace bearer token',
              description: 'Scoped provisioning token',
            },
          ],
        });
      if (req.method === 'GET' && req.path === '/ResourceTypes')
        return res.json({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: 2,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: [
            { id: 'User', name: 'User', endpoint: '/Users', schema: userUrn },
            { id: 'Group', name: 'Group', endpoint: '/Groups', schema: groupUrn },
          ],
        });
      if (req.method === 'GET' && req.path === '/Schemas')
        return res.json({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
          totalResults: 2,
          startIndex: 1,
          itemsPerPage: 2,
          Resources: [
            {
              id: userUrn,
              name: 'User',
              attributes: [
                {
                  name: 'userName',
                  type: 'string',
                  required: true,
                  multiValued: false,
                  mutability: 'immutable',
                  uniqueness: 'server',
                },
                {
                  name: 'displayName',
                  type: 'string',
                  multiValued: false,
                  mutability: 'readWrite',
                },
                { name: 'active', type: 'boolean', multiValued: false, mutability: 'readWrite' },
                { name: 'externalId', type: 'string', multiValued: false, mutability: 'readWrite' },
              ],
            },
            {
              id: groupUrn,
              name: 'Group',
              attributes: [
                {
                  name: 'displayName',
                  type: 'string',
                  required: true,
                  multiValued: false,
                  mutability: 'readWrite',
                },
                {
                  name: 'members',
                  type: 'complex',
                  multiValued: true,
                  mutability: 'readWrite',
                  subAttributes: [{ name: 'value', type: 'string', required: true }],
                },
              ],
            },
          ],
        });
      const match = req.path.match(/^\/(Users|Groups)(?:\/([a-f0-9-]{36}))?\/?$/);
      if (!match) throw new HttpError(404, 'Ресурс не найден');
      const userMode = match[1] === 'Users',
        id = match[2],
        table = userMode ? 'directory_users' : 'directory_groups';
      const getUser = (value: string) =>
        q(
          'SELECT * FROM directory_users WHERE id=? AND workspace_id=? AND deleted_at IS NULL' +
            lockRows(db),
          value,
          directory.workspace_id,
        ).first<User>();
      const getGroup = (value: string) =>
        q(
          'SELECT * FROM directory_groups WHERE id=? AND workspace_id=?' + lockRows(db),
          value,
          directory.workspace_id,
        ).first<Group>();
      const guardVersion = (row: User | Group) => {
        if (req.get('If-Match') && req.get('If-Match') !== etag(row))
          throw new HttpError(412, 'Ресурс уже изменён');
      };
      const result = await db.transaction(async () => {
        const stillAllowed = await q(
          "SELECT m.member_id FROM directory_tokens d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.member_id=d.created_by WHERE d.token_hash=? AND d.expires_at>? AND m.role='owner'" +
            (db.dialect === 'postgres' ? ' FOR SHARE OF d,m' : ''),
          digest(token),
          Date.now(),
        ).first();
        if (!stillAllowed) throw new HttpError(401, 'Токен отозван');
        if (req.method === 'GET') {
          if (id) {
            const row = userMode ? await getUser(id) : await getGroup(id);
            if (!row) throw new HttpError(404, 'Ресурс не найден');
            return {
              status: 200,
              data: userMode ? userResource(row as User) : await groupResource(row as Group),
              tag: etag(row),
            };
          }
          const start = Number(req.query.startIndex || 1),
            count = Number(req.query.count || 100);
          if (
            !Number.isInteger(start) ||
            start < 1 ||
            start > 1000000 ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > 100
          )
            throw new HttpError(400, 'Некорректная страница');
          let where = 'workspace_id=?' + (userMode ? ' AND deleted_at IS NULL' : ''),
            values: unknown[] = [directory.workspace_id];
          if (req.query.filter) {
            const filter = String(req.query.filter).match(
              /^(userName|externalId|displayName) eq ("(?:[^"\\]|\\.)*")$/,
            );
            if (!filter || (!userMode && filter[1] === 'userName'))
              throw new HttpError(400, 'Неподдерживаемый фильтр');
            const column =
              filter[1] === 'userName'
                ? 'email'
                : filter[1] === 'externalId'
                  ? 'external_id'
                  : 'name';
            where += ' AND ' + column + '=?';
            const value = JSON.parse(filter[2]) as string;
            if (value.length > 254) throw new HttpError(400, 'Слишком длинный фильтр');
            values = [...values, column === 'email' ? value.toLowerCase() : value];
          }
          const total = await q(
            'SELECT COUNT(*) n FROM ' + table + ' WHERE ' + where,
            ...values,
          ).first<{ n: number }>();
          const rows = (
            await q(
              'SELECT * FROM ' + table + ' WHERE ' + where + ' ORDER BY id LIMIT ? OFFSET ?',
              ...values,
              count,
              start - 1,
            ).all<User & Group>()
          ).results;
          const resources = await Promise.all(
            rows.map((row) => (userMode ? userResource(row) : groupResource(row))),
          );
          return {
            status: 200,
            data: {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
              totalResults: total!.n,
              startIndex: start,
              itemsPerPage: resources.length,
              Resources: resources,
            },
          };
        }
        if (userMode) {
          const current = id ? await getUser(id) : null;
          if (id && !current) throw new HttpError(404, 'Пользователь не найден');
          if (current) guardVersion(current);
          if (req.method === 'DELETE' && current) {
            await removeAccess(current);
            await q(
              'UPDATE directory_users SET active=0,deleted_at=?,version=version+1,updated_at=? WHERE id=?',
              new Date().toISOString(),
              new Date().toISOString(),
              current.id,
            ).run();
            return { status: 204 };
          }
          let raw = jsonInput(req);
          if (req.method === 'PATCH' && current) {
            const patch = z
              .object({
                Operations: z
                  .array(
                    z.object({
                      op: z.string(),
                      path: z.string().optional(),
                      value: z.unknown().optional(),
                    }),
                  )
                  .min(1)
                  .max(20),
              })
              .passthrough()
              .parse(raw);
            const changed: Record<string, unknown> = {
              userName: current.email,
              displayName: current.name,
              active: Boolean(current.active),
              externalId: current.external_id,
            };
            for (const op of patch.Operations) {
              if (!['replace', 'add', 'remove'].includes(op.op.toLowerCase()))
                throw new HttpError(400, 'Неподдерживаемая операция');
              if (
                !op.path &&
                typeof op.value === 'object' &&
                op.value !== null &&
                op.op.toLowerCase() !== 'remove'
              ) {
                for (const field of ['active', 'displayName', 'externalId', 'userName', 'name'])
                  if (Object.hasOwn(op.value, field))
                    changed[field] = (op.value as Record<string, unknown>)[field];
              } else if (
                op.path &&
                ['active', 'displayName', 'externalId', 'userName'].includes(op.path)
              )
                changed[op.path] = op.op.toLowerCase() === 'remove' ? null : op.value;
              else throw new HttpError(400, 'Неподдерживаемый атрибут');
            }
            raw = changed;
          }
          if (
            !['POST', 'PUT', 'PATCH'].includes(req.method) ||
            (req.method === 'POST' && id) ||
            (req.method !== 'POST' && !id)
          )
            throw new HttpError(405, 'Метод не поддерживается');
          const data = userSchema.parse(raw);
          if (current && data.userName !== current.email)
            throw new HttpError(400, 'userName неизменяемый; создайте нового пользователя');
          const now = new Date().toISOString();
          if (current) {
            await q(
              'UPDATE directory_users SET name=?,external_id=?,active=?,version=version+1,updated_at=? WHERE id=?',
              data.displayName || data.name?.formatted || current.name,
              data.externalId || null,
              Number(data.active),
              now,
              current.id,
            ).run();
            if (data.active) await grantAccess(current.member_id);
            else await removeAccess(current);
            const updated = (await getUser(current.id))!;
            return { status: 200, data: userResource(updated), tag: etag(updated) };
          }
          let existing = await q(
            'SELECT member_id,email_verified,password_version FROM accounts WHERE email=?',
            data.userName,
          ).first<{ member_id: number; email_verified: number; password_version: number }>();
          const name = data.displayName || data.name?.formatted || data.userName;
          if (!existing) {
            const member = await q(
              "INSERT INTO members(name,role,initials,color) VALUES(?,'Участник',?,'#7c64e3') RETURNING id",
              name,
              Array.from(name).slice(0, 2).join('').toUpperCase(),
            ).first<{ id: number }>();
            const inserted = await q(
              "INSERT INTO accounts(member_id,email,password_salt,password_hash,email_verified) VALUES(? ,?,'','',0) ON CONFLICT(email) DO NOTHING",
              member!.id,
              data.userName,
            ).run();
            existing = (await q(
              'SELECT member_id,email_verified,password_version FROM accounts WHERE email=?',
              data.userName,
            ).first<{ member_id: number; email_verified: number; password_version: number }>())!;
            if (!inserted.meta.changes) await q('DELETE FROM members WHERE id=?', member!.id).run();
          }
          if (
            await q(
              'SELECT member_id FROM memberships WHERE workspace_id=? AND member_id=?',
              directory.workspace_id,
              existing.member_id,
            ).first()
          )
            throw new HttpError(409, 'Участник уже управляется вне каталога');
          const newId = randomUUID();
          await q(
            'INSERT INTO directory_users(id,workspace_id,member_id,external_id,email,name,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
            newId,
            directory.workspace_id,
            existing.member_id,
            data.externalId || null,
            data.userName,
            name,
            Number(data.active),
            now,
            now,
          ).run();
          if (data.active) await grantAccess(existing.member_id);
          if (!existing.email_verified)
            await queueAccountAction(
              db,
              mail!,
              settings.publicOrigin!,
              {
                member_id: existing.member_id,
                email: data.userName,
                password_version: existing.password_version,
              },
              'reset',
            );
          const created = (await getUser(newId))!;
          return { status: 201, data: userResource(created), tag: etag(created) };
        }
        const current = id ? await getGroup(id) : null;
        if (id && !current) throw new HttpError(404, 'Группа не найдена');
        if (current) guardVersion(current);
        if (req.method === 'DELETE' && current) {
          await q('DELETE FROM directory_groups WHERE id=?', current.id).run();
          return { status: 204 };
        }
        let raw = jsonInput(req);
        if (req.method === 'PATCH' && current) {
          const oldMembers = (
            await q('SELECT user_id FROM directory_group_members WHERE group_id=?', id).all<{
              user_id: string;
            }>()
          ).results.map((row) => ({ value: row.user_id }));
          const changed: {
            displayName: string;
            externalId: string | null;
            members: { value: string }[];
          } = { displayName: current.name, externalId: current.external_id, members: oldMembers };
          const patch = z
            .object({
              Operations: z
                .array(
                  z.object({
                    op: z.string(),
                    path: z.string().optional(),
                    value: z.unknown().optional(),
                  }),
                )
                .min(1)
                .max(20),
            })
            .passthrough()
            .parse(raw);
          for (const op of patch.Operations) {
            const operation = op.op.toLowerCase();
            if (!['replace', 'add', 'remove'].includes(operation))
              throw new HttpError(400, 'Неподдерживаемая операция');
            const member = op.path?.match(/^members\[value eq "([a-f0-9-]{36})"\]$/);
            if (member && operation === 'remove')
              changed.members = changed.members.filter((m) => m.value !== member[1]);
            else if (op.path === 'members') {
              const values = op.value === undefined ? [] : membersSchema.parse(op.value);
              changed.members =
                operation === 'replace'
                  ? values
                  : operation === 'add'
                    ? [...changed.members, ...values]
                    : op.value === undefined
                      ? []
                      : changed.members.filter((m) => !values.some((v) => v.value === m.value));
            } else if (op.path === 'displayName' && operation !== 'remove')
              changed.displayName = z.string().trim().min(2).max(80).parse(op.value);
            else if (op.path === 'externalId')
              changed.externalId =
                operation === 'remove' ? null : z.string().max(128).parse(op.value);
            else if (
              !op.path &&
              operation !== 'remove' &&
              op.value &&
              typeof op.value === 'object'
            ) {
              for (const field of ['displayName', 'externalId', 'members'] as const)
                if (Object.hasOwn(op.value, field))
                  (changed as Record<string, unknown>)[field] = (
                    op.value as Record<string, unknown>
                  )[field];
            } else throw new HttpError(400, 'Неподдерживаемый атрибут');
          }
          raw = changed;
        }
        if (
          !['POST', 'PUT', 'PATCH'].includes(req.method) ||
          (req.method === 'POST' && id) ||
          (req.method !== 'POST' && !id)
        )
          throw new HttpError(405, 'Метод не поддерживается');
        const data = groupSchema.parse(raw),
          now = new Date().toISOString(),
          groupId = current?.id || randomUUID();
        if (current)
          await q(
            'UPDATE directory_groups SET name=?,external_id=?,version=version+1,updated_at=? WHERE id=?',
            data.displayName,
            data.externalId || null,
            now,
            groupId,
          ).run();
        else
          await q(
            'INSERT INTO directory_groups(id,workspace_id,external_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)',
            groupId,
            directory.workspace_id,
            data.externalId || null,
            data.displayName,
            now,
            now,
          ).run();
        await q('DELETE FROM directory_group_members WHERE group_id=?', groupId).run();
        for (const member of [...new Set(data.members.map((m) => m.value))]) {
          if (!(await getUser(member)))
            throw new HttpError(400, 'Участник группы не найден в этом каталоге');
          await q(
            'INSERT INTO directory_group_members(group_id,user_id) VALUES(?,?)',
            groupId,
            member,
          ).run();
        }
        const changed = (await getGroup(groupId))!;
        return {
          status: current ? 200 : 201,
          data: await groupResource(changed),
          tag: etag(changed),
        };

        async function grantAccess(memberId: number) {
          await q(
            'INSERT INTO memberships(workspace_id,member_id,role) VALUES(?,?,?) ON CONFLICT(workspace_id,member_id) DO NOTHING',
            directory!.workspace_id,
            memberId,
            directory!.default_role,
          ).run();
        }
        async function removeAccess(user: User) {
          const membership = await q(
            'SELECT role FROM memberships WHERE workspace_id=? AND member_id=?' + lockRows(db),
            directory!.workspace_id,
            user.member_id,
          ).first<{ role: string }>();
          if (membership?.role === 'owner')
            throw new HttpError(409, 'Каталог не может изменить владельца');
          await q(
            'UPDATE tasks SET assignee_id=NULL,version=version+1,changed_by=? WHERE assignee_id=? AND project_id IN(SELECT id FROM projects WHERE workspace_id=?)',
            directory!.created_by,
            user.member_id,
            directory!.workspace_id,
          ).run();
          await q(
            'DELETE FROM memberships WHERE workspace_id=? AND member_id=?',
            directory!.workspace_id,
            user.member_id,
          ).run();
        }
      });
      if ('tag' in result && result.tag) res.set('ETag', result.tag);
      if (result.status === 204) return res.status(204).end();
      if (result.status === 201 && 'data' in result && result.data && 'meta' in result.data)
        res.location((result.data as { meta: { location: string } }).meta.location);
      return res.status(result.status).json('data' in result ? result.data : undefined);
    } catch (error) {
      const invalid = error instanceof z.ZodError,
        unique =
          (error as { code?: string; errcode?: number }).code === '23505' ||
          (error as { errcode?: number }).errcode === 2067;
      const status = error instanceof HttpError ? error.status : invalid ? 400 : unique ? 409 : 503;
      if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="flowboard"');
      res.status(status).json({
        schemas: [errorUrn],
        status: String(status),
        ...(status === 400 ? { scimType: 'invalidValue' } : {}),
        detail:
          error instanceof HttpError
            ? error.message
            : invalid
              ? 'Проверьте атрибуты SCIM'
              : unique
                ? 'Пользователь или внешний идентификатор уже существует'
                : 'Сервис временно недоступен',
      });
    }
  });
}
