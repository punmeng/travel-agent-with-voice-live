import { WebSocket } from 'ws';
import { AzureCliCredential } from '@azure/identity';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { voiceConfig, voiceSessionUpdate } from '../lib/voice.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: paid Voice Live synthetic audio and GPT-5.4 test.');
const config = voiceConfig(process.env);
assert.ok(config);
const credential = new AzureCliCredential();
const token = await credential.getToken('https://ai.azure.com/.default');
const url = new URL('/voice-live/realtime', config.endpoint);
url.protocol = 'wss:'; url.searchParams.set('api-version', config.version); url.searchParams.set('model', config.model);
const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${token.token}` }, handshakeTimeout: 15000 });
const synthesis = [];
let updated = false;
const audio = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { upstream.close(); reject(new Error('Voice Live synthetic audio timeout')); }, 60000);
  const finish = (error, bytes) => { clearTimeout(timeout); upstream.close(); error ? reject(error) : resolve(bytes); };
  upstream.on('open', () => upstream.send(JSON.stringify(voiceSessionUpdate(config))));
  upstream.on('unexpected-response', (_req, response) => { response.resume(); finish(new Error(`Voice Live HTTP ${response.statusCode}`)); });
  upstream.on('error', error => finish(new Error(`Voice Live connection: ${error.code ?? 'unknown'}`)));
  upstream.on('message', raw => {
    const e = JSON.parse(raw);
    if (e.type === 'error') return finish(new Error(`Voice Live ${JSON.stringify(e.error)}`));
    if (e.type === 'session.updated' && !updated) {
      updated = true;
      upstream.send(JSON.stringify({ type: 'response.create', response: {
        pre_generated_assistant_message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: '我想去日本玩幾天。' }] }
      } }));
    }
    if (e.type === 'response.audio.delta') synthesis.push(Buffer.from(e.delta, 'base64'));
    if (e.type === 'response.done') {
      if (e.response?.status !== 'completed') return finish(new Error(`Synthesis status ${e.response?.status}`));
      finish(null, Buffer.concat(synthesis));
    }
  });
});
assert.ok(audio.length > 2000, 'actual synthesized PCM bytes');
console.log(`Voice Live session configured and exact-text synthesis received (${audio.length} PCM bytes).`);
const server = createApp(process.env); server.listen(0, '127.0.0.1'); await once(server, 'listening');
let client;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${origin}/api/bootstrap`), cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${origin}/api/voice/session`, { method: 'POST', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const ticket = await response.json();
  client = new WebSocket(origin.replace('http:', 'ws:') + ticket.path, [ticket.protocol, ticket.nonce], { headers: { origin, cookie } });
  const events = []; let outputBytes = 0, result;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Voice shared-turn smoke timeout')), 120000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    client.on('error', fail);
    client.on('message', async raw => {
      const e = JSON.parse(raw); events.push(e.type);
      if (e.type === 'error') return fail(new Error(JSON.stringify(e)));
      if (e.type === 'ready') {
        // Azure-generated synthetic Mandarin, not a human microphone recording.
        const input = Buffer.concat([Buffer.alloc(12000), audio, Buffer.alloc(96000)]);
        for (let offset = 0; offset < input.length; offset += 4800) {
          if (client.readyState !== WebSocket.OPEN) break;
          client.send(input.subarray(offset, offset + 4800));
          await new Promise(r => setTimeout(r, 100));
        }
      }
      if (e.type === 'transcript') console.log(`Synthetic audio transcription: ${e.text}`);
      if (e.type === 'result') {
        result = e.result;
        client.send(JSON.stringify({ type: 'displayed', turnId: e.turnId }));
      }
      if (e.type === 'audio') outputBytes += Buffer.byteLength(e.audio, 'base64');
      if (e.type === 'audioDone' && result && outputBytes > 2000) { clearTimeout(timeout); resolve(); }
    });
  });
  assert.ok(events.includes('transcript'));
  assert.equal(result.state.discovery.country, '日本');
  assert.equal(result.state.toolUnits, 0);
  assert.ok(!result.text.includes('UNKNOWN_CITY'));
  const report = { checkedAt: new Date().toISOString(), syntheticAudio: true, humanMicrophoneTested: false,
    config: { endpoint: config.endpoint, model: config.model, version: config.version, voice: config.voice },
    inputSynthesizedBytes: audio.length, outputAudioBytes: outputBytes, events, text: result.text, country: result.state.discovery.country, toolUnits: result.state.toolUnits };
  await writeFile(new URL('../.foundry/voice-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  server.closeAllConnections(); server.close();
}
