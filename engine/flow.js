// 개체 → 본문(objects_to_body, 2026-11-16 — docs/MCP_REDESIGN_2026-11-16.md §4): 쪽 좌표에 놓인 글상자·괘선으로 그려진 문단을
// 진짜 본문 문단과 표로 옮기고 그 글상자·선·면을 지운다. 무엇을 어떻게 옮길지는 engine/layout.js 가 좌표로 정한다(모델이 글을 다시 치지 않는다).
// 변경 추적 없이 바로 고친다(쪽 구성 제안과 같은 길 — server/service.js 가 고치기 전 사본으로 되돌린다). 그림·표·차트와 안에 개체가 든 글상자는 그대로 둔다.
// 2026-11-17 안전장치(글자는 다 남았는데 문서가 망가진 채 통과하지 않게 — 24쪽 PDF 변환 문서 실제 실행에서 쪽 배경 그림이 옮긴 글을 덮고 48쪽이 됐다):
//   · 쪽 배경 그림(쪽 대부분을 덮는 종이·쪽 기준 그림, 옮길 글상자 아래에 깔린 것): 기본으로 지운다 — 내용으로 보이는 그림(스캔한 쪽 등)은 지우지 않고 글 뒤로(background)
//   · 옮긴 표는 자리차지·셀 단위로 나눔(쪽을 넘으면 나뉜다 — 글자처럼 취급한 표는 쪽을 넘으면 잘리고 통째로 다음 쪽으로 밀린다)
//   · 쪽을 차지하는 글 앞 그림이 있는 구역에는 뒤 구역을 합치지 않는다(합친 글이 그 그림 밑으로 흐른다)
//   · 숫자 보존 검사(소수·정수 토큰 — 붙거나 갈라지면 적용하지 않는다), 옮긴 글 영역에 겹치는 글 앞 개체 알림(covering)
import { EngineError } from './errors.js';
import { analyzeLayout, inferMargins, hostItems, sectionPaper } from './layout.js';

const MM = 7200 / 25.4;
const units = (mm) => Math.round(Number(mm) * MM);
const MARGIN_KEYS = ['left', 'right', 'top', 'bottom', 'header', 'footer', 'gutter'];
/** 넣을 글에서 XML 에 둘 수 없는 제어 문자를 빼고 줄바꿈은 빈칸으로 */
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/\s*\r?\n\s*/g, ' ');

/** 숫자 토큰(정수·소수·천 단위 쉼표 — '2.59' · '1,234' · '2026'). 두 수가 붙으면('2.592.75') 다른 토큰이 되어 다중집합이 달라진다 */
const NUMBER = /\d+(?:[.,]\d+)*/g;
function addText(m, s, sign = 1) { for (const ch of String(s)) { if (/\s/.test(ch)) continue; m.set(ch, (m.get(ch) || 0) + sign); } }
function addNumbers(m, s, sign = 1) { for (const x of String(s).matchAll(NUMBER)) m.set(x[0], (m.get(x[0]) || 0) + sign); }
/** 문서의 보이는 글(메모 본문 빼고 — 본문·표 칸·글상자) 한 번 훑기 → { chars: Map(빈칸 뺀 글자 → 수), numbers: Map(숫자 토큰 → 수) } */
function textStats(doc) {
  const chars = new Map(); const numbers = new Map();
  for (const p of doc.paragraphs({ view: 'final', nested: true })) { addText(chars, p.text); addNumbers(numbers, p.text); }
  return { chars, numbers };
}
/** 문서의 보이는 글(메모 본문 빼고 — 본문·표 칸·글상자)에서 빈칸을 뺀 글자 수 세기 → Map(글자 → 수) */
export function textCount(doc) { return textStats(doc).chars; }
const countOf = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };
/** a 에서 b 를 뺀 차(양수만) → Map */
const minus = (a, b) => { const out = new Map(); for (const [k, v] of a) { const d = v - (b.get(k) || 0); if (d > 0) out.set(k, d); } return out; };

/** 구역의 쪽 여백(HWPUNIT) | null */
function sectionMargins(sec) {
  const m = /<hp:pagePr\b[^>]*>\s*(<hp:margin\b[^>]*>)/.exec(sec.xml);
  if (!m) return null;
  return Object.fromEntries(MARGIN_KEYS.map((k) => [k, Number((new RegExp(`\\s${k}="(-?\\d+)"`).exec(m[1]) || [])[1] || 0)]));
}
function setSectionMargins(sec, mm) {
  const m = /<hp:pagePr\b[^>]*>\s*(<hp:margin\b[^>]*>)/.exec(sec.xml);
  if (!m) return false;
  let tag = m[1];
  for (const k of MARGIN_KEYS) {
    if (mm[k] == null) continue;
    const re = new RegExp(`(\\s${k}=")-?\\d+(")`);
    tag = re.test(tag) ? tag.replace(re, `$1${units(mm[k])}$2`) : tag.replace(/\s*\/?>$/, (end) => ` ${k}="${units(mm[k])}"${end}`);
  }
  const at = m.index + m[0].length - m[1].length;
  sec.load(sec.xml.slice(0, at) + tag + sec.xml.slice(at + m[1].length));
  return true;
}
const paperKey = (sec) => { const m = /<hp:pagePr\b[^>]*>/.exec(sec.xml); return m ? ['width', 'height', 'landscape'].map((k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(m[0]) || [])[1]).join('/') : ''; };

/** 글도 개체도 부호도 없는 빈 문단인가(구역 나누기 부호 secPr·colPr 는 있어도 된다) */
function emptyParagraph(p) {
  return !p.chars.length && !p.children.length
    && p.anchors.every((a) => a.kind === 'ctrl' && (a.name === 'hp:secPr' || (a.name === 'hp:ctrl' && a.inner === 'hp:colPr')));
}
/** 글·개체는 없고 메모(필드)만 달린 문단인가 — 지우지는 않지만(메모가 사라진다) 바로 뒤 글 문단을 끌어올릴 수 있다(메모는 그 문단 머리에 남는다) */
function blankWithMemos(p) {
  return !p.chars.length && p.children.every((c) => c.container === 'hp:fieldBegin')
    && p.anchors.every((a) => a.kind === 'ctrl' && (a.name === 'hp:secPr' || (a.name === 'hp:ctrl' && ['hp:colPr', 'hp:fieldBegin', 'hp:fieldEnd'].includes(a.inner))));
}
const hasPageFurniture = (xml) => /<hp:(?:header|footer|pageNum)\b/.test(xml);

// ───────── 개체 놓임(쪽 좌표) ─────────
const tagAttr = (tag, k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(tag) || [])[1] ?? null;
const firstTag = (xml, name) => (new RegExp(`<${name}\\b[^>]*>`).exec(xml) || [''])[0];
const lastTag = (xml, name) => { const i = xml.lastIndexOf(`<${name} `); return i < 0 ? '' : xml.slice(i, xml.indexOf('>', i) + 1); };
/** 쪽 배경으로 보는 넓이: 그림이 용지 넓이의 80% 넘게 덮는다 */
const PAGE_COVER = 0.8;
/** 무늬 없는 바탕으로 보는 압축률 한도(압축 크기 ÷ 픽셀 원자료) — 아래 compressionRatio */
const PLAIN_RATIO = 0.02;
/** 글 앞 개체 알림에서 빼는 작은 개체: 본문 영역 넓이의 1% 미만 */
const COVER_MIN = 0.01;

/**
 * 개체 XML(본문 문단이 직접 가진 앵커 하나)의 쪽 좌표 놓임 → { wrap, z, tac, rect: { x, y, w, h } | null(문단·단 기준 — 쪽 좌표를 모름) }.
 * 자기 hp:sz·hp:pos: 그림·표는 첫 것(뒤의 캡션·칸 안 개체보다 앞), 도형은 마지막 것(글상자 안 문단의 개체보다 뒤 — engine/layout.js hostItems 와 같다).
 * 기준: PAPER = 용지, PAGE = 쪽 여백 안(왼쪽 + 제본, 위 + 머리말 ~ 아래 − 꼬리말). 정렬 LEFT·TOP = 앞 끝 + 오프셋, CENTER = 가운데 + 오프셋, RIGHT·BOTTOM = 뒤 끝 − 크기 − 오프셋
 */
function placement(xml, name, paper, margins) {
  const open = (/^<[^>]+>/.exec(xml) || [''])[0];
  const own = name === 'hp:pic' || name === 'hp:tbl';
  const pos = own ? firstTag(xml, 'hp:pos') : lastTag(xml, 'hp:pos');
  const sz = (own ? firstTag(xml, 'hp:sz') : lastTag(xml, 'hp:sz')) || firstTag(xml, 'hp:curSz');
  const out = { wrap: tagAttr(open, 'textWrap'), z: Number(tagAttr(open, 'zOrder') ?? 0), tac: tagAttr(pos, 'treatAsChar') === '1', rect: null };
  const w = Number(tagAttr(sz, 'width')) || 0; const h = Number(tagAttr(sz, 'height')) || 0;
  if (!pos || !paper || !(w > 0 && h > 0) || out.tac) return out;
  const m = margins || {};
  const box = (rel, axis) => {
    if (rel === 'PAPER') return axis === 'x' ? [0, paper.w] : [0, paper.h];
    if (rel !== 'PAGE') return null;
    return axis === 'x' ? [(m.left || 0) + (m.gutter || 0), paper.w - (m.left || 0) - (m.right || 0) - (m.gutter || 0)]
      : [(m.top || 0) + (m.header || 0), paper.h - (m.top || 0) - (m.header || 0) - (m.bottom || 0) - (m.footer || 0)];
  };
  const bx = box(tagAttr(pos, 'horzRelTo'), 'x'); const by = box(tagAttr(pos, 'vertRelTo'), 'y');
  if (!bx || !by) return out;
  const place = ([start, len], size, align, off) => (['CENTER'].includes(align) ? start + (len - size) / 2 + off : ['RIGHT', 'BOTTOM', 'OUTSIDE'].includes(align) ? start + len - size - off : start + off);
  out.rect = { x: place(bx, w, tagAttr(pos, 'horzAlign'), Number(tagAttr(pos, 'horzOffset')) || 0), y: place(by, h, tagAttr(pos, 'vertAlign'), Number(tagAttr(pos, 'vertOffset')) || 0), w, h };
  return out;
}
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/** 구역 본문 영역(여백 안 — 머리말·꼬리말 뺌) */
function bodyRect(paper, m) {
  const x = (m?.left || 0) + (m?.gutter || 0); const y = (m?.top || 0) + (m?.header || 0);
  return { x, y, w: Math.max(0, paper.w - x - (m?.right || 0)), h: Math.max(0, paper.h - y - (m?.bottom || 0) - (m?.footer || 0)) };
}

/**
 * 그림 파일의 압축률(압축한 파일 크기 ÷ 픽셀 원자료 크기) | null(PNG·JPEG 가 아님 — 모른다).
 * 흰 바탕·띠·면 같은 무늬 없는 쪽 바탕은 아주 잘 준다(실제 PDF 변환 문서의 쪽 배경 PNG 2315×3142: 0.0014). 글·사진이 든 그림(스캔한 쪽)은
 * 글자 획마다 무늬가 생겨 덜 준다(흑백 글 스캔 PNG 대략 0.05~0.3, JPEG 0.05~0.2 — 일반적인 압축 특성, 이 문서에서 잰 값 아님). 픽셀을 풀지 않는다(서버 스레드에서 돈다)
 */
export function compressionRatio(bytes) {
  if (!bytes || bytes.length < 32) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0) === 0x89504e47) {   // PNG: IHDR 너비·높이·비트 깊이·색 형식
    const w = v.getUint32(16); const h = v.getUint32(20); const depth = v.getUint8(24); const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[v.getUint8(25)];
    return ch && w && h && depth ? bytes.length / ((w * h * ch * depth) / 8) : null;
  }
  if (v.getUint16(0) === 0xffd8) {   // JPEG: 처음 만나는 SOF 표지의 높이·너비·성분 수
    let i = 2;
    while (i + 9 < bytes.length) {
      if (v.getUint8(i) !== 0xff) { i++; continue; }
      const m = v.getUint8(i + 1);
      if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) { const h = v.getUint16(i + 5); const w = v.getUint16(i + 7); const n = v.getUint8(i + 9); return w && h && n ? bytes.length / (w * h * n) : null; }
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

/**
 * 쪽 배경 그림 찾기(옮길 글이 있는 문단 h — analyzeHost 결과). 일반 규칙(문서·수치 하나에 맞춘 것이 아니다):
 *  ① 문단이 직접 가진 그림(hp:pic), 글자처럼 취급 아님, 종이·쪽 기준 자리(PAPER·PAGE — 쪽 좌표가 정해진 것), 캡션 글 없음
 *  ② 용지 넓이의 80% 넘게 덮는다(PAGE_COVER)
 *  ③ 옮길 글상자 밑에 깔려 있다: 글 뒤로(BEHIND_TEXT)이거나, 글 앞으로(IN_FRONT_OF_TEXT)이면서 옮길 글상자의 90% 넘게가 그보다 위 차례(zOrder)
 *  ④ 옮길 글상자의 절반 넘게가(가운데 점) 그 그림 안에 놓인다
 * → [{ start, key(지운 뒤 다시 찾는 열쇠 — picKey), wrap, plain(무늬 없는 바탕 — compressionRatio ≤ PLAIN_RATIO) }]
 * margins: 옮기기 전 그 구역 여백(PAGE 기준 자리를 셀 때 — 여백을 바꾸기 전 자리가 원래 보이던 자리다)
 */
function pageBackgrounds(doc, h, margins) {
  if (!h.used.size || !h.paper) return [];
  const { sec, p } = doc.resolve(h.ref);
  const texts = hostItems(doc, h.ref).items.filter((i) => i.kind === 'text' && h.used.has(i.start));
  if (!texts.length) return [];
  const zs = texts.map((i) => Number(tagAttr(sec.xml.slice(i.start, sec.xml.indexOf('>', i.start) + 1), 'zOrder') ?? 0));
  const paperRect = { x: 0, y: 0, w: h.paper.w, h: h.paper.h };
  const out = [];
  for (const a of doc._ownObjectAnchors(p)) {
    if (a.name !== 'hp:pic') continue;
    const xml = sec.xml.slice(a.start, a.end);
    if (/<hp:caption\b[\s\S]*<hp:t>[^<]*\S/.test(xml)) continue;   // 캡션 글이 있는 그림은 내용이다
    const pl = placement(xml, 'hp:pic', h.paper, margins);
    if (!pl.rect || overlapArea(pl.rect, paperRect) < paperRect.w * paperRect.h * PAGE_COVER) continue;
    const under = pl.wrap === 'BEHIND_TEXT' || (pl.wrap === 'IN_FRONT_OF_TEXT' && zs.filter((z) => z > pl.z).length >= zs.length * 0.9);
    if (!under) continue;
    const on = texts.filter((t) => { const cx = t.x + t.w / 2; const cy = t.y + t.h / 2; return cx >= pl.rect.x && cx <= pl.rect.x + pl.rect.w && cy >= pl.rect.y && cy <= pl.rect.y + pl.rect.h; }).length;
    if (on * 2 <= texts.length) continue;
    const ratio = compressionRatio(doc.binaryItem(tagAttr(xml, 'binaryItemIDRef'))?.bytes);
    out.push({ start: a.start, key: picKey(xml), wrap: pl.wrap, plain: ratio != null && ratio <= PLAIN_RATIO });
  }
  return out;
}
/**
 * 쪽 배경 그림 미리 보기(읽기만 — server/mcp2/views.js 배치 요약): analyzeLayout 의 hosts 가운데 옮길 글이 있는 문단의 쪽 배경 그림 수
 * → { plain(기본으로 지울 무늬 없는 바탕), content(내용으로 보여 글 뒤로 보낼 것) }. 여백을 바꾸기 전 문서에서 objectsToBody 와 같은 규칙(pageBackgrounds)
 */
export function pageBackgroundCount(doc, hosts) {
  const out = { plain: 0, content: 0 };
  for (const h of hosts) {
    const sec = doc.sections[h.sec];
    for (const b of sec ? pageBackgrounds(doc, h, sectionMargins(sec)) : []) out[b.plain ? 'plain' : 'content']++;
  }
  return out;
}
/** 그림을 다시 찾는 열쇠(같은 문단의 다른 개체를 지운 뒤에도 그대로인 것): 여는 태그의 id·instid + 그림 파일 */
const picKey = (xml) => { const open = (/^<[^>]+>/.exec(xml) || [''])[0]; return `${tagAttr(open, 'id')}|${tagAttr(open, 'instid')}|${tagAttr(xml, 'binaryItemIDRef')}`; };
/** 문단 ref 가 직접 가진 그림 가운데 열쇠(picKey)가 keys 에 든 것을 글 뒤로(textWrap BEHIND_TEXT) → 바꾼 수 */
function sendBehind(doc, ref, keys) {
  const { sec, p } = doc.resolve(ref);
  const edits = [];
  for (const a of doc._ownObjectAnchors(p)) {
    if (a.name !== 'hp:pic' || !keys.includes(picKey(sec.xml.slice(a.start, a.end)))) continue;
    const end = sec.xml.indexOf('>', a.start) + 1; const open = sec.xml.slice(a.start, end);
    edits.push([a.start, end, /\stextWrap="/.test(open) ? open.replace(/(\stextWrap=")[^"]*(")/, '$1BEHIND_TEXT$2') : open.replace(/^<hp:pic\b/, '<hp:pic textWrap="BEHIND_TEXT"')]);
  }
  if (!edits.length) return 0;
  let xml = sec.xml;
  for (const [s, e, t] of edits.sort((x, y) => y[0] - x[0])) xml = xml.slice(0, s) + t + xml.slice(e);
  sec.load(xml);
  return edits.length;
}
/** 구역에 쪽을 차지하는 글 앞 그림(글자처럼 취급 아님 · 종이·쪽 기준 · 용지의 80% 넘게)이 있는가 — 그 구역 뒤에 다른 구역의 글을 합치면 그림 밑으로 흐른다 */
function hasPageFrontPicture(doc, sec) {
  const paper = sectionPaper(sec); if (!paper) return false;
  const margins = sectionMargins(sec); const area = paper.w * paper.h;
  for (const p of sec.bodyParas) for (const a of doc._ownObjectAnchors(p)) {
    if (a.name !== 'hp:pic') continue;
    const pl = placement(sec.xml.slice(a.start, a.end), 'hp:pic', paper, margins);
    if (pl.wrap === 'IN_FRONT_OF_TEXT' && pl.rect && overlapArea(pl.rect, { x: 0, y: 0, w: paper.w, h: paper.h }) >= area * PAGE_COVER) return true;
  }
  return false;
}

const OBJECT_KINDS = ['table', 'figure', 'shape', 'chart'];
/**
 * removeRest 옵션 → [{ kinds, refs(Set | null = 옮긴 문단 모두) }].
 * true = 모든 종류, ['shape', …] = 그 종류, [{ kinds?, at? }] = 문단(at — 옮기기 전 주소)마다 따로(같은 호출의 delete_objects 를 합칠 때 server/mcp2/ops.js 가 만든다)
 */
function restRules(v) {
  if (v == null || v === false) return [];
  if (v === true) return [{ kinds: OBJECT_KINDS, refs: null }];
  if (!Array.isArray(v) || !v.length) return [];
  if (typeof v[0] === 'string') return [{ kinds: v.filter((k) => OBJECT_KINDS.includes(k)), refs: null }];
  return v.map((r) => ({ kinds: Array.isArray(r?.kinds) && r.kinds.length ? r.kinds.filter((k) => OBJECT_KINDS.includes(k)) : OBJECT_KINDS, refs: Array.isArray(r?.at) && r.at.length ? new Set(r.at) : null }));
}

/**
 * 숫자 보존 검사: 원문 숫자 토큰(버린 줄·함께 지운 개체 안 것 빼고)과 결과 숫자 토큰이 다중집합으로 같은가 → { checked, problems: [글] }.
 * 다시 이은 숫자는 괜찮다: 늘어난 토큰이 사라진 두 토큰을 '.'·',' 를 사이에 두고 이은 것('2.59' ← 조각 '2.' + '59' — 쪽·조각 경계에서 갈라졌던 수)이면 셋을 지운다.
 * 사이 글자 없이 붙은 것('2.592.75' ← '2.59' + '2.75')은 붙음, 한 토큰이 둘로 나뉜 것은 갈라짐이다(조각을 줄로 이을 때 빈칸을 빠뜨리거나 더한 것 — engine/layout.js)
 */
export function numberCheck(want, have) {
  const missing = minus(want, have); const extra = minus(have, want);
  const take = (m, k) => { const n = m.get(k) || 0; if (n <= 1) m.delete(k); else m.set(k, n - 1); };
  const glued = []; const split = [];
  for (const [x, n] of [...extra]) {
    for (let r = 0; r < n; r++) {
      let done = false;
      // 조각 경계에서 갈라졌던 수를 다시 이음(사이에 '.'·',')
      for (let i = 1; i < x.length - 1 && !done; i++) if ((x[i] === '.' || x[i] === ',') && missing.has(x.slice(0, i)) && missing.has(x.slice(i + 1)) && (x.slice(0, i) !== x.slice(i + 1) || missing.get(x.slice(0, i)) > 1)) { take(missing, x.slice(0, i)); take(missing, x.slice(i + 1)); take(extra, x); done = true; }
      // 두 수가 사이 글자 없이 붙음
      for (let i = 1; i < x.length && !done; i++) if (missing.has(x.slice(0, i)) && missing.has(x.slice(i)) && (x.slice(0, i) !== x.slice(i) || missing.get(x.slice(0, i)) > 1)) { glued.push(`${x} ← ${x.slice(0, i)} + ${x.slice(i)}`); take(missing, x.slice(0, i)); take(missing, x.slice(i)); take(extra, x); done = true; }
    }
  }
  for (const [x, n] of [...missing]) {
    for (let r = 0; r < n; r++) {
      for (let i = 1; i < x.length; i++) {
        const sep = x[i] === '.' || x[i] === ',';
        const a = x.slice(0, i); const b = x.slice(sep ? i + 1 : i);
        if (b && extra.has(a) && extra.has(b) && (a !== b || extra.get(a) > 1)) { split.push(`${x} → ${a} · ${b}`); take(extra, a); take(extra, b); take(missing, x); break; }
      }
    }
  }
  const list = (m) => [...m].map(([k, v]) => (v > 1 ? `${k}×${v}` : k));
  const problems = [];
  if (glued.length) problems.push(`붙은 숫자 ${glued.length}개(${glued.slice(0, 5).join(' · ')}${glued.length > 5 ? ' …' : ''})`);
  if (split.length) problems.push(`갈라진 숫자 ${split.length}개(${split.slice(0, 5).join(' · ')}${split.length > 5 ? ' …' : ''})`);
  if (missing.size) problems.push(`사라진 숫자 ${countOf(missing)}개(${list(missing).slice(0, 8).join(' · ')}${missing.size > 8 ? ' …' : ''})`);
  if (extra.size) problems.push(`늘어난 숫자 ${countOf(extra)}개(${list(extra).slice(0, 8).join(' · ')}${extra.size > 8 ? ' …' : ''})`);
  return { checked: countOf(want), problems };
}

/**
 * 떠 있는 글상자·괘선을 본문 문단·표로 옮긴다.
 * opts: refs(대상 본문 문단들 — 없으면 문서 전체), joinPages·keepPageNumbers·drop·headerRows·wrap(engine/layout.js analyzeLayout),
 *       margins('auto' 기본 — 여백이 모두 0 인 구역만 조각 위치로 추정해 넣는다 | 'keep' | { left, right, top, bottom, header, footer } mm),
 *       mergeSections(기본 true — 비게 된 구역 첫 문단을 지워 앞 구역에 합친다. 용지가 같고 머리말·꼬리말·쪽 번호가 없는 구역만),
 *       removeRest(기본 없음 — 옮긴 문단에 남는 개체[옮기지 못한 그림·표·차트·회전한 도형·안에 개체가 든 글상자]도 지운다: true | 종류 목록 | [{ kinds?, at? }]),
 *       background('remove' 기본 — 쪽 배경 그림[pageBackgrounds]을 지운다. 내용으로 보이는 그림[압축률이 PLAIN_RATIO 넘음·모르는 형식]은 지우지 않고 글 뒤로 |
 *                  'behind' — 모두 글 뒤로[구역 첫 문단에 그림이 남으므로 그 구역은 합치지 않는다 — 원래 쪽마다 새 쪽에서 시작]), author
 * → { report, mapping: [{ old: [구역, 문단], to: [구역, 문단] | null }] }
 *   report: { tables: [{ ref, key, rows, cols, headerRows, merges, pages }], paragraphs, removed, removedRest, kept, dropped: [{ text, why }], sections: [전, 후], margins,
 *             backgrounds?: { mode, removed, behind, content }, covering?: { count, items: [{ ref, name, mm, share }] },
 *             text: { source, moved, dropped, removedWithObjects, lost, extra, numbers } }
 * 글자 수가 어긋나거나 숫자 토큰이 붙고 갈라지면 FLOW_VERIFY 로 던진다(적용하지 않는다).
 */
export function objectsToBody(doc, opts = {}) {
  const layoutOpts = { refs: opts.refs || null, joinPages: opts.joinPages !== false, keepPageNumbers: opts.keepPageNumbers === true, drop: opts.drop || null, headerRows: opts.headerRows ?? null, wrap: opts.wrap || 'auto' };
  const bgMode = opts.background === 'behind' ? 'behind' : 'remove';
  const before = textStats(doc);
  let plan = analyzeLayout(doc, layoutOpts);
  if (!plan.hosts.some((h) => h.used.size)) throw new EngineError('NO_OBJECTS', '본문으로 옮길 글상자·도형이 없습니다(떠 있는 글상자·선이 있는 문단이 대상입니다)');
  const sectionsBefore = doc.sections.length;
  const sizes = doc.sections.map((s) => s.bodyParas.length);
  const marginsBefore = doc.sections.map(sectionMargins);

  // 1) 여백: 표 폭은 본문 폭으로 잡으므로 표를 넣기 전에 정한다
  let margins = null;
  if (opts.margins !== 'keep') {
    const given = opts.margins && typeof opts.margins === 'object' ? opts.margins : null;
    const auto = inferMargins(plan.hosts.filter((h) => h.used.size));
    let changed = false;
    for (const si of [...new Set(plan.hosts.filter((h) => h.used.size).map((h) => h.sec))]) {
      const cur = sectionMargins(doc.sections[si]);
      if (!cur || !(given || MARGIN_KEYS.every((k) => !cur[k]))) continue;
      const want = given ? Object.fromEntries(MARGIN_KEYS.filter((k) => given[k] != null).map((k) => [k, given[k]])) : auto;
      if (setSectionMargins(doc.sections[si], want)) { margins = want; changed = true; }
    }
    if (changed) plan = analyzeLayout(doc, layoutOpts);   // 구역 XML 이 바뀌었다 — 개체 위치를 다시 읽는다
  }

  // 1-1) 쪽 배경 그림: 원래는 글상자 밑에 깔려 보였지만 글이 본문으로 내려오면 글 앞 그림은 글을 덮는다(2026-11-17 실제 24쪽 문서 — 16쪽이 가려짐).
  //      글이 흐르는 문서에서 원래 쪽은 없어지므로 쪽 배경은 지우는 것이 기본이다(남기면 구역 첫 문단이 비지 않아 구역도 합치지 못한다 — 쪽 폭증의 한 원인)
  const backgrounds = new Map(); const bgReport = { mode: bgMode, removed: 0, behind: 0, content: 0 };
  for (const h of plan.hosts) {
    const found = pageBackgrounds(doc, h, marginsBefore[h.sec]);
    if (!found.length) continue;
    const remove = new Set(); const behind = [];
    for (const b of found) {
      if (bgMode === 'remove' && b.plain) { remove.add(b.start); continue; }
      if (bgMode === 'remove') bgReport.content++;
      if (b.wrap !== 'BEHIND_TEXT') behind.push(b.key);
      bgReport.behind++;
    }
    backgrounds.set(h.ref, { remove, behind });
  }

  // 2) 문단마다(뒤에서부터 — 앞 문단 주소·위치가 흔들리지 않게) 옮긴 개체를 지우고 그 뒤에 문단·표를 넣는다
  const order = doc.sections.map((s, si) => s.bodyParas.map((_, i) => `${si}/${i}`));   // 본문 자리 추적(원래 문단 = '구역/번호', 새로 넣은 것 = 객체)
  const flowOf = new Map(plan.flow.map((f) => [f.host, f.items]));
  const made = []; let paragraphs = 0; let removed = 0; let kept = 0;
  const moved = new Map();
  for (const h of [...plan.hosts].reverse()) {
    const [si, bi] = h.ref.slice(1).split('/p').map(Number);
    kept += h.kept;
    const bg = backgrounds.get(h.ref);
    if (h.used.size) {
      // 옮긴 글상자·선과 지울 쪽 배경 그림을 한 번에(자리 번호가 같은 시점의 것이어야 한다)
      const drop = bg?.remove.size ? bg.remove : null;
      const n = doc.removeOwnObjects(h.ref, { kinds: drop ? ['shape', 'figure'] : ['shape'], pick: (a) => h.used.has(a.start) || !!drop?.has(a.start) });
      if (drop) { removed += n - drop.size; bgReport.removed += drop.size; kept -= drop.size; } else removed += n;
    }
    if (bg?.behind.length) sendBehind(doc, h.ref, bg.behind);
    const items = flowOf.get(h.ref) || [];
    for (let k = items.length - 1; k >= 0;) {
      if (items[k].type === 'para') {
        let j = k; while (j > 0 && items[j - 1].type === 'para') j--;
        const texts = items.slice(j, k + 1).map((x) => clean(x.text));
        doc.insertFinalParagraphsAfter(si, bi, texts);
        order[si].splice(bi + 1, 0, ...texts.map(() => ({ kind: 'para' })));
        for (const t of texts) addText(moved, t);
        paragraphs += texts.length; k = j - 1;
      } else {
        const t = plan.tables[items[k].table];
        const rows = t.grid.map((r) => r.map(clean));
        const res = doc.insertTableAfter(si, bi, { rows, headerRows: t.headerRows, caption: '' }, { author: opts.author || 'AI' });
        // 옮긴 표는 자리차지 + 셀 단위로 나눔: 칸 글이 새 칸 폭·여백에서 다시 접혀 높이를 넣기 전에 알 수 없다(insertTableAfter 의 높이 어림은 줄마다 한 줄로 센다 —
        // 실제 24쪽 문서의 6열 표가 글자처럼 취급으로 들어가 쪽보다 길어져 잘리고 통째로 다음 쪽으로 밀렸다). 한 쪽에 들어가는 표는 글자처럼 취급과 같은 자리에 놓인다
        const ops = [{ op: 'table', treat_as_char: false, page_break: 'CELL' }, { op: 'col_widths', widths: t.widths }, ...t.merges.map((m) => ({ op: 'merge', range: { row_from: m.r, row_to: m.r + m.rs - 1, col_from: m.c, col_to: m.c + m.cs - 1 } }))];
        for (let i = 0; i < ops.length; i += 40) doc.editTable(res.tableKey, ops.slice(i, i + 40));
        const token = { kind: 'table', rows: t.rows, cols: t.cols, headerRows: t.headerRows, merges: t.merges.length, pages: t.hosts.length };
        order[si].splice(bi + 1, 0, token); made.push(token);
        for (const r of rows) for (const c of r) addText(moved, c);
        k--;
      }
    }
  }
  if (!bgReport.removed && !bgReport.behind) bgReport.mode = null;

  const tokenOf = (h) => h.ref.slice(1).replace('/p', '/');
  const where = (token) => { for (let s = 0; s < order.length; s++) { const i = order[s].indexOf(token); if (i >= 0) return [s, i]; } return null; };
  const paraAt = (s, i) => doc.sections[s].bodyParas[i];

  // 2-1) 남는 개체도 지우기(removeRest — 같은 호출의 delete_objects 를 합친 것 포함): 옮긴 문단에 남은 개체(옮기지 못한 그림·표·차트·회전한 도형·안에 개체가 든 글상자)
  //      가운데 고른 종류를 지운다. 안에 든 글도 함께 사라지므로 그 글자·숫자를 따로 세어 결과에 적고 보존 검사에서 뺀다(조용히 잃지 않는다)
  let restText = new Map(); let restNumbers = new Map(); let removedRest = 0;
  const rules = restRules(opts.removeRest);
  if (rules.length) {
    const jobs = [];
    for (const h of plan.hosts) {
      if (!h.used.size) continue;
      const kinds = [...new Set(rules.filter((r) => !r.refs || r.refs.has(h.ref)).flatMap((r) => r.kinds))];
      const at = kinds.length ? where(tokenOf(h)) : null;
      if (!at) continue;
      const ref = `s${at[0]}/p${at[1]}`;
      if (doc.ownObjects(ref).some((o) => kinds.includes(o.kind))) jobs.push({ ref, kinds });
    }
    if (jobs.length) {
      const had = textStats(doc);
      for (const j of jobs) removedRest += doc.removeOwnObjects(j.ref, { kinds: j.kinds });
      const has = textStats(doc);
      restText = minus(had.chars, has.chars); restNumbers = minus(had.numbers, has.numbers);
      kept = Math.max(0, kept - removedRest);
    }
  }

  // 3) 비게 된 문단 정리: 구역 첫 문단(구역 나누기)은 앞 구역과 용지가 같으면 지워 구역을 합치고, 그 밖의 빈 문단은 지운다.
  //    지울 수 없는 첫 문단(문서 맨 앞 등)은 바로 뒤에 넣은 글 문단을 끌어올려 빈 줄을 남기지 않는다.
  //    앞 구역에 쪽을 차지하는 글 앞 그림이 있으면 합치지 않는다(합친 글이 그 그림 밑으로 흐른다 — 그 그림은 원래 쪽 하나를 차지했다)
  const hostTokens = plan.hosts.filter((h) => h.used.size).map(tokenOf);
  if (opts.mergeSections !== false && doc.sections.length > 1) {
    const mergeable = hostTokens.filter((tok) => {
      const at = where(tok); if (!at || at[1] !== 0 || at[0] === 0) return false;
      const sec = doc.sections[at[0]]; const prev = doc.sections[at[0] - 1];
      return emptyParagraph(paraAt(at[0], 0)) && paperKey(sec) === paperKey(prev) && !hasPageFurniture(sec.xml)
        && JSON.stringify(sectionMargins(sec)) === JSON.stringify(sectionMargins(prev)) && !hasPageFrontPicture(doc, prev);
    });
    if (mergeable.length) {
      doc.flattenSections();
      const flat = order.flat(); order.length = 0; order.push(flat);
      for (const tok of mergeable.reverse()) {
        const i = flat.indexOf(tok);
        doc.removeBodyParagraph(0, i); flat.splice(i, 1);
      }
      const starts = [];
      for (let i = 1; i < doc.sections[0].bodyParas.length; i++) if (doc.hasSectionBreak(`s0/p${i}`)) starts.push(i);
      if (starts.length) {
        doc.splitSectionsAt(starts);
        const parts = []; let from = 0;
        for (const s of [...starts, flat.length]) { parts.push(flat.slice(from, s)); from = s; }
        order.length = 0; order.push(...parts);
      }
    }
  }
  for (const tok of [...hostTokens].reverse()) {
    const at = where(tok); if (!at) continue;
    const [s, i] = at; const p = paraAt(s, i);
    if (!p) continue;
    if (i > 0 && emptyParagraph(p)) { doc.removeBodyParagraph(s, i); order[s].splice(i, 1); continue; }
    // 남는 빈 문단(구역 첫 문단이거나 메모가 달린 문단): 바로 뒤에 넣은 글 문단을 끌어올린다
    const next = order[s][i + 1];
    if (blankWithMemos(p) && next && typeof next === 'object' && next.kind === 'para') { doc.joinBodyParagraph(s, i + 1); order[s].splice(i + 1, 1); }
  }

  // 4) 보존 검사: 옮기기 전 글 = 옮긴 뒤 글 + 버린 글(쪽 번호 등) + 남는 개체와 함께 지운 글(removeRest). 어긋나면 적용하지 않는다(부르는 쪽이 사본에서 돌렸거나 되돌린다)
  //    글자 수만으로는 두 수가 붙은 것('2.59'·'2.75' → '2.592.75')을 못 잡는다 — 숫자 토큰도 다중집합으로 견준다(2026-11-17 실제 결과에서 소수 26개가 붙었다)
  const after = textStats(doc);
  const droppedText = new Map(); const droppedNumbers = new Map();
  for (const d of plan.dropped) { addText(droppedText, d.text); addNumbers(droppedNumbers, d.text); }
  let lost = 0; let extra = 0;
  for (const ch of new Set([...before.chars.keys(), ...after.chars.keys()])) {
    const d = (before.chars.get(ch) || 0) - (after.chars.get(ch) || 0) - (droppedText.get(ch) || 0) - (restText.get(ch) || 0);
    if (d > 0) lost += d; else extra -= d;
  }
  if (lost || extra) throw new EngineError('FLOW_VERIFY', `옮긴 글이 원문과 맞지 않아 적용하지 않았습니다(빠진 글자 ${lost}개 · 늘어난 글자 ${extra}개)`);
  const nums = numberCheck(minus(minus(before.numbers, droppedNumbers), restNumbers), after.numbers);
  if (nums.problems.length) throw new EngineError('FLOW_VERIFY', `옮긴 숫자가 원문과 맞지 않아 적용하지 않았습니다(원문 숫자 ${nums.checked}개 가운데 ${nums.problems.join(' · ')}) — 글상자 조각을 줄로 이을 때 숫자 사이 빈칸이 빠지거나 더해졌습니다`);

  // 5) 주소 옮김표와 결과
  const mapping = []; const final = new Map();
  order.forEach((list, s) => list.forEach((tok, i) => { if (typeof tok === 'string') final.set(tok, [s, i]); else tok.ref = `s${s}/p${i}`; }));
  for (let s = 0; s < sectionsBefore; s++) for (let i = 0; i < sizes[s]; i++) mapping.push({ old: [s, i], to: final.get(`${s}/${i}`) || null });
  const covering = coveringObjects(doc, order, new Set(hostTokens));
  const report = {
    tables: made.reverse().map((t) => ({ ref: t.ref, key: `${t.ref}#t0`, rows: t.rows, cols: t.cols, headerRows: t.headerRows, merges: t.merges, pages: t.pages })),
    paragraphs, removed, removedRest, kept: Math.max(0, kept),
    dropped: plan.dropped.map((d) => ({ text: d.text, why: d.why })),
    sections: [sectionsBefore, doc.sections.length], margins,
    ...(bgReport.mode ? { backgrounds: bgReport } : {}),
    ...(covering.count ? { covering } : {}),
    text: { source: countOf(before.chars), moved: countOf(moved), dropped: countOf(droppedText), removedWithObjects: countOf(restText), lost, extra, numbers: nums.checked },
  };
  return { report, mapping };
}

/**
 * 옮긴 글 영역에 겹치는 글 앞 개체(알림 — 적용은 막지 않는다): 옮긴 글이 놓인 구역의 본문 문단이 직접 가진 개체 가운데 글자처럼 취급 아님 · 글 앞으로(IN_FRONT_OF_TEXT) ·
 * 쪽 좌표(종이·쪽 기준)가 본문 영역과 겹치는 것(본문 영역의 1% 이상), 그리고 문단 기준이라 자리를 모르는 글 앞 그림·표.
 * 정말 글을 가리는지는 조판 뒤 글이 어디에 놓이는지와 그림의 투명도에 달려 있어 여기서는 알림만 한다(조판으로 잰 '가려진 쪽'은 server/page-estimate.js covered).
 * → { count, items: [{ ref, name, mm('가로×세로'), share(본문 영역 가운데 덮는 비율 | null) }] (앞 5개) }
 */
function coveringObjects(doc, order, hostTokens) {
  const touched = new Set();
  order.forEach((list, s) => { if (list.some((tok) => typeof tok === 'object' || hostTokens.has(tok))) touched.add(s); });
  const items = []; let count = 0;
  for (const s of touched) {
    const sec = doc.sections[s]; const paper = sectionPaper(sec); if (!paper) continue;
    const margins = sectionMargins(sec); const body = bodyRect(paper, margins); const area = body.w * body.h || 1;
    for (const p of sec.bodyParas) {
      const anchors = doc._ownObjectAnchors(p); if (!anchors.length) continue;
      let names = null;
      anchors.forEach((a, k) => {
        const xml = sec.xml.slice(a.start, a.end);
        const pl = placement(xml, a.name, paper, margins);
        if (pl.tac || pl.wrap !== 'IN_FRONT_OF_TEXT') return;
        const share = pl.rect ? overlapArea(pl.rect, body) / area : null;
        if (share != null ? share < COVER_MIN : !(a.name === 'hp:pic' || a.name === 'hp:tbl')) return;
        count++;
        if (items.length >= 5) return;
        names ??= doc.ownObjects(p.ref);
        const sz = (a.name === 'hp:pic' || a.name === 'hp:tbl' ? firstTag(xml, 'hp:sz') : lastTag(xml, 'hp:sz'));
        const mm = (k2) => Math.round((Number(tagAttr(sz, k2)) || 0) / MM);
        items.push({ ref: p.ref, name: names[k]?.name || a.name, mm: `${mm('width')}×${mm('height')}`, share: share == null ? null : Math.round(share * 100) / 100 });
      });
    }
  }
  return { count, items };
}
