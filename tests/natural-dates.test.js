import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnderstanding, mockUnderstanding, resolveDate, extractDateEvidence } from '../lib/conversation.js';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
const now = Date.parse('2026-10-16T08:00:00Z');
const today = '2026-10-16';

test('natural month-day expressions ground upcoming current-year dates and validate Chinese/calendar variants', () => {
  for (const expression of ['11月15號', '十一月十五號', '11月15日出發', '2026年11月15號', '二〇二六年十一月十五日']) {
    assert.equal(resolveDate(expression, today).date, '2026-11-15', expression);
  }
  assert.equal(resolveDate('2028年2月29日', today).date, '2028-02-29');
  assert.match(resolveDate('2027年2月29日', today).question, /有效的日曆/);
  assert.match(resolveDate('11月31日', today).question, /有效的日曆/);
  assert.match(resolveDate('9月15日', today).question, /哪一年/);
  assert.match(resolveDate('2025年11月15日', today).question, /哪一年/);
  assert.equal(resolveDate('11月中', today).date, null);
  assert.equal(resolveDate('下個月中', today).date, null);
  assert.equal(resolveDate('20號', today, '2026-11-15').date, '2026-11-20');
  assert.match(resolveDate('2號', today, '2026-11-28').question, /下個月/);
  assert.match(resolveDate('1月2號', today, '2026-12-28').question, /早於出發/);
  assert.equal(resolveDate('下個月15號', '2026-12-20').date, '2027-01-15');
  assert.equal(resolveDate('11月20號', today, undefined, '2027').date, '2027-11-20');
});

test('exact date advances conversation, approximate correction clears stale exact day and return grounding', async () => {
  const s = createSession();
  const say = message => chat(s, { message }, { APP_MODE: 'mock' }, { now });
  await say('從桃園到大阪，搜尋航班，11月中');
  let response = await say('11月15號出發');
  assert.equal(s.draft.date, '2026-11-15');
  assert.doesNotMatch(response.text, /需要確定一天|哪天出發|哪一天出發/);
  assert.match(response.text, /2026年11月15日/);
  response = await say('20號回來');
  assert.equal(s.draft.returnDate, '2026-11-20');
  assert.doesNotMatch(response.text, /哪一天出發/);
  await say('改成12月中');
  assert.equal(s.draft.date, undefined); assert.equal(s.draft.returnDate, undefined);
  assert.equal(s.discovery.datePreference, '12月中');
  assert.equal(s.quote, null);
  response = await say('12月15號');
  assert.equal(s.draft.date, '2026-12-15'); assert.equal(s.draft.returnDate, '2026-12-20');
  assert.doesNotMatch(response.text, /需要確定一天/);
});

test('invalid natural calendar date is a helpful clarification, not a backend schema error', () => {
  const s = createSession();
  const text = applyUnderstanding(s, mockUnderstanding(s, '2027年2月29日'), now);
  assert.match(text, /有效的日曆/);
  assert.equal(s.draft.date, undefined);
});
test('a return date supplied before other clarifications is retained and never asked again', async () => {
  const s = createSession();
  for (const message of ['從台北到大阪，來回，2026年11月15號出發，2026年11月20號回來，搜尋航班',
    '都可以', '2人', '預設經濟艙，給我時間先']) {
    const response = await chat(s, { message }, { APP_MODE: 'mock' }, { now });
    assert.doesNotMatch(response.text, /回程打算哪一天|需要確定一天/);
    assert.equal(s.draft.returnDate, '2026-11-20');
  }
  assert.equal(s.trip.date, '2026-11-15');
  assert.equal(s.trip.returnDate, '2026-11-20');
  assert.ok(s.offers.size > 0);
});
test('typed date evidence handles full travel clauses, Chinese suffixes and current-century short year', () => {
  const sentence = '2026年11月15號去2026年11月20號回來。';
  const dates = extractDateEvidence(sentence);
  assert.deepEqual(dates.map(({ raw, role }) => ({ raw, role })), [
    { raw: '2026年11月15號去', role: 'date' }, { raw: '2026年11月20號回來', role: 'returnDate' }
  ]);
  for (const text of ['十一月十五號去', '出發：2026 年 11 月 15 號去。', '26年11月15號出發。']) {
    assert.equal(resolveDate(text, today).date, '2026-11-15', text);
  }
  const shortYear = resolveDate('26年11月15號出發。', today);
  assert.equal(shortYear.yearSource, 'current-century-expansion');
  assert.equal(shortYear.assumedYear, true);
});
test('next natural reply repairs old rejected exact pending date and preserves exact state for unrelated unparsed span', () => {
  const s = createSession();
  s.draft = { origin: 'TPE', destination: 'KIX', travelers: 2, budget: null, lowWalking: false, flexibleDays: 0 };
  s.discovery.datePreference = '十一月十五號去';
  s.discovery.returnDatePreference = '2026年11月20號回來';
  s.discovery.roundTripRequested = true;
  applyUnderstanding(s, mockUnderstanding(s, '經濟艙'), now, '經濟艙');
  assert.equal(s.trip.date, '2026-11-15'); assert.equal(s.trip.returnDate, '2026-11-20');
  assert.equal(s.discovery.dateEvidence.date.raw, '十一月十五號去');
  assert.equal(s.discovery.dateEvidence.date.status, 'exact');
  assert.equal(s.discovery.dateEvidence.date.recovered, true);
  const slots = { ...mockUnderstanding(s, ''), dateExpression: '旅遊時間' };
  applyUnderstanding(s, slots, now, '旅遊時間');
  assert.equal(s.trip.date, '2026-11-15', 'unparsed irrelevant words cannot erase an exact date');
});
