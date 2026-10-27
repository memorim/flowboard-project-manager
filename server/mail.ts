import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import type { Store } from './sqlite-adapter.js';
import { decrypt, encrypt } from './account-crypto.js';
import { lockRows } from './auth.js';
import { HttpError } from '../src/flow-http.js';

export type Mail = { to: string; subject: string; text: string };
export type MailSender = (message: Mail & { id: string }) => Promise<void>;
export function smtpSender(env: NodeJS.ProcessEnv = process.env): MailSender | undefined {
  if (!env.SMTP_HOST) return undefined;
  const port = Number(env.SMTP_PORT || 587),
    from = env.SMTP_FROM || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[^\r\n]+@[^\r\n]+$/.test(from))
    throw new Error('Configure SMTP_PORT and SMTP_FROM');
  const local =
    env.NODE_ENV !== 'production' &&
    (['localhost', '127.0.0.1', '::1'].includes(env.SMTP_HOST) ||
      env.FLOW_SMTP_ALLOW_PLAINTEXT === 'true');
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: !local && port !== 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (message) => {
    await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      messageId:
        '<flowboard-' +
        message.id +
        '@' +
        from
          .split('@')
          .pop()!
          .replace(/[^a-z0-9.-]/gi, '') +
        '>',
    });
  };
}
export function mailQueue(db: Store, key?: Buffer, send?: MailSender) {
  let running: Promise<void> | undefined,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const enabled = Boolean(key && send);
  return {
    enabled,
    async enqueue(mail: Mail) {
      if (!key || !send) throw new HttpError(503, 'Отправка писем временно недоступна');
      await db
        .prepare('INSERT INTO mail_outbox(id,payload,created_at,next_attempt_at) VALUES(?,?,?,?)')
        .bind(randomUUID(), encrypt(JSON.stringify(mail), key), Date.now(), Date.now())
        .run();
    },
    run(): Promise<void> {
      if (!enabled || stopped || running) return running || Promise.resolve();
      running = (async () => {
        const now = Date.now();
        await db
          .prepare(
            'UPDATE mail_outbox SET failed_at=? WHERE delivered_at IS NULL AND failed_at IS NULL AND attempts>=5 AND lease_until<=?',
          )
          .bind(now, now)
          .run();
        for (let i = 0; i < 10 && !stopped; i++) {
          const row = await db.transaction(async () => {
            const item = await db
              .prepare(
                'SELECT id,payload,attempts FROM mail_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND attempts<5 AND next_attempt_at<=? AND lease_until<=? ORDER BY created_at LIMIT 1' +
                  lockRows(db),
              )
              .bind(Date.now(), Date.now())
              .first<{ id: string; payload: string; attempts: number }>();
            if (!item) return null;
            const lease = randomUUID();
            await db
              .prepare(
                'UPDATE mail_outbox SET attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?',
              )
              .bind(Date.now() + 120000, lease, item.id)
              .run();
            return { ...item, lease };
          });
          if (!row) break;
          try {
            const mail = JSON.parse(decrypt(row.payload, key!)) as Mail;
            await send!({ ...mail, id: row.id });
            await db
              .prepare(
                'UPDATE mail_outbox SET delivered_at=?,lease_until=0,lease_token=NULL,payload=? WHERE id=? AND lease_token=?',
              )
              .bind(Date.now(), '', row.id, row.lease)
              .run();
          } catch {
            await db
              .prepare(
                'UPDATE mail_outbox SET next_attempt_at=?,lease_until=0,lease_token=NULL,failed_at=? WHERE id=? AND lease_token=?',
              )
              .bind(
                Date.now() + Math.min(300000, 5000 * 2 ** row.attempts),
                row.attempts + 1 >= 5 ? Date.now() : null,
                row.id,
                row.lease,
              )
              .run();
          }
        }
        await db.prepare('DELETE FROM request_budgets WHERE expires_at<?').bind(Date.now()).run();
        await db
          .prepare('DELETE FROM account_actions WHERE expires_at<?')
          .bind(Date.now() - 86400000)
          .run();
        await db.prepare('DELETE FROM mfa_challenges WHERE expires_at<?').bind(Date.now()).run();
        await db
          .prepare('DELETE FROM mail_outbox WHERE delivered_at<? OR failed_at<?')
          .bind(Date.now() - 7 * 86400000, Date.now() - 7 * 86400000)
          .run();
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    start() {
      if (!enabled || stopped || timer) return;
      const tick = async () => {
        try {
          await this.run();
        } catch {
          console.error(JSON.stringify({ event: 'mail_cycle', status: 'failed' }));
        }
        if (!stopped) {
          timer = setTimeout(tick, 5000);
          timer.unref();
        }
      };
      void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
export type MailQueue = ReturnType<typeof mailQueue>;
