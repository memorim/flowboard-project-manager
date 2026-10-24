import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createDatabase} from '../server/db.js';
import {createApp} from '../server/app.js';
test('same operation creates one task/event and replays its original result',async(t)=>{
 const db=createDatabase(':memory:'),server=createApp(db).listen(0);await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
 const body={title:'Idempotent synthetic task',description:'original',status:'todo',priority:'medium',projectId:1,assigneeId:null,dueDate:'2030-01-10'},key='synthetic-operation-123';
 const responses=await Promise.all(Array.from({length:20},()=>request(server).post('/api/tasks').set('X-Demo-Actor','1').set('Idempotency-Key',key).send(body)));
 assert.ok(responses.every(r=>r.status===201));const first=responses[0].body;assert.ok(first.id);assert.ok(responses.every(r=>JSON.stringify(r.body)===JSON.stringify(first)));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE title=?').get(body.title)?.n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM activity WHERE member_id=1').get()?.n,1);
 assert.equal((await request(server).post('/api/tasks').set('X-Demo-Actor','1').set('Idempotency-Key',key).send({...body,title:'different'})).status,409);
 assert.equal((await request(server).post('/api/tasks').set('Idempotency-Key','!').send(body)).status,400);
 assert.equal((await request(server).patch('/api/tasks/'+first.id).set('X-Demo-Actor','1').send({...body,title:'edited',version:1})).status,200);
 const again=await request(server).post('/api/tasks').set('X-Demo-Actor','1').set('Idempotency-Key',key).send(body);assert.deepEqual(again.body,first);
 const other=await request(server).post('/api/tasks').set('X-Demo-Actor','2').set('Idempotency-Key',key).send(body);assert.equal(other.status,201);assert.notEqual(other.body.id,first.id);
 // A transient persistence failure must leave no reservation of the operation key.
 db.exec("CREATE TRIGGER fail_new_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 const failed=await request(server).post('/api/tasks').set('Idempotency-Key','retry-after-failure').send(body);assert.equal(failed.status,503);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE request_key LIKE '%retry-after-failure'").get()?.n,0);db.exec('DROP TRIGGER fail_new_activity');
 assert.equal((await request(server).post('/api/tasks').set('Idempotency-Key','retry-after-failure').send(body)).status,201);
});
