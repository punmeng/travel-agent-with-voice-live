import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { voiceConfig, voiceSessionUpdate } from '../lib/voice.js';
import { gptLiveConfig, gptLiveStart } from '../lib/gpt-live.js';
import {
  buildGptLiveInstructions,
  chunkBytesForDuration,
  chunkDurationForBytes,
  createDefaultVoiceOptions,
  createVoiceOptionsState,
  freezeVoiceOptions,
  validateVoiceOptions
} from '../lib/voice-options.js';

test('voice option defaults are independent by mode and preserve legacy ticket omission', () => {
  assert.equal(validateVoiceOptions(undefined), undefined);
  const defaults = createDefaultVoiceOptions();
  assert.equal(defaults['voice-live'].vadSilenceMs, 800);
  assert.equal(defaults['voice-realtime'].vadSilenceMs, 800);
  assert.equal(defaults['speech-direct'].rest.vadSilenceMs, 1000);
  assert.equal(defaults['speech-direct'].sdk.segmentationMs, 700);
  assert.equal(defaults['speech-direct'].sdk.chunkMs, 40);
  assert.equal(defaults['gpt-live'].voice, 'marin');

  const state = createVoiceOptionsState({ 'voice-live': { vadSilenceMs: 1200 } });
  assert.equal(state['voice-live'].vadSilenceMs, 1200);
  assert.equal(state['voice-realtime'].vadSilenceMs, 800);
  state['voice-live'].phraseList.push('flight');
  assert.equal(Object.hasOwn(state['voice-realtime'], 'phraseList'), false);
});

test('Voice Live and native Realtime options accept only supported controls', () => {
  assert.deepEqual(validateVoiceOptions({
    'voice-live': { vadSilenceMs: 500, noiseReduction: false, echoCancellation: true, phraseList: 'A\nB' },
    'voice-realtime': { vadSilenceMs: 1200, noiseReduction: true, echoCancellation: false }
  }), {
    'voice-live': { vadSilenceMs: 500, noiseReduction: false, echoCancellation: true, phraseList: ['A', 'B'] },
    'voice-realtime': { vadSilenceMs: 1200, noiseReduction: true, echoCancellation: false }
  });
  assert.throws(() => validateVoiceOptions({ 'voice-realtime': { phraseList: ['not supported'] } }), /unsupported/);
  assert.throws(() => validateVoiceOptions({ 'voice-live': { vadSilenceMs: 600 } }), /not supported/);
  assert.throws(() => validateVoiceOptions({ 'voice-live': { noiseReduction: 'on' } }), /boolean/);
});

test('phrase lists are trimmed, deduplicated, and bounded to 100 entries and characters', () => {
  assert.deepEqual(validateVoiceOptions({
    'voice-live': { phraseList: [' flight ', 'flight', '', 'airport'] }
  })['voice-live'].phraseList, ['flight', 'airport']);

  assert.throws(() => validateVoiceOptions({
    'voice-live': { phraseList: Array.from({ length: 101 }, (_, index) => `term-${index}`) }
  }), /at most 100/);
  assert.throws(() => validateVoiceOptions({
    'speech-direct': { sdk: { phraseList: ['x'.repeat(101)] } }
  }), /at most 100 characters/);
});

test('GPT-Live accepts only finite language, wording, style, and verified voice settings', () => {
  const instructions = buildGptLiveInstructions({
    language: 'zh-TW',
    taiwanWording: true,
    style: 'concise',
    voice: 'marin'
  });
  assert.match(instructions, /Traditional Chinese as used in Taiwan/);
  assert.match(instructions, /Taiwan-local terminology/);
  assert.match(instructions, /concise and direct/);
  assert.throws(() => validateVoiceOptions({ 'gpt-live': { style: 'custom prompt' } }), /must be one of/);
  assert.throws(() => validateVoiceOptions({ 'gpt-live': { voice: 'alloy' } }), /must be one of marin/);
  assert.throws(() => validateVoiceOptions({ 'gpt-live': { instructions: 'arbitrary prompt' } }), /unsupported/);
});

test('REST VAD and Speech SDK controls have distinct finite ranges', () => {
  assert.deepEqual(validateVoiceOptions({
    'speech-direct': {
      rest: { vadSilenceMs: 1500 },
      sdk: { segmentationMs: 700, phraseList: ['name'], chunkMs: 100 }
    }
  }), {
    'speech-direct': {
      rest: { vadSilenceMs: 1500 },
      sdk: { segmentationMs: 700, phraseList: ['name'], chunkMs: 100 }
    }
  });
  assert.throws(() => validateVoiceOptions({ 'speech-direct': { rest: { vadSilenceMs: 800 } } }), /not supported/);
  assert.throws(() => validateVoiceOptions({ 'speech-direct': { sdk: { segmentationMs: 800 } } }), /not supported/);
  assert.throws(() => validateVoiceOptions({ 'speech-direct': { sdk: { chunkMs: 60 } } }), /must be one of/);
});

test('SDK chunk durations map to PCM16 byte counts at supported WAV rates', () => {
  assert.equal(chunkBytesForDuration(40, 16000), 1280);
  assert.equal(chunkBytesForDuration(80, 8000), 1280);
  assert.equal(chunkDurationForBytes(1280, 16000), 40);
  assert.equal(chunkDurationForBytes(1280, 8000), 80);
  assert.throws(() => chunkBytesForDuration(40, 44100), /sample rate/);
});

test('ticket settings are validated and recursively frozen', () => {
  const frozen = freezeVoiceOptions({
    'voice-live': { phraseList: ['airport'] },
    'speech-direct': { sdk: { phraseList: ['name'] } }
  });
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen['voice-live']));
  assert.ok(Object.isFrozen(frozen['voice-live'].phraseList));
  assert.throws(() => frozen['voice-live'].phraseList.push('other'), TypeError);
  assert.throws(() => validateVoiceOptions({ unknown: {} }), /unsupported mode/);
});

test('advanced session payloads use real API fields without replacing GPT transaction boundaries', () => {
    const config = voiceConfig({ VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_ENDPOINT: 'https://offline.services.ai.azure.com/' });
    config.advanced = createVoiceOptionsState({ 'voice-live': {
      vadSilenceMs: 700, noiseReduction: false, echoCancellation: false, phraseList: ['桃園']
    } })['voice-live'];
    const { session } = voiceSessionUpdate(config);
    assert.equal(session.turn_detection.silence_duration_ms, 700);
    assert.equal(session.input_audio_noise_reduction, null);
    assert.equal(session.input_audio_echo_cancellation, null);
    assert.deepEqual(session.input_audio_transcription.phrase_list, ['桃園']);
    const gpt = gptLiveConfig({ GPT_LIVE_ENABLED: 'true', GPT_LIVE_ENDPOINT: 'https://offline.openai.azure.com/' });
    gpt.advanced = createVoiceOptionsState({ 'gpt-live': { language: 'en-US', style: 'professional' } })['gpt-live'];
    const start = gptLiveStart(gpt).session;
    assert.deepEqual(start.audio, { output: { voice: 'marin' } });
    assert.match(start.instructions, /Speak in clear, natural English/);
    assert.doesNotMatch(start.instructions, /請用自然的臺灣華語簡短交談/);
    assert.match(start.instructions, /Do not accept selection, repricing, consent, or purchase/);
    assert.doesNotMatch(start.instructions, /\p{Script=Han}/u);
    assert.deepEqual(start.delegation, { type: 'client' });
});

test('HTTP tickets strictly bind only current mode settings and accept bounded Unicode phrases without cloud calls', async () => {
    const server = createApp({ APP_MODE: 'mock', VOICE_LIVE_ENABLED: 'true',
      VOICE_LIVE_ENDPOINT: 'https://offline.services.ai.azure.com/',
      GPT_LIVE_ENABLED: 'true', GPT_LIVE_ENDPOINT: 'https://offline.openai.azure.com/' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const bootstrap = await fetch(`${origin}/api/bootstrap`);
      const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
      const post = body => fetch(`${origin}/api/voice/session`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const phrases = Array.from({ length: 100 }, (_, i) => '詞'.repeat(95) + i);
      assert.equal((await post({ mode: 'voice-live', voiceOptions: { 'voice-live': { phraseList: phrases } } })).status, 200);
      for (const body of [
        { mode: 'voice-live', voiceOptions: { 'gpt-live': { voice: 'marin' } } },
        { mode: 'voice-live', voiceOptions: { 'voice-live': { endpoint: 'https://untrusted.invalid/' } } },
        { mode: 'voice-live', voiceOptions: { 'voice-live': { phraseList: ['x'.repeat(101)] } } },
        { mode: 'gpt-live', voiceOptions: { 'gpt-live': { voice: 'alloy' } } },
        { mode: 'gpt-live', voiceOptions: { 'gpt-live': { instructions: 'custom' } } }
      ]) {
        const response = await post(body);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error, 'VOICE_OPTIONS');
      }
      assert.equal((await post({ mode: 'gpt-live', voiceOptions: { 'gpt-live': { voice: 'marin' } } })).status, 200);
      assert.equal((await post({ mode: 'voice-live' })).status, 200, 'legacy omission remains valid');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
