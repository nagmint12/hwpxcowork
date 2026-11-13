/** A preview is deliberately read-only. The existing load promise and plugin
 * ready event remain full-document barriers for editing and saving. */
export interface ProgressiveOpenState {
  state: 'pending' | 'complete';
  pageCount: number;
  processedParagraphs: number;
  totalParagraphs: number;
}

export interface ProgressiveOpenBridge<Info> {
  readonly documentGeneration: number;
  readonly pageCount: number;
  loadDocument(bytes: Uint8Array, fileName?: string): Info;
  loadDocumentProgressively(bytes: Uint8Array, fileName?: string): Info;
  progressiveOpenState(): string | null;
  stepProgressiveOpen(paragraphBudget: number): string | null;
  flushProgressiveOpen(): string | null;
  commitProgressiveOpen(generation: number): boolean;
  rollbackProgressiveOpen(generation: number): boolean;
  getDocumentInfo(): Info;
}

export interface ProgressiveOpenHooks {
  preview(): Promise<void>;
  previewReady?(): boolean;
  progress(state: ProgressiveOpenState): void;
  preservePreview?(): (() => void) | null;
  rollback?(): void;
}

export class ProgressiveOpenSupersededError extends Error {
  constructor() { super('다른 문서를 열어 이전 문서 준비를 취소했습니다.'); this.name = 'ProgressiveOpenSupersededError'; }
}

export function isProgressiveOpenSuperseded(error: unknown): boolean {
  return error instanceof ProgressiveOpenSupersededError;
}

/** Progress labels do not each require two extra animation frames. Preserve the
 * first spinner paint and periodic opportunities after real synchronous work. */
export class OpenProgressPaintGate {
  private lastPaint: number | null = null;
  constructor(private readonly paint: () => Promise<void>, private readonly intervalMs = 80,
    private readonly now: () => number = () => performance.now()) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('잘못된 진행 표시 간격');
  }
  markPaint(): void { this.lastPaint = this.now(); }
  async update(percent: number): Promise<boolean> {
    if (percent !== 0 && this.lastPaint !== null && this.now() - this.lastPaint < this.intervalMs) return false;
    await this.paint();
    this.markPaint();
    return true;
  }
}

let openEpoch = 0;
let preview: { epoch: number; generation: number; release: () => void } | null = null;

function releasePreview(): void {
  preview?.release();
  preview = null;
}

export function readProgressiveOpenState(value: string | null): ProgressiveOpenState | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('문서 준비 상태를 읽지 못했습니다.');
  const state = parsed as Partial<ProgressiveOpenState>;
  if (!['pending', 'complete'].includes(String(state.state))
    || ![state.pageCount, state.processedParagraphs, state.totalParagraphs]
      .every(number => Number.isSafeInteger(number) && (number as number) >= 0)
    || state.processedParagraphs! > state.totalParagraphs!) {
    throw new Error('문서 준비 상태가 올바르지 않습니다.');
  }
  return state as ProgressiveOpenState;
}

/** Unlike a microtask, this gives the browser a rendering opportunity before
 * the next bounded WASM step. Timers also make hidden frames make progress. */
export function yieldProgressiveOpen(): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    let frame: number | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      setTimeout(resolve, 0);
    };
    const timer = setTimeout(finish, 40);
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(finish);
  });
}

function notify(type: string, data: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (typeof performance?.mark === 'function') performance.mark(type, { detail: data });
  console.debug('[ProgressiveOpen]', type === 'cowork-document-preview' ? 'preview' : 'full', data);
  window.dispatchEvent(new CustomEvent(type, { detail: data }));
  if (window.parent !== window) window.parent.postMessage({ type, ...data }, window.location.origin);
}

export function isProgressivePreviewPainted(container: HTMLElement | null): boolean {
  return [...(container?.querySelectorAll<HTMLCanvasElement>('canvas.document-page-canvas') ?? [])]
    .some(canvas => Number(canvas.dataset.rhwpRenderedZoom) > 0
      && Number(canvas.dataset.rhwpActualSurfacePixels) > 0
      && Boolean(canvas.dataset.rhwpSurfaceCacheLookupKey));
}

/** Preserve the already rendered first viewport while the normal renderer
 * prepares exact font metrics and replaces its internal surfaces. No image
 * readback is used, so a canvas containing cross-origin images is supported. */
export function preserveProgressivePreview(container: HTMLElement | null): (() => void) | null {
  if (!container) return null;
  const content = container.querySelector<HTMLElement>('#scroll-content');
  if (!content?.querySelector('canvas.document-page-canvas')) return null;
  const cover = document.createElement('div');
  cover.dataset.coworkProgressivePreview = 'true';
  cover.setAttribute('aria-hidden', 'true');
  Object.assign(cover.style, {
    position: 'absolute', left: '0', top: `${container.scrollTop}px`,
    width: `${container.clientWidth}px`, height: `${container.clientHeight}px`,
    zIndex: '150', pointerEvents: 'none', overflow: 'hidden', background: getComputedStyle(container).backgroundColor,
  });
  const box = container.getBoundingClientRect();
  try {
    const snapshot = content.cloneNode(true) as HTMLElement;
    const sources = [content, ...content.querySelectorAll<HTMLElement>('*')];
    const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement>('*')];
    const properties = ['position', 'display', 'left', 'top', 'width', 'height', 'transform', 'transform-origin',
      'z-index', 'background', 'box-shadow', 'border', 'opacity', 'overflow', 'clip-path', 'mix-blend-mode'];
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i], copy = copies[i];
      copy.removeAttribute('id');
      copy.classList.remove('document-page-canvas');
      const style = getComputedStyle(source);
      for (const property of properties) copy.style.setProperty(property, style.getPropertyValue(property));
      if (source instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement && source.width && source.height) {
        const context = copy.getContext('2d');
        if (!context) throw new Error('미리보기 화면을 보존하지 못했습니다.');
        context.globalCompositeOperation = 'copy';
        context.drawImage(source, 0, 0);
      }
    }
    const rect = content.getBoundingClientRect();
    Object.assign(snapshot.style, { position: 'absolute', margin: '0',
      left: `${rect.left - box.left - container.clientLeft}px`, top: `${rect.top - box.top - container.clientTop}px` });
    cover.appendChild(snapshot);
    container.appendChild(cover);
  } catch {
    cover.remove();
    return null; // The live preview still exists; a snapshot is optional.
  }
  return () => { cover.remove(); };
}

export async function loadDocumentProgressively<Info>(
  bridge: ProgressiveOpenBridge<Info>, bytes: Uint8Array, fileName: string, hooks: ProgressiveOpenHooks,
): Promise<Info> {
  const epoch = ++openEpoch;
  releasePreview();
  // A query switch is useful for an otherwise identical synchronous control.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('progressiveOpen') === '0') {
    return bridge.loadDocument(bytes, fileName);
  }
  const info = bridge.loadDocumentProgressively(bytes, fileName);
  const generation = bridge.documentGeneration;
  const current = () => epoch === openEpoch && bridge.documentGeneration === generation;
  const assertCurrent = () => { if (!current()) throw new ProgressiveOpenSupersededError(); };
  try {
    let state = readProgressiveOpenState(bridge.progressiveOpenState());
    if (!state || state.state === 'complete') { bridge.commitProgressiveOpen(generation); return info; }
    if (!state.pageCount) {
      bridge.flushProgressiveOpen();
      bridge.commitProgressiveOpen(generation);
      return bridge.getDocumentInfo();
    }
    await hooks.preview();
    assertCurrent();
    const paintDeadline = performance.now() + 2500;
    while (hooks.previewReady && !hooks.previewReady()) {
      if (performance.now() >= paintDeadline) throw new Error('첫 쪽 미리보기를 준비하지 못했습니다.');
      await yieldProgressiveOpen();
      assertCurrent();
    }
    // Do not report preview-ready before the first real document canvas has
    // reached a browser paint opportunity.
    await yieldProgressiveOpen();
    await yieldProgressiveOpen();
    assertCurrent();
    const release = hooks.preservePreview?.();
    if (hooks.preservePreview && !release) throw new Error('첫 쪽 미리보기를 보존하지 못했습니다.');
    preview = { epoch, generation, release: release || (() => {}) };
    hooks.progress(state);
    notify('cowork-document-preview', { pages: Math.min(2, state.pageCount), documentGeneration: generation, complete: false });
    let stalled = 0;
    while (state.state === 'pending') {
      await yieldProgressiveOpen();
      assertCurrent();
      const deadline = performance.now() + 8;
      let steps = 0;
      do {
        const next = readProgressiveOpenState(bridge.stepProgressiveOpen(16));
        if (!next) throw new Error('문서 이어 읽기를 사용할 수 없습니다.');
        if (next.processedParagraphs < state.processedParagraphs) throw new Error('문서 이어 읽기 순서가 올바르지 않습니다.');
        stalled = next.state === 'pending' && next.processedParagraphs === state.processedParagraphs ? stalled + 1 : 0;
        if (stalled > 1) throw new Error('문서 이어 읽기가 진행되지 않습니다.');
        state = next;
        steps++;
      // 짧은 문단이 많은 문서도 128문단마다 한 프레임을 무조건 기다리지 않는다.
      // 실제 CPU 8ms 예산을 우선하고, 저해상도 시계에서도 512문단에서 양보한다.
      } while (state.state === 'pending' && steps < 32 && performance.now() < deadline);
      hooks.progress(state);
    }
    bridge.commitProgressiveOpen(generation);
    return bridge.getDocumentInfo();
  } catch (error) {
    if (current()) {
      // A preview/render failure must not leave a partially paginated document
      // available to the old editor commands. Flush through the normal engine.
      try {
        bridge.flushProgressiveOpen();
        bridge.commitProgressiveOpen(generation);
        releasePreview();
        if (!(error instanceof ProgressiveOpenSupersededError)) return bridge.getDocumentInfo();
      } catch {
        releasePreview();
        if (bridge.rollbackProgressiveOpen(generation)) hooks.rollback?.();
      }
    } else if (preview?.epoch === epoch) {
      // A different open or create-new operation may bypass this coordinator.
      // It must not inherit the old read-only viewport cover.
      releasePreview();
    }
    throw error;
  }
}

/** Final page count is published only after normal font metrics, validation,
 * canvas initialization and edit activation have completed. */
export async function finishProgressiveOpen(bridge: { documentGeneration: number; pageCount: number }): Promise<void> {
  const captured = preview;
  if (!captured || captured.generation !== bridge.documentGeneration) return;
  await yieldProgressiveOpen();
  if (preview !== captured || captured.epoch !== openEpoch || captured.generation !== bridge.documentGeneration) return;
  releasePreview();
  notify('cowork-document-pagination', { pageCount: bridge.pageCount, documentGeneration: bridge.documentGeneration, complete: true });
}
