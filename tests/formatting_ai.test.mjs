import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { parseResult, outputJsonSchema, taskText } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { requestedFormat, requestedRuns } from '../server/format-schema.js';

const response = over => ({ proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '서식 제안을 남겼습니다.', instructionSummary: '서식 검토', ...over });
// 문단 서식을 값으로: get_formatting(refs) 의 번호(paraPrId·runs[].charPrId)를 header 항목으로 푼다(번호는 적용·되돌리기로 바뀔 수 있어 값으로 비교)
async function shape(call, ref) {
  const f = json(await call('get_formatting', { refs: [ref] }));
  const p = f.paragraphs[0];
  const strip = ({ id, ...rest }) => rest;
  const ch = Object.fromEntries(f.header.charPr.map(c => [c.id, strip(c)])); const pp = Object.fromEntries(f.header.paraPr.map(c => [c.id, strip(c)]));
  return { text: p.text, paragraph: pp[p.paraPrId], runs: p.runs.map(r => ({ start: r.start, end: r.end, char: ch[r.charPrId] })) };
}
const json = result => { assert.equal(result.isError, undefined, result.content?.[0]?.text); return JSON.parse(result.content.find(item => item.type === 'text').text); };
async function setup() {
  const srv = await startServer({ ai: 'off' });
  const flat = await (await HwpxDoc.load(await fs.readFile(fixture('tool_memo_tracked.hwpx')))).flattened();
  const upload = await uploadDoc(srv.base, srv.tokens.a, await flat.save());
  const api = srv.api('a'); const route = `/api/docs/${upload.id}`;
  const target = (await api(`${route}/paragraphs`)).find(item => item.ref === 's0/p1');
  const client = new Client({ name: 'codex', version: 'format-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=Codex`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
  const call = (name, args) => client.callTool({ name, arguments: { doc_id: upload.id, ...args } });
  return { srv, api, route, target, call, close: async () => { await client.close(); await srv.stop(); } };
}

test('structured AI format output preserves false, null compatibility and strict required properties', () => {
  const output = parseResult(JSON.stringify(response({
    proposals: [{ ref: 's0/p0', find: '원문', replace: '새 글', reason: '검토', format: { char: { bold: false, italic: null } }, runs: [{ text: '새 글', char: { bold: false }, charPrId: null }] }],
    formats: [{ ref: 's0/p0', find: '원문', occurrence: null, format: { char: { bold: false }, paragraph: null }, reason: '굵게 해제' }],
  })));
  assert.deepEqual(output.formats[0].format, { char: { bold: false } });
  assert.deepEqual(output.proposals[0].runs, [{ text: '새 글', char: { bold: false } }]);
  assert.deepEqual(parseResult(JSON.stringify(response())).formats, []);
  const inspect = schema => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object' && schema.properties) {
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      assert.equal(schema.additionalProperties, false);
    }
    Object.values(schema).forEach(value => Array.isArray(value) ? value.forEach(inspect) : inspect(value));
  };
  inspect(outputJsonSchema());
  assert.deepEqual(requestedFormat({ char: { bold: true, italic: true } }, { char: { bold: false } }), { char: { bold: false, italic: true } });
  assert.deepEqual(requestedRuns([{ text: '글', char: { bold: true } }], { char: { bold: false } }), [{ text: '글', char: { bold: false } }]);
  const modelStyle = { styleId: '1', charPrId: '2', paraPrId: '3', char: { bold: true }, paragraph: { align: 'RIGHT' } };
  assert.deepEqual(requestedFormat(modelStyle, { styleId: '0', char: { bold: false } }), { styleId: '0', char: { bold: false } });
  assert.deepEqual(requestedFormat(modelStyle, { charPrId: '4' }), { styleId: '1', charPrId: '4', paraPrId: '3', paragraph: { align: 'RIGHT' } });
  assert.deepEqual(requestedFormat(modelStyle, { paraPrId: '5' }), { styleId: '1', charPrId: '2', paraPrId: '5', char: { bold: true } });
  assert.equal(requestedRuns([{ text: '글', charPrId: '2', char: { bold: true } }], { styleId: '0' }), undefined);
  const prompt = taskText({ kind: 'instruct', target: { ref: 's0/p0' }, options: { format: { char: { bold: false } } }, context: [{ ref: 's0/p0', text: '글', formatting: { runs: [{ charPrId: '1', char: { bold: true } }] } }], formattingCatalog: { styles: [{ id: '0', name: '본문' }] } });
  assert.match(prompt, /선택 서식/); assert.match(prompt, /현재 서식/); assert.match(prompt, /문서 서식 정의/);
  // 지금 서버: 문단은 번호만(styleId·paraPrId·runs[].charPrId), 값은 formattingHeader
  const compact = taskText({ kind: 'instruct', target: { ref: 's0/p0' }, context: [{ ref: 's0/p0', text: '글', styleId: '0', paraPrId: '3', runs: [{ start: 0, end: 1, charPrId: '1' }] }], formattingHeader: { charPr: [{ id: '1', bold: true }] } });
  assert.match(compact, /현재 서식[^\n]*\n\[\{"ref":"s0\/p0","styleId":"0","paraPrId":"3","runs":\[\{"start":0,"end":1,"charPrId":"1"\}\]\}\]/);
  assert.match(compact, /문서 서식 정의[^\n]*\n\{"charPr":\[\{"id":"1","bold":true\}\]\}/);
});

test('MCP formatting proposal stays pending, validates range/ID/attempt, applies and memo-safe undo restores shape', { timeout: 20000 }, async () => {
  const env = await setup(); const { api, route, target, call } = env;
  try {
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '서식 검토', route: 'queue', target: { ref: target.ref } } })).request;
    const claimed = json(await call('claim_next_request', {}));
    assert.equal(claimed.rid, request.rid);
    const item = claimed.contextItems.find(entry => entry.ref === target.ref);
    assert.ok(item.runs.length && item.runs.every(run => claimed.formattingHeader.charPr.some(c => c.id === run.charPrId)), 'get_request: 문단은 번호만, 그 번호의 값은 formattingHeader');
    assert.ok(claimed.formattingHeader.paraPr.some(c => c.id === item.paraPrId) && !('formattingCatalog' in claimed) && !('formatting' in item));
    const before = await shape(call, target.ref);
    assert.ok(before.runs.length);
    const args = { request_id: request.rid, expected_attempt: 1, ref: target.ref, find: target.text };
    assert.equal((await call('propose_format', { ...args, expected_attempt: 2, format: { char: { bold: false } } })).isError, true);
    assert.equal((await call('propose_format', { ...args, format: { charPrId: '9999999' } })).isError, true);
    assert.equal((await call('propose_format', { ...args, find: undefined, start: 0, end: 1, format: { paragraph: { align: 'CENTER' } } })).isError, true);
    assert.equal((await call('propose_format', { ...args, find: undefined, start: 1, end: 1, format: { char: { bold: false } } })).isError, true, 'an empty selection cannot accidentally format the full paragraph');
    const wanted = !before.runs[0].char.bold;
    const proposal = json(await call('propose_format', { ...args, format: { char: { bold: wanted } }, reason: '글자 강조 변경' }));
    assert.equal(proposal.type, 'format'); assert.equal(proposal.status, 'pending');
    const current = () => shape(call, target.ref);
    assert.deepEqual(await current(), before, 'proposing never applies the format');
    await api(`${route}/proposals/${proposal.pid}/apply`, { method: 'POST' });
    assert.ok((await current()).runs.every(run => run.char.bold === wanted));
    json(await call('add_memo', { ref: target.ref, text: '서식 적용 뒤 추가한 별도 의견' }));
    await api(`${route}/proposals/${proposal.pid}/undo`, { method: 'POST' });
    assert.deepEqual(await current(), before);
    assert.ok((await api(`${route}/memos`)).some(memo => memo.text.includes('서식 적용 뒤 추가한 별도 의견')));
    const stale = json(await call('propose_format', { ...args, format: { char: { bold: wanted } } }));
    const other = json(await call('propose_format', { ...args, format: { char: { italic: !before.runs[0].char.italic } } }));
    await api(`${route}/proposals/${other.pid}/apply`, { method: 'POST' });
    const rejected = await api.res(`${route}/proposals/${stale.pid}/apply`, { method: 'POST' });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.error, 'FORMAT_CONFLICT');
  } finally { await env.close(); }
});

test('rich replacement and insert carry explicit runs through proposal apply and restore original formatting', { timeout: 20000 }, async () => {
  const env = await setup(); const { api, route, target, call } = env;
  try {
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '문장과 서식', route: 'queue', target: { ref: target.ref } } })).request;
    json(await call('claim_next_request', {}));
    const before = await shape(call, target.ref);
    const proposal = json(await call('propose_change', { request_id: request.rid, expected_attempt: 1, ref: target.ref, find: target.text, replace: '굵은 글 일반 글', format: { paragraph: { align: 'CENTER' } }, runs: [{ text: '굵은 글', char: { bold: true } }, { text: ' 일반 글', char: { bold: false } }] }));
    await api(`${route}/proposals/${proposal.pid}/apply`, { method: 'POST' });
    const current = await shape(call, target.ref);
    assert.equal(current.text, '굵은 글 일반 글'); assert.equal(current.runs[0].char.bold, true); assert.equal(current.runs.at(-1).char.bold, false);
    assert.equal(current.paragraph.align, 'CENTER');
    await api(`${route}/proposals/${proposal.pid}/undo`, { method: 'POST' });
    assert.deepEqual(await shape(call, target.ref), before);
    assert.equal((await call('propose_insert', { after_ref: target.ref, text: '맞지 않는 글', runs: [{ text: '다른 글', char: { bold: false } }] })).isError, true);
    const inserted = json(await call('propose_insert', { after_ref: target.ref, text: '새 문단', format: { char: { bold: false }, paragraph: { align: 'CENTER' } }, runs: [{ text: '새 문단', char: { italic: true } }] }));
    const applied = await api(`${route}/proposals/${inserted.pid}/apply`, { method: 'POST' });
    assert.ok(applied.insertedRef);
  } finally { await env.close(); }
});

test('independent format ranges apply and undo separately while overlapping stale proposals remain guarded', { timeout: 20000 }, async () => {
  const env = await setup(); const { api, route, target, call } = env;
  try {
    const length = [...target.text].length; assert.ok(length > 4);
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '범위별 서식', target: { ref: target.ref }, route: 'queue' } })).request;
    json(await call('claim_next_request', {}));
    const before = await shape(call, target.ref);
    const base = { request_id: request.rid, expected_attempt: 1, ref: target.ref };
    const bold = json(await call('propose_format', { ...base, start: 0, end: 2, format: { char: { bold: !before.runs[0].char.bold } } }));
    const italic = json(await call('propose_format', { ...base, start: 3, end: length, format: { char: { italic: !before.runs.at(-1).char.italic } } }));
    const overlap = json(await call('propose_format', { ...base, start: 0, end: 2, format: { char: { italic: true } } }));
    await api(`${route}/proposals/${bold.pid}/apply`, { method: 'POST' });
    await api(`${route}/proposals/${italic.pid}/apply`, { method: 'POST' });
    const rejected = await api.res(`${route}/proposals/${overlap.pid}/apply`, { method: 'POST' });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.error, 'FORMAT_CONFLICT');
    await api(`${route}/proposals/${bold.pid}/undo`, { method: 'POST' });
    const remaining = await shape(call, target.ref);
    assert.equal(remaining.runs[0].char.bold, before.runs[0].char.bold);
    assert.ok(remaining.runs.filter(run => run.end > 3).every(run => run.char.italic === !before.runs.at(-1).char.italic), 'undo keeps the other accepted range');
    await api(`${route}/proposals/${italic.pid}/undo`, { method: 'POST' });
    assert.deepEqual(await shape(call, target.ref), before);
  } finally { await env.close(); }
});

test('personal worker keeps distinct format proposals and fills a selected format omitted by the model', { timeout: 20000 }, async () => {
  const env = await setup(); const { srv, api, route, target } = env; let worker;
  try {
    const requests = [];
    const ai = { async run(input) {
      requests.push(input); assert.ok(input.formattingHeader.styles.length); assert.ok(input.context.find(item => item.ref === target.ref).runs.length);
      return requests.length === 1 ? response({ formats: [true, false].map(bold => ({ ref: target.ref, find: target.text, format: { char: { bold } }, reason: '서로 다른 서식' })) }) : response();
    } };
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 40 } });
    const first = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '서식 비교', target: { ref: target.ref }, route: 'queue' } })).request;
    worker.start();
    const until = async expected => { const deadline = Date.now() + 8000; while (Date.now() < deadline) { if (worker.stats().completed === expected) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail(JSON.stringify(worker.stats())); };
    await until(1);
    let proposals = await api(`${route}/proposals`);
    assert.equal(proposals.filter(item => item.rid === first.rid).length, 2, 'same text with different formatting is not deduplicated');
    const second = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', options: { format: { char: { bold: false } } }, target: { ref: target.ref }, route: 'queue' } })).request;
    await until(2);
    proposals = await api(`${route}/proposals`);
    const forced = proposals.find(item => item.rid === second.rid);
    assert.equal(forced.type, 'format'); assert.equal(forced.format.char.bold, false); assert.equal(forced.status, 'pending');
    assert.equal((await api(`${route}/paragraphs`)).find(item => item.ref === target.ref).text, target.text);
  } finally { await worker?.stop(); await env.close(); }
});
