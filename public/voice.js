import { createWaitingNotice } from './waiting.js';
export function createVoiceController({ api, onTranscript, onResult, onActive, agentStatus, getDisplayedContext, canStart = () => true, onRecovered = () => {}, onSuperseded = () => {} }) {
  const $ = id => document.getElementById(id);
  const labels = { connecting: '連線中…', listening: '聆聽中，請自然說話', thinking: '旅程團隊思考中…', speaking: '正在朗讀，可直接說話打斷', muted: '已靜音', stopped: '已停止收音', error: '語音連線已停止' };
  let socket, stream, context, source, processor, timer, playbackTimer, pendingTimer, wakePending;
  let active = false, muted = false, phase = 'stopped', generation = 0, nextAudio = 0;
  let currentTurn = null;
  const sources = new Set();
  const waiting = createWaitingNotice((visible, text) => { if (visible && active) $('voice-status').textContent = text; });
  function status(next, detail = '') {
    phase = next; $('voice-status').textContent = (muted && active ? `${labels[next]} · 麥克風已靜音` : labels[next]) + (detail ? `：${detail}` : '');
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
    currentTurn = null; agentStatus.clear();
    waiting.clear();
    clearTimeout(pendingTimer); wakePending?.(); wakePending = null;
    clearTimeout(timer); clearAudio();
    processor?.port.close(); processor?.disconnect(); source?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    socket?.close(); socket = null;
    if (context && context.state !== 'closed') context.close();
    processor = source = stream = context = null;
    status(error ? 'error' : 'stopped', error || '');
    $('voice-start').disabled = !canStart(); $('voice-stop').disabled = true;
    $('voice-error-details').textContent = diagnostic;
    $('voice-error').hidden = !diagnostic;
  }
  function play(base64) {
    if (!context) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    if (bytes.length % 2) throw new Error('收到不完整的語音音訊');
    const pcm = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
    nextAudio = Math.max(context.currentTime, nextAudio);
    node.start(nextAudio); nextAudio += buffer.duration; sources.add(node);
    node.onended = () => { sources.delete(node); node.disconnect(); };
    status('speaking');
  }
  async function start() {
    if (active || !canStart()) return;
    $('voice-error').hidden = true;
    active = true; muted = false; const current = ++generation;
    currentTurn = null; agentStatus.clear();
    onActive(true); status('connecting');
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
      onRecovered(bootstrap);
      status('connecting');
      context = new AudioContext({ sampleRate: 24000 }); await context.resume();
      if (current !== generation) return;
      if (context.sampleRate !== 24000) throw new Error('此瀏覽器不支援必要的 24 kHz 音訊，請使用新版 Edge 或 Chrome。');
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (current !== generation) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      await context.audioWorklet.addModule('/audio-worklet.js');
      if (current !== generation) return;
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, 'microphone-pcm');
      source.connect(processor); processor.connect(context.destination);
      const ticket = await api('voice/session', getDisplayedContext());
      if (current !== generation) return;
      const url = new URL(ticket.path, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, [ticket.protocol, ticket.nonce]);
      timer = setTimeout(() => stop('連線逾時，請重新連線'), 25000);
      processor.port.onmessage = event => {
        if (current === generation && socket?.readyState === WebSocket.OPEN && !muted && ['listening', 'thinking', 'speaking'].includes(phase)) {
          if (socket.bufferedAmount > 480000) return stop('網路傳輸過慢，已停止收音');
          socket.send(event.data);
        }
      };
      socket.onmessage = event => {
        if (current !== generation) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') { clearTimeout(timer); status('listening'); }
          else if (data.type === 'state') { if (data.state === 'thinking' && phase !== 'thinking') waiting.start(); status(data.state); }
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
          } else if (data.type === 'audio') play(data.audio);
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
              if (active && currentTurn === spokenTurn) { status('listening'); currentTurn = null; agentStatus.clear(); }
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
  $('voice-start').addEventListener('click', start);
  $('voice-stop').addEventListener('click', () => stop());
  $('voice-mute').addEventListener('click', () => {
    if (!active) return;
    muted = !muted; stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'mute', muted }));
    status(phase);
  });
  $('close-voice').addEventListener('click', () => { stop(); $('voice-dialog').hidden = true; });
  window.addEventListener('pagehide', () => stop());
  return { stop, start };
}
