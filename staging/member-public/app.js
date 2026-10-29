import { createVoiceController } from './voice.js';
import { createWaitingNotice } from './waiting.js';
import { createAgentStatus } from './agent-status.js';
import { t, getLocale, setLocale, applyTranslations } from './i18n.js';
const $ = id => document.getElementById(id);
const agentStatus = createAgentStatus($('voice-agent'));
$('session-context').open = window.matchMedia('(min-width: 901px) and (min-height: 651px)').matches;
const roles = { intent: '意圖協調師', planner: '旅遊規劃師', flight: '航班查詢師', price: '票價與購買師' };
let state = null, loading = false, retryAction = null, voiceActive = false, currentMember = null;
const voiceTranscripts = new Map();
const waiting = createWaitingNotice((visible, text) => { $('busy').textContent = visible ? text : t('旅程團隊正在整理您的提案…'); });
window.addEventListener('pagehide', () => waiting.clear());
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(path, body, signal) {
  let response;
  try { response = await fetch(`/api/${path}`, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal
  }); } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(t('無法連線，請檢查網路後重試。'));
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(t('服務回應格式無效，請稍後重試。')); }
  if (!response.ok) {
    const error = new Error(data.message || t('無法完成請求，請稍後重試。'));
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
  for (const id of ['send', 'new-trip', 'voice', 'retry', 'language', 'member-login', 'member-logout', 'origin-confirm', 'origin-change']) $(id).disabled = value || voiceActive;
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
  const article = el('article', undefined, `message ${role}`);
  const content = el('div');
  const paragraph = el('p');
  const ranking = role === 'assistant' ? state?.memberRanking : null;
  const applied = ranking?.message && text.includes(ranking.message) &&
    !document.querySelector('.applied-preferences') && ranking.offerIds?.length >= 2 &&
    ranking.offerIds.every(id => state.offers.some(offer => offer.id === id)) ? ranking : null;
  if (applied) text = text.replace(applied.message, '').replace(/\n{3,}/g, '\n\n');
  const legacySummaryPrefix = '語音前端委派（非原始逐字稿）：';
  if (role === 'user' && text.startsWith(legacySummaryPrefix)) {
    const label = el('span', t('需求摘要：'));
    label.dataset.i18n = '需求摘要：';
    paragraph.append(label);
    text = text.slice(legacySummaryPrefix.length);
  }
  const pattern = /\/checkout\/[a-f0-9]{64}\b/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    paragraph.append(document.createTextNode(text.slice(last, match.index)));
    const link = el('a', t('開啟模擬結帳（不收款）'));
    link.dataset.i18n = '開啟模擬結帳（不收款）';
    link.href = match[0]; paragraph.append(link); last = match.index + match[0].length;
  }
  paragraph.append(document.createTextNode(text.slice(last)));
  const speakerKey = role === 'user' ? '您' : roles[agent] ?? '旅程助理';
  const speaker = el('p', t(speakerKey), 'speaker'); speaker.dataset.i18n = speakerKey;
  content.append(speaker);
  if (applied) {
    const note = el('aside', undefined, 'applied-preferences');
    note.dataset.rankingText = applied.message;
    note.dataset.offerIds = JSON.stringify(applied.offerIds);
    const label = el('strong', t('已套用至這些航班結果的偏好'));
    label.dataset.i18n = '已套用至這些航班結果的偏好';
    note.append(label, el('p', applied.message));
    content.append(note);
  }
  content.append(paragraph);
  article.append(content); $('messages').append(article);
  return content;
}
function scroll() { $('messages').scrollTop = $('messages').scrollHeight; }
function renderSessionContext() {
  const pendingOrigin = state?.originSuggestion?.status === 'pending' ? state.originSuggestion : null;
  $('origin-suggestion').hidden = !pendingOrigin;
  $('origin-city').textContent = pendingOrigin?.city ?? '';
  if (pendingOrigin) $('session-context').open = true;
  const trip = state?.trip ?? state?.draft ?? {};
  const discovery = state?.discovery ?? {};
  const cabinIsProfileDefault = trip.cabin && !discovery.cabinPreference && currentMember?.preferredCabin === trip.cabin;
  const cabinLabel = trip.cabin ? t({ economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙' }[trip.cabin] ?? trip.cabin) : undefined;
  const fields = [
    ['目前階段', state?.stage],
    ['出發地', trip.origin ?? discovery.originCity ?? (pendingOrigin ? `${pendingOrigin.city} (${t('待確認')})` : undefined)],
    ['目的地', trip.destination ?? discovery.destinationCity],
    ['出發日期', trip.date],
    ['回程日期', trip.returnDate],
    ['旅客人數', trip.travelers],
    ['艙等', cabinIsProfileDefault ? state?.trip ? `${cabinLabel} (${t('艙等軟性預設')})` : undefined : cabinLabel],
    ['少步行', typeof trip.lowWalking === 'boolean' ? t(trip.lowWalking ? '偏好少步行' : '未指定少步行') : undefined]
  ];
  $('session-facts').replaceChildren(...fields.flatMap(([label, value]) => [
    el('dt', t(label)), el('dd', typeof value === 'string' || typeof value === 'number' ? String(value) : t('尚未提供'))
  ]));
}
function setState(next) {
  document.querySelectorAll('.applied-preferences').forEach(note => {
    if (JSON.stringify(next?.memberRanking?.offerIds) !== note.dataset.offerIds) {
      note.replaceWith(el('p', note.dataset.rankingText));
    } else {
      note.dataset.rankingText = next.memberRanking.message;
      note.querySelector('p').textContent = next.memberRanking.message;
    }
  });
  state = next;
  renderSessionContext();
  document.querySelectorAll('[data-agent]').forEach(n => n.classList.toggle('active', n.dataset.agent === state.activeAgent));
  document.querySelectorAll('[data-stage]').forEach(n => n.classList.toggle('active', n.dataset.stage.split(' ').includes(state.stage)));
}
async function sendChat(text, originConfirmation) {
  if (voiceActive) return;
  const q = state?.quote;
  // Capture the displayed context now, not at retry time or from a newer server quote.
  const request = {
    message: text, locale: getLocale(), ...(state?.textDelivery ? { delivery: 'text' } : {}),
    ...(originConfirmation ? { originConfirmation } : {}),
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
  document.querySelectorAll('.applied-preferences').forEach(note => note.replaceWith(el('p', note.dataset.rankingText)));
  setState(result.state);
  const target = message(result.text, 'assistant', result.state.activeAgent);
  scroll();
}
const voiceController = createVoiceController({
  agentStatus,
  api, onTranscript: (text, turnId) => { voiceTranscripts.set(turnId, message(text, 'user')); scroll(); }, onResult: showResult,
  onSuperseded: turnId => {
    const content = voiceTranscripts.get(turnId);
    if (content) {
      const speaker = content.querySelector('.speaker');
      speaker.dataset.i18n = '您 · 已由後續更正取代';
      speaker.textContent = t(speaker.dataset.i18n);
    }
  },
  canStart: () => !loading && !voiceActive,
  onRecovered: data => {
    voiceTranscripts.clear();
    setState(data.state); $('messages').replaceChildren();
    for (const entry of data.history ?? []) message(entry.text, entry.role, entry.agent);
    scroll();
  },
  getDisplayedContext: () => ({
    locale: getLocale(),
    offerIds: state?.offers.map(o => o.id) ?? [],
    quoteContext: state?.quote ? { quoteId: state.quote.id, version: state.quote.version, total: state.quote.total, currency: state.quote.currency, expiresAt: state.quote.expiresAt } : null
  }),
  onActive: active => { voiceActive = active; busy(loading); }
});
$('chat-form').addEventListener('submit', e => { e.preventDefault(); if (!loading && $('message').value.trim()) sendChat($('message').value.trim()); });
$('message').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); } });
$('retry').addEventListener('click', () => { if (retryAction) run(retryAction); });
for (const action of ['confirm', 'change']) $(`origin-${action}`).addEventListener('click', () => {
  if (loading || voiceActive || state?.originSuggestion?.status !== 'pending') return;
  void sendChat(t(action === 'confirm' ? '確認出發城市' : '更改出發城市'), { id: state.originSuggestion.id, action });
});
$('member-login').addEventListener('click', () => {
  $('member-error').hidden = true;
  $('member-login-form').reset();
  $('member-dialog').showModal();
  $('member-email').focus();
});
$('member-close').addEventListener('click', () => $('member-dialog').close());
$('member-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loading || voiceActive) return;
  $('member-error').hidden = true;
  const credentials = { email: $('member-email').value.trim(), password: $('member-password').value };
  busy(true); $('member-submit').disabled = true;
  try {
    let response;
    try { response = await api('member/login', credentials); }
    catch (error) {
      if (error.code !== 'MEMBER_CONFIRMATION_REQUIRED' ||
          !window.confirm(t('登入將清除目前旅程、對話與報價。是否繼續？'))) throw error;
      response = await api('member/login', { ...credentials, confirmReset: true });
    }
    applyMemberChange(response);
    $('member-dialog').close();
    $('member-password').value = '';
  } catch (error) {
    $('member-error').textContent = error.message;
    $('member-error').hidden = false;
  } finally { busy(false); $('member-submit').disabled = false; }
});
$('member-logout').addEventListener('click', async () => {
  if (loading || voiceActive) return;
  busy(true); $('member-logout').disabled = true;
  try {
    let response;
    try { response = await api('member/logout', {}); }
    catch (error) {
      if (error.code !== 'MEMBER_CONFIRMATION_REQUIRED' ||
          !window.confirm(t('登出將清除目前旅程、對話與報價。是否繼續？'))) throw error;
      response = await api('member/logout', { confirmReset: true });
    }
    applyMemberChange(response);
    $('member-email').value = '';
    $('member-password').value = '';
  } catch (error) { $('error').querySelector('span').textContent = error.message; $('error').hidden = false; }
  finally { busy(false); $('member-logout').disabled = false; }
});
$('new-trip').addEventListener('click', () => {
  const locale = getLocale();
  let resetCompleted = false;
  void run(async () => {
    if (!resetCompleted) { await api('reset', {}); resetCompleted = true; }
    if (locale !== 'zh-TW') await api('language', { locale });
    window.location.reload();
  });
});
$('voice').addEventListener('click', () => {
  $('voice-message').textContent = t('航班與票價皆為合成示範，請以畫面內容為準。選班、報價及購買請使用文字對話。');
  $('voice-dialog').hidden = false;
});
let bootstrapData;
const memberCityLabels = { Taipei: { 'zh-TW': '台北', 'en-US': 'Taipei' },
  Tokyo: { 'zh-TW': '東京', 'en-US': 'Tokyo' }, Seoul: { 'zh-TW': '首爾', 'en-US': 'Seoul' },
  Sydney: { 'zh-TW': '雪梨', 'en-US': 'Sydney' }, Singapore: { 'zh-TW': '新加坡', 'en-US': 'Singapore' } };
function renderMember() {
  $('member-login').hidden = Boolean(currentMember);
  $('member-session').hidden = !currentMember;
  $('member-profile').hidden = !currentMember;
  for (const id of ['member-profile-name', 'member-preferences', 'member-cabin-default', 'member-home-city']) $(id).replaceChildren();
  if (!currentMember) return;
  const locale = getLocale();
  const city = memberCityLabels[currentMember.homeCity]?.[locale] ?? currentMember.homeCity;
  $('member-name').textContent = `${currentMember.displayName} · ${currentMember.personaLabel}`;
  $('member-profile-name').textContent = `${currentMember.displayName} · ${currentMember.personaLabel}`;
  $('member-preferences').replaceChildren(...(currentMember.preferenceSummary ?? currentMember.softPreferences ?? []).map(preference => el('li', preference)));
  $('member-cabin-default').textContent = currentMember.preferredCabinLabel
    ? `${t('艙等軟性預設')}：${currentMember.preferredCabinLabel}` : t('沒有預設艙等');
  if (currentMember.corporatePolicyLabel) $('member-preferences').append(
    el('li', `${currentMember.corporatePolicyLabel} (${t('僅供建議')})`));
  $('member-home-city').textContent = `${t('顯示城市')}：${city}`;
}
function applyMemberChange(data) {
  const changed = data.changed === true;
  configure({ ...bootstrapData, ...data, member: data.member ?? null,
    hasActiveJourney: data.hasActiveJourney ?? bootstrapData?.hasActiveJourney,
    history: changed ? data.history ?? [] : bootstrapData?.history ?? [] });
  if (!changed) return;
  $('messages').replaceChildren();
  message(data.originPrompt ?? t('想去哪裡走走？還沒決定也可以一起聊。請勿提供護照或信用卡資料。'));
  scroll();
}
function configure(data) {
  bootstrapData = data;
  setLocale(data.locale ?? data.state?.locale);
  $('language').value = getLocale();
  applyTranslations();
  if (Object.hasOwn(data, 'member')) currentMember = data.member;
  renderMember();
  agentStatus.refresh();
  if (data.version) { $('app-version').textContent = `v${data.version}`; $('app-version').hidden = false; }
  $('mode').textContent = t(data.mode === 'mock' ? '旅遊規劃示範' : 'AI 旅遊規劃');
  $('voice').querySelector('span:last-child').textContent = t(data.voice.available ? '選擇語音模式' : '語音尚未啟用');
  $('voice-message').textContent = t('航班與票價皆為合成示範，請以畫面內容為準。選班、報價及購買請使用文字對話。');
  voiceController.configureModes(data.voice);
  voiceController.refreshLocale();
  setState(data.state);
}
$('language').addEventListener('change', () => {
  const requested = $('language').value;
  $('language').value = getLocale();
  if (loading || voiceActive || requested === getLocale()) return;
  void run(async () => {
    const response = await api('language', { locale: requested });
    const locale = response.locale ?? response.state?.locale ?? requested;
    configure({ ...bootstrapData, ...response, locale, state: response.state ?? { ...state, locale } });
    // Refresh session state without replacing history, clearing a journey, or creating a session.
    configure(await api('bootstrap'));
  });
});
await run(async () => {
  const data = await api('bootstrap');
  configure(data);
  if (data.history?.length) $('messages').replaceChildren();
  for (const entry of data.history ?? []) message(entry.text, entry.role, entry.agent);
  if (!data.history?.length && data.originPrompt) { $('messages').replaceChildren(); message(data.originPrompt); }
  scroll();
});
