import {createApp} from '../server/app.js';
import {createDatabase} from '../server/db.js';
import {writeFile} from 'node:fs/promises';
const db=createDatabase(':memory:'),server=createApp(db).listen(0,'127.0.0.1');
await new Promise<void>(r=>server.once('listening',r));
const address=server.address();if(!address||typeof address==='string')throw new Error('No listener');
const url=`http://127.0.0.1:${address.port}/api/dashboard`,times:number[]=[];
try{
 for(let i=0;i<10;i++)await(await fetch(url)).arrayBuffer();
 const started=performance.now();await Promise.all(Array.from({length:10},async()=>{for(let i=0;i<20;i++){const t=performance.now(),r=await fetch(url);if(r.status!==200)throw new Error(`HTTP ${r.status}`);await r.arrayBuffer();times.push(performance.now()-t);}}));
 times.sort((a,b)=>a-b);const percentile=(q:number)=>Number(times[Math.ceil(times.length*q)-1].toFixed(2));
 const result={kind:'synthetic-local-http',date:new Date().toISOString(),node:process.version,platform:process.platform,endpoint:'/api/dashboard',requests:times.length,concurrency:10,errors:0,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),elapsed_ms:Number((performance.now()-started).toFixed(2)),limits:'Loopback HTTP and fresh in-memory SQLite; not hosted latency, user feedback or production capacity.'};
 await writeFile('docs/SYNTHETIC_METRICS.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));db.close();}
