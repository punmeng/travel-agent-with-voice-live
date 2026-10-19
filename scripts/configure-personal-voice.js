import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AzureCliCredential } from '@azure/identity';
import { voiceConfig } from '../lib/voice.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: resolve an existing consented voice and update local .env only.');
const config = voiceConfig(process.env);
assert.equal(config?.outputVoice.type, 'azure-personal', 'Explicit personal voice configuration required');
const path = new URL('../.env', import.meta.url);
const original = await readFile(path, 'utf8');
const token = await new AzureCliCredential({ processTimeoutInMs: 10000 }).getToken('https://cognitiveservices.azure.com/.default');
const url = new URL('/customvoice/personalvoices?api-version=2026-01-01&maxpagesize=100', config.endpoint);
const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error(`Personal Voice metadata HTTP ${response.status}; configuration unchanged`);
const body = await response.json();
assert.ok(Array.isArray(body.value) && !body.nextLink, 'Metadata must be complete; no partial match selection');
const matches = body.value.filter(voice => voice.id === config.outputVoice.name || voice.displayName === config.outputVoice.name);
assert.equal(matches.length, 1, 'Exactly one matching voice must exist on the configured Voice Live resource');
const [voice] = matches;
assert.equal(voice.status, 'Succeeded', 'The selected existing voice must be ready');
assert.match(voice.id, /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}[a-zA-Z0-9]$/, 'Valid service voice resource ID required');
const key = /^VOICE_LIVE_PERSONAL_VOICE_NAME=[^\r\n]*$/gm;
assert.equal([...original.matchAll(key)].length, 1, 'Expected one local voice configuration entry');
assert.equal(await readFile(path, 'utf8'), original, 'Local configuration changed during lookup; refusing overwrite');
await writeFile(path, original.replace(key, () => `VOICE_LIVE_PERSONAL_VOICE_NAME=${voice.id}`), 'utf8');
console.log(JSON.stringify({ resourceMatched: true, ready: true, voiceResourceIdConfigured: true,
  displayNameWasNotResourceId: voice.id !== config.outputVoice.name,
  resourceIdEqualsSpeakerProfileId: voice.id === voice.speakerProfileId,
  cloudChanges: false, audioHandled: false }));
