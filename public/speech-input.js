export const MAX_WAV_BYTES = 16000 * 2 * 120 + 65536;

export function readPcmWav(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || buffer.byteLength > MAX_WAV_BYTES) {
    throw new Error('WAV必須為120秒內、8或16 kHz、單聲道PCM16。');
  }
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== buffer.byteLength) {
    throw new Error('音訊檔格式不正確，請選擇其他WAV檔案。');
  }
  let format, pcm;
  let at = 12;
  while (at + 8 <= buffer.byteLength) {
    const length = view.getUint32(at + 4, true), start = at + 8, end = start + length;
    if (end > buffer.byteLength) throw new Error('音訊檔不完整，請重新選擇WAV檔案。');
    if (tag(at) === 'fmt ') {
      if (format || length < 16) throw new Error('音訊檔格式不正確，請選擇其他WAV檔案。');
      format = {
        encoding: view.getUint16(start, true), channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true),
        align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true)
      };
    } else if (tag(at) === 'data') {
      if (pcm) throw new Error('音訊檔格式不正確，請選擇其他WAV檔案。');
      pcm = new Uint8Array(buffer, start, length);
    }
    at = end + (length % 2);
  }
  if (at !== buffer.byteLength) throw new Error('音訊檔不完整，請重新選擇WAV檔案。');
  if (!format || !pcm?.length || format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 ||
      ![8000, 16000].includes(format.sampleRate) || format.align !== 2 ||
      format.byteRate !== format.sampleRate * 2 || pcm.length % 2 || pcm.length > format.byteRate * 120) {
    throw new Error('僅接受120秒內、8或16 kHz、單聲道、未壓縮PCM16 WAV，請轉換格式後重試。');
  }
  return { pcm, sampleRate: format.sampleRate, durationMs: pcm.length / format.byteRate * 1000 };
}

export function resampleMicrophone(buffer) {
  const source = new DataView(buffer);
  const output = new ArrayBuffer(Math.floor(buffer.byteLength / 3) * 2), target = new DataView(output);
  for (let i = 0; i < output.byteLength / 2; i++) {
    const start = i * 1.5, end = start + 1.5;
    let value = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      value += source.getInt16(j * 2, true) * (Math.min(end, j + 1) - Math.max(start, j));
    }
    target.setInt16(i * 2, Math.round(value / 1.5), true);
  }
  return new Uint8Array(output);
}

export async function replayPcm({ pcm, sampleRate, chunkBytes = 1280, canSend, send, signal,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {} }) {
  if (![8000, 16000].includes(sampleRate) || !pcm.length || pcm.length % 2 ||
      !Number.isInteger(chunkBytes) || chunkBytes < 320 || chunkBytes > 6400 || chunkBytes % 2) {
    throw new Error('串流PCM格式或區塊大小無效。');
  }
  let offset = 0;
  while (offset < pcm.length) {
    signal.throwIfAborted();
    if (!canSend()) { await wait(40); continue; }
    const packet = pcm.slice(offset, offset + chunkBytes);
    // Delay each packet by its audio duration; a slow consumer never causes a catch-up burst.
    await wait(packet.length / (sampleRate * 2) * 1000);
    signal.throwIfAborted();
    if (!canSend()) continue;
    send(packet); offset += packet.length;
    onProgress(offset / (sampleRate * 2) * 1000);
  }
}
