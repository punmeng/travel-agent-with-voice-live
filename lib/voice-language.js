import { z } from 'zod';

export const voiceLocaleSchema = z.enum(['zh-TW', 'en-US']);
export const voiceLocale = value => voiceLocaleSchema.parse(value === undefined ? 'zh-TW' : value);
export const voiceEnglish = locale => locale === 'en-US';

const messages = new Map([
  ['未偵測到足夠語音，繼續等待；未送至Azure。', 'Not enough speech detected. Still listening; nothing was sent to Azure.'],
  ['偵測到聲音，依本次停頓設定自動送出。', 'Speech detected. Your pause setting controls automatic submission.'],
  ['短暫聲響未送出，繼續等待語音。', 'Brief noise was not submitted. Still listening.'],
  ['WAV辨識輸入已結束；所有已取得的最終片段依序處理。', 'WAV input has ended. All recognized final segments are processed in order.'],
  ['SDK最終辨識片段已排隊；不是語意回合結束判定。', 'The SDK final segment is queued; this is an acoustic segment, not a semantic turn boundary.'],
  ['這一段語音可能沒有完整收錄，尚未交給後端或更改行程；請重新說一次完整需求。', 'This speech segment may be incomplete. It was not sent to the backend and your trip was not changed. Please repeat your complete request.'],
  ['這個委派的轉錄時間範圍不完整或切過轉錄片段。不得把不完整文字交給後端或當作已保存的旅程資料；請使用者重說完整需求。', 'The delegation timeline is incomplete or crosses a transcript segment. Do not send incomplete text to the backend or treat it as saved trip data. Ask the user to repeat the complete request.'],
  ['服務未提供音訊時間戳，改用PCM連續播放；無法還原省略靜音，不影響交易限制。', 'The service supplied no audio timestamps. Using contiguous PCM playback; omitted silence cannot be restored. Transaction restrictions remain in effect.'],
  ['後端未完成此委派，請閱讀畫面錯誤並停止後改用文字。', 'The backend did not complete this delegation. Read the error on screen, stop voice, and retry in text.']
]);

const codeMessages = {
  PLANNING_INPUT: 'Please provide valid trip planning details. Your trip has not been changed.',
  TRIP_INPUT: 'Please provide valid flight search details. Your trip has not been changed.',
  VOICE_LANGUAGE_UNSUPPORTED: 'The configured voice has no verified English support. This mode was not started; no other voice was substituted.',
  VOICE_LOCALE: 'The voice language must match the current session language. Stop voice before changing language.',
  VOICE_AGENT_LOCALE_UNAPPLIED: 'Foundry Voice Agent did not apply the requested language settings. The microphone was not started.',
  VOICE_AGENT_AUDIO_UNAPPLIED: 'Foundry Voice Agent did not apply the required mono PCM and server-reference echo settings. The microphone was not started.',
  VOICE_ACTIVE: 'This trip already has an active voice connection.',
  VOICE_OPTIONS: 'The advanced voice settings are not supported for this mode.',
  VOICE_SELECTION: 'This voice selection is not supported for this mode.',
  VOICE_MODE: 'The voice request contains invalid or unsupported settings.',
  VOICE_NOT_CONFIGURED: 'This voice mode is not configured. No microphone or replacement service was started.',
  STALE_OPTIONS: 'The displayed flights have changed. Refresh before starting voice.',
  STALE_QUOTE: 'The displayed quote has changed. Refresh and read it before starting voice.',
  SESSION_BUSY: 'The previous request is still running. No parallel changes were started.',
  SPEECH_TRANSCRIPTION: 'Speech did not return a valid complete sentence. No agent was called. Please reconnect.',
  SPEECH_HTTP: 'Azure Speech rejected the request. No replacement service was used.',
  SPEECH_SDK_AUTH: 'Speech SDK authentication failed. Check the server Speech identity and permissions. REST was not substituted.',
  SPEECH_SDK_CONNECTION: 'Speech SDK could not connect. Check the Speech endpoint and network. REST was not substituted.',
  SPEECH_SDK_TIMEOUT: 'Speech SDK connection timed out. Check the network and service. REST was not substituted.',
  SPEECH_SDK_INCOMPLETE: 'Audio ended before the final segment was recognized. That segment was not sent to an agent. Completed segments remain on screen.',
  SPEECH_SDK_STATE: 'Speech SDK is not accepting audio. Stop and reconnect.',
  VOICE_TEXT_LIMIT: 'This answer exceeds the speech safety limit. The complete answer remains on screen; ask for one day in detail.'
};

// Localize application-owned messages only. Never translate canonical backend answers or upstream text.
export function voiceMessage(locale, message, code = '') {
  if (!voiceEnglish(locale) || typeof message !== 'string' || !/\p{Script=Han}/u.test(message)) return message;
  if (messages.has(message)) return messages.get(message);
  if (codeMessages[code]) return codeMessages[code];
  if (/TRANSACTION/.test(code)) return 'Stop voice and use text to select flights, reprice, consent, or purchase. No transaction was authorized.';
  if (/PLAYBACK_TIMEOUT/.test(code)) return 'Playback acknowledgment timed out. Speech stopped; the complete text remains on screen.';
  if (/TURN_LIMIT/.test(code)) return 'This voice session has reached its turn limit. Stop and reconnect.';
  if (/AUDIO_LIMIT|OUTPUT_LIMIT|BACKPRESSURE/.test(code)) return 'Audio exceeded a safety limit or the connection is too slow. Voice stopped; completed text remains on screen.';
  if (/PROTOCOL|TOOL|DELEGATION|TRANSCRIPT|AUDIO|PCM|TIMING|ENCODING/.test(code)) return 'Invalid or incomplete voice data. Voice stopped without starting a replacement service.';
  if (/TIMEOUT/.test(code)) return 'The voice operation timed out. Voice stopped; completed text remains on screen.';
  if (/BUSY|PENDING/.test(code)) return 'The previous request is still running. No parallel request or repeated transaction was started.';
  if (/SPEECH_SDK/.test(code)) return 'Speech SDK recognition failed. Check the diagnostic code. REST was not substituted.';
  return 'The voice request could not be completed. Stop voice and retry in text. Completed results remain on screen; no replacement service was used.';
}

export function localizeVoiceEvent(locale, event) {
  return { ...event,
    ...(event.message ? { message: voiceMessage(locale, event.message, event.code) } : {}),
    ...(event.detail ? { detail: voiceMessage(locale, event.detail, event.code) } : {}) };
}
