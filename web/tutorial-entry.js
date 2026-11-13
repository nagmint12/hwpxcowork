// 서버의 토큰별 결과보고서 완료 여부로 로그인 첫 화면을 정한다.
export async function prepareTutorialEntry(me, requested = '#/', request) {
  if (!me?.tutorial || !me.tutorialIntroRequired) return { route: requested };
  const result = await request('/api/tutorial/entry', { method: 'POST', body: {} });
  return result.skipped ? { route: requested } : { route: `#/doc/${result.docId}`, introDocId: result.docId };
}
