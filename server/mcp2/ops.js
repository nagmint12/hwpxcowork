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
import { replaceRange, rangeConflicts, foldReplaceAll, shortText } from './apply-check.js';
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
  // 2026-11-19(§17): 표 칸 주소 = 그 칸의 문단 전체(find 는 칸의 문단을 차례로 찾고 whole:true 는 칸을 통째로 다시 쓴다), 문단 전체를 바꾸는 with 의 줄바꿈 = 문단 나눔(칸 안에서도)
  replace: { sig: "{op:'replace', at, find, with, occurrence?, reason?} — at 문단의 find 글을 with 로(지우기는 with:''). 같은 글이 여럿이면 occurrence 번째(1부터, 없으면 첫 번째). 문단 글 전체를 바꾸려면 find 대신 whole:true. 빈 문단·빈 표 칸에 넣기는 find:''(그 문단의 스타일도 함께 주려면 style:'스타일 이름'). 글을 다 지워도 빈 문단은 남는다(문단째 지우기는 delete_paragraphs). with 의 줄바꿈: 본문 문단과 문단 전체를 바꾸는 표 칸 문단(whole:true)에서는 줄마다 한 문단으로 나뉜다(표 칸 문단의 글 일부만 바꿀 때는 같은 문단 안 줄 나눔). at 이 표 칸 {table,row,col} 이면 그 칸의 문단 전체가 대상이다 — find 는 칸의 문단을 차례로 찾고, whole:true 는 칸을 통째로 with 의 줄마다 한 문단으로 다시 쓴다(남는 문단은 지워지고 모자라면 생긴다. 새 문단의 모양은 같은 글머리(□·ㅇ·- …)로 시작하는 가까운 문단을 따른다). 칸 안 한 문단만은 그 문단 주소('s0/p3/n9') 또는 {table,row,col,para:k}. 칸 안 문단 수를 바꾸는 것(통째로 다시 쓰기·문단 나눔·칸 안 insert·delete_paragraphs)은 칸마다 모아 표 고치기 제안 하나로 나오고 변경 추적 없이 바로 고친다(문단 수를 그대로 두는 문단별 replace 는 예전처럼 문단마다의 바꿈 제안)",
    schema: z.object({ op: z.literal('replace'), at, find: z.string().optional(), whole: z.boolean().optional(), with: text, occurrence: z.number().int().min(1).optional(), style: z.string().max(160).optional(), format: FormatSchema.optional(), runs: RunsSchema.optional(), reason }).strict() },
  insert: { sig: "{op:'insert', after, paragraphs:[{text, style?, runs?}], reason?} — after 문단 뒤에 문단들을 차례대로(빈 줄은 text:''). 한 문단이면 text 만 줘도 된다. style = 문단 스타일 이름. 글 일부만 굵게 등은 text 대신 runs:[{text, char:{bold…}}, {text}]. 같은 after 에 낸 넣기(insert·table·figure)는 함께 반영하면 낸 차례대로 놓인다. after 가 표 칸 문단('s0/p3/n9')이면 그 칸 안, 그 문단 뒤에 넣는다 — 글만 받고(style·format·runs 는 쓰지 않는다) 모양은 같은 글머리로 시작하는 가까운 칸 문단을 따른다",
    schema: z.object({ op: z.literal('insert'), after: ref, text: text.optional(), style: z.string().max(160).optional(), paragraphs: z.array(paragraph).min(1).max(500).optional(), reason }).strict() },
  table: { sig: "{op:'table', after, rows:[[칸 글…]…], header_rows?, caption?, unit?, notes?, reason?} — 새 표(caption 은 제목만 — 번호는 자동). unit:'명, %' → 표 앞 '(단위: 명, %)', notes:'주: …'|['주: …','자료: …'] → 표 아래 주석(문서 서식대로 — insert 로 따로 넣지 않는다)",
    schema: z.object({ op: z.literal('table'), after: ref, rows: z.array(z.array(z.string().max(5000)).min(1).max(60)).min(1).max(1000), header_rows: z.number().int().min(0).max(20).optional(), caption: z.string().max(500).optional(), unit: z.string().max(200).optional(), notes, merges: z.array(z.string().max(40)).max(2000).optional(), like: z.string().max(200).optional(), reason }).strict() },
  table_edit: { sig: "{op:'table_edit', table, ops:[{op:'delete_rows'|'insert_rows'|'delete_cols'|'insert_cols'|'merge'|'unmerge'|'border'|'fill'|'col_widths'|'row_height'|'cell_align'|'table', …}], reason?} — 있는 표의 줄·칸·합치기·테두리·너비. 줄 넣기 {op:'insert_rows', row, position:'below'|'above', values:[[칸 글…]]}(합계 줄처럼 새 줄과 글을 한 번에), 배경 {op:'fill', range:{row_from,row_to,col_from?,col_to?}, color:'#RRGGBB'}, 그 밖의 인자는 read view='guide' id='table_edit'",
    schema: z.object({ op: z.literal('table_edit'), table: z.string().min(1), ops: z.array(TableOpSchema).min(1).max(40), reason }).strict() },
  format: { sig: "{op:'format', at, find?, style?, char?, paragraph?, reason?} — 글은 그대로 서식만. at 은 문단 하나나 목록, find 를 주면 그 글만(문단 하나일 때). 여러 문단은 한 op 로: 범위 's0/p3..p9'·구역 's1'·'*'(본문 문단만 — 표 칸은 들지 않는다), 표 's0/p3#t0'(그 표의 모든 칸), {table, row_from?, row_to?, col_from?, col_to?}(칸 범위 — 머리행은 row_from:0,row_to:0, 0부터), {style:'기존 이름'}(해당 문단 스타일 전체), 이들의 목록. 칸·문단마다 op 를 내지 않는다 — 대상 문단이 20개를 넘거나 범위·표 꼴이면 문단마다의 제안 대신 제안 하나(서식 일괄 — 영수증의 structure)로 묶인다(뒤 op 가 앞 op 를 덮는다: 표 전체 → 머리행 차례로). style = 스타일 이름(같은 호출의 styles 가 들여온·정의한 이름도 된다), char {bold, italic, underline, sizePt, font, color:'#RRGGBB'…}, paragraph {align, lineSpacing, indentPt…, pageBreakBefore:true|false(이 문단 앞에서 새 쪽 — 쪽 나누기 켜기·끄기, 본문 문단 하나씩만)}",
    schema: z.object({ op: z.literal('format'), at: z.union([formatAt, z.array(formatAt).min(1).max(2000)]), find: z.string().optional(), occurrence: z.number().int().min(1).optional(), start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional(),
      style: z.string().max(160).optional(), char: CharFormatSchema.optional(), paragraph: ParagraphFormatSchema.optional(), reason }).strict() },
  delete_objects: { sig: "{op:'delete_objects', at, kinds?, reason?} — 표·그림·도형(글상자·선)·차트를 개체째 지운다(안의 글도 사라진다). at: 본문 문단 's0/p3' · 목록 · 범위 's0/p3..p9' · 구역 's2' · 문서 전체 '*'. kinds: ['table','figure','shape','chart'] 가운데(없으면 모두). objects_to_body 로 옮기는 문단에는 내지 않는다(옮긴 글상자·선은 그 op 가 지운다)",
    schema: z.object({ op: z.literal('delete_objects'), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(BODY_REF)).min(1).max(1000)]), kinds: z.array(z.enum(KINDS)).min(1).optional(), reason }).strict() },
  // [hwpx-cowork] 문단 통째로 지우기·옮기기(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-1: T10 은 글만 지워 빈 문단 6개, T09 는 다시 만들어 표가 새 표)
  // → 제안 para_delete·para_move 하나(server/paragraph-ops.js). 범위는 한 구역 안의 이어진 본문 문단(engine/para-move.js paragraphRange 가 막는 것: 구역 첫 문단·구역 나누기·걸친 필드)
  // 2026-11-19(§17): 표 칸 안 문단도 받는다(한 칸의 문단들 — 글만 든 문단). 실제 Codex 실행이 칸 문단 목록을 냈다가 꼴 오류를 받고 글만 비워 빈 문단 17개를 남겼다
  delete_paragraphs: { sig: "{op:'delete_paragraphs', at, reason?} — 본문 문단을 통째로(안의 표·그림까지, 빈 줄 없이) 지운다. at: 's1/p8' · 's1/p8..p13' · 이어진 목록(한 구역, p0 제외). 표 칸 안 문단도 통째로 지운다: at 에 칸 문단 's0/p3/n9' · 범위 's0/p3/n9..n12' · 목록(한 칸의 문단들 — 떨어져 있어도 된다. 표·그림·메모가 든 문단은 지우지 못한다, 칸의 문단을 모두 지우면 빈 문단 하나가 남는다)",
    schema: z.object({ op: z.literal('delete_paragraphs'), at: z.union([z.string().min(1).max(200), z.array(z.string().regex(REF)).min(1).max(500)]), reason }).strict() },
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
// v3 실험 연결에만 있는 op(2026-11-20 — 문서 끼워 넣기 §21). 다른 연결에서는 모르는 op 처럼 거절하고(parseOps surface) 이름 목록·꼴에 싣지 않는다
export const V3_ONLY_OPS = Object.freeze(['insert_document']);
export const VISIBLE_OP_NAMES = OP_NAMES.filter((name) => !HIDDEN_OPS.includes(name) && !V3_ONLY_OPS.includes(name));
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
  // 2026-11-19(+136자 — §17): 칸 주소 = 칸의 문단 전체, whole 의 줄바꿈 = 문단 나눔, 칸 안에 넣기. 실제 Codex 실행 3건이 문단 21개인 칸을 다시 쓰지 못했다
  // (칸 주소의 whole:true 가 첫 문단만 바꿨고, 칸 문단 뒤 insert 는 표 밖 본문으로 갔다 — 설명에 칸 안 문단을 다루는 길이 없었다)
  replace: "{op:'replace', at, find|whole:true, with, occurrence?, style?, reason?} — find(그 문단에 그대로 있는 글)를 with 로. 같은 글이 여럿이면 occurrence 번째(1부터). 빈 문단·빈 칸에 넣기는 find:''. whole:true 의 with 줄바꿈은 문단 나눔. at 이 칸({table,row,col})이면 find 는 칸 전체에서 찾고 whole:true 는 칸의 문단 전체를 with 의 줄들로 다시 쓴다. 글을 다 지워도 빈 문단은 남는다(문단째 지우기는 delete_paragraphs)",
  insert: "{op:'insert', after, paragraphs:[{text|runs, style?, format?}…] | text, reason?} — after 뒤에 차례대로(빈 줄 text:''. after 가 표 칸 문단이면 그 칸 안에 — 글만). 글 일부 서식은 runs:[{text, char:{bold:true}}, {text}]. 새 쪽 시작은 format:{paragraph:{pageBreakBefore:true}}. 같은 after 의 넣기(insert·table·figure)는 낸 차례대로 놓인다",
  table: "{op:'table', after, rows:[[칸 글…]…], header_rows?(기본 1), caption?, unit?, notes?, reason?} — caption 은 제목만(번호 자동). unit:'명, %' → 표 앞 단위 줄, notes:'주: …'|[…] → 표 아래 주석(insert 로 따로 넣지 않는다)",
  table_edit: "{op:'table_edit', table, ops:[…], reason?} — 있는 표 고치기. ops 항목: {op:'insert_rows', row, position?:'below'|'above', values?:[[칸 글…]]} · {op:'delete_rows', rows:[…]} · {op:'fill', range:{row_from,row_to,col_from?,col_to?}, color:'#RRGGBB'} · delete_cols·insert_cols·merge·unmerge·border·col_widths·row_height·cell_align·table(인자는 read view='guide' id='table_edit')",
  // 2026-11-18(+190자): 범위·표 대상 — 실제 Codex 실행이 칸마다 op 3,141개를 냈다(한도 초과·120초 시간 초과, §15)
  format: "{op:'format', at, find?, style?, char?:{bold,italic,underline,sizePt,font,color:'#RRGGBB'…}, paragraph?:{align,lineSpacing:{type:'PERCENT',value},indentPt…,pageBreakBefore:true|false}, reason?} — at: 문단·칸 | 목록 | 범위 's0/p3..p9'·구역 's1'·'*'(본문 문단) | 표 's0/p3#t0'(모든 칸) | {table, row_from?, row_to?, col_from?, col_to?} | {style:'기존 스타일'}. find는 글 일부. 칸·문단마다 op 를 내지 않는다",
  // 2026-11-18(+215자): 스타일 들여오기 — 같은 실행이 '새 스타일을 만들 도구가 없다'며 문단·칸마다 직접 서식을 줬다(§15)
  styles: "{op:'styles', import?:'standard', define?:[{name,base?,char?,paragraph?,applyToBase?}], update?:[{name,char?,paragraph?}]} — 표준서식 들여오기·생성. applyToBase:true 또는 update로 동일 스타일 전체 적용. 글머리표 등은 read(view='guide',id='styles'), 이름은 read(view='styles')",
  delete_objects: "{op:'delete_objects', at, kinds?:['table'|'figure'|'shape'|'chart'], reason?} — 개체째 지운다(안의 글도). at: 's0/p3'·목록·'s0/p3..p9'·'s2'·'*'",
  // 2026-11-19(+45자 — §17): 표 칸 안 문단. 실제 Codex 실행이 칸 문단 20개를 지우려다 꼴 오류를 받고 글만 비워 빈 문단을 남겼다
  delete_paragraphs: "{op:'delete_paragraphs', at, reason?} — 본문 문단을 통째로(안의 표·그림까지, 빈 줄 없이). at: 's1/p8'·'s1/p8..p13'·이어진 목록(한 구역, p0 제외) | 표 칸 안 문단 's0/p3/n9'·'s0/p3/n9..n12'·목록(한 칸)",
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

// v3(실험 연결) 표 op 안내(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §20): 병합(merges)·본보기 표(like)·칸 안 줄바꿈·적은 그대로의 단위 문구.
// 단위·주석을 둘지, 어디에(표 안 행·표 밖 문단·왼쪽·오른쪽) 둘지는 정하지 않는다 — 문서마다 다르므로 모델이 문서의 기존 표를 보고 고른다(사용자 결정).
// v2 의 BRIEF.table·OPS.table.sig 는 그대로(v2 기본 연결의 계약)
const TABLE_V3 = {
  sig: "{op:'table', after, rows:[[칸 글…]…], header_rows?, caption?, merges?, like?, unit?, notes?, reason?} — 새 표(caption 은 제목만 — 번호는 자동). 칸 글의 줄바꿈은 칸 안 줄 나눔. merges:['r0c0:r0c5',…] = 합칠 칸(read 의 병합 표기와 같다 — 0부터, 왼쪽 위 칸 글이 남으니 덮이는 칸은 빈 글로). like:'s0/p3#t0' = 그 표의 모양(칸 테두리·글자·정렬·열 폭)을 따른다 — 행·열 수가 같으면 칸마다 그대로이고, merges 를 주지 않으면 그 표의 병합도 따른다. unit·notes 는 고를 수 있는 인자 — 표 앞 단위 줄·표 아래 주석 문단을 붙인다(unit 은 적은 글 그대로 — 괄호로 감쌌거나 '단위:'가 든 글은 그대로, 단위 낱말만 주면 '(단위: …)'). 단위·주석을 둘지, 표 안 행과 표 밖 문단 가운데 어디에 둘지는 문서의 기존 표를 보고 정한다(표 안이면 rows 에 넣고 merges). after 가 표 칸 문단이면 그 칸 안에 새 표(칸 폭에 맞춘 글자처럼 취급 표 — caption·unit·notes 없이).",
  brief: "{op:'table', after, rows:[[칸 글…]…], header_rows?(기본 1), caption?, merges?:['r0c0:r0c5'…], like?:'표 열쇠', unit?, notes?, reason?} — caption 은 제목만(번호 자동). 칸 글 줄바꿈 = 칸 안 줄 나눔. merges = read 의 병합 표기(덮이는 칸은 빈 글). like = 그 표 모양 따르기(크기가 같으면 칸·열 폭·병합까지). unit·notes(고를 수 있음) = 표 앞 단위 줄·표 아래 주석 문단(unit 은 적은 글 그대로). 단위·주석을 둘지, 표 안 행·밖 문단 어디에 둘지는 문서의 기존 표를 보고 정한다. after 가 표 칸 문단이면 그 칸 안에 새 표(칸 폭에 맞춘 글자처럼 취급 표 — caption·unit·notes 없이).",
};
// 문서 끼워 넣기(v3 실험 — 2026-11-20 §21). 사용자 결정(같은 날 밤): 도구 설명(sig·brief — edit 설명·Codex 첫 입력·guide 'ops' 목록)에는 '이런 op 가 있다'만 싣는다 —
// 이 길로 문서를 만들라는 권유·효율 비교 문구를 넣지 않는다. 쓰는 법은 모델이 물을 때만(read view='guide' id='document' — 중립적 꼴 설명)
const INSERT_DOCUMENT_V3 = {
  sig: "{op:'insert_document', after, attachment_id} — (실험) HWPX 첨부의 본문을 after 문단 뒤에 넣는다(제안 하나). 꼴: read(view='guide', id='document')",
  brief: "{op:'insert_document', after, attachment_id} — (실험) HWPX 첨부의 본문을 after 문단 뒤에 넣는다. 꼴: read(view='guide', id='document')",
  guide: [
    "문서 끼워 넣기(실험 — insert_document): HWPX 첨부(upload_result_file 로 올린 aid)의 본문 문단을 after 문단 뒤에 넣는다 — 넣은 문단 전체가 제안 하나.",
    "1. download_attachment_file({doc_id, attachment_id:'template'}) → 작업 폴더 in/ 에 '…-빈 서식.hwpx': 이 문서의 Contents/header.xml(스타일·글자·문단 모양·테두리)·바탕쪽·쪽 설정 그대로이고 본문은 구역마다 구역 정의 문단 하나. 제목·표를 이 문서와 똑같은 꼴로 하려면 attachment_id:'document'(이 문서 사본)도 받아 그 XML 을 본뜬다.",
    "2. 파이썬 등으로 zip 을 열어 Contents/section0.xml 의 첫 <hp:p>(hp:secPr 를 든 구역 정의 문단 — 그대로 둔다) 뒤에 <hp:p> 문단을 차례로 쓴다. 문단 꼴: <hp:p id=\"0\" paraPrIDRef=\"…\" styleIDRef=\"…\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"…\"><hp:t>글</hp:t></hp:run></hp:p> — 번호는 header.xml 의 hh:style(name·paraPrIDRef·charPrIDRef)에서 이름으로 고르거나 사본의 같은 꼴 문단에서 그대로 가져온다. 표는 사본의 표 문단(<hp:tbl> 포함)을 복사해 칸 글(hp:t)을 고친다(행을 늘리거나 줄이면 hp:tr 과 rowCnt·cellAddr rowAddr·cellSpan 을 맞춘다). 줄 정보(hp:linesegarray)는 빼도 된다. 개체·누름틀 id 는 서버가 새로 매긴다. zip 은 mimetype 을 맨 앞·무압축으로 다시 묶는다.",
    "3. upload_result_file({doc_id, request_id, path}) → aid. 4. edit 의 {op:'insert_document', after:'s0/p12', attachment_id:aid} — 넣은 문단 전체가 제안 하나(되돌리기 한 번). 다른 op 와 한 호출에 낼 수 있다(주소는 읽은 그대로). 먼저 dry_run 으로 문단·표 수를 볼 수 있다.",
    "받지 않는 것: 차트(그림 figure 로). 메모는 부호를 지우고 글만 넣는다. 빈 서식의 구역 정의 문단(쪽 설정·머리말·꼬리말)은 넣지 않는다 — 이 문서 것을 쓴다(그 문단에 쓴 글만 보통 문단으로 넣는다).",
  ].join('\n'),
};
export const OPS_BRIEF_V3 = OPS_BRIEF.replace(`· ${BRIEF.table}`, `· ${TABLE_V3.brief}`) + `\n· ${INSERT_DOCUMENT_V3.brief}`;
/** 연결별 op 꼴 목록(edit 도구 설명·Codex 첫 입력) — v3 는 표 줄만 다르다 */
export const opsBrief = (surface) => (surface === 'v3' ? OPS_BRIEF_V3 : OPS_BRIEF);
const sigOf2 = (k, surface) => (surface === 'v3' && k === 'table' ? TABLE_V3.sig : OPS[k].sig);

/**
 * 모든 op 의 꼴(read view='guide' id='ops'). 숨긴 op(HIDDEN_OPS — chart)는 목록에 싣지 않고 끝에 한 줄로만 알린다(AI 가 op 를 찾아 물었을 때의 안내),
 * id='chart' 는 쓰는 조건·꼴·JSON Schema 를 준다
 */
export function opsGuide(topic = 'ops', surface = 'v2') {
  if (topic === 'document') return surface === 'v3' ? INSERT_DOCUMENT_V3.guide : '문서 끼워 넣기(insert_document)는 v3 연결의 실험 기능입니다.';
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
  if (topic === 'page') return `쪽 구성 op(JSON Schema):\n${JSON.stringify(z.toJSONSchema(z.union(StructureOpSchema.options.filter((o) => { const v = o.shape.op; return !(v.options ?? [...(v.values || [])]).some((name) => HIDDEN_OPS.includes(name) || V3_ONLY_OPS.includes(name)); })), { reused: 'ref' }))}`;
  return ['edit 의 ops — 주소(at·after)는 read 가 보여 준 그대로 쓴다. 표 칸은 at:{table:\'s0/p3#t0\', row, col}(0부터).',
    ...Object.keys(OPS).filter((k) => !HIDDEN_OPS.includes(k)).map((k) => `· ${sigOf2(k, surface)}`), ...Object.keys(STRUCTURE_SIG).filter((k) => k !== 'footer').map((k) => `· ${STRUCTURE_SIG[k]}`), ...(surface === 'v3' ? [`· ${INSERT_DOCUMENT_V3.sig}`] : []),
    '쪽 구성 op(paper·section·header·footer·page_number·master_page·split_section·merge_section)와 objects_to_body, styles 와 여러 문단 format 은 한 호출의 것을 묶어 제안 하나(되돌리기 한 번)로 낸다 — 그 안에서는 styles → 여러 문단 format → 나머지 차례로 반영된다.',
    "더 자세한 인자: read view='guide' id='table_edit' | 'page'",
    "목록에 없는 op: 한/글 차트 개체(한/글에서 다시 편집하는 차트)는 사용자가 그것을 명시해 요청했을 때만 — read view='guide' id='chart'. 그 밖의 차트·그래프는 figure 로 직접 그린다."].join('\n');
}

/**
 * op 이름 하나의 자세한 꼴(read view='guide' id='replace' 처럼 op 이름으로 물었을 때 — 2026-11-19: 실제 Codex 실행이 그렇게 물었다가 표준서식 작성 지침을 받았다)
 * → 글 | null(op 이름이 아니거나 숨긴 op — 숨긴 op 는 드러내지 않는다)
 */
export function opGuide(name, surface = 'v2') {
  const key = String(name ?? '');
  const sig = HIDDEN_OPS.includes(key) ? null : key === 'insert_document' ? (surface === 'v3' ? INSERT_DOCUMENT_V3.sig : null) : (Object.hasOwn(OPS, key) ? sigOf2(key, surface) : Object.hasOwn(STRUCTURE_SIG, key) ? STRUCTURE_SIG[key] : null);
  return sig ? `· ${sig}\n모든 op 의 꼴: read view='guide' id='ops'` : null;
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
// 오류 글 끝에 그 op 의 꼴을 붙인다 — 연결마다의 꼴(2026-11-20: v3 의 표 오류에 v2 꼴의 '단위·주석은 unit·notes 로(insert 로 따로 넣지 않는다)'가 붙어 v3 안내와 어긋났다)
const sigFor = (name, surface) => (surface === 'v3' && name === 'table' ? TABLE_V3.sig : name === 'insert_document' ? (surface === 'v3' ? INSERT_DOCUMENT_V3.sig : '') : sigOf(name));
const failAt = (index, name, message, surface = 'v2') => { const sig = sigFor(name, surface); return { index, error: `ops[${index}]${name ? ` ${name}` : ''}: ${message}${sig ? ` — 꼴: ${sig}` : ''}` }; };
const fail = (index, name, message) => failAt(index, name, message);

/** ops 를 꼴만 검사한다(문서를 보지 않는다) → { ok: [{ index, name, op }], errors: [{ index, error }] } */
export function parseOps(ops, { surface = 'v2' } = {}) {
  const fail = (index, name, message) => failAt(index, name, message, surface);
  const ok = []; const errors = [];
  if (!Array.isArray(ops) || !ops.length) return { ok, errors: [{ index: 0, error: 'ops(배열)가 필요합니다' }] };
  if (ops.length > 2000) return { ok, errors: [{ index: 0, error: 'ops 는 한 번에 2,000개까지입니다' }] };
  ops.forEach((raw, index) => {
    const name = raw && typeof raw === 'object' ? String(raw.op ?? '') : '';
    if (!OP_NAMES.includes(name) || (surface !== 'v3' && V3_ONLY_OPS.includes(name))) {
      const names = surface === 'v3' ? [...VISIBLE_OP_NAMES, ...V3_ONLY_OPS] : VISIBLE_OP_NAMES;
      errors.push({ index, error: `ops[${index}]: 모르는 op "${name}" — ${names.join(' · ')} 가운데 하나${V3_ONLY_OPS.includes(name) ? ' (이 op 는 v3 연결의 실험 기능입니다)' : ''}` });
      return;
    }
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
 * textRanges: 같은 호출 바꿈끼리 글 범위 검사·replace_all 합치기(checkTextRanges — v3 실험 연결만, 2026-11-20 §19)
 * previews: [{ op, preview }] — 문단 지우기·옮기기가 지울·옮길 문단 수와 첫 글·결과 차례(미리 해 보기 응답에 싣는다 — 2026-11-17 §10.4 나-1·나-9)
 */
export function prepareOps(doc, parsed, { earlier = [], textRanges = false, surface = 'v2' } = {}) {
  const fail = (index, name, message) => failAt(index, name, message, surface);
  const steps = []; const errors = []; const notes = []; const previews = [];
  // summaries: replace_all 의 개수 요약(영수증 한 줄 — 2026-11-17 §10.4 나-6), withdraw: 거두기 단계(맨 앞 하나)
  const summaries = []; let withdraw = null;
  // ── 표 칸 안 문단(2026-11-19 — docs/MCP_REDESIGN_2026-11-16.md §17) ──
  // 실제 Codex 실행 3건: 회의록 서식(내용이 표 칸 하나에 문단 21개)에서 칸 주소의 whole:true 가 칸의 첫 문단만 바꿨고(새 글이 줄바꿈으로 한 문단에 몰리고 옛 문단 20개가
  // 남았다), 칸 문단 뒤 insert 는 표 밖 본문으로 갔고, delete_paragraphs 는 칸 문단을 받지 않았다. 칸 주소 = 그 칸의 문단 전체로 풀고, 칸 안 문단을 넣고·지우고·나누는 것은
  // 칸마다 모아(cellPlans) 표 고치기 제안(engine/table-edit.js cell_paragraphs)으로 낸다 — 대기 제안은 문서를 바꾸지 않으므로 한 호출의 같은 칸 op 는 모두 읽은 주소
  // 그대로 받아 한 번에 푼다(칸마다 따로 내면 앞 제안을 반영한 뒤 뒤 제안의 문단 차례가 어긋난다)
  let allTables = null; let cellIndex = null;
  const tablesOf = () => (allTables ??= doc.tables());
  /** 칸 주소 {table,row,col} → { t(표), c(칸) } | null */
  const cellOfAddr = (a) => { const t = tablesOf().find((x) => x.key === a.table); const c = t?.cells.find((x) => a.row >= x.row && a.row < x.row + x.rowSpan && a.col >= x.col && a.col < x.col + x.colSpan); return c ? { t, c } : null; };
  /** 문단 주소 → { t, c, k(칸 안 차례 — 0부터) } | null(표 칸 문단이 아님) */
  const cellOfRef = (r) => {
    if (BODY_REF.test(r)) return null;
    if (!cellIndex) { cellIndex = new Map(); for (const t of tablesOf()) for (const c of t.cells) c.refs.forEach((x, k) => cellIndex.set(x, { t, c, k })); }
    return cellIndex.get(r) || null;
  };
  const cellName = (c) => `칸(${c.row}, ${c.col})`;
  const short = (s, max = 30) => { const t = [...String(s ?? '')]; return t.length > max ? `${t.slice(0, max).join('')}…` : t.join(''); };
  /** with·text 의 줄들(끝의 빈 줄은 뺀다 — 가운데 빈 줄은 빈 문단) */
  const linesOf = (s) => { const L = String(s ?? '').replace(/\r\n?/g, '\n').split('\n'); while (L.length > 1 && !L[L.length - 1].trim()) L.pop(); return L; };
  /** 칸의 문단을 차례로 훑어 find 의 occurrence 번째(1부터 — 칸 전체에서 센다, doc.find 처럼 겹치는 자리도 센다)가 든 문단 → { ref, occurrence(그 문단 안에서) } | null */
  const findInCell = (c, texts, find, occurrence = 1) => {
    let left = occurrence;
    for (let k = 0; k < texts.length; k++) {
      let n = 0; for (let at = texts[k].indexOf(find); at >= 0; at = texts[k].indexOf(find, at + 1)) n++;
      if (left <= n) return { ref: c.refs[k], occurrence: left };
      left -= n;
    }
    return null;
  };
  // 칸마다의 문단 구조 바꾸기: 열쇠 '표 열쇠@줄,칸' → { t, c, list(새 문단 차례 — {keep:k} | {text, near?}), indexes(이 칸을 고친 op 번호), whole(통째로 다시 씀), reason }
  const cellPlans = new Map();
  const planOf = ({ t, c }) => {
    const key = `${t.key}@${c.row},${c.col}`;
    if (!cellPlans.has(key)) cellPlans.set(key, { t, c, list: c.refs.map((_, k) => ({ keep: k })), indexes: [], whole: false, reason: null });
    return cellPlans.get(key);
  };
  const planTouch = (plan, index, reason) => { if (!plan.indexes.includes(index)) plan.indexes.push(index); plan.reason ??= reason || null; };
  const WHOLE_MIX = (c) => `${cellName(c)}을 통째로 다시 쓰는 op 와 그 칸의 문단을 넣거나 지우는 op 를 한 호출에 함께 낼 수 없습니다 — 통째로 다시 쓰는 op 하나로 모으세요`;
  const BUSY_PARA = (ref) => `${ref} 문단은 같은 호출의 다른 op 가 이미 지우거나 여러 문단으로 바꿉니다`;
  /** 칸을 통째로 줄들로 다시 쓰기 → 오류 글 | null */
  const planWhole = (hit, index, lines, reason) => {
    const plan = planOf(hit);
    if (plan.indexes.length) return WHOLE_MIX(hit.c);
    plan.list = lines.map((text) => ({ text })); plan.whole = true; planTouch(plan, index, reason);
    return null;
  };
  /** 칸 문단 하나(hit.k)를 줄들로 바꾸기(문단 나눔) */
  const planSplit = (hit, index, lines, reason) => {
    const plan = planOf(hit);
    if (plan.whole) return WHOLE_MIX(hit.c);
    const i = plan.list.findIndex((e) => e.keep === hit.k);
    if (i < 0) return BUSY_PARA(hit.c.refs[hit.k]);
    plan.list.splice(i, 1, ...lines.map((text) => ({ text, near: hit.k })));
    planTouch(plan, index, reason);
    return null;
  };
  /** 칸 문단(hit.k) 뒤에 줄들을 넣기 — 같은 문단 뒤에 여러 번 넣으면 낸 차례대로 놓인다 */
  const planInsert = (hit, index, lines, reason) => {
    const plan = planOf(hit);
    if (plan.whole) return WHOLE_MIX(hit.c);
    let i = plan.list.findIndex((e) => e.keep === hit.k || e.replaced === hit.k);
    if (i < 0) return `넣을 자리(after ${hit.c.refs[hit.k]})의 문단을 같은 호출의 다른 op 가 지우거나 여러 문단으로 바꿉니다 — 그 op 의 글에 함께 넣으세요`;
    while (i + 1 < plan.list.length && plan.list[i + 1].after === hit.k) i++;
    plan.list.splice(i + 1, 0, ...lines.map((text) => ({ text, near: hit.k, after: hit.k })));
    planTouch(plan, index, reason);
    return null;
  };
  /** 칸 문단(hit.k)이 빈 글만 든 문단인가(표·그림 같은 개체 없음) */
  const emptyCellPara = (hit) => {
    const r = hit.c.refs[hit.k];
    try { if (doc.text(r, 'final') !== '') return false; } catch { return false; }
    if (tablesOf().some((t) => t.ref === r)) return false;
    try { return !(typeof doc.ownObjects === 'function' && doc.ownObjects(r).length); } catch { return false; }
  };
  /**
   * 칸 문단(hit.k) 자리에 새 표 — 한/글·편집기 엔진이 칸 안에 표를 만드는 규칙(vendor/rhwp create_table_in_cell_by_path_native, 한/글 2020 표본):
   * 캐럿(그 문단 끝)에서 문단을 가른다 — 앞이 비면 그 문단이 표 문단이 되고, 뒤는 비어도 새 문단. 표 문단에는 표만 있다
   */
  const planTable = (hit, index, spec, reason) => {
    const plan = planOf(hit);
    if (plan.whole) return WHOLE_MIX(hit.c);
    let i = plan.list.findIndex((e) => e.keep === hit.k || e.replaced === hit.k);
    if (i < 0) return `표를 넣을 자리(after ${hit.c.refs[hit.k]})의 문단을 같은 호출의 다른 op 가 지우거나 여러 문단으로 바꿉니다`;
    const replace = plan.list[i].keep === hit.k && !plan.list.some((e) => e.after === hit.k) && emptyCellPara(hit);
    while (i + 1 < plan.list.length && plan.list[i + 1].after === hit.k) i++;
    const entries = [{ table: spec, near: hit.k, after: hit.k, ...(replace ? { replaced: hit.k } : {}) }, { text: '', near: hit.k, after: hit.k }];
    if (replace) plan.list.splice(i, 1, ...entries); else plan.list.splice(i + 1, 0, ...entries);
    planTouch(plan, index, reason);
    return null;
  };
  /** 칸 문단들(ks — 칸 안 차례)을 지우기 */
  const planDelete = (hit, index, ks, reason) => {
    const plan = planOf(hit);
    if (plan.whole) return WHOLE_MIX(hit.c);
    for (const k of ks) { const i = plan.list.findIndex((e) => e.keep === k); if (i < 0) return BUSY_PARA(hit.c.refs[k]); plan.list.splice(i, 1); }
    planTouch(plan, index, reason);
    return null;
  };
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
    // 칸 하나({table,row,col,para?})는 문단별 길(아래 formatTargets)과 같은 문단 — para 를 주면 그 칸의 para 번째 문단, 없으면 그 칸의 문단 전체
    // (2026-11-19 — 예전에는 첫 문단만이라 문단이 여럿인 칸은 첫 문단만 서식이 바뀌었다). 못 찾으면 없는 주소를 두어 아래에서 오류가 난다
    const normal = (v) => {
      if (typeof v === 'string' || !('row' in v)) return [v];
      const cell = cellOfAddr(v)?.c; const none = `${v.table}@없는 칸(${v.row},${v.col})`;
      if (!cell) return [none];
      return v.para != null ? [cell.refs[v.para] ?? none] : [...cell.refs];
    };
    let count = 0; const expanded = new Map(); let bad = false;
    for (const x of whole) {
      // 사용 문단은 앞의 스타일 정의·적용 뒤에 정해진다. 준비 단계에서 옛 문서에 고정하지 않는다.
      if (items(x).some(a => a?.style)) { expanded.set(x.index, []); continue; }
      try { const refs = restyleRefs(doc, items(x).flatMap(normal)); expanded.set(x.index, refs); count += refs.length; }
      catch (e) { if (!e?.code) throw e; bad = true; if (items(x).some(ranged)) errors.push(fail(x.index, 'format', e.message)); }
    }
    const want = whole.some((x) => items(x).some(ranged)) || (stylesOps.length > 0 && whole.length > 0) || count > BULK_FORMAT_MIN;
    if (want) for (const x of whole) { if (expanded.has(x.index)) bulk.set(x.index, { at: items(x).flatMap(normal) }); else if (!items(x).some(ranged) && !bad) bulk.set(x.index, { at: items(x).flatMap(normal) }); }
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
  const refOf = (a, index, opName) => {
    if (typeof a === 'string') return a;
    const t = tablesOf().find((x) => x.key === a.table);
    const cell = t?.cells.find((c) => a.row >= c.row && a.row < c.row + c.rowSpan && a.col >= c.col && a.col < c.col + c.colSpan);
    const r = cell?.refs?.[a.para ?? 0];
    if (!r) { errors.push(fail(index, opName, t ? `표 ${a.table} 에 (${a.row}, ${a.col}) 칸${a.para ? `의 ${a.para}번째 문단` : ''}이 없습니다(${t.rows}×${t.cols}, 0부터)` : `표 ${a.table} 을 찾지 못했습니다(read view='tables')`)); return null; }
    return r;
  };
  /**
   * 글(find)이 있는 op(서식·메모·여러 안)의 대상: 칸 주소({table,row,col} — para 없음)이고 그 칸의 문단이 여럿이면 find 가 든 칸 문단(칸 전체에서 occurrence 번째)
   * → { ref, occurrence } | null(오류를 적었다). 그 밖에는 refOf 와 같다
   */
  const refForFind = (a, index, opName, find, occurrence) => {
    const hit = typeof a !== 'string' && a.para == null && find != null && find !== '' ? cellOfAddr(a) : null;
    if (hit && hit.c.refs.length > 1) {
      let texts; try { texts = hit.c.refs.map((x) => doc.text(x, 'final')); } catch (e) { errors.push(fail(index, opName, e.message)); return null; }
      const at = findInCell(hit.c, texts, find, occurrence || 1);
      if (!at) { errors.push(fail(index, opName, `${cellName(hit.c)}의 문단 ${hit.c.refs.length}개 어디에도 「${short(find)}」 이 없습니다 — read(at:{table,row,col}) 로 칸의 문단을 확인하세요`)); return null; }
      return at;
    }
    const r = refOf(a, index, opName);
    return r ? { ref: r, occurrence } : null;
  };
  const bodyOf = (r) => (/^s\d+\/p\d+/.exec(r) || [r])[0];
  const proposals = () => { const last = steps[steps.length - 1]; if (last?.kind === 'proposals') return last.items; const s = { kind: 'proposals', items: [] }; steps.push(s); return s.items; };
  let structure = null;
  // 이 호출에서 문단 글 전체(빈 문단에 넣기 포함)를 바꾸는 replace — 같은 문단에 스타일만 주는 format 이 뒤따르면 그 replace 에 합친다(아래)
  const wholeReplace = new Map();
  // 표·그림·차트를 표 칸 안 문단 뒤에 넣으라는 꼴(2026-11-20 v3 TSV 검증 — docs/MCP_REDESIGN_2026-11-16.md §22): 실제 Codex 가 '칸 안에 표를 만들어'를
  // {op:'table', after:칸 문단} 으로 냈고, 서버는 본문 문단(bodyOf)으로 바꿔 바깥 표 뒤에 조용히 놓았다 — 모델은 '칸에 넣었다'고 보고했다. 칸 안 새 표·그림은 아직 없으므로 오류로 알린다
  // (캡션·글상자 문단처럼 표 칸이 아닌 중첩 문단은 예전처럼 그 본문 문단 뒤)
  const TOPIC = { 표: '표는', 그림: '그림은', 차트: '차트는' };
  const cellAfter = (after, index, opName, what) => {
    const hit = after ? cellOfRef(String(after)) : null;
    if (!hit) return false;
    errors.push(fail(index, opName, `after(${after})는 표 ${hit.t.key} 의 ${cellName(hit.c)} 안 문단입니다 — ${TOPIC[what] || what} 본문 문단 뒤에만 넣을 수 있다(칸 안에 새 ${what} 넣기는 아직 없다; 칸에는 글만 — replace·insert). 그 표 뒤 본문에 두려면 after:'${bodyOf(after)}'`));
    return true;
  };
  // 병합으로 덮인 자리의 칸 주소({table,row,col}): 예전처럼 그 병합 칸으로 받되 영수증에 알린다(같은 검증 — TSV·표 줄에서 덮인 자리는 빈칸과 같아 보여 잘못 센 자리와 구별되지 않는다)
  for (const { index, op } of parsed) {
    for (const a of [op?.at].flat()) {
      if (!a || typeof a !== 'object' || a.table == null || !Number.isInteger(a.row) || !Number.isInteger(a.col)) continue;
      const hit = cellOfAddr(a); if (!hit) continue;
      const { c } = hit;
      if (c.row !== a.row || c.col !== a.col) notes.push({ op: index, note: `ops[${index}]: 칸 (${a.row}, ${a.col})은 병합 칸 r${c.row}c${c.col}:r${c.row + c.rowSpan - 1}c${c.col + c.colSpan - 1} 에 덮인 자리라 그 병합 칸(row ${c.row}, col ${c.col})에 반영한다` });
    }
  }
  for (const { index, name, op } of parsed) {
    if (isStructureOp(name)) {
      if (!structure) { structure = { kind: 'structure', indexes: [], ops: [] }; steps.push(structure); }
      structure.indexes.push(index); structure.ops.push(op);
      continue;
    }
    if (name === 'replace') {
      // 서식을 함께 주는 바꿈(style·format·runs)은 예전 길 그대로(문단 하나의 바꿈 제안 — 칸 안에서는 줄바꿈이 줄 나눔)
      const rich = op.style != null || op.format != null || op.runs != null;
      const multi = /[\r\n]/.test(op.with);
      let r = null; let find = op.find; let occurrence = op.occurrence;
      // (가) 칸 주소({table,row,col} — para 없음) = 그 칸의 문단 전체(2026-11-19 §17). 문단이 하나뿐이고 줄바꿈도 없으면 아래 예전 길(그 문단의 바꿈 제안)
      const cellHit = typeof op.at !== 'string' && op.at.para == null ? cellOfAddr(op.at) : null;
      if (cellHit && (cellHit.c.refs.length > 1 || (multi && !rich))) {
        const { c } = cellHit;
        let texts; try { texts = c.refs.map((x) => doc.text(x, 'final')); } catch (e) { errors.push(fail(index, name, e.message)); continue; }
        const joined = texts.join('\n');
        // 칸 전체가 대상인가: whole:true · find 가 칸 글 전체(문단마다 줄바꿈) · 빈 칸에 넣기(find:'')
        const whole = op.whole === true || (find != null && find !== '' && find === joined) || (find === '' && !joined.trim());
        if (whole && !rich) {
          const bad = planWhole(cellHit, index, linesOf(op.with), op.reason);
          if (bad) errors.push(fail(index, name, bad));
          continue;
        }
        // 문단이 여럿인 칸을 서식과 함께 통째로 바꾸라는 꼴: 첫 문단만 바뀌는 조용한 부분 반영을 막는다
        if (whole && c.refs.length > 1) { errors.push(fail(index, name, `${cellName(c)}에는 문단이 ${c.refs.length}개 있습니다 — 서식(style·format·runs)을 함께 주는 바꿈은 문단 하나에만 씁니다. 칸을 통째로 다시 쓰려면 서식 없이 whole:true(모양은 그 칸의 문단을 따른다), 서식은 format 으로 따로 주세요`)); continue; }
        if (!whole && find != null && find !== '' && c.refs.length > 1) {
          const at = findInCell(c, texts, find, occurrence || 1);
          if (!at) {
            // 실제 hp:lineBreak도 find에서는 \n이다. 문단 안에서 먼저 찾고, 경계를 이어야만 일치할 때 문단별 편집을 안내한다.
            const across = find.includes('\n') && joined.includes(find) && !texts.some((text) => text.includes(find));
            const detail = across
              ? `find 가 ${cellName(c)}의 여러 문단에 걸칩니다(그 칸의 문단 ${c.refs.length}개: ${c.refs[0]} ~ ${c.refs[c.refs.length - 1]}) — 문단을 통째로 지우려면 delete_paragraphs(at: 그 문단 주소들), 칸 전체를 다시 쓰려면 whole:true 와 with 에 줄마다 한 문단`
              : `${cellName(c)}의 문단 ${c.refs.length}개 어디에도 「${short(find)}」 ${occurrence > 1 ? `의 ${occurrence}번째 일치가` : '이'} 없습니다 — read(at:{table,row,col}) 로 칸의 문단을 확인하세요`;
            errors.push(fail(index, name, detail));
            continue;
          }
          r = at.ref; occurrence = at.occurrence;
        }
      }
      if (r == null) { r = refOf(op.at, index, name); if (!r) continue; }
      if (op.whole) { try { find = doc.text(r, 'final'); } catch (e) { errors.push(fail(index, name, e.message)); continue; } }
      if (find == null) { errors.push(fail(index, name, 'find(바꿀 글) 또는 whole:true 가 필요합니다')); continue; }
      // (나) 표 칸 문단 하나의 글 전체를 여러 줄로 바꾸기 = 그 문단을 줄마다 한 문단으로(본문 문단의 여러 문단 바꿈 — server/service.js _paraLines — 과 같은 뜻).
      // 칸 안에서는 문단을 가르는 변경 추적 길이 없어 표 고치기 제안으로 낸다. 글 일부만 바꾸는 줄바꿈은 예전처럼 줄 나눔(영수증 notes 로 알린다)
      if (multi) {
        const inCell = cellOfRef(r);
        if (inCell) {
          let cur = null; try { cur = doc.text(r, 'final'); } catch { cur = null; }
          if (!rich && cur != null && (op.whole || find === cur)) {
            const bad = planSplit(inCell, index, linesOf(op.with), op.reason);
            if (bad) errors.push(fail(index, name, bad));
            continue;
          }
          notes.push({ op: index, note: `ops[${index}] replace: 표 칸 문단(${r})의 ${rich ? '서식을 함께 주는 바꿈' : '글 일부를 바꾸는 바꿈'}이라 with 의 줄바꿈은 줄 나눔(같은 문단)으로 들어갑니다 — 문단으로 나누려면 그 문단 전체를 whole:true 로(서식 없이) 바꾸세요` });
        }
      }
      let rformat = op.format;
      if (op.style != null) { const id = styleId(op.style, index, name); if (id == null) continue; rformat = { ...(rformat || {}), styleId: id }; }
      const item = { index, input: { type: 'replace', ref: r, find, replace: op.with, occurrence, format: rformat, runs: op.runs, reason: op.reason } };
      proposals().push(item);
      if (find === '' || op.whole) wholeReplace.set(r, item);
    } else if (name === 'insert') {
      const list = op.paragraphs?.length ? op.paragraphs : [{ text: op.text ?? '', style: op.style }];
      // 표 칸 문단 뒤에 넣기 = 그 칸 안에(2026-11-19 §17 — 예전에는 표를 품은 본문 문단 뒤, 곧 표 밖으로 갔다). 글만 받는다: 모양은 엔진이 같은 글머리의 가까운 칸 문단에서 고른다
      const inCell = cellOfRef(op.after);
      if (inCell) {
        const lines = []; let styled = op.style != null;
        for (const p of list) {
          lines.push(...linesOf(p.text ?? (Array.isArray(p.runs) ? p.runs.map((x) => x?.text ?? '').join('') : '')));
          if (p.style != null || p.format != null || p.runs != null) styled = true;
        }
        const bad = planInsert(inCell, index, lines, op.reason);
        if (bad) { errors.push(fail(index, name, bad)); continue; }
        if (styled) notes.push({ op: index, note: `ops[${index}] insert: 표 칸 안에 넣는 문단은 글만 받습니다 — style·format·runs 는 쓰지 않았고, 모양은 같은 글머리로 시작하는 가까운 칸 문단(없으면 after 문단)을 따릅니다` });
        continue;
      }
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
      // like(본보기 표)·merges(병합 — 2026-11-20 §20): 본보기가 없으면 오류, 크기가 같은지(칸마다 본뜨고 병합도 따름)·다른지(행 종류별 모양만)를 영수증 notes 로
      if (op.like) {
        const lt = tablesOf().find((x) => x.key === op.like);
        if (!lt) { errors.push(fail(index, name, `like 의 표를 찾지 못했습니다: ${op.like}(read 의 ▦ 표 열쇠 — 예: s0/p3#t0)`)); continue; }
        if (typeof doc._tableModel === 'function' && !doc._tableModel(op.like)?.picked) { errors.push(fail(index, name, `like 표(${op.like})는 본보기로 쓸 수 없습니다(문단이 없는 칸이 있다) — 다른 표를 고르세요`)); continue; }
        const nc = Math.max(...op.rows.map((r) => r.length));
        notes.push({ op: index, note: lt.rows === op.rows.length && lt.cols === nc
          ? `ops[${index}] table: like 표(${op.like})와 크기가 같아 칸마다 그 표의 모양·열 폭${op.merges ? '' : '·병합'}을 따른다`
          : `ops[${index}] table: like 표(${op.like} ${lt.rows}×${lt.cols})와 크기가 달라(새 표 ${op.rows.length}×${nc}) 행 종류별 모양만 따른다${op.merges ? '' : ' — 병합은 merges 로 준다'}` });
      }
      // 표 칸 문단 뒤 = 그 칸 안에 새 표(2026-11-20 §22 — 사용자 요청). 칸 문단 구조 바꾸기(cellPlans → 표 고치기 제안 cell_paragraphs 의 {table})로 낸다
      const inCellT = cellOfRef(op.after);
      // v3(실험 연결)만 칸 안에 만든다 — v2 는 예전처럼 거절(조용히 표 밖에 놓지 않는다)
      if (inCellT && surface !== 'v3' && cellAfter(op.after, index, name, '표')) continue;
      if (inCellT) {
        if (op.caption || op.unit || op.notes) { errors.push(fail(index, name, `칸 안 표에는 caption·unit·notes 를 줄 수 없습니다(${cellName(inCellT.c)} 안 — 필요하면 표 안 행이나 칸 문단으로)`)); continue; }
        const bad = planTable(inCellT, index, { rows: op.rows, headerRows: op.header_rows ?? 1, ...(op.merges?.length ? { merges: op.merges } : {}), ...(op.like ? { like: op.like } : {}) }, op.reason);
        if (bad) { errors.push(fail(index, name, bad)); continue; }
        notes.push({ op: index, note: `ops[${index}] table: 표 ${inCellT.t.key} 의 ${cellName(inCellT.c)} 안에 넣는다 — 칸 안쪽 폭에 맞춘 글자처럼 취급 표(한/글이 칸 안에 만든 표와 같은 꼴: 표만 든 문단과 그 뒤 빈 문단${inCellT.k != null && emptyCellPara(inCellT) ? ', 빈 문단 자리에' : ''}), ${op.like ? '칸 모양은 like 표' : '네 변 실선'}` });
        continue;
      }
      proposals().push({ index, input: { type: 'table', afterRef: bodyOf(op.after), table: { rows: op.rows, headerRows: op.header_rows ?? 1, caption: op.caption || '', ...(op.unit ? { unit: op.unit } : {}), ...(op.notes ? { notes: op.notes } : {}), ...(op.merges?.length ? { merges: op.merges } : {}), ...(op.like ? { like: op.like } : {}) }, reason: op.reason } });
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
      // 대상 문단들: 칸 주소(para 없음)는 그 칸의 문단 전체(2026-11-19 §17 — 예전에는 첫 문단만 바뀌었다). find 가 있으면 그 글이 든 칸 문단, 부분 범위(start·end)는 예전처럼 첫 문단
      const targets = []; let lostTarget = false;
      for (const x of (Array.isArray(op.at) ? op.at : [op.at])) {
        if (typeof x !== 'string' && x.para == null && op.find != null && op.find !== '') { const at = refForFind(x, index, name, op.find, op.occurrence); if (!at) lostTarget = true; else targets.push(at); continue; }
        const hit = typeof x !== 'string' && x.para == null && op.start == null && op.end == null ? cellOfAddr(x) : null;
        if (hit && hit.c.refs.length > 1) { for (const ref of hit.c.refs) targets.push({ ref, occurrence: op.occurrence }); continue; }
        const one = refOf(x, index, name);
        if (!one) lostTarget = true; else targets.push({ ref: one, occurrence: op.occurrence });
      }
      if (lostTarget) continue;
      for (const { ref: r, occurrence } of targets) {
        // 같은 호출에서 그 문단의 글 전체를 바꾸는(빈 문단에 넣는) replace 뒤에 스타일만 주는 서식: 따로 제안하면 글이 들어간 뒤 서식의 범위가 어긋나 반영되지 않는다
        // (FORMAT_PARAGRAPH_RANGE — 2026-11-16 밤 논문 실험 2건 모두). 그 replace 에 스타일을 합쳐 제안 하나로 낸다
        const whole = wholeReplace.get(r);
        if (whole && op.find == null && op.start == null && op.end == null && format.styleId != null && Object.keys(format).length === 1 && whole.input.format?.styleId == null) {
          whole.input.format = { ...(whole.input.format || {}), styleId: format.styleId };
          notes.push({ op: index, note: `ops[${index}] format 의 스타일은 같은 문단(${r})의 글을 넣는 ops[${whole.index}] replace 에 합쳤습니다(따로 제안하지 않음 — 글과 스타일이 한 제안으로 반영됩니다)` });
          continue;
        }
        const range = op.find != null && op.find !== '' ? { find: op.find, occurrence } : op.start != null || op.end != null ? { start: op.start, end: op.end }
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
      // 표 칸 안 문단 지우기(2026-11-19 §17): 한 칸의 문단들(떨어져 있어도 된다) → 그 칸의 문단 구조 바꾸기(cellPlans — 표 고치기 제안)
      const inner = move ? null : nestedSpan(op.at);
      if (inner) {
        if (inner.error) { errors.push(fail(index, name, inner.error)); continue; }
        const hits = inner.refs.map((x) => cellOfRef(x));
        const lost = inner.refs.find((x, i) => !hits[i]);
        if (lost) { errors.push(fail(index, name, `${lost} 은(는) 표 칸 문단이 아닙니다 — 표 칸 안 문단만 이렇게 지울 수 있습니다(글상자·캡션 안 문단은 replace 로 글을 고친다)`)); continue; }
        if (hits.some((h) => h.c !== hits[0].c)) { errors.push(fail(index, name, '여러 칸의 문단이 섞였습니다 — 칸마다 op 를 나누세요')); continue; }
        const bad = planDelete(hits[0], index, [...new Set(hits.map((h) => h.k))].sort((a, b) => a - b), op.reason);
        if (bad) errors.push(fail(index, name, bad));
        continue;
      }
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
      // 칸 주소면 find 가 든 칸 문단(위 refForFind — 2026-11-19 §17)
      const at = refForFind(op.at, index, name, op.find, op.occurrence); if (!at) continue;
      steps.push({ kind: 'alternatives', index, input: { ref: at.ref, find: op.find, occurrence: at.occurrence, options: op.options } });
    } else if (name === 'memo') {
      if (op.reply_to) { steps.push({ kind: 'reply', index, input: { memoId: op.reply_to, text: op.text } }); continue; }
      if (op.at == null) { errors.push(fail(index, name, 'at(문단 주소) 또는 reply_to(메모 id)가 필요합니다')); continue; }
      const at = refForFind(op.at, index, name, op.find, op.occurrence); if (!at) continue;
      steps.push({ kind: 'memo', index, input: { ref: at.ref, find: op.find, occurrence: at.occurrence, text: op.text } });
    } else if (name === 'chart') {
      if (cellAfter(op.after, index, name, '차트')) continue;
      steps.push({ kind: 'chart', index, input: { afterRef: bodyOf(op.after), chart: op.chart, sourceTable: op.source_table, widthMm: op.width_mm, heightMm: op.height_mm, ...(op.caption ? { caption: op.caption } : {}), ...(op.notes ? { notes: op.notes } : {}), reason: op.reason } });
    } else if (name === 'figure') {
      if (!op.after && !op.replace) { errors.push(fail(index, name, 'after(넣을 자리) 또는 replace(바꿀 그림 주소)가 필요합니다')); continue; }
      if (op.replace && op.notes) { errors.push(fail(index, name, '그림 바꾸기(replace)에는 notes 를 줄 수 없습니다(그림 문단의 글은 그대로 둔다)')); continue; }
      if (op.after && cellAfter(op.after, index, name, '그림')) continue;
      steps.push({ kind: 'figure', index, input: { afterRef: op.after ? bodyOf(op.after) : undefined, replaceRef: op.replace, caption: op.caption || '', svg: op.svg, aid: op.attachment_id, widthMm: op.width_mm, ...(op.notes ? { notes: op.notes } : {}), reason: op.reason } });
    } else if (name === 'replace_all') {
      // 일괄 바꾸기(2026-11-17 §10.4 나-6) → 일치마다 바꿈 제안(같은 op 라 한 묶음·영수증 한 줄). 같은 문단 여럿은 occurrence(doc.find 의 셈) — [모두 반영]은 _orderedApplier 가 자리를 지킨다
      const r = findAll(doc, op);
      if (r.error) { errors.push(fail(index, name, r.error)); continue; }
      // all: 같은 호출의 replace 와 겹치는 일치를 접어 넣을 때 쓴다(아래 checkTextRanges — 2026-11-20 §19)
      for (const m of r.matches) proposals().push({ index, all: op, input: { type: 'replace', ref: m.ref, find: m.find, replace: op.with, occurrence: m.occurrence, reason: op.reason } });
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
  // [hwpx-cowork] 칸마다 모은 문단 구조 바꾸기(위 cellPlans — 2026-11-19 §17) → 표마다 표 고치기 제안 하나(칸 40개까지 — 넘으면 나눈다). 다른 제안들 뒤에 둔다:
  // [모두 반영]이 글 제안을 먼저 반영한 뒤 칸의 문단 구조를 바꾼다(어느 쪽이 먼저여도 서버가 칸 문단 주소를 옮겨 준다 — server/service.js _remapCellMoves).
  // 꼴·대상이 틀린 것(표·그림이 든 문단을 지우려 함 등)은 저장 전 검사(사본에서 제안 만들어 보기)가 그 op 번호로 알린다
  if (cellPlans.size && !errors.length) {
    const byTable = new Map();
    for (const plan of cellPlans.values()) { if (!byTable.has(plan.t.key)) byTable.set(plan.t.key, []); byTable.get(plan.t.key).push(plan); }
    const items = [];
    for (const [key, plans] of byTable) {
      for (let i = 0; i < plans.length; i += 40) {
        const chunk = plans.slice(i, i + 40);
        const indexes = [...new Set(chunk.flatMap((p) => p.indexes))].sort((a, b) => a - b);
        const cells = chunk.map((p) => {
          // 칸의 문단을 모두 지웠으면 빈 문단 하나를 남긴다(칸에는 문단이 하나는 있어야 한다)
          const list = p.list.length ? p.list : [{ text: '', near: 0 }];
          return { op: 'cell_paragraphs', row: p.c.row, col: p.c.col, count: p.c.refs.length,
            paragraphs: list.map((e) => (e.keep != null ? { keep: e.keep } : e.table ? { table: e.table, near: e.near } : { text: e.text, ...(e.near != null ? { near: e.near } : {}) })) };
        });
        items.push({ index: indexes[0], input: { type: 'table_edit', tableEdit: { table: key, ops: cells }, reason: chunk.map((p) => p.reason).find(Boolean) } });
        notes.push({ op: indexes[0], note: `ops[${indexes.join(', ')}]: 표 ${key} 의 칸 문단 수를 바꾸는 것(${chunk.map((p) => `${cellName(p.c)} 문단 ${p.c.refs.length} → ${Math.max(1, p.list.length)}개`).join(' · ')})은 표 고치기 제안 하나로 냈습니다(영수증의 op ${indexes[0]}) — 변경 추적 없이 바로 고칩니다` });
      }
    }
    steps.push({ kind: 'proposals', items });
  }
  // textRanges: v3(실험 연결)에서만 — 2026-11-20 §19. v2 기본 연결의 계약은 그대로 둔다
  if (textRanges) checkTextRanges(doc, steps, errors, notes, summaries);
  textBeforeMoves(doc, steps, notes);
  markBundles(steps);
  return { steps, errors, notes, previews, summaries };
}

/**
 * 표 칸 안 문단 지우기의 at(2026-11-19): 중첩 문단 주소 하나 's0/p3/n9' · 범위 's0/p3/n9..n12'('s0/p3/n9..s0/p3/n12') · 목록 → { refs } | { error } | null(본문 문단 꼴 — paragraphSpan 이 본다)
 */
function nestedSpan(at) {
  const ONE = /^(s\d+\/p\d+(?:\/n\d+)*)\/n(\d+)$/;
  if (Array.isArray(at)) {
    const list = at.map((x) => String(x).trim());
    if (!list.some((x) => ONE.test(x))) return null;
    if (!list.every((x) => ONE.test(x))) return { error: '본문 문단과 표 칸 안 문단을 한 op 에 섞을 수 없습니다 — op 를 나누세요' };
    return { refs: [...new Set(list)] };
  }
  const parts = String(at ?? '').trim().split('..').map((x) => x.trim());
  const a = ONE.exec(parts[0]);
  if (!a) return null;
  if (parts.length === 1) return { refs: [parts[0]] };
  const short = /^n(\d+)$/.exec(parts[1] || ''); const b = short ? [null, a[1], short[1]] : ONE.exec(parts[1] || '');
  if (parts.length > 2 || !b || b[1] !== a[1] || Number(b[2]) < Number(a[2])) return { error: `범위가 올바르지 않습니다: ${at} — 표 칸 안 문단은 's0/p3/n9..n12' 꼴(같은 칸 안, 앞에서 뒤로)` };
  if (Number(b[2]) - Number(a[2]) >= 500) return { error: `범위가 너무 넓습니다: ${at}(한 번에 문단 500개까지)` };
  const refs = []; for (let k = Number(a[2]); k <= Number(b[2]); k++) refs.push(`${a[1]}/n${k}`);
  return { refs };
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

/**
 * 같은 호출의 바꿈 제안끼리 글 범위 검사(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §19, 규칙 server/mcp2/apply-check.js).
 * 대기 제안은 문서를 바꾸지 않으므로 한 호출의 바꿈은 모두 읽은 글 기준이고, [모두 반영]은 그것을 차례로 반영하며 앞 제안과 범위가 겹치는 뒤 제안을 STALE 로 실패시킨다.
 * 11-20 실제 Codex 실행: 문단마다 고칠 곳을 긴 replace 하나로 묶고 replace_all('입학년도' → '입학 연도' 등)을 함께 냈는데, 그 일치가 replace 범위 안에 들어
 * 반영에서 실패할 제안이 생겼다. 사본 반영 흉내는 시간 한도로 멈춰 알리지 못했고, 모델이 dry_run 을 거듭하며 손으로 합쳤다(모델 호출 7번).
 *  ① replace_all 의 일치가 같은 호출 replace 가 고치는 범위 안 → 그 replace 의 with 에도 같은 바꿈을 넣고 일치는 따로 제안하지 않는다(notes·영수증 merged)
 *  ② 일치가 replace 범위 경계에 걸침 · replace 끼리 겹침 · replace_all 끼리 겹침 → 오류(아무것도 저장하지 않는다)
 * 찾지 못한 바꿈(범위 없음)은 여기서 보지 않는다 — 저장 전 검사(제안 만들어 보기)가 그 op 를 알린다.
 */
function checkTextRanges(doc, steps, errors, notes, summaries) {
  const reps = [];
  for (const s of steps) {
    if (s.kind !== 'proposals') continue;
    for (const x of s.items) {
      if (x.input?.type !== 'replace' || !x.input.ref) continue;
      const r = replaceRange(doc, x.input);
      if (r) reps.push({ x, s, ref: x.input.ref, start: r.start, end: r.end });
    }
  }
  if (reps.length < 2) return;
  const overlap = (a, b) => a.ref === b.ref && a.start < b.end && b.start < a.end;
  // ① 접어 넣기 — replace 하나에 같은 replace_all op 는 한 번만 적용한다(with 안의 같은 글을 모두 바꾼다)
  const hosts = reps.filter((e) => !e.x.all && e.end > e.start);
  const dropped = new Set(); const applied = new Set(); const merged = new Map();
  for (const m of reps) {
    if (!m.x.all) continue;
    const host = hosts.find((e) => overlap(e, m));
    if (!host) continue;
    if (m.start < host.start || m.end > host.end) continue;   // 경계에 걸침 → ②에서 오류
    if (host.x.input.runs != null) {
      errors.push({ index: m.x.index, error: `ops[${m.x.index}] replace_all: ${m.ref} 의 「${shortText(m.x.input.find)}」 는 같은 호출 ops[${host.x.index}] replace(runs — 글자 서식을 함께 주는 바꿈)가 고치는 글 안에 있습니다 — 그 replace 의 runs 글을 직접 고치고 replace_all 의 at 에서 그 문단을 빼세요` });
      dropped.add(m);
      continue;
    }
    const key = `${reps.indexOf(host)}:${m.x.index}`;
    if (!applied.has(key)) { applied.add(key); host.x.input.replace = foldReplaceAll(host.x.input.replace, m.x.all); }
    dropped.add(m);
    if (!merged.has(m.x.index)) merged.set(m.x.index, { n: 0, into: new Set() });
    const g = merged.get(m.x.index); g.n++; g.into.add(host.x.index);
  }
  if (dropped.size) { const gone = new Set([...dropped].map((d) => d.x)); for (const s of steps) if (s.kind === 'proposals') s.items = s.items.filter((x) => !gone.has(x)); }
  for (const [index, g] of merged) {
    const sum = summaries.find((x) => x.op === index); if (sum) sum.merged = g.n;
    notes.push({ op: index, note: `ops[${index}] replace_all: 일치 ${g.n}곳은 같은 호출 ops[${[...g.into].sort((a, b) => a - b).join(', ')}] replace 가 고치는 글 안이라 그 바꿀 글(with)에 같은 바꿈을 넣었습니다(따로 제안하지 않음 — 따로 내면 [모두 반영]에서 실패한다)` });
  }
  // ② 남은 겹침 — 반영 차례(= 만드는 차례 = items 차례)대로
  const rest = reps.filter((e) => !dropped.has(e));
  for (const { first, later } of rangeConflicts(rest)) {
    const a = first.x; const b = later.x;
    const where = `${later.ref} 의 「${shortText(b.input.find || a.input.find)}」`;
    let error;
    if (a.all && b.all) error = `ops[${a.index}]·ops[${b.index}] replace_all 의 일치가 ${later.ref} 에서 겹칩니다(「${shortText(a.input.find)}」·「${shortText(b.input.find)}」) — [모두 반영]에서 뒤 것이 실패합니다. 한쪽 find 를 바꾸거나 그 문단은 replace 하나로 고치세요`;
    else if (a.all || b.all) { const all = a.all ? a : b; const one = a.all ? b : a; error = `ops[${all.index}] replace_all 의 일치(${later.ref} 「${shortText(all.input.find)}」)가 ops[${one.index}] replace 가 고치는 글의 경계에 걸칩니다 — ops[${one.index}] 의 find 를 그 낱말까지 넓히거나 줄이세요`; }
    else if (a.index === b.index) error = `ops[${a.index}] replace: ${where} 가 같은 op 의 다른 바꿈과 겹칩니다`;
    else error = `ops[${a.index}]·ops[${b.index}] replace 가 ${where} 를 함께 고칩니다 — [모두 반영]에서 뒤 것이 실패합니다. 한 op 로 합치세요(한 문단의 떨어진 여러 곳은 겹치지 않는 replace 여러 개로 낼 수 있다)`;
    errors.push({ index: Math.max(a.index, b.index), error });
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
