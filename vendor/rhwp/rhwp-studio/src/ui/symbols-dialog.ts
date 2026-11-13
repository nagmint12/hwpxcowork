/**
 * 유니코드 문자표 입력 대화상자
 *
 * 유니코드 블록별 문자 그리드를 표시하고 선택한 문자를 본문에 삽입한다.
 */
import type { CommandServices } from '@/command/types';
import { InsertTextCommand } from '@/engine/command';
import { enableDialogDrag } from './dialog-drag';
import { isCodePointInBlock, type UnicodeBlock } from './unicode-block.ts';
import { UNICODE_BLOCKS } from './symbol-blocks.ts';

import { t } from '../i18n/index.ts';
export { isCodePointInBlock } from './unicode-block.ts';

const COLS = 16;
const RECENT_KEY = 'rhwp-symbols-recent';
const MAX_RECENT = 32;

export class SymbolsDialog {
  private services: CommandServices;
  private _open = false;
  private overlay!: HTMLDivElement;
  private dialog!: HTMLDivElement;
  private blockList!: HTMLDivElement;
  private charGrid!: HTMLDivElement;
  private codeLabel!: HTMLSpanElement;
  private previewCell!: HTMLDivElement;
  private recentGrid!: HTMLDivElement;
  private selectedChar: string | null = null;
  private currentBlock: UnicodeBlock = UNICODE_BLOCKS[0];
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(services: CommandServices) {
    this.services = services;
  }

  isOpen(): boolean { return this._open; }

  show(): void {
    if (this._open) return;
    this._open = true;
    this.build();
    document.body.appendChild(this.overlay);

    // 키 이벤트 캡처
    this.captureHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.hide();
        return;
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', this.captureHandler, true);

    // 초기 블록 선택
    this.selectBlock(this.currentBlock);
    this.updateRecent();

    // [hwpx-cowork] 대화상자가 키보드 포커스를 가져간다. Alt+F10 을 IME 조합 중이나 편집기 밖(웹 앱 창)에서
    // 눌러 열었을 때도 Esc 가 이 창의 capture 처리기에 닿고, 조합 중인 글자는 열기 전에 확정된다
    // (한/글도 조합을 끝내고 문자표를 띄운다). 닫으면 hide() 가 편집 칸으로 포커스를 돌려준다.
    this.dialog.tabIndex = -1;
    this.dialog.style.outline = 'none';
    this.dialog.focus({ preventScroll: true });
  }

  hide(): void {
    if (this.captureHandler) {
      document.removeEventListener('keydown', this.captureHandler, true);
      this.captureHandler = null;
    }
    this._open = false;
    this.overlay?.remove();

    // 편집 영역 포커스 복원
    const ih = this.services.getInputHandler();
    ih?.focus();
  }

  // ── DOM 구성 ──

  private build(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';

    this.dialog = document.createElement('div');
    this.dialog.className = 'dialog-wrap sym-dialog';

    // 타이틀
    const titleBar = document.createElement('div');
    titleBar.className = 'dialog-title';
    titleBar.textContent = t('dialog.symbols.titleBar.text');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => this.hide());
    titleBar.appendChild(closeBtn);
    this.dialog.appendChild(titleBar);
    enableDialogDrag(this.dialog, titleBar);

    // 본문
    const body = document.createElement('div');
    body.className = 'dialog-body sym-body';

    // 상단: 블록 목록 + 문자 그리드 + 미리보기/코드
    const top = document.createElement('div');
    top.className = 'sym-top';

    // 블록 목록 (왼쪽)
    const blockCol = document.createElement('div');
    blockCol.className = 'sym-block-col';
    const blockLabel = document.createElement('div');
    blockLabel.className = 'sym-label';
    blockLabel.textContent = t('dialog.symbols.blockLabel.text');
    blockCol.appendChild(blockLabel);
    this.blockList = document.createElement('div');
    this.blockList.className = 'sym-block-list';
    for (const block of UNICODE_BLOCKS) {
      const item = document.createElement('div');
      item.className = 'sym-block-item';
      item.textContent = block.name;
      item.addEventListener('click', () => this.selectBlock(block));
      this.blockList.appendChild(item);
    }
    blockCol.appendChild(this.blockList);
    top.appendChild(blockCol);

    // 문자 그리드 + 코드 (오른쪽)
    const rightCol = document.createElement('div');
    rightCol.className = 'sym-right-col';

    // 코드 행
    const codeRow = document.createElement('div');
    codeRow.className = 'sym-code-row';
    const selLabel = document.createElement('span');
    selLabel.className = 'sym-label';
    selLabel.textContent = t('dialog.symbols.selLabel.text');
    codeRow.appendChild(selLabel);
    const codeSpacer = document.createElement('span');
    codeSpacer.style.flex = '1';
    codeRow.appendChild(codeSpacer);
    const codePrefix = document.createElement('span');
    codePrefix.className = 'sym-label';
    codePrefix.textContent = t('dialog.symbols.codePrefix.text');
    codeRow.appendChild(codePrefix);
    this.codeLabel = document.createElement('span');
    this.codeLabel.className = 'sym-code-value';
    codeRow.appendChild(this.codeLabel);
    rightCol.appendChild(codeRow);

    // 그리드
    this.charGrid = document.createElement('div');
    this.charGrid.className = 'sym-char-grid';
    rightCol.appendChild(this.charGrid);

    // 미리보기
    this.previewCell = document.createElement('div');
    this.previewCell.className = 'sym-preview';
    rightCol.appendChild(this.previewCell);

    top.appendChild(rightCol);
    body.appendChild(top);

    // 최근 사용한 문자
    const recentLabel = document.createElement('div');
    recentLabel.className = 'sym-label';
    recentLabel.textContent = t('dialog.symbols.recentLabel.text');
    recentLabel.style.marginTop = '8px';
    body.appendChild(recentLabel);

    this.recentGrid = document.createElement('div');
    this.recentGrid.className = 'sym-recent-grid';
    body.appendChild(this.recentGrid);

    this.dialog.appendChild(body);

    // 하단 버튼
    const footer = document.createElement('div');
    footer.className = 'dialog-footer';
    const insertBtn = document.createElement('button');
    insertBtn.className = 'dialog-btn dialog-btn-primary';
    insertBtn.textContent = t('dialog.symbols.insertBtn.text');
    insertBtn.addEventListener('click', () => this.doInsert());
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'dialog-btn';
    cancelBtn.textContent = t('dialog.symbols.cancelBtn.text');
    cancelBtn.addEventListener('click', () => this.hide());
    footer.appendChild(insertBtn);
    footer.appendChild(cancelBtn);
    this.dialog.appendChild(footer);

    this.overlay.appendChild(this.dialog);
  }

  // ── 블록 선택 ──

  private selectBlock(block: UnicodeBlock): void {
    this.currentBlock = block;

    // 목록 하이라이트
    const items = this.blockList.querySelectorAll('.sym-block-item');
    const idx = UNICODE_BLOCKS.indexOf(block);
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });
    // 스크롤 into view
    items[idx]?.scrollIntoView({ block: 'nearest' });

    this.renderGrid(block);
    this.selectedChar = null;
    this.codeLabel.textContent = block.start.toString(16).toUpperCase().padStart(4, '0');
    this.previewCell.textContent = '';
  }

  private renderGrid(block: UnicodeBlock): void {
    this.charGrid.replaceChildren();
    const count = block.end - block.start + 1;
    const rows = Math.ceil(count / COLS);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const cp = block.start + r * COLS + c;
        const cell = document.createElement('div');
        cell.className = 'sym-cell';
        if (cp <= block.end) {
          const ch = String.fromCodePoint(cp);
          cell.textContent = ch;
          cell.title = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
          cell.addEventListener('click', () => this.selectChar(ch, cp));
          cell.addEventListener('dblclick', () => {
            this.selectChar(ch, cp);
            this.doInsert();
          });
        } else {
          cell.classList.add('empty');
        }
        this.charGrid.appendChild(cell);
      }
    }
  }

  // ── 문자 선택 ──

  private selectChar(ch: string, codePoint: number): void {
    this.selectedChar = ch;
    this.codeLabel.textContent = codePoint.toString(16).toUpperCase().padStart(4, '0');
    this.previewCell.textContent = ch;

    // 그리드 하이라이트 (최근 사용 문자가 현재 블록에 없으면 하이라이트하지 않음)
    this.charGrid.querySelectorAll('.sym-cell.selected').forEach(el => el.classList.remove('selected'));
    if (isCodePointInBlock(codePoint, this.currentBlock)) {
      const idx = codePoint - this.currentBlock.start;
      const cells = this.charGrid.querySelectorAll('.sym-cell');
      cells[idx]?.classList.add('selected');
    }
  }

  // ── 삽입 ──

  private doInsert(): void {
    if (!this.selectedChar) return;

    const ih = this.services.getInputHandler();
    if (!ih) return;

    const pos = ih.getCursorPosition();
    ih.executeOperation({
      kind: 'command',
      command: new InsertTextCommand(pos, this.selectedChar),
    });
    this.services.eventBus.emit('document-changed');

    // hidden textarea 포커스 복원 (후속 타이핑 가능하도록)
    ih.focus();

    // 최근 문자 저장
    this.addToRecent(this.selectedChar);
    this.updateRecent();
  }

  // ── 최근 사용 문자 ──

  private getRecentChars(): string[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private addToRecent(ch: string): void {
    const list = this.getRecentChars().filter(c => c !== ch);
    list.unshift(ch);
    if (list.length > MAX_RECENT) list.length = MAX_RECENT;
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }

  private updateRecent(): void {
    this.recentGrid.replaceChildren();
    const recents = this.getRecentChars();
    if (recents.length === 0) {
      const msg = document.createElement('span');
      msg.className = 'sym-recent-empty';
      msg.textContent = t('dialog.symbols.msg.text');
      this.recentGrid.appendChild(msg);
      return;
    }
    for (const ch of recents) {
      const cell = document.createElement('div');
      cell.className = 'sym-cell sym-recent-cell';
      cell.textContent = ch;
      const cp = ch.codePointAt(0) ?? 0;
      cell.title = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      cell.addEventListener('click', () => this.selectChar(ch, cp));
      cell.addEventListener('dblclick', () => {
        this.selectChar(ch, cp);
        this.doInsert();
      });
      this.recentGrid.appendChild(cell);
    }
  }
}
