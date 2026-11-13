// 웹 순수 도우미 시험(브라우저 없이): web/util.js josa·roleLabel, web/crs.js 검토 요청 제목 기본값·검토 수·'편집기에서 보기' 자리·막힘 줄 맞추기,
// web/store.js 내 승인 상태·작성자 알림 글. 웹 모듈은 브라우저용이라 '/vendor/vue.esm-browser.prod.js' 를 node_modules 의 vue 로 잇고
// (서버가 내보내는 것과 같은 파일) location 만 흉내 낸다 — DOM 은 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mod from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const VUE = pathToFileURL(`${root}/node_modules/vue/dist/vue.esm-browser.prod.js`).href;
const SPEC = '/vendor/vue.esm-browser.prod.js';
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({ resolve: (s, c, next) => (s === SPEC ? { url: VUE, format: 'module', shortCircuit: true } : next(s, c)) });
} else {
  mod.register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === ${JSON.stringify(SPEC)} ? { url: ${JSON.stringify(VUE)}, format: 'module', shortCircuit: true } : n(s, c); }`)}`);
}
globalThis.location ??= { hash: '#/', protocol: 'http:', host: 'localhost' };

const web = (name) => import(pathToFileURL(`${root}/web/${name}`).href);
const util = await web('util.js');
const { josa, roleLabel } = util;
const crs = await web('crs.js');
const store = await web('store.js');

test('API 전용 화면에서는 개인 실행기·대기열을 보낼 곳에 제시하지 않는다', () => {
  const personalAi = { active: true, apiOnly: true, provider: 'openai' };
  const env = util.workEnv({ agentMe: { online: true, sessions: [{ channel: true, agent: 'Codex' }] }, personalAi, serverAi: true });
  assert.deepEqual([env.agent, env.auto, env.autoRoute], ['', '관리자 API', 'server']);
  assert.deepEqual(util.routeOptions(env), [{ value: 'server', label: '관리자 API' }]);
  const off = util.workEnv({ personalAi: { ...personalAi, active: false }, serverAi: true });
  assert.equal(off.serverOn, false);
  assert.deepEqual(util.routeOptions(off), [{ value: 'server', label: 'API 연결 필요' }]);
});

test('josa: 끝소리(받침)에 맞춰 을/를·이/가·은/는·과/와·으로/로', () => {
  const cases = [
    ['메모', '을/를', '메모를'], ['제안', '을/를', '제안을'], ['홍길동', '이/가', '홍길동이'], ['김검토', '이/가', '김검토가'],
    ['김검토', '와/과', '김검토와'], ['문단', '과/와', '문단과'], ['검토 요청', '은/는', '검토 요청은'], ['문서', '은/는', '문서는'],
    // 으로/로: 받침 없음·ㄹ 받침 → 로
    ['문서', '으로/로', '문서로'], ['파일', '으로/로', '파일로'], ['문단', '으로/로', '문단으로'],
    // 어느 쪽을 앞에 써도 같다
    ['메모', '를/을', '메모를'], ['제안', '가/이', '제안이'],
  ];
  for (const [w, p, want] of cases) assert.equal(josa(w, p), want, `${w} + ${p}`);
});

test('josa: 숫자는 한국어로 읽은 소리(#3 삼·#2 이·#10 십·#100 백·#1000 천·v7 칠)', () => {
  const cases = [
    ['변경 요청 #1', '을/를', '변경 요청 #1을'], ['변경 요청 #2', '을/를', '변경 요청 #2를'], ['제안 #3', '을/를', '제안 #3을'],
    ['제안 #4', '이/가', '제안 #4가'], ['#5', '은/는', '#5는'], ['#6', '이/가', '#6이'], ['#7', '을/를', '#7을'], ['#8', '와/과', '#8과'],
    ['#9', '을/를', '#9를'], ['#10', '이/가', '#10이'], ['#20', '을/를', '#20을'], ['#100', '은/는', '#100은'], ['#1000', '이/가', '#1000이'],
    ['#10000', '을/를', '#10000을'], ['#0', '이/가', '#0이'], ['#12', '을/를', '#12를'],
    ['v3', '으로/로', 'v3으로'], ['v2', '으로/로', 'v2로'], ['v7', '으로/로', 'v7로'], ['v10', '과/와', 'v10과'],
  ];
  for (const [w, p, want] of cases) assert.equal(josa(w, p), want, `${w} + ${p}`);
});

test('josa: 영문자는 글자 이름(엘·엠·엔·알만 받침) · 괄호 덧붙임·따옴표는 건너뜀 · 모르면 을(를)', () => {
  assert.equal(josa('AI', '이/가'), 'AI가');
  assert.equal(josa('URL', '을/를'), 'URL을');
  assert.equal(josa('PDF', '을/를'), 'PDF를');
  assert.equal(josa('HTML', '으로/로'), 'HTML로');   // 엘 — ㄹ 받침
  assert.equal(josa('Claude Code', '이/가'), 'Claude Code가');
  assert.equal(josa('변경 요청 #3(홍길동)', '을/를'), '변경 요청 #3(홍길동)을');
  assert.equal(josa('변경 요청 #2(김검토)', '을/를'), '변경 요청 #2(김검토)를');
  assert.equal(josa('「예산」', '을/를'), '「예산」을');
  assert.equal(josa("'data.xlsx'", '을/를'), "'data.xlsx'를");
  assert.equal(josa('***', '을/를'), '***을(를)');
  assert.equal(josa('', '이/가'), '이(가)');
});

test('josa: 영어 낱말(문서 제목·첨부 이름)은 흔한 끝소리로 — -er·-or 받침 없음 · -le = ㄹ · -me·-ne·-ng 받침 · 줄임말·확장자는 글자 이름', () => {
  const cases = [
    ["'Server'", '을/를', "'Server'를"], ['Paper', '이/가', 'Paper가'], ['Order', '은/는', 'Order는'], ['Seminar', '과/와', 'Seminar와'],
    ['Google', '을/를', 'Google을'], ['Google', '으로/로', 'Google로'], ['Table', '이/가', 'Table이'],
    ['Game', '을/를', 'Game을'], ['Online', '이/가', 'Online이'], ['Meeting', '을/를', 'Meeting을'], ['Meeting', '으로/로', 'Meeting으로'],
    ['Excel', '을/를', 'Excel을'], ['Plan', '이/가', 'Plan이'], ['Report', '을/를', 'Report를'], ['Code', '이/가', 'Code가'],
    // 짧은 홀소리 + t = ㅅ 받침(챗·로봇), 긴 홀소리·자음 + t 는 '트'(시트·리포트)
    ['API', '으로/로', 'API로'], ['Robot', '이/가', 'Robot이'], ['Sheet', '을/를', 'Sheet를'], ['Codex', '으로/로', 'Codex로'],
    // 줄임말(대문자)·확장자·한 글자는 글자 이름 그대로
    ['OCR', '을/를', 'OCR을'], ['QR', '으로/로', 'QR로'], ['ChatGPT', '이/가', 'ChatGPT가'], ['PNG', '을/를', 'PNG를'],
    ["'image.png'", '을/를', "'image.png'를"], ["'notes.md'", '을/를', "'notes.md'를"], ["'a.html'", '을/를', "'a.html'을"], ['Plan A', '이/가', 'Plan A가'],
  ];
  for (const [w, p, want] of cases) assert.equal(josa(w, p), want, `${w} + ${p}`);
});

test('sendToLabel: 바로 보내는 단추·메뉴의 보낼 곳 이름표 — 조사 으로/로, 대기열은 넣기', () => {
  const { sendToLabel } = util;
  assert.equal(sendToLabel('Claude Code', 'agent'), 'Claude Code로 보내기');
  assert.equal(sendToLabel('Codex', 'agent'), 'Codex로 보내기');
  assert.equal(sendToLabel('API', 'server'), 'API로 보내기');
  assert.equal(sendToLabel('AI', 'server'), 'AI로 보내기');
  assert.equal(sendToLabel('대기열', 'queue'), '대기열에 넣기');
  assert.equal(sendToLabel('', 'agent'), '대기열에 넣기');
});

test('roleLabel: admin → 관리자, editor → 편집자, 모르는 역할은 그대로', () => {
  assert.equal(roleLabel('admin'), '관리자');
  assert.equal(roleLabel('editor'), '편집자');
  assert.equal(roleLabel('viewer'), 'viewer');
  assert.equal(roleLabel(undefined), '');
});

test('검토 요청 제목 기본값 = 첫 덩어리에서 바뀐 것(30자까지, 덩어리가 더 있으면 외 n곳)', () => {
  const rep = (baseText, newText, extra = {}) => ({ hid: 'h', type: 'replace', ref: 's0/p4', baseText, newText, ...extra });
  const t = (hunks) => crs.defaultTitle({ cid: 3, hunks });
  // 바꿈: 새 글에서 바뀐 낱말(낱말 가운데서 시작·끝나면 그 낱말 끝까지)
  assert.equal(t([rep('다섯째 문단: 추진 일정은 3월부터 12월까지입니다.', '다섯째 문단: 추진 일정은 4월부터 12월까지입니다.')]), '「4월부터」 수정');
  assert.equal(t([rep('예산은 총 1억 원입니다.', '예산은 총 2억 원입니다.'), rep('a', 'b', { ref: 's0/p6' })]), '「2억」 수정 외 1곳');
  // 넣기만 함 → 추가(앞 낱말을 끌어오지 않음), 지우기만 함 → 옛 글의 그 낱말 삭제
  assert.equal(t([rep('첫째 문단입니다. 메모 대상 문장이 여기 있습니다.', '첫째 문단입니다. 메모 대상 문장이 여기 있습니다. 함께 고쳐 봅니다.')]), '「함께 고쳐 봅니다.」 추가');
  assert.equal(t([rep('셋째 문단은 아주 그대로 둡니다.', '셋째 문단은 그대로 둡니다.')]), '「아주」 삭제');
  assert.equal(t([rep('사업 개요', '사업 개요(1차)')]), '「개요(1차)」 추가');
  // 문단 추가·지움
  assert.equal(t([{ hid: 'i', type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '새로 넣는 문단입니다.' }]), '문단 추가: 새로 넣는 문단입니다.');
  assert.equal(t([{ hid: 'd', type: 'delete', ref: 's0/p2', baseText: '지울 문단', newText: '' }, rep('x', 'y'), rep('p', 'q')]), '문단 삭제 외 2곳');
  // 길면 30자 안으로(…)
  const long = t([rep('가', '아주 긴 문장으로 문단 전체를 새로 고쳐 썼습니다 그래서 제목이 길어집니다'), rep('a', 'b'), rep('c', 'd'), rep('e', 'f'), rep('g', 'h'), rep('i', 'j'), rep('k', 'l'), rep('m', 'n'), rep('o', 'p'), rep('q', 'r'), rep('s', 't')]);
  assert.ok(Array.from(long).length <= crs.TITLE_MAX && long.includes('…') && long.endsWith(' 외 10곳'), long);
  const ins = t([{ hid: 'i', type: 'insert', afterRef: 's0/p1', ref: 's0/p1', baseText: '', newText: '가'.repeat(60) }]);
  assert.ok(Array.from(ins).length <= crs.TITLE_MAX && ins.startsWith('문단 추가: ') && ins.endsWith('…'), ins);
  assert.equal(crs.defaultTitle({ hunks: [] }), '');
  // 빈 문단을 넣음 → '빈 문단 추가'('문단 추가: ' 로 끝나지 않게)
  assert.equal(t([{ hid: 'i', type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '' }]), '빈 문단 추가');
  assert.equal(t([{ hid: 'i', type: 'insert', ref: 's0/p1', afterRef: 's0/p1', baseText: '', newText: '  ' }, rep('a', 'b')]), '빈 문단 추가 외 1곳');
  // 띄어쓰기만 바뀜 → 문단 글 앞부분 + '띄어쓰기 수정'(문단 글 전체를 추가·삭제했다고 하지 않음), 길어도 30자 안
  assert.equal(t([rep('사업 개요를 적습니다.', '사업개요를 적습니다.')]), '「사업개요를 적습니다.」 띄어쓰기 수정');
  assert.equal(t([rep('예산은 총 1억 원입니다.', '예산은 총 1억 원입니다. ')]), '「예산은 총 1억 원입니다.」 띄어쓰기 수정');
  const sp = t([rep('아주 긴 문장으로 문단 전체를 새로 고쳐 썼습니다 그래서 제목이 길어집니다', '아주 긴 문장으로  문단 전체를 새로 고쳐 썼습니다 그래서 제목이 길어집니다'), rep('a', 'b')]);
  assert.ok(Array.from(sp).length <= crs.TITLE_MAX && sp.endsWith('」 띄어쓰기 수정 외 1곳') && sp.includes('…'), sp);
});

test('검토 수·판단 이름: 승인 · 다시 승인 필요(staleApprovals) · 수정 요청 · 의견(스레드 + 의견만)', () => {
  const cr = { cid: 7, status: 'open', approvals: 1, staleApprovals: 2, changesRequested: 1, threads: [{}, {}], reviews: [{ verdict: 'comment' }, { verdict: 'approve' }] };
  assert.deepEqual(crs.crCounts(cr), { approvals: 1, stale: 2, changes: 1, comments: 3 });
  assert.deepEqual(crs.crCounts(null), { approvals: 0, stale: 0, changes: 0, comments: 0 });
  // 상단 칩·카드: 상태 + 번호, 0 인 수정 요청·의견은 빼고 초안에는 승인 수를 쓰지 않는다(docs/UI_TERMS.md §1)
  assert.equal(crs.crChipText(cr), '검토 중 #7 · 승인 1 · 수정 요청 1 · 의견 3');
  assert.equal(crs.crChipText({ cid: 8, status: 'open', approvals: 0, changesRequested: 0, threads: [], reviews: [] }), '검토 중 #8 · 승인 0');
  assert.deepEqual(crs.crCountParts({ status: 'draft', approvals: 0, threads: [{}] }), ['의견 1']);
  assert.equal(crs.crChipText(null), '');
  assert.equal(crs.VERDICT.changes, '수정 요청');
  assert.equal(crs.verdictLabel({ verdict: 'changes' }), '수정 요청');
  assert.equal(crs.verdictLabel({ verdict: 'approve' }), '승인');
  assert.equal(crs.verdictLabel({ verdict: 'approve', stale: { at: 'x', by: '홍길동' } }), '승인(내용 바뀜)');
  assert.equal(crs.isStaleReview({ verdict: 'changes', stale: { at: 'x' } }), false);
  // 옛 자료의 이상한 판단 이름(객체 원형 키)은 그 글 그대로 — 함수 글('function Object()…')이 보이지 않게
  assert.equal(crs.verdictLabel({ verdict: 'constructor' }), 'constructor');
  assert.equal(crs.verdictLabel({ verdict: 'toString' }), 'toString');
  assert.equal(crs.DRAFT_APPROVE_TIP, '검토 요청 후 승인할 수 있습니다');
});

test("'편집기에서 보기' 자리: 진행 중 = curRef · 반영됨 = 그 문단이 지금 기준에 있을 때 · 닫힘·지운 문단은 없음", () => {
  const paras = [{ ref: 's0/p0', text: '머리' }, { ref: 's0/p1', text: '바뀐 글' }, { ref: 's0/p2', text: '끝' }, { ref: 's0/p3', text: '바뀐 글' }, { ref: 's0/p4', text: '바뀐 글', where: '메모' }];
  const h = { hid: 'h1', type: 'replace', ref: 's0/p3', baseText: '옛 글', newText: '바뀐 글' };
  // 진행 중: 서버 curRef 그대로(없으면 사라진 문단)
  assert.deepEqual(crs.hunkViewRef({ status: 'open', hunks: [h] }, { ...h, curRef: 's0/p9' }, paras), { ref: 's0/p9', why: '' });
  assert.equal(crs.hunkViewRef({ status: 'draft', hunks: [h] }, { ...h, curRef: null }, paras).ref, null);
  // 반영됨 + 서버가 curRef 를 줌: 지금 기준에 있을 때만
  const withCur = { status: 'merged', hunks: [{ ...h, curRef: 's0/p1' }] };
  assert.deepEqual(crs.hunkViewRef(withCur, withCur.hunks[0], paras), { ref: 's0/p1', why: '' });
  assert.equal(crs.hunkViewRef(withCur, { ...h, curRef: 's0/p8' }, paras).ref, null);
  // 반영됨 + curRef 없음(서버가 안 줌): 새 글과 같은 문단 — 그 자리 먼저, 아니면 가장 가까운 것(메모 문단은 빼고)
  const merged = { status: 'merged', hunks: [h] };
  assert.equal(crs.hunkViewRef(merged, h, paras).ref, 's0/p3');
  assert.equal(crs.hunkViewRef(merged, { ...h, ref: 's0/p0' }, paras).ref, 's0/p1');
  const gone = crs.hunkViewRef(merged, { ...h, newText: '지금은 없는 글' }, paras);
  assert.equal(gone.ref, null); assert.match(gone.why, /지금 문서에 없습니다/);
  assert.equal(crs.hunkViewRef(merged, { hid: 'd', type: 'delete', ref: 's0/p2', baseText: '끝', newText: '' }, paras).ref, null);
  assert.equal(crs.hunkViewRef(merged, { hid: 'i', type: 'insert', ref: 's0/p0', afterRef: 's0/p0', baseText: '', newText: '바뀐 글' }, paras).ref, 's0/p1');
  // 닫힘: 기준에 들어가지 않았다
  const closed = crs.hunkViewRef({ status: 'closed', hunks: [h] }, h, paras);
  assert.equal(closed.ref, null); assert.match(closed.why, /닫힌/);
});

test('반영 실패 코드 ↔ 이미 보이는 막힘 이유(설명은 한 번만)', () => {
  const blockers = [{ code: 'NEED_APPROVAL', message: '다른 사람 승인이 1개 필요합니다' }, { code: 'PENDING_TRACKED', message: '…' }];
  assert.equal(crs.blockerFor('NEED_APPROVAL', blockers), 'NEED_APPROVAL');
  assert.equal(crs.blockerFor('MERGE_CONFLICT', blockers), 'PENDING_TRACKED');
  assert.equal(crs.blockerFor('MERGE_CONFLICT', [{ code: 'CONFLICT' }]), 'CONFLICT');
  assert.equal(crs.blockerFor('NEED_APPROVAL', []), null);
  assert.equal(crs.blockerFor('FORBIDDEN', blockers), null);
});

test("덩어리 상태 이름표(UI_TERMS): 원문 바뀜 · 사라짐 · 충돌 — '기준' 낱말 없음", () => {
  assert.equal(crs.hunkBadge({ state: 'conflict' }).label, '원문 바뀜');
  assert.equal(crs.hunkBadge({ state: 'gone' }).label, '사라짐');
  assert.equal(crs.hunkBadge({ conflict: { reason: 'TEXT' } }).label, '충돌');
  assert.equal(crs.hunkBadge({ state: 'ok' }), null);
  for (const h of [{ state: 'conflict' }, { state: 'gone' }]) assert.doesNotMatch(crs.hunkBadge(h).title, /기준/);
  assert.equal(crs.REBASE_LABEL, '최신으로 맞추기');
});

test('내 승인 상태(사람이 직접 남긴 마지막 승인·수정 요청) · 낡은 승인 알림 글', () => {
  const me = '김검토';
  const rv = (verdict, extra = {}) => ({ by: me, at: 't', verdict, body: '', ...extra });
  assert.equal(store.myApprovalState({ reviews: [rv('approve')] }, me), 'live');
  assert.equal(store.myApprovalState({ reviews: [rv('approve', { stale: { at: 't', by: '홍길동' } })] }, me), 'stale');
  assert.equal(store.myApprovalState({ reviews: [rv('approve'), rv('changes')] }, me), null);
  assert.equal(store.myApprovalState({ reviews: [rv('changes'), rv('approve', { stale: { at: 't' } }), rv('comment')] }, me), 'stale');
  // 에이전트 검토·남의 검토는 내 승인을 바꾸지 않는다
  assert.equal(store.myApprovalState({ reviews: [rv('approve'), { by: `${me}(Claude)`, agent: 'Claude', verdict: 'changes' }, { by: '관리자', verdict: 'changes' }] }, me), 'live');
  assert.equal(store.myApprovalState({ reviews: [] }, me), null);
  assert.equal(store.myApprovalState(null, me), null);
  assert.equal(store.staleApprovalText(4), '변경 요청 #4 내용이 바뀌어 내 승인이 무효가 됐습니다 — 다시 확인해 주세요');
});

// ───────── v0.3.1 §9.7: AI 작업 '내 눈의 진행'(requestProgress) ─────────
const ME = '홍길동';
const P = (pid, x = {}) => ({ pid, rid: 2, type: 'replace', status: 'pending', ref: `s0/p${pid}`, find: 'a', replace: 'b', ...x });
/** 서버 기록만으로 '내 반영' 판단(store adoptedByMe 와 같은 꼴) + 지금 편집기 글에 들어 있는 pid */
const view = (inEffectPids = []) => ({
  me: ME,
  adoptedByMe: (p) => !!(p.adoptedBy && p.adoptedBy[ME]) || p.adopted?.by === ME,
  inEffect: (p) => inEffectPids.includes(p.pid),
});
const mineAdopt = (cid = 7) => ({ adoptedBy: { [ME]: { at: 't', cid } } });

test('requestProgress: 항목 규칙(서버 outcome 과 같음) — 반영(적용·반영해 둠)·거절·남음, 남은 pid(pid 순)·해결', () => {
  const ps = [P(5), P(3, { status: 'applied' }), P(4, { status: 'rejected' }), P(2, { status: 'undone' }), P(1)];
  const g = util.requestProgress({ status: 'done' }, ps, view());
  assert.deepEqual([g.items, g.accepted, g.declined, g.open, g.applied, g.adopted, g.openAlt, g.tables, g.resolved], [5, 1, 2, 2, 1, 0, 0, 0, false]);
  assert.deepEqual(g.openPids, [1, 5], '남은 pid 는 pid 순');
  assert.deepEqual(g.entries.map((e) => e.state), ['open', 'accepted', 'declined', 'declined', 'open'], '항목은 처음 나온 차례');
  // 남은 것이 없으면 완료·취소된 요청만 해결(대기·처리 중·실패는 아님)
  const all = [P(1, { status: 'applied' }), P(2, { status: 'rejected' })];
  for (const [status, want] of [['done', true], ['cancelled', true], ['pending', false], ['working', false], ['failed', false]]) {
    assert.equal(util.requestProgress({ status }, all, view()).resolved, want, status);
  }
  // 제안이 없는 완료(의견만·고칠 곳 없음)도 해결
  const none = util.requestProgress({ status: 'done' }, [], view());
  assert.deepEqual([none.items, none.open, none.resolved], [0, 0, true]);
  assert.equal(util.requestProgress({ status: 'working' }, [], view()).resolved, false);
});

test('requestProgress: 내 반영은 지금 편집기 글에 들어 있을 때만 반영 — Ctrl+Z 로 되돌렸으면 다시 남음 · 남이 반영해 둔 것은 반영', () => {
  const ps = [P(1, mineAdopt()), P(2, mineAdopt()), P(3)];
  const inEd = util.requestProgress({ status: 'done' }, ps, view([1, 2]));
  assert.deepEqual([inEd.accepted, inEd.adopted, inEd.open, inEd.resolved], [2, 2, 1, false]);
  assert.deepEqual(inEd.openPids, [3]);
  // 편집기에서 되돌림(그 문단이 기준과 같아짐) → 서버 기록이 남아 있어도 다시 남음
  const undone = util.requestProgress({ status: 'done' }, ps, view([]));
  assert.deepEqual([undone.accepted, undone.open], [0, 3]);
  assert.deepEqual(undone.openPids, [1, 2, 3], '되돌린 내 반영은 다시 [모두 반영] 대상');
  // 남(김검토)이 자기 수정본에 반영해 둔 것은 누가 했든 반영(요청의 할 일은 끝남)
  const other = util.requestProgress({ status: 'done' }, [P(1, { adoptedBy: { 김검토: { at: 't', cid: 3 } } })], view([]));
  assert.deepEqual([other.accepted, other.adopted, other.open, other.resolved], [1, 1, 0, true]);
  // 옛 모양(adopted = { by }) 도 같다
  assert.equal(util.requestProgress({ status: 'done' }, [P(1, { adopted: { by: '김검토', cid: 3 } })], view([])).accepted, 1);
  assert.equal(util.requestProgress({ status: 'done' }, [P(1, { adopted: { by: ME, cid: 3 } })], view([])).open, 1);
  // 내 이름의 옛 기록(끝난 변경 요청 — store 의 adoptedByMe 가 빼는 것)은 '남'으로 세지 않는다
  const stale = util.requestProgress({ status: 'done' }, [P(1, mineAdopt(99))], { ...view([1]), adoptedByMe: () => false });
  assert.deepEqual([stale.accepted, stale.open], [0, 1]);
  // 내 이름을 모르면(me 없음) 기록 수로 어림: 나 말고 더 있으면 남
  const noMe = { adoptedByMe: (p) => !!p.adoptedBy?.[ME], inEffect: () => false };
  assert.equal(util.requestProgress({ status: 'done' }, [P(1, { adoptedBy: { [ME]: {}, 김검토: {} } })], noMe).accepted, 1);
  assert.equal(util.requestProgress({ status: 'done' }, [P(1, mineAdopt())], noMe).accepted, 0);
});

test('requestProgress: 여러 안 묶음(gid)은 항목 하나 — 고를 묶음(openAlt)은 남은 pid 에 넣지 않음 · 한 안 반영이면 묶음 반영 · 안 차례', () => {
  const alt = (pid, option, x = {}) => P(pid, { gid: 9, option, ...x });
  const g = util.requestProgress({ status: 'done' }, [alt(12, 3), alt(10, 1), alt(11, 2), P(13)], view());
  assert.deepEqual([g.items, g.open, g.openAlt, g.openPids], [2, 2, 1, [13]]);
  assert.deepEqual(g.entries[0].list.map((p) => p.pid), [10, 11, 12], '묶음 안은 안 차례');
  // 한 안을 내가 반영해 둠(편집기에 있음) → 묶음 반영
  const picked = util.requestProgress({ status: 'done' }, [alt(10, 1, mineAdopt()), alt(11, 2), P(13, { status: 'rejected' })], view([10]));
  assert.deepEqual([picked.accepted, picked.declined, picked.open, picked.resolved], [1, 1, 0, true]);
  // 한 안을 적용 → 나머지는 대체(superseded) — 묶음 반영
  const applied = util.requestProgress({ status: 'done' }, [alt(10, 1, { status: 'superseded' }), alt(11, 2, { status: 'applied' })], view());
  assert.deepEqual([applied.accepted, applied.applied, applied.open], [1, 1, 0]);
  // 모든 안이 거절·복구·대체 → 묶음 거절
  const no = util.requestProgress({ status: 'done' }, [alt(10, 1, { status: 'rejected' }), alt(11, 2, { status: 'undone' }), alt(12, 3, { status: 'superseded' })], view());
  assert.deepEqual([no.declined, no.open, no.resolved], [1, 0, true]);
});

test('requestProgress: 표 제안은 남은 pid 에 들되 tables 로 따로 셈([모두 반영]은 표를 빼고 — 기준에 바로 적용만)', () => {
  const g = util.requestProgress({ status: 'done' }, [P(1, { type: 'table', afterRef: 's0/p1' }), P(2, { type: 'insert', afterRef: 's0/p2', text: '새 문단' }), P(3)], view());
  assert.deepEqual([g.open, g.tables, g.openPids], [3, 1, [1, 2, 3]]);
  assert.equal(g.openPids.length - g.tables, 2, '한 번에 내 수정본에 넣을 수 있는 것 = 바꿈·문단 추가');
});

test('진행 줄·완료 줄·편집기에 넣지 못한 까닭 글', () => {
  const pr = (x) => ({ items: 0, accepted: 0, declined: 0, open: 0, ...x });
  assert.equal(util.progressText(pr({ items: 16, accepted: 3, declined: 1, open: 12 })), '제안 16건 — 반영 3 · 거절 1 · 남음 12');
  assert.equal(util.progressText(pr({ items: 4, open: 4 })), '제안 4건 — 남음 4', '0 인 쪽은 뺌');
  assert.equal(util.progressText(pr({ items: 2, accepted: 2 })), '제안 2건 — 반영 2');
  assert.equal(util.progressText(pr({})), '', '제안이 없으면 줄 없음');
  assert.equal(util.resolvedText(pr({ items: 16, accepted: 14, declined: 2 }), { status: 'done' }), '✓ 완료 · 반영 14 · 거절 2');
  assert.equal(util.resolvedText(pr({ items: 2, declined: 2 }), { status: 'done' }), '✓ 완료 · 거절 2');
  assert.equal(util.resolvedText(pr({}), { status: 'done', outcome: { comments: 1 } }), '✓ 완료 · 의견 1');
  assert.equal(util.resolvedText(pr({}), { status: 'done', comments: [] }), '✓ 완료 · 고칠 곳 없음');
  assert.equal(util.resolvedText(pr({ items: 1, accepted: 1 }), { status: 'cancelled' }), '✓ 완료 · 반영 1 · 취소됨');
  assert.equal(util.resolvedText(pr({}), { status: 'cancelled' }), '✓ 완료 · 취소됨');
  // 상태 칩 곁(레일·검토 탭·AI 작업 탭 카드·결과 창 — RequestActions): '✓ 완료'·'취소됨'은 칩이 말하므로 수만
  assert.equal(util.resolvedText(pr({ items: 4, accepted: 3, declined: 1 }), { status: 'done' }, { head: false }), '반영 3 · 거절 1');
  assert.equal(util.resolvedText(pr({}), { status: 'done', comments: [] }, { head: false }), '고칠 곳 없음');
  assert.equal(util.resolvedText(pr({}), { status: 'cancelled' }, { head: false }), '');
  const res = [{ key: 1, ok: true }, { key: 2, ok: false, reason: 'NOT_FOUND' }, { key: 3, ok: false, reason: 'NOT_FOUND' }, { key: 4, ok: false, reason: 'OVERLAP' }, { key: 5, ok: false, reason: 'NO_PARAGRAPH' }, { key: 6, ok: false, reason: 'ERROR' }];
  assert.equal(util.batchFailText(res), ' · 2건은 찾지 못함 · 1건은 다른 제안과 겹침 · 1건은 문단이 편집기에 없음 · 1건은 반영하지 못함');
  assert.equal(util.batchFailText([{ key: 1, ok: true }]), '');
  assert.equal(util.batchFailText(null), '');
});

test('applyBatch 항목(제안 → 편집기 인자)·내 반영 되돌리기 인자', () => {
  assert.deepEqual(store.batchItemOf(P(7, { find: '있습니다', replace: '있음', occurrence: 2 })), { op: 'text', ref: 's0/p7', find: '있습니다', replace: '있음', occurrence: 2, key: 7 });
  assert.deepEqual(store.batchItemOf(P(8, { start: 3, end: 6 })), { op: 'text', ref: 's0/p8', find: 'a', replace: 'b', occurrence: 1, key: 8, start: 3, end: 6 }, '범위는 정수일 때만');
  assert.ok(!('start' in store.batchItemOf(P(8, { start: 3, end: null }))));
  assert.deepEqual(store.batchItemOf(P(9, { type: 'insert', afterRef: 's0/p2', text: '새 문단' })), { op: 'insert', afterRef: 's0/p2', text: '새 문단', key: 9 });
  assert.deepEqual(store.batchItemOf({ pid: '10', type: 'insert', ref: 's0/p4' }), { op: 'insert', afterRef: 's0/p4', text: '', key: 10 }, 'afterRef 없으면 ref');
  // 되돌리기: 지금 글의 replace → 원문 find(원래 범위가 있으면 같이)
  assert.deepEqual(store.revertArgOf(P(7, { find: '있습니다', replace: '있음', start: 3, end: 7 })), { ref: 's0/p7', find: '있음', replace: '있습니다', occurrence: 1, label: '제안 #7 되돌림', start: 3, end: 7 });
  assert.deepEqual(store.revertArgOf(P(7, { find: '', replace: '12' })), { ref: 's0/p7', find: '12', replace: '', occurrence: 1, label: '제안 #7 되돌림' }, '빈 칸 채우기 되돌림');
  assert.equal(store.revertArgOf(P(7, { find: '지울 글', replace: '' })), null, '지운 제안인데 범위를 모르면 되돌릴 자리를 모른다(문단 끝에 붙지 않게)');
  assert.ok(store.revertArgOf(P(7, { find: '지울 글', replace: '', start: 0, end: 4 })), '범위가 있으면 그 자리에 되살림');
  assert.equal(store.revertArgOf(P(7, { type: 'insert' })), null, '문단 추가는 편집기에서 직접 지운다');
});

test('사람용 버전: 시각 글·이정표 찾기·상단 알약 설명·내려받기 이름(기록 번호는 쓰지 않음)', () => {
  const at = new Date(2026, 9, 23, 1, 16).toISOString();   // 이 컴퓨터 시각 10-23 01:16
  assert.equal(util.fmtStamp(at), '10-23 01:16');
  assert.equal(util.fileStamp(at), '10-23_0116');
  assert.equal(util.fmtStamp(null), ''); assert.equal(util.fmtStamp('x'), '');
  const ms = [{ v: 1, n: 1 }, { v: 2, n: 5 }, { v: 3, n: 9 }];
  assert.equal(util.milestoneAt(ms, 7).v, 2); assert.equal(util.milestoneAt(ms, 9).v, 3); assert.equal(util.milestoneAt(ms, 1).v, 1);
  assert.equal(util.milestoneAt(ms, 0), null); assert.equal(util.milestoneAt(null, 3), null);
  const m3 = { v: 3, n: 9, at, by: '관리자', kind: 'request', note: 'AI 작업 #2 해결 — 적용 14건' };
  assert.equal(util.versionTip(m3, 5), '버전 v3 · 10-23 01:16 · AI 작업 #2 해결 — 적용 14건(관리자) · 그 뒤 변경 이력 5개 — 이력 탭에서 보기');
  assert.equal(util.versionTip(m3, 0), '버전 v3 · 10-23 01:16 · AI 작업 #2 해결 — 적용 14건(관리자) · 그 뒤 변경 없음 — 이력 탭에서 보기');
  assert.equal(util.downloadName('회의록', { v: 3, at }), '회의록_v3.hwpx');
  assert.equal(util.downloadName('회의록', { at }), '회의록_10-23_0116.hwpx');
  assert.equal(util.downloadName('a/b:c', { v: 1 }), 'a_b_c_v1.hwpx', '파일 이름에 못 쓰는 글자');
  assert.equal(util.downloadName('', { v: 2 }), 'document_v2.hwpx');
  // 변경 요청 화면: baseV·mergedV(옛 서버면 그때의 버전 번호), 반영 글 'v4로 반영'(조사)
  assert.equal(crs.baseVOf({ baseV: 3, baseVersion: 17 }), 3);
  assert.equal(crs.baseVOf({ baseVersion: 4 }), 4, '옛 서버');
  assert.equal(crs.mergedText({ mergedV: 4, mergedVersion: 20 }), 'v4로 반영');
  assert.equal(crs.mergedText({ mergedV: 3 }), 'v3으로 반영');
  assert.equal(crs.mergedText({ mergedV: null, mergedVersion: 20 }), '반영', '새 서버가 모르면 번호 없이');
  assert.equal(crs.mergedText({ mergedVersion: 6 }), 'v6으로 반영', '옛 서버');
});

test('작성자 알림 글: 남이 내 변경 요청에 승인·수정 요청·의견', () => {
  const m = (x) => store.crFeedbackText({ type: 'cr', cid: 3, author: '홍길동', by: '김검토', ...x });
  assert.equal(m({ action: 'review', verdict: 'approve' }), '김검토 님이 내 변경 요청 #3을 승인했습니다');
  assert.equal(m({ action: 'review', verdict: 'changes' }), '김검토 님이 내 변경 요청 #3에 수정을 요청했습니다');
  assert.equal(m({ action: 'review', verdict: 'comment' }), '김검토 님이 내 변경 요청 #3에 의견을 남겼습니다');
  assert.equal(m({ action: 'thread', tid: 2 }), '김검토 님이 내 변경 요청 #3에 의견을 달았습니다');
  assert.equal(m({ action: 'thread', tid: 2, resolved: true }), '');   // 해결·다시 열기는 알리지 않음
  assert.equal(m({ action: 'merged' }), '');
  assert.equal(store.crFeedbackText({ type: 'cr', cid: 2, action: 'review', verdict: 'approve', by: '관리자' }), '관리자 님이 내 변경 요청 #2를 승인했습니다');
});

test('요청·메모 대상 문제(v0.4 실시간 문서): [최신으로 맞추기] 대신 편집기가 맞춰진 뒤 · 방금 친 글은 공유 문서에 들어가는 중', () => {
  const { targetProblem } = store;
  assert.match(targetProblem({ ref: 's0/p1', stale: true }, 'review'), /\[최신으로 맞추기\] 뒤에 다시 고르세요$/);
  assert.match(targetProblem({ ref: null, gone: true }, 'review'), /^고른 문단이 지금 문서에 없습니다/);
  assert.match(targetProblem({ ref: 's0/p1', stale: true }, 'review', { realtime: true }), /편집기가 맞춰진 뒤\(잠시 뒤\) 다시 고르세요$/);
  assert.match(targetProblem({ ref: null, gone: true }, 'memo', { realtime: true }), /편집기가 맞춰진 뒤/);
  assert.match(targetProblem({ ref: 's0/p1', draftOnly: true }, 'review', { realtime: true }), /방금 친 글은 아직 공유 문서에 들어가는 중/);
  assert.equal(targetProblem({ ref: 's0/p1', draftOnly: true }, 'memo', { realtime: true }), '');
  assert.match(targetProblem({ ref: 's0/p1', draftOnly: true }, 'review'), /내 수정본에서 고친 글은/);
});
