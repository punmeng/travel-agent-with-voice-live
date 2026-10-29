import { englishAirport, englishCabin, englishPlace } from './language.js';
import { markQuote } from './replies.js';

const money = (total, currency = 'TWD') => `${currency} ${total.toLocaleString('en-US')}`;
const disclaimer = 'Synthetic demo only. No reservation, ticketing or payment.';
const questions = {
  origin: 'Which city or airport would you like to depart from?',
  destination: 'Which city or airport would you like to visit?',
  date: 'What is your departure date? Please include the year.',
  returnDate: 'What is your return date? Please include the year.',
  travelers: 'How many adults are travelling?',
  cabin: 'Would you prefer economy, premium economy or business class?'
};
const purpose = value => ({ 商務出差: 'business trip', 休閒旅遊: 'leisure trip' })[value] ?? value ?? 'trip';
function tripDescription(trip) {
  if (!trip) return '';
  const place = field => (trip[`${field}Airports`] ?? [trip[field]]).map(englishAirport).join(' / ');
  return `${place('origin')} → ${place('destination')}; departure ${trip.date}; ${trip.returnDate ? `return ${trip.returnDate}` : 'one-way'}; ` +
    `${trip.travelers} adult(s), ${englishCabin(trip.cabin)}${trip.budget ? `; flight budget ${money(trip.budget)}` : ''}.`;
}
function offerDescription(offer, index) {
  const leg = flight => `${flight.flightNumber}: ${englishAirport(flight.origin)} ${flight.departureLocal} (${flight.originTimezone}) → ` +
    `${englishAirport(flight.destination)} ${flight.arrivalLocal} (${flight.destinationTimezone})`;
  return `${index + 1}. ${leg(offer.flight)}${offer.returnFlight ? `\nReturn: ${leg(offer.returnFlight)}` : ''}\n` +
    `${offer.travelers} adult(s), ${englishCabin(offer.cabin)}, ${offer.returnFlight ? 'round-trip' : 'one-way'} synthetic tax-inclusive total ${money(offer.total, offer.currency)}. ` +
    `Expires ${offer.expiresAt}.\nSay “select flight ${index + 1}” to select this current option.`;
}
function quoteDescription(quote) {
  return `Current synthetic quote: ${money(quote.total, quote.currency)} (adult total, synthetic taxes included).\n` +
    (quote.priceChanged ? `Previous total ${money(quote.previousTotal, quote.currency)} → ${money(quote.total, quote.currency)}; prior consent is invalid.\n` : '') +
    `Quote version ${quote.version}; expires ${quote.expiresAt}.\n` +
    'Read the complete quote, then say exactly “confirm current quote” to accept this version, amount, currency and expiry.\n' + disclaimer;
}
export function englishPlan(session, { day = null, detail = 'summary', dayAdvice } = {}, now = Date.now()) {
  const discovery = session.discovery, trip = session.trip ?? session.draft, planning = discovery.planning ?? {};
  const count = discovery.durationDays ?? 3, meetings = planning.meetings ?? [], activities = planning.activities ?? [];
  const offers = [...session.offers.values()].filter(offer => Date.parse(offer.expiresAt) > now);
  const overnight = trip.date && offers.length > 0 && offers.every(offer => offer.flight.arrivalLocal.slice(0, 10) > trip.date);
  const lines = day ? [] : [
    `${englishPlace(discovery.destinationCity ?? discovery.country ?? 'Destination to be confirmed')} — ${count}-day ${purpose(planning.purpose)}; ` +
    (trip.travelers ? `${trip.travelers} adult(s).` : 'number of adults to be confirmed.'),
    ...(session.trip ? [tripDescription(session.trip)] : [])
  ];
  for (let index = 1; index <= count; index++) {
    if (day && index !== day) continue;
    const blocks = meetings.filter(block => block.day === index);
    const events = activities.filter(activity => activity.day === index);
    const date = trip.date ? new Date(Date.parse(`${trip.date}T12:00:00Z`) + (index - 1) * 86400000).toISOString().slice(0, 10) : null;
    const parts = blocks.length ? blocks.map(block => `Meeting ${block.start}–${block.end} at ${block.location}; no sightseeing during this time`) :
      [index === 1 ? overnight ? `Departure; synthetic flight arrives ${offers[0].flight.arrivalLocal.slice(0, 10)}. Check-in date needs confirmation`
        : 'Arrival, airport transfer and check-in, subject to the selected flight' :
        index === count ? 'Check-out and airport transfer, subject to the return flight' : 'Flexible local activities and rest'];
    parts.push(...events.map(event => `${blocks.length && event.period !== 'evening' ? 'Activity needs scheduling outside meeting hours: ' : ''}${event.description}`));
    lines.push(`Day ${index}${date ? ` (${date})` : ''}: ${parts.join('; ')}.`);
    if (detail === 'detailed') {
      lines.push(`Suggestion (transport and venue details need verification): ${dayAdvice?.[index] ?? (blocks.length
        ? 'Have breakfast before the meeting and allow transfer and entry time. Follow the organiser’s meal and break schedule; plan dinner and rest after the meeting.'
        : index === 1 ? 'Keep arrival day light. Confirm immigration, airport transport, baggage and hotel check-in arrangements before planning nearby dining and rest.'
          : index === count ? 'Pack before check-out and work backwards from the confirmed flight and airport check-in requirements. Avoid fixed sightseeing before return details are known.'
            : 'Group nearby activities, allow seated breaks and meals, and use transport for longer distances. Confirm venue opening times before departure.')}`);
    }
  }
  if (trip.lowWalking) lines.push('Low-walking preference: group nearby sights, take seated breaks and use transport for longer distances.');
  if (planning.lodging?.area) lines.push(`Preferred accommodation area: ${planning.lodging.area}.`);
  else if (meetings.some(block => /東京車站|Tokyo Station/i.test(block.location))) {
    lines.push('Accommodation suggestion: Yaesu / Nihonbashi near Tokyo Station; suitability and availability need verification.');
  }
  if (planning.airportTransfers) lines.push(trip.destination === 'NRT'
    ? 'Airport transport suggestion: compare Narita–Tokyo rail and airport buses; verify schedules, access and fares.'
    : 'Airport transport suggestion: compare rail, bus or shuttle options for the confirmed airports; verify schedules, access and fares.');
  if (!day && planning.budget) {
    const budget = planning.budget, offer = offers[0];
    lines.push(`${budget.includes.includes('flight') ? 'Flights and accommodation' : 'Accommodation'} budget ceiling: ${money(budget.total)}; ` +
      `${planning.lodging?.nights ?? 'unconfirmed number of'} night(s).`);
    if (budget.includes.includes('flight') && offer) {
      const remainder = budget.total - offer.total;
      lines.push(`${offer.returnFlight ? 'Round-trip' : 'Outbound'} synthetic fare: ${money(offer.total)}. ` +
        (remainder >= 0 ? `${offer.returnFlight ? 'Accommodation' : 'Return flight and accommodation together'} may use up to ${money(remainder)}.`
          : 'This flight exceeds the combined budget; adjust the budget or flight.'));
    } else lines.push('No current flight candidate price is available for allocating the combined budget.');
    const adults = trip.travelers ?? 1;
    if (budget.separate.includes('transport')) lines.push(`Separate transport allowance: ${money((2000 + count * 200) * adults)} ` +
      `(per adult: two airport transfers × TWD 1,000 plus ${count} city days × TWD 200).`);
    if (budget.separate.includes('meals')) lines.push(`Separate meal allowance: ${money(count * 1200 * adults)} ` +
      `(per adult: three meals × TWD 400 × ${count} days).`);
    lines.push('These are budgeting assumptions, not supplier quotes. No hotel prices or availability have been checked.');
  }
  if (!day) {
    const missing = ['origin', 'destination', 'date', 'travelers', 'cabin'].filter(key => trip[key] === undefined);
    lines.push(missing.length ? `To confirm: ${missing.map(key => ({ origin: 'departure airport', destination: 'arrival airport',
      date: 'departure date including year', travelers: 'adult count', cabin: 'cabin' })[key]).join(', ')}.` :
      'Flight times, accommodation suitability and any return-flight needs still require confirmation.');
    if (trip.returnDate && trip.date && Math.round((Date.parse(trip.returnDate) - Date.parse(trip.date)) / 86400000) + 1 !== count) {
      lines.push('The saved departure/return dates and stated trip duration differ. Please confirm the intended duration.');
    }
    lines.push(disclaimer);
  }
  return lines.join('\n');
}
function followUp(session, clarification) {
  const discovery = session.discovery, draft = session.trip ?? session.draft;
  const observation = discovery.lastReturnDateObservation?.status !== 'exact' && discovery.lastReturnDateObservation ||
    discovery.lastDateObservation?.status !== 'exact' && discovery.lastDateObservation;
  if (observation?.status && ['invalid', 'past', 'ambiguous', 'approximate'].includes(observation.status)) {
    return `Please clarify the exact travel date, including its year (${observation.status}). No unconfirmed date will be guessed.`;
  }
  const field = discovery.followUpQuestion?.field;
  const choice = discovery[`${field}AirportChoice`];
  if (choice?.candidates.length > 1 && !choice.accepted.length) return `${englishPlace(choice.city)} has these reference airports: ` +
    `${choice.candidates.map(englishAirport).join(' or ')}. Which do you prefer? You can say “either airport”.`;
  if (discovery.ambiguousPlace) return `Which country do you mean for “${discovery.ambiguousPlace.query}”?`;
  if (clarification && Object.keys(discovery.pending ?? {}).some(key => /origin|destination/.test(key))) {
    return questions[field] ?? 'Which city or airport do you mean? The previous confirmed journey remains on screen.';
  }
  if (session.trip) return `${tripDescription(session.trip)}\nWould you like to plan the itinerary, search flights or update these requirements?\n${disclaimer}`;
  if (discovery.searchRequested) {
    const missing = field ?? ['origin', 'destination', 'date',
      ...((discovery.roundTripRequested || discovery.returnDatePreference) ? ['returnDate'] : []),
      'travelers', 'cabin'].find(key => draft[key] === undefined);
    if (missing) return questions[missing];
  }
  if (discovery.destinationCity || discovery.country) return `Noted your interest in ${englishPlace(discovery.destinationCity ?? discovery.country)}. ` +
    (discovery.durationDays ? `You have requested ${discovery.durationDays} days. ` : '') +
    'What experiences and pace would you enjoy? You can plan before choosing exact flights.';
  return questions[field] ?? 'Where would you like to travel, and what would you enjoy doing?';
}
export function englishResponseSections(session, { route, work, presentation, receipt, memberRankingText, text, modelSuggestion, intentReply, clarification, dayAdvice, searched, now }) {
  if (route.reason === 'confirm') {
    const checkout = [...session.checkouts.values()].find(value => value.quoteId === receipt.quoteId);
    return [{ text: `Simulated confirmation total ${money(receipt.total, receipt.currency)}.\nSimulated reference: ${receipt.id}\n` +
      `Checkout link: ${checkout.path}\nExpires ${checkout.expiresAt}; a trip change or repricing invalidates this link.\n${disclaimer}` }];
  }
  if (route.reason === 'select') {
    const offer = session.offers.get(session.selected), index = [...session.offers.keys()].indexOf(offer.id);
    return [{ text: `Selected flight ${index + 1}: ${offer.travelers} adult(s), ${englishCabin(offer.cabin)}, synthetic candidate total ${money(offer.total, offer.currency)}.\n` +
      'Say “reprice” to check the current quote. No reservation or payment has been made.' }];
  }
  if (route.role === 'price' && session.quote) {
    const offer = session.offers.get(session.quote.offerId);
    return [{ text: tripDescription({ ...session.trip, origin: offer.flight.origin, destination: offer.flight.destination,
      originAirports: undefined, destinationAirports: undefined, date: offer.flight.departureLocal.slice(0, 10),
      ...(offer.returnFlight ? { returnDate: offer.returnFlight.departureLocal.slice(0, 10) } : {}) }) },
    { text: quoteDescription(session.quote), quoteKey: markQuote(session.quote) }];
  }
  if (route.role === 'price') return [{ text: 'Search flights, read the current options, say “select flight 2”, then “reprice”. All prices are synthetic.' }];
  if (route.reason === 'knowledge') return [{ text }];
  const sections = [];
  if (work.plan) sections.push({ text: englishPlan(session, { ...presentation, dayAdvice }, now) +
    (modelSuggestion ? `\nSuggestion: ${modelSuggestion}` : '') });
  if ((route.role === 'flight' || presentation.flights && work.plan) && session.trip) {
    const offers = [...session.offers.values()];
    session.presentedOffers = new Set();
    sections.push(...(offers.length ? offers.map((offer, index) => ({
      text: `${index === 0 ? `Synthetic flights / fares: ${offers.length} option(s).\n${memberRankingText ? `${memberRankingText}\n` : ''}` : ''}${offerDescription(offer, index)}`, offerId: offer.id
    })) : [{ text: searched
      ? 'No matching synthetic flights or seats were found. Try another date or cabin. This demo does not describe real airline supply.'
      : 'No flight search was performed in this turn. Say “search flights” when you want synthetic candidate fares.' }]));
  }
  if (!sections.length) sections.push({ text: intentReply ?? followUp(session, clarification) });
  return sections;
}
export function englishSpeech(session, text, { route, work, presentation, memberRankingText }) {
  if (presentation.detail === 'detailed' || ['select', 'confirm'].includes(route.reason) || session.quote && route.role === 'price') {
    return { text, detail: 'detailed' };
  }
  if (work.plan) {
    const discovery = session.discovery, planning = discovery.planning ?? {}, trip = session.trip ?? session.draft;
    const parts = [`Your ${discovery.durationDays ?? 3}-day ${purpose(planning.purpose)} to ${englishPlace(discovery.destinationCity ?? 'your destination')} is on screen.`];
    if (planning.meetings?.length) parts.push(`Meeting times on day(s) ${[...new Set(planning.meetings.map(block => block.day))].join(', ')} are reserved.`);
    if (planning.activities?.length) parts.push(`Saved activities: ${planning.activities.map(activity => activity.description).join('; ')}.`);
    if (planning.budget) parts.push(`The ${planning.budget.includes.includes('flight') ? 'flight and accommodation' : 'accommodation'} budget is ${money(planning.budget.total)}.`);
    if (trip.lowWalking) parts.push('The low-walking preference is preserved.');
    parts.push('The complete itinerary and any synthetic flight prices are shown on screen. Nothing is booked.');
    return { text: parts.join(' '), detail: 'summary' };
  }
  if (route.role === 'flight' && session.offers.size) {
    const offer = [...session.offers.values()][0];
    return { text: `${memberRankingText ? `${memberRankingText} ` : ''}There are ${session.offers.size} synthetic flight options on screen. For example, ${offer.flight.flightNumber} departs ${offer.flight.departureLocal}; ` +
      `the tax-inclusive total for ${offer.travelers} adult(s) is ${money(offer.total, offer.currency)}. No flight is selected or booked.`, detail: 'summary' };
  }
  return { text, detail: 'summary' };
}
