import { ModalDialog } from './dialog';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import { applyThroughRouter } from './dialog-apply';
import { hasH2022Format } from './h2022-format-api';
import {
  COLUMN_LINE_TYPES, COLUMN_LINE_WIDTHS, columnDialogFromEngine, columnDialogToEngine, columnPreset,
  equalWidthsMm, type ColumnDialogValue,
} from './h2022-format-model';

import { t } from '../i18n/index.ts';
const HWPUNIT_PER_MM = 7200 / 25.4;

function hwpunitToMm(hu: number): number {
  return Math.round(hu / HWPUNIT_PER_MM * 10) / 10;
}

function mmToHwpunit(mm: number): number {
  return Math.round(mm * HWPUNIT_PER_MM);
}

const LABEL_MIN_W = '80px';

/** [hwpx-cowork] 캐럿 자리 — 있으면 '현재 다단'(캐럿 문단에 적용되는 단 정의)과 '새 다단으로'를 쓸 수 있다 */
export interface ColumnDialogCaret {
  para: number;
  offset: number;
}

/**
 * 다단 설정 (한/글 2022 쪽 > 단 > 다단 설정, MultiColumn ColDef).
 * [hwpx-cowork 2026-11-11] 한/글 창처럼 자주 쓰이는 모양·단 방향·단별 너비/간격·구분선(종류·굵기·색)·적용 범위를 더했다.
 * 새 엔진(getColumnDefAt)이 없으면 종전처럼 구역 첫 단 정의의 단 수·종류·같은 너비·간격만 다룬다.
 */
export class ColumnSettingsDialog extends ModalDialog {
  private wasm: WasmBridge;
  private eventBus: EventBus;
  private sectionIdx: number;
  private rich = false;
  private bodyWidthHu = 0;
  private initialJson = '';

  private countInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private directionSelect!: HTMLSelectElement;
  private sameWidthCheck!: HTMLInputElement;
  private spacingInput!: HTMLInputElement;
  private widthTable!: HTMLDivElement;
  private widthInputs: HTMLInputElement[] = [];
  private gapInputs: HTMLInputElement[] = [];
  private lineTypeSelect!: HTMLSelectElement;
  private lineWidthSelect!: HTMLSelectElement;
  private lineColorInput!: HTMLInputElement;
  private applySelect!: HTMLSelectElement;
  private richRows: HTMLElement[] = [];

  constructor(
    wasm: WasmBridge,
    eventBus: EventBus,
    sectionIdx: number,
    private services?: CommandServices,
    private caret?: ColumnDialogCaret,
  ) {
    super(t('dialog.columnSettings.mmToHwpunit.title'), 440);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.sectionIdx = sectionIdx;
  }

  show(): void {
    super.show();
    this.populateFields();
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');

    const addRow = (label: string, rich = false): HTMLElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;margin-bottom:10px;gap:8px;';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.style.cssText = `min-width:${LABEL_MIN_W};font-size:13px;`;
      row.appendChild(lbl);
      body.appendChild(row);
      if (rich) this.richRows.push(row);
      return row;
    };
    const select = (items: ReadonlyArray<{ value: number | string; label: string }>, width = '120px'): HTMLSelectElement => {
      const s = document.createElement('select');
      s.style.cssText = `width:${width};padding:4px;font-size:13px;`;
      for (const it of items) {
        const o = document.createElement('option');
        o.value = String(it.value);
        o.textContent = it.label;
        s.appendChild(o);
      }
      return s;
    };

    // 자주 쓰이는 모양 (한/글: 하나·둘·셋·왼쪽·오른쪽)
    const presetRow = addRow('자주 쓰이는 모양', true);
    for (const [key, label] of [['1', '하나'], ['2', '둘'], ['3', '셋'], ['left', '왼쪽'], ['right', '오른쪽']] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dialog-btn';
      b.textContent = label;
      b.style.cssText = 'padding:2px 8px;font-size:12px;';
      b.addEventListener('click', () => this.applyPreset(key));
      presetRow.appendChild(b);
    }

    // 단 수
    const countRow = addRow(t('dialog.columnSettings.addRow.label'));
    this.countInput = document.createElement('input');
    this.countInput.type = 'number';
    this.countInput.min = '1';
    this.countInput.max = '255';
    this.countInput.style.cssText = 'width:60px;padding:4px 6px;font-size:13px;';
    this.countInput.addEventListener('change', () => this.rebuildWidthRows());
    countRow.appendChild(this.countInput);

    // 단 종류
    const typeRow = addRow(t('dialog.columnSettings.addRow.label.x2ec5ae'));
    this.typeSelect = select([
      { value: 0, label: t('dialog.columnSettings.createBody.label') },
      { value: 1, label: t('dialog.columnSettings.createBody.label.x88b36c') },
      { value: 2, label: t('dialog.columnSettings.createBody.label.xb86927') },
    ]);
    typeRow.appendChild(this.typeSelect);

    // 단 방향 (ColDef Layout: 0 왼쪽부터, 1 오른쪽부터, 2 맞쪽 — 한/글 실측 Layout=1 → layout="RIGHT")
    const dirRow = addRow('단 방향', true);
    this.directionSelect = select([{ value: 0, label: '왼쪽부터' }, { value: 1, label: '오른쪽부터' }, { value: 2, label: '맞쪽' }]);
    dirRow.appendChild(this.directionSelect);

    // 너비 동일
    const sameRow = addRow(t('dialog.columnSettings.addRow.label.x1ce391'));
    this.sameWidthCheck = document.createElement('input');
    this.sameWidthCheck.type = 'checkbox';
    this.sameWidthCheck.addEventListener('change', () => this.updateWidthEnabled());
    sameRow.appendChild(this.sameWidthCheck);

    // 단 간격
    const spacingRow = addRow(t('dialog.columnSettings.addRow.label.x35c51a'));
    this.spacingInput = document.createElement('input');
    this.spacingInput.type = 'number';
    this.spacingInput.min = '0';
    this.spacingInput.step = '0.5';
    this.spacingInput.style.cssText = 'width:80px;padding:4px 6px;font-size:13px;';
    spacingRow.appendChild(this.spacingInput);

    // 단별 너비·간격
    this.widthTable = document.createElement('div');
    this.widthTable.style.cssText = 'display:grid;grid-template-columns:50px 90px 90px;gap:4px 8px;font-size:12px;margin:0 0 10px 88px;max-height:160px;overflow:auto;';
    body.appendChild(this.widthTable);
    this.richRows.push(this.widthTable);

    // 구분선
    const lineRow = addRow('구분선', true);
    this.lineTypeSelect = select(COLUMN_LINE_TYPES, '100px');
    this.lineWidthSelect = select(COLUMN_LINE_WIDTHS, '80px');
    this.lineColorInput = document.createElement('input');
    this.lineColorInput.type = 'color';
    this.lineColorInput.style.cssText = 'width:36px;height:24px;padding:0;';
    this.lineTypeSelect.addEventListener('change', () => this.updateLineEnabled());
    lineRow.append(this.lineTypeSelect, this.lineWidthSelect, this.lineColorInput);

    // 적용 범위 (ColDef ApplyTo: 2 현재 다단, 9 새 다단으로)
    const applyRow = addRow('적용 범위', true);
    this.applySelect = select([{ value: 'current', label: '현재 다단' }, { value: 'newColumn', label: '새 다단으로' }]);
    applyRow.appendChild(this.applySelect);

    return body;
  }

  private value(): ColumnDialogValue {
    const count = Math.max(1, Math.min(255, parseInt(this.countInput.value, 10) || 1));
    return {
      count,
      type: Math.max(0, Math.min(2, parseInt(this.typeSelect.value, 10) || 0)),
      direction: Math.max(0, Math.min(2, parseInt(this.directionSelect.value, 10) || 0)),
      sameWidth: this.sameWidthCheck.checked,
      spacingMm: Math.max(0, parseFloat(this.spacingInput.value) || 0),
      widthsMm: this.widthInputs.map((i) => parseFloat(i.value) || 0),
      gapsMm: this.gapInputs.map((i) => parseFloat(i.value) || 0),
      lineType: parseInt(this.lineTypeSelect.value, 10) || 0,
      lineWidth: parseInt(this.lineWidthSelect.value, 10) || 0,
      lineColor: this.lineColorInput.value || '#000000',
    };
  }

  private setValue(v: ColumnDialogValue): void {
    this.countInput.value = String(v.count);
    this.typeSelect.value = String(v.type);
    this.directionSelect.value = String(v.direction);
    this.sameWidthCheck.checked = v.sameWidth;
    this.spacingInput.value = String(v.spacingMm);
    this.lineTypeSelect.value = String(v.lineType);
    this.lineWidthSelect.value = String(v.lineWidth);
    this.lineColorInput.value = /^#[0-9a-f]{6}$/i.test(v.lineColor) ? v.lineColor : '#000000';
    this.rebuildWidthRows(v.widthsMm, v.gapsMm);
    this.updateLineEnabled();
  }

  private rebuildWidthRows(widths?: number[], gaps?: number[]): void {
    const v = this.widthInputs.length ? this.value() : null;
    const count = Math.max(1, Math.min(255, parseInt(this.countInput.value, 10) || 1));
    const fallback = equalWidthsMm(this.bodyWidthHu, count, parseFloat(this.spacingInput.value) || 0);
    const ws = widths && widths.length === count ? widths : (v && v.widthsMm.length === count ? v.widthsMm : fallback);
    const gs = gaps && gaps.length === count ? gaps : Array.from({ length: count }, (_, i) => (i < count - 1 ? parseFloat(this.spacingInput.value) || 0 : 0));
    this.widthTable.replaceChildren();
    this.widthInputs = [];
    this.gapInputs = [];
    for (const head of ['단', '너비(mm)', '간격(mm)']) {
      const h = document.createElement('div');
      h.textContent = head;
      this.widthTable.appendChild(h);
    }
    for (let i = 0; i < count; i++) {
      const n = document.createElement('div');
      n.textContent = String(i + 1);
      const w = document.createElement('input');
      w.type = 'number'; w.step = '0.5'; w.min = '0'; w.value = String(ws[i] ?? 0); w.style.cssText = 'width:80px;';
      const g = document.createElement('input');
      g.type = 'number'; g.step = '0.5'; g.min = '0'; g.value = String(i < count - 1 ? gs[i] ?? 0 : 0); g.style.cssText = 'width:80px;';
      g.disabled = i === count - 1;
      this.widthInputs.push(w);
      this.gapInputs.push(g);
      this.widthTable.append(n, w, g);
    }
    this.updateWidthEnabled();
  }

  private updateWidthEnabled(): void {
    const same = this.sameWidthCheck.checked;
    this.spacingInput.disabled = !same;
    this.widthInputs.forEach((i) => { i.disabled = same; });
    this.gapInputs.forEach((i, idx) => { i.disabled = same || idx === this.gapInputs.length - 1; });
  }

  private updateLineEnabled(): void {
    const on = this.lineTypeSelect.value !== '0';
    this.lineWidthSelect.disabled = !on;
    this.lineColorInput.disabled = !on;
  }

  private applyPreset(key: '1' | '2' | '3' | 'left' | 'right'): void {
    const spacing = parseFloat(this.spacingInput.value) || 8;
    if (key === 'left' || key === 'right') {
      const p = columnPreset(key, this.bodyWidthHu, spacing);
      const cur = this.value();
      this.setValue({ ...p, lineType: cur.lineType, lineWidth: cur.lineWidth, lineColor: cur.lineColor, direction: cur.direction, type: cur.type });
      return;
    }
    this.countInput.value = key;
    this.sameWidthCheck.checked = true;
    this.rebuildWidthRows(equalWidthsMm(this.bodyWidthHu, Number(key), spacing));
  }

  private populateFields(): void {
    this.rich = !!this.caret && hasH2022Format(this.wasm);
    for (const row of this.richRows) row.style.display = this.rich ? '' : 'none';
    if (this.rich) {
      try {
        const def = this.wasm.getColumnDefAt(this.sectionIdx, this.caret!.para);
        this.bodyWidthHu = Number(def.bodyWidth) || 0;
        const v = columnDialogFromEngine(def);
        this.setValue(v);
        this.initialJson = JSON.stringify(columnDialogToEngine(v));
        return;
      } catch {
        this.rich = false;
        for (const row of this.richRows) row.style.display = 'none';
      }
    }
    try {
      const def = this.wasm.getColumnDef(this.sectionIdx);
      this.countInput.value = String(Math.max(def.columnCount, 1));
      this.typeSelect.value = String(def.columnType);
      this.sameWidthCheck.checked = def.sameWidth;
      this.spacingInput.value = String(hwpunitToMm(def.spacing));
    } catch {
      this.countInput.value = '1';
      this.typeSelect.value = '0';
      this.sameWidthCheck.checked = true;
      this.spacingInput.value = '8';
    }
  }

  protected onConfirm(): boolean {
    if (this.rich && this.caret) {
      const props = columnDialogToEngine(this.value());
      const newColumn = this.applySelect.value === 'newColumn';
      const unchanged = !newColumn && JSON.stringify(props) === this.initialJson;
      const caret = this.caret;
      return applyThroughRouter({
        services: this.services,
        label: 'ColumnSettingsDialog',
        operationType: 'columnSettings',
        operation: (ih) => {
          if (unchanged) return null;
          if (newColumn) {
            // 한/글 '새 다단으로'(ApplyTo=9): 캐럿 자리에서 다단 설정 나누기 뒤 새 다단에 값을 준다(COM 실측)
            const r = this.wasm.insertColumnDefBreak(this.sectionIdx, caret.para, caret.offset, props);
            return { sectionIndex: this.sectionIdx, paragraphIndex: r.para, charOffset: r.charOffset };
          }
          this.wasm.setColumnDefAt(this.sectionIdx, caret.para, props);
          return ih.getCursorPosition();
        },
        fallback: () => {
          if (newColumn) this.wasm.insertColumnDefBreak(this.sectionIdx, caret.para, caret.offset, props);
          else this.wasm.setColumnDefAt(this.sectionIdx, caret.para, props);
          this.eventBus.emit('document-changed');
        },
      });
    }
    const count = Math.max(1, Math.min(8, parseInt(this.countInput.value, 10) || 1));
    const type = Math.max(0, Math.min(2, parseInt(this.typeSelect.value, 10) || 0));
    const sameWidth = this.sameWidthCheck.checked ? 1 : 0;
    const spacingHu = Math.max(0, Math.min(32767, mmToHwpunit(parseFloat(this.spacingInput.value) || 0)));
    // [다단 설정 이관] snapshot 으로 라우팅(#2077 동형). services 미주입 시 직접 적용 fallback.
    const apply = () => this.wasm.setColumnDef(this.sectionIdx, count, type, sameWidth, spacingHu);
    return applyThroughRouter({
      services: this.services,
      label: 'ColumnSettingsDialog',
      operationType: 'columnSettings',
      operation: (ih) => { apply(); return ih.getCursorPosition(); },
      fallback: () => { apply(); this.eventBus.emit('document-changed'); },
    });
  }
}
