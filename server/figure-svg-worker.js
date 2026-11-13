// SVG → PNG 를 그리는 별도 스레드(server/figure-svg.js 가 그림마다 띄우고, 시간이 넘으면 끝낸다).
// resvg(WASM)는 파일·네트워크에 닿지 않는다 — 외부 주소의 그림·글꼴·스크립트는 무시되고, 글꼴은 넘겨준 파일만 쓴다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const require = createRequire(import.meta.url);
const MAX_SIDE = 6000;    // PNG 한 변 최대 픽셀
const MAX_PIXELS = 24e6;  // PNG 전체 픽셀

try {
  // dpi = PNG 해상도(보이는 폭 기준) — 문서에 넣을 그림은 300, 미리보기(preview_figure)는 낮게
  const { svg, widthMm = null, maxWidthMm = 300, dpi = 300, fonts = [] } = workerData;
  const DPI = Math.max(48, Math.min(300, Number(dpi) || 300));
  await initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  const fontBuffers = [];
  for (const file of fonts) { try { fontBuffers.push(new Uint8Array(fs.readFileSync(file))); } catch { /* 없는 글꼴은 건너뛴다 */ } }
  const font = { fontBuffers, defaultFontSize: 16 };
  // 첫 번째 그리기: SVG 의 고유 크기(px, 96dpi) — width·height 가 없으면 viewBox 크기
  const probe = new Resvg(svg, { font });
  const w0 = probe.width; const h0 = probe.height; probe.free();
  if (!(w0 > 0 && h0 > 0)) throw Object.assign(new Error('SVG 크기를 알 수 없습니다(width·height 또는 viewBox 를 주세요)'), { code: 'BAD_SVG' });
  const mm = Math.max(10, Math.min(maxWidthMm, Number(widthMm) > 0 ? Number(widthMm) : (w0 * 25.4) / 96));
  let px = Math.round((mm / 25.4) * DPI);
  // 한 변·전체 픽셀 한도 안으로(가로세로 비율 유지)
  px = Math.min(px, MAX_SIDE, Math.floor((MAX_SIDE * w0) / h0), Math.floor(Math.sqrt((MAX_PIXELS * w0) / h0)));
  px = Math.max(16, px);
  const resvg = new Resvg(svg, { font, fitTo: { mode: 'width', value: px }, background: 'white', shapeRendering: 2, textRendering: 1, imageRendering: 0 });
  const image = resvg.render();
  const png = image.asPng();
  parentPort.postMessage({ ok: true, png, width: image.width, height: image.height, widthMm: Math.round(mm * 10) / 10, intrinsic: [w0, h0] }, [png.buffer]);
  image.free(); resvg.free();
} catch (e) {
  parentPort.postMessage({ ok: false, code: e?.code || 'BAD_SVG', message: String(e?.message || e) });
}
