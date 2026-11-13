// [hwpx-cowork] 조판 부호(표·그림 개체, 표·그림 번호, 새 번호로 시작 등)를 Backspace/Delete 로 지울 때 묻는 창 —
// 한/글의 '지우기' 창과 같다: 경고 아이콘 · '[그림] 을 지울까요?' · [지움(Y)] [취소(N)]. Y·Enter = 지움, N·Esc = 취소.
import { ModalDialog } from './dialog';

import { t } from '../i18n/index.ts';

/** 받침 있는 글자로 끝나면 '을', 아니면 '를'(한글이 아닌 끝 글자는 '을(를)') */
export function objectParticle(label: string): string {
  const last = label.trim().slice(-1);
  const code = last.charCodeAt(0);
  // [hwpx-cowork] 한글이 아닌 끝 글자(괄호 등)는 '를' — 한/글 실측 '[꼬리말(홀수 쪽)] 를 지울까요?'
  if (!(code >= 0xac00 && code <= 0xd7a3)) return t('dialog.codeDelete.particle.vowel');
  return (code - 0xac00) % 28 === 0 ? t('dialog.codeDelete.particle.vowel') : t('dialog.codeDelete.particle.final');
}

class DeleteCodeControlDialog extends ModalDialog {
  private accepted = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  constructor(private label: string, private remove: () => void, private cancel: () => void, private note = '') { super(t('dialog.codeDelete.title'), 360); }
  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'dialog-code-delete-body';
    const icon = document.createElement('span');
    icon.className = 'dialog-code-delete-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 32 32" width="32" height="32"><path d="M16 3 L30 28 H2 Z" fill="#f5c342" stroke="#c99a12" stroke-width="1.2" stroke-linejoin="round"/><rect x="14.6" y="11" width="2.8" height="9.5" rx="1.2" fill="#3b3b3b"/><circle cx="16" cy="24" r="1.7" fill="#3b3b3b"/></svg>';
    const text = document.createElement('span');
    text.className = 'dialog-code-delete-text';
    text.textContent = t('dialog.codeDelete.body.text', { label: this.label, particle: objectParticle(this.label) });
    // [hwpx-cowork] 덧말(메모 — 답글도 함께 지워진다)
    if (this.note) {
      const note = document.createElement('span');
      note.className = 'dialog-code-delete-note';
      note.textContent = this.note;
      text.append(document.createElement('br'), note);
    }
    body.append(icon, text);
    return body;
  }
  protected onConfirm(): void { this.accepted = true; }
  override show(): void {
    // 기본 창의 키 가로채기(모든 키를 막음)보다 먼저 Y/N 을 받는다 — 한글 입력기에서도 물리 키(KeyY·KeyN)로 안다
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.code === 'KeyY' || key === 'y' || e.key === 'ㅛ') {
        e.preventDefault(); e.stopImmediatePropagation();
        this.accepted = true; this.hide();
      } else if (e.code === 'KeyN' || key === 'n' || e.key === 'ㅜ') {
        e.preventDefault(); e.stopImmediatePropagation();
        this.hide();
      }
    };
    document.addEventListener('keydown', this.keyHandler, true);
    super.show();
    this.dialog.classList.add('dialog-code-delete');
    this.dialog.setAttribute('role', 'alertdialog');
    this.dialog.setAttribute('aria-label', t('dialog.codeDelete.show.label'));
    this.dialog.querySelector('.dialog-btn-primary')!.textContent = t('dialog.codeDelete.show.text');
    const buttons = this.dialog.querySelectorAll('.dialog-footer .dialog-btn');
    const cancelBtn = buttons[buttons.length - 1] as HTMLButtonElement | undefined;
    if (cancelBtn && !cancelBtn.classList.contains('dialog-btn-primary')) cancelBtn.textContent = t('dialog.codeDelete.cancel.text');
  }
  override hide(): void {
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    super.hide();
    if (this.accepted) this.remove();
    else this.cancel();
  }
}

export function confirmCodeControlDelete(label: string, remove: () => void, cancel: () => void, note = ''): void {
  new DeleteCodeControlDialog(label, remove, cancel, note).show();
}

/** 묻고 답을 돌려준다(각주·미주 지우기 등) */
export function askCodeControlDelete(label: string): Promise<boolean> {
  return new Promise((resolve) => confirmCodeControlDelete(label, () => resolve(true), () => resolve(false)));
}
