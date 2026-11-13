/**
 * [hwpx-cowork] 한/글 2022 '상호 참조'(입력 > 상호 참조, Ctrl+K,R · InsertCrossReferenceDlg) 창 — 표·책갈피만(2026-11-12).
 * 한/글 창 정의(Hwp.UxXml.Dlg.dll IDS_CrossReference): 파일 · 참조 대상 종류(표·그림·수식·각주·미주·개요·책갈피) · 참조 내용 ·
 * 참조 대상 선택 · 하이퍼링크로 연결. 표의 참조 내용(표가 있는 쪽 번호 · 표 번호 · 캡션 내용 · 위/아래)은 COM 실측.
 * 넣는 꼴(CROSSREF 필드 파라미터)은 엔진 `src/document_core/commands/h2022_edit.rs` 머리 주석.
 * 다른 문서 참조·하이퍼링크로 연결·그림/수식/각주/미주/개요·캡션 내용은 아직 없다(원장).
 */
import { ModalDialog } from './dialog';
import { applyThroughRouter } from './dialog-apply';
import type { CommandServices } from '@/command/types';
import { rawDoc } from './h2022-edit-engine';

interface TableTarget { sec: number; para: number; ctrlIdx: number; id: number; number: number }
interface BookmarkTarget { name: string; sec: number; para: number; charPos: number }

/** 표시 글 셈(DOM 없음 — 시험이 부른다): 쪽 번호·표 번호·위/아래 */
export function crossRefText(
  content: 'page' | 'number' | 'updown',
  target: { sec: number; para: number; number?: number },
  caret: { sec: number; para: number },
  pageNumberOf: (sec: number, para: number) => number,
): string {
  if (content === 'number') return String(target.number ?? '');
  if (content === 'updown') return target.sec < caret.sec || (target.sec === caret.sec && target.para < caret.para) ? '위' : '아래';
  return String(pageNumberOf(target.sec, target.para));
}

export class CrossRefDialog extends ModalDialog {
  private kind!: HTMLSelectElement;
  private content!: HTMLSelectElement;
  private list!: HTMLSelectElement;
  private status!: HTMLDivElement;
  private tables: TableTarget[] = [];
  private bookmarks: BookmarkTarget[] = [];

  constructor(private services: CommandServices) { super('상호 참조', 360); }

  protected createBody(): HTMLElement {
    const doc = rawDoc(this.services.wasm);
    try { this.tables = JSON.parse(doc!.getCrossRefTargets()).tables; } catch { this.tables = []; }
    try { this.bookmarks = (this.services.wasm as any).getBookmarks(); } catch { this.bookmarks = []; }
    const b = document.createElement('div');
    b.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;';
    const row = (label: string, el: HTMLElement) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const l = document.createElement('label'); l.textContent = label; l.style.minWidth = '90px';
      r.append(l, el); return r;
    };
    this.kind = document.createElement('select');
    for (const [v, t, on] of [['table', '표', true], ['picture', '그림(아직)', false], ['equation', '수식(아직)', false], ['footnote', '각주(아직)', false],
      ['endnote', '미주(아직)', false], ['outline', '개요(아직)', false], ['bookmark', '책갈피', true]] as const) {
      const o = document.createElement('option'); o.value = v; o.textContent = t; o.disabled = !on; this.kind.appendChild(o);
    }
    this.content = document.createElement('select');
    this.list = document.createElement('select');
    this.list.size = 8;
    this.list.style.width = '100%';
    this.status = document.createElement('div');
    this.status.style.cssText = 'color:#c00;font-size:12px;';
    this.kind.addEventListener('change', () => this.refresh());
    b.append(row('참조 대상 종류', this.kind), row('참조 내용', this.content), document.createTextNode('참조 대상 선택'), this.list, this.status);
    this.refresh();
    return b;
  }

  private refresh(): void {
    const kind = this.kind.value;
    this.content.textContent = '';
    const contents: Array<[string, string]> = kind === 'table'
      ? [['page', '표가 있는 쪽 번호'], ['number', '표 번호'], ['updown', '위/아래']]
      : [['page', '책갈피가 있는 쪽 번호']];
    for (const [v, t] of contents) { const o = document.createElement('option'); o.value = v; o.textContent = t; this.content.appendChild(o); }
    this.list.textContent = '';
    const items: Array<[string, string]> = kind === 'table'
      ? this.tables.map((t, i) => [String(i), `표 ${t.number}`])
      : this.bookmarks.map((x, i) => [String(i), x.name]);
    for (const [v, t] of items) { const o = document.createElement('option'); o.value = v; o.textContent = t; this.list.appendChild(o); }
    if (this.list.options.length) this.list.selectedIndex = 0;
    this.status.textContent = items.length ? '' : '참조할 대상이 없습니다.';
  }

  protected onConfirm(): boolean {
    const ih = this.services.getInputHandler() as any;
    const cursor = ih?.cursor;
    if (!ih || !cursor) return true;
    if (cursor.isInHeaderFooter?.() || cursor.isInFootnote?.() || cursor.isInCell?.()) { this.status.textContent = '상호 참조는 아직 본문 문단에만 넣습니다.'; return false; }
    const idx = this.list.selectedIndex;
    if (idx < 0) { this.status.textContent = '참조 대상을 고르세요.'; return false; }
    const kind = this.kind.value as 'table' | 'bookmark';
    const content = this.content.value as 'page' | 'number' | 'updown';
    const pos = ih.getCursorPosition();
    const wasm = this.services.wasm as any;
    const pageNumberOf = (sec: number, para: number) => {
      const r = wasm.getPageOfPosition(sec, para);
      const page = r?.ok && r.page != null ? r.page : 0;
      try { return wasm.getPageInfo(page).pageNumber ?? page + 1; } catch { return page + 1; }
    };
    const target = kind === 'table' ? this.tables[idx] : this.bookmarks[idx];
    const text = crossRefText(content, kind === 'table' ? target as TableTarget : { sec: (target as BookmarkTarget).sec, para: (target as BookmarkTarget).para },
      { sec: pos.sectionIndex, para: pos.paragraphIndex }, pageNumberOf);
    const input = kind === 'table'
      ? { kind, targetSec: (target as TableTarget).sec, targetPara: (target as TableTarget).para, targetCtrl: (target as TableTarget).ctrlIdx, content, text }
      : { kind, name: (target as BookmarkTarget).name, content, text };
    cursor.clearSelection?.();
    let after = pos;
    const run = () => {
      const r = JSON.parse(rawDoc(this.services.wasm)!.insertCrossReference(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, JSON.stringify(input)));
      if (r?.ok) after = { ...pos, charOffset: r.charOffset + r.length, codeGap: undefined };
      return after;
    };
    return applyThroughRouter({
      services: this.services, label: 'CrossRefDialog', operationType: 'insertCrossReference',
      operation: () => run(),
      fallback: () => { run(); this.services.eventBus.emit('document-changed'); },
    });
  }
}
