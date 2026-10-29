import {
  chunkBytesForDuration,
  createVoiceOptionsState,
  freezeVoiceOptions,
  VOICE_OPTION_CHOICES
} from '../lib/voice-options.js';
import { t, bindText, applyTranslations } from './i18n.js';

const labelText = (document, text) => bindText(document.createElement('span'), text);

const makeSelect = (document, id, label, choices, selected) => {
  const wrapper = document.createElement('label');
  wrapper.htmlFor = id;
  wrapper.append(labelText(document, label));
  const select = document.createElement('select');
  select.id = id;
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = String(choice.value);
    bindText(option, choice.label);
    select.append(option);
  }
  select.value = String(selected);
  wrapper.append(select);
  return { wrapper, control: select };
};

const selectChoices = values => values.map(value => ({ value, label: `${value} ms` }));

const makeCheckbox = (document, id, label, checked) => {
  const wrapper = document.createElement('label');
  wrapper.className = 'voice-advanced-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  wrapper.append(input, labelText(document, label));
  return { wrapper, control: input };
};

const makeTextarea = (document, id, label, value = '') => {
  const wrapper = document.createElement('label');
  wrapper.htmlFor = id;
  wrapper.append(labelText(document, label));
  const textarea = document.createElement('textarea');
  textarea.id = id;
  textarea.rows = 3;
  textarea.maxLength = 10100;
  textarea.value = value;
  wrapper.append(textarea);
  return { wrapper, control: textarea };
};

/** Mounts the one collapsed advanced panel, reusing the existing Speech SDK controls. */
export function mountVoiceAdvancedSettings({
  panel,
  modeSelect = panel?.querySelector('#voice-mode'),
  speechSttSelect = panel?.querySelector('#speech-stt'),
  sourceSelect = panel?.querySelector('#speech-source'),
  speechWavInput = panel?.querySelector('#speech-wav'),
  initialOptions,
  onChange = () => {},
  getSampleRate = () => 16000
}) {
  if (!panel || !modeSelect || !speechSttSelect) throw new TypeError(t('進階語音設定無效，請檢查選項；提示詞最多100詞，每詞100字。'));
  const document = panel.ownerDocument;
  const legacyDetails = panel.querySelector('#speech-sdk-options details');
  if (!legacyDetails) throw new Error(t('進階語音設定無效，請檢查選項；提示詞最多100詞，每詞100字。'));
  const state = createVoiceOptionsState(initialOptions);
  const root = document.createElement('details');
  root.id = 'voice-advanced';
  const summary = document.createElement('summary');
  bindText(summary, '進階設定');
  root.append(summary);

  const sections = {};
  const addSection = (key, title) => {
    const section = document.createElement('section');
    section.className = 'voice-advanced-section';
    section.dataset.mode = key;
    section.setAttribute('data-i18n-aria-label', title);
    section.setAttribute('aria-label', t(title));
    const heading = document.createElement('h4');
    bindText(heading, title);
    section.append(heading);
    sections[key] = section;
    root.append(section);
    return section;
  };

  const liveSection = addSection('voice-live', 'Voice Live（Azure Speech）');
  const liveVad = makeSelect(document, 'voice-live-vad-silence', '停頓後結束語句', selectChoices(VOICE_OPTION_CHOICES.voiceLiveVadMs), state['voice-live'].vadSilenceMs);
  const livePhrases = makeTextarea(document, 'voice-live-phrase-list', '辨識提示詞（選填，每行一詞，最多100詞、每詞100字）', state['voice-live'].phraseList.join('\n'));
  const liveNoise = makeCheckbox(document, 'voice-live-noise-reduction', 'Azure 語音降噪', state['voice-live'].noiseReduction);
  const liveEcho = makeCheckbox(document, 'voice-live-echo-cancellation', 'Azure 回音消除', state['voice-live'].echoCancellation);
  liveSection.append(liveVad.wrapper, livePhrases.wrapper, liveNoise.wrapper, liveEcho.wrapper);

  const realtimeSection = addSection('voice-realtime', 'Voice Live（原生 Realtime）');
  const realtimeVad = makeSelect(document, 'voice-realtime-vad-silence', '停頓後結束語句', selectChoices(VOICE_OPTION_CHOICES.voiceLiveVadMs), state['voice-realtime'].vadSilenceMs);
  const realtimeNoise = makeCheckbox(document, 'voice-realtime-noise-reduction', 'Azure 語音降噪', state['voice-realtime'].noiseReduction);
  const realtimeEcho = makeCheckbox(document, 'voice-realtime-echo-cancellation', 'Azure 回音消除', state['voice-realtime'].echoCancellation);
  realtimeSection.append(realtimeVad.wrapper, realtimeNoise.wrapper, realtimeEcho.wrapper);

  const gptSection = addSection('gpt-live', 'GPT-Live');
  const gptLanguage = makeSelect(document, 'gpt-live-language', '語音語言', [
    { value: 'zh-TW', label: '繁體中文（台灣）' }, { value: 'en-US', label: 'English (US)' }
  ], state['gpt-live'].language);
  const gptStyle = makeSelect(document, 'gpt-live-style', '說話風格', [
    { value: 'warm', label: '溫和安心' }, { value: 'friendly', label: '親切自然' },
    { value: 'concise', label: '簡潔直接' }, { value: 'professional', label: '沉穩專業' }
  ], state['gpt-live'].style);
  const gptTaiwanWording = makeCheckbox(document, 'gpt-live-taiwan-wording', '台灣用語與地名', state['gpt-live'].taiwanWording);
  const fixedVoice = document.createElement('p');
  bindText(fixedVoice, '輸出聲音：marin（已核驗）；其他音色尚未核實。語言偏好不保證口音。');
  gptSection.append(gptLanguage.wrapper, gptStyle.wrapper, gptTaiwanWording.wrapper, fixedVoice);

  const restSection = addSection('speech-direct-rest', '直接 Azure Speech REST');
  const restVad = makeSelect(document, 'speech-rest-vad-silence', '停頓後送出', selectChoices(VOICE_OPTION_CHOICES.restVadMs), state['speech-direct'].rest.vadSilenceMs);
  restSection.append(restVad.wrapper);

  const sdkSection = addSection('speech-direct-sdk', '直接 Azure Speech SDK');
  const chunkHelp = document.createElement('p');
  bindText(chunkHelp, '區塊長度只控制傳送節奏，不是 VAD；麥克風固定 16 kHz，WAV 沿用檔案取樣率。');
  const sdkControls = [...legacyDetails.children].filter(child => child.tagName !== 'SUMMARY');
  sdkSection.append(...sdkControls);
  sdkSection.append(chunkHelp);
  legacyDetails.remove();
  const legacyChunkInput = sdkSection.querySelector('#speech-chunk');
  let chunkControl = legacyChunkInput;
  if (legacyChunkInput) {
    const label = legacyChunkInput.closest('label');
    chunkControl = document.createElement('select');
    chunkControl.id = 'speech-chunk';
    for (const value of VOICE_OPTION_CHOICES.sdkChunkMs) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value} ms`;
      chunkControl.append(option);
    }
    chunkControl.value = String(state['speech-direct'].sdk.chunkMs);
    if (label) label.replaceChildren(labelText(document, '音訊區塊長度 '), chunkControl);
    else legacyChunkInput.replaceWith(chunkControl);
  }
  let chunkTouched = false;
  const markChunkTouched = () => { chunkTouched = true; };
  chunkControl?.addEventListener('change', markChunkTouched);
  const sdkPhrase = sdkSection.querySelector('#speech-phrases');
  if (sdkPhrase) sdkPhrase.value = state['speech-direct'].sdk.phraseList.join('\n');
  const sdkSilence = sdkSection.querySelector('#speech-silence');
  if (sdkSilence) sdkSilence.value = String(state['speech-direct'].sdk.segmentationMs);
  const sdkSilenceLabel = sdkSilence?.closest('label');
  if (sdkSilenceLabel) sdkSilenceLabel.replaceChildren(labelText(document, '分段靜音時間 '), sdkSilence);
  const sdkPhraseLabel = sdkPhrase?.closest('label');
  if (sdkPhraseLabel) sdkPhraseLabel.replaceChildren(labelText(document, '辨識提示詞（選填，每行一詞，最多100詞、每詞100字）'), sdkPhrase);

  const validationMessage = document.createElement('p');
  validationMessage.className = 'voice-advanced-error';
  validationMessage.setAttribute('role', 'alert');
  validationMessage.hidden = true;
  root.append(validationMessage);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'voice-advanced-reset';
  bindText(reset, '還原所有進階設定預設值');
  root.append(reset);
  let stylesheet = document.head.querySelector('link[data-voice-advanced]');
  const ownsStylesheet = !stylesheet;
  if (!stylesheet) {
    stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/voice-options.css';
    stylesheet.dataset.voiceAdvanced = 'true';
    document.head.append(stylesheet);
  }

  (panel.querySelector('.voice-panel-details') ?? panel).append(root);

  const fields = [liveVad.control, livePhrases.control, liveNoise.control, liveEcho.control,
    realtimeVad.control, realtimeNoise.control, realtimeEcho.control, gptLanguage.control, gptStyle.control,
    gptTaiwanWording.control, restVad.control, reset, ...sdkSection.querySelectorAll('input, select, textarea, button')];
  const read = () => {
    const phrases = textarea => textarea.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return {
      'voice-live': {
        vadSilenceMs: Number(liveVad.control.value), phraseList: phrases(livePhrases.control),
        noiseReduction: liveNoise.control.checked, echoCancellation: liveEcho.control.checked
      },
      'voice-realtime': {
        vadSilenceMs: Number(realtimeVad.control.value), noiseReduction: realtimeNoise.control.checked,
        echoCancellation: realtimeEcho.control.checked
      },
      'gpt-live': {
        language: gptLanguage.control.value, taiwanWording: gptTaiwanWording.control.checked,
        style: gptStyle.control.value, voice: 'marin'
      },
      'speech-direct': {
        rest: { vadSilenceMs: Number(restVad.control.value) },
        sdk: {
          segmentationMs: Number(sdkSilence?.value ?? 700), phraseList: phrases(sdkPhrase),
          chunkMs: Number(chunkControl?.value ?? state['speech-direct'].sdk.chunkMs)
        }
      }
    };
  };
  const refresh = () => {
    const mode = modeSelect.value;
    for (const [key, section] of Object.entries(sections)) {
      section.hidden = key === 'speech-direct-rest' ? mode !== 'speech-direct' || speechSttSelect.value !== 'rest' :
        key === 'speech-direct-sdk' ? mode !== 'speech-direct' || speechSttSelect.value !== 'sdk' : key !== mode;
    }
  };
  const selectedOptions = () => {
    const mode = modeSelect.value, options = read();
    try {
      return freezeVoiceOptions({ [mode]: mode === 'speech-direct'
        ? { [speechSttSelect.value]: options[mode][speechSttSelect.value] } : options[mode] });
    } catch {
      throw new TypeError(t('進階語音設定無效，請檢查選項；提示詞最多100詞，每詞100字。'));
    }
  };
  const emit = () => {
    try {
      const options = selectedOptions();
      validationMessage.hidden = true;
      validationMessage.textContent = '';
      onChange(options, { mode: modeSelect.value, stt: speechSttSelect.value });
    } catch (error) {
      validationMessage.textContent = t('進階語音設定無效，請檢查選項；提示詞最多100詞，每詞100字。');
      validationMessage.hidden = false;
    }
  };
  const setConnected = value => {
    for (const field of fields) field.disabled = Boolean(value);
    gptLanguage.control.disabled = true;
  };
  const update = () => { refresh(); emit(); };
  const resetDefaults = () => {
    const defaults = createVoiceOptionsState();
    liveVad.control.value = String(defaults['voice-live'].vadSilenceMs);
    livePhrases.control.value = '';
    liveNoise.control.checked = defaults['voice-live'].noiseReduction;
    liveEcho.control.checked = defaults['voice-live'].echoCancellation;
    realtimeVad.control.value = String(defaults['voice-realtime'].vadSilenceMs);
    realtimeNoise.control.checked = defaults['voice-realtime'].noiseReduction;
    realtimeEcho.control.checked = defaults['voice-realtime'].echoCancellation;
    gptLanguage.control.value = panel.ownerDocument.documentElement.lang === 'en-US' ? 'en-US' : defaults['gpt-live'].language;
    gptStyle.control.value = defaults['gpt-live'].style;
    gptTaiwanWording.control.checked = defaults['gpt-live'].taiwanWording;
    restVad.control.value = String(defaults['speech-direct'].rest.vadSilenceMs);
    if (sdkSilence) sdkSilence.value = String(defaults['speech-direct'].sdk.segmentationMs);
    if (sdkPhrase) sdkPhrase.value = '';
    if (chunkControl) chunkControl.value = String(sourceSelect?.value === 'wav' && getSampleRate() === 8000 ? 80 : 40);
    chunkTouched = false;
    update();
  };
  for (const field of fields) if (field !== reset) field.addEventListener('change', update);
  for (const field of [livePhrases.control, sdkPhrase]) field?.addEventListener('input', emit);
  modeSelect.addEventListener('change', update);
  speechSttSelect.addEventListener('change', update);
  const syncDefaultChunk = () => {
    if (chunkTouched || !chunkControl) return;
    const sampleRate = sourceSelect?.value === 'wav' ? getSampleRate() : 16000;
    chunkControl.value = String(sampleRate === 8000 ? 80 : 40);
    emit();
  };
  const onWavChange = () => { refresh(); syncDefaultChunk(); };
  sourceSelect?.addEventListener('change', syncDefaultChunk);
  speechWavInput?.addEventListener('change', onWavChange);
  reset.addEventListener('click', resetDefaults);
  refresh();
  setConnected(false);
  emit();

  return {
    element: root,
    getOptions: selectedOptions,
    getChunkBytes: sampleRate => chunkBytesForDuration(Number(chunkControl?.value ?? 40), sampleRate),
    setConnected,
    refresh,
    setLocale(locale) {
      gptLanguage.control.value = locale;
      applyTranslations(root);
      emit();
    },
    reset: resetDefaults,
    dispose() {
      for (const field of fields) field.removeEventListener('change', update);
      for (const field of [livePhrases.control, sdkPhrase]) field?.removeEventListener('input', emit);
      modeSelect.removeEventListener('change', update);
      speechSttSelect.removeEventListener('change', update);
      reset.removeEventListener('click', resetDefaults);
      chunkControl?.removeEventListener('change', markChunkTouched);
      sourceSelect?.removeEventListener('change', syncDefaultChunk);
      speechWavInput?.removeEventListener('change', onWavChange);
      root.remove();
      if (ownsStylesheet) stylesheet.remove();
    }
  };
}
