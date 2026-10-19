import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultMappingRows, validateMappingSnapshot } from '../lib/city-airports.js';
import { readMappingWorkbook } from './import-city-airports.js';
import assert from 'node:assert/strict';

const snapshot = validateMappingSnapshot({ schemaVersion: 1, rows: defaultMappingRows, routeReferences: [] });
const path = new URL('../data/templates/city-airport-mapping.xlsx', import.meta.url);
mkdirSync(new URL('../data/templates/', import.meta.url), { recursive: true });
const created = spawnSync('python', [fileURLToPath(new URL('./mapping-workbook.py', import.meta.url)), 'create', fileURLToPath(path)], {
  input: JSON.stringify(snapshot), encoding: 'utf8', timeout: 30000, windowsHide: true
});
if (created.error) throw created.error;
if (created.status !== 0) throw new Error(created.stderr);
assert.deepEqual(readMappingWorkbook(fileURLToPath(path)), snapshot);
console.log(`Created and roundtrip-validated data\\templates\\city-airport-mapping.xlsx (${snapshot.rows.length} rows; no route assertions).`);
