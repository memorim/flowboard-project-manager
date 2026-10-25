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
const statusSchema=z.object({status:taskSchema.shape.status.unwrap(),version:versionSchema}).strict();
const join=`SELECT t.id,t.title,t.description,t.status,t.priority,t.project_id,t.assignee_id,t.due_date,t.version,t.deleted_at,p.name project_name,p.color project_color,m.name assignee_name,m.initials,m.color assignee_color FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN members m ON m.id=t.assignee_id`;
export async function tokenHash(token:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
export async function body(req:Request):Promise<unknown>{
 const reader=req.body?.getReader();if(!reader)return {};const chunks:Uint8Array[]=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new HttpError(413,'Слишком большой запрос');}chunks.push(value);}
 const data=new Uint8Array(size);let offset=0;for(const part of chunks){data.set(part,offset);offset+=part.byteLength;}
 try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new HttpError(400,'Некорректный JSON');}
}
export function operationKey(req:Request,scope:string){const key=req.headers.get('Idempotency-Key');if(key===null)return null;if(!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw new HttpError(400,'Некорректный ключ операции');return scope+':'+key;}
function replay(row:{request_payload:string;create_result:string},payload:string){if(row.request_payload!==payload)throw new HttpError(409,'Ключ уже использован с другими данными');return json(JSON.parse(row.create_result),201);}
function parse<T>(schema:z.ZodType<T>,data:unknown):T{const r=schema.safeParse(data);if(!r.success)throw new HttpError(400,'Проверьте данные запроса');return r.data;}
export async function flowApi(req:Request,db:SqlDB,actor:Actor|null,mode:'local'|'chatgpt'){
 try{return await handle(req,db,actor,mode);}catch(error){if(String(error).includes('flow_access_denied'))return json({message:'Право на изменение отозвано'},403);if(String(error).includes('flow_assignee_missing'))return json({message:'Исполнитель больше не состоит в команде'},409);if(error instanceof HttpError)return json({message:error.message},error.status);return json({message:'Сервис временно недоступен. Повторите запрос.'},503);}
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
  if(path==='/api/meta'){const [projects,members]=await db.batch([q('SELECT * FROM projects WHERE workspace_id=? ORDER BY name',workspace),q('SELECT m.id,m.name,m.role,m.initials,m.color,ms.role access_role,(SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.assignee_id=m.id AND p.workspace_id=ms.workspace_id AND t.deleted_at IS NULL) task_count FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=? ORDER BY name',workspace)]);return json({projects:projects.results,members:members.results});}
  if(path==='/api/tasks'||path==='/api/tasks/page'||path==='/api/tasks/trash'){
   const search=(url.searchParams.get('search')||'').trim().slice(0,200),status=url.searchParams.get('status')||'',project=Number(url.searchParams.get('project')||0),assignee=url.searchParams.get('assignee')||'';
   const limit=Number(url.searchParams.get('limit')||40),offset=Number(url.searchParams.get('offset')||0);
   if(!Number.isSafeInteger(project)||project<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000||(status&&!['todo','in_progress','review','done','all'].includes(status))||(assignee&&assignee!=='none'&&!/^[1-9]\d*$/.test(assignee)))throw new HttpError(400,'Некорректные параметры страницы');
   const clauses=['p.workspace_id=?',path.endsWith('/trash')?'t.deleted_at IS NOT NULL':'t.deleted_at IS NULL'],values:unknown[]=[workspace];
   if(search){clauses.push('(t.title LIKE ? OR t.description LIKE ?)');values.push('%'+search+'%','%'+search+'%');}
   if(status&&status!=='all'){clauses.push('t.status=?');values.push(status);}if(project){clauses.push('t.project_id=?');values.push(project);}if(assignee){clauses.push(assignee==='none'?'t.assignee_id IS NULL':'t.assignee_id=?');if(assignee!=='none')values.push(Number(assignee));}
   const where=' WHERE '+clauses.join(' AND '),[rows,count]=await db.batch([q(join+where+' ORDER BY t.due_date,t.id LIMIT ? OFFSET ?',...values,limit,offset),q('SELECT COUNT(*) total FROM tasks t JOIN projects p ON p.id=t.project_id'+where,...values)]);
   return json((path.endsWith('/page')||path.endsWith('/trash'))?{items:rows.results,total:(count.results[0] as {total:number}).total,limit,offset}:rows.results);
  }
  if(path==='/api/dashboard'){
   const [stats,projects,activity]=await db.batch([
    q(`SELECT COUNT(*) total,COALESCE(SUM(t.status='done'),0) done,COALESCE(SUM(t.status='in_progress'),0) inProgress,COALESCE(SUM(t.status='review'),0) review FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.workspace_id=? AND t.deleted_at IS NULL`,workspace),
    q(`SELECT p.*,COUNT(t.id) task_count,COALESCE(SUM(t.status='done'),0) done_count,CASE WHEN COUNT(t.id)=0 THEN 0 ELSE ROUND(100.0*SUM(t.status='done')/COUNT(t.id)) END progress FROM projects p LEFT JOIN tasks t ON t.project_id=p.id AND t.deleted_at IS NULL WHERE p.workspace_id=? GROUP BY p.id ORDER BY p.due_date`,workspace),
    q('SELECT a.*,m.name,m.initials,m.color FROM activity a JOIN members m ON m.id=a.member_id WHERE a.workspace_id=? ORDER BY a.id DESC LIMIT 20',workspace)]);return json({stats:stats.results[0],projects:projects.results,activity:activity.results});
  }
  const historyMatch=path.match(/^\/api\/tasks\/(\d+)\/history$/);
  if(historyMatch){const id=Number(historyMatch[1]);if(!await q('SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=?',id,workspace).first())throw new HttpError(404,'Задача не найдена');const entries=(await q('SELECT h.id,h.action,h.version,h.created_at,h.before_json,h.after_json,m.name actor_name FROM task_history h LEFT JOIN members m ON m.id=h.member_id WHERE h.task_id=? AND h.workspace_id=? ORDER BY h.version DESC LIMIT 100',id,workspace).all()).results;return json(entries.map(({before_json,after_json,...h})=>({...h,before:before_json?JSON.parse(String(before_json)):null,after:JSON.parse(String(after_json))})));}
  if(path==='/api/export'){
   if(role!=='owner')throw new HttpError(403,'Экспорт доступен владельцу');const [projects,tasks,members]=await db.batch([q('SELECT * FROM projects WHERE workspace_id=?',workspace),q(join+' WHERE p.workspace_id=?',workspace),q('SELECT m.id,m.name,ms.role FROM members m JOIN memberships ms ON ms.member_id=m.id WHERE ms.workspace_id=?',workspace)]);
   return json({format:'flowboard-workspace-v1',exportedAt:new Date().toISOString(),workspace:{id:space.id,name:space.name},projects:projects.results,tasks:tasks.results,members:members.results});
  }
 }
 if(!actor)throw new HttpError(401,'Войдите для изменения данных');if(role==='viewer')throw new HttpError(403,'Роль наблюдателя разрешает только просмотр');
 const recent=await q('SELECT COUNT(*) n FROM activity WHERE member_id=? AND created_at>?',actor.id,new Date(Date.now()-60000).toISOString()).first<{n:number}>();const limited=(recent?.n||0)>=30;if(limited&&!(path==='/api/tasks'&&method==='POST'))throw new HttpError(429,'До 30 изменений в минуту. Повторите позднее.');
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
  if(method==='DELETE'){const [,removed]=await db.batch([q("UPDATE tasks SET assignee_id=NULL,version=version+1,changed_by=? WHERE assignee_id=? AND project_id IN (SELECT id FROM projects WHERE workspace_id=?) AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",actor.id,target,workspace,workspace,actor.id),q("DELETE FROM memberships WHERE workspace_id=? AND member_id=? AND role!='owner' AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",workspace,target,workspace,actor.id),event('удалил(а) участника из пространства',true)]);if(!removed.meta.changes)throw new HttpError(403,'Право на изменение отозвано');return new Response(null,{status:204});}
  const input=parse(z.object({role:accessRole}).strict(),await body(req));const [changed]=await db.batch([q("UPDATE memberships SET role=? WHERE workspace_id=? AND member_id=? AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role='owner')",input.role,workspace,target,workspace,actor.id),event('изменил(а) права участника',true)]);if(!changed.meta.changes)throw new HttpError(403,'Право на изменение отозвано');return json({id:target,role:input.role});
 }
 if(path==='/api/projects'&&method==='POST'){
  const {name}=parse(nameSchema,await body(req));const count=await q('SELECT COUNT(*) n FROM projects WHERE workspace_id=?',workspace).first<{n:number}>();if((count?.n||0)>=30)throw new HttpError(429,'В демо до 30 проектов на пространство');
  const [result]=await db.batch([q("INSERT INTO projects(name,client,color,progress,due_date,workspace_id) SELECT ?,'Команда','#7c64e3',0,?,? WHERE EXISTS(SELECT 1 FROM memberships WHERE workspace_id=? AND member_id=? AND role IN ('owner','editor'))",name,new Date(Date.now()+7*86400000).toISOString().slice(0,10),workspace,workspace,actor.id),event(`создал(а) проект «${name}»`,true)]);if(!result.meta.changes)throw new HttpError(403,'Право на изменение отозвано');return json({id:result.meta.last_row_id,name},201);
 }
 const match=path.match(/^\/api\/tasks\/(\d+)(\/status|\/restore)?$/),id=Number(match?.[1]);
 if(path==='/api/tasks'&&method==='POST'){
  const t=parse(taskSchema,await body(req)),payload=JSON.stringify(t),key=operationKey(req,actor.id+':'+workspace);await references(t.projectId,t.assigneeId);
  if(key){const previous=await q('SELECT request_payload,create_result FROM tasks WHERE request_key=?',key).first<{request_payload:string;create_result:string}>();if(previous)return replay(previous,payload);}
  if(limited)throw new HttpError(429,'До 30 изменений в минуту. Повторите позднее.');
  const statements=[q('INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date,request_key,request_payload,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING',t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate,key,key?payload:null,actor.id),event(`создал(а) задачу «${t.title}»`,true)];
  if(key)statements.push(q("UPDATE tasks SET create_result=json_set(?, '$.id',id,'$.version',1) WHERE request_key=? AND create_result IS NULL",payload,key));
  const [result]=await db.batch(statements);
  if(key)return replay((await q('SELECT request_payload,create_result FROM tasks WHERE request_key=?',key).first<{request_payload:string;create_result:string}>())!,payload);
  return json({id:result.meta.last_row_id,...t,version:1},201);
 }
 if(match&&['PATCH','DELETE'].includes(method)){
  const old=await q('SELECT t.id,t.title,t.status,t.version,t.deleted_at FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=? AND '+(match[2]==='/restore'?'t.deleted_at IS NOT NULL':'t.deleted_at IS NULL'),id,workspace).first<{id:number;title:string;status:string;version:number;deleted_at:string|null}>();if(!old)throw new HttpError(404,'Задача не найдена');
  const input=await body(req),expected=parse(z.object({version:versionSchema}).passthrough(),input).version;if(expected!==old.version)return conflict();
  let statement:Statement,text:string;
  if(method==='DELETE'){parse(z.object({version:versionSchema}).strict(),input);statement=q('UPDATE tasks SET deleted_at=?,version=version+1,changed_by=? WHERE id=? AND version=? AND deleted_at IS NULL',new Date().toISOString(),actor.id,id,expected);text=`удалил(а) задачу «${old.title}»`;}
  else if(match[2]==='/restore'){parse(z.object({version:versionSchema}).strict(),input);statement=q('UPDATE tasks SET deleted_at=NULL,version=version+1,changed_by=? WHERE id=? AND version=? AND deleted_at IS NOT NULL',actor.id,id,expected);text=`восстановил(а) задачу «${old.title}»`;}
  else if(match[2]){const t=parse(statusSchema,input);if(old.status===t.status)return json({id,status:t.status,version:old.version});statement=q('UPDATE tasks SET status=?,version=version+1,changed_by=? WHERE id=? AND version=?',t.status,actor.id,id,expected);text=`изменил(а) статус «${old.title}» на ${t.status}`;}
  else{const t=parse(editSchema,input);await references(t.projectId,t.assigneeId);statement=q('UPDATE tasks SET title=?,description=?,status=?,priority=?,project_id=?,assignee_id=?,due_date=?,version=version+1,changed_by=? WHERE id=? AND version=?',t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate,actor.id,id,expected);text=`отредактировал(а) задачу «${t.title}»`;}
  const [result]=await db.batch([statement,event(text,true)]);if(!result.meta.changes)return conflict();if(method==='DELETE')return new Response(null,{status:204});return json({id,...(await q('SELECT status,version FROM tasks WHERE id=?',id).first())});
 }
 throw new HttpError(404,'Маршрут не найден');
 async function references(projectId:number,assigneeId:number|null){if(!await q('SELECT id FROM projects WHERE id=? AND workspace_id=?',projectId,workspace).first())throw new HttpError(404,'Проект не найден в пространстве');if(assigneeId!==null&&!await q('SELECT member_id FROM memberships WHERE member_id=? AND workspace_id=?',assigneeId,workspace).first())throw new HttpError(404,'Исполнитель не найден в команде');}
 function conflict(){return json({code:'version_conflict',message:'Задача уже изменена другим участником. Обновите список и откройте её заново; введённый текст сохранён в форме.'},409);}
}
