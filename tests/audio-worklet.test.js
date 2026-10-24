import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('worklet timestamps streaming capture without changing REST/SDK packet formats or PCM size', () => {
  const source = readFileSync(new URL('../public/audio-worklet.js', import.meta.url), 'utf8');
  for (const options of [{ timestamped: true }, {}, { sdk: true }]) {
    const sent = [];
    let Processor;
    const sandbox = {
      AudioWorkletProcessor: class { port = { postMessage: value => sent.push(value) }; },
      currentTime: 4.25,
      registerProcessor: (_name, constructor) => { Processor = constructor; }
    };
    vm.runInNewContext(source, sandbox);
    const processor = new Processor({ processorOptions: options });
    processor.process([[new Float32Array(options.sdk ? 960 : 2048)]]);
    assert.equal(sent.length, 1);
    if (options.timestamped) assert.equal(sent[0].capturedAt, 4.25);
    const audio = sent[0].audio ?? sent[0];
    assert.equal(audio.byteLength, options.sdk ? 1920 : 4096);
  }
});
