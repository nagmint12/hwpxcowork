/**
 * [hwpx-cowork] 문자표(Alt+F10) 전역 단축키.
 *
 * 한/글에서 Alt+F10 은 캐럿이 본문·표 칸·머리말·각주 어디에 있든, 도구 상자를 누른 뒤든 문자표를 연다.
 * 종전에는 InputHandler(편집 textarea)와 setupGlobalShortcuts 의 일부 분기만 이 키를 알아서
 * 도구 상자 단추·찾기 창 입력 칸에 포커스가 있거나, 머리말/각주 편집 중이거나, 한글 IME 조합 중
 * (key='Process')이면 아무 일도 일어나지 않았다(2026-11-12 headless Chromium 실측).
 *
 * 그래서 이 키 하나만 window capture 단계에서 먼저 받아 포커스 위치와 관계없이 같은 명령으로 보낸다.
 * - preventDefault: 크롬(Windows)이 F10/Alt 를 브라우저 메뉴 막대 포커스로 가져가지 않게 한다.
 * - 전파를 끊는다 — 뒤의 InputHandler·전역 경로와 두 번 실행되지 않게.
 * - 다른 모달 대화상자가 떠 있으면 열지 않는다(한/글도 모달 위에는 문자표를 겹쳐 띄우지 않는다).
 *   모든 모달이 키를 막지는 않아(문단 모양 등) 종전에는 InputHandler 가 받아 모달 위에 문자표를 겹쳐 열었다
 *   — 그래서 이때도 전파를 끊어 키를 여기서 끝낸다.
 * 다른 단축키는 건드리지 않는다(이 키가 아니면 바로 false).
 */
import { defaultShortcuts, matchShortcut } from './shortcut-map.ts';

export const SYMBOLS_COMMAND_ID = 'insert:symbols';

export function isSymbolsShortcut(e: KeyboardEvent): boolean {
  return matchShortcut(e, defaultShortcuts) === SYMBOLS_COMMAND_ID;
}

export interface SymbolsShortcutDeps {
  /** insert:symbols 실행(문서가 없으면 명령의 canExecute 가 막는다) */
  dispatch(): void;
  /** 다른 모달 대화상자(.modal-overlay)가 떠 있는가 */
  isModalOpen(): boolean;
}

/** 이 키를 처리했으면 true. */
export function handleSymbolsShortcut(e: KeyboardEvent, deps: SymbolsShortcutDeps): boolean {
  if (!isSymbolsShortcut(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat && !deps.isModalOpen()) deps.dispatch();
  return true;
}
