import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { airports, network, generateFlights, addDays, isEligibleSyntheticFlight } from './dataset.js';
import { resolveCitySchema, resolveCityAirports } from './city-airports.js';

export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new AppError(code, message, status); };
export const airportCode = z.string().refine(s => airports.some(a => a.code === s), '不支援的機場代碼');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const time = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === s;
}, '請提供有效的完整日期與年份');
export const tripSchema = z.object({
  origin: airportCode, destination: airportCode, date: dateSchema,
  originAirports: z.array(airportCode).min(1).max(2).optional(),
  destinationAirports: z.array(airportCode).min(1).max(2).optional(),
  travelers: z.number().int().min(1).max(6),
  cabin: z.enum(['economy', 'premium', 'business']),
  budget: z.number().int().min(1000).max(2000000).nullable(),
  lowWalking: z.boolean(), flexibleDays: z.number().int().min(0).max(1),
  returnDate: dateSchema.optional(), timePreference: z.enum(['any', 'early-out-late-back']).optional()
}).strict().refine(t => t.origin !== t.destination && (!t.returnDate || t.returnDate >= t.date) &&
  (!t.originAirports || (new Set(t.originAirports).size === t.originAirports.length && t.originAirports[0] === t.origin)) &&
  (!t.destinationAirports || (new Set(t.destinationAirports).size === t.destinationAirports.length && t.destinationAirports[0] === t.destination)),
  '出發地與目的地不可相同；回程日期不可早於出發；機場集合須有效');
export const searchSchema = z.object({
  origin: airportCode, destination: airportCode, date: dateSchema,
  travelers: z.number().int().min(1).max(6), cabin: z.enum(['economy', 'premium', 'business']),
  flexibleDays: z.number().int().min(0).max(1)
}).strict();
export const toolSchemas = {
  list_airports: z.object({}).strict(),
  resolve_city_airports: resolveCitySchema,
  search_flights: searchSchema,
  get_offer: z.object({ offerId: z.string().uuid() }).strict(),
  reprice_offer: z.object({ offerId: z.string().uuid() }).strict()
};
export const entitlements = {
  intent: ['list_airports', 'resolve_city_airports'], planner: ['list_airports', 'resolve_city_airports'],
  flight: ['list_airports', 'resolve_city_airports', 'search_flights', 'get_offer'],
  price: ['get_offer', 'reprice_offer']
};
export function createSession(now = Date.now()) {
  return {
    id: randomUUID(), createdAt: now, updatedAt: now, trip: null,
    offers: new Map(), selected: null, quote: null, consent: null, bookings: new Map(),
    receipts: new Map(), toolUnits: 0, turns: 0, activeAgent: 'intent',
    stage: 'Discover', history: [], busy: false, draft: {}, chatRequests: new Map(),
    discovery: { country: null, destinationCity: null, originCity: null, interests: [], pending: {} },
    cloudRequests: 0, cloudTokens: 0
  };
}
function validOffer(session, id, now) {
  const offer = session.offers.get(id);
  if (!offer) fail('OFFER_NOT_FOUND', '此報價不屬於目前工作階段。', 404);
  if (!isEligibleSyntheticFlight(offer.flight) || (offer.returnFlight && !isEligibleSyntheticFlight(offer.returnFlight))) {
    fail('SYNTHETIC_FLIGHT_FORBIDDEN', '僅接受本專案生成的合成示範班次；此候選不符合範圍。', 403);
  }
  if (Date.parse(offer.expiresAt) <= now) fail('OFFER_EXPIRED', '報價已過期，請重新搜尋。', 409);
  return offer;
}
export function setTrip(session, input) {
  const trip = tripSchema.parse(input);
  if (JSON.stringify(trip) !== JSON.stringify(session.trip)) {
    session.offers.clear(); session.selected = null; session.quote = null; session.consent = null;
    session.replyPages = []; session.presentedOffers = new Set(); session.presentedQuote = null;
  }
  session.trip = trip;
  session.draft = { ...trip };
  return trip;
}
export async function boundedMap(items, limit, fn) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      output[current] = await fn(items[current]);
    }
  }));
  return output;
}
export async function callTool(session, agent, name, raw, { now = Date.now(), priceDelta = 0 } = {}) {
  if (!entitlements[agent]?.includes(name)) fail('TOOL_FORBIDDEN', '代理沒有此工具的權限。', 403);
  const args = toolSchemas[name].parse(raw);
  const returnDate = name === 'search_flights' ? session.trip?.returnDate : undefined;
  // A tool's anchor is not an airport selection: explicit accepted sets expand as one bounded search.
  const origins = name === 'search_flights' && args.origin === session.trip?.origin ? session.trip.originAirports ?? [args.origin] : [args.origin];
  const destinations = name === 'search_flights' && args.destination === session.trip?.destination ? session.trip.destinationAirports ?? [args.destination] : [args.destination];
  const cost = name === 'search_flights' ? origins.length * destinations.length * (1 + args.flexibleDays * 2) * (returnDate ? 2 : 1) : 1;
  if (session.toolUnits + cost > 60) fail('TOOL_BUDGET', '此工作階段已達 60 次工具預算，請開啟新旅程。', 429);
  session.toolUnits += cost;
  const correlationId = randomUUID();
  let data;
  if (name === 'list_airports') data = { airports, metadata: network.metadata };
  if (name === 'resolve_city_airports') data = resolveCityAirports(args);
  if (name === 'search_flights') {
    session.replyPages = []; session.presentedOffers = new Set(); session.presentedQuote = null;
    const days = Array.from({ length: 1 + args.flexibleDays * 2 }, (_, i) => addDays(args.date, i - args.flexibleDays));
    const searches = origins.flatMap(origin => destinations.flatMap(destination => days.map(date => ({ origin, destination, date }))));
    const groups = await boundedMap(searches, 2, async ({ origin, destination, date }) => generateFlights(date)
      .filter(f => isEligibleSyntheticFlight(f) && f.origin === origin && f.destination === destination && origin !== destination)
      .flatMap(flight => {
        const fare = flight.cabins.find(c => c.cabin === args.cabin && c.available >= args.travelers);
        if (!fare) return [];
        const returns = returnDate ? generateFlights(addDays(returnDate, days.indexOf(date) - args.flexibleDays))
          .filter(f => isEligibleSyntheticFlight(f) && f.origin === destination && f.destination === origin && f.departureUtc > flight.arrivalUtc)
          .flatMap(returnFlight => {
            const returnFare = returnFlight.cabins.find(c => c.cabin === args.cabin && c.available >= args.travelers);
            return returnFare ? [{ returnFlight, returnFare }] : [];
          }) : [{ returnFlight: null, returnFare: null }];
        return returns.map(({ returnFlight, returnFare }) => ({
          id: randomUUID(), mock: true, flight, cabin: args.cabin, travelers: args.travelers,
          ...(returnFlight ? { returnFlight } : {}),
          unitTotal: fare.unitTotal + (returnFare?.unitTotal ?? 0),
          total: (fare.unitTotal + (returnFare?.unitTotal ?? 0)) * args.travelers, currency: 'TWD',
          expiresAt: new Date(now + 10 * 60000).toISOString()
        }));
      }));
    const timeScore = offer => session.trip?.timePreference === 'early-out-late-back'
      ? Number(offer.flight.departureLocal.slice(11, 13)) - Number(offer.returnFlight?.departureLocal.slice(11, 13) ?? 0) : 0;
    const offers = groups.flat().sort((a, b) => timeScore(a) - timeScore(b) || a.total - b.total).slice(0, 6);
    // A fresh search invalidates old selections and confirmations.
    session.offers.clear(); session.quote = null; session.consent = null; session.selected = null;
    offers.forEach(o => session.offers.set(o.id, o));
    data = { offers, searchedDates: days, searchedAirportPairs: origins.flatMap(origin => destinations.map(destination => ({ origin, destination }))),
      ...(returnDate ? { searchedReturnDates: days.map((_, i) => addDays(returnDate, i - args.flexibleDays)) } : {}),
      ranking: session.trip?.timePreference ?? 'price', coverage: network.metadata.coverage, maxParallelism: 2 };
    session.stage = 'Compare';
  }
  if (name === 'get_offer') data = validOffer(session, args.offerId, now);
  if (name === 'reprice_offer') {
    if (session.selected !== args.offerId) fail('NOT_SELECTED', '請先選擇此航班。', 409);
    const offer = validOffer(session, args.offerId, now);
    const version = (session.quote?.version ?? 0) + 1;
    session.consent = null;
    session.replyPages = []; session.presentedQuote = null;
    const quote = {
      id: randomUUID(), offerId: offer.id, version, mock: true,
      total: offer.total + priceDelta, previousTotal: session.quote?.total ?? offer.total,
      priceChanged: (offer.total + priceDelta) !== (session.quote?.total ?? offer.total), currency: offer.currency,
      expiresAt: new Date(Math.min(now + 3 * 60000, Date.parse(offer.expiresAt))).toISOString()
    };
    if (!Number.isSafeInteger(quote.total) || quote.total <= 0) fail('INVALID_PRICE', '重新報價金額無效。', 502);
    session.quote = quote; session.stage = 'Reprice'; data = quote;
  }
  return { mock: true, correlationId, tool: name, data };
}
export function selectOffer(session, offerId, now = Date.now()) {
  const offer = validOffer(session, z.string().uuid().parse(offerId), now);
  session.selected = offer.id; session.quote = null; session.consent = null; session.stage = 'Select';
  session.replyPages = []; session.presentedQuote = null;
  return offer;
}
export const consentSchema = z.object({
  quoteId: z.string().uuid(), version: z.number().int().positive(), total: z.number().int().positive(),
  currency: z.literal('TWD'), expiresAt: z.string().datetime(), accepted: z.literal(true)
}).strict();
function matchQuote(session, consent, now) {
  const quote = session.quote;
  if (!quote || quote.offerId !== session.selected) fail('REPRICE_REQUIRED', '請先重新報價。', 409);
  if (Date.parse(quote.expiresAt) <= now) fail('QUOTE_EXPIRED', '確認價已過期，請重新報價並重新同意。', 409);
  if (['quoteId', 'version', 'total', 'currency', 'expiresAt'].some(k =>
    consent[k] !== quote[k === 'quoteId' ? 'id' : k])) fail('STALE_CONSENT', '價格或版本已更新，請重新確認。', 409);
  validOffer(session, quote.offerId, now);
  return quote;
}
export function consentToQuote(session, raw, now = Date.now()) {
  const consent = consentSchema.parse(raw);
  matchQuote(session, consent, now);
  session.consent = consent;
  return { mock: true, accepted: true };
}
export const purchaseSchema = z.object({
  quoteId: z.string().uuid(), idempotencyKey: z.string().uuid()
}).strict();
export function purchase(session, raw, now = Date.now()) {
  const args = purchaseSchema.parse(raw);
  const hash = createHash('sha256').update(args.quoteId).digest('hex');
  const previous = session.receipts.get(args.idempotencyKey);
  if (previous) {
    if (previous.hash !== hash) fail('IDEMPOTENCY_CONFLICT', '此請求識別碼已用於另一報價。', 409);
    return previous.receipt;
  }
  if (!session.consent || session.consent.quoteId !== args.quoteId) fail('CONSENT_REQUIRED', '需要您明確同意目前的確認價。', 409);
  const quote = matchQuote(session, session.consent, now);
  const receipt = session.bookings.get(quote.id) ?? {
    id: `SIM-${randomUUID()}`, mock: true, status: 'SIMULATED_ONLY',
    total: quote.total, currency: quote.currency, quoteId: quote.id,
    message: '僅為模擬確認；未訂位、未開票、未付款。請勿提供護照或信用卡資料。'
  };
  session.bookings.set(quote.id, receipt);
  session.receipts.set(args.idempotencyKey, { hash, receipt }); session.stage = 'Book';
  return receipt;
}
export function publicState(session) {
  return {
    trip: session.trip, draft: session.draft, discovery: session.discovery, offers: [...session.offers.values()], selected: session.selected, quote: session.quote,
    consent: session.consent, stage: session.stage, activeAgent: session.activeAgent,
    toolUnits: session.toolUnits, turns: session.turns, mock: true
  };
}
