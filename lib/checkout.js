import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fail, consentToQuote } from './core.js';

export function checkoutForQuote(session, receipt, now = Date.now()) {
  if (receipt.quoteId !== session.quote?.id || !session.consent) fail('REPRICE_REQUIRED', '請先核對目前報價並明確同意。', 409);
  consentToQuote(session, session.consent, now);
  session.checkouts ??= new Map();
  const previous = [...session.checkouts.values()].find(c => c.quoteId === receipt.quoteId);
  if (previous) return previous;
  const token = randomBytes(32).toString('hex');
  const checkout = {
    provider: 'mock', mock: true, token, path: `/checkout/${token}`, quoteId: session.quote.id,
    quoteVersion: session.quote.version, offerId: session.selected, total: session.quote.total,
    currency: session.quote.currency, expiresAt: session.quote.expiresAt
  };
  session.checkouts.set(token, checkout);
  return checkout;
}
export function readCheckout(session, token, now = Date.now()) {
  const checkout = session.checkouts?.get(token);
  if (!checkout) fail('CHECKOUT_NOT_FOUND', '此模擬結帳連結不屬於目前對話。', 404);
  if (Date.parse(checkout.expiresAt) <= now) fail('CHECKOUT_EXPIRED', '模擬結帳連結已到期，請回對話重新報價並同意。', 410);
  const q = session.quote;
  if (!q || q.id !== checkout.quoteId || q.version !== checkout.quoteVersion || q.offerId !== checkout.offerId ||
      q.total !== checkout.total || q.currency !== checkout.currency || session.selected !== checkout.offerId) {
    fail('CHECKOUT_STALE', '行程或報價已變更，此連結已失效。請重新報價並同意。', 409);
  }
  consentToQuote(session, session.consent, now);
  return { checkout, offer: session.offers.get(checkout.offerId) };
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function checkoutPage({ checkout: c, offer }) {
  const leg = f => `${escape(f.flightNumber)} · ${escape(f.origin)} → ${escape(f.destination)}<br>${escape(f.departureLocal)}（${escape(f.originTimezone)}） → ${escape(f.arrivalLocal)}（${escape(f.destinationTimezone)}）`;
  const theme = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[0];
  // All itinerary fields below originate in the deterministic dataset, not model HTML.
  return `<!doctype html><html lang="zh-Hant"><head>${theme}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模擬結帳 · 梅好旅程</title><link rel="stylesheet" href="/style.css"></head>
<body><main class="conversation checkout"><div class="conversation-head"><h1>模擬結帳 · 不收款</h1><span class="badge">MOCK ONLY</span></div>
<div class="notice">這不是航空公司或支付業者的付款頁面。不接受信用卡、不扣款、不訂位、不開票。</div>
<article class="message assistant"><div><h2>您已同意的合成行程</h2><p>${leg(offer.flight)}${offer.returnFlight ? `<br>回程 ${leg(offer.returnFlight)}` : '<br>單程'}</p>
<p>${offer.travelers} 位成人 · ${escape(offer.cabin)}<br>含合成稅費總額：${c.currency} ${c.total.toLocaleString('zh-TW')}<br>報價版本：${c.quoteVersion}<br>有效至：${escape(c.expiresAt)}</p>
<p>目前沒有真實機票或付款供應商串接，因此不能購買這筆合成票價。此連結只示範未來由後端建立 provider-hosted checkout 的流程；不導向任意外部網址。</p><p><a href="/">回到旅行對話</a></p></div></article></main></body></html>`;
}
