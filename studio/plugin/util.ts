// 작은 도우미 — 코드포인트, JSON 복사, 시간 조절(throttle·debounce), 이벤트 발행, 안전 호출.
// 플러그인은 studio 이벤트 처리기 안에서 돈다: 여기서 던지면 studio 가 멈출 수 있으므로 바깥으로 예외를 내보내지 않는다(safe).

export const cps = (s: string | null | undefined): string[] => Array.from(s ?? '');
export const cpLen = (s: string | null | undefined): number => { let n = 0; for (const _ of s ?? '') n++; return n; };
export const cpSlice = (s: string, a: number, b?: number): string => cps(s).slice(a, b).join('');
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** 예외를 삼키고 console.warn 만 남긴다(studio 처리기로 예외가 새지 않게) */
export function safe<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try { return fn(); } catch (e) { console.warn(`[cowork] ${label}:`, e); return fallback; }
}

/** 이 realm 의 JSON 복사본(호스트가 준 값을 Vue 프록시·다른 realm 에서 떼어 낸다) */
export function jsonCopy<T>(v: T): T {
  if (v === undefined) return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * 호스트 realm 의 JSON — 같은 출처 부모 창이 있으면 그 창의 JSON.parse 로 만든 객체를 넘긴다
 * (호스트가 받은 값을 Vue 반응형에 넣어도 다른 realm 객체가 섞이지 않게). 부모에 못 닿으면 이 창의 JSON.
 */
function hostJson(): JSON {
  try {
    const p = window.parent as (Window & typeof globalThis) | null;
    if (p && p !== window && p.JSON && typeof p.JSON.parse === 'function') return p.JSON;
  } catch { /* 다른 출처 */ }
  return JSON;
}
export function toHost<T>(v: T): T {
  if (v === undefined || v === null) return v;
  const s = JSON.stringify(v);
  return (s === undefined ? v : hostJson().parse(s)) as T;
}
/** JSON 글 → 호스트 realm 객체 */
const parseForHost = (json: string): unknown => hostJson().parse(json);

export interface Timer { (): void; cancel(): void; flush(): void; pending(): boolean }

/** 마지막 호출 뒤 ms 쉬면 한 번(trailing). maxWait 를 주면 그 시간 안에는 반드시 한 번 */
export function debounce(fn: () => void, ms: number, maxWait = 0): Timer {
  let t: ReturnType<typeof setTimeout> | null = null; let first = 0;
  const run = () => { t = null; first = 0; safe('debounce', fn); };
  const d = (() => {
    const now = Date.now();
    if (!first) first = now;
    if (t) clearTimeout(t);
    const wait = maxWait > 0 ? Math.max(0, Math.min(ms, first + maxWait - now)) : ms;
    t = setTimeout(run, wait);
  }) as Timer;
  d.cancel = () => { if (t) clearTimeout(t); t = null; first = 0; };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.pending = () => t !== null;
  return d;
}

/** 많아야 ms 에 한 번(앞에서 한 번 + 끝에서 한 번) */
export function throttle(fn: () => void, ms: number): Timer {
  let last = 0; let t: ReturnType<typeof setTimeout> | null = null;
  const run = () => { t = null; last = Date.now(); safe('throttle', fn); };
  const d = (() => {
    const wait = last + ms - Date.now();
    if (wait <= 0 && !t) { run(); return; }
    if (!t) t = setTimeout(run, Math.max(0, wait));
  }) as Timer;
  d.cancel = () => { if (t) clearTimeout(t); t = null; };
  d.flush = () => { if (t) { clearTimeout(t); run(); } };
  d.pending = () => t !== null;
  return d;
}

/** 같은 프레임 안 여러 요청을 rAF 한 번으로 */
export function rafBatch(fn: () => void): Timer {
  let id: number | null = null;
  const run = () => { id = null; safe('raf', fn); };
  const d = (() => { if (id === null) id = requestAnimationFrame(run); }) as Timer;
  d.cancel = () => { if (id !== null) cancelAnimationFrame(id); id = null; };
  d.flush = () => { if (id !== null) { cancelAnimationFrame(id); run(); } };
  d.pending = () => id !== null;
  return d;
}

export const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 이벤트 발행: 받는 쪽마다 호스트 realm JSON 복사본을 준다. 받는 쪽이 던져도 다른 쪽은 받는다 */
export class Emitter {
  private subs = new Map<string, Set<(p: unknown) => void>>();
  on(name: string, cb: (p: unknown) => void): () => void {
    if (typeof cb !== 'function') return () => {};
    let set = this.subs.get(name);
    if (!set) { set = new Set(); this.subs.set(name, set); }
    set.add(cb);
    return () => { this.subs.get(name)?.delete(cb); };
  }
  has(name: string): boolean { return (this.subs.get(name)?.size ?? 0) > 0; }
  emit(name: string, payload: unknown): void {
    const set = this.subs.get(name);
    if (!set || !set.size) return;
    let json: string;
    try { json = JSON.stringify(payload ?? null); } catch (e) { console.warn('[cowork] 이벤트 직렬화 실패', name, e); return; }
    for (const cb of [...set]) {
      // 받는 쪽마다 따로 복사(한 구독자가 고쳐도 다른 구독자는 원래 값을 받는다)
      try { cb(parseForHost(json)); } catch (e) { console.warn(`[cowork] '${name}' 구독자가 던졌다:`, e); }
    }
  }
  clear(): void { this.subs.clear(); }
}

/** 글자 단위 비교용 정규화(공백·제어 문자 무시) — refmap.js 의 norm 과 같은 규칙 */
export const normText = (s: string | null | undefined): string => String(s ?? '').replace(/[\s\u0000-\u001f​﻿]/g, '');

/** CSS 값으로 쓸 색(#rgb·#rrggbb·rgb()·이름만) — 호스트가 준 글이 style 에 그대로 들어가지 않게 */
export function safeColor(c: unknown, fallback: string): string {
  const s = String(c ?? '').trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]{3,20})$/i.test(s) ? s : fallback;
}
