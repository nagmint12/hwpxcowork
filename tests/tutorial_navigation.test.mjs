import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTutorialId, tutorialNavigation } from '../web/tutorial-navigation.js';

test('튜토리얼 마지막은 다음 항목으로 이어지고 관리자 참고 문서는 마지막이다', () => {
  // 2026-11-12: AI 작업 튜토리얼을 앞에, 한/글 편집 기능 소개(overview·clipboard)는 AI 튜토리얼 뒤로
  const ids = ['report', 'ai-work', 'ai-requests', 'ai-connect', 'ai-advanced', 'overview', 'clipboard', 'admin'];
  for (let i = 0; i < ids.length; i++) assert.equal(nextTutorialId(ids[i]), ids[i + 1] || null);
  assert.equal(nextTutorialId('unknown'), null);
});

test('이전 단계를 읽을 때 이미 끝낸 자동 조건으로 즉시 앞으로 이동하지 않는다', () => {
  const nav = tutorialNavigation(4, 4);
  nav.move(3, true); assert.equal(nav.reviewing, true);
  nav.move(2, true); assert.equal(nav.reviewing, true);
  nav.move(3); assert.equal(nav.reviewing, true);
  nav.move(4); assert.equal(nav.reviewing, false, '진행하던 단계로 돌아오면 실제 연습을 계속한다');
  nav.move(5); assert.equal(nav.reviewing, false);
  assert.equal(nav.high, 5);
});
