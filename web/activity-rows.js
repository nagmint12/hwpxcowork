// AI 작업 진행 기록(server/activity.js)을 화면 줄로 — 순수 함수(브라우저·Node 시험 양쪽에서 쓴다, web/ui.js RequestActivity).

/** 걸린 시간 글: 42초 · 3분 35초 */
export const secText = (ms) => { const n = Math.max(0, Math.round(ms / 1000)); return n >= 60 ? `${Math.floor(n / 60)}분 ${n % 60}초` : `${n}초`; };
/** 시각 글(이 PC 시각): 10:49:05 */
export const clockText = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : [t.getHours(), t.getMinutes(), t.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };

/**
 * 진행 기록 → 화면 줄 [{ n, label, ok, count, time, gap }].
 * 이어지는 같은 글은 한 줄로 묶고(count — 의견 남김 ×8), gap = 앞 줄이 끝난 뒤 이 줄이 시작되기까지('+42초' — 3초 이상일 때만:
 * 그동안 AI 가 생각하거나 글을 썼다). 줄의 at 은 그 도구 호출이 끝난 때, ms 는 걸린 시간이다
 */
export function activityRows(items) {
  const rows = []; let prevEnd = null;
  for (const it of items || []) {
    const end = new Date(it.at).getTime(); const start = end - (Number(it.ms) || 0);
    const last = rows[rows.length - 1];
    if (last && last.label === it.label && last.ok === it.ok) { last.count++; prevEnd = end; continue; }
    const gap = prevEnd != null && start - prevEnd >= 3000 ? `+${secText(start - prevEnd)}` : '';
    rows.push({ n: it.n, label: it.label, ok: it.ok, count: 1, time: clockText(it.at), gap });
    prevEnd = end;
  }
  return rows;
}
