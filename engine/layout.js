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

/**
 * 글 폭 어림(HWPUNIT): 글자 높이에 대한 비율 — 한글·한자·전각 0.9, 빈칸·좁은 문장 부호 0.3, 그 밖(숫자·라틴) 0.55.
 * 글상자 안 줄(lineseg)은 줄의 자리와 쓸 수 있는 폭만 저장하므로, 줄 안 글이 실제로 어디까지 차는지는 이것으로 어림한다.
 */
function textWidth(text, h) {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (/\s/.test(ch)) w += 0.3;
    else if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) w += 0.9;
    else if (/[.,:;'"`|!·]/.test(ch)) w += 0.3;
    else w += 0.55;
  }
  return w * h;
}

/**
 * 글상자 안 글을 줄 조각으로(쪽 좌표) → [{ x, y, w, h, text, box, pk, li, nl }] | null(나누지 않음 — 글상자 하나가 곧 조각 하나).
 * PDF 변환기는 표의 한 열이나 여러 줄 글을 글상자 하나에 문단·줄(lineseg)로 쌓아 둔다(한 문단 안에서 줄 폭을 좁혀 여러 행의 값을 줄마다 놓기도 한다).
 * 글상자째 가운데 점으로 칸을 고르면 한 열이 통째로 한 칸에 들어가므로, 저장된 줄 배치(textpos·vertpos·horzpos·horzsize)로 줄마다 자리를 잡는다.
 *   - 줄 글 = 문단 글자[textpos, 다음 textpos), y = 글상자 위 + 안 여백 + vertpos(세로 맞춤 반영), x = 줄 시작(horzpos) — 가운데·오른쪽 정렬이면 어림 폭으로 옮긴다
 *   - 저장된 줄 배치가 없거나 어긋나면(textpos 가 0 에서 시작해 늘지 않음·글자 수 넘음·vertpos 가 거꾸로·변경 추적 글자) 문단마다 글상자 높이를 나눠 준다
 *   - 한 줄뿐인 글상자는 글상자가 글보다 훨씬 넓을 때만(쪽 폭 글상자에 놓인 제목 등) 어림 자리로 바꾼다 — 글에 꼭 맞는 낱말 글상자는 글상자 자리가 더 정확하다
 * box(글상자 시작 위치)·pk(문단 열쇠)·li(문단 안 줄 번호)·nl(문단 줄 수): 같은 문단의 이어지는 줄은 원문 글 그대로 잇고, 같은 글상자의 다른 문단 사이는 문단을 나눈다.
 */
function boxLines(sec, xml, own, item, alignOf) {
  if (!own.length) return null;
  const marg = lastTag(xml, 'hp:textMargin');
  const ml = num(tagAttr(marg, 'left')) || 0; const mt = num(tagAttr(marg, 'top')) || 0; const mb = num(tagAttr(marg, 'bottom')) || 0;
  const vAlign = tagAttr((/<hp:subList\b[^>]*>/.exec(xml) || [''])[0], 'vertAlign') || 'TOP';
  const paras = []; let valid = true; let lastV = -Infinity;
  for (const c of own) {
    const pxml = sec.xml.slice(c.start, c.end);
    const chars = c.chars.map((x) => x.ch);
    if (c.chars.some((x) => x.ins || x.del)) valid = false;
    const segs = [...pxml.matchAll(/<hp:lineseg\b[^>]*>/g)].map((m) => ({ tp: num(tagAttr(m[0], 'textpos')), vp: num(tagAttr(m[0], 'vertpos')), vs: num(tagAttr(m[0], 'vertsize')),
      th: num(tagAttr(m[0], 'textheight')), hp: num(tagAttr(m[0], 'horzpos')) || 0, hs: num(tagAttr(m[0], 'horzsize')) || 0 }));
    if (!segs.length || segs[0].tp !== 0) valid = false;
    for (let i = 0; valid && i < segs.length; i++) {
      const s = segs[i];
      if (!(s.vp >= lastV) || !(s.vs > 0) || (i > 0 && !(s.tp > segs[i - 1].tp)) || (chars.length && s.tp >= chars.length)) valid = false;
      lastV = s.vp;
    }
    const align = alignOf(/\sparaPrIDRef="([^"]*)"/.exec(pxml.slice(0, 400))?.[1]);
    paras.push({ chars, segs, align, text: Section.text(c, 'final') });
  }
  const parts = [];
  if (valid) {
    const total = Math.max(...paras.flatMap((p) => p.segs.map((s) => s.vp + s.vs)));
    if (total > item.h * 1.5 + 1000) valid = false;   // 글상자보다 터무니없이 긴 줄 배치는 믿지 않는다
    const free = Math.max(0, item.h - mt - mb - total);
    const off = vAlign === 'CENTER' ? free / 2 : vAlign === 'BOTTOM' ? free : 0;
    paras.forEach((p, k) => {
      if (!valid) return;
      const segs = p.segs.filter((s) => !p.chars.length || s.tp < p.chars.length);
      segs.forEach((s, i) => {
        const text = p.chars.slice(s.tp, i + 1 < segs.length ? segs[i + 1].tp : p.chars.length).join('');
        if (!text.trim()) return;
        const h = s.vs; const est = textWidth(text.replace(/\s+$/, ''), s.th || h);
        const avail = s.hs > 0 ? s.hs : Math.max(0, item.w - ml - s.hp);
        const w = (p.align === 'JUSTIFY' || p.align === 'DISTRIBUTE') && i + 1 < segs.length ? avail : Math.min(est, avail || est);
        const dx = p.align === 'CENTER' ? Math.max(0, (avail - w) / 2) : p.align === 'RIGHT' ? Math.max(0, avail - w) : 0;
        parts.push({ x: Math.round(item.x + ml + s.hp + dx), y: Math.round(item.y + mt + off + s.vp), w: Math.round(w), h, text, box: item.start, pk: `${item.start}:${k}`, li: i, nl: segs.length });
      });
    });
  }
  if (!valid) {
    // 줄 배치를 믿을 수 없다: 문단이 여럿일 때만 글상자 높이를 문단 수로 나눠 문단마다 한 조각
    if (own.length < 2) return null;
    parts.length = 0;
    const step = item.h / own.length;
    paras.forEach((p, k) => { if (p.text.trim()) parts.push({ x: item.x, y: Math.round(item.y + k * step), w: item.w, h: Math.round(step), text: p.text, box: item.start, pk: `${item.start}:${k}`, li: 0, nl: 1 }); });
    return parts.length ? parts : null;
  }
  if (!parts.length) return null;
  if (parts.length === 1) {
    // 한 줄뿐: 글상자가 글보다 훨씬 넓을 때만 어림 자리로
    const p = parts[0];
    if (!(item.w - p.w > p.h * 2 && p.w < item.w * 0.6)) return null;
  }
  return parts;
}

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
 *   parts(text 일 때만, 있으면): 글상자 안 글을 저장된 줄 배치로 나눈 줄 조각(boxLines) — 여러 문단·여러 줄 글상자, 글보다 훨씬 넓은 글상자.
 *   lines=false 면 줄 조각을 만들지 않는다(개체 지문·대상 고르기처럼 글상자 자체만 볼 때)
 */
export function hostItems(doc, ref, { lines = true } = {}) {
  const { sec, p } = doc.resolve(ref);
  const anchors = doc._ownObjectAnchors(p);
  const kids = p.children.filter((c) => c.container !== 'hp:fieldBegin' && !c.hidden);
  const raw = []; let inline = 0;
  let ki = 0;
  const aligns = new Map();
  const alignOf = (id) => {
    if (id == null) return 'JUSTIFY';
    if (!aligns.has(id)) aligns.set(id, (/<hh:align\b[^>]*\shorizontal="(\w+)"/.exec(doc.header?.block?.('paraPr', id) || '') || [])[1] || 'JUSTIFY');
    return aligns.get(id);
  };
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
      if (lines && item.kind === 'text') { const parts = boxLines(sec, xml, own, item, alignOf); if (parts) item.parts = parts; }
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
      // 숫자 낱말끼리는 낱말 뒤 빈칸이 없어도 틈이 있으면 띄운다(값 둘이 한 값으로 붙지 않게)
      const nums = numeric(lastWord(out)) && numeric(firstWord(t));
      if (!/\s$/.test(out) && !/^\s/.test(t) && gap > h * (spaced && !nums ? 1 : 0.25)) out += ' ';
    }
    out += t;
  }
  return { text: out.replace(/[ \t]+/g, ' ').trim(), open: out !== '' && !/\s$/.test(out) };
}

/**
 * 조각들을 세로 가운데가 겹치는 것끼리 줄로 묶는다 → [{ y(가운데), top, bottom, x, right, h, items, text, open, head, tail, starts, wide }] (위에서 아래로)
 * head·tail: 줄의 맨 왼쪽·오른쪽 조각(같은 글상자 문단의 이어지는 줄인지 볼 때), starts: 조각 시작 x(내어쓰기 자리), wide: 쪽 폭 글상자(글 자리를 모름)가 든 줄
 */
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
    const row = [...ln.items].sort((a, b) => a.x - b.x);
    ln.x = row[0].x; ln.right = Math.max(...row.map((i) => i.x + i.w));
    ln.head = row[0]; ln.tail = row[row.length - 1]; ln.starts = row.map((i) => i.x); ln.wide = row.some((i) => i.wide);
    Object.assign(ln, joinFragments(ln.items, spaced));
  }
  return lines;
}

const lastWord = (s) => { const m = /(\S+)\s*$/.exec(s); return m ? m[1] : ''; };
const firstWord = (s) => { const m = /^\s*(\S+)/.exec(s); return m ? m[1] : ''; };
/** 숫자 값 낱말(3.81 · 1,234 · 12% · -0.5 · 빈 값 표시 '-') */
const numeric = (w) => /^[-+]?(?:\d[\d,]*(?:\.\d+)?%?|[-–—])$/.test(w);

/**
 * 이어지는 두 글을 붙인다: spaced 문서에서 앞 글이 빈칸 없이 끝났으면(open — 낱말 가운데서 줄·쪽이 바뀜) 그대로, 아니면 빈칸 하나.
 * 앞 글이 문장 부호(. ! ? , ; : …)로 끝나면 낱말이 이어질 수 없으므로 빈칸을 둔다(변환기가 줄 끝 빈칸을 내지 않은 경우).
 * 숫자 값 낱말끼리('2.59' + '2.75')도 빈칸을 둔다 — 숫자는 낱말 가운데서 줄을 바꾸지 않으므로 서로 다른 값이다
 */
const glue = (a, b, open, spaced) => (!a ? b : !b ? a
  : `${a}${spaced && open && !/[.!?。…,;:]["'”’)\]]?$/.test(a) && !(numeric(lastWord(a)) && numeric(firstWord(b))) ? '' : ' '}${b}`);

/**
 * 앞 줄 → 다음 줄이 같은 글상자에서 왔으면 어떻게 이을지: 같은 문단의 바로 다음 줄이면 원문 그대로(앞 줄이 빈칸으로 끝났으면 빈칸 하나, 아니면 붙여서),
 * 같은 글상자의 다른 문단이면 null(문단 경계), 다른 글상자면 undefined(좌표 규칙으로 정한다)
 */
function sameBoxJoin(prev, l) {
  const a = prev.tail; const b = l.head;
  if (a?.box == null || a.box !== b?.box) return undefined;
  return a.pk === b.pk && b.li === a.li + 1 ? (prev.open ? '' : ' ') : null;
}

/** 칸 안 조각 → { text, open }: 줄로 묶어 줄마다 이어 붙인다 — 같은 글상자 문단의 줄은 원문대로, 같은 글상자의 다른 문단은 빈칸, 그 밖은 glue(자동 줄바꿈으로 본다) */
function cellText(items, spaced) {
  let text = ''; let open = false; let prev = null;
  for (const l of toLines(items, spaced)) {
    if (!l.text) continue;
    const same = prev ? sameBoxJoin(prev, l) : undefined;
    text = same === undefined ? glue(text, l.text, open, spaced) : !text ? l.text : `${text}${same ?? ' '}${l.text}`;
    open = l.open; prev = l;
  }
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
 * 괘선 묶음 하나 → 격자 | null(가로선 둘·세로선 하나가 안 되거나, 바깥 열 경계를 더해도 열이 하나도 안 되면 격자가 아니다).
 * frags: 글 조각 — 바깥 열 경계(가로선 끝)를 더할지와 가로선 없는 행을 나눌지(rowBands)를 그 자리로 정한다.
 * 격자: { x0, y0, x1, y1, xs(세로 경계), ys(가로 경계), rows, cols, cells: [{ r, c, rs, cs }] } — 선이 지나지 않는 경계는 칸을 합친다(네모꼴일 때만).
 */
function gridOf(rules, frags = []) {
  const H = rules.filter((r) => r.kind === 'hrule').map((r) => ({ pos: r.y + r.h / 2, a: r.x, b: r.x + r.w }));
  const V = rules.filter((r) => r.kind === 'vrule').map((r) => ({ pos: r.x + r.w / 2, a: r.y, b: r.y + r.h }));
  let xs = cluster(V.map((r) => r.pos)); const ys = cluster(H.map((r) => r.pos));
  if (!xs.length || ys.length < 2) return null;
  // 바깥 세로선이 없는 표(좌우 테두리 없는 통계표): 가로선이 세로선 범위 밖으로 뻗고(그 끝까지 닿는 가로선이 둘 넘음 — 머리·바닥선 등)
  // 그 사이에 글이 있으면 가로선 끝을 바깥 열 경계로 본다. 세로선이 하나도 없는 가로선뿐인 묶음은 표로 보지 않는다(제목 위아래 꾸밈선 등)
  const cxOf = (f) => f.x + f.w / 2; const cyOf = (f) => f.y + f.h / 2;
  const between = (a, b) => frags.some((f) => cxOf(f) > a && cxOf(f) < b && cyOf(f) > ys[0] && cyOf(f) < ys[ys.length - 1]);
  const lo = Math.min(...H.map((r) => r.a)); const hi = Math.max(...H.map((r) => r.b));
  if (xs[0] - lo >= RULE_MIN && H.filter((r) => r.a - lo <= TOL).length >= 2 && between(lo, xs[0])) xs = [lo, ...xs];
  if (hi - xs[xs.length - 1] >= RULE_MIN && H.filter((r) => hi - r.b <= TOL).length >= 2 && between(xs[xs.length - 1], hi)) xs = [...xs, hi];
  if (xs.length < 2) return null;
  // 행 사이 가로선이 없는 줄: 한 행 안 글이 기준선(가운데 y)마다 여러 열에 걸쳐 놓였으면 그 사이를 나눈다(rowBands)
  for (const pos of rowBands(xs, ys, frags)) { H.push({ pos, a: xs[0], b: xs[xs.length - 1] }); ys.push(pos); }
  ys.sort((a, b) => a - b);
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

/**
 * 가로선 없이 여러 기록이 쌓인 행 → 나눌 y 목록.
 * 행마다 그 안 조각을 기준선(가운데 y)으로 띠로 묶고, 그 행에서 글이 든 열의 3/4 넘게(둘 이상) 걸친 띠를 '기록 띠'로 본다. 기록 띠가 둘 넘으면 그 사이를 나눈다.
 * 몇 열에만 걸친 띠(한 칸 안 자동 줄바꿈, 두 줄 머리 칸, 세로 가운데 맞춘 칸)는 기록 띠가 아니라 가까운 기록에 붙인다 — 바로 위 기록이
 * 그 열들을 다 가지면(그 칸의 이어지는 줄) 위에, 아니면 더 가까운 쪽에.
 * 행마다 괘선이 있는 표(첫 행 말고 행의 절반 넘게 기록 띠가 하나 이하)는 괘선이 곧 행이므로 나누지 않는다 — 여러 칸이 함께 줄바꿈된 행을 가르지 않게.
 * 첫 행의 기록 띠 둘은 두 줄 머리행으로 보고 나누지 않는다(머리행 아래 괘선이 없어 기록까지 한 행에 든 표는 띠가 셋 넘는다).
 */
function rowBands(xs, ys, frags) {
  const cols = xs.length - 1; const out = []; const plan = [];
  const colOf = (cx) => { const c = xs.findIndex((x, i) => i < cols && cx < xs[i + 1]); return c < 0 ? cols - 1 : c; };
  for (let r = 0; r + 1 < ys.length; r++) {
    const inside = frags.filter((f) => { const cx = f.x + f.w / 2; const cy = f.y + f.h / 2; return cx >= xs[0] - TOL && cx <= xs[cols] + TOL && cy > ys[r] && cy < ys[r + 1]; });
    plan.push([]);
    if (inside.length < 4) continue;
    const bands = [];
    for (const f of inside.map((s) => ({ ...s, cy: s.y + s.h / 2 })).sort((a, b) => a.cy - b.cy)) {
      const last = bands[bands.length - 1];
      if (last && Math.abs(f.cy - last.cy) <= Math.max(120, Math.min(last.h, f.h) * 0.5)) {
        last.n++; last.cy += (f.cy - last.cy) / last.n; last.top = Math.min(last.top, f.y); last.bottom = Math.max(last.bottom, f.y + f.h); last.h = Math.max(last.h, f.h);
        last.cols.add(colOf(f.x + f.w / 2));
      } else bands.push({ cy: f.cy, n: 1, top: f.y, bottom: f.y + f.h, h: f.h, cols: new Set([colOf(f.x + f.w / 2)]) });
    }
    const all = new Set(bands.flatMap((b) => [...b.cols]));
    const need = Math.max(2, Math.ceil(all.size * 0.75));
    const records = bands.filter((b) => b.cols.size >= need);
    if (records.length < 2) continue;
    // 기록 띠가 아닌 띠를 기록에 붙여 기록마다 위·아래를 넓힌다
    const groups = records.map((b) => ({ top: b.top, bottom: b.bottom, cy: b.cy, cols: b.cols }));
    for (const b of bands) {
      if (records.includes(b)) continue;
      const above = [...groups].reverse().find((g) => g.cy < b.cy); const below = groups.find((g) => g.cy > b.cy);
      const g = above && (!below || [...b.cols].every((c) => above.cols.has(c)) || b.cy - above.cy <= below.cy - b.cy) ? above : below;
      g.top = Math.min(g.top, b.top); g.bottom = Math.max(g.bottom, b.bottom);
    }
    for (let i = 0; i + 1 < groups.length; i++) plan[r].push((groups[i].bottom + groups[i + 1].top) / 2);
  }
  const body = plan.slice(1);
  if (body.length >= 2 && body.filter((p) => !p.length).length * 2 > body.length) return out;   // 행마다 괘선이 있는 표
  plan.forEach((cuts, r) => { if (!(r === 0 && plan.length > 1 && cuts.length === 1)) out.push(...cuts); });
  return out;
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
  const paper = host.paper;
  // 글 조각: 글상자 하나가 곧 조각 하나이거나, 여러 줄 글상자는 저장된 줄 배치로 나눈 줄 조각(boxLines). wide = 쪽 폭 글상자(글이 어디 있는지 모름)
  const frags = texts.flatMap((t) => t.parts || [{ x: t.x, y: t.y, w: t.w, h: t.h, text: t.text, box: t.start, pk: `${t.start}:0`, li: 0, nl: 1, wide: !!paper && t.w >= paper.w * 0.9 }]);
  const grids = ruleGroups(rules).map((g) => gridOf(g, frags)).filter(Boolean).sort((a, b) => a.y0 - b.y0);
  // 조각이 낱말 뒤 빈칸을 품는 문서인가(다섯에 하나 넘게 빈칸으로 끝남) — 줄·쪽이 바뀌는 자리에서 낱말이 이어지는지를 그 빈칸으로 가린다
  const spaced = texts.length >= 4 && texts.filter((t) => /\s$/.test(t.text)).length >= texts.length * 0.2;
  // 글상자를 격자 칸에 넣는다(가운데 점 기준). 어느 격자에도 들지 않으면 자유 조각
  const free = [];
  for (const g of grids) g.bucket = new Map();
  for (const t of frags) {
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
    blocks.push({ type: 'grid', top: g.y0, bottom: g.y1, x0: g.x0, x1: g.x1, rows: g.rows, cols: g.cols, xs: g.xs, ys: g.ys,
      cells: g.cells.map(({ r, c, rs, cs, text, open }) => ({ r, c, rs, cs, text, open })), headerRows, spaced });
  }
  for (const ln of toLines(free, spaced)) {
    const line = { text: ln.text, top: ln.top, bottom: ln.bottom, x: ln.x, right: ln.right, h: ln.h, open: ln.open, head: ln.head, tail: ln.tail, starts: ln.starts, wide: ln.wide };
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
  // 글을 옮길 조각의 좌우 끝(여백 추정용) — 쪽 폭을 다 차지하는 글상자(가운데 맞춘 쪽 번호 등)는 빼고, 여러 줄 글상자는 줄 조각 자리로
  const span = [...frags.filter((i) => !i.wide && (!paper || i.w < paper.w * 0.9)), ...rules];
  return { ref, sec: host.sec, paper, frame: host.frame, spaced,
    counts: { text: count('text') + count('empty'), rule: rules.length, fill: count('fill') + count('dot'), figure: count('figure'), table: count('table'), complex: count('complex'), other: host.other, inline: host.inline },
    chars: texts.reduce((s, t) => s + [...t.text].length, 0), blocks: merged, used, kept: anchorsKept(items, used) + host.other + host.inline,
    bounds: span.length ? { left: Math.min(...span.map((i) => i.x)), right: Math.max(...span.map((i) => i.x + i.w)) } : null };
}
function anchorsKept(items, used) { return items.filter((i) => !used.has(i.start)).length; }

/** 개체 배치 지문: 대상 문단들의 개체(종류·자리·크기·글) — 제안한 뒤 개체가 바뀌었는지 볼 때(메모·문단 글 서식은 보지 않는다) */
export function layoutFingerprint(doc, refs = null) {
  return JSON.stringify(layoutHosts(doc, refs).map((ref) => [ref, hostItems(doc, ref, { lines: false }).items.map((i) => [i.tag, i.kind, i.x, i.y, i.w, i.h, i.text || ''])]));
}

/** 개체 → 본문이 실제로 옮길 것이 있는 본문 문단 ref 목록(옮길 수 있는 글상자·괘선·면을 하나라도 가진 문단) — refs 를 주면 그 가운데서 */
export function convertibleHosts(doc, refs = null) {
  return layoutHosts(doc, refs).filter((ref) => hostItems(doc, ref, { lines: false }).items.some((i) => MOVABLE.has(i.kind)));
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
        for (const text of paragraphsOf(kept, wrap, h.spaced)) items.push({ type: 'para', text });
        sawContent = true; open = null;
        continue;
      }
      // 격자: 이 문단의 첫 내용이고 앞 쪽 표와 열 구조가 같으면 잇는다
      if (joinPages && open && !sawContent && sameCols(open.block, b) && open.table.rows + b.rows <= MAX_TABLE_ROWS) {
        // 되풀이된 머리행은 넣지 않는다 — 빠진 글이 아니라 버린 글로 알린다(글 보존 검사·결과 줄)
        for (const text of appendGrid(open.table, b)) dropped.push({ host: h.ref, text, why: '되풀이 머리행' });
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

/** 글머리(기호·번호·'가.'·'(1)'·'제1')로 시작하는 줄 — 새 문단 */
const MARK = /^(?:[-•·∙◦○●■□▶※*]|\d+[.)]|[가-힣][.)]|\(\d+\)|제\s*\d+)/;
/** 문장이 끝난 줄 */
const SENTENCE_END = /[.!?。]["'”’)]?$/;
/** 머리표(글머리·번호, '주1:'·'비고:'·'자료:' 같은 짧은 이름표)로 시작하는 줄 — 다음 줄이 머리표 뒤로 들어가 이어질 수 있다(내어쓰기) */
const LABEL = /^(?:[-•·∙◦○●■□▶※*]|\d+[.)]|[가-힣][.)]|\(\d+\)|[^\s\d:：]{1,4}\s?\d{0,3}\s?[:：])/;

/**
 * 줄 목록 → 문단 글 목록. wrap 'keep': 줄마다 문단. 'auto': 이어지는 줄을 한 문단으로 잇는다.
 *  - 같은 글상자에서 온 줄: 같은 문단의 다음 줄이면 원문대로 잇고, 다른 문단이면 나눈다(저장된 문단 경계 — 제목 글상자의 제목·절 제목 등)
 *  - 다른 글상자에서 온 줄(낱말 조각 문서): 앞줄이 덩이 오른쪽 끝(쪽 폭 글상자 줄은 빼고 잰다)까지 차고, 줄 사이가 글자 높이 안이며, 글자 크기가 같고,
 *    다음 줄이 글머리로 시작하지 않고 앞줄이 문장 끝으로 끝나지 않으며, 왼쪽이 맞을 때 — 같은 왼쪽, 내어쓰기(글자 4개 폭 안에서 더 오른쪽이고, 첫 줄이
 *    머리표로 시작하거나 첫 줄 낱말 하나가 그 자리에서 시작), 첫 줄 들여쓰기(다음 줄이 글자 3개 폭 안에서 더 왼쪽). 셋째 줄부터는 둘째 줄의 왼쪽에 맞아야 한다. 잇는 자리는 glue
 */
function paragraphsOf(lines, wrap, spaced = false) {
  if (wrap === 'keep' || lines.length < 2) return lines.map((l) => l.text).filter(Boolean);
  const body = lines.filter((l) => !l.wide);
  const right = Math.max(...(body.length ? body : lines).map((l) => l.right)); const out = [];
  let cur = null;
  const joinOf = (prev, l) => {
    const same = sameBoxJoin(prev, l);
    if (same !== undefined) return same;
    if (prev.wide || l.wide) return null;
    const h = prev.h; const tol = h * 0.5;
    if (prev.right < right - h * 1.5 || l.top - prev.bottom > h * 0.9 || Math.abs(l.h - h) > h * 0.2) return null;
    if (MARK.test(l.text) || SENTENCE_END.test(prev.text)) return null;
    const left = cur.n >= 2 ? Math.abs(l.x - cur.contX) <= tol
      : Math.abs(l.x - prev.x) <= tol
        || (l.x > prev.x + tol && l.x <= prev.x + h * 4 && (LABEL.test(prev.text) || (prev.starts || []).slice(1).some((x) => Math.abs(x - l.x) <= tol)))
        || (l.x < prev.x - tol && prev.x - l.x <= h * 3);
    if (!left) return null;
    const joined = glue(prev.text, l.text, prev.open, spaced);
    return joined.slice(prev.text.length, joined.length - l.text.length);
  };
  for (const l of lines) {
    if (!l.text) continue;
    const sep = cur ? joinOf(cur.last, l) : null;
    if (sep != null) { cur.text += sep + l.text; cur.last = l; cur.n++; if (cur.n === 2) cur.contX = l.x; } else { cur = { text: l.text, last: l, n: 1, contX: null }; out.push(cur); }
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
 * 앞 표(t) 아래에 다음 쪽 격자 b 를 잇는다 → 넣지 않은 줄의 글 목록(줄마다 칸 글을 빈칸으로 이음 — 부르는 쪽이 '버린 글'로 알린다).
 *  - 다음 쪽이 같은 머리행으로 시작하면(반복 머리행) 그 줄은 넣지 않는다
 *  - 쪽 경계에서 끊긴 줄: 다음 쪽 첫 줄에서 '늘 차 있는 열'이 비어 있으면 앞 쪽 마지막 줄의 나머지다 — 글을 그 줄 칸에 잇고 줄은 넣지 않는다
 *  - 쪽 경계에서 끊긴 세로 합침: 맨 위 칸과 앞 쪽 맨 아래 칸이 같은 열·같은 폭이고, 둘 중 하나가 여러 줄을 합친 칸이며 글이 한쪽에만 있으면 한 칸
 */
function appendGrid(t, b) {
  let cells = b.cells.map((c) => ({ ...c })); let rows = b.rows;
  const removed = [];
  // 줄 k 를 뺀다: 그 줄뿐인 칸은 없어지고(그 글은 removed 에 — 버린 글로 알린다), 걸친 칸은 한 줄 줄며, 아래 칸은 올라온다
  const dropRow = (k) => {
    const gone = cells.filter((c) => c.r === k && c.rs === 1).sort((p, q) => p.c - q.c).map((c) => c.text).filter(Boolean);
    if (gone.length) removed.push(gone.join(' '));
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
      if (cells.every((c) => !(c.r === 0 && c.rs === 1 && c.text))) dropRow(0);
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
  return removed;
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
