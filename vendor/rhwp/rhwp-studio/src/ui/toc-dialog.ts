// [hwpx-cowork] 차례 만들기 대화상자 — 한/글 2022 '도구 > 차례/색인 > 차례 만들기'와 같은 항목·차례
// (차례 형식 · 만들 차례[제목 차례: 개요 문단/스타일/차례 코드, 표·그림·수식 차례] · 탭 모양 · 하이퍼링크 만들기).
// 마지막에 고른 선택 사항은 이 브라우저에 기억한다(한/글도 대화상자가 지난 값을 기억한다).
import { ModalDialog } from './dialog';
import type { TocOptions } from '@/core/types';

import { t } from '../i18n/index.ts';

const STORE_KEY = 'rhwp-toc-options';
/** 개요 수준 선택(한/글은 1~7 수준) */
const MAX_LEVEL = 7;

export const DEFAULT_TOC_OPTIONS: TocOptions = {
  field: true, title: true, outline: true, level: 2, useStyles: false, styles: [], code: false,
  table: true, picture: true, equation: true, autoTab: false, leader: 3, hyperlink: true,
};

/** 지난번 선택 사항(없으면 한/글 기본값) */
export function rememberedTocOptions(): TocOptions {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_TOC_OPTIONS, ...JSON.parse(raw) };
  } catch { /* 저장소를 쓸 수 없으면 기본값 */ }
  return { ...DEFAULT_TOC_OPTIONS };
}

function remember(o: TocOptions): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* 무시 */ }
}

export class TocDialog extends ModalDialog {
  private opts: TocOptions;
  private resolve: ((o: TocOptions | null) => void) | null = null;
  private result: TocOptions | null = null;
  private el: Record<string, HTMLInputElement> = {};
  private levelSelect!: HTMLSelectElement;
  private posSelect!: HTMLSelectElement;
  private styleList!: HTMLDivElement;
  private titleBox!: HTMLDivElement;

  /**
   * @param styles 문단 스타일 이름(문서 차례)
   * @param initial 처음 값(고치기면 그 차례의 선택 사항)
   * @param confirmLabel 확인 단추 글('만들기' · '고치기')
   */
  constructor(private styles: string[], initial: TocOptions, title?: string, private confirmLabel?: string) {
    super(title ?? t('dialog.toc.title'), 460);
    this.opts = { ...DEFAULT_TOC_OPTIONS, ...initial, styles: [...(initial.styles ?? [])] };
  }

  private check(id: string, label: string, checked: boolean, onChange?: () => void): HTMLLabelElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `toc-${id}`;
    box.checked = checked;
    if (onChange) box.addEventListener('change', onChange);
    this.el[id] = box;
    const lab = document.createElement('label');
    lab.className = 'toc-check';
    lab.append(box, document.createTextNode(label));
    return lab;
  }

  private radio(name: string, id: string, label: string, checked: boolean): HTMLLabelElement {
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = `toc-${name}`;
    r.id = `toc-${id}`;
    r.checked = checked;
    this.el[id] = r;
    const lab = document.createElement('label');
    lab.className = 'toc-check';
    lab.append(r, document.createTextNode(label));
    return lab;
  }

  private section(title: string): HTMLDivElement {
    const s = document.createElement('div');
    s.className = 'dialog-section';
    const h = document.createElement('div');
    h.className = 'dialog-section-title';
    h.textContent = title;
    s.appendChild(h);
    return s;
  }

  private row(...children: HTMLElement[]): HTMLDivElement {
    const r = document.createElement('div');
    r.className = 'dialog-row';
    r.append(...children);
    return r;
  }

  /** 제목 차례를 끄면 모으는 방법도 끈다(한/글과 같이 흐리게) */
  private syncEnabled(): void {
    const on = this.el.title.checked;
    this.titleBox.classList.toggle('disabled', !on);
    for (const k of ['outline', 'useStyles', 'code']) this.el[k].disabled = !on;
    this.levelSelect.disabled = !on || !this.el.outline.checked;
    const styleOn = on && this.el.useStyles.checked;
    this.styleList.classList.toggle('disabled', !styleOn);
    for (const b of this.styleList.querySelectorAll('input')) (b as HTMLInputElement).disabled = !styleOn;
  }

  protected createBody(): HTMLElement {
    const o = this.opts;
    const body = document.createElement('div');
    body.className = 'toc-dialog-body';

    const fmt = this.section(t('dialog.toc.format'));
    fmt.appendChild(this.row(this.radio('fmt', 'field', t('dialog.toc.field'), o.field), this.radio('fmt', 'string', t('dialog.toc.string'), !o.field)));
    body.appendChild(fmt);

    const make = this.section(t('dialog.toc.make'));
    make.appendChild(this.row(this.check('title', t('dialog.toc.titleList'), o.title, () => this.syncEnabled())));
    this.titleBox = document.createElement('div');
    this.titleBox.className = 'toc-title-box';
    // 개요 문단으로 모으기 + 개요 수준
    this.levelSelect = document.createElement('select');
    this.levelSelect.className = 'toc-level';
    for (let i = 0; i < MAX_LEVEL; i++) {
      const op = document.createElement('option');
      op.value = String(i);
      op.textContent = t('dialog.toc.levelN', { n: i + 1 });
      this.levelSelect.appendChild(op);
    }
    this.levelSelect.value = String(Math.min(Math.max(o.level, 0), MAX_LEVEL - 1));
    const levelLab = document.createElement('span');
    levelLab.className = 'toc-muted';
    levelLab.textContent = t('dialog.toc.level');
    const until = document.createElement('span');
    until.className = 'toc-muted';
    until.textContent = t('dialog.toc.until');
    this.titleBox.appendChild(this.row(this.check('outline', t('dialog.toc.outline'), o.outline, () => this.syncEnabled()), levelLab, this.levelSelect, until));
    // 스타일로 모으기 + 스타일 목록(여러 개 고르기)
    this.titleBox.appendChild(this.row(this.check('useStyles', t('dialog.toc.byStyle'), o.useStyles, () => this.syncEnabled())));
    this.styleList = document.createElement('div');
    this.styleList.className = 'toc-style-list';
    this.styleList.setAttribute('role', 'listbox');
    this.styleList.setAttribute('aria-multiselectable', 'true');
    for (const name of this.styles) {
      const b = document.createElement('input');
      b.type = 'checkbox';
      b.value = name;
      b.checked = o.styles.includes(name);
      const lab = document.createElement('label');
      lab.className = 'toc-style-item';
      lab.append(b, document.createTextNode(name));
      this.styleList.appendChild(lab);
    }
    this.titleBox.appendChild(this.styleList);
    this.titleBox.appendChild(this.row(this.check('code', t('dialog.toc.byCode'), o.code)));
    this.el.code.parentElement!.title = t('dialog.toc.byCode.tip');
    make.appendChild(this.titleBox);
    make.appendChild(this.row(
      this.check('table', t('dialog.toc.tableList'), o.table),
      this.check('picture', t('dialog.toc.pictureList'), o.picture),
      this.check('equation', t('dialog.toc.equationList'), o.equation),
    ));
    body.appendChild(make);

    const tab = this.section(t('dialog.toc.tab'));
    tab.appendChild(this.row(this.radio('tab', 'autoTab', t('dialog.toc.autoTab'), o.autoTab), this.radio('tab', 'rightTab', t('dialog.toc.rightTab'), !o.autoTab)));
    body.appendChild(tab);

    // 만들 위치: 현재 문서의 커서 위치 / 현재 문서의 새 구역(한/글의 '새 탭'은 새 문서와 같아 두지 않는다). 고치기는 그 자리 그대로
    const etc = this.section(t('dialog.toc.etc'));
    const pos = document.createElement('select');
    pos.className = 'toc-pos';
    for (const [value, label] of [['caret', t('dialog.toc.posCaret')], ['section', t('dialog.toc.posSection')]]) {
      const op = document.createElement('option');
      op.value = value;
      op.textContent = label;
      pos.appendChild(op);
    }
    pos.value = 'caret';
    pos.disabled = !!this.confirmLabel;
    this.posSelect = pos;
    const posLab = document.createElement('span');
    posLab.className = 'toc-muted';
    posLab.textContent = t('dialog.toc.pos');
    etc.appendChild(this.row(posLab, pos));
    etc.appendChild(this.row(this.check('hyperlink', t('dialog.toc.hyperlink'), o.hyperlink)));
    body.appendChild(etc);

    this.syncEnabled();
    return body;
  }

  override show(): void {
    super.show();
    this.dialog.classList.add('toc-dialog');
    if (this.confirmLabel) this.dialog.querySelector('.dialog-btn-primary')!.textContent = this.confirmLabel;
    else this.dialog.querySelector('.dialog-btn-primary')!.textContent = t('dialog.toc.makeBtn');
  }

  private read(): TocOptions {
    const styles = [...this.styleList.querySelectorAll('input')].filter((b) => (b as HTMLInputElement).checked).map((b) => (b as HTMLInputElement).value);
    return {
      field: this.el.field.checked,
      title: this.el.title.checked,
      outline: this.el.outline.checked,
      level: Number(this.levelSelect.value) || 0,
      useStyles: this.el.useStyles.checked,
      styles,
      code: this.el.code.checked,
      table: this.el.table.checked,
      picture: this.el.picture.checked,
      equation: this.el.equation.checked,
      autoTab: this.el.autoTab.checked,
      leader: this.opts.leader ?? 3,
      hyperlink: this.el.hyperlink.checked,
    };
  }

  protected onConfirm(): boolean {
    const o = this.read();
    if (!o.title && !o.table && !o.picture && !o.equation) return false;
    if (o.title && !o.outline && !(o.useStyles && o.styles.length) && !o.code) return false;
    remember(o);
    // 만들 위치는 기억하지 않는다(구역을 나누는 일이라 매번 고른다)
    this.result = this.posSelect.value === 'section' && !this.posSelect.disabled ? { ...o, newSection: true } : o;
    return true;
  }

  override hide(): void {
    super.hide();
    const r = this.resolve;
    this.resolve = null;
    r?.(this.result);
  }

  /** 대화상자를 띄우고 고른 선택 사항(취소면 null) */
  ask(): Promise<TocOptions | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.show();
    });
  }
}

/** 한/글 '차례 필드가 이미 입력되어 있습니다. 차례 필드를 고칠까요?' — [고침] [필드 추가] [취소] */
class TocExistsDialog extends ModalDialog {
  private choice: 'edit' | 'add' | null = null;
  private resolve: ((c: 'edit' | 'add' | null) => void) | null = null;
  constructor() { super(t('dialog.toc.title'), 380); }
  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.style.padding = '16px 20px';
    body.style.lineHeight = '1.6';
    body.textContent = t('dialog.toc.exists');
    return body;
  }
  protected onConfirm(): void { this.choice = 'edit'; }
  override show(): void {
    super.show();
    const primary = this.dialog.querySelector('.dialog-btn-primary') as HTMLButtonElement;
    primary.textContent = t('dialog.toc.existsEdit');
    const add = document.createElement('button');
    add.className = 'dialog-btn';
    add.textContent = t('dialog.toc.existsAdd');
    add.addEventListener('click', () => { this.choice = 'add'; this.hide(); });
    primary.after(add);
  }
  override hide(): void {
    super.hide();
    const r = this.resolve;
    this.resolve = null;
    r?.(this.choice);
  }
  ask(): Promise<'edit' | 'add' | null> {
    return new Promise((resolve) => { this.resolve = resolve; this.show(); });
  }
}

export function askTocExists(): Promise<'edit' | 'add' | null> {
  return new TocExistsDialog().ask();
}
