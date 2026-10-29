import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential, DefaultAzureCredential } from '@azure/identity';
import { AIProjectClient } from '@azure/ai-projects';
import { isDeepStrictEqual } from 'node:util';

const agentVersions = {
  intent: { name: 'ci-intent-agent', sourceVersion: '8' },
  planner: { name: 'ci-travel-planner-agent', sourceVersion: '8' },
  flight: { name: 'ci-flight-checker-agent', sourceVersion: '8' },
  price: { name: 'ci-price-purchase-agent', sourceVersion: '6' }
};
const mappingPath = new URL('../staging/ni-brand-agent-versions.json', import.meta.url);
const sourceMappingPath = new URL('../staging/member-voice-version.json', import.meta.url);

function agentVersion(agent) {
  return String(agent?.versions?.latest?.version ?? agent?.version ?? '');
}

function rewriteInstructions(instructions, role) {
  if (typeof instructions !== 'string') throw new Error(`${role}: source instructions are not readable text.`);
  const updated = instructions
    .replaceAll('梅好 Airlines', 'Ni Airlines')
    .replaceAll('梅好旅程', 'Ni Airlines');
  if (updated === instructions || /梅好|meihao/i.test(updated)) {
    throw new Error(`${role}: expected old brand references were absent or unexpected brand references remain.`);
  }
  return updated;
}

export function niBrandPromptCandidate(source, role) {
  if (!source?.definition || source.definition.kind !== 'prompt' || source.definition.model !== 'gpt-5.4') {
    throw new Error(`${role}: source definition does not match the approved prompt-agent source.`);
  }
  const definition = structuredClone(source.definition);
  const originalInstructions = definition.instructions;
  definition.instructions = rewriteInstructions(originalInstructions, role);
  const changedKeys = Object.keys(definition).filter(key => !isDeepStrictEqual(definition[key], source.definition[key]));
  if (changedKeys.length !== 1 || changedKeys[0] !== 'instructions') {
    throw new Error(`${role}: candidate changes fields outside the authorized prompt branding.`);
  }
  const replacements = [
    { from: '梅好 Airlines', to: 'Ni Airlines', count: originalInstructions.split('梅好 Airlines').length - 1 },
    { from: '梅好旅程', to: 'Ni Airlines', count: originalInstructions.split('梅好旅程').length - 1 }
  ].filter(replacement => replacement.count > 0);
  return { definition, originalInstructions, changedPaths: ['definition.instructions'], replacements };
}

function writeMapping(records, status, extra = {}) {
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const mapping = JSON.parse(readFileSync(sourceMappingPath, 'utf8'));
  writeFileSync(mappingPath, `${JSON.stringify({
    candidate: true,
    status,
    activated: false,
    inferenceTested: false,
    projectEndpointSha256: createHash('sha256').update(endpoint.replace(/\/$/, '')).digest('hex'),
    voiceAgentCandidate: { name: mapping.agent, version: mapping.version, localeVerifiedEnglish: false },
    agents: records,
    ...extra
  }, null, 2)}\n`, { flag: 'w' });
}

export async function createNiBrandAgentVersions(client, { endpoint, candidateEndpointHash, onRecord = () => {} }) {
  if (!endpoint || createHash('sha256').update(endpoint.replace(/\/$/, '')).digest('hex') !== candidateEndpointHash) {
    throw new Error('Configured project endpoint does not match the previously approved candidate endpoint hash.');
  }
  if (existsSync(mappingPath)) throw new Error('The Ni Airlines agent-version mapping already exists; inspect it before any further cloud writes.');

  const planned = [];
  for (const [role, target] of Object.entries(agentVersions)) {
    const agent = await client.agents.get(target.name);
    if (agentVersion(agent) !== target.sourceVersion) {
      throw new Error(`${role}: expected latest version ${target.sourceVersion}; Foundry reports ${agentVersion(agent) || 'none'}. No versions were created.`);
    }
    const source = await client.agents.getVersion(target.name, target.sourceVersion);
    if (!source || source.name !== target.name || String(source.version) !== target.sourceVersion ||
        source.definition?.kind !== 'prompt' || source.definition?.model !== 'gpt-5.4') {
      throw new Error(`${role}: source definition does not match the approved prompt-agent source.`);
    }
    const candidate = niBrandPromptCandidate(source, role);
    planned.push({ role, target, source, ...candidate });
  }

  const records = [];
  for (const item of planned) {
    const current = await client.agents.get(item.target.name);
    if (agentVersion(current) !== item.target.sourceVersion) {
      const partial = { records, failedRole: item.role, failure: 'source-version-changed-before-create' };
      if (records.length) writeMapping(records, 'partial', partial);
      throw new Error(`${item.role}: source version changed after preflight; no further versions were created.`);
    }
    try {
      const created = await client.agents.createVersion(item.target.name, item.definition);
      const version = String(created?.version ?? '');
      const expectedVersion = String(Number(item.target.sourceVersion) + 1);
      if (version !== expectedVersion) {
        const partial = { records, failedRole: item.role, createdVersion: version || null, failure: 'unexpected-version' };
        writeMapping(records, 'partial', partial);
        throw new Error(`${item.role}: Foundry created version ${version || 'unknown'}, expected ${expectedVersion}; inspect before retrying.`);
      }
      const verified = await client.agents.getVersion(item.target.name, version);
      const differences = [];
      if (!verified || verified.name !== item.target.name || String(verified.version) !== version ||
          verified.definition?.kind !== item.source.definition.kind ||
          verified.definition?.model !== item.source.definition.model ||
          verified.definition?.instructions !== item.definition.instructions) {
        throw new Error(`${item.role}: GET readback did not match the authorized prompt edit.`);
      }
      const verifiedDefinition = structuredClone(verified.definition);
      verifiedDefinition.instructions = item.source.definition.instructions;
      if (!isDeepStrictEqual(verifiedDefinition, item.source.definition)) {
        throw new Error(`${item.role}: GET diff contains changes outside definition.instructions.`);
      }
      const preservedSource = await client.agents.getVersion(item.target.name, item.target.sourceVersion);
      if (!isDeepStrictEqual(preservedSource.definition, item.source.definition)) {
        throw new Error(`${item.role}: source version changed after candidate creation.`);
      }
      differences.push('definition.instructions');
      const record = {
        role: item.role,
        name: item.target.name,
        from: item.target.sourceVersion,
        to: version,
        changedPaths: differences,
        replacements: item.replacements,
        model: verified.definition.model,
        tools: (verified.definition.tools ?? []).map(tool => tool.name ?? tool.type),
        promptSha256: createHash('sha256').update(verified.definition.instructions).digest('hex'),
        getVerified: true
      };
      records.push(record);
      writeMapping(records, records.length === planned.length ? 'ready' : 'partial');
      onRecord(JSON.parse(JSON.stringify(records)));
    } catch (error) {
      writeMapping(records, 'partial', { failedRole: item.role, failure: error.name });
      throw error;
    }
  }
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply') || process.argv.some(argument => argument.startsWith('--') && argument !== '--apply')) {
    throw new Error('Explicit --apply required; only the four preapproved prompt-brand versions are supported.');
  }
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  const endpointMapping = JSON.parse(readFileSync(sourceMappingPath, 'utf8'));
  const authMode = process.env.FOUNDRY_AUTH_MODE ?? 'default';
  if (!['default', 'azure-cli'].includes(authMode)) throw new Error('FOUNDRY_AUTH_MODE must be default or azure-cli.');
  const client = new AIProjectClient(endpoint, authMode === 'azure-cli' ? new AzureCliCredential() : new DefaultAzureCredential());
  const result = await createNiBrandAgentVersions(client, {
    endpoint,
    candidateEndpointHash: endpointMapping.metadata.projectEndpointSha256,
    onRecord: records => console.log(JSON.stringify({ records }))
  });
  console.log(JSON.stringify({ status: 'ready', agents: result }));
}
