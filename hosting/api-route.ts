import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {flowApi,tokenHash,type Actor,type SqlDB} from '../../portfolio/flow-api';
import seed from './seed.json';
import {seatlyApi} from '../../seatly-data/api';
export const dynamic='force-dynamic';
async function route(req:Request){
 try{
  const db=env.DB;if(!db)return Response.json({message:'База временно недоступна'},{status:503});
  if(new URL(req.url).pathname.startsWith('/api/seatly/')){const identity=await getChatGPTUser();return seatlyApi(req,db as unknown as SqlDB,identity?await tokenHash(identity.userId):null);}
  const workspace=await db.prepare('SELECT id FROM workspaces WHERE id=1').first();
  if(!workspace)await db.prepare("INSERT OR IGNORE INTO workspaces(id,name,is_public) VALUES (1,'Общее демо',1)").run();
  const count=await db.prepare('SELECT COUNT(*) n FROM members').first<{n:number}>();
  if(!count?.n){
   const date=(v:string)=>new Date(Date.now()+new Date(v).getTime()-new Date('2026-07-04').getTime()).toISOString().slice(0,10);
   await db.batch([
    ...seed.members.map(m=>db.prepare('INSERT OR IGNORE INTO members(id,name,role,initials,color) VALUES (?,?,?,?,?)').bind(m.id,m.name,m.role,m.initials,m.color)),
    ...seed.projects.map(p=>db.prepare('INSERT OR IGNORE INTO projects(id,name,client,color,due_date) VALUES (?,?,?,?,?)').bind(p.id,p.name,p.client,p.color,date(p.due_date))),
    ...seed.tasks.map(t=>db.prepare('INSERT OR IGNORE INTO tasks(id,title,description,status,priority,project_id,assignee_id,due_date) VALUES (?,?,?,?,?,?,?,?)').bind(t.id,t.title,t.description,t.status,t.priority,t.project_id,t.assignee_id,date(t.due_date))),
    db.prepare('INSERT OR IGNORE INTO activity(id,text,member_id,created_at) VALUES (1,?,?,?)').bind('подготовил(а) демонстрационное рабочее пространство',4,new Date().toISOString())
   ]);
  }
  await db.prepare("INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) SELECT 1,id,'editor' FROM members WHERE id<=4").run();
  const identity=await getChatGPTUser();let actor:Actor|null=null;
  if(identity){const key=await tokenHash(identity.userId);await db.prepare('INSERT OR IGNORE INTO members(name,role,initials,color,site_key) VALUES (?,?,?,?,?)').bind('Участник '+key.slice(0,4).toUpperCase(),'Участник демо',key.slice(0,2).toUpperCase(),'#d7c9ff',key).run();actor=await db.prepare('SELECT id,name,role,initials,color FROM members WHERE site_key=?').bind(key).first<Actor>();}
  return flowApi(req,db as unknown as SqlDB,actor,'chatgpt');
 }catch(e){console.error('Flowboard adapter failed:',e instanceof Error?e.name:'UnknownError');return Response.json({message:'Сервис временно недоступен'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export{route as GET,route as POST,route as PATCH,route as DELETE};
