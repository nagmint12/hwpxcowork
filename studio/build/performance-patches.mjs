// 입력 본문과 서식 계산은 그대로 유지하고, 협업 측에 안전한 변경 범위를 전달한다.
// Toolbar는 실제 현재 DOM 값과 비교한다. 서식 객체만 캐시하면 사용자가 직접 고친
// 크기 입력값이나 언어 선택이 낡은 채 남을 수 있으므로 객체 전체를 캐시하지 않는다.
export const PERFORMANCE_PATCHES = [
  {
    id: 'canvas-metric-session-pending-work',
    file: 'src/core/canvas-metric-session.ts',
    why: 'fontsReady 전에 취소된 문단과 전체 측정 요청을 다음 표시 revision에 보존한다',
    anchor: '  private epoch = 0;\n  lastError: string | null = null;',
    replace: (a) => a.replace('  lastError:', `  private coworkMetricPreparation: {
    doc: CanvasMetricDocument; document: number; fonts: number; scope?: string;
    full: boolean; pending: boolean;
  } | null = null;
  private coworkCompletedPreparationSerial = 0;
  get completedPreparationSerial(): number { return this.coworkCompletedPreparationSerial; }
  lastError:`),
  },
  {
    id: 'canvas-metric-session-pending-reset',
    file: 'src/core/canvas-metric-session.ts',
    why: '측정 무효화 뒤 최초 준비는 전체 문서를 다시 수집한다',
    anchor: '  invalidate(): void { this.epoch += 1; this.provider.dispose(); }',
    replace: () => '  invalidate(): void { this.epoch += 1; this.provider.dispose(); this.coworkMetricPreparation = null; }',
  },
  {
    id: 'canvas-metric-session-coalesce-before-await',
    file: 'src/core/canvas-metric-session.ts',
    why: '첫 비동기 대기 전에 미완료 작업을 합쳐 다른 문단/전체 측정 요청의 유실을 막는다',
    anchor: '    const epoch = ++this.epoch;\n    const stale = (): boolean => epoch !== this.epoch || !isCurrent();',
    replace: (a) => `${a}
    const previous = this.coworkMetricPreparation;
    const generationChanged = !previous || previous.doc !== doc
      || previous.document !== generation.document || previous.fonts !== generation.fonts;
    const full = !paragraphTargetJson || generationChanged
      || Boolean(previous?.pending && (previous.full || previous.scope !== paragraphTargetJson));
    const preparation = {
      doc, document: generation.document, fonts: generation.fonts,
      scope: full ? undefined : paragraphTargetJson, full, pending: true,
    };
    this.coworkMetricPreparation = preparation;`,
  },
  {
    id: 'canvas-metric-session-complete-pending-work',
    file: 'src/core/canvas-metric-session.ts',
    why: '현재 세대의 측정 등록과 선택이 모두 성공한 경우에만 미완료 표식을 해제한다',
    anchor: '      this.lastError = null;\n      return registered || selected;',
    replace: () => `      this.lastError = null;
      if (this.coworkMetricPreparation === preparation) preparation.pending = false;
      this.coworkCompletedPreparationSerial += 1;
      return registered || selected;`,
  },
  {
    id: 'canvas-metric-bridge-pending-work',
    file: 'src/core/wasm-bridge.ts',
    why: 'host 폰트 준비를 기다리는 동안에도 앞선 문단과 전체 측정 작업을 누적한다',
    anchor: '  private canvasFontGeneration = 0;',
    replace: (a) => `${a}
  private coworkMetricBridgeWork: {
    doc: HwpDocument | null; document: number; fonts: number; scope?: string;
    full: boolean; pending: boolean;
  } | null = null;`,
  },
  {
    id: 'canvas-metric-bridge-reserve-pending-work',
    file: 'src/core/wasm-bridge.ts',
    why: '표시 revision 선택의 첫 await 전부터 측정 범위를 동기로 예약하여 취소된 변경을 보존한다',
    anchor: '  get canvasMetricFontGeneration(): number { return this.canvasFontGeneration; }',
    replace: (a) => `${a}

  reserveCanvasMetricTarget(paragraphTargetJson?: string): string | undefined {
    const doc = this.doc;
    const documentGeneration = this._documentGeneration;
    const fontGeneration = this.canvasFontGeneration;
    const previous = this.coworkMetricBridgeWork;
    const generationChanged = !previous || previous.doc !== doc
      || previous.document !== documentGeneration || previous.fonts !== fontGeneration;
    const full = !paragraphTargetJson || generationChanged
      || Boolean(previous?.pending && (previous.full || previous.scope !== paragraphTargetJson));
    this.coworkMetricBridgeWork = {
      doc, document: documentGeneration, fonts: fontGeneration,
      scope: full ? undefined : paragraphTargetJson, full, pending: true,
    };
    return this.coworkMetricBridgeWork.scope;
  }`,
  },
  {
    id: 'canvas-metric-bridge-coalesce-before-await',
    file: 'src/core/wasm-bridge.ts',
    why: 'Bridge의 첫 await 전에 누적 범위를 확정하고 폰트 세대 변경도 current 검증에 포함한다',
    anchor: '    const documentGeneration = this._documentGeneration;\n    const current = () => this.doc === doc && this._documentGeneration === documentGeneration && isCurrent();',
    replace: () => `    const documentGeneration = this._documentGeneration;
    const fontGeneration = this.canvasFontGeneration;
    const current = () => this.doc === doc && this._documentGeneration === documentGeneration
      && this.canvasFontGeneration === fontGeneration && isCurrent();
    this.reserveCanvasMetricTarget(paragraphTargetJson);
    const bridgeWork = this.coworkMetricBridgeWork!;`,
  },
  {
    id: 'paragraph-canvas-metric-optional-api',
    file: 'src/core/canvas-metric-session.ts',
    why: '단일 문단 측정 요청 API를 선택적으로 지원하며 구형 WASM은 전체 수집을 유지한다',
    anchor: '  collectCanvasMetricRequests(document: number, fonts: number): string;',
    replace: (a) => `${a}
  collectCanvasMetricRequestsForParagraph?(document: number, fonts: number, targetJson: string): string;`,
  },
  {
    id: 'paragraph-canvas-metric-session-scope',
    file: 'src/core/canvas-metric-session.ts',
    why: '표시 revision의 기존 세대·epoch 계약 안에서 검증된 문단 대상만 추가로 받는다',
    anchor: "    createContext: () => Pick<CanvasRenderingContext2D, 'font' | 'measureText'> | null,\n  ): Promise<boolean> {",
    replace: (a) => a.replace('  ): Promise<boolean> {', '    paragraphTargetJson?: string,\n  ): Promise<boolean> {'),
  },
  {
    id: 'paragraph-canvas-metric-session-collection',
    file: 'src/core/canvas-metric-session.ts',
    why: '순수 문자 변경은 기존 측정 요청과 해당 문단의 새 글리프만 수집한다',
    anchor: '      const batch = JSON.parse(doc.collectCanvasMetricRequests(generation.document, generation.fonts)) as {',
    replace: () => `      const requestJson = preparation.scope && typeof doc.collectCanvasMetricRequestsForParagraph === 'function'
        ? doc.collectCanvasMetricRequestsForParagraph(generation.document, generation.fonts, preparation.scope)
        : doc.collectCanvasMetricRequests(generation.document, generation.fonts);
      const batch = JSON.parse(requestJson) as {`,
  },
  {
    id: 'paragraph-canvas-metric-bridge-scope',
    file: 'src/core/wasm-bridge.ts',
    why: '측정 문단 범위를 현재 문서·폰트 세대의 Session에 전달한다',
    anchor: '  async prepareCanvasMetrics(backend: string, isCurrent: () => boolean = () => true): Promise<boolean> {',
    replace: () => '  async prepareCanvasMetrics(backend: string, isCurrent: () => boolean = () => true, paragraphTargetJson?: string): Promise<boolean> {',
  },
  {
    id: 'paragraph-canvas-metric-bridge-delegate',
    file: 'src/core/wasm-bridge.ts',
    why: '측정 Context·host 폰트와 세대 검증을 유지하면서 마지막 인수로 문단 대상을 전달한다',
    anchor: `    return this.canvasMetrics.prepare(metricDoc,
      { document: this._documentGeneration, fonts: this.canvasFontGeneration }, backend,
      current, () => document.fonts.ready, () => {
        const context = document.createElement('canvas').getContext('2d');
        return context ? this.hostCanvasFonts.measurementContext(context) : null;
      });`,
    replace: () => `    const completionBefore = this.canvasMetrics.completedPreparationSerial;
    const changed = await this.canvasMetrics.prepare(metricDoc,
      { document: documentGeneration, fonts: fontGeneration }, backend,
      current, () => document.fonts.ready, () => {
        const context = document.createElement('canvas').getContext('2d');
        return context ? this.hostCanvasFonts.measurementContext(context) : null;
      }, bridgeWork.scope);
    if (current() && this.coworkMetricBridgeWork === bridgeWork
      && this.canvasMetrics.completedPreparationSerial > completionBefore && this.canvasMetrics.lastError === null) {
      bridgeWork.pending = false;
    }
    return changed;`,
  },
  {
    id: 'paragraph-canvas-metric-target-validator',
    file: 'src/view/canvas-view.ts',
    why: '텍스트 전용 무효화의 유효한 본문/셀 문단 위치만 측정 범위로 변환한다',
    anchor: 'const AUTO_RENDERER_RESELECTION_DELAY_MS = 300;',
    replace: (a) => `${a}

// [hwpx-cowork] Only InputHandler's validated text-only mutation can scope metrics.
// Unknown/structural/custom invalidations and text boxes keep full collection.
function coworkCanvasMetricTarget(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const invalidation = payload as { reason?: unknown; textOnlyPosition?: unknown };
  if (invalidation.reason !== 'text-edit' || !invalidation.textOnlyPosition
    || typeof invalidation.textOnlyPosition !== 'object') return undefined;
  const pos = invalidation.textOnlyPosition as Record<string, unknown>;
  const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (pos.isTextBox || !integer(pos.sectionIndex)) return undefined;
  const para = pos.parentParaIndex ?? pos.paragraphIndex;
  if (!integer(para)) return undefined;
  if (pos.parentParaIndex !== undefined && !integer(pos.parentParaIndex)) return undefined;
  if (pos.parentParaIndex === undefined) {
    if (Array.isArray(pos.cellPath) && pos.cellPath.length > 0) return undefined;
    return JSON.stringify({ sec: pos.sectionIndex, para });
  }
  const sourcePath = Array.isArray(pos.cellPath) && pos.cellPath.length > 0 ? pos.cellPath : [{
    controlIndex: pos.controlIndex, cellIndex: pos.cellIndex, cellParaIndex: pos.cellParaIndex,
  }];
  const cellPath: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }> = [];
  for (const value of sourcePath) {
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    if (!integer(entry.controlIndex) || !integer(entry.cellIndex) || !integer(entry.cellParaIndex)) return undefined;
    cellPath.push({ controlIndex: entry.controlIndex, cellIndex: entry.cellIndex, cellParaIndex: entry.cellParaIndex });
  }
  return JSON.stringify({ sec: pos.sectionIndex, para, cellPath });
}`,
  },
  {
    id: 'paragraph-canvas-metric-view-invalidated-scope',
    file: 'src/view/canvas-view.ts',
    why: '텍스트 무효화에 한해서만 검증된 문단의 측정을 요청한다',
    anchor: '  private async refreshInvalidatedPageForMutation(payload: unknown): Promise<void> {\n    const selected = await this.selectMutationRevision();',
    replace: (a) => a.replace('this.selectMutationRevision();', 'this.selectMutationRevision(coworkCanvasMetricTarget(payload));'),
  },
  {
    id: 'paragraph-canvas-metric-view-selection-scope',
    file: 'src/view/canvas-view.ts',
    why: '단일 문단 측정 힌트를 현재 표시 revision에 전달한다',
    anchor: '  private async selectMutationRevision(): Promise<{',
    replace: () => '  private async selectMutationRevision(paragraphTargetJson?: string): Promise<{',
  },
  {
    id: 'paragraph-canvas-metric-mutation-reserve',
    file: 'src/view/canvas-view.ts',
    why: 'auto/명시 렌더러 분기와 비동기 선택 전에 누적 문단 범위를 예약한다',
    anchor: '    if (this.disposed) return null;\n    const pinned = this.rendererSession.pinAutoMutationRevision();',
    replace: () => '    if (this.disposed) return null;\n    paragraphTargetJson = this.wasm.reserveCanvasMetricTarget(paragraphTargetJson);\n    const pinned = this.rendererSession.pinAutoMutationRevision();',
  },
  {
    id: 'paragraph-canvas-metric-next-revision-reserve',
    file: 'src/view/canvas-view.ts',
    why: '전체 revision 요청도 rendererSession.resolve 대기 전에 기록하여 후속 텍스트 입력이 지우지 못하게 한다',
    anchor: '    if (this.disposed) return null;\n    this.zoomRefreshRequired = this.viewportManager.cancelPendingZoomRaster() || this.zoomRefreshRequired;\n    const epoch = ++this.rendererSelectionEpoch;',
    replace: (a) => a.replace('    this.zoomRefreshRequired', '    paragraphTargetJson = this.wasm.reserveCanvasMetricTarget(paragraphTargetJson);\n    this.zoomRefreshRequired'),
  },
  {
    id: 'paragraph-canvas-metric-explicit-renderer-scope',
    file: 'src/view/canvas-view.ts',
    why: '실제 호스트의 명시적 canvas2d 렌더러에서도 문단 측정 범위를 유지한다',
    anchor: '    if (!pinned) return this.selectNextDocumentRevision();',
    replace: () => '    if (!pinned) return this.selectNextDocumentRevision(true, paragraphTargetJson);',
  },
  {
    id: 'paragraph-canvas-metric-next-revision-scope',
    file: 'src/view/canvas-view.ts',
    why: '명시 렌더러 revision 선택에서도 검증된 문단 대상을 선택적으로 받는다',
    anchor: '  private async selectNextDocumentRevision(resetResources = true): Promise<{',
    replace: () => '  private async selectNextDocumentRevision(resetResources = true, paragraphTargetJson?: string): Promise<{',
  },
  {
    id: 'paragraph-canvas-metric-next-revision-prepare',
    file: 'src/view/canvas-view.ts',
    why: '명시 렌더러의 metrics 준비에도 epoch·문서 freshness 검증을 유지한 채 문단을 전달한다',
    anchor: '    const metricsChanged = await this.wasm.prepareCanvasMetrics(selection.backend, () => !this.disposed && epoch === this.rendererSelectionEpoch && this.rendererSession.isCurrent(selection));',
    replace: (a) => a.replace('this.rendererSession.isCurrent(selection));', 'this.rendererSession.isCurrent(selection), paragraphTargetJson);'),
  },
  {
    id: 'paragraph-canvas-metric-view-prepare-scope',
    file: 'src/view/canvas-view.ts',
    why: '동일 폰트·문서 세대 및 현재 revision 조건을 유지한 채 문단만 측정한다',
    anchor: '      backendChanged: (await this.wasm.prepareCanvasMetrics(pinned.backend, () => !this.disposed && this.rendererSession.isCurrent(pinned))) || this.zoomRefreshRequired,',
    replace: (a) => a.replace('this.rendererSession.isCurrent(pinned)))', 'this.rendererSession.isCurrent(pinned), paragraphTargetJson))'),
  },
  {
    id: 'paragraph-canvas-metric-text-invalidation-hint',
    file: 'src/engine/input-handler.ts',
    why: '이미 순수 문자 변경으로 검증된 위치만 페이지 무효화에도 독립 복사하여 담는다',
    anchor: "        reason: 'text-edit',\n        ...(focusedPagePatch?.pageIndex === pageIndex ? { focusedPagePatch } : {}),",
    replace: (a) => a.replace("        reason: 'text-edit',", `        reason: 'text-edit',
        ...(textOnlyPosition ? { textOnlyPosition: {
          ...textOnlyPosition,
          ...(textOnlyPosition.cellPath ? { cellPath: textOnlyPosition.cellPath.map(entry => ({ ...entry })) } : {}),
        } } : {}),`),
  },
  {
    id: 'font-normalization-cache-storage',
    file: 'src/core/font-rule-runtime.ts',
    why: '불변 글꼴 이름 정규화를 제한된 크기로 재사용하며 모듈 초기화 중에도 사용할 수 있게 한다',
    anchor: "const SUBSTITUTION_BOUNDARY = 'studio-substitution.substitution-tables';",
    replace: (a) => `// [hwpx-cowork] Pure string results only; supply/load state is never cached here.
const coworkNormalizedFontFamilies = new Map<string, string>();
const COWORK_NORMALIZED_FONT_LIMIT = 4096;
${a}`,
  },
  {
    id: 'font-normalization-cache',
    file: 'src/core/font-rule-runtime.ts',
    why: '매 glyph마다 반복되는 Unicode/locale 글꼴 이름 정규화를 재사용한다',
    anchor: `export function normalizeProjectedFontFamily(value: string): string {
  return value
    .replace(/\\u0000/g, '')
    .normalize('NFC')
    .replace(/\\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}`,
    replace: () => `export function normalizeProjectedFontFamily(value: string): string {
  const cached = coworkNormalizedFontFamilies.get(value);
  if (cached !== undefined) return cached;
  const normalized = value
    .replace(/\\u0000/g, '')
    .normalize('NFC')
    .replace(/\\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
  if (value.length <= 512) {
    if (coworkNormalizedFontFamilies.size >= COWORK_NORMALIZED_FONT_LIMIT) {
      coworkNormalizedFontFamilies.delete(coworkNormalizedFontFamilies.keys().next().value!);
    }
    coworkNormalizedFontFamilies.set(value, normalized);
  }
  return normalized;
}`,
  },
  {
    id: 'font-supply-catalog-index',
    file: 'src/core/font-loader.ts',
    why: '고정 웹폰트 카탈로그를 이름으로 색인하여 입력마다 전체 목록을 순회하지 않는다',
    anchor: 'export const REGISTERED_FONTS = new Set(FONT_LIST.map(f => f.name));',
    replace: (a) => `${a}

// [hwpx-cowork] FONT_LIST is an immutable generated projection. Dynamic loaded/registered
// state remains in its original Sets and is checked on every snapshot below.
const coworkFontEntriesByFamily = new Map<string, FontEntry[]>();
for (const entry of FONT_LIST) {
  const key = normalizeFontFamily(entry.name);
  const entries = coworkFontEntriesByFamily.get(key);
  if (entries) entries.push(entry);
  else coworkFontEntriesByFamily.set(key, [entry]);
}`,
  },
  {
    id: 'font-supply-indexed-lookup',
    file: 'src/core/font-loader.ts',
    why: '실제 등록/로드 상태는 유지하면서 같은 이름의 카탈로그 항목만 조회한다',
    anchor: '  const entries = FONT_LIST.filter(entry => normalizeFontFamily(entry.name) === normalized);',
    replace: () => '  const entries = coworkFontEntriesByFamily.get(normalized) ?? [];',
  },
  {
    id: 'font-rule-catalog-index',
    file: 'src/core/font-rule-runtime.ts',
    why: '진단 ruleIds도 고정 카탈로그를 반복 정규화하지 않고 색인으로 읽는다',
    anchor: `export function getProjectedWebFontRuleIds(fontName: string): string[] {
  const normalized = normalizeProjectedFontFamily(fontName);
  return FONT_RULE_WEBFONT_ENTRIES
    .filter(entry => normalizeProjectedFontFamily(entry.name) === normalized)
    .map(entry => entry.ruleId);
}`,
    replace: () => `const coworkWebFontRulesByFamily = new Map<string, string[]>();
for (const entry of FONT_RULE_WEBFONT_ENTRIES) {
  const key = normalizeProjectedFontFamily(entry.name);
  const rules = coworkWebFontRulesByFamily.get(key);
  if (rules) rules.push(entry.ruleId);
  else coworkWebFontRulesByFamily.set(key, [entry.ruleId]);
}

export function getProjectedWebFontRuleIds(fontName: string): string[] {
  // Return a fresh array so trace callers cannot mutate the shared catalog index.
  return [...(coworkWebFontRulesByFamily.get(normalizeProjectedFontFamily(fontName)) ?? [])];
}`,
  },
  {
    id: 'font-substitution-cache-storage',
    file: 'src/core/font-substitution.ts',
    why: '표시 치환의 정규화 캐시는 최초 정부 글꼴 인덱스 구성 전에 준비한다',
    anchor: 'const GOVERNMENT_SUCCESSORS_BY_SOURCE = new Map(',
    replace: (a) => `const coworkNormalizedSubstitutionFamilies = new Map<string, string>();
${a}`,
  },
  {
    id: 'font-substitution-normalization-cache',
    file: 'src/core/font-substitution.ts',
    why: '표시 치환에서 동일한 요청/설치 글꼴 이름의 locale 정규화를 반복하지 않는다',
    anchor: `function normalizedFamilyKey(fontName: string): string {
  return fontName.normalize('NFC').replace(/\\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}`,
    replace: () => `function normalizedFamilyKey(fontName: string): string {
  const cached = coworkNormalizedSubstitutionFamilies.get(fontName);
  if (cached !== undefined) return cached;
  const normalized = fontName.normalize('NFC').replace(/\\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  if (fontName.length <= 512) {
    if (coworkNormalizedSubstitutionFamilies.size >= 4096) {
      coworkNormalizedSubstitutionFamilies.delete(coworkNormalizedSubstitutionFamilies.keys().next().value!);
    }
    coworkNormalizedSubstitutionFamilies.set(fontName, normalized);
  }
  return normalized;
}`,
  },
  {
    id: 'typing-text-mutation-target',
    file: 'src/engine/input-handler.ts',
    why: '검증된 단일 문단 텍스트 입력만 협업 정렬의 부분 갱신 대상으로 알린다',
    anchor: '  private afterPageLocalEdit(): void {',
    replace: () => '  private afterPageLocalEdit(textOnlyPosition?: DocumentPosition): void {',
  },
  {
    id: 'typing-text-mutation-payload',
    file: 'src/engine/input-handler.ts',
    why: '문단 구조를 바꾸지 않은 입력의 문단/셀 경로를 독립 복사하여 전달한다',
    anchor: "    // 텍스트 입력은 셀 폭을 바꾸지 않으므로 눈금자 셀 bbox 캐시를 무효화하지 않는다.\n    this.protectedCellHitCache = null;\n    this.eventBus.emit('document-mutated', 'input-handler-edit');",
    replace: (a) => a.replace("this.eventBus.emit('document-mutated', 'input-handler-edit');", `this.eventBus.emit('document-mutated', 'input-handler-edit', textOnlyPosition ? {
      kind: 'text',
      position: {
        ...textOnlyPosition,
        ...(textOnlyPosition.cellPath ? { cellPath: textOnlyPosition.cellPath.map(entry => ({ ...entry })) } : {}),
      },
    } : undefined);`),
  },
  {
    id: 'typing-raw-input-target',
    file: 'src/engine/input-handler.ts',
    why: 'IME와 iOS 입력도 같은 문단인 것이 검증된 경우에만 부분 갱신한다',
    anchor: "    if (this.shouldUsePageLocalRefresh('insertText', beforePos, afterPos, pageLocalOptions)) {\n      this.afterPageLocalEdit();",
    replace: (a) => a.replace('this.afterPageLocalEdit();', 'this.afterPageLocalEdit(afterPos);'),
  },
  {
    id: 'typing-command-input-target',
    file: 'src/engine/input-handler.ts',
    why: '일반 입력과 삭제도 같은 문단인 것이 검증된 경우에만 부분 갱신한다',
    anchor: '        if (this.shouldUsePageLocalRefresh(commandType, beforePos, afterPos, pageLocalOptions)) {\n          this.afterPageLocalEdit();',
    replace: (a) => a.replace('this.afterPageLocalEdit();', 'this.afterPageLocalEdit(afterPos);'),
  },
  // 2026-11-18 쪽 나눔이 비싼 문서의 타이핑(운영 문서 실측: 20쪽·표 칸 2,382개 — 저장 줄 정보 없음, 전체 쪽 나눔 한 번 300ms).
  // 원본은 30쪽 이하 문서에서 입력이 120ms 쉴 때마다 동기 전체 쪽 나눔(idle-auto flush)을 한다 — 쪽 수가 비용의 어림이라
  // 쪽 수는 적어도 쪽 나눔이 비싼 문서는 글자마다 화면이 멈췄다. 지난 쪽 나눔에 실제로 걸린 시간을 재서, 한 프레임(16ms)을
  // 넘으면 그 8배만큼(최대 1.5초) 쉰 뒤에 한다. 싼 문서(16ms 이하)는 지금과 같은 120ms. 쪽 나눔을 미루는 동안은 원본의
  // 큰 문서(30쪽 초과 — 쉼 flush 없음)와 같은 길이다: 친 문단은 그 쪽만 다시 그리고, 줄 수가 바뀌면 재개형 작업·대체 flush 가,
  // 캐럿 옮기기·되돌리기·저장·포커스 잃음은 그 자리에서 flush 한다.
  {
    id: 'typing-idle-flush-cost-constants',
    file: 'src/engine/input-handler.ts',
    why: '쉼 flush 간격을 지난 쪽 나눔 시간에 맞추는 상수',
    anchor: 'const DOCUMENT_PAGINATION_IDLE_FLUSH_DELAY_MS = 120;',
    replace: (a) => `${a}
// [hwpx-cowork] 전체 쪽 나눔이 이 시간(한 프레임)을 넘는 문서는 쉼 flush 를 더 오래 쉰 뒤에 한다.
const COWORK_PAGINATION_CHEAP_FLUSH_MS = 16;
const COWORK_PAGINATION_IDLE_COST_FACTOR = 8;
const COWORK_PAGINATION_IDLE_FLUSH_MAX_DELAY_MS = 1500;`,
  },
  {
    id: 'typing-idle-flush-cost-delay',
    file: 'src/engine/input-handler.ts',
    why: '쪽 나눔이 비싼 문서는 입력이 충분히 쉰 뒤에만 전체 쪽 나눔을 한다(글자마다 멈추지 않게)',
    anchor: `  private scheduleDeferredPaginationFlush(): void {
    this.cancelDeferredPaginationFlush();
    this.deferredPaginationPending = true;
    if (!this.shouldAutoFlushDeferredPagination()) return;
    this.deferredPaginationFlushTimer = setTimeout(() => {
      this.flushDeferredPaginationIfNeeded('idle-auto');
    }, DOCUMENT_PAGINATION_IDLE_FLUSH_DELAY_MS);
  }`,
    replace: () => `  // [hwpx-cowork] 지난 전체 쪽 나눔(동기 flush)에 걸린 시간(ms) — 아직 재지 않았으면 0(원본 간격 그대로).
  private coworkPaginationFlushCostMs = 0;

  private coworkIdleFlushDelayMs(): number {
    const cost = this.coworkPaginationFlushCostMs;
    if (!(cost > COWORK_PAGINATION_CHEAP_FLUSH_MS)) return DOCUMENT_PAGINATION_IDLE_FLUSH_DELAY_MS;
    return Math.min(
      COWORK_PAGINATION_IDLE_FLUSH_MAX_DELAY_MS,
      Math.max(DOCUMENT_PAGINATION_IDLE_FLUSH_DELAY_MS, Math.round(cost * COWORK_PAGINATION_IDLE_COST_FACTOR)),
    );
  }

  private coworkTimedPaginationFlush(): void {
    const started = performance.now();
    try {
      this.wasm.flushDeferredPagination();
    } finally {
      this.coworkPaginationFlushCostMs = performance.now() - started;
    }
  }

  private scheduleDeferredPaginationFlush(): void {
    this.cancelDeferredPaginationFlush();
    this.deferredPaginationPending = true;
    if (!this.shouldAutoFlushDeferredPagination()) return;
    this.deferredPaginationFlushTimer = setTimeout(() => {
      this.flushDeferredPaginationIfNeeded('idle-auto');
    }, this.coworkIdleFlushDelayMs());
  }`,
  },
  {
    id: 'typing-idle-flush-cost-measure',
    file: 'src/engine/input-handler.ts',
    why: '경계·쉼 flush 의 전체 쪽 나눔 시간을 잰다',
    anchor: '      this.deferredPaginationRunner.cancel();\n      this.wasm.flushDeferredPagination();',
    replace: () => '      this.deferredPaginationRunner.cancel();\n      this.coworkTimedPaginationFlush();',
  },
  {
    id: 'typing-idle-flush-cost-measure-cell-overflow',
    file: 'src/engine/input-handler.ts',
    why: '칸 넘침 flush 의 전체 쪽 나눔 시간도 같은 값으로 잰다',
    anchor: '    try {\n      this.wasm.flushDeferredPagination();\n      this.deferredPaginationPending = false;\n      this.cursor.invalidateFocusedCellCursorGeometry();\n      this.lastCellKey = null;',
    replace: (a) => a.replace('this.wasm.flushDeferredPagination();', 'this.coworkTimedPaginationFlush();'),
  },
  {
    id: 'toolbar-preserve-unchanged-toggle',
    file: 'src/ui/toolbar.ts',
    why: '반복 입력마다 바뀌지 않은 글자 효과와 정렬 버튼의 class 속성을 다시 쓰지 않는다',
    anchor: "  private setActive(btn: HTMLElement, active: boolean): void {\n    btn.classList.toggle('active', active);\n  }",
    replace: () => "  private setActive(btn: HTMLElement, active: boolean): void {\n    if (btn.classList.contains('active') !== active) btn.classList.toggle('active', active);\n  }",
  },
  {
    id: 'toolbar-preserve-unchanged-effects',
    file: 'src/ui/toolbar.ts',
    why: '동일 글자 효과 메뉴의 class 속성 중복 쓰기를 생략한다',
    anchor: "      item.classList.toggle('active', on);\n      if (on) anyFxActive = true;",
    replace: () => "      if (item.classList.contains('active') !== on) item.classList.toggle('active', on);\n      if (on) anyFxActive = true;",
  },
  {
    id: 'toolbar-preserve-unchanged-font',
    file: 'src/ui/toolbar.ts',
    why: '현재 글꼴이 그대로면 매 키 입력마다 글꼴 option 전체를 순회하지 않는다',
    anchor: '    // 글꼴명 — 선택된 언어 카테고리에 따라 표시\n    const displayFont = this.getDisplayFontFamily(props);\n    if (displayFont) {',
    replace: (a) => a.replace('if (displayFont) {', 'if (displayFont && this.fontName.value !== displayFont) {'),
  },
  {
    id: 'toolbar-preserve-unchanged-size',
    file: 'src/ui/toolbar.ts',
    why: '같은 크기의 글자를 연속 입력할 때 크기 입력 DOM 쓰기를 생략한다',
    anchor: '      const pt = props.fontSize / 100;\n      this.fontSize.value = pt.toFixed(1);',
    replace: () => '      const pt = (props.fontSize / 100).toFixed(1);\n      if (this.fontSize.value !== pt) this.fontSize.value = pt;',
  },
  {
    id: 'toolbar-preserve-unchanged-color',
    file: 'src/ui/toolbar.ts',
    why: '글자색이 같은 입력에서 색상 피커와 표시 막대를 다시 쓰지 않는다',
    anchor: '    // 글자색\n    if (props.textColor) {',
    replace: (a) => a.replace('if (props.textColor) {', 'if (props.textColor && (this.colorPicker.value !== props.textColor || !this.colorBar.style.background)) {'),
  },
  {
    id: 'toolbar-preserve-unchanged-highlight',
    file: 'src/ui/toolbar.ts',
    why: '형광펜 색이 같은 입력에서 표시 막대를 다시 쓰지 않는다',
    anchor: '    // 형광펜 색상 표시\n    if (props.shadeColor) {',
    replace: (a) => a.replace('if (props.shadeColor) {', 'if (props.shadeColor && (this.highlightColor !== props.shadeColor || !this.highlightBar.style.background)) {'),
  },
  {
    id: 'toolbar-preserve-unchanged-spacing',
    file: 'src/ui/toolbar.ts',
    why: '줄간격이 같은 문단에서 option 조회와 select 쓰기를 반복하지 않는다',
    anchor: '      const val = Math.round(props.lineSpacing);\n      this.ensureLsOption(val);\n      this.lsSelect.value = String(val);',
    replace: () => `      const val = Math.round(props.lineSpacing);
      if (this.lsSelect.value !== String(val)) {
        this.ensureLsOption(val);
        this.lsSelect.value = String(val);
      }`,
  },
  {
    id: 'toolbar-preserve-unchanged-style',
    file: 'src/ui/toolbar.ts',
    why: '문단 스타일이 같은 입력에서 select 값을 반복해서 쓰지 않는다',
    anchor: '    if (!this.styleDropdownInitialized) return;\n    this.styleName.value = String(info.id);',
    replace: () => '    if (!this.styleDropdownInitialized) return;\n    if (this.styleName.value !== String(info.id)) this.styleName.value = String(info.id);',
  },
];
