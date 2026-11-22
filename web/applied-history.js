import { computed, inject, nextTick, ref, watch } from '/vendor/vue.esm-browser.prod.js';
import { diffText } from './diff.js';
import { proposalPlace, refWords, appliedRange } from './proposal-place.js';
import { fmtStamp } from './util.js';
import { focusIn, FormatPreview, ResultItem } from './ui.js';

const PAGE_SIZE = 20;
const isReplacement = p => !p.type || p.type === 'replace';


function entryLocation(p, doc) {
  const place = proposalPlace(p);
  const paragraph = !place.gone && place.ref ? doc.byRef(place.ref) : null;
  const cell = paragraph?.cell;
  const address = place.gone ? '' : place.ref || '';
  const label = [refWords(address) || address,
    Number.isInteger(cell?.row) && Number.isInteger(cell?.col) ? '표 ' + (cell.row + 1) + '행 ' + (cell.col + 1) + '열' : ''].filter(Boolean).join(' · ');
  return { p, paragraph, address, label };
}

function textComparison(p) {
  // 매우 긴 두 본문도 생략 없이 보여 주되 차이 계산으로 패널을 막지 않는다.
  if (typeof p.find !== 'string' || typeof p.replace !== 'string' || p.find.length + p.replace.length > 12000) return null;
  return diffText(p.find, p.replace);
}

export const AppliedHistory = {
  components: { ResultItem, FormatPreview },
  template: `<details v-if="applied.length" class="card hist-applied" @toggle="expanded = $event.currentTarget.open">
    <summary>AI 반영 내역 <span>{{ applied.length }}건</span></summary>
    <template v-if="expanded">
      <div ref="toolbar" class="hist-applied-tools">
        <select v-if="requestIds.length > 1" v-model="rid" aria-label="AI 작업 선택">
          <option value="">모든 AI 작업</option><option v-for="id in requestIds" :key="id" :value="id">AI 작업 #{{ id }}</option>
        </select>
        <input type="search" v-model="query" aria-label="반영 내역 검색" placeholder="원문·바뀐 글·위치 검색">
      </div>
      <p class="muted" role="status">{{ filtered.length ? first + 1 + '–' + Math.min(first + pageSize, filtered.length) + ' / ' + filtered.length + '건' : '검색 결과가 없습니다.' }}</p>
      <article v-for="row in visible" :key="row.p.pid" class="hist-applied-row" :data-pid="row.p.pid">
        <div class="head"><strong>제안 #{{ row.p.pid }}</strong><span class="muted">AI 작업 #{{ row.p.rid }} · {{ fmtStamp(row.p.appliedAt) }} {{ row.p.appliedBy }}</span></div>
        <template v-if="isReplacement(row.p)">
          <div v-if="row.paragraph" class="row">
            <button type="button" class="linkish hist-jump" :title="row.address" @click="jump(row)">{{ row.label }} · {{ row.range ? (row.p.replace ? '바뀐 글로' : '삭제 자리로') : '문단으로' }}</button>
          </div>
          <div v-else class="muted">{{ row.label ? row.label + ' · ' : '' }}현재 위치를 확인할 수 없습니다</div>
          <dl class="hist-applied-text">
            <dt>반영 전</dt><dd class="difftext"><template v-if="row.p.find == null">원문 기록 없음</template><span class="muted" v-else-if="row.p.find === ''">(빈 글)</span><template v-else-if="row.diff"><template v-for="(part, i) in row.diff" :key="i"><del v-if="part.t === 'del'">{{ part.s }}</del><template v-else-if="part.t === 'eq'">{{ part.s }}</template></template></template><template v-else>{{ row.p.find }}</template></dd>
            <dt>반영 후</dt><dd class="difftext"><template v-if="row.p.replace == null">반영 후 기록 없음</template><span class="muted" v-else-if="row.p.replace === ''">(삭제됨)</span><template v-else-if="row.diff"><template v-for="(part, i) in row.diff" :key="i"><ins v-if="part.t === 'ins'">{{ part.s }}</ins><template v-else-if="part.t === 'eq'">{{ part.s }}</template></template></template><template v-else>{{ row.p.replace }}</template></dd>
          </dl>
          <FormatPreview v-if="row.p.format || row.p.runs?.length" :proposal="row.p"/>
          <div v-if="row.p.reason" class="muted">{{ row.p.reason }}</div>
        </template>
        <ResultItem v-else :it="{ list: [row.p], state: 'accepted' }" ro/>
      </article>
      <nav v-if="pages > 1" class="hist-applied-pages" aria-label="반영 내역 페이지">
        <button type="button" class="small" :disabled="page <= 1" @click="turn(-1)">이전</button><span>{{ page }} / {{ pages }}</span>
        <button type="button" class="small" :disabled="page >= pages" @click="turn(1)">다음</button>
      </nav>
    </template>
  </details>`,
  setup() {
    const doc = inject('doc');
    const expanded = ref(false), toolbar = ref(null);
    const query = ref(''), rid = ref(''), page = ref(1);
    // 이미 화면에 전달된 공유 문서 반영분만 사용한다. 수정본 채택·거절·되돌림은 제외한다.
    const applied = computed(() => (doc.s.proposals || []).filter(p =>
      p.status === 'applied' && p.rid != null && !doc.proposalHidden(p)));
    const requestIds = computed(() => [...new Set(applied.value.map(p => p.rid))].sort((a, b) => b - a));
    const entries = computed(() => applied.value.slice().sort((a, b) =>
      (Number(b.appliedVersion) || 0) - (Number(a.appliedVersion) || 0) || a.pid - b.pid
    ).map(p => entryLocation(p, doc)));
    const filtered = computed(() => {
      const term = query.value.trim().toLowerCase();
      return entries.value.filter(({ p, label, address }) => {
        if (rid.value !== '' && p.rid !== rid.value) return false;
        return !term || ['#' + p.pid, 'AI 작업 #' + p.rid, label, address, p.find, p.replace, p.text, p.reason]
          .some(value => typeof value === 'string' && value.toLowerCase().includes(term));
      });
    });
    const pages = computed(() => Math.ceil(filtered.value.length / PAGE_SIZE));
    const first = computed(() => (page.value - 1) * PAGE_SIZE);
    const visible = computed(() => filtered.value.slice(first.value, first.value + PAGE_SIZE).map(row => ({
      ...row, range: isReplacement(row.p) ? appliedRange(row.p, row.paragraph, doc.s.paraVersion) : null,
      diff: isReplacement(row.p) ? textComparison(row.p) : null,
    })));
    watch([query, rid], () => { page.value = 1; });
    watch(requestIds, ids => { if (!ids.includes(rid.value)) rid.value = ''; });
    watch(() => expanded.value ? pages.value : null, count => {
      if (count !== null) page.value = Math.min(page.value, Math.max(1, count));
    });
    function turn(step) {
      page.value = Math.min(pages.value, Math.max(1, page.value + step));
      nextTick(() => toolbar.value?.scrollIntoView({ block: 'nearest' }));
    }
    function jump(row) { if (row.paragraph) focusIn(doc, row.range || { ref: row.address }); }
    return { expanded, toolbar, query, rid, page, applied, requestIds, filtered, visible, pages, first, pageSize: PAGE_SIZE, turn, jump, fmtStamp, isReplacement };
  },
};
