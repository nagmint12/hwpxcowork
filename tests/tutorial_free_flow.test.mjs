import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportFlow } from '../web/tutorial-modules/report-flow.js';
import { buildAiReview } from '../web/tutorial-modules/ai-review.js';
import { buildEditorBasics } from '../web/tutorial-modules/editor-basics.js';
import { buildClipboard } from '../web/tutorial-modules/clipboard.js';
import { buildAdvanced } from '../web/tutorial-modules/advanced.js';
import { buildComposedTutorialSteps } from '../web/tutorial-modules/compose.js';
import { DEFAULT_TUTORIAL_DEFINITION } from '../web/tutorial-definition.js';
import { createTutorialRecoveryWatch, createTutorialRecoveryHistory, tutorialRecoveryPoint } from '../web/tutorial-recovery.js';

const P1 = '일정 부분 기여한 것으로 보인다';
const environment = () => {
  const s = { paragraphs: [], requests: [], proposals: [], memos: [], info: {} };
  return { describe: true, s, d: { request: rid => s.requests.find(r => r.rid === rid), memo: id => s.memos.find(m => m.id === id) }, ctx: {}, config: {}, clipboard: {},
    dragHow: '끌어', saveButton() {}, focusIn() {}, rectOf() {}, pad: x => x, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {},
    locate: phrase => ({ ref: phrase === P1 ? 's0/p1' : 's0/p2', start: 0, end: [...phrase].length }), phraseRect() {}, cw() {}, toolbarShown: () => false, selHas: () => false, motionReduced: () => true };
};

test('보고서 요청·반영을 안내보다 먼저 끝내도 선택부터 반영까지 결과를 인식한다', () => {
  const e = environment(); const locate = e.locate; let sourceExists = true;
  e.locate = phrase => sourceExists ? locate(phrase) : null;
  const steps = buildReportFlow(e);
  e.s.requests.push({ rid: 1, target: { ...e.locate(P1), text: P1 }, status: 'done' });
  e.s.proposals.push({ rid: 1, status: 'applied' });
  sourceExists = false; // 반영으로 원래 문구가 사라졌습니다.
  for (const i of [1, 2, 3, 4, 5]) assert.equal(steps[i].until(), true, steps[i].title);
});

test('메모와 후속 AI 요청을 먼저 작성하고 창을 닫아도 작성 결과를 다시 요구하지 않는다', () => {
  const e = environment(); const steps = buildReportFlow(e);
  e.s.memos.push({ id: 'm1', ...e.locate('학생 만족도') });
  e.s.requests.push({ rid: 2, followUp: { memoId: 'm1' }, status: 'done' });
  e.s.proposals.push({ rid: 2, status: 'applied' });
  for (const i of [6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(steps[i].until(), true, steps[i].title); steps[i].leave?.();
  }
});

test('거절을 먼저 해도 반영·거절·되돌리기 실습을 이어가고 모두 반영은 준비 지점으로 복구한다', () => {
  const e = environment(); e.s.requests = [{ rid: 1, example: true, status: 'done' }];
  e.s.proposals = [{ rid: 1, pid: 1, status: 'pending' }, { rid: 1, pid: 2, status: 'rejected' }];
  const steps = buildAiReview(e); const apply = steps[4], reject = steps[5], undo = steps[6];
  assert.equal(apply.lost(), null); assert.equal(apply.until(), false);
  e.s.proposals[0].status = 'applied';
  assert.equal(apply.until(), true); assert.equal(reject.until(), true);
  e.s.proposals[0].status = 'undone';
  assert.equal(apply.until(), true); assert.equal(reject.until(), true); assert.equal(undo.until(), true);
  e.s.proposals.forEach(p => { p.status = 'applied'; });
  for (const step of [apply, reject, undo]) { assert.equal(step.until(), false); assert.equal(step.lost(), 4); }
});

test('기본 코스와 사용자 동작에는 대행 완료 동작이 없다', () => {
  for (const course of DEFAULT_TUTORIAL_DEFINITION.courses) {
    const steps = buildComposedTutorialSteps({ ...course, sourceId: course.sourceId }, environment());
    for (const step of steps) for (const key of ['quick', 'quickLabel', 'quickWhen']) assert.equal(step[key], undefined, `${course.id}/${step.title}/${key}`);
  }
});

test('임시 상태·작업 중에는 복구하지 않고, 같은 막힘에는 자동 복구를 한 번만 시도한다', () => {
  const watch = createTutorialRecoveryWatch();
  const value = { step: 5, target: 4, version: 8 };
  assert.equal(watch.poll({ ...value, now: 0 }), false);
  assert.equal(watch.poll({ ...value, busy: true, now: 1000 }), false);
  assert.equal(watch.poll({ ...value, now: 1700 }), false);
  assert.equal(watch.poll({ ...value, now: 1900 }), true);
  assert.equal(watch.poll({ ...value, now: 30000 }), false);
  assert.equal(watch.poll({ ...value, target: null, now: 30001 }), false);
  assert.equal(watch.poll({ ...value, now: 30002 }), false);
  assert.equal(watch.poll({ ...value, now: 31000 }), true);
});

test('미도달·작업 중인 복구 지점은 직전 안전 지점으로 돌아가고 0번도 사용할 수 있다', () => {
  const points = [{ checkpointId: 'intro' }, null, { checkpointId: 'request' }, { checkpointId: 'wait', resumable: false }];
  assert.deepEqual(tutorialRecoveryPoint(4, 3, i => points[i]), { index: 2, point: points[2] });
  assert.deepEqual(tutorialRecoveryPoint(0, 3, i => points[i]), { index: 0, point: points[0] });
  assert.equal(tutorialRecoveryPoint(4, 3, () => null), null);
});

test('복구한 스냅샷도 깨졌으면 새로고침 후 더 이전 지점으로 돌아가며 원래 단계를 지나야 시도를 지운다', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const points = [{ checkpointId: 'intro' }, { checkpointId: 'ready' }, { checkpointId: 'invalid' }];
  let history = createTutorialRecoveryHistory(storage, 'one', () => 1000);
  history.mark('invalid', 2);
  history = createTutorialRecoveryHistory(storage, 'one', () => 2000);
  assert.deepEqual(tutorialRecoveryPoint(2, 2, i => points[i], history.attempted), { index: 1, point: points[1] });
  history.advance(2); assert.equal(history.attempted('invalid'), true);
  history.mark('ready', 2);
  assert.deepEqual(tutorialRecoveryPoint(2, 2, i => points[i], history.attempted), { index: 0, point: points[0] });
  history.advance(3); assert.equal(history.attempted('invalid'), false);
  assert.equal(values.size, 0);
});

test('첫 안내 중 연습 글을 미리 고쳐도 완료를 인식하고 대상 삭제는 복구 지점을 찾는다', () => {
  const e = environment(); const original = '이 문단의 아무 글이나 고쳐 보세요';
  e.s.paragraphs = [{ ref: 's0/p1', text: original }];
  e.cw = () => ({ debug: { text: () => e.s.paragraphs[0]?.text } });
  const steps = buildEditorBasics(e);
  e.s.paragraphs[0].text = '첫 안내에서 이미 고친 문장'; steps[2].enter();
  assert.equal(steps[2].until(), true); assert.equal(steps[3].until(), false);
  e.s.paragraphs = []; assert.equal(steps[2].lost(), 2);
  const missing = environment(); missing.locate = () => null;
  assert.equal(buildReportFlow(missing)[1].lost(), 1);
});

test('선택할 연습 문구를 미리 지웠으면 각 선택 단계에서 자동 복구를 시작한다', () => {
  const e = environment(); e.locate = () => null;
  assert.equal(buildReportFlow(e)[6].lost(), 6);
  assert.equal(buildEditorBasics(e)[4].lost(), 4);
  assert.equal(buildAiReview(e)[1].lost(), 1);
});

test('차례 갱신을 먼저 끝내면 원래 표식이 없어져도 요청·반영 결과를 인식한다', () => {
  const e = environment(); e.s.paragraphs = [{ ref: 's0/p0', text: '<제목 차례>' }];
  const steps = buildReportFlow(e);
  e.s.requests.push({ rid: 3, target: { ref: 's0/p0' }, instruction: '차례 새로고침해줘', status: 'done' });
  e.s.proposals.push({ rid: 3, type: 'toc', status: 'applied' });
  e.s.paragraphs[0].text = '1. 조사 개요 …… 1';
  assert.equal(steps[13].until(), true); assert.equal(steps[14].until(), true);
  assert.equal(steps[13].lost(), null);
});

test('차례 대상만 삭제한 경우에는 무관한 요청을 완료로 세지 않고 복구한다', () => {
  const e = environment(); e.s.paragraphs = [{ ref: 's0/p0', text: '<제목 차례>' }];
  const steps = buildReportFlow(e);
  e.s.paragraphs = [];
  e.s.requests.push({ rid: 3, target: { ref: 's0/p99' }, instruction: '차례 새로고침해줘', status: 'done' });
  assert.equal(steps[13].until(), false); assert.equal(steps[13].lost(), 13);
});

test('메모를 미리 달 때 앞뒤 글이 함께 포함되어도 해당 연습 문구를 포함하면 인식한다', () => {
  const e = environment(); const steps = buildReportFlow(e); const at = e.locate('학생 만족도');
  e.s.memos.push({ id: 'early', ...at, end: at.end + 10 });
  assert.equal(steps[8].until(), true);
});

test('복사 실습은 미리 복사한 실제 결과를 인식하고 표식 삭제 시 선택 준비 상태로 돌아간다', () => {
  for (const touch of [false, true]) {
    const e = environment(); e.touch = touch; e.locate = () => null; e.clipboard.seq = 0;
    const steps = buildClipboard(e);
    const pick = steps.find(step => step.title === '복사할 내용을 직접 선택하기');
    const copy = steps.find(step => step.title === '선택한 내용을 실제로 복사하기');
    assert.equal(steps[pick.lost()], pick); assert.equal(steps[copy.lost()], pick);
    Object.assign(e.clipboard, { seq: 1, type: 'copy', text: '영역 시작\n표와 그림\n영역 끝', tables: 1, images: 1 });
    copy.enter?.();
    assert.equal(pick.until(), true); assert.equal(copy.until(), true);
    assert.equal(pick.lost(), null); assert.equal(copy.lost(), null);
  }
});

test('AI 작업 대상 삭제는 요청 전 상태로 복구하지만 이미 보낸 요청은 기다린다', () => {
  const e = environment(); e.locate = () => null;
  const task = { id: 'S1', title: '그림 만들기', target: { table: '분석 기준 총괄' }, prompt: '그림으로 바꿔 줘' };
  const steps = buildAdvanced(e, [task]);
  assert.equal(steps[1].lost(), 1);
  e.s.requests.push({ rid: 10, tutorialStep: 'S1', status: 'working' });
  assert.equal(steps[1].until(), true); assert.equal(steps[1].lost(), null);
});

test('복사 표식은 남아도 표 또는 그림을 삭제하여 전체 복사 결과가 불완전하면 복구한다', () => {
  for (const media of [{ tables: 0, images: 1 }, { tables: 1, images: 0 }]) {
    const e = environment(); e.clipboard.seq = 0;
    const steps = buildClipboard(e); const copy = steps.find(step => step.title === '선택한 내용을 실제로 복사하기');
    Object.assign(e.clipboard, { seq: 1, type: 'copy', text: '다른 글 복사', ...media });
    assert.equal(copy.lost(), null, '무관한 복사는 되돌리지 않음');
    e.clipboard.text = '영역 시작\n남은 내용\n영역 끝';
    assert.equal(copy.until(), false); assert.equal(copy.lost(), 1);
  }
});
