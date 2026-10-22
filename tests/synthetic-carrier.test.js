import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routes, generateFlights, isSyntheticDemoRecord } from '../lib/dataset.js';
import { createSession, setTrip, callTool, selectOffer } from '../lib/core.js';

test('all generated and indexed flight/fare records are synthetic demo-only', () => {
  for (const route of routes) {
    assert.ok(isSyntheticDemoRecord(route));
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
      assert.ok(isSyntheticDemoRecord(record));
      const flight = record.flightReference ?? record;
      assert.ok(isSyntheticDemoRecord(flight)); assert.match(flight.flightNumber, /^DEMO-FLT-/);
    }
  }
  const original = routes[0].operatingCarrier;
  try {
    routes[0].operatingCarrier = 'SAMPLE';
    assert.ok(generateFlights('2026-11-12').every(f => f.routeId !== routes[0].id));
  } finally { routes[0].operatingCarrier = original; }
});
test('search and subsequent offer access reject non-demo/codeshare contamination defensively', async () => {
  const s = createSession();
  setTrip(s, { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2,
    cabin: 'economy', flexibleDays: 0, budget: null, lowWalking: false });
  const args = { origin: 'TPE', destination: 'NRT', date: '2026-11-12', travelers: 2, cabin: 'economy', flexibleDays: 0 };
  const result = await callTool(s, 'flight', 'search_flights', args);
  assert.ok(result.data.offers.every(o => isSyntheticDemoRecord(o.flight)));
  const offer = result.data.offers[0];
  offer.flight.operatingCarrier = 'SAMPLE';
  await assert.rejects(callTool(s, 'flight', 'get_offer', { offerId: offer.id }), { code: 'SYNTHETIC_FLIGHT_FORBIDDEN' });
  assert.throws(() => selectOffer(s, offer.id), { code: 'SYNTHETIC_FLIGHT_FORBIDDEN' });
  await assert.rejects(callTool(s, 'flight', 'search_flights', { ...args, operatingCarrier: 'SAMPLE' }), { name: 'ZodError' });
});
