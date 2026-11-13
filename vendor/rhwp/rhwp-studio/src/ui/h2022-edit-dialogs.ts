/**
 * [hwpx-cowork] 한/글 2022 편집·입력 대화상자(2026-11-11) — 덧말 넣기, 글자 겹치기, 대문자/소문자 바꾸기,
 * 전각/반각 바꾸기, 날짜/시간 형식. 이름표·선택지는 한/글 2022 메뉴·파라미터 셋을 따른다(원장 `ledger_edit.md`).
 * 문서를 바꾸는 것은 모두 편집 라우터(snapshot)로 보낸다 — 되돌리기 한 번에 되돌아가고 저장·서버 반영 경로를 지난다.
 */
import { ModalDialog } from './dialog';
import { applyThroughRouter } from './dialog-apply';
import type { CommandServices } from '@/command/types';
import {
  CASE_TYPE_LABELS, COMPOSE_SHAPES, COMPOSE_SIZE_DEFAULT, COMPOSE_SIZE_MAX, COMPOSE_SIZE_MIN, DATE_FORMATS,
  composeSizePercent, convertCase, convertFullHalf, convertKana, formatDate, type CaseType, type FullHalfFlags,
} from './h2022-edit-convert';
import { composeAt, deleteCompose, insertCompose, setCompose, type ComposeTarget, type ComposeValue } from './h2022-edit-engine';
import { applyConversion, hostOf, readText, replaceRange, selectionPieces } from './h2022-edit-text';

function row(label: string, control: HTMLElement): HTMLDivElement {
  const r = document.createElement('div');
  r.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const l = document.createElement('label');
  l.textContent = label;
  l.style.cssText = 'min-width:84px;white-space:nowrap;';
  r.append(l, control);
  return r;
}

function textInput(value = '', width = 180): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = value;
  i.style.cssText = `width:${width}px;padding:4px 6px;`;
  return i;
}

function radios(name: string, items: ReadonlyArray<[string, string]>, value: string): { el: HTMLDivElement; get: () => string } {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  for (const [v, label] of items) {
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = name;
    r.value = v;
    r.checked = v === value;
    l.append(r, document.createTextNode(label));
    el.appendChild(l);
  }
  return { el, get: () => (el.querySelector('input:checked') as HTMLInputElement | null)?.value ?? value };
}

function bodyBox(): HTMLDivElement {
  const b = document.createElement('div');
  b.style.cssText = 'padding:14px 16px;display:flex;flex-direction:column;gap:10px;';
  return b;
}

/** 캐럿 자리(선택이 있으면 선택 시작) → 덧말·겹침 주소. 머리말·꼬리말·각주 안이면 null */
export function composeTargetAt(services: CommandServices): { target: ComposeTarget; selected: string; selection: { start: number; end: number } | null } | null {
  const ih = services.getInputHandler() as any;
  const cursor = ih?.cursor;
  if (!ih || !cursor) return null;
  if (cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return null;
  const sel = cursor.getSelectionOrdered?.() ?? null;
  const pos = sel ? sel.start : ih.getCursorPosition();
  const host = hostOf(pos);
  if (!host) return null;
  let selected = '';
  let selection: { start: number; end: number } | null = null;
  if (sel) {
    const other = hostOf(sel.end);
    const sameParagraph = other && other.sec === host.sec && other.para === host.para
      && JSON.stringify(other.cellPath ?? []) === JSON.stringify(host.cellPath ?? []);
    if (sameParagraph && sel.end.charOffset > sel.start.charOffset) {
      selection = { start: sel.start.charOffset, end: sel.end.charOffset };
      selected = readText(services.wasm as any, host, selection.start, selection.end - selection.start);
    }
  }
  return { target: { ...host, charOffset: pos.charOffset }, selected, selection };
}

// ───────── 덧말 넣기 (InsertDutmalDlg · DutmalChars) ─────────

/**
 * 한/글 덧말 넣기: 본말·덧말·덧말 위치(위/아래). 선택한 글이 있으면 본말이 되고 그 글이 덧말로 바뀐다.
 * 캐럿 자리에 덧말이 있으면 고치기 창(덧말 지움 단추 — 한/글 [덧말 지움]: 덧말만 지우고 본말은 글로 남김).
 * 덧말 스타일(Option·StyleNo)은 아직 고르지 않는다(원장).
 */
export class DutmalDialog extends ModalDialog {
  private main!: HTMLInputElement;
  private sub!: HTMLInputElement;
  private pos!: { get: () => string };

  constructor(private services: CommandServices, private at: NonNullable<ReturnType<typeof composeTargetAt>>, private existing: ComposeValue | null) {
    super(existing ? '덧말 고치기' : '덧말 넣기', 340);
  }

  protected createBody(): HTMLElement {
    const b = bodyBox();
    const e = this.existing;
    this.main = textInput(e?.mainText ?? this.at.selected);
    this.sub = textInput(e?.rubyText ?? '');
    b.append(row('본말', this.main), row('덧말', this.sub));
    const p = radios('h2022-dutmal-pos', [['top', '위'], ['bottom', '아래']], e?.below ? 'bottom' : 'top');
    this.pos = p;
    b.append(row('덧말 위치', p.el));
    if (e && e.ctrlIdx !== undefined) {
      const del = document.createElement('button');
      del.className = 'dialog-btn';
      del.textContent = '덧말 지움';
      del.title = '덧말만 지우고 본말은 글로 남깁니다';
      del.addEventListener('click', () => {
        const ok = applyThroughRouter({
          services: this.services, label: 'DutmalDialog', operationType: 'deleteDutmal',
          operation: (ih) => { deleteCompose(this.services.wasm, this.at.target, e.ctrlIdx!, true); return ih.getCursorPosition(); },
          fallback: () => { deleteCompose(this.services.wasm, this.at.target, e.ctrlIdx!, true); this.services.eventBus.emit('document-changed'); },
        });
        if (ok) this.hide();
      });
      b.appendChild(del);
    }
    return b;
  }

  show(): void { super.show(); setTimeout(() => (this.main.value ? this.sub : this.main).focus(), 30); }

  protected shouldConfirmOnEnter(): boolean { return true; }

  protected onConfirm(): boolean {
    const mainText = this.main.value;
    const rubyText = this.sub.value;
    if (!mainText.trim() || !rubyText.trim()) return false;
    const value = { mainText, rubyText, below: this.pos.get() === 'bottom', styleId: null };
    const wasm = this.services.wasm as any;
    const e = this.existing;
    const { target, selection } = this.at;
    const apply = () => {
      if (e && e.ctrlIdx !== undefined) {
        setCompose(wasm, target, e.ctrlIdx, value);
        return;
      }
      // 선택한 글은 덧말의 본말이 된다 — 글을 지우고 그 자리에 덧말을 넣는다(한/글 덧말 넣기)
      if (selection && this.at.selected === mainText) {
        replaceRange(wasm, target, selection.start, selection.end - selection.start, '');
        insertCompose(wasm, 'ruby', { ...target, charOffset: selection.start }, value);
      } else {
        insertCompose(wasm, 'ruby', target, value);
      }
    };
    return applyThroughRouter({
      services: this.services, label: 'DutmalDialog', operationType: e ? 'setDutmal' : 'insertDutmal',
      operation: (ih) => { apply(); return ih.getCursorPosition(); },
      fallback: () => { apply(); this.services.eventBus.emit('document-changed'); },
    });
  }
}

// ───────── 글자 겹치기 (ComposeCharsDlg · ComposeChars) ─────────

/**
 * 한/글 글자 겹치기: 겹쳐 쓸 글자(1~9자, 빈칸 제외), 겹치기 종류(모양 없음 = 글자끼리 겹치기 / 모양과 겹치기),
 * 모양, 글자 크기 조절, 모양 안에 글자 겹치기(겹치기/펼치기). 캐럿 자리에 겹침이 있으면 고치기.
 */
export class ComposeDialog extends ModalDialog {
  private chars!: HTMLInputElement;
  private shape!: HTMLSelectElement;
  private size!: HTMLSelectElement;
  private inside!: HTMLInputElement;

  constructor(private services: CommandServices, private at: NonNullable<ReturnType<typeof composeTargetAt>>, private existing: ComposeValue | null) {
    super(existing ? '글자 겹치기 고치기' : '글자 겹치기', 360);
  }

  protected createBody(): HTMLElement {
    const b = bodyBox();
    const e = this.existing;
    this.chars = textInput(e?.text ?? this.at.selected.replace(/\s+/g, '').slice(0, 9), 160);
    this.chars.maxLength = 9;
    b.appendChild(row('겹쳐 쓸 글자', this.chars));
    this.shape = document.createElement('select');
    for (const [v, label] of COMPOSE_SHAPES) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = label;
      this.shape.appendChild(o);
    }
    this.shape.value = String(e?.shape ?? 1);
    b.appendChild(row('모양', this.shape));
    this.size = document.createElement('select');
    for (let v = COMPOSE_SIZE_MIN; v <= COMPOSE_SIZE_MAX; v++) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = `${composeSizePercent(v)}%`;
      this.size.appendChild(o);
    }
    const cur = e?.innerSize ?? COMPOSE_SIZE_DEFAULT;
    if (cur < COMPOSE_SIZE_MIN || cur > COMPOSE_SIZE_MAX) {
      // 문서에 든 범위 밖 값(엔진은 -8~2 를 받는다)은 그대로 보이고 고르게 둔다
      const o = document.createElement('option');
      o.value = String(cur);
      o.textContent = `${composeSizePercent(cur)}% (문서 값)`;
      this.size.appendChild(o);
    }
    this.size.value = String(cur);
    b.appendChild(row('글자 크기 조절', this.size));
    const l = document.createElement('label');
    l.style.cssText = 'display:flex;gap:6px;align-items:center;';
    this.inside = document.createElement('input');
    this.inside.type = 'checkbox';
    this.inside.checked = e ? !!e.overlap : true;
    l.append(this.inside, document.createTextNode('모양 안에 글자 겹치기'));
    l.title = '끄면 글자를 모양 안에 나란히 펼칩니다';
    b.appendChild(l);
    return b;
  }

  show(): void { super.show(); setTimeout(() => this.chars.focus(), 30); }

  protected shouldConfirmOnEnter(): boolean { return true; }

  protected onConfirm(): boolean {
    const text = this.chars.value.replace(/\s+/g, '');
    if (!text || [...text].length > 9) return false;
    const value = { text, shape: Number(this.shape.value), innerSize: Number(this.size.value), overlap: this.inside.checked };
    const wasm = this.services.wasm as any;
    const e = this.existing;
    const { target, selection } = this.at;
    const apply = () => {
      if (e && e.ctrlIdx !== undefined) { setCompose(wasm, target, e.ctrlIdx, value); return; }
      if (selection && this.at.selected.replace(/\s+/g, '') === text) {
        replaceRange(wasm, target, selection.start, selection.end - selection.start, '');
        insertCompose(wasm, 'overlap', { ...target, charOffset: selection.start }, value);
      } else {
        insertCompose(wasm, 'overlap', target, value);
      }
    };
    return applyThroughRouter({
      services: this.services, label: 'ComposeDialog', operationType: e ? 'setCompose' : 'insertCompose',
      operation: (ih) => { apply(); return ih.getCursorPosition(); },
      fallback: () => { apply(); this.services.eventBus.emit('document-changed'); },
    });
  }
}

/** 캐럿 자리에 kind 의 덧말·겹침이 있으면 그 값 */
export function existingCompose(services: CommandServices, target: ComposeTarget, kind: 'ruby' | 'overlap'): ComposeValue | null {
  const v = composeAt(services.wasm, target);
  return v?.found && v.kind === kind ? v : null;
}

// ───────── 글자 바꾸기: 대문자/소문자, 전각/반각 ─────────

/** 선택 영역 글자를 fn 으로 바꾼다(문단마다 바뀐 구간만) → 바꾼 문단 수, 선택이 없거나 받지 않는 범위면 -1 */
export function convertSelection(services: CommandServices, label: string, fn: (s: string) => string): number {
  const ih = services.getInputHandler() as any;
  const cursor = ih?.cursor;
  const sel = cursor?.getSelectionOrdered?.();
  if (!ih || !sel || cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return -1;
  const wasm = services.wasm as any;
  const pieces = selectionPieces(sel.start, sel.end, wasm);
  if (!pieces) return -1;
  const plan = pieces.map((p) => {
    const before = readText(wasm, p.host, p.start, p.end - p.start);
    return { ...p, before, after: fn(before) };
  }).filter((p) => p.before !== p.after);
  if (!plan.length) return 0;
  const ok = applyThroughRouter({
    services, label, operationType: 'replaceText',
    operation: (h) => {
      // 뒤 문단부터(앞 문단 번호가 밀리지 않게 — 글 바꾸기는 문단 수를 바꾸지 않지만 차례를 지킨다)
      for (const p of [...plan].reverse()) applyConversion(wasm, p.host, p.start, p.before, p.after);
      return h.getCursorPosition();
    },
    fallback: () => {
      for (const p of [...plan].reverse()) applyConversion(wasm, p.host, p.start, p.before, p.after);
      services.eventBus.emit('document-changed');
    },
  });
  return ok ? plan.length : -1;
}

export class ConvertCaseDialog extends ModalDialog {
  private choice!: ReturnType<typeof radios>;
  private static last: CaseType = 0;
  constructor(private services: CommandServices) { super('대문자/소문자 바꾸기', 330); }
  protected createBody(): HTMLElement {
    const b = bodyBox();
    const items = (Object.keys(CASE_TYPE_LABELS) as unknown as CaseType[]).map((k) => [String(k), CASE_TYPE_LABELS[k]] as [string, string]);
    this.choice = radios('h2022-case', items, String(ConvertCaseDialog.last));
    b.appendChild(this.choice.el);
    return b;
  }
  protected onConfirm(): boolean {
    const type = Number(this.choice.get()) as CaseType;
    ConvertCaseDialog.last = type;
    return convertSelection(this.services, 'ConvertCaseDialog', (s) => convertCase(s, type)) >= 0;
  }
}

export class ConvertFullHalfDialog extends ModalDialog {
  private toFull!: ReturnType<typeof radios>;
  private boxes: Partial<Record<keyof FullHalfFlags, HTMLInputElement>> = {};
  private static last: { toFull: boolean; flags: FullHalfFlags } = { toFull: true, flags: { number: true, alpha: true, symbol: true, gata: true, jamo: true } };
  constructor(private services: CommandServices) { super('전각/반각 바꾸기', 330); }
  protected createBody(): HTMLElement {
    const b = bodyBox();
    const last = ConvertFullHalfDialog.last;
    this.toFull = radios('h2022-fullhalf', [['full', '전각으로'], ['half', '반각으로']], last.toFull ? 'full' : 'half');
    b.appendChild(row('바꿀 방향', this.toFull.el));
    const labels: Array<[keyof FullHalfFlags, string]> = [['number', '숫자'], ['alpha', '영문자'], ['symbol', '기호(빈칸 포함)'], ['gata', '가타카나'], ['jamo', '한글 자모']];
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 14px;';
    for (const [k, label] of labels) {
      const l = document.createElement('label');
      l.style.cssText = 'display:flex;gap:4px;align-items:center;';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = last.flags[k];
      this.boxes[k] = c;
      l.append(c, document.createTextNode(label));
      box.appendChild(l);
    }
    b.appendChild(row('바꿀 대상', box));
    return b;
  }
  protected onConfirm(): boolean {
    const toFull = this.toFull.get() === 'full';
    const flags = Object.fromEntries((Object.keys(this.boxes) as Array<keyof FullHalfFlags>).map((k) => [k, !!this.boxes[k]?.checked])) as unknown as FullHalfFlags;
    ConvertFullHalfDialog.last = { toFull, flags };
    return convertSelection(this.services, 'ConvertFullHalfDialog', (s) => convertFullHalf(s, toFull, flags)) >= 0;
  }
}

/** 일어 바꾸기(ConvertJapaneseDlg · ConvertHiraGata) — 히라가나 ↔ 가타카나 */
export class ConvertJapaneseDialog extends ModalDialog {
  private choice!: ReturnType<typeof radios>;
  private static last = 'kata';
  constructor(private services: CommandServices) { super('일어 바꾸기', 300); }
  protected createBody(): HTMLElement {
    const b = bodyBox();
    this.choice = radios('h2022-kana', [['kata', '가타카나로'], ['hira', '히라가나로']], ConvertJapaneseDialog.last);
    b.appendChild(this.choice.el);
    return b;
  }
  protected onConfirm(): boolean {
    const v = this.choice.get();
    ConvertJapaneseDialog.last = v;
    return convertSelection(this.services, 'ConvertJapaneseDialog', (s) => convertKana(s, v === 'kata')) >= 0;
  }
}

// ───────── 날짜/시간 형식 (DateTimeFormatDlg · InputDateStyle) ─────────

/** 한/글 기본 날짜 문자열 형식(실측: `2026년 11월 11일`). 형식 창에서 고르면 바뀐다(이 창이 열려 있는 동안의 세션 값). */
export const dateFormatState = { format: DATE_FORMATS[0] };

export class DateFormatDialog extends ModalDialog {
  private list!: HTMLSelectElement;
  private custom!: HTMLInputElement;
  private preview!: HTMLDivElement;
  constructor(private insert: (text: string) => void) { super('날짜/시간 형식', 360); }
  protected createBody(): HTMLElement {
    const b = bodyBox();
    const now = new Date();
    this.list = document.createElement('select');
    this.list.size = 8;
    this.list.style.width = '100%';
    for (const f of DATE_FORMATS) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = formatDate(now, f);
      this.list.appendChild(o);
    }
    this.list.value = DATE_FORMATS.includes(dateFormatState.format) ? dateFormatState.format : DATE_FORMATS[0];
    this.custom = textInput(dateFormatState.format, 200);
    this.custom.title = 'YYYY 해, M 달, D 날, dddd 요일, A 오전/오후, h·H 시, m 분, s 초';
    this.preview = document.createElement('div');
    this.preview.style.cssText = 'color:#555;';
    const sync = () => { this.preview.textContent = `넣을 글: ${formatDate(new Date(), this.custom.value || DATE_FORMATS[0])}`; };
    this.list.addEventListener('change', () => { this.custom.value = this.list.value; sync(); });
    this.custom.addEventListener('input', sync);
    sync();
    b.append(this.list, row('형식', this.custom), this.preview);
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#777;';
    note.textContent = '문자열로 넣습니다(날짜/시간 코드는 아직 넣지 않습니다).';
    b.appendChild(note);
    return b;
  }
  protected onConfirm(): boolean {
    const f = this.custom.value || DATE_FORMATS[0];
    dateFormatState.format = f;
    this.insert(formatDate(new Date(), f));
    return true;
  }
}
