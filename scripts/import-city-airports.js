import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateMappingSnapshot } from '../lib/city-airports.js';

export function readMappingWorkbook(path) {
  const child = spawnSync('python', [fileURLToPath(new URL('./mapping-workbook.py', import.meta.url)), 'read', path], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 20_000_000, windowsHide: true
  });
  if (child.error) throw new Error(`Workbook reader unavailable: ${child.error.message}`, { cause: child.error });
  if (child.status !== 0) throw new Error(`Excel 匯入未套用：${child.stderr.trim()}`);
  return validateMappingSnapshot(JSON.parse(child.stdout));
}
export async function importMappingWorkbook(path, { apply = false, destination = new URL('../data/city-airport-import.json', import.meta.url) } = {}) {
  const snapshot = readMappingWorkbook(path);
  if (apply) {
    const previous = await readFile(destination, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const temporary = new URL(`./.city-airport-${randomUUID()}.tmp`, destination);
    try {
      await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
      const current = await readFile(destination, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (current !== previous) throw new Error('地理對照已由其他程序變更，未覆寫；請重新驗證');
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { valid: true, applied: apply, rows: snapshot.rows.length,
    cities: new Set(snapshot.rows.map(row => row.city_id)).size,
    routeReferences: snapshot.routeReferences.length, routeEligibilityChanged: false, restartRequired: apply };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), paths = args.filter(arg => arg !== '--apply');
  if (paths.length !== 1 || paths[0].startsWith('--')) throw new Error('Usage: node scripts\\import-city-airports.js <file.xlsx> [--apply]');
  console.log(JSON.stringify(await importMappingWorkbook(paths[0], { apply: args.includes('--apply') })));
}
