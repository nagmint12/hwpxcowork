// 화면에만 그리는 가상 커서. 입력 이벤트·click·OS 마우스/키보드 API를 호출하지 않는다.
export function createTutorialMotion(root, { reduced: prefersReduced } = {}) {
  const doc = root.ownerDocument;
  const pointer = doc.createElement('div'); pointer.className = 'tour-demo-cursor';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = '<span class="tour-demo-ripple"></span><svg viewBox="0 0 32 40" width="28" height="35"><path d="M3 2L4 31L12 24L18 37L24 34L18 21L29 20Z" fill="#fff" stroke="#001a70" stroke-width="2.5" stroke-linejoin="round"/></svg><span class="tour-demo-label">클릭 예시</span>';
  root.append(pointer);
  const reduced = doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)');
  const reduce = () => prefersReduced ? prefersReduced() : reduced.matches;
  let identity = null; let since = 0; let x = 0; let y = 0;
  function hide() { pointer.hidden = true; identity = null; }
  hide();
  return {
    update(spec, time, step) {
      const r = spec?.rect;
      if (reduce() || !r || r.w <= 0 || r.h <= 0) { hide(); return; }
      const W = doc.defaultView.innerWidth; const H = doc.defaultView.innerHeight;
      if (r.x >= W || r.y >= H || r.x + r.w <= 0 || r.y + r.h <= 0) { hide(); return; }
      const typing = spec.mode === 'typing'; const dragging = spec.mode === 'drag';
      const id = `${step}:${spec.mode}:${spec.id || ''}`;
      if (identity !== id) { identity = id; since = time; x = Math.max(8, r.x - 100); y = Math.min(H - 44, r.y + 65); }
      const age = time - since; const phase = age % 2600;
      const fraction = dragging ? Math.max(0, Math.min(1, (phase - 550) / 1350)) : 0.5;
      const tx = Math.max(8, Math.min(W - 30, r.x + (typing ? Math.min(26, r.w / 3) : dragging ? 8 + Math.max(0, r.w - 16) * fraction : r.w / 2)));
      const ty = Math.max(8, Math.min(H - 40, r.y + (typing ? Math.min(20, r.h / 2) : dragging && r.h > 45 ? 10 + Math.max(0, r.h - 20) * fraction : r.h / 2)));
      const ease = 0.13;
      x += (tx - x) * ease; y += (ty - y) * ease;
      pointer.hidden = false;
      pointer.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      pointer.classList.toggle('tour-demo-click', typing ? age > 400 && age < 950 : dragging ? phase > 500 && phase < 1900 : phase > 650 && phase < 1150);
      pointer.querySelector('.tour-demo-label').textContent = typing ? '입력 예시' : dragging ? '끌어 선택 예시' : '클릭 예시';
    },
    hide,
    destroy() { pointer.remove(); },
  };
}

// 코스 종류와 무관하게 현재 안내의 실제 대상을 가리킨다. 입력/클릭 이벤트는 만들지 않는다.
export function tutorialMotionSpec(step, { target = null, exampleRect = null, typingRect = null } = {}) {
  if (step.motionEnabled === false) return null;
  if (typingRect) return { rect: typingRect, mode: 'typing' };
  const explicit = step.motion?.();
  if (explicit) return explicit;
  if (exampleRect) return { rect: exampleRect, mode: 'click' };
  if (!target) return null;
  const dragging = step.motionMode === 'drag' || (!step.click && /고르기|선택|골라/.test(step.originalTitle || step.title || ''));
  return { rect: target, mode: step.motionMode || (dragging ? 'drag' : 'click') };
}

const activeInputs = new WeakMap();
// 실제 예시 입력과 읽기 전용 시연에 공통 사용한다. 대상·단계·사용자 입력이 바뀌면 즉시 중단한다.
export async function typeTutorialInput({ input, text, current = () => true, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), reduced = false }) {
  if (!input || input.isConnected === false) return false;
  const owner = {}; activeInputs.set(input, owner);
  const reduce = () => typeof reduced === 'function' ? reduced() : reduced;
  const chars = [...String(text)]; let previous = String(input.value || '');
  const valid = () => activeInputs.get(input) === owner && input.isConnected !== false && current() && String(input.value || '') === previous;
  input.setAttribute?.('data-tutorial-typing', 'true');
  try {
    if (!reduce()) await wait(650);
    for (let n = 1; n <= Math.max(1, chars.length); n++) {
      if (!valid()) return false;
      previous = reduce() ? String(text) : chars.slice(0, n).join('');
      input.value = previous;
      const EventClass = input.ownerDocument?.defaultView?.Event || globalThis.Event;
      if (EventClass) input.dispatchEvent?.(new EventClass('input', { bubbles: true }));
      if (reduce()) break;
      await wait(/[\s,.?!]/.test(chars[n - 1] || '') ? 100 : 45 + n % 3 * 8);
    }
    return valid();
  } finally {
    if (activeInputs.get(input) === owner) { activeInputs.delete(input); input.removeAttribute?.('data-tutorial-typing'); }
  }
}

// 한 번 열린 요청 창 하나만 소유한다. 전송·닫기·사용자 수정·단계 이동 뒤 늦은 타이핑이 새 창을 덮어쓰지 않는다.
const activePrompts = new WeakMap();
export async function typeTutorialPrompt({ composer, text, current, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), reduced = false }) {
  if (!composer) return;
  const owner = {}; activePrompts.set(composer, owner);
  const chars = [...text]; let previous = String(composer.instruction || '');
  const reduce = () => typeof reduced === 'function' ? reduced() : reduced;
  composer.tutorialTyping = true;
  try {
    if (!reduce()) await wait(650); // 가상 커서가 입력 칸에 도착해 클릭하는 시간
    for (let n = 1; n <= chars.length; n++) {
      if (activePrompts.get(composer) !== owner || !current() || composer.phase !== 'edit' || String(composer.instruction || '') !== previous) return;
      previous = reduce() ? text : chars.slice(0, n).join('');
      composer.instruction = previous;
      if (reduce()) break;
      await wait(/[\s,.?!]/.test(chars[n - 1]) ? 100 : 45 + n % 3 * 8);
    }
  } finally { if (activePrompts.get(composer) === owner) { activePrompts.delete(composer); composer.tutorialTyping = false; } }
}
