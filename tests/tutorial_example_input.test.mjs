import test from 'node:test';
import assert from 'node:assert/strict';
import { typeInTutorialField, typeInTutorialComposer } from '../web/tutorial-modules/common.js';
import { buildReportFlow } from '../web/tutorial-modules/report-flow.js';
import { buildEditorBasics } from '../web/tutorial-modules/editor-basics.js';
import { buildAiReview } from '../web/tutorial-modules/ai-review.js';
import { buildAdvanced } from '../web/tutorial-modules/advanced.js';
import { buildCustomAction } from '../web/tutorial-modules/custom-actions.js';

class Input extends EventTarget {
  value = ''; isConnected = true;
  focus() { this.focused = true; }
}
const environment = () => ({ describe: true, d: {}, s: { info: {}, paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, config: {}, clipboard: {},
  focusIn() {}, rectOf() {}, pad: x => x, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, locate() {}, phraseRect() {}, cw() {}, toolbarShown: () => false, selHas: () => false,
  isCurrentStep: () => true, motionReduced: () => false });

test('명시적으로 예시 작성을 누르면 효과 설정과 무관하게 즉시 한 번 입력하고 전송하지 않는다', async () => {
  const env = environment(); const input = new Input(); let inputs = 0; let submits = 0;
  input.addEventListener('input', () => inputs++); input.addEventListener('submit', () => submits++);
  const fill = typeInTutorialField(env, input, '예시 답글', null, { instant: true });
  assert.equal(input.value, '예시 답글'); assert.equal(inputs, 1); assert.equal(input.focused, true);
  await fill; input.value = '바로 고친 답글'; await Promise.resolve();
  assert.equal(input.value, '바로 고친 답글'); assert.equal(submits, 0);
  env.s.composer = { phase: 'edit', instruction: '' };
  const prompt = typeInTutorialComposer(env, '예시 요청', null, { instant: true });
  assert.equal(env.s.composer.instruction, '예시 요청'); assert.equal(env.s.composer.tutorialTyping, false);
  await prompt; assert.equal(env.s.composer.phase, 'edit');
});

test('보고서의 요청·메모·답글·차례는 각자 예시를 채우고 실제 전송을 기다린다', async () => {
  const env = environment(); const memoInput = new Input(); const replyInput = new Input();
  const card = {};
  env.locate = phrase => ({ ref: phrase === '학생 만족도' ? 's0/p2' : 's0/p1', start: 0, end: [...phrase].length });
  env.s.paragraphs = [{ ref: 's0/p0', text: '<제목 차례>' }];
  env.s.composer = { kind: 'instruct', phase: 'edit', instruction: '', target: env.locate('일정 부분 기여한 것으로 보인다') };
  env.s.popover = { kind: 'memo', target: env.locate('학생 만족도'), text: '' };
  env.ctx.memoId = 'm1'; env.s.memos = [{ id: 'm1', ref: 's0/p2' }];
  env.d.request = () => null; env.d.memo = id => env.s.memos.find(m => m.id === id);
  env.d.openComposer = (target, kind, options) => { env.s.composer = { target, kind, phase: 'edit', ...options }; };
  env.q = (selector, root) => selector === '.popover .memoedit textarea' ? memoInput : selector.startsWith('.rcard[') ? card : root === card && selector === '.memoedit' ? card : root === card && selector === '.memoedit textarea' ? replyInput : null;
  memoInput.addEventListener('input', () => { env.s.popover.text = memoInput.value; });
  const steps = buildReportFlow(env);
  for (const i of [3, 8, 10, 13]) { assert.equal(steps[i].action.label, '대신 예시 작성하기'); assert.ok(steps[i].action.exampleText); await steps[i].action.run(); assert.equal(steps[i].until(), false); }
  assert.equal(memoInput.value, '근거로 [표 1]을 함께 제시해 주세요.');
  assert.equal(replyInput.value, '이 메모대로 문장을 고쳐 줘');
  assert.equal(env.s.composer.instruction, '차례 새로고침해줘');
  assert.equal(env.s.requests.length, 0); assert.equal(env.s.memos.length, 1);
});

test('둘러보기 메모·답글과 AI 요청에는 해당 단계의 예시가 제공된다', async () => {
  const env = environment(); const input = new Input(); const box = { querySelector: () => input };
  env.q = () => box; env.ctx.overviewMemoId = 'm1'; env.s.memos = [{ id: 'm1', thread: { replies: [] } }];
  const steps = buildEditorBasics(env);
  for (const title of ['메모를 직접 남기기', '답글도 남겨 보기']) {
    const step = steps.find(s => s.title === title); await step.action.run(); assert.equal(input.value, step.action.exampleText); assert.equal(step.until(), false);
  }
  env.s.composer = { phase: 'edit', instruction: '' };
  const ai = buildAiReview(env)[2]; await ai.action.run(); assert.equal(env.s.composer.instruction, ai.action.exampleText);
  const task = { id: 'S1', title: '그림 만들기', prompt: '이 표를 그림으로 보여 줘', target: { doc: true } };
  env.s.composer.tutorialStep = 'S1';
  const advanced = buildAdvanced(env, [task])[1]; await advanced.action.run(); assert.equal(env.s.composer.instruction, task.prompt); assert.equal(advanced.until(), false);
});

test('사용자 구성의 입력 예시는 정한 칸에만 쓰며 읽기 전용 칸은 바꾸지 않는다', async () => {
  const env = environment(); const input = new Input(); env.fdoc = () => ({ querySelector: selector => selector === '#example' ? input : null });
  const step = buildCustomAction({ actionId: 'type-text', title: '예시', params: { scope: 'editor', selector: '#example', value: '정한 예시' } }, env);
  assert.equal(input.value, ''); await step.action.run(); assert.equal(step.until(), true);
  input.value = '보호된 글'; input.readOnly = true;
  assert.throws(() => step.action.run(), /입력할 수 없는/); assert.equal(input.value, '보호된 글');
});
