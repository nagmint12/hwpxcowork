import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { docBytesSync } from '../engine/toc.js';
import { contentMarkdown, insertDocumentFeature, normalizeEditOperations, editCapabilities } from '../server/document-edit.js';
import { listFields } from '../engine/fields.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { createApiWorker } from '../server/worker.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { codexToolPolicy } from '../server/codex-mcp.js';
import { AiProposer } from '../server/ai.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { CodexProposer } from '../server/codex-ai.js';
import { ClaudeCodeProposer } from '../server/claude-cli-ai.js';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { fakeClaude } from './helpers/claude-cli.mjs';
import { makePng } from './helpers/image.mjs';

// 내용·형식 나눠 처리(실험)는 기본으로 꺼져 있다(server/config.js experiments.contentFormat — 2026-11-16). 이 파일의 시험은 실험을 켠 서버에서 그 경로가 그대로인지 본다
const EXPERIMENT = { config: { experiments: { contentFormat: true } } };

async function sample() { const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx'))); d.acceptAll(); return d; }
async function setup(t) {
  const srv = await startServer(EXPERIMENT), bytes = docBytesSync(await sample());
  const doc = await uploadDoc(srv.base, srv.tokens.admin, bytes, 'workflow.hwpx');
  const client = new Client({ name: 'workspace-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.admin}`, 'X-Hwpx-Agent-Session': 'workspace-test' } } });
  await client.connect(transport);
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close(); await srv.stop(); });
  const D = `/api/docs/${doc.id}`, api = srv.api('admin');
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', target: { scope: 'document', ref: 's0/p0' },
    instruction: '내용을 고치고 표준 서식으로 정리해줘', options: { workflow: 'content_format' } } })).request;
  const raw = (name, args = {}) => client.callTool({ name, arguments: { doc_id: doc.id, request_id: req.rid, expected_attempt: 1, ...args } });
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, r.content[0].text); return JSON.parse(r.content[0].text); };
  await call('start_request');
  return { srv, doc, D, api, req, client, call, raw, bytes };
}

test('허용 동작만 노출하며 단계가 다르거나 임의 메서드/XML이면 거절한다', () => {
  for (const op of ['hyperlink', 'field', 'note', 'define_style', 'import_styles']) assert.ok(editCapabilities().some(c => c.op === op));
  assert.ok(editCapabilities(['note'])[0].inputSchema.properties.kind.enum.includes('endnote'));
  assert.throws(() => normalizeEditOperations([{ op: 'eval', args: { source: 'x' } }]), /지원하지/);
  assert.throws(() => normalizeEditOperations([{ op: 'replace', args: { ref: 's0/p1', find: 'a', replace: 'b' } }], 'format'), /content/);
  assert.throws(() => normalizeEditOperations([{ op: 'note', args: { ref: 's0/p1', offset: 0, kind: 'footnote', text: 'a', xml: '<xml/>' } }]), /Unrecognized/);
  const policy = codexToolPolicy({ type: 'request', docId: 'doc', requestId: 1, attempt: 1, workflow: 'content_format' }, async () => {});
  assert.equal(policy.allows('edit_workspace'), true); assert.equal(policy.allows('propose_changes'), false); assert.equal(policy.allows('complete_request'), false);
});

test('WASM 컨트롤 조각: 링크·누름틀·각주·미주 생성이 다른 문단·기존 메모·기존 글을 보존한다', async () => {
  const d = await sample(), p0 = d.sections[0].xml.slice(d.resolve('s0/p0').p.start, d.resolve('s0/p0').p.end), text = d.text('s0/p1');
  insertDocumentFeature(d, 'hyperlink', { ref: 's0/p1', start: 0, end: 2, uri: 'https://example.org/path' });
  insertDocumentFeature(d, 'field', { ref: 's0/p1', offset: [...text].length, name: '실험누름틀', guide: '값 입력', editable: true });
  insertDocumentFeature(d, 'note', { ref: 's0/p1', offset: 5, kind: 'footnote', text: '각주 내용' });
  insertDocumentFeature(d, 'note', { ref: 's0/p1', offset: 8, kind: 'endnote', text: '미주 내용' });
  assert.equal(d.text('s0/p1'), text); assert.equal(d.memos().length, 1);
  assert.equal(d.sections[0].xml.slice(d.resolve('s0/p0').p.start, d.resolve('s0/p0').p.end), p0);
  assert.equal(listFields(d)[0].name, '실험누름틀');
  assert.match(d.sections[0].xml, /type="HYPERLINK"/); assert.match(d.sections[0].xml, /<hp:footNote/); assert.match(d.sections[0].xml, /<hp:endNote/);
  assert.match(d.sections[0].xml, /각주 내용/); assert.match(d.sections[0].xml, /미주 내용/);
  const reloaded = await HwpxDoc.load(await d.save()); assert.equal(reloaded.text('s0/p1'), text); assert.equal(listFields(reloaded)[0].name, '실험누름틀');
});

test('앞쪽에 각주·미주를 추가하면 기존 번호와 주석 본문 자동 번호를 함께 다시 매긴다', async () => {
  const doc = await sample();
  for (const kind of ['footnote', 'endnote']) {
    insertDocumentFeature(doc, 'note', { ref: 's0/p1', offset: 8, kind, text: '뒤쪽 주석' });
    insertDocumentFeature(doc, 'note', { ref: 's0/p1', offset: 4, kind, text: '앞쪽 주석' });
    const tag = kind === 'footnote' ? 'hp:footNote' : 'hp:endNote';
    const current = doc.resolve('s0/p1'), notes = current.p.anchors.filter(a => a.inner === tag);
    assert.deepEqual(notes.map(a => a.innerAttrs.get('number')), ['1', '2']);
    assert.deepEqual(notes.map(a => /<hp:autoNum\b[^>]*\bnum="(\d+)"/.exec(current.sec.xml.slice(a.start, a.end))?.[1]), ['1', '2']);
  }
});

test('두 단계 사본 → 한 묶음 제안 → 적용/복구, 중간 원문 불변·표준 역할 스타일 생성', { timeout: 60000 }, async t => {
  const x = await setup(t), original = await x.api(`${x.D}/file?kind=working`);
  const initial = await x.call('get_request'); assert.equal(initial.editWorkflow.stage, 'content'); assert.deepEqual(initial.contextItems, []);
  assert.ok(!('formattingHeader' in initial)); assert.ok(!initial.editWorkflow.markdown.includes('<hp:'));
  const operations = [
    { op: 'replace', args: { ref: 's0/p1', find: '둘째', replace: '두 번째' } },
    { op: 'table', args: { after_ref: 's0/p2', rows: [['구분', '값'], ['A', '20']], caption: '실험 표' } },
    { op: 'hyperlink', args: { ref: 's0/p1', start: 0, end: 2, uri: 'https://example.org' } },
    { op: 'field', args: { ref: 's0/p1', offset: 40, name: '검토자', guide: '입력' } },
    { op: 'note', args: { ref: 's0/p1', offset: 5, kind: 'footnote', text: '근거 각주' } },
  ];
  const a = await x.call('edit_workspace', { stage: 'content', revision: 0, operations, complete_stage: true, summary: '내용과 표·링크·누름틀·각주를 정리했습니다.' });
  assert.equal(a.stage, 'format'); assert.deepEqual(await x.api(`${x.D}/file?kind=working`), original);
  const second = await x.call('get_edit_workspace'); assert.match(second.markdown, /두 번째/);
  const formatOps = [
    { op: 'import_styles', args: { preset: 'hwpx_standard' } },
    { op: 'define_style', args: { name: '실험 제목', format: { char: { sizePt: 15, bold: true }, paragraph: { align: 'CENTER' } } } },
    { op: 'format', args: { refs: ['s0/p1'], style_name: '실험 제목' } },
    { op: 'table_edit', args: { table: a.receipts.find(r => r.op === 'table').table, ops: [{ op: 'table', width_mm: 90, align: 'CENTER' }] } },
  ];
  const b = await x.call('edit_workspace', { stage: 'format', revision: a.revision, operations: formatOps, complete_stage: true, summary: '역할 스타일과 표 정렬을 적용했습니다.' });
  assert.equal(b.stage, 'ready'); assert.deepEqual(await x.api(`${x.D}/file?kind=working`), original);
  assert.equal((await x.srv.api('b').res(`${x.D}/requests/${x.req.rid}/workspace-file`)).status, 403);
  const p = await x.call('publish_edit_workspace'); assert.equal((await x.call('publish_edit_workspace')).pid, p.pid);
  const query = `attempt=${p.batch.attempt}&revision=${p.batch.revision}`;
  const draftBytes = await x.api(`${x.D}/requests/${x.req.rid}/workspace-file?${query}`);
  assert.equal((await HwpxDoc.load(draftBytes)).tables().length, 1);
  const md = await x.api(`${x.D}/requests/${x.req.rid}/workspace-file?kind=markdown&${query}`); assert.match(md, /두 번째/); assert.ok(!md.includes('<hp:'));
  assert.equal((await x.srv.api('b').res(`${x.D}/requests/${x.req.rid}/workspace-file?${query}`)).status, 200, '발행한 결과는 문서를 읽는 공동 검토자도 확인할 수 있다');
  const proposals = await x.call('list_proposals'); assert.equal(proposals.length, 1); assert.equal(proposals[0].batchSnapshot, undefined);
  await x.call('complete_request', { summary: '내용과 형식을 나누어 처리했습니다.' });
  const adopt = await x.api.res(`${x.D}/proposals/${p.pid}/adopt`, { method: 'POST', body: {} });
  assert.equal(adopt.status, 400); assert.equal(adopt.data.error, 'BAD_TYPE');
  const adoptBatch = await x.api(`${x.D}/requests/${x.req.rid}/resolve`, { method: 'POST', body: { adopt: [p.pid] } });
  assert.equal(adoptBatch.counts.failed, 1); assert.equal(adoptBatch.counts.adopted, 0);
  assert.equal(adoptBatch.results[0].code, 'BAD_TYPE');
  // HTTP 저장 ZIP의 시간 메타데이터와 별개로 문서의 모든 항목을 같은 저장 경로에서 비교한다.
  assert.deepEqual(docBytesSync(await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`))), docBytesSync(await HwpxDoc.load(original)));
  await x.call('apply_proposal', { proposal_id: p.pid });
  const applied = await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`));
  assert.match(applied.text('s0/p1'), /^두 번째/); assert.equal(applied.tables().length, 1);
  assert.equal(listFields(applied)[0].name, '검토자'); assert.match(applied.sections[0].xml, /<hp:footNote/);
  assert.ok(applied.formattingCatalog().styles.some(s => s.name === '&본문 1.'));
  assert.equal(applied.inspectFormatting('s0/p1').paragraph.align, 'CENTER');
  await x.call('undo_proposal', { proposal_id: p.pid });
  const undone = await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`)); assert.equal(undone.tables().length, 0); assert.match(undone.text('s0/p1'), /^둘째/);
  assert.equal(listFields(undone).length, 0); assert.ok(!undone.formattingCatalog().styles.some(s => s.name === '실험 제목'));
});

test('원자성·단계 건너뛰기·오래된 revision·취소/시도 변경을 검사한다', { timeout: 60000 }, async t => {
  const x = await setup(t), first = await x.call('get_edit_workspace');
  const bad = await x.raw('edit_workspace', { stage: 'content', revision: 0, operations: [{ op: 'replace', args: { ref: 's0/p1', find: '둘째', replace: '수정' } }, { op: 'replace', args: { ref: 's99/p0', find: '', replace: 'X' } }] });
  assert.ok(bad.isError); assert.equal((await x.call('get_edit_workspace')).draftHash, first.draftHash);
  assert.ok((await x.raw('publish_edit_workspace')).isError); assert.ok((await x.raw('complete_request', { summary: '완료' })).isError);
  assert.ok((await x.raw('edit_workspace', { stage: 'format', revision: 0, operations: [] })).isError);
  await x.call('edit_workspace', { stage: 'content', revision: 0, operations: [], complete_stage: true, no_changes_reason: '전체 본문을 읽었으며 내용 수정은 필요 없습니다.' });
  assert.ok((await x.raw('edit_workspace', { stage: 'content', revision: 0, operations: [] })).isError);
  const source = await x.api(`${x.D}/proposals`, { method: 'POST', body: { ref: 's0/p2', find: '셋째', replace: '사람 수정' } });
  await x.call('apply_proposal', { proposal_id: source.pid });
  assert.match((await x.raw('get_edit_workspace')).content[0].text, /EDIT_SOURCE_CHANGED/);
});

test('표 구조는 내용 단계에서 편집하고 형식 단계의 스키마·저장에서는 거절한다', { timeout: 30000 }, async t => {
  const x = await setup(t);
  const schemas = editCapabilities(['table_structure', 'table_edit']);
  assert.deepEqual(schemas[0].inputSchema.properties.ops.items.properties.op.enum, ['delete_rows', 'delete_cols', 'insert_rows', 'insert_cols', 'merge', 'unmerge']);
  assert.ok(!schemas[1].inputSchema.properties.ops.items.properties.op.enum.includes('insert_rows'));
  const created = await x.call('edit_workspace', { stage: 'content', revision: 0, operations: [
    { op: 'table', args: { after_ref: 's0/p2', rows: [['항목', '값'], ['A', '1']] } },
  ] });
  const table = created.receipts[0].table;
  const ops = [{ op: 'insert_rows', row: 0, position: 'below', values: [['B', '2']] }];
  const content = await x.call('edit_workspace', { stage: 'content', revision: created.revision,
    operations: [{ op: 'table_structure', args: { table, ops } }], complete_stage: true, summary: '새 표에 자료 행을 추가했습니다.' });
  const before = await x.call('get_edit_workspace'); assert.match(before.markdown, /\| B \| 2 \|/);
  assert.ok((await x.raw('edit_workspace', { stage: 'format', revision: content.revision, operations: [{ op: 'table_structure', args: { table, ops } }] })).isError);
  assert.ok((await x.raw('edit_workspace', { stage: 'format', revision: content.revision, operations: [{ op: 'table_edit', args: { table, ops } }] })).isError);
  assert.equal((await x.call('get_edit_workspace')).draftHash, before.draftHash);
  await x.call('edit_workspace', { stage: 'format', revision: content.revision, operations: [
    { op: 'table_edit', args: { table, ops: [{ op: 'table', align: 'CENTER', width_mm: 90 }] } },
  ], complete_stage: true, summary: '표 폭과 정렬을 맞췄습니다.' });
  const published = await x.call('publish_edit_workspace'); await x.call('complete_request', { summary: '표 내용과 형식 완료' });
  await x.call('apply_proposal', { proposal_id: published.pid });
  const applied = await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`));
  assert.equal(applied.tables()[0].rows, 3); assert.ok(applied.tables()[0].cells.some(c => c.text === 'B'));
  await x.call('undo_proposal', { proposal_id: published.pid });
  assert.equal((await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`))).tables().length, 0);
});

test('사본에서 문단·SVG 그림·표 기반 차트·누름틀 채움·개체 삭제·용지·차례까지 기존 엔진 경로를 쓴다', { timeout: 60000 }, async t => {
  const x = await setup(t);
  let result = await x.call('edit_workspace', { stage: 'content', revision: 0, operations: [
    { op: 'insert', args: { after_ref: 's0/p2', paragraphs: [{ text: '1. 추가 내용' }, { text: '추가 문단입니다.' }] } },
    { op: 'table', args: { after_ref: 's0/p2', rows: [['항목', '값'], ['A', '20'], ['B', '30']], caption: '근거 표' } },
    { op: 'field', args: { ref: 's0/p1', offset: 40, name: '작성자', guide: '이름' } },
    { op: 'fill_field', args: { name: '작성자', value: '검토완료' } },
  ] });
  const table = result.receipts.find(r => r.op === 'table').table;
  result = await x.call('edit_workspace', { stage: 'content', revision: result.revision, operations: [
    { op: 'chart', args: { after_ref: 's0/p2', chart: { type: 'bar', title: '측정값' }, source_table: { table, header_row: 0, category_col: 0, value_cols: [1], data_rows: [1, 2] } } },
    { op: 'figure', args: { after_ref: 's0/p2', caption: '도식', width_mm: 70, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="10" y="10" width="180" height="80" fill="#2468ac"/></svg>' } },
    { op: 'table', args: { after_ref: 's0/p2', rows: [['지울 표']], header_rows: 0 } },
  ] });
  const remove = result.receipts.find(r => r.op === 'table').ref;
  result = await x.call('edit_workspace', { stage: 'content', revision: result.revision, operations: [{ op: 'delete', args: { ref: remove, kinds: ['table'] } }], complete_stage: true, summary: '추가 문단과 표·차트·그림·누름틀을 만들었습니다.' });
  const preview = await HwpxDoc.load(await x.api(`${x.D}/requests/${x.req.rid}/workspace-file`));
  assert.equal(listFields(preview)[0].value, '검토완료'); assert.equal(preview.tables().length, 1);
  assert.match(preview.sections[0].xml, /<hp:chart/); assert.match(preview.sections[0].xml, /<hp:pic/);
  result = await x.call('edit_workspace', { stage: 'format', revision: result.revision, operations: [
    { op: 'import_styles', args: { preset: 'hwpx_standard' } },
    { op: 'format', args: { refs: ['s0/p0'], style_name: '&본문 1.' } },
    { op: 'page_layout', args: { ops: [{ op: 'paper', section: 0, margins: { left: 20, right: 20 } }, { op: 'header', section: 0, text: '실험 머리말' }] } },
    { op: 'toc', args: { create_if_missing: true, apply_styles: true } },
  ], complete_stage: true, summary: '표준 스타일·용지·차례를 정리했습니다.' });
  assert.equal(result.stage, 'ready');
  const published = await x.call('publish_edit_workspace'); await x.call('complete_request', { summary: '두 단계를 마쳤습니다.' });
  await x.call('apply_proposal', { proposal_id: published.pid });
  const applied = await HwpxDoc.load(await x.api(`${x.D}/file?kind=working`));
  assert.match(applied.sections[0].xml, /<hp:chart/); assert.match(applied.sections[0].xml, /<hp:pic/); assert.equal(/type="TABLEOFCONTENTS"/.test(applied.sections[0].xml), true);
  assert.equal(listFields(applied)[0].value, '검토완료');
  assert.equal(applied.sections[0].xml.includes('실험 머리말'), true);
});

function stagedApi(seen) {
  return async (_url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    assert.equal(body.messages.length, 1, '각 단계는 이전 도구 대화가 없는 새 Messages 대화');
    const content = JSON.stringify(body.messages[0]); const stage = seen.length === 1 ? 'content' : 'format';
    assert.match(content, /내용·형식 분리 실험/);
    assert.ok(body.tools.some(t => t.name === 'edit_workspace')); assert.ok(!body.tools.some(t => t.name === 'propose_changes'));
    const args = stage === 'content' ? { stage, revision: 0, operations: [{ op: 'replace', args: { ref: 's0/p1', find: '둘째', replace: '두 번째' } }], complete_stage: true, summary: '내용을 정리했습니다.' }
      : { stage, revision: 1, operations: [{ op: 'format', args: { refs: ['s0/p1'], format: { char: { bold: true } } } }], complete_stage: true, summary: '형식을 정리했습니다.' };
    if (stage === 'format') { assert.match(content, /두 번째/); assert.ok(!content.includes('"tool_use"')); }
    return new Response(JSON.stringify({ id: `stage-${stage}`, type: 'message', role: 'assistant', model: 'fake-staged', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `edit-${stage}`, name: 'edit_workspace', input: args }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } }), { headers: { 'Content-Type': 'application/json' } });
  };
}

test('개인 API 실행기: 내용/형식은 각각 새 모델 대화, 단계별 사용량·합계와 한 묶음 결과', { timeout: 60000 }, async t => {
  const srv = await startServer(EXPERIMENT), seen = [], ai = new AiProposer({ ai: { provider: 'anthropic', model: 'fake-staged', enabled: true } }, { key: 'fake', fetch: stagedApi(seen) });
  const doc = await uploadDoc(srv.base, srv.tokens.a, docBytesSync(await sample()));
  const api = srv.api('a'), D = `/api/docs/${doc.id}`;
  const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용과 서식을 고쳐줘', route: 'queue', target: { ref: 's0/p1' }, options: { workflow: 'content_format' } } })).request;
  const worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 30 } });
  t.after(async () => { await worker.stop(); await srv.stop(); });
  worker.start();
  const deadline = Date.now() + 20000; let current;
  do { current = await api(`${D}/requests/${request.rid}`); if (['done', 'failed'].includes(current.status)) break; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < deadline);
  assert.equal(current.status, 'done', current.error); assert.equal(seen.length, 2);
  assert.deepEqual(current.usage, { input: 200, output: 40, cacheRead: 80, modelCalls: 2, toolCalls: 2 });
  const metadata = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'docs', doc.id, 'meta.json'), 'utf8'));
  const w = metadata.requests.find(r => r.rid === request.rid).editWorkspace;
  assert.deepEqual(w.stages.map(s => s.freshConversation), [true, true]); assert.deepEqual(w.stages.map(s => s.usage.modelCalls), [1, 1]);
  assert.equal(metadata.proposals.length, 1); assert.equal(metadata.proposals[0].type, 'edit_batch');
});

test('서버 개인 API 경로도 두 새 대화로 실행하고 중간 사본·사용량을 보존한다', { timeout: 60000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-server-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const user = { name: '실험 사용자', role: 'admin' }, seen = [];
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, experiments: { contentFormat: true } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  service.personalAi = createPersonalAi({ config, fetchImpl: stagedApi(seen) });
  service.personalAi.save(user, { provider: 'anthropic', model: 'fake-staged', key: 'fake-api-key' });
  const docId = store.create({ fileName: 'staged.hwpx', bytes: docBytesSync(await sample()), by: user.name }).id;
  const result = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '내용과 서식을 고쳐줘', options: { workflow: 'content_format' } }, user);
  assert.equal(result.request.status, 'done', result.request.error); assert.equal(seen.length, 2);
  assert.equal(store.readMeta(docId).proposals.length, 1);
});

for (const provider of ['codex', 'claude']) test(`${provider} 실제 CLI/stdio 경계: 단계마다 별도 프로세스·작업 폴더·입력`, { timeout: 60000 }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-cli-')), receipt = path.join(tmp, 'receipt.json');
  const launch = await (provider === 'codex' ? fakeCodex : fakeClaude)(tmp, { mode: 'workspace', receipt });
  const deps = { tempRoot: tmp, env: process.env, resolveCommand: async () => launch };
  const ai = provider === 'codex' ? new CodexProposer({ model: 'gpt-6.1-sol' }, deps) : new ClaudeCodeProposer({ model: 'claude-opus-5-5' }, deps);
  const srv = await startServer(EXPERIMENT); const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, docBytesSync(await sample()));
  const req = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용과 형식을 고쳐줘', route: 'queue', target: { ref: 's0/p1' }, options: { workflow: 'content_format' } } })).request;
  const worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 30 } });
  t.after(async () => { await worker.stop(); await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  worker.start(); let current; const until = Date.now() + 45000;
  do { current = await api(`/api/docs/${doc.id}/requests/${req.rid}`); if (['done', 'failed'].includes(current.status)) break; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < until);
  assert.equal(current.status, 'done', current.error);
  const runs = fs.readFileSync(receipt + '.workspace.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(runs.map(r => r.stage), ['content', 'format']); assert.equal(new Set(runs.map(r => r.pid)).size, 2); assert.equal(new Set(runs.map(r => r.cwd)).size, 2);
  assert.ok(!runs[1].prompt.includes('"tool_use"')); assert.match(runs[1].prompt, /두 번째/);
  assert.equal((await api(`/api/docs/${doc.id}/proposals`)).length, 1);
});

for (const provider of ['openai', 'gemini']) test(`${provider} API 어댑터도 새 대화 두 개로 내용과 형식을 처리한다`, { timeout: 60000 }, async t => {
  const seen = [];
  const ai = new AiProposer({ ai: { enabled: true, provider, model: 'fake-workspace' } }, { key: 'fake-key', fetch: async (_url, init) => {
    const body = JSON.parse(init.body); seen.push(body); const stage = seen.length === 1 ? 'content' : 'format';
    if (provider === 'gemini') assert.equal(body.contents.length, 1); else assert.ok(!body.input.some(item => item.type === 'function_call_output'));
    const args = stage === 'content' ? { stage, revision: 0, operations: [{ op: 'replace', args: { ref: 's0/p1', find: '둘째', replace: '두 번째' } }], complete_stage: true, summary: '내용 완료' }
      : { stage, revision: 1, operations: [{ op: 'format', args: { refs: ['s0/p1'], format: { char: { bold: true } } } }], complete_stage: true, summary: '형식 완료' };
    const response = provider === 'openai' ? { status: 'completed', model: 'fake-workspace', output: [{ type: 'function_call', call_id: 'edit-' + stage, name: 'edit_workspace', arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 20 } }
      : { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { id: 'edit-' + stage, name: 'edit_workspace', args } }] } }], modelVersion: 'fake-workspace', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } };
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
  } });
  const srv = await startServer(EXPERIMENT), api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, docBytesSync(await sample()));
  const req = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용과 서식을 정리', route: 'queue', target: { ref: 's0/p1' }, options: { workflow: 'content_format' } } })).request;
  const worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 30 } });
  t.after(async () => { await worker.stop(); await srv.stop(); }); worker.start();
  let current; const deadline = Date.now() + 20000;
  do { current = await api(`/api/docs/${doc.id}/requests/${req.rid}`); if (['done', 'failed'].includes(current.status)) break; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < deadline);
  assert.equal(current.status, 'done', current.error); assert.equal(seen.length, 2); assert.equal(current.usage.modelCalls, 2);
});

test('옛 실행기는 실험 요청을 선점하지 않고 지원을 선언한 연결만 가져온다', { timeout: 30000 }, async t => {
  const x = await setup(t);
  const second = (await x.api(`${x.D}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', instruction: '실험', target: { ref: 's0/p1' }, options: { workflow: 'content_format' } } })).request;
  assert.equal((await x.call('claim_next_request')).none, true);
  const compatible = await x.call('claim_next_request', { workflows: ['content_format'] });
  assert.equal(compatible.rid, second.rid); assert.equal(compatible.editWorkflow.stage, 'content');
});

test('실험 API 작업공간의 결과 파일을 첨부로 회수하고 그림에 사용한다', { timeout: 30000 }, async t => {
  const srv = await startServer(EXPERIMENT), api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, docBytesSync(await sample()));
  const D = `/api/docs/${doc.id}`; let saved;
  await srv.api('admin')(`${D}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const ai = { supportsTools: true, agentName: '모의 파일 AI', async run(input, { toolContext }) {
    const stage = input.editWorkflow.stage;
    if (stage === 'content') saved = await toolContext.saveFile({ name: 'generated.png', bytes: makePng(4, 4) });
    await toolContext.call('edit_workspace', { stage, revision: input.editWorkflow.revision,
      operations: stage === 'content' ? [{ op: 'figure', args: { after_ref: 's0/p2', attachment_id: saved.aid, caption: '회수한 그림', width_mm: 40 } }] : [],
      complete_stage: true, summary: stage + ' 완료', ...(stage === 'format' ? { no_changes_reason: '저장된 그림의 크기를 확인했으며 추가 서식 변경이 필요 없습니다.' } : {}) });
    return { usage: { input: 1, output: 1, modelCalls: 1 }, model: 'fake-file' };
  } };
  const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '그림 파일을 만들고 넣어줘', route: 'queue', target: { ref: 's0/p2' }, options: { workflow: 'content_format' } } })).request;
  const worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {}, timing: { pollMs: 30 } });
  t.after(async () => { await worker.stop(); await srv.stop(); }); worker.start();
  let current; const until = Date.now() + 20000;
  do { current = await api(`${D}/requests/${req.rid}`); if (['done', 'failed'].includes(current.status)) break; await new Promise(r => setTimeout(r, 30)); } while (Date.now() < until);
  assert.equal(current.status, 'done', current.error); assert.ok(saved.aid);
  const [proposal] = await api(`${D}/proposals`); await srv.api('admin')(`${D}/proposals/${proposal.pid}/apply`, { method: 'POST', body: {} });
  const result = await HwpxDoc.load(await api(`${D}/file?kind=working`)); assert.equal(result.sections[0].xml.includes('<hp:pic'), true);
  assert.ok(result.authors().some(a => a.name === proposal.by), '실제 반영자와 제안 작성자 표기를 구분한다');
});

// 2026-11-16 사용자 결정: 내용·형식 나눠 처리(실험)는 쓰지 않는다 — 기본으로 꺼져 있다(config.experiments.contentFormat).
test('실험이 꺼져 있으면(기본) 그 방식을 받지 않는다: 선택 칸 없음 · 새 요청은 보통 방식 · 그 방식으로 맡기 거절 · 남은 요청은 실패로 닫고 다시 요청하면 보통 방식', { timeout: 60000 }, async t => {
  const srv = await startServer(EXPERIMENT);
  const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, docBytesSync(await sample())), D = `/api/docs/${doc.id}`;
  const make = async (options) => (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '내용과 서식을 정리', route: 'queue', target: { ref: 's0/p1' }, options } })).request;
  const left = await make({ workflow: 'content_format' });   // 실험이 켜져 있을 때 만든 요청(운영에 남아 있을 수 있는 꼴)
  assert.equal(left.options.workflow, 'content_format');
  // 실험 설정을 지우고 다시 띄운다 = 기본값(끔)
  const cfg = JSON.parse(fs.readFileSync(srv.configPath, 'utf8')); delete cfg.experiments; fs.writeFileSync(srv.configPath, JSON.stringify(cfg));
  await srv.restart();
  const client = new Client({ name: 'experiment-off', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': 'experiment-off' } } });
  await client.connect(transport);
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close(); await srv.stop(); });
  const tool = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const text = r.content[0].text; return r.isError ? { error: text } : { value: JSON.parse(text) }; };
  assert.equal((await api('/api/config')).features.contentFormatWorkflow, false, '편집기는 이 값이 false 면 선택 칸을 보이지 않는다');
  // 새 요청: 그 선택을 버리고 보통 방식으로 만든다(열려 있던 편집기 창이 예전 선택 칸으로 보내도 실패하지 않는다)
  const plain = await make({ workflow: 'content_format' });
  assert.equal(plain.options.workflow, undefined);
  // 보통 요청을 실험 방식으로 맡으려는 호출은 거절하고 요청은 그대로 둔다
  assert.match((await tool('start_request', { doc_id: doc.id, request_id: plain.rid, workflow: 'content_format' })).error, /EDIT_WORKFLOW_OFF/);
  assert.equal((await api(`${D}/requests/${plain.rid}`)).status, 'pending');
  // 대기열에서 꺼내기: 남아 있던 실험 요청은 맡기지 않고 실패로 닫으며, 보통 요청을 준다(workflows 를 밝혀도 같다)
  const got = await tool('claim_next_request', { doc_id: doc.id, workflows: ['content_format'] });
  assert.equal(got.value.rid, plain.rid); assert.equal(got.value.editWorkflow, undefined);
  const closed = await api(`${D}/requests/${left.rid}`);
  assert.deepEqual([closed.status, closed.log.at(-1).action, closed.log.at(-1).detail], ['failed', 'failed', '실험 방식 끝냄']);
  assert.match(closed.error, /^내용·형식 나눠 처리\(실험\)는 더 쓰지 않아/);
  // 사본 도구는 받지 않는다. 보통 요청에는 '이 도구만 꺼져 있다 — 보통 도구로 계속'(2026-11-17: 일반 요청을 맡은 Claude 가 첫 호출로 get_edit_workspace 를
  // 불렀다가 '이 요청은 그만두세요'를 받았다 — 요청을 버릴 까닭이 없다). 오류 코드는 그대로
  for (const [name, args] of [['get_edit_workspace', {}], ['edit_workspace', { stage: 'content', revision: 0, operations: [] }]]) {
    const err = (await tool(name, { doc_id: doc.id, request_id: plain.rid, expected_attempt: 1, ...args })).error;
    assert.match(err, /EDIT_WORKFLOW_OFF/, name);
    assert.doesNotMatch(err, /그만두세요/, name);
    assert.match(err, /꺼져 있습니다.*계속 처리하세요/, name);
  }
  // 실험 방식으로 맡긴 요청(실패로 닫힌 것)은 예전 뜻 그대로. 끝난 요청이라도 사본을 새로 만들지 않는다(예전에는 처리 중이 아닌 요청이면 실험이 꺼져도 사본을 만들어 읽어 줬다)
  const leftErr = (await tool('get_edit_workspace', { doc_id: doc.id, request_id: left.rid, expected_attempt: 1 })).error;
  assert.match(leftErr, /EDIT_WORKFLOW_OFF/);
  assert.match(leftErr, /이 요청은 그만두세요/);
  // 사람이 다시 요청하면 보통 방식으로 돈다
  await api(`${D}/requests/${left.rid}/retry`, { method: 'POST', body: {} });
  const again = await api(`${D}/requests/${left.rid}`);
  assert.deepEqual([again.status, again.options.workflow, again.error], ['pending', undefined, null]);
});
