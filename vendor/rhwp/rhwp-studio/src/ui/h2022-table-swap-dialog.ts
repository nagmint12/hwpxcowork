/**
 * [hwpx-cowork] 표 뒤집기 대화상자(한/글 2022 TableSwapDlg — ParameterSet TableSwap Type 0~5, 2026-11-12).
 * 종류 이름은 한/글 ParameterSet 표의 설명을 따른다. 결과는 COM 실측과 같은 엔진 swapTable.
 */
import { ModalDialog } from './dialog';

export const TABLE_SWAP_KINDS: Array<[number, string]> = [
  [0, '위아래 뒤집기'],
  [1, '좌우 뒤집기'],
  [2, '행과 열 바꾸기(X↔Y)'],
  [3, '왼쪽으로 90° 돌리기'],
  [4, '180° 돌리기'],
  [5, '오른쪽으로 90° 돌리기'],
];

export class TableSwapDialog extends ModalDialog {
  private kind = 0;

  constructor(private onApply: (kind: number) => void) {
    super('표 뒤집기', 300);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'table-swap-dialog-body';
    const name = `table-swap-${Math.random().toString(36).slice(2)}`;
    for (const [value, label] of TABLE_SWAP_KINDS) {
      const row = document.createElement('label');
      row.style.display = 'block';
      row.style.margin = '3px 0';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = name;
      radio.checked = value === this.kind;
      radio.addEventListener('change', () => { if (radio.checked) this.kind = value; });
      row.appendChild(radio);
      row.appendChild(document.createTextNode(` ${label}`));
      body.appendChild(row);
    }
    return body;
  }

  protected onConfirm(): boolean {
    this.onApply(this.kind);
    return true;
  }
}
