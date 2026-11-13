import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLabRuntime } from '../runtime.mjs';
import { createLabConnection } from '../gateway.mjs';

const json = result => { assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content.find(c => c.type === 'text').text); };

test('focused MCP progressively exposes every capability; full is a compatibility path', async () => {
  const runtime = createLabRuntime(); let focused, full;
  try {
    focused = await createLabConnection(runtime);
    full = await createLabConnection(runtime, { profile: 'full' });
    const small = (await focused.client.listTools()).tools, large = (await full.client.listTools()).tools;
    assert.ok(small.length < 20);
    assert.ok(JSON.stringify(small).length < JSON.stringify(large).length / 2);
    assert.ok(small.some(t => t.name === 'get_task_guidance'));
    assert.ok(!small.some(t => t.name === 'audit_formatting'));
    assert.ok(large.some(t => t.name === 'download_attachment_file'));
    assert.ok(large.some(t => t.name === 'upload_result_file'));
    assert.ok(!large.some(t => ['get_attachment_file', 'save_result_file'].includes(t.name)));
    assert.equal((await focused.call('audit_formatting', { doc_id: 'not-a-document', refs: ['s0/p0'] })).isError, true);
    json(await focused.call('enable_tools', { groups: ['formatting', 'toc'] }));
    assert.ok((await focused.client.listTools()).tools.some(t => t.name === 'audit_formatting'));
    json(await focused.call('enable_tools', { groups: ['all'] }));
    assert.deepEqual((await focused.client.listTools()).tools.map(t => t.name).sort(), large.map(t => t.name).sort());
    assert.equal((await focused.call('enable_tools', { groups: ['invented'] })).isError, true);
  } finally { await focused?.close(); await full?.close(); await runtime.close(); }
});

test('MCP file tools use the gateway claim and transfer bytes outside model text', async () => {
  const runtime = createLabRuntime(); let connection;
  try {
    const user = runtime.users.owner;
    const doc = await runtime.service.createBlankDocument({ user, title: 'File gateway', location: { space: 'private' } });
    const input = Buffer.from('private payload 6720\n');
    const attachment = await runtime.service.addAttachment(doc.id, { name: 'input.txt', bytes: input }, user);
    const request = (await runtime.service.createRequest(doc.id, { kind: 'instruct', route: 'queue', target: { scope: 'document' }, instruction: '첨부 결과를 저장해줘.', attachments: [attachment.aid] }, user)).request;
    connection = await createLabConnection(runtime);
    json(await connection.call('enable_tools', { groups: ['files'] }));
    const args = { doc_id: doc.id, request_id: request.rid, expected_attempt: request.attempt };
    json(await connection.call('start_request', args));
    const downloaded = json(await connection.call('download_attachment_file', { ...args, attachment_id: attachment.aid }));
    assert.deepEqual(fs.readFileSync(downloaded.path), input);
    const output = path.join(downloaded.out_dir, 'result.txt');
    const bytes = Buffer.from('result data 9821\n'); fs.writeFileSync(output, bytes);
    const saved = json(await connection.call('upload_result_file', { ...args, path: output }));
    assert.deepEqual((await runtime.service.getAttachment(doc.id, saved.aid)).bytes, bytes);
    assert.ok(!JSON.stringify(downloaded).includes(input.toString('utf8').trim()));
    assert.ok(!JSON.stringify(saved).includes(bytes.toString('utf8').trim()));
  } finally { await connection?.close(); await runtime.close(); }
});

test('compact request preserves user text, data and formats while removing duplicated context/procedure', async () => {
  const runtime = createLabRuntime(); let focused, full;
  try {
    const doc = await runtime.service.createBlankDocument({ user: runtime.users.owner, title: '빠른 수정' });
    const request = (await runtime.service.createRequest(doc.id, { kind: 'instruct', route: 'queue', target: { ref: 's0/p0' }, instruction: '첫 문단에 검증된 결론을 작성해줘. 개인 지침을 따른다.' }, runtime.users.owner)).request;
    focused = await createLabConnection(runtime); full = await createLabConnection(runtime, { profile: 'full', compact: false });
    const args = { doc_id: doc.id, request_id: request.rid };
    const rawResult = await full.call('get_request', args), reducedResult = await focused.call('get_request', args);
    const raw = json(rawResult), reduced = json(reducedResult);
    assert.deepEqual(reduced.contextItems, raw.contextItems);
    assert.deepEqual(reduced.formattingHeader, raw.formattingHeader);
    assert.equal(reduced.instruction, raw.instruction);
    assert.equal(reduced.context, undefined);
    assert.equal(reduced.howTo, undefined);
    assert.equal(reduced.guidance.state, 'not_set', 'simple tasks need no extra guidance lookup');
    assert.ok(JSON.stringify(reducedResult).length < JSON.stringify(rawResult).length);
    const trace = JSON.stringify(focused.metrics.snapshot());
    assert.ok(!trace.includes(request.instruction));
    assert.ok(!trace.includes(runtime.users.owner.token));
    assert.equal(focused.metrics.snapshot().modelTokens, null);
  } finally { await focused?.close(); await full?.close(); await runtime.close(); }
});

test('all experimental tools retain per-user document access checks', async () => {
  const runtime = createLabRuntime(); let outsider;
  try {
    const doc = await runtime.service.createBlankDocument({ user: runtime.users.owner, location: { space: 'private' } });
    outsider = await createLabConnection(runtime, { user: runtime.users.other, profile: 'full' });
    for (const [name, args] of [
      ['read_document', {}], ['audit_formatting', { refs: ['s0/p0'] }], ['inspect_toc', {}],
      ['render_figure_preview', { after_ref: 's0/p0', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>' }],
      ['get_task_guidance', { request_id: 1 }],
    ]) assert.equal((await outsider.call(name, { doc_id: doc.id, ...args })).isError, true, name);
  } finally { await outsider?.close(); await runtime.close(); }
});
