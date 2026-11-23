// [hwpx-cowork] 0.9.0의 이동된 준비/교체 지점에 기존 계약을 연결한다.
// 0.8.7 패치 배열은 그대로 두며, 별도 0.9 소스 빌드에서만 선택한다.
export function adaptRhwp090Patches(patches) {
  const overrides = new Map();
  const set = (id, anchor, replace) => overrides.set(id, { anchor, replace });
  set('paragraph-canvas-metric-mutation-reserve',
    '    this.rendererSelectionPending = true;\n    const pinned = this.rendererSession.pinAutoMutationRevision();',
    a => a.replace('    const pinned', '    paragraphTargetJson = this.wasm.reserveCanvasMetricTarget(paragraphTargetJson);\n    const pinned'));
  set('paragraph-canvas-metric-next-revision-prepare',
    '      return this.rendererSession.resolve(this.wasm);\n    });',
    a => a.replace('    });', '    }, paragraphTargetJson);'));
  set('paragraph-canvas-metric-view-prepare-scope',
    '    const selected = await this.prepareRendererRevision(epoch, () => Promise.resolve(pinned));',
    a => a.replace('Promise.resolve(pinned));', 'Promise.resolve(pinned), paragraphTargetJson);'));
  set('prime-hwpx-compression-on-open',
    '    const docInfo = imported ?? await loadDocumentForOpen(data, fileName);',
    a => `${a}\n    primeHwpxCompression(data);`);
  set('reset-hwpx-compression-on-new-document',
    "      const docInfo = wasm.createNewDocument();\n      eventBus.emit('document-swapped');",
    a => a.replace("      eventBus.emit", "      primeHwpxCompression();\n      eventBus.emit"));
  // [hwpx-cowork] 2026-11-10 fontfix: src/core/font-loader.ts 는 fork 로더(studio/overrides/rhwp090/font-loader.ts)로
  // 바꿔 끼우므로 webfont-api-weight 등 글꼴 로더 패치는 0.8.7 기준 글(FontFace(url))에 그대로 댄다.
  set('progressive-open-atomic-hold-option', '    prepared?: { digest: string },\n  ): void {',
    a => a.replace('  ): void {', '    holdPrevious = false,\n  ): void {'));
  set('progressive-open-atomic-previous-state', '    const previousDoc = this.doc;',
    a => `${a}\n    const previousState = { doc: previousDoc, fileName: this._fileName,\n      fileHandle: this._currentFileHandle, requiresPassword: this._requiresPasswordForSave,\n      digest: this._documentDigest, recoveryCipher: this._recoveryCipher, pdfImport: this._pdfImport };`);
  set('progressive-open-atomic-delay-free', '    if (previousDoc) notify(() => previousDoc.free());',
    a => `    if (holdPrevious) {\n      this.coworkProgressivePrevious = { ...previousState, generation: this._documentGeneration };\n    } else ${a.trim()}`);
  // 0.9.0은 후보 검증 후에만 공개하고 공개 후 알림 예외는 notify가 처리한다.
  set('progressive-open-atomic-rollback-error', '      if (nextDoc && !prepared) {',
    a => `      // [hwpx-cowork] 후보 실패는 공개 전이므로 기존 문서를 그대로 보존한다.\n${a}`);
  set('progressive-open-bridge-log-phase', '    void this.populateExternalImagesFromDevServer();',
    // [hwpx-cowork] 2026-11-10 P2: fork 처럼 실제 상태로 적는다 — 점진 열기를 시도했어도 곧바로 끝난 문서(작은 문서, 예전 여러 구역 문서)를
    // «미리보기 준비 중»으로 적어 미리보기가 뜬 것처럼 보였다(실문서A 127쪽 기록).
    // 기록만 한다 — 쪽 수·상태 읽기 실패가 문서 교체·되돌리기 흐름에 끼어들지 않게 모두 삼킨다.
    a => `${a}\n    if (holdPrevious) {\n      try {\n        const coworkPreviewPending = JSON.parse(this.progressiveOpenState() || '{}').state === 'pending';\n        console.log(coworkPreviewPending ? '[WasmBridge] 문서 미리보기: ' + this.pageCount + '페이지 (전체 조판 중)' : '[WasmBridge] 문서 로드: ' + this.pageCount + '페이지');\n      } catch { /* optional diagnostics */ }\n    }`);
  set('progressive-open-release-held-document', '  releaseDocument(): void {\n    this._documentGeneration += 1;',
    a => a.replace('    this._documentGeneration', '    this.commitProgressiveOpen(this._documentGeneration);\n    this._documentGeneration'));
  set('progressive-open-cancelled-error',
    "  return error instanceof DocumentOpenCancelledError || (error as { code?: string })?.code === 'PDF_IMPORT_CANCELLED';",
    a => a.replace('return error instanceof', 'return isProgressiveOpenSuperseded(error) || error instanceof'));
  set('progressive-open-preview-metrics-barrier',
    '    const selected = await this.prepareRendererRevision(epoch, () => this.rendererSession.resolve(this.wasm));',
    a => a.replace('this.rendererSession.resolve(this.wasm));', 'this.rendererSession.resolve(this.wasm), undefined, options.coworkPreview === true);'));
  set('progressive-open-preview-page-bound', '    if (!selected) return;\n\n    const pageCount = this.wasm.pageCount;',
    a => a.replace('const pageCount = this.wasm.pageCount;', 'const pageCount = options.coworkPreview ? Math.min(2, this.wasm.pageCount) : this.wasm.pageCount;'));
  set('progressive-open-load-retry-start',
    '    if (this.disposed) return;\n    if (!this.documentLoadPrepared) this.prepareDocumentLoad();\n    const epoch = this.rendererSelectionEpoch;\n    this.documentLoadPrepared = false;\n    if (this.disposed) return;',
    a => a.replaceAll('if (this.disposed) return;', "if (this.disposed) return 'done';"));
  set('progressive-open-load-retry-metrics', '    if (!selected) return;\n\n    const pageCount = options.coworkPreview',
    a => a.replace('if (!selected) return;', "if (!selected) return this.disposed ? 'done' : 'superseded';"));
  set('preload-noto-sans-kr-fallback',
    "const CRITICAL_FONTS = new Set(['함초롬바탕', '함초롬돋움', 'RHWP Old Hangul']);",
    () => patches.find(p => p.id === 'preload-noto-sans-kr-fallback').replace('').replace("'함초롬돋움']);", "'함초롬돋움', 'RHWP Old Hangul']);"));
  set('inspect-loaded-font-for-fallback',
    "import { getDetectedOSFonts, hasLoadedLocalFontFamily, REGISTERED_FONTS } from './font-loader.ts';",
    () => "import { COWORK_SAME_FACE_ALIASES, coworkSerifFamily, getDetectedOSFonts, getWebFontSupplySnapshot, hasLoadedLocalFontFamily, REGISTERED_FONTS } from './font-loader.ts';");

  const result = patches.map(p => {
    const change = overrides.get(p.id);
    if (change) return { ...p, ...change };
    // [hwpx-cowork] 2026-11-10: 0.9.0 표시 정책은 detectedOSFonts 가 아니라 registerLoadedLocalFontFace 로 등록된
    // 실제 local() face 만 원본으로 인정한다(installedFaceName → hasLoadedLocalFontFamily). 정확한 local() 로드에
    // 성공한 KoPubWorld·HY센스·한컴 윤고딕 등도 같은 등록을 거쳐야 첫 화면에서 Noto 대체로 떨어지지 않는다.
    if (p.id === 'exact-local-faces-before-webfonts') return {
      ...p, replace: a => {
        const out = p.replace(a);
        const from = 'undefined, clientFontRecords)) {';
        if (!out.includes(from)) throw new Error('[rhwp090] exact-local-faces-before-webfonts 바꿀 자리를 찾지 못했습니다');
        return out.replace(from, 'face => registerLoadedLocalFontFace(face), clientFontRecords)) {');
      },
    };
    if (p.id === 'noto-sans-kr-for-unavailable-font') return {
      ...p, replace: a => p.replace(a).replaceAll('installedOriginal', 'coworkInstalledOriginal'),
    };
    if (p.id === 'native-import-keyboard-integration') return {
      ...p, replace: a => p.replace(a).replace("\nimport { showToast } from '@/ui/toast';", ''),
    };
    if (p.id === 'progressive-open-bridge-previous-document') return {
      ...p, replace: a => p.replace(a).replace('digest: string | null; generation: number;',
        'digest: string | null; generation: number; recoveryCipher: RecoveryCipher | null; pdfImport: Record<string, unknown> | null;'),
    };
    if (p.id === 'progressive-open-bridge-api') return {
      ...p, replace: a => p.replace(a)
        .replace('new HwpDocument(data), supported);', 'new HwpDocument(data), undefined, undefined, supported);')
        .replace('    return this.getDocumentInfo();', '    try { return this.getDocumentInfo(); } catch (error) {\n      this.rollbackProgressiveOpen(this._documentGeneration);\n      throw error;\n    }')
        .replace('try { previous.doc?.free(); }', 'try { previous.recoveryCipher?.dispose(); } catch { /* completed replacement */ }\n    try { previous.doc?.free(); }')
        .replace('    this.doc = previous.doc;', '    if (this._recoveryCipher !== previous.recoveryCipher) this._recoveryCipher?.dispose();\n    this._recoveryCipher = previous.recoveryCipher;\n    this._pdfImport = previous.pdfImport;\n    this.doc = previous.doc;'),
    };
    return p;
  });
  const extra = (id, file, anchor, replace, why) => result.push({ id, file, anchor, replace, why });
  extra('rhwp090-metric-revision-scope', 'src/view/canvas-view.ts',
    '    resolve: () => Promise<RendererSessionSelection | null>,\n  ): Promise<{ selection:',
    a => a.replace('  ): Promise<', '    paragraphTargetJson?: string,\n    skipMetrics = false,\n  ): Promise<'),
    '0.9 공통 renderer 준비 함수에 문단 범위와 읽기 전용 미리보기 계약 전달');
  extra('rhwp090-metric-revision-prepare', 'src/view/canvas-view.ts',
    '      metricsChanged = await this.wasm.prepareCanvasMetrics(selection.backend,\n        () => current() && this.rendererSession.isCurrent(preparedSelection));',
    a => a.replace('metricsChanged = await', 'metricsChanged = skipMetrics ? false : await')
      .replace('this.rendererSession.isCurrent(preparedSelection));', 'this.rendererSession.isCurrent(preparedSelection), paragraphTargetJson);'),
    '세대 검사와 portable fallback을 유지하며 범위를 측정 수집 지점에 연결');
  // [hwpx-cowork] 2026-11-10: 운영 fork 표시 계약 — 폭 탐지(detectOSFonts)로 확인된 설치 글꼴은 로컬 글꼴 감지
  // 동의(저장된 감지 결과) 전에도 원본 이름으로 그린다. 0.9.0 은 동의 전 탐지 결과를 버려 맑은 고딕·Arial 문서가
  // Noto 로 보였다(시험 studio_font_fallback 'exact installed and loaded fonts survive…'). 동의 창(0.9 흐름)은 그대로 두고,
  // 동의해 Local Font Access 목록이 생긴 뒤에는 0.9 처럼 그 목록을 권위로 삼는다.
  extra('rhwp090-installed-face-probe-before-consent', 'src/core/font-substitution.ts',
    "  if (!getLocalFontState().stored || getLocalFontState().source === 'local-font-access') return null;",
    () => "  if (getLocalFontState().stored && getLocalFontState().source === 'local-font-access') return null;",
    '감지 동의 전에도 폭 탐지로 확인된 설치 글꼴을 원본 face 로 사용(fork 표시 계약)');
  // ── fontfix(2026-11-10, 사용자 지시 «기존방식을 사용해서 무조건 로드»): 글꼴을 찾고·대체하는 길을 운영 전 fork 와 같게 ──
  // 원인(브라우저 대조, research/rhwp_merge_tools/ledger_fontfix.md): 0.9 엔진은 원본 TTF·굵은 표시 글꼴의 Canvas 체인 맨 앞에
  // '__rhwp_ttf__<이름>'·'__rhwp_intrinsic__<이름>' 내부 별칭을 넣는다(vendor/rhwp/src/renderer/canvas_text_font.rs family_chain).
  // 이 별칭은 호스트 글꼴(scopedHostCanvasFont)만 공급하고 웹에는 등록된 face 가 없다. 0.9 병합 함수는 그것을 원 글꼴로 보고
  // 표시 정책(cowork noto-sans-kr-for-unavailable-font)이 '쓸 수 없는 글꼴' → Noto Sans/Serif KR 을 맨 앞에 두어, 설치된 HY·KoPub·
  // 함초롬·굴림체 문서가 통째로 Noto 로 그려졌다. fork 엔진은 이 별칭을 만들지 않았다.
  // fork 의 병합(설치 face 별칭 보존 #6600, 동의 여부와 무관) 그대로 + 내부 별칭은 바로 뒤의 원 이름으로 되돌린다(같은 뜻).
  extra('fontfix-fork-canvas-font-import', 'src/core/wasm-bridge.ts',
    "  completeFontFamilyList,\n} from './font-substitution';",
    a => a.replace('  completeFontFamilyList,', '  completeFontFamilyList,\n  resolveFont,\n  canFallbackToFont,'),
    'fork 병합이 쓰는 resolveFont 를 가져옴');
  extra('fontfix-fork-canvas-font-merge', 'src/core/wasm-bridge.ts',
    `  const incoming = parseCssFontFamilyList(familyPart);
  const primary = incoming[0];
  if (!primary) return cssFont;

  // 같은 원 이름의 언어 슬롯에 다른 대체가 있으면 엔진이 지정한 체인을 따른다.
  const declaredTargets = documentSubstituteFamilies(primary).filter(target => incoming.includes(target));
  const studioChain = fontFamilyCandidatesForDisplay(primary, 0, 0,
    declaredTargets.length ? { documentFallbackFamilies: declaredTargets } : {});`,
    () => `  // [hwpx-cowork] fontfix: 엔진 내부 별칭('__rhwp_ttf__X'·'__rhwp_intrinsic__X')은 웹에서 공급되지 않는다 — 원 이름 X 로 되돌린다.
  const incoming = parseCssFontFamilyList(familyPart).map(name => {
    const internal = /^__rhwp_(?:ttf|intrinsic)__(.+)$/.exec(name);
    return internal ? internal[1] : name;
  }).filter((name, index, list) => list.findIndex(other => other.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US')) === index);
  const primary = incoming[0];
  if (!primary) return cssFont;

  // [hwpx-cowork] fontfix: fork 그대로 — 표시 정책의 첫 후보, 엔진 체인(설치 face 별칭 포함), 표시 정책의 나머지 순.
  void documentSubstituteFamilies; void completeFontFamilyList;
  const studioChain = fontFamilyCandidatesForDisplay(primary, 0, 0);`,
    'Canvas 글꼴 병합을 fork 방식으로: 엔진 내부 별칭을 원 이름으로 되돌려 설치·웹 글꼴 대신 Noto 로 그리지 않음');
  // KoPub's SFNT family can include Medium even when the saved name omits the weight.
  // Let CSS try the engine's original KoPub faces on the very first frame, while
  // asynchronous local font detection is still pending. An absent face falls through.
  extra('fontfix-kopub-before-discovery', 'src/core/wasm-bridge.ts',
    '  if (studioChain[0]) push(studioChain[0]);',
    a => `  const koPub = /^KoPub(?:World)?\\s*(?:Dotum|Batang|돋움체|바탕체)/i;
  if (koPub.test(primary) && koPub.test(incoming[1] ?? '')) {
    for (const name of incoming) {
      if (!koPub.test(name)) break;
      push(name);
    }
  }
${a}`,
    'KoPub 원본과 실제 설치 이름을 첫 프레임부터 본문 웹폰트보다 먼저 선택');
  extra('fontfix-fork-canvas-font-merge-tail', 'src/core/wasm-bridge.ts',
    `  const primaryAllowed = studioChain.some(name =>
    name.toLocaleLowerCase('en-US') === primary.toLocaleLowerCase('en-US'));
  const localFontsEnabled = getLocalFontState().stored;
  for (const name of incoming) {
    if (name === primary && !primaryAllowed) continue;
    // 감지 승인이 없으면 엔진의 설치 face 별칭으로 원본 로컬 글꼴이 우회되지 않게 한다.
    if (!localFontsEnabled && !studioChain.some(candidate =>
      candidate.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) continue;
    push(name);
  }
  return prefix + formatCssFontFamilyList(completeFontFamilyList(merged, studioChain.slice(1)));`,
    () => `  const primaryAllowed = resolveFont(primary, 0, 0) === primary
    || studioChain.some(name => name.toLocaleLowerCase('en-US') === primary.toLocaleLowerCase('en-US'));
  for (const name of incoming) {
    if (name === primary && !primaryAllowed) continue;
    push(name);
  }
  for (const name of studioChain.slice(1)) push(name);
  return prefix + formatCssFontFamilyList(merged.filter(name => canFallbackToFont(primary, name)));`,
    'fork 병합: 감지 동의와 관계없이 엔진 체인 보존, 표시 정책 나머지는 뒤에 이어 붙임');
  // fork 는 ctx.font 치환 결과를 글꼴 상태가 같으면 다시 썼다(hwpx-cowork 2026-10-31 셈 기억). 0.9 는 한 번 그릴 때만 기억한다.
  extra('fontfix-fork-canvas-font-cache', 'src/core/wasm-bridge.ts',
    'const canvasFontResolution = new CanvasFontResolutionScope(\n  font => scopedHostCanvasFont(font) ?? substituteCssFontFamily(font),\n);',
    a => a.replace('?? substituteCssFontFamily(font)', '?? substituteCssFontFamilyCached(font)'),
    'Canvas 글꼴 치환을 fork 처럼 글꼴 상태 단위로 기억(같은 결과, 반복 셈 없음)');
  // 0.9 는 본문 대체 뒤·generic 앞에 Noto Sans Symbols2·함초롬바탕·D2Coding·컬러 이모지를 끼웠다 — fork 는 본문 대체 뒤 바로 generic.
  extra('fontfix-fork-system-fallback', 'src/core/font-substitution.ts',
    `function systemFallbackFamilies(fontName: string): string[] {
  const body = bodyFallbackFamilies(fontName);
  if (GENERIC_FONTS.has(fontName)) return body;`,
    () => `function systemFallbackFamilies(fontName: string): string[] {
  const body = bodyFallbackFamilies(fontName);
  // [hwpx-cowork] fontfix: fork 그대로 — 본문 대체 다음은 generic. 기호·이모지 후보를 끼우지 않는다.
  if (body.length) return body;`,
    '빠진 글자의 대체 사다리를 fork 와 같게(기호·이모지 글꼴을 끼우지 않음)');
  // 0.9 의 '선언 글꼴 환경'(감지 승인 뒤 로컬 바이트를 별칭 face 로 등록하고 엔진 글꼴 환경을 바꿈)은 fork 에 없던 길이다.
  extra('fontfix-fork-no-declared-font-environment', 'src/core/wasm-bridge.ts',
    "  async prepareDeclaredFontEnvironment(backend = 'canvas2d'): Promise<boolean> {\n    const doc = this.doc;",
    a => a.replace('    const doc = this.doc;', `    // [hwpx-cowork] fontfix: fork 방식 — 엔진 글꼴 환경을 바꾸지 않고 CSS 이름·웹폰트·설치 글꼴로만 그린다.
    if ((globalThis as { __rhwpCoworkDeclaredFonts?: boolean }).__rhwpCoworkDeclaredFonts !== true) return false;
    const doc = this.doc;`),
    '0.9 선언 글꼴 환경(로컬 바이트 별칭·엔진 환경 교체)을 쓰지 않음(fork 방식)');
  // [hwpx-cowork] 독립 편집기는 글꼴 패치만 사용한다. hold 옵션을 추가한
  // 빌드에서만 참조해야 일반 문서 열기에 미정의 변수 오류가 나지 않는다.
  if (patches.some(p => p.id === 'progressive-open-atomic-hold-option')) {
    extra('rhwp090-progressive-hold-recovery-cipher', 'src/core/wasm-bridge.ts',
      '    notify(() => previousCipher?.dispose());', a => a.replace('notify(', 'if (!holdPrevious) notify('),
      'rollback 완료까지 이전 문서의 복구 암호 핸들 보존');
  }
  if (patches.some(p => p.id === 'progressive-open-main-coordinator')) {
    extra('rhwp090-open-font-preparation', 'src/main.ts',
      `async function initializeDocument(
  docInfo: DocumentInfo,
  displayName: string,
  options: { suppressDialogs?: boolean; suppressLocalFontPrompt?: boolean } = {},
): Promise<void> {
  const msg = sbMessage();
  try {
    // 이미 승인된 snapshot을 권한 prompt 없이 준비한 뒤 프로그램을 선택한다.`,
      () => `type OpenFontOptions = { suppressDialogs?: boolean; suppressLocalFontPrompt?: boolean };
let preparedOpenFontGeneration: number | undefined;

// [hwpx-cowork] 2026-11-20 글꼴 표시 비교: 미리보기와 편집 화면이 같은 글꼴 준비를 기다린다.
async function prepareOpenFonts(displayName: string, options: OpenFontOptions): Promise<void> {
    const generation = wasm.documentGeneration;
    if (preparedOpenFontGeneration === generation) return;
    const assertCurrent = () => {
      if (wasm.documentGeneration !== generation) throw new ProgressiveOpenSupersededError();
    };
    const msg = sbMessage();
    // 이미 승인된 snapshot을 권한 prompt 없이 준비한 뒤 프로그램을 선택한다.`,
      '점진 열기와 최종 화면에서 동일한 글꼴 준비를 사용');
    extra('rhwp090-open-font-preparation-current', 'src/main.ts',
      '    await loadStoredLocalFonts();\n    // 초기화 후 첫 문서 로드의 선택을 프로그램 공급·조판보다 먼저 확정한다.',
      a => a.replace('await loadStoredLocalFonts();', 'await loadStoredLocalFonts();\n    assertCurrent();'),
      '다른 문서로 교체된 열기는 해당 문서의 글꼴 선택을 건드리지 않음');
    extra('rhwp090-open-font-preparation-info', 'src/main.ts',
      `    await wasm.prepareDeclaredFontEnvironment(canvasView?.getRenderBackend());
    docInfo = wasm.getDocumentInfo();
    setDocumentFontSubstitutions(docInfo.fontSubstitutions);
    currentDocumentFonts = [...new Set([
      ...(docInfo.fontsUsed ?? []),
      ...(docInfo.fontSubstitutions ?? []).map(([, target]) => target),
    ])];
    lastAppliedLocalFontGeneration = null;
    console.log('[initDoc] 1. 폰트 로딩 시작');
    await updateLoadProgress(55, '폰트 준비 중...');
    if (currentDocumentFonts.length) {
      await loadWebFonts(currentDocumentFonts, (loaded, total) => {`,
      () => `    assertCurrent();
    await wasm.prepareDeclaredFontEnvironment(canvasView?.getRenderBackend());
    assertCurrent();
    const docInfo = wasm.getDocumentInfo();
    const fonts = [...new Set([
      ...(docInfo.fontsUsed ?? []),
      ...(docInfo.fontSubstitutions ?? []).map(([, target]) => target),
    ])];
    await updateLoadProgress(55, '폰트 준비 중...');
    assertCurrent();
    if (fonts.length) {
      await loadWebFonts(fonts, (loaded, total) => {
        if (wasm.documentGeneration !== generation) return;`,
      '원본과 대체 글꼴의 공급이 끝나기 전에 문서 표시를 시작하지 않음');
    extra('rhwp090-open-font-preparation-finish', 'src/main.ts',
      "    console.log('[initDoc] 2. 폰트 로딩 완료');",
      () => `    assertCurrent();
    setDocumentFontSubstitutions(docInfo.fontSubstitutions);
    currentDocumentFonts = fonts;
    lastAppliedLocalFontGeneration = null;
    preparedOpenFontGeneration = generation;
}

async function initializeDocument(
  docInfo: DocumentInfo,
  displayName: string,
  options: OpenFontOptions = {},
): Promise<void> {
  const msg = sbMessage();
  try {
    await prepareOpenFonts(displayName, options);
    docInfo = wasm.getDocumentInfo();`,
      '동일 문서의 최종 화면은 이미 공급한 글꼴을 그대로 사용');
    extra('rhwp090-open-preview-font-options', 'src/main.ts',
      'async function loadDocumentForOpen(data: Uint8Array, fileName: string, pdfSource?: PdfInputSource): Promise<DocumentInfo> {',
      () => `async function loadDocumentForOpen(
  data: Uint8Array, fileName: string, pdfSource?: PdfInputSource, fontOptions: OpenFontOptions = {},
): Promise<DocumentInfo> {`,
      '편집기 임베드의 기존 글꼴 권한 안내 정책을 첫 미리보기에도 전달');
    extra('rhwp090-open-preview-font-options-call', 'src/main.ts',
      '    const docInfo = imported ?? await loadDocumentForOpen(data, fileName);',
      a => a.replace('data, fileName)', 'data, fileName, undefined, options)'),
      '일반 문서 열기의 글꼴 권한 옵션 사용');
    extra('rhwp090-open-preview-font-barrier', 'src/main.ts',
      '        await canvasView?.loadDocument({ coworkPreview: true });',
      a => `        await prepareOpenFonts(fileName, fontOptions);\n${a}`,
      '미리보기를 그리기 전에 지정 글꼴을 준비해 Noto에서 KoPub로 바뀌는 첫 화면 제거');
    extra('rhwp090-open-preview-font-cancel', 'src/main.ts',
      'isProgressiveOpenSuperseded, OpenProgressPaintGate }',
      a => a.replace('OpenProgressPaintGate', 'ProgressiveOpenSupersededError, OpenProgressPaintGate'),
      '글꼴 준비 중 교체된 이전 문서 열기 취소');
    extra('rhwp090-open-preview-font-rollback', 'src/main.ts',
      "      rollback() { plugins.notifyDocumentSwap(); eventBus.emit('document-swapped'); },",
      () => `      rollback() {
        preparedOpenFontGeneration = undefined;
        const restored = wasm.pageCount > 0 ? wasm.getDocumentInfo() : undefined;
        setDocumentFontSubstitutions(restored?.fontSubstitutions);
        currentDocumentFonts = [...new Set([
          ...(restored?.fontsUsed ?? []),
          ...(restored?.fontSubstitutions ?? []).map(([, target]) => target),
        ])];
        plugins.notifyDocumentSwap();
        eventBus.emit('document-swapped');
      },`,
      '점진 열기가 실패하고 이전 문서가 복구되면 글꼴 후보도 복구');

    extra('rhwp090-zoom-slider-ten-percent', 'src/main.ts',
      '    const percent = zoomSliderPositionToPercent(Number(zoomRange.value));',
      () => '    const percent = 10 * Math.round(zoomSliderPositionToPercent(Number(zoomRange.value)) / 10);',
      '배율 슬라이더를 10% 단위에 맞춤');
    extra('rhwp090-zoom-slider-keyboard-ten-percent', 'src/main.ts',
      `    const current = Math.round(vm.getZoom() * 100);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = current - 1;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = current + 1;
        break;
      case 'PageDown':
        next = current - 10;
        break;
      case 'PageUp':
        next = current + 10;
        break;`,
      () => `    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
      case 'PageDown':
        event.preventDefault();
        dispatcher.dispatch('view:zoom-out');
        return;
      case 'ArrowRight':
      case 'ArrowUp':
      case 'PageUp':
        event.preventDefault();
        dispatcher.dispatch('view:zoom-in');
        return;`,
      '슬라이더 키 조작도 확대·축소 버튼과 같은 10% 이동 사용');
    extra('rhwp090-wheel-zoom-step-state', 'src/view/viewport-manager.ts',
      'const WHEEL_ZOOM_SENSITIVITY = 0.00625;\nconst MAX_WHEEL_DELTA_PX = 120;',
      () => 'const WHEEL_ZOOM_STEP_PX = 40;\nconst WHEEL_ZOOM_RESET_MS = 120;',
      '트랙패드의 작은 휠 입력은 한 눈금이 될 때까지 모음');
    extra('rhwp090-wheel-zoom-remainder', 'src/view/viewport-manager.ts',
      '  private zoomTarget = 1.0;',
      a => `${a}\n  private wheelZoomRemainder = 0;\n  private lastWheelZoomAt = -Infinity;`,
      '휠 배율 입력을 화면별로 관리');
    extra('rhwp090-wheel-zoom-step-input', 'src/view/viewport-manager.ts',
      `    const boundedDelta = Math.max(
      -MAX_WHEEL_DELTA_PX,
      Math.min(MAX_WHEEL_DELTA_PX, deltaY),
    );
    if (boundedDelta === 0) return;`,
      () => `    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    const now = performance.now();
    const direction = Math.sign(deltaY);
    if (now - this.lastWheelZoomAt > WHEEL_ZOOM_RESET_MS
        || (this.wheelZoomRemainder !== 0 && Math.sign(this.wheelZoomRemainder) !== direction)) {
      this.wheelZoomRemainder = 0;
    }
    this.lastWheelZoomAt = now;
    // Mouse-wheel ticks count once. Fractional pixel deltas accumulate across a gesture.
    this.wheelZoomRemainder += direction * (e.deltaMode === 0
      ? Math.min(1, Math.abs(deltaY) / WHEEL_ZOOM_STEP_PX) : 1);
    if (Math.abs(this.wheelZoomRemainder) + Number.EPSILON < 1) return;
    this.wheelZoomRemainder = 0;`,
      'Ctrl·Command 휠에서 한 눈금마다 배율을 변경');
    extra('rhwp090-wheel-zoom-reset-on-scroll', 'src/view/viewport-manager.ts',
      '    if (!e.ctrlKey && !e.metaKey) {',
      a => `${a}\n      this.wheelZoomRemainder = 0;`,
      '일반 스크롤이 배율 눈금에 누적되지 않음');
    extra('rhwp090-wheel-zoom-ten-percent', 'src/view/viewport-manager.ts',
      '    const target = this.clampZoom(this.zoomTarget * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY));',
      () => '    const target = this.clampZoom(this.zoomTarget - direction * 0.1);',
      '휠 배율에 10%p 증감과 기존 포인터 기준점을 적용');
  }
  return result;
}
