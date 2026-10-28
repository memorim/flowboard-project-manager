import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { HttpError, type Actor } from '../src/flow-api.js';
import type { Db } from './db.js';
import { asStore, type Store } from './sqlite-adapter.js';
import { digest, randomToken } from './account-crypto.js';
import { takeBudget } from './rate-limit.js';
import { installAccountRoutes, type AccountOptions } from './account-routes.js';

const cookieName = 'flowboard_session';
export const sessionLifetime = 24 * 60 * 60 * 1000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .refine(
    (value) => !value.endsWith('@identity.flowboard.invalid'),
    'Используйте действующий адрес почты',
  );
export const passwordSchema = z.string().min(15).max(128);
const accountSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(2).max(80).optional(),
    memberId: z.number().int().positive().optional(),
  })
  .strict();
export type AuthMode = 'session' | 'demo';
export type AuthSettings = { mode: AuthMode; publicOrigin?: string; secureCookies: boolean };

export function authConfiguration(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  const mode = env.FLOW_AUTH_MODE || 'session';
  if (mode !== 'session' && mode !== 'demo')
    throw new Error('FLOW_AUTH_MODE must be session or demo');
  if (
    mode === 'demo' &&
    (env.NODE_ENV === 'production' || !loopbackHosts.has(env.HOST || '127.0.0.1'))
  )
    throw new Error('Demo identity is only allowed on a development loopback server');
  let publicOrigin: string | undefined;
  if (env.FLOW_PUBLIC_ORIGIN) {
    const value = new URL(env.FLOW_PUBLIC_ORIGIN);
    if (
      !['http:', 'https:'].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.pathname !== '/' ||
      value.search ||
      value.hash
    )
      throw new Error('FLOW_PUBLIC_ORIGIN must be an HTTP(S) origin');
    publicOrigin = value.origin;
    if (value.protocol === 'http:' && !loopbackHosts.has(value.hostname))
      throw new Error('Non-loopback public origins require HTTPS');
  }
  if (env.NODE_ENV === 'production' && !publicOrigin?.startsWith('https://'))
    throw new Error('Production sessions require an explicit HTTPS FLOW_PUBLIC_ORIGIN');
  return {
    mode,
    publicOrigin,
    secureCookies:
      env.NODE_ENV === 'production' ||
      publicOrigin?.startsWith('https://') === true ||
      env.FLOW_COOKIE_SECURE === 'true',
  };
}

let activeDerivations = 0;
export async function passwordHash(password: string, salt: string): Promise<Buffer> {
  if (activeDerivations >= 2) throw new HttpError(429, 'Вход временно занят. Повторите запрос.');
  activeDerivations++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    activeDerivations--;
  }
}
export async function passwordMatches(
  account: { password_salt: string; password_hash: string },
  password: string,
) {
  const actual = await passwordHash(password, account.password_salt),
    expected = Buffer.from(account.password_hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function confirmCredentials(
  db: Store,
  req: Request,
  account: {
    member_id: number;
    password_enabled?: number;
    password_salt: string;
    password_hash: string;
  },
  password: string,
) {
  if (account.password_enabled !== 0) return passwordMatches(account, password);
  const token = sessionToken(req);
  if (!token) return false;
  return Boolean(
    await db
      .prepare(
        'SELECT session_id FROM sessions WHERE token_hash=? AND member_id=? AND created_at>? AND expires_at>?',
      )
      .bind(digest(token), account.member_id, Date.now() - 300000, Date.now())
      .first(),
  );
}

export async function createAccount(
  database: Db | Store,
  input: z.input<typeof accountSchema>,
  verified = true,
) {
  const db = asStore(database),
    parsed = accountSchema.parse(input);
  const salt = randomBytes(16).toString('hex'),
    hash = await passwordHash(parsed.password, salt);
  return db.transaction(async () => {
    const member = parsed.memberId
      ? await db
          .prepare('SELECT id,name FROM members WHERE id=?')
          .bind(parsed.memberId)
          .first<{ id: number; name: string }>()
      : null;
    if (parsed.memberId && !member) throw new Error('Existing member not found');
    if (!member && !parsed.name) throw new Error('A name is required for a new member');
    const name = member?.name || parsed.name || '';
    const created =
      member ||
      (await db
        .prepare(
          "INSERT INTO members(name,role,initials,color) VALUES(?,'Участник',?,'#7c64e3') RETURNING id",
        )
        .bind(name, Array.from(name).slice(0, 2).join('').toUpperCase())
        .first<{ id: number }>());
    await db
      .prepare(
        'INSERT INTO accounts(member_id,email,password_salt,password_hash,email_verified) VALUES(?,?,?,?,?)',
      )
      .bind(created!.id, parsed.email, salt, hash.toString('hex'), Number(verified))
      .run();
    return { id: created!.id, name, email: parsed.email };
  });
}

export function sessionToken(req: Request) {
  const token = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function sessionActor(database: Db | Store, req: Request): Promise<Actor | null> {
  const token = sessionToken(req);
  if (!token) return null;
  return asStore(database)
    .prepare(
      'SELECT m.id,m.name,m.role,m.initials,m.color FROM members m JOIN sessions s ON s.member_id=m.id JOIN accounts a ON a.member_id=m.id WHERE s.token_hash=? AND s.expires_at>? AND (a.email_verified=1 OR EXISTS(SELECT 1 FROM external_identities e WHERE e.member_id=a.member_id))',
    )
    .bind(digest(token), Date.now())
    .first<Actor>();
}
export async function requireActor(db: Store, req: Request) {
  const actor = await sessionActor(db, req);
  if (!actor) throw new HttpError(401, 'Войдите в аккаунт');
  return actor;
}
export function jsonInput(req: Request): unknown {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}
export function input<T>(req: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(jsonInput(req));
  if (!parsed.success) throw new HttpError(400, 'Проверьте данные запроса');
  return parsed.data;
}
export function lockRows(db: Store) {
  return db.dialect === 'postgres' ? ' FOR UPDATE' : '';
}

export async function establishSession(
  db: Store,
  req: Request,
  memberId: number,
  version: number,
  mfaPassed = false,
) {
  return db.transaction(async () => {
    const account = await db
      .prepare(
        'SELECT password_version,email_verified,mfa_secret,EXISTS(SELECT 1 FROM external_identities e WHERE e.member_id=accounts.member_id) external_auth FROM accounts WHERE member_id=?' +
          lockRows(db),
      )
      .bind(memberId)
      .first<{
        password_version: number;
        email_verified: number;
        mfa_secret: string | null;
        external_auth: number | boolean;
      }>();
    if (
      !account ||
      account.password_version !== version ||
      (!account.email_verified && !account.external_auth) ||
      (account.mfa_secret && !mfaPassed)
    )
      throw new HttpError(401, 'Учётные данные изменились. Войдите заново.');
    const token = randomToken(),
      now = Date.now(),
      old = sessionToken(req);
    await db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now).run();
    if (old) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(digest(old)).run();
    await db
      .prepare(
        'INSERT INTO sessions(token_hash,member_id,expires_at,session_id,created_at,device) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        digest(token),
        memberId,
        now + sessionLifetime,
        randomBytes(16).toString('hex'),
        now,
        (req.get('User-Agent') || 'Браузер').slice(0, 160),
      )
      .run();
    return token;
  });
}
const cookieOptions = (settings: AuthSettings) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: settings.secureCookies,
  path: '/',
});
export function setSession(res: Response, settings: AuthSettings, token: string) {
  res.cookie(cookieName, token, { ...cookieOptions(settings), maxAge: sessionLifetime });
}

export function installSessionAuth(
  app: Express,
  database: Db | Store,
  settings: AuthSettings,
  options: AccountOptions = {},
) {
  const db = asStore(database);
  app.use('/api', (req, res, next) => {
    if (settings.mode === 'demo') {
      const peer = req.socket.remoteAddress;
      if (
        !loopbackHosts.has(req.hostname) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '')
      )
        return res
          .status(403)
          .json({ message: 'Демонстрационный сервер доступен только локально' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = settings.publicOrigin || req.protocol + '://' + req.get('host');
      if (
        req.get('Sec-Fetch-Site') === 'cross-site' ||
        (req.get('Origin') && req.get('Origin') !== origin)
      )
        return res.status(403).json({ message: 'Недопустимый источник запроса' });
    }
    next();
  });
  if (settings.mode !== 'session') return;
  app.use('/api/auth', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.post('/api/auth/login', async (req, res) => {
    const parsed = input(
      req,
      z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict(),
    );
    await takeBudget(db, 'login:peer:' + req.ip, 100, 600000);
    await takeBudget(db, 'login:account:' + parsed.email, 10, 600000);
    const account = await db
      .prepare(
        'SELECT member_id,password_salt,password_hash,password_version,email_verified,mfa_secret,password_enabled FROM accounts WHERE email=?',
      )
      .bind(parsed.email)
      .first<{
        member_id: number;
        password_salt: string;
        password_hash: string;
        password_version: number;
        email_verified: number;
        password_enabled: number;
        mfa_secret: string | null;
      }>();
    const valid = await passwordMatches(
      account || { password_salt: 'missing-account-salt', password_hash: '0'.repeat(128) },
      parsed.password,
    );
    if (!account || !valid || !account.email_verified || !account.password_enabled)
      return res
        .status(401)
        .json({ message: 'Неверная почта или пароль либо почта ещё не подтверждена' });
    if (account.mfa_secret) {
      const challenge = randomToken();
      await db
        .prepare(
          'INSERT INTO mfa_challenges(token_hash,member_id,expires_at,password_version) VALUES(?,?,?,?)',
        )
        .bind(digest(challenge), account.member_id, Date.now() + 300000, account.password_version)
        .run();
      return res.json({ mfaRequired: true, challenge });
    }
    const token = await establishSession(db, req, account.member_id, account.password_version);
    setSession(res, settings, token);
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token)
      await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(digest(token)).run();
    res.clearCookie(cookieName, cookieOptions(settings)).status(204).end();
  });
  return installAccountRoutes(app, db, settings, options);
}
