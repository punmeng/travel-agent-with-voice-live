import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaitingNotice, WAITING_MESSAGE } from '../public/waiting.js';
import { MAX_TURNS, MAX_CLOUD_REQUESTS, MAX_CLOUD_TOKENS } from '../lib/limits.js';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { mockUnderstanding } from '../lib/conversation.js';

function fakeClock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    setTimeout(fn, ms) { const key = ++id; tasks.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { tasks.delete(key); },
    tick(ms) { now += ms; for (const [key, task] of tasks) if (task.at <= now) { tasks.delete(key); task.fn(); } }
  };
}
test('15-second waiting notice is neutral, generation-bound and cleared on finish, failure, retry and stop', () => {
  const clock = fakeClock(), shown = [];
  const waiting = createWaitingNotice((visible, text) => shown.push({ visible, text }), clock);
  waiting.start(); clock.tick(14999);
  assert.equal(shown.at(-1).visible, false);
  waiting.clear(); clock.tick(1);
  assert.equal(shown.at(-1).visible, false);
  waiting.start(); clock.tick(15000);
  assert.deepEqual(shown.at(-1), { visible: true, text: WAITING_MESSAGE });
  waiting.clear(); assert.equal(shown.at(-1).visible, false);
  waiting.start(); clock.tick(12000); waiting.start(); clock.tick(3000);
  assert.equal(shown.at(-1).visible, false, 'old request cannot update new request');
  clock.tick(12000); assert.equal(shown.at(-1).visible, true);
  waiting.clear(); clock.tick(60000); assert.equal(shown.at(-1).visible, false);
});

const env = { APP_MODE: 'foundry', FOUNDRY_AUTH_MODE: 'azure-cli',
  FOUNDRY_PROJECT_ENDPOINT: 'https://test.services.ai.azure.com/api/projects/test',
  ...Object.fromEntries(['intent', 'planner', 'flight', 'price'].flatMap(role => [
    [`FOUNDRY_${role.toUpperCase()}_AGENT`, `test-${role}`], [`FOUNDRY_${role.toUpperCase()}_VERSION`, '1']
  ])) };
test('100 completed user turns are feasible above old cloud/token limits; failed work is not a completed turn', async () => {
  const s = createSession();
  const dependencies = { credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async () => Response.json({ id: 'offline', status: 'completed', usage: { total_tokens: 5000 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        role: 'intent', reply: '好的，想聊哪個旅行主題？', slots: mockUnderstanding(s, '')
      }) }] }] }) };
  for (let i = 0; i < MAX_TURNS; i++) await chat(s, { message: '您好' }, env, dependencies);
  assert.equal(s.turns, 100); assert.equal(s.cloudRequests, 100); assert.equal(s.cloudTokens, 500000);
  assert.ok(MAX_CLOUD_REQUESTS >= MAX_TURNS * 6);
  assert.ok(MAX_CLOUD_TOKENS >= MAX_TURNS * 24000);
  await assert.rejects(chat(s, { message: '您好' }, env, dependencies), { code: 'TURN_LIMIT' });
  const failed = createSession();
  await assert.rejects(chat(failed, { message: '您好' }, env, { ...dependencies,
    fetch: async () => new Response('{}', { status: 503 }) }), { code: 'FOUNDRY_UPSTREAM' });
  assert.equal(failed.turns, 0); assert.equal(failed.cloudRequests, 1);
});

test('flight informational Q&A uses file_search without booking prerequisites or authority changes', async () => {
  const s = createSession(), called = [];
  const r = await chat(s, { message: '介紹台北到東京的合成航班時刻資料' }, env, {
    credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body); called.push(body);
      const intent = body.agent_reference.name === 'test-intent';
      return Response.json({ id: 'offline', status: 'completed', output: [
        ...(!intent ? [{ type: 'file_search_call', status: 'completed' }] : []),
        { type: 'message', content: [{ type: 'output_text', text: intent ? JSON.stringify({
          role: 'flight', reply: '請問日期？', slots: mockUnderstanding(s, '')
        }) : 'DEMO合成快照可介紹航線，但不是真實營運證明或即時機位。' }] }
      ] });
    }
  });
  assert.deepEqual(called.at(-1).tool_choice, { type: 'file_search' });
  assert.match(r.text, /DEMO合成快照/);
  assert.doesNotMatch(r.text, /請問日期/);
  assert.equal(s.trip, null); assert.equal(s.toolUnits, 0);
  assert.equal(s.quote, null); assert.equal(s.cloudEvidence.at(-1).fileSearchCalls, 1);
});
