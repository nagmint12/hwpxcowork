import { compressHwpx, HwpxCompressionCache } from './compress-hwpx.mjs';

// Serialize requests so two simultaneous save/export calls do not run two
// compressors and compete for CPU and memory on a small machine.
let pending = Promise.resolve();
const cache = new HwpxCompressionCache();
let generation = 0;
self.onmessage = (event: MessageEvent<{ id?: number; kind?: 'compress' | 'prime' | 'reset'; generation?: number; bytes?: Uint8Array }>) => {
  const { id, kind = 'compress', generation: requested = 0, bytes } = event.data;
  pending = pending.then(async () => {
    if (requested !== generation) { cache.clear(); generation = requested; }
    if (kind === 'reset') { cache.clear(); return; }
    if (kind === 'prime') {
      // HWP/password-protected inputs may not be ZIPs. Cache preparation is
      // optional and must never prevent opening or saving those documents.
      try { if (bytes) await cache.prime(bytes); } catch { cache.clear(); }
      return;
    }
    try {
      if (!bytes) throw new Error('저장할 문서가 없습니다');
      const result: Uint8Array = await compressHwpx(bytes, cache);
      self.postMessage({ id, bytes: result }, { transfer: [result.buffer] });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
