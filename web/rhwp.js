// @rhwp/core(WASM) 한 번만 불러오기. 레이아웃 전에 글자 폭 측정 함수(canvas)를 꼭 등록해야 한다.
let ready = null;

export function loadRhwp() {
  if (!ready) {
    ready = (async () => {
      const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
      const cache = new Map();
      globalThis.measureTextWidth = (font, text) => {
        if (ctx.font !== font) ctx.font = font;
        if (text.length > 1) return ctx.measureText(text).width;
        const k = font + '\u0000' + text; let w = cache.get(k);
        if (w === undefined) { w = ctx.measureText(text).width; if (cache.size > 20000) cache.clear(); cache.set(k, w); }
        return w;
      };
      const mod = await import('/vendor/rhwp-core/rhwp.js');
      await mod.default({ module_or_path: '/vendor/rhwp-core/rhwp_bg.wasm' });
      return mod;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

/** HWPX 바이트 → HwpDocument */
export async function openHwpx(bytes) {
  const mod = await loadRhwp();
  return new mod.HwpDocument(new Uint8Array(bytes));
}
