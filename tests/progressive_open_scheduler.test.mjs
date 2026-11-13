import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../studio/performance/progressive-open.ts', import.meta.url), 'utf8');
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
let sequence = 0;
const fresh = () => import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// ${++sequence}`).toString('base64')}`);

async function withBrowser(run) {
  const keys = ['window', 'location', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const messages = [], events = [];
  let frames = 0;
  Object.assign(globalThis, {
    window: { parent: { postMessage: (message, origin) => messages.push({ message, origin }) },
      location: { origin: 'http://localhost' }, dispatchEvent: event => events.push(event.type) },
    location: { search: '' },
    requestAnimationFrame: callback => { frames++; return setImmediate(() => callback(frames)); },
    cancelAnimationFrame: id => clearImmediate(id),
  });
  try { await run(await fresh(), { messages, events, frames: () => frames }); }
  finally {
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else delete globalThis[key];
    }
  }
}

function bridge({ total = 66, complete = false, old = false } = {}) {
  const state = { state: complete ? 'complete' : 'pending', pageCount: complete ? 33 : 2,
    processedParagraphs: complete ? total : 4, totalParagraphs: total };
  return {
    documentGeneration: 7, steps: [], flushes: 0, ordinary: 0, commits:0, rollbacks:0,
    get pageCount() { return state.pageCount; },
    state,
    loadDocument() { this.ordinary++; state.state = 'complete'; state.pageCount = 33; return this.getDocumentInfo(); },
    loadDocumentProgressively() { return this.getDocumentInfo(); },
    getDocumentInfo() { return { pageCount: state.pageCount }; },
    progressiveOpenState() { return old ? null : JSON.stringify(state); },
    stepProgressiveOpen(budget) {
      this.steps.push(budget);
      state.processedParagraphs = Math.min(total, state.processedParagraphs + budget);
      state.pageCount = Math.ceil(state.processedParagraphs / 2);
      if (state.processedParagraphs === total) state.state = 'complete';
      return JSON.stringify(state);
    },
    flushProgressiveOpen() {
      this.flushes++;state.state = 'complete';state.processedParagraphs = total;state.pageCount = 33;
      return JSON.stringify(state);
    },
    commitProgressiveOpen(generation) { assert.equal(generation,this.documentGeneration);this.commits++;return true; },
    rollbackProgressiveOpen(generation) { assert.equal(generation,this.documentGeneration);this.rollbacks++;this.documentGeneration++;return true; },
  };
}

test('first preview yields real tasks, reports provisional count and keeps full initialization as edit barrier', async () => withBrowser(async (api, browser) => {
  const doc = bridge();let shown = 0, released = 0;
  const states = [];
  const info = await api.loadDocumentProgressively(doc, new Uint8Array([1]), 'sample.hwpx', {
    preview: async () => { shown++; assert.equal(doc.steps.length, 0); },
    preservePreview: () => () => { released++; },
    progress: state => states.push({ ...state }),
  });
  assert.equal(shown, 1);assert.deepEqual(doc.steps, [16,16,16,16]);
  assert.ok(browser.frames() >= 3, 'two preview paint opportunities and bounded continuation tasks');
  assert.equal(states[0].state, 'pending');assert.equal(info.pageCount, 33);
  assert.equal(doc.commits,1);assert.equal(doc.rollbacks,0);
  assert.equal(released, 0, 'preview survives until existing final initialization completes');
  assert.equal(browser.messages.length, 1);assert.equal(browser.messages[0].message.type, 'cowork-document-preview');
  assert.equal(browser.messages[0].message.complete, false);
  await api.finishProgressiveOpen(doc);
  assert.equal(released, 1);
  assert.deepEqual(browser.messages.at(-1).message, { type:'cowork-document-pagination',pageCount:33,documentGeneration:7,complete:true });
}));

test('small completed documents, old engines and explicit synchronous controls avoid a provisional preview', async () => withBrowser(async (api, browser) => {
  const hooks = { preview: async () => assert.fail('no preview'), progress: () => assert.fail('no progress') };
  const small = bridge({ complete:true });
  assert.equal((await api.loadDocumentProgressively(small,new Uint8Array(), 'small.hwpx', hooks)).pageCount,33);
  assert.equal(small.commits,1);
  const legacy = bridge({ old:true, complete:true });
  await api.loadDocumentProgressively(legacy,new Uint8Array(), 'legacy.hwpx', hooks);
  location.search = '?progressiveOpen=0';const control = bridge();
  await api.loadDocumentProgressively(control,new Uint8Array(), 'control.hwpx', hooks);
  assert.equal(control.ordinary,1);assert.equal(browser.messages.length,0);
}));

test('preview failure, malformed engine status and stalled jobs flush before normal initialization', async () => withBrowser(async (api) => {
  const failed = bridge();
  assert.equal((await api.loadDocumentProgressively(failed,new Uint8Array(), 'failed.hwpx', {
    preview: async () => { throw Error('renderer unavailable'); },progress: () => {},
  })).pageCount,33);assert.equal(failed.flushes,1);
  const malformed = bridge();malformed.progressiveOpenState = () => '{';
  await api.loadDocumentProgressively(malformed,new Uint8Array(), 'bad.hwpx', {preview:async()=>{},progress:()=>{}});
  assert.equal(malformed.flushes,1);
  const stalled = bridge();stalled.stepProgressiveOpen = () => JSON.stringify(stalled.state);
  await api.loadDocumentProgressively(stalled,new Uint8Array(), 'stalled.hwpx', {preview:async()=>{},progress:()=>{}});
  assert.equal(stalled.flushes,1);
}));

test('failed continuation and failed full flush roll back the previous document before reporting failure', async () => withBrowser(async api => {
  const doc=bridge();let rollbackNotified=0;
  doc.stepProgressiveOpen=()=>{throw Error('invalid continuation');};
  doc.flushProgressiveOpen=()=>{throw Error('failed recovery');};
  await assert.rejects(api.loadDocumentProgressively(doc,new Uint8Array(), 'corrupt.hwpx', {
    preview:async()=>{},progress:()=>{},rollback:()=>{rollbackNotified++;},
  }),/invalid continuation/);
  assert.equal(doc.rollbacks,1);assert.equal(doc.commits,0);assert.equal(rollbackNotified,1);
}));

test('snapshot capture follows render evidence and two animation opportunities', async () => withBrowser(async (api,browser) => {
  const doc=bridge();let checks=0,captureFrame=0;
  await api.loadDocumentProgressively(doc,new Uint8Array(), 'paint.hwpx', {
    preview:async()=>{},previewReady:()=>++checks>2,
    preservePreview:()=>{captureFrame=browser.frames();return ()=>{};},progress:()=>{},
  });
  assert.ok(checks>=3);assert.ok(captureFrame>=4,'render readiness plus two paint opportunities before capture');
  await api.finishProgressiveOpen(doc);
}));

test('switching document generation cancels a stale job without flushing or publishing to the new document', async () => withBrowser(async (api, browser) => {
  const doc=bridge();
  await assert.rejects(api.loadDocumentProgressively(doc,new Uint8Array(), 'replaced.hwpx', {
    preview:async()=>{doc.documentGeneration++;},progress:()=>assert.fail('stale progress'),
  }), api.ProgressiveOpenSupersededError);
  assert.equal(doc.flushes,0);assert.equal(doc.steps.length,0);assert.equal(browser.messages.length,0);
}));

test('a later generation switch releases only the old preview cover', async () => withBrowser(async (api) => {
  const doc=bridge();let released=0;
  await assert.rejects(api.loadDocumentProgressively(doc,new Uint8Array(), 'new-document.hwpx', {
    preview:async()=>{},preservePreview:()=>()=>{released++;},
    progress:()=>{doc.documentGeneration++;},
  }),api.ProgressiveOpenSupersededError);
  assert.equal(released,1);assert.equal(doc.flushes,0);
}));

test('state validation rejects invalid count/paragraph envelopes', async () => {
  const api=await fresh();
  for(const state of [{state:'pending',pageCount:-1,processedParagraphs:0,totalParagraphs:1},
    {state:'pending',pageCount:2,processedParagraphs:5,totalParagraphs:4},
    {state:'unknown',pageCount:1,processedParagraphs:1,totalParagraphs:1}]) {
    assert.throws(()=>api.readProgressiveOpenState(JSON.stringify(state)));
  }
});

test('progress updates always paint entry and coalesce only labels within the recent 80ms paint window', async () => {
  const {OpenProgressPaintGate}=await fresh();let time=0,paints=0;
  const gate=new OpenProgressPaintGate(async()=>{paints++;},80,()=>time);
  assert.equal(await gate.update(0),true);assert.equal(paints,1);
  time=20;assert.equal(await gate.update(25),false);
  time=79;assert.equal(await gate.update(55),false);assert.equal(paints,1);
  time=80;assert.equal(await gate.update(75),true);assert.equal(paints,2);
  assert.equal(await gate.update(0),true);assert.equal(paints,3,'new open always gets its initial spinner frame');
  time=150;gate.markPaint();time=210;
  assert.equal(await gate.update(90),false,'a real preview/chunk paint also satisfies the progress display');
  time=230;assert.equal(await gate.update(96),true);assert.equal(paints,4);
});

test('failed progress paint does not mark an unpainted frame as ready', async () => {
  const {OpenProgressPaintGate}=await fresh();let calls=0;
  const gate=new OpenProgressPaintGate(async()=>{if(++calls===1)throw Error('paint rejected');},80,()=>0);
  await assert.rejects(gate.update(0),/paint rejected/);
  assert.equal(await gate.update(25),true);assert.equal(calls,2);
});
