import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { serverApi } from './api';

export function AuthDialog({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal task-dialog"
      aria-labelledby="login-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2 id="login-title">Вход в Flowboard</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть вход">
          <X />
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const data = new FormData(event.currentTarget);
          setBusy(true);
          setError('');
          try {
            await serverApi.login(String(data.get('email')), String(data.get('password')));
            await onSignedIn();
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Не удалось войти');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Электронная почта
          <input
            name="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
            autoFocus
          />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти в аккаунт'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
