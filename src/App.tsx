import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  CirclePlus,
  Clock3,
  LayoutDashboard,
  ListFilter,
  MoreHorizontal,
  PanelLeftClose,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { api, serverApi, workspaceId, selectWorkspace } from './api';
import { AuthDialog } from './AuthDialog';
import { GuidedDemo } from './GuidedDemo';
import { TaskHistoryDialog } from './TaskHistoryDialog';
import { WorkspaceDialog } from './WorkspaceDialog';
import type {
  Dashboard,
  Member,
  Priority,
  Project,
  Status,
  Task,
  Workspace,
  Session,
} from './types';
const statusLabels: Record<Status, string> = {
  todo: 'Нужно сделать',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};
const priorityLabels: Record<Priority, string> = {
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
};
const columns = Object.keys(statusLabels) as Status[];
const shortDate = (v: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(
    new Date(v + 'T12:00:00'),
  );
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : 'Не удалось выполнить запрос';
function TaskCard({
  task,
  onMove,
  onDelete,
  onEdit,
  onHistory,
  writable,
  busy,
}: {
  task: Task;
  onMove: (id: number, status: Status) => void;
  onDelete: (id: number) => void;
  onEdit: () => void;
  onHistory: () => void;
  writable: boolean;
  busy: boolean;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <article
      className="task-card"
      draggable={writable && !busy}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(task.id))}
    >
      <div className="task-top">
        <span className={`priority priority-${task.priority}`}>
          {priorityLabels[task.priority]}
        </span>
        <button
          className="icon-button mini"
          onClick={() => setMenu((v) => !v)}
          aria-label={`Действия: ${task.title}`}
          aria-expanded={menu}
        >
          <MoreHorizontal size={18} />
        </button>
        {menu && (
          <div className="card-menu">
            <button
              onClick={() => {
                setMenu(false);
                onHistory();
              }}
            >
              История изменений
            </button>
            <button
              disabled={!writable || busy}
              onClick={() => {
                setMenu(false);
                onEdit();
              }}
            >
              Редактировать
            </button>
            <button
              disabled={!writable || busy}
              className="danger"
              onClick={() => {
                if (window.confirm(`Удалить демонстрационную задачу «${task.title}»?`))
                  onDelete(task.id);
              }}
            >
              Удалить
            </button>
          </div>
        )}
      </div>
      <h4>{task.title}</h4>
      <p>{task.description}</p>
      <div className="project-chip">
        <i style={{ background: task.project_color }} />
        {task.project_name}
      </div>
      <label className="task-status">
        Статус
        <select
          aria-label={`Статус: ${task.title}`}
          value={task.status}
          disabled={!writable || busy}
          onChange={(e) => onMove(task.id, e.target.value as Status)}
        >
          {columns.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
      </label>
      <footer>
        <span className="due">
          <CalendarDays size={14} />
          {shortDate(task.due_date)}
        </span>
        {task.initials && (
          <span
            className="avatar small"
            title={task.assignee_name || ''}
            style={{ background: task.assignee_color || '#ddd' }}
          >
            {task.initials}
          </span>
        )}
      </footer>
    </article>
  );
}
function TaskModal({
  task,
  projects,
  members,
  onClose,
  onSave,
}: {
  task?: Task;
  projects: Project[];
  members: Member[];
  onClose: () => void;
  onSave: (body: object, key: string) => Promise<void>;
}) {
  const submission = useRef<{ payload: string; key: string } | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const close = () => {
    ref.current?.close();
    onClose();
  };
  return (
    <dialog
      ref={ref}
      className="modal task-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="task-modal-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">{task ? 'Редактирование' : 'Новая задача'}</span>
          <h2 id="task-modal-title">{task ? 'Изменить задачу' : 'Что нужно сделать?'}</h2>
        </div>
        <button className="icon-button" onClick={close} aria-label="Закрыть редактор">
          <X />
        </button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError('');
          const d = new FormData(e.currentTarget);
          try {
            const fields = {
              title: d.get('title'),
              description: d.get('description'),
              status: d.get('status'),
              priority: d.get('priority'),
              projectId: Number(d.get('projectId')),
              assigneeId: d.get('assigneeId') ? Number(d.get('assigneeId')) : null,
              dueDate: d.get('dueDate'),
              ...(task ? { version: task.version } : {}),
            };
            const payload = JSON.stringify(fields);
            if (submission.current?.payload !== payload)
              submission.current = { payload, key: crypto.randomUUID() };
            await onSave(fields, submission.current.key);
            close();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Название
          <input
            name="title"
            required
            minLength={3}
            maxLength={120}
            autoFocus
            defaultValue={task?.title}
          />
        </label>
        <label>
          Описание
          <textarea
            aria-label="Описание"
            name="description"
            rows={3}
            maxLength={500}
            defaultValue={task?.description}
          />
        </label>
        <div className="form-grid">
          <label>
            Проект
            <select name="projectId" defaultValue={task?.project_id}>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Исполнитель
            <select name="assigneeId" defaultValue={task?.assignee_id ?? ''}>
              <option value="">Не назначен</option>
              {members.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Приоритет
            <select name="priority" defaultValue={task?.priority || 'medium'}>
              {Object.entries(priorityLabels).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Срок
            <input
              name="dueDate"
              type="date"
              required
              defaultValue={
                task?.due_date || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
              }
            />
          </label>
          <label>
            Состояние
            <select name="status" defaultValue={task?.status || 'todo'}>
              {columns.map((s) => (
                <option value={s} key={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={close}>
            Отмена
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? 'Сохраняю…' : task ? 'Сохранить изменения' : 'Создать задачу'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export default function App() {
  const [view, setView] = useState<'overview' | 'board' | 'team' | 'calendar' | 'trash'>(
    'overview',
  );
  const [dashboard, setDashboard] = useState<Dashboard | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [members, setMembers] = useState<Member[]>([]);
  const [query, setQuery] = useState(''),
    [project, setProject] = useState(''),
    [assignee, setAssignee] = useState(''),
    [statusFilter, setStatusFilter] = useState('');
  const [editor, setEditor] = useState<Task | null | undefined>(undefined),
    [sidebar, setSidebar] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [session, setSession] = useState<Session>({
    mode: 'authenticated',
    user: null,
    workspace: { id: 1, name: 'Общее демо', is_public: 1, access_role: 'viewer' },
    canWrite: false,
  });
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [manage, setManage] = useState(false),
    [inviteToken, setInviteToken] = useState(''),
    [returnTo, setReturnTo] = useState('/');
  const [guide, setGuide] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [historyTask, setHistoryTask] = useState<Task | null>(null);
  const [taskOffset, setTaskOffset] = useState(0),
    [taskTotal, setTaskTotal] = useState(0);
  const requestNumber = useRef(0),
    loadedScope = useRef('');
  const load = async () => {
    const number = ++requestNumber.current;
    setLoading(true);
    setError('');
    const scope = workspaceId() + ':' + (localStorage.getItem('flowboard-actor') || '4');
    if (loadedScope.current !== scope) {
      loadedScope.current = scope;
      setSession((s) => ({ ...s, canWrite: false }));
      setDashboard(null);
      setTasks([]);
      setMembers([]);
      setProjects([]);
    }
    try {
      const spaces = await api.workspaces();
      if (number !== requestNumber.current) return;
      if (!spaces.some((w) => w.id === workspaceId())) selectWorkspace(1);
      const [dash, list, meta, user] = await Promise.all([
        api.dashboard(),
        (view === 'trash' ? api.trashPage : api.taskPage)({
          search: query,
          project,
          assignee,
          status: statusFilter,
          limit: 40,
          offset: taskOffset,
        }),
        api.meta(),
        api.session(),
      ]);
      if (number !== requestNumber.current) return;
      setWorkspaces(spaces);
      setDashboard(dash);
      setTasks(list.items);
      setTaskTotal(list.total);
      setProjects(meta.projects);
      setMembers(meta.members);
      setSession(user);
    } catch (e) {
      if (number === requestNumber.current) {
        setError(errorMessage(e));
        setTasks([]);
        setDashboard(null);
        setMembers([]);
        setProjects([]);
      }
    } finally {
      if (number === requestNumber.current) setLoading(false);
    }
  };
  useEffect(() => {
    setSidebar(
      !window.matchMedia('(max-width:760px), (min-width:801px) and (max-width:950px)').matches,
    );
    setInviteToken(new URLSearchParams(window.location.hash.slice(1)).get('invite') || '');
    setReturnTo(window.location.pathname + window.location.search + window.location.hash);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [query, project, assignee, statusFilter, taskOffset, view]);
  const writable = !error && session.canWrite;
  const signIn = '/signin-with-chatgpt?return_to=' + encodeURIComponent(returnTo);
  const go = (v: typeof view) => {
    if (v !== view) setTaskOffset(0);
    setView(v);
    if (window.matchMedia('(max-width:760px), (min-width:801px) and (max-width:950px)').matches)
      setSidebar(false);
  };
  const visible = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (!project || t.project_id === Number(project)) &&
          (!assignee ||
            (assignee === 'none' ? t.assignee_id === null : t.assignee_id === Number(assignee))) &&
          (!statusFilter || t.status === statusFilter) &&
          `${t.title} ${t.description} ${t.project_name}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()),
      ),
    [tasks, project, assignee, statusFilter, query],
  );
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (id: number, status: Status) => {
    const t = tasks.find((t) => t.id === id);
    if (t) void mutate(() => api.setStatus(id, status, t.version));
  };
  const remove = (id: number) => {
    const t = tasks.find((t) => t.id === id);
    if (t) void mutate(() => api.deleteTask(id, t.version));
  };
  const reset = () => {
    setTaskOffset(0);
    setQuery('');
    setProject('');
    setAssignee('');
    setStatusFilter('');
  };
  const identityChanged = async () => {
    setEditor(undefined);
    setManage(false);
    setHistoryTask(null);
    setGuide(false);
    reset();
    selectWorkspace(1);
    loadedScope.current = '';
    await load();
  };
  return (
    <div className={`app-shell ${sidebar ? '' : 'sidebar-hidden'}`}>
      <aside className="sidebar" aria-hidden={!sidebar} inert={!sidebar}>
        <button
          className="brand"
          onClick={() => {
            reset();
            go('overview');
          }}
        >
          <span>F</span>flowboard
        </button>
        <nav className="main-nav">
          <button className={view === 'overview' ? 'active' : ''} onClick={() => go('overview')}>
            <LayoutDashboard />
            Обзор
          </button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => go('board')}>
            <Sparkles />
            Задачи<span className="nav-count">{tasks.length}</span>
          </button>
          <button className={view === 'team' ? 'active' : ''} onClick={() => go('team')}>
            <Users />
            Команда
          </button>
          <button className={view === 'calendar' ? 'active' : ''} onClick={() => go('calendar')}>
            <CalendarDays />
            Календарь
          </button>
          <button
            className={view === 'trash' ? 'active' : ''}
            onClick={() => {
              reset();
              go('trash');
            }}
          >
            Корзина
          </button>
        </nav>
        <div className="sidebar-section">
          <p>Проекты</p>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setProject(String(p.id));
                go('board');
              }}
            >
              <i style={{ background: p.color }} />
              {p.name}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          {session.mode === 'chatgpt' ? (
            <p>
              {session.user?.name || 'Гостевой просмотр'}
              <br />
              <a href={session.user ? '/signout-with-chatgpt?return_to=/' : signIn} target="_top">
                {session.user ? 'Выйти' : 'Войти в аккаунт'}
              </a>
            </p>
          ) : session.mode === 'authenticated' ? (
            <p>
              {session.user?.name || 'Гостевой просмотр'}
              <br />
              {session.user ? (
                <button
                  className="button ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await serverApi.logout();
                      await identityChanged();
                    })
                  }
                >
                  Выйти
                </button>
              ) : (
                <button className="button ghost" onClick={() => setLoginOpen(true)}>
                  Вход в аккаунт
                </button>
              )}
            </p>
          ) : (
            <label className="actor-select">
              Демо-участник
              <select
                aria-label="Демонстрационный участник"
                value={session.user?.id || 4}
                onChange={(e) => {
                  localStorage.setItem('flowboard-actor', e.target.value);
                  selectWorkspace(1);
                  void load();
                }}
              >
                {[
                  { id: 1, name: 'Анна Морозова' },
                  { id: 2, name: 'Илья Власов' },
                  { id: 3, name: 'Марк Левин' },
                  { id: 4, name: 'Саша Ким' },
                ].map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="workspace-note">
            {session.mode === 'browser' ? 'Данные только в этом браузере' : session.workspace.name}
          </p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            onClick={() => setSidebar((v) => !v)}
            aria-label="Переключить меню"
            aria-expanded={sidebar}
          >
            <PanelLeftClose />
          </button>
          <div className="search">
            <Search />
            <input
              aria-label="Поиск задач"
              value={query}
              onChange={(e) => {
                setTaskOffset(0);
                setQuery(e.target.value);
                if (e.target.value) go('board');
              }}
              placeholder="Найти задачу или проект…"
            />
          </div>
          {session.mode === 'chatgpt' && !session.user ? (
            <a className="button primary" href={signIn} target="_top">
              Войти для изменений
            </a>
          ) : session.mode === 'authenticated' && !session.user ? (
            <button
              className="button primary"
              disabled={loading}
              onClick={() => setLoginOpen(true)}
            >
              Войти
            </button>
          ) : (
            <button
              className="button primary"
              disabled={loading || !writable}
              onClick={() => setEditor(null)}
            >
              <CirclePlus />
              Новая задача
            </button>
          )}
        </header>
        <div className="workspace-bar">
          <button
            className="button ghost"
            onClick={() =>
              session.mode === 'authenticated' && !session.user
                ? setLoginOpen(true)
                : setGuide(true)
            }
          >
            Пройти демонстрацию
          </button>
          <label>
            Рабочее пространство
            <select
              aria-label="Рабочее пространство"
              value={session.workspace.id}
              disabled={loading || busy}
              onChange={(e) => {
                selectWorkspace(Number(e.target.value));
                reset();
                void load();
              }}
            >
              {workspaces.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <span className="access-badge">
            {
              (
                { owner: 'Владелец', editor: 'Редактор', viewer: 'Просмотр' } as Record<
                  string,
                  string
                >
              )[session.workspace.access_role]
            }
          </span>
          <button className="button ghost" disabled={loading || busy} onClick={() => void load()}>
            Обновить данные
          </button>
          {session.mode !== 'browser' && session.user && (
            <button
              className="button ghost"
              disabled={loading || busy}
              onClick={() => setManage(true)}
            >
              Пространство и участники
            </button>
          )}
          {session.mode === 'browser' && (
            <a
              href="https://memorim-flowboard-live.amusedcorgi34.chatgpt.site"
              target="_blank"
              rel="noreferrer"
            >
              Командная серверная версия ↗
            </a>
          )}
        </div>
        {inviteToken && (
          <div className="invite-banner">
            <strong>Приглашение в команду</strong>
            {session.user && session.mode !== 'browser' ? (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    const result = await api.acceptInvite(inviteToken);
                    selectWorkspace(result.workspaceId);
                    setInviteToken('');
                    window.history.replaceState(
                      null,
                      '',
                      window.location.pathname + window.location.search,
                    );
                  })
                }
              >
                Принять приглашение
              </button>
            ) : session.mode === 'authenticated' ? (
              <button className="button primary" onClick={() => setLoginOpen(true)}>
                Войти для принятия приглашения
              </button>
            ) : (
              <a href={signIn} target="_top">
                Войти для принятия приглашения
              </a>
            )}
          </div>
        )}
        {error && (
          <div className="page-error" role="alert">
            {error} <button onClick={() => void load()}>Повторить загрузку</button>
          </div>
        )}
        {loading && !dashboard ? (
          <div className="loader" role="status">
            <span />
            <p>Собираем рабочее пространство</p>
          </div>
        ) : view === 'overview' && dashboard ? (
          <div className="page overview">
            <section className="page-title">
              <div>
                <span className="eyebrow">
                  {new Date().toLocaleDateString('ru-RU', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </span>
                <h1>Рабочее пространство команды</h1>
                <p>Задачи, сроки и последние изменения.</p>
              </div>
              <div className="team-stack">
                {members.slice(0, 5).map((m) => (
                  <span
                    className="avatar"
                    key={m.id}
                    title={m.name}
                    style={{ background: m.color }}
                  >
                    {m.initials}
                  </span>
                ))}
              </div>
            </section>
            <section className="metrics">
              {[
                {
                  label: 'Все задачи',
                  value: dashboard.stats.total,
                  icon: <ListFilter />,
                  color: 'coral',
                },
                {
                  label: 'В работе',
                  value: dashboard.stats.inProgress,
                  icon: <Clock3 />,
                  color: 'purple',
                },
                {
                  label: 'Завершено',
                  value: dashboard.stats.done,
                  icon: <Check />,
                  color: 'green',
                },
                {
                  label: 'На проверке',
                  value: dashboard.stats.review,
                  icon: <Users />,
                  color: 'yellow',
                },
              ].map((m) => (
                <article key={m.label}>
                  <div className={`metric-icon ${m.color}`}>{m.icon}</div>
                  <div>
                    <span>{m.label}</span>
                    <strong>{m.value}</strong>
                    <small>по текущему списку задач</small>
                  </div>
                </article>
              ))}
            </section>
            <section className="overview-grid">
              <div className="panel projects-panel">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">В фокусе</span>
                    <h2>Активные проекты</h2>
                  </div>
                  <button
                    onClick={() => {
                      reset();
                      go('board');
                    }}
                  >
                    Все задачи <ArrowRight />
                  </button>
                </div>
                <div className="project-list">
                  {dashboard.projects.map((p) => (
                    <article key={p.id}>
                      <div className="project-logo" style={{ background: p.color }}>
                        {p.name.slice(0, 1)}
                      </div>
                      <div className="project-info">
                        <button
                          className="project-open"
                          onClick={() => {
                            setProject(String(p.id));
                            go('board');
                          }}
                        >
                          {p.name}
                        </button>
                        <span>{p.client}</span>
                        <div className="progress">
                          <i style={{ width: `${p.progress}%`, background: p.color }} />
                        </div>
                      </div>
                      <div className="project-stat">
                        <strong>{p.progress}%</strong>
                        <span>
                          {p.done_count || 0}/{p.task_count} задач
                        </span>
                      </div>
                      <span className="project-date">
                        <CalendarDays />
                        {shortDate(p.due_date)}
                      </span>
                    </article>
                  ))}
                </div>
              </div>
              <div className="panel activity-panel">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Журнал изменений</span>
                    <h2>Активность</h2>
                  </div>
                </div>
                <div className="activity-list">
                  {!dashboard.activity.length && (
                    <p>Новых действий пока нет. Создайте или измените задачу.</p>
                  )}
                  {dashboard.activity.map((a) => (
                    <article key={a.id}>
                      <span className="avatar small" style={{ background: a.color }}>
                        {a.initials}
                      </span>
                      <p>
                        <strong>{a.name}</strong> {a.text}
                        <time>{new Date(a.created_at).toLocaleString('ru-RU')}</time>
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        ) : view === 'team' ? (
          <div className="page">
            <section className="page-title">
              <div>
                <span className="eyebrow">Участники</span>
                <h1>Команда</h1>
                <p>Демонстрационные профили и распределение задач.</p>
              </div>
            </section>
            <div className="team-grid">
              {members.map((m) => (
                <article className="panel" key={m.id}>
                  <span className="avatar" style={{ background: m.color }}>
                    {m.initials}
                  </span>
                  <h2>{m.name}</h2>
                  <p>{m.role}</p>
                  <p>{m.task_count ?? tasks.filter((t) => t.assignee_id === m.id).length} задач</p>
                  <button
                    className="button ghost"
                    onClick={() => {
                      setAssignee(String(m.id));
                      go('board');
                    }}
                  >
                    Посмотреть задачи
                  </button>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="page board-page">
            <section className="page-title board-title">
              <div>
                <span className="eyebrow">Рабочий процесс</span>
                <h1>
                  {view === 'trash'
                    ? 'Корзина'
                    : view === 'calendar'
                      ? 'Календарь сроков'
                      : 'Доска задач'}
                </h1>
                <p>
                  {taskTotal} задач ·{' '}
                  {session.mode === 'chatgpt'
                    ? 'данные общей базы; обновление после действий'
                    : 'демонстрационный режим'}
                </p>
              </div>
            </section>
            <div className="task-filters">
              <label>
                Проект
                <select
                  value={project}
                  onChange={(e) => {
                    setTaskOffset(0);
                    setProject(e.target.value);
                  }}
                >
                  <option value="">Все проекты</option>
                  {projects.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Исполнитель
                <select
                  value={assignee}
                  onChange={(e) => {
                    setTaskOffset(0);
                    setAssignee(e.target.value);
                  }}
                >
                  <option value="">Все участники</option>
                  <option value="none">Не назначен</option>
                  {members.map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Статус
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setTaskOffset(0);
                    setStatusFilter(e.target.value);
                  }}
                >
                  <option value="">Все статусы</option>
                  {columns.map((s) => (
                    <option value={s} key={s}>
                      {statusLabels[s]}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button ghost" onClick={reset}>
                Сбросить фильтры
              </button>
            </div>
            <nav className="pagination" aria-label="Страницы задач">
              <button
                className="button ghost"
                disabled={loading || taskOffset === 0}
                onClick={() => setTaskOffset((v) => Math.max(0, v - 40))}
              >
                Предыдущие задачи
              </button>
              <span>
                {taskTotal ? taskOffset + 1 : 0}–{Math.min(taskOffset + 40, taskTotal)} из{' '}
                {taskTotal}
              </span>
              <button
                className="button ghost"
                disabled={loading || taskOffset + 40 >= taskTotal}
                onClick={() => setTaskOffset((v) => v + 40)}
              >
                Следующие задачи
              </button>
            </nav>
            {!visible.length && <p role="status">Задач по выбранным условиям нет.</p>}
            {view === 'trash' ? (
              <div className="trash-list">
                {tasks.map((t) => (
                  <article className="panel" key={t.id}>
                    <h2>{t.title}</h2>
                    <p>
                      Удалена {t.deleted_at ? new Date(t.deleted_at).toLocaleString('ru-RU') : ''}.
                      Данные можно восстановить.
                    </p>
                    <button className="button ghost" onClick={() => setHistoryTask(t)}>
                      История изменений
                    </button>
                    {writable && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void mutate(() => api.restoreTask(t.id, t.version))}
                      >
                        Восстановить задачу «{t.title}»
                      </button>
                    )}
                  </article>
                ))}
              </div>
            ) : view === 'calendar' ? (
              <div className="calendar-list">
                {Array.from(new Set(visible.map((t) => t.due_date)))
                  .sort()
                  .map((date) => (
                    <section className="panel" key={date}>
                      <h2>{shortDate(date)}</h2>
                      {visible
                        .filter((t) => t.due_date === date)
                        .map((t) => (
                          <p key={t.id}>
                            <strong>{t.title}</strong> · {t.project_name} · {statusLabels[t.status]}
                          </p>
                        ))}
                    </section>
                  ))}
              </div>
            ) : (
              <div className="board">
                {columns.map((status) => (
                  <section
                    className="board-column"
                    key={status}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = Number(e.dataTransfer.getData('text/plain'));
                      if (writable && tasks.some((t) => t.id === id)) move(id, status);
                    }}
                  >
                    <header>
                      <span className={`status-dot ${status}`} />
                      <strong>{statusLabels[status]}</strong>
                      <b>{visible.filter((t) => t.status === status).length}</b>
                    </header>
                    <div className="column-content">
                      {visible
                        .filter((t) => t.status === status)
                        .map((t) => (
                          <TaskCard
                            key={t.id}
                            task={t}
                            onMove={move}
                            onDelete={remove}
                            onEdit={() => setEditor(t)}
                            onHistory={() => setHistoryTask(t)}
                            writable={writable}
                            busy={busy}
                          />
                        ))}
                      {writable && (
                        <button className="add-inline" onClick={() => setEditor(null)}>
                          <CirclePlus />
                          Добавить задачу
                        </button>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      {guide && (
        <GuidedDemo
          session={session}
          signIn={signIn}
          onClose={() => setGuide(false)}
          onRefresh={load}
          onProgress={(task, deleted) => {
            reset();
            setQuery(task.title);
            go(deleted ? 'trash' : 'board');
          }}
          onComplete={(task) => {
            setGuide(false);
            setHistoryTask(task);
          }}
        />
      )}
      {loginOpen && <AuthDialog onClose={() => setLoginOpen(false)} onSignedIn={identityChanged} />}
      {historyTask && (
        <TaskHistoryDialog task={historyTask} onClose={() => setHistoryTask(null)} />
      )}{' '}
      {manage && (
        <WorkspaceDialog
          session={session}
          members={members}
          onRefresh={load}
          onClose={() => setManage(false)}
        />
      )}{' '}
      {editor !== undefined && (
        <TaskModal
          task={editor || undefined}
          projects={projects}
          members={members}
          onClose={() => setEditor(undefined)}
          onSave={async (body, key) => {
            if (editor) await api.updateTask(editor.id, body);
            else {
              await api.createTask(body, key);
              reset();
              setQuery(String((body as { title: string }).title));
            }
            await load();
            go('board');
          }}
        />
      )}
    </div>
  );
}
