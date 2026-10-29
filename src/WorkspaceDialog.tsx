import { useEffect, useRef, useState } from 'react';
import { api, serverApi, selectWorkspace } from './api';
import type { Member, Session } from './types';
import { WorkspaceIntegrations } from './WorkspaceIntegrations';
const labels: Record<string, string> = {
  owner: 'Владелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};
export function WorkspaceDialog({
  session,
  members,
  onRefresh,
  onClose,
}: {
  session: Session;
  members: Member[];
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [invite, setInvite] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const owner = session.workspace.access_role === 'owner';
  return (
    <dialog
      ref={dialog}
      className="modal task-dialog workspace-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="workspace-dialog-title"
    >
      <div className="modal-head">
        <div>
          <span className="eyebrow">Команда и доступ</span>
          <h2 id="workspace-dialog-title">{session.workspace.name}</h2>
        </div>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Закрыть управление пространством"
        >
          ×
        </button>
      </div>
      <p>
        Ваша роль: <strong>{labels[session.workspace.access_role]}</strong>.{' '}
        {session.workspace.is_public
          ? 'Общее демо видно всем. Создайте отдельное пространство для своей команды.'
          : 'Данные доступны только участникам этого пространства.'}
      </p>
      {!session.canWrite && (
        <p role="status">
          Здесь у вас доступ только для просмотра. Чтобы создавать задачи, выберите своё
          пространство в списке или создайте его ниже. В чужом пространстве право редактирования
          может предоставить его владелец.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get('name'));
          void run(async () => {
            const w = await api.createWorkspace(name);
            selectWorkspace(w.id);
            await onRefresh();
            close();
          });
        }}
      >
        <label>
          Название нового пространства
          <input
            name="name"
            required
            minLength={2}
            maxLength={80}
            placeholder="Например, команда продукта"
          />
        </label>
        <button className="button primary" disabled={busy}>
          Создать пространство
        </button>
      </form>
      {session.canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              name = String(new FormData(form).get('projectName'));
            void run(async () => {
              await api.createProject(name);
              form.reset();
              await onRefresh();
            });
          }}
        >
          <label>
            Название нового проекта
            <input name="projectName" required minLength={2} maxLength={80} />
          </label>
          <button className="button ghost" disabled={busy}>
            Добавить проект
          </button>
        </form>
      )}
      {owner && (
        <section>
          <h3>Одноразовое приглашение</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const role = String(new FormData(e.currentTarget).get('role'));
              const email = String(new FormData(e.currentTarget).get('email') || '').trim();
              void run(async () => {
                setNotice('');
                if (email) {
                  const result = await serverApi.inviteByEmail(role, email);
                  setInvite('');
                  setNotice('Письмо для ' + result.email + ' поставлено в очередь отправки.');
                  return;
                }
                const result = await api.invite(role);
                setInvite(
                  window.location.origin + window.location.pathname + '#invite=' + result.token,
                );
              });
            }}
          >
            <label>
              Роль приглашённого
              <select aria-label="Роль приглашённого" name="role">
                <option value="editor">Редактор — может менять задачи</option>
                <option value="viewer">Наблюдатель — только просмотр</option>
              </select>
            </label>
            {session.mode === 'authenticated' && (
              <label>
                Почта участника (необязательно)
                <input name="email" type="email" maxLength={254} autoComplete="email" />
                <small>
                  Укажите адрес для отправки письма или оставьте пустым, чтобы получить ссылку.
                </small>
              </label>
            )}
            <button className="button ghost" disabled={busy}>
              Создать приглашение
            </button>
          </form>
          {notice && <p role="status">{notice}</p>}
          {invite && (
            <label>
              Ссылка для приглашённого
              <input
                aria-label="Одноразовая ссылка приглашения"
                readOnly
                value={invite}
                onFocus={(e) => e.currentTarget.select()}
              />
              <small>
                Действует 7 дней, принимается одним участником. Передайте ссылку вручную.
              </small>
            </label>
          )}
        </section>
      )}
      {owner && session.mode === 'authenticated' && <WorkspaceIntegrations />}
      <section>
        <h3>Участники</h3>
        {members.map((m) => (
          <div className="membership-row" key={m.id}>
            <span>
              {m.name}
              <small>{labels[m.access_role || 'editor']}</small>
            </span>
            {owner && m.access_role !== 'owner' && (
              <>
                <label>
                  Роль
                  <select
                    aria-label={'Роль: ' + m.name}
                    disabled={busy}
                    value={m.access_role}
                    onChange={(e) =>
                      void run(async () => {
                        await api.changeRole(m.id, e.target.value);
                        await onRefresh();
                      })
                    }
                  >
                    <option value="editor">Редактор</option>
                    <option value="viewer">Наблюдатель</option>
                  </select>
                </label>
                <button
                  className="button ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.removeMember(m.id);
                      await onRefresh();
                    })
                  }
                >
                  Удалить участника
                </button>
              </>
            )}
          </div>
        ))}
      </section>
      {owner && (
        <button
          className="button ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const data = await api.exportWorkspace();
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = 'flowboard-workspace.json';
              a.click();
              URL.revokeObjectURL(url);
            })
          }
        >
          Экспортировать данные пространства
        </button>
      )}
    </dialog>
  );
}
