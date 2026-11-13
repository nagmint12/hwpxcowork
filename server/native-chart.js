// [hwpx-cowork] 자연어 AI → 구조화된 자료 → rhwp 차트 API → 편집 가능한 HWPX 차트.
// 한/글 저장 꼴은 엔진 insertChart/setChartFormatByIndex 가 맡는다. Python·그림 변환은 사용하지 않는다.
import { z } from 'zod';
import { EngineError, HwpxDoc } from '../engine/doc.js';
import { containerFromBytesSync } from '../engine/toc.js';
import { sectionTextWidth } from '../engine/table.js';
import { editorEngine } from './toc-engine.js';

const xmlString = z.string().max(300).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]*$/u, 'XML에 넣을 수 없는 문자가 있습니다');
export const NativeChartSchema = z.object({
  type: z.enum(['bar', 'hbar', 'line', 'pie', 'doughnut', 'area', 'stacked_bar', 'stacked_hbar', 'percent_stacked_bar', 'percent_stacked_hbar'])
    .describe('bar 세로 묶음 막대 · hbar 가로 묶음 막대 · line 꺾은선 · pie 원형 · doughnut 도넛 · area 영역 · stacked_bar/stacked_hbar 누적 · percent_stacked_bar/percent_stacked_hbar 100% 누적'),
  categories: z.array(xmlString.min(1)).min(1).max(4000),
  series: z.array(z.object({ name: xmlString.min(1), values: z.array(z.number().finite().nullable()).min(1).max(4000) }).strict()).min(1).max(255),
  title: xmlString.optional(),
  legend: z.enum(['none', 'right', 'top', 'left', 'bottom']).optional(),
  data_labels: z.boolean().optional(),
  x_title: xmlString.optional(), y_title: xmlString.optional(),
}).strict();

// row·col 은 read_document tables[].cells 와 같은 0 기반. 합계 행·주석·단위를 추측하지 않는다.
export const ChartTableSourceSchema = z.object({
  table: z.string().min(1),
  header_row: z.number().int().min(0), category_col: z.number().int().min(0),
  value_cols: z.array(z.number().int().min(0)).min(1).max(255),
  data_rows: z.array(z.number().int().min(0)).min(1).max(4000),
}).strict();

const bad = message => { throw new EngineError('BAD_CHART', message); };
export function normalizeNativeChart(input) {
  const parsed = NativeChartSchema.safeParse(input);
  if (!parsed.success) bad(`차트 명세를 확인하세요: ${parsed.error.issues.map(x => `${x.path.join('.')} ${x.message}`).join('; ')}`);
  const c = parsed.data;
  if (c.series.some(s => s.values.length !== c.categories.length)) bad('계열의 값 수와 항목 수가 다릅니다');
  if (!c.series.some(s => s.values.some(v => v !== null))) bad('차트에 숫자 값이 없습니다');
  // 현 엔진의 차트 데이터 편집기는 희소 캐시를 읽지 못한다(ChartScanError::NonSequentialPointIndex).
  // 작성만 성공하고 다시 편집하지 못하는 차트를 내보내지 않으며, 결측을 0으로 바꾸지도 않는다.
  if (c.series.some(s => s.values.some(v => v === null))) bad('현재 엔진의 차트 데이터 편집은 빈칸·결측값을 지원하지 않습니다. 빈칸을 0으로 바꾸지 않았습니다. 사용할 자료 행·열을 다시 선택하세요');
  if (['pie', 'doughnut'].includes(c.type)) {
    if (c.series.length !== 1) bad('원형·도넛 차트는 계열을 하나만 선택하세요');
    if (c.series[0].values.some(v => v !== null && v < 0) || !c.series[0].values.some(v => v > 0)) bad('원형·도넛 차트는 음수 없이 양수 값이 있어야 합니다');
    if (c.x_title || c.y_title) bad('원형·도넛 차트에는 축 제목이 없습니다');
  }
  return c;
}

// 쉼표 묶음·부호·소수·지수·%만 허용. %, 빈칸은 각각 표시값(25%=25)·결측으로 보존한다.
function cellNumber(value) {
  const s = String(value).trim().replace(/\u2212/g, '-');
  if (!s) return null;
  if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?$/.test(s)) bad(`표 값 「${s.slice(0, 60)}」을 숫자로 해석할 수 없습니다. 단위·주석을 확인하세요`);
  const n = Number(s.replace(/,/g, '').replace(/%$/, ''));
  if (!Number.isFinite(n)) bad('표 값이 유한한 숫자가 아닙니다');
  return n;
}

export function chartDataFromTable(doc, source) {
  const parsed = ChartTableSourceSchema.safeParse(source);
  if (!parsed.success) bad('표 데이터 범위(source_table)의 표·머리행·항목 열·값 열·자료 행을 확인하세요');
  const s = parsed.data;
  const table = doc.tables().find(t => t.key === s.table);
  if (!table) throw new EngineError('NO_TABLE', `표 열쇠를 찾지 못했습니다: ${s.table}`);
  const cells = new Map(table.cells.map(c => [`${c.row}/${c.col}`, c]));
  if (new Set(s.value_cols).size !== s.value_cols.length || new Set(s.data_rows).size !== s.data_rows.length) bad('같은 행·열을 중복 선택할 수 없습니다');
  if (s.value_cols.includes(s.category_col) || s.data_rows.includes(s.header_row)) bad('항목 열과 값 열, 머리행과 자료 행을 구분하세요');
  function cell(row, col) {
    if (row >= table.rows || col >= table.cols) bad(`표 범위를 벗어났습니다: 행 ${row}, 열 ${col}`);
    const c = cells.get(`${row}/${col}`);
    if (!c || c.rowSpan !== 1 || c.colSpan !== 1) bad(`합친 칸·누락된 칸은 차트 범위로 선택할 수 없습니다: 행 ${row}, 열 ${col}`);
    return c.text.trim();
  }
  const categories = s.data_rows.map(r => cell(r, s.category_col));
  const series = s.value_cols.map(col => ({ name: cell(s.header_row, col), values: s.data_rows.map(r => cellNumber(cell(r, col))) }));
  return { categories, series };
}

export function chartDimensions(doc, afterRef, widthMm, heightMm) {
  const m = /^s(\d+)\/p\d+$/.exec(afterRef || '');
  if (!m) bad('차트를 넣을 본문 문단 주소(after_ref)가 필요합니다');
  const sec = doc.sections[Number(m[1])];
  if (!sec) bad('차트를 넣을 구역이 없습니다');
  for (const v of [widthMm, heightMm]) if (v != null && (!Number.isFinite(v) || v < 10 || v > 300)) bad('차트 크기는 10~300mm입니다');
  const available = sectionTextWidth(sec);
  const width = widthMm == null ? Math.min(42520, available) : Math.round(widthMm * 7200 / 25.4);
  const height = heightMm == null ? Math.round(width * 0.6) : Math.round(heightMm * 7200 / 25.4);
  if (width > available) bad('차트 폭이 본문/단 너비보다 큽니다. width_mm을 줄이세요');
  return { width, height };
}

/** 독립된 빈 문서에서 차트만 만든다. 원본 전체를 엔진 export 로 다시 쓰지 않는다. */
export function nativeChartDocument(spec, { width, height }) {
  const c = normalizeNativeChart(spec);
  const mod = editorEngine();
  if (typeof mod.HwpDocument.createEmpty !== 'function') throw new EngineError('NOT_READY', '편집기 엔진에 차트 생성 기반이 없습니다 — npm run build:engine');
  const d = mod.HwpDocument.createEmpty();
  const parse = (value, what) => {
    let result;
    try { result = JSON.parse(value); } catch { bad(`차트 엔진 응답을 읽지 못했습니다: ${what}`); }
    if (!result.ok) bad(`차트 엔진이 ${what}을 처리하지 못했습니다: ${JSON.stringify(result.invalid || result)}`);
    return result;
  };
  try {
    for (const name of ['insertParagraph', 'insertChart', 'getChartFormatByIndex', 'setChartFormatByIndex']) {
      if (typeof d[name] !== 'function') throw new EngineError('NOT_READY', `편집기 엔진에 ${name}이 없습니다 — npm run build:engine`);
    }
    // 첫 문단의 구역 정의(secPr)를 옮기지 않도록 두 번째 문단에 만든다.
    parse(d.insertParagraph(0, 0), '빈 문단 만들기');
    const base = ['hbar', 'stacked_hbar', 'percent_stacked_hbar'].includes(c.type) ? 'barH' : ['line', 'pie'].includes(c.type) ? c.type : 'bar';
    const result = parse(d.insertChart(0, 1, 0, JSON.stringify({ width, height, kind: base, categories: c.categories,
      series: c.series.map(s => ({ name: s.name, values: s.values.map(v => v === null ? '' : String(v)) })) })), '차트 만들기');
    const ops = { ...(c.title !== undefined ? { title: { mode: c.title ? 'top' : 'none', text: c.title } } : {}),
      ...(c.legend ? { legend: c.legend } : {}), ...(c.data_labels !== undefined ? { dataLabels: c.data_labels } : {}),
      ...(c.x_title !== undefined ? { horizontalAxis: { title: !!c.x_title, titleText: c.x_title } } : {}),
      ...(c.y_title !== undefined ? { verticalAxis: { title: !!c.y_title, titleText: c.y_title } } : {}) };
    // 갤러리 좌표는 한/글 2022 실측 기반 엔진의 kinds 목록에서 이름으로 찾는다(검증 시 계약을 함께 확인).
    const names = { doughnut: '도넛형', area: '영역형', stacked_bar: '누적 세로 막대형', stacked_hbar: '누적 가로 막대형',
      percent_stacked_bar: '100% 기준 누적 세로 막대형', percent_stacked_hbar: '100% 기준 누적 가로 막대형' };
    if (names[c.type]) {
      const state = parse(d.getChartFormatByIndex(result.chartIndex), '차트 종류 읽기');
      const kind = state.kinds.find(k => k.name.replace(/\s/g, '') === names[c.type].replace(/\s/g, ''));
      if (!kind) bad(`현재 엔진이 차트 종류 ${c.type}을 지원하지 않습니다`);
      ops.kind = { group: kind.group, index: kind.index };
    }
    if (Object.keys(ops).length) parse(d.setChartFormatByIndex(result.chartIndex, JSON.stringify(ops)), '차트 서식');
    return new HwpxDoc(containerFromBytesSync(Buffer.from(d.exportHwpx())));
  } finally { d.free(); }
}
