import { createWaitingNotice } from './waiting.js';
import { MAX_WAV_BYTES, readPcmWav, replayPcm, resampleMicrophone } from './speech-input.js';
import { mountVoiceAdvancedSettings } from './voice-options.js';
import { t, getLocale, applyTranslations, bindText } from './i18n.js';
export function createVoiceController({ api, onTranscript, onResult, onActive, agentStatus, getDisplayedContext, canStart = () => true, onRecovered = () => {}, onSuperseded = () => {} }) {
  const $ = id => document.getElementById(id);
  const labels = { connecting: '連線中…', listening: '聆聽中，請自然說話', thinking: '旅程團隊思考中…', speaking: '正在朗讀，可直接說話打斷', muted: '已靜音', stopped: '已停止收音', error: '語音連線已停止' };
  let socket, stream, context, source, processor, timer, playbackTimer, pendingTimer, wakePending;
  let active = false, muted = false, phase = 'stopped', generation = 0, nextAudio = 0;
  let currentTurn = null;
  let expectedSegment = 0;
  let sdkSession = false, speechInput = null, replayController, microphonePending = new Uint8Array();
  let directFinishing = false, measurementTurn = null, measurementStages = {}, packetAt = null;
  let captureResumeAt = 0;
  let advanced, wavSampleRate = 16000;
  let modes = {}, voiceConfiguration = {}, selectedMode = 'voice-live', audioEndMs = null, audioOrigin = null, captions = { user: '', assistant: '' };
  const personalOptions = document.createElement('select');
  personalOptions.id = 'personal-voice'; personalOptions.hidden = true;
  personalOptions.setAttribute('data-i18n-aria-label', '個人化聲音');
  personalOptions.setAttribute('aria-label', t('個人化聲音'));
  const personalSelect = personalOptions;
  const modeRow = document.createElement('div'); modeRow.className = 'voice-mode-row';
  $('voice-mode').before(modeRow);
  modeRow.append($('voice-mode'), personalSelect);
  const modeAvailable = () => {
    const mode = $('voice-mode').value, config = modes[mode];
    const advertisedLocales = config?.availableLocales ?? config?.supportedLocales;
    return config?.available === true && (!Array.isArray(advertisedLocales) || advertisedLocales.includes(getLocale())) &&
      config.localeAvailability?.[getLocale()]?.available !== false && (mode !== 'voice-realtime' ||
      (config.requiredModel === 'gpt-realtime-2.1' && config.configuredModel === 'gpt-realtime-2.1'));
  };
  function configureModes(voice) {
    voiceConfiguration = { ...voiceConfiguration, ...voice };
    voice = voiceConfiguration;
    modes = voice.modes ?? { 'voice-live': { available: voice.available }, 'gpt-live': { available: false } };
    if (!advanced && Object.values(modes).some(mode => mode.advancedSettings)) {
      advanced = mountVoiceAdvancedSettings({ panel: $('voice-dialog'), getSampleRate: () => wavSampleRate,
        initialOptions: { 'gpt-live': { language: getLocale() } } });
    }
    if (advanced) {
      advanced.element.hidden = !modes[$('voice-mode').value]?.advancedSettings;
      advanced.refresh(); advanced.setConnected(active);
    }
    if (voice.personalVoices) {
      const previous = personalSelect.value;
      personalSelect.replaceChildren(...voice.personalVoices.map(({ key, label }) => {
        const option = document.createElement('option'); option.value = key;
        const keyLabel = key === 'alexpun' ? '個人化男聲' : key === 'athena' ? '個人化女聲' : label;
        option.dataset.i18n = keyLabel; option.textContent = t(keyLabel);
        return option;
      }));
      personalSelect.value = voice.personalVoices.some(choice => choice.key === previous) ? previous : voice.defaultPersonalVoice;
    }
    personalOptions.hidden = $('voice-mode').value !== 'voice-live' || !personalSelect.options.length;
    if (voice.type) $('voice-mode').querySelector('[value="voice-live"]').textContent =
      `1 · Voice Live · GPT-5.4 + ${voice.type === 'azure-personal' ? 'Personal Voice' : voice.type === 'azure-custom' ? 'Professional Voice' : t('預建聲音')}`;
    else $('voice-mode').querySelector('[value="voice-live"]').textContent = t('1 · Voice Live · GPT-5.4 + 既有聲音');
    const mode = $('voice-mode').value;
    $('voice-title').textContent = mode === 'gpt-live' ? 'GPT-Live · gpt-live-1' :
      mode === 'voice-realtime' ? 'Voice Live · gpt-realtime-2.1' :
      mode === 'speech-direct' ? t('直接Azure Speech · Personal Voice') : 'Azure Voice Live';
    $('speech-options').hidden = mode !== 'speech-direct';
    const sdkSelected = mode === 'speech-direct' && $('speech-stt').value === 'sdk';
    $('speech-sdk-options').hidden = !sdkSelected;
    $('speech-wav-label').hidden = $('speech-source').value !== 'wav';
    $('speech-asr').hidden = !sdkSelected;
    $('voice-input-notice').textContent = sdkSelected && $('speech-source').value === 'wav' ?
      t('開始即同意將音訊檔傳送至雲端處理（可能計費），不啟用麥克風。') :
      t('開始即同意使用麥克風及雲端語音處理（可能計費）。');
    $('voice-input-notice').hidden = active;
    $('voice-availability').textContent = modeAvailable() ? '' :
      modes[mode]?.localeAvailability?.[getLocale()]?.reason ?? t('此語音模式尚未啟用，請選擇其他模式或聯絡管理員。');
    $('voice-availability').hidden = modeAvailable();
    $('voice-start').hidden = false;
    $('voice-start').dataset.available = String(modeAvailable());
    $('voice-start').disabled = active || !canStart() || !modeAvailable();
  }
  const sources = new Set();
  const audioQueue = [];
  let audioPump, bufferedAudioBytes = 0;
  const MAX_BUFFERED_AUDIO_BYTES = 60 * 24000 * 2;
  function pumpAudio() {
    if (!context || !active) return;
    while (audioQueue.length && audioQueue[0].at + audioQueue[0].buffer.duration <= context.currentTime + 30) {
      const { buffer, at } = audioQueue.shift();
      const node = context.createBufferSource();
      node.buffer = buffer; node.connect(context.destination); sources.add(node);
      node.onended = () => {
        bufferedAudioBytes -= buffer.length * 2;
        sources.delete(node); node.disconnect();
      };
      node.start(at);
    }
    clearTimeout(audioPump);
    if (audioQueue.length) audioPump = setTimeout(pumpAudio, 100);
  }
  const waiting = createWaitingNotice((visible, text) => { if (visible && active) $('voice-status').textContent = text; });
  function status(next, detail = '') {
    phase = next;
    const label = t(selectedMode === 'speech-direct' && next === 'speaking' ? '正在朗讀，結束後可繼續說話' : labels[next] ?? labels.stopped);
    $('voice-status').textContent = (muted && active ? `${label} · ${t('麥克風已靜音')}` : label) + (detail ? `${getLocale() === 'en-US' ? ': ' : '：'}${detail}` : '');
    $('voice-finish').disabled = !active || next !== 'listening' || directFinishing || muted;
    $('voice-mute').disabled = !active;
    $('voice-mute').textContent = t(muted ? '取消靜音' : '靜音');
    $('voice-mute').setAttribute('aria-pressed', String(muted));
  }
  function clearAudio() {
    clearTimeout(playbackTimer);
    clearTimeout(audioPump); audioQueue.length = 0; bufferedAudioBytes = 0;
    for (const node of sources) { node.onended = null; node.stop(); node.disconnect(); }
    sources.clear(); nextAudio = 0;
  }
  function stop(error, diagnostic = '') {
    generation++; active = false; onActive(false);
    replayController?.abort(); replayController = null; microphonePending = new Uint8Array();
    $('speech-options').disabled = false;
    personalOptions.disabled = false;
    advanced?.setConnected(false);
    $('voice-mode').disabled = false;
    audioEndMs = null; audioOrigin = null; captions = { user: '', assistant: '' };
    $('voice-caption').hidden = true; bindText($('voice-caption'), '');
    currentTurn = null; agentStatus.clear();
    waiting.clear();
    clearTimeout(pendingTimer); wakePending?.(); wakePending = null;
    clearTimeout(timer); directFinishing = false; clearAudio();
    processor?.port.close(); processor?.disconnect(); source?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    socket?.close(); socket = null;
    if (context && context.state !== 'closed') context.close();
    processor = source = stream = context = null;
    status(error ? 'error' : 'stopped', error || '');
    $('voice-input-notice').hidden = false;
    $('voice-start').disabled = !canStart() || !modeAvailable(); $('voice-stop').disabled = true;
    $('voice-error-details').textContent = diagnostic;
    $('voice-error').hidden = !diagnostic;
  }
  function play(base64, startMs, endMs, timing) {
    if (!context) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error(t('語音資料不完整，請停止後重新連線。'));
    if (bufferedAudioBytes + bytes.length > MAX_BUFFERED_AUDIO_BYTES) {
      const error = new Error(t('語音回覆過長，請停止後分段詢問；文字回覆仍保留。'));
      error.code = 'VOICE_PLAYBACK_LIMIT'; throw error;
    }
    const pcm = new DataView(bytes.buffer);
    nextAudio = Math.max(context.currentTime, nextAudio);
    if (selectedMode === 'gpt-live' && timing !== 'pcm-contiguous') {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs ||
          (audioEndMs !== null && startMs < audioEndMs)) throw new Error(t('GPT-Live音訊時間順序無效'));
      if (audioOrigin === null) audioOrigin = context.currentTime - startMs / 1000;
      nextAudio = Math.max(context.currentTime, audioOrigin + startMs / 1000);
      audioEndMs = endMs;
    }
    if (nextAudio - context.currentTime > 60) {
      const error = new Error(t('語音播放延遲過久，請停止後重新連線。'));
      error.code = 'VOICE_PLAYBACK_TIMING'; throw error;
    }
    if (packetAt === null) {
      packetAt = performance.now();
      const metrics = $('voice-metrics'), values = JSON.parse(metrics.dataset.i18nValues || '{}');
      bindText(metrics, (metrics.dataset.i18n || metrics.textContent) + '；播放排程 {ms} ms',
        { ...values, ms: Math.round((nextAudio - context.currentTime) * 1000) });
    }
    bufferedAudioBytes += bytes.length;
    // Bound decoded audio to one minute, but schedule only the next 30 seconds.
    for (let offset = 0; offset < bytes.length / 2; offset += 24000) {
      const length = Math.min(24000, bytes.length / 2 - offset);
      const buffer = context.createBuffer(1, length, 24000), samples = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = pcm.getInt16((offset + i) * 2, true) / 32768;
      audioQueue.push({ buffer, at: nextAudio }); nextAudio += buffer.duration;
    }
    pumpAudio();
    status('speaking');
    if (selectedMode === 'gpt-live') {
      clearTimeout(playbackTimer);
      playbackTimer = setTimeout(() => {
        if (active) status($('voice-agent').dataset.status === 'processing' ? 'thinking' : 'listening');
      }, Math.max(0, nextAudio - context.currentTime) * 1000 + 30);
    }
  }
  async function start() {
    if (active || !canStart()) return;
    if (!modeAvailable()) { configureModes({ modes }); return; }
    selectedMode = $('voice-mode').value;
    sdkSession = selectedMode === 'speech-direct' && $('speech-stt').value === 'sdk';
    speechInput = null;
    $('voice-error').hidden = true;
    active = true; muted = false; const current = ++generation;
    currentTurn = null; agentStatus.clear();
    measurementTurn = null; measurementStages = {}; packetAt = null; directFinishing = false;
    bindText($('voice-metrics'), '等待回應時間');
    $('voice-metrics').parentElement.hidden = true;
    $('voice-input-notice').hidden = true;
    onActive(true); status('connecting');
    $('voice-mode').disabled = true;
    $('speech-options').disabled = true;
    personalOptions.disabled = true;
    $('voice-start').disabled = true; $('voice-stop').disabled = false;
    try {
      // A stopped voice turn may still be finishing safely on the server. Do not reopen its lock.
      let bootstrap = await api('bootstrap'), waited = false;
      const deadline = Date.now() + 180000;
      while (bootstrap.pending) {
        if (current !== generation) return;
        if (Date.now() >= deadline) throw new Error(t('上一段仍在處理，請稍後再開始語音；原請求未取消。'));
        if (!waited) { status('thinking', t('等待上一段完成，尚未收音')); waiting.start(); }
        waited = true;
        await new Promise(resolve => { wakePending = resolve; pendingTimer = setTimeout(resolve, 1000); });
        wakePending = null;
        if (current !== generation) return;
        bootstrap = await api('bootstrap');
      }
      if (current !== generation) return;
      waiting.clear();
      configureModes(bootstrap.voice);
      if (!modeAvailable()) throw new Error(t('此語音模式目前無法使用，請選擇其他模式。'));
      let wav;
      if (sdkSession) {
        if (!modes['speech-direct']?.sttModes?.includes('sdk')) throw new Error(t('連續辨識目前無法使用，請選擇其他辨識方式或聯絡管理員。'));
        speechInput = { stt: 'sdk', source: $('speech-source').value, sampleRate: 16000,
          silenceMs: Number($('speech-silence').value), chunkBytes: advanced ? advanced.getChunkBytes(16000) : Number($('speech-chunk').value),
          phrases: [...new Set($('speech-phrases').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))] };
        if (!Number.isInteger(speechInput.chunkBytes) || speechInput.chunkBytes < 320 || speechInput.chunkBytes > 6400 ||
            speechInput.chunkBytes % 2 || speechInput.phrases.length > 100 || speechInput.phrases.some(s => s.length > 100)) {
          throw new Error(t('音訊區塊大小須為320–6400的偶數；提示詞最多100詞，每詞100字。'));
        }
        if (speechInput.source === 'wav') {
          const file = $('speech-wav').files[0];
          if (!file || file.size > MAX_WAV_BYTES) throw new Error(t('請先選擇120秒內的8／16 kHz PCM16單聲道WAV。'));
          wav = readPcmWav(await file.arrayBuffer());
          speechInput.sampleRate = wav.sampleRate;
          wavSampleRate = wav.sampleRate;
          if (advanced) {
            $('speech-source').dispatchEvent(new Event('change'));
            speechInput.chunkBytes = advanced.getChunkBytes(wav.sampleRate);
          }
        }
        $('speech-finals').replaceChildren(); bindText($('speech-interim'), '');
        $('speech-events').textContent = ''; bindText($('speech-replay-progress'), '');
        microphonePending = new Uint8Array();
      }
      if (current !== generation) return;
      onRecovered(bootstrap);
      status('connecting');
      context = new AudioContext({ sampleRate: 24000 }); await context.resume();
      if (current !== generation) return;
      if (context.sampleRate !== 24000) throw new Error(t('此瀏覽器不支援必要的 24 kHz 音訊，請使用新版 Edge 或 Chrome。'));
      if (!wav) {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (current !== generation) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      await context.audioWorklet.addModule('/audio-worklet.js');
      if (current !== generation) return;
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, 'microphone-pcm', { processorOptions: {
        sdk: sdkSession, timestamped: ['voice-live', 'voice-realtime', 'gpt-live'].includes(selectedMode)
      } });
      source.connect(processor); processor.connect(context.destination);
      }
      const ticket = await api('voice/session', {
        ...getDisplayedContext(), locale: getLocale(), ...(bootstrap.voice.modes ? { mode: selectedMode } : {}),
        ...(selectedMode === 'voice-live' && !personalOptions.hidden ? { personalVoiceKey: personalSelect.value } : {}),
        ...(advanced && modes[selectedMode]?.advancedSettings ? { voiceOptions: { [selectedMode]: advanced.getOptions()[selectedMode] } } : {}),
        ...(sdkSession ? { speechInput } : {})
      });
      if (current !== generation) return;
      const url = new URL(ticket.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, [ticket.protocol, ticket.nonce]);
      timer = setTimeout(() => stop(t('連線逾時，請重新連線')), 25000);
      let captureCredit = 12288, captureCreditAt = performance.now(), captureBurst = false;
      let inputFlow = false, sentInputBytes = 0, acknowledgedInputBytes = 0;
      let inputAckAt = performance.now(), pendingInputAt = null, inputAckEvents = 0, turnBoundResume = false;
      if (processor) processor.port.onmessage = event => {
        if (event.data?.type === 'flushed') {
          if (current === generation && directFinishing && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'finish' })); status('thinking'); waiting.start();
          }
          return;
        }
        if (current === generation && socket?.readyState === WebSocket.OPEN && !muted && ['listening', 'thinking', 'speaking'].includes(phase)) {
          const capturedAt = event.data?.capturedAt;
          if (typeof capturedAt === 'number') {
            if (!Number.isFinite(capturedAt) || capturedAt < captureResumeAt) return;
            if (context.currentTime - capturedAt > 1) {
              captureResumeAt = context.currentTime;
              console.warn(JSON.stringify({ code: 'VOICE_CAPTURE_DELAY', mode: selectedMode }));
              status(phase, t('收音曾暫停，請再說一次，並保持網頁在前景。'));
              return;
            }
          }
          const audio = event.data?.audio ?? event.data;
          if (selectedMode === 'voice-live' || selectedMode === 'foundry-voice-agent') {
            const now = performance.now();
            captureCredit = Math.min(12288, captureCredit + Math.max(0, now - captureCreditAt) * 48);
            captureCreditAt = now;
            if (audio.byteLength > captureCredit || socket.bufferedAmount + audio.byteLength > 12288 ||
                inputFlow && sentInputBytes - acknowledgedInputBytes + audio.byteLength > 12288) {
              if (inputFlow && sentInputBytes > acknowledgedInputBytes && now - inputAckAt > 2000) {
                if (selectedMode === 'foundry-voice-agent') socket.send(JSON.stringify({ type: 'inputFlowDiagnostic', sentBytes: sentInputBytes,
                  acknowledgedBytes: acknowledgedInputBytes, ackEvents: inputAckEvents,
                  lastAckAgeMs: Math.round(now - inputAckAt),
                  pendingAgeMs: Math.round(now - (pendingInputAt ?? now)), bufferedBytes: socket.bufferedAmount }));
                return stop(t('收音傳輸確認中斷，已停止，避免卡住或累積音訊。'), 'VOICE_INPUT_ACK_TIMEOUT');
              }
              if (!captureBurst) {
                console.warn(JSON.stringify({ code: 'VOICE_CAPTURE_BURST', mode: selectedMode,
                  packetBytes: audio.byteLength, availableBytes: Math.floor(captureCredit),
                  bufferedBytes: socket.bufferedAmount, unacknowledgedBytes: sentInputBytes - acknowledgedInputBytes }));
                status(phase, t('收音傳送曾延遲，已略過積壓音訊；請再說一次。'));
              }
              captureBurst = true;
              return;
            }
            captureCredit -= audio.byteLength;
            captureBurst = false;
          }
          if (selectedMode === 'speech-direct' && phase !== 'listening') return;
          if (socket.bufferedAmount > 480000) return stop(t('網路傳輸過慢，已停止收音'));
          if (sdkSession) {
            const converted = resampleMicrophone(audio);
            const combined = new Uint8Array(microphonePending.length + converted.length);
            combined.set(microphonePending); combined.set(converted, microphonePending.length);
            let offset = 0;
            while (combined.length - offset >= speechInput.chunkBytes) {
              socket.send(combined.slice(offset, offset + speechInput.chunkBytes)); offset += speechInput.chunkBytes;
            }
            microphonePending = combined.slice(offset);
          } else {
            if (['voice-live', 'foundry-voice-agent'].includes(selectedMode) && sentInputBytes === acknowledgedInputBytes) {
              inputAckAt = performance.now(); pendingInputAt = inputAckAt;
            }
            socket.send(audio);
            if (['voice-live', 'foundry-voice-agent'].includes(selectedMode)) sentInputBytes += audio.byteLength;
          }
        }
      };
      socket.onmessage = event => {
        if (current !== generation) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') {
            turnBoundResume = data.turnBoundResume === true;
            if (['voice-live', 'foundry-voice-agent'].includes(selectedMode) && data.inputFlow !== undefined) {
              if (data.inputFlow?.maxUnackedBytes !== 12288) throw new Error(t('收音流量確認設定無效，已停止連線。'));
              inputFlow = true; inputAckAt = performance.now();
            }
            captureResumeAt = context?.currentTime ?? 0;
            clearTimeout(timer); status('listening');
            if (wav) {
              replayController = new AbortController();
              const signal = replayController.signal;
              void replayPcm({ ...wav, chunkBytes: speechInput.chunkBytes, signal,
                canSend: () => current === generation && phase === 'listening' && !muted && socket?.readyState === WebSocket.OPEN,
                send: packet => {
                  if (socket.bufferedAmount > 480000) throw new Error(t('串流重播背壓過高，已停止。'));
                  socket.send(packet);
                },
                onProgress: ms => { bindText($('speech-replay-progress'), '重播進度 {elapsed}／{total} ms', { elapsed: Math.round(ms), total: Math.round(wav.durationMs) }); }
              }).then(() => {
                if (current === generation) socket.send(JSON.stringify({ type: 'input_eof' }));
              }).catch(error => { if (current === generation && !signal.aborted) stop(error.message); });
            }
          }
          else if (data.type === 'inputAudioAck' && ['voice-live', 'foundry-voice-agent'].includes(selectedMode) && inputFlow) {
            if (!Number.isSafeInteger(data.receivedBytes) || data.receivedBytes < acknowledgedInputBytes ||
                data.receivedBytes > sentInputBytes) throw new Error(t('收音傳輸確認無效，已停止連線。'));
            if (data.receivedBytes > acknowledgedInputBytes) inputAckAt = performance.now();
            inputAckEvents++;
            acknowledgedInputBytes = data.receivedBytes;
            if (acknowledgedInputBytes === sentInputBytes) pendingInputAt = null;
          }
          else if (data.type === 'asr' && sdkSession) {
            const known = ['session_started', 'recognizing', 'recognized', 'no_match', 'input_eof', 'session_stopped', 'canceled'];
            if (!known.includes(data.kind) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) throw new Error(t('SDK事件格式無效'));
            if (data.kind !== 'recognizing') {
              const event = document.createElement('li');
              const eventNames = { session_started: '連線完成', recognized: '辨識完成', no_match: '未辨識到語音',
                input_eof: '檔案傳送完成', session_stopped: '辨識結束', canceled: '辨識已停止' };
              bindText(event, `${eventNames[data.kind]} · {elapsed} ms`, { elapsed: data.elapsedMs });
              if ($('speech-events').children.length >= 200) $('speech-events').firstElementChild.remove();
              $('speech-events').append(event);
            }
            if (['recognizing', 'recognized'].includes(data.kind)) {
              if (typeof data.text !== 'string' || data.text.length > 2000) throw new Error(t('SDK辨識文字無效'));
              if (data.kind === 'recognizing') bindText($('speech-interim'), '辨識中：{text}', { text: data.text });
              else {
                if ($('speech-finals').children.length >= 100) throw new Error(t('SDK最終片段超過上限'));
                const item = document.createElement('li');
                bindText(item, '第{sequence}段 · 起點 {offset} ms · 長度 {duration} ms · 接收 {elapsed} ms：{text}', {
                  sequence: data.sequence, offset: data.offsetMs, duration: data.durationMs, elapsed: data.elapsedMs, text: data.text
                });
                $('speech-finals').append(item); bindText($('speech-interim'), '');
              }
            }
          }
          else if (data.type === 'measurement') {
            const stages = ['input_start', 'input_end', 'endpoint', 'transcript', 'stt_dispatch', 'frontend_dispatch', 'delegation',
              'backend_dispatch', 'backend_result', 'tts_dispatch', 'tts_first_byte', 'frontend_response_dispatch', 'commentary_dispatch', 'first_audio', 'frontend_audio'];
            if (data.mode !== selectedMode || !Number.isInteger(data.turn) || !stages.includes(data.stage) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return;
            if (measurementTurn !== data.turn) { measurementTurn = data.turn; measurementStages = {}; packetAt = null; }
            measurementStages[data.stage] = data.elapsedMs;
            $('voice-metrics').parentElement.hidden = false;
            const duration = (from, to) => measurementStages[from] !== undefined && measurementStages[to] !== undefined &&
              measurementStages[to] >= measurementStages[from] ? `${Math.round(measurementStages[to] - measurementStages[from])} ms` : '—';
            bindText($('voice-metrics'), '語音辨識 {stt}；代理處理 {agent}；語音合成 {tts}；回答後首段音訊 {audio}', {
              stt: duration('stt_dispatch', 'transcript'), agent: duration('backend_dispatch', 'backend_result'),
              tts: duration('tts_dispatch', 'tts_first_byte'), audio: duration('backend_result', 'first_audio')
            });
          }
          else if (data.type === 'state') {
            if (sdkSession && data.state !== 'listening') {
              microphonePending = new Uint8Array(); processor?.port.postMessage({ type: 'reset' });
            }
            if (selectedMode === 'speech-direct' && data.state === 'listening') directFinishing = false;
            if (data.state === 'thinking' && phase !== 'thinking') waiting.start();
            status(data.state);
          }
          else if (data.type === 'transcript') {
            clearAudio();
            expectedSegment = 0;
            currentTurn = data.turnId; agentStatus.start(currentTurn);
            waiting.start(); onTranscript(data.text, data.turnId);
          }
          else if (data.type === 'progress') { agentStatus.update(data.turnId, data.role); }
          else if (data.type === 'result') {
            if (data.turnId !== currentTurn) return;
            waiting.clear();
            agentStatus.update(currentTurn, data.result.state.activeAgent, 'completed');
            status('thinking', t('已取得回答，準備朗讀'));
            onResult(data.result);
            socket.send(JSON.stringify({ type: 'displayed', turnId: data.turnId }));
          } else if (data.type === 'audio') play(data.audio, data.startMs, data.endMs, data.timing);
          else if (data.type === 'liveCaption' && ['gpt-live', 'voice-realtime'].includes(selectedMode)) {
            if (!['user', 'assistant'].includes(data.speaker) || typeof data.text !== 'string') throw new Error(t('GPT-Live字幕無效'));
            captions[data.speaker] = (captions[data.speaker] + data.text).slice(-1000);
            $('voice-caption').hidden = false;
            bindText($('voice-caption'), data.speaker === 'user' ? '即時辨識：{text}' : '語音字幕：{text}', { text: captions[data.speaker] });
          } else if (data.type === 'taskError') {
            if (currentTurn && data.turnId !== currentTurn) { status(phase, data.message); return; }
            clearAudio(); currentTurn = null; waiting.clear(); agentStatus.clear();
            status('listening', data.message);
          }
          else if (data.type === 'interrupted') {
            waiting.clear(); clearAudio(); status('listening');
            if ($('voice-agent').dataset.status !== 'processing') { currentTurn = null; agentStatus.clear(); }
          }
          else if (data.type === 'superseded') {
            onSuperseded(data.turnId);
            if (data.turnId === currentTurn) { currentTurn = null; agentStatus.clear(); }
            status('thinking', t('已收到更正，改依最新內容處理'));
          }
          else if (data.type === 'audioSegmentDone') {
            if (data.turnId !== currentTurn || data.segment !== expectedSegment) return;
            expectedSegment++;
            const spokenTurn = currentTurn;
            clearTimeout(playbackTimer);
            playbackTimer = setTimeout(() => {
              if (active && currentTurn === spokenTurn && socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'segmentPlayed', turnId: spokenTurn, segment: data.segment }));
              }
            }, Math.max(0, nextAudio - context.currentTime) * 1000 + 30);
          }
          else if (data.type === 'audioDone') {
            if (data.turnId && data.turnId !== currentTurn) return;
            if ($('voice-agent').dataset.status !== 'completed') return;
            const spokenTurn = currentTurn;
            clearTimeout(playbackTimer);
            playbackTimer = setTimeout(() => {
              if (active && currentTurn === spokenTurn) {
                if (selectedMode === 'speech-direct') {
                  socket?.send(JSON.stringify({ type: 'resume', ...(turnBoundResume ? { turnId: spokenTurn } : {}) })); directFinishing = false;
                }
                status('listening'); currentTurn = null; agentStatus.clear();
              }
            }, Math.max(0, nextAudio - context.currentTime) * 1000 + 30);
          } else if (data.type === 'error') {
            const messages = {
              SPEECH_SDK_AUTH: '語音服務驗證失敗，請聯絡管理員確認存取權限。',
              SPEECH_SDK_CONNECTION: '無法連線至語音服務，請確認網路後重試。',
              SPEECH_SDK_TIMEOUT: '語音服務連線逾時，請稍後重試。',
              SPEECH_SDK_START: '無法啟動語音辨識，請重新連線；若持續發生請聯絡管理員。',
              SPEECH_SDK_CANCELED: '語音辨識已中斷，請重新連線。',
              SPEECH_SDK_QUEUE: '有太多語音片段等待處理，請停止後分段說明。',
              SPEECH_TRANSACTION: '請先停止語音，再用文字完成選班、報價及購買。'
            };
            stop(messages[data.code] ? t(messages[data.code]) : data.message, `${data.code} · ${data.correlationId}`);
          }
        } catch (error) {
          if (error.code) console.error(JSON.stringify({ code: error.code, mode: selectedMode }));
          stop(error.message, error.code ?? '');
        }
      };
      socket.onerror = () => { if (current === generation) stop(t('無法建立安全語音連線；請檢查後端與 Azure 身分。')); };
      socket.onclose = () => { if (current === generation) stop(t('語音連線已中斷，文字紀錄保留。')); };
    } catch (error) {
      if (current !== generation) return;
      stop(error.code === 'SESSION_BUSY' ? t('上一段對話還在處理，完成後再按開始語音。') :
        error.name === 'NotAllowedError' ? t('麥克風權限被拒絕，請允許此網站使用麥克風後重試。') :
        error.name === 'NotFoundError' ? t('找不到麥克風，請連接裝置後重試。') : error.message, error.diagnostic);
    }
  }
  function finishRecording() {
    if (!active || muted || selectedMode !== 'speech-direct' || phase !== 'listening' || directFinishing) return;
    directFinishing = true; $('voice-finish').disabled = true;
    processor?.port.postMessage({ type: 'flush' });
  }
  $('voice-finish').addEventListener('click', finishRecording);
  $('voice-panel-height').addEventListener('input', event => {
    $('voice-dialog').style.height = `${event.target.value}px`;
  });
  $('conversation-expand').addEventListener('click', () => {
    const expanded = document.querySelector('.layout').classList.toggle('expanded');
    $('conversation-expand').setAttribute('aria-pressed', String(expanded));
    $('conversation-expand').textContent = t(expanded ? '還原對話寬度' : '放大對話寬度');
  });
  $('voice-start').addEventListener('click', start);
  $('voice-stop').addEventListener('click', () => stop());
  $('voice-mute').addEventListener('click', () => {
    if (!active) return;
    muted = !muted; stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    if (selectedMode === 'speech-direct') { directFinishing = false; microphonePending = new Uint8Array(); processor?.port.postMessage({ type: 'reset' }); }
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'mute', muted }));
    status(phase);
  });
  $('close-voice').addEventListener('click', () => { stop(); $('voice-dialog').hidden = true; });
  window.addEventListener('pagehide', () => stop());
  $('voice-mode').addEventListener('change', () => { if (!active) configureModes({ modes }); });
  for (const id of ['speech-stt', 'speech-source']) $(id).addEventListener('change', () => { if (!active) configureModes({ modes }); });
  function refreshLocale() {
    applyTranslations($('voice-dialog'));
    advanced?.setLocale(getLocale());
    $('conversation-expand').textContent = t(document.querySelector('.layout').classList.contains('expanded') ? '還原對話寬度' : '放大對話寬度');
    status(phase);
    // Explicit bindings translate labels around recognition text, never the text itself.
  }
  return { stop, start, configureModes, refreshLocale };
}
