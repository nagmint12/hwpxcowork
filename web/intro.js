// 첫 브라우저 방문의 티저만 여기서 결정한다. 튜토리얼 완료·진행은 서버의 토큰별 기록을 사용한다.
(() => {
  const here = new URL(window.location.href);
  if (here.searchParams.get('teaser') === '0') return;
  try {
    if (localStorage.getItem('hwpx-cowork.teaser3Seen') || localStorage.getItem('hwpx.token')) return;
    localStorage.setItem('hwpx-cowork.teaser3Seen', new Date().toISOString());
  } catch {
    // 저장소가 차단돼도 영상을 한 번 보여 준다. 돌아오는 주소에만 우회 표시를 넣어 무한 이동을 막는다.
    here.searchParams.set('teaser', '0');
  }
  const intro = new URL('/teaser3/', here.origin);
  intro.searchParams.set('intro', '1');
  intro.searchParams.set('next', `${here.pathname}${here.search}${here.hash}`);
  document.documentElement.dataset.introRedirect = '1';
  window.location.replace(`${intro.pathname}${intro.search}`);
})();
