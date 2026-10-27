import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { createPostgresStore, postgresSql } from '../server/postgres.js';
import { createApp } from '../server/app.js';
import { createAccount } from '../server/auth.js';
import { takeBudget } from '../server/rate-limit.js';

test('PostgreSQL binding preserves quoted question marks and never inserts user text into SQL', () => {
  const query = postgresSql(
    "SELECT '?' literal, ? value, changes(),last_insert_rowid()",
    ["x';DROP TABLE tasks;--"],
    { changes: 2, lastId: 4 },
  );
  assert.equal(query.text, "SELECT '?' literal, $1 value, $2,$3");
  assert.deepEqual(query.values, ["x';DROP TABLE tasks;--", 2, 4]);
});
test(
  'real PostgreSQL: two independent app instances preserve task CAS, invitation ownership, shared budgets and migration checksums',
  { skip: !process.env.FLOW_TEST_DATABASE_URL },
  async () => {
    const url = process.env.FLOW_TEST_DATABASE_URL!,
      schema = 'flow_test_' + randomUUID().replaceAll('-', '').slice(0, 24);
    const first = await createPostgresStore(url, schema),
      second = await createPostgresStore(url, schema);
    try {
      const password = 'Postgres-fixture-password-2026';
      const users = [];
      for (const name of ['owner', 'editor', 'other'])
        users.push(await createAccount(first, { name, email: name + '@example.test', password }));
      const a = request.agent(createApp(first, () => {})),
        b = request.agent(createApp(second, () => {})),
        c = request.agent(createApp(first, () => {}));
      for (const [agent, email] of [
        [a, 'owner'],
        [b, 'editor'],
        [c, 'other'],
      ] as const) {
        const login = await agent
          .post('/api/auth/login')
          .send({ email: email + '@example.test', password });
        assert.equal(login.status, 200, JSON.stringify(login.body));
      }
      const team = await a.post('/api/workspaces').send({ name: 'Postgres private team' });
      assert.equal(team.status, 201, JSON.stringify(team.body));
      const suffix = '?workspace=' + team.body.id;
      const invite = await a.post('/api/invitations' + suffix).send({ role: 'editor' });
      assert.equal(invite.status, 201);
      const races = await Promise.all(
        [b, c].map((agent) =>
          agent.post('/api/invitations/accept').send({ token: invite.body.token }),
        ),
      );
      assert.deepEqual(races.map((r) => r.status).sort(), [200, 410]);
      assert.equal(
        (await first
          .prepare("SELECT COUNT(*) n FROM memberships WHERE workspace_id=? AND role='editor'")
          .bind(team.body.id)
          .first<{ n: number }>())!.n,
        1,
      );
      const editor = races[0].status === 200 ? b : c,
        outsider = races[0].status === 200 ? c : b;
      assert.equal((await outsider.get('/api/tasks' + suffix)).status, 404);
      const meta = await a.get('/api/meta' + suffix);
      assert.equal(meta.status, 200, JSON.stringify(meta.body));
      const payload = {
        title: 'Postgres guarded task',
        description: 'Original',
        status: 'todo',
        priority: 'medium',
        projectId: meta.body.projects[0].id,
        assigneeId: users[0].id,
        dueDate: '2030-01-10',
      };
      const created = await a.post('/api/tasks' + suffix).send(payload);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const dashboard = await a.get('/api/dashboard' + suffix);
      assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
      assert.equal(dashboard.body.stats.inProgress, 0);
      const edits = await Promise.all(
        [a, editor].map((agent, i) =>
          agent
            .patch('/api/tasks/' + created.body.id + suffix)
            .send({ ...payload, title: 'Revision ' + i, version: 1 }),
        ),
      );
      assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
      const retries = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? a : editor)
            .post('/api/tasks' + suffix)
            .set('Idempotency-Key', 'same-pg-request-key')
            .send({ ...payload, title: 'Idempotent task' }),
        ),
      );
      assert.ok(
        retries.every((r) => r.status === 201),
        JSON.stringify(retries.map((r) => [r.status, r.body])),
      );
      // The actors have separate operation-key scopes; each scope creates exactly one task.
      assert.equal(new Set(retries.map((r) => r.body.id)).size, 2);
      const budgets = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          takeBudget(i % 2 ? first : second, 'shared-pg-budget', 5, 600000),
        ),
      );
      assert.equal(budgets.filter((r) => r.status === 'fulfilled').length, 5);
      const history = await a.get('/api/tasks/' + created.body.id + '/history' + suffix);
      assert.equal(history.status, 200);
      assert.equal(history.body.length, 2);
      await assert.rejects(
        first.transaction(async () => {
          await first
            .prepare("INSERT INTO workspaces(name,is_public) VALUES('Rollback workspace',0)")
            .run();
          throw new Error('rollback');
        }),
      );
      assert.equal(
        (await first
          .prepare("SELECT COUNT(*) n FROM workspaces WHERE name='Rollback workspace'")
          .first<{ n: number }>())!.n,
        0,
      );
      const reopened = await createPostgresStore(url, schema);
      await reopened.close();
    } finally {
      await first.close();
      await second.close();
      const admin = new Pool({ connectionString: url });
      try {
        await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
      } finally {
        await admin.end();
      }
    }
  },
);
