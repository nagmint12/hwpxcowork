// 새 연결 edit 의 원자적 저장·자기 제안 거두기·일괄 바꾸기·영수증 줄이기(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-4·나-6·나-10·나-13). 모델을 부르지 않는다.
//  · 저장 전 검사(사본에서 만들어 보기)가 잡는 실패 → 그 호출의 제안·메모 0, 앞선 호출의 것은 그대로
//  · 저장 단계에서만 드러나는 실패(검사를 건너뛰고 서비스가 실패하게 만든다) → 이 호출의 제안·메모·답글을 거두고 거둔 제안은 되살린다
//  · withdraw: 내 대기 제안 → 숨김·셈에서 빠짐·같은 것을 다시 낼 수 있음 / 남의 것·반영된 것·다른 요청 것·요청 없이 → 오류, 다시 열기·반영 안 됨
//  · replace_all: 연습 보고서 사본에서 낱말 하나를 문서 전체로(본문·표 칸·캡션, 같은 문단 여럿) → 영수증 한 줄, [모두 반영] 뒤 그 낱말 0곳
//  · 영수증 줄이기(한 op 의 제안 여럿 = 한 줄 pids 범위)와 finish 의 completed
//   node --test tests/mcp_v2_atomic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service, ServiceError } from '../server/service.js';
import { Store } from '../server/store.js';
import { parseOps, prepareOps, OPS_BRIEF } from '../server/mcp2/ops.js';
import { pidRanges } from '../server/proposal-withdraw.js';
import { activityItem } from '../server/activity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
// 에이전트 쓰기는 맡은 세션으로(server/mcp.js actor — agentSession)
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const human = { name: '다른 사람', role: 'admin' };
const AGENT = 'claude-code';

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-v2-atomic-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 쪽 수 어림은 이 시험의 관심이 아니다(조판 작업자를 띄우지 않게 끈다) — 저장 전 검사는 쪽 수 어림과 따로 돈다
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, verify: { pages: false } };
  const store = new Store(path.join(tmp, 'store'));
  const sent = [];
  const service = new Service({ store, hub: { broadcast: (...a) => sent.push(a), broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'report.hwpx', bytes: fs.readFileSync(REPORT), by: user.name }).id;
  return { store, service, docId, sent };
}
async function request(service, docId, instruction = '고쳐 줘') {
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction, target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: r.rid });
  return r.rid;
}
const visible = async (service, docId) => (await service.listProposals(docId)).map((p) => p.pid);
const reqOf = (store, docId, rid) => store.readMeta(docId).requests.find((r) => r.rid === rid);
const memoCount = async (service, docId) => (await service.memos(docId, user)).length;

test('op 꼴: replace_all·withdraw 와 도구 설명 줄', () => {
  assert.equal(parseOps([{ op: 'replace_all', find: '가', with: '나' }, { op: 'withdraw', pids: [3] }, { op: 'withdraw', all: true }]).errors.length, 0);
  assert.equal(parseOps([{ op: 'replace_all', find: '', with: '나' }]).errors.length, 1);
  assert.match(OPS_BRIEF, /op:'replace_all'/); assert.match(OPS_BRIEF, /op:'withdraw'/);
  assert.equal(pidRanges([5, 3, 4, 9, 11, 10]), '3-5,9-11');
  assert.equal(activityItem('edit', { ops: [{ op: 'replace_all' }, { op: 'withdraw' }] }, { value: { saved: [] } }).label, '일괄 바꾸기 · 제안 거두기');
  assert.match(activityItem('edit', { ops: [{ op: 'replace' }] }, { value: { saved: [], failed: [{}] } }).label, /저장 안 됨/);
});

test('한 호출은 다 저장되거나 하나도 저장되지 않는다 — 저장 전 검사·저장 단계 실패 되돌림(제안·메모·답글·거둔 제안)', { timeout: 120000 }, async (t) => {
  const { store, service, docId, sent } = setup(t);
  const rid = await request(service, docId);
  // 앞선 호출: 저장된다(문단 셋 = 영수증 한 줄 + 메모 하나)
  const first = await service.agentEdit(docId, { rid, ops: [
    { op: 'insert', after: 's1/p1', paragraphs: [{ text: '첫째 덧붙임' }, { text: '둘째 덧붙임' }, { text: '셋째 덧붙임' }] },
    { op: 'memo', at: 's1/p1', text: '앞선 호출의 의견' },
  ] }, user, AGENT);
  assert.ok(!first.failed, JSON.stringify(first));
  assert.equal(first.saved.length, 2, JSON.stringify(first.saved));
  assert.equal(first.saved[0].count, 3); assert.match(first.saved[0].pids, /^\d+-\d+$/);
  const memoId = first.saved[1].memo; assert.ok(memoId);
  const before = { pids: await visible(service, docId), memos: await memoCount(service, docId), version: store.readMeta(docId).version };
  assert.equal(before.pids.length, 3);

  // (1) 저장 전 검사가 잡는 실패: 문서에 없는 find — 같은 호출의 맞는 제안·메모도 저장하지 않는다
  const refused = await service.agentEdit(docId, { rid, ops: [
    { op: 'replace', at: 's1/p1', find: '가상의', with: '모의' },
    { op: 'insert', after: 's1/p3', text: '새 문단' },
    { op: 'memo', at: 's1/p3', text: '저장되면 안 되는 의견' },
    { op: 'replace', at: 's1/p1', find: '문서에 없는 글 XYZ', with: '가' },
  ] }, user, AGENT);
  assert.deepEqual(refused.saved, []); assert.equal(refused.failed.length, 1); assert.equal(refused.failed[0].op, 3);
  assert.match(refused.failed[0].error, /NOT_FOUND/); assert.match(refused.note, /아무것도 저장하지 않았습니다/);
  assert.deepEqual(await visible(service, docId), before.pids);
  assert.equal(await memoCount(service, docId), before.memos);
  assert.equal(store.readMeta(docId).version, before.version, '저장 전 검사는 문서를 바꾸지 않는다');
  // 메모를 붙일 글이 없으면 그것도 저장 전에 막는다
  const badMemo = await service.agentEdit(docId, { rid, ops: [{ op: 'replace', at: 's1/p1', find: '가상의', with: '모의' }, { op: 'memo', at: 's1/p3', find: '없는 글 QQ', text: '의견' }] }, user, AGENT);
  assert.deepEqual(badMemo.saved, []); assert.equal(badMemo.failed[0].op, 1);
  assert.deepEqual(await visible(service, docId), before.pids);

  // (2) 저장 단계에서만 드러나는 실패: 검사를 건너뛰고(그 사이 문서가 바뀐 경우와 같다) 마지막 '지금 적용' 차례가 실패하게 만든다
  //     → 이 호출이 만든 제안·메모·답글을 거두고, 이 호출이 거둔 제안은 되살린다
  service._agentPreflight = async () => ({ failed: [] });
  const propose = service.propose.bind(service);
  service.propose = async (id, body, ...rest) => { if (body?.applyNow) throw new ServiceError('ENGINE', '시험: 지금 적용 실패'); return propose(id, body, ...rest); };
  const sentBefore = sent.length;
  const rolled = await service.agentEdit(docId, { rid, ops: [
    { op: 'withdraw', pids: [before.pids[0]] },
    { op: 'replace', at: 's1/p1', find: '가상의', with: '모의' },
    { op: 'insert', after: 's1/p3', paragraphs: [{ text: '거둘 문단 하나' }, { text: '거둘 문단 둘' }] },
    { op: 'memo', at: 's1/p3', text: '거둘 의견' },
    { op: 'memo', reply_to: memoId, text: '거둘 답글' },
    { op: 'toc', apply_now: true },
  ] }, user, AGENT);
  assert.deepEqual(rolled.saved, [], JSON.stringify(rolled)); assert.equal(rolled.failed.length, 1); assert.equal(rolled.failed[0].op, 5);
  assert.match(rolled.failed[0].error, /시험: 지금 적용 실패/); assert.match(rolled.note, /아무것도 저장하지 않았습니다/);
  assert.deepEqual(await visible(service, docId), before.pids, '앞선 호출의 제안은 그대로(거둔 것도 되살림), 이 호출의 제안은 보이지 않는다');
  assert.equal(await memoCount(service, docId), before.memos, '이 호출의 메모는 지웠다');
  const meta = store.readMeta(docId);
  const r = meta.requests.find((x) => x.rid === rid);
  assert.deepEqual(r.proposals, before.pids);
  assert.equal(r.comments.length, 1);
  assert.equal((r.resultReplies || []).length, 0, '답글 기록도 거둔다');
  const thread = Object.values(meta.memoThreads || {}).find((th) => th.replies?.length);
  assert.equal(thread, undefined, '답글이 스레드에서 빠졌다');
  const gone = await service.listProposals(docId, 'withdrawn');
  assert.equal(gone.length, 3, '이 호출이 만든 제안 셋(바꿈 1 + 넣기 2)은 거둔 상태로 기록만 남는다');
  assert.ok(r.log.some((l) => l.action === 'withdraw' && /edit 호출이 저장되지 않아/.test(l.detail)), JSON.stringify(r.log.slice(-3)));
  assert.ok(sent.slice(sentBefore).some(([, m]) => m.type === 'proposal' && m.action === 'withdrawn'), '화면이 다시 읽게 방송');
  // 셈: 거둔 제안은 요청 항목에 들지 않는다
  assert.equal(service._outcome(meta, r).items, 1);   // 앞선 호출의 문단 셋은 한 묶음(p.bundle — 작업 E) = 항목 하나
  service.propose = propose; delete service._agentPreflight;

  // finish 의 completed(§10.4 나-13)
  const fin = await service.agentFinish(docId, rid, { summary: '덧붙임 문단을 제안했습니다.' }, user, AGENT);
  assert.equal(fin.completed, true); assert.equal(fin.status, 'done');
});

test('withdraw: 내 대기 제안만 거둔다 — 숨김·셈에서 빠짐·다시 내기 가능, 남의 것·반영된 것·다른 요청 것은 오류', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId);
  const made = await service.agentEdit(docId, { rid, ops: [
    { op: 'replace', at: 's1/p1', find: '가상의', with: '모의' },
    { op: 'delete_objects', at: 's1/p37', kinds: ['figure'] },
    { op: 'replace', at: 's1/p3', find: '분석 개요', with: '분석의 개요' },
  ] }, user, AGENT);
  assert.ok(!made.failed, JSON.stringify(made));
  const [a, b, c] = made.saved.map((x) => x.pid);
  // 다시 내기: 같은 개체 지우기는 대기 중이면 SAME 으로 막힌다 → 같은 호출에서 거두고 다시 낸다(거두기가 먼저 처리된다)
  const dup = await service.agentEdit(docId, { rid, ops: [{ op: 'delete_objects', at: 's1/p37', kinds: ['figure'] }] }, user, AGENT);
  assert.deepEqual(dup.saved, []); assert.match(dup.failed[0].error, /SAME|이미 있습니다/);
  const again = await service.agentEdit(docId, { rid, ops: [{ op: 'delete_objects', at: 's1/p37', kinds: ['figure'] }, { op: 'withdraw', pids: [b] }] }, user, AGENT);
  assert.ok(!again.failed, JSON.stringify(again));
  assert.deepEqual(again.withdrawn, { ops: 1, pids: String(b), count: 1 });
  const d = again.saved[0].pid;
  assert.deepEqual(await visible(service, docId), [a, c, d]);
  let r = reqOf(store, docId, rid);
  assert.deepEqual(r.proposals, [a, c, d]); assert.deepEqual(r.withdrawn, [b]);
  assert.ok(r.log.some((l) => l.action === 'withdraw' && l.detail.includes(`#${b}`)));
  // 거둔 제안은 반영·다시 열기·거절이 안 된다(사람의 거절과 다르다)
  await assert.rejects(service.applyProposal(docId, b, user, null), (e) => e.code === 'STATE');
  await assert.rejects(service.reopenProposal(docId, b, user, null), (e) => e.code === 'STATE');
  await assert.rejects(service.rejectProposal(docId, b, user, null), (e) => e.code === 'STATE');
  // read view='proposals' 기본은 숨김, status='withdrawn' 으로 물으면 보인다
  const shown = JSON.parse((await service.agentRead(docId, { view: 'proposals' }, user)).text);
  assert.ok(!shown.some((p) => p.pid === b));
  assert.deepEqual(JSON.parse((await service.agentRead(docId, { view: 'proposals', status: 'withdrawn' }, user)).text).map((p) => p.pid), [b]);

  // 오류: 남의 제안(사람이 같은 요청에 낸 것)·반영된 것·다른 요청 것·없는 것·요청 없이 — 하나라도 있으면 아무것도 거두지 않는다
  const theirs = await service.propose(docId, { type: 'replace', ref: 's1/p3', find: '1.', replace: '1)', rid }, human, null);
  await service.applyProposal(docId, c, user, null);
  const rid2 = await request(service, docId, '다른 요청');
  const other = (await service.agentEdit(docId, { rid: rid2, ops: [{ op: 'replace', at: 's1/p1', find: '튜토리얼', with: '연습' }] }, user, AGENT)).saved[0].pid;
  const bad = await service.agentEdit(docId, { rid, ops: [{ op: 'withdraw', pids: [a, theirs.pid, c, other, 99999] }] }, user, AGENT);
  assert.deepEqual(bad.saved, []);
  const msg = bad.failed[0].error;
  assert.match(msg, new RegExp(`#${theirs.pid}: 다른 작성자`)); assert.match(msg, new RegExp(`#${c}: 이미 반영`)); assert.match(msg, new RegExp(`#${other}: 다른 요청`)); assert.match(msg, /#99999: 없는 제안/);
  assert.ok((await visible(service, docId)).includes(a), '하나라도 틀리면 a 도 거두지 않는다');
  assert.match((await service.agentEdit(docId, { ops: [{ op: 'withdraw', all: true }] }, user, AGENT)).failed[0].error, /request_id 와 함께/);
  assert.equal(parseOps([{ op: 'withdraw' }]).errors.length, 0);   // 꼴은 맞지만 pids·all 이 없으면 prepareOps 가 막는다
  assert.match((await service.agentEdit(docId, { rid, ops: [{ op: 'withdraw' }] }, user, AGENT)).failed[0].error, /pids.*all:true/);

  // all:true — 이 요청에서 내가 낸 대기 제안 모두(사람의 제안·반영된 것·다른 요청 것은 그대로)
  const all = await service.agentEdit(docId, { rid, ops: [{ op: 'withdraw', all: true }] }, user, AGENT);
  assert.equal(all.withdrawn.count, 2, JSON.stringify(all)); assert.equal(all.withdrawn.pids, pidRanges([a, d]));
  r = reqOf(store, docId, rid);
  assert.deepEqual(r.proposals.sort((x, y) => x - y), [c, theirs.pid].sort((x, y) => x - y));
  const meta = store.readMeta(docId);
  const o = service._outcome(meta, r);
  assert.equal(o.items, 2); assert.equal(o.open, 1); assert.equal(o.applied, 1);
  // 쪽 수 흉내도 대기 제안만 고른다 — 거둔 것은 빠진다(그 요청의 대기 = 사람의 제안 하나)
  const r2 = reqOf(store, docId, rid2); assert.deepEqual(r2.proposals, [other]);
});

test('replace_all: 연습 보고서 전체의 낱말 하나 — 본문·표 칸·캡션·같은 문단 여럿, 영수증 한 줄, [모두 반영] 뒤 0곳', { timeout: 180000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId, '재수강을 재이수로 모두 바꿔 줘');
  const count = async () => { const doc = await store.doc(docId); let n = 0; const refs = []; for (const p of doc.paragraphs({ view: 'final', nested: true })) { const c = p.text.split('재수강').length - 1; n += c; if (c) refs.push(p.ref); } return { n, refs }; };
  const start = await count();
  assert.equal(start.n, 61, '연습 보고서에 61곳(실험 T16 의 op 61개)');
  // 0곳이면 무엇을 어디서 찾았는지 알려 준다
  const none = await service.agentEdit(docId, { rid, ops: [{ op: 'replace_all', find: '없는낱말QQ', with: '가' }] }, user, AGENT);
  assert.match(none.failed[0].error, /찾지 못했습니다 — 찾은 곳: 문서 전체의 본문·표 칸·캡션/);
  // 미리 해 보기는 개수와 자리만
  const dry = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'replace_all', find: '재수강', with: '재이수' }] }, user, AGENT);
  assert.equal(dry.replace_all[0].replaced, 61); assert.ok(!dry.failed, JSON.stringify(dry.failed));
  const out = await service.agentEdit(docId, { rid, done: '재수강을 재이수로 바꿨습니다.', ops: [{ op: 'replace_all', find: '재수강', with: '재이수', reason: '용어 통일' }] }, user, AGENT);
  assert.ok(!out.failed, JSON.stringify(out));
  assert.equal(out.saved.length, 1, `영수증 한 줄: ${JSON.stringify(out.saved)}`);
  const line = out.saved[0];
  assert.equal(line.op, 0); assert.equal(line.replaced, 61); assert.equal(line.paragraphs, start.refs.length);
  assert.match(line.pids, /^\d+-\d+$/); const [lo, hi] = line.pids.split('-').map(Number); assert.equal(hi - lo + 1, 61);
  assert.match(line.where, /본문 \d+/); assert.match(line.where, /표 칸 \d+/); assert.match(line.where, /표 캡션 \d+/); assert.match(line.where, /그림 캡션 \d+/);
  assert.equal(line.not_searched, '바탕쪽·메모');
  assert.equal(out.completed, true);
  // 제안 61건: 캡션(표 s1/p35/n0 '입학년도별 재수강 경험 비율'·그림 s1/p53/n0)과 같은 문단 셋(s1/p5 — occurrence 1·2·3)
  const props = (await service.listProposals(docId)).filter((p) => p.rid === rid);
  assert.equal(props.length, 61);
  assert.ok(props.some((p) => p.ref === 's1/p35/n0') && props.some((p) => p.ref === 's1/p53/n0'), '표·그림 캡션도 바꾼다');
  assert.ok(props.some((p) => /^s1\/p\d+\/n\d+/.test(p.ref) && p.ref !== 's1/p35/n0' && p.ref !== 's1/p53/n0'), '표 칸도 바꾼다');
  assert.deepEqual(props.filter((p) => p.ref === 's1/p5').map((p) => p.occurrence), [1, 2, 3]);
  assert.equal(new Set(props.map((p) => p.bundle)).size, 1, '한 op = 한 묶음');
  // [모두 반영] 뒤 그 낱말 0곳
  const res = await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  assert.equal(res.counts.failed, 0, JSON.stringify(res.results?.filter((x) => !x.ok)));
  assert.equal(res.counts.applied, 61);
  const end = await count();
  assert.equal(end.n, 0, `남은 곳: ${end.refs.join(', ')}`);
  const doc = await store.doc(docId);
  assert.equal(doc.text('s1/p5', 'final').split('재이수').length - 1, 3);
});

// 2026-11-17(artifacts/mcp-round3-20261117/codex/REPORT.md 문제 4): 모르는 키 오류 글에 그 자리 객체가 받는 키 — 별칭으로 몰래 받지는 않는다
test('모르는 키 오류: 그 자리(op·chart·paragraphs 항목·표 칸 주소·쪽 구성)가 받는 키를 덧붙인다', () => {
  const { ok, errors } = parseOps([
    { op: 'chart', after: 's0/p1', chart: { type: 'line', y_label: '점', y_min: 0 } },
    { op: 'insert', after: 's0/p1', paragraphs: [{ text: '가', bold: true }] },
    { op: 'replace', at: 's0/p1', find: '가', with: '나', wat: 1 },
    { op: 'replace', at: { table: 's0/p3#t0', row: 0, col: 0, cell: 1 }, find: '', with: '나' },
    { op: 'paper', section: 0, foo: 1 },
  ]);
  assert.equal(ok.length, 0); assert.equal(errors.length, 5);
  const keys = (e) => (/받는 키: ([^—]+)/.exec(e.error)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  assert.match(errors[0].error, /chart Unrecognized keys: "y_label", "y_min" — 받는 키: /);
  assert.ok(keys(errors[0]).includes('x_title') && keys(errors[0]).includes('y_title'), errors[0].error);
  assert.deepEqual(keys(errors[1]).sort(), ['format', 'runs', 'style', 'text']);
  assert.ok(keys(errors[2]).includes('find') && keys(errors[2]).includes('whole'), errors[2].error);
  assert.deepEqual(keys(errors[3]).sort(), ['col', 'para', 'row', 'table']);
  assert.ok(keys(errors[4]).includes('margins') && keys(errors[4]).includes('section'), errors[4].error);
  // 꼴 오류(모르는 키 아님)에는 붙이지 않는다
  assert.doesNotMatch(parseOps([{ op: 'replace', at: 's0/p1', find: 3, with: '나' }]).errors[0].error, /받는 키/);
});

// 2026-11-17(같은 REPORT.md 문제 3, §10.4 나-12): 스타일 이름의 사설 영역 글자 — 지침의 '&■ …' 로 써도 문서의 사설 영역 글자(U+F02EA) 스타일을 찾는다
test('스타일 이름: 사설 영역 글자·머리 기호는 같은 자리표로 — 하나면 그것(notes 에 한 줄), 여럿이면 후보와 함께 오류', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const pua = String.fromCodePoint(0xF02EA);
  const dry = await service.agentEdit(docId, { rid, dryRun: true, ops: [
    { op: 'insert', after: 's1/p3', paragraphs: [{ text: '첫 줄', style: '&■ ' }, { text: '둘째 줄', style: '&■ ' }] },
    { op: 'format', at: 's1/p5', style: '&○' },
  ] }, user, AGENT);
  assert.ok(!dry.failed, JSON.stringify(dry));
  const notes = (dry.notes || []).map((x) => x.note);
  assert.deepEqual(notes, [`스타일 「&■ 」 → 문서의 「&${pua}」`, `스타일 「&○」 → 문서의 「&${pua}」`], JSON.stringify(dry.notes));
  // 정확히 맞는 이름은 알림 없음
  const exact = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'insert', after: 's1/p3', text: '가', style: `&${pua}` }] }, user, AGENT);
  assert.ok(!exact.failed && !exact.notes, JSON.stringify(exact));
  // 기호만 다른 이름이 여럿이면 오류(후보를 보인다) — 스타일 목록만 보는 가짜 문서
  const fake = { formattingCatalog: () => ({ styles: [{ id: 1, name: `&${pua} 제목`, type: 'PARA' }, { id: 2, name: '&◆ 제목', type: 'PARA' }, { id: 3, name: '본문', type: 'PARA' }] }) };
  const two = prepareOps(fake, parseOps([{ op: 'insert', after: 's0/p1', text: '가', style: '&■ 제목' }]).ok);
  assert.equal(two.errors.length, 1); assert.match(two.errors[0].error, /기호만 다른 이름이 여럿/); assert.match(two.errors[0].error, /&◆ 제목/);
  const one = prepareOps(fake, parseOps([{ op: 'insert', after: 's0/p1', text: '가', style: '&■ 본문' }]).ok);
  assert.equal(one.errors.length, 1); assert.match(one.errors[0].error, /이 문서에 없습니다/, '자리표를 빼면 다른 이름은 맞추지 않는다');
});
