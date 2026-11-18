// 기준 문서(서버 current.hwpx, setBase 의 문단 목록) ↔ 편집기 문서(내 수정본) 정렬 — docs/V3_SPEC.md §1.3 '기준 ↔ 내 수정본 정렬'.
// 본문은 엔진과 같은 코드(@cowork/engine/diff.js 의 planBody)로 글 + 구조(빈 줄·표·개체)를 보고 짝짓고,
// 짝지어진 문단 안 offset 은 refmap.alignOffsets, 표 칸·캡션·글상자는 refmap.rhwpNestedList 로 읽은 칸 목록을
// 기준 칸 정보(표 순번·행·열)와 맞춘다(구조가 같으면 차례대로, 다르면 글이 같은 칸부터 → 남은 틈은 같은 자리 칸끼리).
// 표 칸은 그 표의 격자(행·열 수)가 기준과 같고 줄이 밀리지 않았을 때만 짝짓는다(§1.3) — 줄·칸을 넣거나 지우면 같은 (표, 행, 열)
// 자리에 다른 칸이 온다.
// 플러그인은 덩어리(hunk)를 만들지 않는다(서버가 수정본 저장 때 계산) — 위치 옮기기·내가 바꾼 문단 표시에만 쓴다.
// 편집기 쪽 읽기는 싸다(2025 종합보고서 본문 479 + 중첩 3,623: 본문 ~1ms, 중첩 전부 ~13ms, Node 기준) —
// 구조 변경은 전체를 다시 읽고(lazy), 입력기가 보증한 한 문단의 글 편집은 그 문단/표만 다시 읽는다.
import type { WasmBridge } from '@/core/wasm-bridge';
import { planBody, charOps, foldOwners } from '@cowork/engine/diff.js';
import { alignOffsets, lcsPairs, rhwpNestedList } from '@cowork/web/refmap.js';
import type { EngineParagraph, DraftState } from './types';
import { cpLen, cps, normText } from './util';

/** 편집기(내 수정본) 문단 자리: 본문이면 cell 없음. 표 칸·캡션·글상자면 cell(그 표·개체를 품은 본문 문단 = para) */
export interface CurPara {
  sec: number;
  para: number;
  cell?: { ci: number; cell: number; cpara: number; kind: 'cell' | 'caption' | 'shape' };
}

/** 글자 자리 지도: 기준 offset → 지금 offset(b2c), 거꾸로(c2b). null 이면 글이 같다(그대로) */
export interface OffMap { b2c: Int32Array; c2b: Int32Array }

/** 기준 ref → 편집기 자리 */
export interface Located { ref: string; cur: CurPara; baseText: string; curText: string; map: OffMap | null }

/** 편집기 자리 → 기준 ref. inserted = 기준에 없는 문단(내가 넣음) — ref 는 그 앞 기준 문단(맨 앞이면 첫 문단) */
export interface BaseLoc {
  ref: string; baseText: string; curText: string; map: OffMap | null;
  inserted: boolean; afterRef: string | null; approx: boolean;
  cell: { table: string; row: number; col: number } | null;
}

/** 내가 바꾼 문단: state = 기준 ref(호스트용 DraftState), marks = 편집기 자리(화면 표시용) */
export interface DraftOut {
  state: Omit<DraftState, 'dirty'>;
  marks: { changed: CurPara[]; inserted: CurPara[]; deleted: Array<{ sec: number; after: number }> };
}

/** 글 조각 바꾸기: 지금(편집기) 글 [s, e) 를 text 로 — 코드포인트 자리 */
export interface TextOp { s: number; e: number; text: string }

/**
 * 맞추기(syncToBase — docs/V4_SPEC.md §2.5) 편집 하나. 자리는 모두 편집 전 문서(편집기)의 것이고, SyncPlan.edits 차례(문서 뒤쪽부터)로
 * 고치면 아직 고치지 않은 편집의 자리가 밀리지 않는다.
 *  - text: 짝지은 문단(본문, 또는 1단 칸·캡션·글상자 문단)의 글 조각들. ops 는 앞에서부터(겹치지 않음) — 뒤에서부터 고친다.
 *  - del:  편집기에만 있는 본문 문단 지우기(글·빈 문단이고 컨트롤이 하나도 없는 문단만).
 *  - ins:  기준에만 있는 본문 문단들(lines — 문단마다 한 줄, 기준 차례) 넣기. after = 앞 짝 편집기 문단(-1 = 구역 맨 앞).
 *          mode 'after' = after 문단을 끝(논리 길이 len)에서 나눠 그 뒤에, 'before' = after + 1 자리 문단(그 사이 편집기에만 있는 문단을
 *          지운 뒤의 다음 짝 문단)을 앞(0)에서 나눠 그 앞에(표·그림이 끝에 붙은 문단, 구역 맨 앞).
 *  - fold: 칸 문단 수만 기준과 다른 1단 표 칸 하나(본문 문단 para 의 컨트롤 ci, 칸 cell) — 칸 안 Enter·Backspace 를 서버가 줄바꿈으로 접어
 *          넣은 모양(cellFolds). groups[k] = 기준 칸 문단 k 가 될 편집기 칸 문단 수(차례대로): 둘 이상이면 뒤 문단들을 앞 문단에 합치며
 *          합친 자리마다 '\n'(줄바꿈)을 넣고, 0 이면 그 자리에 빈 칸 문단을 만든다(앞 문단을 끝에서, 칸 맨 앞이면 첫 문단을 앞에서 나눔).
 *          그다음 ops[k](있으면) = 접힌 칸 문단 k 의 글 조각(남의 고침 — 접힌 글 기준, 앞에서부터).
 */
export type SyncEdit =
  | { op: 'text'; cur: CurPara; ops: TextOp[] }
  | { op: 'del'; sec: number; para: number }
  | { op: 'ins'; sec: number; after: number; mode: 'after' | 'before'; len: number; lines: string[] }
  | { op: 'fold'; sec: number; para: number; ci: number; cell: number; groups: number[]; ops: Array<TextOp[] | null> };

/** 맞추기 계획(편집 전 문서로 세운다) */
export interface SyncPlan {
  ok: true;
  /** 고칠 차례(문서 뒤쪽부터). 비면 고칠 것이 없다 */
  edits: SyncEdit[];
  /** 기준 ref — 글을 바꾼 문단(본문·칸), 넣은 본문 문단 */
  changed: string[];
  inserted: string[];
  /** 지운 편집기 문단 수(기준 ref 가 없다) */
  deleted: number;
  /**
   * 고친 뒤 확인할 것(트랜잭션 안에서 — 다르면 롤백): 구역마다 문단 수 = 기준, 고친·넣은 문단(편집 뒤 자리 = 기준 자리)의 글,
   * 접은 칸(fold)의 칸 문단 수 = 기준(para = 편집 뒤 본문 번호)
   */
  expect: {
    counts: Array<{ sec: number; n: number }>; texts: Array<{ cur: CurPara; text: string; ref: string }>;
    cells: Array<{ sec: number; para: number; ci: number; cell: number; n: number }>;
  };
  /** 편집 전 편집기 자리 → 편집 뒤 자리(캐럿·선택 옮기기). 고친 뒤 본문 문단 번호는 기준 번호와 같다 */
  mapPoint(p: CurPara & { offset: number }): CurPara & { offset: number };
}
export interface SyncFail { ok: false; reason: 'STRUCTURE'; message: string; ref?: string }
/** 계획 세울 때 본 문제(시험·문제 찾기용 debug.syncPlan — 맞추기는 첫 문제에서 멈춘다) */
export interface SyncIssue { what: string; ref?: string; detail?: string }

/** 맞추기에서 한 문단의 글 조각이 이보다 많으면 앞뒤 같은 부분을 뺀 가운데 하나로 바꾼다(조각마다 studio 다시 조판) */
const SYNC_MAX_OPS = 8;
const TEXTUAL_KIND = (k: string): boolean => k === 'text' || k === 'empty';

interface BaseBody { ref: string; sec: number; idx: number; text: string; kind: string; sig: string | null; nested: EngineParagraph[] }
/** 편집기 본문 문단: ctrls = 그 문단이 직접 가진 컨트롤 수(표·그림뿐 아니라 구역 정의·필드 등 모두) */
interface CurBody { text: string; kind: string; sig: string | null; ctrls: number }
type PlanOp = { op: 'pair'; i: number; j: number } | { op: 'del'; i: number } | { op: 'ins'; j: number };
interface SecPlan { b2c: Int32Array; c2b: Int32Array; plan: Array<{ at: number; ops: PlanOp[] }> }
interface RhItem {
  pos: { sec: number; parentPara: number; controlIdx: number; cellIdx: number; cellParaIdx: number };
  text: string; kind: 'cell' | 'caption' | 'shape'; tableOrd?: number; row?: number; col?: number; rowSpan?: number; colSpan?: number;
}
interface NestedMap {
  items: RhItem[]; base: EngineParagraph[]; b2r: Map<string, number>; r2b: Map<string, string>;
  /** 표 격자(표 수·표마다 행x열)가 기준과 다르거나 줄이 밀린 표가 있다 — 그 표의 칸은 짝짓지 않았다(draft() 는 이 문단을 바꾼 문단으로 낸다) */
  structure: boolean;
}
/** 표 격자 재기용 칸 모양(표 순번·행·열·병합) */
interface CellShape { ord: number; row?: number | null; col?: number | null; rowSpan?: number | null; colSpan?: number | null }
/**
 * 칸 접기 계획(cellFolds — 칸 하나): ci·cell = 편집기 컨트롤·칸 번호, base = 기준 칸 문단(차례), groups = SyncEdit fold 의 묶음 수,
 * ops[k] = 접힌 칸 문단 k 를 기준 글로 만드는 글 조각(같으면 null), at[k] = 편집기 칸 문단 k 가 접힌 뒤 [기준 칸 문단 번호, 접힌 글 안 시작
 * offset](캐럿 옮기기 — 그 뒤 ops 로 한 번 더 옮긴다)
 */
interface CellFold { ci: number; cell: number; base: EngineParagraph[]; groups: number[]; ops: Array<TextOp[] | null>; at: Array<[number, number]> }

const BODY_RE = /^s(\d+)\/p(\d+)$/;
const TOP_RE = /^(s(\d+)\/p(\d+))(?:\/|$)/;
const tableOrdOf = (key: string | undefined): number => Number(/#t(\d+)$/.exec(key ?? '')?.[1] ?? NaN);
const posKey = (ci: number, cell: number, cpara: number): string => `${ci}:${cell}:${cpara}`;
/** 보이는 글이 같은가 — 공백 묶음만 하나로 본다(rhwp 는 캡션 자동 번호 자리에 칸을 하나 더 두어 '[표  ]' 로 읽는다) */
export const sameText = (a: string, b: string): boolean => a === b || a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** 표 구조 표시(플러그인 안에서만 씀 — 양쪽을 같은 규칙으로 만든다): 본문 문단이 직접 가진 표마다 '행x열' */
const sigOf = (tables: string[]): string | null => (tables.length ? `T${tables.join(',')}` : null);

/**
 * 표 격자: 표 순번 → '행x열'. 칸의 (행 + 행 병합)·(열 + 열 병합) 최댓값으로 잰다 — 기준(엔진 칸 정보)과 편집기(rhwp getCellInfo)를
 * 같은 규칙으로 재야 손대지 않은 표가 늘 같게 나온다.
 */
function gridOf(cells: CellShape[]): Map<number, string> {
  const dims = new Map<number, { rows: number; cols: number }>();
  for (const c of cells) {
    if (!Number.isFinite(c.ord)) continue;
    const d = dims.get(c.ord) ?? { rows: 0, cols: 0 };
    d.rows = Math.max(d.rows, (Number(c.row) || 0) + (Number(c.rowSpan) || 1));
    d.cols = Math.max(d.cols, (Number(c.col) || 0) + (Number(c.colSpan) || 1));
    dims.set(c.ord, d);
  }
  const out = new Map<number, string>();
  for (const [k, d] of dims) out.set(k, `${d.rows}x${d.cols}`);
  return out;
}
const baseShape = (e: EngineParagraph): CellShape => ({ ord: tableOrdOf(e.cell?.table), row: e.cell?.row, col: e.cell?.col, rowSpan: e.cell?.rowSpan, colSpan: e.cell?.colSpan });
const curShape = (r: RhItem): CellShape => ({ ord: r.tableOrd ?? NaN, row: r.row, col: r.col, rowSpan: r.rowSpan, colSpan: r.colSpan });

/** 기준 칸 ↔ rhwp 칸이 같은 자리인가(표 순번·행·열, 캡션·글상자는 칸이 아닌 것끼리) */
function shapeEq(e: EngineParagraph, r: RhItem): boolean {
  if (e.cell) return r.kind === 'cell' && tableOrdOf(e.cell.table) === r.tableOrd && e.cell.row === r.row && e.cell.col === r.col;
  return r.kind !== 'cell';
}

export class Alignment {
  hasBase = false;
  baseVersion = 0;
  private baseByRef = new Map<string, EngineParagraph>();
  /** 본문 문단 ref → 그 문단이 직접 가진 첫 표의 열쇠('<ref>#t0') */
  private tableOfBody = new Map<string, string>();
  private bodies: BaseBody[][] = [];
  /** 기준에서 중첩 문단(메모 본문 빼고)을 품은 문단 ref — 칸 접기는 그런 칸 문단(칸 속 표·글상자)이 든 칸을 접지 않는다 */
  private parents = new Set<string>();
  private cur: CurBody[][] | null = null;
  /** 순수 글 편집으로 바뀐 자리. 글은 다음 ensure()에서 읽어 키 입력 자체는 캐시 무효화만 한다. */
  private textDirty = new Map<string, CurPara>();
  private plans: SecPlan[] = [];
  private nested = new Map<string, NestedMap>();
  private offs = new Map<string, { bt: string; ct: string; map: OffMap | null }>();
  /** draft() 결과 — 문서·기준이 바뀌기 전까지(invalidate) 다시 쓴다(강조 그리기와 'draft' 이벤트가 같이 쓴다) */
  private draftMemo: DraftOut | null = null;
  /**
   * 맞추기가 보지 못하는 기준 글(머리말·꼬리말·각주 등 칸 지도 밖의 중첩 문단, 칸 안의 표 같은 2단 중첩)의 서명 — 문서를 연 뒤 첫 setBase 가
   * 기준점이고, 그 뒤 setBase 에서 서명이 달라지면 unmappedStale(문서를 다시 열 때까지). 그때 맞추기는 STRUCTURE 다 — 편집기에 그 글을
   * 들일 수 없어, 그대로 두면 다음 밀어 넣기가 남의 고침을 되돌린다(서버 diffDocs 는 중첩 문단을 모두 견준다).
   */
  private unmappedSig: string | null = null;
  unmappedStale = false;
  /**
   * 본문을 다시 읽은 횟수·마지막 걸린 시간(ms), 짝지은 본문 문단 수 — debug.stats().
   * sigDiff = 짝지은 본문 문단 중 표 구조 표시(sig)가 다른 수, gridChanged = 마지막 draft() 에서 표 격자가 바뀌었거나 줄이 밀린 문단 수
   * (손대지 않은 문서는 둘 다 0 이어야 한다 — 시험이 확인)
   */
  stats = { scans: 0, lastScanMs: 0, textRefreshes: 0, lastTextRefreshMs: 0, paragraphReads: 0, cellTextReads: 0, lastNestedMs: 0, nestedBuilt: 0, drafts: 0, lastDraftMs: 0, basePara: 0, curPara: 0, paired: 0, sigDiff: 0, gridChanged: 0 };

  constructor(private readonly wasm: () => WasmBridge | null) {}

  // ───────── 기준 ─────────

  setBase(version: number, paragraphs: EngineParagraph[]): void {
    this.baseVersion = Number(version) || 0;
    this.baseByRef.clear();
    this.tableOfBody.clear();
    this.parents.clear();
    const bodies: BaseBody[][] = [];
    const nestedOf = new Map<string, EngineParagraph[]>();
    for (const p of Array.isArray(paragraphs) ? paragraphs : []) {
      if (!p || typeof p.ref !== 'string' || p.where === '메모' || this.baseByRef.has(p.ref)) continue;
      const q: EngineParagraph = { ref: p.ref, text: String(p.text ?? ''), where: p.where, parent: p.parent ?? null, container: p.container ?? null, cell: p.cell ?? null, kind: p.kind, sig: p.sig ?? null };
      this.baseByRef.set(q.ref, q);
      if (q.parent) this.parents.add(q.parent);
      const m = BODY_RE.exec(q.ref);
      if (m && !q.parent) {
        const sec = Number(m[1]); const idx = Number(m[2]);
        (bodies[sec] ??= [])[idx] = { ref: q.ref, sec, idx, text: q.text, kind: '', sig: null, nested: [] };
      } else if (q.parent) {
        const list = nestedOf.get(q.parent) ?? []; list.push(q); nestedOf.set(q.parent, list);
        if (q.cell?.table && q.cell.table.startsWith(`${q.parent}#t`) && !this.tableOfBody.has(q.parent)) this.tableOfBody.set(q.parent, q.cell.table);
      }
    }
    // 빈 자리(목록에 없는 문단)는 빈 글로 메운다 — 번호가 곧 자리라서
    for (let s = 0; s < bodies.length; s++) {
      const list = bodies[s] ?? (bodies[s] = []);
      for (let i = 0; i < list.length; i++) if (!list[i]) list[i] = { ref: `s${s}/p${i}`, sec: s, idx: i, text: '', kind: 'empty', sig: null, nested: [] };
      for (const b of list) {
        b.nested = nestedOf.get(b.ref) ?? [];
        const src = this.baseByRef.get(b.ref);
        // 표 구조: 본문 문단이 직접 가진 표(열쇠가 '<ref>#t<n>')의 행·열 수(칸 짝짓기의 격자 비교와 같은 gridOf)
        const cells: CellShape[] = [];
        let objects = 0;
        for (const n of b.nested) {
          if (n.cell && n.cell.table.startsWith(`${b.ref}#t`)) cells.push(baseShape(n));
          else if (!n.cell && n.container !== 'hp:tbl' && !/header|footer/i.test(String(n.container))) objects++;
        }
        const tables = [...gridOf(cells).entries()].sort((a, c) => a[0] - c[0]).map(([, d]) => d);
        b.sig = sigOf(tables);
        b.kind = src?.kind ? String(src.kind) : (b.text ? 'text' : tables.length ? 'table' : objects ? 'object' : 'empty');
      }
    }
    this.bodies = bodies;
    this.hasBase = true;
    // 맞추기가 보지 못하는 글의 서명(종류·글 — 자리(ref)는 문단을 넣고 지우면 밀리므로 쓰지 않는다)
    const unmapped: string[] = [];
    for (const q of this.baseByRef.values()) {
      if (!q.parent) continue;
      if (BODY_RE.test(q.parent) && syncMapped(q)) continue;
      unmapped.push(`${q.container ?? ''}\u0001${q.text}`);
    }
    const sig = unmapped.sort().join('\u0000');
    if (this.unmappedSig !== null && sig !== this.unmappedSig) this.unmappedStale = true;
    this.unmappedSig = sig;
    this.invalidate();
  }

  /** 문서를 새로 열었다(편집기 글 = 그 판의 기준) — 다음 setBase 가 맞추기의 새 기준점 */
  resetBaseline(): void { this.unmappedSig = null; this.unmappedStale = false; }

  baseParagraph(ref: string): EngineParagraph | null { return this.baseByRef.get(ref) ?? null; }
  baseText(ref: string): string { return this.baseByRef.get(ref)?.text ?? ''; }
  /** 기준 문단 목록(paragraphGeo 용) */
  baseParagraphs(): EngineParagraph[] { return [...this.baseByRef.values()]; }
  /** 표 열쇠: 칸 문단이면 그 표, 표를 품은 본문 문단이면 그 문단의 첫 표, 아니면 null */
  tableKeyOf(ref: string): string | null {
    return this.baseByRef.get(ref)?.cell?.table ?? this.tableOfBody.get(ref) ?? null;
  }

  // ───────── 편집기 문서 읽기 ─────────

  /** 문서가 바뀌었다 — 다음에 필요할 때 다시 읽는다 */
  invalidate(): void { this.cur = null; this.textDirty.clear(); this.plans = []; this.nested.clear(); this.offs.clear(); this.draftMemo = null; }
  /** 입력기가 구조 불변을 보증한 insertText/deleteText 전용. 일반 명령·히스토리·기준 변경은 invalidate(). */
  invalidateText(cur: CurPara): void {
    if (!this.cur) return; // 이미 전체 무효이면 부분 갱신으로 바꾸지 않는다.
    const key = `${cur.sec}:${cur.para}${cur.cell ? `:${cur.cell.ci}:${cur.cell.cell}:${cur.cell.cpara}` : ''}`;
    this.textDirty.set(key, cur);
    this.draftMemo = null;
  }
  get stale(): boolean { return this.cur === null || this.textDirty.size > 0; }

  ensure(): boolean {
    if (this.cur && !this.textDirty.size) return true;
    const w = this.wasm();
    if (!w || !(w.pageCount > 0)) return false;
    const t0 = performance.now();
    let cur = this.cur;
    let incremental = !!cur;
    let bodyChanged = false;
    if (cur) {
      const dirty = [...this.textDirty.values()];
      // 힌트는 입력기의 보수적인 짧은 글 편집 경로에서만 온다. 예상 밖의 구조 변화는 전체 읽기로 되돌린다.
      const secs = new Set(dirty.map((p) => p.sec));
      if (w.getSectionCount() !== cur.length || [...secs].some((s) => w.getParagraphCount(s) !== cur![s]?.length)) {
        cur = null; incremental = false;
      } else {
        const read = new Set<string>();
        const touched = new Map<string, NestedMap>();
        for (const p of dirty) {
          if (!cur[p.sec]?.[p.para]) { cur = null; incremental = false; break; }
          if (p.cell) {
            // 구조 불변인 칸 글 편집은 그 칸 문단만 읽는다. 큰 표 하나에 수천 개 칸이 있어도 모두 읽지 않는다.
            for (const [key, nm] of this.nested) {
              const [sec, , para] = key.split(':').map(Number);
              if (sec !== p.sec || para !== p.para) continue;
              const it = nm.items.find((r) => r.pos.controlIdx === p.cell!.ci && r.pos.cellIdx === p.cell!.cell && r.pos.cellParaIdx === p.cell!.cpara);
              if (!it) { this.nested.delete(key); touched.delete(key); continue; }
              try {
                const len = w.getCellParagraphLength(p.sec, p.para, p.cell.ci, p.cell.cell, p.cell.cpara);
                it.text = len > 0 ? w.getTextInCell(p.sec, p.para, p.cell.ci, p.cell.cell, p.cell.cpara, 0, len) : '';
                this.stats.cellTextReads++;
                touched.set(key, nm);
              } catch { this.nested.delete(key); touched.delete(key); }
            }
          } else {
            const key = `${p.sec}:${p.para}`;
            if (!read.has(key)) {
              const prev = cur[p.sec][p.para]; const next = this.readBody(w, p.sec, p.para);
              bodyChanged ||= prev.text !== next.text || prev.kind !== next.kind || prev.sig !== next.sig;
              cur[p.sec][p.para] = next; read.add(key);
            }
          }
        }
        // 칸 글을 고친 뒤에도 기존 행 이동·중복 문장 짝 판정을 유지한다(추가 WASM 읽기 없음).
        for (const [key, nm] of touched) this.nested.set(key, this.makeNestedMap(nm.base, nm.items));
      }
    }
    if (!cur) cur = this.scan(w);
    // 칸 글만 바뀌면 본문 정렬의 입력(text/kind/sig)은 동일하다. 수백·수천 문단의 planBody도 반복하지 않는다.
    if (incremental && !bodyChanged) {
      this.textDirty.clear(); this.draftMemo = null;
      this.stats.textRefreshes++; this.stats.lastTextRefreshMs = performance.now() - t0;
      return true;
    }
    const plans: SecPlan[] = [];
    let basePara = 0; let curPara = 0; let paired = 0; let sigDiff = 0;
    for (let s = 0; s < Math.max(cur.length, this.bodies.length); s++) {
      const B = this.bodies[s] ?? []; const C = cur[s] ?? [];
      basePara += B.length; curPara += C.length;
      const b2c = new Int32Array(B.length).fill(-1); const c2b = new Int32Array(C.length).fill(-1);
      if (!this.hasBase) { plans[s] = { b2c, c2b, plan: [] }; continue; }
      const { pairs, plan } = planBody(B.map((b) => ({ text: b.text, kind: b.kind, sig: b.sig })), C.map((c) => ({ text: c.text, kind: c.kind, sig: c.sig })));
      for (const [i, j] of pairs) { b2c[i] = j; c2b[j] = i; if (B[i].sig !== C[j].sig) sigDiff++; }
      paired += pairs.length;
      plans[s] = { b2c, c2b, plan: plan as SecPlan['plan'] };
    }
    this.cur = cur; this.plans = plans; this.textDirty.clear(); this.draftMemo = null;
    if (!incremental) { this.nested.clear(); this.offs.clear(); }
    Object.assign(this.stats, { basePara, curPara, paired, sigDiff });
    if (incremental) { this.stats.textRefreshes++; this.stats.lastTextRefreshMs = performance.now() - t0; }
    else { this.stats.scans++; this.stats.lastScanMs = performance.now() - t0; }
    return true;
  }

  private scan(w: WasmBridge): CurBody[][] {
    const out: CurBody[][] = [];
    const secN = w.getSectionCount();
    for (let s = 0; s < secN; s++) {
      const n = w.getParagraphCount(s); const list: CurBody[] = new Array(n);
      for (let i = 0; i < n; i++) list[i] = this.readBody(w, s, i);
      out[s] = list;
    }
    return out;
  }

  private readBody(w: WasmBridge, s: number, i: number): CurBody {
    this.stats.paragraphReads++;
    let text = '';
    try { const len = w.getParagraphLength(s, i); text = len > 0 ? w.getTextRange(s, i, 0, len) : ''; } catch { text = ''; }
    let kind = text ? 'text' : 'empty'; const tables: string[] = []; let objects = 0;
    const ctrls = w.getControlTextPositions(s, i);
    for (let ci = 0; ci < ctrls.length; ci++) {
      let dims: { rowCount: number; colCount: number } | null = null;
      try { dims = w.getTableDimensions(s, i, ci); } catch { dims = null; }
      if (dims && dims.rowCount != null) { tables.push(`${dims.rowCount}x${dims.colCount}`); continue; }
      if (!text && isObjectControl(w, s, i, ci)) objects++;
    }
    if (!text) kind = tables.length ? 'table' : objects ? 'object' : 'empty';
    return { text, kind, sig: sigOf(tables), ctrls: ctrls.length };
  }

  curText(cur: CurPara): string {
    if (!this.ensure()) return '';
    if (!cur.cell) return this.cur![cur.sec]?.[cur.para]?.text ?? '';
    const w = this.wasm(); if (!w) return '';
    try {
      const len = w.getCellParagraphLength(cur.sec, cur.para, cur.cell.ci, cur.cell.cell, cur.cell.cpara);
      return len > 0 ? w.getTextInCell(cur.sec, cur.para, cur.cell.ci, cur.cell.cell, cur.cell.cpara, 0, len) : '';
    } catch { return ''; }
  }

  /**
   * 시험용(debug.pointForText): 지금 편집기 문서에서 글 text 를 가진 nth 번째 문단 자리 — 본문 문단, 이어서 그 문단의 1단 칸·캡션·글상자
   * 차례로 본다. exact 면 문단 글 전체가 text 와 같아야 한다. 정렬과 무관하게 편집기 문서만 보므로 기준과 짝을 잃은 칸도 찾는다.
   */
  findCur(text: string, nth = 1, exact = false): { cur: CurPara; offset: number; len: number } | null {
    if (!text || !this.ensure()) return null;
    const w = this.wasm();
    const at = (t: string): number => {
      if (exact) return t === text ? 0 : -1;
      const k = t.indexOf(text);
      return k < 0 ? -1 : cpLen(t.slice(0, k));
    };
    let seen = 0;
    for (let s = 0; s < this.cur!.length; s++) {
      const list = this.cur![s] ?? [];
      for (let i = 0; i < list.length; i++) {
        const k = at(list[i].text);
        if (k >= 0 && ++seen === nth) return { cur: { sec: s, para: i }, offset: k, len: cpLen(list[i].text) };
        if (!w) continue;
        let items: RhItem[] = [];
        try { items = rhwpNestedList(w, s, i) as unknown as RhItem[]; } catch { items = []; }
        for (const it of items) {
          const c = at(it.text);
          if (c >= 0 && ++seen === nth) {
            return { cur: { sec: s, para: i, cell: { ci: it.pos.controlIdx, cell: it.pos.cellIdx, cpara: it.pos.cellParaIdx, kind: it.kind } }, offset: c, len: cpLen(it.text) };
          }
        }
      }
    }
    return null;
  }

  sectionCount(): number { this.ensure(); return this.cur?.length ?? 0; }
  paragraphCount(sec: number): number { this.ensure(); return this.cur?.[sec]?.length ?? 0; }
  curKind(sec: number, para: number): string { this.ensure(); return this.cur?.[sec]?.[para]?.kind ?? 'empty'; }

  /**
   * 편집기 문단 cur 가 기준에 짝이 없는(내 수정본에만 있는 — 내가 넣은) 문단인가(2026-11-17 §10.4 나-3 — insertParagraphAfter 의 skip).
   * 기준이 없으면 false(편집기 = 기준이라 가릴 수 없다). 칸 문단은 그 본문 문단이 짝 있고 칸 지도(nestedMap)에 없을 때 true —
   * 내가 넣은 표 안의 칸은 기준 ref 로 가리킬 수 없으니 넣기 자리 계산에 쓰지 않는다(false)
   */
  draftOnly(cur: CurPara): boolean {
    if (!this.ensure() || !this.hasBase || !this.cur![cur.sec]?.[cur.para]) return false;
    const bi = this.plans[cur.sec]?.c2b[cur.para] ?? -1;
    if (!cur.cell) return bi < 0;
    if (bi < 0) return false;
    return !this.nestedMap(cur.sec, bi, cur.para).r2b.has(posKey(cur.cell.ci, cur.cell.cell, cur.cell.cpara));
  }

  // ───────── 기준 → 편집기 ─────────

  locate(ref: string): Located | null {
    if (!this.ensure()) return null;
    const top = TOP_RE.exec(ref ?? '');
    if (!top) return null;
    const bodyRef = top[1]; const sec = Number(top[2]); const bi = Number(top[3]);
    if (!this.hasBase) {
      // 기준이 아직 없으면 편집기 문서를 기준처럼(본문만)
      if (ref !== bodyRef) return null;
      const text = this.cur![sec]?.[bi]?.text; if (text == null) return null;
      return { ref, cur: { sec, para: bi }, baseText: text, curText: text, map: null };
    }
    const cj = this.plans[sec]?.b2c[bi] ?? -1;
    if (cj < 0) return null;
    if (ref === bodyRef) {
      const bt = this.bodies[sec][bi].text; const ct = this.cur![sec][cj].text;
      return { ref, cur: { sec, para: cj }, baseText: bt, curText: ct, map: this.offMap(ref, bt, ct) };
    }
    const p = this.baseByRef.get(ref);
    if (!p || p.parent !== bodyRef) return null; // 칸 안의 표(2단 중첩)는 지도 밖
    const nm = this.nestedMap(sec, bi, cj);
    const k = nm.b2r.get(ref);
    if (k == null) return null;
    const it = nm.items[k];
    return {
      ref, cur: { sec, para: cj, cell: { ci: it.pos.controlIdx, cell: it.pos.cellIdx, cpara: it.pos.cellParaIdx, kind: it.kind } },
      baseText: p.text, curText: it.text, map: this.offMap(ref, p.text, it.text),
    };
  }

  // ───────── 편집기 → 기준 ─────────

  /** 입력 중 표시는 ref만 필요하다. 구조가 보존된 글 편집 중 기존 짝 지도만 읽고 전체 갱신/글자 diff를 강요하지 않는다. */
  cachedEditingRef(cur: CurPara): string | null {
    if (!this.cur?.[cur.sec]?.[cur.para]) return null;
    if (!this.hasBase) return `s${cur.sec}/p${cur.para}`;
    const plan = this.plans[cur.sec];
    const bi = plan?.c2b[cur.para] ?? -1;
    if (bi < 0) {
      for (let k = cur.para - 1; k >= 0; k--) {
        const b = plan?.c2b[k] ?? -1;
        if (b >= 0) return this.bodies[cur.sec][b].ref;
      }
      return this.bodies[cur.sec]?.[0]?.ref ?? null;
    }
    const ref = this.bodies[cur.sec][bi].ref;
    if (!cur.cell) return ref;
    return this.nested.get(`${cur.sec}:${bi}:${cur.para}`)?.r2b.get(posKey(cur.cell.ci, cur.cell.cell, cur.cell.cpara)) ?? ref;
  }

  toBase(cur: CurPara): BaseLoc | null {
    if (!this.ensure()) return null;
    const body = this.cur![cur.sec]?.[cur.para];
    if (!body) return null;
    if (!this.hasBase) {
      const ref = `s${cur.sec}/p${cur.para}`;
      return { ref, baseText: body.text, curText: cur.cell ? this.curText(cur) : body.text, map: null, inserted: false, afterRef: null, approx: !!cur.cell, cell: null };
    }
    const plan = this.plans[cur.sec];
    const bi = plan?.c2b[cur.para] ?? -1;
    if (bi < 0) {
      // 내가 넣은 문단(또는 내가 넣은 표 안): 그 앞의 짝 있는 기준 문단
      let afterRef: string | null = null;
      for (let k = cur.para - 1; k >= 0; k--) { const b = plan?.c2b[k] ?? -1; if (b >= 0) { afterRef = this.bodies[cur.sec][b].ref; break; } }
      const ref = afterRef ?? this.bodies[cur.sec]?.[0]?.ref ?? `s${cur.sec}/p0`;
      return { ref, baseText: this.baseText(ref), curText: cur.cell ? this.curText(cur) : body.text, map: null, inserted: true, afterRef, approx: false, cell: null };
    }
    const b = this.bodies[cur.sec][bi];
    if (!cur.cell) return { ref: b.ref, baseText: b.text, curText: body.text, map: this.offMap(b.ref, b.text, body.text), inserted: false, afterRef: null, approx: false, cell: null };
    const nm = this.nestedMap(cur.sec, bi, cur.para);
    const ref = nm.r2b.get(posKey(cur.cell.ci, cur.cell.cell, cur.cell.cpara));
    const k = nm.items.findIndex((it) => it.pos.controlIdx === cur.cell!.ci && it.pos.cellIdx === cur.cell!.cell && it.pos.cellParaIdx === cur.cell!.cpara);
    const ct = k >= 0 ? nm.items[k].text : this.curText(cur);
    if (!ref) {
      // 칸 지도 밖(내가 넣은 칸 문단, 칸 안의 표 등): 표를 품은 본문 문단으로 근사
      return { ref: b.ref, baseText: b.text, curText: ct, map: null, inserted: false, afterRef: null, approx: true, cell: null };
    }
    const p = this.baseByRef.get(ref)!;
    return { ref, baseText: p.text, curText: ct, map: this.offMap(ref, p.text, ct), inserted: false, afterRef: null, approx: false, cell: p.cell ? { table: p.cell.table, row: p.cell.row, col: p.cell.col } : null };
  }

  // ───────── 내가 바꾼 문단 ─────────

  /**
   * 기준 대비 내 수정본(정렬 결과). changed 는 본문 + 칸(짝지어진 표 문단의 칸 중 글이 다른 것).
   * 표 격자(행·열 수, 표 수)가 바뀐 문단은 그 표의 칸을 짝짓지 않으므로 칸 대신 그 본문 문단을 바꾼 문단으로 낸다
   * (서버도 그 칸 글은 반영하지 않는다 — diffDocs 의 table-structure).
   * marks 는 화면 표시용 편집기 자리: 바꾼 문단(파랑), 넣은 문단(초록), 지운 자리(그 앞 편집기 문단 뒤, 빨강).
   * 결과는 문서·기준이 바뀔 때까지 기억한다(같은 판에서 여러 번 불러도 한 번만 계산).
   */
  draft(): DraftOut {
    if (this.draftMemo && this.cur) return this.draftMemo;
    const state = { changed: [] as string[], inserted: [] as Array<{ afterRef: string | null; text: string }>, deleted: [] as string[] };
    const marks = { changed: [] as CurPara[], inserted: [] as CurPara[], deleted: [] as Array<{ sec: number; after: number }> };
    if (!this.ensure() || !this.hasBase) return { state, marks };
    const t0 = performance.now();
    let gridChanged = 0;
    for (let s = 0; s < this.plans.length; s++) {
      const P = this.plans[s]; const B = this.bodies[s] ?? []; const C = this.cur![s] ?? [];
      if (!P) continue;
      // 바꾼 문단으로 낸 기준 본문 번호(글이 바뀌고 표 격자도 바뀐 문단을 두 번 내지 않게)
      const changedBody = new Set<number>();
      for (const step of P.plan) {
        let lastRef: string | null = step.at > 0 ? B[step.at - 1]?.ref ?? null : null;
        let lastCur = step.at > 0 ? P.b2c[step.at - 1] : -1;
        for (const o of step.ops) {
          if (o.op === 'pair') {
            if (!sameText(B[o.i].text, C[o.j].text)) { state.changed.push(B[o.i].ref); marks.changed.push({ sec: s, para: o.j }); changedBody.add(o.i); }
            lastRef = B[o.i].ref; lastCur = o.j;
          } else if (o.op === 'del') {
            state.deleted.push(B[o.i].ref); marks.deleted.push({ sec: s, after: lastCur });
            lastRef = B[o.i].ref;
          } else {
            state.inserted.push({ afterRef: lastRef, text: C[o.j].text }); marks.inserted.push({ sec: s, para: o.j });
            lastCur = o.j;
          }
        }
      }
      // 칸: 짝지어진 표 문단마다 칸 글 비교(본문 글이 같아도 칸은 바뀌었을 수 있다). 기준에 중첩 문단이 없어도 지금 표가 있으면
      // 본다(표를 넣음 = 격자가 바뀜)
      for (let i = 0; i < B.length; i++) {
        const j = P.b2c[i];
        if (j < 0 || (!B[i].nested.length && !C[j]?.sig)) continue;
        const nm = this.nestedMap(s, i, j);
        if (nm.structure) {
          gridChanged++;
          if (!changedBody.has(i)) { changedBody.add(i); state.changed.push(B[i].ref); marks.changed.push({ sec: s, para: j }); }
        }
        for (const [ref, k] of nm.b2r) {
          const it = nm.items[k];
          if (!sameText(this.baseText(ref), it.text)) {
            state.changed.push(ref);
            marks.changed.push({ sec: s, para: j, cell: { ci: it.pos.controlIdx, cell: it.pos.cellIdx, cpara: it.pos.cellParaIdx, kind: it.kind } });
          }
        }
      }
    }
    this.stats.lastNestedMs = this.stats.lastDraftMs = performance.now() - t0;
    this.stats.drafts++;
    this.stats.gridChanged = gridChanged;
    const out = { state, marks };
    this.draftMemo = out;
    return out;
  }

  // ───────── 맞추기(syncToBase — docs/V4_SPEC.md §2.5) ─────────

  /**
   * 편집기 문서를 기준 글로 맞추는 계획(편집 전 문서 자리). 지금 정렬(planBody 짝·칸 지도)의 차이를 '편집기 쪽을 기준에 맞추는 편집'으로:
   *  - 짝지은 본문 문단·칸 문단의 글이 정확히(공백 무시 없이) 다르면 글자 차이 조각(charOps — 서버 mergeParagraphText 와 같은 조각)만
   *    바꾼다 — 손대지 않은 글의 서식은 그대로. 조각이 SYNC_MAX_OPS 보다 많으면 앞뒤 같은 부분을 뺀 가운데 하나로.
   *  - 편집기에만 있는 본문 문단은 지운다(글·빈 문단이고 컨트롤이 하나도 없을 때만), 기준에만 있는 본문 문단은 앞 짝 문단 뒤에 넣는다(글·빈 문단만).
   * 못 하면 { ok: false, reason: 'STRUCTURE' } 이고 아무것도 고치지 않는다(호스트가 다시 연다): 구역 수가 다름, 표 격자가 다름,
   * 짝 없는 칸 문단(칸 지도 없음), 표·개체·조판 부호가 든 문단을 지우거나 표·개체 문단을 넣어야 함, 짝 문단이 없는 구역,
   * 넣을 자리를 안전하게 나눌 수 없음(끝에 표·그림이 붙은 문단 뒤이고 다음 문단도 글 문단이 아님).
   * issues 를 주면 첫 문제에서 멈추지 않고 모두 모은다(debug.syncPlan — 시험·문제 찾기).
   */
  syncPlan(issues?: SyncIssue[]): SyncPlan | SyncFail {
    const fails: SyncFail[] = [];
    /** 문제 하나 — 모으는 중이 아니면 멈춘다(true) */
    const bad = (what: string, ref?: string, detail?: string): boolean => {
      issues?.push({ what, ...(ref ? { ref } : {}), ...(detail ? { detail } : {}) });
      if (!fails.length) fails.push({ ok: false, reason: 'STRUCTURE', message: detail ? `${what} (${detail})` : what, ...(ref ? { ref } : {}) });
      return !issues;
    };
    if (!this.ensure() || !this.hasBase) return { ok: false, reason: 'STRUCTURE', message: '기준 문단 목록 또는 편집기 문서가 없습니다' };
    if (this.unmappedStale && bad('머리말·꼬리말·각주 등 맞추기가 다루지 않는 글이 바뀌었습니다')) return fails[0];
    const w = this.wasm()!;
    const cur = this.cur!; const bodies = this.bodies; const plans = this.plans;
    const edits: SyncEdit[] = [];
    const changed: string[] = []; const inserted: string[] = []; let deleted = 0;
    const counts: SyncPlan['expect']['counts'] = []; const texts: SyncPlan['expect']['texts'] = []; const cells: SyncPlan['expect']['cells'] = [];
    // 캐럿 옮기기용 — 편집 전 자리 열쇠 → 그 문단의 글 조각 · 접은 칸('구역:본문:컨트롤:칸' → 접기 계획)
    const bodyOps = new Map<string, TextOp[]>(); const cellOps = new Map<string, TextOp[]>(); const cellFolds = new Map<string, CellFold>();
    if (cur.length !== bodies.length && bad('구역 수가 기준과 다릅니다', undefined, `기준 ${bodies.length}, 편집기 ${cur.length}`)) return fails[0];
    for (let s = Math.min(cur.length, bodies.length) - 1; s >= 0; s--) {
      const B = bodies[s] ?? []; const C = cur[s] ?? []; const P = plans[s];
      if (!P) continue;
      /** 편집 자리(편집기 문단 번호; 문단 뒤에 넣기는 +0.5) — 큰 것부터 고친다 */
      const evs: Array<{ pos: number; ed: SyncEdit }> = [];
      const kept: number[] = [];
      for (let j = 0; j < C.length; j++) {
        const c = C[j]; const i = P.c2b[j];
        if (i < 0) {
          // 편집기에만 있는 본문 문단 → 지운다. 구역 정의·표·그림·필드 등 컨트롤이 든 문단은 지우지 않는다(지우면 그것까지 사라진다)
          if (!TEXTUAL_KIND(c.kind) || c.ctrls > 0) { if (bad('표·개체·조판 부호가 든 편집기 문단을 지워야 합니다', `s${s}/p${j}`, clipText(c.text))) return fails[0]; continue; }
          evs.push({ pos: j, ed: { op: 'del', sec: s, para: j } }); deleted++;
          continue;
        }
        kept.push(j);
        const b = B[i];
        if (b.text !== c.text) {
          // 컨트롤이 있는 문단은 자동 번호 자리(rhwp 는 그 컨트롤 자리에 빈칸 하나를 글에 둔다 — 엔진 글에는 없다)를 지우지 않는다
          let at: Set<number> | null = null;
          if (c.ctrls > 0) { try { at = new Set(w.getControlTextPositions(s, j)); } catch { at = new Set(); } }
          const t = syncOps(c.text, b.text, at ? (k) => at!.has(k) : null);
          if (t) {
            evs.push({ pos: j, ed: { op: 'text', cur: { sec: s, para: j }, ops: t.ops } });
            bodyOps.set(`${s}:${j}`, t.ops);
            changed.push(b.ref); texts.push({ cur: { sec: s, para: i }, text: t.expect, ref: b.ref });
          }
        }
        if (!b.nested.length && !c.ctrls) continue;
        const nm = this.nestedMap(s, i, j);
        if (nm.structure) { if (bad('표 격자(행·열)가 기준과 다릅니다', b.ref)) return fails[0]; continue; }
        // 칸 문단 수만 기준과 다른 칸(내가 칸 안에서 Enter·Backspace — 서버 diffDocs 는 칸 문단 수를 그대로 두고 글을 줄바꿈으로 접어 넣는다):
        // 내 칸 문단을 서버와 같은 묶음으로 접어(fold — 합치며 '\n') 기준 칸 문단 수로 맞춘다 — 다시 열지 않고 캐럿도 그 글자 자리에
        const folds = this.cellFolds(nm);
        const foldedBase = (e: EngineParagraph | undefined): boolean => !!e?.cell && folds.has(cellKey(tableOrdOf(e.cell.table), e.cell.row, e.cell.col));
        // 칸 지도가 표 칸·캡션 문단을 모두 짝지어야 그 표의 글을 맞출 수 있다(짝 없는 칸 문단 = 칸 안 문단 수가 다름 등 — 접은 칸은 빼고).
        // 지도 밖 종류(syncMapped 아님)의 기준 문단, 칸이 아닌 편집기 항목(그리기 개체 글상자 등 — 엔진이 다르게 셀 수 있다)은 짝이 없어도 막지 않는다
        let unpaired = false;
        for (const e of nm.base) {
          if (nm.b2r.has(e.ref) || !syncMapped(e) || foldedBase(e)) continue;
          unpaired = true;
          if (bad('편집기에 짝 없는 기준 칸 문단', e.ref, clipText(e.text))) return fails[0];
        }
        for (const it of nm.items) {
          if (it.kind !== 'cell' || folds.has(cellKey(it.tableOrd ?? NaN, it.row, it.col)) || nm.r2b.has(posKey(it.pos.controlIdx, it.pos.cellIdx, it.pos.cellParaIdx))) continue;
          unpaired = true;
          if (bad('기준에 짝 없는 편집기 칸 문단', b.ref, `${it.pos.controlIdx}/${it.pos.cellIdx}/${it.pos.cellParaIdx} ${clipText(it.text)}`)) return fails[0];
        }
        if (unpaired) continue;
        for (const f of folds.values()) {
          // 접기만 한 문단(내가 친 글 그대로 — 기준 글 = 내 칸 문단을 이은 글)은 바뀐 자리(changed — 밑줄 깜빡임)로 내지 않고, 글 조각이 있는
          // 문단(남의 고침)만 낸다
          evs.push({ pos: j, ed: { op: 'fold', sec: s, para: j, ci: f.ci, cell: f.cell, groups: f.groups, ops: f.ops } });
          cellFolds.set(`${s}:${j}:${f.ci}:${f.cell}`, f);
          cells.push({ sec: s, para: i, ci: f.ci, cell: f.cell, n: f.base.length });
          f.base.forEach((e, k) => {
            texts.push({ cur: { sec: s, para: i, cell: { ci: f.ci, cell: f.cell, cpara: k, kind: 'cell' } }, text: e.text, ref: e.ref });
            if (f.ops[k]) changed.push(e.ref);
          });
        }
        for (const [ref, k] of nm.b2r) {
          if (foldedBase(this.baseByRef.get(ref))) continue;
          const it = nm.items[k]; const bt = this.baseText(ref);
          if (bt === it.text) continue;
          // 캡션·글상자는 자동 번호 자리(빈칸 하나 — '[표  ]')가 rhwp 글에만 있다: 빈칸 하나만 지우는 조각은 그 자리로 보고 남긴다
          const t = syncOps(it.text, bt, it.kind === 'cell' ? null : () => true);
          if (!t) continue;
          // 머리말·꼬리말 등(칸 지도 밖의 종류)이 우연히 짝지어졌어도 칸 평면 API 로 고치지 않는다
          if (!syncMapped(this.baseByRef.get(ref)!)) { if (bad('맞추지 않는 종류(머리말·꼬리말 등)의 글이 기준과 다릅니다', ref)) return fails[0]; continue; }
          const cell = { ci: it.pos.controlIdx, cell: it.pos.cellIdx, cpara: it.pos.cellParaIdx, kind: it.kind };
          evs.push({ pos: j, ed: { op: 'text', cur: { sec: s, para: j, cell }, ops: t.ops } });
          cellOps.set(`${s}:${j}:${cell.ci}:${cell.cell}:${cell.cpara}`, t.ops);
          changed.push(ref); texts.push({ cur: { sec: s, para: i, cell }, text: t.expect, ref });
        }
      }
      // 기준에만 있는 본문 문단 → 앞 짝 문단 뒤(같은 자리 여럿은 기준 차례로 한 번에)
      const slots = new Map<number, number[]>();
      let lastKept = -1;
      for (let i = 0; i < B.length; i++) {
        const j = P.b2c[i];
        if (j >= 0) { lastKept = j; continue; }
        const b = B[i];
        if (!TEXTUAL_KIND(b.kind) || b.nested.length || b.sig) { if (bad('표·개체가 든 기준 문단을 넣어야 합니다', b.ref, clipText(b.text))) return fails[0]; continue; }
        let list = slots.get(lastKept);
        if (!list) slots.set(lastKept, (list = []));
        list.push(i);
      }
      if (!kept.length && (slots.size || evs.length)) { if (bad('기준과 짝지은 문단이 없는 구역입니다', `s${s}/p0`)) return fails[0]; continue; }
      for (const [after, list] of slots) {
        // 넣을 자리: after 문단을 끝에서 나눌 수 있으면 그 뒤(그 문단 서식), 아니면 다음 짝 글 문단을 앞에서 나눠 그 앞(그 문단 서식)
        const next = kept.find((j) => j > after) ?? -1;
        let mode: 'after' | 'before' | null = null; let len = 0;
        if (after >= 0) { const L = splitEndLen(w, s, after); if (L != null) { mode = 'after'; len = L; } }
        if (!mode && next >= 0 && TEXTUAL_KIND(C[next].kind) && !C[next].sig) mode = 'before';
        if (!mode) { if (bad('기준 문단을 넣을 자리를 안전하게 나눌 수 없습니다', B[list[0]].ref, clipText(B[list[0]].text))) return fails[0]; continue; }
        evs.push({ pos: after + 0.5, ed: { op: 'ins', sec: s, after, mode, len, lines: list.map((i) => B[i].text) } });
        for (const i of list) { inserted.push(B[i].ref); texts.push({ cur: { sec: s, para: i }, text: B[i].text, ref: B[i].ref }); }
      }
      // 고친 구역은 고친 뒤 문단 수가 기준과 같아야 한다(짝 문단 + 넣은 문단, 편집기에만 있던 문단은 지움)
      if (evs.length) counts.push({ sec: s, n: B.length });
      // 문서 뒤쪽부터. 같은 자리(한 문단의 본문 글·칸 글)는 서로의 자리를 밀지 않는다
      evs.sort((x, y) => y.pos - x.pos);
      for (const e of evs) edits.push(e.ed);
    }
    if (fails.length) return fails[0];
    const firstKeptAfter = (s: number, j: number): number => {
      const c2b = plans[s]?.c2b; if (!c2b) return -1;
      for (let k = j + 1; k < c2b.length; k++) if (c2b[k] >= 0) return k;
      return -1;
    };
    const mapPoint = (p: CurPara & { offset: number }): CurPara & { offset: number } => {
      const P = plans[p.sec]; const B = bodies[p.sec] ?? [];
      const i = P?.c2b[p.para] ?? -1;
      if (!P || p.para >= P.c2b.length) return { ...p };
      if (i >= 0) {
        if (!p.cell) {
          const ops = bodyOps.get(`${p.sec}:${p.para}`);
          return { sec: p.sec, para: i, offset: ops ? mapOffset(ops, p.offset) : p.offset };
        }
        // 접은 칸: 내 칸 문단 k 의 offset → 접힌 문단(기준 칸 문단 번호) 안 자리(같은 묶음 앞 문단 글 + 줄바꿈만큼 민다) → 그 문단 글 조각으로 옮김
        const f = cellFolds.get(`${p.sec}:${p.para}:${p.cell.ci}:${p.cell.cell}`);
        if (f) {
          const last = f.base.length - 1;
          const [bi, off] = f.at[p.cell.cpara] ?? [last, cpLen(f.base[last]?.text ?? '')];
          const o = mapOffset(f.ops[bi] ?? undefined, off + p.offset);
          return { sec: p.sec, para: i, cell: { ...p.cell, cpara: bi }, offset: Math.max(0, Math.min(o, cpLen(f.base[bi]?.text ?? ''))) };
        }
        const ops = cellOps.get(`${p.sec}:${p.para}:${p.cell.ci}:${p.cell.cell}:${p.cell.cpara}`);
        return { sec: p.sec, para: i, cell: { ...p.cell }, offset: ops ? mapOffset(ops, p.offset) : p.offset };
      }
      // 지운 문단 → 다음 짝 문단 처음(없으면 그 구역 마지막 문단 끝)
      const n = firstKeptAfter(p.sec, p.para);
      if (n >= 0) return { sec: p.sec, para: P.c2b[n], offset: 0 };
      const last = Math.max(0, B.length - 1);
      return { sec: p.sec, para: last, offset: cpLen(B[last]?.text ?? '') };
    };
    return { ok: true, edits, changed, inserted, deleted, expect: { counts, texts, cells }, mapPoint };
  }

  /**
   * 칸 접기 계획(syncPlan): 1단 표 칸(표 순번·행·열)마다 기준·편집기 칸 문단 수가 다르면(내가 칸 안에서 Enter·Backspace — 서버 diffDocs 는
   * 칸 문단 수를 그대로 두고 글을 '\n' 으로 접어 넣는다) 편집기 칸 문단마다 접혀 들어갈 기준 칸 문단을 서버와 같은 함수(foldOwners)로 정하고,
   * 묶음마다 합친 글('\n' 으로 이음)과 기준 글이 다르면(그새 남이 같은 칸의 다른 줄을 고침 등) 그 글 조각까지 낸다. 기준 칸 문단 안에 더 깊은
   * 문단(칸 속 표·글상자)이 있거나 편집기 칸 문단 차례가 이어지지 않으면 그 칸은 넣지 않는다(→ 짝 없는 칸 문단 = STRUCTURE, 다시 열기).
   * → 칸 열쇠(cellKey) → 접기 계획
   */
  private cellFolds(nm: NestedMap): Map<string, CellFold> {
    const out = new Map<string, CellFold>();
    const byKey = new Map<string, { base: EngineParagraph[]; items: RhItem[] }>();
    const slot = (key: string) => { let g = byKey.get(key); if (!g) byKey.set(key, (g = { base: [], items: [] })); return g; };
    for (const e of nm.base) if (e.cell && syncMapped(e)) slot(cellKey(tableOrdOf(e.cell.table), e.cell.row, e.cell.col)).base.push(e);
    for (const it of nm.items) if (it.kind === 'cell') slot(cellKey(it.tableOrd ?? NaN, it.row, it.col)).items.push(it);
    for (const [key, g] of byKey) {
      if (!g.base.length || !g.items.length || g.base.length === g.items.length) continue;
      if (g.base.some((e) => this.parents.has(e.ref))) continue;
      const { controlIdx: ci, cellIdx: cell } = g.items[0].pos;
      const items = [...g.items].sort((a, b) => a.pos.cellParaIdx - b.pos.cellParaIdx);
      if (items.some((it, k) => it.pos.controlIdx !== ci || it.pos.cellIdx !== cell || it.pos.cellParaIdx !== k)) continue;
      const owner = foldOwners(g.base.map((e) => e.text), items.map((it) => it.text)) as number[];
      if (owner.some((o, k) => !(o >= 0 && o < g.base.length) || (k > 0 && o < owner[k - 1]))) continue;
      const groups = g.base.map(() => 0); const merged: string[][] = g.base.map(() => []);
      const at: Array<[number, number]> = [];
      owner.forEach((o, k) => { at.push([o, merged[o].reduce((n, t) => n + cpLen(t) + 1, 0)]); groups[o]++; merged[o].push(items[k].text); });
      const ops = g.base.map((e, bi) => syncOps(merged[bi].join('\n'), e.text, null)?.ops ?? null);
      out.set(key, { ci, cell, base: g.base, groups, ops, at });
    }
    return out;
  }

  // ───────── 내부 ─────────

  private offMap(key: string, bt: string, ct: string): OffMap | null {
    if (bt === ct) return null;
    const hit = this.offs.get(key);
    if (hit && hit.bt === bt && hit.ct === ct) return hit.map;
    const al = alignOffsets(bt, ct);
    const map = { b2c: al.a2b, c2b: al.b2a };
    this.offs.set(key, { bt, ct, map });
    return map;
  }

  private nestedMap(sec: number, bi: number, cj: number): NestedMap {
    const key = `${sec}:${bi}:${cj}`;
    const hit = this.nested.get(key);
    if (hit) return hit;
    const b = this.bodies[sec][bi];
    const base = b.nested.filter((n) => n.parent === b.ref);
    const w = this.wasm();
    let items: RhItem[] = [];
    // 기준에 중첩 문단이 있거나 지금 문단에 표가 있으면 읽는다(지금만 표가 있으면 표를 넣은 것 — 격자가 바뀜)
    if (w && (base.length || this.cur?.[sec]?.[cj]?.sig)) { try { items = rhwpNestedList(w, sec, cj) as unknown as RhItem[]; } catch { items = []; } }
    const nm = this.makeNestedMap(base, items);
    this.nested.set(key, nm);
    this.stats.nestedBuilt++;
    return nm;
  }

  private makeNestedMap(base: EngineParagraph[], items: RhItem[]): NestedMap {
    const { pairs, structure } = pairNested(base, items);
    const b2r = new Map<string, number>(); const r2b = new Map<string, string>();
    for (const [i, k] of pairs) {
      b2r.set(base[i].ref, k);
      const it = items[k];
      r2b.set(posKey(it.pos.controlIdx, it.pos.cellIdx, it.pos.cellParaIdx), base[i].ref);
    }
    return { items, base, b2r, r2b, structure };
  }
}

/**
 * 기준 칸 목록 ↔ rhwp 칸 목록 짝. 먼저 표 격자(표 수, 표마다 행x열 — gridOf)를 견준다(V3_SPEC §1.3: 표 칸은 기준 표 구조와 같을 때만):
 *  - 격자가 다른 표의 칸은 짝짓지 않는다 — 줄·칸을 넣거나 지우면 같은 (표, 행, 열) 자리에 다른 칸이 와서, 자리로 짝지으면
 *    메모·선택·반영이 엉뚱한 칸으로 간다. 격자가 같아도 줄이 밀렸으면(linesMoved — 줄 하나 지우고 하나 넣음) 마찬가지.
 *    병합·나누기는 격자가 그대로라 자리 짝이 맞다.
 *  - 표 수가 다르면(표 순번이 밀렸을 수 있음) 칸은 하나도 짝짓지 않고, 캡션·글상자는 글이 같은 것만 짝짓는다.
 * 나머지(격자가 같은 표의 칸, 캡션·글상자)는 전처럼: 모양(표·행·열)이 차례로 같으면 그대로, 아니면 글까지 같은 것 → 남은 틈은 같은 자리끼리.
 * 반환 pairs 는 [기준 번호, rhwp 번호], structure = 격자가 다르거나 줄이 밀린 표가 있다.
 */
function pairNested(base: EngineParagraph[], items: RhItem[]): { pairs: Array<[number, number]>; structure: boolean } {
  const bg = gridOf(base.filter((e) => e.cell).map(baseShape));
  const cg = gridOf(items.filter((r) => r.kind === 'cell').map(curShape));
  const shifted = bg.size !== cg.size || [...bg.keys()].some((k) => !cg.has(k));
  const bad = new Set<number>();
  for (const k of new Set([...bg.keys(), ...cg.keys()])) if (shifted || bg.get(k) !== cg.get(k)) bad.add(k);
  // 격자가 같아도 줄이 밀렸을 수 있다(줄 하나 지우고 다른 줄 하나 넣음 — 행·열 수는 그대로): 그 표도 짝짓지 않는다
  if (!shifted) {
    for (const k of bg.keys()) {
      if (bad.has(k)) continue;
      const a = base.filter((e) => e.cell && tableOrdOf(e.cell.table) === k).map((e) => ({ row: Number(e.cell!.row), col: Number(e.cell!.col), text: e.text }));
      const b = items.filter((r) => r.kind === 'cell' && r.tableOrd === k).map((r) => ({ row: Number(r.row), col: Number(r.col), text: r.text }));
      // 칸 자리·글이 차례로 다 같으면(그 표를 손대지 않음 — 거의 모든 표) 밀렸을 수 없다: 줄 글을 만들지 않는다
      if (a.length === b.length && a.every((x, i) => x.row === b[i].row && x.col === b[i].col && x.text === b[i].text)) continue;
      if (linesMoved(a, b)) bad.add(k);
    }
  }
  const structure = bad.size > 0;
  // 짝 후보(원래 목록 번호): 격자가 그대로인 표의 칸 + 칸이 아닌 것(캡션·글상자)
  const bi: number[] = []; const ri: number[] = [];
  base.forEach((e, i) => { if (!e.cell || !bad.has(tableOrdOf(e.cell.table))) bi.push(i); });
  items.forEach((r, j) => { if (r.kind !== 'cell' || !bad.has(r.tableOrd ?? NaN)) ri.push(j); });
  const B = bi.map((i) => base[i]); const R = ri.map((j) => items[j]);
  const out: Array<[number, number]> = [];
  if (!B.length || !R.length) return { pairs: out, structure };
  // 2026-11-19 견줌에 쓰는 값(표 순번 — 정규식, 보이는 글 — normText)은 항목마다 한 번만 구한다. 판정은 shapeEq·normText 와 같다.
  // 칸 문단을 하나 넣거나 지우면(Enter·합치기) 아래 lcsPairs 가 두 목록의 모든 쌍을 견준다 — 칸 1,936개 표에서 375만 번이고,
  // 그때마다 정규식을 돌려 편집 뒤의 정렬 한 번이 0.2초였다(22쪽 문서 마지막 칸에서 Enter: 주 스레드 공백 약 200ms).
  const Bs: PairShape[] = B.map((e) => (e.cell
    ? { cell: true, ord: tableOrdOf(e.cell.table), row: e.cell.row, col: e.cell.col, text: normText(e.text) }
    : { cell: false, ord: NaN, row: undefined, col: undefined, text: normText(e.text) }));
  const Rs: PairShape[] = R.map((r) => ({ cell: r.kind === 'cell', ord: r.tableOrd, row: r.row, col: r.col, text: normText(r.text) }));
  // shapeEq(B[i], R[k]) 와 같은 값
  const sameShape = (b: PairShape, r: PairShape): boolean => (b.cell ? r.cell && b.ord === r.ord && b.row === r.row && b.col === r.col : !r.cell);
  if (!shifted && Bs.length === Rs.length && Bs.every((b, k) => sameShape(b, Rs[k]))) {
    for (let k = 0; k < B.length; k++) out.push([bi[k], ri[k]]);
    return { pairs: out, structure };
  }
  const strong = lcsPairsAfterCommonPrefix(Bs, Rs, (b, r) => sameShape(b, r) && b.text === r.text);
  let pi = 0; let pj = 0;
  // 남은 틈은 같은 자리끼리(표 순번이 밀렸으면 하지 않는다 — 글이 같은 것만)
  const fill = (i2: number, j2: number) => {
    if (shifted) return;
    let j = pj;
    for (let i = pi; i < i2 && j < j2; i++) {
      for (let k = j; k < j2; k++) if (sameShape(Bs[i], Rs[k])) { out.push([bi[i], ri[k]]); j = k + 1; break; }
    }
  };
  for (const [i, j] of strong) { fill(i, j); out.push([bi[i], ri[j]]); pi = i + 1; pj = j + 1; }
  fill(B.length, R.length);
  return { pairs: out, structure };
}

/** pairNested 가 견줄 때 쓰는 값 — 기준 문단·rhwp 항목을 같은 꼴로 한 번만 풀어 둔다 */
interface PairShape { cell: boolean; ord: number | undefined; row: unknown; col: unknown; text: string }

/**
 * lcsPairs 와 같은 짝을 같은 차례로 낸다(2026-11-19). 앞에서부터 차례로 같은 항목은 표를 만들지 않고 바로 짝짓는다.
 * lcsPairs 의 되짚기는 지금 자리의 두 항목이 같으면 늘 그 둘을 짝짓고 넘어간다(같을 때 L[i][j] = L[i+1][j+1] + 1 이므로) —
 * 그래서 같은 앞부분은 (0,0)…(p-1,p-1) 로 짝지어지고 그 뒤는 남은 목록끼리의 결과와 같다.
 * 뒤에서부터 같은 부분은 미리 짝짓지 않는다(되짚기가 앞에서부터 가므로 같은 글이 겹치면 다른 짝이 될 수 있다).
 * 끝 칸에 문단을 넣는 보통의 편집에서 견줄 쌍이 n×m 에서 몇 개로 준다.
 */
function lcsPairsAfterCommonPrefix<A, B>(a: A[], b: B[], eq: (x: A, y: B) => boolean): Array<[number, number]> {
  const limit = Math.min(a.length, b.length);
  let p = 0;
  while (p < limit && eq(a[p], b[p])) p++;
  if (p === 0) return lcsPairs(a, b, eq) as Array<[number, number]>;
  const out: Array<[number, number]> = [];
  for (let k = 0; k < p; k++) out.push([k, k]);
  if (p < a.length && p < b.length) {
    for (const [i, j] of lcsPairs(a.slice(p), b.slice(p), eq) as Array<[number, number]>) out.push([i + p, j + p]);
  }
  return out;
}

interface CellText { row: number; col: number; text: string }

/**
 * 격자가 같은 표의 줄(행 또는 열)이 밀렸는가: 기준·지금 양쪽에서 한 번씩만 나오는 줄 글이 서로 다른 줄 번호에 있으면 밀렸다
 * (줄 하나 지우고 다른 줄 하나 넣으면 그 사이 줄이 한 칸씩 옮겨 간다). 칸 글만 고친 표는 줄 글이 바뀌거나 제자리에 남으므로
 * 밀렸다고 보지 않는다 — 다른 줄의 글을 옮겨 적은 경우만 밀렸다고 보는데, 그때도 자리로 짝지으면 엉뚱한 칸이라 짝짓지 않는 편이 맞다.
 */
function linesMoved(a: CellText[], b: CellText[]): boolean {
  for (const axis of ['row', 'col'] as const) {
    const ua = uniqueLines(a, axis); const ub = uniqueLines(b, axis);
    for (const [t, i] of ua) { const j = ub.get(t); if (j !== undefined && j !== i) return true; }
  }
  return false;
}

/** 줄 글 → 줄 번호(그 표에서 한 번만 나오는 줄만, 칸이 다 빈 줄은 뺌). 줄 글 = 그 줄에서 시작하는 칸들의 (다른 축 번호, 글) 차례 */
function uniqueLines(cells: CellText[], axis: 'row' | 'col'): Map<string, number> {
  const lines = new Map<number, Array<[number, string]>>();
  for (const c of cells) {
    const li = axis === 'row' ? c.row : c.col; const oi = axis === 'row' ? c.col : c.row;
    const list = lines.get(li) ?? []; list.push([oi, normText(c.text)]); lines.set(li, list);
  }
  const at = new Map<string, number>(); const dup = new Set<string>();
  for (const [li, list] of lines) {
    if (list.every(([, t]) => !t)) continue; // 칸이 다 빈 줄은 줄을 가리지 못한다
    // 같은 칸의 문단들은 목록 차례 그대로(정렬은 안정적)
    const key = list.sort((x, y) => x[0] - y[0]).map(([oi, t]) => `${oi}\u0002${t}`).join('\u0001');
    if (at.has(key)) dup.add(key); else at.set(key, li);
  }
  for (const k of dup) at.delete(k);
  return at;
}

/** 표가 아닌 컨트롤이 '개체'(그림·도형·글상자)인가 — 구역·단 정의·책갈피 같은 표식은 아니다 */
function isObjectControl(w: WasmBridge, s: number, i: number, ci: number): boolean {
  try { w.getPictureProperties(s, i, ci); return true; } catch { /* 그림 아님 */ }
  try { w.getShapeProperties(s, i, ci); return true; } catch { /* 도형 아님 */ }
  return false;
}

// ───────── 맞추기 도우미 ─────────

const clipText = (s: string, n = 24): string => { const a = cps(s); return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };

/** 1단 표 칸 열쇠(칸 접기): 그 본문 문단 안 표 순번·행·열 */
const cellKey = (ord: number, row: number | null | undefined, col: number | null | undefined): string => `${ord}@${row ?? '?'},${col ?? '?'}`;

/**
 * 기준 중첩 문단 중 맞추기가 편집기 칸 지도(refmap.rhwpNestedList)로 맞추는 것 — 표 칸·표 캡션(hp:tbl), 그림 캡션(hp:pic). 그 밖(머리말·꼬리말·
 * 각주·글상자·선 같은 그리기 개체·메모·칸 안의 표)은 지도 밖이다: rhwp 가 목록에 내지 않거나(선·꼬리말 — 짝이 없다) 칸 평면 API 로 고칠 수
 * 없다. 그런 문단은 짝이 없어도 막지 않고, 대신 그 글이 기준에서 바뀌면(setBase 의 unmappedStale) 맞추지 않는다(STRUCTURE — 다시 열기).
 * container 가 없는 옛 서버 문단은 지도 안으로 본다.
 */
const syncMapped = (e: EngineParagraph): boolean => !e.container || e.container === 'hp:tbl' || e.container === 'hp:pic';

/**
 * 지금 글 → 기준 글 조각(앞에서부터)과 고친 뒤 기대 글. slotAt(i) 가 참인 자리의 빈칸(rhwp 의 자동 번호 자리 — 엔진 글에는 없다)을 그 한 글자만
 * 지우는 조각은 고치지 않는다 — 그러면 기대 글은 기준 글에 그 빈칸이 남은 글이다. 고칠 것이 없으면 null. 조각이 SYNC_MAX_OPS 보다 많으면 앞뒤
 * 같은 부분을 뺀 가운데 하나로 바꾼다 — 단 그 가운데에 자동 번호 자리일 수 있는 빈칸이 있으면 조각 그대로(그 자리를 지우지 않게).
 */
function syncOps(cur: string, base: string, slotAt: ((i: number) => boolean) | null): { ops: TextOp[]; expect: string } | null {
  const C = cps(cur);
  const slot = (i: number): boolean => !!slotAt && C[i] === ' ' && slotAt(i);
  let ops = (charOps(cur, base) as Array<{ start: number; end: number; text: string }>).map((o) => ({ s: o.start, e: o.end, text: o.text }));
  ops = ops.filter((o) => !(o.text === '' && o.e - o.s === 1 && slot(o.s)));
  if (!ops.length) return null;
  if (ops.length > SYNC_MAX_OPS) {
    const mid = middleOp(cur, base);
    let guarded = false;
    for (let i = mid.s; i < mid.e && !guarded; i++) guarded = slot(i);
    if (!guarded) ops = [mid];
  }
  let expect = '';
  let at = 0;
  for (const o of ops) { expect += C.slice(at, o.s).join('') + o.text; at = o.e; }
  expect += C.slice(at).join('');
  return { ops, expect };
}

function middleOp(a: string, b: string): TextOp {
  const A = cps(a); const B = cps(b);
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  return { s: p, e: A.length - q, text: B.slice(p, B.length - q).join('') };
}

/**
 * 글 조각(ops — 앞에서부터)을 고친 뒤 offset o 의 자리: 앞쪽 조각만큼 밀고, 바뀐 범위 안이면 바뀐 글 안(넘으면 그 끝),
 * o 에 바로 넣은 글은 o 뒤로(캐럿은 그 앞에 남는다), o 에서 끝나는 바꿈·지움은 그 뒤로.
 */
export function mapOffset(ops: TextOp[] | undefined, o: number): number {
  if (!ops?.length) return o;
  let delta = 0;
  for (const op of ops) {
    const len = cpLen(op.text);
    if (op.e < o || (op.e === o && op.s < op.e)) { delta += len - (op.e - op.s); continue; }
    if (op.s < o && o < op.e) return op.s + delta + Math.min(o - op.s, len);
    break;
  }
  return Math.max(0, o + delta);
}

/**
 * 본문 문단 j 를 끝에서 나눠 그 뒤에 새 문단을 넣어도 되면 나눌 자리(논리 길이 — splitParagraph 는 글자처럼 취급하는 개체를 한 글자로 센다),
 * 아니면 null: 글 끝 자리 이후에 표·그림·도형이 있으면(끝에서 나누면 개체가 새 문단으로 따라갈 수 있다 — 표·그림만 있는 문단 포함).
 * 구역·단 정의 같은 구조 컨트롤은 나눠도 그 문단에 남는다.
 */
function splitEndLen(w: WasmBridge, s: number, j: number): number | null {
  let textLen = 0; let pos: number[] = [];
  try { textLen = w.getParagraphLength(s, j); pos = w.getControlTextPositions(s, j); } catch { return null; }
  for (let ci = 0; ci < pos.length; ci++) {
    if (pos[ci] < textLen) continue;
    let table = false;
    try { const d = w.getTableDimensions(s, j, ci); table = !!d && d.rowCount != null; } catch { table = false; }
    if (table || isObjectControl(w, s, j, ci)) return null;
  }
  try {
    const doc = w.borrowDocumentHandle() as unknown as { getLogicalLength?: (a: number, b: number) => number } | null;
    const L = doc?.getLogicalLength?.(s, j);
    return typeof L === 'number' && L >= textLen ? L : textLen;
  } catch { return textLen; }
}

/** 기준 offset → 지금 offset */
export function toCurOffset(map: OffMap | null, off: number, curLen: number): number {
  if (!map) return Math.max(0, Math.min(curLen, off));
  const v = map.b2c[Math.max(0, Math.min(map.b2c.length - 1, off))];
  return Math.max(0, Math.min(curLen, v));
}
/**
 * 기준 범위 [start, end) 의 끝 → 지금 offset. 범위 마지막 글자 바로 뒤 자리로 옮긴다 — 범위 바로 뒤에 들어간 글(문단 끝에
 * 덧붙인 글, 합쳐진 다음 문단 등)은 범위에 넣지 않는다(b2c[end] 만 쓰면 문단 끝 범위가 덧붙인 글까지 늘어난다).
 */
export function toCurEnd(map: OffMap | null, start: number, end: number, curLen: number): number {
  const e = toCurOffset(map, end, curLen);
  if (!map || !(end > start) || end < 1) return e;
  // 마지막 글자(end-1)의 자리. 그 글자가 지금 글에 남아 있으면 자리가 e 보다 앞이다(지워졌으면 다음 글자 자리와 같다 → e 그대로)
  const last = map.b2c[Math.max(0, Math.min(map.b2c.length - 1, end - 1))];
  return last < e ? Math.max(0, Math.min(e, last + 1, curLen)) : e;
}
/** 지금 offset → 기준 offset */
export function toBaseOffset(map: OffMap | null, off: number, baseLen: number): number {
  if (!map) return Math.max(0, Math.min(baseLen, off));
  const v = map.c2b[Math.max(0, Math.min(map.c2b.length - 1, off))];
  return Math.max(0, Math.min(baseLen, v));
}
