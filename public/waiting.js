export const WAITING_MESSAGE = '我還在查詢，請稍等一下。';
export function createWaitingNotice(show, {
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = timer => globalThis.clearTimeout(timer)
} = {}) {
  let timer, generation = 0;
  function clear() {
    generation++;
    cancel(timer); timer = undefined;
    show(false, '');
  }
  function start() {
    clear();
    const current = generation;
    timer = schedule(() => {
      if (generation === current) show(true, WAITING_MESSAGE);
    }, 15000);
  }
  return { start, clear };
}
