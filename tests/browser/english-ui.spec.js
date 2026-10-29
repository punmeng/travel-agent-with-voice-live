import { test, expect } from '@playwright/test';
import path from 'node:path';
import { englishCandidateAssets } from './english-candidate-assets.js';

const directory = process.env.ENGLISH_UI_CANDIDATE_DIR;
test.skip(!directory, 'Set ENGLISH_UI_CANDIDATE_DIR to exercise the isolated staged frontend.');

async function setup(page, { locale = 'zh-TW', history = [], chat, voiceTicket, localeAvailability, supportedLocales, availableLocales } = {}) {
  const requests = [];
  const state = {
    locale, stage: 'quoted', activeAgent: 'price', contextVersion: 7,
    offers: [{ id: 'existing-offer' }],
    quote: { id: 'existing-quote', version: 3, total: 25000, currency: 'TWD', expiresAt: '2026-12-01T00:00:00Z' }
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (['index.html', 'app.js', 'voice.js', 'voice-options.js', 'voice-options.css', 'style.css', 'ni-airlines-logo.png',
      'waiting.js', 'agent-status.js', 'speech-input.js', 'audio-worklet.js', 'i18n.js'].includes(filename)) {
      return route.fulfill({ path: path.join(directory, filename), contentType: filename.endsWith('.html') ?
        'text/html' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.png') ? 'image/png' : 'text/javascript' });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const request = route.request();
    requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname === '/api/bootstrap') return route.fulfill({ json: {
      locale, state: { ...state, locale }, mode: 'mock', version: '1.0.7', history,
      voice: { available: true, type: 'azure-personal', defaultPersonalVoice: 'alexpun',
        personalVoices: [{ key: 'alexpun', label: '個人化男聲' }, { key: 'athena', label: '個人化女聲' }],
        modes: Object.fromEntries(['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct'].map(mode =>
          [mode, { available: true, advancedSettings: true, sttModes: ['rest', 'sdk'],
            requiredModel: 'gpt-realtime-2.1', configuredModel: 'gpt-realtime-2.1',
            ...(mode === 'voice-realtime' ? { supportedLocales, availableLocales } : {}),
            ...(mode === 'voice-realtime' && localeAvailability ? { localeAvailability } : {}) }])) }
    } });
    if (url.pathname === '/api/language') {
      locale = request.postDataJSON().locale;
      return route.fulfill({ json: { locale, state: { ...state, locale } } });
    }
    if (url.pathname === '/api/reset') {
      locale = 'zh-TW'; history = [];
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/api/progress') return route.fulfill({ json: { progress: { role: 'price', status: 'processing' } } });
    if (url.pathname === '/api/chat') {
      if (chat) return chat(route, state, locale);
      return route.fulfill({ json: { state: { ...state, locale }, text: locale === 'en-US' ?
        'Your quote is TWD 25,000. Review the fare before confirming.' : '您的報價為 TWD 25,000，請先確認票價。' } });
    }
    if (url.pathname === '/api/voice/session') {
      if (voiceTicket) return voiceTicket(route);
      return route.fulfill({ json: { protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream' } });
    }
    throw new Error(`Unexpected API request: ${url.pathname}`);
  });
  await page.addInitScript(() => {
    const Audio = window.AudioContext, Worklet = window.AudioWorkletNode;
    window.AudioContext = class extends Audio { constructor(options) { super(options); window.__context = this; } };
    window.AudioWorkletNode = class extends Worklet { constructor(...args) { super(...args); window.__processor = this; } };
    navigator.mediaDevices.getUserMedia = async () => window.__context.createMediaStreamDestination().stream;
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; controls = []; packets = [];
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready', inputFlow: { maxUnackedBytes: 12288 } }), 20); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) { if (typeof data === 'string') this.controls.push(JSON.parse(data)); else this.packets.push(data.byteLength); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  return { requests, state };
}

test('Ni Airlines logo is accessible, localized and undistorted at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await setup(page);
  const logo = page.locator('.brand img');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', 'Ni Airlines');
  await expect(page.locator('.brand')).toHaveAttribute('aria-label', 'Ni Airlines 首頁');
  await expect.poll(() => logo.evaluate(image => image.naturalWidth)).toBe(1150);
  await page.locator('#language').selectOption('en-US');
  await expect(page.locator('.brand')).toHaveAttribute('aria-label', 'Ni Airlines home');
  const layout = await logo.evaluate(image => {
    const { width, height } = image.getBoundingClientRect();
    return { width, height, naturalRatio: image.naturalWidth / image.naturalHeight, renderedRatio: width / height };
  });
  expect(layout.width).toBeLessThanOrEqual(112);
  expect(Math.abs(layout.renderedRatio - layout.naturalRatio)).toBeLessThan(0.01);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 390, 320]) {
  test(`English switch localizes static and advanced UI without changing journey (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const { requests, state } = await setup(page, { history: [{ role: 'assistant', agent: 'price', text: '既有報價 TWD 25,000，這段歷史必須保留。' }] });
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await page.locator('#language').selectOption('en-US');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page).toHaveTitle('Ni Airlines · AI Travel Planner');
    await expect(page.locator('#messages')).toContainText('既有報價 TWD 25,000，這段歷史必須保留。');
    await expect(page.locator('#message')).toHaveAttribute('placeholder', 'Share your travel ideas…');
    await page.locator('#voice').click();
    await page.locator('.voice-settings > summary').click();
    await page.locator('#voice-advanced > summary').click();
    for (const mode of ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct']) {
      await page.locator('#voice-mode').selectOption(mode);
      if (mode === 'speech-direct') await page.locator('#speech-stt').selectOption('sdk');
      const chineseUi = await page.locator('#voice-dialog').evaluate(panel => {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT), found = [];
        while (walker.nextNode()) if (/\p{Script=Han}/u.test(walker.currentNode.textContent)) found.push(walker.currentNode.textContent);
        return found;
      });
      expect(chineseUi).toEqual([]);
    }
    await expect(page.locator('#gpt-live-language')).toHaveValue('en-US');
    await expect(page.locator('#gpt-live-language')).toBeDisabled();
    await page.locator('#close-voice').click();
    await page.locator('#message').fill('Keep my quote');
    await page.locator('#send').click();
    await expect(page.locator('#messages')).toContainText('Your quote is TWD 25,000');
    expect(requests.find(r => r.path === '/api/chat').body).toMatchObject({
      locale: 'en-US', offerIds: ['existing-offer'], contextVersion: 7, quoteContext: {
        quoteId: state.quote.id, version: 3, total: 25000, currency: 'TWD'
      }
    });
    await page.locator('#language').selectOption('zh-TW');
    await expect(page.locator('#new-trip')).toHaveText('新旅程');
    await expect(page.locator('#messages')).toContainText('Your quote is TWD 25,000');
    expect(requests.filter(r => r.path === '/api/language').map(r => r.body.locale)).toEqual(['en-US', 'zh-TW']);
    expect(requests.some(r => r.path === '/api/reset')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('English loading, agent status, retry and network errors', async ({ page }) => {
  let release, fail = true;
  await setup(page, { locale: 'en-US', chat: async (route, state, locale) => {
    if (fail) { await new Promise(resolve => { release = resolve; }); return route.abort('failed'); }
    return route.fulfill({ json: { text: 'Recovered reply.', state: { ...state, locale } } });
  } });
  await page.locator('#message').fill('Find a flight');
  await page.locator('#send').click();
  await expect(page.locator('#language')).toBeDisabled();
  await expect(page.locator('#busy')).toContainText('Your travel team is preparing');
  await expect(page.locator('#voice-agent')).toContainText('Fares and purchases · Processing');
  release();
  await expect(page.locator('#error')).toContainText('Cannot connect. Check your network and retry.');
  await expect(page.locator('#retry')).toHaveText('Retry');
  await expect(page.locator('#language')).toBeEnabled();
  fail = false;
  await page.locator('#retry').click();
  await expect(page.locator('#messages')).toContainText('Recovered reply.');
});

test('English voice keeps personal voice keys, session locale, live captions and ACK guards', async ({ page }) => {
  const { requests } = await setup(page, { locale: 'en-US' });
  await page.locator('#voice').click();
  await expect(page.locator('#personal-voice option')).toHaveText(['Personal voice · male', 'Personal voice · female']);
  await page.locator('#personal-voice').selectOption('athena');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('Listening');
  expect(requests.find(r => r.path === '/api/voice/session').body).toMatchObject({ locale: 'en-US', personalVoiceKey: 'athena' });
  await expect(page.locator('#language')).toBeDisabled();
  await page.locator('#voice-mute').click();
  await expect(page.locator('#voice-mute')).toHaveText('Unmute');
  await expect(page.locator('#voice-status')).toContainText('Microphone muted');
  await page.evaluate(() => window.__socket.receive({ type: 'inputAudioAck', receivedBytes: 999999 }));
  await expect(page.locator('#voice-status')).toContainText('Invalid audio acknowledgment');
  await expect(page.locator('#language')).toBeEnabled();
  await page.locator('#voice-mode').selectOption('gpt-live');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('Listening');
  const ticket = requests.filter(r => r.path === '/api/voice/session').at(-1).body;
  expect(ticket.voiceOptions['gpt-live']).toMatchObject({ language: 'en-US', voice: 'marin' });
  await page.evaluate(() => window.__socket.receive({ type: 'liveCaption', speaker: 'user', text: 'Keep my destination' }));
  await expect(page.locator('#voice-caption')).toHaveText('Live recognition: Keep my destination');
  await page.evaluate(() => window.__socket.receive({ type: 'liveCaption', speaker: 'assistant', text: 'Sure.' }));
  await expect(page.locator('#voice-caption')).toHaveText('Voice caption: Sure.');
  await page.locator('#voice-stop').click();
});

test('unsupported English neural voice surfaces backend blocker, not an invented voice', async ({ page }) => {
  await setup(page, { locale: 'en-US', voiceTicket: route => route.fulfill({ status: 409, json: {
    error: 'VOICE_LANGUAGE_UNSUPPORTED', message: 'The configured neural voice does not support verified English output.', correlationId: 'demo-test'
  } }) });
  await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption('voice-realtime');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('The configured neural voice does not support verified English output.');
  await expect(page.locator('#voice-error-details')).toContainText('VOICE_LANGUAGE_UNSUPPORTED');
  await expect(page.locator('#language')).toBeEnabled();
});

test('locale availability blocks unverified English Option2 before opening audio', async ({ page }) => {
  const reason = 'English output for this configured neural voice has not been verified.';
  const { requests } = await setup(page, { locale: 'en-US', localeAvailability: {
    'en-US': { available: false, code: 'VOICE_LANGUAGE_UNSUPPORTED', reason },
    'zh-TW': { available: true }
  } });
  await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption('voice-realtime');
  await expect(page.locator('#voice-availability')).toHaveText(reason);
  await expect(page.locator('#voice-start')).toBeDisabled();
  expect(requests.some(r => r.path === '/api/voice/session')).toBe(false);
  await page.locator('#language').selectOption('zh-TW');
  await expect(page.locator('#voice-start')).toBeEnabled();
  await expect(page.locator('#voice-availability')).toBeHidden();
});

for (const field of ['supportedLocales', 'availableLocales']) for (const available of [true, false]) {
  test(`Option2 English follows backend ${field}: ${available}`, async ({ page }) => {
    const { requests } = await setup(page, { locale: 'en-US', [field]: available ? ['zh-TW', 'en-US'] : ['zh-TW'] });
    await page.locator('#voice').click();
    await page.locator('#voice-mode').selectOption('voice-realtime');
    if (!available) {
      await expect(page.locator('#voice-start')).toBeDisabled();
      expect(requests.some(r => r.path === '/api/voice/session')).toBe(false);
    } else {
      await expect(page.locator('#voice-start')).toBeEnabled();
      await page.locator('#voice-start').click();
      await expect(page.locator('#voice-status')).toContainText('Listening');
      expect(requests.find(r => r.path === '/api/voice/session').body).toMatchObject({ locale: 'en-US', mode: 'voice-realtime' });
      await page.locator('#voice-stop').click();
    }
  });
}

test('new journey explicitly restores English after reset defaults to Chinese', async ({ page }) => {
  const { requests } = await setup(page, { locale: 'en-US' });
  await page.locator('#new-trip').click();
  await expect.poll(() => requests.filter(r => r.method === 'POST').map(r => r.path)).toEqual(['/api/reset', '/api/language']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('#new-trip')).toHaveText('New trip');
  expect(requests.find(r => r.path === '/api/language').body).toEqual({ locale: 'en-US' });
});

test('candidate integrates with actual server language and reset contracts without API stubs', async ({ page, baseURL }) => {
  await englishCandidateAssets(page, baseURL);
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'POST') requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#language').selectOption('en-US');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('#language')).toBeEnabled();
  const before = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  expect(before.locale).toBe('en-US');
  expect(before.state.locale).toBe('en-US');
  const displayedHistory = await page.locator('#messages').innerText();
  await page.locator('#language').selectOption('zh-TW');
  await expect(page.locator('#language')).toBeEnabled();
  await page.locator('#language').selectOption('en-US');
  await expect(page.locator('#language')).toBeEnabled();
  expect(await page.locator('#messages').innerText()).toBe(displayedHistory);
  await page.locator('#new-trip').click();
  await expect.poll(() => requests.slice(-2).map(r => r.path)).toEqual(['/api/reset', '/api/language']);
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#language')).toHaveValue('en-US');
  const after = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  expect(after.locale).toBe('en-US');
  expect(after.state.locale).toBe('en-US');
});

for (const width of [1440, 390]) {
  test(`actual HTTP English journey preserves quote and history across language changes (${width}px)`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    await englishCandidateAssets(page, baseURL);
    const snapshot = () => page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    const say = async text => {
      await page.locator('#message').fill(text);
      const responsePromise = page.waitForResponse(response => {
        const request = response.request();
        return new URL(response.url()).pathname === '/api/chat' && request.method() === 'POST' && request.postDataJSON()?.message === text;
      });
      await page.locator('#send').click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const result = await response.json();
      await expect(page.locator('#send')).toBeEnabled();
      await expect(page.locator('#messages .assistant').last().locator('p').last()).toHaveText(result.text);
      expect(result.text).not.toMatch(/\p{Script=Han}/u);
      expect(result.state.locale).toBe('en-US');
      return result;
    };
    const chooseLocale = async locale => {
      await page.locator('#language').selectOption(locale);
      await expect(page.locator('#language')).toBeEnabled();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
    };
    await page.goto('/');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#language')).toHaveValue('zh-TW');
    await chooseLocale('en-US');
    const planned = await say('Plan a five-day business trip from Taoyuan to Narita on November 12, 2026 for two adults, economy, with less walking.');
    expect(planned.text).toContain('Day 5');
    const meetings = await say('Meetings on days 2 and 3 from 09:00 to 17:00 at Tokyo Station.');
    expect(meetings.text).toContain('09:00');
    expect(meetings.text).toContain('17:00');
    const flights = await say('Search flights');
    expect(flights.text).toContain('Synthetic flights');
    expect(flights.state.offers.length).toBeGreaterThan(0);
    const selected = await say('Select flight 1');
    expect(selected.state.selected).toBe(flights.state.offers[0].id);
    const quoted = await say('Reprice');
    expect(quoted.text).toContain('confirm current quote');
    expect(quoted.state.quote.id).toBeTruthy();
    const before = await snapshot();
    const historyContent = page.locator('#messages .message > div > p:last-child:not([data-i18n])');
    const textBefore = await historyContent.allTextContents();
    await chooseLocale('zh-TW');
    const after = await snapshot();
    const { locale: oldLocale, ...oldState } = before.state;
    const { locale: newLocale, ...newState } = after.state;
    expect(oldLocale).toBe('en-US');
    expect(newLocale).toBe('zh-TW');
    expect(newState).toEqual(oldState);
    expect(after.history).toEqual(before.history);
    expect(await historyContent.allTextContents()).toEqual(textBefore);
    expect(after.state.quote).toEqual(quoted.state.quote);
    await chooseLocale('en-US');
    expect(await historyContent.allTextContents()).toEqual(textBefore);
    const navigation = page.waitForEvent('load');
    await page.locator('#new-trip').click();
    await navigation;
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#language')).toHaveValue('en-US');
    const reset = await snapshot();
    expect(reset.locale).toBe('en-US');
    expect(reset.state.locale).toBe('en-US');
    expect(reset.state.quote).toBeNull();
    expect(reset.state.offers).toEqual([]);
    expect(await page.locator('#messages .message > div > p:last-child').allTextContents()).not.toContain(quoted.text);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('English SDK validation, stream events and advanced validation are localized', async ({ page }) => {
  await setup(page, { locale: 'en-US' });
  await page.locator('#voice').click();
  await page.locator('.voice-settings > summary').click();
  await page.locator('#voice-advanced > summary').click();
  await page.locator('#voice-live-phrase-list').fill('x'.repeat(101));
  await expect(page.locator('.voice-advanced-error')).toContainText('Invalid advanced voice settings');
  await page.locator('#voice-mode').selectOption('speech-direct');
  await page.locator('#speech-stt').selectOption('sdk');
  await page.locator('#speech-source').selectOption('wav');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('Select an 8/16 kHz PCM16 mono WAV');
  await page.locator('#speech-source').selectOption('microphone');
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('Listening');
  await page.evaluate(() => {
    window.__socket.receive({ type: 'asr', kind: 'session_started', elapsedMs: 1 });
    window.__socket.receive({ type: 'asr', kind: 'recognizing', elapsedMs: 2, text: 'Tokyo' });
    window.__socket.receive({ type: 'asr', kind: 'recognized', elapsedMs: 3, text: 'Tokyo', sequence: 1, offsetMs: 0, durationMs: 100 });
  });

  await expect(page.locator('#speech-events')).toContainText('Connected');
  await expect(page.locator('#speech-finals')).toContainText('Segment 1 · Offset 0 ms · Duration 100 ms · Received 3 ms: Tokyo');
  await page.locator('#voice-stop').click();
  await page.locator('#language').selectOption('zh-TW');
  await expect(page.locator('#speech-events')).toContainText('連線完成');
  await expect(page.locator('#speech-finals')).toContainText('第1段 · 起點 0 ms · 長度 100 ms · 接收 3 ms：Tokyo');
  await expect(page.locator('#speech-interim')).toBeEmpty();
});

  test('mobile voice resizing keeps footer reachable and conversation readable in both languages', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    for (const locale of ['zh-TW', 'en-US']) {
      await page.locator('#language').selectOption(locale);
      await expect(page.locator('#language')).toBeEnabled();
      await page.locator('#voice').click();
      for (const height of ['260', '440', '160']) {
        await page.locator('#voice-panel-height').evaluate((input, value) => {
          input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
        }, height);
        await page.locator('.app-footer').scrollIntoViewIfNeeded();
        const bounds = await page.evaluate(() => ({
          footer: document.querySelector('.app-footer').getBoundingClientRect().toJSON(),
          composer: document.querySelector('.composer-area').getBoundingClientRect().toJSON(),
          viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
          overflowing: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
            .map(node => `${node.tagName}#${node.id}.${node.className} ${Math.round(node.getBoundingClientRect().right)}`)
        }));
        expect(bounds.footer.top).toBeGreaterThanOrEqual(bounds.composer.bottom - 1);
        expect(bounds.footer.bottom).toBeLessThanOrEqual(bounds.viewport + 1);
        expect(bounds.overflow, JSON.stringify({ locale, height, overflowing: bounds.overflowing })).toBe(false);
        expect(await page.locator('#messages').evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(240);
      }
      await page.locator('#close-voice').click();
    }
  });

  test('known legacy delegation metadata gets customer label without rewriting stored transcript', async ({ page }) => {
    const text = '語音前端委派（非原始逐字稿）：你好你聽得到我說話嗎？';
    await setup(page, { history: [{ role: 'user', text }] });
    await expect(page.locator('#messages')).toContainText('需求摘要：你好你聽得到我說話嗎？');
    await expect(page.locator('#messages')).not.toContainText('非原始逐字稿');
    await page.locator('#language').selectOption('en-US');
    await expect(page.locator('#language')).toBeEnabled();
    await expect(page.locator('#messages')).toContainText('Request summary: 你好你聽得到我說話嗎？');
    const bootstrap = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    expect(bootstrap.history[0].text).toBe(text);
    await page.locator('#language').selectOption('zh-TW');
    await expect(page.locator('#messages')).toContainText('需求摘要：你好你聽得到我說話嗎？');
  });
for (const locale of ['zh-TW', 'en-US']) for (const mode of ['voice-live', 'speech-direct']) {
  test(`${locale} ${mode}: bounded playback preserves display, segment ACK and resume ordering`, async ({ page }) => {
    const { state } = await setup(page, { locale });
    await page.evaluate(() => {
      window.__time = 0; window.__nodes = [];
      const NativeAudio = window.AudioContext;
      window.AudioContext = class extends NativeAudio {
        get currentTime() { return window.__time; }
        createBufferSource() {
          return { connect() {}, disconnect() {}, stop() { this.stopped = true; },
            start(at) { this.at = at; this.scheduledAt = window.__time; window.__nodes.push(this); } };
        }
      };
      window.__advance = time => {
        window.__time = time;
        for (const node of window.__nodes) if (!node.ended && node.at + node.buffer.duration <= time) {
          node.ended = true; node.onended?.();
        }
      };
      window.__audio = btoa(String.fromCharCode(...new Uint8Array(48000)));
    });
    await page.locator('#voice').click();
    await page.locator('#voice-mode').selectOption(mode);
    await page.locator('#voice-start').click();
    await expect(page.locator('#voice-status')).toContainText(locale === 'en-US' ? 'Listening' : '聆聽中');
    await page.clock.install();
    await page.evaluate(({ state }) => {
      window.__socket.receive({ type: 'transcript', text: 'Keep all five days.', turnId: 'detail' });
      window.__socket.receive({ type: 'result', turnId: 'detail', result: {
        text: 'Day 1: Arrival. Day 2: Meeting. Day 3: Meeting. Day 4: Explore. Day 5: Return.',
        state: { ...state, activeAgent: 'planner' }
      } });
      for (let i = 0; i < 45; i++) window.__socket.receive({ type: 'audio', audio: window.__audio });
      window.__socket.receive({ type: 'audioSegmentDone', turnId: 'detail', segment: 0 });
    }, { state });
    await expect(page.locator('#messages')).toContainText('Day 5: Return.');
    if (locale === 'en-US') await expect(page.locator('#voice-metrics')).toContainText('Playback scheduling');
    expect(await page.evaluate(() => window.__nodes.length)).toBe(30);
    expect(await page.evaluate(() => window.__socket.controls.filter(e => e.type === 'displayed')))
      .toEqual([{ type: 'displayed', turnId: 'detail' }]);
    expect(await page.evaluate(() => window.__socket.controls.some(e => e.type === 'segmentPlayed' || e.type === 'resume'))).toBe(false);
    await page.evaluate(() => window.__advance(15));
    await page.clock.fastForward(15000);
    expect(await page.evaluate(() => window.__nodes.length)).toBe(45);
    expect(await page.evaluate(() => window.__nodes.every(n => n.at + n.buffer.duration - n.scheduledAt <= 30))).toBe(true);
    await page.evaluate(() => window.__advance(45));
    await page.clock.fastForward(30040);
    expect(await page.evaluate(() => window.__socket.controls.filter(e => e.type === 'segmentPlayed')))
      .toEqual([{ type: 'segmentPlayed', turnId: 'detail', segment: 0 }]);
    await page.evaluate(() => window.__socket.receive({ type: 'audioDone', turnId: 'detail' }));
    await page.clock.fastForward(40);
    await expect(page.locator('#voice-status')).toContainText(locale === 'en-US' ? 'Listening' : '聆聽中');
    expect(await page.evaluate(() => window.__socket.controls.filter(e => e.type === 'resume').length))
      .toBe(mode === 'speech-direct' ? 1 : 0);
    await page.locator('#voice-stop').click();
    await expect(page.locator('#language')).toBeEnabled();
    expect(await page.evaluate(() => window.__nodes.every(n => n.ended || n.stopped))).toBe(true);
  });
}
