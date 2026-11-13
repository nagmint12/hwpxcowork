import { z } from 'zod';
const section = z.number().int().min(0);
const apply = z.enum(['BOTH', 'EVEN', 'ODD']);
const text = z.string().max(10000);
const style = z.string().max(100).optional().describe('get_formatting의 문단 스타일 이름 또는 ID');
export const PageLayoutOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('paper'), section, width_mm: z.number().min(40).max(1200).optional(), height_mm: z.number().min(40).max(1200).optional(), orientation: z.enum(['portrait', 'landscape']).optional(), margins: z.object(Object.fromEntries(['left', 'right', 'top', 'bottom', 'header', 'footer', 'gutter'].map(k => [k, z.number().min(0).max(300).optional()]))).strict().optional() }).strict(),
  z.object({ op: z.literal('section'), section, page_start: z.number().int().min(0).max(65535).optional(), starts_on: apply.optional(), hide_first_header: z.boolean().optional(), hide_first_footer: z.boolean().optional(), hide_first_master: z.boolean().optional(), hide_first_number: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('split_section'), before_ref: z.string().regex(/^s\d+\/p[1-9]\d*$/) }).strict(),
  z.object({ op: z.literal('merge_section'), section }).strict().describe('이 구역 뒤의 구역을 합친다. 앞 구역의 쪽 설정을 사용하며 뒤 구역의 머리말·꼬리말·쪽 번호 정의를 제거한다'),
  z.object({ op: z.enum(['header', 'footer']), section, apply_to: apply.optional(), text: text.optional(), style, clear: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('page_number'), section, position: z.enum(['NONE', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'OUTSIDE_TOP', 'OUTSIDE_BOTTOM', 'INSIDE_TOP', 'INSIDE_BOTTOM']).optional(), format: z.enum(['DIGIT', 'CIRCLED_DIGIT', 'ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL']).optional(), side_char: z.string().max(1).optional(), start: z.number().int().min(0).max(65535).optional(), clear: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('master_page'), section, apply_to: apply.optional(), text: text.optional(), style, attachment_id: z.string().optional().describe('배경 그림 첨부 aid. 용지 전체에 맞춘다'), clear: z.boolean().optional() }).strict(),
]);
export const normalizePageLayoutOps = ops => z.array(PageLayoutOpSchema).min(1).max(50).parse(ops);
