import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import request from 'supertest';
process.env.NODE_ENV='test';
const config=JSON.parse(readFileSync('tests/contract-config.json','utf8')),baseline='docs/API_CONTRACT.json';
const dbModule=await import(pathToFileURL(resolve(config.databaseModule)).href),appModule=await import(pathToFileURL(resolve(config.appModule)).href);
const db=(dbModule.createDb||dbModule.createDatabase)(':memory:'),agent=request.agent(appModule.createApp(db));
const nullable={response_ms:'number',uptime:'number',last_checked:'string',assignee_id:'number',assignee_name:'string',assignee_color:'string',initials:'string',deleted_at:'string',resolved_at:'string',paid_at:'string',user_id:'number'};
function shape(value,key=''){
 if(nullable[key])return nullable[key]+'|null';
 if(value===null)return 'null';if(Array.isArray(value))return value.length?[shape(value[0])]:[];
 if(typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,shape(value[k],k)]));return typeof value;
}
function verify(value,expected,path){
 if(typeof expected==='string'){assert.ok(expected.split('|').includes(value===null?'null':typeof value),path+' type changed');return;}
 if(Array.isArray(expected)){assert.ok(Array.isArray(value),path+' must be an array');if(expected.length)for(const item of value)verify(item,expected[0],path+'[]');return;}
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value),path+' must be an object');for(const [key,type] of Object.entries(expected)){assert.ok(Object.hasOwn(value,key),path+'.'+key+' is missing');verify(value[key],type,path+'.'+key);}
}
assert.throws(()=>verify({id:'changed'},{id:'number'},'regression'));assert.throws(()=>verify({},{id:'number'},'regression'));verify({id:1,extra:true},{id:'number'},'compatible addition');
try{
 if(config.login){const response=await agent.post('/api/login').send(config.login);assert.equal(response.status,200);}
 if(config.setup){const response=await agent.post(config.setup.path).send(config.setup.body);assert.equal(response.status,201);}
 const results=[],responses=[];
 for(const item of config.endpoints){const response=await agent[item.method||'get'](item.path).send(item.body);assert.equal(response.status,item.status||200,item.path+' status changed');assert.match(response.headers['content-type'],/json/);responses.push(response.body);results.push({method:item.method||'get',path:item.path,status:response.status,body:shape(response.body)});}
 if(process.argv.includes('--record')){assert.ok(!process.env.CI,'Contract snapshots are reviewed locally, not regenerated in CI');writeFileSync(baseline,JSON.stringify(results,null,2)+'\n');}
 else{
  const expected=JSON.parse(readFileSync(baseline,'utf8'));assert.equal(results.length,expected.length,'Endpoint coverage changed');
  for(let i=0;i<expected.length;i++){assert.equal(results[i].path,expected[i].path);assert.equal(results[i].status,expected[i].status);verify(responses[i],expected[i].body,expected[i].path);}
 }
 console.log(JSON.stringify({check:'http_contract',endpoints:results.length,status:'ok'}));
}finally{db.close();}
