// cowork 플러그인 본체(docs/V3_SPEC.md §1.3): CommandServices 확보, 메뉴바 항목, window.rhwpCowork API, 이벤트,
// 우클릭 '검토' 구역, 강조 층, 미니 도구 막대, 내 수정본에 반영(트랜잭션 1개 = 되돌리기 1번).
// 규칙: studio 이벤트 처리기 안에서 던지지 않는다(safe), 호스트와는 JSON 으로만 주고받는다, 키 입력마다 무거운 일을 하지 않는다
// (정렬·강조 다시 계산은 쉼 240ms, 내 수정 표시는 쉼 600ms, 선택 이벤트는 120ms throttle).
// 연속 입력 중에는 강제 만료로 전체 문서를 읽지 않는다. 선택·입력 중 표시는 같은 정렬 결과를 재사용한다.
//
// 강조 그리기는 두 단계다(큰 문서에서도 가볍게):
//  1) 서술(ItemSpec): 주석·내 수정 → 편집기 자리(문단·offset) + 문단 범위. 정렬(align)만 쓰므로 싸다 — 주석·문서가 바뀔 때만 다시.
//  2) 풀기(resolve): 보이는 쪽에 걸칠 수 있는 서술만 쪽 사각형(getSelectionRects*)을 구한다(문단마다 1~5ms). 어느 쪽인지는
//     getPageOfPosition(쪽 나누기 결과를 읽기만 함)으로 거른다. 푼 것은 자리 열쇠로 기억하고 쪽 배치가 바뀔 때만 비운다.
//
// 내 수정본에 반영(applyText·insertParagraphAfter·applyBatch — §1.3·§9.6)도 두 단계다: ① 자리 찾기(planText·planInsert — 편집 전 문서,
// 정렬로 기준 ref → 편집기 자리) ② 고치기(commit → runEdit, 트랜잭션 하나 = studio 되돌리기 한 번). 하나짜리와 여러 건이 같은 코드를 쓴다.
//
// v0.4(docs/V4_SPEC.md §2.5): 실시간 공동 편집 — syncToBase(편집기 글을 setBase 로 준 기준 글로 맞춤: align.syncPlan → 트랜잭션 'cowork:sync'
// 하나 → 되돌리기 기록 비움 · 캐럿/선택/스크롤 그대로 · 'edited' 없음), setOptions({ readOnly })(studio 양식 모드), flash(남이 바꾼 자리 밑줄).
import type { PluginHost, Tx } from '@/plugin/types';
import type { CommandServices } from '@/command/types';
import type { InputHandler } from '@/engine/input-handler';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentPosition, SelectionRect } from '@/core/types';
import { reviewMenuModel, quickTasks, DEFAULT_PRESETS } from '@cowork/web/menumodel.js';
import { paragraphGeo, covers, findRange } from '@cowork/web/annotations.js';
import { projectTextFormats } from '@cowork/engine/format-projection.js';
import { requireCharShapeRunsDocument, parseCharShapeRuns } from '@/core/char-shape-runs';
import {
  Alignment, toCurOffset, toCurEnd, toBaseOffset, sameText,
  type CurPara, type Located, type SyncEdit, type SyncFail, type SyncIssue, type SyncPlan,
} from './align';
import { Geometry, type CurPoint } from './geometry';
import { Overlay, type OverlayItem } from './overlay';
import { ReviewMenu, readOnlyEntries, type MenuContext, type MenuEntry } from './menu';
import { MiniToolbar } from './toolbar';
import { installTouchSelection } from './touch-selection';
import { installMobileRuler } from './mobile-view';
import { injectStyle, removeStyle } from './style';
import * as internals from './internals';
import {
  Emitter, cpLen, cpSlice, cps, debounce, throttle, rafBatch, nextFrame, sleep, safe, jsonCopy, toHost,
} from './util';
import {
  PLUGIN_VERSION, PLUGIN_FEATURES, EVENT_NAMES, BATCH_MAX,
  type Annotations, type Anchor, type ApplyResult, type BatchItem, type BatchItemReason, type BatchItemResult, type BatchKey, type BatchResult,
  type CoworkOptions, type CoworkSelection, type DraftHunkAnn, type DraftState, type EngineParagraph, type FlashOptions, type InsertArgs, type MemoAnn,
  type Range, type Rect, type SyncResult, type TextArgs,
} from './types';

type Geo = ReturnType<typeof paragraphGeo>;
type Action = NonNullable<MenuEntry['action']>;
type CaretPoint = { pageIndex: number; x: number; y: number; height: number };

/** 그릴 것의 자리(편집기 자리 — 쪽 사각형은 보이는 쪽 근처에서만 푼다) */
type Geom =
  | { t: 'range'; a: CurPoint; b: CurPoint; len: number }    // 글 범위(빈 범위면 캐럿 자리 가는 막대). len = 시작 문단 지금 글 길이
  | { t: 'band'; p: CurPara; len: number; first?: boolean }   // 문단 띠(왼쪽 여백 막대·이름표). first = 첫 조각만
  | { t: 'caret'; p: CurPoint; len: number }                 // 점(삭제 쐐기)
  | { t: 'after'; p: CurPara; len: number }                  // 문단 끝 아래 줄(문단 추가·표 제안)
  | { t: 'gap'; sec: number; after: number; len: number };   // 지운 문단 자리(그 앞 편집기 문단 아래, 맨 앞이면 첫 문단 위)
type ItemBase = Omit<OverlayItem, 'rects' | 'band' | 'point'>;
/** 그릴 것 하나의 서술: 무엇(item)·어디(geom, 열쇠 gk)·어느 본문 문단 범위(sec, from..to — 보이는 쪽 거르기용) */
interface ItemSpec { item: ItemBase; geom: Geom; gk: string; sec: number; from: number; to: number }
/** 푼 자리(쪽 좌표) */
interface Resolved { rects: SelectionRect[]; band?: SelectionRect[]; point?: CaretPoint }

/** 내 수정본에 고칠 것 하나(편집 전 문서로 찾은 편집기 자리) — 글 바꾸기: 지금 문단 [s, e) 를 text 로 */
interface TextEdit { op: 'text'; cur: CurPara; s: number; e: number; text: string }
/**
 * 문단 뒤에 넣기: cur 문단 뒤에 lines(줄마다 문단 하나). len = cur 문단 길이(나눌 자리), count = 그 구역 문단 수(본문만),
 * objectOnly = 표·그림만 있는 본문 문단(끝에서 나누면 개체가 따라갈 수 있어 다음 문단 앞을 나눈다)
 */
interface InsertEdit { op: 'insert'; cur: CurPara; lines: string[]; len: number; objectOnly: boolean; count: number }
type Edit = TextEdit | InsertEdit;
type Doc = ReturnType<Tx['doc']>;

const emptyAnnotations = (): Annotations => ({ memos: [], proposals: [], changes: [], drafts: [], editing: [], flash: null });
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const clip = (s: string, n = 40): string => { const a = cps(s); return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };
/** 메뉴 동작 → 요청 종류(Composer 의 kind) */
const REQUEST_KIND: Record<string, string> = { quick: 'instruct', review: 'review', suggest: 'suggest', polish: 'polish', instruct: 'instruct', attach: 'instruct', fill_table: 'fill_table', make_table: 'make_table', insert: 'insert' };
const FLASH_MS = 1600;
/** 남이 바꾼 자리 밑줄 깜빡임(flash — V4 §2.4-5) 시간 */
const REMOTE_FLASH_MS = 1500;
/** 푼 자리 기억 상한(넘으면 비움 — 쪽 배치가 바뀌지 않은 채 주석만 수없이 바뀌는 경우) */
const GEOM_CACHE_MAX = 20000;

export class CoworkController {
  private services: CommandServices | null = null;
  readonly emitter = new Emitter();
  readonly align: Alignment;
  readonly geo: Geometry;
  private overlay: Overlay;
  private menu: ReviewMenu;
  private toolbar: MiniToolbar;
  private ann: Annotations = emptyAnnotations();
  private options: CoworkOptions = { overlays: true, miniToolbar: true, showResolved: false, readOnly: false };
  private active: { kind: string; id: string } | null = null;
  private baseGeo: Geo = paragraphGeo([]);
  private changeSeq = 0;
  private cleanSeq = 0;
  /** 그릴 것의 서술(쪽 사각형 없음) — 주석·정렬·내 수정·옵션이 바뀔 때만 다시 만든다(싸다) */
  private specs: ItemSpec[] | null = null;
  /** 자리 열쇠 → 푼 쪽 사각형(못 그리면 null) — 쪽 배치가 바뀌면(문서 수정·다시 조판) 비운다 */
  private geomCache = new Map<string, Resolved | null>();
  /** 마지막으로 그린 것(보이는 쪽) — 정렬을 다시 하기 전 스크롤 동안 anchors 를 이것으로 낸다 */
  private lastList: OverlayItem[] = [];
  private flash: { rects: SelectionRect[]; until: number } | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** 남이 바꾼 자리 밑줄(flash — 여럿이 겹쳐도 각자 시간) */
  private rflashes: Array<{ key: string; rects: SelectionRect[]; color?: string; until: number }> = [];
  private rflashSeq = 0;
  private rflashTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 맞추기(syncToBase) 트랜잭션 중 — 그 사이 오는 document-mutated 는 사용자 편집이 아니다: changeSeq 를 올리지 않고 'edited'·'editing' 을
   * 내지 않는다(호스트가 자동 저장·밀어 넣기를 예약하지 않게). studio 는 트랜잭션 안에서(afterEdit) 이 알림을 동기로 낸다.
   */
  private syncing = false;
  private viewReady = false;
  private readyGen = -1;
  private readyResolve: () => void = () => {};
  readonly ready: Promise<void>;
  private lastSelJson = '';
  private lastAnchorsJson = '';
  private lastEditingRef: string | null = null;
  /** 사용자 편집 뒤 아직 보내지 않은 입력 중 알림. 정렬이 준비될 때 한 번 보낸다. */
  private editingRequested = false;
  private hoverKey = '';
  private hoverPoint: { x: number; y: number } | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private disposers: Array<() => void> = [];
  private disposed = false;
  readonly perf = {
    relayouts: 0, lastRelayoutMs: 0, lastBuildMs: 0, lastRenderMs: 0, lastDraftMs: 0, lastSelectionMs: 0,
    specs: 0, candidates: 0, resolvedTotal: 0,
    /** 마지막 syncToBase(계획 + 트랜잭션 + 되살리기) 시간·그중 계획·트랜잭션 시간·고친 편집 수 */
    syncs: 0, lastSyncMs: 0, lastSyncPlanMs: 0, lastSyncTxMs: 0, lastSyncEdits: 0,
  };
  /** 플러그인 코드가 쓴 시간(처리기·타이머 합) — debug.stats() 로 타이핑 지연 중 플러그인 몫을 잰다 */
  readonly busy: { ms: number; calls: number; byLabel: Record<string, { ms: number; n: number }> } = { ms: 0, calls: 0, byLabel: {} };

  private layoutTimer = debounce(() => this.timed('relayout', () => this.relayout()), 240);
  private draftTimer = debounce(() => this.timed('draft', () => this.emitDraft()), 600);
  private selTimer = throttle(() => this.timed('selection', () => this.emitSelection()), 120);
  private editingTimer = throttle(() => this.timed('editing', () => this.emitEditing()), 1000);
  private editingIdle = debounce(() => this.emitEditingIdle(), 15000);
  private renderRaf = rafBatch(() => this.timed('render', () => this.renderNow()));
  private hoverRaf = rafBatch(() => this.timed('hover', () => this.updateHover()));
  private toolbarRaf = rafBatch(() => {
    if (this.toolbar.visible && !this.layoutTimer.pending()) this.timed('toolbar', () => this.toolbar.reposition(this.computeSelection()));
  });

  /** 시간을 재며 부른다(던지지 않음) */
  private timed<T>(label: string, fn: () => T): T | undefined {
    const t0 = performance.now();
    try { return fn(); } catch (e) { console.warn(`[cowork] ${label}:`, e); return undefined; } finally {
      const dt = performance.now() - t0;
      this.busy.ms += dt; this.busy.calls++;
      const b = (this.busy.byLabel[label] ??= { ms: 0, n: 0 }); b.ms += dt; b.n++;
    }
  }

  constructor(private readonly host: PluginHost) {
    this.ready = new Promise<void>((r) => { this.readyResolve = r; });
    this.align = new Alignment(() => this.services?.wasm ?? null);
    this.geo = new Geometry(() => this.services);
    this.overlay = new Overlay(this.geo, { click: (items, anchor) => this.onMarkerClick(items, anchor) });
    this.menu = new ReviewMenu({ contextAt: (x, y) => this.menuContextAt(x, y), act: (a, ctx) => this.emitMenuAction(a, ctx.target, ctx.anchor, 'context-menu') });
    this.toolbar = new MiniToolbar({ quickTasks: () => quickTasks(this.presets()), quickSend: () => this.options.quickSend ?? '', act: (a, t) => this.emitMenuAction(a, t, t.rect ?? { x: 0, y: 0, w: 0, h: 0 }, 'toolbar') });
  }

  // ───────── 수명 ─────────

  activate(): void {
    const h = this.host;
    // 부트스트랩: ext: 커맨드의 execute 가 받는 CommandServices(eventBus·wasm·getInputHandler·getViewportManager …)를 잡는다
    h.automation.registerCommand({ id: 'ext:cowork.bootstrap', label: 'cowork', execute: (s) => { this.services = s; } });
    const r = h.automation.execute('ext:cowork.bootstrap');
    if (!this.services) throw new Error(`cowork: CommandServices 를 받지 못했습니다(${r.ok ? '' : r.reason})`);

    // 메뉴바 항목(공식 addMenuItem): 입력 → 메모 달기, 도구 → AI에게 맡기기…·검토 패널 열기
    // (도구 항목은 우클릭 'AI에게 맡기기…'와 같은 요청 창을 연다 — 이름도 같게, 2026-11-17 docs/UI_TERMS.md §3. 명령 id·동작 'review' 는 그대로)
    const cmd = (id: `ext:${string}`, label: string, action: string) => h.automation.registerCommand({
      id, label, canExecute: (ctx) => ctx.hasDocument, execute: () => { safe('메뉴바', () => this.menubarAction(action)); },
    });
    cmd('ext:cowork.memo', '메모 달기', 'memo');
    cmd('ext:cowork.ai-review', 'AI에게 맡기기…', 'review');
    cmd('ext:cowork.panel', '검토 패널 열기', 'panel');
    safe('메뉴바 항목', () => {
      h.automation.addMenuItem({ menuId: 'insert', commandId: 'ext:cowork.memo' });
      h.automation.addMenuItem({ menuId: 'tool', commandId: 'ext:cowork.ai-review' });
      h.automation.addMenuItem({ menuId: 'tool', commandId: 'ext:cowork.panel' });
    });

    injectStyle();
    const mobileRuler = installMobileRuler();
    this.disposers.push(() => mobileRuler.dispose());
    h.automation.registerCommand({ id: 'ext:cowork.mobile-ruler', label: '모바일 눈금자 켜기/끄기', execute: () => mobileRuler.toggle() });
    h.automation.addMenuItem({ menuId: 'view', commandId: 'ext:cowork.mobile-ruler' });

    // studio 이벤트(구독은 호스트 원장이 unload 때 걷는다)
    const on = (name: string, fn: (p?: unknown, detail?: unknown) => void) => h.events.on(name, (p, detail?: unknown) => { if (!this.disposed) this.timed(`ev:${name}`, () => fn(p, detail)); });
    on('document-view-loaded', () => this.onViewLoaded());
    on('document-mutated', (reason, detail) => this.onMutated(String(reason ?? ''), detail));
    on('document-layout-refreshed', () => this.onLayout());
    on('document-page-invalidated', () => this.onLayout());
    on('document-view-changed', () => this.onLayout());
    on('zoom-changed', () => this.onViewport());
    on('viewport-resize', () => this.onViewport());
    on('viewport-scroll', () => this.onScroll());
    on('cursor-rect-updated', () => this.selTimer());
    on('picture-object-selection-changed', () => this.selTimer());
    on('table-object-selection-changed', () => this.selTimer());
    on('headerFooterModeChanged', () => { this.toolbar.hide(); this.selTimer(); });
    // 읽기 전용이면 양식 모드를 지킨다(보기 메뉴 '양식 모드' 등으로 풀어도 다시) — 맞추기의 잠깐 normal 은 InputHandler 만 바꿔 이 알림이 없다
    on('edit-mode-changed', (mode) => { if (this.options.readOnly && mode !== 'form') this.applyEditMode(); });
    h.onDocumentSwap(() => { if (!this.disposed) safe('문서 교체', () => this.onSwap()); });

    this.installDom();
    (globalThis as unknown as { __rhwpCoworkMenuHook?: unknown }).__rhwpCoworkMenuHook = this.menuHook;
    (window as unknown as { rhwpCowork?: unknown }).rhwpCowork = this.buildApi();

    // 이미 문서가 떠 있으면(문서를 연 뒤에 플러그인을 올림) 바로 준비
    if (this.geo.ready()) queueMicrotask(() => safe('준비', () => this.onViewLoaded()));
  }

  deactivate(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [this.layoutTimer, this.draftTimer, this.selTimer, this.editingTimer, this.editingIdle, this.renderRaf, this.hoverRaf, this.toolbarRaf]) t.cancel();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.rflashTimer) clearTimeout(this.rflashTimer);
    for (const off of this.disposers.splice(0)) safe('정리', off);
    const g = globalThis as unknown as { __rhwpCoworkMenuHook?: unknown };
    if (g.__rhwpCoworkMenuHook === this.menuHook) delete g.__rhwpCoworkMenuHook;
    const w = window as unknown as { rhwpCowork?: unknown };
    delete w.rhwpCowork;
    this.overlay.dispose();
    this.toolbar.dispose();
    removeStyle();
    this.emitter.clear();
  }

  private readonly menuHook = (menu: HTMLElement, hide: () => void): void => {
    if (!this.disposed) this.menu.hook(menu, hide);
  };

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): void {
    const wrapped = (e: Event) => { if (!this.disposed) this.timed(`dom:${type}`, () => fn(e)); };
    target.addEventListener(type, wrapped, opts);
    this.disposers.push(() => target.removeEventListener(type, wrapped, opts));
  }

  private installDom(): void {
    const touchContainer = this.geo.container();
    if (touchContainer) this.disposers.push(installTouchSelection(touchContainer));
    const inScroll = (t: EventTarget | null) => t instanceof Node && !!this.geo.container()?.contains(t);
    // 우클릭: studio 처리기(#scroll-container, bubble)보다 먼저(capture) 누른 자리·선택을 기록
    this.listen(document, 'contextmenu', (e) => { if (inScroll(e.target)) { this.toolbar.hide(); this.menu.onContextMenuCapture(e as MouseEvent); } }, true);
    this.listen(window, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent), true);
    this.listen(document, 'mousedown', (e) => {
      const me = e as MouseEvent;
      if (!this.toolbar.contains(me.target)) this.toolbar.hide();
      this.pointerDown = me.button === 0 && inScroll(me.target) ? { x: me.clientX, y: me.clientY } : null;
    }, true);
    this.listen(document, 'mouseup', (e) => this.onMouseUp(e as MouseEvent));
    this.listen(document, 'mousemove', (e) => {
      const me = e as MouseEvent;
      if (!inScroll(me.target)) { if (this.hoverPoint) { this.hoverPoint = null; this.hoverRaf(); } return; }
      this.hoverPoint = { x: me.clientX, y: me.clientY }; this.hoverRaf();
    }, { passive: true });
    this.listen(document, 'mouseleave', () => { this.hoverPoint = null; this.hoverRaf(); });
  }

  private ih(): InputHandler | null { return this.services?.getInputHandler() ?? null; }

  // ───────── studio 이벤트 ─────────

  /** 그릴 것의 서술을 다시 만들게(주석·정렬·내 수정·옵션이 바뀜). 푼 쪽 사각형은 자리 열쇠라 그대로 쓴다 */
  private invalidateItems(): void { this.specs = null; }
  /** 쪽 배치가 바뀜(쪽 사각형·문단의 쪽 다시) */
  private invalidateGeometry(): void { this.geomCache.clear(); this.geo.invalidate(); }

  private onViewLoaded(): void {
    if (!this.geo.ready()) return;
    this.viewReady = true;
    this.align.invalidate(); this.invalidateItems(); this.invalidateGeometry();
    this.overlay.ensureAttached();
    const gen = this.host.currentGeneration();
    if (gen !== this.readyGen) {
      this.readyGen = gen;
      this.emitter.emit('ready', {});
      this.readyResolve();
    }
    this.renderRaf();
    this.draftTimer();
  }

  private onSwap(): void {
    this.viewReady = false;
    this.align.invalidate(); this.invalidateItems(); this.invalidateGeometry();
    this.align.resetBaseline();
    this.flash = null; this.rflashes = []; this.lastList = [];
    this.editingRequested = false;
    this.overlay.clear(); this.toolbar.hide();
    this.cleanSeq = this.changeSeq;
    this.lastSelJson = ''; this.lastAnchorsJson = '';
  }

  private onMutated(reason: string, detail?: unknown): void {
    // 미뤄 둔 쪽 나누기가 끝났다는 알림은 새 편집이 아니다(그 편집의 알림은 이미 왔다) — 배치만 다시
    if (reason === 'input-handler-resumable-pagination') { this.onLayout(); return; }
    if (this.syncing) {
      // 맞추기(syncToBase)가 고친 것 — 사용자 편집이 아니다: changeSeq·'edited'(호스트 자동 저장·밀어 넣기)·'editing'(남에게 '입력 중')을
      // 내지 않는다. 정렬·강조·내 수정 표시만 다시(syncToBase 가 끝나면 깨끗함으로 둔다)
      this.align.invalidate(); this.invalidateItems(); this.invalidateGeometry();
      this.layoutTimer(); this.draftTimer(); this.selTimer();
      return;
    }
    this.changeSeq++;
    this.emitter.emit('edited', { changeSeq: this.changeSeq });
    const hint = detail as { kind?: unknown; position?: DocumentPosition } | undefined;
    const point = hint?.kind === 'text' ? this.geo.fromPosition(hint.position) : null;
    if (point && !point.approx) this.align.invalidateText(point);
    else this.align.invalidate();
    this.invalidateItems(); this.invalidateGeometry();
    this.toolbar.hide();
    this.layoutTimer();
    this.draftTimer();
    this.editingRequested = true;
    this.editingTimer();
    this.editingIdle();
    this.selTimer();
  }

  private onLayout(): void {
    this.invalidateGeometry();
    this.layoutTimer();
  }

  private onViewport(): void { this.renderRaf(); if (this.toolbar.visible) this.toolbarRaf(); }
  private onScroll(): void { this.renderRaf(); if (this.toolbar.visible) this.toolbarRaf(); }

  /** 문서가 바뀐 뒤(쉼): 정렬·강조 다시 계산 */
  private relayout(): void {
    const t0 = performance.now();
    this.renderNow();
    this.perf.relayouts++; this.perf.lastRelayoutMs = performance.now() - t0;
    // 입력 이벤트에서는 선택·입력 중 표시가 정렬을 강제로 읽지 않는다. 강조와 같은 판의 결과로 보낸다.
    this.selTimer();
    if (this.editingRequested) this.editingTimer();
  }

  // ───────── 그리기 ─────────

  private renderNow(): void {
    if (this.disposed || !this.viewReady || !this.geo.ready()) return;
    // 문서가 바뀐 뒤 정렬·배치를 다시 계산하는 일이 곧 온다(layoutTimer) — 그 사이 스크롤 등으로 다시 만들지 않는다.
    // 강조 층은 #scroll-content 안에 있어 스크롤해도 글과 같이 움직인다. 레일 자리(anchors)만 지난번 것으로 따라간다.
    if (this.layoutTimer.pending()) { this.emitAnchors(this.lastList); return; }
    const t0 = performance.now();
    const pages = this.geo.visiblePages();
    const list = this.visibleItems(pages);
    if (this.flash) {
      if (Date.now() < this.flash.until) list.push({ key: 'flash', kind: 'flash', id: 'flash', ref: '', cls: 'cw-flash', rects: this.flash.rects });
      else this.flash = null;
    }
    if (this.rflashes.length) {
      const now = Date.now();
      this.rflashes = this.rflashes.filter((f) => f.until > now);
      for (const f of this.rflashes) list.push({ key: f.key, kind: 'flash', id: 'remote', ref: '', cls: 'cw-rflash', color: f.color, rects: f.rects });
    }
    this.overlay.setHidden(!this.options.overlays);
    if (this.options.overlays) this.overlay.render(list, new Set(pages), this.active);
    this.lastList = list;
    this.perf.lastRenderMs = performance.now() - t0;
    this.emitAnchors(list);
  }

  private ensureSpecs(): ItemSpec[] {
    if (!this.specs) {
      const t0 = performance.now();
      this.specs = safe('강조 서술', () => this.buildSpecs(), []) ?? [];
      this.perf.lastBuildMs = performance.now() - t0;
      this.perf.specs = this.specs.length;
    }
    return this.specs;
  }

  /** 보이는 쪽에 걸칠 수 있는 서술만 쪽 사각형을 풀어 돌려준다 */
  private visibleItems(pages: number[]): OverlayItem[] {
    const specs = this.ensureSpecs();
    const out: OverlayItem[] = [];
    if (!pages.length || !specs.length) return out;
    let lo = Infinity; let hi = -Infinity;
    for (const p of pages) { if (p < lo) lo = p; if (p > hi) hi = p; }
    let n = 0;
    for (const s of specs) {
      const [p0, p1] = this.specPages(s);
      if (p1 < lo || p0 > hi) continue;
      n++;
      const it = this.resolve(s);
      if (it) out.push(it);
    }
    this.perf.candidates = n;
    return out;
  }

  /**
   * 서술이 걸칠 수 있는 쪽 범위(넉넉히): 첫 문단이 시작하는 쪽 ~ 끝 문단 다음 문단이 시작하는 쪽
   * (구역 끝이면 다음 구역 첫 쪽, 모르면 마지막 쪽). 쪽을 모르면 늘 후보.
   */
  private specPages(s: ItemSpec): [number, number] {
    const p0 = this.geo.paragraphPage(s.sec, s.from);
    if (p0 < 0) return [0, Number.MAX_SAFE_INTEGER];
    let p1 = s.to + 1 < this.align.paragraphCount(s.sec) ? this.geo.paragraphPage(s.sec, s.to + 1) : -1;
    if (p1 < 0) {
      const next = s.sec + 1 < this.align.sectionCount() ? this.geo.paragraphPage(s.sec + 1, 0) : -1;
      p1 = next >= 0 ? next : this.geo.pageCount() - 1;
    }
    return [p0, Math.max(p0, p1)];
  }

  private resolve(s: ItemSpec): OverlayItem | null {
    let r = this.geomCache.get(s.gk);
    if (r === undefined) {
      if (this.geomCache.size >= GEOM_CACHE_MAX) this.geomCache.clear();
      r = safe('강조 자리', () => this.resolveGeom(s.geom), null) ?? null;
      this.geomCache.set(s.gk, r);
      this.perf.resolvedTotal++;
    }
    if (!r) return null;
    return { ...s.item, rects: r.rects, band: r.band, point: r.point };
  }

  /** 편집기 자리 → 쪽 사각형 */
  private resolveGeom(g: Geom): Resolved | null {
    switch (g.t) {
      case 'range': {
        if (!(samePara(g.a, g.b) && g.b.offset <= g.a.offset)) {
          const rs = this.geo.rangeRects(g.a, g.b);
          if (rs.length) return { rects: rs };
        }
        // 빈 범위(지운 자리에 단 메모 등)거나 사각형이 없으면 캐럿 자리에 가는 막대
        const c = this.geo.caretRect(g.a, g.len);
        return c ? { rects: [{ pageIndex: c.pageIndex, x: c.x - 1, y: c.y, width: 3, height: c.height }] } : null;
      }
      case 'band': {
        const band = this.geo.paragraphBand(g.p, g.len);
        return band.length ? { rects: [], band: g.first ? band.slice(0, 1) : band } : null;
      }
      case 'caret': {
        const c = this.geo.caretRect(g.p, g.len);
        return c ? { rects: [], point: c } : null;
      }
      case 'after': {
        const band = this.geo.paragraphBand(g.p, g.len);
        const last = band[band.length - 1];
        return last ? { rects: [{ pageIndex: last.pageIndex, x: last.x, y: last.y + last.height - 1, width: Math.max(24, last.width), height: 3 }] } : null;
      }
      case 'gap': {
        const band = this.geo.paragraphBand({ sec: g.sec, para: Math.max(0, g.after) }, g.len);
        const r = g.after >= 0 ? band[band.length - 1] : band[0];
        return r ? { rects: [], point: { pageIndex: r.pageIndex, x: r.x, y: g.after >= 0 ? r.y + r.height : r.y, height: 0 } } : null;
      }
      default:
        return null;
    }
  }

  /** 주석·내 수정 → 그릴 것의 서술(편집기 자리). 쪽 사각형은 구하지 않는다 */
  private buildSpecs(): ItemSpec[] {
    const out: ItemSpec[] = [];
    if (!this.align.ensure()) return out;
    const add = (item: ItemBase, geom: Geom | null): void => { if (geom) out.push(makeSpec(item, geom)); };
    const ann = this.ann;
    const pending = new Set(ann.proposals.filter((p) => p.status === 'pending').map((p) => Number(p.pid)));
    for (const m of ann.memos) {
      if (m.resolved && !this.options.showResolved) continue;
      // 대기 중인 제안의 메모는 제안이 그린다(같은 자리를 두 번 칠하지 않게)
      if (m.kind === 'proposal' && pending.has(Number(/#(\d+)/.exec(m.label || '')?.[1]))) continue;
      const request = m.kind === 'request';
      // AI 작업은 진행 단계 강조(응답 대기 붉은 톤 · 처리 중 보라 움직임 · 내 차례 테두리 — style.ts cw-ph-…)
      const phase = request && m.phase && /^[a-z]+$/.test(m.phase) ? ` cw-ph-${m.phase}` : '';
      const cls = request ? `cw-request${phase}` : m.kind === 'comment' || m.kind === 'review' ? `cw-${m.kind}` : 'cw-memo';
      add({
        key: `memo:${m.id}`, kind: request ? 'request' : 'memo', id: String(m.id), ref: m.ref,
        cls: `${cls}${m.resolved ? ' cw-resolved' : ''}`, color: m.color, marker: request ? 'ai' : 'memo', anchor: request ? 'request' : 'memo',
        tip: `${m.kind === 'memo' || !m.kind ? `메모 · ${m.author}` : `${m.label}${m.author ? ` · ${m.author}` : ''}`}${m.resolved ? ' · 완료' : ''}`,
      }, this.rangeGeom(this.memoSpan(m)));
    }
    for (const p of ann.proposals) {
      if (p.status !== 'pending') continue; // 적용된 제안 항목은 우클릭 메뉴용(그리지 않음 — v0.2 와 같다)
      const id = String(p.pid);
      const base: ItemBase = { key: `proposal:${id}`, kind: 'proposal', id, ref: p.ref, cls: 'cw-proposal', marker: 'prop', anchor: 'proposal', tip: p.label };
      if (p.type === 'format' || (p.type || 'replace') === 'replace') {
        const rg = p.start != null && p.end != null ? { ref: p.ref, start: p.start, end: p.end, endRef: p.endRef ?? p.ref } : findRange(p.ref, p.find ?? '', p.occurrence || 1, this.baseGeo);
        if (rg) add(base, this.rangeGeom(rg));
      } else {
        const after = p.afterRef || p.ref;
        add({ ...base, ref: after, cls: 'cw-proposal-after' }, this.paraGeom('after', after));
      }
    }
    for (const c of ann.changes) {
      const id = String(c.id);
      if (c.type === 'Insert') {
        add({ key: `change:${id}`, kind: 'change', id, ref: c.ref, cls: 'cw-ins', anchor: 'change', tip: `삽입 · ${c.author}` }, this.rangeGeom({ ref: c.ref, start: c.start, end: c.end }));
      } else {
        add({
          key: `change:${id}`, kind: 'change', id, ref: c.ref, cls: '', pointCls: 'cw-wedge', anchor: 'change',
          tip: `지운 글 · ${c.author}${c.text ? `\n「${clip(c.text, 80)}」` : ''}`,
        }, this.caretGeom(c.ref, c.start));
      }
    }
    // 같은 사람이 같은 문단에서 타이핑 중이면 '수정 중' 이름표는 빼고 '입력 중' 표만(겹쳐 그리지 않게)
    const typing = new Set(ann.editing.map((e) => `${e.user}\u0000${e.ref}`));
    for (const d of ann.drafts) {
      for (const hk of arr<DraftHunkAnn>(d.hunks)) {
        const ref = hk.type === 'insert' ? (hk.afterRef ?? hk.ref) : hk.ref;
        if (!ref) continue;
        const what = hk.type === 'insert' ? '이 문단 뒤에 추가' : hk.type === 'delete' ? '이 문단 지움' : '바꿈';
        add({
          key: `draft:${d.cid}:${hk.hid}`, kind: 'draft', id: `${d.cid}:${hk.hid}`, ref, cls: '', bandCls: 'cw-dbar',
          tag: typing.has(`${d.user}\u0000${ref}`) ? undefined : `✎ ${d.user}`, tagCls: 'cw-dtag', color: d.color,
          marker: 'draft', anchor: 'draft', cid: d.cid, hid: hk.hid,
          tip: `✎ ${d.user} ${d.status === 'open' ? '검토 중' : '수정 중'} #${d.cid}\n${what}: ${hk.preview || ''}`,
        }, this.paraGeom('band', ref));
      }
    }
    // 타이핑 중(남): 왼쪽 여백의 작은 표 '● 이름'(여백이 좁아 '입력 중'까지 쓰면 기본 배율에서 잘린다) — 마우스를 올리면 '이름 님이 입력 중'
    for (const e of ann.editing) {
      add({ key: `editing:${e.user}`, kind: 'editing', id: e.user, ref: e.ref, cls: '', bandCls: '', tag: `● ${e.user}`, tagCls: 'cw-etag', color: e.color, tip: `${e.user} 님이 입력 중` }, this.paraGeom('band', e.ref, true));
    }
    // 내 수정(기준 대비): 바꾼 문단 파랑·넣은 문단 초록 막대, 지운 자리 빨간 삼각(정렬 결과 — 문서가 바뀌기 전까지 기억)
    const mine = this.align.draft().marks;
    const curLen = (c: CurPara) => cpLen(this.align.curText(c));
    mine.changed.forEach((c, k) => add({ key: `mine:c${k}`, kind: 'mine', id: '', ref: '', cls: '', bandCls: 'cw-mine-bar cw-mine-changed' }, { t: 'band', p: c, len: curLen(c) }));
    mine.inserted.forEach((c, k) => add({ key: `mine:i${k}`, kind: 'mine', id: '', ref: '', cls: '', bandCls: 'cw-mine-bar cw-mine-inserted' }, { t: 'band', p: c, len: curLen(c) }));
    mine.deleted.forEach((d, k) => add({ key: `mine:d${k}`, kind: 'mine', id: '', ref: '', cls: '', pointCls: 'cw-mine-del' },
      { t: 'gap', sec: d.sec, after: d.after, len: curLen({ sec: d.sec, para: Math.max(0, d.after) }) }));
    return out;
  }

  /** 기준 범위 → 편집기 글 범위(묶음이 다르거나 거꾸로면 시작 문단 끝까지·한 점) */
  private rangeGeom(rg: Range): Geom | null {
    const a = this.align.locate(rg.ref);
    if (!a) return null;
    const endRef = rg.endRef ?? rg.ref;
    const b = endRef === rg.ref ? a : this.align.locate(endRef);
    const aLen = cpLen(a.curText);
    const s0 = Number(rg.start) || 0;
    const start: CurPoint = { ...a.cur, offset: toCurOffset(a.map, s0, aLen) };
    let end: CurPoint;
    if (!b || !sameContainer(a.cur, b.cur) || order(b.cur) < order(a.cur)) end = { ...a.cur, offset: aLen };
    else {
      const e0 = rg.end == null ? cpLen(b.baseText) : Number(rg.end) || 0;
      end = { ...b.cur, offset: toCurEnd(b.map, b === a ? s0 : 0, e0, cpLen(b.curText)) };
    }
    if (samePara(start, end) && end.offset < start.offset) end = { ...start };
    return { t: 'range', a: start, b: end, len: aLen };
  }

  private paraGeom(t: 'band' | 'after', ref: string, first = false): Geom | null {
    const a = this.align.locate(ref);
    if (!a) return null;
    return t === 'band' ? { t, p: a.cur, len: cpLen(a.curText), first } : { t, p: a.cur, len: cpLen(a.curText) };
  }

  private caretGeom(ref: string, off: number): Geom | null {
    const a = this.align.locate(ref);
    if (!a) return null;
    const len = cpLen(a.curText);
    return { t: 'caret', p: { ...a.cur, offset: toCurOffset(a.map, Number(off) || 0, len) }, len };
  }

  /** 기준 범위 → 쪽 사각형(지금 바로 — focusRange·flash). 그 범위를 못 그리면 그 문단 띠 */
  private rectsFor(rg: Range): SelectionRect[] {
    const g = this.rangeGeom(rg);
    const r = g ? this.resolveGeom(g) : null;
    if (r?.rects.length) return r.rects;
    const b = this.paraGeom('band', rg.ref);
    return (b && this.resolveGeom(b)?.band) || [];
  }

  /** 보이는 쪽의 강조 자리(레일 배치용, iframe client 좌표). visible = 편집기 보이는 영역 안. 쪽·y 순서 */
  private computeAnchors(list?: OverlayItem[]): Anchor[] {
    if (!this.viewReady || !this.geo.ready()) return [];
    const items = list ?? this.visibleItems(this.geo.visiblePages());
    const vp = this.geo.viewport();
    const out: Anchor[] = [];
    for (const it of items) {
      if (!it.anchor) continue;
      const r = firstRect(it);
      if (!r) continue;
      const c = this.geo.toClient(r);
      const a: Anchor = { kind: it.anchor, id: it.id, ref: it.ref, x: round(c.x), y: round(c.y), page: r.pageIndex, visible: c.y + c.h >= vp.top && c.y <= vp.bottom };
      if (it.cid != null) { a.cid = it.cid; a.hid = it.hid; }
      out.push(a);
    }
    out.sort((p, q) => p.page - q.page || p.y - q.y || p.x - q.x);
    return out;
  }

  private emitAnchors(list?: OverlayItem[]): void {
    if (!this.emitter.has('anchors')) return;
    const a = this.computeAnchors(list);
    const json = JSON.stringify(a);
    if (json === this.lastAnchorsJson) return;
    this.lastAnchorsJson = json;
    this.emitter.emit('anchors', a);
  }

  private updateHover(): void {
    const p = this.hoverPoint;
    const hit = p ? this.overlay.hitTest(p.x, p.y) : null;
    const it = hit?.item;
    const kind = it ? (it.anchor ?? it.kind) : '';
    const key = it ? `${kind}:${it.id}` : '';
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.emitter.emit('annotation-hover', it ? { kind, id: it.id } : null);
  }

  private onMarkerClick(items0: OverlayItem[], anchor: Rect): void {
    // '● 이름' 입력 중 표는 알림만(마우스를 올리면 설명) — 누르기는 아무 일도 하지 않는다
    const items = items0.filter((x) => x.kind !== 'editing');
    const it = items[0]; if (!it) return;
    const payload: Record<string, unknown> = { kind: it.anchor ?? it.kind, id: it.id, anchor: roundRect(anchor) };
    if (items.length > 1) payload.items = items.map((x) => ({ kind: x.anchor ?? x.kind, id: x.id }));
    if (it.cid != null) { payload.cid = it.cid; payload.hid = it.hid; }
    this.emitter.emit('annotation-click', payload);
  }

  // ───────── 선택 ─────────

  /** 지금 편집기 선택(없으면 캐럿) → 기준 ref + 기준 offset(§1.3 CoworkSelection) */
  computeSelection(): CoworkSelection | null {
    const ih = this.ih();
    if (!ih || !this.viewReady || !this.geo.ready()) return null;
    if (ih.isInPictureObjectSelection() || ih.isInTableObjectSelection() || internals.inSubEditor(ih)) return null;
    const t0 = performance.now();
    const sel = ih.getSelection();
    const s = this.geo.fromPosition(sel ? sel.start : ih.getCursorPosition());
    const e = sel ? this.geo.fromPosition(sel.end) : s;
    if (!s || !e) return null;
    const out = this.selectionFrom(s, e);
    this.perf.lastSelectionMs = performance.now() - t0;
    return out;
  }

  private selectionFrom(s: CurPoint, e: CurPoint): CoworkSelection | null {
    const a = this.align.toBase(s);
    if (!a) return null;
    const same = samePoint(s, e);
    const contained = sameContainer(s, e);
    const b = same ? a : contained ? this.align.toBase(e) : null;
    const aLen = cpLen(a.baseText);
    let start = a.inserted ? aLen : toBaseOffset(a.map, s.offset, aLen);
    let endRef = a.ref; let end = start;
    if (!same) {
      if (b && !b.inserted) { endRef = b.ref; end = toBaseOffset(b.map, e.offset, cpLen(b.baseText)); }
      else if (b && b.inserted) { endRef = b.ref; end = cpLen(b.baseText); }
      else { end = aLen; }
    }
    // 같은 문단 안에서 거꾸로(정렬 근사로) 뒤집히면 맞춘다
    if (endRef === a.ref && end < start) [start, end] = [end, start];
    const refs = endRef === a.ref ? [a.ref] : this.refsBetween(a.ref, endRef);
    const multi = refs.length > 1;
    const text = a.inserted && (!b || b.inserted) ? ''
      : multi ? [cpSlice(a.baseText, start), ...refs.slice(1, -1).map((r) => this.align.baseText(r)), cpSlice(this.align.baseText(refs[refs.length - 1]), 0, end)].join('\n')
        : cpSlice(a.baseText, start, end);
    const draft = a.inserted || a.approx || !sameText(a.baseText, a.curText) || !!(b && b !== a && (b.inserted || !sameText(b.baseText, b.curText)));
    const rect = this.rectOf(s, e, same);
    const out: CoworkSelection = {
      ref: a.ref, start, end, endRef: multi ? refs[refs.length - 1] : endRef, refs: multi ? refs : [a.ref], text,
      collapsed: same, cell: s.cell?.kind === 'cell', tableKey: this.tableKeyOf(a.ref, a.cell?.table ?? null),
      source: draft ? 'draft' : 'base', rect,
    };
    if (draft) {
      out.paragraphText = a.curText;
      out.draftText = same ? '' : selectedCurText(this.align, s, e);
    }
    if (a.inserted) { out.inserted = true; out.afterRef = a.afterRef; }
    return out;
  }

  /**
   * 선택 범위의 기준 문단 ref 목록 [a..b]. 본문은 구역을 넘을 수 있다(모두 선택 등 — docs/SECTIONS.md): 기준 본문 문단을 문서
   * 차례로 이어 그 사이를 잘라 낸다. 칸 안은 baseGeo(같은 칸 안)
   */
  private refsBetween(aRef: string, bRef: string): string[] {
    const body = /^s(\d+)\/p\d+$/;
    const sa = body.exec(aRef); const sb = body.exec(bRef);
    if (!sa || !sb || sa[1] === sb[1]) return arr<string>(this.baseGeo.refsBetween(aRef, bRef));
    const refs = this.align.baseParagraphs().map((p) => p.ref).filter((r) => body.test(r));
    const i = refs.indexOf(aRef); const j = refs.indexOf(bRef);
    return i < 0 || j < i ? [aRef] : refs.slice(i, j + 1);
  }

  private tableKeyOf(ref: string, cellTable: string | null): string | null {
    return cellTable || this.align.tableKeyOf(ref);
  }

  /** 선택(없으면 캐럿) 첫 줄 사각형 — iframe client 좌표 */
  private rectOf(s: CurPoint, e: CurPoint, collapsed: boolean): Rect | null {
    if (!collapsed && sameContainer(s, e)) {
      const rs = this.geo.rangeRects(s, e);
      if (rs.length) return roundRect(this.geo.toClient(rs[0]));
    }
    const c = this.geo.caretRect(s, cpLen(this.align.curText(s)));
    return c ? roundRect(this.geo.toClient({ pageIndex: c.pageIndex, x: c.x, y: c.y, width: 1, height: c.height })) : null;
  }

  private emitSelection(): void {
    if (!this.emitter.has('selection')) return;
    // cursor-rect-updated는 매 글자마다 발생한다. 정렬이 무효인 동안 toBase()를 부르면 전체 WASM 문서
    // 스캔이 키 이벤트 안에서 실행된다. relayout()이 마지막 캐럿의 선택을 다시 예약한다.
    if (this.layoutTimer.pending()) return;
    const sel = this.computeSelection();
    const json = JSON.stringify(sel);
    if (json === this.lastSelJson) return;
    this.lastSelJson = json;
    // [hwpx-cowork] 안내의 '대신 골라 주기' 등으로 선택을 바꿔도 열려 있는
    // 미니 도구 막대가 이전 범위를 AI 요청·메모 대상으로 보내지 않게 맞춥니다.
    if (this.toolbar.visible) this.toolbar.reposition(sel);
    this.emitter.emit('selection', sel);
  }

  private onMouseUp(e: MouseEvent): void {
    const down = this.pointerDown; this.pointerDown = null;
    if (!down || e.button !== 0) return;
    // 표식(여백 원·수정 중 막대·이름표) 위에서 뗀 것은 표식의 click 처리기가 annotation-click 을 낸다(두 번 내지 않게)
    if (this.overlay.ownsMark(e.target)) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3;
    // studio 의 mouseup(선택 끝) 처리 뒤에 본다
    setTimeout(() => safe('mouseup', () => {
      if (this.disposed) return;
      this.selTimer.flush(); this.selTimer();
      const sel = this.computeSelection();
      if (sel && !sel.collapsed) {
        if (this.options.miniToolbar && !this.menu.isOpen()) this.toolbar.show(sel);
      } else if (!moved) {
        const hit = this.overlay.hitTest(e.clientX, e.clientY);
        if (hit && hit.item.kind !== 'mine' && hit.item.kind !== 'flash' && hit.item.kind !== 'editing') {
          const r = this.geo.contentToClient(hit.box);
          const payload: Record<string, unknown> = { kind: hit.item.anchor ?? hit.item.kind, id: hit.item.id, anchor: roundRect(r) };
          if (hit.item.cid != null) { payload.cid = hit.item.cid; payload.hid = hit.item.hid; }
          this.emitter.emit('annotation-click', payload);
        }
      }
    }), 0);
  }

  // ───────── 키 ─────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.menu.onKeyDown(e)) return;
    if (this.toolbar.visible && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) this.toolbar.hide();
    const mod = e.ctrlKey || e.metaKey;
    const esc = e.key === 'Escape' && !mod && !e.altKey;
    const submit = mod && e.key === 'Enter';
    const memo = mod && e.altKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M' || e.key === 'ㅡ');
    if (!esc && !submit && !memo) return;
    // Ctrl/⌘+Alt+M 은 studio 단축키가 없어 글자가 들어가지 않게 막는다. Esc·Ctrl+Enter 는 studio 동작도 그대로 둔다
    if (memo) e.preventDefault();
    this.emitter.emit('key', { key: memo ? 'M' : e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey });
  }

  // ───────── 우클릭 구역·메뉴 동작 ─────────

  /** 우클릭 자리(client 좌표; null 이면 지금 캐럿)의 '검토' 구역 문맥. 넣지 않을 때는 null */
  private menuContextAt(clientX: number | null, clientY: number | null): MenuContext | null {
    const ih = this.ih();
    if (!ih || !internals.isActive(ih) || !this.viewReady || !this.geo.ready()) return null;
    // 그림·표 개체 선택, 머리말/꼬리말·각주 편집 중에는 넣지 않는다(본문 ref 로 옮길 수 없음)
    if (ih.isInPictureObjectSelection() || ih.isInTableObjectSelection() || internals.inSubEditor(ih)) return null;
    let p: (CurPoint & { approx?: boolean }) | null = null;
    if (clientX != null && clientY != null) p = this.geo.fromPosition(this.geo.hitAt(clientX, clientY)?.hit ?? null);
    const studioSel = ih.getSelection();
    const sel = this.computeSelection();
    const hasSel = !!sel && !sel.collapsed;
    let inside = false;
    if (p && hasSel && studioSel) inside = this.pointInSelection(p, studioSel.start, studioSel.end);
    if (!p) { p = this.geo.fromPosition(ih.getCursorPosition()); inside = hasSel; }
    if (!p) return null;
    // 대상: 누른 자리가 선택 안이면 선택, 아니면 그 문단 전체(v0.2 와 같음)
    const target = inside && sel ? sel : this.paragraphTarget(p);
    const bl = this.align.toBase(p);
    const off = bl ? toBaseOffset(bl.map, p.offset, cpLen(bl.baseText)) : 0;
    const cov = bl && !bl.inserted ? this.coverage(bl.ref, off) : { memos: [], proposals: [], drafts: [] };
    const model = reviewMenuModel({
      target, hasSelection: inside, proposals: cov.proposals, drafts: cov.drafts, memos: cov.memos,
      presets: this.presets(), quickSend: this.options.quickSend ?? '',
    }) as unknown as MenuEntry[];
    // 읽기 전용(V4 §2.5): 반영·거절 항목은 숨긴다(메모·AI 요청·보기는 남김)
    const entries = this.options.readOnly ? readOnlyEntries(model) : model;
    const anchor = target?.rect ?? (clientX != null && clientY != null ? { x: clientX, y: clientY, w: 0, h: 0 } : { x: 0, y: 0, w: 0, h: 0 });
    return { entries, target, anchor };
  }

  /** 누른 자리가 studio 선택 범위 안인가(같은 묶음에서 (문단, offset) 사이) */
  private pointInSelection(p: CurPoint, start: DocumentPosition, end: DocumentPosition): boolean {
    const s = this.geo.fromPosition(start); const e = this.geo.fromPosition(end);
    if (!s || !e || !sameContainer(s, e) || !sameContainer(s, p)) return false;
    const key = (x: CurPoint) => order(x) * 1e6 + x.offset;
    return key(p) >= key(s) && key(p) <= key(e);
  }

  /** 문단 전체 대상(선택 밖을 눌렀을 때 — v0.2 와 같음) */
  private paragraphTarget(p: CurPoint): CoworkSelection | null {
    const bl = this.align.toBase(p);
    if (!bl) return null;
    const len = cpLen(bl.baseText);
    const draft = bl.inserted || bl.approx || !sameText(bl.baseText, bl.curText);
    const band = this.geo.paragraphBand(p, cpLen(bl.curText));
    const rect = band.length ? roundRect(this.geo.toClient(band[0])) : null;
    const t: CoworkSelection = {
      ref: bl.ref, start: bl.inserted ? len : 0, end: len, endRef: bl.ref, refs: [bl.ref], text: bl.inserted ? '' : bl.baseText,
      collapsed: bl.inserted, cell: p.cell?.kind === 'cell', tableKey: this.tableKeyOf(bl.ref, bl.cell?.table ?? null),
      source: draft ? 'draft' : 'base', rect, whole: true,
    };
    if (draft) t.paragraphText = bl.curText;
    if (bl.inserted) { t.inserted = true; t.afterRef = bl.afterRef; }
    return t;
  }

  /**
   * 메모 범위 = Annotations 그대로(buildAnnotations 가 이미 memoRange 로 끝·끝 문단을 정했다). memoRange 를 다시 부르면 안 된다 —
   * end 가 채워진 여러 문단 메모가 첫 문단으로 줄어든다. end 가 없으면 끝 문단 끝까지. 그리기(buildSpecs)와 우클릭 구역(coverage)이 같이 쓴다.
   */
  private memoSpan(m: MemoAnn): Range {
    const endRef = m.endRef ?? m.ref;
    return { ref: m.ref, start: Number(m.start) || 0, end: m.end == null ? cpLen(this.align.baseText(endRef)) : Number(m.end) || 0, endRef };
  }

  /** 기준 자리(ref, off)를 덮는 메모·제안·남의 수정 중 */
  private coverage(ref: string, off: number): { memos: unknown[]; proposals: unknown[]; drafts: unknown[] } {
    const geo = this.baseGeo;
    const memos = this.ann.memos.filter((m) => (!m.resolved || this.options.showResolved) && covers(this.memoSpan(m), ref, off, geo));
    const proposals = this.ann.proposals.filter((p) => {
      if (p.type !== 'format' && (p.type || 'replace') !== 'replace') return p.status === 'pending' && (p.afterRef || p.ref) === ref;
      const rg = p.start != null && p.end != null ? { ref: p.ref, start: p.start, end: p.end, endRef: p.endRef ?? p.ref } : findRange(p.ref, p.find ?? '', p.occurrence || 1, geo);
      return !!rg && covers(rg, ref, off, geo);
    });
    const drafts: Array<{ cid: number; user: string; status: string; hid: string; color: string }> = [];
    for (const d of this.ann.drafts) {
      const h = arr<DraftHunkAnn>(d.hunks)
        .find((x) => { const r = x.type === 'insert' ? (x.afterRef ?? x.ref) : x.ref; return !!r && (r === ref || ref.startsWith(`${r}/`)); });
      if (h) drafts.push({ cid: d.cid, user: d.user, status: d.status, hid: h.hid, color: d.color });
    }
    return { memos, proposals, drafts };
  }

  private presets(): Array<{ id: string; label: string }> {
    return this.options.presets?.length ? this.options.presets : DEFAULT_PRESETS;
  }

  private emitMenuAction(action: Action | { type: string; preset?: string }, target: CoworkSelection | null, anchor: Rect, source: string): void {
    const a = action as Record<string, unknown> & { type: string };
    const payload: Record<string, unknown> = { action: a.type, target, anchor: roundRect(anchor), source };
    if (REQUEST_KIND[a.type]) payload.kind = REQUEST_KIND[a.type];
    if (a.preset != null) payload.preset = a.preset;
    if (a.pickFile != null) payload.pickFile = a.pickFile;
    if (a.type === 'attach') payload.pickFile = true; // 파일 첨부해서 AI에게… = 지시 + 파일 고르기부터
    if (a.pid != null) { payload.kind = 'proposal'; payload.pid = a.pid; payload.id = String(a.pid); }
    if (a.cid != null) { payload.kind = 'draft'; payload.cid = a.cid; if (a.hid != null) payload.hid = a.hid; payload.id = `${a.cid}${a.hid != null ? `:${a.hid}` : ''}`; }
    if (a.type === 'quick') payload.quick = a.id;   // AI에게 빠르게 맡기기: 어느 예시 지시인지(지시 글은 호스트 quickPrompt)
    if (a.type.startsWith('memo-')) { payload.kind = 'memo'; payload.id = a.id; if (a.resolved != null) payload.resolved = a.resolved; }
    if (a.rid != null) payload.rid = a.rid; // request-adopt-all(§9.7): 어느 AI 작업의 남은 제안인지
    this.emitter.emit('menu-action', payload);
  }

  /** 메뉴바 항목: 선택이 있으면 선택, 없으면 캐럿 문단 전체 */
  private menubarAction(type: string): void {
    const sel = this.computeSelection();
    let target = sel && !sel.collapsed ? sel : null;
    if (!target) {
      const ih = this.ih();
      const p = ih ? this.geo.fromPosition(ih.getCursorPosition()) : null;
      target = p ? this.paragraphTarget(p) : sel;
    }
    this.emitMenuAction({ type }, target, target?.rect ?? { x: 0, y: 0, w: 0, h: 0 }, 'menubar');
  }

  // ───────── 내 수정 표시 ─────────

  private draftNow(): DraftState {
    const d = this.align.draft();
    this.perf.lastDraftMs = this.align.stats.lastDraftMs;
    return { dirty: this.changeSeq !== this.cleanSeq, ...d.state };
  }

  private emitDraft(): void {
    if (!this.viewReady || !this.geo.ready()) return;
    if (this.layoutTimer.pending()) { this.draftTimer(); return; }
    this.emitter.emit('draft', this.draftNow());
  }

  private emitEditing(): void {
    if (!this.editingRequested || !this.emitter.has('editing')) return;
    const ih = this.ih(); if (!ih) return;
    const p = this.geo.fromPosition(ih.getCursorPosition());
    let ref: string | null;
    if (this.layoutTimer.pending() || this.align.stale) {
      // ref뿐인 입력 중 표시는 text-only 변이로 보존된 기존 짝 지도를 쓴다. 1초 간격 알림을 유지하면서
      // 전체 스캔·offset diff를 키 이벤트 안에서 실행하지 않는다. 구조 변경으로 지도가 없으면 쉼까지 기다린다.
      ref = p ? this.align.cachedEditingRef(p) : null;
      if (!ref) return;
    } else {
      const bl = p ? this.align.toBase(p) : null;
      ref = bl ? (bl.inserted ? bl.afterRef ?? bl.ref : bl.ref) : null;
    }
    this.editingRequested = false;
    this.lastEditingRef = ref;
    this.emitter.emit('editing', ref ? { ref } : null);
  }

  private emitEditingIdle(): void {
    if (this.lastEditingRef === null) return;
    this.lastEditingRef = null;
    this.emitter.emit('editing', null);
  }

  // ───────── 호스트 API 본체 ─────────

  setBase(p: { version?: number; paragraphs?: EngineParagraph[] }): void {
    const x = jsonCopy(p ?? {});
    this.align.setBase(Number(x.version) || 0, arr<EngineParagraph>(x.paragraphs));
    this.baseGeo = paragraphGeo(this.align.baseParagraphs());
    this.invalidateItems(); this.lastSelJson = '';
    this.renderRaf(); this.draftTimer(); this.selTimer();
  }

  /**
   * 지금 편집기 내용 = 서버에 저장된 내 수정본(자동 저장 기준점). 덧붙임: { changeSeq } 를 주면 그 판까지만 깨끗하다고 본다
   * — 내보내기(exportHwpx) 직전의 'edited' changeSeq 를 주면, 저장하는 동안 더 친 글이 dirty 로 남는다.
   */
  markClean(p?: { changeSeq?: number } | null): void {
    const seq = Number(p?.changeSeq);
    this.cleanSeq = Number.isInteger(seq) && seq >= 0 && seq <= this.changeSeq ? seq : this.changeSeq;
    this.draftTimer();
  }

  setAnnotations(a: Partial<Annotations> | null | undefined): void {
    const x = jsonCopy(a ?? {}) as Partial<Annotations>;
    this.ann = { memos: arr(x.memos), proposals: arr(x.proposals), changes: arr(x.changes), drafts: arr(x.drafts), editing: arr(x.editing), flash: x.flash ?? null };
    this.invalidateItems();
    this.renderRaf();
    if (x.flash && x.flash.ref) this.flashRange(x.flash);
  }

  setActive(p: { kind: string; id: string } | null): void {
    const x = p ? jsonCopy(p) : null;
    this.active = x && x.kind != null && x.id != null ? { kind: String(x.kind), id: String(x.id) } : null;
    this.renderRaf();
  }

  setOptions(o: Partial<CoworkOptions>): void {
    const x = jsonCopy(o ?? {}) as Partial<CoworkOptions>;
    const before = this.options.showResolved;
    const wasReadOnly = this.options.readOnly;
    this.options = {
      ...this.options,
      ...(typeof x.overlays === 'boolean' ? { overlays: x.overlays } : {}),
      ...(typeof x.miniToolbar === 'boolean' ? { miniToolbar: x.miniToolbar } : {}),
      ...(typeof x.showResolved === 'boolean' ? { showResolved: x.showResolved } : {}),
      ...(typeof x.readOnly === 'boolean' ? { readOnly: x.readOnly } : {}),
      ...(Array.isArray(x.presets) ? { presets: x.presets.filter((q) => q && q.id && q.label).map((q) => ({ id: String(q.id), label: String(q.label) })) } : {}),
      ...(typeof x.quickSend === 'string' ? { quickSend: x.quickSend } : {}),
    };
    if (!this.options.miniToolbar) this.toolbar.hide();
    if (before !== this.options.showResolved) this.invalidateItems();
    if (wasReadOnly !== this.options.readOnly) this.applyEditMode();
    this.renderRaf();
  }

  /**
   * 읽기 전용 ↔ 편집(V4 §2.5): studio 편집 모드를 'form'(양식 모드 — 글 입력·지우기·붙여넣기·서식·표·쪽 명령이 막힘) ↔ 'normal' 로.
   * main.ts 의 setEditMode(CommandServices — 상태 표시줄·명령 가능 여부까지)를 쓴다. 읽기 전용이 되면 되돌리기·다시하기 기록을 비운다
   * — 양식 모드에서도 되돌리기(edit:undo)는 막히지 않아, 남은 기록으로 문서를 되돌릴 수 있다. 문서가 아직 없으면 모드만(열 때 studio 가 그 모드로 연다).
   */
  private applyEditMode(): void {
    const s = this.services; if (!s) return;
    const want = this.options.readOnly ? 'form' : 'normal';
    safe('편집 모드', () => {
      if (s.getContext().editMode !== want) s.setEditMode(want);
      const ih = this.ih();
      if (this.options.readOnly && ih) { internals.clearHistory(ih, s.wasm); s.eventBus.emit('command-state-changed'); }
    });
    this.lastSelJson = ''; this.selTimer();
  }

  private flashRange(rg: Range): boolean {
    if (!this.viewReady || !this.geo.ready()) return false;
    const rects = this.rectsFor(rg);
    if (!rects.length) return false;
    this.startFlash(rects);
    return true;
  }

  /** 1.6초 깜빡임(강조 층의 flash 항목 — 그 사이 다시 그려도 남는다) */
  private startFlash(rects: SelectionRect[]): void {
    this.flash = { rects, until: Date.now() + FLASH_MS };
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flash = null; this.flashTimer = null; this.renderRaf(); }, FLASH_MS + 50);
    this.renderRaf();
  }

  /** 기준 범위·개체의 iframe 좌표. 스크롤을 움직이지 않아 지속적인 초점 테두리에도 쓸 수 있다. */
  rangeRects(p: import('./types').RangeLocation): Rect[] {
    if (!p || !this.viewReady || !this.geo.ready()) return [];
    const a = this.align.locate(p.ref); if (!a) return [];
    const rects = p.object ? this.geo.objectRects(a.cur, p.object, Number(p.objectIndex ?? 0))
      : this.rectsFor({ ref: p.ref, start: Number(p.start) || 0, end: p.end == null ? cpLen(a.baseText) : Number(p.end), ...(p.endRef ? { endRef: p.endRef } : {}) });
    return rects.map(r => this.geo.toClient(r));
  }

  focusRange(p: import('./types').RangeLocation & { flash?: boolean; select?: boolean }): boolean {
    const x = jsonCopy(p ?? ({} as typeof p));
    if (!x || typeof x.ref !== 'string' || !this.viewReady || !this.geo.ready()) return false;
    const a = this.align.locate(x.ref);
    if (!a) return false;
    const whole = x.start == null && x.end == null;
    const rg: Range = {
      ref: x.ref, start: whole ? 0 : Number(x.start ?? 0), end: whole ? cpLen(a.baseText) : Number(x.end ?? x.start ?? 0),
      ...(x.endRef && !whole ? { endRef: String(x.endRef) } : {}),
    };
    const rects = x.object ? this.geo.objectRects(a.cur, x.object, Number(x.objectIndex ?? 0)) : this.rectsFor(rg);
    if (!rects.length) return false;
    if (x.select) this.selectBase(x.ref, rg.start, rg.end, rg.endRef);
    this.scrollIntoView(rects[0]);
    if (x.flash !== false) this.startFlash(rects);
    this.renderRaf();
    return true;
  }

  /** 쪽 좌표 사각형이 보이게 스크롤(보이는 영역 위에서 30% 자리) */
  private scrollIntoView(r: SelectionRect): void {
    const c = this.geo.container(); if (!c) return;
    const b = this.geo.toContent(r);
    const top = c.scrollTop; const h = c.clientHeight;
    if (b.top < top + 8 || b.top + b.height > top + h - 8) c.scrollTop = Math.max(0, b.top - h * 0.3);
    const left = c.scrollLeft; const w = c.clientWidth;
    if (b.left < left || b.left + b.width > left + w) c.scrollLeft = Math.max(0, b.left - 40);
  }

  /** 기준 범위를 편집기 선택으로(찾기 대화상자와 같은 방법 — internals.selectRange) */
  selectBase(ref: string, start: number, end: number, endRef?: string): boolean {
    const ih = this.ih(); if (!ih || !this.viewReady) return false;
    const a = this.align.locate(ref); if (!a) return false;
    const b = endRef && endRef !== ref ? this.align.locate(endRef) : a;
    if (!b || !sameContainer(a.cur, b.cur)) return false;
    const s = { ...a.cur, offset: toCurOffset(a.map, start, cpLen(a.curText)) };
    const e = { ...b.cur, offset: toCurEnd(b.map, b === a ? start : 0, end, cpLen(b.curText)) };
    if (samePara(s, e) && e.offset < s.offset) e.offset = s.offset;
    const ok = internals.selectRange(ih, this.geo.toPosition(s), this.geo.toPosition(e));
    this.selTimer();
    return ok;
  }

  private editable(): boolean {
    if (this.options.readOnly) return false;
    const ctx = safe('ctx', () => this.services?.getContext());
    return !!ctx && ctx.hasDocument && ctx.isEditable && !ctx.isFormMode;
  }

  // ───────── 실시간 공동 편집(V4 §2.5): syncToBase · flash ─────────

  /**
   * 편집기 글을 setBase 로 준 기준 글로 맞춘다 — 다시 열지 않고 바뀐 문단만 고친다(캐럿·선택·스크롤 그대로).
   *  1) 계획(align.syncPlan — 편집 전 문서): 짝 문단·칸 글이 정확히 다르면 글자 차이 조각만, 편집기에만 있는 글 문단은 지움, 기준에만 있는
   *     글 문단은 앞 짝 문단 뒤에 넣음. 못 하면(표 격자·칸 지도·표/개체 문단 등) STRUCTURE 로 아무것도 고치지 않는다. 고칠 것이 없으면 트랜잭션 없음.
   *  2) 트랜잭션 하나('cowork:sync', deferPagination): 문서 뒤쪽부터 고치고 → 고친 문단 글·구역 문단 수를 기준과 견줘 다르면 던져 롤백(ERROR) →
   *     커서를 옮긴 자리로(studio 가 트랜잭션 뒤 그 자리로 커서를 다시 옮기므로 고친 문서에서 유효해야 한다). 양식 모드(읽기 전용)는 스냅샷 작업을
   *     버리므로 그동안만 InputHandler 를 normal 로.
   *  3) 되돌리기·다시하기 기록을 비운다(남의 글까지 되돌려 밀어 넣지 않게 — V4 §2.4-6), 선택(anchor·focus 방향 그대로)·스크롤을 되살린다
   *     (포커스는 옮기지 않는다), studio dirty 표시는 맞추기 전이 깨끗했으면 깨끗하게.
   * 호스트가 밀어 넣기를 예약하지 않게: 이 트랜잭션의 document-mutated 는 changeSeq·'edited'·'editing' 을 내지 않고(syncing), 끝나면
   * cleanSeq = changeSeq(편집기 = 새 기준 → draft 이벤트 dirty:false). changeSeq 를 올리지 않으므로 호스트의 markClean({ changeSeq }) 도 그대로 맞는다.
   */
  syncToBase(): SyncResult {
    const none = (reason: NonNullable<SyncResult['reason']>, message?: string, ref?: string): SyncResult =>
      ({ ok: false, reason, changed: [], inserted: [], deleted: 0, ...(message ? { message } : {}), ...(ref ? { ref } : {}) });
    const services = this.services; const ih = this.ih();
    if (!services || !ih || !this.viewReady || !this.geo.ready()) return none('READONLY', '문서가 없습니다');
    if (!this.align.hasBase) return none('ERROR', '기준(setBase)이 없습니다');
    // 한글 조합 중(조합 글자가 이미 문서에 있고 조합이 끝나야 기록된다)·머리말/꼬리말·각주 편집 중(본문 캐럿을 따로 기억한다)에는 고치지 않는다
    if (internals.isComposing(ih)) return none('BUSY', '한글 조합 중입니다');
    if (internals.inSubEditor(ih)) return none('BUSY', '머리말/꼬리말·각주 편집 중입니다');
    const t0 = performance.now();
    let plan: SyncPlan | SyncFail;
    try { plan = this.align.syncPlan(); } catch (err) { console.warn('[cowork] syncToBase 계획:', err); return none('ERROR', String((err as Error)?.message ?? err)); }
    if (!plan.ok) return none('STRUCTURE', plan.message, plan.ref);
    if (!plan.edits.length) {
      // 편집기 글 = 기준 글: 고칠 것도, 되돌리기 기록을 비울 까닭도 없다(남의 글이 들어오지 않았다)
      this.cleanSeq = this.changeSeq; this.draftTimer();
      return { ok: true, changed: [], inserted: [], deleted: 0 };
    }
    const ok = plan;
    const t1 = performance.now();
    // 고치기 전: 스크롤, 선택(방향 그대로)·캐럿 → 고친 뒤 자리. 표·그림 개체 선택·칸 블록 선택은 푼다(그 개체의 문단 번호가 바뀔 수 있다)
    const sc = this.geo.container();
    const scroll = sc ? { top: sc.scrollTop, left: sc.scrollLeft } : null;
    safe('개체 선택 풀기', () => internals.exitObjectModes(ih));
    const sel = internals.cursorSelection(ih);
    const mapPos = (pos: DocumentPosition): DocumentPosition => {
      const pt = this.geo.fromPosition(pos);
      if (!pt) return pos;
      if (pt.approx) {
        // 칸 안의 표(2단 이상) — 맞추기는 그 안을 고치지 않는다: 바깥 본문 문단 번호만 옮긴다
        const np = ok.mapPoint({ sec: pt.sec, para: pt.para, offset: 0 }).para;
        return { ...pos, parentParaIndex: np, ...(pos.paragraphIndex === pt.para ? { paragraphIndex: np } : {}) };
      }
      return this.geo.toPosition(ok.mapPoint(pt));
    };
    const focus = mapPos(ih.getCursorPosition());
    const anchor = sel ? mapPos(sel.anchor) : null;
    const wasDirty = safe('dirty', () => services.documentState.isDirty(), true) ?? true;
    const form = ih.isFormMode();
    this.syncing = true;
    try {
      if (form) ih.setEditMode('normal');
      this.host.transaction('cowork:sync', (tx) => {
        tx.deferPagination();
        const doc = tx.doc();
        for (const ed of ok.edits) runSyncEdit(doc, ed);
        const bad = verifySync(services.wasm, ok);
        if (bad) throw new Error(`맞춘 뒤 확인 실패 — ${bad}`);
        internals.setCursor(ih, focus);
      });
    } catch (err) {
      // studio 가 트랜잭션 전 문서로 되돌렸다(스냅샷) — 정렬만 다시
      this.align.invalidate(); this.invalidateItems(); this.invalidateGeometry(); this.layoutTimer();
      const code = (err as { code?: string })?.code;
      console.warn('[cowork] syncToBase 실패(문서는 그대로):', err);
      return none(code === 'DOCUMENT_RELEASED' ? 'READONLY' : 'ERROR', String((err as Error)?.message ?? err));
    } finally {
      if (form) safe('양식 모드', () => ih.setEditMode('form'));
      this.syncing = false;
    }
    const t2 = performance.now();
    this.align.invalidate(); this.invalidateItems(); this.invalidateGeometry();
    safe('되돌리기 기록', () => { internals.clearHistory(ih, services.wasm); services.eventBus.emit('command-state-changed'); });
    safe('캐럿', () => internals.restoreSelection(ih, anchor, focus));
    if (scroll && sc) safe('스크롤', () => this.restoreScroll(sc, scroll));
    if (!wasDirty) safe('dirty', () => services.documentState.markClean('cowork-sync'));
    this.cleanSeq = this.changeSeq;
    this.lastSelJson = '';
    // 열린 우클릭 메뉴는 낡은 대상을 들고 있다 — 닫는다. 미니 도구 막대는 새 선택(새 기준 ref·자리)으로 다시
    safe('메뉴 닫기', () => this.menu.close());
    if (this.toolbar.visible) this.toolbarRaf();
    this.layoutTimer(); this.draftTimer(); this.selTimer();
    const ms = performance.now() - t0;
    this.perf.syncs++; this.perf.lastSyncMs = ms; this.perf.lastSyncEdits = ok.edits.length;
    this.perf.lastSyncPlanMs = t1 - t0; this.perf.lastSyncTxMs = t2 - t1;
    return { ok: true, changed: docOrder(ok.changed), inserted: docOrder(ok.inserted), deleted: ok.deleted, ms: round(ms) };
  }

  /** 스크롤을 그 값으로(ViewportManager 의 기억 값도 같이) */
  private restoreScroll(sc: HTMLElement, at: { top: number; left: number }): void {
    const vm = this.services?.getViewportManager();
    if (vm) { if (sc.scrollTop !== at.top) vm.setScrollTop(at.top); if (sc.scrollLeft !== at.left) vm.setScrollLeft(at.left); return; }
    sc.scrollTop = at.top; sc.scrollLeft = at.left;
  }

  /**
   * 남이 바꾼 자리를 잠깐(1.5초) 밑줄로 깜빡인다(V4 §2.4-5) — 강조 층의 flash 항목(그 사이 다시 그려도 남는다). 스크롤하지 않는다(opts.scroll 이
   * true 면 첫 범위로). ranges = 기준 범위 { ref, start?, end?, endRef? } 하나 또는 목록(start·end 가 없으면 문단 전체). 그린 범위가 있으면 true
   */
  remoteFlash(ranges: unknown, opts?: FlashOptions | null): boolean {
    if (!this.viewReady || !this.geo.ready()) return false;
    const list = (Array.isArray(ranges) ? ranges : ranges ? [ranges] : []) as Array<Partial<Range>>;
    const o = (opts && typeof opts === 'object' ? opts : {}) as FlashOptions;
    const color = typeof o.color === 'string' && o.color ? o.color : undefined;
    const until = Date.now() + REMOTE_FLASH_MS;
    let first: SelectionRect | null = null;
    for (const r of list) {
      if (!r || typeof r.ref !== 'string') continue;
      const a = safe('flash 자리', () => this.align.locate(r.ref!), null);
      if (!a) continue;
      const whole = r.start == null && r.end == null;
      const rg: Range = {
        ref: r.ref, start: whole ? 0 : Number(r.start ?? 0) || 0, end: whole ? cpLen(a.baseText) : Number(r.end ?? r.start ?? 0) || 0,
        ...(r.endRef && !whole ? { endRef: String(r.endRef) } : {}),
      };
      const rects = safe('flash 사각형', () => this.rectsFor(rg), []) ?? [];
      if (!rects.length) continue;
      this.rflashes.push({ key: `rflash:${this.rflashSeq++}`, rects, color, until });
      first ??= rects[0];
    }
    if (!first) return false;
    if (o.scroll === true) this.scrollIntoView(first);
    this.scheduleRflash();
    this.renderRaf();
    return true;
  }

  /** 가장 먼저 끝나는 밑줄 깜빡임 뒤에 다시 그린다(끝난 것을 지움 — 남은 것이 있으면 또) */
  private scheduleRflash(): void {
    if (this.rflashTimer) clearTimeout(this.rflashTimer);
    this.rflashTimer = null;
    if (!this.rflashes.length) return;
    const next = Math.min(...this.rflashes.map((f) => f.until));
    this.rflashTimer = setTimeout(() => {
      this.rflashTimer = null;
      const now = Date.now();
      this.rflashes = this.rflashes.filter((f) => f.until > now);
      this.renderRaf();
      this.scheduleRflash();
    }, Math.max(0, next - Date.now()) + 50);
  }

  // ───────── 내 수정본에 반영(applyText · insertParagraphAfter · applyBatch) ─────────

  applyText(p: TextArgs): ApplyResult {
    const x = jsonCopy(p ?? ({} as TextArgs));
    if (!x || typeof x.ref !== 'string') return { ok: false, reason: 'NO_PARAGRAPH' };
    if (!this.viewReady || !this.editable()) return { ok: false, reason: 'READONLY' };
    const ed = this.planText(x);
    if (typeof ed === 'string') return { ok: false, reason: ed };
    const ih = this.ih(); if (!ih) return { ok: false, reason: 'READONLY' };
    if (ed.e === ed.s && !ed.text) return { ok: true };
    return this.commit('cowork:apply', [ed], ih, false);
  }

  insertParagraphAfter(p: InsertArgs): ApplyResult {
    const x = jsonCopy(p ?? ({} as InsertArgs));
    if (!x || typeof x.afterRef !== 'string') return { ok: false, reason: 'NO_PARAGRAPH' };
    if (!this.viewReady || !this.editable()) return { ok: false, reason: 'READONLY' };
    let ed: InsertEdit | 'NO_PARAGRAPH';
    try { ed = this.planInsert(x); } catch (err) { return failure('insertParagraphAfter', err); }
    if (typeof ed === 'string') return { ok: false, reason: ed };
    const ih = this.ih(); if (!ih) return { ok: false, reason: 'READONLY' };
    return this.commit('cowork:insert', [ed], ih, false);
  }

  /**
   * 여러 제안을 내 수정본에 한 번에(§9.6) — studio 되돌리기 한 번에 모두 빠지고 다시하기 한 번에 모두 돌아온다.
   *  1) 모든 자리를 편집 전 문서로 찾는다(text 는 applyText, insert 는 insertParagraphAfter 와 같은 규칙). 못 찾은 항목만 NO_PARAGRAPH·NOT_FOUND.
   *  2) 같은 문단(같은 칸 문단)에서 바꿀 범위가 겹치면 뒤 항목(items 순서)을 OVERLAP 으로 뺀다(남긴 항목하고만 견준다).
   *  3) 남은 것을 입력 순서대로 트랜잭션 하나('cowork:batch')로 고치고 각 성공 뒤 다음 글·문단 위치를 보정한다.
   *     고칠 것이 없으면 트랜잭션을 만들지 않는다. 트랜잭션이 던지면 studio 가 문서를 롤백하고 결과는 모두 ok:false.
   * results 는 items 순서, key 는 받은 것 그대로(없으면 items 안 번호 0부터). 빈 자리에 빈 글처럼 바꿀 것이 없는 항목은 ok(applyText 와 같다).
   */
  applyBatch(items0: unknown): BatchResult {
    const items: unknown[] = Array.isArray(items0) ? jsonCopy(items0) : [];
    const results: BatchItemResult[] = items.map((it, k) => ({ key: keyOf(it, k), ok: false }));
    /** 묶음 전체 실패: 결과는 모두 ok:false(제 까닭이 있는 항목은 그 까닭, 나머지는 묶음 까닭) */
    const whole = (reason: 'TOO_MANY' | 'READONLY' | 'ERROR', message?: string): BatchResult => ({
      ok: false, reason, ...(message ? { message } : {}), applied: 0,
      results: results.map((r) => ({ key: r.key, ok: false, reason: (!r.ok && r.reason) || reason })),
    });
    if (items.length > BATCH_MAX) return whole('TOO_MANY');
    if (!this.viewReady || !this.editable()) return whole('READONLY');
    const ih = this.ih(); if (!ih) return whole('READONLY');
    const todo: Array<{ k: number; ed: Edit }> = [];
    items.forEach((it, k) => {
      const x = (it && typeof it === 'object' ? it : {}) as Partial<BatchItem>;
      const op = x.op ?? 'text';
      let ed: Edit | BatchItemReason;
      try {
        ed = op === 'insert' ? this.planInsert(x as InsertArgs) : op === 'text' ? this.planText(x as TextArgs) : 'BAD_ITEM';
      } catch (err) {
        console.warn('[cowork] applyBatch 자리 찾기:', err);
        ed = 'ERROR';
      }
      if (typeof ed === 'string') { results[k].reason = ed; return; }
      const cur: Edit = ed;
      if (cur.op === 'text') {
        if (cur.e === cur.s && !cur.text) { results[k].ok = true; return; }
        if (todo.some((t) => t.ed.op === 'text' && overlaps(t.ed, cur))) { results[k].reason = 'OVERLAP'; return; }
      }
      todo.push({ k, ed: cur });
    });
    if (todo.length) {
      // 입력 순서 그대로 처리하고, 각 성공 뒤 남은 글 위치·문단 번호를 옮긴다.
      const r = this.commit('cowork:batch', todo.map((t) => t.ed), ih, true, true);
      if (!r.ok) return whole(r.reason === 'READONLY' ? 'READONLY' : 'ERROR', r.message);
      for (const t of todo) results[t.k].ok = true;
    }
    const out = results.map((r) => (r.ok ? { key: r.key, ok: true } : { key: r.key, ok: false, reason: r.reason ?? 'ERROR' }));
    return { ok: true, applied: out.filter((r) => r.ok).length, results: out };
  }

  /** applyText 꼴 인자 → 바꿀 자리(편집 전 문서). 문단이 없으면 NO_PARAGRAPH, 글을 못 찾으면 NOT_FOUND */
  private planText(x: TextArgs): TextEdit | 'NO_PARAGRAPH' | 'NOT_FOUND' {
    if (!x || typeof x.ref !== 'string') return 'NO_PARAGRAPH';
    const a = this.align.locate(x.ref);
    if (!a) return 'NO_PARAGRAPH';
    const range = findInCurrent(a, x);
    if (!range) return 'NOT_FOUND';
    // 문단 안 글만 바꾼다(줄바꿈은 문단 추가로)
    return { op: 'text', cur: a.cur, s: range[0], e: range[1], text: String(x.replace ?? '').replace(/\r\n?|\n/g, ' ') };
  }

  /** insertParagraphAfter 꼴 인자 → 넣을 자리(편집 전 문서). 문단이 없으면 NO_PARAGRAPH. 문단 길이를 읽다 던지면 그대로 던진다 */
  private planInsert(x: InsertArgs): InsertEdit | 'NO_PARAGRAPH' {
    if (!x || typeof x.afterRef !== 'string') return 'NO_PARAGRAPH';
    const a = this.align.locate(x.afterRef);
    if (!a) return 'NO_PARAGRAPH';
    const w = this.services!.wasm;
    const lines = String(x.text ?? '').replace(/\r\n?/g, '\n').split('\n');
    // skip(0.4.1 'insertSkip'): 기준 문단 뒤에 이미 넣은 내 초안 문단 너머로(없거나 맞는 것이 없으면 예전처럼 기준 문단 바로 뒤)
    const past = Array.isArray(x.skip) && x.skip.length ? this.pastDrafts(a.cur, x.skip) : null;
    if (past) {
      const { sec: ps, para: pp, cell: pc } = past;
      if (!pc) return { op: 'insert', cur: past, lines, len: w.getParagraphLength(ps, pp), objectOnly: false, count: w.getParagraphCount(ps) };
      return { op: 'insert', cur: past, lines, len: w.getCellParagraphLength(ps, pp, pc.ci, pc.cell, pc.cpara), objectOnly: false, count: 0 };
    }
    const { sec, para, cell } = a.cur;
    if (!cell) {
      return {
        op: 'insert', cur: a.cur, lines, len: w.getParagraphLength(sec, para),
        objectOnly: !cpLen(a.curText) && this.align.curKind(sec, para) !== 'empty', count: w.getParagraphCount(sec),
      };
    }
    return { op: 'insert', cur: a.cur, lines, len: w.getCellParagraphLength(sec, para, cell.ci, cell.cell, cell.cpara), objectOnly: false, count: 0 };
  }

  /**
   * 넣기 자리를 기준 문단 뒤에 이미 넣어 둔 내 초안 문단 너머로 옮긴다(2026-11-17 docs/MCP_REDESIGN_2026-11-16.md §10.4 나-3).
   * 비실시간 문서에서 같은 요청·같은 기준 문단의 넣기 제안 #1·#2·#3 을 하나씩 '내 수정본에 반영'하면 매번 기준 문단 바로 뒤에 넣어 3·2·1 로
   * 쌓였다 — 내 수정본에만 있는 초안 문단은 기준 ref 가 없어 호스트가 가리킬 수 없으므로, 호스트가 앞 차례 형제의 글(skip)을 주고 여기서 찾는다.
   * 기준 문단(cur) 바로 뒤에 잇달아 있는 '내 수정본에만 있는' 문단(align.draftOnly — 같은 칸 안이면 그 칸의 칸 문단)만 본다: 짝 있는 기준 문단을
   * 만나면 멈춘다(엉뚱한 기준 문단 뒤에 넣지 않게). 그 문단들을 앞에서부터 skip 줄(글마다 줄바꿈으로 나눈 줄 — 넣을 때 줄마다 문단 하나)과
   * 견주어, 어떤 문단의 글이 아직 맞추지 않은 skip 줄 가운데 첫 같은 줄과 같으면 그 줄까지 맞춘 것으로 하고 그 문단을 '마지막으로 맞은 문단'으로 둔다.
   * 맞춘 줄은 앞으로만 나아가므로 차례를 거스르지 않는다. 사람이 고친 초안(어느 줄과도 다름)·사람이 쓴 문단·뒤 차례 제안 문단은 그 뒤에서
   * 맞는 문단이 나올 때만 함께 넘는다 — 그래서 더 큰 pid 형제가 이미 들어가 있으면 그 앞에 놓인다. 표·그림 문단은 글로 맞추지 않는다.
   * → 마지막으로 맞은 문단 자리(그 뒤에 넣는다), 없으면 null
   */
  private pastDrafts(cur: CurPara, skip0: unknown[]): CurPara | null {
    const want: string[] = [];
    for (const t of skip0) if (typeof t === 'string') want.push(...t.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()));
    if (!want.length) return null;
    const w = this.services!.wasm;
    const { sec, para, cell } = cur;
    const at = (k: number): CurPara => (cell ? { sec, para, cell: { ...cell, cpara: k } } : { sec, para: k });
    const end = cell ? w.getCellParagraphCount(sec, para, cell.ci, cell.cell) : this.align.paragraphCount(sec);
    let j = 0; let last: CurPara | null = null;
    for (let k = (cell ? cell.cpara : para) + 1; k < end && j < want.length; k++) {
      const c = at(k);
      if (!this.align.draftOnly(c)) break;
      if (!cell && ['table', 'object'].includes(this.align.curKind(sec, k))) continue;
      const text = this.align.curText(c).trim();
      const m = want.indexOf(text, j);
      if (m < 0) continue;
      j = m + 1; last = c;
    }
    return last;
  }

  /**
   * 고칠 것들을 트랜잭션 하나로(= studio 되돌리기 한 번·다시하기 한 번). FIFO 배치는 입력 차례로 실행하며 남은 위치를 매번 보정한다.
   * 트랜잭션 전 캐럿은 문서 맨 앞 편집이 시작하는 자리에 둔다 — studio 는 트랜잭션 뒤·다시하기 때 그 '전 캐럿' 자리로
   * 가므로 편집 뒤에도 유효해야 한다(맨 앞 편집보다 앞은 아무것도 바뀌지 않는다). defer 면 조판을 커밋 때 한 번만(tx.deferPagination).
   * 끝나면 정렬을 무효로 하고 캐럿을 마지막으로 처리한 편집의 끝으로.
   */
  private commit(label: string, edits: Edit[], ih: InputHandler, defer: boolean, fifo = false): ApplyResult {
    const planned: Edit[] = fifo ? jsonCopy(edits) : edits;
    const first = [...planned].sort((a, b) => cmpKey(editKey(a), editKey(b)))[0];
    const out: { caret: CurPoint | null } = { caret: null };
    try {
      internals.placeCaret(ih, this.geo.toPosition(caretBefore(first)));
      this.host.transaction(label, (tx) => {
        if (defer) tx.deferPagination();
        const doc = tx.doc();
        for (let i = 0; i < planned.length; i++) {
          const ed = planned[i];
          out.caret = runEdit(doc, ed);
          if (fifo) advanceBatchEdits(planned.slice(i + 1), ed, out.caret);
        }
      });
    } catch (err) {
      return failure(label, err);
    }
    this.align.invalidate();
    const caret = out.caret;
    if (caret) safe('캐럿', () => internals.placeCaret(ih, this.geo.toPosition(caret)));
    return { ok: true };
  }

  draftState(): DraftState {
    if (!this.viewReady) return { dirty: this.changeSeq !== this.cleanSeq, changed: [], inserted: [], deleted: [] };
    return this.draftNow();
  }

  // ───────── 시험용 ─────────

  /** 기준 (ref, offset) 의 iframe client 좌표(글자 왼쪽 조금 안·줄 가운데). 화면 밖이면 먼저 스크롤한다 */
  pointFor(ref: string, offset: number): { x: number; y: number; page: number } | null {
    if (!this.viewReady || !this.geo.ready()) return null;
    const a = this.align.locate(ref); if (!a) return null;
    const len = cpLen(a.curText);
    return this.clientPoint({ ...a.cur, offset: toCurOffset(a.map, offset, len) }, len);
  }

  /**
   * 지금 편집기 문서에서 글 text 를 가진 nth 번째 문단(본문·1단 칸; exact 면 글 전체가 같음)의 그 글 시작 자리 iframe client 좌표.
   * 정렬과 무관하다 — 기준과 짝을 잃은 칸(표 격자가 바뀐 표)을 시험이 누를 때 쓴다
   */
  pointForText(text: string, nth = 1, exact = false): { x: number; y: number; page: number } | null {
    if (!this.viewReady || !this.geo.ready()) return null;
    const f = this.align.findCur(text, nth, exact);
    return f ? this.clientPoint({ ...f.cur, offset: f.offset }, f.len) : null;
  }

  /** 편집기 자리 → iframe client 좌표(글자 왼쪽 조금 안·줄 가운데). 화면 밖이면 먼저 스크롤한다 */
  private clientPoint(p: CurPoint, len: number): { x: number; y: number; page: number } | null {
    const c = this.geo.caretRect(p, len);
    if (!c) return null;
    const box = this.geo.toContent({ pageIndex: c.pageIndex, x: c.x, y: c.y, width: 0, height: c.height });
    const cont = this.geo.container();
    if (cont && (box.top < cont.scrollTop + 4 || box.top + box.height > cont.scrollTop + cont.clientHeight - 4)) {
      cont.scrollTop = Math.max(0, box.top - cont.clientHeight / 3);
    }
    const r = this.geo.contentToClient(box);
    return { x: r.x + 0.6 * this.geo.zoom(), y: r.y + r.h / 2, page: c.pageIndex };
  }

  currentText(ref: string): string | null {
    const a = this.align.locate(ref);
    return a ? a.curText : null;
  }

  /** 시험용: 기준 (ref, offset) 글자의 글자 모양(굵게·기울임·글자 모양 번호·색) — 맞추기가 손대지 않은 글의 서식을 지키는지 본다 */
  charProps(ref: string, offset: number): Record<string, unknown> | null {
    const a = this.align.locate(ref); const w = this.services?.wasm;
    if (!a || !w) return null;
    const o = toCurOffset(a.map, offset, cpLen(a.curText));
    const { sec, para, cell } = a.cur;
    const p = cell ? w.getCellCharPropertiesAt(sec, para, cell.ci, cell.cell, cell.cpara, o) : w.getCharPropertiesAt(sec, para, o);
    return { bold: !!p.bold, italic: !!p.italic, underline: !!p.underline, charShapeId: p.charShapeId ?? null, textColor: p.textColor ?? null };
  }

  /** 시험용: 맞추기 계획 요약(고치지 않음) — 문제는 첫 것에서 멈추지 않고 모두 */
  syncPlanInfo(): Record<string, unknown> {
    const issues: SyncIssue[] = [];
    const p = this.align.syncPlan(issues);
    const edits = p.ok ? p.edits.map((e) => (e.op === 'text'
      ? { op: 'text', at: `${e.cur.sec}/${e.cur.para}${e.cur.cell ? `/${e.cur.cell.ci}.${e.cur.cell.cell}.${e.cur.cell.cpara}` : ''}`, ops: e.ops }
      : e.op === 'del' ? { op: 'del', at: `${e.sec}/${e.para}` }
        : e.op === 'fold' ? { op: 'fold', at: `${e.sec}/${e.para}/${e.ci}.${e.cell}`, groups: e.groups, ops: e.ops }
          : { op: 'ins', at: `${e.sec}/${e.after}`, mode: e.mode, len: e.len, lines: e.lines })) : [];
    return p.ok
      ? { ok: true, edits, changed: docOrder(p.changed), inserted: docOrder(p.inserted), deleted: p.deleted, issues }
      : { ok: false, reason: p.reason, message: p.message, ref: p.ref ?? null, issues };
  }

  async settled(): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      await nextFrame(); await nextFrame();
      const busy = this.layoutTimer.pending() || this.draftTimer.pending() || this.selTimer.pending() || this.renderRaf.pending();
      if (!busy || performance.now() - t0 > 8000) return;
      await sleep(40);
    }
  }

  stats(): Record<string, unknown> {
    const ih = this.ih();
    const editor = ih ? safe('state', () => ({
      active: internals.isActive(ih), inTable: ih.isInTable(), cellSelection: ih.isInCellSelectionMode(),
      tableObject: ih.isInTableObjectSelection(), pictureObject: ih.isInPictureObjectSelection(), subEditor: internals.inSubEditor(ih),
      caret: jsonCopy(ih.getCursorPosition()), selection: jsonCopy(ih.getSelection()),
    })) ?? null : null;
    return {
      viewReady: this.viewReady, changeSeq: this.changeSeq, cleanSeq: this.cleanSeq, items: this.specs?.length ?? null, resolvedCache: this.geomCache.size,
      readOnly: this.options.readOnly, editMode: safe('ctx', () => this.services?.getContext().editMode) ?? null, pages: this.geo.pageCount(),
      canUndo: ih ? safe('undo', () => ih.canUndo()) ?? null : null, canRedo: ih ? safe('redo', () => ih.canRedo()) ?? null : null,
      align: { ...this.align.stats, hasBase: this.align.hasBase, baseVersion: this.align.baseVersion },
      perf: { ...this.perf }, busy: jsonCopy(this.busy), menuOpen: this.menu.isOpen(), toolbar: this.toolbar.visible, editor,
    };
  }

  // ───────── window.rhwpCowork ─────────

  private buildApi(): Record<string, unknown> {
    const self = this;
    // 호스트 → 플러그인: 모두 Promise, 인자는 이 realm 의 JSON 사본으로, 결과는 호스트 realm 의 JSON 사본으로
    const run = <T>(label: string, fn: () => T): Promise<T> => {
      try { return Promise.resolve(toHost(fn())); } catch (e) { console.warn(`[cowork] ${label}:`, e); return Promise.reject(new Error(e instanceof Error ? e.message : String(e))); }
    };
    return {
      version: PLUGIN_VERSION,
      features: [...PLUGIN_FEATURES],
      events: [...EVENT_NAMES],
      ready: this.ready,
      on(event: string, cb: (payload: unknown) => void): () => void { return self.emitter.on(String(event), cb); },
      setBase: (p: { version?: number; paragraphs?: EngineParagraph[] }) => run('setBase', () => { self.setBase(p); }),
      markClean: (p?: { changeSeq?: number }) => run('markClean', () => { self.markClean(jsonCopy(p ?? null)); }),
      setAnnotations: (a: Partial<Annotations>) => run('setAnnotations', () => { self.setAnnotations(a); }),
      setActive: (p: { kind: string; id: string } | null) => run('setActive', () => { self.setActive(p); }),
      getSelection: () => run('getSelection', () => self.computeSelection()),
      focusRange: (p: import('./types').RangeLocation & { flash?: boolean; select?: boolean }) => run('focusRange', () => self.focusRange(p)),
      rangeRects: (p: import('./types').RangeLocation) => run('rangeRects', () => toHost(self.rangeRects(p))),
      applyText: (p: TextArgs) => run('applyText', () => self.applyText(p)),
      insertParagraphAfter: (p: InsertArgs) => run('insertParagraphAfter', () => self.insertParagraphAfter(p)),
      applyBatch: (items: BatchItem[]) => run('applyBatch', () => self.applyBatch(items)),
      // v0.4(V4 §2.5): 편집기 글을 기준 글로 맞춤 · 남이 바꾼 자리 밑줄 깜빡임
      syncToBase: () => run('syncToBase', () => self.syncToBase()),
      flash: (ranges: unknown, opts?: FlashOptions) => run('flash', () => self.remoteFlash(jsonCopy(ranges ?? null), jsonCopy(opts ?? null))),
      draftState: () => run('draftState', () => self.draftState()),
      anchors: () => run('anchors', () => self.computeAnchors()),
      setOptions: (o: Partial<CoworkOptions>) => run('setOptions', () => { self.setOptions(o); }),
      debug: {
        /** 맞추기 계획(고치지 않음): 편집 요약·문제 목록 — 시험·문제 찾기 */
        syncPlan: () => toHost(self.syncPlanInfo()),
        overlays: () => toHost(self.overlay.snapshot()),
        selection: () => toHost(self.computeSelection()),
        pointFor: (ref: string, offset: number) => toHost(self.pointFor(String(ref), Number(offset) || 0)),
        pointForText: (text: string, nth?: number, exact?: boolean) => toHost(self.pointForText(String(text ?? ''), Math.max(1, Number(nth) || 1), exact === true)),
        select: (ref: string, start: number, end: number, endRef?: string) => self.selectBase(String(ref), Number(start) || 0, Number(end) || 0, endRef == null ? undefined : String(endRef)),
        text: (ref: string) => self.currentText(String(ref)),
        /** 지금 편집기 문서의 구역 sec 본문 문단 글(기준과 짝짓지 않은 그대로 — 차례처럼 새로 넣은 문단을 시험이 볼 때) */
        paragraphs: (sec?: number) => toHost(safe('paragraphs', () => {
          const w = self.services?.wasm; const s = Number(sec) || 0;
          if (!w) return [] as string[];
          return Array.from({ length: w.getParagraphCount(s) }, (_, i) => w.getTextRange(s, i, 0, w.getParagraphLength(s, i)));
        }) ?? []),
        charProps: (ref: string, offset: number) => toHost(safe('charProps', () => self.charProps(String(ref), Number(offset) || 0), null) ?? null),
        /** [hwpx-cowork] 편집기 문단 para 의 캐럿 자리 offset 앞 틈 조판 부호(시험용 — 표지·지우기 차례 확인) */
        codeGap: (para: number, offset: number, sec?: number) => toHost(safe('codeGap', () => (self.services?.wasm as any)?.getCodeGap?.({ sec: Number(sec) || 0, para: Number(para) || 0 }, Number(offset) || 0) ?? null, null) ?? null),
        settled: () => self.settled(),
        stats: () => toHost(self.stats()),
      },
    };
  }
}

// ───────── 도우미 ─────────

const round = (v: number): number => Math.round(v * 10) / 10;
const roundRect = (r: Rect): Rect => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) });

/** 묶음 안 순서값(본문: 구역·문단 차례, 칸: 칸 문단 번호) — 본문 묶음은 구역을 넘는다(docs/SECTIONS.md) */
const order = (p: CurPara): number => (p.cell ? p.cell.cpara : p.sec * 1e6 + p.para);

/** 같은 묶음인가 — 본문은 구역을 넘어도 한 묶음(구역을 넘는 선택·메모 범위), 칸은 같은 칸 */
function sameContainer(a: CurPara, b: CurPara): boolean {
  if (!a.cell && !b.cell) return true;
  return !!a.cell && !!b.cell && a.sec === b.sec && a.para === b.para && a.cell.ci === b.cell.ci && a.cell.cell === b.cell.cell;
}

/** 같은 문단(본문 문단 또는 같은 칸 문단)인가 */
function samePara(a: CurPara, b: CurPara): boolean {
  return sameContainer(a, b) && a.sec === b.sec && a.para === b.para && (a.cell?.cpara ?? -1) === (b.cell?.cpara ?? -1);
}

function samePoint(a: CurPoint, b: CurPoint): boolean {
  return samePara(a, b) && a.offset === b.offset;
}

/** 그린 것의 첫 사각형(레일 자리) */
function firstRect(it: OverlayItem): SelectionRect | null {
  return it.rects[0] ?? it.band?.[0] ?? (it.point ? { pageIndex: it.point.pageIndex, x: it.point.x, y: it.point.y, width: 0, height: it.point.height } : null);
}

/** 자리 열쇠(같은 자리면 같은 쪽 사각형) */
function geomKey(g: Geom): string {
  const pt = (p: CurPara & { offset?: number }): string => `${p.sec}.${p.para}${p.cell ? `.${p.cell.ci}.${p.cell.cell}.${p.cell.cpara}` : ''}${p.offset != null ? `@${p.offset}` : ''}`;
  switch (g.t) {
    case 'range': return `r|${pt(g.a)}|${pt(g.b)}|${g.len}`;
    case 'band': return `b|${pt(g.p)}|${g.len}|${g.first ? 1 : 0}`;
    case 'caret': return `c|${pt(g.p)}|${g.len}`;
    case 'after': return `a|${pt(g.p)}|${g.len}`;
    case 'gap': return `g|${g.sec}.${g.after}|${g.len}`;
    default: return '';
  }
}

function makeSpec(item: ItemBase, geom: Geom): ItemSpec {
  let sec: number; let from: number; let to: number;
  if (geom.t === 'range') { sec = geom.a.sec; from = Math.min(geom.a.para, geom.b.para); to = Math.max(geom.a.para, geom.b.para); }
  else if (geom.t === 'gap') { sec = geom.sec; from = to = Math.max(0, geom.after); }
  else { sec = geom.p.sec; from = to = geom.p.para; }
  return { item, geom, gk: geomKey(geom), sec, from, to };
}

/** 지금(내 수정본) 선택 글 — 한 문단 안만(여러 문단이면 첫 문단 끝까지) */
function selectedCurText(align: Alignment, s: CurPoint, e: CurPoint): string {
  const t = align.curText(s);
  return samePara(s, e) ? cpSlice(t, s.offset, e.offset) : cpSlice(t, s.offset);
}

// ───────── 내 수정본에 반영 도우미 ─────────

/** applyBatch 결과 열쇠: 받은 key 그대로(없으면 items 안 번호) */
function keyOf(it: unknown, k: number): BatchKey {
  const key = it && typeof it === 'object' ? (it as { key?: unknown }).key : undefined;
  return key === undefined || key === null ? k : (key as BatchKey);
}

/**
 * 같은 문단(같은 칸 문단)의 두 바꿈이 겹치는가: 범위가 한 글자라도 겹치거나, 시작이 같다(같은 자리에 넣기 둘, 넣기와 그 자리에서
 * 시작하는 바꿈 — 어느 쪽이 앞인지 정할 수 없다). 끝에 닿기만 한 것([0,3)·[3,5), 범위 끝에 넣기)은 겹치지 않는다.
 */
function overlaps(a: TextEdit, b: TextEdit): boolean {
  return samePara(a.cur, b.cur) && ((a.s < b.e && b.s < a.e) || a.s === b.s);
}

/**
 * 문서 순서 열쇠(작을수록 앞): 구역, 본문 문단, 그 문단 안 차례 — 본문 글(0) · 칸·캡션·글상자(1) · 그 문단 뒤에 넣기(2),
 * 칸이면 (ci, cell, cpara) 와 그 칸 문단 안 차례 — 글(0) · 그 칸 문단 뒤에 넣기(1), 마지막으로 글 자리.
 * 이 열쇠의 내림차순으로 고치면 먼저 고친 것이 아직 고치지 않은 것의 자리를 밀지 않는다: 바꿈은 그 자리 뒤 글만, 문단 뒤에 넣기는
 * 그 뒤 문단 번호(칸이면 그 칸의 뒤 문단 번호)만 민다. '그 뒤에 넣기'는 그 문단 글 바꾸기보다 먼저 고친다(나눌 자리 = 편집 전 길이).
 * 본문 글과 그 문단의 칸은 서로의 자리를 밀지 않으므로 둘 사이 차례는 정해 두기만 한다.
 */
function editKey(ed: Edit): number[] {
  const { sec, para, cell } = ed.cur;
  if (!cell) return ed.op === 'insert' ? [sec, para, 2, 0, 0, 0, 0, 0] : [sec, para, 0, 0, 0, 0, 0, ed.s];
  return ed.op === 'insert' ? [sec, para, 1, cell.ci, cell.cell, cell.cpara, 1, 0] : [sec, para, 1, cell.ci, cell.cell, cell.cpara, 0, ed.s];
}

function cmpKey(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 실제 적용 순서는 FIFO. 다음 편집이 처음 고른 글/문단을 계속 가리키게 한다. */
function advanceBatchEdits(pending: Edit[], applied: Edit, caret: CurPoint): void {
  const a = applied.cur;
  for (const next of pending) {
    const b = next.cur;
    if (applied.op === 'text') {
      if (!samePara(a, b)) continue;
      const delta = cpLen(applied.text) - (applied.e - applied.s);
      if (next.op === 'insert') next.len += delta;
      else if (next.s >= applied.e) { next.s += delta; next.e += delta; }
      continue;
    }
    const count = applied.lines.length;
    if (a.sec !== b.sec) continue;
    if (!a.cell) {
      if (next.op === 'insert') next.count += count;
      if (samePara(a, b) && next.op === 'insert') {
        next.cur = { sec: caret.sec, para: caret.para };
        next.len = caret.offset; next.objectOnly = false;
      } else if (b.para > a.para) b.para += count;
    } else if (sameContainer(a, b) && b.cell) {
      if (samePara(a, b) && next.op === 'insert') {
        next.cur = { sec: caret.sec, para: caret.para, cell: { ...caret.cell! } };
        next.len = caret.offset;
      } else if (b.cell.cpara > a.cell.cpara) b.cell.cpara += count;
    }
  }
}

/** 트랜잭션 전 캐럿 자리: 바꿈은 시작, 문단 뒤에 넣기는 나눌 자리(표·그림만 있는 문단은 그 문단 앞) */
function caretBefore(ed: Edit): CurPoint {
  if (ed.op === 'text') return { ...ed.cur, offset: ed.s };
  return { ...ed.cur, offset: ed.objectOnly ? 0 : ed.len };
}

/** 트랜잭션 안에서 하나 고치기 → 고친 글 끝 자리(캐럿용) */
function runEdit(doc: Doc, ed: Edit): CurPoint {
  const { sec, para, cell } = ed.cur;
  if (ed.op === 'text') {
    const { s, e, text } = ed;
    const shapeDoc = requireCharShapeRunsDocument(doc);
    const length = cell ? doc.getCellParagraphLength(sec, para, cell.ci, cell.cell, cell.cpara) : doc.getParagraphLength(sec, para);
    const oldText = length ? (cell ? doc.getTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, 0, length) : doc.getTextRange(sec, para, 0, length)) : '';
    const path = cell ? JSON.stringify([{ controlIndex: cell.ci, cellIndex: cell.cell, cellParaIndex: cell.cpara }]) : null;
    const previous = parseCharShapeRuns(path ? shapeDoc.getCharShapeRunsInCellByPath(sec, para, path, 0, length) : shapeDoc.getCharShapeRuns(sec, para, 0, length), 0, length);
    const replacement = cpSlice(oldText, 0, s) + text + cpSlice(oldText, e);
    const ids: number[] = projectTextFormats(oldText, replacement, previous.map(r => ({ start: r.startOffset, end: r.endOffset, charPrId: r.charShapeId })), String(previous[0]?.charShapeId ?? 0)).map(Number);
    if (!cell) doc.replaceText(sec, para, s, e - s, text);
    else {
      // 표 칸·캡션·글상자: 정렬이 1단 칸만 짓으므로 studio 의 1단 칸 편집(command.ts doInsert/DeleteTextImmediate)과 같은 평면 API.
      // …ByPath 는 studio 도 칸 안의 표(2단 이상)에만 쓴다
      if (e > s) doc.deleteTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, s, e - s);
      if (text) doc.insertTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, s, text);
    }
    // replaceText의 첫 글자 모양 상속을 덮어쓴다. 변경되지 않은 글자는 본래 run을 유지한다.
    const runs: Array<{ startOffset: number; endOffset: number; charShapeId: number }> = [];
    ids.forEach((id, i) => { const last = runs[runs.length - 1]; if (last?.charShapeId === id) last.endOffset = i + 1; else runs.push({ startOffset: i, endOffset: i + 1, charShapeId: id }); });
    if (ids.length) {
      if (path) shapeDoc.setCharShapeRunsInCellByPath(sec, para, path, 0, ids.length, JSON.stringify(runs));
      else shapeDoc.setCharShapeRuns(sec, para, 0, ids.length, JSON.stringify(runs));
    }
    return { ...ed.cur, offset: s + cpLen(text) };
  }
  const { lines } = ed;
  if (!cell) {
    // 표·그림만 있는 문단을 끝에서 나누면 개체가 따라갈 수 있어 다음 문단 앞을 나눈다(마지막 문단이면 그대로 끝에서)
    let at: number;
    if (ed.objectOnly && para + 1 < ed.count) { doc.splitParagraph(sec, para + 1, 0); at = para + 1; }
    else { doc.splitParagraph(sec, para, ed.len); at = para + 1; }
    lines.forEach((line, k) => {
      if (k > 0) { doc.splitParagraph(sec, at, cpLen(lines[k - 1])); at++; }
      if (line) doc.insertText(sec, at, 0, line);
    });
    return { sec, para: at, offset: cpLen(lines[lines.length - 1]) };
  }
  const pathFor = (cp: number) => JSON.stringify([{ controlIndex: cell.ci, cellIndex: cell.cell, cellParaIndex: cp }]);
  doc.splitParagraphInCellByPath(sec, para, pathFor(cell.cpara), ed.len);
  let cp = cell.cpara + 1;
  lines.forEach((line, k) => {
    if (k > 0) { doc.splitParagraphInCellByPath(sec, para, pathFor(cp), cpLen(lines[k - 1])); cp++; }
    if (line) doc.insertTextInCellByPath(sec, para, pathFor(cp), 0, line);
  });
  return { sec, para, offset: cpLen(lines[lines.length - 1]), cell: { ...cell, cpara: cp } };
}

// ───────── 맞추기(syncToBase) 도우미 ─────────

/**
 * 맞추기 편집 하나(트랜잭션 안, 편집 전 문서 자리 — SyncPlan.edits 차례로 부르면 자리가 밀리지 않는다).
 * 본문 글: 조각을 뒤에서부터 replaceText/deleteText/insertText. 칸 글: deleteTextInCell + insertTextInCell(runEdit 와 같은 1단 칸 평면 API).
 * 문단 지우기: deleteParagraph. 문단 넣기: 'after' 는 그 문단을 끝(논리 길이)에서, 'before' 는 다음 문단을 앞에서 나눠 생긴 빈 문단에
 * 줄마다 문단 하나(runEdit 의 넣기와 같은 꼴).
 * 칸 접기(fold): 그 칸의 칸 문단을 앞에서부터 묶음마다 — 둘 이상이면 다음 문단을 합치고(mergeParagraphInCell = 칸 안 Backspace) 합친 자리에
 * '\n'(줄바꿈 — 문단을 나누지 않는다), 0 이면 빈 칸 문단을 만든다(앞 문단 끝·칸 맨 앞이면 첫 문단 앞에서 splitParagraphInCell). 그다음 접힌
 * 칸 문단마다 글 조각(남의 고침)을 뒤에서부터. 다른 칸·본문 문단 자리는 밀지 않는다.
 */
function runSyncEdit(doc: Doc, ed: SyncEdit): void {
  if (ed.op === 'fold') {
    const { sec, para, ci, cell, groups } = ed;
    let at = 0;
    for (const n of groups) {
      if (n === 0) {
        if (at > 0) doc.splitParagraphInCell(sec, para, ci, cell, at - 1, doc.getCellParagraphLength(sec, para, ci, cell, at - 1));
        else doc.splitParagraphInCell(sec, para, ci, cell, 0, 0);
      }
      for (let k = 1; k < n; k++) {
        // 합친 자리 = 합치기 전 앞 문단 길이(rhwp 가 돌려주는 charOffset 이 있으면 그것)
        let point = doc.getCellParagraphLength(sec, para, ci, cell, at);
        const raw = doc.mergeParagraphInCell(sec, para, ci, cell, at + 1);
        try { const r = JSON.parse(raw) as { charOffset?: unknown }; if (Number.isInteger(r?.charOffset)) point = Number(r.charOffset); } catch { /* 길이 그대로 */ }
        doc.insertTextInCell(sec, para, ci, cell, at, point, '\n');
      }
      at++;
    }
    ed.ops.forEach((ops, k) => {
      if (!ops) return;
      for (let t = ops.length - 1; t >= 0; t--) {
        const { s, e, text } = ops[t];
        if (e > s) doc.deleteTextInCell(sec, para, ci, cell, k, s, e - s);
        if (text) doc.insertTextInCell(sec, para, ci, cell, k, s, text);
      }
    });
    return;
  }
  if (ed.op === 'text') {
    const { sec, para, cell } = ed.cur;
    for (let k = ed.ops.length - 1; k >= 0; k--) {
      const { s, e, text } = ed.ops[k];
      if (!cell) {
        if (e > s && text) doc.replaceText(sec, para, s, e - s, text);
        else if (e > s) doc.deleteText(sec, para, s, e - s);
        else if (text) doc.insertText(sec, para, s, text);
      } else {
        if (e > s) doc.deleteTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, s, e - s);
        if (text) doc.insertTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, s, text);
      }
    }
    return;
  }
  if (ed.op === 'del') { doc.deleteParagraph(ed.sec, ed.para); return; }
  const { sec, after, lines } = ed;
  const at0 = after + 1;
  if (ed.mode === 'after') doc.splitParagraph(sec, after, ed.len);
  else doc.splitParagraph(sec, at0, 0);
  let at = at0;
  lines.forEach((line, k) => {
    if (k > 0) { doc.splitParagraph(sec, at, cpLen(lines[k - 1])); at++; }
    if (line) doc.insertText(sec, at, 0, line);
  });
}

/** 맞춘 뒤 확인(트랜잭션 안): 고친 구역의 문단 수 = 기준, 고친·넣은 문단의 글 = 기준 글. 다르면 그 까닭(던져서 롤백한다) */
function verifySync(w: WasmBridge, plan: SyncPlan): string | null {
  for (const { sec, n } of plan.expect.counts) {
    const got = w.getParagraphCount(sec);
    if (got !== n) return `구역 ${sec} 문단 수 ${got} ≠ 기준 ${n}`;
  }
  for (const c of plan.expect.cells) {
    const got = w.getCellParagraphCount(c.sec, c.para, c.ci, c.cell);
    if (got !== c.n) return `칸 ${c.sec}/${c.para}/${c.ci}.${c.cell} 칸 문단 수 ${got} ≠ 기준 ${c.n}`;
  }
  for (const t of plan.expect.texts) {
    const { sec, para, cell } = t.cur;
    let got: string;
    if (!cell) {
      const len = w.getParagraphLength(sec, para);
      got = len > 0 ? w.getTextRange(sec, para, 0, len) : '';
    } else {
      const len = w.getCellParagraphLength(sec, para, cell.ci, cell.cell, cell.cpara);
      got = len > 0 ? w.getTextInCell(sec, para, cell.ci, cell.cell, cell.cpara, 0, len) : '';
    }
    if (got !== t.text) return `${t.ref} 글이 기준과 다릅니다(「${clip(got, 30)}」 ≠ 「${clip(t.text, 30)}」)`;
  }
  return null;
}

/** 기준 ref 를 문서 차례로(구역 → 본문 문단 → 중첩 번호) */
function docOrder(refs: string[]): string[] {
  const key = (r: string): number[] => (r.match(/\d+/g) ?? []).map(Number);
  return [...refs].sort((a, b) => cmpKey(key(a), key(b)) || (a.length - b.length));
}

/** 반영 중 예외 → 결과(문서가 해제됨 = READONLY, 그 밖 = ERROR) */
function failure(label: string, err: unknown): ApplyResult {
  const code = (err as { code?: string })?.code;
  console.warn(`[cowork] ${label} 실패:`, err);
  return code === 'DOCUMENT_RELEASED' ? { ok: false, reason: 'READONLY' } : { ok: false, reason: 'ERROR', message: String((err as Error)?.message ?? err) };
}

/**
 * applyText 의 범위(지금 문단 offset): start/end(기준 offset)를 옮긴 자리의 글이 find 와 같으면 그대로,
 * 아니면 지금 글에서 find 를 찾는다 — 기준의 occurrence 번째 자리(옮김)에 가장 가까운 것. find 가 '' 이면 문단 끝 한 점(빈 칸 채우기),
 * find·start·end 가 다 없으면 문단 전체.
 */
function findInCurrent(a: Located, x: { find?: string; occurrence?: number; start?: number; end?: number }): [number, number] | null {
  const cur = a.curText; const curLen = cpLen(cur);
  const find = x.find == null ? null : String(x.find);
  if (x.start != null && x.end != null) {
    const s = toCurOffset(a.map, Number(x.start), curLen); const e = toCurEnd(a.map, Number(x.start), Number(x.end), curLen);
    if (find == null || find === '' || cpSlice(cur, Math.min(s, e), Math.max(s, e)) === find) return [Math.min(s, e), Math.max(s, e)];
  }
  if (find == null) return x.start == null && x.end == null ? [0, curLen] : null;
  if (find === '') return [curLen, curLen];
  const C = cps(cur); const F = cps(find);
  const hits: number[] = [];
  for (let i = 0; i + F.length <= C.length; i++) {
    let ok = true;
    for (let k = 0; k < F.length; k++) if (C[i + k] !== F[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (!hits.length) return null;
  // 기준 글에서 occurrence 번째 자리 → 지금 자리로 옮겨 가장 가까운 것
  const B = cps(a.baseText); const occ = Math.max(1, Number(x.occurrence) || 1);
  let seen = 0; let baseAt = -1;
  for (let i = 0; i + F.length <= B.length; i++) {
    let ok = true;
    for (let k = 0; k < F.length; k++) if (B[i + k] !== F[k]) { ok = false; break; }
    if (ok && ++seen === occ) { baseAt = i; break; }
  }
  let at = hits[Math.min(occ, hits.length) - 1];
  if (baseAt >= 0) {
    const want = toCurOffset(a.map, baseAt, curLen);
    at = hits.reduce((best, h) => (Math.abs(h - want) < Math.abs(best - want) ? h : best), hits[0]);
  }
  return [at, at + F.length];
}
