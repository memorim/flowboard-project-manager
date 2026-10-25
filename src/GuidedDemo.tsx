import { useEffect, useRef, useState } from 'react';
import { api, selectWorkspace } from './api';
import type { Session, Task } from './types';
const steps = [
  'Создадим учебную задачу',
  'Отметим результат',
  'Переместим в корзину',
  'Восстановим задачу',
  'История сохранена',
];
export function GuidedDemo({
  session,
  signIn,
  onClose,
  onRefresh,
  onProgress,
  onComplete,
}: {
  session: Session;
  signIn: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onProgress: (task: Task, deleted: boolean) => void;
  onComplete: (task: Task) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    key = useRef(crypto.randomUUID()),
    prepared = useRef<Record<string, unknown> | null>(null),
    task = useRef<Task | null>(null),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const act = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (step === 0) {
        if (session.mode !== 'browser') {
          const own = (await api.workspaces()).find(
            (w) => w.access_role === 'owner' && w.name === 'Учебное пространство',
          );
          selectWorkspace(own?.id || (await api.createWorkspace('Учебное пространство')).id);
        }
        const project = (await api.meta()).projects[0];
        if (!project) throw new Error('Сначала создайте проект');
        const title = 'Учебная задача ' + key.current.slice(0, 8);
        prepared.current ??= {
          title,
          description: 'Подготовить план встречи.',
          status: 'todo',
          priority: 'medium',
          projectId: project.id,
          assigneeId: null,
          dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        };
        const created = await api.createTask(prepared.current, key.current);
        task.current = (await api.taskPage({ search: title })).items.find(
          (t) => t.id === created.id,
        )!;
      } else if (step === 1) await api.setStatus(task.current!.id, 'done', task.current!.version);
      else if (step === 2) await api.deleteTask(task.current!.id, task.current!.version);
      else if (step === 3) await api.restoreTask(task.current!.id, task.current!.version);
      const deleted = step === 2;
      if (task.current) {
        const page = await (deleted ? api.trashPage : api.taskPage)({ search: task.current.title });
        task.current = page.items.find((t) => t.id === task.current!.id) || task.current;
        onProgress(task.current, deleted);
      }
      await onRefresh();
      setStep((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить шаг');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="modal task-dialog guided-demo"
      aria-labelledby="guided-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="modal-head">
        <span className="eyebrow">Знакомство с проектом · шаг {step + 1} из 5</span>
        <button className="icon-button" onClick={close} aria-label="Закрыть демонстрацию">
          ×
        </button>
      </div>
      <h2 id="guided-title">{steps[step]}</h2>
      <p>
        {
          [
            'Пройдём создание, завершение и восстановление задачи. В серверной версии используем ваше пространство; существующие задачи не меняются.',
            'Задача создана. Следующий шаг обновит статус и счётчики проекта.',
            'Завершённую учебную задачу перенесём в корзину. Её данные сохранятся.',
            'Вернём ту же задачу из корзины. Она сохранит содержание и получит новую версию.',
            'Создание, смена статуса, удаление и восстановление записаны с автором и временем.',
          ][step]
        }
      </p>
      {task.current && (
        <p>
          <strong>{task.current.title}</strong> · версия {task.current.version}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!session.user && session.mode === 'chatgpt' ? (
        <a className="button primary" href={signIn} target="_top">
          Войти для демонстрации
        </a>
      ) : step < 4 ? (
        <button className="button primary" disabled={busy} onClick={() => void act()}>
          {busy
            ? 'Выполняем шаг…'
            : [
                'Создать учебную задачу',
                'Отметить выполненной',
                'Переместить в корзину',
                'Восстановить учебную задачу',
              ][step]}
        </button>
      ) : (
        <button
          className="button primary"
          onClick={() => {
            dialog.current?.close();
            onComplete(task.current!);
          }}
        >
          Посмотреть историю учебной задачи
        </button>
      )}
    </dialog>
  );
}
