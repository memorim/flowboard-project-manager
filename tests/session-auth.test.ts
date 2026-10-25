import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

test('default server does not accept a client-selected identity for a private workspace', async () => {
  const db = createDatabase(':memory:');
  try {
    db.exec(
      "INSERT INTO workspaces(id,name,is_public) VALUES(99,'Private team',0); INSERT INTO memberships VALUES(99,1,'owner');",
    );
    const app = createApp(db);
    const result = await request(app).get('/api/tasks?workspace=99').set('X-Demo-Actor', '1');
    assert.equal(result.status, 404);
    const session = await request(app).get('/api/session').set('X-Demo-Actor', '4');
    assert.equal(session.body.user, null);
    assert.equal(session.body.canWrite, false);
  } finally {
    db.close();
  }
});
