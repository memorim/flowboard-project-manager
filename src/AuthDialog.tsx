import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { serverApi } from './api';
import { ProviderIcon } from './ProviderIcon';

export type AuthAction = {
  action: 'verify' | 'reset' | 'provider-mfa' | 'provider-error';
  token: string;
};
export function AuthDialog({
  onClose,
  onSignedIn,
  initial,
}: {
  onClose: () => void;
  onSignedIn: () => Promise<void>;
  initial?: AuthAction | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'login' | 'register' | 'forgot' | 'verify' | 'reset' | 'mfa'>(
    initial?.action === 'provider-mfa'
      ? 'mfa'
      : initial?.action === 'provider-error'
        ? 'login'
        : initial?.action || 'login',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(
      initial?.action === 'provider-error' ? 'Не удалось подтвердить вход. Повторите попытку.' : '',
    ),
    [message, setMessage] = useState(''),
    [challenge, setChallenge] = useState('');
  const [config, setConfig] = useState({ registration: false, passwordReset: false, mfa: false });
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof serverApi.socialProviders>>>(
    [],
  );
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void serverApi
      .socialProviders()
      .then((value) => {
        if (active) setProviders(value);
      })
      .catch(() => {});
    if (initial?.action === 'provider-mfa')
      void serverApi
        .socialMfaChallenge()
        .then((value) => {
          if (active) setChallenge(value.challenge);
        })
        .catch((error) => {
          if (active) {
            setError(error.message);
            setView('login');
          }
        });
    serverApi
      .authConfig()
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const titles = {
    login: 'Вход в Flowboard',
    register: 'Создать аккаунт',
    forgot: 'Восстановить доступ',
    verify: 'Подтвердить почту',
    reset: 'Новый пароль',
    mfa: 'Подтвердить вход',
  };
  const change = (next: typeof view) => {
    setView(next);
    setError('');
    setMessage('');
  };
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
        <h2 id="login-title">{titles[view]}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть вход">
          <X />
        </button>
      </div>
      {view === 'login' && providers.length > 0 && (
        <div className="auth-providers" aria-label="Другие способы входа">
          {providers.map((provider) => (
            <a
              className="auth-provider"
              key={provider.id}
              href={'/api/auth/oauth/' + encodeURIComponent(provider.id) + '/start'}
              aria-label={'Войти через ' + provider.label}
            >
              <ProviderIcon id={provider.id} />
              <span>{provider.label}</span>
            </a>
          ))}
          <button
            className="auth-provider"
            type="button"
            aria-label="Войти по почте"
            onClick={() => emailInput.current?.focus()}
          >
            <ProviderIcon id="email" />
            <span>Почта</span>
          </button>
        </div>
      )}
      <form
        key={view}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const form = event.currentTarget,
            data = new FormData(form),
            email = String(data.get('email') || ''),
            password = String(data.get('password') || '');
          setBusy(true);
          setError('');
          setMessage('');
          try {
            if (view === 'register') {
              const result = await serverApi.register(String(data.get('name')), email, password);
              setMessage(result.message);
              form.reset();
            } else if (view === 'forgot') {
              const result = await serverApi.forgotPassword(email);
              setMessage(result.message);
              form.reset();
            } else if (view === 'verify' || view === 'reset') {
              if (!initial) throw new Error('Откройте ссылку из письма');
              if (view === 'verify') await serverApi.verifyEmail(initial.token, password);
              else await serverApi.resetPassword(initial.token, password);
              setView('login');
              setMessage(
                view === 'verify'
                  ? 'Почта подтверждена. Теперь войдите.'
                  : 'Пароль обновлён. Войдите с новым паролем.',
              );
            } else {
              if (view === 'login') {
                const result = await serverApi.login(email, password);
                if (result.mfaRequired && result.challenge) {
                  setChallenge(result.challenge);
                  setView('mfa');
                  return;
                }
              } else await serverApi.verifyMfa(challenge, String(data.get('code')));
              await onSignedIn();
              onClose();
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Не удалось выполнить действие');
          } finally {
            setBusy(false);
          }
        }}
      >
        {view === 'register' && (
          <label>
            Ваше имя
            <input
              name="name"
              autoComplete="name"
              minLength={2}
              maxLength={80}
              required
              autoFocus
            />
          </label>
        )}
        {['login', 'register', 'forgot'].includes(view) && (
          <label>
            Электронная почта
            <input
              name="email"
              ref={emailInput}
              type="email"
              autoComplete="username"
              maxLength={254}
              required
              autoFocus={view !== 'register'}
            />
          </label>
        )}
        {['login', 'register', 'verify', 'reset'].includes(view) && (
          <label>
            {view === 'verify' ? 'Пароль, выбранный при регистрации' : 'Пароль'}
            <input
              name="password"
              aria-label={view === 'verify' ? 'Пароль, выбранный при регистрации' : 'Пароль'}
              type="password"
              autoComplete={
                view === 'register' || view === 'reset' ? 'new-password' : 'current-password'
              }
              minLength={view === 'login' ? 1 : 15}
              maxLength={128}
              required
              autoFocus={view === 'verify' || view === 'reset'}
            />
            {view !== 'login' && <small>От 15 до 128 символов.</small>}
          </label>
        )}
        {view === 'mfa' && (
          <label>
            Код из приложения или резервный код
            <input name="code" autoComplete="one-time-code" maxLength={32} required autoFocus />
            <small>
              Код приложения меняется каждые 30 секунд. Каждый резервный код используется один раз.
            </small>
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={busy || (view === 'mfa' && !challenge)}>
            {busy
              ? 'Подождите…'
              : view === 'register'
                ? 'Зарегистрироваться'
                : view === 'forgot'
                  ? 'Отправить письмо'
                  : view === 'verify'
                    ? 'Подтвердить почту'
                    : view === 'reset'
                      ? 'Обновить пароль'
                      : view === 'mfa'
                        ? 'Подтвердить'
                        : 'Войти в аккаунт'}
          </button>
        </div>
      </form>
      <div className="auth-links">
        {view !== 'login' && (
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => change('login')}
          >
            Вернуться ко входу
          </button>
        )}
        {view === 'login' && config.registration && (
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => change('register')}
          >
            Создать аккаунт
          </button>
        )}
        {view === 'login' && config.passwordReset && (
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => change('forgot')}
          >
            Забыли пароль?
          </button>
        )}
      </div>
    </dialog>
  );
}
