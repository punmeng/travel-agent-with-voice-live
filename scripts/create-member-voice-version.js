import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { AIProjectClient } from '@azure/ai-projects';
import { isDeepStrictEqual } from 'node:util';
import { FOUNDRY_VOICE_AGENT_NAME, FOUNDRY_VOICE_AGENT_MODEL,
  memberDemoVoiceAgentDefinition, memberDemoVoiceVadAgentDefinition } from '../lib/voice-agent.js';

const foundryFeatures = 'VoiceAgents=V1Preview';
const baseVersion = '3';
const vadBaseVersion = '4';
const vadVersion = '5';
const multilingualVad = 'azure_semantic_vad_multilingual';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, normalized(child)]));
}

function differingPaths(expected, actual, prefix = '') {
  if (isDeepStrictEqual(expected, actual)) return [];
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object' ||
      Array.isArray(expected) || Array.isArray(actual)) return [prefix || 'definition'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .flatMap(key => differingPaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key));
}

function normalizedVoiceDefinition(value) {
  const definition = normalized(value);
  const detection = definition?.audio?.input?.turn_detection;
  if (detection?.remove_filler_words === false) delete detection.remove_filler_words;
  return definition;
}

function requireExactDefinition(expected, actual, context) {
  const differences = differingPaths(normalizedVoiceDefinition(expected), normalizedVoiceDefinition(actual));
  if (differences.length) {
    throw new Error(`${context} differs at ${differences.slice(0, 20).join(', ')}; no retry or overwrite was attempted.`);
  }
}

function assertStrictBackendDefinition(definition) {
  const tools = definition?.tools;
  if (!Array.isArray(tools) || tools.length !== 1 || tools[0]?.type !== 'function' ||
      tools[0]?.name !== 'travel_backend' || tools[0]?.parameters?.additionalProperties !== false ||
      definition.tool_choice?.type !== 'function' || definition.tool_choice?.name !== 'travel_backend' ||
      definition.parallel_tool_calls !== false || definition.store !== false ||
      JSON.stringify(tools).toLowerCase().includes('web_search') ||
      JSON.stringify(tools).toLowerCase().includes('toolbox')) {
    throw new Error('The candidate must use only strict travel_backend, disable parallel calls and persistence, and contain no web search or toolbox.');
  }
}

export async function createMemberDemoVoiceVersion(client, name = FOUNDRY_VOICE_AGENT_NAME) {
  if (name !== FOUNDRY_VOICE_AGENT_NAME) throw new Error('Only the approved existing managed voice-agent name may be updated.');
  const agent = await client.agents.get(name);
  const latest = String(agent?.versions?.latest?.version ?? agent?.version ?? '');
  if (!/^\d{1,12}$/.test(latest)) throw new Error('Foundry returned no readable latest version; inspect the agent before retrying.');
  const base = await client.agents.getVersion(name, baseVersion);
  if (!base || base.name !== name || String(base.version) !== baseVersion || !base.definition) {
    throw new Error('The approved source voice-agent version 3 could not be verified.');
  }
  const candidate = memberDemoVoiceAgentDefinition(base.definition);
  assertStrictBackendDefinition(candidate);
  if (candidate.model !== FOUNDRY_VOICE_AGENT_MODEL) throw new Error('The source model differs from the approved managed voice model.');

  if (latest !== baseVersion) {
    const existing = await client.agents.getVersion(name, latest);
    requireExactDefinition(candidate, existing?.definition, 'The latest managed voice-agent version');
    return { name, baseVersion, version: latest, model: candidate.model, created: false, store: false,
      tools: ['travel_backend'], instructionsSha256: createHash('sha256').update(candidate.instructions).digest('hex'),
      inferenceTested: false, previousVersionsPreserved: true };
  }

  const created = await client.agents.createVersion(name, candidate, { foundryFeatures });
  const version = String(created?.version ?? '');
  if (!/^\d{1,12}$/.test(version) || version === baseVersion) {
    throw new Error('Foundry returned an invalid new version; inspect the agent before retrying.');
  }
  const verified = await client.agents.getVersion(name, version);
  requireExactDefinition(candidate, verified?.definition, `New managed voice-agent version ${version}`);
  const preservedBase = await client.agents.getVersion(name, baseVersion);
  requireExactDefinition(base.definition, preservedBase?.definition, `Preserved source voice-agent version ${baseVersion}`);
  return { name, baseVersion, version, model: candidate.model, created: true, store: false,
    tools: ['travel_backend'], instructionsSha256: createHash('sha256').update(candidate.instructions).digest('hex'),
    inferenceTested: false, previousVersionsPreserved: true };
}

export async function createMemberVoiceVadVersion(client, name = FOUNDRY_VOICE_AGENT_NAME) {
  if (name !== FOUNDRY_VOICE_AGENT_NAME) throw new Error('Only the approved existing managed voice-agent name may be updated.');
  const agent = await client.agents.get(name);
  const latest = String(agent?.versions?.latest?.version ?? agent?.version ?? '');
  if (!/^\d{1,12}$/.test(latest)) throw new Error('Foundry returned no readable latest version; inspect the agent before retrying.');
  const base = await client.agents.getVersion(name, vadBaseVersion);
  if (!base || base.name !== name || String(base.version) !== vadBaseVersion || !base.definition) {
    throw new Error('The approved managed voice-agent version 4 could not be verified.');
  }
  const candidate = memberDemoVoiceVadAgentDefinition(base.definition);
  assertStrictBackendDefinition(candidate);
  if (candidate.model !== FOUNDRY_VOICE_AGENT_MODEL ||
      candidate.audio.input.turn_detection.type !== multilingualVad) {
    throw new Error('The candidate does not match the approved model and multilingual VAD settings.');
  }
  const sourceDifferences = differingPaths(normalized(base.definition), normalized(candidate));
  if (sourceDifferences.length !== 1 || sourceDifferences[0] !== 'audio.input.turn_detection.type') {
    throw new Error(`The v5 candidate changes fields outside the authorized VAD setting: ${sourceDifferences.join(', ') || 'none'}.`);
  }

  if (latest === vadVersion) {
    const existing = await client.agents.getVersion(name, vadVersion);
    requireExactDefinition(candidate, existing?.definition, 'The latest managed voice-agent version');
    return { name, baseVersion: vadBaseVersion, version: vadVersion, model: candidate.model,
      created: false, store: false, tools: ['travel_backend'], turnDetection: multilingualVad,
      serviceDefaults: ['audio.input.turn_detection.remove_filler_words=false'],
      instructionsSha256: createHash('sha256').update(candidate.instructions).digest('hex'),
      inferenceTested: false, previousVersionsPreserved: true };
  }
  if (latest !== vadBaseVersion) {
    throw new Error(`Expected version 4 as latest before creating v5; Foundry reports ${latest}. No new version was created.`);
  }

  const created = await client.agents.createVersion(name, candidate, { foundryFeatures });
  const version = String(created?.version ?? '');
  if (version !== vadVersion) {
    throw new Error(`Foundry created version ${version || '(empty)'}, not the authorized v5; inspect it before any retry.`);
  }
  const verified = await client.agents.getVersion(name, vadVersion);
  requireExactDefinition(candidate, verified?.definition, `New managed voice-agent version ${vadVersion}`);
  const preservedBase = await client.agents.getVersion(name, vadBaseVersion);
  requireExactDefinition(base.definition, preservedBase?.definition, `Preserved source voice-agent version ${vadBaseVersion}`);
  return { name, baseVersion: vadBaseVersion, version: vadVersion, model: candidate.model,
    created: true, store: false, tools: ['travel_backend'], turnDetection: multilingualVad,
    serviceDefaults: ['audio.input.turn_detection.remove_filler_words=false'],
    instructionsSha256: createHash('sha256').update(candidate.instructions).digest('hex'),
    inferenceTested: false, previousVersionsPreserved: true };
}

async function writeCandidateMapping(result, endpoint) {
  const mapping = {
    metadata: { candidate: true, inferenceTested: false, createdAt: new Date().toISOString(),
      projectEndpointSha256: createHash('sha256').update(endpoint).digest('hex') },
    agent: result.name,
    sourceVersion: result.baseVersion,
    version: result.version,
    model: result.model,
    store: false,
    tools: result.tools,
    ...(result.turnDetection ? { turnDetection: result.turnDetection } : {}),
    ...(result.serviceDefaults ? { serviceDefaults: result.serviceDefaults } : {}),
    instructionsSha256: result.instructionsSha256
  };
  const target = path.join(repoRoot, 'staging', 'member-voice-version.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(mapping, null, 2)}\n`, { flag: 'w' });
  return path.relative(repoRoot, target).replaceAll(path.sep, '/');
}

function validatedEndpoint(value, name) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error(`Set a valid ${name}.`); }
  if (endpoint.protocol !== 'https:' || !/^[\w-]+\.(?:services\.ai|ai)\.azure\.com$/.test(endpoint.hostname) ||
      !/^\/api\/projects\/[\w-]+\/?$/.test(endpoint.pathname) || endpoint.search || endpoint.username || endpoint.password) {
    throw new Error(`${name} must be an Azure HTTPS project endpoint.`);
  }
  return endpoint.href.replace(/\/$/, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Explicit --apply required. This creates one immutable voice-agent version; it does not run inference.');
  const endpoint = validatedEndpoint(process.env.FOUNDRY_PROJECT_ENDPOINT, 'FOUNDRY_PROJECT_ENDPOINT');
  const approvedEndpoint = validatedEndpoint(process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT, 'FOUNDRY_APPROVED_PROJECT_ENDPOINT');
  if (endpoint !== approvedEndpoint) throw new Error('FOUNDRY_PROJECT_ENDPOINT must exactly match FOUNDRY_APPROVED_PROJECT_ENDPOINT.');
  const authMode = process.env.FOUNDRY_AUTH_MODE || 'default';
  if (!['default', 'azure-cli'].includes(authMode)) throw new Error('FOUNDRY_AUTH_MODE must be default or azure-cli.');
  const client = new AIProjectClient(endpoint, authMode === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential());
  const vadV5 = process.argv.includes('--vad-v5');
  if (process.argv.some(argument => argument.startsWith('--') && !['--apply', '--vad-v5'].includes(argument))) {
    throw new Error('Only --apply and the optional --vad-v5 selector are supported.');
  }
  const result = vadV5
    ? await createMemberVoiceVadVersion(client)
    : await createMemberDemoVoiceVersion(client);
  const mappingFile = await writeCandidateMapping(result, endpoint);
  console.log(JSON.stringify({ ...result, mappingFile }));
}
