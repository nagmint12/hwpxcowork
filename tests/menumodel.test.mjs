// web/menumodel.js 시험: 우클릭 메뉴 모델(동작 서술)·검토 보기 어댑터가 v0.2 원본(web/ui.js 의 menuItems)과 같은지,
// groupChanges 짝짓기, agentPrompt 글. DOM·Vue 없이 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { menuModel, menuItems, menuRunner, toMenuItems, groupChanges, changeGroupLabel, changeText, visibleChanges, agentPrompt, MENU_ACTIONS, DEFAULT_PRESETS, DEFAULT_KINDS, reviewMenuModel, REVIEW_MENU_ACTIONS, quickTasks, quickPrompt } from '../web/menumodel.js';
import { buildAnnotations } from '../web/annotations.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIX = `${root}/tests/fixtures/tool_memo_tracked.hwpx`;
// 엔진은 실제 문서를 쓰는 시험에서만 읽는다(메뉴 모델 시험이 엔진 상태에 묶이지 않게)
const loadDoc = async (file) => (await import('../engine/doc.js')).HwpxDoc.load(fs.readFileSync(file));

// util.js(브라우저 전용 — Vue import)의 기본 목록을 글에서 읽어 둔다: menumodel 의 사본과 어긋나지 않게
const utilSrc = fs.readFileSync(`${root}/web/util.js`, 'utf8');
const literal = (name) => Function(`return ${new RegExp(`export const ${name} = (\\[[\\s\\S]*?\\]);`).exec(utilSrc)[1]}`)();
const UTIL_PRESETS = literal('DEFAULT_PRESETS'); const UTIL_KINDS = literal('DEFAULT_KINDS');

// ───────── v0.2 원본(backups/v0.2.0_2026-10-22/web/ui.js 의 agentPrompt·menuItems·bodyOf·groupChanges 를 그대로 옮김) ─────────
// util.js 도우미는 env 로 받는다: presets(), kindLabel(), toastError, copyText, toast. markRaw 는 그대로 돌려준다.
function v2(env) {
  const { presets, kindLabel, toastError, copyText, toast } = env; const markRaw = (x) => x;
  const clip = (s, n = 40) => { const a = Array.from(String(s ?? '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  /** 내 AI 에이전트(MCP)에게 붙여 넣을 문장 */
  function agentPrompt(d, r) {
    const title = d.s.info?.title || d.id;
    return `hwpx-cowork 문서 「${title}」(doc_id: ${d.id})의 AI 작업 #${r.rid}(${r.label || kindLabel(r.kind)})을 처리해 줘.\n`
      + `순서: get_request(doc_id="${d.id}", request_id=${r.rid}) → start_request → 필요하면 read_attachment → propose_alternatives / propose_changes / propose_insert / propose_table / add_memo(request_id=${r.rid}) → complete_request(summary=공유용 1~2문장 요약, 지시 원문·개인정보 인용 금지).`;
  }
  function menuItems(d, c) {
    const items = []; const t = c.target; const a = c.anchor; const whole = !c.hasSelection;
    const hint = whole ? '문단 전체' : '';
    for (const p of c.proposals || []) {
      items.push({ header: `제안 #${p.pid}${p.option ? ` · 안 ${p.option}` : ''} · ${p.by || ''}` });
      if (p.status === 'pending') { items.push({ icon: 'check', label: '제안 적용', run: () => d.applyProposal(p).catch(toastError) }, { icon: 'x', label: '거절', run: () => d.rejectProposal(p).catch(toastError) }); }
      else if (p.status === 'applied') items.push({ icon: 'undo', label: '복구(적용 취소)', run: () => d.undoProposal(p).catch(toastError) });
      else if (p.status === 'rejected' || p.status === 'undone') items.push({ icon: 'reopen', label: '다시 열기', run: () => d.reopenProposal(p).catch(toastError) });
    }
    for (const g of groupChanges(c.changes || [])) {
      const kind = g.length > 1 ? '교체' : g[0].type === 'Insert' ? '삽입' : '삭제';
      items.push({ header: `변경 ${g.map((x) => `#${x.id}`).join('·')} ${kind} · ${g[0].author}` });
      items.push({ icon: 'check', label: '변경 적용(수락)', run: () => d.resolveChange(g, 'accept').catch(toastError) }, { icon: 'undo', label: '변경 복구(거절)', run: () => d.resolveChange(g, 'reject').catch(toastError) });
    }
    const shownPids = new Set((c.proposals || []).map((p) => p.pid));
    for (const m of (c.memos || []).filter((x) => !(x.link?.type === 'proposal' && shownPids.has(x.link.pid)))) {
      const what = m.link?.type === 'request' ? `AI 작업 #${m.link.rid}` : m.link?.type === 'comment' ? `AI 의견 #${m.link.rid}` : `「${clip(m.text, 14)}」`;
      items.push({ header: `메모 · ${clip(m.author, 12)} · ${what}` });
      items.push({ icon: 'edit', label: m.editable ? '메모 보기/고치기' : '메모 보기', run: () => { d.s.activeMemo = m.id; d.s.editingMemo = m.editable ? m.id : null; } });
      if (m.editable) items.push({ icon: 'trash', label: '메모 삭제', danger: true, run: () => d.deleteMemo(m).catch(toastError) });
    }
    if (items.length) items.push({ sep: true });
    if (t) {
      items.push(
        // (v0.4 이후: 검토·문장 제안·다듬기는 빠른 작업 quick: true — 문서 설정 aiQuick 'send' 면 store 가 창을 연 채 바로 보낸다)
        { icon: 'review', label: 'AI에게 검토 맡기기', hint, run: () => d.openComposer(t, 'review', { anchor: a, quick: true }) },
        { icon: 'suggest', label: '문장 제안 받기(3안)', hint, run: () => d.openComposer(t, 'suggest', { anchor: a, quick: true }) },
        { icon: 'polish', label: '다듬기', sub: presets().map((p) => ({ label: p.label, run: () => d.openComposer(t, 'polish', { preset: p.id, anchor: a, quick: true }) })) },
        { icon: 'instruct', label: '지시해서 요청…', run: () => d.openComposer(t, 'instruct', { anchor: a }) },
        { icon: 'attach', label: '파일 첨부해서 요청…', run: () => d.openComposer(t, 'instruct', { anchor: a, pickFile: true }) },
      );
      const body = d.targetForParagraph(bodyOf(t.ref));
      const extra = [];
      if (c.cell) extra.push({ icon: 'fill', label: '표 채우기(첨부 자료로)…', run: () => d.openComposer(t, 'fill_table', { anchor: a, pickFile: !d.s.attachments.length }) });
      extra.push({ icon: 'para', label: '이 문단 뒤에 문단 추가 요청…', run: () => d.openComposer(body, 'insert', { anchor: a }) });
      extra.push({ icon: 'table', label: '이 문단 뒤에 표 만들기(첨부 자료로)…', run: () => d.openComposer(body, 'make_table', { anchor: a, pickFile: !d.s.attachments.length }) });
      items.push({ sep: true }, ...extra, { sep: true },
        { icon: 'memo', label: '메모 달기', run: () => d.openPopover('memo', t, a) },
        { icon: 'edit', label: '직접 고쳐 쓰기(변경 추적)', disabled: !t.text && !whole, run: () => d.openPopover('rewrite', t, a) },
        { icon: 'copy', label: '복사', hint: 'Ctrl+C', disabled: !(t.display || t.text), run: () => copyText(t.display || t.text).then(() => toast('복사했습니다')) });
    }
    return markRaw(items);
  }
  const bodyOf = (ref_) => (/^(s\d+\/p\d+)/.exec(ref_ || '') || [])[1] || ref_;
  /** 교체(같은 자리의 삭제 + 삽입, 같은 작성자)는 한 묶음으로: 하나만 거절하면 글이 지워진 채 남는다 */
  function groupChanges(list) {
    const out = []; const used = new Set();
    for (const ins of list.filter((x) => x.type === 'Insert')) {
      const del = list.find((x) => x.type === 'Delete' && !used.has(x.id) && x.ref === ins.ref && x.author === ins.author && (x.start === ins.start || x.start === ins.end));
      if (del) { used.add(del.id); used.add(ins.id); out.push([del, ins]); }
    }
    for (const x of list) if (!used.has(x.id)) out.push([x]);
    return out;
  }
  return { agentPrompt, menuItems, groupChanges };
}

// ───────── 시험 받침: store 흉내(호출 기록) ─────────
const kindLabelFor = (kinds) => (id) => (kinds?.length ? kinds : UTIL_KINDS).find((k) => k.id === id)?.label || id || '요청';
function mockStore({ attachments = [], memos = [], proposals = [], fail = false } = {}) {
  const log = [];
  const call = (name) => (...args) => { log.push([name, ...args]); return fail ? Promise.reject(new Error(`${name} 실패`)) : Promise.resolve({ ok: name }); };
  return {
    id: 'doc-1', log,
    s: { info: { title: '시험 문서' }, attachments, memos, proposals, activeMemo: null, editingMemo: null },
    targetForParagraph: (ref) => ({ ref, start: 0, end: 5, text: `«${ref}»`, refs: [ref], display: `«${ref}»`, whole: true }),
    proposal: (pid) => proposals.find((p) => p.pid === Number(pid)) || null,
    openComposer: (...args) => { log.push(['openComposer', ...args]); },
    openPopover: (...args) => { log.push(['openPopover', ...args]); },
    applyProposal: call('applyProposal'), rejectProposal: call('rejectProposal'), undoProposal: call('undoProposal'), reopenProposal: call('reopenProposal'),
    resolveChange: call('resolveChange'), deleteMemo: call('deleteMemo'),
  };
}
const helpers = (log) => ({
  toast: (msg) => log.push(['toast', msg]),
  toastError: (e) => log.push(['toastError', e?.message || String(e)]),
  copyText: (text) => { log.push(['copyText', text]); return Promise.resolve(true); },
});
const settle = () => new Promise((r) => setImmediate(r));
/** 함수(run)를 뺀 모양 — v0.2 와 키까지 비교 */
const strip = (items) => items.map((it) => { const o = { ...it }; if (o.label === '문장 제안 받기(3안)') o.label = '문장 제안 받기'; if ('run' in o) o.run = typeof o.run; if (o.sub) o.sub = strip(o.sub); return o; });
/** 화면에 보이는 줄: 구분선 —, 머리글 #, 하위 메뉴 ▸ */
const lines = (items) => items.map((it) => (it.sep ? '—' : it.header != null ? `# ${it.header}` : `${it.label}${it.sub ? ' ▸' : ''}`));
/** ContextMenu 의 키보드 고르기 순서(구분선·머리글·꺼진 항목 건너뜀) */
const selectable = (items) => items.filter((it) => !it.sep && it.header == null && !it.disabled);

// ───────── 시험 자료 ─────────
const T = (text, display = text, ref = 's0/p2') => ({ ref, start: 4, end: 4 + Array.from(text).length, text, refs: [ref], display });
const CELL = { ref: 's0/p3/n8', start: 0, end: 3, text: '268', refs: ['s0/p3/n8'], display: '268', whole: true, tableKey: 's0/p3#t0' };
const ANCHOR = { x: 100, y: 206, top: 200, avoid: { left: 90, right: 300, top: 190, bottom: 220 } };
const PROPS = [
  { pid: 7, status: 'pending', option: 2, by: '홍길동(Claude)', ref: 's0/p2' },
  { pid: 8, status: 'applied', by: '모의 AI', ref: 's0/p2' },
  { pid: 9, status: 'rejected', ref: 's0/p2' },
  { pid: 10, status: 'undone', by: '김검토', ref: 's0/p2' },
  { pid: 11, status: 'superseded', by: '김검토', ref: 's0/p2' },
];
const CHANGES = [
  { id: 3, type: 'Insert', ref: 's0/p2', author: 'AI 검토자', start: 7, end: 15 },
  { id: 4, type: 'Delete', ref: 's0/p2', author: 'AI 검토자', start: 7, end: 7 },
  { id: 5, type: 'Insert', ref: 's0/p2', author: 'Nag', start: 20, end: 25 },
];
const MEMOS = [
  { id: 'memo1', author: '관리자', text: '수치 근거를 확인해 주세요. 2025년 기준인지?', link: null, editable: true },
  { id: 'memo2', author: '아주아주긴이름을가진검토자님', text: '요청 메모', link: { type: 'request', rid: 3 }, editable: false },
  { id: 'memo3', author: '모의 AI', text: '의견', link: { type: 'comment', rid: 3 }, editable: true },
  { id: 'memo4', author: '모의 AI', text: '[제안 #7] 보이는 제안의 메모', link: { type: 'proposal', pid: 7 }, editable: true },
  { id: 'memo5', author: '모의 AI', text: '[제안 #12] 다른 제안의 메모', link: { type: 'proposal', pid: 12 }, editable: false },
];
const CUSTOM_PRESETS = [{ id: 'short', label: '짧게' }, { id: 'kind', label: '친절하게' }];

/** 메뉴를 여는 자리들(검토 보기·본문 탭·말풍선 우클릭이 넘기는 모양) */
const CONTEXTS = {
  '선택 안(ui_review [3])': { target: T('연도별 응답자 수'), hasSelection: true, cell: false, memos: [], changes: [], proposals: [], anchor: ANCHOR },
  '문단 전체(본문 탭 — 덮는 목록 없음)': { target: T('가. 연도별 응답자 수 및 구성비'), hasSelection: false, cell: false, anchor: ANCHOR },
  '표 칸': { target: CELL, hasSelection: false, cell: true, memos: [], changes: [], proposals: [], anchor: ANCHOR },
  '빈 선택 글': { target: T(''), hasSelection: true, cell: false, anchor: ANCHOR },
  '보이는 글만 있는 선택': { target: T('', '여러 문단 선택'), hasSelection: true, cell: false, anchor: ANCHOR },
  '빈 문단 전체': { target: T('', ''), hasSelection: false, cell: false, anchor: ANCHOR },
  '제안·변경·메모를 덮는 자리': { target: T('abc'), hasSelection: true, cell: true, memos: MEMOS, changes: CHANGES, proposals: PROPS, anchor: ANCHOR },
  '말풍선 우클릭(대상 없음)': { memos: [MEMOS[0]], anchor: { x: 10, y: 20 } },
  '제안만(대상 없음)': { proposals: PROPS.slice(0, 2), anchor: ANCHOR },
  '변경만(대상 없음)': { changes: CHANGES, anchor: ANCHOR },
  '아무것도 없음': {},
};
const VARIANTS = [
  { name: '기본 다듬기·첨부 없음', presets: UTIL_PRESETS, attachments: [] },
  { name: '설정 다듬기·첨부 있음', presets: CUSTOM_PRESETS, attachments: [{ aid: 'a1', name: '응답률.csv' }] },
];

/** v0.2 원본과 새 어댑터를 같은 자리에서 만든다(각자 store 흉내) */
function both(c, variant, { fail = false } = {}) {
  const dA = mockStore({ attachments: variant.attachments, memos: MEMOS, proposals: PROPS, fail });
  const dB = mockStore({ attachments: variant.attachments, memos: MEMOS, proposals: PROPS, fail });
  const old = v2({ presets: () => variant.presets, kindLabel: kindLabelFor(null), ...helpers(dA.log) }).menuItems(dA, c);
  const now = menuItems(dB, c, { presets: variant.presets, ...helpers(dB.log) });
  return { dA, dB, old, now };
}
/** 누를 수 있는 항목의 자리 [i] 또는 [i, j](하위 메뉴) */
function runPaths(items) {
  const out = [];
  items.forEach((it, i) => { if (it.run) out.push([i]); if (it.sub) it.sub.forEach((s, j) => { if (s.run) out.push([i, j]); }); });
  return out;
}
const at = (items, p) => (p.length === 1 ? items[p[0]] : items[p[0]].sub[p[1]]);

// ───────── 시험 ─────────

test('기본 다듬기·종류 목록이 util.js 와 같다', () => {
  assert.deepEqual(DEFAULT_PRESETS, UTIL_PRESETS);
  assert.deepEqual(DEFAULT_KINDS, UTIL_KINDS);
});

test('선택 안 우클릭: v0.2 의 항목·순서·아이콘·힌트(ui_review [3] 의 10개 항목 + ↓↓↓ → 다듬기 하위 메뉴)', () => {
  const d = mockStore();
  const items = menuItems(d, CONTEXTS['선택 안(ui_review [3])'], { presets: UTIL_PRESETS, ...helpers(d.log) });
  assert.deepEqual(lines(items), [
    'AI에게 검토 맡기기', '문장 제안 받기', '다듬기 ▸', '지시해서 요청…', '파일 첨부해서 요청…', '—',
    '이 문단 뒤에 문단 추가 요청…', '이 문단 뒤에 표 만들기(첨부 자료로)…', '—',
    '메모 달기', '직접 고쳐 쓰기(변경 추적)', '복사',
  ]);
  assert.deepEqual(items.filter((it) => !it.sep).map((it) => it.icon), ['review', 'suggest', 'polish', 'instruct', 'attach', 'para', 'table', 'memo', 'edit', 'copy']);
  assert.equal(items[0].hint, ''); assert.equal(items[1].hint, ''); assert.equal(items[11].hint, 'Ctrl+C');
  assert.equal(items[10].disabled, false); assert.equal(items[11].disabled, false);
  // ui_review.py 가 찾는 10개 항목
  for (const want of ['AI에게 검토 맡기기', '문장 제안 받기', '다듬기', '지시해서 요청…', '파일 첨부해서 요청…', '메모 달기', '직접 고쳐 쓰기(변경 추적)', '복사', '이 문단 뒤에 문단 추가 요청…', '이 문단 뒤에 표 만들기(첨부 자료로)…']) {
    assert.ok(items.some((it) => it.label === want), want);
  }
  // ContextMenu: 처음 ↓ 는 첫 항목, ↓↓↓ 은 셋째 = 다듬기, → 로 하위 메뉴
  const third = selectable(items)[2];
  assert.equal(third.label, '다듬기'); assert.ok(Array.isArray(third.sub));
  assert.deepEqual(third.sub.map((s) => s.label), ['간결하게', '공문서체로', '맞춤법·띄어쓰기', '쉽게 풀어쓰기', '수치·사실 확인']);
});

test('문단 전체: 검토·문장 제안에 힌트 「문단 전체」, 빈 문단은 복사만 꺼짐', () => {
  const m1 = menuModel({ target: T('가나다'), hasSelection: false });
  assert.equal(m1.find((e) => e.id === 'review').hint, '문단 전체');
  assert.equal(m1.find((e) => e.id === 'suggest').hint, '문단 전체');
  const m2 = menuModel({ target: T('', ''), hasSelection: false });
  assert.equal(m2.find((e) => e.id === 'rewrite').disabled, false, '문단 전체면 빈 글도 고쳐 쓰기 가능');
  assert.equal(m2.find((e) => e.id === 'copy').disabled, true);
  const m3 = menuModel({ target: T('', '여러 문단'), hasSelection: true });
  assert.equal(m3.find((e) => e.id === 'rewrite').disabled, true, '선택인데 첫 문단 글이 없으면 고쳐 쓰기 꺼짐');
  assert.equal(m3.find((e) => e.id === 'copy').disabled, false, '보이는 글이 있으면 복사');
});

test('표 칸: 표 채우기가 추가 묶음 맨 앞, 첨부가 없으면 파일 고르기부터', () => {
  const none = menuModel({ target: CELL, cell: true, attachmentsCount: 0 });
  const some = menuModel({ target: CELL, cell: true, attachmentsCount: 2 });
  const i = none.findIndex((e) => e.id === 'fill_table');
  assert.ok(i > 0 && none[i - 1].kind === 'sep' && none[i + 1].id === 'insert' && none[i + 2].id === 'make_table');
  assert.deepEqual(none[i].action, { type: 'fill_table', pickFile: true });
  assert.deepEqual(none.find((e) => e.id === 'make_table').action, { type: 'make_table', pickFile: true });
  assert.deepEqual(some.find((e) => e.id === 'fill_table').action, { type: 'fill_table', pickFile: false });
  assert.deepEqual(some.find((e) => e.id === 'make_table').action, { type: 'make_table', pickFile: false });
  assert.equal(menuModel({ target: CELL, cell: false }).some((e) => e.id === 'fill_table'), false);
});

test('덮는 제안·변경·메모: 머리글과 동작(v0.2 글)', () => {
  const model = menuModel({ target: T('abc'), hasSelection: true, memos: MEMOS, changes: CHANGES, proposals: PROPS });
  const head = model.filter((e) => e.kind === 'header').map((e) => e.label);
  assert.deepEqual(head, [
    '제안 #7 · 안 2 · 홍길동(Claude)', '제안 #8 · 모의 AI', '제안 #9 · ', '제안 #10 · 김검토', '제안 #11 · 김검토',
    '변경 #4·#3 교체 · AI 검토자', '변경 #5 삽입 · Nag',
    '메모 · 관리자 · 「수치 근거를 확인해 주세요…」', '메모 · 아주아주긴이름을가진검토… · AI 작업 #3', '메모 · 모의 AI · AI 의견 #3', '메모 · 모의 AI · 「[제안 #12] 다른 제안…」',
  ]);
  const acts = model.filter((e) => e.kind === 'item').map((e) => e.action);
  assert.deepEqual(acts.slice(0, 15), [
    { type: 'proposal-apply', pid: 7 }, { type: 'proposal-reject', pid: 7 }, { type: 'proposal-undo', pid: 8 }, { type: 'proposal-reopen', pid: 9 }, { type: 'proposal-reopen', pid: 10 },
    { type: 'change-accept', ids: [4, 3] }, { type: 'change-reject', ids: [4, 3] }, { type: 'change-accept', ids: [5] }, { type: 'change-reject', ids: [5] },
    { type: 'memo-edit', id: 'memo1' }, { type: 'memo-delete', id: 'memo1' }, { type: 'memo-show', id: 'memo2' }, { type: 'memo-edit', id: 'memo3' },
    { type: 'memo-delete', id: 'memo3' }, { type: 'memo-show', id: 'memo5' },
  ]);
  assert.deepEqual(acts.slice(15).map((a) => a.type), ['review', 'suggest', 'instruct', 'attach', 'insert', 'make_table', 'memo', 'rewrite', 'copy']);
  const del = model.find((e) => e.id === 'memo-delete:memo1');
  assert.equal(del.danger, true); assert.equal(del.icon, 'trash'); assert.equal(del.label, '메모 삭제');
  assert.equal(model.find((e) => e.id === 'memo-show:memo2').label, '메모 보기');
  assert.equal(model.find((e) => e.id === 'memo-edit:memo3').label, '메모 보기/고치기');
  assert.ok(!model.some((e) => e.id === 'memo:memo4'), '보이는 제안(#7)의 메모는 숨김');
  // 덮는 것 다음에 구분선, 그다음 기본 항목
  const first = model.findIndex((e) => e.id === 'review');
  assert.equal(model[first - 1].kind, 'sep');
});

test('대상 없음(말풍선 우클릭): 메모 묶음 + 구분선만, 빈 ctx 는 빈 목록', () => {
  assert.deepEqual(lines(toMenuItems(menuModel({ memos: [MEMOS[0]] }), () => () => {})), ['# 메모 · 관리자 · 「수치 근거를 확인해 주세요…」', '메모 보기/고치기', '메모 삭제', '—']);
  assert.deepEqual(menuModel({}), []);
  assert.deepEqual(menuModel(), []);
});

test('다듬기 하위 메뉴: 설정 목록 그대로, 비면 기본', () => {
  const sub = (presets) => menuModel({ target: T('가'), presets }).find((e) => e.id === 'polish');
  assert.equal(sub(CUSTOM_PRESETS).kind, 'sub');
  assert.deepEqual(sub(CUSTOM_PRESETS).sub.map((s) => [s.id, s.label, s.action]), [['polish:short', '짧게', { type: 'polish', preset: 'short' }], ['polish:kind', '친절하게', { type: 'polish', preset: 'kind' }]]);
  assert.deepEqual(sub([]).sub.map((s) => s.action.preset), DEFAULT_PRESETS.map((p) => p.id));
  assert.deepEqual(sub(undefined).sub.map((s) => s.label), DEFAULT_PRESETS.map((p) => p.label));
});

test('모델은 JSON 그대로(함수·undefined 없음), id 는 유일, 동작은 MENU_ACTIONS 안', () => {
  const seenTypes = new Set();
  for (const [name, c] of Object.entries(CONTEXTS)) {
    for (const presets of [UTIL_PRESETS, CUSTOM_PRESETS]) {
      const model = menuModel({ ...c, presets, attachmentsCount: 1 });
      assert.deepEqual(JSON.parse(JSON.stringify(model)), model, name);
      const all = model.flatMap((e) => [e, ...(e.sub || [])]);
      for (const list of [model, ...model.filter((e) => e.sub).map((e) => e.sub)]) assert.equal(new Set(list.map((e) => e.id)).size, list.length, `${name}: id 유일`);
      for (const e of all) {
        assert.ok(['header', 'item', 'sep', 'sub'].includes(e.kind), e.kind);
        if (e.kind === 'item') { assert.ok(MENU_ACTIONS.includes(e.action.type), e.action.type); seenTypes.add(e.action.type); } else assert.equal(e.action, undefined);
        if (e.kind === 'sub') assert.ok(e.sub.length > 0);
      }
    }
  }
  assert.deepEqual([...seenTypes].sort(), [...MENU_ACTIONS].sort(), '모든 동작 종류가 한 번 이상 나온다');
  // 같은 제안을 두 번 넘겨도 id 는 유일
  const dup = menuModel({ proposals: [PROPS[0], PROPS[0]] });
  assert.equal(new Set(dup.map((e) => e.id)).size, dup.length);
});

test('검토 보기 어댑터 = v0.2 원본: 항목 모양(글·순서·아이콘·힌트·꺼짐·위험·하위 메뉴·키)', () => {
  let n = 0;
  for (const variant of VARIANTS) {
    for (const [name, c] of Object.entries(CONTEXTS)) {
      const { old, now } = both(c, variant);
      assert.deepEqual(strip(now), strip(old), `${variant.name} / ${name}`);
      n += old.length;
    }
  }
  assert.ok(n > 100, `비교한 항목 ${n}개`);
});

test('검토 보기 어댑터 = v0.2 원본: 누르면 같은 store 호출·상태 변화', async () => {
  let n = 0;
  for (const variant of VARIANTS) {
    for (const [name, c] of Object.entries(CONTEXTS)) {
      const probe = both(c, variant);
      for (const p of runPaths(probe.old)) {
        const { dA, dB, old, now } = both(c, variant); // 누를 때마다 새 store
        const ra = at(old, p).run(); const rb = at(now, p).run();
        assert.equal(typeof rb?.then, typeof ra?.then, `${name} ${p}: 돌려주는 것(Promise 여부)`);
        await settle();
        dA.log.push(['s', dA.s.activeMemo, dA.s.editingMemo]); dB.log.push(['s', dB.s.activeMemo, dB.s.editingMemo]);
        assert.deepEqual(dB.log, dA.log, `${variant.name} / ${name} / ${at(old, p).label}`);
        n++;
      }
    }
  }
  assert.ok(n > 60, `누른 항목 ${n}개`);
});

test('store 동작이 실패하면 v0.2 처럼 toastError', async () => {
  const c = CONTEXTS['제안·변경·메모를 덮는 자리'];
  const probe = both(c, VARIANTS[0], { fail: true });
  let n = 0;
  for (const p of runPaths(probe.old)) {
    const { dA, dB, old, now } = both(c, VARIANTS[0], { fail: true });
    at(old, p).run(); at(now, p).run(); await settle();
    assert.deepEqual(dB.log, dA.log, at(old, p).label);
    if (dA.log.some((x) => x[0] === 'toastError')) n++;
  }
  assert.equal(n, 11, '실패 알림: 제안 5(적용·거절·복구·다시 열기 둘) · 변경 4 · 메모 삭제 2');
});

test('menuRunner: 다른 곳(플러그인)에서 온 동작 서술도 store 의 객체로 찾아 실행', async () => {
  const d = mockStore({ memos: MEMOS, proposals: PROPS });
  const run = menuRunner(d, { target: T('가나다'), anchor: ANCHOR }, helpers(d.log));
  run({ type: 'proposal-apply', pid: 7 })();
  run({ type: 'proposal-reject', pid: 99 })();
  run({ type: 'change-accept', ids: [4, 3] })();
  run({ type: 'memo-delete', id: 'memo3' })();
  run({ type: 'memo-delete', id: 'memo-없음' })();
  run({ type: 'polish', preset: 'formal' })();
  run({ type: 'insert' })();
  run({ type: 'review' })(); run({ type: 'suggest' })(); run({ type: 'instruct' })(); run({ type: 'attach' })();
  assert.equal(run({ type: '모르는 동작' })(), undefined);
  assert.equal(run(undefined)(), undefined);
  run({ type: 'memo-show', id: 'memo2' })();
  await settle();
  // 빠른 작업(검토·문장 제안·다듬기)만 quick — 지시·첨부·문단 추가는 창만 연다
  assert.deepEqual(d.log, [
    ['applyProposal', PROPS[0]],
    ['rejectProposal', 99],
    ['resolveChange', [4, 3], 'accept'],
    ['deleteMemo', MEMOS[2]],
    ['deleteMemo', { id: 'memo-없음' }],
    ['openComposer', T('가나다'), 'polish', { preset: 'formal', anchor: ANCHOR, quick: true }],
    ['openComposer', d.targetForParagraph('s0/p2'), 'insert', { anchor: ANCHOR }],
    ['openComposer', T('가나다'), 'review', { anchor: ANCHOR, quick: true }],
    ['openComposer', T('가나다'), 'suggest', { anchor: ANCHOR, quick: true }],
    ['openComposer', T('가나다'), 'instruct', { anchor: ANCHOR }],
    ['openComposer', T('가나다'), 'instruct', { anchor: ANCHOR, pickFile: true }],
  ]);
  assert.equal(d.s.activeMemo, 'memo2'); assert.equal(d.s.editingMemo, null);
  run({ type: 'memo-edit', id: 'memo1' })();
  assert.equal(d.s.activeMemo, 'memo1'); assert.equal(d.s.editingMemo, 'memo1');
});

test('표 칸에서 문단 추가·표 만들기는 표를 품은 본문 문단이 대상(v0.2)', async () => {
  const d = mockStore();
  const items = menuItems(d, { target: CELL, hasSelection: false, cell: true, anchor: ANCHOR }, helpers(d.log));
  items.find((it) => it.label === '이 문단 뒤에 문단 추가 요청…').run();
  items.find((it) => it.label === '이 문단 뒤에 표 만들기(첨부 자료로)…').run();
  items.find((it) => it.label === '표 채우기(첨부 자료로)…').run();
  assert.deepEqual(d.log.map((x) => [x[1].ref, x[2], x[3].pickFile]), [['s0/p3', 'insert', undefined], ['s0/p3', 'make_table', true], ['s0/p3/n8', 'fill_table', true]]);
});

test('메뉴를 연 동안 첨부가 바뀌면 v0.2 처럼 누를 때의 첨부로 파일 고르기를 정한다', async () => {
  // WebSocket 'attachment' 갱신이나 끌어다 놓은 파일 올리기가 끝나면 메뉴를 연 채로 d.s.attachments 가 바뀐다(store 는 목록을 통째로 바꾼다)
  const csv = [{ aid: 'a1', name: '응답률.csv' }];
  let n = 0;
  for (const [before, after] of [[[], csv], [csv, []]]) {
    const variant = { name: `첨부 ${before.length}→${after.length}`, presets: UTIL_PRESETS, attachments: before };
    for (const [name, c] of Object.entries(CONTEXTS)) {
      for (const p of runPaths(both(c, variant).old)) {
        const { dA, dB, old, now } = both(c, variant);
        dA.s.attachments = after; dB.s.attachments = after;
        at(old, p).run(); at(now, p).run(); await settle();
        assert.deepEqual(dB.log, dA.log, `${variant.name} / ${name} / ${at(old, p).label}`);
        for (const x of dB.log.filter((e) => e[0] === 'openComposer' && ['fill_table', 'make_table'].includes(e[2]))) {
          assert.equal(x[3].pickFile, !after.length, `${variant.name} / ${name} / ${x[2]}`); n++;
        }
      }
    }
  }
  assert.equal(n, 18, '두 방향 × (표 채우기 2곳 + 표 만들기 7곳)');
  // 플러그인이 보낸 서술도 store 가 있으면 누를 때의 첨부 수로, store 가 없을 때만 서술 값으로
  const d = mockStore({ attachments: csv });
  const run = menuRunner(d, { target: CELL, anchor: ANCHOR }, helpers(d.log));
  run({ type: 'fill_table', pickFile: true })(); run({ type: 'make_table' })();
  assert.deepEqual(d.log.map((x) => [x[2], x[3].pickFile]), [['fill_table', false], ['make_table', false]]);
  const bare = { ...mockStore(), s: undefined };
  const runBare = menuRunner(bare, { target: CELL, anchor: ANCHOR }, helpers(bare.log));
  runBare({ type: 'fill_table', pickFile: true })(); runBare({ type: 'make_table', pickFile: false })(); runBare({ type: 'make_table' })();
  assert.deepEqual(bare.log.map((x) => [x[2], x[3].pickFile]), [['fill_table', true], ['make_table', false], ['make_table', false]]);
});

test('groupChanges: 같은 자리·같은 작성자의 삭제+삽입은 교체 한 묶음', async () => {
  const { groupChanges: old } = v2({ presets: () => [], kindLabel: kindLabelFor(null), ...helpers([]) });
  const cases = {
    '같은 시작': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 2, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 6 }],
    '삭제가 삽입 끝에': [{ id: 1, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 6 }, { id: 2, type: 'Delete', ref: 'a', author: 'x', start: 6 }],
    '작성자 다름': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 2, type: 'Insert', ref: 'a', author: 'y', start: 3, end: 6 }],
    '문단 다름': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 2, type: 'Insert', ref: 'b', author: 'x', start: 3, end: 6 }],
    '자리 다름': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 2 }, { id: 2, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 6 }],
    '삭제 하나·삽입 둘': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 2, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 4 }, { id: 3, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 5 }],
    '삭제 둘·삽입 하나': [{ id: 1, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 2, type: 'Delete', ref: 'a', author: 'x', start: 3 }, { id: 3, type: 'Insert', ref: 'a', author: 'x', start: 3, end: 5 }],
    '빈 목록': [],
  };
  const ids = (gs) => gs.map((g) => g.map((x) => x.id));
  assert.deepEqual(ids(groupChanges(cases['같은 시작'])), [[1, 2]]);
  assert.deepEqual(ids(groupChanges(cases['삭제가 삽입 끝에'])), [[2, 1]]);
  assert.deepEqual(ids(groupChanges(cases['작성자 다름'])), [[1], [2]]);
  assert.deepEqual(ids(groupChanges(cases['문단 다름'])), [[1], [2]]);
  assert.deepEqual(ids(groupChanges(cases['자리 다름'])), [[1], [2]]);
  assert.deepEqual(ids(groupChanges(cases['삭제 하나·삽입 둘'])), [[1, 2], [3]]);
  assert.deepEqual(ids(groupChanges(cases['삭제 둘·삽입 하나'])), [[1, 3], [2]]);
  assert.deepEqual(groupChanges(cases['빈 목록']), []);
  for (const [name, list] of Object.entries(cases)) assert.deepEqual(groupChanges(list), old(list), name);
  // 실제 변경 추적 문서: #3 삽입 + #4 삭제(같은 자리·AI 검토자) = 교체, #1·#2 는 따로
  const doc = await loadDoc(FIX);
  const real = doc.changes();
  assert.deepEqual(ids(groupChanges(real)), [[4, 3], [1], [2]]);
  assert.equal(groupChanges(real)[0][0], real.find((x) => x.id === 4), '원래 객체를 그대로 묶는다');
});

test('groupChanges·changeGroupLabel·changeText: 개체 변경(표·그림·차트·도형 — 2026-10-30)은 같은 종류끼리만 짝, 이름은 엔진 label', () => {
  const tbl = [{ tag: 'hp:tbl', what: 'table', name: '표' }]; const pic = [{ tag: 'hp:pic', what: 'picture', name: '그림' }];
  const line = [{ tag: 'hp:line', what: 'shape', name: '선' }];
  const O = (id, type, extra = {}) => ({ id, type, ref: 'a', author: 'x', start: 3, end: 3, text: '', kind: 'object', ...extra });
  const T = (id, type, extra = {}) => ({ id, type, ref: 'a', author: 'x', start: 3, end: type === 'Insert' ? 6 : 3, text: '글', ...extra });
  const ids = (gs) => gs.map((g) => g.map((x) => x.id));
  // 같은 자리의 글 넣음 + 표 지움(종류 다름) → 따로, 개체끼리 → 짝, 글끼리 → 짝
  assert.deepEqual(ids(groupChanges([O(1, 'Delete', { objects: tbl, label: '표 지움' }), T(2, 'Insert')])), [[1], [2]]);
  assert.deepEqual(ids(groupChanges([T(1, 'Delete'), O(2, 'Insert', { objects: pic, label: '그림 넣음' })])), [[1], [2]]);
  assert.deepEqual(ids(groupChanges([O(1, 'Delete', { objects: tbl, label: '표 지움' }), O(2, 'Insert', { objects: tbl, label: '표 넣음' })])), [[1, 2]]);
  assert.deepEqual(ids(groupChanges([O(1, 'Delete', { objects: tbl }), T(2, 'Delete'), T(3, 'Insert'), O(4, 'Insert', { objects: tbl })])), [[2, 3], [1, 4]]);
  // 섞인 변경(mixed)은 글 쪽과 짝(글이 들어 있다)
  assert.deepEqual(ids(groupChanges([T(1, 'Delete', { kind: 'mixed', objects: tbl, label: '글과 표 지움' }), T(2, 'Insert')])), [[1, 2]]);
  // 이름: 개체 하나는 엔진 label, 개체 짝은 '… 바꿈', 글은 그대로
  assert.equal(changeGroupLabel([O(1, 'Delete', { objects: tbl, label: '표 지움' })]), '표 지움');
  assert.equal(changeGroupLabel([O(1, 'Insert', { objects: pic, label: '그림 2개 넣음' })]), '그림 2개 넣음');
  assert.equal(changeGroupLabel([O(1, 'Delete', { objects: tbl, label: '표 지움' }), O(2, 'Insert', { objects: tbl, label: '표 넣음' })]), '표 바꿈');
  assert.equal(changeGroupLabel([O(1, 'Delete', { objects: line, label: '도형 지움: 선' }), O(2, 'Insert', { objects: line, label: '도형 넣음: 선' })]), '도형 바꿈: 선');
  assert.equal(changeGroupLabel([O(1, 'Delete', { objects: tbl, label: '표 지움' }), O(2, 'Insert', { objects: pic, label: '그림 넣음' })]), '표 지움 → 그림 넣음');
  assert.equal(changeGroupLabel([O(1, 'Delete'), O(2, 'Insert')]), '개체 바꿈', 'label 이 없는 옛 엔진');
  assert.equal(changeGroupLabel([T(1, 'Delete', { kind: 'mixed', objects: tbl, label: '글과 표 지움' })]), '글과 표 지움');
  assert.equal(changeGroupLabel([T(1, 'Delete'), T(2, 'Insert')]), '교체');
  assert.equal(changeGroupLabel([T(1, 'Insert')]), '삽입');
  assert.equal(changeGroupLabel([T(1, 'Delete')]), '삭제');
  assert.equal(changeGroupLabel([]), '');
  // 본문: 개체는 [이름], 섞인 것은 글 뒤에, 글 변경은 글 그대로
  assert.equal(changeText(O(1, 'Delete', { objects: tbl })), '[표]');
  assert.equal(changeText(O(1, 'Insert', { objects: [...pic, ...pic] })), '[그림][그림]');
  assert.equal(changeText(O(1, 'Insert', { objects: [{ tag: 'hp:ole' }] })), '[개체]');
  assert.equal(changeText(T(1, 'Delete', { kind: 'mixed', objects: tbl, text: '앞 글' })), '앞 글 [표]');
  assert.equal(changeText(T(1, 'Delete', { text: '[표]' })), '[표]', '글 변경은 글 그대로');
  assert.equal(changeText(T(1, 'Delete', { objects: tbl })), '글', 'kind 가 없으면 objects 를 보지 않는다');
  assert.equal(changeText(null), '');
  // 화면 목록: 추적으로 지운 표 안(숨은 문단 '…/dK')의 변경은 뺀다
  const inner = [T(20, 'Insert', { ref: 's0/p3/d2' }), T(21, 'Insert', { ref: 's0/p3/d2/n1' }), T(22, 'Insert', { ref: 's0/p3/n2' }), O(23, 'Delete', { ref: 's0/p3', objects: tbl, label: '표 지움' })];
  assert.deepEqual(visibleChanges(inner).map((c) => c.id), [22, 23]);
  assert.deepEqual(visibleChanges(null), []);
  // 우클릭 메뉴 머리글도 같은 이름
  const model = menuModel({ changes: [O(7, 'Delete', { objects: tbl, label: '표 지움' }), T(8, 'Insert', { start: 9, end: 10 })] });
  const heads = model.filter((x) => x.kind === 'header').map((x) => x.label);
  assert.deepEqual(heads, ['변경 #7 표 지움 · x', '변경 #8 삽입 · x']);
});

test('groupChanges·changeGroupLabel·changeText: 문단 나눔 변경(kind para — 2026-10-30)은 그 문단 글·개체와 묶음(문단 지움·문단 넣음)', () => {
  const tbl = [{ tag: 'hp:tbl', what: 'table', name: '표' }];
  // 폭 0 나눔(start = end = 그 문단 끝 자리), 글 변경, 개체 변경
  const B = (id, type, extra = {}) => ({ id, type, ref: 's0/p2', author: 'x', start: 5, end: 5, text: '', kind: 'para', paraEnd: true, label: type === 'Insert' ? '문단 나눔 넣음' : '문단 나눔 지움', ...extra });
  const T = (id, type, extra = {}) => ({ id, type, ref: 's0/p2', author: 'x', start: 5, end: type === 'Insert' ? 9 : 5, text: '넷째 글', ...extra });
  const ids = (gs) => gs.map((g) => g.map((x) => x.id));
  // 문단 지움: 앞 문단(p2) 끝의 지운 나눔 + 같은 자리의 지운 글(이어 붙은 그 문단 글)·지운 표 — 같은 사람만, 교체 짝은 짓지 않음
  const del = [B(1, 'Delete'), T(2, 'Delete', { scope: 'paragraph' }), T(3, 'Delete', { kind: 'object', objects: tbl, label: '표 지움', text: '' })];
  assert.deepEqual(ids(groupChanges(del)), [[1, 2, 3]]);
  assert.equal(changeGroupLabel(groupChanges(del)[0]), '문단 지움');
  assert.deepEqual(ids(groupChanges([B(1, 'Delete'), T(2, 'Delete', { author: 'y' })])), [[1], [2]], '작성자 다름');
  assert.deepEqual(ids(groupChanges([B(1, 'Delete'), T(2, 'Delete', { start: 3 })])), [[1], [2]], '자리 다름');
  // 지운 나눔 옆의 넣은 글(같은 자리)과 교체 짝을 짓지 않는다
  assert.deepEqual(ids(groupChanges([B(1, 'Delete'), T(2, 'Insert')])), [[1], [2]]);
  // 문단 넣음: p2 끝의 넣은 나눔 + 다음 문단(p3)의 0 부터 이어지는 넣은 글·그림
  const ins = [B(4, 'Insert'), T(5, 'Insert', { ref: 's0/p3', start: 0, end: 4, text: '새 문단' }), T(6, 'Insert', { ref: 's0/p3', start: 4, end: 4, text: '', kind: 'object', objects: [{ name: '그림' }], label: '그림 넣음' })];
  assert.deepEqual(ids(groupChanges(ins)), [[4, 5, 6]]);
  assert.equal(changeGroupLabel(groupChanges(ins)[0]), '문단 넣음');
  assert.deepEqual(ids(groupChanges([B(4, 'Insert'), T(5, 'Insert', { ref: 's0/p3', start: 2, end: 4 })])), [[4], [5]], '0 에서 시작하지 않으면(그 문단의 옛 글 사이) 따로');
  assert.deepEqual(ids(groupChanges([B(4, 'Insert'), T(5, 'Insert', { ref: 's0/p4', start: 0, end: 4 })])), [[4], [5]], '다음 문단이 아님');
  // 한 밀어 넣기에 문단 둘: P{+¶+} N1{+¶+} N2 → 묶음 둘
  const two = [B(1, 'Insert'), T(2, 'Insert', { ref: 's0/p3', start: 0, end: 2 }), B(3, 'Insert', { ref: 's0/p3', start: 2, end: 2 }), T(4, 'Insert', { ref: 's0/p4', start: 0, end: 2 })];
  assert.deepEqual(ids(groupChanges(two)), [[1, 2], [3, 4]]);
  // 표 칸 안 다음 문단(중첩 ref)
  assert.deepEqual(ids(groupChanges([B(1, 'Insert', { ref: 's0/p1/n2' }), T(2, 'Insert', { ref: 's0/p1/n3', start: 0, end: 2 })])), [[1, 2]]);
  // 가른 문단에 걸친 넣음은 두 문단에 같은 번호로 나온다(엔진 splitParagraphTracked) — 목록·묶음에는 한 번만
  const dup = [T(7, 'Insert', { ref: 's0/p2', start: 0, end: 3 }), T(7, 'Insert', { ref: 's0/p3', start: 0, end: 2 }), B(8, 'Insert', { ref: 's0/p2', start: 3, end: 3 })];
  assert.deepEqual(visibleChanges(dup).map((c) => c.id), [7, 8]);
  assert.deepEqual(ids(groupChanges(dup)), [[8], [7]]);
  // 나눔 하나: 엔진 label, 없으면(옛 응답) 종류로
  assert.equal(changeGroupLabel([B(1, 'Delete')]), '문단 나눔 지움');
  assert.equal(changeGroupLabel([B(1, 'Insert', { label: undefined })]), '문단 나눔 넣음');
  assert.equal(changeGroupLabel([B(1, 'Delete', { label: '글과 문단 나눔 지움', text: '끝 글' })]), '글과 문단 나눔 지움');
  // 본문: 나눔은 끝에 ¶(글이 있으면 글 뒤, 개체+나눔은 개체 뒤)
  assert.equal(changeText(B(1, 'Delete')), '¶');
  assert.equal(changeText(B(1, 'Delete', { text: '끝 글' })), '끝 글¶');
  assert.equal(changeText({ id: 9, type: 'Insert', kind: 'object', paraEnd: true, objects: tbl, text: '', label: '표 넣음' }), '[표]¶');
  // 우클릭 메뉴 머리글
  const heads = menuModel({ changes: del }).filter((x) => x.kind === 'header').map((x) => x.label);
  assert.deepEqual(heads, ['변경 #1·#2·#3 문단 지움 · x']);
  const acts = menuModel({ changes: del }).filter((x) => x.kind === 'item').map((x) => x.action);
  assert.deepEqual(acts, [{ type: 'change-accept', ids: [1, 2, 3] }, { type: 'change-reject', ids: [1, 2, 3] }]);
});

test('agentPrompt: 문서·작업 식별, 선점 충돌 중단, 권장안 1개 원칙(store 또는 { id, title })', () => {
  const d = mockStore();
  const reqs = [{ rid: 3, kind: 'suggest' }, { rid: 4, kind: 'polish', label: '다듬기 · 간결하게' }, { rid: 5, kind: 'zzz' }, { rid: 6 }, { rid: 7, kind: 'review' }];
  for (const r of reqs) {
    const text = agentPrompt(d, r, UTIL_KINDS);
    assert.equal(text, agentPrompt(d, r), `#${r.rid} 종류 기본`);
    assert.equal(text, agentPrompt({ id: d.id, title: '시험 문서' }, r), `#${r.rid} { id, title }`);
    // 2026-11-17: MCP 기본 연결이 새 연결(작업 도구 넷 — server/mcp2.js mcpSurface)이라 기본 글은 task → read → edit(done)/finish 순서.
    // 예전 연결(옛 브리지·실행기, 또는 config.mcp.defaultSurface 'v1' 서버)의 도구 순서는 한 줄로 남긴다
    assert.match(text, new RegExp(`task\\(doc_id="${d.id}", request_id=${r.rid}\\)로 맡기\\(CLAIMED·NOT_OWNER·REQUEST_CLOSED면 중단`));
    assert.match(text, /edit\(doc_id=.*done=공유용 1~2문장 요약/); assert.match(text, /finish\(doc_id=.*no_changes_reason/);
    assert.match(text, /예전 연결이면: get_request → start_request → .* → complete_request/);
    assert.match(text, /기본은 권장 수정안 1개/);
    assert.match(text, /여러 안을 요청한 경우에만 options.count/);
    assert.ok(text.includes(`request_id=${r.rid}`));
    const old = agentPrompt(d, r, UTIL_KINDS, { surface: 'v1' });
    assert.match(old, /start_request\(CLAIMED·NOT_OWNER면 중단\)/, '예전 연결 서버(features.mcpDefault v1)');
    assert.doesNotMatch(old, /\btask\(|\bedit\(/);
    assert.ok(old.startsWith(text.split('\n')[0] + '\n'), '첫 줄(문서·작업 식별)은 같다');
  }
  const custom = [{ id: 'review', label: '검토해 줘' }];
  assert.match(agentPrompt(d, reqs[4], custom), /AI 작업 #7\(검토해 줘\)/);
  const noTitle = { ...mockStore(), s: { info: null } };
  assert.match(agentPrompt(noTitle, reqs[0]), /문서 「doc-1」/);
  assert.ok(agentPrompt({ id: 'd9' }, { rid: 1, kind: 'review' }).startsWith('hwpx-cowork 문서 「d9」(doc_id: d9)의 AI 작업 #1(AI 검토)을 처리해 줘.\n'));
  const text = agentPrompt(d, { rid: 12, kind: 'suggest' });
  assert.ok(text.includes('request_id=12') && text.includes(d.id), 'ui_review [15] 가 보는 조각');
  assert.match(text, /AI 작업 #12\(문장 제안\)/);
});

// ───────── v0.3 편집기 우클릭 '검토' 구역(reviewMenuModel — V3_SPEC §1.3) ─────────

/** 모델 → 한 줄씩(머리글 '# 글', 구분선 '—', 하위 메뉴 '▸ 글', 힌트 [힌트], 꺼짐 (off)) */
const rlines = (model) => model.map((e) => (e.kind === 'sep' ? '—' : e.kind === 'header' ? `# ${e.label}`
  : `${e.kind === 'sub' ? '▸ ' : ''}${e.label}${e.hint ? ` [${e.hint}]` : ''}${e.disabled ? ' (off)' : ''}`));
const SEL = { ref: 's0/p1', start: 3, end: 6, endRef: 's0/p1', refs: ['s0/p1'], text: '낱말을', collapsed: false, cell: false, source: 'base', rect: { x: 1, y: 2, w: 3, h: 4 } };
const RV_PROPS = [
  { pid: 7, type: 'replace', status: 'pending', label: '제안 #7 · 안 2 · 홍길동(Claude)' },
  { pid: 8, type: 'replace', status: 'applied', label: '제안 #8 · 모의 AI' },
  { pid: 9, type: 'table', status: 'pending', label: '제안 #9 · 김검토' },
  { pid: 10, type: 'insert', status: 'pending', label: '제안 #10 · 김검토' },
];
const RV_DRAFTS = [{ cid: 3, user: '김검토', status: 'open', hid: 'h1a2', color: '#c2255c' }, { cid: 4, user: '아주아주긴이름을가진검토자', status: 'draft' }];
const RV_MEMOS = [
  { id: 'memo1', kind: 'memo', label: '관리자', author: '관리자', resolved: false },
  { id: 'memo2', kind: 'request', label: 'AI 작업 #3', author: '홍길동', status: 'working', rid: 3, open: 2 },
  { id: 'memo3', kind: 'memo', label: '김검토', author: '김검토', resolved: true },
  { id: 'memo4', kind: 'proposal', label: '제안 #7', author: '홍길동(Claude)' },
  { id: 'memo5', kind: 'comment', label: 'AI 의견 #3', author: '모의 AI' },
];

test('검토 구역: AI에게 맡기기… · AI에게 빠르게 맡기기 ▸ → 메모 달기 — 요청 종류 항목·첨부·표·문단 추가 없음(2026-11-03)', () => {
  const m = reviewMenuModel({ target: SEL, hasSelection: true });
  assert.deepEqual(rlines(m), ['# 검토', 'AI에게 맡기기…', '▸ AI에게 빠르게 맡기기', '—', '메모 달기', '—']);
  assert.deepEqual(m.filter((e) => e.kind === 'item').map((e) => [e.icon, e.action]), [['instruct', { type: 'instruct' }], ['memo', { type: 'memo' }]]);
  assert.equal(m.find((e) => e.id === 'instruct').hint, '', '선택 안이면 범위 힌트 없음');
  const quick = m.find((e) => e.id === 'ai-shortcuts').sub;
  // 예전 'AI 빠른 작업'과 같은 이름·순서 — 동작은 예시 지시(quick id)
  assert.deepEqual(rlines(quick), ['검토하기', '문장 고쳐 쓰기', '—', ...DEFAULT_PRESETS.map((p) => p.label)]);
  assert.deepEqual(quick.filter((e) => e.kind === 'item').map((e) => e.action), ['review', 'suggest', ...DEFAULT_PRESETS.map((p) => `polish:${p.id}`)].map((id) => ({ type: 'quick', id })));
  assert.ok(!quick.some((e) => e.kind === 'header' || e.send), '확인 후 보내기(quickSend 없음) — 표시 없음');
  assert.ok(!m.some((e) => ['rewrite', 'copy', 'attach', 'fill_table', 'insert', 'make_table', 'review', 'suggest', 'polish'].includes(e.action?.type)));
  // 바로 보내기(quickSend) → 하위 메뉴 맨 위 보낼 곳 머리글 · 항목마다 send(AI 보라 — UI_TERMS §4), 위층은 send 없음
  const qs = reviewMenuModel({ target: SEL, hasSelection: true, quickSend: 'Claude Code로 보내기' });
  const qsub = qs.find((e) => e.id === 'ai-shortcuts').sub;
  assert.deepEqual(rlines(qsub)[0], '# Claude Code로 보내기');
  assert.ok(qsub.filter((e) => e.kind === 'item').every((e) => e.send === true) && !qs.some((e) => e.kind === 'item' && e.send));
  // 문단 전체면 힌트 「문단 전체」, 다듬기 기준은 설정 목록
  assert.equal(reviewMenuModel({ target: { ...SEL, whole: true }, hasSelection: false }).find((e) => e.id === 'instruct').hint, '문단 전체');
  const custom = reviewMenuModel({ target: SEL, presets: CUSTOM_PRESETS }).find((e) => e.id === 'ai-shortcuts').sub;
  assert.deepEqual(custom.filter((e) => e.icon === 'polish').map((e) => e.action.id), ['polish:short', 'polish:kind']);
});

test('빠르게 맡기기 예시 지시: 항목마다 알맞은 지시 · 모르는 다듬기 기준은 이름표로 · 모르는 id 는 빈 글', () => {
  const list = quickTasks();
  assert.deepEqual(list.map((q) => (q.sep ? '—' : q.id)), ['review', 'suggest', '—', ...DEFAULT_PRESETS.map((p) => `polish:${p.id}`)]);
  for (const q of list.filter((x) => !x.sep)) assert.ok(q.prompt.length > 15 && /줘|마\.$/.test(q.prompt), q.id);
  assert.match(quickPrompt('polish:formal'), /공문서 문체/);
  assert.match(quickPrompt('review'), /검토/);
  assert.equal(quickPrompt('polish:short', CUSTOM_PRESETS), '고른 글을 「짧게」 기준으로 다듬어 줘. 뜻과 수치는 그대로 두고 고칠 곳만 수정안으로 제안해 줘.');
  assert.equal(quickPrompt('nope'), '');
});

test('검토 구역: 덮는 제안·남의 수정 중·메모마다 하위 메뉴(V3 동작) — 보이는 제안의 메모는 숨김', () => {
  const m = reviewMenuModel({ target: SEL, hasSelection: true, proposals: RV_PROPS, drafts: RV_DRAFTS, memos: RV_MEMOS });
  const subs = m.filter((e) => e.kind === 'sub' && e.id !== 'ai-shortcuts');
  assert.deepEqual(rlines(subs), [
    '▸ 제안 #7 · 안 2 · 홍길동(Claude)', '▸ 제안 #8 · 모의 AI [적용됨]', '▸ 제안 #9 · 김검토', '▸ 제안 #10 · 김검토',
    '▸ ✎ 김검토 수정 중 [#3 검토 중]', '▸ ✎ 아주아주긴이름을가진검토… 수정 중 [#4]', // 이름은 12자에서 자른다
    '▸ 메모 · 관리자', '▸ AI 작업 #3 · 홍길동', '▸ 메모 · 김검토 · 완료', '▸ AI 의견 #3 · 모의 AI',
  ]);
  const sub = (id) => m.find((e) => e.id === id).sub;
  // 제안: 대기 → 반영(내 수정본에) / 거절 / 보기(레일), 적용됨 → 보기만, 표 제안은 반영 꺼짐
  assert.deepEqual(sub('rv-proposal:7').map((s) => [s.label, s.action]), [
    ['반영', { type: 'proposal-adopt', pid: 7 }], ['거절', { type: 'proposal-reject', pid: 7 }], ['보기', { type: 'proposal-show', pid: 7 }],
  ]);
  assert.deepEqual(sub('rv-proposal:8').map((s) => s.action), [{ type: 'proposal-show', pid: 8 }]);
  assert.deepEqual(rlines(sub('rv-proposal:9')), ['반영 [표는 바로 적용만] (off)', '거절', '보기']);
  assert.equal(sub('rv-proposal:10')[0].disabled, undefined, '문단 추가 제안은 내 수정본에 반영 가능(insertParagraphAfter)');
  assert.ok(!JSON.stringify(m).includes('기준') && !JSON.stringify(m).includes('해결'), '보이는 글에 「기준」·「해결」 없음(UI_TERMS)');
  // 남의 수정 중: 변경 보기 / 의견 달기(덩어리 hid 가 있으면 같이)
  assert.deepEqual(sub('rv-draft:3:h1a2').map((s) => [s.label, s.action]), [
    ['변경 보기', { type: 'draft-show', cid: 3, hid: 'h1a2' }], ['의견 달기', { type: 'draft-comment', cid: 3, hid: 'h1a2' }],
  ]);
  assert.deepEqual(sub('rv-draft:4').map((s) => s.action), [{ type: 'draft-show', cid: 4 }, { type: 'draft-comment', cid: 4 }]);
  assert.equal(m.find((e) => e.id === 'rv-draft:3:h1a2').icon, 'draft');
  // 메모: 보기 / 답글 / 완료(완료된 메모는 다시 열기)
  assert.deepEqual(sub('rv-memo:memo1').map((s) => [s.label, s.action]), [
    ['보기', { type: 'memo-show', id: 'memo1' }], ['답글', { type: 'memo-reply', id: 'memo1' }], ['완료', { type: 'memo-resolve', id: 'memo1', resolved: true }],
  ]);
  assert.deepEqual(sub('rv-memo:memo3').map((s) => s.label), ['보기', '답글', '다시 열기']);
  assert.deepEqual(sub('rv-memo:memo3')[2].action, { type: 'memo-resolve', id: 'memo3', resolved: false });
  assert.equal(m.find((e) => e.id === 'rv-memo:memo2').icon, 'ai', 'AI 작업 메모는 AI 아이콘');
  // AI 작업 메모(v0.3.1 §9.7): 보기 / 답글 / 모두 반영 (n) — [완료]는 없다(완료는 제안을 정하면 저절로)
  assert.deepEqual(sub('rv-memo:memo2').map((s) => [s.label, s.action]), [
    ['보기', { type: 'memo-show', id: 'memo2' }], ['답글', { type: 'memo-reply', id: 'memo2' }], ['모두 반영 (2)', { type: 'request-adopt-all', rid: 3 }],
  ]);
  assert.equal(sub('rv-memo:memo2')[2].id, 'request-adopt-all:3', '항목 id 에 요청 번호');
  assert.ok(!m.some((e) => e.id === 'rv-memo:memo4'), '보이는 제안(#7)의 메모는 숨김');
  // 덮는 것들 다음에 구분선, 그다음 AI 요청 항목
  const first = m.findIndex((e) => e.id === 'instruct');
  assert.equal(m[first - 1].kind, 'sep');
  assert.equal(m[0].kind, 'header');
});

test('검토 구역: AI 작업 메모 — 남은 것이 없거나(open 0) 요청 번호를 모르면 보기·답글만, 완료(내 눈)면 머리글에 완료 · [완료]·[다시 열기] 없음', () => {
  const req = (x) => ({ id: 'mr', kind: 'request', label: 'AI 작업 #5', author: '관리자', ...x });
  const subOf = (x) => reviewMenuModel({ memos: [req(x)] }).find((e) => e.id === 'rv-memo:mr').sub;
  assert.deepEqual(subOf({ rid: 5, open: 0 }).map((s) => s.label), ['보기', '답글']);
  assert.deepEqual(subOf({ rid: 5 }).map((s) => s.label), ['보기', '답글']);
  assert.deepEqual(subOf({ open: 3 }).map((s) => s.label), ['보기', '답글'], 'rid 를 모르면 동작을 만들지 않는다');
  assert.deepEqual(subOf({ rid: '5', open: '3' }).map((s) => s.action), [{ type: 'memo-show', id: 'mr' }, { type: 'memo-reply', id: 'mr' }, { type: 'request-adopt-all', rid: 5 }], '문자열 수도 수로');
  const done = reviewMenuModel({ memos: [req({ rid: 5, resolved: true })] });
  assert.deepEqual(rlines(done), ['# 검토', '▸ AI 작업 #5 · 관리자 · 완료', '—']);
  assert.ok(!done[1].sub.some((s) => s.action.type === 'memo-resolve'), 'AI 작업 메모에는 [완료]·[다시 열기]가 없다');
});

test('검토 구역: 대상이 없으면 덮는 것만(+ 구분선), 아무것도 없으면 빈 목록(구역을 넣지 않음)', () => {
  assert.deepEqual(reviewMenuModel({}), []);
  assert.deepEqual(reviewMenuModel(), []);
  assert.deepEqual(reviewMenuModel({ proposals: null, drafts: 'x', memos: undefined }), []);
  assert.deepEqual(rlines(reviewMenuModel({ memos: [RV_MEMOS[0]] })), ['# 검토', '▸ 메모 · 관리자', '—']);
  // 보이는 제안의 메모만 덮으면 그 메모는 숨고 제안만
  assert.deepEqual(rlines(reviewMenuModel({ proposals: [RV_PROPS[0]], memos: [RV_MEMOS[3]] })), ['# 검토', '▸ 제안 #7 · 안 2 · 홍길동(Claude)', '—']);
});

test('검토 구역: JSON 그대로, id 유일(하위 메뉴 안도), 동작은 REVIEW_MENU_ACTIONS 안이고 모두 한 번 이상 나온다', () => {
  const seen = new Set();
  const ctxs = [
    { target: SEL, hasSelection: true, proposals: RV_PROPS, drafts: RV_DRAFTS, memos: RV_MEMOS, attachmentsCount: 0 },
    { target: { ...SEL, cell: true }, cell: true, proposals: [RV_PROPS[0], RV_PROPS[0]], drafts: [RV_DRAFTS[0], RV_DRAFTS[0]], memos: [RV_MEMOS[0], RV_MEMOS[0]] },
    { memos: RV_MEMOS, presets: CUSTOM_PRESETS },
  ];
  for (const c of ctxs) {
    const m = reviewMenuModel(c);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
    for (const list of [m, ...m.filter((e) => e.sub).map((e) => e.sub)]) assert.equal(new Set(list.map((e) => e.id)).size, list.length, 'id 유일');
    for (const e of m.flatMap((x) => [x, ...(x.sub || [])])) {
      assert.ok(['header', 'item', 'sep', 'sub'].includes(e.kind), e.kind);
      if (e.kind === 'item') { assert.ok(REVIEW_MENU_ACTIONS.includes(e.action.type), e.action.type); seen.add(e.action.type); } else assert.equal(e.action, undefined);
      if (e.kind === 'sub') assert.ok(e.sub.length > 0);
    }
  }
  assert.deepEqual([...seen].sort(), [...REVIEW_MENU_ACTIONS].sort());
  // V3_SPEC §1.3 의 menu-action 동작 목록 + v0.3.1 §9.7 request-adopt-all
  assert.deepEqual([...REVIEW_MENU_ACTIONS].sort(), ['instruct', 'quick', 'memo',
    'proposal-adopt', 'proposal-reject', 'proposal-show', 'draft-show', 'draft-comment', 'memo-show', 'memo-reply', 'memo-resolve', 'request-adopt-all'].sort());
});

test('검토 구역: buildAnnotations(Annotations) 모양을 그대로 받는다 — 플러그인이 덮는 것을 고른 그대로 넣으면 같은 머리글', () => {
  const paragraphs = [{ ref: 's0/p0', text: '첫째 문단입니다.' }, { ref: 's0/p1', text: '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다.' }];
  const ann = buildAnnotations({
    paragraphs,
    memos: [
      { id: 'memo1', ref: 's0/p1', start: 10, end: 20, author: '관리자', text: '다듬어 주세요' },
      { id: 'memo2', ref: 's0/p1', start: 10, end: 12, author: '홍길동', text: '[AI 작업 #3]', link: { type: 'request', rid: 3 } },
      { id: 'memo3', ref: 's0/p1', start: 0, end: 5, author: '모의 AI', text: '[제안 #7]', link: { type: 'proposal', pid: 7 } },
      { id: 'memo4', ref: 's0/p1', start: 0, end: 5, author: '김검토', text: '끝', thread: { replies: [], resolved: { by: '관리자', at: 1 } } },
    ],
    proposals: [{ pid: 7, ref: 's0/p1', find: '있던 낱말을', replace: '옛 낱말을', status: 'pending', by: '모의 AI', memoId: 'memo3' }],
    requests: [{ rid: 3, status: 'working' }],
    drafts: [{ cid: 3, user: '김검토', status: 'open', hunks: [{ hid: 'h1', type: 'replace', curRef: 's0/p1', newText: '고친 글' }] }],
  }, { me: '관리자' });
  // 플러그인 coverage(): 덮는 메모·제안·수정 중 덩어리({cid,user,status,hid})
  const drafts = ann.drafts.map((d) => ({ cid: d.cid, user: d.user, status: d.status, hid: d.hunks[0].hid, color: d.color }));
  const m = reviewMenuModel({ target: SEL, hasSelection: true, proposals: ann.proposals, drafts, memos: ann.memos });
  assert.deepEqual(rlines(m.filter((e) => e.kind === 'sub' && e.id !== 'ai-shortcuts')), [
    '▸ 제안 #7 · 모의 AI', '▸ ✎ 김검토 수정 중 [#3 검토 중]', '▸ 메모 · 관리자', '▸ AI 작업 #3 · 홍길동', '▸ 메모 · 김검토 · 완료',
  ]);
  assert.deepEqual(m.find((e) => e.id === 'rv-memo:memo4').sub[2].action, { type: 'memo-resolve', id: 'memo4', resolved: false }, '스레드 해결 → 다시 열기');
  // AI 작업 메모: requestView 없이는 보기·답글만 — 호스트가 남은 수(open)를 주면 '모두 반영 (n)'(요청 번호는 Annotations 의 rid)
  assert.deepEqual(m.find((e) => e.id === 'rv-memo:memo2').sub.map((s) => s.label), ['보기', '답글']);
  const ann2 = buildAnnotations({ paragraphs, memos: [{ id: 'memo2', ref: 's0/p1', start: 10, end: 12, author: '홍길동', text: '[AI 작업 #3]', link: { type: 'request', rid: 3 } }], requests: [{ rid: 3, status: 'done' }] },
    { me: '관리자', requestView: () => ({ open: 1 }) });
  const m2 = reviewMenuModel({ target: SEL, hasSelection: true, memos: ann2.memos });
  assert.deepEqual(m2.find((e) => e.id === 'rv-memo:memo2').sub[2].action, { type: 'request-adopt-all', rid: 3 });
});

test('reviewMenuModel 은 v0.2 menuModel 의 출력을 바꾸지 않는다(같은 문맥, 부른 순서와 무관)', () => {
  for (const [name, c] of Object.entries(CONTEXTS)) {
    const before = JSON.stringify(menuModel(c));
    reviewMenuModel({ ...c, drafts: RV_DRAFTS });
    assert.equal(JSON.stringify(menuModel(c)), before, name);
  }
});

test('검토 구역(v0.4 실시간 문서): 제안의 adoptLabel 이 있으면 그 이름(문서에 반영) — 같은 proposal-adopt, 표 제안도 막지 않음(서버가 적용) · 없으면 v0.3 그대로', () => {
  const props = [
    { pid: 21, type: 'replace', status: 'pending', label: '제안 #21', adoptLabel: '문서에 반영' },
    { pid: 22, type: 'table', status: 'pending', label: '제안 #22', adoptLabel: '문서에 반영' },
    { pid: 23, type: 'table', status: 'pending', label: '제안 #23' },
  ];
  const m = reviewMenuModel({ target: null, proposals: props });
  const sub = (id) => m.find((e) => e.id === id).sub;
  assert.deepEqual(sub('rv-proposal:21').map((s) => [s.label, s.action, s.disabled]), [
    ['문서에 반영', { type: 'proposal-adopt', pid: 21 }, undefined], ['거절', { type: 'proposal-reject', pid: 21 }, undefined], ['보기', { type: 'proposal-show', pid: 21 }, undefined],
  ]);
  assert.deepEqual([sub('rv-proposal:22')[0].label, sub('rv-proposal:22')[0].disabled], ['문서에 반영', undefined]);
  assert.deepEqual([sub('rv-proposal:23')[0].label, sub('rv-proposal:23')[0].disabled, sub('rv-proposal:23')[0].hint], ['반영', true, '표는 바로 적용만']);
  // buildAnnotations 의 adoptLabel(실시간 문서)이 메뉴까지 그대로 간다
  const a = buildAnnotations({ paragraphs: [{ ref: 's0/p0', text: '가나다 라마바' }], proposals: [{ pid: 5, ref: 's0/p0', find: '라마바', status: 'pending', by: 'AI' }] }, { adoptLabel: '문서에 반영' });
  const m2 = reviewMenuModel({ target: null, proposals: a.proposals });
  assert.equal(m2.find((e) => e.id === 'rv-proposal:5').sub[0].label, '문서에 반영');
});
