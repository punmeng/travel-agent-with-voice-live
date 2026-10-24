import { createVoiceController } from './voice.js';
import { createWaitingNotice } from './waiting.js';
import { createAgentStatus } from './agent-status.js';
const $ = id => document.getElementById(id);
const agentStatus = createAgentStatus($('voice-agent'));
const roles = { intent: '意圖協調師', planner: '旅遊規劃師', flight: '航班查詢師', price: '票價與購買師' };
let state = null, loading = false, retryAction = null, voiceActive = false;
const voiceTranscripts = new Map();
const waiting = createWaitingNotice((visible, text) => { $('busy').textContent = visible ? text : '旅程團隊正在整理您的提案…'; });
window.addEventListener('pagehide', () => waiting.clear());
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(path, body, signal) {
  const response = await fetch(`/api/${path}`, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message);
    error.code = data.error; error.diagnostic = `${data.error} · ${data.correlationId}`;
    throw error;
  }
  return data;
}
function watchProgress(requestId) {
  const controller = new AbortController();
  let timer, wake;
  agentStatus.start(requestId);
  const stop = role => {
    controller.abort(); clearTimeout(timer); wake?.();
    window.removeEventListener('pagehide', stop);
    if (typeof role === 'string') agentStatus.update(requestId, role, 'completed');
    else agentStatus.clear();
  };
  window.addEventListener('pagehide', stop, { once: true });
  void (async () => {
    try {
      while (!controller.signal.aborted) {
        const { progress } = await api(`progress?requestId=${encodeURIComponent(requestId)}`, undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (progress) agentStatus.update(requestId, progress.role, progress.status);
        await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 750); });
      }
    } catch {
      if (!controller.signal.aborted) agentStatus.unavailable(requestId);
    }
  })();
  return stop;
}
function busy(value) {
  loading = value;
  $('busy').hidden = !value;
  for (const id of ['send', 'new-trip', 'voice', 'retry']) $(id).disabled = value || voiceActive;
  $('voice-start').disabled = value || voiceActive || $('voice-start').dataset.available === 'false';
  $('message').disabled = voiceActive;
  $('messages').setAttribute('aria-busy', String(value));
}
async function run(action) {
  if (loading) return;
  retryAction = action; $('error').hidden = true; busy(true);
  waiting.start();
  try { await action(); retryAction = null; }
  catch (error) { $('error').querySelector('span').textContent = `${error.message}${error.diagnostic ? `（${error.diagnostic}）` : ''}`; $('error').hidden = false; }
  finally { waiting.clear(); busy(false); }
}
function message(text, role = 'assistant', agent) {
  if (role === 'user') text = text.replace(/^語音前端委派（非原始逐字稿）：/, '需求摘要：');
  const article = el('article', undefined, `message ${role}`);
  const content = el('div');
  const paragraph = el('p');
  const pattern = /\/checkout\/[a-f0-9]{64}\b/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    paragraph.append(document.createTextNode(text.slice(last, match.index)));
    const link = el('a', '開啟模擬結帳（不收款）');
    link.href = match[0]; paragraph.append(link); last = match.index + match[0].length;
  }
  paragraph.append(document.createTextNode(text.slice(last)));
  content.append(el('p', role === 'user' ? '您' : roles[agent] ?? '旅程助理', 'speaker'), paragraph);
  article.append(content); $('messages').append(article);
  return content;
}
function scroll() { $('messages').scrollTop = $('messages').scrollHeight; }
function setState(next) {
  state = next;
  document.querySelectorAll('[data-agent]').forEach(n => n.classList.toggle('active', n.dataset.agent === state.activeAgent));
  document.querySelectorAll('[data-stage]').forEach(n => n.classList.toggle('active', n.dataset.stage.split(' ').includes(state.stage)));
}
async function sendChat(text) {
  if (voiceActive) return;
  const q = state?.quote;
  // Capture the displayed context now, not at retry time or from a newer server quote.
  const request = {
    message: text, ...(state?.textDelivery ? { delivery: 'text' } : {}),
    requestId: crypto.randomUUID(), contextVersion: state?.contextVersion,
    offerIds: state?.offers.map(o => o.id) ?? [],
    quoteContext: q ? { quoteId: q.id, version: q.version, total: q.total, currency: q.currency, expiresAt: q.expiresAt } : null
  };
  message(text, 'user'); $('message').value = ''; scroll();
  await run(async () => {
    const finishProgress = watchProgress(request.requestId);
    try {
      const result = await api('chat', request);
      finishProgress(result.state.activeAgent); showResult(result);
    } catch (error) { finishProgress(); throw error; }
  });
}
function showResult(result) {
  setState(result.state);
  const target = message(result.text, 'assistant', result.state.activeAgent);
  scroll();
}
const voiceController = createVoiceController({
  agentStatus,
  api, onTranscript: (text, turnId) => { voiceTranscripts.set(turnId, message(text, 'user')); scroll(); }, onResult: showResult,
  onSuperseded: turnId => {
    const content = voiceTranscripts.get(turnId);
    if (content) content.querySelector('.speaker').textContent = '您 · 已由後續更正取代';
  },
  canStart: () => !loading && !voiceActive,
  onRecovered: data => {
    voiceTranscripts.clear();
    setState(data.state); $('messages').replaceChildren();
    for (const entry of data.history ?? []) message(entry.text, entry.role, entry.agent);
    scroll();
  },
  getDisplayedContext: () => ({
    offerIds: state?.offers.map(o => o.id) ?? [],
    quoteContext: state?.quote ? { quoteId: state.quote.id, version: state.quote.version, total: state.quote.total, currency: state.quote.currency, expiresAt: state.quote.expiresAt } : null
  }),
  onActive: active => { voiceActive = active; busy(loading); }
});
$('chat-form').addEventListener('submit', e => { e.preventDefault(); if (!loading && $('message').value.trim()) sendChat($('message').value.trim()); });
$('message').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); } });
$('retry').addEventListener('click', () => { if (retryAction) run(retryAction); });
$('new-trip').addEventListener('click', () => run(async () => { await api('reset', {}); window.location.reload(); }));
$('voice').addEventListener('click', () => {
  $('voice-message').textContent = '航班與票價皆為合成示範，請以畫面內容為準。選班、報價及購買請使用文字對話。';
  $('voice-dialog').hidden = false;
});
await run(async () => {
  const data = await api('bootstrap');
  if (data.version) { $('app-version').textContent = `v${data.version}`; $('app-version').hidden = false; }
  $('mode').textContent = data.mode === 'mock' ? '旅遊規劃示範' : 'AI 旅遊規劃';
  $('voice').querySelector('span').textContent = data.voice.available ? '選擇語音模式' : '語音尚未啟用';
  voiceController.configureModes(data.voice);
  setState(data.state);
  for (const entry of data.history ?? []) message(entry.text, entry.role, entry.agent);
  scroll();
});
