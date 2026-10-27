import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { createDatabase } from '../server/db.js';
import { asStore, type Store } from '../server/sqlite-adapter.js';
import { createPostgresStore } from '../server/postgres.js';
import { createApp } from '../server/app.js';
import { createAccount } from '../server/auth.js';
import type { PaymentClient, ProviderPayment } from '../server/billing.js';
process.env.FLOW_PUBLIC_ORIGIN = 'http://localhost:4100';
async function scenario(db: Store) {
  const payments = new Map<string, ProviderPayment>();
  const remoteIds = new Map<string, string>();
  let loseResponse = false;
  const client: PaymentClient = {
    async create(id, workspace, amount) {
      if (!payments.has(id)) {
        const remote = randomUUID();
        payments.set(id, {
          id: remote,
          status: 'pending',
          paid: false,
          test: true,
          amount: { value: (amount / 100).toFixed(2), currency: 'RUB' },
          metadata: { flowboard_payment_id: id, flowboard_workspace: String(workspace) },
          confirmation: {
            confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=' + remote,
          },
        });
        remoteIds.set(remote, id);
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error('Lost HTTP response');
      }
      return structuredClone(payments.get(id)!);
    },
    async read(id) {
      return structuredClone(payments.get(remoteIds.get(id)!)!);
    },
  };
  const webhookToken = 'a'.repeat(64),
    password = 'Billing-fixture-password-2026';
  const app = createApp(db, () => {}, { billing: { client, priceCents: 12345, webhookToken } });
  await createAccount(db, { name: 'Owner', email: 'billing@example.test', password });
  await createAccount(db, { name: 'Outsider', email: 'outsider@example.test', password });
  const owner = request.agent(app),
    outsider = request.agent(app);
  await owner.post('/api/auth/login').send({ email: 'billing@example.test', password });
  await outsider.post('/api/auth/login').send({ email: 'outsider@example.test', password });
  const workspace = (await owner.post('/api/workspaces').send({ name: 'Billing team' })).body.id;
  db.limits!.projects = 1;
  assert.equal(
    (await owner.post('/api/projects?workspace=' + workspace).send({ name: 'Before payment' }))
      .status,
    429,
  );
  const checkout = (key: string, body: object = { plan: 'team' }) =>
    owner
      .post('/api/billing/checkout?workspace=' + workspace)
      .set('Idempotency-Key', key)
      .send(body);
  assert.equal((await outsider.get('/api/billing?workspace=' + workspace)).status, 403);
  assert.equal((await checkout('invalid-body', { plan: 'team', amount: 1 })).status, 400);
  const first = await checkout('payment-one');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(payments.size, 1);
  assert.equal([...payments.values()][0].amount.value, '123.45');
  const again = await checkout('payment-one');
  assert.equal(again.body.id, first.body.id);
  assert.equal(payments.size, 1);
  const remote = payments.get(first.body.id)!;
  remote.status = 'succeeded';
  remote.paid = true;
  const event = {
    type: 'notification',
    event: 'payment.succeeded',
    object: { id: remote.id, status: 'succeeded' },
  };
  assert.equal(
    (await request(app).post('/api/billing/webhook?token=wrong').send(event)).status,
    401,
  );
  assert.equal((await owner.get('/api/billing?workspace=' + workspace)).body.validUntil, null);
  // Callback claims do not confer payment: the merchant API must agree.
  remote.status = 'pending';
  remote.paid = false;
  assert.equal(
    (
      await request(app)
        .post('/api/billing/webhook?token=' + webhookToken)
        .send(event)
    ).status,
    200,
  );
  assert.equal((await owner.get('/api/billing?workspace=' + workspace)).body.validUntil, null);
  remote.status = 'succeeded';
  remote.paid = true;
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(app)
        .post('/api/billing/webhook?token=' + webhookToken)
        .send(event),
    ),
  );
  assert.ok(replies.every((r) => r.status === 200));
  const until = (await owner.get('/api/billing?workspace=' + workspace)).body.validUntil;
  assert.ok(Math.abs(until - Date.now() - 30 * 86400000) < 5000);
  assert.equal(
    (await owner.post('/api/projects?workspace=' + workspace).send({ name: 'Paid plan project' }))
      .status,
    201,
  );
  assert.equal(
    (await db
      .prepare('SELECT COUNT(*) n FROM workspace_payments WHERE applied_at IS NOT NULL')
      .first<{ n: number }>())!.n,
    1,
  );
  remote.status = 'pending';
  remote.paid = false;
  await request(app)
    .post('/api/billing/webhook?token=' + webhookToken)
    .send(event);
  assert.equal(
    (await owner.get('/api/billing?workspace=' + workspace)).body.payments[0].status,
    'succeeded',
  );
  loseResponse = true;
  assert.equal((await checkout('lost-response')).status, 503);
  await app.locals.billing.run();
  const recovered = (await db
    .prepare('SELECT * FROM workspace_payments WHERE request_key LIKE ?')
    .bind('%lost-response')
    .first<{ id: string; provider_id: string }>())!;
  assert.ok(recovered.provider_id);
  assert.equal(payments.size, 2);
  const wrong = payments.get(recovered.id)!;
  wrong.amount.value = '0.01';
  wrong.status = 'succeeded';
  wrong.paid = true;
  assert.equal(
    (await owner.post('/api/billing/payments/' + recovered.id + '/refresh?workspace=' + workspace))
      .status,
    502,
  );
  wrong.amount.value = '123.45';
  wrong.test = false;
  assert.equal(
    (await owner.post('/api/billing/payments/' + recovered.id + '/refresh?workspace=' + workspace))
      .status,
    502,
  );
  wrong.test = true;
  assert.equal(
    (await owner.post('/api/billing/payments/' + recovered.id + '/refresh?workspace=' + workspace))
      .status,
    200,
  );
  assert.equal(
    (await owner.get('/api/billing?workspace=' + workspace)).body.validUntil,
    until + 30 * 86400000,
  );
  assert.equal(
    (
      await outsider.post(
        '/api/billing/payments/' + recovered.id + '/refresh?workspace=' + workspace,
      )
    ).status,
    403,
  );
  await app.locals.billing.stop();
}
test('payment idempotency, trusted reconciliation, amount checks and exactly-once plan application on SQLite', async () => {
  const db = asStore(createDatabase(':memory:'));
  try {
    await scenario(db);
  } finally {
    await db.close();
  }
});
test(
  'payment invariants on real PostgreSQL',
  { skip: !process.env.FLOW_TEST_DATABASE_URL },
  async () => {
    const url = process.env.FLOW_TEST_DATABASE_URL!,
      schema = 'flow_pay_' + randomUUID().replaceAll('-', '').slice(0, 24),
      db = await createPostgresStore(url, schema);
    try {
      await scenario(db);
    } finally {
      await db.close();
      const pool = new Pool({ connectionString: url });
      try {
        await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await pool.end();
      }
    }
  },
);
