/**
 * [hwpx-cowork] 한/글 2022 '한자로 바꾸기'(F9 · ConvertHanjaDlg)·'한글로 바꾸기'(Alt+F9 · ConvertKoreanDlg) 창 — 글자 단위(2026-11-12).
 * 규칙·자료·한/글과 다른 점은 `h2022-hanja.ts` 머리 주석과 원장. 바꾸기는 편집 라우터(snapshot)로 — 서버는 글 바꿈으로 받아 문서 설정대로 변경 추적한다.
 */
import { ModalDialog } from './dialog';
import { applyThroughRouter } from './dialog-apply';
import type { CommandServices } from '@/command/types';
import { HANJA_FORMAT_LABELS, formatHanja, hanjaCandidates, hanjaToHangul, isHangulSyllable, type HanjaEntry, type HanjaFormat, type HanjaTable } from './h2022-hanja';
import { hostOf, readText, replaceRange, type TextHost } from './h2022-edit-text';
import { convertSelection } from './h2022-edit-dialogs';

interface Spot { offset: number; syllable: string }

/** F9 대상: 선택(한 문단 안)의 한글 음절들, 선택이 없으면 캐럿 바로 앞 음절. 머리말·각주 안이면 null */
export function hanjaTargets(services: CommandServices, t: HanjaTable): { host: TextHost; spots: Spot[] } | null {
  const ih = services.getInputHandler() as any;
  const cursor = ih?.cursor;
  if (!ih || !cursor || cursor.isInHeaderFooter?.() || cursor.isInFootnote?.()) return null;
  const wasm = services.wasm as any;
  const sel = cursor.getSelectionOrdered?.() ?? null;
  const pos = sel ? sel.start : ih.getCursorPosition();
  const host = hostOf(pos);
  if (!host) return null;
  let start: number;
  let end: number;
  if (sel) {
    const other = hostOf(sel.end);
    if (!other || other.sec !== host.sec || other.para !== host.para || JSON.stringify(other.cellPath ?? []) !== JSON.stringify(host.cellPath ?? [])) return null;
    start = sel.start.charOffset; end = sel.end.charOffset;
  } else {
    start = Math.max(0, pos.charOffset - 1); end = pos.charOffset;
  }
  const text = readText(wasm, host, start, end - start);
  const spots: Spot[] = [];
  [...text].forEach((ch, i) => { if (isHangulSyllable(ch) && hanjaCandidates(t, ch).length) spots.push({ offset: start + i, syllable: ch }); });
  return { host, spots };
}

export class HanjaDialog extends ModalDialog {
  private static format: HanjaFormat = 'hanja';
  private index = 0;
  /** 앞에서 바꾼 글 때문에 밀린 글자 수 */
  private shift = 0;
  private label!: HTMLDivElement;
  private grid!: HTMLDivElement;
  private picked: HanjaEntry | null = null;

  constructor(private services: CommandServices, private table: HanjaTable, private host: TextHost, private spots: Spot[]) {
    super('한자로 바꾸기', 380);
  }

  protected createBody(): HTMLElement {
    const b = document.createElement('div');
    b.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:10px;';
    this.label = document.createElement('div');
    this.grid = document.createElement('div');
    this.grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:220px;overflow:auto;';
    const formats = document.createElement('div');
    formats.style.cssText = 'display:flex;gap:12px;align-items:center;';
    formats.append(document.createTextNode('입력 형식'));
    for (const f of Object.keys(HANJA_FORMAT_LABELS) as HanjaFormat[]) {
      const l = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = 'h2022-hanja-format'; r.checked = HanjaDialog.format === f;
      r.addEventListener('change', () => { if (r.checked) HanjaDialog.format = f; });
      l.append(r, document.createTextNode(HANJA_FORMAT_LABELS[f]));
      formats.appendChild(l);
    }
    const skip = document.createElement('button');
    skip.className = 'dialog-btn';
    skip.textContent = '지나가기';
    skip.addEventListener('click', () => this.next());
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#777;';
    note.textContent = '글자 단위로 바꿉니다(낱말 사전 없음). 후보 차례는 본음·KS 한자 먼저.';
    b.append(this.label, this.grid, formats, skip, note);
    this.render();
    return b;
  }

  private render(): void {
    const spot = this.spots[this.index];
    if (!spot) return;
    this.label.textContent = `바꿀 글자: ${spot.syllable}  (${this.index + 1}/${this.spots.length})`;
    this.grid.textContent = '';
    const list = hanjaCandidates(this.table, spot.syllable);
    this.picked = list[0] ?? null;
    for (const e of list) {
      const btn = document.createElement('button');
      btn.className = 'dialog-btn';
      btn.style.cssText = 'font-size:20px;padding:2px 0;min-width:0;';
      btn.textContent = e.c;
      btn.title = `${e.readings.map((r) => r.r).join('·')}${e.edu ? ' · 교육용' : ''}${e.name ? ' · 인명용' : ''}${e.ks ? '' : ' · KS 밖'}`;
      btn.addEventListener('click', () => { this.picked = e; this.grid.querySelectorAll('button').forEach((x) => (x as HTMLElement).style.outline = ''); btn.style.outline = '2px solid #36c'; });
      btn.addEventListener('dblclick', () => { this.picked = e; this.replace(); });
      this.grid.appendChild(btn);
    }
    (this.grid.firstElementChild as HTMLElement | null)?.style.setProperty('outline', '2px solid #36c');
  }

  private next(): void {
    this.index++;
    if (this.index >= this.spots.length) { this.hide(); return; }
    this.render();
  }

  private replace(): void {
    const spot = this.spots[this.index];
    if (!spot || !this.picked) return;
    const text = formatHanja(this.picked.c, spot.syllable, HanjaDialog.format);
    const at = spot.offset + this.shift;
    const wasm = this.services.wasm as any;
    const ok = applyThroughRouter({
      services: this.services, label: 'HanjaDialog', operationType: 'replaceText',
      operation: (ih) => { replaceRange(wasm, this.host, at, 1, text); return ih.getCursorPosition(); },
      fallback: () => { replaceRange(wasm, this.host, at, 1, text); this.services.eventBus.emit('document-changed'); },
    });
    if (!ok) return;
    this.shift += [...text].length - 1;
    this.next();
  }

  /** [바꾸기] — 대화상자는 다음 글자로 넘어가며 열려 있다(마지막 글자 뒤에 닫힘) */
  protected onConfirm(): boolean {
    this.replace();
    return false;
  }
}

/** 한글로 바꾸기(Alt+F9): 漢字를 한글로 / 漢字를 漢字(한글)로 — 한/글 메뉴 이름표(Hwp.String.ko-KR.dll) 그대로 */
export class ConvertKoreanDialog extends ModalDialog {
  private static last: 'hangul' | 'hanjaHangul' = 'hangul';
  private radios: HTMLInputElement[] = [];
  constructor(private services: CommandServices, private table: HanjaTable) { super('한글로 바꾸기', 320); }
  protected createBody(): HTMLElement {
    const b = document.createElement('div');
    b.style.cssText = 'padding:14px 16px;display:flex;flex-direction:column;gap:6px;';
    for (const [v, label] of [['hangul', '漢字를 한글로'], ['hanjaHangul', '漢字를 漢字(한글)로']] as const) {
      const l = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = 'h2022-korean'; r.value = v; r.checked = ConvertKoreanDialog.last === v;
      this.radios.push(r);
      l.append(r, document.createTextNode(label));
      b.appendChild(l);
    }
    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px;color:#777;';
    note.textContent = '블록의 한자를 두음 법칙을 고려하여 글자 단위로 바꿉니다(낱말 사전 없음 — 음이 여럿인 한자는 본음).';
    b.appendChild(note);
    return b;
  }
  protected onConfirm(): boolean {
    const v = (this.radios.find((r) => r.checked)?.value ?? 'hangul') as 'hangul' | 'hanjaHangul';
    ConvertKoreanDialog.last = v;
    return convertSelection(this.services, 'ConvertKoreanDialog', (s) => hanjaToHangul(this.table, s, v)) >= 0;
  }
}
