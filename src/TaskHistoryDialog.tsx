import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import type {Task,HistoryEntry} from './types';
const labels:Record<string,string>={title:'Название',description:'Описание',status:'Статус',priority:'Приоритет',projectId:'Проект',assigneeId:'Исполнитель',dueDate:'Срок',deletedAt:'Удаление'};
const actions:Record<string,string>={created:'Создание',updated:'Изменение',deleted:'Удаление в корзину',restored:'Восстановление'};
const value=(v:unknown)=>v===null||v===undefined||v===''?'—':String(v);
export function TaskHistoryDialog({task,onClose}:{task:Task;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[entries,setEntries]=useState<HistoryEntry[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;dialog.current?.showModal();api.history(task.id).then(rows=>{if(active)setEntries(rows);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Не удалось загрузить историю');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[task.id]);
 const close=()=>{dialog.current?.close();onClose();};
 return <dialog ref={dialog} className="modal task-dialog" aria-labelledby="history-title" onCancel={e=>{e.preventDefault();close();}}><div className="modal-head"><h2 id="history-title">История: {task.title}</h2><button className="icon-button" aria-label="Закрыть историю" onClick={close}>×</button></div>
 {loading&&<p role="status">Загружаем историю…</p>}{error&&<p role="alert">{error}</p>}{!loading&&!error&&!entries.length&&<p>Сохранённых изменений пока нет. История записывается с момента добавления этой возможности.</p>}
 {entries.map(entry=><article className="history-entry" key={entry.id}><h3>{actions[entry.action]||entry.action} · версия {entry.version}</h3><p>{entry.actor_name||'Учебные данные'} · <time>{new Date(entry.created_at).toLocaleString('ru-RU')}</time></p><dl>{Object.entries(entry.after).filter(([key,after])=>!entry.before||entry.before[key]!==after).map(([key,after])=><div key={key}><dt>{labels[key]||key}</dt><dd>{entry.before?value(entry.before[key])+' → ':''}{value(after)}</dd></div>)}</dl></article>)}
 </dialog>;
}
