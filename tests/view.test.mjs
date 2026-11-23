// web/view.js 시험(v0.4 docs/V4_SPEC.md §1·§2.4·§2.6·§3·§5 — 브라우저 없이): 보기 '간단히'·'자세히' 규칙(남의 AI 작업 제안 숨김·패널 탭·검토 탭 거르기·
// 수정 중 한 줄), 문서 설정 모양·수정 권한·편집기 방식, AI 작업 한 줄 요약 글, 이력 탭 실시간 편집 묶음, 상단 칩·한글로 저장 설명, ⚙ 문서 설정 창 모델.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_KEY, readView, writeView, normSettings, DEFAULT_SETTINGS, canEditWith, editorMode, isMine, requestHidden, proposalHidden,
  panelTabIds, DETAIL_TABS, reviewFilterIds, filterPass, collapseDrafts, summaryHead, summaryChip, groupHistory, liveGroupLabel, LIVE_NOTE,
  liveChip, READONLY_TIP, exportTip, SETTING_FIELDS, SETTING_VALUES, REVIEW_FILTERS, settingsForm, settingsPatch, editorChoices, settingsWarning, QUICK_KINDS, quickAutoSend,
  PANEL, PANEL_KEY, clampPanelW, clampPanelH, panelHeightFrom, panelWidthFrom, readPanel, writePanel, TOOLS_KEY, readTools, writeTools,
  clampRailW, marginBox, railVisible, DEFAULT_PANEL, memoWidth, memoLeft, freeBox, MEMO_POS_KEY, readMemoPos, writeMemoPos,
} from '../web/view.js';

/** 시험용 저장소(localStorage 흉내) */
function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

test('보기: 기본은 간단히 · localStorage hwpx.view 에 적고 읽음 · 모르는 값·읽기 실패는 간단히', () => {
  assert.equal(VIEW_KEY, 'hwpx.view');
  assert.equal(readView(store()), 'simple');
  assert.equal(readView(store({ 'hwpx.view': 'detail' })), 'detail');
  assert.equal(readView(store({ 'hwpx.view': 'weird' })), 'simple');
  assert.equal(readView({ getItem: () => { throw new Error('막힘'); } }), 'simple');
  assert.equal(readView(null), 'simple');
  const st = store();
  assert.equal(writeView('detail', st), true);
  assert.equal(st.m.get('hwpx.view'), 'detail');
  writeView('nonsense', st);
  assert.equal(st.m.get('hwpx.view'), 'simple');
  assert.equal(writeView('detail', { setItem: () => { throw new Error('사생활 창'); } }), false);
});

test('오른쪽 창 크기: 폭은 280px 이상·편집기 360px 남김 · 160px 아래로 밀어 놓으면 접기(폭은 끌기 전 값) · 좁은 창 높이는 15~80%, 72px 아래로 끌면 접고 높이는 끌기 전 값 · hwpx.panel 에 기억', () => {
  assert.equal(clampPanelW(500, 1440), 500);
  assert.equal(clampPanelW(100, 1440), PANEL.wMin);
  assert.equal(clampPanelW(2000, 1440), 1440 - 360);
  assert.equal(clampPanelW(500, 600), PANEL.wMin);   // 편집기 몫이 모자라도 최소 폭은 지킨다
  assert.equal(clampPanelW(undefined, 0), PANEL.w);
  assert.equal(clampPanelW(612.6), 613);
  assert.deepEqual(panelWidthFrom(420, 1440, 360), { w: 420, pin: true });
  assert.deepEqual(panelWidthFrom(200, 1440, 360), { w: PANEL.wMin, pin: true });   // 최소 폭에서 멈춤
  assert.deepEqual(panelWidthFrom(120, 1440, 400), { w: 400, pin: false });   // 끝까지 밀면 접고 폭은 그대로
  assert.equal(clampPanelH(0.01), PANEL.hMin);
  assert.equal(clampPanelH(0.99), PANEL.hMax);
  assert.equal(clampPanelH('x'), PANEL.h);
  assert.deepEqual(panelHeightFrom(300, 600, 0.35), { h: 0.5, min: false });
  assert.deepEqual(panelHeightFrom(40, 600, 0.42), { h: 0.42, min: true });
  assert.deepEqual(panelHeightFrom(80, 800, 0.4), { h: PANEL.hMin, min: false });
  assert.deepEqual(panelHeightFrom(300, 0, 0.4), { h: 0.4, min: false });
  const st = store();
  const D = { w: PANEL.w, h: PANEL.h, min: false, r: PANEL.r, rmode: 'margin', pin: true };
  assert.deepEqual(DEFAULT_PANEL, D);
  assert.deepEqual(readPanel(st), D);
  assert.equal(writePanel({ w: 512, h: 0.5, min: true, r: 220, rmode: 'off', pin: false }, st), true);
  assert.deepEqual(JSON.parse(st.m.get(PANEL_KEY)), { w: 512, h: 0.5, min: true, r: 220, rmode: 'off', pin: false });
  assert.deepEqual(readPanel(st), { w: 512, h: 0.5, min: true, r: 220, rmode: 'off', pin: false });
  assert.deepEqual(readPanel(store({ [PANEL_KEY]: '{깨짐' })), D);
  assert.deepEqual(readPanel(store({ [PANEL_KEY]: JSON.stringify({ w: 10, h: 3, min: 'yes', r: 9999, rmode: 'weird', pin: 0 }) })), { w: PANEL.wMin, h: PANEL.hMax, min: false, r: PANEL.rMax, rmode: 'margin', pin: true });
  assert.deepEqual(readPanel(store({ [PANEL_KEY]: JSON.stringify({ w: 400 }) })), { ...D, w: 400 });   // 옛 기록은 기본(메모 보임·고정)
  assert.equal(readPanel(store({ [PANEL_KEY]: JSON.stringify({ rmode: 'column' }) })).rmode, 'margin');   // 옛 '오른쪽 칸'은 문서 옆으로
  assert.equal(writePanel({ w: 400 }, { setItem: () => { throw new Error('막힘'); } }), false);
});

test('문서 옆 메모: 쪽 오른쪽 끝 옆에 r 폭(빈 곳이 좁으면 빈 곳만큼, 아주 좁으면 스크롤바 앞에 겹쳐) · 보이는 조건 · 넓히기 · 끌어 옮긴 자리', () => {
  assert.equal(clampRailW(50), PANEL.rMin);
  assert.equal(clampRailW(900), PANEL.rMax);
  assert.equal(clampRailW('x'), PANEL.r);
  // 스크롤 칸 1200px, 쪽 오른쪽 끝 900 → 빈 곳 284(쪽과 8·스크롤바와 8 띄움) → 메모 칸 908 부터 284px
  assert.deepEqual(marginBox({ width: 1200, page: 900, left: 20, right: 15, top: 120.4, bottom: 28 }, 300), { top: 120, bottom: 28, left: 20, right: 15, col: { left: 908, width: 284, limit: 1200 } });
  assert.deepEqual(marginBox({ width: 1600, page: 900, right: 15 }, 300).col, { left: 908, width: 300, limit: 1600 });   // 넓어도 메모 칸 폭까지(쪽 바로 옆)
  assert.deepEqual(marginBox({ width: 1000, page: 900, right: 15 }, 300).col, { left: 1000 - 4 - PANEL.overMin, width: PANEL.overMin, limit: 1000 });   // 좁으면 최소 폭, 스크롤바 앞
  assert.deepEqual(marginBox({ width: 1000, page: 700, reserve: 30 }, 300).col, { left: 708, width: 254, limit: 970 });   // 꼭지 자리(30px)는 비운다
  assert.deepEqual(marginBox({ width: 1000, page: 900, reserve: 30 }, 300).col, { left: 970 - 4 - PANEL.overMin, width: PANEL.overMin, limit: 970 });
  assert.deepEqual(marginBox(null).col, { left: 0, width: PANEL.overMin, limit: 0 });
  assert.equal(marginBox({ width: 800, page: null }).col.width, PANEL.overMin);
  assert.equal(railVisible('margin', {}), true);
  assert.equal(railVisible('margin', { stacked: true }), false);
  assert.equal(railVisible('off', {}), false);
  // 폭: 보통 = 메모 칸, 고른 것 280px, 고치는 중 520px(층 폭 - 16 까지)
  assert.equal(memoWidth(150, '', 1000), 150);
  assert.equal(memoWidth(150, 'open', 1000), PANEL.open);
  assert.equal(memoWidth(300, 'open', 1000), 300);
  assert.equal(memoWidth(150, 'edit', 1000), PANEL.edit);
  assert.equal(memoWidth(150, 'edit', 400), 384);
  assert.equal(memoLeft(840, 150, 1000), 840);
  assert.equal(memoLeft(850, 520, 1000), 1000 - 4 - 520);   // 넓힌 메모는 층 오른쪽을 넘지 않게 왼쪽으로
  // 끌어 옮긴 자리: 메모 칸 + dx(층 안), 강조 높이 + dy
  assert.deepEqual(freeBox({ dx: -400, dy: 30 }, { colLeft: 900, top: 200 }, 150, 1200), { left: 500, top: 230 });
  assert.deepEqual(freeBox({ dx: 500, dy: -20 }, { colLeft: 900, top: 200 }, 150, 1200), { left: 1050, top: 180 });   // 오른쪽 밖 → 층 안
  assert.deepEqual(freeBox({ dx: -2000, dy: 0 }, { colLeft: 900, top: 0 }, 150, 1200), { left: 0, top: 0 });
  const st = store();
  assert.deepEqual(readMemoPos('d1', st), {});
  assert.equal(writeMemoPos('d1', { 'memo:3': { dx: 10.4, dy: -5 }, bad: { dx: 'x' }, 'request:7': { dx: 0, dy: 1 } }, st), true);
  assert.deepEqual(JSON.parse(st.m.get(MEMO_POS_KEY + 'd1')), { 'memo:3': { dx: 10, dy: -5 }, 'request:7': { dx: 0, dy: 1 } });
  assert.deepEqual(readMemoPos('d1', st), { 'memo:3': { dx: 10, dy: -5 }, 'request:7': { dx: 0, dy: 1 } });
  assert.deepEqual(readMemoPos('d2', st), {});   // 문서마다 따로
  writeMemoPos('d1', {}, st);
  assert.equal(st.m.has(MEMO_POS_KEY + 'd1'), false);   // 모두 제자리면 지운다
  assert.deepEqual(readMemoPos('d1', { getItem: () => { throw new Error('막힘'); } }), {});
});

test('휴대전화 폭 편집 도구 막대: 기본 숨김 · 켜면 hwpx.tools=show 로 기억 · 읽기 실패는 숨김', () => {
  const st = store();
  assert.equal(readTools(st), false);
  assert.equal(writeTools(true, st), true);
  assert.equal(st.m.get(TOOLS_KEY), 'show');
  assert.equal(readTools(st), true);
  writeTools(false, st);
  assert.equal(readTools(st), false);
  assert.equal(readTools({ getItem: () => { throw new Error('막힘'); } }), false);
});

test('문서 설정: 없거나 모르는 값은 기본값(실시간·편집자 모두·고친 글만·보이는 그대로·요약) · editors 이름 정리', () => {
  assert.deepEqual(normSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normSettings({ editMode: 'review', track: 'x', exportKind: 'tracked', aiMemo: 'detail', editors: [' 홍길동 ', '', '홍길동', '김검토'] }),
    { editMode: 'review', editors: ['홍길동', '김검토'], track: 'final', exportKind: 'tracked', aiMemo: 'detail', aiQuick: 'send', aiApply: 'manual' });
  assert.equal(normSettings({ editors: 'some' }).editors, 'all');
  assert.equal(DEFAULT_SETTINGS.aiQuick, 'send');
  assert.equal(normSettings({ aiQuick: 'compose' }).aiQuick, 'compose');
  assert.equal(normSettings({ aiQuick: 'later' }).aiQuick, 'send');
});

test('AI에게 빠르게 맡기기 바로 보내기(aiQuick): 예시 지시 instruct(+옛 검토·문장 제안·다듬기) · 설정 compose 면 창에서 확인 · 옛 문서(설정 없음)는 바로 보내기', () => {
  assert.deepEqual([...QUICK_KINDS], ['instruct', 'review', 'suggest', 'polish']);
  for (const k of QUICK_KINDS) {
    assert.equal(quickAutoSend({ aiQuick: 'send' }, k), true, k);
    assert.equal(quickAutoSend({ aiQuick: 'compose' }, k), false, k);
    assert.equal(quickAutoSend(null, k), true, `${k} 옛 문서`);
  }
  for (const k of ['fill_table', 'make_table', 'insert', 'memo', undefined]) assert.equal(quickAutoSend({ aiQuick: 'send' }, k), false, String(k));
});

test('수정 권한(서버 canEdit 과 같은 규칙): 관리자 언제나 · viewer 는 어디서나 읽기 전용 · 그 밖은 편집자 모두이거나 이름이 있을 때', () => {
  const all = { editors: 'all' }; const some = { editors: ['홍길동'] };
  assert.equal(canEditWith(all, { name: '관리자', role: 'admin' }), true);
  assert.equal(canEditWith(some, { name: '관리자', role: 'admin' }), true);
  assert.equal(canEditWith(all, { name: '열람', role: 'viewer' }), false);
  assert.equal(canEditWith(all, { name: '김검토', role: 'editor' }), true);
  assert.equal(canEditWith(some, { name: '김검토', role: 'editor' }), false);
  assert.equal(canEditWith(some, { name: '홍길동' }), true);
  assert.equal(canEditWith(all, null), false);
  // 문서함 권한(docs/LIBRARY_SPEC.md): 서버가 준 perms 가 있으면 역할 대신 그것 — 편집이 없으면 읽기 전용, viewer 도 자기 개인 문서는 편집
  assert.equal(canEditWith(all, { name: '김검토', role: 'editor' }, ['read']), false);
  assert.equal(canEditWith(all, { name: '열람', role: 'viewer' }, ['read', 'edit', 'delete', 'manage']), true);
  assert.equal(canEditWith(some, { name: '김검토', role: 'editor' }, ['read', 'edit']), false);
  assert.equal(canEditWith(all, { name: '관리자', role: 'admin' }, []), true);
});

test('편집기 방식: 실시간+권한 = live · 권한 없음 = follow(읽기 전용, 어느 방식이든) · 승인 = review · 옛 서버(설정 없음) = review', () => {
  assert.equal(editorMode({ settings: { editMode: 'realtime' }, canEdit: true }), 'live');
  assert.equal(editorMode({ settings: { editMode: 'realtime' }, canEdit: false }), 'follow');
  assert.equal(editorMode({ settings: { editMode: 'review' }, canEdit: false }), 'follow');
  assert.equal(editorMode({ settings: { editMode: 'review' }, canEdit: true }), 'review');
  assert.equal(editorMode({ settings: null, canEdit: true }), 'live');   // 서버가 settings 칸을 주면(값이 없어도) 기본값 = 실시간
  assert.equal(editorMode({ version: 3 }), 'review');
  assert.equal(editorMode(null), 'review');
});

test('간단히: 남의 AI 작업 제안은 숨김(한 줄 요약만) · 내 요청(내 에이전트 이름 포함)은 보임 · 자세히는 모두 보임 · 요청 없는 제안은 언제나 보임', () => {
  const mine = { rid: 1, by: '홍길동' }; const agent = { rid: 2, by: '홍길동(Claude)' }; const other = { rid: 3, by: '김검토' };
  const simple = { me: '홍길동', view: 'simple' }; const detail = { me: '홍길동', view: 'detail' };
  assert.equal(isMine('홍길동(Claude)', '홍길동'), true);
  assert.equal(isMine('홍길동님', '홍길동'), false);
  assert.equal(requestHidden(mine, simple), false);
  assert.equal(requestHidden(agent, simple), false);
  assert.equal(requestHidden(other, simple), true);
  assert.equal(requestHidden(other, detail), false);
  assert.equal(requestHidden(null, simple), false);
  assert.equal(requestHidden({ by: '관리자', recoveryOwner: simple.me }, simple), false, '관리자의 대신 재검토는 원요청자에게도 보인다');
  // 관리자도 기본은 같다(자세히면 모두)
  assert.equal(requestHidden(other, { me: '관리자', view: 'simple' }), true);
  const reqs = new Map([[1, mine], [3, other]]);
  const of = (rid) => reqs.get(rid) || null;
  assert.equal(proposalHidden({ pid: 7, rid: 3 }, of, simple), true);
  assert.equal(proposalHidden({ pid: 8, rid: 1 }, of, simple), false);
  assert.equal(proposalHidden({ pid: 9 }, of, simple), false);              // 사람이 낸 제안(요청 없음)
  assert.equal(proposalHidden({ pid: 10, rid: 99 }, of, simple), false);    // 모르는 요청은 숨기지 않는다
  assert.equal(proposalHidden({ pid: 7, rid: 3 }, of, detail), false);
});

test('편집기 탭: 간단히 = AI 작업·메모(+ 진행 중 변경 요청), 드라이브는 모든 보기에서 숨김', () => {
  assert.deepEqual(panelTabIds({ view: 'detail', realtime: true, activeCrs: 0 }), [...DETAIL_TABS]);
  assert.deepEqual(DETAIL_TABS, ['ai', 'review', 'cr', 'change', 'attach', 'history']);
  assert.deepEqual(panelTabIds({ view: 'simple', realtime: true, activeCrs: 3 }), ['ai', 'review']);
  assert.deepEqual(panelTabIds({ view: 'simple', realtime: false, activeCrs: 0 }), ['ai', 'review']);
  assert.deepEqual(panelTabIds({ view: 'simple', realtime: false, activeCrs: 1 }), ['ai', 'review', 'cr']);
  assert.deepEqual(panelTabIds({}), ['ai', 'review']);
});

test('검토 탭 거르기: 간단히 = 전체·메모·AI·완료(AI 에 내 남은 제안 카드 포함) · 자세히 = 여섯 개(종류 그대로)', () => {
  assert.deepEqual(REVIEW_FILTERS.map((f) => f.label), ['전체', '메모', 'AI', '제안', '수정 중', '완료']);
  assert.deepEqual(reviewFilterIds('simple'), ['all', 'memo', 'ai', 'resolved']);
  assert.deepEqual(reviewFilterIds('detail'), ['all', 'memo', 'ai', 'proposal', 'draft', 'resolved']);
  const memo = { cat: 'memo' }; const ai = { cat: 'ai' }; const prop = { cat: 'proposal' }; const draft = { cat: 'draft' }; const done = { cat: 'memo', resolved: true };
  assert.deepEqual([memo, ai, prop, draft, done].map((x) => filterPass(x, 'all', 'simple')), [true, true, true, true, false]);
  assert.deepEqual([memo, ai, prop, draft, done].map((x) => filterPass(x, 'ai', 'simple')), [false, true, true, false, false]);
  assert.deepEqual([memo, ai, prop, draft, done].map((x) => filterPass(x, 'ai', 'detail')), [false, true, false, false, false]);
  assert.deepEqual([memo, ai, prop, draft, done].map((x) => filterPass(x, 'resolved', 'simple')), [false, false, false, false, true]);
  assert.deepEqual([memo, ai, prop, draft, done].map((x) => filterPass(x, 'proposal', 'detail')), [false, false, true, false, false]);
  assert.equal(collapseDrafts('simple'), true);
  assert.equal(collapseDrafts('detail'), false);
});

test('AI 작업 한 줄 요약: 머리 「AI 작업 #2 · 홍길동」(상태 없음) · 상태 칩 하나(대기열·전달됨·처리 중·확인 필요·완료·실패·취소됨 — 끝난 것은 서버 outcome), 수는 title', () => {
  assert.equal(summaryHead({ rid: 2, by: '홍길동', status: 'done' }), 'AI 작업 #2 · 홍길동');
  assert.equal(summaryHead({ rid: 5, by: '김검토', status: 'working' }), 'AI 작업 #5 · 김검토');
  assert.equal(summaryHead({ rid: 6 }), 'AI 작업 #6');
  assert.deepEqual(summaryChip({ rid: 2, status: 'done', outcome: { accepted: 14, open: 2, resolved: false } }), { text: '확인 필요', cls: 'ph-hold', title: '반영 14건 · 남은 제안 2건' });
  assert.deepEqual(summaryChip({ rid: 2, status: 'done', outcome: { accepted: 14, open: 0, resolved: true } }), { text: '완료', cls: 'ph-ok', title: '반영 14건' });
  assert.deepEqual(summaryChip({ rid: 2, status: 'done', outcome: { accepted: 0, resolved: true } }), { text: '완료', cls: 'ph-ok', title: '' });
  assert.deepEqual(summaryChip({ rid: 2, status: 'done', outcome: { accepted: 0, open: 3, resolved: false } }), { text: '확인 필요', cls: 'ph-hold', title: '남은 제안 3건' });
  // 서버 outcome 이 없으면(옛 서버) 내 눈의 진행
  assert.deepEqual(summaryChip({ rid: 2, status: 'done' }, { accepted: 3, open: 0, resolved: true }), { text: '완료', cls: 'ph-ok', title: '반영 3건' });
  // 끝나지 않은 요청: 상태 이름만(requestBadge 와 같은 이름)
  assert.equal(summaryChip({ rid: 2, status: 'pending' }).text, '대기열');
  assert.equal(summaryChip({ rid: 2, status: 'pending', delivery: { agent: 'Codex' } }).text, '전달됨');
  assert.equal(summaryChip({ rid: 2, status: 'working' }).text, '처리 중');
  assert.deepEqual(summaryChip({ rid: 2, status: 'failed', error: '시간 초과' }), { text: '실패', cls: 'ph-fail', title: '시간 초과' });
  assert.equal(summaryChip({ rid: 2, status: 'cancelled' }).text, '취소됨');
  assert.equal(summaryChip(null), null);
});

test('이력 묶음: 같은 사람의 이어진 실시간 편집(서로 5분 안)은 한 줄 · 다른 사람·5분 넘는 틈·다른 기록·이정표에서 끊김 · 하나뿐이면 그냥 줄', () => {
  const at = (hh, mm, ss = 0) => new Date(2026, 9, 23, hh, mm, ss).toISOString();
  const L = (n, by, t) => ({ n, by, at: t, note: LIVE_NOTE });
  // 이력 탭은 새것부터
  const recs = [
    L(12, '홍길동', at(10, 15)), L(11, '홍길동', at(10, 11)), L(10, '홍길동', at(10, 7)), L(9, '홍길동', at(10, 2)),   // 4개(틈 ≤ 5분) — 10:02~10:15
    L(8, '김검토', at(10, 1)),                                                                                    // 다른 사람 하나 → 그냥 줄
    { n: 7, by: '관리자', at: at(10, 0), note: '메모 추가' },
    L(6, '홍길동', at(9, 50)), L(5, '홍길동', at(9, 44)),                                                         // 6분 틈 → 끊김(둘 다 그냥 줄)
    { n: 4, by: '홍길동', at: at(9, 40), note: LIVE_NOTE, v: 2 },                                               // 이정표가 된 기록은 묶지 않는다
    L(3, '홍길동', at(9, 39)), L(2, '홍길동', at(9, 38, 30)),
  ];
  const rows = groupHistory(recs);
  assert.deepEqual(rows.map((r) => (r.kind === 'live' ? `live:${r.recs.map((x) => x.n).join(',')}` : `rec:${r.rec.n}`)),
    ['live:12,11,10,9', 'rec:8', 'rec:7', 'rec:6', 'rec:5', 'rec:4', 'live:3,2']);
  const g = rows[0];
  assert.equal(g.by, '홍길동');
  assert.equal(g.count, 4);
  assert.equal(liveGroupLabel(g), '홍길동 · 실시간 편집 4번 · 10:02~10:15');
  assert.equal(groupHistory([]).length, 0);
  assert.equal(groupHistory(null).length, 0);
  // 날이 다르면 날짜도
  const cross = groupHistory([L(2, '홍길동', new Date(2026, 9, 23, 0, 1).toISOString()), L(1, '홍길동', new Date(2026, 9, 22, 23, 58).toISOString())]);
  assert.equal(liveGroupLabel(cross[0]), '홍길동 · 실시간 편집 2번 · 10-22 23:58~10-23 00:01');
  // 틈 기준을 바꿀 수 있다
  assert.equal(groupHistory(recs.slice(0, 4), { gapMs: 60 * 1000 }).length, 4);
});

test('상단 칩(실시간): 실시간 · 저장됨 HH:MM / 보내는 중… / 보내지 못함 — [다시] / 읽기 전용(설명 그대로) · Ctrl+Z 설명', () => {
  assert.deepEqual(liveChip({ ready: false }), { text: '편집기 준비 중…', cls: 'idle', tip: '' });
  const ro = liveChip({ ready: true, readOnly: true, error: 'x', dirty: true });
  assert.equal(ro.text, '읽기 전용');
  assert.equal(ro.tip, READONLY_TIP);
  assert.equal(READONLY_TIP, '이 문서의 수정 권한이 없습니다(문서 설정). 메모·AI 요청은 됩니다');
  const err = liveChip({ ready: true, error: '네트워크 오류', dirty: true });
  assert.equal(err.text, '보내지 못함 —');
  assert.equal(err.retry, true);
  assert.match(err.tip, /5·10·15초/);
  assert.equal(liveChip({ ready: true, pushing: true }).text, '보내는 중…');
  assert.equal(liveChip({ ready: true, dirty: true }).text, '보내는 중…');
  // 큰 밀어 넣기의 서버 진행(2026-11-03) — 보내는 동안만
  assert.equal(liveChip({ ready: true, pushing: true, progress: { done: 120, total: 583 } }).text, '반영 중 120/583');
  assert.equal(liveChip({ ready: true, dirty: true, progress: { done: 120, total: 583 } }).text, '보내는 중…');
  const ok = liveChip({ ready: true, savedAt: '10:31' });
  assert.equal(ok.text, '실시간 · 저장됨 10:31');
  assert.match(ok.tip, /Ctrl\+Z/);
  assert.equal(liveChip({ ready: true }).text, '실시간 · 저장됨');
});

test('한글로 저장 설명: 문서 설정 exportKind 그대로', () => {
  assert.equal(exportTip({ exportKind: 'final' }), '보이는 그대로 + 메모 (문서 설정에서 바꿈)');
  assert.equal(exportTip({ exportKind: 'tracked' }), '변경 추적 포함 + 메모 (문서 설정에서 바꿈)');
  assert.equal(exportTip(null), '보이는 그대로 + 메모 (문서 설정에서 바꿈)');
});

test('⚙ 문서 설정 창 모델: 일곱 줄 · 창 값 ↔ 설정 · 바뀐 키만 보냄 · 사람 목록(관리자는 언제나·viewer 못 고름·목록에 없는 이름) · 승인→실시간 경고', () => {
  assert.deepEqual(SETTING_FIELDS.map((f) => [f.key, f.label]), [['editMode', '편집 반영 방식'], ['editors', '편집 가능한 사람'], ['track', '실시간 편집 기록'], ['exportKind', '파일에 담을 내용'], ['aiMemo', 'AI 작업 메모'], ['aiQuick', '빠른 AI 요청'], ['aiApply', 'AI 제안 반영']]);
  assert.deepEqual(SETTING_FIELDS.find((x) => x.key === 'aiQuick').options, [['send', '바로 보내기'], ['compose', '확인 후 보내기']]);
  assert.deepEqual(SETTING_FIELDS[0].options, [['realtime', '실시간'], ['review', '승인 후 반영']]);
  // 값은 서버 설정 값 그대로(SETTING_VALUES — editors 는 all|some), 선택지마다 설명(title)이 있다
  for (const f of SETTING_FIELDS) {
    const vals = f.options.map(([v]) => v);
    assert.deepEqual(vals, f.key === 'editors' ? ['all', 'some'] : SETTING_VALUES[f.key], f.key);
    for (const [v, label] of f.options) { assert.ok(label.length <= 10, `${f.key}:${v} 이름표 짧게 「${label}」`); assert.ok(f.tips?.[v], `${f.key}:${v} 설명`); }
  }
  const st = { editMode: 'review', editors: 'all', track: 'final', exportKind: 'final', aiMemo: 'summary', aiQuick: 'send' };
  const f = settingsForm(st);
  assert.deepEqual(f, { editMode: 'review', editorsMode: 'all', editors: [], track: 'final', exportKind: 'final', aiMemo: 'summary', aiQuick: 'send', aiApply: 'manual' });
  assert.deepEqual(settingsPatch({ ...f, aiApply: 'auto' }, st), { aiApply: 'auto' });
  assert.equal(normSettings({ aiApply: 'invalid' }).aiApply, 'manual');
  assert.equal(settingsForm({ aiApply: 'auto' }).aiApply, 'auto');
  assert.deepEqual(settingsPatch(f, st), {});
  assert.deepEqual(settingsPatch({ ...f, editMode: 'realtime', aiMemo: 'detail' }, st), { editMode: 'realtime', aiMemo: 'detail' });
  assert.deepEqual(settingsPatch({ ...f, aiMemo: 'none' }, st), { aiMemo: 'none' });
  assert.deepEqual(settingsPatch({ ...f, aiQuick: 'compose' }, st), { aiQuick: 'compose' });
  assert.deepEqual(settingsPatch({ ...settingsForm({ ...st, aiQuick: 'compose' }), aiQuick: 'send' }, { ...st, aiQuick: 'compose' }), { aiQuick: 'send' });
  assert.deepEqual(settingsPatch({ ...f, aiQuick: 'maybe' }, st), {});
  assert.equal(settingsForm({ editMode: 'review' }).aiQuick, 'send');   // 옛 문서(설정에 aiQuick 없음) → 바로 보내기
  assert.equal(settingsForm({ ...st, aiMemo: 'none' }).aiMemo, 'none');
  assert.ok(SETTING_FIELDS.find((x) => x.key === 'aiMemo').options.some(([v]) => v === 'none'));
  assert.deepEqual(settingsPatch({ ...f, editorsMode: 'some', editors: ['홍길동', '홍길동', '이열람'] }, st), { editors: ['홍길동', '이열람'] });
  assert.deepEqual(settingsPatch({ ...settingsForm({ ...st, editors: ['홍길동'] }), editorsMode: 'all' }, { ...st, editors: ['홍길동'] }), { editors: 'all' });
  assert.deepEqual(settingsPatch({ ...f, track: 'nope' }, st), {});   // 모르는 값은 보내지 않는다
  const users = [{ name: '관리자', role: 'admin' }, { name: '홍길동', role: 'editor' }, { name: '김검토' }, { name: '열람', role: 'viewer' }];
  const some = { editorsMode: 'some', editors: ['홍길동', '옛사람'] };
  assert.deepEqual(editorChoices(users, some).map((u) => [u.name, u.checked, u.disabled, u.note]), [
    ['관리자', true, true, '관리자는 언제나'], ['홍길동', true, false, ''], ['김검토', false, false, ''], ['열람', false, true, '읽기 전용 역할'], ['옛사람', true, false, '사용자 목록에 없음'],
  ]);
  // 편집자 모두: 편집자는 모두 체크(꺼짐)
  assert.deepEqual(editorChoices(users, { editorsMode: 'all', editors: [] }).map((u) => [u.name, u.checked, u.disabled]), [['관리자', true, true], ['홍길동', true, true], ['김검토', true, true], ['열람', false, true]]);
  assert.equal(settingsWarning(st, { ...f, editMode: 'realtime' }, 2), '진행 중 변경 요청 2건을 먼저 반영하거나 닫으세요');
  assert.equal(settingsWarning(st, { ...f, editMode: 'realtime' }, 0), '');
  assert.equal(settingsWarning({ ...st, editMode: 'realtime' }, { ...f, editMode: 'realtime' }, 2), '');
  assert.equal(settingsWarning(st, f, 2), '');
});
