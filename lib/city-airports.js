import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { airports } from './dataset.js';

const maintained = JSON.parse(readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8'));
export const normalizeAlias = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const countryCodeFor = value => Object.entries(maintained.country_aliases).find(([code, names]) =>
  [code, ...names].some(name => normalizeAlias(name) === normalizeAlias(value)))?.[0] ?? null;
const text = z.string().trim().min(1).max(250).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '控制字元不允許');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}, '無效日期');
const countryCode = z.string().regex(/^[A-Z]{2}$/);
export const mappingRowSchema = z.object({
  city_id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), city_name: text, alias: text, country_code: countryCode,
  airport_iata: z.string().regex(/^[A-Z]{3}$/), airport_name: text,
  timezone: text.refine(value => {
    try { return value.includes('/') && Boolean(new Intl.DateTimeFormat('en', { timeZone: value })); } catch { return false; }
  }, '無效 IANA 時區'), source: z.string().trim().min(1).max(1000), updated_at: isoDate
}).strict();
export const routeReferenceSchema = z.object({
  origin_iata: z.string().regex(/^[A-Z]{3}$/), destination_iata: z.string().regex(/^[A-Z]{3}$/),
  marketing_carrier: z.string().regex(/^[A-Z0-9]{2,5}$/),
  operating_carrier: z.string().regex(/^[A-Z0-9]{2,5}$/),
  valid_from: isoDate, valid_to: isoDate, source: z.string().trim().min(1).max(1000), updated_at: isoDate
}).strict().refine(row => row.origin_iata !== row.destination_iata && row.valid_from <= row.valid_to,
  '航線起訖或有效日期範圍無效');
export const resolveCitySchema = z.object({ query: text, countryCode: countryCode.nullable() }).strict();
const airportByCode = new Map(airports.map(airport => [airport.code, airport]));
const countryByAirport = new Map(maintained.cities.flatMap(([, , country, , codes]) => codes.map(code => [code, country])));
export const defaultMappingRows = maintained.cities.flatMap(([id, name, country, aliases, codes]) =>
  aliases.flatMap(alias => codes.map(code => {
    const airport = airportByCode.get(code);
    if (!airport) throw new Error(`Unknown maintained airport ${code}`);
    return { city_id: id, city_name: name, alias, country_code: country, airport_iata: code,
      airport_name: airport.name, timezone: airport.timezone, source: maintained.source, updated_at: maintained.updated_at };
  })));

export function validateMappingSnapshot(raw) {
  const snapshot = z.object({ schemaVersion: z.literal(1), rows: z.array(mappingRowSchema).min(1).max(10000),
    routeReferences: z.array(routeReferenceSchema).max(10000) }).strict().parse(raw);
  const rowKeys = new Set(), cityMeta = new Map(), aliasCity = new Map(), memberships = new Map();
  for (const row of snapshot.rows) {
    const airport = airportByCode.get(row.airport_iata);
    if (!airport || airport.name !== row.airport_name || airport.timezone !== row.timezone ||
        countryByAirport.get(row.airport_iata) !== row.country_code) {
      throw new Error(`城市對照 ${row.city_id}/${row.airport_iata} 與既有機場名稱、國家或時區不符；請先另行維護機場 inventory`);
    }
    const reserved = airportByCode.get(row.alias.toUpperCase());
    if (reserved && reserved.code !== row.airport_iata) throw new Error(`IATA 別名不得指向另一機場：${row.alias}`);
    const key = `${row.city_id}|${normalizeAlias(row.alias)}|${row.airport_iata}`;
    if (rowKeys.has(key)) throw new Error(`重複城市／別名／IATA 列：${key}`);
    rowKeys.add(key);
    const meta = `${row.city_name}|${row.country_code}`;
    if (cityMeta.has(row.city_id) && cityMeta.get(row.city_id) !== meta) throw new Error(`城市 metadata 衝突：${row.city_id}`);
    cityMeta.set(row.city_id, meta);
    const aliasKey = `${row.country_code}|${normalizeAlias(row.alias)}`;
    if (aliasCity.has(aliasKey) && aliasCity.get(aliasKey) !== row.city_id) throw new Error(`同國家別名對應多城市：${aliasKey}`);
    aliasCity.set(aliasKey, row.city_id);
    const aliases = memberships.get(row.city_id) ?? new Map();
    const members = aliases.get(normalizeAlias(row.alias)) ?? new Set();
    members.add(row.airport_iata); aliases.set(normalizeAlias(row.alias), members); memberships.set(row.city_id, aliases);
  }
  for (const [id, aliases] of memberships) {
    const sets = [...aliases.values()].map(codes => [...codes].sort().join(','));
    if (new Set(sets).size > 1) throw new Error(`同城市各別名的機場集合必須一致：${id}`);
    if ([...aliases.values()][0].size > 2) throw new Error(`城市 ${id} 超過目前可接受的兩座機場上限`);
  }
  const routeKeys = new Set(), routeIntervals = [];
  for (const route of snapshot.routeReferences) {
    if (!airportByCode.has(route.origin_iata) || !airportByCode.has(route.destination_iata)) throw new Error('RouteReferences 包含未知機場');
    const key = `${route.origin_iata}|${route.destination_iata}|${route.valid_from}|${route.valid_to}`;
    if (routeKeys.has(key)) throw new Error(`重複 RouteReferences 列：${key}`);
    if (routeIntervals.some(previous => previous.origin_iata === route.origin_iata &&
      previous.destination_iata === route.destination_iata && previous.valid_from <= route.valid_to &&
      previous.valid_to >= route.valid_from)) throw new Error(`RouteReferences 同航線有效期間重疊：${key}`);
    routeKeys.add(key);
    routeIntervals.push(route);
  }
  return snapshot;
}

export function createCityResolver(raw) {
  const snapshot = validateMappingSnapshot(raw);
  const cities = new Map(), aliasIndex = new Map();
  for (const row of snapshot.rows) {
    let city = cities.get(row.city_id);
    if (!city) {
      city = { cityId: row.city_id, cityName: row.city_name, countryCode: row.country_code, airports: [], aliases: [] };
      cities.set(row.city_id, city);
    }
    if (!city.airports.some(a => a.iata === row.airport_iata)) city.airports.push({
      iata: row.airport_iata, name: row.airport_name, timezone: row.timezone, source: row.source, updatedAt: row.updated_at
    });
    if (!city.aliases.includes(normalizeAlias(row.alias))) city.aliases.push(normalizeAlias(row.alias));
    const matches = aliasIndex.get(normalizeAlias(row.alias)) ?? new Set();
    matches.add(row.city_id); aliasIndex.set(normalizeAlias(row.alias), matches);
  }
  const airportIndex = new Map();
  for (const airport of airports) {
    if (![...cities.values()].some(city => city.airports.some(a => a.iata === airport.code))) continue;
    for (const alias of [airport.code, airport.name, airport.city, ...(maintained.airport_aliases[airport.code] ?? [])]) {
      // A city alias always denotes the whole geographic group, never a silent single-airport choice.
      if (aliasIndex.has(normalizeAlias(alias))) continue;
      const codes = airportIndex.get(normalizeAlias(alias)) ?? new Set();
      codes.add(airport.code); airportIndex.set(normalizeAlias(alias), codes);
    }
  }
  function resolve(rawArgs) {
    const args = resolveCitySchema.parse(rawArgs), query = normalizeAlias(args.query);
    const ids = aliasIndex.get(query), codes = airportIndex.get(query);
    const groups = [...cities.values()].filter(city => (!args.countryCode || city.countryCode === args.countryCode) &&
      (ids?.has(city.cityId) || city.airports.some(a => codes?.has(a.iata))))
      .map(({ aliases: _aliases, ...city }) => ({ ...city,
        airports: city.airports.filter(a => ids?.has(city.cityId) || codes?.has(a.iata)) }));
    return { status: groups.length === 0 ? 'not_found' : groups.length > 1 ? 'ambiguous' : 'matched',
      matchKind: ids ? 'city' : codes ? 'airport' : null, query: args.query, countryCode: args.countryCode, cities: groups,
      scope: 'geographic-membership-only', routeEligibility: 'not-determined',
      provenance: { source: 'maintained-local-city-airport-mapping', officialNetworkVerified: false } };
  }
  const terms = [...new Set([...aliasIndex.keys(), ...airportIndex.keys()])].sort((a, b) => b.length - a.length);
  function mentions(value, wholePlace = false) {
    const normalized = normalizeAlias(value), occupied = new Set(), found = [];
    for (const term of terms) {
      let index = normalized.indexOf(term);
      while (index !== -1) {
        const end = index + term.length;
        const boundary = !/^[a-z0-9]/.test(term) || !/[a-z0-9]/.test(normalized[index - 1] ?? '');
        const after = !/[a-z0-9]$/.test(term) || !/[a-z0-9]/.test(normalized[end] ?? '');
        if (boundary && after && ![...Array(term.length)].some((_, i) => occupied.has(index + i))) {
          for (let i = index; i < end; i++) occupied.add(i);
          found.push({ index, term, ...resolve({ query: term, countryCode: null }),
            excluded: /(?:不要|不是|不想|不搭|排除|不選|不從|除了|\b(?:not|exclude|except|avoid)(?:\s+from)?|\bdon't use)\s*$/.test(normalized.slice(0, index)) });
        }
        index = normalized.indexOf(term, index + 1);
      }
    }
    if (wholePlace) {
      const remainder = [...normalized].filter((_, index) => !occupied.has(index)).join('')
        .replace(/都可以|都行|皆可|均可|沒差|無所謂|不限機場|任何一個|你幫我選|都可|\beither\b|any airport|both airports|\b(?:or|and|not|exclude|except|avoid)\b|don't use|不要|不是|不想|不搭|排除|不選|不從|除了|我說|或是|或者|還是|好了|就好|可以|都|或|和|跟|與|以及|是|我|了|[，,。.!！?？、\s]/gi, '');
      if (remainder) return [];
    }
    return found.sort((a, b) => a.index - b.index);
  }
  return { resolve, mentions, cities: [...cities.values()], snapshot,
    geographicCity: codes => [...cities.values()].find(city => codes.length &&
      codes.every(code => city.airports.some(airport => airport.iata === code))) };
}
const importedPath = new URL('../data/city-airport-import.json', import.meta.url);
export const cityResolver = createCityResolver(existsSync(importedPath)
  ? JSON.parse(readFileSync(importedPath, 'utf8')) : { schemaVersion: 1, rows: defaultMappingRows, routeReferences: [] });
export const resolveCityAirports = args => cityResolver.resolve(args);
export const findPlaceMentions = text => cityResolver.mentions(text);
export const airportLabel = code => ({ TPE: '桃園機場', TSA: '松山機場', NRT: '成田機場', HND: '羽田機場', KIX: '關西機場' }[code] ??
  airportByCode.get(code)?.name);
