// Isolated offline worker: never reads .env or acquires an Azure credential.
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../../server.js';

if (process.env.HOSTED_ADAPTER_OFFLINE !== 'true') throw new Error('Offline prototype only');
class OfflineVoice extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  constructor() { super(); setImmediate(() => this.emit('open')); }
  send(raw) {
    const event = JSON.parse(raw);
    if (event.type === 'session.update') {
      setImmediate(() => this.event({ type: 'session.updated' }));
    }
    if (event.type === 'input_audio_buffer.append') {
      setImmediate(() => this.event({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'offline-fixture', transcript: '您好'
      }));
    }
  }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED; this.emit('close');
  }
}
const server = createApp({
  APP_MODE: 'mock', VOICE_LIVE_ENABLED: 'true',
  VOICE_LIVE_ENDPOINT: 'https://offline.services.ai.azure.com/'
}, {
  voice: {
    credential: { getToken: async () => ({ token: 'offline-not-an-azure-token' }) },
    connect: () => new OfflineVoice()
  }
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
