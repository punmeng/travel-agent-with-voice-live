// Acoustic energy endpointing, not speech recognition or semantic turn detection.
export class PcmVad {
  constructor({ silenceMs = 1000 } = {}) {
    if (![500, 700, 1000, 1200, 1500].includes(silenceMs)) throw new RangeError('Unsupported acoustic silence duration');
    this.silenceMs = silenceMs; this.reset();
  }
  reset() {
    this.pending = Buffer.alloc(0); this.pre = []; this.noise = 0.004;
    this.calibration = 0; this.attack = 0; this.voiced = 0; this.silence = 0; this.duration = 0; this.active = false;
  }
  get eligible() { return this.active && this.voiced >= 200; }
  push(pcm) {
    this.pending = Buffer.concat([this.pending, pcm]);
    const events = [];
    while (this.pending.length >= 960) {
      const frame = Buffer.from(this.pending.subarray(0, 960)); this.pending = this.pending.subarray(960);
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2) sum += (frame.readInt16LE(i) / 32768) ** 2;
      const rms = Math.sqrt(sum / 480);
      if (!this.active) {
        this.pre.push(frame); if (this.pre.length > 25) this.pre.shift();
        if (this.calibration < 300) {
          this.noise = Math.max(0.004, this.noise * 0.5 + rms * 0.5); this.calibration += 20; continue;
        }
        const high = Math.max(0.012, this.noise * 3);
        if (rms >= high) this.attack += 20;
        else { this.attack = 0; this.noise = Math.max(0.002, this.noise * 0.98 + rms * 0.02); }
        if (this.attack < 120) continue;
        this.active = true; this.voiced = this.attack; this.duration = this.pre.length * 20;
        events.push({ type: 'start' }, ...this.pre.map(audio => ({ type: 'audio', audio })));
        this.pre = [];
      } else {
        this.duration += 20;
        if (rms >= Math.max(0.007, this.noise * 2)) { this.voiced += 20; this.silence = 0; }
        else this.silence += 20;
        events.push({ type: 'audio', audio: frame });
        if (this.silence >= this.silenceMs || this.duration >= 28000) {
          const eligible = this.eligible;
          events.push({ type: eligible ? 'end' : 'discard', reason: this.duration >= 28000 ? 'max-duration' : 'silence' });
          this.reset();
          break;
        }
      }
    }
    return events;
  }
}
