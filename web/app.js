// HWPX 공동 검토 웹앱 — Vue 3(빌드 없음).
// v0.3(docs/V3_SPEC.md §5): 문서 화면 = 상단 막대 + 편집기(rhwp-studio iframe + cowork 플러그인, web/editor.js) + 문서 옆 메모(web/rail.js) + 패널 탭(web/panels.js).
// 편집기는 하나다 — v0.2 의 검토 보기(review.js)·편집 보기는 없앴다(옛 주소 #/doc/<id>?legacy=1 도 이 화면을 연다. 옛 코드는 backups/v0.2.0_2026-10-22).
// v0.4(docs/V4_SPEC.md §2.4·§3·§5): 상단 막대 `← 목록 · 제목 · v3 · (상태 칩) · 접속자 · 내 에이전트 · [한글로 저장] · ⚙ 문서 설정 · 보기 간단히/자세히`.
// 좁은 창(1100px 이하)이면 ⚙ 문서 설정부터 뒤는 [⋯] 메뉴 안으로(600px 이하면 한글로 저장도) — 막대는 한 줄. 패널은 경계선을 끌어 폭(좁은 창은 높이·접기)을 바꾼다.
// 넓은 창은 두 칸(편집기 | AI 작업 창): 메모·제안(검토 표시)은 칸을 따로 두지 않고 쪽 옆 여백 위에 띄우고(한/글처럼 — 끌어 어디로든 옮김, rail.js),
// AI 작업 창은 꼭지로 접고 펴며 접힌 동안 꼭지나 화면 오른쪽 끝에 마우스를 대면 잠깐 펼친다(docs/V4_SPEC.md §5).
// 상태 칩은 실시간이면 '실시간 · 저장됨 10:31'·'보내는 중…'·'보내지 못함 — [다시]'·'읽기 전용', 승인 방식이면 v0.3 칩(내 수정본·새 버전 있음 [최신으로 맞추기]·[검토 요청]…). 보이는 글은 docs/UI_TERMS.md 대로.
// 한글로 저장은 단추 하나(설정대로 — /file?kind=export), ⚙ 문서 설정 창(web/settings.js — 설정할 수 있는 사람만), 패널 탭은 보기 규칙(web/view.js),
// 실시간 문서에 내게 남은 승인 방식 때 수정본(진행 중 변경 요청)이 있으면 편집기 위 띠 '남은 내 수정본 · 변경 요청 #n · n문단' [반영] [닫기].
import { createApp, ref, reactive, computed, provide, inject, watch, onMounted, onBeforeUnmount, nextTick, markRaw } from '/vendor/vue.esm-browser.prod.js';
import { createDepartureSaves } from './departure-saves.js';
import { state, api, toast, toasts, toastError, fmt, isTyping, clip, kindLabel, roleLabel, josa, versionTip, milestoneAt, workEnv, docWorkEnv, agentEnvName, personalEnvName, presets, NO_AI_TIP, CONNECT_HELP, copyText } from './util.js';
import { quickPrompt } from './menumodel.js';
import { createDocStore } from './store.js';
import { isMobileDevice } from './mobile-settings.js';
import { mountEditor } from './editor.js';
import { startClientLog } from './client-log.js';
import { FloatWin, Composer, EditPopover, MemoEditor, InlineConfirm, openCr as openCrIn, requestGlance, askAiLabel, ASK_AI_TIP } from './ui.js';
import { loadTour, saveTour, clearTour, flushTour } from './tutorial.js';
import { TutorialMenu } from './tutorial-menu.js';
import { prepareTutorialEntry } from './tutorial-entry.js';
import { consumeWelcomeIntent } from './onboarding-model.js';
import { nextTutorialId } from './tutorial-navigation.js';
import { PANEL_TABS, panelTabs } from './panels.js';
import { ReviewRail } from './rail.js';
import { addHunkThread, addThreadByHid, hunkKeys, crCounts, crChipText } from './crs.js';
import { paragraphGeo, memoRange, covers } from './annotations.js';
import { SettingsDialog } from './settings.js';
import { liveChip, exportTip, READONLY_TIP, VIEW_LABEL, PANEL, readPanel, writePanel, clampPanelW, clampPanelH, panelHeightFrom, panelWidthFrom, marginBox, railVisible, readMemoPos, writeMemoPos } from './view.js';
import { connectionUrls } from './connections.js';
import { HelpDialog, openHelp } from './help-dialog.js';
import { AdminTokenNotice, shouldShowTokenNotice } from './admin-token-notice.js';
import { AdminServerPanel } from './admin.js';
import { PersonalAiPanel, AiRunPanel } from './personal-ai.js';
import { OrchestrationPanel } from './orchestration.js';
import { DriveTab } from './drive.js';
import { SideSplitter, useSideWidth } from './side-splitter.js';
import { ICON } from './icons.js';
import { LocalFoldersDialog, ReviewServersDialog, ReviewDialog, localTip, localLabel } from './local.js';
import { LibraryTree, AccessDialog, MoveDialog, NameDialog, PUBLIC_ROOT, parseLocKey, locKey, locExists, foldersAt, docsAt, crumbs, permsAt, docLoc, docBadge, SORTS, DEFAULT_SORT, sortOk, sortDocs, sortFolders, nextSort } from './library.js';
import { createTabs, docOf, routeOf, tabId, panelId, overlayId, officeFileName, officeFileBytes, uploadHeaders, officeTabNames } from './office-tabs.js';

/**
 * 사람용 버전 글(§9.4): 마지막 이정표 v. 옛 서버(milestone 칸 없음)면 그때의 version 이 곧 버전이고, 새 서버인데 이정표가 없으면 ''.
 * 기록 번호(내부 판 n)는 화면에 내지 않는다
 */
function verText(info) {
  if (!info) return '';
  if (info.milestone && info.milestone.v != null) return `v${info.milestone.v}`;
  return 'milestone' in info ? '' : (info.version != null ? `v${info.version}` : '');
}

const DOCLIST_POLL_MS = 30000;   // 문서 목록: 창이 보이는 동안 이 간격으로 다시 읽는다(창으로 돌아올 때도)
const EDITING_ROW_KEY = 'hwpx.office.editingRow';
const STATUS_MARKERS = {
  clean: ['수정 없음', '✓'], saved: ['저장됨', '✓'], dirty: ['저장 대기', '●'],
  saving: ['저장 중', '◷'], error: ['저장 실패', '!'], readonly: ['읽기 전용', '▣'], idle: ['준비 중', '…'],
};

// 방문한 편집기는 탭이 닫힐 때까지 살려 둔다. 화면을 옮길 때에는 배경 저장을 예약한다.
const retainedDocIds = ref([]);
const officeDocs = new Map();
let preparedExit = false;
const retainedSaves = createDepartureSaves({
  changed: ids => { retainedDocIds.value = ids; },
  failed: (id, error) => toast(`‘${retainedSaves.status(id)?.title || '문서'}’ 저장을 완료하지 못했습니다. 작성한 글은 탭에 남아 있습니다. ${error.message}`, { kind: 'warn', ms: 9000 }),
  afterPaint: callback => {
    let fired = false;
    const start = () => { if (!fired) { fired = true; clearTimeout(timer); setTimeout(callback, 0); } };
    const timer = setTimeout(start, 80);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(start));
  },
});
function libraryLocation() { return { space: 'private', owner: state.me?.name, folderId: null }; }
// #/t/<토큰>[/doc/<id>] : 토큰을 저장하고 이동(관리자가 링크로 나눠 줄 때 · 시작 파일·앱이 이 PC 설정의 관리자 토큰으로 열 때)
let viaTokenLink = false;   // 이번에 토큰 주소로 들어왔는가 — 관리자 토큰 안내(admin-token-notice.js)를 띄울지 정한다
(function tokenRoute() {
  if (globalThis.hwpxPages) return;
  const m = /^#\/t\/([^/]+)(\/.*)?$/.exec(location.hash || '');
  if (m) { viaTokenLink = true; const t = decodeURIComponent(m[1]); try { localStorage.setItem('hwpx.token', t); } catch { /* 저장 불가 */ } state.token = t; location.hash = m[2] ? `#${m[2]}` : '#/'; state.route = location.hash; }
})();

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

// 사용자 상태를 공개하기 전에 첫 화면을 정해 문서함·문서 화면이 먼저 그려지지 않게 한다.
async function enterApp(me, requested = state.route) {
  const welcome = consumeWelcomeIntent(location, history);
  const entry = welcome ? { route: welcome === 'tutorial' && me?.tutorial ? '#/tutorial' : requested } : await prepareTutorialEntry(me, requested, api);
  const route = entry.route;
  if (location.hash !== route) history.replaceState(null, '', route);
  state.route = route;
  state.tutorialIntroDocId = entry.introDocId || null;
  state.me = me;
  startClientLog(me);
}

// ───────── 로그인 ─────────
const Login = {
  template: `<div class="entry-page">
    <header class="entry-header"><div class="entry-shell entry-header-inner">
      <a class="entry-brand" href="/?teaser=0"><img src="/icons/icon-128.png?v=20261118" width="32" height="32" alt=""><span>hwpx<span class="brand-dot">.</span>cowork</span></a>
      <nav aria-label="시작 도구"><a href="https://github.com/nagmint12/hwpxcowork/releases/latest">다운로드</a><a href="/help.html#start" target="_blank" rel="noopener" data-testid="help-login">사용 설명서</a></nav>
    </div></header>
    <main class="entry-shell entry-main">
      <section class="entry-intro">
        <h1>HWPX 공동 검토</h1>
        <p>HWPX 문서를 함께 편집하고 변경 내용과 제안을 검토하세요.</p>
        <div class="entry-actions"><a class="btnlike entry-start" href="/onboarding.html?next=%2F%3Fteaser%3D0" data-testid="onboarding-replay">나에게 맞게 시작하기 <span aria-hidden="true">→</span></a>
        <a class="entry-video" href="/teaser/?intro=1&next=%2F%3Fteaser%3D0" data-testid="intro-replay">소개 영상</a></div>
      </section>
      <section class="login" aria-labelledby="login-title">
        <h2 id="login-title">문서함에 들어가기</h2>
        <p class="login-lead">관리자에게 받은 접속 토큰을 입력하세요.</p>
        <form @submit.prevent="go">
          <label for="login-token">접속 토큰</label>
          <input id="login-token" v-model="token" aria-label="접속 토큰" autocapitalize="off" spellcheck="false" :aria-invalid="err ? 'true' : null" :aria-describedby="err ? 'login-error' : null"/>
          <p id="login-error" class="err" v-if="err" role="alert">{{ err }}</p>
          <button type="submit" class="primary" :disabled="busy">{{ busy ? '여는 중…' : '들어가기' }}</button>
        </form>
        <div v-if="selfIssue" class="login-issue" data-testid="login-self-issue">
          <div v-if="issued" class="login-issued" role="alert" data-testid="login-issued"><b>{{ issued.name }} 님의 접속 토큰</b>
            <code data-testid="login-issued-token">{{ issued.token }}</code>
            <p>이 토큰은 지금 한 번만 보입니다. 복사해 두세요.</p>
            <div class="row"><button type="button" class="small" data-testid="login-issued-copy" @click="copyIssued">{{ copied ? '복사됨' : '복사' }}</button>
              <button type="button" class="primary small" data-testid="login-issued-enter" @click="enterIssued">이 토큰으로 들어가기</button></div></div>
          <button v-else-if="!issuing" type="button" class="linklike" data-testid="login-self-issue-open" @click="issuing = true; issueErr = ''">개인 토큰 발급받기</button>
          <form v-else @submit.prevent="issue" data-testid="login-self-issue-form">
            <label for="login-issue-name">이름</label>
            <input id="login-issue-name" v-model="issueName" maxlength="40" autocomplete="name" title="문서에 작성자로 보이는 이름입니다" :aria-invalid="issueErr ? 'true' : null" :aria-describedby="issueErr ? 'login-issue-error' : null" data-testid="login-self-issue-name"/>
            <p id="login-issue-error" class="err" v-if="issueErr" role="alert">{{ issueErr }}</p>
            <div class="row"><button type="submit" class="primary" :disabled="issueBusy || !issueName.trim()" data-testid="login-self-issue-submit">{{ issueBusy ? '발급하는 중…' : '발급받기' }}</button>
              <button type="button" :disabled="issueBusy" @click="issuing = false">취소</button></div>
          </form>
        </div>
        <p class="login-hint" v-if="tryHint" data-testid="login-tutorial-hint">체험용 접속 토큰 <strong>{{ tryHint }}</strong>{{ tryHint.includes('~') ? ' 중 하나를' : '을' }} 입력하세요.</p>
        <p class="login-hint" v-if="localHost" data-testid="login-local-hint">이 PC의 관리자는 앱이나 시작 파일로 바로 들어갈 수 있습니다.</p>
      </section>
    </main>
    <footer class="entry-shell entry-footer">한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고했습니다. 편집기는 rhwp(MIT)입니다.</footer>
  </div>`,
  setup() {
    const token = ref(state.token); const err = ref(''); const busy = ref(false);
    // 체험 토큰 안내: 서버가 알려 준 글(/api/config tutorialLogin — 체험 계정이 없으면 null, 2026-11-17).
    // 그 칸을 모르는 옛 서버(다시 띄우기 전)는 예전 글 그대로
    const tryHint = computed(() => (state.config && Object.hasOwn(state.config, 'tutorialLogin') ? state.config.tutorialLogin || '' : 'test1 ~ test100'));
    async function go() {
      if (busy.value) return;
      busy.value = true; err.value = ''; state.token = token.value.trim();
      try { const me = await api('/api/me'); await enterApp(me, '#/'); try { localStorage.setItem('hwpx.token', state.token); } catch { /* ignore */ } }
      catch (e) { err.value = e.status === 401 ? '토큰이 올바르지 않습니다' : `화면을 열지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    // 이 PC 에서 연 화면(localhost): 시작 파일·앱은 설정 파일의 관리자 토큰으로 자동 로그인한다는 것을 알린다
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    // 개인 토큰 스스로 발급(관리자가 [기능 설정]에서 켰을 때만 — /api/config selfIssue, 2026-11-18). 이름만 보내고 토큰은 서버가 만든다.
    // 토큰은 이 응답에 한 번만 오므로 복사하거나 바로 들어가게 한다
    const selfIssue = computed(() => state.config?.selfIssue === true);
    const issuing = ref(false); const issueName = ref(''); const issueErr = ref(''); const issueBusy = ref(false); const issued = ref(null); const copied = ref(false);
    async function issue() {
      if (issueBusy.value || !issueName.value.trim()) return;
      issueBusy.value = true; issueErr.value = '';
      try { issued.value = (await api('/api/self-token', { method: 'POST', body: { name: issueName.value.trim() } })).issued; issuing.value = false; copied.value = false; }
      catch (e) { issueErr.value = e.message || '발급하지 못했습니다'; }
      finally { issueBusy.value = false; }
    }
    async function copyIssued() { copied.value = await copyText(issued.value.token); }
    function enterIssued() { token.value = issued.value.token; go(); }
    return { token, err, busy, go, tryHint, localHost, selfIssue, issuing, issueName, issueErr, issueBusy, issued, copied, issue, copyIssued, enterIssued };
  },
};

// ───────── 문서 목록(문서함 — docs/LIBRARY_SPEC.md §4) ─────────
// 왼쪽 문서함 나무(공용 · 개인 · 공유받은) | 오른쪽 위치 줄 · [새 폴더] [올리기] [권한] · 폴더와 문서 목록. 찾기 칸에 글을 넣으면 보이는 문서 전부에서 찾는다.
// 지금 자리는 이 브라우저에 기억한다(hwpx.lib.loc). 폴더·문서 행의 [옮기기]·[권한]·[삭제]는 그럴 권한이 있을 때만 보인다.
const LOC_KEY = 'hwpx.lib.loc';
const LIB_SIDE_W = { min: 180, max: 520 };   // 문서함 나무 폭 범위(px) — 기본 240 은 library.css
const DocList = {
  emits: ['open', 'logout'],
  components: { PersonalAiPanel, AiRunPanel, OrchestrationPanel, DriveTab, LibraryTree, AccessDialog, MoveDialog, NameDialog, LocalFoldersDialog, ReviewServersDialog, ReviewDialog, SideSplitter },
  template: `<div class="listpage">
    <header class="topbar listbar"><div class="listbar-inner">
      <div class="listbar-identity"><a class="entry-brand" href="#/"><img src="/icons/icon-128.png?v=20261118" width="32" height="32" alt=""><span>hwpx<span class="brand-dot">.</span>cowork</span></a>
        <span class="muted me-role" :data-role="me.role">{{ me.name }} · {{ roleLabel(me.role) }}</span></div>
      <nav class="listbar-nav" aria-label="문서함 메뉴">
        <a v-if="me.role==='admin' && !me.browserPersonal" class="btnlike small admin-nav" href="#/admin" data-testid="admin-list">관리자</a>
        <a v-if="me.tutorial" class="btnlike small tutorial-nav" href="#/tutorial" data-testid="tutorial-nav">튜토리얼</a>
        <a class="btnlike small" href="/onboarding.html?next=%2F%3Fteaser%3D0" data-testid="onboarding-list">시작 안내</a>
        <a class="btnlike help-link" href="/help.html#start" target="_blank" rel="noopener" data-testid="help-list">사용 설명서</a>
        <button v-if="!me.browserPersonal" class="small" @click="logout">나가기</button>
      </nav></div></header>
    <div class="libpage" :class="{'drive-mode':showDrive}" :style="sideW != null ? { '--lib-side-w': sideW + 'px' } : null">
      <aside class="libside"><LibraryTree v-if="lib" :lib="lib" :cur="cur" :me="me" :drive-active="showDrive" @go="goLibrary" @drive="showDrive=true"/></aside>
      <SideSplitter class="lib-splitter" v-model="sideW" :min="SIDE_W.min" :max="SIDE_W.max" :main-min="420" label="문서함 나무 폭 조절" data-testid="lib-splitter" @commit="saveSideW"/>
      <div class="doclist">
        <section v-if="showDrive" class="list-drive"><DriveTab :library="lib" :library-location="cur" @imported="driveImported"/></section>
        <template v-else>
        <h1 class="lib-title">문서함</h1>
        <p v-if="me.browserPersonal" class="pages-storage-note">여기서 열거나 만든 문서는 이 기기의 브라우저에 저장됩니다. 사이트 데이터를 지우면 문서함도 비워집니다. 편집본을 파일로 보관하려면 ‘한글로 저장’을 누르세요.</p>
        <div class="lib-head">
          <nav class="lib-crumbs" aria-label="위치"><template v-for="(c, i) in crumbList" :key="i"><span v-if="i" class="muted">›</span><a href="#/" :class="{ cur: i === crumbList.length - 1 }" @click.prevent="go(c.loc)">{{ c.label }}</a></template></nav>
          <span class="spacer"></span>
          <select class="lib-sort" v-model="sort" aria-label="정렬" title="문서 정렬(폴더는 늘 위에 이름순)" data-testid="lib-sort"><option v-for="o in SORTS" :key="o.key" :value="o.key">{{ o.label }}</option></select>
          <input class="lib-find" type="search" v-model="query" placeholder="문서 찾기" aria-label="문서 찾기" data-testid="lib-find"/>
        </div>
        <div class="row lib-tools">
          <button class="small" data-testid="lib-newfolder" :disabled="!can('write')" :title="can('write') ? '이 자리에 폴더를 만듭니다' : '이 자리에 폴더를 만들 권한이 없습니다'" @click="dlg = { type: 'name', mode: 'new' }"><span class="ic" v-html="ICON.folder"></span><span class="toolbar-label">새 폴더</span></button>
          <label class="btnlike small primary" :class="{ disabled: !can('write'), busy: !!uploading }" :aria-busy="uploading ? 'true' : 'false'" :title="uploading ? uploading.name + ' 올리는 중' : can('write') ? '이 자리에 HWPX 를 올립니다' : '이 자리에 올릴 권한이 없습니다'" data-testid="lib-upload">
            <input type="file" :accept="me.browserPersonal ? '.hwpx,.hwp' : '.hwpx'" multiple style="display:none" :disabled="!can('write') || !!uploading" @change="upload"/><template v-if="uploading"><span class="spin" aria-hidden="true"></span><span class="toolbar-label">올리는 중 {{ uploading.n }}/{{ uploading.total }}</span></template><template v-else><span class="ic" aria-hidden="true" v-html="ICON.plus"></span><span class="toolbar-label">HWPX 올리기</span></template></label>
          <button class="small" data-testid="lib-newdoc" :disabled="!can('write')" :title="can('write') ? '이 자리에 빈 한글 문서를 만들어 엽니다' : '이 자리에 문서를 만들 권한이 없습니다'" @click="dlg = { type: 'name', mode: 'newdoc' }"><span class="ic" v-html="ICON.edit"></span><span class="toolbar-label">새 문서로 시작</span></button>
          <button class="small" v-if="curAccess" data-testid="lib-access" :title="curAccess.tip" @click="dlg = { type: 'access', target: curAccess.target }"><span class="ic" v-html="ICON.people"></span><span class="toolbar-label">권한</span></button>
          <template v-if="lib && lib.local && lib.local.canLink">
            <button class="small" data-testid="lib-local" title="이 PC 의 폴더를 개인 문서함에 연결합니다 — 그 폴더의 HWPX 를 열어 고치면 그 파일에 저장됩니다" @click="dlg = { type: 'local' }"><span class="ic" v-html="ICON.pc"></span><span class="toolbar-label">PC 폴더 연결</span></button>
            <button class="small" data-testid="lib-remotes" title="여럿이 모여 검토할 서버(주소 + 그 서버의 내 토큰)" @click="dlg = { type: 'remotes' }"><span class="ic" v-html="ICON.people"></span><span class="toolbar-label">검토 서버</span></button>
          </template>
          <span class="muted lib-note" v-if="placeNote" :title="placeNote.tip">{{ placeNote.text }}</span>
        </div>
        <div class="lib-table-wrap"><table class="libtable"><thead><tr><th class="sortable" :aria-sort="ariaSort('name')" title="이름순으로 정렬(다시 누르면 반대로)" data-sort="name" @click="sortBy('name')">문서<span class="sort-ic" v-if="sortField === 'name'">{{ sortArrow }}</span></th><th>버전</th><th class="doc-props">제안(대기/적용)</th><th class="doc-reqs">AI 작업 대기</th><th class="sortable" :aria-sort="ariaSort('updated')" title="마지막 수정순으로 정렬(다시 누르면 반대로)" data-sort="updated" @click="sortBy('updated')">마지막 수정<span class="sort-ic" v-if="sortField === 'updated'">{{ sortArrow }}</span></th><th></th></tr></thead>
        <tbody>
          <tr class="folder" v-for="f in subfolders" :key="f.id" :data-folder="f.id" @click="go(folderLoc(f))">
            <td class="lib-name" colspan="4"><span class="ic lib-fic" v-html="ICON.folder"></span><b>{{ f.name }}</b><span class="lib-badge pc" v-if="f.local && f.local.root" :title="linkTip(f)"><span class="ic" v-html="ICON.pc"></span>PC</span><span class="muted" v-if="f.inherit === false" title="이 폴더는 권한을 직접 정했습니다"> · <span class="ic" v-html="ICON.people"></span></span></td>
            <td class="muted folder-by">{{ f.createdBy || '' }}</td>
            <td class="lib-acts" @click.stop>
              <button class="icon" v-if="f.perms.includes('manage')" title="이름 바꾸기" aria-label="이름 바꾸기" @click="dlg = { type: 'name', mode: 'rename', folder: f }" v-html="ICON.edit"></button>
              <button class="icon" v-if="f.perms.includes('manage') && !(f.local && f.local.root)" title="옮기기" aria-label="옮기기" @click="dlg = { type: 'move', item: { kind: 'folder', id: f.id, name: f.name, loc: parentOf(f), folder: f, localOnly: !!f.local } }" v-html="ICON.move"></button>
              <button class="icon" v-if="f.perms.includes('manage')" title="권한" aria-label="권한" @click="dlg = { type: 'access', target: folderTarget(f) }" v-html="ICON.people"></button>
              <button class="icon" v-if="f.perms.includes('manage') && !(f.local && f.local.root)" title="폴더 삭제(비어 있어야)" aria-label="폴더 삭제" @click="removeFolder(f)" v-html="ICON.trash"></button>
              <button class="icon" v-if="f.local && f.local.root && lib.local && lib.local.canLink" title="연결 끊기 — PC 의 파일은 그대로 남습니다" aria-label="연결 끊기" data-testid="local-unlink" @click="unlinkFolder(f)" v-html="ICON.x"></button></td></tr>
          <tr class="doc" v-for="d in shownDocs" :key="d.id" :data-doc="d.id" :class="{selected:selectedDoc===d.id}" :aria-selected="selectedDoc===d.id" tabindex="0" @click="selectedDoc=d.id" @dblclick="open(d)" @keydown.enter.self.prevent="open(d)" title="제목을 누르거나 두 번 클릭·Enter로 문서 열기">
            <td class="lib-name"><a class="doc-link" :href="'#/doc/' + d.id" data-testid="doc-open-title" title="문서 열기" @click.stop="openLink($event, d)"><b>{{ d.title }}</b></a><span class="lib-badge" v-if="badge(d)" :title="badge(d).title"><span class="ic" v-html="ICON[badge(d).icon]"></span>{{ badge(d).text }}</span><span class="lib-badge pc" v-if="d.local" :class="'st-' + d.local.state" :title="localTip(d.local)" data-testid="doc-pc"><span class="ic" v-html="ICON.pc"></span>{{ localLabel(d.local) }}</span><span class="lib-badge rv" v-if="d.review" :title="reviewTip(d)" data-testid="doc-review"><span class="ic" v-html="ICON.send"></span>{{ d.review.server }}</span>
              <div class="muted">{{ d.fileName }} · {{ d.createdBy }}<template v-if="sortField === 'created' && d.createdAt"> · {{ fmt(d.createdAt) }} 올림</template><template v-if="query.trim()"> · {{ placeOf(d) }}</template></div></td>
            <td class="doc-ver" :title="verTip(d)">{{ verText(d) }}</td><td class="doc-props">{{ d.proposals.pending }} / {{ d.proposals.applied }}</td><td class="doc-reqs">{{ d.requests }}</td><td class="doc-updated" title="마지막 수정">{{ fmt(d.updatedAt) }}</td>
            <td class="lib-acts" @click.stop>
              <!-- 열기는 문서 그림, 이름 바꾸기는 연필(폴더 줄과 같은 그림) — 2026-11-17: 둘 다 연필이라 구분되지 않았다 -->
              <button class="icon" title="문서 열기" aria-label="문서 열기" @click="open(d)" v-html="ICON.file"></button>
              <button class="icon" v-if="canRename(d)" title="이름 바꾸기" aria-label="문서 이름 바꾸기" data-testid="doc-rename" @click="dlg = { type: 'name', mode: 'docrename', doc: d }" v-html="ICON.edit"></button>
              <button class="icon" v-if="lib.local && lib.local.canLink && has(d, 'manage')" title="함께 검토 — 검토 서버에 보내고 검토본을 가져옵니다" aria-label="함께 검토" data-testid="doc-review-open" @click="dlg = { type: 'review', doc: d }" v-html="ICON.send"></button>
              <button class="icon" v-if="has(d, 'manage')" title="옮기기" aria-label="옮기기" @click="dlg = { type: 'move', item: { kind: 'doc', id: d.id, name: d.title, loc: locOfDoc(d), localOnly: !!d.local } }" v-html="ICON.move"></button>
              <button class="icon" v-if="has(d, 'manage')" title="권한" aria-label="권한" @click="dlg = { type: 'access', target: docTarget(d) }" v-html="ICON.people"></button>
              <button class="icon" v-if="has(d, 'delete')" title="삭제" aria-label="삭제" @click="remove(d)" v-html="ICON.trash"></button></td></tr>
          <tr class="lib-empty" v-if="!subfolders.length && !shownDocs.length"><td colspan="6" class="muted">{{ query.trim() ? '찾는 문서가 없습니다' : loaded ? (can('write') ? 'HWPX를 올리거나 새 문서를 만들어 보세요.' : '문서가 없습니다') : '읽는 중…' }}</td></tr></tbody></table></div>
        <section v-if="!me.browserPersonal" class="lib-ai" aria-labelledby="lib-ai-title">
          <h2 id="lib-ai-title">AI 설정</h2>
          <details class="list-connections" v-if="config" data-testid="list-connections" @toggle="onConnToggle"><summary>AI 연결 <span class="muted" v-if="connSummary" :title="connTip" data-testid="list-conn-state">— {{ connSummary }}</span></summary>
            <p v-if="personalLine">{{ personalLine }}</p>
            <ol class="ai-ways" data-testid="ai-ways">
              <li data-way="subscription" :title="WAY_TIPS.subscription"><b>내 PC의 구독 AI</b> — Codex·Claude Code 실행기 <a href="/help.html#agents" target="_blank" rel="noopener">설정 방법</a></li>
              <li v-if="portless"><b>로컬 AI 클라이언트</b> · 앱의 [개인 연결 → AI 앱의 MCP 설정 복사]에서 연결합니다.</li>
              <li v-else data-way="chatgpt-app" :title="WAY_TIPS.app"><b>ChatGPT 앱</b> — MCP 주소 <code>{{ urls.mcpUrl }}</code> <a href="/help.html#chatgpt-oauth" target="_blank" rel="noopener">설정 방법</a></li>
              <li data-way="api-key" :title="WAY_TIPS.key"><b>내 AI 키</b> <span class="muted">· 사용료 별도</span><span v-if="keyLine"> — {{ keyLine }}</span></li>
            </ol>
            <p v-if="portless">연결 방식 · 이 PC에서 포트 없이 편집</p>
            <template v-else><p>현재 주소 <code>{{ urls.currentWebUrl }}</code></p>
            <p>공유 주소 <code>{{ urls.sharedWebUrl }}</code><span v-if="urls.localOnly" class="muted"> · 이 PC 전용</span></p></template>
            <p><a href="/help.html#ai" target="_blank" rel="noopener">연결 설명서</a></p>
          </details>
          <AiRunPanel/>
          <PersonalAiPanel/>
          <OrchestrationPanel/>
        </section>
        </template>
      </div>
    </div>
    <NameDialog v-if="dlg && dlg.type === 'name'" v-bind="nameDlg" @close="dlg = null" @submit="saveName"/>
    <AccessDialog v-if="dlg && dlg.type === 'access'" :target="dlg.target" :me="me" @close="dlg = null" @saved="load({ quiet: true })"/>
    <MoveDialog v-if="dlg && dlg.type === 'move'" :lib="lib" :me="me" :item="dlg.item" @close="dlg = null" @saved="load({ quiet: true })"/>
    <LocalFoldersDialog v-if="dlg && dlg.type === 'local'" :local="lib.local" @close="dlg = null" @changed="localChanged"/>
    <ReviewServersDialog v-if="dlg && dlg.type === 'remotes'" :local="lib.local" @close="dlg = null" @changed="localChanged"/>
    <ReviewDialog v-if="dlg && dlg.type === 'review'" :doc="dlg.doc" :local="lib.local" @close="dlg = null" @changed="localChanged" @saved="load({ quiet: true })"/>
  </div>`,
  setup(_, { expose, emit }) {
    const me = state.me;
    const lib = ref(null); const loaded = ref(false);
    const sectionKey = 'hwpx.lib.section:' + me.name;
    const readSection = () => { try { return sessionStorage.getItem(sectionKey) === 'drive'; } catch { return false; } };
    const showDrive = ref(readSection());
    // 왼쪽 나무 폭(web/side-splitter.js — 경계선을 끌어 바꾸고 이 브라우저에 기억, null = 기본 240px)
    const { width: sideW, save: saveSideW } = useSideWidth('hwpx.lib.sideW', LIB_SIDE_W);
    const selectedDoc = ref('');
    watch(showDrive, value => { try { sessionStorage.setItem(sectionKey, value ? 'drive' : 'library'); } catch { /* 저장 못 함 */ } });
    const query = ref('');
    const dlg = ref(null);
    const readLoc = () => { try { return parseLocKey(localStorage.getItem(LOC_KEY)); } catch { return { ...PUBLIC_ROOT }; } };
    const cur = ref(readLoc());
    // 개인용 앱(PC 폴더 연결): 기억해 둔 자리가 없으면 처음에 연결한 PC 폴더를 연다
    let firstVisit = (() => { try { return localStorage.getItem(LOC_KEY) == null; } catch { return false; } })();
    const linkLoc = (l) => ({ space: 'private', owner: l.owner, folderId: l.folderId });
    const urls = computed(() => connectionUrls({ browserOrigin: location.origin, publicUrl: state.config?.publicUrl }));
    // 여러 번 겹쳐 읽어도 마지막에 부른 것만 쓴다(창으로 돌아옴·30초마다·올리기 뒤가 겹칠 수 있다). quiet: 실패를 알리지 않음(저절로 다시 읽기)
    let seq = 0;
    async function load({ quiet = false } = {}) {
      const my = ++seq;
      try {
        const v = await api('/api/library');
        if (my !== seq) return;
        lib.value = v; loaded.value = true;
        if (firstVisit && v.local?.links?.length) go(linkLoc(v.local.links[0]));
        firstVisit = false;
        if (!locExists(v, cur.value, me)) go({ ...PUBLIC_ROOT });   // 지운 폴더·끝난 공유를 기억하고 있었으면 공용 맨 위로
      } catch (e) { if (!quiet && my === seq) toastError(e, '문서 목록을 읽지 못했습니다: '); }
    }
    function go(loc) {
      cur.value = { space: loc.space, owner: loc.space === 'private' ? loc.owner : null, folderId: loc.folderId || null };
      query.value = '';
      selectedDoc.value = '';
      try { localStorage.setItem(LOC_KEY, locKey(cur.value)); } catch { /* 저장 못 함 */ }
    }
    function goLibrary(loc) { showDrive.value = false; go(loc); }
    const folderIds = computed(() => new Set((lib.value?.folders || []).map((f) => f.id)));
    async function driveImported(doc){go({space:doc.space,owner:doc.spaceOwner||null,folderId:doc.folderId||null});await load({quiet:true});}
    // 정렬(이 브라우저에 기억): 고르기 상자 또는 표 머리(문서·마지막 수정)를 눌러 바꾼다
    const SORT_KEY = 'hwpx.lib.sort';
    const sort = ref((() => { try { const v = localStorage.getItem(SORT_KEY); return sortOk(v) ? v : DEFAULT_SORT; } catch { return DEFAULT_SORT; } })());
    watch(sort, (v) => { try { localStorage.setItem(SORT_KEY, v); } catch { /* 저장 못 함 */ } });
    const sortField = computed(() => sort.value.split('-')[0]);
    const sortArrow = computed(() => (sort.value.endsWith('-asc') ? '▲' : '▼'));
    const sortBy = (field) => { sort.value = nextSort(sort.value, field); };
    const ariaSort = (field) => (sortField.value === field ? (sort.value.endsWith('-asc') ? 'ascending' : 'descending') : 'none');
    const subfolders = computed(() => (query.value.trim() ? [] : sortFolders(foldersAt(lib.value, cur.value), sort.value)));
    const shownDocs = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (q) return sortDocs((lib.value?.docs || []).filter((d) => `${d.title} ${d.fileName}`.toLowerCase().includes(q)), sort.value);
      return sortDocs(docsAt(lib.value, cur.value), sort.value);
    });
    const crumbList = computed(() => crumbs(lib.value, cur.value, me));
    const curPerms = computed(() => permsAt(lib.value, cur.value, me));
    const can = (p) => curPerms.value.includes(p);
    const has = (d, p) => (d.perms || []).includes(p);
    const locOfDoc = (d) => docLoc(d, folderIds.value);
    const parentOf = (f) => ({ space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.parentId && folderIds.value.has(f.parentId) ? f.parentId : null });
    const placeOf = (d) => crumbs(lib.value, locOfDoc(d), me).map((c) => c.label).join(' › ');
    const badge = (d) => docBadge(d, me, { searching: !!query.value.trim() });
    const folderTarget = (f) => ({ kind: 'folder', id: f.id, name: f.name, space: f.space, owner: f.owner, inherit: f.inherit, acl: f.acl, effective: f.effective });
    function docTarget(d) {
      const l = locOfDoc(d);
      const folder = l.folderId ? (lib.value?.folders || []).find((f) => f.id === l.folderId) || null : null;
      const rootAcl = l.space === 'public' ? lib.value?.publicRoot?.acl || null : [];
      return { kind: 'doc', id: d.id, name: d.title, space: l.space, owner: l.owner, inherit: !d.access?.custom, acl: d.access?.acl || [], docFolder: folder, rootAcl };
    }
    // 지금 자리의 [권한]: 폴더는 관리 권한이 있을 때, 공용 맨 위는 관리자(맨 위 관리 권한), 개인 맨 위는 없음(폴더·문서마다 공유)
    const curAccess = computed(() => {
      const c = cur.value;
      if (c.folderId) {
        const f = (lib.value?.folders || []).find((x) => x.id === c.folderId);
        return f?.perms.includes('manage') ? { target: folderTarget(f), tip: '이 폴더에 누가 무엇을 할 수 있는지' } : null;
      }
      if (c.space === 'public' && can('manage')) return { target: { kind: 'root', name: '공용 문서함', space: 'public', acl: lib.value?.publicRoot?.acl || [] }, tip: '공용 문서함 맨 위 권한(따름으로 둔 폴더도 이것을 씁니다)' };
      return null;
    });
    // 자리 안내(한 줄): 개인 문서함 맨 위 · 남의 문서함
    const placeNote = computed(() => {
      const c = cur.value;
      if (c.space !== 'private' || c.folderId) return null;
      if (c.owner === me.name) return { text: '나만 봅니다', tip: '공유하려면 폴더나 문서의 권한에서 사람을 더하세요. 관리자는 언제나 볼 수 있습니다.' };
      return { text: `${c.owner} 님이 공유한 것`, tip: '이 사람의 개인 문서함 중 내게 공유된 폴더·문서만 보입니다' };
    });
    // 올리는 동안 단추에 '올리는 중 n/m'(2026-11-17: 여러 파일을 올리는 동안 표시가 없고 단추가 다시 눌려 같은 파일을 또 올릴 수 있었다)
    const uploading = ref(null);   // { n, total, name } | null
    async function upload(e) {
      const files = [...(e.target.files || [])]; e.target.value = '';
      if (!files.length || uploading.value) return;
      const c = cur.value;
      const where = c.folderId ? { 'x-folder-id': c.folderId } : { 'x-space': c.space, ...(c.space === 'private' ? { 'x-space-owner': encodeURIComponent(c.owner || '') } : {}) };
      let done = 0;
      try {
        for (const [i, f] of files.entries()) {
          uploading.value = { n: i + 1, total: files.length, name: f.name };
          try { await api('/api/docs', { method: 'POST', body: await f.arrayBuffer(), raw: true, headers: { 'x-file-name': encodeURIComponent(f.name), ...where } }); done++; } catch (err) { toastError(err, `${f.name}: `); }
        }
      } finally { uploading.value = null; }
      if (done) toast(done > 1 ? `${done}개 올렸습니다` : '올렸습니다');
      await load();
    }
    // 문서 이름은 수정 권한(편집) 또는 관리 권한이 있으면 바꾼다(서버 renameDocument 와 같은 기준)
    const canRename = (d) => !!d.canEdit || !!d.canConfigure;
    // 이름 창: 새 폴더 · 폴더 이름 바꾸기 · 새 문서 · 문서 이름 바꾸기
    const nameDlg = computed(() => {
      const x = dlg.value || {};
      if (x.mode === 'newdoc') return { title: '새 문서로 시작', action: '만들기', label: '문서 이름', maxlength: 100, value: '새 문서' };
      if (x.mode === 'docrename') return { title: '문서 이름 바꾸기', action: '바꾸기', label: '문서 이름', maxlength: 100, value: x.doc.title };
      return { title: x.mode === 'new' ? '새 폴더' : '이름 바꾸기', action: x.mode === 'new' ? '만들기' : '바꾸기', value: x.folder ? x.folder.name : '' };
    });
    // 실패하면 창 안에 알린다(NameDialog 가 done.reject 를 받는다). 새 문서는 만든 뒤 곧바로 연다
    async function saveName(name, done) {
      try {
        const c = cur.value; const x = dlg.value || {};
        if (x.mode === 'newdoc') {
          const doc = await api('/api/library/docs', { method: 'POST', body: { title: name, space: c.space, ...(c.space === 'private' ? { owner: c.owner } : {}), ...(c.folderId ? { folderId: c.folderId } : {}) } });
          done.resolve();
          if (doc.title !== name) toast(`같은 이름이 있어 '${doc.title}'(으)로 만들었습니다`);
          open(doc);
          return;
        }
        if (x.mode === 'docrename') await api(`/api/docs/${encodeURIComponent(x.doc.id)}`, { method: 'PATCH', body: { title: name } });
        else if (x.mode === 'rename') await api(`/api/folders/${encodeURIComponent(x.folder.id)}`, { method: 'PATCH', body: { name } });
        else await api('/api/folders', { method: 'POST', body: { name, parentId: c.folderId, space: c.space } });
        done.resolve();
        await load({ quiet: true });
      } catch (e) { done.reject(e); }
    }
    async function removeFolder(f) {
      if (!confirm(`폴더 ${josaQuoted(f.name)} 지울까요?`)) return;
      try { await api(`/api/folders/${encodeURIComponent(f.id)}`, { method: 'DELETE' }); toast('폴더를 지웠습니다'); } catch (err) { toastError(err); }
      await load({ quiet: true });
    }
    // PC 폴더 연결(web/local.js): 연결·검토 서버가 바뀌면 문서함을 다시 읽고, 새로 연결했으면 그 폴더로 간다
    async function localChanged(local, link) {
      if (lib.value) lib.value = { ...lib.value, local };
      await load({ quiet: true });
      if (link) { go(linkLoc(link)); dlg.value = null; }
    }
    const linkOfFolder = (f) => (lib.value?.local?.links || []).find((l) => l.id === f.local?.link) || null;
    const linkTip = (f) => { const l = linkOfFolder(f); return l ? `연결한 PC 폴더: ${l.path}${l.ok ? '' : '\n폴더가 보이지 않습니다'}` : '연결한 PC 폴더'; };
    const reviewTip = (d) => `함께 검토: ${d.review.server} 에 보냄 ${fmt(d.review.sentAt)}${d.review.fetchedAt ? ` · 검토본 가져옴 ${fmt(d.review.fetchedAt)}` : ''}`;
    async function unlinkFolder(f) {
      if (!confirm(`'${f.name}' 연결을 끊을까요?\nPC 의 파일은 그대로 남습니다.`)) return;   // josaQuoted 는 을/를을 붙여 "'보고서'를 연결을 끊을까요?"가 됐다(local.js 와 같은 글로)
      try { const out = await api(`/api/local/links/${encodeURIComponent(f.local.link)}`, { method: 'DELETE' }); toast('연결을 끊었습니다'); await localChanged(out.local, null); } catch (err) { toastError(err); }
    }
    async function remove(d) {
      if (!confirm(d.local ? `${josaQuoted(d.title)} 지울까요?\nPC 의 파일도 지웁니다(휴지통으로).` : `${josaQuoted(d.title)} 지울까요?`)) return;
      try { await api(`/api/docs/${d.id}`, { method: 'DELETE' }); } catch (err) { toastError(err); }
      await load();
    }
    function open(d) { emit('open', d); }
    function openLink(event, doc) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(doc);
    }
    function logout() { emit('logout'); }
    async function beginNewDocument() {
      if (!loaded.value) await load();
      if (!can('write')) { toast('현재 위치에 새 문서를 만들 권한이 없습니다.', { kind: 'warn' }); return; }
      showDrive.value = false;
      dlg.value = { type: 'name', mode: 'newdoc' };
    }
    expose({ beginNewDocument, refresh: () => load({ quiet: true }) });
    // 다른 사람이 올리거나 고친 문서가 보이게: 창으로 돌아올 때(focus·다시 보임)와 창이 보이는 동안 30초마다 다시 읽는다
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const onFocus = () => load({ quiet: true });
    const onVisible = () => { if (visible()) load({ quiet: true }); };
    let poll = null;
    onMounted(() => {
      load();
      loadConn();
      addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisible);
      poll = setInterval(() => { if (visible()) load({ quiet: true }); }, DOCLIST_POLL_MS);
    });
    onBeforeUnmount(() => {
      removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll); poll = null;
    });
    const verTip = (d) => (d.milestone ? versionTip(d.milestone, d.sinceMilestone).replace(/ — 이력 탭에서 보기$/, '') : '');
    // AI 연결(2026-11-13 운영 결정 — util.js 'AI 연결 차례'): ① 내 PC 의 구독 AI(기본) ② ChatGPT 앱 연결(선택) ③ 내 AI 키(선택·사용료 별도).
    // 체험 계정·관리자가 공유한 키만 따로 한 줄(personalLine). 중앙 공용 서버 AI 는 배포 전이라 켜짐·꺼짐을 보이지 않는다
    const personalLine = computed(() => { const p = state.me?.personalAi; const n = personalEnvName(p); if (p?.method === 'mcp-events') return p.active ? '튜토리얼 AI 요청은 관리자 ChatGPT가 처리합니다' : '관리자 ChatGPT의 이벤트 구독을 기다리고 있습니다'; if (p?.apiOnly) return p.active ? '체험 AI 요청은 관리자가 공유한 API로만 처리합니다' : '체험용 관리자 API 연결이 필요합니다'; if (n && p?.shared) return `내 AI 요청은 관리자가 공유한 ${n}로 처리합니다`; return ''; });
    const keyLine = computed(() => { const p = state.me?.personalAi; const n = personalEnvName(p); return n && !p?.shared && !p?.apiOnly ? `${n} 등록됨` : ''; });
    const WAY_TIPS = {
      // 2026-11-17: 실행기 bat 을 지웠다(사용자 결정) — Windows 앱 [AI → 실행기 관리…] 또는 명령줄 npm run worker
      subscription: 'Codex(먼저 codex login)·Claude Code(먼저 claude auth login) 실행기를 켜 둡니다. Windows 앱은 [AI → 실행기 관리…]에서 켭니다.\n명령으로 실행하려면 npm run worker -- --provider codex 또는 --provider claude-code. 실행기를 켜 두는 동안 기존 대기 요청과 새 요청을 자동 처리합니다.\nCodex CLI·IDE 확장에 MCP를 직접 등록한 대화는 대기열 처리를 지시해야 합니다. Claude Code 채널은 start-agent.bat에서 선택할 수 있습니다. 사용량은 각 구독의 사용 한도에서 차감됩니다',
      app: 'ChatGPT 앱의 사용자 지정 MCP에 이 주소를 넣고 OAuth로 연결합니다. 대화창에서 "대기열을 처리해 줘"라고 하면 쌓인 요청을 처리합니다(대화를 보낼 때만 처리)',
      key: '아래 \'내 AI 키\'에 API 키를 등록하면 서버가 내 키로 바로 처리합니다. 키 사용료가 따로 듭니다',
    };
    // 지금 연결 상태(/api/automation/status — 읽기만, 내 것만): 목록을 열 때·'AI 연결'을 펼칠 때 한 번씩
    const conn = ref(null);
    async function loadConn() { try { conn.value = await api('/api/automation/status'); } catch { conn.value = null; } }
    const onConnToggle = (e) => { if (e.target.open) loadConn(); };
    const connSummary = computed(() => {
      const st = conn.value; const a = st?.automatic;
      if (!a) return '';
      if (st.apiOnly) return a.available ? '● 연결됨' : '○ 연결 대기';
      if (a.method === 'channel') { const p = st.channels?.primary; return `● ${agentEnvName(p?.agent, p?.client) || '연결된 AI'}`; }
      if (a.method === 'personal') { const n = personalEnvName({ ...st.personalAi, active: true }); return `● ${n && n !== '내 AI 키' ? `${n} (내 키)` : '내 AI 키'}`; }
      if (a.available) return '● AI';
      return '○ 연결 안 됨 · 기본은 내 PC의 Codex·Claude Code';
    });
    const connTip = computed(() => { const st = conn.value; const a = st?.automatic; if (!a) return ''; return a.method == null && !st.apiOnly ? NO_AI_TIP : a.message || ''; });
    const folderLoc = (f) => ({ space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.id });
    return {
      lib, loaded, cur, query, dlg, showDrive, sideW, saveSideW, SIDE_W: LIB_SIDE_W, selectedDoc, me, config: state.config, urls, portless: !!window.hwpxDesktopEnvironment?.portless, personalLine, keyLine, WAY_TIPS, connSummary, connTip, onConnToggle, crumbList, subfolders, shownDocs, curAccess, placeNote,
      sort, sortField, sortArrow, sortBy, ariaSort, SORTS,
      go, goLibrary, can, has, badge, placeOf, locOfDoc, parentOf, folderLoc, folderTarget, docTarget, upload, uploading, saveName, nameDlg, canRename, removeFolder, remove, open, openLink, logout, load, driveImported,
      localChanged, linkTip, reviewTip, unlinkFolder, localTip, localLabel,
      fmt, roleLabel, verText, verTip, ICON,
    };
  },
};
/** '제목' + 을/를 */
const josaQuoted = (t) => josa(`'${t}'`, '을/를');

// ───────── 문서 화면(v0.3): 상단 막대 + 편집기 + 검토 레일 + 패널 ─────────

/** 패널 탭(§5.1): 검토 · 변경 요청 · AI 작업 · 변경 추적 · 첨부 · 이력 — panels.js 의 PANEL_TABS */
const TAB_DEFS = PANEL_TABS.map((t) => ({ id: t.id, label: t.label, comp: markRaw(t.comp) }));

/**
 * 셸의 답글·의견 작은 창: 메모 답글(§3.6) · 남의 수정 중에 의견(변경 요청 스레드, §3.3).
 * 쓰던 글은 창 모델(s.reply.text)에 둔다 — 보내기가 실패해도(변경 요청이 없어짐 등) 창과 글이 그대로 남는다.
 */
const QuickReply = {
  components: { FloatWin, MemoEditor },
  props: { model: Object },
  emits: ['close'],
  template: `<FloatWin :anchor="model.anchor" :width="360" :title="title" cls="popover quickreply" @close="$emit('close')">
    <div class="cmp-target" v-if="model.quote"><span class="ref" v-if="model.ref">{{ model.ref }}</span> <span class="quote">「{{ clip(model.quote, 70) }}」</span></div>
    <MemoEditor v-model="text" :placeholder="placeholder" :ok-label="okLabel" :ask-label="askLabel" :ask-tip="ASK_AI_TIP" :busy="busy" :rows="3" @save="save" @ask="ask" @cancel="$emit('close')"/>
  </FloatWin>`,
  setup(props, { emit }) {
    const d = inject('doc'); const busy = ref(false); const m = props.model;
    const text = computed({ get: () => m.text ?? '', set: (v) => { m.text = v; } });
    const title = m.kind === 'memo' ? '메모에 답글' : `변경 요청 #${m.cid}에 의견`;
    const placeholder = m.kind === 'memo' ? '답글을 적으세요 — 한글에서도 메모 안 답글로 보입니다' : '이 수정에 대한 의견을 적으세요';
    const okLabel = m.kind === 'memo' ? '답글 달기' : '의견 달기';
    // 메모 답글이고 AI 메모(의견·작업 기록·AI 제안)면 [AI에게 요청] — 같은 글을 답글로 남기고 그 AI 작업으로 이어 맡긴다
    const askLabel = computed(() => (m.kind === 'memo' ? askAiLabel(d, d.memo(m.memoId)) : ''));
    async function ask(t) {
      if (busy.value) return;
      busy.value = true;
      try { await d.askAiFromMemo(m.memoId, t); m.text = ''; emit('close'); }
      catch (e) { toastError(e, 'AI에게 보내지 못했습니다(쓴 글은 창에 남아 있습니다): '); } finally { busy.value = false; }
    }
    async function save(t) {
      if (busy.value) return;   // Ctrl+Enter 두 번 → 한 번만
      busy.value = true;
      try {
        if (m.kind === 'memo') await d.replyMemo(m.memoId, t);
        else { await draftComment(t); toast(`변경 요청 #${m.cid}에 의견을 달았습니다`); }
        m.text = '';   // 보냈다 — 닫을 때 '쓰다 만 글'로 남기지 않는다(store closeWindow)
        emit('close');
      } catch (e) { toastError(e, m.kind === 'memo' ? '답글을 달지 못했습니다(쓴 글은 창에 남아 있습니다): ' : '의견을 달지 못했습니다(쓴 글은 창에 남아 있습니다): '); } finally { busy.value = false; }
    }
    /** 덩어리 없이 그 문단(자리·인용)에 다는 변경 요청 전체 의견 */
    const general = (t) => d.addThread(m.cid, { ...(m.ref ? { ref: m.ref } : {}), ...(m.quote ? { quote: m.quote } : {}), text: t });
    /**
     * 남의 수정 중 덩어리에 의견 — 보내기 직전에 그 덩어리의 지금 hid 로(crs.js addHunkThread: 덩어리 열쇠 = 종류 + 기준 자리로 찾고,
     * NO_HUNK 면 변경 요청을 다시 읽어 한 번 더). 그래도 서버가 NO_HUNK(창을 연 뒤 작성자가 그 문단 수정을 거둠 등)로 답하면
     * 그 문단의 전체 의견({ ref, quote })으로 한 번 더 보낸다 — 실패로 끝내지 않고 쓴 글을 잃지 않게
     */
    async function draftComment(t) {
      try {
        if (m.hkey && m.hunk) return await addHunkThread(d, m.cid, m.hkey, m.hunk, t);
        if (m.hid) return await addThreadByHid(d, m.cid, m.hid, t, { ref: m.ref || null, quote: m.quote || '' });
        return await general(t);
      } catch (e) {
        if (e?.code !== 'NO_HUNK') throw e;
        return general(t);
      }
    }
    return { title, placeholder, okLabel, askLabel, ASK_AI_TIP, busy, text, save, ask, clip };
  },
};

const DocView = {
  props: { id: String, active: Boolean },
  emits: ['state', 'unavailable', 'restore'],
  components: { FloatWin, Composer, EditPopover, QuickReply, ReviewRail, SettingsDialog, InlineConfirm },
  template: `<div ref="rootEl" class="docview v3" :class="{ 'view-simple': s.view !== 'detail', 'view-detail': s.view === 'detail', 'doc-live': realtime, stacked, 'panel-min': stacked && panel.min, 'panel-folded': folded, 'panel-peek': folded && !!peek, 'fold-hint': foldHint, resizing }" :style="panelVars" data-view="v3" :data-mode="ed?.mode || ''">
    <Teleport to="#office-document-controls">
      <div v-if="active" ref="moreEl" class="office-document-tools" :data-doc-id="s.id" @keydown.esc.stop.prevent="closeMore(true)" @focusout="onMoreFocusOut">
        <button ref="statusTrigger" type="button" class="office-save-status" :class="compactStatus.cls" data-testid="draft-chip"
          :aria-expanded="moreOpen === 'status'" aria-controls="office-save-details" :aria-label="'저장 상태: ' + compactStatus.label"
          :title="[chip.text, chip.tip].filter(Boolean).join(' · ')" @click="toggleMore('status')">
          <span class="office-status-mark" aria-hidden="true">{{ compactStatus.mark }}</span><span class="office-status-caption">{{ compactStatus.label }}</span>
        </button>
        <button type="button" class="office-direct-export" data-testid="save-hangul" :disabled="saving || !s.info" :title="saveTip" @click="saveHangul">
          <span v-if="saving" class="spin dark" aria-hidden="true"></span><span v-else aria-hidden="true">↓</span><span>한글로 저장</span>
        </button>
        <button ref="actionTrigger" type="button" class="office-document-menu" data-testid="bar-more-toggle" aria-label="문서 작업" title="문서 작업"
          :aria-expanded="moreOpen === 'actions'" aria-controls="office-document-actions" @click="toggleMore('actions')">
          <span class="ic" aria-hidden="true" v-html="ICON.more"></span><span class="office-work-label">문서 작업</span>
        </button>
        <section v-if="moreOpen === 'status'" id="office-save-details" ref="popoverEl" class="office-popover" aria-labelledby="office-save-heading" tabindex="-1" data-testid="office-save-details">
          <h2 id="office-save-heading">저장 상태</h2>
          <div class="office-save-summary">
            <b>{{ chip.text }}</b>
            <p v-if="chip.tip">{{ chip.tip }}</p>
            <span v-if="s.info?.local" data-testid="pc-pill" :title="localTip(s.info.local)">{{ localLabel(s.info.local) }}</span>
            <button v-if="verLabel" type="button" data-testid="version-pill" :title="verTitle" @click="s.tab = 'history'; closeMore(true)">{{ verLabel }} · 버전 이력</button>
          </div>
          <div v-if="chip.retry || chip.keep || chip.carry" class="office-popover-actions">
            <button v-if="chip.retry" type="button" data-testid="chip-retry" :title="chip.reopen || (s.draft.stale && !liveMode) ? '서버의 지금 문서를 다시 엽니다(여기서 친 저장 안 된 글은 버림)' : '다시 저장합니다'" @click="retrySave">{{ chip.reopen || (s.draft.stale && !liveMode) ? '다시 열기' : '저장 재시도' }}</button>
            <button v-if="chip.keep" type="button" data-testid="chip-keep" title="서버의 내 수정본을 이 창의 글로 덮어씁니다" @click="keepMine">이 글로 저장</button>
            <button v-if="chip.carry" type="button" data-testid="chip-carry" :disabled="carrying" title="서버의 지금 수정본 위에 이 창에서 고친 문단을 넣습니다" @click="carryMine">내 글 옮기기</button>
          </div>
          <div v-if="!liveDoc && behind" class="office-popover-group" data-testid="behind-chip" :title="behindTip">
            <b>새 버전 있음</b><button type="button" :disabled="rebasing" @click="rebase"><span v-if="rebasing" class="spin dark"></span>최신으로 맞추기</button>
          </div>
          <p v-if="!liveDoc && s.draft.unsupported?.length" class="office-warn" :title="unsupportedTip">반영 불가 {{ s.draft.unsupported.length }}건</p>
          <div v-if="recoveryFiles.length" class="office-popover-group" aria-label="저장 접수본">
            <button v-for="copy in recoveryFiles" :key="copy.key" type="button" :title="copy.message"
              @click="d.download(d.base+'/departure-saves/'+copy.key+'/file', (s.info?.title || '문서')+'_접수본.hwpx')">저장 접수본 복구 · {{ new Date(copy.time).toLocaleTimeString('ko-KR') }}</button>
          </div>
        </section>
        <section v-else-if="moreOpen === 'actions'" id="office-document-actions" ref="popoverEl" class="office-popover" aria-labelledby="office-work-heading" tabindex="-1" data-testid="office-document-actions">
          <h2 id="office-work-heading">문서 작업</h2>
          <div class="office-popover-group">
            <button type="button" data-testid="more-save-hangul" :disabled="saving || !s.info" :title="saveTip" @click="saveHangul(); closeMore(true)">
              <span v-if="saving" class="spin dark" aria-hidden="true"></span>한글로 저장</button>
            <button v-if="canRename && titleEdit === null" ref="renameTrigger" type="button" data-testid="office-rename-document" @click="editTitle">문서 이름 바꾸기</button>
            <form v-else-if="canRename" class="office-rename" @submit.prevent="saveTitle" @keydown.esc.stop.prevent="cancelTitle">
              <label>문서 이름<input ref="titleInp" data-testid="doc-title-input" v-model="titleEdit" maxlength="100"/></label>
              <div class="office-popover-actions"><button class="primary small" type="submit">바꾸기</button><button class="small" type="button" @click="cancelTitle">취소</button></div>
            </form>
            <button v-if="s.canConfigure" type="button" data-testid="doc-settings" @click="closeMore(); s.settingsOpen = true">문서 설정</button>
          </div>
          <div class="office-popover-group" data-testid="document-view-options" aria-labelledby="office-view-heading">
            <h3 id="office-view-heading">보기</h3>
            <button type="button" :aria-pressed="tools" :disabled="!ed?.ready" data-testid="toggle-editor-tools" @click="toggleTools">편집 메뉴 및 서식 막대</button>
            <button v-if="mobileEnvironment" type="button" :disabled="!ed?.ready" data-testid="mobile-options" @click="closeMore(); openMobileOptions()">모바일 옵션</button>
            <button type="button" :aria-pressed="documentView.paragraph" :disabled="!ed?.ready" data-testid="show-paragraph-marks" @click="toggleDocumentView('view:para-mark')">문단 부호 보기<kbd>Ctrl+G,T</kbd></button>
            <button type="button" :aria-pressed="documentView.controls" :disabled="!ed?.ready" data-testid="show-control-codes" @click="toggleDocumentView('view:ctrl-mark')">조판 부호 보기<kbd>Ctrl+G,C</kbd></button>
            <button type="button" :aria-pressed="memosOn" data-testid="show-memos" @click="toggleMemos">문서 옆 메모 보기</button>
            <button type="button" :disabled="!movedMemos" data-testid="memo-pos-reset" @click="resetMemoPos">메모 제자리로</button>
            <div class="office-view-modes" role="group" aria-label="검토 표시 방식" data-testid="view-toggle">
              <button v-for="v in ['simple', 'detail']" :key="v" type="button" :data-view="v" :aria-pressed="s.view === v" @click="d.setView(v)">{{ VIEW_LABEL[v] }}</button>
            </div>
          </div>
          <div class="office-popover-group" aria-labelledby="office-review-heading">
            <h3 id="office-review-heading">검토와 공동 작업</h3>
            <template v-if="!liveDoc">
              <button v-if="s.myCr?.status==='draft'" type="button" data-testid="submit-cr" @click="closeMore(); openSubmit()">검토 요청</button>
              <button v-else-if="s.myCr?.status==='open'" type="button" data-testid="cr-chip" :title="crChipTip" @click="openCr(s.myCr.cid); closeMore(true)">{{ crChip }}</button>
            </template>
            <div v-if="leftover" class="office-leftover" data-testid="leftover-banner">
              <b>남은 내 수정본 · 변경 요청 #{{ leftover.cid }} · {{ leftover.n }}문단</b>
              <div v-if="!loConfirm" class="office-popover-actions">
                <button type="button" data-testid="leftover-merge" :disabled="loBusy || !s.canEdit" @click="mergeLeftover">반영</button>
                <button type="button" data-testid="leftover-close" :disabled="loBusy" @click="loConfirm = true">닫기</button>
              </div>
              <InlineConfirm v-else :message="loMsg" ok-label="닫기" danger :busy="loBusy" @ok="closeLeftover" @cancel="loConfirm = false"/>
            </div>
            <details class="office-participants" data-testid="presence">
              <summary>접속자 {{ present.length }}명</summary>
              <div class="wp-row" v-for="u in people" :key="u.name">
                <span class="wp-dot" :style="{ background: u.color }"></span><b>{{ u.name }}</b><span class="muted wp-me" v-if="u.me">(나{{ myRole ? ' · ' + myRole : '' }})</span><span class="muted" v-else-if="!u.present">(접속 안 함)</span>
                <div class="wp-what" v-if="u.editing"><button type="button" class="office-link" @click="go(u.editing); closeMore()">{{ u.editing }}</button> 입력 중 <span class="muted">「{{ clip(d.textOf(u.editing), 24) }}」</span></div>
                <div class="wp-what" v-for="c in u.crs" :key="c.cid"><button type="button" class="office-link" @click="openCr(c.cid); closeMore(true)">변경 요청 #{{ c.cid }}</button> {{ c.status === 'open' ? '검토 중' : '수정 중' }} · {{ c.hunkCount ?? (c.hunks || []).length }}문단</div>
                <div class="wp-what muted" v-if="!u.editing && !u.crs.length">고치는 곳 없음</div>
              </div>
              <p class="muted" v-if="!people.length">접속자가 없습니다</p>
            </details>
            <button v-if="!browserPersonal" type="button" data-testid="agent-pill" :title="agentTip" @click="openDocumentHelp(agentHelpHash)">AI 연결 <span class="office-item-value">{{ agentLabel }}</span></button>
          </div>
          <div class="office-popover-group">
            <button v-if="isAdmin && !browserPersonal" type="button" data-testid="admin-doc" @click="closeMore(); showAdmin()">관리자 설정</button>
            <button type="button" data-testid="help-doc" @click="openDocumentHelp('#review')">사용 설명서</button>
            <a v-if="stateMeTutorial" href="#/tutorial" data-testid="tutorial-doc-nav">튜토리얼</a>
            <span v-if="s.info?.tutorialSession" class="tutorial-temp-label">임시 연습 문서</span>
            <button v-if="tourOn && tourPaused" type="button" data-testid="tour-open" @click="closeMore(); openTour()">튜토리얼 계속하기</button>
            <button v-if="s.info?.tutorialSession" type="button" data-testid="tutorial-complete" :disabled="tutorialSaving" @click="completeTutorial">{{ tutorialSaving ? '저장 중…' : '완료하고 문서함에 저장' }}</button>
            <button v-if="s.info?.tutorialCompletedAt && nextCourse" type="button" data-testid="tutorial-next-course" :disabled="tutorialSaving" @click="startNextTutorial">다음 튜토리얼로 가기</button>
          </div>
        </section>
      </div>
    </Teleport>
    <div v-if="serverNotice" class="admin-server-notice" data-testid="server-restart-notice" role="status">{{ serverNotice }}</div>
    <div class="v3layout">
      <div class="editorarea">
        <div class="editorhost" ref="editorEl"></div>
        <div class="railover" v-if="railOver" data-testid="rail" :style="overStyle"><ReviewRail :col="over?.col || null"/></div>
        <div class="loadingpane muted" v-if="!ed?.ready && !ed?.previewReady && !ed?.error && !ed?.notice"><span class="spin dark"></span> {{ ed?.loading === false ? '' : '편집기를 불러오는 중…' }}</div>
        <div class="document-preview-progress" v-if="ed?.previewReady && ed?.loading && !ed?.error" role="status" aria-live="polite" data-testid="document-preview-progress"><span class="spin dark"></span><span>{{ ed.previewPageCount ? ed.previewPageCount + '쪽 · 편집 준비 중…' : '첫 ' + ed.previewPages + '쪽 미리보기 · 나머지 쪽 계산 중…' }}</span></div>
        <div class="editorlock" v-if="ed?.locked" data-testid="editor-lock" aria-live="polite"><span class="lockmsg"><span class="spin dark"></span>{{ ed.locked }}</span></div>
        <div class="banner err" v-if="ed?.error"><span>{{ ed.error }}</span><button class="small" @click="remount">다시 시도</button></div>
        <div class="banner" v-else-if="ed?.notice"><span>{{ ed.notice }}</span></div>
      </div>
      <div class="panel" ref="panelEl" :class="{ folded, peek: folded && !!peek }" data-testid="panel"
        @pointerenter="onPanelEnter" @pointerleave="onPanelLeave" @focusout="onPanelFocusOut">
        <div class="edgetabs" v-if="!stacked">
          <button class="edgetab et-ai" data-testid="edge-ai" :class="{ on: !folded || !!peek }" :aria-expanded="!folded || !!peek" :title="edgeTip"
            @click="togglePin" @pointerenter="onTabEnter" @pointerleave="onTabLeave" @dragenter="openPeek('held')"><span class="et-ic" aria-hidden="true">{{ folded ? '‹' : '›' }}</span><span class="et-label">AI 작업</span><span v-for="g in aiGlance" :key="g.ph" class="et-n" :class="'ph-' + g.ph" :data-ph="g.ph" :title="g.tip">{{ g.n }}</span></button>
          <button class="edgetab et-memo" data-testid="edge-memo" :class="{ on: memosOn }" :aria-pressed="memosOn" :title="memosOn ? '문서 옆 메모 숨기기' : '문서 옆 메모 보기'" @click="toggleMemos"><span class="et-label">메모</span></button>
        </div>
        <div class="splitter" role="separator" tabindex="0" data-testid="panel-splitter" :aria-orientation="stacked ? 'horizontal' : 'vertical'" aria-label="AI 작업 창 크기 조절"
          :aria-valuenow="stacked ? Math.round((panel.min ? 0 : panel.h) * 100) : panel.w" :title="splitTip"
          @pointerdown="startResize" @dblclick="resetPanel" @keydown="keyResize"><span class="grip" aria-hidden="true"></span></div>
        <div class="tabs" role="tablist"><button v-for="t in tabs" :key="t.id" role="tab" :data-tab="t.id" :aria-selected="curTab===t.id" :class="{active: curTab===t.id}" @click="pickTab(t.id)">{{ t.label }}<template v-if="t.glance?.length"><span v-for="g in t.glance" :key="g.ph" class="cnt" :class="'ph-' + g.ph" :data-ph="g.ph" :title="g.tip">{{ g.n }}</span></template><span v-else-if="t.count" class="cnt">{{ t.count }}</span></button></div>
        <div class="tabbody">
          <template v-for="t in tabs" :key="t.id"><component :is="t.comp" v-if="curTab===t.id"/></template>
        </div>
      </div>
    </div>
    <FloatWin v-if="s.composer" :key="s.composer.key" :anchor="s.composer.anchor" :width="452" :title="composerTitle" cls="composer-win" @close="d.closeWindow('composer')">
      <Composer :model="s.composer" @close="d.closeWindow('composer')"/></FloatWin>
    <EditPopover v-if="s.popover" :key="s.popover.key" :model="s.popover" @close="d.closeWindow('popover')"/>
    <QuickReply v-if="s.reply" :key="s.reply.key" :model="s.reply" @close="d.closeWindow('reply')"/>
    <SettingsDialog v-if="s.settingsOpen" @close="s.settingsOpen = false"/>
  </div>`,
  setup(props, { emit }) {
    const d = createDocStore(props.id, { onUnavailable: reason => emit('unavailable', props.id, reason) });
    const s = d.s;
    const rootEl = ref(null);
    const active = computed(() => props.active);
    const overlay = '#' + overlayId(props.id);
    provide('doc', d);
    provide('officeDocument', { active, overlay });

    watch(() => [s.info?.title, s.draft.dirty, s.draft.saving, s.draft.error || s.draft.stale], ([title, dirty, saving, failed]) => {
      emit('state', props.id, { ...(title ? { title } : {}), dirty, saving, failed: !!failed });
    }, { immediate: true });
    // 상단 문서 이름: 눌러서 그 자리에서 바꾼다(Enter·칸 밖 = 저장, Esc = 취소). 권한 = 수정 또는 설정(서버 renameDocument)
    const canRename = computed(() => !!s.info && (!!s.canEdit || !!s.canConfigure));
    const titleEdit = ref(null); const titleInp = ref(null); const renameTrigger = ref(null); let titleBusy = false;
    function editTitle() {
      if (!canRename.value) return;
      titleEdit.value = s.info?.title || '';
      nextTick(() => { titleInp.value?.focus(); titleInp.value?.select(); });
    }
    function cancelTitle() {
      titleEdit.value = null;
      nextTick(() => renameTrigger.value?.focus({ preventScroll: true }));
    }
    async function saveTitle() {
      if (titleEdit.value === null || titleBusy) return;
      const name = titleEdit.value.trim();
      if (!name || name === s.info?.title) { cancelTitle(); return; }
      titleBusy = true;
      try {
        const out = await api(`/api/docs/${encodeURIComponent(props.id)}`, { method: 'PATCH', body: { title: name } });
        if (s.info) s.info.title = out.title;
        cancelTitle();
        toast('이름을 바꿨습니다');
      } catch (e) { toastError(e, '이름을 바꾸지 못했습니다: '); nextTick(() => titleInp.value?.focus()); } finally { titleBusy = false; }
    }
    const automation = ref(null); const automationLoading = ref(false); const automationError = ref(false);
    provide('automation', automation);
    // 연결된 작업 환경 이름(util.workEnv — 채널 세션·내 AI 키). 중앙 공용 서버 AI 는 배포 전이라 이름을 드러내지 않는다
    const env = computed(() => docWorkEnv(s));
    // 자동 처리 상태(/api/automation/status) — 따로 줄을 두지 않고 상단 AI 알약의 설명(title)으로: 채널·내 키면 그 환경 이름으로,
    // 나머지는 서버 안내 글(이벤트 구독·'서버 AI' 를 말하지 않는다)
    const automationMessage = computed(() => {
      if (automationError.value) return '자동 처리 상태를 확인하지 못했습니다. 연결을 확인한 뒤 새로고침하세요.';
      const a = automation.value?.automatic;
      if (!a) return '자동 처리 연결을 확인하는 중입니다…';
      if (a.method === 'channel') {
        const p = automation.value.channels?.primary; const name = agentEnvName(p?.agent, p?.client) || env.value.agent || 'AI 작업 환경';
        return `${name}에 연결되어 있습니다. 새 AI 요청은 ${name}에 바로 전달되고, 결과는 AI 작업 탭에 나타납니다.`;
      }
      if (a.method === 'personal') {
        const name = personalEnvName({ ...automation.value.personalAi, active: true }) || env.value.personal;
        return `${name && name !== '내 AI 키' ? `${name}(내 AI 키)` : '내 AI 키'}로 바로 처리합니다. 사용료는 내 키에 부과됩니다. 내 PC의 Codex·Claude Code를 켜 두면 그쪽이 먼저 처리합니다(추가 비용 없음). 결과는 AI 작업 탭에 나타납니다.`;
      }
      // 연결 없음: 서버 글 대신 웹의 안내(내 PC 의 구독 AI 먼저 — util.js 'AI 연결 차례'). 체험 계정은 서버 글 그대로
      if (a.method == null && !automation.value.apiOnly) return `${NO_AI_TIP}.`;
      return a.message;
    });
    let automationPoll = null; let automationClosed = false;
    async function loadAutomation() {
      if (automationLoading.value || automationClosed) return;
      automationLoading.value = true;
      try { const value = await api('/api/automation/status'); if (!automationClosed) { automation.value = value; automationError.value = false; } }
      catch { if (!automationClosed) { automation.value = null; automationError.value = true; } }
      finally { automationLoading.value = false; }
    }
    const refreshAutomation = () => { if (props.active && document.visibilityState !== 'hidden') loadAutomation(); };
    const openAdmin = inject('openAdmin');
    const prepareOfficeRestart = inject('prepareOfficeRestart');
    const isAdmin = computed(() => state.me?.role === 'admin');
    function showAdmin() {
      if (!isAdmin.value) return;
      openAdmin({ prepareRestart: prepareOfficeRestart });
    }
    watch(active, active => {
      if (active) window.__doc = d;
      else if (window.__doc === d) delete window.__doc;
    }, { immediate: true });
    const editorEl = ref(null);
    const recoveryFiles = ref([]);
    const observingSaves = new Set();
    const recoveryRequests = new AbortController();
    async function refreshRecoveryFiles() {
      try {
        const result = await api(d.base + '/departure-saves', { signal: recoveryRequests.signal });
        recoveryFiles.value = result.files || [];
        for (const key of result.pending || []) {
          if (observingSaves.has(key)) continue;
          observingSaves.add(key);
          api(d.base + '/departure-saves/' + key, { signal: recoveryRequests.signal }).then(refreshRecoveryFiles, error => {
            if (error.data?.receipt) void refreshRecoveryFiles();
          }).finally(() => observingSaves.delete(key));
        }
      }
      catch { /* 이전 서버에서는 기존 편집·저장 경로를 사용한다. */ }
    }
    watch(() => s.draft.error, error => { if (error) void refreshRecoveryFiles(); });
    const serverNotice = ref('');
    const rebasing = ref(false); const carrying = ref(false); const saving = ref(false);
    const ed = computed(() => s.editor);
    const documentView = ref({ paragraph: false, controls: false });
    function documentAutomation() {
      try { return editorEl.value?.querySelector('iframe')?.contentWindow?.rhwpStudio?.automation; }
      catch { return null; }
    }
    function readDocumentView() {
      const context = documentAutomation()?.getContext();
      if (context) documentView.value = { paragraph: !!context.showParagraphMarks, controls: !!context.showControlCodes };
    }
    function toggleDocumentView(command) {
      const result = documentAutomation()?.execute(command);
      if (result && !result.ok) toast('문서를 연 뒤 보기 옵션을 선택하세요');
      readDocumentView();
    }
    // v0.4: 실시간 문서인가(설정) · 이 편집기가 실시간·읽기 전용으로 열렸나(편집기 방식)
    const realtime = computed(() => s.settings?.editMode === 'realtime');
    const liveMode = computed(() => ed.value?.mode === 'live' || ed.value?.mode === 'follow');
    // 승인 방식 칩([검토 요청]·최신 반영·반영 안 되는 변경)은 승인 방식 편집기에서만(실시간이면 '실시간 · 저장됨' 칩 하나, §5)
    const liveDoc = computed(() => liveMode.value || (realtime.value && !ed.value?.ready));

    // 탭(보기 규칙 — panels.js panelTabs·view.js panelTabIds): 수는 검토 탭 목록과 같은 셈
    const tabs = computed(() => {
      const vis = panelTabs(d);
      const defs = new Map(TAB_DEFS.map((t) => [t.id, t]));
      return vis.map((t) => ({ ...defs.get(t.id), count: t.count || 0, glance: t.glance || null })).filter((t) => t.comp);
    });
    // 지금 탭이 이 보기에서 숨는 탭이면(간단히의 변경 추적 등) 검토 탭을 보인다
    const curTab = computed(() => (tabs.value.some((t) => t.id === s.tab) ? s.tab : 'review'));
    // 편집 중 창 제목은 'AI 요청' 하나(요청 종류는 창 안의 종류 칩이 보인다), 결과 단계는 'AI 작업 #n'(창 안 결과는 bare — 번호를 다시 쓰지 않음)
    const composerTitle = computed(() => (s.composer?.phase === 'result' ? `AI 작업 #${s.composer.rid}` : 'AI 요청'));

    // ── 내 수정본 칩 ──
    // (다른 곳에서 이미 최신 반영해 이 창 저장이 멈췄으면 — s.draft.rebased — 이 창의 [최신 반영]은 할 수 없으니 칩의 [내 글 옮겨 넣기]로)
    const behind = computed(() => s.draft.behind > 0 && (!!s.myCr || s.draft.dirty) && !s.draft.rebased);
    const chip = computed(() => {
      const dr = s.draft; const cr = s.myCr; const e = s.editor;
      if (dr.tutorialRestored || dr.fileReplaced) return { text: `${dr.elsewhere} —`, cls: 'error', retry: true, reopen: true, tip: dr.error };
      // v0.4 실시간·읽기 전용(§2.4-8): '실시간 · 저장됨 10:31' / '보내는 중…' / '보내지 못함 — [다시]' / '읽기 전용'
      if (e?.ready && (e.mode === 'live' || e.mode === 'follow')) {
        const c = liveChip({ ready: true, readOnly: e.mode === 'follow', error: s.live.error, pushing: s.live.pushing, progress: s.live.progress, dirty: dr.dirty, savedAt: hhmm(s.live.savedAt) });
        if (e.mode === 'follow' && !realtime.value) c.tip = `${READONLY_TIP} — 승인 방식 문서`;
        return c;
      }
      if (e?.ready && s.readOnly) return { text: '읽기 전용', cls: 'readonly', tip: READONLY_TIP };
      if (!e?.ready) return { text: e?.notice ? '검토 기능 꺼짐(원격 편집기)' : e?.error ? '편집기 없음' : '편집기 준비 중…', cls: 'idle' };
      if (dr.saving) return { text: '저장 중…', cls: 'saving' };
      // 다른 곳에서 바뀜: [다시 열기] + [이 글로 저장](덮어쓰기). 서버 수정본이 더 새 버전 위면(다른 창에서 최신으로 맞춤) 덮어쓸 수 없다(STALE_BASE) —
      // [이 글로 저장] 대신 [내 글 옮기기](새 수정본을 열고 이 창에서 고친 문단을 다시 넣음)
      if (dr.error && dr.elsewhere) return { text: `${dr.elsewhere} —`, cls: 'error', retry: true, keep: !dr.rebased, carry: !!dr.rebased && !!dr.dirty, tip: dr.error };
      // 저장을 멈췄으면(stale) 칩 단추가 [다시 열기] — 글에 '다시 여세요'를 또 쓰지 않는다
      if (dr.error) return { text: '저장 실패 —', cls: 'error', retry: true, tip: dr.error };
      const n = dr.dirty ? dr.count : (cr ? (cr.hunkCount ?? cr.hunks?.length ?? dr.count) : dr.count);
      if (!cr && !n) return { text: dr.dirty ? '수정 중…' : '수정 없음', cls: dr.dirty ? 'dirty' : 'clean', tip: '고친 글은 내 수정본으로 자동 저장됩니다(공유 문서는 그대로)' };
      if (dr.dirty) return { text: n ? `수정 ${n}문단 · 저장 대기` : '수정 중…', cls: 'dirty', tip: '잠시 쉬면 자동 저장합니다' };
      const t = hhmm(dr.savedAt || cr?.updatedAt);
      return { text: `${n ? `수정 ${n}문단` : '수정 없음'}${t ? ` · 저장됨 ${t}` : ''}`, cls: 'saved', tip: cr ? `내 수정본 = 변경 요청 #${cr.cid}(${cr.status === 'open' ? '검토 중' : '초안'})${myBaseV.value ? ` · v${myBaseV.value}에서 고침` : ''}` : '' };
    });
    const compactStatus = computed(() => {
      const status = chip.value.cls.split(' ')[0];
      const cls = recoveryFiles.value.length && status !== 'error' ? 'recovery' : status;
      const [label, mark] = cls === 'recovery' ? ['접수본 복구', '!'] : (STATUS_MARKERS[cls] || STATUS_MARKERS.idle);
      return { cls, label, mark };
    });
    // ── 사람용 버전(§9.4 — 기록 번호는 내지 않는다) ──
    const verLabel = computed(() => verText(s.info));
    const verTitle = computed(() => (s.info?.milestone ? versionTip(s.info.milestone, s.info.sinceMilestone ?? Math.max(0, (Number(s.info.version) || 0) - (Number(s.info.milestone.n) || 0))) : '이력 탭에서 보기'));
    /** 내 수정본의 기준이 된 버전 v: 변경 요청 보기의 baseV, 없으면 기준 기록 이하의 마지막 이정표 */
    const myBaseV = computed(() => {
      if (s.myCr?.baseV != null) return s.myCr.baseV;
      const ms = milestoneAt(s.history?.milestones, s.draft.baseVersion || s.myCr?.baseVersion || 0);
      return ms ? ms.v : null;
    });
    const behindTip = computed(() => `${myBaseV.value ? `v${myBaseV.value} 이후 바뀜 — ` : ''}다른 사람의 반영으로 공유 문서에 새 버전이 생겼습니다. [최신으로 맞추기]를 누르면 내 수정본이 새 버전 위로 옮겨집니다`);
    const unsupportedTip = computed(() => (s.draft.unsupported || []).map((u) => `${u.ref || ''} ${u.detail || u.what}`).join('\n') + '\n— 이 변경은 공유 문서에 들어가지 않습니다');
    async function retrySave() {
      if (s.draft.tutorialRestored) {
        if (s.draft.dirty && !confirm('이 창에서 아직 저장하지 못한 글은 복구한 문서에 넣지 않습니다. 복구한 문서를 다시 열까요?')) return;
        emit('restore', props.id); return;
      }
      if (s.draft.fileReplaced) {
        if (s.draft.dirty && !confirm('저장하지 못한 편집을 버리고 교체된 문서를 다시 열까요?')) return;
        await d.editor?.reload({ keepScroll: true });
        return;
      }
      if (s.draft.stale) {
        // 다시 열기 = 서버의 지금 내 수정본(없으면 공유 문서)을 연다 — 이 창에서 친 저장 안 된 글은 버린다
        const more = s.draft.rebased ? '\n(버리지 않으려면 [취소] 뒤 [내 글 옮기기])' : '';
        if (s.draft.dirty && !confirm(`저장 안 된 글이 사라집니다.${more}\n서버의 지금 수정본(없으면 공유 문서)을 다시 열까요?`)) return;
        Object.assign(s.draft, { error: '', stale: false, elsewhere: '', rebased: false });
        await d.editor?.reload({ keepScroll: true });
        return;
      }
      try { await d.saveDraftNow(); } catch (e) { toastError(e, '저장 실패: '); }
    }
    /** 내 글 옮기기: 다른 곳에서 최신으로 맞춘 서버 수정본을 열고 이 창에서 고친 문단을 그 위에 다시 넣는다(web/editor.js carryOver) */
    async function carryMine() {
      if (carrying.value) return;
      carrying.value = true;
      try { await d.editor?.carryOver?.(); } catch (e) { toastError(e, '옮겨 넣지 못했습니다: '); } finally { carrying.value = false; }
    }
    /** 이 글로 저장: 다른 곳(다른 창·기기·관리자)에서 바뀐 서버 내 수정본을 이 창의 글로 덮어쓴다 */
    async function keepMine() {
      if (!confirm('서버의 내 수정본을 이 창의 글로 덮어쓸까요?\n(반영·닫힌 변경 요청이면 새 수정본을 만듭니다)')) return;
      try { await d.saveDraftNow({ force: true }); toast('이 창의 글을 내 수정본으로 저장했습니다'); } catch (e) { toastError(e, '저장 실패: '); }
    }
    async function rebase() {
      rebasing.value = true;
      try { await d.rebaseMine(); } catch (e) { toastError(e, '최신으로 맞추지 못했습니다: '); } finally { rebasing.value = false; }
    }
    function openSubmit() { s.tab = 'cr'; s.submitOpen = true; }
    function openCr(cid) { s.tab = 'cr'; s.activeCid = Number(cid); }
    // 내 변경 요청 칩(검토 중): '검토 중 #3 · 승인 1 · 의견 2'(0 인 수정 요청·의견은 뺌) — 남의 승인·수정 요청·의견이 오면 store 가 알리고 목록으로 맞춘다
    const crChip = computed(() => crChipText(s.myCr));
    // 휴대전화 폭은 '검토 중 #3' 만(수는 title) — 나머지(' · 승인 1 …')는 CSS 가 숨긴다
    const crChipTip = computed(() => {
      const c = crCounts(s.myCr);
      return `내 변경 요청 ${crChip.value}${c.stale ? ` · 다시 승인 필요 ${c.stale}` : ''} — 눌러서 변경 요청 탭에서 보기`;
    });
    const myRole = computed(() => roleLabel(state.me?.role));

    // ── 접속자 ──
    const people = computed(() => {
      const names = new Set(s.presence);
      for (const c of s.crs) if (['draft', 'open'].includes(c.status)) names.add(c.author);
      for (const u of Object.keys(s.editing)) names.add(u);
      return [...names].map((name) => ({
        name, me: d.isMe(name), present: s.presence.includes(name), color: d.colorOf(name),
        editing: d.isMe(name) ? null : s.editing[name] || null,
        crs: s.crs.filter((c) => c.author === name && ['draft', 'open'].includes(c.status)),
      })).sort((a, b) => Number(a.me) - Number(b.me) || Number(b.present) - Number(a.present) || a.name.localeCompare(b.name));
    });
    const present = computed(() => people.value.filter((u) => u.present));
    const go = (ref_) => { if (ref_) s.focus = { ref: ref_, t: Date.now() }; };

    // ── 내 에이전트 ──
    // 상단 알약: 연결된 작업 환경(채널 → 내 AI 키) 이름, 없으면 '○ 연결 안 됨'
    const agentLabel = computed(() => (env.value.connected ? `● ${env.value.connected}` : '○ 연결 안 됨'));
    const agentTip = computed(() => {
      const more = env.value.connected ? '' : ' — 눌러서 연결 방법 보기';
      if (automation.value?.automatic && !automationError.value) return automationMessage.value + more;
      return env.value.connected ? `${env.value.connected} 연결됨 — 새 AI 작업은 이 작업 환경으로 갑니다. 처리 결과는 AI 작업 탭에서 확인하세요` : `${NO_AI_TIP}${more}`;
    });
    // 연결 방법은 화면에 펼쳐 두지 않고 사용 설명서 ①절 '#agents'(내 PC의 AI — 문서 화면 안 창 — help-dialog.js openHelp)로(docs/UI_TERMS.md §1-5)
    const agentHelpHash = new URL(CONNECT_HELP, location.href).hash;
    function openDocumentHelp(hash) {
      closeMore(true);
      openHelp(hash, actionTrigger.value);
    }

    // ── 한글로 저장(단추 하나 — V4 §3: 무엇을 담을지는 문서 설정) ──
    const saveTip = computed(() => `한글로 저장: ${exportTip(s.settings)}${!realtime.value && s.settings ? ' · 진행 중 변경 요청은 검토 메모로' : ''}`);
    async function saveHangul() {
      if (saving.value) return;
      saving.value = true;
      try { await d.downloadHangul(); } catch (e) { toastError(e, '내려받기 실패: '); } finally { saving.value = false; }
    }

    // ── 실시간 문서에 남은 내 수정본(승인 방식 때 진행 중 변경 요청, §5) — 편집기 위 띠 ──
    const leftover = computed(() => {
      if (!realtime.value || !liveMode.value) return null;
      const c = s.myCr || (s.crs || []).find((x) => x && (x.status === 'draft' || x.status === 'open') && d.isMe(x.author) && x.author === d.me);
      return c ? { cid: c.cid, n: c.hunkCount ?? (c.hunks || []).length ?? 0 } : null;
    });
    const loBusy = ref(false); const loConfirm = ref(false);
    const loMsg = computed(() => (leftover.value ? `${josa(`변경 요청 #${leftover.value.cid}`, '을/를')} 닫을까요? (변경 요청 탭에서 다시 열 수 있음)` : ''));
    async function mergeLeftover() {
      const c = leftover.value; if (!c || loBusy.value) return;
      loBusy.value = true;
      try { await d.mergeLeftover(c.cid); } catch (e) { toastError(e, `변경 요청 #${c.cid} 반영 실패: `); } finally { loBusy.value = false; }
    }
    async function closeLeftover() {
      const c = leftover.value; if (!c || loBusy.value) return;
      loBusy.value = true;
      try { await d.closeCr(c.cid); toast(`${josa(`변경 요청 #${c.cid}`, '을/를')} 닫았습니다`); loConfirm.value = false; } catch (e) { toastError(e, '닫지 못했습니다: '); } finally { loBusy.value = false; }
    }

    // ── 편집기 ──
    let handle = null;
    function mount() { handle = mountEditor(editorEl.value, d, { foreground: props.active }); }
    function remount() { try { handle?.destroy(); } catch { /* 이미 없음 */ } if (editorEl.value) editorEl.value.innerHTML = ''; mount(); }
    function backgroundSave() {
      if (handle?.ready && !s.draft.stale && !s.draft.error && (s.draft.dirty || s.draft.saving)) {
        retainedSaves.leave(props.id, () => d.saveDraftNow({ departure: true }), () => !s.draft.dirty && !s.draft.saving,
          () => handle?.editRevision?.() ?? 0, s.info?.title || props.id);
      }
    }
    const bodyNeedsSave = () => !!(s.draft.dirty || s.draft.saving || handle?.dirty);
    function hasUnsentInput() {
      return d.hasUnsentWindowDrafts() || !!titleEdit.value?.trim() && titleEdit.value.trim() !== s.info?.title
        || !!rootEl.value?.querySelector('[data-office-unsent="true"]') || !!document.querySelector(overlay + ' [data-office-unsent="true"]');
    }
    async function saveForClose() {
      retainedSaves.discard(props.id);
      if (!bodyNeedsSave()) return;
      const unlock = handle?.lock('문서를 저장하는 중…');
      try {
        await d.saveDraftNow({ departure: true });
        if (bodyNeedsSave()) throw new Error(s.draft.error || '저장할 수정 내용이 남아 있습니다.');
      } finally { unlock?.(); }
    }
    async function prepareClose() {
      await saveForClose();
      if (hasUnsentInput() && !confirm(`‘${s.info?.title || '문서'}’에 작성 중인 메모, 요청 또는 이름이 있습니다. 입력을 버리고 닫을까요?`)) return false;
      if (tourOn.value) await flushTour(props.id, { strict: true });
      return true;
    }
    async function leaveTutorial() {
      if (tour && tourOn.value && !await tour.requestLeave()) return false;
      if (tourOn.value) {
        await flushTour(props.id).catch(() => {});
      }
      return true;
    }
    watch(() => [s.draft.dirty, s.draft.saving], ([dirty, saving]) => {
      if (!dirty && !saving && retainedSaves.status(props.id)?.running === false) retainedSaves.discard(props.id);
    });

    // ── 플러그인 menu-action → 요청 창·메모 창·제안 반영·레일 ──
    /** 호스트 페이지 사각형 → FloatWin 기준점(대상 바로 아래, 대상을 가리지 않게) */
    function winAnchor(a) {
      if (!a) return null;
      return { x: a.x, y: a.y + a.h + 8, top: a.y, avoid: { left: a.x, top: a.y, right: a.x + Math.max(1, a.w), bottom: a.y + a.h } };
    }
    function show(active) {
      s.active = active;
      if (!s.railOpen) { s.tab = 'review'; reveal(); }
    }
    /**
     * 우클릭 'AI 작업 메모 ▸ 남은 제안 모두 반영(n)'이 요청 번호(rid)를 싣지 않았을 때(메뉴 동작을 rid 없이 넘기는 플러그인 판):
     * 메뉴 대상 자리를 덮는 AI 작업 메모 중 내가 한 번에 반영할 수 있는 것(요청자·관리자, 남은 바꿈·문단 추가가 있음). 하나로 정해지지 않으면 null
     */
    function requestAt(t) {
      if (!t?.ref) return null;
      const geo = paragraphGeo(s.paragraphs);
      const hits = [];
      for (const m of s.memos) {
        if (m.link?.type !== 'request') continue;
        const r = d.request(m.link.rid);
        if (!r || !d.canResolve(r)) continue;
        const g = d.progress(r);
        if (!g || g.resolved || g.openPids.length - g.tables <= 0) continue;
        let rg = null; try { rg = memoRange(m, geo); } catch { rg = null; }
        if (!rg) continue;
        const exact = covers(rg, t.ref, Number(t.start) || 0, geo) || (t.end != null && covers(rg, t.ref, Number(t.end) || 0, geo));
        if (exact || rg.ref === t.ref || rg.endRef === t.ref) hits.push({ rid: Number(r.rid), exact: !!exact });
      }
      const pick = hits.some((x) => x.exact) ? hits.filter((x) => x.exact) : hits;
      return pick.length === 1 ? pick[0].rid : null;
    }
    function onMenuAction(p) {
      const e = d.editor;
      const a = p.anchor && e ? e.anchorToPage(p.anchor) : null;
      const anchor = winAnchor(a);
      const t = d.targetFromCw(p.target);
      switch (p.action) {
        // 요청 종류는 고르지 않는다(2026-11-03): 'AI에게 맡기기…'는 요청 창을, 'AI에게 빠르게 맡기기 ▸'는 예시 지시를 넣은 요청 창을 연다
        // (문서 설정 aiQuick 이 'send'(기본)면 연 채 곧바로 보낸다 — store openComposer quick). 무엇을 할지는 지시·문맥을 보고 AI 가 고른다
        // 'review' = 편집기 도구 메뉴의 'AI에게 맡기기…'(studio/plugin controller.ts ext:cowork.ai-review — 2026-11-17 전 이름 'AI에게 검토 맡기기') — 같은 요청 창(비워 두면 검토).
        // 2026-11-03 메뉴를 합칠 때 이 갈래가 빠져 눌러도 아무 일이 없었다(2026-11-16)
        case 'review':
        case 'instruct': return d.openComposer(t, 'instruct', { anchor });
        case 'quick': {
          const instruction = quickPrompt(p.quick, presets());
          return instruction ? d.openComposer(t, 'instruct', { anchor, instruction, quick: true }) : null;
        }
        case 'memo': return d.openPopover('memo', t, anchor);
        case 'proposal-adopt': return d.adoptProposal(Number(p.pid));
        case 'proposal-reject': { const pr = d.proposal(p.pid); if (pr) d.rejectProposal(pr).catch(toastError); return null; }
        case 'proposal-show': return show({ kind: 'proposal', id: String(p.pid) });
        case 'draft-show': {
          // 변경 보기: 레일 카드를 고르고(편집기 강조) 패널 '변경 요청' 탭에 그 변경 요청을 그 덩어리에 맞춰 연다
          s.active = { kind: 'draft', id: String(p.cid), cid: Number(p.cid), hid: p.hid ?? null };
          openCrIn(d, Number(p.cid), p.hid || null);
          return null;
        }
        case 'draft-comment': {
          show({ kind: 'draft', id: String(p.cid), cid: Number(p.cid), hid: p.hid ?? null });
          const c = d.cr(p.cid); const hs = Array.isArray(c?.hunks) ? c.hunks : [];
          const hi = p.hid ? hs.findIndex((x) => x.hid === p.hid) : -1; const h = hi >= 0 ? hs[hi] : null;
          // 덩어리 열쇠(종류 + 기준 자리 — 작성자가 자동 저장해 hid 가 바뀌어도 같다): 의견을 보낼 때 지금 hid 를 찾는 데 쓴다(QuickReply)
          const hkey = h ? (hunkKeys(hs)[hi] ?? null) : null;
          // (같은 덩어리의 의견 창을 다시 열면 쓰던 글이 돌아온다 — store openReply)
          d.openReply({ key: Date.now(), kind: 'draft', cid: Number(p.cid), hid: p.hid || null, hkey, hunk: h ? { ...h } : null, ref: h ? (h.curRef || h.ref || h.afterRef) : (p.target?.ref || null), quote: h ? clip(h.type === 'delete' ? h.baseText : h.newText, 80) : (p.target?.text || ''), anchor });
          return null;
        }
        case 'memo-show': s.activeMemo = p.id; return show({ kind: 'memo', id: String(p.id) });
        case 'memo-reply': {
          show({ kind: 'memo', id: String(p.id) });
          const m = d.memo(p.id);
          d.openReply({ key: Date.now(), kind: 'memo', memoId: p.id, ref: m?.ref || null, quote: m ? (m.body ?? m.text ?? '') : '', anchor });
          return null;
        }
        case 'memo-resolve': d.resolveMemo(p.id, p.resolved !== false).catch(toastError); return null;
        case 'request-adopt-all': {
          // AI 작업 메모 ▸ 남은 제안 모두 반영(n) — 그 요청의 [모두 반영]과 같다(§9.7)
          const rid = p.rid != null ? Number(p.rid) : requestAt(p.target);
          const r = rid != null ? d.request(rid) : null;
          if (!r) { toast('어느 AI 작업인지 찾지 못했습니다 — 문서 옆 메모나 AI 작업 탭의 [모두 반영]을 쓰세요', { kind: 'error', ms: 6000 }); return null; }
          d.resolveRequest(r, 'adopt').catch((e) => toastError(e, `AI 작업 #${r.rid}: `));
          return null;
        }
        case 'panel': s.tab = 'review'; return null;
        default: return null;
      }
    }
    /**
     * Esc: 맨 위 떠 있는 창을 닫는다(쓰던 글은 store 가 대상별로 둔다 — 같은 대상의 창을 다시 열면 돌아온다) → 닫았으면 true(없으면 펼쳐 본 패널을 접는다 — onKey).
     * 편집기 안에서 누른 Esc(fromEditor — 선택 풀기·studio 대화상자 닫기 등)는 보내지 않은 글이 있는 창을 닫지 않는다
     */
    function closeFloating({ fromEditor = false } = {}) {
      if (s.settingsOpen && !fromEditor) { s.settingsOpen = false; return true; }
      const top = s.reply ? 'reply' : s.popover ? 'popover' : s.composer && s.composer.phase !== 'sending' ? 'composer' : null;
      if (!top || (fromEditor && d.windowHasText(top))) return false;
      d.closeWindow(top);
      return true;
    }
    /** Ctrl/⌘+Alt+M: 지금 선택(없으면 캐럿 문단)에 메모 */
    async function memoOnSelection() {
      const sel = await d.editor?.getSelection?.();
      const t = d.targetFromCw(sel);
      if (!t) { toast('편집기 본문에 커서를 두세요'); return; }
      d.openPopover('memo', t, winAnchor(sel?.rect ? d.editor.anchorToPage(sel.rect) : null));
    }
    function onEditorKey(k) {
      if (!props.active) return;
      if (k.key === 'Escape') { if (!closeFloating({ fromEditor: true }) && peek.value) closePeek(); }
      else if (k.key === 'M' && (k.ctrl || k.meta) && k.alt) memoOnSelection();
    }
    function onKey(e) {
      if (!props.active) return;
      if (e.key === 'Escape' && moreOpen.value) { e.preventDefault(); closeMore(true); }
      else if (e.key === 'Escape' && !isTyping()) { if (!closeFloating() && peek.value) closePeek(); }
      else if ((e.ctrlKey || e.metaKey) && e.altKey && !isTyping() && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) { e.preventDefault(); memoOnSelection(); }
      else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'F10' || e.key === 'F10')) openSymbols(e);
    }
    // Alt+F10(문자표): 편집기 밖(AI 작업 창·메모 등)에 포커스가 있어도 편집기의 문자표를 연다. 편집기 안의 키는 편집기가 직접 받는다.
    // 보기 옵션과 같은 자동화 길(rhwpStudio.automation.execute)을 쓴다 — 옛 편집기도 이 명령을 알고, 모르면 결과만 실패로 돌아온다.
    function openSymbols(e) {
      const frame = editorEl.value?.querySelector('iframe'); const auto = documentAutomation();
      if (!frame || !auto) return;
      e.preventDefault();
      try { frame.contentWindow.focus(); } catch { /* 없음 */ }
      try { auto.execute('insert:symbols', undefined, { allowDialog: true }); } catch { /* 편집기 준비 전 */ }
    }

    // ── 창 폭: 좁은 창(900px 이하 — 패널이 아래로)이면 문서 옆 메모를 숨기고 패널 '검토' 탭이 대신 ──
    function onResize() { if (props.active) { syncRail(); measureOver(); } }
    // ── 오른쪽 창(패널) 크기: 경계선(.splitter)을 끌어 폭을, 좁은 창(900px 이하 — 패널이 아래로)이면 높이를 바꾼다(view.js PANEL, 이 브라우저에 기억) ──
    // 넓은 창에서 끝까지(wFold 아래로) 줄이면 접는다. 좁은 창에서는 아주 낮게 끌거나 경계선을 누르면 탭 줄만 남기고 접고, 탭을 누르면 다시 편다. 두 번 누르면(Home) 기본 크기
    const stackQuery = matchMedia('(max-width: 900px)');
    const stacked = ref(stackQuery.matches);
    const onStack = () => { stacked.value = stackQuery.matches; };
    const panel = ref(readPanel());
    const resizing = ref(false);
    const foldHint = ref(false);   // 끄는 중 — 놓으면 접힘
    const sbW = ref(15);   // 편집기 세로 스크롤바 폭 — 꼭지를 그 앞에 둔다
    const panelVars = computed(() => ({ '--panel-w': `${panel.value.w}px`, '--panel-h': `${(panel.value.h * 100).toFixed(1)}%`, '--sb-w': `${sbW.value}px` }));
    const splitTip = computed(() => (stacked.value ? '끌어서 AI 작업 창 높이 조절 · 누르면 접기/펴기' : '끌어서 AI 작업 창 폭 조절 · 끝까지 밀면 접기 · 두 번 누르면 기본 폭'));
    const savePanel = () => writePanel(panel.value);
    function setFold(min) { if (panel.value.min !== min) { panel.value = { ...panel.value, min }; savePanel(); } }
    function pickTab(id) { s.tab = id; if (stacked.value) setFold(false); }
    function resetPanel() { panel.value = { ...panel.value, w: PANEL.w, h: PANEL.h, min: false }; savePanel(); }

    // ── 오른쪽 창 접기(넓은 창): 꼭지(edge-ai)를 누르면 고정 ↔ 접힘. 접힌 동안 꼭지·화면 오른쪽 끝에 마우스를 대면 잠깐 펼침(peek 'hover' — 창 밖으로 나가면 접음),
    // 다른 곳에서 패널을 부르면(결과 보기·변경 요청 열기·이력 알약 등) 펼쳐 둠(peek 'held' — 창 밖을 누르거나 Esc, 창에 들어왔다 나가면 접음).
    // 창 안에서 글을 쓰는 중(입력 칸에 포커스)이면 접지 않는다
    const folded = computed(() => !stacked.value && !panel.value.pin);
    const peek = ref(null);
    const panelEl = ref(null);
    let peekTimer = 0; let overPanel = false;
    function onViewportLeave(e) {
      if (!props.active) return;
      if (e?.type === 'pointerleave' && e.pointerType !== 'mouse') return;
      overPanel = false;
      clearTimeout(peekTimer); peekTimer = 0;
      edgeStop();
      if (peek.value === 'hover') closePeek();
    }
    function openPeek(kind = 'held') { clearTimeout(peekTimer); peekTimer = 0; if (folded.value && !peek.value) peek.value = kind; }
    function closePeek() { clearTimeout(peekTimer); peekTimer = 0; peek.value = null; edgeStop(); }
    // 화면 오른쪽 끝(접힌 동안): 마우스를 편집 영역 오른쪽 끝 EDGE px(위 막대 아래 높이 전체 — 편집기 iframe 안도 본다)에 200ms 두면 꼭지에 올린 것처럼 펼침.
    // 스크롤바 가운데는 비워 두려고 바깥 6px 만 본다. 단추를 누른 채(끌기·스크롤바)이거나 누른 뒤·접은 뒤에는 한 번 끝을 벗어나야 다시 연다(edgeLatch)
    const EDGE = 6;
    let edgeTimer = 0; let edgeLatch = false;
    function edgeStop() { clearTimeout(edgeTimer); edgeTimer = 0; edgeLatch = true; }
    function edgeSense(e, x, y) {
      const lay = x >= innerWidth - 40 ? panelEl.value?.parentElement?.getBoundingClientRect() : null;
      if (!lay || x < lay.right - EDGE || x > lay.right || y < lay.top || y >= lay.bottom) { clearTimeout(edgeTimer); edgeTimer = 0; edgeLatch = false; return; }
      if (e.buttons) { edgeStop(); return; }
      if (edgeLatch || edgeTimer || !folded.value || peek.value) return;
      edgeTimer = setTimeout(() => { edgeTimer = 0; openPeek('hover'); }, 200);
    }
    function onHostMove(e) {
      if (!props.active || e.pointerType !== 'mouse' || stacked.value) return;
      if (e.target.closest?.('.floatwin, .toasts, dialog')) { clearTimeout(edgeTimer); edgeTimer = 0; return; }
      edgeSense(e, e.clientX, e.clientY);
    }
    function onFrameMove(e) {
      if (!props.active || e.pointerType !== 'mouse' || stacked.value) return;
      const f = editorEl.value?.querySelector('iframe'); const r = f && e.clientX >= (e.view?.innerWidth || 0) - 40 ? f.getBoundingClientRect() : null;
      edgeSense(e, r ? r.left + e.clientX : -1, r ? r.top + e.clientY : -1);
    }
    const typingIn = (el) => { const a = document.activeElement; return !!el && !!a && el.contains(a) && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); };
    function onTabEnter(e) {
      if (!folded.value || peek.value || e.pointerType !== 'mouse') return;
      clearTimeout(peekTimer); peekTimer = setTimeout(() => openPeek('hover'), 140);
    }
    function onTabLeave() { if (!peek.value) { clearTimeout(peekTimer); peekTimer = 0; } }
    function onPanelEnter(e) {
      if (e.pointerType !== 'mouse') return;
      overPanel = true;
      if (peek.value) { clearTimeout(peekTimer); peekTimer = 0; peek.value = 'hover'; }
    }
    function onPanelLeave(e) {
      if (e.pointerType !== 'mouse') return;
      overPanel = false;
      if (peek.value !== 'hover') return;
      clearTimeout(peekTimer); peekTimer = setTimeout(() => { peekTimer = 0; if (!overPanel && !resizing.value && !typingIn(panelEl.value)) peek.value = null; }, 380);
    }
    // 마우스로 펼친 창: 입력 칸에서 나가면(편집기를 누름 등) 마우스도 밖이면 접는다(다른 곳이 부른 창은 밖을 누르거나 Esc 로)
    function onPanelFocusOut() { setTimeout(() => { if (peek.value === 'hover' && !overPanel && !panelEl.value?.contains(document.activeElement)) closePeek(); }, 0); }
    function togglePin() {
      panel.value = { ...panel.value, pin: folded.value };   // 접힘(펼쳐 보는 중 포함) → 고정, 고정 → 접힘
      savePanel(); closePeek();
    }
    const edgeTip = computed(() => (!folded.value ? 'AI 작업 창 접기' : peek.value ? '누르면 고정' : 'AI 작업 창 — 올리거나 화면 오른쪽 끝에 대면 잠깐 열림 · 누르면 고정'));
    // 꼭지 [AI 작업]의 수: 확인 필요(내 차례 — 파란 테두리) · 처리 중(보라, 움직임) · 응답 대기(은은한 붉은 톤) — ui.js requestGlance(docs/UI_TERMS.md §6)
    const aiGlance = computed(() => requestGlance(d, s.requests));
    // 다른 곳에서 패널을 부름(탭·결과·변경 요청·검토 요청 창, 같은 것을 다시 부르면 ui.js callPanel 의 panelPing) → 접힌 패널을 펼쳐 둔다. 좁은 창이면 접힌 패널(탭 줄만)을 편다
    function reveal() { if (stacked.value) setFold(false); else openPeek('held'); }
    let quietTab = false;   // 화면이 저절로 바꾼 탭(메모가 숨어 검토 탭으로 — syncRail)은 패널을 펼치지 않는다
    watch(() => [s.tab, s.activeRid, s.activeCid, s.crOpen, s.submitOpen, s.panelPing], (n, o) => {
      if (quietTab) { quietTab = false; return; }
      if (n.some((v, i) => v !== o[i] && v != null && v !== false)) reveal();
    });
    function onAnnClick(p) { if (p?.viaMark && (p.kind === 'change' || !s.railOpen)) reveal(); }
    // 창 밖을 누르면 펼쳐 둔 패널을 접는다(떠 있는 창·메뉴·문서 옆 메모를 누를 때는 그대로 — 메모의 [결과 보기] 등이 다시 부른다)
    function onDownOutside(e) {
      if (!props.active) return;
      edgeStop();
      if (!peek.value || panelEl.value?.contains(e.target) || e.target.closest?.('.floatwin, .toasts, dialog, .barmore, .doc-view-options, .railover, .tour')) return;
      closePeek();
    }
    // iframe의 누름은 바깥 문서로 전달되지 않으므로 열린 문서 메뉴를 여기서도 접는다.
    let frameDoc = null;
    function onFrameDown() {
      if (!props.active) return;
      if (moreOpen.value) closeMore();
      edgeStop();
      if (peek.value) closePeek();
    }
    const editorOfficeKeys = inject('officeKeyboard');
    const onFrameKey = e => { if (props.active) editorOfficeKeys(e); };
    const onFrameFocus = e => { if (props.active && isTyping(e.target)) lastWorkInput = null; };
    function hookFrame() {
      let doc = null; try { doc = editorEl.value?.querySelector('iframe')?.contentDocument || null; } catch { doc = null; }
      if (doc === frameDoc) return;
      frameDoc?.removeEventListener('pointerdown', onFrameDown, true); frameDoc?.removeEventListener('pointermove', onFrameMove, true);
      frameDoc?.removeEventListener('keydown', onFrameKey, true);
      frameDoc?.removeEventListener('focusin', onFrameFocus, true);
      frameDoc = doc; frameDoc?.addEventListener('pointerdown', onFrameDown, true); frameDoc?.addEventListener('pointermove', onFrameMove, { capture: true, passive: true });
      frameDoc?.addEventListener('keydown', onFrameKey, true);
      frameDoc?.addEventListener('focusin', onFrameFocus, true);
    }
    let foldTimer = 0;
    watch(folded, (f) => { if (!f) closePeek(); clearTimeout(foldTimer); foldTimer = setTimeout(measureOver, 220); });

    // ── 문서 옆 메모(검토 표시 — 메모·AI 작업·제안·남의 수정 중): 편집기 쪽 오른쪽 여백 위에 겹쳐(한/글처럼), 하나씩 끌어 어디로든 옮길 수 있다(rail.js) ──
    // 상단 보기 메뉴·꼭지 '메모'로 켜고 끈다. s.railOpen = 메모가 지금 보이나(아니면 편집기 표식을 누를 때 패널 '검토' 탭이 대신 — editor.js·panels.js)
    const memosOn = computed(() => panel.value.rmode !== 'off');
    const railOver = computed(() => !!s.railOpen);
    function syncRail() {
      const open = railVisible(panel.value.rmode, { stacked: stacked.value });
      if (open === s.railOpen) return;
      s.railOpen = open;
      // 메모가 숨으면 고정해 둔 패널·좁은 창의 아래 패널은 검토 탭으로 — 탭만 바꾸고 접어 둔 패널을 저절로 펼치지 않는다
      if (!open && !folded.value && s.tab !== 'review') { quietTab = true; s.tab = 'review'; }
    }
    function toggleMemos() { panel.value = { ...panel.value, rmode: memosOn.value ? 'off' : 'margin' }; savePanel(); syncRail(); }
    watch(stacked, () => { if (props.active) syncRail(); });
    // 끌어 옮긴 메모 자리(rail.js 가 d.s.memoPos 에 두고 이 브라우저에 기억 — view.js readMemoPos)
    if (!s.memoPos) s.memoPos = readMemoPos(s.id);
    const movedMemos = computed(() => Object.keys(s.memoPos || {}).length);
    function resetMemoPos() { s.memoPos = {}; writeMemoPos(s.id, {}); }
    // 메모 자리(편집기 iframe 안을 잰다 — 같은 출처): 겹침 층 = 문서 스크롤 칸(왼쪽 세로 눈금자·위 도구 막대 빼고), 메모 칸 = 보이는 쪽 오른쪽 끝 옆(view.js marginBox).
    // 강조 자리·창 폭이 바뀔 때와 1초마다
    const over = ref(null);
    function measureOver() {
      if (!props.active) return;
      const host = editorEl.value; const f = host?.querySelector('iframe');
      let doc = null; try { doc = f?.contentDocument; } catch { /* 다른 출처(원격 편집기) */ }
      const sc = doc?.getElementById('scroll-container');
      if (f && sc) { const sb = Math.max(0, Math.round(sc.offsetWidth - sc.clientWidth - sc.clientLeft)); if (sb !== sbW.value) sbW.value = sb; }
      if (!railOver.value) return;
      let next;
      const reserve = stacked.value ? 0 : 30;   // 오른쪽 끝 꼭지(AI 작업·메모) 자리는 비운다
      if (!f || !sc) next = marginBox({ width: (host?.clientWidth || 0) - 16, page: null, left: 0, right: 16, reserve }, panel.value.r);
      else {
        const r = sc.getBoundingClientRect();
        const left = r.left + sc.clientLeft;
        let right = -Infinity;
        for (const c of doc.querySelectorAll('#scroll-content .document-page-canvas, #scroll-content .page-placeholder')) {
          const b = c.getBoundingClientRect();
          if (b.width && b.bottom > r.top && b.top < r.bottom) right = Math.max(right, b.right);
        }
        const top = r.top + sc.clientTop;
        next = marginBox({ width: sc.clientWidth, page: Number.isFinite(right) ? right - left : null, left, right: f.clientWidth - (left + sc.clientWidth), top, bottom: f.clientHeight - (top + sc.clientHeight), reserve }, panel.value.r);
      }
      next.top += host?.offsetTop || 0;   // 편집기 위 띠(남은 수정본)가 있으면 그만큼 아래
      const o = over.value;
      if (!o || ['top', 'bottom', 'left', 'right'].some((k) => o[k] !== next[k]) || ['left', 'width', 'limit'].some((k) => o.col[k] !== next.col[k])) over.value = next;
    }
    const overStyle = computed(() => (over.value ? { top: `${over.value.top}px`, bottom: `${over.value.bottom}px`, left: `${over.value.left}px`, right: `${over.value.right}px` } : { visibility: 'hidden' }));
    let overTimer = null;
    watch(() => props.active && railOver.value, (on) => {
      clearInterval(overTimer); overTimer = null;
      if (!on) return;
      nextTick(measureOver); overTimer = setInterval(measureOver, 1000);
    }, { immediate: true });
    watch(() => [s.anchors, panel.value.w, leftover.value], () => { if (props.active && railOver.value) requestAnimationFrame(measureOver); });
    watch(() => ed.value?.ready, (r) => { if (r) { hookFrame(); nextTick(measureOver); } });

    /** 경계선 끌기 — 오른쪽 창 폭(넓은 창 — 끝까지 밀면 접기)·높이(좁은 창) */
    function startResize(e) {
      if (e.button !== 0) return;
      const el = e.currentTarget; const layEl = el.closest('.v3layout'); const lay = layEl?.getBoundingClientRect(); const box = el.parentElement.getBoundingClientRect();
      if (!lay) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* 잡지 못해도 끌기는 된다(끄는 동안 편집기 iframe 은 포인터를 받지 않는다) */ }
      const x0 = e.clientX; const y0 = e.clientY; const h0 = panel.value.h; const w0 = panel.value.w; let last = e; let moved = false; let raf = 0;
      const rawW = () => box.width + (x0 - last.clientX);
      const apply = () => {
        raf = 0;
        // 접히면 높이는 끌기 전 값으로 둔다(펼치면 그 높이로)
        if (stacked.value) panel.value = { ...panel.value, ...panelHeightFrom(box.height + (y0 - last.clientY), lay.height, h0) };
        else { panel.value = { ...panel.value, w: clampPanelW(rawW(), lay.width) }; foldHint.value = rawW() < PANEL.wFold; }
      };
      const move = (ev) => {
        last = ev;
        if (!moved && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 4) return;
        moved = true; resizing.value = true;
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        if (raf) { cancelAnimationFrame(raf); apply(); }
        resizing.value = false; foldHint.value = false;
        if (moved && !stacked.value) {
          const v = panelWidthFrom(rawW(), lay.width, w0);
          panel.value = { ...panel.value, w: v.w, pin: v.pin ? panel.value.pin : false }; savePanel();
          if (!v.pin) closePeek();
        } else if (moved) savePanel();
        else if (stacked.value) setFold(!panel.value.min);   // 좁은 창: 경계선을 누르기만 하면 접기/펴기
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    }
    function keyResize(e) {
      if (e.key === 'Home') { e.preventDefault(); resetPanel(); return; }
      if (stacked.value) {
        const dh = { ArrowUp: 0.05, ArrowDown: -0.05 }[e.key];
        if (dh) { e.preventDefault(); panel.value = { ...panel.value, h: clampPanelH((panel.value.min ? PANEL.hMin : panel.value.h) + dh), min: false }; savePanel(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFold(!panel.value.min); }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); togglePin(); return; }
      const dw = { ArrowLeft: 1, ArrowRight: -1 }[e.key] * (e.shiftKey ? 80 : 24);
      if (dw) { e.preventDefault(); panel.value = { ...panel.value, w: clampPanelW(panel.value.w + dw, e.currentTarget.closest('.v3layout')?.clientWidth || 0) }; savePanel(); }
    }
    // 하나로 묶인 편집 메뉴와 서식은 모든 화면에서 기본으로 보인다.
    const mobileEnvironment = ref(isMobileDevice(window));
    function openMobileOptions() { documentAutomation()?.execute('tool:options', undefined, { allowDialog: true }); }
    const tools = inject('officeEditingRowVisible');
    const toggleTools = () => { tools.value = !tools.value; };
    watch([tools, () => ed.value?.ready], ([shown, ready]) => {
      if (ready) d.editor?.setChrome?.({ menu: shown, toolbar: shown });
    });

    const moreOpen = ref(null); const moreEl = ref(null); const popoverEl = ref(null);
    const statusTrigger = ref(null); const actionTrigger = ref(null);
    function toggleMore(kind) {
      if (moreOpen.value === kind) { closeMore(true); return; }
      moreOpen.value = kind;
      if (kind === 'actions') readDocumentView();
      nextTick(() => { if (moreOpen.value === kind) popoverEl.value?.focus({ preventScroll: true }); });
    }
    function closeMore(restoreFocus = false) {
      const trigger = moreOpen.value === 'status' ? statusTrigger : actionTrigger;
      moreOpen.value = null;
      if (restoreFocus === true) nextTick(() => { if (props.active && !moreOpen.value) trigger.value?.focus({ preventScroll: true }); });
    }
    function onDocDown(e) { if (props.active && moreOpen.value && !moreEl.value?.contains(e.target)) closeMore(); }
    function onMoreFocusOut(e) { if (e.relatedTarget && !moreEl.value?.contains(e.relatedTarget)) closeMore(); }
    // 다룰 곳(편집기·요청 창·첨부 칸) 밖에 파일을 놓아도 브라우저가 파일을 열어 화면을 떠나지 않게. 패널에 놓으면 첨부만
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    function onWinDragOver(e) {
      if (!props.active) return;
      if (!isFiles(e)) return; const handled = e.defaultPrevented; e.preventDefault();
      if (!handled) e.dataTransfer.dropEffect = e.target.closest?.('.panel') ? 'copy' : 'none';
    }
    function onWinDrop(e) {
      if (!props.active) return;
      if (!isFiles(e) || e.defaultPrevented) { if (isFiles(e)) e.preventDefault(); return; }
      e.preventDefault();
      if (e.target.closest?.('.panel')) d.uploadFiles([...e.dataTransfer.files]);
    }
    function onBeforeUnload(e) {
      if (!preparedExit && (bodyNeedsSave() || hasUnsentInput())) {
        e.preventDefault(); e.returnValue = '';
      }
    }

    async function serverRestarting(msg) {
      if (msg.type !== 'server' || msg.action !== 'restarting') return;
      serverNotice.value = '관리자가 서버를 재시작합니다. 입력 중인 글을 저장하고 있습니다. 잠시 입력을 멈춰 주세요.';
      try { if (s.draft.dirty || s.draft.saving) await d.saveDraftNow(); } catch { /* 쓴 글은 편집기에 유지한다 */ }
      serverNotice.value = s.draft.dirty || s.draft.saving
        ? '서버 재시작 중입니다. 아직 저장하지 못한 글이 있으니 이 문서 창을 그대로 두세요.'
        : '서버 재시작 중입니다. 저장한 글은 유지되며 연결되면 계속 작업할 수 있습니다.';
    }
    function serverReconnected() {
      if (!serverNotice.value) return;
      serverNotice.value = s.draft.dirty || s.draft.saving ? '서버에 다시 연결했습니다. 상단에서 입력한 글의 저장 상태를 확인하세요.' : '';
    }
    const offs = [d.on('menu-action', p => { if (props.active) onMenuAction(p); }), d.on('editor-key', onEditorKey), d.on('ws', serverRestarting), d.on('reconnect', serverReconnected), d.on('annotation-click', onAnnClick)];
    s.railOpen = railVisible(panel.value.rmode, { stacked: stacked.value });
    let viewClosed = false; let connected = false;
    let lastWorkInput = null;
    function rememberWorkInput(event) {
      const input = event.target;
      if (input === handle?.frame?.()) lastWorkInput = null;
      else if (isTyping(input) && rootEl.value?.parentElement?.contains(input)) lastWorkInput = input;
    }
    async function restoreWorkFocus(canRestore) {
      if (!props.active || !canRestore()) return false;
      const input = lastWorkInput;
      if (input?.isConnected && !input.matches(':disabled') && rootEl.value?.parentElement?.contains(input)) {
        if (folded.value && panelEl.value?.contains(input)) { openPeek('held'); await nextTick(); }
        if (!props.active || !canRestore()) return false;
        if (!input.closest('[inert], [hidden]') && getComputedStyle(input).visibility === 'visible' && input.getClientRects().length) {
          input.focus({ preventScroll: true });
          if (document.activeElement === input) return true;
        }
      }
      return !s.settingsOpen && !!handle?.focusDocumentInput();
    }
    function activateView() {
      document.addEventListener('focusin', rememberWorkInput);
      addEventListener('keydown', onKey); addEventListener('resize', onResize); addEventListener('dragover', onWinDragOver); addEventListener('drop', onWinDrop);
      refreshAutomation(); addEventListener('focus', refreshAutomation); document.addEventListener('visibilitychange', refreshAutomation);
      automationPoll = setInterval(refreshAutomation, 15000);
      document.addEventListener('pointerdown', onDocDown, true); addEventListener('blur', closeMore);
      document.addEventListener('pointerdown', onDownOutside, true); document.addEventListener('pointermove', onHostMove, { capture: true, passive: true });
      document.documentElement.addEventListener('pointerleave', onViewportLeave);
      addEventListener('blur', onViewportLeave);
      onResize();
      if (connected) void readInitialTour();
    }
    function deactivateView() {
      clearInterval(automationPoll); automationPoll = null;
      clearTimeout(foldTimer); closeMore(); closePeek();
      document.removeEventListener('pointerdown', onDownOutside, true); document.removeEventListener('pointermove', onHostMove, true);
      document.documentElement.removeEventListener('pointerleave', onViewportLeave);
      removeEventListener('blur', onViewportLeave);
      removeEventListener('focus', refreshAutomation); document.removeEventListener('visibilitychange', refreshAutomation);
      document.removeEventListener('pointerdown', onDocDown, true); removeEventListener('blur', closeMore);
      document.removeEventListener('focusin', rememberWorkInput);
      removeEventListener('keydown', onKey); removeEventListener('resize', onResize); removeEventListener('dragover', onWinDragOver); removeEventListener('drop', onWinDrop);
    }
    watch(active, shown => {
      handle?.setForeground(shown);
      if (shown) activateView();
      else { deactivateView(); tourStartGeneration++; }
    }, { flush: 'post' });

    const discardLocalChanges = async () => {
      retainedSaves.discard(props.id);
      await handle?.cancelSave();
    };
    const session = { backgroundSave, leaveTutorial, saveForClose, prepareClose, bodyNeedsSave, hasUnsentInput, discardLocalChanges, restoreWorkFocus };
    onMounted(async () => {
      void refreshRecoveryFiles();
      officeDocs.set(props.id, session);
      addEventListener('beforeunload', onBeforeUnload);
      stackQuery.addEventListener('change', onStack);
      if (props.active) activateView();
      mount();
      await d.refresh();
      if (viewClosed) return;
      d.connect(); connected = true;
      try {
        const key = `hwpx.tutorial-recovery-notice:${props.id}`;
        const notice = sessionStorage.getItem(key); sessionStorage.removeItem(key);
        if (notice === 'AI_IN_FLIGHT') toast('진행 중인 AI 작업을 다시 보내지 않도록 요청 전 단계로 돌아왔습니다.');
      } catch { /* 알림 저장을 사용할 수 없어도 복구한 문서는 엽니다. */ }
      if (props.active) void readInitialTour();
    });
    // ── 체험(공모전 체험 계정 — server/tutorial.js·web/tutorial.js) ──
    // [체험 안내]는 체험 문서(서버가 만든 사본 — info.tutorial)에서만. 다른 문서에서 누르면 엉뚱한 문서로 따라 하기가 열렸다
    const stateMeTutorial = computed(() => !!state.me?.tutorial);
    const tourOn = computed(() => !!s.info?.tutorialSession && !!s.info?.tutorialGuided);
    const tutorialSaving = ref(false);
    const tutorialItems = ref([]);
    const nextCourse = computed(() => nextTutorialId(s.info?.tutorialId, tutorialItems.value));
    async function refreshTutorialCatalog() {
      const catalog = await api('/api/tutorial');
      tutorialItems.value = catalog.items || [];
      if (state.me) state.me.tutorialIntroRequired = !!catalog.introRequired;
    }
    async function startNextTutorial() {
      if (!nextCourse.value || tutorialSaving.value) return;
      tutorialSaving.value = true;
      try {
        await refreshTutorialCatalog();
        if (!nextCourse.value) { location.hash = '#/tutorial'; return; }
        const next = await api('/api/tutorial/start', { method: 'POST', body: { tutorialId: nextCourse.value } });
        saveTour(next.guided ? { docId: next.docId, i: 0 } : null);
        location.hash = `#/doc/${next.docId}`;
      } catch (e) { toastError(e, '다음 튜토리얼을 열지 못했습니다: '); }
      finally { tutorialSaving.value = false; }
    }
    async function completeTutorial() {
      if (tutorialSaving.value) return false;
      tutorialSaving.value = true;
      try {
        await d.saveDraftNow();
        if (s.draft.dirty || s.draft.saving) throw new Error('편집 내용이 저장된 뒤 다시 완료해 주세요');
        const result = await api(`/api/tutorial/${props.id}/complete`, { method: 'POST', body: {} });
        clearTour(props.id); tour?.stop({ save: false }); tour = null;
        Object.assign(s.info, { tutorialSession: false, tutorialCompletedAt: result.completedAt });
        await refreshTutorialCatalog().catch(() => {});
        await d.refresh().catch(() => {});
        toast('튜토리얼을 완료해 내 문서함에 저장했습니다');
        return true;
      } catch (e) { toastError(e, '튜토리얼을 저장하지 못했습니다: '); return false; }
      finally { tutorialSaving.value = false; }
    }
    let tour = null; let tutorialClosed = false; let tourStartGeneration = 0; const tourPaused = ref(false);
    let tourRead = false;
    async function readInitialTour() {
      if (!tourOn.value || tour || tourRead) return;
      tourRead = true;
      try {
        await loadTour(props.id);
        if (tutorialClosed || !props.active) { tourRead = false; return; }
        const showIntro = state.tutorialIntroDocId === props.id;
        const resume = state.tutorialResumeDocId === props.id;
        if (resume) state.tutorialResumeDocId = null;
        if (showIntro) state.tutorialIntroDocId = null;
        await startTourHere({ showIntro, resume });
      } catch (e) { tourPaused.value = true; toastError(e, '안내 진행 정보를 읽지 못했습니다: '); }
    }
    async function startTourHere({ showIntro = false, resume = false } = {}) {
      const generation = ++tourStartGeneration;
      for (let k = 0; k < 150 && !(s.editor?.ready && s.paragraphs?.length) && !tutorialClosed && props.active && generation === tourStartGeneration; k++) await new Promise((r) => setTimeout(r, 200));
      if (tutorialClosed || !props.active || !tourOn.value || generation !== tourStartGeneration) { if (!tour) tourRead = false; return; }
      if (!(s.editor?.ready && s.paragraphs?.length)) { tourPaused.value = true; toast('편집기가 아직 준비되지 않았습니다. 준비된 뒤 [튜토리얼 계속하기]를 눌러 주세요.'); return; }
      if (tour) tour.stop();
      const m = await import('./tutorial.js');
      await refreshTutorialCatalog().catch(() => { tutorialItems.value = []; });
      if (tutorialClosed || !props.active || !tourOn.value || generation !== tourStartGeneration) { if (!tour) tourRead = false; return; }
      const saved = m.tourState(props.id);
      if (saved?.ctx?.guidePaused && !resume) { tourPaused.value = true; return; }
      if (saved?.ctx) saved.ctx.guidePaused = false;
      tourPaused.value = false;
      tour = m.runTour({ d, docId: props.id, host: rootEl.value.parentElement, topBar: document.querySelector('[data-testid="office-primary-row"]'), me: state.me, config: state.config, showIntro, onComplete: completeTutorial,
        onReload: () => emit('restore', props.id),
        onRestore: async value => {
          tour = null;
          if (value.recoveryFallback?.reason === 'AI_IN_FLIGHT') {
            try { sessionStorage.setItem(`hwpx.tutorial-recovery-notice:${props.id}`, 'AI_IN_FLIGHT'); } catch { /* 알림만 생략 */ }
          }
          emit('restore', props.id);
        },
        onNext: nextCourse.value ? startNextTutorial : null, onEnd: ({ done }) => {
        tour = null; tourPaused.value = !done;
        if (!done) toast('안내를 닫았습니다. 자유롭게 편집한 뒤 [튜토리얼 계속하기]로 이어가세요.');
      } });
    }
    async function openTour() {
      tour?.stop(); tour = null;
      try { await loadTour(props.id); await startTourHere({ resume: true }); }
      catch (e) { tourPaused.value = true; toastError(e, '튜토리얼 안내를 다시 열지 못했습니다: '); }
    }
    onBeforeUnmount(() => {
      viewClosed = true;
      recoveryRequests.abort();
      tutorialClosed = true;
      tourStartGeneration++;
      automationClosed = true; clearInterval(automationPoll); clearInterval(overTimer); clearTimeout(peekTimer); clearTimeout(edgeTimer); clearTimeout(foldTimer);
      deactivateView();
      try {
        frameDoc?.removeEventListener('pointerdown', onFrameDown, true);
        frameDoc?.removeEventListener('pointermove', onFrameMove, true);
        frameDoc?.removeEventListener('keydown', onFrameKey, true);
        frameDoc?.removeEventListener('focusin', onFrameFocus, true);
      } catch { /* 편집기 창이 이미 없음 */ }
      stackQuery.removeEventListener('change', onStack);
      removeEventListener('beforeunload', onBeforeUnload);
      if (officeDocs.get(props.id) === session) officeDocs.delete(props.id);
      try { tour?.stop(); } catch { /* 없음 */ }
      for (const off of offs) off();
      try { handle?.destroy(); } catch { /* 이미 없음 */ }
      d.close();
      if (window.__doc === d) delete window.__doc;
    });
    return {
      d, s, ed, rootEl, editorEl, active, ICON, browserPersonal: !!state.me?.browserPersonal, recoveryFiles, canRename, titleEdit, titleInp, renameTrigger, editTitle, cancelTitle, saveTitle, rebasing, carrying, saving, tabs, curTab, composerTitle, chip, compactStatus, behind, behindTip, verLabel, verTitle, localTip, localLabel, unsupportedTip, people, present, agentLabel, crChip, crChipTip, myRole, isAdmin, showAdmin, serverNotice,
      agentTip, stacked, panel, panelVars, resizing, foldHint, splitTip, pickTab, startResize, resetPanel, keyResize, moreOpen, moreEl, popoverEl, statusTrigger, actionTrigger, toggleMore, closeMore, onMoreFocusOut, tools, toggleTools, mobileEnvironment, openMobileOptions,
      folded, peek, panelEl, openPeek, togglePin, edgeTip, aiGlance, onTabEnter, onTabLeave, onPanelEnter, onPanelLeave, onPanelFocusOut,
      memosOn, toggleMemos, movedMemos, resetMemoPos, railOver, over, overStyle,
      documentView, toggleDocumentView,
      realtime, liveMode, liveDoc, saveTip, leftover, loBusy, loConfirm, loMsg, VIEW_LABEL,
      retrySave, keepMine, carryMine, rebase, openSubmit, openCr, openDocumentHelp, agentHelpHash, saveHangul, mergeLeftover, closeLeftover, remount, go, clip,
      tourOn, tourPaused, openTour, tutorialSaving, completeTutorial, startNextTutorial, nextCourse, stateMeTutorial,
    };
  },
};

const App = {
  components: { Login, DocList, DocView, HelpDialog, AdminServerPanel, TutorialMenu, AdminTokenNotice },
  template: `<div class="app office-app">
    <Login v-if="!state.me && ready"/>
    <header v-if="state.me" class="office-bar" aria-label="문서 작업 공간" data-testid="office-primary-row" :inert="introOpen">
      <div class="office-product-menu-wrap" ref="productMenuWrap">
        <button ref="productMenuButton" type="button" class="office-action office-app-menu" data-testid="office-app-menu"
          :disabled="windowClosing" :aria-expanded="hasApplicationMenu ? undefined : productMenuOpen" aria-label="HWPX Cowork 메뉴" title="HWPX Cowork 메뉴" @click="openApplicationMenu"><img class="office-product-icon" src="/icons/icon-128.png" width="24" height="24" alt=""><span class="office-action-text toolbar-label">HWPX Cowork</span></button>
        <div v-if="productMenuOpen" class="office-product-menu" data-testid="office-product-menu">
          <a href="https://github.com/nagmint12/hwpxcowork#readme" target="_blank" rel="noopener" @click="closeProductMenu(true)">HWPX Cowork 정보</a>
          <a href="https://github.com/nagmint12/hwpxcowork/releases/latest" target="_blank" rel="noopener" @click="closeProductMenu(true)">다운로드</a>
          <button type="button" data-testid="cowork-tutorial" @click="openTutorial">튜토리얼</button>
          <button type="button" data-testid="cowork-intro" @click="openIntro">소개 영상 보기</button>
        </div>
      </div>
      <button ref="homeButton" type="button" class="office-action office-library-home" data-testid="office-library" :aria-current="isLibrary ? 'page' : null"
        :disabled="windowClosing" title="문서함 (메인 화면)" aria-label="문서함 (메인 화면)" @click="goLibrary"><span class="ic" aria-hidden="true" v-html="ICON.folder"></span><span class="office-action-text toolbar-label">문서함</span></button>
      <div class="office-tablist" role="tablist" aria-label="열린 문서" aria-orientation="horizontal" @wheel="scrollTabs" @keydown="onTabKey" v-if="tabs.items.length">
        <div v-for="tab in tabs.items" :key="tab.id" role="presentation" class="office-tab-item" :class="{selected: tab.id === docId}">
          <button type="button" class="office-tab" role="tab" :id="tabId(tab.id)" :aria-selected="tab.id === docId" :aria-controls="panelId(tab.id)" :tabindex="tab.id === tabStopId ? 0 : -1"
            data-testid="office-tab" :data-doc-id="tab.id" :title="tabLabel(tab)" :aria-label="tabLabel(tab)" :aria-busy="tab.closing || tab.saving || reviewedSavings.has(tab.id)" :disabled="windowClosing" @click="activateTab(tab.id)">
            <span class="office-tab-icon" aria-hidden="true" v-html="ICON.file"></span>
            <span class="office-tab-name" :class="{ split: officeNames.get(tab.id)?.prefix }" :data-testid="tab.id === docId ? 'doc-title' : undefined">
              <template v-if="officeNames.get(tab.id)?.prefix"><span class="office-tab-prefix">{{ officeNames.get(tab.id).prefix }}</span><span class="office-tab-suffix">{{ officeNames.get(tab.id).suffix }}</span></template>
              <template v-else>{{ tab.title }}</template>
            </span>
            <span v-if="officeNames.get(tab.id)?.duplicate" class="office-tab-number" aria-hidden="true">{{ officeNames.get(tab.id).duplicate }}</span>
            <span v-if="tab.failed || tab.unavailable" class="office-tab-state failed" aria-hidden="true">!</span><span v-else-if="tab.dirty" class="office-tab-state" aria-hidden="true">●</span>
          </button>
          <button type="button" class="office-tab-close" tabindex="-1" data-testid="office-tab-close" :data-doc-id="tab.id" :disabled="tab.closing || windowClosing"
            :title="tab.closing ? '저장 중' : '탭 닫기'" :aria-label="tab.title + ' 탭 닫기'" @click="closeTab(tab.id, true)">
            <span v-if="tab.closing" class="spin dark" aria-hidden="true"></span><span v-else aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      <button type="button" class="office-action" data-testid="office-new-document" :disabled="windowClosing" title="새 문서" aria-label="새 문서" @click="newDocument"><span class="ic" aria-hidden="true" v-html="ICON.plus"></span></button>
      <button type="button" class="office-action" data-testid="office-open-files" :disabled="opening || windowClosing" :aria-busy="opening" :title="openFilesTip" @click="pickFiles">
        <span v-if="opening" class="spin dark" aria-hidden="true"></span><span v-else class="ic" aria-hidden="true" v-html="ICON.file"></span><span class="office-action-text toolbar-label">파일 열기</span></button>
      <input ref="fileInput" type="file" :accept="state.me?.browserPersonal ? '.hwpx,.hwp' : '.hwpx'" multiple hidden data-testid="office-file-input" @change="filesPicked"/>
      <small v-if="opening" class="office-visually-hidden" role="status">파일 여는 중…</small>
      <div id="office-document-controls" :inert="windowClosing || !!tabs.find(docId)?.closing"></div>
    </header>
    <aside v-if="closeIssue" class="office-close-problem" data-testid="office-close-problem" :data-doc-id="closeIssue.id" aria-label="탭 닫기 확인" @keydown.esc.stop.prevent="cancelCloseIssue">
      <div class="office-close-message" role="status">
        <strong>‘{{ closeIssue.title }}’</strong>
        <template v-if="discardConfirm"> 이 탭에서 저장되지 않은 변경과 작성 중인 내용을 버리고 닫을까요?</template>
        <template v-else> 탭을 닫기 전에 저장을 마치지 못했습니다. 작성한 내용은 탭에 남아 있습니다.<span v-if="closeIssue.message" class="office-close-detail">{{ closeIssue.message }}</span></template>
      </div>
      <div class="office-close-actions" v-if="discardConfirm">
        <button ref="cancelDiscard" type="button" class="small" data-testid="office-close-cancel" @click="cancelCloseIssue">취소</button>
        <button type="button" class="small danger" data-testid="office-close-discard-confirm" :disabled="windowClosing" @click="discardFailedTab">변경 버리고 닫기</button>
      </div>
      <div class="office-close-actions" v-else>
        <button ref="retryButton" type="button" class="small" data-testid="office-close-retry" :disabled="windowClosing" @click="retryCloseIssue">저장 재시도</button>
        <button type="button" class="small" data-testid="office-close-discard" :disabled="windowClosing" @click="askDiscard">변경 버리고 닫기…</button>
        <button type="button" class="small" data-testid="office-close-cancel" @click="cancelCloseIssue">취소</button>
      </div>
    </aside>
    <div v-if="state.me" class="office-workspace" :inert="windowClosing || introOpen">
      <section v-for="tab in tabs.items" :key="tab.id" :id="panelId(tab.id)" role="tabpanel" :aria-labelledby="tabId(tab.id)"
        class="office-document" :class="{parked: tab.id !== docId}" :aria-hidden="tab.id !== docId" :inert="tab.id !== docId || tab.closing"
        data-testid="office-document" :data-doc-id="tab.id">
        <div :id="overlayId(tab.id)"></div>
        <DocView v-if="tab.visited" :key="tab.generation || 0" :id="tab.id" :active="tab.id === docId" @state="updateTab" @unavailable="documentUnavailable" @restore="restoreTab"/>
      </section>
      <TutorialMenu v-if="!docId && tutorialRoute"/>
      <main v-else-if="!docId && adminRoute" class="admin-page"><AdminServerPanel v-if="state.me.role==='admin'" :prepare-restart="saveAllTabs"/>
        <section v-else class="admin-denied" data-testid="admin-denied"><h1>관리자만 사용할 수 있습니다</h1><p>서버 설정은 관리자에게 요청하세요.</p><a href="#/">문서 목록으로</a></section></main>
      <DocList v-else-if="!docId" ref="library" @open="openDocument" @logout="logout"/>
    </div>
    <AdminServerPanel v-if="adminOpen && state.me?.role==='admin'" modal :prepare-restart="adminContext?.prepareRestart" @close="adminOpen = false"/>
    <div v-if="introOpen" class="office-intro-overlay" @pointerdown.self="closeIntro">
      <section class="office-intro-dialog" role="dialog" aria-modal="true" aria-labelledby="office-intro-title" data-testid="cowork-intro-dialog" @keydown.esc.stop.prevent="closeIntro">
        <header><h2 id="office-intro-title">HWPX Cowork 소개 영상</h2><button ref="introClose" type="button" data-testid="cowork-intro-close" @click="closeIntro">닫기</button></header>
        <iframe title="HWPX Cowork 소개 영상" src="/teaser/" allow="autoplay" @load="bindIntroEscape"></iframe>
      </section>
    </div>
    <HelpDialog/>
    <AdminTokenNotice v-if="tokenNotice && state.me" @close="tokenNotice = false"/>
    <div class="toasts" aria-live="polite"><div class="toast" v-for="t in toasts" :key="t.id" :class="t.kind">{{ t.msg }}</div></div></div>`,
  setup() {
    const ready = ref(false);
    const adminRoute = computed(() => !state.me?.browserPersonal && /^#\/admin(?:[/?]|$)/.test(state.route));
    const tutorialRoute = computed(() => /^#\/tutorial(?:[/?]|$)/.test(state.route));
    const docId = computed(() => docOf(state.route));
    const isLibrary = computed(() => !docId.value && !adminRoute.value && !tutorialRoute.value);
    const tabs = reactive(createTabs());
    const officeNames = computed(() => officeTabNames(tabs.items));
    const tabStopId = computed(() => docId.value || tabs.visits[0] || tabs.items[0]?.id);
    const reviewedSavings = computed(() => new Set(retainedDocIds.value.filter(id => retainedSaves.status(id)?.running)));
    const fileInput = ref(null); const homeButton = ref(null); const library = ref(null);
    const windowClosing = ref(false); const opening = ref(false);
    const closeIssue = ref(null); const discardConfirm = ref(false);
    const cancelDiscard = ref(null); const retryButton = ref(null);
    const desktop = window.hwpxDesktopEnvironment;
    const hasApplicationMenu = typeof desktop?.openApplicationMenu === 'function';
    const productMenuOpen = ref(false); const productMenuWrap = ref(null); const productMenuButton = ref(null);
    const introOpen = ref(false); const introClose = ref(null);
    function closeProductMenu(restoreFocus = false) {
      if (!productMenuOpen.value) return;
      productMenuOpen.value = false;
      if (restoreFocus) productMenuButton.value?.focus({ preventScroll: true });
    }
    function openApplicationMenu() {
      if (hasApplicationMenu) { desktop.openApplicationMenu(); return; }
      productMenuOpen.value = !productMenuOpen.value;
    }
    function productOutside(event) {
      if (!productMenuWrap.value?.contains(event.target)) closeProductMenu();
    }
    function productEscape(event) {
      if (event.key === 'Escape' && productMenuOpen.value) { event.preventDefault(); closeProductMenu(true); }
    }
    const productBlur = () => closeProductMenu();
    function openTutorial() {
      closeProductMenu();
      if (state.me) void navigate('#/tutorial');
    }
    async function openIntro() {
      closeProductMenu();
      introOpen.value = true;
      await nextTick();
      introClose.value?.focus({ preventScroll: true });
    }
    async function closeIntro() {
      introOpen.value = false;
      await nextTick();
      productMenuButton.value?.focus({ preventScroll: true });
    }
    function bindIntroEscape(event) {
      event.target.contentWindow?.addEventListener('keydown', key => {
        if (key.key === 'Escape') { key.preventDefault(); void closeIntro(); }
      });
    }
    const editingRowVisible = ref(true);
    try { editingRowVisible.value = localStorage.getItem(EDITING_ROW_KEY) !== 'hidden'; } catch { /* 기본값 유지 */ }
    watch(editingRowVisible, shown => {
      try { localStorage.setItem(EDITING_ROW_KEY, shown ? 'shown' : 'hidden'); } catch { /* 저장소 사용 불가 */ }
    });
    provide('officeEditingRowVisible', editingRowVisible);
    let exitAttempt = 0; let nativeCloseToken = null;
    const openFilesTip = window.hwpxPages ? '선택한 파일의 사본을 이 브라우저의 문서함에 저장합니다.' : 'HWPX를 선택하면 내 개인 문서함에 사본을 만들고 탭에서 엽니다.';
    const adminOpen = ref(false); const adminContext = ref(null); const tokenNotice = ref(false);
    provide('openAdmin', (context) => { if (state.me?.role !== 'admin') return; adminContext.value = context; adminOpen.value = true; });
    provide('prepareOfficeRestart', saveAllTabs);
    provide('officeKeyboard', onOfficeKey);

    let routeGeneration = 0; let leaving = null;
    function setRoute(route, replace = false) {
      if (location.hash !== route) {
        if (replace) history.replaceState(null, '', route);
        else history.pushState(null, '', route);
      }
      state.route = route;
    }
    async function navigate(route) {
      const generation = ++routeGeneration;
      if (route === state.route) return true;
      const previous = docId.value;
      const session = officeDocs.get(previous);
      if (session && docOf(route) !== previous) {
        if (!leaving) leaving = session.leaveTutorial().catch(e => { toastError(e); return false; }).finally(() => { leaving = null; });
        const allowed = await leaving;
        if (generation !== routeGeneration) return false;
        if (!allowed) { setRoute(state.route, true); return false; }
        session.backgroundSave();
      }
      setRoute(route);
      return true;
    }
    const onHashChange = () => { if (!windowClosing.value) void navigate(location.hash || '#/'); };
    watch([() => state.me, docId], ([me, id]) => { if (me && id) tabs.visit(id); }, { flush: 'sync' });
    function scrollToTab(id, focus = false) {
      if (id !== docId.value) return;
      const element = document.getElementById(tabId(id));
      if (focus) element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    watch(docId, id => { if (id) scrollToTab(id); }, { flush: 'post' });
    async function activateTab(id, target = 'work') {
      if (!tabs.find(id)) return;
      const navigation = navigate(routeOf(id));
      const generation = routeGeneration;
      if (!await navigation) return;
      await nextTick();
      const canRestore = () => generation === routeGeneration && id === docId.value && !windowClosing.value
        && !tabs.find(id)?.closing && !document.querySelector('dialog[open]');
      if (!canRestore()) return;
      scrollToTab(id);
      const restored = target === 'work' && await officeDocs.get(id)?.restoreWorkFocus(canRestore);
      if (!restored && canRestore()) scrollToTab(id, true);
    }
    function updateTab(id, updates) {
      const tab = tabs.find(id); if (tab) Object.assign(tab, updates);
    }
    function openDocument(doc) {
      tabs.add(doc);
      return activateTab(doc.id);
    }
    function goLibrary() { return navigate('#/'); }
    async function newDocument() {
      if (!await goLibrary()) return;
      await nextTick();
      await library.value?.beginNewDocument();
    }
    function removeTab(id) {
      const next = tabs.remove(id);
      retainedSaves.discard(id);
      if (closeIssue.value?.id === id) { closeIssue.value = null; discardConfirm.value = false; }
      if (docId.value === id) { ++routeGeneration; setRoute(routeOf(next), true); }
    }
    async function focusCurrentTab() {
      await nextTick();
      if (docId.value) scrollToTab(docId.value, true);
      else homeButton.value?.focus();
    }
    function reportCloseIssue(tab, error) {
      closeIssue.value = { id: tab.id, title: tab.title, message: error?.message };
      discardConfirm.value = false;
      nextTick(() => retryButton.value?.focus({ preventScroll: true }));
    }
    async function closeTab(id, focus = false) {
      const tab = tabs.find(id);
      if (!tab || tab.closing || windowClosing.value) return;
      tab.closing = true;
      try {
        await nextTick();
        const session = officeDocs.get(id);
        if (session && !await session.prepareClose()) return;
        removeTab(id);
      } catch (error) {
        reportCloseIssue(tab, error);
      } finally {
        tab.closing = false;
        if (focus && closeIssue.value?.id !== id) await focusCurrentTab();
      }
    }
    function cancelCloseIssue() {
      if (discardConfirm.value) {
        discardConfirm.value = false;
        nextTick(() => retryButton.value?.focus({ preventScroll: true }));
        return;
      }
      closeIssue.value = null;
      void focusCurrentTab();
    }
    function askDiscard() {
      discardConfirm.value = true;
      nextTick(() => cancelDiscard.value?.focus({ preventScroll: true }));
    }
    function retryCloseIssue() {
      const id = closeIssue.value?.id;
      if (!id) return;
      closeIssue.value = null;
      void closeTab(id, true);
    }
    async function discardFailedTab() {
      const id = closeIssue.value?.id;
      const tab = tabs.find(id);
      if (!discardConfirm.value || !tab || tab.closing || windowClosing.value) return;
      tab.closing = true;
      try {
        await officeDocs.get(id)?.discardLocalChanges();
        removeTab(id);
      } finally {
        tab.closing = false;
        await focusCurrentTab();
      }
    }
    function documentUnavailable(id, reason) {
      const tab = tabs.find(id); const session = officeDocs.get(id);
      if (!tab || tab.closing || tab.unavailable) return;
      const why = reason === 'deleted' ? '문서가 삭제됐습니다.' : '문서에 접근할 수 없습니다.';
      if (session?.bodyNeedsSave() || session?.hasUnsentInput()) {
        updateTab(id, { failed: true, unavailable: true });
        toast(`‘${tab.title}’ ${why} 작성한 내용은 열린 탭에서 확인할 수 있습니다.`, { kind: 'warn', ms: 9000 });
      } else {
        removeTab(id);
        toast(`‘${tab.title}’ ${why}`);
      }
    }
    function restoreTab(id) {
      const tab = tabs.find(id); if (!tab) return;
      retainedSaves.discard(id);
      Object.assign(tab, { generation: (tab.generation || 0) + 1, dirty: false, saving: false, failed: false });
    }
    function tabLabel(tab) {
      const duplicate = officeNames.value.get(tab.id)?.duplicate;
      const title = duplicate ? tab.title + ' · 같은 이름의 탭 ' + duplicate : tab.title;
      if (tab.failed || tab.unavailable) return title + ' · 저장 상태 확인';
      if (tab.saving || tab.closing || reviewedSavings.value.has(tab.id)) return title + ' · 저장 중';
      if (tab.dirty) return title + ' · 저장되지 않은 변경';
      return title;
    }
    function cycleTab(step) {
      const next = tabs.cycle(docId.value, step);
      if (next) void activateTab(next);
    }
    function onTabKey(event) {
      const id = event.target.dataset?.docId;
      if (!id || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs.cycle(id, event.key === 'ArrowRight' ? 1 : -1);
      else if (event.key === 'Home') next = tabs.items[0]?.id;
      else if (event.key === 'End') next = tabs.items.at(-1)?.id;
      else if (event.key === 'Delete') { event.preventDefault(); void closeTab(id, true); return; }
      if (next) { event.preventDefault(); void activateTab(next, 'tab'); }
    }
    function onOfficeKey(event) {
      if (!state.me || windowClosing.value || event.defaultPrevented || event.altKey || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'tab' && tabs.items.length) { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
      else if (key === 'w' && docId.value && !event.shiftKey) { event.preventDefault(); void closeTab(docId.value, true); }
      else if (key === 'o' && !event.shiftKey) { event.preventDefault(); pickFiles(); }
    }
    function scrollTabs(event) {
      const strip = event.currentTarget;
      if (event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 20 : 1);
    }

    function pickFiles() {
      if (!state.me || opening.value || windowClosing.value) return;
      if (desktop?.pickOfficeFiles) desktop.pickOfficeFiles();
      else fileInput.value?.click();
    }
    let lastBatch = null;
    let pendingImports = Promise.resolve(); let importCount = 0;
    async function importFiles(files, where, me) {
      let first;
      for (const input of files) {
        try {
          const source = typeof input.source === 'string' ? input.source : undefined;
          let tab = tabs.fromSource(source);
          if (!tab) {
            const name = officeFileName(input.name, state.me?.browserPersonal);
            const body = await officeFileBytes(input);
            if (!body?.byteLength) throw new Error('파일에 내용이 없습니다.');
            const doc = await api('/api/docs', { method: 'POST', body, raw: true, headers: { ...uploadHeaders(where), 'x-file-name': encodeURIComponent(name) } });
            if (state.me !== me) continue;
            tabs.add({ ...doc, source });
            tab = tabs.find(doc.id);
          }
          if (!input.batch || input.batch !== lastBatch) {
            first ||= tab.id;
            lastBatch = input.batch || null;
          }
        } catch (error) { toastError(error, `${String(input.name || '파일').split(/[\\/]/).pop()} 열기 실패. `); }
      }
      if (first && state.me === me) await activateTab(first);
      await library.value?.refresh();
    }
    function queueFiles(files) {
      if (!Array.isArray(files) || !files.length) return;
      files = files.filter(file => file && typeof file === 'object');
      const acknowledge = () => { for (const input of files) if (input.receipt) desktop?.finishOfficeFile?.(input.receipt); };
      const me = state.me;
      if (!me || windowClosing.value) {
        acknowledge();
        return;
      }
      const where = libraryLocation();
      opening.value = true;
      importCount++;
      pendingImports = pendingImports.then(() => importFiles(files, where, me)).catch(toastError).finally(() => {
        opening.value = --importCount > 0;
        acknowledge();
      });
    }
    function filesPicked(event) {
      const files = [...event.currentTarget.files]; event.currentTarget.value = '';
      queueFiles(files);
    }

    async function saveAllTabs() {
      for (const tab of tabs.items) {
        try { await officeDocs.get(tab.id)?.saveForClose(); }
        catch (error) { toastError(error, `‘${tab.title}’ 저장 실패. `); return false; }
      }
      return true;
    }
    async function prepareExit() {
      if (windowClosing.value || tabs.items.some(tab => tab.closing)) return false;
      const attempt = ++exitAttempt;
      windowClosing.value = true;
      try {
        await nextTick();
        await pendingImports;
        for (const tab of tabs.items) {
          if (attempt !== exitAttempt) return false;
          try { if (await officeDocs.get(tab.id)?.prepareClose() === false) return false; }
          catch (error) { reportCloseIssue(tab, error); return false; }
        }
        if (attempt !== exitAttempt) return false;
        preparedExit = true;
        return true;
      } finally { if (attempt === exitAttempt && !preparedExit) windowClosing.value = false; }
    }
    async function logout() {
      if (!await prepareExit()) return;
      try {
        for (const id of retainedDocIds.value) retainedSaves.discard(id);
        tabs.items = []; tabs.visits = [];
        try { localStorage.removeItem('hwpx.token'); } catch { /* 저장소를 쓸 수 없는 환경 */ }
        state.token = ''; state.me = null; setRoute('#/', true);
      } finally { windowClosing.value = false; preparedExit = false; }
    }
    function onNativeCommand(event) {
      if (!state.me || windowClosing.value) return;
      if (event.detail === 'open-files') pickFiles();
      else if (event.detail === 'tutorial') openTutorial();
      else if (event.detail === 'intro') void openIntro();
      else if (event.detail === 'new-document') void newDocument();
      else if (event.detail === 'close-tab' && docId.value) void closeTab(docId.value, true);
      else if (event.detail === 'next-tab') cycleTab(1);
      else if (event.detail === 'previous-tab') cycleTab(-1);
      else if (event.detail === 'library') void goLibrary();
      else if (event.detail === 'refresh-library') void library.value?.refresh();
    }
    const onNativeFiles = event => queueFiles(event.detail);
    async function onNativeClose(event) {
      if (typeof event.detail !== 'string' || !desktop?.finishClosing) return;
      const token = event.detail;
      nativeCloseToken = token;
      let allowed = false;
      try { allowed = await prepareExit(); }
      catch (error) { toastError(error, '창을 닫지 못했습니다. '); }
      if (nativeCloseToken !== token) return;
      desktop.finishClosing(token, allowed);
      if (!allowed) nativeCloseToken = null;
    }
    function onNativeCancelClose(event) {
      if (event.detail !== nativeCloseToken) return;
      nativeCloseToken = null;
      ++exitAttempt;
      preparedExit = false;
      windowClosing.value = false;
    }
    onMounted(async () => {
      addEventListener('hashchange', onHashChange);
      addEventListener('pointerdown', productOutside, true);
      addEventListener('keydown', productEscape, true);
      addEventListener('blur', productBlur);
      addEventListener('keydown', onOfficeKey, true);
      addEventListener('hwpx-office-command', onNativeCommand);
      addEventListener('hwpx-office-files', onNativeFiles);
      addEventListener('hwpx-office-prepare-close', onNativeClose);
      addEventListener('hwpx-office-cancel-close', onNativeCancelClose);
      try { state.config = await (await fetch('/api/config')).json(); } catch { state.config = {}; }
      if (state.token) { try { await enterApp(await api('/api/me')); } catch (e) { if (e.status !== 401) toastError(e, '화면을 열지 못했습니다: '); state.token = ''; } }
      tokenNotice.value = shouldShowTokenNotice({ me: state.me, viaLink: viaTokenLink, storage: localStorage });
      ready.value = true;
    });
    watch(() => ready.value && !!state.me, value => { if (value) desktop?.markOfficeTabsReady?.(); }, { flush: 'post' });
    onBeforeUnmount(() => {
      removeEventListener('hashchange', onHashChange);
      removeEventListener('pointerdown', productOutside, true);
      removeEventListener('keydown', productEscape, true);
      removeEventListener('blur', productBlur);
      removeEventListener('keydown', onOfficeKey, true);
      removeEventListener('hwpx-office-command', onNativeCommand);
      removeEventListener('hwpx-office-files', onNativeFiles);
      removeEventListener('hwpx-office-prepare-close', onNativeClose);
      removeEventListener('hwpx-office-cancel-close', onNativeCancelClose);
    });
    return {
      state, docId, tabs, officeNames, tabId, panelId, overlayId, tabStopId, reviewedSavings, tabLabel, ICON, isLibrary, opening, windowClosing, fileInput, homeButton, library, openFilesTip, hasApplicationMenu, openApplicationMenu,
      productMenuOpen, productMenuWrap, productMenuButton, closeProductMenu, openTutorial, openIntro, introOpen, introClose, closeIntro, bindIntroEscape,
      activateTab, closeTab, scrollTabs, onTabKey, goLibrary, newDocument, pickFiles, filesPicked, openDocument, updateTab, documentUnavailable, restoreTab, logout, saveAllTabs,
      closeIssue, discardConfirm, cancelDiscard, retryButton, cancelCloseIssue, askDiscard, retryCloseIssue, discardFailedTab,
      toasts, ready, adminRoute, tutorialRoute, adminOpen, adminContext, tokenNotice,
    };
  },
};
createApp(App).mount('#app');
