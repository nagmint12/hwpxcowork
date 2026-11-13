// 모델 없이 임시 HWPX·포트의 실제 MCP로 보고서 일괄 내용이 임의 개수에서 잘리지 않는지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

async function setup(source) {
  const srv = await startServer({ ai: 'off' });
  let client;
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, source || fixture('tool_memo_tracked.hwpx'));
    const api = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const original = await api(`${D}/paragraphs`);
    const request = (await api(`${D}/requests`, { method: 'POST', body: {
      kind: 'instruct', route: 'queue', target: { ref: original[0].ref, scope: 'document' },
      instruction: '전체 보고서의 원문을 수정하고 필요한 문단과 자료 표를 빠짐없이 제안해 주세요.',
    } })).request;
    client = new Client({ name: 'native-report-batch-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=BatchTest`), {
      requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': 'native-report-batch-session' } },
    }));
    const args = { doc_id: doc.id, request_id: request.rid, expected_attempt: 1 };
    const raw = (name, input = {}) => client.callTool({ name, arguments: { ...args, ...input } });
    const call = async (name, input = {}) => {
      const result = await raw(name, input);
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
    };
    await call('start_request');
    return { srv, api, D, original, request, call, raw, close: async () => { await client.close(); await srv.stop(); } };
  } catch (e) { await client?.close(); await srv.stop(); throw e; }
}

test('native MCP는 한 번에 55문단 삽입·51원문 변경을 전부 저장하고 틀린 원문은 거절한다', { timeout: 20000 }, async () => {
  const source = await HwpxDoc.load(await fs.readFile(fixture('tool_memo_tracked.hwpx')));
  for (let i = 0; i < 51; i++) source.insertParagraphAfter(0, 0, `보고서 원문 ${i}: 근거와 분석을 설명한다.`, { author: '시험' });
  source.acceptAll();
  const x = await setup(Buffer.from(await source.save()));
  try {
    const paragraphs = Array.from({ length: 55 }, (_, i) => ({ text: `새 보고서 문단 ${i + 1}: 이 절의 결과와 시사점을 서술한다.` }));
    const inserted = await x.call('propose_insert', { after_ref: x.original[0].ref, paragraphs });
    assert.equal(inserted.length, 55); assert.ok(inserted.every(r => r.ok), JSON.stringify(inserted.filter(r => !r.ok)));
    assert.deepEqual(inserted.map(r => r.proposal.text), paragraphs.map(p => p.text));

    const targets = x.original.filter(p => p.text.startsWith('보고서 원문 '));
    assert.equal(targets.length, 51);
    const proposals = targets.map(p => ({ ref: p.ref, find: p.text, replace: p.text.replace('설명한다.', '종합하여 제시한다.'), reason: '보고서 표현을 통일한다.' }));
    const changed = await x.call('propose_changes', { proposals });
    assert.equal(changed.length, 51); assert.ok(changed.every(r => r.ok), JSON.stringify(changed.filter(r => !r.ok)));
    assert.deepEqual(changed.map(r => r.proposal.replace), proposals.map(p => p.replace));
    const invalid = await x.call('propose_changes', { proposals: [{ ref: targets.at(-1).ref, find: '문서에 없는 원문', replace: '잘못된 대체문' }] });
    assert.equal(invalid[0].ok, false, '배치 허용은 원문 검증을 건너뛰지 않는다');

    await x.call('complete_request', { summary: '55문단 추가안과 51곳 표현 개선안을 저장했습니다.' });
    const saved = (await x.api(`${x.D}/proposals`)).filter(p => p.rid === x.request.rid);
    assert.equal(saved.length, 106); assert.ok(saved.every(p => p.status === 'pending'));
    assert.equal(saved.filter(p => p.type === 'insert').at(-1).text, paragraphs.at(-1).text);
    assert.equal(saved.filter(p => p.type === 'replace').at(-1).replace, proposals.at(-1).replace);
    assert.deepEqual((await x.api(`${x.D}/paragraphs`)).map(p => p.text), x.original.map(p => p.text));
  } finally { await x.close(); }
});

test('native MCP는 201행·31열 표와 11머리행을 자르지 않고 pending 제안에 보존한다', { timeout: 15000 }, async () => {
  const x = await setup();
  try {
    const rows = Array.from({ length: 201 }, (_, r) => Array.from({ length: 31 }, (_, c) => `자료 ${r + 1}-${c + 1}`));
    rows[7].pop();
    rows[200][30] = '마지막 행·마지막 열의 실제 근거값';
    const result = await x.call('propose_table', { after_ref: x.original[0].ref, rows, header_rows: 11, caption: '전체 자료 표' });
    assert.equal(result.status, 'pending');
    const saved = (await x.api(`${x.D}/proposals`)).find(p => p.pid === result.pid);
    assert.equal(saved.table.rows.length, 201); assert.ok(saved.table.rows.every(r => r.length === 31));
    assert.equal(saved.table.headerRows, 11); assert.equal(saved.table.rows[7][30], '');
    assert.equal(saved.table.rows[200][30], rows[200][30]);
    assert.deepEqual(saved.table.rows[200], rows[200]);
    assert.deepEqual((await x.api(`${x.D}/paragraphs`)).map(p => p.text), x.original.map(p => p.text), '자료 표는 아직 본문에 삽입·렌더링하지 않는다');
  } finally { await x.close(); }
});
