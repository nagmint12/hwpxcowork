// node --test tests/paragraph_delete_move.test.mjs — 본문 문단 통째로 지우기·옮기기(para_delete·para_move — 2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-1).
// 2026-11-16 밤 실험 T10(절 지우기 — 글만 지워 빈 문단 6개)·T09(절 옮기기 — 다시 만들고 원래 자리 빈 문단 5개)의 꼴을 연습 보고서 사본으로 다시 한다:
//   실시간 '고친 글만'(문단째 지움·XML 그대로 옮김)과 변경 추적 문서(글·개체 지움 표식 + 앞 문단 끝 나눔 지움, 옮김 = 지움 + 넣음),
//   되돌리기·다른 대기 제안 lost/되살림·주소 다시 매기기·막는 경우·새 연결 op(꼴·미리 해 보기·영수증).
// 한/글 2022 로 연 결과(쪽 수·변경 추적 모두 적용 뒤 문단)는 HANGUL=1 일 때만(tests/helpers 밖 — 아래 끝 시험, 한/글 COM 이 있는 PC).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
import { paragraphRange, moveParagraphsRaw, moveIndexMap, planParagraphs, paragraphsPreview, removeParagraphsRaw } from '../engine/para-move.js';
import { parseOps, prepareOps, OPS_BRIEF } from '../server/mcp2/ops.js';
import { activityItem } from '../server/activity.js';
import * as MT from '../server/memotext.js';
import { proposalPlace } from '../web/proposal-place.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, root } from './helpers/server.mjs';

const PRACTICE = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const author = '홍길동(Claude)';
const bodyTexts = (d, sec) => d.sections[sec].bodyParas.map((p) => d.text(p.ref, 'final'));
const tableXml = (d, ref) => { const { sec, p } = d.resolve(ref); const x = sec.xml.slice(p.start, p.end); return x.slice(x.indexOf('<hp:tbl'), x.lastIndexOf('</hp:tbl>') + 9); };
const stripIds = (x) => x.replace(/\s(id|instid|zOrder)="\d+"/g, '');

test('엔진: 범위 검사·XML 그대로 옮기기·주소 옮김 표', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  assert.deepEqual(d.sectionSizes(), [8, 74]);
  assert.throws(() => paragraphRange(d, 1, 0, 3), /FIRST_PARAGRAPH|구역의 첫 문단/);
  assert.throws(() => paragraphRange(d, 1, 70, 80), /p0~p73/);
  assert.throws(() => paragraphRange(d, 2, 1, 1), /구역이 없습니다/);
  const before = bodyTexts(d, 1);
  const t59 = tableXml(d, 's1/p59');
  // T09 꼴: '4) 학기 유형별 재수강' 절(p55..p60 — 제목·본문 둘·단위·표+주·빈 줄)을 '3) 소속대학별…'(p47) 앞으로
  const r = moveParagraphsRaw(d, 1, 55, 60, 46);
  assert.deepEqual(r, { from: 47, to: 52 });
  const after = bodyTexts(await HwpxDoc.load(await d.save()), 1);
  const fn = moveIndexMap(55, 60, 46);
  assert.equal(after.length, before.length, '문단 수 그대로(빈 문단이 남지 않는다)');
  before.forEach((t, i) => assert.equal(after[fn(i)], t, `p${i} → p${fn(i)}`));
  assert.equal(after[47], '4) 학기 유형별 재수강');
  assert.equal(after[53], '3) 소속대학별 재수강 현황(RQ2)');
  assert.equal(tableXml(d, 's1/p51'), t59, '표는 원본 XML 그대로(id 까지)');
  // 거꾸로 옮기면 처음 XML 과 같은 글 차례
  moveParagraphsRaw(d, 1, 47, 52, 60);
  assert.deepEqual(bodyTexts(d, 1), before);
  assert.throws(() => moveParagraphsRaw(d, 1, 55, 60, 57), /INSIDE|범위 안/);
  assert.throws(() => moveParagraphsRaw(d, 1, 55, 60, 54), /이미/);
  // 필드가 범위 안팎에 걸치면 막는다(차례 필드 s0/p5..p7) — 차례째면 된다
  assert.throws(() => paragraphRange(d, 0, 5, 6), (e) => e.code === 'FIELD_SPLIT' && /차례.*toc op/.test(e.message));
  assert.doesNotThrow(() => paragraphRange(d, 0, 5, 7));
  // 머리말·꼬리말 부호가 든 문단을 지우면 부호는 앞 문단으로 옮긴다(쪽 꼬리말이 함께 사라지지 않게)
  const e = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  const hfs = e.takeHeaderFooters('s1/p0'); assert.ok(hfs.length, '연습 보고서 s1/p0 에 꼬리말');
  e.putHeaderFooters('s1/p9', hfs);
  assert.deepEqual(removeParagraphsRaw(e, 1, 8, 13), { removed: 6, headerFooters: hfs.length });
  assert.equal(e.takeHeaderFooters('s1/p7').length, hfs.length);
  // 미리 보기 글
  const plan = planParagraphs(d, { ref: 's1/p55', toRef: 's1/p60', afterRef: 's1/p46' }, { move: true });
  assert.match(paragraphsPreview(d, plan, { move: true }), /^문단 6개를 옮긴다\(s1\/p55\.\.p60: 「4\) 학기 유형별 재수강」/);
  assert.match(paragraphsPreview(d, plan, { move: true }), /그다음 「3\) 소속대학별/);
});

/** 문단 글 목록에서 from..to 를 빼거나 after 뒤로 옮긴 기대값 */
const without = (list, from, to) => [...list.slice(0, from), ...list.slice(to + 1)];
const movedList = (list, from, to, after) => { const fn = moveIndexMap(from, to, after); const out = []; list.forEach((t, i) => { out[fn(i)] = t; }); return out; };

test('서버(실시간 고친 글만): T10 절 지우기·T09 절 옮기기 — 빈 문단 0, 표 원본 XML, 다른 제안 lost·따라감, 되돌리기', { timeout: 180000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const orig = await HwpxDoc.load(fs.readFileSync(PRACTICE));
    const T = bodyTexts(orig, 1);
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), '연습 보고서.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const file = async (kind = 'working') => HwpxDoc.load(await A(`${D}/file?kind=${kind}`));
    const props = async () => new Map((await A(`${D}/proposals`)).map((p) => [p.pid, p]));
    const post = (body) => A(`${D}/proposals`, { method: 'POST', body });
    const act = (pid, what) => A(`${D}/proposals/${pid}/${what}`, { method: 'POST' });

    // 다른 대기 제안: 지울 범위 안(RQ1 문단) · 범위 뒤(분석 대상 문단) · 범위 안 문단 뒤에 넣기
    const qIn = await post({ ref: 's1/p10', find: 'RQ1', replace: '질문 1' });
    const qAfter = await post({ ref: 's1/p20', find: '29,821명', replace: '29,821명(전체)' });
    const qIns = await post({ type: 'insert', afterRef: 's1/p12', text: '넣을 문단' });

    // 막는 경우(제안 단계)
    const bad = async (body, re) => { const r = await A.res(`${D}/proposals`, { method: 'POST', body }); assert.ok(!r.ok, JSON.stringify(body)); assert.match(JSON.stringify(r.data), re); };
    await bad({ type: 'para_delete', ref: 's1/p0', toRef: 's1/p3' }, /FIRST_PARAGRAPH|구역의 첫 문단/);
    await bad({ type: 'para_delete', ref: 's0/p5', toRef: 's1/p3' }, /CROSS_SECTION|구역을 넘/);
    await bad({ type: 'para_delete', ref: 's1/p17/n0' }, /BAD_REF|본문 문단/);
    await bad({ type: 'para_move', ref: 's1/p55', toRef: 's1/p60', afterRef: 's1/p57' }, /INSIDE|범위 안/);
    await bad({ type: 'para_move', ref: 's1/p55', toRef: 's1/p60', afterRef: 's1/p54' }, /SAME_PLACE|이미/);
    await bad({ type: 'para_move', ref: 's1/p55', toRef: 's1/p60', afterRef: 's0/p3' }, /CROSS_SECTION|같은 구역/);

    // T10: '2) 분석 질문' 절(p8 제목 ~ p13 RQ4)
    const del = await post({ type: 'para_delete', ref: 's1/p8', toRef: 's1/p13', reason: '절 삭제' });
    assert.deepEqual([del.type, del.ref, del.paras.count, del.paras.first[0]], ['para_delete', 's1/p8', 6, '2) 분석 질문']);
    await bad({ type: 'para_delete', ref: 's1/p8', toRef: 's1/p13' }, /SAME|이미/);
    assert.equal((await A.res(`${D}/proposals/${del.pid}/adopt`, { method: 'POST' })).status, 400, '수정본 반영은 안 된다(문서에 바로 적용만)');
    const ap = await act(del.pid, 'apply');
    assert.deepEqual([ap.status, ap.ref, ap.changeIds.length], ['applied', 's1/p7', 0]);
    let f = await file();
    assert.deepEqual(bodyTexts(f, 1), without(T, 8, 13), '절이 통째로 없어지고 빈 문단이 남지 않는다');
    assert.equal(f.changes().length, 0);
    let P = await props();
    assert.equal(P.get(qIn.pid).lost, true, '지운 문단의 제안은 잃는다');
    assert.equal(P.get(qIns.pid).lost, true, '지운 문단 뒤에 넣기도 잃는다');
    assert.equal(P.get(qAfter.pid).ref, 's1/p14', '뒤 문단 제안 주소는 6 당겨진다');
    assert.equal((await A.res(`${D}/proposals/${qIn.pid}/apply`, { method: 'POST' })).status, 409);

    // 되돌리기(그 뒤 문서 그대로 → 지우기 직전 사본으로): 글·주소·잃은 제안이 돌아온다
    const un = await act(del.pid, 'undo');
    assert.equal(un.status, 'undone');
    f = await file();
    assert.deepEqual(bodyTexts(f, 1), T);
    P = await props();
    assert.deepEqual([P.get(qIn.pid).ref, !!P.get(qIn.pid).lost, P.get(qIns.pid).afterRef, !!P.get(qIns.pid).lost, P.get(qAfter.pid).ref, P.get(del.pid).ref], ['s1/p10', false, 's1/p12', false, 's1/p20', 's1/p8']);

    // 다시 열어 반영 → 다른 제안 반영(문서가 바뀜) → 되돌리기는 사본에서 문단을 다시 만든다
    await act(del.pid, 'reopen');
    await act(del.pid, 'apply');
    assert.equal((await act(qAfter.pid, 'apply')).status, 'applied');
    await act(del.pid, 'undo');
    f = await file();
    const T2 = T.map((t, i) => (i === 20 ? t.replace('29,821명', '29,821명(전체)') : t));
    assert.deepEqual(bodyTexts(f, 1), T2, '다시 만든 문단 + 그 사이 반영한 제안');
    P = await props();
    assert.equal(P.get(qIn.pid).ref, 's1/p10'); assert.ok(!P.get(qIn.pid).lost, '글이 그대로 돌아왔으니 되살린다');
    assert.equal((await act(qIn.pid, 'apply')).status, 'applied');

    // 표가 든 절을 지운 뒤 문서가 바뀌어도 되돌리면 표가 돌아온다(지우기 직전 사본의 문단 XML 을 그대로 다시 넣음 — engine insertParagraphsFrom)
    const del2 = await post({ type: 'para_delete', ref: 's1/p55', toRef: 's1/p60' });
    await act(del2.pid, 'apply');
    const other = await post({ ref: 's1/p57', find: '종합', replace: '종합(요약)' });   // 지운 뒤 주소: 옛 p63 '(종합) …'
    assert.equal((await act(other.pid, 'apply')).status, 'applied');
    await act(del2.pid, 'undo');
    f = await file();
    assert.equal(bodyTexts(f, 1).length, T.length);
    assert.deepEqual(f.ownObjects('s1/p59').map((o) => o.name), ['표']);
    assert.equal(tableXml(f, 's1/p59'), tableXml(orig, 's1/p59'), '돌아온 표 = 원본 XML 그대로');
    assert.equal(f.text('s1/p55', 'final'), T[55]);

    // T09: '4) 학기 유형별 재수강' 절(p55..p60)을 '3) 소속대학별 …'(p47) 앞으로 — XML 그대로, 안의 대기 제안은 따라간다
    f = await file();
    const T3 = bodyTexts(f, 1);
    const t59 = tableXml(f, 's1/p59');
    const qMove = await post({ ref: 's1/p56', find: '(학기 유형)', replace: '(학기 종류)' });
    const mv = await post({ type: 'para_move', ref: 's1/p55', toRef: 's1/p60', beforeRef: 's1/p47', reason: '절 순서' });
    assert.deepEqual([mv.afterRef, mv.paras.dest.before, mv.paras.dest.beforeText], ['s1/p46', true, '3) 소속대학별 재수강 현황(RQ2)']);
    const am = await act(mv.pid, 'apply');
    assert.deepEqual([am.insertedRef, am.extraRefs, am.ref], ['s1/p47', ['s1/p48', 's1/p49', 's1/p50', 's1/p51', 's1/p52'], 's1/p60']);
    f = await file();
    assert.deepEqual(bodyTexts(f, 1), movedList(T3, 55, 60, 46));
    assert.equal(tableXml(f, 's1/p51'), t59, '옮긴 표는 원본 XML 그대로');
    P = await props();
    assert.deepEqual([P.get(qMove.pid).ref, !!P.get(qMove.pid).lost], ['s1/p48', false], '옮긴 문단의 제안은 따라간다');
    assert.equal((await act(qMove.pid, 'apply')).status, 'applied');
    // 되돌리기 = 거꾸로 옮김(그 사이 고친 글은 그대로 따라 돌아간다)
    await act(mv.pid, 'undo');
    f = await file();
    assert.deepEqual(bodyTexts(f, 1), T3.map((t, i) => (i === 56 ? t.replace('(학기 유형)', '(학기 종류)') : t)));
    assert.equal(tableXml(f, 's1/p59'), t59);
    P = await props();
    assert.equal(P.get(mv.pid).ref, 's1/p55');
    assert.equal(P.get(qMove.pid).ref, 's1/p56');
  } finally { await srv.stop(); }
});

test('서버(변경 추적 문서): 지우기 = 글·개체 지움 + 앞 문단 끝 나눔 지움, 옮기기 = 지움 + 넣음(표 원본 XML), 모두 수락하면 기대 결과, 되돌리기 = 거절', { timeout: 180000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const orig = await HwpxDoc.load(fs.readFileSync(PRACTICE));
    const T = bodyTexts(orig, 1);
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), '연습 보고서.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const file = async (kind = 'working') => HwpxDoc.load(await A(`${D}/file?kind=${kind}`));
    const props = async () => new Map((await A(`${D}/proposals`)).map((p) => [p.pid, p]));
    const post = (body) => A(`${D}/proposals`, { method: 'POST', body });
    const act = (pid, what) => A(`${D}/proposals/${pid}/${what}`, { method: 'POST' });
    await A(`${D}/settings`, { method: 'PATCH', body: { track: 'tracked' } });

    // T10(표 없는 절) — 문단 6개: 글 지움(빈 문단 p7 앞 나눔은 BREAK_TRACK a꼴 규칙이 정한다) + 나눔 지움 6
    const qIn = await post({ ref: 's1/p11', find: 'RQ2', replace: '질문 2' });
    const del = await post({ type: 'para_delete', ref: 's1/p8', toRef: 's1/p13' });
    const ap = await act(del.pid, 'apply');
    assert.ok(ap.changeIds.length >= 12, `변경 ${ap.changeIds.length}건`);
    let tr = await file('tracked');
    assert.deepEqual(bodyTexts(tr, 1), without(T, 8, 13), '최종 보기에서는 절이 없다');
    const ch = tr.changes();
    assert.equal(ch.filter((c) => c.kind === 'para' && c.type === 'Delete').length, 6, '지운 문단 나눔 6');
    assert.ok(ch.filter((c) => !c.kind && c.type === 'Delete').length >= 6, '지운 글(문단마다 하나 이상 — 부호가 끼면 조각으로 나뉜다)');
    assert.equal((await file()).changes().length, 0, '작업본(최종본)에는 표식이 없다');
    // 모두 수락하면 절이 통째로 없어진다(빈 문단 0)
    tr.acceptAll();
    const acc = await HwpxDoc.load(await tr.save());
    assert.deepEqual(bodyTexts(acc, 1), without(T, 8, 13));
    assert.equal(acc.sections[1].bodyParas.length, T.length - 6);
    assert.equal((await props()).get(qIn.pid).lost, true);
    // 되돌리기 = 거절 → 처음 글, 잃은 제안 되살림
    await act(del.pid, 'undo');
    tr = await file('tracked');
    assert.equal(tr.changes().length, 0);
    assert.deepEqual(bodyTexts(tr, 1), T);
    let P = await props();
    assert.deepEqual([P.get(qIn.pid).ref, !!P.get(qIn.pid).lost], ['s1/p11', false]);

    // T09(표가 든 절) — 원래 자리는 지움 표식(표는 '표 지움'), 새 자리는 넣음(표는 원본 XML 을 새 id 로 — '표 넣음')
    const t59 = tableXml(orig, 's1/p59');
    const qMv = await post({ ref: 's1/p56', find: '(학기 유형)', replace: '(학기 종류)' });
    const mv = await post({ type: 'para_move', ref: 's1/p55', toRef: 's1/p60', afterRef: 's1/p46' });
    const am = await act(mv.pid, 'apply');
    assert.deepEqual([am.insertedRef, am.extraRefs.length, am.ref], ['s1/p47', 5, 's1/p60']);
    tr = await file('tracked');
    assert.deepEqual(bodyTexts(tr, 1), movedList(T, 55, 60, 46), '최종 보기 = 옮긴 차례');
    const kinds = tr.changes().map((c) => `${c.type}:${c.kind || 'text'}`);
    assert.ok(kinds.includes('Delete:object') || kinds.some((k) => /Delete:(object|mixed)/.test(k)), kinds.join(','));
    assert.ok(kinds.some((k) => /Insert:(object|mixed)/.test(k)), '표 넣음');
    assert.equal(kinds.filter((k) => k === 'Insert:para').length, 6, '넣은 문단 나눔 6');
    assert.equal(kinds.filter((k) => k === 'Delete:para').length, 6, '지운 문단 나눔 6');
    const noRefs = (x) => stripIds(x).replace(/charPrIDRef="\d+"/g, '');
    tr.acceptAll();
    const acc2 = await HwpxDoc.load(await tr.save());
    assert.deepEqual(bodyTexts(acc2, 1), movedList(T, 55, 60, 46), '모두 수락 = 옮긴 차례, 빈 문단 0');
    assert.equal(noRefs(tableXml(acc2, 's1/p51')), noRefs(t59), '수락한 표 = 원본 표 XML(id·글자 모양 번호만 다를 수 있다)');
    assert.equal(acc2.changes().length, 0);
    P = await props();
    // 2026-11-17 L1: 예전에는 원래 문단(지움 표시로 남은 쪽)을 가리켜 잃었다 — 이제 '고친 글만'처럼 새 자리 사본(옛 p56 → p48)으로 따라간다
    assert.deepEqual([P.get(qMv.pid).ref, !!P.get(qMv.pid).lost], ['s1/p48', false], '변경 추적 문서에서도 옮긴 문단의 대기 제안은 새 자리 사본으로 따라간다');
    await act(mv.pid, 'undo');
    tr = await file('tracked');
    assert.equal(tr.changes().length, 0);
    assert.deepEqual(bodyTexts(tr, 1), T);
    assert.equal(tableXml(tr, 's1/p59'), t59, '거절하면 원래 표 XML 그대로');
    P = await props();
    assert.deepEqual([P.get(qMv.pid).ref, !!P.get(qMv.pid).lost], ['s1/p56', false]);
    assert.equal((await act(qMv.pid, 'apply')).status, 'applied');

    // 승인 방식 문서(review)도 변경 추적으로 남긴다
    await A(`${D}/settings`, { method: 'PATCH', body: { editMode: 'review' } });
    const del3 = await post({ type: 'para_delete', ref: 's1/p67', toRef: 's1/p73' });
    await srv.api('admin')(`${D}/proposals/${del3.pid}/apply`, { method: 'POST' });   // 승인 방식은 '기준에 바로 적용'이 관리자만
    tr = await file('tracked');
    assert.deepEqual(bodyTexts(tr, 1).slice(-1), [T[66]], '참고문헌 절이 최종 보기에서 없어진다');
    assert.ok(tr.changes().filter((c) => c.kind === 'para').length >= 7);
  } finally { await srv.stop(); }
});

test('새 연결 op: 꼴·작은 안내(OPS_BRIEF·replace 글)·막는 경우의 오류 글·작업 기록 줄·메모 글', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  assert.match(OPS_BRIEF, /delete_paragraphs/); assert.match(OPS_BRIEF, /move_paragraphs/);
  assert.ok(!/문단을 지우는 op 는 없다/.test(OPS_BRIEF), 'replace 꼴의 옛 글을 고쳤다');
  const parsed = parseOps([
    { op: 'delete_paragraphs', at: 's1/p8..p13', reason: '절 삭제' },
    { op: 'move_paragraphs', at: 's1/p55..s1/p60', before: 's1/p47' },
    { op: 'delete_paragraphs', at: ['s1/p65', 's1/p64'] },
  ]);
  assert.equal(parsed.errors.length, 0);
  const prep = prepareOps(d, parsed.ok);
  assert.deepEqual(prep.errors, []);
  assert.deepEqual(prep.steps[0].items.map((x) => [x.input.type, x.input.ref, x.input.toRef, x.input.beforeRef ?? null]),
    [['para_delete', 's1/p8', 's1/p13', null], ['para_move', 's1/p55', 's1/p60', 's1/p47'], ['para_delete', 's1/p64', 's1/p65', null]]);
  assert.match(prep.previews[0].preview, /^문단 6개를 지운다\(s1\/p8\.\.p13: 「2\) 분석 질문」 · 「이 분석은/);
  assert.match(prep.previews[0].preview, /결과: 「\(빈 줄\)」 다음에 「2\. 분석 기준」/);
  const errs = (ops) => prepareOps(d, parseOps(ops).ok).errors.map((e) => e.error).join('\n') || parseOps(ops).errors.map((e) => e.error).join('\n');
  assert.match(errs([{ op: 'delete_paragraphs', at: 's1/p0..p3' }]), /구역의 첫 문단.*replace\(whole:true/);
  assert.match(errs([{ op: 'delete_paragraphs', at: 's1' }]), /구역 전체/);
  assert.match(errs([{ op: 'delete_paragraphs', at: 's1/p17/n0' }]), /본문 문단만/);
  assert.match(errs([{ op: 'delete_paragraphs', at: ['s1/p8', 's1/p10'] }]), /떨어진 문단/);
  assert.match(errs([{ op: 'delete_paragraphs', at: 's0/p5..s1/p2' }]), /구역을 넘/);
  assert.match(errs([{ op: 'move_paragraphs', at: 's1/p55..p60' }]), /after\(그 문단 뒤\) 또는 before/);
  assert.match(errs([{ op: 'move_paragraphs', at: 's1/p55..p60', after: 's1/p58' }]), /범위 s1\/p55\.\.p60 안/);
  assert.match(errs([{ op: 'move_paragraphs', at: 's1/p55..p60', after: 's0/p3' }]), /같은 구역 안에서만/);
  assert.match(errs([{ op: 'delete_paragraphs', at: 's1/p8..p13', bogus: 1 }]), /꼴: \{op:'delete_paragraphs'/);
  // 작업 기록 줄·메모 글
  assert.equal(activityItem('edit', { ops: [{ op: 'delete_paragraphs' }, { op: 'move_paragraphs' }, { op: 'move_paragraphs' }] }).label, '문단 지우기 · 문단 옮기기 2');
  const p = { pid: 4, type: 'para_move', by: author, status: 'pending', ref: 's1/p55', paras: { count: 6, first: ['4) 학기 유형별 재수강'], dest: { ref: 's1/p46', text: '(빈 줄)', before: true, beforeText: '3) 소속대학별 재수강 현황(RQ2)' } }, log: [] };
  assert.equal(MT.paragraphsSummary(p), '문단 6개 「4) 학기 유형별 재수강」 부터 옮기기 → 「3) 소속대학별 재수강 현황(RQ2)」 앞');
  assert.match(MT.renderProposalMemo(p), /^\[제안 4 · 문단 옮기기\]/);
  assert.equal(MT.paragraphsSummary({ type: 'para_delete', paras: { count: 1, first: ['RQ1'] } }), '문단 1개 「RQ1」 지우기');
  // 카드 자리(web/proposal-place.js): 대기 = 고른 범위, 옮기기 반영 = 옮겨 간 문단, 지우기 반영 = 지운 자리 앞 문단
  assert.deepEqual(proposalPlace({ type: 'para_delete', status: 'pending', ref: 's1/p8', paras: { count: 6 } }), { ref: 's1/p8', endRef: 's1/p13', after: false, gone: false, count: 6 });
  assert.deepEqual(proposalPlace({ type: 'para_delete', status: 'applied', ref: 's1/p7', paras: { count: 6 } }), { ref: 's1/p7', endRef: null, after: true, gone: false, count: 6 });
  assert.deepEqual(proposalPlace({ ...p, status: 'applied', ref: 's1/p60', insertedRef: 's1/p47', extraRefs: ['s1/p48', 's1/p52'] }), { ref: 's1/p47', endRef: 's1/p52', after: false, gone: false, count: 3 });
  assert.equal(proposalPlace({ type: 'para_move', status: 'pending', ref: 's1/p55', lost: true, paras: { count: 6 } }).gone, true);
});

test('새 연결 edit: 미리 해 보기(preview)·저장 영수증·완료 → 반영하면 빈 문단 0', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), '연습 보고서.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    await A(`${D}/settings`, { method: 'PATCH', body: { aiMemo: 'detail' } });   // 작업 기록 메모에 반영 목록까지
    const client = new Client({ name: 'para-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?v=2&tools=core`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
    await client.connect(transport); open.push(async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); });
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map((c) => c.text).join('\n'); assert.ok(!r.isError, t); return JSON.parse(t); };
    const req = (await A(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: "'2) 분석 질문' 절을 통째로 지우고 '4)' 절을 '3)' 절 앞으로", target: { ref: 's1/p8' } } })).request;
    const brief = await call('task', { doc_id: doc.id, request_id: req.rid });
    const ids = { doc_id: doc.id, request_id: req.rid, expected_attempt: brief.attempt };
    // 한 호출에 지우기·옮기기와 다른 op(뒤 문단 바꿈·사이 문단 뒤 넣기)를 함께 — 주소는 모두 지금(반영 전) 문서 기준
    const ops = [{ op: 'delete_paragraphs', at: 's1/p8..p13' }, { op: 'move_paragraphs', at: 's1/p55..p60', before: 's1/p47' },
      { op: 'replace', at: 's1/p20', find: '29,821명', with: '29,821명(전체)' }, { op: 'insert', after: 's1/p62', text: '새 종합 문단' }];
    const dry = await call('edit', { ...ids, ops, dry_run: true });
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.preview.map((x) => x.op), [0, 1]);
    assert.match(dry.preview[1].preview, /문단 6개를 옮긴다.*그다음 「3\) 소속대학별/);
    // 사본에서 두 제안을 만들어 반영해 본다(server/page-estimate — 한도 안일 때): 실패 없음
    if (dry.made != null) assert.ok(dry.made === 4 && !dry.failed && !(dry.pages?.apply_failed || []).length, JSON.stringify(dry));
    assert.equal((await A(`${D}/proposals`)).length, 0, '미리 해 보기는 저장하지 않는다');
    const saved = await call('edit', { ...ids, ops, done: '절 하나를 지우고 절 하나를 옮기도록 제안했습니다.' });
    assert.equal(saved.completed, true, JSON.stringify(saved));
    assert.deepEqual(saved.saved.map((x) => [x.op, x.ref]), [[0, 's1/p8'], [1, 's1/p55'], [2, 's1/p20'], [3, 's1/p62']]);
    const props = await A(`${D}/proposals`);
    assert.deepEqual(props.map((p) => p.type), ['para_delete', 'para_move', 'replace', 'insert']);
    // [모두 반영](resolveRequest apply 'rest' — _orderedApplier): 제안 번호 차례로, 앞 반영에 따라 뒤 제안 주소가 다시 매겨진다
    const res = await A(`${D}/requests/${req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
    assert.ok(res.results.every((r) => r.ok), JSON.stringify(res.results));
    const f = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    let want = T.map((t, i) => ({ i, t: i === 20 ? t.replace('29,821명', '29,821명(전체)') : t }));
    want.splice(63, 0, { i: 62.5, t: '새 종합 문단' });
    want = want.filter((x) => x.i < 8 || x.i > 13);
    const block = want.filter((x) => x.i >= 55 && x.i <= 60); want = want.filter((x) => !(x.i >= 55 && x.i <= 60));
    want.splice(want.findIndex((x) => x.i === 47), 0, ...block);
    assert.deepEqual(bodyTexts(f, 1), want.map((x) => x.t));
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === req.rid);
    assert.match(memo.text, /문단 6개 「2\) 분석 질문」 부터 지우기/);
  } finally { for (const c of open) await c(); await srv.stop(); }
});

test('메모가 든 문단: 고친 글만은 문단째 지우고(되돌리면 메모도 돌아옴), 변경 추적은 지운 글에 메모가 남는다 · 옮기기는 메모가 따라간다', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    for (const track of ['final', 'tracked']) {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), `메모-${track}.hwpx`);
      const D = `/api/docs/${doc.id}`;
      await A(`${D}/settings`, { method: 'PATCH', body: { track } });
      await A(`${D}/memos`, { method: 'POST', body: { ref: 's1/p9', find: '네 가지 질문', text: '지울 문단의 메모' } });
      await A(`${D}/memos`, { method: 'POST', body: { ref: 's1/p56', find: '계절학기', text: '옮길 문단의 메모' } });
      const memoRefs = async () => Object.fromEntries((await A(`${D}/memos`)).filter((m) => /의 메모$/.test(m.text)).map((m) => [m.text, m.ref]));
      const del = await A(`${D}/proposals`, { method: 'POST', body: { type: 'para_delete', ref: 's1/p8', toRef: 's1/p13' } });
      await A(`${D}/proposals/${del.pid}/apply`, { method: 'POST' });
      const after = await memoRefs();
      if (track === 'final') assert.equal(after['지울 문단의 메모'], undefined, '문단째 지우면 메모도 없어진다(한/글도 메모가 든 글을 지우면 메모가 사라진다)');
      else assert.ok(after['지울 문단의 메모'], '변경 추적: 지운 글에 메모가 남는다');
      assert.equal(after['옮길 문단의 메모'], 's1/p50');
      const mv = await A(`${D}/proposals`, { method: 'POST', body: { type: 'para_move', ref: 's1/p49', toRef: 's1/p54', afterRef: 's1/p40' } });
      await A(`${D}/proposals/${mv.pid}/apply`, { method: 'POST' });
      if (track === 'final') assert.equal((await memoRefs())['옮길 문단의 메모'], 's1/p42', '고친 글만: XML 그대로 옮겨 메모가 따라간다');
      await A(`${D}/proposals/${mv.pid}/undo`, { method: 'POST' });
      await A(`${D}/proposals/${del.pid}/undo`, { method: 'POST' });
      const back = await memoRefs();
      assert.deepEqual(back, { '지울 문단의 메모': 's1/p9', '옮길 문단의 메모': 's1/p56' }, track);
      const f = await HwpxDoc.load(await A(`${D}/file?kind=working`));
      assert.deepEqual(bodyTexts(f, 1), bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1));
    }
  } finally { await srv.stop(); }
});

test('그림 문단(고친 글만): 지우면 그림 파일도 거두고, 그 뒤 문서가 바뀐 채 되돌리면 그림 파일까지 돌아온다', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const orig = await HwpxDoc.load(fs.readFileSync(PRACTICE));
    const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), '그림.hwpx');
    const D = `/api/docs/${doc.id}`;
    const fig = orig.figures().find((x) => x.ref === 's1/p53');
    assert.ok(fig?.binId, '연습 보고서 s1/p53 에 그림');
    const del = await A(`${D}/proposals`, { method: 'POST', body: { type: 'para_delete', ref: 's1/p52', toRef: 's1/p54' } });
    await A(`${D}/proposals/${del.pid}/apply`, { method: 'POST' });
    let f = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.equal(f.figures().length, orig.figures().length - 1);
    const q = await A(`${D}/proposals`, { method: 'POST', body: { ref: 's1/p1', find: '가상의', replace: '가상(연습)의' } });
    await A(`${D}/proposals/${q.pid}/apply`, { method: 'POST' });
    await A(`${D}/proposals/${del.pid}/undo`, { method: 'POST' });
    f = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    const back = f.figures().find((x) => x.ref === 's1/p53');
    assert.ok(back, '그림이 제자리로');
    assert.deepEqual(Buffer.from(f.binaryItem(back.binId).bytes), Buffer.from(orig.binaryItem(fig.binId).bytes), '그림 파일 바이트 그대로');
    assert.deepEqual(bodyTexts(f, 1).slice(2), bodyTexts(orig, 1).slice(2));
  } finally { await srv.stop(); }
});

test('뒤로 옮기기(after 가 범위 뒤): 변경 추적·고친 글만 모두 차례가 맞고 되돌리면 처음으로', { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    for (const track of ['tracked', 'final']) {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), `뒤로-${track}.hwpx`);
      const D = `/api/docs/${doc.id}`;
      await A(`${D}/settings`, { method: 'PATCH', body: { track } });
      const q = await A(`${D}/proposals`, { method: 'POST', body: { ref: 's1/p25', find: '주분석', replace: '주 분석' } });   // 범위와 자리 사이
      const mv = await A(`${D}/proposals`, { method: 'POST', body: { type: 'para_move', ref: 's1/p19', toRef: 's1/p22', afterRef: 's1/p29' } });
      const am = await A(`${D}/proposals/${mv.pid}/apply`, { method: 'POST' });
      assert.deepEqual([am.insertedRef, am.extraRefs, am.ref], ['s1/p26', ['s1/p27', 's1/p28', 's1/p29'], 's1/p18'], track);
      const f = await HwpxDoc.load(await A(`${D}/file?kind=${track === 'tracked' ? 'tracked' : 'working'}`));
      assert.deepEqual(bodyTexts(f, 1), movedList(T, 19, 22, 29), track);
      const P = new Map((await A(`${D}/proposals`)).map((x) => [x.pid, x]));
      assert.equal(P.get(q.pid).ref, 's1/p21', '범위와 자리 사이 문단 제안은 4 당겨진다');
      if (track === 'tracked') { f.acceptAll(); assert.deepEqual(bodyTexts(await HwpxDoc.load(await f.save()), 1), movedList(T, 19, 22, 29)); }
      await A(`${D}/proposals/${mv.pid}/undo`, { method: 'POST' });
      const g = await HwpxDoc.load(await A(`${D}/file?kind=${track === 'tracked' ? 'tracked' : 'working'}`));
      assert.deepEqual(bodyTexts(g, 1), T, track);
      assert.equal(g.changes().length, 0);
      assert.equal(new Map((await A(`${D}/proposals`)).map((x) => [x.pid, x])).get(q.pid).ref, 's1/p25');
    }
  } finally { await srv.stop(); }
});

// ─── 2026-11-17 L1: 같은 요청의 범위 안 글 제안과 함께 반영(실제 Codex 실험 X02 — artifacts/mcp-round3-20261117/codex/REPORT.md 문제 1) ───
// 모델이 한 edit 에 replace(s1/p39 '2) 재수강…'→'1) …') · replace(s1/p31 '1) 표본…'→'2) …') · move_paragraphs(s1/p31..p38 → s1/p46 뒤)를 냈다.
// 예전에는 replace 가 먼저 반영되면 옮기기가 STALE('옮길 문단(s1/p31)이 바뀌었습니다'). 문서 모드 셋 × 반영 차례 셋에서 모두 되어야 한다.
const MODES = {
  final: { track: 'final' },               // 실시간 '고친 글만'(기본)
  tracked: { track: 'tracked' },           // 실시간 '변경 추적으로'
  review: { editMode: 'review' },          // 승인 방식
};
const x02Want = (T) => movedList(T.map((s, i) => (i === 31 ? s.replace('1) 표본', '2) 표본') : i === 39 ? s.replace('2) 재수강', '1) 재수강') : s)), 31, 38, 46);

/** 연습 보고서 사본을 올리고 모드를 맞춘 뒤 요청 하나 + 제안 셋(X02 꼴 — del 이면 옮기기 대신 같은 범위 지우기) */
async function x02Setup(srv, mode, { del = false } = {}) {
  const A = srv.api('a'); const M = srv.api('admin');
  const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), `x02-${mode}-${Math.random().toString(36).slice(2, 7)}.hwpx`);
  const D = `/api/docs/${doc.id}`;
  await A(`${D}/settings`, { method: 'PATCH', body: MODES[mode] });
  const req = (await A(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '1) 절을 2) 절 뒤로 옮기고 번호를 고쳐 주세요', target: { ref: 's1/p31' } } })).request;
  const post = (body) => A(`${D}/proposals`, { method: 'POST', body: { rid: req.rid, ...body } });
  const r1 = await post({ ref: 's1/p39', find: '2) 재수강 후 성적 개선(RQ1)', replace: '1) 재수강 후 성적 개선(RQ1)' });
  const r2 = await post({ ref: 's1/p31', find: '1) 표본 특성과 재수강 현황', replace: '2) 표본 특성과 재수강 현황' });
  const mv = await post(del ? { type: 'para_delete', ref: 's1/p31', toRef: 's1/p38' } : { type: 'para_move', ref: 's1/p31', toRef: 's1/p38', afterRef: 's1/p46' });
  assert.deepEqual([r1.rid, r2.rid, mv.rid], [req.rid, req.rid, req.rid]);
  const kind = mode === 'final' ? 'working' : 'tracked';
  return {
    id: doc.id, D, A, M, req, pids: [r1.pid, r2.pid, mv.pid],
    file: async () => HwpxDoc.load(await M(`${D}/file?kind=${kind}`)),
    props: async () => new Map((await M(`${D}/proposals`)).map((p) => [p.pid, p])),
    act: (pid, what) => M.res(`${D}/proposals/${pid}/${what}`, { method: 'POST' }),
  };
}

test('X02: 절 제목 번호 바꾸기 + 그 절 옮기기 — 문서 모드 셋 × [모두 반영]·번호 차례·옮기기 먼저 모두 된다', { timeout: 300000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    assert.deepEqual([T[31], T[39], T[47]], ['1) 표본 특성과 재수강 현황', '2) 재수강 후 성적 개선(RQ1)', '3) 소속대학별 재수강 현황(RQ2)']);
    const want = x02Want(T);
    for (const mode of Object.keys(MODES)) {
      for (const order of ['all', 'pid', 'moveFirst']) {
        const s = await x02Setup(srv, mode);
        const tag = `${mode}/${order}`;
        if (order === 'all') {
          const res = await s.M(`${s.D}/requests/${s.req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
          assert.ok(res.results.length === 3 && res.results.every((r) => r.ok), `${tag} ${JSON.stringify(res.results)}`);
        } else if (mode === 'review' && order === 'moveFirst') {
          // 승인 방식은 처리 안 된 변경 추적(여기서는 옮긴 사본의 '넣음') 안의 글을 고치지 않는다 — 사람이 먼저 수락·거절(예전부터의 OVERLAP 규칙,
          // service._trackedRetry 는 실시간 '변경 추적으로'만 겹친 변경을 수락하고 다시 한다). 그래도 replace 는 사본으로 따라가 있다(lost 아님)
          for (const pid of [s.pids[2], s.pids[0]]) assert.ok((await s.act(pid, 'apply')).ok, tag);
          const q = (await s.props()).get(s.pids[1]);
          assert.deepEqual([q.ref, !!q.lost], ['s1/p39', false], `${tag} 사본으로 따라감`);
          const r = await s.act(s.pids[1], 'apply');
          assert.equal(r.status, 400, tag); assert.match(JSON.stringify(r.data), /OVERLAP/, tag);
          assert.deepEqual(bodyTexts(await s.file(), 1), movedList(T.map((x, i) => (i === 39 ? x.replace('2) 재수강', '1) 재수강') : x)), 31, 38, 46), tag);
          continue;
        } else {
          const seq = order === 'pid' ? s.pids : [s.pids[2], s.pids[0], s.pids[1]];
          for (const pid of seq) { const r = await s.act(pid, 'apply'); assert.ok(r.ok, `${tag} #${pid} ${JSON.stringify(r.data)}`); }
        }
        const f = await s.file();
        assert.deepEqual(bodyTexts(f, 1), want, tag);
        if (mode !== 'final') {
          f.acceptAll();
          assert.deepEqual(bodyTexts(await HwpxDoc.load(await f.save()), 1), want, `${tag} 모두 수락`);
        }
        const P = await s.props();
        assert.ok(s.pids.every((pid) => P.get(pid).status === 'applied'), tag);
        assert.equal(P.get(s.pids[2]).insertedRef, 's1/p39', `${tag} 옮긴 절 첫 문단`);
      }
    }
  } finally { await srv.stop(); }
});

test('X02 꼴의 막는 경우·되돌리기: 사람 편집·다른 요청의 변경은 여전히 STALE, 글 제안을 되돌리면 지문도 돌아온다', { timeout: 240000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    const stale = (r, tag) => { assert.equal(r.status, 409, `${tag} ${JSON.stringify(r.data)}`); assert.match(JSON.stringify(r.data), /STALE/, tag); };
    // ① 사람이 범위 안(p33)을 실시간으로 고친 뒤(고친 글만 — PUT /live, server/live.js) 같은 요청의 replace 를 반영해도 옮기기는 STALE
    {
      const s = await x02Setup(srv, 'final');
      const info = await s.A(`/api/docs/${s.id}`);
      const d = await HwpxDoc.load(await s.A(`${s.D}/file?kind=working`));
      d.replaceTracked('s1/p33', 1, 3, '풀이', { author: '사람' }); d.acceptAll();
      const version = info.version ?? info.meta?.version ?? info.doc?.version ?? 1;
      const put = await fetch(`${srv.base}/api/docs/${s.id}/live?base=${version}&seq=501`, { method: 'PUT', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/octet-stream' }, body: await d.save() });
      assert.ok(put.ok, `live ${put.status} ${await put.text()}`);
      assert.match((await s.file()).text('s1/p33', 'final'), /^\(풀이\)/, '사람 편집이 들어갔다');
      assert.ok((await s.act(s.pids[1], 'apply')).ok);
      stale(await s.act(s.pids[2], 'apply'), '사람 편집 뒤');
    }
    // ② 다른 요청의 제안(범위 안 p32)을 반영한 뒤 — STALE. 요청 없는 다른 사람 제안도 같다
    for (const other of ['request', 'none']) {
      const s = await x02Setup(srv, 'final');
      const rid = other === 'request' ? (await s.A(`${s.D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '숫자 고치기', target: { ref: 's1/p32' } } })).request.rid : undefined;
      const q = await (other === 'request' ? s.A : srv.api('b'))(`${s.D}/proposals`, { method: 'POST', body: { ref: 's1/p32', find: '21,135명', replace: '21,136명', ...(rid ? { rid } : {}) } });
      assert.ok((await s.act(q.pid, 'apply')).ok);
      assert.ok((await s.act(s.pids[1], 'apply')).ok);
      stale(await s.act(s.pids[2], 'apply'), `다른 ${other}`);
    }
    // ③ 되돌리기: 범위 안 replace 반영 → 되돌림 → 옮기기(제안 때 글 그대로라 된다) → 그 replace 다시 열어 옮긴 자리에서 반영
    for (const mode of Object.keys(MODES)) {
      const s = await x02Setup(srv, mode);
      assert.ok((await s.act(s.pids[1], 'apply')).ok);
      let P = await s.props();
      assert.equal(P.get(s.pids[2]).paras.first[0], '2) 표본 특성과 재수강 현황', `${mode} 카드 첫 글도 새 글로`);
      assert.ok((await s.act(s.pids[1], 'undo')).ok, mode);
      P = await s.props();
      assert.equal(P.get(s.pids[2]).paras.first[0], '1) 표본 특성과 재수강 현황', `${mode} 되돌리면 카드 첫 글도 돌아온다`);
      const r = await s.act(s.pids[2], 'apply'); assert.ok(r.ok, `${mode} ${JSON.stringify(r.data)}`);
      assert.deepEqual(bodyTexts(await s.file(), 1), movedList(T, 31, 38, 46), mode);
      const ro = await s.act(s.pids[1], 'reopen'); assert.ok(ro.ok, `${mode} reopen ${JSON.stringify(ro.data)}`);
      P = await s.props();
      assert.deepEqual([P.get(s.pids[1]).status, P.get(s.pids[1]).ref, !!P.get(s.pids[1]).lost], ['pending', 's1/p39', false], `${mode} 되돌린 replace 도 옮긴 자리로`);
      if (mode === 'review') continue;   // 승인 방식은 사본('넣음' 처리 전) 안 글을 고치지 않는다(위 시험의 OVERLAP 규칙)
      assert.ok((await s.act(s.pids[1], 'apply')).ok, mode);
      assert.ok((await s.act(s.pids[0], 'apply')).ok, mode);
      assert.deepEqual(bodyTexts(await s.file(), 1), x02Want(T), `${mode} 옮긴 뒤 번호`);
    }
  } finally { await srv.stop(); }
});

test('지우기 꼴(delete_paragraphs + 범위 안 replace): 차례와 상관없이 지우기가 되고, 지우기 먼저면 그 replace 는 lost', { timeout: 240000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    const want = without(T.map((s, i) => (i === 39 ? s.replace('2) 재수강', '1) 재수강') : s)), 31, 38);
    for (const mode of Object.keys(MODES)) {
      for (const order of ['all', 'pid', 'deleteFirst']) {
        const s = await x02Setup(srv, mode, { del: true });
        const tag = `${mode}/${order}`;
        if (order === 'all') {
          const res = await s.M(`${s.D}/requests/${s.req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
          assert.ok(res.results.every((r) => r.ok), `${tag} ${JSON.stringify(res.results)}`);
        } else if (order === 'pid') {
          for (const pid of s.pids) { const r = await s.act(pid, 'apply'); assert.ok(r.ok, `${tag} #${pid} ${JSON.stringify(r.data)}`); }
        } else {
          for (const pid of [s.pids[2], s.pids[0]]) assert.ok((await s.act(pid, 'apply')).ok, tag);
          assert.equal((await s.props()).get(s.pids[1]).lost, true, `${tag} 지운 문단의 replace 는 lost`);
          assert.equal((await s.act(s.pids[1], 'apply')).status, 409, tag);
        }
        const f = await s.file();
        assert.deepEqual(bodyTexts(f, 1), want, tag);
        if (mode !== 'final') { f.acceptAll(); assert.deepEqual(bodyTexts(await HwpxDoc.load(await f.save()), 1), want, `${tag} 모두 수락`); }
      }
    }
  } finally { await srv.stop(); }
});

test('변경 추적 문서에서 옮기기 먼저: 범위 안 표 칸·표를 가리키던 다른 사람 대기 제안도 사본(같은 꼬리)으로 따라가고, 되돌리면 원래 자리로', { timeout: 180000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    for (const mode of ['tracked', 'review']) {
      const s = await x02Setup(srv, mode);
      // 요청 없는 다른 사람 제안: 표 칸(s1/p35/n2) 글 바꾸기 · 표 고치기(표 열쇠 s1/p35#t0)
      const B = srv.api('b');
      const cell = await B(`${s.D}/proposals`, { method: 'POST', body: { ref: 's1/p35/n2', find: '분석 모집단', replace: '모집단' } });
      const te = await B(`${s.D}/proposals`, { method: 'POST', body: { type: 'table_edit', tableEdit: { table: 's1/p35#t0', ops: [{ op: 'border', sides: ['top', 'bottom'], line: { width_mm: 0.4 } }] } } });
      assert.equal(te.tableKey, 's1/p35#t0');
      const r = await s.act(s.pids[2], 'apply'); assert.ok(r.ok, `${mode} ${JSON.stringify(r.data)}`);
      let P = await s.props();
      assert.deepEqual([P.get(cell.pid).ref, !!P.get(cell.pid).lost], ['s1/p43/n2', false], `${mode} 칸 제안이 사본 표로`);
      assert.deepEqual([P.get(te.pid).ref, P.get(te.pid).tableKey, !!P.get(te.pid).lost], ['s1/p43', 's1/p43#t0', false], `${mode} 표 고치기도 사본 표로`);
      assert.deepEqual([P.get(s.pids[1]).ref, !!P.get(s.pids[1]).lost], ['s1/p39', false], `${mode} 같은 요청 replace 도 사본으로`);
      // 따라간 제안을 반영한 채로는 옮기기를 되돌리지 않는다 → 그 제안 되돌린 뒤 옮기기 되돌리기 → 원래 자리
      assert.ok((await s.act(cell.pid, 'apply')).ok, mode);
      let f = await s.file();
      assert.equal(f.tables().find((t) => t.key === 's1/p43#t0').cells.find((c) => c.refs[0] === 's1/p43/n2').text, '모집단', mode);
      const blocked = await s.act(s.pids[2], 'undo');
      assert.equal(blocked.status, 409, mode); assert.match(JSON.stringify(blocked.data), new RegExp(`제안 ${cell.pid}`));
      assert.ok((await s.act(cell.pid, 'undo')).ok, mode);
      assert.ok((await s.act(cell.pid, 'reopen')).ok, mode);
      const un = await s.act(s.pids[2], 'undo'); assert.ok(un.ok, `${mode} ${JSON.stringify(un.data)}`);
      P = await s.props();
      assert.deepEqual([P.get(cell.pid).ref, !!P.get(cell.pid).lost], ['s1/p35/n2', false], `${mode} 되돌리면 원래 칸`);
      assert.deepEqual([P.get(te.pid).tableKey, !!P.get(te.pid).lost], ['s1/p35#t0', false], mode);
      assert.deepEqual([P.get(s.pids[1]).ref, !!P.get(s.pids[1]).lost], ['s1/p31', false], mode);
      f = await s.file();
      assert.equal(f.changes().length, 0, mode);
      // 원래 자리에서 그대로 반영된다
      assert.ok((await s.act(cell.pid, 'apply')).ok, mode);
      assert.ok((await s.act(s.pids[1], 'apply')).ok, mode);
    }
  } finally { await srv.stop(); }
});

// ─── 2026-11-17 L3: 옮기기를 먼저 적은 edit(실제 Codex 실험 X07 꼴 — artifacts/mcp-round3-20261117/codex/X07/edit-calls.json) ───
// 승인 방식은 옮기기가 먼저 반영되면 사본('넣음') 안 replace 가 OVERLAP(위 X02 시험 review/moveFirst). server/mcp2/ops.js textBeforeMoves 가
// 범위 안 글 제안을 옮기기보다 먼저 만든다(더 작은 pid) — 영수증의 op 번호는 모델이 적은 그대로
test('edit 에 move_paragraphs 를 먼저, 그 범위 안 절 제목 replace 를 뒤에 — 문서 모드 셋 × [모두 반영] 모두 된다(범위 안 글 제안이 먼저 pid)', { timeout: 300000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  try {
    const T = bodyTexts(await HwpxDoc.load(fs.readFileSync(PRACTICE)), 1);
    const want = x02Want(T);
    const M = srv.api('admin');
    for (const mode of Object.keys(MODES)) {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), `x07-${mode}.hwpx`);
      const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
      await A(`${D}/settings`, { method: 'PATCH', body: MODES[mode] });
      const client = new Client({ name: 'para-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?v=2&tools=core`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
      await client.connect(transport); open.push(async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); });
      const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map((c) => c.text).join('\n'); assert.ok(!r.isError, t); return JSON.parse(t); };
      const req = (await A(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '1) 절을 2) 절 뒤로 옮기고 번호를 고쳐 주세요', target: { ref: 's1/p31' } } })).request;
      const brief = await call('task', { doc_id: doc.id, request_id: req.rid });
      const ops = [{ op: 'move_paragraphs', at: 's1/p31..p38', after: 's1/p46' },
        { op: 'replace', at: 's1/p31', find: '1) 표본 특성과 재수강 현황', with: '2) 표본 특성과 재수강 현황' },
        { op: 'replace', at: 's1/p39', find: '2) 재수강 후 성적 개선(RQ1)', with: '1) 재수강 후 성적 개선(RQ1)' }];
      const saved = await call('edit', { doc_id: doc.id, request_id: req.rid, expected_attempt: brief.attempt, ops });
      const pid = Object.fromEntries(saved.saved.map((x) => [x.op, x.pid]));
      assert.deepEqual(Object.keys(pid).map(Number), [0, 1, 2], `${mode} 영수증 op 번호는 적은 그대로 ${JSON.stringify(saved)}`);
      assert.ok(pid[1] < pid[0] && pid[0] < pid[2], `${mode} 범위 안 replace(op 1)가 옮기기(op 0)보다 먼저, 범위 밖 replace(op 2)는 뒤 그대로 ${JSON.stringify(pid)}`);
      assert.ok((saved.notes || []).some((n) => n.op === 0 && /ops\[1\] 뒤에 제안/.test(n.note)), `${mode} notes ${JSON.stringify(saved.notes)}`);
      const props = new Map((await M(`${D}/proposals`)).map((p) => [p.pid, p]));
      assert.deepEqual([props.get(pid[0]).type, props.get(pid[1]).type, props.get(pid[2]).type], ['para_move', 'replace', 'replace'], mode);
      const res = await M(`${D}/requests/${req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
      assert.ok(res.results.length === 3 && res.results.every((r) => r.ok), `${mode} ${JSON.stringify(res.results)}`);
      const f = await HwpxDoc.load(await M(`${D}/file?kind=${mode === 'final' ? 'working' : 'tracked'}`));
      assert.deepEqual(bodyTexts(f, 1), want, mode);
      if (mode !== 'final') { f.acceptAll(); assert.deepEqual(bodyTexts(await HwpxDoc.load(await f.save()), 1), want, `${mode} 모두 수락`); }
      const P = new Map((await M(`${D}/proposals`)).map((p) => [p.pid, p]));
      assert.ok(Object.values(pid).every((x) => P.get(x).status === 'applied'), mode);
      assert.equal(P.get(pid[0]).insertedRef, 's1/p39', `${mode} 옮긴 절 첫 문단`);
    }
  } finally { for (const c of open) await c(); await srv.stop(); }
});

test('textBeforeMoves: 넣기·줄바꿈 바꿈에서 멈추고 덩어리를 가르지 않으며, 지우기는 그대로', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  const prep = (ops) => { const p = parseOps(ops); assert.equal(p.errors.length, 0, JSON.stringify(p.errors)); const out = prepareOps(d, p.ok); assert.equal(out.errors.length, 0, JSON.stringify(out.errors)); return out; };
  const order = (out) => out.steps.flatMap((s) => (s.kind === 'proposals' ? s.items.map((it) => `${it.index}:${it.input.type}`) : [s.kind]));
  const mv = { op: 'move_paragraphs', at: 's1/p31..p38', after: 's1/p46' };
  const rp = (at, find, w) => ({ op: 'replace', at, find, with: w });
  // 범위 안 표 칸(중첩 주소)·서식(목록 at) 은 넘고, 그 op 의 제안 덩어리(목록 at 의 서식 둘)를 가르지 않는다. 메모 단계도 넘는다
  let out = prep([mv, rp('s1/p39', '2) 재수강', '1) 재수강'), { op: 'memo', at: 's1/p32', text: '확인' }, rp('s1/p35/n2', '분석 모집단', '모집단'), { op: 'format', at: ['s1/p31', 's1/p32'], char: { bold: true } }, rp('s1/p47', '소속대학별', '소속 대학별')]);
  assert.deepEqual(order(out), ['1:replace', 'memo', '3:replace', '4:format', '4:format', '0:para_move', '5:replace']);
  assert.ok(out.notes.some((n) => n.op === 0 && /ops\[3, 4\] 뒤에/.test(n.note)), JSON.stringify(out.notes));
  // 넣기에서 멈춘다(범위 안 넣기가 먼저면 범위가 갈라져 옮기기가 STALE) — 그 뒤 범위 안 replace 는 그대로 뒤
  out = prep([mv, { op: 'insert', after: 's1/p33', text: '새 문단' }, rp('s1/p31', '1) 표본', '2) 표본')]);
  assert.deepEqual(order(out), ['0:para_move', '1:insert', '2:replace']);
  assert.equal(out.notes.length, 0);
  // 줄바꿈이 든 replace(문단을 가른다)에서도 멈춘다
  out = prep([mv, rp('s1/p31', '1) 표본', '2) 표본\n덧붙임')]);
  assert.deepEqual(order(out), ['0:para_move', '1:replace']);
  // 지우기는 차례를 바꾸지 않는다
  out = prep([{ op: 'delete_paragraphs', at: 's1/p31..p38' }, rp('s1/p31', '1) 표본', '2) 표본')]);
  assert.deepEqual(order(out), ['0:para_delete', '1:replace']);
});
