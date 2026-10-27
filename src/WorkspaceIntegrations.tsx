import { useEffect, useState } from 'react';
import { serverApi, workspaceId } from './api';
export function WorkspaceIntegrations() {
  const [directory, setDirectory] = useState<Awaited<ReturnType<typeof serverApi.directory>>>(),
    [billing, setBilling] = useState<Awaited<ReturnType<typeof serverApi.billing>>>(),
    [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reload = async () => {
    const [d, b] = await Promise.all([serverApi.directory(), serverApi.billing()]);
    setDirectory(d);
    setBilling(b);
  };
  useEffect(() => {
    let active = true;
    Promise.all([serverApi.directory(), serverApi.billing()])
      .then(([d, b]) => {
        if (active) {
          setDirectory(d);
          setBilling(b);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-section">
      <h3>Интеграции пространства</h3>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <details>
        <summary>Каталог сотрудников · SCIM 2.0</summary>
        <p>
          Пользователи и группы синхронизируются только с этим пространством. Деактивация удаляет
          доступ к нему.
        </p>
        {directory?.enabled === false ? (
          <p>
            Для активации новых сотрудников настройте SMTP, ключ приложения и публичный адрес
            сервера.
          </p>
        ) : (
          <>
            <p>
              Токен: {directory?.configured ? 'подключён' : 'не создан'}. Срок действия — 90 дней.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void run(async () => {
                  const result = await serverApi.createDirectoryToken(
                    String(data.get('password')),
                    String(data.get('role')),
                  );
                  setToken(result.token);
                });
              }}
            >
              <label>
                Текущий пароль
                <input
                  type="password"
                  name="password"
                  required
                  autoComplete="current-password"
                  maxLength={128}
                />
              </label>
              <label>
                Роль новых сотрудников
                <select name="role">
                  <option value="viewer">Наблюдатель</option>
                  <option value="editor">Редактор</option>
                </select>
              </label>
              <button className="button ghost" disabled={busy}>
                Создать или заменить токен
              </button>
            </form>
            {token && (
              <label>
                Скопируйте токен сейчас: повторно он не показывается
                <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} />
              </label>
            )}
            {directory?.baseUrl && (
              <label>
                SCIM Base URL
                <input readOnly value={directory.baseUrl} />
              </label>
            )}
            {directory?.configured && (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await serverApi.revokeDirectoryToken();
                    setToken('');
                  })
                }
              >
                Отключить каталог
              </button>
            )}
          </>
        )}
      </details>
      <details>
        <summary>План «Команда»</summary>
        <p>
          Квота проектов ×4 на 30 дней. Разовая оплата без автопродления. Задачи и доступ к данным
          сохраняются после окончания плана.
        </p>
        {billing?.validUntil && (
          <p>Действует до {new Date(billing.validUntil).toLocaleDateString('ru-RU')}.</p>
        )}
        {billing?.enabled ? (
          <>
            <p>
              {new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(
                billing.amountCents / 100,
              )}{' '}
              {billing.testMode ? '· тестовый режим ЮKassa' : ''}
            </p>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const storageKey = 'flowboard-checkout-' + workspaceId();
                  const previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as {
                    key: string;
                    id?: string;
                  } | null;
                  const completed =
                    previous?.id &&
                    billing.payments.some((p) => p.id === previous.id && p.status !== 'pending');
                  let key = completed ? null : previous?.key;
                  if (!key) {
                    key = crypto.randomUUID();
                    sessionStorage.setItem(storageKey, JSON.stringify({ key }));
                  }
                  const payment = await serverApi.checkout(key);
                  sessionStorage.setItem(storageKey, JSON.stringify({ key, id: payment.id }));
                  if (payment.confirmationUrl) window.location.assign(payment.confirmationUrl);
                  else if (payment.status === 'succeeded') sessionStorage.removeItem(storageKey);
                })
              }
            >
              Перейти к оплате
            </button>
          </>
        ) : (
          <p>
            Оплата выключена. Владелец сервера должен подключить магазин ЮKassa и настроить
            уведомления.
          </p>
        )}
        {billing?.payments.map((p) => (
          <div className="session-row" key={p.id}>
            <span>
              {new Date(p.created_at).toLocaleDateString('ru-RU')} · {p.amount_cents / 100} ₽ ·{' '}
              {p.status === 'succeeded'
                ? 'Оплачено'
                : p.status === 'canceled'
                  ? 'Отменено'
                  : 'Ожидает подтверждения'}
              {p.is_test ? ' · тест' : ''}
            </span>
            {p.status === 'pending' && billing.enabled && (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() => void run(() => serverApi.refreshPayment(p.id))}
              >
                Проверить оплату
              </button>
            )}
          </div>
        ))}
        <button className="button ghost" disabled={busy} onClick={() => void run(reload)}>
          Обновить статус
        </button>
      </details>
    </section>
  );
}
