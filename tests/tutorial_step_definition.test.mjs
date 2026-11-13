import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTutorialDefinition, normalizeTutorialDefinition } from '../web/tutorial-definition.js';
import { describeTutorialModule, validateTutorialStepReferences } from '../web/tutorial-modules/compose.js';
import { startServer } from './helpers/server.mjs';

test('모듈과 단계별 모션, 단계 문구 및 custom 행동 설정은 보존된다', () => {
  const definition = defaultTutorialDefinition();
  const module = definition.courses[0].modules[0];
  module.motion = false;
  const steps = describeTutorialModule('report-flow').steps;
  assert.equal(steps.length, 15);
  module.steps = steps.map(step => ({ key: step.stepId, kind: 'builtin', stepId: step.stepId }));
  module.steps[0].title = '직접 고칠 문장 선택';
  module.steps[0].text = '선택할 문구를 확인해 주세요.';
  module.steps[0].motion = false;
  module.steps.splice(1, 0, { key: 'note', kind: 'custom', actionId: 'notice', title: '선택 확인', text: '골라진 문구를 확인하세요.', params: {} });
  const result = normalizeTutorialDefinition(definition);
  validateTutorialStepReferences(result);
  assert.deepEqual(result.courses[0].modules[0], module);
});

test('잘못된 효과 설정, 등록되지 않은 행동과 다른 원본 handler를 거절한다', () => {
  for (const mutate of [
    module => { module.motion = 'false'; },
    module => { module.steps = [{ key: 'a', kind: 'custom', actionId: 'eval', title: '실행', text: '설명', params: {} }]; },
    module => { module.steps = [{ key: 'a', kind: 'custom', actionId: 'type-text', title: '입력', text: '설명', params: { scope: 'external', selector: '#field', value: '예시' } }]; },
    module => { module.steps = [{ key: 'a', kind: 'custom', actionId: 'registered-handler', title: '동작', text: '설명', params: { handlerId: 'image-create:unknown' } }]; },
    module => { module.steps = [{ key: 'a', kind: 'custom', actionId: 'notice', title: '안내', text: '설명', params: { script: 'alert(1)' } }]; },
  ]) {
    const definition = defaultTutorialDefinition(); mutate(definition.courses[0].modules[0]);
    assert.throws(() => normalizeTutorialDefinition(definition));
  }
});

test('단계 구성 API는 원래 15단계를 보존하며 변경 문구·효과·custom을 새 세션에 고정한다', async () => {
  const server = await startServer();
  try {
    const admin = server.api('admin'); const user = server.api('a');
    const snapshot = await admin('/api/tutorial/definition');
    const original = await user('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } });
    const oldInfo = await user(`/api/docs/${original.docId}`);
    const module = snapshot.definition.courses.find(course => course.id === 'report').modules[0];
    const specs = describeTutorialModule('report-flow').steps;
    module.motion = false;
    module.steps = specs.map(step => ({ key: step.stepId, kind: 'builtin', stepId: step.stepId }));
    module.steps[0].text = '수정한 첫 번째 안내입니다.';
    module.steps.push({ key: 'finish-note', kind: 'custom', actionId: 'notice', title: '마무리 확인', text: '저장 전에 결과를 확인하세요.', params: {}, motion: false });
    const saved = await admin('/api/tutorial/definition', { method: 'PUT', body: { definition: snapshot.definition, revision: snapshot.revision } });
    const started = await user('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } });
    const info = await user(`/api/docs/${started.docId}`);
    assert.deepEqual(info.tutorialModules[0], module);
    assert.deepEqual((await user(`/api/docs/${original.docId}`)).tutorialModules, oldInfo.tutorialModules);
    assert.equal((await admin('/api/tutorial/definition')).revision, saved.revision);
    const invalid = structuredClone(saved.definition);
    invalid.courses[0].modules[0].steps[0].stepId = 'missing';
    const bad = await admin.res('/api/tutorial/definition', { method: 'PUT', body: { definition: invalid, revision: saved.revision } });
    assert.equal(bad.status, 400);
    const reordered = structuredClone(saved.definition);
    reordered.courses[0].modules[0].steps.reverse();
    assert.equal((await admin.res('/api/tutorial/definition', { method: 'PUT', body: { definition: reordered, revision: saved.revision } })).status, 400);
    await server.restart();
    assert.deepEqual((await admin('/api/tutorial/definition')).definition, saved.definition);
  } finally { await server.stop(); }
});
