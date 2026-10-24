import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { countWords } from '../lib/replies.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: bounded paid GPT-5.4 smoke.');
const session = createSession(), turns = [];
for (const message of ['我想去日本玩幾天', '想賞楓，五天，帶媽媽，不要走太多路，東京好了，幫我安排五天']) {
  const result = await chat(session, { message }, process.env);
  assert.ok(result.text.trim());
  assert.equal(result.state.moreReply, false);
  turns.push({ message, text: result.text, words: countWords(result.text) });
}
assert.match(turns.at(-1).text, /第\s*5\s*天/);
assert.equal(session.discovery.country, '日本');
assert.equal(session.discovery.durationDays, 5);
assert.equal(session.draft.lowWalking, true);
assert.equal(session.toolUnits, 0);
const report = {
  checkedAt: new Date().toISOString(), model: 'gpt-5.4', completeReplies: true,
  convention: 'Intl.Segmenter word counts are diagnostic only; no paging or word cap.',
  cloudRequests: session.cloudRequests, totalTokens: session.cloudTokens, turns,
  evidence: session.cloudEvidence, humanMicrophoneTested: false
};
await writeFile(new URL('../.foundry/full-replies-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
const path = new URL('../.foundry/deployment.json', import.meta.url);
const deployment = JSON.parse(await readFile(path, 'utf8'));
deployment.fullRepliesVerified = true; deployment.fullReplySmokeReport = '.foundry/full-replies-smoke.json';
await writeFile(path, JSON.stringify(deployment, null, 2) + '\n');
console.log(JSON.stringify({ cloudRequests: report.cloudRequests, totalTokens: report.totalTokens, wordCounts: turns.map(t => t.words), text: turns.map(t => t.text) }, null, 2));
