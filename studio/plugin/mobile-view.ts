// 모바일 보기 정책은 cowork 통합 층에서만 적용한다.
const RULER_KEY = 'cowork.mobile-ruler';

export function installMobileRuler(doc: Document = document) {
  const root = doc.documentElement;
  let visible = false;
  try { visible = doc.defaultView!.localStorage.getItem(RULER_KEY) === 'true'; } catch { /* 저장 차단 */ }
  const apply = () => root.classList.toggle('cw-mobile-ruler', visible);
  apply();
  return {
    toggle() {
      visible = !visible;
      try { doc.defaultView!.localStorage.setItem(RULER_KEY, String(visible)); } catch { /* 세션 동안 유지 */ }
      apply();
    },
    dispose() { root.classList.remove('cw-mobile-ruler'); },
  };
}

type ZoomView = {
  getZoom(): number;
  setZoom(zoom: number, anchor: { x: number; y: number }): void;
};

export function installDocumentPinch(container: HTMLElement, viewport: () => ZoomView | null): () => void {
  const doc = container.ownerDocument;
  const originalAction = container.style.touchAction;
  // 한 손가락 스크롤은 유지하고 브라우저의 화면 전체 pinch zoom만 제외한다.
  container.style.touchAction = 'pan-x pan-y';
  let pinch: { ids: number[]; distance: number; zoom: number; anchor: { x: number; y: number } } | null = null;
  let active = false;
  let frame = 0;
  let pending: number | null = null;
  const flush = () => {
    frame = 0;
    if (pending !== null && pinch) viewport()?.setZoom(pending, pinch.anchor);
    pending = null;
  };
  const consume = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 2 || !container.contains(event.target as Node)) return;
    const vm = viewport(); if (!vm) return;
    const [a, b] = [...event.touches];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!distance) return;
    const box = container.getBoundingClientRect();
    pinch = { ids: [a.identifier, b.identifier], distance, zoom: vm.getZoom(), anchor: {
      x: Math.max(0, Math.min(1, ((a.clientX + b.clientX) / 2 - box.left) / box.width)),
      y: Math.max(0, Math.min(1, ((a.clientY + b.clientY) / 2 - box.top) / box.height)),
    } };
    active = true;
    consume(event);
  };
  const move = (event: TouchEvent) => {
    if (!active) return;
    consume(event);
    if (!pinch || event.touches.length !== 2) return;
    const points = pinch.ids.map(id => [...event.touches].find(t => t.identifier === id));
    const [a, b] = points; if (!a || !b) return;
    pending = Math.max(0.1, Math.min(4, pinch.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.distance));
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const end = (event: TouchEvent) => {
    if (!active) return;
    consume(event);
    if (frame) cancelAnimationFrame(frame);
    flush();
    pinch = null;
    // 남은 손가락으로 선택/스크롤이 갑자기 시작되지 않도록 모두 뗄 때까지 소비한다.
    if (!event.touches.length) active = false;
  };
  doc.addEventListener('touchstart', start, { capture: true, passive: false });
  doc.addEventListener('touchmove', move, { capture: true, passive: false });
  doc.addEventListener('touchend', end, { capture: true, passive: false });
  doc.addEventListener('touchcancel', end, { capture: true, passive: false });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    doc.removeEventListener('touchstart', start, true);
    doc.removeEventListener('touchmove', move, true);
    doc.removeEventListener('touchend', end, true);
    doc.removeEventListener('touchcancel', end, true);
    container.style.touchAction = originalAction;
  };
}
