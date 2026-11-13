// [hwpx-cowork] 그리기 개체(도형) — 선·사각형(글상자)·타원·호·다각형·곡선·연결선·묶음·차트 요소를 편집기(rhwp) 내보내기에서
// 서버 문서로 옮기는 도우미. diffDocs 'object' 덩어리(지문·짝)와 HwpxDoc.copyObjectsFrom(옮기기)이 쓴다. 그림(hp:pic)·표는 그것대로의 경로가 있다.
//
// 한/글 실측(2026-10-30, 한글 COM — 개체 속성으로 옮기기·크기·지우기 뒤 HWPX 저장):
//  - 옮기기: hp:pos 의 vertOffset·horzOffset 만 바뀐다(줄 정보 그대로)
//  - 크기: hp:sz 가 바뀐다. hp:curSz 가 0(처음 크기 그대로)이면 0 그대로·행렬·회전 중심·꼭짓점 그대로, 0 이 아니면(앞서 크기를 바꾼 개체)
//    curSz = 새 크기, 회전 중심 = 크기/2, scaMatrix e1·e5 = 새 크기/orgSz(서로 지우던 이동 성분 e3·e6 은 0) — 꼭짓점(로컬 좌표)은 그대로
//  - 지우기: 개체 요소만 빠진다(떠 있는 개체의 문단 줄 정보는 그대로)
// 편집기 내보내기는 손대지 않은 도형도 몇 군데 다르게 쓴다(타원 intervalDirty·hasArcPr·arcType 을 빼고, 연결선에 isReverseHV 를 더하고,
// 묶음 instid·묶음 안 개체 id 를 바꾸고, 묶음 안 개체에 sz·pos·outMargin 을 더한다. 사각형 꼭짓점을 크기 좌표로 다시 쓴다) — 지문은 이런 것을
// 보지 않고, 옮길 때는 서버 문서(한/글 원본)의 요소·속성 차례를 그대로 두고 바뀐 값만 바꾼다.
import { scan } from './xmlscan.js';

/** 편집기가 읽고 다시 쓰는(왕복하는) 본문 개체 — 지우기·넣기·옮기기·크기 등을 서버 문서로 옮긴다. 글맵시(hp:textart)는 편집기가 읽지 못해(내보내기에서 빠진다) 넣지 않는다 */
export const SHAPE_TAGS = new Set(['hp:line', 'hp:rect', 'hp:ellipse', 'hp:arc', 'hp:polygon', 'hp:curve', 'hp:connectLine', 'hp:container', 'hp:chart']);
/** 묶음(hp:container) 안에서 편집기가 읽는 개체. 그 밖의 것(글맵시·수식 등)이 든 묶음은 통째로 바꾸지 않는다(편집기 쪽에는 없으므로) */
const CHILD_TAGS = new Set(['hp:line', 'hp:rect', 'hp:ellipse', 'hp:arc', 'hp:polygon', 'hp:curve', 'hp:connectLine', 'hp:container', 'hp:pic', 'hp:ole']);
/** 지문에서 빼는 요소(그 아래 전부): 파생 행렬, 도형 설명, 글(글상자·캡션 문단 — 중첩 문단으로 따로 비교한다) */
const SKIP_SUBTREE = new Set(['hp:renderingInfo', 'hp:shapeComment', 'hp:p']);
/** 묶음 안 개체의 상자 요소 — 한/글은 쓰지 않고 편집기는 쓴다 */
const CHILD_BOX = new Set(['hp:sz', 'hp:pos', 'hp:outMargin', 'hp:caption', 'hp:shapeComment']);
/** 도형 꼭짓점(로컬 좌표) 요소 — 지문은 범위로 맞춘(정규화) 꼴만 본다 */
const POINT_TAGS = new Set(['hc:pt0', 'hc:pt1', 'hc:pt2', 'hc:pt3', 'hc:pt', 'hc:startPt', 'hc:endPt', 'hp:startPt', 'hp:endPt', 'hc:center', 'hc:ax1', 'hc:ax2',
  'hc:start1', 'hc:end1', 'hc:start2', 'hc:end2', 'hp:seg', 'hp:controlPoints']);
/** 지문·옮기기에서 보지 않는 속성: 개체 번호(짝짓기 열쇠로만), 편집기가 빼거나 더하는 것, 글 상자 파생값, 회전 중심(크기/2) */
const SKIP_ATTRS = new Set(['id', 'instid', 'intervalDirty', 'hasArcPr', 'arcType', 'isReverseHV', 'groupLevel', 'linkListIDRef', 'linkListNextIDRef',
  'textWidth', 'textHeight', 'hasTextRef', 'hasNumRef', 'centerX', 'centerY', 'lastWidth']);
/** 묶음 안 개체 여는 태그에서 더 빼는 속성(한/글은 0·기본값으로, 편집기는 원래 값으로 쓴다) */
const CHILD_SKIP_ATTRS = new Set(['zOrder', 'numberingType', 'textWrap', 'textFlow', 'lock', 'dropcapstyle', 'href']);
const COORD_X = new Set(['x', 'x1', 'x2']); const COORD_Y = new Set(['y', 'y1', 'y2']);

const NAME_KO = { 'hp:line': '선', 'hp:rect': '사각형', 'hp:ellipse': '타원', 'hp:arc': '호', 'hp:polygon': '다각형', 'hp:curve': '곡선', 'hp:connectLine': '연결선',
  'hp:container': '묶음', 'hp:chart': '차트', 'hp:textart': '글맵시' };
/** 도형 이름(글상자는 '글상자') */
export function shapeName(tag, xml = '') { return tag === 'hp:rect' && xml.includes('<hp:drawText') ? '글상자' : (NAME_KO[tag] || tag); }

/** 여는 태그의 속성(원문 값 그대로, 차례대로) */
function rawAttrs(open) {
  const out = new Map();
  for (const m of open.matchAll(/([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g)) out.set(m[1], m[2]);
  return out;
}

/** XML 조각 → 요소 나무 { tag, start, openEnd, end, open, attrs(원문 값), children } (첫 요소) */
function tree(xml) {
  const root = { children: [] }; const stack = [root];
  for (const t of scan(xml)) {
    if (t.type === 'open' || t.type === 'selfclose') {
      const open = xml.slice(t.start, t.end);
      const n = { tag: t.name, start: t.start, openEnd: t.end, end: t.end, open, attrs: rawAttrs(open), children: [] };
      stack[stack.length - 1].children.push(n);
      if (t.type === 'open') stack.push(n);
    } else if (t.type === 'close') {
      while (stack.length > 1) { const n = stack.pop(); if (n.tag === t.name) { n.end = t.end; break; } }
    }
  }
  return root.children[0] || null;
}

const skipAttr = (k, depth) => SKIP_ATTRS.has(k) || (depth > 0 && CHILD_SKIP_ATTRS.has(k));
function attrText(n, depth, binKey, isOpen) {
  // [hwpx-cowork] 차트 부분 참조(chartIDRef)도 내용 열쇠로(engine/chart-parts.js) — 차트 값만 바꿔도 지문이 달라진다
  return [...n.attrs].filter(([k]) => !skipAttr(k, isOpen ? depth : 0)).map(([k, v]) => `${k}=${k === 'binaryItemIDRef' || k === 'chartIDRef' ? binKey(v) : v}`).sort().join(',');
}
/** 요소와 그 아래(글 문단·파생 행렬 빼고)의 납작한 지문 글 */
function flat(n, binKey) {
  if (SKIP_SUBTREE.has(n.tag)) return '';
  return `${n.tag}(${attrText(n, 0, binKey, false)})${n.children.map((c) => flat(c, binKey)).filter(Boolean).join('')}`;
}
/** 개체의 꼭짓점 요소들(차례대로) */
function pointNodes(n) { return n.children.filter((c) => POINT_TAGS.has(c.tag)); }
/**
 * 꼭짓점 꼴 지문: 모든 좌표를 그 범위로 맞춘(0~1, 소수 셋째 자리) 값 — 크기만 바뀐 도형은 같다(편집기는 사각형 꼭짓점을 크기 좌표로 다시 쓰고
 * 한/글은 처음 좌표를 그대로 둔다). 끝점을 옮겨 기울기가 바뀌거나 꼭짓점을 고친 도형은 다르다
 */
function geoPrint(n) {
  const pts = [];
  const walk = (e) => { pts.push(e); e.children.forEach(walk); };
  pointNodes(n).forEach(walk);
  if (!pts.length) return '';
  const xs = []; const ys = [];
  for (const e of pts) for (const [k, v] of e.attrs) { if (COORD_X.has(k)) xs.push(Number(v) | 0); else if (COORD_Y.has(k)) ys.push(Number(v) | 0); }
  const span = (a) => (a.length ? [Math.min(...a), Math.max(...a) - Math.min(...a)] : [0, 0]);
  const [x0, w] = span(xs); const [y0, h] = span(ys);
  const norm = (v, o, s) => (s > 0 ? Math.round(((Number(v) | 0) - o) / s * 1000) / 1000 : 0);
  return pts.map((e) => `${e.tag}(${[...e.attrs].map(([k, v]) => `${k}=${COORD_X.has(k) ? norm(v, x0, w) : COORD_Y.has(k) ? norm(v, y0, h) : v}`).join(',')})`).join('');
}

/**
 * 개체 하나(나무 n, 깊이 depth — 묶음 안이면 1 이상)의 비교 속성:
 * { tag, pos(hp:pos), sz(hp:sz 폭·높이), o(그 밖의 요소·속성 지문 글들), g(꼭짓점 꼴), k(묶음 안 개체들), foreign(편집기가 못 읽는 개체가 묶음 안에 있음) }
 */
function nodeProps(n, depth, binKey) {
  const out = { tag: n.tag, pos: '', sz: null, o: [`${n.tag}(${attrText(n, depth, binKey, true)})`], g: geoPrint(n), k: [], foreign: false };
  for (const c of n.children) {
    if (SKIP_SUBTREE.has(c.tag) || POINT_TAGS.has(c.tag)) continue;
    if (depth > 0 && CHILD_BOX.has(c.tag)) continue;
    if (c.tag === 'hp:orgSz' || c.tag === 'hp:curSz' || (c.tag === 'hp:offset' && depth === 0)) continue;   // 로컬 좌표 기준(파생)
    if (n.tag === 'hp:container' && /^h[pc]:/.test(c.tag) && !['hp:offset', 'hp:flip', 'hp:rotationInfo', 'hp:sz', 'hp:pos', 'hp:outMargin', 'hp:caption'].includes(c.tag)) {
      if (CHILD_TAGS.has(c.tag)) { const kp = nodeProps(c, depth + 1, binKey); out.k.push(kp); if (kp.foreign) out.foreign = true; } else out.foreign = true;
      continue;
    }
    if (c.tag === 'hp:pos' && depth === 0) { out.pos = flat(c, binKey); continue; }
    if (c.tag === 'hp:sz' && depth === 0) { out.sz = [Number(c.attrs.get('width')) || 0, Number(c.attrs.get('height')) || 0]; out.o.push(flat(c, binKey)); continue; }
    out.o.push(flat(c, binKey));
  }
  return out;
}

/**
 * [hwpx-cowork] 글 목록(hp:subList — 글상자·캡션의 글) 안을 비운 XML: 그 안은 문단(hp:p)뿐이고 지문은 문단을 보지 않는다(SKIP_SUBTREE —
 * 글은 중첩 문단으로 따로 비교한다). 비교 속성만 셀 때 글상자 글의 run·줄 정보까지 나무로 만들지 않게(2026-11-10: 글상자 수백 개 문단에서
 * 도형 속성 세기가 밀어 넣기 한 번에 1초 넘게 걸렸다). 짝이 맞지 않으면(깨진 XML) 그대로 둔다
 */
function withoutSubListBodies(xml) {
  if (!xml.includes('<hp:subList')) return xml;
  let out = ''; let at = 0;
  for (;;) {
    const s = xml.indexOf('<hp:subList', at); if (s < 0) break;
    const openEnd = xml.indexOf('>', s); if (openEnd < 0) return xml;
    if (xml[openEnd - 1] === '/') { out += xml.slice(at, openEnd + 1); at = openEnd + 1; continue; }
    let depth = 1; let i = openEnd + 1;
    while (depth > 0) {
      const o = xml.indexOf('<hp:subList', i); const c = xml.indexOf('</hp:subList>', i);
      if (c < 0) return xml;
      if (o >= 0 && o < c) { const e = xml.indexOf('>', o); if (e < 0) return xml; if (xml[e - 1] !== '/') depth++; i = e + 1; } else { depth--; i = c + '</hp:subList>'.length; }
    }
    out += `${xml.slice(at, openEnd + 1)}</hp:subList>`; at = i;
  }
  return out + xml.slice(at);
}

/** 도형 XML(본문 run 의 직접 자식 하나) → 비교 속성(shapePrint·shapeChange 가 쓴다). binKey = 그림 파일 id → 내용 열쇠(묶음 안 그림) */
export function shapeProps(xml, binKey = (v) => v) {
  const n = tree(withoutSubListBodies(xml));
  if (n && n.tag === 'hp:switch') {
    // [hwpx-cowork] 한/글 차트 <hp:switch><hp:case><hp:chart/></hp:case><hp:default><hp:ole/></hp:default></hp:switch>: 차트 요소로 보고,
    // 대체 OLE 는 지문(o)에만 더한다(편집기가 차트 값을 바꾸면 대체 OLE 내용도 바뀐다)
    const chart = switchChart(n);
    if (chart) {
      const out = nodeProps(chart, 0, binKey);
      // 대체 OLE 의 배치·크기는 차트와 같게 쓰이므로(rhwp 직렬화기·한/글) 내용(파일 열쇠)만 본다
      for (const c of n.children) {
        if (c.tag !== 'hp:default') continue;
        const ole = c.children.find((x) => x.tag === 'hp:ole');
        const ref = ole?.attrs.get('binaryItemIDRef');
        out.o.push(`hp:default(${ref ? binKey(ref) : ''})`);
      }
      return out;
    }
  }
  return n ? nodeProps(n, 0, binKey) : null;
}
/** [hwpx-cowork] hp:switch 나무의 hp:case 안 hp:chart(없으면 null) */
function switchChart(n) {
  for (const c of n.children) if (c.tag === 'hp:case') { const k = c.children.find((x) => x.tag === 'hp:chart'); if (k) return k; }
  return null;
}
/** [hwpx-cowork] 도형 XML 의 대표 여는 태그 — 한/글 차트 switch 면 안의 hp:chart 것 */
function headTag(xml) {
  if (xml.startsWith('<hp:switch')) { const m = /<hp:chart\b[^>]*>/.exec(xml); if (m) return m[0]; }
  return xml;
}
/** 비교 속성의 한 줄 지문(같으면 같은 도형) */
export function shapePrintText(props) { return props ? JSON.stringify([props.pos, props.o, props.g, props.k.map((k) => shapePrintText(k))]) : ''; }

/** 둘의 바뀐 곳 → { moved, resized, other } */
export function shapeChange(a, b) {
  const moved = a.pos !== b.pos;
  const resized = JSON.stringify(a.sz) !== JSON.stringify(b.sz);
  const strip = (p) => JSON.stringify([p.o.filter((x) => !x.startsWith('hp:sz(')), p.g, p.k.map((k) => shapePrintText(k))]);
  return { moved, resized, other: strip(a) !== strip(b) };
}

/** 개체 짝짓기 열쇠: 요소 이름 + 개체 번호(id — 편집기는 손대지 않은 도형의 id 를 그대로 쓴다) */
export function shapeKey(tag, xml) { return `${tag}#${(/^<[\w:]+\b[^>]*?\sid="([^"]*)"/.exec(headTag(xml)) || [])[1] ?? ''}`; }

function lcs(A, B) {
  const n = A.length; const m = B.length;
  if (!n || !m) return [];
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  return out;
}

/**
 * 두 문단의 도형 짝(T·S = [{ tag, key }], 문서 차례): 열쇠(이름+id) 차례 비교(LCS)로 짝짓고, 남은 것끼리 이름 차례 비교로 한 번 더 짝짓는다
 * (서버가 새로 매긴 id — 편집기 묶음은 id 0 — 와 편집기 쪽 id 가 달라도 같은 도형으로 본다). → { pairs: [[i, j]], removed: [i], added: [j] }
 */
export function pairShapes(T, S) {
  const pairs = lcs(T.map((x) => x.key), S.map((x) => x.key));
  const kt = new Set(pairs.map(([i]) => i)); const ks = new Set(pairs.map(([, j]) => j));
  const lt = T.map((_, i) => i).filter((i) => !kt.has(i)); const ls = S.map((_, j) => j).filter((j) => !ks.has(j));
  for (const [a, b] of lcs(lt.map((i) => T[i].tag), ls.map((j) => S[j].tag))) { pairs.push([lt[a], ls[b]]); kt.add(lt[a]); ks.add(ls[b]); }
  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, removed: T.map((_, i) => i).filter((i) => !kt.has(i)), added: S.map((_, j) => j).filter((j) => !ks.has(j)) };
}

/** 여는 태그의 속성 값을 바꾼다(원문 값 그대로 — 없는 속성은 닫는 > 앞에) */
function setRaw(open, values) {
  let out = open;
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`(\\s${k.replace(/[.:]/g, '\\$&')}=")[^"]*(")`);
    out = re.test(out) ? out.replace(re, `$1${v}$2`) : out.replace(/\s*(\/?)>$/, ` ${k}="${v}"$1>`);
  }
  return out;
}
/** 고칠 것 모으기: 여는 태그 속성(요소마다 하나로 합침)·요소 통째 바꾸기(그 안의 여는 태그 고치기는 버린다) */
function collector() {
  const opens = new Map(); const repl = [];
  return {
    attrs(node, vals) { if (!Object.keys(vals).length) return; opens.set(node, { ...(opens.get(node) || {}), ...vals }); },
    replace(node, insert) { repl.push({ start: node.start, end: node.end, insert }); },
    edits() {
      const out = [...repl];
      for (const [n, vals] of opens) if (!repl.some((r) => r.start <= n.start && n.end <= r.end)) out.push({ start: n.start, end: n.openEnd, insert: setRaw(n.open, vals) });
      return out;
    },
  };
}
/** t 의 여는 태그를 s 의 속성 값으로(비교하지 않는 속성 빼고) */
function attrEdit(t, s, depth, isOpen, ed) {
  const vals = {};
  for (const [k, v] of s.attrs) if (!skipAttr(k, isOpen ? depth : 0) && t.attrs.get(k) !== v) vals[k] = v;
  ed.attrs(t, vals);
}
function applyEdits(xml, edits) {
  let out = xml;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  return out;
}
/** 이름별 차례(같은 이름 k 번째)로 묶은 자식 */
function byTag(children) {
  const m = new Map();
  for (const c of children) { if (!m.has(c.tag)) m.set(c.tag, []); m.get(c.tag).push(c); }
  return m;
}
const sizeOf = (e) => [Number(e?.attrs.get('width')) || 0, Number(e?.attrs.get('height')) || 0];
/** 행렬 값 글: 한/글처럼 단정밀도로 줄여 소수 여섯째 자리까지(1.0869565… → 1.086957, 478.26087 → 478.260864) */
const fmt = (x) => String(Number(Math.fround(x).toFixed(6)));

/**
 * 같은 도형의 서버 XML(txml — 한/글 원본 차례·속성)을 편집기 XML(sxml) 값으로 고친다 → 고친 XML | null(요소 짜임이 달라 고칠 수 없음 —
 * 통째로 바꿀 것). 바꾸는 것: 여는 태그 속성(배치·글 감싸기·z 차례 등), 크기(sz)·배치(pos)·바깥 여백·뒤집기·회전 각·선·그림자·채우기·글상자
 * 여백 등, 꼭짓점 꼴이 다르면(끝점·꼭짓점을 고침) 로컬 좌표 묶음(offset·orgSz·curSz·회전 중심·행렬·꼭짓점)을 편집기 것으로. 꼴이 같은데
 * 크기가 바뀌었으면 꼭짓점은 그대로 두고 한/글처럼 크기를 따라가는 값을 셈한다(resized). mapFragment(xml) = 통째로 옮기는 조각(채우기 등)의
 * 그림 파일 번호 바꾸기
 */
export function patchShape(txml, sxml, mapFragment = (x) => x) {
  const T = tree(txml); const S = tree(sxml);
  if (!T || !S || T.tag !== S.tag) return null;
  // [hwpx-cowork] 차트(한/글 switch — 차트+대체 OLE, 맨 hp:chart)는 통째로 바꾼다: 편집기는 차트 부분을 문서 차례로 다시 매겨
  // 내보내므로(chartIDRef 가 서버 것과 다르다) 속성만 고치면 다른 차트의 부분을 가리킨다. 통째 바꾸기는 _importShapeParts 가 부분을 옮긴다
  if (T.tag === 'hp:switch' || T.tag === 'hp:chart') return null;
  const ed = collector();
  if (!patchNode(txml, sxml, T, S, 0, ed, mapFragment)) return null;
  return applyEdits(txml, ed.edits());
}

/** 글상자·캡션처럼 글 문단을 담은 요소: 문단 밖 요소들의 속성만 같은 자리끼리 맞춘다(짜임이 다르면 false) */
function patchAttrTree(t, s, ed) {
  attrEdit(t, s, 0, false, ed);
  const tc = t.children.filter((c) => c.tag !== 'hp:p'); const sc = s.children.filter((c) => c.tag !== 'hp:p');
  if (tc.length !== sc.length || tc.some((c, i) => c.tag !== sc[i].tag)) return false;
  return tc.every((c, i) => patchAttrTree(c, sc[i], ed));
}

/**
 * 크기를 바꾼 도형(꼭짓점 꼴은 그대로) — 한/글이 그린 뒤 저장하는 값(2026-10-30 실측, 개체 속성 크기 + PDF 저장 뒤 HWPX 저장):
 * curSz = 새 크기, 회전 중심 = 크기/2(묶음은 그대로), scaMatrix e1·e5 = 새 크기/orgSz(서로 지우던 이동 성분 e3·e6 은 0), 글상자 lastWidth = 새 폭·
 * 글상자 문단 줄 폭(horzsize)도 폭 차이만큼(여러 줄 문단은 줄 정보를 지워 다시 잰다), 묶음 안 개체는 묶음 배율로 curSz·회전 중심·scaMatrix
 * (e3·e6 = 묶음 안 자리 × (배율 - 1)). 꼭짓점(로컬 좌표)은 그대로. (그리지 않고 저장한 한/글은 curSz 0 이면 sz 만 바꾼다 — 두 꼴 모두 한/글이
 * 같게 그리지만, 편집기는 curSz 0 인 묶음의 자식을 늘이지 않아 이 꼴을 쓴다)
 */
function resized(T, TG, w, h, oldW, ed) {
  const one = (tag) => (TG.get(tag) || [])[0];
  const org = sizeOf(one('hp:orgSz'));
  const cur = one('hp:curSz');
  if (cur) ed.attrs(cur, { width: String(w), height: String(h) });
  const rot = one('hp:rotationInfo');
  if (rot && T.tag !== 'hp:container') ed.attrs(rot, { centerX: String(Math.round(w / 2)), centerY: String(Math.round(h / 2)) });
  const scale = matrixScale(one('hp:renderingInfo'), org[0] > 0 ? w / org[0] : 0, org[1] > 0 ? h / org[1] : 0, ed);
  // 글상자: 글 폭이 그림 폭을 따라가던 것이면(lastWidth = 옛 폭) 새 폭, 문단 줄 폭도 같이
  const dt = one('hp:drawText');
  if (dt && w !== oldW) {
    if (Number(dt.attrs.get('lastWidth')) === oldW) ed.attrs(dt, { lastWidth: String(w) });
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tag === 'hp:linesegarray') {
          const segs = c.children.filter((x) => x.tag === 'hp:lineseg');
          if (segs.length === 1) ed.attrs(segs[0], { horzsize: String(Math.max(0, (Number(segs[0].attrs.get('horzsize')) || 0) + w - oldW)) });
          else if (segs.length > 1) ed.replace(c, '');
        } else if (c.tag !== 'hp:tbl') walk(c);
      }
    };
    walk(dt);
  }
  // 묶음 안 개체(묶음이 아닌 것): 묶음 배율로
  if (T.tag === 'hp:container' && scale) {
    const [sx, sy] = scale;
    for (const c of T.children) {
      if (!CHILD_TAGS.has(c.tag) || c.tag === 'hp:container') continue;
      const G = byTag(c.children);
      const corg = sizeOf((G.get('hp:orgSz') || [])[0]);
      const off = (G.get('hp:offset') || [])[0];
      const [ox, oy] = [Number(off?.attrs.get('x')) | 0, Number(off?.attrs.get('y')) | 0];
      if (!(corg[0] > 0 && corg[1] > 0)) continue;
      const cw = corg[0] * sx; const ch = corg[1] * sy;
      const ccur = (G.get('hp:curSz') || [])[0];
      if (ccur) ed.attrs(ccur, { width: String(Math.floor(cw)), height: String(Math.floor(ch)) });
      const crot = (G.get('hp:rotationInfo') || [])[0];
      if (crot) ed.attrs(crot, { centerX: String(Math.round(cw / 2)), centerY: String(Math.round(ch / 2)) });
      const sm = (G.get('hp:renderingInfo') || [])[0]?.children.find((x) => x.tag === 'hc:scaMatrix');
      if (sm) ed.attrs(sm, { e1: fmt(sx), e3: fmt(ox * (sx - 1)), e5: fmt(sy), e6: fmt(oy * (sy - 1)) });
    }
  }
}
/** renderingInfo 의 scaMatrix e1·e5 를 배율로(이동 성분이 transMatrix 와 서로 지우던 것이면 둘 다 0) → [sx, sy] | null */
function matrixScale(ri, sx, sy, ed) {
  const tm = ri?.children.find((c) => c.tag === 'hc:transMatrix'); const sm = ri?.children.find((c) => c.tag === 'hc:scaMatrix');
  if (!sm || !(sx > 0 && sy > 0)) return null;
  const sv = { e1: fmt(sx), e5: fmt(sy) }; const tv = {};
  for (const k of ['e3', 'e6']) if (tm && Number(tm.attrs.get(k)) !== 0 && Number(tm.attrs.get(k)) === -Number(sm.attrs.get(k))) { tv[k] = '0'; sv[k] = '0'; }
  ed.attrs(sm, sv);
  if (tm) ed.attrs(tm, tv);
  return [sx, sy];
}

function patchNode(tx, sx, T, S, depth, ed, mapFragment) {
  attrEdit(T, S, depth, true, ed);
  // 묶음 안 개체: 같은 차례·이름이어야 한다(아니면 통째로)
  const isKid = (c) => T.tag === 'hp:container' && CHILD_TAGS.has(c.tag);
  const tk = T.children.filter(isKid); const sk = S.children.filter(isKid);
  if (T.tag === 'hp:container' && (tk.length !== sk.length || tk.some((c, i) => c.tag !== sk[i].tag))) return false;
  if (T.tag === 'hp:container' && T.children.some((c) => /^hp:/.test(c.tag) && !isKid(c) && !['hp:offset', 'hp:orgSz', 'hp:curSz', 'hp:flip', 'hp:rotationInfo', 'hp:renderingInfo', 'hp:sz', 'hp:pos', 'hp:outMargin', 'hp:caption', 'hp:shapeComment'].includes(c.tag))) return false;
  for (let i = 0; i < tk.length; i++) if (!patchNode(tx, sx, tk[i], sk[i], depth + 1, ed, mapFragment)) return false;
  const tp = pointNodes(T); const spn = pointNodes(S);
  const TG = byTag(T.children.filter((c) => !isKid(c))); const SG = byTag(S.children.filter((c) => !isKid(c)));
  const one = (G, tag) => (G.get(tag) || [])[0];
  const replaceEl = (t, s) => { const sx2 = sx.slice(s.start, s.end); if (tx.slice(t.start, t.end) !== sx2) ed.replace(t, mapFragment(sx2)); };
  if (geoPrint(T) !== geoPrint(S)) {
    // 로컬 좌표: 꼭짓점 꼴이 다르면(끝점·꼭짓점을 고침) 편집기 것으로(꼭짓점 요소 차례가 같아야 한다)
    if (tp.length !== spn.length || tp.some((c, i) => c.tag !== spn[i].tag)) return false;
    tp.forEach((c, i) => replaceEl(c, spn[i]));
    for (const tag of ['hp:offset', 'hp:orgSz', 'hp:curSz', 'hp:rotationInfo', 'hp:renderingInfo']) {
      const t = one(TG, tag); const s = one(SG, tag);
      if (t && s) replaceEl(t, s); else if (!!t !== !!s) return false;
    }
  } else if (depth === 0) {
    const tsz = one(TG, 'hp:sz'); const ssz = one(SG, 'hp:sz');
    const [w, h] = sizeOf(ssz); const [ow, oh] = sizeOf(tsz);
    if (tsz && ssz && (w !== ow || h !== oh) && w > 0 && h > 0) resized(T, TG, w, h, ow, ed);
  }
  // 나머지 요소: 같은 이름·차례끼리 속성을 맞춘다. 짜임이 다른 채우기 등은 통째로, 한쪽에만 있으면 고칠 수 없다(통째로)
  for (const [tag, ts] of TG) {
    if (SKIP_SUBTREE.has(tag) || POINT_TAGS.has(tag) || ['hp:offset', 'hp:orgSz', 'hp:curSz', 'hp:renderingInfo'].includes(tag)) continue;
    if (depth > 0 && CHILD_BOX.has(tag)) continue;
    const ss = SG.get(tag) || [];
    if (ts.length !== ss.length) return false;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; const s = ss[i];
      if (flat(t, (v) => v) === flat(s, (v) => v)) continue;
      if (!t.children.length && !s.children.length) { attrEdit(t, s, 0, false, ed); continue; }
      if (t.children.some((c) => c.tag === 'hp:subList') || tag === 'hp:caption' || tag === 'hp:drawText') {
        if (!patchAttrTree(t, s, ed)) return false;
        continue;
      }
      replaceEl(t, s);
    }
  }
  for (const tag of SG.keys()) {
    if (TG.has(tag) || SKIP_SUBTREE.has(tag) || POINT_TAGS.has(tag)) continue;
    if (depth > 0 && CHILD_BOX.has(tag)) continue;
    if (['hp:offset', 'hp:orgSz', 'hp:curSz', 'hp:renderingInfo', 'hp:shadow'].includes(tag)) continue;   // 편집기가 더해 쓰는 것
    return false;
  }
  return true;
}

/** 도형 XML 의 여는 태그 속성 하나 */
export function shapeAttr(xml, k) { return (new RegExp(`^<[\\w:]+\\b[^>]*?\\s${k}="([^"]*)"`).exec(xml) || [])[1] ?? null; }
/** 글자처럼 취급하거나 글을 밀어내는(글 앞·뒤가 아닌) 도형 — 넣고 빼거나 옮기면 그 문단 줄 정보가 낡는다 */
export function shapeFlowsText(xml) {
  const pos = /<hp:pos\b[^>]*>/.exec(xml.slice(0, xml.lastIndexOf('<hp:pos') >= 0 ? xml.length : 0))?.[0] || '';
  if (/\streatAsChar="1"/.test(pos)) return true;
  const wrap = shapeAttr(headTag(xml), 'textWrap');
  return wrap != null && wrap !== 'IN_FRONT_OF_TEXT' && wrap !== 'BEHIND_TEXT';
}
