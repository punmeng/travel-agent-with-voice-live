import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { countWords } from '../lib/replies.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: bounded paid flight-knowledge retrieval.');
const s = createSession(), turns = [];
let r = await chat(s, { message: '介紹台北到東京的合成航班時刻資料' }, process.env);
do {
  assert.ok(countWords(r.text) <= 50);
  turns.push({ text: r.text, words: countWords(r.text) });
  if (!r.state.moreReply) break;
  r = await chat(s, { message: '繼續' }, process.env);
} while (turns.length < 20);
assert.ok(!r.state.moreReply);
assert.equal(s.toolUnits, 0);
assert.equal(s.quote, null);
assert.ok(s.cloudEvidence.some(e => e.role === 'flight' && e.fileSearchCalls > 0));
const report = { checkedAt: new Date().toISOString(), cloudRequests: s.cloudRequests, totalTokens: s.cloudTokens,
  toolUnits: s.toolUnits, turns, evidence: s.cloudEvidence, currentSnapshot: 'synthetic-demo hypothetical demo, not verified operated routes' };
await writeFile(new URL('../.foundry/flight-knowledge-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
