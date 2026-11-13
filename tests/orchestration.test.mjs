// 실제 문서·설정·유료 API를 사용하지 않는 오케스트레이션 상태머신 검증.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestration } from '../server/orchestration.js';

const A = { name: '홍길동' }; const B = { name: '김검토' };
function setup(t, profile = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-orchestration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  let time = Date.parse('2026-10-30T00:00:00Z');
  const config = { dataDir }; const now = () => time;
  const core = createOrchestration({ config, now });
  core.saveProfile(A, { enabled: true, ...profile });
  return { core, config, now, tick(ms) { time += ms; }, file: path.join(dataDir, 'orchestration.json') };
}
const create = core => core.createRun(A, { doc_id: 'doc-test', goal: '교육사회학 전공 한 학기 강의계획서 작성', base_version: 7 });
const claim = (core, run, agent_id = 'codex', session = agent_id) => core.claim(A, { run_id: run.id, agent_id, session });
const args = (leased, session = leased.agent.id) => ({ run_id: leased.run.id, task_id: leased.task.id, lease_token: leased.lease_token, attempt: leased.attempt, session });
const tasks = () => [
  { id: 'draft', agent_id: 'claude-code', kind: 'work', title: '초안', instruction: '15주 강의계획 초안을 작성한다', depends_on: [] },
  { id: 'review', agent_id: 'api-worker', kind: 'review', title: '전공 수준 검토', instruction: '주별 학습목표와 평가 정합성을 검토한다', depends_on: ['draft'] },
  { id: 'final', agent_id: 'codex', kind: 'synthesize', title: '통합', instruction: '검토를 반영한 최종 제안과 공유 요약을 만든다', depends_on: [] },
];
function planned(core, run = create(core)) {
  const leased = claim(core, run);
  const result = core.plan(A, { ...args(leased), tasks: tasks() });
  return { run: result, leased };
}
function finishRound(core, run) {
  const draft = claim(core, run, 'claude-code'); core.submit(A, { ...args(draft), result: { text: '초안' } });
  const review = claim(core, run, 'api-worker'); core.submit(A, { ...args(review), result: { comments: ['이론과 사례의 연결을 강화'] } });
  const final = claim(core, run); return core.submit(A, { ...args(final), result: { summary: '한 학기 강의계획서를 작성했습니다', proposals: [] } });
}

test('사용자별 설정·실행 격리와 프로토타입 이름, 재시작 저장', t => {
  const s = setup(t); const { core } = s;
  assert.equal(core.profile(B).enabled, false);
  assert.equal(core.profile(A).agents[0].effort, 'xhigh');
  core.saveProfile({ name: '__proto__' }, { enabled: true, maxParallel: 2 });
  core.saveProfile({ name: 'constructor' }, { enabled: true, maxParallel: 4 });
  assert.equal(core.profile({ name: '__proto__' }).maxParallel, 2);
  assert.equal(core.profile({ name: 'constructor' }).maxParallel, 4);
  const run = create(core);
  assert.throws(() => core.getRun(B, run.id), { code: 'NO_ORCHESTRATION_RUN', status: 404 });
  assert.equal(core.listRuns(B).length, 0);
  const again = createOrchestration({ config: s.config, now: s.now });
  assert.equal(again.getRun(A, run.id).goal, run.goal);
  assert.equal(again.profile({ name: '__proto__' }).maxParallel, 2);
  const view = again.profile(A); view.agents[0].effort = 'medium';
  assert.equal(again.profile(A).agents[0].effort, 'xhigh', '반환 객체로 저장 상태를 변경할 수 없음');
});

test('설정에서 비밀키·임의 명령·중복 ID·역할·상한을 거절', t => {
  const { core } = setup(t);
  for (const invalid of [{ key: 'secret' }, { command: 'cmd.exe' }, { maxParallel: 0 }, { maxRounds: 11 }, { maxAttempts: 6 }, { leaseSeconds: 2 }, { maxTasks: 201 }, { enabled: 'true' }, { conductor: 'missing' }]) assert.throws(() => core.saveProfile(A, invalid), { code: 'BAD_ORCHESTRATION' });
  const agents = core.profile(A).agents;
  assert.throws(() => core.saveProfile(A, { agents: [...agents, agents[0]] }), { code: 'BAD_ORCHESTRATION' });
  assert.throws(() => core.saveProfile(A, { agents: [{ ...agents[0], roles: ['worker'] }] }), { code: 'BAD_ORCHESTRATION' });
  assert.throws(() => core.createRun(B, { doc_id: 'd', goal: '글', base_version: 1 }), { code: 'ORCHESTRATION_DISABLED' });
});

test('지휘자의 계획→작업자→검토자→통합→완료, 통합 의존성 강제', t => {
  const { core } = setup(t); const { run } = planned(core);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.tasks.at(-1).depends_on, ['r1-draft', 'r1-review']);
  assert.deepEqual(claim(core, run, 'api-worker'), { none: true });
  assert.deepEqual(claim(core, run), { none: true });
  const final = finishRound(core, run); assert.equal(final.status, 'awaiting_review');
  assert.throws(() => core.advance(A, { run_id: run.id, action: 'complete', session: 'wrong' }), { code: 'NOT_CONDUCTOR' });
  assert.equal(core.authorizeConductor(A, { run_id: run.id, session: 'codex' }), true);
  const done = core.advance(A, { run_id: run.id, action: 'complete', session: 'codex', summary: '강의계획서를 작성했습니다' });
  assert.equal(done.status, 'completed'); assert.equal(done.tasks.filter(task => task.status === 'completed').length, 4);
  assert.equal(done.final_result.summary, '한 학기 강의계획서를 작성했습니다');
  assert.equal(core.advance(A, { run_id: run.id, action: 'complete', session: 'codex' }).status, 'completed', '응답 유실 뒤 완료 재전송은 멱등');
  assert.deepEqual(claim(core, run), { none: true });
});

test('계획의 순환·없는 의존성·잘못된 에이전트·중복 통합을 원자적으로 거절', t => {
  const { core } = setup(t); const run = create(core); const leased = claim(core, run);
  const cycle = tasks(); cycle[0].depends_on = ['review'];
  const missing = tasks(); missing[1].depends_on = ['missing'];
  const wrongRole = tasks(); wrongRole[0].agent_id = 'codex';
  const dependFinal = tasks(); dependFinal[0].depends_on = ['final'];
  for (const plan of [cycle, missing, wrongRole, dependFinal, [...tasks(), { ...tasks()[2], id: 'final2' }]]) {
    assert.throws(() => core.plan(A, { ...args(leased), tasks: plan }), { code: 'BAD_ORCHESTRATION' });
    assert.equal(core.getRun(A, run.id).tasks.length, 1);
  }
  assert.equal(core.plan(A, { ...args(leased), tasks: tasks() }).tasks.length, 4);
});

test('병렬 상한과 원자적 선점으로 동일 작업의 중복 수행 방지', async t => {
  const { core } = setup(t, { maxParallel: 2 }); const run = create(core); const planning = claim(core, run);
  const plan = tasks(); plan[1] = { ...plan[0], id: 'second' }; plan.splice(2, 0, { ...plan[0], id: 'third' });
  core.plan(A, { ...args(planning), tasks: plan });
  const leases = await Promise.all(['one', 'two', 'three', 'four'].map(session => Promise.resolve().then(() => claim(core, run, 'claude-code', session))));
  assert.equal(leases.filter(lease => !lease.none).length, 2);
  assert.notEqual(leases[0].task.id, leases[1].task.id);
  assert.deepEqual(leases[2], { none: true });
  core.submit(A, { ...args(leases[0], 'one'), result: { text: '작성' } });
  assert.equal(claim(core, run, 'claude-code', 'three').task.id, 'r1-third');
});

test('임대 만료 후 같은 세션도 새 토큰·attempt가 필요하며 옛 제출 거부', t => {
  const s = setup(t, { leaseSeconds: 30 }); const { core } = s; const { run } = planned(core);
  const old = claim(core, run, 'claude-code'); s.tick(30001);
  const next = claim(core, run, 'claude-code');
  assert.equal(next.task.id, old.task.id); assert.equal(next.attempt, 2); assert.notEqual(next.lease_token, old.lease_token);
  assert.throws(() => core.submit(A, { ...args(old), result: { text: '옛 결과' } }), { code: 'LEASE_LOST' });
  assert.throws(() => core.heartbeat(A, args(old)), { code: 'LEASE_LOST' });
  core.submit(A, { ...args(next), result: { text: '새 결과' } });
  assert.equal(core.getRun(A, run.id).tasks.find(task => task.id === old.task.id).result.text, '새 결과');
});

test('다른 세션·사용자의 제출 거부, 공개 결과에서 세션·토큰 비노출', t => {
  const { core } = setup(t); const { run } = planned(core); const leased = claim(core, run, 'claude-code', 'private-session');
  const input = args(leased, 'private-session');
  assert.throws(() => core.submit(B, { ...input, result: { text: '시도' } }), { code: 'NO_ORCHESTRATION_RUN' });
  assert.throws(() => core.submit(A, { ...input, session: 'other', result: { text: '시도' } }), { code: 'LEASE_LOST' });
  const visible = JSON.stringify(core.getRun(A, run.id));
  assert.ok(!visible.includes(leased.lease_token)); assert.ok(!visible.includes('private-session'));
});

test('계획과 작업 결과 재전송은 멱등, 다른 결과로 덮어쓰기 거부', t => {
  const { core } = setup(t, { maxTasks: 4 }); const run = create(core); const leased = claim(core, run);
  const planInput = { ...args(leased), tasks: tasks() };
  core.plan(A, planInput); assert.equal(core.plan(A, planInput).tasks.length, 4);
  const draft = claim(core, run, 'claude-code'); const input = { ...args(draft), result: { text: '완성' } };
  core.submit(A, input); assert.equal(core.submit(A, input).tasks.find(task => task.id === draft.task.id).result.text, '완성');
  assert.throws(() => core.submit(A, { ...input, result: { text: '변경' } }), { code: 'LEASE_LOST' });
});

test('갱신으로 임대 연장, 만료 후 재시도 한도에 이르면 종속 작업까지 중단', t => {
  const s = setup(t, { leaseSeconds: 30, maxAttempts: 2 }); const { core } = s; const { run } = planned(core);
  const leased = claim(core, run, 'claude-code'); s.tick(20000); core.heartbeat(A, args(leased)); s.tick(20000);
  assert.deepEqual(claim(core, run, 'claude-code', 'other'), { none: true });
  s.tick(10001); const next = claim(core, run, 'claude-code', 'other'); assert.equal(next.attempt, 2);
  s.tick(30001); assert.deepEqual(claim(core, run, 'claude-code'), { none: true });
  const failed = core.getRun(A, run.id); assert.equal(failed.status, 'failed');
  assert.equal(failed.tasks.find(task => task.id === next.task.id).status, 'failed');
  assert.equal(failed.tasks.find(task => task.id === 'r1-review').status, 'cancelled');
});

test('명시적 실패는 제한 안에서 재시도하며 임대 갱신은 소유자만 가능', t => {
  const { core } = setup(t, { maxAttempts: 2 }); const { run } = planned(core);
  const first = claim(core, run, 'claude-code'); const retry = core.fail(A, { ...args(first), error: '일시적 오류' });
  assert.equal(retry.tasks.find(task => task.id === first.task.id).status, 'pending');
  const second = claim(core, run, 'claude-code'); const failed = core.fail(A, { ...args(second), error: '재시도 실패' });
  assert.equal(failed.status, 'failed');
  assert.throws(() => core.heartbeat(A, args(first)), { code: 'RUN_CLOSED' });
});

test('문서 개선 회차·전체 작업 수·실행 시간 한도를 지킨다', t => {
  const s = setup(t, { maxRounds: 2, maxTasks: 8, maxRunMinutes: 2 }); const { core } = s;
  let { run } = planned(core); finishRound(core, run);
  run = core.advance(A, { run_id: run.id, action: 'revise', session: 'codex', summary: '구체성을 보완' });
  assert.equal(run.round, 2); assert.equal(run.tasks.length, 5);
  const plan2 = claim(core, run); core.plan(A, { ...args(plan2), tasks: tasks() }); finishRound(core, run);
  assert.throws(() => core.advance(A, { run_id: run.id, action: 'revise', session: 'codex' }), { code: 'ROUND_LIMIT' });
  assert.equal(core.getRun(A, run.id).tasks.length, 8);
  s.tick(120001); assert.equal(core.getRun(A, run.id).status, 'failed');
  assert.throws(() => core.advance(A, { run_id: run.id, action: 'complete', session: 'codex' }), { code: 'RUN_CLOSED' });
});

test('계획에서 전체 작업 수 한도 초과를 거절하고 취소 후 늦은 결과를 거절', t => {
  const { core } = setup(t, { maxTasks: 3 }); const run = create(core); const leased = claim(core, run);
  assert.throws(() => core.plan(A, { ...args(leased), tasks: tasks() }), { code: 'TASK_LIMIT' });
  const cancelled = core.advance(A, { run_id: run.id, action: 'cancel' }); assert.equal(cancelled.status, 'cancelled');
  assert.equal(core.advance(A, { run_id: run.id, action: 'cancel' }).status, 'cancelled');
  assert.throws(() => core.plan(A, { ...args(leased), tasks: tasks().slice(1) }), { code: 'RUN_CLOSED' });
  assert.deepEqual(claim(core, run), { none: true });
});

test('재시작 후 검토 대기 지휘자 인수는 임대 만료 뒤에만 가능', t => {
  const s = setup(t, { leaseSeconds: 30 }); const { core } = s; const { run } = planned(core); finishRound(core, run);
  const again = createOrchestration({ config: s.config, now: s.now });
  assert.deepEqual(claim(again, run, 'codex', 'new-session'), { none: true });
  s.tick(30001);
  assert.throws(() => core.authorizeConductor(A, { run_id: run.id, session: 'codex' }), { code: 'NOT_CONDUCTOR' });
  const review = claim(again, run, 'codex', 'new-session'); assert.equal(review.review, true); assert.equal(review.task.kind, 'synthesize');
  assert.equal(again.authorizeConductor(A, { run_id: run.id, session: 'new-session' }), true);
  s.tick(20000); again.heartbeat(A, args(review, 'new-session')); s.tick(20000);
  assert.equal(again.advance(A, { run_id: run.id, action: 'complete', session: 'new-session' }).status, 'completed');
});

test('실행 중 개인 설정 변경은 이미 시작한 실행의 배정·한도를 바꾸지 않는다', t => {
  const { core } = setup(t); const run = create(core);
  core.saveProfile(A, { enabled: false, maxParallel: 1, conductor: 'claude-code', agents: core.profile(A).agents.map(agent => ({ ...agent, roles: ['conductor', 'worker', 'reviewer'] })) });
  assert.equal(claim(core, run).task.kind, 'plan');
  assert.equal(core.getRun(A, run.id).profile.conductor, 'codex');
  assert.equal(core.getRun(A, run.id).profile.maxParallel, 3);
  assert.throws(() => create(core), { code: 'ORCHESTRATION_DISABLED' });
});

test('저장 실패는 메모리 상태도 되돌리고 결과 크기를 제한한다', t => {
  const s = setup(t); const { core } = s; const { run } = planned(core); const leased = claim(core, run, 'claude-code');
  assert.throws(() => core.submit(A, { ...args(leased), result: { text: '가'.repeat(40000) } }), { code: 'BAD_ORCHESTRATION' });
  const saved = fs.readFileSync(s.file, 'utf8'); fs.unlinkSync(s.file); fs.mkdirSync(s.file);
  assert.deepEqual(claim(core, run, 'api-worker'), { none: true }, '빈 polling은 저장소에 쓰지 않음');
  assert.equal(core.saveProfile(A, core.profile(A)).maxParallel, 3, '변경 없는 저장도 fsync 생략');
  assert.throws(() => core.submit(A, { ...args(leased), result: { text: '저장 실패' } }), { code: 'ORCHESTRATION_STORAGE' });
  assert.equal(core.getRun(A, run.id).tasks.find(task => task.id === leased.task.id).status, 'running');
  fs.rmdirSync(s.file); fs.writeFileSync(s.file, saved);
  assert.equal(core.submit(A, { ...args(leased), result: { text: '정상' } }).tasks.find(task => task.id === leased.task.id).result.text, '정상');
});
