/**
 * [hwpx-cowork] 문단 번호 사용자 정의 (한/글 2022 '문단 번호 사용자 정의 모양' 창의 핵심 칸) — 2026-11-12, h2022-format.
 * 수준마다 번호 서식(^1. (^2) 등)·번호 모양·시작 번호·번호 정렬·번호 너비 따름·자동 내어 쓰기·너비 조정·본문과의 거리를 정한다.
 * 확인하면 엔진 createNumberingEx 로 **새 번호 정의**를 만들고 그 번호(id)를 onDone 으로 넘긴다(문단 모양 적용은 부르는 쪽 —
 * 번호 모양 창의 onApply 와 같은 경로, executeOperation 안).
 */
import { ModalDialog } from './dialog';
import { NUMBER_SHAPES, previewLevel, type NumberingLevelRow } from './h2022-format-model';

const HWPUNIT_PER_MM = 7200 / 25.4;

export class NumberingCustomDialog extends ModalDialog {
  private rows: NumberingLevelRow[];
  private table!: HTMLDivElement;
  private preview!: HTMLPreElement;

  /** 확인 — 창 줄(부르는 쪽이 createNumberingEx 로 만든다) */
  onDone?: (rows: NumberingLevelRow[]) => void;

  constructor(initial: NumberingLevelRow[]) {
    super('문단 번호 사용자 정의 모양', 760);
    this.rows = initial.map((r) => ({ ...r }));
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:8px;font-size:12px;';
    this.table = document.createElement('div');
    this.table.style.cssText = 'display:grid;grid-template-columns:36px 90px 110px 56px 74px 60px 74px 70px 48px;gap:4px 6px;align-items:center;';
    body.appendChild(this.table);
    this.preview = document.createElement('pre');
    this.preview.style.cssText = 'margin:0;padding:6px;border:1px solid var(--color-border-lighter);min-height:90px;font-size:12px;';
    body.appendChild(this.preview);
    this.render();
    return body;
  }

  private render(): void {
    this.table.replaceChildren();
    for (const h of ['수준', '번호 서식', '번호 모양', '시작', '정렬', '너비 조정', '본문과 거리', '거리 단위', '내어쓰기']) {
      const d = document.createElement('div');
      d.textContent = h;
      d.style.fontWeight = 'bold';
      this.table.appendChild(d);
    }
    this.rows.forEach((r, i) => {
      const lv = document.createElement('div');
      lv.textContent = String(i + 1);
      const fmt = this.input('text', r.format, (v) => { r.format = v; });
      fmt.maxLength = 100;
      const shape = this.select(NUMBER_SHAPES, r.numFormat, (v) => { r.numFormat = v; });
      const start = this.input('number', String(r.start), (v) => { r.start = Math.max(0, parseInt(v, 10) || 0); });
      const align = this.select([{ value: 0, label: '왼쪽' }, { value: 1, label: '가운데' }, { value: 2, label: '오른쪽' }], r.align, (v) => { r.align = v; });
      const width = this.input('number', String(Math.round(r.widthAdjust / HWPUNIT_PER_MM * 10) / 10), (v) => { r.widthAdjust = Math.round((parseFloat(v) || 0) * HWPUNIT_PER_MM); });
      width.title = 'mm';
      const dist = this.input('number', String(r.textOffsetType === 1 ? Math.round(r.textOffset / HWPUNIT_PER_MM * 10) / 10 : r.textOffset), (v) => {
        const n = parseFloat(v) || 0;
        r.textOffset = r.textOffsetType === 1 ? Math.round(n * HWPUNIT_PER_MM) : Math.round(n);
      });
      const unit = this.select([{ value: 0, label: '%' }, { value: 1, label: 'mm' }], r.textOffsetType, (v) => { r.textOffsetType = v; this.render(); });
      const auto = document.createElement('input');
      auto.type = 'checkbox';
      auto.checked = r.autoIndent;
      auto.addEventListener('change', () => { r.autoIndent = auto.checked; });
      this.table.append(lv, fmt, shape, start, align, width, dist, unit, auto);
    });
    this.updatePreview();
  }

  private input(type: string, value: string, set: (v: string) => void): HTMLInputElement {
    const el = document.createElement('input');
    el.type = type;
    el.value = value;
    el.className = 'dialog-input';
    el.style.width = '100%';
    el.addEventListener('input', () => { set(el.value); this.updatePreview(); });
    return el;
  }

  private select(items: ReadonlyArray<{ value: number; label: string }>, value: number, set: (v: number) => void): HTMLSelectElement {
    const el = document.createElement('select');
    el.className = 'dialog-select';
    el.style.width = '100%';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = String(it.value);
      o.textContent = it.label;
      el.appendChild(o);
    }
    el.value = String(value);
    el.addEventListener('change', () => { set(Number(el.value)); this.updatePreview(); });
    return el;
  }

  private updatePreview(): void {
    if (!this.preview) return;
    this.preview.textContent = this.rows.map((_, i) => `${'  '.repeat(i)}${previewLevel(this.rows, i)} 수준 ${i + 1}`).join('\n');
  }

  protected onConfirm(): boolean {
    this.onDone?.(this.rows.map((r) => ({ ...r })));
    return true;
  }
}
