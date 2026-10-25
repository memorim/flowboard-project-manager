import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';
import { authConfiguration, createAccount } from '../server/auth.js';

const password = 'Correct-fixture-password-2026';

test('configuration fails closed for public/production demonstration identity', () => {
  assert.equal(authConfiguration({}).mode, 'session');
  assert.throws(() => authConfiguration({ FLOW_AUTH_MODE: 'unexpected' }));
  assert.throws(() => authConfiguration({ FLOW_AUTH_MODE: 'demo', NODE_ENV: 'production' }));
  assert.throws(() => authConfiguration({ FLOW_AUTH_MODE: 'demo', HOST: '0.0.0.0' }));
  assert.throws(() => authConfiguration({ NODE_ENV: 'production' }));
  assert.throws(() =>
    authConfiguration({ NODE_ENV: 'production', FLOW_PUBLIC_ORIGIN: 'http://example.test' }),
  );
  assert.throws(() => authConfiguration({ FLOW_PUBLIC_ORIGIN: 'https://user:pass@example.test' }));
  assert.equal(
    authConfiguration({ NODE_ENV: 'production', FLOW_PUBLIC_ORIGIN: 'https://example.test' })
      .secureCookies,
    true,
  );
});

test('opaque hashed sessions rotate, expire and are revoked on logout; passwords are not stored', async () => {
  const db = createDatabase(':memory:');
  try {
    const user = await createAccount(db, { email: 'owner@example.test', name: 'Owner', password });
    const app = createApp(db, () => {}),
      agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'OWNER@example.test', password });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const token = cookie.split('=')[1],
      stored = db.prepare('SELECT token_hash FROM sessions').get();
    assert.equal(stored?.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored?.token_hash, token);
    assert.notEqual(
      db.prepare('SELECT password_hash FROM accounts').get()?.password_hash,
      password,
    );
    assert.equal((await agent.get('/api/session').set('X-Demo-Actor', '1')).body.user.id, user.id);
    assert.equal(
      (await agent.get('/api/session')).body.canWrite,
      false,
      'sample workspace is read-only for new real accounts',
    );
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: 'owner@example.test', password })).status,
      200,
    );
    assert.equal(
      (await request(app).get('/api/session').set('Cookie', cookie)).body.user,
      null,
      'old session revoked by rotation',
    );
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get()?.n, 1);
    assert.equal((await agent.post('/api/auth/logout')).status, 204);
    assert.equal((await agent.get('/api/session')).body.user, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get()?.n, 0);
    await agent.post('/api/auth/login').send({ email: 'owner@example.test', password });
    db.prepare('UPDATE sessions SET expires_at=?').run(Date.now() - 1);
    assert.equal((await agent.get('/api/session')).body.user, null);
    assert.equal(
      (
        await request(app)
          .get('/api/session')
          .set('Cookie', 'flowboard_session=' + 'a'.repeat(64))
      ).body.user,
      null,
    );
  } finally {
    db.close();
  }
});

test('real accounts enforce ownership, roles, invitation access, conflict detection and revocation', async () => {
  const db = createDatabase(':memory:');
  try {
    const ownerUser = await createAccount(db, {
      email: 'owner@example.test',
      name: 'Owner',
      password,
    });
    const otherUser = await createAccount(db, {
      email: 'other@example.test',
      name: 'Other',
      password,
    });
    const app = createApp(db, () => {}),
      owner = request.agent(app),
      other = request.agent(app);
    for (const [agent, email] of [
      [owner, 'owner@example.test'],
      [other, 'other@example.test'],
    ] as const)
      assert.equal((await agent.post('/api/auth/login').send({ email, password })).status, 200);
    const workspace = await owner.post('/api/workspaces').send({ name: 'Private owner team' });
    assert.equal(workspace.status, 201);
    const suffix = '?workspace=' + workspace.body.id;
    const project = db
      .prepare('SELECT id FROM projects WHERE workspace_id=?')
      .get(workspace.body.id);
    const task = await owner.post('/api/tasks' + suffix).send({
      title: 'Protected task',
      description: 'Original',
      status: 'todo',
      priority: 'medium',
      projectId: project?.id,
      assigneeId: ownerUser.id,
      dueDate: '2030-01-10',
    });
    assert.equal(task.status, 201);
    for (const path of [
      '/api/meta',
      '/api/tasks',
      '/api/tasks/' + task.body.id + '/history',
      '/api/export',
    ])
      assert.equal(
        (await other.get(path + suffix).set('X-Demo-Actor', String(ownerUser.id))).status,
        404,
        path,
      );
    assert.equal(
      (
        await other
          .patch('/api/tasks/' + task.body.id + '/status' + suffix)
          .send({ status: 'done', version: 1 })
      ).status,
      404,
    );
    const invite = await owner.post('/api/invitations' + suffix).send({ role: 'viewer' });
    assert.equal(invite.status, 201);
    assert.equal(
      (await other.post('/api/invitations/accept').send({ token: invite.body.token })).status,
      200,
    );
    for (const [path, method, body] of [
      ['/api/tasks/' + task.body.id + '/status', 'patch', { status: 'done', version: 1 }],
      ['/api/invitations', 'post', { role: 'editor' }],
      ['/api/members/' + otherUser.id, 'patch', { role: 'owner' }],
    ] as const)
      assert.equal((await other[method](path + suffix).send(body)).status, 403, path);
    assert.equal((await other.get('/api/export' + suffix)).status, 403);
    assert.equal(
      (await owner.patch('/api/members/' + otherUser.id + suffix).send({ role: 'editor' })).status,
      200,
    );
    assert.equal(
      (await other.post('/api/invitations' + suffix).send({ role: 'editor' })).status,
      403,
    );
    const results = await Promise.all(
      [owner, other].map((agent) =>
        agent
          .patch('/api/tasks/' + task.body.id + '/status' + suffix)
          .send({ status: 'done', version: 1 }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(db.prepare('SELECT version FROM tasks WHERE id=?').get(task.body.id)?.version, 2);
    assert.equal((await owner.delete('/api/members/' + otherUser.id + suffix)).status, 204);
    assert.equal((await other.get('/api/tasks' + suffix)).status, 404);
  } finally {
    db.close();
  }
});

test('login rejects cross-site input and limits password guesses', async () => {
  const db = createDatabase(':memory:');
  try {
    await createAccount(db, { email: 'owner@example.test', name: 'Owner', password });
    const app = createApp(db, () => {});
    assert.equal(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Origin', 'https://untrusted.example')
          .send({ email: 'owner@example.test', password })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Sec-Fetch-Site', 'cross-site')
          .send({ email: 'owner@example.test', password })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(app)
          .post('/api/auth/login')
          .set('Content-Type', 'application/json')
          .send('{broken')
      ).status,
      400,
    );
    for (let index = 0; index < 10; index++)
      assert.equal(
        (
          await request(app)
            .post('/api/auth/login')
            .send({ email: 'owner@example.test', password: 'wrong' })
        ).status,
        401,
      );
    assert.equal(
      (await request(app).post('/api/auth/login').send({ email: 'owner@example.test', password }))
        .status,
      429,
    );
  } finally {
    db.close();
  }
});

test('administrator account linking preserves existing ownership and failed session writes roll back', async () => {
  const db = createDatabase(':memory:');
  try {
    db.exec(
      "INSERT INTO workspaces(id,name,is_public) VALUES(99,'Existing team',0);INSERT INTO memberships VALUES(99,1,'owner');",
    );
    const before = db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n;
    await createAccount(db, { email: 'linked@example.test', password, memberId: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n, before);
    assert.equal(
      db.prepare('SELECT role FROM memberships WHERE workspace_id=99 AND member_id=1').get()?.role,
      'owner',
    );
    const app = createApp(db, () => {}),
      agent = request.agent(app);
    assert.equal(
      (await agent.post('/api/auth/login').send({ email: 'linked@example.test', password })).status,
      200,
    );
    assert.equal((await agent.get('/api/tasks?workspace=99')).status, 200);
    const original = db.prepare('SELECT token_hash FROM sessions').get()?.token_hash;
    db.exec(
      "CREATE TRIGGER fixture_session_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture_session_failure');END;",
    );
    const failed = await agent
      .post('/api/auth/login')
      .send({ email: 'linked@example.test', password });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.equal(db.prepare('SELECT token_hash FROM sessions').get()?.token_hash, original);
    assert.equal((await agent.get('/api/tasks?workspace=99')).status, 200);
  } finally {
    db.close();
  }
});

test('reopening a database preserves sessions without granting public write access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flow-auth-'));
  let db;
  try {
    const file = join(directory, 'flow.sqlite');
    db = createDatabase(file);
    const user = await createAccount(db, { email: 'owner@example.test', name: 'Owner', password });
    const app = createApp(db, () => {}),
      agent = request.agent(app);
    const login = await agent
      .post('/api/auth/login')
      .send({ email: 'owner@example.test', password });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    db.close();
    db = createDatabase(file);
    const response = await request(createApp(db, () => {}))
      .get('/api/session')
      .set('Cookie', cookie);
    assert.equal(response.body.user.id, user.id);
    assert.equal(response.body.canWrite, false);
    assert.equal(
      db
        .prepare('SELECT COUNT(*) n FROM memberships WHERE workspace_id=1 AND member_id=?')
        .get(user.id)?.n,
      0,
    );
  } finally {
    db?.close();
    assert.ok(realpathSync(directory).startsWith(realpathSync(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
