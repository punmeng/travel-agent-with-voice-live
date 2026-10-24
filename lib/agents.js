import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { airports, knowledge } from './dataset.js';
import { callTool, fail, publicState, setTrip, consentSchema, selectOffer, consentToQuote, purchase } from './core.js';
import { foundryConfig, invokeFoundry } from './foundry.js';
import { applyUnderstanding, airportChoiceReply, mockUnderstanding, understandFoundry, todayTaipei } from './conversation.js';
import { checkoutForQuote } from './checkout.js';
import { enqueueReply, nextReply, markQuote, quoteWasPresented, replyState } from './replies.js';
import { MAX_TURNS } from './limits.js';
import { resolveCityAirports } from './city-airports.js';
import { checkVersion, planningLead, presentationRequest, projectContext, savedPlan, turnWork } from './journey.js';

export const chatSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  trip: z.unknown().optional(), action: z.enum(['chat', 'plan', 'search', 'price']).default('chat'),
  requestId: z.string().uuid().optional(),
  offerIds: z.array(z.string().uuid()).max(6).optional(),
  quoteContext: consentSchema.omit({ accepted: true }).nullable().optional(),
  contextVersion: z.number().int().min(0).optional(),
  delivery: z.enum(['text', 'voice']).default('voice')
}).strict();
const cabinNames = { economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙' };
const money = total => `TWD ${total.toLocaleString('zh-TW')}`;
const confirmation = /^(?:確認目前報價|同意目前報價|(?:我)?(?:同意|接受)(?:這個|目前(?:的)?)(?:報價|價格)[，,]?\s*(?:請)?(?:給我|提供|產生)(?:一個)?(?:模擬)?(?:結帳|付款)連結|confirm current quote)[。！!]?$/i;
const selection = /^(?:我想|我要|我|幫我|麻煩|請)?選(?:擇)?第?([一二三四五六七八九十\d]+)(?:班|個|項)?(?:就好)?[。！!]?$/;
const ambiguousConsent = message => /^(?:確認|同意)[。！!]?$/i.test(message) ||
  /同意|接受.*(?:報價|價格)|確認目前報價|confirm current quote/i.test(message);
const labels = { origin: '您想從哪個城市出發？', destination: '您想去哪個城市？', date: '您預計哪一天出發？', travelers: '這趟一共幾位成人同行？', cabin: '找機票時，您偏好經濟艙、豪華經濟艙，還是商務艙？' };
export function intentAgent(message, action) {
  if (confirmation.test(message)) return { role: 'price', reason: 'confirm' };
  if (selection.test(message)) return { role: 'price', reason: 'select' };
  if (action !== 'chat') return { role: { plan: 'planner', search: 'flight', price: 'price' }[action], reason: action };
  if (/航點|航線|時刻資料|有哪些.*(?:航班|城市|機場)|(?:介紹|說明|資料|知識).*(?:航班|時刻)|(?:航班|時刻).*(?:介紹|知識)|有飛|routes|schedules/i.test(message) &&
    !/搜尋|查機位|重新報價|幫我訂|買票/.test(message)) return { role: 'flight', reason: 'knowledge' };
  if (/票價|價格|購買|付款|報價|買票|price|buy|pay/i.test(message)) return { role: 'price', reason: 'price' };
  if (/航班|機位|班機|機票|飛機|flight|ticket|search/i.test(message)) return { role: 'flight', reason: 'search' };
  if (/行程|規劃|旅行|旅遊|推薦|安排|賞楓|賞櫻|plan|travel/i.test(message)) return { role: 'planner', reason: 'plan' };
  return { role: 'intent', reason: 'discover' };
}
export function plannerAgent(trip, discovery = {}) {
  const city = discovery.destinationCity ? resolveCityAirports({ query: discovery.destinationCity, countryCode: null }) : null;
  const destination = trip?.destination ?? (city?.status === 'matched' ? city.cities[0].airports[0].iata : undefined);
  const places = knowledge.destinations[destination] ?? knowledge.destinations.default;
  const count = Math.min(14, discovery.durationDays ?? 3);
  const cityName = airports.find(a => a.code === destination)?.city ?? discovery.destinationCity ?? discovery.country ?? '目的地';
  return {
    title: `${cityName}・${count === 3 ? '三' : count}日靈感提案`,
    mock: true, lowWalking: trip?.lowWalking ?? false,
    days: Array.from({ length: count }, (_, i) => ({
      day: i + 1, title: i === count - 1 ? places.at(-1) : places[i] ?? '彈性在地體驗與休息（場所與營業資訊待確認）',
      detail: trip?.lowWalking ? '建議短距離接駁、安排坐下休息；無障礙設施請另行確認。' : '一天一個主題，保留交通與休息時間。'
    })),
    guidance: knowledge.guidance, approvedWebsites: knowledge.approvedWebsites
  };
}
function tripText(t) {
  const names = key => (t[`${key}Airports`] ?? [t[key]]).map(code => airports.find(a => a.code === code).name).join('／');
  return `目前旅程：${names('origin')} → ${names('destination')}，${t.date}${t.returnDate ? ` 出發、${t.returnDate} 回程` : ' 單程'}，${t.travelers} 位成人，${cabinNames[t.cabin]}；${t.flexibleDays ? '比較前後一天' : '固定日期'}，${t.lowWalking ? '少步行' : '一般步調'}，${t.budget ? `機票總預算 ${money(t.budget)}` : '未設定機票預算'}。`;
}
function offerText(o, index, budget) {
  const f = o.flight;
  const leg = flight => `${flight.flightNumber}\n${airports.find(a => a.code === flight.origin).name} ${flight.departureLocal} → ${airports.find(a => a.code === flight.destination).name} ${flight.arrivalLocal}\n時區 ${flight.originTimezone}／${flight.destinationTimezone}`;
  return `${index + 1}. ${leg(f)}${o.returnFlight ? `\n回程 ${leg(o.returnFlight)}` : ''}\n${o.travelers}成人${cabinNames[o.cabin]}，${o.returnFlight ? '來回' : '單程'}含稅總額 ${money(o.total)}${budget && o.total > budget ? '（超預算）' : ''}；有效至 ${o.expiresAt}。`;
}
function quoteText(q) {
  return `模擬確認價：${money(q.total)}（成人含稅總額）${q.priceChanged ? `\n原 ${money(q.previousTotal)} → 現 ${money(q.total)}；舊同意失效。` : ''}\n版本${q.version}；有效至 ${q.expiresAt}。\n不收款、不訂位、不開票。核對後說「確認目前報價」，同意此金額、版本與期限。`;
}
export async function chat(session, raw, env = process.env, dependencies = {}) {
  dependencies.signal?.throwIfAborted();
  const args = chatSchema.parse(raw);
  const hadPlan = Boolean(session.itinerary);
  const fingerprint = JSON.stringify(args);
  const previous = args.requestId && session.chatRequests.get(args.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '此訊息識別碼已用於另一個請求。', 409);
    return previous.response;
  }
  checkVersion(session, args.contextVersion);
  session.replyPages = [];
  if (session.turns >= MAX_TURNS) fail('TURN_LIMIT', `已達 ${MAX_TURNS} 回合上限，請開啟新旅程。`, 429);
  const greeting = args.action === 'chat' && args.trip === undefined && (
    /^(?:(?:你好|您好|哈囉|嗨)[，,、\s]*)?(?:你|您)?(?:聽得到我說話嗎|聽得到我的聲音嗎|聽得到嗎)[？?。！!\s]*$/.test(args.message) ||
    /^(?:你好|您好|哈囉|嗨|hello|hi)[。！!，,\s]*$/i.test(args.message));
  if (greeting || /^(?:繼續|下一段|下一頁|還有呢|continue|next)[。！!]?$/i.test(args.message)) {
    const role = greeting ? 'intent' : session.activeAgent;
    dependencies.onProgress?.(role);
    session.activeAgent = role;
    const text = greeting ? '您好，我收到您的訊息了。今天想聊什麼呢？' : nextReply(session);
    const response = { text, foundryText: null, itinerary: null, receipt: null, tools: [],
      trace: [{ agent: role, event: greeting ? '回應問候' : '接續內容' }], correlationId: randomUUID(),
      mode: env.APP_MODE === 'foundry' ? 'foundry-with-mock-tools' : 'mock',
      state: replyState(session, publicState(session)) };
    session.history.push({ role: 'user', text: args.message }, { role: 'assistant', agent: role, text });
    session.history = session.history.slice(-40);
    session.turns++;
    response.state.turns = session.turns;
    if (args.requestId) session.chatRequests.set(args.requestId, { fingerprint, response });
    return response;
  }
  dependencies.onProgress?.('intent');
  if (args.trip !== undefined) setTrip(session, args.trip);
  let route = intentAgent(args.message, args.action);
  const work = turnWork(args.message, args.action);
  if (work.prices && !session.selected) {
    const priorNeed = session.history.filter(entry => entry.role === 'user').map(entry => entry.text).reverse()
      .slice(0, 4).find(message => /預算|住宿|飯店|住|航班|機票|機場|flight|ticket|budget|hotel/i.test(message)) ?? '';
    if (/住宿|飯店|住|預算|budget|hotel/i.test(priorNeed)) { work.plan = true; work.costs = true; }
    else if (session.offers.size || session.activeAgent === 'flight' || /航班|機票|機場|flight|ticket/i.test(priorNeed)) {
      work.options = true; work.search = true;
    }
  }
  const planningBefore = JSON.stringify(session.discovery.planning);
  const version = session.contextVersion ?? 0;
  const evidenceStart = session.cloudEvidence?.length ?? 0;
  const pauseSearch = /(?:先不|不要|暫停|停止|取消)(?:再)?(?:找|查|搜尋)/.test(args.message);
  const knowledgeQuestion = route.reason === 'knowledge';
  const config = foundryConfig(env);
  const correlationId = randomUUID();
  let understanding = null, clarification = '';
  let presentation = presentationRequest(args.message);
  const answeringAirport = airportChoiceReply(session, args.message, dependencies.resolver);
  if (!['select', 'confirm'].includes(route.reason)) {
    // Invalid/negative consent is rejected before any model can reinterpret it.
    if (ambiguousConsent(args.message) && !/重新報價/.test(args.message)) {
      fail('AMBIGUOUS_CONSENT', '尚未執行確認。請先核對目前報價，再明確同意；含糊、否定或附帶條件的訊息不執行。', 409);
    }
    if (config && !work.summary) understanding = await understandFoundry(config, session, args.message, correlationId, dependencies);
    presentation = understanding?.presentation ?? presentation;
    if (presentation.detail === 'detailed' && (!presentation.flights || understanding?.role === 'planner')) work.plan = true;
    dependencies.signal?.throwIfAborted();
    checkVersion(session, version);
    clarification = knowledgeQuestion ? '' : applyUnderstanding(session, understanding?.slots ?? mockUnderstanding(session, args.message, dependencies), dependencies.now, args.message, { ...dependencies, expectedVersion: version });
    if (!knowledgeQuestion && JSON.stringify(session.discovery.planning) !== planningBefore &&
        /開會|會議|住宿|飯店|預算|合計|活動|逛|參觀/.test(args.message)) work.plan = true;
    if (understanding && args.action === 'chat' && route.reason !== 'search') route = { role: understanding.role, reason: understanding.role === 'price' ? 'price' : 'discover' };
    if (knowledgeQuestion) route = { role: 'flight', reason: 'knowledge' };
    session.discovery.pendingWork ??= { search: session.discovery.searchRequested ?? false };
    if (work.search) session.discovery.pendingWork.search = true;
    if (work.paused) session.discovery.pendingWork.search = false;
    const shortAnswer = !work.plan && !knowledgeQuestion && !/票價|價格|付款|報價|買票/.test(args.message);
    const resumeSearch = session.discovery.pendingWork.search && shortAnswer;
    session.discovery.searchRequested = !knowledgeQuestion && !pauseSearch && (work.search || resumeSearch);
    if (session.discovery.searchRequested) route = { role: 'flight', reason: 'search' };
    else if (work.plan) route = { role: 'planner', reason: work.summary ? 'summary' : 'plan' };
    else if (!knowledgeQuestion && route.role === 'flight') route = { role: 'intent', reason: 'discover' };
    if (work.summary) session.discovery.pendingWork.search = false;
    if (pauseSearch) route = { role: 'intent', reason: 'discover' };
    if (answeringAirport && !session.discovery.searchRequested && !knowledgeQuestion) route = { role: 'intent', reason: 'discover' };
    if (work.options && session.trip && session.offers.size &&
        [...session.offers.values()].every(offer => Date.parse(offer.expiresAt) > (dependencies.now ?? Date.now()))) {
      route = { role: 'flight', reason: 'options' };
      session.discovery.searchRequested = false;
      session.discovery.pendingWork.search = false;
    }
  }
  session.activeAgent = route.role;
  const turnVersion = session.contextVersion ?? 0;
  dependencies.onProgress?.(route.role);
  const trace = [{ agent: 'intent', event: '已辨識意圖', correlationId }];
  let text, itinerary = null, tools = [], receipt = null;
  dependencies.signal?.throwIfAborted();
  if (['confirm', 'select'].includes(route.reason) || route.role === 'price') dependencies.onTransaction?.();
  if (route.reason === 'confirm') {
    if (!quoteWasPresented(session)) fail('QUOTE_NOT_PRESENTED', '請先在畫面閱讀完整確認價，再明確接受。', 409);
    if (!args.requestId || !args.quoteContext) fail('QUOTE_CONTEXT_REQUIRED', '請先閱讀重新報價的完整內容，再輸入「確認目前報價」。', 409);
    consentToQuote(session, { ...args.quoteContext, accepted: true });
    receipt = purchase(session, { quoteId: args.quoteContext.quoteId, idempotencyKey: args.requestId });
    const checkout = checkoutForQuote(session, receipt);
    text = `模擬確認總額 ${money(receipt.total)}。\n模擬識別碼：${receipt.id}\n結帳連結：${checkout.path}\n有效至 ${checkout.expiresAt}；改行程或重報價即失效。不收款、不訂位、不開票。`;
  } else if (route.reason === 'select') {
    const offers = [...session.offers.values()];
    if (!args.offerIds || JSON.stringify(args.offerIds) !== JSON.stringify(offers.map(o => o.id))) fail('STALE_OPTIONS', '航班清單已更新，請先重新搜尋並閱讀目前編號。', 409);
    const number = selection.exec(args.message)[1];
    const index = /^\d+$/.test(number) ? Number(number) - 1 : '一二三四五六七八九十'.indexOf(number);
    if (index < 0 || index >= offers.length) fail('INVALID_SELECTION', '沒有這個編號，請輸入目前清單中的一個編號，例如「選第二班」。');
    if (!session.presentedOffers?.has(offers[index].id)) fail('OPTION_NOT_PRESENTED', '請先在畫面閱讀該航班與總額，再選擇。', 409);
    const offer = selectOffer(session, offers[index].id);
    text = `已選第 ${index + 1} 班，${offer.travelers} 人${cabinNames[offer.cabin]}，合成候選總額 ${money(offer.total)}。\n說「重新報價」核對最新價格；尚未訂位或付款。`;
  } else if (route.reason === 'knowledge') {
    text = '航班知識是合成靜態快照，不是即時時刻或可售機位。想了解哪條航線或城市呢？';
  } else if (route.role === 'planner' || (route.role !== 'flight' && !session.trip && session.discovery.destinationCity && /安排|行程|規劃/.test(args.message))) {
    session.stage = 'Plan'; itinerary = plannerAgent(session.trip ?? session.draft, session.discovery);
    text = `${itinerary.title}（合成靈感）\n${itinerary.days.map(d => `第 ${d.day} 天：${d.title}`).join('\n')}\n${itinerary.lowWalking ? '少步行、多休息。' : ''}交通、營業與無障礙待核驗；未預約。`;
  } else if (!session.trip) {
    const missing = ['origin', 'destination', 'date',
      ...((session.discovery.roundTripRequested || session.discovery.returnDatePreference) ? ['returnDate'] : []),
      'travelers', 'cabin'].filter(key => session.draft[key] === undefined);
    const pendingAirport = session.discovery[`${missing[0]}AirportChoice`];
    const airportQuestion = pendingAirport?.candidates.length > 1 && pendingAirport.accepted.length === 0
      ? `${pendingAirport.city}可使用${pendingAirport.candidates.map(code => airports.find(a => a.code === code).name).join('或')}，您偏好哪一座？兩座都可以。` : null;
    const nextQuestion = airportQuestion ?? (missing[0] === 'date' && session.discovery.datePreference
      ? `已記下您偏好的「${session.discovery.datePreference}」，找機票需要確定一天，您大概想哪天出發？`
      : labels[missing[0]]) ?? ((session.discovery.roundTripRequested || session.discovery.returnDatePreference) && !session.draft.returnDate
      ? '回程打算哪一天呢？可以直接說月份和日期。' : '您最期待這趟旅行的哪種體驗？');
    text = clarification || (session.discovery.followUpQuestion ? nextQuestion : understanding?.reply) ||
      (session.discovery.country ? `已記下想去${session.discovery.country}。您比較想城市散策、美食，還是賞楓？` :
        `已記下您的旅行想法與偏好。${nextQuestion}`);
    if (route.role === 'flight') text = clarification.startsWith('好，')
      ? `${clarification}${nextQuestion}` : clarification || nextQuestion;
    if (route.role === 'flight') session.discovery.followUpQuestion = {
      field: missing[0], ...(airportQuestion ? { ...session.discovery[`${missing[0]}AirportChoice`], key: missing[0] } : {})
    };
    if (route.role === 'flight' && airportQuestion && (!clarification || clarification.startsWith('好，'))) {
      session.discovery.airportQuestion = { key: missing[0], city: pendingAirport.city, candidates: pendingAirport.candidates };
    }
    if (answeringAirport && route.role !== 'flight') text = `${clarification}想先聊行程，還是接著找機票？`;
  } else if (route.role === 'flight' && route.reason === 'options') {
    text = '';
  } else if (route.role === 'flight') {
    delete session.discovery.followUpQuestion;
    const { origin, destination, date, travelers, cabin, flexibleDays } = session.trip;
    const result = await callTool(session, 'flight', 'search_flights', { origin, destination, date, travelers, cabin, flexibleDays });
    tools.push(result);
    session.discovery.searchRequested = false;
    session.discovery.pendingWork.search = false;
    text = '';
  } else if (route.role === 'price') {
    if (ambiguousConsent(args.message) && !/重新報價/.test(args.message)) {
      fail('AMBIGUOUS_CONSENT', '尚未執行確認。只有在閱讀目前確認價後，單獨輸入「確認目前報價」才表示明確同意；其他文字不視為同意。', 409);
    }
    if (session.selected) {
      tools.push(await callTool(session, 'price', 'reprice_offer', { offerId: session.selected }));
      text = quoteText(session.quote);
    } else text = '請先輸入「搜尋航班」，閱讀編號清單後輸入例如「選第二班」，再輸入「重新報價」。所有價格皆為合成資料。';
  } else {
    text = understanding?.reply ?? `${tripText(session.trip)}\n您可直接輸入「規劃行程」、「搜尋航班」或修改條件，例如「改成 3 人，商務艙」。所有選擇與確認均透過聊天完成。`;
  }
  let dayAdvice = null;
  // Selection and consent never pass through model calls.
  if (config && !['select', 'confirm'].includes(route.reason)) {
    const context = { correlationId, message: args.message, today: todayTaipei(dependencies.now), timezone: 'Asia/Taipei',
      state: projectContext(route.role, session),
      knowledge: { guidance: knowledge.guidance, approvedWebsites: knowledge.approvedWebsites },
      task: `自然接續旅行對話；偏好與同行者見discovery，請依durationDays安排實際要求天數，未指定才用三日靈感。可在尚未確定日期或機場前規劃，不催促填完條件。日期模糊時不要挑一天；交通時間/營業/無障礙未核驗要明說，所有航班價格仍合成。搜尋僅在state.trip完整時允許，模型不可執行選班/同意/交易。用file_search參考已掛載合成知識並引用來源。` };
    if (route.reason === 'knowledge') {
      text = await invokeFoundry(config, 'flight', session, { ...context,
        task: '用file_search查已掛載的合成航班／航線靜態知識，直接回答資訊問題並簡短引用；標示合成快照，非即時、非可售。不需要日期、人數、艙等或完整trip才能介紹，不呼叫functions、不搜尋可售票、不改交易。' },
      { ...dependencies, toolChoice: { type: 'file_search' }, readOnlyKnowledge: true });
    } else if (route.role === 'planner') {
      if (!work.summary && !work.costs) {
        const days = presentation.day ? [presentation.day] : Array.from({ length: session.discovery.durationDays ?? 3 }, (_, i) => i + 1);
        if (days.some(day => day > (session.discovery.durationDays ?? 3))) fail('PLANNING_DAY', '指定日期超出目前行程天數，請先確認要詳述哪一天。');
        text = await invokeFoundry(config, 'planner', session, { ...context, presentation,
          task: presentation.detail === 'detailed'
            ? `只輸出JSON {"days":[{"day":1,"advice":"繁體中文建議段落"}]}。days必須正好包含${JSON.stringify(days)}，不增加其他日期。每一天只給80–180字實用建議（最多500字），不要重複已確認清單、標題或整趟概覽；後端會將建議併在該日已存會議／活動後。會議開始至結束整段保留，不自行指定午休或切分上下午會議；會中餐飲依主辦單位實際休息安排，其他建議放會前會後。依已存景點、少步行與住宿偏好給動線、用餐、休息建議，不猜新地點為已確認，不輸出金額或飯店空房，不邀請下輪繼續。未知時刻/營業/交通寫待確認。`
            : '直接針對message這次要求補充兩三句有用的建議，開頭回答目前的問題，不重述整趟旅程或固定前言。依state旅程事實，不要輸出金額、重複已知問題或邀請重排行程；後端會呈現已保存日程與預算。會議時段不可排活動；市內景點不是航班目的地。不要宣稱查過飯店庫存、即時房價或預約。' },
        { ...dependencies, ...(presentation.detail === 'detailed' ? { toolChoice: 'none' } : {}) });
        if (presentation.detail === 'detailed') {
          try {
            const parsed = z.object({ days: z.array(z.object({ day: z.number().int(), advice: z.string().trim().min(1).max(500) }).strict()).max(14) }).strict().parse(JSON.parse(text));
            if (JSON.stringify(parsed.days.map(item => item.day)) !== JSON.stringify(days)) throw new Error('Requested days differ');
            dayAdvice = Object.fromEntries(parsed.days.map(item => [item.day, item.advice]));
          } catch {
            fail('FOUNDRY_PLAN', '行程建議格式或日期範圍不完整，請重試；已保存的會議與旅程保留。', 502);
          }
        }
      }
    } else if (!session.trip) {
      text = route.role === 'flight' || answeringAirport || clarification || session.discovery.followUpQuestion ? text : understanding?.reply ?? text;
    } else if (['flight', 'price'].includes(route.role) && !work.plan && route.reason !== 'options') {
      // Keep specialist execution and diagnostics, but never replace canonical fares with model prose.
      await invokeFoundry(config, route.role, session, context, { ...dependencies, toolChoice: 'none' });
    }
  }
  let planningText = null, planningDetails = null;
    if (work.plan) {
      itinerary ??= plannerAgent(session.trip ?? session.draft, session.discovery);
      const authoritative = savedPlan(session, tools.find(tool => tool.tool === 'search_flights'), dependencies.now, { ...presentation, dayAdvice });
      planningText = planningLead(session, work.costs ? '預算' : args.message, { summary: work.summary, costs: work.costs,
        flightResult: tools.find(tool => tool.tool === 'search_flights'), now: dependencies.now });
      const details = presentation.detail === 'detailed' || !hadPlan || work.summary ? authoritative :
        work.costs || /預算|budget|合計|上限|控制在|以內/i.test(args.message) ? authoritative.split('\n').filter(line =>
          /^交通與餐費|^住宿目前|^少步行/.test(line)).join('\n') : '';
      if (route.role === 'planner') {
        text = `${details}${config && !work.summary && !work.costs && presentation.detail !== 'detailed' ? `\n${text}` : ''}`.trim();
      } else {
        dependencies.onProgress?.('planner');
        const suggestion = config && !work.summary ? await invokeFoundry(config, 'planner', session, {
          correlationId, state: projectContext('planner', session),
          task: '只補充兩句住宿區域與機場交通建議，不重寫日程、預算或航班；依已保存的會議與少步行偏好，不宣稱即時房價或預約。'
        }, dependencies) : '';
        planningDetails = `${details}${suggestion ? `\n${suggestion}` : ''}`.trim();
        trace.push({ agent: 'planner', event: '已完成行程規劃', correlationId });
      }
      if (work.summary || presentation.detail === 'detailed') planningText = null;
    }
    dependencies.signal?.throwIfAborted();
    checkVersion(session, turnVersion);
    if (work.plan) session.itinerary = { version: turnVersion, itinerary };
    const pendingAirportField = ['origin', 'destination'].find(key => {
      const choice = session.discovery[`${key}AirportChoice`];
      return session.draft[key] === undefined && choice?.candidates.length > 1 && !choice.accepted.length;
    });
    const missingField = pendingAirportField ?? ['origin', 'destination', 'date',
      ...((session.discovery.roundTripRequested || session.discovery.returnDatePreference) ? ['returnDate'] : []), 'travelers', 'cabin']
      .find(key => session.draft[key] === undefined);
    if (missingField) {
      session.discovery.followUpQuestion = { field: missingField };
      const choice = session.discovery[`${missingField}AirportChoice`];
      if (choice?.candidates.length > 1 && !choice.accepted.length) {
        Object.assign(session.discovery.followUpQuestion, choice, { key: missingField });
        session.discovery.airportQuestion = { key: missingField, city: choice.city, candidates: choice.candidates };
        if (!work.plan && !answeringAirport && !/[？?]/.test(text)) {
          text = `${choice.city}可使用${choice.candidates.map(code => airports.find(airport => airport.code === code).name).join('或')}，您偏好哪一座？兩座都可以。\n${text}`;
        }
      }
    } else delete session.discovery.followUpQuestion;
  let sections;
  if ((route.role === 'flight' && route.reason !== 'knowledge' || presentation.flights && work.plan) && session.trip) {
    const offers = [...session.offers.values()];
    session.presentedOffers = new Set();
    const flexibleAirports = session.trip.originAirports || session.trip.destinationAirports;
    const searched = tools.find(t => t.tool === 'search_flights')?.data.searchedAirportPairs ?? [];
    const unavailable = [...new Set(searched.flatMap(p => [p.origin, p.destination]))].filter(code =>
      !offers.some(o => o.flight.origin === code || o.flight.destination === code));
    const airportNames = codes => codes.map(code => airports.find(airport => airport.code === code).name).join('／');
    const airportSummary = !flexibleAirports ? '' : searched.length
      ? `已比較接受的機場：${airportNames([...new Set(searched.flatMap(pair => [pair.origin, pair.destination]))])}。${unavailable.length ? `${airportNames(unavailable)}無符合的示範航班。` : ''}\n`
      : `機場偏好：${airportNames(session.trip.originAirports ?? [session.trip.origin])} → ${airportNames(session.trip.destinationAirports ?? [session.trip.destination])}。\n`;
    sections = offers.length ? offers.map((o, i) => ({
      text: `${i === 0 ? `示範航班／模擬票價：${offers.length}個選項。\n` : ''}${offerText(o, i, session.trip.budget)}\n${i === 0 ? airportSummary : ''}可說「選第${i + 1}班」。`, offerId: o.id
    })) : [{ text: '沒有符合的合成航班或機位。想換日期或艙等嗎？這不代表真實航空供應。' }];
    if (route.role === 'planner') sections.unshift({ text });
  }
  if (route.role === 'price' && route.reason === 'price' && session.quote) {
    session.presentedQuote = null;
    const o = session.offers.get(session.selected);
    sections = [{
      text: `${tripText({ ...session.trip, origin: o.flight.origin, destination: o.flight.destination,
        originAirports: undefined, destinationAirports: undefined, date: o.flight.departureLocal.slice(0, 10),
        ...(o.returnFlight ? { returnDate: o.returnFlight.departureLocal.slice(0, 10) } : {}) })}\n${o.flight.flightNumber}${o.returnFlight ? `／${o.returnFlight.flightNumber}` : ''}（合成）。`
    }, { text: quoteText(session.quote), quoteKey: markQuote(session.quote) }];
  }
  if (!sections) sections = [{ text }];
  if (planningDetails) {
    if (work.summary) sections.unshift({ text: planningDetails });
    else sections.push({ text: planningDetails });
  }
  if (planningText) sections.unshift({ text: planningText });
  dependencies.signal?.throwIfAborted();
  checkVersion(session, turnVersion);
  text = enqueueReply(session, sections);
  const speech = presentation.detail === 'detailed' || ['select', 'confirm'].includes(route.reason) || session.quote && route.role === 'price'
    ? { text, detail: 'detailed' }
    : { text: work.plan ? `${planningLead(session, args.message, { summary: true, now: dependencies.now })}\n${presentation.flights && session.offers.size
      ? '示範航班與模擬票價已完整列在畫面；尚未選班或訂票。' : ''}` : route.role === 'flight' && session.offers.size
      ? (() => { const offer = [...session.offers.values()][0]; return `示範航班／模擬票價，共${session.offers.size}個選項。例如${offer.flight.flightNumber}，${offer.flight.departureLocal}出發，${offer.travelers}位成人含稅總額${money(offer.total)}。完整航班列在畫面，尚未選班或訂票。`; })()
      : text, detail: 'summary' };
  if (route.role !== 'intent') trace.push({ agent: route.role, event: '已完成本回合', correlationId });
  session.history.push({ role: 'user', text: args.message }, {
    role: 'assistant', agent: route.role, text, fullText: sections.map(section => section.text).join('\n')
  });
  session.history = session.history.slice(-40);
  session.turns++;
  const response = {
    text, speech, foundryText: null, itinerary, receipt, trace, tools, correlationId,
    mode: config ? 'foundry-with-mock-tools' : 'mock', state: replyState(session, publicState(session)),
    diagnostics: { modelCalls: (session.cloudEvidence ?? []).slice(evidenceStart).map(({ role, agent, usage, fileSearchCalls, functionCalls, inputBytes }) =>
      ({ role, agent, usage, fileSearchCalls, functionCalls, inputBytes })) }
  };
  if (args.requestId) session.chatRequests.set(args.requestId, { fingerprint, response });
  return response;
}
