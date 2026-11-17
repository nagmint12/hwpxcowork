// 관리자 접속 토큰 안내(2026-11-17 사용자 요청).
// 시작 파일·앱 아이콘은 이 PC 설정 파일(config.json)의 관리자 토큰을 주소(#/t/<토큰>)에 실어 브라우저를 연다 — 그래서 [나가기] 뒤에도
// 다시 시작하면 바로 들어온다. 그렇게 처음 들어온 관리자에게 그 토큰을 보여 주고(보기·복사), 원하면 직접 정한 토큰으로 바꾸게 한다.
// 이 브라우저에서 [확인]을 누르면 다시 띄우지 않는다(NOTICE_KEY). 서버는 모든 요청에서 토큰을 확인한다 — 이 안내는 보안 규칙을 바꾸지 않는다.
import { ref, computed } from '/vendor/vue.esm-browser.prod.js';
import { api, copyText, state } from './util.js';
import { FloatWin } from './ui.js';

export const NOTICE_KEY = 'hwpx.adminTokenNotice';
const TITLE = '4~200자: 영문·숫자와 . _ ~ ! @ $ * + = : , -';

/** 토큰 주소로 들어온 관리자이고, 이 브라우저에서 아직 확인하지 않았으면 true */
export function shouldShowTokenNotice({ me, viaLink, storage }) {
  if (me?.role !== 'admin' || !viaLink) return false;
  try { return !storage.getItem(NOTICE_KEY); } catch { return false; }
}

export const AdminTokenNotice = {
  components: { FloatWin },
  emits: ['close'],
  template: `<FloatWin :anchor="null" :width="440" title="관리자 접속 토큰" cls="libdlg tokendlg" @close="done">
    <div class="ld-body" data-testid="admin-token-notice">
      <p>이 PC에서 시작하면 이 토큰으로 자동 로그인합니다. [나가기] 뒤나 다른 브라우저·PC에서는 직접 넣어야 합니다.</p>
      <div class="row"><input class="tokendlg-value" :type="shown ? 'text' : 'password'" :value="state.token" readonly aria-label="관리자 접속 토큰" spellcheck="false" data-testid="admin-token-value"/>
        <button type="button" class="small" @click="shown = !shown">{{ shown ? '숨기기' : '보기' }}</button>
        <button type="button" class="small" data-testid="admin-token-copy" @click="copy">복사</button></div>
      <p class="muted">토큰을 아는 사람은 관리자로 들어올 수 있습니다. 다른 사람에게 알려 주지 마세요.</p>
      <details :open="editing" @toggle="editing = $event.target.open"><summary>직접 정하기</summary>
        <div class="row"><input v-model="custom" class="tokendlg-value" maxlength="200" placeholder="새 토큰" :title="TITLE" autocomplete="off" spellcheck="false" aria-label="새 관리자 토큰" data-testid="admin-token-custom" @keyup.enter="change"/>
          <button type="button" class="small" :disabled="busy || !custom.trim()" data-testid="admin-token-change" @click="change">바꾸기</button></div>
        <p class="muted" v-if="weak" data-testid="admin-token-weak">12자 이상을 권합니다. 짧은 토큰은 외부 접속을 열었을 때 추측당할 수 있습니다.</p></details>
      <p class="err" v-if="error">{{ error }}</p>
      <p class="muted" v-if="notice" role="status" data-testid="admin-token-status">{{ notice }}</p>
      <div class="row end"><span class="spacer"></span><button type="button" class="small primary" data-testid="admin-token-ok" @click="done">확인</button></div>
    </div></FloatWin>`,
  setup(_, { emit }) {
    const shown = ref(false); const editing = ref(false); const custom = ref('');
    const busy = ref(false); const error = ref(''); const notice = ref('');
    const weak = computed(() => custom.value.trim().length > 0 && custom.value.trim().length < 12);
    async function copy() { notice.value = await copyText(state.token) ? '토큰을 복사했습니다.' : '토큰을 선택해 복사해 주세요.'; }
    async function change() {
      const token = custom.value.trim();
      if (!token || busy.value || !state.me?.name) return;
      busy.value = true; error.value = ''; notice.value = '';
      try {
        const list = await api('/api/admin/users');
        const r = await api(`/api/admin/users/${encodeURIComponent(state.me.name)}/token`, { method: 'POST', body: { revision: list.revision, token } });
        // 지금 화면·이 브라우저도 새 토큰으로 이어 간다(시작 파일·앱은 설정 파일에서 새 토큰을 읽는다)
        state.token = r.issued.token; try { localStorage.setItem('hwpx.token', r.issued.token); } catch { /* 저장 불가 */ }
        custom.value = ''; editing.value = false;
        notice.value = '토큰을 바꿨습니다. 다음 시작부터 새 토큰으로 들어옵니다. AI가 연결되어 있으면 다시 연결해 주세요.';
      } catch (e) { error.value = e.message || String(e); }
      finally { busy.value = false; }
    }
    function done() {
      try { localStorage.setItem(NOTICE_KEY, new Date().toISOString()); } catch { /* 저장 불가 — 다음에 다시 보인다 */ }
      emit('close');
    }
    return { state, shown, editing, custom, busy, error, notice, weak, copy, change, done, TITLE };
  },
};
