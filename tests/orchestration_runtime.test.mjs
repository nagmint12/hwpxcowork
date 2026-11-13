import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrationRuntime } from '../server/orchestration-runtime.js';

function fixture() {
  let time = Date.parse('2026-10-30T03:00:00Z');
  const user = { name: 'a' }; const other = { name: 'b' };
  const settings = { enabled: true, conductor: 'codex', agents: [{ id: 'codex', kind: 'codex', roles: ['conductor'] }, { id: 'claude-code', kind: 'claude-code', roles: ['worker', 'reviewer'] }] };
  const run = { id: 'r1', status: 'planning', profile: settings, tasks: [{ id: 'r1-plan', kind: 'plan', agent_id: 'codex', status: 'pending', depends_on: [] }] };
  const runtime = createOrchestrationRuntime({ now: () => time, profile: () => settings, listRuns: who => who.name === user.name ? [run] : [], getRun: (who, id) => { if (who.name !== user.name || id !== run.id) throw new Error('NO_RUN'); return run; }, connections: () => [{ channel: true, agent: 'ChatGPT (Codex)', client: 'hwpx-codex-worker' }, { channel: true, agent: 'Claude Code', client: 'claude-code' }] });
  return { runtime, user, other, forward: ms => time += ms };
}

test('일반 Codex 채널은 협업 실행기 연결로 표시하지 않는다', () => {
  const { runtime, user } = fixture(); const status = runtime.status(user);
  assert.equal(status.agents[0].online, false); assert.equal(status.agents[1].source, 'channel');
  assert.equal(status.waiting[0].reason, 'agent_offline'); assert.equal(status.queue.pending_tasks, 1);
});

test('협업 실행기 생존 보고와 TTL 만료가 대기 원인을 바꾼다', () => {
  const { runtime, user, forward } = fixture();
  runtime.report(user, { agent_id: 'codex', session: 'worker-session', phase: 'idle' });
  assert.equal(runtime.status(user).waiting[0].reason, 'waiting_for_claim');
  runtime.report(user, { agent_id: 'codex', session: 'worker-session', phase: 'working', run_id: 'r1', task_id: 'r1-plan' });
  assert.equal(runtime.status(user).agents[0].phase, 'working');
  forward(90001); assert.equal(runtime.status(user).agents[0].online, false);
});

test('보고는 개인별로 분리하고 종료한 옛 세션이 새 실행기를 가리지 않는다', () => {
  const { runtime, user, other, forward } = fixture();
  runtime.report(user, { agent_id: 'codex', session: 'new-session', phase: 'idle' });
  forward(1); runtime.report(user, { agent_id: 'codex', session: 'old-session', phase: 'stopping' });
  assert.equal(runtime.status(user).agents[0].online, true);
  assert.equal(runtime.status(other).workers.length, 0);
});

test('등록되지 않은 실행기·다른 사용자의 실행·원시 오류 문자열은 거절한다', () => {
  const { runtime, user, other } = fixture();
  assert.throws(() => runtime.report(user, { agent_id: 'unknown', session: 's', phase: 'idle' }), { code: 'AGENT_NOT_CONFIGURED' });
  assert.throws(() => runtime.report(other, { agent_id: 'codex', session: 's', phase: 'working', run_id: 'r1' }), /NO_RUN/);
  assert.throws(() => runtime.report(user, { agent_id: 'codex', session: 's', phase: 'error', error_code: 'sensitive response secret' }), { code: 'BAD_WORKER_STATUS' });
});
