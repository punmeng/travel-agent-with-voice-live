import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createSession, publicState } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { resolveDate, mockUnderstanding, applyUnderstanding } from '../lib/conversation.js';
import { createApp } from '../server.js';
import { foundryConfig, invokeFoundry } from '../lib/foundry.js';
import { checkoutPage, readCheckout } from '../lib/checkout.js';
import { request as httpRequest } from 'node:http';
import { cityResolver } from '../lib/city-airports.js';
import { englishResponseSections } from '../lib/english-replies.js';
const env = { APP_MODE: 'mock' };
const context = session => ({
  offerIds: [...session.offers.keys()],
  quoteContext: session.quote ? { quoteId: session.quote.id, version: session.quote.version, total: session.quote.total,
    currency: session.quote.currency, expiresAt: session.quote.expiresAt } : null,
  contextVersion: session.contextVersion
});
const say = (session, message, extra = {}) => chat(session, { message, requestId: randomUUID(),
  locale: session.locale, ...context(session), delivery: 'text', ...extra }, env);
async function englishSession() {
  const session = createSession();
  session.locale = 'en-US';
  await say(session, 'Plan a five-day business trip from Taoyuan to Narita on November 12, 2026 for two adults, economy, with less walking.');
  return session;
}
test('English multi-turn planning keeps business purpose separate from cabin and local activities separate from destination', async () => {
  const session = await englishSession();
  assert.equal(session.trip.cabin, 'economy');
  assert.equal(session.trip.lowWalking, true);
  assert.equal(session.discovery.durationDays, 5);
  assert.equal(session.trip.travelers, 2);
  await say(session, 'Meetings on days 2 and 3 from 09:00 to 17:00 at Tokyo Station.');
  await say(session, 'Day 4 afternoon visit Asakusa for shopping.');
  const result = await say(session, 'Stay near Tokyo Station for 4 nights. The flights and accommodation budget is TWD 50000, with transport and meals separate.');
  assert.equal(session.trip.destination, 'NRT');
  assert.equal(session.trip.budget, null, 'combined budget is not a flight-only budget');
  assert.equal(session.discovery.planning.lodging.area, 'Tokyo Station');
  assert.deepEqual(session.discovery.planning.meetings.map(block => [block.day, block.start, block.end]), [[2, '09:00', '17:00'], [3, '09:00', '17:00']]);
  assert.equal(session.discovery.planning.activities[0].period, 'afternoon');
  assert.equal(session.discovery.planning.budget.total, 50000);
  assert.deepEqual(session.discovery.planning.budget.separate, ['transport', 'meals']);
  assert.match(result.text, /Day 5/);
  assert.match(result.text, /No flight search was performed/);
  assert.doesNotMatch(result.text, /[\u3400-\u9fff]/);
  assert.equal(result.speech.detail, 'summary');
  assert.doesNotMatch(result.speech.text, /Day 1/);
  const detailed = await say(session, 'Explain day 2 in detail.');
  assert.match(detailed.text, /Day 2/);
  assert.doesNotMatch(detailed.text, /Day 1|Day 3/);
  assert.equal(detailed.speech.text, detailed.text);
  assert.equal(detailed.speech.detail, 'detailed');
  const before = JSON.stringify(publicState(session));
  await assert.rejects(say(session, 'Meeting on day 15 from 9 am to 5 pm at Tokyo Station.'), { code: 'PLANNING_INPUT' });
  assert.equal(JSON.stringify(publicState(session)), before);
  await assert.rejects(say(session, 'My budget is USD 5000.'), { code: 'TRIP_CURRENCY' });
  assert.equal(JSON.stringify(publicState(session)), before);
  await say(session, 'Cancel meetings on day 2.');
  assert.deepEqual(session.discovery.planning.meetings.map(block => block.day), [3]);
});
test('English flight selection, reprice and exact quote confirmation retain transaction guards and idempotency', async () => {
  const session = await englishSession();
  const flights = await say(session, 'Search flights');
  assert.match(flights.text, /Synthetic flights/);
  assert.doesNotMatch(flights.text, /[\u3400-\u9fff]/);
  const list = [...session.offers.keys()];
  await say(session, 'Select flight 1');
  assert.equal(session.selected, list[0]);
  const quote = await say(session, 'Reprice');
  assert.match(quote.text, /confirm current quote/);
  assert.equal(quote.state.quote.id, session.quote.id);
  for (const ambiguous of ['confirm', 'I do not confirm current quote', 'confirm current quote if it is cheaper', 'I accept']) {
    await assert.rejects(say(session, ambiguous), { code: 'AMBIGUOUS_CONSENT' });
  }
  const request = { message: 'confirm current quote', locale: 'en-US', requestId: randomUUID(), ...context(session), delivery: 'text' };
  const confirmed = await chat(session, request, env);
  assert.match(confirmed.text, /Simulated confirmation total/);
  assert.equal(confirmed.speech.detail, 'detailed');
  assert.deepEqual(await chat(session, request, env), confirmed);
  assert.equal(session.bookings.size, 1);
  const checkout = [...session.checkouts.values()][0];
  const page = checkoutPage(readCheckout(session, checkout.token), 'en-US');
  assert.match(page, /No payment/);
  assert.doesNotMatch(page, /[\u3400-\u9fff]/);
});
test('English dates retain explicit year, inherited year and calendar validation without guessing ambiguous dates', () => {
  assert.equal(resolveDate('November 12, 2026', '2026-10-27').date, '2026-11-12');
  assert.equal(resolveDate('12 November 2026', '2026-10-27').yearSource, 'explicit');
  assert.equal(resolveDate('November 12', '2026-10-27', undefined, '2027').date, '2027-11-12');
  assert.equal(resolveDate('February 30, 2027', '2026-10-27').status, 'invalid');
  assert.equal(resolveDate('11/12', '2026-10-27').status, 'ambiguous');
  assert.equal(resolveDate('mid-November', '2026-10-27').status, 'approximate');
  assert.equal(resolveDate('next month on 12th', '2026-10-27').date, '2026-11-12');
  assert.equal(resolveDate('not November 12, 2026 but November 13, 2026', '2026-10-27').date, '2026-11-13');
  const session = createSession();
  const message = 'From Taoyuan to Narita, departing November 12, 2026 and returning November 16, 2026, two adults, economy.';
  applyUnderstanding(session, mockUnderstanding(session, message), Date.parse('2026-10-27T00:00:00Z'), message);
  assert.equal(session.trip.date, '2026-11-12');
  assert.equal(session.trip.returnDate, '2026-11-16');
  assert.equal(session.discovery.dateEvidence.returnDate.raw, 'November 16, 2026');
});
test('English evidence handles spoken day numbers and rejects negative airport/cabin guesses', async () => {
  const session = await englishSession();
  await say(session, 'Meetings on days two and three from 9 am to 5 pm at Tokyo Station.');
  assert.deepEqual(session.discovery.planning.meetings.map(block => block.day), [2, 3]);
  await say(session, 'On the fourth day visit Tokyo Station for shopping.');
  assert.equal(session.discovery.planning.activities[0].day, 4);
  assert.equal(session.trip.destination, 'NRT');
  await say(session, 'Not business class.');
  assert.equal(session.trip.cabin, 'economy');
  const exclusions = cityResolver.mentions('Narita or Haneda, not Haneda');
  assert.equal(exclusions.at(-1).excluded, true);
  const slots = mockUnderstanding(session, 'This is a business trip, not business class.');
  assert.equal(slots.cabinExpression, null);
});
test('English exploratory intent retains the actual agent reply while deterministic trip and price branches remain authoritative', () => {
  const session = createSession(); session.locale = 'en-US';
  const options = { route: { role: 'intent', reason: 'discover' }, work: { plan: false }, presentation: { flights: false },
    text: 'Internal Chinese fallback', intentReply: 'Would you prefer parks or a coastal day trip?', clarification: '' };
  assert.equal(englishResponseSections(session, options)[0].text, options.intentReply);
  const price = englishResponseSections(session, { ...options, route: { role: 'price', reason: 'price' } });
  assert.match(price[0].text, /All prices are synthetic/);
  assert.doesNotMatch(price[0].text, /coastal day trip/);
});
test('idempotency keys are language-bound without changing quote or journey versions', async () => {
  const session = await englishSession();
  const request = { message: 'Hello', requestId: randomUUID() };
  await chat(session, request, env);
  const version = session.contextVersion, trip = structuredClone(session.trip);
  session.locale = 'zh-TW';
  await assert.rejects(chat(session, request, env), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(session.contextVersion, version);
  assert.deepEqual(session.trip, trip);
});
test('language API is strict, session-isolated, busy-guarded and preserves quote, consent, history and version', async t => {
  const server = createApp(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${url}/api/bootstrap`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: url, 'content-type': 'application/json' };
  const post = (path, data) => fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  assert.equal((await initial.json()).locale, 'zh-TW');
  assert.equal((await post('/api/language', { locale: 'en-US', systemPrompt: 'x' })).status, 400);
  assert.equal((await post('/api/language', { locale: 'en-GB' })).status, 400);
  let response = await post('/api/language', { locale: 'en-US' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state.locale, 'en-US');
  response = await post('/api/chat', { message: 'Hello', locale: 'zh-TW' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /request language differs/);
  assert.equal((await (await post('/api/chat', { message: 'Hello', locale: 'en-US' })).json()).text,
    'Hello, I received your message. What would you like to plan today?');
  await post('/api/chat', { message: 'From Taoyuan to Narita on 2026-11-12 for 2 adults, economy. Search flights.', locale: 'en-US' });
  let state = (await (await fetch(`${url}/api/bootstrap`, { headers })).json()).state;
  assert.ok(state.offers.length);
  state = (await (await post('/api/chat', { message: 'Select flight 1', locale: 'en-US', offerIds: state.offers.map(offer => offer.id) })).json()).state;
  state = (await (await post('/api/chat', { message: 'Reprice', locale: 'en-US' })).json()).state;
  await post('/api/chat', { message: 'confirm current quote', locale: 'en-US', requestId: randomUUID(),
    quoteContext: { quoteId: state.quote.id, version: state.quote.version, total: state.quote.total,
      currency: state.quote.currency, expiresAt: state.quote.expiresAt } });
  const previous = await (await fetch(`${url}/api/bootstrap`, { headers })).json();
  assert.ok(previous.state.consent);
  const switched = await (await post('/api/language', { locale: 'zh-TW' })).json();
  const { locale: oldLocale, ...oldState } = previous.state, { locale: newLocale, ...newState } = switched.state;
  assert.equal(oldLocale, 'en-US'); assert.equal(newLocale, 'zh-TW'); assert.deepEqual(newState, oldState);
  const after = await (await fetch(`${url}/api/bootstrap`, { headers })).json();
  assert.deepEqual(after.history, previous.history);
  assert.equal((await (await fetch(`${url}/api/bootstrap`)).json()).locale, 'zh-TW');
  const pending = httpRequest(`${url}/api/chat`, { method: 'POST', headers });
  const pendingResponse = new Promise((resolve, reject) => {
    pending.on('response', response => { response.resume(); response.on('end', resolve); });
    pending.on('error', reject);
  });
  pending.write('{');
  try {
    let busy = false;
    for (let attempt = 0; attempt < 20 && !busy; attempt++) {
      busy = (await (await fetch(`${url}/api/bootstrap`, { headers })).json()).pending;
      if (!busy) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(busy, 'pending HTTP body holds the session lock');
    const rejected = await post('/api/language', { locale: 'en-US' });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, 'SESSION_BUSY');
  } finally { pending.end('}'); await pendingResponse; }
});
test('Foundry bilingual mapping is all-or-nothing and English cannot call unapproved Chinese versions', async () => {
  const endpoint = 'https://test.services.ai.azure.com/api/projects/test';
  const base = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: endpoint };
  for (const role of ['intent', 'planner', 'flight', 'price']) Object.assign(base,
    { [`FOUNDRY_${role.toUpperCase()}_AGENT`]: role, [`FOUNDRY_${role.toUpperCase()}_VERSION`]: '7' });
  const release = { projectEndpointSha256: createHash('sha256').update(endpoint).digest('hex'),
    agents: ['intent', 'planner', 'flight', 'price'].map(role => ({ role, name: role, from: '7', to: '8' })) };
  const approved = foundryConfig(base, null, release);
  assert.deepEqual(approved.locales, ['zh-TW', 'en-US']);
  assert.equal(approved.agents.intent.version, '8');
  const unapproved = foundryConfig(base, null, { ...release, projectEndpointSha256: '0'.repeat(64) });
  assert.deepEqual(unapproved.locales, ['zh-TW']);
  const session = createSession(); session.locale = 'en-US';
  await assert.rejects(invokeFoundry(unapproved, 'intent', session, {}, { credential: {
    getToken: () => { throw new Error('Unapproved language must not authenticate'); }
  } }), { code: 'FOUNDRY_LANGUAGE' });
  let payload;
  const text = await invokeFoundry(approved, 'planner', session, { correlationId: randomUUID(), locale: 'zh-TW' }, {
    credential: { getToken: async () => ({ token: 'test' }) },
    fetch: async (_url, request) => {
      payload = JSON.parse(request.body);
      return Response.json({ id: 'en-test', output: [{ type: 'message', content: [{ type: 'output_text', text: 'English suggestion.' }] }] });
    }
  });
  assert.equal(text, 'English suggestion.');
  const body = JSON.parse(payload.input[0].content);
  assert.equal(body.responseLocale, 'en-US'); assert.equal(body.context.locale, 'en-US');
  assert.doesNotMatch(body.task, /以繁體中文/);
  assert.equal(payload.instructions, undefined, 'agent_reference cannot accept per-request instructions');
});
