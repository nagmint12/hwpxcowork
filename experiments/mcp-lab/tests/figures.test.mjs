import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../server/mcp.js';
import { createFigureTools } from '../figures.mjs';
import { createLabRuntime, repoRoot } from '../runtime.mjs';

const SVG = '<svg viewBox="0 0 200 100"><rect width="200" height="100" fill="#246"/></svg>';
const jsonResult = result => JSON.parse(result.content.find(block => block.type === 'text').text);
const code = result => result.content.find(block => block.type === 'text')?.text || '';
const checkError = (result, expected) => { assert.equal(result.isError, true); assert.match(code(result), new RegExp(expected)); };

function mockHarness(options = {}) {
  const state = { time: 1000, bytes: Buffer.from('original live document'), allowed: true,
    meta: { version: 7, requests: [{ rid: 3, attempt: 2, status: 'working', by: 'owner' }] } };
  const user = { name: 'owner', token: 'test-token', role: 'editor' }, calls = [];
  const service = {
    assertDocRead() { if (!state.allowed) throw Object.assign(new Error('No document access'), { code: 'NO_DOC' }); },
    _meta: () => state.meta, _attempt: request => request.attempt,
    store: { currentBytes: () => state.bytes },
  };
  const callBase = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (options.callBase) return options.callBase(name, args, state);
    if (name === 'preview_figure') return { content: [{ type: 'text', text: 'legacy instruction: repeat the SVG' }, { type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] };
    state.bytes = Buffer.from('document after successful proposal');
    return { content: [{ type: 'text', text: JSON.stringify({ pid: 42, status: 'pending', figure: { aid: 'a7', svg: args.svg } }) }] };
  };
  const module = createFigureTools({ service, user, callBase, now: () => state.time, ...options.cache });
  return { state, user, calls, module,
    preview: args => module.tools[0].handler({ doc_id: 'doc-a', svg: SVG, after_ref: 's0/p1', width_mm: 100, ...args }),
    propose: args => module.tools[1].handler({ doc_id: 'doc-a', ...args }),
  };
}

test('preview stores normalized source and returns only artifact metadata plus image; proposal reuses source', async () => {
  const h = mockHarness();
  const preview = await h.preview();
  assert.equal(preview.content.filter(block => block.type === 'image').length, 1);
  assert.doesNotMatch(code(preview), /<svg|repeat the SVG/);
  const artifact = jsonResult(preview);
  assert.match(artifact.artifact_id, /^fig_[A-Za-z0-9_-]{24}$/);
  const proposed = await h.propose({ artifact_id: artifact.artifact_id, caption: 'A result' });
  assert.deepEqual(jsonResult(proposed), { artifact_id: artifact.artifact_id, doc_id: 'doc-a', accepted: true,
    proposal_id: 42, status: 'pending', attachment_id: 'a7', duplicate: false });
  const [render, write] = h.calls;
  assert.equal(render.name, 'preview_figure'); assert.equal(write.name, 'propose_figure');
  assert.match(write.args.svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.equal(write.args.svg, render.args.svg);
  assert.equal(write.args.after_ref, 's0/p1'); assert.equal(write.args.width_mm, 100);
  assert.doesNotMatch(code(proposed), /<svg|"chart"/);
});

test('source, target, document, user session and request scope cannot be swapped after preview', async () => {
  const h = mockHarness();
  const artifact_id = jsonResult(await h.preview({ request_id: 3, expected_attempt: 2 })).artifact_id;
  const base = { artifact_id, request_id: 3, expected_attempt: 2 };
  checkError(await h.propose({ ...base, after_ref: 's0/p2' }), 'ARTIFACT_TARGET_CHANGED');
  checkError(await h.propose({ ...base, replace_ref: 's0/p1' }), 'ARTIFACT_TARGET_CHANGED');
  checkError(await h.propose({ ...base, width_mm: 120 }), 'ARTIFACT_TARGET_CHANGED');
  checkError(await h.propose({ ...base, svg: SVG }), 'BAD_ARGS');
  checkError(await h.propose({ ...base, doc_id: 'doc-b' }), 'ARTIFACT_SCOPE');
  checkError(await h.propose({ artifact_id }), 'ARTIFACT_SCOPE');
  h.user.token = 'changed-authentication';
  checkError(await h.propose(base), 'ARTIFACT_OWNER');
  assert.equal(h.calls.length, 1);
});

test('live document byte changes invalidate artifacts even when metadata version stays the same', async () => {
  const h = mockHarness(); const artifact_id = jsonResult(await h.preview()).artifact_id;
  h.state.bytes = Buffer.from('changed by a live editor');
  assert.equal(h.state.meta.version, 7);
  checkError(await h.propose({ artifact_id }), 'ARTIFACT_STALE');
  assert.equal(h.calls.length, 1);
});

test('document changes while rendering do not publish a reusable artifact', async () => {
  const h = mockHarness({ callBase: async (_name, _args, state) => {
    state.bytes = Buffer.from('changed while rendering');
    return { content: [{ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] };
  } });
  checkError(await h.preview(), 'ARTIFACT_STALE');
});

test('request attempts and closed requests are checked before rendering and writing', async () => {
  const h = mockHarness();
  checkError(await h.preview({ request_id: 3 }), 'BAD_ARGS');
  checkError(await h.preview({ request_id: 3, expected_attempt: 1 }), 'ATTEMPT_CHANGED');
  const artifact_id = jsonResult(await h.preview({ request_id: 3, expected_attempt: 2 })).artifact_id;
  h.state.meta.requests[0].attempt = 3;
  checkError(await h.propose({ artifact_id, request_id: 3, expected_attempt: 2 }), 'ATTEMPT_CHANGED');
  h.state.meta.requests[0].attempt = 2; h.state.meta.requests[0].status = 'cancelled';
  checkError(await h.propose({ artifact_id, request_id: 3, expected_attempt: 2 }), 'REQUEST_CLOSED');
  assert.equal(h.calls.length, 1);
});

test('TTL and bounded eviction reject missing artifacts instead of rendering unpreviewed source', async () => {
  const h = mockHarness({ cache: { ttlMs: 100, maxEntries: 2 } });
  const first = jsonResult(await h.preview()).artifact_id;
  await h.preview(); const newest = jsonResult(await h.preview()).artifact_id;
  checkError(await h.propose({ artifact_id: first }), 'ARTIFACT_NOT_FOUND');
  h.state.time += 101;
  checkError(await h.propose({ artifact_id: newest }), 'ARTIFACT_NOT_FOUND');
  h.module.close(); checkError(await h.preview(), 'ARTIFACT_CLOSED');
});

test('concurrent same-artifact retries write once; later retry returns receipt even after own write changed document', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = mockHarness({ callBase: async (name, _args, state) => {
    if (name === 'preview_figure') return { content: [{ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] };
    await gate; state.bytes = Buffer.from('own write');
    return { content: [{ type: 'text', text: '{"pid":42,"status":"pending"}' }] };
  } });
  const artifact_id = jsonResult(await h.preview()).artifact_id;
  const one = h.propose({ artifact_id, caption: 'same' });
  const two = h.propose({ artifact_id, caption: 'same' });
  finish();
  assert.equal(jsonResult(await one).duplicate, false);
  assert.equal(jsonResult(await two).duplicate, true);
  assert.equal(jsonResult(await h.propose({ artifact_id, caption: 'same' })).duplicate, true);
  checkError(await h.propose({ artifact_id, caption: 'different' }), 'ARTIFACT_ALREADY_USED');
  assert.equal(h.calls.filter(call => call.name === 'propose_figure').length, 1);
});

test('read permission revocation and base proposal errors are preserved', async () => {
  const h = mockHarness({ callBase: async name => name === 'preview_figure'
    ? { content: [{ type: 'image', mimeType: 'image/png', data: 'dGVzdA==' }] }
    : { isError: true, content: [{ type: 'text', text: '오류(CLAIMED): Another session owns the request.' }] } });
  const artifact_id = jsonResult(await h.preview()).artifact_id;
  h.state.allowed = false; checkError(await h.propose({ artifact_id }), 'NO_DOC');
  assert.equal(h.calls.length, 1);
  h.state.allowed = true; checkError(await h.propose({ artifact_id }), 'CLAIMED');
  checkError(await h.propose({ artifact_id }), 'CLAIMED');
  assert.equal(h.calls.length, 3, 'failed writes must not produce a successful cached receipt');
});

test('chart inputs are normalized and detached from the caller before reuse', async () => {
  const h = mockHarness(); const chart = { type: 'bar', categories: ['A'], series: [{ name: 'Count', values: [3] }] };
  const artifact_id = jsonResult(await h.preview({ svg: undefined, chart })).artifact_id;
  chart.series[0].values[0] = 999;
  await h.propose({ artifact_id });
  assert.equal(h.calls[1].args.chart.series[0].values[0], 3);
  assert.equal(h.calls[1].args.chart.y_min, undefined, 'nullable normalizer defaults are omitted for base MCP schema compatibility');
});

test('real isolated Service + base MCP: preview writes nothing, artifact creates one real figure proposal and reuses receipt', { timeout: 60000 }, async t => {
  const runtime = createLabRuntime();
  const server = createMcpServer({ service: runtime.service, user: runtime.users.admin, agentName: 'MCP Lab Test', agentSession: 'figure-lab-test' });
  const client = new Client({ name: 'figure-lab-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  let module;
  t.after(async () => { module?.close(); await client.close(); await server.close(); await runtime.close(); });
  const docId = runtime.service.store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(path.join(repoRoot, 'tests/fixtures/tool_memo_tracked.hwpx')), by: runtime.users.admin.name }).id;
  module = createFigureTools({ service: runtime.service, user: runtime.users.admin,
    callBase: (name, args) => client.callTool({ name, arguments: args }) });
  const before = JSON.stringify(runtime.service._meta(docId));
  const preview = await runtime.runExclusive(() => module.tools[0].handler({ doc_id: docId, svg: SVG, after_ref: 's0/p1', width_mm: 100 }));
  assert.ok(!preview.isError, code(preview));
  assert.equal(JSON.stringify(runtime.service._meta(docId)), before);
  const artifact_id = jsonResult(preview).artifact_id;
  const args = { doc_id: docId, artifact_id, caption: '실험 그림' };
  const result = await runtime.runExclusive(() => module.tools[1].handler(args));
  assert.ok(!result.isError, code(result));
  assert.equal(jsonResult(result).proposal_id, 1);
  assert.equal(runtime.service._meta(docId).proposals.length, 1);
  assert.equal(runtime.service._meta(docId).attachments.length, 2, 'only final PNG and SVG attachments are stored');
  const retry = await runtime.runExclusive(() => module.tools[1].handler(args));
  assert.equal(jsonResult(retry).duplicate, true);
  assert.equal(runtime.service._meta(docId).proposals.length, 1);
});
