import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AzureCliCredential } from '@azure/identity';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { readCheckout } from '../lib/checkout.js';

if (!process.argv.includes('--apply')) throw new Error('--apply required: this executes authorized paid GPT-5.4 inference and file search.');
const env = { ...process.env, APP_MODE: 'foundry' };
const session = createSession();
const credential = new AzureCliCredential();
const report = { startedAt: new Date().toISOString(), model: 'gpt-5.4', syntheticTravelData: true, realPayment: false, steps: [] };
const reportPath = new URL('../.foundry/live-smoke.json', import.meta.url);
async function say(message) {
  const q = session.quote;
  const result = await chat(session, {
    message, requestId: randomUUID(), offerIds: [...session.offers.keys()],
    quoteContext: q ? { quoteId: q.id, version: q.version, total: q.total, currency: q.currency, expiresAt: q.expiresAt } : null
  }, env, { credential });
  assert.ok(result.text.trim());
  assert.equal(result.state.moreReply, false);
  report.steps.push({ message, text: result.text, agent: result.state.activeAgent, discovery: result.state.discovery,
    draft: result.state.draft, offers: result.state.offers.length, quoteTotal: result.state.quote?.total ?? null });
  Object.assign(report, { cloudRequests: session.cloudRequests, cloudTokens: session.cloudTokens, evidence: session.cloudEvidence });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ step: report.steps.length, message, text: result.text.slice(0, 700), offers: result.state.offers.length, requests: session.cloudRequests, tokens: session.cloudTokens }));
  return result;
}
try {
  await say('我想去日本玩幾天');
  assert.equal(session.discovery.country, '日本'); assert.equal(session.toolUnits, 0);
  await say('想賞楓，不要走太多路，下個月中，五天，帶媽媽');
  assert.equal(session.draft.date, undefined); assert.equal(session.discovery.durationDays, 5);
  assert.equal(session.draft.travelers, undefined); assert.equal(session.toolUnits, 0);
  const plan = await say('那東京好了，幫我安排五天');
  assert.equal(plan.itinerary.days.length, 5); assert.equal(session.draft.lowWalking, true);
  assert.equal(session.discovery.companions, '帶媽媽');
  assert.match(plan.text, /(?:第\s*5\s*天|Day\s*5|第五天)/i);
  const search = await say('從桃園出發，到成田機場，2026年11月12日出發，2026年11月16日回程，我們兩位成人，經濟艙，早去晚回，幫我找機票');
  assert.ok(search.state.offers.length > 1);
  assert.ok(search.state.offers.every(o => o.returnFlight));
  await say('選第二班');
  await say('幫我看看現在這個票價，準備結帳');
  assert.ok(session.quote);
  const result = await say('我同意這個報價，請給我模擬結帳連結');
  assert.match(result.text, /\/checkout\/[a-f0-9]{64}/);
  const checkout = [...session.checkouts.values()][0];
  readCheckout(session, checkout.token);
  assert.ok(session.cloudEvidence.some(e => e.fileSearchCalls > 0), 'Actual built-in knowledge retrieval must be observed');
  report.status = 'passed'; report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const deploymentPath = new URL('../.foundry/deployment.json', import.meta.url);
  const deployment = JSON.parse(readFileSync(deploymentPath));
  deployment.inferenceTested = true; deployment.smokeReport = '.foundry/live-smoke.json';
  deployment.appMode = process.env.APP_MODE;
  writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, requests: session.cloudRequests, tokens: session.cloudTokens, fileSearchCalls: session.cloudEvidence.reduce((n, e) => n + e.fileSearchCalls, 0) }));
} catch (error) {
  Object.assign(report, { cloudRequests: session.cloudRequests, cloudTokens: session.cloudTokens, evidence: session.cloudEvidence });
  report.status = 'failed'; report.error = { code: error.code ?? error.name, message: error.message };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  throw error;
}
