import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppliedReview, appliedReviewRange, appliedReviewDetails } from '../web/tutorial-apply-review.js';

const proposal = (pid, extra = {}) => ({ pid, type: 'replace', ref: `s0/p${pid}`, status: 'pending', find: '이전', replace: '이후', ...extra });

test('반영 성공만 확인 대상으로 삼고, 확인 버튼 전에는 대기열을 유지한다', () => {
  const ctx = {}; const list = [proposal(1), proposal(2), proposal(3)];
  const review = createAppliedReview(ctx, list);
  list[0].status = 'applied'; list[1].status = 'rejected'; list[2].status = 'adopted';
  assert.equal(review.observe(list), true); assert.equal(review.count, 1);
  assert.equal(review.confirm(), false, '본문을 아직 보여 주지 않았다');
  review.visit();
  assert.equal(review.active, true, '본문 이동만으로 자동 완료하지 않는다');
  assert.equal(review.confirm(), true); assert.equal(review.observe(list, list), false);
});

test('모두 반영의 성공 위치를 각각 확인하고, 실패·미반영 건은 반영됐다고 안내하지 않는다', () => {
  const list = [proposal(1), proposal(2), proposal(3)]; const review = createAppliedReview({}, list);
  list[0].status = list[1].status = 'applied';
  review.observe(list); assert.equal(review.groups().length, 2);
  review.visit(); assert.equal(review.confirm(), false);
  review.move(1); review.visit();
  assert.equal(review.canConfirm, true); assert.equal(review.active, true);
  assert.equal(review.confirm(), true); assert.equal(list[2].status, 'pending');
});

test('확인 중 늦게 도착한 반영 결과도 확인하기 전에는 완료할 수 없다', () => {
  const list = [proposal(1), proposal(2)]; const review = createAppliedReview({}, list);
  list[0].status = 'applied'; review.observe(list); review.visit();
  list[1].status = 'applied'; review.observe(list);
  assert.equal(review.canConfirm, false); assert.equal(review.confirm(), false);
  review.move(1); review.visit(); assert.equal(review.confirm(), true);
});

test('같은 표의 숫자·모양은 함께 보여 주고 다른 본문은 별도 위치로 안내한다', () => {
  const list = [proposal(1, { ref: 's1/p43#t0/r5/c4/p0' }), proposal(2, { type: 'table_edit', tableKey: 's1/p43#t0', ref: 's1/p43' }), proposal(3)];
  const review = createAppliedReview({}, list); list.forEach(p => { p.status = 'applied'; }); review.observe(list);
  assert.equal(review.count, 3); assert.equal(review.groups().length, 2);
  assert.deepEqual(review.current.proposals.map(p => p.pid), [1, 2]);
});

test('확인 창을 닫거나 새로고침해도 대기 위치를 복원하고 확인한 결과는 반복 안내하지 않는다', () => {
  const ctx = {}; const list = [proposal(1), proposal(2)]; const first = createAppliedReview(ctx, list);
  list.forEach(p => { p.status = 'applied'; }); first.observe(list); first.visit(); first.move(1);
  const saved = JSON.parse(JSON.stringify(ctx)); const resumed = createAppliedReview(saved, list);
  resumed.observe(list); assert.equal(resumed.active, true); assert.equal(resumed.index, 1);
  resumed.visit(); assert.equal(resumed.confirm(), true);
  const next = createAppliedReview(JSON.parse(JSON.stringify(saved)), list);
  assert.equal(next.observe(list, list), false);
});

test('기존 이력은 재생하지 않고, 현재 반영 단계에서 놓친 결과만 한 번 확인한다', () => {
  const list = [proposal(1, { status: 'applied' }), proposal(2, { status: 'applied' })]; const review = createAppliedReview({}, list);
  assert.equal(review.observe(list), false);
  assert.equal(review.observe(list, [list[1]]), true); assert.equal(review.current.proposals[0].pid, 2);
  review.visit(); review.confirm(); assert.equal(review.observe(list, [list[1]]), false);
});

test('되돌린 결과는 확인 목록에서 빼고 같은 제안을 다시 반영하면 다시 확인한다', () => {
  const p = proposal(1); const review = createAppliedReview({}, [p]);
  p.status = 'applied'; review.observe([p]); p.status = 'pending'; review.observe([p]); assert.equal(review.active, false);
  p.status = 'applied'; review.observe([p]); review.visit(); review.confirm();
  p.status = 'pending'; review.observe([p]); p.status = 'applied';
  assert.equal(review.observe([p]), true);
});

test('본문 초점은 반영된 범위·추가 문단의 현재 주소를 우선하고 없어진 대상은 가리키지 않는다', () => {
  const paragraphs = [{ ref: 's0/p4', text: '가😀이후나' }, { ref: 's0/p8', text: '새 문단' }];
  assert.deepEqual(appliedReviewRange(proposal(1, { appliedRange: { ref: 's0/p4', start: 2, end: 4 } }), paragraphs), { ref: 's0/p4', start: 2, end: 4 });
  assert.deepEqual(appliedReviewRange(proposal(1, { ref: 's0/p4' }), paragraphs), { ref: 's0/p4', start: 2, end: 4 });
  assert.deepEqual(appliedReviewRange(proposal(1, { type: 'insert', insertedRef: 's0/p8', text: '새 문단' }), paragraphs), { ref: 's0/p8', start: 0, end: 4 });
  assert.equal(appliedReviewRange(proposal(1, { refGone: true, ref: 's0/p4' }), paragraphs), null);
  assert.equal(appliedReviewRange(proposal(1), paragraphs), null);
});

test('문장·그림·표·서식·차례의 반영 내용을 사용자 언어로 구분한다', () => {
  assert.deepEqual(appliedReviewDetails(proposal(1)).before, '이전');
  assert.equal(appliedReviewDetails(proposal(1, { replace: '' })).after, '');
  for (const [type, title] of [['figure', '그림 교체'], ['table_edit', '표 구조·서식'], ['format', '글자·문단 서식'], ['toc', '차례 갱신']]) {
    const d = appliedReviewDetails(proposal(1, { type, figure: { replace: {} }, reason: '수정 이유' }));
    assert.ok(d.title.includes(title)); assert.equal(d.reason, '수정 이유');
  }
});

test('그림·표는 주석 글자 대신 실제 개체 위치를 요청하고 추가된 문단의 주소를 쓴다', () => {
  const paragraphs = [{ ref: 's1/p53', text: '\n주: 분석 모집단 기준.' }, { ref: 's1/p43', text: '주: 표 아래 주석' }, { ref: 's1/p60', text: '' }];
  assert.deepEqual(appliedReviewRange(proposal(1, { type: 'figure', ref: 's1/p53', figure: { replace: { n: 2 } } }), paragraphs), { ref: 's1/p53', object: 'image', objectIndex: 1 });
  assert.deepEqual(appliedReviewRange(proposal(1, { type: 'table_edit', ref: 's1/p43', tableKey: 's1/p43#t1' }), paragraphs), { ref: 's1/p43', object: 'table', objectIndex: 1 });
  assert.deepEqual(appliedReviewRange(proposal(1, { type: 'figure', ref: 's1/p53', insertedRef: 's1/p60' }), paragraphs), { ref: 's1/p60', object: 'image', objectIndex: 0 });
});

test('실제 중첩 문단 주소(/n번호)는 문단의 cell.table로 묶고, 문단 나눔으로 옮겨간 주석을 찾는다', () => {
  const list = [proposal(1, { ref: 's1/p43/n10' }), proposal(2, { ref: 's1/p43/n40' }), proposal(3, { type: 'table_edit', ref: 's1/p43', tableKey: 's1/p43#t0' })];
  const review = createAppliedReview({}, list); list.forEach(p => { p.status = 'applied'; });
  review.observe(list, [], [{ ref: 's1/p43/n10', cell: { table: 's1/p43#t0' } }, { ref: 's1/p43/n40', cell: { table: 's1/p43#t0' } }]);
  assert.equal(review.groups().length, 1); assert.equal(review.current.proposals.length, 3);
  const p = proposal(4, { ref: 's1/p43', replace: '\n주: p < .001', appliedRange: { ref: 's1/p43', start: 0, end: 0 }, split: { refs: ['s1/p44'] } });
  assert.deepEqual(appliedReviewRange(p, [{ ref: 's1/p43', text: '' }, { ref: 's1/p44', text: '주: p < .001' }]), { ref: 's1/p44', start: 0, end: 11 });
});

test('서버가 최신 제안부터 보내도 반영 확인은 먼저 등록한 제안부터 보여 준다',()=>{
  const list=[proposal(3),proposal(2),proposal(1)];const review=createAppliedReview({},list);
  list.forEach(p=>{p.status='applied';});review.observe(list);
  assert.deepEqual(review.groups().map(g=>g.proposals[0].pid),[1,2,3]);
});

test('안내를 닫아 자유롭게 편집한 동안 반영된 제안도 안내 재개 시 확인하고 기존 확인은 반복하지 않는다',()=>{
  const ctx={};const list=[proposal(1),proposal(2)];const first=createAppliedReview(ctx,list);
  list[0].status='applied';first.observe(list);first.visit();first.confirm();first.pause();
  list[1].status='applied';
  const resumed=createAppliedReview(JSON.parse(JSON.stringify(ctx)),list);resumed.observe(list);
  assert.equal(resumed.count,1);assert.equal(resumed.current.proposals[0].pid,2);
});

test('once: 요청 하나의 반영은 첫 위치를 본 뒤 한 번에 확인한다', () => {
  const list = [proposal(1), proposal(2)]; const review = createAppliedReview({}, list, { once: true });
  list.forEach(p => { p.status = 'applied'; }); review.observe(list);
  assert.equal(review.groups().length, 2);
  assert.equal(review.confirm(), false, '본문을 아직 보여 주지 않았다');
  review.visit(); assert.equal(review.canConfirm, true);
  assert.equal(review.confirm(), true); assert.equal(review.active, false);
});
