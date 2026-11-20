import { z } from 'zod';
import { CharFormatSchema, ParagraphFormatSchema } from './format-schema.js';
import { styleParagraphFields } from '../engine/style-properties.js';
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
// 개체 → 본문(2026-11-16, engine/flow.js): 쪽 좌표에 놓인 글상자·괘선을 진짜 문단·표로 옮긴다. 쪽 구성 제안과 같은 길(고치기 전 사본으로 되돌림)을 쓴다.
// 옛 MCP 도구(propose_page_layout)의 입력 스키마는 PageLayoutOpSchema 그대로다 — 이 op 는 새 연결(server/mcp2.js edit)과 REST 가 쓴다.
const marginMm = z.number().min(0).max(300).optional();
const REST_KINDS = ['table', 'figure', 'shape', 'chart'];   // 개체 지우기(delete_objects)의 종류와 같다
export const ObjectsToBodyOpSchema = z.object({
  op: z.literal('objects_to_body'),
  at: z.union([z.string().regex(/^(\*|s\d+|s\d+\/p\d+)$/), z.array(z.string().regex(/^s\d+\/p\d+$/)).min(1).max(1000)]).optional()
    .describe("대상: 생략·'*' = 문서 전체, 's3' = 구역, 's3/p0' 또는 그 목록 = 그 본문 문단의 개체"),
  join_pages: z.boolean().optional().describe("쪽마다 끊긴 같은 표(열 구조 같음)를 하나로 잇는다(기본 true — 되풀이된 머리행은 넣지 않고 버린 줄 '되풀이 머리행'으로 알린다). false = 쪽마다 따로 표"),
  keep_page_numbers: z.boolean().optional().describe('쪽 번호로 보이는 줄도 본문으로 옮긴다(기본 false — 버린다)'),
  drop: z.array(z.string().regex(/^s\d+\/p\d+:L\d+$/)).max(1000).optional().describe("옮기지 않고 버릴 줄(read view=layout 의 줄 번호 — 's0/p0:L3')"),
  header_rows: z.number().int().min(0).max(20).optional().describe('표 머리행 수(기본: 배경색이 칠해진 첫 줄들)'),
  wrap: z.enum(['auto', 'keep']).optional().describe('표 밖 줄: auto = 이어지는 줄을 한 문단으로, keep = 줄마다 문단'),
  margins: z.union([z.enum(['auto', 'keep']), z.object({ left: marginMm, right: marginMm, top: marginMm, bottom: marginMm, header: marginMm, footer: marginMm }).strict()]).optional()
    .describe('쪽 여백 mm: auto(기본) = 여백이 모두 0 인 구역만 조각 위치로 추정해 넣는다, keep = 그대로'),
  merge_sections: z.boolean().optional().describe('비게 된 구역 첫 문단을 지워 앞 구역에 합친다(기본 true — 용지가 같은 구역만)'),
  // 옮긴 글상자·선은 언제나 지운다. 이 옵션은 옮기지 못해 그 문단에 남는 개체까지 같은 제안 안에서 지울 때 — 같은 호출의 delete_objects 도 서버가 이 꼴로 합친다(server/mcp2/ops.js)
  remove_rest: z.union([z.boolean(), z.array(z.enum(REST_KINDS)).min(1).max(REST_KINDS.length),
    z.array(z.object({ kinds: z.array(z.enum(REST_KINDS)).min(1).max(REST_KINDS.length).optional(), at: z.array(z.string().regex(/^s\d+\/p\d+$/)).min(1).max(1000).optional() }).strict()).min(1).max(50)]).optional()
    .describe("옮긴 문단에 남는 개체(옮기지 못한 그림·표·차트·회전한 도형·안에 개체가 든 글상자)도 지운다: true = 모두, ['shape','figure','table','chart'] 가운데 = 그 종류만, [{kinds?, at?}] = 문단마다 따로(기본: 남긴다). 안에 든 글도 함께 지워지고 그 글자 수가 결과에 적힌다"),
  // 쪽 배경 그림(2026-11-17 — engine/flow.js pageBackgrounds: 옮길 글상자 밑에 깔린, 용지의 80% 넘게 덮는 종이·쪽 기준 그림). 글이 본문으로 내려오면 글 앞 그림은 글을 덮는다
  background: z.enum(['remove', 'behind']).optional()
    .describe("쪽 배경 그림(옮길 글상자 밑에 깔린 쪽 크기 그림): remove(기본) = 지운다(내용으로 보이는 그림은 지우지 않고 글 뒤로), behind = 모두 글 뒤로 보내 남긴다(그 구역은 앞 구역에 합치지 않아 원래 쪽마다 새 쪽에서 시작)"),
}).strict();
// 스타일 들여오기·정의와 여러 문단 서식(2026-11-18 — docs/MCP_REDESIGN_2026-11-16.md §15, engine/page-layout.js). 쪽 구성 제안과 같은 길(제안 하나·고치기 전 사본으로 되돌림)을 쓴다.
// 근거: 실제 Codex 실행이 '표준서식에 맞추기'를 칸마다 format op 3,141개로 냈다(스타일을 들여올 길·표 전체 대상이 없어서) — 한도·120초 시간 초과.
//  · styles: import 'standard' = 표준서식 스타일 세트(server/templates/blank.hwpx 의 '&본문 1.'·'&표내용__' …)에서 문서에 없는 이름만 들여온다, define = 새 스타일(기준 스타일 + 글자·문단 모양)
//  · restyle: 여러 문단(문단 전체)에 스타일·글자 모양·문단 모양을 한 번에. at 항목: 문단 주소 's0/p3'·'s0/p3/n2' · 범위 's0/p3..p9'(본문 문단만) · 구역 's1' · '*'(모든 본문 문단) ·
//    표 's0/p3#t0'(모든 칸) · { table, row_from?, row_to?, col_from?, col_to? }(칸 범위, 0부터). style 은 이름 — 같은 묶음의 styles 가 들여온·정의한 이름도 된다(차례대로 반영).
//    새 연결(server/mcp2/ops.js)이 format op 의 여러 문단 대상을 이 꼴로 푼다 — 모델에게 보이는 이름은 format 이다
const styleName = z.string().trim().min(1).max(160);
export const styleTarget = z.object({ style: styleName }).strict();
const styleFormat = { char: CharFormatSchema.optional(), paragraph: ParagraphFormatSchema.extend(styleParagraphFields).strict().optional() };
const tableTarget = z.object({ table: z.string().min(1).max(200), row_from: z.number().int().min(0).optional(), row_to: z.number().int().min(0).optional(), col_from: z.number().int().min(0).optional(), col_to: z.number().int().min(0).optional() }).strict();
export const StylesOpSchema = z.object({
  op: z.literal('styles'),
  import: z.literal('standard').optional().describe("표준서식 스타일 세트를 문서에 들여온다(문서에 없는 이름만 — 있는 스타일은 그대로)"),
  define: z.array(z.object({ name: styleName, base: z.string().max(160).optional().describe('기준 스타일 이름(없으면 바탕글)'), type: z.enum(['PARA', 'CHAR']).optional(),
    ...styleFormat, applyToBase: z.boolean().optional() }).strict()).min(1).max(50).optional().describe('새 스타일. applyToBase:true면 base를 쓰는 문단 전체에 함께 적용'),
  update: z.array(z.object({ name: styleName, ...styleFormat }).strict()).min(1).max(50).optional().describe('기존 문단 스타일과 사용 문단 전체에서 지정한 속성만 수정'),
}).strict();
export const RestyleOpSchema = z.object({
  op: z.literal('restyle'),
  at: z.array(z.union([z.string().min(1).max(200), tableTarget, styleTarget])).min(1).max(5000),
  style: styleName.optional(), char: CharFormatSchema.optional(), paragraph: ParagraphFormatSchema.optional(),
}).strict();
// 문서 끼워 넣기(MCP v3 실험 — 2026-11-20, docs/MCP_REDESIGN_2026-11-16.md §21): 이 문서의 빈 서식(download_attachment_file 'template')에 쓴 HWPX 를
// upload_result_file 로 올린 첨부(attachment_id)의 본문을 after 문단 뒤에 — 제안 하나(쪽 구성 제안과 같은 길: 사본으로 되돌림·주소 옮기기)
export const InsertDocumentOpSchema = z.object({
  op: z.literal('insert_document'),
  after: z.string().regex(/^s\d+\/p\d+$/).describe('넣을 자리 앞 본문 문단 주소'),
  attachment_id: z.string().min(1).max(64).describe('끼워 넣을 HWPX 첨부 aid(upload_result_file 의 결과)'),
}).strict();
export const StructureOpSchema = z.discriminatedUnion('op', [...PageLayoutOpSchema.options, ObjectsToBodyOpSchema, StylesOpSchema, RestyleOpSchema, InsertDocumentOpSchema]);
export const normalizePageLayoutOps = ops => z.array(StructureOpSchema).min(1).max(200).parse(ops);
