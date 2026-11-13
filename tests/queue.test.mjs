// 격리 서버와 MCP HTTP 경로로 재시작·만료 작업 회수·동시 선점의 실제 동작을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

async function call(srv, session, name, args) {
  const response = await fetch(`${srv.base}/mcp?agent=QueueTest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const event = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const rpc = JSON.parse(event ? event.slice(5) : raw);
  assert.ok(!rpc.error, JSON.stringify(rpc.error));
  const result = rpc.result;
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('재시작 후 만료된 working부터 회수하고 같은 세션의 동시 claim_next도 중복 선점하지 않는다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { agents: { leaseMinutes: 0.03, othersCanTake: false } } });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const create = () => srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } });
    const first = (await create()).request;
    const second = (await create()).request;
    await call(srv, 'old_worker', 'start_request', { doc_id: doc.id, request_id: first.rid });
    const paragraphs = await srv.api('a')(`/api/docs/${doc.id}/paragraphs`);
    const original = paragraphs.find((p) => p.ref === 's0/p0').text;
    const proposal = await call(srv, 'old_worker', 'propose_change', { doc_id: doc.id, request_id: first.rid, ref: 's0/p0', find: original, replace: `${original} 확인` });
    const comment = await call(srv, 'old_worker', 'add_memo', { doc_id: doc.id, request_id: first.rid, ref: 's0/p0', text: '근거 자료 확인이 필요합니다.' });
    await srv.restart();
    const restored = await srv.api('a')(`/api/docs/${doc.id}/requests/${first.rid}`);
    assert.equal(restored.status, 'working');
    assert.equal(restored.claim.session, 'old_worker');
    const delay = Math.max(0, Date.parse(restored.claim.expires) - Date.now() + 80);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const recovered = await call(srv, 'new_worker', 'claim_next_request', { doc_id: doc.id });
    assert.equal(recovered.rid, first.rid, '더 오래된 만료 작업이 새 pending보다 먼저 처리되어야 함');
    assert.equal(recovered.claim.mine, true);
    assert.equal(recovered.existingResults.proposals[0].pid, proposal.pid, '재시작 전 부분 제안 ID를 이어받는다');
    assert.ok(recovered.existingResults.comments.includes(comment.id), '재시작 전 확인 의견 ID를 이어받는다');
    assert.match(recovered.existingResults.resume, /남은 작업/);
    assert.equal((await srv.api('a')(`/api/docs/${doc.id}/proposals`)).length, 1, '회수 자체는 부분 결과를 다시 생성하지 않는다');
    const claimed = await srv.api('a')(`/api/docs/${doc.id}/requests/${first.rid}`);
    assert.equal(claimed.claim.session, 'new_worker');
    assert.equal(claimed.log.at(-1).detail, '처리 이어받음');
    const simultaneous = await Promise.all([1, 2, 3].map(() => call(srv, 'new_worker', 'claim_next_request', { doc_id: doc.id })));
    const assigned = simultaneous.filter((item) => item.claimed);
    assert.equal(assigned.length, 1, '같은 세션이 동시에 꺼내도 같은 요청을 두 번 받지 않아야 함');
    assert.equal(assigned[0].rid, second.rid);
    assert.equal(simultaneous.filter((item) => item.none).length, 2);
    const list = await call(srv, 'new_worker', 'list_requests', { doc_id: doc.id });
    assert.equal(list.length, 2);
    assert.ok(list.every((item) => item.status === 'working' && item.claim.mine));
  } finally {
    await srv.stop();
  }
});
