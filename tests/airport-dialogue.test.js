import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/agents.js';
import { createSession, callTool, setTrip, selectOffer } from '../lib/core.js';
import { mockUnderstanding, applyUnderstanding } from '../lib/conversation.js';
import { readAll } from './reply-helper.js';

const env = { APP_MODE: 'mock' };
const say = async (session, message) => readAll(session, await chat(session, { message, requestId: randomUUID() }, env));
const trip = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', returnDate: '2026-11-16',
  travelers: 2, cabin: 'economy', budget: 50000, lowWalking: true, flexibleDays: 1 };
function apply(session, message) { return applyUnderstanding(session, mockUnderstanding(session, message), undefined, message); }

test('exact Taipei question, 都可以 and explicit correction retain city, both airports and preferences', async () => {
  const s = createSession();
  await say(s, '我想去日本玩幾天');
  await say(s, '成田好了，五天，帶媽媽，不要走太多路');
  let r = await say(s, '從台北出發，幫我找航班');
  assert.match(r.text, /桃園機場或松山機場/);
  assert.equal(s.discovery.airportQuestion.key, 'origin');
  r = await say(s, '都可以。');
  assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
  assert.equal(s.discovery.originCity, '台北');
  assert.equal(s.discovery.airportQuestion, undefined);
  assert.match(r.text, /桃園機場、松山機場/);
  assert.doesNotMatch(r.text, /哪個城市出發|偏好哪一座|其他已聊過/);
  assert.match(r.text, /哪一天出發/);
  r = await say(s, '我說都可以，台北桃園或松山都可以。');
  assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
  assert.doesNotMatch(r.text, /哪個城市出發|哪一座|無法確定/);
  assert.equal(s.discovery.companions, '帶媽媽');
  assert.equal(s.discovery.durationDays, 5);
  assert.equal(s.draft.lowWalking, true);
  assert.equal(s.toolUnits, 0);
});

test('pending airport question binds short answers even when model chooses wrong place slot', () => {
  for (const message of ['都可以', '沒差', '任何一個', '你幫我選']) {
    const s = createSession();
    apply(s, '從台北出發');
    const slots = mockUnderstanding(s, '');
    slots.destinationPlace = message;
    applyUnderstanding(s, slots, undefined, message);
    assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
    assert.equal(s.discovery.originCity, '台北');
    assert.equal(s.discovery.destinationCity, null);
  }
});
test('two unresolved city airport questions advance to the other airport, never re-ask its known city', async () => {
  const s = createSession();
  await say(s, '去東京');
  await say(s, '從台北出發，搜尋航班');
  let r = await say(s, '都可以');
  assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
  assert.match(r.text, /東京/);
  assert.doesNotMatch(r.text, /去哪個城市/);
  assert.equal(s.discovery.airportQuestion.key, 'destination');
  r = await say(s, '沒差');
  assert.deepEqual(s.draft.destinationAirports, ['NRT', 'HND']);
  assert.match(r.text, /哪一天出發/);
  assert.equal(s.toolUnits, 0);
});

test('Tokyo either, restriction, correction and changed city maintain an explicit accepted set', () => {
  const s = createSession();
  apply(s, '去東京');
  apply(s, '任何一個');
  assert.deepEqual(s.draft.destinationAirports, ['NRT', 'HND']);
  apply(s, '不要羽田');
  assert.equal(s.draft.destination, 'NRT');
  assert.equal(s.draft.destinationAirports, undefined);
  apply(s, '不是成田，是羽田');
  assert.equal(s.draft.destination, 'HND');
  apply(s, '去東京成田或羽田都可以');
  assert.deepEqual(s.draft.destinationAirports, ['NRT', 'HND']);
  apply(s, '去大阪');
  assert.equal(s.draft.destination, 'KIX');
  assert.equal(s.draft.destinationAirports, undefined);
  apply(s, '去火星');
  assert.equal(s.draft.destination, undefined);
  assert.equal(s.discovery.pending.destination, '火星');
});

test('accepted airport sets advance pending search, bound Cartesian costs and retain exact return pairs', async () => {
  const s = createSession();
  setTrip(s, trip);
  await say(s, '從台北出發，幫我找航班');
  assert.equal(s.trip, null);
  const r = await say(s, '都可以');
  assert.equal(s.trip.travelers, 2);
  assert.equal(s.trip.returnDate, trip.returnDate);
  assert.equal(s.trip.budget, trip.budget);
  assert.equal(s.trip.lowWalking, true);
  assert.equal(s.toolUnits, 12);
  assert.match(r.text, /已比較接受的機場|合成選項/);
  const result = r.tools[0].data;
  assert.equal(result.searchedAirportPairs.length, 2);
  assert.equal(result.maxParallelism, 2);
  assert.ok(result.offers.length > 0 && result.offers.length <= 6);
  for (const offer of result.offers) {
    assert.ok(['TPE', 'TSA'].includes(offer.flight.origin));
    assert.equal(offer.returnFlight.destination, offer.flight.origin);
  }
  setTrip(s, { ...trip, originAirports: ['TPE', 'TSA'], destinationAirports: ['NRT', 'HND'] });
  const args = { origin: 'TPE', destination: 'NRT', date: trip.date, travelers: 2, cabin: 'economy', flexibleDays: 1 };
  const multi = await callTool(s, 'flight', 'search_flights', args);
  assert.equal(multi.data.searchedAirportPairs.length, 4);
  assert.equal(s.toolUnits, 36);
  s.toolUnits = 59;
  const old = [...s.offers.keys()];
  await assert.rejects(callTool(s, 'flight', 'search_flights', args), { code: 'TOOL_BUDGET' });
  assert.deepEqual([...s.offers.keys()], old);
  assert.equal(s.toolUnits, 59);
});

test('restating an accepted city preserves selection, narrowing invalidates it without losing other trip data', async () => {
  const s = createSession();
  setTrip(s, trip);
  apply(s, '從台北出發');
  apply(s, '都可以');
  const args = { origin: 'TPE', destination: 'NRT', date: trip.date, travelers: 2, cabin: 'economy', flexibleDays: 1 };
  const result = await callTool(s, 'flight', 'search_flights', args);
  selectOffer(s, result.data.offers[0].id);
  const selected = s.selected;
  apply(s, '從台北出發');
  assert.equal(s.selected, selected);
  apply(s, '不要松山');
  assert.equal(s.selected, null);
  assert.equal(s.trip.origin, 'TPE');
  assert.equal(s.trip.originAirports, undefined);
  assert.equal(s.trip.returnDate, trip.returnDate);
  assert.equal(s.trip.travelers, 2);
});
