import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { registerHooks } from 'node:module';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
test.afterAll(async () => {
  if (process.env.MANAGED_FLOW_OFFLINE_EVIDENCE) {
    await writeFile(process.env.MANAGED_FLOW_OFFLINE_EVIDENCE, `${JSON.stringify({
      schemaVersion: 1, mode: 'offline real browser and SDK Node transport; local wire emulator; no cloud',
      checkedAt: new Date().toISOString(), results
    }, null, 2)}\n`);
  }
});

async function openHarness(page, { sendDelayMs = 0, businessBackend = false } = {}) {
  const [{ VoiceAgentRealtimeClient }, { NodeWebSocketTransport }, { createApp }, { publicState },
    { memberDemoVoiceLocaleSettings, travelBackendTool }] = await Promise.all([
    import('@azure/ai-projects'),
    import('../../node_modules/@azure/ai-projects/dist/esm/webSocketTransport.js'),
    import('../../server.js'), import('../../lib/core.js'), import('../../lib/voice-agent.js')
  ]);
  const wire = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wire, 'listening');
  const record = { sdkStarted: 0, sdkCompleted: 0, wireAppends: 0, backendCalls: 0, backendExactAsr: false };
  const sdkClients = [];
  wire.on('connection', socket => {
    let response = 0;
    let eventId = 0;
    const emit = event => socket.send(JSON.stringify({ event_id: `offline-event-${++eventId}`, ...event }));
    socket.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.update') {
        assert.deepEqual(event.session, { type: 'realtime' });
        const settings = memberDemoVoiceLocaleSettings('zh-TW');
        emit({ type: 'session.updated', session: { type: 'realtime', instructions: settings.instructions,
          tools: [travelBackendTool], tool_choice: { type: 'function', name: 'travel_backend' },
          parallel_tool_calls: false, audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: settings.transcription,
              turn_detection: { type: 'azure_semantic_vad_multilingual', create_response: false, interrupt_response: false },
              echo_cancellation: { type: 'server_echo_cancellation', reference_source: 'server', channels: 1 } },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: settings.outputVoice }
          } } });
      } else if (event.type === 'input_audio_buffer.append') {
        assert.equal(Buffer.from(event.audio, 'base64').length, 4096);
        record.wireAppends++;
        if (record.wireAppends === 30) {
          emit({ type: 'input_audio_buffer.speech_started', item_id: 'offline-input' });
          emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'offline-input' });
          emit({ type: 'input_audio_buffer.committed', item_id: 'offline-input' });
          emit({ type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'offline-input', content_index: 0, transcript: '我想去東京' });
        }
      } else if (event.type === 'response.create') {
        const id = `offline-response-${++response}`;
        emit({ type: 'response.created', response: { id } });
        if (event.response?.tool_choice?.name === 'travel_backend') {
          emit({ type: 'response.done', response: { id, status: 'completed', output: [
            { type: 'function_call', status: 'completed', name: 'travel_backend', call_id: 'offline-call',
              arguments: JSON.stringify({ message: 'A rewritten trigger, not backend input' }) }
          ] } });
        } else {
          emit({ type: 'response.output_audio.delta', response_id: id, item_id: 'offline-output',
            output_index: 0, content_index: 0, delta: Buffer.alloc(4800).toString('base64') });
          emit({ type: 'response.done', response: { id, status: 'completed', output: [
            { type: 'message', role: 'assistant', status: 'completed', content: [] }
          ] } });
        }
      }
    });
  });
  const app = createApp({ APP_MODE: 'mock',
    FOUNDRY_PROJECT_ENDPOINT: 'https://offline.services.ai.azure.com/api/projects/travel',
    FOUNDRY_VOICE_AGENT_NAME: 'meihao-travel-intent-voice', FOUNDRY_VOICE_AGENT_VERSION: '8'
  }, { voice: {
    credential: { async getToken() { throw new Error('Cloud credentials must not be used'); } },
    async voiceAgentConnect() {
      const sdk = new VoiceAgentRealtimeClient('https://offline.example.test',
        { async getToken() { return { token: 'offline-only', expiresOnTimestamp: Date.now() + 60000 }; } },
        { webSocketFactory: { create() {
          const transport = new NodeWebSocketTransport();
          const originalConnect = transport.connect.bind(transport), originalSend = transport.send.bind(transport);
          transport.connect = options => originalConnect({ ...options,
            url: `ws://127.0.0.1:${wire.address().port}`, headers: {} });
          transport.send = async (data, signal) => {
            const audio = JSON.parse(data).type === 'input_audio_buffer.append';
            if (audio) { record.sdkStarted++; await delay(sendDelayMs); }
            await originalSend(data, signal);
            if (audio) record.sdkCompleted++;
          };
          return transport;
        } } });
      const connection = await sdk.connect('offline-agent').catch(error => {
        console.error('OFFLINE_SDK_CONNECT', error.message, error.cause?.message);
        throw error;
      });
      sdkClients.push(connection);
      return connection;
    },
    async chat(session, request, _env, dependencies) {
      record.backendCalls++;
      record.backendExactAsr = request.message === '我想去東京';
      record.authenticatedMember = Boolean(session.memberId);
      if (businessBackend) {
        const { chat } = await import('../../lib/agents.js');
        const { mockUnderstanding } = await import('../../lib/conversation.js');
        return chat(session, request, {
          APP_MODE: 'foundry', FOUNDRY_AUTH_MODE: 'azure-cli',
          FOUNDRY_PROJECT_ENDPOINT: 'https://offline.services.ai.azure.com/api/projects/travel',
          ...Object.fromEntries(['intent', 'planner', 'flight', 'price'].map(role => [`FOUNDRY_${role.toUpperCase()}_AGENT`, role]))
        }, { ...dependencies, credential: undefined, fetch: async () => Response.json({
          id: 'offline-understanding', status: 'completed', output: [{ type: 'message', content: [{
            type: 'output_text', text: JSON.stringify({
              role: 'intent', reply: '您想哪一天出發？', slots: mockUnderstanding(session, '')
            })
          }] }]
        }) });
      }
      await delay(700);
      return { text: '已收到東京旅程需求。', speech: { text: '已收到東京旅程需求。' },
        state: { ...publicState(session), activeAgent: 'intent' } };
    },
    onVoiceAgentBridge(bridge) { record.bridge = bridge; }
  } });
  const handler = app.listeners('request')[0];
  app.removeListener('request', handler);
  const index = await readFile(path.resolve('staging', 'member-public', 'index.html'), 'utf8');
  const themeHash = createHash('sha256').update(index.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n')).digest('base64');
  app.on('request', async (request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    const names = ['index.html', 'app.js', 'voice.js', 'voice-options.js', 'voice-options.css', 'style.css',
      'ni-airlines-logo.png', 'waiting.js', 'agent-status.js', 'speech-input.js', 'audio-worklet.js', 'i18n.js'];
    if (request.method !== 'GET' || !names.includes(name)) return handler(request, response);
    response.writeHead(200, {
      'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' :
        name.endsWith('.png') ? 'image/png' : 'text/javascript',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'sha256-${themeHash}'; style-src 'self'; connect-src 'self'; img-src 'self'`
    });

    response.end(await readFile(path.resolve('staging', 'member-public', name)));
  });
  app.prependListener('upgrade', req => {
    console.info('OFFLINE_UPGRADE', JSON.stringify({ originMatches: req.headers.origin === `http://${req.headers.host}`,
      cookiePresent: Boolean(req.headers.cookie), protocolsPresent: Boolean(req.headers['sec-websocket-protocol']) }));
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = `http://127.0.0.1:${app.address().port}`;
  page.on('console', message => { if (message.type() === 'error') console.info('OFFLINE_BROWSER_ERROR', message.text()); });
  page.on('websocket', socket => socket.on('socketerror', error => console.info('OFFLINE_WS_ERROR', error)));
  await page.addInitScript(() => {
    const Audio = window.AudioContext, Worklet = window.AudioWorkletNode, Socket = window.WebSocket;
    window.__receipts = []; window.__sentBytes = 0;
    window.AudioContext = class extends Audio { constructor(options) { super(options); window.__context = this; } };
    window.AudioWorkletNode = class extends Worklet { constructor(...args) { super(...args); window.__processor = this; } };
    navigator.mediaDevices.getUserMedia = async () => window.__context.createMediaStreamDestination().stream;
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args); window.__socket = this;
        this.addEventListener('message', event => {
          const data = JSON.parse(event.data);
          if (['inputAudioAck', 'audio', 'result', 'error'].includes(data.type)) {
            window.__receipts.push({ type: data.type, receivedBytes: data.receivedBytes });
          }
        });
      }
      send(data) { if (typeof data !== 'string') window.__sentBytes += data.byteLength; super.send(data); }
    };
  });
  await page.goto(origin);
  const login = await page.request.post(`${origin}/api/member/login`, {
    headers: { Origin: origin }, data: { email: 'ohsung.seoul@example.test', password: 'MeihaoDemo!2026' }
  });
  assert.equal(login.status(), 200);
  await page.reload();
  await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption('foundry-voice-agent');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.evaluate(() => {
    window.__capture = window.__processor.port.onmessage;
    window.__processor.port.onmessage = null;
    window.__pump = setInterval(() => window.__capture({ data: {
      audio: new ArrayBuffer(4096), capturedAt: window.__context.currentTime
    } }), 86);
  });
  return { record, async close() {
    await page.evaluate(() => clearInterval(window.__pump));
    record.bridge?.stop();
    for (const connection of sdkClients) await connection.close();
    await new Promise(resolve => app.close(resolve));
    wire.clients.forEach(socket => socket.terminate());
    await new Promise(resolve => wire.close(resolve));
  } };
}

test('cold business identity resolution cannot block capture after the voice connection is ready', async ({ page }) => {
  test.setTimeout(120000);
  let capturing = false, activeResolutionCalls = 0, providerCalls = 0;
  const provider = `data:text/javascript,${encodeURIComponent(`
    export class AzureCliCredential {
      async getToken() { globalThis.__offlineProviderCalled(); return { token: 'offline-only' }; }
    }
    export const DefaultAzureCredential = AzureCliCredential;
  `)}`;
  globalThis.__offlineProviderCalled = () => { providerCalls++; };
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '@azure/identity' && context.parentURL?.endsWith('/lib/foundry.js')) {
      if (capturing) {
        activeResolutionCalls++;
        const end = performance.now() + 3000;
        while (performance.now() < end) { /* Controlled synchronous filesystem-resolution stall. */ }
      }
      return nextResolve(provider, context);
    }
    return nextResolve(specifier, context);
  } });
  let h;
  try {
    h = await openHarness(page, { businessBackend: true });
    capturing = true;
    await expect.poll(() => page.evaluate(() => window.__receipts.some(event => event.type === 'result')),
      { timeout: 12000 }).toBe(true);
    await page.waitForTimeout(2500);
    expect(await page.locator('#voice-error-details').textContent()).toBe('');
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
    expect(providerCalls).toBeGreaterThan(0);
    expect(activeResolutionCalls).toBe(0);
    expect(h.record.bridge.diagnostics.inputFlow.sdkCompleted).toBeGreaterThan(50);
    results.push({ case: 'cold-business-identity-before-capture', passed: true,
      providerCalls, activeResolutionCalls, flow: h.record.bridge.diagnostics.inputFlow });
  } finally {
    capturing = false;
    await h?.close();
    hook.deregister();
    delete globalThis.__offlineProviderCalled;
  }
});

test('real browser capture, bridge, SDK2.9 Node transport and ACK stay bounded beyond 60 seconds with backend/output', async ({ page }) => {
  test.setTimeout(90000);
  const h = await openHarness(page, { sendDelayMs: 100 });
  try {
    await expect.poll(() => page.evaluate(() => window.__receipts.some(event => event.type === 'audio')),
      { timeout: 8000 }).toBe(true);
    await page.waitForTimeout(58000);
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
    expect(h.record.backendCalls).toBe(1);
    expect(h.record.backendExactAsr).toBe(true);
    expect(h.record.authenticatedMember).toBe(true);
    const receipts = await page.evaluate(() => window.__receipts);
    expect(receipts.some(event => event.type === 'result')).toBe(true);
    expect(receipts.some(event => event.type === 'audio')).toBe(true);
    expect(receipts.some(event => event.type === 'error')).toBe(false);
    const before = h.record.sdkCompleted;
    await page.locator('#voice-mute').click();
    await page.waitForTimeout(500);
    expect(h.record.sdkCompleted - before).toBeLessThanOrEqual(3);
    await page.locator('#voice-mute').click();
    await page.waitForTimeout(500);
    await page.locator('#voice-stop').click();
    const trace = h.record.bridge.diagnostics;
    expect(trace.inputFlow.maxQueuedBytes).toBeLessThanOrEqual(12288);
    expect(h.record.sdkCompleted).toBeGreaterThan(500);
    const lastAck = receipts.filter(event => event.type === 'inputAudioAck').at(-1)?.receivedBytes;
    results.push({ case: 'sustained-62s-backend-output-mute-stop', passed: true,
      elapsedMs: trace.elapsedMs, wireAppends: h.record.wireAppends,
      sdkCompleted: h.record.sdkCompleted, clientLastAckBytes: lastAck,
      backendCalls: h.record.backendCalls, sameItemAsrExact: h.record.backendExactAsr,
      authenticatedMember: h.record.authenticatedMember, outputAudio: true,
      flow: trace.inputFlow });
  } finally { await h.close(); }
});

test('real SDK transport blocked send produces attributed browser timeout without early ACK or queue growth', async ({ page }) => {
  test.setTimeout(20000);
  const h = await openHarness(page, { sendDelayMs: 3000 });
  try {
    await expect(page.locator('#voice-error-details')).toHaveText('VOICE_INPUT_ACK_TIMEOUT', { timeout: 8000 });
    expect(await page.evaluate(() => window.__receipts.some(event => event.type === 'inputAudioAck'))).toBe(false);
    expect(h.record.sdkStarted).toBe(1);
    await expect.poll(() => h.record.bridge.diagnostics.inputFlow.client?.sentBytes).toBe(12288);
    const flow = h.record.bridge.diagnostics.inputFlow;
    expect(flow.sdkPending).toBe(true);
    expect(flow.sdkPendingMs).toBeGreaterThanOrEqual(2000);
    expect(flow.ackIssuedBytes).toBe(0);
    expect(flow.maxQueuedBytes).toBe(12288);
    results.push({ case: 'sdk-send-pending-3s', passed: true, flow });
  } finally { await h.close(); }
});
