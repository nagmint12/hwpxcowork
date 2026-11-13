import test from 'node:test';
import assert from 'node:assert/strict';
import { typeTutorialPrompt } from '../web/tutorial-motion.js';
import { buildTutorialSteps } from '../web/tutorial-steps.js';

test('타이핑 도중 보낸 요청이나 닫힌 창·새 창을 늦은 글자가 덮어쓰지 않는다', async () => {
  for (const mode of ['send', 'close', 'edit']) {
    const composer = { phase: 'edit', instruction: '' }; let current = true;
    await typeTutorialPrompt({ composer, text: '가나다', current: () => current, wait: async () => {
      if (!composer.instruction) return;
      if (mode === 'send') composer.phase = 'sending';
      if (mode === 'close') current = false;
      if (mode === 'edit') composer.instruction = '직접 쓴 요청';
    } });
    assert.equal(composer.instruction, mode === 'edit' ? '직접 쓴 요청' : '가');
    assert.equal(composer.tutorialTyping, false);
  }
});

test('모션 줄이기는 한 번에 완성하고 대기 실패에도 입력 잠금을 해제한다', async () => {
  const composer = { phase: 'edit', instruction: '' };
  await typeTutorialPrompt({ composer, text: '가상 입력', current: () => true, reduced: true, wait: async () => {} });
  assert.equal(composer.instruction, '가상 입력'); assert.equal(composer.tutorialTyping, false);
  await assert.rejects(typeTutorialPrompt({ composer, text: '새 요청', current: () => true, wait: async () => { throw Error('cancel'); } }));
  assert.equal(composer.tutorialTyping, false);
});

test('첫 답변이 WS로 먼저 완료되어도 전송 마무리를 기다리고 새로고침 뒤 같은 결과를 이어 본다', () => {
  const env = { d: {}, s: { requests: [{rid: 3, tutorialStep: 'S1', status: 'done'}], proposals: [], sending: 1 }, ctx: {},
    q() {}, pad() {}, rectOf() {}, locate() {}, focusIn() {}, frameRect() {} };
  const steps = buildTutorialSteps('ai-advanced', env);
  steps[1].enter(); // 이미 완료한 S1은 요청 창을 다시 열지 않는다.
  assert.equal(steps[1].until(), false);
  assert.equal(env.ctx.ridS1, 3);
  env.s.sending = 0;
  assert.equal(steps[1].until(), true);
  assert.equal(steps[2].idle(), true);
  assert.doesNotMatch(steps[2].text(), /답변을 넣지 못했습니다|기다리는 중/);
  env.s.proposals.push({pid: 7, rid: 3, status: 'pending'});
  assert.equal(steps[2].until(), false);
  env.s.proposals[0].status = 'applied';
  assert.equal(steps[2].until(), true);
});

test('타이핑 중 동작 예시를 끄면 나머지 문장을 한 번에 채우고 전송 잠금을 푼다', async () => {
  const composer = { phase: 'edit', instruction: '' }; let reduce = false;
  await typeTutorialPrompt({ composer, text: '가나다라마', current: () => true, reduced: () => reduce,
    wait: async () => { if (composer.instruction.length >= 2) reduce = true; } });
  assert.equal(composer.instruction, '가나다라마'); assert.equal(composer.tutorialTyping, false);
});
