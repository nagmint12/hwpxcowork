// 글 범위 반영 검사(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §19).
// [모두 반영](server/service.js _orderedApplier)은 같은 문단의 바꿈 제안을 제안 번호 차례로 반영하며, 앞 제안이 고친 범위와 겹치는 뒤 제안을 STALE 로 실패시킨다.
// 바꿈(replace) 제안끼리라면 이 실패는 문서 사본에 반영해 보지 않고 범위만 견줘서 미리 알 수 있다 — 65쪽 문서에서 제안 159건을 사본에 반영해 보는 흉내는
// 시간 한도(6초)를 넘어 중간에 멈췄고(apply_failed 가 비어 보였다), 모델이 작은 dry_run 을 거듭해 겹침을 찾느라 모델 호출 13번(입력의 56%)을 썼다.
// 판정 규칙은 _orderedApplier 와 같아야 한다: 그쪽을 고치면 laterFails 도 고친다(시험 tests/mcp_apply_check.test.mjs).

const cpLen = (s) => { let n = 0; for (const _ of String(s ?? '')) n++; return n; };

/**
 * 바꿈 제안(또는 그 입력)이 고치는 글 범위 → { start, end }(코드 포인트, 최종본 보기) | null(문단·글을 찾지 못함).
 * _orderedApplier 와 같다: find 가 있으면 doc.find(ref, find, occurrence), 없으면 offset(없으면 문단 끝)의 빈 범위.
 */
export function replaceRange(doc, { ref, find, occurrence, offset, start }) {
  let text;
  try { text = doc.text(ref, 'final'); } catch { return null; }
  if (text == null) return null;
  if (find) {
    const r = doc.find(ref, find, occurrence || 1);
    return r ? { start: r.start, end: r.end } : null;
  }
  const at = offset ?? start ?? cpLen(text);
  return { start: at, end: at };
}

/**
 * a 를 먼저 반영한 뒤 b 가 실패하는가(같은 문단). _orderedApplier: 뒤 제안은 앞 범위의 앞(빈 범위가 같은 자리에서 시작하는 경우는 빼고)이나 뒤에 있어야 남는다.
 */
export function laterFails(a, b) {
  const before = b.end <= a.start && !(b.start === b.end && b.start === a.start);
  const after = b.start >= a.end;
  return !before && !after;
}

/**
 * 반영 차례로 놓인 범위 목록에서 실패할 쌍 → [{ first(겹친 앞 제안 — 반영되는 것), later(실패할 제안) }](entries 의 원소 그대로). 같은 문단(ref)끼리만 견준다.
 * entries: [{ ref, start, end, … }] — 차례 = 배열 차례(제안 번호 차례).
 * 실패할 제안은 반영되지 않으므로(_orderedApplier — STALE 은 그 제안만 건너뛰고, 무효인 제안은 뒤 제안의 범위를 바꾸지 않는다) 뒤 제안은 반영될 앞 제안하고만 견준다.
 * (2026-11-20 검증: 사슬 a[0,5]·b[3,8]·c[6,9] 에서 실제로는 b 만 실패한다 — 모든 앞 제안과 견주면 c 까지 실패로 셌다)
 */
export function rangeConflicts(entries) {
  const byRef = new Map();
  for (const e of entries) {
    if (!e || e.start == null) continue;
    if (!byRef.has(e.ref)) byRef.set(e.ref, []);
    byRef.get(e.ref).push(e);
  }
  const out = [];
  for (const list of byRef.values()) {
    if (list.length < 2) continue;
    const applied = [list[0]];
    for (let j = 1; j < list.length; j++) {
      const hit = applied.find((a) => laterFails(a, list[j]));
      if (hit) out.push({ first: hit, later: list[j] }); else applied.push(list[j]);
    }
  }
  return out;
}

/** 오류·영수증에 보일 짧은 글 */
export const shortText = (s, n = 24) => { const t = [...String(s ?? '')]; return t.length > n ? `${t.slice(0, n).join('')}…` : t.join(''); };

/**
 * replace_all 의 바꿈을 다른 바꿈의 with 글에 접어 넣는다(같은 호출의 replace 가 고치는 글 안에 replace_all 의 일치가 든 경우 — 그 replace 의 결과 글도
 * 문서 전체 바꾸기를 따라야 한다). with 에 이미 바꿀 글(op.with)이 들어 있으면 그 자리는 다시 바꾸지 않는다('AI' → 'AI(인공지능)' 이 두 번 붙지 않게).
 * word·ignore_case 는 server/mcp2/ops.js findAll 과 같은 뜻이다.
 */
export function foldReplaceAll(text, op) {
  const src = String(text ?? '');
  const edge = op.word ? ['(?<![\\p{L}\\p{N}])', '(?![\\p{L}\\p{N}])'] : ['', ''];
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${edge[0]}${esc(op.find)}${edge[1]}`, `gu${op.ignore_case ? 'i' : ''}`);
  const swap = (piece) => piece.replace(re, (m) => (op.ignore_case && m === op.with ? m : op.with));
  if (op.with && String(op.with).includes(op.find)) return src.split(op.with).map(swap).join(op.with);
  return swap(src);
}
