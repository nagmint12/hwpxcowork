import { readMobileHoldMs } from '../../web/mobile-settings.js';
type Point = { x: number; y: number };
type HoldOptions = {
  start(point: Point): void; move(point: Point): void; end(point: Point): void;
  schedule?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (id: ReturnType<typeof setTimeout>) => void;
  delay?: () => number;
};

// 짧은 탭·스크롤은 브라우저에 맡기고, 정지해서 오래 누른 뒤의 움직임만 선택 드래그로 보낸다.
export function createHoldDrag(options: HoldOptions) {
  const schedule = options.schedule || setTimeout; const clear = options.clear || clearTimeout;
  let origin: Point | null = null; let current: Point | null = null; let timer: ReturnType<typeof setTimeout> | null = null; let selecting = false;
  const cancelTimer = () => { if (timer != null) clear(timer); timer = null; };
  const finish = () => { cancelTimer(); if (selecting && current) options.end(current); origin = null; current = null; selecting = false; };
  return {
    start(point: Point) { finish(); origin = current = point; timer = schedule(() => { timer = null; if (!origin) return; selecting = true; options.start(origin); }, options.delay?.() ?? 400); },
    move(point: Point) { if (!origin) return; current = point; if (selecting) options.move(point); else if (Math.hypot(point.x - origin.x, point.y - origin.y) > 10) finish(); },
    end: finish, cancel: finish, get selecting() { return selecting; },
  };
}

export function installTouchSelection(container: HTMLElement): () => void {
  const doc = container.ownerDocument; const view = doc.defaultView!;
  let target: EventTarget | null = null; let touchId: number | null = null; let lastTouchAt = -Infinity; let suppressMouseUntil = -Infinity;
  const originalAction = container.style.touchAction; const originalCallout = container.style.getPropertyValue('-webkit-touch-callout');
  container.style.setProperty('-webkit-touch-callout', 'none');
  const emitMouse = (type: string, point: Point, buttons: number) => {
    if (!(target instanceof view.Node)) return;
    target.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, view, button: 0, buttons, clientX: point.x, clientY: point.y }));
  };
  const hold = createHoldDrag({
    delay: () => readMobileHoldMs(view),
    start(point) { container.style.touchAction = 'none'; container.classList.add('cw-touch-selecting'); emitMouse('mousedown', point, 1); },
    move(point) { emitMouse('mousemove', point, 1); },
    end(point) { emitMouse('mouseup', point, 0); container.style.touchAction = originalAction; container.classList.remove('cw-touch-selecting'); suppressMouseUntil = performance.now() + 800; },
  });
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) { hold.cancel(); touchId = null; return; }
    if (!(event.target instanceof view.Element) || !container.contains(event.target) || event.target.closest('button,input,textarea,[contenteditable],.cowork-marks,.cw-mini')) return;
    const touch = event.touches[0]; target = event.target; touchId = touch.identifier; lastTouchAt = performance.now();
    hold.start({ x: touch.clientX, y: touch.clientY });
  };
  const move = (event: TouchEvent) => {
    const touch = [...event.touches].find(t => t.identifier === touchId); if (!touch) return;
    hold.move({ x: touch.clientX, y: touch.clientY });
    if (hold.selecting) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const end = (event: TouchEvent) => {
    if (touchId == null || [...event.touches].some(t => t.identifier === touchId)) return;
    const selecting = hold.selecting; hold.end(); touchId = null; lastTouchAt = performance.now();
    if (selecting) { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const cancel = () => { hold.cancel(); touchId = null; };
  const context = (event: Event) => {
    const pointer = event as PointerEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
    if (!container.contains(event.target as Node)) return;
    if (pointer.pointerType === 'touch' || pointer.sourceCapabilities?.firesTouchEvents === true || (pointer.pointerType !== 'mouse' && pointer.sourceCapabilities?.firesTouchEvents !== false && performance.now() - lastTouchAt < 1000)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const compatibilityMouse = (event: Event) => {
    const mouse = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
    if (event.isTrusted && performance.now() < suppressMouseUntil && container.contains(event.target as Node) && mouse.sourceCapabilities?.firesTouchEvents !== false) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  doc.addEventListener('touchstart', start, { capture: true, passive: true });
  doc.addEventListener('touchmove', move, { capture: true, passive: false });
  doc.addEventListener('touchend', end, { capture: true, passive: false });
  doc.addEventListener('touchcancel', cancel, true);
  doc.addEventListener('contextmenu', context, true);
  for (const type of ['mousedown','mouseup','click']) doc.addEventListener(type, compatibilityMouse, true);
  return () => {
    hold.cancel();
    doc.removeEventListener('touchstart', start, true); doc.removeEventListener('touchmove', move, true); doc.removeEventListener('touchend', end, true); doc.removeEventListener('touchcancel', cancel, true); doc.removeEventListener('contextmenu', context, true);
    for (const type of ['mousedown','mouseup','click']) doc.removeEventListener(type, compatibilityMouse, true);
    container.style.touchAction = originalAction; container.style.setProperty('-webkit-touch-callout', originalCallout); container.classList.remove('cw-touch-selecting');
  };
}
