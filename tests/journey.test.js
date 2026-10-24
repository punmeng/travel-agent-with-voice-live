import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { foundryConfig } from '../lib/foundry.js';
import { chat } from '../lib/agents.js';
import { createSession } from '../lib/core.js';
import { applyUnderstanding, resolveDate } from '../lib/conversation.js';
import { planningLead, projectContext, planningUpdates, savedPlan } from '../lib/journey.js';
import { readAll } from './reply-helper.js';

const env = { APP_MODE: 'mock' };
const now = Date.parse('2026-10-23T12:00:00Z');
export const demo = [
  '我要去東京出差五天，二零二六年十一月十二日從桃園出發，一位成人，搭經濟艙。請先幫我規劃行程，並查詢去程到成田機場的航班，先不要訂票。',
  '第二天和第三天，上午九點到下午五點都在東京車站附近開會。請保留這兩天的工作時間，推薦交通方便的住宿區域，並安排機場往返交通。',
  '第四天下午可以自由活動，想去淺草和買伴手禮，不要安排太多步行。機票和四晚住宿的總預算是新臺幣四萬元，請另外估算交通和餐費。',
  '請簡短整理五天行程、建議住宿區域和預算分配，最後列出還需要我確認的資料。先不要訂票。'
];
const say = async (s, message) => readAll(s, await chat(s, { message, requestId: randomUUID() }, env, { now }));
test('airport transfer advice never substitutes Tokyo/Narita for another confirmed airport', () => {
  for (const [destination, city] of [['KIX', '大阪'], ['HND', '東京'], ['NRT', '東京']]) {
    const s = createSession();
    s.draft = { destination };
    s.discovery.destinationCity = city;
    s.discovery.planning = planningUpdates(undefined, '請安排機場往返交通');
    const text = savedPlan(s);
    if (destination === 'NRT') assert.match(text, /成田往返東京車站/);
    else {
      assert.doesNotMatch(text, /成田|東京車站/);
      assert.match(text, /鐵路|巴士|接駁/);
    }
  }
});
test('presentation release applies only to the exact approved project, agent and source version', () => {
  const endpoint = 'https://demo.services.ai.azure.com/api/projects/test';
  const source = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: endpoint,
    FOUNDRY_INTENT_AGENT: 'intent', FOUNDRY_INTENT_VERSION: '6',
    FOUNDRY_PLANNER_AGENT: 'planner', FOUNDRY_PLANNER_VERSION: '6',
    FOUNDRY_FLIGHT_AGENT: 'flight', FOUNDRY_FLIGHT_VERSION: '8',
    FOUNDRY_PRICE_AGENT: 'price', FOUNDRY_PRICE_VERSION: '9' };
  const release = { projectEndpointSha256: createHash('sha256').update(endpoint).digest('hex'),
    agents: [{ role: 'intent', name: 'intent', from: '6', to: '7' }, { role: 'planner', name: 'planner', from: '6', to: '7' }] };
  const resolved = foundryConfig(source, release);
  assert.equal(resolved.agents.intent.version, '7'); assert.equal(resolved.agents.planner.version, '7');
  assert.equal(resolved.agents.flight.version, '8'); assert.equal(resolved.agents.price.version, '9');
  assert.equal(source.FOUNDRY_INTENT_VERSION, '6', 'environment remains untouched');
  assert.equal(foundryConfig({ ...source, FOUNDRY_INTENT_VERSION: '5' }, release).agents.intent.version, '5');
  assert.equal(foundryConfig({ ...source, FOUNDRY_INTENT_AGENT: 'unrelated' }, release).agents.intent.version, '6');
  assert.equal(foundryConfig({ ...source, FOUNDRY_PROJECT_ENDPOINT: endpoint + '-other' }, release).agents.intent.version, '6');
  assert.equal(foundryConfig(source, null).agents.intent.version, '6', 'without a private release manifest, explicit environment pins apply');
});
test('unrecognized airport answer preserves the confirmed city and pending airport question without guessing', async () => {
  const s = createSession();
  await say(s, '東京出差五天');
  const before = structuredClone(s.discovery);
  const clarification = applyUnderstanding(s, { destinationPlace: '陳田機場' }, now, '陳田機場');
  assert.equal(s.discovery.destinationCity, '東京');
  assert.deepEqual(s.discovery.destinationAirportChoice, before.destinationAirportChoice);
  assert.deepEqual(s.discovery.airportQuestion, before.airportQuestion);
  assert.equal(s.draft.destination, undefined);
  assert.match(clarification, /沒認出.*先保留東京.*成田.*羽田/);
  await say(s, '我要選東京的成田機場。');
  assert.equal(s.discovery.destinationCity, '東京');
  assert.equal(s.draft.destination, 'NRT');
  assert.equal(s.discovery.airportQuestion, undefined);
});
test('pending airport question binds an unknown short answer even if a model proposes the wrong place role', async () => {
  const s = createSession();
  await say(s, '從桃園到東京，2026-11-12，一人，經濟艙');
  const origin = s.draft.origin, question = structuredClone(s.discovery.airportQuestion);
  const clarification = applyUnderstanding(s, { originPlace: '陳田機場' }, now, '陳田機場');
  assert.equal(s.draft.origin, origin);
  assert.equal(s.discovery.destinationCity, '東京');
  assert.deepEqual(s.discovery.airportQuestion, question);
  assert.match(clarification, /沒認出/);
});
test('exact four-turn business demo preserves airport, meetings, activities and scoped budget', async () => {
  const s = createSession();
  const first = await say(s, demo[0]);
  assert.equal(s.trip.destination, 'NRT');
  assert.equal(s.trip.date, '2026-11-12');
  assert.equal(s.trip.travelers, 1);
  assert.equal(s.trip.cabin, 'economy');
  assert.equal(s.discovery.durationDays, 5);
  assert.ok(first.tools.some(tool => tool.tool === 'search_flights'));
  assert.match(first.text, /第 5 天/);
  const tools = s.toolUnits;
  await say(s, demo[1]);
  assert.equal(s.discovery.destinationCity, '東京');
  assert.equal(s.discovery.roundTripRequested, undefined);
  assert.equal(s.discovery.planning.airportTransfers, true);
  assert.deepEqual(s.discovery.planning.meetings.map(({ day, start, end, location }) => ({ day, start, end, location })), [
    { day: 2, start: '09:00', end: '17:00', location: '東京車站附近' },
    { day: 3, start: '09:00', end: '17:00', location: '東京車站附近' }
  ]);
  await say(s, demo[2]);
  assert.equal(s.trip.destination, 'NRT');
  assert.equal(s.trip.lowWalking, true);
  assert.ok(s.offers.size > 0, 'mobility edits retain searched flight candidates');
  assert.equal(s.trip.budget, null, 'combined budget is not airfare-only');
  assert.equal(s.discovery.planning.budget.total, 40000);
  assert.deepEqual(s.discovery.planning.budget.includes, ['flight', 'lodging']);
  assert.deepEqual(s.discovery.planning.budget.separate, ['transport', 'meals']);
  assert.equal(s.discovery.planning.lodging.nights, 4);
  assert.equal(s.discovery.planning.activities[0].day, 4);
  assert.equal(s.discovery.planning.activities[0].period, 'afternoon');
  const summary = await say(s, demo[3]);
  for (const value of [/第 5 天/, /09:00–17:00/, /東京車站/, /淺草/, /40,000/, /4晚/, /交通/, /餐費/, /待確認/]) assert.match(summary.text, value);
  assert.equal(s.toolUnits, tools, 'edits and summary must not search again');
  assert.equal(s.selected, null); assert.equal(s.quote, null); assert.equal(s.bookings.size, 0);
});

test('ordinary text answers each current request directly without continuation or repeated preambles', async () => {
  const s = createSession(), replies = [];
  for (const message of demo) {
    const response = await chat(s, { message, delivery: 'text', requestId: randomUUID() }, env, { now });
    assert.equal(response.state.moreReply, false);
    assert.doesNotMatch(response.text, /說「繼續」|已查得.*候選/);
    replies.push(response.text);
  }
  assert.match(replies[0], /第 5 天/);
  assert.match(replies[0], /DEMO-FLT-.*[\s\S]*TWD/);
  assert.match(replies[1].split('\n')[0], /第2、3天09:00–17:00.*開會/);
  assert.match(replies[1], /八重洲|日本橋/);
  assert.match(replies[1], /鐵路|巴士/);
  assert.doesNotMatch(replies[1], /目前旅程|航班需求|第 1 天/);
  assert.match(replies[2].split('\n')[0], /機票.*4晚住宿.*40,000/);
  assert.match(replies[2], /31,100|30,900/);
  assert.match(replies[2], /預算假設/);
  assert.match(replies[3], /第 5 天.*[\s\S]*待確認/);
  assert.equal(new Set(replies.map(reply => reply.split('\n')[0])).size, 4);
  const units = s.toolUnits, ids = [...s.offers.keys()];
  const options = await chat(s, { message: 'give me the ticket option', delivery: 'text' }, env);
  assert.equal(options.state.activeAgent, 'flight');
  assert.match(options.text, /DEMO-FLT-[\s\S]*2026-11-12[\s\S]*TWD/);
  assert.equal(options.state.moreReply, false);
  assert.deepEqual([...s.offers.keys()], ids);
  assert.equal(s.toolUnits, units, 'existing current offers are displayed without a new search');
  assert.equal(s.history.at(-1).agent, 'flight');
  const prices = await chat(s, { message: 'how much?', delivery: 'text' }, env);
  assert.match(prices.text, /TWD/);
  assert.equal(prices.state.activeAgent, 'flight');
  assert.equal(s.toolUnits, units);
});

test('summary then full five days then day2 detail preserves meetings, duration and canonical flight information', async () => {
  const s = createSession();
  for (const message of demo.slice(0, 3)) await chat(s, { message }, env, { now });
  const meetings = structuredClone(s.discovery.planning.meetings), units = s.toolUnits;
  assert.equal(s.discovery.durationDays, 5, 'fourth-day activity must not shorten the trip');
  s.replyPages = [{ text: 'obsolete hidden response' }];
  const summary = await chat(s, { message: '整理目前行程、建議行程和機票資訊', delivery: 'voice' }, env, { now });
  assert.match(summary.text, /第 5 天/);
  assert.match(summary.text, /DEMO-FLT-[\s\S]*TWD/);
  assert.equal(summary.speech.detail, 'summary');
  assert.ok(summary.speech.text.length < summary.text.length / 2);
  const detailed = await chat(s, { message: '五天全部展開', delivery: 'voice' }, env, { now });
  for (let day = 1; day <= 5; day++) assert.match(detailed.text, new RegExp(`第 ${day} 天`));
  assert.match(detailed.text, /09:00–17:00 東京車站附近開會/);
  assert.match(detailed.text, /淺草/);
  assert.match(detailed.text, /建議：會前.*早餐/);
  assert.equal(detailed.speech.text, detailed.text);
  const day2 = await chat(s, { message: '第二天詳細一點', delivery: 'voice' }, env, { now });
  assert.match(day2.text, /^第 2 天.*\n建議：會前.*早餐/);
  assert.doesNotMatch(day2.text, /第 [1345] 天|另計|總預算/);
  assert.equal(day2.speech.text, day2.text);
  for (const result of [summary, detailed, day2]) {
    assert.equal(result.state.moreReply, false);
    assert.doesNotMatch(result.text, /繼續|obsolete/);
  }
  assert.equal(s.discovery.durationDays, 5);
  assert.deepEqual(s.discovery.planning.meetings, meetings);
  assert.equal(s.replyPages.length, 0);
  assert.equal(s.toolUnits, units);
  assert.equal(s.bookings.size, 0);
});

test('Foundry presentation uses semantic intent and existing calls with explicit complete-answer policy and usage', async () => {
  const s = createSession();
  for (const message of demo.slice(0, 3)) await chat(s, { message }, env, { now });
  const slots = Object.fromEntries(['originPlace', 'destinationPlace', 'country', 'dateExpression', 'travelerExpression',
    'cabinExpression', 'budgetExpression', 'walkingExpression', 'durationExpression', 'interestExpression',
    'companionExpression', 'returnDateExpression', 'flexibleExpression', 'timeExpression'].map(key => [key, null]));
  const requests = [];
  let focus = 2, advice = JSON.stringify({ days: [{ day: 2, advice: '會議前在住宿附近用早餐，會後用餐並休息；交通時間待確認。' }] });
  const liveEnv = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: 'https://demo.services.ai.azure.com/api/projects/test',
    FOUNDRY_INTENT_AGENT: 'intent', FOUNDRY_PLANNER_AGENT: 'planner', FOUNDRY_FLIGHT_AGENT: 'flight', FOUNDRY_PRICE_AGENT: 'price' };
  const dependencies = {
    now, credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (body.agent_reference.name === 'intent') {
        assert.match(JSON.parse(body.input[0].content).context.presentationPolicy, /畫面永遠完整/);
        assert.match(JSON.parse(body.input[0].content).context.presentationPolicy, /不延續上輪朗讀深度/);
      } else {
        assert.equal(body.tool_choice, 'none');
        assert.match(JSON.parse(body.input[0].content).context.task, /不自行指定午休/);
      }
      assert.equal(body.instructions, undefined, 'agent_reference does not allow per-request instructions');
      return Response.json({ id: 'response-' + requests.length, status: 'completed', usage: { total_tokens: 30 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: body.agent_reference.name === 'intent'
          ? JSON.stringify({ role: 'planner', reply: '以下詳述行程。', presentation: { detail: 'detailed', day: focus, flights: false }, slots })
          : advice }] }] });
    }
  };
  const result = await chat(s, { message: '把下一個工作日說仔細些', delivery: 'voice' }, liveEnv, dependencies);
  assert.match(result.text, /^第 2 天.*09:00–17:00/);
  assert.equal((result.text.match(/第 2 天/g) ?? []).length, 1);
  assert.match(result.text, /建議（交通與場所資訊待核驗）：會議前/);
  assert.equal(result.speech.detail, 'detailed');
  assert.equal(s.discovery.durationDays, 5);
  assert.equal(requests.length, 2, 'same intent + planner calls, no extra summarizer');
  assert.equal(s.cloudRequests, 2); assert.equal(s.cloudTokens, 60);
  assert.deepEqual(result.diagnostics.modelCalls.map(call => call.role), ['intent', 'planner']);
  const meetings = structuredClone(s.discovery.planning.meetings);
  for (const invalid of ['not JSON', { days: [] }, { days: [{ day: 3, advice: '錯誤日期' }] },
    { days: [{ day: 2, advice: 'x'.repeat(501) }] }, { days: [{ day: 2, advice: 'one' }, { day: 2, advice: 'two' }] }]) {
    advice = typeof invalid === 'string' ? invalid : JSON.stringify(invalid);
    await assert.rejects(() => chat(s, { message: '第二天詳細一點' }, liveEnv, dependencies), { code: 'FOUNDRY_PLAN' });
    assert.deepEqual(s.discovery.planning.meetings, meetings);
  }
  focus = null;
  advice = JSON.stringify({ days: Array.from({ length: 5 }, (_, index) => ({ day: index + 1, advice: `本日建議${index + 1}，具體時間待確認。` })) });
  const full = await chat(s, { message: '五天全部展開' }, liveEnv, dependencies);
  for (let day = 1; day <= 5; day++) {
    assert.equal((full.text.match(new RegExp(`第 ${day} 天`, 'g')) ?? []).length, 1);
    assert.match(full.text, new RegExp(`本日建議${day}`));
  }
  assert.equal(full.speech.text, full.text);
});

test('nine short voice-like turns preserve customer context and route current task', async () => {
  const s = createSession();
  for (const text of ['你好你聽得到我說話嗎？', '我要去東京出差五天', '成田機場', '2026/11/12從桃園出發',
    '一位成人經濟艙', '第二天和第三天上午九點到下午五點在東京車站附近開會',
    '機場往返交通也安排一下', '第四天下午去淺草買伴手禮，不要太多步行', '請整理五天行程']) await say(s, text);
  assert.equal(s.trip.date, '2026-11-12'); assert.equal(s.trip.destination, 'NRT');
  assert.equal(s.discovery.planning.meetings.length, 2);
  assert.equal(s.discovery.planning.activities[0].day, 4);
  assert.equal(s.discovery.roundTripRequested, undefined);
  assert.equal(s.toolUnits, 0);
});

test('both airports and short slash return-date answer bind to the pending slot on intent route', async () => {
  const s = createSession();
  await say(s, '東京出差五天');
  await say(s, '都可以');
  await say(s, '2026/11/12桃園出發一人，經濟艙，來回機票');
  assert.equal(s.discovery.followUpQuestion.field, 'returnDate');
  await say(s, '2026/11/17');
  assert.deepEqual(s.trip.destinationAirports, ['NRT', 'HND']);
  assert.equal(s.trip.date, '2026-11-12');
  assert.equal(s.trip.returnDate, '2026-11-17');
  assert.equal(s.discovery.followUpQuestion, undefined);
  await say(s, '搜尋航班');
  const units = s.toolUnits;
  const prices = await chat(s, { message: 'how much?', delivery: 'text' }, env);
  assert.equal(s.toolUnits, units);
  assert.match(prices.text, /TWD/);
  assert.match(prices.text, /機場偏好.*成田.*羽田/);
  assert.doesNotMatch(prices.text, /機場：。/);
});

test('central merge protects destination from locality proposals and rejects stale proposals', () => {
  const s = createSession();
  applyUnderstanding(s, { destinationPlace: '成田', originPlace: '桃園', dateExpression: '2026/11/12',
    travelerExpression: '一人', cabinExpression: '經濟艙' }, now, '桃園到成田2026/11/12一人經濟艙');
  const version = s.contextVersion;
  applyUnderstanding(s, { destinationPlace: '淺草', country: '日本' }, now, '第四天下午在淺草自由活動');
  assert.equal(s.trip.destination, 'NRT');
  const snapshot = JSON.stringify(s.draft);
  assert.throws(() => applyUnderstanding(s, { destinationPlace: '大阪' }, now, '改去大阪', { expectedVersion: version }), { code: 'STALE_JOURNEY' });
  assert.equal(JSON.stringify(s.draft), snapshot);
});

test('date correction invalidates affected offers while planning edits preserve flight candidates', async () => {
  const s = createSession();
  await say(s, demo[0]);
  const offers = [...s.offers.keys()];
  await say(s, demo[1]);
  assert.deepEqual([...s.offers.keys()], offers);
  await say(s, '出發日期改成2026/11/13');
  assert.equal(s.trip.date, '2026-11-13');
  assert.equal(s.offers.size, 0);
  assert.equal(s.quote, null); assert.equal(s.consent, null);
  assert.equal(s.itinerary, null);
  assert.equal(resolveDate('2026/02/30', '2026-01-01').status, 'invalid');
});

test('per-role projections exclude old prices/results/history and expose only scoped planning', async () => {
  const s = createSession();
  await say(s, demo[0]);
  await say(s, demo[1]);
  s.quote = { privateOldQuote: true }; s.history.push({ role: 'assistant', text: 'old fare' });
  const intent = projectContext('intent', s), planner = projectContext('planner', s), flight = projectContext('flight', s);
  assert.equal(intent.offers, undefined); assert.equal(intent.quote, undefined);
  assert.equal(planner.history, undefined); assert.equal(planner.quote, undefined);
  assert.equal(flight.planning, undefined); assert.equal(flight.history, undefined);
  assert.equal(flight.trip.destination, 'NRT');
  assert.equal(planningUpdates({}, demo[1]).meetings.length, 2);
  assert.equal(planner.planning.meetings[0].evidence, undefined);
  assert.ok(intent.recent.every(message => message.length <= 300));
});

test('explicit cancellations remove only targeted planning constraints', () => {
  let p = planningUpdates({}, demo[1]);
  p = planningUpdates(p, demo[2]);
  p = planningUpdates(p, '取消第三天的會議');
  assert.deepEqual(p.meetings.map(block => block.day), [2]);
  p = planningUpdates(p, '取消第四天下午的淺草活動');
  assert.equal(p.activities.length, 0);
  assert.equal(p.airportTransfers, true);
  p = planningUpdates(p, '取消機場往返交通');
  assert.equal(p.airportTransfers, false);
  p = planningUpdates(p, '取消總預算');
  assert.equal(p.budget, undefined);
  assert.equal(p.lodging.nights, 4);
  assert.equal(planningUpdates(p, '不是出差，改成旅遊').purpose, '休閒旅遊');
});

test('different cities, implicit afternoon end-time and non-script activities preserve planning scope', () => {
  let p = planningUpdates({}, '第二天下午一點到五點在梅田開會');
  assert.equal(p.meetings[0].start, '13:00');
  assert.equal(p.meetings[0].end, '17:00');
  assert.equal(p.meetings[0].location, '梅田');
  p = planningUpdates(p, '第三天下午逛心齋橋，少走路；機票加三晚住宿合計TWD50000，餐費和市區交通另算');
  assert.equal(p.activities[0].day, 3);
  assert.match(p.activities[0].description, /心齋橋/);
  assert.equal(p.budget.total, 50000);
  assert.deepEqual(p.budget.includes, ['flight', 'lodging']);
  assert.equal(p.lodging.nights, 3);
  p = planningUpdates(p, '不要住新宿，飯店想住梅田，離會議近一點');
  assert.equal(p.lodging.area, '梅田');
  p = planningUpdates(p, '為什麼建議住這一帶？');
  assert.equal(p.lodging.area, '梅田', 'rationale questions must not change confirmed lodging');
  p = planningUpdates(p, '第二天下午一點到五點在梅田開會，晚上想吃大阪燒。');
  assert.ok(p.activities.some(item => item.day === 2 && item.period === 'evening' && /大阪燒/.test(item.description)));
});

test('planning corrections replace only matching blocks; unrelated preferences do not change destination', async () => {
  const s = createSession();
  await say(s, demo[0]); await say(s, demo[1]);
  await say(s, '第三天改成上午十點到下午四點在東京車站附近開會');
  assert.equal(s.discovery.planning.meetings.find(block => block.day === 2).start, '09:00');
  assert.equal(s.discovery.planning.meetings.find(block => block.day === 3).start, '10:00');
  assert.match(planningLead(s, '請整理行程', { summary: true }), /第2天09:00–17:00.*第3天10:00–16:00/);
  applyUnderstanding(s, { destinationPlace: '大阪' }, now, '我也喜歡大阪美食');
  assert.equal(s.trip.destination, 'NRT');
  await say(s, '機票和四晚住宿的總預算 TWD 40,000，交通和餐費另計');
  assert.equal(s.discovery.planning.budget.total, 40000);
  await assert.rejects(chat(s, { message: '改去大阪', contextVersion: 0 }, env), { code: 'STALE_JOURNEY' });
  assert.equal(s.trip.destination, 'NRT');
});

test('a delayed intent proposal cannot overwrite a newer context version', async () => {
  const s = createSession();
  const foundry = { APP_MODE: 'foundry', FOUNDRY_PROJECT_ENDPOINT: 'https://test.services.ai.azure.com/api/projects/test',
    ...Object.fromEntries(['intent', 'planner', 'flight', 'price'].map(role => [`FOUNDRY_${role.toUpperCase()}_AGENT`, role])) };
  const slots = Object.fromEntries(['originPlace', 'destinationPlace', 'country', 'dateExpression', 'travelerExpression',
    'cabinExpression', 'budgetExpression', 'walkingExpression', 'durationExpression', 'interestExpression', 'companionExpression',
    'returnDateExpression', 'flexibleExpression', 'timeExpression'].map(key => [key, null]));
  await assert.rejects(chat(s, { message: '改去大阪' }, foundry, {
    credential: { getToken: async () => ({ token: 'offline' }) },
    fetch: async () => {
      s.contextVersion++;
      return Response.json({ id: 'offline', status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({ role: 'planner', reply: '收到', slots: { ...slots, destinationPlace: '大阪' } })
      }] }] });
    }
  }), { code: 'STALE_JOURNEY' });
  assert.equal(s.discovery.destinationCity, null);
});
