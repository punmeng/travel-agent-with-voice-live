import { airports, localDateTime } from './dataset.js';
import { AppError } from './core.js';

export function speechSegments(result) {
  const text = speechText(result.speech?.text ?? result.text);
  const chunks = [];
  let buffer = '';
  for (const part of new Intl.Segmenter('zh-Hant', { granularity: 'sentence' }).segment(text)) {
    if (part.segment.length <= 120) {
      if (buffer.length + part.segment.length > 120 && buffer) { chunks.push(buffer); buffer = ''; }
      buffer += part.segment;
      continue;
    }
    if (buffer) { chunks.push(buffer); buffer = ''; }
    for (const word of new Intl.Segmenter('zh-Hant', { granularity: 'word' }).segment(part.segment)) {
      if (buffer.length + word.segment.length > 120 && buffer) { chunks.push(buffer); buffer = ''; }
      if (word.segment.length > 120) throw new AppError('VOICE_TEXT_LIMIT', '朗讀識別碼過長，完整答案已保留在畫面。', 422);
      buffer += word.segment;
    }
    if (buffer) { chunks.push(buffer); buffer = ''; }
  }
  if (buffer) chunks.push(buffer);
  if (chunks.length > 48) throw new AppError('VOICE_TEXT_LIMIT', '此回答超過單輪朗讀安全上限，完整答案已保留在畫面；請指定其中一天詳述。', 422);
  return chunks.filter(chunk => chunk.trim());
}

export function commentaryContext(result) {
  const text = speechText(result.speech?.text ?? result.text);
  const parts = [];
  let buffer = '';
  for (const character of text) {
    if (Buffer.byteLength(buffer + character) > 380) { parts.push(buffer); buffer = ''; }
    buffer += character;
  }
  if (buffer) parts.push(buffer);
  if (parts.length > 64) throw new AppError('VOICE_TEXT_LIMIT', '此回答超過原生語音上下文上限，完整答案已保留在畫面。', 422);
  return parts;
}

const digits = '零一二三四五六七八九';
const digitByDigit = value => [...value].map(char => /\d/.test(char) ? digits[Number(char)] : char.toUpperCase()).join('，');
const airportCodes = new Set(airports.map(airport => airport.code));
const timezoneNames = {
  'Asia/Taipei': '臺灣當地時間', 'Asia/Tokyo': '日本當地時間', 'Asia/Seoul': '韓國當地時間',
  'Asia/Hong_Kong': '香港當地時間', 'Asia/Shanghai': '中國當地時間', 'Asia/Bangkok': '泰國當地時間',
  'Asia/Singapore': '新加坡當地時間', 'Asia/Kuala_Lumpur': '馬來西亞當地時間',
  'Asia/Ho_Chi_Minh': '越南當地時間', 'Asia/Manila': '菲律賓當地時間', 'Asia/Jakarta': '雅加達當地時間',
  'Asia/Makassar': '峇里島當地時間', 'Asia/Kolkata': '印度當地時間',
  'America/Los_Angeles': '美國太平洋當地時間', 'America/New_York': '美國紐約當地時間',
  'America/Vancouver': '加拿大溫哥華當地時間', 'Europe/London': '英國當地時間',
  'Europe/Berlin': '德國當地時間', 'Europe/Amsterdam': '荷蘭當地時間', 'Europe/Rome': '義大利當地時間',
  'Europe/Vienna': '奧地利當地時間', 'Europe/Prague': '捷克當地時間', 'Australia/Sydney': '雪梨當地時間',
  'Australia/Melbourne': '墨爾本當地時間', 'Australia/Brisbane': '布里斯本當地時間',
  'Pacific/Auckland': '奧克蘭當地時間', 'Pacific/Guam': '關島當地時間'
};
export function chineseNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Speech numeric value must be a safe nonnegative integer');
  if (number === 0) return '零';
  function group(n, leading) {
    let output = '', pendingZero = false;
    for (const [unit, label] of [[1000, '千'], [100, '百'], [10, '十'], [1, '']]) {
      const digit = Math.floor(n / unit); n %= unit;
      if (digit) {
        if (pendingZero) output += '零';
        output += (leading && digit === 1 && unit === 10 && output === '' ? '' : digits[digit]) + label;
        pendingZero = false;
      } else if (output && n) pendingZero = true;
    }
    return output;
  }
  let remainder = number, output = '', skipped = false;
  const groups = [];
  while (remainder) { groups.push(remainder % 10000); remainder = Math.floor(remainder / 10000); }
  for (let i = groups.length - 1; i >= 0; i--) {
    const part = groups[i];
    if (!part) { if (output) skipped = true; continue; }
    if (output && (skipped || part < 1000)) output += '零';
    output += group(part, output === '') + ['', '萬', '億', '兆'][i];
    skipped = false;
  }
  return output;
}
function spokenDate(date) {
  const [year, month, day] = date.split('-');
  return [...year].map(digit => digits[Number(digit)]).join('') +
    `年${chineseNumber(month)}月${chineseNumber(day)}日`;
}
function spokenTime(value) {
  const [hour, minute, second] = value.split(':');
  const h = Number(hour), period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  return `${period}${chineseNumber(h % 12 || 12)}點${Number(minute) ? `${chineseNumber(minute)}分` : '整'}` +
    (second && Number(second) ? `${chineseNumber(second)}秒` : '');
}

export function spokenExpiryText(text) {
  return text.replace(/(有效(?:期限|期)?(?:至|為|到)?[：:\s]*)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))/g,
    (_match, label, timestamp) => {
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) throw new Error('Invalid expiry timestamp in speech output');
      const local = localDateTime(date.toISOString(), 'Asia/Taipei');
      return label + '台北時間' + spokenDate(local.slice(0, 10)) + spokenTime(local.slice(11, 16));
    });
}

export function withoutSpeechSources(canonical) {
  let sourceList = false;
  const lines = [];
  for (const line of canonical.split(/\r?\n/)) {
    const clean = line.trim().replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '');
    const heading = clean.match(/^(?:(?:知識|資料|參考|引用)?來源|參考資料|引用資料|sources?|references?|citations?)(?:[（(][^）)\n]*[）)])?\s*(?:[:：]|$)/i);
    if (heading) {
      const followingSentence = clean.slice(heading[0].length).match(/[。；]\s*(.+)$/)?.[1];
      sourceList = !followingSentence;
      if (followingSentence) lines.push(followingSentence);
      continue;
    }
    if (sourceList && /^\s*(?:[-*•]|\d+[.)])\s+/.test(line) &&
        /https?:\/\/|\.txt\b|【[^】]*†/.test(line)) continue;
    if (clean) sourceList = false;
    lines.push(line);
  }
  return lines.join('\n').replace(/【[^】\n]*†(?:source|[^\s】]*file[^\s】]*)】|(?:filecite|cite)[^\n]*/g, '').trim();
}

// Display/tool facts stay canonical. Only synthesis input omits source metadata and normalizes pronunciation.
export function speechText(canonical) {
  const protectedParts = [];
  const protect = value => {
    protectedParts.push(value);
    return `\uE000${String.fromCharCode(0xE100 + protectedParts.length - 1)}\uE001`;
  };
  let text = spokenExpiryText(withoutSpeechSources(canonical)).replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/checkout\/[^)\s]+)\)/g,
    (_match, _label, url) => protect(url.includes('/checkout/') ? '結帳連結已放在對話中' : '連結已放在對話中'));
  text = text.replace(/https?:\/\/[^\s<>"'）。，；]+|\/checkout\/[a-f0-9]{64}(?:[?#][^\s<>"'）。，；]*)?/gi,
    url => protect(url.includes('/checkout/') ? '結帳連結已放在對話中' : '連結已放在對話中'));
  text = text.replace(/(?<![A-Za-z0-9_./-])(\d{1,2})\/(\d{1,2})\s*[-–—~～]\s*(\d{1,2})\/(\d{1,2})(?![A-Za-z0-9_./-])/g,
    (range, startMonth, startDay, endMonth, endDay) => {
      const valid = (month, day) => Number(month) >= 1 && Number(month) <= 12 &&
        Number(day) >= 1 && Number(day) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1];
      if (!valid(startMonth, startDay) || !valid(endMonth, endDay)) return range;
      return protect(`${chineseNumber(startMonth)}月${chineseNumber(startDay)}號到${chineseNumber(endMonth)}月${chineseNumber(endDay)}號`);
    });
  text = text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?/g, value => {
    const zoned = /Z|[+-]\d{2}:\d{2}$/.test(value);
    const date = new Date(zoned ? value : value + 'Z');
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp in speech output');
    const local = zoned ? localDateTime(date.toISOString(), 'Asia/Taipei') : value;
    const seconds = value.match(/T\d{2}:\d{2}:(\d{2})/)?.[1];
    const milliseconds = value.match(/\.(\d{1,3})/)?.[1];
    return protect((zoned ? '臺灣時間' : '') + spokenDate(local.slice(0, 10)) +
      spokenTime(local.slice(11, 16) + (seconds ? `:${seconds}` : '')) +
      (milliseconds && Number(milliseconds) ? `又${chineseNumber(milliseconds.padEnd(3, '0'))}毫秒` : ''));
  });
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, date => protect(spokenDate(date)));
  text = text.replace(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g, time => protect(spokenTime(time)));
  text = text.replace(/(?:TWD|NT\$)\s*([\d,]+(?:\.\d{1,2})?)/gi, (_match, amount) => {
    const [integer, decimal] = amount.replaceAll(',', '').split('.');
    return protect(`新臺幣${chineseNumber(integer)}${decimal ? '點' + [...decimal].map(n => digits[Number(n)]).join('') : ''}元`);
  });
  text = text.replace(/(\d[\d,]*(?:\.\d{1,2})?)\s*元/g, (_match, amount) => {
    const [integer, decimal] = amount.replaceAll(',', '').split('.');
    return protect(`${chineseNumber(integer)}${decimal ? '點' + [...decimal].map(n => digits[Number(n)]).join('') : ''}元`);
  });
  text = text.replace(/\b(?:Asia|America|Europe|Australia|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g, zone => {
    if (!timezoneNames[zone]) throw new Error('No vetted spoken timezone label');
    return protect(timezoneNames[zone]);
  });
  text = text.replace(/\b(?:DEMO-FLT-[A-Za-z0-9-]+|SIM-[a-f0-9-]+|[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}|[A-Za-z]+(?:-?[A-Za-z]*\d)[A-Za-z0-9-]*)\b/gi,
    code => protect((/^DEMO-FLT-/i.test(code) ? '模擬班號，' : '') + digitByDigit(code.replaceAll('-', ''))));
  text = text.replace(/\b[A-Z]{2,4}\b/g, word => airportCodes.has(word) ? protect(digitByDigit(word)) : word);
  text = text.replace(/\d+(?=\s*(?:位|人|成人|天|分鐘|秒|小時|回合|班|個|年|月|日|元|詞|次))/g, number => protect(chineseNumber(number)));
  text = text.replace(/版本\s*(\d+)/g, (_match, number) => protect(`版本${chineseNumber(number)}`));
  text = text.replace(/\d+/g, number => protect(digitByDigit(number)));
  return text.replace(/\uE000([\uE100-\uF8FF])\uE001/g, (_match, char) => protectedParts[char.charCodeAt(0) - 0xE100])
    .replace(/[→]/g, '到').replace(/[／/]/g, '、');
}
