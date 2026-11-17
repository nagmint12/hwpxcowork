// 앱 입력을 제한하지 않고 실제로 일어난 클릭·복사만 진행 판단에 전달합니다.
export function observeTutorialInput(document, { onClick, onClipboard = () => {} }) {
  document.addEventListener('click', onClick, true);
  document.addEventListener('copy', onClipboard);
  document.addEventListener('cut', onClipboard);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('copy', onClipboard);
    document.removeEventListener('cut', onClipboard);
  };
}
