import { test, expect } from '../fixtures.mjs';
test('keyboard focus, Escape and reflow at 320 and 640 CSS pixels', async ({ page }) => {
  await page.goto('/');
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    const small = await page
      .locator('button:visible,input:visible,select:visible')
      .evaluateAll((es) =>
        es
          .map((e) => ({
            label: e.getAttribute('aria-label') || e.textContent?.trim(),
            r: e.getBoundingClientRect(),
          }))
          .filter(({ r }) => r.width < 23.9 || r.height < 23.9)
          .map(({ label }) => label),
      );
    expect(small).toEqual([]);
    const opener = page.getByRole('button', { name: 'Новая задача', exact: true });
    await expect(opener).toBeEnabled();
    await opener.focus();
    await opener.press('Enter');
    const d = page.getByRole('dialog');
    await expect(d).toBeVisible();
    await expect(d.getByRole('heading', { name: 'Что нужно сделать?', exact: true })).toBeVisible();
    await expect.poll(() => d.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await d.press('Tab');
    const focused = await page.evaluate(() => {
      const e = document.activeElement,
        c = getComputedStyle(e);
      return { inside: !!e.closest('dialog'), outline: c.outlineStyle };
    });
    expect(focused.inside).toBe(true);
    expect(focused.outline).not.toBe('none');
    await d.press('Escape');
    await expect(d).not.toBeVisible();
    await expect(opener).toBeFocused();
  }
});
