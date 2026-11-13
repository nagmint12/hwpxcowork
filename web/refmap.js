// rhwp 위치(구역·문단·글자 offset, 표 셀 경로) ↔ 엔진 문단 주소(s0/p12, s0/p3/n8) 지도.
// 순수 함수(DOM 없음): 브라우저(검토 보기)와 Node 시험(tests/refmap.test.mjs)이 같이 쓴다.
// - 본문: rhwp (sec, para) = 엔진 s{sec}/p{para}. 글이 다르면(드묾) 글자 정렬로 offset 을 옮긴다.
// - 중첩: 문단 P 의 rhwp 셀 문단 목록(표 캡션 → 셀 순서, 그림 캡션·글상자)을 엔진 s{sec}/p{P}/n* 목록과
//   글 순서 정렬(LCS)로 짝짓는다. 엔진이 cell 정보(행·열)를 주면 그것까지 맞아야 짝이 된다.
// - offset 단위는 둘 다 유니코드 코드포인트. 캡션은 rhwp 가 자동 번호 자리에 글자 하나를 더 두므로 정렬로 옮긴다.

export const CAPTION_CELL = 65534; // rhwp: 표 캡션의 cellIndex

const cps = (s) => Array.from(s || '');
const norm = (s) => String(s || '').replace(/[\s\u0000-\u001f​﻿]/g, '');
const tryJson = (f) => { try { const v = f(); return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const tryNum = (f) => { try { const v = f(); return typeof v === 'number' ? v : null; } catch { return null; } };

/** 두 글(코드포인트 배열)의 글자 정렬 → 양방향 offset 표(단조 증가). */
export function alignOffsets(a, b) {
  const A = Array.isArray(a) ? a : cps(a); const B = Array.isArray(b) ? b : cps(b);
  const n = A.length; const m = B.length;
  const a2b = new Int32Array(n + 1).fill(-1); const b2a = new Int32Array(m + 1).fill(-1);
  let pre = 0; while (pre < n && pre < m && A[pre] === B[pre]) { a2b[pre] = pre; b2a[pre] = pre; pre++; }
  let suf = 0; while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) { a2b[n - 1 - suf] = m - 1 - suf; b2a[m - 1 - suf] = n - 1 - suf; suf++; }
  const an = n - pre - suf; const bn = m - pre - suf;
  if (an > 0 && bn > 0 && an * bn <= 4e6) {
    const w = bn + 1; const L = new Uint16Array((an + 1) * w);
    for (let i = an - 1; i >= 0; i--) for (let j = bn - 1; j >= 0; j--) {
      L[i * w + j] = A[pre + i] === B[pre + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
    let i = 0; let j = 0;
    while (i < an && j < bn) {
      if (A[pre + i] === B[pre + j]) { a2b[pre + i] = pre + j; b2a[pre + j] = pre + i; i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++; else j++;
    }
  }
  fillGaps(a2b, n, m); fillGaps(b2a, m, n);
  return { a2b, b2a };
}
// 짝 없는 글자 자리는 바로 앞 짝의 다음 자리로(단조 증가 유지), 끝 자리는 상대 끝으로
function fillGaps(map, len, other) {
  let next = 0;
  for (let i = 0; i < len; i++) { if (map[i] >= 0) next = map[i] + 1; else map[i] = Math.min(next, other); }
  map[len] = other;
}

/** 순서 있는 두 목록의 LCS 짝: eq(a,b) → bool. 반환: [[i,j],...] */
export function lcsPairs(A, B, eq) {
  const n = A.length; const m = B.length;
  if (n === m && A.every((x, i) => eq(x, B[i]))) return A.map((x, i) => [i, i]);
  const w = m + 1; const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i * w + j] = eq(A[i], B[j]) ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  }
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (eq(A[i], B[j]) && L[i * w + j] === L[(i + 1) * w + j + 1] + 1) { out.push([i, j]); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++; else j++;
  }
  return out;
}

const posKey = (p) => (p.parentPara == null ? `b:${p.sec}:${p.para}` : `c:${p.sec}:${p.parentPara}:${p.controlIdx}:${p.cellIdx}:${p.cellParaIdx}`);
const containerKey = (p) => (p.parentPara == null ? `b:${p.sec}` : `c:${p.sec}:${p.parentPara}:${p.controlIdx}:${p.cellIdx}`);

/** 문단 P 의 rhwp 중첩 문단 목록(표: 캡션 → 셀, 그림·글상자: 0번 목록) */
export function rhwpNestedList(doc, sec, P) {
  const out = [];
  const ctrls = tryJson(() => doc.getControlTextPositions(sec, P)) || [];
  let tableOrd = 0;
  for (let ci = 0; ci < ctrls.length; ci++) {
    const dims = tryJson(() => doc.getTableDimensions(sec, P, ci));
    if (dims && dims.cellCount != null) {
      const capN = tryNum(() => doc.getCellParagraphCount(sec, P, ci, CAPTION_CELL)) || 0;
      for (let k = 0; k < capN; k++) out.push(item(doc, sec, P, ci, CAPTION_CELL, k, { kind: 'caption', tableOrd }));
      for (let c = 0; c < dims.cellCount; c++) {
        const info = tryJson(() => doc.getCellInfo(sec, P, ci, c)) || {};
        const nP = tryNum(() => doc.getCellParagraphCount(sec, P, ci, c)) || 0;
        for (let k = 0; k < nP; k++) out.push(item(doc, sec, P, ci, c, k, { kind: 'cell', tableOrd, row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan }));
      }
      tableOrd++;
    } else {
      const nP = tryNum(() => doc.getCellParagraphCount(sec, P, ci, 0)) || 0;
      for (let k = 0; k < nP; k++) out.push(item(doc, sec, P, ci, 0, k, { kind: 'shape' }));
    }
  }
  return out;
}
function item(doc, sec, P, ci, cell, k, extra) {
  const len = tryNum(() => doc.getCellParagraphLength(sec, P, ci, cell, k)) || 0;
  let text = '';
  try { text = len ? doc.getTextInCell(sec, P, ci, cell, k, 0, len) : ''; } catch { text = ''; }
  return { pos: { sec, parentPara: P, controlIdx: ci, cellIdx: cell, cellParaIdx: k, cellPath: [{ controlIndex: ci, cellIndex: cell, cellParaIndex: k }] }, text, ...extra };
}

/** 엔진 중첩 문단 ↔ rhwp 항목이 같은 문단인가 */
function sameNested(e, r) {
  if (norm(e.text) !== norm(r.text)) return false;
  if (!('cell' in e) || e.cell === undefined) return true; // 옛 엔진: 글만 본다
  if (e.cell === null) return r.kind !== 'cell';
  if (r.kind !== 'cell') return false;
  const ord = Number(/#t(\d+)$/.exec(e.cell.table || '')?.[1] ?? NaN);
  if (Number.isFinite(ord) && ord !== r.tableOrd) return false;
  return e.cell.row === r.row && e.cell.col === r.col;
}

/**
 * 지도 만들기.
 * @param doc rhwp HwpDocument(작업본=최종본)
 * @param paragraphs 엔진 문단 목록(GET /api/docs/:id/paragraphs, 최종본 글)
 */
export function buildRefMap(doc, paragraphs) {
  const byRef = new Map(); const toPos = new Map(); const toRef = new Map(); const rhText = new Map();
  const offs = new Map(); // ref → {r2e, e2r} (글이 다를 때만)
  const unmatchedEngine = []; const unmatchedRhwp = []; let nested = 0;
  const groups = new Map(); // `${sec}:${P}` → 엔진 중첩 문단들
  for (const p of paragraphs) {
    byRef.set(p.ref, p);
    if (p.where === '메모') continue;
    const m = /^s(\d+)\/p(\d+)(\/.+)?$/.exec(p.ref); if (!m) continue;
    if (!m[3]) continue;
    const k = `${m[1]}:${m[2]}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); nested++;
  }
  const link = (ref, pos, rtext) => {
    toPos.set(ref, pos); toRef.set(posKey(pos), ref); rhText.set(ref, rtext);
    const et = byRef.get(ref)?.text ?? '';
    if (rtext !== et) { const al = alignOffsets(rtext, et); offs.set(ref, { r2e: al.a2b, e2r: al.b2a }); }
  };
  // 본문
  const secN = tryNum(() => doc.getSectionCount()) || 0;
  for (let s = 0; s < secN; s++) {
    const n = tryNum(() => doc.getParagraphCount(s)) || 0;
    for (let i = 0; i < n; i++) {
      const ref = `s${s}/p${i}`; if (!byRef.has(ref)) continue;
      const len = tryNum(() => doc.getParagraphLength(s, i)) || 0;
      let t = ''; try { t = len ? doc.getTextRange(s, i, 0, len) : ''; } catch { t = ''; }
      link(ref, { sec: s, para: i }, t);
    }
  }
  // 중첩
  for (const [k, eng] of groups) {
    const [s, P] = k.split(':').map(Number);
    const rh = rhwpNestedList(doc, s, P);
    const pairs = lcsPairs(eng, rh, sameNested);
    const usedE = new Set(); const usedR = new Set();
    for (const [i, j] of pairs) { link(eng[i].ref, rh[j].pos, rh[j].text); usedE.add(i); usedR.add(j); }
    eng.forEach((e, i) => { if (!usedE.has(i)) unmatchedEngine.push(e.ref); });
    rh.forEach((r, j) => { if (!usedR.has(j)) unmatchedRhwp.push(posKey(r.pos)); });
  }

  const api = {
    /** 엔진 문단 정보 */
    para(ref) { return byRef.get(ref) || null; },
    text(ref) { return byRef.get(ref)?.text ?? ''; },
    length(ref) { return cps(byRef.get(ref)?.text).length; },
    /** 엔진 ref → rhwp 위치 */
    refToPos(ref) { return toPos.get(ref) || null; },
    /** rhwp hitTest 결과 → { ref, offset }(엔진 단위) */
    posToRef(hit) {
      if (!hit) return null;
      const sec = hit.sectionIndex ?? hit.secIdx ?? 0;
      const path = hit.cellPath;
      const pp = hit.parentParaIndex ?? hit.parentParaIdx;
      if (pp != null) {
        const top = path && path[0] ? path[0] : { controlIndex: hit.controlIndex ?? hit.controlIdx, cellIndex: hit.cellIndex ?? hit.cellIdx, cellParaIndex: hit.cellParaIndex ?? hit.cellParaIdx };
        if (path && path.length > 1) {
          // 중첩 표(셀 안의 표): 지도 밖 → 바깥 셀 문단으로 근사
          const ref = toRef.get(`c:${sec}:${pp}:${top.controlIndex}:${top.cellIndex}:${top.cellParaIndex}`) || toRef.get(`b:${sec}:${pp}`);
          return ref ? { ref, offset: 0, approx: true } : null;
        }
        const ref = toRef.get(`c:${sec}:${pp}:${top.controlIndex}:${top.cellIndex}:${top.cellParaIndex}`);
        if (!ref) { const body = toRef.get(`b:${sec}:${pp}`); return body ? { ref: body, offset: 0, approx: true } : null; }
        return { ref, offset: api.toEngine(ref, hit.charOffset ?? hit.charStart ?? 0) };
      }
      const para = hit.paragraphIndex ?? hit.paraIdx;
      const ref = toRef.get(`b:${sec}:${para}`);
      return ref ? { ref, offset: api.toEngine(ref, hit.charOffset ?? hit.charStart ?? 0) } : null;
    },
    toEngine(ref, rOff) {
      const o = offs.get(ref); const len = api.length(ref);
      const v = o ? o.r2e[Math.max(0, Math.min(o.r2e.length - 1, rOff))] : rOff;
      return Math.max(0, Math.min(len, v));
    },
    toRhwp(ref, eOff) {
      const o = offs.get(ref); const len = cps(rhText.get(ref)).length;
      const v = o ? o.e2r[Math.max(0, Math.min(o.e2r.length - 1, eOff))] : eOff;
      return Math.max(0, Math.min(len, v));
    },
    /** 같은 묶음(본문 구역 / 한 셀)인가 — 선택은 한 묶음 안에서만 */
    container(ref) { const p = toPos.get(ref); return p ? containerKey(p) : null; },
    /** 묶음 안 순서값(본문: 문단 번호, 셀: 셀 문단 번호) */
    order(ref) { const p = toPos.get(ref); return p ? (p.parentPara == null ? p.para : p.cellParaIdx) : -1; },
    /** 같은 묶음의 문단 ref 목록 [a..b] */
    refsBetween(refA, refB) {
      const a = toPos.get(refA); const b = toPos.get(refB); if (!a || !b) return [refA];
      if (containerKey(a) !== containerKey(b)) return [refA];
      const out = [];
      if (a.parentPara == null) { for (let i = Math.min(a.para, b.para); i <= Math.max(a.para, b.para); i++) { const r = toRef.get(`b:${a.sec}:${i}`); if (r) out.push(r); } }
      else for (let i = Math.min(a.cellParaIdx, b.cellParaIdx); i <= Math.max(a.cellParaIdx, b.cellParaIdx); i++) { const r = toRef.get(`c:${a.sec}:${a.parentPara}:${a.controlIdx}:${a.cellIdx}:${i}`); if (r) out.push(r); }
      return out;
    },
    /** 범위 사각형(쪽 좌표). start/end 는 엔진 offset. endRef 가 있으면 여러 문단(같은 묶음) */
    rects(ref, start, end, endRef = ref) {
      const a = toPos.get(ref); const b = toPos.get(endRef); if (!a || !b) return [];
      const s = api.toRhwp(ref, start); const e = api.toRhwp(endRef, end);
      if (a.parentPara == null && b.parentPara == null) return tryJson(() => doc.getSelectionRects(a.sec, a.para, s, b.para, e)) || [];
      if (containerKey(a) !== containerKey(b)) return [];
      return tryJson(() => doc.getSelectionRectsInCell(a.sec, a.parentPara, a.controlIdx, a.cellIdx, a.cellParaIdx, s, b.cellParaIdx, e)) || [];
    },
    /** 글자 자리(커서) 사각형 {pageIndex,x,y,height}.
     *  getCursorRect 는 어떤 문단(앞에 숨은 조판 부호가 있는 문단)에서 한 글자 밀리므로, 글이 있으면 선택 사각형으로 구한다. */
    caret(ref, offset) {
      const a = toPos.get(ref); if (!a) return null;
      const len = api.length(ref); const o = Math.max(0, Math.min(len, offset));
      if (len > 0) {
        const r = o < len ? api.rects(ref, o, o + 1)[0] : api.rects(ref, o - 1, o).slice(-1)[0];
        if (r) return { pageIndex: r.pageIndex, x: o < len ? r.x : r.x + r.width, y: r.y, height: r.height };
      }
      const ro = api.toRhwp(ref, o);
      if (a.parentPara == null) return tryJson(() => doc.getCursorRect(a.sec, a.para, ro));
      return tryJson(() => doc.getCursorRectInCell(a.sec, a.parentPara, a.controlIdx, a.cellIdx, a.cellParaIdx, ro));
    },
    /** 본문 문단 ref(셀이면 표를 품은 본문 문단) */
    bodyRef(ref) { const m = /^(s\d+\/p\d+)/.exec(ref || ''); return m ? m[1] : null; },
    isCell(ref) { const p = toPos.get(ref); return !!(p && p.parentPara != null && p.cellIdx !== CAPTION_CELL && tableKind(doc, p)); },
    stats() { return { body: [...toPos.keys()].filter((r) => !r.includes('/n')).length, nested, mapped: [...toPos.keys()].filter((r) => r.includes('/n')).length, unmatchedEngine, unmatchedRhwp }; },
    refs() { return [...toPos.keys()]; },
  };
  return api;
}

/**
 * 쪽 좌표 → rhwp 위치. 글자 상자(getPageTextLayout 의 run) 안이면 그 run 의 charX 로 정확히,
 * 아니면(줄 사이·여백) rhwp hitTest. rhwp hitTest 는 캡션과 다음 줄(그림 줄)이 겹칠 때 다음 문단을 주는 일이 있다.
 * @param runs 그 쪽의 runs(JSON.parse(doc.getPageTextLayout(page)).runs) — 호출하는 쪽이 쪽마다 기억해 둔다
 */
export function hitTestPoint(doc, page, x, y, runs) {
  let best = null;
  for (const r of runs || []) {
    if (!r.text || r.w <= 0) continue;
    if (x >= r.x - 0.5 && x <= r.x + r.w + 0.5 && y >= r.y && y <= r.y + r.h) { if (!best || r.w * r.h < best.w * best.h) best = r; }
  }
  if (best) {
    const cx = best.charX || []; const n = Math.max(0, cx.length - 1); const dx = x - best.x;
    let i = 0; while (i < n && dx > (cx[i] + cx[i + 1]) / 2) i++;
    const off = (best.charStart || 0) + i;
    const hit = { sectionIndex: best.secIdx ?? 0, paragraphIndex: best.paraIdx, charOffset: off, cursorRect: { pageIndex: page, x: best.x + (cx[i] || 0), y: best.y, height: best.h } };
    if (best.parentParaIdx != null) Object.assign(hit, { parentParaIndex: best.parentParaIdx, controlIndex: best.controlIdx, cellIndex: best.cellIdx, cellParaIndex: best.cellParaIdx, cellPath: best.cellPath });
    return hit;
  }
  return tryJson(() => doc.hitTest(page, x, y));
}

function tableKind(doc, p) {
  const k = `${p.sec}:${p.parentPara}:${p.controlIdx}`;
  const cache = doc.__refmapTbl || (doc.__refmapTbl = new Map());
  if (!cache.has(k)) cache.set(k, !!tryJson(() => doc.getTableDimensions(p.sec, p.parentPara, p.controlIdx)));
  return cache.get(k);
}

// ── 코드포인트 ↔ UTF-16 ──
export function cpSlice(s, a, b) { return cps(s).slice(a, b).join(''); }
export function cpLen(s) { return cps(s).length; }
export function u16ToCp(s, u) { return cps(String(s).slice(0, u)).length; }
export function cpToU16(s, c) { return cps(s).slice(0, c).join('').length; }
