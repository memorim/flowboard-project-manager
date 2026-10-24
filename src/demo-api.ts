import initial from './demo-data.json';
import { taskSchema } from './task-schema';
import type { Activity, Dashboard, Member, Project, Status, Task } from './types';
const key = 'flowboard-browser-demo-v2';
type Data = { tasks: Task[]; activity: Activity[] };
const current = () => initial.members.find(m => m.id === Number(localStorage.getItem('flowboard-actor') || 4)) || initial.members[0];
const dateFromSample = (date: string) => new Date(Date.now() + (new Date(date).getTime() - new Date('2026-07-04').getTime())).toISOString().slice(0,10);
const projects = () => initial.projects.map(p => ({...p,due_date:dateFromSample(p.due_date)}));
const load = (): Data => {
  try {
    const stored = localStorage.getItem(key);
    if (stored) { const data = JSON.parse(stored); if (!Array.isArray(data.tasks) || !Array.isArray(data.activity)) throw new Error(); return data; }
    const legacy = localStorage.getItem('flowboard-browser-demo-v1');
    return { tasks: legacy ? JSON.parse(legacy) : initial.tasks.map(t => ({...t,due_date:dateFromSample(t.due_date)})), activity: [] };
  } catch { throw new Error('Данные браузера повреждены. Они сохранены без изменений; перед сбросом экспортируйте localStorage.'); }
};
const save = (data: Data) => localStorage.setItem(key, JSON.stringify(data));
const event = (data: Data, text: string) => {
  const user = current(); data.activity.unshift({id:Math.max(0,...data.activity.map(a=>a.id))+1,text,name:user.name,initials:user.initials,color:user.color,created_at:new Date().toISOString()});
};
function makeTask(body: object, id: number): Task {
  const parsed = taskSchema.safeParse(body);
  if (!parsed.success) throw new Error('Проверьте данные задачи');
  const t = parsed.data, p = initial.projects.find(p=>p.id===t.projectId), m = initial.members.find(m=>m.id===t.assigneeId);
  if (!p || (t.assigneeId!==null && !m)) throw new Error('Проект или исполнитель не найден');
  return {id,title:t.title,description:t.description,status:t.status,priority:t.priority,due_date:t.dueDate,project_id:p.id,project_name:p.name,project_color:p.color,assignee_id:m?.id??null,assignee_name:m?.name??null,initials:m?.initials??null,assignee_color:m?.color??null};
}
// ponytail: localStorage is private to one browser; the hosted D1 API provides shared persistence.
export const demoApi = {
  session: async () => ({mode:'browser',user:current() as Member|null}),
  dashboard: async (): Promise<Dashboard> => {
    const {tasks,activity} = load();
    return {stats:{total:tasks.length,done:tasks.filter(t=>t.status==='done').length,inProgress:tasks.filter(t=>t.status==='in_progress').length,review:tasks.filter(t=>t.status==='review').length},
      projects:projects().map(p=>{const subset=tasks.filter(t=>t.project_id===p.id),done=subset.filter(t=>t.status==='done').length;return {...p,task_count:subset.length,done_count:done,progress:subset.length?Math.round(done/subset.length*100):0};}),activity:activity.slice(0,10)};
  },
  meta: async (): Promise<{projects:Project[];members:Member[]}> => structuredClone({projects:projects(),members:initial.members}),
  tasks: async (search=''): Promise<Task[]> => load().tasks.filter(t=>`${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())),
  createTask: async (body:object): Promise<Task> => {const data=load();const t=makeTask(body,Math.max(0,...data.tasks.map(t=>t.id))+1);data.tasks.push(t);event(data,`создал(а) задачу «${t.title}»`);save(data);return t;},
  updateTask: async (id:number,body:object) => {const data=load(),index=data.tasks.findIndex(t=>t.id===id);if(index<0)throw new Error('Задача не найдена');const t=makeTask(body,id);data.tasks[index]=t;event(data,`отредактировал(а) задачу «${t.title}»`);save(data);return t;},
  setStatus: async (id:number,status:Status) => {if(!['todo','in_progress','review','done'].includes(status))throw new Error('Недопустимый статус');const data=load(),t=data.tasks.find(t=>t.id===id);if(!t)throw new Error('Задача не найдена');if(t.status!==status){t.status=status;event(data,`изменил(а) статус «${t.title}» на ${status}`);save(data);}return{id,status};},
  deleteTask: async (id:number) => {const data=load(),t=data.tasks.find(t=>t.id===id);if(!t)throw new Error('Задача не найдена');data.tasks=data.tasks.filter(t=>t.id!==id);event(data,`удалил(а) задачу «${t.title}»`);save(data);},
};
