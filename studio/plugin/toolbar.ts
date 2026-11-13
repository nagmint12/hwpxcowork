// 미니 도구 막대(docs/V3_SPEC.md §1.3, 옵션 기본 켬): 마우스로 선택을 끝내면 선택 위에 [AI에게 맡기기] [AI에게 빠르게 맡기기 ▾] | [메모].
// [AI에게 빠르게 맡기기 ▾] = 검토하기 · 문장 고쳐 쓰기 · (구분선) · 다듬기 기준 — 누르면 예시 지시를 넣은 요청(action quick, id — 지시 글은
// 호스트가 menumodel quickPrompt 로). 바로 보낼 때(옵션 quickSend — 'Claude Code로 보내기' 등)는 목록 맨 위에 그 보낼 곳 머리글을 두고
// 항목에 cw-send(AI 보라 — docs/UI_TERMS.md §4)를 붙인다. 비면(확인 후 보내기) 표시 없음. 우클릭 'AI에게 빠르게 맡기기 ▸'와 같은 이름·순서.
// 타이핑·바깥 누르기·선택 해제 때 숨긴다. 누르면 menu-action(source 'toolbar').
// mousedown 을 막아 편집기 선택·포커스를 그대로 둔다(studio 도구 막대 #780 과 같은 이유).
import type { CoworkSelection } from './types';
import { safe } from './util';

export interface ToolbarDeps {
  /** 빠르게 맡기기 목록(menumodel quickTasks — { sep } 는 구분선) */
  quickTasks(): Array<{ id?: string; label?: string; sep?: boolean }>;
  /** 바로 보낼 때 보낼 곳 이름표, 확인 후 보내기면 '' */
  quickSend(): string;
  act(action: { type: string; id?: string }, target: CoworkSelection): void;
}

export class MiniToolbar {
  private el: HTMLDivElement | null = null;
  private drop: HTMLDivElement | null = null;
  private target: CoworkSelection | null = null;

  constructor(private readonly deps: ToolbarDeps) {}

  get visible(): boolean { return !!this.el && this.el.style.display !== 'none'; }

  contains(node: EventTarget | null): boolean {
    return node instanceof Node && (!!this.el?.contains(node) || !!this.drop?.contains(node));
  }

  show(sel: CoworkSelection): void {
    if (!sel.rect) return;
    this.target = sel;
    if (!this.el) this.build();
    const el = this.el!;
    el.style.display = 'flex';
    this.closeDrop();
    this.place(sel);
  }

  /** 스크롤 뒤 같은 선택 자리로(선택 사각형이 바뀌었으면 새 값으로) */
  reposition(sel: CoworkSelection | null): void {
    if (!this.visible) return;
    if (!sel || sel.collapsed || !sel.rect) { this.hide(); return; }
    this.target = sel; this.place(sel);
  }

  private place(sel: CoworkSelection): void {
    const el = this.el!; const r = sel.rect!;
    const w = el.offsetWidth || 260; const h = el.offsetHeight || 30;
    let top = r.y - h - 8;
    if (top < 4) top = r.y + r.h + 8;
    const left = Math.max(4, Math.min(innerWidth - w - 4, r.x));
    el.style.left = `${Math.round(left)}px`; el.style.top = `${Math.round(Math.min(innerHeight - h - 4, top))}px`;
  }

  hide(): void {
    if (this.el) this.el.style.display = 'none';
    this.closeDrop();
    this.target = null;
  }

  private build(): void {
    const el = document.createElement('div');
    el.className = 'cw-mini';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', '검토 도구');
    const btn = (label: string, action: string, title?: string) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.dataset.coworkAction = action; if (title) b.title = title;
      return b;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'cw-mini-sep'; return s; };
    el.append(btn('AI에게 맡기기', 'instruct', '원하는 작업을 적어 AI에게 맡깁니다(비우면 검토)'), btn('AI에게 빠르게 맡기기 ▾', 'quick', '예시 지시로 바로 맡기기 — 검토·문장 고쳐 쓰기·다듬기'), sep(), btn('메모', 'memo', '메모 달기'));
    el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = (e.target as HTMLElement | null)?.closest('button') as HTMLButtonElement | null;
      if (!b || !this.target) return;
      const a = b.dataset.coworkAction ?? '';
      if (a === 'quick') { this.toggleDrop(b); return; }
      const t = this.target; this.hide();
      safe('toolbar', () => this.deps.act({ type: a }, t));
    });
    el.style.display = 'none';
    document.body.appendChild(el);
    this.el = el;
  }

  private toggleDrop(anchor: HTMLButtonElement): void {
    if (this.drop) { this.closeDrop(); return; }
    const d = document.createElement('div');
    d.className = 'cw-mini-drop';
    d.setAttribute('role', 'menu');
    const to = this.deps.quickSend();
    if (to) { const h = document.createElement('div'); h.className = 'cw-mini-head'; h.textContent = to; d.appendChild(h); }
    for (const q of this.deps.quickTasks()) {
      if (q.sep) { const line = document.createElement('div'); line.className = 'cw-mini-line'; d.appendChild(line); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = q.label ?? ''; b.dataset.coworkAction = 'quick'; b.dataset.coworkQuick = q.id ?? '';
      if (to) b.classList.add('cw-send');
      d.appendChild(b);
    }
    d.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    d.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = (e.target as HTMLElement | null)?.closest('button') as HTMLButtonElement | null;
      if (!b || !this.target) return;
      const t = this.target; const id = b.dataset.coworkQuick ?? '';
      this.hide();
      safe('toolbar', () => this.deps.act({ type: 'quick', id }, t));
    });
    document.body.appendChild(d);
    const r = anchor.getBoundingClientRect();
    d.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - d.offsetWidth - 4, r.left)))}px`;
    const below = r.bottom + 4; d.style.top = `${Math.round(below + d.offsetHeight > innerHeight - 4 ? r.top - d.offsetHeight - 4 : below)}px`;
    anchor.classList.add('cw-on');
    this.drop = d;
  }

  private closeDrop(): void {
    this.drop?.remove(); this.drop = null;
    this.el?.querySelectorAll('.cw-on').forEach((b) => b.classList.remove('cw-on'));
  }

  dispose(): void { this.closeDrop(); this.el?.remove(); this.el = null; }
}
