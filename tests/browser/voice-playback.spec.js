import { test, expect } from '@playwright/test';
import { candidateAssets } from './candidate-assets.js';

async function playbackPage(page, mode, personalVoice = false) {
  await candidateAssets(page);
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.voice = { available: true, modes: Object.fromEntries(
      ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct', 'foundry-voice-agent'].map(name => [name, {
        available: true, requiredModel: 'gpt-realtime-2.1', configuredModel: 'gpt-realtime-2.1', sttModes: ['rest', 'sdk']
      }])) };
    if (personalVoice) Object.assign(body.voice, {
      type: 'azure-personal', defaultPersonalVoice: 'alexpun',
      personalVoices: [{ key: 'alexpun', label: '男聲' }, { key: 'athena', label: '女聲' }]
    });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/voice/session', route => route.fulfill({ json: {
    protocol: 'journey-voice', nonce: 'a'.repeat(64), path: '/api/voice/stream'
  } }));
  await page.addInitScript(() => {
    window.__time = 0; window.__nodes = []; window.__micCalls = 0;
    const NativeAudio = window.AudioContext;
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(...args) { super(...args); window.__processor = this; }
    };
    window.AudioContext = class extends NativeAudio {
      constructor(options) { super(options); window.__context = this; }
      get currentTime() { return window.__time; }
      createBufferSource() {
        const node = {
          connect() {}, disconnect() {}, stop() { this.stopped = true; },
          start(at) { this.at = at; this.scheduledAt = window.__time; window.__nodes.push(this); }
        };
        return node;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      // Synthetic in-browser stream only; never ask for the physical microphone.
      window.__micCalls++;
      return window.__context.createMediaStreamDestination().stream;
    };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0; controls = []; binarySent = 0; binaryBytes = 0;
      constructor() { window.__socket = this; setTimeout(() => this.receive({ type: 'ready' }), 20); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      send(data) {
        if (typeof data === 'string') this.controls.push(JSON.parse(data));
        else { this.binarySent++; this.binaryBytes += data.byteLength; }
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    window.__advance = time => {
      window.__time = time;
      for (const node of window.__nodes) {
        if (!node.ended && node.at + node.buffer.duration <= time) {
          node.ended = true; node.onended?.();
        }
      }
    };
    window.__audio = btoa(String.fromCharCode(...new Uint8Array(48000)));
  });
  await page.goto('/'); await page.locator('#voice').click();
  await page.locator('#voice-mode').selectOption(mode);
  await page.locator('#voice-start').click();
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
}

for (const width of [1440, 390, 320]) {
  test(`Option1 personal voice selector stays compact, scoped and connection-bound at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await playbackPage(page, 'voice-live', true);
    const voice = page.locator('#personal-voice');
    await expect(voice.locator('option')).toHaveText(['個人化男聲', '個人化女聲']);
    await expect(voice).toHaveValue('alexpun');
    await expect(voice).toBeDisabled();
    await expect(page.locator('#voice-dialog legend')).not.toContainText(['Personal Voice']);
    const modeBounds = await page.locator('#voice-mode').boundingBox(), voiceBounds = await voice.boundingBox();
    expect(Math.abs(modeBounds.y - voiceBounds.y) < 2).toBe(width === 1440);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#voice-stop').click();
    await expect(voice).toBeEnabled();
    for (const mode of ['voice-realtime', 'gpt-live', 'speech-direct']) {
      await page.locator('#voice-mode').selectOption(mode);
      await expect(voice).toBeHidden();
    }
    await page.locator('#voice-mode').selectOption('voice-live');
    await voice.selectOption('athena');
    const request = page.waitForRequest('**/api/voice/session');
    await page.locator('#voice-start').click();
    expect((await request).postDataJSON().personalVoiceKey).toBe('athena');
    await expect(page.locator('#voice-status')).toContainText('聆聽中');
    await expect(voice).toBeDisabled();
    await page.locator('#voice-stop').click();
    await expect(voice).toBeEnabled();
    await expect(voice).toHaveValue('athena');
  });
}

for (const mode of ['voice-live', 'voice-realtime', 'gpt-live', 'speech-direct']) {
  test(`${mode}: burst of 45 seconds plays in bounded windows, drains, and stops cleanly`, async ({ page }) => {
    await playbackPage(page, mode);
    await page.clock.install();
    await page.evaluate(async () => {
      const state = (await (await fetch('/api/bootstrap')).json()).state;
      window.__socket.receive({ type: 'transcript', text: '測試', turnId: 'turn' });
      window.__socket.receive({ type: 'result', turnId: 'turn', result: {
        text: '測試回答', state: { ...state, activeAgent: 'planner' }
      } });
      for (let i = 0; i < 45; i++) {
        window.__socket.receive({ type: 'audio', audio: window.__audio, timing: 'pcm-contiguous' });
      }
      window.__socket.receive({ type: 'audioDone' });
    });
    await expect(page.locator('#voice-status')).toContainText('正在朗讀');
    expect(await page.evaluate(() => window.__nodes.length)).toBe(30);
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
    await page.evaluate(() => window.__advance(15));
    await page.clock.fastForward(15000);
    await expect.poll(() => page.evaluate(() => window.__nodes.length)).toBe(45);
    expect(await page.evaluate(() => window.__nodes.every(n => n.at + n.buffer.duration - n.scheduledAt <= 30))).toBe(true);
    expect(await page.evaluate(() => window.__nodes.every(n => n.buffer.sampleRate === 24000))).toBe(true);
    expect(await page.evaluate(() => window.__nodes.map(n => n.at))).toEqual(Array.from({ length: 45 }, (_, i) => i));
    expect(await page.evaluate(() => window.__socket.controls.some(e => e.type === 'resume'))).toBe(false);
    await page.evaluate(() => window.__advance(45));
    await page.clock.fastForward(30040);
    await expect(page.locator('#voice-status')).toContainText('聆聽中');
    if (mode === 'speech-direct') {
      expect(await page.evaluate(() => window.__socket.controls.filter(e => e.type === 'resume').length)).toBe(1);
    }
    // Freed playback capacity accepts later audio without accumulating old duration.
    await page.evaluate(() => {
      window.__advance(45);
      for (let i = 0; i < 30; i++) window.__socket.receive({ type: 'audio', audio: window.__audio, timing: 'pcm-contiguous' });
    });
    expect(await page.evaluate(() => window.__nodes.length)).toBe(75);
    await page.locator('#voice-stop').click();
    expect(await page.evaluate(() => window.__nodes.every(n => n.ended || n.stopped))).toBe(true);
    await expect(page.locator('#voice-status')).toHaveText('已停止收音');
  });
}

test('playback still rejects excess queued PCM with a friendly error and safe diagnostic code', async ({ page }) => {
  await playbackPage(page, 'voice-live');
  await page.evaluate(() => {
    for (let i = 0; i < 61; i++) window.__socket.receive({ type: 'audio', audio: window.__audio });
  });
  await expect(page.locator('#voice-status')).toContainText('語音回覆過長');
  await expect(page.locator('#voice-error-details')).toHaveText('VOICE_PLAYBACK_LIMIT');
  expect(await page.evaluate(() => window.__socket.readyState)).toBe(3);
});

test('internal segments drain automatically without hiding the full answer; stop cancels the pending acknowledgment', async ({ page }) => {
    await playbackPage(page, 'voice-live');
    await page.clock.install();
    await page.evaluate(async () => {
      const state = (await (await fetch('/api/bootstrap')).json()).state;
      window.__socket.receive({ type: 'transcript', text: '五天全部展開', turnId: 'detail' });
      window.__socket.receive({ type: 'result', turnId: 'detail', result: {
        text: '第 1 天：抵達與休息。第 2 天：09:00–17:00開會。第 3 天：會議。第 4 天：淺草。第 5 天：回程待確認。',
        speech: {text:'逐日完整朗讀',detail:'detailed'}, state: {...state,activeAgent:'planner',moreReply:false}
      } });
      window.__socket.receive({type:'audio',audio:window.__audio});
      window.__socket.receive({type:'audioSegmentDone',turnId:'detail',segment:0});
    });
    await expect(page.locator('#messages')).toContainText('第 5 天');
    expect(await page.evaluate(() => window.__socket.controls.filter(e=>e.type==='segmentPlayed').length)).toBe(0);
    await page.evaluate(() => window.__advance(1));
    await page.clock.fastForward(1040);
    expect(await page.evaluate(() => window.__socket.controls.filter(e=>e.type==='segmentPlayed'))).toEqual([{type:'segmentPlayed',turnId:'detail',segment:0}]);
    await page.evaluate(() => {
      window.__socket.receive({type:'audio',audio:window.__audio});
      window.__socket.receive({type:'audioSegmentDone',turnId:'detail',segment:1});
    });
    await page.locator('#voice-stop').click();
    await page.clock.fastForward(2000);
    expect(await page.evaluate(() => window.__socket.controls.filter(e=>e.type==='segmentPlayed').length)).toBe(1);
});

test('interruption discards scheduled and pending audio without stale playback', async ({ page }) => {
  await playbackPage(page, 'gpt-live');
  await page.evaluate(() => {
    for (let i = 0; i < 45; i++) window.__socket.receive({ type: 'audio', audio: window.__audio, timing: 'pcm-contiguous' });
    window.__socket.receive({ type: 'interrupted' });
    window.__advance(40);
  });

  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__nodes.length)).toBe(30);
  expect(await page.evaluate(() => window.__nodes.every(n => n.stopped))).toBe(true);
  await expect(page.locator('#voice-status')).toContainText('聆聽中');
  await page.locator('#voice-stop').click();
});

test('Realtime summaries and restored history use customer labels, never pretend to be verbatim transcripts', async ({ page }) => {
  await playbackPage(page, 'voice-realtime');
  await page.evaluate(() => window.__socket.receive({
    type: 'transcript', turnId: 'greeting', text: '需求摘要：你好你聽得到我說話嗎？'
  }));
  await expect(page.locator('#messages')).toContainText('需求摘要：你好你聽得到我說話嗎？');
  await expect(page.locator('#messages')).not.toContainText('非原始逐字稿');
  await page.locator('#voice-stop').click();
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), data = await response.json();
    data.history = [{ role: 'user', text: '語音前端委派（非原始逐字稿）：你好你聽得到我說話嗎？' }];
    await route.fulfill({ response, json: data });
  });

  await page.reload();
  await expect(page.locator('#messages')).toContainText('需求摘要：你好你聽得到我說話嗎？');
  await expect(page.locator('#messages')).not.toContainText('語音前端委派');
});

for (const mode of ['voice-live', 'voice-realtime', 'gpt-live']) {
  test(`${mode} discards delayed capture batches instead of bursting stale audio to the service`, async ({ page }) => {
    await playbackPage(page, mode);
    await expect(page.locator('#voice-input-notice')).toBeHidden();
    await expect(page.locator('#voice-metrics').locator('..')).toBeHidden();
    const counts = await page.evaluate(() => {
      const receive = window.__processor.port.onmessage;
      window.__processor.port.onmessage = null;
      window.__time = 10;
      const before = window.__socket.binarySent;
      for (let i = 0; i < 60; i++) receive({ data: { audio: new ArrayBuffer(4096), capturedAt: 5 + i * 0.085 } });
      const afterStale = window.__socket.binarySent;
      receive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } });
      return { before, afterStale, afterCurrent: window.__socket.binarySent };
    });
    expect(counts.afterStale).toBe(counts.before + 1);
    expect(counts.afterCurrent).toBe(counts.afterStale + 1);
    await expect(page.locator('#voice-status')).toContainText('請再說一次');
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
    await page.locator('#voice-stop').click();
    await expect(page.locator('#voice-input-notice')).toBeVisible();
  });
}
test('Option1 bounds fresh timestamp bursts by wall clock even when audio time is frozen', async ({ page }) => {
  await playbackPage(page, 'voice-live');
  await page.clock.install();
  const counts = await page.evaluate(() => {
    const receive = window.__processor.port.onmessage;
    window.__captureReceive = receive;
    window.__processor.port.onmessage = null;
    window.__time = 10;
    const before = window.__socket.binarySent;
    for (let i = 0; i < 40; i++) receive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } });
    return { before, after: window.__socket.binarySent };
  });

  expect(counts.after - counts.before).toBeLessThanOrEqual(3);
  await expect(page.locator('#voice-status')).toContainText('已略過積壓音訊');
  await page.clock.fastForward(100);
  const resumed = await page.evaluate(() => {
    const before = window.__socket.binarySent;
    window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } });
    return { before, after: window.__socket.binarySent };
  });
  expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
  expect(resumed.before).toBe(counts.after);
  expect(resumed.after).toBe(counts.after + 1);
  const congested = await page.evaluate(() => {
    const before = window.__socket.binarySent;
    window.__socket.bufferedAmount = 12288;
    window.__captureReceive({ data: new ArrayBuffer(4096) });
    window.__socket.bufferedAmount = 0;
    return { before, after: window.__socket.binarySent };
  });
  expect(congested.after).toBe(congested.before);
  for (let i = 0; i < 24; i++) {
    await page.clock.fastForward(86);
    const paced = await page.evaluate(() => {
      const before = window.__socket.binarySent;
      window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } });
      return window.__socket.binarySent - before;
    });
    expect(paced).toBe(1);
  }
});

for (const mode of ['voice-live', 'foundry-voice-agent']) {
for (const confirmed of [false, true]) {
  test(`${mode} delayed transport ${confirmed ? 'caps unacknowledged input' : 'reproduces legacy arrival burst despite empty browser buffer'}`, async ({ page }) => {
    await playbackPage(page, mode);
    await page.clock.install();
    await page.evaluate(confirmed => {
      window.__captureReceive = window.__processor.port.onmessage;
      window.__processor.port.onmessage = null;
      window.__time = 10;
      if (confirmed) {
        window.__socket.receive({ type: 'ready', inputFlow: { maxUnackedBytes: 12288 } });
        window.__socket.receive({ type: 'inputAudioAck', receivedBytes: window.__socket.binaryBytes });
      }
      window.__beforeCapture = window.__socket.binarySent;
      window.__beforeCaptureBytes = window.__socket.binaryBytes;
    }, confirmed);
    // Legacy bursts after three seconds; negotiated credit recovers before ACK timeout.
    for (let i = 0; i < (confirmed ? 18 : 36); i++) {
      await page.clock.fastForward(86);
      await page.evaluate(() => window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } }));
    }
    const delayed = await page.evaluate(() => (window.__socket.binarySent - window.__beforeCapture) * 4096);
    if (!confirmed) {
      expect(delayed).toBe(147456);
      return;
    }
    expect(delayed).toBe(12288);
    expect(await page.evaluate(() => window.__socket.bufferedAmount)).toBe(0);
    await expect(page.locator('#voice-status')).toContainText('已略過積壓音訊');
    await page.evaluate(() => window.__socket.receive({ type: 'inputAudioAck', receivedBytes: window.__beforeCaptureBytes + 12288 }));
    await page.clock.fastForward(86);
    await page.evaluate(() => window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } }));
    expect(await page.evaluate(() => (window.__socket.binarySent - window.__beforeCapture) * 4096)).toBe(16384);
    expect(await page.evaluate(() => window.__socket.readyState)).toBe(1);
    await page.locator('#voice-stop').click();
  });
}

test(`${mode} rejects invalid input acknowledgements`, async ({ page }) => {
  await playbackPage(page, mode);
  await page.evaluate(() => {
    window.__processor.port.onmessage = null;
    window.__socket.receive({ type: 'ready', inputFlow: { maxUnackedBytes: 12288 } });
    window.__socket.receive({ type: 'inputAudioAck', receivedBytes: Number.MAX_SAFE_INTEGER });
  });
  await expect(page.locator('#voice-status')).toContainText('收音傳輸確認無效');
  expect(await page.evaluate(() => window.__socket.readyState)).toBe(3);
});

test(`${mode} missing input ACK terminates explicitly instead of remaining in a capture-credit deadlock`, async ({ page }) => {
  await playbackPage(page, mode);
  await page.clock.install();
  await page.evaluate(() => {
    window.__captureReceive = window.__processor.port.onmessage;
    window.__processor.port.onmessage = null;
    window.__time = 10;
    window.__socket.receive({ type: 'ready', inputFlow: { maxUnackedBytes: 12288 } });
    for (let i = 0; i < 3; i++) window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } });
  });
  await page.clock.fastForward(2100);
  await page.evaluate(() => window.__captureReceive({ data: { audio: new ArrayBuffer(4096), capturedAt: 10 } }));
  await expect(page.locator('#voice-error-details')).toHaveText('VOICE_INPUT_ACK_TIMEOUT');
  expect(await page.evaluate(() => window.__socket.readyState)).toBe(3);
});
}

test('old, duplicate and future segment events cannot replace the current segment ACK timer', async ({ page }) => {
  await playbackPage(page, 'voice-live');
  await page.clock.install();
  await page.evaluate(async () => {
    const state = (await (await fetch('/api/bootstrap')).json()).state;
    window.__socket.receive({ type: 'transcript', turnId: 'current', text: '完整回答' });
    window.__socket.receive({ type: 'result', turnId: 'current', result: { text: '回答', state } });
    window.__socket.receive({ type: 'audio', audio: window.__audio });
    window.__socket.receive({ type: 'audioSegmentDone', turnId: 'current', segment: 0 });
    window.__advance(1);
  });
  await page.clock.fastForward(1040);
  await page.evaluate(() => {
    window.__socket.receive({ type: 'audio', audio: window.__audio });
    window.__socket.receive({ type: 'audioSegmentDone', turnId: 'current', segment: 1 });
    window.__socket.receive({ type: 'audioSegmentDone', turnId: 'current', segment: 0 });
    window.__socket.receive({ type: 'audioSegmentDone', turnId: 'stale', segment: 1 });
    window.__socket.receive({ type: 'audioSegmentDone', turnId: 'current', segment: 3 });
    window.__advance(2);
  });
  await page.clock.fastForward(1040);
  expect(await page.evaluate(() => window.__socket.controls.filter(event => event.type === 'segmentPlayed')))
    .toEqual([{ type: 'segmentPlayed', turnId: 'current', segment: 0 }, { type: 'segmentPlayed', turnId: 'current', segment: 1 }]);
  await page.locator('#voice-stop').click();
});
