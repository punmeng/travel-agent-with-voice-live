import { readFileSync } from 'node:fs';

export const network = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url)));
export const knowledge = JSON.parse(readFileSync(new URL('../data/planner-knowledge.json', import.meta.url)));
export const airports = network.airports.map(([code, city, name, timezone]) => ({ code, city, name, timezone }));
export const airportMap = new Map(airports.map(a => [a.code, a]));
export const routes = network.spokes.flatMap(([from, to, minutes, baseFare], i) =>
  [[from, to], [to, from]].map(([origin, destination], direction) => ({
    id: `MOCK-R${i * 2 + direction + 1}`, origin, destination, minutes, baseFare,
    cabins: minutes >= 480 ? ['economy', 'premium', 'business'] : ['economy', 'business'],
    mock: true, marketingCarrier: 'DEMO', operatingCarrier: 'DEMO', codeshare: false,
    routeEvidenceStatus: 'synthetic-demo-not-real-world'
  })));
export const isSyntheticDemoOnly = record => record?.marketingCarrier === 'DEMO' && record?.operatingCarrier === 'DEMO' && record?.codeshare === false;
export const isEligibleSyntheticFlight = flight => isSyntheticDemoOnly(flight) && flight.mock === true &&
  /^DEMO-FLT-[\w-]+$/.test(flight.flightNumber) && routes.some(route =>
    isSyntheticDemoOnly(route) && route.id === flight.routeId && route.origin === flight.origin && route.destination === flight.destination);

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
export function localDateTime(iso, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function localToUtc(date, time, timezone) {
  const target = Date.parse(`${date}T${time}:00Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const actual = Date.parse(`${localDateTime(guess, timezone)}:00Z`);
    const delta = target - actual;
    guess += delta;
    if (!delta) return new Date(guess).toISOString();
  }
  throw new Error(`Unrepresentable local time: ${date} ${time} ${timezone}`);
}
function hash(text) {
  return [...text].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7);
}
export function generateFlights(date) {
  if (date < network.metadata.startDate || date >= addDays(network.metadata.startDate, network.metadata.days)) return [];
  return routes.filter(isSyntheticDemoOnly).flatMap(route => [0, 1].map(slot => {
    const id = `${route.id}-${date}-${slot}`;
    const departureUtc = localToUtc(date, slot ? '23:40' : '08:30', airportMap.get(route.origin).timezone);
    const arrivalUtc = new Date(Date.parse(departureUtc) + route.minutes * 60000).toISOString();
    return {
      id, routeId: route.id, mock: true, flightNumber: `DEMO-FLT-${route.id.slice(6)}${slot}`,
      marketingCarrier: 'DEMO', operatingCarrier: 'DEMO', codeshare: false, routeEvidenceStatus: route.routeEvidenceStatus,
      origin: route.origin, destination: route.destination, departureUtc, arrivalUtc,
      departureLocal: localDateTime(departureUtc, airportMap.get(route.origin).timezone),
      arrivalLocal: localDateTime(arrivalUtc, airportMap.get(route.destination).timezone),
      originTimezone: airportMap.get(route.origin).timezone,
      destinationTimezone: airportMap.get(route.destination).timezone,
      durationMinutes: route.minutes,
      cabins: route.cabins.map(cabin => ({
        cabin, available: hash(`${id}-${cabin}`) % 9,
        currency: 'TWD', unitTotal: Math.round(route.baseFare *
          ({ economy: 1, premium: 1.7, business: 3.1 }[cabin])) + (hash(id) % 6) * 200
      }))
    };
  }));
}
