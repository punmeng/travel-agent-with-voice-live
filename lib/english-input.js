const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
export const englishNumber = raw => /^\d+$/.test(raw) ? Number(raw) : numbers[raw.toLowerCase()] ?? null;
const numberPattern = `(?:\\d+|${Object.keys(numbers).join('|')})`;
const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15 };
export function englishDay(message) {
  const normal = message.match(new RegExp(`\\bdays?\\s+(${numberPattern})\\b`, 'i'));
  const ordinal = message.match(new RegExp(`\\b(${Object.keys(ordinals).join('|')})\\s+days?\\b`, 'i'));
  return normal ? englishNumber(normal[1]) : ordinal ? ordinals[ordinal[1].toLowerCase()] : null;
}
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthPattern = `(?:${monthNames.map(name => `${name}|${name.slice(0, 3)}`).join('|')})`;
export const englishDatePattern = `(?:${monthPattern}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${monthPattern}\\.?(?:\\s+\\d{4})?|(?:early|mid|late)[ -]+${monthPattern}(?:\\s+\\d{4})?|(?:next|this) month(?:\\s+(?:on\\s+)?\\d{1,2}(?:st|nd|rd|th)?)?|tomorrow|day after tomorrow)`;
export function approximateEnglishDate(expression) {
  return new RegExp(`^(?:(?:early|mid|late)[ -]+)?${monthPattern}(?:\\s+\\d{4})?$|^(?:next|this) month$`, 'i').test(expression.trim());
}
export function englishDateParts(expression) {
  const clean = expression.trim().replace(/\./g, '').replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
  const first = new RegExp(`^(${monthPattern})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`, 'i').exec(clean);
  const second = new RegExp(`^(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?$`, 'i').exec(clean);
  if (!first && !second) return null;
  const name = first?.[1] ?? second[2], day = first?.[2] ?? second[1], year = first?.[3] ?? second?.[3];
  const month = monthNames.findIndex(item => item.toLowerCase().startsWith(name.toLowerCase())) + 1;
  return { month, day: Number(day), year };
}
export function englishSlots(message, resolver, session) {
  const slots = {};
  const positive = pattern => [...message.matchAll(pattern)].filter(match =>
    !/\b(?:not|no|instead of|rather than|don't want)\s*$/i.test(message.slice(0, match.index)));
  const locations = resolver.mentions(message).filter(match => !match.excluded && match.status === 'matched');
  for (const match of locations) {
    const before = message.slice(Math.max(0, match.index - 35), match.index);
    if (/\bfrom\s*$/i.test(before)) slots.originPlace = match.term;
    if (/\b(?:to|destination(?: is)?|fly to|visit)\s*$/i.test(before) &&
      !englishDay(message) && !/\b(?:hotel|meeting|sightseeing|afternoon|morning|evening)\b/i.test(message)) slots.destinationPlace = match.term;
  }
  if (!Object.keys(slots).length && /^[a-z .'-]+[.!?]?$/i.test(message.trim()) &&
      resolver.resolve({ query: message.replace(/[.!?]$/g, '').trim(), countryCode: null }).status === 'matched') {
    slots[session.discovery.pending.origin ? 'originPlace' : 'destinationPlace'] = message.replace(/[.!?]$/g, '').trim();
  }
  const travelers = positive(new RegExp(`\\b${numberPattern}\\s+(?:adults?|people|travell?ers?|persons?|persions?)\\b`, 'gi'));
  slots.travelerExpression = travelers.at(-1)?.[0];
  const cabins = positive(/\bpremium(?: economy)?(?: class)?\b|\b(?:economy|encomcy)(?: class)?\b|\bbusiness(?: class)?\b(?!\s+(?:trip|travel))/gi);
  if (cabins.length) slots.cabinExpression = cabins.at(-1)[0];
  else if (/\bbusiness|economy|premium\b/i.test(message)) slots.cabinExpression = null;
  slots.durationExpression = positive(new RegExp(`\\b${numberPattern}[ -]+day(?:s|\\b)`, 'gi')).at(-1)?.[0];
  slots.walkingExpression = message.match(/\b(?:no walking restrictions|cancel low walking|low[ -]walking|less walking|not (?:too )?much walking|minim(?:al|ize) walking)\b/i)?.[0];
  slots.budgetExpression = message.match(/\b(?:no budget limit|unlimited budget|budget(?:\s+(?:of|is|up to))?\s*[:=]?\s*(?:(?:TWD|NT\$|USD|US\$|EUR|JPY)\s*)?[\d,]+)/i)?.[0];
  slots.companionExpression = message.match(/\bwith (?:my |our )?(?:mother|father|parents|children|kids|family)\b/i)?.[0];
  slots.interestExpression = message.match(/\b(?:food|shopping|culture|beaches?|cherry blossoms|autumn leaves|sightseeing)\b/i)?.[0];
  slots.flexibleExpression = message.match(/\b(?:fixed dates?|flexible dates?|one day either side)\b/i)?.[0];
  return Object.fromEntries(Object.entries(slots).filter(([, value]) => value !== undefined));
}
function clock(hour, minute, meridiem) {
  let value = Number(hour);
  if (meridiem) {
    if (value < 1 || value > 12) return '99:00';
    value = value % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  return `${String(value).padStart(2, '0')}:${minute ?? '00'}`;
}
export function updateEnglishPlanning(planning, message) {
  if (/\b(?:business trip|business travel|meeting|conference)\b/i.test(message)) planning.purpose = '商務出差';
  else if (/\b(?:leisure|holiday|vacation)\b/i.test(message)) planning.purpose = '休閒旅遊';
  if (/\b(?:airport transfer|airport transport|airport shuttle)\b/i.test(message)) planning.airportTransfers = true;
  const nights = message.match(new RegExp(`\\b(${numberPattern})[ -]+nights?\\b`, 'i'));
  if (nights) planning.lodging.nights = englishNumber(nights[1]);
  const area = message.match(/\b(?:stay|hotel|accommodation|lodging)\s+(?:near|around|in)\s+([^.;\n]+?)(?=\s+for\s+\d+\s+nights?|,\s*(?:with|and|budget)|[.;\n]|$)/i);
  if (area) planning.lodging.area = area[1].trim();
  const timeRange = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|–|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  for (const clause of message.split(/[.;\n]/)) {
    const day = clause.match(new RegExp(`\\bdays?\\s+(${numberPattern}(?:\\s*(?:and|&|,)\\s*${numberPattern})*)\\b`, 'i'));
    const ordinal = clause.match(new RegExp(`\\b((?:${Object.keys(ordinals).join('|')})(?:\\s*(?:and|&|,)\\s*(?:${Object.keys(ordinals).join('|')}))*)\\s+days?\\b`, 'i'));
    if (!day && !ordinal) continue;
    const days = (day?.[1] ?? ordinal[1]).split(/\s*(?:and|&|,)\s*/i)
      .map(value => day ? englishNumber(value) : ordinals[value.toLowerCase()]);
    if (/\b(?:cancel|remove|delete)\s+(?:the\s+)?meetings?\b/i.test(clause)) {
      planning.meetings = planning.meetings.filter(block => !days.includes(block.day));
      continue;
    }
    if (/\bmeeting|conference\b/i.test(clause)) {
      const time = clause.match(timeRange);
      if (!time) continue;
      const location = clause.match(/\b(?:at|near|in)\s+(.+?)(?=\s+(?:from\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:to|–|-)|$)/i)?.[1]?.trim() ??
        clause.match(/\b(?:at|near|in)\s+(.+)$/i)?.[1]?.trim() ?? 'Location to be confirmed';
      for (const dayIndex of days) {
        planning.meetings = planning.meetings.filter(block => block.day !== dayIndex);
        planning.meetings.push({ day: dayIndex, start: clock(time[1], time[2], time[3]),
          end: clock(time[4], time[5], time[6]), location: location.slice(0, 120), evidence: clause.trim().slice(0, 300) });
      }
    } else {
      const activity = clause.match(/\b(?:visit|explore|shop|shopping|sightseeing|free time|rest)\b.*$/i)?.[0];
      if (!activity) continue;
      const period = clause.match(/\b(morning|afternoon|evening)\b/i)?.[1]?.toLowerCase() ?? 'any';
      for (const dayIndex of days) {
        planning.activities = planning.activities.filter(item => item.day !== dayIndex || item.period !== period);
        planning.activities.push({ day: dayIndex, period, description: activity.trim().slice(0, 200), evidence: clause.trim().slice(0, 300) });
      }
    }
  }
  if (/\b(?:hotel|accommodation|lodging)\b/i.test(message) && /\bbudget|total|ceiling|limit\b/i.test(message)) {
    const amount = message.match(/\bTWD\s*([\d,]+)|\bbudget(?:\s+(?:of|is))?\s*[:=]?\s*([\d,]+)/i);
    if (amount) planning.budget = { total: Number((amount[1] ?? amount[2]).replaceAll(',', '')), currency: 'TWD',
      includes: /\bflight|ticket\b/i.test(message) ? ['flight', 'lodging'] : ['lodging'],
      separate: /\b(?:separate|extra|excluding|outside)\b/i.test(message)
        ? [/\btransport\b/i.test(message) && 'transport', /\bmeals?|food\b/i.test(message) && 'meals'].filter(Boolean) : [],
      evidence: message.slice(0, 300) };
  }
  return planning;
}
