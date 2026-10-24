import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z, ZodError } from 'zod';
import { airports, network } from './lib/dataset.js';
import { AppError, createSession, callTool, selectOffer, consentToQuote, purchase, publicState } from './lib/core.js';
import { chat } from './lib/agents.js';
import { foundryConfig } from './lib/foundry.js';
import { readCheckout, checkoutPage } from './lib/checkout.js';
import { attachVoice, voiceFailureDetails } from './lib/voice.js';
import { replyState, quoteWasPresented } from './lib/replies.js';
import { cityResolver } from './lib/city-airports.js';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'],
  '/speech-input.js': ['speech-input.js', 'text/javascript; charset=utf-8'],
  '/waiting.js': ['waiting.js', 'text/javascript; charset=utf-8'],
  '/agent-status.js': ['agent-status.js', 'text/javascript; charset=utf-8'],
  '/audio-worklet.js': ['audio-worklet.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const idSchema = z.object({ offerId: z.string().uuid() }).strict();
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const themeScript = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const themeHash = createHash('sha256').update(themeScript.replace(/\r\n?/g, '\n')).digest('base64');
const build = createHash('sha256').update(['./server.js', './package.json', './lib/core.js', './lib/replies.js', './lib/limits.js', './lib/conversation.js', './lib/agents.js', './lib/voice.js',
  './lib/speech.js', './lib/speech-sdk.js', './lib/gpt-live.js', './lib/direct-speech.js', './lib/pcm-vad.js', './lib/voice-metrics.js', './lib/city-airports.js', './lib/journey.js', './lib/foundry.js', './data/cities.json',
  './public/app.js', './public/voice.js', './public/audio-worklet.js', './public/speech-input.js', './public/agent-status.js', './public/index.html', './public/style.css']
  .map(file => readFileSync(new URL(file, import.meta.url))).reduce((text, bytes) => text + bytes.toString('utf8'), '') +
  JSON.stringify(cityResolver.snapshot)).digest('hex').slice(0, 16);
export function createApp(env = process.env, dependencies = {}) {
  if (!['mock', 'foundry'].includes(env.APP_MODE ?? 'mock')) throw new Error('APP_MODE must be mock or foundry');
  if (env.PAYMENT_PROVIDER && env.PAYMENT_PROVIDER !== 'mock') throw new Error('Only PAYMENT_PROVIDER=mock is implemented. No real payment provider is configured.');
  foundryConfig(env);
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    res.setHeader('X-Correlation-ID', correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${themeHash}'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    res.setHeader('Permissions-Policy', `microphone=${voice.available ? '(self)' : '()'}, camera=(), geolocation=()`);
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...data, correlationId }));
    };
    let locked;
    try {
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) throw new AppError('HOST_FORBIDDEN', '僅接受本機存取。', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': mime });
        res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') return send(200, {
        ok: true, version, mode: env.APP_MODE ?? 'mock', build, voice: { available: voice.available, type: voice.type, modes: voice.modes }
      });
      if (!url.pathname.startsWith('/api/') && !/^\/checkout\/[a-f0-9]{64}$/.test(url.pathname)) throw new AppError('NOT_FOUND', '找不到資源。', 404);
      if (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host}`) throw new AppError('ORIGIN_FORBIDDEN', '請從本機應用程式送出請求。', 403);
      if (req.method !== 'GET' && req.method !== 'POST') throw new AppError('METHOD', '不支援的 HTTP 方法。', 405);
      const now = Date.now();
      for (const [id, s] of sessions) if (now - s.updatedAt > 3600000 && !s.busy) sessions.delete(id);
      const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('journey='))?.slice(8);
      let session = sessions.get(cookie);
      if (!session) {
        if (sessions.size >= 100) throw new AppError('SESSION_LIMIT', '本機工作階段已滿。', 429);
        session = createSession(); sessions.set(session.id, session);
        res.setHeader('Set-Cookie', `journey=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      }
      session.updatedAt = now;
      if (req.method === 'GET' && url.pathname.startsWith('/checkout/')) {
        const checkout = readCheckout(session, url.pathname.split('/').at(-1));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(checkoutPage(checkout));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(200, {
        airports, metadata: network.metadata, state: replyState(session, publicState(session)), history: session.history,
        mode: env.APP_MODE ?? 'mock', version,
        pending: session.busy,
        voice: { available: voice.available, type: voice.type, modes: voice.modes,
          ...(voice.personalVoices ? { personalVoices: voice.personalVoices, defaultPersonalVoice: voice.defaultPersonalVoice } : {}),
          state: voice.available ? 'ready-to-connect' : 'configuration-required',
          message: voice.available ? '四種比較方式共用四代理與模擬庫存。GPT-Live與GPT-Realtime前端不處理交易，語音可能改述，請以畫面為準；未設定模式不可用。' : '語音尚未啟用，未要求麥克風權限。請參閱 docs/FOUNDRY.md。' }
      });
      if (req.method === 'GET' && url.pathname === '/api/progress') {
        const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(Object.fromEntries(url.searchParams));
        return send(200, { progress: session.processing?.requestId === requestId ? session.processing : null });
      }
      if (req.method !== 'POST') throw new AppError('NOT_FOUND', '找不到 API。', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('CONTENT_TYPE', '必須使用 JSON。', 415);
      if (session.busy) throw new AppError('SESSION_BUSY', '上一個請求仍在處理中。', 409);
      if (session.voice) throw new AppError('VOICE_ACTIVE', '請先停止語音，再繼續文字對話或開啟新旅程。', 409);
      session.busy = true; locked = session;
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 12000) throw new AppError('BODY_LIMIT', '請求過大。', 413);
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new AppError('INVALID_JSON', 'JSON 格式無效。'); }
      if (url.pathname === '/api/chat') {
        const requestId = z.string().uuid().optional().parse(data.requestId);
        session.processing = null;
        try {
          const result = await chat(session, data, env, { ...dependencies.chat,
            onProgress: role => {
              if (requestId && ['intent', 'planner', 'flight', 'price'].includes(role)) {
                session.processing = { requestId, role, status: 'processing' };
              }
            }
          });
          if (requestId) session.processing = { requestId, role: result.state.activeAgent, status: 'completed' };
          return send(200, result);
        } catch (error) { session.processing = null; throw error; }
      }
      if (url.pathname === '/api/select') {
        const { offerId } = idSchema.parse(data);
        selectOffer(session, offerId); session.activeAgent = 'price';
        return send(200, { state: publicState(session) });
      }
      if (url.pathname === '/api/reprice') {
        const { offerId } = idSchema.parse(data);
        const result = await callTool(session, 'price', 'reprice_offer', { offerId });
        session.activeAgent = 'price';
        return send(200, { result, state: publicState(session) });
      }
      if (url.pathname === '/api/consent') {
        if (!quoteWasPresented(session)) throw new AppError('QUOTE_NOT_PRESENTED', '請先透過對話閱讀完整確認價。', 409);
        const result = consentToQuote(session, data);
        return send(200, { result, state: publicState(session) });
      }
      if (url.pathname === '/api/purchase') {
        const receipt = purchase(session, data);
        return send(200, { receipt, state: publicState(session) });
      }
      if (url.pathname === '/api/reset') {
        z.object({}).strict().parse(data);
        sessions.delete(session.id);
        return send(200, { reset: true });
      }
      if (url.pathname === '/api/voice/session') {
        return send(200, voice.ticket(session, data));
      }
      throw new AppError('NOT_FOUND', '找不到 API。', 404);
    } catch (error) {
      const validation = error instanceof ZodError;
      const status = validation ? 400 : error instanceof AppError ? error.status : 500;
      console.error(JSON.stringify({ correlationId, code: error.code ?? (validation ? 'VALIDATION' : 'INTERNAL'), status,
        ...voiceFailureDetails(error, Date.now() - startedAt) }));
      if (!res.headersSent) send(status, {
        error: validation ? 'VALIDATION' : error.code ?? 'INTERNAL',
        message: validation ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') :
          error instanceof AppError ? error.message : '處理失敗，請重試；若持續發生請提供關聯識別碼。'
      });
      else res.end();
    } finally { if (locked) locked.busy = false; }
  });
  const voice = attachVoice(server, sessions, env, dependencies.voice);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createApp();
  server.requestTimeout = 90000;
  server.listen(port, '127.0.0.1', () => console.log(`Plum Journeys: http://127.0.0.1:${port} (${process.env.APP_MODE ?? 'mock'})`));
}
