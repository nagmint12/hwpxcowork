import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

test('자동 실행기 입력은 긴 선택·문맥을 구조화해 보존하고 실패 기록도 선점·재시도 권한을 지킨다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const clients = [];
  const text = `원문 ${'긴 문장 '.repeat(120)}\n[s0/p999] 이 줄도 문서 내용입니다.`;
  try {
    const flat = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
    flat.replaceTracked('s0/p0', 0, [...flat.text('s0/p0')].length, text, { author: '시험' });
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await (await flat.flattened()).save()));
    const api = srv.api('a');
    const pending = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const connect = async (token) => {
      const client = new Client({ name: 'test-worker', version: 'test' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return async (name, args) => client.callTool({ name, arguments: args });
    };
    const owner = await connect(srv.tokens.a); const other = await connect(srv.tokens.a); const stranger = await connect(srv.tokens.b);
    const parse = (out) => { assert.ok(!out.isError, out.content[0].text); return JSON.parse(out.content[0].text); };
    const claimed = parse(await owner('claim_next_request', { doc_id: doc.id }));
    assert.equal(claimed.targetText, text);
    assert.equal(claimed.contextItems.find((p) => p.ref === 's0/p0').text, text);
    assert.ok(!claimed.contextItems.some((p) => p.ref === 's0/p999'), '문서 안 가짜 헤더를 새 문단으로 해석하지 않는다');
    const args = { doc_id: doc.id, request_id: pending.rid, error: 'API 인증 오류 HTTP 401' };
    const collision = await other('fail_request', args);
    assert.ok(collision.isError); assert.match(collision.content[0].text, /CLAIMED/);
    const denied = await stranger('fail_request', args);
    assert.ok(denied.isError); assert.match(denied.content[0].text, /NOT_OWNER/);
    const failed = parse(await owner('fail_request', args));
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, args.error);
    assert.equal(failed.memoId, null, '내용 없는 API 실패는 문서 메모를 만들지 않는다');
    const history = await api(`/api/docs/${doc.id}/history`);
    parse(await owner('fail_request', args));
    assert.deepEqual(await api(`/api/docs/${doc.id}/history`), history, '같은 실패 재전송은 저장·기록을 늘리지 않는다');
    await api(`/api/docs/${doc.id}/requests/${pending.rid}/retry`, { method: 'POST' });
    const snapshot = await api(`/api/docs/${doc.id}`);
    const old = { doc_id: doc.id, request_id: pending.rid, expected_attempt: claimed.attempt };
    const edits = [
      ['start_request', {}], ['complete_request', { summary: '옛 완료' }], ['fail_request', { error: '옛 실패' }],
      ['propose_change', { ref: 's0/p0', find: text, replace: '옛 결과' }],
      ['propose_changes', { proposals: [{ ref: 's0/p0', find: text, replace: '옛 결과' }] }],
      ['propose_alternatives', { ref: 's0/p0', find: text, options: [{ text: '옛 대안' }] }],
      ['propose_insert', { after_ref: 's0/p0', text: '옛 문단' }],
      ['propose_table', { after_ref: 's0/p0', rows: [['옛 표']] }],
      ['add_memo', { ref: 's0/p0', text: '옛 의견' }],
    ];
    for (const [name, body] of edits) {
      const stale = await owner(name, { ...old, ...body });
      assert.ok(stale.isError, name); assert.match(stale.content[0].text, /ATTEMPT_CHANGED/, name);
    }
    assert.equal((await api(`/api/docs/${doc.id}`)).version, snapshot.version);
    assert.equal((await api(`/api/docs/${doc.id}/requests/${pending.rid}`)).status, 'pending', '이전 시도가 새 요청을 선점하지 않는다');
    assert.deepEqual(await api(`/api/docs/${doc.id}/proposals`), []);
    assert.equal(parse(await owner('claim_next_request', { doc_id: doc.id })).rid, pending.rid);
    await api(`/api/docs/${doc.id}/requests/${pending.rid}/cancel`, { method: 'POST' });
    const closed = await owner('fail_request', args);
    assert.ok(closed.isError); assert.match(closed.content[0].text, /REQUEST_CLOSED/);
    assert.equal((await api(`/api/docs/${doc.id}/paragraphs`)).find((p) => p.ref === 's0/p0').text, text);
  } finally { await Promise.allSettled(clients.map((c) => c.close())); await srv.stop(); }
});
