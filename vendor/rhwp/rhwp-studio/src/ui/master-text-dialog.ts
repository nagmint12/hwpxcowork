import type { CommandServices } from '@/command/types';
import type { MasterTextEntry } from '@/core/wasm-bridge';
import { PageSourceCommand } from '@/engine/command';
import { ModalDialog } from './dialog';

// [hwpx-cowork] 반복되는 바탕쪽은 실제 표시 소유자를 선택해서 한 번 편집한다.
export class MasterTextDialog extends ModalDialog {
  private picker!: HTMLSelectElement;
  private editor!: HTMLInputElement;
  private message!: HTMLDivElement;
  constructor(private services: CommandServices, private rows: MasterTextEntry[]) {
    super('바탕쪽 글 편집', 460);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.cssText = 'display:grid;gap:8px';
    if (!this.rows.length) {
      body.textContent = '이 쪽에 적용된 바탕쪽 문단이 없습니다.';
      return body;
    }
    const label = document.createElement('label');
    label.textContent = '바탕쪽 문단';
    this.picker = document.createElement('select');
    this.picker.setAttribute('aria-label', '바탕쪽 문단');
    this.rows.forEach((row, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${row.section + 1}구역 · 바탕쪽 ${row.master + 1} · 문단 ${row.paragraph + 1}　${row.text.trim().slice(0, 35)}`;
      this.picker.append(option);
    });
    this.editor = document.createElement('input');
    this.editor.setAttribute('aria-label', '바탕쪽 문단 내용');
    this.message = document.createElement('div');
    this.message.setAttribute('role', 'status');
    this.picker.onchange = () => {
      this.editor.value = this.rows[this.picker.selectedIndex].text;
      this.message.textContent = '';
    };
    this.editor.value = this.rows[0].text;
    label.append(this.picker);
    body.append(label, this.editor, this.message);
    return body;
  }

  protected onConfirm(): boolean {
    if (!this.rows.length) return true;
    const row = this.rows[this.picker.selectedIndex];
    const next = this.editor.value;
    if (row.text === next) return true;
    const handler = this.services.getInputHandler();
    if (!handler) return false;
    try {
      handler.executeOperation({ kind: 'command', command: new PageSourceCommand(
        'editMasterText', handler.getCursorPosition(), wasm => wasm.replaceMasterText(row, next),
      ) });
      return true;
    } catch (error) {
      this.message.textContent = String(error);
      return false;
    }
  }
}
