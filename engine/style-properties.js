import { z } from 'zod';
import { LINE_TYPES } from './table-edit.js';

// 기존 MCP의 표시 이름 대응. 새로 문단 전체를 고를 때는 아래 열쇠에 더해 사설 글자가 든 유일한 후보인지 확인한다.
const styleMarks = new Set([...'■□▣◆◇◈●○◎◉▶►▷▸▹▪▫◼◻◾◽•❍❏❑★☆※➢➤']);
export const privateStyleChar = ch => /^\p{Co}$/u.test(ch);
export const styleKey = name => [...String(name ?? '').trim()].map(ch => styleMarks.has(ch) || privateStyleChar(ch) ? '\0' : ch).join('');

const glyph = z.string().regex(/^[^\p{Cc}\p{Cs}\s\uFFFE\uFFFF]$/u, '글머리표는 표시 가능한 문자 하나입니다');
const bullet = z.object({
  type: z.literal('BULLET'), char: glyph.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), sizePt: z.number().min(1).max(1000).optional(),
}).strict();
const level = z.number().int().min(1).max(10);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const numbering = z.object({
  type: z.literal('NUMBER'), level: level.optional(), start: z.number().int().min(1).max(65535).optional(),
  format: z.enum(['DIGIT', 'CIRCLED_DIGIT', 'ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL',
    'CIRCLED_LATIN_CAPITAL', 'CIRCLED_LATIN_SMALL', 'HANGUL_SYLLABLE', 'CIRCLED_HANGUL_SYLLABLE', 'HANGUL_JAMO',
    'CIRCLED_HANGUL_JAMO', 'HANGUL_PHONETIC', 'IDEOGRAPH', 'CIRCLED_IDEOGRAPH']).optional(),
  pattern: z.string().max(128).regex(/^[^\p{Cc}\p{Cs}\uFFFE\uFFFF]*$/u).optional(),
}).strict();
const nonempty = value => Object.keys(value).length > 0;
const tabStop = z.object({
  posPt: z.number().min(0).max(10000), type: z.enum(['LEFT', 'RIGHT', 'CENTER', 'DECIMAL']).optional(),
  leader: z.enum(LINE_TYPES).optional(),
}).strict();
const tabs = z.object({
  stops: z.array(tabStop).max(64).optional(), autoLeft: z.boolean().optional(), autoRight: z.boolean().optional(),
}).strict().refine(nonempty, '탭 위치 목록(stops)이나 자동 탭을 지정하세요');
const line = z.object({
  type: z.enum(LINE_TYPES).optional(), widthMm: z.number().min(0.1).max(5).optional(), color: color.optional(),
}).strict().refine(nonempty, '테두리 종류·굵기·색 중 하나를 지정하세요');
export const borderSides = ['left', 'right', 'top', 'bottom'];
const sides = schema => Object.fromEntries(borderSides.map(s => [s, schema.optional()]));
const border = z.object({
  all: line.optional(), ...sides(line), fill: z.union([color, z.literal('none')]).optional(),
  offsetMm: z.object(sides(z.number().min(0).max(100))).strict().refine(nonempty).optional(),
  connect: z.boolean().optional(), ignoreMargin: z.boolean().optional(),
}).strict().refine(nonempty, '바꿀 문단 테두리 속성을 지정하세요');

// 스타일을 묻거나 고칠 때만 읽는 꼴. 모든 MCP 호출에 실리는 글자·문단 서식 스키마는 키우지 않는다.
export const styleParagraphFields = {
  heading: z.discriminatedUnion('type', [bullet, numbering, z.object({ type: z.literal('OUTLINE'), level }).strict(), z.object({ type: z.literal('NONE') }).strict()]).optional(),
  tabs: tabs.optional(), border: border.optional(),
};
