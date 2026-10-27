import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { createAccount } from '../server/auth.js';
import { asStore } from '../server/sqlite-adapter.js';
import { digest, totp } from '../server/account-crypto.js';
import { takeBudget } from '../server/rate-limit.js';
import type { Mail } from '../server/mail.js';

process.env.FLOW_PUBLIC_ORIGIN = 'http://localhost:4100';
const password = 'Unique-fixture-password-2026';
function fixture() {
  const db = createDatabase(':memory:'),
    messages: Mail[] = [],
    key = randomBytes(32);
  const app = createApp(db, () => {}, {
    accounts: {
      key,
      sendMail: async (mail) => {
        messages.push(mail);
      },
    },
  });
  const flush = () => app.locals.mail.run();
  const token = () =>
    new URL(messages.at(-1)!.text.match(/http:\/\/localhost:4100\/\S+/)![0]).searchParams.get(
      'token',
    )!;
  return { db, app, messages, key, flush, token };
}
test('TOTP matches every RFC 6238 SHA1 test vector', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const)
    assert.equal(totp(secret, Math.floor(seconds / 30), 8), expected);
});
test('signup verifies email and the chosen password; tokens and mail are not stored in plaintext', async () => {
  const f = fixture();
  try {
    const agent = request.agent(f.app);
    assert.equal((await agent.get('/api/auth/config')).body.registration, true);
    const body = { name: 'New member', email: 'new@example.test', password };
    const registered = await agent.post('/api/auth/register').send(body);
    assert.equal(registered.status, 202);
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: body.email, password })).status,
      401,
    );
    await f.flush();
    const token = f.token();
    assert.equal(f.messages.length, 1);
    assert.equal(
      f.db.prepare('SELECT token_hash FROM account_actions').get()!.token_hash,
      digest(token),
    );
    assert.ok(
      !String(f.db.prepare('SELECT payload FROM mail_outbox').get()!.payload).includes(token),
    );
    assert.equal(
      (
        await agent
          .post('/api/auth/verify-email')
          .send({ token, password: 'Wrong-password-value-2026' })
      ).status,
      400,
    );
    assert.equal(
      (await agent.post('/api/auth/verify-email').send({ token, password })).status,
      200,
    );
    assert.equal(
      (await agent.post('/api/auth/verify-email').send({ token, password })).status,
      410,
    );
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: body.email, password })).status,
      200,
    );
    const duplicate = await agent.post('/api/auth/register').send(body);
    assert.equal(duplicate.status, 202);
    assert.deepEqual(duplicate.body, registered.body);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM accounts').get()!.n, 1);
    assert.equal(
      (await agent.post('/api/auth/register').send({ ...body, memberId: 4 })).status,
      400,
    );
    assert.equal(
      (await agent.post('/api/auth/register').set('Origin', 'https://other.test').send(body))
        .status,
      403,
    );
  } finally {
    f.db.close();
  }
});
test('password reset is single-use under concurrency, expires and revokes every previous session', async () => {
  const f = fixture();
  try {
    await createAccount(f.db, { name: 'Owner', email: 'owner@example.test', password });
    const agent = request.agent(f.app),
      other = request.agent(f.app);
    for (const a of [agent, other])
      assert.equal(
        (await a.post('/api/auth/login').send({ email: 'owner@example.test', password })).status,
        200,
      );
    const existing = await agent
      .post('/api/auth/forgot-password')
      .send({ email: 'owner@example.test' });
    const missing = await agent
      .post('/api/auth/forgot-password')
      .send({ email: 'missing@example.test' });
    assert.equal(existing.status, 202);
    assert.deepEqual(existing.body, missing.body);
    await f.flush();
    const token = f.token(),
      next = 'Changed-fixture-password-2026';
    const changed = await Promise.all(
      [request(f.app), request(f.app)].map((a) =>
        a.post('/api/auth/reset-password').send({ token, password: next }),
      ),
    );
    assert.deepEqual(changed.map((r) => r.status).sort(), [200, 410]);
    assert.equal((await agent.get('/api/session')).body.user, null);
    assert.equal((await other.get('/api/session')).body.user, null);
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: 'owner@example.test', password })).status,
      401,
    );
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: 'owner@example.test', password: next }))
        .status,
      200,
    );
    await agent.post('/api/auth/forgot-password').send({ email: 'owner@example.test' });
    await f.flush();
    f.db.prepare('UPDATE account_actions SET expires_at=1 WHERE used_at IS NULL').run();
    assert.equal(
      (await agent.post('/api/auth/reset-password').send({ token: f.token(), password })).status,
      410,
    );
  } finally {
    f.db.close();
  }
});
test('MFA gates login, rejects reused OTP/recovery codes, and password reset keeps MFA enabled', async () => {
  const f = fixture();
  try {
    const user = await createAccount(f.db, {
      name: 'Owner',
      email: 'owner@example.test',
      password,
    });
    const owner = request.agent(f.app),
      stranger = request.agent(f.app);
    await owner.post('/api/auth/login').send({ email: 'owner@example.test', password });
    const setup = await owner.post('/api/auth/mfa/setup').send({ password });
    assert.equal(setup.status, 200);
    assert.match(setup.body.qr, /^data:image\/png;base64,/);
    assert.notEqual(
      f.db.prepare('SELECT mfa_pending FROM accounts WHERE member_id=?').get(user.id)!.mfa_pending,
      setup.body.secret,
    );
    const code = totp(setup.body.secret, Math.floor(Date.now() / 30000));
    const enabled = await owner.post('/api/auth/mfa/enable').send({ code });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.recoveryCodes.length, 10);
    const login = await stranger
      .post('/api/auth/login')
      .send({ email: 'owner@example.test', password });
    assert.equal(login.body.mfaRequired, true);
    assert.equal(login.headers['set-cookie'], undefined);
    assert.equal((await stranger.get('/api/session')).body.user, null);
    assert.equal(
      (await stranger.post('/api/auth/mfa/verify').send({ challenge: login.body.challenge, code }))
        .status,
      401,
    );
    const recovery = enabled.body.recoveryCodes[0];
    const verified = await stranger
      .post('/api/auth/mfa/verify')
      .send({ challenge: login.body.challenge, code: recovery });
    assert.equal(verified.status, 200);
    assert.equal(
      (
        await stranger
          .post('/api/auth/mfa/verify')
          .send({ challenge: login.body.challenge, code: recovery })
      ).status,
      401,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE code_hash=?').get(digest(recovery))!
        .n,
      0,
    );
    const sessions = await owner.get('/api/auth/sessions');
    assert.equal(sessions.body.length, 2);
    assert.ok(sessions.body.every((s: Record<string, unknown>) => !('token_hash' in s)));
    await owner.post('/api/auth/sessions/revoke-others');
    assert.equal((await stranger.get('/api/session')).body.user, null);
    await owner.post('/api/auth/forgot-password').send({ email: 'owner@example.test' });
    await f.flush();
    assert.equal(
      (await owner.post('/api/auth/reset-password').send({ token: f.token(), password })).status,
      200,
    );
    assert.equal((await owner.get('/api/session')).body.user, null);
    const after = await owner
      .post('/api/auth/login')
      .send({ email: 'owner@example.test', password });
    assert.equal(after.body.mfaRequired, true);
    assert.equal(
      (
        await owner
          .post('/api/auth/mfa/verify')
          .send({ challenge: after.body.challenge, code: enabled.body.recoveryCodes[1] })
      ).status,
      200,
    );
    const disabled = await owner
      .post('/api/auth/mfa/disable')
      .send({ password, code: enabled.body.recoveryCodes[2] });
    assert.equal(disabled.status, 200);
    assert.equal((await owner.get('/api/auth/account')).body.mfaEnabled, false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recovery_codes').get()!.n, 0);
  } finally {
    f.db.close();
  }
});
test('shared database budgets are atomic, and an async rollback never includes another request', async () => {
  const db = createDatabase(':memory:'),
    store = asStore(db);
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => takeBudget(store, 'same', 5, 600000)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    let release!: () => void, entered!: () => void;
    const pause = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const rejected = store.transaction(async () => {
      await store
        .prepare("INSERT INTO workspaces(name,is_public) VALUES('Must roll back',0)")
        .run();
      entered();
      await pause;
      throw new Error('forced rollback');
    });
    await ready;
    const preserved = store
      .prepare("INSERT INTO workspaces(name,is_public) VALUES('Separate request',0)")
      .run();
    release();
    await assert.rejects(rejected);
    await preserved;
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM workspaces WHERE name='Must roll back'").get()!.n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM workspaces WHERE name='Separate request'").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});
