import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { AIProjectClient } from '@azure/ai-projects';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FOUNDRY_VOICE_AGENT_NAME, foundryVoiceAgentDefinition } from '../lib/voice-agent.js';

const foundryFeatures = 'VoiceAgents=V1Preview';

function projectEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('Set a valid FOUNDRY_PROJECT_ENDPOINT.'); }
  if (endpoint.protocol !== 'https:' || !/^[\w-]+\.(?:services\.ai|ai)\.azure\.com$/.test(endpoint.hostname) ||
      !/^\/api\/projects\/[\w-]+\/?$/.test(endpoint.pathname) || endpoint.search || endpoint.username || endpoint.password) {
    throw new Error('FOUNDRY_PROJECT_ENDPOINT must be an Azure HTTPS project endpoint.');
  }
  return endpoint.href.replace(/\/$/, '');
}

function definitionProjection(definition) {
  return {
    kind: definition?.kind,
    model_type: definition?.model_type,
    model: definition?.model,
    instructions: definition?.instructions,
    output_modalities: definition?.output_modalities,
    max_output_tokens: definition?.max_output_tokens,
    tools: definition?.tools,
    tool_choice: definition?.tool_choice,
    parallel_tool_calls: definition?.parallel_tool_calls,
    store: definition?.store,
    audio: {
      input: {
        format: definition?.audio?.input?.format,
        noise_reduction: definition?.audio?.input?.noise_reduction,
        echo_cancellation: definition?.audio?.input?.echo_cancellation,
        turn_detection: definition?.audio?.input?.turn_detection,
        transcription: definition?.audio?.input?.transcription
      },
      output: {
        format: definition?.audio?.output?.format,
        voice_type: definition?.audio?.output?.voice_type,
        voice: definition?.audio?.output?.voice,
        voice_locale: definition?.audio?.output?.voice_locale
      }
    }
  };
}

function differingPaths(expected, actual, prefix = '') {
  if (isDeepStrictEqual(expected, actual)) return [];
  if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object' ||
      Array.isArray(expected) || Array.isArray(actual)) {
    return [prefix || 'definition'];
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].flatMap(key => differingPaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key));
}

export async function ensureVoiceAgent(client, name = FOUNDRY_VOICE_AGENT_NAME) {
  const definition = foundryVoiceAgentDefinition();
  let agent;
  try {
    agent = await client.agents.get(name);
  } catch (error) {
    if (error?.statusCode !== 404) throw error;
  }
  let created = false;
  if (!agent) {
    agent = await client.agents.create(name, definition, {
      foundryFeatures,
      description: 'Bilingual managed voice entry point to the Ni Airlines travel backend.'
    });
    created = true;
  }
  const resolvedAgent = created ? await client.agents.get(name) : agent;
  const version = resolvedAgent.versions?.latest?.version ?? resolvedAgent.version;
  if (!version) throw new Error(`Foundry returned no readable version for ${name}; inspect the agent before retrying.`);
  const verified = await client.agents.getVersion(name, String(version));
  const differences = !verified || verified.name !== name || String(verified.version) !== String(version)
    ? ['identity']
    : differingPaths(definitionProjection(definition), definitionProjection(verified.definition));
  if (differences.length) {
    throw new Error(`Existing voice-agent definition differs from the approved app contract for ${name} (${differences.slice(0, 20).join(', ')}); refusing overwrite.`);
  }
  await client.agents.enable(name);
  return { name, version: String(version), model: verified.definition.model, created, enabled: true, inferenceTested: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Explicit --apply required. This only creates or enables the managed agent; it does not run inference.');
  const endpoint = projectEndpoint(process.env.FOUNDRY_PROJECT_ENDPOINT);
  const approvedEndpoint = projectEndpoint(process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT);
  if (endpoint !== approvedEndpoint) throw new Error('FOUNDRY_PROJECT_ENDPOINT must exactly match FOUNDRY_APPROVED_PROJECT_ENDPOINT.');
  const name = process.env.FOUNDRY_VOICE_AGENT_NAME?.trim() || FOUNDRY_VOICE_AGENT_NAME;
  if (!/^[\w-]{1,128}$/.test(name)) throw new Error('Invalid FOUNDRY_VOICE_AGENT_NAME.');
  const authMode = process.env.FOUNDRY_AUTH_MODE || 'default';
  if (!['default', 'azure-cli'].includes(authMode)) throw new Error('FOUNDRY_AUTH_MODE must be default or azure-cli.');
  const credential = authMode === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential();
  const client = new AIProjectClient(endpoint, credential);
  const result = await ensureVoiceAgent(client, name);
  console.log(JSON.stringify({ projectEndpoint: endpoint, ...result }));
}
