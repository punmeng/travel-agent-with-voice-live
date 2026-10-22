import { test, expect } from '@playwright/test';

function wav(rate) {
  const buffer = Buffer.alloc(44 + rate * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(rate * 2, 40); return buffer;
}
async function sdkPage(page) {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.voice = { available: true, modes: { 'speech-direct': { available: true, sttModes: ['rest', 'sdk'] } } };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    window.__microphoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__microphoneCalls++; throw new Error('must not request mic for WAV'); };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; packets = []; controls = [];
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready' }), 20); }
      send(data) { if (typeof data === 'string') this.controls.push(JSON.parse(data)); else this.packets.push({ size: data.byteLength, at: performance.now() }); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#voice').click(); await page.locator('#voice-mode').selectOption('speech-direct');
  await expect(page.locator('#speech-stt')).toHaveValue('rest');
  await expect(page.locator('#voice-finish')).not.toHaveAttribute('hidden');
  await page.locator('#speech-stt').selectOption('sdk');
  await expect(page.locator('#voice-finish')).toBeHidden();
  await page.locator('#speech-source').selectOption('wav');
}
for (const rate of [8000, 16000]) {
  test(`SDK streams ${rate}Hz WAV at real-time pace with no microphone, shows all finals and pauses for half-duplex`, async ({ page }) => {
    let input;
    await page.route('**/api/voice/session', route => {
      input = route.request().postDataJSON().speechInput;
      return route.fulfill({ json: { protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream' } });
    });
    await sdkPage(page);
    await page.locator('#speech-silence').selectOption('1000');
    await page.locator('#speech-phrases').fill('梅好\n桃園');
    await page.locator('#speech-wav').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav(rate) });
    await page.locator('#voice-start').click();
    await expect.poll(() => page.evaluate(() => window.__socket?.packets.length ?? 0)).toBeGreaterThan(0);
    expect(input).toEqual({ stt: 'sdk', source: 'wav', sampleRate: rate, silenceMs: 1000, phrases: ['梅好', '桃園'], chunkBytes: 1280 });
    await page.evaluate(() => {
      window.__socket.receive({ type: 'asr', kind: 'recognizing', text: '東', sequence: 1, elapsedMs: 20 });
      window.__socket.receive({ type: 'state', state: 'thinking' });
      for (const [sequence, text] of [[1, '東京'], [2, '兩位']]) {
        window.__socket.receive({ type: 'asr', kind: 'recognized', text, sequence, elapsedMs: 100, offsetMs: 0, durationMs: 500 });
      }
    });
    await expect(page.locator('#speech-finals li')).toHaveCount(2);
    await expect(page.locator('#speech-finals')).toContainText('offset 0 ms · duration 500 ms');
    const count = await page.evaluate(() => window.__socket.packets.length);
    await page.waitForTimeout(160);
    expect(await page.evaluate(() => window.__socket.packets.length)).toBe(count);
    await page.evaluate(() => window.__socket.receive({ type: 'state', state: 'listening' }));
    await expect.poll(() => page.evaluate(() => window.__socket.controls.some(e => e.type === 'input_eof')), { timeout: 5000 }).toBe(true);
    const packets = await page.evaluate(() => window.__socket.packets);
    expect(packets.slice(0, -1).every(p => p.size === 1280)).toBe(true);
    expect(packets.reduce((sum, packet) => sum + packet.size, 0)).toBe(rate * 2);
    expect(packets.at(-1).at - packets[0].at).toBeGreaterThan(850);
    await page.evaluate(() => window.__socket.receive({ type: 'asr', kind: 'session_stopped', elapsedMs: 1400 }));
    await expect(page.locator('#speech-finals li')).toHaveCount(2);
    expect(await page.evaluate(() => window.__microphoneCalls)).toBe(0);
    await page.locator('#voice-stop').click();
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(3);
    await expect(page.locator('#speech-finals li')).toHaveCount(2);
  });
}
test('invalid SDK WAV is rejected before microphone, ticket or cloud and REST remains selectable', async ({ page }) => {
  let tickets = 0;
  await page.route('**/api/voice/session', route => { tickets++; return route.abort(); });
  await sdkPage(page);
  const bad = wav(8000); bad.writeUInt16LE(2, 22);
  await page.locator('#speech-wav').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: bad });
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('僅接受');
  expect(tickets).toBe(0);
  expect(await page.evaluate(() => window.__microphoneCalls)).toBe(0);
  await page.locator('#speech-stt').selectOption('rest');
  await expect(page.locator('#speech-sdk-options')).toBeHidden();
  await expect(page.locator('#voice-finish')).not.toHaveAttribute('hidden');
});
test('stopping WAV replay cancels its producer and ignores stale recognition events', async ({ page }) => {
  await page.route('**/api/voice/session', route => route.fulfill({ json: {
    protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream'
  } }));
  await sdkPage(page);
  await page.locator('#speech-wav').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav(8000) });
  await page.locator('#voice-start').click();
  await expect.poll(() => page.evaluate(() => window.__socket?.packets.length ?? 0)).toBeGreaterThan(0);
  await page.locator('#voice-stop').click();
  const count = await page.evaluate(() => window.__socket.packets.length);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.__socket.packets.length)).toBe(count);
  expect(await page.evaluate(() => window.__socket.controls.some(e => e.type === 'input_eof'))).toBe(false);
  await page.evaluate(() => window.__socket.receive({ type: 'asr', kind: 'recognized', text: 'stale', sequence: 1, elapsedMs: 100, offsetMs: 0, durationMs: 100 }));
  await expect(page.locator('#speech-finals li')).toHaveCount(0);
});
test('SDK microphone uses 16kHz fixed packets, pauses during half-duplex and never submits REST finish', async ({ page }) => {
  await sdkPage(page);
  await page.locator('#speech-source').selectOption('microphone');
  await page.evaluate(() => {
    const Audio = window.AudioContext;
    window.AudioContext = class extends Audio {
      constructor(options) { super(options); window.__audio = this; }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__microphoneCalls++;
      const stream = window.__audio.createMediaStreamDestination().stream;
      window.__tracks = stream.getTracks(); return stream;
    };
  });
  let input;
  await page.route('**/api/voice/session', route => {
    input = route.request().postDataJSON().speechInput;
    return route.fulfill({ json: { protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream' } });
  });
  await page.locator('#voice-start').click();
  await expect.poll(() => page.evaluate(() => window.__socket?.packets.length ?? 0)).toBeGreaterThan(0);
  expect(input.sampleRate).toBe(16000);
  expect(await page.evaluate(() => window.__socket.packets.every(p => p.size === 1280))).toBe(true);
  await page.evaluate(() => window.__socket.receive({ type: 'state', state: 'thinking' }));
  const count = await page.evaluate(() => window.__socket.packets.length);
  await page.waitForTimeout(160);
  expect(await page.evaluate(() => window.__socket.packets.length)).toBe(count);
  await page.evaluate(() => window.__socket.receive({ type: 'state', state: 'listening' }));
  await expect.poll(() => page.evaluate(() => window.__socket.packets.length)).toBeGreaterThan(count);
  await page.locator('#voice-mute').click();
  expect(await page.evaluate(() => window.__tracks.every(t => !t.enabled))).toBe(true);
  await page.locator('#voice-stop').click();
  expect(await page.evaluate(() => window.__tracks.every(t => t.readyState === 'ended'))).toBe(true);
  expect(await page.evaluate(() => window.__socket.controls.some(e => e.type === 'finish'))).toBe(false);
});
