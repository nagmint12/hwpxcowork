// 서식 조회·선택 범위 적용. 기존 모양 XML을 복제하여 명시한 속성만 바꾼다.
// 코드포인트 좌표는 최종본 기준이며 메모/개체/변경 표식은 다시 만들지 않는다.
import { createHash } from 'node:crypto';
import { Section } from './section.js';
import { EngineError } from './errors.js';
import { scan, attr, attrs, escapeAttr, escapeText, decodeEntities } from './xmlscan.js';
import { replacementShapes, projectTextFormats } from './format-projection.js';
export { replacementShapes, projectTextFormats } from './format-projection.js';

const fail = (code, message) => { throw new EngineError(code, message); };
const LANGS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
// [hwpx-cowork] 2026-10-30: 한/글 글자 모양의 자주 쓰는 속성 — 취소선·위첨자·아래첨자·장평·자간·음영 색도
const CHAR_KEYS = ['font', 'sizePt', 'bold', 'italic', 'underline', 'color', 'strikeout', 'superscript', 'subscript', 'ratioPct', 'spacingPct', 'shadeColor'];
// [hwpx-cowork] oneLine = 한/글 문단 모양 '한 줄로 입력'(hh:breakSetting lineWrap SQUEEZE — 넘치면 자간을 줄여 한 줄에)
const PARA_KEYS = ['align', 'lineSpacing', 'spaceBeforePt', 'spaceAfterPt', 'indentPt', 'leftMarginPt', 'rightMarginPt', 'oneLine'];
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
    keys(spec.paragraph, PARA_KEYS, '문단모양'); out.paragraph = { ...spec.paragraph };
    if (spec.paragraph.align !== undefined && !ALIGN.includes(spec.paragraph.align)) fail('FORMAT_SPEC', '문단 정렬이 올바르지 않습니다');
    for (const k of PARA_KEYS.filter(k => k.endsWith('Pt'))) if (spec.paragraph[k] !== undefined) number(spec.paragraph[k], k === 'indentPt' ? -10000 : 0, 10000, k);
    if (spec.paragraph.oneLine !== undefined && typeof spec.paragraph.oneLine !== 'boolean') fail('FORMAT_SPEC', 'oneLine(한 줄로 입력)은 true/false입니다');
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
function modernUnits(doc) { return Number(attrXml(doc.container.getText('version.xml'), 'xmlVersion', '1.5')) >= 1.4; }
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
function paraVariant(header, baseId, patch = {}, modern = true) {
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
  if (patch.oneLine !== undefined) {
    const bs = elements(xml, 'hh:breakSetting');
    if (!bs.length) fail('FORMAT_UNSUPPORTED', '줄 나눔 설정(hh:breakSetting) 요소가 없습니다');
    xml = patchElements(xml, 'hh:breakSetting', { lineWrap: patch.oneLine ? 'SQUEEZE' : 'BREAK' });
  }
  return xml === src ? String(baseId) : header.addItem('paraProperties', 'paraPr', xml);
}

export function formattingCatalog(doc) {
  const list = fonts(doc.header); const modern = modernUnits(doc);
  return {
    styles: elements(doc.header.xml, 'hh:style').map(t => ({ id: attrXml(t.xml, 'id'), name: attrXml(t.xml, 'name'), engName: attrXml(t.xml, 'engName'), type: attrXml(t.xml, 'type', 'PARA'), charPrId: attrXml(t.xml, 'charPrIDRef', '0'), paraPrId: attrXml(t.xml, 'paraPrIDRef', '0') })),
    charProperties: elements(doc.header.xml, 'hh:charPr').map(t => { const id = attrXml(t.xml, 'id'); return { id, props: charProps(doc.header, id, list) }; }),
    paragraphProperties: elements(doc.header.xml, 'hh:paraPr').map(t => { const id = attrXml(t.xml, 'id'); return { id, props: paraProps(doc.header, id, modern) }; }),
    fonts: list.map(font => ({ ...font })),
  };
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
  // 먼저 파싱해 실패 시 기존 문서·헤더가 그대로 남는다.
  if (xml !== sec.xml) new Section(xml, sec.index);
  if (header) doc.header.xml = header.xml;
  if (xml !== sec.xml) sec.load(xml);
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
  edits.push(...paragraphEdits(sec, p, { paraPrIDRef: pp, ...(paraStyle ? { styleIDRef: style.id } : {}) }));
  commit(doc, sec, p, edits, header);
  const after = inspectFormatting(doc, ref); const changed = before.fingerprint !== after.fingerprint;
  return { changed, ref, start: spec.start, end: spec.end, before, after, undo: changed ? { ref, before, afterFingerprint: after.fingerprint } : null };
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

function formattingCopyEdits(doc, source, sourceRef, targetRef, sourceInfo, before, imported) {
  if (sourceInfo.text !== before.text) fail('FORMAT_CONFLICT', '원본과 대상의 글이 달라 서식을 정확한 범위에 복사할 수 없습니다');
  if (modernUnits(source) !== modernUnits(doc)) fail('FORMAT_UNSUPPORTED', '서식 단위 버전이 다른 문서 간 복사는 지원하지 않습니다');
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
  const snapshot = owner => ({ header: owner.header.xml, sections: owner.sections.map(sec => ({ sec, xml: sec.xml })) });
  const unchanged = (owner, before) => owner.header.xml === before.header && owner.sections.length === before.sections.length && before.sections.every(({ sec, xml }, i) => owner.sections[i] === sec && sec.xml === xml);
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
  if (modernUnits(source) !== modernUnits(doc)) fail('FORMAT_UNSUPPORTED', '서식 단위 버전이 다른 문서 간 복사는 지원하지 않습니다');
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
    const original = shape(source.header, tag, sourceId); const semantic = semanticShape(source, tag, sourceId); const wanted = hash(semantic);
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
      xml = rootAttrs(xml, { id: reserved }); const placeholder = header.block('style', reserved); header.xml = header.xml.replace(placeholder, xml); destination = reserved;
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

