/**
 * [hwpx-cowork] 한/글 2022 차트 명령(2026-11-11, 차트 영역) — 차트 종류 변경·차트 구성 추가(한 창)·줄/칸 전환.
 *
 * 한/글: 차트 디자인 도구 상자 ChangeChartButton·ChartItemButton·ChangeChartRowCol, 차트 영역 오른쪽 단추 메뉴 '차트 종류 변경'
 * (data/uxxml hwp_context_menus.xml IDC_ChartAreaMenu). 저장 꼴은 한/글 COM 실측(엔진 format.rs). 근거·한계: impl/ledger_chart.md.
 */
import type { CommandDef, CommandServices } from '../types';
import type { WasmBridge } from '@/core/wasm-bridge';
import { showToast } from '@/ui/toast';
import { chartTargetFromSelection, matchChartRef, type ChartRefJson } from '@/core/chart-data-target';
import { transposeEdits } from '@/core/h2022-chart-format';
import { ChartFormatDialog, sameChartAddress } from '@/ui/h2022-chart-dialog';

let dialog: ChartFormatDialog | null = null;

function selectedChart(services: CommandServices): { ih: any; chart: ChartRefJson } | null {
  const ih = services.getInputHandler() as any;
  if (!ih) return null;
  const ref = ih.getSelectedPictureRef?.();
  if (!ref) return null;
  const target = chartTargetFromSelection(ref);
  if (!target) return null;
  let chart: ChartRefJson | null = null;
  try {
    chart = matchChartRef(services.wasm.listCharts(), target);
  } catch {
    chart = null;
  }
  if (!chart) return null;
  if (typeof (services.wasm as any).getChartFormatByIndex !== 'function') {
    showToast({ message: '엔진이 옛 판이라 이 기능을 쓸 수 없습니다.', durationMs: 4000 });
    return null;
  }
  return { ih, chart };
}

function openFormat(services: CommandServices, d: ChartFormatDialog): void {
  const sel = selectedChart(services);
  if (!sel) return;
  dialog = d;
  dialog.afterClose = () => requestAnimationFrame(() => sel.ih.focus?.());
  if (!dialog.open(sel.chart)) showToast({ message: '이 차트의 구성을 읽지 못했습니다.', durationMs: 4000 });
}

export const h2022ChartCommands: CommandDef[] = [
  {
    id: 'chart:change-type',
    opensDialog: true,
    label: '차트 종류 변경',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute: (services) => openFormat(services, dialog ?? new ChartFormatDialog(services.wasm, services.eventBus, services)),
  },
  {
    id: 'chart:items',
    opensDialog: true,
    label: '차트 구성 추가',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute: (services) => openFormat(services, dialog ?? new ChartFormatDialog(services.wasm, services.eventBus, services)),
  },
  {
    // 줄/칸 전환 — 데이터 행렬을 뒤집는다(항목 이름 ↔ 계열 이름). 한/글 ChangeChartRowCol 은 COM 액션이 아니라 실측 못 함(원장).
    id: 'chart:switch-row-col',
    label: '줄/칸 전환',
    canExecute: (ctx) => ctx.inPictureObjectSelection,
    execute(services) {
      const sel = selectedChart(services);
      if (!sel) return;
      const data = services.wasm.getChartDataByIndex(sel.chart.index);
      const t = transposeEdits(data);
      if ('error' in t) {
        showToast({ message: t.error, durationMs: 4000 });
        return;
      }
      const probe = services.wasm.setChartDataByIndex(sel.chart.index, { ...t.edits, dryRun: true });
      if (!probe.ok) {
        showToast({ message: (probe.invalid ?? []).map((i) => i.message).join(' ') || '줄/칸을 바꾸지 못했습니다.', durationMs: 5000 });
        return;
      }
      const chart = sel.chart;
      sel.ih.executeOperation({
        kind: 'snapshot',
        operationType: 'objectProps',
        operation: (wasm: WasmBridge) => {
          const found = wasm.listCharts().find((c) => sameChartAddress(c, chart));
          if (!found) return null;
          const res = wasm.setChartDataByIndex(found.index, t.edits);
          return res.ok && (res.changedCount ?? 0) > 0 ? sel.ih.getCursorPosition() : null;
        },
      });
    },
  },
];
