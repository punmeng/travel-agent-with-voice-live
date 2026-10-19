import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/agents.js';
import { createSession, callTool, consentToQuote, selectOffer, setTrip, purchase } from '../lib/core.js';
import { mockUnderstanding, applyUnderstanding, understandFoundry } from '../lib/conversation.js';
import { checkoutForQuote, readCheckout, checkoutPage } from '../lib/checkout.js';
import { readAll } from './reply-helper.js';
const env = { APP_MODE: 'mock' };
const say = async (s, message) => readAll(s, await chat(s, {
  message, requestId: randomUUID(), offerIds: [...s.offers.keys()],
  quoteContext: s.quote && { quoteId: s.quote.id, version: s.quote.version, total: s.quote.total, currency: s.quote.currency, expiresAt: s.quote.expiresAt }
}, env));
const trip = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', returnDate: '2026-11-16',
  travelers: 2, cabin: 'economy', budget: 50000, lowWalking: true, flexibleDays: 0, timePreference: 'early-out-late-back' };
const args = { origin: trip.origin, destination: trip.destination, date: trip.date, travelers: trip.travelers, cabin: trip.cabin, flexibleDays: 0 };

test('country discovery, themes, mother and five-day plan work before date/cabin/airport readiness', async () => {
  const s = createSession();
  let r = await say(s, '我想去日本玩幾天');
  assert.match(r.text, /日本/); assert.doesNotMatch(r.text, /UNKNOWN_CITY|IATA|YYYY|艙等/);
  assert.equal(s.discovery.country, '日本');
  await say(s, '想賞楓，不要走太多路');
  await say(s, '下個月中，五天，帶媽媽');
  r = await say(s, '那東京好了，幫我安排五天');
  assert.equal(s.trip, null); assert.equal(s.discovery.destinationCity, '東京');
  assert.equal(s.discovery.durationDays, 5); assert.equal(s.discovery.companions, '帶媽媽');
  assert.ok(s.discovery.interests.includes('賞楓')); assert.equal(s.draft.lowWalking, true);
  assert.equal(s.draft.date, undefined); assert.equal(s.draft.travelers, undefined);
  assert.equal(r.itinerary.days.length, 5); assert.match(r.text, /第 5 天/);
  assert.equal(s.toolUnits, 0); assert.equal(s.offers.size, 0);
  r = await say(s, '從台北出發，幫我找航班');
  assert.match(r.text, /桃園機場或松山機場/);
  assert.doesNotMatch(r.text, /IATA|UNKNOWN_CITY/);
  assert.equal(s.draft.origin, undefined); assert.equal(s.toolUnits, 0);
  r = await say(s, '去火星'); assert.match(r.text, /哪個城市/);
});

test('relative dates anchor to Taipei date; ambiguity stays a preference instead of an invented date', () => {
  const s = createSession(), now = Date.parse('2026-12-31T17:00:00Z'); // Jan 1 in Taipei.
  applyUnderstanding(s, mockUnderstanding(s, '明天出發'), now);
  assert.equal(s.draft.date, '2027-01-02');
  applyUnderstanding(s, mockUnderstanding(s, '下個月12號'), now);
  assert.equal(s.draft.date, '2027-02-12');
  applyUnderstanding(s, mockUnderstanding(s, '下個月中'), now);
  assert.equal(s.draft.date, undefined);
  assert.equal(s.discovery.datePreference, '下個月中');
});

test('round-trip search ranks real synthetic leg pairs and bills both legs with bounded flexible dates', async () => {
  const s = createSession(); setTrip(s, { ...trip, flexibleDays: 1 });
  const { data } = await callTool(s, 'flight', 'search_flights', { ...args, flexibleDays: 1 });
  assert.equal(s.toolUnits, 6); assert.equal(data.searchedDates.length, 3); assert.equal(data.searchedReturnDates.length, 3);
  assert.ok(data.offers.length > 0 && data.offers.length <= 6);
  for (const o of data.offers) {
    assert.equal(o.returnFlight.origin, trip.destination); assert.equal(o.returnFlight.destination, trip.origin);
    assert.ok(o.returnFlight.departureUtc > o.flight.arrivalUtc);
    const outbound = o.flight.cabins.find(c => c.cabin === trip.cabin);
    const inbound = o.returnFlight.cabins.find(c => c.cabin === trip.cabin);
    assert.ok(outbound.available >= 2 && inbound.available >= 2);
    assert.equal(o.total, (outbound.unitTotal + inbound.unitTotal) * 2);
  }
  const empty = await callTool(s, 'flight', 'search_flights', { ...args, cabin: 'premium' });
  assert.deepEqual(empty.data.offers, []);
});

test('explicit acceptance creates one opaque checkout bound to latest quote, session and expiry', async () => {
  const s = createSession(); setTrip(s, trip);
  const { data } = await callTool(s, 'flight', 'search_flights', args);
  selectOffer(s, data.offers[0].id);
  const q = (await callTool(s, 'price', 'reprice_offer', { offerId: s.selected })).data;
  await say(s, '重新報價');
  const current = s.quote;
  const r = await say(s, '我同意這個報價，請給我模擬結帳連結');
  assert.match(r.text, /\/checkout\/[a-f0-9]{64}/);
  const checkout = [...s.checkouts.values()][0];
  assert.equal(checkout.total, current.total);
  assert.deepEqual(checkoutForQuote(s, r.receipt), checkout);
  assert.equal(s.checkouts.size, 1);
  assert.match(checkoutPage(readCheckout(s, checkout.token)), /不接受信用卡/);
  assert.throws(() => readCheckout(createSession(), checkout.token), { code: 'CHECKOUT_NOT_FOUND' });
  assert.throws(() => readCheckout(s, checkout.token, Date.parse(current.expiresAt)), { code: 'CHECKOUT_EXPIRED' });
  await callTool(s, 'price', 'reprice_offer', { offerId: s.selected }, { priceDelta: 500 });
  assert.equal(s.quote.priceChanged, true); assert.equal(s.consent, null);
  assert.throws(() => readCheckout(s, checkout.token), { code: 'CHECKOUT_STALE' });
  await assert.rejects(say(s, '我不同意這個報價，請給我模擬結帳連結'), { code: 'AMBIGUOUS_CONSENT' });
  setTrip(s, { ...trip, travelers: 3 });
  assert.throws(() => readCheckout(s, checkout.token), { code: 'CHECKOUT_STALE' });
});

test('live interpretation is schema checked and evidence-bound, with no mock fallback or pre-trip search', async () => {
  const s = createSession();
  const config = { endpoint: 'https://demo.services.ai.azure.com/api/projects/test', agents: { intent: { name: 'intent', version: '3' } } };
  const result = { role: 'intent', reply: '想去日本，可以先聊旅行主題。', slots: mockUnderstanding(s, '我想去日本玩幾天') };
  const credential = { getToken: async () => ({ token: 'offline' }) };
  const fetcher = async (url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.agent_reference.name, 'intent'); assert.equal(body.tool_choice, 'none');
    assert.equal(body.text, undefined); assert.equal(body.reasoning, undefined);
    return new Response(JSON.stringify({ id: 'r', status: 'completed', usage: { total_tokens: 12 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }));
  };
  const parsed = await understandFoundry(config, s, '我想去日本玩幾天', 'corr', { credential, fetch: fetcher });
  applyUnderstanding(s, parsed.slots); assert.equal(s.discovery.country, '日本'); assert.equal(s.toolUnits, 0);
  assert.equal(s.cloudTokens, 12);
  result.slots.dateExpression = '2026-11-15';
  await assert.rejects(understandFoundry(config, s, '我想去日本玩幾天', 'corr', { credential, fetch: fetcher }), { code: 'FOUNDRY_EVIDENCE' });
});
