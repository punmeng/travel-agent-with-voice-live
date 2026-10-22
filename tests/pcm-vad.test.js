import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmVad } from '../lib/pcm-vad.js';

function pcm(ms, amplitude = 0) {
  const buffer = Buffer.alloc(ms * 48);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(Math.round(amplitude * Math.sin(i / 2 * 0.11) * 32767), i);
  return buffer;
}
const count = (events, type) => events.filter(e => e.type === type).length;
test('silence and calibrated stationary noise stay idle with bounded pre-roll and no segments', () => {
  for (const amplitude of [0, 0.004, 0.03]) {
    const vad = new PcmVad();
    for (let i = 0; i < 200; i++) assert.deepEqual(vad.push(pcm(100, amplitude)), []);
    assert.ok(vad.pre.length <= 25); assert.equal(vad.active, false);
  }
});
test('speech endpoint waits through natural short pauses then finishes once after one second silence', () => {
  const vad = new PcmVad(); vad.push(pcm(400));
  const events = [...vad.push(pcm(300, 0.08)), ...vad.push(pcm(600)), ...vad.push(pcm(300, 0.08)), ...vad.push(pcm(980))];
  assert.equal(count(events, 'start'), 1); assert.equal(count(events, 'end'), 0);
  const end = vad.push(pcm(20));
  assert.equal(count(end, 'end'), 1);
  assert.equal(end.at(-1).reason, 'silence'); assert.equal(vad.active, false);
  assert.equal(count(vad.push(pcm(2000)), 'end'), 0);
});
test('short bursts cannot become a submitted utterance; pre-roll protects onset and frame fragmentation works', () => {
  const vad = new PcmVad(); vad.push(pcm(400));
  assert.deepEqual(vad.push(pcm(80, 0.1)), []);
  assert.equal(count(vad.push(pcm(1200)), 'end'), 0);
  const burst = [...vad.push(pcm(140, 0.1)), ...vad.push(pcm(1000))];
  assert.equal(count(burst, 'discard'), 1); assert.equal(count(burst, 'end'), 0);
  const next = new PcmVad(); next.push(pcm(400));
  const speech = pcm(400, 0.1), events = [];
  for (let offset = 0; offset < speech.length; offset += 128) events.push(...next.push(speech.subarray(offset, offset + 128)));
  assert.equal(count(events, 'start'), 1);
  assert.equal(events.find(e => e.type === 'audio').audio.readInt16LE(0), 0, 'onset includes buffered pre-roll');
  assert.equal(next.eligible, true);
});
test('continuous speech submits at bounded max duration and reset drops stale partial input', () => {
  const vad = new PcmVad(); vad.push(pcm(400));
  const events = [];
  for (let i = 0; i < 290; i++) events.push(...vad.push(pcm(100, 0.1)));
  assert.equal(count(events, 'end'), 1);
  assert.equal(events.find(e => e.type === 'end').reason, 'max-duration');
  vad.reset(); assert.equal(vad.pending.length, 0); assert.equal(vad.eligible, false);
  assert.equal(count(vad.push(pcm(1600)), 'end'), 0);
});
