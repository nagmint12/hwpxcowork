/**
 * [hwpx-cowork] 한/글 2022 차트 디자인 — 차트 종류 변경·차트 구성 추가·줄/칸 전환의 순수 로직(DOM·엔진 없음, 2026-11-11 차트 영역).
 *
 * 엔진 계약: `getChartFormatByIndex(index)` → {@link ChartFormatState}, `setChartFormatByIndex(index, ops)` ← {@link ChartFormatOps}
 * (vendor/rhwp/crates/rhwp-ooxml-chart/src/format.rs — 저장 꼴은 한/글 COM 실측). 이 모듈은 대화상자 값 ↔ 엔진 JSON 변환만 한다.
 * 근거·남은 차이: research/hangul2022-features-20261111/impl/ledger_chart.md.
 */
import type { ChartDataResult, ChartEditsInput } from './chart-data-target';

export type TitleMode = 'none' | 'top' | 'overlay';
export type LegendPos = 'none' | 'right' | 'top' | 'left' | 'bottom' | 'topRight';

export interface AxisState {
  kind: string;
  visible: boolean;
  majorGrid: boolean;
  minorGrid: boolean;
  title: boolean;
  titleText: string | null;
}

export interface ChartKind {
  group: number;
  index: number;
  name: string;
}

/** 엔진이 돌려주는 차트 구성 상태. */
export interface ChartFormatState {
  ok: boolean;
  chart?: number;
  group: number | null;
  index: number | null;
  plots: string[];
  title: TitleMode;
  titleText: string | null;
  legend: LegendPos;
  dataLabels: boolean;
  hasAxes: boolean;
  horizontalAxis: AxisState | null;
  verticalAxis: AxisState | null;
  series: (string | null)[];
  kinds: ChartKind[];
  invalid?: { reason: string; message: string }[];
}

export interface AxisOps {
  visible?: boolean;
  majorGrid?: boolean;
  minorGrid?: boolean;
  title?: boolean;
  titleText?: string;
}

/** 엔진에 보내는 편집(바뀐 것만). */
export interface ChartFormatOps {
  kind?: { group: number; index: number };
  /** 한/글 '차트 계열색 바꾸기' — hncChartStyle colorIndex(0~3 색상 조합, 10~22 단색 조합) */
  colors?: number;
  /** 한/글 '차트 레이아웃' 0~10 */
  layout?: number;
  title?: { mode: TitleMode; text?: string };
  legend?: Exclude<LegendPos, 'topRight'>;
  dataLabels?: boolean;
  horizontalAxis?: AxisOps;
  verticalAxis?: AxisOps;
}

/** 대화상자 입력값. */
export interface ChartFormatForm {
  group: number | null;
  index: number | null;
  /** null = 그대로 */
  colors: number | null;
  /** null = 그대로 */
  layout: number | null;
  title: TitleMode;
  titleText: string;
  legend: Exclude<LegendPos, 'topRight'>;
  dataLabels: boolean;
  horizontalAxis: { visible: boolean; majorGrid: boolean; title: boolean; titleText: string } | null;
  verticalAxis: { visible: boolean; majorGrid: boolean; title: boolean; titleText: string } | null;
}

/** 한/글 갤러리 묶음 이름(ChartGroup 차례 — `IDS_HorizBarChart`…, data/strings_common_ko.json). */
export const CHART_GROUP_NAMES: Record<number, string> = {
  0: '가로 막대형',
  1: '세로 막대형',
  2: '꺾은선/영역형',
  3: '원형',
  4: '분산형',
  5: '기타',
};

/** 범례 위치 이름(한/글 '범례' 단추 차례: 없음·오른쪽·위쪽·왼쪽·아래쪽). */
export const LEGEND_CHOICES: { value: Exclude<LegendPos, 'topRight'>; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'right', label: '오른쪽' },
  { value: 'top', label: '위쪽' },
  { value: 'left', label: '왼쪽' },
  { value: 'bottom', label: '아래쪽' },
];

/** '차트 계열색 바꾸기' 목록(한/글 실측 colorIndex — 색상 조합 0~3, 단색 조합 10~22). */
export const COLOR_CHOICES: { value: number; label: string }[] = [
  ...[0, 1, 2, 3].map((c) => ({ value: c, label: `색상 조합 ${c + 1}` })),
  ...Array.from({ length: 13 }, (_, i) => ({ value: 10 + i, label: `단색 조합 ${i + 1}` })),
];

/** '차트 레이아웃' 목록(한/글 ChartLayoutList 0~10). */
export const LAYOUT_CHOICES: { value: number; label: string }[] = Array.from({ length: 11 }, (_, i) => ({ value: i, label: `레이아웃 ${i + 1}` }));

export const TITLE_CHOICES: { value: TitleMode; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'top', label: '위쪽' },
  { value: 'overlay', label: '가운데 겹치기' },
];

export function formFromState(s: ChartFormatState): ChartFormatForm {
  const axis = (a: AxisState | null) =>
    a && s.hasAxes ? { visible: a.visible, majorGrid: a.majorGrid, title: a.title, titleText: a.titleText ?? '' } : null;
  return {
    group: s.group,
    index: s.index,
    colors: null,
    layout: null,
    title: s.title,
    titleText: s.titleText ?? '',
    legend: s.legend === 'topRight' ? 'right' : s.legend,
    dataLabels: s.dataLabels,
    horizontalAxis: axis(s.horizontalAxis),
    verticalAxis: axis(s.verticalAxis),
  };
}

/** 종류를 바꾸면 원형은 축이 없어진다 — 축 칸을 쓸 수 있는가. */
export function kindHasAxes(group: number | null): boolean {
  return group !== 3;
}

/**
 * 대화상자 값 → 엔진 편집. 처음 상태와 같은 칸은 싣지 않는다(무변경이면 빈 객체).
 * 종류가 바뀌어 원형이 되면 축 편집은 싣지 않는다(축이 사라진다).
 */
export function buildFormatOps(before: ChartFormatState, form: ChartFormatForm): ChartFormatOps {
  const ops: ChartFormatOps = {};
  const prev = formFromState(before);
  const kindChanged = form.group !== null && form.index !== null && (form.group !== prev.group || form.index !== prev.index);
  if (kindChanged) ops.kind = { group: form.group as number, index: form.index as number };
  if (form.colors !== null) ops.colors = form.colors;
  if (form.layout !== null) ops.layout = form.layout;
  const textChanged = form.titleText !== prev.titleText;
  if (form.title !== prev.title || (form.title !== 'none' && textChanged)) {
    ops.title = { mode: form.title };
    if (form.title !== 'none' && (textChanged || form.title !== prev.title)) ops.title.text = form.titleText;
  }
  if (form.legend !== prev.legend) ops.legend = form.legend;
  if (form.dataLabels !== prev.dataLabels) ops.dataLabels = form.dataLabels;
  const axesAfter = kindChanged ? kindHasAxes(form.group) : before.hasAxes;
  if (axesAfter) {
    for (const key of ['horizontalAxis', 'verticalAxis'] as const) {
      const a = form[key];
      const p = prev[key];
      if (!a) continue;
      const o: AxisOps = {};
      // 원형에서 축 있는 종류로 바꾸면 축은 새로 생기므로(처음 상태 없음) 사용자가 고른 값을 모두 싣는다
      if (!p || a.visible !== p.visible) o.visible = a.visible;
      if (!p || a.majorGrid !== p.majorGrid) o.majorGrid = a.majorGrid;
      if (!p || a.title !== p.title) o.title = a.title;
      if (a.title && (!p || a.titleText !== p.titleText || a.title !== p.title)) o.titleText = a.titleText;
      if (Object.keys(o).length) ops[key] = o;
    }
  }
  return ops;
}

export function hasFormatOps(ops: ChartFormatOps): boolean {
  return Object.keys(ops).length > 0;
}

/**
 * 줄/칸 전환(한/글 ChangeChartRowCol — "X축의 데이터를 Y축으로 옮기고 Y축의 데이터를 X축으로") — 차트 데이터 행렬을 뒤집은
 * 구조 편집(`setChartDataByIndex` structure). 항목 이름 ↔ 계열 이름, 값은 전치. 빈 칸이 있거나 이름이 없으면 null(사유).
 */
export function transposeEdits(data: ChartDataResult): { edits: ChartEditsInput } | { error: string } {
  const series = data.series ?? [];
  const labels = data.labels ?? [];
  if (!data.ok || series.length === 0) return { error: '차트 데이터를 읽지 못했습니다.' };
  if (data.axis === 'scatter') return { error: '분산형 차트는 줄/칸을 바꿀 수 없습니다.' };
  if (data.labelsShared === false || data.labelsMultiLevel) return { error: '계열마다 항목이 달라 줄/칸을 바꿀 수 없습니다.' };
  const rows = Math.max(labels.length, ...series.map((s) => s.values.length));
  if (labels.length !== rows) return { error: '항목 이름이 모자라 줄/칸을 바꿀 수 없습니다.' };
  if (series.some((s) => s.values.length !== rows || s.values.some((v) => v === '' || v == null))) {
    return { error: '빈 값이 있어 줄/칸을 바꿀 수 없습니다(값을 먼저 채우세요).' };
  }
  const names = series.map((s, i) => (s.name ?? '').trim() || `계열 ${i + 1}`);
  return {
    edits: {
      structure: true,
      labels: names,
      series: labels.map((label, r) => ({ name: label, values: series.map((s) => s.values[r]) })),
    },
  };
}
