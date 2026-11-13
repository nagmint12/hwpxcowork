import { detectPlatformKind, type PlatformKind } from '../engine/navigation-keymap.ts';

/** 키보드 단축키 정의 */
export interface ShortcutDef {
  /** 키 문자 (소문자). 예: 'z', 'b', '=', '-' */
  key: string;
  /** 물리 키 코드. IME 입력 중 key가 Process일 때 사용한다. 예: 'KeyJ' */
  code?: string;
  /** Ctrl (Windows) 또는 Meta (Mac) */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 특정 플랫폼에서만 활성화해야 하는 단축키 */
  platform?: PlatformKind;
}

/** [hwpx-cowork] 한컴: Ctrl+1~9·Ctrl+0 = 스타일 목록의 1~10번째 스타일 */
export const STYLE_SHORTCUT_COUNT = 10;

export function styleShortcutCommandId(n: number): string {
  return `format:style-shortcut-${n}`;
}

export function isStyleShortcutCommand(commandId: string | null): boolean {
  return !!commandId?.startsWith('format:style-shortcut-');
}

/** 한글 IME 조합 중에는 key 가 'Process' 이므로 물리 Digit 코드로도 찾는다 */
const styleShortcuts: [ShortcutDef, string][] = Array.from({ length: STYLE_SHORTCUT_COUNT }, (_, i) => {
  const digit = String((i + 1) % 10);
  return [{ key: digit, code: `Digit${digit}`, ctrl: true }, styleShortcutCommandId(i + 1)];
});

/** 기본 단축키 → 커맨드 ID 매핑 */
export const defaultShortcuts: [ShortcutDef, string][] = [
  // 편집
  [{ key: 'z', ctrl: true }, 'edit:undo'],
  [{ key: 'z', ctrl: true, shift: true }, 'edit:redo'],
  // [hwpx-cowork] 한컴: Ctrl+Y = 한 줄 지우기, Alt+Y = 줄 뒤 지우기. 다시 실행은 Ctrl+Shift+Z 만 쓴다.
  [{ key: 'y', code: 'KeyY', ctrl: true }, 'edit:delete-line'],
  [{ key: 'ㅛ', ctrl: true }, 'edit:delete-line'],
  [{ key: 'y', code: 'KeyY', alt: true }, 'edit:delete-line-end'],
  [{ key: 'ㅛ', alt: true }, 'edit:delete-line-end'],
  // 한글 IME에서는 e.key가 'ㅁ' 또는 조합 중 'Process'가 되므로 물리 KeyA로 보정한다.
  [{ key: 'a', code: 'KeyA', ctrl: true }, 'edit:select-all'],

  [{ key: 'e', code: 'KeyE', ctrl: true }, 'edit:delete'],
  [{ key: 'ㄷ', ctrl: true }, 'edit:delete'],
  // macOS Option+C가 문자 입력으로 해석되어도 물리 C 키를 한컴 호환 모양 복사로 처리한다.
  [{ key: 'c', code: 'KeyC', alt: true }, 'edit:format-copy'],
  [{ key: 'ㅊ', alt: true }, 'edit:format-copy'],

  // 파일
  [{ key: 'n', alt: true }, 'file:new-doc'],
  [{ key: 'ㅜ', alt: true }, 'file:new-doc'],
  [{ key: 'o', ctrl: true }, 'file:open'],
  [{ key: 'ㅐ', ctrl: true }, 'file:open'],
  [{ key: 's', ctrl: true }, 'file:save'],
  // [Task #833] Ctrl+Shift+S → 다른 이름으로 저장 (한글 IME 'ㄴ'/Process 도 함께).
  [{ key: 's', code: 'KeyS', ctrl: true, shift: true }, 'file:save-as'],
  [{ key: 'ㄴ', ctrl: true, shift: true }, 'file:save-as'],
  [{ key: 'p', ctrl: true }, 'file:print'],

  // 서식
  [{ key: 'b', ctrl: true }, 'format:bold'],
  [{ key: 'i', ctrl: true }, 'format:italic'],
  [{ key: 'u', ctrl: true }, 'format:underline'],
  [{ key: 'l', alt: true }, 'format:char-shape'],
  [{ key: 'ㄹ', alt: true }, 'format:char-shape'],
  [{ key: 't', alt: true }, 'format:para-shape'],
  [{ key: 'ㅅ', alt: true }, 'format:para-shape'],
  // [#3682] 개체 속성 — 커맨드(shortcutLabel 'P')는 정의돼 있었으나 단축키 매핑이
  // 없어 어떤 경로로도 실행되지 않았다(차트/그림/도형 공통). 개체 선택 상태에서만
  // canExecute 가 참이므로 본문 타이핑의 'p' 와 충돌하지 않는다.
  [{ key: 'p', code: 'KeyP' }, 'format:object-properties'],
  [{ key: 'ㅔ', code: 'KeyP' }, 'format:object-properties'],

  // 서식 – 스타일
  [{ key: 'f6' }, 'format:style-dialog'],
  // [hwpx-cowork] 편집 칸 안에서는 브라우저 탭 전환(Ctrl+1~9)보다 먼저 먹는다. 편집 칸 밖은 브라우저 몫.
  // Ctrl+0 은 편집 칸 밖에서만 종전 100% 배율(main.ts 전역 경로). 편집 칸 안의 100% 는 Ctrl+G,Q.
  ...styleShortcuts,

  // 쪽
  [{ key: 'f7' }, 'file:page-setup'],

  // [hwpx-cowork] 한/글 2022: Ctrl+Num - = 한 수준 증가, Ctrl+Num + = 한 수준 감소 — 숫자판 키(code)로만, 줌(Ctrl+-/=)보다 먼저
  [{ key: 'numpadsubtract', code: 'NumpadSubtract', ctrl: true }, 'format:level-increase'],
  [{ key: 'numpadadd', code: 'NumpadAdd', ctrl: true }, 'format:level-decrease'],
  // [hwpx-cowork] 한/글 2022: Ctrl+Insert = 개요 적용/해제(ToggleOutlineNumber)
  [{ key: 'insert', code: 'Insert', ctrl: true }, 'format:outline-toggle'],

  // 줌
  [{ key: '=', ctrl: true }, 'view:zoom-in'],
  [{ key: '+', ctrl: true }, 'view:zoom-in'],
  [{ key: '+', ctrl: true, shift: true }, 'view:zoom-in'],
  [{ key: '-', ctrl: true }, 'view:zoom-out'],

  // 도구 상자 (한글 2024 호환)
  [{ key: 'f1', ctrl: true }, 'view:toolbox-basic'],

  // 검색
  [{ key: 'f', ctrl: true }, 'edit:find'],
  [{ key: 'f2', ctrl: true }, 'edit:find-replace'],
  [{ key: 'l', ctrl: true }, 'edit:find-again'],
  [{ key: 'v', alt: true, shift: true }, 'edit:compare-documents'],
  [{ key: 'h', ctrl: true, shift: true }, 'edit:document-history'],
  // macOS 영문 입력에서 Option+G의 key는 ©가 되지만 물리 키는 KeyG로 유지된다.
  [{ key: 'g', code: 'KeyG', alt: true }, 'edit:goto'],
  [{ key: 'ㅎ', alt: true }, 'edit:goto'],

  // 입력
  // [hwpx-cowork] IME 조합 중에는 key 가 'Process' 라 물리 F10 코드로도 찾는다(문자표 전역 키 — symbols-shortcut.ts).
  [{ key: 'f10', code: 'F10', alt: true }, 'insert:symbols'],
  // [hwpx-cowork] 한/글 2022 글자 바꾸기: F9 한자로 바꾸기 · Alt+F9 한글로 바꾸기
  [{ key: 'f9' }, 'edit:convert-hanja'],
  [{ key: 'f9', alt: true }, 'edit:convert-to-hangul'],

  // 쪽
  [{ key: 'enter', ctrl: true }, 'page:break'],
  [{ key: 'enter', ctrl: true, shift: true }, 'page:column-break'],
  // [hwpx-cowork] 한/글 2022: Ctrl+Alt+Enter = 다단 설정 나누기(InsertColDefBreak), Alt+Shift+Enter = 구역 나누기(BreakSection)
  [{ key: 'enter', ctrl: true, alt: true }, 'page:coldef-break'],
  [{ key: 'enter', alt: true, shift: true }, 'page:section-break'],

  // 줄간격
  [{ key: 'a', alt: true, shift: true }, 'format:line-spacing-decrease'],
  [{ key: 'ㅁ', alt: true, shift: true }, 'format:line-spacing-decrease'],
  [{ key: 'z', alt: true, shift: true }, 'format:line-spacing-increase'],
  [{ key: 'ㅋ', alt: true, shift: true }, 'format:line-spacing-increase'],

  // 글꼴 크기
  [{ key: 'e', alt: true, shift: true }, 'format:font-size-increase'],
  [{ key: 'ㄷ', alt: true, shift: true }, 'format:font-size-increase'],
  [{ key: 'r', alt: true, shift: true }, 'format:font-size-decrease'],
  [{ key: 'ㄱ', alt: true, shift: true }, 'format:font-size-decrease'],
  // 글꼴 크기 — Ctrl+]/[ (한컴 호환, 브라우저 충돌 없음)
  [{ key: ']', ctrl: true }, 'format:font-size-increase'],
  [{ key: '[', ctrl: true }, 'format:font-size-decrease'],

  // 장평/자간 (한컴 호환)
  [{ key: 'j', code: 'KeyJ', alt: true, shift: true }, 'format:char-ratio-decrease'],
  [{ key: 'ㅓ', alt: true, shift: true }, 'format:char-ratio-decrease'],
  [{ key: 'k', code: 'KeyK', alt: true, shift: true }, 'format:char-ratio-increase'],
  [{ key: 'ㅏ', alt: true, shift: true }, 'format:char-ratio-increase'],
  [{ key: 'n', code: 'KeyN', alt: true, shift: true }, 'format:char-spacing-decrease'],
  [{ key: 'ㅜ', alt: true, shift: true }, 'format:char-spacing-decrease'],
  [{ key: 'w', code: 'KeyW', alt: true, shift: true }, 'format:char-spacing-increase'],
  [{ key: 'ㅈ', alt: true, shift: true }, 'format:char-spacing-increase'],

  // 문단 정렬
  // Ctrl+Shift+L: 왼쪽 정렬 (브라우저 주소창 포커스이나 편집 영역에서 양보)
  [{ key: 'l', ctrl: true, shift: true }, 'format:align-left'],
  // Ctrl+Shift+M: 양쪽 정렬 (브라우저 충돌 없음)
  [{ key: 'm', ctrl: true, shift: true }, 'format:align-justify'],
  // Ctrl+Shift+R: 브라우저 강제새로고침 충돌 → Alt+Shift+H로 재매핑 (Alt+Shift+R은 글꼴크기축소)
  // Ctrl+Shift+C: 브라우저 요소검사 충돌 → Alt+Shift+C로 재매핑
  // Ctrl+Shift+T: 브라우저 탭복원 충돌 → Alt+Shift+T로 재매핑
  [{ key: 'h', alt: true, shift: true }, 'format:align-right'],   // 오른쪽 정렬 (재매핑, H=rigHt)
  [{ key: 'ㅗ', alt: true, shift: true }, 'format:align-right'],
  [{ key: 'c', alt: true, shift: true }, 'format:align-center'],  // 가운데 정렬 (재매핑)
  [{ key: 'ㅊ', alt: true, shift: true }, 'format:align-center'],
  [{ key: 'd', alt: true, shift: true }, 'format:align-distribute'], // 배분 정렬 (재매핑)
  [{ key: 'ㅇ', alt: true, shift: true }, 'format:align-distribute'],

  // 표
  // [hwpx-cowork] 한컴 줄/칸 추가하기는 Alt+Insert. Alt+Enter 는 Insert 키가 없는 자판(맥)용 별칭으로 남긴다.
  [{ key: 'insert', code: 'Insert', alt: true }, 'table:insert-row-col'],
  [{ key: 'enter', alt: true }, 'table:insert-row-col'],
  [{ key: 'delete', alt: true }, 'table:delete-row-col'],
  [{ key: 'a', ctrl: true, shift: true }, 'table:block-avg'],
  [{ key: 'p', ctrl: true, shift: true }, 'table:block-product'],
];

/**
 * KeyboardEvent에 매칭되는 단축키가 있으면 커맨드 ID를 반환한다.
 * 없으면 null.
 */
export function matchShortcut(
  e: KeyboardEvent,
  shortcuts: [ShortcutDef, string][],
  platform: PlatformKind = detectPlatformKind(),
): string | null {
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  const eventKey = e.key.toLowerCase();
  const eventCode = (e.code ?? '').toLowerCase();

  for (const [def, cmdId] of shortcuts) {
    if (def.platform && def.platform !== platform) continue;
    if (def.ctrl && !ctrlOrMeta) continue;
    if (!def.ctrl && ctrlOrMeta) continue;
    if ((def.shift ?? false) !== e.shiftKey) continue;
    if ((def.alt ?? false) !== e.altKey) continue;
    if (eventKey === def.key) return cmdId;
    if (def.code && eventCode === def.code.toLowerCase()) return cmdId;
  }
  return null;
}
