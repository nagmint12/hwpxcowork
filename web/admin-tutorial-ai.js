// 관리자 설정의 '튜토리얼 AI' 탭: 튜토리얼·체험 계정의 AI 요청을 처리할 연결을 고른다(서버 /api/admin/tutorial-ai — 바로 적용).
import { ref, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, josa } from './util.js';

export const AdminTutorialAiPanel = {
  template: `<section class="admin-tabpanel" data-testid="admin-tutorial-ai" aria-labelledby="admin-tutorial-ai-title">
    <h2 id="admin-tutorial-ai-title" class="admin-subtitle">튜토리얼 AI</h2>
    <p class="muted">{{ data && data.examples === true ? '튜토리얼 연습 문서의 AI 요청은 늘 미리 준비한 예시 답변으로 처리합니다(AI 호출 없음). 여기서 고른 연결은 체험 계정이 자기 문서에서 보낸 요청에만 씁니다.' : '튜토리얼과 체험 계정의 AI 요청을 처리할 연결입니다.' }} 저장하면 바로 적용됩니다.</p>
    <p v-if="loading" class="admin-message" role="status">설정을 읽는 중입니다…</p>
    <div v-else-if="!data" class="admin-message" data-testid="admin-load-failed"><p class="err" role="alert">{{ error }}</p><button type="button" :disabled="busy" @click="load()">다시 읽기</button></div>
    <form v-else class="tutorial-ai-form" @submit.prevent="save">
      <fieldset :disabled="busy"><legend class="sr-only">튜토리얼 AI 연결</legend>
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
        <span class="muted">현재: <b data-testid="tutorial-ai-current">{{ currentLabel }}</b></span></div>
    </form>
  </section>`,
  setup() {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const error = ref(''); const notice = ref('');
    const choice = ref('');
    const changed = computed(() => !!data.value && choice.value !== (data.value.provider || ''));
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
        const keep = keepChoice && changed.value ? choice.value : null;
        data.value = await api('/api/admin/tutorial-ai');
        choice.value = keep ?? (data.value.provider || '');
      } catch (e) { error.value = e.status === 404 ? '서버를 다시 시작하면 쓸 수 있습니다.' : `설정을 읽지 못했습니다: ${e.message}`; }
      finally { busy.value = false; loading.value = false; }
    }
    async function save() {
      if (!changed.value) return;
      busy.value = true; error.value = ''; notice.value = '';
      try {
        data.value = await api('/api/admin/tutorial-ai', { method: 'PUT', body: { provider: choice.value || null, revision: data.value.revision } });
        choice.value = data.value.provider || '';
        const o = data.value.options.find((x) => x.id === data.value.provider);
        notice.value = `튜토리얼 AI를 ${josa(currentLabel.value, '으로/로')} 바꿨습니다.${o && !o.ready ? ' 아직 연결되지 않아 요청은 연결될 때까지 기다립니다.' : ''}`;
      } catch (e) { error.value = e.code === 'CONFIG_CHANGED' ? '다른 곳에서 설정이 바뀌었습니다. 상태 새로고침 뒤 다시 저장하세요.' : `저장하지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    onMounted(() => load());
    return { data, loading, busy, error, notice, choice, changed, currentLabel, legacyNote, load, save };
  },
};
