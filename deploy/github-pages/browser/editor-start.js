// Canvas does not wait for CSS fonts. Register both body families before the editor's first draw.
async function startEditor() {
  const variants = [['Regular', '400'], ['Bold', '700']];
  const faces = await Promise.all(['Noto Serif KR', 'Noto Sans KR'].flatMap(family =>
    variants.map(([style, weight]) => {
      const file = family.replaceAll(' ', '') + '-' + style + '.woff2';
      const url = new URL('./fonts/' + file, import.meta.url);
      return new FontFace(family, `url("${url}") format("woff2")`, { weight }).load();
    })));
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
