// 표 고치기(propose_table_edit · 서버 AI tableEdits) 입력 — 엔진 engine/table-edit.js 의 ops 와 같은 꼴. null 은 '지정 안 함'.
// 한 객체에 op 와 그 op 가 쓰는 칸만 준다(엄격 구조화 출력이 쓰기 쉽게 평평한 객체 하나). 칸 번호(row·col)는 0부터 — get_request 의 tables[].cells 와 같다.
import { z } from 'zod';
import { TABLE_OPS, LINE_TYPES, BORDER_SIDES } from '../engine/table-edit.js';

const n0 = z.number().int().min(0);
const opt = (s) => s.nullish();
export const TableRangeSchema = z.object({
  row_from: opt(n0), row_to: opt(n0), col_from: opt(n0), col_to: opt(n0),
}).strict().describe('칸 범위(포함, 0부터). 생략한 쪽은 표 끝까지 — 범위 전체를 생략하면 표 전체');
export const TableOpSchema = z.object({
  op: z.enum(TABLE_OPS).describe('delete_rows 줄 지우기 · delete_cols 칸 지우기 · insert_rows 줄 넣기 · insert_cols 칸 넣기 · merge 셀 합치기 · unmerge 합친 셀 나누기 · border 테두리 · fill 배경색 · col_widths 칸 너비 · row_height 줄 높이 · cell_align 셀 세로 정렬 · table 표 속성'),
  rows: opt(z.array(n0).max(200)).describe('delete_rows: 지울 줄 번호들 / row_height: 높이를 바꿀 줄(생략하면 모두)'),
  cols: opt(z.array(n0).max(60)).describe('delete_cols: 지울 칸 번호들'),
  row: opt(n0).describe('insert_rows: 기준 줄 / unmerge: 나눌 셀의 줄'),
  col: opt(n0).describe('insert_cols: 기준 칸 / unmerge: 나눌 셀의 칸'),
  count: opt(z.number().int().min(1).max(50)).describe('insert_*: 넣을 개수(기본 1)'),
  position: opt(z.enum(['above', 'below', 'left', 'right'])).describe('insert_rows: below(기본)·above / insert_cols: right(기본)·left'),
  keep_width: opt(z.boolean()).describe('delete_cols·insert_cols: 표 전체 폭 유지(기본 true — 남은 칸 너비를 비율대로 늘리거나 줄임)'),
  values: opt(z.array(z.array(z.string().max(500)).max(60)).max(50)).describe('insert_rows·insert_cols: 넣는 줄(칸)의 칸 글 — values[j][k] = j 번째 새 줄의 k 번째 칸(새 칸이면 k 번째 줄), 번호는 이 op 를 적용한 뒤의 표 칸 번호(0부터). 합계 줄처럼 새 줄과 그 글을 한 번에 넣는다(새 줄의 칸은 같은 요청의 propose_changes 로 채울 수 없다)'),
  range: opt(TableRangeSchema).describe('merge·border·fill·cell_align 의 칸 범위'),
  sides: opt(z.array(z.enum(BORDER_SIDES)).max(9)).describe('border: top·bottom·left·right = 범위 바깥 위·아래·왼쪽·오른쪽 선, inner_h 안쪽 가로선, inner_v 안쪽 세로선, outer = 바깥 넷, inner = 안쪽 모두, all = 모두(기본)'),
  line: opt(z.object({
    type: opt(z.enum(LINE_TYPES)).describe('선 종류(NONE = 선 없앰, SOLID 실선, DOUBLE_SLIM 이중선 …). 생략하면 지금 종류(선이 없던 곳은 실선)'),
    width_mm: opt(z.number().min(0.1).max(5)).describe('선 굵기 mm(한/글 목록 0.1·0.12·0.15·0.2·0.25·0.3·0.4·0.5·0.6·0.7·1.0 … 가운데 가까운 값). 생략하면 지금 굵기'),
    color: opt(z.string().regex(/^#[0-9a-fA-F]{6}$/)).describe('선 색 #RRGGBB. 생략하면 지금 색'),
  }).strict()).describe('border: 바꿀 선 모양(준 것만 바뀐다)'),
  color: opt(z.string().regex(/^(#[0-9a-fA-F]{6}|none)$/)).describe('fill: 배경색 #RRGGBB, none = 배경 없앰'),
  widths: opt(z.array(z.number().positive()).max(60)).describe('col_widths: 칸마다 너비 비율(칸 수만큼, 예: [1,2,4])'),
  total_mm: opt(z.number().min(10).max(600)).describe('col_widths: 표 전체 폭 mm(생략하면 지금 폭)'),
  height_mm: opt(z.number().min(1).max(300)).describe('row_height: 줄 높이 mm(최소 높이 — 글이 많으면 한/글이 늘린다)'),
  vert_align: opt(z.enum(['TOP', 'CENTER', 'BOTTOM'])).describe('cell_align: 셀 안 세로 정렬'),
  header_rows: opt(z.number().int().min(0).max(20)).describe('table: 제목 줄(머리행) 수 — 그 줄 셀을 제목 셀로'),
  repeat_header: opt(z.boolean()).describe('table: 쪽이 넘어가면 제목 줄 반복'),
  width_mm: opt(z.number().min(10).max(600)).describe('table: 표 전체 폭 mm(칸 너비는 비율대로)'),
  align: opt(z.enum(['LEFT', 'CENTER', 'RIGHT'])).describe('table: 표 가로 위치(본문 기준). 글자처럼 표는 표를 품은 문단 정렬도 함께 변경'),
  treat_as_char: opt(z.boolean()).describe('table: 글자처럼 취급'),
  page_break: opt(z.enum(['CELL', 'TABLE', 'NONE'])).describe('table: 쪽 경계에서 CELL 셀 단위로 나눔 · TABLE 나눔 · NONE 나누지 않음'),
}).strict();

/** null·빈 값을 뺀 ops(엔진에 넘길 꼴) */
export function normalizeTableOps(ops) {
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) { if (x == null) continue; const c = clean(x); if (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue; out[k] = c; }
      return out;
    }
    return v;
  };
  return z.array(TableOpSchema).min(1).max(40).parse(ops).map(clean);
}
