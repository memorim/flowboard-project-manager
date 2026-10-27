import { z } from 'zod';
import type { Express } from 'express';
import type { Store } from './sqlite-adapter.js';
import { input, jsonInput, lockRows, type AuthSettings } from './auth.js';
import { workspaceOwner } from './workspace-integrations.js';
import { HttpError } from '../src/flow-http.js';
import { digest, randomToken } from './account-crypto.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { takeBudget } from './rate-limit.js';

const paymentSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['pending', 'succeeded', 'canceled']),
    paid: z.boolean(),
    test: z.boolean(),
    amount: z.object({ value: z.string(), currency: z.literal('RUB') }),
    metadata: z.object({
      flowboard_payment_id: z.string().uuid(),
      flowboard_workspace: z.string(),
    }),
    confirmation: z.object({ confirmation_url: z.string().url() }).passthrough().optional(),
  })
  .passthrough();
export type ProviderPayment = z.infer<typeof paymentSchema>;
export type PaymentClient = {
  create: (
    id: string,
    workspace: number,
    amount: number,
    returnUrl: string,
    signal?: AbortSignal,
  ) => Promise<ProviderPayment>;
  read: (id: string, signal?: AbortSignal) => Promise<ProviderPayment>;
};
export type BillingOptions = {
  client?: PaymentClient;
  priceCents?: number;
  webhookToken?: string;
  allowLive?: boolean;
};
type PaymentRow = {
  id: string;
  workspace_id: number;
  amount_cents: number;
  provider_id: string | null;
  request_key: string;
  status: string;
  confirmation_url: string | null;
  created_at: number;
  applied_at: number | null;
};
const decimal = (cents: number) =>
  Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
export function yookassaClient(env: NodeJS.ProcessEnv = process.env): PaymentClient | undefined {
  if (!env.YOOKASSA_SHOP_ID && !env.YOOKASSA_SECRET_KEY) return undefined;
  if (
    !/^\d{1,20}$/.test(env.YOOKASSA_SHOP_ID || '') ||
    !env.YOOKASSA_SECRET_KEY ||
    /[\r\n]/.test(env.YOOKASSA_SECRET_KEY)
  )
    throw new Error('Configure YooKassa shop ID and secret');
  const authorization =
    'Basic ' + Buffer.from(env.YOOKASSA_SHOP_ID + ':' + env.YOOKASSA_SECRET_KEY).toString('base64');
  async function call(
    path: string,
    method: string,
    body?: object,
    key?: string,
    signal?: AbortSignal,
  ) {
    const response = await fetch('https://api.yookassa.ru/v3' + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotence-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, 'Платёжный сервис временно недоступен');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing payment response');
    let text = '',
      size = 0;
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new Error('Payment response too large');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return paymentSchema.parse(JSON.parse(text));
  }
  return {
    create: (id, workspace, amount, returnUrl, signal) =>
      call(
        '/payments',
        'POST',
        {
          amount: { value: decimal(amount), currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: returnUrl },
          description: 'Flowboard — план Команда на 30 дней',
          metadata: { flowboard_payment_id: id, flowboard_workspace: String(workspace) },
        },
        id,
        signal,
      ),
    read: (id, signal) =>
      call('/payments/' + encodeURIComponent(id), 'GET', undefined, undefined, signal),
  };
}
export function installBilling(
  app: Express,
  db: Store,
  settings: AuthSettings,
  options: BillingOptions = {},
) {
  const client = options.client || yookassaClient(),
    price = options.priceCents ?? Number(process.env.FLOW_TEAM_PRICE_CENTS || 99000);
  const webhookToken = options.webhookToken || process.env.FLOW_YOOKASSA_WEBHOOK_TOKEN || '',
    allowLive = options.allowLive ?? process.env.FLOW_BILLING_ALLOW_LIVE === 'true';
  if (!Number.isSafeInteger(price) || price < 100 || price > 100000000)
    throw new Error('Invalid FLOW_TEAM_PRICE_CENTS');
  if (webhookToken && !/^[a-f0-9]{64}$/.test(webhookToken))
    throw new Error('Webhook token must contain 32 random bytes in hex');
  const enabled = Boolean(client && settings.publicOrigin && webhookToken);
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  let stopped = false,
    running: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  function validate(payment: ProviderPayment, row: PaymentRow) {
    if (
      payment.metadata.flowboard_payment_id !== row.id ||
      payment.metadata.flowboard_workspace !== String(row.workspace_id) ||
      payment.amount.value !== decimal(row.amount_cents) ||
      payment.amount.currency !== 'RUB' ||
      (!allowLive && !payment.test)
    )
      throw new HttpError(502, 'Платёж не соответствует ожидаемым параметрам');
    if (payment.status === 'succeeded' && !payment.paid)
      throw new HttpError(502, 'Оплата не подтверждена');
    if (payment.confirmation) {
      const url = new URL(payment.confirmation.confirmation_url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !['yoomoney.ru', 'yookassa.ru'].includes(url.hostname) ||
        !['', '443'].includes(url.port)
      )
        throw new HttpError(502, 'Недопустимый адрес оплаты');
    }
  }
  async function apply(payment: ProviderPayment) {
    return db.transaction(async () => {
      const row = await q(
        'SELECT * FROM workspace_payments WHERE id=?' + lockRows(db),
        payment.metadata.flowboard_payment_id,
      ).first<PaymentRow>();
      if (!row) return null;
      validate(payment, row);
      if (row.provider_id && row.provider_id !== payment.id)
        throw new HttpError(409, 'Уже зарегистрирован другой платёж');
      const status = row.applied_at ? 'succeeded' : payment.status;
      await q(
        'UPDATE workspace_payments SET provider_id=?,status=?,confirmation_url=?,is_test=? WHERE id=?',
        payment.id,
        status,
        payment.confirmation?.confirmation_url || row.confirmation_url,
        Number(payment.test),
        row.id,
      ).run();
      if (payment.status === 'succeeded' && !row.applied_at) {
        await q(
          'INSERT INTO workspace_plans(workspace_id,valid_until) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET valid_until=CASE WHEN workspace_plans.valid_until>? THEN workspace_plans.valid_until+? ELSE ? END',
          row.workspace_id,
          Date.now() + 30 * 86400000,
          Date.now(),
          30 * 86400000,
          Date.now() + 30 * 86400000,
        ).run();
        await q('UPDATE workspace_payments SET applied_at=? WHERE id=?', Date.now(), row.id).run();
      }
      return row.id;
    });
  }
  async function refresh(row: PaymentRow, signal?: AbortSignal) {
    if (!client) return;
    // ponytail: the provider keeps idempotency keys for 24h; unknown older requests need manual reconciliation, never a new charge.
    if (!row.provider_id && Date.now() - row.created_at >= 23 * 3600000) return;
    await apply(
      row.provider_id
        ? await client.read(row.provider_id, signal)
        : await client.create(
            row.id,
            row.workspace_id,
            row.amount_cents,
            settings.publicOrigin + '/?billing=return',
            signal,
          ),
    );
  }
  app.get('/api/billing', async (req, res) => {
    const { workspace } = await workspaceOwner(db, req),
      plan = await q(
        'SELECT valid_until FROM workspace_plans WHERE workspace_id=?',
        workspace,
      ).first<{ valid_until: number }>();
    const payments = (
      await q(
        'SELECT id,amount_cents,status,created_at,applied_at,is_test FROM workspace_payments WHERE workspace_id=? ORDER BY created_at DESC LIMIT 30',
        workspace,
      ).all()
    ).results;
    res.set('Cache-Control', 'no-store').json({
      enabled,
      testMode: !allowLive,
      amountCents: price,
      currency: 'RUB',
      validUntil: plan?.valid_until || null,
      payments,
    });
  });
  app.post('/api/billing/checkout', async (req, res) => {
    if (!enabled) throw new HttpError(503, 'Оплата временно недоступна');
    input(req, z.object({ plan: z.literal('team') }).strict());
    const rawKey = req.get('Idempotency-Key');
    if (!rawKey || !/^[A-Za-z0-9_-]{8,128}$/.test(rawKey))
      throw new HttpError(400, 'Нужен ключ операции');
    const row = await db.transaction(async () => {
      const { actor, workspace } = await workspaceOwner(db, req);
      await takeBudget(db, 'checkout:' + actor.id, 5, 600000);
      const key = actor.id + ':' + workspace + ':' + rawKey;
      const existing = await q(
        'SELECT * FROM workspace_payments WHERE request_key=?',
        key,
      ).first<PaymentRow>();
      if (existing) return existing;
      const id = randomUUID(),
        now = Date.now();
      await q(
        'INSERT INTO workspace_payments(id,workspace_id,created_by,amount_cents,request_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING',
        id,
        workspace,
        actor.id,
        price,
        key,
        now,
      ).run();
      return (await q(
        'SELECT * FROM workspace_payments WHERE request_key=?',
        key,
      ).first<PaymentRow>())!;
    });
    if (!row.provider_id && Date.now() - row.created_at >= 23 * 3600000)
      throw new HttpError(409, 'Статус операции требует сверки. Не создавайте повторный платёж.');
    const remote = row.provider_id
      ? await client!.read(row.provider_id)
      : await client!.create(
          row.id,
          row.workspace_id,
          row.amount_cents,
          settings.publicOrigin + '/?billing=return',
        );
    validate(remote, row);
    await apply(remote);
    res.set('Cache-Control', 'no-store').json({
      id: row.id,
      status: remote.status,
      confirmationUrl: remote.confirmation?.confirmation_url || null,
      test: remote.test,
    });
  });
  app.post('/api/billing/payments/:id/refresh', async (req, res) => {
    if (!enabled) throw new HttpError(503, 'Оплата временно недоступна');
    const { workspace, actor } = await workspaceOwner(db, req);
    await takeBudget(db, 'payment-refresh:' + actor.id, 15, 600000);
    const row = await q(
      'SELECT * FROM workspace_payments WHERE id=? AND workspace_id=?',
      req.params.id,
      workspace,
    ).first<PaymentRow>();
    if (!row) throw new HttpError(404, 'Платёж не найден');
    await refresh(row);
    res.json({ ok: true });
  });
  app.post('/api/billing/webhook', async (req, res) => {
    const supplied = typeof req.query.token === 'string' ? req.query.token : '';
    if (
      !enabled ||
      !supplied ||
      !timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(webhookToken)))
    )
      throw new HttpError(401, 'Недопустимое уведомление');
    await takeBudget(db, 'billing-webhook', 120, 60000);
    const event = z
      .object({
        type: z.literal('notification'),
        event: z.string().max(80),
        object: z.object({ id: z.string().uuid() }).passthrough(),
      })
      .passthrough()
      .safeParse(jsonInput(req));
    if (!event.success) throw new HttpError(400, 'Некорректное уведомление');
    // The callback is only a hint. Trusted state is fetched from the merchant API.
    const payment = await client!.read(event.data.object.id);
    await apply(payment);
    res.json({ ok: true });
  });
  return {
    enabled,
    run() {
      if (!enabled || stopped || running) return running || Promise.resolve();
      running = (async () => {
        for (let i = 0; i < 10 && !stopped; i++) {
          const leased = await db.transaction(async () => {
            const row = await q(
              "SELECT * FROM workspace_payments WHERE status='pending' AND (provider_id IS NOT NULL OR created_at>?) AND next_check_at<=? AND check_lease_until<=? ORDER BY created_at LIMIT 1" +
                lockRows(db),
              Date.now() - 23 * 3600000,
              Date.now(),
              Date.now(),
            ).first<PaymentRow>();
            if (!row) return null;
            const lease = randomToken();
            await q(
              'UPDATE workspace_payments SET check_lease_until=?,check_lease_token=? WHERE id=?',
              Date.now() + 60000,
              lease,
              row.id,
            ).run();
            return { row, lease };
          });
          if (!leased) break;
          try {
            await refresh(leased.row, controller.signal);
          } catch {
            console.error(
              JSON.stringify({ event: 'payment_reconcile', status: 'retry', id: leased.row.id }),
            );
          }
          await q(
            'UPDATE workspace_payments SET next_check_at=?,check_lease_until=0,check_lease_token=NULL WHERE id=? AND check_lease_token=?',
            Date.now() + 300000,
            leased.row.id,
            leased.lease,
          ).run();
        }
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
          console.error(JSON.stringify({ event: 'payment_cycle', status: 'failed' }));
        }
        if (!stopped) {
          timer = setTimeout(tick, 60000);
          timer.unref();
        }
      };
      void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await running;
    },
  };
}
