const diagnosticWords = new Set(('a an and are as at audio azure azure-standard be because can cannot change changed changing ' +
  'configuration configured current default does enabled error for format from has have in initial invalid is it ' +
  'missing model must name native no not of on once only output parameter pcm please provided request required ' +
  'session set settings should started supported supports that the this to type unavailable unknown unsupported ' +
  'use used valid value voice voices was when with without you your').split(' '));
const publicVoiceNames = new Set(['zh-TW-HsiaoChenNeural', 'en-US-AvaNeural', 'azure-standard',
  'azure-realtime-native', 'gpt-realtime-2.1', 'audio/pcm', 'voice_type', 'voice_locale']);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;

export function voiceServiceErrorEvidence(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 2048) : '';
  let classification = 'unclassified';
  if (error?.param === 'voice') {
    if (/cannot (?:be )?chang|can't (?:be )?chang|chang.{0,30}not (?:allowed|supported)/i.test(message)) {
      classification = 'voice-mutation-rejected';
    } else if (/not supported|unsupported|not available|unavailable/i.test(message)) {
      classification = 'voice-unsupported';
    } else if (/required|missing|must (?:be |provide|specify)/i.test(message)) {
      classification = 'voice-required-or-invalid';
    } else if (/invalid|unknown|not valid/i.test(message)) classification = 'voice-invalid';
    else classification = 'voice-error-unclassified';
  }
  // Unknown words, IDs, URLs, credentials and quoted user content never pass through.
  const words = message.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  const diagnosticWording = words.slice(0, 100).map(word => {
    const plain = word.replace(/[.:]+$/, '');
    return publicVoiceNames.has(plain) || diagnosticWords.has(plain.toLowerCase()) ? plain : '[redacted]';
  }).join(' ');
  return {
    ...Object.fromEntries(Object.entries({
      type: token(error?.type), code: token(error?.code), param: token(error?.param)
    }).filter(([, value]) => value !== undefined)),
    classification,
    diagnosticWording,
    rawMessageRetained: false,
    wordingIsExact: false,
    messagePresent: Boolean(message)
  };
}
