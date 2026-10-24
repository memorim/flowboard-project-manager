import {z} from 'zod';
import {taskSchema} from './task-schema.js';
type Row=Record<string,unknown>;
export type Result<T=Row>={results:T[];meta:{changes?:number;last_row_id?:number}};
export interface Statement {bind(...values:unknown[]):Statement;first<T=Row>():Promise<T|null>;all<T=Row>():Promise<Result<T>>;run():Promise<Result>}
// Native D1 subset, reused by the local SQLite adapter so authorization has one implementation.
export interface SqlDB {prepare(sql:string):Statement;batch(statements:Statement[]):Promise<Result[]>}
export type Actor={id:number;name:string;role:string;initials:string;color:string};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
const nameSchema=z.object({name:z.string().trim().min(2).max(80)}).strict();
const accessRole=z.enum(['editor','viewer']),versionSchema=z.number().int().positive();
const editSchema=taskSchema.extend({version:versionSchema});
const statusSchema=z.object({status:taskSchema.shape.status.removeDefault(),version:versionSchema}).strict();
const join=`SELECT t.*,p.name project_name,p.color project_color,m.name assignee_name,m.initials,m.color assignee_color FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN members m ON m.id=t.assignee_id`;
export async function tokenHash(token:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
export async function body(req:Request):Promise<unknown>{
 const reader=req.body?.getReader();if(!reader)return {};const chunks:Uint8Array[]=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new HttpError(413,'Слишком большой запрос');}chunks.push(value);}
 const data=new Uint8Array(size);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new HttpError(400,'Некорректный JSON');}
}
function parse<T>(schema:z.ZodType<T>,data:unknown):T{const r=schema.safeParse(data);if(!r.success)throw new HttpError(400,'Проверьте данные запроса');return r.data;}
export async function flowApi(req:Request,db:SqlDB,actor:Actor|null,mode:'local'|'chatgpt'){
 try{return await handle(req,db,actor,mode);}catch(error){if(error instanceof HttpError)return json({message:error.message},error.status);console.error('Flowboard request failed:',error instanceof Error?error.name:'UnknownError');return json({message:'Сервис временно недоступен. Повторите запрос.'},503);}
}
async function handle(req:Request,db:SqlDB,actor:Actor|null,mode:string){
 const url=new URL(req.url),path=url.pathname,method=req.method;
 const q=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values);
 if(!['GET','HEAD'].includes(method)&&(req.headers.get('sec-fetch-site')==='cross-site'||(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)))throw new HttpError(403,'Недопустимый источник запроса');
 if(path==='/api/health'&&method==='GET')return json({status:'ok'});
 // Only the public sandbox auto-enrols visitors. Other workspaces always require explicit membership.
 if(actor)await q("INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) VALUES (1,?,'editor')",actor.id).run();
 if(path==='/api/workspaces'&&method==='GET')return json((await q(`SELECT w.id,w.name,w.is_public,COALESCE(m.role,'viewer') access_role FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.member_id=? WHERE w.is_public=1 OR m.member_id IS NOT NULL ORDER BY w.id`,actor?.id??-1).all()).results);
 if(path==='/api/workspaces'&&method==='POST'){
  if(!actor)throw new HttpError(401,'Войдите для создания пространства');const {name}=parse(nameSchema,await body(req));
  const count=await q("SELECT COUNT(*) n FROM memberships WHERE member_id=? AND role='owner'",actor.id).first<{n:number}>();if((count?.n??0)>=10)throw new HttpError(429,'В демо до 10 пространств на участника');
  const [created]=await db.batch([q('INSERT INTO workspaces(name,is_public) VALUES (?,0)',name),q("INSERT INTO memberships(workspace_id,member_id,role) VALUES (last_insert_rowid(),?,'owner')",actor.id),q("INSERT INTO projects(name,client,color,progress,due_date,workspace_id) SELECT 'Основной проект','Команда','#ff6b3d',0,?,workspace_id FROM memberships WHERE member_id=? AND role='owner' ORDER BY workspace_id DESC LIMIT 1",new Date(Date.now()+7*86400000).toISOString().slice(0,10),actor.id)]);
  return json({id:created.meta.last_row_id,name,is_public:0,access_role:'owner'},201);
 }
 if(path==='/api/invitations/accept'&&method==='POST'){
  if(!actor)throw new HttpError(401,'Войдите для принятия приглашения');const {token}=parse(z.object({token:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),await body(req));
  const hash=await tokenHash(token),now=new Date().toISOString();const invitation=await q('SELECT workspace_id,accepted_by,expires_at FROM invitations WHERE token_hash=?',hash).first<{workspace_id:number;accepted_by:number|null;expires_at:string}>();
  if(!invitation||invitation.expires_at<=now||invitation.accepted_by!==null)throw new HttpError(410,'Приглашение истекло или уже использовано');
  await db.batch([q('INSERT OR IGNORE INTO memberships(workspace_id,member_id,role) SELECT workspace_id,?,role FROM invitations WHERE token_hash=? AND expires_at>? AND accepted_by IS NULL',actor.id,hash,now),q('UPDATE invitations SET accepted_by=? WHERE token_hash=? AND expires_at>? AND accepted_by IS NULL',actor.id,hash,now)]);
  const accepted=await q('SELECT accepted_by FROM invitations WHERE token_hash=?',hash).first<{accepted_by:number}>();if(accepted?.accepted_by!==actor.id)throw new HttpError(410,'Приглашение уже использовано');return json({workspaceId:invitation.workspace_id});
 }
 const workspace=Number(url.searchParams.get('workspace')||1);if(!Number.isSafeInteger(workspace)||workspace<1)throw new HttpError(400,'Некорректное пространство');
 const space=await q(`SELECT w.*,m.role access_role FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.member_id=? WHERE w.id=?`,actor?.id??-1,workspace).first<{id:number;name:string;is_public:number;access_role:string|null}>();
 if(!space||(!space.is_public&&!space.access_role))throw new HttpError(404,'Пространство не найдено');const role=space.access_role||'viewer';
 if(path==='/api/session'&&method==='GET')return json({mode,user:actor,workspace:{...space,access_role:role},canWrite:!!actor&&role!=='viewer'});
 if(method==='GET'){
  if(path==='/api/meta'){const [projects,members]=await db.batch([q('SELECT * FROM projects WHERE workspace_id=? ORDER BY name',workspace),q('SELECT m.id,m.name,m.role,m.initials,m.color,ms.role access_role FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=? ORDER BY name',workspace)]);return json({projects:projects.results,members:members.results});}
  if(path==='/api/tasks'){
   const search=(url.searchParams.get('search')||'').slice(0,200),status=url.searchParams.get('status')||'',project=Number(url.searchParams.get('project')||0);if(!Number.isSafeInteger(project)||project<0)throw new HttpError(400,'Некорректный проект');
   return json((await q(join+` WHERE p.workspace_id=? AND (?='' OR t.title LIKE ? OR t.description LIKE ?) AND (?='' OR ?='all' OR t.status=?) AND (?=0 OR t.project_id=?) ORDER BY t.due_date,t.id`,workspace,search,'%'+search+'%','%'+search+'%',status,status,status,project,project).all()).results);
  }
  if(path==='/api/dashboard'){
   const [stats,projects,activity]=await db.batch([
    q(`SELECT COUNT(*) total,COALESCE(SUM(t.status='done'),0) done,COALESCE(SUM(t.status='in_progress'),0) inProgress,COALESCE(SUM(t.status='review'),0) review FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.workspace_id=?`,workspace),
    q(`SELECT p.*,COUNT(t.id) task_count,COALESCE(SUM(t.status='done'),0) done_count,CASE WHEN COUNT(t.id)=0 THEN 0 ELSE ROUND(100.0*SUM(t.status='done')/COUNT(t.id)) END progress FROM projects p LEFT JOIN tasks t ON t.project_id=p.id WHERE p.workspace_id=? GROUP BY p.id ORDER BY p.due_date`,workspace),
    q('SELECT a.*,m.name,m.initials,m.color FROM activity a JOIN members m ON m.id=a.member_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 20',workspace)]);return json({stats:stats.results[0],projects:projects.results,activity:activity.results});
  }
  if(path==='/api/export'){
   if(role!=='owner')throw new HttpError(403,'Экспорт доступен владельцу');const [projects,tasks,members]=await db.batch([q('SELECT * FROM projects WHERE workspace_id=?',workspace),q(join+' WHERE p.workspace_id=?',workspace),q('SELECT m.id,m.name,ms.role FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=?',workspace)]);
   return json({format:'flowboard-workspace-v1',exportedAt:new Date().toISOString(),workspace:{id:space.id,name:space.name},projects:projects.results,tasks:tasks.results,members:members.results});
  }
 }
 if(!actor)throw new HttpError(401,'Войдите для изменения данных');if(role==='viewer')throw new HttpError(403,'Роль наблюдателя разрешает только просмотр');
 const recent=await q('SELECT COUNT(*) n FROM activity WHERE member_id=? AND created_at>?',actor.id,new Date(Date.now()-60000).toISOString()).first<{n:number}>();if((recent?.n||0)>=30)throw new HttpError(429,'До 30 изменений в минуту. Повторите позднее.');
 const event=(text:string,conditional=false)=>q(`INSERT INTO activity(text,member_id,created_at,workspace_id) SELECT ?,?,?,? ${conditional?'WHERE changes()>0':''}`,text,actor.id,new Date().toISOString(),workspace);
 if(path==='/api/invitations'&&method==='POST'){
  if(role!=='owner')throw new HttpError(403,'Приглашать может только владелец');const input=parse(z.object({role:accessRole}).strict(),await body(req));
  const count=await q('SELECT COUNT(*) n FROM invitations WHERE workspace_id=? AND accepted_by IS NULL AND expires_at>?',workspace,new Date().toISOString()).first<{n:number}>();if((count?.n||0)>=20)throw new HttpError(429,'Сначала используйте действующие приглашения');
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join(''),expiresAt=new Date(Date.now()+7*86400000).toISOString();
  await q('INSERT INTO invitations(workspace_id,token_hash,role,expires_at,created_by) VALUES (?,?,?,?,?)',workspace,await tokenHash(token),input.role,expiresAt,actor.id).run();return json({token,expiresAt,role:input.role},201);
 }
 const memberMatch=path.match(/^\/api\/members\/(\d+)$/);
 if(memberMatch&&['PATCH','DELETE'].includes(method)){
  if(role!=='owner')throw new HttpError(403,'Права меняет только владелец');const target=Number(memberMatch[1]);const member=await q('SELECT role FROM memberships WHERE workspace_id=? AND member_id=?',workspace,target).first<{role:string}>();
  if(!member)throw new HttpError(404,'Участник не найден');if(member.role==='owner')throw new HttpError(400,'Нельзя удалить или понизить владельца');
  if(method==='DELETE'){await db.batch([q('UPDATE tasks SET assignee_id=NULL,version=version+1 WHERE assignee_id=? AND project_id IN (SELECT id FROM projects WHERE workspace_id=?)',target,workspace),q('DELETE FROM memberships WHERE workspace_id=? AND member_id=?',workspace,target),event('удалил(а) участника из пространства')]);return new Response(null,{status:204});}
  const input=parse(z.object({role:accessRole}).strict(),await body(req));await db.batch([q('UPDATE memberships SET role=? WHERE workspace_id=? AND member_id=?',input.role,workspace,target),event('изменил(а) права участника')]);return json({id:target,role:input.role});
 }
 if(path==='/api/projects'&&method==='POST'){
  const {name}=parse(nameSchema,await body(req));const count=await q('SELECT COUNT(*) n FROM projects WHERE workspace_id=?',workspace).first<{n:number}>();if((count?.n||0)>=30)throw new HttpError(429,'В демо до 30 проектов на пространство');
  const [result]=await db.batch([q("INSERT INTO projects(name,client,color,progress,due_date,workspace_id) VALUES (?,'Команда','#7c64e3',0,?,?)",name,new Date(Date.now()+7*86400000).toISOString().slice(0,10),workspace),event(`создал(а) проект «${name}»`)]);return json({id:result.meta.last_row_id,name},201);
 }
 const match=path.match(/^\/api\/tasks\/(\d+)(\/status)?$/),id=Number(match?.[1]);
 if(path==='/api/tasks'&&method==='POST'){
  const t=parse(taskSchema,await body(req));await references(t.projectId,t.assigneeId);
  const [result]=await db.batch([q('INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date) VALUES (?,?,?,?,?,?,?)',t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate),event(`создал(а) задачу «${t.title}»`)]);return json({id:result.meta.last_row_id,...t,version:1},201);
 }
 if(match&&['PATCH','DELETE'].includes(method)){
  const old=await q('SELECT t.id,t.title,t.status,t.version FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=?',id,workspace).first<{id:number;title:string;status:string;version:number}>();if(!old)throw new HttpError(404,'Задача не найдена');
  const input=await body(req),expected=parse(z.object({version:versionSchema}).passthrough(),input).version;if(expected!==old.version)return conflict();
  let statement:Statement,text:string;
  if(method==='DELETE'){parse(z.object({version:versionSchema}).strict(),input);statement=q('DELETE FROM tasks WHERE id=? AND version=?',id,expected);text=`удалил(а) задачу «${old.title}»`;}
  else if(match[2]){const t=parse(statusSchema,input);if(old.status===t.status)return json({id,status:t.status,version:old.version});statement=q('UPDATE tasks SET status=?,version=version+1 WHERE id=? AND version=?',t.status,id,expected);text=`изменил(а) статус «${old.title}» на ${t.status}`;}
  else{const t=parse(editSchema,input);await references(t.projectId,t.assigneeId);statement=q('UPDATE tasks SET title=?,description=?,status=?,priority=?,project_id=?,assignee_id=?,due_date=?,version=version+1 WHERE id=? AND version=?',t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate,id,expected);text=`отредактировал(а) задачу «${t.title}»`;}
  const [result]=await db.batch([statement,event(text,true)]);if(!result.meta.changes)return conflict();if(method==='DELETE')return new Response(null,{status:204});return json({id,...(await q('SELECT status,version FROM tasks WHERE id=?',id).first())});
 }
 throw new HttpError(404,'Маршрут не найден');
 async function references(projectId:number,assigneeId:number|null){if(!await q('SELECT id FROM projects WHERE id=? AND workspace_id=?',projectId,workspace).first())throw new HttpError(404,'Проект не найден в пространстве');if(assigneeId!==null&&!await q('SELECT member_id FROM memberships WHERE member_id=? AND workspace_id=?',assigneeId,workspace).first())throw new HttpError(404,'Исполнитель не найден в команде');}
 function conflict(){return json({code:'version_conflict',message:'Задача уже изменена другим участником. Обновите список и откройте её заново; введённый текст сохранён в форме.'},409);}
}
