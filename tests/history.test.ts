import test from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';import {createDatabase} from '../server/db.js';import {createApp} from '../server/app.js';
test('trash/history are scoped, restoration is versioned and audit failure rolls back',async(t)=>{
 const db=createDatabase(':memory:'),server=createApp(db).listen(0);await new Promise<void>(r=>server.once('listening',r));t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
 const call=(actor:number,path:string,method='get',body?:object)=>{const r=(request(server) as unknown as Record<string,(p:string)=>request.Test>)[method](path).set('X-Demo-Actor',String(actor));return body?r.send(body):r;};
 const wid=(await call(1,'/api/workspaces','post',{name:'Synthetic history team'})).body.id,scope=(p:string)=>p+(p.includes('?')?'&':'?')+'workspace='+wid;
 const token=(await call(1,scope('/api/invitations'),'post',{role:'viewer'})).body.token;await call(3,'/api/invitations/accept','post',{token});
 const projectId=(await call(1,scope('/api/meta'))).body.projects[0].id,body={title:'Original task',description:'Before',status:'todo',priority:'medium',projectId,assigneeId:null,dueDate:'2030-01-10'};
 const created=await call(1,scope('/api/tasks'),'post',body);assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await call(1,scope('/api/tasks/'+id),'patch',{...body,title:'Changed task',version:1})).status,200);
 assert.equal((await call(1,scope('/api/tasks/'+id),'delete',{version:2})).status,204);
 assert.equal((await call(1,scope('/api/tasks/page'))).body.total,0);const trash=await call(1,scope('/api/tasks/trash'));assert.equal(trash.body.total,1);assert.equal(trash.body.items[0].version,3);
 assert.equal((await call(4,scope('/api/tasks/'+id+'/history'))).status,404);assert.equal((await call(4,scope('/api/tasks/trash'))).status,404);
 assert.equal((await call(3,scope('/api/tasks/'+id+'/restore'),'patch',{version:3})).status,403);assert.equal((await call(1,scope('/api/tasks/'+id+'/restore'),'patch',{version:2})).status,409);
 const restored=await Promise.all([call(1,scope('/api/tasks/'+id+'/restore'),'patch',{version:3}),call(1,scope('/api/tasks/'+id+'/restore'),'patch',{version:3})]);assert.equal(restored.filter(r=>r.status===200).length,1);assert.ok(restored.every(r=>[200,404,409].includes(r.status)));
 assert.equal((await call(1,scope('/api/tasks/trash'))).body.total,0);const history=(await call(3,scope('/api/tasks/'+id+'/history'))).body;assert.deepEqual(history.map((h:{version:number})=>h.version),[4,3,2,1]);assert.equal(history[2].before.title,'Original task');assert.equal(history[2].after.title,'Changed task');assert.equal(history[0].action,'restored');assert.equal(history[0].actor_name,'Анна Морозова');
 db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END;");assert.equal((await call(1,scope('/api/tasks/'+id),'patch',{...body,title:'Must roll back',version:4})).status,503);const saved=db.prepare('SELECT title,version FROM tasks WHERE id=?').get(id);assert.equal(saved?.title,'Changed task');assert.equal(saved?.version,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM task_history WHERE task_id=?').get(id)?.n,4);
});
