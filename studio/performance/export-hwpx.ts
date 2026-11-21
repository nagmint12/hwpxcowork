type Exporter = {
  exportHwpx(): Uint8Array;
  exportHwpxUncompressed?(): Uint8Array | null;
  prepareAsyncExport?(pause?: () => Promise<void>): Promise<void>;
  beginHwpxSave?(): { step(units: number): boolean; finish(): Uint8Array; free(): void } | null;
  readonly documentGeneration?: number;
};
type Job = { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

let worker: Worker | null = null;
let disabled = false;
let nextId = 0;
const jobs = new Map<number, Job>();
let activeExport: Promise<Uint8Array> | null = null;
let documentGeneration = 0;

function stopWorker(error: Error): void {
  worker?.terminate();
  worker = null;
  disabled = true;
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
  jobs.clear();
}

function getWorker(): Worker | null {
  if (worker || disabled) return worker;
  if (typeof Worker === 'undefined') { disabled = true; return null; }
  try {
    worker = new Worker(new URL('./hwpx-zip.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; bytes?: Uint8Array; error?: string }>) => {
      const job = jobs.get(event.data.id);
      if (!job) return;
      jobs.delete(event.data.id);
      clearTimeout(job.timer);
      if (event.data.bytes) job.resolve(event.data.bytes);
      else job.reject(new Error(event.data.error || 'HWPX 압축 실패'));
    };
    worker.onerror = () => stopWorker(new Error('HWPX 저장 작업자를 시작하지 못했습니다'));
    worker.onmessageerror = () => stopWorker(new Error('HWPX 저장 결과를 읽지 못했습니다'));
  } catch { disabled = true; worker = null; }
  return worker;
}

/** Prepare unchanged compressed parts while fonts/view initialization proceeds.
 * Copy the input: opening hooks and the WASM engine retain their original bytes.
 * This operation deliberately does not delay the document-open promise. */
export function primeHwpxCompression(bytes?: Uint8Array): void {
  const generation = ++documentGeneration;
  const target = getWorker();
  if (!target) return;
  try {
    const snapshot = bytes?.slice();
    target.postMessage({ kind: snapshot ? 'prime' : 'reset', generation, bytes: snapshot }, snapshot ? [snapshot.buffer] : []);
  } catch { /* An unavailable cache must not interrupt document opening. */ }
}

function yieldForInput(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  });
}

async function captureSnapshot(exporter: Exporter, checkDocument: () => void): Promise<Uint8Array | null> {
  const save = exporter.beginHwpxSave?.();
  if (!save) return exporter.exportHwpxUncompressed?.() ?? null;
  try {
    while (true) {
      await yieldForInput();
      checkDocument();
      const start = performance.now();
      do { if (save.step(16)) {
        await yieldForInput();
        checkDocument();
        return save.finish();
      } } while (performance.now() - start < 4);
    }
  } finally { save.free(); }
}

async function captureAndCompress(exporter: Exporter, checkDocument: () => void): Promise<Uint8Array> {
  // Save/Back can return to the input loop before preparing package bytes.
  // The host revision fence keeps intervening edits dirty until acknowledged.
  await yieldForInput();
  checkDocument();
  await exporter.prepareAsyncExport?.(yieldForInput);
  checkDocument();
  if (typeof exporter.exportHwpxUncompressed !== 'function') return exporter.exportHwpx();
  const target = getWorker();
  if (!target) return exporter.exportHwpx();
  const start = performance.now();
  const bytes = await captureSnapshot(exporter, checkDocument);
  if (!bytes) return exporter.exportHwpx();
  performance.measure('cowork.export.snapshot', { start, end: performance.now() });
  const id = ++nextId;
  try {
    const result = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => stopWorker(new Error('HWPX 압축 시간 초과')), 120000);
      jobs.set(id, { resolve, reject, timer });
      try { target.postMessage({ id, kind: 'compress', generation: documentGeneration, bytes }, [bytes.buffer]); }
      catch (error) { jobs.delete(id); clearTimeout(timer); reject(error); }
    });
    performance.measure('cowork.export.total', { start, end: performance.now() });
    // PerformanceEntry buffers should remain bounded during long sessions.
    if (performance.getEntriesByName('cowork.export.snapshot').length > 20) {
      performance.clearMeasures('cowork.export.snapshot');
      performance.clearMeasures('cowork.export.total');
    }
    return result;
  } catch (error) {
    checkDocument();
    stopWorker(error instanceof Error ? error : new Error(String(error)));
    console.warn('[cowork] 저장 작업자 오류 — 기본 내보내기로 다시 시도합니다');
    return exporter.exportHwpx();
  }
}

export async function exportHwpxOffThread(exporter: Exporter): Promise<Uint8Array> {
  const owner = exporter.documentGeneration;
  const generation = documentGeneration;
  const checkDocument = () => {
    if (owner !== exporter.documentGeneration || generation !== documentGeneration) throw new Error('저장할 문서가 바뀌었습니다.');
  };
  // Do not queue large snapshots. Waiting callers capture only when the single
  // compressor is available. Their host changeSeq predates that later snapshot,
  // so any intervening input remains dirty and is saved again conservatively.
  while (activeExport) {
    try { await activeExport; } catch { /* the next caller can retry */ }
  }
  checkDocument();
  const run = captureAndCompress(exporter, checkDocument);
  activeExport = run;
  try { const bytes = await run; checkDocument(); return bytes; }
  finally { if (activeExport === run) activeExport = null; }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (!(event as PageTransitionEvent).persisted) stopWorker(new Error('편집기를 닫았습니다'));
  });
}
