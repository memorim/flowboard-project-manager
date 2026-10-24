import test from 'node:test';
import assert from 'node:assert/strict';
import {backup,DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase} from '../server/db.js';
test('SQLite online backup restores identical records and passes integrity checks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'portfolio-backup-')),db=createDatabase(join(dir,'source.db'));let restored:DatabaseSync|undefined;
 try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
  await backup(db,join(dir,'backup.db'));restored=new DatabaseSync(join(dir,'backup.db'));
  assert.equal(restored.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const {name} of tables)assert.deepEqual(restored.prepare(`SELECT * FROM "${name}"`).all(),db.prepare(`SELECT * FROM "${name}"`).all());
 }finally{restored?.close();db.close();await rm(dir,{recursive:true,force:true});}
});
