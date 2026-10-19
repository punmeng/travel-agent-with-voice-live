import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { bridgeVoice, voiceConfig, voiceSessionUpdate, quoteContext } from '../lib/voice.js';
import { AppError, createSession, callTool } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { createApp } from '../server.js';
import { readAll } from './reply-helper.js';
import { countWords } from '../lib/replies.js';
import { speechText } from '../lib/speech.js';

const env = { APP_MODE: 'mock', VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_ENDPOINT: 'https://demo.services.ai.azure.com/', FOUNDRY_AUTH_MODE: 'azure-cli' };
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(s = createSession(), dependencies = {}) {
  const client = new Socket(), upstream = new Socket();
  const bridge = bridgeVoice(client, upstream, s, env, voiceConfig(env), dependencies);
  upstream.emit('open'); upstream.event({ type: 'session.updated' });
  let count = 0;
  return { client, upstream, s, bridge,
    async say(text) {
      upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: `item-${++count}`, transcript: text });
      await tick(); return client.sent.findLast(e => e.type === 'result');
    },
    async readAll(result) {
      let next = result, pages = 0;
      while (true) {
        assert.ok(countWords(next.result.text) <= 50);
        client.event({ type: 'displayed', turnId: next.turnId });
        if (!next.result.state.moreReply) return next;
        assert.ok(++pages < 100);
        upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: `item-${++count}`, transcript: '繼續' });
        await tick(); next = client.sent.findLast(e => e.type === 'result');
      }
    },
    displayed(result) { client.event({ type: 'displayed', turnId: result.turnId }); }
  };
}
test('Voice Live uses documented exact-text synthesis with no automatic/competing model response', () => {
  assert.equal(voiceConfig({}), null);
  assert.throws(() => voiceConfig({ ...env, VOICE_LIVE_ENDPOINT: 'https://evil.invalid' }));
  const config = voiceConfig(env), update = voiceSessionUpdate(config);
  assert.equal(config.model, 'gpt-5.4'); assert.equal(config.version, '2026-07-15');
  assert.equal(update.session.turn_detection.create_response, false);
  assert.equal(update.session.voice.name, 'zh-TW-HsiaoChenNeural');
  assert.deepEqual(update.session.tools, []);
  const t = setup();
  assert.equal(t.upstream.sent[0].type, 'session.update');
  t.bridge.stop(); assert.equal(t.s.voice, null);
});
test('Personal Voice is explicit server-only configuration with no recording, silent activation or identifier disclosure', () => {
  const pending = voiceConfig({ ...env, VOICE_LIVE_PERSONAL_VOICE_NAME: 'offline-example-private-name' });
  assert.equal(pending.voice, 'zh-TW-HsiaoChenNeural', 'name alone never activates personal voice');
  assert.deepEqual(voiceSessionUpdate(pending).session.voice, { type: 'azure-standard', name: 'zh-TW-HsiaoChenNeural' });
  const configured = { ...env, VOICE_LIVE_VOICE_TYPE: 'azure-personal',
    VOICE_LIVE_PERSONAL_VOICE_NAME: 'offline-example-private-name', VOICE_LIVE_PERSONAL_VOICE_MODEL: 'DragonLatestNeural' };
  const config = voiceConfig(configured);
  assert.deepEqual(voiceSessionUpdate(config).session.voice, {
    type: 'azure-personal', name: 'offline-example-private-name', model: 'DragonLatestNeural'
  });
  assert.equal(config.voice, 'personal-voice', 'public ready label never includes the personal identifier');
  assert.throws(() => voiceConfig({ ...configured, VOICE_LIVE_PERSONAL_VOICE_NAME: '' }), /requires/);
  assert.throws(() => voiceConfig({ ...configured, VOICE_LIVE_PERSONAL_VOICE_MODEL: 'MAI-Voice-2' }), /supported/);
  assert.throws(() => voiceConfig({ ...configured, VOICE_LIVE_VOICE_TYPE: 'azure-custom' }), /Invalid/);
});
test('runtime health identifies personal output type without exposing its resource identifier', async () => {
  const privateName = 'offline-private-resource-id';
  const server = createApp({ ...env, VOICE_LIVE_VOICE_TYPE: 'azure-personal',
    VOICE_LIVE_PERSONAL_VOICE_NAME: privateName, VOICE_LIVE_PERSONAL_VOICE_MODEL: 'DragonLatestNeural' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/health`);
    const body = await response.json();
    assert.deepEqual(body.voice, { available: true, type: 'azure-personal' });
    assert.ok(!JSON.stringify(body).includes(privateName));
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).text();
    assert.ok(!bootstrap.includes(privateName));
  } finally {
    server.closeAllConnections(); server.close();
  }
});
test('the reported vague roundtrip utterance produces a clarification without closing voice or inventing a date', async () => {
  const t = setup();
  try {
    const result = await t.say('好啊，你幫我規劃一下那個臺北到大阪的飛機，來回10月中左右。');
    assert.ok(result);
    assert.doesNotMatch(result.result.text, /第 1 天|三日/);
    assert.equal(t.s.draft.date, undefined);
    assert.equal(t.s.toolUnits, 0);
    assert.equal(t.client.sent.some(event => event.type === 'error'), false);
    assert.ok(t.s.voice);
    assert.deepEqual(t.client.sent.filter(event => event.type === 'progress').map(event => event.role), ['intent', 'flight']);
    assert.equal(t.s.busy, false);
    assert.deepEqual(t.upstream.sent.at(-1).response.pre_generated_assistant_message.content,
      [{ type: 'text', text: speechText(result.result.text) }]);
  } finally { t.bridge.stop(); }
});
test('voice permits 100 turns without a five-minute cutoff and advertises the shared journey bound', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup();
  try {
    assert.equal(t.client.sent.find(e => e.type === 'ready').maxTurns, 100);
    assert.equal(t.client.sent.find(e => e.type === 'ready').maxSeconds, undefined);
    context.mock.timers.tick(300001);
    assert.ok(t.s.voice, 'no application five-minute timer');
    for (let i = 0; i < 100; i++) {
      const r = await t.say('您好'); assert.ok(r); t.displayed(r);
    }
    assert.equal(t.s.turns, 100);
    await t.say('您好');
    assert.equal(t.client.sent.at(-1).code, 'VOICE_TURN_LIMIT');
  } finally { t.bridge.stop(); }
});
test('late transcription does not kill an active turn; stop keeps its lock until completion and permits retry afterward', async () => {
  let finish;
  const s = createSession();
  const t = setup(s, { chat: async () => {
    await new Promise(resolve => { finish = resolve; });
    return { text: '好的，已完成。', state: { quote: null, offers: [] } };
  } });
  await t.say('請規劃');
  assert.equal(s.busy, true);
  await t.say('延遲到達的轉錄');
  assert.equal(t.client.sent.some(e => e.type === 'error'), false);
  t.bridge.stop();
  assert.equal(s.voice, null);
  assert.equal(s.busy, true, 'do not unlock unfinished state changes');
  finish(); await tick();
  assert.equal(s.busy, false);
  assert.equal(t.client.sent.some(e => e.type === 'result'), false);
  const next = setup(s);
  try { assert.ok(await next.say('您好')); } finally { next.bridge.stop(); }
});
test('stopping a pending voice turn suppresses all later progress and unknown role names', async () => {
  let progress, release;
  const t = setup(createSession(), { chat: async (_session, _args, _env, options) => {
    progress = options.onProgress;
    progress('intent'); progress('Voice Live'); progress('__proto__');
    await new Promise(resolve => { release = resolve; });
    progress('price');
    return { text: '完成。', state: { quote: null, offers: [], activeAgent: 'price' } };
  } });
  await t.say('測試處理狀態');
  assert.deepEqual(t.client.sent.filter(event => event.type === 'progress').map(event => event.role), ['intent']);
  t.bridge.stop(); const length = t.client.sent.length;
  progress('flight'); release(); await tick();
  assert.equal(t.client.sent.length, length);
  assert.equal(t.s.busy, false);
});
test('correction while thinking aborts read-only work, serializes latest message and suppresses outdated speech', async () => {
  let finish, entered = false, calls = 0, running = 0, maxRunning = 0;
  const s = createSession();
  const t = setup(s, { chat: async (session, args, _env, options) => {
    calls++; running++; maxRunning = Math.max(maxRunning, running);
    try {
      if (!entered) {
        entered = true;
        options.onProgress('intent');
        await new Promise(resolve => { finish = resolve; });
        assert.equal(options.signal.aborted, true);
        options.onProgress('flight');
        options.signal.throwIfAborted();
      }
      options.onProgress('planner');
      assert.match(args.message, /台北到大阪/);
      assert.match(args.message, /不是十月，是十一月中/);
      session.discovery.datePreference = '十一月中';
      return { text: '改成十一月中，台北到大阪來回。想從桃園還是松山出發？', state: { quote: null, offers: [] } };
    } finally { running--; }
  } });
  try {
    await t.say('台北到大阪，來回十月中');
    const oldTurn = t.client.sent.findLast(event => event.type === 'transcript').turnId;
    assert.deepEqual(t.client.sent.filter(event => event.type === 'progress'), [{ type: 'progress', turnId: oldTurn, role: 'intent' }]);
    t.client.emit('message', Buffer.alloc(4800), true);
    assert.equal(t.upstream.sent.at(-1).type, 'input_audio_buffer.append', 'mic forwarded while model waits');
    t.upstream.event({ type: 'input_audio_buffer.speech_started' });
    await t.say('不是十月，是十一月中');
    assert.equal(s.busy, true);
    assert.equal(calls, 1, 'must wait for earlier work to settle');
    finish(); await tick(); await tick();
    assert.equal(maxRunning, 1);
    assert.equal(s.discovery.datePreference, '十一月中');
    assert.equal(t.client.sent.filter(event => event.type === 'result').length, 1);
    assert.equal(t.upstream.sent.filter(event => event.type === 'response.create').length, 1);
    assert.equal(t.client.sent.some(event => event.type === 'error'), false);
    assert.equal(s.busy, false);
    const newTurn = t.client.sent.findLast(event => event.type === 'transcript').turnId;
    assert.deepEqual(t.client.sent.filter(event => event.type === 'progress'), [
      { type: 'progress', turnId: oldTurn, role: 'intent' },
      { type: 'progress', turnId: newTurn, role: 'planner' }
    ]);
  } finally { t.bridge.stop(); }
});
test('barge-in cancels active synthesis and discards late audio without creating an automatic model answer', async () => {
  const t = setup();
  try {
    await t.say('您好');
    t.upstream.event({ type: 'response.created', response: { id: 'old-audio' } });
    t.upstream.event({ type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAAAAA==' });
    const audioCount = t.client.sent.filter(e => e.type === 'audio').length;
    t.upstream.event({ type: 'input_audio_buffer.speech_started' });
    assert.equal(t.upstream.sent.at(-1).type, 'response.cancel');
    t.upstream.event({ type: 'response.audio.delta', response_id: 'old-audio', delta: 'AAAAAA==' });
    t.upstream.event({ type: 'response.done', response: { id: 'old-audio', status: 'cancelled' } });
    assert.equal(t.client.sent.filter(e => e.type === 'audio').length, audioCount);
    assert.equal(t.client.sent.at(-1).type, 'interrupted');
    assert.equal(t.upstream.sent.filter(e => e.type === 'response.create').length, 1);
    assert.deepEqual(voiceSessionUpdate(voiceConfig(env)).session.input_audio_echo_cancellation,
      { type: 'server_echo_cancellation' });
  } finally { t.bridge.stop(); }
});
test('interrupting a transaction queues one follow-up without aborting, retrying or releasing its lock', async () => {
  let finish, transactions = 0, signal;
  const s = createSession();
  const t = setup(s, { chat: async (_session, args, _env, options) => {
    if (args.message === '重新報價') {
      options.onTransaction(); transactions++; signal = options.signal;
      await new Promise(resolve => { finish = resolve; });
    }
    return { text: args.message, state: { quote: null, offers: [] } };
  } });
  try {
    await t.say('重新報價');
    await t.say('不是十月，是十一月中');
    assert.equal(signal.aborted, false); assert.equal(s.busy, true);
    finish(); await tick(); await tick();
    assert.equal(transactions, 1); assert.equal(s.busy, false);
    assert.equal(t.client.sent.filter(e => e.type === 'result').length, 2);
    assert.equal(t.client.sent.some(e => e.type === 'error'), false);
  } finally { t.bridge.stop(); }
});
test('voice flight-time request persists through airport, departure, return, people and explicit economy answers', async () => {
  const t = setup();
  try {
    for (const text of ['從台北到大阪，搜尋航班，來回11月中', '都可以', '11月15號出發', '11月20號回來', '2人']) {
      const r = await t.say(text); assert.ok(r); t.displayed(r);
    }
    const r = await t.say('不要問我了，預設經濟艙，你給我時間先');
    assert.ok(r.result.state.offers.every(o => o.returnFlight));
    assert.match(r.result.text, /2026-11-15T/); assert.match(r.result.text, /2026-11-20T/);
    assert.doesNotMatch(r.result.text, /輸入「搜尋航班」|目前旅程/);
    assert.equal(t.s.trip.date, '2026-11-15'); assert.equal(t.s.trip.returnDate, '2026-11-20');
    assert.equal(t.s.bookings.size, 0);
    assert.ok(t.s.voice);
  } finally { t.bridge.stop(); }
});
test('voice preserves typed upstream diagnostics and logs no raw messages or credentials', async context => {
  const logger = context.mock.method(console, 'error', () => {});
  const error = new AppError('FOUNDRY_CONNECTION', '暫時無法連線至 AI 服務，請稍後重試。', 502);
  error.stage = 'responses.fetch'; error.elapsedMs = 120;
  error.cause = Object.assign(new TypeError('private user text and credential'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  const t = setup(createSession(), { chat: async () => { throw error; } });
  await t.say('private user transcript');
  const result = t.client.sent.find(e => e.type === 'error');
  assert.equal(result.code, 'FOUNDRY_CONNECTION');
  const log = JSON.parse(logger.mock.calls[0].arguments[0]);
  assert.equal(log.stage, 'responses.fetch'); assert.equal(log.causeCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(log.correlationId, result.correlationId);
  assert.doesNotMatch(JSON.stringify(log), /private|credential|transcript/);
  assert.equal(t.s.busy, false); assert.equal(t.s.voice, null);
});
test('voice and text share natural discovery, real handlers, displayed flight options, quote acceptance and checkout', async () => {
  const s = createSession();
  await chat(s, { message: '我想去日本玩幾天' }, { APP_MODE: 'mock' });
  const t = setup(s);
  try {
    let r = await t.say('想賞楓，五天，帶媽媽，不要走太多路。'); t.displayed(r);
    assert.equal(s.discovery.country, '日本'); assert.equal(s.draft.lowWalking, true);
    r = await t.say('東京好了，幫我安排五天。'); t.displayed(r);
    assert.equal(r.result.itinerary.days.length, 5); assert.equal(s.toolUnits, 0);
    r = await t.readAll(await t.say('從桃園到成田，2026-11-12出發，2026-11-16回程，2人，經濟艙，搜尋航班'));
    assert.ok(r.result.state.offers[0].returnFlight);
    r = await t.say('選第二班。'); t.displayed(r);
    assert.equal(s.selected, [...s.offers.keys()][1]);
    r = await t.readAll(await t.say('重新報價。'));
    const exactQuote = quoteContext(r.result.state);
    r = await t.say('我同意這個報價，請給我模擬結帳連結。');
    assert.match(r.result.text, /\/checkout\/[a-f0-9]{64}/);
    assert.equal(r.result.receipt.total, exactQuote.total);
    const speak = t.upstream.sent.findLast(e => e.type === 'response.create');
    assert.equal(speak.response.pre_generated_assistant_message.content[0].text, speechText(r.result.text));
    assert.equal(s.bookings.size, 1);
    t.upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-6', transcript: '我同意這個報價，請給我模擬結帳連結。' });
    await tick(); assert.equal(s.bookings.size, 1);
  } finally { t.bridge.stop(); }
});
test('unseen quote and stale delivered quote cannot be accepted by voice', async () => {
  for (const stale of [false, true]) {
    const s = createSession();
    let r = await readAll(s, await chat(s, { message: '從桃園到成田，2026-11-12，2人，經濟艙，搜尋航班' }, { APP_MODE: 'mock' }));
    await chat(s, { message: '選第二班', offerIds: r.state.offers.map(o => o.id) }, { APP_MODE: 'mock' });
    const t = setup(s);
    const quote = await t.say('重新報價。');
    if (stale) {
      await t.readAll(quote);
      await callTool(s, 'price', 'reprice_offer', { offerId: s.selected }, { priceDelta: 500 });
    }
    await t.say('我同意這個報價，請給我模擬結帳連結。');
    assert.equal(s.bookings.size, 0); assert.equal(s.consent, null);
    assert.equal(t.client.sent.at(-1).type, 'error');
    assert.equal(t.client.sent.at(-1).code, 'QUOTE_NOT_PRESENTED');
    assert.equal(s.voice, null); assert.equal(s.busy, false);
  }
});
test('Voice bridge rejects arbitrary events/audio and fails visibly on upstream errors; mute and cleanup work', async () => {
  const t = setup();
  t.client.emit('message', Buffer.alloc(4800), true);
  assert.equal(t.upstream.sent.at(-1).type, 'input_audio_buffer.append');
  t.client.event({ type: 'mute', muted: true });
  const before = t.upstream.sent.length;
  t.client.emit('message', Buffer.alloc(4800), true); assert.equal(t.upstream.sent.length, before);
  t.upstream.event({ type: 'response.created' });
  t.upstream.event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(t.upstream.sent.at(-1).type, 'response.cancel');
  assert.equal(t.client.sent.at(-1).type, 'interrupted');
  t.client.event({ type: 'response.create', instructions: 'bypass' });
  assert.equal(t.client.sent.at(-1).code, 'VOICE_PROTOCOL');
  assert.equal(t.upstream.readyState, WebSocket.CLOSED);
  assert.equal(t.s.voice, null);
  const u = setup();
  u.upstream.event({ type: 'error', error: { code: 'permission_denied' } });
  assert.match(u.client.sent.at(-1).message, /permission_denied/);
  assert.equal(u.s.voice, null);
  const b = setup();
  b.client.emit('message', Buffer.alloc(48002), true);
  assert.equal(b.client.sent.at(-1).code, 'VOICE_AUDIO');
});
test('HTTP/WS voice tickets are same-session, one-use, origin restricted, capped, no cloud credentials returned', async () => {
  let connections = 0;
  const server = createApp(env, { voice: {
    credential: { getToken: async () => ({ token: 'server-only-secret' }) },
    connect: () => {
      connections++; const upstream = new Socket();
      setImmediate(() => { upstream.emit('open'); upstream.event({ type: 'session.updated' }); });
      return upstream;
    }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let ws;
  try {
    const response = await fetch(`${base}/api/bootstrap`), cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(response.headers.get('permissions-policy'), 'microphone=(self), camera=(), geolocation=()');
    assert.equal((await response.json()).voice.available, true);
    const post = (data = {}, origin = base) => fetch(`${base}/api/voice/session`, {
      method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    assert.equal((await post({}, 'https://evil.invalid')).status, 403);
    assert.equal((await post({ endpoint: 'https://evil.invalid' })).status, 400);
    let ticket = await (await post()).json();
    assert.doesNotMatch(JSON.stringify(ticket), /server-only-secret|Bearer/);
    const wsurl = base.replace('http:', 'ws:') + ticket.path;
    async function denied(headers, nonce = ticket.nonce) {
      const socket = new WebSocket(wsurl, ['journey-voice', nonce], { headers });
      const status = await new Promise((resolve, reject) => {
        socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
        socket.on('open', () => { socket.close(); reject(new Error('unexpected open')); });
        socket.on('error', () => {});
      });
      assert.equal(status, 403);
    }
    await denied({ origin: 'https://evil.invalid', cookie });
    await denied({ origin: base, cookie: 'journey=other-session' });
    ticket = await (await post({ offerIds: [], quoteContext: null })).json();
    ws = new WebSocket(wsurl, ['journey-voice', ticket.nonce], { headers: { origin: base, cookie } });
    const ready = await once(ws, 'message'); assert.equal(JSON.parse(ready[0]).type, 'ready');
    assert.equal(connections, 1);
    await denied({ origin: base, cookie });
    assert.equal((await post()).status, 409);
    const close = once(ws, 'close'); ws.send(JSON.stringify({ type: 'stop' })); await close; await tick();
    const text = await fetch(`${base}/api/chat`, { method: 'POST', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '我想去日本玩幾天' }) });
    assert.equal(text.status, 200);
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
  } finally { ws?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
