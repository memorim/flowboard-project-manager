import { test, expect } from '../fixtures.mjs';

test('calendar renders leap days, month filters and tasks beyond the first page', async ({
  page,
}) => {
  const tasks = Array.from({ length: 105 }, (_, i) => ({
    id: i + 1,
    version: 1,
    title: `Calendar task ${i + 1}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    project_id: 1,
    project_name: 'Calendar project',
    project_color: '#777',
    assignee_id: null,
    due_date: '2032-02-29',
  }));
  await page.route('**/api/tasks/page?*', (route) => {
    const url = new URL(route.request().url());
    const filtered = url.searchParams.get('month') === '2032-02' ? tasks : [];
    const offset = Number(url.searchParams.get('offset') || 0),
      limit = Number(url.searchParams.get('limit'));
    return route.fulfill({
      json: {
        items: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
      },
    });
  });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Переключить меню' });
  if ((await menu.getAttribute('aria-expanded')) === 'false') await menu.click();
  await page.getByRole('button', { name: 'Календарь', exact: true }).click();
  await page.getByLabel('Месяц календаря').fill('2032-02');
  await expect(page.locator('.calendar-task')).toHaveCount(105);
  await expect(page.locator('td[data-date]')).toHaveCount(29);
  await expect(page.locator('td[data-date="2032-02-29"] .calendar-task')).toHaveCount(105);
  await page.getByLabel('Месяц календаря').fill('2032-03');
  await expect(page.locator('td[data-date]')).toHaveCount(31);
  await expect(page.locator('.calendar-task')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});
