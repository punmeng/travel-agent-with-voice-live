import { createWaitingNotice } from './waiting.js';
import { MAX_WAV_BYTES, readPcmWav, replayPcm, resampleMicrophone } from './speech-input.js';
export function createVoiceController({ api, onTranscript, onResult, onActive, agentStatus, getDisplayedContext, canStart = () => true, onRecovered = () => {}, onSuperseded = () => {} }) {
  const $ = id => document.getElementById(id);
  const labels = { connecting: '連線中…', listening: '聆聽中，請自然說話', thinking: '旅程團隊思考中…', speaking: '正在朗讀，可直接說話打斷', muted: '已靜音', stopped: '已停止收音', error: '語音連線已停止' };
  let socket, stream, context, source, processor, timer, playbackTimer, pendingTimer, wakePending;
  let active = false, muted = false, phase = 'stopped', generation = 0, nextAudio = 0;
  let currentTurn = null;
  let sdkSession = false, speechInput = null, replayController, microphonePending = new Uint8Array();
  let directFinishing = false, measurementTurn = null, measurementStages = {}, packetAt = null;
  let modes = {}, selectedMode = 'voice-live', audioEndMs = null, audioOrigin = null, captions = { user: '', assistant: '' };
  const modeDescriptions = {
    'voice-live': 'Voice Live內Azure Speech zh-TW逐句辨識 → GPT-5.4四代理 → 確切文字朗讀。保留既有設定的Personal Voice與發音規則；交易仍由後端驗證。',
    'speech-direct': '直接Azure Speech REST：聲學VAD偵測聲音，停頓約1秒自動送出；可選擇手動提早送出。zh-TW STT → 同一GPT-5.4四代理 → SSML Personal Voice，完全不使用Voice Live。不是語意VAD；半雙工，等待與朗讀時不送音訊，不支援自動插話、phrase list、自動語言偵測或伺服器回音消除。交易請用文字。',
    'voice-realtime': 'Voice Live gpt-realtime-2.1直接理解音訊；VAD提交音訊後，以唯一function委派同一GPT-5.4四代理，不等待STT。委派文字不是原始逐字稿。結果經模型生成，再用Azure Neural zh-TW-HsiaoChenNeural朗讀，可改述；不是內建模型聲音，亦不保證較低延遲。交易請用文字。',
    'gpt-live': '全雙工語音前端，預設內建聲音（非Personal Voice）；旅遊工作委派同一四代理。語音可改述，不保證逐字發音或模型token串流。選班／報價／購買請停止後用文字完成；畫面後端結果才是依據。'
  };
  const modeAvailable = () => {
    const mode = $('voice-mode').value, config = modes[mode];
    return config?.available === true && (mode !== 'voice-realtime' ||
      (config.requiredModel === 'gpt-realtime-2.1' && config.configuredModel === 'gpt-realtime-2.1'));
  };
  function configureModes(voice) {
    modes = voice.modes ?? { 'voice-live': { available: voice.available }, 'gpt-live': { available: false } };
    if (voice.type) $('voice-mode').querySelector('[value="voice-live"]').textContent =
      `1 · Voice Live · GPT-5.4 + ${voice.type === 'azure-personal' ? 'Personal Voice' : voice.type === 'azure-custom' ? 'Professional Voice' : '預建聲音'}`;
    const mode = $('voice-mode').value;
    $('voice-title').textContent = mode === 'gpt-live' ? 'GPT-Live · gpt-live-1' :
      mode === 'voice-realtime' ? 'Voice Live · gpt-realtime-2.1（實驗）' :
      mode === 'speech-direct' ? '直接Azure Speech · Personal Voice' : 'Azure Voice Live';
    $('speech-options').hidden = mode !== 'speech-direct';
    const sdkSelected = mode === 'speech-direct' && $('speech-stt').value === 'sdk';
    $('speech-sdk-options').hidden = !sdkSelected;
    $('speech-wav-label').hidden = $('speech-source').value !== 'wav';
    $('speech-asr').hidden = !sdkSelected;
    $('voice-input-notice').textContent = sdkSelected && $('speech-source').value === 'wav' ?
      '按開始即以即時速率傳送所選WAV到Azure（可能計費），不啟用麥克風。' : '按開始即將麥克風音訊傳至所選 Azure 服務。';
    $('voice-comparison').textContent = sdkSelected ?
      '直接Speech SDK PushAudioInputStream連續辨識（固定zh-TW）：recognizing顯示中間結果，recognized每個最終片段排隊交同一四代理，再用既有Personal Voice TTS。SDK聲學停頓切段700／1000ms不是語意VAD，session_stopped只代表串流工作階段結束。REST對照組保持原樣。' : modeDescriptions[mode];
    $('voice-availability').textContent = modeAvailable() ? '已設定；尚未驗證本次雲端連線。' :
      mode === 'gpt-live' ? 'GPT-Live尚未設定，不可使用；不會自動切換其他管線。' :
      mode === 'voice-realtime' ? `此比較要求gpt-realtime-2.1；目前服務設定為${modes[mode]?.configuredModel ?? '未確認（舊版服務亦不可視為2.1）'}，未啟用或不符，請依後端設定說明處理。` :
      mode === 'speech-direct' ? '直接Speech尚未設定；需要獨立Speech端點與Personal Voice speakerProfileId，不會套用Voice Live的識別碼。' :
      '所選Voice Live模式尚未啟用，不可使用；不會自動切換其他管線。';
    $('voice-finish').hidden = mode !== 'speech-direct' || sdkSelected;
    $('voice-start').hidden = false;
    $('voice-start').dataset.available = String(modeAvailable());
    $('voice-start').disabled = active || !canStart() || !modeAvailable();
  }
  const sources = new Set();
  const waiting = createWaitingNotice((visible, text) => { if (visible && active) $('voice-status').textContent = text; });
  function status(next, detail = '') {
    phase = next;
    const label = selectedMode === 'speech-direct' && next === 'speaking' ? '正在朗讀；半雙工，完成後才能繼續收音' : labels[next];
    $('voice-status').textContent = (muted && active ? `${label} · 麥克風已靜音` : label) + (detail ? `：${detail}` : '');
    $('voice-finish').disabled = !active || next !== 'listening' || directFinishing || muted;
    $('voice-mute').disabled = !active;
    $('voice-mute').textContent = muted ? '取消靜音' : '靜音';
    $('voice-mute').setAttribute('aria-pressed', String(muted));
  }
  function clearAudio() {
    clearTimeout(playbackTimer);
    for (const node of sources) { node.onended = null; node.stop(); node.disconnect(); }
    sources.clear(); nextAudio = 0;
  }
  function stop(error, diagnostic = '') {
    generation++; active = false; onActive(false);
    replayController?.abort(); replayController = null; microphonePending = new Uint8Array();
    $('speech-options').disabled = false;
    $('voice-mode').disabled = false;
    audioEndMs = null; audioOrigin = null; captions = { user: '', assistant: '' };
    $('voice-caption').hidden = true; $('voice-caption').textContent = '';
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
    $('voice-start').disabled = !canStart() || !modeAvailable(); $('voice-stop').disabled = true;
    $('voice-error-details').textContent = diagnostic;
    $('voice-error').hidden = !diagnostic;
  }
  function play(base64, startMs, endMs, timing) {
    if (!context) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (bytes.length % 2) throw new Error('收到不完整的語音音訊');
    const pcm = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
    nextAudio = Math.max(context.currentTime, nextAudio);
    if (selectedMode === 'gpt-live' && timing !== 'pcm-contiguous') {
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs ||
          (audioEndMs !== null && startMs < audioEndMs)) throw new Error('GPT-Live音訊時間順序無效');
      if (audioOrigin === null) audioOrigin = context.currentTime - startMs / 1000;
      nextAudio = Math.max(context.currentTime, audioOrigin + startMs / 1000);
      audioEndMs = endMs;
    }
    if (nextAudio + buffer.duration - context.currentTime > 30) throw new Error('語音播放時間超過緩衝上限');
    if (packetAt === null) {
      packetAt = performance.now();
      $('voice-metrics').textContent += `；瀏覽器首包→首次播放排程等待 ${Math.round((nextAudio - context.currentTime) * 1000)} ms（非實際揚聲器出聲）`;
    }
    node.start(nextAudio); nextAudio += buffer.duration; sources.add(node);
    node.onended = () => { sources.delete(node); node.disconnect(); };
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
    $('voice-metrics').textContent = '尚無量測；各時鐘分開，缺少事件不補造時間。';
    onActive(true); status('connecting');
    $('voice-mode').disabled = true;
    $('speech-options').disabled = true;
    $('voice-start').disabled = true; $('voice-stop').disabled = false;
    try {
      // A stopped voice turn may still be finishing safely on the server. Do not reopen its lock.
      let bootstrap = await api('bootstrap'), waited = false;
      const deadline = Date.now() + 180000;
      while (bootstrap.pending) {
        if (current !== generation) return;
        if (Date.now() >= deadline) throw new Error('上一段仍在處理，請稍後再開始語音；原請求未取消。');
        if (!waited) { status('thinking', '等待上一段完成，尚未收音'); waiting.start(); }
        waited = true;
        await new Promise(resolve => { wakePending = resolve; pendingTimer = setTimeout(resolve, 1000); });
        wakePending = null;
        if (current !== generation) return;
        bootstrap = await api('bootstrap');
      }
      if (current !== generation) return;
      waiting.clear();
      configureModes(bootstrap.voice);
      if (!modeAvailable()) throw new Error('所選語音管線尚未設定或模型不符，未啟動麥克風。');
      let wav;
      if (sdkSession) {
        if (!modes['speech-direct']?.sttModes?.includes('sdk')) throw new Error('執行中的後端尚未支援SDK模式，請先套用新版；未啟動收音。');
        speechInput = { stt: 'sdk', source: $('speech-source').value, sampleRate: 16000,
          silenceMs: Number($('speech-silence').value), chunkBytes: Number($('speech-chunk').value),
          phrases: [...new Set($('speech-phrases').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))] };
        if (!Number.isInteger(speechInput.chunkBytes) || speechInput.chunkBytes < 320 || speechInput.chunkBytes > 6400 ||
            speechInput.chunkBytes % 2 || speechInput.phrases.length > 100 || speechInput.phrases.some(s => s.length > 100)) {
          throw new Error('SDK區塊需為320–6400偶數bytes；phrase list最多100詞、每詞100字。');
        }
        if (speechInput.source === 'wav') {
          const file = $('speech-wav').files[0];
          if (!file || file.size > MAX_WAV_BYTES) throw new Error('請先選擇120秒內的8／16 kHz PCM16單聲道WAV。');
          wav = readPcmWav(await file.arrayBuffer());
          speechInput.sampleRate = wav.sampleRate;
        }
        $('speech-finals').replaceChildren(); $('speech-interim').textContent = '';
        $('speech-events').textContent = ''; $('speech-replay-progress').textContent = '';
        microphonePending = new Uint8Array();
      }
      if (current !== generation) return;
      onRecovered(bootstrap);
      status('connecting');
      context = new AudioContext({ sampleRate: 24000 }); await context.resume();
      if (current !== generation) return;
      if (context.sampleRate !== 24000) throw new Error('此瀏覽器不支援必要的 24 kHz 音訊，請使用新版 Edge 或 Chrome。');
      if (!wav) {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (current !== generation) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      await context.audioWorklet.addModule('/audio-worklet.js');
      if (current !== generation) return;
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, 'microphone-pcm', { processorOptions: { sdk: sdkSession } });
      source.connect(processor); processor.connect(context.destination);
      }
      const ticket = await api('voice/session', {
        ...getDisplayedContext(), ...(bootstrap.voice.modes ? { mode: selectedMode } : {}),
        ...(sdkSession ? { speechInput } : {})
      });
      if (current !== generation) return;
      const url = new URL(ticket.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, [ticket.protocol, ticket.nonce]);
      timer = setTimeout(() => stop('連線逾時，請重新連線'), 25000);
      if (processor) processor.port.onmessage = event => {
        if (event.data?.type === 'flushed') {
          if (current === generation && directFinishing && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'finish' })); status('thinking'); waiting.start();
          }
          return;
        }
        if (current === generation && socket?.readyState === WebSocket.OPEN && !muted && ['listening', 'thinking', 'speaking'].includes(phase)) {
          if (selectedMode === 'speech-direct' && phase !== 'listening') return;
          if (socket.bufferedAmount > 480000) return stop('網路傳輸過慢，已停止收音');
          if (sdkSession) {
            const converted = resampleMicrophone(event.data);
            const combined = new Uint8Array(microphonePending.length + converted.length);
            combined.set(microphonePending); combined.set(converted, microphonePending.length);
            let offset = 0;
            while (combined.length - offset >= speechInput.chunkBytes) {
              socket.send(combined.slice(offset, offset + speechInput.chunkBytes)); offset += speechInput.chunkBytes;
            }
            microphonePending = combined.slice(offset);
          } else socket.send(event.data);
        }
      };
      socket.onmessage = event => {
        if (current !== generation) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') {
            clearTimeout(timer); status('listening');
            if (wav) {
              replayController = new AbortController();
              const signal = replayController.signal;
              void replayPcm({ ...wav, chunkBytes: speechInput.chunkBytes, signal,
                canSend: () => current === generation && phase === 'listening' && !muted && socket?.readyState === WebSocket.OPEN,
                send: packet => {
                  if (socket.bufferedAmount > 480000) throw new Error('串流重播背壓過高，已停止。');
                  socket.send(packet);
                },
                onProgress: ms => { $('speech-replay-progress').textContent = `WAV已送出 ${Math.round(ms)}／${Math.round(wav.durationMs)} ms（不含半雙工暫停）`; }
              }).then(() => {
                if (current === generation) socket.send(JSON.stringify({ type: 'input_eof' }));
              }).catch(error => { if (current === generation && !signal.aborted) stop(error.message); });
            }
          }
          else if (data.type === 'asr' && sdkSession) {
            const known = ['session_started', 'recognizing', 'recognized', 'no_match', 'input_eof', 'session_stopped', 'canceled'];
            if (!known.includes(data.kind) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) throw new Error('SDK事件格式無效');
            if (data.kind !== 'recognizing') {
              const event = document.createElement('li');
              event.textContent = `${data.kind} · 本機接收 ${data.elapsedMs} ms`;
              if ($('speech-events').children.length >= 200) $('speech-events').firstElementChild.remove();
              $('speech-events').append(event);
            }
            if (['recognizing', 'recognized'].includes(data.kind)) {
              if (typeof data.text !== 'string' || data.text.length > 2000) throw new Error('SDK辨識文字無效');
              if (data.kind === 'recognizing') $('speech-interim').textContent = `中間結果（可更正）：${data.text}`;
              else {
                if ($('speech-finals').children.length >= 100) throw new Error('SDK最終片段超過上限');
                const item = document.createElement('li');
                item.textContent = `#${data.sequence} · offset ${data.offsetMs} ms · duration ${data.durationMs} ms · 接收 ${data.elapsedMs} ms：${data.text}`;
                $('speech-finals').append(item); $('speech-interim').textContent = '';
              }
            }
          }
          else if (data.type === 'measurement') {
            const stages = ['input_start', 'input_end', 'endpoint', 'transcript', 'stt_dispatch', 'frontend_dispatch', 'delegation',
              'backend_dispatch', 'backend_result', 'tts_dispatch', 'tts_first_byte', 'frontend_response_dispatch', 'commentary_dispatch', 'first_audio', 'frontend_audio'];
            if (data.mode !== selectedMode || !Number.isInteger(data.turn) || !stages.includes(data.stage) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return;
            if (measurementTurn !== data.turn) { measurementTurn = data.turn; measurementStages = {}; packetAt = null; }
            measurementStages[data.stage] = data.elapsedMs;
            const duration = (from, to) => measurementStages[from] !== undefined && measurementStages[to] !== undefined &&
              measurementStages[to] >= measurementStages[from] ? `${Math.round(measurementStages[to] - measurementStages[from])} ms` : '未提供／不可比較';
            $('voice-metrics').textContent = `伺服器本機：輸入結束→後端委派 ${duration('input_end', 'backend_dispatch')}；STT ${duration('stt_dispatch', 'transcript')}；原生前端→function ${duration('frontend_dispatch', 'delegation')}；後端處理 ${duration('backend_dispatch', 'backend_result')}；Speech TTS→首位元組 ${duration('tts_dispatch', 'tts_first_byte')}；後端結果→送出首音訊 ${duration('backend_result', 'first_audio')}。直接Speech先完整驗證音訊再送出；GPT-Live結果後首包亦非語意上的答案完成；不同時鐘不相減。`;
          }
          else if (data.type === 'state') {
            if (sdkSession && data.state !== 'listening') {
              microphonePending = new Uint8Array(); processor?.port.postMessage({ type: 'reset' });
            }
            if (selectedMode === 'speech-direct' && data.state === 'listening') directFinishing = false;
            if (data.state === 'thinking' && phase !== 'thinking') waiting.start();
            status(data.state, data.detail ?? '');
          }
          else if (data.type === 'transcript') {
            clearTimeout(playbackTimer);
            currentTurn = data.turnId; agentStatus.start(currentTurn);
            waiting.start(); onTranscript(data.text, data.turnId);
          }
          else if (data.type === 'progress') { agentStatus.update(data.turnId, data.role); }
          else if (data.type === 'result') {
            if (data.turnId !== currentTurn) return;
            waiting.clear();
            agentStatus.update(currentTurn, data.result.state.activeAgent, 'completed');
            status('thinking', '已取得回答，準備朗讀');
            onResult(data.result);
            socket.send(JSON.stringify({ type: 'displayed', turnId: data.turnId }));
          } else if (data.type === 'compatibility' && selectedMode === 'gpt-live') {
            $('voice-availability').textContent = data.message;
          } else if (data.type === 'audio') play(data.audio, data.startMs, data.endMs, data.timing);
          else if (data.type === 'liveCaption' && ['gpt-live', 'voice-realtime'].includes(selectedMode)) {
            if (!['user', 'assistant'].includes(data.speaker) || typeof data.text !== 'string') throw new Error('GPT-Live字幕無效');
            captions[data.speaker] = (captions[data.speaker] + data.text).slice(-1000);
            $('voice-caption').hidden = false;
            $('voice-caption').textContent = `${data.speaker === 'user' ? '即時辨識片段' :
              selectedMode === 'gpt-live' ? 'GPT-Live語音（非權威結果）' : 'GPT-Realtime語音（非權威結果）'}：${captions[data.speaker]}`;
          } else if (data.type === 'taskError' && selectedMode === 'gpt-live') {
            if (currentTurn && data.turnId !== currentTurn) { status(phase, data.message); return; }
            currentTurn = null; waiting.clear(); agentStatus.clear();
            status('listening', data.message);
          }
          else if (data.type === 'interrupted') {
            waiting.clear(); clearAudio(); status('listening');
            if ($('voice-agent').dataset.status !== 'processing') { currentTurn = null; agentStatus.clear(); }
          }
          else if (data.type === 'superseded') {
            onSuperseded(data.turnId);
            if (data.turnId === currentTurn) { currentTurn = null; agentStatus.clear(); }
            status('thinking', '已收到更正，改依最新內容處理');
          }
          else if (data.type === 'audioDone') {
            if ($('voice-agent').dataset.status !== 'completed') return;
            const spokenTurn = currentTurn;
            clearTimeout(playbackTimer);
            playbackTimer = setTimeout(() => {
              if (active && currentTurn === spokenTurn) {
                if (selectedMode === 'speech-direct') {
                  socket?.send(JSON.stringify({ type: 'resume' })); directFinishing = false;
                }
                status('listening'); currentTurn = null; agentStatus.clear();
              }
            }, Math.max(0, nextAudio - context.currentTime) * 1000 + 30);
          } else if (data.type === 'error') stop(data.message, `${data.code} · ${data.correlationId}`);
        } catch (error) { stop(error.message); }
      };
      socket.onerror = () => { if (current === generation) stop('無法建立安全語音連線；請檢查後端與 Azure 身分。'); };
      socket.onclose = () => { if (current === generation) stop('語音連線已中斷，文字紀錄保留。'); };
    } catch (error) {
      if (current !== generation) return;
      stop(error.code === 'SESSION_BUSY' ? '上一段對話還在處理，完成後再按開始語音。' :
        error.name === 'NotAllowedError' ? '麥克風權限被拒絕，請允許此網站使用麥克風後重試。' :
        error.name === 'NotFoundError' ? '找不到麥克風，請連接裝置後重試。' : error.message, error.diagnostic);
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
    $('conversation-expand').textContent = expanded ? '還原對話寬度' : '放大對話寬度';
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
  return { stop, start, configureModes };
}
