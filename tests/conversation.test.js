import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chat } from '../lib/agents.js';
import { createSession, callTool } from '../lib/core.js';
import { readAll } from './reply-helper.js';
import { enqueueReply, markQuote } from '../lib/replies.js';
const env = { APP_MODE: 'mock' };
const context = s => ({
  offerIds: [...s.offers.keys()],
  quoteContext: s.quote ? {
    quoteId: s.quote.id, version: s.quote.version, total: s.quote.total,
    currency: s.quote.currency, expiresAt: s.quote.expiresAt
  } : null
});
const say = async (s, message, extra = {}) => readAll(s, await chat(s, { message, requestId: randomUUID(), ...context(s), ...extra }, env));
test('greetings and audio checks bypass model work without changing trip, prices, or request idempotency', async () => {
  const s = await ready();
  const trip = structuredClone(s.trip), offers = [...s.offers.keys()];
  for (const text of ['你好', '你好你聽得到我說話嗎？', '你好，你聽得到我說話嗎？', '你聽得到我的聲音嗎？']) {
    const request = { message: text, requestId: randomUUID() };
    const result = await chat(s, request, { APP_MODE: 'foundry' }, {
      fetch: async () => { throw new Error('Greeting must not call a model'); }
    });
    assert.equal(result.text, '您好，我收到您的訊息了。今天想聊什麼呢？');
    assert.equal(result.state.activeAgent, 'intent');
    assert.deepEqual(result.tools, []);
    assert.deepEqual(s.trip, trip);
    assert.deepEqual([...s.offers.keys()], offers);
    assert.equal(s.history.at(-2).text, text);
    assert.deepEqual(await chat(s, request, { APP_MODE: 'foundry' }), result);
  }
});
async function ready() {
  const s = createSession();
  await say(s, '從桃園到成田，2026-11-12，2 人，經濟艙，搜尋航班，前後一天');
  return s;
}
test('chat gathers trip fields incrementally without business selection controls or silent defaults', async () => {
  const s = createSession();
  let r = await say(s, '從桃園到成田');
  assert.equal(s.trip, null); assert.equal(s.draft.origin, 'TPE'); assert.equal(s.draft.destination, 'NRT');
  assert.match(r.text, /哪一天出發/);
  await say(s, '2026-11-12，2 人');
  assert.equal(s.trip, null);
  r = await say(s, '經濟艙，預算 30000，少步行，規劃行程');
  assert.equal(s.trip.travelers, 2); assert.equal(s.trip.lowWalking, true);
  assert.match(r.text, /第 1 天/); assert.equal(s.trip.budget, 30000);
  await say(s, '改成 3 人，商務艙，不限制步行');
  assert.equal(s.trip.travelers, 3); assert.equal(s.trip.cabin, 'business'); assert.equal(s.trip.lowWalking, false);
  await assert.rejects(say(s, '改成 7 人'), { code: 'TRIP_INPUT', stage: 'journey.trip' });
  assert.equal(s.trip.travelers, 3, 'rejected update never partially changes the confirmed trip');
  r = await say(s, '去火星'); assert.match(r.text, /哪個城市/);
  assert.equal(s.trip, null); assert.equal(s.toolUnits, 0);
  r = await say(s, '11/12 出發'); assert.equal(s.draft.date, undefined);
});
test('conversational options select only current owned offers, reject old or ambiguous choices', async () => {
  const s = await ready(), old = context(s);
  const ids = [...s.offers.keys()];
  let r = await say(s, '選第二班');
  assert.equal(s.selected, ids[1]); assert.match(r.text, /已選第 2 班/);
  await assert.rejects(say(s, '選第九班'), { code: 'INVALID_SELECTION' });
  await say(s, '選第一班或第二班');
  assert.equal(s.selected, ids[1], 'ambiguous selection never executes');
  await say(s, '搜尋航班');
  await assert.rejects(say(s, '選第二班', old), { code: 'STALE_OPTIONS' });
  await say(s, '選第一班');
  s.offers.get(s.selected).expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(say(s, '選第一班'), { code: 'OFFER_EXPIRED' });
});
test('explicit chat consent binds displayed quote and retries produce exactly one receipt', async () => {
  const s = await ready();
  await say(s, '選第二班'); await say(s, '重新報價');
  const old = context(s), q = s.quote;
  assert.equal(s.bookings.size, 0);
  for (const text of ['確認', '同意', '不要確認目前報價', '確認目前報價，如果便宜一點']) {
    await assert.rejects(say(s, text), { code: 'AMBIGUOUS_CONSENT' });
    assert.equal(s.bookings.size, 0);
  }
  await assert.rejects(say(s, '確認目前報價', { quoteContext: null }), { code: 'QUOTE_CONTEXT_REQUIRED' });
  await callTool(s, 'price', 'reprice_offer', { offerId: s.selected }, { priceDelta: 500 });
  assert.equal(s.quote.total, q.total + 500); assert.equal(s.consent, null);
  enqueueReply(s, [{ text: `完整新報價 TWD ${s.quote.total}`, quoteKey: markQuote(s.quote) }]);
  await assert.rejects(say(s, '確認目前報價', old), { code: 'STALE_CONSENT' });
  const request = { message: '確認目前報價', requestId: randomUUID(), ...context(s) };
  const result = await chat(s, request, env);
  assert.match(result.text, /模擬識別碼：SIM-/); assert.equal(s.bookings.size, 1);
  const turns = s.turns;
  assert.deepEqual(await chat(s, request, env), result); assert.equal(s.turns, turns);
  await say(s, '確認目前報價');
  assert.equal(s.bookings.size, 1);
  await assert.rejects(chat(s, { ...request, message: '同意目前報價' }, env), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('expired quote, changed trip or changed selection cannot be confirmed with old chat context', async () => {
  const s = await ready();
  await say(s, '選第一班'); await say(s, '重新報價');
  s.quote.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(say(s, '確認目前報價'), { code: 'QUOTE_NOT_PRESENTED' });
  await say(s, '重新報價');
  const old = context(s);
  await say(s, '選第二班');
  await assert.rejects(say(s, '確認目前報價', old), { code: 'QUOTE_NOT_PRESENTED' });
  await say(s, '重新報價');
  const beforeChange = context(s);
  await say(s, '改成 3 人');
  await assert.rejects(say(s, '確認目前報價', beforeChange), { code: 'QUOTE_NOT_PRESENTED' });
  assert.equal(s.bookings.size, 0);
});
