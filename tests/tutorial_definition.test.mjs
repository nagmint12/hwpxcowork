import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTutorialDefinition, normalizeTutorialDefinition } from '../web/tutorial-definition.js';
import { nextTutorialId } from '../web/tutorial-navigation.js';

test('구성은 독립 복사되며 기본 모듈 정의를 그대로 검증한다', () => {
  const definition = defaultTutorialDefinition();
  assert.deepEqual(normalizeTutorialDefinition(definition), definition);
  definition.courses[0].modules[0].key = 'changed';
  assert.equal(defaultTutorialDefinition().courses[0].modules[0].key, 'report-flow');
});

test('그림 모듈의 순서 변경과 자유 안내 삽입을 허용한다', () => {
  const definition = defaultTutorialDefinition();
  definition.entryCourseId = null;
  const course = definition.courses.find(item => item.id === 'ai-advanced');
  definition.courses = [course];
  course.modules = [
    { key: 'before', moduleId: 'guide', title: '연습 준비', text: '그림 변경부터 시작합니다.' },
    { key: 'replace', moduleId: 'image-replace' },
    { key: 'create', moduleId: 'image-create', text: '표를 먼저 확인하세요.' },
    { key: 'after', moduleId: 'guide', title: '확인', text: '결과를 비교하세요.' },
  ];
  assert.deepEqual(normalizeTutorialDefinition(definition).courses[0].modules, course.modules);
  course.modules.push({ key: 'replace-again', moduleId: 'image-replace' });
  assert.throws(() => normalizeTutorialDefinition(definition), /한 번/);
});

test('빈 안내와 실행 코드·없는 모듈·호환되지 않는 원본은 거절한다', () => {
  for (const change of [
    d => { d.courses[0].modules = []; },
    d => { d.courses[0].modules = [{ key: 'guide', moduleId: 'guide', title: '제목', text: '' }]; },
    d => { d.courses[0].modules[0].moduleId = 'no-such-module'; },
    d => { d.courses[0].modules[0].moduleId = 'editing-commands'; },
    d => { d.courses[0].modules[0].run = 'window.alert(1)'; },
    d => { d.courses[0].enabled = false; },
  ]) {
    const definition = defaultTutorialDefinition(); change(definition);
    assert.throws(() => normalizeTutorialDefinition(definition));
  }
});

test('다음 튜토리얼은 현재 구성 순서와 사용 여부를 따른다', () => {
  const courses = [{ id: 'pictures' }, { id: 'hidden', enabled: false }, { id: 'commands' }];
  assert.equal(nextTutorialId('pictures', courses), 'commands');
  assert.equal(nextTutorialId('commands', courses), null);
  assert.equal(nextTutorialId('removed', courses), null);
  assert.equal(nextTutorialId('report', []), null);
});