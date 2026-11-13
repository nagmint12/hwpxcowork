// 관리자 설정의 'AI 크레딧' 탭: 체험에 공유하는 키와 내 키의 API 잔액·이번 달 사용량(서버 /api/admin/ai-credits — 조회는 과금 없음).
// 월 할당은 계정 단위라 같은 계정의 키는 한 묶음으로 보인다.
import { ref, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { api, fmt } from './util.js';

const num = (v) => (Number(v) || 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const day = (iso) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[1])}월 ${Number(m[2])}일` : ''; };

export const AdminCreditsPanel = {
  // mine: 웹 '내 AI 키' 안에서 내 키만(/api/me/ai/credits — 키를 등록한 누구나). 아니면 관리자 설정 탭(체험 공유 키 + 내 키)
  props: { mine: Boolean },
  template: `<section class="admin-tabpanel" :class="{ 'credit-mine': mine }" data-testid="admin-credits" aria-labelledby="admin-credits-title">
    <h2 v-if="!mine" id="admin-credits-title" class="admin-subtitle">AI 크레딧</h2>
    <p v-if="!mine" class="muted">체험에 공유하는 키와 내 키의 API 잔액입니다. 조회에는 크레딧이 들지 않습니다.</p>
    <p v-if="loading" class="admin-message" role="status">잔액을 읽는 중입니다…</p>
    <p v-else-if="error" class="admin-message err" role="alert">{{ error }}</p>
    <template v-else-if="data">
      <div v-for="(a, i) in data.accounts" :key="i" class="credit-account" data-testid="credit-account">
        <div class="credit-head"><span title="월 할당은 계정 단위입니다. 같은 계정의 키·API 화면이 함께 씁니다">남은 크레딧</span>
          <span class="admin-status" :class="chip(a).cls" data-testid="credit-status">{{ chip(a).label }}</span></div>
        <div class="credit-big" data-testid="credit-remaining">{{ num(a.balance.total.remaining) }}<span class="muted"> / {{ num(a.balance.total.quota) }}</span></div>
        <div class="credit-bar" role="img" :aria-label="'쓴 비율 ' + pct(a) + '%'"><i :class="chip(a).cls" :style="{ width: pct(a) + '%' }"></i></div>
        <dl class="credit-facts">
          <dt>이번 달 쓴 양</dt><dd>{{ num(a.balance.monthly.used) }}</dd>
          <dt title="이 계정의 API 키가 이번 달 쓴 양">API 키</dt><dd data-testid="credit-api">{{ num(a.apiCredits) }}</dd>
          <dt title="API 키로 잡히지 않는 사용(API 화면 등)">그 밖</dt><dd data-testid="credit-other">{{ num(a.otherCredits) }}</dd>
          <dt>다시 차는 날</dt><dd>{{ day(a.balance.renewalDate) || '—' }}</dd>
          <template v-if="a.balance.purchased.quota"><dt>구매 크레딧</dt><dd>{{ num(a.balance.purchased.remaining) }} / {{ num(a.balance.purchased.quota) }}</dd></template>
          <template v-if="a.balance.orgGranted.quota"><dt>기관 지원</dt><dd>{{ num(a.balance.orgGranted.remaining) }} / {{ num(a.balance.orgGranted.quota) }}</dd></template>
        </dl>
        <div v-for="k in a.keys" :key="k.owner" class="credit-key" data-testid="credit-key">
          <div class="credit-key-row"><b v-if="!mine">{{ k.owner }}</b> <code>{{ k.keyHint }}</code>
            <span v-if="k.sharing" class="admin-status ready" title="체험 계정·체험 문서의 AI 요청이 이 키로 처리됩니다">체험 공유 중</span>
            <span v-else-if="k.me" class="admin-status">내 키</span>
            <span class="credit-key-use">이번 달 {{ num(k.usage.credits) }} · {{ num(k.usage.calls) }}회</span></div>
          <details v-if="k.usage.days.length"><summary>날짜별</summary>
            <table class="admin-users credit-days"><thead><tr><th>날짜</th><th>호출</th><th>크레딧</th></tr></thead>
              <tbody><tr v-for="d in k.usage.days" :key="d.date"><td>{{ day(d.date) }}</td><td>{{ num(d.calls) }}</td><td>{{ num(d.credits) }}</td></tr></tbody></table></details>
        </div>
      </div>
      <div v-for="k in data.others" :key="k.owner" class="credit-key credit-other" data-testid="credit-missing">
        <div class="credit-key-row"><b>{{ k.owner }}</b> <code v-if="k.keyHint">{{ k.keyHint }}</code>
          <span class="admin-status pending" :title="k.error || (k.shared && !k.configured ? '체험 공유 목록에 있지만 등록한 키가 없습니다' : '')">{{ !k.configured ? '키 없음' : k.gateway !== 'baze' ? 'API 키 아님' : '조회 실패' }}</span>
          <span v-if="k.error" class="muted credit-key-use">{{ k.error }}</span></div>
      </div>
      <p v-if="!data.accounts.length && !data.others.length" class="admin-message">등록한 API 키가 없습니다.</p>
      <div class="admin-actions"><button type="button" :disabled="busy" data-testid="credit-refresh" @click="load(true)">새로 읽기</button>
        <span class="muted credit-checked">{{ fmt(data.checkedAt) }} 기준</span></div>
    </template>
  </section>`,
  setup(props) {
    const data = ref(null); const loading = ref(true); const busy = ref(false); const error = ref('');
    const pct = (a) => { const q = a.balance.total.quota; return q > 0 ? Math.min(100, Math.round((a.balance.total.used / q) * 100)) : 0; };
    const chip = (a) => {
      const { remaining, quota } = a.balance.total;
      if (remaining <= 0) return { label: '소진', cls: 'empty' };
      if (quota > 0 && remaining / quota < 0.1) return { label: '얼마 안 남음', cls: 'pending' };
      return { label: '사용 가능', cls: 'ready' };
    };
    async function load(refresh = false) {
      busy.value = true; error.value = '';
      try { data.value = await api(`${props.mine ? '/api/me/ai/credits' : '/api/admin/ai-credits'}${refresh ? '?refresh=1' : ''}`); }
      catch (e) { error.value = e.status === 404 ? '서버를 다시 시작하면 볼 수 있습니다.' : `잔액을 읽지 못했습니다: ${e.message}`; }
      finally { busy.value = false; loading.value = false; }
    }
    onMounted(() => load());
    return { data, loading, busy, error, num, day, fmt, pct, chip, load };
  },
};
