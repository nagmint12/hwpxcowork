export interface CellBlockCtrlShiftSContext {
  inCellSelectionMode: boolean;
  blockSumEnabled: boolean;
  saveAsEnabled: boolean;
}

export type ContextualShortcutResolution =
  | { kind: 'dispatch'; commandId: 'table:block-sum' | 'file:save-as' }
  | { kind: 'consume' }
  | null;

// [hwpx-cowork] 셀 블록 글자 단축키 — 한컴 「단축키 일람」 '셀 블록 상태에서'의 P·L·C·B·F·H·W 를
// S/M 과 같은 길로 해석한다. L/C/B/F 는 셀 테두리/배경 대화상자의 처음 탭을 params 로 넘긴다.
export type CellBlockLetterCommandId =
  | 'table:cell-split'
  | 'table:cell-merge'
  | 'table:cell-props'
  | 'table:border-each'
  | 'table:border-one'
  | 'table:cell-height-equal' // [hwpx-cowork] 셀 블록 H/W — 엔진 equalizeTableCellSizes 연결(h2022 표)
  | 'table:cell-width-equal'
  | 'table:swap'; // [hwpx-cowork] 셀 블록 T = 표 뒤집기(한/글 단축키 TableSwapDlg 'T')

export type CellBlockLetterShortcutResolution =
  | { kind: 'dispatch'; commandId: CellBlockLetterCommandId; params?: { tab: 'border' | 'background' }; fallbackCommandId?: CellBlockLetterCommandId }
  | { kind: 'consume' }
  | null;

/** [hwpx-cowork] 한글 호환 자모(ㄱ~ㆎ) — 한글 입력 상태의 글자 keydown 이 내는 key 값. */
export function isHangulJamoKey(key: string): boolean {
  if (key.length !== 1) return false;
  const c = key.charCodeAt(0);
  return c >= 0x3131 && c <= 0x318e;
}

type CellBlockLetterImeGuardState = 'idle' | 'armed' | 'composition';
type CellBlockLetterImeFollowupEvent = 'compositionstart' | 'input' | 'compositionend';

/**
 * 한글 IME의 물리 S/M keydown은 preventDefault 뒤에도 composition/input을 이어서 낼 수 있다.
 * 셀 명령으로 소비한 IME keydown만 arm하고, 그 한 조합 스트림을 문서 입력 경로에서 격리한다.
 */
export class CellBlockLetterImeGuard {
  private state: CellBlockLetterImeGuardState = 'idle';
  private ghostText = '';

  arm(
    event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>,
  ): boolean {
    // [hwpx-cowork] S/M 의 'ㄴ'/'ㅡ' 만이 아니라 P('ㅔ')·L('ㅣ') 등 모든 셀 블록 글자 단축키가
    // 같은 조합 스트림을 낼 수 있으므로 한글 자모 전체를 IME 소유로 본다.
    const imeOwned = isHangulJamoKey(event.key)
      || event.key === 'Process'
      || event.isComposing
      || event.keyCode === 229;
    this.state = imeOwned ? 'armed' : 'idle';
    this.ghostText = '';
    return imeOwned;
  }

  consume(eventType: CellBlockLetterImeFollowupEvent, text = ''): boolean {
    if (this.state === 'idle') {
      if (eventType === 'input' && this.ghostText && text === this.ghostText) {
        this.ghostText = '';
        return true;
      }
      if (eventType === 'input') this.ghostText = '';
      return false;
    }

    if (this.state === 'armed') {
      this.state = eventType === 'compositionstart' ? 'composition' : 'idle';
      if (eventType === 'compositionend' && text) this.ghostText = text;
      return true;
    }

    if (text) this.ghostText = text;
    if (eventType === 'compositionend') this.state = 'idle';
    return true;
  }

  reset(): void {
    this.state = 'idle';
    this.ghostText = '';
  }
}

/**
 * Ctrl/Cmd+Shift+S는 일반 문맥에서는 다른 이름으로 저장이지만, F5 셀 블록에서는
 * 한컴 호환 블록 합계다. embed처럼 Save As 소유권이 없는 프로파일에서는 후순위
 * 표 명령으로 우회하지 않고 브라우저 기본 동작만 막는다.
 */
export function resolveCellBlockCtrlShiftS(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  context: CellBlockCtrlShiftSContext,
): ContextualShortcutResolution {
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const isS = event.key.toLowerCase() === 's'
    || event.key === 'ㄴ'
    || event.code.toLowerCase() === 'keys';

  if (!ctrlOrMeta || !event.shiftKey || event.altKey || !isS) return null;
  if (!context.inCellSelectionMode) return null;
  if (!context.saveAsEnabled) return { kind: 'consume' };
  if (context.blockSumEnabled) {
    return { kind: 'dispatch', commandId: 'table:block-sum' };
  }
  return { kind: 'dispatch', commandId: 'file:save-as' };
}

/**
 * F5 셀 블록의 수정자 없는 물리 S/M을 입력 언어와 무관하게 셀 명령으로 해석한다.
 * Shift는 대문자 S/M 입력에 쓰일 수 있어 허용하고, Ctrl/Meta/Alt가 있으면 다른 단축키
 * 소유권을 침범하지 않는다. `Process`는 code가 실제 물리 키를 알려줄 때만 처리한다.
 */
export function resolveCellBlockLetterShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  context: { inCellSelectionMode: boolean; protectedCellSelection?: boolean },
): CellBlockLetterShortcutResolution {
  if (!context.inCellSelectionMode || event.ctrlKey || event.metaKey || event.altKey) return null;

  const key = event.key.toLowerCase();
  const code = event.code.toLowerCase();
  if (key === 's' || event.key === 'ㄴ' || code === 'keys') {
    return { kind: 'dispatch', commandId: 'table:cell-split' };
  }
  if (key === 'm' || event.key === 'ㅡ' || code === 'keym') {
    return { kind: 'dispatch', commandId: 'table:cell-merge' };
  }
  // [hwpx-cowork] 한컴 셀 블록 글자 단축키(도움말 「단축키 일람」 '셀 블록 상태에서').
  // 자모는 Shift 로 쌍자음·복모음이 될 수 있어 둘 다 받는다(ㅔ/ㅖ, ㅈ/ㅉ).
  const letter = physicalLetter(event.key, code);
  // 보호 칸 블록(보호 칸 클릭으로 들어온 블록)에서는 대화상자를 열지 않고 글자만 막는다.
  if (context.protectedCellSelection && letter && 'plcbfhwt'.includes(letter)) return { kind: 'consume' };
  switch (letter) {
    case 'p': // 표/셀 속성
      return { kind: 'dispatch', commandId: 'table:cell-props' };
    case 'l': // 각 셀 테두리 모양
      return { kind: 'dispatch', commandId: 'table:border-each', params: { tab: 'border' } };
    case 'c': // 각 셀 배경 모양
      return { kind: 'dispatch', commandId: 'table:border-each', params: { tab: 'background' } };
    case 'b': // 여러 셀 테두리 모양 — 한 칸 블록이면 '각 셀마다'로 대신한다
      return { kind: 'dispatch', commandId: 'table:border-one', params: { tab: 'border' }, fallbackCommandId: 'table:border-each' };
    case 'f': // 여러 셀 배경 모양
      return { kind: 'dispatch', commandId: 'table:border-one', params: { tab: 'background' }, fallbackCommandId: 'table:border-each' };
    case 'h': // 셀 높이를 같게 — [hwpx-cowork] 엔진 equalizeTableCellSizes 로 연결(h2022 표, 2026-11-11)
      return { kind: 'dispatch', commandId: 'table:cell-height-equal' };
    case 'w': // 셀 너비를 같게
      return { kind: 'dispatch', commandId: 'table:cell-width-equal' };
    case 't': // [hwpx-cowork] 표 뒤집기(한/글 TableSwapDlg 단축키 T)
      return { kind: 'dispatch', commandId: 'table:swap' };
    default:
      return null;
  }
}

/** [hwpx-cowork] 물리 키(code 우선) → 영문 소문자. 한글 자모는 두벌식 자리로 되돌린다. */
const JAMO_TO_LETTER: Record<string, string> = {
  'ㅔ': 'p', 'ㅖ': 'p', 'ㅣ': 'l', 'ㅊ': 'c', 'ㅠ': 'b', 'ㄹ': 'f', 'ㅗ': 'h', 'ㅈ': 'w', 'ㅉ': 'w',
  'ㄷ': 'e', 'ㄸ': 'e', 'ㅁ': 'a', 'ㅛ': 'y', 'ㄴ': 's', 'ㅡ': 'm', 'ㅅ': 't', 'ㅆ': 't',
};

function physicalLetter(key: string, lowerCode: string): string | null {
  const m = /^key([a-z])$/.exec(lowerCode);
  if (m) return m[1];
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toLowerCase();
  return JAMO_TO_LETTER[key] ?? null;
}

// ─── [hwpx-cowork] 표 문맥 단축키 ──────────────────────────────────────────
//
// 한컴 「단축키 일람」의 '표 내부에 커서를 둔 상태'·'셀 블록 상태'·'표를 선택한 상태'에서만
// 뜻이 바뀌는 키를 한 곳에서 해석한다. 일반 단축키 표(shortcut-map)는 문맥을 모르므로,
// keydown 흐름의 IME 조기 반환·셀 블록 해제보다 **앞에서** 이 해석을 먼저 해야 한다.

export interface TableKeyShortcutContext {
  /** 캐럿이 표 칸 안(글상자 본문은 제외) */
  inTableCell: boolean;
  /** 중첩 표·글상자 안 표 — 줄 추가/지우기 API 가 아직 닿지 않는다 */
  nestedTable: boolean;
  inCellSelectionMode: boolean;
  /** 셀 블록이 두 줄 이상에 걸쳤다 */
  multiRowCellSelection: boolean;
  inTableObjectSelection: boolean;
  /** 칸 안에 글자 선택이 있다 */
  hasTextSelection: boolean;
  /** 머리말/꼬리말·각주·양식 모드·그림 선택 — 이 해석기가 손대지 않는다 */
  otherMode: boolean;
}

export type TableKeyCommandId =
  | 'table:append-row'
  | 'table:subtract-row'
  | 'table:block-avg'
  | 'table:block-product'
  | 'table:cell-props'
  | 'table:easy-sum-h' | 'table:easy-sum-v' // [hwpx-cowork] 쉬운 계산식(한/글 Ctrl+Shift+H/V/J/B/K/N)
  | 'table:easy-avg-h' | 'table:easy-avg-v'
  | 'table:easy-product-h' | 'table:easy-product-v'
  | 'edit:delete';

export type TableKeyShortcutResolution =
  | { kind: 'dispatch'; commandId: TableKeyCommandId; ime?: boolean }
  | { kind: 'clear-cell-block' }
  | { kind: 'consume' }
  | null;

export function resolveTableKeyShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  ctx: TableKeyShortcutContext,
): TableKeyShortcutResolution {
  if (ctx.otherMode) return null;
  const code = (event.code ?? '').toLowerCase();
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const inTableEdit = ctx.inTableCell || ctx.inCellSelectionMode;

  // 표 선택 상태의 P = 개체 속성(표/셀 속성 — 표 모드), Ctrl+E = 지우기
  if (ctx.inTableObjectSelection) {
    if (!ctrlOrMeta && !event.altKey && physicalLetter(event.key, code) === 'p') {
      return { kind: 'dispatch', commandId: 'table:cell-props', ime: true };
    }
    if (ctrlOrMeta && !event.shiftKey && !event.altKey && physicalLetter(event.key, code) === 'e') {
      return { kind: 'dispatch', commandId: 'edit:delete' };
    }
    return null;
  }
  if (!inTableEdit) return null;

  const isEnter = event.key === 'Enter' || code === 'enter' || code === 'numpadenter';
  if (ctrlOrMeta && !event.altKey && isEnter) {
    // Ctrl+Shift+Enter(단 나누기)는 표 안에서 할 일이 없다 — 본문 문단을 쪼개지 않게 막기만 한다.
    if (event.shiftKey) return { kind: 'consume' };
    // Ctrl+Enter = 줄 추가하기(현재 줄 아래)
    if (ctx.nestedTable) return { kind: 'consume' };
    return { kind: 'dispatch', commandId: 'table:append-row' };
  }

  // Ctrl+Backspace = 줄 지우기. macOS Cmd+Backspace(줄 처음까지 지우기)는 그대로 둔다.
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
      && (event.key === 'Backspace' || code === 'backspace')) {
    // 한/글 동작이 확인되지 않은 경우는 보수적으로: 글자 선택이 있으면 종전처럼 선택만 지우고,
    // 여러 줄 셀 블록이면 아무것도 지우지 않는다.
    if (!ctx.inCellSelectionMode && ctx.hasTextSelection) return null;
    if (ctx.nestedTable || ctx.multiRowCellSelection) return { kind: 'consume' };
    return { kind: 'dispatch', commandId: 'table:subtract-row' };
  }

  // [hwpx-cowork] 쉬운 계산식(한/글 2022 단축키 — 표 안 캐럿): Ctrl+Shift+H/V 가로/세로 합계,
  // J/B 가로/세로 평균, K/N 가로/세로 곱. 표 밖의 같은 키(Ctrl+Shift+H 문서 이력 등)는 그대로 둔다.
  // 셀 블록에서는 B/A/P 등 블록 명령과 겹치지 않게 캐럿 상태에서만 받는다.
  if (ctrlOrMeta && event.shiftKey && !event.altKey && !ctx.inCellSelectionMode && ctx.inTableCell && !ctx.nestedTable) {
    const easy: Record<string, TableKeyCommandId> = {
      h: 'table:easy-sum-h', v: 'table:easy-sum-v', j: 'table:easy-avg-h',
      b: 'table:easy-avg-v', k: 'table:easy-product-h', n: 'table:easy-product-v',
    };
    const letter = physicalLetter(event.key, code);
    if (letter && easy[letter]) return { kind: 'dispatch', commandId: easy[letter] };
  }

  if (!ctx.inCellSelectionMode) return null;

  // 셀 블록 Ctrl+E = 셀 내용 지우기(Delete 와 같다)
  if (ctrlOrMeta && !event.shiftKey && !event.altKey && physicalLetter(event.key, code) === 'e') {
    return { kind: 'clear-cell-block' };
  }
  // 셀 블록 Ctrl+Shift+A / Ctrl+Shift+P = 블록 평균 / 블록 곱 (S 는 resolveCellBlockCtrlShiftS 가 소유)
  if (ctrlOrMeta && event.shiftKey && !event.altKey) {
    const letter = physicalLetter(event.key, code);
    if (letter === 'a') return { kind: 'dispatch', commandId: 'table:block-avg' };
    if (letter === 'p') return { kind: 'dispatch', commandId: 'table:block-product' };
  }
  return null;
}
