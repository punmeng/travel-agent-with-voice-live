import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { VoiceAgentRealtimeClient } from '@azure/ai-projects';
import { createSession } from '../lib/core.js';
import { MAX_TURNS } from '../lib/limits.js';
import { bridgeFoundryVoiceAgent, foundryVoiceAgentDefinition, foundryVoiceSessionConfig,
  memberDemoVoiceLocaleSettings, sessionLocaleMismatch, travelBackendTool, voiceTranscriptComparison } from '../lib/voice-agent.js';

test('terminal tolerance is limited to explicit sentence marks and rejects ambiguous or meaningful changes', () => {
  for (const mark of ['。', '.', '？', '?', '！', '!']) {
    assert.equal(voiceTranscriptComparison(`前往東京${mark}`, '前往東京').terminalOnlyEqual, true);
  }
  for (const [original, message] of [
    ['Tokyo.', 'Tokyo'], ['Show flights!', 'Show flights?']
  ]) assert.equal(voiceTranscriptComparison(original, message).terminalOnlyEqual, true);
  for (const [original, message] of [
    ['Pay 1.', 'Pay 1'], ['Pay 1.5', 'Pay 15'], ['Pay -5.', 'Pay 5'],
    ['Pay -5', 'Pay 5'], ['Pay 1.50.', 'Pay 1.50'], ['Ask Dr.', 'Ask Dr'],
    ['Visit U.S.', 'Visit U.S'], ['About approx.', 'About approx'],
    ['Company Corp.', 'Company Corp'], ['Tokyo...', 'Tokyo'], ['Tokyo!!', 'Tokyo'],
    ['Tokyo,', 'Tokyo'], ['Tokyo;', 'Tokyo'], ['Tokyo—', 'Tokyo'],
    ['A-B.', 'AB'], ['A/B?', 'AB'], ['1,000.', '1000'], ['No stops.', 'Stops'],
    ['Direct flights.', 'Nonstop flights'], ['Go Tokyo .', 'Go Tokyo']
  ]) {
    const comparison = voiceTranscriptComparison(original, message);
    assert.equal(comparison.terminalOnlyEqual, false, `${original} / ${message}`);
    assert.equal(comparison.whitespaceEqual, false);
  }
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }

class Client extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  audio(bytes = [0, 0]) { this.emit('message', Buffer.from(bytes), true); }
}

class Connection {
  constructor(effectiveSession) { this.effectiveSession = effectiveSession; }
  sentAudio = [];
  sentOutputs = [];
  responses = [];
  cancellations = [];
  audioCommits = 0;
  cleared = 0;
  queue = [];
  waiters = [];
  ended = false;
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
  event(event) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
  async configureSession(config) {
    this.config = config;
    this.event({ type: 'session.updated', session: this.effectiveSession, event_id: 'session-update-ack' });
  }
  async sendAudio(audio) { this.sentAudio.push(Buffer.from(audio)); }
  async commitAudio() { this.audioCommits++; }
  async sendToolOutput(callId, output, options) { this.sentOutputs.push({ callId, output, options }); }
  async requestResponse(options) { this.responses.push(options); }
  async cancelResponse(options) { this.cancellations.push(options); }
  async clearOutputAudio() {
    this.cleared++;
    this.event({ type: 'error', error: { type: 'invalid_request_error', code: 'avatar_not_configured',
      param: 'output_audio_buffer.clear', message: 'output_audio_buffer.clear is only supported in avatar mode.' } });
  }
  async clearInputAudio() {}
  async close() { this.ended = true; this.waiters.splice(0).forEach(resolve => resolve({ done: true })); }
}

function effectiveSession(locale) {
  const settings = memberDemoVoiceLocaleSettings(locale);
  return { type: 'realtime', instructions: settings.instructions,
    tools: [travelBackendTool], tool_choice: { type: 'function', name: 'travel_backend' }, parallel_tool_calls: false,
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: settings.transcription,
        turn_detection: { type: 'azure_semantic_vad_multilingual', create_response: false, interrupt_response: false },
        echo_cancellation: { type: 'server_echo_cancellation', reference_source: 'server', channels: 1 } },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice: settings.outputVoice }
    } };
}

function harness({ locale = 'zh-TW', effectiveSession: sessionResponse, chat = async () => ({ text: '已完成規劃。', speech: { text: '已完成規劃。' },
  state: { offers: [], quote: null, activeAgent: 'intent' } }) } = {}) {
  const client = new Client(), connection = new Connection(sessionResponse ?? effectiveSession(locale)), session = Object.assign(createSession(), { locale });
  const bridge = bridgeFoundryVoiceAgent(client, connection, session, { APP_MODE: 'mock' },
    { locale, startupGreetingType: 'llm_generated' }, { chat });
  return { client, connection, session, bridge };
}

function delegate(connection, responseId, inputItem, callId, message) {
  connection.event({ type: 'response.created', response: { id: responseId } });
  connection.event({ type: 'response.done', response: { id: responseId, status: 'completed', output: [
    { type: 'function_call', status: 'completed', name: travelBackendTool.name, call_id: callId,
      arguments: JSON.stringify({ message }) }
  ] } });
}

test('managed input ACK waits for SDK completion and preserves serial byte offsets across mute', async () => {
  const t = harness();
  let release;
  try {
    await settle();
    assert.deepEqual(t.client.sent.find(event => event.type === 'ready').inputFlow, { maxUnackedBytes: 12288 });
    t.connection.sendAudio = async audio => {
      await new Promise(resolve => { release = resolve; });
      t.connection.sentAudio.push(Buffer.from(audio));
    };
    t.client.audio(Buffer.alloc(4096));
    await settle();
    t.client.event({ type: 'mute', muted: true });
    t.client.audio(Buffer.alloc(4096));
    await settle();
    assert.equal(t.client.sent.filter(event => event.type === 'inputAudioAck').length, 0);
    release();
    await settle();
    assert.deepEqual(t.client.sent.filter(event => event.type === 'inputAudioAck').map(event => event.receivedBytes),
      [4096, 8192]);
    assert.equal(t.connection.sentAudio.length, 1, 'muted in-flight packet consumes credit without reaching SDK');
    assert.equal(t.client.readyState, WebSocket.OPEN);
  } finally { release?.(); t.bridge.stop(); await t.bridge.done; }
});

test('managed pending-send limit reproduces the fourth 4096-byte packet without widening the bound', async context => {
  const logs = [];
  context.mock.method(console, 'error', raw => logs.push(JSON.parse(raw)));
  const t = harness();
  let release;
  try {
    await settle();
    t.connection.sendAudio = () => new Promise(resolve => { release = resolve; });
    for (let i = 0; i < 3; i++) { t.client.audio(Buffer.alloc(4096)); await settle(); }
    assert.equal(t.client.readyState, WebSocket.OPEN);
    assert.equal(t.client.sent.filter(event => event.type === 'inputAudioAck').length, 0);
    t.client.audio(Buffer.alloc(4096));
    assert.equal(t.client.sent.at(-1).code, 'VOICE_AUDIO_LIMIT');
    assert.equal(logs.at(-1).limitReason, 'pending_send');
    assert.equal(logs.at(-1).queuedBytes, 12288);
    assert.equal(logs.at(-1).packetBytes, 4096);
    assert.equal(logs.at(-1).inputDiagnostics.audio.sdkAppendBytes, 0);
  } finally { release?.(); t.bridge.stop(); await t.bridge.done; }
});

test('managed failed SDK append never acknowledges input credit', async context => {
  context.mock.method(console, 'error', () => {});
  const t = harness();
  try {
    await settle();
    t.connection.sendAudio = async () => { throw new Error('injected offline failure'); };
    t.client.audio(Buffer.alloc(4096));
    await settle();
    assert.equal(t.client.sent.at(-1).code, 'VOICE_AGENT_CONNECTION');
    assert.equal(t.client.sent.filter(event => event.type === 'inputAudioAck').length, 0);
  } finally { t.bridge.stop(); await t.bridge.done; }
});

test('managed input rate limit still rejects a burst even when every SDK append completes', async context => {
  const logs = [];
  context.mock.method(console, 'error', raw => logs.push(JSON.parse(raw)));
  context.mock.method(Date, 'now', () => 1000);
  const t = harness();
  try {
    await settle();
    for (let i = 0; i < 36; i++) { t.client.audio(Buffer.alloc(4096)); await settle(); }
    assert.equal(t.client.sent.at(-1).code, 'VOICE_AUDIO_LIMIT');
    assert.equal(logs.at(-1).limitReason, 'input_rate');
    assert.equal(logs.at(-1).queuedBytes, 0);
    assert.equal(logs.at(-1).windowBytes, 147456);
    assert.equal(t.client.sent.filter(event => event.type === 'inputAudioAck').length, 35);
  } finally { t.bridge.stop(); await t.bridge.done; }
});

test('managed stop while SDK send is pending never ACKs or logs a late send failure', async context => {
  const logs = [];
  context.mock.method(console, 'error', raw => logs.push(raw));
  const t = harness();
  let reject;
  await settle();
  t.connection.sendAudio = () => new Promise((_resolve, fail) => { reject = fail; });
  t.client.audio(Buffer.alloc(4096));
  await settle();
  t.client.event({ type: 'stop' });
  reject(new Error('offline close-race'));
  await settle();
  assert.equal(t.client.sent.some(event => event.type === 'inputAudioAck'), false);
  assert.deepEqual(logs, []);
  assert.equal(t.bridge.diagnostics.inputFlow.sdkPending, false);
  await t.bridge.flushDiagnostics();
});

test('managed timeout diagnostics are numeric only and do not authorize any additional input', async context => {
  const info = [];
  context.mock.method(console, 'info', raw => info.push(JSON.parse(raw)));
  context.mock.method(console, 'error', () => {});
  const t = harness();
  try {
    await settle();
    t.client.event({ type: 'inputFlowDiagnostic', sentBytes: 12288, acknowledgedBytes: 4096,
      ackEvents: 1, lastAckAgeMs: 2001, pendingAgeMs: 2100, bufferedBytes: 0 });
    assert.equal(info[0].code, 'VOICE_INPUT_ACK_TIMEOUT');
    assert.equal(t.bridge.diagnostics.inputFlow.client.ackEvents, 1);
    t.client.event({ type: 'inputFlowDiagnostic', sentBytes: 12288, acknowledgedBytes: 0,
      ackEvents: 0, lastAckAgeMs: 2001, pendingAgeMs: 2100, bufferedBytes: 0, text: 'not allowed' });
    assert.equal(t.client.sent.at(-1).code, 'VOICE_AGENT_PROTOCOL');
  } finally { await t.bridge.flushDiagnostics(); }
});

test('Azure SDK 2.9 serializes PCM audio as base64 append and explicit commit separately from response creation', async () => {
  const sent = [];
  let handlers;
  const transport = {
    setHandlers(value) { handlers = value; },
    async connect() {},
    async send(serialized) { sent.push(JSON.parse(serialized)); },
    async close() {}
  };
  const client = new VoiceAgentRealtimeClient('https://voice.example.test', {
    async getToken() { return { token: 'offline-test-token' }; }
  }, { webSocketFactory: { create: () => transport } });
  const connection = await client.connect('ni-member-demo');
  try {
    await connection.configureSession(foundryVoiceSessionConfig(), { eventId: 'offline-config-request' });
    assert.deepEqual(sent.shift(), {
      type: 'session.update', session: { type: 'realtime' }, event_id: 'offline-config-request'
    });
    const pcm = Buffer.from([0, 1, 2, 255]);
    await connection.sendAudio(pcm);
    await connection.commitAudio();
    await connection.requestResponse();
    assert.deepEqual(sent[0], {
      type: 'input_audio_buffer.append',
      audio: pcm.toString('base64')
    });
    assert.deepEqual(sent.slice(1).map(event => event.type), [
      'input_audio_buffer.commit',
      'response.create'
    ]);
    assert.equal(Buffer.from(sent[0].audio, 'base64').toString('hex'), pcm.toString('hex'));
    handlers.onMessage(JSON.stringify({
      type: 'response.output_audio.delta', event_id: 'audio-wire-event', item_id: 'audio-wire-item',
      response_id: 'audio-wire-response', output_index: 0, content_index: 0,
      delta: pcm.toString('base64')
    }));
    const iterator = connection[Symbol.asyncIterator]();
    const event = await iterator.next();
    assert.ok(event.value.delta instanceof Uint8Array, 'SDK decodes wire base64 before the bridge sees audio');
    assert.deepEqual(Buffer.from(event.value.delta), pcm);
    handlers.onMessage(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'final-event', item_id: 'committed-input', content_index: 0, transcript: 'Final request.'
    }));
    const final = (await iterator.next()).value;
    assert.equal(final.type, 'conversation.item.input_audio_transcription.completed');
    assert.equal(final.item_id, 'committed-input');
    assert.equal(final.content_index, 0);
    assert.equal(final.transcript, 'Final request.');
  } finally {
    await connection.close();
  }
});

test('mono bridge waits for effective server-reference audio settings instead of accepting persisted client stereo', async () => {
  const actual = effectiveSession('zh-TW');
  actual.audio.input.echo_cancellation = {
    type: 'server_echo_cancellation', reference_source: 'client', channels: 2
  };
  const t = harness({ effectiveSession: actual });
  try {
    await settle();
    assert.equal(t.client.sent.some(event => event.type === 'ready'), false);
    assert.equal(t.connection.sentAudio.length, 0);
    assert.equal(t.connection.ended, false, 'initial unsolicited defaults must not preempt the requested ACK');
    t.connection.event({ type: 'session.updated', session: effectiveSession('zh-TW') });
    await settle();
    assert.equal(t.client.sent.filter(event => event.type === 'ready').length, 1);
    t.client.audio();
    await settle();
    assert.equal(t.connection.sentAudio.length, 1);
  } finally { await t.bridge.flushDiagnostics(); }
});

test('unapplied stereo audio defaults fail explicitly at the bounded handshake without sending PCM', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const actual = effectiveSession('en-US');
  actual.audio.input.echo_cancellation.reference_source = 'client';
  actual.audio.input.echo_cancellation.channels = 2;
  const t = harness({ locale: 'en-US', effectiveSession: actual });
  try {
    await settle();
    context.mock.timers.tick(20000);
    await settle();
    assert.equal(t.client.sent.some(event => event.type === 'ready'), false);
    assert.equal(t.client.sent.find(event => event.type === 'error')?.code, 'VOICE_AGENT_AUDIO_UNAPPLIED');
    assert.match(t.client.sent.find(event => event.type === 'error').message, /required mono PCM/);
    assert.equal(t.connection.sentAudio.length, 0);
    assert.equal(t.connection.audioCommits, 0);
  } finally { await t.bridge.flushDiagnostics(); }
});

test('service rejection of immutable echo channels closes before ready and preserves diagnostic error metadata', async () => {
  const actual = effectiveSession('zh-TW');
  actual.audio.input.echo_cancellation.reference_source = 'client';
  actual.audio.input.echo_cancellation.channels = 2;
  const t = harness({ effectiveSession: actual });
  try {
    await settle();
    t.connection.event({ type: 'error', error: {
      type: 'invalid_request_error', code: 'change_in_ec_channels_not_allowed',
      param: 'session.input_audio_echo_cancellation', message: 'PRIVATE_SERVICE_MESSAGE_SENTINEL'
    } });
    await settle();
    assert.equal(t.client.sent.some(event => event.type === 'ready'), false);
    assert.equal(t.client.sent.find(event => event.type === 'error')?.code, 'VOICE_AGENT_SERVICE');
    assert.equal(t.connection.sentAudio.length, 0);
    assert.equal(t.connection.audioCommits, 0);
    const diagnostics = await t.bridge.flushDiagnostics();
    assert.equal(diagnostics.eventCounts.error, 1);
    assert.equal(diagnostics.events[0].error.code, 'change_in_ec_channels_not_allowed');
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_SERVICE_MESSAGE_SENTINEL'), false);
  } finally { t.bridge.stop(); }
});

test('managed Voice Agent definition and per-session bilingual settings use one strict backend function', () => {
  const definition = foundryVoiceAgentDefinition();
  assert.equal(definition.kind, 'voice');
  assert.equal(definition.model, 'gpt-realtime-2.1');
  assert.equal(definition.store, false);
  assert.match(definition.instructions, /zh-TW/);
  assert.deepEqual(definition.output_modalities, ['text', 'audio']);
  assert.deepEqual(definition.tools, [travelBackendTool]);
  assert.equal(definition.parallel_tool_calls, false);
  assert.deepEqual(foundryVoiceSessionConfig('zh-TW'), foundryVoiceSessionConfig('en-US'));
  assert.deepEqual(foundryVoiceSessionConfig(), { type: 'realtime' },
    'audio comes only from the immutable version; no partial output update can reset voice defaults');
});

test('managed Voice Agent does not announce ready when the effective session keeps the wrong locale', async () => {
  const t = harness({ locale: 'en-US', effectiveSession: foundryVoiceSessionConfig('zh-TW') });
  try {
    await settle();
    assert.equal(t.client.sent.some(event => event.type === 'ready'), false);
    const error = t.client.sent.find(event => event.type === 'error');
    assert.equal(error.code, 'VOICE_AGENT_LOCALE_UNAPPLIED');
    assert.match(error.message, /did not apply the requested language settings/);
    assert.equal(t.connection.sentAudio.length, 0);
    assert.equal(t.connection.ended, true);
  } finally { t.bridge.stop(); }
});

test('managed Voice Agent announces ready after the effective English session matches the request', async () => {
  const t = harness({ locale: 'en-US' });
  try {
    await settle();
    assert.equal(t.client.sent.find(event => event.type === 'ready')?.mode, 'foundry-voice-agent');
    assert.deepEqual(t.connection.config, foundryVoiceSessionConfig('en-US'),
      'runtime update contains no audio/voice mutations; the immutable settings are checked on ACK');
    assert.match(t.client.sent.find(event => event.type === 'ready')?.mode, /foundry-voice-agent/);
  } finally { t.bridge.stop(); }
});

test('persisted VAD and tool guards reject mismatches without mutating audio or accepting PCM', async () => {
  for (const change of [
    actual => { actual.audio.input.turn_detection.create_response = true; },
    actual => { actual.audio.input.turn_detection.interrupt_response = true; },
    actual => { actual.tool_choice = 'auto'; },
    actual => { actual.parallel_tool_calls = true; },
    actual => { actual.tools = [{ ...travelBackendTool, parameters: { type: 'object', additionalProperties: true } }]; }
  ]) {
    const actual = effectiveSession('zh-TW');
    change(actual);
    const t = harness({ effectiveSession: actual });
    try {
      await settle();
      assert.deepEqual(t.connection.config, { type: 'realtime' });
      assert.equal(t.client.sent.some(event => event.type === 'ready'), false);
      assert.equal(t.client.sent.find(event => event.type === 'error')?.code, 'VOICE_AGENT_SESSION');
      assert.equal(t.connection.sentAudio.length, 0);
    } finally { t.bridge.stop(); }
  }
});

test('early immutable ACK opens exactly once and runtime configuration contains no audio fields', async () => {
  const client = new Client(), connection = new Connection(effectiveSession('zh-TW'));
  connection.event({ type: 'session.updated', session: effectiveSession('zh-TW') });
  const bridge = bridgeFoundryVoiceAgent(client, connection, createSession(), { APP_MODE: 'mock' },
    { locale: 'zh-TW', startupGreetingType: 'llm_generated' });
  try {
    await settle();
    assert.deepEqual(connection.config, { type: 'realtime' });
    assert.equal(client.sent.filter(event => event.type === 'ready').length, 1);
    client.audio();
    await settle();
    assert.equal(connection.sentAudio.length, 1);
  } finally { bridge.stop(); }
});

test('configured session-start greeting is cancelled once without blocking a delegated user turn', async () => {
  const calls = [];
  const t = harness({ chat: async (_session, request) => {
    calls.push(request.message);
    return { text: '已完成規劃。', speech: { text: '已完成規劃。' },
      state: { offers: [], quote: null, activeAgent: 'intent' } };
  } });
  try {
    await settle();
    t.connection.event({ type: 'response.created', response: { id: 'greeting-1' } });
    await settle();
    assert.deepEqual(t.connection.cancellations, [{ responseId: 'greeting-1' }]);
    assert.equal(t.connection.cleared, 0, 'managed WebSocket sessions must not send avatar-only output_audio_buffer.clear');
    t.connection.event({ type: 'response.done', response: {
      id: 'greeting-1', status: 'cancelled', output: [{ type: 'message', role: 'assistant' }]
    } });
    await settle();
    assert.equal(t.client.sent.some(event => event.type === 'error'), false);

    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'user-1' });
    await settle();
    assert.equal(t.connection.responses.length, 1);
    delegate(t.connection, 'response-1', 'user-1', 'call-1', '我想去東京');
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1', transcript: '我想去東京' });
    await settle();
    assert.deepEqual(calls, ['我想去東京']);
    assert.equal(t.connection.sentOutputs.length, 1);
  } finally { t.bridge.stop(); }
});

test('managed speech interruption cancels the response without avatar-only output-buffer clearing', async () => {
  const t = harness();
  try {
    await settle();
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'user-interrupt' });
    t.connection.event({ type: 'response.created', response: { id: 'delegate-interrupt' } });
    t.connection.event({ type: 'response.done', response: { id: 'delegate-interrupt', status: 'completed', output: [
      { type: 'function_call', status: 'completed', name: travelBackendTool.name, call_id: 'call-interrupt',
        arguments: JSON.stringify({ message: '我想去東京' }) }
    ] } });
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-interrupt', transcript: '我想去東京' });
    await settle();
    assert.equal(t.connection.sentOutputs.length, 1);
    t.connection.event({ type: 'response.created', response: { id: 'spoken-interrupt' } });
    t.connection.event({ type: 'input_audio_buffer.speech_started' });
    await settle();
    assert.deepEqual(t.connection.cancellations, [{ responseId: 'spoken-interrupt' }]);
    assert.equal(t.connection.cleared, 0);
    assert.equal(t.client.sent.some(event => event.type === 'error'), false);
  } finally { t.bridge.stop(); }
});

test('locale ACK accepts an omitted optional voice_locale but rejects mismatches and missing required settings', () => {
  const settings = memberDemoVoiceLocaleSettings('en-US');
  const expected = { instructions: settings.instructions,
    audio: { input: { transcription: settings.transcription },
      output: { voice: settings.outputVoice, voice_locale: settings.locale } } };
  assert.deepEqual(sessionLocaleMismatch(effectiveSession('en-US'), expected), [],
    'voice_locale is optional in the effective-session contract');
  const wrongLocale = effectiveSession('en-US');
  wrongLocale.audio.output.voice_locale = 'zh-TW';
  assert.deepEqual(sessionLocaleMismatch(wrongLocale, expected), ['audio.output.voice_locale']);
  assert.deepEqual(sessionLocaleMismatch({ type: 'realtime' }, expected),
    ['instructions', 'audio.input.transcription.model', 'audio.input.transcription.language', 'audio.output.voice']);
});

test('voice turns use the final service transcription, serialize tool work, and speak backend output', async () => {
  const calls = [], t = harness({ chat: async (_session, request) => {
    calls.push(request.message);
    return { text: `後端：${request.message}`, speech: { text: `後端：${request.message}` },
      state: { offers: [], quote: null, activeAgent: 'intent' } };
  } });
  try {
    await settle();
    assert.equal(t.client.sent.find(event => event.type === 'ready')?.mode, 'foundry-voice-agent');
    assert.deepEqual(t.connection.config, foundryVoiceSessionConfig());
    t.client.audio();
    await settle();
    assert.equal(t.connection.sentAudio.length, 1);
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    await settle();
    assert.equal(t.connection.responses.length, 1);
    delegate(t.connection, 'response-1', 'item-1', 'call-1', '你好');
    await settle();
    assert.deepEqual(calls, [], 'wait for final ASR rather than dispatching model-rewritten tool arguments');
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-1', transcript: '你好' });
    await settle();
    assert.deepEqual(calls, ['你好']);
    assert.equal(t.session.busy, false);
    assert.equal(t.connection.sentOutputs[0].callId, 'call-1');
    assert.equal(t.connection.audioCommits, 0, 'VAD owns input-buffer commit; the bridge does not manually commit audio');
    assert.deepEqual(t.connection.sentOutputs[0].options, { createResponse: false });
    assert.deepEqual(t.connection.responses[1], { response: { tool_choice: 'none' } });
    t.connection.event({ type: 'response.created', response: { id: 'speech-1' } });
    t.connection.event({ type: 'response.output_audio.delta', response_id: 'speech-1', delta: new Uint8Array([1, 0, 2, 0]) });
    t.connection.event({ type: 'response.audio.delta', response_id: 'speech-1', delta: Buffer.from([3, 0]).toString('base64') });
    t.connection.event({ type: 'response.done', response: { id: 'speech-1', status: 'completed', output: [] } });
    await settle();
    assert.deepEqual(t.client.sent.filter(event => event.type === 'audio').map(event => event.audio),
      [Buffer.from([1, 0, 2, 0]).toString('base64'), Buffer.from([3, 0]).toString('base64')]);
    assert.ok(t.client.sent.some(event => event.type === 'audioDone'));
  } finally { t.bridge.stop(); }
});

test('voice diagnostics count VAD, commit, transcription and errors without storing audio, transcript, or service messages', async () => {
  const t = harness();
  try {
    await settle();
    t.client.audio([1, 0, 2, 0]);
    await settle();
    t.connection.event({ type: 'input_audio_buffer.speech_started' });
    t.connection.event({ type: 'input_audio_buffer.speech_stopped' });
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'private-item-id' });
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'private-item-id', transcript: 'PRIVATE_TRANSCRIPT_SENTINEL' });
    t.connection.event({ type: 'error', error: {
      type: 'invalid_request_error',
      code: 'service_error_code',
      param: 'input_audio_buffer.append',
      message: 'PRIVATE_SERVICE_MESSAGE_SENTINEL'
    } });
    await settle();

    const diagnostics = t.bridge.diagnostics;
    assert.deepEqual(diagnostics.audio, {
      format: 'pcm16-mono',
      sampleRateHz: 24000,
      clientFramesAccepted: 1,
      clientBytesAccepted: 4,
      sdkAppendCalls: 1,
      sdkAppendBytes: 4
    });
    assert.equal(diagnostics.eventCounts['input_audio_buffer.speech_started'], 1);
    assert.equal(diagnostics.eventCounts['input_audio_buffer.speech_stopped'], 1);
    assert.equal(diagnostics.eventCounts['input_audio_buffer.committed'], 1);
    assert.equal(diagnostics.eventCounts['conversation.item.input_audio_transcription.completed'], 1);
    assert.equal(diagnostics.eventCounts.error, 1);
    assert.ok(diagnostics.events.every(event => Number.isInteger(event.elapsedMs) &&
      event.audio.sdkAppendBytes === 4 && event.state.ready));
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes('PRIVATE_TRANSCRIPT_SENTINEL'), false);
    assert.equal(serialized.includes('PRIVATE_SERVICE_MESSAGE_SENTINEL'), false);
    assert.equal(serialized.includes('private-item-id'), false);
    assert.equal(diagnostics.events.at(-1).error.code, 'service_error_code');
    assert.equal(t.connection.audioCommits, 0);
  } finally { t.bridge.stop(); }
});

test('voice diagnostics record transcription failure as a content-free event', async () => {
  const t = harness();
  try {
    await settle();
    t.connection.event({ type: 'conversation.item.input_audio_transcription.failed',
      error: { code: 'transcription_failed', message: 'PRIVATE_TRANSCRIPTION_FAILURE_SENTINEL' } });
    await settle();
    const diagnostics = t.bridge.diagnostics;
    assert.equal(diagnostics.eventCounts['conversation.item.input_audio_transcription.failed'], 1);
    assert.equal(diagnostics.events[0].type, 'conversation.item.input_audio_transcription.failed');
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_TRANSCRIPTION_FAILURE_SENTINEL'), false);
  } finally { t.bridge.stop(); }
});

test('an interrupted backend turn is not spoken and the next committed utterance waits for its tool handoff', async () => {
  let release, calls = 0;
  const t = harness({ chat: async (_session, request) => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return { text: `已處理：${request.message}`, speech: { text: `已處理：${request.message}` },
      state: { offers: [], quote: null, activeAgent: 'intent' } };
  } });
  try {
    await settle();
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'first' });
    delegate(t.connection, 'response-1', 'first', 'call-1', '第一句');
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '第一句' });
    await settle();
    assert.equal(calls, 1);
    t.connection.event({ type: 'input_audio_buffer.speech_started' });
    t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'second' });
    await settle();
    assert.equal(calls, 1, 'never run the queued turn in parallel');
    assert.equal(t.connection.responses.length, 1);
    release();
    await settle();
    assert.equal(t.connection.sentOutputs.length, 1);
    assert.equal(t.connection.responses.length, 2, 'dispatch the queued turn only after releasing the session lock');
    assert.equal(t.session.busy, false);
    delegate(t.connection, 'response-2', 'second', 'call-2', '第二句');
    t.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: '第二句' });
    await settle();
    assert.deepEqual(calls, 2);
    assert.equal(t.connection.sentOutputs.length, 2);
  } finally { t.bridge.stop(); }
});

test('model message never overrides final ASR and ASR transaction attempts remain denied', async () => {
  let calls = 0;
  const mismatch = harness({ chat: async (_session, request) => {
    calls++; assert.equal(request.message, '去東京');
    return { text: '完成', state: { offers: [] } };
  } });
  try {
    await settle();
    mismatch.connection.event({ type: 'input_audio_buffer.committed', item_id: 'mismatch' });
    delegate(mismatch.connection, 'response-m', 'mismatch', 'call-m', '去大阪');
    mismatch.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'mismatch', transcript: '去東京' });
    await settle();
    assert.equal(calls, 1);
    assert.equal(mismatch.bridge.diagnostics.delegations.at(-1).source, 'same-item-final-asr');
    delegate(mismatch.connection, 'response-m', 'mismatch', 'call-m', '去大阪');
    mismatch.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'mismatch', transcript: '去大阪' });
    await settle();
    assert.equal(calls, 1, 'duplicate response/final cannot execute twice');
  } finally { mismatch.bridge.stop(); }

  const transaction = harness({ chat: async (_session, _request, _env, hooks) => hooks.onTransaction() });
  try {
    await settle();
    transaction.connection.event({ type: 'input_audio_buffer.committed', item_id: 'transaction' });
    delegate(transaction.connection, 'response-t', 'transaction', 'call-t', '只是查詢航班');
    transaction.connection.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'transaction', transcript: '確認報價' });
    await settle();
    assert.equal(transaction.connection.sentOutputs.length, 1);
    assert.deepEqual(JSON.parse(transaction.connection.sentOutputs[0].output), { error: 'VOICE_AGENT_TRANSACTION', executed: false });
    assert.ok(transaction.client.sent.some(event => event.type === 'taskError'));
    assert.equal(transaction.connection.responses.length, 1, 'transaction denial does not request spoken success');
  } finally { transaction.bridge.stop(); }
});

test('unmatched final transcription tracking is bounded', async () => {
  const t = harness({ chat: async () => { throw new Error('unmatched transcription must never dispatch'); } });
  try {
    await settle();
    for (let index = 0; index <= MAX_TURNS; index++) {
      t.connection.event({ type: 'conversation.item.input_audio_transcription.completed',
        item_id: `unmatched-${index}`, transcript: '完整需求' });
    }
    await settle();
    assert.equal(t.client.sent.at(-1).code, 'VOICE_AGENT_TRANSCRIPT_LIMIT');
    assert.equal(t.session.busy, false);
  } finally { t.bridge.stop(); }
});

test('missing, failed, malformed or wrong-item final never uses a tool-message fallback', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const final of [
    null,
    { type: 'conversation.item.input_audio_transcription.failed', item_id: 'current' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'other', transcript: '去東京' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'current', transcript: '' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'current', transcript: { message: '去東京' } }
  ]) {
    let calls = 0;
    const t = harness({ chat: async () => { calls++; throw new Error('must not dispatch'); } });
    try {
      await settle();
      t.connection.event({ type: 'input_audio_buffer.committed', item_id: 'current' });
      delegate(t.connection, 'current-response', 'current', 'current-call', '購買機票');
      if (final) t.connection.event(final);
      await settle();
      context.mock.timers.tick(30000);
      await settle();
      assert.equal(calls, 0);
      assert.equal(t.connection.sentOutputs.length, 0);
      assert.ok(t.client.sent.some(event => event.type === 'error'));
    } finally { t.bridge.stop(); }
  }
});
