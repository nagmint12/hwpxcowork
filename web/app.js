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
import { createApp, ref, computed, provide, inject, watch, onMounted, onBeforeUnmount, nextTick, markRaw } from '/vendor/vue.esm-browser.prod.js';
import { state, api, toast, toasts, toastError, fmt, isTyping, clip, kindLabel, roleLabel, josa, versionTip, milestoneAt, workEnv, docWorkEnv, agentEnvName, personalEnvName, presets, NO_AI_TIP, CONNECT_HELP } from './util.js';
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
import { liveChip, exportTip, READONLY_TIP, VIEW_LABEL, PANEL, readPanel, writePanel, clampPanelW, clampPanelH, panelHeightFrom, panelWidthFrom, marginBox, railVisible, readMemoPos, writeMemoPos, readTools, writeTools } from './view.js';
import { connectionUrls } from './connections.js';
import { HelpDialog } from './help-dialog.js';
import { AdminServerPanel } from './admin.js';
import { PersonalAiPanel, AiRunPanel } from './personal-ai.js';
import { OrchestrationPanel } from './orchestration.js';
import { DriveTab } from './drive.js';
import { ICON } from './icons.js';
import { LocalFoldersDialog, ReviewServersDialog, ReviewDialog, localTip, localLabel } from './local.js';
import { LibraryTree, AccessDialog, MoveDialog, NameDialog, PUBLIC_ROOT, parseLocKey, locKey, locExists, foldersAt, docsAt, crumbs, permsAt, docLoc, docBadge, SORTS, DEFAULT_SORT, sortOk, sortDocs, sortFolders, nextSort } from './library.js';

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

// 화면을 옮기기 전에 할 일(문서 화면이 단다: 저장 안 된 편집 저장 → 저장하지 못했으면 나갈지 묻기). 브라우저 '뒤로'·주소 바꾸기·'← 목록'도
// 여기를 지난다. guard() → false 면 머문다(주소를 되돌린다 — 편집기와 그 안 글이 그대로). 같은 문서 안의 주소 바꾸기(?legacy=1 등)는 화면을 옮기지 않는다
let leaveGuard = null;
let routeGen = 0; let leaving = null;
const docOf = (route) => (/^#\/doc\/([\w-]+)/.exec(route || '') || [])[1] || null;
window.addEventListener('hashchange', async () => {
  const gen = ++routeGen;
  const next = location.hash || '#/';
  const guard = leaveGuard;
  if (guard && next !== state.route && docOf(next) !== docOf(state.route)) {
    // 잇달아 옮기면(두 번 누름) 확인은 한 번만
    if (!leaving) leaving = Promise.resolve().then(guard).catch(e => { toastError(e, '문서를 나가기 전에 상태를 확인하지 못했습니다: '); return false; }).finally(() => { leaving = null; });
    const go = await leaving;
    if (gen !== routeGen) return;   // 그사이 또 옮겼다 — 나중 것이 맡는다
    if (go === false) { try { history.replaceState(null, '', state.route); } catch { /* 옛 브라우저 */ } return; }
  }
  state.route = location.hash || '#/';
});
// #/t/<토큰>[/doc/<id>] : 토큰을 저장하고 이동(관리자가 링크로 나눠 줄 때)
(function tokenRoute() {
  const m = /^#\/t\/([^/]+)(\/.*)?$/.exec(location.hash || '');
  if (m) { const t = decodeURIComponent(m[1]); try { localStorage.setItem('hwpx.token', t); } catch { /* 저장 불가 */ } state.token = t; location.hash = m[2] ? `#${m[2]}` : '#/'; state.route = location.hash; }
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
  template: `<div class="login"><h1>HWPX 공동 검토</h1>
    <p class="muted">관리자에게 받은 접속 토큰을 넣으세요.</p>
    <p class="muted">체험용 접속 토큰: <strong>test1 ~ test100</strong> 중 하나를 입력하세요.</p>
    <input v-model="token" placeholder="토큰" @keyup.enter="go" aria-label="접속 토큰"/>
    <p class="err" v-if="err">{{ err }}</p>
    <div class="login-actions"><button class="primary" :disabled="busy" @click="go">{{ busy ? '여는 중…' : '들어가기' }}</button><a class="login-guide" href="/help.html#join" target="_blank" rel="noopener" data-testid="help-login">사용설명서</a><a class="login-video" href="/teaser/?intro=1&next=%2F%3Fteaser%3D0" data-testid="intro-replay">소개 영상 다시 보기</a><a class="login-guide" href="/onboarding.html?next=%2F%3Fteaser%3D0" data-testid="onboarding-replay">나에게 맞게 시작하기</a></div>
    <p class="muted" style="margin-top:16px">본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. 편집기는 rhwp(MIT)입니다.</p></div>`,
  setup() {
    const token = ref(state.token); const err = ref(''); const busy = ref(false);
    async function go() {
      if (busy.value) return;
      busy.value = true; err.value = ''; state.token = token.value.trim();
      try { const me = await api('/api/me'); await enterApp(me, '#/'); try { localStorage.setItem('hwpx.token', state.token); } catch { /* ignore */ } }
      catch (e) { err.value = e.status === 401 ? '토큰이 올바르지 않습니다' : `화면을 열지 못했습니다: ${e.message}`; }
      finally { busy.value = false; }
    }
    return { token, err, busy, go };
  },
};

// ───────── 문서 목록(문서함 — docs/LIBRARY_SPEC.md §4) ─────────
// 왼쪽 문서함 나무(공용 · 개인 · 공유받은) | 오른쪽 위치 줄 · [새 폴더] [올리기] [권한] · 폴더와 문서 목록. 찾기 칸에 글을 넣으면 보이는 문서 전부에서 찾는다.
// 지금 자리는 이 브라우저에 기억한다(hwpx.lib.loc). 폴더·문서 행의 [옮기기]·[권한]·[삭제]는 그럴 권한이 있을 때만 보인다.
const LOC_KEY = 'hwpx.lib.loc';
const DocList = {
  components: { PersonalAiPanel, AiRunPanel, OrchestrationPanel, DriveTab, LibraryTree, AccessDialog, MoveDialog, NameDialog, LocalFoldersDialog, ReviewServersDialog, ReviewDialog },
  template: `<div class="listpage">
    <div class="topbar"><span class="title">HWPX 공동 검토</span><span class="muted me-role" :data-role="me.role">{{ me.name }} · {{ roleLabel(me.role) }}</span><span class="spacer"></span>
      <a v-if="me.role==='admin'" class="btnlike small admin-nav" href="#/admin" data-testid="admin-list">관리자</a>
      <a v-if="me.tutorial" class="btnlike small tutorial-nav" href="#/tutorial" data-testid="tutorial-nav">튜토리얼</a>
      <a class="btnlike small" href="/onboarding.html?next=%2F%3Fteaser%3D0" data-testid="onboarding-list">시작 안내</a>
      <a class="btnlike help-link" href="/help.html" target="_blank" rel="noopener" data-testid="help-list">사용 설명서</a>
      <button class="small" @click="logout">나가기</button></div>
    <div class="libpage" :class="{'drive-mode':showDrive}">
      <aside class="libside"><LibraryTree v-if="lib" :lib="lib" :cur="cur" :me="me" :drive-active="showDrive" @go="goLibrary" @drive="showDrive=true"/></aside>
      <div class="doclist">
        <section v-if="showDrive" class="list-drive"><DriveTab :library="lib" :library-location="cur" @imported="driveImported"/></section>
        <template v-else>
        <details class="list-connections" v-if="config" data-testid="list-connections" @toggle="onConnToggle"><summary>AI 연결 <span class="muted" v-if="connSummary" :title="connTip" data-testid="list-conn-state">— {{ connSummary }}</span></summary>
          <p v-if="personalLine">{{ personalLine }}</p>
          <ol class="ai-ways" style="margin:6px 0;padding-left:20px" data-testid="ai-ways">
            <li data-way="subscription" :title="WAY_TIPS.subscription"><b>내 PC의 구독 AI</b> <span class="muted">· 기본 · 추가 비용 없음</span> — Codex(ChatGPT 로그인) · Claude Code(Claude 로그인) 실행기 <a href="/help.html#agents" target="_blank" rel="noopener">설정 방법</a></li>
            <li data-way="chatgpt-app" :title="WAY_TIPS.app"><b>ChatGPT 앱 연결</b> <span class="muted">· 고급 선택</span> — MCP 주소 <code>{{ urls.mcpUrl }}</code> <a href="/help.html#chatgpt-oauth" target="_blank" rel="noopener">설정 방법</a></li>
            <li data-way="api-key" :title="WAY_TIPS.key"><b>내 AI 키</b> <span class="muted">· 선택 · 사용료 별도</span><span v-if="keyLine"> — {{ keyLine }}</span></li>
          </ol>
          <p><a href="/help.html#ai" target="_blank" rel="noopener">연결 방법</a> · 사용자별 토큰으로 연결합니다.</p>
          <p>지금 접속한 주소: <code>{{ urls.currentWebUrl }}</code></p>
          <p>공유할 서버 주소: <code>{{ urls.sharedWebUrl }}</code><span v-if="urls.localOnly" class="muted"> — 이 PC 전용입니다. 설명서에서 공유 주소를 점검하세요.</span></p></details>
        <AiRunPanel/>
        <PersonalAiPanel/>
        <OrchestrationPanel/>
        <div class="lib-head">
          <nav class="lib-crumbs" aria-label="위치"><template v-for="(c, i) in crumbList" :key="i"><span v-if="i" class="muted">›</span><a href="#/" :class="{ cur: i === crumbList.length - 1 }" @click.prevent="go(c.loc)">{{ c.label }}</a></template></nav>
          <span class="spacer"></span>
          <select class="lib-sort" v-model="sort" aria-label="정렬" title="문서 정렬(폴더는 늘 위에 이름순)" data-testid="lib-sort"><option v-for="o in SORTS" :key="o.key" :value="o.key">{{ o.label }}</option></select>
          <input class="lib-find" type="search" v-model="query" placeholder="문서 찾기" aria-label="문서 찾기" data-testid="lib-find"/>
        </div>
        <div class="row lib-tools">
          <button class="small" data-testid="lib-newfolder" :disabled="!can('write')" :title="can('write') ? '이 자리에 폴더를 만듭니다' : '이 자리에 폴더를 만들 권한이 없습니다'" @click="dlg = { type: 'name', mode: 'new' }"><span class="ic" v-html="ICON.folder"></span>새 폴더</button>
          <label class="btnlike small primary" :class="{ disabled: !can('write') }" :title="can('write') ? '이 자리에 HWPX 를 올립니다' : '이 자리에 올릴 권한이 없습니다'" data-testid="lib-upload">
            <input type="file" accept=".hwpx" multiple style="display:none" :disabled="!can('write')" @change="upload"/>＋ HWPX 올리기</label>
          <button class="small" data-testid="lib-newdoc" :disabled="!can('write')" :title="can('write') ? '이 자리에 빈 한글 문서를 만들어 엽니다' : '이 자리에 문서를 만들 권한이 없습니다'" @click="dlg = { type: 'name', mode: 'newdoc' }"><span class="ic" v-html="ICON.edit"></span>새 문서로 시작</button>
          <button class="small" v-if="curAccess" data-testid="lib-access" :title="curAccess.tip" @click="dlg = { type: 'access', target: curAccess.target }"><span class="ic" v-html="ICON.people"></span>권한</button>
          <template v-if="lib && lib.local && lib.local.canLink">
            <button class="small" data-testid="lib-local" title="이 PC 의 폴더를 개인 문서함에 연결합니다 — 그 폴더의 HWPX 를 열어 고치면 그 파일에 저장됩니다" @click="dlg = { type: 'local' }"><span class="ic" v-html="ICON.pc"></span>PC 폴더 연결</button>
            <button class="small" data-testid="lib-remotes" title="여럿이 모여 검토할 서버(주소 + 그 서버의 내 토큰)" @click="dlg = { type: 'remotes' }"><span class="ic" v-html="ICON.people"></span>검토 서버</button>
          </template>
          <span class="muted lib-note" v-if="placeNote" :title="placeNote.tip">{{ placeNote.text }}</span>
        </div>
        <table class="libtable"><thead><tr><th class="sortable" :aria-sort="ariaSort('name')" title="이름순으로 정렬(다시 누르면 반대로)" data-sort="name" @click="sortBy('name')">문서<span class="sort-ic" v-if="sortField === 'name'">{{ sortArrow }}</span></th><th>버전</th><th>제안(대기/적용)</th><th>AI 작업 대기</th><th class="sortable" :aria-sort="ariaSort('updated')" title="마지막 수정순으로 정렬(다시 누르면 반대로)" data-sort="updated" @click="sortBy('updated')">마지막 수정<span class="sort-ic" v-if="sortField === 'updated'">{{ sortArrow }}</span></th><th></th></tr></thead>
        <tbody>
          <tr class="folder" v-for="f in subfolders" :key="f.id" :data-folder="f.id" @click="go(folderLoc(f))">
            <td colspan="4"><span class="ic lib-fic" v-html="ICON.folder"></span><b>{{ f.name }}</b><span class="lib-badge pc" v-if="f.local && f.local.root" :title="linkTip(f)"><span class="ic" v-html="ICON.pc"></span>PC</span><span class="muted" v-if="f.inherit === false" title="이 폴더는 권한을 직접 정했습니다"> · <span class="ic" v-html="ICON.people"></span></span></td>
            <td class="muted">{{ f.createdBy || '' }}</td>
            <td class="lib-acts" @click.stop>
              <button class="icon" v-if="f.perms.includes('manage')" title="이름 바꾸기" aria-label="이름 바꾸기" @click="dlg = { type: 'name', mode: 'rename', folder: f }" v-html="ICON.edit"></button>
              <button class="icon" v-if="f.perms.includes('manage') && !(f.local && f.local.root)" title="옮기기" aria-label="옮기기" @click="dlg = { type: 'move', item: { kind: 'folder', id: f.id, name: f.name, loc: parentOf(f), folder: f, localOnly: !!f.local } }" v-html="ICON.move"></button>
              <button class="icon" v-if="f.perms.includes('manage')" title="권한" aria-label="권한" @click="dlg = { type: 'access', target: folderTarget(f) }" v-html="ICON.people"></button>
              <button class="icon" v-if="f.perms.includes('manage') && !(f.local && f.local.root)" title="폴더 지우기(비어 있어야)" aria-label="폴더 지우기" @click="removeFolder(f)" v-html="ICON.trash"></button>
              <button class="icon" v-if="f.local && f.local.root && lib.local && lib.local.canLink" title="연결 끊기 — PC 의 파일은 그대로 남습니다" aria-label="연결 끊기" data-testid="local-unlink" @click="unlinkFolder(f)" v-html="ICON.x"></button></td></tr>
          <tr class="doc" v-for="d in shownDocs" :key="d.id" :data-doc="d.id" :class="{selected:selectedDoc===d.id}" :aria-selected="selectedDoc===d.id" tabindex="0" @click="selectedDoc=d.id" @dblclick="open(d)" @keydown.enter.self.prevent="open(d)" title="제목을 누르거나 두 번 클릭·Enter로 문서 열기">
            <td><a class="doc-link" :href="'#/doc/' + d.id" data-testid="doc-open-title" title="문서 열기" @click.stop><b>{{ d.title }}</b></a><span class="lib-badge" v-if="badge(d)" :title="badge(d).title"><span class="ic" v-html="ICON[badge(d).icon]"></span>{{ badge(d).text }}</span><span class="lib-badge pc" v-if="d.local" :class="'st-' + d.local.state" :title="localTip(d.local)" data-testid="doc-pc"><span class="ic" v-html="ICON.pc"></span>{{ localLabel(d.local) }}</span><span class="lib-badge rv" v-if="d.review" :title="reviewTip(d)" data-testid="doc-review"><span class="ic" v-html="ICON.send"></span>{{ d.review.server }}</span>
              <div class="muted">{{ d.fileName }} · {{ d.createdBy }}<template v-if="sortField === 'created' && d.createdAt"> · {{ fmt(d.createdAt) }} 올림</template><template v-if="query.trim()"> · {{ placeOf(d) }}</template></div></td>
            <td class="doc-ver" :title="verTip(d)">{{ verText(d) }}</td><td>{{ d.proposals.pending }} / {{ d.proposals.applied }}</td><td>{{ d.requests }}</td><td>{{ fmt(d.updatedAt) }}</td>
            <td class="lib-acts" @click.stop>
              <button class="icon" title="문서 열기" aria-label="문서 열기" @click="open(d)" v-html="ICON.edit"></button>
              <button class="icon" v-if="canRename(d)" title="이름 바꾸기" aria-label="문서 이름 바꾸기" data-testid="doc-rename" @click="dlg = { type: 'name', mode: 'docrename', doc: d }">✎</button>
              <button class="icon" v-if="lib.local && lib.local.canLink && has(d, 'manage')" title="함께 검토 — 검토 서버에 보내고 검토본을 가져옵니다" aria-label="함께 검토" data-testid="doc-review-open" @click="dlg = { type: 'review', doc: d }" v-html="ICON.send"></button>
              <button class="icon" v-if="has(d, 'manage')" title="옮기기" aria-label="옮기기" @click="dlg = { type: 'move', item: { kind: 'doc', id: d.id, name: d.title, loc: locOfDoc(d), localOnly: !!d.local } }" v-html="ICON.move"></button>
              <button class="icon" v-if="has(d, 'manage')" title="권한" aria-label="권한" @click="dlg = { type: 'access', target: docTarget(d) }" v-html="ICON.people"></button>
              <button class="icon" v-if="has(d, 'delete')" title="삭제" aria-label="삭제" @click="remove(d)" v-html="ICON.trash"></button></td></tr>
          <tr v-if="!subfolders.length && !shownDocs.length"><td colspan="6" class="muted">{{ query.trim() ? '찾는 문서가 없습니다' : loaded ? (can('write') ? '비어 있습니다. HWPX 를 올리거나 새 문서로 시작하세요.' : '비어 있습니다') : '읽는 중…' }}</td></tr></tbody></table>
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
  setup() {
    const me = state.me;
    const lib = ref(null); const loaded = ref(false);
    const sectionKey = 'hwpx.lib.section:' + me.name;
    const readSection = () => { try { return sessionStorage.getItem(sectionKey) === 'drive'; } catch { return false; } };
    const showDrive = ref(readSection());
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
    async function upload(e) {
      const files = [...(e.target.files || [])]; e.target.value = '';
      if (!files.length) return;
      const c = cur.value;
      const where = c.folderId ? { 'x-folder-id': c.folderId } : { 'x-space': c.space, ...(c.space === 'private' ? { 'x-space-owner': encodeURIComponent(c.owner || '') } : {}) };
      let done = 0;
      for (const f of files) {
        try { await api('/api/docs', { method: 'POST', body: await f.arrayBuffer(), raw: true, headers: { 'x-file-name': encodeURIComponent(f.name), ...where } }); done++; } catch (err) { toastError(err, `${f.name}: `); }
      }
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
      if (!confirm(`${josaQuoted(f.name)} 연결을 끊을까요?\nPC 의 파일은 그대로 남습니다.`)) return;
      try { const out = await api(`/api/local/links/${encodeURIComponent(f.local.link)}`, { method: 'DELETE' }); toast('연결을 끊었습니다'); await localChanged(out.local, null); } catch (err) { toastError(err); }
    }
    async function remove(d) {
      if (!confirm(d.local ? `${josaQuoted(d.title)} 지울까요?\nPC 의 파일도 지웁니다(휴지통으로).` : `${josaQuoted(d.title)} 지울까요?`)) return;
      try { await api(`/api/docs/${d.id}`, { method: 'DELETE' }); } catch (err) { toastError(err); }
      await load();
    }
    function open(d) { location.hash = `#/doc/${d.id}`; }
    function logout() { try { localStorage.removeItem('hwpx.token'); } catch { /* ignore */ } state.token = ''; state.me = null; location.hash = '#/'; }
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
      subscription: 'Codex: start-codex-agent.bat(먼저 codex login). Claude Code: start-claude-worker.bat(먼저 claude auth login).\n명령으로 실행하려면 node scripts/ai-worker.mjs --provider codex 또는 --provider claude-code. 실행기를 켜 두는 동안 기존 대기 요청과 새 요청을 자동 처리합니다.\nCodex CLI·IDE 확장에 MCP를 직접 등록한 대화는 대기열 처리를 지시해야 합니다. Claude Code 채널은 start-agent.bat에서 선택할 수 있습니다. 사용량은 각 구독의 사용 한도에서 차감됩니다',
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
      lib, loaded, cur, query, dlg, showDrive, selectedDoc, me, config: state.config, urls, personalLine, keyLine, WAY_TIPS, connSummary, connTip, onConnToggle, crumbList, subfolders, shownDocs, curAccess, placeNote,
      sort, sortField, sortArrow, sortBy, ariaSort, SORTS,
      go, goLibrary, can, has, badge, placeOf, locOfDoc, parentOf, folderLoc, folderTarget, docTarget, upload, saveName, nameDlg, canRename, removeFolder, remove, open, logout, load, driveImported,
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
  props: ['id'],
  components: { FloatWin, Composer, EditPopover, QuickReply, ReviewRail, SettingsDialog, InlineConfirm },
  template: `<div class="docview v3" :class="{ 'view-simple': s.view !== 'detail', 'view-detail': s.view === 'detail', 'doc-live': realtime, stacked, 'panel-min': stacked && panel.min, 'panel-folded': folded, 'panel-peek': folded && !!peek, 'fold-hint': foldHint, resizing }" :style="panelVars" data-view="v3" :data-mode="ed?.mode || ''">
    <div class="topbar v3bar">
      <a href="#/" class="back" title="문서 목록" @click.prevent="goBack">←<span class="back-text"> 목록</span></a>
      <input v-if="titleEdit !== null" ref="titleInp" class="title title-edit" data-testid="doc-title-input" v-model="titleEdit" maxlength="100" aria-label="문서 이름"
        @keydown.enter.prevent="saveTitle" @keydown.esc.prevent="titleEdit = null" @blur="saveTitle"/>
      <span v-else-if="canRename" class="title title-click" role="button" tabindex="0" data-testid="doc-title" :title="'눌러서 이름 바꾸기' + (s.info?.fileName ? ' · ' + s.info.fileName : '')"
        @click="editTitle" @keydown.enter.prevent="editTitle">{{ s.info?.title }}</span>
      <span v-else class="title" data-testid="doc-title" :title="s.info?.fileName">{{ s.info?.title }}</span>
      <button class="pill ver" v-if="verLabel" data-testid="version-pill" :title="verTitle" @click="s.tab = 'history'">{{ verLabel }}</button>
      <span class="pill pcpill" v-if="s.info?.local" :class="'st-' + s.info.local.state" :title="localTip(s.info.local)" data-testid="pc-pill">{{ localLabel(s.info.local) }}</span>
      <span class="draftchip" :class="chip.cls" :title="chip.tip" data-testid="draft-chip"><span class="dot" aria-hidden="true"></span><span class="chip-text">{{ chip.text }}</span>
        <button v-if="chip.retry" class="linkbtn" data-testid="chip-retry" :title="s.draft.tutorialRestored || (s.draft.stale && !liveMode) ? '서버의 지금 문서를 다시 엽니다(여기서 친 저장 안 된 글은 버림)' : '다시 저장합니다'" @click="retrySave">{{ s.draft.tutorialRestored || (s.draft.stale && !liveMode) ? '다시 열기' : '다시' }}</button>
        <button v-if="chip.keep" class="linkbtn" data-testid="chip-keep" title="서버의 내 수정본을 이 창의 글로 덮어씁니다" @click="keepMine">이 글로 저장</button>
        <button v-if="chip.carry" class="linkbtn" data-testid="chip-carry" :disabled="carrying" title="서버의 지금 수정본을 열고 이 창에서 고친 문단을 그 위에 다시 넣습니다" @click="carryMine">내 글 옮기기</button></span>
      <template v-if="!liveDoc">
        <span class="behindchip" v-if="behind" data-testid="behind-chip" :title="behindTip"><span class="bc-text">새 버전 있음 →</span>
          <button class="small" :disabled="rebasing" title="내 수정본을 공유 문서의 새 버전 위로 옮깁니다(겹치는 곳은 내 글을 남김)" @click="rebase"><span v-if="rebasing" class="spin dark"></span><span class="bc-full">최신으로 맞추기</span><span class="bc-short">최신으로</span></button></span>
        <span class="warnchip" v-if="s.draft.unsupported?.length" :title="unsupportedTip">반영 불가 {{ s.draft.unsupported.length }}건</span>
        <button v-if="s.myCr?.status==='draft'" class="primary small" data-testid="submit-cr" @click="openSubmit">검토 요청</button>
        <button v-else-if="s.myCr?.status==='open'" class="crchip" data-testid="cr-chip" :title="crChipTip" @click="openCr(s.myCr.cid)"><span class="cc-text"><span class="cc-head">{{ crChipHead }}</span><span class="cc-rest">{{ crChip.slice(crChipHead.length) }}</span></span></button>
      </template>
      <span class="spacer"></span>
      <div class="whobox" tabindex="0" aria-label="접속자" data-testid="presence">
        <span class="who" v-for="u in present" :key="u.name" :style="{ background: u.color }" :class="{ me: u.me }" :title="u.me ? u.name + '(나' + (myRole ? ' · ' + myRole : '') + ')' : u.name">{{ u.name.slice(0, 1) }}<i v-if="u.editing" class="typing" aria-hidden="true"></i></span>
        <div class="whopop" role="tooltip">
          <div class="wp-h">누가 어디를 고치는 중</div>
          <div class="wp-row" v-for="u in people" :key="u.name">
            <span class="wp-dot" :style="{ background: u.color }"></span><b>{{ u.name }}</b><span class="muted wp-me" v-if="u.me">(나{{ myRole ? ' · ' + myRole : '' }})</span><span class="muted" v-else-if="!u.present">(접속 안 함)</span>
            <div class="wp-what" v-if="u.editing"><span class="ref" @click="go(u.editing)">● {{ u.editing }}</span> 입력 중 <span class="muted">「{{ clip(d.textOf(u.editing), 24) }}」</span></div>
            <div class="wp-what" v-for="c in u.crs" :key="c.cid"><a href="#" class="wp-link" @click.prevent="openCr(c.cid)">✎ 변경 요청 #{{ c.cid }}</a> {{ c.status === 'open' ? '검토 중' : '수정 중' }} · {{ c.hunkCount ?? (c.hunks || []).length }}문단</div>
            <div class="wp-what muted" v-if="!u.editing && !u.crs.length">고치는 곳 없음</div>
          </div>
          <div class="muted" v-if="!people.length">접속자가 없습니다</div>
        </div>
      </div>
      <button class="agentpill" :class="{ on: !!env.connected }" data-testid="agent-pill" :aria-label="agentLabel" :title="agentTip" @click="openAgentHelp"><span class="ap-full">{{ agentLabel }}</span><span class="ap-short" aria-hidden="true">{{ env.connected ? '● AI' : '○ AI' }}</span></button>
      <a v-if="stateMeTutorial" class="btnlike small tourbtn tutorial-nav" href="#/tutorial" data-testid="tutorial-doc-nav">튜토리얼</a>
      <span v-if="s.info?.tutorialSession" class="tutorial-temp-label">임시 연습 문서</span>
      <button v-if="tourOn" class="small tourbtn" data-testid="tour-open" @click="openTour">{{ tourPaused ? '튜토리얼 계속하기' : '튜토리얼 안내' }}</button>
      <button v-if="s.info?.tutorialSession" class="small primary" data-testid="tutorial-complete" :disabled="tutorialSaving" @click="completeTutorial">{{ tutorialSaving ? '저장 중…' : '완료하고 문서함에 저장' }}</button>
      <button v-if="s.info?.tutorialCompletedAt && nextCourse" class="small" data-testid="tutorial-next-course" :disabled="tutorialSaving" @click="startNextTutorial">다음 튜토리얼로 가기</button>
      <button class="small savebtn" data-testid="save-hangul" :disabled="saving" :title="saveTip" @click="saveHangul"><span v-if="saving" class="spin dark"></span>한글로 저장</button>
      <div class="barmore" :class="{ open: moreOpen }" ref="moreEl" data-testid="bar-more">
        <button class="more-btn" data-testid="bar-more-toggle" aria-haspopup="true" :aria-expanded="moreOpen" aria-label="메뉴 더 보기" title="메뉴 더 보기" @click="moreOpen = !moreOpen">⋯</button>
        <div class="more-items" @click="onMoreClick">
          <button class="small more-save" data-testid="more-save-hangul" :disabled="saving" :title="saveTip" @click="saveHangul"><span v-if="saving" class="spin dark"></span>한글로 저장</button>
          <button class="small more-tools" role="menuitemcheckbox" :aria-checked="tools" :disabled="!ed?.ready" data-testid="toggle-editor-tools" title="편집기 메뉴·도구 막대 보이기(휴대전화 폭에서는 기본으로 숨겨 문서를 넓게 봅니다)" @click="toggleTools"><span class="chk">{{ tools ? '✓' : '' }}</span>편집 도구 막대</button>
          <button v-if="mobileEnvironment" class="small" :disabled="!ed?.ready" data-testid="mobile-options" @click="openMobileOptions">모바일 옵션</button>
          <button v-if="s.canConfigure" class="small icon-text docset" data-testid="doc-settings" title="문서 설정 — 편집 방식·수정 권한·한글로 저장·AI 작업 메모" @click="s.settingsOpen = true">⚙ 문서 설정</button>
          <button v-if="isAdmin" class="small admin-nav" data-testid="admin-doc" @click="showAdmin">관리자</button>
          <a class="btnlike help-link" href="/help.html#review" data-testid="help-doc" title="프로그램 안에서 사용 설명서 열기">사용 설명서</a>
          <details class="doc-view-options" data-testid="document-view-options" @toggle="readDocumentView" @keydown.esc.prevent="$event.currentTarget.open = false">
            <summary>보기</summary>
            <div class="doc-view-menu" role="menu" aria-label="문서 보기">
              <button role="menuitemcheckbox" :aria-checked="documentView.paragraph" :disabled="!ed?.ready" data-testid="show-paragraph-marks" @click="toggleDocumentView('view:para-mark')"><span>{{ documentView.paragraph ? '✓' : '' }}</span>문단 부호 보기<kbd>Ctrl+G,T</kbd></button>
              <button role="menuitemcheckbox" :aria-checked="documentView.controls" :disabled="!ed?.ready" data-testid="show-control-codes" @click="toggleDocumentView('view:ctrl-mark')"><span>{{ documentView.controls ? '✓' : '' }}</span>조판 부호 보기<kbd>Ctrl+G,C</kbd></button>
              <div class="dvm-sep" role="separator"></div>
              <button role="menuitemcheckbox" :aria-checked="memosOn" data-testid="show-memos" title="메모·AI 작업·제안을 문서 옆 여백에 띄웁니다(끄면 오른쪽 창의 검토 탭에서 봄)" @click="toggleMemos"><span>{{ memosOn ? '✓' : '' }}</span>문서 옆 메모 보기</button>
              <button role="menuitem" data-testid="memo-pos-reset" :disabled="!movedMemos" title="끌어 옮긴 메모를 모두 쪽 옆 제자리로" @click="resetMemoPos"><span></span>메모 제자리로</button>
            </div>
          </details>
          <div class="viewseg" role="group" aria-label="보기" data-testid="view-toggle" title="보기: 간단히(남의 AI 작업은 한 줄 요약 · 필요한 탭만) / 자세히(모든 제안·변경 요청·변경 추적)">
            <button v-for="v in ['simple', 'detail']" :key="v" class="seg" :class="{ on: s.view === v }" :data-view="v" :aria-pressed="s.view === v" @click="d.setView(v)">{{ VIEW_LABEL[v] }}</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="serverNotice" class="admin-server-notice" data-testid="server-restart-notice" role="status">{{ serverNotice }}</div>
    <div class="v3layout">
      <div class="editorarea" :class="{ 'has-strip': !!leftover }">
        <div class="leftover-strip" v-if="leftover" data-testid="leftover-banner" role="status">
          <span class="lo-text" title="승인 방식일 때 고친 내 수정본이 아직 문서에 들어가지 않았습니다 — 반영하거나 닫으세요">남은 내 수정본 · 변경 요청 #{{ leftover.cid }} · {{ leftover.n }}문단</span>
          <template v-if="!loConfirm">
            <button class="small primary" data-testid="leftover-merge" :disabled="loBusy || !s.canEdit" :title="s.canEdit ? '그 수정본을 지금 공유 문서에 반영합니다(겹친 곳은 최신으로 맞춘 뒤)' : '이 문서의 수정 권한이 없습니다'" @click="mergeLeftover"><span v-if="loBusy" class="spin"></span>반영</button>
            <button class="small" data-testid="leftover-close" :disabled="loBusy" title="그 변경 요청을 닫습니다(변경 요청 탭에서 다시 열 수 있음)" @click="loConfirm = true">닫기</button>
          </template>
          <InlineConfirm v-else :message="loMsg" ok-label="닫기" danger :busy="loBusy" @ok="closeLeftover" @cancel="loConfirm = false"/>
        </div>
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
        <div class="splitter" role="separator" tabindex="0" data-testid="panel-splitter" :aria-orientation="stacked ? 'horizontal' : 'vertical'" aria-label="AI 창 크기 조절"
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
  setup(props) {
    const d = createDocStore(props.id); provide('doc', d); const s = d.s;
    // 상단 문서 이름: 눌러서 그 자리에서 바꾼다(Enter·칸 밖 = 저장, Esc = 취소). 권한 = 수정 또는 설정(서버 renameDocument)
    const canRename = computed(() => !!s.info && (!!s.canEdit || !!s.canConfigure));
    const titleEdit = ref(null); const titleInp = ref(null); let titleBusy = false;
    function editTitle() {
      if (!canRename.value) return;
      titleEdit.value = s.info?.title || '';
      nextTick(() => { titleInp.value?.focus(); titleInp.value?.select(); });
    }
    async function saveTitle() {
      if (titleEdit.value === null || titleBusy) return;
      const name = titleEdit.value.trim();
      if (!name || name === s.info?.title) { titleEdit.value = null; return; }
      titleBusy = true;
      try {
        const out = await api(`/api/docs/${encodeURIComponent(props.id)}`, { method: 'PATCH', body: { title: name } });
        if (s.info) s.info.title = out.title;
        titleEdit.value = null;
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
    const refreshAutomation = () => { if (document.visibilityState !== 'hidden') loadAutomation(); };
    const openAdmin = inject('openAdmin');
    const isAdmin = computed(() => state.me?.role === 'admin');
    function showAdmin() {
      if (!isAdmin.value) return;
      openAdmin({ prepareRestart: async () => {
        if (s.draft.dirty || s.draft.saving) {
          try { await Promise.race([d.saveDraftNow(), new Promise((resolve) => setTimeout(resolve, 8000))]); } catch { /* 설정 창에서 저장 상태를 안내한다 */ }
        }
        return !s.draft.dirty && !s.draft.saving;
      } });
    }
    window.__doc = d;   // 시험·문제 찾기용(같은 출처 페이지 안)
    const editorEl = ref(null);
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
      if (dr.tutorialRestored) return { text: '연습 문서 복구됨 —', cls: 'error', retry: true, tip: dr.error };
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
        location.reload(); return;
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
    const crChipHead = computed(() => crChip.value.split(' · ')[0]);
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
    async function openAgentHelp(e) {
      const from = e?.currentTarget || null;   // 기다린 뒤에는 이벤트의 currentTarget 이 비므로 먼저
      const { openHelp } = await import('./help-dialog.js');
      openHelp(new URL(CONNECT_HELP, location.href).hash, from);   // ① 내 PC의 AI(#agents)부터
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
    function mount() { handle = mountEditor(editorEl.value, d); }
    function remount() { try { handle?.destroy(); } catch { /* 이미 없음 */ } if (editorEl.value) editorEl.value.innerHTML = ''; mount(); }
    // 목록으로: 저장 안 된 편집은 화면을 옮기기 전에 저장한다(leaveGuard — 브라우저 '뒤로'도 같다)
    function goBack() { location.hash = '#/'; }
    /**
     * 화면을 옮겨도 되나(leaveGuard): 저장 안 된 편집을 먼저 저장한다(최대 8초). 저장하지 못했으면(저장을 멈춤 — 다른 곳에서 바뀜·옛 기준,
     * 저장 실패·아직 저장 중) 나가면 편집기 안 글이 사라지므로 묻는다 → false 면 머문다
     */
    async function guard() {
      if (tour && tourOn.value && !await tour.requestLeave()) return false;
      if (tourOn.value) await flushTour(props.id).catch(() => {});
      if (s.draft.dirty || s.draft.saving) {
        try { await Promise.race([d.saveDraftNow(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* 아래에서 묻는다 */ }
      }
      if (!s.draft.dirty && !s.draft.saving) return true;
      const p = s.live.progress;
      const why = s.draft.stale ? `저장을 멈춤${s.draft.elsewhere ? ` — ${s.draft.elsewhere}` : ''}` : s.draft.saving ? `아직 저장 중${p?.total ? ` — 문서에 넣는 중 ${p.done}/${p.total}` : ''}` : '저장 실패';
      return confirm(`저장하지 못한 글이 있습니다(${why}).\n나가면 그 글이 사라집니다. 그래도 나갈까요?\n([취소]: 남아서 상단 칩의 단추로 저장)`);
    }

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
      if (k.key === 'Escape') { if (!closeFloating({ fromEditor: true }) && peek.value) closePeek(); }
      else if (k.key === 'M' && (k.ctrl || k.meta) && k.alt) memoOnSelection();
    }
    function onKey(e) {
      if (e.key === 'Escape' && moreOpen.value) moreOpen.value = false;
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
    function onResize() { syncRail(); measureOver(); }
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
    const splitTip = computed(() => (stacked.value ? '끌어서 AI 창 높이 조절 · 누르면 접기/펴기' : '끌어서 AI 창 폭 조절 · 끝까지 밀면 접기 · 두 번 누르면 기본 폭'));
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
      if (e.pointerType !== 'mouse' || stacked.value) return;
      if (e.target.closest?.('.floatwin, .toasts, dialog')) { clearTimeout(edgeTimer); edgeTimer = 0; return; }
      edgeSense(e, e.clientX, e.clientY);
    }
    function onFrameMove(e) {
      if (e.pointerType !== 'mouse' || stacked.value) return;
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
      edgeStop();
      if (!peek.value || panelEl.value?.contains(e.target) || e.target.closest?.('.floatwin, .toasts, dialog, .barmore, .doc-view-options, .railover, .tour')) return;
      closePeek();
    }
    // 편집기 안을 누르면(iframe — 같은 출처) 펼쳐 둔 패널을 접는다(표식을 눌러 연 것은 누른 뒤에 열리므로 그 누름은 닫지 않는다)
    let frameDoc = null;
    const onFrameDown = () => { edgeStop(); if (peek.value) closePeek(); };
    function hookFrame() {
      let doc = null; try { doc = editorEl.value?.querySelector('iframe')?.contentDocument || null; } catch { doc = null; }
      if (doc === frameDoc) return;
      frameDoc?.removeEventListener('pointerdown', onFrameDown, true); frameDoc?.removeEventListener('pointermove', onFrameMove, true);
      frameDoc = doc; frameDoc?.addEventListener('pointerdown', onFrameDown, true); frameDoc?.addEventListener('pointermove', onFrameMove, { capture: true, passive: true });
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
    watch(stacked, syncRail);
    // 끌어 옮긴 메모 자리(rail.js 가 d.s.memoPos 에 두고 이 브라우저에 기억 — view.js readMemoPos)
    if (!s.memoPos) s.memoPos = readMemoPos(s.id);
    const movedMemos = computed(() => Object.keys(s.memoPos || {}).length);
    function resetMemoPos() { s.memoPos = {}; writeMemoPos(s.id, {}); }
    // 메모 자리(편집기 iframe 안을 잰다 — 같은 출처): 겹침 층 = 문서 스크롤 칸(왼쪽 세로 눈금자·위 도구 막대 빼고), 메모 칸 = 보이는 쪽 오른쪽 끝 옆(view.js marginBox).
    // 강조 자리·창 폭이 바뀔 때와 1초마다
    const over = ref(null);
    function measureOver() {
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
    watch(railOver, (on) => {
      clearInterval(overTimer); overTimer = null;
      if (!on) { over.value = null; return; }
      nextTick(measureOver); overTimer = setInterval(measureOver, 1000);
    }, { immediate: true });
    watch(() => [s.anchors, panel.value.w, leftover.value], () => { if (railOver.value) requestAnimationFrame(measureOver); });
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
    // ── 편집기 메뉴·도구 막대: 휴대전화 폭(600px 이하)이면 기본으로 숨긴다 — [⋯] 메뉴 '편집 도구 막대'로 켜면 기억(view.js readTools) ──
    const phoneQuery = matchMedia('(max-width: 600px)');
    const phone = ref(phoneQuery.matches);
    const mobileEnvironment = ref(isMobileDevice(window));
    const onPhone = () => { phone.value = phoneQuery.matches; mobileEnvironment.value = isMobileDevice(window); };
    function openMobileOptions() { documentAutomation()?.execute('tool:options', undefined, { allowDialog: true }); }
    const toolsPref = ref(readTools());
    const tools = computed(() => !phone.value || toolsPref.value);
    function applyTools() { if (ed.value?.ready) d.editor?.setChrome?.({ menu: tools.value, toolbar: tools.value }); }
    function toggleTools() { toolsPref.value = !tools.value; writeTools(toolsPref.value); }
    watch(tools, applyTools);
    watch(() => ed.value?.ready, (r) => { if (r && !tools.value) applyTools(); });
    // ── [⋯] 메뉴(좁은 창): 밖을 누르거나(편집기 안을 누르면 이 창이 blur 된다)·Esc·메뉴 안 단추·링크를 고르면 닫는다 ──
    const moreOpen = ref(false); const moreEl = ref(null);
    function onMoreClick(e) { if (!e.target.closest('summary') && e.target.closest('button, a')) moreOpen.value = false; }
    function onDocDown(e) { if (moreOpen.value && !moreEl.value?.contains(e.target)) moreOpen.value = false; }
    const closeMore = () => { moreOpen.value = false; };
    // 휴대전화 폭에서는 위 막대가 여러 줄로 접혀 [⋯]가 왼쪽에 올 수 있다 — 오른쪽 맞춤 메뉴가 화면 왼쪽 밖으로 잘리지 않게 옮긴다
    watch(moreOpen, async (open) => {
      const menu = moreEl.value?.querySelector('.more-items'); if (!menu) return;
      menu.style.transform = '';
      if (!open) return;
      await nextTick();
      const r = menu.getBoundingClientRect(); const room = document.documentElement.clientWidth;
      const dx = r.left < 8 ? 8 - r.left : r.right > room - 8 ? room - 8 - r.right : 0;
      if (dx) menu.style.transform = `translateX(${Math.round(dx)}px)`;
    });
    // 다룰 곳(편집기·요청 창·첨부 칸) 밖에 파일을 놓아도 브라우저가 파일을 열어 화면을 떠나지 않게. 패널에 놓으면 첨부만
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    function onWinDragOver(e) {
      if (!isFiles(e)) return; const handled = e.defaultPrevented; e.preventDefault();
      if (!handled) e.dataTransfer.dropEffect = e.target.closest?.('.panel') ? 'copy' : 'none';
    }
    function onWinDrop(e) {
      if (!isFiles(e) || e.defaultPrevented) { if (isFiles(e)) e.preventDefault(); return; }
      e.preventDefault();
      if (e.target.closest?.('.panel')) d.uploadFiles([...e.dataTransfer.files]);
    }
    function onBeforeUnload(e) { if (s.draft.dirty || s.draft.saving) { e.preventDefault(); e.returnValue = ''; } }

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
    const offs = [d.on('menu-action', onMenuAction), d.on('editor-key', onEditorKey), d.on('ws', serverRestarting), d.on('reconnect', serverReconnected), d.on('annotation-click', onAnnClick)];
    s.railOpen = railVisible(panel.value.rmode, { stacked: stacked.value });
    onMounted(async () => {
      addEventListener('keydown', onKey); addEventListener('resize', onResize); addEventListener('dragover', onWinDragOver); addEventListener('drop', onWinDrop);
      addEventListener('beforeunload', onBeforeUnload);
      leaveGuard = guard;
      loadAutomation(); addEventListener('focus', refreshAutomation); document.addEventListener('visibilitychange', refreshAutomation);
      automationPoll = setInterval(refreshAutomation, 15000);
      stackQuery.addEventListener('change', onStack); phoneQuery.addEventListener('change', onPhone); document.addEventListener('pointerdown', onDocDown, true); addEventListener('blur', closeMore);
      document.addEventListener('pointerdown', onDownOutside, true); document.addEventListener('pointermove', onHostMove, { capture: true, passive: true });
      document.documentElement.addEventListener('pointerleave', onViewportLeave);
      addEventListener('blur', onViewportLeave);
      mount();
      await d.refresh(); d.connect();
      try {
        const key = `hwpx.tutorial-recovery-notice:${props.id}`;
        const notice = sessionStorage.getItem(key); sessionStorage.removeItem(key);
        if (notice === 'AI_IN_FLIGHT') toast('진행 중인 AI 작업을 다시 보내지 않도록 요청 전 단계로 돌아왔습니다.');
      } catch { /* 알림 저장을 사용할 수 없어도 복구한 문서는 엽니다. */ }
      // 체험 따라 하기: 이 문서가 진행 중인 체험 문서면 편집기가 뜬 뒤 붙인다(web/tutorial.js)
      if (s.info?.tutorialSession && s.info?.tutorialGuided) {
        try {
          await loadTour(props.id);
          const showIntro = state.tutorialIntroDocId === props.id;
          state.tutorialIntroDocId = null;
          startTourHere({ showIntro });
        } catch (e) { toastError(e, '안내 진행 정보를 읽지 못했습니다: '); }
      }
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
    async function startTourHere({ showIntro = false, resume = false } = {}) {
      const generation = ++tourStartGeneration;
      for (let k = 0; k < 150 && !(s.editor?.ready && s.paragraphs?.length) && !tutorialClosed && generation === tourStartGeneration; k++) await new Promise((r) => setTimeout(r, 200));
      if (tutorialClosed || !tourOn.value || generation !== tourStartGeneration) return;
      if (!(s.editor?.ready && s.paragraphs?.length)) { tourPaused.value = true; toast('편집기가 아직 준비되지 않았습니다. 준비된 뒤 [튜토리얼 계속하기]를 눌러 주세요.'); return; }
      if (tour) tour.stop();
      const m = await import('./tutorial.js');
      await refreshTutorialCatalog().catch(() => { tutorialItems.value = []; });
      if (tutorialClosed || !tourOn.value || generation !== tourStartGeneration) return;
      const saved = m.tourState(props.id);
      if (saved?.ctx?.guidePaused && !resume) { tourPaused.value = true; return; }
      if (saved?.ctx) saved.ctx.guidePaused = false;
      tourPaused.value = false;
      tour = m.runTour({ d, docId: props.id, me: state.me, config: state.config, showIntro, onComplete: completeTutorial,
        onRestore: async value => {
          tour = null;
          if (value.recoveryFallback?.reason === 'AI_IN_FLIGHT') {
            try { sessionStorage.setItem(`hwpx.tutorial-recovery-notice:${props.id}`, 'AI_IN_FLIGHT'); } catch { /* 알림만 생략 */ }
          }
          // 편집기의 undo·자동 저장·지연 응답을 함께 버리고 서버 복구본으로 새 실행을 시작합니다.
          location.reload();
        },
        onNext: nextCourse.value ? startNextTutorial : null, onEnd: ({ done }) => {
        tour = null; tourPaused.value = !done;
        if (!done) toast('안내를 닫았습니다. 자유롭게 편집한 뒤 [튜토리얼 계속하기]로 이어가세요.');
      } });
    }
    async function openTour() {
      tour?.stop(); tour = null;
      try { await loadTour(props.id); await startTourHere({ resume: true }); }
      catch (e) { toastError(e, '튜토리얼 안내를 다시 열지 못했습니다: '); }
    }
    onBeforeUnmount(() => {
      tutorialClosed = true;
      tourStartGeneration++;
      automationClosed = true; clearInterval(automationPoll); clearInterval(overTimer); clearTimeout(peekTimer); clearTimeout(edgeTimer); clearTimeout(foldTimer);
      document.removeEventListener('pointerdown', onDownOutside, true); document.removeEventListener('pointermove', onHostMove, true);
      document.documentElement.removeEventListener('pointerleave', onViewportLeave);
      removeEventListener('blur', onViewportLeave);
      try { frameDoc?.removeEventListener('pointerdown', onFrameDown, true); frameDoc?.removeEventListener('pointermove', onFrameMove, true); } catch { /* 이미 없음 */ }
      removeEventListener('focus', refreshAutomation); document.removeEventListener('visibilitychange', refreshAutomation);
      stackQuery.removeEventListener('change', onStack); phoneQuery.removeEventListener('change', onPhone); document.removeEventListener('pointerdown', onDocDown, true); removeEventListener('blur', closeMore);
      removeEventListener('keydown', onKey); removeEventListener('resize', onResize); removeEventListener('dragover', onWinDragOver); removeEventListener('drop', onWinDrop);
      removeEventListener('beforeunload', onBeforeUnload);
      if (leaveGuard === guard) leaveGuard = null;
      try { tour?.stop(); } catch { /* 없음 */ }
      for (const off of offs) off();
      try { handle?.destroy(); } catch { /* 이미 없음 */ }
      d.close();
      if (window.__doc === d) delete window.__doc;
    });
    return {
      d, s, ed, editorEl, canRename, titleEdit, titleInp, editTitle, saveTitle, rebasing, carrying, saving, tabs, curTab, composerTitle, chip, behind, behindTip, verLabel, verTitle, localTip, localLabel, unsupportedTip, people, present, agentLabel, crChip, crChipHead, crChipTip, myRole, isAdmin, showAdmin, serverNotice,
      env, agentTip, stacked, panel, panelVars, resizing, foldHint, splitTip, pickTab, startResize, resetPanel, keyResize, moreOpen, moreEl, onMoreClick, tools, toggleTools, mobileEnvironment, openMobileOptions,
      folded, peek, panelEl, openPeek, togglePin, edgeTip, aiGlance, onTabEnter, onTabLeave, onPanelEnter, onPanelLeave, onPanelFocusOut,
      memosOn, toggleMemos, movedMemos, resetMemoPos, railOver, over, overStyle,
      documentView, readDocumentView, toggleDocumentView,
      realtime, liveMode, liveDoc, saveTip, leftover, loBusy, loConfirm, loMsg, VIEW_LABEL,
      retrySave, keepMine, carryMine, rebase, openSubmit, openCr, openAgentHelp, saveHangul, mergeLeftover, closeLeftover, remount, goBack, go, clip,
      tourOn, tourPaused, openTour, tutorialSaving, completeTutorial, startNextTutorial, nextCourse, stateMeTutorial,
    };
  },
};

const App = {
  components: { Login, DocList, DocView, HelpDialog, AdminServerPanel, TutorialMenu },
  template: `<div class="app">
    <Login v-if="!state.me && ready"/>
    <DocView v-else-if="state.me && docId" :id="docId" :key="docId"/>
    <TutorialMenu v-else-if="state.me && tutorialRoute"/>
    <main v-else-if="state.me && adminRoute" class="admin-page"><AdminServerPanel v-if="state.me.role==='admin'"/>
      <section v-else class="admin-denied" data-testid="admin-denied"><h1>관리자만 사용할 수 있습니다</h1><p>서버 설정은 관리자에게 요청하세요.</p><a href="#/">문서 목록으로</a></section></main>
    <DocList v-else-if="state.me"/>
    <AdminServerPanel v-if="adminOpen && state.me?.role==='admin'" modal :prepare-restart="adminContext?.prepareRestart" @close="adminOpen = false"/>
    <HelpDialog/>
    <div class="toasts" aria-live="polite"><div class="toast" v-for="t in toasts" :key="t.id" :class="t.kind">{{ t.msg }}</div></div></div>`,
  setup() {
    const ready = ref(false);
    const adminRoute = computed(() => /^#\/admin(?:[/?]|$)/.test(state.route));
    const tutorialRoute = computed(() => /^#\/tutorial(?:[/?]|$)/.test(state.route));
    const adminOpen = ref(false); const adminContext = ref(null);
    provide('openAdmin', (context) => { if (state.me?.role !== 'admin') return; adminContext.value = context; adminOpen.value = true; });
    // #/tutorial은 원본 목록만 연다. 시작 버튼을 눌렀을 때 임시 문서를 만든다.
    // #/doc/<id>[?…] — 옛 주소 #/doc/<id>?legacy=1(v0.2 검토 보기)도 같은 편집기 화면을 연다
    const docId = computed(() => (/^#\/doc\/([\w-]+)/.exec(state.route) || [])[1] || null);
    onMounted(async () => {
      try { state.config = await (await fetch('/api/config')).json(); } catch { state.config = {}; }
      if (state.token) { try { await enterApp(await api('/api/me')); } catch (e) { if (e.status !== 401) toastError(e, '화면을 열지 못했습니다: '); state.token = ''; } }
      ready.value = true;
    });
    return { state, docId, toasts, ready, adminRoute, tutorialRoute, adminOpen, adminContext };
  },
};
createApp(App).mount('#app');
