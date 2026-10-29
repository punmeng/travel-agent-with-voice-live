import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './core.js';
import { memberProfile } from './members.js';
import { applyUnderstanding } from './conversation.js';
import { checkVersion } from './journey.js';

export const originConfirmationSchema = z.object({
  id: z.string().uuid(), action: z.enum(['confirm', 'change'])
}).strict();
const copies = {
  'zh-TW': {
    question: city => `您的示範個人檔案城市是${city}。這趟要從這裡出發嗎？請確認，或告訴我其他出發城市。`,
    confirmed: city => `已確認出發城市：${city}。`,
    airport: codes => `您偏好哪個出發機場？${codes.join('／')}；也可以說「都可以」。`,
    next: '接著可補齊「本次旅程」尚缺的條件，或繼續規劃；尚未搜尋航班。',
    change: '好的，未採用個人檔案城市。這趟想從哪個城市或機場出發？'
  },
  'en-US': {
    question: city => `Your demo profile city is ${city}. Depart from there for this trip? Please confirm or tell me a different departure city.`,
    confirmed: city => `Departure city confirmed: ${city}.`,
    airport: codes => `Which departure airport do you prefer: ${codes.join(' / ')}? You can also say “either”.`,
    next: 'You can continue planning or add any missing Current trip details. No flight search was performed.',
    change: 'The profile city was not applied. Which city or airport would you like to depart from?'
  },
  'ja-JP': {
    question: city => `デモのプロフィール都市は${city}です。今回はこちらから出発しますか？確認するか、別の出発都市を教えてください。`,
    confirmed: city => `出発都市を確認しました：${city}。`,
    airport: codes => `出発空港は${codes.join(' / ')}のどちらを希望しますか？「どちらでも」でも選べます。`,
    next: '旅程の未確定項目を補足するか、計画を続けられます。フライト検索はまだ実行していません。',
    change: 'プロフィール都市は適用しません。出発する都市または空港を教えてください。'
  },
  'ko-KR': {
    question: city => `데모 프로필 도시는 ${city}입니다. 이번 여행은 여기에서 출발하나요? 확인하거나 다른 출발 도시를 알려 주세요.`,
    confirmed: city => `출발 도시 확인: ${city}.`,
    airport: codes => `출발 공항은 ${codes.join(' / ')} 중 어디인가요? "둘 다"도 선택할 수 있습니다.`,
    next: '여정의 미확정 항목을 추가하거나 계획을 계속할 수 있습니다. 아직 항공편을 검색하지 않았습니다.',
    change: '프로필 도시는 적용하지 않았습니다. 출발 도시 또는 공항을 알려 주세요.'
  }
};

export function seedMemberOrigin(session) {
  const member = memberProfile(session.memberId, session.locale);
  session.originSuggestion = member ? { id: randomUUID(), city: member.homeCity, status: 'pending', promptActive: true } : null;
}

export function memberOriginPrompt(session) {
  if (session.originSuggestion?.status !== 'pending') return null;
  return copies[session.locale ?? 'zh-TW'].question(session.originSuggestion.city);
}

export function reconcileMemberOrigin(session) {
  if (session.originSuggestion?.status === 'pending' &&
      (session.trip?.origin || session.draft.origin || session.discovery.originCity)) {
    session.originSuggestion.status = 'overridden';
    session.originSuggestion.promptActive = false;
  }
}

export function answerMemberOriginMessage(session, message, submitted, expectedVersion, now) {
  const suggestion = session.originSuggestion;
  const specificConfirm = /^(?:確認出發城市|confirm departure city|出発都市を確認|출발 도시 확인)[。.!！]?$/iu.test(message);
  const specificChange = /^(?:更改出發城市|change departure city|出発都市を変更|출발 도시 변경)[。.!！]?$/iu.test(message);
  const plainConfirm = /^(?:是|好|好的|確認|可以|yes|yes please|confirm|はい|네)[。.!！]?$/iu.test(message);
  const plainChange = /^(?:不是|不要|否|no|いいえ|아니요)[。.!！]?$/iu.test(message);
  if (!submitted && (!suggestion || suggestion.status !== 'pending' ||
      !(specificConfirm || specificChange || suggestion.promptActive && (plainConfirm || plainChange)))) return null;
  const answer = submitted ? originConfirmationSchema.parse(submitted) : {
    id: suggestion.id, action: specificChange || plainChange ? 'change' : 'confirm'
  };
  if (submitted && expectedVersion === undefined) throw new AppError('ORIGIN_CONTEXT_REQUIRED', 'The displayed trip version is required to confirm the suggested departure.', 409);
  checkVersion(session, expectedVersion);
  if (!session.memberId || !suggestion || suggestion.id !== answer.id || suggestion.status !== 'pending') {
    throw new AppError('ORIGIN_SUGGESTION_STALE', 'Departure suggestion changed. Please use the current trip confirmation.', 409);
  }
  const copy = copies[session.locale ?? 'zh-TW'];
  suggestion.promptActive = false;
  if (answer.action === 'change') {
    suggestion.status = 'declined';
    session.contextVersion = (session.contextVersion ?? 0) + 1;
    session.discovery.followUpQuestion = { field: 'origin', kind: 'manual-origin' };
    return copy.change;
  }
  applyUnderstanding(session, { originPlace: suggestion.city }, now, `從${suggestion.city}出發`, { expectedVersion });
  suggestion.status = 'confirmed';
  const choice = session.discovery.originAirportChoice;
  session.discovery.followUpQuestion = { field: choice && !choice.accepted.length ? 'origin' : 'destination', kind: 'trip' };
  return `${copy.confirmed(suggestion.city)} ${choice?.candidates.length > 1 && !choice.accepted.length
    ? copy.airport(choice.candidates) : copy.next}`;
}
