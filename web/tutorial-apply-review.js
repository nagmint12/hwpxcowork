// 튜토리얼 공통: 실제 반영을 감지해 본문을 확인할 때까지 단계 이동을 막는다.
// 진행 번호는 바꾸지 않고 확인 대기열만 ctx에 저장해 새로고침 후에도 이어 본다.
const stamp = p => `${p.pid}:${[...(p.log || [])].reverse().find(e => ['apply', 'applied'].includes(e.action))?.at || p.appliedAt || 'applied'}`;
const tableOf = p => p.tableKey || /^(s\d+\/p\d+(?:\/n\d+)*#t\d+)/.exec(p.ref || '')?.[1];

export function appliedReviewRange(p, paragraphs = []) {
  if (!p || p.refGone || p.insertedGone) return null;
  const splitRef = p.type === 'replace' && /^[\r\n]/.test(p.replace || '') ? p.split?.refs?.[0] : null;
  const ref = splitRef || p.appliedRange?.ref || p.insertedRef || p.ref || p.afterRef;
  const paragraph = paragraphs.find(x => x.ref === ref);
  if (!paragraph) return null; // 없어진 주소 대신 같은 번호의 다른 문단을 가리키지 않는다.
  if (p.type === 'figure') return { ref, object: 'image', objectIndex: Math.max(0, (Number(p.figure?.replace?.n) || 1) - 1) };
  if (['table', 'table_edit'].includes(p.type)) return { ref, object: 'table', objectIndex: Number(/#t(\d+)$/.exec(p.tableKey || '')?.[1] || 0) };
  const text = String(paragraph.text || '');
  if (p.appliedRange && !splitRef) return { ref, start: p.appliedRange.start, end: p.appliedRange.end };
  const value = p.type === 'replace' ? p.replace : p.type === 'insert' ? p.text : p.find;
  const at = value ? text.indexOf(value) : -1;
  const start = at >= 0 ? [...text.slice(0, at)].length : 0;
  return { ref, start, end: at >= 0 ? start + [...value].length : [...text].length };
}

// once: 한 번의 반영(요청 하나)은 확인 한 번 — 첫 위치를 보여 준 뒤 바로 [본문 확인 완료]를 누를 수 있다(나머지 위치는 [다음 위치]로 골라 본다, 2026-11-04)
export function createAppliedReview(ctx, initial = [], { once = false } = {}) {
  const state = ctx.appliedReview ||= { queue: [], confirmed: {}, visited: [], index: 0 };
  state.queue ||= []; state.confirmed ||= {}; state.visited ||= []; state.index ||= 0;
  const seen = new Map(state.observed || initial.map(p => [p.pid, p.status]));
  delete state.observed;
  let current = initial;
  let paragraphTables = new Map();
  function observe(proposals, include = [], paragraphs = []) {
    current = proposals || [];
    paragraphTables = new Map(paragraphs.filter(p => p.cell?.table).map(p => [p.ref, p.cell.table]));
    const forced = new Set(include.map(p => p.pid));
    for (const p of [...current].sort((a, b) => a.pid - b.pid)) {
      const previous = seen.get(p.pid);
      if (p.status === 'applied' && (previous !== 'applied' || forced.has(p.pid))) {
        const key = stamp(p);
        if (previous != null && previous !== 'applied') delete state.confirmed[p.pid];
        if (state.confirmed[p.pid] !== key && !state.queue.some(q => q.key === key)) {
          state.queue = state.queue.filter(q => q.pid !== p.pid);
          state.queue.push({ pid: p.pid, key });
        }
      }
      seen.set(p.pid, p.status);
    }
    state.queue = state.queue.filter(q => current.some(p => p.pid === q.pid && p.status === 'applied'));
    state.index = Math.max(0, Math.min(state.index, Math.max(0, groups().length - 1)));
    if (!state.queue.length) { state.visited = []; state.index = 0; }
    return state.queue.length > 0;
  }
  function groups() {
    const out = new Map();
    for (const item of state.queue) {
      const p = current.find(p => p.pid === item.pid); if (!p) continue;
      // 같은 표의 숫자·모양은 한 위치에서 함께 읽고, 서로 다른 본문 위치는 따로 확인한다.
      const key = tableOf(p) || paragraphTables.get(p.ref) || p.insertedRef || p.appliedRange?.ref || p.ref || `proposal:${p.pid}`;
      if (!out.has(key)) out.set(key, { key, proposals: [] });
      out.get(key).proposals.push(p);
    }
    return [...out.values()];
  }
  const seenEnough = () => (once ? groups().some(g => state.visited.includes(g.key)) : groups().every(g => state.visited.includes(g.key)));
  return {
    observe, groups, once,
    pause() { state.observed = [...seen]; },
    get active() { return state.queue.length > 0; },
    get index() { return state.index; },
    get count() { return state.queue.length; },
    get current() { return groups()[state.index] || null; },
    get canConfirm() { return seenEnough(); },
    visit() { const group = groups()[state.index]; if (group && !state.visited.includes(group.key)) state.visited.push(group.key); },
    move(delta) { state.index = Math.max(0, Math.min(groups().length - 1, state.index + delta)); },
    confirm() {
      if (!state.queue.length || !seenEnough()) return false;
      for (const q of state.queue) state.confirmed[q.pid] = q.key;
      state.queue = []; state.visited = []; state.index = 0;
      return true;
    },
  };
}

export function appliedReviewDetails(p) {
  const names = { replace: '문장 수정', insert: '문단 추가', format: '글자·문단 서식', table: '표 추가', table_edit: '표 구조·서식', delete: '개체 지우기', figure: p.figure?.replace ? '그림 교체' : '그림 추가', toc: '차례 갱신', page_layout: '쪽 구성' };
  return { title: `제안 #${p.pid} · ${names[p.type] || '본문 수정'}`,
    before: p.type === 'replace' ? p.find : null,
    after: p.type === 'replace' ? p.replace : p.type === 'insert' ? (p.blank ? '(빈 문단 추가)' : p.text) : p.figure?.name || p.table?.caption || p.reason || names[p.type] || '본문 수정',
    reason: p.reason || '',
  };
}
