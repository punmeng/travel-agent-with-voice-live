import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { AzureCliCredential } from '@azure/identity';
import { writeFile } from 'node:fs/promises';
import { voiceConfig, voiceSessionUpdate } from '../lib/voice.js';
import { speechText } from '../lib/speech.js';

if (!process.argv.includes('--apply')) throw new Error('Requires --apply: one paid fixed-text Voice Live synthesis.');
const config = voiceConfig(process.env);
const pronunciation = process.argv.includes('--pronunciation');
const savePreview = process.argv.includes('--save-preview');
if (savePreview && !pronunciation) throw new Error('--save-preview only supports the fixed non-sensitive pronunciation test.');
const spoken = speechText(pronunciation
  ? '發音測試，不是真實航班。DEMO101，DEMO0101，TPE。2026-11-25T08:30，Asia/Taipei。總額 TWD 12,345；不收款、不訂位。'
  : '您好，我是您的旅遊助理。');
assert.ok(config, 'Voice Live must be explicitly configured');
const token = await new AzureCliCredential({ processTimeoutInMs: 10000 }).getToken('https://ai.azure.com/.default');
const url = new URL('/voice-live/realtime', config.endpoint);
url.protocol = 'wss:';
url.searchParams.set('api-version', config.version);
url.searchParams.set('model', config.model);
const socket = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token.token}` }, handshakeTimeout: 15000
});
const safeDetail = value => String(value ?? '').replaceAll(config.outputVoice.name, '[voice]')
  .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]').replace(/https?:\/\/\S+/g, '[url]').slice(0, 600);
let confirmed = false, bytes = 0;
const audio = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Voice output test timeout')), 60000);
    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    }
    socket.on('open', () => socket.send(JSON.stringify(voiceSessionUpdate(config))));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finish(new Error(`Voice Live HTTP ${response.statusCode}`));
    });
    socket.on('error', () => finish(new Error('Voice Live connection failed')));
    socket.on('close', () => finish(new Error('Voice Live closed before synthesis completed')));
    socket.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'error') {
          const code = String(event.error?.code ?? 'unknown').replace(/[^\w.-]/g, '').slice(0, 80);
          return finish(new Error(`Voice Live service error: ${code}; no fallback attempted`));
        }
        if (event.type === 'session.updated' && !confirmed) {
          assert.deepEqual(Object.fromEntries(Object.keys(config.outputVoice).map(key => [key, event.session?.voice?.[key]])),
            config.outputVoice, 'Service must acknowledge the requested voice, not a substitute');
          confirmed = true;
          socket.send(JSON.stringify({ type: 'response.create', response: {
            pre_generated_assistant_message: { type: 'message', role: 'assistant',
              content: [{ type: 'text', text: spoken }] }
          } }));
        }
        if (event.type === 'response.audio.delta') {
          const chunk = Buffer.from(event.delta, 'base64');
          bytes += chunk.length;
          if (bytes > 5_000_000) return finish(new Error('Fixed speech preview exceeded audio safety bound'));
          if (savePreview) audio.push(chunk);
        }
        if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') return finish(new Error(
            `Synthesis ${safeDetail(event.response?.status)}: ${safeDetail(JSON.stringify(event.response?.status_details))}; no fallback attempted`));
          assert.ok(confirmed && bytes > 2000, 'Expected real PCM audio after voice acknowledgment');
          finish();
        }
      } catch (error) {
        // Assertions may contain the private voice name; emit only their fixed descriptions.
        finish(new Error(error.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : 'Invalid Voice Live event'));
      }
    });
  });
  if (savePreview) {
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(bytes, 40);
    await writeFile(new URL('../.foundry/pronunciation-preview.wav', import.meta.url), Buffer.concat([header, ...audio]));
  }
  console.log(JSON.stringify({ voice: config.voice, type: config.outputVoice.type,
    model: config.outputVoice.model, sessionAcknowledged: confirmed, pcmBytes: bytes,
    sampleRate: 24000, fallback: false, pronunciationNormalization: pronunciation,
    ...(savePreview ? { localSyntheticPreview: '.foundry\\pronunciation-preview.wav' } : {}),
    humanSimilarityTested: false }));
} finally {
  socket.close();
}
