import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureVoiceAgent } from '../scripts/create-voice-agent.js';
import { foundryVoiceAgentDefinition } from '../lib/voice-agent.js';

function agentRecord(definition = foundryVoiceAgentDefinition()) {
  return { name: 'meihao-travel-voice', version: '3', versions: { latest: { version: '3' } }, definition };
}

function clientWith(existing) {
  let record = existing;
  const calls = [];
  return {
    calls,
    agents: {
      async get(name) {
        calls.push(['get', name]);
        if (!record) throw Object.assign(new Error('not found'), { statusCode: 404 });
        return record;
      },
      async create(name, definition) {
        calls.push(['create', name]);
        record = agentRecord(definition);
        return record;
      },
      async getVersion(name, version) {
        calls.push(['getVersion', name, version]);
        return record && { name: record.name, version: record.version, definition: record.definition };
      },
      async enable(name) { calls.push(['enable', name]); }
    }
  };
}

test('voice-agent creator enables only an existing exact contract match', async () => {
  const client = clientWith(agentRecord());
  const result = await ensureVoiceAgent(client, 'meihao-travel-voice');
  assert.deepEqual(result, {
    name: 'meihao-travel-voice', version: '3', model: 'gpt-realtime-2.1',
    created: false, enabled: true, inferenceTested: false
  });
  assert.equal(client.calls.filter(([method]) => method === 'create').length, 0);
  assert.deepEqual(client.calls.at(-1), ['enable', 'meihao-travel-voice']);
});

test('voice-agent creator reports differing fields without exposing prompt content and never overwrites', async () => {
  const existingDefinition = foundryVoiceAgentDefinition();
  existingDefinition.model = 'different-model';
  const client = clientWith(agentRecord(existingDefinition));
  await assert.rejects(ensureVoiceAgent(client, 'meihao-travel-voice'), error => {
    assert.match(error.message, /model/);
    assert.match(error.message, /refusing overwrite/);
    assert.doesNotMatch(error.message, /instructions|travel_backend/);
    return true;
  });
  assert.equal(client.calls.some(([method]) => method === 'create' || method === 'enable'), false);
});

test('voice-agent creator creates and verifies only when the approved name is absent', async () => {
  const client = clientWith(null);
  const result = await ensureVoiceAgent(client, 'meihao-travel-voice');
  assert.equal(result.created, true);
  assert.equal(result.enabled, true);
  assert.equal(client.calls.filter(([method]) => method === 'create').length, 1);
  assert.equal(client.calls.filter(([method]) => method === 'getVersion').length, 1);
});
