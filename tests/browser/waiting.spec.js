import { test, expect } from '@playwright/test';

test('pending text disables voice start, shows a 15-second neutral cue and clears on completion', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), data = await response.json();
    data.voice = { available: true, message: '100回合；DEMO合成示範，不收款。' };
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    window.__microphoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__microphoneCalls++; throw new Error('must not start'); };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click();
  await expect(page.locator('#voice-message')).not.toBeVisible();
  let release;
  let processingRole = 'intent';
  await page.route(/\/api\/progress\?/, route => route.fulfill({ json: { progress: {
    requestId: new URL(route.request().url()).searchParams.get('requestId'), role: processingRole, status: 'processing'
  } } }));
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/chat', async route => { await pending; await route.continue(); });
  await page.clock.install({ time: new Date('2026-10-16T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-16T00:00:01Z'));
  await page.locator('#message').fill('我想去日本玩幾天');
  await page.locator('#send').click();
  await expect(page.locator('#voice-start')).toBeDisabled();
  await expect(page.locator('#voice-agent')).toHaveText('意圖協調 · 處理中');
  processingRole = 'planner';
  await page.evaluate(() => document.getElementById('voice-start').dispatchEvent(new Event('click')));
  expect(await page.evaluate(() => window.__microphoneCalls)).toBe(0);
  await page.clock.fastForward(14999);
  await expect(page.locator('#voice-agent')).toHaveText('旅遊規劃 · 處理中');
  await expect(page.locator('#busy')).not.toContainText('我還在查詢');
  await page.clock.fastForward(1);
  await expect(page.locator('#busy')).toContainText('我還在查詢，請稍等一下。');
  release();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#busy')).toBeHidden();
  await expect(page.locator('#voice-start')).toBeEnabled();
  await expect(page.locator('#voice-agent')).toHaveText('意圖協調 · 已完成');
  await expect(page.locator('#messages')).not.toContainText('我還在查詢');
});

test('long text failure and retry do not retain a stale waiting cue', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/chat', async route => {
    await pending;
    await route.fulfill({ status: 503, json: { message: '服務暫停，請重試。', error: 'TEST', correlationId: 'offline' } });
  });
  await page.clock.install();
  await page.locator('#message').fill('我想去日本');
  await page.locator('#send').click();
  await page.clock.fastForward(16000);
  await expect(page.locator('#busy')).toContainText('我還在查詢');
  release();
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#voice-agent')).toHaveText('等待對話');
  await expect(page.locator('#busy')).toBeHidden();
  await page.unroute('**/api/chat');
  await page.locator('#retry').click();
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#send')).toBeEnabled();
  await page.clock.fastForward(16000);
  await expect(page.locator('#busy')).toBeHidden();
});
