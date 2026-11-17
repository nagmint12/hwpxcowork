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

// 되풀이 막기(2026-11-16): 처리 도중 서버·실행기가 죽으면 실패 보고 없이 lease 만 끝나고, 실행기는 그 요청을 다시 맡아 같은 일을 되풀이한다
// (2026-11-14 밤 한 요청이 16분마다 43번 다시 돌았다). 이어받기 한도(config.agents.maxTakeovers, 기본 3)를 넘으면 실패로 닫는다.
test('lease 가 끝난 요청을 이어받는 횟수에는 한도가 있다 — 넘으면 실패로 닫고, 다시 요청하면 다시 센다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { agents: { leaseMinutes: 0.005, othersCanTake: false, maxTakeovers: 2 } } });   // lease 300ms
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const api = srv.api('a'); const R = `/api/docs/${doc.id}/requests`;
    const req = (await api(R, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const view = () => api(`${R}/${req.rid}`);
    const expire = async () => { const v = await view(); await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(v.claim.expires) - Date.now() + 60))); };
    await call(srv, 'w0', 'start_request', { doc_id: doc.id, request_id: req.rid });
    await call(srv, 'w0', 'start_request', { doc_id: doc.id, request_id: req.rid });   // 같은 세션이 이어 가는 것은 세지 않는다
    assert.equal((await view()).takeovers ?? 0, 0);
    // 한도(2번)까지는 다른 세션이 이어받는다
    for (const [i, session] of ['w1', 'w2'].entries()) {
      await expire();
      const got = await call(srv, session, 'claim_next_request', { doc_id: doc.id });
      assert.equal(got.rid, req.rid);
      const v = await view();
      assert.deepEqual([v.status, v.claim.session, v.takeovers, v.log.at(-1).detail], ['working', session, i + 1, '처리 이어받음']);
    }
    // 세 번째는 맡기지 않고 실패로 닫는다: 대기열에서 꺼내면 없음, 그 요청을 직접 맡으려 하면 오류
    await expire();
    assert.deepEqual(await call(srv, 'w3', 'claim_next_request', { doc_id: doc.id }), { none: true });
    const closed = await view();
    assert.equal(closed.status, 'failed');
    assert.match(closed.error, /^처리 도중 3번 멈췄습니다.*자동으로 다시 맡지 않습니다/);
    assert.deepEqual([closed.log.at(-1).action, closed.log.at(-1).detail], ['failed', '되풀이 멈춤']);
    await assert.rejects(call(srv, 'w3', 'start_request', { doc_id: doc.id, request_id: req.rid }), /대기 중인 요청만 시작할 수 있습니다/);
    assert.deepEqual(await call(srv, 'w3', 'claim_next_request', { doc_id: doc.id }), { none: true });
    // 사람이 다시 요청하면 처음부터 다시 센다
    await api(`${R}/${req.rid}/retry`, { method: 'POST', body: {} });
    const again = await call(srv, 'w4', 'claim_next_request', { doc_id: doc.id });
    assert.equal(again.rid, req.rid);
    const fresh = await view();
    assert.deepEqual([fresh.status, fresh.takeovers, fresh.error], ['working', 0, null]);
  } finally {
    await srv.stop();
  }
});

test('이어받기 한도의 기본값은 3번이다 — 네 번째 이어받기에서 닫는다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { agents: { leaseMinutes: 0.005, othersCanTake: false } } });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const api = srv.api('a'); const R = `/api/docs/${doc.id}/requests`;
    const req = (await api(R, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const expire = async () => { const v = await api(`${R}/${req.rid}`); await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(v.claim.expires) - Date.now() + 60))); };
    await call(srv, 'w0', 'start_request', { doc_id: doc.id, request_id: req.rid });
    for (const session of ['w1', 'w2', 'w3']) { await expire(); assert.equal((await call(srv, session, 'claim_next_request', { doc_id: doc.id })).rid, req.rid); }
    await expire();
    assert.deepEqual(await call(srv, 'w4', 'claim_next_request', { doc_id: doc.id }), { none: true });
    const closed = await api(`${R}/${req.rid}`);
    assert.deepEqual([closed.status, closed.takeovers], ['failed', 3]);
    assert.match(closed.error, /^처리 도중 4번 멈췄습니다/);
  } finally {
    await srv.stop();
  }
});
