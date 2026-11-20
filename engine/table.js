// 표(hp:tbl) 구조 읽기와 새 표 XML 만들기.
// 읽기: 구역 토큰을 한 번 훑어 표마다 행·열 수, 셀 주소(hp:cellAddr)·합침(hp:cellSpan), 셀 문단, 캡션 문단을 모은다.
// 만들기: 문서의 기존 표 모양(셀 테두리·문단 모양·글자 모양·여백)을 빌려 같은 꼴의 표를 만든다(한글 2022 로 열림 확인).
// 캡션은 hp:caption(자동 번호) — 문단 조립은 doc.js insertTableAfter.
import { attrs, escapeAttr } from './xmlscan.js';

const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/**
 * 구역의 표 목록(문서 순서, 셀 안의 중첩 표 포함)과 문단 → 셀/캡션 연결.
 * 표를 직접 품은 문단(가장 가까운 hp:p)이 표의 주인이고 key = `${주인 ref}#t${주인 안 순번}`.
 * @returns {{ tables: object[], cellOf: Map<object, object>, captionOf: Map<object, object> }}
 */
export function scanTables(sec) {
  const { xml, tokens } = sec;
  // [hwpx-cowork] 나눔을 지워 이은 본문 기록은 물리 문단(member)마다 여는 태그가 있다 — 모두 그 기록으로(표 번호 #t 가 기록 안에서 이어진다)
  const paraByTok = new Map();
  for (const p of sec.paras) { if (p.members) for (const m of p.members) paraByTok.set(m.openTok, p); else paraByTok.set(p.openTok, p); }
  const tables = []; const cellOf = new Map(); const captionOf = new Map(); const perOwner = new Map(); const hiddenPerOwner = new Map();
  const stack = [];
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    if (t.type === 'close') {
      let fr = stack.pop();
      while (fr && fr.name !== t.name) fr = stack.pop();
      if (fr && fr.name === 'hp:tbl' && fr.table) fr.table.end = t.end;
      if (fr && fr.name === 'hp:tc' && fr.cell) fr.cell.end = t.end;
      continue;
    }
    if (t.type !== 'open' && t.type !== 'selfclose') continue;
    const top = stack[stack.length - 1];
    const fr = { name: t.name };
    if (t.name === 'hp:p') {
      const p = paraByTok.get(ti); fr.para = p;
      // 가장 가까운 문단·셀·캡션 중 무엇 안에 있는가(셀 안 글상자의 문단은 셀 문단이 아니다)
      for (let i = stack.length - 1; i >= 0 && p; i--) {
        const f = stack[i];
        if (f.name === 'hp:p') break;
        if (f.name === 'hp:tc' && f.cell) { f.cell.paras.push(p); cellOf.set(p, f.cell); break; }
        if (f.name === 'hp:caption' && f.table) { f.table.captionParas.push(p); captionOf.set(p, f.table); break; }
      }
    } else if (t.name === 'hp:tbl') {
      let owner = null;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === 'hp:p') { owner = stack[i].para; break; }
      if (owner) {
        const a = attrs(xml, t);
        // [hwpx-cowork] 변경 추적으로 지운 표(주인 문단 run 의 표 anchor 가 del, 또는 주인이 지운 개체 안 문단)는 최종본에 없다 — 번호를 따로
        // ('#d{k}') 매겨 보이는 표의 번호(#t — 칸 문단 sig·표 열쇠)가 평탄화 사본과 같게
        const hidden = !!owner.hidden || owner.anchors.some((x) => x.kind === 'ctrl' && x.start === t.start && x.del);
        const counter = hidden ? hiddenPerOwner : perOwner;
        const index = counter.get(owner) || 0; counter.set(owner, index + 1);
        fr.table = {
          key: `${owner.ref}#${hidden ? 'd' : 't'}${index}`, ref: owner.ref, index, owner, rows: int(a.get('rowCnt')), cols: int(a.get('colCnt')),
          attrs: a, start: t.start, openEnd: t.end, end: t.end, parts: {}, captionParas: [], cells: [], ...(hidden ? { hidden: true } : {}),
        };
        tables.push(fr.table);
      }
    } else if (top && top.table && !top.cell && (t.name === 'hp:tr' || t.name === 'hp:caption') && top.name === 'hp:tbl') {
      fr.table = top.table;
    } else if (t.name === 'hp:tc' && top && top.name === 'hp:tr' && top.table) {
      const a = attrs(xml, t);
      fr.cell = { table: top.table, row: null, col: null, rowSpan: 1, colSpan: 1, header: a.get('header') === '1', attrs: a, start: t.start, end: t.end, paras: [], parts: {} };
      top.table.cells.push(fr.cell);
    } else if (top && top.name === 'hp:tbl' && top.table) {
      top.table.parts[t.name] = xml.slice(t.start, t.end); // hp:sz, hp:pos, hp:outMargin, hp:inMargin …
    } else if (top && top.name === 'hp:tc' && top.cell) {
      const c = top.cell; const a = attrs(xml, t);
      if (t.name === 'hp:cellAddr') { c.col = int(a.get('colAddr')); c.row = int(a.get('rowAddr')); }
      else if (t.name === 'hp:cellSpan') { c.colSpan = int(a.get('colSpan'), 1); c.rowSpan = int(a.get('rowSpan'), 1); }
      else if (t.name === 'hp:cellSz') { c.width = int(a.get('width')); c.height = int(a.get('height')); }
      if (t.type === 'open' && t.name === 'hp:subList') c.subListAttrs = a;
      c.parts[t.name] = t.type === 'selfclose' ? xml.slice(t.start, t.end) : null;
    }
    if (t.type === 'open') stack.push(fr);
  }
  return { tables, cellOf, captionOf };
}

/** 구역 본문 폭(HWPUNIT) = 용지 폭 − 좌우 여백 − 제본 여백(단이 여럿이면 한 단 폭). */
export function sectionTextWidth(sec) {
  const pp = /<hp:pagePr\b[^>]*>/.exec(sec.xml);
  const mg = /<hp:pagePr\b[^>]*>\s*<hp:margin\b[^>]*>/.exec(sec.xml);
  if (!pp) return 42520;
  const g = (s, k) => int((new RegExp(`\\b${k}="(-?\\d+)"`).exec(s) || [])[1]);
  const w = g(pp[0], 'width'); const h = g(pp[0], 'height');
  // 한글은 세로 용지를 landscape="WIDELY" 로 쓴다(표본 문서 모두). NARROWLY(가로)는 긴 변이 폭.
  const landscape = (/\blandscape="(\w+)"/.exec(pp[0]) || [])[1];
  const pageW = landscape === 'NARROWLY' ? Math.max(w, h) : w;
  const m = mg ? mg[0].slice(mg[0].indexOf('<hp:margin')) : '';
  let tw = pageW - g(m, 'left') - g(m, 'right') - g(m, 'gutter');
  const col = /<hp:colPr\b[^>]*>/.exec(sec.xml);
  const n = col ? int((/\bcolCount="(\d+)"/.exec(col[0]) || [])[1], 1) : 1;
  if (n > 1) tw = Math.floor((tw - int((/\bsameGap="(\d+)"/.exec(col[0]) || [])[1]) * (n - 1)) / n);
  return tw > 2000 ? tw : 42520;
}

/** 구역 본문 높이(HWPUNIT, 대략) = 용지 높이 − 위·아래 여백 − 머리말·꼬리말 */
export function sectionTextHeight(sec) {
  const pp = /<hp:pagePr\b[^>]*>/.exec(sec.xml);
  const mg = /<hp:pagePr\b[^>]*>\s*<hp:margin\b[^>]*>/.exec(sec.xml);
  if (!pp) return 65000;
  const g = (s, k) => int((new RegExp(`\\b${k}="(-?\\d+)"`).exec(s) || [])[1]);
  const w = g(pp[0], 'width'); const h = g(pp[0], 'height');
  const landscape = (/\blandscape="(\w+)"/.exec(pp[0]) || [])[1];
  const pageH = landscape === 'NARROWLY' ? Math.min(w, h) : h;
  const m = mg ? mg[0].slice(mg[0].indexOf('<hp:margin')) : '';
  const th = pageH - g(m, 'top') - g(m, 'bottom') - g(m, 'header') - g(m, 'footer');
  return th > 5000 ? th : 65000;
}

/** 원본 표 셀 격자에서 (r, c) 를 덮는 셀 */
export function cellAt(table, r, c) {
  return table.cells.find((x) => x.row != null && r >= x.row && r < x.row + x.rowSpan && c >= x.col && c < x.col + x.colSpan) || null;
}

/**
 * 캡션 글 앞에 사람이 적은 번호를 뗀다 — 번호는 캡션의 자동 번호(hp:autoNum)가 단다. label = '표' | '그림'.
 * '[표 3] 제목'·'<표 3> 제목'·'표 3. 제목'·'표3 제목'·'표 3-1. 제목'·'표. 제목'·'[표 ] 제목' → '제목'. '표본 설계'·'그림자' 같은 낱말은 그대로.
 */
export function stripCaptionNumber(text, label = '표') {
  const L = label === '그림' ? '그림' : '표';
  const re = new RegExp(`^\\s*(?:[[<〈《(（【]\\s*${L}\\s*[\\d\\-.]*\\s*[\\]>〉》)）】]|${L}\\s*\\d+(?:[-.]\\d+)*(?:\\s*[.:：)]|\\s|$)|${L}\\s*[.:：])\\s*`);
  return String(text ?? '').replace(re, '').trim();
}

/** 숫자 칸('1,234'·'-0.12'·'45.6%'·'▲0.05')인가 — 빈 칸·'-' 는 판정에서 뺀다 */
export function isNumericCell(text) { return /^[-−+▲▼△▽]?\s*[\d,]*\.?\d+\s*%?$/.test(String(text).trim()); }

/** 열마다 본문 칸(머리행 아래)이 모두 숫자인가 — 숫자 열은 오른쪽 정렬(표준서식 §4) */
export function numericColumns(rows, headerRows) {
  const nCols = Math.max(...rows.map((r) => r.length));
  const out = [];
  for (let c = 0; c < nCols; c++) {
    const vals = rows.slice(headerRows).map((r) => String(r[c] ?? '').trim()).filter((v) => v && v !== '-' && v !== '−');
    out.push(vals.length > 0 && vals.every(isNumericCell));
  }
  return out;
}

/** 글 한 줄의 대략 폭(em): 한글·한자 같은 넓은 글자 1, 빈칸 0.5, 숫자·영문·기호 0.55 */
function lineEm(s) { let w = 0; for (const ch of s) w += ch === ' ' ? 0.5 : ch.codePointAt(0) >= 0x1100 ? 1 : 0.55; return w; }

/**
 * 열 너비(합 = total): 열마다 가장 긴 줄이 한 줄에 들어갈 폭(최소 minCol)을 바라고, 다 들어가면 그 비율로 나누며,
 * 모자라면 좁은 열('순서'·숫자 열)은 바라는 폭 그대로, 넓은 열은 남은 폭을 고르게 나눈다(긴 글 열만 여러 줄로 접힌다).
 * em = 칸 글자 크기(HWPUNIT), pad = 칸 안 여백 몫.
 */
export function columnWidths(rows, total, { em = 1000, minCol = 2400, pad = 1000 } = {}) {
  const nCols = Math.max(...rows.map((r) => r.length));
  const want = Array.from({ length: nCols }, (_, c) => {
    const longest = Math.max(0, ...rows.flatMap((r) => String(r[c] ?? '').split('\n').map(lineEm)));
    return Math.max(minCol, Math.ceil(longest * em) + pad);
  });
  const sum = want.reduce((a, b) => a + b, 0);
  let out;
  if (sum <= total) out = want.map((w) => Math.floor((w * total) / sum));
  else {
    const fixed = new Set(); let share;
    for (;;) {
      share = (total - [...fixed].reduce((a, c) => a + want[c], 0)) / (nCols - fixed.size);
      const more = want.map((_, c) => c).filter((c) => !fixed.has(c) && want[c] <= share);
      if (!more.length) break;
      for (const c of more) fixed.add(c);
    }
    out = want.map((w, c) => Math.floor(fixed.has(c) ? w : share));
  }
  out[nCols - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
  return out;
}

/**
 * 새 표 XML(hp:tbl 하나). 모양 값은 style 에서 받는다.
 * @param {object} o { id, zOrder, rows: string[][], headerRows, width, style, textXml(글 → 인라인 XML), numbering('TABLE'|'NONE'), captionXml(hp:caption 요소 | '') }
 *   style: { tblAttrs: Map, pos, outMargin, inMargin, em(칸 글자 크기), cell(r, c, nRows, nCols, headerRows, { numeric }) → { borderFill, paraPr, styleId, charPr, vertAlign, margin, height, hasMargin } }
 * 열 너비는 글 길이에 맞춘다(columnWidths). 캡션은 한글 순서대로 outMargin 과 inMargin 사이.
 */
function scaleWidths(ws, width) {
  const sum = ws.reduce((a, b) => a + b, 0);
  const out = ws.map((w) => Math.max(1, Math.round((w * width) / sum)));
  out[out.length - 1] += width - out.reduce((a, b) => a + b, 0);
  return out;
}

export function tableXml({ id, zOrder, rows, headerRows, width, style, textXml, numbering = 'NONE', captionXml = '' }) {
  const nRows = rows.length; const nCols = Math.max(...rows.map((r) => r.length));
  // style.colWidths(본보기 표 열 폭 — like, 2026-11-20): 비율대로 표 폭에 맞춘다(합이 표 폭과 같게 끝 열에서 맞춤)
  const widths = Array.isArray(style.colWidths) && style.colWidths.length === nCols ? scaleWidths(style.colWidths, width) : columnWidths(rows, width, { em: style.em || 1000 });
  const numeric = numericColumns(rows, headerRows);
  const heights = []; const trs = [];
  for (let r = 0; r < nRows; r++) {
    const tcs = []; let rowH = 0;
    for (let c = 0; c < nCols; c++) {
      const s = style.cell(r, c, nRows, nCols, headerRows, { numeric: numeric[c] });
      const text = rows[r][c] == null ? '' : String(rows[r][c]);
      rowH = Math.max(rowH, s.height);
      const run = text ? `<hp:run charPrIDRef="${s.charPr}"><hp:t>${textXml(text)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${s.charPr}"/>`;
      tcs.push(`<hp:tc name="" header="${r < headerRows ? 1 : 0}" hasMargin="${s.hasMargin}" protect="0" editable="0" dirty="0" borderFillIDRef="${s.borderFill}">`
        + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${s.vertAlign}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">`
        + `<hp:p id="0" paraPrIDRef="${s.paraPr}" styleIDRef="${s.styleId}" pageBreak="0" columnBreak="0" merged="0">${run}</hp:p></hp:subList>`
        + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/>`
        + `<hp:cellSz width="${widths[c]}" height="${s.height}"/>${s.margin}</hp:tc>`);
    }
    heights.push(rowH); trs.push(`<hp:tr>${tcs.join('')}</hp:tr>`);
  }
  const total = heights.reduce((a, b) => a + b, 0);
  const ta = new Map(style.tblAttrs);
  ta.set('id', String(id)); ta.set('zOrder', String(zOrder)); ta.set('rowCnt', String(nRows)); ta.set('colCnt', String(nCols));
  // 번호 종류: 자동 번호 캡션이 있는 표만 '표'(TABLE). 캡션 없는 표를 TABLE 로 두면 한글이 번호 하나를 먹어 뒤 [표 N] 이 건너뛴다
  ta.set('numberingType', numbering);
  if (headerRows > 0) ta.set('repeatHeader', '1');
  const attrStr = [...ta].map(([k, v]) => `${k}="${escapeAttr(String(v))}"`).join(' ');
  return `<hp:tbl ${attrStr}><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${total}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `${style.pos}${style.outMargin}${captionXml}${style.inMargin}${trs.join('')}</hp:tbl>`;
}
