import { test, expect } from '@playwright/test';

test.skip(!process.env.ENGLISH_UI_CANDIDATE_DIR, 'Requires the isolated staged member frontend.');

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`suggested departure needs confirmation and retains airport choices at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.locator('#language').selectOption('en-US');
    await page.locator('#member-login').click();
    await page.locator('#member-email').fill('alex.taipei@example.test');
    await page.locator('#member-password').fill('MeihaoDemo!2026');
    await page.locator('#member-submit').click();
    await expect(page.locator('#origin-suggestion')).toBeVisible();
    await expect(page.locator('#origin-city')).toHaveText('Taipei');
    await expect(page.locator('#session-facts')).toContainText('Awaiting confirmation');
    await expect(page.locator('#messages')).toContainText('Depart from there for this trip?');
    const measured = await page.locator('#messages').evaluate(node => node.getBoundingClientRect().height);
    expect(measured).toBeGreaterThanOrEqual(viewport.width === 1366 ? 300 : 300);
    console.log(JSON.stringify({ viewport, pendingConversationHeight: measured }));
    await page.screenshot({ path: testInfo.outputPath(`origin-bilingual-pending-${viewport.width}.png`), fullPage: true });
    const pending = page.waitForResponse(response => response.url().endsWith('/api/chat') && response.request().method() === 'POST');
    await page.locator('#origin-confirm').click();
    const result = await (await pending).json();
    expect(result.state.originSuggestion.status).toBe('confirmed');
    expect(result.state.draft.origin).toBeUndefined();
    expect(result.tools).toEqual([]);
    await expect(page.locator('#origin-suggestion')).toBeHidden();
    await expect(page.locator('#messages')).toContainText('TPE / TSA');
    await expect(page.locator('#session-facts')).toContainText('台北');
    await page.screenshot({ path: testInfo.outputPath(`origin-bilingual-confirmed-${viewport.width}.png`), fullPage: true });
    const reset = page.waitForResponse(response => response.url().endsWith('/api/reset'));
    await page.locator('#new-trip').click();
    await reset;
    await expect(page.locator('#origin-suggestion')).toBeVisible();
    await page.locator('#origin-change').click();
    await expect(page.locator('#origin-suggestion')).toBeHidden();
    await expect(page.locator('#messages')).toContainText('The profile city was not applied');
  });
}
