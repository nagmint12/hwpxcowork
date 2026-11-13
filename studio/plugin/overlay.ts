// 강조 층(docs/V3_SPEC.md §1.3 '강조 층') — SelectionRenderer 방식으로 #scroll-content 안에 두 겹을 붙인다.
//  div.cowork-layer  (pointer-events:none, z-index 4): 메모·요청·제안·변경 추적 강조, 내 수정 막대, flash
//  div.cowork-marks  (z-index 8, 표식만 pointer-events:auto): 오른쪽 여백 원형 표식, 남의 수정 중 막대·이름표, 삭제 쐐기, 입력 중 표
// CanvasView.reset() 이 #scroll-content 를 비우면(문서 열기) 그릴 때 다시 붙인다(ensureAttached).
// 보이는 쪽만 그리고, 같은 열쇠의 요소는 다시 쓴다(스크롤마다 DOM 을 새로 만들지 않음).
import type { SelectionRect } from '@/core/types';
import type { ContentBox, Geometry } from './geometry';
import type { AnchorKind, Rect } from './types';
import { safeColor } from './util';

export type ItemKind = 'memo' | 'request' | 'proposal' | 'change' | 'draft' | 'mine' | 'editing' | 'flash';
export type MarkerKind = 'memo' | 'ai' | 'prop' | 'draft';

/** 그릴 것 하나(쪽 좌표). 컨트롤러가 주석·정렬에서 만들고, 문서·주석이 바뀔 때만 다시 만든다 */
export interface OverlayItem {
  key: string;
  kind: ItemKind;
  id: string;
  ref: string;
  /** 강조 사각형의 클래스(rects 용) */
  cls: string;
  /** 사람 색(--cw-person) */
  color?: string;
  rects: SelectionRect[];
  /** 문단 띠(왼쪽 여백 막대·이름표 자리) */
  band?: SelectionRect[];
  bandCls?: string;
  tag?: string;
  tagCls?: string;
  tip?: string;
  /** 점 표시(삭제 쐐기·지운 문단 자리) — 쪽 좌표 캐럿 */
  point?: { pageIndex: number; x: number; y: number; height: number };
  pointCls?: string;
  marker?: MarkerKind;
  anchor?: AnchorKind;
  cid?: number;
  hid?: string;
}

interface Spec {
  layer: 'hl' | 'mk';
  cls: string;
  box: ContentBox;
  color?: string;
  text?: string;
  tip?: string;
  kind: string;
  id: string;
  item?: OverlayItem;
  group?: OverlayItem[];
}

type ElWithSpec = HTMLDivElement & { __cw?: Spec; __sig?: string };

export interface OverlayHandlers {
  click(items: OverlayItem[], anchor: Rect): void;
}

export class Overlay {
  private layer: HTMLDivElement;
  private marks: HTMLDivElement;
  private els = new Map<string, ElWithSpec>();
  /** 마지막으로 그린 강조 상자(hover·click 판정용, #scroll-content 좌표) */
  private boxes: Array<{ item: OverlayItem; box: ContentBox }> = [];
  private tip: HTMLDivElement | null = null;
  private hidden = false;

  constructor(private readonly geo: Geometry, private readonly handlers: OverlayHandlers) {
    this.layer = document.createElement('div');
    this.layer.className = 'cowork-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.marks = document.createElement('div');
    this.marks.className = 'cowork-marks';
  }

  /** 레이어가 #scroll-content 에 없으면 다시 붙인다(CanvasView.reset 뒤) */
  ensureAttached(): boolean {
    const content = this.geo.content();
    if (!content) return false;
    if (this.layer.parentElement !== content) content.appendChild(this.layer);
    if (this.marks.parentElement !== content) content.appendChild(this.marks);
    return true;
  }

  /** 클릭할 수 있는 표식 층(여백 표식·수정 중 막대 등) 안의 요소인가 — 그 클릭은 표식이 직접 처리한다 */
  ownsMark(node: EventTarget | null): boolean {
    return node instanceof Node && this.marks.contains(node);
  }

  setHidden(h: boolean): void {
    this.hidden = h;
    this.layer.style.display = h ? 'none' : '';
    this.marks.style.display = h ? 'none' : '';
  }

  /** items 를 보이는 쪽(visible)에만 그린다. active = 레일 hover/active 와 맞춘 강조 */
  render(items: OverlayItem[], visible: Set<number>, active: { kind: string; id: string } | null): void {
    if (!this.ensureAttached()) return;
    const geo = this.geo; const z = geo.zoom();
    const want = new Map<string, Spec>();
    const boxes: Array<{ item: OverlayItem; box: ContentBox }> = [];
    const markerGroups = new Map<string, { page: number; top: number; height: number; items: OverlayItem[] }>();
    // 레일 카드와 맞춤: 같은 종류·id(요청 메모는 'memo' 로도), 남의 수정 중은 변경 요청 번호(cid)만 줘도 그 덩어리 전부
    const isActive = (it: OverlayItem) => !!active && (
      (active.id === it.id && (active.kind === it.kind || active.kind === it.anchor || (active.kind === 'memo' && it.kind === 'request')))
      || (it.kind === 'draft' && active.kind === 'draft' && active.id === String(it.cid)));

    for (const it of items) {
      const act = isActive(it) ? ' cw-active' : '';
      it.rects.forEach((r, k) => {
        if (!visible.has(r.pageIndex) || (r.width <= 0 && r.height <= 0)) return;
        const box = geo.toContent(r);
        want.set(`${it.key}|r${k}`, { layer: 'hl', cls: `cw-box ${it.cls}${act}`, box, color: it.color, kind: it.kind, id: it.id, item: it });
        if (it.kind !== 'flash' && it.kind !== 'mine') boxes.push({ item: it, box });
      });
      if (it.band?.length) {
        it.band.forEach((r, k) => {
          if (!visible.has(r.pageIndex)) return;
          const b = geo.toContent(r); const page = geo.pageBox(r.pageIndex);
          const ml = Math.max(14, (geo.pageInfo(r.pageIndex)?.marginLeft ?? 56) * z);
          const mine = it.kind === 'mine';
          const barW = mine ? 3 : 4;
          const barLeft = page.left + Math.max(2, ml - (mine ? 9 : 16));
          const barBox = { left: barLeft, top: b.top, width: barW, height: Math.max(4, b.height) };
          if (it.bandCls !== '') {
            want.set(`${it.key}|b${k}`, { layer: mine ? 'hl' : 'mk', cls: `${it.bandCls ?? 'cw-bar'}${act}`, box: barBox, color: it.color, tip: it.tip, kind: it.kind, id: it.id, item: it });
            if (!mine) boxes.push({ item: it, box: { left: barLeft - 2, top: b.top, width: barW + 4, height: barBox.height } });
          }
          if (k === 0 && it.tag) {
            const right = barLeft - 3; const left = page.left + 2;
            want.set(`${it.key}|t`, { layer: 'mk', cls: `${it.tagCls ?? 'cw-tag'}${act}`, box: { left, top: b.top, width: Math.max(0, right - left), height: 16 }, color: it.color, text: it.tag, tip: it.tip, kind: it.kind, id: it.id, item: it });
          }
        });
      }
      if (it.point && visible.has(it.point.pageIndex)) {
        const p = geo.toContent({ pageIndex: it.point.pageIndex, x: it.point.x, y: it.point.y, width: 0, height: it.point.height });
        if (it.kind === 'mine') {
          const page = geo.pageBox(it.point.pageIndex);
          const ml = Math.max(14, (geo.pageInfo(it.point.pageIndex)?.marginLeft ?? 56) * z);
          want.set(`${it.key}|p`, { layer: 'hl', cls: it.pointCls ?? 'cw-mine-del', box: { left: page.left + Math.max(2, ml - 12), top: p.top - 4, width: 8, height: 8 }, kind: it.kind, id: it.id, item: it });
        } else {
          want.set(`${it.key}|p`, { layer: 'mk', cls: `${it.pointCls ?? 'cw-wedge'}${act}`, box: { left: p.left - 4, top: p.top - 3, width: 8, height: 7 }, tip: it.tip, kind: it.kind, id: it.id, item: it });
        }
      }
      if (it.marker) {
        const r = it.rects[0] ?? it.band?.[0] ?? (it.point ? { pageIndex: it.point.pageIndex, x: it.point.x, y: it.point.y, width: 0, height: it.point.height } : null);
        if (r && visible.has(r.pageIndex)) {
          const top = geo.toContent(r).top; const h = r.height * z;
          const gk = `${r.pageIndex}:${Math.round((top + h / 2) / 14)}`;
          const g = markerGroups.get(gk) ?? { page: r.pageIndex, top, height: h, items: [] };
          g.items.push(it); markerGroups.set(gk, g);
        }
      }
    }
    // 오른쪽 여백 원형 표식: 같은 줄이면 하나로(숫자)
    for (const [gk, g] of markerGroups) {
      const page = geo.pageBox(g.page); const pi = geo.pageInfo(g.page);
      const mr = (pi?.marginRight ?? 56) * z;
      const cx = page.left + page.width - Math.max(10, Math.min(mr / 2, 40));
      const first = g.items[0];
      const kinds = new Set(g.items.map((x) => x.marker));
      const cls = `cw-mark cw-mark-${kinds.size === 1 ? first.marker : 'mixed'}${g.items.some(isActive) ? ' cw-active' : ''}`;
      const tip = g.items.map((x) => x.tip || x.tag || x.id).filter(Boolean).join('\n');
      want.set(`mark|${gk}`, {
        layer: 'mk', cls, box: { left: cx - 8, top: g.top + g.height / 2 - 8, width: 16, height: 16 },
        color: kinds.size === 1 && first.marker === 'draft' ? first.color : undefined,
        text: g.items.length > 1 ? String(g.items.length) : '', tip, kind: first.kind, id: first.id, item: first, group: g.items,
      });
    }

    for (const [key, spec] of want) this.apply(key, spec);
    for (const [key, el] of this.els) if (!want.has(key)) { el.remove(); this.els.delete(key); }
    this.boxes = boxes;
  }

  private apply(key: string, spec: Spec): void {
    let el = this.els.get(key);
    if (!el) {
      el = document.createElement('div') as ElWithSpec;
      if (spec.layer === 'mk') this.wire(el);
      (spec.layer === 'hl' ? this.layer : this.marks).appendChild(el);
      this.els.set(key, el);
    } else if ((spec.layer === 'hl') !== (el.parentElement === this.layer)) {
      (spec.layer === 'hl' ? this.layer : this.marks).appendChild(el);
    }
    el.__cw = spec;
    const b = spec.box;
    const sig = `${spec.cls}|${b.left.toFixed(2)},${b.top.toFixed(2)},${b.width.toFixed(2)},${b.height.toFixed(2)}|${spec.color ?? ''}|${spec.text ?? ''}|${spec.tip ?? ''}`;
    if (el.__sig === sig) return;
    el.__sig = sig;
    el.className = spec.cls;
    el.style.left = `${b.left.toFixed(2)}px`;
    el.style.top = `${b.top.toFixed(2)}px`;
    el.style.width = `${Math.max(0, b.width).toFixed(2)}px`;
    el.style.height = `${Math.max(0, b.height).toFixed(2)}px`;
    if (spec.color) el.style.setProperty('--cw-person', safeColor(spec.color, '#1c7ed6')); else el.style.removeProperty('--cw-person');
    el.dataset.cwKind = spec.kind;
    el.dataset.cwId = spec.id;
    if (spec.text !== undefined) el.textContent = spec.text; else if (el.firstChild) el.textContent = '';
  }

  /** 클릭할 수 있는 표식: mousedown 이 편집기로 가지 않게(캐럿이 움직이지 않게), 클릭 → annotation-click, hover → 미리보기 */
  private wire(el: ElWithSpec): void {
    el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const s = el.__cw; if (!s?.item) return;
      const r = el.getBoundingClientRect();
      try { this.handlers.click(s.group ?? [s.item], { x: r.left, y: r.top, w: r.width, h: r.height }); } catch (err) { console.warn('[cowork] 표식 클릭', err); }
    });
    el.addEventListener('mouseenter', () => { const t = el.__cw?.tip; if (t) this.showTip(el, t); });
    el.addEventListener('mouseleave', () => this.hideTip());
  }

  private showTip(el: HTMLElement, text: string): void {
    if (!this.tip) {
      this.tip = document.createElement('div');
      this.tip.className = 'cw-tip';
      document.body.appendChild(this.tip);
    }
    this.tip.textContent = text;
    this.tip.style.display = 'block';
    const r = el.getBoundingClientRect(); const tw = this.tip.offsetWidth; const th = this.tip.offsetHeight;
    let x = r.right + 6; let y = r.top - 2;
    if (x + tw > innerWidth - 4) x = Math.max(4, r.left - tw - 6);
    if (y + th > innerHeight - 4) y = Math.max(4, innerHeight - th - 4);
    this.tip.style.left = `${x}px`; this.tip.style.top = `${y}px`;
  }

  hideTip(): void { if (this.tip) this.tip.style.display = 'none'; }

  /** iframe client 좌표에 걸린 강조(가장 작은 것) */
  hitTest(clientX: number, clientY: number): { item: OverlayItem; box: ContentBox } | null {
    if (this.hidden) return null;
    const content = this.geo.content(); if (!content) return null;
    const o = content.getBoundingClientRect();
    const x = clientX - o.left; const y = clientY - o.top;
    let best: { item: OverlayItem; box: ContentBox } | null = null;
    for (const b of this.boxes) {
      const bx = b.box;
      if (x >= bx.left - 1 && x <= bx.left + bx.width + 1 && y >= bx.top - 1 && y <= bx.top + bx.height + 1) {
        if (!best || bx.width * bx.height < best.box.width * best.box.height) best = b;
      }
    }
    return best;
  }

  /** 그린 요소들(시험용 debug.overlays) — iframe client 좌표 */
  snapshot(): Array<{ kind: string; id: string; cls: string; rect: Rect; text: string }> {
    const out: Array<{ kind: string; id: string; cls: string; rect: Rect; text: string }> = [];
    for (const el of this.els.values()) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      out.push({ kind: el.dataset.cwKind ?? '', id: el.dataset.cwId ?? '', cls: el.className, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, text: el.textContent ?? '' });
    }
    return out;
  }

  clear(): void {
    for (const el of this.els.values()) el.remove();
    this.els.clear();
    this.boxes = [];
    this.hideTip();
  }

  dispose(): void {
    this.clear();
    this.layer.remove();
    this.marks.remove();
    this.tip?.remove();
    this.tip = null;
  }
}
