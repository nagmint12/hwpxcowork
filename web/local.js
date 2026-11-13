// PC 폴더 연결·함께 검토 화면 조각(docs/LOCAL_FOLDER_APP_2026-11-10.md) — 개인용 앱(서버 설정 local.enabled)에서만 보인다.
// 문서 목록 화면(app.js DocList)이 GET /api/library 의 local = { canLink, links, remotes } 을 넘긴다. 보이는 글은 이름표만(docs/UI_TERMS.md §1).
//   LocalFoldersDialog  PC 폴더 연결·연결 끊기(폴더 고르기 창은 서버가 이 PC 화면에 띄운다)
//   ReviewServersDialog 검토 서버(다른 hwpx-cowork 서버 주소 + 그 서버의 내 토큰) 등록·열기·지우기
//   ReviewDialog        문서 하나를 검토 서버에 보내고(함께 검토) 검토본을 가져온다
import { ref, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, toast, fmt } from './util.js';
import { FloatWin, Hint } from './ui.js';
import { ICON } from './icons.js';

const HELP = '/help.html#local';

/** PC 파일 표시의 풀이(마우스 올림): 경로 + 지금 상태 */
export function localTip(local) {
  if (!local) return '';
  const where = local.path ? `PC 파일: ${local.path}` : 'PC 폴더의 파일';
  const state = {
    file: '아직 열지 않은 파일(열면 이 앱에 기록이 생깁니다)',
    ok: local.syncedAt ? `PC 파일에 저장됨 ${fmt(local.syncedAt)}` : 'PC 파일과 같음',
    saving: 'PC 파일에 저장하는 중',
    locked: '다른 프로그램(한/글 등)에서 열려 있어 PC 파일에 쓰지 못했습니다 — 닫으면 저장합니다',
    unreadable: 'PC 파일을 읽지 못했습니다(HWPX 가 아니거나 저장 중) — 앱의 문서는 그대로입니다',
    unlinked: '연결이 끊긴 PC 폴더의 문서',
  }[local.state] || '';
  return state ? `${where}\n${state}` : where;
}
/** 목록·상단의 짧은 꼬리표 글 */
export const localLabel = (local) => ({ locked: 'PC 쓰기 대기', unreadable: 'PC 읽기 실패', saving: 'PC 저장 중' }[local?.state] || 'PC');

// ───────── PC 폴더 연결 ─────────

export const LocalFoldersDialog = {
  components: { FloatWin, Hint },
  props: { local: Object },
  emits: ['close', 'changed'],
  template: `<FloatWin :anchor="null" :width="520" title="PC 폴더 연결" cls="libdlg localdlg" @close="$emit('close')">
    <div class="ld-body" data-testid="local-dialog">
      <ul class="lc-list" v-if="links.length">
        <li v-for="l in links" :key="l.id" :data-link="l.id">
          <span class="lt-ic" v-html="ICON.pc"></span>
          <span class="lc-main"><b>{{ l.name }}</b><span class="muted lc-path" :title="l.path">{{ l.path }}</span>
            <span class="warn" v-if="!l.ok" title="폴더가 보이지 않습니다(외장 디스크·네트워크 폴더가 빠졌거나 지워짐). 다시 보이면 이어집니다."> · 폴더 없음</span>
            <span class="warn" v-if="l.truncated" title="파일이 너무 많아 일부만 보입니다 — 더 안쪽 폴더를 연결하세요"> · 일부만</span></span>
          <button class="small" :disabled="busy" title="문서함에서만 뺍니다 — PC 의 파일과 이 앱의 문서 기록은 그대로 남습니다" @click="unlink(l)">연결 끊기</button></li>
      </ul>
      <div class="muted" v-else>연결한 폴더 없음</div>
      <div class="row lc-add">
        <button class="small" data-testid="local-pick" :disabled="busy" title="이 PC 의 폴더 고르기 창을 엽니다" @click="pick"><span class="ic" v-html="ICON.folder"></span>폴더 고르기</button>
        <input v-model="path" data-testid="local-path" placeholder="폴더 경로" aria-label="폴더 경로" title="폴더의 전체 경로(예: C:\\Users\\이름\\Documents\\보고서)" @keyup.enter="link"/>
        <button class="small primary" data-testid="local-link" :disabled="busy || !path.trim()" @click="link"><span v-if="busy" class="spin"></span>연결</button>
        <Hint text="연결한 폴더의 HWPX 가 개인 문서함에 보입니다. 열어서 고치면 그 파일에 저장되고, 한/글에서 고친 것도 다시 읽습니다." :href="HELP"/>
      </div>
      <div class="err" v-if="error" data-testid="local-error">{{ error }}</div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    const path = ref(''); const busy = ref(false); const error = ref('');
    const links = computed(() => props.local?.links || []);
    async function run(fn) {
      if (busy.value) return;
      busy.value = true; error.value = '';
      try { await fn(); } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    const pick = () => run(async () => {
      const out = await api('/api/local/pick', { method: 'POST', body: {} });
      if (out.path) path.value = out.path;
    });
    const link = () => run(async () => {
      const out = await api('/api/local/links', { method: 'POST', body: { path: path.value.trim() } });
      path.value = '';
      toast(`'${out.link.name}' 폴더를 연결했습니다`);
      emit('changed', out.local, out.link);
    });
    const unlink = (l) => run(async () => {
      if (!confirm(`'${l.name}' 연결을 끊을까요?\nPC 의 파일은 그대로 남습니다.`)) return;
      const out = await api(`/api/local/links/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
      toast('연결을 끊었습니다');
      emit('changed', out.local, null);
    });
    return { path, busy, error, links, pick, link, unlink, ICON, HELP };
  },
};

// ───────── 검토 서버 ─────────

/** 검토 서버 등록 칸(주소 · 토큰 · 이름) — 두 창이 같이 쓴다 */
const RemoteForm = {
  emits: ['added'],
  template: `<div class="rm-form">
    <input v-model="url" data-testid="remote-url" placeholder="서버 주소" aria-label="서버 주소" title="함께 검토할 hwpx-cowork 서버 주소(예: https://example.org)"/>
    <input v-model="token" data-testid="remote-token" type="password" autocomplete="off" placeholder="내 토큰" aria-label="그 서버의 내 토큰" title="그 서버 관리자에게 받은 내 접속 토큰 — 이 PC 에 암호화해 저장합니다" @keyup.enter="add"/>
    <input v-model="name" data-testid="remote-name" placeholder="이름(선택)" aria-label="서버 이름" maxlength="40"/>
    <button class="small primary" data-testid="remote-add" :disabled="busy || !url.trim() || !token.trim()" title="그 서버에 토큰으로 접속되는지 확인한 뒤 등록합니다" @click="add"><span v-if="busy" class="spin"></span>등록</button>
    <div class="err" v-if="error" data-testid="remote-error">{{ error }}</div></div>`,
  setup(props, { emit }) {
    const url = ref(''); const token = ref(''); const name = ref(''); const busy = ref(false); const error = ref('');
    async function add() {
      if (busy.value || !url.value.trim() || !token.value.trim()) return;
      busy.value = true; error.value = '';
      try {
        const out = await api('/api/local/remotes', { method: 'POST', body: { url: url.value.trim(), token: token.value.trim(), name: name.value.trim() || undefined } });
        url.value = ''; token.value = ''; name.value = '';
        toast(`'${out.remote.name}' 서버를 등록했습니다`);
        emit('added', out.local, out.remote);
      } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    return { url, token, name, busy, error, add };
  },
};

/** 그 서버를 내 토큰으로 새 창에 연다(주소는 서버가 이 PC 화면에만 준다) */
async function openRemote(id) {
  const out = await api(`/api/local/remotes/${encodeURIComponent(id)}/open`);
  window.open(out.url, '_blank', 'noopener');
}

export const ReviewServersDialog = {
  components: { FloatWin, Hint, RemoteForm },
  props: { local: Object },
  emits: ['close', 'changed'],
  template: `<FloatWin :anchor="null" :width="520" title="검토 서버" cls="libdlg localdlg" @close="$emit('close')">
    <div class="ld-body" data-testid="remotes-dialog">
      <ul class="lc-list" v-if="remotes.length">
        <li v-for="r in remotes" :key="r.id" :data-remote="r.id">
          <span class="lt-ic" v-html="ICON.people"></span>
          <span class="lc-main"><b>{{ r.name }}</b><span class="muted lc-path" :title="r.url">{{ r.url }}</span><span class="muted" v-if="r.user"> · {{ r.user }}</span></span>
          <button class="small" :disabled="busy" title="그 서버를 내 토큰으로 새 창에 엽니다" @click="open(r)">열기</button>
          <button class="icon" :disabled="busy" title="등록 지우기" aria-label="등록 지우기" @click="remove(r)" v-html="ICON.trash"></button></li>
      </ul>
      <div class="muted" v-else>등록한 서버 없음</div>
      <div class="row"><b class="lc-head">서버 추가</b><Hint text="여럿이 모여 검토할 때 쓰는 서버(중앙 서버)의 주소와 그 서버에서 받은 내 토큰을 등록합니다. 문서 줄의 [함께 검토]로 그 서버에 보냅니다." :href="HELP"/></div>
      <RemoteForm @added="(local) => $emit('changed', local)"/>
      <div class="err" v-if="error">{{ error }}</div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    const busy = ref(false); const error = ref('');
    const remotes = computed(() => props.local?.remotes || []);
    async function run(fn) {
      if (busy.value) return;
      busy.value = true; error.value = '';
      try { await fn(); } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    const open = (r) => run(() => openRemote(r.id));
    const remove = (r) => run(async () => {
      if (!confirm(`'${r.name}' 등록을 지울까요?`)) return;
      const out = await api(`/api/local/remotes/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      emit('changed', out.local);
    });
    return { busy, error, remotes, open, remove, ICON, HELP };
  },
};

// ───────── 함께 검토(문서 하나) ─────────

export const ReviewDialog = {
  components: { FloatWin, Hint, RemoteForm },
  props: { doc: Object, local: Object },
  emits: ['close', 'changed', 'saved'],
  template: `<FloatWin :anchor="null" :width="500" :title="'함께 검토 — ' + doc.title" cls="libdlg localdlg reviewdlg" @close="$emit('close')">
    <div class="ld-body" data-testid="review-dialog">
      <div class="rv-sent" v-if="review" data-testid="review-sent">
        <div><b>{{ review.server }}</b><span class="muted"> · 보냄 {{ fmt(review.sentAt) }}</span><span class="muted" v-if="review.fetchedAt"> · 가져옴 {{ fmt(review.fetchedAt) }}</span></div>
        <div class="muted" v-if="status?.remote" :title="'그 서버의 문서: ' + status.remote.title">서버 문서 · 수정 {{ fmt(status.remote.updatedAt) }}<template v-if="status.remote.proposals"> · 제안 {{ status.remote.proposals }}</template><template v-if="status.remote.requests"> · AI 작업 {{ status.remote.requests }}</template>
          <span class="pill rv-new" v-if="status.remote.changed" title="보낸 뒤(또는 마지막으로 가져온 뒤) 서버 문서가 바뀌었습니다">새 내용</span></div>
        <div class="err" v-else-if="status?.error">{{ status.error }}</div>
        <div class="muted" v-else-if="loading"><span class="spin dark"></span></div>
        <div class="row rv-acts">
          <button class="small" :disabled="!!busy || !status?.openUrl" title="그 서버의 이 문서를 새 창에 엽니다(내 토큰으로)" @click="open">서버에서 열기</button>
          <select v-model="kind" aria-label="가져올 꼴" title="그대로: 서버 문서의 변경 추적·메모까지 그대로 / 최종본: 변경을 모두 받아들인 글 + 메모">
            <option value="tracked">그대로</option><option value="final">최종본</option></select>
          <button class="small primary" data-testid="review-fetch" :disabled="!!busy" title="서버의 검토본으로 이 문서를 바꿉니다 — 지금 내용은 이력에 남고, PC 폴더 문서면 PC 파일에도 저장합니다" @click="fetchBack"><span v-if="busy === 'fetch'" class="spin"></span>검토본 가져오기</button>
        </div>
      </div>
      <template v-if="remotes.length">
        <div class="row rv-send">
          <select v-model="remote" data-testid="review-remote" aria-label="검토 서버"><option v-for="r in remotes" :key="r.id" :value="r.id">{{ r.name }}{{ r.user ? ' · ' + r.user : '' }}</option></select>
          <select v-model="space" data-testid="review-space" aria-label="올릴 곳" title="그 서버의 어느 문서함에 올릴지 — 개인 문서함에 올린 뒤 그 서버에서 폴더·권한으로 공유할 수도 있습니다">
            <option value="private">개인 문서함</option><option value="public">공용 문서함</option></select>
          <button class="small" :class="{ primary: !review }" data-testid="review-send" :disabled="!!busy || !remote" :title="sendTip" @click="send"><span v-if="busy === 'send'" class="spin" :class="{ dark: !!review }"></span>{{ review ? '다시 보내기' : '보내기' }}</button>
          <Hint text="지금 문서(메모·변경 추적 포함)를 검토 서버에 새 문서로 올립니다. 그 서버에서 여럿이 검토한 뒤 [검토본 가져오기]로 내 문서에 되돌려 받습니다." :href="HELP"/>
        </div>
      </template>
      <template v-else>
        <div class="row"><b class="lc-head">검토 서버 등록</b><Hint text="함께 검토할 서버의 주소와 그 서버에서 받은 내 토큰을 한 번 등록합니다." :href="HELP"/></div>
        <RemoteForm @added="added"/>
      </template>
      <div class="err" v-if="error" data-testid="review-error">{{ error }}</div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    const review = ref(props.doc.review || null);
    const status = ref(null); const loading = ref(false);
    // busy = '' | 'send' | 'fetch' — 틀에서는 !!busy 로 쓴다(Vue 는 :disabled="" 를 켜진 것으로 본다)
    const busy = ref(''); const error = ref('');
    const remotes = computed(() => props.local?.remotes || []);
    const remote = ref(review.value?.remote && remotes.value.some((r) => r.id === review.value.remote) ? review.value.remote : remotes.value[0]?.id || '');
    const space = ref('private'); const kind = ref('tracked');
    const id = encodeURIComponent(props.doc.id);
    const sendTip = computed(() => (review.value ? '지금 문서를 새 문서로 한 번 더 올립니다(앞서 보낸 서버 문서는 그대로 남습니다)' : '검토 서버에 올립니다'));
    async function loadStatus() {
      loading.value = true;
      try { status.value = await api(`/api/docs/${id}/review`); if (status.value.review) review.value = status.value.review; } catch (e) { status.value = { error: e.message }; } finally { loading.value = false; }
    }
    onMounted(() => { if (review.value) loadStatus(); });
    async function run(what, fn) {
      if (busy.value) return;
      busy.value = what; error.value = '';
      try { await fn(); } catch (e) { error.value = e.message || String(e); } finally { busy.value = ''; }
    }
    const send = () => run('send', async () => {
      const out = await api(`/api/docs/${id}/review/send`, { method: 'POST', body: { remote: remote.value, space: space.value } });
      review.value = out.review; status.value = { review: out.review, remote: null, openUrl: out.openUrl };
      toast('검토 서버에 보냈습니다');
      emit('saved');
      loadStatus();
    });
    const fetchBack = () => run('fetch', async () => {
      if (!confirm('서버의 검토본으로 이 문서를 바꿀까요?\n지금 내용은 이력에 남습니다.')) return;
      const out = await api(`/api/docs/${id}/review/fetch`, { method: 'POST', body: { kind: kind.value } });
      review.value = out.review;
      toast('검토본을 가져왔습니다');
      emit('saved');
      loadStatus();
    });
    const open = () => { if (status.value?.openUrl) window.open(status.value.openUrl, '_blank', 'noopener'); };
    function added(local, r) { emit('changed', local); remote.value = r.id; }
    return { review, status, loading, busy, error, remotes, remote, space, kind, sendTip, send, fetchBack, open, added, fmt, ICON, HELP };
  },
};
