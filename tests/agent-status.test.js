import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createAgentStatus } from '../public/agent-status.js';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { mockUnderstanding } from '../lib/conversation.js';
import { createApp } from '../server.js';

test('agent badge accepts only current-turn roles, completion cannot regress and stop removes stale progress', () => {
  const element = { textContent: '', dataset: {} }, badge = createAgentStatus(element);
  assert.equal(element.textContent, '等待對話');
  badge.start('first'); badge.update('first', 'intent');
  assert.equal(element.textContent, '意圖協調 · 處理中');
  badge.update('first', 'flight');
  assert.equal(element.textContent, '航班查詢 · 處理中');
  badge.start('second'); badge.update('first', 'price');
  assert.equal(element.textContent, '等待對話');
  for (const role of ['Voice Live', '__proto__', 'toString']) badge.update('second', role);
  assert.equal(element.textContent, '等待對話');
  badge.update('second', 'planner'); badge.update('second', 'planner', 'completed');
  badge.update('second', 'intent'); badge.unavailable('second');
  assert.equal(element.textContent, '旅遊規劃 · 已完成');
  badge.clear(); badge.update('second', 'price'); badge.unavailable('second');
  assert.equal(element.textContent, '等待對話');
});

test('actual chat emits real intent and specialist stages without extra model requests', async () => {
  for (const [message, specialist] of [['請搜尋航班', 'flight'], ['幫我規劃大阪行程', 'planner'], ['重新報價', 'price']]) {
    const stages = [];
    const s = createSession();
    const result = await chat(s, { message }, { APP_MODE: 'mock' }, { onProgress: role => stages.push(role) });
    assert.deepEqual(stages, ['intent', specialist]);
    assert.equal(result.state.activeAgent, specialist);
    assert.equal(s.cloudRequests, 0);
  }
});

test('read-only HTTP progress observes actual pending model stages, isolates sessions and clears errors', async () => {
  const env = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: 'https://demo.services.ai.azure.com/api/projects/demo',
    ...Object.fromEntries(['intent', 'planner', 'flight', 'price'].map(role => [`FOUNDRY_${role.toUpperCase()}_AGENT`, `demo-${role}`])) };
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const enteredIntent = deferred(), intent = deferred(), enteredFlight = deferred(), flight = deferred();
  const message = '從桃園到成田，2026年11月12日，2人，經濟艙，搜尋航班';
  let fail = false;
  const server = createApp(env, { chat: {
    credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async (_url, options) => {
      if (fail) throw new Error('private transport error');
      const isIntent = JSON.parse(options.body).agent_reference.name === 'demo-intent';
      (isIntent ? enteredIntent : enteredFlight).resolve();
      await (isIntent ? intent : flight).promise;
      return Response.json({ id: 'offline', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: isIntent ? JSON.stringify({
          role: 'flight', reply: '查詢示範航班。', slots: mockUnderstanding(createSession(), message)
        }) : '合成班次已整理。'
      }] }] });
    }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let pending;
  try {
    const boot = await fetch(`${origin}/api/bootstrap`);
    const cookie = boot.headers.get('set-cookie').split(';')[0];
    const requestId = randomUUID();
    const progress = async (id = requestId, headers = { cookie }) => (await (await fetch(
      `${origin}/api/progress?requestId=${id}`, { headers })).json()).progress;
    const send = id => fetch(`${origin}/api/chat`, { method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ message, requestId: id }) });
    pending = send(requestId);
    await enteredIntent.promise;
    assert.deepEqual(await progress(), { requestId, role: 'intent', status: 'processing' });
    assert.equal(await progress(randomUUID()), null);
    assert.equal(await progress(requestId, {}), null);
    intent.resolve(); await enteredFlight.promise;
    assert.deepEqual(await progress(), { requestId, role: 'flight', status: 'processing' });
    flight.resolve();
    const response = await pending; assert.equal(response.status, 200);
    assert.equal((await response.json()).state.activeAgent, 'flight');
    assert.deepEqual(await progress(), { requestId, role: 'flight', status: 'completed' });
    assert.equal((await fetch(`${origin}/api/progress?requestId=invalid`, { headers: { cookie } })).status, 400);
    fail = true;
    assert.equal((await send(randomUUID())).status, 502);
    assert.equal(await progress(), null);
  } finally {
    intent.resolve(); flight.resolve(); await pending;
    server.closeAllConnections(); server.close();
  }
});
