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

export function restoreTutorialView(snapshot, state, closeWindow) {
  if (!snapshot) return;
  for (const kind of ['composer', 'popover', 'reply']) {
    closeWindow(kind); state[kind] = clone(snapshot.windows[kind]);
    if (state[kind]) { state[kind].autoSend = false; state[kind].tutorialTyping = false; }
  }
  if (state.composer?.phase === 'sending') state.composer.phase = 'edit';
  state.tab = snapshot.tab; state.active = clone(snapshot.active); state.activeRid = snapshot.activeRid;
}
