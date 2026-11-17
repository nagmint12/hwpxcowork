// 모듈 판이 바뀌어도 같은 행동 ID의 복구 지점을 사용합니다.
export function tutorialStepKey(id) {
  return typeof id === 'string' && id ? id.replace(/^([^/]+)\/\d+\/([^/]+)$/, '$1/$2') : null;
}
