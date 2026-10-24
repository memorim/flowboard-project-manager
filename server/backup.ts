import {backup,DatabaseSync} from 'node:sqlite';
import {open,rm,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeLog,type LogSink} from './observability.js';
export async function backupDatabase(source:string,destination:string,log:LogSink=writeLog){
 const requestId=crypto.randomUUID(),start=performance.now();let db:DatabaseSync|undefined,check:DatabaseSync|undefined,created=false;
 try{
  if(resolve(source)===resolve(destination))throw new Error('same_path');
  if(!(await stat(source)).isFile())throw new Error('invalid_source');
  db=new DatabaseSync(source,{readOnly:true});
  const target=await open(destination,'wx');created=true;await target.close();
  await backup(db,destination);check=new DatabaseSync(destination,{readOnly:true});
  if(check.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('invalid_backup');
  const bytes=(await stat(destination)).size;log({event:'database_backup',requestId,status:'ok',bytes,durationMs:Number((performance.now()-start).toFixed(2))});return {requestId,bytes};
 }catch(error){
  check?.close();check=undefined;if(created)await rm(destination,{force:true});
  log({event:'database_backup',requestId,status:'failed',durationMs:Number((performance.now()-start).toFixed(2))});throw Object.assign(error instanceof Error?error:new Error('backup_failed'),{requestId});
 }finally{check?.close();db?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [, ,source,destination]=process.argv;
 if(!source||!destination){console.error('Usage: pnpm backup <existing-source.db> <new-backup.db>');process.exitCode=1;}
 else await backupDatabase(source,destination).catch(()=>{console.error('Backup failed; see database_backup event. Existing destination files are never overwritten.');process.exitCode=1;});
}
