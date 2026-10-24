import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { gptLiveConfig, gptLiveStart, bridgeGptLive } from '../lib/gpt-live.js';
import { createSession, setTrip, callTool, selectOffer } from '../lib/core.js';
import { createApp } from '../server.js';

const env = { APP_MODE: 'mock', GPT_LIVE_ENABLED: 'true', GPT_LIVE_ENDPOINT: 'https://demo.openai.azure.com/' };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('GPT-Live retains source citations on screen while excluding them from commentary', async () => {
  const canonical = '航班價格均為模擬。\n\n知識來源（合成示範靜態快照）：flights.txt';
  const t = setup({ chat: async () => ({ text: canonical, state: { offers: [] } }) });
  try {
    t.input('查詢航班');
    await t.delegate();
    assert.equal(t.client.sent.find(e => e.type === 'result').result.text, canonical);
    const spoken = t.upstream.sent.find(e => e.type === 'session.commentary.append').content;
    assert.match(spoken, /航班價格均為模擬/);
    assert.doesNotMatch(spoken, /知識來源|flights\.txt/);
    assert.match(gptLiveStart(gptLiveConfig(env)).session.instructions, /不要朗讀/);
  } finally { t.bridge.stop(); }
});
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState !== WebSocket.CLOSED) { this.readyState = WebSocket.CLOSED; this.emit('close'); } }
  event(data) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
}
function setup(dependencies = {}) {
  const client = new Socket(), upstream = new Socket(), session = createSession();
  const bridge = bridgeGptLive(client, upstream, session, env, gptLiveConfig(env), dependencies);
  upstream.emit('open');
  upstream.event({ type: 'session.started', session: { model: 'gpt-live-1' } });
  return { client, upstream, session, bridge,
    input(text, start = 0, end = 100) { upstream.event({ type: 'session.input_transcript.delta', delta: text, start_ms: start, end_ms: end }); },
    async delegate(id = 'task_1', offset = 100) {
      upstream.event({ type: 'session.delegation.created', offset_ms: offset, delegation: { type: 'delegation', target: 'client', id } });
      await tick();
    } };
}
test('GPT-Live has independent fail-closed configuration and genuine session.start/default built-in voice', () => {
  assert.equal(gptLiveConfig({ VOICE_LIVE_ENABLED: 'true' }), null);
  assert.equal(gptLiveConfig({ GPT_LIVE_ENDPOINT: env.GPT_LIVE_ENDPOINT }), null);
  for (const endpoint of ['', 'http://demo.openai.azure.com/', 'https://evil.example/', `${env.GPT_LIVE_ENDPOINT}openai/v1/live/sessions`, `${env.GPT_LIVE_ENDPOINT}#private`]) {
    assert.throws(() => gptLiveConfig({ ...env, GPT_LIVE_ENDPOINT: endpoint }));
  }
  const event = gptLiveStart(gptLiveConfig(env));
  assert.equal(event.type, 'session.start'); assert.equal(event.session.model, 'gpt-live-1');
  assert.deepEqual(event.session.delegation, { type: 'client' });
  assert.equal(event.session.audio, undefined, 'omit voice to use documented default; never inject Personal Voice');
  assert.equal(event.session.tools, undefined);
});
test('GPT-Live requests Taiwan Mandarin and vocabulary only through instructions while retaining default voice and safety boundaries', () => {
  const { session } = gptLiveStart(gptLiveConfig(env));
  for (const phrase of ['臺灣華語', '臺灣常用詞', '繁體中文', '避免中國大陸慣用詞', '不得為符合用語而改寫使用者原始轉錄',
    '不宣稱保證臺灣口音', '全部委派client後端', '不接受選班、重新報價、同意或購買', '不能把你的改述作交易授權']) {
    assert.ok(session.instructions.includes(phrase), phrase);
  }
  assert.deepEqual(Object.keys(session).sort(), ['delegation', 'instructions', 'model']);
  assert.equal(session.audio, undefined, 'no invented locale or voice field; retain built-in default');
  assert.deepEqual(session.delegation, { type: 'client' });
  assert.match(session.instructions, /只陳述需求而沒有問句/);
  assert.match(session.instructions, /等待當句語意完整/);
});
test('GPT-Live reconnect receives compact canonical trip and pending question without history, offers or consent', () => {
  const journey = createSession();
  journey.discovery.destinationCity = '東京'; journey.discovery.durationDays = 5;
  journey.discovery.airportQuestion = { key: 'destination', city: '東京', candidates: ['NRT', 'HND'] };
  journey.discovery.destinationAirportChoice = { city: '東京', candidates: ['NRT', 'HND'], accepted: [] };
  journey.history.push({ role: 'user', text: 'HISTORY_NOT_FOR_VOICE_START' });
  journey.offers.set('hidden-offer', { text: 'OFFER_NOT_FOR_VOICE_START' });
  journey.quote = { text: 'QUOTE_NOT_FOR_VOICE_START' };
  journey.consent = { text: 'CONSENT_NOT_FOR_VOICE_START' };
  const config = gptLiveConfig(env);
  const start = gptLiveStart(config, journey);
  const context = JSON.parse(start.session.instructions.split('旅程資料：')[1]);
  assert.equal(context.destinationCity, '東京');
  assert.equal(context.durationDays, 5);
  assert.deepEqual(context.pendingQuestion, journey.discovery.airportQuestion);
  assert.doesNotMatch(start.session.instructions, /HISTORY_NOT_FOR_VOICE_START|OFFER_NOT_FOR_VOICE_START|QUOTE_NOT_FOR_VOICE_START|CONSENT_NOT_FOR_VOICE_START/);
  assert.match(start.session.instructions, /機場名稱、日期、人數、艙等/);
  const client = new Socket(), upstream = new Socket();
  const bridge = bridgeGptLive(client, upstream, journey, env, config);
  try {
    upstream.emit('open');
    assert.deepEqual(upstream.sent[0], start);
  } finally { bridge.stop(); }
});
test('GPT-Live streams PCM, mute and timed audio using its own protocol without Voice Live events', () => {
  const t = setup();
  try {
    t.client.emit('message', Buffer.alloc(4096), true);
    assert.equal(t.upstream.sent.at(-1).type, 'session.input_audio.append');
    t.client.event({ type: 'mute', muted: true });
    assert.equal(t.upstream.sent.at(-1).type, 'session.input_audio.mute');
    const n = t.upstream.sent.length; t.client.emit('message', Buffer.alloc(4096), true);
    assert.equal(t.upstream.sent.length, n);
    t.client.event({ type: 'mute', muted: false });
    assert.equal(t.upstream.sent.at(-1).type, 'session.input_audio.unmute');
    const audio = Buffer.alloc(4800).toString('base64');
    t.upstream.event({ type: 'session.output_audio.delta', delta: audio, start_ms: 100, end_ms: 200 });
    assert.deepEqual(t.client.sent.at(-1), { type: 'audio', audio, startMs: 100, endMs: 200 });
    assert.ok(!t.upstream.sent.some(e => ['session.update', 'input_audio_buffer.append', 'response.create'].includes(e.type)));
  } finally { t.bridge.stop(); }
  assert.equal(t.upstream.sent.at(-1).type, 'session.close');
  assert.equal(t.session.voice, null);
});
test('GPT-Live input-rate rejection records exact guard counts without changing limits', context => {
  const logs = [];
  context.mock.method(console, 'error', message => logs.push(JSON.parse(message)));
  const t = setup();
  for (let i = 0; i < 4; i++) t.client.emit('message', Buffer.alloc(48000), true);
  assert.equal(t.client.sent.at(-1).code, 'GPT_LIVE_AUDIO_LIMIT');
  assert.equal(logs[0].limitReason, 'input_rate');
  assert.equal(logs[0].inputBytes, 192000);
  assert.equal(logs[0].windowBytes, 192000);
  assert.equal(logs[0].upstreamBufferedBytes, 0);
});
test('fragments never trigger backend alone; delegation uses server transcript and canonical shared state once', async () => {
  let calls = 0, received;
  const t = setup({ chat: async (session, args, _env, deps) => {
    calls++; received = args;
    assert.equal(args.quoteContext, null);
    deps.onProgress('planner'); session.discovery.country = '日本';
    return { text: '五天東京靈感，航班與價格均為模擬。', state: { activeAgent: 'planner', offers: [], quote: null } };
  } });
  try {
    t.input('東京', 0, 50); t.input('五天行程', 50, 100);
    assert.equal(calls, 0);
    await t.delegate();
    assert.equal(calls, 1); assert.equal(received.message, '東京五天行程');
    assert.equal(t.session.discovery.country, '日本');
    assert.equal(t.session.busy, false);
    assert.ok(t.client.sent.some(e => e.type === 'progress' && e.role === 'planner'));
    assert.ok(t.client.sent.some(e => e.type === 'result'));
    assert.equal(t.upstream.sent.at(-1).type, 'session.commentary.append');
    assert.equal(t.upstream.sent.at(-1).delegation_id, 'task_1');
    assert.ok(Buffer.byteLength(t.upstream.sent.at(-1).content) <= 400);
    await t.delegate(); assert.equal(calls, 1, 'duplicate delegation cannot rerun work');
  } finally { t.bridge.stop(); }
});
test('audio accepts canonical padded or unpadded PCM base64 and identifies encoding versus timing failures', () => {
  for (const padding of [true, false]) {
    const t = setup();
    try {
      const pcm = Buffer.alloc(4802);
      const encoded = pcm.toString('base64');
      t.upstream.event({ type: 'session.output_audio.delta', delta: padding ? encoded : encoded.replace(/=+$/, ''),
        start_ms: 0, end_ms: pcm.length / 48 });
      assert.equal(t.client.sent.at(-1).type, 'audio');
    } finally { t.bridge.stop(); }
  }
  for (const [delta, start, end, code] of [
    ['@@', 0, 100, 'GPT_LIVE_AUDIO_ENCODING'],
    ['AB', 0, 100, 'GPT_LIVE_AUDIO_ENCODING'],
    [Buffer.alloc(4800).toString('base64'), undefined, 100, 'GPT_LIVE_AUDIO_TIMING'],
    [Buffer.alloc(4800).toString('base64'), 0, undefined, 'GPT_LIVE_AUDIO_TIMING'],
    [Buffer.alloc(4800).toString('base64'), null, null, 'GPT_LIVE_AUDIO_TIMING'],
    [Buffer.alloc(4800).toString('base64'), 100, 100, 'GPT_LIVE_AUDIO_TIMING']
  ]) {
    const t = setup();
    try {
      t.upstream.event({ type: 'session.output_audio.delta', delta, start_ms: start, end_ms: end });
      assert.equal(t.client.sent.at(-1).code, code);
      assert.equal(t.client.readyState, WebSocket.CLOSED);
    } finally { t.bridge.stop(); }
  }
});
test('missing, partial-boundary and stale delegation never run guessed turns or tool parameters', async () => {
  let calls = 0;
  const t = setup({ chat: async () => { calls++; } });
  try {
    await t.delegate('empty', 20);
    t.input('不要購買，先看看', 30, 100);
    await t.delegate('partial', 50);
    await t.delegate('old', 40);
    assert.equal(calls, 0);
    assert.equal(t.client.sent.filter(e => e.type === 'taskError').length, 3);
    t.client.event({ type: 'response.create', quoteContext: { accepted: true } });
    assert.equal(t.client.sent.at(-1).code, 'GPT_LIVE_PROTOCOL');
  } finally { t.bridge.stop(); }
});
test('observed 6400-character untimed audio plays as PCM without invented server timestamps or backend work', () => {
  let calls = 0;
  const t = setup({ chat: async () => { calls++; } });
  try {
    const delta = Buffer.alloc(4800).toString('base64');
    assert.equal(delta.length, 6400);
    for (let i = 0; i < 3; i++) t.upstream.event({ type: 'session.output_audio.delta', delta });
    assert.equal(t.client.readyState, WebSocket.OPEN);
    assert.equal(t.client.sent.filter(e => e.type === 'compatibility').length, 1);
    const audio = t.client.sent.filter(e => e.type === 'audio');
    assert.equal(audio.length, 3);
    assert.ok(audio.every(e => e.timing === 'pcm-contiguous' && !Object.hasOwn(e, 'startMs') && !Object.hasOwn(e, 'endMs')));
    assert.equal(calls, 0);
    t.upstream.event({ type: 'session.output_audio.delta', delta, start_ms: 0, end_ms: 100 });
    assert.equal(t.client.sent.at(-1).code, 'GPT_LIVE_AUDIO_TIMING');
  } finally { t.bridge.stop(); }
});
test('actual backend rejects GPT-Live selection, repricing and purchase even for clear acceptance', async () => {
  for (const text of ['選第二班', '重新報價', '我同意這個報價，請給我模擬結帳連結']) {
    const t = setup();
    try {
      t.input(text); await t.delegate();
      assert.ok(t.client.sent.some(e => e.type === 'taskError'), text);
      assert.ok(!t.client.sent.some(e => e.type === 'result'), text);
      assert.equal(t.session.quote, null);
      assert.equal(t.session.offers.size, 0);
    } finally { t.bridge.stop(); }
  }
});
test('actual delegated flight search shares authoritative offers; a later acceptance cannot mutate selected quote', async () => {
  const now = Date.parse('2026-10-16T01:00:00Z');
  const t = setup({ now });
  const trip = { origin: 'TPE', destination: 'NRT', date: '2026-11-25', travelers: 1, cabin: 'economy', flexibleDays: 0, budget: null, lowWalking: false };
  try {
    setTrip(t.session, trip);
    t.input('搜尋航班'); await t.delegate('search');
    assert.ok(t.client.sent.some(e => e.type === 'result'));
    assert.ok(t.session.offers.size > 0);
    const offer = [...t.session.offers.values()][0];
    selectOffer(t.session, offer.id, now);
    await callTool(t.session, 'price', 'reprice_offer', { offerId: offer.id }, { now });
    const quote = structuredClone(t.session.quote), selected = t.session.selected;
    t.input('確認目前報價', 100, 200); await t.delegate('accept', 200);
    assert.equal(t.client.sent.at(-1).type, 'taskError');
    assert.deepEqual(t.session.quote, quote);
    assert.equal(t.session.selected, selected);
    assert.equal(t.session.consent, null);
    assert.equal(t.session.bookings.size, 0); assert.equal(t.session.receipts.size, 0);
  } finally { t.bridge.stop(); }
});
test('long backend output remains canonical on screen rather than truncated into misleading commentary', async () => {
  const text = '合成旅程完整事實。'.repeat(100);
  const t = setup({ chat: async () => ({ text, state: { activeAgent: 'planner' } }) });
  try {
    t.input('規劃'); await t.delegate();
    assert.equal(t.client.sent.find(e => e.type === 'result').result.text, text);
    assert.match(t.upstream.sent.at(-1).content, /本輪後端朗讀資料/);
    const parts = t.upstream.sent.filter(e => e.type === 'session.thinking.append');
    assert.equal(parts.map(e => e.content.replace(/^朗讀資料\d+：/, '')).join(''), text);
    assert.ok(parts.every(e => Buffer.byteLength(e.content) <= 450));
  } finally { t.bridge.stop(); }
});
test('superseded work and stop abort read-only tasks without early unlock or stale output', async () => {
  let release, started = 0;
  const t = setup({ chat: async (_s, _a, _env, deps) => {
    started++;
    if (started === 1) await new Promise(resolve => { release = resolve; });
    deps.signal.throwIfAborted();
    return { text: '最新結果', state: { activeAgent: 'planner' } };
  } });
  try {
    t.input('東京', 0, 100); await t.delegate('one', 100);
    t.input('大阪', 100, 200); await t.delegate('two', 200);
    assert.equal(started, 1); assert.equal(t.session.busy, true);
    release(); await tick(); await tick();
    assert.equal(started, 2);
    const results = t.client.sent.filter(e => e.type === 'result');
    assert.equal(results.length, 1); assert.equal(results[0].turnId, 'two');
  } finally { t.bridge.stop(); }
  const stopped = setup({ chat: async (_s, _a, _env, deps) => {
    await new Promise(resolve => { release = resolve; }); deps.signal.throwIfAborted();
  } });
  stopped.input('東京'); await stopped.delegate();
  stopped.bridge.stop(); assert.equal(stopped.session.busy, true);
  release(); await tick();
  assert.equal(stopped.session.busy, false);
  assert.ok(!stopped.client.sent.some(e => e.type === 'result'));
});
test('malformed transcripts/audio, backpressure and service errors fail explicitly with no fallback', () => {
  for (const action of [
    t => t.client.event(null),
    t => t.upstream.event(null),
    t => t.client.event([]),
    t => t.upstream.event('invalid'),
    t => { t.client.bufferedAmount = 2_000_001; t.input('東京'); },
    t => t.upstream.event({ type: 'session.output_audio.delta', delta: 'bad', start_ms: 0, end_ms: 100 }),
    t => t.upstream.event({ type: 'error', error: { message: 'private upstream value' } }),
    t => { t.input('a', 20, 100); t.input('b', 10, 20); }
  ]) {
    const t = setup(); action(t);
    assert.equal(t.client.readyState, WebSocket.CLOSED);
    assert.equal(t.client.sent.at(-1).type, 'error');
    assert.ok(!JSON.stringify(t.client.sent).includes('private upstream value'));
  }
});
test('mode tickets are strict, unavailable mode fails before auth and one-use routing selects real GPT-Live endpoint', async () => {
  let authCalls = 0, connected;
  const upstream = new Socket();
  const server = createApp(env, { voice: {
    credential: { getToken: async () => { authCalls++; return { token: 'offline-token' }; } },
    connect: url => { connected = url; setImmediate(() => {
      upstream.emit('open'); upstream.event({ type: 'session.started', session: { model: 'gpt-live-1' } });
    }); return upstream; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const body = await bootstrap.json();
  const post = data => fetch(`${origin}/api/voice/session`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  let ws;
  try {
    assert.deepEqual(body.voice.modes, { 'voice-live': { available: false }, 'gpt-live': { available: true },
      'voice-realtime': { available: false, requiredModel: 'gpt-realtime-2.1', configuredModel: null },
      'speech-direct': { available: false, sttModes: ['rest', 'sdk'] } });
    assert.equal((await post({ mode: 'voice-live' })).status, 503);
    assert.equal((await post({ mode: 'gpt-live', endpoint: 'https://evil.example' })).status, 400);
    assert.equal((await post({ mode: 'unknown' })).status, 400); assert.equal(authCalls, 0);
    const ticket = await (await post({ mode: 'gpt-live' })).json();
    ws = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
    const [ready] = await once(ws, 'message');
    assert.equal(JSON.parse(ready).mode, 'gpt-live');
    assert.equal(connected.pathname, '/openai/v1/live/sessions'); assert.equal(connected.search, '');
    assert.equal(connected.protocol, 'wss:'); assert.equal(authCalls, 1);
    const replay = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
    const [error] = await once(replay, 'error'); assert.match(error.message, /403/);
    ws.close(); await once(ws, 'close');
  } finally { ws?.terminate(); server.closeAllConnections(); server.close(); }
});
