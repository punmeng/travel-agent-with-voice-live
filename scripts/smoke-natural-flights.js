import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createSession } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { countWords } from '../lib/replies.js';
if (!process.argv.includes('--apply')) throw new Error('Requires --apply: six natural user turns, bounded live GPT and mock tools.');
const session = createSession(), turns = [];
const messages = [
  '好啊，你幫我規劃一下那個臺北到大阪的飛機，來回11月中左右。',
  '都可以。',
  '11月15號出發。',
  '我不是說了2026年11月20號回來嗎？',
  '2人。',
  '不要問我了，預設經濟艙，你給我時間先。'
];
for (const message of messages) {
  const result = await chat(session, { message }, process.env);
  assert.ok(countWords(result.text) <= 50);
  turns.push({ message, text: result.text, words: countWords(result.text), role: result.state.activeAgent });
  if (message.startsWith('11月15')) {
    assert.equal(session.draft.date, '2026-11-15');
    assert.doesNotMatch(result.text, /哪天出發|哪一天出發|需要確定一天/);
  }
  if (message.startsWith('我不是')) {
    assert.equal(session.draft.date, '2026-11-15');
    assert.equal(session.draft.returnDate, '2026-11-20');
    assert.doesNotMatch(result.text, /回程打算|哪一天出發/);
  }
}
const last = turns.at(-1);
assert.equal(session.trip.date, '2026-11-15'); assert.equal(session.trip.returnDate, '2026-11-20');
assert.deepEqual(session.trip.originAirports, ['TPE', 'TSA']);
assert.equal(session.trip.travelers, 2); assert.equal(session.trip.cabin, 'economy');
assert.ok(session.offers.size > 0); assert.equal(session.bookings.size, 0);
assert.match(last.text, /2026-11-15T\d\d:\d\d/);
assert.match(last.text, /2026-11-20T\d\d:\d\d/);
assert.doesNotMatch(last.text, /目前旅程|輸入「搜尋航班」/);
const report = { checkedAt: new Date().toISOString(), activeUserSessionTouched: false,
  turns, trip: session.trip, offerCount: session.offers.size, toolUnits: session.toolUnits,
  cloudRequests: session.cloudRequests, reportedTokens: session.cloudTokens, evidence: session.cloudEvidence };
await writeFile(new URL('../.foundry/natural-flight-flow-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, evidence: undefined }, null, 2));
