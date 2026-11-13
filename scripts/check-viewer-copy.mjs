// 작업본(viewerCopy — 편집기가 여는 '모든 변경을 수락한 사본')을 묶음 수락 켬·끔으로 만들어 견준다. acceptAll 의 묶음
// (_acceptBreaksBatch·_acceptInsertsBatch)을 고치거나 더할 때 큰 문서·운영 문서 사본으로 '같은 결과'인지 확인하는 도구
// (npm test 의 tests/viewer_copy_batch.test.mjs 는 작은 fixture 만).
//
//   node scripts/check-viewer-copy.mjs <hwpx...> [--a seq|B|BI] [--b seq|B|BI]
//     seq = 묶음 둘 다 끔(하나씩), B = 나눔 묶음만, BI = 둘 다(지금 길). 기본 --a seq --b BI
//
// 같음 판정: BYTE(구역·머리 XML 같음) > SEMANTIC(문단 글·서식 지문·개체 지문·남은 변경 수·그림 파일·rhwp 쪽마다 글·너그러운 길 id 가 같음) > DIFF.
// 넣음 묶음 하나만 견주려면 --a B --b BI (바이트 같아야 한다). rhwp 는 vendor/rhwp/pkg 를 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const MODE_A = opt('--a', 'seq'); const MODE_B = opt('--b', 'BI');
if (!args.length) { console.error('사용: node scripts/check-viewer-copy.mjs <hwpx...> [--a seq|B|BI] [--b seq|B|BI]'); process.exit(2); }

const pkgDir = path.join(root, 'vendor', 'rhwp', 'pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const rh = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
rh.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });

const P = HwpxDoc.prototype; const realB = P._acceptBreaksBatch; const realI = P._acceptInsertsBatch;
const pageTexts = (bytes) => {
  const d = new rh.HwpDocument(new Uint8Array(bytes)); const out = [];
  for (let i = 0; i < d.pageCount(); i++) {
    const t = JSON.parse(d.getPageRenderTree(i)); const s = [];
    const walk = (x) => { if (typeof x.text === 'string') s.push(x.text); (x.children || []).forEach(walk); };
    walk(t.root || t); out.push(s.join(''));
  }
  return out;
};
async function summary(v) {
  const paras = v.paragraphs({ nested: true, view: 'final' }).map((p) => ({ ref: p.ref, text: p.text }));
  const prints = paras.map((p) => {
    let f = ''; let o = '';
    try { f = v.formattingFingerprint(p.ref); } catch { f = 'ERR'; }
    try { o = /^s\d+\/p\d+$/.test(p.ref) ? v.objectPrint(p.ref) : ''; } catch { o = 'ERR'; }
    return [p.ref, f, o];
  });
  const bytes = await v.save();
  return {
    paras: JSON.stringify(paras), prints: JSON.stringify(prints), changes: String(v.changes().length),
    bins: JSON.stringify((v.container?.list?.() || []).filter((x) => /BinData/.test(x)).sort()),
    pages: JSON.stringify(pageTexts(bytes)), xml: v.sections.map((s) => s.xml).join('\u0000') + v.header.xml,
  };
}
async function viewer(bytes, mode) {
  P._acceptBreaksBatch = mode !== 'seq' ? realB : function () { return null; };
  P._acceptInsertsBatch = mode === 'BI' ? realI : function () { return null; };
  try {
    const d = await HwpxDoc.load(bytes); const t0 = performance.now();
    const v = await d.viewerCopy({ tolerant: true }); const ms = performance.now() - t0;
    return { ms, skips: JSON.stringify(v.lastTolerantSkips || []), ...(await summary(v)) };
  } finally { P._acceptBreaksBatch = realB; P._acceptInsertsBatch = realI; }
}

const counts = { BYTE: 0, SEMANTIC: 0, DIFF: 0 };
for (const f of args) {
  const bytes = fs.readFileSync(f);
  let n = 0; try { n = (await HwpxDoc.load(bytes)).changes().length; } catch { /* 읽지 못하면 아래에서 */ }
  let A; let B;
  try { A = await viewer(bytes, MODE_A); B = await viewer(bytes, MODE_B); } catch (e) { console.log(path.basename(f), 'ERROR', e.code || '', e.message); counts.DIFF++; continue; }
  const keys = ['paras', 'prints', 'changes', 'bins', 'pages', 'skips'];
  const bad = keys.filter((k) => A[k] !== B[k]);
  const kind = A.xml === B.xml ? 'BYTE' : bad.length ? 'DIFF' : 'SEMANTIC';
  counts[kind]++;
  let detail = '';
  if (bad.length) {
    const k = bad[0]; let i = 0; while (i < A[k].length && A[k][i] === B[k][i]) i++;
    detail = `${bad.join(',')} @${i}\n   ${MODE_A}=${JSON.stringify(A[k].slice(Math.max(0, i - 120), i + 120))}\n   ${MODE_B}=${JSON.stringify(B[k].slice(Math.max(0, i - 120), i + 120))}`;
  }
  console.log(path.basename(f).slice(0, 40).padEnd(40), `변경 ${n}`.padStart(9), kind.padEnd(8), `${MODE_A} ${Math.round(A.ms)}ms ${MODE_B} ${Math.round(B.ms)}ms`, detail);
}
console.log(JSON.stringify(counts));
process.exitCode = counts.DIFF ? 1 : 0;
