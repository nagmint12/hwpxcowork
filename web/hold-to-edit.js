// 문서의 숨은 IME는 길게 누르기로 연다. 보이는 메모·요청 입력은 브라우저의 기본 터치 입력을 쓴다.
const installed = new WeakMap();
import { isMobileDevice, readMobileHoldMs } from './mobile-settings.js';

export function installHoldToEdit(input, {surface = input, schedule = setTimeout, clear = clearTimeout} = {}) {
  if (installed.has(input)) return installed.get(input);
  const doc = input.ownerDocument; const view = doc.defaultView;
  const coarse = view.matchMedia('(pointer: coarse)');
  const mobile = () => isMobileDevice(view);
  const original = {focus: Object.getOwnPropertyDescriptor(input, 'focus'), readOnly: input.readOnly,
    inputmode: input.getAttribute('inputmode'), editable: input.getAttribute('contenteditable'),
    hint: input.getAttribute('data-hold-to-edit')};
  const nativeFocus = input.focus.bind(input);
  const nativeTouchInput = surface === input;
  let armed = false; let gesture = null; let timer = null; let disposed = false;
  const attr = (name, value) => value == null ? input.removeAttribute(name) : input.setAttribute(name, value);
  function sync() {
    const locked = mobile() && !armed && !nativeTouchInput;
    if ('readOnly' in input) input.readOnly = locked || original.readOnly;
    attr('inputmode', locked ? 'none' : original.inputmode);
    if (original.editable != null) attr('contenteditable', locked ? 'false' : original.editable);
    attr('data-hold-to-edit', mobile() ? (locked ? 'locked' : 'editing') : original.hint);
  }
  function cancel() { if (timer != null) clear(timer); timer = null; gesture = null; }
  function lock() {
    armed = false; sync();
    if (mobile() && doc.activeElement === input) input.blur();
  }
  function guardedFocus(options) {
    sync();
    if (!mobile() || armed) nativeFocus(options);
  }
  input.focus = guardedFocus;
  const contains = target => target === input || (surface.contains(target)
    && !target.closest?.('button,input,textarea,select,[contenteditable],a,.cw-mini,.cowork-marks'));
  function start(event) {
    if (!mobile()) return;
    cancel();
    if (event.touches.length !== 1 || !contains(event.target)) { lock(); return; }
    // 보이는 입력 칸은 readonly/inputmode 잠금과 touchend 재포커스로 키보드를
    // 열지 않는다. 실제 터치의 기본 동작이 iOS/Android 키보드와 캐럿을 관리한다.
    if (nativeTouchInput) { armed = true; sync(); return; }
    // 이미 길게 눌러 입력 중이면 짧은 터치로 캐럿을 옮겨도 키보드는 계속 쓴다.
    if (armed && doc.activeElement === input) return;
    lock();
    const t = event.touches[0];
    gesture = {id: t.identifier, x: t.clientX, y: t.clientY, held: false};
    timer = schedule(() => { timer = null; if (gesture) gesture.held = true; }, readMobileHoldMs(view));
  }
  function move(event) {
    if (!gesture) return;
    const t = [...event.touches].find(t => t.identifier === gesture.id);
    if (event.touches.length !== 1 || !t || (!gesture.held && Math.hypot(t.clientX - gesture.x, t.clientY - gesture.y) > 10)) cancel();
  }
  function end(event) {
    if (!gesture || [...event.touches].some(t => t.identifier === gesture.id)) return;
    const held = gesture.held; cancel();
    if (!held || input.disabled || original.readOnly || input.isConnected === false) return;
    armed = true; sync();
    // iOS도 키보드를 열 수 있도록 타이머가 아니라 실제 touchend 안에서 포커스를 준다.
    nativeFocus({preventScroll: true});
    if (surface === input && event.cancelable) event.preventDefault();
  }
  const abort = () => { cancel(); lock(); };
  const blur = () => { armed = false; sync(); };
  const focus = () => { if (mobile() && !armed && !nativeTouchInput) input.blur(); };
  const context = event => { if (!nativeTouchInput && mobile() && contains(event.target) && !armed) event.preventDefault(); };
  const change = () => { cancel(); armed = false; sync(); };
  doc.addEventListener('touchstart', start, {capture: true, passive: true});
  doc.addEventListener('touchmove', move, {capture: true, passive: true});
  doc.addEventListener('touchend', end, {capture: true, passive: false});
  doc.addEventListener('touchcancel', abort, true);
  doc.addEventListener('contextmenu', context, true);
  input.addEventListener('blur', blur);
  input.addEventListener('focus', focus);
  coarse.addEventListener('change', change);
  sync();
  const dispose = () => {
    if (disposed) return; disposed = true; cancel();
    doc.removeEventListener('touchstart', start, true); doc.removeEventListener('touchmove', move, true);
    doc.removeEventListener('touchend', end, true); doc.removeEventListener('touchcancel', abort, true);
    doc.removeEventListener('contextmenu', context, true);
    input.removeEventListener('blur', blur); input.removeEventListener('focus', focus);
    coarse.removeEventListener('change', change);
    if (original.focus) Object.defineProperty(input, 'focus', original.focus); else delete input.focus;
    if ('readOnly' in input) input.readOnly = original.readOnly;
    attr('inputmode', original.inputmode); attr('contenteditable', original.editable); attr('data-hold-to-edit', original.hint);
    installed.delete(input);
  };
  installed.set(input, dispose);
  return dispose;
}

export function focusEditingInput(input, options) {
  if (!input) return;
  installHoldToEdit(input);
  input.focus(options);
}
