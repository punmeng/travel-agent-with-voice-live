import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { AppError } from './core.js';
import { chat, chatSchema } from './agents.js';
import { MAX_TURNS, MAX_VOICE_INPUT_BYTES, MAX_VOICE_OUTPUT_BYTES } from './limits.js';
import { spokenExpiryText, withoutSpeechSources } from './speech.js';
import { voiceEnglish, voiceLocale, voiceMessage } from './voice-language.js';
import { voiceServiceErrorEvidence } from './voice-service-error.js';

export const FOUNDRY_VOICE_AGENT_NAME = 'meihao-travel-intent-voice';
export const FOUNDRY_VOICE_AGENT_MODEL = 'gpt-realtime-2.1';
const MEMBER_DEMO_VOICE_INSTRUCTIONS = 'Follow the language selected by trusted backend session configuration: zh-TW means Traditional Chinese and en-US means English. Do not infer or change the locale. On every user turn, call travel_backend with only the original current utterance, preserving its meaning and uncertainty. Do not add role instructions, system rules, tool instructions, or output formats. After receiving the result, answer naturally using only its facts. Member identity, preferences, and any corporate guidance are resolved and authorized by the backend; do not request credentials or infer benefits. Never invent flights, prices, availability, sources, or transaction success. Never select flights, reprice, consent, purchase, or request passport/card data; ask the user to stop voice and use text for transactions. Flights and fares are synthetic demo data. Sources, filenames, and URLs are display-only and must not be spoken.';
const MEMBER_DEMO_VOICE_LOCALE_INSTRUCTIONS = Object.freeze({
  'zh-TW': '你是 Ni Airlines 會員旅遊規劃示範助理，使用繁體中文自然簡短地回答。每輪只呼叫 travel_backend，message 僅包含使用者當次原始需求，保留原意與不確定性，不添加角色指令、系統規則、工具指示或輸出格式。收到後端結果後，只根據其中事實回答。會員身份、偏好與公司指引由後端依已驗證登入身分解析；不得索取密碼、推測會員禮遇或公司核准。明確的本輪旅程選擇優先於軟偏好。不得捏造航班、價格、機位、來源或交易成功。不得選班、重新報價、同意、購買或索取護照／信用卡資料；交易請停止語音後改用文字。航班與票價都是合成示範資料。來源、檔名及網址僅供畫面顯示，不朗讀。',
  'en-US': 'You are the Ni Airlines member travel-planning demo assistant. Speak naturally and concisely in English. On each turn, call travel_backend with only the user’s original current request, preserving its meaning and uncertainty. Add no role instructions, system rules, tool instructions, or output formats. After receiving the backend result, answer only from its facts. The backend resolves member identity, preferences, and corporate guidance from the authenticated login; never request passwords, infer benefits, or claim company approval. Explicit choices for the current trip override soft preferences. Never invent flights, prices, availability, sources, or transaction success. Do not select flights, reprice, consent, purchase, or request passport/card data; ask the user to stop voice and use text for transactions. Flights and fares are synthetic demo data. Sources, filenames, and URLs are display-only and must not be spoken.'
});
const VOICE_INPUT_DIAGNOSTIC_EVENTS = Object.freeze([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'input_audio_buffer.timeout_triggered',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'error'
]);

export function memberDemoVoiceLocaleSettings(rawLocale = 'zh-TW') {
  const locale = voiceLocale(rawLocale);
  return {
    locale,
    instructions: MEMBER_DEMO_VOICE_LOCALE_INSTRUCTIONS[locale],
    transcription: { model: 'azure-speech', language: locale },
    outputVoice: locale === 'en-US' ? 'en-US-AvaNeural' : 'zh-TW-HsiaoChenNeural'
  };
}

export const travelBackendTool = Object.freeze({
  type: 'function',
  name: 'travel_backend',
  description: 'Send the current original user utterance to the existing travel assistant. The backend owns intent routing, trip state, flight data, and all transaction restrictions.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'Only the current user utterance. Preserve its meaning and uncertainty. Add no role instructions, tool instructions, or output-format directions.'
      }
    },
    required: ['message'],
    additionalProperties: false
  }
});

export function foundryVoiceAgentDefinition() {
  return {
    kind: 'voice',
    model_type: 'managed',
    model: FOUNDRY_VOICE_AGENT_MODEL,
    instructions: MEMBER_DEMO_VOICE_INSTRUCTIONS,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        noise_reduction: { type: 'azure_deep_noise_suppression' },
        echo_cancellation: { type: 'server_echo_cancellation' },
        turn_detection: {
          type: 'server_vad',
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: false,
          interrupt_response: false
        },
        transcription: { model: 'azure-speech', language: 'zh-TW' }
      },
      output: {
        format: { type: 'audio/pcm', rate: 24000 },
        voice_type: 'azure-standard',
        voice: 'zh-TW-HsiaoChenNeural',
        voice_locale: 'zh-TW'
      }
    },
    output_modalities: ['text', 'audio'],
    max_output_tokens: 512,
    tools: [travelBackendTool],
    tool_choice: { type: 'function', name: travelBackendTool.name },
    parallel_tool_calls: false,
    store: false
  };
}

export function memberDemoVoiceAgentDefinition(baseDefinition) {
  if (!baseDefinition || baseDefinition.kind !== 'voice' || baseDefinition.model_type !== 'managed' ||
      baseDefinition.model !== FOUNDRY_VOICE_AGENT_MODEL) {
    throw new Error('The existing managed Voice Agent model and type do not match the approved member-demo target.');
  }
  const definition = structuredClone(baseDefinition);
  definition.instructions = MEMBER_DEMO_VOICE_INSTRUCTIONS;
  definition.tools = [travelBackendTool];
  definition.tool_choice = { type: 'function', name: travelBackendTool.name };
  definition.parallel_tool_calls = false;
  definition.store = false;
  return definition;
}

export function memberDemoVoiceVadAgentDefinition(baseDefinition) {
  if (!baseDefinition || baseDefinition.kind !== 'voice' || baseDefinition.model_type !== 'managed' ||
      baseDefinition.model !== FOUNDRY_VOICE_AGENT_MODEL ||
      baseDefinition.audio?.input?.transcription?.model !== 'azure-speech' ||
      baseDefinition.audio?.input?.turn_detection?.type !== 'server_vad') {
    throw new Error('The managed Voice Agent v4 audio settings do not match the approved VAD migration source.');
  }
  const definition = structuredClone(baseDefinition);
  definition.audio.input.turn_detection.type = 'azure_semantic_vad_multilingual';
  return definition;
}

export function memberDemoLocaleVoiceAgentDefinition(baseDefinition, rawLocale) {
  if (!baseDefinition || baseDefinition.kind !== 'voice' || baseDefinition.model_type !== 'managed' ||
      baseDefinition.model !== FOUNDRY_VOICE_AGENT_MODEL ||
      baseDefinition.store !== false ||
      baseDefinition.audio?.input?.turn_detection?.type !== 'azure_semantic_vad_multilingual' ||
      baseDefinition.audio?.input?.transcription?.model !== 'azure-speech' ||
      baseDefinition.audio?.input?.transcription?.language !== 'zh-TW' ||
      baseDefinition.audio?.output?.voice !== 'zh-TW-HsiaoChenNeural' ||
      (baseDefinition.audio?.output?.voice_locale !== undefined &&
        baseDefinition.audio?.output?.voice_locale !== 'zh-TW')) {
    throw new Error('The managed Voice Agent v5 definition does not match the approved locale-version source.');
  }
  const settings = memberDemoVoiceLocaleSettings(rawLocale);
  const definition = structuredClone(baseDefinition);
  definition.instructions = settings.instructions;
  definition.audio.input.transcription = settings.transcription;
  definition.audio.output.voice = settings.outputVoice;
  definition.audio.output.voice_locale = settings.locale;
  return definition;
}

export function foundryVoiceSessionConfig(rawLocale = 'zh-TW') {
  voiceLocale(rawLocale);
  return { type: 'realtime' };
}

export function sessionAudioMismatch(actual) {
  const mismatches = [];
  for (const direction of ['input', 'output']) {
    const format = actual?.audio?.[direction]?.format;
    if (format?.type !== 'audio/pcm' || format?.rate !== 24000) {
      mismatches.push(`audio.${direction}.format`);
    }
  }
  const echo = actual?.audio?.input?.echo_cancellation;
  if (echo?.type !== 'server_echo_cancellation' || echo.reference_source !== 'server' || echo.channels !== 1) {
    mismatches.push('audio.input.echo_cancellation');
  }
  return mismatches;
}

export function sessionLocaleMismatch(actual, expected) {
  const mismatches = [];
  if (actual?.instructions !== expected.instructions) mismatches.push('instructions');
  if (actual?.audio?.input?.transcription?.model !== expected.audio.input.transcription.model) {
    mismatches.push('audio.input.transcription.model');
  }
  if (actual?.audio?.input?.transcription?.language !== expected.audio.input.transcription.language) {
    mismatches.push('audio.input.transcription.language');
  }
  if (actual?.audio?.output?.voice !== expected.audio.output.voice) mismatches.push('audio.output.voice');
  if (actual?.audio?.output?.voice_locale !== undefined &&
      actual.audio.output.voice_locale !== expected.audio.output.voice_locale) {
    mismatches.push('audio.output.voice_locale');
  }
  return mismatches;
}

export function sessionGuardMismatch(actual) {
  const mismatches = [];
  const vad = actual?.audio?.input?.turn_detection;
  if (vad?.type !== 'azure_semantic_vad_multilingual' || vad.create_response !== false ||
      vad.interrupt_response !== false) mismatches.push('audio.input.turn_detection');
  if (actual?.tool_choice?.type !== 'function' || actual.tool_choice.name !== 'travel_backend' ||
      actual.parallel_tool_calls !== false) mismatches.push('tool_choice');
  const tool = actual?.tools?.[0], parameters = tool?.parameters;
  if (actual?.tools?.length !== 1 || tool?.type !== 'function' || tool.name !== 'travel_backend' ||
      parameters?.type !== 'object' || parameters.additionalProperties !== false ||
      parameters.required?.length !== 1 || parameters.required[0] !== 'message' ||
      Object.keys(parameters.properties ?? {}).length !== 1 || parameters.properties?.message?.type !== 'string') {
    mismatches.push('tools');
  }
  return mismatches;
}

const responseDetails = response => ({
  responseStatus: ['completed', 'failed', 'cancelled', 'incomplete', 'in_progress'].includes(response?.status) ? response.status : 'other',
  outputCount: Array.isArray(response?.output) ? response.output.length : null,
  functionCallCount: Array.isArray(response?.output) ? response.output.filter(item => item?.type === 'function_call').length : null
});

const TERMINAL_MARKS = Object.freeze(['。', '.', '？', '?', '！', '!']);
const AMBIGUOUS_FINAL_WORD = /^(?:[a-z]{1,3}|approx|assoc|bros|corp|dept|est|inc|intl|ltd|misc|prof|resp|univ|versus)$/i;

function withoutTerminalMark(value) {
  const mark = value.at(-1);
  if (!TERMINAL_MARKS.includes(mark)) return value;
  const body = value.slice(0, -1);
  if (!body || body !== body.trimEnd() || TERMINAL_MARKS.includes(body.at(-1))) return value;
  if (mark === '.') {
    const token = body.split(/\s/u).at(-1);
    // A final dot can belong to a decimal, initial, dotted acronym or abbreviation.
    if (/\p{N}$/u.test(body) || token.includes('.') ||
        (/^[A-Za-z]+$/.test(token) && (AMBIGUOUS_FINAL_WORD.test(token) || token === token.toUpperCase()))) return value;
  }
  return body;
}

export function voiceTranscriptComparison(transcript, delegated) {
  const whitespace = value => value.trim().replace(/\s+/gu, ' ');
  const original = whitespace(transcript), message = whitespace(delegated);
  return {
    transcriptLength: transcript.length,
    delegatedLength: delegated.length,
    exactEqual: transcript === delegated,
    whitespaceEqual: original === message,
    terminalOnlyEqual: withoutTerminalMark(original) === withoutTerminalMark(message),
    punctuationOnlyEqual: original.replace(/\p{P}/gu, '') === message.replace(/\p{P}/gu, ''),
    numericOnlyEqual: original.replace(/\p{N}+/gu, '#') === message.replace(/\p{N}+/gu, '#')
  };
}

export function bridgeFoundryVoiceAgent(client, connection, session, env, config, dependencies = {}) {
  const locale = voiceLocale(config.locale ?? session.locale), english = voiceEnglish(locale);
  const localeSettings = memberDemoVoiceLocaleSettings(locale);
  const requestedSessionConfig = foundryVoiceSessionConfig(locale);
  let audioMismatches = null;
  const runChat = dependencies.chat ?? chat;
  let closed = false, ready = false, muted = false, responseRequested = false, responseKind = null;
  let startupGreetingHandled = false;
  let activeResponse = null, cancelBeforeCreate = false, awaitingTool = false, activeTurn = null;
  let activeInputItem = null, pendingInputItem = null, spokenTurnId = null, queuedBytes = 0;
  let turns = 0, inputBytes = 0, inputFrames = 0, appendedAudioBytes = 0, appendedAudioFrames = 0;
  let outputBytes = 0, windowBytes = 0, windowAt = Date.now();
  let toolTimer, handshakeTimer, inputChain = Promise.resolve(), connectionClose;
  let delivered = dependencies.initialContext ?? { offerIds: [], quoteContext: null }, pendingDisplay = null;
  let pendingSpeechTurn = null, pendingSpeechEnabled = false, pendingToolCall = null;
  const committedItems = new Set(), seenItems = new Set(), transcriptions = new Map(), transcribedItems = new Set();
  const seenCalls = new Set(), cancelledResponses = new Set(), completedResponses = new Set();
  const diagnosticStartedAt = Date.now();
  const diagnosticCounts = Object.fromEntries(VOICE_INPUT_DIAGNOSTIC_EVENTS.map(type => [type, 0]));
  const diagnosticEvents = [];
  const delegationDiagnostics = [];
  const flow = { sdkStarted: 0, sdkCompleted: 0, sdkPending: false, sdkStartedAt: null,
    maxSdkSendMs: 0, ackIssuedBytes: 0, ackSendCallbacks: 0, ackCallbackBytes: 0,
    ackSendErrors: 0, lastAckAt: null, maxQueuedBytes: 0 };
  let clientFlowDiagnostic = null;
  const flowSnapshot = () => ({
    ...flow, queuedBytes, sdkPendingMs: flow.sdkPending ? Date.now() - flow.sdkStartedAt : 0,
    lastAckAgeMs: flow.lastAckAt === null ? null : Date.now() - flow.lastAckAt,
    clientBufferedBytes: client.bufferedAmount,
    ...(clientFlowDiagnostic ? { client: clientFlowDiagnostic } : {})
  });
  const diagnosticSnapshot = () => ({
    elapsedMs: Math.max(0, Date.now() - diagnosticStartedAt),
    audio: {
      format: 'pcm16-mono',
      sampleRateHz: 24000,
      clientFramesAccepted: inputFrames,
      clientBytesAccepted: inputBytes,
      sdkAppendCalls: appendedAudioFrames,
      sdkAppendBytes: appendedAudioBytes
    },
    eventCounts: { ...diagnosticCounts },
    inputFlow: flowSnapshot(),
    delegations: delegationDiagnostics.map(event => ({ ...event, association: { ...event.association },
      ...(event.comparison ? { comparison: { ...event.comparison } } : {}) })),
    events: diagnosticEvents.map(event => ({ ...event, audio: { ...event.audio }, state: { ...event.state },
      ...(event.error ? { error: { ...event.error } } : {}) }))
  });
  const recordDelegationDiagnostic = (type, association, comparison) => {
    delegationDiagnostics.push({ type, elapsedMs: Math.max(0, Date.now() - diagnosticStartedAt),
      association, ...(comparison ? { comparison, source: 'same-item-final-asr',
        equalityIsDiagnosticOnly: true, accepted: true } : {}) });
    if (delegationDiagnostics.length > 64) delegationDiagnostics.shift();
  };
  const recordInputDiagnostic = event => {
    if (!VOICE_INPUT_DIAGNOSTIC_EVENTS.includes(event.type)) return;
    diagnosticCounts[event.type]++;
    const entry = {
      type: event.type,
      elapsedMs: Math.max(0, Date.now() - diagnosticStartedAt),
      audio: {
        clientFramesAccepted: inputFrames,
        clientBytesAccepted: inputBytes,
        sdkAppendCalls: appendedAudioFrames,
        sdkAppendBytes: appendedAudioBytes
      },
      state: {
        ready,
        muted,
        turns,
        responseRequested,
        responseKind,
        activeResponse: Boolean(activeResponse),
        pendingInput: Boolean(pendingInputItem),
        awaitingTool,
        activeTurn: Boolean(activeTurn)
      },
      ...(event.type === 'error' ? {
        error: Object.fromEntries(Object.entries({
          ...voiceServiceErrorEvidence(event.error)
        }).filter(([, value]) => value !== undefined))
      } : {})
    };
    diagnosticEvents.push(entry);
    if (diagnosticEvents.length > 64) diagnosticEvents.shift();
  };
  const send = (data, onSent) => {
    if (!closed && client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 2_000_000) return fail('VOICE_BACKPRESSURE', '語音播放連線過慢，已停止。');
      client.send(JSON.stringify({
        ...data,
        ...(data.message ? { message: voiceMessage(locale, data.message, data.code) } : {})
      }), onSent);
    }
  };
  const stop = () => {
    if (closed) return;
    closed = true; clearTimeout(toolTimer); clearTimeout(handshakeTimer);
    pendingInputItem = null; pendingToolCall = null; transcriptions.clear(); queuedBytes = 0;
    if (activeTurn && !activeTurn.transaction) activeTurn.controller.abort();
    connectionClose = Promise.resolve().then(() => connection.close());
    void connectionClose.catch(() => {});
    client.close(1000);
    if (session.voice?.stop === stop) session.voice = null;
  };
  const fail = (code, message, details = {}) => {
    if (closed) return;
    const correlationId = randomUUID();
    console.error(JSON.stringify({ correlationId, code, timestamp: new Date().toISOString(),
      mode: 'foundry-voice-agent', ...details, inputDiagnostics: diagnosticSnapshot() }));
    if (!closed && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'error', code, message: voiceMessage(locale, message, code), correlationId }));
    }
    stop();
  };
  const sendConnection = (operation, code, message) => {
    void operation().catch(() => fail(code, message));
  };
  const armToolTimer = (code, message) => {
    clearTimeout(toolTimer);
    toolTimer = setTimeout(() => fail(code, message), 30000);
  };
  function dispatchResponse() {
    if (closed || !ready || responseRequested || activeResponse || awaitingTool || activeTurn || !pendingInputItem) return;
    if (session.busy) return fail('SESSION_BUSY', '上一段仍在完成，未派發平行委派。');
    activeInputItem = pendingInputItem;
    pendingInputItem = null;
    responseRequested = true; responseKind = 'delegate';
    armToolTimer('VOICE_AGENT_TIMEOUT', 'Foundry Voice Agent未完成旅行委派，已停止。');
    send({ type: 'state', state: 'thinking' });
    sendConnection(
      () => connection.requestResponse({ response: { tool_choice: { type: 'function', name: travelBackendTool.name } } }),
      'VOICE_AGENT_CONNECTION', '無法要求 Foundry Voice Agent 處理這段語音。'
    );
  }
  function requestSpeech(turnId) {
    if (closed || muted || pendingInputItem || cancelBeforeCreate) {
      if (pendingInputItem) dispatchResponse();
      else if (!closed && turnId) send({ type: 'audioDone', turnId });
      return;
    }
    responseRequested = true; responseKind = 'speech'; spokenTurnId = turnId;
    armToolTimer('VOICE_AGENT_TIMEOUT', 'Foundry Voice Agent朗讀逾時，文字回覆仍保留。');
    sendConnection(
      () => connection.requestResponse({ response: { tool_choice: 'none' } }),
      'VOICE_AGENT_CONNECTION', '無法要求 Foundry Voice Agent 朗讀後端結果。'
    );
  }
  async function sendToolOutput(callId, output, turnId, speak) {
    try {
      await connection.sendToolOutput(callId, output, { createResponse: false });
    } catch {
      return fail('VOICE_AGENT_TOOL_OUTPUT', 'Foundry Voice Agent未能接收旅行後端結果；未偽裝完成。');
    }
    if (closed) return;
    awaitingTool = false;
    pendingSpeechTurn = turnId;
    pendingSpeechEnabled = speak && !muted && !cancelBeforeCreate;
  }
  async function processTurn(turn) {
    activeTurn = turn; awaitingTool = true; session.busy = true; session.updatedAt = Date.now();
    const startedAt = Date.now();
    const correlationId = turn.id;
    send({ type: 'transcript', text: `${english ? 'Request summary: ' : '需求摘要：'}${turn.message}`, turnId: turn.id });
    send({ type: 'state', state: 'thinking' });
    try {
      const result = await runChat(session, {
        message: turn.message, requestId: turn.id, locale,
        offerIds: turn.context?.offerIds ?? [], quoteContext: turn.context?.quoteContext ?? null
      }, env, {
        ...dependencies,
        memberAware: true,
        signal: turn.controller.signal,
        onProgress: role => {
          if (!closed && activeTurn === turn && ['intent', 'planner', 'flight', 'price'].includes(role)) {
            send({ type: 'progress', turnId: turn.id, role });
          }
        },
        onTransaction: () => {
          throw new AppError('VOICE_AGENT_TRANSACTION', '請停止語音，再用文字完成選班、報價及購買；尚未執行交易。', 409);
        }
      });
      if (closed) return;
      const state = result.state;
      const quote = state?.quote;
      pendingDisplay = { id: turn.id, context: {
        quoteContext: quote ? Object.fromEntries([['quoteId', quote.id], ...['version', 'total', 'currency', 'expiresAt'].map(key => [key, quote[key]])]) : null,
        offerIds: Array.isArray(state?.offers) ? state.offers.map(offer => offer.id) : []
      } };
      send({ type: 'result', result, turnId: turn.id });
      const speech = spokenExpiryText(withoutSpeechSources(result.speech?.text ?? result.text), locale);
      const toolOutput = JSON.stringify({
        text: speech,
        detail: result.speech?.detail ?? 'summary',
        authoritative: false,
        instruction: english
          ? 'Use only these backend facts. The displayed backend result is authoritative. Never claim a transaction succeeded. Sources are display-only.'
          : '只依這些後端事實回答。畫面後端結果才是權威，不可聲稱交易成功。資料來源僅顯示，不朗讀。'
      });
      activeTurn = null;
      await sendToolOutput(turn.callId, toolOutput, turn.id, !turn.interrupted);
    } catch (error) {
      if (closed || turn.controller.signal.aborted) return;
      if (error instanceof AppError && error.status < 500) {
        send({ type: 'taskError', turnId: turn.id, code: error.code, message: error.message });
        activeTurn = null;
        await sendToolOutput(turn.callId, JSON.stringify({ error: error.code, executed: false }), turn.id, false);
      } else {
        fail(error instanceof AppError ? error.code : 'VOICE_AGENT_TURN_FAILED',
          error instanceof AppError ? error.message : 'Foundry Voice Agent這段委派未完成；已套用的旅程內容請以畫面為準。',
          { elapsedMs: Date.now() - startedAt, errorType: error?.constructor?.name });
      }
    } finally {
      if (activeTurn === turn) activeTurn = null;
      if (session.busy && !activeTurn) session.busy = false;
      if (!closed) {
        if (pendingInputItem && !responseRequested && !activeResponse && !awaitingTool) {
          if (pendingSpeechTurn) send({ type: 'audioDone', turnId: pendingSpeechTurn });
          pendingSpeechTurn = null; pendingSpeechEnabled = false;
          dispatchResponse();
        } else if (pendingSpeechTurn) {
          const turnId = pendingSpeechTurn;
          const speak = pendingSpeechEnabled;
          pendingSpeechTurn = null; pendingSpeechEnabled = false;
          if (speak) requestSpeech(turnId);
          else {
            if (cancelBeforeCreate) { cancelBeforeCreate = false; spokenTurnId = null; }
            send({ type: 'audioDone', turnId });
            send({ type: 'state', state: 'listening' });
          }
        }
      }
    }
  }
  function dispatchToolCall(call) {
    const transcript = transcriptions.get(call.inputItem);
    if (!transcript) {
      pendingToolCall = call;
      awaitingTool = true;
      armToolTimer('VOICE_TRANSCRIPTION_TIMEOUT', '語音辨識最終文字未完成，未派送旅行後端；請停止後重說完整需求。');
      return;
    }
    const comparison = voiceTranscriptComparison(transcript, call.message);
    recordDelegationDiagnostic('transcript_comparison', {
      ...call.association,
      transcriptForCommittedInputPresent: transcriptions.has(call.inputItem)
    }, comparison);
    if (seenItems.has(call.inputItem)) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent重複處理音訊回合，未重複執行。',
      { delegationFailure: 'duplicate_input' });
    seenCalls.add(call.callId); seenItems.add(call.inputItem);
    clearTimeout(toolTimer);
    awaitingTool = true;
    const turn = { id: randomUUID(), message: transcript, context: call.context,
      controller: new AbortController(), transaction: false, interrupted: call.interrupted || muted, callId: call.callId };
    transcriptions.delete(call.inputItem);
    void processTurn(turn);
  }
  function dispatchPendingToolCall() {
    if (!pendingToolCall || !transcriptions.has(pendingToolCall.inputItem)) return;
    const call = pendingToolCall;
    pendingToolCall = null;
    dispatchToolCall(call);
  }
  function acceptToolResponse(response) {
    const association = {
      appRequestedDelegation: responseRequested && responseKind === 'delegate',
      responseMatchesActive: typeof response?.id === 'string' && response.id === activeResponse,
      committedInputKnown: committedItems.has(activeInputItem),
      transcriptForCommittedInputPresent: transcriptions.has(activeInputItem)
    };
    if (!responseRequested || responseKind !== 'delegate' || !activeInputItem ||
        typeof response?.id !== 'string' || !response.id || response.id !== activeResponse) {
      recordDelegationDiagnostic('response_association_rejected', association);
      return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent委派與目前音訊回合不符，未執行。',
        { ...responseDetails(response), delegationFailure: 'response_mismatch' });
    }
    const output = response.output;
    const calls = Array.isArray(output) ? output.filter(item => item?.type === 'function_call') : [];
    const failure = response.status !== 'completed' ? 'response_not_completed' :
      !Array.isArray(output) ? 'output_not_array' : calls.length !== 1 ? 'function_call_count' :
      ![undefined, 'completed'].includes(calls[0].status) ? 'call_not_completed' :
      output.some(item => item !== calls[0] && !(
        ['message', 'reasoning'].includes(item?.type) && [undefined, 'completed'].includes(item.status) &&
        (item.type !== 'message' || [undefined, 'assistant'].includes(item.role)))) ?
        'unexpected_output_item' : null;
    if (failure) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent未完成唯一旅行委派，未執行。',
      { ...responseDetails(response), delegationFailure: failure });
    const call = calls[0];
    if (call.name !== travelBackendTool.name) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent提出未允許的工具，未執行。',
      { ...responseDetails(response), delegationFailure: 'unexpected_tool' });
    if (typeof call.call_id !== 'string' || !/^[\w-]{1,128}$/.test(call.call_id)) {
      return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent的委派識別碼無效，未執行。',
        { ...responseDetails(response), delegationFailure: 'invalid_call_id' });
    }
    if (seenCalls.has(call.call_id)) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent重複提出委派，未重複執行。',
      { ...responseDetails(response), delegationFailure: 'duplicate_call' });
    if (typeof call.arguments !== 'string' || call.arguments.length > 24000) {
      return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent委派參數無效，未執行。',
        { ...responseDetails(response), delegationFailure: 'arguments_type_or_size' });
    }
    let parsed;
    try { parsed = JSON.parse(call.arguments); } catch {
      return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent委派參數無效，未執行。',
        { ...responseDetails(response), delegationFailure: 'arguments_json' });
    }
    let args;
    try { args = chatSchema.pick({ message: true }).parse(parsed); } catch {
      return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent委派參數無效，未執行。',
        { ...responseDetails(response), delegationFailure: 'arguments_schema' });
    }
    if (seenItems.has(activeInputItem)) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent重複處理音訊回合，未重複執行。',
      { ...responseDetails(response), delegationFailure: 'duplicate_input' });
    if (seenCalls.has(call.call_id)) return fail('VOICE_AGENT_TOOL', 'Foundry Voice Agent重複提出委派，未重複執行。',
      { ...responseDetails(response), delegationFailure: 'duplicate_call' });
    completedResponses.add(response.id);
    seenCalls.add(call.call_id);
    pendingToolCall = {
      callId: call.call_id, inputItem: activeInputItem, message: args.message,
      context: delivered, interrupted: false, association
    };
    recordDelegationDiagnostic('tool_response_validated', association);
    delivered = null;
    activeInputItem = null; activeResponse = null; responseRequested = false; responseKind = null;
    clearTimeout(toolTimer);
    const pending = pendingToolCall;
    pendingToolCall = null;
    dispatchToolCall(pending);
  }
  async function handleEvent(event) {
    if (closed || !event || typeof event !== 'object') return;
    if (event.type === 'unknown') return;
    recordInputDiagnostic(event);
    if (event.type === 'error') return fail('VOICE_AGENT_SERVICE', 'Foundry Voice Agent回報服務錯誤，未切換其他語音服務。');
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      return fail('VOICE_AGENT_TRANSCRIPTION', '語音最終辨識失敗，未派送旅行後端；請停止後重說完整需求。');
    }
    if (event.type === 'session.updated') {
      if (!ready) {
        const mismatchedFields = sessionLocaleMismatch(event.session, {
          instructions: localeSettings.instructions,
          audio: { input: { transcription: localeSettings.transcription },
            output: { voice: localeSettings.outputVoice, voice_locale: localeSettings.locale } }
        });
        if (mismatchedFields.length) {
          return fail('VOICE_AGENT_LOCALE_UNAPPLIED', 'Foundry Voice Agent未套用要求的語言設定，未開始收音。', {
            requestedLocale: locale,
            mismatchedFields,
            serverEventId: typeof event.event_id === 'string' ? event.event_id : undefined
          });
        }
        const guardMismatches = sessionGuardMismatch(event.session);
        if (guardMismatches.length) {
          return fail('VOICE_AGENT_SESSION', 'Foundry Voice Agent安全設定不符，未開始收音。',
            { mismatchedFields: guardMismatches });
        }
        audioMismatches = sessionAudioMismatch(event.session);
        if (audioMismatches.length) return;
        ready = true; clearTimeout(handshakeTimer);
        send({ type: 'ready', mode: 'foundry-voice-agent', sampleRate: 24000, voice: 'azure-standard',
          maxTurns: MAX_TURNS, remainingTurns: MAX_TURNS - session.turns,
          inputFlow: { maxUnackedBytes: 12288 } });
        send({ type: 'state', state: 'listening' });
      }
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      if (activeTurn) activeTurn.interrupted = true;
      if (pendingToolCall) pendingToolCall.interrupted = true;
      send({ type: 'interrupted' });
      if (activeResponse || responseRequested && responseKind === 'speech') {
        if (activeResponse) {
          cancelledResponses.add(activeResponse);
          sendConnection(() => connection.cancelResponse({ responseId: activeResponse }),
            'VOICE_AGENT_CANCEL', '等待舊語音回應停止逾時。');
        } else cancelBeforeCreate = true;
      } else if (responseRequested && responseKind === 'delegate') {
        if (activeResponse) {
          cancelledResponses.add(activeResponse);
          sendConnection(() => connection.cancelResponse({ responseId: activeResponse }),
            'VOICE_AGENT_CANCEL', '等待舊語音委派停止逾時。');
        } else cancelBeforeCreate = true;
      }
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped') return;
    if (event.type === 'input_audio_buffer.committed') {
      if (!ready || typeof event.item_id !== 'string' || !/^[\w-]{1,256}$/.test(event.item_id)) {
        return fail('VOICE_AGENT_PROTOCOL', 'Foundry Voice Agent音訊回合識別碼無效。');
      }
      if (committedItems.has(event.item_id)) return;
      if (event.item_id === activeInputItem || event.item_id === pendingInputItem) return;
      if (pendingInputItem) return fail('VOICE_PENDING_LIMIT', '已有一段語音等待處理，未平行派送。');
      if (++turns > MAX_TURNS) return fail('VOICE_TURN_LIMIT', `本次語音已達 ${MAX_TURNS} 回合上限。`);
      committedItems.add(event.item_id);
      pendingInputItem = event.item_id;
      if (cancelBeforeCreate && activeResponse) {
        cancelledResponses.add(activeResponse);
        sendConnection(() => connection.cancelResponse({ responseId: activeResponse }),
          'VOICE_AGENT_CANCEL', '等待舊語音停止逾時。');
        return;
      }
      dispatchResponse();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (typeof event.item_id !== 'string' || !/^[\w-]{1,256}$/.test(event.item_id) ||
          typeof event.transcript !== 'string' ||
          !event.transcript.trim() || event.transcript.length > 2000) return;
      if (!transcribedItems.has(event.item_id)) {
        if (transcribedItems.size >= MAX_TURNS) return fail('VOICE_AGENT_TRANSCRIPT_LIMIT', '語音辨識片段超過安全上限，未派送後端。');
        transcribedItems.add(event.item_id);
        transcriptions.set(event.item_id, event.transcript);
        send({ type: 'liveCaption', speaker: 'user', text: event.transcript });
        dispatchPendingToolCall();
      }
      return;
    }
    if (event.type === 'response.created') {
      const id = event.response?.id;
      if (typeof id !== 'string' || !id || id.length > 256) return fail('VOICE_AGENT_PROTOCOL', 'Foundry Voice Agent回應識別碼無效。');
      if (activeResponse && activeResponse !== id) return fail('VOICE_AGENT_PROTOCOL', 'Foundry Voice Agent同時回傳多個回應，已停止。');
      activeResponse = id;
      if (config.startupGreetingType === 'llm_generated' && !startupGreetingHandled &&
          !responseRequested && !activeInputItem && turns === 0) {
        startupGreetingHandled = true;
        cancelledResponses.add(id);
        sendConnection(() => connection.cancelResponse({ responseId: id }), 'VOICE_AGENT_CANCEL', '等待啟動問候停止逾時。');
        return;
      }
      if (cancelBeforeCreate) {
        cancelBeforeCreate = false; cancelledResponses.add(id);
        sendConnection(() => connection.cancelResponse({ responseId: id }), 'VOICE_AGENT_CANCEL', '等待舊語音停止逾時。');
      }
      return;
    }
    if (['response.output_audio.delta', 'response.audio.delta'].includes(event.type)) {
      if (!activeResponse || event.response_id !== activeResponse || responseKind !== 'speech' || muted || cancelBeforeCreate) return;
      const delta = event.delta;
      const pcm = delta instanceof Uint8Array
        ? Buffer.from(delta.buffer, delta.byteOffset, delta.byteLength)
        : typeof delta === 'string' && delta.length <= 64000 &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(delta)
          ? Buffer.from(delta, 'base64') : null;
      if (!pcm || pcm.length > 48000) return fail('VOICE_AGENT_AUDIO', 'Foundry Voice Agent輸出的PCM16音訊格式無效。');
      const bytes = pcm.length;
      if (!bytes || bytes % 2) return fail('VOICE_AGENT_AUDIO', 'Foundry Voice Agent輸出的PCM16音訊格式無效。');
      outputBytes += bytes;
      if (outputBytes > MAX_VOICE_OUTPUT_BYTES) return fail('VOICE_OUTPUT_LIMIT', '語音輸出已達上限，文字對話仍保留。');
      send({ type: 'audio', audio: pcm.toString('base64') }); return;
    }
    if (['response.output_audio_transcript.delta', 'response.audio_transcript.delta'].includes(event.type)) {
      if (responseKind === 'speech' && activeResponse === event.response_id && !muted &&
          typeof event.delta === 'string' && event.delta.length <= 2000) {
        send({ type: 'liveCaption', speaker: 'assistant', text: event.delta });
      }
      return;
    }
    if (event.type === 'response.done') {
      const response = event.response;
      const id = response?.id;
      if (typeof id !== 'string' || !id || completedResponses.has(id)) return;
      if (cancelledResponses.has(id)) {
        cancelledResponses.delete(id); clearTimeout(toolTimer);
        if (activeResponse === id) activeResponse = null;
        if (responseRequested && !activeResponse) { responseRequested = false; responseKind = null; }
        if (activeInputItem) activeInputItem = null;
        if (pendingInputItem) dispatchResponse();
        else if (spokenTurnId) {
          const interrupted = spokenTurnId; spokenTurnId = null;
          send({ type: 'audioDone', turnId: interrupted });
          send({ type: 'state', state: 'listening' });
        }
        else if (ready) send({ type: 'state', state: 'listening' });
        return;
      }
      if (activeResponse !== id) return fail('VOICE_AGENT_PROTOCOL', 'Foundry Voice Agent回應與目前回合不符，已停止。',
        { delegationFailure: 'response_mismatch' });
      clearTimeout(toolTimer);
      if (response.status === 'failed') return fail('VOICE_AGENT_RESPONSE', 'Foundry Voice Agent回應失敗，未執行不完整委派。',
        responseDetails(response));
      if (responseKind === 'delegate') {
        acceptToolResponse(response);
        return;
      }
      if (responseKind === 'speech') {
        if (response.status !== 'completed') return fail('VOICE_AGENT_RESPONSE', '語音回覆未完成；文字回覆仍保留。',
          responseDetails(response));
        completedResponses.add(id); activeResponse = null; responseRequested = false; responseKind = null;
        const completedTurn = spokenTurnId; spokenTurnId = null;
        if (completedTurn) send({ type: 'audioDone', turnId: completedTurn });
        return;
      }
      return fail('VOICE_AGENT_PROTOCOL', 'Foundry Voice Agent回應沒有對應工作，已停止。');
    }
  }
  async function readEvents() {
    try {
      for await (const event of connection) await handleEvent(event);
      if (!closed) fail('VOICE_AGENT_CLOSED', 'Foundry Voice Agent連線已結束，文字紀錄保留。');
    } catch {
      if (!closed) fail('VOICE_AGENT_CONNECTION', 'Foundry Voice Agent連線中斷，未切換其他語音服務。');
    }
  }
  session.voice = { stop };
  handshakeTimer = setTimeout(() => {
    if (audioMismatches?.length) {
      fail('VOICE_AGENT_AUDIO_UNAPPLIED', 'Foundry Voice Agent未套用單聲道音訊設定，未開始收音。',
        { mismatchedFields: audioMismatches });
    } else fail('VOICE_AGENT_TIMEOUT', 'Foundry Voice Agent設定確認逾時。');
  }, 20000);
  const eventLoop = readEvents();
  void connection.configureSession(requestedSessionConfig).catch(() =>
    fail('VOICE_AGENT_SESSION', 'Foundry Voice Agent拒絕本次語音設定，未開始收音。'));
  client.on('close', code => {
    if (!closed) console.info(JSON.stringify({ code: 'VOICE_AGENT_CLIENT_CLOSED',
      timestamp: new Date().toISOString(), mode: 'foundry-voice-agent',
      closeCode: Number.isInteger(code) ? code : null, inputDiagnostics: diagnosticSnapshot() }));
    stop();
  });
  client.on('error', stop);
  client.on('message', (raw, binary) => {
    if (closed) return;
    if (binary) {
      if (!ready || raw.length < 2 || raw.length > 48000 || raw.length % 2) {
        return fail('VOICE_AGENT_AUDIO', '音訊格式無效，已停止連線。');
      }
      if (Date.now() - windowAt >= 1000) { windowAt = Date.now(); windowBytes = 0; }
      inputBytes += raw.length; inputFrames++; windowBytes += raw.length;
      const limitReason = inputBytes > MAX_VOICE_INPUT_BYTES ? 'session_input' :
        windowBytes > 144000 ? 'input_rate' : queuedBytes + raw.length > 12288 ? 'pending_send' : null;
      if (limitReason) {
        return fail('VOICE_AUDIO_LIMIT', '語音輸入達到安全用量或流量上限，已停止。',
          { limitReason, inputBytes, windowBytes, windowMs: Date.now() - windowAt,
            queuedBytes, packetBytes: raw.length });
      }
      const receivedBytes = inputBytes;
      const append = !muted;
      queuedBytes += raw.length;
      flow.maxQueuedBytes = Math.max(flow.maxQueuedBytes, queuedBytes);
      inputChain = inputChain.then(async () => {
        if (closed) return;
        try {
          if (append) {
            flow.sdkStarted++; flow.sdkPending = true; flow.sdkStartedAt = Date.now();
            try { await connection.sendAudio(raw); }
            finally {
              flow.sdkPending = false;
              flow.maxSdkSendMs = Math.max(flow.maxSdkSendMs, Date.now() - flow.sdkStartedAt);
            }
            flow.sdkCompleted++; flow.sdkPending = false;
            appendedAudioBytes += raw.length;
            appendedAudioFrames++;
          }
          if (closed) return;
          flow.ackIssuedBytes = receivedBytes; flow.lastAckAt = Date.now();
          send({ type: 'inputAudioAck', receivedBytes }, error => {
            if (error) flow.ackSendErrors++;
            else { flow.ackSendCallbacks++; flow.ackCallbackBytes = receivedBytes; }
          });
        }
        finally { queuedBytes = Math.max(0, queuedBytes - raw.length); }
      }).catch(() => fail('VOICE_AGENT_CONNECTION', '音訊未能傳送至 Foundry Voice Agent，已停止。'));
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return fail('VOICE_AGENT_PROTOCOL', '語音控制訊息無效。'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return fail('VOICE_AGENT_PROTOCOL', '語音控制訊息必須為物件。');
    if (event.type === 'inputFlowDiagnostic') {
      const fields = ['sentBytes', 'acknowledgedBytes', 'ackEvents', 'lastAckAgeMs', 'pendingAgeMs', 'bufferedBytes'];
      if (clientFlowDiagnostic || Object.keys(event).length !== fields.length + 1 ||
          fields.some(key => !Number.isSafeInteger(event[key]) || event[key] < 0 || event[key] > 1_000_000_000) ||
          event.acknowledgedBytes > event.sentBytes) {
        return fail('VOICE_AGENT_PROTOCOL', '語音控制訊息無效。');
      }
      clientFlowDiagnostic = Object.fromEntries(fields.map(key => [key, event[key]]));
      console.info(JSON.stringify({ code: 'VOICE_INPUT_ACK_TIMEOUT', timestamp: new Date().toISOString(),
        mode: 'foundry-voice-agent', inputDiagnostics: diagnosticSnapshot() }));
      return;
    }
    if (event.type === 'stop' && Object.keys(event).length === 1) return stop();
    if (event.type === 'displayed' && Object.keys(event).length === 2 && pendingDisplay?.id === event.turnId) {
      delivered = pendingDisplay.context; pendingDisplay = null; return;
    }
    if (event.type === 'mute' && typeof event.muted === 'boolean' && Object.keys(event).length === 2) {
      muted = event.muted;
      if (muted) sendConnection(() => connection.clearInputAudio(), 'VOICE_AGENT_CONNECTION', '無法清除靜音前的音訊。');
      return;
    }
    fail('VOICE_AGENT_PROTOCOL', '不支援的語音控制訊息，已停止。');
  });
  return {
    stop,
    async flushDiagnostics() {
      stop();
      await Promise.all([inputChain, eventLoop, connectionClose]);
      return diagnosticSnapshot();
    },
    get diagnostics() { return diagnosticSnapshot(); }
  };
}
