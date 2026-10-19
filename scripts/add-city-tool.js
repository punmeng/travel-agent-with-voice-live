import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential } from '@azure/identity';

export function withCityTool(definition, tool) {
  if (tool?.name !== 'resolve_city_airports' || tool.type !== 'function' || !tool.strict) throw new Error('Expected strict canonical city resolver');
  const existing = definition.tools.filter(entry => entry.type === 'function' && entry.name === tool.name);
  if (existing.length > 1 || (existing.length && !isDeepStrictEqual(existing[0], tool))) throw new Error('Unknown city tool definition; refusing overwrite');
  if (existing.length) return structuredClone(definition);
  return { ...structuredClone(definition), tools: [...structuredClone(definition.tools), structuredClone(tool)],
    instructions: definition.instructions + `
城市機場對照補充（優先於舊版僅list_airports描述）：resolve_city_airports是本角色可用的確定性地理工具，只按已維護的完整別名比對，query與可空的countryCode須符合schema。matched可能包含兩座機場；ambiguous要自然確認國家，not_found不猜代碼。地理群組包含都會區服務機場，不代表機場行政區相同，更不代表DEMO實際營運或可售。DEMO班表／機位仍須專業工具及原有後端檢查。都可以／排除某座等偏好由後端保留，已接受的機場集合不要反覆追問。intent的原文slots及tool_choice不變，後端會用同一resolver處理，不在slots自行填代碼。Excel只是本機人工資料來源，不送進模型或file_search；價格與交易界線不變。` };
}

export async function updateCityTools(state, manifest, request, record) {
  // Verify all four known definitions, even the unchanged price role, before writing anything.
  for (const agent of Object.values(state.agents)) {
    const latest = await request('GET', `/agents/${agent.name}`);
    const version = String(latest.versions?.latest?.version ?? latest.version);
    const live = await request('GET', `/agents/${agent.name}/versions/${version}`);
    if (version !== agent.version || !isDeepStrictEqual(live.definition, agent.definition)) throw new Error(`Unknown/concurrent agent changes: ${agent.name}`);
  }
  for (const [role, agent] of Object.entries(state.agents)) {
    const tool = manifest.roles[role]?.find(entry => entry.name === 'resolve_city_airports');
    if (!tool) continue;
    const definition = withCityTool(agent.definition, tool);
    if (isDeepStrictEqual(definition, agent.definition)) continue;
    const latest = await request('GET', `/agents/${agent.name}`);
    if (String(latest.versions?.latest?.version ?? latest.version) !== agent.version) throw new Error(`Concurrent agent update: ${agent.name}`);
    const created = await request('POST', `/agents/${agent.name}/versions`, { definition });
    const verified = await request('GET', `/agents/${agent.name}/versions/${created.version}`);
    if (!isDeepStrictEqual(verified.definition, definition)) throw new Error(`City tool management verification failed: ${agent.name}`);
    Object.assign(agent, { version: String(verified.version), definition, cityResolverRevision: 1, verifiedAt: new Date().toISOString() });
    state.updatedAt = agent.verifiedAt;
    await record(state, role);
  }
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--apply')) throw new Error('Requires --apply: add one tool to existing approved prompt agent versions.');
  const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
  if (!endpoint || !process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT || endpoint !== process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT) throw new Error('Unapproved project');
  const statePath = new URL('../.foundry/knowledge-ingestion.json', import.meta.url);
  const state = JSON.parse(readFileSync(statePath));
  if (state.projectEndpoint !== endpoint || Object.keys(state.agents).length !== 4) throw new Error('Expected four known attached agent definitions');
  const manifest = JSON.parse(readFileSync(new URL('../data/generated/foundry-tools.json', import.meta.url)));
  const credential = new AzureCliCredential({ processTimeoutInMs: 10000 });
  async function request(method, path, body) {
    const token = await credential.getToken('https://ai.azure.com/.default');
    const response = await fetch(`${endpoint}${path}?api-version=v1`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`Agent management HTTP ${response.status}; no automatic retry`);
    return response.json();
  }
  await updateCityTools(state, manifest, request, async (next, role) => {
    writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');
    const envPath = new URL('../.env', import.meta.url);
    const local = readFileSync(envPath, 'utf8'), key = `FOUNDRY_${role.toUpperCase()}_VERSION`;
    if (!new RegExp(`^${key}=\\d+$`, 'm').test(local)) throw new Error(`Missing local version ${key}; verified cloud version recorded, inspect before retrying`);
    writeFileSync(envPath, local.replace(new RegExp(`^${key}=\\d+$`, 'm'), `${key}=${next.agents[role].version}`));
    console.log(JSON.stringify({ role, version: next.agents[role].version,
      fileSearchRetained: next.agents[role].definition.tools.some(tool => tool.type === 'file_search'),
      tools: next.agents[role].definition.tools.map(tool => tool.name ?? tool.type) }));
  });
  const deploymentPath = new URL('../.foundry/deployment.json', import.meta.url);
  const deployment = JSON.parse(readFileSync(deploymentPath));
  deployment.verifiedAt = state.updatedAt;
  for (const entry of deployment.agents) {
    entry.version = state.agents[entry.role].version;
    entry.tools = state.agents[entry.role].definition.tools.map(tool => tool.name ?? tool.type);
  }
  writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + '\n');
}
