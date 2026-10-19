import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { AzureCliCredential } from '@azure/identity';
import { createApp } from '../server.js';
import { voiceConfig, voiceSessionUpdate } from '../lib/voice.js';
import { countWords } from '../lib/replies.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: bounded paid synthetic Voice Live interrupt and two GPT turns.');
const config = voiceConfig(process.env);
const token = await new AzureCliCredential().getToken('https://ai.azure.com/.default');
const url = new URL('/voice-live/realtime', config.endpoint);
url.protocol = 'wss:'; url.searchParams.set('api-version', config.version); url.searchParams.set('model', config.model);
const phrases = ['好啊，你幫我規劃一下那個臺北到大阪的飛機，來回十月中左右。', '不是十月，是十一月中。'];
const synthesized = [];
const source = new WebSocket(url, { headers: { Authorization: `Bearer ${token.token}` }, handshakeTimeout: 15000 });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic source timeout')), 60000);
    let chunks = [], index = 0;
    const synthesize = () => source.send(JSON.stringify({ type: 'response.create', response: {
      pre_generated_assistant_message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: phrases[index] }] }
    } }));
    source.on('open', () => source.send(JSON.stringify(voiceSessionUpdate(config))));
    source.on('error', reject);
    source.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'error') { clearTimeout(timeout); reject(new Error(`Synthesis error ${event.error?.code}`)); }
      if (event.type === 'session.updated') synthesize();
      if (event.type === 'response.audio.delta') chunks.push(Buffer.from(event.delta, 'base64'));
      if (event.type === 'response.done') {
        if (event.response?.status !== 'completed') { clearTimeout(timeout); reject(new Error('Source incomplete')); return; }
        synthesized.push(Buffer.concat(chunks)); chunks = [];
        if (++index < phrases.length) synthesize();
        else { clearTimeout(timeout); resolve(); }
      }
    });
  });
} finally { source.close(); }

let firstFetch = true, deferredAborted = false, calls = 0;
const server = createApp(process.env, { voice: { fetch: async (endpoint, options) => {
  calls++;
  if (firstFetch) {
    firstFetch = false;
    try { await sleep(25000, null, { signal: options.signal }); }
    catch (error) { deferredAborted = options.signal.aborted; throw error; }
  }
  return fetch(endpoint, options);
} } });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let client;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${origin}/api/bootstrap`), cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const headers = { origin, cookie, 'Content-Type': 'application/json' };
  const ticket = await (await fetch(`${origin}/api/voice/session`, { method: 'POST', headers, body: '{}' })).json();
  client = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
  const events = [], transcripts = [], results = [];
  let outputBytes = 0;
  const stream = async audio => {
    const pcm = Buffer.concat([Buffer.alloc(12000), audio, Buffer.alloc(72000)]);
    for (let offset = 0; offset < pcm.length && client.readyState === WebSocket.OPEN; offset += 4800) {
      client.send(pcm.subarray(offset, offset + 4800)); await sleep(100);
    }
  };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Interrupt smoke timeout')), 120000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    client.on('error', fail);
    client.on('message', raw => {
      const event = JSON.parse(raw); events.push(event.type);
      if (event.type === 'error') return fail(new Error(`Bridge ${event.code}`));
      if (event.type === 'ready') void stream(synthesized[0]).catch(fail);
      if (event.type === 'transcript') {
        transcripts.push(event.text);
        if (transcripts.length === 1) void sleep(1800).then(() => stream(synthesized[1])).catch(fail);
      }
      if (event.type === 'result') { results.push(event.result); client.send(JSON.stringify({ type: 'displayed', turnId: event.turnId })); }
      if (event.type === 'audio') outputBytes += Buffer.byteLength(event.audio, 'base64');
      if (event.type === 'audioDone' && results.length && outputBytes) { clearTimeout(timeout); resolve(); }
    });
  });
  assert.ok(deferredAborted, 'original read-only request cancelled while waiting');
  assert.equal(results.length, 1, 'only corrected response displayed and spoken');
  const result = results[0];
  assert.match(result.state.discovery.datePreference, /11月中|十一月中/);
  assert.equal(result.state.discovery.originCity, '台北');
  assert.equal(result.state.discovery.destinationCity, '大阪');
  assert.equal(result.state.toolUnits, 0);
  assert.ok(countWords(result.text) <= 50);
  client.send(JSON.stringify({ type: 'stop' })); await once(client, 'close');
  const response = await fetch(`${origin}/api/chat`, { method: 'POST', headers,
    body: JSON.stringify({ message: '11月15號出發。', requestId: crypto.randomUUID() }) });
  const dated = await response.json();
  assert.equal(response.status, 200);
  assert.equal(dated.state.draft.date, '2026-11-15');
  assert.doesNotMatch(dated.text, /需要確定一天|哪天出發|哪一天出發/);
  assert.ok(countWords(dated.text) <= 50);
  const report = { checkedAt: new Date().toISOString(), syntheticAudio: true, humanMicrophoneTested: false,
    originalFetchArtificialDelayMs: 25000, deferredAborted, voiceFetchAttempts: calls,
    transcripts, events, onlyLatestResult: result.text, correctedMonth: result.state.discovery.datePreference,
    originCity: result.state.discovery.originCity, destinationCity: result.state.discovery.destinationCity,
    outputAudioBytes: outputBytes, exactDate: dated.state.draft.date, exactDateReply: dated.text };
  await writeFile(new URL('../.foundry/voice-interrupt-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { client?.close(); server.closeAllConnections(); server.close(); }
