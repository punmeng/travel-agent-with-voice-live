import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCityAirports, createCityResolver, defaultMappingRows, validateMappingSnapshot } from '../lib/city-airports.js';
import { createSession, callTool } from '../lib/core.js';
import { chat } from '../lib/agents.js';
import { withCityTool, updateCityTools } from '../scripts/add-city-tool.js';
import { readMappingWorkbook, importMappingWorkbook } from '../scripts/import-city-airports.js';

const snapshot = () => ({ schemaVersion: 1, rows: structuredClone(defaultMappingRows), routeReferences: [] });
const codes = result => result.cities[0]?.airports.map(a => a.iata);
const lookup = query => resolveCityAirports({ query, countryCode: null });
test('vetted exact normalized geographic aliases resolve without inventing DEMO eligibility', () => {
  for (const alias of ['台北', '臺北', 'Taipei', '  Ｔａｉｐｅｉ  ']) assert.deepEqual(codes(lookup(alias)), ['TPE', 'TSA']);
  for (const alias of ['Tokyo', '東京', '东京']) assert.deepEqual(codes(lookup(alias)), ['NRT', 'HND']);
  for (const alias of ['大阪', 'osaka', 'KIX', '關西機場']) assert.deepEqual(codes(lookup(alias)), ['KIX']);
  assert.deepEqual(codes(lookup('Taoyuan')), ['TPE']);
  for (const alias of ['Taipie', 'Tok', '火星', '日本']) assert.equal(lookup(alias).status, 'not_found');
  assert.equal(resolveCityAirports({ query: 'Taipei', countryCode: 'JP' }).status, 'not_found');
  const result = lookup('台北');
  assert.equal(result.scope, 'geographic-membership-only');
  assert.equal(result.syntheticRouteEligibility, 'not-determined');
  assert.equal(result.provenance.officialNetworkVerified, false);
  for (const airport of result.cities[0].airports) {
    assert.ok(airport.source); assert.equal(airport.updatedAt, '2026-10-19'); assert.equal(airport.timezone, 'Asia/Taipei');
    assert.equal(airport.marketingCarrier, undefined);
  }
});
test('same alias across countries is ambiguous, country answer resolves state without a silent first match', async () => {
  const raw = snapshot();
  for (const id of ['tw-taipei', 'jp-tokyo']) {
    raw.rows.push(...raw.rows.filter(row => row.city_id === id && row.alias === (id === 'tw-taipei' ? '台北' : '東京'))
      .map(row => ({ ...row, alias: 'Shared City' })));
  }
  const resolver = createCityResolver(raw);
  assert.equal(resolver.resolve({ query: 'Shared City', countryCode: null }).status, 'ambiguous');
  assert.deepEqual(codes(resolver.resolve({ query: 'Shared City', countryCode: 'JP' })), ['NRT', 'HND']);
  const session = createSession(), dependencies = { resolver };
  let result = await chat(session, { message: '去Shared City查航班' }, { APP_MODE: 'mock' }, dependencies);
  // The raw city answer itself is a vetted span, not a fuzzy substring of an unknown city.
  if (!session.discovery.ambiguousPlace) result = await chat(session, { message: 'Shared City' }, { APP_MODE: 'mock' }, dependencies);
  assert.match(result.text, /哪個國家/);
  assert.equal(session.draft.destination, undefined);
  result = await chat(session, { message: '日本' }, { APP_MODE: 'mock' }, dependencies);
  assert.equal(session.discovery.ambiguousPlace, undefined);
  assert.deepEqual(session.discovery.destinationAirportChoice.candidates, ['NRT', 'HND']);
  result = await chat(session, { message: '都可以' }, { APP_MODE: 'mock' }, dependencies);
  assert.deepEqual(session.draft.destinationAirports, ['NRT', 'HND']);
  assert.doesNotMatch(result.text, /哪個國家|哪一座/);
});
test('English/Taipei alias, accepted airports and exclusion survive natural followups without re-asking', async () => {
  const s = createSession(), env = { APP_MODE: 'mock' };
  const say = message => chat(s, { message, requestId: randomUUID() }, env);
  await say('從Taipei出發，幫我查航班');
  await say('都可以');
  assert.deepEqual(s.draft.originAirports, ['TPE', 'TSA']);
  let result = await say('從臺北出發');
  assert.doesNotMatch(result.text, /偏好哪一座|哪個城市出發/);
  await say('不要松山');
  assert.equal(s.draft.origin, 'TPE');
  result = await say('去東京火星');
  assert.equal(s.draft.destination, undefined);
  assert.match(result.text, /無法確定/);
  result = await say('去東京或大阪');
  assert.equal(s.draft.destination, undefined);
  assert.match(result.text, /哪個城市/);
  await say('去大阪');
  assert.equal(s.draft.destination, 'KIX');
  assert.equal(s.draft.origin, 'TPE');
});
test('MCP/shared role handler is strict and geographic only; price cannot use it', async () => {
  const session = createSession();
  const output = await callTool(session, 'flight', 'resolve_city_airports', { query: 'Taipei', countryCode: null });
  assert.deepEqual(codes(output.data), ['TPE', 'TSA']);
  assert.ok(output.correlationId);
  await assert.rejects(callTool(session, 'intent', 'resolve_city_airports', { query: 'Tokyo', countryCode: null, operatingCarrier: 'AE' }));
  await assert.rejects(callTool(session, 'price', 'resolve_city_airports', { query: 'Tokyo', countryCode: null }), { code: 'TOOL_FORBIDDEN' });
  await assert.rejects(callTool(session, 'flight', 'resolve_city_airports', { query: 'Tokyo' }));
  assert.equal(session.offers.size, 0);
});
test('mapping validation rejects duplicate/conflicting aliases, airport metadata, timezone, dates and non-DEMO routes', () => {
  const invalid = [
    data => data.rows.push(data.rows[0]),
    data => { data.rows[0].timezone = 'Fake/Timezone'; },
    data => { data.rows[0].timezone = 'Asia/Tokyo'; },
    data => { data.rows[0].updated_at = '2026-02-30'; },
    data => { data.rows[0].country_code = 'JP'; },
    data => { data.rows[0].airport_iata = 'XXX'; },
    data => { data.rows[0].city_name = 'conflict'; },
    data => { data.rows[0].alias = 'NRT'; },
    data => data.rows.splice(1, 1),
    data => { data.routeReferences = [{ origin_iata: 'TPE', destination_iata: 'KIX', marketing_carrier: 'DEMO',
      operating_carrier: 'AE', valid_from: '2026-11-01', valid_to: '2026-12-01', source: 'not-verified', updated_at: '2026-10-19' }]; }
  ];
  for (const mutate of invalid) {
    const data = snapshot(); mutate(data); assert.throws(() => validateMappingSnapshot(data));
  }
});
test('XLSX template roundtrip, apply and invalid workbook rejection are atomic; macros/formulas/external links never evaluated', async () => {
  await mkdir(new URL('../.workbook-tests/', import.meta.url), { recursive: true });
  const directory = await mkdtemp(new URL('../.workbook-tests/city-import-', import.meta.url));
  const root = pathToFileURL(directory + '\\'), target = new URL('city-airport-import.json', root);
  try {
    const path = fileURLToPath(new URL('../data/templates/city-airport-mapping.xlsx', import.meta.url));
    const read = readMappingWorkbook(path);
    assert.deepEqual(read, snapshot());
    await writeFile(target, 'previous-valid-file\n');
    await importMappingWorkbook(path, { destination: target });
    assert.equal(await readFile(target, 'utf8'), 'previous-valid-file\n', 'dry run never writes');
    await importMappingWorkbook(path, { destination: target, apply: true });
    const original = await readFile(target, 'utf8');
    assert.deepEqual(JSON.parse(original), snapshot());
    const fixtures = spawnSync('python', ['-c', `
import sys
from pathlib import Path
from openpyxl import load_workbook
from zipfile import ZipFile
source, directory = sys.argv[1:]
for kind in ["duplicate", "formula", "timezone", "date", "carrier", "macro", "external"]:
    book = load_workbook(source)
    sheet = book["CityAirportMapping"]
    if kind == "duplicate": sheet.append([cell.value for cell in sheet[2]])
    if kind == "formula": sheet["C2"] = "=1+1"
    if kind == "timezone": sheet["G2"] = "Fake/Timezone"
    if kind == "date": sheet["I2"] = "2026-02-30"
    if kind == "carrier": book["RouteReferences"].append(["TPE","KIX","DEMO","AE","2026-11-01","2026-12-01","demo","2026-10-19"])
    path = Path(directory) / (kind + ".xlsx")
    book.save(path)
    if kind == "macro":
        with ZipFile(path, "a") as archive: archive.writestr("xl/vbaProject.bin", b"not executable")
    if kind == "external":
        with ZipFile(path, "a") as archive: archive.writestr("xl/_rels/external.rels", '<Relationships><Relationship TargetMode="External" Target="https://invalid.example"/></Relationships>')
`, path, directory], { encoding: 'utf8', timeout: 30000 });
    assert.equal(fixtures.status, 0, fixtures.stderr);
    for (const kind of ['duplicate', 'formula', 'timezone', 'date', 'carrier', 'macro', 'external']) {
      await assert.rejects(importMappingWorkbook(fileURLToPath(new URL(`${kind}.xlsx`, root)), { apply: true, destination: target }));
      assert.equal(await readFile(target, 'utf8'), original, `${kind}: destination unchanged`);
    }
  } finally { await rm(directory, { recursive: true }); }
});
test('agent tool addition preserves file_search, instructions and model; unknown edits fail before writes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../data/generated/foundry-tools.json', import.meta.url)));
  const base = { kind: 'prompt', model: 'gpt-5.4', instructions: 'Keep original 50-word and confirmation rules.',
    tools: [{ type: 'file_search', vector_store_ids: ['existing-store'] }], text: { format: { type: 'json_object' } } };
  const next = withCityTool(base, manifest.roles.intent.find(tool => tool.name === 'resolve_city_airports'));
  assert.deepEqual(next.tools[0], base.tools[0]); assert.deepEqual(next.text, base.text);
  assert.ok(next.instructions.startsWith(base.instructions)); assert.equal(next.model, base.model);
  assert.deepEqual(withCityTool(next, next.tools[1]), next);
  let writes = 0;
  const state = { agents: Object.fromEntries(['intent', 'planner', 'flight', 'price'].map(role =>
    [role, { name: role, version: '1', definition: structuredClone(base) }])) };
  await assert.rejects(updateCityTools(state, manifest, async (method, path) => {
    if (method === 'POST') writes++;
    return path.endsWith('/1') ? { definition: { ...base, instructions: 'unknown' } } : { version: '1' };
  }, () => {}), /Unknown/);
  assert.equal(writes, 0);
});
