export function shapeDialog(doc, kind) {
  const selector = kind === 'char' ? '.dialog-wrap.cs-dialog' : kind === 'para' ? '.dialog-wrap.ps-dialog' : null;
  if (!selector) return null;
  return [...(doc?.querySelectorAll(selector) || [])].find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null;
}

// 제안 번호와 요청 번호를 함께 제한한다. 다른 카드의 같은 이름 단추를 선택하지 않는다.
export function proposalControl(doc, pid, action, rid) {
  if (!/^\d+$/.test(String(pid)) || !/^\d+$/.test(String(rid))) return null;
  const variants = action === 'apply' ? [['rs-live','rs-adopt','rs-apply'], ['rc-live','rc-adopt','rc-apply']] : action === 'undo' ? [['rs-undo'], ['rc-undo']] : [['rs-reject'], ['rc-reject']];
  const roots = [`[data-testid="panel"] .result[data-rid="${rid}"] [data-pid="${pid}"]`, `.rcard[data-kind="proposal"][data-rid="${rid}"] [data-pid="${pid}"]`];
  for (let index = 0; index < roots.length; index++) for (const cls of variants[index]) {
    const found = [...(doc?.querySelectorAll(`${roots[index]} button.${cls}:not(:disabled)`) || [])].find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (found) return found;
  }
  return null;
}

// 요청별 일괄 반영 단추. 다른 요청 카드의 반영 단추로 초점이 넘어가지 않게 한다.
export function requestControl(doc, rid) {
  if (!/^\d+$/.test(String(rid))) return null;
  const selector = `.result[data-rid="${rid}"] .req-actions[data-rid="${rid}"] button.ra-adopt:not(:disabled)`;
  return [...(doc?.querySelectorAll(selector) || [])].find(el => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  }) || null;
}
