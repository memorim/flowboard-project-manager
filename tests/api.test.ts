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
    const updated = await request(app).patch(`/api/tasks/${created.body.id}/status`).send({ status: 'done',version:1 });
    assert.equal(updated.body.status, 'done');
  });
});


describe('task validation', () => {
  it('rejects invalid input and missing references without a server error', async () => {
    assert.equal((await request(app).post('/api/tasks').send({})).status,400);
    const body={ title:'New task',priority:'medium',projectId:999,assigneeId:null,dueDate:'2030-01-10' };
    assert.equal((await request(app).post('/api/tasks').send(body)).status,404);
    assert.equal((await request(app).post('/api/tasks').send({ ...body,projectId:1,assigneeId:999 })).status,404);
  });
  it('rejects an invalid status and returns 404 for an unknown task', async () => {
    assert.equal((await request(app).patch('/api/tasks/1/status').send({status:'invalid'})).status,400);
    assert.equal((await request(app).patch('/api/tasks/999/status').send({status:'done'})).status,404);
    assert.equal((await request(app).delete('/api/tasks/999')).status,404);
  });
});

 it('edits all task fields, recomputes progress and records actual mutations', async () => {
   const body={title:'Edited task',description:'New details',status:'done',priority:'high',projectId:2,assigneeId:null,dueDate:'2035-01-10'};
   const created=await request(app).post('/api/tasks').send({...body,status:'todo'});
   const id=created.body.id;
   assert.equal((await request(app).patch(`/api/tasks/${id}`).send({...body,version:1})).status,200);
   const dash=(await request(app).get('/api/dashboard')).body;
   const p=dash.projects.find((p:{id:number})=>p.id===2);
   assert.equal(p.progress,Math.round(p.done_count/p.task_count*100));
   assert.ok(dash.activity.some((a:{text:string})=>a.text.includes('отредактировал')&&a.text.includes('Edited task')));
   assert.equal((await request(app).patch(`/api/tasks/${id}`).send({...body,projectId:999,version:2})).status,404);
   assert.equal((await request(app).patch(`/api/tasks/${id}`).send({...body,role:'admin',version:2})).status,400);
 });
