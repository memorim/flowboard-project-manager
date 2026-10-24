import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { demoApi } from '../src/demo-api.ts';

const values = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
} });

describe('browser demonstration', () => {
  it('creates, finds, moves and deletes a task, preserving changes in browser storage', async () => {
    const before = (await demoApi.tasks()).length;
    const body = { title: 'Portfolio demo task', description: 'Local only', projectId: 1, assigneeId: 1,
      priority: 'medium', dueDate: '2030-01-10' };
    const task = await demoApi.createTask(body);
    assert.equal((await demoApi.tasks('Portfolio demo')).length, 1);
    await demoApi.updateTask(task.id,{...body,title:'Edited portfolio task',status:'review'});
    assert.equal((await demoApi.tasks()).find(t=>t.id===task.id).title,'Edited portfolio task');
    await demoApi.setStatus(task.id, 'done');
    assert.equal((await demoApi.tasks()).find(t => t.id === task.id)?.status, 'done');
    assert.equal((await demoApi.dashboard()).stats.total, before + 1);
    assert.ok((await demoApi.dashboard()).activity.some(a=>a.text.includes('отредактировал')));
    await demoApi.deleteTask(task.id);
    assert.equal((await demoApi.tasks()).length, before);
    await assert.rejects(demoApi.createTask({ ...body, projectId: 999 }), /не найден/);
    await assert.rejects(demoApi.createTask({ ...body, dueDate: 'invalid' }), /данные/);
    await assert.rejects(demoApi.setStatus(-1, 'done'), /не найдена/);
  });
});
