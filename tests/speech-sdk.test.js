import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechRecognition, speechInputSchema } from '../lib/speech-sdk.js';
import { mockSpeechSdk } from './mock-speech-sdk.js';
import { readPcmWav, replayPcm, resampleMicrophone } from '../public/speech-input.js';

const config = { endpoint: 'https://offline.cognitiveservices.azure.com', resourceId: '/private-resource' };
const options = speechInputSchema.parse({ stt: 'sdk', sampleRate: 8000, phrases: ['梅好 Airlines', '梅好 Airlines'], silenceMs: 700 });
function setup(extra = {}) {
  const mock = mockSpeechSdk(), events = [], finals = [], failures = [];
  const adapter = createSpeechRecognition(config, options, {
    credential: { getToken: async () => ({ token: 'private-token' }) }, sdk: mock.sdk,
    onEvent: event => events.push(event), onFinal: final => finals.push(final),
    onFailure: code => failures.push(code), ...extra
  });
  return { ...mock, events, finals, failures, adapter };
}

test('Speech SDK input contract rejects transport/auth overrides, bad segmentation/PCM/phrase settings', () => {
  assert.equal(speechInputSchema.parse({}).stt, 'rest');
  for (const bad of [{ endpoint: 'https://evil.invalid' }, { stt: 'sdk', sampleRate: 24000 },
    { stt: 'sdk', silenceMs: 701 }, { stt: 'sdk', chunkBytes: 1281 },
    { stt: 'sdk', phrases: ['x'.repeat(101)] }, { stt: 'sdk', phrases: Array(101).fill('x') },
    { stt: 'rest', source: 'wav' }, { stt: 'rest', phrases: ['梅好 Airlines'] }]) {
    assert.throws(() => speechInputSchema.parse(bad));
  }
});
test('continuous recognizer uses exact endpoint, private Entra auth, PCM format, zh-TW, silence and deduplicated phrases', async () => {
  const t = setup();
  try {
    await t.adapter.start();
    assert.equal(t.configs[0].endpoint.href, 'wss://offline.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1');
    assert.equal(t.configs[0].authorizationToken, 'aad#/private-resource#private-token');
    assert.equal(t.configs[0].speechRecognitionLanguage, 'zh-TW');
    assert.equal(t.configs[0].properties.silence, '700');
    assert.deepEqual(t.streams[0].format, { rate: 8000, bits: 16, channels: 1 });
    assert.equal(t.sdk.SpeechRecognizer.telemetry, false);
    assert.deepEqual(t.instances[0].phrases, ['梅好 Airlines']);
    const pooled = Buffer.from([99, 99, 1, 2, 3, 4, 99]);
    t.adapter.write(pooled.subarray(2, 6));
    assert.deepEqual([...new Uint8Array(t.streams[0].packets[0])], [1, 2, 3, 4]);
    const r = t.instances[0];
    r.recognizing(null, { result: { text: '東' } });
    for (const [text, offset] of [['東京', 0], ['兩位', 10000000]]) {
      r.recognized(null, { result: { reason: 3, text, offset, duration: 5000000 } });
    }
    r.recognized(null, { result: { reason: 0 } });
    assert.deepEqual(t.finals.map(f => [f.text, f.offsetMs, f.durationMs]), [['東京', 0, 500], ['兩位', 1000, 500]]);
    t.adapter.finishInput();
    r.sessionStopped();
    assert.equal(t.finals.length, 2, 'session_stopped never creates an utterance');
    assert.equal(t.events.at(-1).kind, 'session_stopped');
    assert.deepEqual(t.failures, []);
    assert.ok(!JSON.stringify(t.events).includes('private'));
    assert.throws(() => t.adapter.write(Buffer.alloc(2)), /不再接收/);
  } finally { t.adapter.close(); }
  assert.equal(t.instances[0].closed, true);
  assert.equal(t.streams[0].closed, true);
});
test('SDK cancellation is sanitized, no fallback; unexpected stopped fails without a made-up final', async () => {
  for (const event of ['canceled', 'sessionStopped']) {
    const t = setup();
    try {
      await t.adapter.start();
      t.instances[0][event](null, { reason: 1, errorDetails: 'private-resource/token/transcript' });
      assert.equal(t.failures.length, 1);
      assert.equal(t.finals.length, 0);
      assert.ok(!JSON.stringify([...t.events, ...t.failures]).includes('private'));
    } finally { t.adapter.close(); }
  }
});
test('stop during Entra acquisition prevents stale recognizer startup', async () => {
  let release;
  const t = setup({ credential: { getToken: () => new Promise(resolve => { release = resolve; }) } });
  const starting = t.adapter.start();
  t.adapter.close(); release({ token: 'private' }); await starting;
  assert.equal(t.instances.length, 0);
  assert.equal(t.events.length, 0);
});
test('SDK updates recognizer authorization before expiry and refuses invalid result shape/timing', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let tokens = 0;
  const t = setup({ credential: { getToken: async () => ({ token: `token-${++tokens}` }) } });
  try {
    await t.adapter.start();
    context.mock.timers.tick(8 * 60 * 1000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(t.instances[0].authorizationToken, 'aad#/private-resource#token-2');
    const r = t.instances[0];
    r.recognized(null, { result: { resultId: 'same', text: '東京', reason: 3, offset: 0, duration: 10000 } });
    r.recognized(null, { result: { resultId: 'same', text: '東京', reason: 3, offset: 0, duration: 10000 } });
    assert.equal(t.finals.length, 1);
    r.recognized(null, { result: { text: '東京', reason: 3, offset: -1, duration: 10000 } });
    assert.equal(t.failures.at(-1), 'SPEECH_SDK_TIMING');
  } finally { t.adapter.close(); }
});

export function wav(rate = 8000, samples = 800) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return Uint8Array.from(bytes).buffer;
}
test('WAV replay accepts 8/16 kHz mono PCM16 only and validates before any recognizer or permission request', () => {
  for (const rate of [8000, 16000]) assert.equal(readPcmWav(wav(rate)).sampleRate, rate);
  for (const [offset, value, width] of [[20, 3, 2], [22, 2, 2], [34, 8, 2], [24, 24000, 4], [4, 9999999, 4]]) {
    const bytes = wav(), view = new DataView(bytes);
    if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
    assert.throws(() => readPcmWav(bytes));
  }
  assert.throws(() => readPcmWav(wav(8000, 8000 * 121)));
  const converted = resampleMicrophone(new Int16Array(960).fill(1000).buffer);
  assert.equal(converted.length, 1280);
  assert.equal(new DataView(converted.buffer).getInt16(0, true), 1000);
});
test('fixed-size replay is paced at 80ms for 8k /40ms for 16k, pauses rather than dropping samples, and cancels without stale writes', async () => {
  for (const rate of [8000, 16000]) {
    const controller = new AbortController(), waits = [], packets = [];
    let allowed = false;
    await replayPcm({ pcm: new Uint8Array(2600), sampleRate: rate, signal: controller.signal,
      canSend: () => allowed, send: p => packets.push(p),
      wait: async ms => { waits.push(ms); allowed = true; } });
    assert.deepEqual(packets.map(p => p.length), [1280, 1280, 40]);
    assert.deepEqual(waits, [40, 1280 / (rate * 2) * 1000, 1280 / (rate * 2) * 1000, 40 / (rate * 2) * 1000]);
  }
  const controller = new AbortController(); let sends = 0;
  await assert.rejects(replayPcm({ pcm: new Uint8Array(1280), sampleRate: 8000, signal: controller.signal,
    canSend: () => true, send: () => sends++, wait: async () => controller.abort() }));
  assert.equal(sends, 0);
});
