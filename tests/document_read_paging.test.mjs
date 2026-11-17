import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../server/service.js';
import { modelToolResult, proposalToolResult } from '../server/editor-instructions.js';
import { leanReceipt } from '../server/lean.js';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCodexMcpBridge } from '../server/codex-mcp.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const paragraph = (section, body, text, nested) => ({ ref: `s${section}/p${body}${nested != null ? `/n${nested}` : ''}`,
  section, body: nested == null ? body : null, where: nested == null ? '본문' : '표', text });
const readFrom = paras => (opts = {}) => Service.prototype.readText.call({ paragraphs: async () => paras }, 'paging-test', opts);

test('구역마다 p0으로 돌아가도 from/to는 문서 전체 본문 차례로 선택한다', async () => {
  const paras = Array.from({ length: 20 }, (_, s) => [paragraph(s, 0, `구역${s}`), paragraph(s, 0, `셀${s}`, 1)]).flat();
  const read = readFrom(paras);
  const r = await read({ from: 13, to: 16 });
  assert.deepEqual(r.fragments.map(x => x.ref), ['s13/p0', 's13/p0/n1', 's14/p0', 's14/p0/n1', 's15/p0', 's15/p0/n1']);
  assert.equal(r.bodyParagraphs, 20); assert.equal(r.to, 16); assert.equal(r.truncated, false);
  assert.equal((await read({ from: 2, to: 7, nested: false })).fragments.filter(x => !x.ref.includes('/n')).length, 5);
});

test('본문 하나 아래 수많은 표 셀과 긴 이모지 문단도 cursor로 누락·중복 없이 읽는다', async () => {
  const paras = [paragraph(0, 0, '표 본문'), ...Array.from({ length: 35 }, (_, n) => paragraph(0, 0, `셀${n}: ` + '한글😀𠮷'.repeat(19), n)), paragraph(1, 0, '마지막 구역')];
  const read = readFrom(paras), received = new Map(); let cursor, pages = 0;
  do {
    const r = await read({ cursor, maxChars: 79 });
    assert.ok(r.text.length <= 79);
    for (const f of r.fragments) {
      const existing = received.get(f.ref) || '';
      assert.equal(f.start, existing.length, '정확한 다음 글자부터 이어진다');
      assert.ok(!/[\uD800-\uDBFF]$/.test(f.text)); assert.ok(!/^[\uDC00-\uDFFF]/.test(f.text));
      received.set(f.ref, existing + f.text);
    }
    cursor = r.nextCursor; assert.equal(r.truncated, !!cursor);
    assert.ok(++pages < 400, '끝까지 진전해야 한다');
  } while (cursor);
  assert.deepEqual([...received], paras.map(p => [p.ref, p.text]));
});

test('cursor는 문서·범위·보기와 묶이고 원문이 바뀌면 조용히 건너뛰지 않는다', async () => {
  const paras = [paragraph(0, 0, '긴 글'.repeat(80)), paragraph(1, 0, '마지막')];
  const read = readFrom(paras), first = await read({ maxChars: 60, from: 0, to: 2, view: 'markup' });
  assert.ok(first.nextCursor);
  for (const args of [{ cursor: 'broken' }, { cursor: first.nextCursor, view: 'final' }, { cursor: first.nextCursor, view: 'markup', from: 1 }]) {
    await assert.rejects(read(args), { code: 'BAD_CURSOR' });
  }
  await assert.rejects(Service.prototype.readText.call({ paragraphs: async () => paras }, 'another-doc', { cursor: first.nextCursor, view: 'markup' }), { code: 'BAD_CURSOR' });
  paras[0].text += '수정';
  await assert.rejects(read({ cursor: first.nextCursor, view: 'markup' }), { code: 'READ_CHANGED' });
});

test('모델 제안 응답은 내부 undo만 제외하고 제안 글·실패·이미지·서버 원본은 보존한다', () => {
  const proposal = { pid: 1, type: 'table_edit', ref: 's0/p1', status: 'applied', tableUndo: { before: '<xml>'.repeat(100000) },
    formatUndo: { before: 'x' }, objectUndo: {}, childSnapshot: {}, reason: '가운데 정렬',
    table: { rows: [['원문', '그대로']], userUndo: '표 안의 같은 이름은 보존' }, warning: '검증 경고', log: ['기록'] };
  const value = [{ ok: true, proposal }, { ok: false, error: 'BAD_REF', message: '주소 오류' }];
  const raw = { content: [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', mimeType: 'image/png', data: 'AA==' }], structuredContent: { results: value }, _meta: { keep: true } };
  const projected = proposalToolResult('propose_changes', raw);
  const expected = { ...proposal }; for (const k of ['tableUndo', 'formatUndo', 'objectUndo', 'childSnapshot']) delete expected[k];
  assert.deepEqual(JSON.parse(projected.content[0].text), [{ ok: true, proposal: expected }, value[1]]);
  assert.deepEqual(projected.structuredContent.results[0].proposal, expected);
  assert.equal(projected.content[1], raw.content[1]); assert.equal(projected._meta, raw._meta);
  assert.ok(raw.content[0].text.includes('tableUndo') && proposal.tableUndo.before.length === 500000, '원본 기록을 고치지 않음');
  assert.equal(modelToolResult('get_formatting', raw), raw);
  assert.equal(proposalToolResult('list_proposals', { ...raw, isError: true }).content[0], raw.content[0]);
  assert.deepEqual(JSON.parse(modelToolResult('list_proposals', { content: [{ type: 'text', text: JSON.stringify([proposal]) }] }).content[0].text), [expected]);
  assert.ok(!('tableUndo' in leanReceipt('propose_table_edit', proposal)));
});

test('실제 MCP·API·Codex: 20구역 표 전체 열거·범위 읽기·cursor·undo 보존', { timeout: 60000 }, async () => {
  const source = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  source.insertTableAfter(0, 0, { rows: [['항목', '값'], ['첫째', '본문'.repeat(120)]], headerRows: 1, caption: '목록 시험 표' }, { author: '시험' });
  source.acceptAll();
  const xml = source.sections[0].xml;
  source.sections = Array.from({ length: 20 }, (_, i) => new Section(xml, i)); source._rewriteSectionFiles();
  const bytes = await source.save();
  const srv = await startServer({ config: { limits: { mcpResponseChars: 5000 } } });
  let remote, transport, bridge, codex;
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.admin, bytes, '20-section-tables.hwpx');
    const D = `/api/docs/${doc.id}`, api = srv.api('admin');
    remote = new Client({ name: 'paging-test', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.admin}`, 'X-Hwpx-Agent-Session': 'paging-session' } } });
    await remote.connect(transport);
    const call = async (name, args = {}) => {
      const r = await remote.callTool({ name, arguments: { doc_id: doc.id, ...args } });
      assert.ok(!r.isError, r.content[0].text); const text = r.content[0].text;
      try { return JSON.parse(text); } catch { return text; }
    };
    const inventory = []; let from = 0;
    do { const page = await call('list_tables', { from, limit: 3 }); assert.equal(page.total, 20); inventory.push(...page.tables); from = page.nextFrom; } while (from != null);
    assert.equal(new Set(inventory.map(t => t.key)).size, 20); assert.equal(inventory[19].ref, 's19/p1');
    assert.ok(inventory.every(t => t.rows === 2 && t.cols === 2 && !t.cells));
    // 기존 본문 3개 + 삽입 표 본문 1개 = 구역당 4개. 13번째 구역은 전역 52..56.
    const full = await call('read_document', { from: 52, to: 56, nested: false });
    assert.match(full, /\[s13\/p0\]/); assert.match(full, /\[s13\/p3\]/); assert.ok(!full.includes('[s0/'));
    const first = await call('read_document', { from: 4, to: 8, max_chars: 130 });
    const pageMeta = JSON.parse(first.split('\n이어 읽기: ')[1]); assert.equal(pageMeta.truncated, true);
    const next = await call('read_document', { cursor: pageMeta.cursor, max_chars: 130 });
    assert.notEqual(next, first); assert.match(next, /s1\//);
    const req = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '모든 표를 가운데 정렬', route: 'queue', target: { scope: 'document', ref: 's0/p0' } } })).request;
    const request = await call('get_request', { request_id: req.rid }); assert.equal(request.tableInventory.total, 20);
    const toolContext = await createApiToolContext({ docId: doc.id, requestId: req.rid, attempt: 1, listTools: () => remote.listTools(), assertCurrent: async () => {}, callTool: (name, args) => remote.callTool({ name, arguments: args }) });
    assert.equal(JSON.parse((await toolContext.call('list_tables', { limit: 100 })).content[0].text).total, 20);
    bridge = await createCodexMcpBridge({ job: { type: 'request', docId: doc.id, requestId: req.rid, attempt: 1 }, url: `${srv.base}/mcp`, token: srv.tokens.admin, session: 'paging-session', log() {} });
    codex = new Client({ name: 'native-model-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b); await codex.connect(a);
    const nativeInventory = await codex.callTool({ name: 'list_tables', arguments: {} }); assert.ok(!nativeInventory.isError); assert.equal(JSON.parse(nativeInventory.content[0].text).total, 20);
    const made = await call('propose_table_edit', { table: inventory[0].key, ops: [{ op: 'table', align: 'CENTER' }] });
    await call('apply_proposal', { proposal_id: made.pid });
    const saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'docs', doc.id, 'meta.json'), 'utf8')).proposals.find(p => p.pid === made.pid);
    assert.ok(saved.tableUndo?.before, '운영 데이터 대신 임시 문서의 실제 undo 기록을 확인');
    const listed = (await call('list_proposals')).find(p => p.pid === made.pid);
    assert.equal(listed.tableUndo, undefined); assert.deepEqual(listed.tableEdit, saved.tableEdit);
    await call('undo_proposal', { proposal_id: made.pid });
    assert.equal((await call('list_proposals')).find(p => p.pid === made.pid).status, 'undone');
  } finally {
    await codex?.close().catch(() => {}); await bridge?.stop(); await transport?.terminateSession().catch(() => {}); await remote?.close().catch(() => {}); await srv.stop();
  }
});
