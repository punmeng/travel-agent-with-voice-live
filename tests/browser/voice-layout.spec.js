import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`voice panel is adjustable and preserves the conversation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/bootstrap', async route => {
      const response = await route.fetch(), data = await response.json();
      data.voice.type = 'azure-personal';
      data.history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `歷史對話 ${i + 1}` }));
      await route.fulfill({ response, json: data });
    });
    await page.goto('/');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#voice-dialog')).toBeHidden();
    await expect(page.locator('#voice-agent')).toBeVisible();
    await expect(page.locator('#voice-mode option').first()).toHaveText('1 · Voice Live · GPT-5.4 + Personal Voice');
    await page.locator('#conversation-expand').click();
    await expect(page.locator('#conversation-expand')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.layout')).toHaveClass(/expanded/);
    await page.locator('#voice').click();
    const panel = page.locator('#voice-dialog'), slider = page.locator('#voice-panel-height');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(panel).toHaveCSS('height', '160px');
    const panelBounds = await panel.boundingBox();
    const startBounds = await page.locator('#voice-start').boundingBox();
    expect(startBounds.y).toBeGreaterThanOrEqual(panelBounds.y);
    expect(startBounds.y + startBounds.height).toBeLessThanOrEqual(panelBounds.y + panelBounds.height);
    await expect(page.locator('#messages')).toBeVisible();
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThan(80);
    await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
    await expect(page.locator('#messages .message').nth(1)).toContainText('歷史對話 1');
    await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollTop)).toBe(0);
    await page.locator('#messages').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#messages .message').last()).toContainText('歷史對話 30');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(panel).toHaveCSS('height', '180px');
    expect(await panel.evaluate(node => getComputedStyle(node).resize)).toBe('vertical');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#conversation-expand').click();
    await expect(page.locator('.layout')).not.toHaveClass(/expanded/);
    await page.locator('#close-voice').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#voice-agent')).toBeVisible();
  });
}

test('actual agent progress remains visible during text requests without opening voice', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/chat', async route => { await pending; await route.continue(); });
  await page.route(/\/api\/progress\?/, route => route.fulfill({ json: { progress: {
    requestId: new URL(route.request().url()).searchParams.get('requestId'), role: 'planner', status: 'processing'
  } } }));
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#message').fill('規劃日本行程');
  await page.locator('#send').click();
  await expect(page.locator('#voice-dialog')).toBeHidden();
  await expect(page.locator('#voice-agent')).toBeVisible();
  await expect(page.locator('#voice-agent')).toHaveText('旅遊規劃 · 處理中');
  await expect(page.locator('#voice-agent')).toHaveAttribute('title', '旅遊規劃代理（planner）');
  release();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#voice-agent')).toContainText('已完成');
});
