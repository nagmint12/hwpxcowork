// 서버의 토큰별 결과보고서 완료 여부로 로그인 첫 화면을 정한다.
export async function prepareTutorialEntry(me, requested = '#/', request) {
  if (!me?.tutorial || !me.tutorialIntroRequired) return { route: requested };
  // 복구·새로고침은 이미 선택한 본인의 연습에서 이어간다. 서버의 문서 접근 검사로
  // 확인하며, URL만 보고 첫 안내를 건너뛰거나 다른 사람의 연습을 열지 않는다.
  const docId = /^#\/doc\/([\w-]+)(?:[/?]|$)/.exec(requested)?.[1];
  if (docId) {
    try {
      const doc = await request(`/api/docs/${docId}`);
      if (doc?.tutorialSession && !doc.tutorialCompletedAt) return { route: requested };
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
    }
  }
  const result = await request('/api/tutorial/entry', { method: 'POST', body: {} });
  return result.skipped ? { route: requested } : { route: `#/doc/${result.docId}`, introDocId: result.docId };
}
