import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { AppError } from './core.js';

export const speechInputSchema = z.object({
  stt: z.enum(['rest', 'sdk']).default('rest'),
  source: z.enum(['microphone', 'wav']).default('microphone'),
  sampleRate: z.union([z.literal(8000), z.literal(16000)]).default(16000),
  silenceMs: z.union([z.literal(700), z.literal(1000)]).default(700),
  phrases: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  chunkBytes: z.number().int().min(320).max(6400).refine(n => n % 2 === 0).default(1280)
}).strict().superRefine((value, context) => {
  if (value.stt === 'rest' && (value.source !== 'microphone' || value.phrases.length)) {
    context.addIssue({ code: 'custom', message: 'REST control uses the unchanged microphone/VAD path without a phrase list.' });
  }
});

// SDK callbacks enqueue final segments; orchestration belongs to the bridge worker, never the callbacks.
export function createSpeechRecognition(config, options, { credential, sdk = SpeechSDK, onEvent, onFinal, onFailure }) {
  let closed = false, ended = false, started = false, inputEnded = false, sequence = 0;
  let recognizer, push, audio, speech, refresh, eofTimer, startTimer, releaseStart;
  const controller = new AbortController(), began = performance.now();
  const resultIds = new Set();
  const emit = (kind, fields = {}) => {
    if (!closed) onEvent({ type: 'asr', kind, elapsedMs: Math.round(performance.now() - began), ...fields });
  };
  const failure = code => { if (!closed) onFailure(code, 'Speech SDK辨識失敗，請查看安全錯誤碼；未切換REST。'); };
  const token = async () => {
    const access = await credential.getToken('https://cognitiveservices.azure.com/.default', {
      abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    });
    if (!access?.token) throw new AppError('SPEECH_SDK_AUTH', '未取得Speech SDK權杖。', 502);
    return `aad#${config.resourceId}#${access.token}`;
  };
  const close = () => {
    if (closed) return;
    closed = true; controller.abort(); clearTimeout(refresh); clearTimeout(eofTimer); clearTimeout(startTimer); releaseStart?.();
    push?.close();
    if (recognizer) {
      recognizer.recognizing = recognizer.recognized = recognizer.canceled = recognizer.sessionStopped = undefined;
      recognizer.close();
    }
    audio?.close(); speech?.close();
  };
  const scheduleRefresh = () => {
    refresh = setTimeout(() => {
      void token().then(value => {
        if (closed || ended) return;
        recognizer.authorizationToken = value; scheduleRefresh();
      }).catch(() => failure('SPEECH_SDK_AUTH'));
    }, 8 * 60 * 1000);
    refresh.unref?.();
  };
  return {
    async start() {
      try {
        const endpoint = new URL('/stt/speech/recognition/conversation/cognitiveservices/v1', config.endpoint);
        endpoint.protocol = 'wss:';
        speech = sdk.SpeechConfig.fromEndpoint(endpoint, config.key ?? '');
        if (!config.key) {
          const value = await token();
          if (closed) { speech.close(); return; }
          speech.authorizationToken = value;
        }
        speech.speechRecognitionLanguage = 'zh-TW';
        speech.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(options.silenceMs));
        sdk.SpeechRecognizer.enableTelemetry(false);
        push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(options.sampleRate, 16, 1));
        audio = sdk.AudioConfig.fromStreamInput(push);
        recognizer = new sdk.SpeechRecognizer(speech, audio);
        const grammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
        for (const phrase of new Set(options.phrases)) grammar.addPhrase(phrase);
        recognizer.recognizing = (_sender, event) => {
          if (closed || ended) return;
          if (typeof event.result?.text !== 'string' || event.result.text.length > 2000) return failure('SPEECH_SDK_RESULT');
          emit('recognizing', { text: event.result.text, sequence: sequence + 1 });
        };
        recognizer.recognized = (_sender, event) => {
          if (closed || ended) return;
          const result = event.result;
          if (result?.reason === sdk.ResultReason.NoMatch) { emit('no_match'); return; }
          if (result?.reason !== sdk.ResultReason.RecognizedSpeech) return;
          if (typeof result.resultId === 'string' && resultIds.has(result.resultId)) return;
          if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000 || sequence >= 100) {
            return failure('SPEECH_SDK_RESULT');
          }
          const timing = { offsetMs: Number(result.offset) / 10000, durationMs: Number(result.duration) / 10000 };
          if (Object.values(timing).some(n => !Number.isFinite(n) || n < 0) || timing.durationMs > 120000) return failure('SPEECH_SDK_TIMING');
          const final = { text: result.text, sequence: ++sequence, ...timing };
          if (typeof result.resultId === 'string') resultIds.add(result.resultId);
          emit('recognized', final); onFinal(final);
        };
        recognizer.canceled = (_sender, event) => {
          if (closed || ended) return;
          ended = true; clearTimeout(refresh); clearTimeout(eofTimer);
          emit('canceled', { isError: event.reason === sdk.CancellationReason.Error });
          if (event.reason === sdk.CancellationReason.Error) failure('SPEECH_SDK_CANCELED');
          else if (!inputEnded) failure('SPEECH_SDK_STOPPED');
        };
        recognizer.sessionStopped = () => {
          if (closed) return;
          ended = true; clearTimeout(refresh); clearTimeout(eofTimer);
          emit('session_stopped');
          if (!inputEnded) failure('SPEECH_SDK_STOPPED');
        };
        await new Promise((resolve, reject) => {
          releaseStart = resolve;
          startTimer = setTimeout(() => reject(new Error('Speech SDK start timeout')), 20000);
          recognizer.startContinuousRecognitionAsync(() => {
            clearTimeout(startTimer); started = true; resolve();
          }, () => { clearTimeout(startTimer); reject(new Error('Speech SDK start failed')); });
        });
        if (closed) return;
        if (!config.key) scheduleRefresh();
        emit('session_started', { sampleRate: options.sampleRate, silenceMs: options.silenceMs });
      } catch { if (!closed) failure('SPEECH_SDK_START'); }
    },
    write(bytes) {
      if (!started || closed || ended || inputEnded) throw new AppError('SPEECH_SDK_STATE', 'SDK不再接收音訊，請停止後重新開始。', 409);
      // Buffer views may contain unrelated pooled bytes; copy exactly this packet.
      push.write(Uint8Array.from(bytes).buffer);
    },
    finishInput() {
      if (closed || ended || inputEnded) return;
      inputEnded = true; push.close(); emit('input_eof');
      eofTimer = setTimeout(() => failure('SPEECH_SDK_EOF_TIMEOUT'), 15000);
    },
    close
  };
}
