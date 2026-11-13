import { ModalDialog } from './dialog';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import type { CodeControlInfo } from '@/core/types';
import { applyThroughRouter } from './dialog-apply';

import { t } from '../i18n/index.ts';

/** [hwpx-cowork] 새 번호로 시작의 번호 종류(한/글 대화상자와 같은 차례) */
const NUM_TYPES = ['PAGE', 'FOOTNOTE', 'ENDNOTE', 'PICTURE', 'TABLE', 'EQUATION'] as const;

export class NewNumberDialog extends ModalDialog {
  private wasm: any;
  private eventBus: EventBus;
  private cursorPos: { sec: number; para: number; offset: number };
  private numInput!: HTMLInputElement;
  private typeSelect: HTMLSelectElement | null = null;

  /**
   * [hwpx-cowork] existing = 캐럿 자리의 새 번호 부호(있으면 그 종류·번호를 고친다 — 한/글에서 [새 번호] 부호를 고치는 것).
   * 엔진에 setNewNumber 가 있으면 번호 종류(쪽·각주·미주·그림·표·수식)도 고른다 — 종전에는 쪽 번호만 넣을 수 있었다.
   */
  constructor(wasm: any, eventBus: EventBus, pos: { sec: number; para: number; offset: number }, private services?: CommandServices, private existing: CodeControlInfo | null = null) {
    super(existing ? t('dialog.newNumber.titleEdit') : t('dialog.newNumber.title'), 300);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.cursorPos = pos;
  }

  private typed(): boolean { return typeof this.wasm?.hasSetNewNumber === 'function' && this.wasm.hasSetNewNumber(); }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.padding = '16px';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '10px';

    if (this.typed()) {
      const kindRow = document.createElement('div');
      kindRow.style.display = 'flex';
      kindRow.style.alignItems = 'center';
      kindRow.style.gap = '8px';
      const kindLabel = document.createElement('label');
      kindLabel.textContent = t('dialog.newNumber.kind.text');
      kindLabel.style.whiteSpace = 'nowrap';
      const select = document.createElement('select');
      select.style.padding = '4px 8px';
      for (const k of NUM_TYPES) {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = t(`codeControl.numType.${k}`);
        select.appendChild(o);
      }
      select.value = this.existing?.numType && (NUM_TYPES as readonly string[]).includes(this.existing.numType) ? this.existing.numType : 'PAGE';
      this.typeSelect = select;
      kindRow.appendChild(kindLabel);
      kindRow.appendChild(select);
      body.appendChild(kindRow);
    }

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';

    const label = document.createElement('label');
    label.textContent = t('dialog.newNumber.label.text');
    label.style.whiteSpace = 'nowrap';

    this.numInput = document.createElement('input');
    this.numInput.type = 'number';
    this.numInput.min = '1';
    this.numInput.max = '65535';
    this.numInput.value = String(this.existing?.number || 1);
    this.numInput.style.width = '80px';
    this.numInput.style.padding = '4px 8px';

    row.appendChild(label);
    row.appendChild(this.numInput);
    body.appendChild(row);

    return body;
  }

  show(): void {
    super.show();
    setTimeout(() => {
      this.numInput.focus();
      this.numInput.select();
    }, 50);
  }

  protected onConfirm(): boolean {
    const num = parseInt(this.numInput.value, 10);
    if (isNaN(num) || num < 1 || num > 65535) return false;
    const typed = this.typed();
    const numType = this.typeSelect?.value || 'PAGE';
    const target = { sec: this.cursorPos.sec, para: this.cursorPos.para };
    // [새 번호 이관] snapshot 으로 라우팅(#2077 동형). services 미주입 시 직접 적용 fallback.
    const apply = () => (typed
      ? this.wasm.setNewNumber(target, {
        charOffset: this.cursorPos.offset, numType, number: num,
        ...(this.existing ? { codeIndex: this.existing.codeIndex } : {}),
      })
      : this.wasm.insertNewNumber(this.cursorPos.sec, this.cursorPos.para, this.cursorPos.offset, num));
    return applyThroughRouter({
      services: this.services,
      label: 'NewNumberDialog',
      operationType: typed ? 'setNewNumber' : 'insertNewNumber',
      operation: (ih) => { apply(); return ih.getCursorPosition(); },
      fallback: () => { apply(); this.eventBus.emit('document-changed'); },
    });
  }
}
