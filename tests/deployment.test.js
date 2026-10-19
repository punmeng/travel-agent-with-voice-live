import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDefinitions, deployAgents } from '../scripts/deploy-agents.js';
import { entitlements } from '../lib/core.js';

const endpoint = 'https://example-resource.services.ai.azure.com/api/projects/example-project';
const manifest = JSON.parse(readFileSync(new URL('../data/generated/foundry-tools.json', import.meta.url)));
const definitions = buildDefinitions(manifest, 'gpt-5.4');
test('approved definitions bind GPT-5.4 and only backed role tools, no legacy sampling or transaction tool', () => {
  assert.equal(Object.keys(definitions).length, 4);
  for (const [role, { definition }] of Object.entries(definitions)) {
    assert.equal(definition.model, 'gpt-5.4');
    assert.deepEqual(definition.tools.map(t => t.name), entitlements[role]);
    assert.ok(definition.instructions.includes('繁體中文'));
    assert.ok(definition.instructions.includes('合成 mock'));
    assert.equal(definition.temperature, undefined); assert.equal(definition.top_p, undefined);
    for (const t of definition.tools) {
      assert.equal(t.strict, true); assert.equal(t.parameters.additionalProperties, false);
    }
  }
  assert.throws(() => buildDefinitions(manifest, 'new-unapproved-deployment'));
});
test('deployment verifies management definitions, reruns reuse matching versions and conflicts never overwrite', async () => {
  const stored = new Map(); let writes = 0;
  const fetcher = async (url, request) => {
    assert.ok(url.startsWith(endpoint));
    const path = new URL(url).pathname.split('/agents')[1];
    const name = path.split('/')[1];
    if (request.method === 'POST') {
      const body = JSON.parse(request.body); writes++;
      const result = { name: body.name, version: '1', definition: body.definition };
      stored.set(body.name, result);
      return Response.json(result);
    }
    const result = stored.get(name);
    if (!result) return Response.json({ error: { code: 'NotFound' } }, { status: 404 });
    return Response.json(path.includes('/versions/') ? result : { name, versions: { latest: result } });
  };
  await assert.rejects(deployAgents({ endpoint, approvedEndpoint: '', definitions, token: 'fake', fetcher }), /Unapproved/);
  await assert.rejects(deployAgents({ endpoint, approvedEndpoint: `${endpoint}-other`, definitions, token: 'fake', fetcher }), /Unapproved/);
  assert.equal(writes, 0);
  const result = await deployAgents({ endpoint, approvedEndpoint: endpoint, definitions, token: 'fake', fetcher });
  assert.equal(writes, 4); assert.equal(result.length, 4);
  const repeated = await deployAgents({ endpoint, approvedEndpoint: endpoint, definitions, token: 'fake', fetcher });
  assert.equal(writes, 4); assert.ok(repeated.every(r => !r.created));
  stored.get('meihao-flight-checker-agent').definition.instructions = 'unknown custom instruction';
  await assert.rejects(deployAgents({ endpoint, approvedEndpoint: endpoint, definitions, token: 'fake', fetcher }), /conflict/);
  assert.equal(writes, 4);
});
