/**
 * [hwpx-cowork] 쪽 번호 매기기 (한/글 2022 쪽 > 쪽 번호 매기기, PageNumPos, Ctrl+N,P → 편집기 Ctrl+M,P) — 2026-11-11.
 * 번호 위치(11가지)·번호 모양·줄표 넣기·시작 번호. 엔진 setPageNumbering(위치는 구역 첫 문단, 시작 번호는 그 뒤 쪽 새 번호 —
 * 한/글 COM 실측 artifacts/h2022-format/com/result*.json).
 */
import { ModalDialog } from './dialog';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import { applyThroughRouter } from './dialog-apply';
import { PAGE_NUM_FORMATS, PAGE_NUM_POSITIONS, pageNumberingFromEngine, type PageNumberingValue } from './h2022-format-model';

let seq = 0;

export class PageNumberingDialog extends ModalDialog {
  private readonly radioName = `h2022-pagenum-pos-${++seq}`;
  private initial!: PageNumberingValue;
  private positionRadios: HTMLInputElement[] = [];
  private formatSelect!: HTMLSelectElement;
  private dashCheck!: HTMLInputElement;
  private startInput!: HTMLInputElement;
  private preview!: HTMLDivElement;

  constructor(private wasm: WasmBridge, private eventBus: EventBus, private sectionIdx: number, private services?: CommandServices) {
    super('쪽 번호 매기기', 420);
  }

  show(): void {
    try {
      this.initial = pageNumberingFromEngine(this.wasm.getPageNumbering(this.sectionIdx));
    } catch {
      this.initial = pageNumberingFromEngine(null);
    }
    super.show();
    for (const r of this.positionRadios) r.checked = Number(r.value) === this.initial.position;
    this.formatSelect.value = String(this.initial.format);
    this.dashCheck.checked = this.initial.dash;
    this.startInput.value = String(this.initial.startNumber);
    this.updatePreview();
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;font-size:13px;';

    const posSet = this.fieldset('번호 위치');
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,auto);gap:4px 14px;';
    for (const p of PAGE_NUM_POSITIONS) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = this.radioName;
      radio.value = String(p.value);
      radio.addEventListener('change', () => this.updatePreview());
      this.positionRadios.push(radio);
      label.append(radio, document.createTextNode(p.label));
      grid.appendChild(label);
    }
    posSet.appendChild(grid);

    const shapeSet = this.fieldset('번호 모양');
    this.formatSelect = document.createElement('select');
    this.formatSelect.className = 'dialog-select';
    for (const f of PAGE_NUM_FORMATS) {
      const o = document.createElement('option');
      o.value = String(f.value);
      o.textContent = f.label;
      this.formatSelect.appendChild(o);
    }
    this.formatSelect.addEventListener('change', () => this.updatePreview());
    this.dashCheck = document.createElement('input');
    this.dashCheck.type = 'checkbox';
    this.dashCheck.addEventListener('change', () => this.updatePreview());
    const dashLabel = document.createElement('label');
    dashLabel.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:6px;';
    dashLabel.append(this.dashCheck, document.createTextNode('줄표 넣기'));
    shapeSet.append(this.formatSelect, dashLabel);

    const startSet = this.fieldset('시작 번호');
    this.startInput = document.createElement('input');
    this.startInput.type = 'number';
    this.startInput.min = '1';
    this.startInput.max = '65535';
    this.startInput.style.cssText = 'width:80px;padding:4px 6px;';
    startSet.appendChild(this.startInput);

    this.preview = document.createElement('div');
    this.preview.style.cssText = 'padding:6px;border:1px solid var(--color-border-lighter);text-align:center;min-height:20px;';

    body.append(posSet, shapeSet, startSet, this.preview);
    return body;
  }

  private fieldset(title: string): HTMLFieldSetElement {
    const fs = document.createElement('fieldset');
    fs.style.cssText = 'border:1px solid var(--color-border-lighter);padding:8px 10px;margin:0;';
    const lg = document.createElement('legend');
    lg.textContent = title;
    lg.style.cssText = 'font-size:12px;padding:0 4px;';
    fs.appendChild(lg);
    return fs;
  }

  private value(): PageNumberingValue {
    const checked = this.positionRadios.find((r) => r.checked);
    return {
      position: checked ? Number(checked.value) : 0,
      format: Number(this.formatSelect.value) || 0,
      dash: this.dashCheck.checked,
      startNumber: Math.max(1, Math.min(65535, parseInt(this.startInput.value, 10) || 1)),
    };
  }

  private updatePreview(): void {
    const v = this.value();
    const label = PAGE_NUM_FORMATS.find((f) => f.value === v.format)?.label.split(',')[0] ?? '1';
    const pos = PAGE_NUM_POSITIONS.find((p) => p.value === v.position)?.label ?? '';
    this.preview.textContent = v.position === 0 ? '쪽 번호 없음' : `${pos}: ${v.dash ? `- ${label} -` : label}`;
  }

  protected onConfirm(): boolean {
    const v = this.value();
    const same = v.position === this.initial.position && v.format === this.initial.format
      && v.dash === this.initial.dash && v.startNumber === this.initial.startNumber;
    const apply = () => this.wasm.setPageNumbering(this.sectionIdx, v.position, v.format, v.dash, v.startNumber);
    return applyThroughRouter({
      services: this.services,
      label: 'PageNumberingDialog',
      operationType: 'pageNumbering',
      operation: (ih) => {
        if (same) return null;
        apply();
        return ih.getCursorPosition();
      },
      fallback: () => { apply(); this.eventBus.emit('document-changed'); },
    });
  }
}
