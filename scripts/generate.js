import { mkdirSync, writeFileSync } from 'node:fs';
import { network, routes, airports, generateFlights, addDays } from '../lib/dataset.js';

const flights = Array.from({ length: network.metadata.days }, (_, i) =>
  generateFlights(addDays(network.metadata.startDate, i))).flat();
const fares = flights.flatMap(flight => flight.cabins.map(cabin => ({
  id: `${flight.id}-${cabin.cabin}`, flightId: flight.id, ...cabin, mock: true,
  marketingCarrier: flight.marketingCarrier, operatingCarrier: flight.operatingCarrier, codeshare: false
})));
mkdirSync(new URL('../data/generated/', import.meta.url), { recursive: true });
for (const [name, records] of Object.entries({ airports, routes, flights, fares })) {
  writeFileSync(new URL(`../data/generated/${name}.json`, import.meta.url),
    JSON.stringify({ metadata: network.metadata, records }, null, 2) + '\n');
}
console.log(`Generated deterministic mock data: ${airports.length} airports, ${routes.length} routes, ${flights.length} flights, ${fares.length} fares.`);
