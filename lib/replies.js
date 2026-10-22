const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
// Opaque references and amounts are indivisible, not prose to split in the middle.
const atomic = /(?:https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+|\/checkout\/[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9-]{27,36}|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|TWD\s*[\d,]+(?:\.\d+)?|DEMO-FLT-[\w-]+)/gi;
export const MAX_REPLY_WORDS = 50;
const continuation = '\n說「繼續」看下一段。';
function segments(text) {
  const output = [];
  let last = 0;
  for (const match of text.matchAll(atomic)) {
    output.push(...[...segmenter.segment(text.slice(last, match.index))].map(s => ({ text: s.segment, words: s.isWordLike ? 1 : 0 })));
    const words = match[0].startsWith('/checkout/') ? [...segmenter.segment('開啟模擬結帳（不收款）')].filter(s => s.isWordLike).length : 1;
    output.push({ text: match[0], words }); last = match.index + match[0].length;
  }
  output.push(...[...segmenter.segment(text.slice(last))].map(s => ({ text: s.segment, words: s.isWordLike ? 1 : 0 })));
  return output;
}
export const countWords = text => segments(text).reduce((n, s) => n + s.words, 0);
export function paginateReply(text) {
  const budget = MAX_REPLY_WORDS - countWords(continuation);
  const parts = [];
  let buffer = [], words = 0;
  for (const segment of segments(text)) {
    if (words + segment.words > budget && buffer.length) {
      let boundary = buffer.findLastIndex(s => /[。！？?\n]/.test(s.text));
      if (boundary < 0 || !buffer.slice(0, boundary + 1).some(s => s.words)) boundary = buffer.length - 1;
      parts.push(buffer.slice(0, boundary + 1).map(s => s.text).join('').trim());
      buffer = buffer.slice(boundary + 1);
      words = buffer.reduce((n, s) => n + s.words, 0);
    }
    buffer.push(segment); words += segment.words;
  }
  const final = buffer.map(s => s.text).join('').trim();
  if (final) parts.push(final);
  return parts;
}
const quoteKey = q => q ? `${q.id}:${q.version}:${q.total}:${q.currency}:${q.expiresAt}` : null;
export function enqueueReply(session, sections) {
  session.replyPages = sections.flatMap(section => {
    const parts = paginateReply(section.text);
    return parts.map((text, index) => ({
      text, ...(index === parts.length - 1 ? { offerId: section.offerId, quoteKey: section.quoteKey } : {})
    }));
  });
  return nextReply(session);
}
export function nextReply(session) {
  const page = session.replyPages?.shift();
  if (!page) return '目前沒有下一段。想調整哪部分旅程？';
  if (page.offerId && session.offers.has(page.offerId)) {
    session.presentedOffers ??= new Set();
    session.presentedOffers.add(page.offerId);
  }
  if (page.quoteKey && page.quoteKey === quoteKey(session.quote)) session.presentedQuote = page.quoteKey;
  const text = page.text + (session.replyPages.length ? continuation : '');
  if (countWords(text) > MAX_REPLY_WORDS) throw new Error('Reply word limit invariant failed');
  return text;
}
export const quoteWasPresented = session => Boolean(session.quote) && session.presentedQuote === quoteKey(session.quote);
export const markQuote = q => quoteKey(q);
export function replyState(session, state) {
  return { ...state, quote: quoteWasPresented(session) ? state.quote : null, moreReply: Boolean(session.replyPages?.length) };
}
