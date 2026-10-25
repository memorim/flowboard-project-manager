import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from './demo-app.js';
test('bounded pages, stable order, filters, membership scope and internal fields', async () => {
  const db = createDatabase(':memory:'),
    app = createApp(db);
  try {
    const insert = db.prepare(
      "INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date,version) VALUES (?,'fixture','todo','medium',1,1,'2030-01-10',1)",
    );
    for (let i = 0; i < 85; i++) insert.run('Page fixture ' + i);
    const a = await request(app).get('/api/tasks/page?limit=40'),
      b = await request(app).get('/api/tasks/page?limit=40&offset=40');
    assert.equal(a.body.items.length, 40);
    assert.ok(a.body.total >= 85);
    assert.equal(
      a.body.items.some((x: { id: number }) =>
        b.body.items.some((y: { id: number }) => x.id === y.id),
      ),
      false,
    );
    assert.equal('request_key' in a.body.items[0], false);
    const filtered = await request(app).get(
      '/api/tasks/page?search=Page%20fixture%2084&status=todo&assignee=1&project=1',
    );
    assert.equal(filtered.body.total, 1);
    assert.equal((await request(app).get('/api/tasks/page?limit=101')).status, 400);
    assert.equal((await request(app).get('/api/tasks/page?offset=-1')).status, 400);
    assert.equal((await request(app).get('/api/tasks/page?workspace=999')).status, 404);
    assert.equal((await request(app).get('/api/tasks')).body.length, 40);
  } finally {
    db.close();
  }
});
