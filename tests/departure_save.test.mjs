import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { HwpxDoc } from '../engine/doc.js';
import { DepartureSaves } from '../server/departure-saves.js';
import { installCollabRoutes } from '../server/routes/collab.js';
import { Service, ServiceError } from '../server/service.js';
import { Store } from '../server/store.js';
import { submitDeparture } from '../web/departure-transport.js';

const author = { name: 'receipt-a', role: 'admin' };
const other = { name: 'receipt-b', role: 'admin' };
const fixture = fs.readFileSync('tests/fixtures/hangul_trk_brk_base.hwpx');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const nextTask = () => new Promise(resolve => setImmediate(resolve));

async function variant(marker) {
  const zip = await JSZip.loadAsync(fixture);
  const part = 'Contents/section0.xml';
  const source = await zip.file(part).async('string');
  const edited = source.replace(/<hp:t>([^<]+)<\/hp:t>/, (_, text) => `<hp:t>${text}${marker}</hp:t>`);
  assert.notEqual(edited, source);
  zip.file(part, edited);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-departure-receipt-'));
  assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function setup(t, mode = 'review') {
  const temporaryRoot = temporary(t);
  const store = new Store(path.join(temporaryRoot, 'store'));
  const config = { dataDir: path.join(temporaryRoot, 'test-data'), configFile: path.join(temporaryRoot, 'config.json'),
    users: [author, other], ai: {}, documents: {} };
  const hub = { broadcast() {}, broadcastAll() {} };
  const service = new Service({ store, hub, config, ai: { enabled: false } });
  const id = store.create({ fileName: 'receipt-fixture.hwpx', bytes: fixture, by: author.name }).id;
  if (mode === 'live') await service.patchSettings(id, { editMode: 'realtime', track: 'final' }, author);
  const gate = deferred();
  t.after(() => gate.resolve());
  let started = 0;
  const routes = new Map();
  const register = method => (url, ...callbacks) => routes.set(`${method} ${url}`, callbacks.at(-1));
  const app = Object.fromEntries(['get', 'put', 'post', 'patch', 'delete'].map(verb => [verb, register(verb.toUpperCase())]));
  const { crs } = installCollabRoutes({ app, service, config, store, hub, wrap: handler => handler, auth() {}, raw() {},
    bodyBytes: req => req.body, trackOperation: async fn => { started++; await gate.promise; return fn(); } });
  const base = `/api/docs/${id}`;
  const putPath = `${base}/${mode === 'live' ? 'live?base=1&seq=10001' : 'drafts/mine?base=1&rev=0'}`;
  const journal = path.join(store.dataDir, 'departure-saves');
  const record = key => JSON.parse(fs.readFileSync(path.join(journal, `${key}.json`), 'utf8'));
  const spool = key => fs.readFileSync(path.join(journal, `${key}.hwpx`));
  async function dispatch(url, options = {}, user = author) {
    const parsed = new URL(url, 'http://in-process.invalid');
    const [, , , doc, kind, item, rest] = parsed.pathname.split('/');
    const method = options.method ?? 'GET';
    const route = kind === 'departure-saves' ? `/api/docs/:id/departure-saves/:key${rest ? '/file' : ''}`
      : `/api/docs/:id/${kind}${item ? `/${item}` : ''}`;
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `Missing in-process route ${method} ${route}`);
    const reply = { status: 200, headers: {}, data: undefined };
    const res = {
      setHeader(name, content) { reply.headers[name] = content; return this; },
      set(headers) { Object.assign(reply.headers, headers); return this; },
      status(code) { reply.status = code; return this; },
      json(data) { reply.data = data; return this; },
      send(data) { reply.data = data; return this; },
    };
    await handler({ params: { id: doc, key: item }, query: Object.fromEntries(parsed.searchParams), user, body: options.body }, res);
    return reply;
  }
  return { base, putPath, service, crs, store, id, journal, record, spool, dispatch, gate, started: () => started };
}

for (const mode of ['review', 'live']) {
  test(`actual ${mode} endpoint returns 202 over exact bytes before final application, then applies after editor departs`, async t => {
    const local = await setup(t, mode);
    const marker = mode === 'review' ? '접수검토판' : '접수실시간판';
    const bytes = await variant(marker);
    const received = deferred();
    const writes = [];
    const api = async (url, options) => {
      // Simulate losing the browser's status request when its editor/tab closes.
      if (mode === 'live' && options?.method !== 'PUT') return new Promise(() => {});
      const reply = await local.dispatch(url, options);
      if (options?.method === 'PUT') writes.push(reply);
      return reply.data;
    };
    let finalArrived = false;
    const result = submitDeparture(api, local.base, local.putPath, { method: 'PUT', raw: true, body: bytes }, received.resolve);
    void result.then(() => { finalArrived = true; }, () => {});
    const key = await Promise.race([received.promise, result.then(() => assert.fail('Missing 202 receipt'))]);
    assert.equal(writes[0].status, 202);
    assert.deepEqual(writes[0].data, { receipt: key });
    assert.equal(local.record(key).state, 'queued');
    assert.deepEqual(local.spool(key), bytes);
    assert.equal(finalArrived, false);
    assert.equal(local.record(key).owner, author.name);
    assert.equal('token' in local.record(key), false);
    await assert.rejects(local.dispatch(`${local.base}/departure-saves/${key}`, {}, other), { code: 'NO_RECEIPT', status: 404 });
    await assert.rejects(local.dispatch(`/api/docs/other-document/departure-saves/${key}`), { code: 'NO_RECEIPT', status: 404 });
    await assert.rejects(local.dispatch(`${local.base}/departure-saves/${key}/file`), { code: 'NO_RECOVERY_FILE', status: 404 });
    // A fresh in-process request can read the durable result after the original editor is gone.
    local.gate.resolve();
    const fetched = await local.dispatch(`${local.base}/departure-saves/${key}`);
    const final = mode === 'review' ? await result : fetched.data;
    if (mode === 'live') assert.equal(finalArrived, false);
    assert.deepEqual(fetched.data, final);
    assert.equal(local.record(key).state, 'saved');
    assert.equal(local.started(), 1);
    assert.equal(fs.existsSync(path.join(local.journal, `${key}.hwpx`)), false);
    if (mode === 'review') {
      assert.ok(final.cr && final.rev > 0);
      assert.deepEqual(local.store.readDraft(local.id, final.cr.cid), bytes);
    } else {
      assert.ok(local.service._meta(local.id).version > 1);
      assert.ok((await local.store.doc(local.id)).paragraphs().some(para => para.text.includes(marker)));
    }
  });
}

test('older accepted review revision cannot overwrite a later ordinary save; only its owner can recover its bytes', async t => {
  const local = await setup(t);
  const old = await variant('접수옛판');
  const current = await variant('새로저장된판');
  const key = randomUUID();
  const receiptPath = `${local.base}/departure-saves/${key}`;
  const put = `${local.putPath}&departure=${key}`;
  assert.equal((await local.dispatch(put, { method: 'PUT', body: old })).status, 202);
  assert.equal((await local.dispatch(put, { method: 'PUT', body: old })).status, 202);
  await assert.rejects(local.dispatch(put, { method: 'PUT', body: current }), { code: 'RECEIPT_CHANGED', status: 409 });
  await assert.rejects(local.dispatch(put, { method: 'PUT', body: old }, other), { code: 'NO_RECEIPT', status: 404 });
  const newest = (await local.dispatch(local.putPath, { method: 'PUT', body: current })).data;
  local.gate.resolve();
  await assert.rejects(local.dispatch(receiptPath), error => error.code === 'DRAFT_STALE' && error.extra.receipt === key);
  assert.equal(local.record(key).state, 'failed');
  assert.equal(local.started(), 1);
  assert.deepEqual(local.store.readDraft(local.id, newest.cr.cid), current);
  await assert.rejects(local.dispatch(`${receiptPath}/file`, {}, other), { code: 'NO_RECEIPT', status: 404 });
  const recovered = await local.dispatch(`${receiptPath}/file`);
  assert.equal(recovered.headers['Cache-Control'], 'no-store');
  assert.deepEqual(recovered.data, old);
});

test('lost response to submission waits for the same final receipt and never submits the same bytes twice', async t => {
  const local = await setup(t);
  const bytes = await variant('응답유실저장');
  const submitted = deferred();
  const requests = [];
  const sent = submitDeparture(async (url, options) => {
    requests.push(url);
    const reply = await local.dispatch(url, options);
    if (options?.method === 'PUT') {
      assert.equal(reply.status, 202);
      submitted.resolve(reply.data.receipt);
      throw new Error('simulated lost acknowledgement');
    }
    return reply.data;
  }, local.base, local.putPath, { method: 'PUT', body: bytes }, () => assert.fail('An unobserved response did not establish an acknowledgement'));
  const key = await submitted.promise;
  assert.deepEqual(local.spool(key), bytes);
  local.gate.resolve();
  const result = await sent;
  assert.ok(result.cr);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], `${local.base}/departure-saves/${key}`);
  assert.equal(local.started(), 1);
});

test('restart replays queued receipts in order, preserves interrupted bytes and does not replay an ambiguous save', async t => {
  const directory = temporary(t);
  const bytes = await variant('재시작접수');
  const order = [];
  const journal = new DepartureSaves({ directory, async apply(record, received) {
    order.push(record.key);
    assert.deepEqual(received, bytes);
    return { rev: order.length };
  } });
  const doc = 'test-doc';
  const owner = author.name;
  const [queuedA, queuedB, interrupted, finished, damaged] = Array.from({ length: 5 }, () => randomUUID());
  const digest = createHash('sha256').update(bytes).digest('hex');
  function seal(key, state, time) {
    journal.write({ key, doc, owner, state, mode: 'review', args: { base: '1', rev: '0' }, time, digest });
    fs.writeFileSync(journal.file(key, '.hwpx'), bytes);
  }
  const now = Date.now();
  seal(queuedB, 'queued', now + 1);
  seal(queuedA, 'queued', now);
  seal(interrupted, 'applying', now - 200);
  seal(finished, 'saved', now - 1000 * 60 * 60 * 48);
  seal(damaged, 'queued', now + 2);
  fs.writeFileSync(journal.file(damaged, '.hwpx'), await variant('재시작뒤훼손'));
  journal.resume();
  assert.deepEqual(await journal.result(queuedB, doc, owner), { rev: 2 });
  assert.deepEqual(await journal.result(queuedA, doc, owner), { rev: 1 });
  assert.deepEqual(order, [queuedA, queuedB]);
  await assert.rejects(journal.result(interrupted, doc, owner), error => error instanceof ServiceError
    && error.code === 'SAVE_INTERRUPTED' && error.extra.receipt === interrupted);
  await assert.rejects(journal.result(damaged, doc, owner), { code: 'RECEIPT_DAMAGED' });
  assert.deepEqual(fs.readFileSync(journal.file(interrupted, '.hwpx')), bytes);
  assert.equal(journal.record(finished), null);
  assert.equal(fs.existsSync(journal.file(finished, '.hwpx')), false);
  assert.ok((await HwpxDoc.load(bytes)).sections.length);
  await nextTask();
});
