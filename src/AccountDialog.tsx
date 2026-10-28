import { useEffect, useRef, useState } from 'react';
import { serverApi } from './api';
import { ProviderIcon } from './ProviderIcon';

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [account, setAccount] = useState<Awaited<ReturnType<typeof serverApi.account>> | null>(
    null,
  );
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof serverApi.sessions>>>([]);
  const [config, setConfig] = useState({ mfa: false });
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof serverApi.socialProviders>>>(
    [],
  );
  const [setup, setSetup] = useState<Awaited<ReturnType<typeof serverApi.setupMfa>> | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const refresh = async () => {
    const [user, devices] = await Promise.all([serverApi.account(), serverApi.sessions()]);
    setAccount(user);
    setSessions(devices);
  };
  useEffect(() => {
    dialog.current?.showModal();
    void refresh().catch((error) => setError(error.message));
    void serverApi
      .socialProviders()
      .then(setProviders)
      .catch(() => {});
    void serverApi
      .authConfig()
      .then(setConfig)
      .catch(() => {});
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="modal task-dialog account-dialog"
      aria-labelledby="account-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2 id="account-title">Безопасность аккаунта</h2>
        <button className="icon-button" aria-label="Закрыть настройки аккаунта" onClick={onClose}>
          ×
        </button>
      </div>
      <p>{account?.email || account?.name}</p>
      {account?.hasPassword === false && (
        <p>
          Для изменения способов входа и защиты повторно войдите через провайдера. Подтверждение
          действует 5 минут.
        </p>
      )}
      {providers.length > 0 && account && (
        <section>
          <h3>Способы входа</h3>
          {providers.map((provider) =>
            account.identities.some((identity) => identity.provider === provider.id) ? (
              <p className="provider-connection" key={provider.id}>
                <ProviderIcon id={provider.id} />
                {provider.label}: подключён
              </p>
            ) : (
              <form
                key={provider.id}
                onSubmit={(event) => {
                  event.preventDefault();
                  const password = String(new FormData(event.currentTarget).get('password') || '');
                  void run(async () => {
                    const result = await serverApi.linkProvider(provider.id, password);
                    window.location.assign(result.url);
                  });
                }}
              >
                {account.hasPassword && (
                  <label>
                    Текущий пароль
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      maxLength={128}
                      required
                    />
                  </label>
                )}
                <button className="button ghost provider-connection" disabled={busy}>
                  <ProviderIcon id={provider.id} />
                  Подключить {provider.label}
                </button>
              </form>
            ),
          )}
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {config.mfa && (
        <section>
          <h3>Двухфакторная защита {account?.mfaEnabled ? 'включена' : 'выключена'}</h3>
          {!account?.mfaEnabled && !setup && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  password = String(new FormData(form).get('password') || '');
                void run(async () => {
                  setSetup(await serverApi.setupMfa(password));
                  form.reset();
                });
              }}
            >
              {account?.hasPassword !== false && (
                <label>
                  Подтвердите пароль
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </label>
              )}
              <button className="button primary" disabled={busy}>
                Настроить защиту
              </button>
            </form>
          )}
          {setup && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const code = String(new FormData(e.currentTarget).get('code'));
                void run(async () => {
                  const result = await serverApi.enableMfa(code);
                  setCodes(result.recoveryCodes);
                  setSetup(null);
                  setMessage('Двухфакторная защита включена. Сохраните резервные коды.');
                });
              }}
            >
              <p>Отсканируйте QR-код в приложении-аутентификаторе или введите ключ вручную.</p>
              <img
                src={setup.qr}
                width="220"
                height="220"
                alt="QR-код для настройки аутентификатора"
              />
              <label>
                Ключ настройки
                <input readOnly value={setup.secret} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <label>
                Код из приложения
                <input
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                Включить защиту
              </button>
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => setSetup(null)}
              >
                Отменить настройку
              </button>
            </form>
          )}
          {account?.mfaEnabled && (
            <details>
              <summary>Отключить двухфакторную защиту</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    data = new FormData(form);
                  void run(async () => {
                    await serverApi.disableMfa(
                      String(data.get('password') || ''),
                      String(data.get('code')),
                    );
                    setCodes([]);
                    form.reset();
                    setMessage('Двухфакторная защита отключена.');
                  });
                }}
              >
                {account?.hasPassword !== false && (
                  <label>
                    Пароль
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                    />
                  </label>
                )}
                <label>
                  Код приложения или резервный код
                  <input name="code" autoComplete="one-time-code" required maxLength={32} />
                </label>
                <button className="button ghost" disabled={busy}>
                  Отключить защиту
                </button>
              </form>
            </details>
          )}
          {codes.length > 0 && (
            <section>
              <h3>Резервные коды</h3>
              <p>
                Сохраните их в безопасном месте. Каждый код работает один раз; повторно этот список
                не показывается.
              </p>
              <textarea
                aria-label="Резервные коды"
                readOnly
                rows={6}
                value={codes.join('\n')}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                className="button ghost"
                onClick={() => {
                  const url = URL.createObjectURL(
                      new Blob([codes.join('\n')], { type: 'text/plain' }),
                    ),
                    link = document.createElement('a');
                  link.href = url;
                  link.download = 'flowboard-recovery-codes.txt';
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Скачать коды
              </button>
            </section>
          )}
        </section>
      )}
      <section>
        <h3>Активные сессии</h3>
        {sessions.map((session) => (
          <div className="session-row" key={session.session_id}>
            <div>
              <strong>{session.current ? 'Этот браузер' : 'Другой браузер'}</strong>
              <p>{session.device}</p>
              <small>
                {session.created_at
                  ? new Date(session.created_at).toLocaleString('ru-RU')
                  : 'Ранее'}
              </small>
            </div>
            {!session.current && (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await serverApi.revokeSession(session.session_id);
                  })
                }
              >
                Завершить сессию
              </button>
            )}
          </div>
        ))}
        <button
          className="button ghost"
          disabled={busy || sessions.length < 2}
          onClick={() =>
            void run(async () => {
              await serverApi.revokeOtherSessions();
              setMessage('Другие сессии завершены.');
            })
          }
        >
          Выйти на других устройствах
        </button>
      </section>
    </dialog>
  );
}
