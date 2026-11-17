// 문서함 화면 조각(docs/LIBRARY_SPEC.md §4): 왼쪽 문서함 나무(공용 문서함 · 개인 문서함 · 공유받은 문서함) + 권한 창 + 옮기기 창 + 이름 창.
// 문서 목록 화면(app.js DocList)이 GET /api/library 를 읽어 넘긴다. 보이는 글은 이름표만(docs/UI_TERMS.md §1) — 설명은 title 로.
// 자리·권한 계산(순수 함수)은 web/library-model.js.
import { ref, reactive, computed, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, toast } from './util.js';
import { FloatWin, Hint } from './ui.js';
import { ICON } from './icons.js';
import { PERM_LABELS, PERM_TIPS, PUBLIC_ROOT, everyoneLabel, locKey, parseLocKey, sameLoc, foldersAt, docsAt, sharedOwners, permColumns, togglePerm, moveTargets, rootLabel } from './library-model.js';

export * from './library-model.js';
const folderLoc = (f) => ({ space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.id });

// ───────── 문서함 나무 ─────────

const EXPAND_KEY = 'hwpx.lib.open';
const readOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(EXPAND_KEY) || '[]')); } catch { return new Set(); } };
const writeOpen = (set) => { try { localStorage.setItem(EXPAND_KEY, JSON.stringify([...set].slice(-300))); } catch { /* 저장 못 함 */ } };

const TreeNode = {
  name: 'TreeNode',
  props: { lib: Object, folder: Object, cur: Object, open: Object, depth: Number, active: { type: Boolean, default: true } },
  emits: ['go', 'toggle'],
  template: `<li>
    <div class="lt-row" :class="{ on: active && isCur, nav: folder.nav }" :style="{ paddingLeft: (depth * 14 + 4) + 'px' }" :data-folder="folder.id" @click="$emit('go', loc)" :title="folder.nav ? '길만 보임(이 폴더 문서는 볼 권한이 없습니다)' : folder.name">
      <button class="icon lt-tog" v-if="kids.length" :aria-label="isOpen ? '접기' : '펴기'" @click.stop="$emit('toggle', folder.id)" v-html="isOpen ? ICON.down : ICON.chevron"></button><span class="lt-tog sp" v-else></span>
      <span class="lt-ic" v-html="folder.local && folder.local.root ? ICON.pc : ICON.folder"></span><span class="lt-name">{{ folder.name }}</span><span class="lt-pc" v-if="folder.local && folder.local.root" title="연결한 PC 폴더 — 열어서 고치면 그 파일에 저장됩니다">PC</span>
    </div>
    <ul v-if="isOpen && kids.length"><TreeNode v-for="k in kids" :key="k.id" :lib="lib" :folder="k" :cur="cur" :active="active" :open="open" :depth="depth + 1" @go="$emit('go', $event)" @toggle="$emit('toggle', $event)"/></ul>
  </li>`,
  setup(props) {
    const loc = computed(() => folderLoc(props.folder));
    const kids = computed(() => foldersAt(props.lib, loc.value));
    const isOpen = computed(() => props.open.has(props.folder.id));
    const isCur = computed(() => sameLoc(props.cur, loc.value));
    return { loc, kids, isOpen, isCur, ICON };
  },
};

export const LibraryTree = {
  components: { TreeNode },
  props: { lib: Object, cur: Object, me: Object, driveActive: Boolean },
  emits: ['go', 'drive'],
  template: `<nav class="libtree" aria-label="문서함">
    <section v-for="r in roots" :key="r.key" class="lt-sec">
      <div class="lt-row lt-root" :class="{ on: isCur(r.loc) }" :data-root="r.key" @click="go(r.loc)" :title="r.title">
        <span class="lt-ic" v-html="ICON[r.icon]"></span><span class="lt-name">{{ r.label }}</span><span class="lt-count muted" v-if="r.count">{{ r.count }}</span></div>
      <ul><TreeNode v-for="f in r.folders" :key="f.id" :lib="lib" :folder="f" :cur="cur" :active="!driveActive" :open="open" :depth="1" @go="go" @toggle="toggle"/></ul>
    </section>
    <section class="lt-sec" data-testid="lib-drive"><button class="lt-row lt-root lt-drive" :class="{on:driveActive}" :aria-current="driveActive?'page':undefined" @click="$emit('drive')" title="두레이 드라이브 탐색"><span class="lt-ic" v-html="ICON.folder"></span><span class="lt-name">드라이브</span></button></section>
    <section class="lt-sec" v-if="shared.length" data-testid="lib-shared">
      <div class="lt-head muted">{{ me.role === 'admin' ? '다른 사람 문서함' : '공유받은 문서함' }}</div>
      <template v-for="r in shared" :key="r.key">
        <div class="lt-row" :class="{ on: isCur(r.loc) }" :style="{ paddingLeft: '4px' }" @click="go(r.loc)" :title="r.label + '의 개인 문서함'"><span class="lt-tog sp"></span><span class="lt-ic" v-html="ICON.people"></span><span class="lt-name">{{ r.label }}</span></div>
        <ul><TreeNode v-for="f in r.folders" :key="f.id" :lib="lib" :folder="f" :cur="cur" :active="!driveActive" :open="open" :depth="1" @go="go" @toggle="toggle"/></ul>
      </template>
    </section>
  </nav>`,
  setup(props, { emit }) {
    const open = reactive(readOpen());
    const mine = computed(() => ({ space: 'private', owner: props.me?.name, folderId: null }));
    const roots = computed(() => [
      { key: 'public', loc: PUBLIC_ROOT, label: '공용 문서함', icon: 'folder', title: '함께 쓰는 문서함 — 폴더마다 권한', folders: foldersAt(props.lib, PUBLIC_ROOT), count: docsAt(props.lib, PUBLIC_ROOT).length },
      { key: 'private', loc: mine.value, label: '개인 문서함', icon: 'lock', title: '나만 보는 문서함 — 폴더·문서를 골라 공유', folders: foldersAt(props.lib, mine.value), count: docsAt(props.lib, mine.value).length },
    ]);
    const shared = computed(() => sharedOwners(props.lib, props.me).map((o) => { const loc = { space: 'private', owner: o, folderId: null }; return { key: `p:${o}`, label: o, loc, folders: foldersAt(props.lib, loc) }; }));
    const isCur = (loc) => !props.driveActive && sameLoc(props.cur, loc);
    function toggle(id) { if (open.has(id)) open.delete(id); else open.add(id); writeOpen(open); }
    // 고른 폴더의 위는 펴 둔다(목록에서 폴더를 눌러 들어갔을 때도 나무에서 보이게)
    function go(loc) {
      const byId = new Map((props.lib?.folders || []).map((f) => [f.id, f]));
      let changed = false;
      for (let f = byId.get(byId.get(loc.folderId)?.parentId); f; f = byId.get(f.parentId)) { if (!open.has(f.id)) { open.add(f.id); changed = true; } if (open.size > 300) break; }
      if (changed) writeOpen(open);
      emit('go', loc);
    }
    return { roots, shared, open, isCur, toggle, go, ICON };
  },
};

// ───────── 이름 창(새 폴더·이름 바꾸기) ─────────

export const NameDialog = {
  components: { FloatWin },
  props: { title: String, value: { type: String, default: '' }, action: { type: String, default: '만들기' }, label: { type: String, default: '폴더 이름' }, maxlength: { type: Number, default: 60 } },
  emits: ['close', 'submit'],
  template: `<FloatWin :anchor="null" :width="340" :title="title" cls="libdlg" @close="$emit('close')">
    <div class="ld-body"><input ref="inp" v-model="name" :maxlength="maxlength" :placeholder="label" :aria-label="label" data-testid="folder-name" @keyup.enter="submit"/>
      <div class="err" v-if="error">{{ error }}</div>
      <div class="row end"><span class="spacer"></span><button class="small" @click="$emit('close')">취소</button>
        <button class="small primary" data-testid="folder-name-ok" :disabled="busy || !name.trim()" @click="submit">{{ action }}</button></div></div>
  </FloatWin>`,
  setup(props, { emit, expose }) {
    const name = ref(props.value); const inp = ref(null); const busy = ref(false); const error = ref('');
    onMounted(() => { inp.value?.focus(); inp.value?.select(); });
    // 부르는 쪽이 submit(name) 에서 Promise 를 돌려주면 끝날 때까지 기다리고, 실패하면 창 안에 알린다
    async function submit() {
      if (busy.value || !name.value.trim()) return;
      busy.value = true; error.value = '';
      try { await new Promise((resolve, reject) => emit('submit', name.value.trim(), { resolve, reject })); emit('close'); } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    expose({ submit });
    return { name, inp, busy, error, submit };
  },
};

// ───────── 권한 창 ─────────
// target = { kind: 'folder'|'root'|'doc', id?, name, space, owner?, inherit?, acl?, effective?, docFolder? }

export const AccessDialog = {
  components: { FloatWin, Hint },
  props: { target: Object, me: Object },
  emits: ['close', 'saved'],
  template: `<FloatWin :anchor="null" :width="560" :title="title" cls="libdlg accessdlg" @close="$emit('close')">
    <div class="ld-body" data-testid="access-dialog">
      <div class="acc-mode" v-if="target.kind !== 'root'" role="radiogroup" aria-label="권한 방식">
        <label class="ds-opt" :class="{ on: inherit }" :title="inheritTip"><input type="radio" :checked="inherit" @change="setInherit(true)" data-value="inherit"/> {{ target.kind === 'doc' ? '폴더 권한 따름' : '상위 폴더 따름' }}</label>
        <label class="ds-opt" :class="{ on: !inherit }" :title="target.kind === 'doc' ? '이 문서만 따로 정합니다(폴더 권한 대신)' : '이 폴더와 그 아래(따름으로 둔 하위 폴더)에 씁니다'"><input type="radio" :checked="!inherit" @change="setInherit(false)" data-value="custom"/> 직접 지정</label>
        <Hint :text="target.space === 'private' ? '개인 문서함은 주인과 여기 적은 사람만 봅니다. 관리자는 언제나 볼 수 있습니다.' : '공용 문서함은 폴더마다 여기 적은 사람에게 권한을 줍니다. 관리자는 언제나 볼 수 있습니다.'" href="/help.html#library"/>
      </div>
      <table class="acc-table" :class="{ dim: inherit }">
        <thead><tr><th>사람</th><th v-for="p in cols" :key="p" :title="PERM_TIPS[p]">{{ PERM_LABELS[p] }}</th><th></th></tr></thead>
        <tbody>
          <tr v-if="target.space === 'private'" class="acc-owner"><td>{{ target.owner }} <span class="muted">주인</span></td><td :colspan="cols.length + 1" class="muted">전부</td></tr>
          <tr v-for="e in shown" :key="e.name" :data-person="e.name">
            <td>{{ everyoneLabel(e.name) }}<span class="muted" v-if="roleOf(e.name) === 'viewer'" title="역할이 '보기만'이라 남의 문서함에서는 볼 수만 있습니다"> · 보기만</span></td>
            <td v-for="p in cols" :key="p"><input type="checkbox" :checked="e.perms.includes(p)" :disabled="inherit" :data-perm="p" :aria-label="everyoneLabel(e.name) + ' ' + PERM_LABELS[p]" @change="toggle(e, p, $event.target.checked)"/></td>
            <td><button class="icon" v-if="!inherit" title="빼기" aria-label="빼기" @click="remove(e)" v-html="ICON.x"></button></td>
          </tr>
          <tr v-if="!shown.length"><td :colspan="cols.length + 2" class="muted">{{ inherit && target.kind === 'doc' && !target.docFolder ? '폴더 권한을 따릅니다' : target.space === 'private' ? '공유한 사람 없음' : '아무도 없음' }}</td></tr>
        </tbody>
      </table>
      <div class="row acc-add" v-if="!inherit">
        <select v-model="addName" data-testid="access-add" aria-label="사람 추가" @change="add">
          <option value="">＋ 사람 추가</option>
          <option v-if="target.space === 'public' && !rows.some((r) => r.name === '*')" value="*">모든 사용자</option>
          <option v-for="u in candidates" :key="u.name" :value="u.name">{{ u.name }}{{ u.role === 'admin' ? ' · 관리자' : '' }}</option>
        </select>
        <span class="muted" v-if="loadingUsers"><span class="spin dark"></span></span>
      </div>
      <div class="err" v-if="error" data-testid="access-error">{{ error }}</div>
      <div class="row end ds-foot"><span class="spacer"></span>
        <button class="small" @click="$emit('close')">취소</button>
        <button class="small primary" data-testid="access-save" :disabled="busy" @click="save"><span v-if="busy" class="spin"></span>저장</button></div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    const t = props.target;
    const inherit = ref(t.kind !== 'root' && t.inherit !== false);
    const copy = (list) => (list || []).map((e) => ({ name: e.name, perms: [...e.perms] }));
    const rows = ref(copy(t.acl));
    const users = ref([]); const loadingUsers = ref(false);
    const addName = ref(''); const busy = ref(false); const error = ref('');
    const cols = computed(() => permColumns(t.kind === 'doc' ? 'doc' : 'folder', t.space));
    // 따름이면 물려받는 목록(관리 권한이 있는 폴더면 서버가 effective 를 준다 — 문서는 그 폴더의 것)
    const inherited = computed(() => copy(t.kind === 'doc' ? t.docFolder?.effective || (t.docFolder === null ? t.rootAcl : null) : t.effective));
    const shown = computed(() => (inherit.value ? inherited.value : rows.value).filter((e) => !(t.space === 'private' && e.name === t.owner)));
    const title = computed(() => `권한 — ${t.name}`);
    const inheritTip = computed(() => (t.kind === 'doc' ? '이 문서가 든 폴더의 권한을 그대로 씁니다' : '바로 위 폴더(맨 위면 문서함)의 권한을 그대로 씁니다'));
    const roleOf = (name) => users.value.find((u) => u.name === name)?.role || null;
    const candidates = computed(() => users.value.filter((u) => u.name && !rows.value.some((r) => r.name === u.name) && !(t.space === 'private' && u.name === t.owner)));
    onMounted(async () => {
      loadingUsers.value = true;
      try { users.value = await api('/api/users'); } catch (e) { error.value = `사람 목록을 읽지 못했습니다: ${e.message}`; } finally { loadingUsers.value = false; }
    });
    function setInherit(v) {
      error.value = '';
      inherit.value = v;
      // 처음 직접 지정으로 바꾸면 지금 물려받는 목록을 채워 둔다(고칠 것만 고치게)
      if (!v && !rows.value.length && inherited.value.length) rows.value = copy(inherited.value);
    }
    function toggle(e, p, on) { e.perms = togglePerm(e.perms, p, on); if (!e.perms.length) remove(e); }
    function remove(e) { rows.value = rows.value.filter((r) => r !== e); }
    function add() {
      const n = addName.value; addName.value = '';
      if (!n || rows.value.some((r) => r.name === n)) return;
      rows.value = [...rows.value, { name: n, perms: ['read'] }];
    }
    async function save() {
      if (busy.value) return;
      busy.value = true; error.value = '';
      const body = inherit.value ? { inherit: true } : { acl: rows.value.filter((r) => r.perms.length) };
      try {
        let out;
        if (t.kind === 'root') out = await api('/api/library/public/access', { method: 'PUT', body });
        else if (t.kind === 'folder') out = await api(`/api/folders/${encodeURIComponent(t.id)}/access`, { method: 'PUT', body: inherit.value ? { inherit: true } : { inherit: false, acl: body.acl } });
        else out = await api(`/api/docs/${encodeURIComponent(t.id)}/access`, { method: 'PUT', body });
        toast('권한을 저장했습니다');
        emit('saved', out); emit('close');
      } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    return { target: t, inherit, rows, shown, cols, title, inheritTip, candidates, addName, loadingUsers, busy, error, roleOf, setInherit, toggle, remove, add, save, PERM_LABELS, PERM_TIPS, everyoneLabel, ICON };
  },
};

// ───────── 옮기기 창 ─────────
// item = { kind: 'doc'|'folder', id, name, loc(지금 자리), folder?(폴더면 그 폴더) }

export const MoveDialog = {
  components: { FloatWin },
  props: { lib: Object, me: Object, item: Object },
  emits: ['close', 'saved'],
  template: `<FloatWin :anchor="null" :width="380" :title="'옮기기 — ' + item.name" cls="libdlg movedlg" @close="$emit('close')">
    <div class="ld-body" data-testid="move-dialog">
      <ul class="mv-list" role="listbox" aria-label="옮길 자리">
        <li v-for="t in targets" :key="locKeyOf(t.loc)" role="option" :aria-selected="picked === locKeyOf(t.loc)" :class="{ on: picked === locKeyOf(t.loc), here: isHere(t.loc), root: t.root }"
          :style="{ paddingLeft: (t.depth * 14 + 8) + 'px' }" :data-target="locKeyOf(t.loc)" @click="!isHere(t.loc) && (picked = locKeyOf(t.loc))">
          <span class="lt-ic" v-html="t.root ? (t.loc.space === 'public' ? ICON.folder : t.loc.owner === me.name ? ICON.lock : ICON.people) : ICON.folder"></span> {{ t.label }}<span class="muted" v-if="isHere(t.loc)"> · 지금 자리</span></li>
        <li v-if="!targets.length" class="muted">옮길 수 있는 자리가 없습니다</li>
      </ul>
      <div class="err" v-if="error">{{ error }}</div>
      <div class="row end ds-foot"><span class="spacer"></span><button class="small" @click="$emit('close')">취소</button>
        <button class="small primary" data-testid="move-ok" :disabled="busy || !picked" @click="save"><span v-if="busy" class="spin"></span>옮기기</button></div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    // 폴더는 자기 자리(지금 위) 대신 '지금 자리'로 보이고, 자기 자신·그 아래는 moveTargets 가 뺀다.
    // PC 폴더의 문서·폴더(item.localOnly)는 PC 폴더 안으로만 옮긴다(서버 문서함으로는 옮기지 않는다 — 서버가 409 LOCAL_ONLY)
    const targets = computed(() => {
      const all = moveTargets(props.lib, props.me, props.item.kind === 'folder' ? props.item.folder : null);
      if (!props.item.localOnly) return all;
      const local = new Set((props.lib?.folders || []).filter((f) => f.local && (props.item.kind !== 'folder' || f.local.link === props.item.folder.local?.link)).map((f) => f.id));
      return all.filter((t) => t.loc.folderId && local.has(t.loc.folderId));
    });
    const picked = ref(''); const busy = ref(false); const error = ref('');
    const isHere = (loc) => sameLoc(loc, props.item.loc);
    async function save() {
      if (busy.value || !picked.value) return;
      busy.value = true; error.value = '';
      const loc = parseLocKey(picked.value);
      try {
        const out = props.item.kind === 'doc'
          ? await api(`/api/docs/${encodeURIComponent(props.item.id)}/location`, { method: 'PATCH', body: loc.folderId ? { folderId: loc.folderId } : { space: loc.space, owner: loc.owner } })
          : await api(`/api/folders/${encodeURIComponent(props.item.id)}`, { method: 'PATCH', body: { parentId: loc.folderId } });
        toast('옮겼습니다');
        emit('saved', out); emit('close');
      } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    return { targets, picked, busy, error, isHere, save, locKeyOf: locKey, ICON };
  },
};
