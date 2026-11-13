// 개인별 멀티에이전트 설정과 실행 현황. 모델 호출은 사용자 측 실행기가 담당한다.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { api, toast, fmt } from './util.js';

const EFFORTS = ['medium', 'high', 'xhigh', 'max'];
const ROLES = [
  { id: 'conductor', label: '지휘·통합' },
  { id: 'worker', label: '분담 작업' },
  { id: 'reviewer', label: '독립 검토' },
];
const KINDS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'api', label: 'API·API' },
  { id: 'mcp', label: '기타 MCP 실행기' },
];
const STATUS = {
  planning: '지휘자 계획 대기', pending: '대기', queued: '대기', ready: '실행 가능',
  running: '진행 중', working: '처리 중', synthesizing: '지휘자 통합 중',
  reviewing: '검토 중', awaiting_review: '지휘자 최종 확인 중', completed: '완료', done: '완료',
  failed: '실패', cancelled: '취소됨', blocked: '선행 작업 대기', expired: '시간 만료',
};
const TERMINAL = new Set(['completed', 'done', 'failed', 'cancelled', 'expired']);
const defaults = () => ({
  enabled: false, conductor: 'codex',
  agents: [
    { id: 'codex', label: 'Codex 지휘자', kind: 'codex', effort: 'xhigh', model: '', roles: ['conductor'] },
    { id: 'claude-code', label: 'Claude Code', kind: 'claude-code', effort: 'high', model: '', roles: ['worker', 'reviewer'] },
    { id: 'api-worker', label: 'API', kind: 'api', effort: 'medium', model: '', roles: ['worker', 'reviewer'] },
  ],
  maxParallel: 3, maxRounds: 3, maxTasks: 40, maxAttempts: 3, leaseSeconds: 180, maxRunMinutes: 60,
});
const idOf = (run) => String(run?.id || run?.run_id || '');
const arrayOf = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
const statusLabel = (status) => STATUS[status] || status || '대기';
const resultText = (value) => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

// 온라인 표시는 최근 보고의 유효 기간 안에서만 사용한다. 모델 호출 성공을 뜻하지 않는다.
export function orchestrationAgentState(runtime, agentId, now = Date.now()) {
  const unknown = { known: false, online: false, phase: null, source: null, lastSeen: null, label: '상태 확인 필요' };
  if (!runtime) return unknown;
  const checkedAt = Date.parse(runtime.checked_at);
  if (Number.isFinite(checkedAt) && now - checkedAt > 30000) return { ...unknown, label: '상태 보고 갱신 필요' };
  const agent = runtime.agents?.find(item => item.id === agentId);
  const workers = (runtime.workers || []).filter(item => item.agent_id === agentId).sort((a, b) => (Date.parse(b.last_seen) || 0) - (Date.parse(a.last_seen) || 0));
  const alive = item => item.online && Date.parse(item.expires_at) > now && item.phase !== 'stopping';
  const worker = workers.find(item => alive(item) && item.phase === 'working') || workers.find(alive) || workers[0];
  if (!agent && !worker) return unknown;
  const source = agent?.source || (worker ? 'worker' : null);
  const expiresAt = Date.parse(worker?.expires_at);
  const phase = source === 'worker' ? worker?.phase || agent?.phase : agent?.phase;
  const reportedOnline = agent ? agent.online === true : worker?.online === true;
  const online = reportedOnline && phase !== 'stopping' && (source !== 'worker' || !Number.isFinite(expiresAt) || expiresAt > now);
  const label = phase === 'stopping' ? '종료 중' : !online ? '미연결 · 최근 보고 없음' : phase === 'error' ? '오류 보고' : phase === 'working' ? '온라인 · 처리 중' : source === 'channel' ? '온라인 · 채널 연결' : '온라인 · 작업 대기';
  return { known: true, online, phase, source, lastSeen: source === 'worker' ? worker?.last_seen || agent?.last_seen || null : agent?.last_seen || null, label };
}

export function orchestrationTaskWait(task, run, runtime, now = Date.now()) {
  if (task?.status !== 'pending' || TERMINAL.has(run?.status)) return '';
  const dependencies = task.depends_on || task.dependsOn || task.dependencies || [];
  if (dependencies.some(id => !run?.tasks?.some(item => item.id === id && item.status === 'completed'))) return '선행 작업 완료 대기';
  const waiting = runtime?.waiting?.find(item => item.run_id === idOf(run) && item.task_id === (task.id || task.task_id));
  if (waiting?.reason === 'worker_unavailable') return '분담 작업자 연결 대기 · 모델 호출 전 대기';
  const presence = orchestrationAgentState(runtime, task.agent_id || task.agentId || task.assignee, now);
  if (presence.known && (!presence.online || waiting?.reason === 'agent_offline')) return '배정된 협업 실행기 미연결로 대기';
  if (!presence.known) return '실행기 상태 확인 필요 · 작업 선점 대기';
  if (presence.phase === 'error') return '협업 실행기 오류 보고 · 작업 선점 대기';
  if ((run?.tasks || []).filter(item => item.status === 'running').length >= (run?.profile?.maxParallel || Infinity)) return '동시 작업 한도로 대기';
  return '협업 실행기의 작업 선점 대기';
}

export function orchestrationTaskTiming(task, now = Date.now()) {
  if (task?.status !== 'running') return '';
  const started = Date.parse(task.started_at);
  const expires = Date.parse(task.lease_expires_at);
  const parts = [];
  if (Number.isFinite(started)) {
    const seconds = Math.max(0, Math.floor((now - started) / 1000));
    const elapsed = seconds >= 3600 ? `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분` : seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
    parts.push(`시작 ${fmt(task.started_at)}`, `경과 ${elapsed}`);
  }
  if (Number.isFinite(expires)) parts.push(`최근 임대 만료 시각 ${fmt(task.lease_expires_at)}${expires <= now ? ' (시각 경과 · 서버 확인 대기)' : ''}`);
  return parts.join(' · ');
}

export function orchestrationAgentHelp(agent) {
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(agent?.id || '') ? agent.id : '<실행기 ID>';
  const model = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(agent?.model || '') ? agent.model : '<모델 ID>';
  const prefix = `npm run orchestrator -- --agent-id ${id}`;
  if (agent?.kind === 'codex') return { command: `${prefix} --provider codex${agent.model ? ` --model ${model}` : ''}`, note: '이 PC에서는 start-codex-agent.bat 하나로 일반 요청과 Codex 협업을 함께 처리합니다. 아래 명령은 개별 실행용입니다. 본인 HWPX_COWORK_TOKEN과 codex login이 필요합니다.' };
  if (agent?.kind === 'api') return { command: `${prefix} --provider openai --gateway baze --model ${model}`, note: 'API는 BAZE_API_KEY와 본인 HWPX_COWORK_TOKEN을 실행기 환경에 설정하세요. 다른 API는 제공자·게이트웨이 옵션을 맞추세요.' };
  return { command: `claim_orchestration_task({"agent_id":"${id}"})`, note: '연결한 에이전트가 이 협업 도구를 주기적으로 호출하고, heartbeat로 임대를 연장한 뒤 결과를 제출하도록 지시하세요. 일반 AI 요청의 claim_next_request와 별도 대기열입니다.' };
}

export const OrchestrationPanel = {
  props: { docs: { type: Array, default: null } },
  template: `<details class="personal-ai orchestration-panel" data-testid="orchestration-panel">
    <summary>멀티에이전트 협업 <span class="muted">· {{ summary }}</span></summary>
    <p>지휘자가 작업을 나누고, 연결한 AI가 초안 작성과 검토를 분담합니다. 결과를 통합한 뒤 기존 문서의 제안으로 남깁니다.</p>
    <p class="muted">사용자 PC의 실행기나 Claude Code 채널·MCP 실행기를 켜두어야 자동 진행됩니다. MCP 연결만으로 다른 AI가 실행되지는 않습니다.</p>
    <p class="muted">일반 AI 큐와 협업 큐는 다릅니다. start-codex-agent.bat 하나로 일반 요청과 Codex 협업을 함께 처리합니다. Claude Code 등 분담 작업자도 연결해 두세요.</p>
    <section aria-label="협업 실행기 연결 상태" aria-live="polite" data-testid="orchestration-runtime">
      <p class="muted" v-if="runtimeUnsupported">이 서버는 협업 실행기 상태 조회를 지원하지 않습니다. 서버를 업데이트하거나 각 실행기 터미널에서 작업 선점 여부를 확인하세요. 협업 작업은 계속 사용할 수 있습니다.</p>
      <p class="muted" v-else-if="runtimeError">{{ runtimeError }} 실행기 연결 상태를 확인할 수 없습니다.</p>
      <p class="muted" v-else-if="!runtime">협업 실행기의 최근 보고를 확인하는 중…</p>
      <template v-else>
        <p class="err" role="status" v-if="conductorMissing" data-testid="orchestration-conductor-offline">지휘자 {{ conductorLabel }}의 협업 실행기가 연결되지 않아 계획·통합 작업이 대기할 수 있습니다. 아래 실행 방법으로 지휘자를 켜두세요.</p>
        <p class="err" role="status" v-else-if="conductorFailed">지휘자 {{ conductorLabel }}의 협업 실행기가 오류를 보고했습니다. 실행기 터미널에서 모델·계정·연결을 확인하세요.</p>
        <p class="muted" v-if="runtime.queue">진행 중 실행 {{ runtime.queue.active_runs }}개 · 대기 작업 {{ runtime.queue.pending_tasks }}개 · 처리 중 {{ runtime.queue.running_tasks }}개</p>
        <p class="muted">연결 상태는 최근 실행기·채널 보고의 유효 기간을 기준으로 표시합니다. 모델 응답 성공을 보장하지 않습니다. 확인 {{ fmt(runtime.checked_at) }}</p>
      </template>
    </section>
    <p class="err" role="alert" v-if="error">{{ error }}</p>
    <p class="muted" v-if="loading">개인 설정을 읽는 중…</p>
    <fieldset :disabled="loading || saving" class="orchestration-profile">
      <legend>내 협업 설정</legend>
      <label class="orchestration-check"><input type="checkbox" v-model="profile.enabled"/> 멀티에이전트 협업 사용</label>
      <div class="pai-form">
        <label>대표 지휘자<select v-model="profile.conductor" aria-label="대표 지휘자"><option v-for="agent in profile.agents" :key="agent.id" :value="agent.id">{{ agent.label || agent.id }} ({{ agent.id }})</option></select></label>
        <label>동시 작업 수<input type="number" v-model.number="profile.maxParallel" min="1" max="8" aria-label="동시 작업 수"/></label>
        <label>최대 개선 회차<input type="number" v-model.number="profile.maxRounds" min="1" max="10" aria-label="최대 개선 회차"/></label>
        <label>총 작업 수 한도<input type="number" v-model.number="profile.maxTasks" min="3" max="200" aria-label="총 작업 수 한도"/></label>
        <label>작업당 최대 시도<input type="number" v-model.number="profile.maxAttempts" min="1" max="5" aria-label="작업당 최대 시도"/></label>
        <label>작업 임대 시간(초)<input type="number" v-model.number="profile.leaseSeconds" min="30" max="3600" step="1" aria-label="작업 임대 시간 초"/></label>
        <label>실행 시간 한도(분)<input type="number" v-model.number="profile.maxRunMinutes" min="1" max="1440" aria-label="실행 시간 한도 분"/></label>
      </div>
      <div class="orchestration-agents">
        <fieldset v-for="(agent, index) in profile.agents" :key="index" class="orchestration-agent">
          <legend>{{ agent.label || agent.id || '새 에이전트' }}<span v-if="profile.conductor === agent.id"> · 지휘자</span></legend>
          <p role="status" :class="agentState(agent.id).online && agentState(agent.id).phase !== 'error' ? 'ok' : 'muted'" :data-testid="'orchestration-agent-status-' + agent.id">{{ agentState(agent.id).label }}<span v-if="agentState(agent.id).source"> · {{ agentState(agent.id).source === 'channel' ? '협업 채널' : '협업 실행기' }}</span><span v-if="agentState(agent.id).lastSeen"> · 최근 보고 {{ fmt(agentState(agent.id).lastSeen) }}</span></p>
          <div class="pai-form">
            <label>실행기 ID<input v-model.trim="agent.id" maxlength="48" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" spellcheck="false" autocomplete="off" :aria-label="'에이전트 ' + (index + 1) + ' 실행기 ID'"/></label>
            <label>표시 이름<input v-model.trim="agent.label" maxlength="120" :aria-label="'에이전트 ' + (index + 1) + ' 이름'"/></label>
            <label>연결 방식<select v-model="agent.kind" :aria-label="'에이전트 ' + (index + 1) + ' 연결 방식'"><option v-for="kind in kinds" :key="kind.id" :value="kind.id">{{ kind.label }}</option></select></label>
            <label>권장 추론 수준<select v-model="agent.effort" :aria-label="'에이전트 ' + (index + 1) + ' 추론 수준'"><option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option></select></label>
            <label>모델 ID(선택)<input v-model.trim="agent.model" maxlength="200" placeholder="실행기 기본 모델" spellcheck="false" autocomplete="off" :aria-label="'에이전트 ' + (index + 1) + ' 모델 ID'"/></label>
          </div>
          <div class="row pai-actions"><label v-for="role in roles" :key="role.id" class="orchestration-check"><input type="checkbox" v-model="agent.roles" :value="role.id"/> {{ role.label }}</label><button class="small" type="button" :disabled="profile.agents.length < 2" @click="removeAgent(index)" :aria-label="(agent.label || agent.id) + ' 삭제'">에이전트 제거</button></div>
          <details><summary>{{ agent.label || agent.id }} 협업 실행 방법</summary><p class="muted">{{ agentHelp(agent).note }}</p><pre class="orchestration-result" style="white-space:pre-wrap;overflow-wrap:anywhere">{{ agentHelp(agent).command }}</pre></details>
        </fieldset>
      </div>
      <div class="row pai-actions"><button class="small" type="button" @click="addAgent" :disabled="profile.agents.length >= 16">에이전트 추가</button><button class="primary small" type="button" @click="save" data-testid="orchestration-save">{{ saving ? '저장 중…' : '설정 저장' }}</button><span class="muted" v-if="dirty">저장하지 않은 변경이 있습니다.</span></div>
      <p class="muted">실행기 ID는 실행할 때 지정하는 agent-id와 같아야 합니다. 추론 수준은 실행기와 모델이 지원하는 값으로 맞추세요. max와 xhigh는 제공자마다 다르게 처리될 수 있습니다.</p>
    </fieldset>
    <form class="orchestration-start" @submit.prevent="start">
      <h3>새 문서 개선 작업</h3>
      <div class="pai-form"><label>대상 문서<select v-model="docId" required aria-label="협업 대상 문서"><option value="" disabled>문서를 선택하세요</option><option v-for="doc in availableDocs" :key="doc.id" :value="doc.id">{{ doc.title || doc.id }}</option></select></label></div>
      <p class="muted" v-if="!availableDocs.length">먼저 문서함에 HWPX 문서를 올리세요. 새 강의계획서는 내용을 추가할 문서를 선택하세요.</p>
      <label class="orchestration-goal">작업 목표<textarea v-model.trim="goal" required maxlength="12000" rows="4" placeholder="이 보고서를 검토하고 논문 형식으로 수정하여 작성해주세요." aria-label="협업 작업 목표"></textarea></label>
      <div class="row pai-actions"><button class="small" type="button" @click="goal = examples[0]">보고서 → 논문</button><button class="small" type="button" @click="goal = examples[1]">교육사회학 강의계획서</button></div>
      <div class="row pai-actions"><button class="primary small" :disabled="loading || starting || saving || dirty || !profile.enabled || !docId || !goal" data-testid="orchestration-start">{{ starting ? '시작 중…' : '협업 시작' }}</button><span class="muted" v-if="!profile.enabled">협업 사용을 켜고 설정을 저장하세요.</span><span class="muted" v-else-if="dirty">변경한 설정을 먼저 저장하세요.</span></div>
    </form>
    <div class="row pai-actions"><h3>내 실행 기록</h3><button class="small" type="button" :disabled="refreshing" @click="refresh()">{{ refreshing ? '읽는 중…' : '새로고침' }}</button><span class="muted">8초마다 갱신</span></div>
    <p class="muted" v-if="!runs.length">아직 실행한 작업이 없습니다.</p>
    <ul class="orchestration-runs" v-else><li v-for="run in runs" :key="idOf(run)"><button type="button" class="small" :aria-pressed="selectedId === idOf(run)" @click="selectRun(run)">{{ statusLabel(run.status) }} · {{ run.goal || run.title || idOf(run) }}</button> <span class="muted">{{ fmt(run.createdAt || run.created_at) }}</span></li></ul>
    <section v-if="detail" class="orchestration-detail" aria-label="협업 실행 상세">
      <div class="row pai-actions"><h3>{{ statusLabel(detail.status) }} · {{ detail.goal || detail.title || idOf(detail) }}</h3><button class="small" type="button" v-if="!terminal(detail.status)" :disabled="cancelling" @click="cancel">{{ cancelling ? '취소 중…' : '실행 취소' }}</button></div>
      <p class="muted" v-if="detail.round || detail.currentRound">개선 회차 {{ detail.round || detail.currentRound }}</p>
      <p class="err" v-if="detail.error">{{ resultText(detail.error) }}</p>
      <p v-if="detail.summary">{{ detail.summary }}</p>
      <details v-if="detail.final_result != null"><summary>통합 결과</summary><pre class="orchestration-result" style="white-space:pre-wrap;overflow-wrap:anywhere">{{ resultText(detail.final_result) }}</pre></details>
      <a v-if="detail.doc_id || detail.docId" :href="'#/doc/' + encodeURIComponent(detail.doc_id || detail.docId)">문서에서 제안 확인</a>
      <p class="muted" v-if="!tasks.length">지휘자 실행기가 계획을 수립하면 세부 작업이 표시됩니다.</p>
      <details v-for="task in tasks" :key="task.id || task.task_id" class="orchestration-task">
        <summary>{{ statusLabel(task.status) }} · {{ task.title || task.goal || task.id || task.task_id }} <span class="muted">· {{ task.agentId || task.agent_id || task.assignee || task.role || '' }}</span><span class="muted" v-if="task.status === 'pending'"> · {{ taskWait(task) }}</span><span class="muted" v-if="task.status === 'running'"> · {{ taskTiming(task) }}</span></summary>
        <p v-if="task.instruction || task.prompt">{{ task.instruction || task.prompt }}</p>
        <p class="muted" v-if="task.depends_on?.length || task.dependsOn?.length || task.dependencies?.length">선행 작업: {{ (task.depends_on || task.dependsOn || task.dependencies).join(', ') }}</p>
        <p class="muted" v-if="task.attempt || task.attempts">시도 {{ task.attempt || task.attempts }}</p>
        <p class="err" v-if="task.error">{{ resultText(task.error) }}</p>
        <pre v-if="task.result != null || task.output != null" class="orchestration-result" style="white-space:pre-wrap;overflow-wrap:anywhere">{{ resultText(task.result ?? task.output) }}</pre>
        <p class="muted" v-else>아직 제출한 결과가 없습니다.</p>
      </details>
    </section>
  </details>`,
  setup(props) {
    const profile = reactive(defaults());
    const saved = ref(''); const loading = ref(true); const saving = ref(false);
    const starting = ref(false); const refreshing = ref(false); const cancelling = ref(false); const error = ref('');
    const fetchedDocs = ref([]); const runs = ref([]); const selectedId = ref(''); const detail = ref(null);
    const runtime = ref(null); const runtimeError = ref(''); const runtimeUnsupported = ref(false); const clockNow = ref(Date.now());
    const docId = ref(''); const goal = ref('');
    const availableDocs = computed(() => props.docs ?? fetchedDocs.value);
    const dirty = computed(() => saved.value !== JSON.stringify(profile));
    const tasks = computed(() => arrayOf(detail.value?.tasks, 'tasks'));
    const summary = computed(() => profile.enabled ? `${profile.agents.length}개 AI · 지휘자 ${profile.agents.find(a => a.id === profile.conductor)?.label || profile.conductor}` : '사용 안 함');
    const agentState = id => orchestrationAgentState(runtimeError.value || runtimeUnsupported.value ? null : runtime.value, id, clockNow.value);
    const conductorId = computed(() => runtime.value?.conductor || profile.conductor);
    const conductorLabel = computed(() => runtime.value?.agents?.find(agent => agent.id === conductorId.value)?.label || profile.agents.find(agent => agent.id === conductorId.value)?.label || conductorId.value);
    const conductorMissing = computed(() => runtime.value?.enabled && agentState(conductorId.value).known && !agentState(conductorId.value).online);
    const conductorFailed = computed(() => runtime.value?.enabled && agentState(conductorId.value).online && agentState(conductorId.value).phase === 'error');
    const taskWait = task => orchestrationTaskWait(task, detail.value, runtimeError.value || runtimeUnsupported.value ? null : runtime.value, clockNow.value);
    const taskTiming = task => orchestrationTaskTiming(task, clockNow.value);
    const examples = [
      '이 보고서를 검토하고 논문 형식으로 수정하여 작성해주세요. 연구 문제, 이론적 배경, 방법, 결과, 논의의 구조를 검토하고 근거가 부족한 부분과 확인이 필요한 참고문헌을 밝혀주세요.',
      '교육사회학 교과목의 전공 수준 15주 한 학기 강의계획서를 작성해주세요. 학습 목표, 주차별 주제·읽기 자료·토론 질문, 과제, 평가 기준을 구성하고 주차 수와 평가 비율을 별도로 검증해주세요.',
    ];
    let disposed = false; let poll = null; let selectionVersion = 0; let detailRequest = 0;
    const controller = new AbortController();
    const request = (path, options = {}) => api(path, { ...options, signal: controller.signal });
    const setError = e => { if (!disposed && e?.name !== 'AbortError') error.value = e?.message || String(e); };
    function applyProfile(value) {
      const source = value?.profile || value;
      const next = defaults();
      for (const key of Object.keys(next)) if (source && source[key] !== undefined) next[key] = source[key];
      next.agents = Array.isArray(next.agents) ? next.agents.map(a => ({ id: a.id || '', label: a.label || '', kind: a.kind || 'mcp', effort: a.effort || 'high', model: a.model || '', roles: Array.isArray(a.roles) ? [...a.roles] : [] })) : [];
      Object.assign(profile, next);
      saved.value = JSON.stringify(profile);
    }
    function validate() {
      const ids = profile.agents.map(a => a.id);
      if (!ids.length || ids.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('실행기 ID는 영문·숫자로 시작하는 48자 이내 영문·숫자·밑줄·하이픈으로 서로 다르게 지정하세요.');
      if (!ids.includes(profile.conductor)) throw new Error('대표 지휘자를 선택하세요.');
      if (!profile.agents.find(a => a.id === profile.conductor)?.roles.includes('conductor')) throw new Error('대표 지휘자의 지휘·통합 역할을 선택하세요.');
      if (profile.agents.some(a => !a.roles.length)) throw new Error('각 에이전트의 역할을 하나 이상 선택하세요.');
      const limits = { maxParallel: [1, 8], maxRounds: [1, 10], maxTasks: [3, 200], maxAttempts: [1, 5], leaseSeconds: [30, 3600], maxRunMinutes: [1, 1440] };
      for (const [key, [min, max]] of Object.entries(limits)) if (!Number.isInteger(profile[key]) || profile[key] < min || profile[key] > max) throw new Error('실행 한도를 입력 범위 안의 정수로 지정하세요.');
    }
    function addAgent() {
      let n = profile.agents.length + 1;
      while (profile.agents.some(a => a.id === `agent-${n}`)) n++;
      profile.agents.push({ id: `agent-${n}`, label: `에이전트 ${n}`, kind: 'mcp', effort: 'high', model: '', roles: ['worker'] });
    }
    function removeAgent(index) {
      if (profile.agents.length < 2) return;
      const [removed] = profile.agents.splice(index, 1);
      if (removed.id === profile.conductor) profile.conductor = profile.agents[0].id;
    }
    async function save() {
      if (saving.value) return;
      saving.value = true; error.value = '';
      try { validate(); const value = await request('/api/me/orchestration', { method: 'PUT', body: JSON.parse(JSON.stringify(profile)) }); if (!disposed) { applyProfile(value); await loadRuntime(); toast('협업 설정을 저장했습니다'); } }
      catch (e) { setError(e); }
      finally { if (!disposed) saving.value = false; }
    }
    async function loadDetail(id, version) {
      const myRequest = ++detailRequest;
      const value = await request(`/api/orchestration/runs/${encodeURIComponent(id)}`);
      if (!disposed && selectedId.value === id && version === selectionVersion && myRequest === detailRequest) detail.value = value?.run || value;
    }
    async function loadRuntime() {
      if (disposed || runtimeUnsupported.value) return;
      try {
        const value = await request('/api/orchestration/status');
        if (!disposed) { runtime.value = value; runtimeError.value = ''; clockNow.value = Date.now(); }
      } catch (e) {
        if (!disposed && e?.name !== 'AbortError') {
          if (e?.status === 404) { runtimeUnsupported.value = true; runtime.value = null; runtimeError.value = ''; }
          else runtimeError.value = '협업 실행기 상태를 갱신하지 못했습니다.';
        }
      }
    }
    async function refresh({ quiet = false } = {}) {
      if (refreshing.value || disposed) return;
      refreshing.value = true;
      if (!quiet) error.value = '';
      try {
        clockNow.value = Date.now();
        const [runsResult] = await Promise.allSettled([request('/api/orchestration/runs'), loadRuntime()]);
        if (runsResult.status === 'rejected') throw runsResult.reason;
        const value = runsResult.value;
        if (disposed) return;
        runs.value = arrayOf(value, 'runs');
        if (selectedId.value) await loadDetail(selectedId.value, selectionVersion);
      } catch (e) { setError(e); }
      finally { if (!disposed) refreshing.value = false; }
    }
    async function selectRun(run) {
      const id = idOf(run); if (!id) return;
      selectedId.value = id; detail.value = run; const version = ++selectionVersion;
      try { await loadDetail(id, version); } catch (e) { setError(e); }
    }
    async function start() {
      if (starting.value || dirty.value || !profile.enabled || !docId.value || !goal.value) return;
      starting.value = true; error.value = '';
      try {
        const value = await request('/api/orchestration/runs', { method: 'POST', body: { doc_id: docId.value, goal: goal.value } });
        if (disposed) return;
        const run = value?.run || value;
        await selectRun(run); await refresh({ quiet: true });
        if (!disposed) toast('협업을 시작했습니다. 지휘자 실행기가 작업을 가져갑니다.');
      } catch (e) { setError(e); }
      finally { if (!disposed) starting.value = false; }
    }
    async function cancel() {
      if (cancelling.value || !selectedId.value) return;
      cancelling.value = true; error.value = ''; const id = selectedId.value;
      try {
        const value = await request(`/api/orchestration/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
        if (!disposed && selectedId.value === id) { detailRequest++; detail.value = value?.run || value; }
        await refresh({ quiet: true }); if (!disposed) toast('협업 실행을 취소했습니다');
      }
      catch (e) { setError(e); }
      finally { if (!disposed) cancelling.value = false; }
    }
    async function pollAgain() {
      if (disposed) return;
      clockNow.value = Date.now();
      if (document.visibilityState !== 'hidden') await refresh({ quiet: true });
      if (!disposed) poll = setTimeout(pollAgain, 8000);
    }
    watch(availableDocs, value => { if (!value.some(d => d.id === docId.value)) docId.value = value[0]?.id || ''; }, { immediate: true });
    onMounted(async () => {
      const jobs = [
        request('/api/me/orchestration').then(value => { if (!disposed) applyProfile(value); }),
        refresh({ quiet: true }),
      ];
      if (props.docs == null) jobs.push(request('/api/docs').then(value => { if (!disposed) fetchedDocs.value = arrayOf(value, 'docs'); }));
      const results = await Promise.allSettled(jobs);
      for (const result of results) if (result.status === 'rejected') setError(result.reason);
      if (!disposed) { loading.value = false; poll = setTimeout(pollAgain, 8000); }
    });
    onBeforeUnmount(() => { disposed = true; selectionVersion++; clearTimeout(poll); controller.abort(); });
    return { profile, loading, saving, starting, refreshing, cancelling, error, dirty, summary, availableDocs, docId, goal, examples, runs, selectedId, detail, tasks, runtime, runtimeError, runtimeUnsupported, clockNow, conductorLabel, conductorMissing, conductorFailed, agentState, taskWait, taskTiming, agentHelp: orchestrationAgentHelp, efforts: EFFORTS, roles: ROLES, kinds: KINDS, idOf, statusLabel, resultText, fmt, terminal: status => TERMINAL.has(status), addAgent, removeAgent, save, start, cancel, refresh, selectRun };
  },
};
