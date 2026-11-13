// ⚙ 문서 설정 창(docs/V4_SPEC.md §5) — 관리자·문서를 올린 사람(s.canConfigure)만 연다.
// 설정: 편집 방식(실시간 / 승인 후 반영) · 수정 권한(편집자 모두 / 지정한 사람 — GET /api/users 의 사람 목록, 관리자는 언제나) ·
// 실시간 기록(고친 글만 / 변경 추적) · 한글로 저장(보이는 그대로 / 변경 추적 포함 — 둘 다 메모 포함) · AI 메모(요약 / 요약 + 반영 목록 / 안 남김) ·
// AI에게 빠르게 맡기기(바로 보내기 / 확인 후 보내기 — 예시 지시를 넣은 요청) · AI 자동 반영(직접 / 자동).
// 보이는 글은 이름표만(docs/UI_TERMS.md §1): 항목 설명은 이름 옆 '?'(Hint), 선택지 설명은 마우스 올림(title) — 글은 view.js SETTING_FIELDS.
// 승인 → 실시간으로 바꿀 때 진행 중 변경 요청이 있으면 경고 줄. [저장] = PATCH /settings(바뀐 키만 — view.js settingsPatch), 오류는 창 안에.
// 모델(값·바뀐 것·사람 목록·경고)은 순수 함수(web/view.js — tests/view.test.mjs).
import { ref, reactive, computed, inject, onMounted } from '/vendor/vue.esm-browser.prod.js';
import { toast } from './util.js';
import { FloatWin, Hint } from './ui.js';
import { SETTING_FIELDS, SETTINGS_WARN_TIP, settingsForm, settingsPatch, editorChoices, settingsWarning } from './view.js';

export const SettingsDialog = {
  components: { FloatWin, Hint },
  emits: ['close'],
  template: `<FloatWin :anchor="null" :width="420" title="문서 설정" cls="docsettings" @close="$emit('close')">
    <div class="ds-body" data-testid="settings-dialog">
      <div class="ds-row" v-for="f in fields" :key="f.key" :data-setting="f.key" :class="{ dim: idle(f.key) }">
        <div class="ds-label"><span class="ds-name">{{ f.label }}</span><Hint v-if="f.help" :text="f.help"/><span class="muted ds-note" v-if="idle(f.key)">실시간일 때만</span></div>
        <div class="ds-opts" role="radiogroup" :aria-label="f.label">
          <label v-for="[v, label] in f.options" :key="v" class="ds-opt" :class="{ on: valueOf(f.key) === v }" :title="f.tips?.[v] || null">
            <input type="radio" :name="'ds-' + f.key" :value="v" :checked="valueOf(f.key) === v" :data-value="v" @change="setValue(f.key, v)"/> {{ label }}</label>
        </div>
        <div class="ds-people" v-if="f.key === 'editors' && form.editorsMode === 'some'" data-testid="settings-people">
          <span class="muted" v-if="loadingUsers"><span class="spin dark"></span> 사람 목록을 읽는 중…</span>
          <label v-for="u in people" :key="u.name" class="ds-person" :class="{ off: u.disabled }" :title="u.note || null">
            <input type="checkbox" :checked="u.checked" :disabled="u.disabled" :data-person="u.name" @change="togglePerson(u.name, $event.target.checked)"/> {{ u.name }}<span class="muted" v-if="u.note"> · {{ u.note }}</span></label>
          <span class="muted" v-if="!loadingUsers && !people.length">사람 목록이 없습니다</span>
        </div>
      </div>
      <div class="ds-warn" v-if="warning" data-testid="settings-warning" :title="warnTip">⚠ {{ warning }}</div>
      <div class="err ds-err" v-if="error" data-testid="settings-error">{{ error }}</div>
      <div class="row end ds-foot"><span class="muted" v-if="!dirty">바뀐 것 없음</span><span class="spacer"></span>
        <button class="small" @click="$emit('close')">취소</button>
        <button class="small primary" data-testid="settings-save" :disabled="busy || !dirty" @click="save"><span v-if="busy" class="spin"></span>저장</button></div>
    </div>
  </FloatWin>`,
  setup(props, { emit }) {
    const d = inject('doc');
    const form = reactive(settingsForm(d.s.settings));
    const users = ref([]); const loadingUsers = ref(false);
    const busy = ref(false); const error = ref('');
    const fields = SETTING_FIELDS;
    const valueOf = (k) => (k === 'editors' ? form.editorsMode : form[k]);
    // 실시간 기록은 실시간 편집일 때만 쓴다 — 승인 방식이면 옅게 + '실시간일 때만'
    const idle = (k) => k === 'track' && form.editMode !== 'realtime';
    function setValue(k, v) {
      error.value = '';
      if (k === 'editors') {
        form.editorsMode = v === 'some' ? 'some' : 'all';
        // '편집자 모두' → '지정한 사람': 처음에는 편집자 모두를 골라 둔다(뺄 사람만 끄면 되게)
        if (form.editorsMode === 'some' && !form.editors.length) form.editors = users.value.filter((u) => u && u.name && (u.role || 'editor') === 'editor').map((u) => u.name);
      } else form[k] = v;
    }
    function togglePerson(name, on) {
      error.value = '';
      const set = new Set(form.editors);
      if (on) set.add(name); else set.delete(name);
      form.editors = [...set];
    }
    const people = computed(() => editorChoices(users.value, form));
    const patch = computed(() => settingsPatch(form, d.s.settings));
    const dirty = computed(() => Object.keys(patch.value).length > 0);
    const activeCrs = computed(() => (d.s.crs || []).filter((c) => c && (c.status === 'draft' || c.status === 'open')).length);
    const warning = computed(() => settingsWarning(d.s.settings, form, activeCrs.value));
    onMounted(async () => {
      loadingUsers.value = true;
      try { users.value = await d.listUsers(); } catch (e) { error.value = `사람 목록을 읽지 못했습니다: ${e.message}`; } finally { loadingUsers.value = false; }
    });
    async function save() {
      if (busy.value || !dirty.value) return;
      busy.value = true; error.value = '';
      try {
        await d.patchSettings(patch.value);
        toast('문서 설정을 저장했습니다');
        emit('close');
      } catch (e) { error.value = e.message || String(e); } finally { busy.value = false; }
    }
    return { form, fields, valueOf, idle, setValue, togglePerson, people, loadingUsers, busy, error, dirty, warning, warnTip: SETTINGS_WARN_TIP, save };
  },
};
export default SettingsDialog;
