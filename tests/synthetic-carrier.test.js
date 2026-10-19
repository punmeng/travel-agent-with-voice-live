import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routes, generateFlights, isSyntheticDemoOnly } from '../lib/dataset.js';
import { createSession, setTrip, callTool, selectOffer } from '../lib/core.js';

test('all generated and indexed flight/fare records are explicitly hypothetical DEMO marketing and operating only', () => {
  for (const route of routes) {
    assert.ok(isSyntheticDemoOnly(route));
    assert.equal(route.routeEvidenceStatus, 'synthetic-demo-not-real-world');
    assert.ok(!['TSA', 'AKL', 'CEB'].includes(route.origin));
    assert.ok(!['TSA', 'AKL', 'CEB'].includes(route.destination));
  }
  const manifest = JSON.parse(readFileSync(new URL('../data/knowledge/manifest.json', import.meta.url)));
  assert.equal(manifest.counts.flights, 20640);
  for (const file of manifest.files.filter(f => ['flight', 'fare'].includes(f.kind))) {
    const text = readFileSync(new URL(`../data/knowledge/${file.filename}`, import.meta.url), 'utf8');
    assert.match(text, /synthetic-demo-not-real-world/);
    for (const line of text.split('\n').filter(line => line.startsWith('{'))) {
      const record = JSON.parse(line);
      assert.ok(isSyntheticDemoOnly(record));
      const flight = record.flightReference ?? record;
      assert.ok(isSyntheticDemoOnly(flight)); assert.match(flight.flightNumber, /^DEMO-FLT-/);
    }
  }
  const original = routes[0].operatingCarrier;
  try {
    routes[0].operatingCarrier = 'AE';
    assert.ok(generateFlights('2026-11-12').every(f => f.routeId !== routes[0].id));
  } finally { routes[0].operatingCarrier = original; }
});
test('search and subsequent offer access reject non-DEMO/codeshare contamination defensively', async () => {
  const s = createSession();
  setTrip(s, { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2,
    cabin: 'economy', flexibleDays: 0, budget: null, lowWalking: false });
  const args = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2, cabin: 'economy', flexibleDays: 0 };
  const result = await callTool(s, 'flight', 'search_flights', args);
  assert.ok(result.data.offers.every(o => isSyntheticDemoOnly(o.flight)));
  const offer = result.data.offers[0];
  offer.flight.operatingCarrier = 'AE';
  await assert.rejects(callTool(s, 'flight', 'get_offer', { offerId: offer.id }), { code: 'CARRIER_FORBIDDEN' });
  assert.throws(() => selectOffer(s, offer.id), { code: 'CARRIER_FORBIDDEN' });
  await assert.rejects(callTool(s, 'flight', 'search_flights', { ...args, operatingCarrier: 'AE' }), { name: 'ZodError' });
});
