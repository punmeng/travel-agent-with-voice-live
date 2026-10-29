import { test, expect } from '@playwright/test';
import { countWords } from '../../lib/replies.js';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
async function say(page, text) {
  await page.locator('#message').fill(text);
  await page.locator('#message').press('Enter');
  await expect(page.locator('#send')).toBeEnabled();
  const more = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).state.moreReply);
  expect(more).toBe(false);
  const replies = await page.locator('.message.assistant > div > p:not(.speaker)').allTextContents();
  for (const reply of replies) {
    expect(countWords(reply)).toBeLessThanOrEqual(500);
    expect(reply).not.toContain('說「繼續」看下一段');
  }
}
test('desktop chat-only planning, selection, quote and confirmation with no choice controls', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
  });
  await page.goto('/?scoutTheme=dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('.rail, .steps, .conversation-head, .brand-mark')).toHaveCount(0);
  await expect(page.locator('select:not(#language):not(#voice-dialog select), input:not(#voice-panel-height):not(#voice-dialog input):not(#member-dialog input), .card, [data-prompt], #trip-form')).toHaveCount(0);
  await expect(page.locator('#voice-mode')).toHaveCount(1);
  await say(page, '從桃園到成田，2026-11-12，2 人，經濟艙，少步行，請規劃行程');
  await expect(page.locator('#messages')).toContainText('東京3天');
  await say(page, '搜尋航班，比較前後一天');
  await expect(page.locator('#messages')).toContainText('DEMO-FLT-');
  await expect(page.getByRole('button', { name: '選擇', exact: true })).toHaveCount(0);
  await say(page, '選第二班');
  await expect(page.locator('#messages')).toContainText('已選第 2 班');
  await say(page, '重新報價');
  await expect(page.locator('#messages')).toContainText('模擬確認價：TWD');
  await page.reload();
  await expect(page.locator('#messages')).toContainText('模擬確認價：TWD');
  await say(page, '確認目前報價');
  await expect(page.locator('#messages')).toContainText('模擬識別碼：SIM-');
  await page.getByRole('link', { name: '開啟模擬結帳（不收款）' }).click();
  await expect(page).toHaveTitle('模擬結帳 · Ni Airlines');
  await expect(page.getByRole('img', { name: 'Ni Airlines' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  await expect(page.locator('body')).toContainText('不接受信用卡、不扣款、不訂位、不開票');
  await expect(page.locator('input, form')).toHaveCount(0);
  await page.getByRole('link', { name: '回到旅行對話' }).click();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('select:not(#language):not(#voice-dialog select), input:not(#voice-panel-height):not(#voice-dialog input):not(#member-dialog input), .card, [data-prompt], #purchase')).toHaveCount(0);
  await page.locator('#voice').click();
  await expect(page.locator('#voice-dialog')).toContainText('尚未啟用');
  await expect(page.locator('#voice-start')).toBeDisabled();
  await page.getByRole('button', { name: '關閉，繼續文字規劃' }).click();
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('mobile partial chat setup, keyboard submission and recoverable retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await say(page, '從桃園到成田');
  await expect(page.locator('#messages')).toContainText('哪一天出發');
  await page.route('**/api/chat', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'TEST', message: '暫時無法連線', correlationId: 'test' }) }));
  await say(page, '2026-11-12，2 人，經濟艙，請規劃行程');
  await expect(page.getByRole('alert')).toContainText('暫時無法連線');
  await page.unroute('**/api/chat');
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await expect(page.locator('#messages')).toContainText('東京3天');
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('select:not(#language):not(#voice-dialog select), input:not(#voice-panel-height):not(#voice-dialog input):not(#member-dialog input), .card, [data-prompt]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
test('central release footer remains reachable below controls without compressing mobile conversation', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('#app-version')).toHaveText(`v${version}`);
    await expect(page.locator('.app-footer')).toContainText('Powered by Microsoft Innovation Taipei');
    const health = await (await page.request.get('/api/health')).json();
    expect(health.version).toBe(version);
    for (const open of [false, true]) {
      if (open) await page.locator('#voice').click();
      await page.locator('.app-footer').scrollIntoViewIfNeeded();
      const bounds = await page.evaluate(() => ({
        footer: document.querySelector('.app-footer').getBoundingClientRect().toJSON(),
        composer: document.querySelector('.composer-area').getBoundingClientRect().toJSON(),
        viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth
      }));
      expect(bounds.footer.top).toBeGreaterThanOrEqual(bounds.composer.bottom - 1);
      expect(bounds.footer.bottom).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(bounds.overflow).toBe(false);
      if (viewport.width === 390) expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(240);
    }
  }
});
test('country-level inspiration and five-day plan never request codes or trigger a search', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await say(page, '我想去日本玩幾天');
  await expect(page.getByRole('alert')).toBeHidden();
  await say(page, '想賞楓，不要走太多路，下個月中，五天，帶媽媽');
  await say(page, '那東京好了，幫我安排五天');
  await expect(page.locator('#messages')).toContainText('第 5 天');
  await expect(page.locator('#messages')).not.toContainText('UNKNOWN_CITY');
  const state = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).state);
  expect(state.discovery.country).toBe('日本');
  expect(state.discovery.durationDays).toBe(5);
  expect(state.draft.lowWalking).toBe(true);
  expect(state.toolUnits).toBe(0);
});
