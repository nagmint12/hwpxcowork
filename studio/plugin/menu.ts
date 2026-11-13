// 우클릭 '검토' 구역(docs/V3_SPEC.md §1.3) — context-menu-hook 패치가 studio ContextMenu.show() 에서 메뉴를 화면에 붙이기 직전에
// __rhwpCoworkMenuHook(menu, hide) 를 부른다. 그 전에 플러그인은 #scroll-container 의 contextmenu 를 capture 로 먼저 받아
// 누른 자리(hit → 기준 ref/offset)와 지금 선택을 기록해 둔다(onContextMenuCapture). 구역의 항목은 web/menumodel.js 의
// reviewMenuModel() 이 만든 동작 서술이고, 여기서는 studio 의 .md-item/.md-sep/.md-sub 모양으로 그리기만 한다.
// 키보드: 메뉴가 열린 동안 ↑/↓(항목), →/Enter(하위 메뉴 열기), ←/Esc(하위 메뉴 닫기), Enter(실행). studio 원래 항목도 같이 돈다.
import type { Rect, CoworkSelection } from './types';
import { safe } from './util';

/** web/menumodel.js 의 MenuEntry(JSON 동작 서술) */
export interface MenuEntry {
  id: string;
  kind: 'header' | 'item' | 'sep' | 'sub';
  label?: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 누르면 AI 에게 바로 보낸다(AI 빠른 작업 — 바로 보내기) → cw-send(AI 보라, docs/UI_TERMS.md §4) */
  send?: boolean;
  action?: { type: string; [k: string]: unknown };
  sub?: MenuEntry[];
}

export interface MenuContext {
  entries: MenuEntry[];
  target: CoworkSelection | null;
  anchor: Rect;
}

export interface MenuDeps {
  /** 누른 자리(client 좌표, 없으면 지금 캐럿)의 메뉴 문맥. 넣지 않을 때(그림·표 개체·머리말 편집 중 등)는 null */
  contextAt(clientX: number | null, clientY: number | null): MenuContext | null;
  act(action: NonNullable<MenuEntry['action']>, ctx: MenuContext): void;
}

/**
 * 읽기 전용(V4 §2.5 — 수정 권한 없음)에서 숨길 동작: 문서를 정하는 것(반영·거절 — 서버도 403). 메모(보기·답글·해결)·AI 요청·보기는 남긴다.
 */
export const READONLY_HIDDEN_ACTIONS = new Set(['proposal-adopt', 'proposal-reject', 'request-adopt-all']);

/**
 * 읽기 전용 메뉴: READONLY_HIDDEN_ACTIONS 항목을 빼고(하위 메뉴 안까지), 비게 된 하위 메뉴를 빼고, 구분선이 겹치거나 머리글 바로 뒤에
 * 오지 않게 한다(맨 끝 구분선 — studio 원래 항목과의 경계 — 은 그대로). 머리글('검토')만 남으면 빈 목록(구역을 넣지 않음).
 */
export function readOnlyEntries(entries: MenuEntry[]): MenuEntry[] {
  const keep = (list: MenuEntry[], top: boolean): MenuEntry[] => {
    const out: MenuEntry[] = [];
    for (const e of list) {
      if (e.kind === 'item' && e.action && READONLY_HIDDEN_ACTIONS.has(e.action.type)) continue;
      if (e.kind === 'sub') {
        const sub = keep(e.sub ?? [], false);
        if (!sub.some((x) => x.kind === 'item' || x.kind === 'sub')) continue;
        out.push({ ...e, sub });
        continue;
      }
      if (e.kind === 'sep' && (!out.length || out[out.length - 1].kind === 'sep' || out[out.length - 1].kind === 'header')) continue;
      out.push(e);
    }
    if (!top) while (out.length && out[out.length - 1].kind === 'sep') out.pop();
    return out;
  };
  const out = keep(entries, true);
  return out.some((x) => x.kind === 'item' || x.kind === 'sub') ? out : [];
}

const ICONS: Record<string, string> = {
  review: '◎', suggest: '☰', polish: '✧', instruct: '➤', attach: '⎘', fill: '▦', para: '¶', table: '▤', memo: '✎',
  proposal: '◆', draft: '✎', ai: '✦', check: '✓', x: '✕', rail: '↗', diff: '⇄', comment: '❝', show: '◉', reply: '↩', reopen: '↺',
};

interface SubState { row: HTMLElement; panel: HTMLElement; items: HTMLElement[]; index: number }
interface NavState { menu: HTMLElement; hide: () => void; rows: HTMLElement[]; index: number; sub: SubState | null; closeTimer: ReturnType<typeof setTimeout> | null }

const PENDING_MS = 1500;

export class ReviewMenu {
  private pending: { at: number; ctx: MenuContext | null } | null = null;
  private nav: NavState | null = null;

  constructor(private readonly deps: MenuDeps) {}

  /** #scroll-container contextmenu(capture): studio 처리기보다 먼저 자리·선택을 기록 */
  onContextMenuCapture(e: MouseEvent): void {
    this.pending = { at: performance.now(), ctx: safe('메뉴 문맥', () => this.deps.contextAt(e.clientX, e.clientY), null) ?? null };
  }

  /** __rhwpCoworkMenuHook 본체 — 메뉴(아직 문서에 붙기 전)에 구역을 맨 위에 끼운다 */
  hook(menu: HTMLElement, hide: () => void): void {
    try {
      const p = this.pending; this.pending = null;
      const ctx = p && performance.now() - p.at < PENDING_MS ? p.ctx : this.deps.contextAt(null, null);
      this.nav = null;
      if (!ctx || !ctx.entries.length) return;
      const close = () => { this.reset(); hide(); };
      const frag = document.createDocumentFragment();
      for (const e of ctx.entries) { const el = this.renderEntry(e, ctx, close); if (el) frag.appendChild(el); }
      // 좁은 화면에서도 전체 선택이 숨지 않도록 기본 명령 하나를 검토 구역 위에 둔다.
      const selectAll = menu.querySelector('[data-cmd="edit:select-all"]');
      menu.insertBefore(frag, selectAll?.nextSibling || menu.firstChild);
      menu.classList.add('cw-has-review');
      menu.setAttribute('role', 'menu');
      this.nav = { menu, hide: close, rows: [], index: -1, sub: null, closeTimer: null };
      this.nav.rows = this.collectRows(menu);
    } catch (e) {
      console.warn('[cowork] 우클릭 구역을 넣지 못했습니다:', e);
    }
  }

  isOpen(): boolean {
    if (this.nav && !this.nav.menu.isConnected) this.reset();
    return !!this.nav;
  }

  /** 열린 메뉴를 닫는다 — 맞추기(syncToBase)로 문서·기준이 바뀌면 메뉴가 기억한 대상(기준 ref·offset)이 낡는다 */
  close(): void { if (this.isOpen()) this.nav?.hide(); }

  private reset(): void {
    if (this.nav?.closeTimer) clearTimeout(this.nav.closeTimer);
    this.nav = null;
  }

  private collectRows(menu: HTMLElement): HTMLElement[] {
    return [...menu.children].filter((el): el is HTMLElement => el instanceof HTMLElement
      && (el.classList.contains('md-item') || el.classList.contains('cw-sub')) && !el.classList.contains('disabled'));
  }

  private renderEntry(e: MenuEntry, ctx: MenuContext, close: () => void): HTMLElement | null {
    if (e.kind === 'sep') { const d = document.createElement('div'); d.className = 'md-sep'; d.dataset.coworkSep = e.id; return d; }
    if (e.kind === 'header') {
      const d = document.createElement('div'); d.className = 'cw-menu-head'; d.textContent = e.label ?? ''; d.dataset.coworkHead = e.id; d.setAttribute('role', 'presentation');
      return d;
    }
    const row = document.createElement('div');
    row.className = e.kind === 'sub' ? 'md-sub cw-sub cw-row' : 'md-item cw-row';
    if (e.disabled) row.classList.add('disabled');
    if (e.send) row.classList.add('cw-send');
    row.setAttribute('role', 'menuitem');
    const ico = document.createElement('span'); ico.className = 'cw-ico'; ico.textContent = ICONS[e.icon ?? ''] ?? ''; row.appendChild(ico);
    const label = document.createElement('span'); label.className = 'md-label'; label.textContent = e.label ?? ''; row.appendChild(label);
    if (e.hint) { const h = document.createElement('span'); h.className = 'md-shortcut'; h.textContent = e.hint; row.appendChild(h); }
    if (e.kind === 'sub') {
      row.dataset.coworkSub = e.id;
      row.setAttribute('aria-haspopup', 'menu');
      const arrow = document.createElement('span'); arrow.className = 'md-arrow'; arrow.textContent = '▶'; row.appendChild(arrow);
      const panel = document.createElement('div'); panel.className = 'cw-sub-panel'; panel.setAttribute('role', 'menu');
      for (const s of e.sub ?? []) { const el = this.renderEntry(s, ctx, close); if (el) panel.appendChild(el); }
      row.appendChild(panel);
      row.addEventListener('mouseenter', () => { this.cancelClose(); this.openSub(row, false); this.highlightRow(row); });
      row.addEventListener('mouseleave', () => this.scheduleClose(row));
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (ev.target instanceof Node && panel.contains(ev.target)) return;
        if (this.nav?.sub?.row === row) this.closeSub(); else this.openSub(row, false);
      });
      return row;
    }
    row.dataset.coworkAction = e.action?.type ?? '';
    row.dataset.coworkId = e.id;
    row.addEventListener('mouseenter', () => {
      // 위층 항목에 올라가면 열린 하위 메뉴를 닫고, 하위 메뉴 안 항목이면 그 안에서 강조
      const inPanel = row.parentElement?.classList.contains('cw-sub-panel');
      if (!inPanel) { this.closeSub(); this.highlightRow(row); } else if (this.nav?.sub) { this.nav.sub.index = this.nav.sub.items.indexOf(row); this.paintSub(); }
    });
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (row.classList.contains('disabled') || !e.action) return;
      close();
      safe('menu-action', () => this.deps.act(e.action!, ctx));
    });
    return row;
  }

  // ───────── 하위 메뉴 ─────────

  private openSub(row: HTMLElement, focusFirst: boolean): void {
    const nav = this.nav; if (!nav) return;
    if (nav.sub?.row === row) { if (focusFirst && nav.sub.index < 0) { nav.sub.index = 0; this.paintSub(); } return; }
    this.closeSub();
    const panel = row.querySelector(':scope > .cw-sub-panel') as HTMLElement | null;
    if (!panel || row.classList.contains('disabled')) return;
    row.classList.add('cw-open');
    // 메뉴가 넘치면 스크롤하므로(position:fixed 라 잘리지 않는다) 화면 자리를 직접 잡는다
    const r = row.getBoundingClientRect();
    panel.style.left = `${Math.round(r.right - 2)}px`; panel.style.top = `${Math.round(r.top - 4)}px`;
    const pw = panel.offsetWidth; const ph = panel.offsetHeight;
    if (r.right - 2 + pw > innerWidth - 2) panel.style.left = `${Math.max(2, Math.round(r.left - pw + 2))}px`;
    if (r.top - 4 + ph > innerHeight - 2) panel.style.top = `${Math.max(2, Math.round(innerHeight - ph - 2))}px`;
    const items = [...panel.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('md-item') && !el.classList.contains('disabled'));
    nav.sub = { row, panel, items, index: focusFirst ? 0 : -1 };
    this.paintSub();
  }

  private closeSub(): void {
    const nav = this.nav; if (!nav?.sub) return;
    nav.sub.row.classList.remove('cw-open');
    for (const it of nav.sub.items) it.classList.remove('cw-kb');
    nav.sub = null;
  }

  private scheduleClose(row: HTMLElement): void {
    const nav = this.nav; if (!nav) return;
    this.cancelClose();
    nav.closeTimer = setTimeout(() => { if (this.nav?.sub?.row === row) this.closeSub(); }, 220);
  }

  private cancelClose(): void { if (this.nav?.closeTimer) { clearTimeout(this.nav.closeTimer); this.nav.closeTimer = null; } }

  private paintSub(): void {
    const s = this.nav?.sub; if (!s) return;
    s.items.forEach((it, k) => it.classList.toggle('cw-kb', k === s.index));
  }

  private highlightRow(row: HTMLElement): void {
    const nav = this.nav; if (!nav) return;
    const k = nav.rows.indexOf(row);
    if (k >= 0) { nav.index = k; this.paint(); }
  }

  private paint(): void {
    const nav = this.nav; if (!nav) return;
    nav.rows.forEach((r, k) => r.classList.toggle('cw-kb', k === nav.index));
    const cur = nav.rows[nav.index];
    if (cur) safe('scroll', () => cur.scrollIntoView({ block: 'nearest' }));
  }

  // ───────── 키보드 ─────────

  /** 메뉴가 열린 동안의 keydown(window capture). 메뉴가 받은 키면 true(편집기로 가지 않게 막았음) */
  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.isOpen()) return false;
    const nav = this.nav!;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const n = nav.rows.length;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        stop();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        if (nav.sub && nav.sub.index >= 0) {
          const m = nav.sub.items.length; if (!m) return true;
          nav.sub.index = (nav.sub.index + d + m) % m; this.paintSub(); return true;
        }
        if (!n) return true;
        this.closeSub();
        nav.index = nav.index < 0 ? (d > 0 ? 0 : n - 1) : (nav.index + d + n) % n;
        this.paint();
        return true;
      }
      case 'ArrowRight': {
        stop();
        const row = nav.rows[nav.index];
        if (row?.classList.contains('cw-sub')) this.openSub(row, true);
        return true;
      }
      case 'ArrowLeft': {
        stop();
        if (nav.sub) { const row = nav.sub.row; this.closeSub(); this.highlightRow(row); }
        return true;
      }
      case 'Enter': {
        stop();
        if (nav.sub && nav.sub.index >= 0) { nav.sub.items[nav.sub.index]?.click(); return true; }
        const row = nav.rows[nav.index];
        if (!row) return true;
        if (row.classList.contains('cw-sub')) this.openSub(row, true);
        else row.click();
        return true;
      }
      case 'Escape': {
        stop();
        if (nav.sub) { const row = nav.sub.row; this.closeSub(); this.highlightRow(row); return true; }
        // 메뉴는 여기서 닫고 키는 막는다 — studio 의 Esc 처리기는 메뉴만 닫고 키를 흘려보내, 표 칸 안이면
        // 편집기가 Esc 를 받아 표 개체 선택으로 바뀐다(선택이 사라짐)
        nav.hide();
        return true;
      }
      default:
        return false;
    }
  }
}
