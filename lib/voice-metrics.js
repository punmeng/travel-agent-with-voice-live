import { performance } from 'node:perf_hooks';

export function voiceMetrics(send, mode, now = () => performance.now()) {
  const origin = now();
  let turn = 0, marks = new Set();
  return {
    begin() { turn++; marks = new Set(); },
    mark(stage) {
      if (marks.has(stage)) return;
      marks.add(stage);
      send({ type: 'measurement', mode, turn, stage, elapsedMs: Math.round((now() - origin) * 10) / 10 });
    }
  };
}
