// 실제 모델 호출 없이 개인 실행기와 실제 오케스트레이션 큐의 협업을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestration, DEFAULT_ORCHESTRATION_PROFILE } from '../server/orchestration.js';
import { createOrchestrationWorker, orchestrationInput, orchestrationPlan, synthesisDecision, orchestrationErrorMessage } from '../server/orchestration-worker.js';
import { parseOrchestrationArgs, createOrchestrationAi } from '../scripts/orchestration-worker.mjs';

const user = { name: '시험 사용자' };
const paragraphs = [{ ref: 's0/p0', text: '원래 문장' }];
const result = extra => ({ proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '결과를 검토했습니다.', instructionSummary: '문서 검토', ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(5); }
  assert.fail('실행기 상태 전환 시간 초과');
}
const plan = [
  { id: 'draft', agent_id: 'claude-code', kind: 'work', title: '초안', instruction: '전공 수준의 초안을 작성', depends_on: [] },
  { id: 'review', agent_id: 'api-worker', kind: 'review', title: '전문 검토', instruction: '초안의 근거와 구조 검토', depends_on: ['draft'] },
  { id: 'synthesis', agent_id: 'codex', kind: 'synthesize', title: '통합', instruction: '하나의 개선안으로 통합', depends_on: ['draft', 'review'] },
];

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-orchestration-worker-'));
  const clock = { value: Date.now() };
  const store = createOrchestration({ config: { dataDir: directory }, now: () => clock.value });
  store.saveProfile(user, { ...structuredClone(DEFAULT_ORCHESTRATION_PROFILE), enabled: true, maxRounds: 2, leaseSeconds: 30 });
  const publications = []; const calls = [];
  const methods = { claim_orchestration_task: 'claim', plan_orchestration_run: 'plan', heartbeat_orchestration_task: 'heartbeat', submit_orchestration_task: 'submit', fail_orchestration_task: 'fail', advance_orchestration_run: 'advance' };
  const callJson = async (name, args, { session }) => {
    calls.push({ name, args, session });
    if (name === 'get_orchestration_profile') return store.profile(user);
    if (name === 'get_orchestration_run') return store.getRun(user, args.run_id);
    if (name === 'publish_orchestration_result') { store.authorizeConductor(user, { ...args, session }); publications.push(args); return { published: true }; }
    if (!methods[name]) throw new Error(`지원하지 않는 시험 도구 ${name}`);
    return store[methods[name]](user, { ...args, session });
  };
  const workers = [];
  const worker = (agentId, ai, options = {}) => {
    const execution = createOrchestrationWorker({ url: 'http://localhost:9876/mcp', token: 'test-token', agentId, ai, session: `${agentId}-test-session`,
      callJson, readParagraphs: async () => paragraphs, timing: { pollMs: 1000, heartbeatMs: 10 }, log() {}, ...options });
    workers.push(execution); return execution;
  };
  return { store, calls, publications, clock, worker, callJson, async stop() {
    await Promise.all(workers.map(w => w.stop())); fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('개인 오케스트레이션 CLI는 게이트웨이 키와 명시한 세션만 사용하고 추론값을 적용', () => {
  const env = { HWPX_COWORK_TOKEN: 'user-token', BAZE_API_KEY: 'gateway-key', OPENAI_API_KEY: 'provider-key' };
  const options = parseOrchestrationArgs(['--agent-id', 'api-worker', '--provider', 'openai', '--gateway', 'baze', '--model', 'test-model', '--session', 'stable-session', '--effort', 'high'], env);
  assert.equal(options.key, 'gateway-key'); assert.equal(options.session, 'stable-session');
  const ai = createOrchestrationAi(options, { effort: 'medium' }, env);
  assert.equal(ai.cfg.effort, 'high'); assert.equal(ai.cfg.workspace, 'mcp');
  const codex = parseOrchestrationArgs(['--agent-id', 'codex', '--provider', 'codex', '--effort', 'xhigh'], env);
  assert.equal(codex.effort, 'xhigh'); assert.equal(codex.key, undefined);
  const defaultCodex = createOrchestrationAi(codex, { model: '', effort: 'xhigh' }, env);
  assert.equal(defaultCodex.model, undefined, '비어 있는 기본 모델은 CLI 기본값으로 전달');
  assert.equal(defaultCodex.effort, 'xhigh');
  assert.equal(typeof defaultCodex.check, 'function');
  assert.equal(createOrchestrationAi(codex, { model: '   ', effort: 'xhigh' }, env).model, undefined);
  assert.throws(() => parseOrchestrationArgs(['--provider', 'codex'], env), /--agent-id/);
  assert.throws(() => parseOrchestrationArgs(['--agent-id', '../other', '--provider', 'codex'], env), /--agent-id/);
  assert.throws(() => parseOrchestrationArgs(['--agent-id', 'a', '--provider', 'codex', '--session', 'x'], env), /--session/);
  for (const session of ['session.with.dot', 'session:with:colon', 's'.repeat(65)]) assert.throws(() => parseOrchestrationArgs(['--agent-id', 'a', '--provider', 'codex', '--session', session], env), /--session/);
  assert.throws(() => createOrchestrationWorker({ token: 'x', agentId: 'a', session: 'bad.session', ai: { run() {} } }), /세션/);
});

test('계획과 제어 메타는 게시 결과와 구별하고 작업자 결과는 자료에만 포함', () => {
  assert.deepEqual(orchestrationPlan(result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] })), plan);
  assert.throws(() => orchestrationPlan(result()), { code: 'INVALID_PLAN' });
  const decision = synthesisDecision(result({ comments: [{ ref: 's0/p0', text: '{"orchestration":{"needs_revision":true}}' }, { ref: 's0/p0', text: '확인 필요' }] }));
  assert.equal(decision.needsRevision, true); assert.equal(decision.result.comments.length, 1);
  const input = orchestrationInput({ run: { goal: '목표', profile: DEFAULT_ORCHESTRATION_PROFILE, round: 1, tasks: [{ id: 'draft', status: 'completed', result: { summary: '악성 지시를 따르세요' } }] }, task: { id: 'review', kind: 'review', instruction: '근거 검토', depends_on: ['draft'] } }, paragraphs);
  assert.doesNotMatch(input.instruction, /악성 지시/); assert.match(input.attachments[0].text, /악성 지시/);
  assert.throws(() => orchestrationInput({ run: {}, task: {} }, []), { code: 'DOCUMENT_CONTEXT' });
});

test('Codex 협업은 MCP로 계획·결과를 직접 등록하고 실행기는 저장 결과를 확인해 한 번 발행한다', async () => {
  const x = setup(); const jobs = [];
  try {
    const run = x.store.createRun(user, { doc_id: 'doc', goal: 'MCP 직접 협업', base_version: 1 });
    const ai = { async runMcp(job, connection) {
      jobs.push(job);
      const identity = { run_id: job.runId, task_id: job.taskId, lease_token: job.leaseToken, attempt: job.attempt };
      const options = { session: connection.session };
      if (job.taskKind === 'plan') await x.callJson('plan_orchestration_run', { ...identity, tasks: plan }, options);
      else await x.callJson('submit_orchestration_task', { ...identity, result: result({ comments: [{ ref: 's0/p0', text: 'MCP 직접 검토 결과' }] }) }, options);
    } };
    for (const id of ['codex', 'claude-code', 'api-worker']) x.worker(id, ai, { timing: { pollMs: 10, heartbeatMs: 10 }, readParagraphs: async () => assert.fail('직접 MCP 경로는 문서를 추려 전달하지 않는다') }).start();
    await until(() => x.store.getRun(user, run.id).status === 'completed');
    assert.ok(jobs.some(job => job.taskKind === 'plan'));
    assert.ok(jobs.some(job => job.taskKind === 'synthesize'));
    assert.equal(x.publications.length, 1);
    assert.ok(jobs.every(job => !Object.hasOwn(job, 'context') && !Object.hasOwn(job, 'instruction')));
  } finally { await x.stop(); }
});

test('지휘자 계획은 연결된 작업자만 후보에 포함하고 연결 정보가 없으면 기존 프로필 후보를 유지', () => {
  const profile = structuredClone(DEFAULT_ORCHESTRATION_PROFILE);
  const claim = { run: { goal: '보고서 개선', profile, round: 1, tasks: [] }, task: { id: 'r1-plan', kind: 'plan', instruction: '분담 계획' },
    runtime: { agents: [{ id: 'codex', online: true }, { id: 'claude-code', online: true }, { id: 'api-worker', online: false }] } };
  const input = orchestrationInput(claim, paragraphs);
  assert.match(input.instruction, /claude-code/); assert.doesNotMatch(input.instruction, /api-worker/);
  assert.match(input.instruction, /"roles":\["worker","reviewer"\]/); assert.match(input.instruction, /"effort":"high"/);
  assert.match(input.instruction, /오프라인 에이전트에 배정하면/); assert.match(input.instruction, /conductor 역할만 있는 지휘자/);
  assert.equal(profile.agents.length, 3); assert.ok(profile.agents.some(agent => agent.id === 'api-worker'), '프로필 스냅샷은 변경하지 않음');
  const legacy = orchestrationInput({ ...claim, runtime: undefined }, paragraphs);
  assert.match(legacy.instruction, /api-worker/);
  const conductorOnly = orchestrationInput({ ...claim, runtime: { agents: [] } }, paragraphs);
  assert.match(conductorOnly.instruction, /codex/); assert.doesNotMatch(conductorOnly.instruction, /claude-code|api-worker/);
});

test('문서 크기 제한은 서식 메타데이터·주소·빈 문단을 제외한 본문 글자 수로 검사', () => {
  const claim = { run: { goal: '보고서 개선', profile: DEFAULT_ORCHESTRATION_PROFILE, tasks: [] }, task: { id: 'r1-plan', kind: 'plan' } };
  const richParagraphs = Array.from({ length: 8000 }, (_, index) => ({ ref: `s0/p${index}`, text: index % 10 ? '' : '검토할 짧은 문장', formatting: { metadata: '서식'.repeat(100) } }));
  assert.ok(JSON.stringify(richParagraphs).length > 200000);
  const input = orchestrationInput(claim, richParagraphs);
  assert.equal(input.context.length, richParagraphs.length);
  assert.deepEqual(input.context.map(paragraph => paragraph.ref), richParagraphs.map(paragraph => paragraph.ref), '모든 원본 문단 주소와 빈 문단을 보존');
  assert.ok(input.context.every(paragraph => !Object.hasOwn(paragraph, 'formatting')), '불필요한 서식 메타데이터는 모델 문맥에 복사하지 않음');
  assert.equal(orchestrationInput(claim, [{ ref: 's0/p0', text: '가'.repeat(200000) }]).context[0].text.length, 200000);
  assert.throws(() => orchestrationInput(claim, [{ ref: 's0/p0', text: '가'.repeat(200001) }]), { code: 'DOCUMENT_TOO_LARGE' });
});

test('실제 코어와 세 실행기: 계획→초안→검토→통합→재검토→제안 게시→완료', async () => {
  const fixture = setup(); const modelCalls = [];
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '보고서를 논문 형식으로 개선', base_version: 1 });
    const conductor = fixture.worker('codex', { async run(input) {
      modelCalls.push({ agent: 'codex', input });
      if (input.label.endsWith('plan')) return result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] });
      const round = /회차: (\d+)/.exec(input.instruction)?.[1];
      return result({ proposals: [{ ref: 's0/p0', find: '원래 문장', replace: '검증된 개선 문장', reason: '논리 개선' }],
        comments: [{ ref: 's0/p0', text: JSON.stringify({ orchestration: { needs_revision: round === '1' } }) }] });
    } });
    const draft = fixture.worker('claude-code', { async run(input) { modelCalls.push({ agent: 'claude-code', input }); return result({ inserts: [{ afterRef: 's0/p0', text: '전문 초안', reason: '내용 보강' }] }); } });
    const review = fixture.worker('api-worker', { async run(input) { modelCalls.push({ agent: 'api-worker', input }); return result({ comments: [{ ref: 's0/p0', text: '전문 초안을 검토했습니다.' }] }); } });
    await conductor.drain();
    assert.equal(modelCalls.length, 1, '지휘자는 계획 후 작업자 완료를 기다림');
    for (let round = 1; round <= 2; round++) {
      await review.drain(); assert.equal(modelCalls.filter(c => c.agent === 'api-worker').length, round - 1, '검토자는 초안 의존성 대기');
      await draft.drain(); await review.drain(); await conductor.drain();
    }
    const ended = fixture.store.getRun(user, run.id);
    assert.equal(ended.status, 'completed'); assert.equal(ended.round, 2);
    assert.equal(conductor.stats().revised, 1); assert.equal(fixture.publications.length, 1);
    assert.deepEqual(modelCalls.map(c => c.agent), ['codex', 'claude-code', 'api-worker', 'codex', 'codex', 'claude-code', 'api-worker', 'codex']);
    const synthesis = modelCalls.find(c => c.input.label.endsWith('synthesize'));
    assert.match(synthesis.input.attachments[0].text, /전문 초안/);
    assert.ok(fixture.calls.every(call => !Object.hasOwn(call.args, 'session')), '세션은 호출 헤더/서버 측에서만 연결');
  } finally { await fixture.stop(); }
});

test('임대 갱신 오류는 실행 중 모델을 중단하고 늦은 결과 제출을 막음', async () => {
  const fixture = setup(); let resolveLate; let modelSignal;
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { run(input, { signal }) { modelSignal = signal; return new Promise(resolve => { resolveLate = resolve; }); } }, {
      callJson: async (name, args, context) => {
        if (name === 'get_orchestration_profile') return fixture.store.profile(user);
        if (name === 'claim_orchestration_task') return fixture.store.claim(user, { ...args, session: context.session });
        if (name === 'heartbeat_orchestration_task') throw new Error('임대 상실');
        fixture.calls.push({ name, args }); return {};
      },
    });
    await worker.drain();
    assert.equal(modelSignal.aborted, true);
    resolveLate(result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.store.getRun(user, run.id).tasks[0].status, 'running');
    assert.ok(!fixture.calls.some(call => ['submit_orchestration_task', 'plan_orchestration_run'].includes(call.name)));
  } finally { resolveLate?.(result()); await fixture.stop(); }
});

test('재시작 지휘자는 만료된 통합 검토를 인수하고 모델 재호출 없이 게시', async () => {
  const fixture = setup();
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const planClaim = fixture.store.claim(user, { agent_id: 'codex', session: 'old-conductor-session' });
    fixture.store.plan(user, { run_id: run.id, session: 'old-conductor-session', lease_token: planClaim.lease_token, attempt: planClaim.attempt, tasks: plan });
    for (const agentId of ['claude-code', 'api-worker', 'codex']) {
      const task = fixture.store.claim(user, { agent_id: agentId, session: 'old-conductor-session' });
      fixture.store.submit(user, { run_id: run.id, task_id: task.task.id, session: 'old-conductor-session', lease_token: task.lease_token, attempt: task.attempt, result: result() });
    }
    fixture.clock.value += 31000;
    const conductor = fixture.worker('codex', { run() { assert.fail('저장된 통합 결과는 모델 재호출 없이 복구'); } });
    await conductor.drain();
    assert.equal(fixture.store.getRun(user, run.id).status, 'completed'); assert.equal(fixture.publications.length, 1);
  } finally { await fixture.stop(); }
});

test('잘못된 계획은 실패 처리 뒤 다음 poll까지 즉시 과금 재시도를 멈춤', async () => {
  const fixture = setup(); let calls = 0;
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { async run() { calls++; return result(); } });
    await worker.drain();
    assert.equal(calls, 1); assert.equal(worker.stats().failed, 1);
    assert.equal(fixture.store.getRun(user, run.id).tasks[0].status, 'pending');
    assert.match(fixture.store.getRun(user, run.id).tasks[0].error, /^INVALID_PLAN:/);
  } finally { await fixture.stop(); }
});

test('모델 실행 상태·임대 갱신·고정 경과 로그를 노출하고 완료 후 경과 타이머를 정리', async () => {
  const fixture = setup(); const logs = []; const reports = []; let resolveModel;
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '절대 로그에 넣지 않을 비밀 목표', base_version: 1 });
    const worker = fixture.worker('codex', { run() { return new Promise(resolve => { resolveModel = resolve; }); } }, {
      log: message => logs.push(message), timing: { heartbeatMs: 10, statusMs: 10, reportTimeoutMs: 30 },
      callJson: async (name, args, context) => {
        if (name === 'report_orchestration_worker') { reports.push(args); return { ok: true }; }
        return fixture.callJson(name, args, context);
      },
    });
    const execution = worker.drain();
    await until(() => worker.stats().phase === 'model_running');
    assert.equal(worker.stats().runId, run.id); assert.equal(worker.stats().taskId, 'r1-plan');
    assert.ok(worker.stats().startedAt); assert.ok(worker.stats().lastPollAt);
    await until(() => logs.some(message => message.includes('초 경과')) && worker.stats().lastHeartbeatAt);
    resolveModel(result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] }));
    await execution; await worker.reportState();
    assert.equal(worker.stats().phase, 'idle'); assert.equal(worker.stats().taskId, null);
    assert.equal(worker.stats().completed, 1);
    const elapsedLogs = logs.filter(message => message.includes('초 경과')).length;
    await sleep(40);
    assert.equal(logs.filter(message => message.includes('초 경과')).length, elapsedLogs, '모델 완료 후 타이머 중지');
    assert.ok(reports.some(report => report.phase === 'working' && report.task_id === 'r1-plan'));
    assert.ok(reports.some(report => report.phase === 'idle'));
    assert.doesNotMatch(JSON.stringify(logs) + JSON.stringify(reports), /비밀 목표|test-token|lease_token|instruction/);
  } finally { resolveModel?.(result()); await fixture.stop(); }
});

test('상태 보고 도구가 없는 구버전 서버에서도 모델 작업은 정상 완료', async () => {
  const fixture = setup(); let reports = 0;
  try {
    fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { async run() { return result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] }); } }, {
      callJson: async (name, args, context) => {
        if (name === 'report_orchestration_worker') { reports++; throw Object.assign(new Error('미지원'), { code: -32601 }); }
        return fixture.callJson(name, args, context);
      },
    });
    await worker.drain(); await worker.reportState();
    assert.equal(worker.stats().completed, 1); assert.equal(worker.stats().failed, 0); assert.equal(reports, 1);
  } finally { await fixture.stop(); }
});

test('응답 없는 선택적 상태 보고가 모델 결과 제출을 막지 않음', async () => {
  const fixture = setup();
  try {
    fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { async run() { return result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] }); } }, {
      timing: { heartbeatMs: 10, statusMs: 10, reportTimeoutMs: 10 },
      callJson: (name, args, context) => name === 'report_orchestration_worker' ? new Promise(() => {}) : fixture.callJson(name, args, context),
    });
    await worker.drain(); assert.equal(worker.stats().completed, 1);
    await worker.reportState(); assert.equal(worker.stats().phase, 'idle');
  } finally { await fixture.stop(); }
});

test('실패 로그와 상태 보고는 알려진 오류 코드만 포함하고 모델 원시 오류를 숨김', async () => {
  const fixture = setup(); const logs = []; const reports = [];
  try {
    fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { async run() { throw Object.assign(new Error('API키 원문 비밀'), { code: 'SECRET_TOKEN_12345' }); } }, {
      log: message => logs.push(message),
      callJson: async (name, args, context) => {
        if (name === 'report_orchestration_worker') { reports.push(args); return { ok: true }; }
        return fixture.callJson(name, args, context);
      },
    });
    await worker.drain(); await worker.reportState();
    assert.equal(worker.stats().lastErrorCode, 'WORKER_ERROR'); assert.equal(worker.stats().phase, 'error');
    assert.ok(reports.some(report => report.phase === 'error' && report.error_code === 'WORKER_ERROR'));
    assert.doesNotMatch(JSON.stringify(logs) + JSON.stringify(reports), /API키|비밀|SECRET_TOKEN/);
    assert.match(orchestrationErrorMessage({ code: 'CODEX_INPUT_INVALID', message: '숨길 토큰' }), /^CODEX_INPUT_INVALID:/);
    assert.doesNotMatch(orchestrationErrorMessage({ code: 'SECRET_TOKEN_12345', message: '숨길 토큰' }), /SECRET_TOKEN|숨길/);
  } finally { await fixture.stop(); }
});

test('꺼진 개인 협업 설정은 idle·enabled=false를 명시하고 작업을 선점하지 않음', async () => {
  const fixture = setup(); const logs = [];
  try {
    fixture.store.saveProfile(user, { enabled: false });
    const worker = fixture.worker('codex', { run() { assert.fail('꺼진 협업 모델 호출 금지'); } }, { log: message => logs.push(message) });
    await worker.drain(); await worker.drain();
    assert.equal(worker.stats().phase, 'idle'); assert.equal(worker.stats().enabled, false);
    assert.equal(logs.filter(message => message.includes('enabled=false')).length, 1);
    assert.ok(!fixture.calls.some(call => call.name === 'claim_orchestration_task'));
  } finally { await fixture.stop(); }
});

test('연결된 작업자가 없으면 계획을 선점하거나 모델을 호출하지 않고 연결 후 재개', async () => {
  const fixture = setup(); const logs = []; const claims = []; let online = false; let modelCalls = 0;
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { async run() { modelCalls++; return result({ comments: [{ ref: 's0/p0', text: JSON.stringify({ tasks: plan }) }] }); } }, {
      log: message => logs.push(message),
      callJson: async (name, args, context) => {
        if (name === 'claim_orchestration_task') {
          claims.push(args);
          if (!online) return { none: true, reason: 'worker_unavailable' };
        }
        return fixture.callJson(name, args, context);
      },
    });
    await worker.drain(); await worker.drain();
    assert.equal(modelCalls, 0); assert.equal(fixture.store.getRun(user, run.id).tasks[0].attempt, 0);
    assert.equal(worker.stats().phase, 'idle'); assert.equal(worker.stats().waitingReason, 'worker_unavailable');
    assert.equal(logs.filter(message => message.includes('분담 작업자 실행기가 연결될 때까지')).length, 1, '같은 대기 이유는 한 번만 로그');
    assert.ok(claims.every(args => args.require_online_workers === true));
    online = true;
    await worker.drain();
    assert.equal(modelCalls, 1); assert.equal(worker.stats().completed, 1); assert.equal(worker.stats().waitingReason, null);
    assert.equal(fixture.store.getRun(user, run.id).tasks[0].attempt, 1);
  } finally { await fixture.stop(); }
});

test('문서 본문 한도 오류의 공개 코드·안내를 저장해 화면에서 실패 원인을 식별', async () => {
  const fixture = setup();
  try {
    const run = fixture.store.createRun(user, { doc_id: 'sample', goal: '검토', base_version: 1 });
    const worker = fixture.worker('codex', { run() { assert.fail('크기 초과 문서는 모델 호출 전에 중단'); } }, {
      readParagraphs: async () => [{ ref: 's0/p0', text: '본문'.repeat(100001) }],
    });
    await worker.drain();
    assert.equal(worker.stats().lastErrorCode, 'DOCUMENT_TOO_LARGE');
    const saved = fixture.store.getRun(user, run.id).tasks[0].error;
    assert.match(saved, /^DOCUMENT_TOO_LARGE:/); assert.match(saved, /문서 범위를 나누어/);
    assert.doesNotMatch(saved, /본문본문|test-token/);
  } finally { await fixture.stop(); }
});
