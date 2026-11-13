/**
 * [hwpx-cowork] 한/글 2022 블록 계산식·쉬운 계산식의 식 모양 (2026-11-11, h2022 표 영역).
 *
 * 한/글 2022 COM 실측(`artifacts/h2022-table/com/probe_table.py` — TableFormulaSumAuto/AvgAuto/ProAuto,
 * TableFormulaSumHor/Ver…; 결과는 셀 FORMULA 필드 `식??형식;;결과`):
 * - 블록의 마지막 열이 모두 비었으면 그 열에 행마다 `=SUM(A?:B?)`(? = 결과 칸의 행),
 *   마지막 줄이 모두 비었으면 그 줄에 열마다 `=SUM(?1:?2)`(? = 결과 칸의 열), 둘 다면 모서리 칸에
 *   `=SUM(A1:B2)`. (블록 A1:C2·C열 빔 → C1·C2 만, A1:B3·3줄 빔 → A3·B3 만, A1:C3 → 다섯 칸)
 * - 블록이 꽉 찼으면 블록 오른쪽 열·아래 줄에 같은 꼴로 쓰고 모서리 칸도 쓴다(A1:B2 → C1·C2·A3·B3·C3).
 *   오른쪽 칸에 글이 있어도 썼다. 오른쪽 열도 아래 줄도 없으면(표 끝) 아무것도 하지 않았다.
 * - 함수 이름: 합계 SUM, 평균 AVG, 곱 PRODUCT. 결과 형식: 합계·곱 `%g`, 평균 `%.2f`(세 자리 쉼표 없음 —
 *   2022 Windows 기본. 12.30 Mac 은 `%g,` 였다).
 * - 쉬운 계산식: 가로 = `=SUM(LEFT)`, 세로 = `=SUM(ABOVE)` (평균 AVG·곱 PRODUCT 같은 꼴), 캐럿 칸에 쓴다.
 * 병합 칸이 끼면 한/글 동작을 재지 않았으므로 하지 않는다(null).
 */

export type HangulCalcFunction = 'SUM' | 'AVG' | 'PRODUCT';

export interface HangulBlockCalcInput {
  range: { startRow: number; startCol: number; endRow: number; endCol: number };
  /** 블록 칸 상태(range 의 startRow/startCol 기준 행렬). */
  cells: Array<Array<{ empty: boolean; rowSpan?: number; colSpan?: number }>>;
  /** 표 전체 줄·칸 수 — 꽉 찬 블록의 결과를 블록 밖에 쓸 수 있는지 본다. */
  rowCount: number;
  colCount: number;
  functionName: HangulCalcFunction;
}

export interface HangulCalcJob {
  targetRow: number;
  targetCol: number;
  formula: string;
  resultFormat: string;
}

export function hangulResultFormat(fn: HangulCalcFunction): string {
  return fn === 'AVG' ? '%.2f' : '%g';
}

export function columnLetters(zeroBasedColumn: number): string {
  let value = zeroBasedColumn + 1;
  let result = '';
  while (value > 0) {
    const digit = (value - 1) % 26;
    result = String.fromCharCode(65 + digit) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

/** 블록 계산 결과 칸과 식을 정한다. 할 일이 없으면 빈 배열, 재지 않은 모양(병합 칸 등)이면 null. */
export function planHangulBlockCalculation(input: HangulBlockCalcInput): HangulCalcJob[] | null {
  const { range, cells, functionName: fn } = input;
  const rows = range.endRow - range.startRow + 1;
  const cols = range.endCol - range.startCol + 1;
  if (rows <= 0 || cols <= 0 || rows * cols <= 1) return null;
  if (cells.length !== rows || cells.some((r) => r.length !== cols)) return null;
  if (cells.some((r) => r.some((c) => (c.rowSpan ?? 1) !== 1 || (c.colSpan ?? 1) !== 1))) return null;
  const fmt = hangulResultFormat(fn);
  const lastColEmpty = cols >= 2 && cells.every((r) => r[cols - 1].empty);
  const lastRowEmpty = rows >= 2 && cells[rows - 1].every((c) => c.empty);

  let dataEndRow: number;
  let dataEndCol: number;
  let hTarget: number | null; // 가로 결과 열
  let vTarget: number | null; // 세로 결과 줄
  if (lastColEmpty || lastRowEmpty) {
    dataEndCol = lastColEmpty ? range.endCol - 1 : range.endCol;
    dataEndRow = lastRowEmpty ? range.endRow - 1 : range.endRow;
    hTarget = lastColEmpty ? range.endCol : null;
    vTarget = lastRowEmpty ? range.endRow : null;
  } else {
    dataEndCol = range.endCol;
    dataEndRow = range.endRow;
    hTarget = range.endCol + 1 < input.colCount ? range.endCol + 1 : null;
    vTarget = range.endRow + 1 < input.rowCount ? range.endRow + 1 : null;
  }
  const c0 = columnLetters(range.startCol);
  const c1 = columnLetters(dataEndCol);
  const r0 = range.startRow + 1;
  const r1 = dataEndRow + 1;
  const jobs: HangulCalcJob[] = [];
  if (hTarget !== null) {
    for (let r = range.startRow; r <= dataEndRow; r += 1) {
      jobs.push({ targetRow: r, targetCol: hTarget, formula: `=${fn}(${c0}?:${c1}?)`, resultFormat: fmt });
    }
  }
  if (vTarget !== null) {
    for (let c = range.startCol; c <= dataEndCol; c += 1) {
      jobs.push({ targetRow: vTarget, targetCol: c, formula: `=${fn}(?${r0}:?${r1})`, resultFormat: fmt });
    }
  }
  if (hTarget !== null && vTarget !== null) {
    jobs.push({ targetRow: vTarget, targetCol: hTarget, formula: `=${fn}(${c0}${r0}:${c1}${r1})`, resultFormat: fmt });
  }
  return jobs;
}

/** 쉬운 계산식(가로/세로 합계·평균·곱) — 캐럿 칸에 쓸 식. */
export function easyFormula(fn: HangulCalcFunction, direction: 'horizontal' | 'vertical'): { formula: string; resultFormat: string } {
  return { formula: `=${fn}(${direction === 'horizontal' ? 'LEFT' : 'ABOVE'})`, resultFormat: hangulResultFormat(fn) };
}

/**
 * 한/글 셀 안 정렬 9방향(TableCellAlign{Left,Center,Right}{Top,Center,Bottom}) — 문단 정렬 + 셀 세로 정렬.
 * 2022 COM 실측: '왼쪽'은 양쪽 정렬(JUSTIFY)로 바꿨다(LeftTop·LeftCenter 모두, 오른쪽·가운데 문단에서도).
 * 셀 세로 정렬 값: 0 위 · 1 가운데 · 2 아래(엔진 setCellProperties).
 */
export type CellAlign9 =
  | 'left-top' | 'left-center' | 'left-bottom'
  | 'center-top' | 'center-center' | 'center-bottom'
  | 'right-top' | 'right-center' | 'right-bottom';

export function cellAlign9Props(align: CellAlign9): { alignment: 'justify' | 'center' | 'right'; verticalAlign: 0 | 1 | 2 } {
  const [h, v] = align.split('-') as ['left' | 'center' | 'right', 'top' | 'center' | 'bottom'];
  return {
    alignment: h === 'left' ? 'justify' : h,
    verticalAlign: v === 'top' ? 0 : v === 'center' ? 1 : 2,
  };
}

/**
 * [hwpx-cowork] 셀 음영 한 단계 어둡게/밝게(한/글 TableCellShadeInc/Dec). 한/글 2022 COM 실측(2026-11-12 probe2 shade):
 * 배경 없음에서 어둡게 → #F2F2F2, 이어서 #E5E5E5·#D8D8D8·#CCCCCC·#BFBFBF·#B2B2B2·#A5A5A5·#999999·#8C8C8C·#7F7F7F
 * (단계 k = 255×(1−0.05k) 내림, 10단계). 밝게는 거꾸로 가고 #F2F2F2 에서 멈췄다(배경 없음으로 돌아가지 않음).
 * 회색이 아닌 색은 재지 않아 바꾸지 않는다(null). 배경 없음에서 밝게도 null.
 */
export const SHADE_LADDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => Math.floor(255 * (1 - 0.05 * k)));

export function shadeStep(current: string | null, delta: 1 | -1): string | null {
  const hex = (v: number) => `#${v.toString(16).toUpperCase().padStart(2, '0').repeat(3)}`;
  if (!current) return delta > 0 ? hex(SHADE_LADDER[0]) : null;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(current.trim());
  if (!m || m[1].toLowerCase() !== m[2].toLowerCase() || m[2].toLowerCase() !== m[3].toLowerCase()) return null;
  const v = parseInt(m[1], 16);
  if (v === 255) return delta > 0 ? hex(SHADE_LADDER[0]) : null;
  // 사다리에서 가장 가까운 단계
  let k = 0;
  SHADE_LADDER.forEach((level, i) => { if (Math.abs(level - v) < Math.abs(SHADE_LADDER[k] - v)) k = i; });
  const next = Math.min(SHADE_LADDER.length - 1, Math.max(0, k + delta));
  const out = hex(SHADE_LADDER[next]);
  return out.toUpperCase() === current.trim().toUpperCase() ? null : out;
}
