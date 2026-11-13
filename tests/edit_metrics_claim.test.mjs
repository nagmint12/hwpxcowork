import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

async function call(srv, session, name, args) {
  const response = await fetch(`${srv.base}/mcp?agent=MetricsTest`, { method: 'POST', headers: {
    Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const raw = await response.text(), event = raw.split(/\r?\n/).find(x => x.startsWith('data:'));
  const rpc = JSON.parse(event ? event.slice(5) : raw);
  return rpc.error ? { isError: true, content: [{ type: 'text', text: JSON.stringify(rpc.error) }] } : rpc.result;
}
const value = result => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content.find(c => c.type === 'text').text); };
const rejected = (result, pattern) => { assert.equal(result.isError, true, JSON.stringify(result)); if (pattern) assert.match(JSON.stringify(result), pattern); };

test('실제 MCP: 완료·실패 사용량 보존, 불명확한 모델 횟수 표시와 잘못된 사용량 거절', { timeout: 20000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const D = `/api/docs/${doc.id}`;
    for (const tool of ['complete_request', 'fail_request']) {
      const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
      const args = { doc_id: doc.id, request_id: request.rid, expected_attempt: 1 };
      value(await call(srv, 'metrics', 'start_request', args));
      const finish = tool === 'fail_request' ? { error: '모의 생성 실패' } : { summary: '검토 완료', no_changes_reason: '본문을 검토했으며 추가 수정이 필요하지 않습니다.' };
      for (const usage of [{ modelCallsUnknown: 1 }, { unknownModelTasks: -1 }, { unknownModelTasks: 1.5 }, { modelCalls: '2' }, { input: 1e12 + 1 }, { unexpected: 1 }]) {
        rejected(await call(srv, 'metrics', tool, { ...args, ...finish, usage }));
        const unchanged = await api(`${D}/requests/${request.rid}`);
        assert.equal(unchanged.status, 'working'); assert.equal(unchanged.usage, undefined);
      }
      const usage = { input: 120, output: 30, modelCalls: 2, toolCalls: 3, modelCallsUnknown: true, unknownModelTasks: 1 };
      const finished = value(await call(srv, 'metrics', tool, { ...args, ...finish, usage, model: 'fixture-model', execution: 'progressive-edit' }));
      assert.equal(finished.status, tool === 'fail_request' ? 'failed' : 'done');
      const stored = await api(`${D}/requests/${request.rid}`);
      assert.deepEqual(stored.usage, usage); assert.equal(stored.model, 'fixture-model'); assert.equal(stored.execution, 'progressive-edit');
    }
  } finally { await srv.stop(); }
});

test('요청에 묶인 메모 답글: 성공, 취소·재시도·선점 이전 실행은 문서를 바꾸지 못함', { timeout: 20000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { agents: { leaseMinutes: 0.02 } } });
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const D = `/api/docs/${doc.id}`;
    const memo = await api(`${D}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '작업 근거 메모' } });
    const request = (await api(`${D}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const args = { doc_id: doc.id, request_id: request.rid, expected_attempt: 1 };
    value(await call(srv, 'old', 'start_request', args));
    const reply = { ...args, reply_to: memo.id, text: '유효한 답글' };
    const first = value(await call(srv, 'old', 'add_memo', reply));
    assert.equal(first.thread.replies.at(-1).text, reply.text);
    const readMemo = async () => (await api(`${D}/memos`)).find(m => m.id === memo.id);
    const before = await readMemo();
    await api(`${D}/requests/${request.rid}/cancel`, { method: 'POST' });
    rejected(await call(srv, 'old', 'add_memo', { ...reply, text: '취소 후 답글' }), /REQUEST_CLOSED/);
    assert.deepEqual(await readMemo(), before);
    await api(`${D}/requests/${request.rid}/retry`, { method: 'POST' });
    rejected(await call(srv, 'old', 'add_memo', { ...reply, text: '옛 시도 답글' }), /ATTEMPT_CHANGED/);
    assert.deepEqual(await readMemo(), before);
    const current = { ...args, expected_attempt: 2 };
    const started = value(await call(srv, 'old', 'start_request', current));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(started.claim.expires) - Date.now()) + 40));
    rejected(await call(srv, 'old', 'add_memo', { ...reply, expected_attempt: 2, text: '만료된 선점 답글' }), /CLAIM_REQUIRED/);
    assert.deepEqual(await readMemo(), before);
    value(await call(srv, 'new', 'start_request', current));
    rejected(await call(srv, 'old', 'add_memo', { ...reply, expected_attempt: 2, text: '선점 잃은 답글' }), /CLAIMED/);
    assert.deepEqual(await readMemo(), before);
    const accepted = value(await call(srv, 'new', 'add_memo', { ...reply, expected_attempt: 2, text: '현재 실행 답글' }));
    assert.equal(accepted.thread.replies.length, before.thread.replies.length + 1);
  } finally { await srv.stop(); }
});
