const segmenter = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
// Opaque references and amounts are indivisible, not prose to split in the middle.
const atomic = /(?:https?:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+|\/checkout\/[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9-]{27,36}|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?|TWD\s*[\d,]+(?:\.\d+)?|DEMO-FLT-[\w-]+)/gi;
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
const quoteKey = q => q ? `${q.id}:${q.version}:${q.total}:${q.currency}:${q.expiresAt}` : null;
export function enqueueReply(session, sections) {
  session.replyPages = [];
  for (const section of sections) {
    if (section.offerId && session.offers.has(section.offerId)) {
      session.presentedOffers ??= new Set();
      session.presentedOffers.add(section.offerId);
    }
    if (section.quoteKey && section.quoteKey === quoteKey(session.quote)) session.presentedQuote = section.quoteKey;
  }
  return sections.map(section => section.text).filter(Boolean).join('\n\n');
}
export function nextReply(session) {
  session.replyPages = [];
  return '上一則回答已完整顯示。想進一步了解哪一天或哪個部分？';
}
export const quoteWasPresented = session => Boolean(session.quote) && session.presentedQuote === quoteKey(session.quote);
export const markQuote = q => quoteKey(q);
export function replyState(session, state) {
  return { ...state, quote: quoteWasPresented(session) ? state.quote : null, moreReply: Boolean(session.replyPages?.length) };
}
