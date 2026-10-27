import { randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError } from '../src/flow-http.js';
import type { Store } from './sqlite-adapter.js';
import {
  createAccount,
  emailSchema,
  passwordSchema,
  passwordHash,
  passwordMatches,
  sessionToken,
  requireActor,
  input,
  lockRows,
  establishSession,
  setSession,
  type AuthSettings,
} from './auth.js';
import {
  decrypt,
  digest,
  encrypt,
  encryptionKey,
  matchTotp,
  mfaSecret,
  randomToken,
  requireKey,
} from './account-crypto.js';
import { mailQueue, smtpSender, type MailSender, type MailQueue } from './mail.js';
import { takeBudget } from './rate-limit.js';

export type AccountOptions = { key?: Buffer; sendMail?: MailSender; registration?: boolean };
type Account = {
  member_id: number;
  email: string;
  email_verified: number;
  password_salt: string;
  password_hash: string;
  password_version: number;
  mfa_secret: string | null;
  mfa_pending: string | null;
  mfa_pending_until: number | null;
  mfa_counter: number;
};
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/[-\s]/g, ''))
  .pipe(z.string().regex(/^(?:\d{6}|[a-f0-9]{20})$/));
const generic = {
  message: 'Если адрес может использоваться, письмо с инструкцией будет отправлено.',
};
export async function queueAccountAction(
  db: Store,
  mail: MailQueue,
  origin: string,
  user: Pick<Account, 'member_id' | 'email' | 'password_version'>,
  kind: 'verify' | 'reset',
) {
  const token = randomToken(),
    now = Date.now(),
    lifetime = kind === 'verify' ? 86400000 : 1800000;
  await db.transaction(async () => {
    await db
      .prepare(
        'UPDATE account_actions SET used_at=? WHERE member_id=? AND kind=? AND used_at IS NULL',
      )
      .bind(now, user.member_id, kind)
      .run();
    await db
      .prepare(
        'INSERT INTO account_actions(token_hash,member_id,kind,expires_at,password_version) VALUES(?,?,?,?,?)',
      )
      .bind(digest(token), user.member_id, kind, now + lifetime, user.password_version)
      .run();
    const url = origin + '/?auth=' + kind + '&token=' + token;
    await mail.enqueue({
      to: user.email,
      subject:
        kind === 'verify' ? 'Подтверждение почты Flowboard' : 'Восстановление доступа Flowboard',
      text:
        (kind === 'verify'
          ? 'Подтвердите адрес и пароль, указанный при регистрации: '
          : 'Установите новый пароль: ') +
        url +
        '\nЕсли вы не отправляли запрос, проигнорируйте письмо.',
    });
  });
}

export function installAccountRoutes(
  app: Express,
  db: Store,
  settings: AuthSettings,
  options: AccountOptions,
) {
  const key = options.key || encryptionKey(),
    mail = mailQueue(db, key, options.sendMail || smtpSender());
  const registration =
    (options.registration ?? process.env.FLOW_REGISTRATION_ENABLED !== 'false') &&
    mail.enabled &&
    Boolean(settings.publicOrigin);
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const account = (id: number, locked = false) =>
    q(
      'SELECT * FROM accounts WHERE member_id=?' + (locked ? lockRows(db) : ''),
      id,
    ).first<Account>();
  const budget = (req: Request, action: string, limit = 10) =>
    takeBudget(db, action + ':' + req.ip, limit, 600000);
  function requireMail() {
    if (!mail.enabled || !settings.publicOrigin)
      throw new HttpError(503, 'Отправка писем временно недоступна');
  }
  async function sendAction(user: Account, kind: 'verify' | 'reset') {
    requireMail();
    await queueAccountAction(db, mail, settings.publicOrigin!, user, kind);
  }
  async function verifySecondFactor(user: Account, code: string) {
    if (!user.mfa_secret) return false;
    const counter = matchTotp(
      decrypt(user.mfa_secret, requireKey(key)),
      code,
      Date.now(),
      user.mfa_counter,
    );
    if (counter !== null) {
      const result = await q(
        'UPDATE accounts SET mfa_counter=? WHERE member_id=? AND mfa_counter<?',
        counter,
        user.member_id,
        counter,
      ).run();
      return Boolean(result.meta.changes);
    }
    if (/^[a-f0-9]{20}$/.test(code)) {
      const result = await q(
        'DELETE FROM recovery_codes WHERE member_id=? AND code_hash=? RETURNING member_id',
        user.member_id,
        digest(code),
      ).first();
      return Boolean(result);
    }
    return false;
  }
  async function makeRecoveryCodes(id: number) {
    const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
    await q('DELETE FROM recovery_codes WHERE member_id=?', id).run();
    for (const code of codes)
      await q(
        'INSERT INTO recovery_codes(member_id,code_hash) VALUES(?,?)',
        id,
        digest(code),
      ).run();
    return codes;
  }
  app.get('/api/auth/config', (_req, res) =>
    res.json({
      registration,
      passwordReset: mail.enabled && Boolean(settings.publicOrigin),
      mfa: Boolean(key),
    }),
  );
  app.post('/api/auth/register', async (req, res) => {
    if (!registration) throw new HttpError(503, 'Регистрация временно недоступна');
    const data = input(
      req,
      z
        .object({
          name: z.string().trim().min(2).max(80),
          email: emailSchema,
          password: passwordSchema,
        })
        .strict(),
    );
    await budget(req, 'registration', 10);
    await takeBudget(db, 'register-email:' + data.email, 3, 3600000);
    try {
      const created = await createAccount(db, data, false);
      await sendAction((await account(created.id))!, 'verify');
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code !== '23505' &&
        !(code === 'ERR_SQLITE_ERROR' && (error as { errcode?: number }).errcode === 2067)
      )
        throw error;
      if (!(await q('SELECT member_id FROM accounts WHERE email=?', data.email).first()))
        throw error;
    }
    res.status(202).json(generic);
  });
  app.post('/api/auth/forgot-password', async (req, res) => {
    requireMail();
    const data = input(req, z.object({ email: emailSchema }).strict());
    await budget(req, 'forgot', 10);
    await takeBudget(db, 'forgot-email:' + data.email, 3, 3600000);
    const user = await q('SELECT * FROM accounts WHERE email=?', data.email).first<Account>();
    if (user) await sendAction(user, 'reset');
    res.status(202).json(generic);
  });
  for (const kind of ['verify', 'reset'] as const) {
    app.post(
      '/api/auth/' + (kind === 'verify' ? 'verify-email' : 'reset-password'),
      async (req, res) => {
        const data = input(
          req,
          z.object({ token: tokenSchema, password: passwordSchema }).strict(),
        );
        await budget(req, 'consume-' + kind, 15);
        const action = await q(
          'SELECT member_id,password_version FROM account_actions WHERE token_hash=? AND kind=? AND used_at IS NULL AND expires_at>?',
          digest(data.token),
          kind,
          Date.now(),
        ).first<{ member_id: number; password_version: number }>();
        if (!action) throw new HttpError(410, 'Ссылка истекла или уже использована');
        const user = await account(action.member_id);
        if (!user || user.password_version !== action.password_version)
          throw new HttpError(410, 'Ссылка недействительна');
        if (kind === 'verify' && !(await passwordMatches(user, data.password)))
          throw new HttpError(400, 'Укажите пароль, выбранный при регистрации');
        const salt = randomBytes(16).toString('hex');
        const hash =
          kind === 'reset' ? (await passwordHash(data.password, salt)).toString('hex') : null;
        await db.transaction(async () => {
          const current = await account(user.member_id, true);
          const fresh = await q(
            'SELECT token_hash FROM account_actions WHERE token_hash=? AND kind=? AND used_at IS NULL AND expires_at>? AND password_version=?' +
              lockRows(db),
            digest(data.token),
            kind,
            Date.now(),
            current?.password_version ?? -1,
          ).first();
          if (!fresh) throw new HttpError(410, 'Ссылка истекла или уже использована');
          await q(
            'UPDATE account_actions SET used_at=? WHERE token_hash=?',
            Date.now(),
            digest(data.token),
          ).run();
          if (kind === 'reset') {
            await q(
              'UPDATE accounts SET password_salt=?,password_hash=?,email_verified=1,password_version=password_version+1 WHERE member_id=?',
              salt,
              hash,
              user.member_id,
            ).run();
            await q('DELETE FROM sessions WHERE member_id=?', user.member_id).run();
            await q('DELETE FROM mfa_challenges WHERE member_id=?', user.member_id).run();
          } else
            await q('UPDATE accounts SET email_verified=1 WHERE member_id=?', user.member_id).run();
        });
        res.json({ ok: true });
      },
    );
  }
  app.get('/api/auth/account', async (req, res) => {
    const actor = await requireActor(db, req),
      user = (await account(actor.id))!;
    res.json({
      id: actor.id,
      name: actor.name,
      email: user.email,
      emailVerified: Boolean(user.email_verified),
      mfaEnabled: Boolean(user.mfa_secret),
    });
  });
  app.get('/api/auth/sessions', async (req, res) => {
    const actor = await requireActor(db, req),
      current = digest(sessionToken(req)!);
    const rows = (
      await q(
        'SELECT session_id,created_at,expires_at,device,token_hash FROM sessions WHERE member_id=? AND expires_at>? ORDER BY created_at DESC',
        actor.id,
        Date.now(),
      ).all()
    ).results;
    res.json(rows.map(({ token_hash, ...row }) => ({ ...row, current: token_hash === current })));
  });
  app.delete('/api/auth/sessions/:id', async (req, res) => {
    const actor = await requireActor(db, req);
    if (!/^[a-f0-9]{32}$/.test(String(req.params.id)))
      throw new HttpError(400, 'Некорректная сессия');
    await q(
      'DELETE FROM sessions WHERE session_id=? AND member_id=?',
      req.params.id,
      actor.id,
    ).run();
    res.status(204).end();
  });
  app.post('/api/auth/sessions/revoke-others', async (req, res) => {
    const actor = await requireActor(db, req);
    await q(
      'DELETE FROM sessions WHERE member_id=? AND token_hash!=?',
      actor.id,
      digest(sessionToken(req)!),
    ).run();
    res.status(204).end();
  });
  app.post('/api/auth/mfa/setup', async (req, res) => {
    requireKey(key);
    const actor = await requireActor(db, req),
      data = input(req, z.object({ password: z.string().min(1).max(128) }).strict());
    await budget(req, 'mfa-setup');
    const old = (await account(actor.id))!;
    if (!(await passwordMatches(old, data.password))) throw new HttpError(401, 'Неверный пароль');
    const secret = mfaSecret();
    await db.transaction(async () => {
      const user = (await account(actor.id, true))!;
      if (user.password_version !== old.password_version)
        throw new HttpError(409, 'Учётные данные изменились');
      if (user.mfa_secret) throw new HttpError(409, 'Двухфакторная защита уже включена');
      await q(
        'UPDATE accounts SET mfa_pending=?,mfa_pending_until=? WHERE member_id=?',
        encrypt(secret, key!),
        Date.now() + 600000,
        actor.id,
      ).run();
    });
    const uri =
      'otpauth://totp/' +
      encodeURIComponent('Flowboard:' + old.email) +
      '?secret=' +
      secret +
      '&issuer=Flowboard&algorithm=SHA1&digits=6&period=30';
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { width: 220, margin: 2 }) });
  });
  app.post('/api/auth/mfa/enable', async (req, res) => {
    const actor = await requireActor(db, req),
      data = input(req, z.object({ code: codeSchema }).strict());
    await budget(req, 'mfa-enable');
    const result = await db.transaction(async () => {
      const user = (await account(actor.id, true))!;
      if (
        !user.mfa_pending ||
        !user.mfa_pending_until ||
        user.mfa_pending_until < Date.now() ||
        user.mfa_secret
      )
        throw new HttpError(410, 'Настройте двухфакторную защиту заново');
      const counter = matchTotp(decrypt(user.mfa_pending, requireKey(key)), data.code, Date.now());
      if (counter === null) throw new HttpError(400, 'Неверный код');
      await q(
        'UPDATE accounts SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_pending_until=NULL,mfa_counter=?,password_version=password_version+1 WHERE member_id=?',
        counter,
        actor.id,
      ).run();
      const codes = await makeRecoveryCodes(actor.id);
      await q('DELETE FROM sessions WHERE member_id=?', actor.id).run();
      const token = await establishSession(db, req, actor.id, user.password_version + 1, true);
      return { codes, token };
    });
    setSession(res, settings, result.token);
    res.json({ recoveryCodes: result.codes });
  });
  app.post('/api/auth/mfa/verify', async (req, res) => {
    const data = input(req, z.object({ challenge: tokenSchema, code: codeSchema }).strict());
    await budget(req, 'mfa-login', 30);
    const challenge = await q(
      'SELECT member_id FROM mfa_challenges WHERE token_hash=?',
      digest(data.challenge),
    ).first<{ member_id: number }>();
    if (!challenge) throw new HttpError(401, 'Повторите вход');
    const token = await db.transaction(async () => {
      const user = await account(challenge.member_id, true);
      const fresh = await q(
        'SELECT * FROM mfa_challenges WHERE token_hash=? AND expires_at>? AND attempts<5' +
          lockRows(db),
        digest(data.challenge),
        Date.now(),
      ).first<{ password_version: number }>();
      if (!user || !fresh || fresh.password_version !== user.password_version) return null;
      await q(
        'UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?',
        digest(data.challenge),
      ).run();
      if (!(await verifySecondFactor(user, data.code))) return null;
      await q('DELETE FROM mfa_challenges WHERE token_hash=?', digest(data.challenge)).run();
      return establishSession(db, req, user.member_id, user.password_version, true);
    });
    if (!token) throw new HttpError(401, 'Неверный код или срок входа истёк');
    setSession(res, settings, token);
    res.json({ ok: true });
  });
  app.post('/api/auth/mfa/disable', async (req, res) => {
    const actor = await requireActor(db, req),
      data = input(
        req,
        z.object({ password: z.string().min(1).max(128), code: codeSchema }).strict(),
      );
    await budget(req, 'mfa-disable');
    const old = (await account(actor.id))!;
    if (!(await passwordMatches(old, data.password))) throw new HttpError(401, 'Неверный пароль');
    const token = await db.transaction(async () => {
      const user = (await account(actor.id, true))!;
      if (
        user.password_version !== old.password_version ||
        !(await verifySecondFactor(user, data.code))
      )
        return null;
      await q(
        'UPDATE accounts SET mfa_secret=NULL,mfa_pending=NULL,mfa_counter=-1,password_version=password_version+1 WHERE member_id=?',
        actor.id,
      ).run();
      await q('DELETE FROM recovery_codes WHERE member_id=?', actor.id).run();
      await q('DELETE FROM sessions WHERE member_id=?', actor.id).run();
      return establishSession(db, req, actor.id, user.password_version + 1);
    });
    if (!token) throw new HttpError(401, 'Неверный код');
    setSession(res, settings, token);
    res.json({ ok: true });
  });
  return mail;
}
