// [hwpx-cowork] Opening previews are read-only. Keep the existing loadFile and
// plugin ready promises as full font/layout/collaboration barriers.
export const PROGRESSIVE_OPEN_PATCHES = [
  {
    id: 'progressive-open-main-helper', file: 'src/main.ts',
    why: '읽기 전용 첫 쪽과 전체 조판 준비를 구분한다',
    anchor: "import { WasmBridge } from '@/core/wasm-bridge';",
    replace: a => `${a}\nimport { loadDocumentProgressively, finishProgressiveOpen, preserveProgressivePreview, isProgressivePreviewPainted, isProgressiveOpenSuperseded, OpenProgressPaintGate } from '@cowork/performance/progressive-open';`,
  },
  {
    id: 'progressive-open-progress-paint-gate', file: 'src/main.ts',
    why: '문서 열기의 연속 진행 문구마다 고정 두 프레임을 기다리지 않는다',
    anchor: 'async function updateLoadProgress(percent: number, label: string): Promise<void> {',
    replace: a => `const coworkOpenProgressPaint = new OpenProgressPaintGate(waitForNextPaint, 80);\n\n${a}`,
  },
  {
    id: 'progressive-open-progress-coalesce', file: 'src/main.ts',
    why: '첫 진입은 반드시 표시하고 80ms 이내의 중복 진행 표시 대기만 합친다',
    anchor: '  await waitForNextPaint();\n}',
    replace: () => '  await coworkOpenProgressPaint.update(percent);\n}',
  },
  {
    id: 'progressive-open-bridge-previous-document', file: 'src/core/wasm-bridge.ts',
    why: '점진 열기가 끝나기 전까지 이전 문서와 파일 메타데이터를 보존한다',
    anchor: '  private _documentGeneration = 0;',
    replace: a => `${a}
  private coworkProgressivePrevious: {
    doc: HwpDocument | null; fileName: string; fileHandle: FileSystemFileHandleLike | null;
    requiresPassword: boolean; digest: string | null; generation: number;
  } | null = null;`,
  },
  {
    id: 'progressive-open-atomic-hold-option', file: 'src/core/wasm-bridge.ts',
    why: '정상 열기와 구분하여 점진 열기만 이전 핸들의 해제를 지연한다',
    anchor: '    createDocument: () => HwpDocument,\n  ): void {',
    replace: a => a.replace('  ): void {', '    holdPrevious = false,\n  ): void {'),
  },
  {
    id: 'progressive-open-atomic-replace-pending', file: 'src/core/wasm-bridge.ts',
    why: '다른 문서를 여는 새 시도는 이전 미완료 문서를 먼저 원래 상태로 되돌린다',
    anchor: "    const nextFileName = fileName ?? 'document.hwp';",
    replace: a => `    this.rollbackProgressiveOpen(this._documentGeneration);\n${a}`,
  },
  {
    id: 'progressive-open-atomic-previous-state', file: 'src/core/wasm-bridge.ts',
    why: '기존 문서의 저장 이름·핸들·보호 상태·식별자를 함께 보존한다',
    anchor: '      const previousDoc = this.doc;',
    replace: a => `${a}
      const previousState = { doc: previousDoc, fileName: this._fileName,
        fileHandle: this._currentFileHandle, requiresPassword: this._requiresPasswordForSave,
        digest: this._documentDigest };`,
  },
  {
    id: 'progressive-open-atomic-delay-free', file: 'src/core/wasm-bridge.ts',
    why: '완료 전 오류가 발생해도 기존 문서를 복구할 수 있게 한다',
    anchor: '      if (previousDoc) {\n        try {\n          previousDoc.free();',
    replace: a => a.replace('      if (previousDoc) {', `      if (holdPrevious) {
        this.coworkProgressivePrevious = { ...previousState, generation: this._documentGeneration };
      } else if (previousDoc) {`),
  },
  {
    id: 'progressive-open-atomic-rollback-error', file: 'src/core/wasm-bridge.ts',
    why: '부분 문서 교체 뒤 오류에서도 이미 해제한 핸들을 다시 사용하지 않는다',
    anchor: '    } catch (error) {\n      if (nextDoc) {',
    replace: a => a.replace('      if (nextDoc) {', `      if (holdPrevious && this.coworkProgressivePrevious?.generation === this._documentGeneration) {
        this.rollbackProgressiveOpen(this._documentGeneration);
        nextDoc = null;
      }
      if (nextDoc) {`),
  },
  {
    id: 'progressive-open-bridge-log-phase', file: 'src/core/wasm-bridge.ts',
    why: '처음 두 쪽의 임시 수를 전체 문서 쪽 수로 오해하지 않게 한다',
    anchor: '      console.log(`[WasmBridge] 문서 로드: ${this.pageCount}페이지`);',
    replace: a => `      let coworkPreviewPending = false;
      try { coworkPreviewPending = JSON.parse(this.progressiveOpenState() || '{}').state === 'pending'; } catch { /* optional diagnostics */ }
      if (coworkPreviewPending) console.log('[WasmBridge] 문서 미리보기: ' + this.pageCount + '페이지 (전체 조판 중)');
      else ${a.trim()}`,
  },
  {
    id: 'progressive-open-bridge-api', file: 'src/core/wasm-bridge.ts',
    why: '새 엔진의 점진 열기를 선택적으로 사용하고 구형 엔진은 그대로 연다',
    anchor: '  loadDocument(data: Uint8Array, fileName?: string): DocumentInfo {',
    replace: a => `  // [hwpx-cowork] Partial pagination is only used by the read-only open coordinator.
  loadDocumentProgressively(data: Uint8Array, fileName?: string): DocumentInfo {
    const constructor = HwpDocument as unknown as {
      openProgressive?: (bytes: Uint8Array, firstPages: number) => HwpDocument;
      prototype: { stepProgressiveOpen?: unknown; progressiveOpenState?: unknown; flushProgressiveOpen?: unknown };
    };
    const supported = typeof constructor.openProgressive === 'function'
      && ['stepProgressiveOpen', 'progressiveOpenState', 'flushProgressiveOpen']
        .every(name => typeof (constructor.prototype as Record<string, unknown>)[name] === 'function');
    this.loadDocumentAtomically(data, fileName, false, () => supported
      ? constructor.openProgressive!(data, 2) : new HwpDocument(data), supported);
    return this.getDocumentInfo();
  }

  progressiveOpenState(): string | null {
    const doc = this.doc as unknown as { progressiveOpenState?: () => string } | null;
    return typeof doc?.progressiveOpenState === 'function' ? doc.progressiveOpenState() : null;
  }

  stepProgressiveOpen(paragraphBudget = 16): string | null {
    const doc = this.doc as unknown as { stepProgressiveOpen?: (budget: number) => string } | null;
    return typeof doc?.stepProgressiveOpen === 'function' ? doc.stepProgressiveOpen(paragraphBudget) : null;
  }

  flushProgressiveOpen(): string | null {
    const doc = this.doc as unknown as { flushProgressiveOpen?: () => string } | null;
    return typeof doc?.flushProgressiveOpen === 'function' ? doc.flushProgressiveOpen() : null;
  }

  commitProgressiveOpen(generation: number): boolean {
    const previous = this.coworkProgressivePrevious;
    if (!previous || previous.generation !== generation || this._documentGeneration !== generation) return false;
    this.coworkProgressivePrevious = null;
    try { previous.doc?.free(); } catch { /* the completed document owns the new handle */ }
    return true;
  }

  rollbackProgressiveOpen(generation: number): boolean {
    const previous = this.coworkProgressivePrevious;
    if (!previous || previous.generation !== generation || this._documentGeneration !== generation) return false;
    this.coworkProgressivePrevious = null;
    try { this.doc?.free(); } catch { /* restore the previous live handle regardless */ }
    this.doc = previous.doc;
    this._fileName = previous.fileName;
    this._currentFileHandle = previous.fileHandle;
    this._requiresPasswordForSave = previous.requiresPassword;
    this._documentDigest = previous.digest;
    this._documentGeneration += 1;
    this.releaseCanvasFontResources();
    this.onFileNameChanged?.(this._fileName);
    return true;
  }

${a}`,
  },
  {
    id: 'progressive-open-main-coordinator', file: 'src/main.ts',
    why: '첫 1~2쪽을 표시한 뒤 브라우저에 실행 기회를 주며 나머지를 계산한다',
    anchor: '    return wasm.loadDocument(data, fileName);',
    replace: () => `    return await loadDocumentProgressively(wasm, data, fileName, {
      async preview() {
        inputHandler?.deactivate();
        toolbar?.setEnabled(false);
        await canvasView?.loadDocument({ coworkPreview: true });
      },
      previewReady: () => isProgressivePreviewPainted(document.getElementById('scroll-container')),
      preservePreview: () => preserveProgressivePreview(document.getElementById('scroll-container')),
      rollback() { plugins.notifyDocumentSwap(); eventBus.emit('document-swapped'); },
      progress(state) {
        coworkOpenProgressPaint.markPaint();
        sbPage().textContent = '1 / ' + state.pageCount + '+ 쪽 · 계산 중';
        sbMessage().textContent = '문서 준비 중… (' + state.processedParagraphs + '/' + state.totalParagraphs + ' 문단)';
      },
    });`,
  },
  {
    id: 'progressive-open-release-held-document', file: 'src/core/wasm-bridge.ts',
    why: '문서 해제 시 이전 문서 보존 핸들도 함께 해제한다',
    anchor: '  releaseDocument(): void {\n    this.releaseCanvasFontResources();',
    replace: a => a.replace('    this.releaseCanvasFontResources();', '    this.commitProgressiveOpen(this._documentGeneration);\n    this.releaseCanvasFontResources();'),
  },
  {
    id: 'progressive-open-new-document-clears-held', file: 'src/core/wasm-bridge.ts',
    why: '새 문서 생성은 이전 점진 열기의 복구 핸들을 남기지 않는다',
    anchor: '  createNewDocument(): DocumentInfo {',
    replace: a => `${a}\n    this.commitProgressiveOpen(this._documentGeneration);`,
  },
  {
    id: 'progressive-open-cancelled-error', file: 'src/main.ts',
    why: '새 문서로 교체된 이전 비동기 열기는 오류 화면을 덮어쓰지 않는다',
    anchor: '  return error instanceof DocumentOpenCancelledError;',
    replace: () => '  return error instanceof DocumentOpenCancelledError || isProgressiveOpenSuperseded(error);',
  },
  {
    id: 'progressive-open-ignore-stale-error', file: 'src/main.ts',
    why: '이전 열기의 취소 처리가 새 문서 화면 복구나 준비 상태를 건드리지 않는다',
    anchor: 'function showLoadErrorUnlessCancelled(error: unknown): void {',
    replace: a => `${a}\n  if (isProgressiveOpenSuperseded(error)) return;`,
  },
  {
    id: 'progressive-open-finish-preview', file: 'src/main.ts',
    why: '기존 초기화가 끝난 뒤 미리보기 보존 화면을 해제하고 확정 쪽 수를 알린다',
    anchor: `    await initializeDocument(docInfo, t('ui.sbMessage.filePagesTimed', { p1: fileName, p2: docInfo.pageCount, p3: elapsed.toFixed(1) }), {
      suppressDialogs: options.suppressDialogs,
    });`,
    replace: a => `${a}\n    await finishProgressiveOpen(wasm);`,
  },
  {
    id: 'progressive-open-preview-view-option', file: 'src/view/canvas-view.ts',
    why: '미리보기에서는 아직 완성되지 않은 전 문서 메트릭 준비를 요청하지 않는다',
    anchor: '  async loadDocument(): Promise<void> {',
    replace: () => '  async loadDocument(options: { coworkPreview?: boolean } = {}): Promise<void> {',
  },
  {
    id: 'progressive-open-preview-metrics-barrier', file: 'src/view/canvas-view.ts',
    why: '정상 전체 열기만 기존 정확 폰트 메트릭을 준비한다',
    anchor: '    await this.wasm.prepareCanvasMetrics(selection.backend, () => !this.disposed && epoch === this.rendererSelectionEpoch && this.rendererSession.isCurrent(selection));',
    replace: a => `    if (!options.coworkPreview) {\n${a}\n    }`,
  },
  {
    id: 'progressive-open-preview-page-bound', file: 'src/view/canvas-view.ts',
    why: '미리보기 페이지 정보와 Canvas를 처음 두 쪽으로 제한한다',
    anchor: '    this.applyRendererSelection(selection);\n\n    const pageCount = this.wasm.pageCount;\n    this.pages = [];\n    for (let i = 0; i < pageCount; i++) {',
    replace: a => a.replace('const pageCount = this.wasm.pageCount;', 'const pageCount = options.coworkPreview ? Math.min(2, this.wasm.pageCount) : this.wasm.pageCount;'),
  },
  {
    id: 'progressive-open-preview-ready-barrier', file: 'src/view/canvas-view.ts',
    why: '부분 화면을 협업 플러그인의 편집 준비 완료로 알리지 않는다',
    anchor: "    this.eventBus.emit('document-view-loaded');",
    replace: () => "    if (!options.coworkPreview) this.eventBus.emit('document-view-loaded');",
  },
  // 문서 화면 올리기가 화면 그리기 선택(rendererSelectionEpoch)이 바뀌었다고 조용히 그만두면 다시 하는 사람이 없다 —
  // 미리보기가 떠 있는 동안 글꼴 적재(폰처럼 한글 글꼴이 OS 에 없을 때)가 자동 재선택을 부르면 전체 화면이 0쪽으로 남고
  // 'document-view-loaded'(플러그인 ready)가 오지 않았다(2026-11-03 폰 63쪽 문서). 같은 문서를 여는 중이면 다시 올린다.
  {
    id: 'progressive-open-load-retry-wrapper', file: 'src/view/canvas-view.ts',
    why: '화면 선택이 바뀌어 그만둔 문서 화면 올리기를 같은 문서면 다시 한다',
    anchor: '  async loadDocument(options: { coworkPreview?: boolean } = {}): Promise<void> {',
    replace: () => `  private coworkDocumentLoadSeq = 0;
  async loadDocument(options: { coworkPreview?: boolean } = {}): Promise<void> {
    const seq = ++this.coworkDocumentLoadSeq;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if ((await this.coworkLoadDocumentOnce(options)) !== 'superseded') return;
      // 새 문서 열기·닫기가 이 호출을 앞질렀으면 그쪽이 화면을 올린다
      if (this.disposed || seq !== this.coworkDocumentLoadSeq) return;
      console.warn(\`[CanvasView] 화면 그리기 선택이 바뀌어 문서 화면을 다시 올립니다(\${attempt})\`);
    }
    console.error('[CanvasView] 문서 화면을 올리지 못했습니다(화면 그리기 선택이 계속 바뀜)');
  }

  private async coworkLoadDocumentOnce(options: { coworkPreview?: boolean }): Promise<'done' | 'superseded'> {`,
  },
  {
    id: 'progressive-open-load-retry-start', file: 'src/view/canvas-view.ts',
    why: '앞쪽 그만두기를 끝(done)과 선택 바뀜(superseded)으로 나눈다',
    anchor: `    if (this.disposed) return;
    if (!this.documentLoadPrepared) this.prepareDocumentLoad();
    const epoch = this.rendererSelectionEpoch;
    this.documentLoadPrepared = false;
    if (this.disposed) return;
    const selection = await this.rendererSession.resolve(this.wasm);
    if (this.disposed || epoch !== this.rendererSelectionEpoch || !this.rendererSession.isCurrent(selection)) return;`,
    replace: () => `    if (this.disposed) return 'done';
    if (!this.documentLoadPrepared) this.prepareDocumentLoad();
    const epoch = this.rendererSelectionEpoch;
    this.documentLoadPrepared = false;
    if (this.disposed) return 'done';
    const selection = await this.rendererSession.resolve(this.wasm);
    if (this.disposed) return 'done';
    if (epoch !== this.rendererSelectionEpoch || !this.rendererSession.isCurrent(selection)) return 'superseded';`,
  },
  {
    id: 'progressive-open-load-retry-metrics', file: 'src/view/canvas-view.ts',
    why: '메트릭 준비 뒤 그만두기도 나눈다',
    anchor: `    if (
      this.disposed
      || epoch !== this.rendererSelectionEpoch
      || !this.rendererSession.isCurrent(selection)
    ) return;
    this.applyRendererSelection(selection);`,
    replace: () => `    if (this.disposed) return 'done';
    if (epoch !== this.rendererSelectionEpoch || !this.rendererSession.isCurrent(selection)) return 'superseded';
    this.applyRendererSelection(selection);`,
  },
  {
    id: 'progressive-open-load-retry-no-pages', file: 'src/view/canvas-view.ts',
    why: '쪽이 없으면 다시 해도 같다',
    anchor: `      console.error('[CanvasView] 로드된 페이지가 없습니다');
      return;`,
    replace: () => `      console.error('[CanvasView] 로드된 페이지가 없습니다');
      return 'done';`,
  },
  {
    id: 'progressive-open-load-retry-end', file: 'src/view/canvas-view.ts',
    why: '끝까지 올렸다',
    anchor: "    if (!options.coworkPreview) this.eventBus.emit('document-view-loaded');",
    replace: a => `${a}\n    return 'done';`,
  },
];
