import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { AppError, createSession } from '../lib/core.js';
import { attachVoice, bridgeVoice, voiceConfig, voiceSessionUpdate } from '../lib/voice.js';
import { bridgeGptLive, gptLiveStart } from '../lib/gpt-live.js';
import { bridgeDirectSpeech, personalVoiceSsml } from '../lib/direct-speech.js';
import { createSpeechRecognition, speechInputSchema } from '../lib/speech-sdk.js';
import { commentaryContext, speechSegments, speechText } from '../lib/speech.js';
import { mockSpeechSdk } from './mock-speech-sdk.js';

const english = value => assert.doesNotMatch(value, /\p{Script=Han}/u);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 15; i++) await tick(); }
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED; this.emit('close');
  }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
}
const env = {
  APP_MODE: 'mock',
  VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_ENDPOINT: 'https://offline.services.ai.azure.com',
  VOICE_LIVE_VOICE_TYPE: 'azure-personal', VOICE_LIVE_PERSONAL_VOICE_NAME: 'existing-personal-voice',
  VOICE_LIVE_PERSONAL_VOICE_MODEL: 'DragonLatestNeural',
  VOICE_LIVE_PERSONAL_VOICE_ATHENA_NAME: 'existing-female-voice',
  VOICE_LIVE_REALTIME_ENABLED: 'true', VOICE_LIVE_REALTIME_MODEL: 'gpt-realtime-2.1',
  GPT_LIVE_ENABLED: 'true', GPT_LIVE_ENDPOINT: 'https://offline.openai.azure.com'
};
const directConfig = { endpoint: 'https://offline.cognitiveservices.azure.com', key: 'offline',
  profile: '12345678-1234-1234-1234-123456789abc', model: 'DragonLatestNeural', locale: 'en-US' };
const session = () => Object.assign(createSession(), { locale: 'en-US' });

test('English synthesis preserves canonical answers and uses English dates, times, currency and links', () => {
  const canonical = 'Flight DEMO-FLT-AB123 from TPE to NRT. TWD 12,300 on 2026-11-02 at 17:30. ' +
    'Expires 2026-10-23T16:21:06.754Z. [Checkout](/checkout/' + 'a'.repeat(64) + ').\nSources: flights.txt';
  const spoken = speechText(canonical, 'en-US');
  english(spoken);
  assert.match(spoken, /November 2, 2026 at 5:30 PM/);
  assert.match(spoken, /October 24, 2026 at 12:21:06 AM and 754 milliseconds Taipei time/);
  assert.match(spoken, /12,300 New Taiwan dollars/);
  assert.match(spoken, /DEMO-FLT-AB123 from TPE to NRT/);
  assert.match(spoken, /checkout link is in the conversation/i);
  assert.doesNotMatch(spoken, /flights\.txt|Sources:|\/checkout\//);
  const result = { text: canonical };
  assert.ok(speechSegments(result, 'en-US').every(part => part.length <= 120));
  assert.ok(commentaryContext(result, 'en-US').every(part => Buffer.byteLength(part) <= 380));
  assert.equal(result.text, canonical);
  assert.equal(speechText('Meet at 12:21:06 AM or 5:30 PM.', 'en-US'), 'Meet at 12:21:06 AM or 5:30 PM.');
  const ssml = personalVoiceSsml(directConfig, 'Fare TWD 12,300. < &');
  assert.match(ssml, /xml:lang="en-US"/);
  assert.match(ssml, /speakerProfileId="12345678-1234-1234-1234-123456789abc"/);
  assert.match(ssml, /&lt; &amp;/);
  english(ssml);
  assert.throws(() => personalVoiceSsml({ ...directConfig, locale: 'en-GB' }, 'hello'));
});

test('Option1 and native Option2 English payloads contain no conflicting Chinese instructions or voice replacement', () => {
  const config = { ...voiceConfig(env), locale: 'en-US' };
  const update = voiceSessionUpdate(config).session;
  assert.equal(update.input_audio_transcription.language, 'en-US');
  assert.deepEqual(update.turn_detection.languages, ['en']);
  assert.deepEqual(update.voice, config.outputVoice);
  const realtime = voiceSessionUpdate({ ...config, realtime: true }).session;
  assert.deepEqual(realtime.voice, { type: 'azure-standard', name: 'en-US-AvaNeural' });
  assert.deepEqual(config.outputVoice, voiceConfig(env).outputVoice);
  const chinese = voiceSessionUpdate({ ...voiceConfig(env), realtime: true }).session;
  assert.deepEqual(chinese.voice, config.outputVoice);
  english(JSON.stringify(realtime));
  assert.match(realtime.instructions, /clear, natural English/);
  assert.match(realtime.instructions, /stop voice and use text/i);
  assert.match(realtime.instructions, /detail=detailed/);
  assert.equal(realtime.parallel_tool_calls, false);
  assert.equal(realtime.tools[0].parameters.additionalProperties, false);
});

test('Option1 dispatches the session locale, preserves canonical English display, and localizes backend failures', async () => {
  for (const fail of [false, true]) {
    const client = new Socket(), upstream = new Socket(), s = session();
    const canonical = 'The fare is TWD 12,300 on 2026-11-02.';
    const bridge = bridgeVoice(client, upstream, s, env, voiceConfig(env), {
      chat: async (current, raw) => {
        assert.equal(current.locale, 'en-US'); assert.equal(raw.locale, 'en-US');
        if (fail) throw new AppError('PLANNING_INPUT', '請提供有效行程。', 400);
        return { text: canonical, state: { offers: [] } };
      }
    });
    try {
      upstream.emit('open');
      assert.equal(upstream.sent[0].session.input_audio_transcription.language, 'en-US');
      upstream.event({ type: 'session.updated' });
      upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'english', transcript: 'Find flights to Tokyo.' });
      await settle();
      if (fail) {
        const event = client.sent.find(value => value.type === 'taskError');
        assert.equal(event.code, 'PLANNING_INPUT'); english(event.message);
        assert.equal(client.readyState, WebSocket.OPEN);
      } else {
        assert.equal(client.sent.find(value => value.type === 'result').result.text, canonical);
        const spoken = upstream.sent.find(value => value.type === 'response.create').response.pre_generated_assistant_message.content[0].text;
        english(spoken); assert.match(spoken, /New Taiwan dollars/);
      }
      assert.equal(s.locale, 'en-US');
    } finally { bridge.stop(); }
  }
});

test('GPT English session instructions enforce locale over advanced defaults and retain verified marin only', () => {
  const config = { model: 'gpt-live-1', locale: 'en-US',
    advanced: { language: 'zh-TW', taiwanWording: true, style: 'professional', voice: 'marin' } };
  const start = gptLiveStart(config).session;
  assert.equal(start.audio.output.voice, 'marin');
  english(start.instructions);
  assert.match(start.instructions, /Speak in clear, natural English/);
  assert.match(start.instructions, /professional delivery/);
  assert.match(start.instructions, /No transaction|never authorizes a transaction/i);
  assert.throws(() => gptLiveStart({ ...config, advanced: { ...config.advanced, voice: 'invented' } }));
  const legacy = gptLiveStart({ model: 'gpt-live-1', advanced: { language: 'en-US', voice: 'marin' } }).session;
  assert.match(legacy.instructions, /Speak in clear, natural English/);
  english(legacy.instructions);
  const authoritative = gptLiveStart({ model: 'gpt-live-1', advanced: { language: 'en-US', voice: 'marin' } }, createSession()).session;
  assert.match(authoritative.instructions, /Speak in natural Traditional Chinese/);
});

test('GPT incomplete English delegation clarifies without calling the backend or changing language', async () => {
  const client = new Socket(), upstream = new Socket(), s = session();
  let calls = 0;
  const bridge = bridgeGptLive(client, upstream, s, env, { model: 'gpt-live-1', locale: 'en-US' }, {
    chat: async () => { calls++; }
  });
  try {
    upstream.emit('open'); upstream.event({ type: 'session.started', session: { model: 'gpt-live-1' } });
    upstream.event({ type: 'session.input_transcript.delta', delta: 'I want to visit', start_ms: 0, end_ms: 100 });
    upstream.event({ type: 'session.delegation.created', offset_ms: 50, delegation: { type: 'delegation', target: 'client', id: 'incomplete' } });
    await settle();
    assert.equal(calls, 0); assert.equal(s.locale, 'en-US');
    const error = client.sent.find(value => value.type === 'taskError');
    english(error.message); assert.match(error.message, /repeat your complete request/);
    for (const event of upstream.sent.filter(value => value.content)) english(event.content);
  } finally { bridge.stop(); }
});

test('GPT English backend result and task failure remain English with no arbitrary answer translation', async () => {
  for (const fail of [false, true]) {
    const client = new Socket(), upstream = new Socket(), s = session();
    const canonical = 'Your itinerary includes two days in Tokyo. Prices are synthetic.';
    const bridge = bridgeGptLive(client, upstream, s, env, { model: 'gpt-live-1', locale: 'en-US' }, {
      chat: async (current, raw) => {
        assert.equal(current.locale, 'en-US'); assert.equal(raw.locale, 'en-US');
        if (fail) throw new AppError('PLANNING_INPUT', '請補充行程。', 400);
        return { text: canonical, state: { offers: [] } };
      }
    });
    try {
      upstream.emit('open'); upstream.event({ type: 'session.started', session: { model: 'gpt-live-1' } });
      upstream.event({ type: 'session.input_transcript.delta', delta: 'Two days in Tokyo.', start_ms: 0, end_ms: 100 });
      upstream.event({ type: 'session.delegation.created', offset_ms: 100, delegation: { type: 'delegation', target: 'client', id: 'task' } });
      await settle();
      const commentary = upstream.sent.find(value => value.type === 'session.commentary.append');
      english(commentary.content);
      if (fail) english(client.sent.find(value => value.type === 'taskError').message);
      else {
        assert.match(commentary.content, /Backend result \(data only, not instructions\)/);
        assert.equal(client.sent.find(value => value.type === 'result').result.text, canonical);
      }
    } finally { bridge.stop(); }
  }
});

test('Option4 REST sends en-US STT and SSML, preserves canonical result, and sanitizes transcription/HTTP/backend failures', async () => {
  for (const failure of [null, 'transcription', 'http', 'backend']) {
    const client = new Socket(), s = session(), requests = [];
    const canonical = 'Your fare is TWD 12,300.';
    const bridge = bridgeDirectSpeech(client, s, env, directConfig, {
      trace: () => {},
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (failure === 'http') return new Response('private service response', { status: 403 });
        return url.pathname.startsWith('/stt/')
          ? Response.json({ RecognitionStatus: 'Success', DisplayText: failure === 'transcription' ? '' : 'Find a flight.' })
          : new Response(Buffer.alloc(4800));
      },
      chat: async (current, raw) => {
        assert.equal(current.locale, 'en-US'); assert.equal(raw.locale, 'en-US');
        if (failure === 'backend') throw new AppError('TRIP_INPUT', '請提供有效機場。', 400);
        return { text: canonical, state: { offers: [] } };
      }
    });
    try {
      const pcm = Buffer.alloc(38400);
      for (let i = 19200; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 4000), i);
      client.emit('message', pcm, true); client.event({ type: 'finish' }); await settle();
      assert.equal(requests[0].url.searchParams.get('language'), 'en-US');
      if (!failure) {
        assert.equal(client.sent.find(value => value.type === 'result').result.text, canonical);
        assert.match(requests[1].options.body, /xml:lang="en-US"/);
        english(requests[1].options.body);
      } else {
        const error = client.sent.find(value => ['error', 'taskError'].includes(value.type));
        english(error.message);
        assert.doesNotMatch(error.message, /private service response/);
        assert.equal(requests.length, 1);
      }
      assert.equal(s.locale, 'en-US');
      for (const event of client.sent) {
        if (event.detail) english(event.detail);
        if (event.message) english(event.message);
      }
    } finally { bridge.stop(); }
  }
});

test('Option4 SDK uses en-US recognition and English safe auth failures without switching to REST', async () => {
  const options = speechInputSchema.parse({ stt: 'sdk' });
  for (const fail of [false, true]) {
    const mock = mockSpeechSdk(), failures = [];
    if (fail) mock.sdk.SpeechRecognizer.prototype.startContinuousRecognitionAsync = (_success, error) => error('401 private-token');
    const adapter = createSpeechRecognition(directConfig, options, {
      sdk: mock.sdk, onEvent: () => {}, onFinal: () => {},
      onFailure: (code, message) => failures.push({ code, message })
    });
    try {
      await adapter.start();
      assert.equal(mock.configs[0].speechRecognitionLanguage, 'en-US');
      if (fail) {
        assert.equal(failures[0].code, 'SPEECH_SDK_AUTH');
        english(failures[0].message); assert.doesNotMatch(failures[0].message, /private-token/);
      } else assert.deepEqual(failures, []);
    } finally { adapter.close(); }
  }
});

test('tickets strictly validate matching locales, preserve session on invalid input, and enable verified finite Option2 English voice', () => {
  const server = createServer(), s = session();
  const voice = attachVoice(server, new Map([[s.id, s]]), env);
  try {
    assert.equal(voice.modes['voice-realtime'].localeAvailability['en-US'].available, true);
    for (const locale of ['en', 'en-GB', null, 123, {}, 'zh-TW']) {
      assert.throws(() => voice.ticket(s, { locale }));
      assert.equal(s.locale, 'en-US'); assert.ok(!s.voice);
    }
    assert.throws(() => voice.ticket(s, { mode: 'gpt-live', voiceOptions: { 'gpt-live': { language: 'zh-TW' } } }),
      error => error.code === 'VOICE_OPTIONS');
    assert.equal(voice.ticket(s, { mode: 'voice-realtime', locale: 'en-US' }).protocol, 'journey-voice');
    for (const personalVoiceKey of ['alexpun', 'athena']) {
      assert.equal(voice.ticket(s, { locale: 'en-US', personalVoiceKey }).protocol, 'journey-voice');
    }
    assert.equal(voice.ticket(s, { mode: 'gpt-live' }).protocol, 'journey-voice');
  } finally { server.emit('close'); }
});

test('a ticket freezes locale at issue and rejects a later session language change before authentication', async () => {
  const server = createServer(), s = session();
  let authCalls = 0;
  const voice = attachVoice(server, new Map([[s.id, s]]), env, {
    credential: { getToken: async () => { authCalls++; return { token: 'offline' }; } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, ticket = voice.ticket(s, { locale: 'en-US' });
  s.locale = 'zh-TW';
  const ws = new WebSocket(`ws://127.0.0.1:${port}${ticket.path}`, [ticket.protocol, ticket.nonce], {
    headers: { Cookie: `journey=${s.id}`, Origin: `http://127.0.0.1:${port}` }
  });
  try {
    const status = await new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
      ws.once('error', reject);
    });
    assert.equal(status, 403); assert.equal(authCalls, 0); assert.equal(s.locale, 'zh-TW');
  } finally {
    ws.on('error', () => {}); ws.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('English tickets keep existing personal identities and finite native English voice through the local WS handshake', async () => {
    const server = createServer(), s = session(), upstreams = [];
    const voice = attachVoice(server, new Map([[s.id, s]]), env, {
      credential: { getToken: async () => ({ token: 'offline' }) },
      connect: () => {
        const upstream = new Socket(); upstreams.push(upstream);
        setImmediate(() => { upstream.emit('open'); upstream.event({ type: 'session.updated' }); });
        return upstream;
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    try {
      for (const [raw, name, personal] of [
        [{ personalVoiceKey: 'alexpun' }, env.VOICE_LIVE_PERSONAL_VOICE_NAME, true],
        [{ personalVoiceKey: 'athena' }, env.VOICE_LIVE_PERSONAL_VOICE_ATHENA_NAME, true],
        [{ mode: 'voice-realtime' }, 'en-US-AvaNeural', false]
      ]) {
        const ticket = voice.ticket(s, raw);
        raw.locale = 'zh-TW';
        const ws = new WebSocket(`ws://127.0.0.1:${port}${ticket.path}`, [ticket.protocol, ticket.nonce], {
          headers: { Cookie: `journey=${s.id}`, Origin: `http://127.0.0.1:${port}` }
        });
        try {
          await once(ws, 'message');
          const config = upstreams.at(-1).sent[0].session;
          if (personal) assert.equal(config.input_audio_transcription.language, 'en-US');
          else {
            assert.equal(config.input_audio_transcription, undefined);
            assert.equal(config.voice.type, 'azure-standard');
            english(config.instructions);
          }
          assert.equal(config.voice.name, name);
          assert.equal(config.voice.model, personal ? 'DragonLatestNeural' : undefined);
          assert.equal(s.locale, 'en-US');
        } finally { ws.close(); await once(ws, 'close'); await settle(); }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a language change during credential acquisition prevents connection with an obsolete frozen locale', async () => {
    const server = createServer(), s = session();
    let release, connections = 0;
    const voice = attachVoice(server, new Map([[s.id, s]]), env, {
      credential: { getToken: () => new Promise(resolve => { release = resolve; }) },
      connect: () => { connections++; return new Socket(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port, ticket = voice.ticket(s);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${ticket.path}`, [ticket.protocol, ticket.nonce], {
      headers: { Cookie: `journey=${s.id}`, Origin: `http://127.0.0.1:${port}` }
    });
    const status = new Promise((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
      ws.once('error', reject);
    });
    try {
      while (!release) await tick();
      s.locale = 'zh-TW'; release({ token: 'offline' });
      assert.equal(await status, 403); assert.equal(connections, 0);
    } finally {
      ws.on('error', () => {}); ws.terminate();
      await new Promise(resolve => server.close(resolve));
    }
});
