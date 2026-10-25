import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from './demo-app.js';
import { createDatabase } from '../server/db.js';

test('synthetic owner, editor, viewer and outsider: isolation, invitations, conflicts and revocation', async () => {
  const db = createDatabase(':memory:'),
    app = createApp(db);
  const api = (actor: number, path: string, method = 'get', body?: object) => {
    const r = (request(app) as unknown as Record<string, (path: string) => request.Test>)
      [method](path)
      .set('X-Demo-Actor', String(actor));
    return body ? r.send(body) : r;
  };
  const a = await api(1, '/api/workspaces', 'post', { name: 'Synthetic Team A' });
  assert.equal(a.status, 201);
  const wid = a.body.id;
  const scope = (path: string) => path + '?workspace=' + wid;
  const b = await api(4, '/api/workspaces', 'post', { name: 'Synthetic Team B' });
  assert.equal(b.status, 201);
  for (const path of ['/api/tasks', '/api/meta', '/api/dashboard', '/api/session', '/api/export'])
    assert.equal((await api(4, scope(path))).status, 404, path);
  assert.equal((await api(999, scope('/api/tasks'))).status, 404);
  assert.ok(!(await api(4, '/api/workspaces')).body.some((w: { id: number }) => w.id === wid));
  assert.equal((await api(1, scope('/api/invitations'), 'post', { role: 'owner' })).status, 400);
  const invite = await api(1, scope('/api/invitations'), 'post', { role: 'editor' });
  assert.equal(invite.status, 201);
  const token = invite.body.token;
  assert.equal((await api(2, '/api/invitations/accept', 'post', { token })).status, 200);
  assert.equal((await api(4, '/api/invitations/accept', 'post', { token })).status, 410);
  const viewToken = (await api(1, scope('/api/invitations'), 'post', { role: 'viewer' })).body
    .token;
  assert.equal((await api(3, '/api/invitations/accept', 'post', { token: viewToken })).status, 200);
  const project = (await api(1, scope('/api/meta'))).body.projects[0].id;
  const payload = {
    title: 'Synthetic shared task',
    description: 'No human participants',
    status: 'todo',
    priority: 'medium',
    projectId: project,
    assigneeId: 2,
    dueDate: '2030-01-10',
  };
  const created = await api(1, scope('/api/tasks'), 'post', payload);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.version, 1);
  assert.equal((await api(3, scope('/api/tasks'), 'post', payload)).status, 403);
  assert.equal((await api(3, scope('/api/tasks/' + id), 'delete', { version: 1 })).status, 403);
  assert.equal((await api(3, scope('/api/invitations'), 'post', { role: 'editor' })).status, 403);
  assert.equal((await api(3, scope('/api/export'))).status, 403);
  assert.equal((await api(3, scope('/api/session'))).body.canWrite, false);
  assert.equal(
    (
      await api(4, '/api/tasks/' + id + '?workspace=' + b.body.id, 'patch', {
        ...payload,
        version: 1,
      })
    ).status,
    404,
  );
  assert.equal((await api(4, '/api/tasks?workspace=' + b.body.id, 'post', payload)).status, 404);
  const before = Number(
    (db.prepare('SELECT COUNT(*) n FROM activity WHERE workspace_id=?').get(wid) as { n: number })
      .n,
  );
  const competing = await Promise.all([
    api(1, scope('/api/tasks/' + id), 'patch', { ...payload, title: 'Owner revision', version: 1 }),
    api(2, scope('/api/tasks/' + id), 'patch', {
      ...payload,
      title: 'Editor revision',
      version: 1,
    }),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const stored = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as {
    version: number;
    title: string;
  };
  assert.equal(stored.version, 2);
  assert.equal(
    Number(
      (db.prepare('SELECT COUNT(*) n FROM activity WHERE workspace_id=?').get(wid) as { n: number })
        .n,
    ),
    before + 1,
    'failed conflict must not create an activity event',
  );
  assert.equal((await api(2, scope('/api/tasks/' + id), 'delete', { version: 1 })).status, 409);
  assert.equal(
    (await api(2, scope('/api/tasks/' + id + '/status'), 'patch', { status: 'done', version: 2 }))
      .status,
    200,
  );
  const exported = (await api(1, scope('/api/export'))).body;
  assert.equal(exported.workspace.id, wid);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.tasks[0].version, 3);
  assert.ok(!JSON.stringify(exported).includes('token_hash'));
  assert.equal((await api(1, scope('/api/members/2'), 'delete')).status, 204);
  assert.equal((await api(2, scope('/api/tasks'))).status, 404);
  assert.equal(
    (await api(2, '/api/invitations/accept', 'post', { token })).status,
    410,
    'a consumed invitation must not restore revoked membership',
  );
  assert.equal((await api(1, scope('/api/members/1'), 'delete')).status, 400);
  assert.equal(
    (
      db.prepare('SELECT assignee_id FROM tasks WHERE id=?').get(id) as {
        assignee_id: number | null;
      }
    ).assignee_id,
    null,
  );
  const stale = (await api(1, scope('/api/invitations'), 'post', { role: 'viewer' })).body.token;
  db.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE accepted_by IS NULL").run();
  assert.equal((await api(4, '/api/invitations/accept', 'post', { token: stale })).status, 410);
  assert.equal(
    (await api(1, scope('/api/tasks/' + id + '/status'), 'patch', null as unknown as object))
      .status,
    400,
  );
  db.close();
});

test('task and activity rollback together when activity storage fails', async () => {
  const db = createDatabase(':memory:'),
    app = createApp(db);
  db.exec(
    "CREATE TRIGGER reject_test_activity BEFORE INSERT ON activity WHEN NEW.text LIKE '%Rollback sentinel%' BEGIN SELECT RAISE(ABORT,'test_failure'); END;",
  );
  const before = (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
  const response = await request(app).post('/api/tasks').send({
    title: 'Rollback sentinel',
    priority: 'medium',
    projectId: 1,
    assigneeId: null,
    dueDate: '2030-01-10',
  });
  assert.equal(response.status, 503);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n, before);
  db.close();
});
