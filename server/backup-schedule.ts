import {mkdir,readFile,writeFile,rename,readdir,lstat,unlink} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {backupDatabase} from './backup.js';
import {writeLog,type LogSink} from './observability.js';
type State={lastSuccess:string|null;lastFailure:string|null;activeAlert:boolean;requestId?:string};
export function backupSchedule(source:string,{directory=resolve('data/backups'),intervalMs=86400000,retentionDays=7,now=()=>new Date(),backup=backupDatabase,log=writeLog,notify=async(_event:object)=>{}}:{directory?:string;intervalMs?:number;retentionDays?:number;now?:()=>Date;backup?:typeof backupDatabase;log?:LogSink;notify?:(event:object)=>Promise<void>}={}){
 if(!Number.isFinite(intervalMs)||intervalMs<1000||!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365)throw new Error('Invalid backup schedule');
 const root=resolve(directory),statusFile=join(root,'status.json');let state:State={lastSuccess:null,lastFailure:null,activeAlert:false},loaded=false,running=false,stopped=false,timer:ReturnType<typeof setTimeout>|undefined,nextAttempt=0;
 const load=async()=>{if(loaded)return;await mkdir(root,{recursive:true});try{const old=JSON.parse(await readFile(statusFile,'utf8'));if(typeof old==='object'&&old&&(!old.lastSuccess||Number.isFinite(Date.parse(old.lastSuccess))))state={lastSuccess:old.lastSuccess||null,lastFailure:old.lastFailure||null,activeAlert:old.activeAlert===true};}catch{/* A missing or damaged status file must not prevent creating a fresh verified backup. */}loaded=true;};
 const persist=async()=>{const temp=join(root,'.status-'+crypto.randomUUID()+'.tmp');try{await writeFile(temp,JSON.stringify(state),{flag:'wx',mode:0o600});await rename(temp,statusFile);}finally{await unlink(temp).catch(()=>{});}};
 const run=async()=>{
  if(running||stopped)return false;running=true;const date=now();
  try{
   await load();const filename='auto-'+date.toISOString().replaceAll(':','-')+'-'+crypto.randomUUID()+'.sqlite';const result=await backup(source,join(root,filename),log);
   // Retention is applied only after a new copy has passed integrity checks, and only to this scheduler's files.
   for(const entry of await readdir(root)){
    if(entry===filename)continue;
    if(!/^auto-[0-9TZ.-]+-[a-f0-9-]{36}\.sqlite$/.test(entry))continue;
    const file=resolve(root,entry);if(!file.startsWith(root+sep))throw new Error('Invalid retention target');const stat=await lstat(file);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtimeMs<date.getTime()-retentionDays*86400000)await unlink(file);
   }
   state={...state,lastSuccess:date.toISOString(),activeAlert:false,requestId:result.requestId};nextAttempt=date.getTime()+intervalMs;await persist();log({event:'backup_schedule',status:'ok',requestId:result.requestId});return true;
  }catch(error){
   const wasActive=state.activeAlert;state={...state,lastFailure:date.toISOString(),activeAlert:true,requestId:(error as {requestId?:string}|null)?.requestId||crypto.randomUUID()};nextAttempt=date.getTime()+Math.min(intervalMs,300000);
   await persist().catch(()=>{});const alert={event:'backup_alert',severity:'error',status:'failed',requestId:state.requestId!,at:date.toISOString()};log(alert);
   if(!wasActive)try{await notify(alert);}catch{log({event:'backup_notification',status:'failed',requestId:state.requestId!});}
   return false;
  }finally{running=false;}
 };
 const start=()=>{const tick=async()=>{try{await load();if(now().getTime()>=nextAttempt&&(state.activeAlert||!state.lastSuccess||now().getTime()<Date.parse(state.lastSuccess)||now().getTime()-Date.parse(state.lastSuccess)>=intervalMs))await run();}catch{log({event:'backup_schedule',status:'unavailable'});}if(!stopped){timer=setTimeout(tick,Math.min(intervalMs,60000));timer.unref();}};void tick();};
 return {run,start,stop:()=>{stopped=true;clearTimeout(timer);},status:()=>({...state}),get running(){return running;}};
}
export function backupWebhook(url:string|undefined,token=''){
 if(!url)return async()=>{};
 const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password||target.hash)throw new Error('Backup alert endpoint must be fixed HTTPS without credentials');
 return async(event:object)=>{const response=await fetch(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(event)});if(!response.ok)throw new Error('Alert delivery failed');};
}
