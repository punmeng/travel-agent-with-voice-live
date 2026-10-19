import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AzureCliCredential } from '@azure/identity';
import { understandingFormat } from '../lib/conversation.js';
import { updatedKnowledgeEnv } from './ingest-knowledge.js';

if (!process.argv.includes('--apply')) throw new Error('--apply required for approved agent version updates.');
const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
if (!endpoint || !process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT || endpoint !== process.env.FOUNDRY_APPROVED_PROJECT_ENDPOINT) throw new Error('Unapproved project');
const statePath = new URL('../.foundry/knowledge-ingestion.json', import.meta.url);
const state = JSON.parse(readFileSync(statePath));
const functionManifest = JSON.parse(readFileSync(new URL('../data/generated/foundry-tools.json', import.meta.url)));
if (state.projectEndpoint !== endpoint || Object.keys(state.agents).length !== 4) throw new Error('Expected four verified knowledge agents.');
const credential = new AzureCliCredential();
async function request(method, path, body) {
  const token = await credential.getToken('https://ai.azure.com/.default');
  const r = await fetch(`${endpoint}${path}?api-version=v1`, {
    method, headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000)
  });
  const result = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${result.error?.message}`);
  return result;
}
const current = {};
for (const [role, agent] of Object.entries(state.agents)) {
  const latest = await request('GET', `/agents/${agent.name}`);
  const version = latest.versions?.latest?.version ?? latest.version;
  const found = await request('GET', `/agents/${agent.name}/versions/${version}`);
  if (!isDeepStrictEqual(found.definition, agent.definition)) throw new Error(`Unknown changes for ${agent.name}`);
  current[role] = found;
}
for (const [role, agent] of Object.entries(state.agents)) {
  if (agent.conversationRevision === 2) continue;
  const definition = {
    ...agent.definition, reasoning: { effort: 'low' },
    tools: [...functionManifest.roles[role], ...agent.definition.tools.filter(t => t.type !== 'function')],
    ...(role === 'intent' ? { text: { format: understandingFormat }, tool_choice: 'none' } : {}),
    instructions: agent.definition.instructions.split('\n自然對話補充')[0] + `\n自然對話補充（優先於上述單程／三日模板限制）：先聊國家、主題、同行者、步調與天數，不要求機場代碼或一次填完欄位。可在日期/機場未定時先規劃；五天就規劃五天而非強制三天。history與discovery提供目前偏好，使用者未提供的條件不猜。東京與台北的多機場偏好到搜尋前再自然確認。日期以context.today與Asia/Taipei為基準，模糊的下個月中不猜出發日。不得保證賞楓時況、天氣、交通時間或無障礙；沒有可靠來源要註明待核驗。
後端現在可依明確出發與回程日期組合合成來回offer，最多3組日期配對、兩個平行工作、總共最多6個選項。search_flights參數仍依目前trip，回程日期與早去晚回偏好由後端session取得，不得額外塞入未宣告參數。沒有premium的短程回無結果，不私改艙等。所有供應為mock。
模型不執行選班、同意或結帳。後端在最新報價與明確同意後可提供限時、session綁定的模擬checkout相對連結；不是實際付款/訂位，不收卡號，不自行生成付款URL。
${role === 'intent' ? '你是自然語言理解器，必須輸出text.format規範的JSON；slots僅摘取當則使用者訊息的原文連續字串，無資訊填null，禁止從history補抄。reply為自然中文建議；由後端驗證與套用，不是交易命令。' : '你提供本角色的自然繁體中文文字建議；所有交易結果以本機後端為準。'}`
  };
  if (isDeepStrictEqual(definition, agent.definition)) {
    agent.conversationRevision = 2;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    continue;
  }
  const created = await request('POST', `/agents/${agent.name}/versions`, { definition });
  const verified = await request('GET', `/agents/${agent.name}/versions/${created.version}`);
  if (!isDeepStrictEqual(verified.definition, definition)) throw new Error(`Verification failed ${agent.name}`);
  Object.assign(agent, { version: String(verified.version), definition, conversationRevision: 2, verifiedAt: new Date().toISOString() });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ name: agent.name, version: agent.version, model: agent.model, vectorStoreId: agent.vectorStoreId }));
}
const envPath = new URL('../.env', import.meta.url);
writeFileSync(envPath, updatedKnowledgeEnv(readFileSync(envPath, 'utf8'), state.agents));
writeFileSync(new URL('../.foundry/deployment.json', import.meta.url), JSON.stringify({
  projectEndpoint: endpoint, verifiedAt: state.updatedAt, inferenceTested: false, appMode: 'mock',
  agents: Object.entries(state.agents).map(([role, a]) => ({
    role, name: a.name, version: a.version, model: a.model, vectorStoreId: a.vectorStoreId,
    tools: a.definition.tools.map(t => t.name ?? t.type), status: 'management-verified'
  }))
}, null, 2) + '\n');
