import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { AIProjectClient } from '@azure/ai-projects';
import { AzureCliCredential } from '@azure/identity';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server.js';
import { FOUNDRY_VOICE_AGENT_NAME } from '../lib/voice-agent.js';
import { pinMemberVoiceLocale, voiceModes } from '../lib/voice.js';
import { memberAgentPreferences } from '../lib/members.js';
import { voiceServiceErrorEvidence } from '../lib/voice-service-error.js';
import { generateFlights, addDays, network } from '../lib/dataset.js';
import { foundryConfig } from '../lib/foundry.js';
import { chat } from '../lib/agents.js';

const evidenceUrl = new URL('../staging/member-voice-live-evidence.json', import.meta.url);
const accounts = {
  email: 'ohsung.seoul@example.test',
  password: 'MeihaoDemo!2026',
  memberId: 'ohsung-seoul',
  persona: 'value'
};
const utterances = {
  'zh-TW': '請列出首爾到東京的航班選項。',
  'en-US': 'Show flight options from Seoul to Tokyo.'
};
const tripFor = (locale, date) => ({
  origin: 'ICN', destination: 'NRT', date, travelers: 1, cabin: 'economy',
  flexibleDays: 1, budget: null, lowWalking: false
});
const safeString = (value, maxLength = 320) => typeof value === 'string'
  ? value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '[ID]')
    .replaceAll(accounts.password, '[REDACTED]')
    .slice(0, maxLength)
  : undefined;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const inputDiagnosticTypes = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'input_audio_buffer.timeout_triggered',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'error'
]);
const safeDiagnosticToken = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value)
  ? value : undefined;
const audioFormatEvidence = format => format ? {
  type: ['audio/pcm', 'audio/pcma', 'audio/pcmu'].includes(format.type) ? format.type : 'other',
  ...(Number.isFinite(format.rate) ? { rate: format.rate } : {})
} : null;
const echoEvidence = echo => echo ? {
  type: safeDiagnosticToken(echo.type),
  reference_source: ['server', 'client'].includes(echo.reference_source) ? echo.reference_source : 'other',
  ...(Number.isFinite(echo.channels) ? { channels: echo.channels } : {})
} : null;
function createInputDiagnostics() {
  return {
    captured: true,
    format: 'pcm16-mono',
    sampleRateHz: 24000,
    frameBytes: 4800,
    targetPaceMs: 100,
    clientFramesSent: 0,
    clientBytesSent: 0,
    sdkAppendCalls: 0,
    sdkAppendBytes: 0,
    explicitCommitCalls: 0,
    eventCounts: Object.fromEntries([...inputDiagnosticTypes].map(type => [type, 0])),
    events: []
  };
}
const audioContract = {
  sdkVersion: '2.9.0',
  pcm: { format: 'pcm16-mono', sampleRateHz: 24000 },
  sdk: {
    sendAudioEvent: 'input_audio_buffer.append',
    audioEncoding: 'base64',
    appendAcknowledgement: false,
    commitAudioEvent: 'input_audio_buffer.commit',
    commitCreatesResponse: false
  },
  smokePacing: { chunkBytes: 4800, intervalMs: 100 },
  vad: {
    configuredType: 'azure_semantic_vad_multilingual',
    noClientAutoCommit: true,
    documentedServerVadAutoCommit: true,
    exactSemanticVadEventTimingConfirmed: false,
    responseRequiresSeparateRequest: true
  },
  privacy: {
    diagnosticsIncludeRawAudio: false,
    diagnosticsIncludeTranscript: false,
    diagnosticsIncludeServiceErrorMessage: false,
    eventTimelineLimit: 64
  },
  officialApiReference: 'https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-api-reference-2026-06-01-preview'
};

export async function synthesizeInput(env, credential, locale, utterance = utterances[locale]) {
  const endpoint = new URL(env.DIRECT_SPEECH_ENDPOINT);
  const headers = {
    'Content-Type': 'application/ssml+xml',
    'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm',
    'User-Agent': 'travelagent-member-voice-smoke'
  };
  if (env.DIRECT_SPEECH_KEY) headers['Ocp-Apim-Subscription-Key'] = env.DIRECT_SPEECH_KEY;
  else {
    const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
    if (!token?.token) throw new Error('SPEECH_SYNTHESIS_AUTH');
    headers.Authorization = `Bearer ${token.token}`;
  }
  const voice = locale === 'en-US' ? 'en-US-AvaNeural' : 'zh-TW-HsiaoChenNeural';
  const text = utterance.replace(/[<>&"']/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[char]);
  const response = await fetch(new URL('/tts/cognitiveservices/v1', endpoint), {
    method: 'POST',
    headers,
    body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${text}</voice></speak>`,
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`SPEECH_SYNTHESIS_HTTP_${response.status}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length || audio.length > 5_000_000 || audio.length % 2) {
    throw new Error('SPEECH_SYNTHESIS_PCM_INVALID');
  }
  return { audio, voice };
}

export function trackedConnection(connection, record) {
  const iterator = connection[Symbol.asyncIterator]();
  const diagnostics = record.inputDiagnostics ??= createInputDiagnostics();
  const diagnosticStartedAt = performance.now();
  const operations = new Map();
  const pendingResponses = [];
  let operationSequence = 0;
  record.clientOperations ??= [];
  record.protocolEvents ??= [];
  const elapsedMs = () => Math.max(0, Math.round(performance.now() - diagnosticStartedAt));
  const boundedPush = (items, value) => { items.push(value); if (items.length > 64) items.shift(); };
  const errorEvidence = event => {
    const operation = operations.get(event.error?.event_id);
    return {
      ...voiceServiceErrorEvidence(event.error),
      clientEventReferencePresent: typeof event.error?.event_id === 'string',
      attributedOperation: operation?.operation ?? 'unattributed',
      operationSequence: operation?.sequence ?? null,
      attributionEstablished: Boolean(operation),
      startupResponseObserved: record.responsesCreated.some(response => !response.requestedByApplication)
    };
  };
  const trackInputEvent = event => {
    if (!inputDiagnosticTypes.has(event?.type)) return;
    diagnostics.eventCounts[event.type]++;
    const item = {
      type: event.type,
      elapsedMs: Math.max(0, Math.round(performance.now() - diagnosticStartedAt)),
      clientFramesSent: diagnostics.clientFramesSent,
      clientBytesSent: diagnostics.clientBytesSent,
      sdkAppendCalls: diagnostics.sdkAppendCalls,
      sdkAppendBytes: diagnostics.sdkAppendBytes,
      explicitCommitCalls: diagnostics.explicitCommitCalls,
      state: {
        appRequestedResponses: record.requestedResponses.length,
        responsesCreated: record.responsesCreated.length,
        travelBackendCalls: record.responsesDone.reduce((count, response) => count +
          response.functionCalls.filter(call => call.name === 'travel_backend').length, 0),
        toolOutputs: record.toolOutputs.length,
        outputAudioBytes: record.outputAudio?.bytes ?? 0
      },
      ...(event.type === 'error' ? {
        error: errorEvidence(event)
      } : {})
    };
    diagnostics.events.push(item);
    if (diagnostics.events.length > 64) diagnostics.events.shift();
  };
  return new Proxy(connection, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return () => ({
          async next() {
            const result = await iterator.next();
            if (!result.done) {
              const event = result.value;
              trackInputEvent(event);
              if (['session.updated', 'response.created', 'response.done', 'error'].includes(event?.type)) {
                boundedPush(record.protocolEvents, { type: event.type, elapsedMs: elapsedMs(),
                  ...(event.type === 'error' ? { error: errorEvidence(event) } : {}) });
              }
              if (event?.type === 'session.updated') {
                const session = event.session;
                record.sessionAcks.push({
                  turnDetection: session?.audio?.input?.turn_detection?.type,
                  createResponse: session?.audio?.input?.turn_detection?.create_response,
                  interruptResponse: session?.audio?.input?.turn_detection?.interrupt_response,
                  toolChoice: session?.tool_choice?.name ?? session?.tool_choice,
                  transcriptionModel: session?.audio?.input?.transcription?.model,
                  transcriptionLanguage: session?.audio?.input?.transcription?.language,
                  outputVoice: session?.audio?.output?.voice,
                  outputVoiceLocale: session?.audio?.output?.voice_locale,
                  outputVoiceType: safeDiagnosticToken(session?.audio?.output?.voice_type),
                  inputFormat: audioFormatEvidence(session?.audio?.input?.format),
                  echoCancellation: echoEvidence(session?.audio?.input?.echo_cancellation),
                  outputFormat: audioFormatEvidence(session?.audio?.output?.format),
                  instructionsSha256: typeof session?.instructions === 'string' ? sha256(session.instructions) : null
                });
              } else if (event?.type === 'response.created') {
                const requested = pendingResponses.shift();
                record.responsesCreated.push({
                  id: safeString(event.response?.id),
                  requestedByApplication: Boolean(requested),
                  requestOperationSequence: requested?.sequence ?? null,
                  attribution: requested ? 'ordered-app-request' : 'unrequested-response'
                });
              } else if (event?.type === 'response.done') {
                const calls = Array.isArray(event.response?.output)
                  ? event.response.output.filter(item => item?.type === 'function_call')
                  : [];
                record.responsesDone.push({
                  id: safeString(event.response?.id),
                  status: safeString(event.response?.status),
                  functionCalls: calls.map(call => ({
                    name: safeString(call.name),
                    callId: safeString(call.call_id),
                    argumentsPresent: typeof call.arguments === 'string'
                  }))
                });
              } else if (event?.type === 'error') {
                record.serviceErrors.push(errorEvidence(event));
              }
            }
            return result;
          }
        });
      }
      if (['configureSession', 'requestResponse', 'cancelResponse', 'clearInputAudio'].includes(property)) {
        return async (...args) => {
          const optionIndex = property === 'configureSession' ? 1 : 0;
          const options = args[optionIndex] ?? {};
          const eventId = options.eventId ?? randomUUID();
          const operation = { sequence: ++operationSequence, operation: property,
            elapsedMs: elapsedMs(), completed: false };
          operations.set(eventId, operation);
          if (operations.size > 64) operations.delete(operations.keys().next().value);
          boundedPush(record.clientOperations, operation);
          args[optionIndex] = { ...options, eventId };
          if (property === 'requestResponse') {
            pendingResponses.push(operation);
            record.requestedResponses.push({
              toolChoice: options?.response?.tool_choice?.name ?? options?.response?.tool_choice ?? null
            });
          }
          try { const result = await target[property](...args); operation.completed = true; return result; }
          catch (error) { operation.failed = true; throw error; }
        };
      }
      if (property === 'sendAudio') {
        return async (audio, options) => {
          await target.sendAudio(audio, options);
          diagnostics.sdkAppendCalls++;
          diagnostics.sdkAppendBytes += audio?.byteLength ?? audio?.length ?? 0;
        };
      }
      if (property === 'commitAudio') {
        return async options => {
          diagnostics.explicitCommitCalls++;
          return target.commitAudio(options);
        };
      }
      if (property === 'sendToolOutput') {
        return async (callId, output, options) => {
          let parsed;
          try { parsed = JSON.parse(output); } catch { parsed = null; }
          record.toolOutputs.push({
            callId: safeString(callId),
            createResponse: options?.createResponse,
            text: safeString(parsed?.text, 8000),
            detail: safeString(parsed?.detail),
            error: safeString(parsed?.error)
          });
          return target.sendToolOutput(callId, output, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function bindLiveAudioDiagnostics(record, voiceTrace) {
  assert.ok(voiceTrace?.inputDiagnostics && voiceTrace.bridge, 'SERVER_CONNECTION_TRACE_MISSING');
  record.connectionId = voiceTrace.connectionId;
  record.inputDiagnostics = voiceTrace.inputDiagnostics;
  voiceTrace.outputAudio = record.outputAudio;
}

async function postJson(origin, cookie, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.error ?? 'HTTP'}_${response.status}`);
  return { response, payload };
}

export async function runLocale(origin, cookie, locale, date, env, credential, agentCalls, options = {}) {
  const record = {
    locale,
    expectedVersion: pinMemberVoiceLocale(voiceModes(env)['foundry-voice-agent'], locale).version,
    utteranceSynthesized: options.utterance ?? utterances[locale],
    inputDiagnostics: createInputDiagnostics(),
    inputAudio: null,
    sessionAcks: [],
    requestedResponses: [],
    responsesCreated: [],
    responsesDone: [],
    serviceErrors: [],
    toolOutputs: [],
    backend: null,
    outputAudio: { sampleRate: 24000, bytes: 0, sha256: null, audioDone: false },
    status: 'in_progress'
  };
  let socket, voiceTrace, sendTask, outputHasher = createHash('sha256');
  try {
    const synthesized = await (options.synthesizeInput ?? synthesizeInput)(env, credential, locale, record.utteranceSynthesized);
    record.inputAudio = { voice: synthesized.voice, sampleRate: 24000,
      bytes: synthesized.audio.length, sha256: sha256(synthesized.audio) };

    await postJson(origin, cookie, '/api/language', { locale });
    if (!options.skipTripSetup) {
      const { payload: plan } = await postJson(origin, cookie, '/api/chat', {
      message: locale === 'en-US' ? 'Prepare a sample trip.' : '先準備示範行程。',
      action: 'plan',
      trip: tripFor(locale, date),
      locale,
      requestId: randomUUID()
    });
      if (!plan.state?.trip) throw new Error('BACKEND_TRIP_SETUP_MISSING');
    }

    const { payload: ticket } = await postJson(origin, cookie, '/api/voice/session', {
      mode: 'foundry-voice-agent', locale
    });
    record.connectionId = sha256(ticket.nonce);
    const serverSocketUrl = `${origin.replace('http:', 'ws:')}${ticket.path}`;
    socket = new WebSocket(serverSocketUrl, [ticket.protocol, ticket.nonce], {
      headers: { origin, cookie }, handshakeTimeout: 15000, maxPayload: 2_000_000
    });
    let inputSent = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('VOICE_TURN_TIMEOUT')), options.timeoutMs ?? 90000);
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      socket.on('error', () => finish(new Error('LOCAL_VOICE_SOCKET_ERROR')));
      socket.on('close', (code) => {
        if (!done) finish(new Error(`LOCAL_VOICE_SOCKET_CLOSED_${code}`));
      });
      socket.on('message', async raw => {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === 'error') {
            record.clientError = { code: safeString(event.code), message: safeString(event.message),
              correlationId: safeString(event.correlationId) };
            return finish(new Error(event.code ?? 'VOICE_CLIENT_ERROR'));
          }
          if (event.type === 'ready' && !inputSent) {
            inputSent = true;
            voiceTrace = agentCalls.find(call => call.connectionId === record.connectionId);
            bindLiveAudioDiagnostics(record, voiceTrace);
            assert.equal(voiceTrace.version, record.expectedVersion, 'PINNED_LOCALE_VERSION_MISMATCH');
            record.inputDiagnostics.targetPaceMs = options.paceMs ?? 100;
            const input = Buffer.concat([Buffer.alloc(12000), synthesized.audio, Buffer.alloc(96000)]);
            record.inputAudio.plannedSendBytes = input.length;
            sendTask = (async () => {
              for (let offset = 0; offset < input.length; offset += 4800) {
                if (done) return;
                if (socket.readyState !== WebSocket.OPEN) throw new Error('VOICE_SOCKET_NOT_OPEN_DURING_INPUT');
                const frame = input.subarray(offset, offset + 4800);
                socket.send(frame);
                record.inputDiagnostics.clientFramesSent++;
                record.inputDiagnostics.clientBytesSent += frame.length;
                await pause(options.paceMs ?? 100);
              }
            })();
            void sendTask.catch(() => finish(new Error('VOICE_INPUT_SEND_FAILED')));
          } else if (event.type === 'transcript') {
            record.backendTranscriptDisplayed = typeof event.text === 'string' && event.text.length > 0;
          } else if (event.type === 'result') {
            record.backend = {
              memberId: accounts.memberId,
              locale: event.result?.state?.locale ?? locale,
              activeAgent: safeString(event.result?.state?.activeAgent),
              text: safeString(event.result?.text, 12000),
              speechText: safeString(event.result?.speech?.text, 12000),
              rankingTextPresent: typeof event.result?.text === 'string' &&
                /個人化排序|Personalized order/i.test(event.result.text),
              offers: (event.result?.state?.offers ?? []).slice(0, 6).map(offer => ({
                id: safeString(offer.id), total: offer.total, currency: safeString(offer.currency),
                flightNumber: safeString(offer.flight?.flightNumber),
                departureLocal: safeString(offer.flight?.departureLocal)
              })),
              modelCalls: (event.result?.diagnostics?.modelCalls ?? []).map(call => ({
                role: call.role, version: call.agent?.version, usage: call.usage,
                fileSearchCalls: call.fileSearchCalls, functionCalls: call.functionCalls
              }))
            };
            socket.send(JSON.stringify({ type: 'displayed', turnId: event.turnId }));
          } else if (event.type === 'audio') {
            const bytes = Buffer.from(event.audio, 'base64');
            record.outputAudio.bytes += bytes.length;
            outputHasher.update(bytes);
          } else if (event.type === 'audioDone') {
            record.outputAudio.audioDone = true;
            record.outputAudio.sha256 = outputHasher.copy().digest('hex');
            if (record.backend && record.outputAudio.bytes > 2000) finish(null, true);
          }
        } catch {
          finish(new Error('VOICE_EVENT_PROCESSING_ERROR'));
        }
      });
      socket.on('open', () => {});
    });
    if (!record.backendTranscriptDisplayed) throw new Error('FINAL_TRANSCRIPT_MISSING');
    const preference = memberAgentPreferences(accounts.memberId, locale);
    const backendTrace = voiceTrace;
    record.memberContext = {
      authenticatedMemberId: accounts.memberId,
      persona: preference.persona,
      preferredCabin: preference.preferredCabin,
      softPreferences: preference.softPreferences,
      corporateAdvisoryOnly: preference.corporateAdvisoryOnly ?? false,
      suppliedToBackend: Boolean(backendTrace?.context)
    };
    record.sessionAcks = backendTrace?.sessionAcks ?? [];
    record.requestedResponses = backendTrace?.requestedResponses ?? [];
    record.responsesCreated = backendTrace?.responsesCreated ?? [];
    record.responsesDone = backendTrace?.responsesDone ?? [];
    record.serviceErrors = backendTrace?.serviceErrors ?? [];
    record.backendRequest = backendTrace?.backendRequest ?? null;
    record.toolOutputs = backendTrace?.toolOutputs ?? record.toolOutputs;
    record.status = 'passed';
    assert.ok(record.sessionAcks.some(ack => ack.transcriptionLanguage === locale));
    assert.ok(record.backendRequest, 'the authenticated member context must reach the travel backend');
    assert.ok(record.responsesDone.some(response => response.functionCalls.some(call =>
      call.name === 'travel_backend' && call.argumentsPresent)));
    assert.ok(backendTrace.bridge.diagnostics.delegations.some(event =>
      event.type === 'transcript_comparison' && event.accepted &&
      event.source === 'same-item-final-asr' &&
      event.association.committedInputKnown && event.association.transcriptForCommittedInputPresent &&
      event.association.appRequestedDelegation && event.association.responseMatchesActive),
    'backend delivery must follow the bridge comparison for the committed input, not a prefixed UI summary');
    assert.equal(record.backend?.activeAgent, 'flight');
    assert.equal(record.memberContext.suppliedToBackend, true);
    assert.equal(record.outputAudio.audioDone, true);
    assert.ok(record.outputAudio.bytes > 2000);
    if (options.requireRealBackend) {
      assert.ok(record.backend.modelCalls.some(call => call.role === 'intent'), 'REAL_INTENT_CALL_MISSING');
      assert.ok(record.backend.modelCalls.some(call => call.role === 'flight'), 'REAL_FLIGHT_CALL_MISSING');
      assert.ok(record.backend.offers.length > 0, 'REAL_BACKEND_OFFERS_MISSING');
      assert.equal(record.backend.rankingTextPresent, true, 'MEMBER_RANKING_MISSING');
      assert.ok(backendTrace.modelInputs?.some(input => input.memberPreferencesPresent), 'MODEL_MEMBER_CONTEXT_MISSING');
    }
    return record;
  } catch (error) {
    record.status = 'blocked';
    record.error = safeString(error?.message ?? error);
    if (record.outputAudio.bytes && !record.outputAudio.sha256) record.outputAudio.sha256 = outputHasher.digest('hex');
    return record;
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const closed = once(socket, 'close');
          socket.close(1000);
          await closed;
        }
      })(),
      sendTask
    ]);
    try {
      voiceTrace ??= record.connectionId && agentCalls.find(call => call.connectionId === record.connectionId);
      if (!voiceTrace?.bridge) throw new Error('SERVER_CONNECTION_TRACE_MISSING');
      record.bridgeDiagnostics = await voiceTrace.bridge.flushDiagnostics();
      bindLiveAudioDiagnostics(record, voiceTrace);
      record.diagnosticsFlushed = true;
    } catch (error) {
      record.status = 'blocked';
      record.diagnosticsFlushed = false;
      record.diagnosticCaptureError = safeString(error?.message ?? error);
      if (!voiceTrace?.inputDiagnostics) {
        record.inputDiagnostics = {
          ...record.inputDiagnostics, captured: false,
          sdkAppendCalls: null, sdkAppendBytes: null, explicitCommitCalls: null,
          eventCounts: null, events: null
        };
      }
    }
    if (cleanup.some(result => result.status === 'rejected')) {
      record.status = 'blocked';
      record.cleanupError = cleanup[0].status === 'rejected' ? 'VOICE_SOCKET_CLOSE_FAILED' : 'VOICE_INPUT_SEND_FAILED';
    }
  }
}

export function createVoiceSmokeHarness(env, { credential, connect, onBackendRequest }) {
  const agentCalls = [];
  const traces = new WeakMap();
  const app = createApp(env, { voice: {
    credential,
    voiceAgentConnect: async (selected, activeCredential) => {
      const record = {
        locale: selected.locale,
        version: selected.version,
        context: null,
        sessionAcks: [],
        requestedResponses: [],
        responsesCreated: [],
        responsesDone: [],
        serviceErrors: [],
        toolOutputs: [],
        inputDiagnostics: createInputDiagnostics()
      };
      agentCalls.push(record);
      const connection = trackedConnection(await connect(selected, activeCredential), record);
      traces.set(connection, record);
      return connection;
    },
    onVoiceAgentBridge: (bridge, connection, { nonce }) => {
      const record = traces.get(connection);
      assert.ok(record, 'SERVER_CONNECTION_TRACE_MISSING');
      record.connectionId = sha256(nonce);
      record.bridge = bridge;
    },
    chat: async (session, request, requestEnv, dependencies) => {
      if (dependencies?.memberAware && session.memberId) {
        onBackendRequest?.(request);
        const preference = memberAgentPreferences(session.memberId, request.locale);
        const trace = agentCalls.find(call => call.bridge?.stop === session.voice?.stop);
        assert.ok(trace, 'BACKEND_CONNECTION_TRACE_MISSING');
        trace.context = {
          authenticatedMemberId: session.memberId,
          persona: preference?.persona,
          preferredCabin: preference?.preferredCabin,
          softPreferences: preference?.softPreferences,
          corporateAdvisoryOnly: preference?.corporateAdvisoryOnly ?? false
        };
        trace.backendRequest = {
          locale: request.locale,
          messageLength: request.message.length
        };
      }
      const trace = agentCalls.find(call => call.bridge?.stop === session.voice?.stop);
      const config = requestEnv.APP_MODE === 'foundry' ? foundryConfig(requestEnv) : null;
      const result = await chat(session, request, requestEnv, config && trace ? {
        ...dependencies,
        fetch: async (url, options) => {
          const body = JSON.parse(options.body);
          const role = Object.keys(config.agents).find(role => config.agents[role].name === body.agent_reference?.name);
          const user = body.input?.find(item => item.role === 'user');
          const payload = user ? JSON.parse(user.content) : null;
          trace.modelInputs ??= [];
          trace.modelInputs.push({
            role: role ?? 'unknown',
            memberPreferencesPresent: Boolean(payload?.context?.memberPreferences),
            persona: payload?.context?.memberPreferences?.persona ?? null,
            responseLocaleMatchesTicket: payload ? payload.responseLocale === request.locale : null
          });
          return fetch(url, options);
        }
      } : dependencies);
      return result;
    }
  } });
  return { app, agentCalls };
}

export async function persistVoiceEvidence(results, agentCalls, {
  outputUrl = evidenceUrl, mode = 'mock travel backend + managed Foundry Voice Agent'
} = {}) {
  const evidence = {
    schemaVersion: 2,
    checkedAt: new Date().toISOString(),
    mode,
    connectionTopology: {
      current: 'one server-owned SDK connection per local WebSocket; no runner-side SDK connection',
      previous: 'one unused runner-side SDK connection plus one server-owned SDK connection per locale',
      previousTimeoutCauseEstablished: false,
      serverConnectionsCreated: agentCalls.length
    },
    audioContract,
    syntheticAudio: true,
    humanMicrophoneTested: false,
    localPort3100Started: false,
    activated: false,
    agent: FOUNDRY_VOICE_AGENT_NAME,
    sourceVersion: '5',
    member: { id: accounts.memberId, persona: accounts.persona },
    results: results.map(record => {
      const trace = record.connectionId && agentCalls.find(call => call.connectionId === record.connectionId);
      return {
        ...record,
        backendHarnessEvidence: trace?.backendRequest ?? null,
        memberContextSupplied: trace?.context ?? null,
        sessionAcks: trace?.sessionAcks ?? [],
        requestedResponses: trace?.requestedResponses ?? [],
        responsesCreated: trace?.responsesCreated ?? [],
        responsesDone: trace?.responsesDone ?? [],
        serviceErrors: trace?.serviceErrors ?? [],
        clientOperations: trace?.clientOperations ?? [],
        protocolEvents: trace?.protocolEvents ?? [],
        toolOutputs: trace?.toolOutputs ?? [],
        modelInputs: trace?.modelInputs ?? []
      };
    })
  };
  await mkdir(new URL('.', outputUrl), { recursive: true });
  await writeFile(outputUrl, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

async function main() {
  if (!process.argv.includes('--apply')) {
    throw new Error('Requires --apply: bounded bilingual managed Voice Agent synthetic-audio validation.');
  }
  const localeOnly = process.argv.includes('--zh-only');
  const realBackend = process.argv.includes('--real-backend');
  const env = {
    ...process.env,
    APP_MODE: realBackend ? 'foundry' : 'mock',
    FOUNDRY_AUTH_MODE: process.env.FOUNDRY_AUTH_MODE || 'azure-cli',
    FOUNDRY_VOICE_AGENT_NAME: FOUNDRY_VOICE_AGENT_NAME,
    FOUNDRY_VOICE_AGENT_VERSION: '5'
  };
  if (!env.FOUNDRY_PROJECT_ENDPOINT || !env.DIRECT_SPEECH_ENDPOINT || !env.DIRECT_SPEECH_RESOURCE_ID) {
    throw new Error('FOUNDRY_OR_SPEECH_TEST_CONFIGURATION_MISSING');
  }
  const credential = new AzureCliCredential({ processTimeoutInMs: 10000 });
  let realOptions;
  if (realBackend) {
    foundryConfig(env);
    const date = addDays(new Date().toISOString().slice(0, 10), 14);
    const supported = generateFlights(date).filter(flight => flight.origin === 'TPE' && flight.destination === 'NRT' &&
      flight.cabins.some(cabin => cabin.cabin === 'economy' && cabin.available >= 1));
    assert.ok(supported.length, 'REAL_TEST_CATALOG_ROUTE_DATE_UNAVAILABLE');
    realOptions = { date, coverageStart: network.metadata.startDate,
      coverageEndExclusive: addDays(network.metadata.startDate, network.metadata.days), supportedFlights: supported.length };
  }
  const { app, agentCalls } = createVoiceSmokeHarness(env, {
    credential,
    connect: async (selected, activeCredential) => {
      const project = new AIProjectClient(selected.endpoint, activeCredential);
      return project.beta.voiceAgents.realtime.connect(selected.agentName, {
        store: false, agentVersionOverride: selected.version
      });
    }
  });
  app.requestTimeout = 90000;
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = `http://127.0.0.1:${app.address().port}`;
  const results = [];
  try {
    const bootstrap = await fetch(`${origin}/api/bootstrap`, { signal: AbortSignal.timeout(15000) });
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    if (!bootstrap.ok || !cookie) throw new Error('LOCAL_TEST_SESSION_SETUP_FAILED');
    const login = await postJson(origin, cookie, '/api/member/login', {
      email: accounts.email, password: accounts.password
    });
    if (login.payload.member?.id !== accounts.memberId) throw new Error('MEMBER_LOGIN_CONTEXT_MISMATCH');
    let activeCookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const optionsFor = locale => realBackend ? {
      skipTripSetup: true, requireRealBackend: true,
      utterance: locale === 'zh-TW'
        ? `請搜尋${realOptions.date.slice(0, 4)}年${realOptions.date.slice(5, 7)}月${realOptions.date.slice(8)}日從臺灣桃園機場TPE到東京成田機場NRT的單程航班，一位成人，經濟艙，固定日期。`
        : `Search one-way flights from Taiwan Taoyuan airport TPE to Tokyo Narita airport NRT on ${realOptions.date}, one adult, economy, fixed date.`
    } : {};
    results.push(await runLocale(origin, activeCookie, 'zh-TW', realOptions?.date ?? '2026-11-12', env, credential, agentCalls, optionsFor('zh-TW')));
    if (!localeOnly && results.at(-1).status === 'passed') {
      results.push(await runLocale(origin, activeCookie, 'en-US', realOptions?.date ?? '2026-11-13', env, credential, agentCalls, optionsFor('en-US')));
    }
    const evidence = await persistVoiceEvidence(results, agentCalls, realBackend ? {
      mode: 'real Foundry business agents with synthetic catalog + managed Foundry Voice Agent',
      outputUrl: new URL('../staging/member-voice-real-backend-evidence.json', import.meta.url)
    } : {});
    console.log(JSON.stringify({
      evidence: realBackend ? 'staging/member-voice-real-backend-evidence.json' : 'staging/member-voice-live-evidence.json',
      locales: evidence.results.map(({ locale, expectedVersion, status, error, transcript, backend, outputAudio, serviceErrors }) => ({
        locale, expectedVersion, status, error, transcript, backendAgent: backend?.activeAgent,
        offerCount: backend?.offers?.length ?? 0, outputAudioBytes: outputAudio?.bytes ?? 0,
        audioDone: outputAudio?.audioDone ?? false, serviceErrors
      }))
    }, null, 2));
    if (results.length !== (localeOnly ? 1 : 2) || results.some(record => record.status !== 'passed')) process.exitCode = 1;
  } finally {
    app.closeAllConnections();
    await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
