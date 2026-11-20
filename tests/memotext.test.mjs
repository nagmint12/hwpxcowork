// 메모 글(server/memotext.js) 단위 시험 — docs/V3_SPEC.md §9.3(작업 기록 메모 — 요청마다 하나)·§9.2(해결 상태)·§9.4(복구 메모 두 꼴).
// 순수 함수만 부른다(서버·파일 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as MT from '../server/memotext.js';

const T0 = '2026-10-23T01:00:00.000Z';
const T1 = '2026-10-23T01:03:00.000Z';
const T2 = '2026-10-23T01:16:00.000Z';

let seq = 0;
/** 제안 하나(바꿈 기본). over 로 덮어쓴다 */
const P = (over = {}) => ({ pid: ++seq, type: 'replace', status: 'pending', by: '관리자(Claude Code)', ref: 's0/p1', find: '원문', replace: '고친 글', ...over });
/** 요청 하나 */
const R = (over = {}) => ({
  rid: 2, kind: 'instruct', label: '지시', by: '관리자', handledBy: 'Claude Code', status: 'done', summary: '회의록 표현 다듬기',
  instruction: '', options: { includeInstruction: false }, attachmentInfo: [], comments: [],
  log: [{ at: T0, by: '관리자', action: 'request', detail: '요청' }, { at: T1, by: '관리자(Claude Code)', action: 'done', detail: '완료' }],
  resolvedAt: null, resolvedBy: null, ...over,
});
const lines = (t) => t.split('\n');
const resultLine = (t) => lines(t).find((l) => l.startsWith('결과: ')) ?? null;
const listLines = (t) => lines(t).filter((l) => l.startsWith(' · '));

test('서식 제안과 반영 목록은 글 삭제가 아닌 서식 변경으로 표시한다', () => {
  const p = P({ type: 'format', find: '제목 보통 문장', replace: undefined, format: { char: { bold: false }, paragraph: { align: 'CENTER' } }, status: 'applied' });
  const proposal = MT.renderProposalMemo(p);
  assert.match(proposal, /서식 변경: 굵게 끔 · 가운데 정렬/);
  assert.match(proposal, /대상: 「제목 보통 문장」/);
  assert.ok(!proposal.includes('→'));
  const request = MT.renderRequestMemo(R(), [p]);
  assert.match(request, /「제목 보통 문장」 서식 변경: 굵게 끔 · 가운데 정렬/);
  assert.ok(!request.includes('→'));
  const rich = MT.renderProposalMemo(P({ format: { paragraph: { align: 'CENTER' } }, runs: [{ text: '고친', char: { bold: true } }, { text: ' 글', char: { bold: false } }] }));
  assert.match(rich, /→ 「고친 글」/);
  assert.match(rich, /서식: 가운데 정렬 \/ 「고친」 굵게 켬 \/ 「 글」 굵게 끔/);
});

test('작업 기록 메모: 반영한 것만 적고(문서 순서) 거절한 것·거절 수는 쓰지 않는다', () => {
  const INS = '이와 관련한 세부 추진 일정과 담당 부서는 별도 계획에 따라 정리함.';
  const props = [
    P({ ref: 's0/p5', find: '1억 원', replace: '1억 2천만 원', status: 'applied' }),
    P({ ref: 's0/p2', find: '사업 개요를', replace: '사업 개요와 배경을', status: 'rejected' }),
    P({ ref: 's0/p3', find: '3월부터', replace: '4월부터', status: 'pending' }),
    P({ type: 'insert', ref: 's0/p4', afterRef: 's0/p4', text: INS, status: 'applied' }),
    P({ type: 'table', ref: 's0/p1', afterRef: 's0/p1', table: { rows: [['구분', '2025'], ['학부', '1'], ['대학원', '2']], caption: '표. 응답률' }, status: 'applied' }),
    P({ ref: 's0/p0', find: '여기', replace: '이곳', status: 'undone' }),
  ];
  const t = MT.renderRequestMemo(R({ comments: ['memo9'] }), props);
  assert.equal(lines(t)[0], '[AI 작업 #2] 지시 · 요청 관리자 · 처리 Claude Code');
  assert.equal(lines(t)[1], '요약: 회의록 표현 다듬기');
  assert.equal(resultLine(t), '결과: 반영 3건 · 남은 제안 1건 · 의견 1건');
  assert.ok([...INS].length > 30);
  assert.deepEqual(listLines(t), [
    ' · 표 3×2 「표. 응답률」',
    ` · 문단 추가 「${[...INS].slice(0, 30).join('')}…」`,   // 앞 30자
    ' · 「1억 원」→「1억 2천만 원」',
  ]);
  assert.ok(!t.includes('거절') && !t.includes('사업 개요') && !t.includes('3월부터') && !t.includes('여기'), '거절·복구·남은 제안은 목록에 없다');
  // 표 캡션이 없으면 꺾쇠 없이
  const t2 = MT.renderRequestMemo(R(), [P({ type: 'table', table: { rows: [['a', 'b']] }, status: 'applied' })]);
  assert.deepEqual(listLines(t2), [' · 표 1×2']);
});

test('결과 줄: 반영한 제안 없음 · 의견만 · 남은 것 · 처리 중', () => {
  assert.equal(resultLine(MT.renderRequestMemo(R({ comments: ['m1'] }), [P({ status: 'rejected' }), P({ status: 'undone' })])), '결과: 반영한 제안 없음 · 의견 1건');
  assert.equal(resultLine(MT.renderRequestMemo(R({ comments: ['m1', 'm2'] }), [])), '결과: 의견 2건');
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'working' }), [P(), P()])), '결과: 남은 제안 2건');
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'cancelled' }), [P({ status: 'applied' }), P()])), '결과: 반영 1건 · 남은 제안 1건 (취소됨)');
});

test('결과 줄: 실패·취소·고칠 곳 없음·대기 중(줄 없음)', () => {
  const longErr = 'x'.repeat(80);
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'failed', error: longErr }), [])), `결과: 실패 — ${'x'.repeat(60)}…`);
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'failed', error: null }), [])), '결과: 실패');
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'cancelled' }), [])), '결과: 취소됨');
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'done' }), [])), '결과: 고칠 곳 없음');
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'pending' }), [])), null);
  assert.equal(resultLine(MT.renderRequestMemo(R({ status: 'working' }), [])), null);
  // 다시 요청이 실패해도 앞서 반영한 것은 문서에 있으니 목록에 남는다
  const failedWith = MT.renderRequestMemo(R({ status: 'failed', error: 'x' }), [P({ status: 'applied', find: '가', replace: '나' }), P()]);
  assert.equal(resultLine(failedWith), '결과: 실패 — x');
  assert.deepEqual(listLines(failedWith), [' · 「가」→「나」']);
});

test('여러 안 묶음: 반영한 안은 「안 3개 중 안 2 반영」·목록 「안 2:」, 고르는 중이면 「안 3개 — 고르는 중」, 모두 거절이면 적지 않음', () => {
  const g = (status2, others = 'superseded') => [1, 2, 3].map((o) => P({ gid: 2, option: o, ref: 's0/p0', find: '메모 대상 문장이 여기 있습니다.', replace: `안 ${o} 글`, status: o === 2 ? status2 : others }));
  const t = MT.renderRequestMemo(R(), g('applied'));
  assert.equal(resultLine(t), '결과: 안 3개 중 안 2 반영');
  assert.deepEqual(listLines(t), [' · 안 2: 「메모 대상 문장이 여기 있습니다.」→「안 2 글」']);
  const choosing = MT.renderRequestMemo(R(), g('pending', 'pending'));
  assert.equal(resultLine(choosing), '결과: 안 3개 — 고르는 중');
  assert.deepEqual(listLines(choosing), []);
  assert.equal(resultLine(MT.renderRequestMemo(R(), g('rejected', 'rejected'))), '결과: 반영한 제안 없음');
  // 묶음 + 낱개 섞임
  const mixed = MT.renderRequestMemo(R(), [...g('applied'), P({ status: 'applied', ref: 's0/p3' }), P({ ref: 's0/p4' })]);
  assert.equal(resultLine(mixed), '결과: 반영 1건 · 안 3개 중 안 2 반영 · 남은 제안 1건');
});

test(`반영 목록은 ${MT.ACCEPTED_LIST_MAX}줄까지, 넘으면 ' · … 외 n건'`, () => {
  const many = Array.from({ length: 25 }, (_, i) => P({ ref: `s0/p${i}`, find: `옛${i}`, replace: `새${i}`, status: 'applied' }));
  const t = MT.renderRequestMemo(R(), many);
  const ls = listLines(t);
  assert.equal(resultLine(t), '결과: 반영 25건');
  assert.equal(ls.length, MT.ACCEPTED_LIST_MAX + 1);
  assert.equal(ls[0], ' · 「옛0」→「새0」');
  assert.equal(ls[MT.ACCEPTED_LIST_MAX - 1], ` · 「옛${MT.ACCEPTED_LIST_MAX - 1}」→「새${MT.ACCEPTED_LIST_MAX - 1}」`);
  assert.equal(ls.at(-1), ' · … 외 5건');
  // 딱 20건이면 '외' 줄 없음
  assert.equal(listLines(MT.renderRequestMemo(R(), many.slice(0, MT.ACCEPTED_LIST_MAX))).length, MT.ACCEPTED_LIST_MAX);
});

test('수정본에만 반영(대기 + adoptedBy): 꼬리 「— 변경 요청 #cid」, 묶인 변경 요청이 없으면 「— 수정본」', () => {
  const a = P({ ref: 's0/p1', find: '가', replace: '나', adoptedBy: { 홍길동: { at: T1, cid: 3 } }, adopted: { by: '홍길동', at: T1, cid: 3 } });
  const b = P({ ref: 's0/p2', find: '다', replace: '라', adoptedBy: { 김검토: { at: T1, cid: null } }, adopted: { by: '김검토', at: T1, cid: null } });
  const c = P({ ref: 's0/p3', find: '마', replace: '바', adopted: { by: '홍길동', at: T1, cid: 4 } });   // 예전 모양(adopted 하나뿐)
  const d = P({ ref: 's0/p4', find: '사', replace: '아', adoptedBy: { 김검토: { at: T1, cid: null }, 홍길동: { at: T1, cid: 5 } }, adopted: { by: '김검토', at: T1, cid: null } });
  const t = MT.renderRequestMemo(R(), [a, b, c, d]);
  assert.equal(resultLine(t), '결과: 반영 4건');
  assert.deepEqual(listLines(t), [' · 「가」→「나」 — 변경 요청 #3', ' · 「다」→「라」 — 수정본', ' · 「마」→「바」 — 변경 요청 #4', ' · 「사」→「아」 — 변경 요청 #5']);
  // crOf 를 주면 그것으로
  assert.deepEqual(listLines(MT.renderRequestMemo(R(), [a], { crOf: () => 9 })), [' · 「가」→「나」 — 변경 요청 #9']);
  // 기준에 적용된 것은 꼬리 없음(적용됐으면 반영 기록은 의미 없음)
  assert.deepEqual(listLines(MT.renderRequestMemo(R(), [{ ...a, status: 'applied' }])), [' · 「가」→「나」']);
});

test('해결 줄: 해결(완료·취소 + 남은 것 없음)이고 resolvedAt 이 있을 때만 「✓ 해결 · 누가 MM-dd HH:mm」', () => {
  const props = [P({ status: 'applied' }), P({ status: 'rejected' })];
  const t = MT.renderRequestMemo(R({ resolvedAt: T2, resolvedBy: '관리자' }), props);
  assert.ok(lines(t).includes(`✓ 해결 · 관리자 ${MT.fmtTime(T2)}`), t);
  // 에이전트가 해결(의견만 남기고 완료) — 이름은 에이전트 이름(shortBy)
  assert.ok(lines(MT.renderRequestMemo(R({ resolvedAt: T2, resolvedBy: '관리자(Claude Code)' }), [])).includes(`✓ 해결 · Claude Code ${MT.fmtTime(T2)}`));
  assert.ok(!MT.renderRequestMemo(R({ resolvedAt: null }), props).includes('✓ 해결'), 'resolvedAt 이 없으면 없음');
  assert.ok(!MT.renderRequestMemo(R({ resolvedAt: T2, resolvedBy: '관리자' }), [...props, P()]).includes('✓ 해결'), '남은 것이 있으면 없음');
  assert.ok(!MT.renderRequestMemo(R({ status: 'working', resolvedAt: T2, resolvedBy: '관리자' }), props).includes('✓ 해결'), '처리 중이면 없음');
  // 해결 줄은 반영 목록 뒤·이력 줄 앞, 스레드 블록은 맨 끝
  const th = MT.renderRequestMemo(R({ resolvedAt: T2, resolvedBy: '관리자' }), props, { thread: { replies: [{ by: '김검토', at: T2, text: '확인' }], resolved: null } });
  const ls = lines(th);
  const iList = ls.findIndex((l) => l.startsWith(' · ')); const iOk = ls.findIndex((l) => l.startsWith('✓ 해결 · ')); const iHist = ls.findIndex((l) => l.startsWith('이력: ')); const iTh = ls.indexOf('── 답글');
  assert.ok(iList < iOk && iOk < iHist && iHist < iTh && ls.at(-1) === `↳ 김검토 ${MT.fmtTime(T2)}: 확인`, th);
});

test('이력 줄: 요청 생애 기록만(최근 6개) — 제안 하나하나의 생김·적용·거절·복구·다시 열기·고치기·의견·요약은 빼고, 해결 기록의 거절 수도 쓰지 않음', () => {
  const at = (m) => `2026-10-23T01:${String(m).padStart(2, '0')}:00.000Z`;
  const log = [
    { at: at(0), by: '관리자', action: 'request', detail: '요청' },
    { at: at(1), by: '관리자(Claude Code)', action: 'working', detail: '처리 시작' },
    { at: at(2), by: '관리자(Claude Code)', action: 'proposals', detail: '제안 16건' },
    { at: at(3), by: '관리자(Claude Code)', action: 'comments', detail: '의견 1건' },
    { at: at(4), by: '관리자(Claude Code)', action: 'done', detail: '완료' },
    { at: at(5), by: '관리자', action: 'apply', detail: '#3 적용' },
    { at: at(6), by: '관리자', action: 'reject', detail: '#4 거절' },
    { at: at(7), by: '관리자', action: 'undo', detail: '#3 복구' },
    { at: at(8), by: '관리자', action: 'proposal-reopen', detail: '#4 다시 열기' },
    { at: at(9), by: '관리자', action: 'reopen', detail: '#5 다시 열기' },   // 옛 자료의 제안 다시 열기(action reopen)
    { at: at(10), by: '관리자', action: 'edit', detail: '#6 고침' },
    { at: at(11), by: '관리자', action: 'summary', detail: '요약 수정' },
    { at: at(12), by: '홍길동', action: 'adopt', detail: '#7 수정본에 반영' },
    { at: at(13), by: '관리자', action: 'resolve', detail: '해결 — 반영 14 · 거절 2' },
  ];
  const hist = lines(MT.renderRequestMemo(R({ log }), [])).find((l) => l.startsWith('이력: '));
  const t = (m) => MT.fmtTime(at(m), false);
  assert.equal(hist, `이력: ${MT.fmtTime(at(0))} 요청(관리자) · ${t(1)} 처리 시작(Claude Code) · ${t(4)} 완료(Claude Code) · ${t(13)} 해결(관리자)`);
  // 요청 자체의 다시 열림·다시 요청·취소·실패도 생애 기록 — 최근 6개만
  const log2 = [...log,
    { at: at(14), by: '관리자', action: 'reopen', detail: '다시 열림 — 남은 2건' },
    { at: at(15), by: '관리자', action: 'cancel', detail: '취소' },
    { at: at(16), by: '관리자', action: 'retry', detail: '다시 요청' },
    { at: at(17), by: '서버 AI', action: 'failed', detail: '실패' }];
  const hist2 = lines(MT.renderRequestMemo(R({ log: log2, status: 'failed' }), [])).find((l) => l.startsWith('이력: '));
  assert.equal(hist2, `이력: ${MT.fmtTime(at(4))} 완료(Claude Code) · ${t(13)} 해결(관리자) · ${t(14)} 다시 열림(관리자) · ${t(15)} 취소(관리자) · ${t(16)} 다시 요청(관리자) · ${t(17)} 실패(서버 AI)`);
});

test('requestOutcome: 항목(묶음 = 하나)·반영(적용/수정본)·거절·남음·해결·openPids', () => {
  const props = [
    P({ status: 'applied' }), P({ status: 'pending', adoptedBy: { 홍길동: { at: T1, cid: null } } }), P({ status: 'rejected' }), P({ status: 'undone' }),
    P({ status: 'pending' }),
    ...[1, 2].map((o) => P({ gid: 'g1', option: o, status: 'pending' })),                                     // 고르는 중
    ...[1, 2].map((o) => P({ gid: 'g2', option: o, status: o === 1 ? 'applied' : 'superseded' })),            // 반영(적용)
    ...[1, 2].map((o) => P({ gid: 'g3', option: o, status: o === 1 ? 'rejected' : 'superseded' })),           // 거절
  ];
  const o = MT.requestOutcome(R({ comments: ['m'] }), props);
  const pend = props.filter((p) => p.status === 'pending' && !p.adoptedBy).map((p) => p.pid).sort((a, b) => a - b);
  assert.deepEqual(o, { items: 8, accepted: 3, applied: 2, adopted: 1, declined: 3, open: 2, comments: 1, resolved: false, openPids: pend });
  // 남은 것이 없으면 완료·취소된 요청은 해결 — 처리 중·실패·대기는 아님. 제안이 없는 완료도 해결
  const decided = props.filter((p) => !(p.status === 'pending' && !p.adoptedBy));
  for (const [status, want] of [['done', true], ['cancelled', true], ['working', false], ['failed', false], ['pending', false]]) assert.equal(MT.requestOutcome(R({ status }), decided).resolved, want, status);
  assert.equal(MT.requestOutcome(R({ status: 'done' }), []).resolved, true);
  assert.equal(MT.isAdopted(P({ adoptedBy: {} })), false);
  assert.equal(MT.isAdopted(P({ adopted: { by: '홍길동' } })), true);
});

test('묶음 제안(bundle — docs/UI_TERMS.md §9): 항목 하나 — 일부 반영이어도 남음, 다 정하면 반영 · 결과 줄은 항목 수 · 반영 목록은 묶음 한 줄', () => {
  const ins = (t, over = {}) => P({ type: 'insert', text: t, bundle: 'bA', ref: undefined, afterRef: 's0/p0', find: undefined, replace: undefined, ...over });
  const props = [ins('첫 문단', { status: 'applied' }), ins('둘째', { status: 'applied' }), ins('셋째'), P({ type: 'table', bundle: 'bA', table: { rows: [['a', 'b']] } }), P({ status: 'pending' })];
  const o = MT.requestOutcome(R(), props);
  assert.deepEqual([o.items, o.open, o.accepted], [2, 2, 0], '묶음은 남은 구성원이 있으면 남음');
  assert.deepEqual(o.openPids, [props[2].pid, props[3].pid, props[4].pid]);
  assert.equal(MT.requestSummaryResultLine(R({ status: 'done' }), props), '결과: 남은 제안 2건');
  // 남은 것을 정함(셋째 반영 · 표 거절) → 묶음 = 반영, 목록은 한 줄(일부만이면 '(n건 중 k건)')
  props[2].status = 'applied'; props[3].status = 'rejected';
  const o2 = MT.requestOutcome(R(), props);
  assert.deepEqual([o2.items, o2.accepted, o2.applied, o2.open], [2, 1, 1, 1]);
  const memo = MT.renderRequestMemo(R({ status: 'done' }), props);
  assert.match(memo, /결과: 반영 1건 · 남은 제안 1건/);
  assert.match(memo, / · 새 문단 3 · 표 1 넣기\(4건 중 3건\): 문단 추가 「첫 문단」 외 2건/);
  assert.equal(MT.bundleLabel(props.slice(0, 4)), '새 문단 3 · 표 1 넣기');
  // 구성원이 하나뿐인 bundle 은 보통 항목, 거둔 제안(withdrawn)은 빠진다
  const lone = MT.requestItems([P({ bundle: 'bZ' }), P({ bundle: 'bY' }), P({ bundle: 'bY', status: 'withdrawn' })]);
  assert.deepEqual(lone.map((x) => x.bundle ?? null), [null, null]);
  // 여러 안(gid)은 bundle 이 있어도 여러 안 묶음(섞지 않는다)
  const alt = MT.requestItems([P({ gid: 'g', option: 1, bundle: 'bQ' }), P({ gid: 'g', option: 2, bundle: 'bQ' })]);
  assert.deepEqual(alt.map((x) => [x.gid, x.bundle ?? null, x.list.length]), [['g', null, 2]]);
});

test('compareRefs: 구역 → 본문 → 중첩 번호 차례', () => {
  const refs = ['s0/p10', 's0/p2/n3', 's1/p0', 's0/p2', 's0/p2/n10', 'x', 's0/p2/n3/n0'];
  assert.deepEqual([...refs].sort(MT.compareRefs), ['s0/p2', 's0/p2/n3', 's0/p2/n3/n0', 's0/p2/n10', 's0/p10', 's1/p0', 'x']);
});

// ───────── v0.4 요약 꼴 작업 기록 메모(docs/V4_SPEC.md §4.4 aiMemo 'summary') ─────────

test('자동 메모 생성: 내용 없는 대기·실행·실패·취소는 미루고 완료·부분 결과·공유 요약은 남긴다', () => {
  for (const status of ['pending', 'working', 'failed', 'cancelled']) {
    const req = R({ status, summaryBy: 'auto', summary: MT.autoSummary('지시', status), error: '일시적 오류' });
    assert.equal(MT.shouldCreateRequestMemo(req), false, status);
    assert.equal(MT.shouldCreateRequestMemo(req, [P()]), true, `${status}: 부분 제안`);
    assert.equal(MT.shouldCreateRequestMemo({ ...req, comments: ['m1'] }), true, `${status}: 확인 의견`);
    assert.equal(MT.shouldCreateRequestMemo({ ...req, summaryBy: 'user', summary: '근거 자료를 다시 확인해 주세요' }), true, `${status}: 사람 요약`);
    assert.equal(MT.shouldCreateRequestMemo({ ...req, aiSummary: '일부 표현을 고쳤으나 추가 확인이 필요합니다' }), true, `${status}: AI 요약`);
  }
  assert.equal(MT.shouldCreateRequestMemo(R({ status: 'done', summary: '', summaryBy: 'auto' })), true, '고칠 곳 없는 완료도 결과를 남김');
  assert.equal(MT.shouldCreateRequestMemo(R({ status: 'failed', summaryBy: 'user', summary: ' \u0001 ' })), false, '공백·XML 금지 문자뿐인 요약은 내용 없음');
});

test('자동 메모 생성: detail은 대기부터 기록, none·삭제한 요청은 새 자동 메모를 만들지 않음', () => {
  assert.equal(MT.shouldCreateRequestMemo(R({ status: 'pending', summaryBy: 'auto' }), [], 'detail'), true);
  for (const mode of ['summary', 'detail', 'none']) {
    assert.equal(MT.shouldCreateRequestMemo(R({ memoDeleted: true }), [P()], mode), false, `${mode}: 사람이 지운 메모를 다시 만들지 않음`);
  }
  assert.equal(MT.shouldCreateRequestMemo(R({ comments: ['m1'], summaryBy: 'user' }), [P()], 'none'), false, '결과가 있어도 none은 신규 작업기록만 생략');
  assert.equal(MT.shouldCreateRequestMemo(null), false);
});

test('요약 꼴: 머리줄(요청한 사람 · 처리) · 요약 한 문단 · 결과 한 줄 — 반영 목록·이력 줄 없음', () => {
  const props = [P({ status: 'applied' }), P({ status: 'applied' }), P({ status: 'rejected' }), P({ status: 'pending' })];
  const t = MT.renderRequestSummaryMemo(R({ comments: ['m1'] }), props);
  assert.deepEqual(lines(t), ['[AI 작업 #2] 관리자 · 처리 Claude Code', '회의록 표현 다듬기', '결과: 반영 2건 · 의견 1건 · 남은 제안 1건']);
  assert.ok(MT.isRequestMemoText(t, 2), '요청 메모 머리(같은 [AI 작업 #n])');
  // 해결되면 남은 제안 대신 ✓ 해결 시각(거절 수는 쓰지 않음)
  const done = [P({ status: 'applied' }), P({ status: 'rejected' })];
  const r = R({ resolvedAt: T2, resolvedBy: '관리자' });
  assert.equal(resultLine(MT.renderRequestSummaryMemo(r, done)), `결과: 반영 1건 · ✓ 해결 ${MT.fmtTime(T2)}`);
  assert.ok(!MT.renderRequestSummaryMemo(r, done).includes('거절'));
  // 처리자가 없으면 머리줄은 요청한 사람만
  assert.equal(lines(MT.renderRequestSummaryMemo(R({ handledBy: null, status: 'pending', summary: 'AI 검토 요청 — AI 처리 대기' }), []))[0], '[AI 작업 #2] 관리자');
});

test('요약 꼴 결과 줄: 반영한 제안 없음 · 의견만 · 여러 안 묶음 = 한 건 · 결과가 없으면 V3 규칙(실패·취소·고칠 곳 없음·대기 중 없음)', () => {
  assert.equal(MT.requestSummaryResultLine(R({ resolvedAt: T2 }), [P({ status: 'rejected' })]), `결과: 반영한 제안 없음 · ✓ 해결 ${MT.fmtTime(T2)}`);
  assert.equal(MT.requestSummaryResultLine(R({ comments: ['a', 'b'] }), []), '결과: 의견 2건');
  const alts = [1, 2, 3].map((o) => P({ gid: 'g9', option: o, status: 'pending' }));
  assert.equal(MT.requestSummaryResultLine(R(), [...alts, P({ status: 'applied' })]), '결과: 반영 1건 · 남은 제안 1건');
  assert.equal(MT.requestSummaryResultLine(R({ status: 'failed', error: '모의 실패' }), []), '결과: 실패 — 모의 실패');
  assert.equal(MT.requestSummaryResultLine(R({ status: 'cancelled' }), []), '결과: 취소됨');
  assert.equal(MT.requestSummaryResultLine(R({ status: 'done' }), []), '결과: 고칠 곳 없음');
  assert.equal(MT.requestSummaryResultLine(R({ status: 'working' }), []), null);
  assert.equal(MT.requestSummaryResultLine(R({ status: 'cancelled' }), [P({ status: 'applied' }), P()]), '결과: 반영 1건 · 남은 제안 1건 (취소됨)');
});

test('요약 꼴 요약 글: 줄바꿈은 그대로(빈 줄은 하나로)·600자까지(넘으면 …)·XML 금지 글자 빼고 · 스레드 블록은 그대로 붙음', () => {
  const sum = `첫 줄\n\n\n\n둘째 줄\u0001  \n${'가'.repeat(700)}`;
  const t = MT.renderRequestSummaryMemo(R({ summary: sum }), [], { thread: { replies: [{ by: '김검토', at: T1, text: '확인했습니다' }], resolved: { by: '관리자', at: T2 } } });
  const body = t.split('\n── 답글')[0].split('\n').slice(1, -1).join('\n');
  assert.ok(body.startsWith('첫 줄\n\n둘째 줄\n가'), body.slice(0, 20));
  assert.equal([...body].length, MT.SUMMARY_MEMO_MAX + 1);
  assert.ok(body.endsWith('…') && !t.includes('\u0001'));
  assert.ok(t.includes(`\n── 답글\n↳ 김검토 ${MT.fmtTime(T1)}: 확인했습니다\n✓ 해결됨 · 관리자 ${MT.fmtTime(T2)}`), '스레드 블록(답글·해결 표시는 렌더러에 준 그대로)');
});
