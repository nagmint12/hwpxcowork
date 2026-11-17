// 실행기 보고와 작업 대기의 구분, 실제 Vue 렌더링, 구버전 서버 호환을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSSRApp, compile } from 'vue';
import { renderToString } from '@vue/server-renderer';

const source = fs.readFileSync(new URL('../web/orchestration.js', import.meta.url), 'utf8');
const vueUrl = import.meta.resolve('vue');
const browserImport = "import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';";
const utilImport = "import { api, toast, fmt } from './util.js';";
const moduleSource = source.replace(browserImport, `import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from '${vueUrl}';`).replace(utilImport, "const api = async () => { throw new Error('예상하지 않은 요청'); }; const toast = () => {}; const fmt = value => value || ''; ");
const ui = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
const now = Date.parse('2026-10-30T10:00:00Z');
const iso = seconds => new Date(now + seconds * 1000).toISOString();
const status = ({ online = true, phase = 'idle', expires = 90, checked = 0, source = 'worker' } = {}) => ({
  enabled: true, conductor: 'codex', checked_at: iso(checked),
  agents: [{ id: 'codex', label: 'Codex 지휘자', kind: 'codex', online, phase, source: online ? source : null, last_seen: iso(-1) }],
  workers: source === 'worker' ? [{ agent_id: 'codex', online, phase, last_seen: iso(-1), expires_at: iso(expires) }] : [],
  queue: { active_runs: 1, pending_tasks: 1, running_tasks: 0 }, waiting: [],
});
const planTask = () => ({ id: 'r1-plan', kind: 'plan', agent_id: 'codex', title: '작업 계획', status: 'pending', depends_on: [], attempt: 0 });
const runOf = task => ({ id: 'run-1', doc_id: 'doc-1', goal: '보고서 개선', status: 'planning', round: 1, profile: { maxParallel: 3 }, tasks: [task] });

test('최근 실행기 보고의 TTL·종료·오류·채널을 구별하고 보고가 없으면 온라인으로 표시하지 않음', () => {
  assert.match(ui.orchestrationAgentState(status(), 'codex', now).label, /온라인.*작업 대기/);
  assert.match(ui.orchestrationAgentState(status({ phase: 'working' }), 'codex', now).label, /처리 중/);
  assert.equal(ui.orchestrationAgentState(status({ expires: -1 }), 'codex', now).online, false);
  assert.equal(ui.orchestrationAgentState(status({ phase: 'stopping' }), 'codex', now).online, false);
  assert.equal(ui.orchestrationAgentState(status({ phase: 'error' }), 'codex', now).label, '오류 보고');
  assert.equal(ui.orchestrationAgentState(status({ checked: -31 }), 'codex', now).known, false);
  assert.equal(ui.orchestrationAgentState(null, 'codex', now).known, false);
  assert.equal(ui.orchestrationAgentState(status({ online: false }), 'codex', now).online, false);
  const channel = ui.orchestrationAgentState(status({ source: 'channel', phase: 'idle' }), 'codex', now);
  assert.equal(channel.source, 'channel'); assert.equal(channel.online, true);
  const otherAgent = ui.orchestrationAgentState(status(), 'not-configured', now);
  assert.equal(otherAgent.known, false); assert.equal(otherAgent.online, false);
  const multiple = status({ phase: 'working' });
  multiple.workers.push({ ...multiple.workers[0], phase: 'idle', last_seen: iso(1) });
  assert.match(ui.orchestrationAgentState(multiple, 'codex', now).label, /처리 중/);
});

test('실행기 미연결·선행 작업·선점·동시 작업 한도 대기를 분리하고 불명 상태를 미연결로 단정하지 않음', () => {
  const task = planTask(); const run = runOf(task);
  assert.match(ui.orchestrationTaskWait(task, run, status({ online: false }), now), /미연결로 대기/);
  assert.match(ui.orchestrationTaskWait(task, run, status(), now), /작업 선점 대기/);
  const noWorker = status(); noWorker.waiting = [{ run_id: 'run-1', task_id: task.id, reason: 'worker_unavailable' }];
  assert.match(ui.orchestrationTaskWait(task, run, noWorker, now), /분담 작업자 연결 대기.*모델 호출 전/);
  assert.match(ui.orchestrationTaskWait(task, run, null, now), /상태 확인 필요/);
  assert.match(ui.orchestrationTaskWait(task, run, status({ checked: -31 }), now), /상태 확인 필요/);
  task.depends_on = ['draft'];
  run.tasks.push({ id: 'draft', status: 'running' });
  assert.equal(ui.orchestrationTaskWait(task, run, status({ online: false }), now), '선행 작업 완료 대기');
  run.tasks[1].status = 'completed';
  assert.match(ui.orchestrationTaskWait(task, run, status({ online: false }), now), /미연결/);
  task.depends_on = []; run.profile.maxParallel = 1; run.tasks.push({ id: 'other', status: 'running' });
  assert.equal(ui.orchestrationTaskWait(task, run, status(), now), '동시 작업 한도로 대기');
  assert.equal(ui.orchestrationTaskWait(task, { ...run, status: 'cancelled' }, status(), now), '');
});

test('처리 중 작업은 시작·경과·임대 시각을 표시하고 시각 경과를 실패로 단정하지 않음', () => {
  const task = { status: 'running', started_at: iso(-125), lease_expires_at: iso(50) };
  assert.match(ui.orchestrationTaskTiming(task, now), /시작.*경과 2분 5초.*최근 임대 만료 시각/);
  task.lease_expires_at = iso(-1);
  assert.match(ui.orchestrationTaskTiming(task, now), /시각 경과 · 서버 확인 대기/);
  assert.doesNotMatch(ui.orchestrationTaskTiming(task, now), /실패/);
  assert.equal(ui.orchestrationTaskTiming({ status: 'pending', started_at: iso(-10) }, now), '');
  assert.equal(ui.orchestrationTaskTiming({ status: 'running', started_at: 'invalid' }, now), '');
  assert.match(ui.orchestrationTaskTiming({ status: 'running', started_at: iso(5) }, now), /경과 0초/);
});

test('실행 도움말은 일반 AI 큐와 구별하고 프로필 문자열을 실행 명령에 무방비로 삽입하지 않음', () => {
  assert.match(ui.orchestrationAgentHelp({ id: 'codex', kind: 'codex', model: '' }).command, /npm run orchestrator -- --agent-id codex --provider codex$/);
  assert.match(ui.orchestrationAgentHelp({ id: 'codex', kind: 'codex', model: '' }).note, /HWPX_COWORK_ORCHESTRATION=1.*기본 꺼짐/, 'Codex 실행기의 협업 큐는 기본 끔(2026-11-17)');
  const api = ui.orchestrationAgentHelp({ id: 'api-worker', kind: 'api', model: 'allowed-model' });
  assert.match(api.command, /--gateway baze --model allowed-model/); assert.match(api.note, /BAZE_API_KEY/);
  const claude = ui.orchestrationAgentHelp({ id: 'claude-code', kind: 'claude-code' });
  assert.match(claude.command, /claim_orchestration_task/); assert.match(claude.note, /claim_next_request.*별도/);
  const malicious = ui.orchestrationAgentHelp({ id: '$(bad)', kind: 'codex', model: 'x; bad' });
  assert.doesNotMatch(malicious.command, /\$\(bad\)|x; bad/);
});

async function renderPanel({ runtime, task = planTask(), unsupported = false } = {}) {
  const component = {
    ...ui.OrchestrationPanel,
    setup(props) {
      const state = ui.OrchestrationPanel.setup(props);
      state.profile.enabled = true; state.runtime.value = runtime || null; state.clockNow.value = now;
      state.runtimeUnsupported.value = unsupported; state.detail.value = runOf(task);
      return state;
    },
  };
  return renderToString(createSSRApp(component, { docs: [{ id: 'doc-1', title: '보고서' }] }));
}

test('실제 Vue 화면은 지휘자 미연결과 작업 대기 원인을 표시하고 결과 HTML을 실행하지 않음', async () => {
  assert.doesNotThrow(() => compile(ui.OrchestrationPanel.template, { onError: error => { throw error; } }));
  const task = { ...planTask(), result: { text: '<script>alert(1)</script>' } };
  const html = await renderPanel({ runtime: status({ online: false }), task });
  assert.match(html, /data-testid="orchestration-conductor-offline"/);
  assert.match(html, /지휘자 Codex 지휘자의 협업 실행기가 연결되지 않아/);
  assert.match(html, /배정된 협업 실행기 미연결로 대기/);
  // 2026-11-17: start-codex-agent.bat 을 지웠고 일반 요청 실행기(앱 [AI → 실행기 관리…]·npm run worker)는 협업 큐를 처리하지 않는다(Codex 실행기도 HWPX_COWORK_ORCHESTRATION=1 일 때만)
  assert.match(html, /일반 요청 실행기\(Windows 앱 \[AI → 실행기 관리…\]·npm run worker\)는 협업 작업을 처리하지 않습니다/);
  assert.doesNotMatch(html, /start-codex-agent\.bat/, '지운 bat 을 안내하지 않는다');
  assert.match(html, /협업 실행 방법/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /aria-live="polite"/);
});

test('실제 Vue 화면은 진행 경과와 임대 시각을 요약 행에 표시하고 404 호환 안내를 제공', async () => {
  const html = await renderPanel({ runtime: status({ phase: 'working' }), task: { ...planTask(), status: 'running', started_at: iso(-65), lease_expires_at: iso(90) } });
  assert.match(html, /온라인 · 처리 중/); assert.match(html, /경과 1분 5초/); assert.match(html, /최근 임대 만료 시각/);
  assert.doesNotMatch(html, /data-testid="orchestration-conductor-offline"/);
  const older = await renderPanel({ unsupported: true });
  assert.match(older, /상태 조회를 지원하지 않습니다/); assert.match(older, /협업 작업은 계속 사용할 수 있습니다/);
});

test('상태 API 404는 초기 조회와 갱신의 작업 목록을 유지하며 종료 시 요청을 취소', async () => {
  const key = `__orchestration_status_ui_${Date.now()}`;
  const hooks = { mounted: [], unmounted: [], requests: [], api: async (path, options) => {
    hooks.requests.push({ path, signal: options?.signal });
    if (path === '/api/me/orchestration') return { enabled: true };
    if (path === '/api/orchestration/runs') return [{ id: 'existing', status: 'planning' }];
    if (path === '/api/orchestration/status') throw Object.assign(new Error('404'), { status: 404 });
    throw new Error(`예상하지 않은 요청 ${path}`);
  } };
  globalThis[key] = hooks;
  const mocked = source.replace(browserImport, `import { ref, reactive, computed, watch } from '${vueUrl}'; const onMounted = fn => globalThis['${key}'].mounted.push(fn); const onBeforeUnmount = fn => globalThis['${key}'].unmounted.push(fn); const setTimeout = () => 1; const clearTimeout = () => {};`).replace(utilImport, `const api = (...args) => globalThis['${key}'].api(...args); const toast = () => {}; const fmt = value => value || '';`);
  let state;
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(mocked).toString('base64')}`);
    state = module.OrchestrationPanel.setup({ docs: [] });
    await hooks.mounted[0]();
    assert.equal(state.runtimeUnsupported.value, true); assert.equal(state.error.value, '');
    assert.equal(state.runs.value[0].id, 'existing'); assert.equal(state.loading.value, false);
    await state.refresh();
    assert.equal(hooks.requests.filter(item => item.path === '/api/orchestration/status').length, 1);
    assert.equal(hooks.requests.filter(item => item.path === '/api/orchestration/runs').length, 2);
  } finally {
    hooks.unmounted.forEach(fn => fn());
    assert.ok(hooks.requests.every(item => item.signal.aborted));
    delete globalThis[key];
  }
});
