import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { createSession, callTool, publicState, setTrip } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { applyUnderstanding, mockUnderstanding } from '../lib/conversation.js';
import { foundryVoiceAgentDefinition } from '../lib/voice-agent.js';
import { authenticateMember, createLoginRateLimiter, memberAgentPreferences, memberDefaults,
  memberProfile, memberRankingContext, memberRankingSummary, rankMemberOffers } from '../lib/members.js';
import { invokeFoundry } from '../lib/foundry.js';

const demoPassword = 'MeihaoDemo!2026';
const accounts = [
  ['alex.taipei@example.test', 'Alex', 'business'],
  ['tomo.tokyo@example.test', 'Tomo', 'family'],
  ['ohsung.seoul@example.test', 'Ohsung', 'value'],
  ['adam.sydney@example.test', 'Adam', 'premium'],
  ['felix.singapore@example.test', 'Felix', 'business']
];

test('demo member credentials are salted hashes and catalogs resolve without exposing identities to agent context', async () => {
  for (const [email, name] of accounts) assert.equal((await authenticateMember(email, demoPassword))?.displayName, name);
  assert.equal(await authenticateMember(accounts[0][0], 'WrongPassword!'), null);
  assert.equal(await authenticateMember('nobody@example.test', demoPassword), null);
  const member = (await authenticateMember('felix.singapore@example.test', demoPassword));
  const preferences = memberAgentPreferences(member.id, 'en-US');
  assert.deepEqual(Object.keys(preferences).sort(), ['corporateAdvisoryOnly', 'corporateGuidance', 'persona',
    'preferredCabin', 'softPreferences', 'unsupportedRequests'].sort());
  assert.equal(preferences.corporateAdvisoryOnly, true);
  assert.match(preferences.corporateGuidance.join(' '), /No company approval/);
  assert.equal(JSON.stringify(preferences).includes(member.email), false);
  assert.deepEqual(memberDefaults('adam-sydney'), { cabin: 'business' });
  assert.equal(memberProfile('adam-sydney', 'zh-TW').preferredCabinLabel, '商務艙');
  assert.equal(memberProfile('adam-sydney', 'en-US').preferredCabinLabel, 'Business');
  assert.equal(memberProfile('unknown'), null);
  for (const [email, , persona] of accounts) {
    const member = await authenticateMember(email, demoPassword);
    for (const locale of ['zh-TW', 'en-US']) {
      const projection = memberProfile(member.id, locale);
      assert.deepEqual(projection.softPreferences, memberAgentPreferences(member.id, locale).softPreferences);
      assert.ok(projection.preferenceSummary.length >= 1 && projection.preferenceSummary.length <= 3);
      assert.equal(projection.personaId, persona);
      assert.equal(Object.keys(projection).some(key => /salt|hash|password|unsupportedRequests|corporateGuidance/.test(key)), false);
    }
  }
  assert.equal(memberProfile('alex-taipei').preferredCabin, null);
  assert.match(memberProfile('alex-taipei', 'en-US').softPreferences.join(' '), /daytime departures/);
});

test('ranking evidence is emitted only after actual multi-offer ranking and bound to member, trip, meeting blocks and offer IDs', async () => {
  const session = createSession();
  session.memberId = 'alex-taipei';
  const trip = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 1,
    cabin: 'economy', budget: null, lowWalking: false, flexibleDays: 0 };
  setTrip(session, trip);
  await callTool(session, 'flight', 'search_flights', { origin: 'TPE', destination: 'NRT', date: trip.date,
    travelers: 1, cabin: 'economy', flexibleDays: 0 });
  assert.equal(publicState(session).memberRanking, null, 'raw search alone is not member ranking');
  const ranked = rankMemberOffers(session.memberId, [...session.offers.values()], session.trip);
  session.offers = new Map(ranked.offers.map(offer => [offer.id, offer]));
  session.memberRanking = { memberId: session.memberId, reason: ranked.reason, meetingAware: ranked.meetingAware,
    context: memberRankingContext(session), offerIds: ranked.offers.map(offer => offer.id) };
  const summary = publicState(session).memberRanking;
  assert.equal(summary.reason, 'business');
  assert.equal(summary.meetingAware, false);
  assert.deepEqual(Object.keys(summary).sort(), ['meetingAware', 'message', 'offerIds', 'reason']);
  session.discovery.planning = { meetings: [{ day: 1, start: '14:00', end: '15:00', location: 'Tokyo', evidence: 'Day 1 meeting in Tokyo 14:00–15:00' }] };
  assert.equal(memberRankingSummary(session), null, 'new meeting context invalidates old note');
  delete session.discovery.planning;
  session.memberId = 'tomo-tokyo';
  assert.equal(memberRankingSummary(session), null);
  session.memberId = 'alex-taipei';
  session.offers.delete(summary.offerIds[0]);
  assert.equal(memberRankingSummary(session), null);
  assert.equal(rankMemberOffers('unknown', ranked.offers, trip).reason, null);
  assert.equal(rankMemberOffers('alex-taipei', [ranked.offers[0]], trip).reason, null);
});

test('actual member chat exposes applied ranking even if order stays the same and clears it on new searches', async () => {
  const session = createSession();
  session.memberId = 'alex-taipei';
  const result = await chat(session, { message: '從桃園到成田，2026-11-12，1 人，經濟艙，搜尋航班' },
    { APP_MODE: 'mock' }, { memberAware: true });
  assert.equal(result.state.memberRanking.reason, 'business');
  assert.equal(result.state.memberRanking.meetingAware, false);
  assert.equal(result.state.trip.cabin, 'economy');
  assert.equal(result.state.memberRanking.offerIds.length, result.state.offers.length);
  assert.ok(result.text.includes(result.state.memberRanking.message));
  const offers = [...session.offers.values()];
  assert.deepEqual(rankMemberOffers(session.memberId, offers, session.trip).offers.map(o => o.id), offers.map(o => o.id));
  session.discovery.planning = { meetings: [{ day: 1, start: '14:00', end: '15:00', location: 'Tokyo', evidence: 'Day 1 meeting in Tokyo 14:00–15:00' }] };
  const meeting = rankMemberOffers(session.memberId, offers, session.trip, session.discovery.planning);
  assert.equal(meeting.meetingAware, true);
  assert.equal(rankMemberOffers('tomo-tokyo', offers, session.trip, session.discovery.planning).meetingAware, false);
  const withMeeting = await chat(session, { message: '搜尋航班' }, { APP_MODE: 'mock' }, { memberAware: true });
  assert.equal(withMeeting.state.memberRanking.meetingAware, true);
  assert.match(withMeeting.state.memberRanking.message, /已保存的會議時段比較/);
  await callTool(session, 'flight', 'search_flights', { origin: 'TPE', destination: 'NRT',
    date: '2026-11-12', travelers: 1, cabin: 'economy', flexibleDays: 0 });
  assert.equal(publicState(session).memberRanking, null, 'unranked new offers cannot inherit previous applied status');
  setTrip(session, { ...session.trip, date: '2026-11-13' });
  assert.equal(publicState(session).memberRanking, null);
});

test('authenticated HTTP searches apply trusted preferences and logout/reset remove applied evidence', async t => {
  const app = await createTestApp(t);
  const response = await app.post('member/login', { email: accounts[0][0], password: demoPassword });
  let cookie = response.headers.get('set-cookie').split(';')[0];
  const result = await (await app.post('chat', {
    message: '從桃園到成田，2026-11-12，1 人，經濟艙，搜尋航班'
  }, cookie)).json();
  assert.equal(result.state.memberRanking.reason, 'business');
  assert.equal(result.state.memberRanking.meetingAware, false);
  const reset = await app.post('reset', {}, cookie);
  cookie = reset.headers.get('set-cookie').split(';')[0];
  const resetData = await reset.json();
  assert.equal(resetData.member.displayName, 'Alex');
  assert.equal(resetData.state.memberRanking, null);
  const logout = await app.post('member/logout', {}, cookie);
  const logoutData = await logout.json();
  assert.equal(logoutData.member, null);
  assert.equal(logoutData.state.memberRanking, null);
});

test('member ranking gives value, family, and premium distinct deterministic orderings', () => {
  const offers = [
    { id: 'late-cheap', total: 8500, flight: { departureLocal: '2026-11-12T23:40', arrivalLocal: '2026-11-13T03:40', durationMinutes: 180 } },
    { id: 'evening', total: 9000, flight: { departureLocal: '2026-11-12T18:30', arrivalLocal: '2026-11-12T23:30', durationMinutes: 300 } },
    { id: 'morning', total: 10000, flight: { departureLocal: '2026-11-12T08:30', arrivalLocal: '2026-11-12T12:30', durationMinutes: 180 } },
    { id: 'next-morning', total: 11000, flight: { departureLocal: '2026-11-13T08:30', arrivalLocal: '2026-11-13T12:30', durationMinutes: 180 } }
  ];
  const trip = { date: '2026-11-12' };
  const ids = id => rankMemberOffers(id, offers, trip).offers.map(offer => offer.id);
  assert.equal(ids('ohsung-seoul')[0], 'late-cheap');
  assert.equal(ids('tomo-tokyo')[0], 'evening');
  assert.equal(ids('adam-sydney')[0], 'morning');
  assert.notDeepEqual(ids('ohsung-seoul'), ids('tomo-tokyo'));
  assert.notDeepEqual(ids('tomo-tokyo'), ids('adam-sydney'));
});

test('explicit current-trip cabin overrides a premium member soft default', () => {
  const session = createSession();
  session.memberId = 'adam-sydney';
  session.draft = memberDefaults(session.memberId);
  const message = '桃園到成田2027/11/12兩人經濟艙';
  const slots = { ...mockUnderstanding(session, ''), originPlace: '桃園', destinationPlace: '成田',
    dateExpression: '2027-11-12', travelerExpression: '兩人', cabinExpression: '經濟艙' };
  applyUnderstanding(session, slots, Date.parse('2026-10-27T00:00:00Z'), message);
  assert.equal(session.trip.cabin, 'economy');
});

test('login limiter blocks repeated failures and expires them after its window', () => {
  let now = 1000;
  const limiter = createLoginRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.blocked('127.0.0.1'), false);
  limiter.recordFailure('127.0.0.1');
  limiter.recordFailure('127.0.0.1');
  assert.equal(limiter.blocked('127.0.0.1'), true);
  now += 1001;
  assert.equal(limiter.blocked('127.0.0.1'), false);
});

test('member preferences reach only server-authorized non-transaction Foundry roles', async () => {
  const preferences = memberAgentPreferences('tomo-tokyo', 'en-US');
  const session = { locale: 'en-US', cloudRequests: 0, cloudTokens: 0, cloudEvidence: [] };
  const config = { endpoint: 'https://demo.services.ai.azure.com/api/projects/demo',
    locales: ['zh-TW', 'en-US'],
    agents: { flight: { agent_name: 'flight', version: '1' }, price: { agent_name: 'price', version: '1' } } };
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `response-${calls.length}`, status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready.' }] }] }), { status: 200 });
  };
  const dependencies = { memberPreferences: preferences, credential: { getToken: async () => ({ token: 'test-token' }) }, fetch };
  await invokeFoundry(config, 'flight', session, { correlationId: 'flight', task: 'Search.' }, dependencies);
  await invokeFoundry(config, 'price', session, { correlationId: 'price', task: 'Quote.' }, dependencies);
  assert.equal(calls[0].input[0].content.includes('family'), true);
  assert.equal(calls[1].input[0].content.includes('memberPreferences'), false);
});

test('managed Voice Agent contract is bilingual-safe and delegates only to the backend function', () => {
  const definition = foundryVoiceAgentDefinition();
  assert.equal(definition.model, 'gpt-realtime-2.1');
  assert.equal(definition.store, false);
  assert.deepEqual(definition.tools.map(tool => tool.name), ['travel_backend']);
  assert.deepEqual(definition.tool_choice, { type: 'function', name: 'travel_backend' });
  assert.match(definition.instructions, /zh-TW|繁體中文/);
  assert.doesNotMatch(JSON.stringify(definition), /web_search|member directory|corporate approval/i);
});

async function createTestApp(t, env = { APP_MODE: 'mock' }) {
  const server = createApp(env);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const post = (path, body, sessionCookie = cookie) => fetch(`${origin}/api/${path}`, {
    method: 'POST', headers: { origin, cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { origin, cookie, post };
}

test('member login requires confirmation before clearing a journey and rotates identity sessions', async t => {
  const app = await createTestApp(t);
  const chat = await app.post('chat', { message: 'hello' });
  assert.equal(chat.status, 200);
  const denied = await app.post('member/login', { email: accounts[0][0], password: demoPassword });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, 'MEMBER_CONFIRMATION_REQUIRED');
  const wrong = await app.post('member/login', { email: accounts[0][0], password: 'WrongPassword!', confirmReset: true });
  assert.equal(wrong.status, 401);
  assert.equal((await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie: app.cookie } })).json()).history.length, 2);
  const response = await app.post('member/login', { email: accounts[0][0], password: demoPassword, confirmReset: true });
  assert.equal(response.status, 200);
  const data = await response.json();
  const nextCookie = response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(nextCookie, app.cookie);
  assert.equal(data.member.displayName, 'Alex');
  assert.deepEqual(data.history, []);
  const recoveredOld = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie: app.cookie } })).json();
  assert.equal(recoveredOld.member, null);
  assert.deepEqual(recoveredOld.history, []);
  const current = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie: nextCookie } })).json();
  assert.equal(current.member.id, 'alex-taipei');
});

test('account changes and logout isolate histories; new-trip reset preserves the authenticated member', async t => {
  const app = await createTestApp(t);
  let login = await app.post('member/login', { email: accounts[0][0], password: demoPassword });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  await app.post('chat', { message: 'hello' }, cookie);
  let blocked = await app.post('member/login', { email: accounts[1][0], password: demoPassword }, cookie);
  assert.equal(blocked.status, 409);
  login = await app.post('member/login', { email: accounts[1][0], password: demoPassword, confirmReset: true }, cookie);
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await login.json()).member.id, 'tomo-tokyo');
  assert.deepEqual((await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie } })).json()).history, []);

  const reset = await app.post('reset', {}, cookie);
  assert.equal(reset.status, 200);
  cookie = reset.headers.get('set-cookie').split(';')[0];
  let boot = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(boot.member.id, 'tomo-tokyo');
  assert.deepEqual(boot.history, []);
  await app.post('chat', { message: 'hello' }, cookie);
  const logoutBlocked = await app.post('member/logout', {}, cookie);
  assert.equal(logoutBlocked.status, 409);
  const logout = await app.post('member/logout', { confirmReset: true }, cookie);
  assert.equal(logout.status, 200);
  cookie = logout.headers.get('set-cookie').split(';')[0];
  boot = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(boot.member, null);
  assert.deepEqual(boot.history, []);
});

test('each browser session resolves only its own authenticated member', async t => {
  const app = await createTestApp(t);
  const secondBoot = await fetch(`${app.origin}/api/bootstrap`);
  const secondCookie = secondBoot.headers.get('set-cookie').split(';')[0];
  const firstLogin = await app.post('member/login', { email: accounts[0][0], password: demoPassword });
  const firstCookie = firstLogin.headers.get('set-cookie').split(';')[0];
  const secondLogin = await app.post('member/login', { email: accounts[1][0], password: demoPassword }, secondCookie);
  const secondMemberCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const first = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie: firstCookie } })).json();
  const second = await (await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie: secondMemberCookie } })).json();
  assert.equal(first.member.id, 'alex-taipei');
  assert.equal(second.member.id, 'tomo-tokyo');
});

test('managed-voice tickets issued before login cannot authorize the rotated member session', async t => {
  const env = {
    APP_MODE: 'mock',
    FOUNDRY_PROJECT_ENDPOINT: 'https://demo.services.ai.azure.com/api/projects/demo',
    FOUNDRY_VOICE_AGENT_NAME: 'meihao-travel-intent-voice',
    FOUNDRY_VOICE_AGENT_VERSION: '3',
    FOUNDRY_AUTH_MODE: 'azure-cli'
  };
  const app = await createTestApp(t, env);
  const ticketResponse = await app.post('voice/session', { mode: 'foundry-voice-agent', locale: 'zh-TW' });
  assert.equal(ticketResponse.status, 200);
  const ticket = await ticketResponse.json();
  const login = await app.post('member/login', { email: accounts[0][0], password: demoPassword }, app.cookie);
  assert.equal(login.status, 200);
  const socket = new WebSocket(app.origin.replace('http:', 'ws:') + ticket.path,
    [ticket.protocol, ticket.nonce], { headers: { origin: app.origin, cookie: app.cookie } });
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket rejection timed out')), 3000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(status, 403);
});
