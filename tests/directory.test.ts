import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { asStore, type Store } from '../server/sqlite-adapter.js';
import { createPostgresStore } from '../server/postgres.js';
import { createApp } from '../server/app.js';
import { createAccount } from '../server/auth.js';
import { digest } from '../server/account-crypto.js';
import type { Mail } from '../server/mail.js';

process.env.FLOW_PUBLIC_ORIGIN = 'http://localhost:4100';
async function directoryScenario(db: Store) {
  const password = 'Directory-fixture-password-2026',
    messages: Mail[] = [];
  const app = createApp(db, () => {}, {
    accounts: {
      key: randomBytes(32),
      sendMail: async (mail) => {
        messages.push(mail);
      },
    },
  });
  const ownerUser = await createAccount(db, {
    name: 'Directory owner',
    email: 'owner@example.test',
    password,
  });
  await createAccount(db, { name: 'Another owner', email: 'other@example.test', password });
  const owner = request.agent(app),
    other = request.agent(app);
  for (const [agent, email] of [
    [owner, 'owner@example.test'],
    [other, 'other@example.test'],
  ] as const)
    assert.equal((await agent.post('/api/auth/login').send({ email, password })).status, 200);
  const workspace = (await owner.post('/api/workspaces').send({ name: 'Directory A' })).body.id;
  const secondWorkspace = (await other.post('/api/workspaces').send({ name: 'Directory B' })).body
    .id;
  const token = await owner
    .post('/api/integrations/directory/token?workspace=' + workspace)
    .send({ password });
  assert.equal(token.status, 201, JSON.stringify(token.body));
  assert.equal(
    (await db
      .prepare('SELECT token_hash FROM directory_tokens WHERE workspace_id=?')
      .bind(workspace)
      .first<{ token_hash: string }>())!.token_hash,
    digest(token.body.token),
  );
  const otherToken = (
    await other
      .post('/api/integrations/directory/token?workspace=' + secondWorkspace)
      .send({ password })
  ).body.token;
  const call = (
    path: string,
    method: 'get' | 'post' | 'patch' | 'put' | 'delete' = 'get',
    data?: object,
    bearer = token.body.token,
    tag?: string,
  ) => {
    const r = request(app)
      [method]('/api/scim/v2' + path)
      .set('Authorization', 'Bearer ' + bearer);
    if (tag) r.set('If-Match', tag);
    return data ? r.set('Content-Type', 'application/scim+json').send(JSON.stringify(data)) : r;
  };
  assert.equal((await call('/Users', 'get', undefined, 'f'.repeat(64))).status, 401);
  assert.equal((await call('/ServiceProviderConfig')).body.patch.supported, true);
  const created = await call('/Users', 'post', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'employee@example.test',
    displayName: 'Directory member',
    active: true,
    externalId: 'corporate-1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id,
    tag = created.headers.etag;
  const list = await call(
    '/Users?filter=' + encodeURIComponent('userName eq "employee@example.test"'),
  );
  assert.equal(list.body.totalResults, 1);
  assert.equal((await call('/Users?filter=' + encodeURIComponent('passwordHash pr'))).status, 400);
  assert.equal((await call('/Users/' + id, 'get', undefined, otherToken)).status, 404);
  assert.equal(
    (
      await call('/Users', 'post', {
        userName: 'owner@example.test',
        displayName: 'Cannot manage owner',
      })
    ).status,
    409,
  );
  await app.locals.mail.run();
  const link = messages
    .find((mail) => mail.to === 'employee@example.test')!
    .text.match(/http:\/\/localhost:4100\/\S+/)![0];
  const activation = new URL(link).searchParams.get('token');
  const employee = request.agent(app);
  assert.equal(
    (await employee.post('/api/auth/reset-password').send({ token: activation, password })).status,
    200,
  );
  assert.equal(
    (await employee.post('/api/auth/login').send({ email: 'employee@example.test', password }))
      .status,
    200,
  );
  assert.equal((await employee.get('/api/session?workspace=' + workspace)).body.canWrite, false);
  const member = (await db
    .prepare('SELECT member_id FROM accounts WHERE email=?')
    .bind('employee@example.test')
    .first<{ member_id: number }>())!.member_id;
  const project = (await owner.get('/api/meta?workspace=' + workspace)).body.projects[0].id;
  const task = await owner.post('/api/tasks?workspace=' + workspace).send({
    title: 'Assigned directory task',
    description: '',
    status: 'todo',
    priority: 'medium',
    projectId: project,
    assigneeId: member,
    dueDate: '2030-01-10',
  });
  assert.equal(task.status, 201);
  const group = await call('/Groups', 'post', {
    displayName: 'Product team',
    members: [{ value: id }],
    externalId: 'group-1',
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  assert.equal(group.body.members.length, 1);
  const wrongGroup = await call(
    '/Groups',
    'post',
    { displayName: 'Wrong workspace', members: [{ value: id }] },
    otherToken,
  );
  assert.equal(wrongGroup.status, 400);
  assert.equal((await call('/Groups', 'get', undefined, otherToken)).body.totalResults, 0);
  assert.equal(
    (
      await call('/Groups/' + group.body.id, 'patch', {
        Operations: [{ op: 'remove', path: 'members[value eq "' + id + '"]' }],
      })
    ).body.members.length,
    0,
  );
  assert.equal(
    (
      await call(
        '/Groups/' + group.body.id,
        'put',
        { displayName: 'Updated group', members: [{ value: id }] },
        token.body.token,
        group.headers.etag,
      )
    ).status,
    412,
  );
  const deactivated = await call('/Users/' + id, 'patch', {
    Operations: [{ op: 'replace', path: 'active', value: false }],
  });
  assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
  assert.equal((await employee.get('/api/tasks?workspace=' + workspace)).status, 404);
  assert.equal(
    (await db
      .prepare('SELECT assignee_id FROM tasks WHERE id=?')
      .bind(task.body.id)
      .first<{ assignee_id: number | null }>())!.assignee_id,
    null,
  );
  assert.equal((await employee.get('/api/session')).body.user.id, member);
  assert.equal(
    (
      await call(
        '/Users/' + id,
        'patch',
        { Operations: [{ op: 'replace', path: 'active', value: true }] },
        token.body.token,
        tag,
      )
    ).status,
    412,
  );
  assert.equal(
    (
      await call('/Users/' + id, 'patch', {
        Operations: [{ op: 'replace', value: { active: true, displayName: 'Renamed member' } }],
      })
    ).status,
    200,
  );
  assert.equal((await employee.get('/api/tasks?workspace=' + workspace)).status, 200);
  const victim = (
    await createAccount(db, {
      name: 'Invitation recipient',
      email: 'invite@example.test',
      password,
    })
  ).id;
  assert.ok(victim > ownerUser.id);
  const emailInvite = await owner
    .post('/api/invitations/email?workspace=' + workspace)
    .send({ email: 'invite@example.test', role: 'editor' });
  assert.equal(emailInvite.status, 202);
  await app.locals.mail.run();
  const invitation = messages
    .find((mail) => mail.to === 'invite@example.test')!
    .text.match(/#invite=([a-f0-9]{64})/)![1];
  assert.equal(
    (await employee.post('/api/invitations/accept').send({ token: invitation })).status,
    403,
  );
  assert.equal((await call('/Users/' + id, 'delete')).status, 204);
  assert.equal((await call('/Users/' + id)).status, 404);
  assert.equal((await employee.get('/api/tasks?workspace=' + workspace)).status, 404);
  const rotated = await owner
    .post('/api/integrations/directory/token?workspace=' + workspace)
    .send({ password, role: 'editor' });
  assert.equal(rotated.status, 201);
  assert.equal((await call('/Users')).status, 401);
  assert.equal((await call('/Users', 'get', undefined, rotated.body.token)).status, 200);
  await owner.delete('/api/integrations/directory/token?workspace=' + workspace);
  assert.equal((await call('/Users', 'get', undefined, rotated.body.token)).status, 401);
  assert.equal((await call('/Users', 'get', undefined, otherToken)).status, 200);
}
test('SCIM and email invitations: provisioning, groups, activation, revocation, ETags and workspace isolation on SQLite', async () => {
  const db = asStore(createDatabase(':memory:'));
  try {
    await directoryScenario(db);
  } finally {
    await db.close();
  }
});
test(
  'SCIM and email invitations preserve the same guarantees on real PostgreSQL',
  { skip: !process.env.FLOW_TEST_DATABASE_URL },
  async () => {
    const url = process.env.FLOW_TEST_DATABASE_URL!,
      schema = 'flow_dir_' + randomUUID().replaceAll('-', '').slice(0, 24),
      db = await createPostgresStore(url, schema);
    try {
      await directoryScenario(db);
    } finally {
      await db.close();
      const admin = new Pool({ connectionString: url });
      try {
        await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await admin.end();
      }
    }
  },
);
