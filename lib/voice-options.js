const VOICE_LIVE_VAD_MS = Object.freeze([500, 700, 800, 1000, 1200]);
const REST_VAD_MS = Object.freeze([500, 700, 1000, 1200, 1500]);
const SDK_SEGMENTATION_MS = Object.freeze([700, 1000]);
const SDK_CHUNK_MS = Object.freeze([20, 40, 80, 100]);
const GPT_LANGUAGES = Object.freeze(['zh-TW', 'en-US']);
const GPT_STYLES = Object.freeze(['warm', 'friendly', 'concise', 'professional']);
const MODES = Object.freeze(['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct']);
const VOICE_STYLE_INSTRUCTIONS = Object.freeze({
  warm: 'Use a warm, reassuring, natural conversational delivery.',
  friendly: 'Use a friendly, approachable conversational delivery.',
  concise: 'Be concise and direct while remaining courteous.',
  professional: 'Use a calm, polished, professional delivery.'
});

export const VOICE_OPTION_CHOICES = Object.freeze({
  voiceLiveVadMs: VOICE_LIVE_VAD_MS,
  restVadMs: REST_VAD_MS,
  sdkSegmentationMs: SDK_SEGMENTATION_MS,
  sdkChunkMs: SDK_CHUNK_MS,
  gptLanguages: GPT_LANGUAGES,
  gptStyles: GPT_STYLES,
  gptVoices: Object.freeze(['marin'])
});

export function createDefaultVoiceOptions() {
  return {
    'voice-live': {
      vadSilenceMs: 800,
      phraseList: [],
      noiseReduction: true,
      echoCancellation: true
    },
    'voice-realtime': {
      vadSilenceMs: 800,
      noiseReduction: true,
      echoCancellation: true
    },
    'gpt-live': {
      language: 'zh-TW',
      taiwanWording: true,
      style: 'warm',
      voice: 'marin'
    },
    'speech-direct': {
      rest: { vadSilenceMs: 1000 },
      sdk: { segmentationMs: 700, phraseList: [], chunkMs: 40 }
    }
  };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  throw new TypeError(`Invalid voice options: ${message}`);
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unsupported ${path} setting "${key}"`);
  }
}

function copyPhraseList(value, path) {
  const phrases = typeof value === 'string' ? value.split(/\r?\n/) : value;
  if (!Array.isArray(phrases)) fail(`${path} must be an array or newline-separated text`);
  const unique = [];
  const seen = new Set();
  for (const phrase of phrases) {
    if (typeof phrase !== 'string') fail(`${path} entries must be strings`);
    const clean = phrase.trim();
    if (!clean) continue;
    if (clean.length > 100) fail(`${path} entries must be at most 100 characters`);
    if (!seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }
  if (unique.length > 100) fail(`${path} must contain at most 100 phrases`);
  return unique;
}

function copyChoice(value, choices, path) {
  if (!choices.includes(value)) fail(`${path} must be one of ${choices.join(', ')}`);
  return value;
}

function copyBoolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}

function copyVad(value, choices, path) {
  if (!Number.isInteger(value) || !choices.includes(value)) fail(`${path} is not supported`);
  return value;
}

function copyModeSettings(mode, settings) {
  if (!isRecord(settings)) fail(`${mode} must be an object`);
  if (mode === 'voice-live' || mode === 'voice-realtime') {
    const allowed = mode === 'voice-live'
      ? ['vadSilenceMs', 'phraseList', 'noiseReduction', 'echoCancellation']
      : ['vadSilenceMs', 'noiseReduction', 'echoCancellation'];
    assertKeys(settings, allowed, mode);
    const result = {};
    if ('vadSilenceMs' in settings) result.vadSilenceMs = copyVad(settings.vadSilenceMs, VOICE_LIVE_VAD_MS, `${mode}.vadSilenceMs`);
    if ('phraseList' in settings) result.phraseList = copyPhraseList(settings.phraseList, `${mode}.phraseList`);
    if ('noiseReduction' in settings) result.noiseReduction = copyBoolean(settings.noiseReduction, `${mode}.noiseReduction`);
    if ('echoCancellation' in settings) result.echoCancellation = copyBoolean(settings.echoCancellation, `${mode}.echoCancellation`);
    return result;
  }
  if (mode === 'gpt-live') {
    assertKeys(settings, ['language', 'taiwanWording', 'style', 'voice'], mode);
    const result = {};
    if ('language' in settings) result.language = copyChoice(settings.language, GPT_LANGUAGES, `${mode}.language`);
    if ('taiwanWording' in settings) result.taiwanWording = copyBoolean(settings.taiwanWording, `${mode}.taiwanWording`);
    if ('style' in settings) result.style = copyChoice(settings.style, GPT_STYLES, `${mode}.style`);
    if ('voice' in settings) result.voice = copyChoice(settings.voice, ['marin'], `${mode}.voice`);
    return result;
  }

  assertKeys(settings, ['rest', 'sdk'], mode);
  const result = {};
  if ('rest' in settings) {
    if (!isRecord(settings.rest)) fail(`${mode}.rest must be an object`);
    assertKeys(settings.rest, ['vadSilenceMs'], `${mode}.rest`);
    result.rest = {};
    if ('vadSilenceMs' in settings.rest) {
      result.rest.vadSilenceMs = copyVad(settings.rest.vadSilenceMs, REST_VAD_MS, `${mode}.rest.vadSilenceMs`);
    }
  }
  if ('sdk' in settings) {
    if (!isRecord(settings.sdk)) fail(`${mode}.sdk must be an object`);
    assertKeys(settings.sdk, ['segmentationMs', 'phraseList', 'chunkMs'], `${mode}.sdk`);
    result.sdk = {};
    if ('segmentationMs' in settings.sdk) {
      result.sdk.segmentationMs = copyVad(settings.sdk.segmentationMs, SDK_SEGMENTATION_MS, `${mode}.sdk.segmentationMs`);
    }
    if ('phraseList' in settings.sdk) result.sdk.phraseList = copyPhraseList(settings.sdk.phraseList, `${mode}.sdk.phraseList`);
    if ('chunkMs' in settings.sdk) result.sdk.chunkMs = copyChoice(settings.sdk.chunkMs, SDK_CHUNK_MS, `${mode}.sdk.chunkMs`);
  }
  return result;
}

/**
 * Validate only explicitly supplied settings. Undefined remains undefined so older
 * callers can keep their existing server defaults without a protocol change.
 */
export function validateVoiceOptions(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail('expected an object');
  assertKeys(value, MODES, 'mode');
  const validated = {};
  for (const [mode, settings] of Object.entries(value)) {
    validated[mode] = copyModeSettings(mode, settings);
  }
  return validated;
}

function mergeOptions(base, update) {
  for (const [key, value] of Object.entries(update)) {
    if (isRecord(value) && isRecord(base[key])) mergeOptions(base[key], value);
    else base[key] = Array.isArray(value) ? [...value] : value;
  }
  return base;
}

export function createVoiceOptionsState(initial) {
  const defaults = createDefaultVoiceOptions();
  if (initial === undefined) return defaults;
  return mergeOptions(defaults, validateVoiceOptions(initial));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function freezeVoiceOptions(value) {
  const validated = validateVoiceOptions(value);
  return validated === undefined ? undefined : deepFreeze(validated);
}

export function chunkBytesForDuration(durationMs, sampleRate) {
  if (!SDK_CHUNK_MS.includes(durationMs)) fail('speech-direct.sdk.chunkMs is not supported');
  if (![8000, 16000].includes(sampleRate)) fail('speech-direct audio sample rate must be 8000 or 16000 Hz');
  return sampleRate * durationMs / 1000 * 2;
}

export function chunkDurationForBytes(chunkBytes, sampleRate) {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || ![8000, 16000].includes(sampleRate)) {
    fail('speech-direct chunk size or sample rate is invalid');
  }
  return chunkBytes * 1000 / (sampleRate * 2);
}

export function buildGptLiveInstructions(settings) {
  const validated = copyModeSettings('gpt-live', settings);
  const { language = 'zh-TW', taiwanWording = true, style = 'warm' } = validated;
  const lines = [
    language === 'zh-TW'
      ? 'Speak in natural Traditional Chinese as used in Taiwan.'
      : 'Speak in clear, natural English.',
    taiwanWording
      ? 'For Taiwan-related topics, use Taiwan-local terminology, place names, dates, and customary phrasing; avoid Mainland China-specific wording.'
      : 'Use neutral terminology unless the user requests a regional variant.',
    VOICE_STYLE_INSTRUCTIONS[style]
  ];
  return lines.join(' ');
}
