// 관리자 설정의 '기능 설정' 탭(2026-11-18). 저장하면 서버에 바로 적용된다(재시작 없음).
// 개인 토큰 발급: 켜면 로그인 화면에 [개인 토큰 발급받기]가 생기고, 누구나 이름을 넣어 자기 접속 토큰을 받는다(POST /api/self-token).
import { ref, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, state } from './util.js';

const ROLE_LABELS = { editor: '편집자', viewer: '보기만' };
const changedMessage = '다른 곳에서 설정이 바뀌었습니다. 최신 상태를 다시 읽었습니다. 확인한 뒤 다시 저장하세요.';

export const AdminFeaturesPanel = {
  template: `<section class="admin-tabpanel" data-testid="admin-features" aria-labelledby="admin-features-title">
    <h2 id="admin-features-title" class="admin-subtitle">기능 설정</h2>
    <p v-if="loading" class="admin-message" role="status">설정을 읽는 중입니다…</p>
    <template v-else-if="data">
      <form class="admin-form" @submit.prevent="save" novalidate>
        <fieldset :disabled="busy"><legend class="admin-subtitle admin-feature-title">개인 토큰 발급</legend>
          <label class="admin-feature-switch"><input type="checkbox" v-model="enabled" data-testid="admin-self-issue"/>
            <span>로그인 화면에서 개인 토큰 발급받기</span></label>
          <p class="muted">켜면 접속 주소를 아는 사람은 누구나 이름을 넣고 자기 접속 토큰을 받습니다. 토큰은 서버가 무작위로 만듭니다.</p>
          <div class="admin-field"><label for="admin-self-issue-role">발급 계정 역할</label>
            <select id="admin-self-issue-role" v-model="role" data-testid="admin-self-issue-role"><option v-for="r in data.roles" :key="r" :value="r">{{ roleLabel(r) }}</option></select></div>
          <div class="admin-field"><label for="admin-self-issue-max">발급 한도</label>
            <input id="admin-self-issue-max" v-model="max" type="text" inputmode="numeric" autocomplete="off" data-testid="admin-self-issue-max"/>
            <p class="muted" data-testid="admin-self-issue-count">{{ data.range.max[0] }}–{{ data.range.max[1] }}개 · 지금까지 발급 {{ data.selfIssue.issued }}개</p></div>
        </fieldset>
        <p v-if="enabled && publicOpen" class="admin-message pending" data-testid="admin-self-issue-public">외부 주소로 열린 서버입니다. 발급받은 계정은 [사용자] 탭에서 확인하고 삭제할 수 있습니다.</p>
        <p v-if="error" class="admin-message err" role="alert">{{ error }}</p>
        <p v-if="notice" class="admin-message" role="status" data-testid="admin-features-notice">{{ notice }}</p>
        <div class="admin-actions"><button type="submit" class="primary" :disabled="busy || !dirty" data-testid="admin-features-save">저장</button></div>
      </form>
    </template>
    <div v-else class="admin-message" data-testid="admin-load-failed"><p class="err" role="alert">{{ error }}</p><button type="button" @click="load">다시 읽기</button></div>
  </section>`,
  setup() {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const error = ref(''); const notice = ref('');
    const enabled = ref(false); const role = ref('editor'); const max = ref('');
    const roleLabel = (r) => ROLE_LABELS[r] || r;
    const saved = computed(() => data.value?.selfIssue || {});
    const dirty = computed(() => !!data.value && (enabled.value !== saved.value.enabled || role.value !== saved.value.role || String(max.value).trim() !== String(saved.value.max)));
    // 공유 주소가 있거나 이 PC 밖 주소로 들어왔으면 외부에 열린 서버로 본다(안내 한 줄만)
    const publicOpen = computed(() => !!state.config?.publicUrl || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
    const fill = (d) => { data.value = d; enabled.value = d.selfIssue.enabled; role.value = d.selfIssue.role; max.value = String(d.selfIssue.max); };
    async function load() {
      loading.value = true; error.value = '';
      try { fill(await api('/api/admin/features')); } catch (e) { error.value = `설정을 읽지 못했습니다: ${e.message}`; } finally { loading.value = false; }
    }
    async function save() {
      error.value = ''; notice.value = '';
      const [lo, hi] = data.value.range.max; const n = Number(String(max.value).trim());
      if (!/^\d+$/.test(String(max.value).trim()) || n < lo || n > hi) { error.value = `발급 한도는 ${lo}–${hi} 사이의 정수로 입력하세요.`; return; }
      busy.value = true;
      try {
        fill(await api('/api/admin/features', { method: 'PATCH', body: { features: { selfIssue: { enabled: enabled.value, role: role.value, max: n } }, revision: data.value.revision } }));
        // 로그인 화면이 보는 값(/api/config selfIssue)도 이 화면에 맞춘다
        if (state.config) state.config = { ...state.config, selfIssue: data.value.selfIssue.enabled };
        notice.value = data.value.selfIssue.enabled ? '저장했습니다. 로그인 화면에 [개인 토큰 발급받기]가 보입니다.' : '저장했습니다. 개인 토큰 발급을 받지 않습니다.';
      } catch (e) { if (e.code === 'CONFIG_CHANGED') { await load(); error.value = changedMessage; } else error.value = `저장하지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    onMounted(load);
    return { data, loading, busy, error, notice, enabled, role, max, dirty, publicOpen, roleLabel, load, save };
  },
};
