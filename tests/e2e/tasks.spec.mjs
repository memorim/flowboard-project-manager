import { test, expect } from '../fixtures.mjs';
async function nav(page, name) {
  const target = page
    .getByRole('navigation')
    .getByRole('button', { name: name === 'Задачи' ? /^Задачи/ : name, exact: name !== 'Задачи' });
  if (
    page.viewportSize().width <= 760 &&
    (await page.getByRole('button', { name: 'Переключить меню' }).getAttribute('aria-expanded')) !==
      'true'
  )
    await page.getByRole('button', { name: 'Переключить меню' }).click();
  await target.click();
}
test('create, edit, filter and move a task with persistence and a real activity log', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Рабочее пространство команды' })).toBeVisible();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  let modal = page.getByRole('dialog');
  const title = 'Browser task ' + Date.now();
  await modal.getByLabel('Название', { exact: true }).fill(title);
  await modal.getByLabel('Описание', { exact: true }).fill('Created by the browser test');
  await modal.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Действия: ' + title, exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('Название', { exact: true }).fill(title + ' edited');
  await modal.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
  await page.getByLabel('Статус: ' + title + ' edited', { exact: true }).selectOption('done');
  await expect(page.getByLabel('Статус: ' + title + ' edited', { exact: true })).toHaveValue(
    'done',
  );
  await page.reload();
  await nav(page, 'Задачи');
  await expect(page.getByRole('heading', { name: title + ' edited', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Поиск задач' }).fill('no-such-unique-task');
  await expect(page.getByText('Задач по выбранным условиям нет.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await expect(page.getByRole('heading', { name: title + ' edited', exact: true })).toBeVisible();
  await nav(page, 'Календарь');
  await expect(page.getByRole('heading', { name: 'Календарь сроков' })).toBeVisible();
  await nav(page, 'Команда');
  await expect(page.getByRole('heading', { name: 'Команда', exact: true })).toBeVisible();
  await nav(page, 'Обзор');
  await expect(
    page.getByText('отредактировал(а) задачу «' + title + ' edited»', { exact: false }),
  ).toBeVisible();
});

test('synthetic owner, editor and viewer use isolated workspaces and keep a conflicting draft', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.addInitScript(
    () => location.protocol.startsWith('http') && localStorage.setItem('flowboard-actor', '1'),
  );
  const editorContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  await editorContext.addInitScript(
    () => location.protocol.startsWith('http') && localStorage.setItem('flowboard-actor', '2'),
  );
  const viewerContext = await browser.newContext({ baseURL, viewport: page.viewportSize() });
  await viewerContext.addInitScript(
    () => location.protocol.startsWith('http') && localStorage.setItem('flowboard-actor', '3'),
  );
  const editor = await editorContext.newPage(),
    viewer = await viewerContext.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Пространство и участники', exact: true }).click();
    let dialog = page.getByRole('dialog');
    const name = 'Synthetic team ' + Date.now();
    await dialog.getByLabel('Название нового пространства', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Создать пространство', exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
    ).toContainText(name);
    const wid = await page
      .getByRole('combobox', { name: 'Рабочее пространство', exact: true })
      .inputValue();
    expect(wid).not.toBe('1');
    async function invitation(role) {
      await page.getByRole('button', { name: 'Пространство и участники', exact: true }).click();
      const d = page.getByRole('dialog');
      await d.getByRole('combobox', { name: 'Роль приглашённого', exact: true }).selectOption(role);
      await d.getByRole('button', { name: 'Создать приглашение', exact: true }).click();
      const field = d.getByRole('textbox', { name: 'Одноразовая ссылка приглашения', exact: true });
      await expect(field).toHaveValue(/#invite=/);
      const url = await field.inputValue();
      await d
        .getByRole('button', { name: 'Закрыть управление пространством', exact: true })
        .click();
      return url;
    }
    const editorLink = await invitation('editor');
    await editor.goto(editorLink);
    await editor.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
    await expect(
      editor.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
    ).toHaveValue(wid);
    const title = 'Synthetic shared task ' + Date.now();
    await editor.getByRole('button', { name: 'Новая задача', exact: true }).click();
    dialog = editor.getByRole('dialog');
    await dialog.getByLabel('Название', { exact: true }).fill(title);
    await dialog.getByLabel('Описание', { exact: true }).fill('Synthetic initial revision');
    await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(editor.getByRole('dialog')).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
    await nav(page, 'Задачи');
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Действия: ' + title, exact: true }).click();
    await editor.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await editor
      .getByRole('dialog')
      .getByLabel('Описание', { exact: true })
      .fill('Unsaved synthetic draft', { timeout: 6000 });
    await page.getByRole('button', { name: 'Действия: ' + title, exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Описание', { exact: true })
      .fill('Owner saved revision');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Сохранить изменения', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await editor
      .getByRole('dialog')
      .getByRole('button', { name: 'Сохранить изменения', exact: true })
      .click();
    await expect(editor.getByRole('dialog').getByRole('alert')).toContainText('уже изменена');
    await expect(editor.getByRole('dialog').getByLabel('Описание', { exact: true })).toHaveValue(
      'Unsaved synthetic draft',
    );
    await editor.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    const viewerLink = await invitation('viewer');
    await viewer.goto(viewerLink);
    await viewer.getByRole('button', { name: 'Принять приглашение', exact: true }).click();
    await expect(
      viewer.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
    ).toHaveValue(wid);
    await expect(viewer.getByRole('button', { name: 'Новая задача', exact: true })).toBeDisabled();
    await nav(viewer, 'Задачи');
    await expect(viewer.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Пространство и участники', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog
      .getByRole('combobox', { name: 'Роль: Илья Власов', exact: true })
      .selectOption('viewer');
    await expect(
      dialog.getByRole('combobox', { name: 'Роль: Илья Власов', exact: true }),
    ).toHaveValue('viewer');
    await editor.getByRole('button', { name: 'Обновить данные', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Новая задача', exact: true })).toBeDisabled();
    await dialog
      .locator('.membership-row')
      .filter({ hasText: 'Марк Левин' })
      .getByRole('button', { name: 'Удалить участника', exact: true })
      .click();
    await expect(dialog.locator('.membership-row').filter({ hasText: 'Марк Левин' })).toHaveCount(
      0,
    );
    await viewer.getByRole('button', { name: 'Обновить данные', exact: true }).click();
    await expect(
      viewer.getByRole('combobox', { name: 'Рабочее пространство', exact: true }),
    ).toHaveValue('1');
    await expect(viewer.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    expect(
      (
        await viewerContext.request.get('/api/tasks?workspace=' + wid, {
          headers: { 'X-Demo-Actor': '3' },
        })
      ).status(),
    ).toBe(404);
    await dialog.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await Promise.allSettled([editorContext.close(), viewerContext.close()]);
  }
});
