import {requestLog,safeError,type LogSink} from './observability.js';
import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, type Db } from './db.js';
import { sqliteAdapter } from './sqlite-adapter.js';
import { flowApi, type Actor } from '../src/flow-api.js';
export function createApp(db: Db = createDatabase(), log?:LogSink): Express {
 const app=express(),sql=sqliteAdapter(db);app.use(requestLog(log));app.use(express.text({type:'application/json',limit:'16kb'}));
 app.use('/api',async(req,res)=>{
  // ponytail: local fixture identities are trusted; the hosted adapter uses Sites identity, never this header.
  const actor=db.prepare('SELECT id,name,role,initials,color FROM members WHERE id=?').get(Number(req.get('X-Demo-Actor')||4)) as Actor|undefined;
  const request=new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`,{method:req.method,headers:req.headers as Record<string,string>,...(!['GET','HEAD'].includes(req.method)&&req.body?{body:req.body}:{})});
  const response=await flowApi(request,sql,actor??null,'local');res.status(response.status);response.headers.forEach((v,n)=>res.set(n,v));res.send(await response.text());
 });
 const dist=resolve('dist');if(existsSync(dist)){app.use(express.static(dist));app.get(/^(?!\/api(?:\/|$)).*/,(_req,res)=>res.sendFile(resolve(dist,'index.html')));}
 app.use((_req,res)=>res.status(404).json({message:'Маршрут не найден'}));app.use(safeError);return app;
}
