import { test, expect } from '../fixtures.mjs';

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
