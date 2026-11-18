// [hwpx-cowork] 있는 표(hp:tbl) 고치기 — 한/글 표 명령을 서버가 XML 로 그대로 한다(2026-10-30).
//   줄·칸 지우기(delete_rows·delete_cols), 줄·칸 넣기(insert_rows·insert_cols), 셀 합치기·나누기(merge·unmerge),
//   테두리(border)·배경(fill), 칸 너비(col_widths)·줄 높이(row_height), 셀 세로 정렬(cell_align), 표 속성(table).
// 한/글 2022 는 이런 표 구조·모양 바꾸기를 변경 추적하지 않는다(줄·칸·합치기·너비·선·채우기 — 실측 scratchpad/track_hangul) — 여기서도 바로 고치고
// 되돌리기는 고치기 전 표 XML 로 한다(서비스 _undoCore). 칸 주소(row·col)는 0부터, doc.tables() 의 cells.row·col 과 같다.
// 셀 XML 은 원문을 살리고 바뀐 것(셀 주소·합침·크기·테두리 번호·세로 정렬)만 고친다. 합친 칸의 글은 차례대로 한 칸에 모은다(빈 칸은 뺀다).
import { createHash } from 'node:crypto';
import { scan, attrs, escapeAttr, escapeText } from './xmlscan.js';
import { EngineError } from './errors.js';

/** 표 XML 지문(되돌리기 전에 그새 바뀌지 않았는지 본다) */
export const tableHash = (xml) => createHash('sha256').update(String(xml)).digest('hex');

const MM = 7200 / 25.4;
const fail = (code, message) => { throw new EngineError(code, message); };
// 한/글 선 굵기 목록(표/셀 속성 — 테두리) — 다른 값은 가장 가까운 것으로
const WIDTHS = ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1.0', '1.5', '2.0', '3.0', '4.0', '5.0'];
export const LINE_TYPES = ['NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM'];
export const TABLE_OPS = ['delete_rows', 'delete_cols', 'insert_rows', 'insert_cols', 'merge', 'unmerge', 'border', 'fill', 'col_widths', 'row_height', 'cell_align', 'table'];
export const BORDER_SIDES = ['all', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'inner_h', 'inner_v'];
const SIDES = ['left', 'right', 'top', 'bottom'];

const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const setAttr = (tag, k, v) => {
  const re = new RegExp(`(\\s${k}=)"[^"]*"`);
  return re.test(tag) ? tag.replace(re, `$1"${escapeAttr(String(v))}"`) : tag.replace(/\s*(\/?)>$/, ` ${k}="${escapeAttr(String(v))}"$1>`);
};
const getAttr = (tag, k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(tag) || [])[1];

/** 표 XML(<hp:tbl>…</hp:tbl>) → 모형 { open, head, tail, rows, cols, cells: [{ open, kids: [{name, xml}], row, col, rowSpan, colSpan, width, height }] } */
export function parseTable(xml) {
  const toks = scan(xml);
  const root = toks.find((t) => t.type === 'open' && t.name === 'hp:tbl');
  if (!root || root.start !== 0) fail('TABLE_XML', '표 XML 이 아닙니다');
  const model = { open: xml.slice(0, root.end), head: '', tail: '', cells: [], trCount: 0 };
  let depth = 0; let headEnd = null; let lastTrEnd = null; let tr = null; let tc = null; let kid = null;
  for (const t of toks) {
    if (t === root) { depth = 1; continue; }
    if (t.type === 'open') depth++;
    const d = t.type === 'selfclose' ? depth : depth - 1;   // 이 토큰의 깊이(표 바로 아래 = 1)
    if (d === 1 && t.name === 'hp:tr' && t.type !== 'close') {
      if (headEnd == null) headEnd = t.start;
      tr = { start: t.start }; model.trCount++;
      if (t.type === 'selfclose') { lastTrEnd = t.end; tr = null; }
    } else if (d === 1 && t.name === 'hp:tr' && t.type === 'close') { lastTrEnd = t.end; tr = null; }
    else if (d === 2 && tr && t.name === 'hp:tc' && t.type === 'open') tc = { open: xml.slice(t.start, t.end), kids: [], start: t.start };
    else if (d === 2 && tc && t.name === 'hp:tc' && t.type === 'close') {
      const c = tc; tc = null;
      const kidAttrs = (name) => { const k = c.kids.find((x) => x.name === name); return k ? attrs(k.xml, scan(k.xml)[0]) : new Map(); };
      const a = kidAttrs('hp:cellAddr'); const s = kidAttrs('hp:cellSpan'); const z = kidAttrs('hp:cellSz');
      Object.assign(c, { row: int(a.get('rowAddr')), col: int(a.get('colAddr')), rowSpan: Math.max(1, int(s.get('rowSpan'), 1)), colSpan: Math.max(1, int(s.get('colSpan'), 1)), width: int(z.get('width')), height: int(z.get('height')) });
      delete c.start; model.cells.push(c);
    } else if (d === 3 && tc && t.type !== 'close') {
      if (t.type === 'selfclose') tc.kids.push({ name: t.name, xml: xml.slice(t.start, t.end) });
      else kid = { name: t.name, start: t.start, depth };
    } else if (kid && t.type === 'close' && depth === kid.depth && t.name === kid.name) {
      tc.kids.push({ name: kid.name, xml: xml.slice(kid.start, t.end) }); kid = null;
    }
    if (t.type === 'close') depth--;
  }
  if (headEnd == null) fail('TABLE_XML', '표에 줄(hp:tr)이 없습니다');
  model.head = xml.slice(root.end, headEnd);
  model.tail = xml.slice(lastTrEnd);
  const ta = attrs(xml, root);
  model.rows = Math.max(int(ta.get('rowCnt')), ...model.cells.map((c) => c.row + c.rowSpan));
  model.cols = Math.max(int(ta.get('colCnt')), ...model.cells.map((c) => c.col + c.colSpan));
  return model;
}

/** 칸 길이(열 너비·줄 높이): 하나짜리 칸에서, 합친 칸만 덮는 자리는 합친 칸에서 남은 몫을 나눠 */
function lengths(cells, n, pos, span, size) {
  const out = new Array(n).fill(null);
  const sorted = [...cells].sort((a, b) => a[span] - b[span]);
  for (let round = 0; round < 3; round++) {
    for (const c of sorted) {
      const idx = []; for (let i = c[pos]; i < c[pos] + c[span] && i < n; i++) idx.push(i);
      const unknown = idx.filter((i) => out[i] == null);
      if (!unknown.length) continue;
      if (c[span] === 1) { out[idx[0]] = c[size]; continue; }
      if (round === 0 && unknown.length > 1) continue;
      const rest = c[size] - idx.filter((i) => out[i] != null).reduce((s, i) => s + out[i], 0);
      for (const i of unknown) out[i] = Math.max(1, Math.round(rest / unknown.length));
    }
  }
  const known = out.filter((v) => v != null);
  const avg = known.length ? Math.round(known.reduce((s, v) => s + v, 0) / known.length) : 1000;
  return out.map((v) => (v == null ? avg : v));
}

/** 칸 → 덮는 자리 격자 grid[r][c] = 셀 */
function gridOf(m) {
  const g = Array.from({ length: m.rows }, () => new Array(m.cols).fill(null));
  for (const c of m.cells) for (let r = c.row; r < c.row + c.rowSpan && r < m.rows; r++) for (let k = c.col; k < c.col + c.colSpan && k < m.cols; k++) g[r][k] = c;
  return g;
}

const kid = (c, name) => c.kids.find((x) => x.name === name) || null;
const borderFillOf = (c) => getAttr(c.open, 'borderFillIDRef') || '1';
const subListOpen = (c) => { const s = kid(c, 'hp:subList'); return s ? (/^<hp:subList\b[^>]*>/.exec(s.xml) || [''])[0] : ''; };
const subListInner = (c) => { const s = kid(c, 'hp:subList'); if (!s) return ''; const o = subListOpen(c); return s.xml.slice(o.length, s.xml.length - '</hp:subList>'.length); };
const setSubListInner = (c, inner) => { const s = kid(c, 'hp:subList'); if (s) s.xml = `${subListOpen(c)}${inner}</hp:subList>`; };
/** 칸에 글·개체가 있는가(빈 칸은 합칠 때 뺀다) */
const cellHasContent = (c) => { const x = subListInner(c); return /<hp:t>[^<]*\S/.test(x) || /<hp:t\b[^>]*>[^<]*\S/.test(x) || /<hp:(tbl|pic|rect|ellipse|line|polygon|curve|arc|container|equation|ole|chart|ctrl)\b/.test(x); };

/** 같은 모양의 빈 칸(스타일 = 본보기 칸 첫 문단의 문단·글자 모양) */
function blankCell(model, src, row, col, rowSpan = 1, colSpan = 1, text = '') {
  const inner = subListInner(src);
  const p = /<hp:p\b[^>]*>/.exec(inner);
  const run = /<hp:run\b[^>]*\bcharPrIDRef="(\d+)"/.exec(inner);
  const pOpen = p ? setAttr(setAttr(setAttr(setAttr(p[0], 'id', '0'), 'pageBreak', '0'), 'columnBreak', '0'), 'merged', '0') : '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
  // [hwpx-cowork] 넣는 줄·칸의 글(values — 합계 줄처럼 새 줄과 그 칸 글을 한 번에): 옆 칸의 문단·글자 모양 그대로
  const t = String(text ?? '').replace(/[\r\n]+/g, ' ');
  const para = `${pOpen}<hp:run charPrIDRef="${run ? run[1] : '0'}"${t ? `><hp:t>${escapeText(t)}</hp:t></hp:run>` : '/>'}</hp:p>`;
  const kids = src.kids.filter((k) => k.name !== 'hp:subList').map((k) => ({ ...k }));
  const sub = kid(src, 'hp:subList');
  const subXml = sub ? `${subListOpen(src)}${para}</hp:subList>` : `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${para}</hp:subList>`;
  return { open: src.open, kids: [{ name: 'hp:subList', xml: subXml }, ...kids], row, col, rowSpan, colSpan, width: 0, height: 0 };
}

/** 칸 범위 { row_from, row_to, col_from, col_to }(포함, 생략하면 표 끝까지) → { r0, r1, c0, c1 } */
function rangeOf(m, rg, name) {
  const r = rg || {};
  const r0 = r.row_from ?? 0; const r1 = r.row_to ?? m.rows - 1; const c0 = r.col_from ?? 0; const c1 = r.col_to ?? m.cols - 1;
  for (const v of [r0, r1, c0, c1]) if (!isInt(v)) fail('TABLE_RANGE', `${name}: 칸 범위는 0 이상의 정수입니다`);
  if (r0 > r1 || c0 > c1 || r1 >= m.rows || c1 >= m.cols) fail('TABLE_RANGE', `${name}: 칸 범위가 표 밖입니다(표 ${m.rows}행×${m.cols}열, 0부터)`);
  return { r0, r1, c0, c1 };
}

function snapWidth(mm) {
  let best = WIDTHS[0];
  for (const w of WIDTHS) if (Math.abs(Number(w) - mm) < Math.abs(Number(best) - mm)) best = w;
  return `${best} mm`;
}

/** borderFill 항목을 고친 새 번호(같은 것이 있으면 그 번호): sides = { left|right|top|bottom: { type?, width?, color? } }, fill = '#RRGGBB' | 'none' | undefined */
export function patchBorderFill(header, id, { sides = {}, fill } = {}) {
  const src = header.block('borderFill', id);
  if (!src) fail('TABLE_STYLE', `테두리 모양 ${id} 을 찾지 못했습니다`);
  let xml = src;
  for (const s of SIDES) {
    const want = sides[s]; if (!want) continue;
    const re = new RegExp(`<hh:${s}Border\\b[^>]*/>`);
    let tag = (re.exec(xml) || [`<hh:${s}Border type="NONE" width="0.1 mm" color="#000000"/>`])[0];
    const had = re.test(xml);
    if (want.type) tag = setAttr(tag, 'type', want.type);
    else if (want.width && getAttr(tag, 'type') === 'NONE') tag = setAttr(tag, 'type', 'SOLID');   // 굵기만 주면 없던 선은 실선으로
    if (want.width) tag = setAttr(tag, 'width', want.width);
    if (want.color) tag = setAttr(tag, 'color', want.color);
    if (had) xml = xml.replace(re, tag);
    else xml = xml.replace(/<hh:diagonal\b|<hc:fillBrush\b|<\/hh:borderFill>/, (m) => tag + m);
  }
  if (fill !== undefined) {
    xml = xml.replace(/<hc:fillBrush\b[\s\S]*?<\/hc:fillBrush>|<hh:fillBrush\b[\s\S]*?<\/hh:fillBrush>/, '');
    if (fill !== 'none') xml = xml.replace('</hh:borderFill>', `<hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill>`);
  }
  return xml === src ? String(id) : header.addItem('borderFills', 'borderFill', xml);
}

/** 선 하나 { type?, width_mm?, color? } → { type, width, color } 꼴(빈 값은 그대로 둠) */
export function lineSpec(line, name) {
  const l = line || {};
  const out = {};
  if (l.type != null) { if (!LINE_TYPES.includes(l.type)) fail('TABLE_SPEC', `${name}: 선 종류는 ${LINE_TYPES.join('·')} 가운데 하나입니다`); out.type = l.type; }
  if (l.width_mm != null) { if (!(typeof l.width_mm === 'number' && l.width_mm > 0 && l.width_mm <= 5)) fail('TABLE_SPEC', `${name}: 선 굵기(width_mm)는 0.1~5 입니다`); out.width = snapWidth(l.width_mm); }
  if (l.color != null) { if (!/^#[0-9a-fA-F]{6}$/.test(l.color)) fail('TABLE_SPEC', `${name}: 선 색은 #RRGGBB 입니다`); out.color = l.color.toUpperCase(); }
  if (!Object.keys(out).length) fail('TABLE_SPEC', `${name}: 선(line)의 type·width_mm·color 가운데 하나는 주세요`);
  return out;
}

/** 지울 칸 XML 에 남은 변경 추적·짝 잃는 메모가 있으면 거절 */
function assertRemovable(cells, name) {
  const x = cells.map((c) => c.kids.map((k) => k.xml).join('')).join('');
  if (/<hp:(insertBegin|deleteBegin|insertEnd|deleteEnd)\b/.test(x)) fail('TABLE_TRACKED', `${name}: 지울 칸에 처리하지 않은 변경 추적이 있습니다 — 먼저 수락·거절하세요`);
  const begins = [...x.matchAll(/<hp:fieldBegin\b[^>]*\bid="(\d+)"/g)].map((m) => m[1]);
  const ends = new Set([...x.matchAll(/<hp:fieldEnd\b[^>]*\bbeginIDRef="(\d+)"/g)].map((m) => m[1]));
  if (begins.some((id) => !ends.has(id))) fail('TABLE_MEMO', `${name}: 지울 칸의 메모가 다른 칸까지 이어집니다 — 메모를 먼저 지우세요`);
}

/** 쓸 조각 하나 하나의 이름(메모·변경 기록용) */
function opLabel(o) {
  const n = (a) => (a || []).length;
  switch (o.op) {
    case 'delete_rows': return `줄 ${n(o.rows)}개 지우기`;
    case 'delete_cols': return `칸 ${n(o.cols)}개 지우기`;
    case 'insert_rows': return `줄 ${o.count || 1}개 ${o.position === 'above' ? '위에' : '아래에'} 넣기`;
    case 'insert_cols': return `칸 ${o.count || 1}개 ${o.position === 'left' ? '왼쪽에' : '오른쪽에'} 넣기`;
    case 'merge': return '셀 합치기';
    case 'unmerge': return '셀 나누기';
    case 'border': return `테두리(${(o.sides || []).join('·')}${o.line?.width_mm ? ` ${o.line.width_mm}mm` : ''}${o.line?.type ? ` ${o.line.type}` : ''})`;
    case 'fill': return o.color && o.color !== 'none' ? `배경 ${o.color}` : '배경 없앰';
    case 'col_widths': return '칸 너비';
    case 'row_height': return '줄 높이';
    case 'cell_align': return `셀 세로 정렬 ${o.vert_align}`;
    case 'table': return '표 속성';
    default: return o.op;
  }
}
export function tableOpLabels(ops) { return (ops || []).map(opLabel); }

/** 고치기 목록 검사(모양만 — 표 크기에 맞는지는 적용할 때). 잘못되면 EngineError TABLE_SPEC */
export function validateTableOps(ops) {
  if (!Array.isArray(ops) || !ops.length) fail('TABLE_SPEC', '표 고치기(ops)가 필요합니다');
  if (ops.length > 40) fail('TABLE_SPEC', '표 고치기는 한 번에 40개까지입니다');
  for (const o of ops) {
    if (!o || typeof o !== 'object' || !TABLE_OPS.includes(o.op)) fail('TABLE_SPEC', `표 고치기 종류(op)는 ${TABLE_OPS.join('·')} 가운데 하나입니다`);
  }
  return ops;
}

/**
 * 표 XML 에 고치기 목록을 차례로 적용한다 → { xml, rows, cols, labels, geometry(크기·구조가 바뀌었는가) }
 * header = 문서 Header(테두리 모양 항목을 더한다 — 미리 보기는 사본을 넘긴다)
 */
export function editTableXml(xml, ops, { header }) {
  validateTableOps(ops);
  const m = parseTable(xml);
  m.cells.forEach((c, i) => { c.orig = i; });   // 되돌릴 때 글을 옮겨 올 원래 칸(새 칸·합친 칸은 없앤다)
  let colW = lengths(m.cells, m.cols, 'col', 'colSpan', 'width');
  let rowH = lengths(m.cells, m.rows, 'row', 'rowSpan', 'height');
  const total0 = colW.reduce((s, v) => s + v, 0);
  let geometry = false; let tblOpen = m.open; let head = m.head;
  const done = [];
  ops.forEach((o, i) => {
    const name = `${i + 1}번째(${o.op})`;
    if (o.op === 'delete_rows' || o.op === 'delete_cols') {
      const rowsOp = o.op === 'delete_rows';
      const list = rowsOp ? o.rows : o.cols; const n = rowsOp ? m.rows : m.cols;
      if (!Array.isArray(list) || !list.length || !list.every(isInt)) fail('TABLE_SPEC', `${name}: 지울 ${rowsOp ? '줄(rows)' : '칸(cols)'} 번호(0부터)가 필요합니다`);
      const del = new Set(list);
      if ([...del].some((x) => x >= n)) fail('TABLE_RANGE', `${name}: 표에 ${rowsOp ? `줄이 ${n}개` : `칸이 ${n}개`}뿐입니다(0부터)`);
      if (del.size >= n) fail('TABLE_RANGE', `${name}: ${rowsOp ? '줄' : '칸'}을 모두 지울 수는 없습니다 — 표째 지우려면 글 고치기로 표 문단을 지우세요`);
      const pos = rowsOp ? 'row' : 'col'; const span = rowsOp ? 'rowSpan' : 'colSpan';
      const shift = (x) => x - [...del].filter((d) => d < x).length;
      const gone = []; const keep = [];
      for (const c of m.cells) {
        const left = []; for (let k = c[pos]; k < c[pos] + c[span]; k++) if (!del.has(k)) left.push(k);
        if (!left.length) gone.push(c); else { c[pos] = shift(left[0]); c[span] = left.length; keep.push(c); }
      }
      assertRemovable(gone, name);
      m.cells = keep;
      if (rowsOp) { rowH = rowH.filter((_, k) => !del.has(k)); m.rows -= del.size; }
      else {
        colW = colW.filter((_, k) => !del.has(k)); m.cols -= del.size;
        if (o.keep_width !== false) { const t = colW.reduce((s, v) => s + v, 0); colW = colW.map((w) => Math.round((w * total0) / t)); }
      }
      geometry = true;
    } else if (o.op === 'insert_rows' || o.op === 'insert_cols') {
      const rowsOp = o.op === 'insert_rows';
      const at = rowsOp ? o.row : o.col; const n = rowsOp ? m.rows : m.cols;
      if (!isInt(at) || at >= n) fail('TABLE_RANGE', `${name}: 기준 ${rowsOp ? '줄(row)' : '칸(col)'} 번호가 표 밖입니다(0..${n - 1})`);
      const count = o.count == null ? 1 : o.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 50) fail('TABLE_SPEC', `${name}: 넣을 개수(count)는 1~50 입니다`);
      // values[j][k] = j 번째 새 줄(칸)의 k 번째 칸(줄) 글(합친 칸은 그 첫 자리)
      if (o.values != null && (!Array.isArray(o.values) || o.values.length > count || o.values.some((v) => !Array.isArray(v) || v.some((x) => typeof x !== 'string')))) fail('TABLE_SPEC', `${name}: values 는 새 ${rowsOp ? '줄' : '칸'}마다 글 배열입니다(${count}개까지)`);
      const after = rowsOp ? o.position !== 'above' : o.position !== 'left';
      const ins = after ? at + 1 : at;   // 새 줄·칸이 들어갈 번호
      const pos = rowsOp ? 'row' : 'col'; const span = rowsOp ? 'rowSpan' : 'colSpan';
      const other = rowsOp ? 'col' : 'row'; const otherSpan = rowsOp ? 'colSpan' : 'rowSpan';
      const g = gridOf(m);
      const across = new Set();   // 새 자리를 가로질러 늘어나는 합친 칸
      for (const c of m.cells) if (c[pos] < ins && ins < c[pos] + c[span]) across.add(c);
      const fresh = [];
      const m2 = rowsOp ? m.cols : m.rows;
      for (let k = 0; k < m2; k++) {
        const ref = rowsOp ? g[at][k] : g[k][at];
        if (!ref || across.has(ref)) continue;
        if (ref[other] < k) continue;   // 앞 자리에서 이미 만든 칸(합친 칸 폭)
        let w = 1; while (w < ref[otherSpan] && k + w < m2) { const nx = rowsOp ? g[at][k + w] : g[k + w][at]; if (nx !== ref) break; w++; }
        for (let j = 0; j < count; j++) {
          const text = o.values?.[j]?.[k] ?? '';
          const b = rowsOp ? blankCell(m, ref, 0, k, 1, w, text) : blankCell(m, ref, k, 0, w, 1, text);
          b[pos] = ins + j; fresh.push(b);
        }
      }
      for (const c of m.cells) { if (across.has(c)) c[span] += count; else if (c[pos] >= ins) c[pos] += count; }
      m.cells.push(...fresh);
      if (rowsOp) { rowH.splice(ins, 0, ...new Array(count).fill(rowH[at])); m.rows += count; }
      else {
        colW.splice(ins, 0, ...new Array(count).fill(colW[at])); m.cols += count;
        if (o.keep_width !== false) { const t = colW.reduce((s, v) => s + v, 0); colW = colW.map((w) => Math.round((w * total0) / t)); }
      }
      geometry = true;
    } else if (o.op === 'merge') {
      const { r0, r1, c0, c1 } = rangeOf(m, o.range, name);
      if (r0 === r1 && c0 === c1) fail('TABLE_RANGE', `${name}: 합칠 칸이 하나뿐입니다`);
      const inside = m.cells.filter((c) => c.row <= r1 && c.row + c.rowSpan - 1 >= r0 && c.col <= c1 && c.col + c.colSpan - 1 >= c0);
      if (inside.some((c) => c.row < r0 || c.row + c.rowSpan - 1 > r1 || c.col < c0 || c.col + c.colSpan - 1 > c1)) fail('TABLE_RANGE', `${name}: 범위가 이미 합친 칸의 가운데를 자릅니다 — 합친 칸 전체를 포함하세요`);
      const g = gridOf(m);
      const top = g[r0][c0];
      const ordered = [...inside].sort((a, b) => a.row - b.row || a.col - b.col);
      const rest = ordered.filter((c) => c !== top);
      // 글: 왼쪽 위 칸 + 글이 있는 다른 칸의 문단을 차례대로(왼쪽 위 칸이 비면 그 빈 문단은 뺀다)
      const filled = rest.filter(cellHasContent);
      if (filled.length) setSubListInner(top, (cellHasContent(top) ? subListInner(top) : '') + filled.map(subListInner).join(''));
      top.orig = null;
      // 테두리: 왼쪽·위 = 왼쪽 위 칸, 오른쪽 = 오른쪽 위 칸, 아래 = 왼쪽 아래 칸
      const sideFrom = (c, s) => (new RegExp(`<hh:${s}Border\\b[^>]*/>`).exec(header.block('borderFill', borderFillOf(c)) || '') || [])[0];
      const tr = g[r0][c1]; const bl = g[r1][c0];
      const want = {};
      for (const [s, c] of [['right', tr], ['bottom', bl]]) {
        const tag = c && c !== top ? sideFrom(c, s) : null;
        if (tag) want[s] = { type: getAttr(tag, 'type'), width: getAttr(tag, 'width'), color: getAttr(tag, 'color') };
      }
      if (Object.keys(want).length) top.open = setAttr(top.open, 'borderFillIDRef', patchBorderFill(header, borderFillOf(top), { sides: want }));
      assertRemovable(rest.filter((c) => !filled.includes(c)), name);
      m.cells = m.cells.filter((c) => !rest.includes(c));
      top.rowSpan = r1 - r0 + 1; top.colSpan = c1 - c0 + 1;
      geometry = true;
    } else if (o.op === 'unmerge') {
      if (!isInt(o.row) || !isInt(o.col) || o.row >= m.rows || o.col >= m.cols) fail('TABLE_RANGE', `${name}: 나눌 칸(row·col)이 표 밖입니다`);
      const c = gridOf(m)[o.row][o.col];
      if (!c || (c.rowSpan === 1 && c.colSpan === 1)) fail('TABLE_RANGE', `${name}: (${o.row}, ${o.col}) 칸은 합친 칸이 아닙니다`);
      for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) if (r !== c.row || k !== c.col) m.cells.push(blankCell(m, c, r, k));
      c.rowSpan = 1; c.colSpan = 1;
      geometry = true;
    } else if (o.op === 'border') {
      const { r0, r1, c0, c1 } = rangeOf(m, o.range, name);
      const sides = Array.isArray(o.sides) && o.sides.length ? o.sides : ['all'];
      if (sides.some((s) => !BORDER_SIDES.includes(s))) fail('TABLE_SPEC', `${name}: sides 는 ${BORDER_SIDES.join('·')} 입니다`);
      const has = (k) => sides.includes(k) || sides.includes('all') || (['top', 'bottom', 'left', 'right'].includes(k) && sides.includes('outer')) || (['inner_h', 'inner_v'].includes(k) && sides.includes('inner'));
      const line = lineSpec(o.line, name);
      const g = gridOf(m); const plan = new Map();
      const put = (c, s) => { if (!c) return; if (!plan.has(c)) plan.set(c, {}); plan.get(c)[s] = line; };
      // 가로선 y(줄 y-1 과 y 사이), 세로선 x(칸 x-1 과 x 사이): 맞닿은 두 칸의 그쪽 변을 함께(한/글 셀 테두리처럼). 합친 칸 가운데는 선이 없다
      const hLine = (y) => { for (let k = c0; k <= c1; k++) { const a = y > 0 ? g[y - 1][k] : null; const b = y < m.rows ? g[y][k] : null; if (a && a === b) continue; put(a, 'bottom'); put(b, 'top'); } };
      const vLine = (x) => { for (let r = r0; r <= r1; r++) { const a = x > 0 ? g[r][x - 1] : null; const b = x < m.cols ? g[r][x] : null; if (a && a === b) continue; put(a, 'right'); put(b, 'left'); } };
      if (has('top')) hLine(r0);
      if (has('bottom')) hLine(r1 + 1);
      if (has('inner_h')) for (let y = r0 + 1; y <= r1; y++) hLine(y);
      if (has('left')) vLine(c0);
      if (has('right')) vLine(c1 + 1);
      if (has('inner_v')) for (let x = c0 + 1; x <= c1; x++) vLine(x);
      for (const [c, s] of plan) c.open = setAttr(c.open, 'borderFillIDRef', patchBorderFill(header, borderFillOf(c), { sides: s }));
    } else if (o.op === 'fill') {
      const { r0, r1, c0, c1 } = rangeOf(m, o.range, name);
      const color = o.color == null || o.color === 'none' ? 'none' : String(o.color);
      if (color !== 'none' && !/^#[0-9a-fA-F]{6}$/.test(color)) fail('TABLE_SPEC', `${name}: 배경색은 #RRGGBB 또는 none 입니다`);
      for (const c of m.cells) if (c.row <= r1 && c.row + c.rowSpan - 1 >= r0 && c.col <= c1 && c.col + c.colSpan - 1 >= c0) c.open = setAttr(c.open, 'borderFillIDRef', patchBorderFill(header, borderFillOf(c), { fill: color === 'none' ? 'none' : color.toUpperCase() }));
    } else if (o.op === 'col_widths') {
      const w = o.widths;
      if (!Array.isArray(w) || w.length !== m.cols || !w.every((x) => typeof x === 'number' && x > 0)) fail('TABLE_SPEC', `${name}: widths 는 칸 ${m.cols}개의 너비 비율(양수) 배열입니다`);
      const total = o.total_mm != null ? Math.round(o.total_mm * MM) : colW.reduce((s, v) => s + v, 0);
      if (o.total_mm != null && !(o.total_mm >= 10 && o.total_mm <= 600)) fail('TABLE_SPEC', `${name}: total_mm 는 10~600 입니다`);
      const sum = w.reduce((s, v) => s + v, 0);
      colW = w.map((x) => Math.max(200, Math.round((x * total) / sum)));
      geometry = true;
    } else if (o.op === 'row_height') {
      const rows = Array.isArray(o.rows) && o.rows.length ? o.rows : rowH.map((_, k) => k);
      if (!rows.every((r) => isInt(r) && r < m.rows)) fail('TABLE_RANGE', `${name}: 줄 번호가 표 밖입니다(0..${m.rows - 1})`);
      if (!(typeof o.height_mm === 'number' && o.height_mm >= 1 && o.height_mm <= 300)) fail('TABLE_SPEC', `${name}: height_mm 는 1~300 입니다`);
      for (const r of rows) rowH[r] = Math.round(o.height_mm * MM);
      geometry = true;
    } else if (o.op === 'cell_align') {
      const { r0, r1, c0, c1 } = rangeOf(m, o.range, name);
      if (!['TOP', 'CENTER', 'BOTTOM'].includes(o.vert_align)) fail('TABLE_SPEC', `${name}: vert_align 은 TOP·CENTER·BOTTOM 입니다`);
      for (const c of m.cells) {
        if (!(c.row <= r1 && c.row + c.rowSpan - 1 >= r0 && c.col <= c1 && c.col + c.colSpan - 1 >= c0)) continue;
        const s = kid(c, 'hp:subList'); if (!s) continue;
        const open = subListOpen(c); s.xml = setAttr(open, 'vertAlign', o.vert_align) + s.xml.slice(open.length);
      }
    } else if (o.op === 'table') {
      let any = false;
      if (o.header_rows != null) {
        if (!Number.isSafeInteger(o.header_rows) || o.header_rows < 0 || o.header_rows > m.rows) fail('TABLE_SPEC', `${name}: header_rows 는 0..${m.rows} 입니다`);
        for (const c of m.cells) c.open = setAttr(c.open, 'header', c.row < o.header_rows ? '1' : '0');
        any = true;
      }
      if (o.repeat_header != null) { tblOpen = setAttr(tblOpen, 'repeatHeader', o.repeat_header ? '1' : '0'); any = true; }
      if (o.width_mm != null) {
        if (!(o.width_mm >= 10 && o.width_mm <= 600)) fail('TABLE_SPEC', `${name}: width_mm 는 10~600 입니다`);
        const t = colW.reduce((s, v) => s + v, 0); const want = Math.round(o.width_mm * MM);
        colW = colW.map((w) => Math.max(200, Math.round((w * want) / t))); geometry = true; any = true;
      }
      if (o.treat_as_char != null) { head = head.replace(/<hp:pos\b[^>]*\/>/, (p) => setAttr(p, 'treatAsChar', o.treat_as_char ? '1' : '0')); any = true; }
      if (o.align != null) {
        if (!['LEFT', 'CENTER', 'RIGHT'].includes(o.align)) fail('TABLE_SPEC', `${name}: align 은 LEFT·CENTER·RIGHT 입니다`);
        head = head.replace(/<hp:pos\b[^>]*\/>/, (p) => setAttr(setAttr(p, 'horzAlign', o.align), 'horzOffset', '0')); any = true;
      }
      if (o.page_break != null) {
        if (!['CELL', 'TABLE', 'NONE'].includes(o.page_break)) fail('TABLE_SPEC', `${name}: page_break 는 CELL(셀 단위로 나눔)·TABLE(나눔)·NONE(나누지 않음) 입니다`);
        tblOpen = setAttr(tblOpen, 'pageBreak', o.page_break); any = true;
      }
      if (!any) fail('TABLE_SPEC', `${name}: 바꿀 표 속성(header_rows·repeat_header·width_mm·treat_as_char·align·page_break)이 없습니다`);
    }
    done.push(opLabel(o));
  });
  // [hwpx-cowork] 2026-11-04 칸이 하나도 시작하지 않는 줄(줄 전체를 합친 뒤 등)은 없앤다 — 한/글 2022 는 빈 <hp:tr/> 이 든 표를 열지 않고,
  // 한/글 자신은 두 줄 전체를 합치면 그 줄을 없애 rowCnt 를 줄이고 합친 칸 rowSpan 을 줄이며 높이는 두 줄 합으로 둔다(5차 save 실측 hg-merge.py).
  if (compactRows(m, rowH)) geometry = true;
  // 다시 쓰기: 줄마다 그 줄에서 시작하는 칸(칸 차례), 셀 주소·합침·크기를 격자에서
  const total = colW.reduce((s, v) => s + v, 0); const height = rowH.reduce((s, v) => s + v, 0);
  const sum = (arr, a, n) => arr.slice(a, a + n).reduce((s, v) => s + v, 0);
  const cellXml = (c) => {
    const kids = c.kids.map((k) => {
      if (k.name === 'hp:cellAddr') return { ...k, xml: setAttr(setAttr(k.xml, 'colAddr', c.col), 'rowAddr', c.row) };
      if (k.name === 'hp:cellSpan') return { ...k, xml: setAttr(setAttr(k.xml, 'colSpan', c.colSpan), 'rowSpan', c.rowSpan) };
      if (k.name === 'hp:cellSz' && geometry) return { ...k, xml: setAttr(setAttr(k.xml, 'width', sum(colW, c.col, c.colSpan)), 'height', sum(rowH, c.row, c.rowSpan)) };
      return k;
    });
    let body = kids.map((k) => k.xml).join('');
    // 크기가 바뀐 칸의 줄 정보(linesegarray — 옛 폭)는 지워 한/글·편집기가 다시 재게 한다
    if (geometry) body = body.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '').replace(/<hp:linesegarray\/>/g, '');
    return `${c.open}${body}</hp:tc>`;
  };
  const trs = [];
  for (let r = 0; r < m.rows; r++) {
    const row = m.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    trs.push(row.length ? `<hp:tr>${row.map(cellXml).join('')}</hp:tr>` : '<hp:tr/>');
  }
  if (geometry) {
    tblOpen = setAttr(setAttr(tblOpen, 'rowCnt', m.rows), 'colCnt', m.cols);
    head = head.replace(/<hp:sz\b[^>]*\/>/, (s) => setAttr(setAttr(s, 'width', total), 'height', height))
      .replace(/(<hp:caption\b[^>]*\blastWidth=")\d+(")/, `$1${total}$2`);
  }
  const out = `${tblOpen}${head}${trs.join('')}${m.tail}`;
  // 되돌리기 기록: 고친 뒤 표 뼈대 지문(칸 글·캡션 글은 뺀다 — 그새 작업 기록 메모·칸 글이 바뀌어도 되돌린다)과 고친 뒤 칸 → 원래 칸 번호
  const origins = m.cells.filter((c) => c.orig != null).map((c) => [c.row, c.col, c.orig]);
  return { xml: out, rows: m.rows, cols: m.cols, labels: done, geometry, undo: { skeleton: tableSkeletonHash(out), origins } };
}

/** [hwpx-cowork] 2026-11-04 칸이 시작하지 않는 줄을 없앤다(그 줄 높이는 바로 위 남는 줄에 더하고, 그 줄을 지나던 칸의 rowSpan 을 줄인다). 바꿨으면 true */
function compactRows(m, rowH) {
  const used = [...new Set(m.cells.map((c) => c.row))].filter((r) => r < m.rows).sort((a, b) => a - b);
  if (!used.length || used.length === m.rows) return false;
  const h = used.map(() => 0);
  for (let r = 0, k = 0; r < m.rows; r++) { while (k + 1 < used.length && used[k + 1] <= r) k++; h[k] += rowH[r] || 0; }
  for (const c of m.cells) {
    const end = c.row + c.rowSpan;
    c.rowSpan = Math.max(1, used.filter((r) => r >= c.row && r < end).length);
    c.row = used.indexOf(c.row);
  }
  rowH.splice(0, rowH.length, ...h);
  m.rows = used.length;
  return true;
}

/** 표 뼈대 지문: 표·캡션 여는 태그, 표 크기·위치, 칸마다 주소·합침·크기·여는 태그(테두리 번호) — 칸 글·캡션 글은 뺀다 */
export function tableSkeletonHash(xml) {
  const m = parseTable(xml);
  const head = m.head.replace(/(<hp:caption[^>]*>)[\s\S]*?<\/hp:caption>/, '$1');
  const cells = m.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.width, c.height, c.open, subListOpen(c)]);
  return tableHash(JSON.stringify([m.open, head, m.rows, m.cols, cells]));
}

/**
 * 표 고치기 되돌리기: 지금 표(current)의 뼈대가 고친 뒤 그대로(undo.skeleton)일 때만 고치기 전 표(before)로 — 원래 칸 글은 지금 칸 글로(그새 고친 글·
 * 메모를 살린다 — 지운 칸·합친 칸은 고치기 전 글), 캡션은 지금 캡션(폭 lastWidth 만 고치기 전 값). 뼈대가 바뀌었으면 STALE
 */
export function restoreTableXml(current, before, undo) {
  if (!undo?.skeleton || tableSkeletonHash(current) !== undo.skeleton) fail('STALE', '표를 고친 뒤 표 구조·모양이 다시 바뀌어 되돌릴 수 없습니다');
  const cur = parseTable(current); const old = parseTable(before);
  const at = new Map(cur.cells.map((c) => [`${c.row},${c.col}`, c]));
  for (const [r, c, i] of undo.origins || []) {
    const now = at.get(`${r},${c}`); const was = old.cells[i];
    const sub = now && kid(now, 'hp:subList'); const target = was && kid(was, 'hp:subList');
    if (sub && target) target.xml = sub.xml;
  }
  let head = old.head;
  const capNow = /<hp:caption[\s\S]*?<\/hp:caption>/.exec(cur.head); const capOld = /<hp:caption[^>]*>/.exec(old.head);
  if (capNow && capOld) {
    const lw = getAttr(capOld[0], 'lastWidth');
    head = head.replace(/<hp:caption[\s\S]*?<\/hp:caption>/, () => (lw != null ? capNow[0].replace(/^<hp:caption[^>]*>/, (t) => setAttr(t, 'lastWidth', lw)) : capNow[0]));
  }
  const trs = [];
  for (let r = 0; r < old.rows; r++) {
    const row = old.cells.filter((c) => c.row === r);
    trs.push(row.length ? `<hp:tr>${row.map((c) => `${c.open}${c.kids.map((k) => k.xml).join('')}</hp:tc>`).join('')}</hp:tr>` : '<hp:tr/>');
  }
  return `${old.open}${head}${trs.join('')}${old.tail}`;
}
