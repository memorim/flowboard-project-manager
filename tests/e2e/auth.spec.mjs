import { test, expect } from '../fixtures.mjs';

test('configured provider choices and a failed callback are usable on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/?auth=provider-error');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toHaveText(
    'Не удалось подтвердить вход. Повторите попытку.',
  );
  for (const [id, label] of [
    ['google', 'Google'],
    ['yandex', 'Яндекс'],
    ['github', 'GitHub'],
  ])
    await expect(
      dialog.getByRole('link', { name: 'Войти через ' + label, exact: true }),
    ).toHaveAttribute('href', '/api/auth/oauth/' + id + '/start');
  await expect(dialog.getByLabel('Электронная почта')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Войти через Telegram' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Войти по почте', exact: true }).click();
  await expect(dialog.getByLabel('Электронная почта')).toBeFocused();
  expect(new URL(page.url()).searchParams.has('auth')).toBe(false);
});

test('real session login, private task persistence and logout work without actor switching', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Демонстрационный участник' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = page.getByRole('dialog');
  await login.getByLabel('Электронная почта').fill('owner@example.test');
  await login.getByLabel('Пароль', { exact: true }).fill('Correct-fixture-password-2026');
  await login.getByRole('button', { name: 'Войти в аккаунт' }).click();
  await expect(login).toHaveCount(0);
  expect(
    (await context.cookies()).find((cookie) => cookie.name === 'flowboard_session')?.httpOnly,
  ).toBe(true);
  await page.getByRole('button', { name: 'Пространство и участники' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название нового пространства').fill('Authenticated team');
  await dialog.getByRole('button', { name: 'Создать пространство', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
  ).toContainText('Authenticated team');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название', { exact: true }).fill('Session-owned task');
  await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Session-owned task', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
  ).toContainText('Authenticated team');
  if (page.viewportSize().width <= 760)
    await page.getByRole('button', { name: 'Переключить меню' }).click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'flowboard_session')).toBe(
    false,
  );
  await expect(
    page.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
  ).not.toContainText('Authenticated team');
  expect(
    (
      await context.request.get('/api/tasks?workspace=2', { headers: { 'X-Demo-Actor': '5' } })
    ).status(),
  ).toBe(404);
});

test('registration, email proof, password recovery and MFA settings work in the browser', async ({
  page,
  request,
}) => {
  const password = 'Browser-signup-password-2026';
  await page.goto('/');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await dialog.getByLabel('Ваше имя').fill('Browser member');
  await dialog.getByLabel('Электронная почта').fill('browser@example.test');
  await dialog.getByLabel('Пароль', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('письмо');
  let messages = await (await request.get('/__test/messages')).json();
  const link = messages.at(-1).text.match(/http:\/\/127.0.0.1:4141\/\S+/)[0];
  await page.goto(link);
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Пароль, выбранный при регистрации').fill(password);
  await dialog.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Вход в Flowboard' })).toBeVisible();
  expect(page.url()).not.toContain('token=');
  await dialog.getByLabel('Электронная почта').fill('browser@example.test');
  await dialog.getByLabel('Пароль', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Войти в аккаунт' }).click();
  await expect(dialog).toHaveCount(0);
  if (page.viewportSize().width <= 760)
    await page.getByRole('button', { name: 'Переключить меню' }).click();
  await page.getByRole('button', { name: 'Безопасность аккаунта', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Подтвердите пароль').fill(password);
  await dialog.getByRole('button', { name: 'Настроить защиту' }).click();
  await expect(
    dialog.getByRole('img', { name: 'QR-код для настройки аутентификатора' }),
  ).toBeVisible();
  const secret = await dialog.getByLabel('Ключ настройки').inputValue();
  const { totp } = await import('../../server/account-crypto.ts');
  await dialog
    .getByLabel('Код из приложения', { exact: true })
    .fill(totp(secret, Math.floor(Date.now() / 30000)));
  await dialog.getByRole('button', { name: 'Включить защиту', exact: true }).click();
  await expect(dialog.getByLabel('Резервные коды', { exact: true })).toBeVisible();
  const codes = (await dialog.getByLabel('Резервные коды', { exact: true }).inputValue()).split(
    '\n',
  );
  expect(codes).toHaveLength(10);
  await dialog.getByRole('button', { name: 'Закрыть настройки аккаунта' }).click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Забыли пароль?' }).click();
  await dialog.getByLabel('Электронная почта').fill('browser@example.test');
  await dialog.getByRole('button', { name: 'Отправить письмо', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('письмо');
  messages = await (await request.get('/__test/messages')).json();
  await page.goto(messages.at(-1).text.match(/http:\/\/127.0.0.1:4141\/\S+/)[0]);
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Пароль', { exact: true }).fill(password + '-new');
  await dialog.getByRole('button', { name: 'Обновить пароль', exact: true }).click();
  await dialog.getByLabel('Электронная почта').fill('browser@example.test');
  await dialog.getByLabel('Пароль', { exact: true }).fill(password + '-new');
  await dialog.getByRole('button', { name: 'Войти в аккаунт' }).click();
  await expect(dialog.getByRole('heading', { name: 'Подтвердить вход' })).toBeVisible();
  await dialog.getByLabel('Код из приложения или резервный код').fill(codes[0]);
  await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
