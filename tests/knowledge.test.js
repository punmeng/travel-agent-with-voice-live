import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from '../scripts/prepare-knowledge.js';
import { createSession } from '../lib/core.js';
import { invokeFoundry } from '../lib/foundry.js';
import { buildKnowledgeDefinition, updatedKnowledgeEnv } from '../scripts/ingest-knowledge.js';

test('knowledge attachment preserves instructions/functions and local mock configuration', () => {
  const base = { kind: 'prompt', model: 'gpt-5.4', instructions: '原始角色指令', tools: [{ type: 'function', name: 'get_offer', strict: true, parameters: { type: 'object', additionalProperties: false } }] };
  const definition = buildKnowledgeDefinition(base, 'vs-test');
  assert.equal(definition.model, base.model);
  assert.ok(definition.instructions.startsWith(base.instructions));
  assert.match(definition.instructions, /不可信資料/);
  assert.match(definition.instructions, /靜態合成票價可以作知識解釋/);
  assert.deepEqual(definition.tools.slice(0, -1), base.tools);
  assert.deepEqual(definition.tools.at(-1), { type: 'file_search', vector_store_ids: ['vs-test'], max_num_results: 5 });
  assert.equal(base.tools.length, 1);
  assert.throws(() => buildKnowledgeDefinition(definition, 'other'), /merge decision/);
  const original = '# preserve me\r\nAPP_MODE=mock\r\nFOUNDRY_INTENT_VERSION=1\r\nCUSTOM=value\r\n';
  const updated = updatedKnowledgeEnv(original, { intent: { version: '2' } });
  assert.equal(updated, original.replace('VERSION=1', 'VERSION=2'));
  assert.throws(() => updatedKnowledgeEnv(original.replace('mock', 'foundry'), {}), /Expected mock/);
});

test('knowledge snapshot contains every original record exactly, with role partitioning and content hashes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/knowledge/manifest.json', import.meta.url)));
  const load = name => JSON.parse(readFileSync(new URL(`../data/generated/${name}.json`, import.meta.url))).records;
  const originalFlights = load('flights'), originalFares = load('fares');
  const extracted = {};
  for (const file of manifest.files) {
    const content = readFileSync(new URL(`../data/knowledge/${file.filename}`, import.meta.url), 'utf8');
    assert.equal(sha256(content), file.sha256);
    assert.equal(Buffer.byteLength(content), file.bytes);
    assert.match(content, /SYNTHETIC MOCK ONLY/);
    assert.match(content, /No airline schedule, operated-route or availability data was used/);
    assert.ok(file.bytes < 10 * 1024 * 1024);
    const records = content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.equal(records.length, file.records);
    (extracted[file.kind] ??= []).push(...records);
  }
  assert.deepEqual(extracted.flight, originalFlights);
  const flightMap = new Map(originalFlights.map(f => [f.id, f]));
  assert.deepEqual(extracted.fare.map(({ flightReference, ...fare }) => {
    const { id, cabins, ...context } = flightMap.get(fare.flightId);
    assert.deepEqual(flightReference, context);
    return fare;
  }), originalFares);
  const geo = extracted['airports-routes'];
  assert.equal(geo.filter(r => r.recordType === 'airport-geographic-reference').length, load('airports').length);
  assert.equal(geo.filter(r => r.recordType === 'synthetic-route').length, load('routes').length);
  assert.equal(manifest.truncated, false);
  assert.equal(manifest.roles.intent.length, 1);
  assert.equal(manifest.roles.planner.length, 3);
  assert.equal(manifest.roles.flight.length, 8);
  assert.equal(manifest.roles.price.length, Math.ceil(originalFares.length / 8000) + 2);
});

test('server-side file search output and citations do not become local tools or transaction authority', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/knowledge/manifest.json', import.meta.url)));
  const firstFareFile = manifest.files.find(file => file.kind === 'fare').filename;
  const session = createSession();
  const config = { endpoint: 'https://example.services.ai.azure.com/api/projects/test', agents: { price: { name: 'price', version: '2' } } };
  const credential = { getToken: async () => ({ token: 'offline' }) };
  const response = output => async () => new Response(JSON.stringify({ id: 'r', status: 'completed', output }));
  const output = [
    { type: 'file_search_call', id: 'fs1', status: 'completed', queries: ['mock fare'], results: [] },
    { type: 'message', content: [{ type: 'output_text', text: '合成票價參考，不是可售報價。', annotations: [
      { type: 'file_citation', file_id: 'file1', filename: firstFareFile, index: 0 }
    ] }] }
  ];
  const text = await invokeFoundry(config, 'price', session, {}, { credential, fetch: response(output) });
  assert.ok(text.includes(`知識來源（合成示範靜態快照）：${firstFareFile}`));
  assert.equal(session.selectedOfferId, undefined);
  assert.equal(session.quote, null);
  await assert.rejects(invokeFoundry(config, 'price', session, {}, { credential, fetch: response([
    { type: 'file_search_call', status: 'failed' }, ...output.slice(1)
  ]) }), { code: 'FOUNDRY_KNOWLEDGE' });
  await assert.rejects(invokeFoundry(config, 'price', session, {}, { credential, fetch: response([
    { type: 'function_call', call_id: 'c', name: 'file_search', arguments: '{}' }
  ]) }), { code: 'TOOL_FORBIDDEN' });
});
