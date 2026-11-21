import type { CommandDef, CommandServices, EditorContext } from '../types';
import { TableCellPropsDialog } from '@/ui/table-cell-props-dialog';
import { TableCreateDialog } from '@/ui/table-create-dialog';
import type { TableCreateOptions } from '@/ui/table-create-dialog';
import { CellSplitDialog } from '@/ui/cell-split-dialog';
import { CellBorderBgDialog } from '@/ui/cell-border-bg-dialog';
import { FormulaDialog } from '@/ui/formula-dialog';
import {
  planBlockCalculation,
  preflightBlockCalculationJobs,
  type BlockCalculationCellState,
  type BlockCalculationFunction,
  type BlockCalculationJob,
} from '@/command/block-calculation-plan';
import {
  TableDeleteRowColumnDialog,
  TableInsertRowColumnDialog,
  type TableDeleteRowColumnMode,
  type TableInsertRowColumnMode,
} from '@/ui/table-row-column-dialog';
import { t } from '../../i18n/index.ts';
import {
  planHangulBlockCalculation,
  easyFormula,
  cellAlign9Props,
  shadeStep,
  type CellAlign9,
  type HangulCalcFunction,
} from '@/command/h2022-block-calc';
import { cellsToLines, linesToCells, type TableTextOptions } from '@/command/h2022-table-text';
import { planAutofill } from '@/command/h2022-autofill';
import { TableTextDialog } from '@/ui/h2022-table-text-dialog';
import { TableSwapDialog } from '@/ui/h2022-table-swap-dialog';
import { clampedCellAfterDelete } from '@/engine/table-cell-clamp';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { CellPathEntry, DocumentPosition } from '@/core/types';
const inTable = (ctx: EditorContext) => ctx.inTable;
const inTableOrCellSelection = (ctx: EditorContext) => ctx.inTable || ctx.inCellSelectionMode;
const hasMultiCellSelection = (ctx: EditorContext) => ctx.hasMultiCellSelection;
// HWP/HWPX cannot persist independent per-row or per-column geometry. Keep
// commands that require that representation unavailable at command routing.
const localTableGeometryCanPersist = () => false;

type CellRange = { startRow: number; startCol: number; endRow: number; endCol: number };
type TableDimensions = { rowCount: number; colCount: number; cellCount: number };
type TableCellCommandContext = {
  ih: NonNullable<ReturnType<CommandServices['getInputHandler']>>;
  pos: ReturnType<NonNullable<ReturnType<CommandServices['getInputHandler']>>['getCursorPosition']>;
  cellInfo: ReturnType<CommandServices['wasm']['getCellInfo']>;
};

function safeTableOp(fn: () => void, label: string): void {
  try { fn(); } catch (e) { console.error(`[table] ${label} 실패:`, e); }
}

function isTopLevelTableCellEmpty(
  wasm: CommandServices['wasm'],
  sec: number,
  ppi: number,
  ci: number,
  cellIdx: number,
): boolean {
  const paragraphCount = wasm.getCellParagraphCount(sec, ppi, ci, cellIdx);
  for (let cellParaIdx = 0; cellParaIdx < paragraphCount; cellParaIdx += 1) {
    if (wasm.getCellParagraphLength(sec, ppi, ci, cellIdx, cellParaIdx) > 0) return false;
  }
  return true;
}

function selectedBlockCalculationCells(
  wasm: CommandServices['wasm'],
  sec: number,
  ppi: number,
  ci: number,
  range: CellRange,
  dims: TableDimensions,
): BlockCalculationCellState[][] | null {
  if (range.startRow < 0 || range.startCol < 0 ||
      range.endRow >= dims.rowCount || range.endCol >= dims.colCount) return null;

  const byCoordinate = new Map<string, {
    cellIdx: number;
    rowSpan: number;
    colSpan: number;
  }>();
  for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx += 1) {
    const info = wasm.getCellInfo(sec, ppi, ci, cellIdx);
    if (!isCellInRange(info, range)) continue;
    const key = `${info.row}:${info.col}`;
    if (byCoordinate.has(key)) return null;
    byCoordinate.set(key, {
      cellIdx,
      rowSpan: info.rowSpan,
      colSpan: info.colSpan,
    });
  }

  const cells: BlockCalculationCellState[][] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const cellRow: BlockCalculationCellState[] = [];
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const cell = byCoordinate.get(`${row}:${col}`);
      // 병합 셀이 덮은 비-anchor 좌표도 여기서 빠지므로 fail-closed한다.
      if (!cell) return null;
      cellRow.push({
        empty: isTopLevelTableCellEmpty(wasm, sec, ppi, ci, cell.cellIdx),
        rowSpan: cell.rowSpan,
        colSpan: cell.colSpan,
      });
    }
    cells.push(cellRow);
  }
  return cells;
}

function hasNonRectangularCellSelection(ih: ReturnType<CommandServices['getInputHandler']>): boolean {
  return Boolean(ih?.isInCellSelectionMode?.() && ih.hasExcludedCellSelection?.());
}

function isTransposeTargetOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('표 크기') && message.includes('초과');
}

function isCellInRange(cell: { row: number; col: number }, range: CellRange): boolean {
  return cell.row >= range.startRow && cell.row <= range.endRow &&
    cell.col >= range.startCol && cell.col <= range.endCol;
}

function stub(id: string, label: string, icon?: string, shortcut?: string): CommandDef {
  return {
    id,
    label,
    icon,
    shortcutLabel: shortcut,
    canExecute: inTable,
    execute() { /* TODO: 후속 타스크에서 구현 */ },
  };
}

function blockCalcCommand(
  id: string,
  label: string,
  func: BlockCalculationFunction,
  shortcut: string,
): CommandDef {
  return {
    id,
    label,
    shortcutLabel: shortcut,
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      try {
        const tableContext = ih.getCellTableContext();
        const range = ih.getSelectedCellRange();
        if (!tableContext || !range || !ih.isInCellSelectionMode()) return;
        const nested = (tableContext.cellPath?.length ?? 0) > 1;
        if (nested || ih.hasExcludedCellSelection()) return;

        const { sec, ppi, ci } = tableContext;
        const dims = services.wasm.getTableDimensions(sec, ppi, ci);
        const cells = selectedBlockCalculationCells(services.wasm, sec, ppi, ci, range, dims);
        if (!cells) return;
        const plan = planBlockCalculation({
          range,
          cells,
          functionName: func,
          hasExcludedCells: false,
          nested: false,
        });
        if (!plan) return;

        const evaluate = (
          wasm: CommandServices['wasm'],
          job: BlockCalculationJob,
          writeResult: boolean,
        ): { ok: boolean } => JSON.parse(wasm.evaluateTableFormula(
          sec, ppi, ci, job.targetRow, job.targetCol, job.formula, writeResult,
        ));
        const preflightOk = preflightBlockCalculationJobs(
          plan.jobs,
          (job, writeResult) => evaluate(services.wasm, job, writeResult),
        );
        if (!preflightOk) return;

        // 모든 결과를 먼저 dry-run한 뒤 하나의 snapshot에서 기록한다. write 중 예외가 나면
        // SnapshotCommand가 before snapshot으로 전체 rollback한다.
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'tableBlockCalc',
          operation: (wasm) => {
            for (const job of plan.jobs) {
              const result = evaluate(wasm, job, true);
              if (!result.ok) throw new Error(`블록 계산 쓰기 실패: ${job.formula}`);
            }
            return pos;
          },
        }), '블록 계산');
      } catch (err) {
        console.warn(`[${id}] 블록 계산 실패:`, err);
      }
    },
  };
}

function openFormulaDialog(services: Parameters<CommandDef['execute']>[0]): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const pos = ih.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
  const dialog = new FormulaDialog(services.wasm, services.eventBus, {
    sec: pos.sectionIndex,
    ppi: pos.parentParaIndex,
    ci: pos.controlIndex,
    cellIndex: pos.cellIndex,
  }, services);
  dialog.show();
}

function currentTableCellContext(services: CommandServices): TableCellCommandContext | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  const pos = ih.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return null;
  const cellInfo = services.wasm.getCellInfo(
    pos.sectionIndex,
    pos.parentParaIndex,
    pos.controlIndex,
    pos.cellIndex,
  );
  return { ih, pos, cellInfo };
}

function restoreEditorFocus(ih: TableCellCommandContext['ih']): void {
  const textarea = (ih as unknown as { textarea?: HTMLTextAreaElement }).textarea;
  textarea?.focus();
}

function applyTableInsertRowColumn(
  services: CommandServices,
  mode: TableInsertRowColumnMode,
  count: number,
): void {
  const ctx = currentTableCellContext(services);
  if (!ctx) return;
  const { ih, pos, cellInfo } = ctx;
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: mode.startsWith('row') ? 'insertTableRow' : 'insertTableColumn',
    operation: (wasm) => {
      for (let i = 0; i < count; i += 1) {
        switch (mode) {
          case 'row-above':
            wasm.insertTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row, false);
            break;
          case 'row-below':
            wasm.insertTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row, true);
            break;
          case 'col-left':
            wasm.insertTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col, false);
            break;
          case 'col-right':
            wasm.insertTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col, true);
            break;
        }
      }
      return pos;
    },
  }), '줄/칸 추가');
  restoreEditorFocus(ih);
}


function applyTableDeleteRowColumn(
  services: CommandServices,
  mode: TableDeleteRowColumnMode,
): void {
  const ctx = currentTableCellContext(services);
  if (!ctx) return;
  const { ih, pos, cellInfo } = ctx;
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: mode === 'row' ? 'deleteTableRow' : 'deleteTableColumn',
    operation: (wasm) => {
      const res = mode === 'row'
        ? wasm.deleteTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row)
        : wasm.deleteTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col);
      if (!res.ok) return pos;
      // 삭제 후 셀 수가 줄면 기존 cellIndex가 범위를 벗어날 수 있어 보정한다 (#1483).
      const corrected = clampedCellAfterDelete(
        wasm, pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!,
        cellInfo.row, cellInfo.col, res.rowCount, res.colCount,
        pos.cellPath,
      );
      if (!corrected) {
        // 표 소멸 → 표 밖 본문 위치로 폴백.
        return { sectionIndex: pos.sectionIndex, paragraphIndex: pos.parentParaIndex ?? 0, charOffset: 0 };
      }
      return { ...pos, charOffset: 0, ...corrected };
    },
  }), '줄/칸 지우기');
  restoreEditorFocus(ih);
}

// ─── [hwpx-cowork] 한컴 표 키: 줄 추가하기(Ctrl+Enter)·줄 지우기(Ctrl+Backspace) ───────────

type DocPos = ReturnType<NonNullable<ReturnType<CommandServices['getInputHandler']>>['getCursorPosition']>;

/** 위쪽 표 칸(중첩 표·글상자 안 표가 아닌) 위치면 그 표 좌표를 준다. */
function topLevelTableOf(pos: DocPos): { sec: number; ppi: number; ci: number; cellIdx: number } | null {
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return null;
  // 줄 추가/지우기 wasm API 는 (구역, 문단, 컨트롤) 로만 표를 찾는다 — 중첩 표·글상자 안 표는 닿지 않는다.
  if ((pos.cellPath?.length ?? 0) > 1 || pos.isTextBox) return null;
  return { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex, cellIdx: pos.cellIndex };
}

/** (row, col) 격자 자리를 덮는 칸의 처음 위치. 없으면 null. */
function cellStartAt(
  wasm: CommandServices['wasm'],
  table: { sec: number; ppi: number; ci: number },
  row: number,
  col: number,
): DocPos | null {
  // [hwpx-cowork] 병합 칸도 덮는 모델 격자가 실행 직후 이미 최신이다.
  const indexed = wasm.getTableCellIndexAt?.(table.sec, table.ppi, table.ci, row, col);
  const cellIndex = indexed === undefined ? wasm.getTableCellBboxes(table.sec, table.ppi, table.ci).find((b) =>
    row >= b.row && row < b.row + b.rowSpan && col >= b.col && col < b.col + b.colSpan)?.cellIdx : indexed;
  if (cellIndex == null) return null;
  return {
    sectionIndex: table.sec,
    paragraphIndex: 0,
    charOffset: 0,
    parentParaIndex: table.ppi,
    controlIndex: table.ci,
    cellIndex,
    cellParaIndex: 0,
  };
}

/**
 * 줄 추가하기(한컴 Ctrl+Enter): 현재 줄 **아래**에 한 줄을 끼우고 캐럿을 새 줄의 같은 칸으로 옮긴다
 * (한컴 도움말 「줄/칸 추가하기」 + 한글 COM `TableAppendRow` 실측). 병합 칸이면 그 칸의 아래 끝 줄
 * 아래에 끼운다(마지막 칸 Tab 과 같은 셈). 셀 블록이면 블록의 마지막 줄 아래에 끼우고 블록을 푼다
 * — 여러 줄 블록에서의 한/글 동작은 확인되지 않아 가장 덜 놀라운 쪽을 골랐다.
 */
function appendTableRow(services: CommandServices): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const pos = ih.getCursorPosition();
  const table = topLevelTableOf(pos);
  if (!table) return;
  const info = services.wasm.getCellInfo(table.sec, table.ppi, table.ci, table.cellIdx);
  let afterRow = info.row + Math.max(1, info.rowSpan || 1) - 1;
  if (ih.isInCellSelectionMode()) {
    const range = ih.getSelectedCellRange();
    if (range) afterRow = Math.max(range.startRow, range.endRow);
    ih.exitCellSelectionMode();
  }
  const caretCol = info.col;
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'insertTableRow',
    captureBefore: wasm => wasm.saveInsertRowUndo?.(table.sec, table.ppi, table.ci, afterRow) ?? wasm.saveSnapshot(),
    ownsPriorTextPagination: true, // [hwpx-cowork] 삽입 API가 직전 글자의 표 조각까지 발행한다.
    operation: (wasm) => {
      const res = wasm.insertTableRow(table.sec, table.ppi, table.ci, afterRow, true);
      if (res && res.ok === false) return null;
      return cellStartAt(wasm, table, afterRow + 1, caretCol) ?? pos;
    },
  }), '줄 추가');
}

/**
 * 줄 지우기(한컴 Ctrl+Backspace): 캐럿 칸이 든 줄을 지우고 캐럿을 그 자리 줄의 **첫 칸**으로 옮긴다
 * (한글 COM `TableSubtractRow` 실측). 한/글 동작이 확인되지 않은 경우는 보수적으로 다룬다:
 * 표에 줄이 하나뿐이면 지우지 않고(표 지우기는 따로 한다), 여러 줄 셀 블록이면 지우지 않는다.
 */
function subtractTableRow(services: CommandServices): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const pos = ih.getCursorPosition();
  const table = topLevelTableOf(pos);
  if (!table) return;
  const info = services.wasm.getCellInfo(table.sec, table.ppi, table.ci, table.cellIdx);
  let row = info.row;
  if (ih.isInCellSelectionMode()) {
    const range = ih.getSelectedCellRange();
    if (range && range.startRow !== range.endRow) return;
    if (range) row = range.startRow;
  }
  const dims = services.wasm.getTableDimensions(table.sec, table.ppi, table.ci);
  if (dims.rowCount <= 1) return;
  if (ih.isInCellSelectionMode()) ih.exitCellSelectionMode();
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteTableRow',
    operation: (wasm) => {
      const res = wasm.deleteTableRow(table.sec, table.ppi, table.ci, row);
      if (!res.ok) return pos;
      const nextRow = Math.min(row, res.rowCount - 1);
      return cellStartAt(wasm, table, nextRow, 0) ?? pos;
    },
  }), '줄 지우기');
}

/** [hwpx-cowork] 셀 테두리/배경 대화상자의 처음 탭(키 경로가 params.tab 으로 넘긴다) */
function initialBorderTab(params?: Record<string, unknown>): 'border' | 'background' {
  return params?.tab === 'background' ? 'background' : 'border';
}

/**
 * [#8262] 캐럿이 있는 칸 안에 표를 만들고, 캐럿을 안쪽 표 첫 칸에 둔다.
 * 깊이 1 칸은 `cellPath` 가 없을 수 있어 평면 필드로 경로를 만든다.
 */
function createTableInCell(
  wasm: WasmBridge,
  pos: DocumentPosition,
  rows: number,
  cols: number,
  options?: TableCreateOptions,
): DocumentPosition {
  const cellPath: CellPathEntry[] = pos.cellPath?.length
    ? pos.cellPath
    : [{ controlIndex: pos.controlIndex!, cellIndex: pos.cellIndex!, cellParaIndex: pos.cellParaIndex! }];
  const result = wasm.createTableInCellByPath(pos.sectionIndex, pos.parentParaIndex!, cellPath, pos.charOffset, {
    rowCount: rows,
    colCount: cols,
    ...(options?.colWidths ? { colWidths: options.colWidths } : {}),
    ...(options?.rowHeights ? { rowHeights: options.rowHeights } : {}),
  });
  if (!result.ok) return pos;
  const [outer] = result.cellPath;
  return {
    sectionIndex: pos.sectionIndex,
    paragraphIndex: pos.paragraphIndex,
    charOffset: 0,
    parentParaIndex: pos.parentParaIndex,
    controlIndex: outer.controlIndex,
    cellIndex: outer.cellIndex,
    cellParaIndex: outer.cellParaIndex,
    cellPath: result.cellPath,
  };
}

// ─── [hwpx-cowork] 한/글 2022 표 기능(h2022 표 영역, 2026-11-11) ────────────────────────────
// 근거: research/hangul2022-features-20261111/impl/ledger_table.md(한/글 2022 COM 실측 요약)

type TableAt = { sec: number; ppi: number; ci: number };

/** 캐럿 칸이 든 위쪽 표(중첩 표·글상자 안 표는 null — 이 명령들의 엔진 API 가 평면 표만 받는다). */
function topLevelCaretTable(services: CommandServices): (TableAt & { cellIdx: number; pos: DocPos }) | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  const pos = ih.getCursorPosition();
  const table = topLevelTableOf(pos);
  return table ? { ...table, pos } : null;
}

/** 셀 블록(위쪽 표, 제외 칸 없음)의 표·범위. 아니면 null. */
function topLevelCellBlock(services: CommandServices): (TableAt & {
  range: CellRange;
  ih: NonNullable<ReturnType<CommandServices['getInputHandler']>>;
}) | null {
  const ih = services.getInputHandler();
  if (!ih || !ih.isInCellSelectionMode()) return null;
  const tc = ih.getCellTableContext();
  const range = ih.getSelectedCellRange();
  if (!tc || !range || (tc.cellPath?.length ?? 0) > 1 || ih.hasExcludedCellSelection()) return null;
  return { sec: tc.sec, ppi: tc.ppi, ci: tc.ci, range, ih };
}

/** 표 격자 (행:열) → 그 자리에서 시작하는 칸 번호·병합 폭. */
function cellAnchors(wasm: CommandServices['wasm'], table: TableAt): Map<string, { cellIdx: number; rowSpan: number; colSpan: number }> {
  const dims = wasm.getTableDimensions(table.sec, table.ppi, table.ci);
  const map = new Map<string, { cellIdx: number; rowSpan: number; colSpan: number }>();
  for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx += 1) {
    const info = wasm.getCellInfo(table.sec, table.ppi, table.ci, cellIdx);
    map.set(`${info.row}:${info.col}`, { cellIdx, rowSpan: info.rowSpan, colSpan: info.colSpan });
  }
  return map;
}

/** 셀 높이/너비를 같게 — 셀 블록 범위 그대로 엔진에 넘긴다. 격자를 다시 나눌 수 있어 블록은 푼다. */
function equalizeCellBlock(services: CommandServices, axis: 'width' | 'height'): void {
  const block = topLevelCellBlock(services);
  if (!block) return;
  const { ih, range } = block;
  const pos = ih.getCursorPosition();
  const before = services.wasm.getTableDimensions(block.sec, block.ppi, block.ci);
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: axis === 'width' ? 'equalizeTableCellWidth' : 'equalizeTableCellHeight',
    operation: (wasm) => {
      const r = wasm.resizeTableCellsEqual(block.sec, block.ppi, block.ci,
        range.startRow, range.startCol, range.endRow, range.endCol, axis);
      const moved = pos.cellIndex !== undefined ? r.cellMap?.[pos.cellIndex] : undefined;
      return moved === undefined ? pos : { ...pos, cellIndex: moved, cellParaIndex: 0, charOffset: 0 };
    },
  }), axis === 'width' ? '셀 너비를 같게' : '셀 높이를 같게');
  // 한/글은 명령 뒤에도 셀 블록을 둔다(COM block_keep 실측). 격자를 다시 나눴으면(줄·칸 수가 바뀜) 블록 좌표가
  // 옛 칸을 가리키므로 푼다.
  const after = services.wasm.getTableDimensions(block.sec, block.ppi, block.ci);
  if (after.rowCount !== before.rowCount || after.colCount !== before.colCount) ih.exitCellSelectionMode();
}

/** 블록 합계·평균·곱(한/글 2022 식 모양, 계산식 필드로 저장). */
function h2022BlockCalcCommand(id: string, label: string, fn: HangulCalcFunction, shortcut: string): CommandDef {
  return {
    id,
    label,
    shortcutLabel: shortcut,
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const block = topLevelCellBlock(services);
      if (!block) return;
      const { ih, range } = block;
      try {
        const anchors = cellAnchors(services.wasm, block);
        const dims = services.wasm.getTableDimensions(block.sec, block.ppi, block.ci);
        const cells: Array<Array<{ empty: boolean; rowSpan: number; colSpan: number }>> = [];
        for (let row = range.startRow; row <= range.endRow; row += 1) {
          const line: Array<{ empty: boolean; rowSpan: number; colSpan: number }> = [];
          for (let col = range.startCol; col <= range.endCol; col += 1) {
            const cell = anchors.get(`${row}:${col}`);
            if (!cell) return; // 병합 칸이 덮은 자리 — 한/글 동작 미실측, 하지 않는다
            line.push({
              empty: isTopLevelTableCellEmpty(services.wasm, block.sec, block.ppi, block.ci, cell.cellIdx),
              rowSpan: cell.rowSpan,
              colSpan: cell.colSpan,
            });
          }
          cells.push(line);
        }
        const jobs = planHangulBlockCalculation({
          range, cells, rowCount: dims.rowCount, colCount: dims.colCount, functionName: fn,
        });
        if (!jobs || jobs.length === 0) return;
        const targets = jobs.map((job) => {
          const cell = anchors.get(`${job.targetRow}:${job.targetCol}`);
          return cell && cell.rowSpan === 1 && cell.colSpan === 1 ? { job, cellIdx: cell.cellIdx } : null;
        });
        if (targets.some((x) => !x)) return;
        const pos = ih.getCursorPosition();
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'tableBlockCalc',
          operation: (wasm) => {
            for (const target of targets) {
              // 한/글 2022: 결과 칸에 글이 있으면 결과를 앞에 넣고 글은 남긴다('3x' — COM block_busy 실측)
              wasm.setTableCellFormula(block.sec, block.ppi, block.ci, target!.cellIdx, target!.job.formula, target!.job.resultFormat, true);
            }
            return pos;
          },
        }), '블록 계산');
        // 한/글 2022: 블록 계산 뒤 블록이 결과 칸까지 넓어진다(COM block_keep: A1:B2 → A1:C3)
        const endRow = Math.max(range.endRow, ...jobs.map((j) => j.targetRow));
        const endCol = Math.max(range.endCol, ...jobs.map((j) => j.targetCol));
        if (endRow !== range.endRow || endCol !== range.endCol) {
          ih.setCellSelectionRange?.(range.startRow, range.startCol, endRow, endCol);
        }
      } catch (err) {
        console.warn(`[${id}] 블록 계산 실패:`, err);
      }
    },
  };
}

/** 쉬운 계산식(캐럿 칸) — 가로/세로 합계·평균·곱. */
function easyFormulaCommand(id: string, label: string, fn: HangulCalcFunction, direction: 'horizontal' | 'vertical', shortcut: string): CommandDef {
  return {
    id,
    label,
    shortcutLabel: shortcut,
    canExecute: inTable,
    execute(services) {
      const at = topLevelCaretTable(services);
      const ih = services.getInputHandler();
      if (!at || !ih) return;
      if (ih.isInCellSelectionMode()) ih.exitCellSelectionMode();
      const { formula, resultFormat } = easyFormula(fn, direction);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'tableEasyFormula',
        operation: (wasm) => {
          wasm.setTableCellFormula(at.sec, at.ppi, at.ci, at.cellIdx, formula, resultFormat);
          return { ...at.pos, cellParaIndex: 0, charOffset: 0 };
        },
      }), '쉬운 계산식');
    },
  };
}

/** 셀 블록 칸(없으면 캐럿 칸) 번호들 — 위쪽 표만. */
function blockOrCaretCells(services: CommandServices): (TableAt & { cells: number[] }) | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  if (ih.isInCellSelectionMode()) {
    const block = ih.getSelectedCellBlockIndices();
    return block && block.cellIndices.length ? { sec: block.sec, ppi: block.ppi, ci: block.ci, cells: block.cellIndices } : null;
  }
  const at = topLevelCaretTable(services);
  return at ? { sec: at.sec, ppi: at.ppi, ci: at.ci, cells: [at.cellIdx] } : null;
}

/** 자릿점 넣기/빼기(한/글 TableInsertComma/TableDeleteComma) — 셀 블록에서만(한/글 2022: 캐럿만 있으면 하지 않았다). */
function thousandsCommand(id: string, label: string, insert: boolean): CommandDef {
  return {
    id,
    label,
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih || !ih.isInCellSelectionMode()) return;
      const target = blockOrCaretCells(services);
      if (!target) return;
      const pos = ih.getCursorPosition();
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: insert ? 'tableInsertComma' : 'tableDeleteComma',
        operation: (wasm) => {
          wasm.applyTableThousandsSeparator(target.sec, target.ppi, target.ci, target.cells, insert);
          return { ...pos, charOffset: 0 };
        },
      }), label);
    },
  };
}

/** 셀 안 정렬 9방향(문단 정렬 + 셀 세로 정렬) — 셀 블록 칸 전부 또는 캐럿 칸. */
function cellAlignCommand(align: CellAlign9, label: string): CommandDef {
  return {
    id: `table:cell-align-${align}`,
    label,
    canExecute: inTableOrCellSelection,
    execute(services) {
      const ih = services.getInputHandler();
      const target = blockOrCaretCells(services);
      if (!ih || !target) return;
      const { alignment, verticalAlign } = cellAlign9Props(align);
      const pos = ih.getCursorPosition();
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'tableCellAlign',
        operation: (wasm) => {
          for (const cellIdx of target.cells) {
            wasm.setCellProperties(target.sec, target.ppi, target.ci, cellIdx, { verticalAlign });
            const paras = wasm.getCellParagraphCount(target.sec, target.ppi, target.ci, cellIdx);
            for (let p = 0; p < paras; p += 1) {
              wasm.applyParaFormatInCell(target.sec, target.ppi, target.ci, cellIdx, p, JSON.stringify({ alignment }));
            }
          }
          return pos;
        },
      }), '셀 정렬');
    },
  };
}

const CELL_ALIGN_LABELS: Array<[CellAlign9, string]> = [
  ['left-top', '왼쪽 위 정렬'], ['center-top', '가운데 위 정렬'], ['right-top', '오른쪽 위 정렬'],
  ['left-center', '왼쪽 가운데 정렬'], ['center-center', '가운데 정렬'], ['right-center', '오른쪽 가운데 정렬'],
  ['left-bottom', '왼쪽 아래 정렬'], ['center-bottom', '가운데 아래 정렬'], ['right-bottom', '오른쪽 아래 정렬'],
];

function h2022TableCommands(): CommandDef[] {
  return [
    easyFormulaCommand('table:easy-sum-h', '가로 합계', 'SUM', 'horizontal', 'Ctrl+Shift+H'),
    easyFormulaCommand('table:easy-sum-v', '세로 합계', 'SUM', 'vertical', 'Ctrl+Shift+V'),
    easyFormulaCommand('table:easy-avg-h', '가로 평균', 'AVG', 'horizontal', 'Ctrl+Shift+J'),
    easyFormulaCommand('table:easy-avg-v', '세로 평균', 'AVG', 'vertical', 'Ctrl+Shift+B'),
    easyFormulaCommand('table:easy-product-h', '가로 곱', 'PRODUCT', 'horizontal', 'Ctrl+Shift+K'),
    easyFormulaCommand('table:easy-product-v', '세로 곱', 'PRODUCT', 'vertical', 'Ctrl+Shift+N'),
    thousandsCommand('table:thousands-insert', '자릿점 넣기', true),
    thousandsCommand('table:thousands-delete', '자릿점 빼기', false),
    ...CELL_ALIGN_LABELS.map(([align, label]) => cellAlignCommand(align, label)),
    {
      id: 'table:auto-fill',
      label: '자동 채우기',
      canExecute: (ctx) => ctx.inCellSelectionMode,
      execute(services) { autoFillBlock(services); },
    },
    shadeCommand('table:cell-shade-inc', '셀 음영 한 단계 어둡게', 1),
    shadeCommand('table:cell-shade-dec', '셀 음영 한 단계 밝게', -1),
    {
      id: 'table:swap',
      label: '표 뒤집기',
      shortcutLabel: 'T',
      canExecute: inTableOrCellSelection,
      execute(services) {
        new TableSwapDialog((kind) => swapTable(services, kind)).show();
      },
    },
    cellMoveCommand('table:col-begin', '줄의 처음 칸으로', 'row-begin'),
    cellMoveCommand('table:col-end', '줄의 끝 칸으로', 'row-end'),
    cellMoveCommand('table:col-page-up', '칸의 맨 위로', 'col-top'),
    cellMoveCommand('table:col-page-down', '칸의 맨 아래로', 'col-bottom'),
    {
      id: 'table:table-to-string',
      label: '표를 문자열로',
      canExecute: inTableOrCellSelection,
      execute(services) {
        new TableTextDialog('table-to-string', (options) => tableToString(services, options)).show();
      },
    },
    {
      id: 'table:string-to-table',
      label: '문자열을 표로',
      canExecute: (ctx) => ctx.hasSelection && !ctx.inTable,
      execute(services) {
        new TableTextDialog('string-to-table', (options) => stringToTable(services, options)).show();
      },
    },
  ];
}

/** 셀 음영 한 단계(한/글 TableCellShadeInc/Dec) — 블록 칸 전부 또는 캐럿 칸. 회색 사다리는 h2022-block-calc.ts shadeStep. */
function shadeCommand(id: string, label: string, delta: 1 | -1): CommandDef {
  return {
    id,
    label,
    canExecute: inTableOrCellSelection,
    execute(services) {
      const ih = services.getInputHandler();
      const target = blockOrCaretCells(services);
      if (!ih || !target) return;
      const pos = ih.getCursorPosition();
      const plan = target.cells.map((cellIdx) => {
        const props = services.wasm.getCellProperties(target.sec, target.ppi, target.ci, cellIdx);
        const current = props.fillType === 'solid' ? props.fillColor ?? null : null;
        return { cellIdx, next: shadeStep(current, delta) };
      }).filter((x) => x.next);
      if (!plan.length) return;
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: delta > 0 ? 'tableCellShadeInc' : 'tableCellShadeDec',
        operation: (wasm) => {
          for (const { cellIdx, next } of plan) {
            wasm.setCellProperties(target.sec, target.ppi, target.ci, cellIdx, { fillType: 'solid', fillColor: next! });
          }
          return pos;
        },
      }), label);
    },
  };
}

/** 표 자동 채우기(한/글 TableAutoFill) — 셀 블록 칸 글로 규칙(`command/h2022-autofill.ts`)을 세우고 빈 칸을 채운다. */
function autoFillBlock(services: CommandServices): void {
  const block = topLevelCellBlock(services);
  if (!block) return;
  const { ih, range } = block;
  const anchors = cellAnchors(services.wasm, block);
  const grid: string[][] = [];
  const idx: number[][] = [];
  for (let r = range.startRow; r <= range.endRow; r += 1) {
    const line: string[] = [];
    const ids: number[] = [];
    for (let c = range.startCol; c <= range.endCol; c += 1) {
      const a = anchors.get(`${r}:${c}`);
      if (!a || a.rowSpan !== 1 || a.colSpan !== 1) return; // 병합 칸 — 한/글 동작 미실측
      line.push(cellPlainText(services.wasm, block, a.cellIdx));
      ids.push(a.cellIdx);
    }
    grid.push(line);
    idx.push(ids);
  }
  const plan = planAutofill(grid);
  if (!plan.length) return;
  const pos = ih.getCursorPosition();
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'tableAutoFill',
    operation: (wasm) => {
      for (const cell of plan) {
        const cellIdx = idx[cell.row][cell.col];
        const paras = wasm.getCellParagraphCount(block.sec, block.ppi, block.ci, cellIdx);
        const last = Math.max(0, paras - 1);
        const lastLen = wasm.getCellParagraphLength(block.sec, block.ppi, block.ci, cellIdx, last);
        if (paras > 1 || lastLen > 0) wasm.deleteRangeInCell(block.sec, block.ppi, block.ci, cellIdx, 0, 0, last, lastLen);
        wasm.insertTextInCell(block.sec, block.ppi, block.ci, cellIdx, 0, 0, cell.text);
      }
      return pos;
    },
  }), '자동 채우기');
}

/** 표 뒤집기(한/글 TableSwap) — 캐럿 표 전체. 칸 번호가 바뀌므로 셀 블록은 풀고 캐럿은 표 첫 칸으로. */
function swapTable(services: CommandServices, kind: number): void {
  const at = topLevelCaretTable(services);
  const ih = services.getInputHandler();
  if (!at || !ih) return;
  if (ih.isInCellSelectionMode()) ih.exitCellSelectionMode();
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'tableSwap',
    operation: (wasm) => {
      wasm.transposeTableSwap(at.sec, at.ppi, at.ci, kind);
      return cellStartAt(wasm, at, 0, 0) ?? at.pos;
    },
  }), '표 뒤집기');
}

/** 셀 이동(한/글 TableColBegin/End/PageUp/PageDown, 2022 COM 실측: (2,1)에서 각각 (2,0)·(2,2)·(0,1)·(3,1)). */
function cellMoveCommand(id: string, label: string, where: 'row-begin' | 'row-end' | 'col-top' | 'col-bottom'): CommandDef {
  return {
    id,
    label,
    canExecute: inTable,
    execute(services) {
      const at = topLevelCaretTable(services);
      const ih = services.getInputHandler();
      if (!at || !ih) return;
      const info = services.wasm.getCellInfo(at.sec, at.ppi, at.ci, at.cellIdx);
      const dims = services.wasm.getTableDimensions(at.sec, at.ppi, at.ci);
      const [row, col] = where === 'row-begin' ? [info.row, 0]
        : where === 'row-end' ? [info.row, dims.colCount - 1]
        : where === 'col-top' ? [0, info.col]
        : [dims.rowCount - 1, info.col];
      const target = cellStartAt(services.wasm, at, row, col);
      if (target) ih.moveCursorTo(target);
    },
  };
}

/** 칸의 모든 문단 글(문단 사이는 빈칸 — 여러 문단 칸의 한/글 동작은 미실측). */
function cellPlainText(wasm: CommandServices['wasm'], table: TableAt, cellIdx: number): string {
  const n = wasm.getCellParagraphCount(table.sec, table.ppi, table.ci, cellIdx);
  const parts: string[] = [];
  for (let p = 0; p < n; p += 1) {
    const len = wasm.getCellParagraphLength(table.sec, table.ppi, table.ci, cellIdx, p);
    parts.push(len > 0 ? wasm.getTextInCell(table.sec, table.ppi, table.ci, cellIdx, p, 0, len) : '');
  }
  return parts.join(' ');
}

/** 표를 문자열로(한/글 TableTableToString): 줄마다 문단 하나, 칸 사이 분리 기호. 표 자리에 글을 넣는다. */
function tableToString(services: CommandServices, options: TableTextOptions): void {
  const at = topLevelCaretTable(services);
  const ih = services.getInputHandler();
  if (!at || !ih) return;
  const dims = services.wasm.getTableDimensions(at.sec, at.ppi, at.ci);
  const anchors = cellAnchors(services.wasm, at);
  const rows: string[][] = [];
  for (let r = 0; r < dims.rowCount; r += 1) {
    const line: string[] = [];
    for (let c = 0; c < dims.colCount; c += 1) {
      const a = anchors.get(`${r}:${c}`);
      line.push(a ? cellPlainText(services.wasm, at, a.cellIdx) : '');
    }
    rows.push(line);
  }
  const lines = cellsToLines(rows, options);
  const offset = services.wasm.getControlTextPositions(at.sec, at.ppi)[at.ci] ?? 0;
  if (ih.isInCellSelectionMode()) ih.exitCellSelectionMode();
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'tableToString',
    operation: (wasm) => {
      wasm.deleteTableControl(at.sec, at.ppi, at.ci);
      let para = at.ppi;
      let off = offset;
      lines.forEach((line, i) => {
        if (line) {
          const r = JSON.parse(wasm.insertText(at.sec, para, off, line) || '{}');
          off = typeof r.charOffset === 'number' ? r.charOffset : off + line.length;
        }
        if (i < lines.length - 1) {
          wasm.splitParagraph(at.sec, para, off);
          para += 1;
          off = 0;
        }
      });
      return { sectionIndex: at.sec, paragraphIndex: para, charOffset: off };
    },
  }), '표를 문자열로');
}

/** 문자열을 표로(한/글 TableStringToTable): 고른 문단들을 줄마다 한 행, 분리 기호마다 한 칸인 표로 바꾼다. */
function stringToTable(services: CommandServices, options: TableTextOptions): void {
  const ih = services.getInputHandler();
  const sel = ih?.getSelection();
  if (!ih || !sel) return;
  const { start, end } = sel;
  if (start.parentParaIndex !== undefined || end.parentParaIndex !== undefined || start.sectionIndex !== end.sectionIndex) return;
  const sec = start.sectionIndex;
  const first = start.paragraphIndex;
  const last = end.charOffset === 0 && end.paragraphIndex > first ? end.paragraphIndex - 1 : end.paragraphIndex;
  const lines: string[] = [];
  for (let p = first; p <= last; p += 1) {
    // 개체(그림·표·글상자…)가 든 문단은 글만 옮기면 개체를 잃는다 — 하지 않는다(한/글 동작 미실측).
    if (services.wasm.getControlTextPositions(sec, p).length > 0) return;
    const len = services.wasm.getParagraphLength(sec, p);
    lines.push(len > 0 ? services.wasm.getTextRange(sec, p, 0, len) : '');
  }
  const cells = linesToCells(lines, options);
  const cols = cells[0]?.length ?? 0;
  if (!cells.length || !cols) return;
  const lastLen = services.wasm.getParagraphLength(sec, last);
  safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: 'stringToTable',
    operation: (wasm) => {
      wasm.deleteRange(sec, first, 0, last, lastLen);
      const made = wasm.createTable(sec, first, 0, cells.length, cols);
      if (!made.ok) throw new Error('표 만들기 실패');
      cells.forEach((row, r) => row.forEach((text, c) => {
        if (text) wasm.insertTextInCell(sec, made.paraIdx, made.controlIdx, r * cols + c, 0, 0, text);
      }));
      return {
        sectionIndex: sec, paragraphIndex: made.paraIdx, charOffset: 0,
        parentParaIndex: made.paraIdx, controlIndex: made.controlIdx, cellIndex: 0, cellParaIndex: 0,
      };
    },
  }), '문자열을 표로');
}

export const tableCommands: CommandDef[] = [
  { id: 'table:create', label: t('command.table.create.label'), icon: 'icon-table',
    opensDialog: true,
    // [#8262] 표 칸 안에서도 만든다(깊이 무관). 글상자 안은 아직 받지 않는다.
    canExecute: (ctx) => ctx.hasDocument,
    execute(services, params) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.isTextBox) return;
      const inCell = pos.parentParaIndex !== undefined;
      const dialog = new TableCreateDialog();
      dialog.inlineOnly = inCell;
      dialog.onApply = (rows, cols, options?: TableCreateOptions) => {
        const ih2 = services.getInputHandler();
        if (!ih2) return;
        safeTableOp(() => ih2.executeOperation({
          kind: 'snapshot',
          operationType: 'createTable',
          operation: (wasm) => {
            if (inCell) return createTableInCell(wasm, pos, rows, cols, options);
            const result = options
              ? wasm.createTableEx({
                  sectionIdx: pos.sectionIndex,
                  paraIdx: pos.paragraphIndex,
                  charOffset: pos.charOffset,
                  rowCount: rows,
                  colCount: cols,
                  ...options,
                })
              : wasm.createTable(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, rows, cols);
            if (result.ok) {
              return {
                sectionIndex: pos.sectionIndex,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: result.paraIdx,
                controlIndex: result.controlIdx,
                cellIndex: 0,
                cellParaIndex: 0,
                cellPath: [{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }],
              };
            }
            return pos;
          },
        }), '표 만들기');
        // 대화상자 닫힘 후 편집 포커스 복원 — textarea 에 keydown 이 바인딩되어
        // 있어, 복원하지 않으면 직후 F5 등이 브라우저 기본동작으로 빠진다 (#1140)
        (ih2 as any).textarea?.focus();
      };
      dialog.show(params?.anchorEl as HTMLElement | undefined);
    },
  },
  {
    id: 'table:cell-props',
    opensDialog: true,
    label: t('command.table.cellProps.label'),
    canExecute: (ctx) => ctx.inTable || ctx.inCellSelectionMode || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      if (ih.isInTableObjectSelection()) {
        const ref = ih.getSelectedTableRef();
        if (!ref) return;
        const tableCtx = { sec: ref.sec, ppi: ref.ppi, ci: ref.ci };
        const dialog = new TableCellPropsDialog(services.wasm, services.eventBus, tableCtx, 0, 'table', services);
        dialog.show();
        return;
      }

      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex };
      // [hwpx-cowork] 셀 블록(F5·마우스 끌기)에서 열면 셀 탭 변경을 블록 칸 전부에 적용한다.
      const block = ih.isInCellSelectionMode() ? ih.getSelectedCellBlockIndices() : null;
      const blockCells = block && block.sec === tableCtx.sec && block.ppi === tableCtx.ppi && block.ci === tableCtx.ci
        ? block.cellIndices
        : undefined;
      const dialog = new TableCellPropsDialog(services.wasm, services.eventBus, tableCtx, pos.cellIndex, 'cell', services);
      dialog.setBlockCells(blockCells);
      dialog.show();
    },
  },
  {
    id: 'table:border-each',
    opensDialog: true,
    label: t('command.table.borderEach.registryLabel'),
    canExecute: inTable,
    execute(services, params) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex };
      const selectionRange = ih.isInCellSelectionMode?.() ? ih.getSelectedCellRange?.() ?? null : null;
      const dialog = new CellBorderBgDialog(
        services.wasm,
        services.eventBus,
        tableCtx,
        pos.cellIndex,
        'each',
        selectionRange,
        services,
      );
      dialog.setInitialTab(initialBorderTab(params)); // [hwpx-cowork] 셀 블록 L(테두리)/C(배경)
      dialog.show();
    },
  },
  {
    id: 'table:border-one',
    opensDialog: true,
    label: t('command.table.borderOne.registryLabel'),
    canExecute: hasMultiCellSelection,
    execute(services, params) {
      const ih = services.getInputHandler();
      if (!ih) return;
      if (!ih.hasMultiCellSelection()) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex };
      const dialog = new CellBorderBgDialog(
        services.wasm,
        services.eventBus,
        tableCtx,
        pos.cellIndex,
        'asOne',
        ih.getSelectedCellRange(),
        services,
      );
      dialog.setInitialTab(initialBorderTab(params)); // [hwpx-cowork] 셀 블록 B(테두리)/F(배경)
      dialog.show();
    },
  },
  {
    id: 'table:insert-row-col',
    opensDialog: true,
    label: t('command.table.insertRowCol.label'),
    shortcutLabel: 'Alt+Insert', // [hwpx-cowork] 한컴 표시(Alt+Enter 는 별칭으로 남김)
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const dialog = new TableInsertRowColumnDialog();
      dialog.onApply = ({ mode, count }) => applyTableInsertRowColumn(services, mode, count);
      dialog.afterClose = () => restoreEditorFocus(ih);
      dialog.show();
    },
  },
  {
    id: 'table:delete-row-col',
    opensDialog: true,
    label: t('command.table.deleteRowCol.label'),
    shortcutLabel: 'Alt+Delete',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const dialog = new TableDeleteRowColumnDialog();
      dialog.onApply = ({ mode }) => applyTableDeleteRowColumn(services, mode);
      dialog.afterClose = () => restoreEditorFocus(ih);
      dialog.show();
    },
  },
  // [hwpx-cowork] 한컴 표 키 — 줄 추가하기(Ctrl+Enter), 줄 지우기(Ctrl+Backspace).
  // 키 경로는 contextual-shortcut 의 resolveTableKeyShortcut 이 소유한다(본문 Ctrl+Enter = 쪽 나누기).
  {
    id: 'table:append-row',
    label: t('command.table.appendRow.label'),
    shortcutLabel: 'Ctrl+Enter',
    canExecute: inTableOrCellSelection,
    execute(services) {
      appendTableRow(services);
    },
  },
  {
    id: 'table:subtract-row',
    label: t('command.table.subtractRow.label'),
    shortcutLabel: 'Ctrl+Backspace',
    canExecute: inTableOrCellSelection,
    execute(services) {
      subtractTableRow(services);
    },
  },
  {
    id: 'table:insert-row-above',
    label: t('command.table.insertRowAbove.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'insertTableRow',
        operation: (wasm) => {
          wasm.insertTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row, false);
          return pos;
        },
      }), '줄 추가');
    },
  },
  {
    id: 'table:insert-row-below',
    label: t('command.table.insertRowBelow.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'insertTableRow',
        operation: (wasm) => {
          wasm.insertTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row, true);
          return pos;
        },
      }), '줄 추가');
    },
  },
  {
    id: 'table:insert-col-left',
    label: t('command.table.insertColLeft.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'insertTableColumn',
        operation: (wasm) => {
          wasm.insertTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col, false);
          return pos;
        },
      }), '칸 추가');
    },
  },
  {
    id: 'table:insert-col-right',
    label: t('command.table.insertColRight.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'insertTableColumn',
        operation: (wasm) => {
          wasm.insertTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col, true);
          return pos;
        },
      }), '칸 추가');
    },
  },
  {
    id: 'table:delete-row',
    label: t('command.table.deleteRow.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'deleteTableRow',
        operation: (wasm) => {
          const res = wasm.deleteTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.row);
          // [hwpx-cowork] 지운 뒤 낡은 cellIndex 가 범위를 벗어나지 않게 보정한다(#1483 과 같은 보정).
          if (!res?.ok) return pos;
          const corrected = clampedCellAfterDelete(
            wasm, pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!,
            cellInfo.row, cellInfo.col, res.rowCount, res.colCount,
          );
          if (!corrected) return { sectionIndex: pos.sectionIndex, paragraphIndex: pos.parentParaIndex ?? 0, charOffset: 0 };
          return {
            sectionIndex: pos.sectionIndex, charOffset: 0,
            parentParaIndex: pos.parentParaIndex, controlIndex: pos.controlIndex, ...corrected,
          };
        },
      }), '줄 지우기');
    },
  },
  {
    id: 'table:delete-col',
    label: t('command.table.deleteCol.registryLabel'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'deleteTableColumn',
        operation: (wasm) => {
          wasm.deleteTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, cellInfo.col);
          return pos;
        },
      }), '칸 지우기');
    },
  },
  {
    id: 'table:cell-split',
    opensDialog: true,
    label: t('command.table.cellSplit.label'),
    shortcutLabel: 'S',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;

      // F5 셀 선택 모드: 범위 선택 여부 확인
      const range = ih.getSelectedCellRange?.();
      const tableCtx = ih.getCellTableContext?.();
      const isMultiCell = range && tableCtx &&
        (range.startRow !== range.endRow || range.startCol !== range.endCol);

      const cellInfo = services.wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex);
      const isMerged = !isMultiCell && (cellInfo.rowSpan > 1 || cellInfo.colSpan > 1);

      const dialog = new CellSplitDialog(isMerged);
      dialog.onApply = (nRows, mCols, equalHeight, mergeFirst) => {
        const ih2 = services.getInputHandler();
        if (!ih2) return;
        safeTableOp(() => ih2.executeOperation({
          kind: 'snapshot',
          operationType: 'splitTableCell',
          operation: (wasm) => {
            if (isMultiCell && range && tableCtx) {
              wasm.splitTableCellsInRange(
                tableCtx.sec, tableCtx.ppi, tableCtx.ci,
                range.startRow, range.startCol, range.endRow, range.endCol,
                nRows, mCols, equalHeight,
              );
            } else {
              wasm.splitTableCellInto(
                pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!,
                cellInfo.row, cellInfo.col,
                nRows, mCols, equalHeight, mergeFirst,
              );
            }
            return pos;
          },
        }), '셀 나누기');
        if (isMultiCell) ih2.exitCellSelectionMode?.();
        // 대화상자 닫힘 후 편집 포커스 복원 (#1140 — 표 만들기와 동일 결함)
        (ih2 as any).textarea?.focus();
      };
      dialog.show();
    },
  },
  {
    id: 'table:cell-merge',
    label: t('command.table.cellMerge.label'),
    shortcutLabel: 'M',
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const range = ih.getSelectedCellRange();
      const tableCtx = ih.getCellTableContext();
      if (!range || !tableCtx) return;
      if (range.startRow === range.endRow && range.startCol === range.endCol) return;
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'mergeTableCells',
        operation: (wasm) => {
          wasm.mergeTableCells(tableCtx.sec, tableCtx.ppi, tableCtx.ci, range.startRow, range.startCol, range.endRow, range.endCol);
          return ih.getCursorPosition();
        },
      }), '셀 합치기');
      ih.exitCellSelectionMode();
    },
  },
  {
    id: 'table:transpose-copy',
    label: t('command.table.transposeCopy.label'),
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const range = ih.getSelectedCellRange?.();
      const tableCtx = ih.getCellTableContext?.();
      if (!range || !tableCtx) return;
      if (hasNonRectangularCellSelection(ih)) return;
      if (tableCtx.cellPath && tableCtx.cellPath.length > 1) return;

      safeTableOp(() => {
        services.wasm.copyTableCellsTransposed(
          tableCtx.sec,
          tableCtx.ppi,
          tableCtx.ci,
          range.startRow,
          range.startCol,
          range.endRow,
          range.endCol,
        );
      }, '행/열 바꿈 복사');
      restoreEditorFocus(ih);
    },
  },
  {
    id: 'table:transpose-paste',
    label: t('command.table.transposePaste.label'),
    canExecute: (ctx) => ctx.hasDocument && ctx.hasTableTransposeClipboard,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if ((pos.cellPath?.length ?? 0) > 1) return;

      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'pasteTableCellsTransposed',
        operation: (wasm) => {
          const pasteAsNewTable = (sectionIndex: number, paragraphIndex: number, charOffset: number) => {
            const result = wasm.pasteTableCellsTransposedAsTable(
              sectionIndex,
              paragraphIndex,
              charOffset,
            );
            if (result.ok && result.paraIdx !== undefined && result.controlIdx !== undefined) {
              return {
                sectionIndex,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: result.paraIdx,
                controlIndex: result.controlIdx,
                cellIndex: 0,
                cellParaIndex: 0,
              };
            }
            return pos;
          };

          const selectionTableCtx = ih.isInCellSelectionMode?.() ? ih.getCellTableContext?.() : null;
          if (selectionTableCtx) {
            if ((selectionTableCtx.cellPath?.length ?? 0) > 1) return pos;
            const range = ih.getSelectedCellRange?.();
            const dims = wasm.getTableDimensions(
              selectionTableCtx.sec,
              selectionTableCtx.ppi,
              selectionTableCtx.ci,
            );
            const isWholeTable = range
              && range.startRow === 0
              && range.startCol === 0
              && range.endRow === dims.rowCount - 1
              && range.endCol === dims.colCount - 1;
            if (isWholeTable) {
              wasm.transposeTableCellsInPlace(
                selectionTableCtx.sec,
                selectionTableCtx.ppi,
                selectionTableCtx.ci,
              );
              return {
                sectionIndex: selectionTableCtx.sec,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: selectionTableCtx.ppi,
                controlIndex: selectionTableCtx.ci,
                cellIndex: 0,
                cellParaIndex: 0,
              };
            }
            if (range) {
              try {
                wasm.pasteTableCellsTransposed(
                  selectionTableCtx.sec,
                  selectionTableCtx.ppi,
                  selectionTableCtx.ci,
                  range.startRow,
                  range.startCol,
                );
                return {
                  sectionIndex: selectionTableCtx.sec,
                  paragraphIndex: 0,
                  charOffset: 0,
                  parentParaIndex: selectionTableCtx.ppi,
                  controlIndex: selectionTableCtx.ci,
                  cellIndex: 0,
                  cellParaIndex: 0,
                };
              } catch (err) {
                if (!isTransposeTargetOverflowError(err)) throw err;
              }
            }
            return pasteAsNewTable(selectionTableCtx.sec, selectionTableCtx.ppi, 0);
          }

          if (pos.parentParaIndex !== undefined && pos.controlIndex !== undefined && pos.cellIndex !== undefined) {
            const cellInfo = services.wasm.getCellInfo(
              pos.sectionIndex,
              pos.parentParaIndex,
              pos.controlIndex,
              pos.cellIndex,
            );
            try {
              wasm.pasteTableCellsTransposed(
                pos.sectionIndex,
                pos.parentParaIndex,
                pos.controlIndex,
                cellInfo.row,
                cellInfo.col,
              );
            } catch (err) {
              if (!isTransposeTargetOverflowError(err)) throw err;
              return pasteAsNewTable(pos.sectionIndex, pos.parentParaIndex, 0);
            }
            return pos;
          }

          return pasteAsNewTable(pos.sectionIndex, pos.paragraphIndex, pos.charOffset);
        },
      }), '행/열 바꿈 붙여넣기');
      restoreEditorFocus(ih);
    },
  },
  {
    id: 'table:split',
    label: t('command.table.split.registryLabel'),
    shortcutLabel: 'Ctrl+M,A',
    canExecute: (ctx) => ctx.inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos?.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      // 중첩 표(cellPath 깊이 2+)는 flat 인덱스가 바깥 표를 가리켜 오동작한다 —
      // path 기반 API 가 생기기 전까지는 최상위 표에서만 허용.
      if ((pos.cellPath?.length ?? 0) > 1) return;
      const { sectionIndex: sec, parentParaIndex: ppi, controlIndex: ci, cellIndex } = pos;
      safeTableOp(() => {
        // Rust 쪽에서도 첫 행을 거부하지만, snapshot 을 뜬 뒤 실패하면 빈 undo
        // 항목이 남으므로 확정 실패는 executeOperation 전에 걸러낸다.
        const info = services.wasm.getCellInfo(sec, ppi, ci, cellIndex);
        if (info.row === 0) {
          console.warn('[table:split] 첫 번째 줄에서는 표 나누기를 할 수 없습니다.');
          return;
        }
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'splitTable',
          operation: (wasm) => {
            // 커서 셀(row >= 분할행)은 예외 없이 뒤 표로 옮겨지므로, 작업 전
            // 위치를 그대로 반환하면 앞 표의 범위 밖 cellIndex 가 된다
            // (redo 시에도 같은 무효 위치로 복원). 뒤 표 기준으로 재계산한다.
            const res = wasm.splitTable(sec, ppi, ci, info.row);
            const frontCells = wasm.getTableDimensions(sec, ppi, ci).cellCount;
            return {
              sectionIndex: sec,
              paragraphIndex: 0,
              charOffset: 0,
              parentParaIndex: res.backParaIdx,
              controlIndex: 0,
              cellIndex: Math.max(0, cellIndex - frontCells),
              cellParaIndex: 0,
            };
          },
        });
      }, '표 나누기');
    },
  },
  {
    // 한컴 용어는 '붙이기'(attach)지만 의미는 다음 표와의 행 병합이라
    // WASM API 는 mergeTableWithNext, 이벤트는 TablesMerged 를 쓴다.
    id: 'table:attach',
    label: t('command.table.attach.registryLabel'),
    shortcutLabel: 'Ctrl+M,Z',
    canExecute: (ctx) => ctx.inTable || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      // 셀 컨텍스트가 필요 없는 명령이라 표 객체 선택 상태도 지원한다
      // (table:delete 와 같은 패턴 — 테두리 클릭 진입 시 커서는 셀 밖이다).
      let sec: number, ppi: number, ci: number;
      const ref = ih.getSelectedTableRef();
      if (ref) {
        sec = ref.sec; ppi = ref.ppi; ci = ref.ci;
      } else {
        const pos = ih.getCursorPosition();
        if (pos?.parentParaIndex === undefined || pos.controlIndex === undefined) return;
        // 중첩 표(cellPath 깊이 2+)는 flat 인덱스가 바깥 표를 가리켜 오동작한다 —
        // path 기반 API 가 생기기 전까지는 최상위 표에서만 허용.
        if ((pos.cellPath?.length ?? 0) > 1) return;
        sec = pos.sectionIndex; ppi = pos.parentParaIndex; ci = pos.controlIndex;
      }
      safeTableOp(() => {
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'mergeTableWithNext',
          operation: (wasm) => {
            wasm.mergeTableWithNext(sec, ppi, ci);
            return ih.getCursorPosition()!;
          },
        });
      }, '표 붙이기');
    },
  },
  {
    id: 'table:delete',
    label: t('command.table.delete.registryLabel'),
    canExecute: (ctx) => ctx.inTable || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const ref = ih.getSelectedTableRef();
      if (ref) {
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'deleteTable',
          operation: (wasm) => {
            wasm.deleteTableControl(ref.sec, ref.ppi, ref.ci);
            return { sectionIndex: ref.sec, paragraphIndex: ref.ppi, charOffset: 0 };
          },
        }), '표 지우기');
        return;
      }
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined) return;
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'deleteTable',
        operation: (wasm) => {
          wasm.deleteTableControl(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!);
          return { sectionIndex: pos.sectionIndex, paragraphIndex: pos.parentParaIndex!, charOffset: 0 };
        },
      }), '표 지우기');
    },
  },
  {
    id: 'table:caption-toggle',
    label: t('command.table.captionToggle.registryLabel'),
    canExecute: (ctx) => ctx.inTable || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      // 표 참조 획득 (표 객체 선택 또는 셀 내부)
      let sec: number, ppi: number, ci: number;
      const ref = ih.getSelectedTableRef();
      if (ref) {
        sec = ref.sec; ppi = ref.ppi; ci = ref.ci;
      } else {
        const pos = ih.getCursorPosition();
        if (pos.parentParaIndex === undefined || pos.controlIndex === undefined) return;
        sec = pos.sectionIndex; ppi = pos.parentParaIndex; ci = pos.controlIndex;
      }
      // 현재 캡션 상태 조회
      let props: any;
      try { props = services.wasm.getTableProperties(sec, ppi, ci); } catch { return; }
      if (!props) return;
      let charOffset = 0;
      if (!props.hasCaption) {
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'toggleTableCaption',
          operation: (wasm) => {
            const result: any = wasm.setTableProperties(sec, ppi, ci, { hasCaption: true });
            charOffset = result?.captionCharOffset ?? 3;
            return { sectionIndex: sec, paragraphIndex: ppi, charOffset: 0 };
          },
        }), '캡션 넣기');
      } else {
        try {
          const len = services.wasm.getCellParagraphLength(sec, ppi, ci, 65534, 0);
          charOffset = len;
        } catch { charOffset = 0; }
      }
      // 표 내부 편집 모드 종료 후 캡션 편집 진입
      if (ref) {
        ih.exitTableObjectSelection();
      }
      ih.enterTableCaptionEditing(sec, ppi, ci, charOffset);
    },
  },
  // [hwpx-cowork] 셀 높이/너비를 같게(한/글 셀 블록 H/W) — 엔진 equalizeTableCellSizes(한/글 12.30 실측,
  // 블록 밖 셀은 제자리·격자 다시 나눔)를 잇는다. 종전 localTableGeometryCanPersist 로 늘 꺼져 있었다.
  {
    id: 'table:cell-height-equal',
    label: t('command.table.cellHeightEqual.label'),
    shortcutLabel: 'H',
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) { equalizeCellBlock(services, 'height'); },
  },
  {
    id: 'table:cell-width-equal',
    label: t('command.table.cellWidthEqual.label'),
    shortcutLabel: 'W',
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) { equalizeCellBlock(services, 'width'); },
  },
  ...h2022TableCommands(),
  {
    id: 'table:formula',
    label: t('command.table.formula.registryLabel'),
    shortcutLabel: 'Ctrl+M,F',
    canExecute: inTable,
    execute(services) { openFormulaDialog(services); },
  },
  {
    id: 'table:block-formula',
    label: t('command.table.blockFormula.label'),
    canExecute: inTable,
    execute(services) { openFormulaDialog(services); },
  },
  // [hwpx-cowork] 블록 합계·평균·곱 — 한/글 2022 처럼 계산식 필드로 저장(h2022BlockCalcCommand).
  h2022BlockCalcCommand('table:block-sum', t('command.table.blockSum.label'), 'SUM', 'Ctrl+Shift+S'),
  h2022BlockCalcCommand('table:block-avg', t('command.table.blockAvg.label'), 'AVG', 'Ctrl+Shift+A'),
  h2022BlockCalcCommand('table:block-product', t('command.table.blockProduct.label'), 'PRODUCT', 'Ctrl+Shift+P'),
  {
    id: 'table:thousand-sep',
    label: t('command.table.thousandSep.label'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex, cei = pos.cellIndex;
      const cpi = pos.cellParaIndex ?? 0;
      try {
        const len = services.wasm.getCellParagraphLength(sec, ppi, ci, cei, cpi);
        if (len <= 0) return;
        const text = services.wasm.getTextInCell(sec, ppi, ci, cei, cpi, 0, len);
        const trimmed = text.trim();
        if (!trimmed) return;
        const stripped = trimmed.replace(/,/g, '');
        const numMatch = stripped.match(/^([+-]?)(\d+)(\.?\d*)$/);
        if (!numMatch) return;
        const [, sign, intPart, decPart] = numMatch;
        let result: string;
        if (trimmed.includes(',')) {
          result = sign + intPart + decPart;
        } else {
          const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          result = sign + formatted + decPart;
        }
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        // [Task #2370] 종전에는 여기를 safeTableOp 으로 한 겹 더 감쌌으나, 이 문장이 바깥
        // try 의 마지막이라 바깥 catch 는 도달할 수 없었다. 관측 차이는 로그뿐이고 바깥
        // catch 의 메시지가 더 구체적이므로 한 겹만 남긴다.
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            wasm.deleteTextInCell(sec, ppi, ci, cei, cpi, 0, len);
            wasm.insertTextInCell(sec, ppi, ci, cei, cpi, 0, result);
            return pos;
          },
        });
      } catch (err) {
        console.warn('[table:thousand-sep] 구분 쉼표 변환 실패:', err);
      }
    },
  },
  {
    id: 'table:decimal-add',
    label: t('command.table.decimalAdd.label'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex, cei = pos.cellIndex;
      const cpi = pos.cellParaIndex ?? 0;
      try {
        const len = services.wasm.getCellParagraphLength(sec, ppi, ci, cei, cpi);
        if (len <= 0) return;
        const text = services.wasm.getTextInCell(sec, ppi, ci, cei, cpi, 0, len);
        const trimmed = text.trim();
        const raw = trimmed.replace(/,/g, '');
        const match = raw.match(/^([+-]?)(\d+)(\.(\d*))?$/);
        if (!match) return;
        const [, sign, intPart, , decimals] = match;
        const newDecimals = (decimals ?? '') + '0';
        const hasCommas = trimmed.includes(',');
        const fmtInt = hasCommas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
        const result = sign + fmtInt + '.' + newDecimals;
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        // [Task #2370] 종전에는 여기를 safeTableOp 으로 한 겹 더 감쌌으나, 이 문장이 바깥
        // try 의 마지막이라 바깥 catch 는 도달할 수 없었다. 관측 차이는 로그뿐이고 바깥
        // catch 의 메시지가 더 구체적이므로 한 겹만 남긴다.
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            wasm.deleteTextInCell(sec, ppi, ci, cei, cpi, 0, len);
            wasm.insertTextInCell(sec, ppi, ci, cei, cpi, 0, result);
            return pos;
          },
        });
      } catch (err) {
        console.warn('[table:decimal-add] 자릿점 넣기 실패:', err);
      }
    },
  },
  {
    id: 'table:decimal-remove',
    label: t('command.table.decimalRemove.label'),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex, cei = pos.cellIndex;
      const cpi = pos.cellParaIndex ?? 0;
      try {
        const len = services.wasm.getCellParagraphLength(sec, ppi, ci, cei, cpi);
        if (len <= 0) return;
        const text = services.wasm.getTextInCell(sec, ppi, ci, cei, cpi, 0, len);
        const trimmed = text.trim();
        const raw = trimmed.replace(/,/g, '');
        const match = raw.match(/^([+-]?)(\d+)\.(\d+)$/);
        if (!match) return;
        const [, sign, intPart, decimals] = match;
        const hasCommas = trimmed.includes(',');
        const fmtInt = hasCommas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
        const newDecimals = decimals.slice(0, -1);
        const result = newDecimals ? sign + fmtInt + '.' + newDecimals : sign + fmtInt;
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        // [Task #2370] 종전에는 여기를 safeTableOp 으로 한 겹 더 감쌌으나, 이 문장이 바깥
        // try 의 마지막이라 바깥 catch 는 도달할 수 없었다. 관측 차이는 로그뿐이고 바깥
        // catch 의 메시지가 더 구체적이므로 한 겹만 남긴다.
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            wasm.deleteTextInCell(sec, ppi, ci, cei, cpi, 0, len);
            wasm.insertTextInCell(sec, ppi, ci, cei, cpi, 0, result);
            return pos;
          },
        });
      } catch (err) {
        console.warn('[table:decimal-remove] 자릿점 빼기 실패:', err);
      }
    },
  },
];
