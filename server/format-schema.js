// MCP·모델 출력·서비스가 공유하는 서식 입력. null은 모델의 '지정 안 함'이며 false는 유지한다.
import { z } from 'zod';

const optional = schema => schema.nullish();
const shapeId = z.string().regex(/^\d+$/).max(30);
export const CharFormatSchema = z.object({
  font: optional(z.string().trim().min(1).max(160)), sizePt: optional(z.number().finite().min(1).max(1000)),
  bold: optional(z.boolean()), italic: optional(z.boolean()), underline: optional(z.boolean()),
  color: optional(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  // 한/글 글자 모양의 자주 쓰는 속성(2026-10-30): 취소선·위첨자·아래첨자·장평(%)·자간(%)·음영 색(none = 없앰)
  strikeout: optional(z.boolean()), superscript: optional(z.boolean()), subscript: optional(z.boolean()),
  ratioPct: optional(z.number().finite().min(50).max(200)), spacingPct: optional(z.number().finite().min(-50).max(50)),
  shadeColor: optional(z.string().regex(/^(#[0-9a-fA-F]{6}|none)$/)),
}).strict();
export const ParagraphFormatSchema = z.object({
  align: optional(z.enum(['LEFT', 'RIGHT', 'CENTER', 'JUSTIFY', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'])),
  lineSpacing: optional(z.object({ type: z.enum(['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST']), value: z.number().finite().nonnegative().max(10000) }).strict()),
  spaceBeforePt: optional(z.number().finite().nonnegative().max(10000)), spaceAfterPt: optional(z.number().finite().nonnegative().max(10000)),
  indentPt: optional(z.number().finite().min(-10000).max(10000)),
  leftMarginPt: optional(z.number().finite().nonnegative().max(10000)), rightMarginPt: optional(z.number().finite().nonnegative().max(10000)),
  // 한/글 '한 줄로 입력'(넘치면 자간을 줄여 한 줄에 — 차례 항목 등)
  oneLine: optional(z.boolean()),
}).strict();
export const FormatSchema = z.object({
  styleId: optional(shapeId), charPrId: optional(shapeId), paraPrId: optional(shapeId),
  char: optional(CharFormatSchema), paragraph: optional(ParagraphFormatSchema),
}).strict();
// 새 연결(v2 — server/mcp2/ops.js)용: 문단 앞 쪽 나눔(pageBreakBefore — engine/formatting.js PARA_KEYS)을 더 받는다(2026-11-17 작업 P).
// 예전 연결 도구·서버 AI 의 인자 꼴(위 ParagraphFormatSchema·FormatSchema)은 그대로 두고, 서비스 정규화(normalizeFormat)는 이 꼴로 받는다
export const ParagraphFormatSchemaV2 = ParagraphFormatSchema.extend({ pageBreakBefore: optional(z.boolean()) }).strict();
export const FormatSchemaV2 = FormatSchema.extend({ paragraph: optional(ParagraphFormatSchemaV2) }).strict();
export const RunsSchema = z.array(z.object({ text: z.string(), charPrId: optional(shapeId), char: optional(CharFormatSchema) }).strict()).min(1).max(1000);

// 지시 글에 서식 변경 요청이 있어 보이는가 — 요청 창에 서식 칸이 없으므로 AI 가 지시만 보고 서식 제안을 한다.
// 서버 AI 에 문서 서식 정의 전체(스타일·모양 번호)를 싣는 기준·모의 AI 서식 제안에 쓴다(틀려도 프롬프트가 길어질 뿐이다)
const FORMAT_HINT = /한\s*줄로|한\s*줄을?\s*넘|취소선|위\s*첨자|아래\s*첨자|장평|자간|음영|굵게|진하게|볼드|bold|기울임|이탤릭|italic|밑줄|underline|글꼴|폰트|font|글자\s*크기|\d+(\.\d+)?\s*(pt|포인트)|글자\s*색|색으로|빨간|파란|정렬|줄\s*간격|행간|들여쓰기|내어쓰기|문단\s*(앞|뒤)?\s*간격|여백|스타일|서식/i;
export function formatHinted(instruction) { return FORMAT_HINT.test(String(instruction ?? '')); }

function withoutNull(value) {
  if (Array.isArray(value)) return value.map(withoutNull);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item != null).map(([key, item]) => [key, withoutNull(item)])
    .filter(([, item]) => typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length));
  return value;
}
export function normalizeFormat(value) {
  if (value == null) return undefined;
  const clean = withoutNull(FormatSchemaV2.parse(value));
  if (clean.char?.color) clean.char.color = clean.char.color.toUpperCase();
  if (clean.char?.shadeColor && clean.char.shadeColor !== 'none') clean.char.shadeColor = clean.char.shadeColor.toUpperCase();
  return Object.keys(clean).length ? clean : undefined;
}
export function normalizeRuns(value) {
  if (value == null) return undefined;
  return withoutNull(RunsSchema.parse(value)).map(run => ({ ...run, ...(run.char?.color ? { char: { ...run.char, color: run.char.color.toUpperCase() } } : {}) }));
}
export function requestedRuns(value, desired) {
  const runs = normalizeRuns(value); const selected = normalizeFormat(desired);
  if (!runs || !selected) return runs;
  // 선택한 기존 스타일/모양은 모델이 임의 run 속성으로 다시 덮지 않는다.
  if (selected.styleId != null || selected.charPrId != null) return undefined;
  return selected.char ? runs.map(run => ({ ...run, char: { ...run.char, ...selected.char } })) : runs;
}

// 사람이 선택한 속성은 모델이 생략하거나 바꾸어도 유지한다. 지정하지 않은 속성은 모델 결과를 쓴다.
export function requestedFormat(model, desired) {
  let supplied = normalizeFormat(model); const selected = normalizeFormat(desired);
  if (!selected) return supplied;
  supplied = { ...supplied };
  if (selected.styleId != null) {
    // 엔진의 style→shape IDs→explicit 순서에서 모델 속성이 선택 스타일을 덮지 않게 한다.
    delete supplied.charPrId; delete supplied.paraPrId; delete supplied.char; delete supplied.paragraph;
  } else {
    if (selected.charPrId != null) delete supplied.char;
    if (selected.paraPrId != null) delete supplied.paragraph;
  }
  return { ...supplied, ...selected,
    ...(supplied?.char || selected.char ? { char: { ...supplied?.char, ...selected.char } } : {}),
    ...(supplied?.paragraph || selected.paragraph ? { paragraph: { ...supplied?.paragraph, ...selected.paragraph } } : {}),
  };
}

// OpenAI/Codex strict JSON은 optional 속성도 required+nullable로 표현한다.
export function strictOutputSchema(schema) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'default' && key !== '$schema').map(([key, item]) => [key, visit(item)]));
    if (out.type === 'object' && out.properties) {
      const required = new Set(out.required || []);
      for (const [key, property] of Object.entries(out.properties)) if (!required.has(key)) {
        const nullable = property.type === 'null' || property.anyOf?.some(item => item.type === 'null');
        if (!nullable) out.properties[key] = { anyOf: [property, { type: 'null' }] };
      }
      out.required = Object.keys(out.properties); out.additionalProperties = false;
    }
    return out;
  };
  return visit(schema);
}

// Gemini·Claude 구조화 출력·Gemini 함수 선언은 JSON Schema 의 값 범위·패턴을 받지 않는다(Gemini 400 invalid argument, Claude 'minimum… not supported').
// 범위는 받은 쪽(RunSchema·MCP 도구의 zod)이 다시 검사하므로 스키마에서만 뺀다. properties 안의 속성 이름(예: format)은 건드리지 않는다.
const BOUND_KEYWORDS = new Set(['pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
export function withoutBounds(node) {
  if (Array.isArray(node)) return node.map(withoutBounds);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => !BOUND_KEYWORDS.has(key)).map(([key, value]) => [key,
    key === 'properties' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withoutBounds(item)])) : withoutBounds(value)]));
}
