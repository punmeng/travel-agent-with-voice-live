import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { AppError } from './core.js';
import { chat, chatSchema } from './agents.js';
import { MAX_TURNS, MAX_VOICE_INPUT_BYTES, MAX_VOICE_OUTPUT_BYTES } from './limits.js';
import { speechText } from './speech.js';

export function voiceConfig(env) {
  if (env.VOICE_LIVE_ENABLED !== 'true') return null;
  const endpoint = new URL(env.VOICE_LIVE_ENDPOINT);
  if (endpoint.protocol !== 'https:' || !/^[\w-]+\.services\.ai\.azure\.com$/.test(endpoint.hostname) ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password) throw new Error('Invalid VOICE_LIVE_ENDPOINT');
  const voiceType = env.VOICE_LIVE_VOICE_TYPE ?? 'azure-standard';
  if (!['azure-standard', 'azure-personal'].includes(voiceType)) throw new Error('Invalid VOICE_LIVE_VOICE_TYPE');
  let voice = 'zh-TW-HsiaoChenNeural', outputVoice = { type: 'azure-standard', name: voice };
  if (voiceType === 'azure-personal') {
    const name = env.VOICE_LIVE_PERSONAL_VOICE_NAME?.trim();
    const model = env.VOICE_LIVE_PERSONAL_VOICE_MODEL;
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('Personal Voice requires a valid server-side VOICE_LIVE_PERSONAL_VOICE_NAME; no default substitution.');
    }
    if (!['DragonLatestNeural', 'DragonHDOmniLatestNeural'].includes(model)) {
      throw new Error('Personal Voice requires supported VOICE_LIVE_PERSONAL_VOICE_MODEL.');
    }
    voice = 'personal-voice';
    outputVoice = { type: voiceType, name, model };
  }
  return { endpoint: endpoint.origin, model: 'gpt-5.4', version: '2026-07-15', voice, outputVoice };
}

export function voiceSessionUpdate(config) {
  return {
    type: 'session.update', session: {
      modalities: ['text', 'audio'], input_audio_format: 'pcm16', output_audio_format: 'pcm16',
      input_audio_sampling_rate: 24000,
      input_audio_transcription: { model: 'azure-speech', language: 'zh-TW' },
      turn_detection: { type: 'azure_semantic_vad_multilingual', languages: ['zh'], silence_duration_ms: 800, create_response: false, interrupt_response: false },
      input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
      input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
      voice: config.outputVoice,
      instructions: 'Do not generate answers. The server supplies pre-generated assistant text. No tools or transactions.',
      tools: []
    }
  };
}

export const quoteContext = state => state?.quote ? Object.fromEntries(
  [['quoteId', state.quote.id], ...['version', 'total', 'currency', 'expiresAt'].map(k => [k, state.quote[k]])]
) : null;

export function voiceFailureDetails(error, elapsedMs) {
  const safeType = value => ['Error', 'AppError', 'TypeError', 'SyntaxError', 'ZodError', 'TimeoutError', 'AbortError',
    'CredentialUnavailableError', 'AuthenticationError', 'AggregateAuthenticationError'].includes(value) ? value : 'OtherError';
  const code = error?.cause?.code;
  return {
    errorType: safeType(error?.constructor?.name),
    causeType: error?.cause ? safeType(error.cause.constructor?.name) : undefined,
    causeCode: typeof code === 'string' && /^(?:UND_ERR_[A-Z_]+|E[A-Z_]{2,30})$/.test(code) ? code : undefined,
    stage: ['auth', 'responses.fetch', 'responses.decode', 'responses.http'].includes(error?.stage) ? error.stage : 'chat',
    upstreamStatus: Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : undefined,
    elapsedMs, upstreamElapsedMs: Number.isFinite(error?.elapsedMs) ? error.elapsedMs : undefined
  };
}

// Only this bridge can create responses; the browser sends PCM or bounded UI acknowledgments.
export function bridgeVoice(client, upstream, session, env, config, dependencies = {}) {
  const runChat = dependencies.chat ?? chat;
  let closed = false, ready = false, thinking = false, responseActive = false, muted = false, turns = 0;
  let activeTurn = null, queuedTurn = null, cancelledResponse = null, activeResponse = null, audioSuppressed = false;
  let inputBytes = 0, outputBytes = 0, windowBytes = 0, windowAt = Date.now();
  let delivered = dependencies.initialContext ?? { offerIds: [], quoteContext: null }, pending = null;
  const seen = new Set();
  const send = data => {
    if (!closed && client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 2_000_000) return fail('VOICE_BACKPRESSURE', '語音播放連線過慢，已停止。');
      client.send(JSON.stringify(data));
    }
  };
  const write = event => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event)); };
  const stop = () => {
    if (closed) return;
    closed = true; clearTimeout(handshake); queuedTurn = null;
    if (activeTurn && !activeTurn.transaction) activeTurn.controller.abort();
    upstream.close(); client.close(1000);
    if (session.voice?.stop === stop) session.voice = null;
  };
  const fail = (code, message, details) => {
    const correlationId = randomUUID();
    console.error(JSON.stringify({ correlationId, code, ...details }));
    if (!closed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', code, message, correlationId }));
    stop();
  };
  const handshake = setTimeout(() => fail('VOICE_TIMEOUT', 'Voice Live 連線逾時，請停止後重試。'), 20000);
  async function processTurn(turn) {
    activeTurn = turn; thinking = true; session.busy = true; session.updatedAt = Date.now();
    const startedAt = Date.now();
    try {
      const result = await runChat(session, {
        message: turn.message, requestId: turn.id,
        offerIds: turn.context?.offerIds ?? [], quoteContext: turn.context?.quoteContext ?? null
      }, env, { ...dependencies, signal: turn.controller.signal,
        onProgress: role => {
          if (!closed && !turn.superseded && activeTurn === turn && ['intent', 'planner', 'flight', 'price'].includes(role)) {
            send({ type: 'progress', turnId: turn.id, role });
          }
        },
        onTransaction: () => { turn.transaction = true; } });
      if (closed || turn.superseded) return;
      pending = { id: turn.id, context: { quoteContext: quoteContext(result.state), offerIds: result.state.offers.map(o => o.id) } };
      send({ type: 'result', result, turnId: turn.id });
      if (queuedTurn) return;
      audioSuppressed = false;
      write({ type: 'response.create', response: {
        pre_generated_assistant_message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: speechText(result.text) }] }
      } });
    } catch (error) {
      if (!closed && !turn.superseded) {
        fail(error instanceof AppError ? error.code : 'VOICE_TURN_FAILED',
          error instanceof AppError ? error.message : '這段對話未完成，請稍後重試；原有偏好仍保留。',
          voiceFailureDetails(error, Date.now() - startedAt));
      }
    } finally {
      activeTurn = null;
      if (queuedTurn && !closed) {
        const next = queuedTurn; queuedTurn = null;
        // Keep ownership across the handoff; no concurrent chat or unlocked transaction gap.
        void processTurn(next);
      } else { thinking = false; session.busy = false; }
    }
  }
  session.voice = { stop };
  upstream.on('open', () => write(voiceSessionUpdate(config)));
  upstream.on('unexpected-response', (_request, response) => {
    response.resume();
    fail('VOICE_UPSTREAM', `Voice Live 拒絕連線（HTTP ${response.statusCode}），未使用替代語音。`);
  });
  upstream.on('error', () => fail('VOICE_CONNECTION', 'Voice Live 連線失敗，請檢查 Azure 身分與資源存取。'));
  upstream.on('close', () => { if (!closed) fail('VOICE_CLOSED', 'Voice Live 已中斷，已停止麥克風連線。'); });
  client.on('close', stop);
  client.on('error', stop);
  client.on('message', (raw, binary) => {
    if (closed) return;
    if (binary) {
      if (!ready || raw.length > 48000 || raw.length % 2) return fail('VOICE_AUDIO', '音訊格式無效，已停止連線。');
      if (muted) return;
      if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); windowBytes = 0; }
      inputBytes += raw.length; windowBytes += raw.length;
      if (inputBytes > MAX_VOICE_INPUT_BYTES || windowBytes > 144000 || upstream.bufferedAmount > 1_000_000) return fail('VOICE_AUDIO_LIMIT', '語音資料超過用量或傳輸上限，已停止。');
      write({ type: 'input_audio_buffer.append', audio: raw.toString('base64') });
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return fail('VOICE_PROTOCOL', '語音控制訊息無效。'); }
    if (event.type === 'stop' && Object.keys(event).length === 1) return stop();
    if (event.type === 'displayed' && Object.keys(event).length === 2 && pending?.id === event.turnId) {
      delivered = pending.context; pending = null; return;
    }
    if (event.type === 'mute' && typeof event.muted === 'boolean' && Object.keys(event).length === 2) {
      muted = event.muted;
      write({ type: 'input_audio_buffer.clear' }); return;
    }
    fail('VOICE_PROTOCOL', '不支援的語音控制訊息，已停止。');
  });
  upstream.on('message', async raw => {
    if (closed) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return fail('VOICE_PROTOCOL', 'Voice Live 回傳無效資料。'); }
    if (event.type === 'error') return fail('VOICE_SERVICE', `Voice Live 錯誤（${String(event.error?.code ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 80)}），未切換替代服務。`);
    if (event.type === 'session.updated') {
      clearTimeout(handshake); ready = true;
      send({ type: 'ready', sampleRate: 24000, voice: config.voice, maxTurns: MAX_TURNS, remainingTurns: MAX_TURNS - session.turns }); return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      audioSuppressed = true;
      if (responseActive) {
        cancelledResponse = activeResponse;
        write({ type: 'response.cancel' });
      }
      responseActive = false;
      send({ type: 'interrupted' }); return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') return fail('VOICE_TRANSCRIPTION', '未能辨識語音，請重新連線後再說一次。');
    if (event.type === 'response.created') {
      activeResponse = event.response?.id;
      if (audioSuppressed) { cancelledResponse = activeResponse; write({ type: 'response.cancel' }); }
      else responseActive = true;
      return;
    }
    if (event.type === 'response.audio.delta') {
      if (!responseActive || audioSuppressed || (event.response_id && event.response_id !== activeResponse) || typeof event.delta !== 'string') return;
      outputBytes += Buffer.byteLength(event.delta, 'base64');
      if (outputBytes > MAX_VOICE_OUTPUT_BYTES) return fail('VOICE_OUTPUT_LIMIT', '語音輸出已達上限，文字對話仍保留。');
      send({ type: 'audio', audio: event.delta }); return;
    }
    if (event.type === 'response.done') {
      if (event.response?.id && event.response.id === cancelledResponse) { cancelledResponse = null; return; }
      if (event.response?.id && activeResponse && event.response.id !== activeResponse) return;
      responseActive = false;
      if (event.response?.status === 'failed') return fail('VOICE_SYNTHESIS', 'Voice Live 朗讀失敗，對話文字已保留。');
      send({ type: 'audioDone' }); return;
    }
    if (event.type !== 'conversation.item.input_audio_transcription.completed') return;
    if (!ready || typeof event.transcript !== 'string' || !event.transcript.trim()) return;
    if (typeof event.item_id !== 'string' || event.item_id.length > 256) return fail('VOICE_PROTOCOL', 'Voice Live 轉錄識別碼無效。');
    if (seen.has(event.item_id)) return;
    seen.add(event.item_id);
    if (++turns > MAX_TURNS) return fail('VOICE_TURN_LIMIT', `本次語音已達 ${MAX_TURNS} 回合上限。`);
    if (event.transcript.length > 2000) return fail('VOICE_TRANSCRIPT_LIMIT', '這段語音太長，請分段說明。');
    const turnId = randomUUID();
    send({ type: 'transcript', text: event.transcript, turnId });
    send({ type: 'state', state: 'thinking' });
    const turn = { id: turnId, message: event.transcript, context: delivered,
      controller: new AbortController(), transaction: false, superseded: false };
    delivered = null;
    if (activeTurn) {
      if (!activeTurn.transaction) {
        const prior = queuedTurn?.message ?? activeTurn.message;
        turn.message = `${prior}\n使用者最新更正：${turn.message}`;
        if (turn.message.length > 2000) return fail('VOICE_TRANSCRIPT_LIMIT', '連續更正太長，請停止後分段說明；未重做交易。');
        activeTurn.superseded = true;
        activeTurn.controller.abort();
        if (queuedTurn) send({ type: 'superseded', turnId: queuedTurn.id });
        send({ type: 'superseded', turnId: activeTurn.id });
      } else if (queuedTurn) {
        // Only one pending follow-up, never retry a transaction or carry unseen quote consent.
        return fail('VOICE_PENDING_LIMIT', '確認仍在完成，請稍後再補充；沒有重做交易。');
      }
      queuedTurn = turn;
    } else if (session.busy) {
      fail('SESSION_BUSY', '上一段仍在完成，請稍後重新連線；未執行平行變更。');
    } else { void processTurn(turn); }
  });
  return { stop };
}

export function attachVoice(server, sessions, env, dependencies = {}) {
  const config = voiceConfig(env);
  const tickets = new Map(), connecting = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 48000, handleProtocols: protocols => protocols.has('journey-voice') ? 'journey-voice' : false });
  server.on('close', () => { for (const s of sessions.values()) s.voice?.stop(); wss.close(); });
  server.on('upgrade', async (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (!config || req.url !== '/api/voice/stream' || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '') ||
        req.headers.origin !== `http://${req.headers.host}`) return reject(403);
    const id = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('journey='))?.slice(8);
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    const nonce = protocols.find(p => /^[a-f0-9]{64}$/.test(p));
    const ticket = tickets.get(nonce);
    tickets.delete(nonce);
    const session = sessions.get(id);
    if (!ticket || ticket.id !== id || ticket.expires < Date.now() || !session || session.voice || session.busy || connecting.has(id)) return reject(403);
    if (connecting.size + [...sessions.values()].filter(s => s.voice).length >= 4) return reject(429);
    connecting.add(id);
    try {
      const credential = dependencies.credential ?? (env.FOUNDRY_AUTH_MODE === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential());
      const token = await credential.getToken('https://ai.azure.com/.default');
      if (!token || socket.destroyed) return reject(502);
      wss.handleUpgrade(req, socket, head, client => {
        const url = new URL('/voice-live/realtime', config.endpoint);
        url.protocol = 'wss:'; url.searchParams.set('api-version', config.version); url.searchParams.set('model', config.model);
        const upstream = dependencies.connect ? dependencies.connect(url, token.token) :
          new WebSocket(url, { headers: { Authorization: `Bearer ${token.token}` }, handshakeTimeout: 15000, maxPayload: 2_000_000 });
        bridgeVoice(client, upstream, session, env, config, { ...dependencies, initialContext: ticket.displayed });
      });
    } catch {
      console.error(JSON.stringify({ code: 'VOICE_AUTH', correlationId: randomUUID() }));
      reject(502);
    } finally { connecting.delete(id); }
  });
  return {
    available: Boolean(config),
    type: config?.outputVoice.type ?? null,
    ticket(session, raw = {}) {
      if (!config) throw new AppError('VOICE_NOT_CONFIGURED', 'Voice Live 未啟用，請設定後端後再連線。', 503);
      if (session.voice || connecting.has(session.id)) throw new AppError('VOICE_ACTIVE', '此旅程已有語音連線。', 409);
      if ((session.voiceConnections ?? 0) >= 3) throw new AppError('VOICE_CONNECT_LIMIT', '此旅程已達三次語音連線上限，請開啟新旅程。', 429);
      const displayed = chatSchema.pick({ offerIds: true, quoteContext: true }).parse(raw);
      if (displayed.offerIds && JSON.stringify(displayed.offerIds) !== JSON.stringify([...session.offers.keys()])) throw new AppError('STALE_OPTIONS', '對話中的航班已更新，請重新整理後再開始語音。', 409);
      if (displayed.quoteContext && JSON.stringify(displayed.quoteContext) !== JSON.stringify(quoteContext({ quote: session.quote }))) throw new AppError('STALE_QUOTE', '對話中的報價已更新，請重新整理並閱讀後再開始語音。', 409);
      for (const [key, ticket] of tickets) if (ticket.expires < Date.now() || ticket.id === session.id) tickets.delete(key);
      const nonce = randomBytes(32).toString('hex');
      tickets.set(nonce, { id: session.id, expires: Date.now() + 30000, displayed });
      session.voiceConnections = (session.voiceConnections ?? 0) + 1;
      return { protocol: 'journey-voice', nonce, path: '/api/voice/stream' };
    }
  };
}
