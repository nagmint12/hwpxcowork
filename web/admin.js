// 관리자 전용 서버 설정. 문서에서 열 때는 편집기를 유지하는 대화상자를 쓴다.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { state, api, copyText } from './util.js';
import { webAddress, localAddress } from './connections.js';
import { AdminLimitsPanel, AdminUsersPanel } from './admin-accounts.js';
import { AdminCreditsPanel } from './admin-credits.js';
import { AdminTutorialAiPanel } from './admin-tutorial-ai.js';

const hostMode = (host) => host === '127.0.0.1' ? 'local' : host === '0.0.0.0' ? 'lan' : 'custom';
const binding = (s) => s ? `${s.host.includes(':') ? `[${s.host}]` : s.host}:${s.port}` : '';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const AdminServerPanel = {
  components: { AdminLimitsPanel, AdminUsersPanel, AdminCreditsPanel, AdminTutorialAiPanel },
  props: { modal: Boolean, prepareRestart: Function },
  emits: ['close'],
  template: `<component :is="modal ? 'dialog' : 'section'" ref="container" :class="['admin-server', { 'admin-dialog': modal }]"
      aria-labelledby="admin-server-title" data-testid="admin-server" @cancel.prevent="requestClose" @keydown.esc.stop.prevent="requestClose">
    <header class="admin-heading"><div><span class="admin-eyebrow">관리자</span><h1 id="admin-server-title">서버 설정</h1></div>
      <button v-if="modal" class="small" data-testid="admin-close" aria-label="관리자 설정 닫기" @click="requestClose">닫기</button>
      <a v-else class="btnlike small" href="#/">← 문서 목록</a></header>
    <p class="muted admin-intro">접속 주소·서버 실행 방식, AI 응답 크기, 사용자, AI 크레딧, 튜토리얼 AI를 관리합니다.</p>
    <nav class="admin-tabs" role="tablist" aria-label="관리자 설정"><button v-for="t in tabs" :key="t.id" type="button" role="tab" :aria-selected="tab === t.id" :class="{ active: tab === t.id }" :data-testid="'admin-tab-' + t.id" @click="selectTab(t.id)">{{ t.label }}</button></nav>
    <template v-if="tab === 'server'">
    <p v-if="loading" class="admin-message" role="status">서버 설정을 읽는 중입니다…</p>
    <div v-else-if="!snapshot" class="admin-message"><p class="err" role="alert">{{ error }}</p><button @click="load">다시 읽기</button></div>
    <template v-else>
      <div class="admin-current" data-testid="admin-current"><span>현재 접속 주소</span><code>{{ currentAddress }}</code>
        <span>실행 중</span><div><code>{{ runningBinding }}</code><span class="admin-status" :class="snapshot.restartRequired ? 'pending' : 'ready'">{{ snapshot.restartRequired ? '저장한 설정 · 재시작 대기' : '저장한 설정으로 실행 중' }}</span></div>
        <template v-if="snapshot.restartRequired"><span>다음 실행</span><code>{{ savedBinding }} · 공유 주소 {{ snapshot.saved.publicUrl || '자동' }}</code></template></div>
      <form class="admin-form" @submit.prevent="review('saveRestart')" novalidate>
        <fieldset :disabled="busy || polling"><legend class="sr-only">서버 접속 설정</legend>
          <div class="admin-field"><label for="admin-access">접속 허용</label>
            <select id="admin-access" v-model="access" :disabled="locked('host')" aria-describedby="admin-access-help" data-testid="admin-access"><option value="local">이 PC만</option><option value="lan">같은 네트워크의 다른 PC</option><option value="custom">직접 지정 (고급)</option></select>
            <p id="admin-access-help" class="muted">{{ access === 'local' ? '127.0.0.1 — 서버를 실행한 PC에서만 직접 접속합니다.' : access === 'lan' ? '0.0.0.0 — 같은 네트워크에서는 아래 LAN 주소로 접속합니다.' : '이 서버에서 수신할 IP 주소 또는 localhost를 지정합니다.' }}</p>
            <input v-if="access === 'custom'" v-model="customHost" :disabled="locked('host')" aria-label="수신 호스트" autocomplete="off" spellcheck="false" data-testid="admin-host"/>
            <p v-if="locked('host')" class="admin-lock">{{ lockReason('host') }}</p><p v-if="fieldErrors.host" class="err" role="alert">{{ fieldErrors.host }}</p></div>
          <div class="admin-field admin-port"><label for="admin-port">포트</label><input id="admin-port" v-model="port" type="text" inputmode="numeric" autocomplete="off" :disabled="locked('port')" data-testid="admin-port"/>
            <p class="muted">1–65535 사이의 번호입니다. 기본값은 8787입니다.</p><p v-if="locked('port')" class="admin-lock">{{ lockReason('port') }}</p><p v-if="fieldErrors.port" class="err" role="alert">{{ fieldErrors.port }}</p></div>
          <div class="admin-field"><label for="admin-public-url">외부 공유 주소 <span class="muted">(선택)</span></label>
            <input id="admin-public-url" v-model="publicUrl" type="url" placeholder="https://cowork.example.org" :disabled="locked('publicUrl')" autocomplete="off" spellcheck="false" data-testid="admin-public-url" aria-describedby="admin-url-help"/>
            <p id="admin-url-help" class="muted">비워 두면 자동으로 안내합니다. 이미 연결한 도메인·HTTPS 프록시 주소를 적으세요. 이 설정만으로 인터넷에 공개되지는 않습니다.</p>
            <p v-if="locked('publicUrl')" class="admin-lock">{{ lockReason('publicUrl') }}</p><p v-if="fieldErrors.publicUrl" class="err" role="alert">{{ fieldErrors.publicUrl }}</p></div>
        </fieldset>
        <div class="admin-lan" v-if="lan.length"><b>같은 네트워크에서 공유할 주소</b><p class="muted">접속할 LAN·VPN 주소를 골라 전달하세요. 다른 PC의 연결 여부는 확인이 필요합니다.</p>
          <div v-for="item in lan" :key="item.webUrl" class="admin-lan-row"><code>{{ item.webUrl }}</code><span class="muted">{{ item.label }}</span><button type="button" class="small" @click="copy(item.webUrl)">주소 복사</button></div></div>
        <p v-else-if="access === 'lan'" class="muted">저장하고 재시작하면 이 서버의 LAN 주소 후보를 확인할 수 있습니다. 다른 PC에서 접속하려면 서버 PC의 방화벽도 허용되어 있어야 합니다.</p>
        <p v-if="invalidSaved" class="admin-message pending">기존 설정 중 확인이 필요한 항목이 있습니다. 아래 값을 확인하고 저장하세요.</p>
        <div v-if="changed" class="admin-review" data-testid="admin-change-preview"><b>저장할 변경</b><p>수신 주소: <code>{{ runningBinding }}</code> → <code>{{ previewBinding }}</code></p><p>외부 공유 주소: <code>{{ publicUrl.trim() || '자동' }}</code></p><p class="muted">저장한 설정은 서버를 재시작한 뒤 적용됩니다.</p></div>
        <p v-if="!snapshot.restart.supported" class="admin-message">이 실행 방식에서는 화면에서 재시작할 수 없습니다. 설정을 저장한 뒤 서버 PC에서 서버를 종료하고 <code>npm start</code>로 다시 실행하세요.</p>
        <p v-if="snapshot.restart.busy && !polling" class="admin-message" role="status">서버 재시작이 이미 진행 중입니다. 잠시 뒤 설정을 다시 읽으세요.</p>
        <p v-if="error" class="admin-message err" role="alert" data-testid="admin-error">{{ error }}</p>
        <p v-if="notice" class="admin-message" role="status" data-testid="admin-notice">{{ notice }}</p>
        <div v-if="polling" class="admin-message" role="status"><span class="spin dark"></span> 서버가 다시 시작되기를 기다립니다… 이 화면의 입력은 유지됩니다.</div>
        <div v-if="reconnectUrl" class="admin-message admin-reconnect" data-testid="admin-reconnect"><p>{{ reconnectDirect ? '새 포트로 직접 접속할 주소' : '설정한 공유 주소' }}</p><a :href="reconnectUrl" target="_blank" rel="noopener noreferrer" data-testid="admin-new-address">{{ reconnectUrl }}</a><p class="muted">새 주소에서는 개인 접속 토큰으로 다시 로그인하세요. ‘이 PC만’은 서버 PC의 브라우저에서 접속합니다.</p><p v-if="configuredReconnectUrl">설정한 공유 주소: <a :href="configuredReconnectUrl" target="_blank" rel="noopener noreferrer">{{ configuredReconnectUrl }}</a> — 프록시를 사용한다면 연결을 확인하세요.</p></div>
        <div v-if="reviewMode" class="admin-review" data-testid="admin-restart-review" role="group" aria-label="서버 재시작 확인"><b>{{ reviewMode === 'saveRestart' ? '저장한 뒤 서버를 재시작할까요?' : '서버를 재시작할까요?' }}</b><p>모든 사용자의 연결이 잠시 끊깁니다. 입력 중인 글을 저장한 뒤 진행하세요.</p><div class="row"><button type="button" class="primary" :disabled="busy || polling" data-testid="admin-restart-confirm" @click="confirmRestart">확인하고 재시작</button><button type="button" :disabled="busy || polling" @click="reviewMode = ''">취소</button></div></div>
        <div v-else class="admin-actions"><button type="submit" class="primary" data-testid="admin-save-restart" :disabled="busy || polling || !canRestart || (!changed && !snapshot.restartRequired)">저장하고 재시작</button><button type="button" data-testid="admin-save" :disabled="busy || polling || !changed || snapshot.restart.busy" @click="saveOnly">설정만 저장</button><button type="button" data-testid="admin-restart" :disabled="busy || polling || !canRestart" @click="review('restart')">서버 재시작</button><button type="button" class="small" :disabled="busy || polling" @click="refresh">상태 새로고침</button></div>
      </form>
      <div v-if="closeReview" class="admin-review"><p>저장하지 않은 설정이 있습니다. 창을 닫을까요?</p><div class="row"><button @click="finishClose">닫기</button><button @click="closeReview = false">계속 설정</button></div></div>
    </template>
    </template>
    <AdminLimitsPanel v-else-if="tab === 'limits'"/>
    <AdminCreditsPanel v-else-if="tab === 'credits'"/>
    <AdminTutorialAiPanel v-else-if="tab === 'tutorial-ai'"/>
    <AdminUsersPanel v-else/>
  </component>`,
  setup(props, { emit }) {
    const container = ref(null); const snapshot = ref(null); const loading = ref(true);
    const access = ref('local'); const customHost = ref(''); const port = ref('8787'); const publicUrl = ref('');
    const error = ref(''); const notice = ref(''); const fieldErrors = ref({}); const busy = ref(false); const polling = ref(false);
    const reviewMode = ref(''); const closeReview = ref(false); const diagnostics = ref(null); const reconnectUrl = ref('');
    const reconnectDirect = ref(false); const configuredReconnectUrl = ref('');
    // 탭: 서버 접속(재시작 필요) · AI 응답 크기 · 사용자(둘 다 바로 적용 — 같은 설정 파일이라 돌아오면 서버 설정을 다시 읽는다) · AI 크레딧(읽기만)
    const tabs = [{ id: 'server', label: '서버 접속' }, { id: 'limits', label: 'AI 응답 크기' }, { id: 'users', label: '사용자' }, { id: 'credits', label: 'AI 크레딧' }, { id: 'tutorial-ai', label: '튜토리얼 AI' }];
    const tab = ref('server');
    async function selectTab(id) {
      if (id === tab.value) return;
      tab.value = id;
      if (id === 'server' && snapshot.value) { try { apply(await api('/api/admin/server'), !changed.value); } catch { /* 저장할 때 다시 확인한다 */ } }
    }
    let disposed = false; let focusBefore = null; let pollController = null;
    const currentAddress = webAddress(location.origin);
    const settings = computed(() => ({ host: access.value === 'local' ? '127.0.0.1' : access.value === 'lan' ? '0.0.0.0' : customHost.value.trim(), port: Number(port.value), publicUrl: publicUrl.value.trim().replace(/\/+$/, '') }));
    const changed = computed(() => !!snapshot.value && ['host', 'port', 'publicUrl'].some((key) => settings.value[key] !== snapshot.value.saved[key]));
    const runningBinding = computed(() => binding(snapshot.value?.running));
    const savedBinding = computed(() => binding(snapshot.value?.saved));
    const previewBinding = computed(() => binding(settings.value));
    const canRestart = computed(() => !!snapshot.value?.restart?.supported && !snapshot.value.restart.busy);
    const invalidSaved = computed(() => !!snapshot.value?.invalidFields?.saved?.length);
    const lan = computed(() => (diagnostics.value?.lan || []).map((x) => ({ ...x, webUrl: webAddress(x.webUrl) })).filter((x) => x.webUrl));
    const locked = (key) => !!snapshot.value?.overrides?.[key]?.locked;
    const lockReason = (key) => `${snapshot.value?.overrides?.[key]?.source || '환경 변수'}로 고정되어 있습니다. 서버를 실행한 곳에서 변경하세요.`;
    function fill(data) { access.value = hostMode(data.saved.host); customHost.value = data.saved.host; port.value = String(data.saved.port); publicUrl.value = data.saved.publicUrl || ''; }
    function apply(data, reset = false) { snapshot.value = data; if (reset) fill(data); }
    async function readConnections() { try { diagnostics.value = await api('/api/connections'); } catch { /* 설정은 주소 진단 없이도 사용한다 */ } }
    async function load() {
      if (state.me?.role !== 'admin') return;
      loading.value = true; error.value = '';
      try { apply(await api('/api/admin/server'), true); await readConnections(); } catch (e) { error.value = `서버 설정을 읽지 못했습니다: ${e.message}`; }
      finally { loading.value = false; }
    }
    async function refresh() {
      error.value = ''; notice.value = '';
      try { const keep = changed.value; apply(await api('/api/admin/server'), !keep); await readConnections(); notice.value = keep ? '실행 상태를 새로 읽었습니다. 입력 중인 설정은 유지했습니다.' : '최신 상태입니다.'; }
      catch (e) { error.value = `상태를 읽지 못했습니다. 입력한 설정은 유지했습니다: ${e.message}`; }
    }
    function validate() {
      const errors = {}; const v = settings.value;
      const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(v.host) && v.host.split('.').every((part) => String(Number(part)) === part && Number(part) <= 255);
      let ipv6 = false; if (v.host.includes(':') && !v.host.includes('%')) { try { ipv6 = new URL(`http://[${v.host}]`).hostname.startsWith('['); } catch { /* 잘못된 IPv6 */ } }
      if (v.host.toLowerCase() !== 'localhost' && !ipv4 && !ipv6) errors.host = '수신할 IP 주소 또는 localhost를 입력하세요. URL과 포트는 넣지 않습니다.';
      if (!/^\d+$/.test(String(port.value)) || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) errors.port = '포트는 1–65535 사이의 정수로 입력하세요.';
      if (v.publicUrl) {
        try { const u = new URL(v.publicUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.port && Number(u.port) < 1) || ['0.0.0.0', '[::]'].includes(u.hostname)) throw new Error(); }
        catch { errors.publicUrl = '인증정보·토큰·쿼리 없는 HTTP 또는 HTTPS 서버 주소를 입력하세요.'; }
      }
      fieldErrors.value = errors; return !Object.keys(errors).length;
    }
    function report(e, prefix) {
      if (e.code === 'CONFIG_CHANGED') error.value = '다른 관리자가 설정을 바꿨습니다. 상태 새로고침으로 확인한 뒤 다시 저장하세요. 입력한 값은 유지했습니다.';
      else if (e.code === 'ENV_OVERRIDE') error.value = '환경 변수로 고정된 항목을 변경할 수 없습니다. 상태를 새로 읽어 확인하세요.';
      else error.value = `${prefix}${e.message}`;
      if (e.data?.field && ['host', 'port', 'publicUrl'].includes(e.data.field)) fieldErrors.value = { ...fieldErrors.value, [e.data.field]: e.message };
    }
    async function save() {
      if (!changed.value) return true;
      if (!validate()) return false;
      const data = await api('/api/admin/server', { method: 'PATCH', body: { settings: settings.value, revision: snapshot.value.revision } });
      apply(data, true); return true;
    }
    async function saveOnly() {
      if (busy.value || polling.value || !validate()) return;
      busy.value = true; error.value = ''; notice.value = ''; reviewMode.value = '';
      try { if (await save()) notice.value = snapshot.value.restartRequired ? '설정을 저장했습니다. 서버를 재시작하면 적용됩니다.' : '설정을 저장했습니다.'; }
      catch (e) { report(e, '설정을 저장하지 못했습니다. 입력한 값은 유지했습니다: '); }
      finally { busy.value = false; }
    }
    function review(mode) {
      if (busy.value || polling.value || !canRestart.value) return;
      error.value = ''; notice.value = '';
      if (mode === 'saveRestart' && !validate()) return;
      if (mode === 'restart' && changed.value) { error.value = '입력한 설정을 적용하려면 ‘저장하고 재시작’을 누르세요. 먼저 저장한 설정만 재시작하려면 입력을 원래 값으로 돌려주세요.'; return; }
      reviewMode.value = mode;
    }
    function nextAddress(saved) {
      try {
        const u = new URL(location.origin);
        u.port = String(locked('port') ? snapshot.value.running.port : saved.port);
        const direct = webAddress(u.href); const configured = webAddress(saved.publicUrl);
        reconnectDirect.value = false; configuredReconnectUrl.value = '';
        if (!configured) { reconnectDirect.value = true; return direct; }
        const publicAddress = new URL(configured);
        const publicPort = Number(publicAddress.port || (publicAddress.protocol === 'https:' ? 443 : 80));
        // localhost 공유 주소는 원격 브라우저의 PC를 가리킨다. 현 브라우저의 주소로 안내한다.
        const remoteLocal = localAddress(configured) && !localAddress(currentAddress);
        const oldDirect = publicPort === snapshot.value.running.port && (localAddress(configured) || publicAddress.origin === location.origin);
        if (remoteLocal || (oldDirect && direct !== configured)) {
          reconnectDirect.value = true;
          if (!localAddress(configured) && configured !== direct) configuredReconnectUrl.value = configured;
          return direct;
        }
        return configured;
      } catch { return ''; }
    }
    async function confirmRestart() {
      if (busy.value || polling.value || !canRestart.value) return;
      busy.value = true; error.value = ''; notice.value = ''; let saved = false;
      const oldInstance = snapshot.value.running.instanceId || state.config?.nonce;
      try {
        if (props.prepareRestart && !(await props.prepareRestart())) { error.value = '문서에 아직 저장하지 못한 글이 있습니다. 관리자 창을 닫고 문서의 저장 상태를 확인한 뒤 다시 시도하세요.'; return; }
        if (reviewMode.value === 'saveRestart') { if (!(await save())) return; saved = true; }
        const target = nextAddress(snapshot.value.saved);
        const expected = { saved: { ...snapshot.value.saved }, running: Object.fromEntries(['host', 'port', 'publicUrl'].map((key) => [key, locked(key) ? snapshot.value.running[key] : snapshot.value.saved[key]])) };
        const result = await api('/api/admin/restart', { method: 'POST', body: { revision: snapshot.value.revision } });
        apply(result); reviewMode.value = ''; reconnectUrl.value = target !== currentAddress ? target : '';
        busy.value = false; await pollRestart(oldInstance, expected);
      } catch (e) { report(e, saved ? '설정은 저장했지만 재시작을 시작하지 못했습니다: ' : '서버 재시작을 시작하지 못했습니다: '); }
      finally { busy.value = false; }
    }
    async function pollRestart(oldInstance, expected) {
      polling.value = true; let changedInstance = false;
      try {
        // 현 주소를 먼저 확인한다. 프록시 주소는 포트를 바꿔도 그대로일 수 있다.
        // 다른 origin에는 토큰을 보내지 않는다. 과거 서버의 응답은 완료로 보지 않는다.
        for (let attempt = 0; attempt < 24 && !disposed; attempt++) {
          await wait(1000); if (disposed) break;
          pollController = new AbortController(); const timeout = setTimeout(() => pollController?.abort(), 1200);
          try {
            const r = await fetch('/api/config', { cache: 'no-store', signal: pollController.signal });
            if (r.ok) {
              const cfg = await r.json();
              if (oldInstance && cfg.nonce && cfg.nonce !== oldInstance) {
                changedInstance = true; state.config = cfg;
                try {
                  const actual = await api('/api/admin/server'); apply(actual); await readConnections();
                  const matchingSaved = ['host', 'port', 'publicUrl'].every((key) => actual.saved[key] === expected.saved[key]);
                  const matchingRunning = ['host', 'port', 'publicUrl'].every((key) => key === 'publicUrl' && !expected.running[key] || actual.running[key] === expected.running[key]);
                  notice.value = matchingSaved && matchingRunning && !actual.restartRequired
                    ? '서버가 다시 시작되었습니다. 새 설정이 적용되었습니다.'
                    : '서버가 다시 시작되었지만 요청한 설정과 실행 상태가 다릅니다. 이전 설정으로 복구되었을 수 있습니다. 위 실행 중 주소와 저장한 설정을 확인하세요.';
                }
                catch { notice.value = '새 서버가 시작되었습니다. 연결을 확인하고 필요하면 다시 로그인하세요.'; }
                break;
              }
            }
          } catch { /* 재시작 중에는 연결이 잠시 끊긴다 */ }
          finally { clearTimeout(timeout); pollController = null; }
        }
        if (!changedInstance && !disposed) notice.value = '재시작 요청을 보냈지만 현재 주소에서 완료를 확인하지 못했습니다. 잠시 뒤 상태를 새로 읽거나 새 주소에서 접속하세요. 저장한 설정은 유지됩니다.';
      } finally { polling.value = false; }
    }
    async function copy(value) { notice.value = await copyText(value) ? '주소를 복사했습니다.' : '주소를 선택하여 복사해 주세요.'; }
    function finishClose() { if (!props.modal) return; container.value?.close(); emit('close'); }
    function requestClose() { if (!props.modal || busy.value) return; if (changed.value) closeReview.value = true; else finishClose(); }
    onMounted(async () => {
      focusBefore = document.activeElement;
      if (props.modal) { await nextTick(); container.value?.showModal(); }
      await load();
    });
    onBeforeUnmount(() => { disposed = true; pollController?.abort(); if (props.modal && focusBefore?.isConnected) focusBefore.focus({ preventScroll: true }); });
    return { tabs, tab, selectTab, container, snapshot, loading, access, customHost, port, publicUrl, error, notice, fieldErrors, busy, polling, reviewMode, closeReview, reconnectUrl, reconnectDirect, configuredReconnectUrl, currentAddress, changed, runningBinding, savedBinding, previewBinding, canRestart, invalidSaved, lan, locked, lockReason, load, refresh, saveOnly, review, confirmRestart, copy, requestClose, finishClose };
  },
};
