import test from 'node:test';
import assert from 'node:assert/strict';
import { createTutorialMotion, tutorialMotionSpec, typeTutorialInput } from '../web/tutorial-motion.js';
import { buildTutorialSteps } from '../web/tutorial-steps.js';
import { buildReportFlow } from '../web/tutorial-modules/report-flow.js';
import { typeInTutorialField } from '../web/tutorial-modules/common.js';

const rectangle = { x: 20, y: 30, w: 150, h: 25 };
function fakeInput(value = '') {
  return { value, isConnected: true, attributes: {}, events: [],
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    dispatchEvent(event) { this.events.push(event.type); }, focus() {}, ownerDocument: { defaultView: { Event } } };
}
const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, describe: true,
  config: { publicUrl: 'https://document.example' }, q() {}, pad() {}, rectOf() {}, locate() {}, focusIn() {}, frameRect() {}, phraseRect() {},
  fdoc() {}, inFrame() {}, selectFor() {}, cw() {}, clipboard: {}, toolbarShown: () => false, selHas: () => false, motionReduced: () => true });

test('1~6 문서의 일반 안내 대상에 클릭·선택 포인터를 적용하고 모듈 효과 끄기를 지킨다', () => {
  for (const id of ['report', 'overview', 'clipboard', 'ai-requests', 'ai-connect', 'ai-advanced']) {
    const steps = id === 'report' ? buildReportFlow(environment()) : buildTutorialSteps(id, environment());
    const step = steps.find(step => step.ring || step.example);
    const spec = tutorialMotionSpec({ ...step, motion: undefined }, { target: rectangle });
    assert.equal(spec.rect, rectangle, id);
    assert.ok(['drag', 'click'].includes(spec.mode), id);
    assert.equal(tutorialMotionSpec({ ...step, motionEnabled: false }, { target: rectangle }), null, id);
  }
  assert.equal(tutorialMotionSpec({ title: '고칠 글 고르기' }, { target: rectangle }).mode, 'drag');
  assert.equal(tutorialMotionSpec({ title: '요청 입력' }, { target: rectangle, typingRect: rectangle }).mode, 'typing');
});

test('동작 줄이기 또는 효과 끄기는 포인터 자체를 숨긴다', () => {
  const label = { textContent: '' }; let pointer;
  const doc = { defaultView: { innerWidth: 800, innerHeight: 600, matchMedia: () => ({ matches: false }) },
    createElement() { pointer = { style: {}, classList: { toggle() {} }, setAttribute() {}, querySelector: () => label, remove() {} }; return pointer; } };
  let reduced = false; const motion = createTutorialMotion({ ownerDocument: doc, append() {} }, { reduced: () => reduced });
  motion.update({ rect: rectangle, mode: 'drag' }, 1000, 1);
  assert.equal(pointer.hidden, false); assert.equal(label.textContent, '끌어 선택 예시');
  reduced = true; motion.update({ rect: rectangle, mode: 'typing' }, 2000, 1);
  assert.equal(pointer.hidden, true);
});

test('일반 입력 타이핑은 사용자 수정·단계 이동·제거 뒤 글을 덮지 않는다', async () => {
  for (const mode of ['edit', 'step', 'detach']) {
    const input = fakeInput(); let active = true;
    await typeTutorialInput({ input, text: '가나다', current: () => active, wait: async () => {
      if (!input.value) return;
      if (mode === 'edit') input.value = '사용자가 쓴 글';
      if (mode === 'step') active = false;
      if (mode === 'detach') input.isConnected = false;
    } });
    assert.equal(input.value, mode === 'edit' ? '사용자가 쓴 글' : '가');
    assert.equal(input.attributes['data-tutorial-typing'], undefined);
    assert.deepEqual(input.events, ['input']);
  }
});

test('효과를 끄면 입력을 기다리지 않고 즉시 채우고 중간 해제도 나머지를 완성한다', async () => {
  const immediate = fakeInput(); let waits = 0;
  const done = typeTutorialInput({ input: immediate, text: '즉시 입력', reduced: true, wait: async () => { waits++; } });
  assert.equal(immediate.value, '즉시 입력'); await done; assert.equal(waits, 0);
  const input = fakeInput(); let reduced = false;
  await typeTutorialInput({ input, text: '가나다라마', reduced: () => reduced, wait: async () => { if (input.value.length > 1) reduced = true; } });
  assert.equal(input.value, '가나다라마');
});

test('보고서 예시 요청은 공통 타이핑으로 채우되 요청을 전송하지 않는다', async () => {
  const env = environment(); env.s.composer = { phase: 'edit', instruction: '' };
  env.d.createRequest = () => { throw new Error('자동 전송하면 안 됩니다'); };
  const steps = buildReportFlow(env);
  await steps.find(step => step.title === '3. AI 에게 말하기').action.run();
  assert.equal(env.s.composer.instruction, '‘보인다’ 말고, 적절한 표현으로');
  assert.equal(env.s.composer.tutorialTyping, false);
});

test('메모 입력 시연은 다른 답글이나 새 단계로 이동하면 중단할 수 있다', async () => {
  const env = environment(); const input = fakeInput();
  const identity = {}; env.stepIdentity = () => identity;
  await typeInTutorialField(env, input, '메모 예시');
  assert.equal(input.value, '메모 예시');
  assert.deepEqual(input.events, ['input']);
});

test('복사는 한/글 붙여넣기 그림 장면과 따라하기 안내, 연결은 읽기 전용 입력 예시를 제공한다', () => {
  const clipboard = buildTutorialSteps('clipboard', environment());
  const connections = buildTutorialSteps('ai-connect', environment());
  assert.equal(typeof clipboard.find(step => step.title === '한/글에 붙여넣기').example, 'function');
  assert.equal(clipboard.find(step => step.title === '한/글에 붙여넣는 흐름').scene, 'hangul-paste');
  assert.equal(typeof connections.find(step => step.title === 'ChatGPT 웹 — 주소와 OAuth').example, 'function');
  assert.equal(clipboard.find(step => step.title === '선택한 내용을 실제로 복사하기').quick, undefined);
});
