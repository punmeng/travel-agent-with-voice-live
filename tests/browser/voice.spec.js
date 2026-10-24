import { test, expect } from '@playwright/test';

async function enabled(page, mode) {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), data = await response.json();
    data.voice = { available: true, message: 'Voice Live test transport' };
    if (mode) data.voice.modes = { [mode]: { available: true,
      requiredModel: 'gpt-realtime-2.1', configuredModel: 'gpt-realtime-2.1' } };
    await route.fulfill({ response, json: data });
  });
}
for (const mode of [undefined, 'voice-realtime']) {
test(`microphone user gesture, transcript rendering, mute, stop and track/context/socket cleanup (${mode ?? 'legacy'})`, async ({ page }) => {
  await enabled(page, mode);
  await page.route('**/api/voice/session', route => {
    expect(route.request().postDataJSON().mode).toBe(mode);
    return route.fulfill({ json: {
    path: '/api/voice/stream', protocol: 'journey-voice', nonce: 'a'.repeat(64)
  } }); });
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.__voiceContexts = []; window.__voiceTracks = []; window.__microphoneCalls = 0; window.__stoppedPlayback = 0;
    window.AudioContext = class extends NativeContext {
      constructor(options) { super(options); window.__voiceContexts.push(this); }
      createBufferSource() {
        const node = super.createBufferSource(), stop = node.stop.bind(node);
        node.stop = (...args) => { window.__stoppedPlayback++; return stop(...args); };
        return node;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__microphoneCalls++;
      const context = window.__voiceContexts[0];
      const stream = context.createMediaStreamDestination().stream;
      window.__voiceTracks.push(...stream.getTracks());
      return stream;
    };
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      sent = [];
      binarySent = 0;
      constructor(url, protocols) {
        this.url = url; this.protocols = protocols; window.__voiceSocket = this;
        setTimeout(() => this.receive({ type: 'ready' }), 30);
      }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) { if (typeof data === 'string') this.sent.push(JSON.parse(data)); else this.binarySent++; }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click();
  await expect(page.locator('#voice-mode option')).toHaveCount(4);
  if (mode) await page.locator('#voice-mode').selectOption(mode);
  await expect(page.locator('#voice-agent')).toHaveText('等待對話');
  expect(await page.evaluate(() => window.__microphoneCalls)).toBe(0);
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await expect(page.locator('#message')).toBeDisabled();
  await page.evaluate(() => window.__voiceSocket.receive({ type: 'state', state: 'thinking' }));
  const beforeThinking = await page.evaluate(() => window.__voiceSocket.binarySent);
  await expect.poll(() => page.evaluate(() => window.__voiceSocket.binarySent)).toBeGreaterThan(beforeThinking);
  await page.clock.install();
  await page.evaluate(async () => {
    window.__voiceSocket.receive({ type: 'transcript', text: '我想去日本玩幾天', turnId: 'synthetic-ui' });
    window.__voiceSocket.receive({ type: 'state', state: 'thinking' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'synthetic-ui', role: 'intent' });
  });
  await expect(page.locator('#voice-agent')).toHaveText('意圖協調 · 處理中');
  await page.evaluate(() => {
    window.__voiceSocket.receive({ type: 'progress', turnId: 'synthetic-ui', role: 'flight' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'old-turn', role: 'price' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'synthetic-ui', role: 'Voice Live' });
  });
  await expect(page.locator('#voice-agent')).toHaveText('航班查詢 · 處理中');
  await page.clock.fastForward(15001);
  await expect(page.locator('#voice-status')).toContainText('我還在查詢，請稍等一下');
  await page.evaluate(async () => {
    const state = (await (await fetch('/api/bootstrap')).json()).state;
    window.__voiceSocket.receive({ type: 'result', turnId: 'synthetic-ui', result: {
      state: { ...state, activeAgent: 'flight' }, text: '可以呀，想賞楓還是吃美食？', trace: [], correlationId: 'synthetic-ui'
    } });
  });
  await expect(page.locator('#messages')).toContainText('我想去日本玩幾天');
  await expect(page.locator('#messages')).toContainText('想賞楓還是吃美食');
  await expect(page.locator('#voice-agent')).toHaveText('航班查詢 · 已完成');
  expect(await page.evaluate(() => window.__voiceSocket.sent.some(e => e.type === 'displayed'))).toBe(true);
  await page.evaluate(audio => {
    window.__voiceSocket.receive({ type: 'audio', audio });
    window.__voiceSocket.receive({ type: 'interrupted' });
    window.__voiceSocket.receive({ type: 'superseded', turnId: 'synthetic-ui' });
  }, Buffer.alloc(96000).toString('base64'));
  expect(await page.evaluate(() => window.__stoppedPlayback)).toBe(2);
  await expect(page.locator('#messages')).toContainText('已由後續更正取代');
  await expect(page.locator('#voice-status')).toContainText('已收到更正');
  await page.evaluate(() => {
    window.__voiceSocket.receive({ type: 'transcript', text: '改成大阪', turnId: 'new-ui' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'new-ui', role: 'planner' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'synthetic-ui', role: 'price' });
    window.__voiceSocket.receive({ type: 'superseded', turnId: 'synthetic-ui' });
    window.__voiceSocket.receive({ type: 'audioDone' });
  });
  await expect(page.locator('#voice-agent')).toHaveText('旅遊規劃 · 處理中');
  await page.locator('#voice-mute').click();
  await expect(page.locator('#voice-mute')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__voiceTracks.every(t => !t.enabled))).toBe(true);
  await page.evaluate(() => window.__voiceSocket.receive({ type: 'interrupted' }));
  await page.locator('#voice-mute').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await expect(page.locator('#voice-mute')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.__voiceTracks.every(t => t.enabled))).toBe(true);
  await page.locator('#voice-stop').click();
  await expect(page.locator('#voice-status')).toContainText('已停止收音');
  await expect(page.locator('#voice-agent')).toHaveText('等待對話');
  await page.clock.fastForward(16000);
  await expect(page.locator('#voice-status')).not.toContainText('我還在查詢');
  await expect(page.locator('#message')).toBeEnabled();
  expect(await page.evaluate(() => window.__voiceTracks.every(t => t.readyState === 'ended'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__voiceContexts.every(c => c.state === 'closed'))).toBe(true);
  expect(await page.evaluate(() => window.__voiceSocket.readyState)).toBe(3);
  await page.locator('#voice-start').click();
  await page.clock.fastForward(100);
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.evaluate(() => {
    window.__voiceSocket.receive({ type: 'transcript', text: '測試錯誤狀態', turnId: 'error-ui' });
    window.__voiceSocket.receive({ type: 'progress', turnId: 'error-ui', role: 'price' });
  });
  await expect(page.locator('#voice-agent')).toHaveText('票價與購買 · 處理中');
  await page.evaluate(() => window.__voiceSocket.receive({ type: 'error', message: '測試連線錯誤', code: 'TEST', correlationId: 'offline' }));
  await expect(page.locator('#voice-agent')).toHaveText('等待對話');
  await page.locator('#voice-start').click();
  await page.clock.fastForward(100);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#voice-status')).toContainText('已停止收音');
  expect(await page.evaluate(() => window.__voiceTracks.every(t => t.readyState === 'ended'))).toBe(true);
});
}
test('microphone denial is explicit and cleanup restores text; no browser speech substitute', async ({ page }) => {
  await enabled(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click(); await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('麥克風權限被拒絕');
  await expect(page.locator('#message')).toBeEnabled();
  await expect(page.locator('#voice-stop')).toBeDisabled();
  await expect(page.locator('#voice-start')).toBeEnabled();
});
test('voice retry waits for an unfinished server turn before requesting microphone; stop cancels only local waiting', async ({ page }) => {
  let pending = false;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), data = await response.json();
    data.voice = { available: true, message: 'DEMO mock' }; data.pending = pending;
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    window.__microphoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__microphoneCalls++; throw new DOMException('denied', 'NotAllowedError');
    };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click();
  pending = true;
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('等待上一段完成');
  expect(await page.evaluate(() => window.__microphoneCalls)).toBe(0);
  await page.locator('#voice-stop').click();
  await expect(page.locator('#voice-status')).toContainText('已停止收音');
  expect(pending).toBe(true);
  pending = false;
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('麥克風權限被拒絕');
  expect(await page.evaluate(() => window.__microphoneCalls)).toBe(1);
  await expect(page.locator('#voice-start')).toBeEnabled();
});
