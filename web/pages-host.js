// GitHub Pages 에 끼워 연 화면인가(2026-11-18 사용자 요청).
// https://<계정>.github.io/<저장소>/ 가 이 서버의 화면을 그대로 iframe 으로 보여 준다(deploy/github-pages/app.html — 화면·기능은 서버 주소로 연 것과 같다).
// 그 화면에서는 개인 API 키·두레이 토큰을 저장하지 않는다(사용자 결정 — 누구나 여는 공개 페이지라 위험하다, GitHub 페이지에만 적용).
// 판정: 다른 창 안에 끼워져 있고, 끼운 iframe 이름이 FRAME_NAME 이거나(첫 방문 소개 영상으로 넘어갔다 와도 남는다)
//       처음 주소에 ?host=github-pages 가 있었거나(이 탭 동안 기억), 바깥 창이 *.github.io 일 때.
// 서버도 X-Hwpx-Host: github-pages 머리글이 붙은 저장 요청을 거절한다(server/index.js PAGES_SECRET_ROUTES).
const KEY = 'hwpx.pagesHost';
const PAGES_RE = /(^|\.)github\.io$/i;
export const FRAME_NAME = 'hwpx-cowork-github-pages';   // deploy/github-pages/app.html 의 <iframe name>과 같아야 한다

function detect() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  let framed = false;
  try { framed = window.top !== window; } catch { framed = true; }
  if (!framed) return false;
  try { if (window.name === FRAME_NAME) return true; } catch { /* 없음 */ }
  try {
    if (new URLSearchParams(location.search).get('host') === 'github-pages') { sessionStorage.setItem(KEY, '1'); return true; }
    if (sessionStorage.getItem(KEY) === '1') return true;
  } catch { /* 저장소를 못 쓰면 아래 주소로만 판정 */ }
  const origins = [];
  try { origins.push(...(location.ancestorOrigins || [])); if (document.referrer) origins.push(document.referrer); } catch { /* 없음 */ }
  return origins.some((o) => { try { return PAGES_RE.test(new URL(o).hostname); } catch { return false; } });
}

const framedPages = detect();
export const PAGES_HOST = !!globalThis.hwpxPages || framedPages;
export const PAGES_HOST_HEADER = 'X-Hwpx-Host';
export const PAGES_NO_SECRET = 'GitHub 페이지에서는 API 키·토큰을 저장하지 않습니다. 서버 주소에서 직접 열어 저장하세요.';

if (framedPages) {
  // /download 는 다른 창 안에서 열리지 않는다(frame-ancestors 'none') — 새 탭으로
  document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin === location.origin && /^\/download(\/|$)/.test(u.pathname)) { e.preventDefault(); window.open(u.href, '_blank', 'noopener'); }
  }, true);
  // 바깥 페이지 주소의 # 를 이 화면의 # 에 맞춘다(새로 고침·즐겨찾기). 토큰이 든 주소(#/t/…)는 보내지 않는다
  const send = () => { if (!/^#\/t\//.test(location.hash)) { try { window.parent.postMessage({ type: 'hwpx-cowork:hash', hash: location.hash }, '*'); } catch { /* 바깥 창이 없다 */ } } };
  window.addEventListener('hashchange', send);
  send();
}
