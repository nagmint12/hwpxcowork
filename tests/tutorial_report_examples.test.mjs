// node --test tests/tutorial_report_examples.test.mjs — 모든 튜토리얼을 예시 답변으로(2026-11-12 사용자 지시).
// 결과보고서 연습(report)의 AI 요청 세 가지(글 고치기 T1 · 메모 답글 T2 · 차례 새로 고침 T3)는 tutorial/report-answers.json 의 when 으로 골라
// '예시 답변' 실행기가 MCP 도구로 넣는다. 관리자 공유 키·관리자 실행기·학습자 본인 연결을 부르지 않고, 맞는 예시가 없는 요청은 문서를 고치지 않고
// 안내로 끝난다(대기열에 남아 완료를 막지 않음). API 는 가짜 fetch, 문서는 임시 사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { TutorialStore as Store } from '../server/tutorial-store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { createTutorial } from '../server/tutorial.js';
import { EXAMPLE_AGENT, loadSourceAnswers, whenMatches, resolveAnchors } from '../server/tutorial-advanced.js';
import { HwpxDoc } from '../engine/doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(ROOT, 'tutorial', '결과보고서.hwpx');
const admin = { name: '관리자', role: 'admin' };
const learner = { name: 'test1', role: 'editor', token: 'test1-token' };
// web/tutorial-modules/report-flow.js 의 연습 글과 같다
const P1 = '일정 부분 기여한 것으로 보인다'; const P2 = '학생 만족도';
const INSTR1 = '‘보인다’ 말고, 적절한 표현으로'; const MEMO = '근거로 [표 1]을 함께 제시해 주세요.'; const REPLY = '이 메모대로 문장을 고쳐 줘'; const TOC = '차례 새로고침해줘';
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });

function setup(t, tutorial = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-report-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  // allowAgentApply: 서버 설정 기본값(server/config.js — 꺼야 false). 차례 새로 고침의 apply_now 가 이 문을 지난다
  const config = { tutorialExampleDelayMs: 0, root: ROOT, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: {}, agents: { othersCanTake: true }, allowAgentApply: true,
    users: [{ ...admin, token: 'admin-token', serverAi: true }, { ...learner, serverAi: true }],
    tutorial: { users: [learner.name], shareFrom: [admin.name], provider: 'claude-code', restrictUsers: false, ...tutorial } };
  const seen = []; const deliveries = []; const sent = [];
  const personal = createPersonalAi({ config, fetchImpl: async (url, init) => {
    seen.push(new Headers(init.headers).get('authorization'));
    const output = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '관리자 API 로 처리함', instructionSummary: '처리', noChangesReason: '시험' };
    return json({ status: 'completed', model: 'test-api', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  } });
  personal.save(admin, { provider: 'openai', model: 'test-api', key: 'sk-admin-shared-000000' });
  personal.save(learner, { provider: 'openai', model: 'test-api', key: 'sk-learner-own-000000' });
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  service.personalAi = personal;
  // 관리자 Claude Code 채널·학습자 채널이 모두 붙어 있어도 쓰지 않아야 한다
  service.agents = {
    online: () => true,
    sessions: (name) => (name === admin.name ? [{ session: 'cc-1', agent: 'Claude Code', client: 'claude-code/2.1.319', channel: true }] : []),
    sendSession(name, session, type) { sent.push({ name, session, type }); return true; },
    deliver(name, type) { deliveries.push({ name, type }); return { session: `${name}-session`, agent: 'Claude Code' }; },
  };
  const tut = createTutorial({ service, config });
  return { tmp, config, service, store, personal, tut, seen, deliveries, sent };
}

/** 글 조각을 고른 요청 대상(화면에서 끌어 고른 것과 같은 꼴) */
async function pick(s, id, want) {
  const d = await s.store.doc(id);
  const p = d.paragraphs({ view: 'final', nested: true }).find((x) => String(x.text).includes(want));
  assert.ok(p, `문서에 ‘${want}’ 가 없다`);
  const text = s.service._text(d, p.ref); const k = text.indexOf(want); const start = [...text.slice(0, k)].length;
  return { ref: p.ref, start, end: start + [...want].length, text: want, refs: [p.ref] };
}
const textOf = async (s, id, ref) => (await s.store.doc(id)).text(ref, 'final');
const noRealAi = (s) => { assert.deepEqual(s.seen, [], '관리자·학습자 API 키를 부르지 않는다'); assert.deepEqual(s.deliveries, [], '채널로 보내지 않는다'); assert.deepEqual(s.sent, [], '관리자 실행기로 보내지 않는다'); };

test('결과보고서 예시 답변 파일: 세 요청(T1·T2·T3)의 조건과 자리표시가 연습 문서에서 찾아진다', async () => {
  const answers = loadSourceAnswers(ROOT, 'report');
  assert.deepEqual(Object.keys(answers.steps).sort(), ['T1', 'T2', 'T3']);
  const d = await HwpxDoc.load(fs.readFileSync(REPORT));
  for (const [step, a] of Object.entries(answers.steps)) for (const c of a.calls) {
    for (const item of c.name === 'propose_changes' ? c.args.proposals : [c.args]) assert.ok(resolveAnchors(d, [], item), `${step} ${JSON.stringify(item).slice(0, 100)}`);
  }
  // 조건: 메모 답글은 T2, 차례는 T3, ‘보인다’ 글 고치기는 T1 — 메모 답글은 고른 글이 같아도 T1 이 아니다
  assert.equal(whenMatches(answers.steps.T2.when, { followUp: { memoId: 'm1' }, instruction: REPLY, target: { text: P2 } }), true);
  assert.equal(whenMatches(answers.steps.T1.when, { followUp: { memoId: 'm1' }, instruction: REPLY, target: { text: P1 } }), false);
  assert.equal(whenMatches(answers.steps.T1.when, { instruction: '아무 지시', target: { text: P1 } }), true);
  assert.equal(whenMatches(answers.steps.T3.when, { instruction: '차례 새로 고쳐 줘', target: { text: '<제목 차례>' } }), true);
  assert.equal(whenMatches(answers.steps.T3.when, { instruction: '다듬어 줘', target: { text: '<제목 차례>' } }), true);
  assert.equal(whenMatches(answers.steps.T1.when, { instruction: '다듬어 줘', target: { text: '본 사업은' } }), false);
});

test('결과보고서 연습: 글 고치기·메모 답글·차례 새로 고침이 모두 예시 답변 — 관리자 AI·본인 AI 를 부르지 않고 완료까지', async (t) => {
  const s = setup(t);
  const started = await s.tut.start(learner, { tutorialId: 'report' });
  const id = started.docId; const meta = s.store.readMeta(id);
  assert.equal(meta.tutorial, true); assert.equal(meta.tutorialSession, true);
  const info = s.service._summary(meta, learner);
  assert.equal(info.tutorialOwnAi, true, '화면 작업 환경 = 예시 답변'); assert.ok(!info.tutorialApiOnly);

  // 1) 글 고치기(T1)
  const t1 = await s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, P1), instruction: INSTR1 }, learner);
  assert.deepEqual([t1.route, t1.request.status], ['example', 'done']);
  const r1 = s.service._meta(id).requests.at(-1);
  assert.deepEqual([r1.example, r1.handledBy], [true, EXAMPLE_AGENT]);
  const p1 = s.service._meta(id).proposals.filter((p) => p.rid === r1.rid);
  assert.equal(p1.length, 1); assert.equal(p1[0].replace, '일정 부분 기여한 것으로 나타났다');
  await s.service.applyProposal(id, p1[0].pid, learner);
  const ref = p1[0].ref;
  assert.match(await textOf(s, id, ref), /기여한 것으로 나타났다\.$/);

  // 2) 메모 → 답글로 AI 에게(T2) — T1 을 반영한 뒤에도 들어간다
  const memo = await s.service.addMemo(id, { ...(await pick(s, id, P2)), text: MEMO }, learner);
  const mid = memo.memo?.id ?? memo.id ?? s.service._meta(id).memos?.at?.(-1)?.id;
  const memos = (await s.store.doc(id)).memos(); const m = memos.find((x) => String(x.text).includes('[표 1]')) || memos.at(-1);
  const t2 = await s.service.askAiFromMemo(id, mid || m.id, { text: REPLY }, learner);
  assert.equal(t2.route, 'example');
  const r2 = s.service._meta(id).requests.at(-1);
  assert.ok(r2.followUp); assert.equal(r2.status, 'done', r2.error || '');
  const p2 = s.service._meta(id).proposals.filter((p) => p.rid === r2.rid);
  assert.equal(p2.length, 1);
  await s.service.applyProposal(id, p2[0].pid, learner);
  assert.equal(await textOf(s, id, ref), '[표 1]과 같이 본 사업은 교육과정 개선을 통해 학생 만족도 향상에 일정 부분 기여한 것으로 나타났다.');

  // 3) 차례 새로 고침(T3) — 바로 적용(apply_now)
  const before = (await s.store.doc(id)).paragraphs({ view: 'final' }).map((p) => p.text);
  const t3 = await s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, '<제목 차례>'), instruction: TOC }, learner);
  assert.deepEqual([t3.route, t3.request.status], ['example', 'done']);
  const r3 = s.service._meta(id).requests.at(-1);
  const p3 = s.service._meta(id).proposals.filter((p) => p.rid === r3.rid);
  assert.ok(p3.length >= 1 && p3.every((p) => p.type === 'toc'), JSON.stringify(p3.map((p) => [p.type, p.status])));
  assert.ok(p3.every((p) => p.status === 'applied'), '차례는 바로 적용된다');
  const after = (await s.store.doc(id)).paragraphs({ view: 'final' }).map((p) => p.text);
  assert.notDeepEqual(after, before, '차례 문단이 바뀐다');
  assert.ok(after.some((x) => /영역별 만족도/.test(x) && /\d\s*$/.test(x)), `표 차례 항목과 쪽 번호: ${after.filter((x) => /만족도/.test(x)).join(' | ')}`);

  // 4) 맞는 예시가 없는 요청 — 문서를 고치지 않고 안내로 끝난다(대기열에 남지 않는다)
  const free = await s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, '본 사업은'), instruction: '이 문단을 영어로 번역해 줘' }, learner);
  assert.deepEqual([free.route, free.request.status], ['example', 'done']);
  const rf = s.service._meta(id).requests.at(-1);
  assert.equal(s.service._meta(id).proposals.filter((p) => p.rid === rf.rid).length, 0);
  assert.match(rf.noChangesReason, /미리 준비한 예시/);

  noRealAi(s);
  const done = await s.tut.complete(learner, id);
  assert.equal(done.saved, true, '대기 요청이 없어 완료할 수 있다');
});

test('메모 답글(T2)은 글 고치기(T1)를 반영하지 않은 문서에도 들어간다, 다시 요청도 예시 답변', async (t) => {
  const s = setup(t);
  const id = (await s.tut.start(learner, { tutorialId: 'report' })).docId;
  await s.service.addMemo(id, { ...(await pick(s, id, P2)), text: MEMO }, learner);
  const m = (await s.store.doc(id)).memos().find((x) => String(x.text).includes('[표 1]'));
  await s.service.askAiFromMemo(id, m.id, { text: REPLY }, learner);
  const r = s.service._meta(id).requests.at(-1);
  const p = s.service._meta(id).proposals.filter((x) => x.rid === r.rid);
  await s.service.applyProposal(id, p[0].pid, learner);
  assert.equal(await textOf(s, id, p[0].ref), '[표 1]과 같이 본 사업은 교육과정 개선을 통해 학생 만족도 향상에 일정 부분 기여한 것으로 보인다.');
  const again = await s.service.retryRequest(id, r.rid, learner);
  assert.equal(again.route, 'example');
  noRealAi(s);
});

test('이미 진행 중이던 예전 연습 문서(tutorial 표시만 있음)도 예시 답변 — config.tutorial.examples:false 면 예전처럼 관리자 AI', async (t) => {
  const s = setup(t);
  const legacy = () => s.store.create({ fileName: 'r.hwpx', bytes: fs.readFileSync(REPORT), by: learner.name, extra: { tutorial: true, tutorialId: 'report' } }).id;
  const id = legacy();
  const res = await s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, P1), instruction: INSTR1, route: 'server' }, learner);
  assert.deepEqual([res.route, res.request.status], ['example', 'done']);
  noRealAi(s);
  // 관리자가 예시 답변을 끄면(examples:false) 연습 문서도 관리자가 고른 튜토리얼 AI(여기서는 관리자 Claude Code 채널)로 간다
  s.config.tutorial.examples = false;
  const id2 = legacy();
  const old = await s.service.createRequest(id2, { kind: 'instruct', target: await pick(s, id2, P1), instruction: INSTR1 }, learner);
  assert.equal(old.route, 'agent');
  assert.deepEqual(s.sent.map((x) => x.session), ['cc-1']);
  assert.equal(s.service._summary(s.service._meta(id2), learner).tutorialApiOnly, true);
});

test('AI 작업 맡기기(ai-requests) 연습: 미리 만든 예시 기록(완료·대기·실패)은 그대로, 새 요청은 예시 답변 안내로 끝난다', async (t) => {
  const s = setup(t);
  const id = (await s.tut.start(learner, { tutorialId: 'ai-requests' })).docId;
  const seeded = s.service._meta(id).requests;
  assert.deepEqual([...new Set(seeded.map((r) => r.status))].sort(), ['done', 'failed', 'pending'], '예시 기록은 시나리오가 도구로 만든다(예시 답변 경로로 바로 처리되지 않음)');
  assert.ok(seeded.every((r) => r.handledBy !== EXAMPLE_AGENT));
  assert.ok(seeded.every((r) => r.example));
  const p = (await s.service.paragraphs(id)).find((x) => /^예시 문단 B/.test(x.text));
  const res = await s.service.createRequest(id, { kind: 'instruct', target: { ref: p.ref }, instruction: '두 문장으로 요약해 줘' }, learner);
  assert.deepEqual([res.route, res.request.status], ['example', 'done']);
  noRealAi(s);
  assert.equal((await s.tut.complete(learner, id)).saved, true, '예시로 남긴 대기 요청은 완료를 막지 않는다');
});

test('예시 답변 문서가 아닌 일반 문서는 그대로 — 체험 계정의 자기 문서는 관리자 AI, BAD_ROUTE 검사', async (t) => {
  const s = setup(t);
  const id = s.store.create({ fileName: 'own.hwpx', bytes: fs.readFileSync(REPORT), by: learner.name }).id;
  await assert.rejects(s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, P1), instruction: INSTR1, route: 'example' }, learner), { code: 'BAD_ROUTE' });
  const res = await s.service.createRequest(id, { kind: 'instruct', target: await pick(s, id, P1), instruction: INSTR1 }, learner);
  assert.equal(res.route, 'agent', '체험 계정의 자기 문서는 관리자가 고른 튜토리얼 AI(관리자 채널)');
  assert.equal(s.service._summary(s.service._meta(id), learner).tutorialOwnAi, undefined);
});
