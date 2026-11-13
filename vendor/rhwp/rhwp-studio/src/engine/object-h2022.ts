/**
 * [hwpx-cowork] 한/글 2022 개체 기능 — 엔진(WASM) 새 API 부르기와 편집 라우팅 (2026-11-11, 개체 영역).
 *
 * 엔진 API(`src/wasm_api/h2022_object.rs`): getObjectInfoH2022·changeObjectZOrderH2022·setObjectLockH2022·
 * unlockAllObjectsH2022·setObjectWrapH2022·copyObjectFormatH2022·getObjectFormatClipH2022·pasteObjectFormatH2022.
 * 브리지(`core/wasm-bridge.ts`, 공유)를 넓히지 않고 브리지 안 문서 객체를 직접 부른다. 문서를 바꾸는 호출은
 * 반드시 편집 라우터(`executeOperation({kind:'snapshot'})`) 안에서 부른다 — 되돌리기·저장(서버 반영) 경로를 지나도록.
 * 한/글 동작 근거·남은 차이: `research/hangul2022-features-20261111/impl/ledger_object.md`.
 */

export type ObjectCellPath = Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;

export interface ObjectAddrLike {
  sec: number;
  ppi: number;
  ci: number;
  type?: string;
  cellPath?: unknown;
  headerFooter?: unknown;
  noteRef?: unknown;
}

export interface ObjectInfoH2022 {
  ok: boolean;
  kind: string;
  locked: boolean;
  zOrder: number;
  rank: number;
  count: number;
  textWrap: string;
  treatAsChar: boolean;
  width: number;
  height: number;
}

export interface FormatFlags {
  line: boolean;
  fill: boolean;
  size: boolean;
  shadow: boolean;
  picEffect: boolean;
}

type Doc = Record<string, (...args: unknown[]) => string>;

function rawDoc(wasm: unknown): Doc | null {
  const doc = (wasm as { doc?: unknown } | null)?.doc;
  return doc && typeof doc === 'object' ? (doc as Doc) : null;
}

export function hasObjectApi(wasm: unknown): boolean {
  return typeof rawDoc(wasm)?.changeObjectZOrderH2022 === 'function';
}

function call<T>(wasm: unknown, name: string, ...args: unknown[]): T {
  const doc = rawDoc(wasm);
  if (!doc || typeof doc[name] !== 'function') throw new Error(`엔진에 ${name} 이 없습니다 — 엔진을 다시 빌드하세요`);
  return JSON.parse(doc[name](...args)) as T;
}

/** 편집기 cellPath(키 이름이 갈래마다 조금 다르다) → 엔진 꼴 JSON. 본문 개체는 "" */
export function cellPathJson(ref: { cellPath?: unknown } | null | undefined): string {
  const p = ref?.cellPath;
  if (!Array.isArray(p) || p.length === 0) return '';
  const norm: ObjectCellPath = p.map((e: any) => ({
    controlIndex: e?.controlIndex ?? e?.controlIdx ?? 0,
    cellIndex: e?.cellIndex ?? e?.cellIdx ?? 0,
    cellParaIndex: e?.cellParaIndex ?? e?.cellParaIdx ?? 0,
  }));
  return JSON.stringify(norm);
}

/** 머리말·꼬리말·각주 안 개체는 본문 주소로 찾을 수 없다 — 이 기능들은 본문(칸·글상자 안 포함)만 */
export function isBodyObject(ref: ObjectAddrLike | null | undefined): ref is ObjectAddrLike {
  return !!ref && !ref.headerFooter && !ref.noteRef && Number.isInteger(ref.sec) && Number.isInteger(ref.ppi) && Number.isInteger(ref.ci);
}

export function objectInfo(wasm: unknown, ref: ObjectAddrLike): ObjectInfoH2022 | null {
  if (!isBodyObject(ref) || !hasObjectApi(wasm)) return null;
  try { return call<ObjectInfoH2022>(wasm, 'getObjectInfoH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci); } catch { return null; }
}

/** 쪽 개체 배치(getPageControlLayout 의 항목)가 보호된 개체인가 — 한/글: 보호한 개체는 마우스로 고를 수 없다 */
export function isLockedLayoutControl(wasm: unknown, ctrl: any): boolean {
  if (!ctrl || ctrl.headerFooter || ctrl.noteRef || ctrl.secIdx === undefined || ctrl.paraIdx === undefined || ctrl.controlIdx === undefined) return false;
  const doc = rawDoc(wasm);
  if (!doc || typeof doc.isObjectLockedH2022 !== 'function') return false;
  try {
    return (doc.isObjectLockedH2022 as unknown as (...a: unknown[]) => boolean)(ctrl.secIdx, ctrl.paraIdx, cellPathJson(ctrl), ctrl.controlIdx) === true;
  } catch { return false; }
}

export type ZOrderOp = 'front' | 'forward' | 'backward' | 'back';

export interface ZOrderResult { ok: boolean; zOrder: number; moves: Array<{ sec: number; ppi: number; ci: number; before: number; after: number }> }

/** 순서 바꾸기(엔진 — 라우터 안에서 부른다) */
export function changeObjectZOrder(wasm: unknown, ref: ObjectAddrLike, op: ZOrderOp): ZOrderResult {
  return call<ZOrderResult>(wasm, 'changeObjectZOrderH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, op);
}

export function setObjectLock(wasm: unknown, ref: ObjectAddrLike, locked: boolean): { ok: boolean; before: boolean; locked: boolean } {
  return call(wasm, 'setObjectLockH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, locked);
}

export function unlockAllObjects(wasm: unknown): { ok: boolean; count: number } {
  return call(wasm, 'unlockAllObjectsH2022');
}

export function setObjectWrap(wasm: unknown, ref: ObjectAddrLike, wrap: 'InFrontOfText' | 'BehindText'): { ok: boolean; changed: boolean; before: string } {
  return call(wasm, 'setObjectWrapH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, wrap);
}

export function copyObjectFormat(wasm: unknown, ref: ObjectAddrLike): { ok: boolean; kind: string } & FormatFlags {
  return call(wasm, 'copyObjectFormatH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci);
}

export function objectFormatClip(wasm: unknown): ({ ok: boolean; has: boolean; kind?: string } & Partial<FormatFlags>) | null {
  if (!hasObjectApi(wasm)) return null;
  try { return call(wasm, 'getObjectFormatClipH2022'); } catch { return null; }
}

export function pasteObjectFormat(wasm: unknown, ref: ObjectAddrLike, flags: FormatFlags): { ok: boolean; applied: string[] } {
  return call(wasm, 'pasteObjectFormatH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, JSON.stringify(flags));
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'hspace' | 'vspace' | 'width' | 'height' | 'size';

/** 여러 개체 맞춤·간격·크기 — refs 의 마지막 = 기준 개체(한/글: 맨 마지막에 선택한 개체). 본문 떠 있는 개체만 */
export function alignObjects(wasm: unknown, refs: ObjectAddrLike[], mode: AlignMode): { ok: boolean; moved: number; skipped: number } {
  const targets = refs.filter((r) => isBodyObject(r) && !cellPathJson(r)).map((r) => ({ sec: r.sec, ppi: r.ppi, ci: r.ci }));
  return call(wasm, 'alignObjectsH2022', JSON.stringify(targets), mode);
}

/** 그림 효과 값(저장 단위 그대로: 길이 HWPUNIT, 각도 도, 투명도 0..1). null = 효과 없음 */
export interface PictureEffectsValue {
  shadow: { style?: string; alpha: number; radius: number; direction: number; distance: number; color: string } | null;
  glow: { alpha: number; radius: number; color: string } | null;
  softEdge: { radius: number } | null;
  reflection: { radius: number; distance: number; alphaStart: number; alphaEnd: number; posStart: number; posEnd: number } | null;
}

export function getPictureEffects(wasm: unknown, ref: ObjectAddrLike): PictureEffectsValue | null {
  if (!isBodyObject(ref) || typeof rawDoc(wasm)?.getPictureEffectsH2022 !== 'function') return null;
  try { return call<PictureEffectsValue>(wasm, 'getPictureEffectsH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci); } catch { return null; }
}

/** 그림 효과 바꾸기(라우터 안에서) — 주어진 키만 */
export function setPictureEffects(wasm: unknown, ref: ObjectAddrLike, value: Partial<PictureEffectsValue>): { ok: boolean } {
  return call(wasm, 'setPictureEffectsH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, JSON.stringify(value));
}

/** 그림 바꾸기(한/글 PictureChange — 틀 크기 그대로, 그림·자르기·원래 크기만 새 그림으로) */
export function changePicture(wasm: unknown, ref: ObjectAddrLike, data: Uint8Array, w: number, h: number, ext: string): { ok: boolean } {
  return call(wasm, 'changePictureH2022', ref.sec, ref.ppi, cellPathJson(ref), ref.ci, data, w, h, ext);
}

/**
 * 개체 선택 상태의 한/글 단축키 → 명령 id (input-handler-keyboard 의 개체 선택 분기에서 부른다).
 * 한/글 2022 단축키(data/hangul2022_menu.json shortcuts): OrderFirst Shift+PgUp · OrderLast Shift+PgDn ·
 * PlacementInFrontOfText Shift+Home · PlacementBehindText Shift+End · CopyShapeFormatDlg Alt+Shift+C · PasteShapeFormat Alt+Shift+V.
 */
export function objectShortcutCommand(e: { key: string; code?: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): string | null {
  if (e.ctrlKey || e.metaKey || !e.shiftKey) return null;
  if (e.altKey) {
    const k = e.code === 'KeyC' || e.key === 'c' || e.key === 'C' || e.key === 'ㅊ' ? 'c'
      : e.code === 'KeyV' || e.key === 'v' || e.key === 'V' || e.key === 'ㅍ' ? 'v' : '';
    if (k === 'c') return 'object:copy-format';
    if (k === 'v') return 'object:paste-format';
    return null;
  }
  switch (e.key) {
    case 'PageUp': return 'object:order-first';
    case 'PageDown': return 'object:order-last';
    case 'Home': return 'object:in-front-of-text';
    case 'End': return 'object:behind-text';
    default: return null;
  }
}
