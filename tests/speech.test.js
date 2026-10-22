import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { speechText, chineseNumber, withoutSpeechSources } from '../lib/speech.js';
import { bridgeVoice, voiceConfig } from '../lib/voice.js';
import { createSession } from '../lib/core.js';
import { countWords } from '../lib/replies.js';

test('voice omits explicit source metadata and citation tokens but preserves answer, warnings and transaction facts', () => {
  const answer = 'DEMO101，TWD 12,345。航班與價格均為模擬，營業時間未核驗。';
  for (const suffix of [
    '\n\n知識來源（合成示範靜態快照）：flight-knowledge.txt',
    '\n資料來源：旅遊資訊網站 https://example.test/source',
    '\n**參考資料：**\n- [航點](https://example.test/stops)\n- flight-knowledge.txt',
    '\n### Sources\n1. https://example.test/source',
    '\n來源：https://example.test/source'
  ]) {
    const canonical = answer + suffix;
    assert.equal(withoutSpeechSources(canonical), answer);
    assert.equal(speechText(canonical), speechText(answer));
    assert.ok(canonical.includes(suffix), 'visible canonical answer is unchanged');
  }
  assert.equal(withoutSpeechSources('東京。大阪。'), '東京。大阪。');
  assert.equal(withoutSpeechSources('來源：https://example.test\n不收款、不訂位、不開票。'), '不收款、不訂位、不開票。');
  assert.equal(withoutSpeechSources('資料來源尚未核驗。\n- 票價 TWD 12,345\n- 不收款。'), '資料來源尚未核驗。\n- 票價 TWD 12,345\n- 不收款。');
  assert.equal(withoutSpeechSources('資料來源：https://example.test。此為模擬，不收款。'), '此為模擬，不收款。');
  assert.equal(withoutSpeechSources('資料來源：example.txt'), '');
});

test('flight/code letters are spelled separately and Mandarin digits preserve I versus 1 and leading zero', () => {
  for (const [canonical, spoken] of [
    ['DEMO101', 'D，E，M，O，一，零，一'], ['I1', 'I，一'], ['DEMO0101', 'D，E，M，O，零，一，零，一'],
    ['TPE', 'T，P，E'], ['DEMO-FLT-30', '模擬班號，D，E，M，O，F，L，T，三，零'],
    ['aB010c', 'A，B，零，一，零，C'], ['00101', '零，零，一，零，一']
  ]) assert.equal(speechText(canonical), spoken);
  assert.equal(speechText('Travel planner HELLO welcome'), 'Travel planner HELLO welcome');
  assert.equal(speechText('I like travel'), 'I like travel');
});
test('dates, local times, currency and counts retain meaning in Traditional Chinese rather than English cardinals', () => {
  assert.equal(speechText('2026-11-25T08:30'), '二零二六年十一月二十五日上午八點三十分');
  assert.equal(speechText('2026-11-25T00:30:05.123Z'), '臺灣時間二零二六年十一月二十五日上午八點三十分五秒又一百二十三毫秒');
  assert.equal(speechText('2026-11-25 23:40'), '二零二六年十一月二十五日 晚上十一點四十分');
  assert.equal(speechText('12:00'), '中午十二點整');
  assert.equal(speechText('TWD 12,345'), '新臺幣一萬二千三百四十五元');
  assert.equal(speechText('TWD 1,000,001.50'), '新臺幣一百萬零一點五零元');
  assert.equal(speechText('2成人，版本3，有效至2026-11-25'), '二成人，版本三，有效至二零二六年十一月二十五日');
  assert.equal(chineseNumber(101), '一百零一');
  assert.equal(chineseNumber(100000), '十萬');
  assert.equal(chineseNumber(100010), '十萬零一十');
  assert.equal(speechText('預算12,345元'), '預算一萬二千三百四十五元');
});
test('timezones get vetted geographic labels, checkout/URL tokens never enter synthesis', () => {
  assert.equal(speechText('Asia/Taipei／Asia/Tokyo'), '臺灣當地時間、日本當地時間');
  assert.throws(() => speechText('Asia/Unknown'), /vetted/);
  const token = 'a'.repeat(64);
  const canonical = `結帳連結：/checkout/${token}?key=Secret123\nTWD 12,345，版本1，有效至2026-11-25T00:30:00.000Z。不收款、不訂位、不開票。`;
  const spoken = speechText(canonical);
  assert.match(spoken, /結帳連結已放在對話中/);
  assert.doesNotMatch(spoken, /Secret|checkout|a{10}|https/);
  assert.match(spoken, /新臺幣一萬二千三百四十五元，版本一，有效至臺灣時間二零二六年十一月二十五日上午八點三十分/);
  assert.match(spoken, /不收款、不訂位、不開票/);
  assert.equal(speechText(`[結帳](/checkout/${token})`), '結帳連結已放在對話中');
  assert.equal(speechText('https://example.test/?token=123abc'), '連結已放在對話中');
  assert.ok(canonical.includes(token), 'canonical visible link stays intact');
});
test('month/day ranges speak natural Mandarin dates without reinterpreting codes, paths or invalid dates', () => {
  for (const separator of ['–', '-', '—', '~', '～', ' – ']) {
    const canonical = `日期11/26${separator}11/30，DEMO0101`;
    assert.equal(speechText(canonical), '日期十一月二十六號到十一月三十號，D，E，M，O，零，一，零，一');
    assert.ok(canonical.includes(`11/26${separator}11/30`));
  }
  assert.equal(speechText('12/30–1/2'), '十二月三十號到一月二號');
  assert.equal(speechText('02/28–03/01'), '二月二十八號到三月一號');
  assert.equal(speechText(speechText('11/26–11/30')), '十一月二十六號到十一月三十號');
  for (const nonDate of ['13/26–11/30', '11/31–12/1', '2/30–3/1', '0/1–1/2', '11/0–11/30',
    'ABC11/26–11/30', '11/26–11/30XYZ', '/11/26–11/30/file', '2026/11/26–11/30',
    '1.11/26–11/30', '11/26–11/30.5', '1/100–2/100', '11/26', '26/30']) {
    assert.doesNotMatch(speechText(nonDate), /月.*號到/);
  }
  assert.equal(speechText('https://example.test/11/26–11/30?token=123'), '連結已放在對話中');
});
test('voice delivers canonical display facts and normalizes speech once without changing backend identifiers', async () => {
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN; bufferedAmount = 0; sent = [];
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
    event(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  }
  const env = { VOICE_LIVE_ENABLED: 'true', VOICE_LIVE_ENDPOINT: 'https://demo.services.ai.azure.com/' };
  const client = new Socket(), upstream = new Socket(), session = createSession();
  const canonical = '11/26–11/30，DEMO0101，TPE，TWD 12,345，有效至2026-11-25T08:30。不收款。\n\n知識來源（合成示範靜態快照）：flights.txt';
  assert.ok(countWords(canonical) <= 50);
  const bridge = bridgeVoice(client, upstream, session, env, voiceConfig(env), {
    chat: async () => ({ text: canonical, state: { offers: [{ id: 'DEMO0101' }], quote: null } })
  });
  try {
    upstream.emit('open'); upstream.event({ type: 'session.updated' });
    upstream.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '讀一下班號' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.sent.find(event => event.type === 'result').result.text, canonical);
    assert.equal(client.sent.find(event => event.type === 'result').result.state.offers[0].id, 'DEMO0101');
    const requests = upstream.sent.filter(event => event.type === 'response.create');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].response.pre_generated_assistant_message.content[0].text, speechText(canonical));
    assert.doesNotMatch(requests[0].response.pre_generated_assistant_message.content[0].text, /知識來源|flights\.txt/);
    assert.equal(speechText(speechText(canonical)), speechText(canonical), 'already normalized values do not change again');
    upstream.event({ type: 'response.created', response: { id: 'speech-one' } });
    upstream.event({ type: 'input_audio_buffer.speech_started' });
    assert.equal(upstream.sent.at(-1).type, 'response.cancel');
  } finally { bridge.stop(); }
});
