// [hwpx-cowork] Hancom-style Alt+C: choose what to remember, then apply to a block.
import { ModalDialog } from './dialog';
import type { FormatBrushInfo, FormatBrushMode } from '../engine/format-brush';

const MODES: Array<[FormatBrushMode, string]> = [
  ['character', '글자 모양'], ['paragraph', '문단 모양'], ['both', '글자 모양과 문단 모양 둘 다 복사'],
  ['characterStyle', '글자 스타일'], ['paragraphStyle', '문단 스타일'],
];
class FormatCopyDialog extends ModalDialog {
  private selected: FormatBrushMode;
  constructor(private info: FormatBrushInfo, initial: FormatBrushMode,
    private accept: (mode: FormatBrushMode) => void, private restore: () => void) {
    super('모양 복사', 420);
    this.selected = this.allowed(initial) ? initial : 'character';
    this.afterClose = restore;
  }
  private allowed(mode: FormatBrushMode): boolean {
    return mode === 'characterStyle' ? this.info.hasCharacterStyle
      : mode === 'paragraphStyle' ? this.info.hasParagraphStyle : true;
  }
  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = '본문 모양 복사'; group.append(legend);
    for (const [value, text] of MODES) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:7px;padding:7px 2px;';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'format-copy-mode'; radio.value = value;
      radio.checked = this.selected === value; radio.disabled = !this.allowed(value);
      radio.addEventListener('change', () => { this.selected = value; });
      const name = value === 'characterStyle' ? this.info.characterStyleName
        : value === 'paragraphStyle' ? this.info.paragraphStyleName : null;
      label.append(radio, document.createTextNode(text + (name ? ` (${name})` : '')));
      if (radio.disabled) label.style.color = '#87909e';
      group.append(label);
    }
    const help = document.createElement('p');
    help.style.cssText = 'font-size:12px;line-height:1.6;margin-top:12px;color:#5c6573;';
    help.textContent = '복사 후 바꿀 부분을 블록으로 선택하고 Alt+C를 누르세요. 같은 모양을 여러 곳에 계속 적용할 수 있습니다.';
    body.append(group, help);
    return body;
  }
  protected onConfirm(): void { this.accept(this.selected); }
  override show(): void {
    super.show();
    this.dialog.setAttribute('role', 'dialog'); this.dialog.setAttribute('aria-label', '모양 복사');
    this.dialog.querySelector('.dialog-btn-primary')!.textContent = '복사';
  }
}
export function showFormatCopyDialog(info: FormatBrushInfo, initial: FormatBrushMode,
  accept: (mode: FormatBrushMode) => void, restore: () => void): void {
  new FormatCopyDialog(info, initial, accept, restore).show();
}
