import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomAction } from '../web/tutorial-modules/custom-actions.js';

const text = '선택할 연습 글';
const range = { ref: 's0/p3', start: 2, end: 2 + [...text].length };
const environment = () => ({ s: {}, q() {}, frameRect() {}, phraseRect() {}, rectOf() {}, pad() {},
  locate: () => ({ ...range }), selHas: () => true, isCurrentStep: () => true, motionReduced: () => false });
const selectStep = env => buildCustomAction({ actionId: 'select-text', title: '글 선택', params: { text } }, env);

test('custom 선택은 문구가 같아도 다른 문단·범위·끝 문단을 통과시키지 않는다', () => {
  const env = environment(); const select = selectStep(env);
  for (const mismatch of [{ ref: 's0/p99' }, { start: 1 }, { end: range.end - 1 }, { endRef: 's0/p4' }, { collapsed: true }]) {
    env.s.selection = { ...range, text, ...mismatch }; assert.equal(select.until(), false, JSON.stringify(mismatch));
  }
  env.s.selection = { ...range, endRef: range.ref, refs: [range.ref], text }; assert.equal(select.until(), true);
  env.locate = () => null; assert.equal(select.until(), false, '원문이 사라진 경우 선택 문자열만으로 통과하지 않음');
});

test('custom 선택은 대행 실행을 만들지 않고 재진입 중에도 사용자의 선택을 보존한다', () => {
  const env = environment(); let called = 0; env.selectFor = () => { called++; };
  env.s.selection = { ...range, text };
  for (let i = 0; i < 2; i++) { const step = selectStep(env); assert.equal(step.action, undefined); assert.equal(step.until(), true); }
  assert.equal(called, 0); assert.deepEqual(env.s.selection, { ...range, text });
});

test('custom 선택은 선택 해제와 원문 삭제를 인식하고 정상 범위에서만 완료한다', () => {
  const env = environment(); const step = selectStep(env);
  assert.equal(step.until(), false); env.s.selection = { ...range, text }; assert.equal(step.until(), true);
  env.s.selection = null; assert.equal(step.until(), false);
  env.s.selection = { ...range, text }; env.locate = () => null; assert.equal(step.until(), false);
});

test('custom 입력은 재진입해도 직접 쓰던 글을 자동 타이핑으로 덮지 않는다', () => {
  const env = environment(); const input = { value: '직접 쓰던 글' }; env.q = () => input;
  const ref = { actionId: 'type-text', title: '같은 제목', params: { scope: 'document', selector: '#input', value: '가나다' } };
  for (let i = 0; i < 2; i++) { const step = buildCustomAction(ref, env); assert.equal(step.action.label, '대신 예시 작성하기'); assert.equal(step.until(), false); }
  assert.equal(input.value, '직접 쓰던 글');
});

test('custom 입력은 직접 입력한 값을 확인하고 직접 클릭은 자동 실행하지 않는다', () => {
  const env = environment(); const input = { value: '' }; env.q = () => input;
  const type = buildCustomAction({ actionId: 'type-text', title: '정상 입력', params: { scope: 'document', selector: '#input', value: '정상 예시' } }, env);
  assert.equal(type.until(), false); input.value = '정상 예시'; assert.equal(type.until(), true);
  let clicks = 0; const button = { click() { clicks++; } }; env.q = () => button;
  const click = buildCustomAction({ actionId: 'click-target', title: '직접 클릭', params: { scope: 'document', selector: '#button' } }, env);
  assert.equal(click.click(), button); assert.equal(clicks, 0);
});
