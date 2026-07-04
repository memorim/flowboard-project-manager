import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Bell, CalendarDays, Check, ChevronDown, CirclePlus, Clock3,
  LayoutDashboard, ListFilter, MoreHorizontal, PanelLeftClose, Search, Settings,
  Sparkles, Users, X,
} from 'lucide-react';
import { api } from './api';
import type { Dashboard, Member, Priority, Project, Status, Task } from './types';

const statusLabels: Record<Status, string> = { todo: 'Нужно сделать', in_progress: 'В работе', review: 'На проверке', done: 'Готово' };
const priorityLabels: Record<Priority, string> = { low: 'Низкий', medium: 'Средний', high: 'Высокий' };
const columns: Status[] = ['todo', 'in_progress', 'review', 'done'];

const shortDate = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value));
const timeAgo = (value: string) => {
  const hours = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 3_600_000));
  return hours < 24 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
};

function TaskCard({ task, onMove, onDelete }: { task: Task; onMove: (id: number, status: Status) => void; onDelete: (id: number) => void }) {
  const [menu, setMenu] = useState(false);
  const next = columns[Math.min(columns.indexOf(task.status) + 1, columns.length - 1)];
  return (
    <article className="task-card">
      <div className="task-top">
        <span className={`priority priority-${task.priority}`}>{priorityLabels[task.priority]}</span>
        <button className="icon-button mini" onClick={() => setMenu(!menu)} aria-label="Действия"><MoreHorizontal size={18} /></button>
        {menu && <div className="card-menu">
          {next !== task.status && <button onClick={() => { onMove(task.id, next); setMenu(false); }}>Переместить дальше</button>}
          <button className="danger" onClick={() => onDelete(task.id)}>Удалить</button>
        </div>}
      </div>
      <h4>{task.title}</h4>
      <p>{task.description}</p>
      <div className="project-chip"><i style={{ background: task.project_color }} />{task.project_name}</div>
      <footer>
        <span className="due"><CalendarDays size={14} />{shortDate(task.due_date)}</span>
        {task.initials && <span className="avatar small" title={task.assignee_name || ''} style={{ background: task.assignee_color || '#ddd' }}>{task.initials}</span>}
      </footer>
    </article>
  );
}

function NewTaskModal({ projects, members, onClose, onCreated }: { projects: Project[]; members: Member[]; onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      await api.createTask({
        title: data.get('title'), description: data.get('description'), status: 'todo', priority: data.get('priority'),
        projectId: Number(data.get('projectId')), assigneeId: Number(data.get('assigneeId')), dueDate: data.get('dueDate'),
      });
      onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать задачу'); setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(e) => e.currentTarget === e.target && onClose()}>
    <div className="modal">
      <div className="modal-head"><div><span className="eyebrow">Новая задача</span><h2>Что нужно сделать?</h2></div><button className="icon-button" onClick={onClose}><X /></button></div>
      <form onSubmit={submit}>
        <label>Название<input name="title" required minLength={3} autoFocus placeholder="Например, обновить страницу оплаты" /></label>
        <label>Описание<textarea name="description" rows={3} placeholder="Короткий контекст для команды" /></label>
        <div className="form-grid">
          <label>Проект<select name="projectId">{projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
          <label>Исполнитель<select name="assigneeId">{members.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
          <label>Приоритет<select name="priority"><option value="medium">Средний</option><option value="high">Высокий</option><option value="low">Низкий</option></select></label>
          <label>Срок<input name="dueDate" type="date" required defaultValue="2026-07-20" /></label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Отмена</button><button className="button primary" disabled={saving}>{saving ? 'Сохраняю…' : 'Создать задачу'}</button></div>
      </form>
    </div>
  </div>;
}

export default function App() {
  const [view, setView] = useState<'overview' | 'board'>('overview');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(false);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [dash, taskList, meta] = await Promise.all([api.dashboard(), api.tasks(), api.meta()]);
      setDashboard(dash); setTasks(taskList); setProjects(meta.projects); setMembers(meta.members);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const visibleTasks = useMemo(() => {
    const value = query.toLowerCase().trim();
    return value ? tasks.filter(t => `${t.title} ${t.description} ${t.project_name}`.toLowerCase().includes(value)) : tasks;
  }, [tasks, query]);
  const setStatus = async (id: number, status: Status) => { await api.setStatus(id, status); setTasks(v => v.map(t => t.id === id ? { ...t, status } : t)); };
  const removeTask = async (id: number) => { await api.deleteTask(id); setTasks(v => v.filter(t => t.id !== id)); };

  return <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'}`}>
    <aside className="sidebar">
      <a className="brand"><span>F</span>flowboard</a>
      <nav className="main-nav">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><LayoutDashboard />Обзор</button>
        <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Sparkles />Мои задачи<span className="nav-count">4</span></button>
        <button><Users />Команда</button>
        <button><CalendarDays />Календарь</button>
      </nav>
      <div className="sidebar-section"><p>Проекты <CirclePlus size={15} /></p>{projects.map(project => <button key={project.id} onClick={() => { setView('board'); setQuery(project.name); }}><i style={{ background: project.color }} />{project.name}</button>)}</div>
      <div className="sidebar-bottom"><button><Settings />Настройки</button><div className="profile"><span className="avatar">РС</span><div><strong>Роман С.</strong><small>Workspace owner</small></div><ChevronDown size={16} /></div></div>
    </aside>

    <main>
      <header className="topbar">
        <button className="icon-button sidebar-toggle" onClick={() => setSidebar(v => !v)}><PanelLeftClose /></button>
        <div className="search"><Search /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти задачу или проект…" /><kbd>⌘ K</kbd></div>
        <button className="icon-button notify"><Bell /><i /></button>
        <button className="button primary" onClick={() => setModal(true)}><CirclePlus />Новая задача</button>
      </header>

      {loading ? <div className="loader"><span /><p>Собираем рабочее пространство</p></div> : view === 'overview' && dashboard ? <div className="page overview">
        <section className="page-title"><div><span className="eyebrow">Суббота, 4 июля</span><h1>Доброе утро, Роман.</h1><p>Вот что происходит в проектах сегодня.</p></div><div className="team-stack">{members.map(m => <span className="avatar" key={m.id} style={{ background: m.color }}>{m.initials}</span>)}<button>+2</button></div></section>
        <section className="metrics">
          <article><div className="metric-icon coral"><ListFilter /></div><div><span>Все задачи</span><strong>{dashboard.stats.total}</strong><small>в 3 активных проектах</small></div></article>
          <article><div className="metric-icon purple"><Clock3 /></div><div><span>В работе</span><strong>{dashboard.stats.inProgress}</strong><small>на этой неделе</small></div></article>
          <article><div className="metric-icon green"><Check /></div><div><span>Завершено</span><strong>{dashboard.stats.done}</strong><small className="positive">↑ 18% за месяц</small></div></article>
          <article><div className="metric-icon yellow"><Users /></div><div><span>На проверке</span><strong>{dashboard.stats.review}</strong><small>ожидают ответа</small></div></article>
        </section>
        <section className="overview-grid">
          <div className="panel projects-panel"><div className="panel-head"><div><span className="eyebrow">В фокусе</span><h2>Активные проекты</h2></div><button onClick={() => setView('board')}>Все задачи <ArrowRight /></button></div>
            <div className="project-list">{dashboard.projects.map(project => <article key={project.id}><div className="project-logo" style={{ background: project.color }}>{project.name.slice(0, 1)}</div><div className="project-info"><strong>{project.name}</strong><span>{project.client}</span><div className="progress"><i style={{ width: `${project.progress}%`, background: project.color }} /></div></div><div className="project-stat"><strong>{project.progress}%</strong><span>{project.done_count || 0}/{project.task_count} задач</span></div><span className="project-date"><CalendarDays />{shortDate(project.due_date)}</span></article>)}</div>
          </div>
          <div className="panel activity-panel"><div className="panel-head"><div><span className="eyebrow">В реальном времени</span><h2>Активность</h2></div><button className="icon-button"><MoreHorizontal /></button></div><div className="activity-list">{dashboard.activity.map(item => <article key={item.id}><span className="avatar small" style={{ background: item.color }}>{item.initials}</span><p><strong>{item.name}</strong> {item.text}<time>{timeAgo(item.created_at)}</time></p></article>)}</div></div>
        </section>
      </div> : <div className="page board-page">
        <section className="page-title board-title"><div><span className="eyebrow">Рабочий процесс</span><h1>Доска задач</h1><p>{visibleTasks.length} задач · синхронизация включена</p></div><button className="button ghost"><ListFilter />Фильтры</button></section>
        <div className="board">{columns.map(status => <section className="board-column" key={status}><header><span className={`status-dot ${status}`} /><strong>{statusLabels[status]}</strong><b>{visibleTasks.filter(t => t.status === status).length}</b><MoreHorizontal /></header><div className="column-content">{visibleTasks.filter(t => t.status === status).map(task => <TaskCard key={task.id} task={task} onMove={setStatus} onDelete={removeTask} />)}<button className="add-inline" onClick={() => setModal(true)}><CirclePlus />Добавить задачу</button></div></section>)}</div>
      </div>}
    </main>
    {modal && <NewTaskModal projects={projects} members={members} onClose={() => setModal(false)} onCreated={() => { setModal(false); void load(); setView('board'); }} />}
  </div>;
}
