// 관리자 설정의 'AI 사용량' 탭(2026-11-16): 요청마다 저장된 토큰과 예상 API 비용(서버 /api/admin/usage-report — server/usage-report.js).
// 구독 한도(Codex·Claude 사용률)는 보이지 않는다 — 토큰 × API 공개 단가로 'API 로 냈다면'의 금액만. 화면이 열려 있는 동안 10초마다 다시 읽는다.
import { ref, computed, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { api } from './util.js';

const num = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const short = (v) => { const x = Number(v) || 0; return x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${(x / 1e3).toFixed(1)}k` : num(x); };
const usd = (v) => (v == null ? '—' : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`);
const when = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const d = new Date(t + 9 * 3600e3).toISOString(); return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}`; };
const dayLabel = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const secs = (s) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${s}초`);
const STATUS = { done: '완료', failed: '실패', working: '처리 중', pending: '대기열', canceled: '취소됨' };   // 상태 글은 AI 작업 칩과 같게(docs/UI_TERMS.md §1-3)

export const AdminUsagePanel = {
  template: `<section class="admin-tabpanel usage-panel" data-testid="admin-usage" aria-labelledby="admin-usage-title">
    <h2 id="admin-usage-title" class="admin-subtitle">AI 사용량</h2>
    <p class="muted">AI 요청마다 기록된 토큰과 예상 API 비용입니다. 구독으로 처리한 요청도 같은 토큰을 API로 냈다면의 금액으로 셉니다. 10초마다 새로 읽습니다.</p>
    <div v-if="error" class="admin-message" data-testid="admin-load-failed"><p class="err" role="alert">{{ error }}<template v-if="data"> 아래는 마지막으로 읽은 사용량입니다.</template></p><button type="button" @click="retry">다시 읽기</button></div>
    <p v-if="!error && !data" class="admin-message" role="status">사용량을 읽는 중입니다…</p>
    <template v-if="data">
      <div class="usage-cards">
        <div v-for="p in periods" :key="p.id" class="usage-card" :data-testid="'usage-total-' + p.id">
          <span class="muted">{{ p.label }}</span>
          <b class="usage-cost">{{ usd(data.totals[p.id].cost) }}</b>
          <span>입력 {{ short(data.totals[p.id].input) }} <span class="muted">(캐시 {{ pct(data.totals[p.id]) }}%)</span> · 출력 {{ short(data.totals[p.id].output) }}</span>
          <span class="muted">요청 {{ num(data.totals[p.id].requests) }}건</span>
        </div>
      </div>
      <h3 class="usage-h">최근 14일 예상 비용</h3>
      <div class="usage-chart" role="img" :aria-label="chartLabel">
        <div v-for="d in data.days" :key="d.date" class="usage-col" :title="dayLabel(d.date) + ' · ' + usd(d.cost) + ' · 입력 ' + num(d.input) + ' · 출력 ' + num(d.output) + ' · 요청 ' + d.requests + '건'">
          <span class="usage-val">{{ d.cost ? usd(d.cost) : '' }}</span>
          <i :style="{ height: bar(d.cost) + '%' }"></i>
          <span class="usage-day">{{ dayLabel(d.date) }}</span>
        </div>
      </div>
      <h3 class="usage-h">AI별</h3>
      <div class="usage-scroll"><table class="admin-users usage-table" data-testid="usage-by-ai">
        <thead><tr><th>AI</th><th>모델</th><th class="r">요청</th><th class="r">새 입력</th><th class="r">캐시 읽음</th><th class="r">캐시 씀</th><th class="r">출력</th><th class="r">예상 비용</th></tr></thead>
        <tbody><tr v-for="a in data.byAi" :key="a.agent + a.model">
          <td>{{ a.agent }}</td><td><code v-if="a.model">{{ a.model }}</code><span v-else class="muted">—</span></td>
          <td class="r">{{ num(a.requests) }}<span v-if="a.noUsage" class="muted" title="사용량을 알리지 않은 요청"> (기록 없음 {{ a.noUsage }})</span></td>
          <td class="r">{{ num(a.fresh) }}</td><td class="r">{{ num(a.cacheRead) }}</td><td class="r">{{ num(a.cacheWrite) }}</td><td class="r">{{ num(a.output) }}</td>
          <td class="r"><b>{{ a.requests - a.noUsage - a.unpriced > 0 ? usd(a.cost) : '—' }}</b></td></tr>
          <tr v-if="!data.byAi.length"><td colspan="8" class="muted">아직 AI가 처리한 요청이 없습니다.</td></tr></tbody></table></div>
      <h3 class="usage-h">요청별 <span class="muted">(최근 {{ data.rows.length }}건{{ data.total > data.rows.length ? ' / 전체 ' + num(data.total) + '건' : '' }})</span></h3>
      <div class="usage-scroll"><table class="admin-users usage-table" data-testid="usage-rows">
        <thead><tr><th>요청 시각</th><th>문서</th><th>요청</th><th>AI · 모델</th><th class="r">입력</th><th class="r">캐시</th><th class="r">출력</th><th class="r">예상 비용</th><th class="r">요청→완료</th><th>결과</th></tr></thead>
        <tbody><tr v-for="r in data.rows" :key="r.docId + '#' + r.rid">
          <td class="nowrap">{{ when(r.at) }}</td>
          <td class="usage-title" :title="r.title">{{ r.title || r.docId }}</td>
          <td class="nowrap">{{ r.label }} #{{ r.rid }}<span v-if="r.by" class="muted"> · {{ r.by }}</span></td>
          <td>{{ r.agent || '—' }}<br v-if="r.model"><code v-if="r.model">{{ r.model }}</code></td>
          <template v-if="r.tokens"><td class="r">{{ num(r.tokens.input) }}</td><td class="r">{{ num(r.tokens.cacheRead) }}</td><td class="r">{{ num(r.tokens.output) }}</td>
            <td class="r"><b v-if="r.cost != null">{{ usd(r.cost) }}</b><span v-else class="muted" title="단가 표에 없는 모델">단가 없음</span></td></template>
          <td v-else colspan="4" class="muted">기록 없음</td>
          <td class="r nowrap">{{ secs(r.seconds) }}</td>
          <td class="nowrap">{{ status(r.status) }}<span v-if="r.proposals" class="muted"> · 제안 {{ r.proposals }}</span></td></tr>
          <tr v-if="!data.rows.length"><td colspan="10" class="muted">아직 AI가 처리한 요청이 없습니다.</td></tr></tbody></table></div>
      <details class="usage-prices"><summary>계산에 쓴 단가 (USD / 100만 토큰)</summary>
        <table class="admin-users usage-table"><thead><tr><th>모델</th><th class="r">입력</th><th class="r">캐시 읽음</th><th class="r">캐시 씀</th><th class="r">출력</th></tr></thead>
          <tbody><tr v-for="(p, k) in data.prices" :key="k"><td><code>{{ k }}</code></td><td class="r">{{ p.input }}</td><td class="r">{{ p.cacheRead }}</td><td class="r">{{ p.cacheWrite }}</td><td class="r">{{ p.output }}</td></tr></tbody></table>
        <p class="muted">GPT는 연결한 게이트웨이의 모델 목록 단가(청구액과 맞춰 확인), Claude는 Anthropic 공개 단가입니다. 지운 문서의 요청은 셈에서 빠집니다.</p></details>
      <p v-if="data.missingPrices.length" class="admin-message pending">단가가 없어 비용에서 빠진 모델: <code v-for="m in data.missingPrices" :key="m">{{ m }} </code></p>
      <p class="muted usage-at">{{ when(data.generatedAt) }} 기준</p>
    </template>
  </section>`,
  setup() {
    const data = ref(null); const error = ref('');
    const periods = [{ id: 'today', label: '오늘' }, { id: 'week', label: '최근 7일' }, { id: 'month', label: '이번 달' }, { id: 'all', label: '전체' }];
    let timer = null; let busy = false;
    async function load() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const res = await api('/api/admin/usage-report');
        if (!res?.totals) throw Object.assign(new Error('응답 형식이 맞지 않습니다'), { status: 404 });
        data.value = res; error.value = '';
      }
      catch (e) { error.value = e.status === 404 ? '서버를 다시 시작하면 사용량을 볼 수 있습니다.' : `사용량을 읽지 못했습니다: ${e.message}`; }
      finally { busy = false; }
    }
    const max = computed(() => Math.max(0, ...(data.value?.days || []).map((d) => d.cost)));
    const bar = (cost) => (max.value > 0 ? Math.max(cost > 0 ? 2 : 0, Math.round((cost / max.value) * 100)) : 0);
    const pct = (t) => (t.input ? Math.round((t.cacheRead / t.input) * 100) : 0);
    const status = (s) => STATUS[s] || s || '—';
    const chartLabel = computed(() => (data.value?.days || []).filter((d) => d.cost).map((d) => `${dayLabel(d.date)} ${usd(d.cost)}`).join(', ') || '최근 14일 사용 없음');
    // 읽기에 실패해도 마지막으로 읽은 표는 그대로 두고(10초마다 다시 읽는다) 오류 줄에 [다시 읽기] — 2026-11-17: 예전에는 오류 글만 남고 표가 사라졌다
    const retry = () => load();
    onMounted(() => { load(); timer = setInterval(load, 10000); document.addEventListener('visibilitychange', load); });
    onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', load); });
    return { data, error, retry, periods, num, short, usd, when, dayLabel, secs, bar, pct, status, chartLabel };
  },
};
