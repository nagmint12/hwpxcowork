import { ModalDialog } from './dialog';

const choices = [
  ['overwrite', '덮어쓰기'],
  ['contents', '내용만 덮어쓰기'],
  ['nested', '셀 안에 표로 넣기'],
  ['above', '위쪽에 끼워 넣기'],
  ['below', '아래쪽에 끼워 넣기'],
  ['left', '왼쪽에 끼워 넣기'],
  ['right', '오른쪽에 끼워 넣기'],
] as const;

export type CellPasteMode = (typeof choices)[number][0];

// [hwpx-cowork] Hancom uses the same seven choices for a copied cell block.
export class CellPasteDialog extends ModalDialog {
  private mode: CellPasteMode = 'overwrite';

  constructor(private readonly paste: (mode: CellPasteMode) => boolean) {
    super('셀 붙이기', 350);
  }

  show(): void {
    super.show();
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-label', '셀 붙이기');
    const confirm = this.dialog.querySelector('.dialog-btn-primary');
    if (confirm) confirm.textContent = '붙이기';
  }

  protected createBody(): HTMLElement {
    const options = document.createElement('div');
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', '붙이기 방식');
    options.style.display = 'grid';
    options.style.gap = '8px';
    for (const [mode, title] of choices) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'cell-paste-mode';
      input.checked = mode === this.mode;
      input.addEventListener('change', () => { this.mode = mode; });
      label.append(input, ` ${title}`);
      options.append(label);
    }
    return options;
  }

  protected onTabKey(event: KeyboardEvent): boolean {
    const targets = Array.from(this.dialog.querySelectorAll<HTMLElement>('button, input:checked'));
    const index = targets.indexOf(document.activeElement as HTMLElement);
    const next = (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
    targets[next]?.focus();
    return true;
  }

  protected shouldConfirmOnEnter(target: HTMLElement): boolean {
    return target instanceof HTMLInputElement && target.type === 'radio';
  }

  protected onConfirm(): boolean {
    return this.paste(this.mode);
  }
}
