// 조판 추적 — 한 HWPX 를 rhwp 가 어떻게 쪽·줄로 나눴는지, 한/글과 어디서 처음 갈라지는지 문단 단위로 보여 준다.
//
//   node scripts/layout-trace.mjs <문서.hwpx> [--hangul <한글 결과 폴더 | saved.hwpx>] [--run-hangul] [--pdf <한글.pdf>]
//                                 [--all] [--from N] [--to M] [--json <out.json>]
//   npm run layout:trace -- testdata/매크로테스트용_다운.hwpx --run-hangul
//
// 기준(한/글):
//   - 한/글이 다시 저장한 HWPX(saved.hwpx)의 linesegarray — 줄마다 한/글이 정한 vertpos(쪽 본문 위 기준)·vertsize·spacing·
//     horzpos·horzsize. vertpos 가 되돌아가면 새 쪽(또는 새 단)이다. 글이 그림을 피해 흐른 자리(horzpos/horzsize)도 여기 있다.
//   - 한/글 쪽 그림(CreatePageImage, 인쇄 없음) — 그림 상자(쪽·x·y·폭·높이)와 문단 쪽 번호. 저장본에는 개체 자리가 없으므로 그림 위치는
//     쪽 그림으로 본다. 그림마다 표식 색 그림으로 바꾼 사본을 한/글로 연다(scripts/hangul-oracle.mjs — 조판은 원본과 같다).
//   `--run-hangul` 은 이 PC 의 한/글에서 둘 다 만든다(임시 폴더, 한/글 COM — Windows 전용).
//   `--pdf <한글.pdf>` 는 예전 PDF 결과를 진단으로 볼 때만 쓴다(회귀 기준은 쪽 그림).
// rhwp:
//   - getLayoutTrace() — 엔진이 실제로 쓴 줄 값(저장 줄인지 합성 줄인지)·개체 배치 속성·쪽별 조판 항목.
//   - getPageRenderTree() — 실제로 그린 줄(TextLine)·그림·표의 쪽과 y.
// 출력: 문단마다 [rhwp 쪽·y·줄 수·줄높이/줄간격] ↔ [한/글 쪽·vertpos·…], 다른 칸에 표시. 처음 갈라진 문단에는 그 쪽의 남은
// 높이와 그 문단이 요구한 높이를 나란히 적어 "어느 값 때문에" 넘어갔는지 보이게 한다. HWPUNIT(HU) = 1/7200 인치, 75HU = 1px(96dpi).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HU_PER_PX = 75;

function parseArgs(argv) {
  const o = { file: null, hangul: null, pdf: null, runHangul: false, all: false, from: 0, to: Infinity, json: null, pkg: process.env.RHWP_PKG || path.join(root, 'vendor', 'rhwp', 'pkg'), tol: 1.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hangul') o.hangul = argv[++i];
    else if (a === '--pdf') o.pdf = argv[++i];
    else if (a === '--run-hangul') o.runHangul = true;
    else if (a === '--all') o.all = true;
    else if (a === '--from') o.from = Number(argv[++i]);
    else if (a === '--to') o.to = Number(argv[++i]);
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--pkg') o.pkg = argv[++i];
    else if (a === '--tol') o.tol = Number(argv[++i]);
    else if (a === '--oracle') o.oracle = argv[++i];
    else if (a === '--save-oracle') o.saveOracle = argv[++i];
    else if (a === '--decisions') o.decisions = true;
    else if (!o.file) o.file = a;
  }
  return o;
}

// ── rhwp ───────────────────────────────────────────────────────────────────
let engine = null;
export async function loadEngine(pkgDir) {
  if (engine) return engine;
  if (typeof globalThis.measureTextWidth !== 'function') globalThis.measureTextWidth = (font, text) => text.length * 10; // 그리기용 스텁(조판은 엔진 내장 폭)
  engine = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
  // 같은 엔진을 이미 띄운 쪽(시험 파일)이 있으면 다시 초기화하지 않는다.
  if (!globalThis.__rhwpEngineReady?.has(pkgDir)) {
    engine.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });
    (globalThis.__rhwpEngineReady ??= new Set()).add(pkgDir);
  }
  return engine;
}

/** rhwp 조판 — 문단별 줄(엔진 값 + 실제로 그린 자리)과 개체 상자. 구역마다 따로. */
export async function rhwpLayout(file, pkgDir, { decisions = false } = {}) {
  const mod = await loadEngine(pkgDir);
  const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(file)));
  try {
    doc.convertToEditable(); // 편집기와 같은 경로
    const pageCount = doc.pageCount();
    const trace = JSON.parse(doc.getLayoutTrace());
    const pageSection = trace.pages.map((p) => p.section);
    const drawn = new Map(); // `${sec}/${pi}` → {lines:[{page,y,h,x,w}], objects:[{page,ci,type,x,y,w,h}]}
    const at = (sec, pi) => {
      const k = `${sec}/${pi}`;
      if (!drawn.has(k)) drawn.set(k, { lines: [], objects: [] });
      return drawn.get(k);
    };
    const pages = [];
    for (let pg = 0; pg < pageCount; pg++) {
      const tree = JSON.parse(doc.getPageRenderTree(pg));
      const sec = pageSection[pg] ?? 0;
      let column = null;
      // 캡션 줄은 `captionOwner` 를 달고 나오지만, 같은 줄의 조각(메모 표식 등)이 표식 없이 따로 나올 수 있다 — 같은 y 는 캡션으로 본다.
      const captionYs = [];
      const findCaptions = (n) => { if (n.type === 'TextLine' && n.captionOwner) captionYs.push(n.bbox.y); for (const c of n.children || []) findCaptions(c); };
      findCaptions(tree);
      const walk = (n, inside) => {
        if (n.type === 'Column') column = n.bbox;
        const nested = inside || ['Table', 'Cell', 'TextBox', 'Header', 'Footer', 'FootnoteArea', 'Footnote'].includes(n.type);
        // 표 앵커의 빈 줄은 TextLine.pi 가 0 으로 나오고 글조각(TextRun)에만 제 문단 번호가 있다 — 글조각 쪽을 믿는다.
        const runPi = n.children?.find((c) => c.type === 'TextRun' && c.pi != null)?.pi;
        const linePi = n.pi === 0 && runPi != null ? runPi : n.pi;
        if (!inside && n.type === 'TextLine' && linePi != null && !n.captionOwner && !(linePi === 0 && captionYs.some((y) => Math.abs(y - n.bbox.y) < 0.5))) {
          at(sec, linePi).lines.push({ page: pg, y: n.bbox.y, h: n.bbox.h, x: n.bbox.x - (column?.x ?? 0), w: n.bbox.w });
        }
        if (!inside && ['Image', 'Table', 'Shape', 'Group', 'Equation', 'Line', 'Rect', 'Ellipse'].includes(n.type) && n.pi != null && n.ci != null) {
          at(sec, n.pi).objects.push({ page: pg, ci: n.ci, type: n.type, x: n.bbox.x, y: n.bbox.y, w: n.bbox.w, h: n.bbox.h });
        }
        for (const c of n.children || []) walk(c, nested);
      };
      walk(tree, false);
      const body = tree.children?.find((c) => c.type === 'Body')?.bbox;
      pages.push({ index: pg, section: sec, body, images: collectImages(tree) });
    }
    // 쪽 나눔 결정 기록(엔진의 흐름 높이를 바꾼 소스 줄·쪽 넘김·항목) — 다시 쪽 나눔하므로 요청할 때만.
    const events = decisions ? JSON.parse(doc.getLayoutDecisions()) : null;
    return { pageCount, trace, drawn, pages, events };
  } finally {
    doc.free();
  }
}

function collectImages(tree) {
  const out = [];
  const walk = (n, inCell) => {
    if (n.type === 'Image' && !inCell) out.push([n.bbox.x, n.bbox.y, n.bbox.x + n.bbox.w, n.bbox.y + n.bbox.h, n.pi, n.ci]);
    for (const c of n.children || []) walk(c, inCell || n.type === 'Cell');
  };
  walk(tree, false);
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

// ── 한/글 기준 ──────────────────────────────────────────────────────────────
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };

/** 최상위 문단(<hs:sec> 바로 아래 <hp:p>)의 linesegarray. 중첩 문단(표 칸·글상자·캡션)의 줄은 빼고 센다. */
export function topLevelParagraphs(xml) {
  const out = [];
  const re = /<hp:p\b[^>]*?(\/?)>|<\/hp:p>|<hp:linesegarray>([\s\S]*?)<\/hp:linesegarray>|<hp:t>([^<]*)<\/hp:t>|<hp:(pic|tbl|rect|ellipse|line|container|equation|ole|polygon|curve|arc|textart)\b([^>]*)>|<hp:pos\b([^>]*)\/>|<hp:sz\b([^>]*)\/>/g;
  let depth = 0; let cur = null; let pendingObj = null;
  for (const m of xml.matchAll(re)) {
    const t = m[0];
    if (t.startsWith('<hp:p ') || t === '<hp:p>') {
      if (m[1] === '/') { if (depth === 0) out.push({ lines: [], text: '', objects: [] }); continue; }
      depth++;
      if (depth === 1) cur = { lines: [], text: '', objects: [] };
    } else if (t === '</hp:p>') {
      if (depth === 1) { out.push(cur); cur = null; }
      depth--;
    } else if (m[2] != null) {
      if (depth === 1 && cur) {
        for (const s of m[2].matchAll(/<hp:lineseg\b([^>]*)\/>/g)) {
          const a = s[1];
          cur.lines.push({ textpos: +attr(a, 'textpos'), vpos: +attr(a, 'vertpos'), lh: +attr(a, 'vertsize'), th: +attr(a, 'textheight'), bl: +attr(a, 'baseline'), ls: +attr(a, 'spacing'), x: +attr(a, 'horzpos'), w: +attr(a, 'horzsize'), flags: +attr(a, 'flags') });
        }
      }
    } else if (m[3] != null) {
      if (depth === 1 && cur && cur.text.length < 40) cur.text += m[3].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    } else if (m[4]) {
      if (depth === 1 && cur) { pendingObj = { kind: m[4], wrap: attr(m[5], 'textWrap') }; cur.objects.push(pendingObj); } else pendingObj = null;
    } else if (m[6] != null) {
      if (pendingObj && !('tac' in pendingObj)) Object.assign(pendingObj, { tac: attr(m[6], 'treatAsChar') === '1', vertRelTo: attr(m[6], 'vertRelTo'), horzRelTo: attr(m[6], 'horzRelTo'), vertOffset: +attr(m[6], 'vertOffset'), horzOffset: +attr(m[6], 'horzOffset') });
    } else if (m[7] != null) {
      if (pendingObj && !('height' in pendingObj)) Object.assign(pendingObj, { width: +attr(m[7], 'width'), height: +attr(m[7], 'height') });
    }
  }
  return out;
}

/** 한/글 줄에 쪽 번호를 매긴다 — vertpos 가 앞 줄보다 작아지면 새 쪽(구역이 바뀌어도 새 쪽, 다단은 단마다 센다).
 *  쪽을 거의 채운 글자처럼 취급 그림 문단은 한/글이 뒤에 겹친 빈 줄(vertpos 1100 등)을 하나 더 적어, 다음 쪽 첫 문단이
 *  그보다 큰 vertpos 로 시작하면 되감김이 안 보인다 — 한/글 결과 폴더가 있으면 `alignPagesWithParaPages`(hangul-oracle.mjs)가 한/글 문단 쪽 번호로 바로잡는다. */
function assignHangulPages(sections) {
  let page = -1;
  for (const sec of sections) {
    page++;
    let last = null;
    for (const p of sec.paragraphs) {
      for (const l of p.lines) {
        if (last != null && l.vpos < last) page++;
        l.page = page;
        last = l.vpos;
      }
    }
  }
  return page + 1;
}

const squash = (t) => (t || '').replace(/\s+/g, '');

/** (진단용) PDF 글줄로 한/글 쪽을 바로잡는다 — 글이 있는 문단마다 첫 글자 몇 개가 처음 나오는 쪽(현재 추정 쪽부터 앞으로)을 찾아
 *  그 뒤 문단들의 쪽에 차이를 더한다. 찾지 못한 문단은 추정을 그대로 둔다. */
export function alignPagesWithPdf(hangul, pdf) {
  const pageText = pdf.pages.map((p) => p.lines.map((l) => squash(l[3])));
  let delta = 0;
  for (const sec of hangul.sections) {
    for (const p of sec.paragraphs) {
      if (!p.lines.length) continue;
      const key = squash(p.text).slice(0, 8);
      if (key.length >= 4) {
        const guess = p.lines[0].page + delta;
        // 추정 쪽을 먼저 보고, 없을 때만 앞뒤 쪽을 찾는다(같은 글이 여러 쪽에 되풀이되는 문서).
        for (const pg of [guess, guess + 1, guess - 1, guess + 2]) {
          if (pg >= 0 && pg < pageText.length && pageText[pg].some((t) => t.includes(key))) { delta = pg - p.lines[0].page; break; }
        }
      }
      for (const l of p.lines) l.page += delta;
    }
  }
  hangul.pageCount = Math.max(hangul.pageCount + delta, ...hangul.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.lines.map((l) => l.page + 1))));
}

export async function hangulLayout(savedHwpx) {
  const zip = await JSZip.loadAsync(fs.readFileSync(savedHwpx));
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const sections = [];
  for (const n of names) sections.push({ paragraphs: topLevelParagraphs(await zip.file(n).async('string')) });
  const pageCount = assignHangulPages(sections);
  return { sections, pageCount };
}

/** 표 측정 누락과 "실제로 표가 없는 쪽"을 구분한다. 오래된 그림 전용 기준은 표를 요구하지 않을 때만 읽는다. */
export function validateLayoutOracle(oracle, { requireTables = false, source = oracle.doc || '한/글 기준 JSON' } = {}) {
  const fail = (detail) => { throw new Error(`${source}: ${detail}. node scripts/layout-trace.mjs <문서.hwpx> --run-hangul --save-oracle <기준.json>으로 한/글 기준을 다시 측정하세요`); };
  for (const key of ['images', 'tables']) {
    const groups = oracle[key];
    if (groups == null) {
      if (key === 'tables' && requireTables) fail('필수 tables(표 상자 측정값)가 없습니다');
      continue;
    }
    if (!Array.isArray(groups) || !Number.isInteger(oracle.hangulPages) || groups.length !== oracle.hangulPages) fail(`${key}의 쪽 수가 hangulPages와 다릅니다`);
    groups.forEach((boxes, pg) => {
      if (!Array.isArray(boxes)) fail(`${key}[${pg}] 측정값이 없습니다(표/그림이 없는 쪽은 []로 기록)`);
      for (const box of boxes) {
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) fail(`${key}[${pg}]에 잘못된 상자가 있습니다`);
      }
    });
  }
  return oracle;
}

/** 기준 JSON(tests/fixtures/layout/*_hangul.json) — 한/글 줄·그림 상자를 저장해 두고 한/글 없이 다시 견준다. view = 한/글 쪽 그림 결과. */
export function oracleFromHangul(doc, hangul, view, extra = {}) {
  const oracle = {
    doc,
    made: new Date().toISOString().slice(0, 10),
    note: '한/글이 다시 저장한 linesegarray(구역별 문단의 줄: [쪽, vpos, lh, ls, horzpos, horzsize], 쪽은 한/글 문단 쪽 번호로 바로잡음) + 한/글 CreatePageImage(96dpi, 인쇄 없음) 표식 그림·표 상자(px, 쪽마다 최상위 개체). scripts/layout-trace.mjs --save-oracle 로 만든다.',
    oracle: 'Hancom CreatePageImage',
    hangulPages: view ? view.pages.length : null,
    ...extra,
    sections: hangul.sections.map((s) => s.paragraphs.map((p) => p.lines.map((l) => [l.page, l.vpos, l.lh, l.ls, l.x, l.w]))),
    images: view ? view.pages.map((p) => p.images) : null,
    tables: view ? view.pages.map((p) => p.tables) : null,
  };
  return validateLayoutOracle(oracle, { requireTables: !!view });
}

export function hangulFromOracle(oracle) {
  validateLayoutOracle(oracle);
  const sections = oracle.sections.map((paras) => ({
    paragraphs: paras.map((lines) => ({ text: '', objects: [], lines: lines.map(([page, vpos, lh, ls, x, w]) => ({ page, vpos, lh, ls, x, w })) })),
  }));
  const pageCount = Math.max(1, ...sections.flatMap((s) => s.paragraphs.flatMap((p) => p.lines.map((l) => l.page + 1))));
  const view = oracle.images ? { pages: oracle.images.map((images, i) => ({ images, tables: oracle.tables?.[i], lines: [] })) } : null;
  return { hangul: { sections, pageCount }, view };
}

export function hangulPdfBoxes(pdf) {
  const out = execFileSync('python', ['-I', path.join(here, 'hangul-pdf-boxes.py'), pdf], { maxBuffer: 64 << 20 });
  return JSON.parse(out.toString('utf8'));
}

/** 한/글 결과 폴더(scripts/hangul-oracle.mjs 의 runHangulOracle) → 쪽 그림 보기 { pages: [{ images, lines }] } 와 문단 쪽 번호. */
export async function hangulView(dir) {
  const { readHangulOracle } = await import('./hangul-oracle.mjs');
  const o = readHangulOracle(dir);
  return { pages: o.images.map((images, i) => ({ images, tables: o.tables?.[i], lines: [] })), paraPages: o.paraPages, oracle: o };
}

// ── 비교 ───────────────────────────────────────────────────────────────────
const fmtHU = (v) => (v == null ? '-' : String(Math.round(v)));

/** 문단 하나의 비교 행. y·vpos 는 쪽 본문 위 기준 HU. */
export function compareParagraph(sec, pi, r, h, rp, ctx) {
  const rLines = (r?.lines || []).map((l) => ({ page: l.page, vpos: (l.y - ctx.bodyTopPx(l.page)) * HU_PER_PX, lh: l.h * HU_PER_PX, x: l.x * HU_PER_PX, w: l.w * HU_PER_PX }));
  const rObjs = r?.objects || [];
  // TAC 그림만 있는 줄은 TextLine 으로 그린다. 줄이 없는 개체 문단(앵커만)은 개체 쪽으로 본다.
  const rPage = rLines[0]?.page ?? rObjs[0]?.page ?? null;
  const hLines = h?.lines || [];
  const hPage = hLines[0]?.page ?? null;
  const tolHU = ctx.tol * HU_PER_PX;
  const diffs = [];
  if (h) {
    // 앵커 줄을 그리지 않았다 — 한/글도 폭 0(개체 띠에 겹친 보이지 않는 줄)이면 차이가 아니다.
    if (!rLines.length && hLines.length && rObjs.length) { if (hLines[0].w > 0) diffs.push('앵커줄 안 그림'); }
    else if (rPage != null && hPage != null && rPage !== hPage) diffs.push('쪽');
    if (rLines.length && hLines.length && rLines.length !== hLines.length) diffs.push('줄수');
    const n = Math.min(rLines.length, hLines.length);
    for (let i = 0; i < n; i++) {
      if (rLines[i].page !== hLines[i].page) { diffs.push(`${i + 1}줄쪽`); break; }
      if (Math.abs(rLines[i].vpos - hLines[i].vpos) > tolHU) { diffs.push(`${i + 1}줄y`); break; }
    }
    for (let i = 0; i < n; i++) {
      // 한/글이 폭 0 으로 저장한 줄은 개체 띠에 겹친 빈 앵커 줄이다 — 그릴 글이 없어 x/폭을 견주지 않는다.
      // rhwp 의 빈 줄(글 없는 앵커 줄)은 14.7px 자리표만 그린다 — 역시 견주지 않는다.
      if (hLines[i].w === 0 || rLines[i].w < 20 * HU_PER_PX) continue;
      if (Math.abs(rLines[i].x - hLines[i].x) > tolHU || Math.abs(rLines[i].w - hLines[i].w) > tolHU * 2) { diffs.push(`${i + 1}줄x/폭`); break; }
    }
  }
  return { sec, pi, text: rp?.text ?? h?.text ?? '', rp, rLines, rObjs, rPage, hLines, hPage, diffs };
}

function describeObjects(rp) {
  return (rp?.objects || []).map((o) => {
    const wrap = { TopAndBottom: '위아래', Square: '어울림', BehindText: '글뒤', InFrontOfText: '글앞', Tight: '빈틈', Through: '자리' }[o.wrap] ?? o.wrap;
    const cap = o.caption ? ` 캡션${o.caption.side === 'Bottom' ? '↓' : o.caption.side === 'Top' ? '↑' : o.caption.side}` : '';
    const m = o.margin?.some((v) => v) ? ` 여백${o.margin.join('/')}` : '';
    return `${o.kind}${o.tac ? '(글자처럼)' : `(${wrap} ${o.vertRelTo}${o.vertOffset ? '+' + o.vertOffset : ''})`} ${o.width}×${o.height}${m}${cap}`;
  }).join(', ');
}

/** 처음 갈라진 문단의 까닭 — 한/글 쪽에서 남은 높이와 그 문단이 요구한 높이. */
function explain(row, prevRow, ctx) {
  const notes = [];
  const bodyH = ctx.bodyHeightHU;
  const h0 = row.hLines[0];
  const r0 = row.rLines[0];
  const prevH = prevRow?.hLines.at(-1);
  const prevR = prevRow?.rLines.at(-1);
  const rSeg = row.rp?.lines?.[0];
  if (row.diffs.includes('쪽') || row.diffs.includes('1줄쪽')) {
    const need = h0 ? h0.lh : rSeg?.lh;
    if (prevH) {
      const end = prevH.vpos + prevH.lh + prevH.ls;
      notes.push(`한/글: 앞 문단 끝 ${end} HU(쪽 ${prevH.page + 1}) → 남은 높이 ${bodyH - end} HU, 이 문단 첫 줄 높이 ${need} HU → ${h0 && h0.page !== prevH.page ? '다음 쪽' : '같은 쪽'}`);
    }
    if (prevR && rSeg) {
      const end = prevR.vpos + prevR.lh;
      notes.push(`rhwp: 앞 문단 마지막 줄 끝 ${Math.round(end)} HU(쪽 ${prevR.page + 1}), 이 문단 엔진 줄 lh ${rSeg.lh}·ls ${rSeg.ls}${rSeg.synthetic ? '(합성 줄)' : '(저장 줄)'} → 쪽 ${row.rPage + 1}`);
    }
  } else if (h0 && r0) {
    notes.push(`첫 줄 y: 한/글 ${h0.vpos} ↔ rhwp ${Math.round(r0.vpos)} HU (차 ${Math.round(r0.vpos - h0.vpos)} HU = ${((r0.vpos - h0.vpos) / HU_PER_PX).toFixed(1)}px)`);
    if (prevH && prevR) notes.push(`앞 문단 끝줄: 한/글 vpos ${prevH.vpos} lh ${prevH.lh} ls ${prevH.ls} ↔ rhwp y ${Math.round(prevR.vpos)} lh ${Math.round(prevR.lh)}`);
    if (rSeg) notes.push(`이 문단 엔진 첫 줄: lh ${rSeg.lh} ls ${rSeg.ls}${rSeg.synthetic ? ' (합성 줄)' : ' (저장 줄)'} ↔ 한/글 lh ${h0.lh} ls ${h0.ls}`);
  }
  const obj = describeObjects(row.rp);
  if (obj) notes.push(`개체: ${obj}`);
  return notes;
}

export function compareImages(rhwp, view, tolPx) {
  const out = [];
  const n = Math.max(rhwp.pages.length, view.pages.length);
  for (let pg = 0; pg < n; pg++) {
    const a = view.pages[pg]?.images || [];
    const b = rhwp.pages[pg]?.images || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const ha = a[i]; const rb = b[i];
      const bad = !ha || !rb || [0, 1, 2, 3].some((k) => Math.abs(ha[k] - rb[k]) > tolPx);
      out.push({ page: pg, idx: i, hangul: ha ? ha.slice(0, 4) : null, rhwp: rb ? rb.slice(0, 4).map((v) => +v.toFixed(2)) : null, pi: rb?.[4], ci: rb?.[5], ok: !bad });
    }
  }
  return out;
}

export async function layoutTrace(opts) {
  const rhwp = await rhwpLayout(opts.file, opts.pkg ?? path.join(root, 'vendor', 'rhwp', 'pkg'), { decisions: !!opts.decisions });
  let hangul = null; let view = null; let hangulDir = null;
  if (opts.oracle) ({ hangul, view } = hangulFromOracle(typeof opts.oracle === 'string' ? JSON.parse(fs.readFileSync(opts.oracle, 'utf8')) : opts.oracle));
  if (opts.runHangul) { const { runHangulOracle } = await import('./hangul-oracle.mjs'); hangulDir = await runHangulOracle(opts.file, { tables: true }); }
  if (opts.hangul) hangulDir = opts.hangul;
  if (hangulDir) {
    const isDir = fs.statSync(hangulDir).isDirectory();
    hangul = await hangulLayout(isDir ? path.join(hangulDir, 'saved.hwpx') : hangulDir);
    if (isDir && fs.existsSync(path.join(hangulDir, 'page_images.json')) && fs.existsSync(path.join(hangulDir, 'markers.json'))) {
      view = await hangulView(hangulDir);
      const { alignPagesWithParaPages } = await import('./hangul-oracle.mjs');
      alignPagesWithParaPages(hangul, view.paraPages);
    } else if (isDir && !opts.pdf && fs.existsSync(path.join(hangulDir, 'view.pdf'))) opts.pdf = path.join(hangulDir, 'view.pdf'); // 예전 결과 폴더(진단)
  }
  if (opts.pdf) { view = hangulPdfBoxes(opts.pdf); if (hangul) alignPagesWithPdf(hangul, view); }

  const rows = [];
  rhwp.trace.sections.forEach((sec, si) => {
    const bodyTopPx = (pg) => rhwp.pages[pg]?.body?.y ?? sec.bodyTopPx;
    const ctx = { bodyTopPx, bodyHeightHU: sec.bodyHeightHU, tol: opts.tol ?? 1.5 };
    const hsec = hangul?.sections[si];
    const n = Math.max(sec.paragraphs.length, hsec?.paragraphs.length ?? 0);
    for (let pi = 0; pi < n; pi++) rows.push({ ...compareParagraph(si, pi, rhwp.drawn.get(`${si}/${pi}`), hsec?.paragraphs[pi], sec.paragraphs[pi], ctx), ctx });
  });
  const firstDiff = rows.findIndex((r) => r.diffs.length);
  const images = view ? compareImages(rhwp, view, (opts.tol ?? 1.5) + 0.5) : null;
  return { rhwp, hangul, view, rows, firstDiff, images, hangulDir };
}

function print(res, opts) {
  const { rhwp, hangul, rows, firstDiff, images } = res;
  const sec0 = rhwp.trace.sections[0];
  console.log(`문서: ${opts.file}`);
  console.log(`쪽 수: rhwp ${rhwp.pageCount}${hangul ? ` / 한/글 ${hangul.pageCount}` : ''}${res.view ? ` (한/글 쪽 그림 ${res.view.pages.length})` : ''}   본문 높이 ${sec0.bodyHeightHU} HU = ${(sec0.bodyHeightHU / HU_PER_PX).toFixed(1)}px`);
  if (res.hangulDir) console.log(`한/글 기준: ${res.hangulDir}`);
  if (hangul) {
    const hp = hangul.sections.reduce((a, s) => a + s.paragraphs.length, 0);
    const rp = rhwp.trace.sections.reduce((a, s) => a + s.paragraphs.length, 0);
    if (hp !== rp) console.log(`!! 문단 수가 다릅니다: rhwp ${rp} / 한/글 ${hp} — 같은 차례 번호로 견준다`);
  }
  console.log('');
  console.log('  문단 | rhwp 쪽  첫줄y(HU)  줄  엔진 lh/ls      | 한/글 쪽  vpos   줄  lh/ls        | 다른 칸     | 글·개체');
  const diffCount = rows.filter((r) => r.diffs.length).length;
  const show = (r, i) => opts.all || r.diffs.length || (firstDiff >= 0 && Math.abs(i - firstDiff) <= 1);
  rows.forEach((r, i) => {
    if (r.pi < opts.from || r.pi > opts.to || !show(r, i)) return;
    const seg = r.rp?.lines?.[0];
    const eng = seg ? `${seg.lh}/${seg.ls}${seg.synthetic ? '합성' : ''}` : '-';
    const h0 = r.hLines[0];
    const label = `${r.sec ? r.sec + ':' : ''}${r.pi}`.padStart(6);
    const left = `${r.rPage != null ? String(r.rPage + 1).padStart(3) : '  -'}  ${fmtHU(r.rLines[0]?.vpos).padStart(9)}  ${String(r.rLines.length).padStart(3)}  ${eng.padEnd(14)}`;
    const right = hangul ? `${r.hPage != null ? String(r.hPage + 1).padStart(3) : '  -'}  ${fmtHU(h0?.vpos).padStart(6)}  ${String(r.hLines.length).padStart(3)}  ${(h0 ? `${h0.lh}/${h0.ls}` : '-').padEnd(12)}` : '';
    const mark = i === firstDiff ? '▶' : ' ';
    const what = (r.text || '').replace(/\s+/g, ' ').slice(0, 24) + ((r.rp?.objects?.length) ? ` [${describeObjects(r.rp)}]` : '');
    console.log(`${mark}${label} | ${left} | ${right} | ${(r.diffs.join(',') || '').padEnd(11)} | ${what}`);
  });
  console.log('');
  if (!hangul) {
    console.log('(한/글 기준 없음 — --hangul <폴더> 또는 --run-hangul 로 비교한다)');
  } else if (firstDiff < 0) {
    console.log(`모든 문단의 쪽·줄 수·첫 줄 y(±${opts.tol}px)·줄 x/폭이 한/글과 같다.`);
  } else {
    const r = rows[firstDiff];
    console.log(`처음 갈라진 곳: 구역 ${r.sec} 문단 ${r.pi} (${r.diffs.join(', ')}) — 다른 문단 ${diffCount}개`);
    for (const n of explain(r, rows[firstDiff - 1]?.sec === r.sec ? rows[firstDiff - 1] : null, r.ctx)) console.log(`  · ${n}`);
  }
  if (rhwp.events) {
    // --from/--to 가 없으면 처음 갈라진 문단과 그 앞 문단의 결정만.
    const lo = opts.from > 0 || opts.to < Infinity ? opts.from : Math.max(0, (rows[firstDiff]?.pi ?? 0) - 1);
    const hi = opts.from > 0 || opts.to < Infinity ? opts.to : (rows[firstDiff]?.pi ?? 0);
    console.log('');
    console.log(`쪽 나눔 결정(문단 ${lo}~${hi}) — 쪽 | 문단 | 동작 | 흐름 높이 px 전→후 | 엔진 소스`);
    for (const e of rhwp.events) {
      if (e.pi == null || e.pi < lo || e.pi > hi) continue;
      if (['align', 'reclaim', 'advance'].includes(e.op) && Math.abs(e.after - e.before) < 0.05) continue; // 값이 안 바뀐 호출
      console.log(`  ${String(e.page).padStart(3)} ${String(e.pi).padStart(5)}  ${e.op.padEnd(15)} ${e.before.toFixed(1).padStart(7)} → ${e.after.toFixed(1).padEnd(7)} ${e.at}${e.detail ? '  ' + e.detail.slice(0, 90) : ''}`);
    }
  }
  if (images) {
    const bad = images.filter((i) => !i.ok);
    console.log('');
    console.log(`그림 상자(한/글 쪽 그림 ↔ rhwp, px): ${images.length - bad.length}/${images.length} 일치`);
    for (const i of (opts.all ? images : bad)) console.log(`  ${i.ok ? ' ' : '!'} 쪽 ${i.page + 1} #${i.idx + 1}${i.pi != null ? ` (문단 ${i.pi})` : ''}: 한/글 ${JSON.stringify(i.hangul)} ↔ rhwp ${JSON.stringify(i.rhwp)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.log('사용: node scripts/layout-trace.mjs <문서.hwpx> [--hangul <한글 결과 폴더|saved.hwpx>] [--run-hangul] [--pdf <한글.pdf>] [--all] [--from N --to M] [--json out.json] [--tol px]');
    process.exit(2);
  }
  const res = await layoutTrace(opts);
  print(res, opts);
  if (opts.saveOracle) {
    if (!res.hangul) throw new Error('--save-oracle 에는 --hangul 또는 --run-hangul 이 필요하다');
    fs.writeFileSync(opts.saveOracle, JSON.stringify(oracleFromHangul(path.relative(root, path.resolve(opts.file)).replace(/\\/g, '/'), res.hangul, res.view)));
    console.log(`
기준 JSON: ${opts.saveOracle}`);
  }
  if (opts.json) {
    const slim = { file: opts.file, rhwpPages: res.rhwp.pageCount, hangulPages: res.hangul?.pageCount ?? null, firstDiff: res.firstDiff, rows: res.rows.map(({ ctx, ...r }) => r), images: res.images, trace: res.rhwp.trace };
    fs.writeFileSync(opts.json, JSON.stringify(slim, null, 1));
    console.log(`\nJSON: ${opts.json}`);
  }
  if (res.hangul && res.firstDiff >= 0) process.exitCode = 1;
}
