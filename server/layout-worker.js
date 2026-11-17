// 편집 뒤 조판 검사(V3) 작업자 — worker_threads 안에서만 돈다(server/layout-check.js 가 띄운다). 2026-11-12.
// 서버 차례 엔진(server/toc-engine.js)과 같은 우리 fork WASM(vendor/rhwp/pkg — HWPX_COWORK_ENGINE_PKG)을 이 스레드에서 따로 읽어
// 저장된 기록 파일을 열고 조판 결과만 읽는다(읽기 전용 — 문서를 고치거나 저장하지 않는다). 엔진 호출은 동기라 서버 스레드를 막지 않게 여기서 한다.
// 받는 일: { job, id, file(편집 뒤 기록 파일), beforeFile(편집 전 — 이 작업자가 그 문서의 앞 결과를 기억하지 않을 때만 연다), version, beforeVersion, positions:[{ref, sec, para}] }
//   또는 쪽 수 어림(2026-11-17): { job, kind: 'pages', docs: [{ bytes } | { file }] } → { job, ok, results: [{ pages, sections, lastFill, fills }] } (아래 estimatePages)
//     — 문서마다 ops(구조 op 를 이 스레드에서 문서 엔진으로 반영한 뒤 잰다 — 큰 문서의 개체 → 본문)·covered(글 앞 그림이 본문 글을 덮는 쪽)를 줄 수 있다
// 돌려줌: { job, ok, before:{pages}, after:{pages}, changedPages:[쪽(0부터)], refPages:[{ref, page}], overflow:[{kind, page, cell}], ms, rss }
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffArrays } from 'diff';

const pkgDir = workerData?.pkgDir;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
globalThis.measureTextWidth ??= (font, text) => String(text).length * 10;   // toc-engine.js 와 같은 스텁(글자 폭은 엔진 안 폭 표)
mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });

/**
 * 문서 하나의 조판 요약: 쪽 수, 쪽마다 글(바뀐 쪽 견주기), 표마다 칸 글·줄 수·넘침(칸 상자 아래로 나간 글 — 엔진 배치 결과).
 * 표 = 본문 표(구역·주인 문단·조판 부호 번호 — 편집 전후 짝은 pairTables 가 짓는다), 칸 열쇠 = 표 안 경로(칸 안 표도 — 바깥 칸·그 칸 문단·안쪽 표·안쪽 칸).
 * 2026-11-12 2차 검토: 칸 안 표를 건너뛰어 중첩 칸의 넘침을 놓쳤고, 표 등장 차례를 열쇠로 써서 앞 표를 지우면 다른 표끼리 견줬다
 */
function cellKey(r) {
  const path = Array.isArray(r.cellPath) && r.cellPath.length ? r.cellPath : [{ cellIndex: r.cellIdx }];
  return path.map((e, i) => (i === 0 ? `${e.cellIndex}` : `${path[i - 1].cellParaIndex}/${e.controlIndex}/${e.cellIndex}`)).join('>');
}
function summarize(d) {
  const pages = d.pageCount();
  const pageTexts = []; const tables = new Map(); const boxes = new Map();
  for (let p = 0; p < pages; p++) {
    pageTexts.push(d.getPageText(p));
    let runs = [];
    try { runs = JSON.parse(d.getPageTextLayout(p)).runs || []; } catch { runs = []; }
    for (const r of runs) {
      if (r.parentParaIdx == null) continue;
      const tk = `${r.secIdx}/${r.parentParaIdx}/${r.controlIdx}`;
      let t = tables.get(tk);
      if (!t) {
        // 약한 지문 = 칸 구조(행·열·병합) — 글이 바뀐 표도 구조로 짝짓는다
        let shape = '';
        try { shape = JSON.parse(d.getTableCellBboxes(r.secIdx, r.parentParaIdx, r.controlIdx)).filter((b, i, a) => a.findIndex((x) => x.cellIdx === b.cellIdx) === i).map((b) => `${b.row},${b.col},${b.rowSpan},${b.colSpan}`).join(';'); } catch { shape = ''; }
        t = { sec: r.secIdx, order: r.parentParaIdx * 1000 + r.controlIdx, shape, cells: new Map() };
        tables.set(tk, t);
      }
      const nested = Array.isArray(r.cellPath) && r.cellPath.length > 1;
      const ck = cellKey(r);
      const c = t.cells.get(ck) || { text: '', ys: new Set(), clip: null, page: p, nested };
      c.text += r.text || '';
      if (r.text) c.ys.add(`${p}:${Math.round(r.y)}`);
      // 잘린 글은 본문 표 칸만 본다(칸 안 표의 상자는 경로 API 가 쪽을 주지 않는다 — 미검증 범위)
      if (r.text && !nested && c.clip == null) {
        if (!boxes.has(`${tk}@${p}`)) { try { boxes.set(`${tk}@${p}`, JSON.parse(d.getTableCellBboxes(r.secIdx, r.parentParaIdx, r.controlIdx, p))); } catch { boxes.set(`${tk}@${p}`, []); } }
        const box = boxes.get(`${tk}@${p}`).find((b) => b.cellIdx === r.cellIdx && b.pageIndex === p);
        if (box && r.y + r.h - (box.y + box.h) > 1) c.clip = p;   // 칸 상자 아래로 1px 넘게 나간 글 = 잘린 글
      }
      t.cells.set(ck, c);
    }
  }
  const list = [...tables.values()].map((t) => {
    const cells = new Map([...t.cells].map(([k, c]) => [k, { text: c.text, lines: c.ys.size, clip: c.clip, page: c.page, nested: c.nested }]));
    const strong = `${t.shape}|${[...cells].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, c]) => `${k}=${c.text}`).join('\u0001')}`;
    return { sec: t.sec, order: t.order, shape: t.shape, strong, cells };
  }).sort((a, b) => a.sec - b.sec || a.order - b.order);
  return { pages, pageTexts, tables: list };
}

/**
 * 편집 전후 표 짝짓기(구역마다): 글·구조가 모두 같은 표(strong)를 diffArrays 로 먼저 맞추고, 그 사이에 남은 지운·넣은 표 묶음은
 * 개수가 같고 칸 구조(shape)가 차례로 모두 같을 때만 1:1 로 짝짓는다(글이 바뀐 표). 짝을 못 지은 표는 견주지 않는다(경고하지 않는 쪽)
 */
function pairTables(B, A) {
  const pairs = [];
  const secs = new Set([...B.map((t) => t.sec), ...A.map((t) => t.sec)]);
  for (const s of secs) {
    const b = B.filter((t) => t.sec === s); const a = A.filter((t) => t.sec === s);
    let bi = 0; let ai = 0; let rem = []; let add = [];
    const flush = () => {
      if (rem.length && rem.length === add.length && rem.every((t, i) => t.shape === add[i].shape)) rem.forEach((t, i) => pairs.push([t, add[i]]));
      else if (rem.length && add.length) {
        // 개수가 다르면(같은 자리에서 표를 지우고 다른 표의 글을 바꿈 등) 칸 구조가 그 묶음 안에서 양쪽에 하나뿐인 표만 짝짓는다(같은 구조가 여럿이면 어느 것인지 모른다)
        const once = (list, shape) => list.filter((t) => t.shape === shape).length === 1;
        for (const t of rem) if (once(rem, t.shape) && once(add, t.shape)) pairs.push([t, add.find((x) => x.shape === t.shape)]);
      }
      rem = []; add = [];
    };
    for (const part of diffArrays(b.map((t) => t.strong), a.map((t) => t.strong))) {
      const n = part.count ?? part.value.length;
      if (part.removed) { for (let k = 0; k < n; k++) rem.push(b[bi++]); continue; }
      if (part.added) { for (let k = 0; k < n; k++) add.push(a[ai++]); continue; }
      flush();
      for (let k = 0; k < n; k++) pairs.push([b[bi++], a[ai++]]);
    }
    flush();
  }
  return pairs;
}

const open = (file) => new mod.HwpDocument(new Uint8Array(fs.readFileSync(file)));
const cache = new Map();   // 문서 id → { version, sum } (이 작업자가 마지막으로 본 기록)

/**
 * 쪽 수 어림(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-7, server/page-estimate.js): 쪽 수, 구역별 쪽 수, 마지막 쪽이 찬 비율.
 * 찬 비율 = 쪽 본문 영역(머리말 아래 ~ 꼬리말 위) 높이 가운데 본문 글 줄·개체(글 뒤·앞 개체 제외)의 가장 아래까지 — 엔진 배치 결과의 어림이다
 */
function pageFill(d, p, info, stopAt = null) {
  const top = info.headerArea ? info.headerArea.y + info.headerArea.height : (info.marginTop || 0) + (info.marginHeader || 0);
  const bottom = info.footerArea ? info.footerArea.y : info.height - (info.marginBottom || 0) - (info.marginFooter || 0);
  let low = top;
  let runs = []; try { runs = JSON.parse(d.getPageTextLayout(p)).runs || []; } catch { runs = []; }
  // paraIdx 0xFFFFFFFF = 머리말·꼬리말·쪽 번호(본문 문단이 아님)
  for (const r of runs) if (r.paraIdx != null && r.paraIdx < 0x7fffffff && r.y >= top - 1 && r.y < bottom) low = Math.max(low, Math.min(bottom, r.y + r.h));
  const ratio = () => (bottom > top ? Math.round(((low - top) / (bottom - top)) * 100) / 100 : null);
  // stopAt: 글 줄만으로 이 비율을 넘었으면 개체 배치는 읽지 않는다(개체는 찬 비율을 늘리기만 한다 — 이때 값은 아래 한계)
  if (stopAt != null && ratio() != null && ratio() >= stopAt) return ratio();
  let controls = []; try { controls = JSON.parse(d.getPageControlLayout(p)).controls || []; } catch { controls = []; }
  for (const c of controls) if (!['behindText', 'inFrontOfText'].includes(c.wrap) && c.y >= top - 1 && c.y < bottom) low = Math.max(low, Math.min(bottom, c.y + c.h));
  return ratio();
}
// 거의 빈 쪽 후보(2026-11-17 작업 Q — artifacts/mcp-round3-20261117/codex/REPORT-G3.md 문제 2: Z01 은 9쪽에서 멈췄는데 5쪽에 2장 끝 144자만 있었다).
// 쪽마다 배치를 읽으면 작업자 시간이 두 배쯤 든다(9쪽 보고서: 조판 55ms + 모든 쪽 찬 비율 77ms — 쪽 글 읽기는 1ms 미만). 그래서 쪽 글(getPageText)이
// SPARSE_TEXT 자(빈칸 뺀 글자) 이하인 쪽만 찬 비율을 잰다 — 본문 15%(page-estimate.js SPARSE_FILL)는 A4·10pt 로 대여섯 줄(300자 안팎)이라 그보다 글이 많은 쪽은 거의 빈 쪽이 아니다
// (글이 적고 큰 그림·표가 찬 쪽은 후보로 들어와 찬 비율로 걸러진다). 글자가 아주 작거나 다단이면 놓칠 수 있다 — 알림은 덤이다
const SPARSE_TEXT = 400;
function pageStats(d, sparseBelow = null) {
  const pages = d.pageCount(); const sections = [];
  const infos = [];
  for (let p = 0; p < pages; p++) {
    let info = null; try { info = JSON.parse(d.getPageInfo(p)); } catch { info = null; }
    infos.push(info);
    const s = Number(info?.sectionIndex ?? 0); sections[s] = (sections[s] || 0) + 1;
  }
  const last = pages ? infos[pages - 1] : null;
  const lastFill = last ? pageFill(d, pages - 1, last) : null;
  // fills: 마지막 쪽이 아닌 쪽 가운데 글이 적은 쪽의 [쪽(0부터), 찬 비율] — 문서 글은 싣지 않는다. sparseBelow 를 받았을 때만(page-estimate.js SPARSE_FILL)
  // — 그 문턱을 글 줄만으로 넘은 쪽의 값은 아래 한계다(거의 빈 쪽인지 가리는 데는 넉넉하다)
  const fills = [];
  for (let p = 0; sparseBelow != null && p < pages - 1; p++) {
    if (!infos[p]) continue;
    let n = 0; try { n = d.getPageText(p).replace(/\s+/g, '').length; } catch { continue; }
    if (n <= SPARSE_TEXT) { const f = pageFill(d, p, infos[p], sparseBelow); if (f != null) fills.push([p, f]); }
  }
  return { pages, sections: sections.map((n) => n || 0), lastFill, fills };
}

/**
 * 가려진 쪽(2026-11-17 — 개체 → 본문 결과, server/page-estimate.js covered): 글 앞(inFrontOfText) 그림이 본문 글 줄 위에 그려지는 쪽(0부터).
 * 글 줄이 그 그림보다 위 차례(zOrder)의 글 앞 개체(글상자 등) 안에 있으면 가리지 않는다. 그림의 투명도는 보지 않는다(엔진 배치 결과의 어림)
 */
function coveredPages(d, pages) {
  const out = [];
  const meet = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
  for (let p = 0; p < pages; p++) {
    let controls = []; try { controls = JSON.parse(d.getPageControlLayout(p)).controls || []; } catch { continue; }
    const fronts = controls.filter((c) => c.type === 'image' && c.wrap === 'inFrontOfText' && c.w > 0 && c.h > 0);
    if (!fronts.length) continue;
    let runs = []; try { runs = JSON.parse(d.getPageTextLayout(p)).runs || []; } catch { continue; }
    const holder = new Map(controls.map((c) => [`${c.secIdx}/${c.paraIdx}/${c.controlIdx}`, c]));
    const hit = runs.some((r) => {
      if (!r.text || !String(r.text).trim()) return false;
      const own = r.parentParaIdx != null ? holder.get(`${r.secIdx}/${r.parentParaIdx}/${r.controlIdx}`) : null;
      return fronts.some((f) => own !== f && !(own?.wrap === 'inFrontOfText' && (own.zOrder ?? 0) > (f.zOrder ?? 0)) && meet(r, f));
    });
    if (hit) out.push(p);
  }
  return out;
}

// 구조 op 반영(2026-11-17 — 큰 문서의 쪽 수 어림, server/page-estimate.js _structureOnly): 서버 스레드를 막지 않게 이 스레드에서 문서 엔진(engine/ — 순수 JS)으로
// 개체 → 본문·쪽 구성을 반영한 뒤 그 결과를 조판한다. 엔진은 처음 쓸 때만 읽는다
let engine = null;
function structureEngine() {
  engine ??= Promise.all([import('../engine/doc.js'), import('../engine/toc.js'), import('../engine/page-layout.js')])
    .then(([doc, toc, layout]) => ({ HwpxDoc: doc.HwpxDoc, containerFromBytesSync: toc.containerFromBytesSync, docBytesSync: toc.docBytesSync, editPageLayout: layout.editPageLayout }));
  return engine;
}
async function applyStructure(bytes, lists) {
  const e = await structureEngine();
  const doc = new e.HwpxDoc(e.containerFromBytesSync(new Uint8Array(bytes)));
  for (const ops of lists) e.editPageLayout(doc, ops, { author: '쪽 수 어림' });
  return e.docBytesSync(doc);
}

/**
 * 쪽 수 어림 일: { job, kind: 'pages', docs: [{ bytes | file, ops?, covered? }] } → { job, ok, results: [{ pages, sections, lastFill, fills, covered? } | { error }], ms }.
 * ops(구조 op 묶음 목록)를 주면 반영한 결과를 잰다 — 반영이 실패하면 그 문서만 { error }(다른 문서의 쪽 수는 그대로). covered:true 면 가려진 쪽도
 */
async function estimatePages(m, t0) {
  const results = [];
  for (const x of m.docs || []) {
    let bytes = x.bytes;
    if (Array.isArray(x.ops) && x.ops.length) {
      try { bytes = await applyStructure(x.file ? fs.readFileSync(x.file) : x.bytes, x.ops); }
      catch (e) { results.push({ error: `${e?.code ? `${e.code}: ` : ''}${String(e?.message || e)}`.slice(0, 200) }); continue; }
    }
    const d = x.file && bytes === x.bytes ? open(x.file) : new mod.HwpDocument(new Uint8Array(bytes));
    try {
      const stats = pageStats(d, Number.isFinite(m.sparseBelow) ? m.sparseBelow : null);
      if (x.covered) stats.covered = coveredPages(d, stats.pages);
      results.push(stats);
    } finally { d.free?.(); }
  }
  return { job: m.job, ok: true, results, ms: performance.now() - t0, rss: process.memoryUsage().rss };
}

parentPort.on('message', (m) => {
  const t0 = performance.now();
  if (m?.kind === 'pages') {
    estimatePages(m, t0).then((r) => parentPort.postMessage(r), (e) => parentPort.postMessage({ job: m.job, ok: false, error: String(e?.message || e).slice(0, 200), ms: performance.now() - t0 }));
    return;
  }
  try {
    let before = cache.get(m.id);
    if (!before || before.version !== m.beforeVersion) {
      const d = open(m.beforeFile); try { before = { version: m.beforeVersion, sum: summarize(d) }; } finally { d.free?.(); }
    }
    const d = open(m.file);
    let after; const refPages = [];
    try {
      after = summarize(d);
      for (const x of m.positions || []) {
        try { const r = JSON.parse(d.getPageOfPosition(x.sec, x.para)); if (r?.ok) refPages.push({ ref: x.ref, page: r.page }); } catch { /* 쪽에 없는 문단(숨김 등) */ }
      }
    } finally { d.free?.(); }
    cache.set(m.id, { version: m.version, sum: after });
    while (cache.size > 16) cache.delete(cache.keys().next().value);
    const changedPages = [];
    for (let p = 0; p < Math.max(before.sum.pages, after.pages); p++) if (before.sum.pageTexts[p] !== after.pageTexts[p]) changedPages.push(p);
    // 새로 생긴 칸 넘침만(편집 전부터 있던 것은 뺀다 — V1 과 같은 생각): 잘린 글(clip), 글이 바뀌어 한 줄이던 칸이 여러 줄이 됨(wrap — rhwp set_cell overflow 와 같은 뜻)
    // 짝지은 표의 같은 칸끼리만 본다(짝 없는 표·칸은 경고하지 않는다)
    const overflow = [];
    for (const [bt, at] of pairTables(before.sum.tables, after.tables)) {
      for (const [k, c] of at.cells) {
        const b = bt.cells.get(k); if (!b) continue;
        const cell = `${at.sec}/${at.order}/${k}`; const nested = c.nested ? { nested: true } : {};
        if (c.clip != null && b.clip == null) overflow.push({ kind: 'clip', page: c.clip, cell, ...nested });
        else if (b.text !== c.text && b.lines <= 1 && c.lines > 1) overflow.push({ kind: 'wrap', page: c.page, cell, lines: c.lines, ...nested });
      }
    }
    parentPort.postMessage({ job: m.job, ok: true, before: { pages: before.sum.pages }, after: { pages: after.pages }, changedPages, refPages, overflow, ms: performance.now() - t0, rss: process.memoryUsage().rss });
  } catch (e) {
    parentPort.postMessage({ job: m.job, ok: false, error: String(e?.message || e).slice(0, 200), ms: performance.now() - t0 });
  }
});
parentPort.postMessage({ ready: true });
