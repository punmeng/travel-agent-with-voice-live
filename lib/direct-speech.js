import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { AppError } from './core.js';
import { chat } from './agents.js';
import { speechText, speechSegments } from './speech.js';
import { MAX_TURNS, MAX_VOICE_INPUT_BYTES, MAX_VOICE_OUTPUT_BYTES } from './limits.js';
import { voiceMetrics } from './voice-metrics.js';
import { PcmVad } from './pcm-vad.js';
import { createSpeechRecognition } from './speech-sdk.js';
import { voiceLocale, voiceMessage, localizeVoiceEvent } from './voice-language.js';

const MAX_RECORDING_BYTES = 24000 * 2 * 30;
const models = ['DragonLatestNeural', 'DragonHDOmniLatestNeural', 'PhoenixLatestNeural'];
export function directSpeechConfig(env) {
  if (env.DIRECT_SPEECH_ENABLED !== 'true') return null;
  let endpoint;
  try { endpoint = new URL(env.DIRECT_SPEECH_ENDPOINT); } catch { throw new Error('DIRECT_SPEECH_ENDPOINT is required.'); }
  if (endpoint.protocol !== 'https:' || !/^[\w-]+\.cognitiveservices\.azure\.com$/.test(endpoint.hostname) ||
      endpoint.pathname !== '/' || endpoint.port || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('DIRECT_SPEECH_ENDPOINT must be an explicitly configured Speech resource root, not a Voice Live endpoint.');
  }
  const profile = env.DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID;
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(profile ?? '')) {
    throw new Error('Direct Speech requires a separate Personal Voice speakerProfileId GUID; no Voice Live name substitution.');
  }
  if (!models.includes(env.DIRECT_SPEECH_PERSONAL_VOICE_MODEL)) throw new Error('Direct Speech requires an explicit supported Personal Voice base model.');
  const resourceId = env.DIRECT_SPEECH_RESOURCE_ID;
  if (!env.DIRECT_SPEECH_KEY && !/^\/subscriptions\/[\w-]+\/resourceGroups\/[\w.-]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[\w-]+$/i.test(resourceId ?? '')) {
    throw new Error('Direct Speech requires a server-side key or explicit Speech resource ID for Entra authentication.');
  }
  return { endpoint: endpoint.origin, profile, model: env.DIRECT_SPEECH_PERSONAL_VOICE_MODEL,
    key: env.DIRECT_SPEECH_KEY, resourceId };
}
const xml = text => text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
export function personalVoiceSsml(config, text) {
  const locale = voiceLocale(config.locale);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${xml(config.model)}"><mstts:ttsembedding speakerProfileId="${xml(config.profile)}">${xml(speechText(text, locale))}</mstts:ttsembedding></voice></speak>`;
}
export function speechWav(pcm) {
  if (pcm.length < 4 || pcm.length % 2 || pcm.length > MAX_RECORDING_BYTES) throw new AppError('SPEECH_AUDIO', '錄音必須為30秒內的完整PCM16音訊。', 400);
  const count = Math.floor(pcm.length / 2 * 2 / 3);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(36 + count * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  // Average the overlap of each 16 kHz sample with the 24 kHz source samples.
  for (let i = 0; i < count; i++) {
    const start = i * 1.5, end = start + 1.5;
    let value = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      value += pcm.readInt16LE(j * 2) * (Math.min(end, j + 1) - Math.max(start, j));
    }
    wav.writeInt16LE(Math.round(value / 1.5), 44 + i * 2);
  }
  return wav;
}
async function boundedBody(response, maxBytes, controller, onFirstChunk) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    if (!length && chunk.length) onFirstChunk?.();
    length += chunk.length;
    if (length > maxBytes) {
      controller.abort();
      throw new AppError('SPEECH_OUTPUT_LIMIT', 'Speech服務輸出超過安全上限。', 502);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function bridgeDirectSpeech(client, session, env, config, dependencies = {}) {
  const locale = voiceLocale(config.locale ?? session.locale);
  let closed = false, active = null, muted = false, accepting = true, turns = 0;
  let chunks = [], recordingBytes = 0, inputBytes = 0, outputBytes = 0, windowBytes = 0, windowAt = Date.now();
  let recordingTimer;
  let recognition, sdkReady = false, sdkEof = false;
  let playback = null, playbackTimer;
  let resumePending = false, resumeTurn = null;
  const connectionId = randomUUID();
  const counters = { acceptedBytes: 0, silenceBytes: 0, pausedBytes: 0, partials: 0, finals: 0, dispatched: 0, completed: 0 };
  const trace = stage => {
    const event = { code: 'SPEECH_PIPELINE', correlationId: connectionId, timestamp: new Date().toISOString(),
      mode: 'speech-direct', stt: input.stt, stage, queueDepth: finals.length, accepting, busy: session.busy, ...counters };
    (dependencies.trace ?? (value => console.info(JSON.stringify(value))))(event);
  };
  const input = dependencies.speechInput ?? { stt: 'rest' };
  const sdkMode = input.stt === 'sdk', finals = [];
  const vad = new PcmVad({ silenceMs: dependencies.restVadSilenceMs ?? 1000 });
  const resetRecording = () => { clearTimeout(recordingTimer); chunks = []; recordingBytes = 0; vad.reset(); };
  const send = event => {
    if (closed || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 2_000_000) return fail('SPEECH_BACKPRESSURE', '播放連線過慢，已停止。');
    client.send(JSON.stringify(localizeVoiceEvent(locale, event)));
  };
  const metrics = voiceMetrics(send, 'speech-direct', dependencies.monotonicNow);
  const stop = () => {
    if (closed) return;
    closed = true; clearTimeout(recordingTimer); clearTimeout(playbackTimer); playback?.reject(new Error('Playback stopped')); playback = null;
    chunks = []; finals.length = 0; recognition?.close(); active?.abort(); client.close(1000);
    if (session.voice?.stop === stop) session.voice = null;
  };
  const fail = (code, message) => {
    const correlationId = randomUUID();
    console.error(JSON.stringify({ code, correlationId, timestamp: new Date().toISOString(), mode: 'speech-direct',
      stt: input.stt, queueDepth: finals.length, accepting, busy: session.busy, ...counters }));
    if (!closed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', code, message: voiceMessage(locale, message, code), correlationId }));
    stop();
  };
  async function request(path, body, type, maxBytes) {
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(30000)]);
    const headers = { 'Content-Type': type };
    if (config.key) headers['Ocp-Apim-Subscription-Key'] = config.key;
    else {
      const token = await dependencies.credential.getToken('https://cognitiveservices.azure.com/.default', { abortSignal: signal });
      if (!token?.token) throw new AppError('SPEECH_AUTH', '未取得Speech身分權杖。', 502);
      headers.Authorization = `Bearer aad#${config.resourceId}#${token.token}`;
    }
    if (path.startsWith('/tts/')) {
      headers['X-Microsoft-OutputFormat'] = 'raw-24khz-16bit-mono-pcm';
      headers['User-Agent'] = 'travelagent';
    } else headers.Accept = 'application/json';
    signal.throwIfAborted();
    const response = await (dependencies.fetch ?? fetch)(new URL(path, config.endpoint), {
      method: 'POST', headers, body, signal,
      redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('SPEECH_HTTP', `Azure Speech拒絕請求（HTTP ${response.status}），未切換替代服務。`, 502);
    }
    return boundedBody(response, maxBytes, active, path.startsWith('/tts/') ? () => metrics.mark('tts_first_byte') : undefined);
  }
  async function finish(detected = false, final = null) {
    if (!accepting) return;
    if (session.busy) return fail('SPEECH_BUSY', '上一段尚未完成，未執行平行工作。');
    if (!final && (!recordingBytes || (!detected && !vad.eligible))) {
      resetRecording(); send({ type: 'state', state: 'listening', detail: '未偵測到足夠語音，繼續等待；未送至Azure。' }); return;
    }
    if (++turns > MAX_TURNS) return fail('SPEECH_TURN_LIMIT', '語音回合已達上限。');
    accepting = false; clearTimeout(recordingTimer);
    const pcm = Buffer.concat(chunks); chunks = []; recordingBytes = 0;
    active = new AbortController(); session.busy = true; session.updatedAt = Date.now();
    metrics.mark('input_end'); send({ type: 'state', state: 'thinking' });
    const turnId = randomUUID();
    try {
      let result;
      if (final) result = { RecognitionStatus: 'Success', DisplayText: final.text };
      else {
        metrics.mark('stt_dispatch');
        const bytes = await request(`/stt/speech/recognition/conversation/cognitiveservices/v1?language=${locale}&format=simple`,
          speechWav(pcm), 'audio/wav; codecs=audio/pcm; samplerate=16000', 64000);
        result = JSON.parse(bytes.toString('utf8'));
      }
      if (result.RecognitionStatus !== 'Success' || typeof result.DisplayText !== 'string' || !result.DisplayText.trim() || result.DisplayText.length > 2000) {
        throw new AppError('SPEECH_TRANSCRIPTION', 'Speech未取得有效完整語句，未委派代理；請重新連線。', 502);
      }
      if (closed) return;
      metrics.mark('transcript');
      send({ type: 'transcript', text: result.DisplayText, turnId });
      metrics.mark('backend_dispatch');
      counters.dispatched++; trace('backend_dispatch');
      const answer = await (dependencies.chat ?? chat)(session, { message: result.DisplayText, requestId: turnId, offerIds: [], quoteContext: null, locale }, env, {
        ...dependencies, signal: active.signal,
        onProgress: role => { if (['intent', 'planner', 'flight', 'price'].includes(role)) send({ type: 'progress', turnId, role }); },
        onTransaction: () => { throw new AppError('SPEECH_TRANSACTION', '此比較模式只處理查詢與規劃，交易請停止語音後用文字完成。', 409); }
      });
      if (closed) return;
      metrics.mark('backend_result'); send({ type: 'result', turnId, result: answer });
      counters.completed++; trace('backend_result');
      const parts = speechSegments(answer, locale);
      for (const [index, part] of parts.entries()) {
        metrics.mark('tts_dispatch');
        const audio = await request('/tts/cognitiveservices/v1', personalVoiceSsml({ ...config, locale }, part), 'application/ssml+xml',
          Math.min(MAX_VOICE_OUTPUT_BYTES - outputBytes, 24_000 * 2 * 30));
        if (!audio.length || audio.length % 2) throw new AppError('SPEECH_PCM', 'Speech回傳無效PCM，文字結果保留。', 502);
        if (closed) return;
        outputBytes += audio.length; metrics.mark('first_audio');
        for (let offset = 0; offset < audio.length; offset += 24000) send({ type: 'audio', audio: audio.subarray(offset, offset + 24000).toString('base64') });
        if (index < parts.length - 1) await new Promise((resolve, reject) => {
          playback = { turnId, segment: index, resolve, reject };
          playbackTimer = setTimeout(() => reject(new AppError('SPEECH_PLAYBACK_TIMEOUT', '播放確認逾時，完整文字保留。', 408)), 45000);
          send({ type: 'audioSegmentDone', turnId, segment: index });
        });
      }
      resumeTurn = turnId;
      trace('playback_dispatched'); send({ type: 'audioDone', turnId });
    } catch (error) {
      if (!closed && ['PLANNING_INPUT', 'TRIP_INPUT'].includes(error.code)) {
        trace('input_rejected');
        send({ type: 'taskError', turnId, code: error.code, message: error.message });
        resumeTurn = turnId; resumePending = true;
        return;
      }
      if (!closed) fail(error instanceof AppError ? error.code : 'SPEECH_FAILED',
        error instanceof AppError ? error.message : '直接Speech處理失敗，未切換語音服務；已完成文字結果保留。');
    } finally {
      session.busy = false; active = null;
      if (resumePending && !closed) { resumePending = false; resume(); }
    }
  }
  session.voice = { stop };
  function drainFinals() {
    if (closed || active || session.busy || !accepting || !finals.length) return;
    const final = finals.shift();
    metrics.begin(); metrics.mark('input_start');
    void finish(true, final);
  }
  function resume() {
    if (accepting || !resumeTurn) return;
    if (active || session.busy) { resumePending = true; return; }
    resumeTurn = null;
    resetRecording(); accepting = true;
    trace('resume');
    if (sdkMode && finals.length) { drainFinals(); return; }
    send({ type: 'state', state: 'listening', ...(sdkEof ? { detail: 'WAV辨識輸入已結束；所有已取得的最終片段依序處理。' } : {}) });
  }
  client.on('close', stop); client.on('error', stop);
  client.on('message', (raw, binary) => {
    if (closed) return;
    if (binary) {
      if (!accepting || muted) { counters.pausedBytes += raw.length; return; }
      if (sdkMode && (!sdkReady || sdkEof)) return fail('SPEECH_SDK_STATE', 'SDK尚未就緒或已結束輸入。');
      if (!raw.length || raw.length % 2 || raw.length > 48000) return fail('SPEECH_AUDIO', '錄音格式無效。');
      if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); windowBytes = 0; }
      inputBytes += raw.length; windowBytes += raw.length;
      if (inputBytes > MAX_VOICE_INPUT_BYTES || windowBytes > 144000) return fail('SPEECH_AUDIO_LIMIT', '音訊傳輸超過安全上限，已停止。');
      if (sdkMode) {
        if (raw.length > input.chunkBytes || (input.source === 'wav' && inputBytes > input.sampleRate * 2 * 120)) {
          return fail('SPEECH_AUDIO_LIMIT', 'SDK區塊超過票券大小或WAV超過120秒，已停止。');
        }
        try { recognition.write(raw); }
        catch { fail('SPEECH_SDK_INPUT', 'SDK音訊輸入失敗，未切換REST。'); }
        counters.acceptedBytes += raw.length;
        if (raw.every(byte => byte === 0)) counters.silenceBytes += raw.length;
        if (Math.floor(counters.acceptedBytes / (input.sampleRate * 2)) !==
            Math.floor((counters.acceptedBytes - raw.length) / (input.sampleRate * 2))) trace('pcm_accepted');
        return;
      }
      const events = vad.push(raw);
      for (const event of events) {
        if (event.type === 'start') {
          metrics.begin(); metrics.mark('input_start');
          send({ type: 'state', state: 'listening', detail: '偵測到聲音，依本次停頓設定自動送出。' });
          recordingTimer = setTimeout(() => fail('SPEECH_RECORDING_TIMEOUT', '語音片段超過30秒，請重新連線並分段說明。'), 30000);
        } else if (event.type === 'audio') {
          chunks.push(event.audio); recordingBytes += event.audio.length;
          if (recordingBytes > MAX_RECORDING_BYTES) return fail('SPEECH_AUDIO_LIMIT', '錄音超過30秒，已停止。');
        } else if (event.type === 'discard') {
          resetRecording(); send({ type: 'state', state: 'listening', detail: '短暫聲響未送出，繼續等待語音。' });
        } else if (event.type === 'end') {
          // The detector resets after emitting the completed segment.
          void finish(true); return;
        }
      }
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return fail('SPEECH_PROTOCOL', 'Speech控制訊息無效。'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return fail('SPEECH_PROTOCOL', 'Speech控制訊息必須是物件。');
    if (event.type === 'stop' && Object.keys(event).length === 1) return stop();
    if (event.type === 'finish' && Object.keys(event).length === 1 && !sdkMode) { void finish(); return; }
    if (event.type === 'input_eof' && Object.keys(event).length === 1 && sdkMode && sdkReady && input.source === 'wav') {
      sdkEof = true; recognition.finishInput(); return;
    }
    if (event.type === 'mute' && typeof event.muted === 'boolean' && Object.keys(event).length === 2) {
      muted = event.muted; if (accepting) resetRecording(); return;
    }
    if (event.type === 'displayed' && typeof event.turnId === 'string' && Object.keys(event).length === 2) return;
    if (event.type === 'segmentPlayed' && Object.keys(event).length === 3) {
      if (playback && event.turnId === playback.turnId && event.segment === playback.segment) {
        clearTimeout(playbackTimer); const done = playback.resolve; playback = null; done();
        trace('segment_ack');
      }
      return;
    }
    if (event.type === 'resume' && Object.keys(event).every(key => ['type', 'turnId'].includes(key)) &&
        (event.turnId === undefined || typeof event.turnId === 'string')) {
      if (event.turnId !== undefined && event.turnId !== resumeTurn) return;
      resume(); return;
    }
    fail('SPEECH_PROTOCOL', '不支援的Speech控制訊息。');
  });
  if (sdkMode) {
    recognition = createSpeechRecognition({ ...config, locale }, input, {
      credential: dependencies.credential, sdk: dependencies.speechSdk,
      onEvent: event => {
        if (event.kind === 'recognizing') counters.partials++;
        else if (event.kind === 'recognized') { counters.finals++; trace('recognized'); }
        else if (['input_eof', 'session_stopped', 'canceled'].includes(event.kind)) trace(event.kind);
        send(event);
      },
      onFinal: final => {
        if (closed) return;
        if (finals.length >= 8) return fail('SPEECH_SDK_QUEUE', '辨識片段佇列已滿，已停止；未遺失後假裝完成。');
        finals.push(final);
        trace('final_queued');
        send({ type: 'state', state: 'thinking', detail: 'SDK最終辨識片段已排隊；不是語意回合結束判定。' });
        setImmediate(drainFinals);
      },
      onFailure: fail
    });
    void recognition.start().then(() => {
      if (closed) return;
      sdkReady = true;
      send({ type: 'ready', mode: 'speech-direct', stt: 'sdk', sampleRate: input.sampleRate, voice: 'personal-voice', turnBoundResume: true });
    });
  } else send({ type: 'ready', mode: 'speech-direct', sampleRate: 24000, voice: 'personal-voice', vad: 'acoustic', turnBoundResume: true });
  return { stop };
}
