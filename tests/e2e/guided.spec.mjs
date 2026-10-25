import { test, expect } from '../fixtures.mjs';
test('guided synthetic task completes create, status, trash, restore and history', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Пройти демонстрацию', exact: true }).click();
  const d = page.getByRole('dialog');
  for (const name of [
    'Создать учебную задачу',
    'Отметить выполненной',
    'Переместить в корзину',
    'Восстановить учебную задачу',
  ]) {
    await d.getByRole('button', { name, exact: true }).click();
  }
  await expect(d.getByRole('heading', { name: 'История сохранена', exact: true })).toBeVisible();
  await d.getByRole('button', { name: 'Посмотреть историю учебной задачи', exact: true }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('heading', { name: 'Восстановление · версия 4', exact: true }),
  ).toBeVisible();
});
