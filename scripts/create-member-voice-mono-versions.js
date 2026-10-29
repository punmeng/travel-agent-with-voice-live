import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AIProjectClient } from '@azure/ai-projects';
import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { differences, normalizedVoiceDefinition } from './create-member-voice-locale-versions.js';
import { FOUNDRY_VOICE_AGENT_NAME } from '../lib/voice-agent.js';

const outputUrl = new URL('../staging/member-voice-mono.json', import.meta.url);
const digest = value => createHash('sha256').update(JSON.stringify(normalizedVoiceDefinition(value))).digest('hex');
export const monoChangedPaths = [
  'audio.input.echo_cancellation.channels',
  'audio.input.echo_cancellation.reference_source'
];

export async function createMemberVoiceMonoVersions(client, { endpoint, sourceMapping, outputPath = outputUrl }) {
  const endpointHash = createHash('sha256').update(endpoint.replace(/\/$/, '')).digest('hex');
  if (sourceMapping.agent !== FOUNDRY_VOICE_AGENT_NAME ||
      sourceMapping.metadata?.projectEndpointSha256 !== endpointHash ||
      sourceMapping.metadata.status !== 'ready' || sourceMapping.metadata.activated !== false ||
      sourceMapping.versions?.['zh-TW']?.version !== '6' || sourceMapping.versions?.['en-US']?.version !== '7') {
    throw new Error('MONO_SOURCE_MAPPING_MISMATCH');
  }
  if (existsSync(outputPath)) throw new Error('MONO_CANDIDATE_ALREADY_EXISTS_INSPECT_BEFORE_WRITES');
  const latest = async () => String((await client.agents.get(FOUNDRY_VOICE_AGENT_NAME)).versions.latest.version);
  if (await latest() !== '7') throw new Error('MONO_EXPECTED_LATEST_7');
  const sources = {};
  for (const locale of ['zh-TW', 'en-US']) {
    const mapped = sourceMapping.versions[locale];
    const source = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, mapped.version);
    const echo = source?.definition?.audio?.input?.echo_cancellation;
    if (source?.name !== FOUNDRY_VOICE_AGENT_NAME || String(source.version) !== mapped.version ||
        mapped.getVerified !== true || digest(source.definition) !== mapped.definitionSha256 ||
        echo?.type !== 'server_echo_cancellation' || echo.reference_source !== 'client' || echo.channels !== 2) {
      throw new Error(`MONO_SOURCE_HASH_OR_CHANNEL_MISMATCH_${locale}`);
    }
    sources[locale] = source.definition;
  }
  const mapping = {
    schemaVersion: 1,
    metadata: {
      candidate: true, status: 'creating', activated: false, inferenceTested: false,
      projectEndpointSha256: endpointHash, createdAt: new Date().toISOString()
    },
    agent: FOUNDRY_VOICE_AGENT_NAME,
    model: 'gpt-realtime-2.1', store: false,
    echoCancellation: { type: 'server_echo_cancellation', reference_source: 'server', channels: 1 },
    versions: {}
  };
  const save = () => writeFileSync(outputPath, `${JSON.stringify(mapping, null, 2)}\n`);
  // Persist the attempt before a cloud write, so an ambiguous response cannot cause an automatic rerun.
  save();
  for (const [locale, from, to, previous] of [
    ['zh-TW', '6', '8', '7'], ['en-US', '7', '9', '8']
  ]) {
    if (await latest() !== previous) throw new Error(`MONO_UNEXPECTED_LATEST_BEFORE_${to}`);
    const definition = structuredClone(sources[locale]);
    definition.audio.input.echo_cancellation.reference_source = 'server';
    definition.audio.input.echo_cancellation.channels = 1;
    const changed = differences(normalizedVoiceDefinition(sources[locale]), normalizedVoiceDefinition(definition)).sort();
    if (JSON.stringify(changed) !== JSON.stringify(monoChangedPaths)) throw new Error('MONO_UNEXPECTED_DEFINITION_DIFF');
    mapping.pending = { locale, sourceVersion: from, expectedVersion: to };
    save();
    const created = await client.agents.createVersion(FOUNDRY_VOICE_AGENT_NAME, definition, {
      foundryFeatures: 'VoiceAgents=V1Preview'
    });
    if (String(created.version) !== to) throw new Error(`MONO_UNEXPECTED_CREATED_VERSION_${created.version}`);
    const verified = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, to);
    if (verified?.name !== FOUNDRY_VOICE_AGENT_NAME || String(verified.version) !== to ||
        differences(normalizedVoiceDefinition(definition), normalizedVoiceDefinition(verified.definition)).length) {
      throw new Error(`MONO_GET_DIFF_${to}`);
    }
    mapping.versions[locale] = {
      sourceVersion: from, version: to, getVerified: true, changedPaths: changed,
      sourceDefinitionSha256: digest(sources[locale]), definitionSha256: digest(verified.definition),
      instructionsSha256: createHash('sha256').update(verified.definition.instructions).digest('hex')
    };
    delete mapping.pending;
    mapping.metadata.status = 'partial';
    save();
  }
  for (const locale of ['zh-TW', 'en-US']) {
    const preserved = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, sourceMapping.versions[locale].version);
    if (digest(preserved?.definition) !== digest(sources[locale])) throw new Error('MONO_SOURCE_CHANGED');
  }
  if (await latest() !== '9') throw new Error('MONO_FINAL_LATEST_MISMATCH');
  mapping.metadata.status = 'ready';
  save();
  return mapping;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Explicit --apply required for two approved mono versions.');
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const authMode = process.env.FOUNDRY_AUTH_MODE ?? 'default';
  if (!['default', 'azure-cli'].includes(authMode)) throw new Error('FOUNDRY_AUTH_MODE must be default or azure-cli.');
  const client = new AIProjectClient(endpoint, authMode === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential());
  console.log(JSON.stringify(await createMemberVoiceMonoVersions(client, {
    endpoint, sourceMapping: JSON.parse(readFileSync(new URL('../staging/member-voice-locales.json', import.meta.url), 'utf8'))
  })));
}
