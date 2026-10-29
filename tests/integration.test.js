import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../mcp.js';
import { createApp } from '../server.js';
import { createSession } from '../lib/core.js';
import { foundryConfig, invokeFoundry } from '../lib/foundry.js';

const search = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2, cabin: 'economy', flexibleDays: 0 };
test('MCP tools/list and strict contract share search, offer and reprice handlers', async () => {
  const server = createMcpServer(), client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['get_offer', 'list_airports', 'reprice_offer', 'resolve_city_airports', 'search_flights']);
    assert.equal(tools.find(t => t.name === 'search_flights').inputSchema.additionalProperties, false);
    const mapping = await client.callTool({ name: 'resolve_city_airports', arguments: { query: '臺北', countryCode: null } });
    const geography = JSON.parse(mapping.content[0].text);
    assert.equal(geography.data.status, 'matched');
    assert.deepEqual(geography.data.cities[0].airports.map(airport => airport.iata), ['TPE', 'TSA']);
    assert.equal(geography.data.routeEligibility, 'not-determined');
    assert.equal((await client.callTool({ name: 'resolve_city_airports',
      arguments: { query: 'Tokyo', countryCode: null, carrier: 'AE' } })).isError, true);
    const bad = await client.callTool({ name: 'search_flights', arguments: { ...search, price: 1 } });
    assert.equal(bad.isError, true);
    const r = await client.callTool({ name: 'search_flights', arguments: search });
    const output = JSON.parse(r.content[0].text);
    assert.equal(output.mock, true); assert.ok(output.correlationId);
    const offer = output.data.offers[0]; assert.ok(offer);
    const get = await client.callTool({ name: 'get_offer', arguments: { offerId: offer.id } });
    assert.equal(JSON.parse(get.content[0].text).data.id, offer.id);
    const quote = await client.callTool({ name: 'reprice_offer', arguments: { offerId: offer.id } });
    assert.equal(JSON.parse(quote.content[0].text).data.total, offer.total);
  } finally { await client.close(); await server.close(); }
});
test('MCP stdio entry point is runnable', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp.js'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const output = await client.callTool({ name: 'list_airports', arguments: {} });
    assert.ok(JSON.parse(output.content[0].text).data.airports.length >= 40);
  } finally { await client.close(); }
});
test('HTTP chat-only selection/reprice/confirmation, isolation and explicit errors', async () => {
  const server = createApp({ APP_MODE: 'mock' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/bootstrap`);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie); const initial = await response.json(); assert.equal(initial.voice.available, false);
    const rawPost = async (path, body, extra = {}) => fetch(`${base}/api/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base, ...extra }, body: JSON.stringify(body)
    });
    const post = async (path, body, extra = {}) => {
      const response = await rawPost(path, body, extra);
      if (path !== 'chat' || !response.ok) return response;
      const original = await response.json();
      assert.equal(original.state.moreReply, false);
      return new Response(JSON.stringify(original));
    };
    let r = await post('chat', { message: '從桃園到成田，2026-11-12，2 人，經濟艙，查詢航班' });
    assert.equal(r.status, 200);
    const result = await r.json(), offer = result.state.offers[0];
    assert.equal(result.state.activeAgent, 'flight');
    r = await post('chat', { message: '選第一班', offerIds: result.state.offers.map(o => o.id) }); assert.equal(r.status, 200);
    r = await post('chat', { message: '重新報價' }); const q = (await r.json()).state.quote;
    r = await post('chat', { message: '確認目前報價', requestId: crypto.randomUUID() }); assert.equal(r.status, 409);
    const purchaseArgs = { message: '確認目前報價', requestId: crypto.randomUUID(), quoteContext: { quoteId: q.id, version: q.version, total: q.total, currency: q.currency, expiresAt: q.expiresAt } };
    r = await post('chat', purchaseArgs);
    assert.equal(r.status, 200);
    const receipt = (await r.json()).receipt;
    assert.equal(receipt.status, 'SIMULATED_ONLY');
    r = await post('chat', purchaseArgs); assert.equal((await r.json()).receipt.id, receipt.id);
    const accepted = await (await post('chat', purchaseArgs)).json();
    const checkoutPath = accepted.text.match(/\/checkout\/[a-f0-9]{64}/)[0];
    let landing = await fetch(`${base}${checkoutPath}`, { headers: { cookie } });
    assert.equal(landing.status, 200);
    const checkoutHtml = await landing.text();
    assert.match(checkoutHtml, /模擬結帳 · 不收款/); assert.doesNotMatch(checkoutHtml, /<input|<form/);
    landing = await fetch(`${base}${checkoutPath}`); assert.equal(landing.status, 404);
    await post('chat', { message: '重新報價' });
    landing = await fetch(`${base}${checkoutPath}`, { headers: { cookie } }); assert.equal(landing.status, 409);
    r = await post('voice/session', {}); assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'VOICE_NOT_CONFIGURED');
    r = await post('chat', { message: 'hi' }, { origin: 'https://evil.invalid' }); assert.equal(r.status, 403);
    r = await post('chat', { message: 'hi', overridePrice: 1 }); assert.equal(r.status, 400);
    r = await fetch(`${base}/api/select`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ offerId: offer.id }) });
    assert.equal(r.status, 404);
    const html = await fetch(base); assert.match(html.headers.get('content-security-policy'), /sha256-/);
    assert.match(await html.text(), /語音對話/);
    const page = await (await fetch(base)).text();
    const speechOptions = page.match(/<fieldset id="speech-options"[^>]*>[\s\S]*?<\/fieldset>/)?.[0];
    assert.ok(speechOptions, 'SDK input settings must remain inside the voice fieldset');
    assert.deepEqual([...speechOptions.matchAll(/<select id="([^"]+)"/g)].map(match => match[1]),
      ['speech-stt', 'speech-source', 'speech-silence']);
    const chatOnlyPage = page.replace(speechOptions, '');
    assert.deepEqual([...chatOnlyPage.matchAll(/<select id="([^"]+)"/g)].map(match => match[1]),
      ['language', 'voice-mode'], 'only the existing language and voice settings may add selectors');
    assert.match(page, /<select id="voice-mode"/);
    assert.doesNotMatch(chatOnlyPage.replace(/<select\b[^>]*>[\s\S]*?<\/select>/g, ''), /<select|type="checkbox"|data-prompt|id="purchase"|class="card/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('Foundry transport uses configured agent reference; gated tool loop fails closed', async () => {
  const env = {
    APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: 'https://demo.services.ai.azure.com/api/projects/travel',
    FOUNDRY_INTENT_AGENT: 'intent', FOUNDRY_PLANNER_AGENT: 'planner',
    FOUNDRY_FLIGHT_AGENT: 'flight', FOUNDRY_PRICE_AGENT: 'price'
  };
  const config = foundryConfig(env);
  assert.equal(foundryConfig({ APP_MODE: 'mock' }), null);
  assert.throws(() => foundryConfig({ ...env, FOUNDRY_PROJECT_ENDPOINT: 'http://localhost/' }), { code: 'FOUNDRY_CONFIG' });
  const credential = { getToken: async scope => { assert.equal(scope, 'https://ai.azure.com/.default'); return { token: 'test-token' }; } };
  let calls = 0;
  const fetcher = async (url, request) => {
    assert.equal(url, `${config.endpoint}/openai/v1/responses`);
    const body = JSON.parse(request.body);
    assert.equal(body.agent_reference.name, 'flight'); assert.equal(body.max_output_tokens, 2500); calls++;
    return new Response(JSON.stringify(calls === 1 ? { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'list_airports', arguments: '{}' }] } :
      { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: '合成資料建議' }] }] }));
  };
  assert.equal(await invokeFoundry(config, 'flight', createSession(), { correlationId: 'corr' }, { credential, fetch: fetcher }), '合成資料建議');
  assert.equal(calls, 2);
  await assert.rejects(invokeFoundry(config, 'planner', createSession(), {}, { credential, fetch: async () =>
    new Response(JSON.stringify({ id: 'r', output: [{ type: 'function_call', call_id: 'c', name: 'reprice_offer', arguments: '{}' }] }))
  }), { code: 'TOOL_FORBIDDEN' });
  await assert.rejects(invokeFoundry(config, 'flight', createSession(), {}, { credential, fetch: async () =>
    new Response(JSON.stringify({ id: 'r', output: [{ type: 'function_call', call_id: 'c', name: 'search_flights', arguments: JSON.stringify(search) }] }))
  }), { code: 'OFF_TRIP_TOOL' });
  await assert.rejects(invokeFoundry(config, 'intent', createSession(), {}, { credential, fetch: async () => new Response('{}', { status: 503 }) }), { code: 'FOUNDRY_UPSTREAM' });
});
