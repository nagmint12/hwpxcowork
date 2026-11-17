import { fileURLToPath } from 'node:url';
const queue = fileURLToPath(new URL('../fonts/font-resource-queue.mjs', import.meta.url)).replaceAll('\\', '/');

// [hwpx-cowork] Opening loads fonts, but a later choice used to change only
// the font ID. Both web and desktop must use the same resource preparation.
export const FONT_SELECTION_PATCHES = [
  { id: 'desktop-local-font-automatic-preparation', file: 'src/main.ts', why: '로컬 앱과 cowork 앱 모두 신뢰한 호스트에서 설치 글꼴을 자동 준비한다',
    anchor: 'async function promptLocalFontsIfNeeded(displayName: string): Promise<void> {\n  try {',
    replace: a => `function automaticDesktopFonts(): boolean {
  try {
    return (globalThis as any).hwpxLocal?.fonts?.autoLoad === true
      || (window.parent as any).hwpxDesktopEnvironment?.automaticLocalFonts === true;
  } catch { return false; }
}

${a}
    if (automaticDesktopFonts()) {
      if (document.visibilityState !== 'visible') await new Promise<void>(resolve => {
        const visible = () => { if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', visible); resolve();
        } };
        document.addEventListener('visibilitychange', visible); visible();
      });
      await detectLocalFonts({ force: true, candidateFamilies: wasm.getDocumentFontCandidates() });
      return;
    }` },
  { id: 'desktop-local-font-suppressed-dialog-preparation', file: 'src/main.ts', why: '내장 편집기의 대화상자 생략 옵션이 글꼴 준비까지 생략하지 않게 한다',
    anchor: '    if (!options.suppressDialogs && !options.suppressLocalFontPrompt) {',
    replace: () => '    if (automaticDesktopFonts() || (!options.suppressDialogs && !options.suppressLocalFontPrompt)) {' },
  { id: 'font-choice-resource-hook', file: 'src/core/wasm-bridge.ts', why: '선택한 글꼴의 실제 face 준비를 편집기 호스트에 알린다',
    anchor: 'export class WasmBridge {', replace: a => `${a}\n  onFontRequested: ((name: string) => void) | null = null;` },
  { id: 'font-choice-resource-all-languages', file: 'src/core/wasm-bridge.ts', why: '전체 언어 글꼴 변경을 준비한다',
    anchor: '    return this.doc.findOrCreateFontId(name);',
    replace: () => '    const id = this.doc.findOrCreateFontId(name);\n    if (id >= 0) this.onFontRequested?.(name);\n    return id;' },
  { id: 'font-choice-resource-language-slot', file: 'src/core/wasm-bridge.ts', why: '언어별 글꼴·대표 글꼴 세트도 준비한다',
    anchor: '    return (this.doc as any).findOrCreateFontIdForLang(lang, name) as number;',
    replace: () => '    const id = (this.doc as any).findOrCreateFontIdForLang(lang, name) as number;\n    if (id >= 0) this.onFontRequested?.(name);\n    return id;' },
  { id: 'font-choice-resource-queue-import', file: 'src/main.ts', why: '준비 요청을 묶고 문서 교체 경합을 막는다',
    anchor: "import { loadWebFonts, resolveCanvasKitFontPlan } from '@/core/font-loader';",
    replace: a => `${a}\nimport { createFontResourceQueue } from ${JSON.stringify(queue)};` },
  { id: 'font-choice-resource-refresh', file: 'src/main.ts', why: '준비 후 측정·그리기만 갱신하며 원문·선택·undo는 보존한다',
    anchor: "  onHostFontsChanged(() => {",
    replace: a => `  wasm.onFontRequested = createFontResourceQueue({
    generation: () => wasm.documentGeneration,
    prepare: async (names: string[]) => {
      await loadWebFonts([...new Set([...wasm.getDocumentFontCandidates(), ...names])], undefined, extensionViewerSettings);
    },
    refresh: async () => {
      if (!canvasView || !wasm.pageCount) return;
      wasm.invalidateCanvasMetricFonts();
      await canvasView.refreshFontResources();
    },
    onError: (error: unknown) => console.warn('[FontChoice] Font preparation failed:', error),
  });

${a}` },
];
