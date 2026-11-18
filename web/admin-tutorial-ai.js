// 관리자 설정의 '튜토리얼 AI' 탭: 튜토리얼·체험 계정의 AI 요청을 처리할 연결을 고른다(서버 /api/admin/tutorial-ai — 바로 적용).
import { ref, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, josa } from './util.js';

export const AdminTutorialAiPanel = {
  template: `<section class="admin-tabpanel" data-testid="admin-tutorial-ai" aria-labelledby="admin-tutorial-ai-title">
    <h2 id="admin-tutorial-ai-title" class="admin-subtitle">튜토리얼 AI</h2>
    <p class="muted">튜토리얼 연습 문서의 AI 요청을 어떻게 처리할지 고릅니다. 저장하면 바로 적용됩니다.</p>
    <p v-if="loading" class="admin-message" role="status">설정을 읽는 중입니다…</p>
    <div v-else-if="!data" class="admin-message" data-testid="admin-load-failed"><p class="err" role="alert">{{ error }}</p><button type="button" :disabled="busy" @click="load()">다시 읽기</button></div>
    <form v-else class="tutorial-ai-form" @submit.prevent="save">
      <fieldset :disabled="busy || !data.examplesEditable" data-testid="tutorial-ai-mode"><legend class="admin-subtitle">연습 문서의 AI 요청</legend>
        <label class="tutorial-ai-option" :class="{ chosen: mode === 'examples' }" data-testid="tutorial-ai-mode-examples">
          <input type="radio" name="tutorial-ai-mode" value="examples" v-model="mode"/>
          <span class="tutorial-ai-label"><b>예시 답변</b><span class="muted">미리 준비한 답변으로 처리합니다. AI 호출·비용이 없습니다.</span></span>
        </label>
        <label class="tutorial-ai-option" :class="{ chosen: mode === 'shared' }" data-testid="tutorial-ai-mode-shared">
          <input type="radio" name="tutorial-ai-mode" value="shared" v-model="mode"/>
          <span class="tutorial-ai-label"><b>공유 AI(관리자)</b><span class="muted">아래에서 고른 연결이 실제로 처리합니다. 사용자 탭에서 관리자 AI를 허용한 계정만 쓰고, 허용하지 않은 계정은 본인 AI 연결로 갑니다.</span></span>
        </label>
        <p class="muted" v-if="data.examplesEditable">튜토리얼 6·AI로 보고서 만들기는 이 설정과 관계없이 늘 예시 답변입니다.</p>
        <p class="muted" v-else data-testid="tutorial-ai-mode-restart">서버를 다시 시작하면 고를 수 있습니다. 지금: {{ data.examples === false ? '공유 AI' : '예시 답변' }}</p>
      </fieldset>
      <fieldset :disabled="busy"><legend class="admin-subtitle">공유 AI 연결</legend>
        <p class="muted">{{ mode === 'examples' ? '연습 문서는 예시 답변으로 처리하므로, 이 연결은 체험 계정이 자기 문서에서 보낸 요청에만 씁니다.' : '연습 문서와 체험 계정의 AI 요청을 처리할 연결입니다.' }}</p>
        <label v-for="o in data.options" :key="o.id" class="tutorial-ai-option" :class="{ chosen: choice === o.id }" :data-testid="'tutorial-ai-' + o.id" :title="o.detail">
          <input type="radio" name="tutorial-ai" :value="o.id" v-model="choice"/>
          <span class="tutorial-ai-label"><b>{{ o.label }}</b><span class="muted">{{ o.note }}</span></span>
          <span class="admin-status" :class="o.ready ? 'ready' : 'pending'">{{ o.ready ? '사용 가능' : '연결 안 됨' }}</span>
        </label>
        <label class="tutorial-ai-option" :class="{ chosen: choice === '' }" data-testid="tutorial-ai-legacy" title="config.json 의 shareAgent·shareChatGPT 와 공유 키 순서를 그대로 씁니다">
          <input type="radio" name="tutorial-ai" value="" v-model="choice"/>
          <span class="tutorial-ai-label"><b>기존 설정</b><span class="muted">{{ legacyNote }}</span></span>
        </label>
      </fieldset>
      <p v-if="error" class="admin-message err" role="alert">{{ error }}</p>
      <p v-if="notice" class="admin-message" role="status" data-testid="tutorial-ai-notice">{{ notice }}</p>
      <div class="admin-actions"><button type="submit" class="primary" data-testid="tutorial-ai-save" :disabled="busy || !changed">저장</button>
        <button type="button" :disabled="busy" @click="load(true)">상태 새로고침</button>
        <span class="muted">현재: <b data-testid="tutorial-ai-current">{{ data.examples === false ? '공유 AI' : '예시 답변' }} · {{ currentLabel }}</b></span></div>
    </form>
  </section>`,
  setup() {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const error = ref(''); const notice = ref('');
    const choice = ref(''); const mode = ref('examples');   // mode: 'examples'(예시 답변) | 'shared'(공유 AI) — 서버 config.tutorial.examples
    const modeOf = (d) => (d?.examples === false ? 'shared' : 'examples');
    const modeChanged = computed(() => !!data.value?.examplesEditable && mode.value !== modeOf(data.value));
    const changed = computed(() => !!data.value && (choice.value !== (data.value.provider || '') || modeChanged.value));
    const labelOf = (id) => data.value?.options.find((o) => o.id === id)?.label || '기존 설정';
    const currentLabel = computed(() => labelOf(data.value?.provider || ''));
    const legacyNote = computed(() => {
      const l = data.value?.legacy; if (!l) return '';
      const parts = [];
      if (l.shareChatGPT?.length) parts.push('ChatGPT 구독');
      if (l.shareAgent) parts.push(`실행기 ${Array.isArray(l.shareAgent) ? l.shareAgent.join('·') : l.shareAgent === true ? '아무 채널' : l.shareAgent}`);
      parts.push('공유 키');
      return `${parts.join(' → ')} 순서`;
    });
    async function load(keepChoice = false) {
      busy.value = true; error.value = ''; if (!keepChoice) notice.value = '';
      try {
        const keep = keepChoice && changed.value ? { choice: choice.value, mode: mode.value } : null;
        data.value = await api('/api/admin/tutorial-ai');
        choice.value = keep ? keep.choice : (data.value.provider || '');
        mode.value = keep ? keep.mode : modeOf(data.value);
      } catch (e) { error.value = e.status === 404 ? '서버를 다시 시작하면 쓸 수 있습니다.' : `설정을 읽지 못했습니다: ${e.message}`; }
      finally { busy.value = false; loading.value = false; }
    }
    async function save() {
      if (!changed.value) return;
      busy.value = true; error.value = ''; notice.value = '';
      try {
        const providerChanged = choice.value !== (data.value.provider || '');
        const body = { provider: choice.value || null, revision: data.value.revision };
        if (data.value.examplesEditable) body.examples = mode.value === 'examples';
        data.value = await api('/api/admin/tutorial-ai', { method: 'PUT', body });
        choice.value = data.value.provider || ''; mode.value = modeOf(data.value);
        const o = data.value.options.find((x) => x.id === data.value.provider);
        const parts = [];
        if (body.examples !== undefined) parts.push(`연습 문서의 AI 요청을 ${data.value.examples === false ? '공유 AI(관리자)로' : '예시 답변으로'} 처리합니다.`);
        if (providerChanged) parts.push(`공유 AI 연결을 ${josa(currentLabel.value, '으로/로')} 바꿨습니다.`);
        if (data.value.examples === false && o && !o.ready) parts.push('공유 AI 연결이 아직 안 되어 요청은 연결될 때까지 기다립니다.');
        notice.value = parts.join(' ') || '저장했습니다.';
      } catch (e) { error.value = e.code === 'CONFIG_CHANGED' ? '다른 곳에서 설정이 바뀌었습니다. 상태 새로고침 뒤 다시 저장하세요.' : `저장하지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    onMounted(() => load());
    return { data, loading, busy, error, notice, choice, mode, changed, currentLabel, legacyNote, load, save };
  },
};
