import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSession } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { turnWork } from '../lib/journey.js';

const now = Date.parse('2026-10-29T04:00:00Z');
const say = (session, message) => chat(session, { message, requestId: randomUUID(), delivery: 'text' },
  { APP_MODE: 'mock' }, { now });
const englishSession = () => {
  const session = createSession(now);
  session.locale = 'en-US';
  return session;
};

test('screenshot follow-ups progress from discovery to missing flight details and then itinerary suggestions', async () => {
  const session = englishSession();
  await say(session, 'I want to travel to Tokyo for 3 days');
  const search = await say(session, 'seach the flight , encomcy, 1 persion');
  assert.equal(search.state.activeAgent, 'flight');
  assert.equal(session.discovery.searchRequested, true);
  assert.equal(session.draft.cabin, 'economy');
  assert.equal(session.draft.travelers, 1);
  assert.equal(session.draft.date, undefined);
  assert.match(search.text, /Tokyo.*NRT.*HND.*Which do you prefer/);
  assert.doesNotMatch(search.text, /What experiences and pace/);
  assert.deepEqual(search.tools, []);
  const suggestions = await say(session, 'give me suggest');
  assert.equal(suggestions.state.activeAgent, 'planner');
  assert.match(suggestions.text, /Day 1/);
  assert.match(suggestions.text, /Day 3/);
  assert.equal(session.discovery.durationDays, 3);
  assert.equal(session.trip, null);
  assert.deepEqual(suggestions.tools, []);
  assert.equal(session.cloudRequests, 0);
  assert.equal(session.history.at(-4).text, 'seach the flight , encomcy, 1 persion');
});

test('pending flight search resumes only after explicit airports and date are supplied', async () => {
  const session = englishSession();
  await say(session, 'To Tokyo for 3 days');
  await say(session, 'seach the flight , encomcy, 1 persion');
  await say(session, 'From TPE');
  assert.equal(session.draft.destination, undefined, 'Tokyo must not silently become NRT');
  const airports = await say(session, 'NRT');
  assert.match(airports.text, /departure date.*year/);
  assert.deepEqual(airports.tools, []);
  const flights = await say(session, 'November 12, 2026');
  assert.equal(session.trip.origin, 'TPE');
  assert.equal(session.trip.destination, 'NRT');
  assert.equal(session.trip.date, '2026-11-12');
  assert.equal(flights.tools.filter(tool => tool.tool === 'search_flights').length, 1);
  assert.match(flights.text, /Synthetic flights/);
  assert.equal(session.bookings.size, 0);
});

test('a complete English route must not be consumed as the pending destination airport answer', async () => {
  const session = englishSession();
  await say(session, 'To Tokyo for 3 days');
  await say(session, 'seach the flight , encomcy, 1 persion');
  await say(session, 'give me suggest');
  const result = await say(session, 'Search flights from TPE to NRT on November 12, 2026');
  assert.equal(session.trip.origin, 'TPE');
  assert.equal(session.trip.destination, 'NRT');
  assert.equal(session.trip.originAirports, undefined);
  assert.equal(session.trip.destinationAirports, undefined);
  assert.equal(result.tools.filter(tool => tool.tool === 'search_flights').length, 1);
});

test('bounded spelling aliases preserve negative requirements, search pause and transaction guards', async () => {
  const session = englishSession();
  await say(session, 'From TPE to NRT on 2026-11-12, 1 person, business');
  await say(session, 'do not seach flights, not encomcy');
  assert.equal(session.trip.cabin, 'business');
  assert.equal(session.discovery.pendingWork.search, false);
  assert.equal(session.offers.size, 0);
  assert.equal(turnWork('give me suggest').plan, true);
  assert.equal(turnWork('give me recommendations').plan, true);
  for (const text of ['give me suggested payment', 'confirm current quote', 'buy suggested flight',
    'do not give me suggestions']) assert.equal(turnWork(text).plan, false, text);
  await assert.rejects(say(session, 'confirm'), { code: 'AMBIGUOUS_CONSENT' });
  assert.equal(session.bookings.size, 0);
});
