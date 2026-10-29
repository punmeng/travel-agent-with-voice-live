import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 2000, height: 1177 }, { width: 1366, height: 768 },
  { width: 390, height: 844 }, { width: 1000, height: 589 }]) {
  for (const locale of ['zh-TW', 'en-US']) test(`conversation-first layout, context and voice resize at ${viewport.width}px ${locale}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let voiceRequests = 0;
    await page.route('**/api/voice/session', route => { voiceRequests++; return route.abort(); });
    await page.route('**/api/bootstrap', async route => {
      const response = await route.fetch(), data = await response.json();
      data.locale = locale;
      data.member = { displayName: 'Alex', homeCity: 'Taipei', personaLabel: locale === 'en-US' ? 'Business traveler' : '商務旅客' };
      data.state.trip = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2, cabin: 'economy', lowWalking: true };
      data.state.internalCredential = 'NEVER_RENDER_INTERNAL_CONTEXT';
      data.voice = { available: true, modes: Object.fromEntries(
        ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct', 'foundry-voice-agent'].map(mode =>
          [mode, { available: true, advancedSettings: mode !== 'foundry-voice-agent', sttModes: ['rest', 'sdk'],
            requiredModel: 'gpt-realtime-2.1', configuredModel: 'gpt-realtime-2.1' }])) };
      data.history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `歷史對話 ${i + 1}` }));
      await route.fulfill({ response, json: data });
    });
    await page.goto('/');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#voice-dialog')).toBeHidden();
    await expect(page.locator('#voice-agent')).toBeVisible();
    await expect(page.locator('#voice-mode option')).toHaveCount(5);
    await page.locator('#conversation-expand').click();
    await expect(page.locator('#conversation-expand')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.layout')).toHaveClass(/expanded/);
    await page.locator('#voice').click();
    const panel = page.locator('#voice-dialog'), slider = page.locator('#voice-panel-height');
    const desktop = viewport.width > 900 && viewport.height > 650;
    const minimumReadingHeight = desktop ? viewport.height * .35 : Math.max(240, viewport.height * .45);
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(Math.floor(minimumReadingHeight));
    if (viewport.width === 1366) expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(300);
    const context = page.locator('#session-context');
    await expect(context).toHaveJSProperty('open', desktop);
    if (!desktop) await context.locator('summary').click();
    await expect(page.locator('#session-facts')).toContainText('TPE');
    await expect(page.locator('#session-facts')).toContainText('2026-11-12');
    await expect(context).toContainText(locale === 'en-US' ? 'Long-term memory not enabled' : '長期記憶尚未啟用');
    await expect(context).not.toContainText('NEVER_RENDER_INTERNAL_CONTEXT');
    const conversationBox = await page.locator('.conversation').boundingBox();
    const contextBox = await page.locator('.context-panel').boundingBox();
    if (desktop) expect(contextBox.x).toBeGreaterThanOrEqual(conversationBox.x + conversationBox.width - 1);
    else expect(contextBox.y).toBeGreaterThanOrEqual(conversationBox.y + conversationBox.height - 1);
    for (const mode of ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct', 'foundry-voice-agent']) {
      await page.locator('#voice-mode').selectOption(mode);
      for (const id of ['voice-start', 'voice-mute', 'voice-stop', 'close-voice']) {
        await expect(page.locator(`#${id}`)).toBeVisible();
        const bounds = await panel.boundingBox(), button = await page.locator(`#${id}`).boundingBox();
        expect(button.y).toBeGreaterThanOrEqual(bounds.y);
        expect(button.y + button.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      }
    }
    await expect(page.locator('.voice-settings')).not.toHaveAttribute('open', '');
    await page.locator('.voice-settings > summary').click();
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('160');
    await expect(panel).toHaveCSS('height', desktop ? '160px' : '220px');
    await expect(page.locator('#messages')).toBeVisible();
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(Math.floor(minimumReadingHeight));
    await page.locator('#messages').evaluate(node => { node.style.scrollBehavior = 'auto'; node.scrollTop = 0; });
    await expect(page.locator('#messages').getByText('歷史對話 1', { exact: true })).toBeVisible();
    await expect.poll(() => page.locator('#messages').evaluate(node => node.scrollTop)).toBe(0);
    await page.locator('#messages').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(page.locator('#messages .message').last()).toContainText('歷史對話 30');
    expect(await page.locator('#messages').evaluate(node => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThanOrEqual(1);
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveValue('180');
    expect(await panel.evaluate(node => getComputedStyle(node).resize)).toBe('vertical');
    // Both the slider and a previous native-resize inline size must respect the viewport budget.
    await slider.evaluate(node => { node.value = '440'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await panel.evaluate(node => { node.style.height = '900px'; });
    expect((await panel.boundingBox()).height).toBeLessThanOrEqual(viewport.height * (desktop ? .26 : .4) + 1);
    expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(Math.floor(minimumReadingHeight));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#conversation-expand').click();
    await expect(page.locator('.layout')).not.toHaveClass(/expanded/);
    await page.locator('#close-voice').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#voice-agent')).toBeVisible();
    expect(voiceRequests).toBe(0);
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
  await expect(page.locator('#voice-agent')).toHaveAttribute('title', '旅遊規劃專員');
  release();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#voice-agent')).toContainText('已完成');
});

test('session facts follow server responses, language changes and reset without persisting memory', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#message').fill('從桃園到成田，2026-11-12，2 人，經濟艙，少步行，請規劃行程');
  await page.locator('#send').click();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#session-facts')).toContainText('TPE');
  await expect(page.locator('#session-facts')).toContainText('NRT');
  await expect(page.locator('#session-facts')).toContainText('2026-11-12');
  await expect(page.locator('#session-facts')).toContainText('經濟艙');
  await page.locator('#language').selectOption('en-US');
  await expect(page.locator('#session-facts')).toContainText('Economy');
  await expect(page.locator('#session-facts')).toContainText('Low walking preferred');
  await expect(page.locator('#session-context')).toContainText('Long-term memory not enabled');
  await page.locator('#new-trip').click();
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#session-facts')).not.toContainText('2026-11-12');
  await expect(page.locator('#session-facts')).toContainText('Not provided yet');
});
