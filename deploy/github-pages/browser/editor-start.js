// The editor's first Canvas frame can use Noto Sans KR before document font discovery finishes.
// Make its regular and bold text glyphs available before that frame, including on a clean browser.
async function startEditor() {
  const faces = await Promise.all([['Regular', '400'], ['Bold', '700']].map(([name, weight]) => {
    const url = new URL(`./fonts/NotoSansKR-${name}.woff2`, import.meta.url);
    return new FontFace('Noto Sans KR', `url("${url}") format("woff2")`, { weight }).load();
  }));
  for (const face of faces) document.fonts.add(face);
  await import(document.querySelector('script[data-pages-editor]').dataset.pagesEditor);
}

startEditor().catch(error => {
  console.error('Pages 편집기 시작 실패', error);
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = '편집기에 필요한 파일을 불러오지 못했습니다. 네트워크 연결을 확인한 후 다시 열어 주세요.';
  const retry = document.createElement('button');
  retry.textContent = '다시 열기';
  retry.onclick = () => location.reload();
  document.body.replaceChildren(message, retry);
});
