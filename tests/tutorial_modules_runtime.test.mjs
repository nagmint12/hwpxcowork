import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComposedTutorialSteps, resolveTutorialPosition } from '../web/tutorial-modules/compose.js';
import { DEFAULT_TUTORIAL_DEFINITION } from '../web/tutorial-definition.js';
import { buildReportFlow } from '../web/tutorial-modules/report-flow.js';

const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, clipboard: { seq: 0 }, config: { publicUrl: 'https://document.example' },
  saveButton() {}, focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {}, locate() {}, phraseRect() {}, cw() {}, toolbarShown: () => false, selHas: () => false, motionReduced: () => true });
const ref = (moduleId, key = moduleId, extra = {}) => ({ key, moduleId, ...extra });
const compose = (sourceId, modules, env = environment()) => buildComposedTutorialSteps({ sourceId, modules }, env);

test('보고서 수정 실습은 빈 지시를 채우고 직접 입력한 지시는 유지한다', () => {
  const env = environment(); env.s.composer = { phase: 'edit', instruction: '' };
  const step = buildReportFlow(env).find(step => step.title === '3. AI 에게 말하기');
  step.enter(); assert.equal(env.s.composer.instruction, '‘보인다’ 말고, 적절한 표현으로');
  env.s.composer.instruction = '조심스러운 표현으로 바꿔 줘';
  step.enter(); assert.equal(env.s.composer.instruction, '조심스러운 표현으로 바꿔 줘');
  env.s.composer = { phase: 'sending', instruction: '' };
  step.enter(); assert.equal(env.s.composer.instruction, '');
});

test('의견만 남은 빈 검토는 수정 지시로 새로 요청하고 실습이 새 결과를 기다린다', async () => {
  const env = environment(); const target = { ref: 's1/p9', text: '고칠 글' };
  env.s.requests = [{ rid: 1, status: 'done', instruction: '', target }];
  env.ctx.rid1 = 1; env.s.composer = { rid: 1 };
  env.d.request = rid => env.s.requests.find(r => r.rid === rid);
  env.d.retryRequest = () => assert.fail('빈 검토를 그대로 반복하면 안 됨');
  env.d.createRequest = async c => {
    assert.equal(c.kind, 'instruct'); assert.equal(c.target, target);
    assert.equal(c.instruction, '‘보인다’ 말고, 적절한 표현으로');
    env.s.requests.push({ rid: 2, status: 'done', instruction: c.instruction, target });
    return { request: { rid: 2 } };
  };
  const step = buildReportFlow(env).find(step => step.title === '4. AI 가 처리하는 중');
  await step.action.run();
  assert.equal(env.ctx.rid1, 2); assert.equal(env.s.composer.rid, 2);
  env.s.proposals.push({ rid: 1, status: 'pending' }); assert.equal(step.until(), false);
  env.s.proposals.push({ rid: 2, status: 'pending' }); assert.equal(step.until(), true);
  let retried; env.d.retryRequest = async r => { retried = r.rid; };
  env.s.requests[1].status = 'failed';
  await step.action.run(); assert.equal(retried, 2);
});

test('모든 기본 코스는 시작과 완료를 한 번만 제공하며 단계 ID가 유일하다', () => {
  for (const course of DEFAULT_TUTORIAL_DEFINITION.courses) {
    const steps = compose(course.sourceId, course.modules);
    assert.equal(steps[0].id, 'course/intro');
    assert.equal(steps.at(-1).last, true);
    assert.equal(steps.filter(step => step.last).length, 1);
    assert.equal(new Set(steps.map(step => step.id)).size, steps.length, course.id);
    assert.ok(steps.every(step => step.title && step.text && (step.next || step.until || step.click)), course.id);
  }
});

test('그림 변경만 선택하거나 순서를 바꾸면 선택한 모듈만 그 순서로 실행된다', () => {
  const steps = compose('ai-advanced', [ref('image-replace'), ref('guide', 'note', { title: '잠깐 확인', text: '색을 확인하세요.' }), ref('image-create')]);
  assert.deepEqual(steps.slice(1, -1).map(step => step.moduleId), ['image-replace', 'image-replace', 'guide', 'image-create', 'image-create']);
  assert.ok(!steps.some(step => /표 서식과 오탈자|문서 교정|결론 쓰기/.test(step.title)));
  assert.match(steps[0].text, /AI 연결이나 사용료가 필요 없습니다/);
  assert.equal(steps[3].text, '색을 확인하세요.');
});

test('보고서 선택 결과와 복구 위치는 안내나 다른 모듈을 끼워도 자기 모듈에 남는다', async () => {
  const env = environment();
  const at = { ref: 's0/p1', start: 0, end: 17 };
  let available = true;
  env.locate = () => available ? at : null;
  env.selHas = text => !!env.s.selection?.text?.includes(text);
  const steps = compose('report', [ref('guide', 'intro-note', { title: '준비', text: '안내입니다.' }), ref('report-flow', 'first'), ref('report-flow', 'second')], env);
  for (const key of ['first', 'second']) {
    const pick = steps.find(step => step.moduleKey === key && step.title === '고칠 글 고르기');
    assert.equal(pick.action, undefined); env.s.selection = { ...at, text: '일정 부분 기여한 것으로 보인다' }; env.selHas = text => env.s.selection.text.includes(text);
    assert.equal(pick.until(), true);
    assert.equal(steps[steps.indexOf(pick) + 1].title, 'AI에게 맡기기');
    const lost = steps.find(step => step.moduleKey === key && step.title === 'AI에게 맡기기');
    available = false;
    assert.equal(steps[lost.lost()], pick);
    available = true;
  }
});

test('제목 기반 분기와 완료 이동은 같은 모듈에 한정되고 다음 모듈을 건너뛰지 않는다', () => {
  const env = environment();
  const modules = [ref('ai-connections', 'a'), ref('guide', 'between', { title: '다음 실습 준비', text: '이 안내가 생략되면 안 됩니다.' }), ref('ai-connections', 'b')];
  const steps = compose('ai-connect', modules, env);
  env.ctx.modules.b.connectionChoice = 'api';
  const choice = steps.find(step => step.moduleKey === 'b' && step.title === '어떤 AI를 연결할까요');
  const target = choice.action.run();
  assert.equal(steps[target].moduleKey, 'b');
  assert.equal(steps[target].title, '내 AI 키 — 사용료 별도');
  const webEnd = steps.find(step => step.moduleKey === 'a' && step.title === '연결 확인과 사용');
  assert.equal(steps[webEnd.nextIndex].moduleKey, 'between');
});

test('편집 명령은 복사 모듈 없이 시작할 수 있고 휴대폰에서는 복사 대신 붙여넣기 그림 장면을 볼 수 있다', () => {
  const env = environment(); env.touch = true;
  const editing = compose('clipboard', [ref('editing-commands')], env);
  assert.equal(editing[1].title, '편집 명령을 위한 도구 막대');
  assert.ok(editing.some(step => step.title === '글자 모양 열기'));
  assert.ok(!editing.some(step => step.title === '복사할 내용을 직접 선택하기'));
  const transfer = compose('clipboard', [ref('clipboard-transfer'), ref('guide', 'after', { title: '끝 안내', text: '완료 전 안내입니다.' })], environment());
  const mobile = compose('clipboard', [ref('clipboard-transfer'), ref('guide', 'after', { title: '끝 안내', text: '완료 전 안내입니다.' })], env);
  const selection = mobile.find(step => step.title === '복사할 내용을 직접 선택하기');
  assert.equal(mobile[selection.nextIndex].moduleKey, 'clipboard-transfer');
  assert.equal(mobile[selection.nextIndex].scene, 'hangul-paste');
  assert.ok(transfer.some(step => step.title === '한/글에서 웹 편집기로 붙여넣기'));
});

test('반복한 그림 모듈은 앞 모듈의 완료 요청을 자기 결과로 재사용하지 않는다', async () => {
  const env = environment(); let opens = 0;
  env.selectFor = async () => ({ ref: 's0/p1' });
  env.d.openComposer = (_target, _kind, options) => { opens++; env.s.composer = { instruction: '', phase: 'edit', tutorialStep: options.tutorialStep }; };
  const steps = compose('ai-advanced', [ref('image-create', 'a'), ref('image-create', 'b')], env);
  const first = steps.find(step => step.moduleKey === 'a' && step.press === '보내기');
  first.enter(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 1);
  env.s.requests.push({ rid: 1, tutorialStep: 'S1', status: 'done' });
  assert.equal(first.until(), true);
  env.s.composer = null;
  const second = steps.find(step => step.moduleKey === 'b' && step.press === '보내기');
  second.enter(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(opens, 2);
  assert.equal(second.until(), false);
  env.s.requests.push({ rid: 2, tutorialStep: 'S1', status: 'done' });
  assert.equal(second.until(), true);
  assert.equal(env.ctx.modules.a.ridS1, 1);
  assert.equal(env.ctx.modules.b.ridS1, 2);
});

test('안내 문구 편집은 실행 단계를 유지하고 위치 복원은 배열 번호보다 안정 ID를 우선한다', () => {
  const modules = [ref('image-create'), ref('image-replace', 'change', { title: '우리 그림 수정', text: '이 순서로 연습합니다.' })];
  const before = compose('ai-advanced', modules);
  const active = before.find(step => step.moduleKey === 'change' && step.press === '보내기');
  const after = compose('ai-advanced', [...modules].reverse());
  const progress = { i: before.indexOf(active), ctx: { currentStepId: active.id } };
  const found = resolveTutorialPosition(after, progress);
  assert.equal(after[found.index].id, active.id);
  assert.equal(after[1].title, '우리 그림 수정');
  assert.equal(after[1].text, '이 순서로 연습합니다.');
  const withIntro = resolveTutorialPosition(after, progress, true);
  assert.equal(withIntro.index, 0);
  assert.equal(after[withIntro.resumeAfterIntro].id, active.id);
});

test('등록되지 않거나 다른 문서를 요구하는 모듈은 실행하지 않는다', () => {
  assert.throws(() => compose('report', [ref('unknown')]), /등록되지 않은/);
  assert.throws(() => compose('report', [ref('image-create')]), /연습 문서/);
});
