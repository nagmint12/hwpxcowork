// 제안 카드가 보여 줄 '자리' — 순수 모듈(Vue·DOM 없음, tests/proposal_place.test.mjs).
//
// 문단 주소(ref 's0/p655')는 문단마다 붙은 고유 번호가 아니다: '구역 번호 / 그 구역에서 위에서부터 센 본문 문단 차례(0부터)'다.
// 한/글 파일의 문단에는 믿을 고유 번호가 없어(hp:p id 는 거의 모든 문단이 같은 값) 차례로 가리키고, 문단을 넣거나 지우면 서버가
// 저장해 둔 주소를 그만큼 밀어 다시 매긴다(server/service.js _remapRefs).
// 그래서 '문단 뒤에 넣기' 제안(문단·표·그림)은 반영 전과 뒤에 보여 줄 주소가 다르다:
//   - 반영 전: 그 뒤에 넣을 문단(afterRef)
//   - 반영 뒤: 실제로 넣은 문단(insertedRef — 여러 문단이면 split.refs)
// 2026-11-10 까지 카드는 반영 뒤에도 제안할 때의 기준 문단(p.ref)을 보여 줬다 — 한 문단 뒤에 31개를 차례로 넣은 제안이 모두 같은 주소였고,
// 눌러도 넣은 자리가 아니라 그 기준 문단으로 갔다.

const ADDS = ['insert', 'table', 'figure'];

/**
 * 제안의 지금 자리 → { ref, endRef(여러 문단이면 마지막 문단 | null), after(그 문단 '뒤'에 넣을 제안인가), gone(그 자리가 없어졌는가), count(문단 수) }
 *  - 넣기(문단·표·그림) 반영: 실제로 넣은 문단. 그 뒤 지워졌으면 gone
 *  - 넣기 대기·거절·되돌림: 그 뒤에 넣을 문단(after)
 *  - 그 밖(바꿈·서식·표 고치기·그림 교체 …): 고칠(고친) 문단 — 여러 문단으로 나눠 반영했으면 나뉜 마지막 문단까지
 */
export function proposalPlace(p) {
  if (!p) return { ref: null, endRef: null, after: false, gone: true, count: 0 };
  const type = p.type || 'replace';
  const applied = p.status === 'applied';
  const parts = applied ? (p.split?.refs || []).filter(Boolean) : [];
  // 반영 때 덧붙여 넣은 본문 문단(extraRefs — 표·차트의 단위 줄·주석, 문단 옮기기, 2026-11-17)도 '넣은 문단 n개' 범위에 든다. 없으면 예전과 같다
  const extra = applied && Array.isArray(p.extraRefs) ? p.extraRefs.filter(Boolean) : [];
  // 문단 지우기·옮기기(para_delete·para_move — 2026-11-17, server/paragraph-ops.js): 대기 중에는 고른 범위(ref 부터 paras.count 개),
  // 옮기기 반영 뒤에는 옮겨 간 문단(insertedRef + extraRefs), 지우기 반영 뒤에는 지운 자리 바로 앞 문단(ref — '이 문단 뒤에 있던')
  if (type === 'para_delete' || type === 'para_move') {
    const n = Math.max(1, Number(p.paras?.count) || 1);
    if (applied && type === 'para_move') {
      const all = [...new Set([p.insertedRef, ...extra].filter(Boolean))].sort(byDoc);
      return { ref: all[0] || null, endRef: all.length > 1 ? all[all.length - 1] : null, after: false, gone: !all.length || !!p.insertedGone, count: Math.max(1, all.length) };
    }
    if (applied) return { ref: p.ref || null, endRef: null, after: true, gone: !p.ref || !!p.refGone, count: n };
    const m = /^s(\d+)\/p(\d+)$/.exec(String(p.ref || ''));
    return { ref: p.ref || null, endRef: m && n > 1 ? `s${m[1]}/p${Number(m[2]) + n - 1}` : null, after: false, gone: !p.ref || !!p.lost || !!p.refGone, count: n };
  }
  if (ADDS.includes(type) && !p.figure?.replace) {
    if (!applied) return { ref: p.afterRef || p.ref || null, endRef: null, after: true, gone: !!p.lost, count: 1 };
    if (extra.length) {
      const all = [...new Set([p.insertedRef, ...parts, ...extra].filter(Boolean))].sort(byDoc);
      const ref = all[0] || null;
      return { ref, endRef: all.length > 1 ? all[all.length - 1] : null, after: false, gone: !ref || !!p.insertedGone, count: Math.max(1, all.length) };
    }
    const ref = p.insertedRef || parts[0] || null;
    const endRef = parts.length > 1 && parts[parts.length - 1] !== ref ? parts[parts.length - 1] : null;
    return { ref, endRef, after: false, gone: !ref || !!p.insertedGone, count: Math.max(1, parts.length) };
  }
  const ref = p.ref || p.afterRef || null;
  if (extra.length) {
    const more = [...new Set([...(type === 'replace' ? parts : []), ...extra])].filter((r) => r !== ref).sort(byDoc);
    return { ref, endRef: more.length ? more[more.length - 1] : null, after: false, gone: !ref || !!p.refGone || !!p.lost, count: 1 + more.length };
  }
  const endRef = type === 'replace' && parts.length ? parts[parts.length - 1] : null;
  return { ref, endRef, after: false, gone: !ref || !!p.refGone || !!p.lost, count: 1 + (endRef ? parts.length : 0) };
}

/** 본문 문단 주소의 문서 차례('s0/p9' < 's0/p10' < 's1/p0') — 주소 꼴이 아니면 맨 뒤 */
function byDoc(a, b) {
  const key = (r) => { const m = /^s(\d+)\/p(\d+)/.exec(String(r || '')); return m ? [Number(m[1]), Number(m[2])] : [Infinity, Infinity]; };
  const x = key(a); const y = key(b);
  return (x[0] - y[0]) || (x[1] - y[1]) || 0;
}

/**
 * 문단 주소를 사람 말로: 's0/p686' → '위에서 687번째 문단', 's1/p4' → '구역 2 · 위에서 5번째 문단',
 * 's0/p3/n5' → '위에서 4번째 문단 안(표·글상자)의 6번째 문단'. 주소 꼴이 아니면 ''
 */
export function refWords(ref) {
  const m = /^s(\d+)\/p(\d+)((?:\/[nd]\d+)*)/.exec(String(ref || ''));
  if (!m) return '';
  const sec = Number(m[1]); const nested = [...m[3].matchAll(/\/[nd](\d+)/g)].map((x) => Number(x[1]) + 1);
  let out = `${sec > 0 ? `구역 ${sec + 1} · ` : ''}위에서 ${Number(m[2]) + 1}번째 문단`;
  if (nested.length) out += ` 안(표·글상자)의 ${nested.join('-')}번째 문단`;
  return out;
}

/** 넣기 제안 카드의 한 줄: 반영 전 '이 문단 뒤에 …', 반영 뒤 '넣은 …'(what = '새 문단'·'3×4 표'·'그림') */
export function placeNote(place, what, { many = '' } = {}) {
  if (place?.after) return `이 문단 뒤에 ${what}`;
  return `넣은 ${place?.count > 1 && many ? `${many} ${place.count}개` : what.replace(/^새 /, '')}`;
}
