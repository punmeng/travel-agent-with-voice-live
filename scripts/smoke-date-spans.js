import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { AzureCliCredential } from '@azure/identity';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { countWords } from '../lib/replies.js';
if (!process.argv.includes('--apply')) throw new Error('Requires --apply: at most three paid current-agent understanding calls.');
const deadline = setTimeout(() => { console.error('DATE_SPAN_SMOKE_DEADLINE'); process.exit(1); }, 100000);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90000);
try {
  const credential = new AzureCliCredential({ processTimeoutInMs: 10000 });
  const token = await credential.getToken('https://ai.azure.com/.default');
  const spans = [], turns = [];
  const session = createSession();
  session.draft = { origin: 'TPE', destination: 'KIX', travelers: 2, budget: null, lowWalking: false, flexibleDays: 0 };
  session.discovery.searchRequested = true;
  session.discovery.datePreference = '十一月十五號去';
  session.discovery.roundTripRequested = true;
  const fetcher = async (url, options) => {
    const response = await fetch(url, options);
    if (!response.ok) return response;
    const data = await response.clone().json();
    for (const output of data.output ?? []) for (const content of output.content ?? []) {
      if (content.type !== 'output_text') continue;
      const understanding = JSON.parse(content.text);
      spans.push({ role: understanding.role, dateExpression: understanding.slots.dateExpression,
        returnDateExpression: understanding.slots.returnDateExpression });
    }
    return response;
  };
  for (const message of ['十一月十五號去。', '2026年11月15號去2026年11月20號回來。', '26年11月15號出發。']) {
    const result = await chat(session, { message }, process.env, {
      credential: { getToken: async () => token }, fetch: fetcher, signal: controller.signal
    });
    assert.equal(session.draft.date, '2026-11-15');
    if (turns.length) assert.equal(session.draft.returnDate, '2026-11-20');
    assert.doesNotMatch(result.text, /哪天出發|哪一天出發|需要確定一天/);
    assert.ok(result.text.trim());
    assert.equal(result.state.moreReply, false);
    turns.push({ message, reply: result.text, words: countWords(result.text),
      date: session.draft.date, returnDate: session.draft.returnDate,
      dateEvidence: session.discovery.dateEvidence });
  }
  assert.equal(session.cloudRequests, 3);
  assert.equal(session.toolUnits, 0);
  const report = { checkedAt: new Date().toISOString(), activeUserSessionTouched: false,
    intentVersion: process.env.FOUNDRY_INTENT_VERSION, spans, turns,
    cloudRequests: session.cloudRequests, reportedTokens: session.cloudTokens };
  await writeFile(new URL('../.foundry/date-spans-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code, type: error.name, stage: error.stage,
    causeCode: error.cause?.code, message: error.code ? error.message : 'Bounded date-span smoke failed; no retry.' }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); clearTimeout(timeout); }
