// node --test tests/tutorial.test.mjs — 체험 계정(config.tutorial — server/tutorial.js)·관리자 AI 연결 공유와
// 표준서식 작성 지침(get_writing_guide)·빈 줄 넣기(propose_insert blank). 화면 따라 하기(web/tutorial.js)는 Playwright 로 따로 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as MT from '../server/memotext.js';
import { startServer, uploadDoc, fixture, root } from './helpers/server.mjs';

const TUT = path.join(root, 'tutorial', '결과보고서.hwpx');

/** MCP 도구 한 번 → 결과 JSON | { error } */
async function mcp(srv, token, name, args, session = 'sessTut') {
  const r = await fetch(`${srv.base}/mcp?agent=TutTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('튜토리얼: 시작마다 새 임시 문서·목록 제외·계정 격리·연습 문서는 API 없이 예시 답변, 체험 계정의 자기 문서는 API가 꺼져 있으면 요청 중단', { timeout: 90000 }, async () => {
  assert.ok(fs.existsSync(TUT), `체험 문서가 있어야 한다(python -I scripts/build-tutorial-doc.py): ${TUT}`);
  const srv = await startServer({ ai: 'off', config: { tutorialExampleDelayMs: 0, tutorial: { users: ['홍길동'], shareFrom: ['관리자'], everyone: false, restrictUsers: false } } });
  try {
    const A = srv.api('a'); const B = srv.api('b');
    assert.equal((await A('/api/me')).tutorial, true);
    assert.ok(!(await B('/api/me')).tutorial);
    assert.equal((await B.res('/api/tutorial/start', { method: 'POST', body: {} })).status, 403);

    const s1 = await A('/api/tutorial/start', { method: 'POST', body: {} });
    assert.equal(s1.created, true);
    const again = await A('/api/tutorial/start', { method: 'POST', body: {} });
    assert.notEqual(again.docId, s1.docId, '처음부터는 매번 새 임시 문서');
    assert.equal(again.temporary, true);
    const st = await A('/api/tutorial');
    assert.equal(st.enabled, true);
    assert.ok(st.sessions.some(s => s.docId === s1.docId));
    assert.equal((await B.res(`/api/docs/${s1.docId}`)).ok, false, '다른 사람에게는 안 보인다(개인 문서함)');
    const s2 = await A('/api/tutorial/start', { method: 'POST', body: { reset: true } });
    assert.notEqual(s2.docId, s1.docId);
    const ids = (await A('/api/docs')).map((d) => d.id);
    assert.deepEqual(ids, [], '임시 연습 문서는 일반 문서 목록에 없다');
    assert.deepEqual((await A('/api/library')).docs, []);
    assert.equal((await A(`/api/docs/${s1.docId}`)).tutorialSession, true, '다시 시작해도 기존 연습을 덮어쓰지 않는다');

    // 연습 문서의 요청은 관리자 API 없이 준비된 예시 답변(2026-11-12 — 모든 튜토리얼). 대기열로 골라도 예시 답변이고 개인 실행기 대기열에 넣지 않는다.
    const other = await uploadDoc(srv.base, srv.tokens.b, fixture('tool_memo_tracked.hwpx'), 'b.hwpx');
    await B(`/api/docs/${other.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 줘', route: 'queue', target: { ref: 's0/p0' } } });
    const example = await A(`/api/docs/${s2.docId}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '차례 새로고침해줘', route: 'queue', target: { ref: 's0/p20' } } });
    assert.deepEqual([example.route, example.request.status, example.request.handledBy], ['example', 'done', '예시 답변']);
    assert.equal((await A(`/api/docs/${s2.docId}`)).tutorialOwnAi, true);
    // 체험 계정(tutorial.users)의 자기 문서는 관리자 API 전용 — 꺼져 있으면 개인 실행기 대기열에 넣지 않고 중단한다
    const own = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'), 'a.hwpx');
    const denied = await A.res(`/api/docs/${own.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 줘', route: 'queue', target: { ref: 's0/p0' } } });
    assert.deepEqual([denied.status, denied.data.error], [503, 'TUTORIAL_API_UNAVAILABLE']);
    assert.equal((await A('/api/me')).tutorialApiOnly, true);
    assert.equal((await A('/api/me')).personalAi.active, false);
    const none = await mcp(srv, srv.tokens.admin, 'claim_next_request', {});
    assert.equal(none.none, true, '김검토 요청은 공유 대상이 아니다');
  } finally { await srv.stop(); }
});

test('체험 누구나: 처음 접속 때 한 번 자동 시작·체험 문서는 예시 답변, 다른 문서는 기존 경로 유지', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { tutorialExampleDelayMs: 0, tutorial: { users: ['홍길동'], shareFrom: ['관리자'], restrictUsers: false } } });
  try {
    const B = srv.api('b');
    const me0 = await B('/api/me');
    assert.deepEqual([me0.tutorial, me0.tutorialAuto], [true, true], '체험 계정이 아니어도 체험·처음 접속 자동');
    const automatic = await Promise.all([1, 2].map(() => B('/api/tutorial/start', { method: 'POST', body: { auto: true } })));
    const a1 = automatic.find(r => !r.skipped);
    assert.equal(automatic.filter(r => r.skipped).length, 1, '이전 클라이언트의 자동 시작도 여러 탭에서 한 번만 생성');
    assert.equal(a1.created, true);
    assert.deepEqual(await B('/api/tutorial/start', { method: 'POST', body: { auto: true } }), { skipped: true }, '자동은 계정마다 한 번');
    assert.ok(!(await B('/api/me')).tutorialAuto);
    assert.notEqual((await B('/api/tutorial/start', { method: 'POST', body: {} })).docId, a1.docId, '언제든 새 임시 문서로 시작');
    const seen = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'tutorial-seen.json'), 'utf8'));
    assert.equal(seen['김검토'].how, 'auto');
    // 처음 접속 기록은 서버를 다시 켜도 남는다
    await srv.restart();
    assert.ok(!(await srv.api('b')('/api/me')).tutorialAuto);

    // 김검토(공유 계정 아님): 체험 문서는 준비된 예시 답변(2026-11-12 — 관리자 API 를 쓰지 않음)이고 자기 다른 문서는 대기열 사용 가능.
    const B2 = srv.api('b');
    const other = await uploadDoc(srv.base, srv.tokens.b, fixture('tool_memo_tracked.hwpx'), 'b.hwpx');
    assert.deepEqual([(await B2(`/api/docs/${a1.docId}`)).tutorial, (await B2(`/api/docs/${other.id}`)).tutorial], [true, undefined], '화면의 [체험 안내]는 체험 문서에서만(info.tutorial)');
    await B2(`/api/docs/${other.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 줘', route: 'queue', target: { ref: 's0/p0' } } });
    const example = await B2(`/api/docs/${a1.docId}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '차례 새로고침해줘', route: 'queue', target: { ref: 's0/p20' } } });
    assert.deepEqual([example.route, example.request.status], ['example', 'done']);
    assert.deepEqual([(await B2(`/api/docs/${a1.docId}`)).tutorialOwnAi, (await B2(`/api/docs/${a1.docId}`)).tutorialApiOnly], [true, undefined]);
    assert.equal((await B2(`/api/docs/${other.id}`)).tutorialApiOnly, undefined);
    assert.equal((await mcp(srv, srv.tokens.admin, 'claim_next_request', {})).none, true, '체험 문서가 아닌 요청은 공유 안 함');
  } finally { await srv.stop(); }
});

test('표준서식: get_writing_guide(standard·지침·서식명세), get_request 에 작성 지침 안내, propose_insert blank=true 로 빈 줄 넣기', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a'); const tk = srv.tokens.a;
    const doc = await uploadDoc(srv.base, tk, TUT, '결과보고서.hwpx');
    const plain = await uploadDoc(srv.base, tk, fixture('tool_memo_tracked.hwpx'), 'plain.hwpx');
    const g = await mcp(srv, tk, 'get_writing_guide', { doc_id: doc.id });
    assert.equal(g.standard, true);
    assert.match(g.guide, /빈 줄/);
    assert.match(g.guide, /&본문 1\./);
    assert.equal((await mcp(srv, tk, 'get_writing_guide', { doc_id: plain.id })).standard, false);
    const spec = await mcp(srv, tk, 'get_writing_guide', { part: 'spec' });
    assert.equal(spec.part, 'spec');
    assert.ok(spec.guide.length > 200 && spec.guide !== g.guide);

    const paras = await A(`/api/docs/${doc.id}/paragraphs`);
    const intro = paras.find((p) => /^이 보고서는/.test(p.text || ''));
    const req = (await A(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '도입 문단 뒤에 빈 줄', route: 'queue', target: { ref: intro.ref } } })).request;
    const view = await mcp(srv, tk, 'get_request', { doc_id: doc.id, request_id: req.rid });
    assert.match(view.writingGuide || '', /get_writing_guide/);
    assert.match(view.howTo, /^새 문단·표·서식을 만들면 get_writing_guide\(doc_id\)/, '작성 지침은 새 글·표·서식을 만들 때 읽는다');
    await mcp(srv, tk, 'start_request', { doc_id: doc.id, request_id: req.rid });
    const empty = await mcp(srv, tk, 'propose_insert', { doc_id: doc.id, after_ref: intro.ref, request_id: req.rid });
    assert.match(empty.error, /blank/);
    const p = await mcp(srv, tk, 'propose_insert', { doc_id: doc.id, after_ref: intro.ref, blank: true, request_id: req.rid, expected_attempt: 1 });
    assert.deepEqual([p.type, p.blank, p.text], ['insert', true, '']);
    assert.ok(MT.renderProposalMemo(p).includes('빈 줄'));
    const ap = await A(`/api/docs/${doc.id}/proposals/${p.pid}/apply`, { method: 'POST' });
    assert.equal(ap.status, 'applied');
    const after = await A(`/api/docs/${doc.id}/paragraphs`);
    const top = (list) => list.filter((x) => !x.parent);
    assert.equal(top(after).length, top(paras).length + 1);
    const k = top(after).findIndex((x) => x.ref === intro.ref);
    assert.deepEqual([top(after)[k + 1].text, top(after)[k + 2].text, top(after)[k + 3].text], ['', '', '1. 사업 개요'], '도입 뒤 빈 줄 둘(원래 하나 + 넣은 것) 뒤에 1장');
  } finally { await srv.stop(); }
});
