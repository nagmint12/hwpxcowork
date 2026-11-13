/**
 * [hwpx-cowork] 한/글 2022 편집·입력 — 엔진(WASM HwpDocument) 새 API 부르기(2026-11-11).
 *
 * 새 API 는 `src/wasm_api/h2022_edit.rs`(찾기 옵션·캐럿 자리 덧말/겹침)와 기존 덧말·글자 겹침 API(`insertRuby` …)다.
 * 브리지(`core/wasm-bridge.ts`, 공유 파일)를 넓히지 않고 브리지 안의 문서 객체를 직접 부른다 — 문서를 바꾸는 호출은
 * 반드시 편집 라우터(`executeOperation({kind:'snapshot'})`) 안에서 부른다(되돌리기·저장 경로를 지나도록).
 * 엔진이 옛 판이라 API 가 없으면 null 을 돌려주고, 부르는 쪽이 종전 동작으로 물러선다.
 */
import type { SearchResult } from '@/core/types';

type Doc = Record<string, (...args: unknown[]) => string>;

export function rawDoc(wasm: unknown): Doc | null {
  const doc = (wasm as { doc?: unknown } | null)?.doc;
  return doc && typeof doc === 'object' ? (doc as Doc) : null;
}

export function hasApi(wasm: unknown, name: string): boolean {
  return typeof rawDoc(wasm)?.[name] === 'function';
}

function call<T>(wasm: unknown, name: string, ...args: unknown[]): T | null {
  const doc = rawDoc(wasm);
  if (!doc || typeof doc[name] !== 'function') return null;
  return JSON.parse(doc[name](...args)) as T;
}

export function searchTextEx(
  wasm: unknown, query: string, sec: number, para: number, charOffset: number, forward: boolean, optionsJson: string, includeCells: boolean,
): SearchResult | null {
  return call<SearchResult>(wasm, 'searchTextEx', query, sec, para, charOffset, forward, optionsJson, includeCells);
}

export function replaceAllEx(wasm: unknown, query: string, newText: string, optionsJson: string): { ok: boolean; count?: number } | null {
  return call(wasm, 'replaceAllEx', query, newText, optionsJson);
}

/** 캐럿 자리 → 덧말·글자 겹침을 넣고 고칠 문단 주소 */
export interface ComposeTarget {
  sec: number;
  para: number;
  /** 표 셀·글상자면 경로(insertRubyByPath 와 같은 꼴), 본문이면 없음 */
  cellPath?: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;
  charOffset: number;
}

export interface ComposeValue {
  found?: boolean;
  ctrlIdx?: number;
  kind?: 'ruby' | 'overlap';
  mainText?: string;
  rubyText?: string;
  below?: boolean;
  styleId?: number | null;
  text?: string;
  shape?: number;
  innerSize?: number;
  overlap?: boolean;
}

export function composeAt(wasm: unknown, t: ComposeTarget): ComposeValue | null {
  try {
    return call<ComposeValue>(wasm, 'getComposeControlAt', JSON.stringify(t));
  } catch {
    return null;
  }
}

const pathJson = (t: ComposeTarget) => JSON.stringify(t.cellPath ?? []);
const inCell = (t: ComposeTarget) => (t.cellPath?.length ?? 0) > 0;

/** 덧말·글자 겹침 넣기(kind 'ruby' | 'overlap'). 반환 `{ok, controlIdx}` */
export function insertCompose(wasm: unknown, kind: 'ruby' | 'overlap', t: ComposeTarget, value: object): { ok: boolean; controlIdx?: number } | null {
  const json = JSON.stringify(value);
  if (kind === 'ruby') {
    return inCell(t)
      ? call(wasm, 'insertRubyByPath', t.sec, t.para, pathJson(t), t.charOffset, json)
      : call(wasm, 'insertRuby', t.sec, t.para, t.charOffset, json);
  }
  return inCell(t)
    ? call(wasm, 'insertCharOverlapByPath', t.sec, t.para, pathJson(t), t.charOffset, json)
    : call(wasm, 'insertCharOverlap', t.sec, t.para, t.charOffset, json);
}

export function setCompose(wasm: unknown, t: ComposeTarget, ctrlIdx: number, value: object): { ok: boolean } | null {
  const json = JSON.stringify(value);
  return inCell(t)
    ? call(wasm, 'setComposeControlByPath', t.sec, t.para, pathJson(t), ctrlIdx, json)
    : call(wasm, 'setComposeControl', t.sec, t.para, ctrlIdx, json);
}

export function deleteCompose(wasm: unknown, t: ComposeTarget, ctrlIdx: number, keepMainText: boolean): { ok: boolean } | null {
  return inCell(t)
    ? call(wasm, 'deleteComposeControlByPath', t.sec, t.para, pathJson(t), ctrlIdx, keepMainText)
    : call(wasm, 'deleteComposeControl', t.sec, t.para, ctrlIdx, keepMainText);
}

/** 날짜/시간 코드(한/글 DATE 필드, 기본 형식) 넣기 — 본문 문단만. 반환 `{ok, fieldId, charOffset, length}` */
export function insertDateCode(wasm: unknown, sec: number, para: number, charOffset: number, text: string): { ok: boolean; charOffset: number; length: number } | null {
  return call(wasm, 'insertDateCode', sec, para, charOffset, text);
}
