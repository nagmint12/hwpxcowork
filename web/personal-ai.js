// 내 AI 키(서버 보관, server/personal-ai.js) — 문서 목록에서 각자 API(gateway 'baze') 키와 모델을 한 번 등록한다.
// (제공업체 직접 키도 받지만 참여자 대부분은 API 만 쓰므로 맨 뒤 묶음에 둔다.)
// 등록하면 내 AI 작업을 서버가 내 키로 바로 처리한다 — 내 PC 에 실행기를 깔거나 켜 둘 필요가 없다.
// 2026-11-13 운영 결정: 기본은 내 PC 의 구독 AI(Codex·Claude Code — 추가 비용 없음, util.js 'AI 연결 차례'). 내 AI 키는 선택·사용료 별도로
// 맨 뒤에 두고, 처음부터 펼쳐 두지 않는다(예전에는 등록 전이면 펼쳤다).
// 키는 다시 보여 주지 않는다(끝 4자리만). '연결 확인'은 모델 정보 조회만 한다(생성 호출·과금 없음).
import { ref, reactive, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { state, api, toast, toastError, fmt } from './util.js';
import { AdminCreditsPanel } from './admin-credits.js';
import { PAGES_HOST } from './pages-host.js';

// 연결 고르기: 연결 방식·제공자와 처음 넣어 둘 모델(API는 API 모델 목록의 ID)·추론 강도. 첫 항목이 기본
export const PERSONAL_AI_CHOICES = [
  { id: 'baze-openai', label: 'API · GPT 모델', group: 'gateway', gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' },
  { id: 'baze-anthropic', label: 'API · Claude 모델', group: 'gateway', gateway: 'baze', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  { id: 'baze-gemini', label: 'API · Gemini 모델', group: 'gateway', gateway: 'baze', provider: 'gemini', model: 'gemini-3.8-flash', effort: '' },
  { id: 'direct-openai', label: 'OpenAI API 직접', group: 'direct', gateway: 'direct', provider: 'openai', model: '', effort: '' },
  { id: 'direct-anthropic', label: 'Claude API 직접', group: 'direct', gateway: 'direct', provider: 'anthropic', model: '', effort: 'medium' },
  { id: 'direct-gemini', label: 'Gemini API 직접', group: 'direct', gateway: 'direct', provider: 'gemini', model: '', effort: '' },
  { id: 'local-openai', label: '로컬 AI · OpenAI 호환 API', group: 'direct', gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', effort: '' },
];
const choiceOf = (s) => PERSONAL_AI_CHOICES.find((c) => c.gateway === s?.gateway && c.provider === s?.provider) || PERSONAL_AI_CHOICES[0];

export const PersonalAiPanel = {
  components: { AdminCreditsPanel },
  // 체험 계정(config.tutorial)이 관리자가 공유한 키를 쓰면(shared) 등록 칸 대신 한 줄만 — 남의 키를 지우거나 확인하는 단추를 보이지 않는다
  template: `<p v-if="st.shared" class="muted personal-ai-shared" data-testid="personal-ai-shared" title="체험 계정은 관리자가 공유한 API로만 요청을 처리합니다">AI: {{ st.active ? '관리자가 공유한 API · ' + sharedLabel : '체험용 관리자 API 연결 필요' }}</p>
  <details v-else class="personal-ai" data-testid="personal-ai">
    <summary>내 AI 키 <span class="muted" title="기본은 내 PC의 Codex·Claude Code(구독 — 추가 비용 없음)입니다. 내 AI 키는 사용료가 따로 듭니다">· 선택 · 사용료 별도 — {{ summary }}</span></summary>
    <p class="muted">기본은 <b>내 PC의 Codex·Claude Code</b>(구독 — 추가 비용 없음)입니다. 그 PC를 켜 두기 어려우면 <b>API·제공업체 API 키 또는 로컬 AI 주소</b>를 등록해 서버가 바로 처리하게 할 수 있습니다. API는 크레딧이 차감되고 제공업체 API는 해당 요금이 적용됩니다. 키는 서버에 암호로 잠가 보관하며 다시 보여 주지 않습니다.</p>
    <p v-if="pagesHost" class="muted" data-testid="personal-ai-pages">GitHub 페이지에서는 API 키를 저장하지 않습니다. <a :href="serverUrl" target="_blank" rel="noopener">서버 주소에서 열기</a></p>
    <div v-else class="pai-form">
      <label>연결<select v-model="f.choice" @change="pick" aria-label="AI 연결 방식"><optgroup label="API"><option v-for="c in gatewayChoices" :key="c.id" :value="c.id">{{ c.label }}</option></optgroup><optgroup label="제공업체·로컬 API 직접"><option v-for="c in directChoices" :key="c.id" :value="c.id">{{ c.label }}</option></optgroup></select></label>
      <label v-if="current.gateway === 'local'">로컬 API 주소<input v-model.trim="f.baseUrl" placeholder="http://localhost:1234/v1" spellcheck="false" autocomplete="off" aria-label="로컬 API 주소"/></label>
      <label>모델 ID<span class="pai-model"><input v-model.trim="f.model" list="pai-model-list" :placeholder="current.gateway === 'local' ? '예: qwen/qwen3.8-27b' : current.gateway === 'baze' ? '예: gpt-6.1-sol (API 모델 목록의 ID)' : '제공업체에서 확인한 모델 ID'" spellcheck="false" autocomplete="off" aria-label="모델 ID"/>
        <button v-if="st.configured" type="button" class="small" :disabled="busy" data-testid="personal-ai-models" title="저장한 키로 쓸 수 있는 모델 목록을 받아 옵니다(목록 조회만 — 사용료 없음)" @click="loadModels">목록</button></span>
        <datalist id="pai-model-list"><option v-for="m in models" :key="m.id" :value="m.id">{{ m.label || m.id }}</option></datalist></label>
      <label v-if="current.gateway === 'direct' && current.provider === 'anthropic'" title="sk-ant-usr-·sk-ant-svc 로 시작하는 키는 Console → Settings → Workspaces 의 ID가 필요합니다. 일반 키(sk-ant-api…)는 비워 두세요">워크스페이스 ID<input v-model.trim="f.workspaceId" placeholder="wrkspc_… (계정·서비스 계정 키만)" spellcheck="false" autocomplete="off" aria-label="워크스페이스 ID"/></label>
      <label>추론 강도<select v-model="f.effort" aria-label="추론 강도"><option value="">모델 기본값</option><option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option></select></label>
      <label>{{ current.gateway === 'local' ? 'API 키(선택)' : 'API 키' }}<input v-model="f.key" type="password" :placeholder="current.gateway === 'local' ? (st.gateway === 'local' && st.keyHint ? '바꿀 때만 입력 (지금 ' + st.keyHint + ')' : '키가 없는 로컬 서버는 비워 두세요') : st.configured && st.gateway === current.gateway && st.keyHint ? '바꿀 때만 입력 (지금 ' + st.keyHint + ')' : (current.gateway === 'baze' ? 'API 제공업체에서 발급한 키' : '제공업체 API 키')" autocomplete="new-password" spellcheck="false" aria-label="API 키"/></label>
    </div>
    <p v-if="current.gateway === 'local' && !pagesHost" class="muted">localhost는 이 웹 서비스의 서버가 실행되는 PC입니다. 같은 PC의 LM Studio 등에서 OpenAI 호환 API 서버를 켜 두세요. 별도 개인 실행기는 필요 없습니다. 모델 ID를 저장한 뒤 목록·연결 확인을 사용할 수 있습니다.</p>
    <div class="row pai-actions">
      <button v-if="!pagesHost" class="primary small" :disabled="busy" @click="save" data-testid="personal-ai-save">저장</button>
      <button class="small" v-if="st.configured" :disabled="busy" @click="check" data-testid="personal-ai-check">연결 확인</button>
      <button class="small" v-if="st.configured" :disabled="busy" @click="remove" data-testid="personal-ai-remove">키 삭제</button>
      <span class="muted" v-if="st.lastCheck" :class="st.lastCheck.ok ? 'ok' : 'err'">{{ st.lastCheck.ok ? '✓' : '✗' }} {{ st.lastCheck.message }}</span>
    </div>
    <p class="err" v-if="st.configured && !st.active">이 서버는 지금 개인 키로 AI 를 부르지 않습니다(시험·체험 설정). 등록한 키는 그대로 둡니다.</p>
    <p class="err" v-if="st.error">{{ st.error }}</p>
    <details v-if="st.configured && st.active && st.gateway === 'baze'" class="pai-credits" data-testid="personal-ai-credits"><summary title="API 잔액·이번 달 사용량(조회는 크레딧이 들지 않음)">AI 크레딧</summary>
      <AdminCreditsPanel mine :key="st.keyHint + st.updatedAt"/></details>
  </details>`,
  setup() {
    const st = computed(() => state.me?.personalAi || { configured: false });
    const first = choiceOf(st.value);
    const f = reactive({ choice: first.id, baseUrl: st.value.baseUrl || first.baseUrl || '', model: st.value.model || first.model, effort: st.value.configured ? (st.value.effort || '') : first.effort, key: '', workspaceId: st.value.anthropicWorkspaceId || '' });
    const current = computed(() => PERSONAL_AI_CHOICES.find((c) => c.id === f.choice) || PERSONAL_AI_CHOICES[0]);
    const busy = ref(false);
    const models = ref([]);
    async function loadModels() {
      busy.value = true;
      try { models.value = (await api('/api/me/ai/models')).models || []; toast(models.value.length ? `모델 ${models.value.length}개 — 모델 ID 칸에서 고르세요` : '받은 모델이 없습니다'); }
      catch (e) { toastError(e, '모델 목록을 받지 못했습니다: '); } finally { busy.value = false; }
    }
    const summary = computed(() => (st.value.configured ? `${choiceOf(st.value).label} · ${st.value.model}${st.value.keyHint ? ' · 키 ' + st.value.keyHint : ''}` : '등록 안 됨'));
    const sharedLabel = computed(() => `${choiceOf(st.value).label} · ${st.value.model || ''}`);
    function pick() { f.model = current.value.model; f.effort = current.value.effort; f.baseUrl = current.value.baseUrl || ''; f.key = ''; models.value = []; }
    function apply(view) { if (state.me && view) state.me.personalAi = view; }
    async function run(call, done) {
      busy.value = true;
      try { apply(await call()); if (done) toast(done); }
      catch (e) {
        // 확인 실패도 결과(lastCheck)를 남긴다 — 다시 읽어 보여 준다
        try { apply(await api('/api/me/ai')); } catch { /* 그대로 */ }
        toastError(e);
      } finally { busy.value = false; }
    }
    const save = () => run(async () => {
      const c = current.value;
      const view = await api('/api/me/ai', { method: 'PUT', body: { gateway: c.gateway, provider: c.provider, ...(c.gateway === 'local' ? { baseUrl: f.baseUrl } : {}), model: f.model, effort: f.effort || null, ...(c.gateway === 'direct' && c.provider === 'anthropic' ? { anthropicWorkspaceId: f.workspaceId || null } : {}), ...(f.key.trim() ? { key: f.key.trim() } : {}) } });
      f.key = '';
      return view;
    }, '저장했습니다. 연결 확인으로 키와 모델을 확인하세요.');
    const check = () => run(() => api('/api/me/ai/check', { method: 'POST' }), '키와 모델을 확인했습니다');
    const remove = () => { if (confirm('등록한 내 AI 키를 서버에서 지울까요?')) run(() => api('/api/me/ai', { method: 'DELETE' }), '내 AI 키를 지웠습니다'); };
    // GitHub 페이지에 끼워 연 화면(web/pages-host.js)에서는 키를 저장하지 않는다 — 서버 주소로 직접 열어 저장한다(2026-11-18)
    const serverUrl = location.origin + '/';
    return { pagesHost: PAGES_HOST, serverUrl, st, f, current, busy, summary, sharedLabel, models, loadModels, EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'], choices: PERSONAL_AI_CHOICES, gatewayChoices: PERSONAL_AI_CHOICES.filter((c) => c.group === 'gateway'), directChoices: PERSONAL_AI_CHOICES.filter((c) => c.group === 'direct'), pick, save, check, remove };
  },
};

// 연결별 모델·추론 강도(server/ai-run.js, 2026-10-31) — 내 PC 의 실행기·채널 에이전트가 쓸 모델과 추론 강도를 웹에서 정한다.
// 실행기(Codex·Claude Code·Gemini CLI·Antigravity·개인 API)는 요청마다 이 값을 읽고, 직접 띄운 Claude Code 채널은 다음에 띄울 때부터 쓴다.
// 모델 목록은 실행기가 켜질 때 알려 준 것(Codex 는 codex debug models), Claude Code 는 기본 목록. 목록에 없는 ID 는 직접 입력.
// ChatGPT·Claude 웹 대화처럼 앱이 모델을 고르는 연결은 서버가 바꿀 수 없다(마지막 줄 안내).
const CUSTOM = '__custom__';
export const AiRunPanel = {
  template: `<details class="personal-ai ai-run" data-testid="ai-run" @toggle="onToggle">
    <summary>AI 모델·추론 강도 <span class="muted">— {{ summary }}</span></summary>
    <table class="ai-run-table" v-if="view">
      <thead><tr><th>연결</th><th>모델</th><th>추론 강도</th><th></th></tr></thead>
      <tbody>
        <tr v-for="k in view.kinds" :key="k.id" :data-kind="k.id">
          <td :title="(k.applies === 'launch' ? '다음에 띄울 때부터 적용' : '요청마다 적용') + (k.start ? ' — 켜기: ' + k.start : '') + (k.launchNote ? ' · ' + k.launchNote : '')">{{ k.label }}
            <label v-if="k.canSelectModel" style="display:block"><input type="checkbox" style="min-width:0;width:auto" :checked="form[k.id].modelSelection === 'auto'" @change="form[k.id].modelSelection = $event.target.checked ? 'auto' : 'manual'; save(k)"/> Codex가 자동 선택</label>
          </td>
          <td>
            <select v-if="k.models.length && !custom[k.id]" :value="pickValue(k)" :aria-label="k.label + ' 모델'" @change="pickModel(k, $event.target.value)">
              <option value="">기본</option>
              <option v-for="m in k.models" :key="m.id" :value="m.id">{{ m.label || m.id }}</option>
              <option v-if="form[k.id].model && !k.models.some((m) => m.id === form[k.id].model)" :value="form[k.id].model">{{ form[k.id].model }}</option>
              <option :value="CUSTOM">직접 입력…</option>
            </select>
            <input v-else v-model.trim="form[k.id].model" placeholder="기본" spellcheck="false" autocomplete="off" :aria-label="k.label + ' 모델 ID'" title="모델 ID — 비우면 실행할 때 준 값(없으면 그 AI 의 기본)" @change="save(k)"/>
          </td>
          <td>
            <select v-if="effortsFor(k).length" v-model="form[k.id].effort" :aria-label="k.label + ' 추론 강도'" @change="save(k)">
              <option value="">기본{{ defaultEffort(k) ? ' (' + defaultEffort(k) + ')' : '' }}</option>
              <option v-for="e in effortsFor(k)" :key="e" :value="e">{{ e }}</option>
            </select>
            <span v-else class="muted" title="이 연결은 추론 강도를 정할 수 없습니다">—</span>
          </td>
          <td class="muted ai-run-src" :title="srcTip(k)">{{ srcLabel(k) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="muted" v-else-if="error">{{ error }}</p>
    <p class="muted ai-run-note" v-if="view && view.kinds.some(k => k.canSelectModel)">Codex 자동 선택은 요청마다 모델·추론 강도를 판단합니다. 위 설정은 판단용 모델과 판단 실패 시 사용할 값입니다. 판단 단계도 Codex 사용량에 포함됩니다.</p>
    <p class="muted ai-run-note" title="MCP 서버는 연결한 앱이 쓰는 모델을 바꿀 수 없습니다">ChatGPT·Claude 웹 대화와 직접 띄운 Claude Code·Codex 대화는 그 앱에서 모델을 고릅니다.</p>
  </details>`,
  setup() {
    const view = ref(null); const error = ref(''); const form = reactive({}); const custom = reactive({}); let loaded = false;
    function fill(v) {
      view.value = v;
      for (const k of v.kinds) form[k.id] = { model: v.settings[k.id]?.model || '', effort: v.settings[k.id]?.effort || '', modelSelection: v.settings[k.id]?.modelSelection || 'manual' };
    }
    async function load() {
      try { fill(await api('/api/me/ai-run')); error.value = ''; loaded = true; } catch (e) { error.value = `불러오지 못했습니다: ${e.message}`; }
    }
    onMounted(load);
    function onToggle(e) { if (e.target.open && loaded) load(); }   // 펼칠 때 다시 읽는다(실행기가 그새 목록을 알렸을 수 있다)
    const modelOf = (k) => k.models.find((m) => m.id === form[k.id]?.model) || null;
    // Codex 처럼 모델마다 받는 강도가 다르면 그 모델의 것만
    const effortsFor = (k) => { const m = modelOf(k); return m?.efforts?.length ? m.efforts : k.efforts; };
    const defaultEffort = (k) => modelOf(k)?.defaultEffort || '';
    const pickValue = (k) => form[k.id]?.model || '';
    function pickModel(k, value) {
      if (value === CUSTOM) { custom[k.id] = true; return; }
      form[k.id].model = value;
      if (form[k.id].effort && !effortsFor(k).includes(form[k.id].effort)) form[k.id].effort = '';
      save(k);
    }
    async function save(k) {
      try {
        fill(await api('/api/me/ai-run', { method: 'PUT', body: { kind: k.id, model: form[k.id].model || null, effort: form[k.id].effort || null,
          ...(k.canSelectModel ? { modelSelection: form[k.id].modelSelection } : {}) } }));
        custom[k.id] = false;
        toast(k.applies === 'launch' ? `${k.label}: 저장했습니다 — 다음에 띄울 때부터` : `${k.label}: 저장했습니다 — 다음 요청부터${k.launchNote ? ` · ${k.launchNote}` : ''}`);
      } catch (e) { toastError(e, '저장하지 못했습니다: '); await load(); }
    }
    const srcLabel = (k) => (k.modelsFrom === 'reported' ? `목록 ${fmt(k.modelsAt)}` : k.modelsFrom === 'builtin' ? '기본 목록' : '');
    const srcTip = (k) => (k.modelsFrom === 'reported' ? '실행기가 이 계정으로 쓸 수 있다고 알려 준 목록(켤 때와 30분마다 다시 읽음)' : k.modelsFrom === 'builtin' ? '알려진 모델 목록 — "최신 (자동)" 별칭은 그 PC 의 Claude Code 가 아는 가장 새 모델을 씁니다' : `실행기를 켜면 쓸 수 있는 모델 목록이 여기에 들어옵니다${k.start ? ` — 켜기: ${k.start}` : ''}`);
    const summary = computed(() => {
      if (!view.value) return '';
      const set = view.value.kinds.filter((k) => view.value.settings[k.id]).map((k) => `${k.label.split(' ')[0]} ${view.value.settings[k.id].modelSelection === 'auto' ? '자동 선택' : [view.value.settings[k.id].model, view.value.settings[k.id].effort].filter(Boolean).join('·')}`);
      return set.length ? set.join(', ') : '기본';
    });
    return { view, error, form, custom, CUSTOM, effortsFor, defaultEffort, pickValue, pickModel, save, srcLabel, srcTip, summary, onToggle };
  },
};
