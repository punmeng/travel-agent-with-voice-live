import { promisify } from 'node:util';
import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { addDays } from './dataset.js';

const scrypt = promisify(scryptCallback);
const profiles = JSON.parse(readFileSync(new URL('../data/member-profiles.json', import.meta.url), 'utf8'));
const personas = JSON.parse(readFileSync(new URL('../data/member-personas.json', import.meta.url), 'utf8'));
const policies = JSON.parse(readFileSync(new URL('../data/corporate-policies.json', import.meta.url), 'utf8'));
const credentialsData = JSON.parse(readFileSync(new URL('../data/member-credentials.json', import.meta.url), 'utf8'));
const memberSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,48}$/),
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(64),
  homeCity: z.string().min(1).max(64),
  personaId: z.string(),
  corporatePolicyId: z.string().optional()
}).strict();
const personaSchema = z.object({
  labels: z.object({ 'zh-TW': z.string(), 'en-US': z.string() }).strict(),
  preferredCabin: z.enum(['economy', 'premium', 'business']).nullable(),
  preferenceSummary: z.object({ 'zh-TW': z.array(z.string().min(1).max(100)).min(1).max(3),
    'en-US': z.array(z.string().min(1).max(100)).min(1).max(3) }).strict(),
  softPreferences: z.object({ 'zh-TW': z.array(z.string().min(1).max(240)).max(8),
    'en-US': z.array(z.string().min(1).max(240)).max(8) }).strict(),
  unsupportedRequests: z.array(z.string().min(1).max(120)).max(8)
}).strict();
const credentialSchema = z.object({
  email: z.string().email().max(254),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  hash: z.string().regex(/^[a-f0-9]{128}$/)
}).strict();
const corporatePolicySchema = z.object({
  labels: z.object({ 'zh-TW': z.string(), 'en-US': z.string() }).strict(),
  advisoryOnly: z.literal(true),
  guidance: z.object({ 'zh-TW': z.array(z.string().min(1).max(240)).max(8),
    'en-US': z.array(z.string().min(1).max(240)).max(8) }).strict()
}).strict();
const memberRows = z.array(memberSchema).parse(profiles.members);
const credentials = z.array(credentialSchema).parse(credentialsData.credentials);
const personaRows = Object.fromEntries(Object.entries(personas.personas).map(([id, value]) => [id, personaSchema.parse(value)]));
const policyRows = Object.fromEntries(Object.entries(policies.policies).map(([id, value]) => [id, corporatePolicySchema.parse(value)]));
const memberByEmail = new Map(memberRows.map(member => [member.email.toLowerCase(), member]));
const memberById = new Map(memberRows.map(member => [member.id, member]));
const credentialByEmail = new Map(credentials.map(credential => [credential.email.toLowerCase(), credential]));
if (memberByEmail.size !== memberRows.length || credentialByEmail.size !== credentials.length ||
    memberRows.some(member => !personaRows[member.personaId] ||
      member.corporatePolicyId && !policyRows[member.corporatePolicyId] ||
      !credentialByEmail.has(member.email.toLowerCase()))) {
  throw new Error('Member catalogs contain duplicate or unresolved references.');
}

const dummySalt = Buffer.alloc(16, 0x5a);
const dummyHash = Buffer.alloc(64);
const publicMemberFields = new Set(['id', 'email', 'displayName', 'homeCity', 'personaId', 'corporatePolicyId']);

export const memberLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  password: z.string().min(8).max(128),
  confirmReset: z.boolean().optional().default(false)
}).strict();

export async function authenticateMember(email, password) {
  const member = memberByEmail.get(email);
  const credential = credentialByEmail.get(email);
  const salt = credential ? Buffer.from(credential.salt, 'hex') : dummySalt;
  const expected = credential ? Buffer.from(credential.hash, 'hex') : dummyHash;
  const actual = await scrypt(password, salt, 64);
  if (!timingSafeEqual(actual, expected) || !member) return null;
  return member;
}

export function memberProfile(memberId, locale = 'zh-TW') {
  const member = memberById.get(memberId);
  if (!member) return null;
  const persona = personaRows[member.personaId];
  const policy = member.corporatePolicyId ? policyRows[member.corporatePolicyId] : null;
  return {
    ...Object.fromEntries(Object.entries(member).filter(([key]) => publicMemberFields.has(key))),
    personaLabel: persona.labels[locale],
    softPreferences: [...persona.softPreferences[locale]],
    preferenceSummary: [...persona.preferenceSummary[locale]],
    preferredCabin: persona.preferredCabin,
    preferredCabinLabel: persona.preferredCabin
      ? ({ economy: locale === 'en-US' ? 'Economy' : '經濟艙',
        premium: locale === 'en-US' ? 'Premium economy' : '豪華經濟艙',
        business: locale === 'en-US' ? 'Business' : '商務艙' })[persona.preferredCabin]
      : null,
    ...(policy ? { corporatePolicyLabel: policy.labels[locale], corporatePolicyAdvisoryOnly: true } : {})
  };
}

export function memberDefaults(memberId) {
  const member = memberById.get(memberId);
  if (!member) return {};
  const preferredCabin = personaRows[member.personaId].preferredCabin;
  return preferredCabin ? { cabin: preferredCabin } : {};
}

export function hasActiveMemberJourney(session) {
  return Boolean(session.trip || session.selected || session.quote || session.consent ||
    session.offers?.size || session.history?.some(entry => entry.role === 'user') ||
    session.discovery?.planning?.meetings?.length || session.discovery?.planning?.activities?.length);
}

export function memberAgentPreferences(memberId, locale = 'zh-TW') {
  const member = memberById.get(memberId);
  if (!member) return null;
  const persona = personaRows[member.personaId];
  const policy = member.corporatePolicyId ? policyRows[member.corporatePolicyId] : null;
  return {
    persona: member.personaId,
    preferredCabin: persona.preferredCabin,
    softPreferences: [...persona.softPreferences[locale]],
    unsupportedRequests: [...persona.unsupportedRequests],
    ...(policy ? { corporateGuidance: [...policy.guidance[locale]], corporateAdvisoryOnly: true } : {})
  };
}

function localDate(isoLocal) { return isoLocal?.slice(0, 10) ?? ''; }
function localHour(isoLocal) { return Number(isoLocal?.slice(11, 13) ?? 0); }
function dateDistance(value, target) {
  if (!value || !target) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Date.parse(`${value}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`));
}
function daylightScore(hour) { return hour >= 6 && hour < 19 ? 0 : 1; }
function arrivalDaylightScore(offer) {
  const hour = localHour(offer.flight.arrivalLocal);
  return hour >= 7 && hour < 21 ? 0 : 1;
}
function meetingFit(offer, trip, meetings = []) {
  let misses = 0;
  for (const meeting of meetings) {
    const meetingDate = addDays(trip.date, meeting.day - 1);
    const start = `${meetingDate}T${meeting.start}`;
    if (offer.flight.arrivalLocal > start) misses++;
    if (offer.returnFlight) {
      const returnDate = addDays(trip.returnDate ?? trip.date, meeting.day - 1);
      const end = `${returnDate}T${meeting.end}`;
      if (offer.returnFlight.departureLocal >= start && offer.returnFlight.departureLocal < end) misses++;
    }
  }
  return misses;
}

export function rankMemberOffers(memberId, offers, trip, planning = {}) {
  const member = memberById.get(memberId);
  if (!member || offers.length < 2) return { offers: [...offers], reason: null };
  const personaId = member.personaId;
  const annotated = offers.map((offer, index) => ({ offer, index }));
  const dateDistanceFor = offer => dateDistance(localDate(offer.flight.departureLocal), trip?.date);
  const price = (a, b) => a.offer.total - b.offer.total;
  const date = (a, b) => dateDistanceFor(a.offer) - dateDistanceFor(b.offer);
  if (personaId === 'value') annotated.sort((a, b) => price(a, b) || date(a, b) || a.index - b.index);
  else if (personaId === 'family') annotated.sort((a, b) =>
    daylightScore(localHour(a.offer.flight.departureLocal)) - daylightScore(localHour(b.offer.flight.departureLocal)) ||
    date(a, b) || price(a, b) || a.index - b.index);
  else if (personaId === 'premium') annotated.sort((a, b) =>
    arrivalDaylightScore(a.offer) - arrivalDaylightScore(b.offer) ||
    daylightScore(localHour(a.offer.flight.departureLocal)) - daylightScore(localHour(b.offer.flight.departureLocal)) ||
    a.offer.flight.durationMinutes - b.offer.flight.durationMinutes || price(a, b) || a.index - b.index);
  else {
    const meetings = planning.meetings ?? [];
    annotated.sort((a, b) => meetings.length
      ? meetingFit(a.offer, trip, meetings) - meetingFit(b.offer, trip, meetings) ||
        daylightScore(localHour(a.offer.flight.departureLocal)) - daylightScore(localHour(b.offer.flight.departureLocal)) ||
        price(a, b) || a.index - b.index
      : daylightScore(localHour(a.offer.flight.departureLocal)) - daylightScore(localHour(b.offer.flight.departureLocal)) ||
        date(a, b) || price(a, b) || a.index - b.index);
  }
  return {
    offers: annotated.map(({ offer }) => offer),
    reason: personaId === 'value' ? 'value' : personaId === 'family' ? 'family' :
      personaId === 'premium' ? 'premium' : 'business',
    meetingAware: personaId === 'business' && (planning.meetings?.length ?? 0) > 0
  };
}

export function memberRankingMessage(reason, locale, meetingAware = false) {
  const messages = locale === 'en-US' ? {
      value: 'Personalized order: lower synthetic total first, then date flexibility.',
      family: 'Personalized order: daytime departures first, then date flexibility and synthetic total fare. Child services, adjacent seats, and family-room inventory are not cataloged.',
      premium: 'Personalized order: daytime local arrivals, then daytime departures, shorter flight duration, and synthetic total fare. Cabin choice stays unchanged; hotel quality and status benefits are not cataloged.',
      business: meetingAware
        ? 'Personalized order: synthetic arrival/departure times are compared with the saved meeting blocks, then daytime departures and synthetic total fare. Direct-flight, changeability, and hotel inventory are not represented.'
        : 'Personalized order: daytime departures first, then date flexibility and synthetic total fare. Add meeting times for schedule-fit comparison; direct-flight, changeability, and hotel inventory are not represented.'
    } : {
    value: '個人化排序：先比較合成總價，再比較日期彈性。',
    family: '個人化排序：優先白天出發，再比較日期彈性與合成總價；目錄沒有兒童服務、相鄰座位或家庭房庫存資料。',
    premium: '個人化排序：優先當地白天抵達，再比較白天出發、較短飛行時間與合成總價；所選艙等保持不變，目錄沒有飯店品質或會員禮遇資料。',
    business: meetingAware
      ? '個人化排序：先將合成抵達／出發時間與已保存的會議時段比較，再比較白天出發與合成總價。目錄沒有直飛、改票或飯店庫存資料。'
      : '個人化排序：優先白天出發，再比較日期彈性與合成總價；提供會議時間後可再比較時程。目錄沒有直飛、改票或飯店庫存資料。'
  };
  return messages[reason] ?? null;
}

export function memberRankingSummary(session) {
  const ranking = session.memberRanking;
  const offerIds = [...session.offers.keys()];
  if (!ranking?.reason || ranking.memberId !== session.memberId || !memberById.has(session.memberId) ||
      session.offers.size < 2 || ranking.context !== memberRankingContext(session) ||
      ranking.offerIds.length !== session.offers.size ||
      !ranking.offerIds.every((id, index) => id === offerIds[index])) return null;
  return {
    reason: ranking.reason, meetingAware: ranking.meetingAware === true,
    offerIds: [...ranking.offerIds],
    message: memberRankingMessage(ranking.reason, session.locale ?? 'zh-TW', ranking.meetingAware)
  };
}

export function memberRankingContext(session) {
  return JSON.stringify({ trip: session.trip, meetings: session.discovery?.planning?.meetings ?? [] });
}

export function createLoginRateLimiter({ limit = 8, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const failures = new Map();
  return {
    blocked(key) {
      const cutoff = now() - windowMs;
      const recent = (failures.get(key) ?? []).filter(timestamp => timestamp > cutoff);
      if (recent.length) failures.set(key, recent);
      else failures.delete(key);
      return recent.length >= limit;
    },
    recordFailure(key) {
      const cutoff = now() - windowMs;
      const recent = (failures.get(key) ?? []).filter(timestamp => timestamp > cutoff);
      recent.push(now());
      failures.set(key, recent);
      if (failures.size > 2000) {
        for (const [candidate, timestamps] of failures) {
          if (!timestamps.some(timestamp => timestamp > cutoff)) failures.delete(candidate);
        }
      }
    }
  };
}
