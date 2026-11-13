// 개체 배치 조합표 시험지 — layout-combos.mjs 가 센 조합을 순번 목록으로 정리하고, 조합마다 한 쪽씩 시험지를 만든다.
// 놓인 자리(본문·다단·표 셀·글상자·머리말·꼬리말·각주·미주·묶음 안·바탕쪽)마다 파일 하나, 조합 하나 = 쪽 하나.
// 문단에는 저장 줄(linesegarray)을 넣지 않는다(layout-probe.mjs 와 같은 경로 — 엔진이 직접 조판).
//
//   node scripts/layout-combos.mjs --corpus real=data,... --corpus rhwp=<rhwp samples> --out tests/fixtures/layout/matrix/combos_counts.json
//   node scripts/layout-matrix.mjs [--counts <json>] [--out-dir tests/fixtures/layout/matrix] [--md docs/LAYOUT_MATRIX.md]
//
// 결과: matrix_list.json(순번·조합·건수·시험지 파일/쪽), matrix_<자리>.hwpx, --md 를 주면 사람이 읽는 목록.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.join(root, 'tests', 'fixtures', 'layout', 'matrix');

// ── 서식 번호(기본 서식 testdata/매크로테스트용_저장.hwpx — layout-probe.mjs 와 같다) ──
const PARA_PLAIN = 28;
const PARA_CAPTION = 18;
const CHAR_BODY = 8;
const CHAR_CAPTION = 1;
const BORDER = 19;      // 테두리 없음 — 바깥 틀(표 셀 자리의 1×1 표)
const BORDER_MARK = 20; // 테두리 없음 + 칸 채움 TABLE_MARK — 시험 표(한/글 쪽 그림에서 표 상자를 찾는 표식). header.xml 에 덧붙인다

const KIND_KO = { tbl: '표', pic: '그림', textbox: '글상자', rect: '사각형', ellipse: '타원', arc: '호', polygon: '다각형', curve: '곡선', connectLine: '연결선', line: '선', ole: 'OLE', chart: '차트', equation: '수식', container: '묶음', textart: '글맵시', video: '동영상', form: '양식 개체' };
const CTX_KO = { body: '본문', column: '다단 본문', cell: '표 셀', textbox: '글상자 안', header: '머리말', footer: '꼬리말', footNote: '각주', endNote: '미주', master: '바탕쪽', group: '묶음 안', caption: '캡션 안' };
const DIM_ORDER = ['자리', '글자처럼', '가로', '세로', '배치', '이동·겹침', '표 나눔'];
// 시험지를 만드는 자리·개체. 나머지는 이유와 함께 목록에만 남긴다.
const GEN_CTX = ['body', 'column', 'cell', 'textbox', 'header', 'footer', 'footNote', 'endNote', 'group', 'master'];
const GEN_KIND = ['tbl', 'pic', 'textbox', 'rect', 'ellipse', 'line', 'polygon', 'equation', 'container'];
const SKIP_KIND = { ole: 'OLE 원본 자료가 있어야 함', chart: '차트 자료(Chart XML)가 있어야 함', form: '양식 개체 — 조판보다 입력 개체', textart: '글맵시 미구현', video: '동영상 미구현', arc: '호 미구현(드묾)', curve: '곡선 미구현(드묾)', connectLine: '연결선 미구현(드묾)' };

let uid = 1950000000;
const nextId = () => String(uid++);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FILL = '조합 시험 문장입니다. 개체 둘레로 글이 어떻게 비키는지 본다. ';
const LONG = (n) => FILL.repeat(n).trim();
const SUB = (inner, vertAlign = 'TOP') => `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${vertAlign}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>`;
const para = ({ pageBreak = false, runs = [], paraPr = PARA_PLAIN, id = nextId() } = {}) => `<hp:p id="${id}" paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${runs.length ? runs.join('') : `<hp:run charPrIDRef="${CHAR_BODY}"/>`}</hp:p>`;
const textRun = (t, charPr = CHAR_BODY) => `<hp:run charPrIDRef="${charPr}"><hp:t>${esc(t)}</hp:t></hp:run>`;
const text = (t, o = {}) => para({ ...o, runs: [textRun(t)] });
const objRun = (xml, tail = '') => `<hp:run charPrIDRef="${CHAR_BODY}">${xml}<hp:t>${esc(tail)}</hp:t></hp:run>`;
const MAT = '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>';
const LINE = (color = '#1F4E9E') => `<hp:lineShape color="${color}" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>`;
const FILLB = (c) => `<hc:fillBrush><hc:winBrush faceColor="${c}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`;
const SHADOW = '<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>';

// ── 조합 열쇠 → 개체 설정 ─────────────────────────────────────────────
const OFF = { h: { '0': 0, '+': 4000, '-': -1500 }, v: { '0': 0, '+': 2000, '-': -1000 } };
const MARGIN = { '0': [0, 0, 0, 0], '있음': [283, 283, 283, 283] };
/** item.base: 그 자리·개체에서 가장 흔한 전체 조합(떠있는 개체) — 한 속성만 바꾸고 나머지는 실제 문서처럼 둔다. */
function specOf(item) {
  const s = { tac: false, wrap: 'TOP_AND_BOTTOM', flow: 'BOTH_SIDES', vertRelTo: 'PARA', vertAlign: 'TOP', vOff: 0, horzRelTo: 'COLUMN', horzAlign: 'LEFT', hOff: 0, margin: MARGIN['0'], caption: null, flowWithText: 1, overlap: 0, pageBreak: 'CELL', child: false };
  const b = item.base;
  const tac = (item.dim === '자리' && item.attrs.mode === '글자처럼') || item.dim === '글자처럼';
  if (b && !tac) Object.assign(s, { wrap: b.wrap, flow: b.flow, vertRelTo: b.vertRelTo, vertAlign: b.vertAlign, vOff: OFF.v[b.vOff], horzRelTo: b.horzRelTo, horzAlign: b.horzAlign, hOff: OFF.h[b.hOff], margin: MARGIN[b.margin], flowWithText: Number(b.flowWithText), overlap: Number(b.overlap), pageBreak: b.pageBreak === '-' ? 'CELL' : b.pageBreak });
  const a = item.attrs;
  switch (item.dim) {
    case '자리': if (a.mode === '글자처럼') s.tac = true; else if (a.mode === '위치없음') s.child = true; break;
    case '글자처럼': s.tac = true; s.margin = MARGIN[a.margin]; s.caption = a.caption === '없음' ? null : a.caption; break;
    case '가로': Object.assign(s, { horzRelTo: a.relTo, horzAlign: a.align, hOff: OFF.h[a.off], margin: MARGIN[a.margin] }); break;
    case '세로': Object.assign(s, { vertRelTo: a.relTo, vertAlign: a.align, vOff: OFF.v[a.off], margin: MARGIN[a.margin] }); break;
    case '배치': s.wrap = a.wrap; if (a.flow !== '-') s.flow = a.flow; if (a.wrap === 'BEHIND_TEXT' || a.wrap === 'IN_FRONT_OF_TEXT') s.overlap = 1; break;
    case '이동·겹침': s.flowWithText = Number(a.flowWithText); s.overlap = Number(a.overlap); break;
    case '표 나눔': s.pageBreak = a.pageBreak; s.wrap = a.wrap; break;
  }
  if (s.tac) { s.overlap = 1; s.vertRelTo = 'PARA'; s.horzRelTo = 'PARA'; }
  return s;
}

function parseKey(id) {
  const [dim, rest] = id.split('§');
  const [ctx, kind, ...p] = rest.split('|');
  const strip = (v, pre) => v.replace(pre, '');
  let attrs = {};
  if (dim === '자리') attrs = { mode: p[0] };
  else if (dim === '글자처럼') attrs = { margin: strip(p[0], '여백'), caption: strip(p[1], '캡션') };
  else if (dim === '가로' || dim === '세로') attrs = { relTo: p[0], align: p[1], off: strip(p[2], '오프셋'), margin: strip(p[3], '여백') };
  else if (dim === '배치') attrs = { wrap: p[0], flow: p[1] };
  else if (dim === '이동·겹침') attrs = { flowWithText: strip(p[0], '글과이동'), overlap: strip(p[1], '겹침') };
  else if (dim === '표 나눔') attrs = { pageBreak: p[0], wrap: p[1] };
  return { dim, ctx, kind, attrs, rest: p.join(' · ') };
}

// ── 개체 XML ─────────────────────────────────────────────────────────
function caption(side, label, width) {
  return `<hp:caption side="${side}" fullSz="0" width="8503" gap="850" lastWidth="${width}">${SUB(`<hp:p id="0" paraPrIDRef="${PARA_CAPTION}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${textRun(label, CHAR_CAPTION)}</hp:p>`)}</hp:caption>`;
}
const posXml = (s) => `<hp:pos treatAsChar="${s.tac ? 1 : 0}" affectLSpacing="0" flowWithText="${s.flowWithText}" allowOverlap="${s.overlap}" holdAnchorAndSO="0" vertRelTo="${s.vertRelTo}" horzRelTo="${s.horzRelTo}" vertAlign="${s.vertAlign}" horzAlign="${s.horzAlign}" vertOffset="${s.vOff}" horzOffset="${s.hOff}"/>`;
const tailXml = (s, w, h) => s.child ? '' : `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>${posXml(s)}<hp:outMargin left="${s.margin[0]}" right="${s.margin[1]}" top="${s.margin[2]}" bottom="${s.margin[3]}"/>`
  + (s.caption ? caption(s.caption, '[캡션] 시험 개체', w) : '');
/** 도형 공통 머리(offset·크기·회전·변환). child 면 묶음 안 좌표(x,y). */
function shapeHead(tag, s, w, h, extra = '', { x = 0, y = 0, num = 'PICTURE' } = {}) {
  const cur = s.child ? 'width="0" height="0"' : `width="${w}" height="${h}"`;
  return `<hp:${tag} id="${s.child ? 0 : nextId()}" zOrder="${s.child ? 0 : uid % 50}" numberingType="${s.child ? 'NONE' : num}" textWrap="${s.wrap}" textFlow="${s.flow}" lock="0" dropcapstyle="None" href="" groupLevel="${s.child ? 1 : 0}" instid="${nextId()}"${extra}>`
    + `<hp:offset x="${x}" y="${y}"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz ${cur}/><hp:flip horizontal="0" vertical="0"/>`
    + `<hp:rotationInfo angle="0" centerX="${w >> 1}" centerY="${h >> 1}" rotateimage="1"/><hp:renderingInfo>${MAT.replace('e3="0"', `e3="${x}"`).replace('e6="0"', `e6="${y}"`)}</hp:renderingInfo>`;
}
const KIND = {
  pic: (s, w, h, o) => shapeHead('pic', s, w, h, ' reverse="0"', o)
    + `<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
    + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${w}" dimheight="${h}"/><hp:effects/>${tailXml(s, w, h)}</hp:pic>`,
  rect: (s, w, h, o, textbox = false) => shapeHead('rect', s, w, h, ' ratio="0"', o) + LINE() + FILLB(textbox ? '#FFF7D6' : '#D6E6FF') + SHADOW
    + (textbox ? `<hp:drawText lastWidth="${w - 566}" name="" editable="0">${SUB(text('글상자 안 글. ' + LONG(1)))}<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>` : '')
    + `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/>${tailXml(s, w, h)}</hp:rect>`,
  textbox: (s, w, h, o) => KIND.rect(s, w, h, o, true),
  ellipse: (s, w, h, o) => shapeHead('ellipse', s, w, h, ' intervalDirty="0" hasArcPr="0" arcType="NORMAL"', o) + LINE() + FILLB('#E3F5DA') + SHADOW
    + `<hc:center x="${w >> 1}" y="${h >> 1}"/><hc:ax1 x="${w}" y="${h >> 1}"/><hc:ax2 x="${w >> 1}" y="0"/><hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/><hc:start2 x="0" y="0"/><hc:end2 x="0" y="0"/>${tailXml(s, w, h)}</hp:ellipse>`,
  line: (s, w, h, o) => shapeHead('line', s, w, h, ' isReverseHV="0"', o) + LINE('#C00000') + SHADOW + `<hc:startPt x="0" y="0"/><hc:endPt x="${w}" y="${h}"/>${tailXml(s, w, h)}</hp:line>`,
  polygon: (s, w, h, o) => shapeHead('polygon', s, w, h, '', o) + LINE() + FILLB('#F5DADA') + SHADOW
    + `<hc:pt x="${w >> 1}" y="0"/><hc:pt x="${w}" y="${h}"/><hc:pt x="0" y="${h}"/><hc:pt x="${w >> 1}" y="0"/>${tailXml(s, w, h)}</hp:polygon>`,
  equation: (s, w, h) => `<hp:equation id="${nextId()}" zOrder="${uid % 50}" numberingType="EQUATION" textWrap="${s.wrap}" textFlow="${s.flow}" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="86" textColor="#000000" baseUnit="1100" lineMode="CHAR" font="HYhwpEQ">`
    + `${tailXml(s, w, h)}<hp:script>{a+b} over {c}</hp:script></hp:equation>`,
  tbl: (s, w, h) => {
    const cw = w >> 1, rh = h >> 1;
    const cell = (r, c) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${BORDER_MARK}">${SUB(text(`칸 ${r}-${c}`, { id: '0' }), 'CENTER')}`
      + `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cw}" height="${rh}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`;
    const cap = s.caption ? caption(s.caption, '[캡션] 시험 표', w) : '';
    return `<hp:tbl id="${nextId()}" zOrder="${uid % 50}" numberingType="TABLE" textWrap="${s.wrap}" textFlow="${s.flow}" lock="0" dropcapstyle="None" pageBreak="${s.pageBreak}" repeatHeader="1" rowCnt="2" colCnt="2" cellSpacing="0" borderFillIDRef="${BORDER_MARK}" noAdjust="0">`
      + tailXml({ ...s, caption: null }, w, h) + cap + `<hp:inMargin left="141" right="141" top="141" bottom="141"/><hp:tr>${cell(0, 0)}${cell(0, 1)}</hp:tr><hp:tr>${cell(1, 0)}${cell(1, 1)}</hp:tr></hp:tbl>`;
  },
  // 묶음: 그림 + 사각형 두 개를 묶는다.
  container: (s, w, h) => {
    const c = { ...s, child: true, caption: null };
    return shapeHead('container', s, w, h)
      + KIND.pic(c, w >> 1, h >> 1, { x: 0, y: 0 }) + KIND.rect(c, w >> 1, h >> 1, { x: w >> 1, y: h >> 1 })
      + tailXml(s, w, h) + '</hp:container>';
  },
};
/** 자리별 개체 크기 */
const SIZE = { body: [12000, 6000], column: [9000, 5000], cell: [10000, 5000], textbox: [10000, 5000], header: [8000, 2000], footer: [8000, 2000], footNote: [8000, 3000], endNote: [8000, 3000], master: [12000, 6000], group: [12000, 6000] };

// 독립 회귀 자료 생성기도 같은 HWPX 개체 문법을 쓴다. 기존 조합표의 실행·자료는 바꾸지 않는다.
export const layoutFixture = { KIND, specOf, para, text, textRun, objRun, SUB, shapeHead, tailXml, SIZE };

/** 사례 하나 → 문단들(section 본문). master 는 { masterInner, paras }. */
function caseParas(item) {
  const s = specOf(item);
  const [w, h] = SIZE[item.ctx];
  const head = `[${item.no}] ${CTX_KO[item.ctx]} × ${KIND_KO[item.kind]} — ${item.dim}: ${item.label}`;
  const build = () => item.ctx === 'group'
    // 묶음 안 개체: 시험 개체(묶음 안 좌표 0,0) + 기준 사각형을 묶은 묶음 하나(자리차지·문단 기준).
    ? shapeHead('container', { ...specOf({ dim: '자리', attrs: { mode: '떠있음' } }) }, w * 2, h * 2)
      + KIND[item.kind]({ ...s, child: true, caption: null }, w, h, { x: 0, y: 0 }) + KIND.rect({ ...s, child: true, caption: null }, w, h, { x: w, y: h })
      + tailXml(specOf({ dim: '자리', attrs: { mode: '떠있음' } }), w * 2, h * 2) + '</hp:container>'
    : KIND[item.kind](s, w, h);
  const anchor = (extra = '') => para({ runs: [objRun(build(), extra || ' 앵커 문단 글. ' + LONG(2))] });
  const filler = (n) => Array.from({ length: n }, (_, i) => text(`뒤따르는 글 ${i + 1}. ${LONG(2)}`));
  const headPara = (ctrl = '') => para({ pageBreak: true, runs: [`<hp:run charPrIDRef="${CHAR_BODY}">${ctrl}<hp:t>${esc(head)}</hp:t></hp:run>`] });
  switch (item.ctx) {
    case 'body': case 'column': case 'group':
      return { paras: [headPara(), anchor(), ...filler(item.ctx === 'column' ? 6 : 4)] };
    case 'cell': {
      const inner = anchor() + filler(2).join('');
      const tc = `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${BORDER}">${SUB(inner)}<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="42000" height="24000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
      const host = `<hp:tbl id="${nextId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="${BORDER}" noAdjust="0">`
        + `<hp:sz width="42000" widthRelTo="ABSOLUTE" height="24000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
        + `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/><hp:tr>${tc}</hp:tr></hp:tbl>`;
      return { paras: [headPara(), para({ runs: [objRun(host)] }), ...filler(2)] };
    }
    case 'textbox': {
      const inner = anchor() + filler(2).join('');
      const box = shapeHead('rect', specOf({ dim: '자리', attrs: { mode: '떠있음' } }), 42520, 24000, ' ratio="0"') + LINE('#000000') + SHADOW
        + `<hp:drawText lastWidth="41954" name="" editable="0">${SUB(inner)}<hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>`
        + `<hc:pt0 x="0" y="0"/><hc:pt1 x="42520" y="0"/><hc:pt2 x="42520" y="24000"/><hc:pt3 x="0" y="24000"/>`
        + tailXml(specOf({ dim: '자리', attrs: { mode: '떠있음' } }), 42520, 24000) + '</hp:rect>';
      return { paras: [headPara(), para({ runs: [objRun(box)] }), ...filler(2)] };
    }
    case 'header': case 'footer': {
      const ctrl = `<hp:ctrl><hp:${item.ctx} id="${nextId()}" applyPageType="BOTH">${SUB(anchor(' 머리·꼬리 글.'))}</hp:${item.ctx}></hp:ctrl>`;
      return { paras: [headPara(ctrl), ...filler(4)] };
    }
    case 'footNote': case 'endNote': {
      const numType = item.ctx === 'footNote' ? 'FOOTNOTE' : 'ENDNOTE';
      const note = `<hp:ctrl><hp:${item.ctx} number="1" suffixChar="41" instId="${nextId()}">`
        + SUB(para({ runs: [`<hp:run charPrIDRef="${CHAR_BODY}"><hp:ctrl><hp:autoNum num="1" numType="${numType}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl><hp:t> [${item.no}] 주석 글.</hp:t></hp:run>`] }) + anchor(' 주석 안 앵커 글.'))
        + `</hp:${item.ctx}></hp:ctrl>`;
      return { paras: [headPara(), para({ runs: [`<hp:run charPrIDRef="${CHAR_BODY}"><hp:t>주석이 달린 문단.</hp:t>${note}<hp:t> ${LONG(1)}</hp:t></hp:run>`] }), ...filler(2)] };
    }
    case 'master':
      return { masterInner: para({ runs: [objRun(build(), '')] }), paras: [text(head), ...filler(6)] };
  }
  throw new Error(`자리 미지원 ${item.ctx}`);
}

// ── 목록 ─────────────────────────────────────────────────────────────
export function buildList(counts) {
  const ids = new Set(Object.values(counts).flatMap((c) => Object.keys(c.combos)));
  const corpora = Object.keys(counts);
  const all = [...ids].map((id) => {
    const by = Object.fromEntries(corpora.map((c) => [c, counts[c].combos[id] ? { docs: counts[c].combos[id].docs, objs: counts[c].combos[id].objs, ex: counts[c].combos[id].ex, docList: counts[c].combos[id].docList } : { docs: 0, objs: 0 }]));
    return { id, by };
  });
  const score = (x) => corpora.map((c) => x.by[c].docs);
  const cmp = (a, b) => { const sa = score(a), sb = score(b); for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i]; return 0; };
  // 자리·개체마다 가장 흔한 전체 조합 → 시험 사례의 기본값
  const bases = new Map();
  for (const x of all.filter((x) => x.id.startsWith('전체§')).sort((a, b) => cmp(a, b) || a.id.localeCompare(b.id))) {
    const [ctx, kind, wrap, flow, vertRelTo, vertAlign, vOff, horzRelTo, horzAlign, hOff, margin, flowWithText, overlap, pageBreak] = x.id.slice(3).split('|');
    if (!bases.has(`${ctx}|${kind}`)) bases.set(`${ctx}|${kind}`, { wrap, flow, vertRelTo, vertAlign, vOff, horzRelTo, horzAlign, hOff, margin, flowWithText, overlap, pageBreak, id: x.id });
  }
  const items = all.filter((x) => !x.id.startsWith('전체§')).map((x) => {
    const k = parseKey(x.id);
    return { ...x, ...k, label: k.rest, base: bases.get(`${k.ctx}|${k.kind}`) || null };
  });
  // 묶음(자리 × 개체): 그 묶음의 '자리' 항목 건수 합으로 순서를 정한다.
  const groups = new Map();
  for (const it of items) { const g = `${it.ctx}|${it.kind}`; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
  const gScore = (list) => corpora.map((c) => list.filter((x) => x.dim === '자리').reduce((a, x) => a + x.by[c].docs, 0));
  const ordered = [...groups.entries()].sort((a, b) => { const sa = gScore(a[1]), sb = gScore(b[1]); for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i]; return a[0].localeCompare(b[0]); });
  let no = 0;
  const out = [];
  ordered.forEach(([g, list], gi) => {
    list.sort((a, b) => DIM_ORDER.indexOf(a.dim) - DIM_ORDER.indexOf(b.dim) || cmp(a, b) || a.id.localeCompare(b.id));
    for (const it of list) {
      no++;
      const skip = SKIP_KIND[it.kind] ? SKIP_KIND[it.kind]
        : !GEN_CTX.includes(it.ctx) ? `${CTX_KO[it.ctx] || it.ctx} 자리 미구현(드묾)`
        : !GEN_KIND.includes(it.kind) ? `${KIND_KO[it.kind] || it.kind} 미구현`
        : it.ctx === 'group' && it.kind === 'tbl' ? '표는 묶을 수 없음'
        : it.ctx === 'group' && it.dim !== '자리' ? '묶음 안 개체는 위치 속성 대신 묶음 안 좌표를 씀(자리 항목만 만듦)'
        : it.ctx === 'group' && it.attrs.mode !== '위치없음' ? '묶음 안 개체의 자체 위치(드묾) 미구현'
        : it.dim === '글자처럼' && it.kind !== 'tbl' && it.kind !== 'pic' && it.attrs.caption !== '없음' ? '캡션은 표·그림만 만듦'
        : null;
      out.push({ no: String(no).padStart(4, '0'), group: gi + 1, groupKey: g, dim: it.dim, ctx: it.ctx, kind: it.kind, attrs: it.attrs, label: it.label, id: it.id, by: it.by, base: it.base, skip });
    }
  });
  return out;
}

// ── 문서 만들기 ─────────────────────────────────────────────────────
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 80 + (x * 150) / w; raw[o + 1] = 120 + (y * 100) / h; raw[o + 2] = 200; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 자리 하나의 사례들 → HWPX. 바탕쪽은 사례마다 구역 하나(구역마다 바탕쪽 하나). */
async function buildDoc(templatePath, outPath, ctx, items) {
  const zin = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const section = await zin.file('Contents/section0.xml').async('string');
  const start = section.indexOf('<hp:p ');
  const secEnd = section.indexOf('</hp:secPr>');
  const colEnd = section.indexOf('</hp:ctrl>', secEnd) + '</hp:ctrl>'.length;
  const head = section.slice(0, start);
  let first = section.slice(start, colEnd).replace(/paraPrIDRef="\d+"/, `paraPrIDRef="${PARA_PLAIN}"`);
  if (ctx === 'column') first = first.replace(/colCount="\d+"/, 'colCount="2"').replace(/sameGap="\d+"/, 'sameGap="1134"');
  const firstPara = (title, master) => (master ? first.replace(/masterPageCnt="\d+"/, 'masterPageCnt="1"').replace('</hp:secPr>', `<hp:masterPage idRef="${master}"/></hp:secPr>`) : first)
    + `</hp:run>${textRun(title)}</hp:p>`;
  const files = new Map(); // name → string
  const title = `개체 배치 조합 시험지 — ${CTX_KO[ctx]} (${items.length}쪽, 사례마다 새 쪽)`;
  const pages = [];
  if (ctx !== 'master') {
    const body = [];
    items.forEach((it, i) => { body.push(...caseParas(it).paras); pages.push({ no: it.no, page: i + 2 }); });
    files.set('Contents/section0.xml', head + firstPara(title) + body.join('') + '</hs:sec>');
  } else {
    const mHead = (await zin.file('Contents/header.xml').async('string')).match(/^<\?xml[^>]*>/)[0];
    const ns = head.match(/<hs:sec ([^>]*)>/)[1];
    items.forEach((it, i) => {
      const c = caseParas(it);
      const mid = `masterpage${i}`;
      files.set(`Contents/${mid}.xml`, `${mHead}<masterPage ${ns} id="${mid}" type="BOTH" pageNumber="0" pageDuplicate="0" pageFront="0">${SUB(c.masterInner).replace('textWidth="0" textHeight="0"', 'textWidth="42520" textHeight="65762"')}</masterPage>`);
      files.set(`Contents/section${i}.xml`, head + firstPara(i === 0 ? title : `[${it.no}] 구역 시작`, mid) + c.paras.join('') + '</hs:sec>');
      pages.push({ no: it.no, page: i + 1, section: i });
    });
  }
  const out = new JSZip();
  out.file('mimetype', await zin.file('mimetype').async('uint8array'), { compression: 'STORE' });
  for (const [name, f] of Object.entries(zin.files)) {
    if (f.dir || name === 'mimetype' || /^Preview\//.test(name) || /^Contents\/(section|masterpage)\d+\.xml$/.test(name)) continue;
    let data = await f.async(/\.(xml|hpf)$/.test(name) ? 'string' : 'uint8array');
    if (/^BinData\/image\d+\.png$/.test(name)) data = png(60, 30);
    if (name === 'Contents/header.xml') {
      if (ctx === 'master') data = data.replace(/secCnt="\d+"/, `secCnt="${items.length}"`);
      if (data.includes(`<hh:borderFill id="${BORDER_MARK}"`)) throw new Error(`기본 서식에 이미 테두리 ${BORDER_MARK} 가 있다 — BORDER_MARK 를 바꾼다`);
      const none = (side) => `<hh:${side}Border type="NONE" width="0.12 mm" color="#000000"/>`;
      data = data.replace('</hh:borderFills>', `<hh:borderFill id="${BORDER_MARK}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`
        + `${none('left')}${none('right')}${none('top')}${none('bottom')}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="${TABLE_MARK}" hatchColor="#000000" alpha="0"/></hc:fillBrush></hh:borderFill></hh:borderFills>`)
        .replace(/<hh:borderFills itemCnt="(\d+)"/, (m, n) => `<hh:borderFills itemCnt="${Number(n) + 1}"`);
    }
    if (name === 'Contents/content.hpf') {
      // 바탕쪽은 제 구역 바로 앞에 둔다(한/글 저장 순서 — rhwp 도 이 순서로 바탕쪽을 구역에 붙인다).
      const sec = [...files.keys()].filter((n) => /section\d+/.test(n));
      data = data.replace(/<opf:item id="(section|masterpage)\d+"[^>]*\/>/g, '').replace(/<opf:itemref idref="(section|masterpage)\d+"[^>]*\/>/g, '')
        .replace('</opf:manifest>', [...files.keys()].map((n) => `<opf:item id="${path.basename(n, '.xml')}" href="${n}" media-type="application/xml"/>`).join('') + '</opf:manifest>')
        .replace(/(<opf:itemref idref="header"[^>]*\/>)/, `$1${sec.map((n) => `<opf:itemref idref="${path.basename(n, '.xml')}" linear="yes"/>`).join('')}`);
    }
    out.file(name, data);
  }
  for (const [name, xml] of files) out.file(name, xml);
  fs.writeFileSync(outPath, await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return pages;
}

const CTX_FILE = { body: 'body', column: 'column', cell: 'cell', textbox: 'textbox', header: 'header', footer: 'footer', footNote: 'footnote', endNote: 'endnote', group: 'group', master: 'master' };

export async function buildMatrix({ counts, template, outDir }) {
  const list = buildList(counts);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const ctx of GEN_CTX) {
    const items = list.filter((x) => !x.skip && x.ctx === ctx);
    if (!items.length) continue;
    const file = `matrix_${CTX_FILE[ctx]}.hwpx`;
    const pages = await buildDoc(template, path.join(outDir, file), ctx, items);
    for (const p of pages) Object.assign(list.find((x) => x.no === p.no), { file, page: p.page, ...(p.section != null ? { section: p.section } : {}) });
    files.push({ file, ctx, cases: items.length });
  }
  return { list, files };
}

// ── 사람이 읽는 목록(Markdown) ───────────────────────────────────────
export function listMarkdown(list, counts) {
  const corpora = Object.keys(counts);
  const CN = { real: '실문서', rhwp: 'rhwp 공개' };
  const screen = (it) => {
    if (it.skip) return '';
    const h = it.hangul;
    if (!h) return '';
    if (!h.kept) return '한/글이 바꿔 저장';
    const img = h.images && h.images.split('/')[0] !== h.images.split('/')[1] ? [`그림 상자 ${h.images}`] : [];
    const o = h.object;
    const obj = !o ? [] : o.verdict === '다름' ? [`개체 상자 Δ${o.delta.length === 2 ? `x${o.delta[0]} y${o.delta[1]}` : o.delta.join(',')}px`] : o.verdict === '같음' ? [] : [`개체 ${o.verdict}`];
    const d = [...h.diffs, ...img, ...obj];
    const measured = o ? '' : ' (개체 상자 미측정)';
    return (d.length ? '✗ ' + d.join(', ') : '○') + measured;
  };
  const L = [];
  let lastG = 0;
  for (const it of list) {
    if (it.group !== lastG) {
      const gl = list.filter((x) => x.group === it.group);
      const docs = corpora.map((c) => `${CN[c] || c} ${gl.filter((x) => x.dim === '자리').reduce((s, x) => s + x.by[c].docs, 0)}`).join(' · ');
      L.push('', `### G${String(it.group).padStart(3, '0')} ${CTX_KO[it.ctx] || it.ctx} × ${KIND_KO[it.kind] || it.kind}  <small>(자리 항목 문서 수 합: ${docs})</small>`, '');
      L.push(`| 순번 | 구분 | 속성 | ${corpora.map((c) => `${CN[c] || c} 문서/개체`).join(' | ')} | 시험지 | 한/글 첫 선별 |`);
      L.push(`|---|---|---|${corpora.map(() => '---').join('|')}|---|---|`);
      lastG = it.group;
    }
    const where = it.skip ? `— ${it.skip}` : `${it.file.replace(/^matrix_|\.hwpx$/g, '')} ${it.section != null ? `구역 ${it.section + 1}` : `${it.page}쪽`}`;
    L.push(`| ${it.no} | ${it.dim} | ${it.label || ''} | ${corpora.map((c) => it.by[c].docs ? `${it.by[c].docs} / ${it.by[c].objs}` : '·').join(' | ')} | ${where} | ${screen(it)} |`);
  }
  return L.join('\n');
}

// ── 개체 상자 견주기(한/글 CreatePageImage 쪽 그림 ↔ rhwp 그리기 나무) ─────────────
// 쪽 그림에서 시험 개체를 알아보는 표식 색: 그림 = 표식 사본의 그림 색(scripts/hangul-oracle.mjs), 표 = 칸 채움(TABLE_MARK),
// 도형 = 채움 색(사각형·글상자·타원·다각형)·선 색(선). 바깥 틀(표 셀 자리의 1×1 표, 글상자 자리의 큰 글상자)은 표식 색이 없다.
const TABLE_MARK = '#FFC8E6';
const MARK = { tbl: TABLE_MARK, rect: '#D6E6FF', textbox: '#FFF7D6', ellipse: '#E3F5DA', polygon: '#F5DADA', line: '#C00000' };
export const MARK_COLORS = [...new Set(Object.values(MARK))];
const NODE = { pic: ['Image'], tbl: ['Table'], rect: ['Rect'], textbox: ['Rect'], ellipse: ['Ellipse'], polygon: ['Path'], line: ['Line'], container: ['Group'] };
const union = (bs) => bs.length ? [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))] : null;
const OBJ_TOL = 2; // px

/** 사례마다 시험 개체의 상자를 한/글 쪽 그림과 rhwp 에서 찾아 견준다. 미주(문서 끝에 모임)·수식은 견주지 않는다. */
async function compareObjects(file, cases, hangulDir, pageOf) {
  const { loadEngine } = await import('./layout-trace.mjs');
  const { readHangulOracle } = await import('./hangul-oracle.mjs');
  const mod = await loadEngine(path.join(root, 'vendor', 'rhwp', 'pkg'));
  const doc = new mod.HwpDocument(new Uint8Array(fs.readFileSync(file)));
  const view = readHangulOracle(hangulDir);
  const picColors = new Set(view.instances.filter((i) => (i.kind || 'pic') === 'pic').map((i) => i.color));
  const todo = cases.filter((c) => c.ctx !== 'endNote' && c.kind !== 'equation');
  const result = new Map();
  try {
    doc.convertToEditable();
    todo.forEach((c) => {
      // 사례 머리 문단이 놓인 쪽 — 한/글(문단 쪽 번호)과 rhwp 가 다를 수 있다.
      const page = pageOf(c);
      if (!page || page.r == null || page.h == null || page.r >= doc.pageCount() || page.h >= view.pages) { result.set(c.no, { verdict: '쪽 없음' }); return; }
      const boxes = view.colorBoxes[page.h] || {};
      const of = (pred) => union(Object.entries(boxes).filter(([col]) => pred(col)).flatMap(([, bs]) => bs));
      const tree = JSON.parse(doc.getPageRenderTree(page.r));
      const nodes = [];
      const walk = (n) => { nodes.push(n); for (const k of n.children || []) walk(k); };
      walk(tree);
      const bb = (n) => [n.bbox.x, n.bbox.y, n.bbox.x + n.bbox.w, n.bbox.y + n.bbox.h];
      const kind = c.ctx === 'group' ? 'container' : c.kind;
      const hb = kind === 'pic' ? of((col) => picColors.has(col))
        : kind === 'container' ? of((col) => picColors.has(col) || MARK_COLORS.includes(col))
          : of((col) => col === MARK[kind]);
      // 바깥 틀(표 셀 자리의 1×1 표 · 글상자 자리의 본문 폭 글상자)은 시험 개체가 아니다.
      const host = (n) => (c.ctx === 'cell' && n.type === 'Table' && n.bbox.w > 500) || (c.ctx === 'textbox' && n.bbox.w > 500);
      const rb = union(nodes.filter((n) => NODE[kind].includes(n.type) && !host(n)).map(bb));
      if (!hb || !rb) { result.set(c.no, { verdict: '못 찾음', hangul: hb, rhwp: rb }); return; }
      const d = hb.map((v, k) => +(rb[k] - v).toFixed(1));
      result.set(c.no, { verdict: d.every((v) => Math.abs(v) <= OBJ_TOL) ? '같음' : '다름', delta: d, hangul: hb.map((v) => +v.toFixed(1)), rhwp: rb.map((v) => +v.toFixed(1)) });
    });
  } finally { doc.free(); }
  return result;
}

/**
 * 한/글 첫 선별: 시험지마다 한/글 COM 으로 열어(인쇄 없이 CreatePageImage — scripts/hangul-oracle.mjs) 쪽 그림·문단 쪽 번호·재저장본을 받고,
 * (1) 한/글이 사례 조합을 그대로 두었는지(재저장본을 다시 셈), (2) 쪽 수, (3) 본문 문단의 쪽·줄·y·x/폭(layout-trace),
 * (4) 그림 상자, (5) 시험 개체 상자(표식 색)를 사례별로 견준다.
 */
export async function compareWithHangul(list, outDir, { only, dirs = {} } = {}) {
  const { layoutTrace } = await import('./layout-trace.mjs');
  const { countCorpus } = await import('./layout-combos.mjs');
  const { runHangulOracle } = await import('./hangul-oracle.mjs');
  const files = [...new Set(list.filter((x) => x.file).map((x) => x.file))].filter((f) => !only || f.includes(only));
  const summary = [];
  for (const f of files) {
    const file = path.join(outDir, f);
    // dirs[f]: 이미 만든 한/글 결과 폴더(runHangulOracle 결과)를 다시 쓴다.
    const work = dirs[f] || await runHangulOracle(file, { extraColors: MARK_COLORS });
    const kept = (await countCorpus([path.join(work, 'saved.hwpx')])).combos;
    const res = await layoutTrace({ file, hangul: work });
    const cases = list.filter((x) => x.file === f);
    // 문단 → 사례: 머리 문단 "[NNNN]" 부터 다음 머리 문단 앞까지(바탕쪽 시험지는 구역 = 사례).
    const byNo = new Map(cases.map((c) => [c.no, { rows: 0, diffs: new Set(), images: [0, 0] }]));
    // 쪽은 사례 첫 문단의 쪽에서 몇 쪽 뒤인가로 견준다 — 앞 사례에서 한 쪽이 갈라지면 뒤 사례가 모두 '쪽' 다름으로 나오지 않게.
    let cur = null, p0 = null;
    const pageCase = new Map();
    const headPages = new Map(); // 사례 → 머리 문단의 쪽 { r: rhwp, h: 한/글 }
    for (const r of res.rows) {
      const m = /^\[(\d{4})\]/.exec(r.text || '');
      if (m && byNo.has(m[1]) && !headPages.has(m[1])) headPages.set(m[1], { r: r.rPage, h: r.hPage });
      const prev = cur;
      if (m && byNo.has(m[1])) cur = m[1];
      else if (f === 'matrix_master.hwpx') cur = cases.find((c) => c.section === r.sec)?.no ?? cur;
      if (!cur) continue;
      if (cur !== prev) p0 = { r: r.rPage, h: r.hPage };
      const b = byNo.get(cur);
      b.rows++;
      const samePage = r.rPage != null && r.hPage != null && r.rPage - p0.r === r.hPage - p0.h;
      for (const d of r.diffs) if (!(samePage && (d === '쪽' || d === '1줄쪽'))) b.diffs.add(d);
      if (r.rPage != null && !pageCase.has(r.rPage)) pageCase.set(r.rPage, cur);
    }
    // 그림 상자(layout-trace): 한/글 쪽은 본문 최상위 그림만 모은다 — 표 칸·글상자·머리말·바탕쪽 안 그림은 개체 상자(아래)로 본다.
    const imagesComparable = ['matrix_body.hwpx', 'matrix_column.hwpx', 'matrix_group.hwpx'].includes(f);
    for (const im of imagesComparable ? res.images || [] : []) { const no = pageCase.get(im.page); if (!no) continue; const b = byNo.get(no); b.images[1]++; if (im.ok) b.images[0]++; }
    const objs = await compareObjects(file, cases, work, (c) => headPages.get(c.no));
    for (const c of cases) {
      const b = byNo.get(c.no);
      c.hangul = { kept: kept.has(c.id), diffs: [...b.diffs], images: b.images[1] ? `${b.images[0]}/${b.images[1]}` : null, object: objs.get(c.no) || null };
    }
    const bad = cases.filter((c) => c.hangul.diffs.length || c.hangul.object?.verdict === '다름' || (c.hangul.images && c.hangul.images.split('/')[0] !== c.hangul.images.split('/')[1]));
    summary.push({ file: f, cases: cases.length, rhwpPages: res.rhwp.pageCount, hangulPages: res.hangul.pageCount, lost: cases.filter((c) => !c.hangul.kept).length, differ: bad.length, work });
    console.log(`${f}: 쪽 rhwp ${res.rhwp.pageCount} / 한/글 ${res.hangul.pageCount} · 사례 ${cases.length} · 한/글이 바꿔 저장 ${summary.at(-1).lost} · 본문 흐름·그림 상자 다름 ${bad.length} · ${work}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const outDir = opt('--out-dir', OUT);
  const counts = JSON.parse(fs.readFileSync(opt('--counts', path.join(outDir, 'combos_counts.json')), 'utf8'));
  const template = opt('--template', path.join(root, 'testdata', '매크로테스트용_저장.hwpx'));
  const t0 = Date.now();
  const { list, files } = await buildMatrix({ counts, template, outDir });
  const made = list.filter((x) => !x.skip).length;
  console.log(`목록 ${list.length}칸 · 시험지 ${made}쪽(${files.length}파일) · 만들지 않음 ${list.length - made} · ${Date.now() - t0}ms`);
  for (const f of files) console.log(`  ${f.file}  ${f.cases}쪽`);
  if (args.includes('--hangul')) {
    const dirs = args.includes('--hangul-dirs') ? JSON.parse(fs.readFileSync(opt('--hangul-dirs'), 'utf8')) : {};
    const summary = await compareWithHangul(list, outDir, { only: opt('--only', null), dirs });
    fs.writeFileSync(path.join(outDir, 'matrix_hangul_summary.json'), JSON.stringify(summary, null, 1));
  }
  fs.writeFileSync(path.join(outDir, 'matrix_list.json'), JSON.stringify(list, null, 1));
  const md = opt('--md', null);
  // 이미 있는 문서면 표식 뒤(순번 목록)만 바꾼다 — 앞의 요약은 사람이 쓴 글이다.
  const MARKER = '<!-- 순번 목록: scripts/layout-matrix.mjs --md 가 이 줄 아래를 다시 쓴다 -->';
  if (md) {
    const prev = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    const at = prev.indexOf(MARKER);
    fs.writeFileSync(md, (at >= 0 ? prev.slice(0, at) : '') + MARKER + '\n' + listMarkdown(list, counts) + '\n');
  }
}
