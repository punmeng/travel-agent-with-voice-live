import { z } from 'zod';
import { AppError } from './core.js';
import { airports } from './dataset.js';

const day = z.number().int().min(1).max(14);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const evidence = z.string().min(1).max(2000);
export const planningSchema = z.object({
  purpose: z.string().max(80).optional(),
  meetings: z.array(z.object({ day, start: clock, end: clock, location: z.string().min(1).max(120), evidence }).strict()
    .refine(block => block.start < block.end)).max(28).default([]),
  activities: z.array(z.object({ day, period: z.enum(['morning', 'afternoon', 'evening', 'any']),
    description: z.string().min(1).max(250), evidence }).strict()).max(28).default([]),
  lodging: z.object({ nights: z.number().int().min(1).max(30).optional(), area: z.string().max(120).optional() }).strict().default({}),
  airportTransfers: z.boolean().default(false),
  budget: z.object({ total: z.number().int().min(1000).max(2000000), currency: z.literal('TWD'),
    includes: z.array(z.enum(['flight', 'lodging'])).min(1).max(2),
    separate: z.array(z.enum(['transport', 'meals'])).max(2), evidence }).strict().optional()
}).strict();
const nums = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function n(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value.includes('十')) {
    const [a, b] = value.split('十');
    return (nums[a] ?? 1) * 10 + (nums[b] ?? 0);
  }
  return nums[value] ?? null;
}
const numeral = '[\\d一二兩三四五六七八九十]+';
export function checkVersion(session, expected) {
  if (expected !== undefined && expected !== (session.contextVersion ?? 0)) {
    throw new AppError('STALE_JOURNEY', '旅程已更新，請重新整理後再送出這則訊息。', 409);
  }
}
export function planningUpdates(previous, message) {
  const value = planningSchema.parse(structuredClone(previous ?? {}));
  if (/不是出差|不出差|改成旅遊|改為旅遊/.test(message)) value.purpose = '休閒旅遊';
  else if (/出差|商務/.test(message)) value.purpose = '商務出差';
  if (/機場.{0,8}(?:往返|接送|交通)|(?:往返|接送).{0,8}機場/.test(message)) {
    value.airportTransfers = !/(?:取消|不用|不需要|不要).{0,10}機場/.test(message);
  }
  const nights = message.match(new RegExp(`(${numeral})\\s*(?:晚|夜)`));
  if (nights) value.lodging.nights = n(nights[1]);
  const days = [...message.matchAll(new RegExp(`第(${numeral})天`, 'g'))].map(match => n(match[1]));
  let meridiem = '';
  const hours = [...message.matchAll(new RegExp(`(上午|下午|晚上)?\\s*(${numeral})\\s*(?:點|時)(?:(${numeral})分)?`, 'g'))]
    .map(match => {
      let hour = n(match[2]);
      meridiem = match[1] ?? meridiem;
      if (/下午|晚上/.test(meridiem) && hour < 12) hour += 12;
      return `${String(hour).padStart(2, '0')}:${String(n(match[3] ?? '0')).padStart(2, '0')}`;
    });
  const cancelling = /取消|刪除|不需要/.test(message);
  if (cancelling && /開會|會議/.test(message) && days.length) value.meetings = value.meetings.filter(block => !days.includes(block.day));
  if (!cancelling && /開會|會議/.test(message) && days.length && hours.length >= 2) {
    const location = message.match(/(?:在|於)([^，。；]{2,60}?)(?:開會|會議)/)?.[1]?.trim();
    if (location) for (const index of days) {
      value.meetings = value.meetings.filter(block => block.day !== index);
      value.meetings.push({ day: index, start: hours[0], end: hours[1], location, evidence: message });
    }
  }
  const evening = message.match(/(?:晚上|晚間)[^。；]+/)?.[0];
  if (!cancelling && /開會|會議/.test(message) && evening &&
      /吃|用餐|晚餐|散步|逛|參觀|想去/.test(evening) && !/不要|不想|取消/.test(evening)) {
    for (const index of days) {
      value.activities = value.activities.filter(item => item.day !== index || item.period !== 'evening');
      value.activities.push({ day: index, period: 'evening', description: evening, evidence: message });
    }
  }
  const activity = /自由活動|伴手禮|景點|觀光|逛|遊覽|參觀|想去|去.{1,30}(?:走走|玩)/;
  if (cancelling && /活動|景點|觀光/.test(message) && days.length) value.activities = value.activities.filter(item => !days.includes(item.day));
  if (!cancelling && activity.test(message) && !/開會|會議/.test(message) && days.length) {
    const period = /下午/.test(message) ? 'afternoon' : /上午/.test(message) ? 'morning' : /晚上/.test(message) ? 'evening' : 'any';
    const description = message.split(/[。；]/).find(part => activity.test(part))?.trim();
    if (description) for (const index of days) {
      value.activities = value.activities.filter(item => item.day !== index || item.period !== period);
      value.activities.push({ day: index, period, description, evidence: message });
    }
  }
  const lodgingQuestion = /為什麼|為何|怎麼|如何|是否|[？?]/.test(message);
  for (const lodgingArea of message.matchAll(/(?:住在|住宿(?:區域)?(?:改成|選|在)|住(?!宿))([^，。；]{2,40})/g)) {
    const prefix = message.slice(0, lodgingArea.index);
    if (!lodgingQuestion && !/(?:不想|不要|不|別)$/.test(prefix)) value.lodging.area = lodgingArea[1].replace(/(?:吧|就好)$/, '');
  }
  if (/取消總預算|不限總預算/.test(message)) delete value.budget;
  const amount = message.match(new RegExp(`(?:新臺幣|新台幣|TWD|NT\\$)\\s*([\\d,]+|${numeral})\\s*(萬)?(?:元)?`, 'i'));
  if (amount && /預算|合計|上限|控制在|以內/.test(message) && /住宿|飯店/.test(message)) {
    const raw = amount[1].replaceAll(',', '');
    const total = n(raw) * (amount[2] ? 10000 : 1);
    value.budget = { total, currency: 'TWD', includes: /機票|航班/.test(message) ? ['flight', 'lodging'] : ['lodging'],
      separate: ['transport', 'meals'].filter(kind => (kind === 'transport' ? /交通/ : /餐費|餐飲/).test(message)), evidence: message };
  }
  return planningSchema.parse(value);
}

export function projectContext(role, session) {
  const d = session.discovery, t = session.trip ?? session.draft;
  const planning = d.planning ? {
    ...d.planning,
    meetings: d.planning.meetings.map(({ evidence: _evidence, ...block }) => block),
    activities: d.planning.activities.map(({ evidence: _evidence, ...activity }) => activity),
    ...(d.planning.budget ? { budget: Object.fromEntries(Object.entries(d.planning.budget).filter(([key]) => key !== 'evidence')) } : {})
  } : undefined;
  const facts = { version: session.contextVersion ?? 0, destinationCity: d.destinationCity, originCity: d.originCity,
    durationDays: d.durationDays, trip: t };
  if (role === 'intent') return {
    ...facts, planning, pendingQuestion: d.followUpQuestion ?? d.airportQuestion ?? null,
    airportChoices: { origin: d.originAirportChoice, destination: d.destinationAirportChoice },
    recent: session.history.filter(entry => entry.role === 'user' && !/^(?:繼續|下一段|下一頁)$/.test(entry.text)).slice(-4).map(entry => entry.text.slice(0, 300))
  };
  if (role === 'planner') return { ...facts, planning, interests: d.interests, companions: d.companions };
  if (role === 'flight') return { version: facts.version,
    trip: Object.fromEntries(['origin', 'destination', 'originAirports', 'destinationAirports', 'date', 'returnDate', 'travelers', 'cabin', 'flexibleDays', 'timePreference', 'budget']
      .filter(key => t[key] !== undefined).map(key => [key, t[key]])) };
  return { version: facts.version, selected: session.selected, quote: session.quote,
    consent: session.consent, offerIds: session.selected ? [session.selected] : [] };
}

export function turnWork(message, action = 'chat') {
  const summary = /整理|摘要|總結|summari[sz]e|summary/i.test(message);
  const prices = /^(?:how much(?: is it| are they)?|多少錢|多少錢呢|票價呢|現在多少)[？?。！!\s]*$/i.test(message);
  const options = /航班|機票|班機|flight|ticket/i.test(message) &&
    /選項|候選|清單|列出|看看|給我|options?|choices?|show|give me/i.test(message);
  const flightOnly = /航班|機位|班機|機票|飛機/.test(message) && !/行程|住宿|開會|會議|景點|預算|摘要|整理|出差|(?:安排|規劃).{0,16}天/.test(message);
  const search = options || action === 'search' || /(?:搜尋|查詢|查找|找|查).{0,16}(?:航班|機位|班機|機票)|(?:航班|機位|班機).{0,10}(?:搜尋|查詢|查找|比較)/.test(message) ||
    (flightOnly && /規劃|安排|來回|往返|時間|時段/.test(message));
  const paused = /(?:先不|不要|暫停|停止|取消)(?:再)?(?:找|查|搜尋)/.test(message);
  const plan = action === 'plan' || summary || (!flightOnly && /行程|規劃|安排|住宿|開會|會議|自由活動|伴手禮|景點|預算分配/.test(message));
  return { plan, summary, search: search && !paused, options: options && !paused, prices, paused };
}

export function presentationRequest(message) {
  const detailed = /詳細|展開|詳列|detail|expand/i.test(message);
  const match = new RegExp(`第\\s*(${numeral})\\s*天|day\\s*(\\d+)`, 'i').exec(message);
  const day = match ? n(match[1] ?? match[2]) : null;
  return { detail: detailed ? 'detailed' : 'summary', day: detailed && day >= 1 && day <= 14 ? day : null,
    flights: /機票|航班|班機|flight|ticket/i.test(message) };
}

const airportTransferAdvice = (trip, discovery) => trip.destination === 'NRT' && discovery.destinationCity === '東京'
  ? '成田往返東京車站可比較鐵路與機場巴士' : '機場往返比較鐵路、巴士或接駁車';

export function planningLead(session, message, { summary = false, costs = false, flightResult, now = Date.now() } = {}) {
  const d = session.discovery, t = session.trip ?? session.draft, p = d.planning ?? planningSchema.parse({});
  const count = d.durationDays ?? 3;
  const lodging = p.lodging.area ?? (p.meetings.some(block => /東京車站/.test(block.location)) ? '八重洲／日本橋' : null);
  const meetingGroups = new Map();
  for (const block of p.meetings) {
    const key = `${block.start}–${block.end}${block.location}`;
    meetingGroups.set(key, [...(meetingGroups.get(key) ?? []), block.day]);
  }
  const meetingText = [...meetingGroups].map(([description, days]) => `第${days.join('、')}天${description}開會`).join('；');
  const activities = p.activities.map(item => item.description).join('；');
  const offer = (flightResult?.data?.offers ?? [...session.offers.values()]).find(item => Date.parse(item.expiresAt) > now);
  const budget = p.budget ? `${p.budget.includes.includes('flight') ? '機票＋' : ''}${p.lodging.nights ? `${p.lodging.nights}晚` : ''}住宿上限TWD${p.budget.total.toLocaleString('en-US')}` : '';
  const allocation = p.budget && offer && p.budget.includes.includes('flight')
    ? `${offer.returnFlight ? '來回' : '去程'}模擬票價TWD${offer.total.toLocaleString('en-US')}，${p.budget.total >= offer.total
      ? `${offer.returnFlight ? '住宿額度' : '剩餘回程＋住宿額度'}TWD${(p.budget.total - offer.total).toLocaleString('en-US')}` : '需調整預算'}` : '';
  const transfer = airportTransferAdvice(t, d);
  if (costs && !p.budget) return '住宿目前提供區域建議，尚未查詢房價或空房。您想每晚預留多少住宿預算？';
  if (summary) return [
    `${count}天安排：第1天抵達；${meetingText || '中間保留彈性活動'}；${activities || '依興趣安排觀光'}；第${count}天返程。`,
    lodging ? `住${lodging}。` : '',
    budget ? `${budget}。` : ''
  ].filter(Boolean).join('\n');
  if (/預算|budget|合計|上限|控制在|以內/i.test(message) && p.budget) return [
    `${budget}。`, allocation ? `${allocation}。` : '機票候選價待確認。',
    activities ? `${activities}。` : '',
    p.budget.separate.length ? '交通、餐費另計。' : ''
  ].filter(Boolean).join('\n');
  if (/住宿|飯店|(?:想|打算|希望)?住/.test(message) && lodging &&
      !/第[\d一二三四五六七八九十]+天|上午|下午|晚上/.test(message)) {
    return `住宿安排在${lodging}。${meetingText ? `方便${meetingText}。` : ''}`;
  }
  if (/開會|會議|meeting/i.test(message) && meetingText) return [
    `${meetingText}；此時段不排觀光。`, lodging ? `住${lodging}。` : '',
    p.airportTransfers ? `${transfer}。` : ''
  ].filter(Boolean).join('\n');
  if (/活動|伴手禮|景點|觀光|逛|參觀|activity|sightseeing/i.test(message) && activities) {
    return `${activities}。${t.lowWalking ? '較遠路段搭車，保留休息。' : ''}`;
  }
  if (/住宿|飯店|(?:想|打算|希望)?住/.test(message) && lodging) return `住宿安排在${lodging}。${meetingText ? `方便${meetingText}。` : ''}`;
  if (/機場|airport|接送|交通|transfer/i.test(message) && p.airportTransfers) return `${transfer}。${t.lowWalking ? '較遠路段搭車，減少步行。' : ''}${lodging ? `住宿建議${lodging}。` : ''}`;
  return [
    `${d.destinationCity ?? '目的地'}${count}天：抵達、${p.purpose === '商務出差' ? '商務與彈性活動' : '在地體驗與休息'}、返程。`,
    flightResult ? `找到${flightResult.data.offers.length}個合成航班${offer ? `，${t.origin}→${t.destination}，TWD${offer.total.toLocaleString('en-US')}起` : ''}；尚未訂票。` : '',
    meetingText ? `${meetingText}。` : ''
  ].filter(Boolean).join('\n');
}

export function savedPlan(session, flightResult, now = Date.now(), presentation = {}) {
  const d = session.discovery, t = session.trip ?? session.draft, p = d.planning ?? planningSchema.parse({});
  const count = d.durationDays ?? 3;
  const date = index => {
    if (!t.date) return '';
    const value = new Date(`${t.date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + index);
    return `（${value.toISOString().slice(0, 10)}）`;
  };
  const lines = presentation.day ? [] : [`${d.destinationCity ?? '目的地'}・${count}天${p.purpose ?? '行程'}，${t.travelers ? `${t.travelers}位成人` : '同行人數待確認'}。`];
  const offers = (flightResult?.data?.offers ?? [...session.offers.values()]).filter(item => Date.parse(item.expiresAt) > now);
  const overnight = offers.length && offers.every(offer => offer.flight.arrivalLocal.slice(0, 10) > t.date);
  if (t.origin && t.destination && !presentation.day) {
    const label = key => (t[`${key}Airports`] ?? [t[key]]).map(code => airports.find(airport => airport.code === code)?.name ?? code).join('／');
    lines.push(`航班需求：${label('origin')} → ${label('destination')}，${({ economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙' })[t.cabin] ?? '艙等待確認'}${t.returnDate ? `；${t.returnDate}回程` : '；目前查去程'}。`);
  }
  for (let index = 1; index <= count; index++) {
    if (presentation.day && presentation.day !== index) continue;
    const blocks = p.meetings.filter(block => block.day === index);
    const activities = p.activities.filter(item => item.day === index);
    lines.push(`第 ${index} 天${date(index - 1)}：${blocks.length ? blocks.map(block => `${block.start}–${block.end} ${block.location}開會；此時段不排觀光`).join('；') :
      index === 1 ? overnight ? `出發；示範航班${offers[0].flight.arrivalLocal.slice(0, 10)}抵達，入住日待確認` : '出發、抵達與入住（依選班時間安排）' : index === count ? '退房、前往機場' : '保留彈性與休息'}${activities.length ? `；${activities.map(item =>
        blocks.length && item.period !== 'evening' ? `待調整活動：${item.description}（需避開會議時段）` : item.description).join('；')}` : ''}。`);
    if (presentation.detail === 'detailed') {
      lines.push(presentation.dayAdvice?.[index] ? `建議（交通與場所資訊待核驗）：${presentation.dayAdvice[index]}` : blocks.length
        ? `建議：會前在住宿附近早餐，預留前往${blocks[0].location}的接駁與入場時間；會中用餐及休息依主辦安排。${blocks.at(-1).end}後再用餐、回住宿休息，不安排趕場。交通時間與餐廳待確認。`
        : index === 1
          ? '建議：依實際抵達時間安排入境、機場交通及入住；當天以附近用餐與休息為主。班機與入住時間尚待確認。'
          : index === count
            ? '建議：退房前整理行李，依回程航班及機場報到要求倒推接駁時間；回程航班未確認前不排固定觀光。'
            : `建議：${activities.length ? '活動前後保留用餐與坐下休息，確認場所開放資訊；較遠路段搭車。' : '上午可在住宿周邊慢遊，下午安排一處有興趣的景點，晚上用餐休息；地點尚待您選擇。'}場館、交通班次與費用出發前核驗。`);
    }
  }
  if (t.lowWalking) lines.push('少步行：景點集中、保留休息，較長路段搭車。');
  if (p.meetings.some(block => /東京車站/.test(block.location))) lines.push(`住宿建議：${p.lodging.area ?? '東京車站八重洲、日本橋'}，方便前往會議地點。`);
  else if (p.lodging.area) lines.push(`住宿區域：${p.lodging.area}。`);
  if (presentation.day) return lines.join('\n');
  if (p.airportTransfers) lines.push(`機場交通建議：${airportTransferAdvice(t, d)}；班次與費用出發前確認${t.lowWalking ? '，少步行可加用計程車接駁' : ''}。`);
  if (p.budget) {
    const offer = offers[0];
    lines.push(`${p.budget.includes.includes('flight') ? '機票＋住宿' : '住宿'}配置上限：TWD ${p.budget.total.toLocaleString('en-US')}；${p.lodging.nights ?? '待確認'}晚住宿。`);
    if (offer && p.budget.includes.includes('flight')) {
      const available = p.budget.total - offer.total;
      lines.push(`${offer.returnFlight ? '來回' : '去程'}模擬票價 TWD ${offer.total.toLocaleString('en-US')}；${available >= 0
        ? `${offer.returnFlight ? '住宿最多預留' : '回程與住宿合計最多預留'} TWD ${available.toLocaleString('en-US')}` : '機票已超出總預算，需調整'}。`);
    } else lines.push('尚無機票候選價；確認航班後再分配住宿額度。');
    if (p.budget.separate.length) {
      const adults = t.travelers ?? 1;
      const allowances = [];
      if (p.budget.separate.includes('transport')) allowances.push(`交通 TWD ${((2000 + count * 200) * adults).toLocaleString('en-US')}（每人機場接駁2程×1,000＋市內${count}天×200）`);
      if (p.budget.separate.includes('meals')) allowances.push(`餐費 TWD ${(count * 1200 * adults).toLocaleString('en-US')}（每人每天3餐×400，共${count}天）`);
      lines.push(`交通與餐費另計：${t.travelers ? `${adults}人` : '每人'}${allowances.join('、')}；這是預算假設，非供應商報價。`);
    }
    lines.push('住宿目前提供區域與預算建議，尚未查詢房價或空房。');
  }
  const missing = [];
  if (!t.origin) missing.push('出發機場');
  if (!t.destination) missing.push('抵達機場');
  if (!t.date) missing.push('出發日期');
  if (!t.travelers) missing.push('成人數');
  if (!t.cabin) missing.push('艙等');
  if (!t.returnDate) missing.push('回程日期與航班是否需要協助');
  if (p.lodging.nights && !p.lodging.area) missing.push('住宿區域與每晚額度');
  if (overnight) missing.push('入住起日（示範航班隔日抵達）');
  if (t.date && t.returnDate && Math.round((Date.parse(t.returnDate) - Date.parse(t.date)) / 86400000) + 1 !== count) missing.push('行程天數與出回程日期的差異');
  lines.push(`待確認：${missing.length ? missing.join('、') : '航班時段與住宿偏好'}。尚未訂票或預約。`);
  return lines.join('\n');
}
