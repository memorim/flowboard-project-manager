import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import { HttpError, type Actor } from '../src/flow-api.js';
import type { Db } from './db.js';

const cookieName = 'flowboard_session';
const sessionLifetime = 24 * 60 * 60 * 1000;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(15).max(128);
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
async function passwordHash(password: string, salt: string): Promise<Buffer> {
  // ponytail: two concurrent KDFs bound memory/CPU in this process; add a shared gateway limit before using multiple replicas.
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

export async function createAccount(db: Db, input: z.input<typeof accountSchema>) {
  const parsed = accountSchema.parse(input);
  const existingMember = parsed.memberId
    ? (db.prepare('SELECT id,name FROM members WHERE id=?').get(parsed.memberId) as
        { id: number; name: string } | undefined)
    : undefined;
  if (parsed.memberId && !existingMember) throw new Error('Existing member not found');
  if (!existingMember && !parsed.name) throw new Error('A name is required for a new member');
  const salt = randomBytes(16).toString('hex'),
    hash = await passwordHash(parsed.password, salt);
  db.exec('BEGIN IMMEDIATE');
  try {
    const name = existingMember?.name || parsed.name || '';
    const memberId =
      existingMember?.id ||
      Number(
        db
          .prepare("INSERT INTO members(name,role,initials,color) VALUES(?,'Участник',?,'#7c64e3')")
          .run(name, Array.from(name).slice(0, 2).join('').toUpperCase()).lastInsertRowid,
      );
    db.prepare(
      'INSERT INTO accounts(member_id,email,password_salt,password_hash) VALUES(?,?,?,?)',
    ).run(memberId, parsed.email, salt, hash.toString('hex'));
    db.exec('COMMIT');
    return { id: memberId, name, email: parsed.email };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function sessionToken(req: Request) {
  const token = req.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export function sessionActor(db: Db, req: Request): Actor | null {
  const token = sessionToken(req);
  if (!token) return null;
  return (
    (db
      .prepare(
        'SELECT m.id,m.name,m.role,m.initials,m.color FROM members m JOIN sessions s ON s.member_id=m.id WHERE s.token_hash=? AND s.expires_at>?',
      )
      .get(digest(token), Date.now()) as Actor | undefined) || null
  );
}

export function installSessionAuth(app: Express, db: Db, settings: AuthSettings) {
  // A bounded, per-process login budget; untrusted proxy headers never determine identity or the rate-limit key.
  const attempts = new Map<string, { count: number; until: number }>();
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
      const origin = settings.publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (
        req.get('Sec-Fetch-Site') === 'cross-site' ||
        (req.get('Origin') && req.get('Origin') !== origin)
      )
        return res.status(403).json({ message: 'Недопустимый источник запроса' });
    }
    next();
  });
  if (settings.mode !== 'session') return;
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: settings.secureCookies,
    path: '/',
  };
  app.post('/api/auth/login', async (req, res) => {
    const now = Date.now(),
      ip = req.ip || 'local';
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const prior = attempts.get(ip);
    if ((prior?.count || 0) >= 10 || (!prior && attempts.size >= 10000))
      return res
        .status(429)
        .json({ message: 'Слишком много попыток входа. Повторите через 10 минут' });
    let raw: unknown = null;
    try {
      raw = typeof req.body === 'string' ? JSON.parse(req.body) : null;
    } catch {
      throw new HttpError(400, 'Некорректный JSON');
    }
    const parsed = z
      .object({ email: emailSchema, password: z.string().min(1).max(128) })
      .strict()
      .safeParse(raw);
    if (!parsed.success)
      return res.status(400).json({ message: 'Укажите корректную почту и пароль' });
    attempts.set(ip, { count: (prior?.count || 0) + 1, until: prior?.until || now + 600000 });
    const account = db
      .prepare('SELECT member_id,password_salt,password_hash FROM accounts WHERE email=?')
      .get(parsed.data.email) as
      { member_id: number; password_salt: string; password_hash: string } | undefined;
    const actual = await passwordHash(
      parsed.data.password,
      account?.password_salt || 'missing-account-salt',
    );
    const expected = account ? Buffer.from(account.password_hash, 'hex') : Buffer.alloc(64);
    if (!account || expected.length !== actual.length || !timingSafeEqual(actual, expected))
      return res.status(401).json({ message: 'Неверная почта или пароль' });
    const token = randomBytes(32).toString('hex'),
      old = sessionToken(req);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
      if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(old));
      db.prepare('INSERT INTO sessions(token_hash,member_id,expires_at) VALUES(?,?,?)').run(
        digest(token),
        account.member_id,
        now + sessionLifetime,
      );
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    attempts.delete(ip);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
}
