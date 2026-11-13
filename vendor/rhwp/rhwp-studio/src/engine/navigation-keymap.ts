export type PlatformKind = 'mac' | 'other';

export type NavigationAction =
  | 'wordBackward'
  | 'wordForward'
  | 'lineStart'
  | 'lineEnd'
  | 'paragraphBackward'
  | 'paragraphForward'
  // [hwpx-cowork] 한/글 2022 MoveParaBegin(Alt+Home)·MoveParaEnd(Alt+End) — 지금 문단의 처음/끝
  | 'paragraphStart'
  | 'paragraphEnd'
  // [hwpx-cowork] 한/글 2022 MoveTopLevelBegin(Ctrl+PageUp)·MoveTopLevelEnd(Ctrl+PageDown) — 문서 처음/끝
  | 'documentStart'
  | 'documentEnd'
  // [hwpx-cowork] 한/글 2022 PrevPage(Alt+PageUp)·NextPage(Alt+PageDown) — 앞/뒤 쪽의 시작
  | 'pagePrev'
  | 'pageNext';

export interface NavigationKeyInput {
  key?: string;
  code?: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type CellSelectionArrowAction = 'resize' | 'navigate';

/**
 * Resolve arrow ownership while F5 cell selection is active.
 *
 * Only Ctrl/Command resize maps to persisted table geometry. Alt/Shift arrows
 * remain ordinary cell navigation so unsupported local geometry never swallows
 * the user's input before the navigation owner can handle it.
 */
export function getCellSelectionArrowAction(
  input: NavigationKeyInput,
): CellSelectionArrowAction | null {
  const isArrow = input.key === 'ArrowUp'
    || input.key === 'ArrowDown'
    || input.key === 'ArrowLeft'
    || input.key === 'ArrowRight';
  if (!isArrow) return null;
  return input.ctrlKey || input.metaKey ? 'resize' : 'navigate';
}

interface PlatformInfo {
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: {
    platform?: string;
  };
}

type NavigationTestGlobal = typeof globalThis & {
  __rhwpTestPlatformKind?: PlatformKind;
};

function testPlatformOverride(): PlatformKind | null {
  const value = (globalThis as NavigationTestGlobal).__rhwpTestPlatformKind;
  return value === 'mac' || value === 'other' ? value : null;
}

export function detectPlatformKind(nav?: PlatformInfo): PlatformKind {
  const override = testPlatformOverride();
  if (override) return override;

  const source = (nav ?? (typeof navigator === 'undefined' ? undefined : navigator)) as PlatformInfo | undefined;
  const platform = source?.userAgentData?.platform || source?.platform || '';
  const userAgent = source?.userAgent || '';

  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'mac';
  if (/mac os x|iphone|ipad|ipod/i.test(userAgent)) return 'mac';
  return 'other';
}

function navigationKey(input: NavigationKeyInput): string {
  const key = input.key || '';
  if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' ||
      key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') {
    return key;
  }
  return input.code || key;
}

export function getNavigationAction(
  input: NavigationKeyInput,
  platform: PlatformKind = detectPlatformKind(),
): NavigationAction | null {
  const key = navigationKey(input);
  const hasOnlyShift = !input.ctrlKey && !input.metaKey && !input.altKey;

  if (hasOnlyShift) {
    if (key === 'Home') return 'lineStart';
    if (key === 'End') return 'lineEnd';
    return null;
  }

  // [hwpx-cowork] 한/글 2022 단축키 표(hangul2022_menu.json shortcuts): Alt+Home/End = 문단 처음/끝,
  // Ctrl+PageUp/PageDown = 문서(탑레벨 목록) 처음/끝. 맥은 Option+Home/End 를 같은 뜻으로 둔다.
  if (input.altKey && !input.ctrlKey && !input.metaKey) {
    if (key === 'Home') return 'paragraphStart';
    if (key === 'End') return 'paragraphEnd';
    if (key === 'PageUp' && !input.shiftKey) return 'pagePrev';
    if (key === 'PageDown' && !input.shiftKey) return 'pageNext';
  }
  // [hwpx-cowork] 2026-11-12 통합: 한/글의 Ctrl+PageUp/PageDown(문서 처음/끝)은 잇지 않는다 — 브라우저(크롬)가 탭 전환으로
  // 먼저 가져가 페이지가 막을 수 없고, 기존 계약(tests/composition-pending-navigation: 편집기가 처리하지 않는 키의 브라우저
  // 기본 동작 유지)과 맞부딪친다. 문서 처음/끝은 기존 Ctrl+Home/End 로 간다.

  if (platform === 'mac') {
    if (input.altKey && !input.ctrlKey && !input.metaKey) {
      if (key === 'ArrowLeft') return 'wordBackward';
      if (key === 'ArrowRight') return 'wordForward';
    }
    if (input.metaKey && !input.ctrlKey && !input.altKey) {
      if (key === 'ArrowLeft') return 'lineStart';
      if (key === 'ArrowRight') return 'lineEnd';
    }
    return null;
  }

  if (input.ctrlKey && !input.metaKey && !input.altKey) {
    if (key === 'ArrowLeft') return 'wordBackward';
    if (key === 'ArrowRight') return 'wordForward';
    if (key === 'ArrowUp') return 'paragraphBackward';
    if (key === 'ArrowDown') return 'paragraphForward';
  }

  return null;
}

export function shouldSuppressUnmappedNavigation(
  input: NavigationKeyInput,
  platform: PlatformKind = detectPlatformKind(),
): boolean {
  const key = navigationKey(input);
  return platform === 'other' &&
    input.altKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    (key === 'ArrowLeft' || key === 'ArrowRight');
}

export function formatShortcutLabel(
  label: string,
  platform: PlatformKind = detectPlatformKind(),
): string {
  if (platform !== 'mac') return label;
  return label
    .replace(/\bCtrl\+/g, '⌘')
    .replace(/\bAlt\+/g, '⌥')
    .replace(/\bShift\+/g, '⇧');
}
