import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { coworkBuildPlugins, patchesForStudio } from '../studio/build/patches.mjs';
import { STANDALONE_EDITOR_PATCHES } from '../studio/build/standalone-editor-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const studio = path.join(root, 'vendor/rhwp/rhwp-studio');
const patches = patchesForStudio(studio, process.env.STUDIO_TEST_PROFILE === 'standalone' ? STANDALONE_EDITOR_PATCHES : undefined);

function sourceApi(file, names, extra = {}) {
  const filename = path.join(studio, file);
  const source = fs.readFileSync(filename, 'utf8');
  const patched = coworkBuildPlugins({ studioSrc: studio, patches })[0].transform(source, filename)?.code ?? source;
  const compiled = stripTypeScriptTypes(patched, { mode: 'transform' })
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export /gm, '')
    .replaceAll('import.meta', '({env:{DEV:false},url:"file:///studio-test.mjs"})');
  return vm.runInNewContext(`${compiled}\n;({${names}});`, { console, TextEncoder, setTimeout, clearTimeout, ...extra }, { filename });
}

// [hwpx-cowork] 2026-11-10: 0.9.0 wasm-bridge.ts 는 모듈 맨 위에서 가져온 CanvasFontResolutionScope 를 만든다.
// sourceApi 는 import 를 지우므로 실제 원본 클래스를 같이 넘긴다(0.8.7 원본에는 이 파일이 없다).
function bridgeModuleScope() {
  return fs.existsSync(path.join(studio, 'src/core/canvas-font-resolution-scope.ts'))
    ? sourceApi('src/core/canvas-font-resolution-scope.ts', 'CanvasFontResolutionScope') : {};
}

// 0.9.0 WasmBridge 의 비공개 필드(MetafileFontSession·NativePuaFontSession)는 Object.create 로 만든 시험 다리에 없다.
// 시험 문서는 메타파일·PUA 글꼴 API 가 없으므로, 실제 세션도 이때 곧바로 true(할 일 없음)를 돌려준다 — 그 동작을 그대로 둔다.
function bridgeFontSessions(bridge) {
  bridge.metafileFonts = { prepare: async () => true };
  bridge.nativePuaFonts = { records: () => [], prepare: async () => true, clear() {} };
  return bridge;
}

function metricSession() {
  const provider = sourceApi('src/core/supplemental-text-metrics.ts', 'CanvasSupplementalMetricProvider');
  const { CanvasMetricSession } = sourceApi('src/core/canvas-metric-session.ts', 'CanvasMetricSession', provider);
  return new CanvasMetricSession();
}

const request = (key, cluster) => ({ key, cluster, font: '10px sans-serif' });
const target = JSON.stringify({ sec: 0, para: 3 });
const generation = { document: 1, fonts: 2 };
const ready = () => Promise.resolve();

function documentFixture(scoped = true) {
  const calls = [];
  const registered = [];
  let revision = 0;
  const doc = {
    collectCanvasMetricRequests(document, fonts) {
      calls.push({ kind: 'full', document, fonts });
      return JSON.stringify({ revision: ++revision, requests: [request('A', 'A')] });
    },
    registerCanvasMetricReplies(document, fonts, revision, json) {
      registered.push({ document, fonts, revision, replies: JSON.parse(json) });
      return true;
    },
    selectCanvasMetrics() { return false; },
  };
  if (scoped) doc.collectCanvasMetricRequestsForParagraph = (document, fonts, targetJson) => {
    calls.push({ kind: 'scoped', document, fonts, target: JSON.parse(targetJson) });
    return JSON.stringify({ revision: ++revision, requests: [request('A', 'A'), request('omega', 'Ω')] });
  };
  let measurements = 0;
  const context = { font: '', measureText() { measurements++; return { width: 7 }; } };
  return { doc, calls, registered, createContext: () => context, measurements: () => measurements };
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function bridgeFixture(hostFonts = false) {
  const f = documentFixture();
  let fontsReady = Promise.resolve();
  let hostReady = Promise.resolve();
  const { WasmBridge } = sourceApi('src/core/wasm-bridge.ts', 'WasmBridge', {
    ...bridgeModuleScope(),
    hasHostFontProvider: () => hostFonts,
    prepareHostFontCatalog: () => hostReady,
    getHostFontState: () => ({ generation: 1 }),
    document: {
      fonts: { get ready() { return fontsReady; } },
      createElement: () => ({ getContext: f.createContext }),
    },
  });
  const bridge = bridgeFontSessions(Object.create(WasmBridge.prototype));
  bridge.doc = f.doc;
  bridge._documentGeneration = 1;
  bridge.canvasFontGeneration = 2;
  bridge.canvasMetricDocument = () => f.doc;
  bridge.withPortableMetrics = () => [];
  bridge.hostCanvasFonts = { reset() {}, prepare: async () => {}, measurementContext: context => context };
  bridge.canvasMetrics = metricSession();
  return { ...f, bridge, setFontsReady: promise => { fontsReady = promise; }, setHostReady: promise => { hostReady = promise; } };
}

test('metric session uses full preparation initially and scoped preparation for a known text target', async () => {
  const session = metricSession();
  const f = documentFixture();
  assert.equal(await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext), true);
  assert.equal(f.calls[0].kind, 'full');
  assert.equal(f.measurements(), 1);
  assert.equal(await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target), true);
  assert.deepEqual(f.calls[1], { kind: 'scoped', document: 1, fonts: 2, target: { sec: 0, para: 3 } });
  assert.equal(f.measurements(), 2, 'previous glyph remains cached; the new glyph is measured immediately');
  assert.deepEqual(f.registered.at(-1).replies.map(reply => reply.cluster), ['A', 'Ω']);
  assert.equal(f.registered.at(-1).revision, 2);
});

test('old WASM and unscoped edits retain full collection; non-Canvas2D skips measurement', async () => {
  const session = metricSession();
  const f = documentFixture(false);
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target);
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext);
  assert.deepEqual(f.calls.map(call => call.kind), ['full', 'full']);
  await session.prepare(f.doc, generation, 'svg', () => true, ready, f.createContext, target);
  assert.equal(f.calls.length, 2);
});

test('scoped requests preserve epoch and current-document cancellation', async () => {
  const session = metricSession();
  const f = documentFixture();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = session.prepare(f.doc, generation, 'canvas2d', () => true, () => blocked, f.createContext, target);
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target);
  release();
  assert.equal(await first, false);
  assert.equal(f.calls.length, 1, 'superseded preparation never collects or publishes');
  assert.equal(f.registered.length, 1);
  await session.prepare(f.doc, generation, 'canvas2d', () => false, ready, f.createContext, target);
  assert.equal(f.calls.length, 1, 'document replacement prevents collection');
});

test('font generation changes remeasure glyphs even when a paragraph hint is present', async () => {
  const session = metricSession();
  const f = documentFixture();
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target);
  assert.equal(f.measurements(), 1, 'new generation starts with a full collection');
  await session.prepare(f.doc, { ...generation, fonts: 3 }, 'canvas2d', () => true, ready, f.createContext, target);
  assert.equal(f.measurements(), 2);
  assert.deepEqual(f.calls.map(call => call.kind), ['full', 'full']);
  assert.equal(f.registered.at(-1).fonts, 3);
});

test('view scopes body and nested cell text targets while structural/custom/invalid targets use full collection', () => {
  const { coworkCanvasMetricTarget } = sourceApi('src/view/canvas-view.ts', 'coworkCanvasMetricTarget');
  const body = { sectionIndex: 1, paragraphIndex: 3, charOffset: 8 };
  const payload = textOnlyPosition => ({ pageIndex: 0, reason: 'text-edit', textOnlyPosition });
  assert.equal(coworkCanvasMetricTarget(payload(body)), JSON.stringify({ sec: 1, para: 3 }));
  const nested = { ...body, parentParaIndex: 5, cellPath: [{ controlIndex: 1, cellIndex: 2, cellParaIndex: 3 }, { controlIndex: 4, cellIndex: 5, cellParaIndex: 6 }] };
  assert.deepEqual(JSON.parse(coworkCanvasMetricTarget(payload(nested))), { sec: 1, para: 5, cellPath: nested.cellPath });
  const flat = { ...body, parentParaIndex: 5, controlIndex: 4, cellIndex: 5, cellParaIndex: 6 };
  assert.deepEqual(JSON.parse(coworkCanvasMetricTarget(payload(flat))), { sec: 1, para: 5, cellPath: [nested.cellPath[1]] });
  for (const invalid of [undefined, {}, { ...payload(body), reason: 'structural' }, payload({ ...body, isTextBox: true }), payload({ ...body, sectionIndex: -1 }), payload({ ...body, parentParaIndex: null }), payload({ ...nested, cellPath: [{ controlIndex: 1, cellIndex: -1, cellParaIndex: 0 }] }), payload({ ...body, parentParaIndex: 0 })]) {
    assert.equal(coworkCanvasMetricTarget(invalid), undefined);
  }
});

test('view forwards scoped preparation but retains revision and visible page redraw checks', async () => {
  const { CanvasView } = sourceApi('src/view/canvas-view.ts', 'CanvasView');
  const fixture = Object.create(CanvasView.prototype);
  const selected = { selection: {} };
  const calls = [];
  fixture.selectMutationRevision = async scope => { calls.push(['select', scope]); return selected; };
  fixture.rendererSession = { isCurrent: () => true };
  fixture.refreshPages = () => calls.push(['full-redraw']);
  fixture.refreshInvalidatedPage = payload => calls.push(['page-redraw', payload.pageIndex]);
  const payload = { pageIndex: 2, reason: 'text-edit', textOnlyPosition: { sectionIndex: 0, paragraphIndex: 3 } };
  await fixture.refreshInvalidatedPageForMutation(payload);
  assert.deepEqual(calls, [['select', target], ['page-redraw', 2]]);
  calls.length = 0;
  selected.backendChanged = true;
  await fixture.refreshInvalidatedPageForMutation({ pageIndex: 2, reason: 'custom' });
  assert.deepEqual(calls, [['select', undefined], ['full-redraw']]);
  calls.length = 0;
  fixture.rendererSession.isCurrent = () => false;
  await fixture.refreshInvalidatedPageForMutation(payload);
  assert.deepEqual(calls, [['select', target]]);
});

test('mutation revision preserves paragraph scope for both auto and explicit Canvas2D renderers', async () => {
  const { CanvasView } = sourceApi('src/view/canvas-view.ts', 'CanvasView');
  const fixture = Object.create(CanvasView.prototype);
  const selection = { backend: 'canvas2d' };
  const calls = [];
  fixture.rendererSelectionEpoch = 0;
  fixture.rendererSession = { pinAutoMutationRevision: () => selection, isCurrent: candidate => candidate === selection };
  fixture.wasm = { reserveCanvasMetricTarget: scope => scope, prepareCanvasMetrics(backend, current, scope) { calls.push({ backend, current: current(), scope }); return false; } };
  fixture.applyRendererSelection = () => false;
  fixture.scheduleAutoRendererReselection = () => {};
  fixture.selectNextDocumentRevision = (...args) => { calls.push(args); return null; };
  assert.ok(await fixture.selectMutationRevision(target));
  assert.deepEqual(calls[0], { backend: 'canvas2d', current: true, scope: target });
  fixture.rendererSession.pinAutoMutationRevision = () => null;
  assert.equal(await fixture.selectMutationRevision(target), null);
  assert.deepEqual(calls.at(-1), [true, target]);
});

test('bridge forwards paragraph scope under the original document and font generation guards', async () => {
  const { WasmBridge } = sourceApi('src/core/wasm-bridge.ts', 'WasmBridge', {
    ...bridgeModuleScope(),
    hasHostFontProvider: () => false,
    document: { fonts: { ready: Promise.resolve() }, createElement: () => ({ getContext: () => ({ font: '', measureText: () => ({ width: 1 }) }) }) },
  });
  const fixture = bridgeFontSessions(Object.create(WasmBridge.prototype));
  fixture.doc = {};
  fixture._documentGeneration = 7;
  fixture.canvasFontGeneration = 9;
  fixture.canvasMetricDocument = () => ({ owner: 'metric-doc' });
  fixture.hostCanvasFonts = { reset() {}, measurementContext: context => context };
  let captured;
  fixture.canvasMetrics = { completedPreparationSerial: 0, lastError: null, prepare(...args) { captured = args; this.completedPreparationSerial++; return true; } };
  await fixture.prepareCanvasMetrics('canvas2d', () => true);
  assert.equal(await fixture.prepareCanvasMetrics('canvas2d', () => true, target), true);
  assert.equal(JSON.stringify(captured[1]), JSON.stringify({ document: 7, fonts: 9 }));
  assert.equal(captured[6], target);
  assert.equal(captured[3](), true);
  assert.ok(captured[5]());
  fixture._documentGeneration = 8;
  assert.equal(captured[3](), false);
});

test('session preserves A-to-B and full-to-B work cancelled before fonts.ready; same target stays scoped', async () => {
  const targetB = JSON.stringify({ sec: 0, para: 4 });
  for (const [firstTarget, nextTarget, expected] of [[target, targetB, 'full'], [undefined, targetB, 'full'], [target, target, 'scoped']]) {
    const session = metricSession();
    const f = documentFixture();
    await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext);
    f.calls.length = 0;
    const blocked = gate();
    const first = session.prepare(f.doc, generation, 'canvas2d', () => true, () => blocked.promise, f.createContext, firstTarget);
    await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, nextTarget);
    blocked.release();
    assert.equal(await first, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].kind, expected);
    assert.equal(session.completedPreparationSerial, 2);
  }
});

test('explicit completion serial distinguishes unchanged success from stale and failed preparation', async t => {
  t.mock.method(console, 'warn', () => {});
  const session = metricSession();
  const f = documentFixture();
  f.doc.registerCanvasMetricReplies = () => false;
  assert.equal(await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext), false);
  assert.equal(session.completedPreparationSerial, 1, 'unchanged measurements still complete successfully');
  const collect = f.doc.collectCanvasMetricRequests;
  f.doc.collectCanvasMetricRequests = () => { throw new Error('source changed'); };
  assert.equal(await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext), false);
  assert.equal(session.completedPreparationSerial, 1, 'fallback failure cannot complete outstanding full work');
  f.doc.collectCanvasMetricRequests = collect;
  f.calls.length = 0;
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target);
  assert.equal(f.calls[0].kind, 'full');
  assert.equal(session.completedPreparationSerial, 2);
  await session.prepare(f.doc, generation, 'canvas2d', () => true, ready, f.createContext, target);
  assert.equal(f.calls[1].kind, 'scoped');
});

test('bridge reserves work before host font awaits and clears it only after explicit session completion', async () => {
  for (const firstTarget of [target, undefined]) {
    const f = bridgeFixture(true);
    await f.bridge.prepareCanvasMetrics('canvas2d', () => true);
    f.calls.length = 0;
    const blocked = gate();
    f.setHostReady(blocked.promise);
    let revision = 1;
    const first = f.bridge.prepareCanvasMetrics('canvas2d', () => revision === 1, firstTarget);
    revision = 2;
    const second = f.bridge.prepareCanvasMetrics('canvas2d', () => revision === 2, JSON.stringify({ sec: 0, para: 4 }));
    blocked.release();
    assert.equal(await first, false);
    await second;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].kind, 'full');
    assert.equal(f.bridge.coworkMetricBridgeWork.pending, false);
    await f.bridge.prepareCanvasMetrics('canvas2d', () => true, target);
    assert.equal(f.calls.at(-1).kind, 'scoped');
  }
});

test('explicit Canvas2D view reserves direct-full/A-to-B revisions before renderer resolution awaits', async () => {
  const { CanvasView } = sourceApi('src/view/canvas-view.ts', 'CanvasView');
  for (const [firstTarget, nextTarget, expected] of [[undefined, target, 'full'], [target, JSON.stringify({ sec: 0, para: 4 }), 'full'], [target, target, 'scoped']]) {
    const f = bridgeFixture();
    await f.bridge.prepareCanvasMetrics('canvas2d', () => true);
    f.calls.length = 0;
    const view = Object.create(CanvasView.prototype);
    const blocked = gate();
    let revision = 0;
    view.wasm = f.bridge;
    view.rendererSelectionEpoch = 0;
    view.viewportManager = { cancelPendingZoomRaster: () => false };
    view.rendererSession = {
      pinAutoMutationRevision: () => null,
      invalidateDocument() { revision++; },
      async resolve() { const selected = { backend: 'canvas2d', revision }; await blocked.promise; return selected; },
      isCurrent: selection => selection.revision === revision,
    };
    view.applyRendererSelection = () => false;
    const first = view.selectNextDocumentRevision(true, firstTarget);
    await Promise.resolve(); // The first call now waits inside rendererSession.resolve.
    const second = view.selectMutationRevision(nextTarget);
    blocked.release();
    assert.equal(await first, null);
    assert.ok(await second);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].kind, expected);
  }
});
