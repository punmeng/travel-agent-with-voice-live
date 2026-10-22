class MicrophonePCM extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.frameSamples = options?.processorOptions?.sdk ? 960 : 2048;
    this.samples = new Int16Array(this.frameSamples); this.offset = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'reset') { this.offset = 0; return; }
      if (event.data?.type !== 'flush') return;
      if (this.offset) this.port.postMessage(this.samples.slice(0, this.offset).buffer);
      this.offset = 0;
      this.port.postMessage({ type: 'flushed' });
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      const value = Math.max(-1, Math.min(1, sample));
      this.samples[this.offset++] = value < 0 ? value * 32768 : value * 32767;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(this.frameSamples); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('microphone-pcm', MicrophonePCM);
