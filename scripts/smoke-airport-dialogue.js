import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { countWords } from '../lib/replies.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: three bounded paid GPT-5.4 dialogue turns.');
const session = createSession();
session.draft = { destination: 'NRT', travelers: 2, cabin: 'economy', budget: 50000, lowWalking: true, flexibleDays: 0 };
session.discovery.country = '日本';
session.discovery.destinationCity = '東京';
session.discovery.companions = '帶媽媽';
session.discovery.durationDays = 5;
const turns = [];
for (const message of ['從台北出發，幫我找航班', '都可以。', '我說都可以，台北桃園或松山都可以。']) {
  let result = await chat(session, { message }, process.env);
  let text = '';
  do {
    assert.ok(countWords(result.text) <= 50);
    turns.push({ message: text ? '繼續' : message, text: result.text, words: countWords(result.text) });
    text += result.text;
    if (!result.state.moreReply) break;
    result = await chat(session, { message: '繼續' }, process.env);
  } while (true);
  if (message.startsWith('從')) {
    assert.match(text, /桃園機場或松山機場/);
    assert.equal(session.discovery.airportQuestion.key, 'origin');
  } else {
    assert.deepEqual(session.draft.originAirports, ['TPE', 'TSA']);
    assert.equal(session.discovery.originCity, '台北');
    assert.doesNotMatch(text, /哪個城市出發|偏好哪一座|無法確定|其他已聊過/);
    assert.match(text, /哪一天出發/);
  }
}
assert.equal(session.toolUnits, 0);
assert.equal(session.discovery.companions, '帶媽媽');
assert.equal(session.draft.lowWalking, true);
assert.equal(session.cloudRequests, 3);
const report = { checkedAt: new Date().toISOString(), model: 'gpt-5.4', cloudRequests: session.cloudRequests,
  totalTokens: session.cloudTokens, turns, acceptedOriginAirports: session.draft.originAirports,
  toolUnits: session.toolUnits, evidence: session.cloudEvidence, activeUserSessionTouched: false };
await writeFile(new URL('../.foundry/airport-dialogue-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, evidence: undefined }, null, 2));
