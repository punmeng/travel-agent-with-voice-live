import { test, expect } from '@playwright/test';

test('pre-session selector omits internal exposition and unavailable modes cannot request microphone or a ticket', async ({ page }) => {
  let tickets = 0;
  await page.route('**/api/voice/session', async route => { tickets++; await route.abort(); });
  await page.addInitScript(() => {
    window.__micCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__micCalls++; throw new Error('must not run'); };
  });
  await page.goto('/');
  await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption('gpt-live');
  await expect(page.locator('#voice-title')).toHaveText('GPT-Live · gpt-live-1');
  await expect(page.locator('#voice-comparison')).toHaveCount(0);
  await expect(page.locator('#voice-dialog')).not.toContainText('管線說明');
  await expect(page.locator('#voice-dialog')).not.toContainText('尚未驗證');
  await expect(page.locator('#voice-dialog')).not.toContainText('非品質排名');
  await expect(page.locator('#voice-availability')).toContainText('尚未啟用');
  await expect(page.locator('#voice-start')).toBeDisabled();
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
  expect(tickets).toBe(0);
  await page.locator('#voice-mode').selectOption('voice-live');
  await expect(page.locator('#voice-comparison')).toHaveCount(0);
  for (const mode of ['voice-realtime', 'speech-direct']) {
    await page.locator('#voice-mode').selectOption(mode);
    await expect(page.locator('#voice-start')).toBeDisabled();
    await expect(page.locator('#voice-availability')).toContainText('尚未啟用');
  }
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
  expect(tickets).toBe(0);
});

for (const timing of ['server-timed', 'pcm-contiguous']) {
test(`configured GPT-Live uses selected ticket, captions, ${timing} audio, read-only delegation and cleanup`, async ({ page }) => {
  let ticketMode;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), data = await response.json();
    data.voice = { available: true, type: 'azure-personal', modes: {
      'voice-live': { available: true }, 'gpt-live': { available: true }
    } };
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/voice/session', async route => {
    ticketMode = route.request().postDataJSON().mode;
    await route.fulfill({ json: { path: '/api/voice/stream', protocol: 'journey-voice', nonce: 'a'.repeat(64) } });
  });
  await page.addInitScript(() => {
    const Audio = window.AudioContext;
    window.__tracks = []; window.__contexts = []; window.__schedules = [];
    window.AudioContext = class extends Audio {
      constructor(options) { super(options); window.__contexts.push(this); }
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source);
        source.start = when => { window.__schedules.push(when); start(when); };
        return source;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = window.__contexts[0].createMediaStreamDestination().stream;
      window.__tracks.push(...stream.getTracks()); return stream;
    };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = []; binarySent = 0;
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready', mode: 'gpt-live' }), 20); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) { if (typeof data === 'string') this.sent.push(JSON.parse(data)); else this.binarySent++; }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/'); await page.locator('#voice').click();
  await expect(page.locator('#voice-mode option[value="voice-live"]')).toHaveText('1 · Voice Live · GPT-5.4 + Personal Voice');
  await page.locator('#voice-mode').selectOption('gpt-live');
  await expect(page.locator('#voice-availability')).toBeHidden();
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  expect(ticketMode).toBe('gpt-live');
  await expect(page.locator('#voice-mode')).toBeDisabled();
  await page.evaluate(async timing => {
    const s = window.__socket;
    s.receive({ type: 'liveCaption', speaker: 'assistant', text: '您好' });
    s.receive({ type: 'transcript', text: '東京五天', turnId: 'task_1' });
    s.receive({ type: 'progress', turnId: 'task_1', role: 'planner' });
    const state = (await (await fetch('/api/bootstrap')).json()).state;
    s.receive({ type: 'result', turnId: 'task_1', result: { text: '五天行程，請以畫面為準。', state: { ...state, activeAgent: 'planner' } } });
    const audio = btoa(String.fromCharCode(...new Uint8Array(4800)));
    if (timing === 'pcm-contiguous') {
      s.receive({ type: 'compatibility', audioTiming: timing, message: '服務未提供音訊時間戳，改用PCM連續播放。' });
      s.receive({ type: 'audio', audio, timing });
      s.receive({ type: 'audio', audio, timing });
    } else {
      s.receive({ type: 'audio', audio, startMs: 1000, endMs: 1100 });
      s.receive({ type: 'audio', audio, startMs: 1200, endMs: 1300 });
    }
  }, timing);
  await expect(page.locator('#voice-caption')).toContainText('語音字幕');
  await expect(page.locator('#messages')).toContainText('請以畫面為準');
  await expect(page.locator('#voice-agent')).toContainText('旅遊規劃');
  const schedules = await page.evaluate(() => window.__schedules);
  expect(schedules.length).toBe(2);
  expect(schedules[1] - schedules[0]).toBeCloseTo(timing === 'pcm-contiguous' ? 0.1 : 0.2, 2);
  await expect(page.locator('#voice-availability')).toBeHidden();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.evaluate(() => window.__socket.receive({ type: 'taskError', turnId: 'unlocated_task', message: '未取得完整可定位的委派轉錄。' }));
  await expect(page.locator('#voice-status')).toContainText('未取得完整');
  await expect(page.locator('#voice-agent')).toContainText('旅遊規劃');
  await page.evaluate(() => window.__socket.receive({ type: 'taskError', turnId: 'task_1', message: '請停止後用文字完成交易。' }));
  await expect(page.locator('#voice-status')).toContainText('用文字完成');
  await expect(page.locator('#voice-agent')).toHaveText('等待對話');
  await page.locator('#voice-mute').click();
  expect(await page.evaluate(() => window.__socket.sent.some(e => e.type === 'mute' && e.muted))).toBe(true);
  await page.locator('#voice-stop').click();
  await expect(page.locator('#voice-mode')).toBeEnabled();
  await expect(page.locator('#voice-caption')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__tracks.every(t => t.readyState === 'ended'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__contexts.every(c => c.state === 'closed'))).toBe(true);
});
}
