import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { createSession, setTrip, selectOffer, callTool } from '../lib/core.js';
import { bridgeDirectSpeech, directSpeechConfig, personalVoiceSsml, speechWav } from '../lib/direct-speech.js';
import { voiceMetrics } from '../lib/voice-metrics.js';
import { mockSpeechSdk } from './mock-speech-sdk.js';
import { speechInputSchema } from '../lib/speech-sdk.js';

const env = { APP_MODE: 'mock', DIRECT_SPEECH_ENABLED: 'true',
  DIRECT_SPEECH_ENDPOINT: 'https://offline.cognitiveservices.azure.com',
  DIRECT_SPEECH_KEY: 'offline-test-key',
  DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID: '12345678-1234-1234-1234-123456789abc',
  DIRECT_SPEECH_PERSONAL_VOICE_MODEL: 'DragonLatestNeural' };
function speechInput() {
  const bytes = Buffer.alloc(38400);
  for (let i = 19200; i < bytes.length; i += 2) bytes.writeInt16LE(Math.round(Math.sin(i * 0.1) * 4000), i);
  return bytes;
}
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  audio(bytes = speechInput()) { this.emit('message', bytes, true); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
test('REST and SDK detailed speech synthesize serial chunks, ignore stale playback acknowledgment and stop cleanly', async () => {
  for (const sdk of [false, true]) {
    const mock = mockSpeechSdk();
    const text = '已確認第二天九點到十七點開會。建議會前用餐，會後休息；交通待確認。'.repeat(8);
    const t = setup({ ...(sdk ? { speechSdk: mock.sdk, speechInput: speechInputSchema.parse({ stt: 'sdk' }) } : {}),
      chat: async () => ({ text, speech: { text, detail: 'detailed' }, state: { offers: [], activeAgent: 'planner' } }) });
    try {
      if (sdk) {
        await settle();
        mock.instances[0].recognized(null, { result: { text: '第二天詳細一點', reason: 3, offset: 0, duration: 1000000 } });
      } else { t.client.audio(); t.client.event({ type: 'finish' }); }
      await settle();
      assert.equal(t.client.sent.find(e => e.type === 'result').result.text, text);
      const first = t.client.sent.find(e => e.type === 'audioSegmentDone');
      assert.ok(first); assert.equal(t.session.busy, true);
      assert.equal(t.requests.filter(r => r.url.pathname.startsWith('/tts/')).length, 1);
      t.client.event({ type: 'segmentPlayed', turnId: 'stale', segment: first.segment }); await settle();
      assert.equal(t.requests.filter(r => r.url.pathname.startsWith('/tts/')).length, 1);
      t.client.event({ type: 'segmentPlayed', turnId: first.turnId, segment: first.segment }); await settle();
      assert.equal(t.requests.filter(r => r.url.pathname.startsWith('/tts/')).length, 2);
      t.bridge.stop(); await settle();
      assert.equal(t.session.busy, false); assert.equal(t.session.voice, null);
      assert.equal(t.client.sent.filter(e => e.type === 'error').length, 0);
      assert.equal(t.requests.filter(r => r.url.pathname.startsWith('/tts/')).length, 2);
    } finally { t.bridge.stop(); }
  }
});
function setup(dependencies = {}) {
  const client = new Socket(), session = createSession(), requests = [];
  const bridge = bridgeDirectSpeech(client, session, env, directSpeechConfig(env), {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return url.pathname.startsWith('/stt/') ? Response.json({ RecognitionStatus: 'Success', DisplayText: '我想去日本玩幾天' }) :
        new Response(Buffer.alloc(4800));
    }, ...dependencies
  });
  return { client, session, bridge, requests };
}
test('direct Speech displays source metadata but excludes it from Personal Voice SSML', async () => {
  const canonical = '合成班次，無真實訂位。\n\n知識來源（合成示範靜態快照）：flights.txt';
  const t = setup({ chat: async () => ({ text: canonical, state: { offers: [] } }) });
  try {
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.client.sent.find(e => e.type === 'result').result.text, canonical);
    const spoken = t.requests.find(r => r.url.pathname.startsWith('/tts/')).options.body;
    assert.match(spoken, /合成班次，無真實訂位/);
    assert.doesNotMatch(spoken, /知識來源|flights\.txt/);
  } finally { t.bridge.stop(); }
});
test('direct Speech source-only answers complete without sending blank TTS and allow the next turn', async () => {
  const t = setup({ chat: async () => ({ text: '資料來源：flights.txt', state: { offers: [] } }) });
  try {
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.requests.length, 1);
    assert.equal(t.client.sent.at(-1).type, 'audioDone');
    assert.equal(t.session.busy, false);
    t.client.event({ type: 'resume' });
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.requests.length, 2);
  } finally { t.bridge.stop(); }
});
test('SDK finals enqueue without blocking callbacks, use the same backend/TTS serially, and retain every in-flight final', async () => {
  const mock = mockSpeechSdk(), messages = [];
  let release;
  const t = setup({
    speechSdk: mock.sdk, speechInput: speechInputSchema.parse({ stt: 'sdk', source: 'wav', sampleRate: 8000 }),
    chat: async (_session, args, _env, dependencies) => {
      messages.push(args.message);
      dependencies.onProgress('planner');
      if (messages.length === 1) await new Promise(resolve => { release = resolve; });
      return { text: '合成靈感。\n知識來源：flights.txt', state: { offers: [], activeAgent: 'planner' } };
    }
  });
  try {
    await settle();
    assert.equal(t.client.sent.find(e => e.type === 'ready').stt, 'sdk');
    const recognizer = mock.instances[0], stream = mock.streams[0];
    t.client.audio(Buffer.alloc(1280));
    assert.equal(stream.packets.length, 1);
    recognizer.recognizing(null, { result: { text: '東' } });
    recognizer.recognized(null, { result: { text: '東京', reason: 3, offset: 0, duration: 7000000 } });
    await settle();
    assert.deepEqual(messages, ['東京']);
    assert.equal(t.session.busy, true);
    recognizer.recognized(null, { result: { text: '兩位', reason: 3, offset: 8000000, duration: 4000000 } });
    t.client.audio(Buffer.alloc(1280));
    assert.equal(stream.packets.length, 1, 'half-duplex rejects uploads while backend is working');
    assert.equal(t.client.sent.filter(e => e.type === 'asr' && e.kind === 'recognized').length, 2);
    release(); await settle();
    assert.deepEqual(messages, ['東京']);
    assert.equal(t.requests.filter(r => r.url.pathname.startsWith('/stt/')).length, 0, 'SDK never uses REST STT');
    assert.doesNotMatch(t.requests[0].options.body, /flights\.txt/);
    t.client.event({ type: 'resume' }); await settle();
    assert.deepEqual(messages, ['東京', '兩位']);
    assert.equal(t.client.sent.filter(e => e.type === 'result').length, 2);
    assert.equal(t.client.sent.filter(e => e.type === 'audioDone').length, 2);
    t.client.event({ type: 'resume' });
    t.client.event({ type: 'mute', muted: true }); t.client.audio(Buffer.alloc(1280));
    assert.equal(stream.packets.length, 1);
    t.client.event({ type: 'mute', muted: false });
    t.client.audio(Buffer.alloc(1280));
    assert.equal(stream.packets.length, 2);
    t.client.event({ type: 'input_eof' }); recognizer.sessionStopped();
    await settle();
    assert.equal(messages.length, 2, 'EOF/session_stopped never dispatches an extra turn');
    assert.equal(t.session.busy, false);
    assert.ok(!t.client.sent.some(e => e.type === 'error'));
  } finally { release?.(); t.bridge.stop(); }
  assert.equal(mock.instances[0].closed, true);
});
test('SDK final cannot execute transactions, and excessive queued finals fail explicitly', async () => {
  for (const overload of [false, true]) {
    const mock = mockSpeechSdk();
    let release;
    const t = setup({ speechSdk: mock.sdk, speechInput: speechInputSchema.parse({ stt: 'sdk' }),
      ...(overload ? { chat: async () => {
        await new Promise(resolve => { release = resolve; });
        return { text: '無交易', state: { offers: [] } };
      } } : {})
    });
    try {
      await settle();
      const recognizer = mock.instances[0];
      const final = () => recognizer.recognized(null, { result: { text: '重新報價', reason: 3, offset: 0, duration: 1000000 } });
      final(); await settle();
      if (overload) for (let i = 0; i < 9; i++) final();
      await settle();
      assert.equal(t.client.sent.at(-1).code, overload ? 'SPEECH_SDK_QUEUE' : 'SPEECH_TRANSACTION');
      assert.equal(t.session.bookings.size, 0);
      assert.equal(t.requests.length, 0);
    } finally { release?.(); t.bridge.stop(); await settle(); }
  }
});
test('Direct Speech ignores premature and wrong-turn resume but honors synchronous completion resume after lock release', async () => {
  let release;
  const t = setup({ chat: async () => {
    await new Promise(resolve => { release = resolve; });
    return { text: '完成。', state: { offers: [] } };
  } });
  try {
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    t.client.event({ type: 'resume' }); release(); await settle();
    const first = t.client.sent.find(event => event.type === 'audioDone');
    assert.ok(first);
    const before = t.requests.length;
    t.client.event({ type: 'resume', turnId: 'wrong-turn' }); t.client.audio(); await settle();
    assert.equal(t.requests.length, before);
    t.client.event({ type: 'resume', turnId: first.turnId });
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.requests.length, before + 1, 'valid resume allows exactly the next STT request');
    const send = t.client.send.bind(t.client);
    t.client.send = value => {
      send(value);
      const event = JSON.parse(value);
      if (event.type === 'audioDone') t.client.event({ type: 'resume', turnId: event.turnId });
    };
    release(); await settle();
    assert.equal(t.session.busy, false);
    const complete = t.requests.length;
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.requests.length, complete + 1, 'synchronous ACK cannot deadlock finally lock release');
  } finally { release?.(); t.bridge.stop(); await settle(); }
});
test('SDK microphone forwards trailing zero PCM, delegates only recognized finals and accepts the next utterance after playback resume', async () => {
  const mock = mockSpeechSdk(), messages = [];
  const t = setup({
    speechSdk: mock.sdk, speechInput: speechInputSchema.parse({ stt: 'sdk', source: 'microphone', sampleRate: 16000 }),
    chat: async (_session, args) => {
      messages.push(args.message);
      return { text: '完成。', state: { offers: [], activeAgent: 'planner' } };
    }
  });
  try {
    await settle();
    const recognizer = mock.instances[0], stream = mock.streams[0];
    for (let turn = 1; turn <= 2; turn++) {
      const before = stream.packets.length;
      t.client.audio(Buffer.alloc(1280, 1));
      recognizer.recognizing(null, { result: { text: '未完成片段' } });
      for (let packet = 0; packet < 18; packet++) t.client.audio(Buffer.alloc(1280));
      await settle();
      assert.equal(stream.packets.length, before + 19);
      assert.ok(stream.packets.slice(-18).every(packet => new Uint8Array(packet).every(byte => byte === 0)));
      assert.equal(messages.length, turn - 1, '720ms zero PCM and partial events must not invent a final');
      recognizer.recognized(null, { result: { text: `第${turn}句`, reason: 3, offset: turn * 10000000, duration: 1000000 } });
      await settle();
      assert.deepEqual(messages, Array.from({ length: turn }, (_, i) => `第${i + 1}句`));
      assert.equal(t.client.sent.filter(e => e.type === 'audioDone').length, turn);
      const paused = stream.packets.length;
      t.client.audio(Buffer.alloc(1280));
      assert.equal(stream.packets.length, paused, 'do not recognize playback through the microphone');
      t.client.event({ type: 'resume' });
      assert.equal(t.client.sent.at(-1).state, 'listening');
    }
    assert.equal(t.client.sent.some(e => e.type === 'error'), false);
  } finally { t.bridge.stop(); }
});
test('SDK HTTP tickets bind strict settings server-side and do not acquire credentials before upgrade', async () => {
  let auth = 0, socket;
  const mock = mockSpeechSdk();
  const server = createApp(env, { voice: {
    speechSdk: mock.sdk, credential: { getToken: async () => { auth++; throw new Error('offline'); } }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const boot = await fetch(`${origin}/api/bootstrap`), cookie = boot.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await boot.json()).voice.modes['speech-direct'].sttModes, ['rest', 'sdk']);
    const post = async body => {
      const response = await fetch(`${origin}/api/voice/session`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); return { status: response.status, data };
    };
    const ticket = await post({ mode: 'speech-direct', speechInput: { stt: 'sdk', source: 'wav', sampleRate: 8000 } });
    assert.equal(ticket.status, 200);
    for (const speechInput of [{ stt: 'sdk', endpoint: 'https://evil.invalid' },
      { stt: 'sdk', sampleRate: 24000 }, { stt: 'sdk', silenceMs: 50 }, { stt: 'sdk', key: 'client-secret' }]) {
      assert.equal((await post({ mode: 'speech-direct', speechInput })).status, 400);
    }
    assert.equal((await post({ mode: 'gpt-live', speechInput: { stt: 'sdk' } })).status, 400);
    assert.equal(auth, 0);
    socket = new WebSocket(origin.replace('http:', 'ws:') + ticket.data.path, ['journey-voice', ticket.data.nonce], {
      headers: { origin, cookie }
    });
    const ready = await new Promise((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', bytes => { const event = JSON.parse(bytes); if (event.type === 'ready') resolve(event); });
    });
    assert.equal(ready.stt, 'sdk');
    assert.equal(mock.streams[0].format.rate, 8000);
    const stopped = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'stop' })); await stopped;
    assert.equal(mock.instances[0].closed, true);
    assert.equal(auth, 0, 'mock key SDK path does not open Voice Live bearer auth');
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close'); socket.terminate(); await closed;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
test('direct Speech needs its own explicit endpoint, credential and speakerProfileId; never reuses Voice Live identifiers', () => {
  assert.equal(directSpeechConfig({}), null);
  assert.equal(directSpeechConfig({ VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_PERSONAL_VOICE_NAME: 'private' }), null);
  for (const values of [
    { DIRECT_SPEECH_ENDPOINT: 'https://offline.services.ai.azure.com' },
    { DIRECT_SPEECH_ENDPOINT: 'https://offline.cognitiveservices.azure.com:444' },
    { DIRECT_SPEECH_ENDPOINT: 'https://offline.cognitiveservices.azure.com/?x=1' },
    { DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID: 'voice-live-name' },
    { DIRECT_SPEECH_PERSONAL_VOICE_MODEL: 'unknown' },
    { DIRECT_SPEECH_KEY: '', DIRECT_SPEECH_RESOURCE_ID: '' }
  ]) assert.throws(() => directSpeechConfig({ ...env, ...values }));
  assert.ok(directSpeechConfig(env));
});
test('direct Speech resamples bounded 24 kHz PCM to documented 16 kHz mono WAV and escapes SSML', () => {
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  const wav = speechWav(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 32000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.length, 32044);
  for (let i = 44; i < wav.length; i += 2) assert.equal(wav.readInt16LE(i), 1000);
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(2), Buffer.alloc(3), Buffer.alloc(1440002)]) assert.throws(() => speechWav(invalid));
  const ssml = personalVoiceSsml(directSpeechConfig(env), '飯店 & <script>「日本」');
  assert.match(ssml, /mstts:ttsembedding speakerProfileId="12345678/);
  assert.match(ssml, /&amp;/); assert.match(ssml, /&lt;script&gt;/);
  assert.doesNotMatch(ssml, /endpoint_id|<script>/);
});
test('direct Speech runs the real same four-agent mock backend between STT and exact-text Personal Voice TTS, never Voice Live', async () => {
  const t = setup();
  try {
    assert.equal(t.requests.length, 0, 'readiness is local and never contacts Speech');
    t.client.audio(); assert.equal(t.requests.length, 0, 'only explicit finish uploads recording');
    t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.session.turns, 1);
    assert.equal(t.requests.length, 2);
    assert.equal(t.requests[0].url.pathname, '/stt/speech/recognition/conversation/cognitiveservices/v1');
    assert.equal(t.requests[0].url.searchParams.get('language'), 'zh-TW');
    assert.equal(t.requests[1].url.pathname, '/tts/cognitiveservices/v1');
    assert.equal(t.requests[1].options.headers['X-Microsoft-OutputFormat'], 'raw-24khz-16bit-mono-pcm');
    assert.ok(!JSON.stringify(t.requests.map(r => r.url)).includes('voice-live'));
    assert.ok(t.client.sent.some(e => e.type === 'result'));
    assert.ok(t.client.sent.some(e => e.type === 'audioDone'));
    assert.equal(t.client.sent.filter(e => e.type === 'audio').length, 1);
    const metrics = t.client.sent.filter(e => e.type === 'measurement');
    assert.deepEqual(metrics.map(e => e.stage), ['input_start', 'input_end', 'stt_dispatch', 'transcript', 'backend_dispatch', 'backend_result', 'tts_dispatch', 'tts_first_byte', 'first_audio']);
    assert.ok(!JSON.stringify(metrics).includes('日本'));
    t.client.event({ type: 'resume' }); t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.session.turns, 2);
  } finally { t.bridge.stop(); }
});
test('direct Speech fails before transaction writes, never synthesizes success or falls back', async () => {
  const t = setup({ fetch: async () => Response.json({ RecognitionStatus: 'Success', DisplayText: '重新報價' }) });
  try {
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.client.sent.at(-1).code, 'SPEECH_TRANSACTION');
    assert.equal(t.session.quote, null); assert.equal(t.session.bookings.size, 0);
    assert.ok(!t.client.sent.some(e => ['audio', 'result'].includes(e.type)));
  } finally { t.bridge.stop(); }
});
test('direct Speech real search shares canonical offers and cannot reprice an existing quote', async () => {
  const now = Date.parse('2026-10-16T01:00:00Z');
  let phrase = '搜尋航班';
  const t = setup({ now, fetch: async url => url.pathname.startsWith('/stt/') ?
    Response.json({ RecognitionStatus: 'Success', DisplayText: phrase }) : new Response(Buffer.alloc(4800)) });
  try {
    setTrip(t.session, { origin: 'TPE', destination: 'NRT', date: '2026-11-25', travelers: 1, cabin: 'economy',
      flexibleDays: 0, budget: null, lowWalking: false });
    t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.ok(t.session.offers.size > 0);
    const played = new Set();
    while (!t.client.sent.some(e => e.type === 'audioDone')) {
      const next = t.client.sent.find(e => e.type === 'audioSegmentDone' && !played.has(e.segment));
      assert.ok(next, 'each next TTS waits for actual playback acknowledgment');
      played.add(next.segment);
      t.client.event({ type: 'segmentPlayed', turnId: next.turnId, segment: next.segment });
      await settle();
    }
    const offer = [...t.session.offers.values()][0];
    selectOffer(t.session, offer.id, now);
    await callTool(t.session, 'price', 'reprice_offer', { offerId: offer.id }, { now });
    const quote = structuredClone(t.session.quote);
    phrase = '重新報價';
    t.client.event({ type: 'resume' }); t.client.audio(); t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.client.sent.at(-1).code, 'SPEECH_TRANSACTION');
    assert.deepEqual(t.session.quote, quote);
    assert.equal(t.session.consent, null); assert.equal(t.session.bookings.size, 0);
  } finally { t.bridge.stop(); }
});
test('direct Speech malformed/no-match transcription and HTTP errors never reach agents or expose upstream data', async () => {
  for (const response of [
    () => Response.json({ RecognitionStatus: 'NoMatch' }),
    () => Response.json({ RecognitionStatus: 'Success', DisplayText: '' }),
    () => new Response('upstream-private-detail', { status: 403 }),
    () => new Response('not-json')
  ]) {
    let calls = 0;
    const t = setup({ fetch: async () => response(), chat: async () => { calls++; } });
    try {
      t.client.audio(); t.client.event({ type: 'finish' }); await settle();
      assert.equal(calls, 0); assert.equal(t.client.sent.at(-1).type, 'error');
      assert.ok(!JSON.stringify(t.client.sent).includes('upstream-private-detail'));
    } finally { t.bridge.stop(); }
  }
});
test('direct Speech cancellation preserves the backend lock until read-only work settles', async () => {
  let release;
  const t = setup({ chat: async (_s, _a, _e, options) => {
    await new Promise(resolve => { release = resolve; });
    options.signal.throwIfAborted();
  } });
  t.client.audio(); t.client.event({ type: 'finish' }); await settle();
  assert.equal(t.session.busy, true);
  t.bridge.stop(); assert.equal(t.session.busy, true);
  release(); await settle();
  assert.equal(t.session.busy, false);
  assert.ok(!t.client.sent.some(e => e.type === 'result'));
});
test('direct Speech rejects browser injection, empty/odd PCM, double finish and overlong recording', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of [
    t => t.client.event({ type: 'finish', endpoint: 'https://evil.invalid' }),
    t => t.client.event(null),
    t => t.client.audio(Buffer.alloc(3)),
    t => { t.client.audio(); context.mock.timers.tick(30001); }
  ]) {
    const t = setup();
    try {
      action(t); assert.equal(t.client.sent.at(-1).type, 'error'); assert.equal(t.requests.length, 0);
    } finally { t.bridge.stop(); }
  }
  let calls = 0;
  const t = setup({ fetch: async () => { calls++; return new Promise(() => {}); } });
  try {
    t.client.audio(); t.client.event({ type: 'finish' }); t.client.event({ type: 'finish' });
    assert.equal(calls, 1);
    assert.ok(!t.client.sent.some(e => e.type === 'error'));
  } finally { t.bridge.stop(); }
});
test('acoustic VAD waits without Azure calls, auto-submits voiced segment exactly once and mute discards partial speech', async context => {
  let time = Date.now();
  context.mock.method(Date, 'now', () => time += 1100);
  const t = setup();
  try {
    for (let i = 0; i < 20; i++) t.client.audio(Buffer.alloc(4800));
    assert.equal(t.requests.length, 0);
    t.client.event({ type: 'finish' }); await settle();
    assert.equal(t.requests.length, 0); assert.equal(t.client.readyState, WebSocket.OPEN);
    t.client.audio();
    t.client.event({ type: 'mute', muted: true });
    t.client.audio(Buffer.alloc(48000)); t.client.event({ type: 'mute', muted: false });
    t.client.audio(Buffer.alloc(48000)); assert.equal(t.requests.length, 0);
    t.client.audio();
    t.client.audio(Buffer.alloc(48000)); await settle();
    assert.equal(t.requests.length, 2);
    assert.equal(t.client.sent.filter(e => e.type === 'result').length, 1);
    assert.equal(t.session.turns, 1);
    t.client.audio(); assert.equal(t.requests.length, 2, 'half duplex does not dispatch during playback');
  } finally { t.bridge.stop(); }
});
test('direct Speech TTS rejects malformed or oversized output after preserving canonical text result', async () => {
  for (const audio of [Buffer.alloc(3), Buffer.alloc(1440002)]) {
    const t = setup({ fetch: async url => url.pathname.startsWith('/stt/') ?
      Response.json({ RecognitionStatus: 'Success', DisplayText: '日本' }) : new Response(audio) });
    try {
      t.client.audio(); t.client.event({ type: 'finish' }); await settle();
      assert.ok(t.client.sent.some(e => e.type === 'result'));
      assert.equal(t.client.sent.at(-1).type, 'error');
      assert.ok(!t.client.sent.some(e => e.type === 'audio'));
    } finally { t.bridge.stop(); }
  }
});
test('direct Speech Entra auth uses the separately configured resource id and Speech scope only', async () => {
  let scope, authorization;
  const config = directSpeechConfig({ ...env, DIRECT_SPEECH_KEY: '',
    DIRECT_SPEECH_RESOURCE_ID: '/subscriptions/offline/resourceGroups/offline/providers/Microsoft.CognitiveServices/accounts/offline' });
  const client = new Socket(), session = createSession();
  const bridge = bridgeDirectSpeech(client, session, env, config, {
    credential: { getToken: async value => { scope = value; return { token: 'offline-entra-token' }; } },
    fetch: async (_url, options) => {
      authorization = options.headers.Authorization;
      return Response.json({ RecognitionStatus: 'NoMatch' });
    }
  });
  try {
    client.audio(); client.event({ type: 'finish' }); await settle();
    assert.equal(scope, 'https://cognitiveservices.azure.com/.default');
    assert.equal(authorization, `Bearer aad#${config.resourceId}#offline-entra-token`);
    assert.ok(!JSON.stringify(client.sent).includes('offline-entra-token'));
  } finally { bridge.stop(); }
});
test('direct Speech HTTP/WS readiness requests no token or upstream connection and consumes mode-bound ticket', async () => {
  let calls = 0;
  const server = createApp(env, { voice: { credential: { getToken: async () => { calls++; throw new Error('must not authenticate'); } },
    connect: () => { calls++; throw new Error('must not open Voice Live'); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let socket;
  try {
    const response = await fetch(`${origin}/api/bootstrap`), cookie = response.headers.get('set-cookie').split(';')[0];
    const bootstrap = await response.json();
    assert.equal(bootstrap.voice.modes['speech-direct'].available, true);
    assert.ok(!JSON.stringify(bootstrap).includes(env.DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID));
    const ticket = await (await fetch(`${origin}/api/voice/session`, { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'speech-direct' }) })).json();
    socket = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
    const [ready] = await once(socket, 'message');
    assert.equal(JSON.parse(ready).mode, 'speech-direct'); assert.equal(calls, 0);
    socket.close(); await once(socket, 'close');
  } finally { socket?.terminate(); server.closeAllConnections(); server.close(); }
});
test('voice metrics use monotonic local timestamps, deduplicate stage, and contain only numeric timing metadata', () => {
  let now = 10;
  const events = [], metrics = voiceMetrics(event => events.push(event), 'offline', () => now);
  metrics.begin(); metrics.mark('input_start'); now = 30; metrics.mark('backend_result'); metrics.mark('backend_result');
  assert.deepEqual(events.map(e => e.elapsedMs), [0, 20]); assert.equal(events.length, 2);
  metrics.begin(); metrics.mark('backend_result'); assert.equal(events.at(-1).turn, 2);
});
