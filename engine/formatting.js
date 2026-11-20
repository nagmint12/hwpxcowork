// 서식 조회·선택 범위 적용. 기존 모양 XML을 복제하여 명시한 속성만 바꾼다.
// 코드포인트 좌표는 최종본 기준이며 메모/개체/변경 표식은 다시 만들지 않는다.
import { createHash } from 'node:crypto';
import { Section } from './section.js';
import { EngineError } from './errors.js';
import { scan, attr, attrs, escapeAttr, escapeText, decodeEntities } from './xmlscan.js';
import { replacementShapes, projectTextFormats } from './format-projection.js';
import { borderSides, privateStyleChar, styleKey, styleParagraphFields } from './style-properties.js';
import { lineSpec, patchBorderFill } from './table-edit.js';
export { replacementShapes, projectTextFormats } from './format-projection.js';

const fail = (code, message) => { throw new EngineError(code, message); };
const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
// [hwpx-cowork] 2026-10-30: 한/글 글자 모양의 자주 쓰는 속성 — 취소선·위첨자·아래첨자·장평·자간·음영 색도
const CHAR_KEYS = ['font', 'sizePt', 'bold', 'italic', 'underline', 'color', 'strikeout', 'superscript', 'subscript', 'ratioPct', 'spacingPct', 'shadeColor'];
// [hwpx-cowork] oneLine = 한/글 문단 모양 '한 줄로 입력'(hh:breakSetting lineWrap SQUEEZE — 넘치면 자간을 줄여 한 줄에)
// [hwpx-cowork] 2026-11-17 pageBreakBefore = 이 문단 앞에서 강제로 쪽을 나눈다(true: 문단 태그 pageBreak="1" — 한/글 Ctrl+Enter, 표준서식의 '장은 새 쪽에서'.
// false: 문단 태그를 끄고 문단 모양의 '문단 앞에서 항상 쪽 나눔'(breakSetting pageBreakBefore)도 그 문단만 끈다). 한/글 2022 실측: 둘은 따로 저장되고
// 어느 쪽이든 그 문단 앞에서 쪽을 나눈다(artifacts/mcp-round3-20261117/P/DESIGN.md §2). 본문 문단만(표 칸·글상자 안은 받지 않음)
const PARA_KEYS = ['align', 'lineSpacing', 'spaceBeforePt', 'spaceAfterPt', 'indentPt', 'leftMarginPt', 'rightMarginPt', 'oneLine', 'pageBreakBefore'];
const ALIGN = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];
// 취소선으로 그려지는 hh:strikeout shape. 그 밖(NONE·한/글 2018 이 자리만 채운 3D·모르는 값)은 취소선 없음 —
// 한/글이 그리지 않고 편집기(rhwp)는 NONE 으로 다시 적는다(docs/CLIPBOARD_AND_FORMAT_COPY.md '화면에 나타나지 않는 값')
const STRIKE_SHAPES = ['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE'];
const SPACING = ['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST'];
const dict = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, name) {
  if (!dict(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('FORMAT_SPEC', `${name}의 속성을 확인하세요`);
}
function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('FORMAT_SPEC', `${name}의 값이 범위 밖입니다`);
}
function id(value) {
  if (!((typeof value === 'string' && /^\d+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0))) fail('FORMAT_SPEC', '서식 ID는 음수가 아닌 정수입니다');
  return String(value);
}

/** 서버·엔진 공용 엄격 검증. range가 없는 순수 format 객체도 검증한다. */
export function validateFormatSpec(spec) {
  keys(spec, ['start', 'end', 'char', 'paragraph', 'styleId', 'charPrId', 'paraPrId', 'expectedFingerprint'], '서식');
  const out = { ...spec };
  for (const k of ['start', 'end']) if (spec[k] !== undefined && (!Number.isSafeInteger(spec[k]) || spec[k] < 0)) fail('RANGE', '범위는 음수가 아닌 코드포인트 정수입니다');
  if (spec.start !== undefined && spec.end !== undefined && spec.start > spec.end) fail('RANGE', '범위 시작이 끝보다 큽니다');
  for (const k of ['styleId', 'charPrId', 'paraPrId']) if (spec[k] !== undefined) out[k] = id(spec[k]);
  if (spec.expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(spec.expectedFingerprint)) fail('FORMAT_SPEC', '서식 fingerprint가 올바르지 않습니다');
  if (spec.char !== undefined) {
    keys(spec.char, CHAR_KEYS, '글자모양'); out.char = { ...spec.char };
    if (spec.char.font !== undefined && (typeof spec.char.font !== 'string' || !spec.char.font.trim() || spec.char.font.length > 160 || /[\x00-\x1f<>]/.test(spec.char.font))) fail('FORMAT_SPEC', '글꼴 이름이 올바르지 않습니다');
    if (spec.char.sizePt !== undefined) number(spec.char.sizePt, 1, 1000, '글자 크기(pt)');
    for (const k of ['bold', 'italic', 'underline', 'strikeout', 'superscript', 'subscript']) if (spec.char[k] !== undefined && typeof spec.char[k] !== 'boolean') fail('FORMAT_SPEC', `${k}는 true/false입니다`);
    if (spec.char.superscript === true && spec.char.subscript === true) fail('FORMAT_SPEC', '위첨자와 아래첨자는 함께 켤 수 없습니다');
    if (spec.char.ratioPct !== undefined) number(spec.char.ratioPct, 50, 200, '장평(%)');
    if (spec.char.spacingPct !== undefined) number(spec.char.spacingPct, -50, 50, '자간(%)');
    if (spec.char.shadeColor !== undefined) {
      if (typeof spec.char.shadeColor !== 'string' || !/^(#[0-9a-f]{6}|none)$/i.test(spec.char.shadeColor)) fail('FORMAT_SPEC', '음영 색은 #RRGGBB 또는 none입니다');
      out.char.shadeColor = spec.char.shadeColor === 'none' ? 'none' : spec.char.shadeColor.toUpperCase();
    }
    if (spec.char.color !== undefined) {
      if (typeof spec.char.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(spec.char.color)) fail('FORMAT_SPEC', '글자색은 #RRGGBB입니다');
      out.char.color = spec.char.color.toUpperCase();
    }
  }
  if (spec.paragraph !== undefined) {
    keys(spec.paragraph, [...PARA_KEYS, ...Object.keys(styleParagraphFields)], '문단모양'); out.paragraph = { ...spec.paragraph };
    for (const [key, schema] of Object.entries(styleParagraphFields)) if (spec.paragraph[key] !== undefined) {
      const result = schema.safeParse(spec.paragraph[key]);
      if (!result.success) fail('FORMAT_SPEC', `${key}: ${result.error.issues[0].message}`);
      out.paragraph[key] = result.data;
    }
    if (spec.paragraph.align !== undefined && !ALIGN.includes(spec.paragraph.align)) fail('FORMAT_SPEC', '문단 정렬이 올바르지 않습니다');
    for (const k of PARA_KEYS.filter(k => k.endsWith('Pt'))) if (spec.paragraph[k] !== undefined) number(spec.paragraph[k], k === 'indentPt' ? -10000 : 0, 10000, k);
    if (spec.paragraph.oneLine !== undefined && typeof spec.paragraph.oneLine !== 'boolean') fail('FORMAT_SPEC', 'oneLine(한 줄로 입력)은 true/false입니다');
    if (spec.paragraph.pageBreakBefore !== undefined && typeof spec.paragraph.pageBreakBefore !== 'boolean') fail('FORMAT_SPEC', 'pageBreakBefore(문단 앞 쪽 나눔)는 true/false입니다');
    if (spec.paragraph.lineSpacing !== undefined) {
      const ls = spec.paragraph.lineSpacing; keys(ls, ['type', 'value'], '줄 간격');
      if (!SPACING.includes(ls.type)) fail('FORMAT_SPEC', '줄 간격 종류가 올바르지 않습니다');
      number(ls.value, 0, ls.type === 'PERCENT' ? 1000 : 10000, '줄 간격');
      out.paragraph.lineSpacing = { ...ls };
    }
  }
  if (!['styleId', 'charPrId', 'paraPrId'].some(k => out[k] !== undefined) && !Object.keys(out.char || {}).length && !Object.keys(out.paragraph || {}).length) fail('FORMAT_SPEC', '적용할 서식이 없습니다');
  return out;
}

const open = xml => scan(xml).find(t => t.type === 'open' || t.type === 'selfclose');
const attrXml = (xml, name, fallback = null) => xml ? attr(xml, open(xml), name) ?? fallback : fallback;

// 쪽·단 나누기(<hp:p pageBreak="1"/columnBreak="1"> — 한/글 Ctrl+Enter·Ctrl+Shift+Enter). 문단모양(paraPr)이 아니라 문단 태그 속성이지만
// 서식처럼 지문·비교·복사에 넣는다(넣지 않으면 편집기에서 나눈 쪽이 공유 문서에 실리지 않는다)
const BREAKS = [['pageBreak', '쪽 나누기'], ['columnBreak', '단 나누기']];
function paragraphBreaks(sec, p) {
  const t = sec.tokens[p.openTok];
  return Object.fromEntries(BREAKS.map(([k]) => [k, ['1', 'true'].includes(attr(sec.xml, t, k))]));
}
/** want 의 나누기(값이 있는 것만)를 have 와 다를 때만 문단 태그 속성으로 */
function breakPatch(want, have) {
  return Object.fromEntries(BREAKS.filter(([k]) => typeof want[k] === 'boolean' && want[k] !== have[k]).map(([k]) => [k, want[k] ? '1' : '0']));
}
/** 문단 모양의 '문단 앞에서 항상 쪽 나눔'(hh:breakSetting pageBreakBefore) */
function paraPrBreakBefore(header, paraPrId) {
  const xml = header.block('paraPr', paraPrId);
  return !!xml && elements(xml, 'hh:breakSetting').some(t => ['1', 'true'].includes(attrXml(t.xml, 'pageBreakBefore')));
}
const NESTED_REF = /\/[nd]\d+/;
/** 이 문단 앞에서 강제로 쪽이 나뉘는가(문단 태그 쪽 나누기 또는 문단 모양 — 본문 문단만, 표 칸·글상자 안은 false) */
export function forcedPageBreak(doc, ref) {
  if (NESTED_REF.test(String(ref))) return false;
  const { sec, p } = doc.resolve(ref);
  return paragraphBreaks(sec, p).pageBreak || paraPrBreakBefore(doc.header, attr(sec.xml, sec.tokens[p.openTok], 'paraPrIDRef') ?? '0');
}
/** 두 문단의 쪽·단 나누기 차이 이름표(diffDocs format 덩어리 요약) — 같으면 [] */
export function breakChangeLabels(a, aRef, b, bRef) {
  const ra = a.resolve(aRef); const rb = b.resolve(bRef);
  const x = paragraphBreaks(ra.sec, ra.p); const y = paragraphBreaks(rb.sec, rb.p);
  return BREAKS.filter(([k]) => x[k] !== y[k]).map(([k, label]) => `${label} ${y[k] ? '넣음' : '지움'}`);
}
function setAttrs(tag, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(`(\\s${key}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`);
    const text = `${key}="${escapeAttr(String(value))}"`;
    tag = re.test(tag) ? tag.replace(re, () => ` ${text}`) : tag.replace(/\/?>(?![\s\S])/, end => ` ${text}${end}`);
  }
  return tag;
}
function rootAttrs(xml, patch) { const t = open(xml); return xml.slice(0, t.start) + setAttrs(xml.slice(t.start, t.end), patch) + xml.slice(t.end); }
function elements(xml, name) {
  const ts = scan(xml); const out = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]; if (t.name !== name || !['open', 'selfclose'].includes(t.type)) continue;
    let end = t.end;
    if (t.type === 'open') { let depth = 1; for (let j = i + 1; j < ts.length; j++) if (ts[j].name === name) { if (ts[j].type === 'open') depth++; else if (ts[j].type === 'close' && --depth === 0) { end = ts[j].end; break; } } }
    out.push({ ...t, blockEnd: end, xml: xml.slice(t.start, end) });
  }
  return out;
}
// [hwpx-cowork] 2026-11-12 뒤에서부터 쓴다. 시작이 같으면 범위를 지우는·바꾸는 편집을 먼저, 그 자리 삽입(end 없음)을 나중에 —
// 삽입은 원본의 그 자리 '앞'에 들어간다. 예전에는 넣은 순서대로라, 표만 든 문단의 빈 run 삽입(linesegarray 앞)을 먼저 하고
// 같은 자리에서 시작하는 linesegarray 지우기를 그 뒤에 해 넣은 run 과 줄 정보 앞부분을 지웠다(문단 태그가 깨져 구역이 문단 4개로 읽힘).
// 같은 (start, end) 끼리는 안정 정렬이라 같은 자리 삽입들의 차례는 그대로다.
const byPosition = (a, b) => b.start - a.start || (b.end ?? b.start) - (a.end ?? a.start);
function apply(xml, edits) {
  for (const e of edits.sort(byPosition)) xml = xml.slice(0, e.start) + e.text + xml.slice(e.end ?? e.start);
  return xml;
}
// 큰 표의 서식 편집마다 전체 XML 문자열을 복사하지 않고 조각을 한 번만 잇는다.
// 같은 위치의 삽입 순서는 apply와 같으며, 겹치는 치환은 쓰기 전에 거절한다.
function applyDisjoint(xml, edits) {
  const chunks = []; let cursor = xml.length;
  for (const e of edits.sort(byPosition)) {
    const end = e.end ?? e.start;
    if (e.start < 0 || end < e.start || end > cursor) fail('FORMAT_CONFLICT', '일괄 서식 복사의 XML 범위가 겹칩니다');
    chunks.push(xml.slice(end, cursor), e.text); cursor = e.start;
  }
  chunks.push(xml.slice(0, cursor)); return chunks.reverse().join('');
}
function patchElements(xml, name, patch) {
  const matches = elements(xml, name);
  if (!matches.length) fail('FORMAT_UNSUPPORTED', `${name} 요소가 없어 정확한 서식 변경을 할 수 없습니다`);
  return apply(xml, matches.map(t => ({ start: t.start, end: t.end, text: setAttrs(xml.slice(t.start, t.end), patch) })));
}
function insertCharChild(xml, name, child) {
  const order = ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold', 'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave', 'supscript', 'subscript'];
  const index = order.indexOf(name);
  const next = scan(xml).find(t => (t.type === 'open' || t.type === 'selfclose') && order.indexOf(t.name?.slice(3)) > index);
  const at = next?.start ?? xml.lastIndexOf('</hh:charPr>');
  if (at < 0) return xml.replace(/\/>$/, `>${child}</hh:charPr>`);
  return xml.slice(0, at) + child + xml.slice(at);
}
function toggle(xml, name, value) {
  const found = elements(xml, `hh:${name}`);
  if (!value) return apply(xml, found.map(t => ({ start: t.start, end: t.blockEnd, text: '' })));
  return found.length ? xml : insertCharChild(xml, name, `<hh:${name}/>`);
}

// 글꼴이 많은 문서에서도 언어/번호 조회마다 전체 header.xml을 다시 스캔하지 않는다.
// Header.xml은 문자열로 교체되므로 글꼴 추가·서식 복사 직후에는 자동으로 새 색인을 쓴다.
const fontIndexes = new WeakMap();
function fontIndex(header) {
  const previous = fontIndexes.get(header);
  if (previous?.xml === header.xml) return previous;
  const index = { xml: header.xml, list: [], byLang: new Map() };
  for (const group of elements(header.xml, 'hh:fontface')) {
    const lang = attrXml(group.xml, 'lang'); const byId = new Map();
    for (const font of elements(group.xml, 'hh:font')) {
      const id = attrXml(font.xml, 'id');
      index.list.push({ lang, id, name: attrXml(font.xml, 'face') });
      if (!byId.has(id)) byId.set(id, font.xml);
    }
    if (!index.byLang.has(lang)) index.byLang.set(lang, byId);
  }
  fontIndexes.set(header, index); return index;
}
function fonts(header) { return fontIndex(header).list; }
function ensureFont(header, name) {
  const result = {};
  for (const lang of LANGS) {
    const group = elements(header.xml, 'hh:fontface').find(t => attrXml(t.xml, 'lang') === lang.toUpperCase());
    if (!group) fail('FORMAT_UNSUPPORTED', `글꼴 목록 ${lang}가 없습니다`);
    const list = elements(group.xml, 'hh:font');
    const found = list.find(t => attrXml(t.xml, 'face') === name);
    if (found) { result[lang] = attrXml(found.xml, 'id'); continue; }
    const next = list.reduce((n, t) => Math.max(n, Number(attrXml(t.xml, 'id')) + 1), 0);
    const font = `<hh:font id="${next}" face="${escapeAttr(name)}" type="TTF" isEmbedded="0"/>`;
    let xml = rootAttrs(group.xml, { fontCnt: list.length + 1 });
    xml = group.type === 'selfclose' ? xml.replace(/\/>$/, `>${font}</hh:fontface>`) : xml.replace('</hh:fontface>', `${font}</hh:fontface>`);
    header.xml = header.xml.slice(0, group.start) + xml + header.xml.slice(group.blockEnd);
    result[lang] = String(next);
  }
  return result;
}
function shape(header, tag, shapeId) {
  const xml = header.block(tag, shapeId);
  if (!xml) fail('NO_FORMAT', `${tag} ${shapeId}를 찾을 수 없습니다`);
  return xml;
}
function charProps(header, shapeId, list = fonts(header)) {
  const xml = shape(header, 'charPr', shapeId); const fr = elements(xml, 'hh:fontRef')[0]?.xml;
  const font = Object.fromEntries(LANGS.map(lang => [lang, list.find(f => f.lang === lang.toUpperCase() && f.id === attrXml(fr, lang))?.name ?? null]));
  const under = elements(xml, 'hh:underline')[0]?.xml;
  const strike = elements(xml, 'hh:strikeout')[0]?.xml;
  const pct = tag => { const el = elements(xml, tag)[0]?.xml; return el ? Number(attrXml(el, 'hangul', 0)) : null; };
  return { font: font.hangul, fonts: font, sizePt: Number(attrXml(xml, 'height', 1000)) / 100, bold: elements(xml, 'hh:bold').length > 0, italic: elements(xml, 'hh:italic').length > 0, underline: attrXml(under, 'type', 'NONE') !== 'NONE', color: attrXml(xml, 'textColor', '#000000'),
    // Hancom 2018 emits 3D as an inactive placeholder, matching the WASM parser.
    strikeout: !!strike && STRIKE_SHAPES.includes(attrXml(strike, 'shape', 'NONE')), superscript: elements(xml, 'hh:supscript').length > 0, subscript: elements(xml, 'hh:subscript').length > 0,
    ratioPct: pct('hh:ratio') ?? 100, spacingPct: pct('hh:spacing') ?? 0, shadeColor: attrXml(xml, 'shadeColor', 'none') };
}
function modernUnits(doc) {
  const version = attrXml(doc.container.getText('version.xml'), 'xmlVersion', '').match(/^(\d+)\.(\d+)$/);
  return !!version && (+version[1] > 1 || (+version[1] === 1 && +version[2] >= 4));
}

const unitNamespace = 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar';
const lengthSpacing = new Set(['FIXED', 'BETWEEN_LINES', 'SPACE_ONLY', 'SPACEONLY', 'AT_LEAST', 'MINIMUM']);
const marginLength = /^(?:hc:)?(?:intent|left|right|prev|next)$/;
const isUnitCase = (tag) => (attrXml(tag.xml, 'hp:required-namespace') || attrXml(tag.xml, 'required-namespace', '')).includes('HwpUnitChar');

// [hwpx-cowork] 구판 리더는 호환 case를 닫을 때 앞서 읽은 평문 길이도 반감한다.
// 신판으로 옮기기 전에 그 값을 해소하고, 구판으로 쓸 때는 실제로 남은 case만큼 보상한다.
function adjustLegacyPlainLengths(xml, reading) {
  const switches = elements(xml, 'hp:switch');
  const unitSwitches = switches.filter(sw => elements(sw.xml, 'hp:case').some(isUnitCase));
  if (!unitSwitches.length) return xml;
  const edits = [];
  const adjust = (start, end) => {
    if (switches.some(sw => start > sw.start && start < sw.blockEnd)) return;
    const later = unitSwitches.filter(sw => sw.start > start).length;
    if (!later) return;
    const tag = xml.slice(start, end);
    const raw = attrXml(tag, 'value');
    if (raw === null || !/^-?\d+$/.test(raw)) return;
    const scale = 2 ** later;
    const value = reading ? Math.trunc(Number(raw) / scale) : Number(raw) * scale;
    if (value < -2147483648 || value > 2147483647) fail('FORMAT_UNSUPPORTED', '대상 서식 버전의 문단 길이 범위를 넘습니다');
    edits.push({ start, end, text: setAttrs(tag, { value }) });
  };
  for (const margin of elements(xml, 'hh:margin')) {
    for (const token of scan(margin.xml)) {
      if ((token.type === 'selfclose' || token.type === 'open') && marginLength.test(token.name)) {
        adjust(margin.start + token.start, margin.start + token.end);
      }
    }
  }
  for (const line of elements(xml, 'hh:lineSpacing')) {
    if (lengthSpacing.has(attrXml(line.xml, 'type'))) adjust(line.start, line.end);
  }
  return applyDisjoint(xml, edits);
}

// 1.2의 평문/호환 case와 1.4 이후의 물리 단위를 한/글 ParaShape 저장값을 거쳐 옮긴다.
// 탭 위치, 줄 간격 비율, 테두리와 다른 네임스페이스를 위한 switch는 판본 단위의 대상이 아니다.
function convertParaUnits(xml, toModern) {
  if (toModern) xml = adjustLegacyPlainLengths(xml, true);
  const edits = [];
  const lengths = [];
  const margins = elements(xml, 'hh:margin');
  for (const margin of margins) {
    for (const token of scan(margin.xml)) {
      if (!['selfclose', 'open'].includes(token.type) || !marginLength.test(token.name)) continue;
      lengths.push({ name: token.name.split(':').pop(), start: margin.start + token.start, end: margin.start + token.end });
    }
  }
  for (const line of elements(xml, 'hh:lineSpacing')) {
    if (lengthSpacing.has(attrXml(line.xml, 'type'))) lengths.push(line);
  }
  const switches = elements(xml, 'hp:switch').map(sw => ({
    ...sw, cases: elements(sw.xml, 'hp:case'), fallback: elements(sw.xml, 'hp:default')[0],
    selected: [], defaults: new Map(),
  }));
  const inside = (offset, el) => el && offset > el.start && offset < el.blockEnd;
  const write = (item, value, unit) => {
    if (value === item.value && (unit === undefined || unit === item.unit)) return;
    // 구판의 호환 default는 case의 두 배다. 범위를 넘긴 정수로 문서를 쓰지 않는다.
    if (value < -2147483648 || value > 2147483647) fail('FORMAT_UNSUPPORTED', '대상 서식 버전의 문단 길이 범위를 넘습니다');
    const patch = unit === undefined ? { value } : { value, unit };
    edits.push({ start: item.start, end: item.end, text: setAttrs(item.tag, patch) });
  };
  const encode = (item, stored) => {
    if (!toModern) return write(item, stored, item.line ? undefined : 'HWPUNIT');
    if (item.line) return write(item, Math.trunc(stored / 2));
    write(item, Math.floor(stored / 2), stored % 2 ? 'CHAR' : 'HWPUNIT');
  };
  for (const item of lengths) {
    item.tag = xml.slice(item.start, item.end);
    const raw = attrXml(item.tag, 'value');
    if (raw === null || !/^-?\d+$/.test(raw)) continue;
    item.value = Number(raw); item.unit = attrXml(item.tag, 'unit'); item.line = item.name === 'hh:lineSpacing';
    const sw = switches.find(s => inside(item.start, s));
    if (sw) {
      const offset = item.start - sw.start;
      if (inside(offset, sw.fallback)) sw.defaults.set(item.name, item);
      else if (sw.cases.some(c => inside(offset, c) && isUnitCase(c))) sw.selected.push(item);
      continue;
    }
    // 단위 없는 평문 여백과 hh:margin 자체 속성은 양쪽 모두 원래 저장값이다.
    if (!item.line && !['CHAR', 'HWPUNIT'].includes(item.unit)) continue;
    if (item.line && toModern && item.value % 2) {
      // 신판 평문 정수 한 칸에 못 담는 길이. 인접한 평문 여백도 한/글 저장본처럼
      // 같은 분기에 두며 default에는 구판의 원래 정수를 넣는다.
      const margin = margins.find(m => m.blockEnd <= item.start && !xml.slice(m.blockEnd, item.start).trim());
      const paired = margin && !/\b(?:left|right|indent|prev|next)\s*=/.test(xml.slice(margin.start, margin.end))
        && lengths.filter(t => inside(t.start, margin)).every(t => ['HWPUNIT', 'CHAR'].includes(t.unit));
      const begin = `<hp:switch><hp:case hp:required-namespace="${unitNamespace}">`;
      const fallbackMargin = paired ? xml.slice(margin.start, item.start) : '';
      if (paired) edits.push({ start: margin.start, text: begin });
      // HwpUnitChar 분기의 lineSpacing은 한/글이 쓰는 빈 요소 형식으로 내보낸다.
      const line = item.tag.replace(/\s*\/?>$/, '/>');
      const half = rootAttrs(line, { value: Math.trunc(item.value / 2) });
      edits.push({ start: item.start, end: item.blockEnd, text: `${paired ? '' : begin}${half}</hp:case><hp:default>${fallbackMargin}${line}</hp:default></hp:switch>` });
    } else {
      encode(item, toModern ? item.value : item.value * 2 + Number(!item.line && item.unit === 'CHAR'));
    }
  }
  for (const sw of switches) {
    const written = new Set();
    for (const item of sw.selected) {
      const other = sw.defaults.get(item.name);
      const exact = other && other.value !== item.value && Math.abs(other.value - item.value * 2) <= 1;
      const combined = exact ? other.value : item.value * 2 + Number(!item.line && item.unit === 'CHAR');
      const stored = toModern ? Math.trunc(combined / 2) : combined;
      // 줄 간격 하나의 두 표기만 있는 switch는 구판 평문의 정수 한 칸으로 충분하다.
      // 구판 리더는 이런 case에서도 이미 읽은 별도 평문 여백까지 반감한다.
      if (!toModern && item.line && exact && sw.cases.length === 1 && sw.selected.length === 1 &&
          attrXml(item.tag, 'type') === attrXml(other.tag, 'type') &&
          scan(sw.xml).every(t => !t.name || ['hp:switch', 'hp:case', 'hp:default', 'hh:lineSpacing'].includes(t.name))) {
        edits.push({ start: sw.start, end: sw.blockEnd, text: rootAttrs(item.xml, { value: stored }) });
        continue;
      }
      encode(item, stored);
      if (other && !written.has(other)) {
        // 독립된 대체값은 그 비율을 보존한다. 통상적인 반감 쌍은 default에 정확한 저장값이 있다.
        const fallback = exact ? (toModern ? stored : stored * 2) : (toModern ? Math.trunc(other.value / 2) : other.value * 2);
        write(other, fallback); written.add(other);
      }
    }
  }
  const converted = applyDisjoint(xml, edits);
  return toModern ? converted : adjustLegacyPlainLengths(converted, false);
}

/** 원본을 수정하지 않고 대상 xmlVersion에서 읽을 수 있는 서식 머리를 돌려준다. */
export function formattingPartsFor(source, target) {
  const modern = modernUnits(target);
  if (modernUnits(source) === modern) return null;
  const xml = source.header.xml;
  const edits = elements(xml, 'hh:paraPr').map(p => ({ start: p.start, end: p.blockEnd, text: convertParaUnits(p.xml, modern) }));
  const original = source.container.getText('version.xml');
  const targetPart = target.container.getText('version.xml');
  const revision = attrXml(targetPart, 'xmlVersion');
  const versionXml = original && revision ? rootAttrs(original, { xmlVersion: revision }) : targetPart;
  return { header: new source.header.constructor(applyDisjoint(xml, edits)), versionXml };
}
function paragraphContext(xml) {
  const preferred = elements(xml, 'hp:case').find(t => attrXml(t.xml, 'hp:required-namespace', '').includes('HwpUnitChar'));
  return preferred ? { xml: preferred.xml, isCase: true } : { xml: elements(xml, 'hp:default')[0]?.xml || xml, isCase: false };
}
function paraProps(header, shapeId, modern = true) {
  const xml = shape(header, 'paraPr', shapeId); const context = paragraphContext(xml);
  const factor = context.isCase ? (modern ? 100 : 200) : (modern && !xml.includes('<hp:switch') ? 100 : 200);
  const get = tag => { const el = elements(context.xml, tag)[0]?.xml; return el ? Number(attrXml(el, 'value', 0)) / factor : null; };
  const ls = elements(context.xml, 'hh:lineSpacing')[0]?.xml; const type = attrXml(ls, 'type', 'PERCENT');
  return { align: attrXml(elements(xml, 'hh:align')[0]?.xml, 'horizontal', 'JUSTIFY'), lineSpacing: { type, value: Number(attrXml(ls, 'value', 160)) / (type === 'PERCENT' ? 1 : factor) }, spaceBeforePt: get('hc:prev'), spaceAfterPt: get('hc:next'), indentPt: get('hc:intent'), leftMarginPt: get('hc:left'), rightMarginPt: get('hc:right'), oneLine: attrXml(elements(xml, 'hh:breakSetting')[0]?.xml, 'lineWrap', 'BREAK') === 'SQUEEZE' };
}
function charVariant(header, baseId, patch = {}) {
  const src = shape(header, 'charPr', baseId); let xml = src;
  if (patch.font !== undefined) xml = patchElements(xml, 'hh:fontRef', ensureFont(header, patch.font));
  if (patch.sizePt !== undefined) xml = rootAttrs(xml, { height: Math.round(patch.sizePt * 100) });
  if (patch.color !== undefined) xml = rootAttrs(xml, { textColor: patch.color });
  for (const k of ['bold', 'italic']) if (patch[k] !== undefined) xml = toggle(xml, k, patch[k]);
  if (patch.underline !== undefined) {
    const underline = elements(xml, 'hh:underline')[0];
    if (!underline && patch.underline) xml = insertCharChild(xml, 'underline', `<hh:underline type="BOTTOM" shape="SOLID" color="${escapeAttr(attrXml(xml, 'textColor', '#000000'))}"/>`);
    else if (underline) xml = patchElements(xml, 'hh:underline', { type: patch.underline ? 'BOTTOM' : 'NONE', ...(patch.underline && attrXml(underline.xml, 'shape', 'NONE') === 'NONE' ? { shape: 'SOLID' } : {}) });
  }
  // [hwpx-cowork] 취소선(hh:strikeout shape)·위/아래첨자(hh:supscript·hh:subscript — 하나만)·장평(hh:ratio)·자간(hh:spacing — 모든 언어)·음영(shadeColor)
  if (patch.strikeout !== undefined) {
    const so = elements(xml, 'hh:strikeout')[0];
    if (!so && patch.strikeout) xml = insertCharChild(xml, 'strikeout', `<hh:strikeout shape="SOLID" color="${escapeAttr(attrXml(xml, 'textColor', '#000000'))}"/>`);
    else if (so) xml = patchElements(xml, 'hh:strikeout', { shape: patch.strikeout ? 'SOLID' : 'NONE', ...(patch.strikeout && !/^#/.test(attrXml(so.xml, 'color', '')) ? { color: attrXml(xml, 'textColor', '#000000') } : {}) });
  }
  if (patch.superscript !== undefined) { xml = toggle(xml, 'supscript', patch.superscript); if (patch.superscript) xml = toggle(xml, 'subscript', false); }
  if (patch.subscript !== undefined) { xml = toggle(xml, 'subscript', patch.subscript); if (patch.subscript) xml = toggle(xml, 'supscript', false); }
  for (const [key, tag] of [['ratioPct', 'ratio'], ['spacingPct', 'spacing']]) {
    if (patch[key] === undefined) continue;
    const v = Object.fromEntries(LANGS.map(lang => [lang, Math.round(patch[key])]));
    xml = elements(xml, `hh:${tag}`).length ? patchElements(xml, `hh:${tag}`, v) : insertCharChild(xml, tag, `<hh:${tag} ${LANGS.map(l => `${l}="${v[l]}"`).join(' ')}/>`);
  }
  if (patch.shadeColor !== undefined) xml = rootAttrs(xml, { shadeColor: patch.shadeColor });
  return xml === src ? String(baseId) : header.addItem('charProperties', 'charPr', xml);
}
// 한/글 글머리표는 본문 글과 별도인 hh:bullet 정의다. 공유하는 다른 스타일·문단을 위해 복제한다.
const INHERIT_CHAR = '4294967295';
const levelPattern = level => `^${level === 10 ? ':' : level}.`;
function numberingVariant(header, old, heading) {
  const current = attrXml(old, 'type') === 'NUMBER';
  const level = heading.level ?? (current ? Number(attrXml(old, 'level', '0')) + 1 : 1);
  const newHead = n => `<hh:paraHead start="1" level="${n}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="${INHERIT_CHAR}" checkable="0">${levelPattern(n)}</hh:paraHead>`;
  const ref = attrXml(old, 'idRef', '0');
  let xml = current && ref !== '0' ? shape(header, 'numbering', ref)
    : `<hh:numbering id="1" start="0">${Array.from({ length: 10 }, (_, i) => newHead(i + 1)).join('')}</hh:numbering>`;
  let head = elements(xml, 'hh:paraHead').find(t => Number(attrXml(t.xml, 'level')) === level);
  if (!head) {
    const at = elements(xml, 'hh:paraHead').find(t => Number(attrXml(t.xml, 'level')) > level)?.start ?? xml.indexOf('</hh:numbering>');
    if (at < 0) fail('FORMAT_UNSUPPORTED', '문단 번호 정의에 수준을 추가할 수 없습니다');
    const h = newHead(level);
    xml = xml.slice(0, at) + h + xml.slice(at);
    head = { start: at, blockEnd: at + h.length, xml: h };
  }
  const patch = {};
  if (heading.format != null) patch.numFormat = heading.format;
  if (heading.start != null) patch.start = heading.start;
  if (heading.pattern !== undefined && attrXml(head.xml, 'text') !== null) patch.text = heading.pattern;
  let h = rootAttrs(head.xml, patch);
  if (heading.pattern !== undefined) {
    const token = open(h);
    h = h.slice(0, token.end).replace(/\/>$/, '>') + escapeText(heading.pattern) + '</hh:paraHead>';
  }
  xml = xml.slice(0, head.start) + h + xml.slice(head.blockEnd);
  return { type: 'NUMBER', idRef: header.addItem('numberings', 'numbering', xml), level: level - 1 };
}
function headingVariant(header, para, heading, charId) {
  if (heading.type === 'NONE') return { type: 'NONE', idRef: '0', level: '0' };
  const old = elements(para, 'hh:heading')[0]?.xml;
  if (heading.type === 'OUTLINE') return { type: 'OUTLINE', idRef: attrXml(old, 'type') === 'OUTLINE' ? attrXml(old, 'idRef', '0') : '0', level: heading.level - 1 };
  if (heading.type === 'NUMBER') return numberingVariant(header, old, heading);
  const src = attrXml(old, 'type') === 'BULLET' ? shape(header, 'bullet', attrXml(old, 'idRef')) : null;
  if (!heading.char && (!src || attrXml(src, 'useImage') === '1')) fail('FORMAT_SPEC', '문자 글머리표를 새로 지정할 때는 char가 필요합니다');
  const template = `<hh:bullet id="1" char="" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="${INHERIT_CHAR}" checkable="0"/></hh:bullet>`;
  let xml = src || template;
  if (heading.char !== undefined) {
    xml = rootAttrs(xml, { char: heading.char, useImage: '0' });
    const images = elements(xml, 'hc:img');
    xml = apply(xml, images.map(t => ({ start: t.start, end: t.blockEnd, text: '' })));
  }
  if (heading.color != null || heading.sizePt != null) {
    const head = elements(xml, 'hh:paraHead')[0]?.xml;
    const marker = attrXml(head, 'charPrIDRef', INHERIT_CHAR);
    const id = charVariant(header, marker === INHERIT_CHAR ? charId : marker, {
      ...(heading.color ? { color: heading.color.toUpperCase() } : {}), ...(heading.sizePt ? { sizePt: heading.sizePt } : {}),
    });
    xml = patchElements(xml, 'hh:paraHead', { charPrIDRef: id });
  }
  return { type: 'BULLET', idRef: header.addItem('bullets', 'bullet', xml), level: '0' };
}

const paragraph2016 = 'http://www.hancom.co.kr/hwpml/2016/paragraph';
function hpDeclaration(header) {
  return /<hh:head\b[^>]*\sxmlns:hp\s*=/.test(header.xml) ? '' : ' xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"';
}
function writeStyleHeading(header, para, values) {
  const heads = elements(para, 'hh:heading');
  if (!heads.length) fail('FORMAT_UNSUPPORTED', '문단 머리(hh:heading)가 없습니다');
  const high = values.type !== 'NONE' && Number(values.level) >= 7;
  const h = heads[0];
  const next = rootAttrs(h.xml, values);
  if (heads.length === 1 && !high) return para.slice(0, h.start) + next + para.slice(h.blockEnd);
  // 한/글 2022 개요 8~10과 rhwp의 hwpx_heading_switch. 2011 호환 갈래는 NONE/0/0이다.
  const fallback = { type: 'NONE', idRef: '0', level: '0' };
  const sw = elements(para, 'hp:switch').find(t => t.start < h.start && h.start < t.blockEnd);
  if (!sw) {
    if (heads.length !== 1) fail('FORMAT_UNSUPPORTED', '문단 머리 갈래를 식별할 수 없습니다');
    const xml = `<hp:switch${hpDeclaration(header)}><hp:case hp:required-namespace="${paragraph2016}">${next}</hp:case><hp:default><hh:heading type="NONE" idRef="0" level="0"/></hp:default></hp:switch>`;
    return para.slice(0, h.start) + xml + para.slice(h.blockEnd);
  }
  const branch = elements(sw.xml, 'hp:case').find(t => attrXml(t.xml, 'hp:required-namespace') === paragraph2016);
  const def = elements(sw.xml, 'hp:default')[0];
  const inBranch = (item, b) => b && sw.start + b.start < item.start && item.blockEnd < sw.start + b.blockEnd;
  if (heads.length !== 2 || !inBranch(h, branch) || !inBranch(heads[1], def))
    fail('FORMAT_UNSUPPORTED', '문단 머리의 확장 갈래를 안전하게 변경할 수 없습니다');
  const tags = scan(sw.xml).filter(t => t.type === 'open' || t.type === 'selfclose').map(t => t.name);
  if (!high && tags.join(' ') === 'hp:switch hp:case hh:heading hp:default hh:heading')
    return para.slice(0, sw.start) + next + para.slice(sw.blockEnd);
  return apply(para, [{ start: h.start, end: h.blockEnd, text: next },
    { start: heads[1].start, end: heads[1].blockEnd, text: rootAttrs(heads[1].xml, high ? fallback : values) }]);
}

function tabVariant(header, para, tabs) {
  const id = attrXml(para, 'tabPrIDRef', '0');
  let xml = header.block('tabPr', id);
  if (!xml && id !== '0') fail('NO_FORMAT', `탭 모양 ${id}가 없습니다`);
  xml ??= '<hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>';
  const flags = {};
  if (tabs.autoLeft != null) flags.autoTabLeft = Number(tabs.autoLeft);
  if (tabs.autoRight != null) flags.autoTabRight = Number(tabs.autoRight);
  xml = rootAttrs(xml, flags);
  if (tabs.stops) {
    // 한/글 표준서식 차례 탭은 같은 물리 위치를 case에 HWPUNIT(1pt=100), default에 그 두 배로 기록한다.
    const stops = [...tabs.stops].sort((a, b) => a.posPt - b.posPt);
    let previous = -1;
    const items = stops.map(stop => {
      const pos = Math.round(stop.posPt * 100);
      if (pos === previous) fail('FORMAT_SPEC', '같은 위치에 두 개의 탭을 지정할 수 없습니다');
      previous = pos;
      const at = `type="${stop.type ?? 'LEFT'}" leader="${stop.leader ?? 'NONE'}"`;
      return `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:tabItem pos="${pos}" ${at} unit="HWPUNIT"/></hp:case><hp:default><hh:tabItem pos="${pos * 2}" ${at}/></hp:default></hp:switch>`;
    });
    const tag = xml.slice(0, open(xml).end).replace(/\s*\/?>$/, '');
    const ns = items.length && !attrXml(xml, 'xmlns:hp') ? hpDeclaration(header) : '';
    xml = items.length ? tag + ns + '>' + items.join('') + '</hh:tabPr>' : tag + '/>';
  }
  return header.addItem('tabProperties', 'tabPr', xml);
}

function paragraphBorder(header, para, border) {
  const old = elements(para, 'hh:border')[0]?.xml;
  if (!old) fail('FORMAT_UNSUPPORTED', '문단 테두리(hh:border)가 없습니다');
  const patch = {}; const sides = {};
  for (const side of borderSides) {
    if (border.all || border[side]) {
      const l = { ...border.all, ...border[side] };
      sides[side] = lineSpec({ type: l.type, width_mm: l.widthMm, color: l.color }, side);
    }
    if (border.offsetMm?.[side] != null) patch['offset' + side[0].toUpperCase() + side.slice(1)] = Math.round(border.offsetMm[side] * 7200 / 25.4);
  }
  if (border.connect != null) patch.connect = Number(border.connect);
  if (border.ignoreMargin != null) patch.ignoreMargin = Number(border.ignoreMargin);
  if (Object.keys(sides).length || border.fill != null) {
    let id = attrXml(old, 'borderFillIDRef', '0');
    if (id === '0' && !header.block('borderFill', id)) {
      const none = { type: 'NONE', width: '0.1 mm', color: '#000000' };
      id = header.borderFill(Object.fromEntries(borderSides.map(s => [s, none])));
    }
    patch.borderFillIDRef = patchBorderFill(header, id, { sides, fill: border.fill === 'none' ? 'none' : border.fill?.toUpperCase() });
  }
  return patchElements(para, 'hh:border', patch);
}

function paraVariant(header, baseId, patch = {}, modern = true, charId = '0', resolvedHeading = null) {
  const src = shape(header, 'paraPr', baseId); let xml = src;
  if (patch.align !== undefined) xml = patchElements(xml, 'hh:align', { horizontal: patch.align });
  const names = { spaceBeforePt: 'hc:prev', spaceAfterPt: 'hc:next', indentPt: 'hc:intent', leftMarginPt: 'hc:left', rightMarginPt: 'hc:right' };
  const cases = elements(xml, 'hp:case'); const defaults = elements(xml, 'hp:default');
  const units = t => cases.some(c => c.start < t.start && c.blockEnd > t.end && attrXml(c.xml, 'hp:required-namespace', '').includes('HwpUnitChar')) ? (modern ? 100 : 200) : defaults.some(c => c.start < t.start && c.blockEnd > t.end) ? (modern ? 200 : 400) : (modern ? 100 : 200);
  const edits = [];
  for (const [key, tag] of Object.entries(names)) if (patch[key] !== undefined) {
    const es = elements(xml, tag); if (!es.length) fail('FORMAT_UNSUPPORTED', `${tag} 요소가 없습니다`);
    for (const t of es) edits.push({ start: t.start, end: t.end, text: setAttrs(xml.slice(t.start, t.end), { value: Math.round(patch[key] * units(t)), unit: 'HWPUNIT' }) });
  }
  if (patch.lineSpacing !== undefined) {
    const es = elements(xml, 'hh:lineSpacing'); if (!es.length) fail('FORMAT_UNSUPPORTED', '줄 간격 요소가 없습니다');
    for (const t of es) edits.push({ start: t.start, end: t.end, text: setAttrs(xml.slice(t.start, t.end), { type: patch.lineSpacing.type, value: Math.round(patch.lineSpacing.value * (patch.lineSpacing.type === 'PERCENT' ? 1 : units(t))), unit: 'HWPUNIT' }) });
  }
  xml = apply(xml, edits);
  if (patch.heading) xml = writeStyleHeading(header, xml, resolvedHeading || headingVariant(header, xml, patch.heading, charId));
  if (patch.tabs) xml = rootAttrs(xml, { tabPrIDRef: tabVariant(header, xml, patch.tabs) });
  if (patch.border) xml = paragraphBorder(header, xml, patch.border);
  if (patch.oneLine !== undefined) {
    const bs = elements(xml, 'hh:breakSetting');
    if (!bs.length) fail('FORMAT_UNSUPPORTED', '줄 나눔 설정(hh:breakSetting) 요소가 없습니다');
    xml = patchElements(xml, 'hh:breakSetting', { lineWrap: patch.oneLine ? 'SQUEEZE' : 'BREAK' });
  }
  // [hwpx-cowork] 쪽 나눔 끄기: 문단 모양이 켜 둔 것도 그 문단만 끈다(켜기는 문단 태그로 — formatRange). 문단 모양이 없거나 꺼져 있으면 그대로
  if (patch.pageBreakBefore === false && elements(xml, 'hh:breakSetting').some(t => ['1', 'true'].includes(attrXml(t.xml, 'pageBreakBefore')))) {
    xml = patchElements(xml, 'hh:breakSetting', { pageBreakBefore: '0' });
  }
  return xml === src ? String(baseId) : header.addItem('paraProperties', 'paraPr', xml);
}

// [hwpx-cowork] 2026-11-18: 머리(header.xml)가 같으면 다시 훑지 않는다. 돌려주는 것은 부를 때마다 새 사본이다 — 받은 쪽이 목록을 고쳐도 다음 조회가 오염되지 않는다
// (tests/formatting_engine.test.mjs '공개 목록 수정에 오염되지 않는다').
// 문단 모양 301개·453KB 머리인 문서에서 한 번이 70ms 였고, 서식 제안 하나를 만들 때마다 두 번(스타일 번호 확인·사전 검사 사본) 불려
// 칸 서식 200개 저장 53초 가운데 28초가 이 훑기였다(docs/MCP_REDESIGN_2026-11-16.md §15). 위 fontIndex 와 같은 꼴(머리 객체 + xml 견줌)
const catalogs = new WeakMap();
export function styleDefinitions(doc) {
  return elements(doc.header.xml, 'hh:style').map(t => ({ id: attrXml(t.xml, 'id'), name: attrXml(t.xml, 'name'), engName: attrXml(t.xml, 'engName'), type: attrXml(t.xml, 'type', 'PARA'), charPrId: attrXml(t.xml, 'charPrIDRef', '0'), paraPrId: attrXml(t.xml, 'paraPrIDRef', '0') }));
}
export function namedStyle(doc, value, list = styleDefinitions(doc)) {
  const name = String(value);
  const exact = list.filter(s => s.name === name);
  const hits = exact.length ? exact : list.filter(s => s.name.trim() === name.trim());
  if (hits.length > 1) fail('NO_STYLE', `이름이 겹치는 스타일입니다: ${name}. read(view='styles')의 스타일 ID로 지정하세요`);
  const direct = hits[0] || list.find(s => s.id === name);
  if (direct || !['&□', '&■'].includes(name.trim())) return direct;
  // 표준서식 안내에서 쓰는 두 표시 이름. 실제 이름(또는 ID)이 일치할 때는 항상 그 문단 스타일이 우선이다.
  const candidates = list.filter(s => s.type === 'PARA' && styleKey(s.name) === styleKey(name));
  if (candidates.length > 1) fail('NO_STYLE', `「${name}」와 기호만 다른 스타일이 여럿입니다. read(view='styles')의 실제 이름이나 ID를 지정하세요`);
  if (candidates.length === 1 && [...candidates[0].name].some(privateStyleChar)) return candidates[0];
}

// 읽기의 사용 수와 변경 대상이 같은 문단이어야 한다. 메모 안의 자손·삭제된 개체·대체 XML 갈래를 제외한다.
export function styleUsage(doc, ordinals = false) {
  const uses = new Map();
  for (const sec of doc.sections) {
    const excluded = new Set(); let ordinal = 0;
    for (const p of sec.paras) {
      if (p.container === 'hp:fieldBegin' || excluded.has(p.parent) || !Section.visibleParagraph(p, 'final')) { excluded.add(p); continue; }
      const id = attr(sec.xml, sec.tokens[p.openTok], 'styleIDRef') ?? '0';
      if (!uses.has(id)) uses.set(id, []);
      uses.get(id).push(ordinals ? [sec.index, ordinal, attr(sec.xml, sec.tokens[p.openTok], 'id') ?? ''] : p.ref);
      ordinal++;
    }
  }
  return uses;
}

export function styleDependencies(doc, watched) {
  const list = styleDefinitions(doc);
  const uses = styleUsage(doc, true);
  return [...watched].map(([name, members]) => {
    const s = namedStyle(doc, name, list);
    return s ? [name, s.id, semanticShapeHash(doc, 'style', s.id), members ? uses.get(s.id) || [] : null] : [name, null];
  });
}

export function styleHeading(doc, style) {
  const head = elements(doc.header.block('paraPr', style.paraPrId) || '', 'hh:heading')[0]?.xml;
  const type = attrXml(head, 'type', 'NONE');
  if (type === 'BULLET') {
    const b = doc.header.block('bullet', attrXml(head, 'idRef'));
    if (!b) return { type, missing: true };
    const markerId = attrXml(elements(b, 'hh:paraHead')[0]?.xml, 'charPrIDRef', INHERIT_CHAR);
    const cp = markerId === INHERIT_CHAR ? null : doc.header.block('charPr', markerId);
    return { type, char: attrXml(b, 'char'), ...(attrXml(b, 'useImage') === '1' ? { image: true } : {}),
      ...(cp ? { color: attrXml(cp, 'textColor'), sizePt: Number(attrXml(cp, 'height')) / 100 } : {}) };
  }
  const level = Number(attrXml(head, 'level', '0')) + 1;
  if (type === 'NUMBER') {
    const num = doc.header.block('numbering', attrXml(head, 'idRef'));
    const h = elements(num || '', 'hh:paraHead').find(t => Number(attrXml(t.xml, 'level')) === level);
    if (h) return { type, level, format: attrXml(h.xml, 'numFormat', 'DIGIT'), start: Number(attrXml(h.xml, 'start', '1')),
      pattern: decodeEntities(h.xml.slice(h.end - h.start, h.xml.indexOf('</hh:paraHead>'))) || attrXml(h.xml, 'text', '') };
  }
  return type === 'NONE' ? { type } : { type, level };
}

// 상세 조회를 명시한 스타일 하나에만 관련 정의를 풀어 준다. 문서 전체 목록·기본 도구 설명에는 싣지 않는다.
export function styleDetail(doc, s) {
  const header = doc.header; const para = shape(header, 'paraPr', s.paraPrId);
  const tab = header.block('tabPr', attrXml(para, 'tabPrIDRef', '0')) || '';
  const cases = elements(tab, 'hp:case').filter(t => attrXml(t.xml, 'hp:required-namespace', '').includes('HwpUnitChar'));
  const defaults = elements(tab, 'hp:default');
  const stops = elements(tab, 'hh:tabItem').filter(t => !cases.length || !defaults.some(d => t.start > d.start && t.start < d.blockEnd)).map(t => ({
    posPt: Number(attrXml(t.xml, 'pos')) / (attrXml(t.xml, 'unit') === 'HWPUNIT' ? 100 : 200),
    type: attrXml(t.xml, 'type', 'LEFT'), leader: attrXml(t.xml, 'leader', 'NONE'),
  }));
  const b = elements(para, 'hh:border')[0]?.xml;
  const bf = header.block('borderFill', attrXml(b, 'borderFillIDRef')) || '';
  const border = { offsetMm: {}, connect: attrXml(b, 'connect') === '1', ignoreMargin: attrXml(b, 'ignoreMargin') === '1' };
  for (const side of borderSides) {
    const line = elements(bf, `hh:${side}Border`)[0]?.xml;
    if (line) border[side] = { type: attrXml(line, 'type'), widthMm: parseFloat(attrXml(line, 'width')), color: attrXml(line, 'color') };
    const val = Number(attrXml(b, 'offset' + side[0].toUpperCase() + side.slice(1), '0'));
    border.offsetMm[side] = Number((val * 25.4 / 7200).toFixed(3));
  }
  border.fill = attrXml(elements(bf, 'hc:winBrush')[0]?.xml, 'faceColor', 'none');
  return { ...s, char: charProps(header, s.charPrId), paragraph: { ...paraProps(header, s.paraPrId, modernUnits(doc)),
    heading: styleHeading(doc, s), tabs: { autoLeft: attrXml(tab, 'autoTabLeft') === '1', autoRight: attrXml(tab, 'autoTabRight') === '1', stops }, border } };
}

export function formattingCatalog(doc) {
  const header = doc.header; const modern = modernUnits(doc);
  const previous = catalogs.get(header);
  if (previous && previous.xml === header.xml && previous.modern === modern) return structuredClone(previous.value);
  const list = fonts(header);
  const value = {
    styles: styleDefinitions(doc),
    charProperties: elements(header.xml, 'hh:charPr').map(t => { const id = attrXml(t.xml, 'id'); return { id, props: charProps(header, id, list) }; }),
    paragraphProperties: elements(header.xml, 'hh:paraPr').map(t => { const id = attrXml(t.xml, 'id'); return { id, props: paraProps(header, id, modern) }; }),
    fonts: list.map(font => ({ ...font })),
  };
  if (header && typeof header === 'object') catalogs.set(header, { xml: header.xml, modern, value: structuredClone(value) });
  return value;
}

export function inspectFormatting(doc, ref) {
  const { sec, p } = doc.resolve(ref); const chars = Section.visibleChars(p, 'final'); const runs = []; const list = fonts(doc.header);
  for (let i = 0; i < chars.length; i++) {
    const charPrId = chars[i].run?.charPr ?? '0'; const last = runs.at(-1);
    if (last?.charPrId === charPrId) { last.end++; last.text += chars[i].ch; }
    else runs.push({ start: i, end: i + 1, text: chars[i].ch, charPrId, char: charProps(doc.header, charPrId, list) });
  }
  const styleId = attr(sec.xml, sec.tokens[p.openTok], 'styleIDRef') ?? '0';
  const paraPrId = attr(sec.xml, sec.tokens[p.openTok], 'paraPrIDRef') ?? '0';
  // [hwpx-cowork] 나눔을 지워 이은 기록은 최종본 run(합칠 때 비게 된 run 은 버림 — Section.finalRuns)
  const fr = Section.finalRuns(p);
  const emptyCharPrId = chars.length ? null : (fr.find(r => !p.anchors.some(a => a.run === r && a.kind === 'ctrl'))?.charPr ?? fr.at(-1)?.charPr ?? '0');
  const text = chars.map(c => c.ch).join('');
  const fingerprint = hash({ styleId, paraPrId, runs: runs.map(r => [r.start, r.end, r.charPrId]), emptyCharPrId, semantic: formattingFingerprint(doc, ref) });
  return { ref, text, length: chars.length, styleId, paraPrId, paragraph: paraProps(doc.header, paraPrId, modernUnits(doc)), runs, emptyCharPrId, ...paragraphBreaks(sec, p), fingerprint };
}

/** cp별 모양을 현재 run에 적용한다. 컨트롤/메모 본문은 범위에 포함시키지 않는다. */
export function characterShapeEdits(sec, p, desired, emptyId = null) {
  const fc = Section.visibleChars(p, 'final'); const wanted = new Map(fc.map((c, i) => [c, desired[i] ?? c.run?.charPr ?? '0']));
  const edits = [];
  for (const run of p.runs) {
    const chars = p.chars.filter(c => c.run === run); const ctrl = p.anchors.some(a => a.run === run && a.kind === 'ctrl');
    const old = run.charPr; const runTok = sec.tokens[run.openTok]; const runOpen = sec.xml.slice(runTok.start, runTok.end);
    const target = c => wanted.get(c) ?? old;
    if (!chars.length) {
      if (emptyId !== null && !ctrl && old !== emptyId) edits.push({ start: runTok.start, end: runTok.end, text: setAttrs(runOpen, { charPrIDRef: emptyId }) });
      continue;
    }
    if (chars.every(c => target(c) === old)) continue;
    let current = ctrl ? old : target(chars[0]);
    if (current !== old) edits.push({ start: runTok.start, end: runTok.end, text: setAttrs(runOpen, { charPrIDRef: current }) });
    const split = (c, cp) => `</hp:t></hp:run>${setAttrs(runOpen, { charPrIDRef: cp })}${sec.xml.slice(c.t.openStart, c.t.openEnd)}`;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (target(c) !== current) { current = target(c); edits.push({ start: c.raw[0], text: split(c, current) }); }
      // hp:t 밖의 개체는 원래 run 모양으로 남긴다. 메모 본문은 자신의 문단/run을 가진다.
      if (ctrl && current !== old && chars[i + 1]?.t !== c.t) { edits.push({ start: c.raw[1], text: split(c, old) }); current = old; }
    }
  }
  if (!fc.length && emptyId !== null && !p.runs.some(r => !p.anchors.some(a => a.run === r && a.kind === 'ctrl'))) {
    const at = p.lineseg?.start ?? sec.tokens[p.closeTok].start;
    edits.push({ start: at, text: `<hp:run charPrIDRef="${escapeAttr(emptyId)}"><hp:t/></hp:run>` });
  }
  return edits;
}

function paragraphEdits(sec, p, patch) {
  const t = sec.tokens[p.openTok]; const old = sec.xml.slice(t.start, t.end); const next = setAttrs(old, patch);
  return next === old ? [] : [{ start: t.start, end: t.end, text: next }];
}
/**
 * 탭 글자(hp:tab)의 종류·채움·너비를 source 문단의 같은 차례 탭과 같게 — 글로 넣은 문단의 탭은 `<hp:tab/>` 이라 한/글이 왼쪽 탭으로
 * 그린다(차례의 오른쪽 탭·점선 채움이 사라져 쪽 번호가 가운데로 온다 — 2026-10-29 한/글 PDF 실측). 글이 같은 문단에만 부른다.
 */
function inlineTabEdits(source, sourceRef, sec, p) {
  const sp = source.resolve(sourceRef);
  const tabs = (q) => Section.visibleChars(q, 'final').filter((c) => c.inline === 'hp:tab');
  const S = tabs(sp.p); const T = tabs(p);
  if (!S.length || S.length !== T.length) return [];
  const out = [];
  S.forEach((s, i) => {
    const sx = sp.sec.xml.slice(s.raw[0], s.raw[1]); const t = T[i];
    if (sec.xml.slice(t.raw[0], t.raw[1]) !== sx) out.push({ start: t.raw[0], end: t.raw[1], text: sx });
  });
  return out;
}

function commit(doc, sec, p, edits, header) {
  if (edits.length) for (const ls of Section.linesegs(p)) edits.push({ start: ls.start, end: ls.end, text: '' }); // [hwpx-cowork] member 마다
  const xml = apply(sec.xml, edits);
  // 먼저 구역을 바꿔 끼우고 헤더는 그 뒤에 — 읽다가 실패하면 기존 문서·헤더가 그대로 남는다.
  // [hwpx-cowork] (2026-11-16) Section.load 는 새 상태를 다 만든 뒤에만 바꿔 끼운다. 예전에는 같은 XML 을 버리는 파싱으로 한 번 더 읽었다(큰 구역에서 50ms+)
  if (xml !== sec.xml) sec.load(xml);
  if (header) doc.header.xml = header.xml;
}

export function formatRange(doc, ref, input) {
  const spec = validateFormatSpec(input); const { sec, p } = doc.resolve(ref); const before = inspectFormatting(doc, ref);
  if (!Number.isSafeInteger(spec.start) || !Number.isSafeInteger(spec.end) || spec.end > before.length) fail('RANGE', `범위가 문단 밖입니다 (0..${before.length})`);
  if (spec.expectedFingerprint && spec.expectedFingerprint !== before.fingerprint) fail('FORMAT_CONFLICT', '문단의 글 또는 서식이 바뀌었습니다. 다시 조회하세요');
  const header = new doc.header.constructor(doc.header.xml);
  const style = spec.styleId === undefined ? null : formattingCatalog(doc).styles.find(s => s.id === spec.styleId);
  if (spec.styleId !== undefined && !style) fail('NO_FORMAT', `스타일 ${spec.styleId}를 찾을 수 없습니다`);
  const paraStyle = style && !['CHAR', 'CHARACTER'].includes(style.type);
  const changesPara = paraStyle || spec.paraPrId !== undefined || Object.keys(spec.paragraph || {}).length > 0;
  if (changesPara && (spec.start !== 0 || spec.end !== before.length)) fail('FORMAT_PARAGRAPH_RANGE', '문단모양과 문단 스타일은 문단 전체 범위를 지정하세요');
  const changesChar = !!style || spec.charPrId !== undefined || Object.keys(spec.char || {}).length > 0;
  if (changesChar && spec.start === spec.end && before.length) fail('RANGE', '글자모양에는 비어 있지 않은 선택 범위가 필요합니다');
  const fc = Section.visibleChars(p, 'final'); const desired = fc.map(c => c.run?.charPr ?? '0'); const cache = new Map();
  const variant = original => { const base = spec.charPrId ?? style?.charPrId ?? original; if (!cache.has(base)) cache.set(base, charVariant(header, base, spec.char)); return cache.get(base); };
  if (changesChar) for (let i = spec.start; i < spec.end; i++) desired[i] = variant(desired[i]);
  const emptyId = changesChar && !before.length ? variant(before.emptyCharPrId) : null;
  const edits = characterShapeEdits(sec, p, desired, emptyId);
  const pp = changesPara ? paraVariant(header, spec.paraPrId ?? (paraStyle ? style.paraPrId : before.paraPrId), spec.paragraph, modernUnits(doc)) : before.paraPrId;
  // 쪽 나눔(pageBreakBefore): 켜기는 문단 태그 pageBreak="1"(새 문단 모양이 이미 켜 두었으면 그대로), 끄기는 문단 태그 "0"(문단 모양은 paraVariant 가 껐다)
  const wantBreak = spec.paragraph?.pageBreakBefore; const tagBreak = {};
  if (typeof wantBreak === 'boolean') {
    if (NESTED_REF.test(String(ref))) fail('FORMAT_SPEC', '쪽 나눔(pageBreakBefore)은 본문 문단에만 줄 수 있습니다(표 칸·글상자 안 문단은 안 됨)');
    if (!wantBreak) tagBreak.pageBreak = '0';
    else if (!before.pageBreak && !paraPrBreakBefore(header, pp)) tagBreak.pageBreak = '1';
  }
  edits.push(...paragraphEdits(sec, p, { paraPrIDRef: pp, ...(paraStyle ? { styleIDRef: style.id } : {}), ...tagBreak }));
  commit(doc, sec, p, edits, header);
  const after = inspectFormatting(doc, ref); const changed = before.fingerprint !== after.fingerprint;
  return { changed, ref, start: spec.start, end: spec.end, before, after, undo: changed ? { ref, before, afterFingerprint: after.fingerprint } : null };
}

/**
 * [hwpx-cowork] 여러 문단의 서식을 한 번에 바꾼다(2026-11-18 — 문단 전체에만: 스타일·글자 모양·문단 모양). formatRange 를 문단마다 부르면 문단마다
 * 서식 목록을 읽고 구역을 다시 읽는다(문단 2,400개 구역에서 문단 하나에 90ms — 표 칸 2,500개면 4분). 여기서는 모양 변형을 바탕 번호마다 한 번만 만들고,
 * 고칠 자리를 구역별로 모아 구역마다 한 번만 다시 읽는다. 문단 하나의 결과는 formatRange(문단 전체 범위)와 같다(시험 tests/format_paragraphs.test.mjs).
 * refs: 문단 주소(본문·표 칸·글상자 안 — 겹쳐도 한 번만), input: { styleId?, char?, paragraph? }. 쪽 나눔(pageBreakBefore)·범위·모양 번호 직접 지정은 받지 않는다.
 * 실패하면 문서는 그대로다(구역·머리를 모두 계산한 뒤에 바꿔 끼운다). → { changed(서식이 바뀐 문단 수), total }
 */
export function formatParagraphs(doc, refs, input, styleChange = null) {
  // 스타일 교체·갱신에서는 지정한 속성만 바꾼다. 기존 format(styleId)의 전체 서식 적용 계약은 그대로 사용한다.
  const spec = styleChange && !Object.keys(input).length ? {} : validateFormatSpec(input);
  if (['start', 'end', 'expectedFingerprint', 'charPrId', 'paraPrId'].some(k => spec[k] !== undefined)) fail('FORMAT_SPEC', '여러 문단 서식은 스타일·글자모양·문단모양만 받습니다');
  if (spec.paragraph?.pageBreakBefore !== undefined) fail('FORMAT_SPEC', '쪽 나눔(pageBreakBefore)은 문단 하나씩 주세요');
  if (!Array.isArray(refs)) fail('FORMAT_SPEC', '문단 주소 목록이 필요합니다');
  const header = new doc.header.constructor(doc.header.xml);
  const style = spec.styleId === undefined ? null : formattingCatalog(doc).styles.find(s => s.id === spec.styleId);
  if (spec.styleId !== undefined && !style) fail('NO_FORMAT', `스타일 ${spec.styleId}를 찾을 수 없습니다`);
  const paraStyle = !!style && !['CHAR', 'CHARACTER'].includes(style.type);
  const changesPara = paraStyle || !!styleChange || Object.keys(spec.paragraph || {}).length > 0;
  const changesChar = !!style || Object.keys(spec.char || {}).length > 0;
  if (!changesPara && !changesChar) fail('FORMAT_SPEC', '바꿀 서식(스타일·글자모양·문단모양)이 없습니다');
  const modern = modernUnits(doc); const chars = new Map(); const paras = new Map();
  const charOf = original => { const base = style?.charPrId ?? original; if (!chars.has(base)) chars.set(base, charVariant(header, base, spec.char)); return chars.get(base); };
  const heading = styleChange && spec.paragraph?.heading ? elements(shape(header, 'paraPr', styleChange.paraPrId), 'hh:heading')[0]?.xml : null;
  const resolvedHeading = heading ? Object.fromEntries(attrs(heading, open(heading))) : null;
  const paraOf = original => {
    if (styleChange && original === styleChange.baseParaPrId) return styleChange.paraPrId;
    const base = paraStyle ? style.paraPrId : original;
    if (!paras.has(base)) paras.set(base, paraVariant(header, base, spec.paragraph, modern, style?.charPrId, resolvedHeading));
    return paras.get(base);
  };
  const bySec = new Map(); const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref)) continue; seen.add(ref);
    const { sec, p } = doc.resolve(ref);
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(p);
  }
  let changed = 0; const next = [];
  for (const [sec, list] of bySec) {
    const edits = [];
    for (const p of list) {
      const mine = [];
      if (changesChar) {
        const fc = Section.visibleChars(p, 'final'); let emptyId = null;
        if (!fc.length) {   // 빈 문단: inspectFormatting 의 emptyCharPrId 와 같은 run 의 모양을 바꾼다
          const fr = Section.finalRuns(p);
          emptyId = charOf(fr.find(r => !p.anchors.some(a => a.run === r && a.kind === 'ctrl'))?.charPr ?? fr.at(-1)?.charPr ?? '0');
        }
        mine.push(...characterShapeEdits(sec, p, fc.map(c => charOf(c.run?.charPr ?? '0')), emptyId));
      }
      if (changesPara) mine.push(...paragraphEdits(sec, p, { paraPrIDRef: paraOf(attr(sec.xml, sec.tokens[p.openTok], 'paraPrIDRef') ?? '0'), ...(paraStyle || styleChange ? { styleIDRef: styleChange?.id ?? style.id } : {}) }));
      if (!mine.length) continue;
      changed++;
      for (const ls of Section.linesegs(p)) mine.push({ start: ls.start, end: ls.end, text: '' });   // 저장된 줄 정보는 서식이 바뀌면 맞지 않는다(commit 과 같다)
      edits.push(...mine);
    }
    // 고칠 자리가 수천이라 조각을 한 번만 잇는다(applyDisjoint — 자리마다 구역 글 전체를 복사하지 않는다). 문단마다 자리가 겹치지 않는다
    if (edits.length) next.push([sec, applyDisjoint(sec.xml, edits)]);
  }
  for (const [sec, xml] of next) if (xml !== sec.xml) sec.load(xml);
  doc.header.xml = header.xml;
  return { changed, total: seen.size };
}

/** 메모의 추가/수정은 허용하되 글·서식이 달라진 뒤에는 되돌리지 않는다. */
export function undoFormatting(doc, undo) {
  if (!dict(undo) || !dict(undo.before) || undo.ref !== undo.before.ref) fail('FORMAT_SPEC', '서식 복원 정보가 올바르지 않습니다');
  const current = inspectFormatting(doc, undo.ref); const before = undo.before;
  if (current.fingerprint !== undo.afterFingerprint || current.text !== before.text) fail('FORMAT_CONFLICT', '서식 적용 뒤 문단의 글 또는 서식이 바뀌어 되돌리지 않았습니다');
  const { sec, p } = doc.resolve(undo.ref); const desired = Array(current.length);
  for (const run of before.runs) { shape(doc.header, 'charPr', run.charPrId); for (let i = run.start; i < run.end; i++) desired[i] = run.charPrId; }
  if (Array.from(desired).some(v => v === undefined) || before.length !== current.length) fail('FORMAT_SPEC', '서식 복원 범위가 올바르지 않습니다');
  shape(doc.header, 'paraPr', before.paraPrId);
  const edits = characterShapeEdits(sec, p, desired, before.emptyCharPrId);
  edits.push(...paragraphEdits(sec, p, { paraPrIDRef: before.paraPrId, styleIDRef: before.styleId, ...breakPatch(before, current) }));
  commit(doc, sec, p, edits);
  return { changed: true, ref: undo.ref, after: inspectFormatting(doc, undo.ref) };
}

export function validateTextFormatting(text, { format, runs } = {}) {
  if (format !== undefined) {
    validateFormatSpec(format);
    if (['start', 'end', 'expectedFingerprint'].some(k => Object.hasOwn(format, k))) fail('FORMAT_SPEC', '삽입 서식의 범위는 넣을 글 전체입니다');
  }
  if (runs !== undefined) {
    if (!Array.isArray(runs) || runs.length > 1000 || runs.some(r => !dict(r) || typeof r.text !== 'string')) fail('FORMAT_SPEC', '서식 run 목록이 올바르지 않습니다');
    if (runs.map(r => r.text).join('') !== text) fail('FORMAT_SPEC', '서식 run의 글을 합친 결과가 넣을 글과 다릅니다');
    if (runs.map(r => normalizedInsertedText(r.text)).join('') !== normalizedInsertedText(text)) fail('FORMAT_SPEC', '서식 run 경계가 줄바꿈 문자 안에 있습니다');
    for (const run of runs) {
      keys(run, ['text', 'charPrId', 'char'], '서식 run');
      if (run.charPrId !== undefined || Object.keys(run.char || {}).length) validateFormatSpec({ ...(run.charPrId !== undefined ? { charPrId: run.charPrId } : {}), ...(run.char !== undefined ? { char: run.char } : {}) });
      else if (run.char !== undefined) keys(run.char, CHAR_KEYS, '글자모양');
    }
  }
}

// doc.inlineXml과 같은 XML 문자 정리. CRLF/금지 문자를 좌표 계산에 세지 않는다.
export function normalizedInsertedText(text) { return decodeEntities(escapeText(String(text).replace(/\r\n/g, '\n'))); }

export function formattingTransaction(doc, operation) {
  const header = doc.header.xml; const sections = doc.sections.map(s => s.xml);
  try { return operation(); }
  catch (e) { doc.header.xml = header; doc.sections.forEach((s, i) => { if (s.xml !== sections[i]) s.load(sections[i]); }); throw e; }
}

export function applyInsertedFormatting(doc, ref, start, text, options, shapeIds) {
  const { format, runs } = options; const { sec, p } = doc.resolve(ref); const fc = Section.visibleChars(p, 'final');
  const desired = fc.map(c => c.run?.charPr ?? '0'); const length = Array.from(normalizedInsertedText(text)).length;
  for (let i = 0; i < length; i++) if (shapeIds?.[i] !== undefined) desired[start + i] = shapeIds[i];
  commit(doc, sec, p, characterShapeEdits(sec, p, desired));
  if (format !== undefined) formatRange(doc, ref, { ...format, start, end: start + length });
  if (runs !== undefined) {
    let at = start;
    for (const run of runs) {
      const size = Array.from(normalizedInsertedText(run.text)).length;
      if (size && (run.charPrId !== undefined || Object.keys(run.char || {}).length)) formatRange(doc, ref, { start: at, end: at + size, ...(run.charPrId !== undefined ? { charPrId: run.charPrId } : {}), ...(run.char !== undefined ? { char: run.char } : {}) });
      at += size;
    }
  }
}

const REFERENCES = { charPrIDRef: ['charProperties', 'charPr'], paraPrIDRef: ['paraProperties', 'paraPr'], borderFillIDRef: ['borderFills', 'borderFill'], tabPrIDRef: ['tabProperties', 'tabPr'], styleIDRef: ['styles', 'style'], nextStyleIDRef: ['styles', 'style'] };
const LISTS = { charPr: 'charProperties', paraPr: 'paraProperties', borderFill: 'borderFills', tabPr: 'tabProperties', style: 'styles', numbering: 'numberings', bullet: 'bullets' };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function fontXml(header, lang, fontId) {
  return fontIndex(header).byLang.get(lang.toUpperCase())?.get(String(fontId));
}
function headingRef(tokenAttrs) {
  const type = tokenAttrs.get('type');
  return type === 'BULLET' ? 'bullet' : ['NUMBER', 'OUTLINE'].includes(type) ? 'numbering' : null;
}
function binaryFingerprint(doc, resourceId) {
  const manifest = doc.container?.getText('Contents/content.hpf') || '';
  const item = scan(manifest).find(t => t.name === 'opf:item' && attr(manifest, t, 'id') === resourceId);
  const href = item && attr(manifest, item, 'href');
  const bytes = href && (doc.container.getBytes(href.replace(/^\.\//, '')) || doc.container.getBytes(href.replace(/^\.\.\//, '')) || doc.container.getBytes(`Contents/${href}`));
  return bytes ? createHash('sha256').update(bytes).digest('hex') : `missing-binary:${resourceId}`;
}
// [hwpx-cowork] 글자모양의 독립 속성은 순서가 달라도 같은 뜻이다.
// 한/글이 끝에 둔 <hh:bold/>를 rhwp가 underline 앞에 쓰는 것만으로
// 수천 문단이 변경됐다고 판단하지 않는다. 알려진 단일 속성만 정렬하며
// 알 수 없는 요소·중복 속성·중첩 내용의 순서는 보존한다.
const CHAR_PROPERTY_ORDER = ['fontRef', 'ratio', 'spacing', 'relSz', 'offset', 'italic', 'bold', 'underline', 'strikeout', 'outline', 'shadow', 'emboss', 'engrave', 'supscript', 'subscript'].map(name => `hh:${name}`);
const CHAR_PROPERTY_CHILDREN = new Set(CHAR_PROPERTY_ORDER);
function canonicalCharPropertyOrder(xml) {
  const tokens = scan(xml); const root = tokens.find(t => t.type === 'open');
  if (root?.name !== 'hh:charPr') return xml;
  const children = []; const seen = new Set(); let depth = 0; let start; let close;
  for (const token of tokens) {
    if (token.type === 'text' && depth === 1 && xml.slice(token.start, token.end).trim()) return xml;
    if (token.type === 'open' || token.type === 'selfclose') {
      if (depth === 1) {
        if (!CHAR_PROPERTY_CHILDREN.has(token.name) || seen.has(token.name)) return xml;
        seen.add(token.name); start = token.start;
        if (token.type === 'selfclose') children.push({ name: token.name, xml: xml.slice(start, token.end) });
      }
      if (token.type === 'open') depth++;
    } else if (token.type === 'close') {
      depth--;
      if (depth === 1) children.push({ name: token.name, xml: xml.slice(start, token.end) });
      if (depth === 0) close = token.start;
    }
  }
  if (close === undefined || depth !== 0) return xml;
  return xml.slice(0, root.end) + children.sort((a, b) => CHAR_PROPERTY_ORDER.indexOf(a.name) - CHAR_PROPERTY_ORDER.indexOf(b.name)).map(c => c.xml).join('') + xml.slice(close);
}
function canonicalXml(xml, resolve, font, binary = value => value) {
  xml = canonicalCharPropertyOrder(xml);
  const out = []; let first = true;
  for (const token of scan(xml)) {
    if (token.type === 'other' || (token.type === 'text' && !xml.slice(token.start, token.end).trim())) continue;
    if (token.type === 'text') { out.push(['text', xml.slice(token.start, token.end)]); continue; }
    const values = attrs(xml, token);
    if (first) { values.delete('id'); first = false; }
    // [hwpx-cowork] 2026-11-12 그리지 않는 취소선 모양(3D 등)은 NONE 과 같은 뜻. 아니면 한/글 2018 문서(strikeout shape="3D")를 편집기에서
    // 손대지 않고 저장해도 그 글자모양을 쓰는 모든 문단(691개)이 서식 변경으로 잡히고, 같은 정의를 새 번호로 또 들였다.
    if (token.name === 'hh:strikeout' && values.has('shape') && !STRIKE_SHAPES.includes(values.get('shape'))) values.set('shape', 'NONE');
    for (const [key, value] of values) {
      if (key === 'binaryItemIDRef') values.set(key, binary(value));
      else if (REFERENCES[key]) values.set(key, resolve(REFERENCES[key][1], value));
      else if (token.name === 'hh:fontRef' && LANGS.includes(key)) values.set(key, font(key, value));
      else if (token.name === 'hh:heading' && key === 'idRef' && headingRef(values)) values.set(key, resolve(headingRef(values), value));
    }
    // <tag/>와 <tag></tag>는 같은 정의다.
    if (token.type === 'close') out.push(['end', token.name]);
    else { out.push(['start', token.name, [...values].sort(([a], [b]) => a.localeCompare(b))]); if (token.type === 'selfclose') out.push(['end', token.name]); }
  }
  return out;
}
function semanticFormats(doc) {
  const previous = doc._semanticFormats;
  // 정의의 번호가 같아도 header나 그림 자원이 바뀌면 의미가 달라진다.
  // 문서/컨테이너 객체도 구분하여 같은 revision 번호의 다른 사본을 재사용하지 않는다.
  if (previous?.header !== doc.header || previous?.container !== doc.container || previous?.xml !== doc.header.xml || previous?.revision !== doc.container?.revision) {
    doc._semanticFormats = { header: doc.header, container: doc.container, xml: doc.header.xml, revision: doc.container?.revision, cache: new Map(), hashes: new Map(), sections: new WeakMap() };
  }
  return doc._semanticFormats;
}
function semanticShape(doc, tag, shapeId, visiting = new Set()) {
  const cache = semanticFormats(doc).cache; const key = `${tag}/${shapeId}`;
  if (cache.has(key)) return cache.get(key);
  const xml = doc.header.block(tag, shapeId);
  if (!xml) return `missing:${tag}:${shapeId}`;
  if (visiting.has(key)) return ['cycle', tag, attrXml(xml, 'name'), attrXml(xml, 'engName')];
  const next = new Set(visiting); next.add(key);
  const value = canonicalXml(xml, (type, value) => semanticShape(doc, type, value, next), (lang, value) => {
    const font = fontXml(doc.header, lang, value);
    return font ? canonicalXml(font, (t, v) => semanticShape(doc, t, v, next), () => null, value => binaryFingerprint(doc, value)) : `missing-font:${lang}:${value}`;
  }, value => binaryFingerprint(doc, value));
  // 순환 스타일을 방문한 경로는 캐시하지 않아 시작점에 따라 값이 달라지지 않게 한다.
  if (!visiting.size) cache.set(key, value);
  return value;
}
function semanticShapeHash(doc, tag, shapeId) {
  const hashes = semanticFormats(doc).hashes; const key = `${tag}/${shapeId}`;
  // 한 정의를 수천 문단에서 써도 정규화 XML의 SHA-256은 한 번만 계산한다.
  if (!hashes.has(key)) hashes.set(key, hash(semanticShape(doc, tag, shapeId)));
  return hashes.get(key);
}
function semanticParagraphEntry(doc, ref) {
  // ref는 삽입/삭제 뒤 다른 문단을 가리킬 수 있으므로 항상 현재 모델에서 찾는다.
  const { sec, p } = doc.resolve(ref); const formats = semanticFormats(doc);
  let section = formats.sections.get(sec);
  if (!section || section.loadSeq !== sec.loadSeq || section.xml !== sec.xml) {
    section = { loadSeq: sec.loadSeq, xml: sec.xml, paragraphs: new WeakMap() }; formats.sections.set(sec, section);
  }
  let entry = section.paragraphs.get(p);
  if (entry) return entry;
  const chars = Section.visibleChars(p, 'final');
  const style = attr(sec.xml, sec.tokens[p.openTok], 'styleIDRef') ?? '0'; const para = attr(sec.xml, sec.tokens[p.openTok], 'paraPrIDRef') ?? '0';
  const ids = new Map(); const charKey = id => { if (!ids.has(id)) ids.set(id, semanticShapeHash(doc, 'charPr', id)); return ids.get(id); };
  // 나누기는 걸린 문단만 지문에 넣는다 — 나누기 없는 문단의 지문은 예전과 같다(열린 변경 요청의 기준 지문이 그대로 맞게)
  const on = paragraphBreaks(sec, p); const breaks = BREAKS.filter(([k]) => on[k]).map(([k]) => k).join(',');
  entry = { value: { text: chars.map(c => c.ch).join(''), paragraph: semanticShapeHash(doc, 'paraPr', para), style: semanticShapeHash(doc, 'style', style), chars: chars.map(c => charKey(c.run?.charPr ?? '0')), empty: chars.length ? null : charKey(Section.lastLiveRun(p)?.charPr ?? '0'), ...(breaks ? { breaks } : {}) } };
  section.paragraphs.set(p, entry); return entry;
}
function semanticParagraph(doc, ref) { return semanticParagraphEntry(doc, ref).value; }
export function formattingFingerprint(doc, ref) {
  // diff・서식 검사・저장 후 clean 판정이 같은 문단을 반복해서 읽는다.
  // 구역 재해석/정의 변경 전까지만 글과 서식을 포함한 기존 지문을 재사용한다.
  const entry = semanticParagraphEntry(doc, ref); return entry.fingerprint ??= hash(entry.value);
}
/** 글 교체 자체가 예측하는 혼합모양과 수정본을 비교한다(단순 글 수정은 false). */
export function formattingChanged(base, baseRef, head, headRef) {
  const a = semanticParagraph(base, baseRef); const b = semanticParagraph(head, headRef);
  if (a.paragraph !== b.paragraph || a.style !== b.style || (a.breaks ?? '') !== (b.breaks ?? '')) return true;
  if (!a.text && !b.text) return a.empty !== b.empty;
  const old = Array.from(a.text, (ch, i) => ({ ch, run: { charPr: a.chars[i] } }));
  const projected = replacementShapes(old, b.text, a.empty ?? a.chars[0]);
  return projected.length !== b.chars.length || projected.some((x, i) => x !== b.chars[i]);
}

function importFont(source, target, lang, sourceId, candidates) {
  const header = target.header;
  const xml = fontXml(source.header, lang, sourceId); if (!xml) fail('NO_FORMAT', `글꼴 ${lang}/${sourceId}를 찾을 수 없습니다`);
  const norm = (x, owner) => JSON.stringify(canonicalXml(x, (t, v) => `${t}:${v}`, () => null, value => binaryFingerprint(owner, value)));
  let names = candidates.get(lang);
  if (!names) {
    names = new Map();
    for (const [id, font] of fontIndex(header).byLang.get(lang.toUpperCase()) || []) {
      const key = norm(font, target); if (!names.has(key)) names.set(key, id);
    }
    candidates.set(lang, names);
  }
  const wanted = norm(xml, source); const same = names.get(wanted);
  if (same !== undefined) return same;
  const group = elements(header.xml, 'hh:fontface').find(t => attrXml(t.xml, 'lang') === lang.toUpperCase());
  if (!group) fail('FORMAT_UNSUPPORTED', `대상 글꼴 목록 ${lang}가 없습니다`);
  const list = elements(group.xml, 'hh:font');
  // [hwpx-cowork] rhwp writes nonembedded substFont with an empty binaryItemIDRef.
  // Inspect every font/substitute node's values: attribute presence alone rejected
  // normal HFT fallback definitions on live-save after a successful paste.
  const embedded = scan(xml).some(t => (t.type === 'open' || t.type === 'selfclose')
    && (['1', 'true'].includes(attr(xml, t, 'isEmbedded')) || !!attr(xml, t, 'binaryItemIDRef')?.trim()));
  if (embedded) fail('FORMAT_UNSUPPORTED', '포함 글꼴은 대상 문서에 같은 자원이 있어야 복사할 수 있습니다');
  const next = String(list.reduce((n, t) => Math.max(n, Number(attrXml(t.xml, 'id')) + 1), 0));
  const item = rootAttrs(xml, { id: next }); let updated = rootAttrs(group.xml, { fontCnt: list.length + 1 });
  updated = group.type === 'selfclose' ? updated.replace(/\/>$/, `>${item}</hh:fontface>`) : updated.replace('</hh:fontface>', `${item}</hh:fontface>`);
  header.xml = header.xml.slice(0, group.start) + updated + header.xml.slice(group.blockEnd);
  names.set(wanted, next);
  return next;
}

/** 참조 문서의 서식 정의를 복사하고 ID 참조를 재매핑한다(쪽·단 나누기도 옮긴다). 본문/메모/개체는 복사하지 않는다. */
export function copyFormattingFrom(doc, source, sourceRef, targetRef) {
  const sourceInfo = inspectFormatting(source, sourceRef); const before = inspectFormatting(doc, targetRef);
  const { header, imported, remember } = formatImporter(doc, source);
  const { sec, p, edits } = formattingCopyEdits(doc, source, sourceRef, targetRef, sourceInfo, before, imported);
  commit(doc, sec, p, edits, header);
  remember();
  const after = inspectFormatting(doc, targetRef); const changed = before.fingerprint !== after.fingerprint;
  return { changed, ref: targetRef, before, after, undo: changed ? { ref: targetRef, before, afterFingerprint: after.fingerprint } : null };
}

/**
 * Keep copied style definitions, including names not referenced by body paragraphs.
 * [hwpx-cowork] 2026-11-04 받는 문서에 이름이 같은 스타일이 이미 있으면 옮기지 않는다(새 이름 스타일만 — 한/글 붙여넣기도 같은 이름이면
 * 받는 문서 스타일을 쓴다, docs/CLIPBOARD_AND_FORMAT_COPY.md). 편집기(rhwp) 내보내기는 손대지 않은 정의도 다르게 적는다 — 한/글 기본
 * 개요 8~10 문단 모양의 `hp:switch`(2016/paragraph 개요 수준) 를 기본값 heading NONE 하나로. 뜻 비교만으로 옮기면 글만 친 실시간 밀어
 * 넣기·변경 요청 반영마다 같은 이름 스타일(개요 8~10)이 하나씩 더 생기고 서식 커밋이 되어, 다른 창은 글 맞추기(V4 §2.5) 대신 편집기를
 * 다시 열었다(test:ui:studio [8]·[13b], test:live '손대지 않은 작업본 → 커밋 없음'). 본문 문단이 쓰는 스타일의 정의 차이는 문단 서식
 * 복사(copyFormattingFrom)가 따로 맡는다.
 */
export async function copyStyleDefinitionsFrom(doc, source) {
  const before = doc.header.xml; const sourceBefore = source.header.xml;
  const { header, imported, remember } = formatImporter(doc, source);
  const names = new Set(elements(doc.header.xml, 'hh:style').map(t => attrXml(t.xml, 'name')).filter(Boolean));
  let count = 0;
  for (const item of elements(source.header.xml, 'hh:style')) {
    const name = attrXml(item.xml, 'name');
    if (name && names.has(name)) continue;
    imported('style', attrXml(item.xml, 'id'));
    if (++count % 8 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  if (doc.header.xml !== before || source.header.xml !== sourceBefore) fail('FORMAT_CONFLICT', '스타일 정의 복사 중 문서가 바뀌었습니다');
  doc.header.xml = header.xml;
  remember();
  return { changed: before !== header.xml };
}

/** 실험 편집의 동기 트랜잭션용. 번호·글머리표·글꼴 참조도 기존 importer로 함께 옮긴다. */
export function copyStyleDefinitionsFromSync(doc, source) {
  const before = doc.header.xml;
  const { header, imported, remember } = formatImporter(doc, source);
  const names = new Set(elements(doc.header.xml, 'hh:style').map(t => attrXml(t.xml, 'name')).filter(Boolean));
  for (const item of elements(source.header.xml, 'hh:style')) {
    if (!names.has(attrXml(item.xml, 'name'))) imported('style', attrXml(item.xml, 'id'));
  }
  doc.header.xml = header.xml; remember();
  return { changed: before !== header.xml };
}

/** 임의 XML 없이 기존 스타일을 바탕으로 이름 있는 문단/글자 스타일을 정의한다. */
export function defineStyle(doc, { name, baseStyle, type = 'PARA', format = {}, update = false, applyToBase = false }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f<>]/.test(name)) fail('FORMAT_SPEC', '스타일 이름을 확인하세요');
  const list = styleDefinitions(doc);
  if (!update && list.some(s => s.name.trim() === name.trim())) fail('STYLE_EXISTS', `이미 있는 스타일입니다: ${name}`);
  if (applyToBase && !baseStyle) fail('FORMAT_SPEC', 'applyToBase에는 기준 문단 스타일(base)이 필요합니다');
  const base = update ? namedStyle(doc, name, list) : baseStyle == null ? list.find(s => s.id === '0') || list[0] : namedStyle(doc, baseStyle, list);
  if (!base) fail('NO_STYLE', `스타일 「${update ? name : baseStyle}」을 찾지 못했습니다. read(view='styles')에서 실제 이름을 확인하세요`);
  if ((update || applyToBase) && (base.type !== 'PARA' || type !== 'PARA')) fail('FORMAT_SPEC', '스타일 전체 적용은 사용 문단을 식별할 수 있는 문단 스타일(PARA)에 씁니다');
  if (!['PARA', 'CHAR'].includes(type)) fail('FORMAT_SPEC', '스타일 종류는 PARA/CHAR입니다');
  const spec = !update && !Object.keys(format).length ? {} : validateFormatSpec(format);
  if (spec.styleId != null || spec.charPrId != null || spec.paraPrId != null || spec.start != null || spec.end != null) fail('FORMAT_SPEC', '정의할 char/paragraph 값만 전달하세요');
  if (type === 'CHAR' && spec.paragraph) fail('FORMAT_SPEC', '글자 스타일에는 문단모양을 넣지 않습니다');
  const header = new doc.header.constructor(doc.header.xml);
  const charId = charVariant(header, base.charPrId, spec.char);
  const paraId = paraVariant(header, base.paraPrId, spec.paragraph, modernUnits(doc), charId);
  let styleId = base.id;
  if (update) {
    const original = shape(header, 'style', base.id);
    header.xml = header.xml.replace(original, () => rootAttrs(original, { paraPrIDRef: paraId, charPrIDRef: charId }));
  } else if (applyToBase) {
    // 기준 스타일이 다음 문단에서도 이어지는 목록이면 새 스타일도 이어진다. 장 제목 → 본문처럼 정해진 후속 스타일은 유지한다.
    const original = shape(header, 'style', base.id);
    const copy = rootAttrs(original, { name: name.trim(), engName: '', paraPrIDRef: paraId, charPrIDRef: charId });
    styleId = header.addItem('styles', 'style', copy);
    if (attrXml(original, 'nextStyleIDRef') === base.id) {
      const added = shape(header, 'style', styleId);
      header.xml = header.xml.replace(added, () => rootAttrs(added, { nextStyleIDRef: styleId }));
    }
  } else {
    styleId = header.addItem('styles', 'style', `<hh:style id="0" type="${type}" name="${escapeAttr(name.trim())}" engName="" paraPrIDRef="${paraId}" charPrIDRef="${charId}" nextStyleIDRef="${base.id}" langID="1042" lockForm="0"/>`);
  }
  const out = { id: String(styleId), name: update ? base.name : name.trim(), type };
  if (!update && !applyToBase) { doc.header.xml = header.xml; return out; }
  const refs = styleUsage(doc).get(base.id) || [];
  if (applyToBase && !refs.length) fail('NO_PARAGRAPH', `「${base.name}」을 쓰는 문단이 없습니다. 정의만 만들려면 applyToBase를 빼세요`);
  return formattingTransaction(doc, () => {
    doc.header.xml = header.xml;
    const result = formatParagraphs(doc, refs, spec, { id: out.id, baseParaPrId: base.paraPrId, paraPrId: paraId });
    return { ...out, ...result };
  });
}

function formattingCopyEdits(doc, source, sourceRef, targetRef, sourceInfo, before, imported) {
  if (sourceInfo.text !== before.text) fail('FORMAT_CONFLICT', '원본과 대상의 글이 달라 서식을 정확한 범위에 복사할 수 없습니다');
  const paraPrId = imported('paraPr', sourceInfo.paraPrId); const styleId = imported('style', sourceInfo.styleId);
  const desired = sourceInfo.runs.flatMap(r => Array(r.end - r.start).fill(imported('charPr', r.charPrId)));
  const emptyId = sourceInfo.emptyCharPrId === null ? null : imported('charPr', sourceInfo.emptyCharPrId);
  const { sec, p } = doc.resolve(targetRef); const edits = characterShapeEdits(sec, p, desired, emptyId);
  edits.push(...paragraphEdits(sec, p, { paraPrIDRef: paraPrId, styleIDRef: styleId, ...breakPatch(sourceInfo, before) }));
  edits.push(...inlineTabEdits(source, sourceRef, sec, p));
  return { sec, p, edits };
}

/** 본문·표 셀 등 서로 다른 문단들의 서식을 구역마다 한 번만 재해석해 복사한다. 전체 검증 뒤에만 반영한다. */
export async function copyFormattingBatch(doc, source, pairs) {
  const snapshot = owner => ({ header: owner.header.xml, revision: owner.container.revision, sections: owner.sections.map(sec => ({ sec, xml: sec.xml })) });
  const unchanged = (owner, before) => owner.header.xml === before.header && owner.container.revision === before.revision && owner.sections.length === before.sections.length && before.sections.every(({ sec, xml }, i) => owner.sections[i] === sec && sec.xml === xml);
  const targetBefore = snapshot(doc); const sourceBefore = snapshot(source);
  const seen = new Set();
  for (const { sourceRef, targetRef } of pairs) {
      if (!/^s\d+\/p\d+(?:\/n\d+)*$/.test(sourceRef) || !/^s\d+\/p\d+(?:\/n\d+)*$/.test(targetRef)) fail('FORMAT_UNSUPPORTED', '일괄 서식 복사의 문단 주소가 올바르지 않습니다');
      const { p } = doc.resolve(targetRef);
      if (seen.has(p)) fail('FORMAT_UNSUPPORTED', '일괄 서식 복사는 서로 다른 문단에만 사용할 수 있습니다');
      seen.add(p);
  }
  const { header, imported, remember } = formatImporter(doc, source); const sections = new Map();
  for (const { sourceRef, targetRef } of pairs) {
    const sourceInfo = inspectFormatting(source, sourceRef); const before = inspectFormatting(doc, targetRef);
    const { sec, p, edits } = formattingCopyEdits(doc, source, sourceRef, targetRef, sourceInfo, before, imported);
    if (!edits.length) continue;
    for (const ls of Section.linesegs(p)) edits.push({ start: ls.start, end: ls.end, text: '' });
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(...edits);
    // 사본 헤더와 편집 후보를 준비하는 동안에도 생존 신호를 처리한다. 쓰기는 검증 후에만 한다.
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!unchanged(doc, targetBefore) || !unchanged(source, sourceBefore)) fail('FORMAT_CONFLICT', '일괄 서식 복사 중 문서가 바뀌었습니다');
    const prepared = [...sections].map(([sec, edits]) => ({ sec, xml: applyDisjoint(sec.xml, edits) }));
  for (const { sec, xml } of prepared) if (xml !== sec.xml) new Section(xml, sec.index);
  doc.header.xml = header.xml;
  for (const { sec, xml } of prepared) if (xml !== sec.xml) sec.load(xml);
  remember();
}

/**
 * source 문서의 XML 조각(다른 문서에서 옮겨 오는 그림 — 캡션 문단 등)이 참조하는 글자·문단 모양·스타일·테두리·탭 번호를 이 문서에서
 * 같은 정의의 번호로 바꾼 조각(없는 정의는 이 문서 머리에 더한다 — copyFormattingFrom 과 같은 규칙). 머리를 고쳤으면 doc.header 에 반영한다.
 */
export function importFormattingRefs(doc, source, xml) {
  const { header, imported, remember } = formatImporter(doc, source);
  const edits = [];
  for (const t of scan(xml)) if (t.type === 'open' || t.type === 'selfclose') {
    const patch = {};
    for (const [key, value] of attrs(xml, t)) if (REFERENCES[key]) patch[key] = imported(REFERENCES[key][1], value);
    if (Object.keys(patch).length) edits.push({ start: t.start, end: t.end, text: setAttrs(xml.slice(t.start, t.end), patch) });
  }
  const out = apply(xml, edits);
  doc.header.xml = header.xml;
  remember();
  return out;
}

/** 서식 정의 옮기기 도구: source 의 (종류, 번호) → 이 문서의 같은 정의 번호(없으면 머리 사본 header 에 더함). 다 쓰면 doc.header.xml = header.xml */
const completedImporters = new WeakMap();
const importDefinitionsXml = xml => xml.replace(/<hh:(trackChanges|trackChangeAuthors|trackchageConfig)\b[^>]*(?:\/>|>[\s\S]*?<\/hh:\1>)/g, '');
function formatImporter(doc, source) {
  // Reuse a completed import plan across paragraphs. Rebuilding all style/font
  // candidates for every paragraph blocks large native pastes for minutes.
  // Lease the plan exclusively: async preparatory work must never expose an
  // uncommitted header to another caller. Header/resource changes invalidate it.
  let owners = completedImporters.get(doc);
  if (!owners) { owners = new WeakMap(); completedImporters.set(doc, owners); }
  const previous = owners.get(source); owners.delete(source);
  if (previous && previous.sourceXml === source.header.xml && previous.targetRevision === doc.container?.revision && previous.sourceRevision === source.container?.revision && (previous.header.xml === doc.header.xml || importDefinitionsXml(previous.header.xml) === importDefinitionsXml(doc.header.xml))) {
    previous.plan.rebase(doc.header.xml); return previous.plan;
  }
  const header = new doc.header.constructor(doc.header.xml); const temp = { header, container: doc.container };
  const sourceXml = source.header.xml; const sourceRevision = source.container?.revision;
  const converted = formattingPartsFor(source, doc);
  const from = converted ? { header: converted.header, container: source.container } : source;
  const mapping = new Map(); const active = new Set();
  const fontCandidates = new Map();
  const candidates = new Map();
  // 이 importer는 기존 정의를 수정하지 않고 새 정의만 붙인다. 모든 참조가 해결된 정의는
  // 뒤에 항목이 늘어도 의미가 같다. 누락/순환/예약 스타일은 헤더가 바뀌면 다시 검사한다.
  const appendStable = value => !/"missing(?::|-font:)|"cycle"|__format_import_/.test(JSON.stringify(value));
  const definitions = tag => {
    let index = candidates.get(tag);
    if (index && (index.xml === header.xml || index.stable)) return index.ids;
    const ids = new Map(); let stable = true;
    for (const item of elements(header.xml, `hh:${tag}`)) {
      const candidate = attrXml(item.xml, 'id'); const semantic = semanticShape(temp, tag, candidate); const fingerprint = hash(semantic);
      stable &&= appendStable(semantic);
      if (!ids.has(fingerprint)) ids.set(fingerprint, candidate);
    }
    candidates.set(tag, { xml: header.xml, ids, stable }); return ids;
  };
  const imported = (tag, sourceId) => {
    const key = `${tag}/${sourceId}`; if (mapping.has(key)) return mapping.get(key);
    // [hwpx-cowork] HWPX borderFill은 1부터 번호를 붙이며 0은 테두리/채움 없음이다.
    // 정의 0이 없는 정상 문서에서 새 글자모양(예: 11→12pt)을 복사할 때
    // 'borderFill 0 누락'으로 저장을 거절하지 않고 원래의 없음 표식을 보존한다.
    // 실제 정의가 있는 0과 누락된 비영 참조는 기존 검증/재매핑을 그대로 따른다.
    if (tag === 'borderFill' && String(sourceId) === '0' && !source.header.block('borderFill', '0')) {
      if (header.block('borderFill', '0')) fail('FORMAT_UNSUPPORTED', '대상 문서에 borderFill 0 정의가 있어 테두리/채움 없음 참조를 안전하게 복사할 수 없습니다');
      mapping.set(key, '0'); return '0';
    }
    const original = shape(from.header, tag, sourceId); const semantic = semanticShape(from, tag, sourceId); const wanted = hash(semantic);
    const candidate = definitions(tag).get(wanted);
    if (candidate !== undefined) { mapping.set(key, candidate); return candidate; }
    if (/\bbinaryItemIDRef\s*=/.test(original)) fail('FORMAT_UNSUPPORTED', '그림 자원을 참조하는 서식은 대상 문서에 같은 자원이 있어야 복사할 수 있습니다');
    if (active.has(key)) fail('FORMAT_UNSUPPORTED', '순환 서식 참조를 안전하게 복사할 수 없습니다');
    active.add(key);
    let reserved = null;
    if (tag === 'style') {
      // nextStyle의 자기참조·상호참조를 위한 임시 예약. 성공한 뒤에만 원본 문서에 반영한다.
      reserved = header.addItem('styles', 'style', `<hh:style id="0" name="__format_import_${hash(key).slice(0, 16)}"/>`);
      mapping.set(key, reserved);
    }
    const edits = [];
    for (const t of scan(original)) if (t.type === 'open' || t.type === 'selfclose') {
      const as = attrs(original, t); const patch = {};
      for (const [key, value] of as) {
        // 한글 2018의 문단 번호 글자 모양 UINT32_MAX는 별도 모양이 없다는 표식이다.
        // 실제 charPr 번호로 가져오지 않고 번호 정의 안의 원래 표식을 보존한다.
        if (t.name === 'hh:paraHead' && key === 'charPrIDRef' && value === '4294967295') continue;
        if (REFERENCES[key]) patch[key] = imported(REFERENCES[key][1], value);
        else if (t.name === 'hh:fontRef' && LANGS.includes(key)) patch[key] = importFont(source, temp, key, value, fontCandidates);
        else if (t.name === 'hh:heading' && key === 'idRef' && headingRef(as)) {
          const kind = headingRef(as);
          if (source.header.block(kind, value)) patch[key] = imported(kind, value);
          else if (value !== '0') fail('NO_FORMAT', `문단 번호 모양 ${value}가 없습니다`);
        } else if (/IDRef$/.test(key) && !['binaryItemIDRef'].includes(key)) fail('FORMAT_UNSUPPORTED', `지원하지 않는 서식 참조입니다: ${key}`);
      }
      if (Object.keys(patch).length) edits.push({ start: t.start, end: t.end, text: setAttrs(original.slice(t.start, t.end), patch) });
    }
    let xml = apply(original, edits); let destination;
    if (reserved !== null) {
      xml = rootAttrs(xml, { id: reserved }); const placeholder = header.block('style', reserved); header.xml = header.xml.replace(placeholder, () => xml); destination = reserved;
    } else destination = header.addItem(LISTS[tag], tag, xml);
    const index = candidates.get(tag);
    if (index?.stable && appendStable(semantic) && !index.ids.has(wanted)) index.ids.set(wanted, destination);
    active.delete(key); mapping.set(key, destination); return destination;
  };
  const plan = { header, imported, rebase(xml) {
    const old = header.xml; header.xml = xml;
    for (const index of candidates.values()) if (index.xml === old) index.xml = xml;
    if (temp._semanticFormats?.xml === old) temp._semanticFormats.xml = xml;
  }, remember() {
    if (!active.size && doc.header.xml === header.xml && source.header.xml === sourceXml && source.container?.revision === sourceRevision) owners.set(source, { header, sourceXml, sourceRevision, targetRevision: doc.container?.revision, plan });
  } };
  return plan;
}

