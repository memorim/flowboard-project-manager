import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=realpathSync('.'),baseline=JSON.parse(readFileSync('tests/upgrade-baseline.json','utf8'));
assert.match(baseline.commit,/^[a-f0-9]{40}$/);
try{execFileSync('git',['cat-file','-e',baseline.commit],{stdio:'ignore'});}catch{execFileSync('git',['fetch','--depth=1','origin',baseline.commit],{stdio:'pipe'});}
const directory=mkdtempSync(join(root,'.upgrade-test-'));
const quote=s=>'"'+s.replaceAll('"','""')+'"';
function snapshot(db){
 return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,columns:db.prepare('PRAGMA table_info('+quote(name)+')').all().map(c=>c.name),rows:db.prepare('SELECT * FROM '+quote(name)).all()}));
}
let previous,current;
try{
 const archive=join(directory,'source.tar');execFileSync('git',['archive','--format=tar',baseline.commit,'-o',archive]);execFileSync('tar',['-xf',archive,'-C',directory]);
 process.env.NODE_ENV='test';
 const older=await import(pathToFileURL(join(directory,baseline.module)).href),latest=await import(pathToFileURL(resolve(baseline.module)).href),file=join(directory,'previous.sqlite');
 previous=(older.createDb||older.createDatabase)(file);
 const before=snapshot(previous);assert.ok(before.some(t=>t.rows.length),'Previous release must contain records');previous.close();previous=null;
 current=(latest.createDb||latest.createDatabase)(file);
 for(const table of before){
  const after=current.prepare('SELECT '+table.columns.map(quote).join(',')+' FROM '+quote(table.name)).all();
  const order=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(table.columns.map(c=>[c,r[c]])))).sort();assert.deepEqual(order(after),order(table.rows),'Data changed in '+table.name);
 }
 assert.equal(current.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(current.prepare('PRAGMA foreign_key_check').all(),[]);
 console.log(JSON.stringify({check:'previous_release_upgrade',from:baseline.commit,tables:before.length,records:before.reduce((n,t)=>n+t.rows.length,0),status:'ok'}));
}finally{
 previous?.close();current?.close();assert.ok(realpathSync(directory).startsWith(root+sep));rmSync(directory,{recursive:true,force:true});
}
