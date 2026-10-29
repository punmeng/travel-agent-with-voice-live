import { test, expect } from '@playwright/test';
import { candidateAssets } from './candidate-assets.js';

async function setup(page) {
  await candidateAssets(page);
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.voice = { available: true, modes: Object.fromEntries(
      ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct'].map(mode =>
        [mode, { available: true, advancedSettings: true, sttModes: ['rest', 'sdk'],
          requiredModel: 'gpt-realtime-2.1', configuredModel: 'gpt-realtime-2.1' }])) };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/voice/session', route => {
    return route.fulfill({ json: { protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream' } });
  });
  await page.addInitScript(() => {
    const Audio = window.AudioContext, Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet {
      constructor(...args) { super(...args); window.__processor = this; }
    };
    window.AudioContext = class extends Audio {
      constructor(options) { super(options); window.__context = this; }
    };
    navigator.mediaDevices.getUserMedia = async () => window.__context.createMediaStreamDestination().stream;
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; controls = []; packets = [];
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready' }), 20); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) { if (typeof data === 'string') this.controls.push(JSON.parse(data)); else this.packets.push(data.byteLength); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click();
  await page.locator('.voice-settings > summary').click();
  await expect(page.locator('#voice-advanced')).toBeVisible();
  await expect(page.locator('#voice-advanced')).not.toHaveAttribute('open', '');
  await page.locator('#voice-advanced > summary').click();
}
const start = async page => {
  const request = page.waitForRequest('**/api/voice/session');
  await page.locator('#voice-start').click();
  const body = (await request).postDataJSON();
  await expect(page.locator('#voice-status')).toContainText(/聆聽中|Listening/);
  return body;
};

for (const width of [1440, 390, 320]) {
  test(`advanced settings are mode-scoped, collapsed, responsive and connection-frozen (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await setup(page);
    await page.locator('#voice-live-vad-silence').selectOption('1200');
    await page.locator('#voice-live-phrase-list').fill('桃園\n松山');
    await page.locator('#voice-live-noise-reduction').uncheck();
    const live = await start(page);
    expect(live.voiceOptions).toEqual({ 'voice-live': {
      vadSilenceMs: 1200, phraseList: ['桃園', '松山'], noiseReduction: false, echoCancellation: true
    } });
    expect(await page.locator('#voice-advanced input, #voice-advanced select, #voice-advanced textarea, #voice-advanced button')
      .evaluateAll(fields => fields.every(field => field.disabled))).toBe(true);
    await page.locator('#voice-stop').click();
    await expect(page.locator('#voice-live-vad-silence')).toBeEnabled();
    await page.locator('#voice-mode').selectOption('voice-realtime');
    await expect(page.locator('#voice-live-phrase-list')).toBeHidden();
    await expect(page.locator('#voice-realtime-vad-silence')).toHaveValue('800');
    const realtime = await start(page);
    expect(realtime.voiceOptions).toEqual({ 'voice-realtime': {
      vadSilenceMs: 800, noiseReduction: true, echoCancellation: true
    } });
    await page.locator('#voice-stop').click();
    await page.locator('#voice-mode').selectOption('gpt-live');
    await expect(page.locator('#voice-advanced')).toContainText('其他音色尚未核實');
    await expect(page.locator('#voice-realtime-vad-silence')).toBeHidden();
    const sharedLanguage = await page.locator('#language').count();
    if (sharedLanguage) {
      await expect(page.locator('#gpt-live-language')).toBeDisabled();
      await expect(page.locator('#gpt-live-language')).toHaveValue('zh-TW');
      await page.locator('#language').selectOption('en-US');
      await expect(page.locator('#gpt-live-language')).toHaveValue('en-US');
    } else await page.locator('#gpt-live-language').selectOption('en-US');
    await page.locator('#gpt-live-style').selectOption('professional');
    expect((await start(page)).voiceOptions).toEqual({ 'gpt-live': {
      language: 'en-US', taiwanWording: true, style: 'professional', voice: 'marin'
    } });
    await page.locator('#voice-stop').click();
    if (sharedLanguage) await page.locator('#language').selectOption('zh-TW');
    await page.locator('#voice-mode').selectOption('voice-live');
    await expect(page.locator('#voice-live-vad-silence')).toHaveValue('1200');
    await page.locator('.voice-advanced-reset').click();
    await expect(page.locator('#voice-live-vad-silence')).toHaveValue('800');
    await expect(page.locator('#voice-live-phrase-list')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const rate of [8000, 16000]) test(`SDK ms controls use real ${rate}Hz WAV header and preserve legacy default byte size`, async ({ page }) => {
  await setup(page);
  // Invalid hidden live settings cannot block a different mode.
  await page.locator('#voice-live-phrase-list').fill('x'.repeat(101));
  await page.locator('#voice-mode').selectOption('speech-direct');
  await page.locator('#speech-rest-vad-silence').selectOption('1500');
  expect((await start(page)).voiceOptions).toEqual({ 'speech-direct': { rest: { vadSilenceMs: 1500 } } });
  await page.locator('#voice-stop').click();
  await page.locator('#speech-stt').selectOption('sdk');
  await page.locator('#speech-source').selectOption('wav');
  const buffer = Buffer.alloc(44 + rate * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(rate * 2, 40);
  await page.locator('#speech-wav').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer });
  const body = await start(page);
  expect(body.speechInput.sampleRate).toBe(rate);
  expect(body.speechInput.chunkBytes).toBe(1280);
  expect(body.voiceOptions['speech-direct'].sdk.chunkMs).toBe(rate === 8000 ? 80 : 40);
  await page.locator('#voice-stop').click();
  await page.locator('#speech-chunk').selectOption('20');
  expect((await start(page)).speechInput.chunkBytes).toBe(rate * 20 / 1000 * 2);
  await page.locator('#voice-stop').click();
});

test('task validation errors keep the connection open and stale audioDone never drains a newer turn', async ({ page }) => {
  await setup(page); await start(page);
  await page.evaluate(() => {
    window.__socket.receive({ type: 'transcript', turnId: 'invalid', text: '測試無效需求' });
    window.__socket.receive({ type: 'taskError', turnId: 'invalid', message: '請重說完整需求。' });
  });
  await expect(page.locator('#voice-status')).toContainText('請重說完整需求');
  expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
  await page.evaluate(() => {
    window.__socket.receive({ type: 'transcript', turnId: 'next', text: '東京' });
    window.__socket.receive({ type: 'state', state: 'thinking' });
    window.__socket.receive({ type: 'audioDone', turnId: 'invalid' });
  });
  await expect(page.locator('#voice-status')).toContainText('思考中');
  await page.locator('#voice-stop').click();
});
