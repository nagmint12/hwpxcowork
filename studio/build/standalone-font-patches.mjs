import { PATCHES } from './patches.mjs';
import { FONT_PATCHES } from './font-patches.mjs';

// [hwpx-cowork] 독립 앱도 웹 편집기와 같은 실제 공급/대체 정책을 쓴다.
// 미설치 본문 face 뒤로 Symbol cmap 글꼴(Wingdings 등)이 먼저 선택되면
// U+002E가 우체통 그림으로 바뀐다. 실제 적재한 본문 face가 먼저다.
const ids = new Set([
  'preload-noto-sans-kr-fallback',
  'detect-same-face-aliases',
  'preload-noto-serif-for-serif-docs',
  'inspect-loaded-font-for-fallback',
  'noto-sans-kr-for-unavailable-font',
]);
export const STANDALONE_FONT_PATCHES = [...FONT_PATCHES, ...PATCHES.filter(p => ids.has(p.id))];
