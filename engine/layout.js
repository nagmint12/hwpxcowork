// 떠 있는 개체의 배치 읽기(2026-11-16, docs/MCP_REDESIGN_2026-11-16.md §4) — 읽기 전용 분석.
// PDF 를 옮긴 문서처럼 글이 본문 흐름이 아니라 쪽 좌표에 놓인 글상자 조각으로, 표 선이 가는 사각형·선으로 그려진 문단을
// 좌표로 다시 읽는다: 괘선 → 표 격자(합친 칸까지), 격자 밖 글상자 → 줄, 쪽 번호 후보, 쪽을 넘어 이어지는 표.
// 문서를 바꾸지 않는다(바꾸는 쪽은 engine/flow.js). 좌표 단위는 HWPUNIT(1/7200 인치, 1mm ≈ 283.46).
import { Section, anchorTag } from './section.js';
import { SHAPE_TAGS } from './shapes.js';

/** 괘선으로 보는 굵기 한도(≈0.7mm)와 최소 길이(≈3.5mm) */
const THIN = 200;
const RULE_MIN = 1000;
/** 같은 선·같은 자리로 보는 좌표 차(≈0.5mm) */
const TOL = 140;
const MM = 7200 / 25.4;
/** 표 하나의 줄 수 한도(engine/doc.js insertTableAfter 와 같다) — 넘으면 쪽을 잇지 않고 새 표로 */
const MAX_TABLE_ROWS = 1000;

const num = (s) => (s == null ? null : Number(s));
const lastTag = (xml, name) => { const i = xml.lastIndexOf(`<${name}`); return i < 0 ? '' : xml.slice(i, xml.indexOf('>', i) + 1); };
const tagAttr = (tag, k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(tag) || [])[1] ?? null;

/** 구역의 용지 크기(가로 방향이면 뒤집어서) → { w, h } | null */
export function sectionPaper(sec) {
  const m = /<hp:pagePr\b[^>]*>/.exec(sec.xml);
  if (!m) return null;
  let w = num(tagAttr(m[0], 'width')); let h = num(tagAttr(m[0], 'height'));
  if (!(w > 0 && h > 0)) return null;
  // 한/글은 세로 용지를 landscape="WIDELY" 로 쓴다. NARROWLY(가로)는 긴 변이 폭(engine/table.js sectionTextWidth 와 같은 규칙)
  if (tagAttr(m[0], 'landscape') === 'NARROWLY') [w, h] = [Math.max(w, h), Math.min(w, h)];
  return { w, h };
}

/**
 * 본문 문단(ref)이 직접 가진 개체를 좌표가 있는 조각으로 읽는다.
 * → { ref, sec, paper, items: [{ start, end, tag, kind, x, y, w, h, text, refs, fill }], inline(글자처럼 놓인 개체 수), other(읽지 못한 개체 수) }
 *   kind: 'text'(글이 든 글상자) · 'hrule'·'vrule'(가는 선 — 표 괘선 후보) · 'fill'(글 없는 면) · 'figure'(그림) · 'table' · 'complex'(안에 표·개체가 든 글상자·묶음)
 *   좌표는 문단의 개체 가운데 가장 많은 기준(vertRelTo/horzRelTo — 보통 PAPER)의 것만 쓴다. 다른 기준·회전한 개체는 other 로 센다.
 */
export function hostItems(doc, ref) {
  const { sec, p } = doc.resolve(ref);
  const anchors = doc._ownObjectAnchors(p);
  const kids = p.children.filter((c) => c.container !== 'hp:fieldBegin' && !c.hidden);
  const raw = []; let inline = 0;
  let ki = 0;
  for (const a of anchors) {
    const tag = anchorTag(a); const xml = sec.xml.slice(a.start, a.end);
    const pos = lastTag(xml, 'hp:pos'); const sz = lastTag(xml, 'hp:sz');
    const own = [];
    while (ki < kids.length && kids[ki].start < a.start) ki++;
    while (ki < kids.length && kids[ki].end <= a.end) own.push(kids[ki++]);
    if (!pos || !sz) { raw.push({ a, tag, frame: null }); continue; }
    if (tagAttr(pos, 'treatAsChar') === '1') { inline++; continue; }
    const rot = /<hp:rotationInfo\b[^>]*\sangle="(-?\d+)"/.exec(xml);
    const frame = `${tagAttr(pos, 'vertRelTo')}/${tagAttr(pos, 'horzRelTo')}/${tagAttr(pos, 'vertAlign')}/${tagAttr(pos, 'horzAlign')}`;
    const item = { start: a.start, end: a.end, tag, frame: rot && Number(rot[1]) % 360 !== 0 ? null : frame,
      x: num(tagAttr(pos, 'horzOffset')) || 0, y: num(tagAttr(pos, 'vertOffset')) || 0, w: num(tagAttr(sz, 'width')) || 0, h: num(tagAttr(sz, 'height')) || 0 };
    if (a.name === 'hp:tbl') item.kind = 'table';
    else if (a.name === 'hp:pic') item.kind = 'figure';
    else if (!SHAPE_TAGS.has(tag) || tag === 'hp:chart') item.kind = 'other';
    else if (own.length) {
      // 글상자: 안 문단이 글만 가지면 text, 표·그림·글상자를 품으면 complex(옮기지 않는다)
      const plain = own.every((c) => !c.children.some((g) => g.container !== 'hp:fieldBegin') && !c.anchors.some((x) => Section.isObject(x)));
      item.text = own.map((c) => Section.text(c, 'final')).join('\n');
      item.refs = own.map((c) => c.ref);
      item.kind = plain && tag !== 'hp:container' ? (item.text.trim() ? 'text' : 'empty') : 'complex';
    } else if (tag === 'hp:container') item.kind = 'complex';
    else {
      const face = /<hc:winBrush\b[^>]*\sfaceColor="([^"]*)"/.exec(xml);
      item.fill = face && !/^none$/i.test(face[1]) ? face[1].toUpperCase() : null;
      const thinW = item.w <= THIN; const thinH = item.h <= THIN;
      if (thinH && !thinW && item.w >= RULE_MIN) item.kind = 'hrule';
      else if (thinW && !thinH && item.h >= RULE_MIN) item.kind = 'vrule';
      else item.kind = thinW && thinH ? 'dot' : 'fill';
    }
    raw.push({ a, tag, frame: item.frame, item });
  }
  // 가장 많은 좌표 기준만 분석한다
  const tally = new Map();
  for (const r of raw) if (r.frame) tally.set(r.frame, (tally.get(r.frame) || 0) + 1);
  const main = [...tally].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const items = raw.filter((r) => r.item && r.frame === main).map((r) => r.item);
  return { ref, sec: sec.index, paper: sectionPaper(sec), frame: main, items, inline, other: raw.length - items.length };
}

/** 가까운 값끼리 묶어 대표값(평균) 목록으로 */
function cluster(values, tol = TOL) {
  const v = [...values].sort((a, b) => a - b); const out = [];
  for (const x of v) {
    const last = out[out.length - 1];
    if (last && x - last.max <= tol) { last.sum += x; last.n++; last.max = x; } else out.push({ sum: x, n: 1, max: x });
  }
  return out.map((c) => c.sum / c.n);
}

/**
 * 한 줄 안 조각을 왼쪽부터 이어 붙인다. spaced(조각이 낱말 뒤 빈칸을 품은 문서 — PDF 변환기가 낱말마다 뒤 빈칸까지 한 조각으로 낸다)면
 * 조각의 빈칸만 믿고(틈이 글자 높이를 넘을 때만 빈칸 하나), 아니면 앞뒤에 빈칸이 없고 틈이 글자 높이의 1/4 을 넘을 때 빈칸 하나를 넣는다.
 * → { text(앞뒤 빈칸 뗀 글), open(마지막 조각이 빈칸 없이 끝남 — 다음 줄로 낱말이 이어질 수 있다) }
 */
function joinFragments(list, spaced) {
  const row = [...list].sort((a, b) => a.x - b.x);
  let out = '';
  for (let i = 0; i < row.length; i++) {
    const t = row[i].text.replace(/\s*\n\s*/g, ' ');
    if (i > 0) {
      const prev = row[i - 1]; const gap = row[i].x - (prev.x + prev.w); const h = Math.min(prev.h, row[i].h);
      if (!/\s$/.test(out) && !/^\s/.test(t) && gap > h * (spaced ? 1 : 0.25)) out += ' ';
    }
    out += t;
  }
  return { text: out.replace(/[ \t]+/g, ' ').trim(), open: out !== '' && !/\s$/.test(out) };
}

/** 조각들을 세로 가운데가 겹치는 것끼리 줄로 묶는다 → [{ y(가운데), top, bottom, x, right, h, items, text, open }] (위에서 아래로) */
export function toLines(items, spaced = false) {
  const list = items.map((s) => ({ ...s, cy: s.y + s.h / 2 })).sort((a, b) => a.cy - b.cy || a.x - b.x);
  const lines = [];
  for (const it of list) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.cy - last.y) <= Math.max(120, Math.min(last.h, it.h) * 0.5)) {
      last.items.push(it); last.y = (last.y * (last.items.length - 1) + it.cy) / last.items.length;
      last.top = Math.min(last.top, it.y); last.bottom = Math.max(last.bottom, it.y + it.h); last.h = Math.max(last.h, it.h);
    } else lines.push({ y: it.cy, top: it.y, bottom: it.y + it.h, h: it.h, items: [it] });
  }
  for (const ln of lines) {
    ln.x = Math.min(...ln.items.map((i) => i.x)); ln.right = Math.max(...ln.items.map((i) => i.x + i.w));
    Object.assign(ln, joinFragments(ln.items, spaced));
  }
  return lines;
}

/**
 * 이어지는 두 글을 붙인다: spaced 문서에서 앞 글이 빈칸 없이 끝났으면(open — 낱말 가운데서 줄·쪽이 바뀜) 그대로, 아니면 빈칸 하나.
 * 앞 글이 문장 부호(. ! ? , ; : …)로 끝나면 낱말이 이어질 수 없으므로 빈칸을 둔다(변환기가 줄 끝 빈칸을 내지 않은 경우)
 */
const glue = (a, b, open, spaced) => (!a ? b : !b ? a : `${a}${spaced && open && !/[.!?。…,;:]["'”’)\]]?$/.test(a) ? '' : ' '}${b}`);

/** 칸 안 조각 → { text, open }: 줄로 묶어 줄마다 이어 붙이고 줄 사이는 glue(칸 안 줄바꿈은 자동 줄바꿈으로 본다) */
function cellText(items, spaced) {
  let text = ''; let open = false;
  for (const l of toLines(items, spaced)) { if (!l.text) continue; text = glue(text, l.text, open, spaced); open = l.open; }
  return { text, open };
}

/** 괘선을 서로 닿는 것끼리 묶는다(쪽에 표가 여럿일 때) → [[rule…]] */
function ruleGroups(rules) {
  const parent = rules.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const box = rules.map((r) => ({ x0: r.x - TOL, y0: r.y - TOL, x1: r.x + r.w + TOL, y1: r.y + r.h + TOL }));
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    if (box[i].x0 <= box[j].x1 && box[j].x0 <= box[i].x1 && box[i].y0 <= box[j].y1 && box[j].y0 <= box[i].y1) parent[find(i)] = find(j);
  }
  const groups = new Map();
  rules.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()];
}

/**
 * 괘선 묶음 하나 → 격자 | null(가로·세로 선이 둘씩 안 되면 격자가 아니다).
 * 격자: { x0, y0, x1, y1, xs(세로 경계), ys(가로 경계), rows, cols, cells: [{ r, c, rs, cs }] } — 선이 지나지 않는 경계는 칸을 합친다(네모꼴일 때만).
 */
function gridOf(rules) {
  const H = rules.filter((r) => r.kind === 'hrule').map((r) => ({ pos: r.y + r.h / 2, a: r.x, b: r.x + r.w }));
  const V = rules.filter((r) => r.kind === 'vrule').map((r) => ({ pos: r.x + r.w / 2, a: r.y, b: r.y + r.h }));
  const xs = cluster(V.map((r) => r.pos)); const ys = cluster(H.map((r) => r.pos));
  if (xs.length < 2 || ys.length < 2) return null;
  const rows = ys.length - 1; const cols = xs.length - 1;
  // 경계 조각에 선이 지나는가(조각 길이의 60% 넘게 덮음)
  const covers = (list, pos, a, b) => {
    let cov = 0; const len = b - a;
    for (const r of list) if (Math.abs(r.pos - pos) <= TOL) cov += Math.max(0, Math.min(b, r.b) - Math.max(a, r.a));
    return cov >= len * 0.6;
  };
  const id = (r, c) => r * cols + c;
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (r + 1 < rows && !covers(H, ys[r + 1], xs[c], xs[c + 1])) parent[find(id(r, c))] = find(id(r + 1, c));
    if (c + 1 < cols && !covers(V, xs[c + 1], ys[r], ys[r + 1])) parent[find(id(r, c))] = find(id(r, c + 1));
  }
  const sets = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = find(id(r, c)); if (!sets.has(k)) sets.set(k, []); sets.get(k).push([r, c]); }
  const cells = [];
  for (const list of sets.values()) {
    const r0 = Math.min(...list.map((x) => x[0])); const r1 = Math.max(...list.map((x) => x[0]));
    const c0 = Math.min(...list.map((x) => x[1])); const c1 = Math.max(...list.map((x) => x[1]));
    // 네모꼴이 아닌 묶음(선이 군데군데 빠진 그림)은 합치지 않고 칸마다 둔다
    if ((r1 - r0 + 1) * (c1 - c0 + 1) === list.length) cells.push({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    else for (const [r, c] of list) cells.push({ r, c, rs: 1, cs: 1 });
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  return { x0: xs[0], x1: xs[cols], y0: ys[0], y1: ys[rows], xs, ys, rows, cols, cells };
}

const PAGE_NO = /^[-–—·\s]*(?:p\.?\s*|쪽\s*)?(\d{1,4})(?:\s*[/／]\s*\d{1,4})?\s*(?:쪽|페이지)?[-–—·\s]*$/i;
/** 본문으로 옮길 수 있는 개체 종류(hostItems 의 kind): 글상자(글 있음·빈 것)·괘선·면·점. 그림·표·차트·안에 개체가 든 글상자·회전한 도형은 남긴다 */
const MOVABLE = new Set(['text', 'empty', 'hrule', 'vrule', 'fill', 'dot']);

/**
 * 본문 문단 하나의 배치 읽기.
 * → { ref, sec, paper, counts: { text, rule, fill, figure, table, complex, other, inline }, chars(글상자 글자 수),
 *     blocks: [ { type: 'lines', top, lines: [{ text, top, bottom, x, right, h, role? }] }
 *             | { type: 'grid', top, bottom, x0, x1, rows, cols, xs, cells: [{ r, c, rs, cs, text }], headerRows } ] (위에서 아래로),
 *     used: Set(옮길 수 있는 개체의 시작 위치 — 글상자·괘선·면), kept(남길 개체 수 — 그림·표·복합 글상자 등) }
 */
export function analyzeHost(doc, ref) {
  const host = hostItems(doc, ref);
  const { items } = host;
  const texts = items.filter((i) => i.kind === 'text');
  const rules = items.filter((i) => i.kind === 'hrule' || i.kind === 'vrule');
  const fills = items.filter((i) => i.kind === 'fill' && i.fill && i.fill !== '#FFFFFF');
  const grids = ruleGroups(rules).map(gridOf).filter(Boolean).sort((a, b) => a.y0 - b.y0);
  // 조각이 낱말 뒤 빈칸을 품는 문서인가(다섯에 하나 넘게 빈칸으로 끝남) — 줄·쪽이 바뀌는 자리에서 낱말이 이어지는지를 그 빈칸으로 가린다
  const spaced = texts.length >= 4 && texts.filter((t) => /\s$/.test(t.text)).length >= texts.length * 0.2;
  // 글상자를 격자 칸에 넣는다(가운데 점 기준). 어느 격자에도 들지 않으면 자유 조각
  const free = [];
  for (const g of grids) g.bucket = new Map();
  for (const t of texts) {
    const cx = t.x + t.w / 2; const cy = t.y + t.h / 2;
    const g = grids.find((q) => cx >= q.x0 - TOL && cx <= q.x1 + TOL && cy >= q.y0 - TOL && cy <= q.y1 + TOL);
    if (!g) { free.push(t); continue; }
    let c = g.xs.findIndex((x, i) => i < g.cols && cx < g.xs[i + 1]); if (c < 0) c = g.cols - 1;
    let r = g.ys.findIndex((y, i) => i < g.rows && cy < g.ys[i + 1]); if (r < 0) r = g.rows - 1;
    const cell = g.cells.find((q) => r >= q.r && r < q.r + q.rs && c >= q.c && c < q.c + q.cs);
    if (!g.bucket.has(cell)) g.bucket.set(cell, []);
    g.bucket.get(cell).push(t);
  }
  const blocks = [];
  for (const g of grids) {
    for (const cell of g.cells) Object.assign(cell, cellText(g.bucket.get(cell) || [], spaced));
    // 머리행: 맨 위부터 면(배경색 도형)이 줄 넓이의 절반 넘게 덮은 줄 수
    let headerRows = 0;
    for (let r = 0; r < g.rows; r++) {
      const y0 = g.ys[r]; const y1 = g.ys[r + 1]; let cov = 0;
      for (const f of fills) cov += Math.max(0, Math.min(g.x1, f.x + f.w) - Math.max(g.x0, f.x)) * Math.max(0, Math.min(y1, f.y + f.h) - Math.max(y0, f.y));
      if (cov >= (g.x1 - g.x0) * (y1 - y0) * 0.5) headerRows++; else break;
    }
    blocks.push({ type: 'grid', top: g.y0, bottom: g.y1, x0: g.x0, x1: g.x1, rows: g.rows, cols: g.cols, xs: g.xs,
      cells: g.cells.map(({ r, c, rs, cs, text, open }) => ({ r, c, rs, cs, text, open })), headerRows, spaced });
  }
  const paper = host.paper;
  for (const ln of toLines(free, spaced)) {
    const line = { text: ln.text, top: ln.top, bottom: ln.bottom, x: ln.x, right: ln.right, h: ln.h };
    // 쪽 번호 후보: 쪽 위·아래 12% 안의 숫자뿐인 줄
    if (paper && PAGE_NO.test(ln.text) && (ln.bottom <= paper.h * 0.12 || ln.top >= paper.h * 0.88)) line.role = 'page_number';
    blocks.push({ type: 'line', top: ln.top, line });
  }
  blocks.sort((a, b) => a.top - b.top);
  // 잇닿은 줄은 한 덩이로
  const merged = [];
  for (const b of blocks) {
    if (b.type === 'grid') { merged.push(b); continue; }
    const last = merged[merged.length - 1];
    if (last && last.type === 'lines') last.lines.push(b.line); else merged.push({ type: 'lines', top: b.top, lines: [b.line] });
  }
  const count = (k) => items.filter((i) => i.kind === k).length;
  const used = new Set(items.filter((i) => MOVABLE.has(i.kind)).map((i) => i.start));
  // 글을 옮길 조각의 좌우 끝(여백 추정용) — 쪽 폭을 다 차지하는 글상자(가운데 맞춘 쪽 번호 등)는 뺀다
  const span = items.filter((i) => (i.kind === 'text' && (!paper || i.w < paper.w * 0.9)) || i.kind === 'vrule' || i.kind === 'hrule');
  return { ref, sec: host.sec, paper, frame: host.frame, spaced,
    counts: { text: count('text') + count('empty'), rule: rules.length, fill: count('fill') + count('dot'), figure: count('figure'), table: count('table'), complex: count('complex'), other: host.other, inline: host.inline },
    chars: texts.reduce((s, t) => s + [...t.text].length, 0), blocks: merged, used, kept: anchorsKept(items, used) + host.other + host.inline,
    bounds: span.length ? { left: Math.min(...span.map((i) => i.x)), right: Math.max(...span.map((i) => i.x + i.w)) } : null };
}
function anchorsKept(items, used) { return items.filter((i) => !used.has(i.start)).length; }

/** 개체 배치 지문: 대상 문단들의 개체(종류·자리·크기·글) — 제안한 뒤 개체가 바뀌었는지 볼 때(메모·문단 글 서식은 보지 않는다) */
export function layoutFingerprint(doc, refs = null) {
  return JSON.stringify(layoutHosts(doc, refs).map((ref) => [ref, hostItems(doc, ref).items.map((i) => [i.tag, i.kind, i.x, i.y, i.w, i.h, i.text || ''])]));
}

/** 개체 → 본문이 실제로 옮길 것이 있는 본문 문단 ref 목록(옮길 수 있는 글상자·괘선·면을 하나라도 가진 문단) — refs 를 주면 그 가운데서 */
export function convertibleHosts(doc, refs = null) {
  return layoutHosts(doc, refs).filter((ref) => hostItems(doc, ref).items.some((i) => MOVABLE.has(i.kind)));
}

/** 떠 있는 글상자·선을 가진 본문 문단 ref 목록(문서 차례) — refs 를 주면 그 가운데서 */
export function layoutHosts(doc, refs = null) {
  const out = [];
  const want = refs ? new Set(refs) : null;
  for (const sec of doc.sections) for (const p of sec.bodyParas) {
    if (want && !want.has(p.ref)) continue;
    if (doc._ownObjectAnchors(p).some((a) => SHAPE_TAGS.has(anchorTag(a)) && anchorTag(a) !== 'hp:chart')) out.push(p.ref);
  }
  return out;
}

const sameCols = (a, b) => a.cols === b.cols && a.xs.every((x, i) => Math.abs((x - a.xs[0]) - (b.xs[i] - b.xs[0])) <= Math.max(TOL * 2, (a.x1 - a.x0) * 0.02));
const rowTexts = (cells, cols, r) => Array.from({ length: cols }, (_, c) => cells.find((q) => q.r === r && q.c === c)?.text ?? null);

/**
 * 문서(또는 refs 문단들)의 배치 읽기 + 쪽을 넘어 이어지는 표 잇기.
 * → { hosts: [analyzeHost 결과 + pageNumbers], tables: [{ host(첫 문단 ref), hosts: [ref…], rows, cols, headerRows, grid(rows×cols 글), merges: [{ r, c, rs, cs }], widths(칸 너비 비율) }],
 *     flow: [{ host, items: [{ type: 'para', text } | { type: 'table', table(tables 의 번호) }] }](문단마다 그 뒤에 넣을 것), dropped: [{ host, text, why }] }
 * opts: joinPages(기본 true — 열 구조가 같은 다음 쪽 표를 잇는다), keepPageNumbers(기본 false), drop(Set — 'ref:L3' 꼴로 버릴 줄), headerRows(첫 표 머리행 수 — 기본 자동)
 */
export function analyzeLayout(doc, { refs = null, joinPages = true, keepPageNumbers = false, drop = null, headerRows = null, wrap = 'auto' } = {}) {
  const hosts = layoutHosts(doc, refs).map((ref) => analyzeHost(doc, ref));
  // 쪽 번호: 후보가 한 쪽뿐이거나 여러 쪽에서 번호가 늘어날 때만 쪽 번호로 본다(본문에 놓인 숫자 한 줄을 지우지 않게)
  const cand = hosts.map((h) => h.blocks.flatMap((b) => (b.type === 'lines' ? b.lines.filter((l) => l.role === 'page_number') : [])));
  const nums = cand.map((list) => (list.length ? Number(PAGE_NO.exec(list[list.length - 1].text)[1]) : null));
  const withNum = nums.filter((n) => n != null);
  const rising = withNum.length >= 2 && withNum.every((n, i) => i === 0 || n > withNum[i - 1]);
  if (!(rising || (hosts.length === 1 && withNum.length === 1))) for (const list of cand) for (const l of list) delete l.role;

  const tables = []; const flow = []; const dropped = [];
  let open = null;   // 이어 붙일 수 있는 마지막 표 { table, block(마지막 격자), host }
  const dropSet = drop instanceof Set ? drop : new Set(drop || []);
  hosts.forEach((h) => {
    const items = []; let lineNo = 0; let sawContent = false;
    for (const b of h.blocks) {
      if (b.type === 'lines') {
        const kept = [];
        for (const l of b.lines) {
          lineNo++; l.id = `L${lineNo}`;
          if (l.role === 'page_number' && !keepPageNumbers) { dropped.push({ host: h.ref, text: l.text, why: '쪽 번호' }); continue; }
          if (dropSet.has(`${h.ref}:${l.id}`)) { dropped.push({ host: h.ref, text: l.text, why: '지정' }); continue; }
          kept.push(l);
        }
        if (!kept.length) continue;
        for (const text of paragraphsOf(kept, wrap)) items.push({ type: 'para', text });
        sawContent = true; open = null;
        continue;
      }
      // 격자: 이 문단의 첫 내용이고 앞 쪽 표와 열 구조가 같으면 잇는다
      if (joinPages && open && !sawContent && sameCols(open.block, b) && open.table.rows + b.rows <= MAX_TABLE_ROWS) {
        appendGrid(open.table, b);
        open.table.hosts.push(h.ref); open.block = b; sawContent = true;
        continue;
      }
      const t = newTable(h.ref, b, headerRows);
      tables.push(t); items.push({ type: 'table', table: tables.length - 1 });
      open = { table: t, block: b }; sawContent = true;
    }
    flow.push({ host: h.ref, items });
  });
  for (const t of tables) finishTable(t);
  return { hosts, tables, flow, dropped };
}

/** 줄 목록 → 문단 글 목록. wrap 'auto': 앞줄이 덩이 오른쪽 끝까지 차고 다음 줄이 같은 왼쪽에서 바로 이어지면 한 문단으로 잇는다. 'keep': 줄마다 문단 */
function paragraphsOf(lines, wrap) {
  if (wrap === 'keep' || lines.length < 2) return lines.map((l) => l.text).filter(Boolean);
  const right = Math.max(...lines.map((l) => l.right)); const out = [];
  let cur = null;
  for (const l of lines) {
    if (!l.text) continue;
    const prev = cur?.last;
    const cont = prev && prev.right >= right - prev.h * 1.5 && (l.top - prev.bottom) <= prev.h * 0.9 && Math.abs(l.h - prev.h) <= prev.h * 0.2
      && l.x <= prev.x + prev.h * 0.5 && !/^(?:[-•·∙◦○●■□▶※*]|\d+[.)]|[가-힣][.)]|\(\d+\)|제\s*\d+)/.test(l.text) && !/[.!?。]["'”’)]?$/.test(prev.text);
    if (cont) { cur.text += ` ${l.text}`; cur.last = l; } else { cur = { text: l.text, last: l }; out.push(cur); }
  }
  return out.map((x) => x.text);
}

function newTable(host, b, headerRows) {
  return { host, hosts: [host], cols: b.cols, headerRows: headerRows ?? b.headerRows, xs: b.xs, cells: b.cells.map((c) => ({ ...c })), rows: b.rows, spaced: !!b.spaced };
}

/** 다른 줄에서는 늘 글이 있는 열(합치지 않은 칸이 5줄 넘고 98% 넘게 참) — 쪽 경계에서 끊긴 줄을 알아볼 때 쓴다 */
function alwaysFilled(t, cells, cols) {
  const seen = Array.from({ length: cols }, () => [0, 0]);
  const add = (list, from) => { for (const c of list) if (c.r >= from && c.rs === 1 && c.cs === 1) { seen[c.c][0]++; if (c.text) seen[c.c][1]++; } };
  add(t.cells, t.headerRows || 0); add(cells, 1);
  return new Set(seen.map(([n, f], c) => (n >= 5 && f >= n * 0.98 ? c : -1)).filter((c) => c >= 0));
}

/**
 * 앞 표(t) 아래에 다음 쪽 격자 b 를 잇는다.
 *  - 다음 쪽이 같은 머리행으로 시작하면(반복 머리행) 그 줄은 넣지 않는다
 *  - 쪽 경계에서 끊긴 줄: 다음 쪽 첫 줄에서 '늘 차 있는 열'이 비어 있으면 앞 쪽 마지막 줄의 나머지다 — 글을 그 줄 칸에 잇고 줄은 넣지 않는다
 *  - 쪽 경계에서 끊긴 세로 합침: 맨 위 칸과 앞 쪽 맨 아래 칸이 같은 열·같은 폭이고, 둘 중 하나가 여러 줄을 합친 칸이며 글이 한쪽에만 있으면 한 칸
 */
function appendGrid(t, b) {
  let cells = b.cells.map((c) => ({ ...c })); let rows = b.rows;
  // 줄 k 를 뺀다: 그 줄뿐인 칸은 없어지고, 걸친 칸은 한 줄 줄며, 아래 칸은 올라온다
  const dropRow = (k) => {
    cells = cells.filter((c) => !(c.r === k && c.rs === 1)).map((c) => (c.r <= k && k < c.r + c.rs ? { ...c, rs: c.rs - 1 } : c.r > k ? { ...c, r: c.r - 1 } : c));
    rows--;
  };
  const head = Math.max(t.headerRows || 0, 0);
  if (head > 0 && rows > head) {
    let same = true;
    for (let r = 0; r < head && same; r++) if (JSON.stringify(rowTexts(t.cells, t.cols, r)) !== JSON.stringify(rowTexts(cells, t.cols, r))) same = false;
    if (same) for (let r = 0; r < head; r++) dropRow(0);
  }
  if (rows > 0) {
    const first = cells.filter((c) => c.r === 0 && c.rs === 1 && c.cs === 1);
    const always = alwaysFilled(t, cells, t.cols);
    if (first.some((c) => always.has(c.c) && !c.text) && first.some((c) => c.text)) {
      for (const c of first) {
        if (!c.text) continue;
        const above = t.cells.find((q) => q.c === c.c && q.cs === 1 && q.rs === 1 && q.r === t.rows - 1);
        if (!above) continue;
        above.text = glue(above.text, c.text, above.open, t.spaced); above.open = c.open; c.text = '';
      }
      if (first.every((c) => !c.text)) dropRow(0);
    }
  }
  const base = t.rows; const lastRow = t.rows - 1;
  for (const cell of cells) {
    if (cell.r === 0) {
      const above = t.cells.find((q) => q.c === cell.c && q.cs === cell.cs && q.r + q.rs - 1 === lastRow);
      if (above && (above.rs > 1 || cell.rs > 1) && !(above.text && cell.text)) {
        above.rs += cell.rs; if (!above.text) { above.text = cell.text; above.open = cell.open; }
        continue;
      }
    }
    t.cells.push({ ...cell, r: cell.r + base });
  }
  t.rows += rows;
}

/** 표를 넣을 꼴로: grid(rows×cols 글 — 합친 칸은 왼쪽 위에만), merges, widths */
function finishTable(t) {
  const grid = Array.from({ length: t.rows }, () => Array.from({ length: t.cols }, () => ''));
  const merges = [];
  for (const c of t.cells) {
    grid[c.r][c.c] = c.text || '';
    if (c.rs > 1 || c.cs > 1) merges.push({ r: c.r, c: c.c, rs: c.rs, cs: c.cs });
  }
  t.grid = grid; t.merges = merges;
  t.widths = t.xs.slice(1).map((x, i) => Math.max(1, Math.round(x - t.xs[i])));
  t.headerRows = Math.max(0, Math.min(t.rows - 1, t.headerRows || 0));
  delete t.cells; delete t.xs;
}

/** 여백 추정(mm): 옮길 조각의 좌우 끝으로 왼쪽·오른쪽 여백을 잡는다(10~35mm, 못 구하면 30). 위·아래·머리말·꼬리말은 한/글 기본값 */
export function inferMargins(hosts) {
  const lefts = []; const rights = [];
  for (const h of hosts) {
    if (!h.paper || !h.bounds) continue;
    lefts.push(h.bounds.left); rights.push(h.paper.w - h.bounds.right);
  }
  const pick = (list) => {
    if (!list.length) return 30;
    const mm = Math.round(Math.min(...list) / MM);
    return Math.max(10, Math.min(35, mm));
  };
  const side = Math.min(pick(lefts), pick(rights));
  return { left: side, right: side, top: 20, bottom: 15, header: 15, footer: 15, gutter: 0 };
}
