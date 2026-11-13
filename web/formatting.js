// AI 서식 요청·제안 표시의 공통 규칙. 값이 없는 속성은 기존 모양을 유지한다.
export const isRichProposal = (p) => !!p && (p.type === 'format' || !!p.format || (Array.isArray(p.runs) && p.runs.length > 0));
export function adoptionRecord(p, name) {
  if (!p || !name) return null;
  return p.adoptedBy?.[name] || (Array.isArray(p.adopted) ? p.adopted.find(x => x?.by === name) : p.adopted?.by === name ? p.adopted : null) || null;
}
export function formatAdoptionOf(p, name) {
  const value = adoptionRecord(p, name);
  return value?.formatApplied ? value : null;
}
export function emptyFormatDraft() {
  return { styleId: '', charPrId: '', paraPrId: '', font: '', sizePt: '', bold: '', italic: '', underline: '', color: '', align: '', lineType: 'PERCENT', lineValue: '', spaceBeforePt: '', spaceAfterPt: '', indentPt: '', leftMarginPt: '', rightMarginPt: '' };
}
export function formatFromDraft(input = {}) {
  const format = {}, char = {}, paragraph = {};
  for (const key of ['styleId', 'charPrId', 'paraPrId']) if (String(input[key] ?? '').trim()) format[key] = String(input[key]).trim();
  if (input.font?.trim()) char.font = input.font.trim();
  for (const key of ['bold', 'italic', 'underline']) if (input[key] === true || input[key] === 'true') char[key] = true; else if (input[key] === false || input[key] === 'false') char[key] = false;
  const number = (key, label, min, max) => {
    if (input[key] === '' || input[key] == null) return undefined;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}: ${min}~${max} 범위의 숫자를 입력하세요`);
    return value;
  };
  const size = number('sizePt', '글자 크기', 1, 1000); if (size !== undefined) char.sizePt = size;
  if (input.color?.trim()) { if (!/^#[\da-f]{6}$/i.test(input.color.trim())) throw new Error('글자 색은 #RRGGBB 형식으로 입력하세요'); char.color = input.color.trim(); }
  if (input.align) paragraph.align = input.align;
  const line = number('lineValue', '줄 간격', 0, 10000); if (line !== undefined) paragraph.lineSpacing = { type: input.lineType || 'PERCENT', value: line };
  for (const key of ['spaceBeforePt', 'spaceAfterPt', 'indentPt', 'leftMarginPt', 'rightMarginPt']) {
    const value = number(key, '문단 간격', key === 'indentPt' ? -1000 : 0, 1000); if (value !== undefined) paragraph[key] = value;
  }
  if (Object.keys(char).length) format.char = char;
  if (Object.keys(paragraph).length) format.paragraph = paragraph;
  return Object.keys(format).length ? format : null;
}
export function paragraphFormatRequested(format, catalog) {
  if (!format) return false;
  const style = catalog?.styles?.find(x => String(x.id) === String(format.styleId));
  return !!format.paraPrId || !!format.paragraph || (format.styleId != null && String(style?.type || 'PARA').toUpperCase() !== 'CHAR');
}
const ALIGN = { LEFT: '왼쪽', CENTER: '가운데', RIGHT: '오른쪽', JUSTIFY: '양쪽', DISTRIBUTE: '배분', DISTRIBUTE_SPACE: '나눔' };
const LINE = { PERCENT: '%', FIXED: 'pt 고정', BETWEEN_LINES: 'pt 여백', AT_LEAST: 'pt 최소' };
export function formatSummary(format, catalog) {
  if (!format || typeof format !== 'object') return [];
  const rows = [];
  if (format.styleId != null) { const style = catalog?.styles?.find(x => String(x.id) === String(format.styleId)); rows.push(`스타일 ${style?.name || '#' + format.styleId}`); }
  if (format.charPrId != null) rows.push(`글자 모양 #${format.charPrId}`);
  if (format.paraPrId != null) rows.push(`문단 모양 #${format.paraPrId}`);
  const char = format.char || {};
  if (char.font) rows.push(`글꼴 ${char.font}`);
  if (char.sizePt != null) rows.push(`${char.sizePt}pt`);
  for (const [key, label] of [['bold', '굵게'], ['italic', '기울임'], ['underline', '밑줄']]) if (typeof char[key] === 'boolean') rows.push(`${label} ${char[key] ? '켬' : '끔'}`);
  if (char.color) rows.push(`글자 색 ${char.color}`);
  for (const [key, label] of [['strikeout', '취소선'], ['superscript', '위첨자'], ['subscript', '아래첨자']]) if (typeof char[key] === 'boolean') rows.push(`${label} ${char[key] ? '켬' : '끔'}`);
  if (char.ratioPct != null) rows.push(`장평 ${char.ratioPct}%`);
  if (char.spacingPct != null) rows.push(`자간 ${char.spacingPct}%`);
  if (char.shadeColor) rows.push(char.shadeColor === 'none' ? '음영 없음' : `음영 ${char.shadeColor}`);
  const p = format.paragraph || {};
  if (p.align) rows.push(`${ALIGN[String(p.align).toUpperCase()] || p.align} 정렬`);
  if (p.lineSpacing) rows.push(`줄 간격 ${p.lineSpacing.value}${LINE[p.lineSpacing.type] || ''}`);
  for (const [key, label] of [['spaceBeforePt', '문단 앞'], ['spaceAfterPt', '문단 뒤'], ['indentPt', '들여쓰기'], ['leftMarginPt', '왼쪽 여백'], ['rightMarginPt', '오른쪽 여백']]) if (p[key] != null) rows.push(`${label} ${p[key]}pt`);
  if (typeof p.oneLine === 'boolean') rows.push(`한 줄로 입력 ${p.oneLine ? '켬' : '끔'}`);
  return rows;
}
export function runPreviewStyle(run) {
  const c = run?.char || {}, style = {};
  if (typeof c.bold === 'boolean') style.fontWeight = c.bold ? '700' : '400';
  if (typeof c.italic === 'boolean') style.fontStyle = c.italic ? 'italic' : 'normal';
  if (typeof c.underline === 'boolean') style.textDecoration = c.underline ? 'underline' : 'none';
  if (/^#[\da-f]{6}$/i.test(c.color || '')) style.color = c.color;
  if (c.strikeout === true) style.textDecoration = style.textDecoration === 'underline' ? 'underline line-through' : 'line-through';
  if (c.superscript === true) style.verticalAlign = 'super';
  if (c.subscript === true) style.verticalAlign = 'sub';
  if (/^#[\da-f]{6}$/i.test(c.shadeColor || '')) style.background = c.shadeColor;
  return style;
}
