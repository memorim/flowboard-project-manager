import { test, expect, chromium } from '../fixtures.mjs';
import { fileURLToPath } from 'node:url';
// A disposable Chromium profile uses the native tabs.setZoom API, not CSS zoom or device emulation.
test('real 200% browser zoom keeps the primary form usable', async ({ baseURL }, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Native zoom is measured once in isolated Chromium; reflow is checked in all engines.',
  );
  const extension = fileURLToPath(new URL('../zoom-extension', import.meta.url));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: null,
    args: [
      '--window-size=1280,900',
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(baseURL);
    const opener = page.getByRole('button', { name: 'Новая задача', exact: true });
    await expect(opener).toBeEnabled();
    const before = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
    const actual = await worker.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url));
      if (!tab?.id) throw new Error('Local test tab absent');
      await chrome.tabs.setZoom(tab.id, 2);
      return chrome.tabs.getZoom(tab.id);
    }, baseURL);
    expect(actual).toBe(2);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(before.dpr * 2, 1);
    const after = await page.evaluate(() => ({
      width: innerWidth,
      dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
    expect(Math.abs(after.width - before.width / 2)).toBeLessThan(3);
    expect(after.overflow).toBe(false);
    await opener.focus();
    await opener.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await dialog.press('Tab');
    expect(await dialog.evaluate((e) => e.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: info.outputPath('zoom-200.png') });
    await dialog.press('Escape');
    await expect(opener).toBeFocused();
    await info.attach('native-zoom-measurements', {
      body: JSON.stringify({ zoom: actual, before, after }),
      contentType: 'application/json',
    });
  } finally {
    await context.close();
  }
});
