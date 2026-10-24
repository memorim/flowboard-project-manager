import {demoApi} from './demo-api';
import type {Dashboard,Member,Project,Status,Task,Workspace,Session,Page,TaskFilters,HistoryEntry} from './types';
export const workspaceId=()=>Number(localStorage.getItem('flowboard-workspace')||1);
export const selectWorkspace=(id:number)=>localStorage.setItem('flowboard-workspace',String(id));
async function request<T>(url:string,options?:RequestInit):Promise<T>{
 const response=await fetch(url+(url.includes('?')?'&':'?')+'workspace='+workspaceId(),{...options,headers:{'Content-Type':'application/json','X-Demo-Actor':localStorage.getItem('flowboard-actor')||'4',...options?.headers}});
 if(!response.ok){const e=await response.json().catch(()=>null) as {message?:string}|null;throw new Error((e?.message||'Ошибка запроса')+(response.status>=500&&response.headers.get('X-Request-Id')?' Код обращения: '+response.headers.get('X-Request-Id'):''));}return response.status===204?undefined as T:response.json();
}
export const serverApi={
 session:()=>request<Session>('/api/session'),workspaces:()=>request<Workspace[]>('/api/workspaces'),
 createWorkspace:(name:string)=>request<Workspace>('/api/workspaces',{method:'POST',body:JSON.stringify({name})}),
 createProject:(name:string)=>request('/api/projects',{method:'POST',body:JSON.stringify({name})}),
 invite:(role:string)=>request<{token:string;expiresAt:string}>('/api/invitations',{method:'POST',body:JSON.stringify({role})}),
 acceptInvite:(token:string)=>request<{workspaceId:number}>('/api/invitations/accept',{method:'POST',body:JSON.stringify({token})}),
 changeRole:(id:number,role:string)=>request(`/api/members/${id}`,{method:'PATCH',body:JSON.stringify({role})}),
 removeMember:(id:number)=>request(`/api/members/${id}`,{method:'DELETE'}),
 exportWorkspace:()=>request<object>('/api/export'),
 dashboard:()=>request<Dashboard>('/api/dashboard'),meta:()=>request<{projects:Project[];members:Member[]}>('/api/meta'),
 history:(id:number)=>request<HistoryEntry[]>(`/api/tasks/${id}/history`),
 restoreTask:(id:number,version:number)=>request(`/api/tasks/${id}/restore`,{method:'PATCH',body:JSON.stringify({version})}),
 trashPage:(filters:TaskFilters={})=>request<Page<Task>>('/api/tasks/trash?'+new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)]))),
 taskPage:(filters:TaskFilters={})=>request<Page<Task>>('/api/tasks/page?'+new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==undefined&&v!=='').map(([k,v])=>[k,String(v)]))),
 tasks:(search='')=>request<Task[]>('/api/tasks'+(search?'?search='+encodeURIComponent(search):'')),
 createTask:(body:object,key?:string)=>request<Task>('/api/tasks',{method:'POST',body:JSON.stringify(body),headers:key?{'Idempotency-Key':key}:undefined}),
 updateTask:(id:number,body:object)=>request(`/api/tasks/${id}`,{method:'PATCH',body:JSON.stringify(body)}),
 setStatus:(id:number,status:Status,version:number)=>request(`/api/tasks/${id}/status`,{method:'PATCH',body:JSON.stringify({status,version})}),
 deleteTask:(id:number,version:number)=>request(`/api/tasks/${id}`,{method:'DELETE',body:JSON.stringify({version})}),
};
export const api=import.meta.env.VITE_DEMO_MODE==='true'?demoApi:serverApi;
