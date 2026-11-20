// [hwpx-cowork] 표·그림·차트에 딸린 글: 표의 단위 줄, 표·그림·차트의 주석(주:·자료:), 차트 캡션(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-8).
// 실험 T06(차트에 [그림 N] 캡션을 붙일 길이 없었다)·P1·P2·T09(단위 줄·주석을 따로 문단으로 넣어 서식 명세의 꼴과 달랐다)에서 드러났다.
//
// 놓는 꼴 — 문서의 스타일을 따른다:
//  - 표준서식(스타일 '&표단위'·'&표주석'이 있는 문서 — skill/hwpx-standard-report/reference/서식명세.md §3·§4·§5, 실제 예 tutorial 'AI 활용 심화 — 연습 보고서'
//    표 5개·그림 3개를 엔진으로 읽어 맞춤):
//      단위 줄 = 표 바로 앞 '&표단위' 문단 하나(오른쪽 정렬, 다음 문단과 함께 — 문서에 이미 있는 단위 줄의 문단 모양을 빌린다).
//      주석 = 개체 문단 안 [개체][줄 바꿈][주석] — 문단 스타일 '&표주석'. 표는 개체와 줄 바꿈이 든 런이 1pt 글자(표 아래 빈 줄이 1pt — 주석이 표에 붙는다),
//      그림·차트는 주석 글자 모양 그대로 + 문단 보호(서식명세 §5). 문서에 이미 있는 '표 + 주석'·'그림 + 주석' 문단의 모양을 먼저 빌린다.
//      주석 여러 줄은 같은 문단 안 줄 바꿈(한/글 Shift+Enter)으로.
//  - 그 밖의 문서: 단위 줄 = 표 바로 앞 '바탕글' 오른쪽 정렬 문단(다음 문단과 함께), 주석 = 개체 바로 뒤 '바탕글' 왼쪽 정렬 문단 하나(여러 줄은 줄 바꿈) —
//    개체 문단의 정렬(가운데 등)을 주석이 따라가지 않게 따로 둔다. 한/글 기본 서식에 단위·주석 전용 스타일이 없어 바탕글의 정렬만 바꾼 무난한 꼴.
// 넣는 글(단위·주석·캡션 제목)은 변경 추적 '삽입'(캡션 제목과 같은 규칙 — 거절·되돌리기가 함께 거둔다).
import { EngineError } from './errors.js';
import { sectionTextWidth } from './table.js';

const UNIT_STYLE = '&표단위';
const NOTE_STYLE = '&표주석';
const ANCHOR_HEIGHT = 100;   // 서식명세 §4: 표 앵커와 줄 바꿈이 든 런은 1pt(charPr height="100" — 표준서식 생성기의 ANCHOR_PT)
const OBJ_TAG = { table: 'hp:tbl', figure: 'hp:pic', chart: 'hp:chart' };

const xmlSafe = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

/**
 * 단위 줄 글: '명, %' → '(단위: 명, %)', '단위: 명' → '(단위: 명)', 괄호로 감싼 글은 그대로. 빈 글이면 ''.
 * 서식명세의 단위 줄 꼴이 `(단위: …)` 라 모델이 단위 이름만 줘도 그 꼴이 되게 한다
 */
export function normUnit(v) {
  const s = xmlSafe(v).replace(/\s*\n\s*/g, ' ').trim().slice(0, 200);
  if (!s) return '';
  if (/^[(（].*[)）]$/.test(s)) return s;
  // 단위 문구를 적은 그대로(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §20): 'base: 봉사활동 참여자, 단위: 명, 회' 처럼 '단위'가 든 글은 괄호만 씌운다
  // (예전에는 '단위:' 로 시작할 때만 — 그 밖은 '(단위: …)' 로 감싸 실제 Codex 가 '(base: …, 단위: …)' 를 '(단위: …; base: …)' 로 바꿔 냈다)
  if (/단위\s*[:：]/.test(s)) return `(${s})`;
  return `(단위: ${s})`;
}

/** 주석 줄들: 문자열(줄 바꿈으로 여러 줄) 또는 줄 배열 → 빈 줄을 뺀 줄 배열(최대 20줄, 줄마다 1,000자) | null. 머리('주:'·'자료:')는 준 그대로 */
export function normNotes(v) {
  if (v == null || v === '') return null;
  const list = (Array.isArray(v) ? v : [v]).flatMap((x) => xmlSafe(x).split(/\r?\n/)).map((x) => x.trim()).filter(Boolean);
  if (list.length > 20) throw new EngineError('BAD_NOTES', `주석은 20줄까지입니다(${list.length}줄)`);
  return list.length ? list.map((x) => x.slice(0, 1000)) : null;
}

const attrIn = (tag, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(tag) || [])[1];
const openTag = (xml, at) => xml.slice(at, xml.indexOf('>', at) + 1);

// 스타일 이름은 머리 XML 속성에 '&amp;표주석' 으로 들어 있다 — 풀어 읽은 목록(formattingCatalog)에서 이름으로 찾고 번호로 꺼낸다
function styleByName(doc, name) { const s = doc.formattingCatalog().styles.find((x) => x.name === name && x.type !== 'CHAR'); return s ? doc.header.style({ id: s.id }) : null; }
function normalStyle(h) { return h.style({ engName: 'Normal' }) || h.style({ name: '바탕글' }) || h.style({ id: 0 }) || { styleId: '0', paraPr: '0', charPr: '0' }; }

/** 문단 모양 변형: 정렬·들여쓰기 0(header.paraPrVariant) + 다음 문단과 함께·문단 보호. 바뀔 것이 없으면 원본 id */
function paraVariant(h, paraPrId, { align = null, noIndent = false, keepWithNext = null, keepLines = null } = {}) {
  let id = h.paraPrVariant(paraPrId, { align, noIndent });
  if (keepWithNext == null && keepLines == null) return id;
  const src = h.block('paraPr', id); if (!src) return id;
  let xml = src;
  if (keepWithNext != null) xml = xml.replace(/\bkeepWithNext="\d"/, `keepWithNext="${keepWithNext ? 1 : 0}"`);
  if (keepLines != null) xml = xml.replace(/\bkeepLines="\d"/, `keepLines="${keepLines ? 1 : 0}"`);
  if (xml !== src) id = h.addItem('paraProperties', 'paraPr', xml);
  return id;
}

/** 글자 모양 변형: 크기만 height(HWPUNIT/100pt)로 */
function charHeightVariant(h, charPrId, height) {
  const src = h.block('charPr', charPrId); if (!src) return String(charPrId);
  const xml = src.replace(/(<hh:charPr\b[^>]*?\bheight=")\d+(")/, `$1${height}$2`);
  return xml === src ? String(charPrId) : h.addItem('charProperties', 'charPr', xml);
}

/** 본문 문단마다 (sec, p, open 태그) — 모양을 빌릴 본보기 찾기용 */
function* bodyParas(doc) { for (const sec of doc.sections) for (const p of sec.bodyParas) yield { sec, p, open: openTag(sec.xml, p.start) }; }

/** 문서에 이미 있는 단위 줄 문단 모양 { paraPr, styleId, charPr } | null — 스타일이 단위 줄 스타일인 첫 본문 문단 */
function unitModel(doc, styleId) {
  for (const { sec, p, open } of bodyParas(doc)) {
    if (attrIn(open, 'styleIDRef') !== styleId) continue;
    const xml = sec.xml.slice(p.start, p.end);
    const run = /<hp:run\b[^>]*\bcharPrIDRef="(\d+)"[^>]*>\s*<hp:t>[^<]/.exec(xml);
    return { paraPr: attrIn(open, 'paraPrIDRef'), styleId, charPr: run ? run[1] : null };
  }
  return null;
}

/** 문서에 이미 있는 '개체 + 주석' 문단(스타일 = 주석 스타일, 개체 뒤에 글) 모양 { paraPr, styleId, anchorCharPr, noteCharPr } | null */
function noteModel(doc, styleId, tag) {
  for (const { sec, p, open } of bodyParas(doc)) {
    if (attrIn(open, 'styleIDRef') !== styleId) continue;
    const xml = sec.xml.slice(p.start, p.end);
    const at = xml.indexOf(`<${tag} `); const close = xml.lastIndexOf(`</${tag}>`);
    if (at < 0 || close < 0) continue;
    const after = xml.slice(close);
    const notes = [...after.matchAll(/<hp:run\b[^>]*\bcharPrIDRef="(\d+)"[^>]*>(?:(?!<\/hp:run>)[\s\S])*?<hp:t>[^<]/g)];
    if (!notes.length) continue;
    const runAt = xml.lastIndexOf('<hp:run', at);
    return { paraPr: attrIn(open, 'paraPrIDRef'), styleId, anchorCharPr: runAt >= 0 ? attrIn(openTag(xml, runAt), 'charPrIDRef') : null, noteCharPr: notes[notes.length - 1][1] };
  }
  return null;
}

/**
 * 이 문서에서 단위 줄·주석을 놓는 꼴.
 * → { unit: { paraPr, styleId, charPr }, notes: { inline: true, paraPr, styleId, anchorCharPr, noteCharPr } | { inline: false, paraPr, styleId, charPr } }
 */
export function attachmentLayout(doc, kind = 'table') {
  const h = doc.header;
  const normal = normalStyle(h);
  const unitStyle = styleByName(doc, UNIT_STYLE);
  const noteStyle = styleByName(doc, NOTE_STYLE);
  let unit;
  if (unitStyle) {
    const m = unitModel(doc, unitStyle.styleId);
    // 본보기가 없으면 스타일의 문단 모양에 '다음 문단과 함께'(서식명세 §3 표의 단위 줄 — 표와 떨어지지 않게)
    unit = { paraPr: m?.paraPr || paraVariant(h, unitStyle.paraPr, { keepWithNext: true }), styleId: unitStyle.styleId, charPr: m?.charPr || unitStyle.charPr };
  } else unit = { paraPr: paraVariant(h, normal.paraPr, { align: 'RIGHT', noIndent: true, keepWithNext: true }), styleId: normal.styleId, charPr: normal.charPr };
  let notes;
  if (noteStyle) {
    const m = noteModel(doc, noteStyle.styleId, OBJ_TAG[kind] || 'hp:pic') || (kind === 'chart' ? noteModel(doc, noteStyle.styleId, 'hp:pic') : null);
    const noteCharPr = m?.noteCharPr || noteStyle.charPr;
    if (kind === 'table') notes = { inline: true, paraPr: m?.paraPr || noteStyle.paraPr, styleId: noteStyle.styleId, anchorCharPr: m?.anchorCharPr || charHeightVariant(h, noteCharPr, ANCHOR_HEIGHT), noteCharPr };
    // 그림·차트 + 주석: 주석 글자 모양 그대로 + 문단 보호(서식명세 §5)
    else notes = { inline: true, paraPr: m?.paraPr || paraVariant(h, noteStyle.paraPr, { keepLines: true }), styleId: noteStyle.styleId, anchorCharPr: m?.anchorCharPr || noteCharPr, noteCharPr };
  } else notes = { inline: false, paraPr: paraVariant(h, normal.paraPr, { align: 'LEFT', noIndent: true }), styleId: normal.styleId, charPr: normal.charPr };
  return { unit, notes };
}

function bodyRef(doc, ref) {
  const m = /^s(\d+)\/p(\d+)$/.exec(String(ref || ''));
  if (!m) throw new EngineError('BAD_REF', `본문 문단 주소가 아닙니다: ${ref}`);
  const sec = doc.sections[Number(m[1])]; const p = sec?.bodyParas[Number(m[2])];
  if (!p) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: ${ref}`);
  return { sec, p, si: Number(m[1]), body: Number(m[2]) };
}

/** 글 한 문단 XML(글은 변경 추적 '삽입') */
function textParaXml(doc, { paraPr, styleId, charPr }, text, { author, date }) {
  return `<hp:p id="0" paraPrIDRef="${paraPr}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charPr}"><hp:t>${doc._trackedInsertXml(text, { author, date })}</hp:t></hp:run></hp:p>`;
}

/**
 * 본문 문단 at 뒤에 단위 줄 문단을 넣는다(표를 넣기 전에 — 표는 그 뒤에). → { ref, breakId }
 */
export function insertUnitParagraph(doc, si, at, unit, { author, date, trackBreak = false } = {}) {
  const sec = doc.sections[si];
  if (!sec?.bodyParas[at]) throw new EngineError('NO_PARAGRAPH', `문단을 찾을 수 없습니다: s${si}/p${at}`);
  const text = normUnit(unit); if (!text) throw new EngineError('EMPTY', '단위 줄 글이 없습니다');
  const { unit: u } = attachmentLayout(doc, 'table');
  const breakId = doc._insertParagraphXml(sec, at, textParaXml(doc, u, text, { author, date }), { author, date, trackBreak });
  return { ref: `s${si}/p${at + 1}`, breakId };
}

/**
 * 개체(kind 'table'|'figure'|'chart') 하나만 든 본문 문단 ref 에 주석을 단다(방금 넣은 개체 문단 — 그 개체가 문단의 마지막 개체).
 *  - inline(표준서식): 그 문단을 주석 문단 모양으로 바꾸고 [개체][줄 바꿈][주석] — 줄 바꿈은 개체가 든 런 끝, 주석은 새 런.
 *    문단 정렬이 바뀌면 그림·차트의 가운데 맞춤(바깥 여백 왼쪽 — insertPictureAfter 와 같은 규칙)을 새 정렬에 맞춘다
 *  - 따로(그 밖): 개체 문단 바로 뒤에 주석 문단 하나
 * → { inline, ref(따로 넣은 주석 문단 | null), breakId }
 */
export function attachNotes(doc, ref, notes, { kind = 'table', author, date, trackBreak = false } = {}) {
  const lines = normNotes(notes);
  if (!lines) return { inline: false, ref: null, breakId: null };
  const { sec, p, si, body } = bodyRef(doc, ref);
  const { notes: n } = attachmentLayout(doc, kind);
  if (!n.inline) {
    const breakId = doc._insertParagraphXml(sec, body, textParaXml(doc, n, lines.join('\n'), { author, date }), { author, date, trackBreak });
    return { inline: false, ref: `s${si}/p${body + 1}`, breakId };
  }
  const tag = OBJ_TAG[kind];
  let xml = sec.xml.slice(p.start, p.end);
  const objAt = xml.lastIndexOf(`<${tag} `); const close = xml.lastIndexOf(`</${tag}>`);
  if (objAt < 0 || close < objAt) throw new EngineError('NO_OBJECT', `주석을 달 개체를 찾지 못했습니다: ${ref}`);
  const runAt = xml.lastIndexOf('<hp:run', objAt);
  const end = close + `</${tag}>`.length;
  // 줄 바꿈은 개체가 든 런(1pt 앵커) 끝에, 주석 글은 새 런 — 그 런의 나머지(빈 hp:t·문단 나눔 표식)는 주석 런 끝으로 간다(나눔 표식은 문단 끝에 남아야 한다)
  const lb = doc._trackedInsertXml('\n', { author, date });
  const note = doc._trackedInsertXml(lines.join('\n'), { author, date });
  xml = `${xml.slice(0, end)}<hp:t>${lb}</hp:t></hp:run><hp:run charPrIDRef="${n.noteCharPr}"><hp:t>${note}</hp:t>${xml.slice(end)}`;
  if (runAt >= 0) { const rt = openTag(xml, runAt); xml = xml.slice(0, runAt) + rt.replace(/\bcharPrIDRef="\d+"/, `charPrIDRef="${n.anchorCharPr}"`) + xml.slice(runAt + rt.length); }
  xml = restyle(doc, sec, xml, { paraPr: n.paraPr, styleId: n.styleId }, kind === 'table' ? null : tag);
  sec.load(sec.xml.slice(0, p.start) + xml + sec.xml.slice(p.end));
  return { inline: true, ref: null, breakId: null };
}

/**
 * 문단 XML 의 여는 태그 모양(paraPr·styleId)을 바꾸고 줄 정보(linesegarray — 옛 모양)를 지운다. tag(그림·차트)를 주면 그 개체의 가운데 맞춤
 * (바깥 여백 왼쪽)을 새 정렬에 맞춘다: 가운데 정렬 문단이면 0(한/글이 상자를 가운데에 둔다), 아니면 (본문 폭 − 개체 폭) ÷ 2(서식명세 §5)
 */
function restyle(doc, sec, xml, { paraPr, styleId }, tag) {
  const open = openTag(xml, 0);
  let out = open.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${paraPr}"`).replace(/\bstyleIDRef="\d+"/, `styleIDRef="${styleId}"`) + xml.slice(open.length);
  out = out.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/, '');
  if (tag) {
    const at = out.lastIndexOf(`<${tag} `);
    const w = Number((/<hp:sz\b[^>]*\bwidth="(\d+)"/.exec(out.slice(at)) || [])[1]) || 0;
    const centered = /<hh:align horizontal="CENTER"/.test(doc.header.block('paraPr', paraPr) || '');
    const textWidth = sectionTextWidth(sec);
    const left = !centered && w && w < textWidth ? Math.floor((textWidth - w) / 2) : 0;
    const om = /<hp:outMargin\b[^>]*\/>/.exec(out.slice(at));
    if (om) { const s = at + om.index; out = out.slice(0, s) + om[0].replace(/\bleft="\d+"/, `left="${left}"`) + out.slice(s + om[0].length); }
  }
  return out;
}

/**
 * 차트(hp:chart) 하나가 든 본문 문단 ref 에 캡션을 단다 — 문서의 그림 캡션 꼴('[그림 N] 제목', 자동 번호 그림 — 없으면 표준서식 아래 캡션)을 따르고
 * 차트의 번호 종류는 그림(PICTURE — 한/글이 차트를 그림 번호로 센다). 문단 모양은 그림 문단의 본보기(_pictureStyle)로 바꾼다
 * (주석도 달면 attachNotes 가 다시 주석 문단 모양으로). → 캡션 문단 ref(`${ref}/n0`)
 */
export function addChartCaption(doc, ref, caption, { author, date } = {}) {
  const text = xmlSafe(caption).replace(/\s*\n\s*/g, ' ').trim();
  if (!text) return null;
  const { sec, p, si } = bodyRef(doc, ref);
  let xml = sec.xml.slice(p.start, p.end);
  const at = xml.lastIndexOf('<hp:chart '); const close = xml.lastIndexOf('</hp:chart>');
  if (at < 0 || close < at) throw new EngineError('NO_OBJECT', `캡션을 달 차트를 찾지 못했습니다: ${ref}`);
  if (xml.slice(at, close).includes('<hp:caption')) throw new EngineError('HAS_CAPTION', '차트에 이미 캡션이 있습니다');
  const style = doc._pictureStyle();
  const width = Number((/<hp:sz\b[^>]*\bwidth="(\d+)"/.exec(xml.slice(at)) || [])[1]) || 0;
  const capXml = doc._captionXml(style.caption, text, { numType: 'PICTURE', sectionIndex: si, pos: p.start, width, near: p, author, date });
  xml = xml.slice(0, close) + capXml + xml.slice(close);
  const chartOpen = openTag(xml, at);
  if (!/\bnumberingType="PICTURE"/.test(chartOpen)) xml = xml.slice(0, at) + (/\bnumberingType="/.test(chartOpen) ? chartOpen.replace(/\bnumberingType="[^"]*"/, 'numberingType="PICTURE"') : chartOpen.replace('<hp:chart ', '<hp:chart numberingType="PICTURE" ')) + xml.slice(at + chartOpen.length);
  xml = restyle(doc, sec, xml, { paraPr: style.para.paraPr, styleId: style.para.styleId }, 'hp:chart');
  // 개체가 든 런도 그림 본보기의 글자 모양으로(앞 문단에서 물려받은 글자 모양 — 줄 높이가 엉뚱하지 않게)
  const runAt = xml.lastIndexOf('<hp:run', xml.lastIndexOf('<hp:chart '));
  if (runAt >= 0 && style.para.charPr != null) { const rt = openTag(xml, runAt); xml = xml.slice(0, runAt) + rt.replace(/\bcharPrIDRef="\d+"/, `charPrIDRef="${style.para.charPr}"`) + xml.slice(runAt + rt.length); }
  sec.load(sec.xml.slice(0, p.start) + xml + sec.xml.slice(p.end));
  return `${ref}/n0`;
}

