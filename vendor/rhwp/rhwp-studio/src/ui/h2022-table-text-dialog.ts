/**
 * [hwpx-cowork] 문자열을 표로 / 표를 문자열로 대화상자(한/글 2022 TableStringToTable·TableTableToString, 2026-11-11).
 * 분리 방법: 자동(문자열을 표로만)·탭·쉼표·빈칸·기타 문자, 문자열을 표로는 '분리 기호 남기기'.
 * 나누기 규칙은 `command/h2022-table-text.ts`(Node 시험 가능).
 */
import { ModalDialog } from './dialog';
import type { TableTextDelimiter, TableTextOptions } from '@/command/h2022-table-text';

export class TableTextDialog extends ModalDialog {
  private choice: TableTextDelimiter;
  private otherInput!: HTMLInputElement;
  private keepCheck: HTMLInputElement | null = null;

  constructor(private mode: 'string-to-table' | 'table-to-string', private onApply: (options: TableTextOptions) => void) {
    super(mode === 'string-to-table' ? '문자열을 표로' : '표를 문자열로', 340);
    this.choice = mode === 'string-to-table' ? 'auto' : 'tab';
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'table-text-dialog-body';
    const legend = document.createElement('div');
    legend.textContent = '분리 방법';
    legend.style.fontWeight = 'bold';
    legend.style.marginBottom = '6px';
    body.appendChild(legend);
    const options: Array<[TableTextDelimiter, string]> = [
      ...(this.mode === 'string-to-table' ? [['auto', '자동으로 넣기'] as [TableTextDelimiter, string]] : []),
      ['tab', '탭'], ['comma', '쉼표'], ['space', '빈칸'], ['other', '기타 문자'],
    ];
    const name = `table-text-${Math.random().toString(36).slice(2)}`;
    for (const [value, label] of options) {
      const row = document.createElement('label');
      row.style.display = 'block';
      row.style.margin = '2px 0';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.value = value;
      radio.checked = value === this.choice;
      radio.addEventListener('change', () => {
        if (radio.checked) this.choice = value;
        this.otherInput.disabled = this.choice !== 'other';
      });
      row.appendChild(radio);
      row.appendChild(document.createTextNode(` ${label}`));
      if (value === 'other') {
        this.otherInput = document.createElement('input');
        this.otherInput.type = 'text';
        this.otherInput.maxLength = 8;
        this.otherInput.style.marginLeft = '6px';
        this.otherInput.style.width = '60px';
        this.otherInput.disabled = true;
        row.appendChild(this.otherInput);
      }
      body.appendChild(row);
    }
    if (this.mode === 'string-to-table') {
      const row = document.createElement('label');
      row.style.display = 'block';
      row.style.marginTop = '8px';
      this.keepCheck = document.createElement('input');
      this.keepCheck.type = 'checkbox';
      row.appendChild(this.keepCheck);
      row.appendChild(document.createTextNode(' 분리 기호 남기기'));
      body.appendChild(row);
    }
    return body;
  }

  protected onConfirm(): boolean {
    if (this.choice === 'other' && !this.otherInput.value) {
      this.otherInput.focus();
      return false;
    }
    this.onApply({
      delimiter: this.choice,
      other: this.otherInput.value || undefined,
      keepSeparator: this.keepCheck?.checked ?? false,
    });
    return true;
  }
}
