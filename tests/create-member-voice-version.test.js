import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberDemoVoiceVersion, createMemberVoiceVadVersion } from '../scripts/create-member-voice-version.js';
import { foundryVoiceAgentDefinition, memberDemoVoiceAgentDefinition,
  memberDemoVoiceVadAgentDefinition } from '../lib/voice-agent.js';

const name = 'meihao-travel-intent-voice';
const clone = value => structuredClone(value);

function makeClient(latest = '3', overrides = {}) {
  const source = foundryVoiceAgentDefinition();
  source.instructions = 'Original version 3 instructions.';
  source.tools = [{ type: 'toolbox', toolbox_id: 'preserved-only-in-version-3' }];
  source.store = true;
  source.audio.input.turn_detection.auto_truncate = false;
  const versions = new Map([['3', { name, version: '3', definition: source }]]);
  if (latest !== '3') {
    versions.set(String(latest), { name, version: String(latest),
      definition: overrides.latestDefinition ?? clone(source) });
  }
  const calls = [];
  const client = { calls, agents: {
    async get(requestedName) {
      calls.push(['get', requestedName]);
      return { name: requestedName, version: String(latest), versions: { latest: { version: String(latest) } } };
    },
    async getVersion(requestedName, version) {
      calls.push(['getVersion', requestedName, version]);
      const record = versions.get(String(version));
      return record ? clone(record) : null;
    },
    async createVersion(requestedName, definition, options) {
      calls.push(['createVersion', requestedName, options]);
      const version = '4';
      versions.set(version, { name: requestedName, version, definition: clone(definition) });
      latest = version;
      return { name: requestedName, version };
    }
  } };
  return { client, calls, versions };
}

test('member voice version adds one immutable bilingual backend-only candidate without changing v3', async () => {
  const { client, calls, versions } = makeClient();
  const before = clone(versions.get('3').definition);
  const result = await createMemberDemoVoiceVersion(client, name);

  assert.equal(result.version, '4');
  assert.equal(result.created, true);
  assert.equal(result.inferenceTested, false);
  assert.equal(result.previousVersionsPreserved, true);
  assert.equal(calls.filter(([method]) => method === 'createVersion').length, 1);
  assert.equal(calls.some(([method]) => method === 'enable'), false);
  assert.deepEqual(versions.get('3').definition, before);
  const candidate = versions.get('4').definition;
  assert.deepEqual(candidate.audio, before.audio);
  assert.deepEqual(candidate.tools.map(tool => tool.name), ['travel_backend']);
  assert.equal(candidate.tool_choice.name, 'travel_backend');
  assert.equal(candidate.store, false);
  assert.equal(candidate.model, 'gpt-realtime-2.1');
  assert.match(candidate.instructions, /zh-TW/);
  assert.match(candidate.instructions, /en-US/);
});

test('rerunning after a successful creation verifies the candidate instead of creating duplicates', async () => {
  const base = foundryVoiceAgentDefinition();
  base.instructions = 'Original version 3 instructions.';
  base.tools = [{ type: 'toolbox', toolbox_id: 'preserved-only-in-version-3' }];
  base.store = true;
  base.audio.input.turn_detection.auto_truncate = false;
  const latest = memberDemoVoiceAgentDefinition(base);
  const { client, calls } = makeClient('4', { latestDefinition: latest });

  const result = await createMemberDemoVoiceVersion(client, name);
  assert.equal(result.version, '4');
  assert.equal(result.created, false);
  assert.equal(calls.some(([method]) => method === 'createVersion'), false);
});

test('a different latest voice definition fails closed without creating another version', async () => {
  const wrong = foundryVoiceAgentDefinition();
  wrong.model = 'different-model';
  const { client, calls } = makeClient('4', { latestDefinition: wrong });

  await assert.rejects(createMemberDemoVoiceVersion(client, name), /differs at model/);
  assert.equal(calls.some(([method]) => method === 'createVersion'), false);
});

test('the creator refuses a different agent name', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(createMemberDemoVoiceVersion(client, 'another-agent'), /Only the approved existing/);
  assert.equal(calls.length, 0);
});

function makeVadClient(latest = '4', override) {
  const original = foundryVoiceAgentDefinition();
  original.instructions = 'Preserved member-demo v4 instructions.';
  original.audio.input.turn_detection.type = 'server_vad';
  original.audio.input.transcription = { model: 'azure-speech', language: 'zh-TW' };
  original.tools = [{ type: 'function', name: 'travel_backend', parameters: { additionalProperties: false } }];
  original.tool_choice = { type: 'function', name: 'travel_backend' };
  original.parallel_tool_calls = false;
  original.store = false;
  const versions = new Map([
    ['4', { name, version: '4', definition: original }],
    ...(latest === '5' ? [['5', { name, version: '5',
      definition: override ?? memberDemoVoiceVadAgentDefinition(original) }]] : [])
  ]);
  const calls = [];
  const client = { calls, agents: {
    async get(requestedName) {
      calls.push(['get', requestedName]);
      return { name: requestedName, versions: { latest: { version: String(latest) } } };
    },
    async getVersion(requestedName, version) {
      calls.push(['getVersion', requestedName, version]);
      const record = versions.get(String(version));
      return record ? clone(record) : null;
    },
    async createVersion(requestedName, definition, options) {
      calls.push(['createVersion', requestedName, options]);
      const storedDefinition = clone(definition);
      storedDefinition.audio.input.turn_detection.remove_filler_words = false;
      versions.set('5', { name: requestedName, version: '5', definition: storedDefinition });
      latest = '5';
      return { name: requestedName, version: '5' };
    }
  } };
  return { client, calls, versions };
}

test('v5 changes only persisted turn detection and preserves v4', async () => {
  const { client, calls, versions } = makeVadClient();
  const before = clone(versions.get('4').definition);
  const result = await createMemberVoiceVadVersion(client, name);

  assert.equal(result.version, '5');
  assert.equal(result.created, true);
  assert.equal(result.turnDetection, 'azure_semantic_vad_multilingual');
  assert.deepEqual(result.serviceDefaults, ['audio.input.turn_detection.remove_filler_words=false']);
  assert.equal(result.inferenceTested, false);
  assert.equal(result.previousVersionsPreserved, true);
  assert.equal(calls.filter(([method]) => method === 'createVersion').length, 1);
  assert.deepEqual(versions.get('4').definition, before);
  const candidate = versions.get('5').definition;
  const expected = clone(before);
  expected.audio.input.turn_detection.type = 'azure_semantic_vad_multilingual';
  expected.audio.input.turn_detection.remove_filler_words = false;
  assert.deepEqual(candidate, expected);
});

test('v5 rerun verifies the exact candidate and never creates another version', async () => {
  const { client, calls } = makeVadClient('5');
  const result = await createMemberVoiceVadVersion(client, name);
  assert.equal(result.version, '5');
  assert.equal(result.created, false);
  assert.equal(calls.some(([method]) => method === 'createVersion'), false);
});

test('v5 refuses an unexpected latest version or modified v5 definition', async () => {
  const higherVersion = makeVadClient('6');
  await assert.rejects(createMemberVoiceVadVersion(higherVersion.client, name), /Expected version 4 as latest/);
  assert.equal(higherVersion.calls.some(([method]) => method === 'createVersion'), false);

  const wrong = memberDemoVoiceVadAgentDefinition(makeVadClient().versions.get('4').definition);
  wrong.audio.input.output = 'unexpected';
  const modified = makeVadClient('5', wrong);
  await assert.rejects(createMemberVoiceVadVersion(modified.client, name), /differs at audio\.input\.output/);
  assert.equal(modified.calls.some(([method]) => method === 'createVersion'), false);
});
