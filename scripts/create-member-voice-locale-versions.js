import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { AIProjectClient } from '@azure/ai-projects';
import { FOUNDRY_VOICE_AGENT_NAME, FOUNDRY_VOICE_AGENT_MODEL, memberDemoLocaleVoiceAgentDefinition,
  travelBackendTool } from '../lib/voice-agent.js';

const sourceVersion = '5';
const candidates = [
  { locale: 'zh-TW', version: '6', changedPaths: ['audio.output.voice_locale', 'instructions'] },
  { locale: 'en-US', version: '7', changedPaths: ['audio.input.transcription.language',
    'audio.output.voice', 'audio.output.voice_locale', 'instructions'] }
];
const sourceMappingPath = new URL('../staging/member-voice-version.json', import.meta.url);
const mappingPath = new URL('../staging/member-voice-locales.json', import.meta.url);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, normalized(child)]));
}

export function differences(expected, actual, prefix = '') {
  if (isDeepStrictEqual(expected, actual)) return [];
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object' ||
      Array.isArray(expected) || Array.isArray(actual)) return [prefix || 'definition'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .flatMap(key => differences(expected[key], actual[key], prefix ? `${prefix}.${key}` : key));
}

export function normalizedVoiceDefinition(value) {
  const definition = normalized(value);
  const turnDetection = definition?.audio?.input?.turn_detection;
  if (turnDetection?.remove_filler_words === false) delete turnDetection.remove_filler_words;
  return definition;
}

function assertDefinition(expected, actual, label) {
  const changedPaths = differences(normalizedVoiceDefinition(expected), normalizedVoiceDefinition(actual));
  if (changedPaths.length) throw new Error(`${label} differs at ${changedPaths.slice(0, 20).join(', ')}.`);
}

function assertStrictSource(definition, sourceMapping) {
  if (!definition || definition.kind !== 'voice' || definition.model_type !== 'managed' ||
      definition.model !== FOUNDRY_VOICE_AGENT_MODEL || definition.store !== false ||
      definition.greeting?.type !== 'llm_generated' ||
      definition.audio?.input?.turn_detection?.type !== sourceMapping.turnDetection ||
      definition.audio?.input?.transcription?.model !== 'azure-speech' ||
      definition.audio?.input?.transcription?.language !== 'zh-TW' ||
      definition.audio?.output?.voice !== 'zh-TW-HsiaoChenNeural' ||
      (definition.audio?.output?.voice_locale !== undefined &&
        definition.audio.output.voice_locale !== 'zh-TW') ||
      createHash('sha256').update(definition.instructions ?? '').digest('hex') !== sourceMapping.instructionsSha256 ||
      !Array.isArray(definition.tools) || definition.tools.length !== 1 ||
      !isDeepStrictEqual(normalized(definition.tools[0]), normalized(travelBackendTool)) ||
      !isDeepStrictEqual(normalized(definition.tool_choice), { type: 'function', name: 'travel_backend' }) ||
      definition.parallel_tool_calls !== false) {
    throw new Error('The fetched v5 source does not match the previously validated strict member-demo definition.');
  }
}

function recordFor(candidate, definition) {
  return {
    locale: candidate.locale,
    version: candidate.version,
    changedPaths: candidate.changedPaths,
    instructionsSha256: createHash('sha256').update(definition.instructions).digest('hex'),
    definitionSha256: createHash('sha256').update(JSON.stringify(normalizedVoiceDefinition(definition))).digest('hex'),
    getVerified: true
  };
}

function writeMapping(targetPath, { endpointHash, records, status }) {
  const mapping = {
    schemaVersion: 1,
    metadata: {
      candidate: true, status, activated: false, inferenceTested: false,
      createdAt: new Date().toISOString(), projectEndpointSha256: endpointHash
    },
    agent: FOUNDRY_VOICE_AGENT_NAME,
    sourceVersion,
    model: FOUNDRY_VOICE_AGENT_MODEL,
    store: false,
    tools: ['travel_backend'],
    turnDetection: 'azure_semantic_vad_multilingual',
    startupGreetingType: 'llm_generated',
    versions: Object.fromEntries(records.map(record => [record.locale, record]))
  };
  writeFileSync(targetPath, `${JSON.stringify(mapping, null, 2)}\n`, { flag: 'w' });
}

export async function createMemberVoiceLocaleVersions(client, { endpoint, sourceMapping, outputPath = mappingPath }) {
  if (!endpoint || !sourceMapping || sourceMapping.agent !== FOUNDRY_VOICE_AGENT_NAME ||
      sourceMapping.version !== sourceVersion ||
      createHash('sha256').update(endpoint.replace(/\/$/, '')).digest('hex') !== sourceMapping.metadata?.projectEndpointSha256) {
    throw new Error('The configured project endpoint does not match the validated v5 candidate mapping.');
  }
  if (existsSync(outputPath)) {
    throw new Error('A locale-version mapping already exists; inspect it and the remote versions before any further cloud writes.');
  }
  const agent = await client.agents.get(FOUNDRY_VOICE_AGENT_NAME);
  const latest = String(agent?.versions?.latest?.version ?? agent?.version ?? '');
  if (latest !== sourceVersion) {
    throw new Error(`Expected v5 as the latest source; Foundry reports ${latest || 'none'}. No versions were created.`);
  }
  const source = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, sourceVersion);
  if (!source || source.name !== FOUNDRY_VOICE_AGENT_NAME || String(source.version) !== sourceVersion) {
    throw new Error('The exact validated v5 source could not be fetched.');
  }
  assertStrictSource(source.definition, sourceMapping);

  const endpointHash = createHash('sha256').update(endpoint.replace(/\/$/, '')).digest('hex');
  const records = [];
  for (const candidate of candidates) {
    const expectedLatest = candidate.locale === 'zh-TW' ? sourceVersion : candidates[0].version;
    const currentAgent = await client.agents.get(FOUNDRY_VOICE_AGENT_NAME);
    const currentLatest = String(currentAgent?.versions?.latest?.version ?? currentAgent?.version ?? '');
    if (currentLatest !== expectedLatest) {
      if (records.length) writeMapping(outputPath, { endpointHash, records, status: 'partial' });
      throw new Error(`Expected latest ${expectedLatest} before creating ${candidate.locale}; Foundry reports ${currentLatest}.`);
    }

    const definition = memberDemoLocaleVoiceAgentDefinition(source.definition, candidate.locale);
    const actualChanges = differences(normalizedVoiceDefinition(source.definition), normalizedVoiceDefinition(definition)).sort();
    if (!isDeepStrictEqual(actualChanges, [...candidate.changedPaths].sort())) {
      throw new Error(`${candidate.locale} candidate changes unexpected fields: ${actualChanges.join(', ') || 'none'}.`);
    }

    const created = await client.agents.createVersion(FOUNDRY_VOICE_AGENT_NAME, definition, {
      foundryFeatures: 'VoiceAgents=V1Preview'
    });
    const createdVersion = String(created?.version ?? '');
    if (createdVersion !== candidate.version) {
      const partialRecord = { ...recordFor({ ...candidate, version: createdVersion || 'unknown' }, definition), getVerified: false };
      writeMapping(outputPath, { endpointHash, records: [...records, partialRecord], status: 'partial' });
      throw new Error(`Foundry created ${createdVersion || 'an unreadable version'} instead of authorized v${candidate.version}; stop and inspect before any retry.`);
    }

    const verified = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, candidate.version);
    if (!verified || verified.name !== FOUNDRY_VOICE_AGENT_NAME || String(verified.version) !== candidate.version) {
      writeMapping(outputPath, { endpointHash, records, status: 'partial' });
      throw new Error(`GET could not verify new ${candidate.locale} version ${candidate.version}.`);
    }
    const definitionDiff = differences(normalizedVoiceDefinition(definition),
      normalizedVoiceDefinition(verified.definition));
    const verifiedChanges = differences(normalizedVoiceDefinition(source.definition), normalizedVoiceDefinition(verified.definition)).sort();
    if (definitionDiff.length || !isDeepStrictEqual(verifiedChanges, [...candidate.changedPaths].sort())) {
      records.push({
        ...recordFor({ ...candidate, version: candidate.version }, verified.definition),
        getVerified: false,
        expectedChangedPaths: candidate.changedPaths,
        actualChangedPaths: verifiedChanges,
        getDiffPaths: definitionDiff
      });
      writeMapping(outputPath, { endpointHash, records, status: 'partial' });
      throw new Error(`${candidate.locale} GET did not match the authorized definition; changed fields: ${
        [...new Set([...definitionDiff, ...verifiedChanges])].join(', ') || 'none'
      }. Stop and inspect before any further cloud write.`);
    }
    records.push(recordFor(candidate, verified.definition));
    writeMapping(outputPath, { endpointHash, records, status: 'partial' });
  }

  const preservedSource = await client.agents.getVersion(FOUNDRY_VOICE_AGENT_NAME, sourceVersion);
  assertDefinition(source.definition, preservedSource?.definition, 'Preserved source version 5');
  const finalAgent = await client.agents.get(FOUNDRY_VOICE_AGENT_NAME);
  const finalLatest = String(finalAgent?.versions?.latest?.version ?? finalAgent?.version ?? '');
  if (finalLatest !== candidates.at(-1).version) {
    throw new Error(`Both locale versions were read back, but latest is ${finalLatest || 'unreadable'}; inspect mapping before activation.`);
  }
  writeMapping(outputPath, { endpointHash, records, status: 'ready' });
  return { agent: FOUNDRY_VOICE_AGENT_NAME, sourceVersion, model: FOUNDRY_VOICE_AGENT_MODEL,
    versions: records, status: 'ready', activated: false, inferenceTested: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
    throw new Error('Explicit --apply required; this creates only the two authorized locale versions and does not activate the application.');
  }
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const sourceMapping = JSON.parse(readFileSync(sourceMappingPath, 'utf8'));
  const authMode = process.env.FOUNDRY_AUTH_MODE ?? 'default';
  if (!['default', 'azure-cli'].includes(authMode)) throw new Error('FOUNDRY_AUTH_MODE must be default or azure-cli.');
  const client = new AIProjectClient(endpoint, authMode === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential());
  const result = await createMemberVoiceLocaleVersions(client, { endpoint, sourceMapping });
  console.log(JSON.stringify(result));
}
