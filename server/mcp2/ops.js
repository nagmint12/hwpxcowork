// 새 MCP 연결의 고치기(edit) 동작 — 한 도구에 ops 배열로 낸다(docs/MCP_REDESIGN_2026-11-16.md §3.3).
// 도구 정의에는 op 이름만 싣고(가볍게) 인자는 여기서 op 마다 검사한다 — 틀리면 그 op 의 꼴을 오류 글로 돌려줘 모델이 고친다.
// 동작은 모두 지금 있는 제안 종류(바꿈·넣기·표·표 고치기·서식·개체 지우기·차례·쪽 구성…)로 풀린다(server/service.js _proposeCore) —
// 권한·선점·변경 추적·되돌리기는 그 길 그대로다. 문서 구조를 바꾸는 op(쪽 구성·objects_to_body)는 한 호출의 것을 묶어 쪽 구성 제안 하나로 낸다.
import { expandFieldFill, pickField } from '../../engine/fields.js';
import { z } from 'zod';
// 새 연결은 문단 앞 쪽 나눔(paragraph.pageBreakBefore)을 더 받는 꼴(2026-11-17 작업 P — Y05 는 그 키가 없어 장 제목을 지우고 다시 넣었다). 예전 연결의 꼴은 그대로
import { FormatSchemaV2 as FormatSchema, RunsSchema, CharFormatSchema, ParagraphFormatSchemaV2 as ParagraphFormatSchema } from '../format-schema.js';
import { TableOpSchema } from '../table-schema.js';
import { StructureOpSchema, styleTarget } from '../page-layout-schema.js';
import { NativeChartSchema, ChartTableSourceSchema } from '../native-chart.js';
import { SVG_MAX_CHARS } from '../figure-svg.js';
import { convertibleHosts } from '../../engine/layout.js';
import { structureRefs, restyleRefs, standardStyleNames } from '../../engine/page-layout.js';
import { planParagraphs, paragraphsPreview, paragraphLabel } from '../../engine/para-move.js';
import { rangePicker } from './views.js';
import { styleKey } from '../../engine/style-properties.js';

const REF = /^s\d+\/p\d+(?:\/[nd]\d+)*$/;
const BODY_REF = /^s\d+\/p\d+$/;
const ref = z.string().regex(REF);
const cellAt = z.object({ table: z.string().min(1), row: z.number().int().min(0), col: z.number().int().min(0), para: z.number().int().min(0).optional() }).strict();
const at = z.union([ref, cellAt]);
const reason = z.string().max(2000).optional();
const text = z.string().max(200000);
// 표·그림·차트의 주석 줄(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-8 — 놓는 꼴은 engine/captions-notes.js): 한 줄 글(줄 바꿈으로 여러 줄) 또는 줄 배열
const notes = z.union([z.string().max(5000), z.array(z.string().max(1000)).min(1).max(20)]).optional();
const KINDS = ['table', 'figure', 'shape', 'chart'];
// 쪽 구성 묶음의 op 이름들(literal 은 values, enum(header·footer)은 options)
const STRUCTURE_OPS = StructureOpSchema.options.flatMap((o) => { const s = o.shape.op; return s.options ?? [...(s.values || [])]; });

const paragraph = z.object({ text: text.optional(), style: z.string().max(160).optional(), format: FormatSchema.optional(), runs: RunsSchema.optional() }).strict();
// [hwpx-cowork] format 의 여러 문단 대상(2026-11-18 — docs/MCP_REDESIGN_2026-11-16.md §15): 범위 's0/p3..p9'·구역 's1'·'*'(본문 문단), 표 's0/p3#t0'(모든 칸),
// { table, row_from?, row_to?, col_from?, col_to? }(칸 범위). 실제 Codex 실행이 표 칸마다 format op 를 내 3,141개(한도 2,000)가 됐다 — 표·범위를 한 op 로 받는다
const RANGE_AT = /^(?:\*|s\d+|s\d+\/p\d+\.\.(?:s\d+\/)?p\d+|s\d+\/p\d+(?:\/[nd]\d+)*#t\d+.*)$/;
const tableAt = z.object({ table: z.string().min(1).max(200), row_from: z.number().int().min(0).optional(), row_to: z.number().int().min(0).optional(), col_from: z.number().int().min(0).optional(), col_to: z.number().int().min(0).optional() }).strict();
const formatAt = z.union([ref, cellAt, z.string().regex(RANGE_AT), tableAt, styleTarget]);
// 한 호출의 서식 대상 문단이 이 수를 넘으면(또는 범위·표 꼴을 쓰거나 같은 호출에 styles 가 있으면) 문단마다 제안하지 않고 제안 하나(서식 일괄)로 낸다:
// 문단마다의 제안은 제안 하나에 메모 하나·사전 검사 한 번이 따라 큰 문서에서 하나에 0.1초가 넘는다(칸 200개 저장 32초 — 같은 문서 §15.2)
const BULK_FORMAT_MIN = 20;

/** op 이름 → { schema, sig(한 줄 꼴 — 도구 설명·오류 글에 싣는다) } */
export const OPS = {
  replace: { sig: "{op:'replace', at, find, with, occurrence?, reason?} — at 문단의 find 글을 with 로(지우기는 with:''). 같은 글이 여럿이면 occurrence 번째(1부터, 없으면 첫 번째). 문단 글 전체를 바꾸려면 find 대신 whole:true. 빈 문단·빈 표 칸에 넣기는 find:''(그 문단의 스타일도 함께 주려면 style:'스타일 이름'). 글을 다 지워도 빈 문단은 남는다(문단째 지우기는 delete_paragraphs)",
    schema: z.object({ op: z.literal('replace'), at, find: z.string().optional(), whole: z.boolean().optional(), with: text, occurrence: z.number().int().min(1).optional(), style: z.string().max(160).optional(), format: FormatSchema.optional(), runs: RunsSchema.optional(), reason }).strict() },
  insert: { sig: "{op:'insert', after, paragraphs:[{text, style?, runs?}], reason?} — after 문단 뒤에 문단들을 차례대로(빈 줄은 text:''). 한 문단이면 text 만 줘도 된다. style = 문단 스타일 이름. 글 일부만 굵게 등은 text 대신 runs:[{text, char:{bold…}}, {text}]. 같은 after 에 낸 넣기(insert·table·figure)는 함께 반영하면 낸 차례대로 놓인다",
    schema: z.object({ op: z.literal('insert'), after: ref, text: text.optional(), style: z.string().max(160).optional(), paragraphs: z.array(paragraph).min(1).max(500).optional(), reason }).strict() },
  table: { sig: "{op:'table', after, rows:[[칸 글…]…], header_rows?, caption?, unit?, notes?, reason?} — 새 표(caption 은 제목만 — 번호는 자동). unit:'명, %' → 표 앞 '(단위: 명, %)', notes:'주: …'|['주: …','자료: …'] → 표 아래 주석(문서 서식대로 — insert 로 따로 넣지 않는다)",
    schema: z.object({ op: z.literal('table'), after: ref, rows: z.array(z.array(z.string().max(5000)).min(1).max(60)).min(1).max(1000), header_rows: z.number().int().min(0).max(20).optional(), caption: z.string().max(500).optional(), unit: z.string().max(200).optional(), notes, reason }).strict() },
  table_edit: { sig: "{op:'table_edit', table, ops:[{op:'delete_rows'|'insert_rows'|'delete_cols'|'insert_cols'|'merge'|'unmerge'|'border'|'fill'|'col_widths'|'row_height'|'cell_align'|'table', …}], reason?} — 있는 표의 줄·칸·합치기·테두리·너비. 줄 넣기 {op:'insert_rows', row, position:'below'|'above', values:[[칸 글…]]}(합계 줄처럼 새 줄과 글을 한 번에), 배경 {op:'fill', range:{row_from,row_to,col_from?,col_to?}, color:'#RRGGBB'}, 그 밖의 인자는 read view='guide' id='table_edit'",
    schema: z.object({ op: z.literal('table_edit'), table: z.string().min(1), ops: z.array(TableOpSchema).min(1).max(40), reason }).strict() },
  format: { sig: "{op:'format', at, find?, style?, char?, paragraph?, reason?} — 글은 그대로 서식만. at 은 문단 하나나 목록, find 를 주면 그 글만(문단 하나일 때). 여러 문단은 한 op 로: 범위 's0/p3..p9'·구역 's1'·'*'(본문 문단만 — 표 칸은 들지 않는다), 표 's0/p3#t0'(그 표의 모든 칸), {table, row_from?, row_to?, col_from?, col_to?}(칸 범위 — 머리행은 row_from:0,row_to:0, 0부터), {style:'기존 이름'}(해당 문단 스타일 전체), 이들의 목록. 칸·문단마다 op 를 내지 않는다 — 대상 문단이 20개를 넘거나 범위·표 꼴이면 문단마다의 제안 대신 제안 하나(서식 일괄 — 영수증의 structure)로 묶인다(뒤 op 가 앞 op 를 덮는다: 표 전체 → 머리행 차례로). style = 스타일 이름(같은 호출의 styles 가 들여온·정의한 이름도 된다), char {bold, italic, underline, sizePt, font, color:'#RRGGBB'…}, paragraph {align, lineSpacing, indentPt…, pageBreakBefore:true|false(이 문단 앞에서 새 쪽 — 쪽 나누기 켜기·끄기, 본문 문단 하나씩만)}",
    schema: z.object({ op: z.literal('format'), at: z.union([formatAt, z.array(formatAt).min(1).max(2000)]), find: z.string().optional(), occurrence: z.number().int().min(1).optional(), start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional(),
      style: z.string().max(160).optional(), char: CharFormatSchema.optional(), paragraph: ParagraphFormatSchema.optional(), reason }).strict() },
  delete_objects: { sig: "{op:'delete_objects', at, kinds?, reason?} — 표·그림·도형(글상자·선)·차트를 개체째 지운다(안의 글도 사라진다). at: 본문 문단 's0/p3' · 목록 · 범위 's0/p3..p9' · 구역 's2' · 문서 전체 '*'. kinds: ['table','figure','shape','chart'] 가운데(없으면 모두). objects_to_body 로 옮기는 문단에는 내지 않는다(옮긴 글상자·선은 그 op 가 지운다)",
    schema: z.object({ op: z.literal('delete_objects'), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(BODY_REF)).min(1).max(1000)]), kinds: z.array(z.enum(KINDS)).min(1).optional(), reason }).strict() },
  // [hwpx-cowork] 문단 통째로 지우기·옮기기(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-1: T10 은 글만 지워 빈 문단 6개, T09 는 다시 만들어 표가 새 표)
  // → 제안 para_delete·para_move 하나(server/paragraph-ops.js). 범위는 한 구역 안의 이어진 본문 문단(engine/para-move.js paragraphRange 가 막는 것: 구역 첫 문단·구역 나누기·걸친 필드)
  delete_paragraphs: { sig: "{op:'delete_paragraphs', at, reason?} — 본문 문단을 통째로(안의 표·그림까지, 빈 줄 없이) 지운다. at: 's1/p8' · 's1/p8..p13' · 이어진 목록(한 구역, p0 제외)",
    schema: z.object({ op: z.literal('delete_paragraphs'), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(BODY_REF)).min(1).max(500)]), reason }).strict() },
  move_paragraphs: { sig: "{op:'move_paragraphs', at, after|before, reason?} — 그 문단들을 원본 그대로(표·서식째) after 뒤·before 앞으로 옮긴다(같은 구역, 옮기기 전 주소)",
    schema: z.object({ op: z.literal('move_paragraphs'), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(BODY_REF)).min(1).max(500)]), after: z.string().regex(BODY_REF).optional(), before: z.string().regex(BODY_REF).optional(), reason }).strict() },
  alternatives: { sig: "{op:'alternatives', at, find, options:[{text, reason?}…]} — 같은 글의 여러 안(비교를 요청받았을 때만)",
    schema: z.object({ op: z.literal('alternatives'), at, find: z.string().min(1), occurrence: z.number().int().min(1).optional(), options: z.array(z.object({ text, reason, format: FormatSchema.optional(), runs: RunsSchema.optional() }).strict()).min(1).max(10) }).strict() },
  memo: { sig: "{op:'memo', at, text, find?} — 의견 메모(find 를 주면 그 글에). 답글은 {op:'memo', reply_to:'memo3', text}",
    schema: z.object({ op: z.literal('memo'), at: at.optional(), text: z.string().min(1).max(20000), find: z.string().optional(), occurrence: z.number().int().min(1).optional(), reply_to: z.string().max(100).optional() }).strict() },
  fill: { sig: "{op:'fill', fields:[{name, value, occurrence?}…], reason?} — 누름틀 채우기(칸마다 제안 하나). 한/글 PutFieldText 와 같다: name 만 주면 그 이름의 칸 모두, 한 칸만은 occurrence(0부터 — read view='fields' 의 차례). 값은 한 줄 글",
    schema: z.object({ op: z.literal('fill'), fields: z.array(z.object({ name: z.string().min(1), value: z.string(), occurrence: z.number().int().min(0).optional(), reason }).strict()).min(1).max(200), reason }).strict() },
  toc: { sig: "{op:'toc', apply_now?, apply_styles?, one_line?, create_if_missing?, after?, at?, reason?} — 차례 새로 고침·만들기(본문·표·제목 작업을 마친 뒤 마지막에). 제목·표·그림 차례를 지금 문서로 다시 뽑는다. at = 고칠 차례 안 문단(없으면 첫 차례), create_if_missing = 차례가 없으면 after 뒤에 새로 만든다, apply_styles = 차례 스타일을 다시 준다, one_line = 긴 항목을 한 줄로, apply_now = 지금 바로 반영(그렇게 지시받았을 때만)",
    schema: z.object({ op: z.literal('toc'), at: ref.optional(), after: ref.optional(), apply_now: z.boolean().optional(), apply_styles: z.boolean().optional(), one_line: z.boolean().optional(), create_if_missing: z.boolean().optional(),
      styles: z.object({ title: z.string().optional(), level1: z.string().optional(), level2: z.string().optional(), level3: z.string().optional(), captions: z.string().optional() }).strict().optional(),
      collect_styles: z.array(z.string()).optional(), reason }).strict() },
  // [hwpx-cowork] 숨긴 op(2026-11-18 사용자 결정 — 아래 HIDDEN_OPS): 도구 설명·op 목록에는 싣지 않고, 사용자가 한/글 차트 개체를 명시해 요청했을 때만 쓴다
  chart: { sig: "{op:'chart', after, chart:{type, title?, categories?, series?…}, source_table?:{table, header_row, category_col, value_cols, data_rows}, width_mm?, height_mm?, caption?, notes?} — 한/글에서 편집되는 차트 개체(사용자가 그것을 명시해 요청했을 때만 — 그 밖의 차트·그래프는 figure 로 직접 그린다). caption = 아래 '[그림 N] 제목'(번호 자동), notes = table 과 같음(자세히: read view='guide' id='chart')",
    schema: z.object({ op: z.literal('chart'), after: ref, chart: NativeChartSchema.partial({ categories: true, series: true }), source_table: ChartTableSourceSchema.optional(), width_mm: z.number().min(10).max(300).optional(), height_mm: z.number().min(10).max(300).optional(), caption: z.string().max(500).optional(), notes, reason }).strict() },
  figure: { sig: "{op:'figure', after | replace, svg | attachment_id, caption?, notes?, width_mm?} — 그림 넣기·바꾸기. 차트·그래프·도식 등 시각화는 직접 그린다: svg(<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 W H\">…</svg> — 서버가 300dpi PNG 로 그린다. viewBox 로 비율, 글자는 viewBox 단위로 충분히 크게(본문 폭 160mm 에 viewBox 폭 1600 이면 글자 28~36), font-family 는 생략(서버의 한글 글꼴), 바탕 흰색, 외부 파일·주소·스크립트 없이) 또는 직접 만든 그림 파일의 attachment_id(PNG·JPEG·GIF·BMP·SVG). 값은 문서·첨부에 있는 것만 쓰고, 색·글꼴·꼴은 문서의 기존 그림에 맞춘다. 내기 전에 preview_figure(같은 svg·width_mm)로 글자 겹침·잘림을 본다(그림마다 두 번까지). width_mm = 문서에 보일 폭(본문 폭 이하, 생략하면 SVG 의 폭), caption = 그림 아래 '[그림 N] 제목'(제목 글만 — 번호 자동, 그림 안에는 제목을 넣지 않는다), notes = table 과 같음(새 그림만)",
    schema: z.object({ op: z.literal('figure'), after: ref.optional(), replace: z.string().max(200).optional(), svg: z.string().max(SVG_MAX_CHARS).optional(), attachment_id: z.string().max(100).optional(), caption: z.string().max(500).optional(), notes, width_mm: z.number().min(10).max(300).optional(), reason }).strict() },
  // 일괄 바꾸기(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-6: T16 은 낱말 하나에 op 61개를 두 번 썼다). 일치마다 바꿈 제안(같은 문단 여럿은 occurrence) — 아래 findAll
  replace_all: { sig: "{op:'replace_all', find, with, at?, word?, ignore_case?, reason?} — at 범위(기본 문서 전체 '*' · 's1' · 's0/p3..p9')의 본문·표 칸·표와 그림 캡션·글상자·머리말·꼬리말·각주에서 find 를 모두 with 로(일치마다 제안). word:true = 앞뒤가 글자·숫자가 아닌 곳만(조사가 붙은 곳은 빠진다). 미리 보기는 read(view='text', find)",
    schema: z.object({ op: z.literal('replace_all'), find: z.string().min(1).max(1000), with: z.string().max(5000), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(BODY_REF)).min(1).max(2000)]).optional(), word: z.boolean().optional(), ignore_case: z.boolean().optional(), reason }).strict() },
  // 자기 대기 제안 거두기(2026-11-17 — 같은 문서 §10.4 나-4: 2차 T09 는 고쳐 다시 내며 중복 제안 4건을 남겼다 — 거절은 사람만). server/proposal-withdraw.js
  withdraw: { sig: "{op:'withdraw', pids:[12,13] | all:true} — 이 요청에서 내가 낸 대기 제안을 거둔다(고쳐 다시 낼 때 — 같은 호출의 다른 op 보다 먼저). 반영·거절된 것·남의 것은 오류",
    schema: z.object({ op: z.literal('withdraw'), pids: z.array(z.number().int().min(1)).min(1).max(2000).optional(), all: z.boolean().optional(), reason }).strict() },
};
const STRUCTURE_SIG = {
  styles: "{op:'styles', import?:'standard', define?:[{name, base?, type?:'PARA'|'CHAR', char?, paragraph?, applyToBase?}], update?:[{name,char?,paragraph?}]} — 표준서식 들여오기·새 스타일 정의·기존 문단 스타일 수정. applyToBase:true는 기준 스타일을 쓰는 모든 문단을 새 스타일로 옮긴다. update는 기존 스타일과 사용 문단에서 준 속성만 바꾼다. 이미 만든 스타일로 전체 서식을 다시 입히기는 format(at:{style:'기존 이름'},style:'새 이름'). 이름·사용 수는 read view='styles', 자세한 예는 guide id='styles'.",
  objects_to_body: "{op:'objects_to_body', at?, join_pages?, keep_page_numbers?, drop?, header_rows?, margins?, remove_rest?, background?} — 떠 있는 글상자·괘선으로 그려진 쪽을 진짜 본문 문단·표로 옮기고 그 글상자·선을 지운다(좌표로 줄·칸·합친 칸·쪽을 넘는 표를 읽는다 — 글을 다시 치지 않는다). 이 op 하나로 옮기기와 지우기가 끝난다 — delete_objects 를 함께 내지 않는다. join_pages(기본 true): 다음 쪽의 첫 내용이 열 구조가 같은 표면 앞 쪽 표에 이어 한 표로 만든다 — 쪽마다 되풀이된 머리행은 넣지 않고 버린 줄(why '되풀이 머리행')로 알린다(글자 검사는 버린 글자로 센다). false = 쪽마다 따로 표. 옮길 글상자 밑에 깔린 쪽 크기 그림(쪽 배경)은 background:'remove'(기본)면 지운다(내용으로 보이는 그림은 지우지 않고 글 뒤로), 'behind' 면 모두 글 뒤로 남긴다(그 구역은 앞 구역에 합치지 않아 원래 쪽마다 새 쪽에서 시작). 옮긴 표는 쪽에서 나뉘고, 비게 된 구역은 앞 구역에 합친다(merge_sections 기본 true). 옮기지 못해 남는 개체(그림·표·회전한 도형 등)까지 지우려면 remove_rest:true(또는 종류 목록). 글자·숫자가 원문과 어긋나면(숫자가 붙거나 갈라짐) 적용하지 않는다. at 생략 = 문서 전체. 구조는 요청 내용의 배치 요약이나 read view='layout' 로 확인하고, 결과(쪽 수 pages.all_applied, 글 앞 그림에 가려진 쪽 pages.covered)를 미리 보려면 dry_run",
  paper: "{op:'paper', section, margins?:{left,right,top,bottom,header,footer}, width_mm?, height_mm?, orientation?:'portrait'|'landscape'} — 용지·여백(mm). section 은 0부터(화면의 '구역 2' = section 1 — read view='page')",
  section: "{op:'section', section, page_start?, hide_first_header?…}", split_section: "{op:'split_section', before_ref}", merge_section: "{op:'merge_section', section} — 다음 구역을 합침",
  header: "{op:'header'|'footer', section, text?|clear?, apply_to?, style?} — 머리말·꼬리말 글(쪽 번호는 page_number 로)", footer: "{op:'footer', …}", page_number: "{op:'page_number', section, position?:'BOTTOM_CENTER'|'BOTTOM_LEFT'|'BOTTOM_RIGHT'|'TOP_CENTER'|'TOP_LEFT'|'TOP_RIGHT'|'NONE'…, format?:'DIGIT'…, start?|clear?} — 쪽 번호", master_page: "{op:'master_page', section, text?|attachment_id?|clear?}",
};

export const OP_NAMES = [...Object.keys(OPS), ...STRUCTURE_OPS];
/**
 * [hwpx-cowork] 숨긴 op(2026-11-18 사용자 결정): 차트·그래프 등 시각화는 AI 가 직접 그린 그림(figure — svg·그림 파일)이 기본이고, 한/글 차트 개체(chart)는
 * 사용자가 그것을 명시해 요청했을 때만 쓴다(한/글 차트의 모양이 좋지 않다). 그래서 chart 는 없는 것처럼 둔다 — 도구 설명의 op 목록(OPS_BRIEF)·Codex 첫 입력·
 * 모르는 op 오류의 이름 목록·read view='guide' id='ops' 의 목록에 싣지 않는다. 꼴 검사·저장은 그대로다(내면 받는다).
 * 안내는 두 길뿐: AI 가 물을 때(read view='guide' id='chart', id='ops' 끝의 한 줄)와 지시가 한/글 차트 개체를 명시했을 때(요청 내용 todo — nativeChartAsked).
 * 근거: 2026-11-18 실제 Codex 실행('…통계를 작성하여 차트를 제시해줘')이 op 목록의 '한/글 차트'를 골라 한/글 차트 2개를 냈다. 기록 docs/MCP_REDESIGN_2026-11-16.md §14
 */
// 'restyle' 은 여러 문단 서식의 안쪽 이름이다(구조 op — server/page-layout-schema.js). 모델에게 보이는 꼴은 format 의 범위·표 대상이고, 서버가 restyle 로 푼다(직접 내도 받는다)
export const HIDDEN_OPS = Object.freeze(['chart', 'restyle']);
export const VISIBLE_OP_NAMES = OP_NAMES.filter((name) => !HIDDEN_OPS.includes(name));
// 지시가 한/글 차트 개체를 가리켜 말했는가(요청 내용 todo 에 꼴 안내 한 줄을 더할지). 그냥 '차트·그래프·시각화'는 아니다 — 한/글·편집 가능·개체·기능을 함께 말했을 때만.
// 맞아도 고르는 것은 AI 다(안내 글이 조건을 다시 적는다): 놓치면 figure 로 그려지고(기본), 잘못 맞으면 안내 한 줄이 더 실릴 뿐이다
const HANGUL = '(?:한\\s*\\/?\\s*글|한컴|hwpx?)';
const NATIVE_CHART_ASK = new RegExp([
  `${HANGUL}\\s*(?:의|에서\\s*쓰는|용|문서의?|프로그램의?)?\\s*(?:자체|고유|기본|내장|전용)?\\s*(?:의\\s*)?(?:차트|chart)`,
  '(?:차트|chart)\\s*(?:개체|객체|도구|object|기능(?!별))',
  '(?:편집|수정)\\s*(?:이\\s*)?(?:가능한|할\\s*수\\s*있는|되는)\\s*(?:차트|그래프)',
  '(?:네이티브|native|고유|내장|자체)\\s*(?:차트|chart)',
  `${HANGUL}에서\\s*(?:다시\\s*|직접\\s*|바로\\s*)?(?:편집|수정|고칠)[^.\\n]{0,24}(?:차트|그래프)`,
  `(?:차트|그래프)[^.\\n]{0,24}${HANGUL}에서\\s*(?:다시\\s*|직접\\s*|바로\\s*)?(?:편집|수정|고칠)`,
].join('|'), 'i');
export const nativeChartAsked = (instruction) => NATIVE_CHART_ASK.test(String(instruction ?? ''));
export const NATIVE_CHART_TODO = "한/글 차트 개체(한/글에서 값·모양을 다시 편집하는 차트)를 새로 만들라는 지시면 edit 의 chart op 로 만든다 — 꼴은 read(view='guide', id='chart'). 그런 지시가 아니면 차트·그래프는 figure 로 직접 그린다.";
export const isStructureOp = (name) => STRUCTURE_OPS.includes(name);
const sigOf = (name) => OPS[name]?.sig || STRUCTURE_SIG[name] || '';

/**
 * 도구 설명에 싣는 op 목록(한 줄씩). 2026-11-16 밤 하위 에이전트 실험(docs/MCP_REDESIGN_2026-11-16.md §10)에서 18건 가운데 13건이 op 꼴만 보려고
 * read view='guide' id='ops'(3,019자 + 응답 한 번)를 더 불렀다 — 자주 쓰는 여덟 개만 싣던 것을 모두 싣는다(설명 +1,400자쯤, 부를 때마다 드는 읽기 한 번을 없앤다).
 * 2026-11-17(작업 I): 갈래 C·D·F 가 op 를 더해 4,389자가 됐다(모델 호출마다 실리는 고정 글). 도구 설명에는 op 마다 짧은 꼴(BRIEF — 인자 이름·필수 여부와
 * 모델이 틀리기 쉬운 규칙만)을 싣고, 자세한 뜻은 sig(read view='guide' id='ops' · 꼴 오류 글)에 둔다. BRIEF 를 고치면 그 op 의 schema·prepareOps 와 대조한다
 * (틀린 꼴 한 줄이 중복 제안을 남긴 일이 있다 — §10.4 2차 T09). 시험: tests/mcp_v2_flow.test.mjs 의 크기 한도·꼴 대조
 */
const BRIEF = {
  replace: "{op:'replace', at, find|whole:true, with, occurrence?, style?, reason?} — find(그 문단에 그대로 있는 글)를 with 로. 같은 글이 여럿이면 occurrence 번째(1부터). 빈 문단·빈 칸에 넣기는 find:''. 글을 다 지워도 빈 문단은 남는다(문단째 지우기는 delete_paragraphs)",
  insert: "{op:'insert', after, paragraphs:[{text|runs, style?, format?}…] | text, reason?} — after 뒤에 차례대로(빈 줄 text:''). 글 일부 서식은 runs:[{text, char:{bold:true}}, {text}]. 새 쪽 시작은 format:{paragraph:{pageBreakBefore:true}}. 같은 after 의 넣기(insert·table·figure)는 낸 차례대로 놓인다",
  table: "{op:'table', after, rows:[[칸 글…]…], header_rows?(기본 1), caption?, unit?, notes?, reason?} — caption 은 제목만(번호 자동). unit:'명, %' → 표 앞 단위 줄, notes:'주: …'|[…] → 표 아래 주석(insert 로 따로 넣지 않는다)",
  table_edit: "{op:'table_edit', table, ops:[…], reason?} — 있는 표 고치기. ops 항목: {op:'insert_rows', row, position?:'below'|'above', values?:[[칸 글…]]} · {op:'delete_rows', rows:[…]} · {op:'fill', range:{row_from,row_to,col_from?,col_to?}, color:'#RRGGBB'} · delete_cols·insert_cols·merge·unmerge·border·col_widths·row_height·cell_align·table(인자는 read view='guide' id='table_edit')",
  // 2026-11-18(+190자): 범위·표 대상 — 실제 Codex 실행이 칸마다 op 3,141개를 냈다(한도 초과·120초 시간 초과, §15)
  format: "{op:'format', at, find?, style?, char?:{bold,italic,underline,sizePt,font,color:'#RRGGBB'…}, paragraph?:{align,lineSpacing:{type:'PERCENT',value},indentPt…,pageBreakBefore:true|false}, reason?} — at: 문단·칸 | 목록 | 범위 's0/p3..p9'·구역 's1'·'*'(본문 문단) | 표 's0/p3#t0'(모든 칸) | {table, row_from?, row_to?, col_from?, col_to?} | {style:'기존 스타일'}. find는 글 일부. 칸·문단마다 op 를 내지 않는다",
  // 2026-11-18(+215자): 스타일 들여오기 — 같은 실행이 '새 스타일을 만들 도구가 없다'며 문단·칸마다 직접 서식을 줬다(§15)
  styles: "{op:'styles', import?:'standard', define?:[{name,base?,char?,paragraph?,applyToBase?}], update?:[{name,char?,paragraph?}]} — 표준서식 들여오기·생성. applyToBase:true 또는 update로 동일 스타일 전체 적용. 글머리표 등은 read(view='guide',id='styles'), 이름은 read(view='styles')",
  delete_objects: "{op:'delete_objects', at, kinds?:['table'|'figure'|'shape'|'chart'], reason?} — 개체째 지운다(안의 글도). at: 's0/p3'·목록·'s0/p3..p9'·'s2'·'*'",
  delete_paragraphs: "{op:'delete_paragraphs', at, reason?} — 본문 문단을 통째로(안의 표·그림까지, 빈 줄 없이). at: 's1/p8'·'s1/p8..p13'·이어진 목록(한 구역, p0 제외)",
  move_paragraphs: "{op:'move_paragraphs', at, after|before, reason?} — 원본 그대로(표·서식째) 옮긴다. 같은 구역, 옮기기 전 주소",
  // 2026-11-17(안전장치): 쪽 배경 그림도 지운다는 것과 background(+29자 — 실제 24쪽 문서에서 배경이 글을 덮었다), 쪽을 넘는 표 잇기(join_pages)와 되풀이 머리행을
  // 버린 줄로 알린다는 것(+59자 — 같은 실행에서 모델이 join_pages:false 로 표 24개를 냈다. 되풀이 머리행은 engine/layout.js analyzeLayout dropped). 'drop?' 은 sig·guide 에만
  objects_to_body: "{op:'objects_to_body', at?, join_pages?, remove_rest?, background?, …} — 글상자·괘선으로 그린 쪽을 본문 문단·표로 옮기고(글을 다시 치지 않는다) 그 글상자·선·쪽 배경 그림을 지운다('behind' = 배경을 글 뒤로). 쪽을 넘는 표는 열 구조가 같으면 한 표로 잇는다(되풀이 머리행은 버린 줄로 알림, join_pages:false = 쪽마다 따로). 같은 문단에 delete_objects 를 내지 않는다 — 남는 개체는 remove_rest:true. at 생략 = 전체",
  memo: "{op:'memo', at, text, find?} — 의견 메모. 답글은 {op:'memo', reply_to:'memo3', text}",
  alternatives: "{op:'alternatives', at, find, options:[{text, reason?}…]} — 여러 안(비교 요청 때만)",
  fill: "{op:'fill', fields:[{name, value, occurrence?}…], reason?} — 누름틀. name 만 주면 그 이름의 칸 모두, 한 칸만은 occurrence(0부터 — read view='fields' 차례). 값은 한 줄",
  toc: "{op:'toc', at?, after?, create_if_missing?, apply_styles?, one_line?, apply_now?} — 차례 새로 고침(없으면 create_if_missing:true + after). 다른 작업을 마친 뒤 마지막에. apply_now 는 지시받았을 때만",
  // 숨긴 op(HIDDEN_OPS) — OPS_BRIEF 에는 싣지 않는다. read view='guide' id='chart' 가 이 줄을 앞에 보인다
  chart: "{op:'chart', after, chart:{type:'bar'|'line'|'pie'…, title?, categories?, series?:[{name, values}]}, source_table?:{table, header_row, category_col, value_cols, data_rows}, width_mm?, height_mm?, caption?, notes?} — 한/글 차트(값은 categories·series 또는 source_table). caption = 아래 [그림 N] 제목(번호 자동)",
  // 2026-11-18: 차트·그래프도 여기로 온다(chart 줄을 뺀 290자 가운데 +215자) — 직접 그리는 법(svg 의 비율·글자·글꼴, 미리보기)과 문서에 맞추기. 자세한 것은 sig(guide id='ops')
  figure: "{op:'figure', after|replace, svg|attachment_id, caption?, notes?, width_mm?} — 그림 넣기·바꾸기. 차트·그래프·도식 등 시각화는 직접 그린다: svg(viewBox 로 비율, 글자는 viewBox 단위로 크게, font-family 생략 — 서버가 한글 글꼴 PNG 로 그린다) 또는 만든 그림 파일의 attachment_id. 값은 문서·첨부의 것만, 색·글꼴은 문서의 기존 그림에 맞추고 preview_figure 로 겹침·잘림을 본다. caption = 아래 [그림 N] 제목(번호 자동 — 그림 안에 제목을 넣지 않는다), notes 는 새 그림만",
  replace_all: "{op:'replace_all', find, with, at?, word?, ignore_case?, reason?} — 범위(기본 '*')의 본문·표 칸·캡션·글상자·머리말·꼬리말·각주에서 모두 바꾼다(바탕쪽·메모 제외). word:true = 낱말 단위(조사가 붙은 곳은 빠진다)",
  withdraw: "{op:'withdraw', pids:[12,13] | all:true} — 이 요청에서 낸 내 대기 제안을 거둔다(고쳐 다시 낼 때)",
};
const BRIEF_STRUCTURE = "쪽 구성(section 은 0부터 — 화면의 '구역 2' = 1): {op:'paper', section, margins?:{left,right,top,bottom,header,footer}, width_mm?, height_mm?, orientation?:'portrait'|'landscape'} · {op:'header'|'footer', section, text?|clear?} · {op:'page_number', section, position?:'BOTTOM_CENTER'…, start?|clear?} · section·split_section·merge_section·master_page — 인자는 read view='guide' id='ops'|'page'";
export const OPS_BRIEF = ['replace', 'insert', 'table', 'table_edit', 'format', 'styles', 'delete_objects', 'delete_paragraphs', 'move_paragraphs', 'objects_to_body', 'memo', 'alternatives', 'fill', 'toc', 'figure', 'replace_all', 'withdraw'].map((k) => `· ${BRIEF[k]}`).join('\n')
  + `\n· ${BRIEF_STRUCTURE}`;

/**
 * 모든 op 의 꼴(read view='guide' id='ops'). 숨긴 op(HIDDEN_OPS — chart)는 목록에 싣지 않고 끝에 한 줄로만 알린다(AI 가 op 를 찾아 물었을 때의 안내),
 * id='chart' 는 쓰는 조건·꼴·JSON Schema 를 준다
 */
export function opsGuide(topic = 'ops') {
  if (topic === 'styles') return [
    STRUCTURE_SIG.styles,
    "read(view='styles')에서 사용 수와 실제 글머리표를 본다. 대학혁신센터 표준서식의 빈 네모는 read(view='styles',id='&□')로 찾을 수 있다. 후보가 여럿이면 표시된 실제 이름이나 ID 문자열을 쓴다.",
    "빈 네모 글머리표를 채운 네모로: {op:'styles',define:[{name:'채운 네모',base:'기존 이름',applyToBase:true,paragraph:{heading:{type:'BULLET',char:'■'}}}]}. 같은 이름 유지: {op:'styles',update:[{name:'기존 이름',paragraph:{heading:{type:'BULLET',char:'■'}}}]}. 한 제안에 사용 문단 수가 나온다.",
    "paragraph.heading은 하나를 고른다. {type:'BULLET',char:'■',color?:'#RRGGBB',sizePt?:12}, {type:'NUMBER',level:1,format:'HANGUL_SYLLABLE',pattern:'(^1)',start:3}, {type:'OUTLINE',level:2}(구역 개요 번호 사용), {type:'NONE'}. 수준은 1~10. 번호 모양은 DIGIT·ROMAN_CAPITAL·LATIN_SMALL 등. 글에 직접 입력한 □는 글 바꾸기로 다룬다.",
    "paragraph.tabs:{stops:[{posPt:72,type:'RIGHT',leader:'DOT'}],autoLeft?,autoRight?}. stops는 새 탭 위치 전체, []은 지정 탭 지우기. 종류 LEFT·RIGHT·CENTER·DECIMAL.",
    "paragraph.border:{bottom:{type:'SOLID',widthMm:0.5,color:'#23547B'},fill?:'#RRGGBB'|'none',offsetMm?:{left?,right?,top?,bottom?},connect?,ignoreMargin?}. all 또는 각 변을 지정한다. 표 셀 테두리는 table_edit. 문단별 굵게·들여쓰기 등 나머지 속성은 define(applyToBase)·update에서 유지한다.",
    "대상은 최종본 구역의 본문·표 칸·글상자·캡션·머리말·꼬리말·각주 등의 문단이다. 메모·삭제 개체·바탕쪽은 범위 밖이다. 글자 스타일(CHAR)은 정의 후 원하는 범위에 format으로 적용한다.",
  ].join('\n');
  if (topic === 'table_edit') return `table_edit 의 ops 항목(JSON Schema):\n${JSON.stringify(z.toJSONSchema(TableOpSchema))}`;
  if (topic === 'chart') return ["chart op — 한/글에서 값·모양을 다시 편집하는 차트 개체. 사용자가 한/글 차트 개체를 명시해 요청했을 때만 쓴다. 그 밖의 차트·그래프·시각화는 figure 로 직접 그린다(기본).",
    `· ${BRIEF.chart}`, `JSON Schema:\n${JSON.stringify(z.toJSONSchema(OPS.chart.schema))}`].join('\n');
  // 숨긴 구조 op(restyle — 여러 문단 서식의 안쪽 이름)는 꼴에서 뺀다(모델에게 보이는 이름은 format 이다 — 2026-11-18 검증에서 이 JSON Schema 에 드러난 것을 고쳤다)
  if (topic === 'page') return `쪽 구성 op(JSON Schema):\n${JSON.stringify(z.toJSONSchema(z.union(StructureOpSchema.options.filter((o) => { const v = o.shape.op; return !(v.options ?? [...(v.values || [])]).some((name) => HIDDEN_OPS.includes(name)); })), { reused: 'ref' }))}`;
  return ['edit 의 ops — 주소(at·after)는 read 가 보여 준 그대로 쓴다. 표 칸은 at:{table:\'s0/p3#t0\', row, col}(0부터).',
    ...Object.keys(OPS).filter((k) => !HIDDEN_OPS.includes(k)).map((k) => `· ${OPS[k].sig}`), ...Object.keys(STRUCTURE_SIG).filter((k) => k !== 'footer').map((k) => `· ${STRUCTURE_SIG[k]}`),
    '쪽 구성 op(paper·section·header·footer·page_number·master_page·split_section·merge_section)와 objects_to_body, styles 와 여러 문단 format 은 한 호출의 것을 묶어 제안 하나(되돌리기 한 번)로 낸다 — 그 안에서는 styles → 여러 문단 format → 나머지 차례로 반영된다.',
    "더 자세한 인자: read view='guide' id='table_edit' | 'page'",
    "목록에 없는 op: 한/글 차트 개체(한/글에서 다시 편집하는 차트)는 사용자가 그것을 명시해 요청했을 때만 — read view='guide' id='chart'. 그 밖의 차트·그래프는 figure 로 직접 그린다."].join('\n');
}

// 꼴 오류 글. 모르는 키(unrecognized_keys)면 그 자리 객체가 받는 키를 덧붙인다(2026-11-17 — artifacts/mcp-round3-20261117/codex/REPORT.md 문제 4:
// X05 의 chart.y_label·y_min 이 거절되자 모델이 축 제목을 빼고 다시 냈다 — 맞는 키 x_title·y_title 은 guide id='chart' 에만 있었다). 별칭으로 몰래 받지는 않는다
const issueText = (e, schema, raw) => (e?.issues ? e.issues.slice(0, 3).map((x) => {
  const keys = x.code === 'unrecognized_keys' && schema ? keysAt(schema, x.path, raw) : null;
  return `${x.path.join('.') || '(op)'} ${x.message}${keys?.length ? ` — 받는 키: ${keys.join(', ')}` : ''}`;
}).join('; ') : e?.message || String(e));

// zod(4) 스키마에서 path 자리의 객체가 받는 키. 감싼 것(optional 등)은 벗기고, 갈래(union)는 그 자리 입력의 op 값·아는 키가 가장 많이 맞는 객체를 고른다
const WRAPS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional', 'lazy', 'pipe']);
function unwrapSchema(s) {
  for (let i = 0; i < 20 && s?._zod?.def && WRAPS.has(s._zod.def.type); i++) { const d = s._zod.def; s = d.type === 'lazy' ? d.getter() : d.type === 'pipe' ? d.in : d.innerType; }
  return s;
}
function flatSchemas(s) { s = unwrapSchema(s); return s?._zod?.def?.type === 'union' ? s._zod.def.options.flatMap(flatSchemas) : s ? [s] : []; }
function keysAt(schema, path, raw) {
  try {
    let list = flatSchemas(schema); let v = raw;
    for (const seg of path) {
      list = list.flatMap((s) => {
        const d = s._zod.def;
        if (d.type === 'object') return d.shape[seg] ? flatSchemas(d.shape[seg]) : [];
        if (d.type === 'array' && typeof seg === 'number') return flatSchemas(d.element);
        if (d.type === 'record') return flatSchemas(d.valueType);
        return [];
      });
      v = v?.[seg];
    }
    const objs = list.filter((s) => s._zod.def.type === 'object');
    const fits = (s) => { const lit = s._zod.def.shape.op?._zod?.def?.values; return !(lit && v && typeof v === 'object' && !lit.includes(v.op)); };
    const score = (s) => (v && typeof v === 'object' ? Object.keys(v).filter((k) => k in s._zod.def.shape).length : 0);
    const best = objs.filter(fits).sort((a, b) => score(b) - score(a))[0];
    return best ? Object.keys(best._zod.def.shape) : null;
  } catch { return null; }
}
const fail = (index, name, message) => ({ index, error: `ops[${index}]${name ? ` ${name}` : ''}: ${message}${sigOf(name) ? ` — 꼴: ${sigOf(name)}` : ''}` });

/** ops 를 꼴만 검사한다(문서를 보지 않는다) → { ok: [{ index, name, op }], errors: [{ index, error }] } */
export function parseOps(ops) {
  const ok = []; const errors = [];
  if (!Array.isArray(ops) || !ops.length) return { ok, errors: [{ index: 0, error: 'ops(배열)가 필요합니다' }] };
  if (ops.length > 2000) return { ok, errors: [{ index: 0, error: 'ops 는 한 번에 2,000개까지입니다' }] };
  ops.forEach((raw, index) => {
    const name = raw && typeof raw === 'object' ? String(raw.op ?? '') : '';
    if (!OP_NAMES.includes(name)) { errors.push({ index, error: `ops[${index}]: 모르는 op "${name}" — ${VISIBLE_OP_NAMES.join(' · ')} 가운데 하나` }); return; }
    // 쪽 구성 op 는 reason 을 받지 않는다(제안 하나로 묶인다) — 다른 op 처럼 붙여 낸 reason 때문에 전체를 다시 내지 않게 여기서 뺀다(2026-11-16 밤 실험)
    const body = isStructureOp(name) && raw && 'reason' in raw ? (({ reason, ...rest }) => rest)(raw) : raw;
    const schema = isStructureOp(name) ? StructureOpSchema : OPS[name].schema;
    try { ok.push({ index, name, op: schema.parse(isStructureOp(name) ? body : raw) }); }
    catch (e) { errors.push(fail(index, name, issueText(e, schema, isStructureOp(name) ? body : raw))); }
  });
  return { ok, errors };
}

// 문서에 없는 스타일 이름 오류에 붙이는 길잡이(2026-11-18): 실제 Codex 실행이 '&본문제목 이 문서에 없습니다'를 받고 스타일을 포기했다 — 들여오는 길을 알린다
// format 은 같은 호출의 styles 가 더할 이름을 쓸 수 있다(서식 묶음 안에서 차례대로 반영). 새로 넣는 문단·바꾸는 글(insert·table·replace)의 style 은 문서에 이미 있는 스타일만이다
const STANDARD_HINT = (name, opName = 'format') => {
  const how = String(name).trim().startsWith('&') ? "표준서식 스타일은 {op:'styles', import:'standard'} 로 들여옵니다" : "새 스타일은 {op:'styles', define:[{name, base?, char?, paragraph?}]} 로 만듭니다";
  return opName === 'format' ? ` — ${how}(같은 호출의 format 이 그 이름을 style 로 쓸 수 있다)` : ` — ${how}. 다만 새로 넣는 글의 style 은 문서에 이미 있는 스타일만 됩니다: 그 styles 제안이 반영된 뒤에 쓰거나, 지금은 style 없이 넣습니다`;
};

/**
 * 꼴 검사를 지난 ops 를 문서에 맞춰 서비스 입력으로 푼다(스타일 이름 → 번호, 표 칸 → 칸 문단 주소, 개체 지우기 범위 → 본문 문단들).
 * → { steps: [{ kind: 'proposals', items: [{ index, input }] } | { kind: 'structure', indexes, ops } | { kind: 'alternatives'|'memo'|'reply'|'chart'|'figure', index, input }], errors, notes: [{ op, note }] }
 *   steps 는 ops 차례를 따른다(잇닿은 제안은 한 묶음으로, 구조 op 는 모두 모아 첫 자리에 한 묶음).
 *   notes: 서버가 op 를 다르게 푼 자리(같은 호출의 objects_to_body 에 합친 delete_objects, 앞선 호출의 objects_to_body 제안과 겹쳐 내지 않은 delete_objects) — 영수증에 싣는다.
 * earlier: 이 요청이 앞선 호출에서 낸, 아직 대기 중인 objects_to_body 제안들 [{ pid, at }] — 그 문단의 개체 지우기를 뒤에 따로 제안하지 않게(아래)
 * previews: [{ op, preview }] — 문단 지우기·옮기기가 지울·옮길 문단 수와 첫 글·결과 차례(미리 해 보기 응답에 싣는다 — 2026-11-17 §10.4 나-1·나-9)
 */
export function prepareOps(doc, parsed, { earlier = [] } = {}) {
  const steps = []; const errors = []; const notes = []; const previews = [];
  // summaries: replace_all 의 개수 요약(영수증 한 줄 — 2026-11-17 §10.4 나-6), withdraw: 거두기 단계(맨 앞 하나)
  const summaries = []; let withdraw = null;
  // 앞선 호출의 objects_to_body 제안이 옮길 문단(필요할 때만 한 번 읽는다). 그 제안이 대기 중인데 같은 문단의 개체 지우기를 따로 제안하면,
  // 사람이 그것을 먼저 반영했을 때 옮길 글이 사라지고 objects_to_body 제안은 반영되지 않는다 — 그 문단 몫은 내지 않고 영수증에 알린다
  let earlierHosts = null;
  const pendingMove = (r) => {
    earlierHosts ??= earlier.map((e) => { try { return { pid: e.pid, hosts: new Set(convertibleHosts(doc, structureRefs(doc, e.at))) }; } catch { return { pid: e.pid, hosts: new Set() }; } });
    return earlierHosts.find((e) => e.hosts.has(r)) || null;
  };
  // 같은 호출의 objects_to_body 가 옮길 문단(옮길 글상자·괘선을 가진 문단). delete_objects 가 그 문단을 가리키면 따로 제안하지 않고 그 op 의 remove_rest 로 합친다 —
  // 옮긴 글상자·선은 objects_to_body 가 지우고, 그 문단에 남는 개체만 같은 제안 안에서 지운다. 따로 제안하면 '개체 지우기'를 먼저 반영했을 때 옮길 글이 사라지고,
  // 나중에 반영하면 대상이 이미 없어 반영되지 않는다(2026-11-16 실제 Codex 실행에서 그렇게 남은 제안이 20건 — docs/MCP_REDESIGN_2026-11-16.md §8)
  const movers = [];
  for (const x of parsed) {
    if (x.name !== 'objects_to_body') continue;
    try { movers.push({ index: x.index, op: x.op, hosts: new Set(convertibleHosts(doc, structureRefs(doc, x.op.at))), rest: [] }); }
    catch (e) { errors.push({ index: x.index, error: `ops[${x.index}] objects_to_body: ${e.message}` }); }
  }
  const styles = doc.formattingCatalog().styles;
  // [hwpx-cowork] 이 호출의 styles op 가 더할 스타일 이름(들여오기 = 표준서식 세트에서 문서에 없는 이름, define = 새 이름) — 여러 문단 format 의 style 이 쓸 수 있다
  const stylesOps = parsed.filter((x) => x.name === 'styles');
  const coming = [];
  if (stylesOps.some((x) => x.op.import === 'standard')) { try { for (const st of standardStyleNames(doc)) if (!styles.some((x) => x.name === st.name)) coming.push(st); } catch { /* 원본을 못 읽으면 반영 때 오류로 알린다 */ } }
  for (const x of stylesOps) for (const d of x.op.define || []) coming.push({ name: d.name, type: d.type || 'PARA' });
  // 여러 문단 서식(bulk): 문단 전체에 주는 format(find·범위 없음)을 모아 — 범위·표 꼴이 있거나, 같은 호출에 styles 가 있거나, 대상 문단이 BULK_FORMAT_MIN 을 넘으면
  // 모두 구조 묶음의 restyle 로 낸다(제안 하나). 아니면 예전처럼 문단마다 서식 제안. bulk: op 번호 → { at(restyle 의 at) }
  const bulk = new Map();
  {
    const whole = parsed.filter((x) => x.name === 'format' && x.op.find == null && x.op.start == null && x.op.end == null && x.op.occurrence == null);
    const items = (x) => (Array.isArray(x.op.at) ? x.op.at : [x.op.at]);
    const ranged = (v) => (typeof v === 'string' ? RANGE_AT.test(v) : !(v && 'row' in v));
    // 칸 하나({table,row,col,para?})는 문단별 길(refOf)과 같은 문단만 — 그 칸의 para 번째(기본 첫) 문단 주소로 바꾼다. 못 찾으면 그대로 두어 아래에서 오류가 난다
    let cellTables = null;
    const normal = (v) => {
      if (typeof v === 'string' || !('row' in v)) return v;
      cellTables ??= doc.tables();
      const t = cellTables.find((x) => x.key === v.table);
      const cell = t?.cells.find((c) => v.row >= c.row && v.row < c.row + c.rowSpan && v.col >= c.col && v.col < c.col + c.colSpan);
      return cell?.refs?.[v.para ?? 0] ?? `${v.table}@없는 칸(${v.row},${v.col})`;
    };
    let count = 0; const expanded = new Map(); let bad = false;
    for (const x of whole) {
      // 사용 문단은 앞의 스타일 정의·적용 뒤에 정해진다. 준비 단계에서 옛 문서에 고정하지 않는다.
      if (items(x).some(a => a?.style)) { expanded.set(x.index, []); continue; }
      try { const refs = restyleRefs(doc, items(x).map(normal)); expanded.set(x.index, refs); count += refs.length; }
      catch (e) { if (!e?.code) throw e; bad = true; if (items(x).some(ranged)) errors.push(fail(x.index, 'format', e.message)); }
    }
    const want = whole.some((x) => items(x).some(ranged)) || (stylesOps.length > 0 && whole.length > 0) || count > BULK_FORMAT_MIN;
    if (want) for (const x of whole) { if (expanded.has(x.index)) bulk.set(x.index, { at: items(x).map(normal) }); else if (!items(x).some(ranged) && !bad) bulk.set(x.index, { at: items(x).map(normal) }); }
    // 대상을 못 푼 op(없는 문단·표)는 범위 꼴이면 위에서, 문단·칸 꼴이면 아래 문단별 길(refOf)에서 오류가 난다
  }
  const fuzzyNoted = new Set();
  const styleId = (name, index, opName) => {
    let hit = styles.find((s) => s.name === name && s.type !== 'CHAR') || styles.find((s) => s.name === name) || styles.find((s) => s.name.trim() === String(name).trim());
    if (!hit) {
      // 기호 자리를 같은 자리표로 보고 견준다(2026-11-17 — REPORT.md 문제 3, §10.4 나-12): 지침은 '&■ …' 로 쓰는데 문서 스타일 이름은 사설 영역 글자 '&󰋪 …' 라
      // 모델이 첫 시도에 맞히지 못했다. 하나만 맞으면 그것을 쓰고 영수증 notes 에 알린다, 둘 이상이면 아래 오류에 후보를 보인다
      const key = styleKey(name);
      const same = (list) => list.filter((s) => styleKey(s.name) === key);
      const cands = same(styles.filter((s) => s.type !== 'CHAR')).length ? same(styles.filter((s) => s.type !== 'CHAR')) : same(styles);
      if (cands.length > 1) { errors.push(fail(index, opName, `스타일 「${name}」 이 문서에 없고 기호만 다른 이름이 여럿입니다: ${cands.map((s) => `「${s.name}」`).join(' · ')}`)); return null; }
      hit = cands[0];
      if (hit && !fuzzyNoted.has(name)) { fuzzyNoted.add(name); notes.push({ op: index, note: `스타일 「${name}」 → 문서의 「${hit.name}」` }); }
    }
    if (!hit) { errors.push(fail(index, opName, `스타일 「${name}」 이 문서에 없습니다(있는 스타일: ${styles.filter((s) => s.type !== 'CHAR').slice(0, 20).map((s) => s.name).join(' · ')})${STANDARD_HINT(name, opName)}`)); return null; }
    return String(hit.id);
  };
  // 여러 문단 서식의 스타일 이름 → 정확한 이름(문서의 스타일 + 이 호출의 styles 가 더할 이름). 번호는 반영 때 엔진이 찾는다(들여온 뒤에 정해진다)
  const styleName = (name, index, opName) => {
    const all = [...styles.filter((x) => x.type !== 'CHAR'), ...coming.filter((x) => x.type !== 'CHAR'), ...styles.filter((x) => x.type === 'CHAR'), ...coming.filter((x) => x.type === 'CHAR')];
    let hit = all.find((x) => x.name === name) || all.find((x) => x.name.trim() === String(name).trim());
    if (!hit) {
      const key = styleKey(name); const cands = [...new Map(all.filter((x) => styleKey(x.name) === key).map((x) => [x.name, x])).values()];
      if (cands.length > 1) { errors.push(fail(index, opName, `스타일 「${name}」 이 없고 기호만 다른 이름이 여럿입니다: ${cands.map((x) => `「${x.name}」`).join(' · ')}`)); return null; }
      hit = cands[0];
      if (hit && !fuzzyNoted.has(name)) { fuzzyNoted.add(name); notes.push({ op: index, note: `스타일 「${name}」 → 「${hit.name}」` }); }
    }
    if (!hit) { errors.push(fail(index, opName, `스타일 「${name}」 이 문서에 없습니다(있는 스타일: ${styles.filter((x) => x.type !== 'CHAR').slice(0, 20).map((x) => x.name).join(' · ')})${STANDARD_HINT(name, opName)}`)); return null; }
    return hit.name;
  };
  let tables = null;
  const refOf = (a, index, opName) => {
    if (typeof a === 'string') return a;
    tables ??= doc.tables();
    const t = tables.find((x) => x.key === a.table);
    const cell = t?.cells.find((c) => a.row >= c.row && a.row < c.row + c.rowSpan && a.col >= c.col && a.col < c.col + c.colSpan);
    const r = cell?.refs?.[a.para ?? 0];
    if (!r) { errors.push(fail(index, opName, t ? `표 ${a.table} 에 (${a.row}, ${a.col}) 칸${a.para ? `의 ${a.para}번째 문단` : ''}이 없습니다(${t.rows}×${t.cols}, 0부터)` : `표 ${a.table} 을 찾지 못했습니다(read view='tables')`)); return null; }
    return r;
  };
  const bodyOf = (r) => (/^s\d+\/p\d+/.exec(r) || [r])[0];
  const proposals = () => { const last = steps[steps.length - 1]; if (last?.kind === 'proposals') return last.items; const s = { kind: 'proposals', items: [] }; steps.push(s); return s.items; };
  let structure = null;
  // 이 호출에서 문단 글 전체(빈 문단에 넣기 포함)를 바꾸는 replace — 같은 문단에 스타일만 주는 format 이 뒤따르면 그 replace 에 합친다(아래)
  const wholeReplace = new Map();
  for (const { index, name, op } of parsed) {
    if (isStructureOp(name)) {
      if (!structure) { structure = { kind: 'structure', indexes: [], ops: [] }; steps.push(structure); }
      structure.indexes.push(index); structure.ops.push(op);
      continue;
    }
    if (name === 'replace') {
      const r = refOf(op.at, index, name); if (!r) continue;
      let find = op.find;
      if (op.whole) { try { find = doc.text(r, 'final'); } catch (e) { errors.push(fail(index, name, e.message)); continue; } }
      if (find == null) { errors.push(fail(index, name, 'find(바꿀 글) 또는 whole:true 가 필요합니다')); continue; }
      let rformat = op.format;
      if (op.style != null) { const id = styleId(op.style, index, name); if (id == null) continue; rformat = { ...(rformat || {}), styleId: id }; }
      const item = { index, input: { type: 'replace', ref: r, find, replace: op.with, occurrence: op.occurrence, format: rformat, runs: op.runs, reason: op.reason } };
      proposals().push(item);
      if (find === '' || op.whole) wholeReplace.set(r, item);
    } else if (name === 'insert') {
      const list = op.paragraphs?.length ? op.paragraphs : [{ text: op.text ?? '', style: op.style }];
      const after = bodyOf(op.after); let bad = false; const items = [];
      for (const p of list) {
        let format = p.format;
        const style = p.style ?? op.style;
        if (style != null) { const id = styleId(style, index, name); if (id == null) { bad = true; break; } format = { ...(format || {}), styleId: id }; }
        // runs 만 주면 글은 그 조각들을 이은 것(서비스는 text 와 runs 의 글이 같아야 받는다 — 2026-11-16 밤 실험: runs 만 내고 실패)
        const t = p.text ?? (Array.isArray(p.runs) ? p.runs.map((r) => r?.text ?? '').join('') : '');
        // text 와 runs 를 함께 줬는데 글이 다르면 여기서 막는다 — 저장 단계에서 그 문단만 실패하면 같은 op 의 다른 문단은 이미 저장돼 차례가 어긋난 제안이 남는다(2026-11-16 밤 실험 T09)
        if (Array.isArray(p.runs) && p.text != null && p.runs.map((r) => r?.text ?? '').join('') !== p.text) { errors.push(fail(index, name, 'runs 의 글을 이으면 text 와 같아야 합니다(text 를 빼면 runs 에서 만든다)')); bad = true; break; }
        items.push({ index, input: { type: 'insert', afterRef: after, text: t, blank: !t.trim(), format, runs: p.runs, reason: op.reason } });
      }
      if (!bad) proposals().push(...items);
    } else if (name === 'table') {
      proposals().push({ index, input: { type: 'table', afterRef: bodyOf(op.after), table: { rows: op.rows, headerRows: op.header_rows ?? 1, caption: op.caption || '', ...(op.unit ? { unit: op.unit } : {}), ...(op.notes ? { notes: op.notes } : {}) }, reason: op.reason } });
    } else if (name === 'table_edit') {
      proposals().push({ index, input: { type: 'table_edit', tableEdit: { table: op.table, ops: op.ops }, reason: op.reason } });
    } else if (name === 'format') {
      // 여러 문단 서식(위 bulk): 구조 묶음의 restyle 로 — 스타일은 이름으로 싣는다(같은 호출의 styles 가 들여올 이름일 수 있다)
      const bulkAt = bulk.get(index);
      if (bulkAt) {
        if (!op.char && !op.paragraph && op.style == null) { errors.push(fail(index, name, 'style·char·paragraph 가운데 하나가 필요합니다')); continue; }
        if (op.paragraph?.pageBreakBefore != null) { errors.push(fail(index, name, '쪽 나눔(pageBreakBefore)은 본문 문단 하나씩 줍니다(여러 문단 서식에는 줄 수 없습니다)')); continue; }
        let style;
        if (op.style != null) { style = styleName(op.style, index, name); if (style == null) continue; }
        if (!structure) { structure = { kind: 'structure', indexes: [], ops: [] }; steps.push(structure); }
        structure.indexes.push(index);
        structure.ops.push({ op: 'restyle', at: bulkAt.at, ...(style != null ? { style } : {}), ...(op.char ? { char: op.char } : {}), ...(op.paragraph ? { paragraph: op.paragraph } : {}) });
        continue;
      }
      const format = { ...(op.char ? { char: op.char } : {}), ...(op.paragraph ? { paragraph: op.paragraph } : {}) };
      if (op.style != null) { const id = styleId(op.style, index, name); if (id == null) continue; format.styleId = id; }
      if (!Object.keys(format).length) { errors.push(fail(index, name, 'style·char·paragraph 가운데 하나가 필요합니다')); continue; }
      // 여기는 문단마다의 서식 제안(글 일부 find·부분 범위 포함). 범위·표 꼴은 문단 전체 서식(위 bulk)에만 쓴다
      if ((Array.isArray(op.at) ? op.at : [op.at]).some((x) => (typeof x === 'string' ? RANGE_AT.test(x) : !('row' in x)))) { errors.push(fail(index, name, "find(글 일부)·부분 범위는 문단·칸 하나(또는 그 목록)에만 줍니다 — 범위 's0/p3..p9'·표 's0/p3#t0' 대상은 문단 전체 서식(find 없이)에 씁니다")); continue; }
      const targets = (Array.isArray(op.at) ? op.at : [op.at]).map((x) => refOf(x, index, name));
      if (targets.some((x) => !x)) continue;
      for (const r of targets) {
        // 같은 호출에서 그 문단의 글 전체를 바꾸는(빈 문단에 넣는) replace 뒤에 스타일만 주는 서식: 따로 제안하면 글이 들어간 뒤 서식의 범위가 어긋나 반영되지 않는다
        // (FORMAT_PARAGRAPH_RANGE — 2026-11-16 밤 논문 실험 2건 모두). 그 replace 에 스타일을 합쳐 제안 하나로 낸다
        const whole = wholeReplace.get(r);
        if (whole && op.find == null && op.start == null && op.end == null && format.styleId != null && Object.keys(format).length === 1 && whole.input.format?.styleId == null) {
          whole.input.format = { ...(whole.input.format || {}), styleId: format.styleId };
          notes.push({ op: index, note: `ops[${index}] format 의 스타일은 같은 문단(${r})의 글을 넣는 ops[${whole.index}] replace 에 합쳤습니다(따로 제안하지 않음 — 글과 스타일이 한 제안으로 반영됩니다)` });
          continue;
        }
        const range = op.find != null && op.find !== '' ? { find: op.find, occurrence: op.occurrence } : op.start != null || op.end != null ? { start: op.start, end: op.end }
          : (() => { try { return { start: 0, end: [...doc.text(r, 'final')].length }; } catch { return { start: 0 }; } })();
        proposals().push({ index, input: { type: 'format', ref: r, ...range, format, reason: op.reason } });
      }
    } else if (name === 'delete_objects') {
      let refs;
      if (Array.isArray(op.at)) refs = op.at;
      else {
        let pick; try { pick = rangePicker(op.at); } catch (e) { errors.push(fail(index, name, e.message)); continue; }
        refs = doc.sections.flatMap((s) => s.bodyParas.filter((p) => !pick || pick(s.index, p.body)).map((p) => p.ref));
      }
      const hosts = refs.filter((r) => { try { return doc.ownObjects(r).some((o) => !op.kinds || op.kinds.includes(o.kind)); } catch { return false; } });
      if (!hosts.length) { errors.push(fail(index, name, `그 범위(${Array.isArray(op.at) ? `${op.at.length}개 문단` : op.at})에 지울 개체${op.kinds ? `(${op.kinds.join('·')})` : ''}가 없습니다`)); continue; }
      // 같은 호출의 objects_to_body 가 옮기는 문단은 그 op 에 합친다(위 movers)
      const left = []; const into = new Map();
      for (const r of hosts) { const m = movers.find((x) => x.hosts.has(r)); if (!m) { left.push(r); continue; } if (!into.has(m)) into.set(m, []); into.get(m).push(r); }
      for (const [m, list] of into) {
        m.rest.push({ kinds: op.kinds || null, at: list });
        notes.push({ op: index, note: `ops[${m.index}] objects_to_body 가 옮기는 문단 ${list.length}개의 개체 지우기는 그 제안에 합쳤습니다(따로 제안하지 않음) — 옮긴 글상자·선은 objects_to_body 가 지우고, 그 문단에 남는 개체${op.kinds ? `(${op.kinds.join('·')})` : ''}만 함께 지웁니다` });
      }
      // 이 요청이 앞선 호출에서 낸 objects_to_body 제안(대기 중)이 옮길 문단: 따로 제안하지 않는다
      const free = []; const held = new Map();
      for (const r of left) { const e = earlier.length ? pendingMove(r) : null; if (!e) { free.push(r); continue; } held.set(e.pid, (held.get(e.pid) || 0) + 1); }
      for (const [pid, count] of held) notes.push({ op: index, note: `이 요청이 앞서 낸 objects_to_body 제안(#${pid})이 그 문단 ${count}개의 글상자·선을 옮기고 지웁니다 — 개체 지우기를 따로 제안하지 않았습니다(먼저 반영되면 옮길 글이 사라집니다)` });
      if (free.length > 500) { errors.push(fail(index, name, `개체를 가진 문단이 ${free.length}개입니다 — 한 번에 500개까지(범위를 나누세요). 글상자·선을 본문으로 옮기는 일이면 objects_to_body 를 쓰세요`)); continue; }
      for (const r of free) proposals().push({ index, input: { type: 'delete', ref: r, delete: { kinds: op.kinds }, reason: op.reason } });
    } else if (name === 'delete_paragraphs' || name === 'move_paragraphs') {
      // 문단 통째로 지우기·옮기기(2026-11-17 §10.4 나-1) → 제안 하나. 범위·옮길 자리를 지금 문서로 검사해 틀리면 저장 전에 고치는 법과 함께 돌려준다
      const move = name === 'move_paragraphs';
      if (move && !op.after === !op.before) { errors.push(fail(index, name, 'after(그 문단 뒤) 또는 before(그 문단 앞) 가운데 하나가 필요합니다')); continue; }
      const span = paragraphSpan(op.at);
      if (span.error) { errors.push(fail(index, name, span.error)); continue; }
      let plan; try { plan = planParagraphs(doc, { ref: span.from, toRef: span.to, afterRef: op.after, beforeRef: op.before }, { move }); } catch (e) { errors.push(fail(index, name, e.message)); continue; }
      proposals().push({ index, input: { type: move ? 'para_move' : 'para_delete', ref: span.from, toRef: span.to, ...(move ? (op.before ? { beforeRef: op.before } : { afterRef: op.after }) : {}), reason: op.reason } });
      previews.push({ op: index, preview: paragraphsPreview(doc, plan, { move }) });
      // 지운(옮긴) 자리 앞뒤가 모두 빈 줄이면 빈 줄 둘이 이어진다(2026-11-17 작업 Q — REPORT-G3.md 문제 3: Z01 은 「표 → 빈 줄 → 그림 → 빈 줄」에서 그림 문단만 지워
      // 빈 줄 둘이 연달아 남았다. dry_run preview 에 「(빈 줄) 다음에 (빈 줄)」이 보였지만 모델이 놓쳤다). 알리기만 하고 더 지우지는 않는다 —
      // 뒤 빈 줄을 범위에 넣으라고 권한다(앞 빈 줄은 그 앞 표·그림 뒤의 빈 줄일 수 있다 — 표준서식은 표·그림 뒤에 빈 줄 하나를 둔다)
      const blank = (i) => i >= 0 && i < doc.sections[plan.sec].bodyParas.length && paragraphLabel(doc, `s${plan.sec}/p${i}`) === '(빈 줄)';
      if (blank(plan.from - 1) && blank(plan.to + 1)) notes.push({ op: index, note: `ops[${index}] ${name}: ${move ? '옮긴 원래 자리' : '지운 자리'} 앞뒤(s${plan.sec}/p${plan.from - 1}·p${plan.to + 1})가 모두 빈 줄이라 빈 줄 둘이 이어진다 — 하나만 남기려면 뒤 빈 줄 s${plan.sec}/p${plan.to + 1} 을 범위에 넣는다` });
    } else if (name === 'fill') {
      // 이름만 준 누름틀은 이름이 같은 칸 모두로 나뉜다(한/글 PutFieldText — engine/fields.js). 여기서 미리 나눠 저장 결과와 op 번호를 1:1 로 맞춘다 —
      // 저장 단계(proposeMany)가 나누면 결과가 입력보다 많아져 영수증을 만들다 예외가 났다(2026-11-16 밤 실험: 제안은 저장됐는데 오류 응답이 가고 done 이 처리되지 않음)
      for (const f of op.fields) for (const it of expandFieldFill(doc, { type: 'replace', fieldFill: { name: f.name, occurrence: f.occurrence ?? null }, replace: f.value, reason: f.reason ?? op.reason })) proposals().push({ index, input: it });
    } else if (name === 'toc') {
      proposals().push({ index, input: { type: 'toc', toc: { at: op.at, ...(op.apply_styles || op.styles ? { styles: op.styles || true } : {}), ...(op.one_line ? { oneLine: true } : {}), ...(op.create_if_missing ? { createIfMissing: true } : {}),
        ...(op.after ? { afterRef: op.after } : {}), ...(op.collect_styles ? { collectStyles: op.collect_styles } : {}) }, reason: op.reason, ...(op.apply_now ? { applyNow: true } : {}) } });
    } else if (name === 'alternatives') {
      const r = refOf(op.at, index, name); if (!r) continue;
      steps.push({ kind: 'alternatives', index, input: { ref: r, find: op.find, occurrence: op.occurrence, options: op.options } });
    } else if (name === 'memo') {
      if (op.reply_to) { steps.push({ kind: 'reply', index, input: { memoId: op.reply_to, text: op.text } }); continue; }
      if (op.at == null) { errors.push(fail(index, name, 'at(문단 주소) 또는 reply_to(메모 id)가 필요합니다')); continue; }
      const r = refOf(op.at, index, name); if (!r) continue;
      steps.push({ kind: 'memo', index, input: { ref: r, find: op.find, occurrence: op.occurrence, text: op.text } });
    } else if (name === 'chart') {
      steps.push({ kind: 'chart', index, input: { afterRef: bodyOf(op.after), chart: op.chart, sourceTable: op.source_table, widthMm: op.width_mm, heightMm: op.height_mm, ...(op.caption ? { caption: op.caption } : {}), ...(op.notes ? { notes: op.notes } : {}), reason: op.reason } });
    } else if (name === 'figure') {
      if (!op.after && !op.replace) { errors.push(fail(index, name, 'after(넣을 자리) 또는 replace(바꿀 그림 주소)가 필요합니다')); continue; }
      if (op.replace && op.notes) { errors.push(fail(index, name, '그림 바꾸기(replace)에는 notes 를 줄 수 없습니다(그림 문단의 글은 그대로 둔다)')); continue; }
      steps.push({ kind: 'figure', index, input: { afterRef: op.after ? bodyOf(op.after) : undefined, replaceRef: op.replace, caption: op.caption || '', svg: op.svg, aid: op.attachment_id, widthMm: op.width_mm, ...(op.notes ? { notes: op.notes } : {}), reason: op.reason } });
    } else if (name === 'replace_all') {
      // 일괄 바꾸기(2026-11-17 §10.4 나-6) → 일치마다 바꿈 제안(같은 op 라 한 묶음·영수증 한 줄). 같은 문단 여럿은 occurrence(doc.find 의 셈) — [모두 반영]은 _orderedApplier 가 자리를 지킨다
      const r = findAll(doc, op);
      if (r.error) { errors.push(fail(index, name, r.error)); continue; }
      for (const m of r.matches) proposals().push({ index, input: { type: 'replace', ref: m.ref, find: m.find, replace: op.with, occurrence: m.occurrence, reason: op.reason } });
      summaries.push({ op: index, replaced: r.matches.length, paragraphs: r.paragraphs, where: r.where, not_searched: FIND_ALL_SKIPS });
    } else if (name === 'withdraw') {
      // 거두기(2026-11-17 §10.4 나-4)는 한 단계로 모아 맨 앞에 둔다 — 고쳐 다시 낸 제안이 거둘 제안과 겹쳐(같은 개체 지우기 등) 막히지 않게.
      // 대상(같은 요청·같은 작성자·대기)은 meta 를 보는 agentEdit 가 검사한다(server/proposal-withdraw.js _withdrawTargets)
      if (!op.pids?.length === !op.all) { errors.push(fail(index, name, 'pids(거둘 제안 번호들) 또는 all:true 가운데 하나가 필요합니다')); continue; }
      if (!withdraw) { withdraw = { kind: 'withdraw', indexes: [], pids: [], all: false }; steps.unshift(withdraw); }
      withdraw.indexes.push(index); if (op.all) withdraw.all = true; else withdraw.pids.push(...op.pids);
    }
  }
  // 합친 개체 지우기를 objects_to_body 의 remove_rest 에 싣는다: 모델이 준 remove_rest(옮긴 문단 모두에 적용)는 그대로 두고, 합친 것은 문단(at)마다 —
  // 같은 종류끼리 모아 한 항목으로(항목마다 문단 1,000개까지 — 쪽 구성 op 꼴 server/page-layout-schema.js)
  for (const m of movers) {
    if (!m.rest.length) continue;
    const given = m.op.remove_rest;
    const own = given === true ? [{}] : Array.isArray(given) && given.length ? (typeof given[0] === 'string' ? [{ kinds: given }] : given) : [];
    const byKinds = new Map();
    for (const r of m.rest) { const key = r.kinds ? [...r.kinds].sort().join(',') : '*'; if (!byKinds.has(key)) byKinds.set(key, { kinds: r.kinds, at: new Set() }); for (const x of r.at) byKinds.get(key).at.add(x); }
    const folded = [];
    for (const { kinds, at } of byKinds.values()) { const list = [...at]; for (let i = 0; i < list.length; i += 1000) folded.push({ ...(kinds ? { kinds } : {}), at: list.slice(i, i + 1000) }); }
    m.op.remove_rest = [...own, ...folded];
  }
  // [hwpx-cowork] 구조 묶음 안의 차례(2026-11-18): styles → 여러 문단 서식(restyle) → 나머지(준 차례). 서식은 주소를 옮기지 않으니 주소를 옮기는 op(objects_to_body·구역 나누기)보다
  // 먼저 해야 읽은 주소 그대로 맞고, 스타일은 그것을 쓰는 서식보다 먼저 있어야 한다. 서식 값이 같은 restyle 은 합친다 — 한 문단에 서로 다른 서식이 겹치지 않으면 떨어져 있어도
  // (칸마다 낸 op 수천 개가 값 종류만큼의 op 로), 겹치면(표 전체 → 머리행처럼 뒤가 앞을 덮는 꼴) 잇닿은 것끼리만(차례를 지킨다)
  if (structure && structure.ops.some((op) => op.op === 'styles' || op.op === 'restyle')) {
    const rank = (op) => (op.op === 'styles' ? 0 : op.op === 'restyle' ? 1 : 2);
    const order = structure.ops.map((op, i) => ({ op, i })).sort((a, b) => rank(a.op) - rank(b.op) || a.i - b.i).map((x) => x.op);
    const restyles = order.filter((op) => op.op === 'restyle');
    const merged = [];
    let fixed = [];
    for (const op of restyles) {
      if (op.at.some(a => a?.style)) {
        merged.push(...mergeFixedFormats(doc, fixed), op);
        fixed = [];
      } else fixed.push(op);
    }
    merged.push(...mergeFixedFormats(doc, fixed));
    structure.ops = [...order.filter((op) => op.op === 'styles'), ...merged, ...order.filter((op) => rank(op) === 2)];
    structure.indexes = [...structure.indexes].sort((a, b) => a - b);
    if (structure.ops.length > 200) errors.push({ index: structure.indexes[0], error: `ops[${structure.indexes[0]}]: 서식 종류가 너무 많습니다(${structure.ops.length}가지 — 200가지까지). 같은 서식은 표·범위 대상으로 한 op 에 모아 주세요` });
  }
  textBeforeMoves(doc, steps, notes);
  markBundles(steps);
  return { steps, errors, notes, previews, summaries };
}

// 스타일을 고르는 op의 앞뒤에서 각각 합친다. 앞 op가 다음 op의 사용 문단을 바꿀 수 있다.
function mergeFixedFormats(doc, group) {
  if (group.length < 2) return group;
  const key = op => JSON.stringify([op.style ?? null, op.char ?? null, op.paragraph ?? null]);
  const owner = new Map();
  let disjoint;
  try {
    disjoint = group.every(op => {
      const k = key(op);
      return restyleRefs(doc, op.at).every(ref => {
        if (owner.has(ref) && owner.get(ref) !== k) return false;
        owner.set(ref, k); return true;
      });
    });
  } catch (e) { if (!e?.code) throw e; disjoint = false; }
  const merged = [];
  for (const op of group) {
    const k = key(op);
    const fits = other => other && key(other) === k && other.at.length + op.at.length <= 5000;
    const into = disjoint ? merged.find(fits) : fits(merged.at(-1)) && merged.at(-1);
    if (into) into.at.push(...op.at);
    else merged.push({ ...op, at: [...op.at] });
  }
  return merged;
}

/**
 * 옮기기보다 범위 안 글 제안을 먼저(2026-11-17 L3 — 실제 Codex 실험 X07 은 한 edit 에 move_paragraphs 를 그 절 제목 번호 replace 보다 먼저 적었다,
 * artifacts/mcp-round3-20261117/codex/X07/edit-calls.json). [모두 반영]은 pid 차례로 반영하고 pid 는 여기 제안 입력 차례로 매겨진다(service.agentEdit·proposeMany).
 * 승인 방식 문서에서 옮기기가 먼저 반영되면 범위 안 글 제안은 사본(처리 전 '넣음') 안을 고치게 되어 승인 방식의 규칙(처리 안 된 변경 추적 안 글은 고치지 않는다)으로
 * OVERLAP 이 된다. 글 제안이 먼저면 옮기기는 지문 넘기기(server/paragraph-ops.js ①)로 STALE 이 되지 않아 세 문서 모드 모두 된다.
 * 규칙: 제안 입력에서 para_move 뒤에 그 범위 안 문단(중첩 주소 /nK 등은 그 본문 문단)을 가리키는 글 제안 — replace(fill·replace_all 의 몫 포함, 줄바꿈 없는 것)·format —
 *  이 있으면 para_move 를 그 가운데 마지막 것(그 op 의 제안 덩어리 끝) 바로 뒤로 옮긴다. 글 제안끼리의 차례·op 번호(영수증)는 그대로다.
 *  넘는 것은 문단 구조를 바꾸지 않는 replace·format 과 메모·답글 단계(저장은 어차피 맨 뒤 — agentEdit late)뿐이고, 다른 제안(넣기·표·문단 지우기·옮기기·줄바꿈 바꿈·
 *  개체 지우기·표 고치기·차례·'지금 적용')·여러 안·그림·차트 단계에서 멈춘다 — 그것과 옮기기의 차례는 결과를 바꾼다(범위 안 넣기·문단 가르기가 먼저면 범위가 갈라져
 *  옮기기가 STALE, 옮길 자리 뒤 넣기는 놓이는 차례가 바뀐다). 쪽 구성(structure)·거두기는 원래 맨 앞 단계라 상관없다.
 * 지우기(para_delete)는 옮기지 않는다: 범위 안 글 제안이 먼저면 고친 문단째 지우고(지문 넘기기), 지우기가 먼저면 그 제안이 lost 로 남을 뿐 문서 결과가 같다
 *  (tests/paragraph_delete_move.test.mjs '지우기 꼴' — 세 모드 × [모두 반영]·pid 차례·지우기 먼저 모두 같은 글). 영수증 notes 에 한 줄 남긴다.
 */
function textBeforeMoves(doc, steps, notes) {
  const HEAD = /^s(\d+)\/p(\d+)/;
  const hasBreak = (x) => /[\r\n]/.test(String(x.replace ?? '')) || (Array.isArray(x.runs) && x.runs.some((r) => /[\r\n]/.test(String(r?.text ?? ''))));
  const refOf = (x) => { if (x.ref) return x.ref; if (x.fieldFill) { try { return pickField(doc, x.fieldFill).ref; } catch { return null; } } return null; };
  // 넘을 수 있는 글 제안이면 그 본문 문단 { sec, body }, 아니면 null(여기서 멈춘다)
  const textAt = (x) => {
    if (x.applyNow || !(x.type === 'replace' || x.type === 'format') || (x.type === 'replace' && hasBreak(x))) return null;
    const m = HEAD.exec(refOf(x) || '');
    return m ? { sec: Number(m[1]), body: Number(m[2]) } : null;
  };
  const moves = steps.flatMap((s) => (s.kind === 'proposals' ? s.items.filter((it) => it.input.type === 'para_move' && !it.input.applyNow) : []));
  for (const mv of moves) {
    const a = HEAD.exec(mv.input.ref || ''); const b = HEAD.exec(mv.input.toRef || mv.input.ref || '');
    if (!a || !b) continue;
    const sec = Number(a[1]); const from = Number(a[2]); const to = Number(b[2]);
    const si = steps.findIndex((s) => s.kind === 'proposals' && s.items.includes(mv));
    const start = steps[si].items.indexOf(mv);
    let target = null; const hit = [];
    scan: for (let k = si; k < steps.length; k++) {
      const s = steps[k];
      if (s.kind === 'memo' || s.kind === 'reply') continue;
      if (s.kind !== 'proposals') break;
      for (let j = k === si ? start + 1 : 0; j < s.items.length; j++) {
        const t = textAt(s.items[j].input);
        if (!t) break scan;
        if (t.sec === sec && t.body >= from && t.body <= to) { target = { k, j }; if (!hit.includes(s.items[j].index)) hit.push(s.items[j].index); }
      }
    }
    if (!target) continue;
    const dest = steps[target.k].items;
    let j = target.j; while (j + 1 < dest.length && dest[j + 1].index === dest[j].index) j++;   // op 하나의 제안 덩어리를 가르지 않는다
    steps[si].items.splice(start, 1);
    if (target.k === si) j--;
    dest.splice(j + 1, 0, mv);
    if (!steps[si].items.length) steps.splice(si, 1);
    notes.push({ op: mv.index, note: `ops[${mv.index}] move_paragraphs 는 그 범위 안을 고치는 ops[${hit.join(', ')}] 뒤에 제안했습니다([모두 반영]이 글을 먼저 고친 뒤 옮긴다)` });
  }
}

/**
 * 묶음 달기(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-11): 5쪽 논문(edit 한 번, ops 8개)이 제안 54건 = 카드 54개가 됐다.
 * 제안은 지금처럼 하나씩 저장하고(반영·충돌·되돌리기 규칙 그대로) 한 덩어리에 같은 bundle 을 달아 화면·셈에서 항목 하나로 본다
 * (server/memotext.js requestItems · web/util.js requestProgress · docs/UI_TERMS.md §9).
 *  (a) 제안 여럿으로 풀린 op 하나(insert paragraphs·목록 at 의 format·이름으로 여러 칸을 채우는 fill·범위 delete_objects·replace_all 등) = 한 묶음
 *  (b) 같은 after 에 잇달아 넣는 넣기 op(insert·table·figure·chart — 반영하면 pid 차례로 이어 놓인다, server/service.js _insertAfterRef)는 op 가 달라도 한 묶음
 *  (c) 제안 하나뿐이면 묶음 없음. 여러 안(alternatives — gid)·메모·쪽 구성·'지금 적용' 차례는 묶지 않고 잇달음을 끊는다.
 *  (d) 한 호출 안의 같은 종류 제안(바꿈끼리·서식끼리·문단 지우기끼리·개체 지우기끼리)은 op 가 달라도 한 묶음(2026-11-17). 그림 바꾸기·표 고치기·차례·문단 옮기기는 (a) 만
 * op 갈래가 어떻게 풀리든(다른 작업이 고치는 중) 풀린 steps 만 보고 한 번 훑는다. 입력(input.bundle)에 싣고 _proposeCore 가 p.bundle 로 저장한다.
 */
export function newBundleId() {
  return `b${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
const INSERT_TYPES = new Set(['insert', 'table']);
// (d) 의 종류(2026-11-17 — REPORT.md 문제 5: X06 '8쪽으로 줄이기'가 delete_paragraphs op 여럿 + replace 여럿으로 제안 24 = 카드 24)
const KIND_BUNDLE = new Set(['replace', 'format', 'para_delete', 'delete']);
function markBundles(steps) {
  // 단위 = op 하나가 낸 제안 입력들(같은 step 안에서 index 가 같은 잇닿은 항목). 끊는 step 은 null
  const units = [];
  for (const s of steps) {
    if (s.kind === 'proposals') {
      for (const it of s.items) {
        if (it.input.applyNow) { units.push(null); continue; }
        const last = units[units.length - 1];
        if (last && last.step === s && last.index === it.index) last.inputs.push(it.input);
        else units.push({ step: s, index: it.index, inputs: [it.input] });
      }
    } else if (s.kind === 'figure' || s.kind === 'chart') units.push({ step: s, index: s.index, inputs: [s.input] });
    else units.push(null);
  }
  // 넣기 단위의 자리: 모든 입력이 같은 자리 뒤에 새로 넣는 것일 때만(그림 바꾸기는 넣기가 아니다)
  const insertAt = (u) => {
    const at = u.inputs.map((x) => (u.step.kind === 'proposals' ? (INSERT_TYPES.has(x.type) ? x.afterRef : null) : x.replaceRef ? null : x.afterRef));
    return at.every((a) => a && a === at[0]) ? at[0] : null;
  };
  // (d) 같은 종류 묶음: 바꿈·서식·문단 지우기·개체 지우기는 이 호출 안의 같은 종류끼리 op 가 달라도(떨어져 있어도) 한 묶음 — 넣기 잇달음(b)과는 겹치지 않는다
  const byType = new Map();
  const typeOf = (u) => { if (u.step.kind !== 'proposals') return null; const t = u.inputs[0].type; return KIND_BUNDLE.has(t) && u.inputs.every((x) => x.type === t) ? t : null; };
  const groups = []; let chain = null;
  for (const u of units) {
    const at = u ? insertAt(u) : null;
    if (u && at && chain?.at === at) { chain.inputs.push(...u.inputs); continue; }
    const t = u && !at ? typeOf(u) : null;
    if (t) {
      if (byType.has(t)) byType.get(t).inputs.push(...u.inputs); else { const g = { at: null, inputs: [...u.inputs] }; byType.set(t, g); groups.push(g); }
      chain = null; continue;
    }
    chain = u ? { at, inputs: [...u.inputs] } : null;
    if (chain) groups.push(chain);
    if (chain && !at) chain = null;   // 넣기가 아닌 단위는 뒤와 잇지 않는다
  }
  for (const g of groups) {
    if (g.inputs.length < 2) continue;
    const id = newBundleId();
    for (const x of g.inputs) x.bundle = id;
  }
}

// replace_all 이 찾지 않는 곳(영수증에 적는다): 바탕쪽 글은 문단 목록(engine HwpxDoc.paragraphs)에 없고, 메모 글은 의견이라 바꾸지 않는다
const FIND_ALL_SKIPS = '바탕쪽·메모';
const FIND_ALL_MAX = 1000;
const regexEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 문단 종류 이름(영수증의 어디서 바꿨는지) */
const whereOf = (p) => (!p.parent ? '본문' : p.where === '표' ? (p.cell ? '표 칸' : '표 캡션') : p.where === '그림' ? '그림 캡션' : p.where);

/**
 * replace_all 의 일치 찾기 → { matches: [{ ref, find(문서에 있는 그대로), occurrence(doc.find 의 셈 — 1부터, 겹치는 자리도 센다) }], paragraphs, where } | { error }.
 * 범위 안 모든 문단(본문·표 칸·캡션·글상자·머리말·꼬리말·각주·미주 — 최종본 보기, 지운 개체 안 문단 제외)을 훑는다. 한 문단 안 일치는 겹치지 않게 앞에서부터.
 */
function findAll(doc, op) {
  let pick = null;
  if (Array.isArray(op.at)) { const set = new Set(op.at); pick = (ref) => set.has((/^s\d+\/p\d+/.exec(ref) || [ref])[0]); }
  else {
    let rp; try { rp = rangePicker(op.at); } catch (e) { return { error: e.message }; }
    if (rp) pick = (ref) => { const m = /^s(\d+)\/p(\d+)/.exec(ref); return !!m && rp(Number(m[1]), Number(m[2])); };
  }
  if (!op.ignore_case && op.find === op.with) return { error: 'find 와 with 가 같습니다' };
  const edge = op.word ? ['(?<![\\p{L}\\p{N}])', '(?![\\p{L}\\p{N}])'] : ['', ''];
  const re = new RegExp(`${edge[0]}${regexEscape(op.find)}${edge[1]}`, `gu${op.ignore_case ? 'i' : ''}`);
  const matches = []; const where = new Map(); let paragraphs = 0;
  for (const p of doc.paragraphs({ view: 'final', nested: true })) {
    if (p.hidden || (pick && !pick(p.ref)) || !p.text) continue;
    const t = p.text; let hit = 0;
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const s = m[0]; if (!s) { re.lastIndex++; continue; }
      if (op.ignore_case && s === op.with) continue;   // 이미 바꿀 글 그대로인 곳(대소문자만 다른 찾기)
      // doc.find(ref, s, n) 은 한 글자씩 옮기며 센다 — 이 자리까지의 같은 글 개수가 그 셈의 n
      let n = 0; for (let at = t.indexOf(s); at >= 0 && at <= m.index; at = t.indexOf(s, at + 1)) n++;
      matches.push({ ref: p.ref, find: s, occurrence: n }); hit++;
    }
    if (hit) { paragraphs++; const w = whereOf(p); where.set(w, (where.get(w) || 0) + hit); }
  }
  const scope = op.at == null || op.at === '*' ? '문서 전체' : Array.isArray(op.at) ? `문단 ${op.at.length}개` : op.at;
  if (!matches.length) return { error: `「${op.find}」 을 찾지 못했습니다 — 찾은 곳: ${scope}의 본문·표 칸·캡션·글상자·머리말·꼬리말·각주${op.word ? '(낱말 단위)' : ''}${op.ignore_case ? '(대소문자 무시)' : ''}, 찾지 않은 곳: ${FIND_ALL_SKIPS}. read(view='text', find) 로 글을 확인하세요` };
  if (matches.length > FIND_ALL_MAX) return { error: `일치가 ${matches.length}곳입니다 — 한 op 에 ${FIND_ALL_MAX}곳까지(at 범위를 나누세요)` };
  return { matches, paragraphs, where: [...where].map(([k, c]) => `${k} ${c}`).join('·') };
}

/**
 * 문단 지우기·옮기기의 at → { from, to }(본문 문단 주소) | { error }. 's1/p8' · 's1/p8..p13' · 's1/p8..s1/p13' · 이어진 본문 문단 목록(차례는 상관없음, 한 구역)
 */
function paragraphSpan(at) {
  const how = "'s1/p8' · 범위 's1/p8..p13' · 이어진 문단 목록 꼴";
  if (Array.isArray(at)) {
    const list = [...new Set(at)].map((r) => /^s(\d+)\/p(\d+)$/.exec(r)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (!list.length) return { error: `본문 문단 주소가 필요합니다(${how})` };
    if (list.some((x) => x[0] !== list[0][0])) return { error: '여러 구역에 걸친 목록입니다 — 구역마다 op 를 나누세요' };
    if (list.some((x, k) => x[1] !== list[0][1] + k)) return { error: '떨어진 문단이 섞인 목록입니다 — 이어진 문단끼리 op 를 나누세요' };
    return { from: `s${list[0][0]}/p${list[0][1]}`, to: `s${list[0][0]}/p${list[list.length - 1][1]}` };
  }
  const m = /^\s*s(\d+)\/p(\d+)\s*(?:\.\.\s*(?:s(\d+)\/)?p(\d+)\s*)?$/.exec(String(at ?? ''));
  if (!m) return { error: /^\s*s\d+\s*$/.test(String(at)) ? `구역 전체(${at})는 고를 수 없습니다(구역 첫 문단은 구역 정의라 지울 수 없다) — 's1/p1..p73' 처럼 범위로` : /\/[nd]\d|#/.test(String(at)) ? `본문 문단만 고를 수 있습니다(표 칸·글상자 안 문단은 replace 로): ${at}` : `범위가 올바르지 않습니다: ${at} — ${how}` };
  const sec = Number(m[1]);
  if (m[3] != null && Number(m[3]) !== sec) return { error: `범위가 구역을 넘습니다(${at}) — 구역마다 op 를 나누세요` };
  return { from: `s${sec}/p${m[2]}`, to: `s${sec}/p${m[4] ?? m[2]}` };
}
