// 행 나눔 조판 시험지(scripts/layout-probe-rowsplit.mjs)의 한/글 재저장본에서 사례마다 첫 쪽에 담긴 행 수를 읽는다(앵커 줄 vertpos 로 셈).
// rhwp 와의 비교는 layout-trace(--hangul) 가 정확하다 — 아래 rhwp 칸은 참고용 어림이다.
//   node scripts/layout-probe-rowsplit-read.mjs <out.hwpx> <saved.hwpx>
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
const [,, probe, saved] = process.argv;
const cases = JSON.parse(fs.readFileSync(probe.replace(/\.hwpx$/, '.cases.json'), 'utf8'));
const z = await JSZip.loadAsync(fs.readFileSync(saved));
const x = await z.file('Contents/section1.xml').async('string');
// 최상위 문단 중 표를 단 문단의 마지막 linesegarray(문단 자기 줄)
const hosts = [];
let depth = 0, start = -1;
for (const m of x.matchAll(/<(\/?)hp:p\b[^>]*?(\/?)>/g)) {
  if (m[2]) continue;
  if (!m[1]) { if (depth === 0) start = m.index; depth++; }
  else if (--depth === 0) {
    const p = x.slice(start, m.index);
    if (p.includes('<hp:tbl ')) {
      const own = p.slice(p.lastIndexOf('</hp:tbl>'));
      const segs = [...own.matchAll(/<hp:lineseg ([^>]*)\/>/g)].map((s) => Object.fromEntries([...s[1].matchAll(/(\w+)="(-?\d+)"/g)].map((a) => [a[1], +a[2]])));
      hosts.push(segs);
    }
  }
}
// rhwp
const pkg = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'vendor', 'rhwp', 'pkg');
globalThis.measureTextWidth ??= () => 10;
const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(probe)));
doc.convertToEditable();
const rows = [];
for (let pg = 0; pg < doc.pageCount(); pg++) {
  const tree = JSON.parse(doc.getPageRenderTree(pg));
  (function walk(n) {
    if (/Table/.test(JSON.stringify(n.type ?? '')) && n.bbox) rows.push({ pg, h: n.bbox.h ?? n.bbox.height });
    for (const c of n.children || []) walk(c);
  })(tree);
}
// rhwp 표 조각: 사례마다 2 조각(첫 쪽, 다음 쪽) — 둘째 조각 높이로 다음 쪽 행 수
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const segs = hosts[i] || [];
  const s0 = segs[0];
  const contRows = s0 ? Math.round((s0.vertpos - c.marginBottom) / 1112) : null;
  const hgFit = contRows == null ? null : c.n - contRows;
  const r2 = rows[i * 2 + 1];
  const rhwpCont = r2 ? Math.round(r2.h * 75 / 1112) : null;
  const rhwpFit = rhwpCont == null ? null : c.n - rhwpCont;
  console.log(`${c.variant ?? (c.note ? "note" : "empty")} mb${c.marginBottom} X=${String(c.x).padStart(3)} m=${c.m}: 한/글 첫 쪽 ${hgFit} 행 (line0 vpos ${s0?.vertpos}) | rhwp ${rhwpFit} ${hgFit === rhwpFit ? '' : '  ✗'}`);
}
