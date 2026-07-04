import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDatabase } from '../server/db.js';
import { createApp } from '../server/app.js';

const app = createApp(createDatabase(':memory:'));

describe('Flowboard API', () => {
  it('returns dashboard data', async () => {
    const response = await request(app).get('/api/dashboard');
    assert.equal(response.status, 200);
    assert.equal(response.body.stats.total, 8);
    assert.equal(response.body.projects.length, 3);
  });

  it('filters tasks by status', async () => {
    const response = await request(app).get('/api/tasks?status=review');
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 2);
    assert.ok(response.body.every((task: { status: string }) => task.status === 'review'));
  });

  it('creates and updates a task', async () => {
    const created = await request(app).post('/api/tasks').send({
      title: 'Проверить новый сценарий', description: 'Регрессионная проверка',
      status: 'todo', priority: 'medium', projectId: 1, assigneeId: 2, dueDate: '2026-07-22',
    });
    assert.equal(created.status, 201);
    const updated = await request(app).patch(`/api/tasks/${created.body.id}/status`).send({ status: 'done' });
    assert.equal(updated.body.status, 'done');
  });
});
