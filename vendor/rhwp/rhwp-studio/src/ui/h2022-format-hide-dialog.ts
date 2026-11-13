/**
 * [hwpx-cowork] 감추기 (한/글 2022 쪽 > 감추기, PageHiding, Ctrl+N,S → 편집기 Ctrl+M,S) — 2026-11-11.
 * 캐럿 문단에 감추기 컨트롤(hp:pageHiding)을 넣거나 고친다 — 그 문단이 있는 쪽에서 머리말·꼬리말·바탕쪽·테두리·배경·쪽 번호를 감춘다.
 * 한/글 COM 실측: Fields 비트 0x01|0x04|0x20 → hideHeader·hideMasterPage·hidePageNum="1" 이 캐럿 문단에 저장, 다른 문단에서 또 하면
 * 그 문단에 따로 하나 더 생긴다. 모두 끄면 컨트롤을 지운다(엔진 setPageHide 규칙).
 */
import { ModalDialog } from './dialog';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import { applyThroughRouter } from './dialog-apply';
import { HIDE_FIELDS, hideFlagsFromEngine, hideFlagsToArgs, type HideFlags, type HideKey } from './h2022-format-model';

export class PageHideDialog extends ModalDialog {
  private initial!: HideFlags;
  private checks = new Map<HideKey, HTMLInputElement>();

  constructor(
    private wasm: WasmBridge,
    private eventBus: EventBus,
    private target: { sec: number; para: number },
    private services?: CommandServices,
  ) {
    super('감추기', 300);
  }

  show(): void {
    try {
      this.initial = hideFlagsFromEngine(this.wasm.getPageHide(this.target.sec, this.target.para));
    } catch {
      this.initial = hideFlagsFromEngine(null);
    }
    super.show();
    for (const f of HIDE_FIELDS) this.checks.get(f.key)!.checked = this.initial[f.key];
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    const fs = document.createElement('fieldset');
    fs.style.cssText = 'border:1px solid var(--color-border-lighter);padding:8px 10px;margin:0;font-size:13px;';
    const lg = document.createElement('legend');
    lg.textContent = '감출 내용';
    lg.style.cssText = 'font-size:12px;padding:0 4px;';
    fs.appendChild(lg);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,auto);gap:6px 18px;';
    for (const f of HIDE_FIELDS) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      this.checks.set(f.key, c);
      label.append(c, document.createTextNode(f.label));
      grid.appendChild(label);
    }
    fs.appendChild(grid);
    const note = document.createElement('div');
    note.textContent = '현재 쪽에만 적용됩니다.';
    note.style.cssText = 'font-size:12px;margin-top:8px;color:var(--color-text-secondary, #666);';
    body.append(fs, note);
    return body;
  }

  protected onConfirm(): boolean {
    const next = {} as HideFlags;
    for (const f of HIDE_FIELDS) next[f.key] = this.checks.get(f.key)!.checked;
    const same = HIDE_FIELDS.every((f) => next[f.key] === this.initial[f.key]);
    const apply = () => this.wasm.setPageHide(this.target.sec, this.target.para, hideFlagsToArgs(next));
    return applyThroughRouter({
      services: this.services,
      label: 'PageHideDialog',
      operationType: 'pageHide',
      operation: (ih) => {
        if (same) return null;
        apply();
        return ih.getCursorPosition();
      },
      fallback: () => { apply(); this.eventBus.emit('document-changed'); },
    });
  }
}
