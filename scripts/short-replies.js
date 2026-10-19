import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AzureCliCredential } from '@azure/identity';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply for approved four-agent concise instruction updates.');
const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (!endpoint || !process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT || endpoint !== process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT) throw new Error('Unapproved project');
const statePath = new URL('../.foundry/knowledge-ingestion.json', import.meta.url);
const state = JSON.parse(readFileSync(statePath));
const credential = new AzureCliCredential();
async function request(method, path, body) {
  const token = await credential.getToken('https://ai.azure.com/.default');
  const response = await fetch(`${endpoint}${path}?api-version=v1`, {
    method, signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`Agent management HTTP ${response.status}`);
  return response.json();
}
for (const agent of Object.values(state.agents)) {
  const latest = await request('GET', `/agents/${agent.name}`);
  const version = String(latest.versions?.latest?.version ?? latest.version);
  const current = await request('GET', `/agents/${agent.name}/versions/${version}`);
  if (!isDeepStrictEqual(current.definition, agent.definition) || version !== agent.version) throw new Error(`Unknown changes: ${agent.name}`);
}
for (const agent of Object.values(state.agents)) {
  if (agent.conciseRevision === 1) continue;
  const latest = await request('GET', `/agents/${agent.name}`);
  if (String(latest.versions?.latest?.version ?? latest.version) !== agent.version) throw new Error(`Concurrent update: ${agent.name}`);
  const definition = { ...agent.definition, instructions: agent.definition.instructions + `
精簡回覆規則（優先）：每則對旅客的reply／文字回答以35個有意義詞為目標，絕不超過50詞。中文依Intl.Segmenter zh-Hant word斷詞，不是按空白或字數；英文按詞。只回應當前意圖並問下一個自然問題，不加長篇開場、重複聲明或欄位清單。意圖JSON的slots仍完整精確，50詞只限制reply內容。規劃保留指定天數：五天列五個短主題，少步行需求仍保留；必要時後端用「繼續」逐段呈現，不縮短天數。引用從簡、不重複貼大量來源。機票／報價由後端權威文字呈現；不可虛構交易結果、價格或連結。模型僅協助濃縮；50詞硬限制與完整報價呈現檢查由後端執行。` };
  const created = await request('POST', `/agents/${agent.name}/versions`, { definition });
  const verified = await request('GET', `/agents/${agent.name}/versions/${created.version}`);
  if (!isDeepStrictEqual(verified.definition, definition)) throw new Error(`Definition mismatch: ${agent.name}`);
  Object.assign(agent, { version: String(verified.version), definition, conciseRevision: 1, verifiedAt: new Date().toISOString() });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ name: agent.name, version: agent.version, model: agent.model, tools: definition.tools.map(t => t.name ?? t.type) }));
}
const envPath = new URL('../.env', import.meta.url);
let local = readFileSync(envPath, 'utf8');
for (const [role, agent] of Object.entries(state.agents)) {
  const key = `FOUNDRY_${role.toUpperCase()}_VERSION`;
  if (!new RegExp(`^${key}=.*$`, 'm').test(local)) throw new Error(`Missing local version ${key}`);
  local = local.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${agent.version}`);
}
writeFileSync(envPath, local);
const deploymentPath = new URL('../.foundry/deployment.json', import.meta.url);
const deployment = JSON.parse(readFileSync(deploymentPath));
deployment.verifiedAt = state.updatedAt;
deployment.conciseRepliesVerified = false;
for (const entry of deployment.agents) entry.version = state.agents[entry.role].version;
writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + '\n');
