import { DEFAULT_TUTORIAL_DEFINITION } from './tutorial-definition.js';

// 서버의 현재 메뉴 순서를 따른다. 인수 생략은 이전 호출·테스트와의 호환용이다.
export function nextTutorialId(id, courses = DEFAULT_TUTORIAL_DEFINITION.courses) {
  const ids = courses.filter(course => typeof course === 'string' || course.enabled !== false).map(course => typeof course === 'string' ? course : course.id);
  const i = ids.indexOf(id); return i >= 0 ? ids[i + 1] || null : null;
}

// 이전에 완료한 단계로 돌아가도 자동 조건이 곧바로 앞으로 보내지 않게 읽기 모드로 둔다.
export function tutorialNavigation(start = 0, furthest = start) {
  let index = start; let high = Math.max(start, furthest); let reviewing = false;
  return {
    move(next, previous = false) { reviewing = previous || (reviewing && next < high); index = next; high = Math.max(high, index); return { index, high, reviewing }; },
    get reviewing() { return reviewing; }, get high() { return high; },
  };
}
