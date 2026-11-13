// 관리자 설정의 'AI 응답 크기'·'사용자' 탭. 둘 다 저장하면 서버에 바로 적용된다(재시작 없음).
import { ref, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, copyText, state } from './util.js';

const changedMessage = '다른 곳에서 설정이 바뀌었습니다. 최신 상태를 다시 읽었습니다. 확인한 뒤 다시 시도하세요.';

export const AdminLimitsPanel = {
  template: `<section class="admin-tabpanel" data-testid="admin-limits" aria-labelledby="admin-limits-title">
    <h2 id="admin-limits-title" class="admin-subtitle">AI 응답 크기</h2>
    <p class="muted">AI 도구(MCP) 한 번의 응답에 싣는 최대 글자 수입니다. 넘치면 서버가 먼 문맥부터 줄이고, AI 는 나머지를 나눠 읽습니다. 저장하면 바로 적용됩니다.</p>
    <p v-if="loading" class="admin-message" role="status">설정을 읽는 중입니다…</p>
    <template v-else-if="data">
      <form class="admin-form" @submit.prevent="save" novalidate>
        <div class="admin-field"><label for="admin-limit-chars">응답 최대 글자 수</label>
          <input id="admin-limit-chars" v-model="chars" type="text" inputmode="numeric" autocomplete="off" data-testid="admin-limit-chars"/>
          <p class="muted">{{ data.range.mcpResponseChars[0].toLocaleString() }}–{{ data.range.mcpResponseChars[1].toLocaleString() }}자 · 기본 {{ data.defaults.mcpResponseChars.toLocaleString() }}자 · 지금 적용 {{ data.limits.mcpResponseChars.toLocaleString() }}자<template v-if="tokens"> · 입력값은 약 {{ tokens.toLocaleString() }} 토큰</template></p></div>
        <ul class="admin-guide"><li v-for="(text, key) in data.guide" :key="key">{{ text }}</li></ul>
        <p v-if="error" class="admin-message err" role="alert">{{ error }}</p>
        <p v-if="notice" class="admin-message" role="status">{{ notice }}</p>
        <div class="admin-actions"><button type="submit" class="primary" :disabled="busy || !dirty" data-testid="admin-limit-save">저장</button>
          <button type="button" :disabled="busy || Number(chars) === data.defaults.mcpResponseChars" @click="chars = String(data.defaults.mcpResponseChars)">기본값으로</button></div>
      </form>
    </template>
    <p v-else class="admin-message err" role="alert">{{ error }}</p>
  </section>`,
  setup() {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const chars = ref(''); const error = ref(''); const notice = ref('');
    const dirty = computed(() => !!data.value && Number(chars.value) !== data.value.limits.mcpResponseChars);
    const tokens = computed(() => (/^\d+$/.test(String(chars.value).trim()) ? Math.round(Number(chars.value) / 2) : 0));
    const fill = (d) => { data.value = d; chars.value = String(d.limits.mcpResponseChars); };
    async function load() {
      loading.value = true; error.value = '';
      try { fill(await api('/api/admin/limits')); } catch (e) { error.value = `설정을 읽지 못했습니다: ${e.message}`; } finally { loading.value = false; }
    }
    async function save() {
      error.value = ''; notice.value = '';
      const [min, max] = data.value.range.mcpResponseChars; const v = Number(String(chars.value).trim());
      if (!/^\d+$/.test(String(chars.value).trim()) || v < min || v > max) { error.value = `${min.toLocaleString()}–${max.toLocaleString()} 사이의 정수로 입력하세요.`; return; }
      busy.value = true;
      try { fill(await api('/api/admin/limits', { method: 'PATCH', body: { limits: { mcpResponseChars: v }, revision: data.value.revision } })); notice.value = '저장했습니다. 다음 AI 도구 호출부터 적용됩니다.'; }
      catch (e) { if (e.code === 'CONFIG_CHANGED') { await load(); error.value = changedMessage; } else error.value = `저장하지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    onMounted(load);
    return { data, loading, busy, chars, error, notice, dirty, tokens, save };
  },
};

const ROLE_LABELS = { admin: '관리자', editor: '편집자', viewer: '보기만' };
// 접속 토큰은 직접 정한다(서버 TOKEN_RE 와 같은 규칙). 비우면 서버가 무작위로 만든다
const TOKEN_TITLE = '4~200자: 영문·숫자와 . _ ~ ! @ $ * + = : , -  · 비워 두면 자동으로 만듭니다 · 짧은 토큰은 시험용으로만';
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const AdminUsersPanel = {
  template: `<section class="admin-tabpanel" data-testid="admin-users" aria-labelledby="admin-users-title">
    <h2 id="admin-users-title" class="admin-subtitle">사용자</h2>
    <p class="muted">접속 토큰으로 로그인하는 사용자입니다. 추가·삭제·역할·토큰 변경은 바로 적용되고, 지운 사용자나 바꾼 토큰은 다음 요청부터 접속할 수 없습니다. 문서에 남은 그 사람의 기록은 지우지 않습니다.</p>
    <p v-if="loading" class="admin-message" role="status">사용자 목록을 읽는 중입니다…</p>
    <template v-else-if="data">
      <div v-if="data.serverAi" class="admin-field" data-testid="admin-server-ai">
        <label for="admin-server-ai-key">서버 AI 키</label>
        <select id="admin-server-ai-key" :value="data.serverAi.useKeyOf || ''" :disabled="busy" data-testid="admin-server-ai-key" @change="setKeyOwner($event.target.value)">
          <option value="">서버 설정(config.ai)의 키</option>
          <option v-for="n in data.serverAi.candidates" :key="n" :value="n">{{ n }} 의 '내 AI 키'</option></select>
        <p class="muted" data-testid="admin-server-ai-state">{{ serverAiState }} · 허용 {{ allowedCount }}명 — 아래 '관리자 AI' 칸을 체크한 계정만 씁니다</p></div>
      <div v-if="secret" class="admin-review admin-secret" role="alert" data-testid="admin-user-token"><b>{{ secret.name }} 의 접속 토큰</b>
        <p><code>{{ secret.token }}</code></p><p class="muted">이 토큰은 지금 한 번만 보입니다. 복사해 본인에게만 전달하세요.</p>
        <div class="row"><button type="button" class="small" @click="copy(secret.token)">복사</button><button type="button" class="small" @click="secret = null">확인했습니다</button></div></div>
      <table class="admin-users" data-testid="admin-user-list"><thead><tr><th>이름</th><th>역할</th><th title="체크한 계정만 관리자 AI(서버의 API 키, 튜토리얼에서 나눠 쓰는 관리자 API 키·실행기·ChatGPT)를 씁니다. 체크하지 않은 계정은 본인 AI 키·내 에이전트만 씁니다.">관리자 AI</th><th>토큰</th><th></th></tr></thead>
        <tbody><tr v-for="u in data.users" :key="u.name" :data-user="u.name">
          <td>{{ u.name }}<span v-if="u.me" class="muted"> (나)</span></td>
          <td><select :value="u.role" :disabled="busy" :aria-label="u.name + ' 역할'" @change="setRole(u, $event.target.value)"><option v-for="r in data.roles" :key="r" :value="r">{{ roleLabel(r) }}</option></select></td>
          <td><input type="checkbox" :checked="u.serverAi" :disabled="busy" :aria-label="u.name + ' 관리자 AI 허용'" data-testid="admin-user-server-ai" @change="setServerAi(u, $event.target.checked)"/></td>
          <td><code>{{ u.tokenHint }}</code></td>
          <td class="admin-user-actions">
            <template v-if="editing === u.name"><input v-model="editToken" class="admin-token-input" maxlength="200" :placeholder="'새 토큰'" :title="TOKEN_TITLE" :aria-label="u.name + ' 새 토큰'" autocomplete="off" spellcheck="false" data-testid="admin-user-token-edit"/>
              <button type="button" class="small" :disabled="busy" title="무작위 토큰을 채웁니다" @click="editToken = randomToken()">자동</button><button type="button" class="small primary" :disabled="busy" data-testid="admin-user-token-save" @click="reissue(u)">저장</button><button type="button" class="small" @click="editing = ''">취소</button></template>
            <button v-else type="button" class="small" :disabled="busy" @click="editing = u.name; editToken = ''">토큰 바꾸기</button>
            <template v-if="confirming === u.name"><button type="button" class="small danger" :disabled="busy" data-testid="admin-user-delete-confirm" @click="remove(u)">삭제 확인</button><button type="button" class="small" @click="confirming = ''">취소</button></template>
            <button v-else type="button" class="small" :disabled="busy || u.me" :title="u.me ? '자기 계정은 지울 수 없습니다' : ''" @click="confirming = u.name">삭제</button></td></tr></tbody></table>
      <form class="admin-user-add" @submit.prevent="add" novalidate><b>사용자 추가</b>
        <input v-model="name" maxlength="40" placeholder="이름(문서에 작성자로 보입니다)" aria-label="새 사용자 이름" autocomplete="off" data-testid="admin-user-name"/>
        <input v-model="token" class="admin-token-input" maxlength="200" placeholder="토큰(비우면 자동)" :title="TOKEN_TITLE" aria-label="새 사용자 토큰" autocomplete="off" spellcheck="false" data-testid="admin-user-token-input"/>
        <button type="button" class="small" :disabled="busy" title="무작위 토큰을 채웁니다" @click="token = randomToken()">자동</button>
        <select v-model="role" aria-label="새 사용자 역할"><option v-for="r in data.roles" :key="r" :value="r">{{ roleLabel(r) }}</option></select>
        <button type="submit" class="primary" :disabled="busy || !name.trim()" data-testid="admin-user-add">추가</button></form>
      <p v-if="error" class="admin-message err" role="alert">{{ error }}</p>
      <p v-if="notice" class="admin-message" role="status">{{ notice }}</p>
    </template>
    <p v-else class="admin-message err" role="alert">{{ error }}</p>
  </section>`,
  setup() {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const error = ref(''); const notice = ref('');
    const name = ref(''); const role = ref('editor'); const secret = ref(null); const confirming = ref('');
    const token = ref(''); const editing = ref(''); const editToken = ref('');
    const roleLabel = (r) => ROLE_LABELS[r] || r;
    const allowedCount = computed(() => (data.value?.users || []).filter((u) => u.serverAi).length);
    const serverAiState = computed(() => {
      const st = data.value?.serverAi;
      if (!st) return '';
      const on = !st.enabled ? '꺼짐' : st.mock ? '모의 실행(시험용)' : '켜짐';
      return `${on} · ${st.restricted ? '체크한 계정만 사용' : '제한 없음(모든 계정)'}`;
    });
    async function load() {
      loading.value = true; error.value = '';
      try { data.value = await api('/api/admin/users'); } catch (e) { error.value = `사용자 목록을 읽지 못했습니다: ${e.message}`; } finally { loading.value = false; }
    }
    async function run(fn, done) {
      busy.value = true; error.value = ''; notice.value = '';
      try { const r = await fn(); data.value = r; done?.(r); }
      catch (e) {
        if (e.code === 'CONFIG_CHANGED') { await load(); error.value = changedMessage; }
        else error.value = e.message;
      } finally { busy.value = false; confirming.value = ''; }
    }
    const path = (u) => `/api/admin/users/${encodeURIComponent(u.name)}`;
    const add = () => run(() => api('/api/admin/users', { method: 'POST', body: { user: { name: name.value.trim(), role: role.value, ...(token.value ? { token: token.value } : {}) }, revision: data.value.revision } }),
      (r) => { secret.value = { name: r.created.name, token: r.created.token }; notice.value = `${r.created.name} 을(를) 추가했습니다.`; name.value = ''; token.value = ''; });
    const setRole = (u, r) => run(() => api(path(u), { method: 'PATCH', body: { user: { role: r }, revision: data.value.revision } }), () => { notice.value = `${u.name} 의 역할을 ${roleLabel(r)}(으)로 바꿨습니다.`; });
    const setKeyOwner = (owner) => run(() => api('/api/admin/server-ai-key', { method: 'PUT', body: { useKeyOf: owner || null, revision: data.value.revision } }),
      () => { notice.value = owner ? `서버 AI 가 ${owner} 의 '내 AI 키'를 씁니다.` : '서버 AI 가 서버 설정의 키를 씁니다.'; });
    const setServerAi = (u, on) => run(() => api(path(u), { method: 'PATCH', body: { user: { serverAi: on }, revision: data.value.revision } }),
      () => { notice.value = `${u.name} 의 관리자 AI 사용을 ${on ? '허용했습니다' : '막았습니다'}.`; });
    const reissue = (u) => run(() => api(`${path(u)}/token`, { method: 'POST', body: { revision: data.value.revision, ...(editToken.value ? { token: editToken.value } : {}) } }),
      (r) => {
        secret.value = { name: u.name, token: r.issued.token }; editing.value = ''; editToken.value = '';
        notice.value = u.me ? '내 토큰을 바꿨습니다. 이 브라우저는 새 토큰으로 계속 로그인됩니다.' : `${u.name} 의 토큰을 바꿨습니다. 이전 토큰은 더 쓸 수 없습니다.`;
        // 지금 로그인한 내 토큰을 바꿨으면 이 화면·브라우저에 저장한 토큰도 바꿔 로그아웃되지 않게 한다
        if (u.me) { state.token = r.issued.token; try { localStorage.setItem('hwpx.token', r.issued.token); } catch { /* 저장 불가 */ } }
      });
    const remove = (u) => run(() => api(path(u), { method: 'DELETE', body: { revision: data.value.revision } }), () => {
      if (secret.value?.name === u.name) secret.value = null;   // 지운 사람의 토큰은 더 쓸 수 없다
      notice.value = `${u.name} 을(를) 지웠습니다.`;
    });
    async function copy(value) { notice.value = await copyText(value) ? '토큰을 복사했습니다.' : '토큰을 선택해 복사해 주세요.'; }
    onMounted(load);
    return { data, loading, busy, error, notice, name, role, token, editing, editToken, secret, confirming, roleLabel, allowedCount, serverAiState, add, setRole, setServerAi, setKeyOwner, reissue, remove, copy, randomToken, TOKEN_TITLE };
  },
};
