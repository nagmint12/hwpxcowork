// AI 작업 진행 기록(server/activity.js — 편집기에 '지금 무슨 일을 하는지' 실시간으로) 회귀 시험. 모델을 부르지 않는다.
//  · 줄 글: 도구 이름에서 나온 낱말과 개수·범위만(문서 글·지시·검색어 없음)
//  · 임시 서버: 도구 호출마다 그 요청의 기록에 남고 WebSocket { type:'activity' } 로 온다. 맡지 않은 세션의 읽기는 남지 않는다
//  · 화면 줄 묶기(web/activity-rows.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, watchWs, fixture } from './helpers/server.mjs';
import { activityItem, isActivityTool, RequestActivity } from '../server/activity.js';
import { activityRows, secText } from '../web/activity-rows.js';

const json = (result) => { assert.ok(!result.isError, result.content?.[0]?.text); return JSON.parse(result.content.find((c) => c.type === 'text').text); };

test('activityItem: 도구 호출 → 줄 글(개수·범위만), 실패는 오류 코드만, 기록하지 않는 도구는 null', () => {
  assert.deepEqual(activityItem('read_document', { doc_id: 'd' }, { text: '본문 문단 387개 중 0..182' }), { tool: 'read_document', label: '문서 읽기 · 본문 0~182번 문단(모두 387개)', ok: true });
  assert.equal(activityItem('read_document', {}, { text: '다른 꼴' }).label, '문서 읽기');
  assert.equal(activityItem('search_document', { query: '비밀 검색어' }, { value: [1, 2, 3] }).label, '문서 검색 · 3곳');
  assert.equal(activityItem('get_formatting', { refs: ['s0/p1', 's0/p2'] }).label, '서식 확인 · 문단 2개');
  assert.equal(activityItem('propose_changes', { proposals: [{}, {}, {}] }, { value: [{ ok: true }, { ok: true }, { ok: false }] }).label, '수정 제안 2건(1건은 다시 내야 함)');
  assert.equal(activityItem('propose_changes', { proposals: [{}, {}] }, { value: { results: [{ ok: true }, { ok: true }], completed: true } }).label, '수정 제안 2건 · 완료');
  assert.equal(activityItem('propose_insert', { paragraphs: [{}, {}, {}] }).label, '문단 추가 3개');
  assert.equal(activityItem('propose_figure', { replace_ref: 's0/p3' }).label, '그림 교체 제안');
  assert.equal(activityItem('add_memo', { text: '의견 글', reply_to: 'memo3' }).label, '답글');
  assert.deepEqual(activityItem('add_memo', { text: '문서에 있던 글' }, { text: '오류(NO_REF): 문단 주소가 필요합니다 — 문서에 있던 글', isError: true }), { tool: 'add_memo', label: '의견 남김 — 안 됨(NO_REF)', ok: false });
  for (const item of [activityItem('search_document', { query: '비밀 검색어' }, { value: [] }), activityItem('add_memo', { text: '문서에 있던 글' }, { text: '오류(X): 문서에 있던 글', isError: true })]) assert.ok(!/비밀|문서에 있던/.test(item.label), '줄 글에 검색어·문서 글 없음');
  for (const skip of ['get_request', 'list_requests', 'list_documents', 'claim_orchestration_task', 'get_change_request']) { assert.equal(isActivityTool(skip), false); assert.equal(activityItem(skip, {}), null); }
  for (const keep of ['start_request', 'claim_next_request', 'read_document', 'propose_changes', 'add_memo', 'complete_request', 'propose_toc_update', 'preview_figure']) assert.equal(isActivityTool(keep), true);
});

test('activityItem(edit): 영수증 pages.all_applied 가 now 와 다를 때만 \' · 모두 반영하면 N쪽\'(숫자만)', () => {
  const ops = { ops: [{ op: 'replace' }, { op: 'replace' }] };
  assert.equal(activityItem('edit', ops, { value: { saved: [{ op: 0, pids: '1-2', count: 2 }], pages: { now: 5, all_applied: 4, last_page_fill: 0.6 } } }).label, '수정 제안 2 · 모두 반영하면 4쪽');
  assert.equal(activityItem('edit', { ...ops, dry_run: true }, { value: { dry_run: true, made: 2, pages: { now: 5, all_applied: 4 } } }).label, '미리 해 보기 · 수정 제안 2 · 모두 반영하면 4쪽');
  assert.equal(activityItem('edit', { ...ops, dry_run: true }, { value: { dry_run: true, failed: [{ op: 1 }], pages: { now: 5, all_applied: 6 } } }).label, '미리 해 보기 · 수정 제안 2(1건은 다시 내야 함) · 모두 반영하면 6쪽');
  for (const pages of [{ now: 5, all_applied: 5 }, { now: 5 }, { skipped: '쪽 수 어림이 꺼져 있다' }, undefined]) assert.equal(activityItem('edit', ops, { value: { saved: [], pages } }).label, '수정 제안 2');
  assert.equal(activityItem('edit', ops, { value: { saved: [], failed: [{ op: 0 }] } }).label, '수정 제안 2(1건 때문에 저장 안 됨 — 다시 내야 함)');
});

test('RequestActivity: 요청별로 쌓고 넘치면 오래된 것부터 버린다', () => {
  const log = new RequestActivity({ perRequest: 3, maxRequests: 2 });
  for (let i = 1; i <= 5; i++) log.add('d1', 1, { tool: 'read_document', label: `줄 ${i}`, ok: true }, `2026-11-10T00:00:0${i}Z`);
  assert.deepEqual(log.list('d1', 1).map((x) => x.label), ['줄 3', '줄 4', '줄 5']);
  assert.deepEqual(log.list('d1', 1).map((x) => x.n), [3, 4, 5]);
  log.add('d1', 2, { tool: 'add_memo', label: '의견 남김', ok: true }); log.add('d2', 1, { tool: 'add_memo', label: '의견 남김', ok: true });
  assert.equal(log.list('d1', 1).length, 0, '요청 수 상한을 넘으면 가장 오래 쓰지 않은 요청부터');
  assert.equal(log.list('d1', 2).length, 1); assert.equal(log.list('d2', '1').length, 1);
  log.clear('d1', 2); assert.equal(log.list('d1', 2).length, 0);
});

test('activityRows: 이어지는 같은 줄은 묶고, 줄 사이 생각·작성 시간(+n초)을 보인다', () => {
  const at = (s) => new Date(Date.UTC(2026, 10, 10, 1, 49, s)).toISOString();
  const rows = activityRows([
    { n: 1, at: at(5), ms: 100, label: '요청을 맡음', ok: true },
    { n: 2, at: at(8), ms: 40, label: '문서 읽기 · 본문 0~182번 문단(모두 387개)', ok: true },
    { n: 3, at: at(50), ms: 40, label: '문서 읽기 · 본문 183~386번 문단(모두 387개)', ok: true },
    { n: 4, at: at(52), ms: 300, label: '의견 남김', ok: true }, { n: 5, at: at(54), ms: 300, label: '의견 남김', ok: true }, { n: 6, at: at(56), ms: 300, label: '의견 남김', ok: true },
    { n: 7, at: at(57), ms: 200, label: '의견 남김 — 안 됨(NO_REF)', ok: false },
    { n: 8, at: at(59), ms: 250, label: '완료', ok: true },
  ]);
  assert.deepEqual(rows.map((r) => [r.label, r.count, r.gap]), [
    ['요청을 맡음', 1, ''], ['문서 읽기 · 본문 0~182번 문단(모두 387개)', 1, ''], ['문서 읽기 · 본문 183~386번 문단(모두 387개)', 1, '+42초'],
    ['의견 남김', 3, ''], ['의견 남김 — 안 됨(NO_REF)', 1, ''], ['완료', 1, ''],
  ]);
  assert.match(rows[0].time, /^\d\d:\d\d:05$/); assert.equal(rows[4].ok, false);
  assert.equal(secText(42400), '42초'); assert.equal(secText(215000), '3분 35초');
  assert.deepEqual(activityRows(null), []);
});

test('임시 서버: 도구 호출이 그 요청의 진행 기록에 남고 편집기에 실시간으로 온다', { timeout: 60000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const clients = []; let ws;
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const para = (await api(`${route}/paragraphs`)).find((p) => p.ref === 's0/p0'); const find = [...para.text].slice(0, 4).join('');
    const connect = async ({ lean = false, token = srv.tokens.a } = {}) => {
      const client = new Client({ name: 'activity-test', version: 'test' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${lean ? '?lean=1' : ''}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return (tool, args = {}) => client.callTool({ name: tool, arguments: args });
    };
    const make = async () => (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '비밀 지시 글', route: 'queue', target: { ref: para.ref } } })).request;
    // 편집 뒤 조판 검사(V3 — server/layout-check.js, 2026-11-12)는 커밋마다 작업자 스레드에서 나중에 '조판 확인 · n쪽' 줄을 더한다 — 완료 뒤에 올 수도 있다.
    // 이 시험은 AI 가 부른 도구의 줄을 보므로 그 줄은 빼고 견주고(그 줄 자체는 tests/edit_verify_layout.test.mjs), 뺀 줄이 조판 확인 꼴인지만 본다(2026-11-17)
    const activity = async (rid, who = api) => {
      const a = await who(`${route}/requests/${rid}/activity`);
      const layout = (a.items || []).filter((x) => x.tool === 'layout_check');
      assert.ok(layout.every((x) => /^조판 확인 · /.test(x.label)), `조판 확인 줄 꼴: ${layout.map((x) => x.label).join(' / ')}`);
      return { ...a, items: (a.items || []).filter((x) => x.tool !== 'layout_check') };
    };
    ws = watchWs(srv.base, srv.tokens.b, doc.id); await ws.ready;   // 같은 문서를 보는 다른 사람의 편집기

    // ── lean 연결: 맡기 → 읽기 → 검색 → 쓰기(complete) ──
    const lean = await connect({ lean: true }); const other = await connect({ lean: true });
    const r1 = await make(); const ids1 = { doc_id: doc.id, request_id: r1.rid, expected_attempt: 1 };
    assert.deepEqual((await activity(r1.rid)).items, [], '아직 아무도 맡지 않음');
    json(await lean('get_request', { doc_id: doc.id, request_id: r1.rid }));   // 보기만 — 기록하지 않는다
    json(await lean('start_request', ids1));
    json(await lean('start_request', ids1));                                    // 맡은 시간 늘리기 — 줄을 더 만들지 않는다
    assert.ok(!(await lean('read_document', { doc_id: doc.id, from: 0, to: 2 })).isError);
    json(await lean('search_document', { doc_id: doc.id, query: find }));
    assert.ok(!(await other('read_document', { doc_id: doc.id })).isError);     // 맡지 않은 세션의 읽기 — 이 요청의 기록이 아니다
    json(await lean('get_formatting', { doc_id: doc.id, refs: [para.ref] }));
    assert.equal((await lean('add_memo', { ...ids1, ref: 's9/p999', text: '없는 문단에 의견' })).isError, true);
    const done = json(await lean('propose_changes', { ...ids1, proposals: [{ ref: para.ref, find, replace: `${find}!` }], complete: '낱말을 다듬었습니다.' }));
    assert.equal(done.completed, true);
    const a1 = await activity(r1.rid);
    assert.equal(a1.status, 'done');
    assert.deepEqual(a1.items.map((x) => x.tool), ['start_request', 'read_document', 'search_document', 'get_formatting', 'add_memo', 'propose_changes']);
    assert.equal(a1.items[0].label, '요청을 맡음');
    assert.match(a1.items[1].label, /^문서 읽기 · 본문 0~\d+번 문단\(모두 \d+개\)$/);
    assert.match(a1.items[2].label, /^문서 검색 · \d+곳$/);
    assert.equal(a1.items[3].label, '서식 확인 · 문단 1개');
    assert.match(a1.items[4].label, /^의견 남김 — 안 됨\([A-Z_]+\)$/); assert.equal(a1.items[4].ok, false);
    assert.equal(a1.items[5].label, '수정 제안 1건 · 완료');
    assert.ok(a1.items.every((x) => Number.isInteger(x.n) && Number.isFinite(Date.parse(x.at)) && Number.isInteger(x.ms) && x.ms >= 0));
    assert.ok(!JSON.stringify(a1).includes('비밀 지시') && !JSON.stringify(a1).includes(find) && !JSON.stringify(a1).includes('없는 문단에'), '기록에 지시·검색어·문서 글·의견 글이 없다');
    // 같은 줄이 WebSocket 으로 왔다(문서를 보는 다른 사람에게도 — 글에 민감한 것이 없다)
    const live = ws.msgs.filter((m) => m.type === 'activity' && m.rid === r1.rid && m.item.tool !== 'layout_check').map((m) => m.item.n);
    assert.deepEqual(live, a1.items.map((x) => x.n));
    assert.equal((await activity(r1.rid, srv.api('b'))).items.length, 6, '문서를 볼 수 있는 사람은 볼 수 있다');
    assert.equal((await srv.api(null).res(`${route}/requests/${r1.rid}/activity`)).status, 401);
    assert.equal((await api.res(`${route}/requests/9999/activity`)).ok, false);

    // ── 기본 연결(예전 흐름): get_request → start_request → propose_change → complete_request, 그리고 다시 요청 ──
    const full = await connect();
    const r2 = await make(); const ids2 = { doc_id: doc.id, request_id: r2.rid, expected_attempt: 1 };
    json(await full('get_request', { doc_id: doc.id, request_id: r2.rid }));
    json(await full('start_request', ids2));
    json(await full('propose_change', { ...ids2, ref: para.ref, find, replace: `${find}?` }));
    json(await full('complete_request', { ...ids2, summary: '기본 흐름으로 완료' }));
    assert.deepEqual((await activity(r2.rid)).items.map((x) => x.label), ['요청을 맡음', '수정 제안 1건', '완료']);
    await api(`${route}/requests/${r2.rid}/retry`, { method: 'POST' });
    json(await full('claim_next_request', { doc_id: doc.id }));
    assert.deepEqual((await activity(r2.rid)).items.map((x) => x.label), ['요청을 맡음', '수정 제안 1건', '완료', '다시 요청', '요청을 맡음'], '다시 요청하면 경계 줄 뒤에 이어 쌓인다');
    assert.deepEqual((await activity(r1.rid)).items.length, 6, '다른 요청의 기록은 그대로');
  } finally {
    ws?.close();
    for (const client of clients) await client.close().catch(() => {});
    await srv.stop();
  }
});
