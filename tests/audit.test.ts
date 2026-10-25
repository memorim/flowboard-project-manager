import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from './demo-app.js';
import { sqliteAdapter } from '../server/sqlite-adapter.js';
import { flowApi, type Actor } from '../src/flow-api.js';

test('revoking an editor before commit prevents their already validated task change', async () => {
  const db = createDatabase(':memory:');
  try {
    db.exec(
      "INSERT INTO workspaces(id,name,is_public) VALUES(99,'Private',0);INSERT INTO projects(id,name,client,color,progress,due_date,workspace_id) VALUES(99,'Private project','Team','#123456',0,'2030-01-10',99);INSERT INTO memberships VALUES(99,4,'owner'),(99,1,'editor');INSERT INTO tasks(id,title,status,priority,project_id,due_date) VALUES(99,'Keep original','todo','medium',99,'2030-01-10');",
    );
    const adapter = sqliteAdapter(db);
    let revoked = false;
    const guarded = {
      ...adapter,
      prepare(sql: string) {
        if (sql.startsWith('UPDATE tasks SET title=') && !revoked) {
          revoked = true;
          db.prepare('DELETE FROM memberships WHERE workspace_id=99 AND member_id=1').run();
        }
        return adapter.prepare(sql);
      },
    };
    const actor = db.prepare('SELECT * FROM members WHERE id=1').get() as Actor;
    const response = await flowApi(
      new Request('http://localhost/api/tasks/99?workspace=99', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Unauthorized late edit',
          description: '',
          status: 'todo',
          priority: 'medium',
          projectId: 99,
          assigneeId: null,
          dueDate: '2030-01-10',
          version: 1,
        }),
      }),
      guarded,
      actor,
      'local',
    );
    assert.equal(response.status, 403);
    assert.equal(db.prepare('SELECT title FROM tasks WHERE id=99').get()?.title, 'Keep original');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_history WHERE task_id=99').get()?.n, 0);
  } finally {
    db.close();
  }
});

test('one invitation accepted concurrently grants exactly one membership', async () => {
  const db = createDatabase(':memory:');
  try {
    const app = createApp(db),
      owner = request(app);
    const team = await owner
      .post('/api/workspaces')
      .set('X-Demo-Actor', '4')
      .send({ name: 'Invitation race' });
    assert.equal(team.status, 201);
    const invitation = await owner
      .post(`/api/invitations?workspace=${team.body.id}`)
      .set('X-Demo-Actor', '4')
      .send({ role: 'editor' });
    assert.equal(invitation.status, 201);
    const results = await Promise.all(
      [1, 2].map((id) =>
        request(app)
          .post('/api/invitations/accept')
          .set('X-Demo-Actor', String(id))
          .send({ token: invitation.body.token }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 410]);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM memberships WHERE workspace_id=? AND role='editor'")
        .get(team.body.id)?.n,
      1,
    );
  } finally {
    db.close();
  }
});

test('an owner demoted before member removal cannot unassign tasks or remove that member', async () => {
  const db = createDatabase(':memory:');
  try {
    db.exec(
      "INSERT INTO workspaces(id,name,is_public) VALUES(99,'Private',0);INSERT INTO projects(id,name,client,color,progress,due_date,workspace_id) VALUES(99,'Private project','Team','#123456',0,'2030-01-10',99);INSERT INTO memberships VALUES(99,4,'owner'),(99,1,'editor');INSERT INTO tasks(id,title,status,priority,project_id,assignee_id,due_date) VALUES(99,'Keep assignee','todo','medium',99,1,'2030-01-10');",
    );
    const adapter = sqliteAdapter(db),
      actor = db.prepare('SELECT * FROM members WHERE id=4').get() as Actor;
    const guarded = {
      ...adapter,
      batch: async (statements: Parameters<typeof adapter.batch>[0]) => {
        db.exec("UPDATE memberships SET role='editor' WHERE workspace_id=99 AND member_id=4");
        return adapter.batch(statements);
      },
    };
    const response = await flowApi(
      new Request('http://localhost/api/members/1?workspace=99', { method: 'DELETE' }),
      guarded,
      actor,
      'local',
    );
    assert.equal(response.status, 403);
    assert.equal(db.prepare('SELECT assignee_id FROM tasks WHERE id=99').get()?.assignee_id, 1);
    assert.ok(
      db.prepare('SELECT member_id FROM memberships WHERE workspace_id=99 AND member_id=1').get(),
    );
  } finally {
    db.close();
  }
});
