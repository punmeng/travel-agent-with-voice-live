import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { createSession } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { seedMemberOrigin, memberOriginPrompt } from '../lib/member-origin.js';

const env = { APP_MODE: 'mock' }, now = Date.parse('2026-10-29T04:00:00Z');
const memberSession = (id = 'alex-taipei', locale = 'en-US') => {
  const session = createSession(now);
  session.memberId = id; session.locale = locale;
  seedMemberOrigin(session);
  return session;
};
const say = (session, message, extra = {}) => chat(session, { message, requestId: randomUUID(), ...extra }, env, { now });

test('all catalog cities are pending suggestions, never authoritative departure airports', () => {
  for (const [id, city] of [['alex-taipei', 'Taipei'], ['tomo-tokyo', 'Tokyo'], ['ohsung-seoul', 'Seoul'],
    ['adam-sydney', 'Sydney'], ['felix-singapore', 'Singapore']]) {
    const session = memberSession(id);
    assert.equal(session.originSuggestion.city, city);
    assert.equal(session.originSuggestion.status, 'pending');
    assert.equal(session.draft.origin, undefined);
    assert.equal(session.trip, null);
    assert.match(memberOriginPrompt(session), new RegExp(city));
  }
  const guest = createSession(); seedMemberOrigin(guest);
  assert.equal(guest.originSuggestion, null);
});

test('search cannot use an unconfirmed profile origin and repeats the explicit confirmation prompt', async () => {
  const session = memberSession('ohsung-seoul');
  const result = await say(session, 'Search flights to TPE on 2026-11-12 for 1 adult in economy');
  assert.equal(result.state.originSuggestion.status, 'pending');
  assert.equal(result.state.trip, null);
  assert.equal(result.tools.some(tool => tool.tool === 'search_flights'), false);
  assert.match(result.text, /Your demo profile city is Seoul/);
  assert.equal(session.cloudRequests, 0);
});

test('confirming a single-airport city applies that city without searching or overriding other choices', async () => {
  const session = memberSession('ohsung-seoul');
  session.draft.cabin = 'economy';
  const request = { message: 'Confirm departure city', requestId: randomUUID(), contextVersion: session.contextVersion,
    originConfirmation: { id: session.originSuggestion.id, action: 'confirm' } };
  const result = await chat(session, request, env, { now });
  assert.equal(result.state.originSuggestion.status, 'confirmed');
  assert.equal(result.state.draft.origin, 'ICN');
  assert.equal(result.state.draft.cabin, 'economy');
  assert.equal(result.tools.length, 0);
  assert.equal(session.cloudRequests, 0);
  assert.match(result.text, /Departure city confirmed: Seoul/);
  assert.equal(await chat(session, request, env, { now }), result, 'repeat button request must be idempotent');
});

test('confirmed Taipei city still requires airport choice; yes does not choose TPE silently', async () => {
  const session = memberSession();
  const result = await say(session, 'yes');
  assert.equal(result.state.originSuggestion.status, 'confirmed');
  assert.equal(result.state.draft.origin, undefined);
  assert.deepEqual(result.state.discovery.originAirportChoice.candidates, ['TPE', 'TSA']);
  assert.deepEqual(result.state.discovery.originAirportChoice.accepted, []);
  assert.match(result.text, /TPE \/ TSA/);
  assert.equal(result.tools.length, 0);
});

test('changing or explicitly specifying a departure overrides profile suggestion and never updates the catalog', async () => {
  const declined = memberSession();
  await say(declined, 'Change departure city', { contextVersion: 0,
    originConfirmation: { id: declined.originSuggestion.id, action: 'change' } });
  assert.equal(declined.originSuggestion.status, 'declined');
  assert.equal(declined.draft.origin, undefined);
  assert.equal(memberOriginPrompt(declined), null);
  const explicit = memberSession();
  await say(explicit, 'From KHH to NRT on 2026-11-12 for 1 adult in economy, search flights');
  assert.equal(explicit.trip.origin, 'KHH');
  assert.equal(explicit.originSuggestion.status, 'overridden');
  assert.equal(memberSession().originSuggestion.city, 'Taipei');
});

test('stale tokens, missing versions, unknown properties and guest origin confirmations fail before any model call', async () => {
  const session = memberSession(), id = session.originSuggestion.id;
  await assert.rejects(say(session, 'Confirm departure city', { originConfirmation: { id, action: 'confirm' } }), { code: 'ORIGIN_CONTEXT_REQUIRED' });
  await assert.rejects(say(session, 'Confirm departure city', { contextVersion: 0,
    originConfirmation: { id: randomUUID(), action: 'confirm' } }), { code: 'ORIGIN_SUGGESTION_STALE' });
  await assert.rejects(say(session, 'Confirm departure city', { contextVersion: 1,
    originConfirmation: { id, action: 'confirm' } }), { code: 'STALE_JOURNEY' });
  await assert.rejects(say(session, 'Confirm departure city', { contextVersion: 0,
    originConfirmation: { id, action: 'confirm', city: 'Sydney' } }), error => error.name === 'ZodError');
  await assert.rejects(say(createSession(), 'Confirm departure city', { contextVersion: 0,
    originConfirmation: { id, action: 'confirm' } }), { code: 'ORIGIN_SUGGESTION_STALE' });
  assert.equal(session.originSuggestion.status, 'pending');
  assert.equal(session.cloudRequests, 0);
});

test('explicit structured trip wins over a generic yes and conflicting confirmation commands are rejected', async () => {
  const trip = { origin: 'KHH', destination: 'NRT', date: '2026-11-12', travelers: 1,
    cabin: 'economy', flexibleDays: 0, budget: null, lowWalking: false };
  const conflicting = memberSession();
  await assert.rejects(say(conflicting, 'yes', { trip, contextVersion: 0,
    originConfirmation: { id: conflicting.originSuggestion.id, action: 'confirm' } }),
  { code: 'ORIGIN_CONFIRMATION_CONFLICT' });
  assert.equal(conflicting.originSuggestion.status, 'pending');
  const explicit = memberSession();
  await say(explicit, 'yes', { trip });
  assert.equal(explicit.trip.origin, 'KHH');
  assert.equal(explicit.originSuggestion.status, 'overridden');
});

test('login, logout, reset and account switches keep suggestions isolated and regenerate confirmation tokens', async t => {
  const server = createApp(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const request = async (path, body) => {
    const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    assert.equal(response.status, 200);
    return response.json();
  };
  const login = email => request('member/login', { email, password: 'MeihaoDemo!2026', confirmReset: true });
  const first = await login('alex.taipei@example.test');
  assert.equal(first.state.originSuggestion.city, 'Taipei');
  assert.ok(first.originPrompt);
  const id = first.state.originSuggestion.id;
  const reset = await request('reset', {});
  assert.equal(reset.state.originSuggestion.status, 'pending');
  assert.notEqual(reset.state.originSuggestion.id, id);
  const second = await login('tomo.tokyo@example.test');
  assert.equal(second.state.originSuggestion.city, 'Tokyo');
  assert.notEqual(second.state.originSuggestion.id, id);
  const logout = await request('member/logout', { confirmReset: true });
  assert.equal(logout.state.originSuggestion, null);
  const bootstrap = await request('bootstrap');
  assert.equal(bootstrap.originPrompt, null);
});
