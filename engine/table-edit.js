// [hwpx-cowork] 있는 표(hp:tbl) 고치기 — 한/글 표 명령을 서버가 XML 로 그대로 한다(2026-10-30).
//   줄·칸 지우기(delete_rows·delete_cols), 줄·칸 넣기(insert_rows·insert_cols), 셀 합치기·나누기(merge·unmerge),
//   테두리(border)·배경(fill), 칸 너비(col_widths)·줄 높이(row_height), 셀 세로 정렬(cell_align), 표 속성(table).
// 한/글 2022 는 이런 표 구조·모양 바꾸기를 변경 추적하지 않는다(줄·칸·합치기·너비·선·채우기 — 실측 scratchpad/track_hangul) — 여기서도 바로 고치고
// 되돌리기는 고치기 전 표 XML 로 한다(서비스 _undoCore). 칸 주소(row·col)는 0부터, doc.tables() 의 cells.row·col 과 같다.
// 셀 XML 은 원문을 살리고 바뀐 것(셀 주소·합침·크기·테두리 번호·세로 정렬)만 고친다. 합친 칸의 글은 차례대로 한 칸에 모은다(빈 칸은 뺀다).
// 2026-11-19: 칸 안 문단을 넣고·지우고·통째로 다시 쓰는 cell_paragraphs(CELL_OPS — 새 MCP 연결이 안에서 쓰는 op, 아래 '칸 문단 다시 짜기').
import { createHash } from 'node:crypto';
import { scan, attrs, attr, escapeAttr, escapeText, decodeEntities } from './xmlscan.js';
import { EngineError } from './errors.js';

/** 표 XML 지문(되돌리기 전에 그새 바뀌지 않았는지 본다) */
export const tableHash = (xml) => createHash('sha256').update(String(xml)).digest('hex');

const MM = 7200 / 25.4;
const fail = (code, message) => { throw new EngineError(code, message); };
// 한/글 선 굵기 목록(표/셀 속성 — 테두리) — 다른 값은 가장 가까운 것으로
const WIDTHS = ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1.0', '1.5', '2.0', '3.0', '4.0', '5.0'];
export const LINE_TYPES = ['NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM'];
export const TABLE_OPS = ['delete_rows', 'delete_cols', 'insert_rows', 'insert_cols', 'merge', 'unmerge', 'border', 'fill', 'col_widths', 'row_height', 'cell_align', 'table'];
// [hwpx-cowork] 2026-11-19 칸 문단 다시 짜기(cell_paragraphs — 아래 rebuildCell). 새 MCP 연결(server/mcp2/ops.js)이 칸 통째로 다시 쓰기·칸 안 문단 넣기·지우기를
// 이 op 로 푼다. 도구가 받는 표 고치기 목록(TABLE_OPS — server/table-schema.js TableOpSchema 의 op 이름)에는 싣지 않는다(예전 연결의 도구 꼴은 그대로).
export const CELL_OPS = ['cell_paragraphs'];
export const CELL_PARAGRAPHS_MAX = 500;
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

// ───────── 칸 문단 다시 짜기(cell_paragraphs — 2026-11-19, docs/MCP_REDESIGN_2026-11-16.md §17) ─────────
// 회의록 서식처럼 내용이 표 칸 하나에 문단 여럿으로 든 문서에서 칸 안 문단을 넣고 지울 길이 없었다(2026-11-19 실제 Codex 실행 3건이 그 칸을 다시 쓰지 못했다 —
// 새 글을 줄바꿈으로 한 문단에 몰아 넣거나 빈 문단을 남겼다). 다른 표 고치기처럼 변경 추적 없이 바로 고치고, 되돌리기는 고치기 전 표 XML 로 한다.
//   op: { op:'cell_paragraphs', row, col, count(제안할 때 그 칸의 문단 수), paragraphs:[{keep:k} | {text, like?:k, near?:k}], expect?(사라질 문단의 글 지문 — 제안할 때 엔진이 적는다) }
//   · {keep:k} = 지금 k 번째(0부터) 문단을 원문 그대로 둔다(차례대로 한 번씩). {text} = 새 문단 — 문단·글자 모양은 like 번째 문단을 따른다
//     (없으면 같은 글머리(□·ㅇ·- …)로 시작하는 문단 가운데 near 에 가장 가까운 것 — near 가 없으면 바로 앞에 남긴 문단·그 자리 — 그런 문단이 없으면 near 자리 문단)
//   · 남기지 않는 문단은 사라진다 — 글만 든 문단만(표·그림·메모·각주 같은 개체·조판 부호나 처리 안 된 변경 추적이 있으면 거절: 그 문단은 keep 으로 남긴다)
const LINESEG = /<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>|<hp:linesegarray\/>/g;
// 칸 문단에 든 단 정의(hp:colPr — 본문 첫 문단에서 옮겨 붙인 글에 딸려 온다)는 글만 든 문단으로 본다(첫 문단의 것은 새 첫 문단으로 옮긴다)
const COLPR = /<hp:ctrl\b[^>]*>\s*<hp:colPr\b[^>]*\/>\s*<\/hp:ctrl>/g;
const NOT_PLAIN = /<hp:(?:ctrl|secPr|tbl|pic|rect|ellipse|line|polygon|curve|arc|container|equation|ole|chart|textart|connectLine|video|compose|dutmal|switch|form|insertBegin|insertEnd|deleteBegin|deleteEnd)\b/;
const inlineXml = (text) => String(text).split(/\r?\n/).map((line) => escapeText(line).replace(/\t/g, '<hp:tab/>')).join('<hp:lineBreak/>');
const shortHash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const clipText = (s, max) => { const t = [...String(s ?? '')]; return t.length > max ? `${t.slice(0, max).join('')}…` : t.join(''); };

/** 칸 subList 안 XML → 가장 바깥 문단(hp:p)들의 XML(문단 안 표·글상자의 문단은 그 문단 XML 에 든다) | null(문단 밖에 다른 것이 있어 다시 짤 수 없음) */
function cellParagraphs(inner) {
  const out = []; let depth = 0; let start = -1;
  for (const t of scan(inner)) {
    if (t.type === 'open') { if (depth === 0) { if (t.name !== 'hp:p') return null; start = t.start; } depth++; }
    else if (t.type === 'close') { depth--; if (depth < 0) return null; if (depth === 0) out.push(inner.slice(start, t.end)); }
    else if (t.type === 'selfclose') { if (depth === 0) { if (t.name !== 'hp:p') return null; out.push(inner.slice(t.start, t.end)); } }
    else if (depth === 0 && inner.slice(t.start, t.end).trim()) return null;
  }
  return depth === 0 ? out : null;
}

/** 칸 문단 하나(가장 바깥 hp:p XML) → { open(여는 태그), runs: [{ charPr, text }](가장 바깥 run 의 글 — 문단 안 개체의 글은 세지 않는다), text, plain(글만 든 문단인가), colPr(단 정의 XML | null) } */
function paraInfo(xml) {
  const runs = []; let depth = 0; let run = null; let inT = false; let columnCharPr = null;
  for (const t of scan(xml)) {
    // 이 문단의 run/ctrl 바로 아래 단 정의만 따른다. 칸 안의 중첩 표·글상자는 자체 단 정의를 가질 수 있다.
    if (depth === 3 && run && t.name === 'hp:colPr' && (t.type === 'open' || t.type === 'selfclose')) columnCharPr ??= run.charPr;
    if (t.type === 'open') {
      depth++;
      if (depth === 2 && t.name === 'hp:run') { run = { charPr: attr(xml, t, 'charPrIDRef') ?? '0', text: '' }; runs.push(run); }
      else if (depth === 3 && run && t.name === 'hp:t') inT = true;
    } else if (t.type === 'close') {
      if (depth === 3 && t.name === 'hp:t') inT = false;
      if (depth === 2 && t.name === 'hp:run') run = null;
      depth--;
    } else if (t.type === 'selfclose') {
      if (depth === 1 && t.name === 'hp:run') runs.push({ charPr: attr(xml, t, 'charPrIDRef') ?? '0', text: '' });
      else if (inT && depth === 3 && run) { if (t.name === 'hp:lineBreak') run.text += '\n'; else if (t.name === 'hp:tab') run.text += '\t'; }
    } else if (t.type === 'text' && inT && depth === 3 && run) run.text += t.cdata ? xml.slice(t.start + 9, t.end - 3) : decodeEntities(xml.slice(t.start, t.end));
  }
  const open = (/^<hp:p\b[^>]*>/.exec(xml) || [''])[0].replace(/\s*\/>$/, '>');
  return { open, runs, text: runs.map((r) => r.text).join(''), plain: !NOT_PLAIN.test(xml.replace(COLPR, '')), colPr: (xml.match(COLPR) || [null])[0], columnCharPr };
}

/**
 * 문단 글머리 갈래: 빈 줄 'blank', 기호(□·ㅇ·-·※ …)는 그 글자, 번호 꼴('1.'·'(1)'·'가.'·'(가)'·'①'), 그 밖의 글 'text'.
 * 새 칸 문단이 따를 모양(같은 갈래의 가까운 문단)을 고르는 데만 쓴다 — 서식 문서의 칸은 제목 줄(□)과 항목 줄(ㅇ)의 문단 모양이 다를 수 있다
 */
export function paraMarker(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'blank';
  if (/^\d+[.)]/.test(t)) return '1.';
  if (/^\(\d+\)/.test(t)) return '(1)';
  if (/^[가-힣][.)]\s/.test(t)) return '가.';
  if (/^\([가-힣]\)/.test(t)) return '(가)';
  if (/^[①-⑳㉠-㉻]/.test(t)) return '①';
  const ch = [...t][0];
  // 낱자(ㅇ·ㅁ — 공문서 글머리로 쓴다)는 기호로 본다
  return /[\p{L}\p{N}]/u.test(ch) && !/[ㄱ-ㆎ]/.test(ch) ? 'text' : ch;
}

/** 새 칸 문단 XML: like(paraInfo)의 문단 모양·스타일과 글이 가장 많은 run 의 글자 모양 */
function freshParagraph(like, text) {
  let open = like?.open || '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
  for (const [k, v] of [['id', '0'], ['pageBreak', '0'], ['columnBreak', '0'], ['merged', '0']]) open = setAttr(open, k, v);
  let main = like?.runs[0] || null;
  for (const r of like?.runs || []) if ([...r.text].length > [...main.text].length) main = r;
  const cp = escapeAttr(String(main?.charPr ?? '0'));
  const t = String(text ?? '');
  return `${open}<hp:run charPrIDRef="${cp}"${t ? `><hp:t>${inlineXml(t)}</hp:t></hp:run>` : '/>'}</hp:p>`;
}

/** 표 하나만 든 칸 문단(like 의 문단 모양·스타일, 글이 가장 많은 run 의 글자 모양) — 한/글이 칸 안에 만든 표 문단과 같은 꼴(표 뒤 빈 hp:t) */
function tableParagraph(like, tblXml) {
  let open = like?.open || '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
  for (const [k, v] of [['id', '0'], ['pageBreak', '0'], ['columnBreak', '0'], ['merged', '0']]) open = setAttr(open, k, v);
  let main = like?.runs[0] || null;
  for (const r of like?.runs || []) if ([...r.text].length > [...main.text].length) main = r;
  return `${open}<hp:run charPrIDRef="${escapeAttr(String(main?.charPr ?? '0'))}">${tblXml}<hp:t/></hp:run></hp:p>`;
}

/** 칸 안쪽 폭(HWPUNIT) = 칸 폭 − 왼·오른 안 여백(칸 여백 hasMargin=1 이면 그 칸의 hp:cellMargin, 아니면 표의 hp:inMargin) */
function cellInnerWidth(c, inMargin) {
  const own = getAttr(c.open, 'hasMargin') === '1' ? kid(c, 'hp:cellMargin')?.xml : null;
  const m = own || inMargin || '';
  const side = (k) => { const v = new RegExp(`\\b${k}="(\\d+)"`).exec(m); return v ? Number(v[1]) : 510; };
  return Math.max(0, (c.width || 0) - side('left') - side('right'));
}

/** 칸 글 지문(되돌리기 전에 그새 그 칸이 바뀌지 않았는지): 문단마다 문단 모양·스타일과 같은 글자 모양끼리 이은 글. 줄 정보·run 나뉨은 보지 않는다 */
function cellSignature(c) {
  const ps = (kid(c, 'hp:subList') ? cellParagraphs(subListInner(c)) : null) || [];
  return shortHash(JSON.stringify(ps.map((x) => {
    const i = paraInfo(x); const runs = [];
    for (const r of i.runs) { if (!r.text) continue; const p = runs[runs.length - 1]; if (p && p[0] === r.charPr) p[1] += r.text; else runs.push([r.charPr, r.text]); }
    return [getAttr(i.open, 'paraPrIDRef') ?? '', getAttr(i.open, 'styleIDRef') ?? '', runs, i.plain];
  })));
}

/**
 * 칸 c 의 문단을 o.paragraphs 대로 다시 짠다(c 의 subList 를 고친다) → { map(옛 문단 k → 새 차례 | null = 사라짐), count(새 문단 수), expect(사라진 문단의 글 지문), label }.
 * 던짐: TABLE_SPEC·TABLE_RANGE(꼴·범위), TABLE_CELL_SHAPE(문단 수가 읽은 주소와 다름), TABLE_CELL_OBJECT(글만 든 문단이 아닌 것을 지우려 함), STALE(제안 뒤 그 칸이 바뀜)
 */
function rebuildCell(c, o, nm, { cellTable = null, inMargin = null } = {}) {
  const olds = kid(c, 'hp:subList') ? cellParagraphs(subListInner(c)) : null;
  if (!olds?.length) fail('TABLE_XML', `${nm}: 칸의 문단을 읽지 못했습니다`);
  const M = olds.length; const list = o.paragraphs;
  if (o.count != null && o.count !== M) {
    if (o.expect) fail('STALE', `${nm}: 제안한 뒤 그 칸의 문단 수가 바뀌었습니다(${o.count} → ${M}개) — 다시 읽고 제안하세요`);
    fail('TABLE_CELL_SHAPE', `${nm}: 칸의 문단 수(${M})가 읽은 주소의 수(${o.count})와 다릅니다 — 그 칸에 처리하지 않은 변경 추적이 있으면 먼저 수락·거절하세요`);
  }
  if (!Array.isArray(list) || !list.length || list.length > CELL_PARAGRAPHS_MAX) fail('TABLE_SPEC', `${nm}: 새 문단 목록(paragraphs — {keep:k} 또는 {text})이 필요합니다(1~${CELL_PARAGRAPHS_MAX}개)`);
  const info = olds.map(paraInfo);
  const map = new Array(M).fill(null); let last = -1;
  list.forEach((e, j) => {
    if (e && typeof e === 'object' && e.keep != null) {
      if (!isInt(e.keep) || e.keep >= M) fail('TABLE_RANGE', `${nm}: 남길 문단 ${e.keep} — 칸에 문단이 ${M}개뿐입니다(0부터)`);
      if (e.keep <= last) fail('TABLE_SPEC', `${nm}: 남길 문단(keep)은 차례대로 한 번씩만 씁니다`);
      last = e.keep; map[e.keep] = j;
    } else if (e && typeof e === 'object' && e.table && typeof e.table === 'object') {
      // 칸 안 새 표(2026-11-20 §22): 표 XML 은 문서 쪽(engine/doc.js _cellTableFactory — 머리·id·본보기 표)이 만든다
      if (!cellTable) fail('TABLE_SPEC', `${nm}: 칸 안 새 표는 문서 편집(HwpxDoc.editTable)에서만 만들 수 있습니다`);
      if (e.near != null && (!isInt(e.near) || e.near >= M)) fail('TABLE_RANGE', `${nm}: 표를 넣을 자리 문단 ${e.near} — 칸에 문단이 ${M}개뿐입니다(0부터)`);
    } else if (!e || typeof e !== 'object' || typeof e.text !== 'string') fail('TABLE_SPEC', `${nm}: paragraphs 항목은 {keep:k} 또는 {text:'글', like?:k} 또는 {table:{rows…}, near?:k} 입니다`);
    else if (e.like != null && (!isInt(e.like) || e.like >= M)) fail('TABLE_RANGE', `${nm}: 모양을 따를 문단 ${e.like} — 칸에 문단이 ${M}개뿐입니다(0부터)`);
  });
  const gone = []; for (let k = 0; k < M; k++) if (map[k] == null) gone.push(k);
  const bad = gone.filter((k) => !info[k].plain);
  if (bad.length) fail('TABLE_CELL_OBJECT', `${nm}: ${bad.map((k) => k + 1).join('·')}번째 문단에 표·그림·메모·각주 같은 개체나 조판 부호(또는 처리하지 않은 변경 추적)가 있어 지우거나 통째로 바꿀 수 없습니다 — 그 문단은 남기고 글만 고치세요`);
  const expect = gone.map((k) => shortHash(info[k].text));
  // 반영(제안 때 적어 둔 지문이 있다): 사라질 문단의 글이 제안 때 그대로이거나 그새 비워졌을 때만 — 사람이 그 뒤 고친 글을 지우지 않는다
  if (o.expect && (o.expect.length !== gone.length || gone.some((k, i) => info[k].text !== '' && o.expect[i] !== expect[i]))) fail('STALE', `${nm}: 제안한 뒤 지울 문단의 글이 바뀌었습니다 — 다시 읽고 제안하세요`);
  // 새 문단이 따를 모양: 같은 글머리 갈래의 가장 가까운 옛 문단(hint = 바로 앞에 남긴 문단, 없으면 그 자리)
  const marks = info.map((x) => paraMarker(x.text));
  const likeOf = (text, hint) => {
    const mk = paraMarker(text); let best = -1;
    for (let k = 0; k < M; k++) if (marks[k] === mk && (best < 0 || Math.abs(k - hint) < Math.abs(best - hint))) best = k;
    return best >= 0 ? best : Math.max(0, Math.min(M - 1, hint));
  };
  let anchor = -1; const fresh = [];
  const parts = list.map((e, j) => {
    if (e.keep != null) { anchor = e.keep; return olds[e.keep].replace(LINESEG, ''); }
    if (e.table) {
      // 칸 안 새 표: 표만 든 문단(한/글·편집기 엔진이 칸 안에 만든 표와 같은 꼴 — vendor/rhwp create_table_in_cell_by_path_native).
      // 문단 모양·스타일·글자 모양은 넣을 자리 문단(near — 없으면 바로 앞에 남긴 문단)의 것, 표 폭은 칸 안쪽 폭(칸 폭 − 칸 안 여백)에서 문서 쪽이 정한다
      const like = info[Math.max(0, Math.min(M - 1, isInt(e.near) ? e.near : anchor >= 0 ? anchor : 0))];
      const tbl = cellTable({ spec: e.table, width: cellInnerWidth(c, inMargin), paraPr: getAttr(like.open, 'paraPrIDRef') ?? '0', styleId: getAttr(like.open, 'styleIDRef') ?? '0',
        charPr: (like.runs.find((r) => r.text) || like.runs[0])?.charPr ?? '0' });
      fresh.push(`[표 ${tbl.rows}×${tbl.cols}]`);
      return tableParagraph(like, tbl.xml);
    }
    fresh.push(e.text);
    const hint = isInt(e.near) ? e.near : anchor >= 0 ? anchor : j;
    return freshParagraph(info[e.like ?? likeOf(e.text, hint)], e.text);
  });
  // 첫 문단이 없어져도 칸의 단 정의는 새 첫 문단에 둔다. 기존 문단이 그 자리에 오면 그 문단의 자체 단 정의가 우선한다.
  if (map[0] == null && info[0].colPr && info[list[0].keep]?.columnCharPr == null) {
    const xml = parts[0]; const tag = scan(xml)[0];
    const open = xml.slice(0, tag.end).replace(/\s*\/>$/, '>');
    const rest = tag.type === 'selfclose' ? '</hp:p>' : xml.slice(tag.end);
    const cp = escapeAttr(info[0].columnCharPr ?? '0');
    parts[0] = `${open}<hp:run charPrIDRef="${cp}">${info[0].colPr}</hp:run>${rest}`;
  }
  setSubListInner(c, parts.join(''));
  // 카드에 보일 글(표 고치기 제안의 labels): 무엇을 몇 문단, 그리고 새 글
  const where = `${c.row + 1}번째 줄 ${c.col + 1}번째 칸`;
  const show = (texts, max) => { const s = clipText(texts.map((x) => String(x).replace(/\s*\n\s*/g, ' ')).join(' ⏎ '), max); return s.trim() ? `: ${s}` : ''; };
  let label;
  const tables = list.filter((e) => e && e.table).length;
  // 칸 안 새 표(빈 문단 자리에 든 경우 포함 — 사라진 문단이 모두 빈 문단이면 '표 넣기')
  if (tables && gone.every((k) => !info[k].text.trim())) label = `셀(${where})에 표 ${tables}개 넣기${show(fresh, 1500)}`;
  else if (gone.length === M) label = `셀(${where}) 글 다시 쓰기 — 문단 ${M} → ${list.length}개${show(fresh, 1500)}`;
  else if (!gone.length) label = `셀(${where})에 문단 ${fresh.length}개 넣기${show(fresh, 1500)}`;
  else if (!fresh.length) label = `셀(${where})의 문단 ${gone.length}개 지우기${show(gone.map((k) => clipText(info[k].text.trim(), 40)).filter(Boolean), 400)}`;
  else label = `셀(${where})의 문단 ${gone.length}개를 ${fresh.length}개로 바꾸기${show(fresh, 1500)}`;
  return { map, count: list.length, expect, label };
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
    if (!o || typeof o !== 'object' || !(TABLE_OPS.includes(o.op) || CELL_OPS.includes(o.op))) fail('TABLE_SPEC', `표 고치기 종류(op)는 ${TABLE_OPS.join('·')} 가운데 하나입니다`);
  }
  return ops;
}

/**
 * 표 XML 에 고치기 목록을 차례로 적용한다 → { xml, rows, cols, labels, geometry(크기·구조가 바뀌었는가) }
 * header = 문서 Header(테두리 모양 항목을 더한다 — 미리 보기는 사본을 넘긴다)
 * [hwpx-cowork] 칸 문단 다시 짜기(cell_paragraphs)가 들면 relayout(표를 품은 문단의 줄 정보를 지워 다시 재게 한다), stamps(op 차례 — 그 op 의 사라질 문단 글 지문:
 * 제안할 때 op.expect 로 적어 둔다), cellMoves(모든 op 가 칸 문단 다시 짜기일 때만 — [{ row, col, map, count }], 중첩 주소 옮기기용)를 더 준다
 */
export function editTableXml(xml, ops, { header, cellTable = null }) {
  validateTableOps(ops);
  const m = parseTable(xml);
  m.cells.forEach((c, i) => { c.orig = i; });   // 되돌릴 때 글을 옮겨 올 원래 칸(새 칸·합친 칸은 없앤다)
  let colW = lengths(m.cells, m.cols, 'col', 'colSpan', 'width');
  let rowH = lengths(m.cells, m.rows, 'row', 'rowSpan', 'height');
  const total0 = colW.reduce((s, v) => s + v, 0);
  let geometry = false; let tblOpen = m.open; let head = m.head;
  const done = [];
  const retexted = new Map(); const stamps = []; const cellMoves = [];   // 칸 문단 다시 짜기를 한 칸 → 결과
  ops.forEach((o, i) => {
    const name = `${i + 1}번째(${o.op})`;
    if (o.op === 'cell_paragraphs') {
      const nm = `칸(${o.row}, ${o.col})`;
      if (!isInt(o.row) || !isInt(o.col) || o.row >= m.rows || o.col >= m.cols) fail('TABLE_RANGE', `${nm}: 표 밖입니다(표 ${m.rows}행×${m.cols}열, 0부터)`);
      const c = gridOf(m)[o.row][o.col];
      if (!c) fail('TABLE_RANGE', `${nm}: 그 자리에 칸이 없습니다`);
      if (retexted.has(c)) fail('TABLE_SPEC', `${nm}: 같은 칸의 문단을 한 번에 두 번 다시 짤 수 없습니다`);
      const res = rebuildCell(c, o, nm, { cellTable, inMargin: (/<hp:inMargin\b[^>]*\/>/.exec(m.head) || [null])[0] });
      retexted.set(c, res); stamps[i] = res.expect; cellMoves.push({ row: o.row, col: o.col, map: res.map, count: res.count });
      done.push(res.label);
      return;
    }
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
  // [hwpx-cowork] 칸 문단을 다시 짠 칸은 origins 에서 뺀다(그 칸은 고치기 전 글로 되돌린다) — 대신 고친 뒤의 칸 글 지문(cells)을 남겨, 그새 그 칸이 다시 바뀌었으면
  // 되돌리지 않는다(restoreTableXml — 고친 글을 버리지 않게)
  const origins = m.cells.filter((c) => c.orig != null && !retexted.has(c)).map((c) => [c.row, c.col, c.orig]);
  const cells = [...retexted.keys()].filter((c) => m.cells.includes(c)).map((c) => [c.row, c.col, cellSignature(c)]);
  return { xml: out, rows: m.rows, cols: m.cols, labels: done, geometry, undo: { skeleton: tableSkeletonHash(out), origins, ...(cells.length ? { cells } : {}) },
    ...(retexted.size ? { relayout: true, stamps, ...(ops.every((o) => CELL_OPS.includes(o.op)) ? { cellMoves } : {}) } : {}) };
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
  // [hwpx-cowork] 칸 문단을 다시 짠 칸(undo.cells)은 고치기 전 글로 되돌린다 — 그새 그 칸의 글·모양이 다시 바뀌었으면 되돌리지 않는다(뒤에 고친 글을 버리지 않는다)
  for (const [r, c, sig] of undo.cells || []) {
    const now = at.get(`${r},${c}`);
    if (!now || cellSignature(now) !== sig) fail('STALE', '표 칸의 문단을 고친 뒤 그 칸이 다시 바뀌어 되돌릴 수 없습니다');
  }
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
