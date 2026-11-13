/**
 * [hwpx-cowork] Backspace/Delete 로 조판 부호를 지운다 — 한/글 2022 실측(2026-10-30, 숨긴 한글 HAction DeleteBack/Delete)과 같게.
 *
 * 캐럿 = (논리 자리, 틈 자리 codeGap). 틈 자리는 그 자리 앞 틈의 폭 없는 부호(감추기·선·자리차지 표·머리말·새 번호·책갈피·메모 시작/끝 …)
 * 가운데 캐럿 앞에 있는 개수다(없으면 틈 끝 = 부호 뒤). 지울 것은 엔진 getCodeDeleteTarget 이 정한다:
 *  · 조판 부호 보기 켬: 캐럿 바로 앞(Backspace)·뒤(Delete) 부호를 '지우기 — [감추기] 를 지울까요? [지움(Y)] [취소(N)]' 로 묻는다.
 *    붙은 부호는 하나씩(가나[감추기][선]다라 에서 Backspace → [선] → [감추기] → 나 → 가).
 *  · 보기 끔: 숨은 부호는 묻지도 지우지도 않는다 — Backspace 는 부호 앞 글자, Delete 는 부호 뒤 글자를 지운다(호출부 글자 지우기).
 *    늘 보이는 것(글자처럼 취급한 표·그림·수식, 메모, 자동 번호)은 보기를 꺼도 묻는다. 단 글머리표 문단 첫 자리(숨은 부호 뒤)의
 *    Backspace 는 그 부호를 묻는다(표 아래 빈 줄 → '[표] 를 지울까요?').
 *  · 문단 첫 자리 Backspace·문단 끝 Delete 는 묻지 않고 문단을 합친다(부호는 따라간다 — 호출부).
 *  · [취소] 하면 캐럿은 그대로, 다음 지우기는 같은 부호를 다시 묻는다(건너뛰지 않는다).
 *  · [지움] 은 부호만 빼고 캐럿은 부호가 있던 자리. 스냅샷 편집 하나라 되돌리기 한 번에 부호 하나가 돌아온다.
 * 끌어 고른 범위를 지울 때는 묻지 않는다(deleteSelection 경로). 머리말·꼬리말·각주 안, 누름틀(종전 누름틀 지우기 창)은 다루지 않는다.
 * 메모: '[메모] 를 지울까요?' + 답글도 지워진다는 덧말. 같은 자리 글 없는 메모가 여럿이면 한 번에 모두 지운다(종전 규칙). 공유 문서에서는
 * 밀어 넣기로 서버 메모·답글도 지워진다(server/live.js).
 */
import type { CodeControlInfo, CodeControlTarget, CodeDeleteTarget, DocumentPosition } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { OperationDescriptor } from './command';
import { confirmCodeControlDelete } from '@/ui/code-delete-dialog';
import { showToast } from '@/ui/toast';
import { t } from '../i18n/index.ts';

type CodeDeleteHost = {
  wasm: WasmBridge;
  cursor?: { isInHeaderFooter?(): boolean; isInFootnote?(): boolean; setCodeGap?(gap: number | null): void; updateRect?(): void };
  isFormMode?(): boolean;
  focusTextarea(): void;
  executeOperation(operation: OperationDescriptor): unknown;
};
const pending = new WeakSet<CodeDeleteHost>();

/** 캐럿 자리 → 조판 부호 편집 대상 문단(본문 문단, 또는 표 칸·캡션·글상자 경로) */
export function codeControlTarget(pos: DocumentPosition): CodeControlTarget | null {
  if (pos.parentParaIndex === undefined) return { sec: pos.sectionIndex, para: pos.paragraphIndex };
  const path = pos.cellPath?.length
    ? pos.cellPath
    : pos.controlIndex !== undefined && pos.cellIndex !== undefined
      ? [{ controlIndex: pos.controlIndex, cellIndex: pos.cellIndex, cellParaIndex: pos.cellParaIndex ?? 0 }]
      : null;
  if (!path) return null;
  return {
    sec: pos.sectionIndex,
    para: pos.parentParaIndex,
    cellPath: path.map((e) => ({ controlIndex: e.controlIndex, cellIndex: e.cellIndex, cellParaIndex: e.cellParaIndex })),
  };
}

/** 부호 이름 — 한/글이 부르는 이름('그림'·'표'·'번호 넣기'·'새 번호' …), 없으면 편집기 이름('찾아보기 표식' …) */
export function codeControlLabel(info: CodeControlInfo | CodeDeleteTarget): string {
  if (info.label) return info.label;
  const type = info.numType ? t(`codeControl.numType.${info.numType}`) : '';
  return t(`codeControl.kind.${info.kind}`, { type });
}

/** 개체 부호를 지운다 — 다룰 수 없는 자리(칸 안의 표·도형·수식)면 null(호출부는 종전 지우기를 한다) */
function objectDeleter(target: CodeControlTarget, hit: CodeDeleteTarget): ((wasm: WasmBridge) => void) | null {
  const ci = hit.codeIndex;
  if (target.cellPath?.length) {
    if (hit.objectType !== 'picture') return null;
    const path = target.cellPath;
    return (wasm) => { wasm.deleteCellPictureControlByPath(target.sec, target.para, path, ci); };
  }
  switch (hit.objectType) {
    case 'table': return (wasm) => { wasm.deleteTableControl(target.sec, target.para, ci); };
    case 'picture': return (wasm) => { wasm.deletePictureControl(target.sec, target.para, ci); };
    case 'equation': return (wasm) => { wasm.deleteEquationControl(target.sec, target.para, ci); };
    case 'shape': return (wasm) => { wasm.deleteShapeControl(target.sec, target.para, ci); };
    default: return null;
  }
}

/** 부호를 빼는 일 — 개체·머리말/꼬리말·그 밖의 부호(엔진 deleteCodeControl). 다룰 수 없으면 null */
function codeRemover(target: CodeControlTarget, hit: CodeDeleteTarget): ((wasm: WasmBridge) => void) | null {
  if (hit.kind === 'object') return objectDeleter(target, hit);
  if (hit.kind === 'header' || hit.kind === 'footer') {
    if (target.cellPath?.length || hit.applyTo === undefined) return null;
    const isHeader = hit.kind === 'header';
    const applyTo = hit.applyTo;
    return (wasm) => { wasm.deleteHeaderFooter(target.sec, isHeader, applyTo); };
  }
  // 누름틀·그 밖의 필드·숨은 설명은 종전 길(누름틀 지우기 창 등)
  if (hit.kind === 'clickHere' || hit.kind === 'field' || hit.kind === 'hiddenComment') return null;
  const ci = hit.codeIndex;
  const memoMany = hit.kind === 'memo' && (hit.memoCount ?? 1) > 1;
  return (wasm) => {
    wasm.deleteCodeControl(target, ci);
    // 같은 자리의 글 없는 메모를 모두(한 스냅샷 — 되돌리기 한 번에 함께 돌아온다)
    for (let k = 1; memoMany && k < (hit.memoCount ?? 1); k++) {
      const gap = wasm.getCodeGap(target, hit.caret.charOffset);
      const codes = gap?.codes ?? [];
      const empty = codes.find((c) => c.kind === 'memo' && c.item === 'control'
        && codes.some((o) => o.kind === 'memo' && o.item === 'fieldEnd' && o.codeIndex === c.codeIndex));
      if (!empty) break;
      wasm.deleteCodeControl(target, empty.codeIndex);
    }
  };
}

/** 조판 부호 보기가 켜져 있는가 */
function codesViewOn(self: CodeDeleteHost): boolean {
  try { return !!self.wasm.getShowControlCodes?.(); } catch { return false; }
}

/**
 * Backspace(backward)·Delete(forward)가 조판 부호에 닿으면 묻고 지운다. 처리했으면 true — 호출부는 글자 지우기를 하지 않는다.
 * 부호가 없거나(보기를 끈 숨은 부호 포함) 다룰 수 없는 문맥이면 false.
 */
export function tryDeleteCodeControl(self: CodeDeleteHost, position: DocumentPosition, direction: 'backward' | 'forward'): boolean {
  if (pending.has(self)) return true;
  if (self.isFormMode?.() || self.cursor?.isInHeaderFooter?.() || self.cursor?.isInFootnote?.()) return false;
  const pos = structuredClone(position);
  const target = codeControlTarget(pos);
  if (!target) return false;
  const gap = pos.codeGap;
  let info: CodeDeleteTarget | null;
  try { info = self.wasm.getCodeDeleteTarget(target, pos.charOffset, gap, direction); } catch { return false; }
  if (!info) return false;
  const hit = info;
  const remove = codeRemover(target, hit);
  if (!remove) return false;
  const run = () => {
    self.executeOperation({
      kind: 'snapshot',
      operationType: hit.kind === 'object' ? 'deleteObject' : 'deleteCodeControl',
      selectionBefore: null,
      operation: (wasm) => {
        remove(wasm);
        // 캐럿 = 부호가 있던 자리(엔진이 정한 틈 자리)
        const after: DocumentPosition = { ...pos, charOffset: hit.caret.charOffset };
        after.codeGap = hit.caret.gap;
        return after;
      },
    });
  };
  // 부호 하나를 지울 때는 늘 묻는다(한/글). 묻지 않는 것은 끌어 고른 범위를 한꺼번에 지울 때뿐(deleteSelection)
  const generation = self.wasm.documentGeneration;
  const finish = () => { pending.delete(self); self.focusTextarea(); };
  pending.add(self);
  const label = hit.kind === 'memo' && (hit.memoCount ?? 1) > 1 ? t('codeControl.kind.memoMany', { n: hit.memoCount ?? 1 }) : codeControlLabel(hit);
  confirmCodeControlDelete(label, () => {
    try {
      // 묻는 사이 문서가 바뀌었으면(남의 고침 맞추기 등) 그 자리를 믿지 않는다
      if (self.wasm.documentGeneration !== generation) throw new Error(t('dialog.codeDelete.stale'));
      const again = self.wasm.getCodeDeleteTarget(target, pos.charOffset, gap, direction);
      if (!again || again.codeIndex !== hit.codeIndex || again.kind !== hit.kind) throw new Error(t('dialog.codeDelete.stale'));
      run();
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : String(error) });
    } finally { finish(); }
  }, () => {
    // [취소] — 캐럿은 그대로, 다음 지우기는 같은 부호를 다시 묻는다(한/글 실측)
    finish();
  }, hit.kind === 'memo' ? t('dialog.codeDelete.memoNote') : '');
  return true;
}

/**
 * [hwpx-cowork] 문단을 합치기 전 — 조판 부호 보기에서 합친 뒤 캐럿이 앞 문단 끝 부호들 뒤·옮겨 온 부호들 앞에 서도록(한/글 실측:
 * '캐럿은 옮겨 온 부호 바로 앞') 앞 문단 끝 틈의 부호 수를 잰다. 합친 뒤 `after()` 를 부른다. 보기를 끄면 아무것도 안 한다(부호 뒤).
 */
export function codeGapAcrossMerge(self: CodeDeleteHost, sec: number, prevPara: number): { after(): void } {
  const none = { after() {} };
  if (!codesViewOn(self)) return none;
  try {
    const len = self.wasm.getCodeGap({ sec, para: prevPara }, 1 << 30);
    const end = len?.len;
    if (end === undefined) return none;
    const before = self.wasm.getCodeGap({ sec, para: prevPara }, end)?.codes.length ?? 0;
    return {
      after() {
        self.cursor?.setCodeGap?.(before);
        self.cursor?.updateRect?.();
      },
    };
  } catch { return none; }
}
