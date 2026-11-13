import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCodexAgentArgs, runCodexAgent } from '../scripts/codex-agent.mjs';

const names = ['get_orchestration_profile', 'claim_orchestration_task', 'plan_orchestration_run', 'heartbeat_orchestration_task',
  'submit_orchestration_task', 'fail_orchestration_task', 'publish_orchestration_result', 'advance_orchestration_run'];
const options = { provider: 'codex', url: 'http://localhost:8787/mcp', token: 'NEVER-LOG-TOKEN' };
function setup({ enabled = true, agents, available = true, profileError, authReady = true, connectionError } = {}) {
  const calls = []; const logs = [];
  const profile = { enabled, conductor: 'my-codex', agents: agents || [{ id: 'my-codex', kind: 'codex', model: '', effort: 'xhigh' }] };
  const ordinary = { started: 0, stopped: 0,
    async connected() { return { listTools: async () => ({ tools: (available ? names : []).map(name => ({ name })) }) }; },
    async callJson(name) { calls.push(name); if (profileError) throw profileError; return profile; },
    start() { this.started++; }, async stop() { this.stopped++; },
  };
  const orchestration = { started: 0, stopped: 0, async profile() { calls.push('orchestration.profile'); return profile; },
    start() { this.started++; }, async stop() { this.stopped++; },
  };
  let captured;
  const dependencies = {
    createWorkerAi: () => ({ async check() { calls.push('auth'); return { ready: authReady, code: authReady ? null : 'CODEX_AUTH_REQUIRED' }; } }),
    createApiWorker: () => ordinary,
    checkWorkerConnection: async () => { calls.push('connection'); if (connectionError) throw connectionError; return { connected: true }; },
    createOrchestrationWorker: args => { captured = args; return orchestration; },
    createOrchestrationAi: (_options, agent) => { calls.push(`ai:${agent.id}`); return { run() { assert.fail('model must not run in launcher'); } }; },
    log: line => logs.push(line),
  };
  return { profile, ordinary, orchestration, dependencies, calls, logs, capture: () => captured };
}

test('Codex 시작 인자는 기존 모델·주소·명령 옵션을 보존하고 API 제공자로 바꾸지 않는다', () => {
  const env = { HWPX_COWORK_TOKEN: 'local-token' };
  const result = parseCodexAgentArgs(['--model', 'my-model', '--url', 'https://example.test/mcp', '--codex-command', 'C:/my codex.exe', '--check'], env);
  assert.equal(result.provider, 'codex'); assert.equal(result.model, 'my-model'); assert.equal(result.command, 'C:/my codex.exe');
  assert.equal(result.url, 'https://example.test/mcp'); assert.equal(result.check, true);
  assert.equal(parseCodexAgentArgs(['--provider', 'openai'], env).provider, 'codex');
  assert.deepEqual(parseCodexAgentArgs(['--help'], {}), { help: true });
});

test('통합 실행기는 두 큐의 사전 점검이 끝난 뒤 둘 다 시작하고 함께 종료한다', async () => {
  const x = setup(); const control = await runCodexAgent({ options, dependencies: x.dependencies });
  assert.equal(control.summary.ordinaryReady, true); assert.equal(control.summary.orchestrationReady, true);
  assert.equal(control.summary.agentId, 'my-codex');
  assert.equal(x.ordinary.started, 1); assert.equal(x.orchestration.started, 1);
  assert.deepEqual(x.calls, ['auth', 'connection', 'get_orchestration_profile', 'ai:my-codex', 'orchestration.profile']);
  assert.equal(x.capture().agentId, 'my-codex'); assert.equal(x.capture().token, options.token);
  assert.ok(!x.logs.join('\n').includes(options.token));
  await control.stop(); await control.stop();
  assert.equal(x.ordinary.stopped, 1); assert.equal(x.orchestration.stopped, 1);
});

test('--check는 두 큐 준비만 확인하고 작업·모델을 시작하지 않는다', async () => {
  const x = setup(); const control = await runCodexAgent({ options: { ...options, check: true }, dependencies: x.dependencies });
  assert.equal(control.summary.modelCalled, false); assert.equal(control.summary.queueClaimed, false);
  assert.equal(x.ordinary.started, 0); assert.equal(x.orchestration.started, 0);
  assert.equal(x.ordinary.stopped, 1); assert.equal(x.orchestration.stopped, 1);
});

test('협업 사용이 꺼져 있어도 프로필의 Codex 실행기는 활성화를 기다릴 준비를 한다', async () => {
  const x = setup({ enabled: false }); const control = await runCodexAgent({ options, dependencies: x.dependencies });
  assert.equal(control.summary.orchestrationEnabled, false); assert.equal(x.orchestration.started, 1);
  assert.ok(x.logs.some(line => line.includes('설정을 켜면'))); await control.stop();
});

test('지휘자가 다른 AI이면 첫 Codex 작업자를 선택하고 없는 경우 일반 큐만 시작한다', async () => {
  const x = setup({ agents: [{ id: 'claude', kind: 'claude-code' }, { id: 'codex-worker', kind: 'codex' }] });
  const control = await runCodexAgent({ options, dependencies: x.dependencies });
  assert.equal(control.summary.agentId, 'codex-worker'); await control.stop();
  const noCodex = setup({ agents: [{ id: 'claude', kind: 'claude-code' }] });
  const normal = await runCodexAgent({ options, dependencies: noCodex.dependencies });
  assert.equal(normal.summary.orchestrationReady, false); assert.equal(noCodex.ordinary.started, 1); assert.equal(noCodex.orchestration.started, 0);
  await normal.stop();
});

test('협업 미지원 서버에서는 일반 요청만 유지하고 사전 점검 실패 시 모든 생성 자원을 정리한다', async () => {
  const old = setup({ available: false }); const control = await runCodexAgent({ options, dependencies: old.dependencies });
  assert.equal(control.summary.orchestrationReady, false); assert.equal(old.calls.includes('get_orchestration_profile'), false); await control.stop();
  const broken = setup({ profileError: Object.assign(new Error('private error'), { code: 'ORCHESTRATION_STORAGE' }) });
  await assert.rejects(runCodexAgent({ options, dependencies: broken.dependencies }), { code: 'ORCHESTRATION_STORAGE' });
  assert.equal(broken.ordinary.started, 0); assert.equal(broken.ordinary.stopped, 1);
  const login = setup({ authReady: false });
  await assert.rejects(runCodexAgent({ options, dependencies: login.dependencies }), { code: 'CODEX_AUTH_REQUIRED' });
  assert.equal(login.ordinary.started, 0); assert.equal(login.calls.includes('connection'), false);
});

test('두 번 클릭하는 시작 파일이 통합 실행기를 호출하고 환경 토큰·서버 시작 흐름을 유지한다', () => {
  const batch = fs.readFileSync(new URL('../start-codex-agent.bat', import.meta.url), 'utf8');
  assert.match(batch, /node scripts\\codex-agent\.mjs %\* --provider codex/);
  assert.match(batch, /reg query HKCU\\Environment \/v HWPX_COWORK_TOKEN/);
  assert.match(batch, /start-server\.bat/);
  assert.match(batch, /멀티에이전트 협업/);
});
