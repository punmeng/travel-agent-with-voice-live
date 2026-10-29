import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemberVoiceMonoVersions, monoChangedPaths } from '../scripts/create-member-voice-mono-versions.js';
import { normalizedVoiceDefinition, differences } from '../scripts/create-member-voice-locale-versions.js';
import { foundryVoiceAgentDefinition, memberDemoVoiceLocaleSettings } from '../lib/voice-agent.js';
import { validateMemberVoiceMonoMapping, pinMemberVoiceLocale } from '../lib/voice.js';

const endpoint = 'https://offline.services.ai.azure.com/api/projects/travel';
const name = 'meihao-travel-intent-voice';
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(normalizedVoiceDefinition(value)));
function setup() {
  const versions = new Map(), writes = [];
  const sourceMapping = {
    agent: name, metadata: { status: 'ready', activated: false, projectEndpointSha256: hash(endpoint) },
    versions: {}
  };
  for (const [locale, version] of [['zh-TW', '6'], ['en-US', '7']]) {
    const definition = foundryVoiceAgentDefinition(), settings = memberDemoVoiceLocaleSettings(locale);
    definition.instructions = settings.instructions;
    definition.audio.input.transcription = settings.transcription;
    definition.audio.output.voice = settings.outputVoice;
    definition.audio.output.voice_locale = locale;
    definition.audio.input.turn_detection.type = 'azure_semantic_vad_multilingual';
    definition.audio.input.echo_cancellation = { type: 'server_echo_cancellation', reference_source: 'client', channels: 2 };
    definition.greeting = { type: 'llm_generated', prompt: 'Preserve this greeting.' };
    versions.set(version, { name, version, definition });
    sourceMapping.versions[locale] = {
      version, definitionSha256: digest(definition), instructionsSha256: hash(definition.instructions), getVerified: true
    };
  }
  let latest = '7';
  const client = { agents: {
    async get() { return { versions: { latest: { version: latest } } }; },
    async getVersion(_, version) { return structuredClone(versions.get(version)); },
    async createVersion(_, definition, options) {
      assert.deepEqual(options, { foundryFeatures: 'VoiceAgents=V1Preview' });
      latest = String(Number(latest) + 1);
      writes.push(latest);
      versions.set(latest, { name, version: latest, definition: structuredClone(definition) });
      return { version: latest };
    }
  } };
  return { client, sourceMapping, versions, writes };
}

test('approved mono versions branch exact hashes, change only two fields and pin both locales', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'travelagent-mono-'));
  const outputPath = path.join(directory, 'mapping.json'), t = setup();
  try {
    await createMemberVoiceMonoVersions(t.client, { endpoint, sourceMapping: t.sourceMapping, outputPath });
    const mapping = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(t.writes, ['8', '9']);
    assert.equal(mapping.metadata.status, 'ready');
    assert.equal(mapping.metadata.inferenceTested, false);
    assert.equal(mapping.metadata.activated, false);
    assert.equal(mapping.pending, undefined);
    for (const [from, to] of [['6', '8'], ['7', '9']]) {
      assert.deepEqual(differences(t.versions.get(from).definition, t.versions.get(to).definition).sort(), monoChangedPaths);
      assert.equal(t.versions.get(from).definition.audio.input.echo_cancellation.channels, 2);
      assert.equal(t.versions.get(to).definition.audio.input.echo_cancellation.channels, 1);
    }
    const localeVersions = validateMemberVoiceMonoMapping(mapping, t.sourceMapping, endpoint, name);
    assert.deepEqual(localeVersions, { 'zh-TW': '8', 'en-US': '9' });
    assert.equal(pinMemberVoiceLocale({ sourceVersion: '5', localeVersions }, 'zh-TW').version, '8');
    assert.equal(pinMemberVoiceLocale({ sourceVersion: '5', localeVersions }, 'en-US').version, '9');
    assert.equal(validateMemberVoiceMonoMapping(mapping, t.sourceMapping, `${endpoint}/wrong`, name), null);
    const broken = structuredClone(mapping);
    broken.versions['en-US'].sourceDefinitionSha256 = 'wrong';
    assert.throws(() => validateMemberVoiceMonoMapping(broken, t.sourceMapping, endpoint, name), /source or version evidence/);
    await assert.rejects(createMemberVoiceMonoVersions(t.client, { endpoint, sourceMapping: t.sourceMapping, outputPath }),
      /ALREADY_EXISTS/);
  } finally { await rm(directory, { recursive: true }); }
});

test('mono creator stops before writing on changed source or latest and records failed verification without retry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'travelagent-mono-guards-'));
  try {
    for (const mode of ['source', 'latest', 'get-diff']) {
      const t = setup(), outputPath = path.join(directory, `${mode}.json`);
      if (mode === 'source') t.versions.get('6').definition.instructions += ' unauthorized';
      if (mode === 'latest') t.client.agents.get = async () => ({ versions: { latest: { version: '8' } } });
      if (mode === 'get-diff') {
        const getVersion = t.client.agents.getVersion;
        t.client.agents.getVersion = async (...args) => {
          const result = await getVersion(...args);
          if (args[1] === '8') result.definition.store = true;
          return result;
        };
      }
      await assert.rejects(createMemberVoiceMonoVersions(t.client, { endpoint, sourceMapping: t.sourceMapping, outputPath }),
        mode === 'get-diff' ? /MONO_GET_DIFF/ : mode === 'source' ? /SOURCE_HASH/ : /LATEST_7/);
      assert.deepEqual(t.writes, mode === 'get-diff' ? ['8'] : []);
      assert.equal(existsSync(outputPath), mode === 'get-diff');
      if (mode === 'get-diff') {
        const mapping = JSON.parse(await readFile(outputPath, 'utf8'));
        assert.equal(mapping.metadata.status, 'creating');
        assert.equal(mapping.pending.expectedVersion, '8');
      }
    }
  } finally { await rm(directory, { recursive: true }); }
});
