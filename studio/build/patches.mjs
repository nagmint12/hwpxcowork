// 빌드 시점 패치 — vendor/rhwp 스냅샷 파일은 그대로 두고, 번들을 만들 때만 정해진 자리를 고친다.
// 패치마다 기준 글(anchor)이 정확히 한 번 나와야 한다. 스냅샷이 바뀌어 기준 글이 없으면 빌드를 멈춘다.
import fs from 'node:fs';
import path from 'node:path';
import { PERFORMANCE_PATCHES } from './performance-patches.mjs';
import { EXPORT_PATCHES } from './export-patches.mjs';
import { FONT_PATCHES } from './font-patches.mjs';
import { CLIPBOARD_COMMAND_PATCHES } from './clipboard-command-patches.mjs';
import { NATIVE_CLIPBOARD_PATCHES } from './native-clipboard-patches.mjs';
import { TOUCH_MENU_PATCHES } from './touch-menu-patches.mjs';
import { PROGRESSIVE_OPEN_PATCHES } from './progressive-open-patches.mjs';
import { SELECT_ALL_PATCHES } from './select-all-patches.mjs';
import { MOBILE_INPUT_PATCHES } from './mobile-input-patches.mjs';
import { MOBILE_VIEW_PATCHES } from './mobile-view-patches.mjs';
import { AI_KEY_STORAGE_PATCHES } from './ai-key-storage-patches.mjs';
import { adaptRhwp090Patches } from './rhwp090-patches.mjs';
import { fileURLToPath } from 'node:url';

// 0.9.0 원본 대신 읽을 cowork 모듈(sourceOverridesForStudio)
const RHWP090_SOURCE_OVERRIDES = Object.freeze({
  'src/core/font-loader.ts': fileURLToPath(new URL('../overrides/rhwp090/font-loader.ts', import.meta.url)),
});

/**
 * 패치 목록. 통합 훅과 표시용 기본 글꼴만 다루며 문서 저장 글꼴을 변경하지 않는다.
 * 그 밖의 접근은 플러그인 공개 표면 + ext: 커맨드의 CommandServices 로 한다.
 * anchor 는 줄바꿈을 LF 로 맞춘 원문에서 정확히 한 번 나와야 하고, replace(anchor) 가 그 자리를 바꿀 글을 돌려준다.
 * @type {{id:string, file:string, why:string, anchor:string, replace:(anchor:string)=>string}[]}
 */
export const PATCHES = [
  ...PERFORMANCE_PATCHES,
  ...EXPORT_PATCHES,
  ...FONT_PATCHES,
  ...CLIPBOARD_COMMAND_PATCHES,
  ...NATIVE_CLIPBOARD_PATCHES,
  ...TOUCH_MENU_PATCHES,
  ...PROGRESSIVE_OPEN_PATCHES,
  ...SELECT_ALL_PATCHES,
  ...MOBILE_INPUT_PATCHES,
  ...MOBILE_VIEW_PATCHES,
  // 2026-11-18 GitHub Pages(공개 주소)에서는 AI 도우미 API 키를 저장하지 않는다 — 그 밖의 배포에서는 동작이 바뀌지 않는다
  ...AI_KEY_STORAGE_PATCHES,
  {
    // 2026-11-18 사용자 요청: 한글 조합 중인 글자를 덮던 검은 상자(흰 글자 — 0.5초마다 깜빡임)를 없앤다.
    // 조합 글자는 이미 본문(canvas)에 보통 글자로 그려져 있다 — 그 뒤에 보통 캐럿만 둔다. 조합 처리(넣기·바꾸기·확정)는 그대로.
    id: 'ime-composition-plain-caret',
    file: 'src/engine/input-handler.ts',
    why: '한글 조합 중에도 검은 상자 대신 보통 글자와 보통 캐럿으로 보인다',
    anchor: '      if (this.isComposing && this.compositionAnchor && this.compositionLength > 0) {\n        try {\n          const anchor = this.compositionAnchor;',
    replace: (a) => a.replace('if (this.isComposing', 'if (COWORK_IME_COMPOSITION_BOX && this.isComposing'),
  },
  {
    id: 'ime-composition-plain-caret-flag',
    file: 'src/engine/input-handler.ts',
    why: '조합 상자를 끄는 상수(다시 켜려면 true)',
    anchor: 'const DOCUMENT_PAGINATION_INITIAL_START_DELAY_MS = 100;',
    replace: (a) => `// [hwpx-cowork] IME 조합 글자를 덮는 검은 상자(한/글 식 표시)를 쓰지 않는다(2026-11-18 사용자 결정).\nconst COWORK_IME_COMPOSITION_BOX: boolean = false;\n${a}`,
  },
  {
    id: 'allow-cowork-plugin',
    file: 'src/main.ts',
    why: '플러그인 allowlist 에 cowork 추가(번들 포함, 임의 URL 로드 없음)',
    // resolvePlugin() 의 마지막 줄(허용 목록 밖이면 던짐) 바로 앞에 cowork 분기를 끼운다 — 동적 import 라 별도 청크가 된다
    anchor: 'throw new Error(`허용되지 않은 플러그인: ${id}`);',
    replace: (a) => `if (id === 'cowork') return (await import('@cowork/studio-plugin')).coworkStudioPlugin as StudioPlugin;\n  ${a}`,
  },
  {
    id: 'context-menu-hook',
    file: 'src/ui/context-menu.ts',
    why: "우클릭 메뉴가 화면에 붙기 직전에 cowork '검토' 구역을 넣는다(크기 계산 전이라 위치 보정이 같이 된다)",
    anchor: '    document.body.appendChild(menu);\n    this.el = menu;',
    replace: (a) => `    (globalThis as any).__rhwpCoworkMenuHook?.(menu, () => this.hide());\n${a}`,
  },
  {
    id: 'preload-noto-sans-kr-fallback',
    file: 'src/core/font-loader.ts',
    why: '외부 CDN 없이도 첫 문서 표시 전에 번들 Noto Sans KR를 준비한다',
    anchor: "const CRITICAL_FONTS = new Set(['함초롬바탕', '함초롬돋움']);",
    replace: () => `const CRITICAL_FONTS = new Set(['Noto Sans KR', '함초롬바탕', '함초롬돋움']);
// cowork(2026-11-04): 한/글 전용 이름(HFT 한양…)과 한국어 이름이 브라우저에서 안 잡히는 HY 글꼴은
// '다른 글꼴로 대체'가 아니라 같은 글꼴이 다른 이름으로 설치된 것이다 — 엔진 installed_render_font_aliases
// (vendor/rhwp/src/renderer/mod.rs)와 같은 짝. 이 이름들도 설치 감지 후보에 넣고, 표시 정책은 이 짝을 원본으로 본다.
export const COWORK_SAME_FACE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Unqualified KoPub names refer to its ordinary Medium face (the SFNT family includes the weight).
  'KoPub돋움체': ['KoPubDotum Medium'],
  'KoPubDotum': ['KoPubDotum Medium'],
  'KoPub Dotum': ['KoPubDotum Medium'],
  'KoPub바탕체': ['KoPubBatang Medium'],
  'KoPubBatang': ['KoPubBatang Medium'],
  'KoPub Batang': ['KoPubBatang Medium'],
  'KoPubWorld돋움체': ['KoPubWorldDotum Medium'],
  'KoPubWorldDotum': ['KoPubWorldDotum Medium'],
  'KoPubWorld Dotum': ['KoPubWorldDotum Medium'],
  'KoPubWorld바탕체': ['KoPubWorldBatang Medium'],
  'KoPubWorldBatang': ['KoPubWorldBatang Medium'],
  'KoPubWorld Batang': ['KoPubWorldBatang Medium'],
  '한양견명조': ['HY견명조', 'HYMyeongJo-Extra'],
  '한양견고딕': ['HY견고딕', 'HYGothic-Extra'],
  '한양중고딕': ['HY중고딕', 'HYGothic', 'HYGothic-Medium'],
  '한양신명조': ['HYSinMyeongJo', 'HY신명조', 'HYSinMyeongJo-Medium'],
  'HY중고딕': ['HYGothic', 'HYGothic-Medium'],
  'HY신명조': ['HYSinMyeongJo', 'HYSinMyeongJo-Medium'],
  'HY헤드라인M': ['HYHeadLine', 'HYHeadLine-Medium'],
  'HY그래픽M': ['HYGraphic', 'HYGraphic-Medium'],
});
/** 명조·바탕·궁서 계열 이름 — 쓸 수 없는 글꼴을 고딕 대신 명조(Noto Serif KR)로 보인다 */
export function coworkSerifFamily(name: string): boolean {
  return /명조|바탕|궁서|myeong|myung|batang|gungsuh|serif/i.test(name) && !/sans/i.test(name);
}`,
  },
  {
    id: 'detect-same-face-aliases',
    file: 'src/core/font-loader.ts',
    why: '같은 글꼴의 설치 이름(HY견명조 등)도 감지하고, 명조 글꼴이 있는 문서는 번들 Noto Serif KR 도 준비한다',
    anchor: '    ...targetNames.flatMap(name => projectedSubstituteTargets(name).map(target => target.face)),\n  ];',
    replace: () => '    ...targetNames.flatMap(name => projectedSubstituteTargets(name).map(target => target.face)),\n    ...targetNames.flatMap(name => COWORK_SAME_FACE_ALIASES[name] ?? []),\n  ];',
  },
  {
    id: 'preload-noto-serif-for-serif-docs',
    file: 'src/core/font-loader.ts',
    why: '쓸 수 없는 명조 글꼴의 대체(Noto Serif KR)를 첫 표시 전에 준비한다(명조 글꼴이 있는 문서만)',
    anchor: '  const targetNames = [...(docFonts ?? []), ...CRITICAL_FONTS];',
    replace: () => "  const targetNames = [...(docFonts ?? []), ...CRITICAL_FONTS, ...((docFonts ?? []).some(coworkSerifFamily) ? ['Noto Serif KR'] : [])];",
  },
  {
    id: 'inspect-loaded-font-for-fallback',
    file: 'src/core/font-substitution.ts',
    why: '카탈로그 등록과 실제 웹폰트 적재 성공을 구분한다',
    anchor: "import { getDetectedOSFonts, REGISTERED_FONTS } from './font-loader.ts';",
    replace: () => "import { COWORK_SAME_FACE_ALIASES, coworkSerifFamily, getDetectedOSFonts, getWebFontSupplySnapshot, REGISTERED_FONTS } from './font-loader.ts';",
  },
  {
    id: 'noto-sans-kr-for-unavailable-font',
    file: 'src/core/font-substitution.ts',
    why: '사용할 수 없는 문서 글꼴은 Noto Sans KR로 표시하고 실제 설치·적재된 글꼴은 유지한다',
    anchor: "  return {\n    candidates: families,\n    ruleIds: [...new Set(ruleIds.filter(Boolean))],\n  };\n}",
    replace: () => `  // cowork 표시 정책: 웹폰트 카탈로그에 이름이 있다는 것만으로는 사용할 수 없다.
  // 외부 로드 차단·실패·미등록 글꼴은 첫 후보를 번들 Noto Sans KR로 고정한다.
  // 첫 후보는 Canvas2D 엔진 체인과 병합할 때도 유지되며 문서의 글꼴 지정은 바꾸지 않는다.
  const installedOriginal = installedFaceName(fontName, options.confirmedLocalFonts);
  // cowork(2026-11-04): 한/글 전용 이름(HFT 한양견명조 등)은 Windows 에 그 이름으로 설치되지 않는다.
  // 같은 글꼴이 다른 이름(HY견명조 = H2MJRE.TTF)으로 설치돼 있으면 그것이 원본이다 — 대체로 보지 않는다
  // (stand-in 웹폰트보다도 앞). 짝 목록은 font-loader 의 COWORK_SAME_FACE_ALIASES(엔진과 같은 표).
  if (installedOriginal === null) {
    for (const alias of COWORK_SAME_FACE_ALIASES[fontName] ?? []) {
      const installedAlias = installedFaceName(alias, options.confirmedLocalFonts);
      if (!installedAlias) continue;
      const sameFace: string[] = [];
      pushUniqueFontFamily(sameFace, installedAlias);
      for (const family of families) pushUniqueFontFamily(sameFace, family);
      return {
        candidates: sameFace,
        ruleIds: [...new Set([...ruleIds.filter(Boolean), 'cowork.same-face-alias'])],
      };
    }
  }
  const originalAvailable = installedOriginal !== null
    || getWebFontSupplySnapshot(fontName).status === 'loaded'
    || options.includeUnconfirmedOriginal === true;
  if (!originalAvailable) {
    // 명조·바탕 계열은 번들 Noto Serif KR(적재됐을 때), 그 밖은 Noto Sans KR. 글자 자리·폭은 엔진이 잡으므로 줄 나눔은 그대로다.
    if (coworkSerifFamily(fontName) && getWebFontSupplySnapshot('Noto Serif KR').status === 'loaded') {
      return {
        candidates: ['Noto Serif KR', 'serif'],
        ruleIds: ['cowork.noto-serif-kr-fallback'],
      };
    }
    return {
      candidates: ['Noto Sans KR', 'sans-serif'],
      ruleIds: ['cowork.noto-sans-kr-fallback'],
    };
  }
  // 실제 설치된 원본을 우선하며 엔진이 제공하는 동일 글꼴 별칭은 기존 경로에서 보존한다.
  const availableFamilies: string[] = [];
  if (installedOriginal) pushUniqueFontFamily(availableFamilies, installedOriginal);
  else if (getWebFontSupplySnapshot(fontName).status === 'loaded') pushUniqueFontFamily(availableFamilies, fontName);
  for (const family of families) pushUniqueFontFamily(availableFamilies, family);
  return {
    candidates: availableFamilies,
    ruleIds: [...new Set(ruleIds.filter(Boolean))],
  };
}`,
  },
];

const norm = (s) => s.replace(/\r\n/g, '\n');

function applyPatch(code, p) {
  const src = norm(code);
  const first = src.indexOf(p.anchor);
  if (first < 0) throw new Error(`[cowork patch ${p.id}] 기준 글을 찾지 못했습니다: ${p.file}`);
  if (src.indexOf(p.anchor, first + 1) >= 0) throw new Error(`[cowork patch ${p.id}] 기준 글이 여러 번 나옵니다: ${p.file}`);
  return src.slice(0, first) + p.replace(p.anchor) + src.slice(first + p.anchor.length);
}

/** 편집기 원본(rhwp-studio)이 속한 엔진 소스의 판(Cargo.toml version). 못 읽으면 null. */
export function studioSourceVersion(studioSrc) {
  try {
    return /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(studioSrc, '..', 'Cargo.toml'), 'utf8'))?.[1] ?? null;
  } catch { return null; }
}

/** 원본 파일 대신 읽을 cowork 모듈 { 'src/…': 절대 경로 } — 패치는 그 글 위에 얹는다.
 * [hwpx-cowork] 2026-11-10 fontfix: 0.9.0 원본의 글꼴 로더는 운영 전 fork 로더(studio/overrides/rhwp090/font-loader.ts)로 바꿔 끼운다
 * (사용자 지시 «기존방식을 사용해서 무조건 로드»). 빌드·--check·시험 하네스가 모두 이 함수를 거친다. */
export function sourceOverridesForStudio(studioSrc) {
  return studioSourceVersion(studioSrc) === '0.9.0' ? RHWP090_SOURCE_OVERRIDES : {};
}

/** 패치가 대는 원문 — 바꿔 끼운 모듈이 있으면 그 글. */
export function studioSourceText(studioSrc, file) {
  const override = sourceOverridesForStudio(studioSrc)[file];
  return fs.readFileSync(override ?? path.join(studioSrc, file), 'utf8');
}

/** 실제 번들과 같은 글(바꿔 끼우기 + 그 파일의 패치를 차례대로). 시험이 원본 일부를 잘라 쓸 때 쓴다. */
export function patchedStudioSource(studioSrc, file, patches = patchesForStudio(studioSrc)) {
  let code = studioSourceText(studioSrc, file);
  for (const p of patches) if (p.file === file) code = applyPatch(code, p);
  return norm(code);
}

/** 실제 빌드(scripts/build-studio.mjs)와 같은 패치 선택 — 0.9.0 원본이면 0.9 덮어쓰기(rhwp090-patches.mjs)를 얹는다.
 * [hwpx-cowork] 2026-11-10: 시험이 기본값(0.8.7 PATCHES)으로 0.9.0 원본을 묶어 실제 번들과 다른 글을 시험하던 것을 막는다. */
export function patchesForStudio(studioSrc, base = PATCHES) {
  return studioSourceVersion(studioSrc) === '0.9.0' ? adaptRhwp090Patches(base) : base;
}

/** 스냅샷에 패치 기준 글이 그대로 있는지 확인(파일은 바꾸지 않음).
 * 빌드 플러그인과 같이 파일마다 PATCHES 순서대로 이어 적용하며 잰다 — 뒤 패치는 앞 패치가 만든 글을
 * 기준으로 삼을 수 있다(예: progressive-open-load-retry-*). 2026-11-04 전에는 패치를 하나씩 원본에 따로
 * 대 보아, 빌드는 되는데 확인만 실패했다. 실패한 패치는 건너뛰고 다음 패치를 잰다. */
export function verifyPatches(studioSrc, patches = patchesForStudio(studioSrc)) {
  const code = new Map();
  return patches.map((p) => {
    try {
      if (!code.has(p.file)) code.set(p.file, studioSourceText(studioSrc, p.file));
      code.set(p.file, applyPatch(code.get(p.file), p));
      return { id: p.id, file: p.file, ok: true };
    } catch (e) { return { id: p.id, file: p.file, ok: false, error: e.message }; }
  });
}

/** vite 플러그인: 해당 파일을 읽을 때 패치를 적용한다 */
export function coworkBuildPlugins({ studioSrc, patches = patchesForStudio(studioSrc) }) {
  const byFile = new Map();
  for (const p of patches) {
    const abs = path.join(studioSrc, p.file).replace(/\\/g, '/').toLowerCase();
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push(p);
  }
  const applied = new Set();
  const overrides = new Map(Object.entries(sourceOverridesForStudio(studioSrc)).map(([file, source]) =>
    [path.join(studioSrc, file).replace(/\\/g, '/').toLowerCase(), source]));
  return [{
    name: 'cowork-patches',
    enforce: 'pre',
    // 바꿔 끼운 모듈: 원본 자리(id)는 그대로 두어 상대 import 가 원본 폴더 기준으로 풀린다.
    load(id) {
      const source = overrides.get(id.split('?')[0].replace(/\\/g, '/').toLowerCase());
      if (!source) return null;
      this.addWatchFile?.(source);
      return fs.readFileSync(source, 'utf8');
    },
    transform(code, id) {
      const key = id.split('?')[0].replace(/\\/g, '/').toLowerCase();
      const list = byFile.get(key);
      if (!list) return null;
      let out = code;
      for (const p of list) { out = applyPatch(out, p); applied.add(p.id); }
      return { code: out, map: null };
    },
    buildEnd(err) {
      if (err) return;
      const missing = patches.filter((p) => !applied.has(p.id)).map((p) => p.id);
      if (missing.length) this.error(`[cowork patch] 적용되지 않은 패치: ${missing.join(', ')}`);
    },
  }];
}
