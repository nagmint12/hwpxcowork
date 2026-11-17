import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCodexAgentArgs, runCodexAgent, orchestrationWanted } from '../scripts/codex-agent.mjs';

const names = ['get_orchestration_profile', 'claim_orchestration_task', 'plan_orchestration_run', 'heartbeat_orchestration_task',
  'submit_orchestration_task', 'fail_orchestration_task', 'publish_orchestration_result', 'advance_orchestration_run'];
const options = { provider: 'codex', url: 'http://localhost:8787/mcp', token: 'NEVER-LOG-TOKEN' };
// AI 협업 큐는 기본 꺼짐(2026-11-17 사용자 결정) — 협업 갈래를 보는 시험은 이 환경으로 켠다
const ON = { HWPX_COWORK_ORCHESTRATION: '1' };
function setup({ enabled = true, agents, available = true, profileError, authReady = true, connectionError } = {}) {
  const calls = []; const logs = [];
  const profile = { enabled, conductor: 'my-codex', agents: agents || [{ id: 'my-codex', kind: 'codex', model: '', effort: 'xhigh' }] };
  const ordinary = { started: 0, stopped: 0,
    async connected() { calls.push('listTools'); return { listTools: async () => ({ tools: (available ? names : []).map(name => ({ name })) }) }; },
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

test('기본(AI 협업 꺼짐): 일반 큐만 시작하고 협업 도구 확인·프로필 조회·협업 실행기를 만들지 않는다', async () => {
  const x = setup(); const control = await runCodexAgent({ options, env: {}, dependencies: x.dependencies });
  assert.equal(control.summary.ordinaryReady, true); assert.equal(control.summary.orchestrationRequested, false);
  assert.equal(control.summary.orchestrationReady, false); assert.equal(control.summary.agentId, null);
  assert.equal(x.ordinary.started, 1); assert.equal(x.orchestration.started, 0); assert.equal(x.capture(), undefined);
  // 협업 쪽으로는 서버에 아무것도 보내지 않는다(도구 목록·get_orchestration_profile 없음 — 5초마다의 상태 보고도 없다)
  assert.deepEqual(x.calls, ['auth', 'connection']);
  assert.ok(x.logs.some(line => line.includes('AI 협업 큐는 처리하지 않습니다') && line.includes('HWPX_COWORK_ORCHESTRATION=1')));
  assert.ok(x.logs.some(line => line === '일반 요청 자동 처리를 시작했습니다.'));
  await control.stop(); assert.equal(x.ordinary.stopped, 1); assert.equal(x.orchestration.stopped, 0);
  // --check 도 협업 쪽은 보지 않는다
  const check = setup(); const checked = await runCodexAgent({ options: { ...options, check: true }, env: {}, dependencies: check.dependencies });
  assert.deepEqual(check.calls, ['auth', 'connection']); assert.equal(checked.summary.orchestrationReady, false);
});

test('AI 협업 켜기 환경 값: 1·true·on·yes 만 켠다', () => {
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) assert.equal(orchestrationWanted({ HWPX_COWORK_ORCHESTRATION: v }), true, v);
  for (const v of [undefined, '', '0', 'false', 'off', 'no', '2']) assert.equal(orchestrationWanted({ HWPX_COWORK_ORCHESTRATION: v }), false, String(v));
  assert.equal(orchestrationWanted({}), false); assert.equal(orchestrationWanted(undefined), false);
});

test('통합 실행기(협업 켬)는 두 큐의 사전 점검이 끝난 뒤 둘 다 시작하고 함께 종료한다', async () => {
  const x = setup(); const control = await runCodexAgent({ options, env: ON, dependencies: x.dependencies });
  assert.equal(control.summary.ordinaryReady, true); assert.equal(control.summary.orchestrationReady, true);
  assert.equal(control.summary.orchestrationRequested, true); assert.equal(control.summary.agentId, 'my-codex');
  assert.equal(x.ordinary.started, 1); assert.equal(x.orchestration.started, 1);
  assert.deepEqual(x.calls, ['auth', 'connection', 'listTools', 'get_orchestration_profile', 'ai:my-codex', 'orchestration.profile']);
  assert.equal(x.capture().agentId, 'my-codex'); assert.equal(x.capture().token, options.token);
  assert.ok(!x.logs.join('\n').includes(options.token));
  await control.stop(); await control.stop();
  assert.equal(x.ordinary.stopped, 1); assert.equal(x.orchestration.stopped, 1);
});

test('--check(협업 켬)는 두 큐 준비만 확인하고 작업·모델을 시작하지 않는다', async () => {
  const x = setup(); const control = await runCodexAgent({ options: { ...options, check: true }, env: ON, dependencies: x.dependencies });
  assert.equal(control.summary.modelCalled, false); assert.equal(control.summary.queueClaimed, false);
  assert.equal(x.ordinary.started, 0); assert.equal(x.orchestration.started, 0);
  assert.equal(x.ordinary.stopped, 1); assert.equal(x.orchestration.stopped, 1);
});

test('협업 사용이 꺼져 있어도(협업 켬으로 띄운) 프로필의 Codex 실행기는 활성화를 기다릴 준비를 한다', async () => {
  const x = setup({ enabled: false }); const control = await runCodexAgent({ options, env: ON, dependencies: x.dependencies });
  assert.equal(control.summary.orchestrationEnabled, false); assert.equal(x.orchestration.started, 1);
  assert.ok(x.logs.some(line => line.includes('설정을 켜면'))); await control.stop();
});

test('지휘자가 다른 AI이면 첫 Codex 작업자를 선택하고 없는 경우 일반 큐만 시작한다', async () => {
  const x = setup({ agents: [{ id: 'claude', kind: 'claude-code' }, { id: 'codex-worker', kind: 'codex' }] });
  const control = await runCodexAgent({ options, env: ON, dependencies: x.dependencies });
  assert.equal(control.summary.agentId, 'codex-worker'); await control.stop();
  const noCodex = setup({ agents: [{ id: 'claude', kind: 'claude-code' }] });
  const normal = await runCodexAgent({ options, env: ON, dependencies: noCodex.dependencies });
  assert.equal(normal.summary.orchestrationReady, false); assert.equal(noCodex.ordinary.started, 1); assert.equal(noCodex.orchestration.started, 0);
  await normal.stop();
});

test('협업 미지원 서버에서는 일반 요청만 유지하고 사전 점검 실패 시 모든 생성 자원을 정리한다', async () => {
  const old = setup({ available: false }); const control = await runCodexAgent({ options, env: ON, dependencies: old.dependencies });
  assert.equal(control.summary.orchestrationReady, false); assert.equal(old.calls.includes('get_orchestration_profile'), false); await control.stop();
  const broken = setup({ profileError: Object.assign(new Error('private error'), { code: 'ORCHESTRATION_STORAGE' }) });
  await assert.rejects(runCodexAgent({ options, env: ON, dependencies: broken.dependencies }), { code: 'ORCHESTRATION_STORAGE' });
  assert.equal(broken.ordinary.started, 0); assert.equal(broken.ordinary.stopped, 1);
  const login = setup({ authReady: false });
  await assert.rejects(runCodexAgent({ options, env: ON, dependencies: login.dependencies }), { code: 'CODEX_AUTH_REQUIRED' });
  assert.equal(login.ordinary.started, 0); assert.equal(login.calls.includes('connection'), false);
});

// 2026-11-17: 두 번 클릭 시작 파일 start-codex-agent.bat(·-v2)을 지웠다(사용자 결정 — Windows 앱 [AI → 실행기 관리]가 대신한다,
// 사본 backups/v2_default_gui_2026-11-17/). 그 bat 의 글·CRLF·토큰 읽기를 보던 시험도 함께 지우고, 앱이 같은 실행기를 같은 인자·
// 토큰 환경 변수로 띄우는지는 tests/desktop_windows.test.mjs('지운 실행기 bat 이 하던 일을 …')가 본다.
test('안내 글은 지운 bat 대신 node 명령과 앱 메뉴를 알린다', () => {
  assert.equal(fs.existsSync(new URL('../start-codex-agent.bat', import.meta.url)), false);
  const source = fs.readFileSync(new URL('../scripts/codex-agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /\n {2}node scripts\/codex-agent\.mjs \[--check\]/);
  assert.match(source, /\[AI → 실행기 관리\]/);
});
