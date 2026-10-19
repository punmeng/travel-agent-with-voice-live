import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { countWords, paginateReply } from '../lib/replies.js';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { readAll } from './reply-helper.js';
const env = { APP_MODE: 'mock' };
const request = (s, message) => ({
  message, requestId: randomUUID(), offerIds: [...s.offers.keys()],
  quoteContext: s.quote ? { quoteId: s.quote.id, version: s.quote.version, total: s.quote.total, currency: s.quote.currency, expiresAt: s.quote.expiresAt } : null
});
test('meaningful Chinese/English/mixed word counting preserves every unit, identifiers, amounts and links', () => {
  assert.ok(countWords('我想帶媽媽去日本玩五天') > 5);
  assert.equal(countWords('one two three'), 3);
  assert.equal(countWords('TWD 12,345'), 1);
  assert.equal(countWords('2026-11-12T08:30:00.000Z'), 1);
  const link = '/checkout/' + 'a'.repeat(64);
  for (const text of [
    '想帶媽媽去東京賞楓，少步行，多休息。'.repeat(50),
    'A gentle five day itinerary for Tokyo with your mother. '.repeat(30),
    `第1天東京 Tokyo；總額 TWD 12,345；報價 ${randomUUID()}；有效至 2026-11-12T08:30:00.000Z。 ${link} `.repeat(20)
  ]) {
    const pages = paginateReply(text);
    assert.ok(pages.length > 1);
    assert.equal(pages.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
    for (const page of pages) assert.ok(countWords(page) <= 50);
    for (const page of pages.filter(p => p.includes('/checkout/'))) assert.ok(page.includes(link));
    assert.equal(pages.reduce((n, p) => n + (p.match(/TWD 12,345/g)?.length ?? 0), 0), text.match(/TWD 12,345/g)?.length ?? 0);
  }
});
test('all assistant turns are <=50 words; five-day plan/flight/quote are progressive with no premature acceptance', async () => {
  const s = createSession(), captured = [];
  async function say(message) {
    const response = await chat(s, request(s, message), env);
    assert.ok(countWords(response.text) <= 50, `${countWords(response.text)}: ${response.text}`);
    assert.equal(response.foundryText, null);
    captured.push(response);
    return response;
  }
  await say('我想去日本玩幾天');
  await say('五天，帶媽媽，不要走太多路');
  let r = await say('東京好了，幫我安排五天');
  assert.equal(r.itinerary.days.length, 5);
  while (s.replyPages.length) await say('繼續');
  assert.match(captured.map(r => r.text).join('\n'), /第 5 天/);
  r = await say('從桃園到成田，2026-11-12出發，2026-11-16回程，2人，經濟艙，搜尋航班');
  await assert.rejects(chat(s, request(s, '選第二班'), env), { code: 'OPTION_NOT_PRESENTED' });
  while (!s.presentedOffers.has([...s.offers.keys()][1])) await say('繼續');
  await say('選第二班');
  r = await say('重新報價');
  assert.equal(r.state.quote, null);
  await assert.rejects(chat(s, request(s, '確認目前報價'), env), { code: 'QUOTE_NOT_PRESENTED' });
  assert.ok(s.replyPages.length, 'rejected premature consent preserves pending quote pages');
  let shown = '';
  while (s.replyPages.length) { r = await say('繼續'); shown += r.text; }
  assert.match(shown, /模擬確認價：TWD/);
  assert.match(shown, /不收款、不訂位、不開票/);
  assert.equal(r.state.quote.id, s.quote.id);
  const accepted = await say('確認目前報價');
  let linkText = accepted.text;
  while (s.replyPages.length) linkText += (await say('繼續')).text;
  assert.match(linkText, /\/checkout\/[a-f0-9]{64}/);
  assert.equal(s.bookings.size, 1);
  assert.equal(s.cloudRequests, 0);
});
test('oversized live understanding and planning are paginated without extra model calls or silent mock content', async () => {
  const s = createSession();
  const env = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: 'https://demo.services.ai.azure.com/api/projects/test',
    FOUNDRY_INTENT_AGENT: 'intent', FOUNDRY_PLANNER_AGENT: 'planner', FOUNDRY_FLIGHT_AGENT: 'flight', FOUNDRY_PRICE_AGENT: 'price' };
  let calls = 0;
  const slots = Object.fromEntries(['originPlace', 'destinationPlace', 'country', 'dateExpression', 'travelerExpression', 'cabinExpression', 'budgetExpression', 'walkingExpression', 'durationExpression', 'interestExpression', 'companionExpression', 'returnDateExpression', 'flexibleExpression', 'timeExpression'].map(k => [k, null]));
  slots.durationExpression = '五天'; slots.destinationPlace = '東京';
  const text = [1, 2, 3, 4, 5].map(n => `第${n}天：東京慢遊，多休息，交通及無障礙待核驗。`).join('\n');
  const dependencies = {
    credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async (_url, request) => {
      calls++;
      const role = JSON.parse(request.body).agent_reference.name;
      return new Response(JSON.stringify({ id: 'r' + calls, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: role === 'intent' ? JSON.stringify({ role: 'planner', reply: '好呀，我們來規劃五天。', slots }) : text }] }] }));
    }
  };
  const result = await chat(s, { message: '東京五天，幫我安排' }, env, dependencies);
  assert.ok(countWords(result.text) <= 50);
  const combined = await readAll(s, result, env);
  assert.match(combined.text, /第5天/);
  assert.equal(calls, 2, 'continuation never invokes a model');
});
