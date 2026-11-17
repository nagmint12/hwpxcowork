// AI 사용량 보고(관리자 'AI 사용량' 탭, 2026-11-16): 요청 기록에 저장된 토큰(r.usage)을 모아 예상 API 비용과 함께 보여 준다.
//   - 모든 AI 경로가 같은 칸(server/edit-usage.js — input·output·cacheRead·cacheWrite)에 쓴다: Codex·Claude Code 실행기, API 실행기, 서버 AI.
//     사용량을 알리지 않는 경로(Claude Code 채널 에이전트 등)는 '기록 없음' 줄로만 보인다.
//   - 구독 한도(Codex 주간 %, Claude 5시간 한도)는 다루지 않는다 — 토큰과 'API 로 냈다면'의 예상 금액만(사용자 결정).
//   - 입력 토큰 셈은 제공자마다 다르다: OpenAI·Gemini 는 input 에 캐시 읽기·쓰기가 들어 있고, Anthropic(Claude)은 input 이 캐시를 뺀 나머지다.

// USD / 100만 토큰. 모델 목록에 단가를 주는 API 는 없어서 표로 둔다 — 새 모델은 여기에 더한다.
//   GPT: BAZE 게이트웨이 모델 목록 단가 — 2026-11-03 실측 3번에서 계산과 청구 차이 ≤0.2 크레딧.
//   Claude: Anthropic 공개 단가(2026-11-03 기준). 캐시 쓰기 = 입력×1.25, 캐시 읽기 = 공개 값(없으면 입력×0.1). Haiku 5.5 는 10만 토큰 넘는 프롬프트에서 5배(반영 안 함).
export const PRICES = Object.freeze({
  'gpt-6.1-sol': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  'claude-fable-5-2': { input: 8, cacheRead: 0.2, cacheWrite: 10, output: 40 },
  'claude-fable-5-1': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
});
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' };

/** 모델 이름 → 단가 표의 이름(제공자 앞머리·날짜 꼬리를 떼고, 없으면 가장 긴 앞부분 일치) 또는 null */
export function priceKey(model) {
  let m = String(model || '').trim().toLowerCase();
  if (!m) return null;
  m = m.slice(m.lastIndexOf('/') + 1).replace(/^models\//, '').replace(/@.*$/, '').replace(/-\d{8}$/, '');
  if (ALIASES[m]) return ALIASES[m];
  if (PRICES[m]) return m;
  return Object.keys(PRICES).filter((k) => m.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0] || null;
}

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** 요청 사용량 → { fresh(캐시 아닌 입력), cacheRead, cacheWrite, input(전체 입력), output } — 사용량이 없으면 null */
export function splitTokens(usage, model) {
  if (!usage || typeof usage !== 'object' || (usage.input == null && usage.output == null)) return null;
  const cacheRead = n(usage.cacheRead), cacheWrite = n(usage.cacheWrite), output = n(usage.output);
  const anthropic = /^claude|(^|\/)anthropic/i.test(String(model || ''));
  // Claude: input = 캐시를 뺀 나머지. 그 밖(OpenAI·Gemini): input 안에 캐시 읽기·쓰기가 들어 있다
  const fresh = anthropic ? n(usage.input) : Math.max(0, n(usage.input) - cacheRead - cacheWrite);
  return { fresh, cacheRead, cacheWrite, input: fresh + cacheRead + cacheWrite, output };
}

/** 토큰 × 단가 → USD(단가가 없으면 null) */
export function costOf(t, key) {
  const p = key && PRICES[key];
  if (!t || !p) return null;
  return (t.fresh * p.input + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.output * p.output) / 1e6;
}

// 한국 시각 날짜(YYYY-MM-DD)
const kstDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : ''; };
const zero = () => ({ requests: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, cost: 0, unpriced: 0 });
function add(sum, row) {
  sum.requests += 1;
  if (!row.tokens) return;
  for (const k of ['fresh', 'cacheRead', 'cacheWrite', 'input', 'output']) sum[k] += row.tokens[k];
  if (row.cost == null) sum.unpriced += 1; else sum.cost += row.cost;
}

/**
 * 문서 메타 목록 → 보고서. AI 가 맡았거나 사용량이 남은 요청만 센다(사람이 직접 처리한 요청·대기 중 요청은 뺀다).
 * → { rows(최근 것부터, limit 개), totals: { today, week, month, all }, days(최근 14일), byAi, missingPrices, prices, generatedAt }
 */
export function usageReport(metas, { now = new Date(), limit = 300 } = {}) {
  const rows = [];
  for (const m of metas || []) {
    for (const r of m?.requests || []) {
      // 튜토리얼 예시 답변(r.example — '예시 답변'·'예시 AI')은 준비된 답을 다시 낸 것이라 AI 호출이 아니다
      if (!r || r.example || (!r.usage && !r.handledBy)) continue;
      const model = r.model || null;
      const tokens = splitTokens(r.usage, model);
      const key = priceKey(model);
      const done = r.doneAt || null;
      rows.push({
        docId: m.id, title: m.title || '', rid: r.rid, at: r.at || null, doneAt: done, status: r.status || '',
        label: r.label || r.kind || '', by: r.by || '', agent: r.handledBy || r.doneBy || '', model, priceKey: key,
        tokens, cost: costOf(tokens, key),
        seconds: done && r.at ? Math.max(0, Math.round((Date.parse(done) - Date.parse(r.at)) / 100) / 10) : null,
        proposals: Array.isArray(r.proposals) ? r.proposals.length : 0,
      });
    }
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const today = kstDay(now.toISOString());
  const weekStart = kstDay(new Date(now.getTime() - 6 * 86400e3).toISOString());
  const monthStart = `${today.slice(0, 8)}01`;
  const totals = { today: zero(), week: zero(), month: zero(), all: zero() };
  const dayMap = new Map(); const aiMap = new Map(); const missing = new Set();
  for (let i = 13; i >= 0; i -= 1) dayMap.set(kstDay(new Date(now.getTime() - i * 86400e3).toISOString()), zero());
  for (const row of rows) {
    const d = kstDay(row.at);
    add(totals.all, row);
    if (d >= monthStart && d <= today) add(totals.month, row);
    if (d >= weekStart && d <= today) add(totals.week, row);
    if (d === today) add(totals.today, row);
    if (dayMap.has(d)) add(dayMap.get(d), row);
    const ai = `${row.agent || '(이름 없음)'}\u0000${row.model || ''}`;
    if (!aiMap.has(ai)) aiMap.set(ai, { agent: row.agent || '(이름 없음)', model: row.model || '', ...zero(), noUsage: 0 });
    const a = aiMap.get(ai); add(a, row); if (!row.tokens) a.noUsage += 1;
    if (row.tokens && row.cost == null) missing.add(row.model || '(모델 이름 없음)');
  }
  return {
    rows: rows.slice(0, limit), total: rows.length, totals,
    days: [...dayMap].map(([date, v]) => ({ date, ...v })),
    byAi: [...aiMap.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests),
    missingPrices: [...missing], prices: PRICES, generatedAt: now.toISOString(),
  };
}
