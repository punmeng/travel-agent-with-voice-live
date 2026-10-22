import { test, expect } from '@playwright/test';

for (const trigger of ['manual', 'vad']) {
test(`direct Speech ${trigger} finish; half-duplex pauses uploads until playback ends and cleans up`, async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.voice = { available: true, modes: { 'speech-direct': { available: true } } };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/voice/session', route => {
    expect(route.request().postDataJSON().mode).toBe('speech-direct');
    return route.fulfill({ json: { path: '/api/voice/stream', protocol: 'journey-voice', nonce: 'a'.repeat(64) } });
  });
  await page.addInitScript(() => {
    const Audio = window.AudioContext;
    window.__tracks = []; window.__contexts = []; window.__micCalls = 0;
    window.AudioContext = class extends Audio {
      constructor(options) { super(options); window.__contexts.push(this); }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__micCalls++;
      const stream = window.__contexts[0].createMediaStreamDestination().stream;
      window.__tracks.push(...stream.getTracks()); return stream;
    };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = []; binarySent = 0;
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready', mode: 'speech-direct' }), 20); }
      receive(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
      send(event) { if (typeof event === 'string') this.sent.push(JSON.parse(event)); else this.binarySent++; }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click();
  expect(await page.locator('#voice-mode option').evaluateAll(options => options.map(option => option.value))).toEqual([
    'voice-live', 'voice-realtime', 'gpt-live', 'speech-direct'
  ]);
  await page.locator('#voice-mode').selectOption('speech-direct');
  await expect(page.locator('#voice-comparison')).toContainText('完全不使用Voice Live');
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await expect(page.locator('#voice-finish')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.__socket.binarySent)).toBeGreaterThan(0);
  if (trigger === 'manual') {
    await page.locator('#voice-finish').click();
    await expect.poll(() => page.evaluate(() => window.__socket.sent.filter(event => event.type === 'finish').length)).toBe(1);
  } else {
    await page.evaluate(() => window.__socket.receive({ type: 'state', state: 'thinking' }));
    expect(await page.evaluate(() => window.__socket.sent.filter(event => event.type === 'finish').length)).toBe(0);
  }
  await expect(page.locator('#voice-status')).toContainText('思考中');
  await expect(page.locator('#voice-finish')).toBeDisabled();
  const sent = await page.evaluate(() => window.__socket.binarySent);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__socket.binarySent)).toBe(sent);
  await page.evaluate(async () => {
    const state = (await (await fetch('/api/bootstrap')).json()).state;
    window.__socket.receive({ type: 'transcript', text: '東京兩位', turnId: 'speech-test' });
    window.__socket.receive({ type: 'progress', turnId: 'speech-test', role: 'flight' });
    window.__socket.receive({ type: 'result', turnId: 'speech-test', result: {
      text: '測試的模擬航班。', state: { ...state, activeAgent: 'flight' }, trace: [], correlationId: 'offline'
    } });
    for (const [stage, elapsedMs] of [['input_end', 100], ['backend_dispatch', 200], ['backend_result', 500], ['first_audio', 900]]) {
      window.__socket.receive({ type: 'measurement', mode: 'speech-direct', turn: 1, stage, elapsedMs });
    }
  });
  await expect(page.locator('#messages')).toContainText('東京兩位');
  await expect(page.locator('#voice-metrics')).toContainText('300 ms');
  await expect(page.locator('#voice-metrics')).toContainText('400 ms');
  await page.evaluate(audio => {
    window.__socket.receive({ type: 'audio', audio });
    window.__socket.receive({ type: 'audioDone' });
  }, Buffer.alloc(24000).toString('base64'));
  await expect(page.locator('#voice-status')).toContainText('半雙工');
  await expect.poll(() => page.evaluate(() => window.__socket.sent.filter(event => event.type === 'resume').length)).toBe(1);
  await expect(page.locator('#voice-finish')).toBeEnabled();
  await page.locator('#voice-mute').click();
  await expect(page.locator('#voice-finish')).toBeDisabled();
  await page.locator('#voice-mute').click();
  await expect(page.locator('#voice-finish')).toBeEnabled();
  await page.evaluate(() => { window.__oldSocket = window.__socket; });
  await page.locator('#voice-stop').click();
  expect(await page.evaluate(() => window.__tracks.every(track => track.readyState === 'ended'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__contexts.every(context => context.state === 'closed'))).toBe(true);
  await expect(page.locator('#voice-finish')).toBeDisabled();
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.evaluate(() => window.__oldSocket.receive({ type: 'state', state: 'thinking' }));
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.locator('#voice-stop').click();
});
}

for (const configuredModel of ['gpt-realtime', null]) {
test(`Realtime2.1 comparison refuses old/missing model metadata (${configuredModel}) before microphone`, async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.voice = { available: true, modes: { 'voice-realtime': { available: true, configuredModel, requiredModel: 'gpt-realtime-2.1' } } };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    window.__micCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__micCalls++; throw new Error('must not run'); };
  });
  await page.goto('/'); await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption('voice-realtime');
  await expect(page.locator('#voice-start')).toBeDisabled();
  await expect(page.locator('#voice-availability')).toContainText(configuredModel ?? '舊版服務');
  expect(await page.evaluate(() => window.__micCalls)).toBe(0);
});
}
