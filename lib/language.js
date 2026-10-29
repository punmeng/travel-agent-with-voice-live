import { z } from 'zod';
import { readFileSync } from 'node:fs';

export const localeSchema = z.enum(['zh-TW', 'en-US']);
export const sessionLocale = session => session?.locale ?? 'zh-TW';
export const english = session => sessionLocale(session) === 'en-US';
const cities = JSON.parse(readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8'));
const cityNames = new Map(cities.cities.map(([, name, , aliases]) =>
  [name, aliases.find(alias => /^[A-Za-z]/.test(alias)) ?? name]));
const airportNames = new Map(cities.cities.flatMap(([, name, , , codes]) =>
  codes.map(code => [code, `${cityNames.get(name)} (${code})`])));
for (const [code, name] of Object.entries({ TPE: 'Taiwan Taoyuan (TPE)', TSA: 'Taipei Songshan (TSA)',
  NRT: 'Tokyo Narita (NRT)', HND: 'Tokyo Haneda (HND)', KIX: 'Osaka Kansai (KIX)' })) airportNames.set(code, name);
export const englishPlace = value => cityNames.get(value) ?? value;
export const englishAirport = code => airportNames.get(code) ?? code;
export const englishCabin = cabin => ({ economy: 'Economy', premium: 'Premium economy', business: 'Business' })[cabin] ?? 'cabin to be confirmed';

const errorMessages = {
  VALIDATION: 'Some request fields are invalid. Check the selected values and try again.',
  LANGUAGE_ACTIVE: 'Stop voice and wait for the current request to finish before changing language.',
  LANGUAGE_MISMATCH: 'The request language differs from this journey. Switch language before starting a new request.',
  FOUNDRY_LANGUAGE: 'The selected Foundry agent versions are not yet approved for English. No English agent call was made.',
  SESSION_BUSY: 'The previous request is still being processed. No parallel action was started.',
  MEMBER_INVALID: 'The email or password is incorrect.',
  MEMBER_RATE_LIMIT: 'Too many unsuccessful sign-in attempts. Wait 15 minutes and try again.',
  MEMBER_CONFIRMATION_REQUIRED: 'This will clear the current journey before switching members. Confirm the change and try again.',
  MEMBER_BUSY: 'Wait for the current request to finish before changing member accounts.',
  VOICE_ACTIVE: 'Stop the voice connection before continuing with text or changing language.',
  TRIP_INPUT: 'This trip update was not applied. Check the dates, distinct airports, cabin, budget and 1–6 adults.',
  TRIP_CURRENCY: 'This demo accepts budgets in TWD only. No currency conversion or budget update was applied.',
  PLANNING_INPUT: 'This planning update was not applied. Use days 1–14, 1–30 nights and valid same-day meeting times.',
  STALE_JOURNEY: 'The journey changed. Refresh the current journey before submitting this request.',
  STALE_OPTIONS: 'The flight list changed. Read the current numbered options before selecting.',
  INVALID_SELECTION: 'That flight number is not in the current list. Select one current numbered option.',
  OPTION_NOT_PRESENTED: 'Read this flight and its total on screen before selecting it.',
  AMBIGUOUS_CONSENT: 'No confirmation was executed. Read the current quote, then say exactly “confirm current quote”.',
  QUOTE_NOT_PRESENTED: 'Read the complete current quote on screen before confirming.',
  QUOTE_CONTEXT_REQUIRED: 'Read the current repriced quote before saying “confirm current quote”.',
  OFFER_EXPIRED: 'This offer expired. Search again to obtain current synthetic offers.',
  OFFER_NOT_FOUND: 'This offer does not belong to this journey.',
  REPRICE_REQUIRED: 'Reprice the selected offer and explicitly accept the current quote first.',
  QUOTE_EXPIRED: 'The quote expired. Reprice and accept the new quote.',
  CHECKOUT_EXPIRED: 'This simulated checkout link expired. Return to chat, reprice and confirm again.',
  CHECKOUT_STALE: 'The trip or quote changed. This link is no longer valid.',
  CHECKOUT_NOT_FOUND: 'This simulated checkout link does not belong to this conversation.',
  IDEMPOTENCY_CONFLICT: 'This request identifier was already used for a different request.',
  TOOL_FORBIDDEN: 'This agent is not authorized to execute the requested tool.',
  OFF_TRIP_TOOL: 'The tool parameters differ from the confirmed trip. No off-trip search was executed.',
  CLOUD_BUDGET: 'This journey reached its cloud usage safety limit. Start a new journey to continue.',
  FOUNDRY_UNDERSTANDING: 'The agent did not return valid understanding data. This turn was not applied.',
  FOUNDRY_EVIDENCE: 'The extracted conditions were not exact spans from your message. This update was rejected.',
  FOUNDRY_PLAN: 'The planning response has an invalid format or day range. Check the saved journey on screen.',
  PLANNING_DAY: 'The requested day is outside the saved trip duration.',
  BODY_LIMIT: 'The request exceeds the permitted size.',
  INVALID_JSON: 'The request must contain valid JSON.',
  CONTENT_TYPE: 'Send the request as JSON.',
  NOT_FOUND: 'The requested resource was not found.',
  HOST_FORBIDDEN: 'Only local access is allowed.',
  METHOD: 'This HTTP method is not supported.',
  INTERNAL: 'The request failed. Check the saved journey and provide the correlation ID if the problem persists.'
};
export function localizedError(error, locale = 'zh-TW') {
  if (locale !== 'en-US') return error.message;
  const code = error.code ?? (error.name === 'ZodError' ? 'VALIDATION' : 'INTERNAL');
  if (errorMessages[code]) return errorMessages[code];
  if (code.startsWith('FOUNDRY_')) return 'The AI service could not complete this request. Check the saved journey on screen. No success is assumed.';
  if (code.startsWith('VOICE_') || code.startsWith('SPEECH_') || code.startsWith('GPT_LIVE_')) {
    return 'The voice request could not be completed. Check the diagnostic code and the saved journey on screen.';
  }
  return `The request was rejected (${code}). Check the current journey, offer and quote before continuing.`;
}
