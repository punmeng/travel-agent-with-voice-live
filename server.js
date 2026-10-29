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
import { localeSchema, localizedError, sessionLocale } from './lib/language.js';
import { hostingPolicy } from './lib/hosting.js';
import { seedMemberOrigin, memberOriginPrompt } from './lib/member-origin.js';
import { authenticateMember, createLoginRateLimiter, hasActiveMemberJourney, memberDefaults,
  memberLoginSchema, memberProfile } from './lib/members.js';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ni-airlines-logo.png': ['ni-airlines-logo.png', 'image/png'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'],
  '/voice-options.js': ['voice-options.js', 'text/javascript; charset=utf-8'],
  '/voice-options.css': ['voice-options.css', 'text/css; charset=utf-8'],
  '/lib/voice-options.js': ['../lib/voice-options.js', 'text/javascript; charset=utf-8'],
  '/speech-input.js': ['speech-input.js', 'text/javascript; charset=utf-8'],
  '/waiting.js': ['waiting.js', 'text/javascript; charset=utf-8'],
  '/agent-status.js': ['agent-status.js', 'text/javascript; charset=utf-8'],
  '/audio-worklet.js': ['audio-worklet.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};
const idSchema = z.object({ offerId: z.string().uuid() }).strict();
const logoutSchema = z.object({ confirmReset: z.boolean().optional().default(false) }).strict();
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const themeScript = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const themeHash = createHash('sha256').update(themeScript.replace(/\r\n?/g, '\n')).digest('base64');
const build = createHash('sha256').update(['./server.js', './package.json', './lib/core.js', './lib/replies.js', './lib/limits.js', './lib/hosting.js', './lib/conversation.js', './lib/agents.js', './lib/voice.js',
  './lib/member-origin.js',
  './lib/members.js', './data/member-personas.json',
  './lib/speech.js', './lib/speech-sdk.js', './lib/gpt-live.js', './lib/direct-speech.js', './lib/voice-agent.js', './lib/pcm-vad.js', './lib/voice-metrics.js', './lib/city-airports.js', './lib/journey.js', './lib/foundry.js', './lib/validation.js', './lib/voice-options.js', './lib/language.js', './lib/english-input.js', './lib/english-replies.js', './lib/voice-language.js', './data/cities.json',
  './public/app.js', './public/i18n.js', './public/waiting.js', './public/voice.js', './public/voice-options.js', './public/voice-options.css', './public/audio-worklet.js', './public/speech-input.js', './public/agent-status.js', './public/index.html', './public/style.css']
  .map(file => readFileSync(new URL(file, import.meta.url))).reduce((text, bytes) => text + bytes.toString('utf8'), '') +
  createHash('sha256').update(readFileSync(new URL('./public/ni-airlines-logo.png', import.meta.url))).digest('hex') +
  JSON.stringify(cityResolver.snapshot)).digest('hex').slice(0, 16);
export function createApp(env = process.env, dependencies = {}) {
  const hosting = hostingPolicy(env);
  if (!['mock', 'foundry'].includes(env.APP_MODE ?? 'mock')) throw new Error('APP_MODE must be mock or foundry');
  if (env.PAYMENT_PROVIDER && env.PAYMENT_PROVIDER !== 'mock') throw new Error('Only PAYMENT_PROVIDER=mock is implemented. No real payment provider is configured.');
  foundryConfig(env);
  const sessions = new Map();
  const loginRateLimiter = createLoginRateLimiter();
  const setSessionCookie = (res, session) => res.setHeader('Set-Cookie',
    `journey=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${hosting.secureCookies ? '; Secure' : ''}`);
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
    let locked, requestLocale = 'zh-TW';
    try {
      if (!hosting.acceptsHost(req.headers.host)) throw new AppError('HOST_FORBIDDEN',
        hosting.secureCookies ? '僅接受已設定的應用程式網域。' : '僅接受本機存取。', 403);
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
      if (req.method === 'POST' && !hosting.acceptsOrigin(req.headers.host, req.headers.origin)) throw new AppError('ORIGIN_FORBIDDEN',
        hosting.secureCookies ? '請從已設定的應用程式來源送出請求。' : '請從本機應用程式送出請求。', 403);
      if (req.method !== 'GET' && req.method !== 'POST') throw new AppError('METHOD', '不支援的 HTTP 方法。', 405);
      const now = Date.now();
      for (const [id, s] of sessions) if (now - s.updatedAt > 3600000 && !s.busy) sessions.delete(id);
      const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('journey='))?.slice(8);
      let session = sessions.get(cookie);
      if (!session) {
        if (sessions.size >= 100) throw new AppError('SESSION_LIMIT', '本機工作階段已滿。', 429);
        session = createSession(); sessions.set(session.id, session);
        setSessionCookie(res, session);
      }
      session.updatedAt = now;
      requestLocale = sessionLocale(session);
      if (req.method === 'GET' && url.pathname.startsWith('/checkout/')) {
        const checkout = readCheckout(session, url.pathname.split('/').at(-1));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(checkoutPage(checkout, requestLocale));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(200, {
        airports, metadata: network.metadata, state: replyState(session, publicState(session)), history: session.history,
        mode: env.APP_MODE ?? 'mock', version, locale: requestLocale,
        member: session.memberId ? memberProfile(session.memberId, requestLocale) : null, originPrompt: memberOriginPrompt(session),
        hasActiveJourney: hasActiveMemberJourney(session),
        pending: session.busy,
        voice: { available: voice.available, type: voice.type, modes: voice.modes,
          ...(voice.personalVoices ? { personalVoices: voice.personalVoices, defaultPersonalVoice: voice.defaultPersonalVoice } : {}),
          state: voice.available ? 'ready-to-connect' : 'configuration-required',
          message: requestLocale === 'en-US' ? voice.available
            ? 'Configured voice modes use the same backend journey and synthetic inventory. Managed Foundry voice has passed bounded synthetic Chinese/English member-search tests; human microphone quality still needs testing. Same-item final ASR is the backend input. Voice may paraphrase; use the screen as the authoritative result. Unconfigured modes remain unavailable.'
            : 'Voice is not enabled. No microphone permission was requested. See docs/FOUNDRY.md.'
            : voice.available ? '已設定的語音模式共用同一後端旅程與合成庫存。Foundry託管語音已通過有限中英文合成會員搜尋驗證，真人麥克風品質仍待測；後端只採同回合ASR最終原文。語音可能改述，請以畫面為準；未設定模式不可用。' : '語音尚未啟用，未要求麥克風權限。請參閱 docs/FOUNDRY.md。' }
      });
      if (req.method === 'GET' && url.pathname === '/api/progress') {
        const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(Object.fromEntries(url.searchParams));
        return send(200, { progress: session.processing?.requestId === requestId ? session.processing : null });
      }
      if (req.method !== 'POST') throw new AppError('NOT_FOUND', '找不到 API。', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('CONTENT_TYPE', '必須使用 JSON。', 415);
      if (session.busy) throw new AppError('SESSION_BUSY', '上一個請求仍在處理中。', 409);
      const memberTransition = url.pathname === '/api/member/login' || url.pathname === '/api/member/logout';
      if (session.voice && !memberTransition) throw new AppError('VOICE_ACTIVE', '請先停止語音，再繼續文字對話或開啟新旅程。', 409);
      session.busy = true; locked = session;
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > (url.pathname === '/api/voice/session' ? 96000 : 12000)) throw new AppError('BODY_LIMIT', '請求過大。', 413);
      }
      let data;
      try { data = JSON.parse(body); } catch { throw new AppError('INVALID_JSON', 'JSON 格式無效。'); }
      if (url.pathname === '/api/member/login') {
        const args = memberLoginSchema.parse(data);
        const remoteAddress = req.socket.remoteAddress ?? 'local';
        if (loginRateLimiter.blocked(remoteAddress)) throw new AppError('MEMBER_RATE_LIMIT', '登入失敗次數過多，請 15 分鐘後再試。', 429);
        const member = await authenticateMember(args.email, args.password);
        if (!member) {
          loginRateLimiter.recordFailure(remoteAddress);
          throw new AppError('MEMBER_INVALID', '電子郵件或密碼不正確。', 401);
        }
        if (session.memberId === member.id) {
          return send(200, { member: memberProfile(member.id, requestLocale), changed: false,
            state: replyState(session, publicState(session)), hasActiveJourney: hasActiveMemberJourney(session) });
        }
        if (hasActiveMemberJourney(session) && !args.confirmReset) {
          throw new AppError('MEMBER_CONFIRMATION_REQUIRED', '切換會員前必須先確認清除目前旅程。', 409);
        }
        const previous = session;
        previous.voice?.stop();
        sessions.delete(previous.id);
        session = createSession(now);
        session.locale = previous.locale;
        session.memberId = member.id;
        session.draft = memberDefaults(member.id);
        seedMemberOrigin(session);
        sessions.set(session.id, session);
        setSessionCookie(res, session);
        return send(200, { member: memberProfile(member.id, sessionLocale(session)), changed: true,
          state: replyState(session, publicState(session)), originPrompt: memberOriginPrompt(session), hasActiveJourney: false, history: [] });
      }
      if (url.pathname === '/api/member/logout') {
        const args = logoutSchema.parse(data);
        if (hasActiveMemberJourney(session) && !args.confirmReset) {
          throw new AppError('MEMBER_CONFIRMATION_REQUIRED', '登出前必須先確認清除目前旅程。', 409);
        }
        if (session.memberId || hasActiveMemberJourney(session)) {
          const previous = session;
          previous.voice?.stop();
          sessions.delete(previous.id);
          session = createSession(now);
          session.locale = previous.locale;
          sessions.set(session.id, session);
          setSessionCookie(res, session);
        }
        return send(200, { member: null, changed: true, state: replyState(session, publicState(session)),
          hasActiveJourney: false, history: [] });
      }
      if (url.pathname === '/api/language') {
        const { locale } = z.object({ locale: localeSchema }).strict().parse(data);
        session.locale = locale;
        return send(200, { locale, state: replyState(session, publicState(session)) });
      }
      if (url.pathname === '/api/chat') {
        const requestId = z.string().uuid().optional().parse(data.requestId);
        session.processing = null;
        try {
          const result = await chat(session, data, env, { ...dependencies.chat,
            memberAware: Boolean(session.memberId),
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
        const previous = session;
        previous.voice?.stop();
        sessions.delete(previous.id);
        session = createSession(now);
        session.locale = previous.locale;
        session.memberId = previous.memberId;
        session.draft = memberDefaults(previous.memberId);
        seedMemberOrigin(session);
        sessions.set(session.id, session);
        setSessionCookie(res, session);
        return send(200, { reset: true, member: session.memberId ? memberProfile(session.memberId, requestLocale) : null,
          state: replyState(session, publicState(session)), hasActiveJourney: false, history: [] });
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
        message: requestLocale === 'en-US' ? localizedError(error, requestLocale) : validation ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') :
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
  const hosting = hostingPolicy();
  const server = createApp();
  server.requestTimeout = 90000;
  server.listen(port, hosting.bindAddress, () => console.log(
    `Plum Journeys: ${hosting.secureCookies ? process.env.PUBLIC_ORIGIN : `http://127.0.0.1:${port}`} (${process.env.APP_MODE ?? 'mock'})`));
}
