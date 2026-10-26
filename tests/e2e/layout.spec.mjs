import { test, expect } from '../fixtures.mjs';

test('sidebar follows the effective viewport at desktop 125%', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Переключить меню' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Задачи/ })
    .click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});
