import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { taskSchema } from '../../portfolio/task-schema';
import seed from './seed.json';
export const dynamic = 'force-dynamic';
const json = (data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const join = `SELECT t.*,p.name project_name,p.color project_color,m.name assignee_name,m.initials,m.color assignee_color FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN members m ON m.id=t.assignee_id`;
async function body(req:Request) {
  const reader=req.body?.getReader();if(!reader)return {};
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new RangeError('too large');}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(data));
}
async function handle(req:Request) {
  const db=env.DB;if(!db)return json({message:'База временно недоступна'},503);
  const url=new URL(req.url);const path=url.pathname;
  if(!['GET','HEAD'].includes(req.method)&&req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({message:'Недопустимый источник запроса'},403);
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
  const identity=await getChatGPTUser();
  let actor:{id:number;name:string;role:string;initials:string;color:string}|null=null;
  if(identity){
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity.userId));const key=Array.from(new Uint8Array(bytes)).map(v=>v.toString(16).padStart(2,'0')).join('');
    await db.prepare('INSERT OR IGNORE INTO members(name,role,initials,color,site_key) VALUES (?,?,?,?,?)').bind('Участник '+key.slice(0,4).toUpperCase(),'Участник демо',key.slice(0,2).toUpperCase(),'#d7c9ff',key).run();
    actor=await db.prepare('SELECT id,name,role,initials,color FROM members WHERE site_key=?').bind(key).first();
  }
  if(path==='/api/session')return json({mode:'chatgpt',user:actor});
  if(path==='/api/health')return json({status:'ok',storage:'D1'});
  if(req.method==='GET'){
    if(path==='/api/meta'){const [projects,members]=await db.batch([db.prepare('SELECT * FROM projects ORDER BY name'),db.prepare('SELECT id,name,role,initials,color FROM members ORDER BY name')]);return json({projects:projects.results,members:members.results});}
    if(path==='/api/tasks'){
      const search=url.searchParams.get('search')||'',status=url.searchParams.get('status')||'',project=Number(url.searchParams.get('project')||0);
      if(!Number.isSafeInteger(project)||project<0)return json({message:'Некорректный проект'},400);
      const result=await db.prepare(join+` WHERE (?='' OR t.title LIKE ? OR t.description LIKE ?) AND (?='' OR t.status=?) AND (?=0 OR t.project_id=?) ORDER BY t.due_date,t.id`).bind(search,'%'+search+'%','%'+search+'%',status,status,project,project).all();return json(result.results);
    }
    if(path==='/api/dashboard'){
      const [stats,projects,activity]=await db.batch([
        db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(status='done'),0) done,COALESCE(SUM(status='in_progress'),0) inProgress,COALESCE(SUM(status='review'),0) review FROM tasks`),
        db.prepare(`SELECT p.*,COUNT(t.id) task_count,COALESCE(SUM(t.status='done'),0) done_count,CASE WHEN COUNT(t.id)=0 THEN 0 ELSE ROUND(100.0*SUM(t.status='done')/COUNT(t.id)) END progress FROM projects p LEFT JOIN tasks t ON t.project_id=p.id GROUP BY p.id ORDER BY p.due_date`),
        db.prepare('SELECT a.*,m.name,m.initials,m.color FROM activity a JOIN members m ON m.id=a.member_id ORDER BY a.id DESC LIMIT 10')
      ]);return json({stats:stats.results[0],projects:projects.results,activity:activity.results});
    }
  }
  if(!actor)return json({message:'Войдите через ChatGPT для изменения задач'},401);
  // ponytail: a public shared sandbox allows every signed-in participant to edit demo tasks; private workspaces need a membership table.
  const recent=await db.prepare('SELECT COUNT(*) n FROM activity WHERE member_id=? AND created_at>?').bind(actor.id,new Date(Date.now()-60000).toISOString()).first<{n:number}>();
  if((recent?.n||0)>=30)return json({message:'Лимит: 30 изменений в минуту. Попробуйте позднее.'},429);
  const event=(text:string)=>db.prepare('INSERT INTO activity(text,member_id,created_at) VALUES (?,?,?)').bind(text,actor!.id,new Date().toISOString());
  const match=path.match(/^\/api\/tasks\/(\d+)(\/status)?$/);const id=Number(match?.[1]);
  if(req.method==='POST'&&path==='/api/tasks'||req.method==='PATCH'&&match&&!match[2]){
    const parsed=taskSchema.safeParse(await body(req));if(!parsed.success)return json({message:'Проверьте данные задачи'},400);
    const t=parsed.data;
    if(!await db.prepare('SELECT id FROM projects WHERE id=?').bind(t.projectId).first()||(t.assigneeId!==null&&!await db.prepare('SELECT id FROM members WHERE id=?').bind(t.assigneeId).first()))return json({message:'Проект или исполнитель не найден'},404);
    if(req.method==='PATCH'&&!await db.prepare('SELECT id FROM tasks WHERE id=?').bind(id).first())return json({message:'Задача не найдена'},404);
    if(req.method==='POST'){
      const [result]=await db.batch([db.prepare('INSERT INTO tasks(title,description,status,priority,project_id,assignee_id,due_date) VALUES (?,?,?,?,?,?,?)').bind(t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate),event(`создал(а) задачу «${t.title}»`)]);
      return json({id:result.meta.last_row_id,...t},201);
    }
    await db.batch([db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,project_id=?,assignee_id=?,due_date=? WHERE id=?').bind(t.title,t.description,t.status,t.priority,t.projectId,t.assigneeId,t.dueDate,id),event(`отредактировал(а) задачу «${t.title}»`)]);return json({id,...t});
  }
  if(match&&(req.method==='PATCH'||req.method==='DELETE')){
    const old=await db.prepare('SELECT title,status FROM tasks WHERE id=?').bind(id).first<{title:string;status:string}>();if(!old)return json({message:'Задача не найдена'},404);
    if(req.method==='DELETE'){await db.batch([db.prepare('DELETE FROM tasks WHERE id=?').bind(id),event(`удалил(а) задачу «${old.title}»`)]);return new Response(null,{status:204});}
    const parsed=taskSchema.shape.status.removeDefault().safeParse((await body(req) as {status?:string}).status);if(!parsed.success||!parsed.data)return json({message:'Недопустимый статус'},400);
    if(old.status!==parsed.data)await db.batch([db.prepare('UPDATE tasks SET status=? WHERE id=?').bind(parsed.data,id),event(`изменил(а) статус «${old.title}» на ${parsed.data}`)]);return json({id,status:parsed.data});
  }
  return json({message:'Маршрут не найден'},404);
}
async function route(req:Request){try{return await handle(req);}catch(e){if(e instanceof SyntaxError)return json({message:'Некорректный JSON'},400);if(e instanceof RangeError)return json({message:'Слишком большой запрос'},413);console.error('Flowboard request failed',e instanceof Error?e.name:'UnknownError');return json({message:'Сервис временно недоступен. Повторите запрос.'},503);}}
export {route as GET,route as POST,route as PATCH,route as DELETE};
