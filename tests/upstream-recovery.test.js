import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invokeFoundry } from '../lib/foundry.js';
import { chat } from '../lib/agents.js';
import { mockUnderstanding } from '../lib/conversation.js';
import { createSession } from '../lib/core.js';
import { voiceFailureDetails } from '../lib/voice.js';

const config = { endpoint: 'https://demo.services.ai.azure.com/api/projects/demo',
  agents: { intent: { name: 'demo-intent', version: '1' } }, authMode: 'azure-cli' };
const credential = { getToken: async () => ({ token: 'offline' }) };
const env = { APP_MODE: 'foundry', FOUNDRY_AUTH_MODE: 'azure-cli', FOUNDRY_PROJECT_ENDPOINT: config.endpoint,
  ...Object.fromEntries(['intent', 'planner', 'flight', 'price'].map(role => [`FOUNDRY_${role.toUpperCase()}_AGENT`, `demo-${role}`])) };

test('Foundry errors identify auth, timeout, transport and response decoding without exposing payloads', async () => {
  const cases = [
    ['FOUNDRY_AUTH', 'auth', { credential: { getToken: async () => { throw new Error('private auth payload'); } } }],
    ['FOUNDRY_TIMEOUT', 'responses.fetch', { fetch: async () => { throw new DOMException('private timeout', 'TimeoutError'); } }],
    ['FOUNDRY_CONNECTION', 'responses.fetch', { fetch: async () => { throw new TypeError('private endpoint'); } }],
    ['FOUNDRY_RESPONSE', 'responses.decode', { fetch: async () => new Response('private invalid JSON') }],
    ['FOUNDRY_RESPONSE', 'responses.decode', { fetch: async () => Response.json({ private: 'invalid schema' }) }]
  ];
  for (const [code, stage, dependencies] of cases) {
    const s = createSession();
    await assert.rejects(invokeFoundry(config, 'intent', s, { correlationId: 'test' }, { credential, ...dependencies }), error => {
      assert.equal(error.code, code); assert.equal(error.stage, stage);
      assert.ok(error.cause); assert.ok(error.elapsedMs >= 0);
      assert.doesNotMatch(error.message, /private/);
      const diagnostic = voiceFailureDetails(error, 125);
      assert.equal(diagnostic.stage, stage); assert.equal(diagnostic.elapsedMs, 125);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private|invalid JSON|endpoint|payload/);
      return true;
    });
    assert.equal(s.turns, 0);
  }
  assert.equal(voiceFailureDetails({ cause: { code: 'token-or-user-text' } }, 0).causeCode, undefined);
  assert.equal(voiceFailureDetails({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 0).causeCode, 'UND_ERR_CONNECT_TIMEOUT');
});

test('planning a roundtrip flight does not become an invented three-day itinerary even if model routes to planner', async () => {
  const s = createSession();
  const message = '好啊，你幫我規劃一下那個臺北到大阪的飛機，來回10月中左右。';
  let currentMessage = message;
  const dependencies = { credential, now: Date.parse('2026-10-16T08:00:00Z'),
    fetch: async () => Response.json({ id: 'offline', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        role: 'planner', reply: '我幫您安排三日行程。',
        slots: currentMessage === message ? { ...mockUnderstanding(s, ''),
          originPlace: '臺北', destinationPlace: '大阪', dateExpression: '10月中左右' } :
          { ...mockUnderstanding(s, ''), originPlace: '都可以' }
      }) }] }] }) };
  const first = await chat(s, { message }, env, dependencies);
  assert.match(first.text, /桃園機場或松山機場/);
  assert.doesNotMatch(first.text, /第 1 天|三日/);
  assert.equal(s.draft.date, undefined); assert.equal(s.trip, null);
  assert.equal(s.discovery.datePreference, '10月中左右');
  currentMessage = '都可以';
  const next = await chat(s, { message: currentMessage }, env, dependencies);
  assert.match(next.text, /10月中左右.*哪天出發/);
  assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
  assert.equal(s.toolUnits, 0); assert.equal(s.quote, null);
});
test('persistent flight-time task advances every answered slot, grounds return reminder and searches without magic commands', async () => {
  const s = createSession();
  let current = '';
  const dependencies = { credential, now: Date.parse('2026-10-16T08:00:00Z'),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      const slots = mockUnderstanding(s, current);
      if (current.startsWith('臺北')) Object.assign(slots, { originPlace: '臺北', destinationPlace: '大阪', dateExpression: '11月中' });
      if (current.startsWith('我不是')) Object.assign(slots, { dateExpression: '2026年11月20號', returnDateExpression: null });
      return Response.json({ id: 'offline', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: body.agent_reference.name === 'demo-intent' ?
          JSON.stringify({ role: 'intent', reply: '請輸入搜尋航班。', slots }) : '合成候選應以工具為準。'
      }] }] });
    } };
  const say = async message => { current = message; return chat(s, { message }, env, dependencies); };
  await say('臺北到大阪的飛機，來回11月中');
  await say('都可以');
  await say('11月15號出發');
  assert.equal(s.discovery.followUpQuestion.field, 'returnDate');
  await say('我不是說了2026年11月20號嗎？');
  assert.equal(s.draft.date, '2026-11-15');
  assert.equal(s.draft.returnDate, '2026-11-20');
  const people = await say('2人');
  assert.doesNotMatch(people.text, /回程打算|哪天出發|搜尋航班/);
  const result = await say('不要問我了，預設經濟艙，你給我時間先。');
  assert.equal(s.trip.cabin, 'economy');
  assert.equal(s.trip.travelers, 2);
  assert.ok(s.toolUnits > 0);
  assert.ok(result.state.offers.length > 0);
  assert.ok(result.state.offers.every(o => o.returnFlight));
  assert.doesNotMatch(result.text, /目前旅程|輸入「搜尋航班」|請輸入搜尋航班/);
  assert.equal(s.bookings.size, 0);
});
test('actual model span suffixes and both dates in one clause recover a stuck journey without repeated departure question', async () => {
  const s = createSession();
  s.draft = { origin: 'TPE', destination: 'KIX', travelers: 2, budget: null, lowWalking: false, flexibleDays: 0 };
  s.discovery.searchRequested = true;
  s.discovery.datePreference = '十一月十五號去';
  const statements = [
    ['2026年11月15號去2026年11月20號回來。', '2026年11月15號去', '2026年11月20號回來'],
    ['26年11月15號出發。', '26年11月15號出發', null],
    ['十一月十五號去。', '十一月十五號去', null]
  ];
  for (const [message, departure, returned] of statements) {
    const result = await chat(s, { message }, env, {
      credential, now: Date.parse('2026-10-18T08:00:00Z'),
      fetch: async () => Response.json({ id: 'offline', status: 'completed', output: [{
        type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          role: 'intent', reply: '您想哪一天出發？',
          slots: { ...mockUnderstanding(s, ''), dateExpression: departure, returnDateExpression: returned }
        }) }]
      }] })
    });
    assert.equal(s.draft.date, '2026-11-15');
    assert.equal(s.draft.returnDate, '2026-11-20');
    assert.equal(s.discovery.dateEvidence.date.status, 'exact');
    assert.equal(s.discovery.dateEvidence.date.raw, departure);
    assert.doesNotMatch(result.text, /哪天出發|哪一天出發|需要確定一天/);
    assert.match(result.text, /艙/);
    assert.equal(s.toolUnits, 0);
  }
});
