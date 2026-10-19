import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { network, airports, routes, airportMap, generateFlights, localDateTime, localToUtc, addDays } from '../lib/dataset.js';
import { createSession, callTool, setTrip, selectOffer, consentToQuote, purchase, boundedMap, tripSchema } from '../lib/core.js';
import { chat, intentAgent } from '../lib/agents.js';

const now = Date.parse('2026-10-16T01:00:00Z');
const search = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2, cabin: 'economy', flexibleDays: 1 };
const trip = { ...search, budget: 30000, lowWalking: true };
async function selectedSession() {
  const s = createSession(now); setTrip(s, trip);
  const { data } = await callTool(s, 'flight', 'search_flights', search, { now });
  assert.ok(data.offers.length);
  selectOffer(s, data.offers[0].id, now);
  return s;
}
const consent = q => ({ quoteId: q.id, version: q.version, total: q.total, currency: q.currency, expiresAt: q.expiresAt, accepted: true });
test('representative network integrity, timezone, cabins, deterministic schedules and fares', () => {
  assert.equal(new Set(airports.map(a => a.code)).size, airports.length);
  assert.equal(new Set(routes.map(r => r.id)).size, routes.length);
  assert.ok(airports.length >= 40 && routes.length >= 80);
  for (const a of airports) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: a.timezone }));
  for (const r of routes) {
    assert.ok(airportMap.has(r.origin) && airportMap.has(r.destination));
    assert.notEqual(r.origin, r.destination);
    assert.ok(routes.some(other => other.origin === r.destination && other.destination === r.origin));
    assert.ok(!r.cabins.includes('premium') || r.minutes >= 480);
  }
  for (const date of ['2026-10-16', '2026-11-01', '2027-02-12']) {
    const flights = generateFlights(date);
    assert.deepEqual(flights, generateFlights(date));
    assert.equal(new Set(flights.map(f => f.id)).size, flights.length);
    for (const f of flights) {
      assert.equal(f.departureLocal.slice(0, 10), date);
      assert.equal(Date.parse(f.arrivalUtc) - Date.parse(f.departureUtc), f.durationMinutes * 60000);
      assert.equal(localDateTime(f.arrivalUtc, f.destinationTimezone), f.arrivalLocal);
      assert.equal(localToUtc(date, f.departureLocal.slice(11), f.originTimezone), f.departureUtc);
      assert.ok(f.mock && f.flightNumber.startsWith('DEMO-FLT-'));
      for (const c of f.cabins) {
        assert.ok(Number.isInteger(c.unitTotal) && c.unitTotal > 0);
        assert.ok(c.available >= 0 && c.available <= 8);
        assert.equal(c.currency, 'TWD');
      }
    }
  }
  const eastbound = generateFlights('2026-11-12').find(f => f.origin === 'TPE' && f.destination === 'LAX' && f.departureLocal.endsWith('08:30'));
  assert.ok(eastbound.arrivalLocal < eastbound.departureLocal, 'date line local arrival can be earlier');
  const overnight = generateFlights('2026-11-12').find(f => f.origin === 'TPE' && f.destination === 'NRT' && f.departureLocal.endsWith('23:40'));
  assert.equal(overnight.arrivalLocal.slice(0, 10), '2026-11-13');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(generateFlights(addDays(network.metadata.startDate, network.metadata.days)).length, 0);
});
test('strict schemas and permissions reject unauthorized and malformed inputs', async () => {
  const s = createSession(now);
  assert.throws(() => tripSchema.parse({ ...trip, date: '2026-02-30' }));
  assert.throws(() => tripSchema.parse({ ...trip, date: '11-12' }));
  assert.throws(() => tripSchema.parse({ ...trip, origin: 'BAD' }));
  for (const input of [{ ...search, travelers: 7 }, { ...search, flexibleDays: 2 }, { ...search, currency: 'USD' }]) {
    await assert.rejects(callTool(s, 'flight', 'search_flights', input));
  }
  await assert.rejects(callTool(s, 'planner', 'search_flights', search), { code: 'TOOL_FORBIDDEN' });
  await assert.rejects(callTool(s, 'price', 'purchase', {}), { code: 'TOOL_FORBIDDEN' });
});
test('persisted dataset exports have complete flight/fare referential integrity', () => {
  const load = name => JSON.parse(readFileSync(new URL(`../data/generated/${name}.json`, import.meta.url)));
  const exportedAirports = load('airports'), exportedRoutes = load('routes'), flights = load('flights'), fares = load('fares');
  assert.deepEqual(exportedAirports.records, airports); assert.deepEqual(exportedRoutes.records, routes);
  assert.equal(flights.metadata.mock, true); assert.equal(fares.metadata.sourceAccessDate, '2026-10-16');
  const routeMap = new Map(routes.map(r => [r.id, r]));
  const flightMap = new Map(flights.records.map(f => [f.id, f]));
  assert.equal(flightMap.size, flights.records.length); assert.equal(flightMap.size, routes.length * 2 * 120);
  const fareIds = new Set();
  for (const f of flights.records) {
    const r = routeMap.get(f.routeId);
    assert.ok(r); assert.equal(f.origin, r.origin); assert.equal(f.destination, r.destination);
    assert.equal(Date.parse(f.arrivalUtc) - Date.parse(f.departureUtc), r.minutes * 60000);
  }
  for (const fare of fares.records) {
    assert.ok(!fareIds.has(fare.id)); fareIds.add(fare.id);
    const f = flightMap.get(fare.flightId); assert.ok(f);
    const c = f.cabins.find(c => c.cabin === fare.cabin);
    assert.ok(c); assert.equal(c.unitTotal, fare.unitTotal); assert.equal(c.available, fare.available);
    assert.equal(fare.currency, 'TWD'); assert.equal(fare.mock, true);
  }
  assert.equal(fares.records.length, flights.records.reduce((n, f) => n + f.cabins.length, 0));
});
test('no-result unsupported cabin/route/date and bounded flexible search budgets', async () => {
  const s = createSession(now);
  for (const override of [{ cabin: 'premium' }, { origin: 'KHH', destination: 'JFK' }, { date: '2028-01-01' }]) {
    const r = await callTool(s, 'flight', 'search_flights', { ...search, ...override }, { now });
    assert.deepEqual(r.data.offers, []);
  }
  const r = await callTool(s, 'flight', 'search_flights', search, { now });
  assert.equal(r.data.searchedDates.length, 3);
  assert.ok(r.data.offers.length <= 6);
  for (const o of r.data.offers) assert.equal(o.total, o.unitTotal * 2);
  s.toolUnits = 58;
  await assert.rejects(callTool(s, 'flight', 'search_flights', search), { code: 'TOOL_BUDGET' });
  let active = 0, peak = 0;
  const result = await boundedMap([1, 2, 3], 2, async n => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return n;
  });
  assert.deepEqual(result, [1, 2, 3]); assert.equal(peak, 2);
});
test('offer ownership, expiry, reprice and explicit quote-bound consent', async () => {
  const s = await selectedSession(), id = s.selected;
  await assert.rejects(callTool(createSession(), 'price', 'get_offer', { offerId: id }, { now }), { code: 'OFFER_NOT_FOUND' });
  assert.throws(() => selectOffer(s, id, now + 600000), { code: 'OFFER_EXPIRED' });
  assert.throws(() => purchase(s, { quoteId: randomUUID(), idempotencyKey: randomUUID() }, now), { code: 'CONSENT_REQUIRED' });
  const q = (await callTool(s, 'price', 'reprice_offer', { offerId: id }, { now })).data;
  assert.throws(() => consentToQuote(s, { ...consent(q), total: q.total - 1 }, now), { code: 'STALE_CONSENT' });
  assert.throws(() => consentToQuote(s, { ...consent(q), accepted: false }, now));
  consentToQuote(s, consent(q), now);
  const q2 = (await callTool(s, 'price', 'reprice_offer', { offerId: id }, { now: now + 1000, priceDelta: 500 })).data;
  assert.equal(q2.total, q.total + 500); assert.equal(q2.version, q.version + 1);
  assert.equal(s.consent, null);
  assert.throws(() => consentToQuote(s, consent(q), now + 1000), { code: 'STALE_CONSENT' });
  consentToQuote(s, consent(q2), now + 1000);
  assert.throws(() => purchase(s, { quoteId: q2.id, idempotencyKey: randomUUID() }, Date.parse(q2.expiresAt)), { code: 'QUOTE_EXPIRED' });
  const args = { quoteId: q2.id, idempotencyKey: randomUUID() };
  const receipt = purchase(s, args, now + 1001);
  assert.equal(receipt.status, 'SIMULATED_ONLY');
  assert.deepEqual(purchase(s, args, now + 999999), receipt, 'retry returns the same simulated receipt');
  assert.deepEqual(purchase(s, { ...args, idempotencyKey: randomUUID() }, now + 1002), receipt, 'one receipt per quote');
  assert.throws(() => purchase(s, { ...args, quoteId: randomUUID() }, now + 1002), { code: 'IDEMPOTENCY_CONFLICT' });
  setTrip(s, { ...trip, travelers: 3 });
  assert.equal(s.selected, null); assert.equal(s.consent, null); assert.equal(s.quote, null); assert.equal(s.offers.size, 0);
});
test('all four mock agents route, share state, and chat cannot purchase', async () => {
  const s = createSession();
  assert.equal(intentAgent('您好', 'chat').role, 'intent');
  let r = await chat(s, { message: '您好', trip }, { APP_MODE: 'mock' });
  assert.equal(r.state.activeAgent, 'intent');
  r = await chat(s, { message: '幫我規劃少步行行程' }, { APP_MODE: 'mock' });
  assert.equal(r.state.activeAgent, 'planner'); assert.equal(r.itinerary.days.length, 3);
  assert.equal(r.itinerary.lowWalking, true);
  r = await chat(s, { message: '搜尋航班' }, { APP_MODE: 'mock' });
  assert.equal(r.state.activeAgent, 'flight'); assert.ok(r.state.offers.length > 0);
  selectOffer(s, r.state.offers[0].id);
  r = await chat(s, { message: '我要買票付款' }, { APP_MODE: 'mock' });
  assert.equal(r.state.activeAgent, 'price'); assert.ok(s.quote); assert.equal(r.state.quote, null); assert.equal(s.bookings.size, 0);
  await chat(s, { message: '從高雄到成田，2026-11-14，3 人，預算 40000', action: 'plan' }, { APP_MODE: 'mock' });
  assert.equal(s.trip.origin, 'KHH'); assert.equal(s.trip.destination, 'NRT');
  assert.equal(s.trip.date, '2026-11-14'); assert.equal(s.trip.travelers, 3); assert.equal(s.trip.budget, 40000);
  s.turns = 100;
  await assert.rejects(chat(s, { message: '再找一次' }, { APP_MODE: 'mock' }), { code: 'TURN_LIMIT' });
});
