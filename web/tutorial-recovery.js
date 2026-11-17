// 단계 번호가 같아도 재진입·중단 뒤의 비동기 응답은 다른 실행입니다.
export function createTutorialTimeline() {
  let generation = 0; let active = true; let identity = {};
  return {
    ticket: () => identity,
    current: ticket => active && ticket === identity,
    renew() { generation++; identity = { generation }; return identity; },
    stop() { active = false; generation++; identity = { generation }; },
  };
}

// 자유로운 조작 중의 일시적인 갱신은 기다리고, 같은 막힘에 복구 요청은 한 번만 보냅니다.
export function createTutorialRecoveryWatch({ delay = 800 } = {}) {
  let key = null; let since = 0; let attempted = false;
  return {
    poll({ step, target, version, busy = false, now }) {
      if (!Number.isInteger(target)) { key = null; attempted = false; return false; }
      const next = `${step}:${target}:${version}`;
      if (key !== next) { key = next; since = now; attempted = false; }
      if (busy) { since = now; return false; }
      if (attempted || now - since < delay) return false;
      attempted = true; return true;
    },
    reset() { key = null; attempted = false; },
  };
}

// 앞 단계에서 순서를 달리 눌렀다면 아직 도달하지 않은 복구 지점 대신
// 그 지점 이전의 가장 가까운 저장 상태를 사용합니다. 실행 중 AI의 스냅샷은 피합니다.
export function tutorialRecoveryPoint(target, current, checkpointAt, attempted = () => false) {
  for (let index = Math.min(target, current); index >= 0; index--) {
    const point = checkpointAt(index);
    if (point && point.resumable !== false && !attempted(point.checkpointId)) return { index, point };
  }
  return null;
}

// 새로고침 뒤에도 같은 잘못된 스냅샷으로 무한 복귀하지 않습니다.
// 문서 내용·진행은 서버에만 두고, 이 탭에는 자동 복구를 시도한 ID만 잠시 둡니다.
export function createTutorialRecoveryHistory(storage, docId, now = Date.now) {
  const key = `hwpx.tutorial-auto-recovery:${docId}`;
  let value = null;
  try { value = JSON.parse(storage?.getItem(key) || 'null'); } catch { /* 저장소 사용 불가 */ }
  if (!Array.isArray(value?.points) || !Number.isInteger(value?.step) || now() - value.at > 600000) value = null;
  const write = () => { try { if (value) storage?.setItem(key, JSON.stringify(value)); else storage?.removeItem(key); } catch { /* 메모리만 사용 */ } };
  return {
    attempted: id => !!value?.points.includes(id),
    mark(id, step) { value = { points: [...new Set([...(value?.points || []), id])], step: Math.max(value?.step ?? step, step), at: now() }; write(); },
    advance(step) { if (value && step > value.step) { value = null; write(); } },
    clear() { value = null; write(); },
  };
}

const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
export function tutorialViewSnapshot(state) {
  return { tab: state.tab, active: clone(state.active), activeRid: state.activeRid,
    windows: Object.fromEntries(['composer', 'popover', 'reply'].map(kind => [kind, clone(state[kind])])) };
}

export function tutorialStoredView(state) {
  const view = tutorialViewSnapshot(state);
  for (const model of Object.values(view.windows)) {
    if (!model) continue;
    model.anchor = null;
    // 창 재구성은 사용자 클릭을 기다립니다. 저장된 자동 전송·타이핑 실행을 재생하지 않습니다.
    model.autoSend = false; model.tutorialTyping = false;
    if ('pending' in model) model.pending = [];
    for (const key of ['instruction', 'text', 'quote']) if (typeof model[key] === 'string') model[key] = model[key].slice(0, 4096);
    if (typeof model.target?.text === 'string') model.target.text = model.target.text.slice(0, 2048);
  }
  if (view.windows.composer?.phase === 'sending') view.windows.composer.phase = 'edit';
  return JSON.stringify(view).length <= 12000 ? view : null;
}

let restoredWindowKey = 0;
export function restoreTutorialView(snapshot, state, closeWindow) {
  if (!snapshot) return;
  for (const kind of ['composer', 'popover', 'reply']) {
    const previousKey = Number(state[kind]?.key) || 0;
    closeWindow(kind); state[kind] = clone(snapshot.windows[kind]);
    if (state[kind]) {
      // Vue는 같은 key의 창을 재사용합니다. 복원한 모델에는 새 key를 주어
      // 입력·전송 처리기가 닫힌 창의 모델을 계속 고치지 않게 합니다.
      restoredWindowKey = Math.max(Date.now(), restoredWindowKey + 1, previousKey + 1, (Number(state[kind].key) || 0) + 1);
      state[kind].key = restoredWindowKey;
      state[kind].autoSend = false; state[kind].tutorialTyping = false;
    }
  }
  if (state.composer?.phase === 'sending') state.composer.phase = 'edit';
  state.tab = snapshot.tab; state.active = clone(snapshot.active); state.activeRid = snapshot.activeRid;
}
