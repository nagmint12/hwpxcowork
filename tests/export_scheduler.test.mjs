import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const sourceUrl = new URL('../studio/performance/export-hwpx.ts', import.meta.url);
const source = fs.readFileSync(sourceUrl, 'utf8').replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
let moduleId = 0;
const fresh = () => import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// ${++moduleId}`).toString('base64')}`);

class FakeWorker {
  static latest;
  static notify;
  messages = [];
  terminated = false;
  constructor() { FakeWorker.latest = this; }
  postMessage(message, transfer) {
    this.messages.push(structuredClone(message, { transfer }));
    if (message.kind === 'compress') FakeWorker.notify?.();
  }
  finish() {
    const message = this.messages.shift();
    this.onmessage({ data: message });
  }
  terminate() { this.terminated = true; }
}

function nextSnapshot() { return new Promise(resolve => { FakeWorker.notify = resolve; }); }

async function withWorker(fn) {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try { await fn(await fresh()); }
  finally { globalThis.Worker = previous; FakeWorker.notify = undefined; }
}

test('export scheduler bounds live snapshots and preserves each captured document', async () => withWorker(async ({ exportHwpxOffThread }) => {
  let text = 1;
  let captures = 0;
  const exporter = {
    exportHwpxUncompressed() { captures++; return new Uint8Array([text]); },
    exportHwpx() { assert.fail('normal export is not used when Worker succeeds'); },
  };
  const firstCaptured = nextSnapshot();
  const first = exportHwpxOffThread(exporter);
  assert.equal(captures, 0, 'the initiating UI event returns before capturing any package');
  await firstCaptured;
  text = 2;
  const secondCaptured = nextSnapshot();
  const second = exportHwpxOffThread(exporter);
  assert.equal(captures, 1, 'second caller does not allocate a queued document');
  FakeWorker.latest.finish();
  assert.deepEqual(await first, new Uint8Array([1]));
  await secondCaptured;
  assert.equal(captures, 2);
  text = 3;
  FakeWorker.latest.finish();
  assert.deepEqual(await second, new Uint8Array([2]), 'continued typing cannot mutate the snapshot');
}));

test('Worker failure retries with normal export and disables the failed Worker', async () => withWorker(async ({ exportHwpxOffThread }) => {
  let normalExports = 0;
  const exporter = {
    exportHwpxUncompressed: () => new Uint8Array([1]),
    exportHwpx: () => new Uint8Array([++normalExports]),
  };
  const captured = nextSnapshot();
  const first = exportHwpxOffThread(exporter);
  await captured;
  FakeWorker.latest.onerror(new Error('blocked by browser'));
  assert.deepEqual(await first, new Uint8Array([1]));
  assert.equal(FakeWorker.latest.terminated, true);
  assert.deepEqual(await exportHwpxOffThread(exporter), new Uint8Array([2]));
  assert.equal(normalExports, 2);
}));

test('unsupported engines keep the normal export path', async () => withWorker(async ({ exportHwpxOffThread }) => {
  assert.deepEqual(await exportHwpxOffThread({ exportHwpx: () => new Uint8Array([5]) }), new Uint8Array([5]));
  assert.deepEqual(await exportHwpxOffThread({ exportHwpxUncompressed: () => null, exportHwpx: () => new Uint8Array([6]) }), new Uint8Array([6]));
}));

test('Worker unavailable browsers keep the normal export path', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined;
  try {
    const { exportHwpxOffThread } = await fresh();
    assert.deepEqual(await exportHwpxOffThread({ exportHwpxUncompressed() { assert.fail('do not capture'); }, exportHwpx: () => new Uint8Array([7]) }), new Uint8Array([7]));
  } finally { globalThis.Worker = previous; }
});

test('document opening primes a copied ZIP and each document switch advances its generation', async () => withWorker(async ({ exportHwpxOffThread, primeHwpxCompression }) => {
  const original = new Uint8Array([3, 4, 5]);
  primeHwpxCompression(original);
  assert.deepEqual(original, new Uint8Array([3, 4, 5]), 'opening bytes remain owned by the caller');
  const primed = FakeWorker.latest.messages.shift();
  assert.equal(primed.kind, 'prime');
  assert.deepEqual(primed.bytes, original);
  original.fill(9);
  assert.deepEqual(primed.bytes, new Uint8Array([3, 4, 5]));
  const captured = nextSnapshot();
  const save = exportHwpxOffThread({ exportHwpxUncompressed: () => new Uint8Array([7]), exportHwpx: () => assert.fail() });
  await captured;
  assert.equal(FakeWorker.latest.messages[0].generation, primed.generation);
  FakeWorker.latest.finish();
  assert.deepEqual(await save, new Uint8Array([7]));
  primeHwpxCompression();
  const reset = FakeWorker.latest.messages.shift();
  assert.equal(reset.kind, 'reset');
  assert.equal(reset.generation, primed.generation + 1);
  assert.equal(reset.bytes, undefined);
}));

test('a document switch during cooperative preparation cannot export the new document under the old revision', async () => withWorker(async ({ exportHwpxOffThread }) => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const exporter = {
    documentGeneration: 1,
    async prepareAsyncExport() { started.resolve(); await finish.promise; },
    exportHwpxUncompressed: () => assert.fail('captured a different document'),
    exportHwpx: () => assert.fail('retried on a different document'),
  };
  const save = exportHwpxOffThread(exporter);
  await started.promise;
  exporter.documentGeneration++;
  finish.resolve();
  await assert.rejects(save, /문서가 바뀌었습니다/);
}));
