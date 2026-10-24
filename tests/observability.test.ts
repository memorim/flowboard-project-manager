import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {observe,safePath} from '../src/observability.js';
import {createApp} from '../server/app.js';
import {createDatabase} from '../server/db.js';
import {backupDatabase} from '../server/backup.js';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('safe request logs correlate errors and omit untrusted data',async()=>{
 const db=createDatabase(':memory:'),events:Record<string,string|number>[]=[],app=createApp(db,e=>events.push(e));
 try{
  const health=await request(app).get('/api/health?secret=not-for-logs').set('Authorization','private-token').set('X-Request-Id','spoofed');
  assert.equal(health.status,200);assert.match(health.headers['x-request-id'],/^[a-f0-9-]{36}$/);
  const invalid=await request(app).post('/api/tasks').set('Content-Type','application/json').send('{broken');assert.equal(invalid.status,400);assert.match(invalid.headers['x-request-id'],/^[a-f0-9-]{36}$/);
  db.close();const failed=await request(app).get('/api/meta');assert.equal(failed.status,503);assert.equal(events.at(-1)?.requestId,failed.headers['x-request-id']);assert.equal(events.at(-1)?.error,'service_unavailable');
  const logged=JSON.stringify(events);for(const secret of ['not-for-logs','private-token','spoofed','broken'])assert.ok(!logged.includes(secret));assert.ok(events.every(e=>Number(e.durationMs)>=0));
 }finally{if(db.isOpen)db.close();}
});
test('backup command records verified success and never overwrites an existing file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'verified-backup-')),source=join(dir,'source.db'),target=join(dir,'backup.db'),events:Record<string,string|number>[]=[];const db=createDatabase(source);
 try{
  const result=await backupDatabase(source,target,e=>events.push(e));assert.ok(result.bytes>0);const original=await readFile(target);
  await assert.rejects(()=>backupDatabase(source,target,e=>events.push(e)));assert.deepEqual(await readFile(target),original);
  await assert.rejects(()=>backupDatabase(join(dir,'missing.db'),join(dir,'missing-copy.db'),e=>events.push(e)));
  assert.deepEqual(events.map(e=>e.status),['ok','failed','failed']);assert.ok(!JSON.stringify(events).includes(dir));
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});

test('hosted wrapper correlates unexpected failures without exposing their details',async()=>{
 const events:Record<string,string|number>[]=[];
 const response=await observe(new Request('https://example.test/api/tasks/42?private=hidden'),async()=>{throw new Error('private database details');},e=>events.push(e));
 assert.equal(response.status,503);assert.equal(response.headers.get('X-Request-Id'),events[0].requestId);assert.equal(events[0].path,'/api/tasks/:id');assert.ok(!(await response.text()).includes('private'));assert.ok(!JSON.stringify(events).includes('hidden'));assert.equal(safePath('/api/untrusted-token'),'/api/unknown');
});
