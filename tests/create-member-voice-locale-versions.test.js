import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberVoiceLocaleVersions } from '../scripts/create-member-voice-locale-versions.js';
import { foundryVoiceAgentDefinition, memberDemoLocaleVoiceAgentDefinition,
  memberDemoVoiceLocaleSettings } from '../lib/voice-agent.js';

const name = 'meihao-travel-intent-voice';
const endpoint = 'https://demo.services.ai.azure.com/api/projects/travel';
const clone = value => structuredClone(value);

function makeSource() {
  const definition = foundryVoiceAgentDefinition();
  definition.instructions = 'Validated member demo v5 source.';
  definition.audio.input.turn_detection.type = 'azure_semantic_vad_multilingual';
  definition.greeting = { type: 'llm_generated', prompt: 'Welcome to AI Travel Agent' };
  delete definition.audio.output.voice_locale;
  return definition;
}

function makeClient(latest = '5') {
  const source = makeSource();
  const versions = new Map([['5', { name, version: '5', definition: source }]]);
  let currentLatest = latest;
  const createdVersions = [];
  const client = { agents: {
    async get(requestedName) {
      assert.equal(requestedName, name);
      return { name, versions: { latest: { version: currentLatest } } };
    },
    async getVersion(requestedName, version) {
      assert.equal(requestedName, name);
      const record = versions.get(String(version));
      return record ? clone(record) : null;
    },
    async createVersion(requestedName, definition, options) {
      assert.equal(requestedName, name);
      assert.deepEqual(options, { foundryFeatures: 'VoiceAgents=V1Preview' });
      const version = String(Number(currentLatest) + 1);
      versions.set(version, { name, version, definition: clone(definition) });
      currentLatest = version;
      createdVersions.push(version);
      return { name, version };
    }
  } };
  return { client, source, versions, createdVersions };
}

function sourceMapping(source) {
  return {
    agent: name,
    version: '5',
    turnDetection: 'azure_semantic_vad_multilingual',
    instructionsSha256: createHash('sha256').update(source.instructions).digest('hex'),
    metadata: { projectEndpointSha256: createHash('sha256').update(endpoint).digest('hex') }
  };
}

test('locale version creation branches only the approved localized fields from v5 and writes a candidate mapping', async () => {
  const { client, source, versions, createdVersions } = makeClient();
  const outputPath = path.join(os.tmpdir(), `member-voice-locales-${randomUUID()}.json`);
  try {
    const result = await createMemberVoiceLocaleVersions(client, { endpoint, sourceMapping: sourceMapping(source), outputPath });
    const mapping = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.deepEqual(createdVersions, ['6', '7']);
    assert.equal(result.status, 'ready');
    assert.equal(result.activated, false);
    assert.equal(result.inferenceTested, false);
    assert.deepEqual(Object.keys(mapping.versions).sort(), ['en-US', 'zh-TW']);
    assert.equal(mapping.metadata.status, 'ready');
    assert.equal(mapping.metadata.activated, false);
    assert.equal(mapping.startupGreetingType, 'llm_generated');
    assert.deepEqual(mapping.versions['zh-TW'].changedPaths, ['audio.output.voice_locale', 'instructions']);
    assert.deepEqual(mapping.versions['en-US'].changedPaths, [
      'audio.input.transcription.language', 'audio.output.voice', 'audio.output.voice_locale', 'instructions'
    ]);
    assert.deepEqual(versions.get('5').definition, source);
    for (const locale of ['zh-TW', 'en-US']) {
      const settings = memberDemoVoiceLocaleSettings(locale);
      const definition = versions.get(mapping.versions[locale].version).definition;
      assert.equal(definition.instructions, settings.instructions);
      assert.equal(definition.audio.input.transcription.language, locale);
      assert.equal(definition.audio.output.voice, settings.outputVoice);
      assert.equal(definition.audio.output.voice_locale, locale);
      assert.equal(definition.audio.input.turn_detection.type, 'azure_semantic_vad_multilingual');
      assert.equal(definition.store, false);
      assert.deepEqual(definition.tools, source.tools);
    }
    assert.match(versions.get('6').definition.instructions, /Ni Airlines/);
    assert.match(versions.get('7').definition.instructions, /Ni Airlines/);
    assert.equal(memberDemoLocaleVoiceAgentDefinition(source, 'zh-TW').audio.output.voice_locale, 'zh-TW');
  } finally {
    if (existsSync(outputPath)) rmSync(outputPath);
  }
});

test('locale version creator refuses an unexpected latest version before any cloud write', async () => {
  const { client, source, createdVersions } = makeClient('6');
  const outputPath = path.join(os.tmpdir(), `member-voice-locales-${randomUUID()}.json`);
  try {
    await assert.rejects(createMemberVoiceLocaleVersions(client, {
      endpoint, sourceMapping: sourceMapping(source), outputPath
    }), /Expected v5 as the latest source/);
    assert.deepEqual(createdVersions, []);
    assert.equal(existsSync(outputPath), false);
  } finally {
    if (existsSync(outputPath)) rmSync(outputPath);
  }
});

test('locale version creator rejects a project endpoint that differs from the previously validated candidate', async () => {
  const { client, source, createdVersions } = makeClient();
  const outputPath = path.join(os.tmpdir(), `member-voice-locales-${randomUUID()}.json`);
  try {
    await assert.rejects(createMemberVoiceLocaleVersions(client, {
      endpoint: `${endpoint}/wrong`, sourceMapping: sourceMapping(source), outputPath
    }), /does not match the validated v5 candidate mapping/);
    assert.deepEqual(createdVersions, []);
  } finally {
    if (existsSync(outputPath)) rmSync(outputPath);
  }
});
