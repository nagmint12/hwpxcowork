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

test('custom 선택의 이전 실행은 새 세대에 늦게 끝나도 오류를 남기지 않는다', async () => {
  for (const reject of [false, true]) {
    const env = environment(); let identity = {}; env.stepIdentity = () => identity;
    let settle; env.selectFor = () => new Promise((resolve, fail) => { settle = reject ? fail : resolve; });
    const pending = selectStep(env).action.run(); identity = {}; settle(reject ? new Error('이전 선택 실패') : null);
    await assert.doesNotReject(pending);
  }
});

test('custom 선택은 현재 실행의 실패를 알리고 정상 선택은 정확한 범위로 완료한다', async () => {
  const env = environment(); const identity = {}; env.stepIdentity = () => identity;
  env.selectFor = async () => null; await assert.rejects(selectStep(env).action.run(), /찾지 못/);
  env.selectFor = async () => { throw new Error('현재 선택 실패'); }; await assert.rejects(selectStep(env).action.run(), /현재 선택 실패/);
  env.selectFor = async chosen => { assert.equal(chosen, text); return env.s.selection = { ...range, endRef: range.ref, text }; };
  const select = selectStep(env); await select.action.run(); assert.equal(select.until(), true);
});

test('custom 타이핑은 같은 제목의 새 실행이 시작되면 이전 입력을 중단한다', async () => {
  const env = environment(); let identity = {}; env.stepIdentity = () => identity; const events = [];
  const input = { tagName: 'TEXTAREA', value: '', isConnected: true, focus() {}, setAttribute() {}, removeAttribute() {},
    dispatchEvent() { events.push(this.value); if (events.length === 1) identity = {}; } };
  env.q = () => input;
  const action = buildCustomAction({ actionId: 'type-text', title: '같은 제목', params: { scope: 'document', selector: '#input', value: '가나다' } }, env);
  const original = globalThis.setTimeout;
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
  try { await action.action.run(); } finally { globalThis.setTimeout = original; }
  assert.equal(input.value, '가'); assert.deepEqual(events, ['가']); assert.equal(action.until(), false);
});

test('custom 타이핑 정상 실행은 입력을 완성하고 직접 클릭은 자동 실행하지 않는다', async () => {
  const env = environment(); const identity = {}; env.stepIdentity = () => identity; env.motionReduced = () => true;
  const input = { tagName: 'INPUT', value: '', isConnected: true, focus() {}, dispatchEvent() {} }; env.q = () => input;
  const type = buildCustomAction({ actionId: 'type-text', title: '정상 입력', params: { scope: 'document', selector: '#input', value: '정상 예시' } }, env);
  await type.action.run(); assert.equal(input.value, '정상 예시'); assert.equal(type.until(), true);
  let clicks = 0; const button = { click() { clicks++; } }; env.q = () => button;
  const click = buildCustomAction({ actionId: 'click-target', title: '직접 클릭', params: { scope: 'document', selector: '#button' } }, env);
  assert.equal(click.click(), button); assert.equal(clicks, 0);
});
