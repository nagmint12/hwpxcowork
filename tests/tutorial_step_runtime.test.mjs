import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComposedTutorialSteps, describeTutorialModule, validateTutorialStepReferences, resolveTutorialPosition } from '../web/tutorial-modules/compose.js';
import { TUTORIAL_MODULES } from '../web/tutorial-definition.js';

const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, config: {}, clipboard: {},
  dragHow: '끌어', saveButton() {}, focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {}, locate() {}, phraseRect() {}, cw() {}, toolbarShown: () => false, selHas: () => false, motionReduced: () => true });
const refsFor = moduleId => describeTutorialModule(moduleId).steps.map(step => ({ key: step.stepId, kind: 'builtin', stepId: step.stepId }));
const course = (modules, sourceId = 'report') => ({ sourceId, modules });
const entry = (steps, extra = {}) => ({ key: 'report', moduleId: 'report-flow', steps, ...extra });

test('단계 목록은 DOM과 네트워크 없이 결과보고서 15개 행동과 준비 조건을 설명한다', () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('설명 목록에서 네트워크를 읽으면 안 됩니다'); };
  try {
    for (const module of TUTORIAL_MODULES) assert.ok(Array.isArray(describeTutorialModule(module.id).steps));
    const report = describeTutorialModule('report-flow').steps;
    assert.equal(report.length, 15);
    assert.equal(new Set(report.map(step => step.stepId)).size, 15);
    assert.ok(report.every(step => step.title && step.text && step.actionKind && step.target && step.completion && step.handlerId));
    assert.ok(!/^\d+\./.test(report[0].title));
    assert.deepEqual(report[0].dependsOn, []);
    assert.deepEqual(report[1].dependsOn, [report[0].stepId]);
    assert.deepEqual(report[5].dependsOn, []);
    assert.deepEqual(report[12].dependsOn, []);
    assert.deepEqual(report[14].dependsOn, []);
  } finally { globalThis.fetch = oldFetch; }
});

test('개별 문구를 수정하고 안내를 끼워 넣어도 빠른 선택은 그 안내를 넘기지 않는다', async () => {
  const env = environment(); const at = { ref: 's0/p1', start: 0, end: 17 };
  env.locate = () => at; env.selectExact = async text => { env.s.selection = { ...at, text }; };
  const refs = refsFor('report-flow');
  refs[0].title = '첫 문장 고르기'; refs[0].text = '수정한 안내'; refs[0].next = '조건 우회 금지';
  refs.splice(1, 0, { key: 'notice', kind: 'custom', actionId: 'notice', title: '선택 확인', text: '선택 상태를 확인하세요.' });
  const steps = buildComposedTutorialSteps(course([entry(refs)]), env);
  assert.equal(steps.length, 18);
  assert.equal(steps[1].title, '첫 문장 고르기');
  assert.equal(steps[1].text, '수정한 안내');
  assert.equal(steps[1].originalTitle, '1. 고칠 글 고르기');
  assert.equal(steps[1].next, undefined, '버튼 문구는 자동 완료 조건을 없애지 않음');
  assert.equal(await steps[1].action.run(), undefined);
  assert.equal(steps[1].until(), true);
  assert.equal(steps[2].title, '선택 확인');
});

test('독립 실습 묶음은 이동·제거할 수 있고 누락되거나 뒤에 놓인 준비 단계는 저장 전에 알린다', () => {
  const refs = refsFor('report-flow');
  const valid = entry([refs[14], ...refs.slice(5, 12), ...refs.slice(0, 5)]);
  validateTutorialStepReferences({ courses: [course([valid])] });
  const steps = buildComposedTutorialSteps(course([valid]), environment());
  assert.equal(steps[1].title, '한글로 저장');
  assert.ok(!steps.some(step => step.title === '차례도 AI 에게'));
  assert.throws(() => validateTutorialStepReferences({ courses: [course([entry(refs.slice(1))])] }), /고칠 글 고르기/);
  assert.throws(() => validateTutorialStepReferences({ courses: [course([entry([refs[1], refs[0]])])] }), /준비 단계/);
});

test('등록된 custom 동작은 복잡한 기존 행동과 상태를 그대로 연결한다', async () => {
  const specs = describeTutorialModule('report-flow').steps;
  const refs = refsFor('report-flow').slice(0, 5);
  refs[0] = { key: 'custom-select', kind: 'custom', actionId: 'registered-handler', title: '직접 연결한 선택 행동', text: '원래 선택 기능을 사용합니다.', params: { handlerId: specs[0].handlerId } };
  const env = environment(); const at = { ref: 's0/p1', start: 0, end: 17 };
  env.locate = () => at; env.selectExact = async text => { env.s.selection = { ...at, text }; };
  const steps = buildComposedTutorialSteps(course([entry(refs)]), env);
  await steps[1].action.run();
  assert.equal(steps[1].until(), true);
  assert.equal(steps[2].title, 'AI에게 맡기기');
  assert.equal(steps[1].id, 'report/custom/custom-select');
  const duplicates = [...refs, { key: 'duplicate', kind: 'builtin', stepId: specs[0].stepId }];
  assert.throws(() => validateTutorialStepReferences({ courses: [course([entry(duplicates)])] }), /한 번/);
  assert.throws(() => validateTutorialStepReferences({ courses: [course([entry([{ ...refs[0], params: { handlerId: 'image-create:unknown' } }])])] }), /연습 문서/);
});

test('custom 모듈은 직접 클릭·글 선택·타이핑을 연결하고 전송을 자동 실행하지 않는다', async () => {
  const input = { tagName: 'TEXTAREA', value: '', isConnected: true, focus() {}, dispatchEvent() {} };
  const button = { clicked: 0, click() { this.clicked++; } };
  const env = environment(); env.q = selector => selector === '#input' ? input : button;
  env.locate = text => ({ ref: 's0/p1', start: 0, end: [...text].length });
  env.selectFor = async text => { env.selected = text; return env.s.selection = { ...env.locate(text), endRef: 's0/p1', refs: ['s0/p1'], text }; }; env.selHas = text => env.selected === text;
  const modules = [{ key: 'mine', moduleId: 'custom', motion: false, steps: [
    { key: 'click', kind: 'custom', actionId: 'click-target', title: '직접 클릭', text: '버튼을 직접 누릅니다.', params: { scope: 'document', selector: '#button' } },
    { key: 'type', kind: 'custom', actionId: 'type-text', title: '예시 입력', text: '문장을 입력합니다.', params: { scope: 'document', selector: '#input', value: '입력 예시' } },
    { key: 'select', kind: 'custom', actionId: 'select-text', title: '글 선택', text: '글을 고릅니다.', params: { text: '문서의 글' } },
  ] }];
  const steps = buildComposedTutorialSteps(course(modules), env);
  assert.equal(steps[1].click(), button); assert.equal(button.clicked, 0);
  assert.equal(steps[2].motionEnabled, false);
  await steps[2].action.run(); assert.equal(input.value, '입력 예시'); assert.equal(steps[2].until(), true);
  await steps[3].action.run(); assert.equal(steps[3].until(), true); assert.equal(button.clicked, 0);
});

test('효과를 단계별로 끄고 모듈 전체에서 끌 수 있으며 단계 편집 뒤에도 ID로 이어한다', () => {
  const refs = refsFor('report-flow'); refs[0].motion = false;
  const before = buildComposedTutorialSteps(course([entry(refs)]), environment());
  assert.equal(before[1].motionEnabled, false); assert.equal(before[2].motionEnabled, true);
  const progress = { i: 1, ctx: { currentStepId: before[3].id } };
  refs.unshift({ key: 'intro', kind: 'custom', actionId: 'notice', title: '추가 안내', text: '읽고 진행합니다.' });
  const after = buildComposedTutorialSteps(course([entry(refs, { motion: false })]), environment());
  assert.equal(after[resolveTutorialPosition(after, progress).index].id, before[3].id);
  assert.ok(after.slice(1, -1).every(step => step.motionEnabled === false));
});

test('모바일 준비 단계가 포함된 저장 구성은 PC에서 해당 단계만 생략한다', () => {
  const refs = refsFor('clipboard-transfer');
  const config = course([{ key: 'copy', moduleId: 'clipboard-transfer', steps: refs }], 'clipboard');
  const pc = buildComposedTutorialSteps(config, environment());
  const phone = buildComposedTutorialSteps(config, { ...environment(), touch: true });
  assert.ok(!pc.some(step => step.title === '편집 도구 막대 켜기'));
  assert.ok(phone.some(step => step.title === '편집 도구 막대 켜기'));
});

test('선택 해제한 편집 행동을 되살리지 않고 남은 다음 단계로 안내한다', () => {
  // 현재 사용자가 고른 조합을 재현하며 실제 data/ 설정을 시험에서 읽지 않습니다.
  const enabled = new Set(['그림·도형의 크기', '조판 부호 켜기', '모양 복사']);
  const selected = describeTutorialModule('editing-commands').steps.map(step => ({ key: step.stepId, kind: 'builtin', stepId: step.stepId, enabled: enabled.has(step.title) }));
  const edited = { key: 'editing', moduleId: 'editing-commands', steps: selected };
  const steps = buildComposedTutorialSteps(course([{ key: 'copy', moduleId: 'clipboard-transfer' }, edited], 'clipboard'), environment());
  assert.deepEqual(steps.filter(step => step.moduleKey === 'editing').map(step => step.title), [...enabled]);
  const copyEnd = steps.filter(step => step.moduleKey === 'copy').at(-1);
  assert.equal(copyEnd.next, '다음 모듈로');
  const editEnd = steps.filter(step => step.moduleKey === 'editing').at(-1);
  assert.equal(editEnd.next, '연습 마치기');
  assert.ok(!steps.some(step => step.next === '글자 모양 보기' || step.next === '반대로 붙여넣기 알아보기'));
  selected.at(-1).next = '직접 편집한 이동 문구';
  const customized = buildComposedTutorialSteps(course([edited], 'clipboard'), environment());
  assert.equal(customized.at(-2).next, '직접 편집한 이동 문구');
});

test('코스 순서가 바뀌어도 AI 작업 안내는 고정 코스 번호를 지시하지 않는다', () => {
  const steps = buildComposedTutorialSteps(course([{ key: 'review', moduleId: 'ai-review' }], 'ai-requests'), environment());
  const finalAdvice = steps.find(step => step.title === '실제 작업을 보내기 전');
  assert.match(finalAdvice.text, /‘AI 연결’/);
  assert.doesNotMatch(finalAdvice.text, /다음 \d+번/);
});

test('붙여넣기 검사·영상 대신 그림 장면으로 바뀐 단계도 저장된 선택과 진행 ID를 이어받는다', () => {
  const oldStepId = '1s3lf9h';
  const spec = describeTutorialModule('clipboard-transfer').steps.find(step => step.stepId === oldStepId);
  assert.equal(spec.actionKind, 'scene');
  assert.equal(spec.title, '한/글에 붙여넣는 흐름');
  const steps = buildComposedTutorialSteps(course([{ key: 'copy', moduleId: 'clipboard-transfer', steps: [{ key: oldStepId, kind: 'builtin', stepId: oldStepId }] }], 'clipboard'), environment());
  assert.equal(steps[1].scene, 'hangul-paste');
  const stableId = `copy/${TUTORIAL_MODULES.find(module => module.id === 'clipboard-transfer').version}/${oldStepId}`;
  assert.equal(steps[1].id, stableId);
  assert.equal(resolveTutorialPosition(steps, { i: 99, ctx: { currentStepId: stableId } }).index, 1);
  assert.equal(resolveTutorialPosition(steps, { i: 99, ctx: { currentStepId: `copy/1/${oldStepId}` } }).index, 1, '이전 모듈 버전의 같은 행동부터 이어하기');
});
