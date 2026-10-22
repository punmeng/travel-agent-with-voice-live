import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { bridgeVoice, voiceConfig, voiceSessionUpdate, voiceModes, quoteContext, voiceResponseDetails } from '../lib/voice.js';
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
test('Realtime displays sources but only returns the source-free authoritative answer to the spoken frontend', async () => {
  const canonical = '航班均為模擬，時間未核驗。\n\n知識來源（合成示範靜態快照）：flights.txt';
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const t = setup(createSession(), { chat: async () => ({ text: canonical, state: { offers: [], activeAgent: 'flight' } }) }, config);
  try {
    await t.say('查詢航班');
    t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
    t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [
      { type: 'function_call', call_id: 'c1', name: 'travel_backend', arguments: '{"message":"查詢航班"}' }
    ] } });
    await tick();
    assert.equal(t.client.sent.find(e => e.type === 'result').result.text, canonical);
    const output = t.upstream.sent.find(e => e.item?.type === 'function_call_output');
    assert.equal(JSON.parse(output.item.output).text, '航班均為模擬，時間未核驗。');
    assert.match(voiceSessionUpdate(config).session.instructions, /不要朗讀/);
  } finally { t.bridge.stop(); }
});
test('source-only answers finish without blank synthesis while Realtime still acknowledges its function call', async () => {
  const modes = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' });
  for (const mode of ['voice-live', 'voice-realtime']) {
    const t = setup(createSession(), { chat: async () => ({
      text: '知識來源：flights.txt', state: { offers: [], activeAgent: 'flight' }
    }) }, modes[mode]);
    try {
      await t.say('查詢航班');
      if (mode === 'voice-realtime') {
        t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
        t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [
          { type: 'function_call', call_id: 'c1', name: 'travel_backend', arguments: '{"message":"查詢航班"}' }
        ] } });
        await tick();
        assert.equal(t.upstream.sent.filter(e => e.item?.type === 'function_call_output').length, 1);
      }
      assert.equal(t.client.sent.at(-1).type, 'audioDone');
      assert.equal(t.upstream.sent.filter(e => e.type === 'response.create').length, mode === 'voice-realtime' ? 1 : 0);
    } finally { t.bridge.stop(); }
  }
});
test('response diagnostics retain bounded known shapes only, never upstream messages, IDs or function arguments', () => {
  const details = voiceResponseDetails({ id: 'private-response-id', status: 'incomplete',
    status_details: { type: 'incomplete', reason: 'max_output_tokens', error: { code: 'private-voice-id', message: 'private-user-audio' } },
    output: [{ type: 'function_call', name: 'private-name', status: 'in_progress', call_id: 'private-call-id', arguments: '{"message":"private-transcript"}' }] });
  assert.equal(details.responseStatus, 'incomplete');
  assert.equal(details.reason, 'max_output_tokens');
  assert.equal(details.errorCategory, 'other');
  assert.equal(details.functionCallCount, 1);
  assert.deepEqual(details.items, [{ type: 'function_call', status: 'in_progress', expectedTool: false }]);
  assert.ok(!JSON.stringify(details).includes('private'));
  assert.equal(voiceResponseDetails({ output: Array(100).fill({ type: 'unknown-private' }) }).items.length, 8);
  assert.equal(voiceResponseDetails(null).outputCount, null);
});
function setup(s = createSession(), dependencies = {}, config = voiceConfig(env)) {
  const client = new Socket(), upstream = new Socket();
  const bridge = bridgeVoice(client, upstream, s, env, config, dependencies);
  upstream.emit('open'); upstream.event({ type: 'session.updated' });
  let count = 0;
  return { client, upstream, s, bridge,
    async say(text) {
      upstream.event({ type: config.realtime ? 'input_audio_buffer.committed' : 'conversation.item.input_audio_transcription.completed', item_id: `item-${++count}`, transcript: text });
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
test('four architectures are independently gated; Realtime requires exactly 2.1, no private ID or model fallback', () => {
  assert.deepEqual(Object.values(voiceModes({})), [null, null, null, null]);
  const configEnv = { ...env, VOICE_LIVE_VOICE_TYPE: 'azure-personal',
    VOICE_LIVE_PERSONAL_VOICE_NAME: 'offline-private-id', VOICE_LIVE_PERSONAL_VOICE_MODEL: 'DragonLatestNeural',
    VOICE_LIVE_STANDARD_ENABLED: 'true', VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' };
  const modes = voiceModes(configEnv);
  assert.equal(modes['voice-live'].outputVoice.type, 'azure-personal');
  for (const mode of ['voice-realtime']) {
    assert.deepEqual(modes[mode].outputVoice, { type: 'azure-standard', name: 'zh-TW-HsiaoChenNeural' });
    assert.ok(!JSON.stringify(modes[mode]).includes('offline-private-id'));
  }
  assert.equal(modes['voice-standard'], undefined, 'standard voice is not a separate architecture');
  assert.equal(modes['speech-direct'], null);
  assert.equal(modes['voice-realtime'].model, 'gpt-realtime-2.1');
  assert.equal(voiceModes({ ...configEnv, VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime' })['voice-realtime'], null);
  assert.equal(voiceSessionUpdate(modes['voice-realtime']).session.tools[0].name, 'travel_backend');
  assert.equal(voiceSessionUpdate(modes['voice-realtime']).session.input_audio_transcription, undefined);
  assert.equal(voiceSessionUpdate(modes['voice-realtime']).session.turn_detection.create_response, false);
  assert.equal(voiceSessionUpdate(modes['voice-realtime']).session.parallel_tool_calls, false);
  for (const model of ['', 'gpt-realtime-1', 'gpt-live-1', 'https://evil.example']) {
    assert.throws(() => voiceModes({ ...configEnv, VOICE_LIVE_REALTIME_MODEL: model }), /explicitly/);
  }
});
test('standard voice uses the unchanged four-agent exact-text path with standard Neural only', async () => {
  const config = voiceConfig(env);
  const t = setup(createSession(), {}, config);
  try {
    const result = await t.say('我想去日本玩幾天');
    assert.ok(result);
    assert.deepEqual(t.upstream.sent[0].session.voice, { type: 'azure-standard', name: 'zh-TW-HsiaoChenNeural' });
    assert.equal(t.upstream.sent.at(-1).response.pre_generated_assistant_message.content[0].text, speechText(result.result.text));
  } finally { t.bridge.stop(); }
});
test('Realtime receives native model tool requests, delegates real travel backend and rejects transaction before writes', async () => {
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const t = setup(createSession(), {}, config);
  try {
    await t.say('我想去日本');
    assert.equal(t.s.turns, 0, 'committed native audio triggers model response without any STT result');
    assert.deepEqual(t.upstream.sent.at(-1).response.tool_choice, { type: 'function', name: 'travel_backend' });
    t.upstream.event({ type: 'response.created', response: { id: 'response_1' } });
    t.upstream.event({ type: 'response.function_call_arguments.done', response_id: 'response_1',
      call_id: 'call_1', arguments: JSON.stringify({ message: '我想去日本玩幾天' }) });
    await tick();
    assert.equal(t.s.turns, 0, 'arguments.done may be incomplete/cancelled and does not include a tool name');
    t.upstream.event({ type: 'response.done', response: { id: 'response_1', status: 'completed', output: [
      { type: 'function_call', status: 'completed', call_id: 'call_1', name: 'travel_backend',
        arguments: JSON.stringify({ message: '我想去日本玩幾天' }) }
    ] } });
    await tick();
    assert.equal(t.s.turns, 1);
    assert.ok(t.client.sent.some(e => e.type === 'result'));
    assert.equal(t.client.sent.find(e => e.type === 'transcript').text, '語音前端委派（非原始逐字稿）：我想去日本玩幾天');
    const output = t.upstream.sent.find(e => e.item?.type === 'function_call_output');
    assert.equal(output.item.call_id, 'call_1');
    assert.match(output.item.output, /日本/);
    assert.equal(t.upstream.sent.at(-1).response.tool_choice, 'none');
    await t.say('重新報價');
    t.upstream.event({ type: 'response.created', response: { id: 'response_2' } });
    t.upstream.event({ type: 'response.done', response: { id: 'response_2', status: 'completed', output: [
      { type: 'function_call', status: 'completed', call_id: 'call_2', name: 'travel_backend',
        arguments: JSON.stringify({ message: '重新報價' }) }
    ] } });
    await tick();
    assert.equal(t.client.sent.at(-1).code, 'VOICE_REALTIME_TRANSACTION');
    assert.equal(t.s.quote, null);
    assert.equal(t.s.bookings.size, 0);
  } finally { t.bridge.stop(); }
});
test('Realtime rejects injected tool arguments and uncorrelated functions without backend calls', async () => {
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  for (const args of [{ message: '日本', quoteContext: { accepted: true } }, { message: '' }]) {
    let calls = 0;
    const t = setup(createSession(), { chat: async () => { calls++; } }, config);
    try {
      await t.say('日本');
      t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
      t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [
        { type: 'function_call', status: 'completed', call_id: 'c1', name: 'travel_backend', arguments: JSON.stringify(args) }
      ] } });
      await tick();
      assert.equal(t.client.sent.at(-1).code, 'VOICE_REALTIME_TOOL');
      assert.equal(calls, 0);
    } finally { t.bridge.stop(); }
  }
});
test('Realtime accepts one completed-response call with optional item status and non-call items, dispatching only once', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  for (const status of ['completed', undefined]) {
    for (const extras of [[], [{ type: 'reasoning', summary: 'private-reasoning' }],
      [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: 'private-model-answer' }] }],
      [{ type: 'message', content: [{ type: 'text', text: 'private-model-answer' }] }, { type: 'reasoning' }]]) {
      let calls = 0, release;
      const t = setup(createSession(), { chat: async (_session, args) => {
        calls++;
        assert.equal(args.message, '日本');
        await new Promise(resolve => { release = resolve; });
        return { text: '後端結果', state: { offers: [] } };
      } }, config);
      try {
        await t.say('日本');
        t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
        t.upstream.event({ type: 'response.function_call_arguments.done', response_id: 'r1',
          call_id: 'c1', arguments: '{"message":"日本"}' });
        t.upstream.event({ type: 'response.output_item.done', response_id: 'r1',
          item: { type: 'function_call', status, call_id: 'c1', name: 'travel_backend', arguments: '{"message":"日本"}' } });
        assert.equal(calls, 0);
        const done = { type: 'response.done', response: { id: 'r1', status: 'completed', output: [
          ...extras, { type: 'function_call', status, call_id: 'c1', name: 'travel_backend', arguments: '{"message":"日本"}' }
        ] } };
        t.upstream.event(done); t.upstream.event(done);
        await tick();
        assert.equal(calls, 1);
        assert.equal(t.s.busy, true);
        release(); await tick();
        assert.equal(t.s.busy, false);
        const sent = t.upstream.sent.length, received = t.client.sent.length;
        t.upstream.event({ type: 'response.created', response: { id: 'spoken-answer' } });
        t.upstream.event(done); await tick();
        assert.equal(t.upstream.sent.length, sent);
        assert.equal(t.client.sent.length, received);
        assert.equal(t.upstream.sent.filter(e => e.item?.type === 'function_call_output').length, 1);
        const result = t.client.sent.find(e => e.type === 'result');
        assert.equal(result.result.text, '後端結果');
        t.upstream.event({ type: 'response.audio.delta', response_id: 'spoken-answer', delta: 'AAA=' });
        t.upstream.event({ type: 'response.done', response: { id: 'spoken-answer', status: 'completed',
          output: [{ type: 'message', role: 'assistant', status: 'completed' }] } });
        assert.equal(t.client.sent.at(-1).type, 'audioDone');
        assert.equal(t.client.sent.find(e => e.type === 'audio').audio, 'AAA=');
        assert.equal(calls, 1);
        context.mock.timers.tick(20001);
        assert.equal(t.client.sent.some(e => e.type === 'error'), false);
        assert.ok(!JSON.stringify(t.client.sent).includes('private'));
      } finally { release?.(); t.bridge.stop(); }
    }
  }
});
test('Realtime refuses uncorrelated response completion and reused call IDs with safe failure reasons', async context => {
  const logs = [];
  context.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const call = { type: 'function_call', call_id: 'c1', name: 'travel_backend', arguments: '{"message":"日本"}' };
  for (const correlated of [false, true]) {
    let calls = 0;
    const t = setup(createSession(), { chat: async () => {
      calls++; return { text: '後端結果', state: { offers: [] } };
    } }, config);
    try {
      await t.say('日本');
      if (correlated) {
        t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
        t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [call] } });
        await tick();
        assert.equal(calls, 1);
        await t.say('日本');
        t.upstream.event({ type: 'response.created', response: { id: 'r2' } });
      }
      t.upstream.event({ type: 'response.done', response: { id: correlated ? 'r2' : 'r1', status: 'completed', output: [call] } });
      await tick();
      assert.equal(calls, correlated ? 1 : 0);
      assert.equal(t.client.sent.at(-1).code, 'VOICE_REALTIME_TOOL');
      assert.equal(logs.at(-1).delegationFailure, correlated ? 'duplicate_call' : 'response_mismatch');
      assert.equal(logs.at(-1).functionCallCount, 1);
    } finally { t.bridge.stop(); }
  }
});
test('Realtime rejection diagnostics distinguish shape, correlation, JSON and schema failures without leaking content', async context => {
  const logs = [];
  context.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const call = { type: 'function_call', call_id: 'private-call', name: 'travel_backend', arguments: '{"message":"private-transcript"}' };
  const cases = [
    [{ status: 'incomplete', output: [call] }, 'response_not_completed'],
    [{ status: 'completed', output: null }, 'output_not_array'],
    [{ status: 'completed', output: [] }, 'function_call_count'],
    [{ status: 'completed', output: [call, call] }, 'function_call_count'],
    ...['in_progress', 'incomplete', null, 'other'].map(status =>
      [{ status: 'completed', output: [{ ...call, status }] }, 'call_not_completed']),
    [{ status: 'completed', output: [call, { type: 'function_call_output', output: 'private-transcript' }] }, 'unexpected_output_item'],
    [{ status: 'completed', output: [{ ...call, name: 'private-tool' }] }, 'unexpected_tool'],
    ...['', 'bad id', 'x'.repeat(129), null].map(call_id =>
      [{ status: 'completed', output: [{ ...call, call_id }] }, 'invalid_call_id']),
    ...[{}, null, 'x'.repeat(24001)].map(argumentsValue =>
      [{ status: 'completed', output: [{ ...call, arguments: argumentsValue }] }, 'arguments_type_or_size']),
    [{ status: 'completed', output: [{ ...call, arguments: 'private-invalid-json' }] }, 'arguments_json'],
    ...[{}, null, [], 'private-transcript', { message: '' }, { message: '   ' }, { message: 42 },
      { message: 'x'.repeat(2001) }, { message: 'private-transcript', quoteContext: {} }].map(args =>
      [{ status: 'completed', output: [{ ...call, arguments: JSON.stringify(args) }] }, 'arguments_schema'])
  ];
  for (const [response, reason] of cases) {
    let calls = 0;
    const t = setup(createSession(), { chat: async () => { calls++; } }, config);
    try {
      await t.say('日本');
      t.upstream.event({ type: 'response.created', response: { id: 'private-response' } });
      t.upstream.event({ type: 'response.done', response: { id: 'private-response', ...response } });
      await tick();
      assert.equal(calls, 0);
      assert.equal(t.client.sent.at(-1).code, 'VOICE_REALTIME_TOOL');
      assert.equal(logs.at(-1).delegationFailure, reason);
      assert.equal(logs.at(-1).outputCount, Array.isArray(response.output) ? response.output.length : null);
      assert.equal(logs.at(-1).functionCallCount, Array.isArray(response.output) ? response.output.filter(i => i.type === 'function_call').length : null);
      assert.equal(logs.at(-1).correlationId, t.client.sent.at(-1).correlationId);
      assert.ok(!JSON.stringify(logs.at(-1)).includes('private'));
      assert.equal(t.upstream.sent.some(e => e.item?.type === 'function_call_output'), false);
    } finally { t.bridge.stop(); }
  }
});
test('HTTP tickets select bridge or exact Realtime2.1 upstream without accepting browser model overrides', async () => {
  const urls = [], updates = [];
  const server = createApp({ ...env, VOICE_LIVE_STANDARD_ENABLED: 'true', VOICE_LIVE_REALTIME_ENABLED: 'true',
    VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' }, { voice: {
    credential: { getToken: async () => ({ token: 'offline-only' }) },
    connect: url => {
      urls.push(url);
      const upstream = new Socket();
      const send = upstream.send.bind(upstream);
      upstream.send = value => { updates.push(JSON.parse(value)); send(value); };
      setImmediate(() => { upstream.emit('open'); upstream.event({ type: 'session.updated' }); });
      return upstream;
    }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [mode, model] of [['voice-live', 'gpt-5.4'], ['voice-realtime', 'gpt-realtime-2.1']]) {
      const response = await fetch(`${origin}/api/bootstrap`, { headers: { connection: 'close' } }), cookie = response.headers.get('set-cookie').split(';')[0];
      await response.arrayBuffer();
      const post = data => fetch(`${origin}/api/voice/session`, { method: 'POST',
        headers: { cookie, origin, connection: 'close', 'content-type': 'application/json' }, body: JSON.stringify(data) });
      assert.equal((await post({ mode, model: 'gpt-live-1' })).status, 400);
      const ticket = await (await post({ mode })).json();
      const socket = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
      try {
        await once(socket, 'message');
        assert.equal(urls.at(-1).pathname, '/voice-live/realtime');
        assert.equal(urls.at(-1).searchParams.get('model'), model);
        assert.equal(urls.at(-1).searchParams.get('api-version'), '2026-07-15');
        assert.deepEqual(updates.at(-1).session.voice, { type: 'azure-standard', name: 'zh-TW-HsiaoChenNeural' });
        socket.close(); await once(socket, 'close');
      } finally { socket.terminate(); }
    }
  } finally { server.closeAllConnections(); server.close(); }
});
test('Realtime ignores incomplete argument events and fails closed on cancelled, multiple or timed-out delegation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const item = { type: 'function_call', status: 'completed', call_id: 'c1', name: 'travel_backend', arguments: '{"message":"日本"}' };
  for (const response of [
    { id: 'r1', status: 'cancelled', output: [item] },
    { id: 'r1', status: 'completed', output: [item, { ...item, call_id: 'c2' }] },
    { id: 'r1', status: 'completed', output: [{ ...item, name: 'purchase' }] },
    null
  ]) {
    let calls = 0;
    const t = setup(createSession(), { chat: async () => { calls++; } }, config);
    try {
      await t.say('日本');
      t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
      t.upstream.event({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', arguments: item.arguments });
      assert.equal(calls, 0);
      if (response) t.upstream.event({ type: 'response.done', response });
      else context.mock.timers.tick(20001);
      assert.equal(calls, 0);
      assert.equal(t.client.sent.at(-1).code, response ? 'VOICE_REALTIME_TOOL' : 'VOICE_REALTIME_TIMEOUT');
    } finally { t.bridge.stop(); }
  }
});
test('tool shape failures log only bounded metadata and never dispatch malformed responses', async context => {
  const logs = [];
  context.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  let calls = 0;
  for (const output of [
    [],
    [{ type: 'function_call', name: 'travel_backend', arguments: 'private-transcript', call_id: 'private-id' }],
    [{ type: 'message', status: 'completed', content: 'private-transcript' }, { type: 'function_call', status: 'completed' }]
  ]) {
    const t = setup(createSession(), { chat: async () => { calls++; } }, config);
    try {
      await t.say('日本');
      t.upstream.event({ type: 'response.created', response: { id: 'private-response' } });
      t.upstream.event({ type: 'response.done', response: { id: 'private-response', status: 'completed', output } });
      assert.equal(t.client.sent.at(-1).code, 'VOICE_REALTIME_TOOL');
      assert.equal(logs.at(-1).outputCount, output.length);
      assert.ok(!JSON.stringify(logs.at(-1)).includes('private'));
    } finally { t.bridge.stop(); }
  }
  assert.equal(calls, 0);
});
test('failed frontend and synthesis responses have separate safe diagnostics without raw service messages', async context => {
  const logs = [];
  context.mock.method(console, 'error', value => logs.push(JSON.parse(value)));
  const realtime = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  for (const config of [voiceConfig(env), realtime]) {
    const t = setup(createSession(), {}, config);
    try {
      await t.say('日本');
      t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
      t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'failed', output: [],
        status_details: { type: 'failed', error: { code: 'voice_not_found', message: 'private-voice-id' } } } });
      assert.equal(t.client.sent.at(-1).code, config.realtime ? 'VOICE_REALTIME_RESPONSE' : 'VOICE_SYNTHESIS');
      assert.equal(logs.at(-1).errorCategory, 'voice_not_found');
      assert.equal(logs.at(-1).responseStatus, 'failed');
      assert.ok(!JSON.stringify(logs.at(-1)).includes('private'));
    } finally { t.bridge.stop(); }
  }
});
test('stopping Realtime cancels read-only delegated work without prematurely unlocking backend state', async () => {
  let release;
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  const t = setup(createSession(), { chat: async (_s, _args, _env, deps) => {
    await new Promise(resolve => { release = resolve; });
    deps.signal.throwIfAborted();
  } }, config);
  await t.say('日本');
  t.upstream.event({ type: 'response.created', response: { id: 'r1' } });
  t.upstream.event({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [
    { type: 'function_call', status: 'completed', call_id: 'c1', name: 'travel_backend', arguments: '{"message":"日本"}' }
  ] } });
  await tick();
  try {
    assert.equal(t.s.busy, true);
    t.bridge.stop();
    assert.equal(t.s.busy, true);
    release(); await tick();
    assert.equal(t.s.busy, false);
    assert.ok(!t.client.sent.some(e => e.type === 'result'));
  } finally { release?.(); t.bridge.stop(); }
});
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
  assert.throws(() => voiceConfig({ ...configured, VOICE_LIVE_VOICE_TYPE: 'azure-custom' }), /Professional Voice/);
});
test('Professional Voice is an explicit future asset seam, not Personal Voice or a fallback', () => {
  const config = voiceConfig({ ...env, VOICE_LIVE_VOICE_TYPE: 'azure-custom',
    VOICE_LIVE_CUSTOM_VOICE_NAME: 'offline-custom', VOICE_LIVE_CUSTOM_VOICE_ENDPOINT_ID: '12345678-1234-1234-1234-123456789abc' });
  assert.deepEqual(config.outputVoice, { type: 'azure-custom', name: 'offline-custom', endpoint_id: '12345678-1234-1234-1234-123456789abc' });
  assert.equal(config.voice, 'professional-voice');
});
test('Realtime dispatch uses committed audio, never late optional STT, and deduplicates responses', async () => {
  const config = voiceModes({ ...env, VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1' })['voice-realtime'];
  let calls = 0;
  const t = setup(createSession(), { chat: async () => { calls++; } }, config);
  try {
    t.upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x', transcript: '不應觸發' });
    t.upstream.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'x' });
    assert.equal(t.upstream.sent.filter(e => e.type === 'response.create').length, 0);
    assert.equal(t.client.readyState, WebSocket.OPEN);
    t.upstream.event({ type: 'input_audio_buffer.speech_started', item_id: 'x' });
    t.upstream.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'x' });
    t.upstream.event({ type: 'input_audio_buffer.committed', item_id: 'x' });
    t.upstream.event({ type: 'input_audio_buffer.committed', item_id: 'x' });
    t.upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x', transcript: '仍不觸發' });
    assert.equal(t.upstream.sent.filter(e => e.type === 'response.create').length, 1);
    assert.equal(calls, 0);
    assert.ok(t.client.sent.some(e => e.type === 'measurement' && e.stage === 'endpoint'));
    assert.ok(!JSON.stringify(t.client.sent.filter(e => e.type === 'measurement')).includes('不觸發'));
  } finally { t.bridge.stop(); }
});
test('runtime health identifies personal output type without exposing its resource identifier', async () => {
  const privateName = 'offline-private-resource-id';
  const server = createApp({ ...env, VOICE_LIVE_VOICE_TYPE: 'azure-personal',
    VOICE_LIVE_PERSONAL_VOICE_NAME: privateName, VOICE_LIVE_PERSONAL_VOICE_MODEL: 'DragonLatestNeural' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/api/health`, { headers: { connection: 'close' } });
    const body = await response.json();
    assert.deepEqual(body.voice, { available: true, type: 'azure-personal',
      modes: { 'voice-live': { available: true }, 'gpt-live': { available: false },
        'voice-realtime': { available: false, requiredModel: 'gpt-realtime-2.1', configuredModel: null }, 'speech-direct': { available: false, sttModes: ['rest', 'sdk'] } } });
    assert.ok(!JSON.stringify(body).includes(privateName));
    const bootstrap = await (await fetch(`${origin}/api/bootstrap`, { headers: { connection: 'close' } })).text();
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
test('HTTP/WS voice tickets are same-session, one-use, origin restricted and allow repeated connections without credentials returned', async () => {
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post();
      assert.equal(response.status, 200);
      ticket = await response.json();
      ws = new WebSocket(wsurl, ['journey-voice', ticket.nonce], { headers: { origin: base, cookie } });
      const ready = await once(ws, 'message');
      assert.equal(JSON.parse(ready[0]).type, 'ready');
      const close = once(ws, 'close');
      ws.send(JSON.stringify({ type: 'stop' }));
      await close; await tick();
    }
    assert.equal(connections, 6);
  } finally { ws?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
