import { ref, computed, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { api } from './util.js';
import { defaultTutorialDefinition, normalizeTutorialDefinition, TUTORIAL_MODULES, TUTORIAL_SOURCES } from './tutorial-definition.js';
import { TutorialStepEditor } from './tutorial-step-editor.js';
import { validateTutorialStepReferences } from './tutorial-modules/compose.js';

const clone = value => JSON.parse(JSON.stringify(value));
const freshKey = (prefix, used) => { let n = 1; let key = prefix; while (used.includes(key)) key = `${prefix}-${++n}`; return key; };

export const TutorialEditor = {
  components: { TutorialStepEditor },
  emits: ['saved', 'close'],
  template: `<section class="tutorial-editor" data-testid="tutorial-editor" aria-labelledby="tutorial-editor-title">
    <div class="row tutorial-editor-heading"><h2 id="tutorial-editor-title">튜토리얼 구성 편집</h2><span class="spacer"></span><button @click="close" :disabled="saving">닫기</button></div>
    <p class="muted">튜토리얼과 모듈의 순서를 바꾸고 필요한 실습만 조합하세요. 저장한 구성은 새로 시작하는 연습부터 적용됩니다.</p>
    <p v-if="error" class="tour-error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="!draft">구성을 읽는 중… <button v-if="error" @click="load">다시 읽기</button></p>
    <template v-else>
      <fieldset :disabled="saving">
        <label class="tutorial-field">첫 접속 시 안내할 튜토리얼
          <select v-model="draft.entryCourseId"><option :value="null">자동 안내 없음</option><option v-for="item in enabledCourses" :key="item.id" :value="item.id">{{ item.title }}</option></select>
        </label>
        <div class="tutorial-editor-layout">
          <nav class="tutorial-course-list" aria-label="튜토리얼 순서">
            <div v-for="(item, index) in draft.courses" :key="item.id" class="tutorial-course-row" :class="{ selected: selectedId === item.id }">
              <button class="tutorial-course-select" @click="selectedId = item.id" :aria-current="selectedId === item.id ? 'true' : undefined">{{ index + 1 }}. {{ item.title }}<small v-if="!item.enabled">숨김</small></button>
              <div class="tutorial-order-buttons"><button :disabled="index === 0" @click="move(draft.courses, index, -1)" :aria-label="item.title + ' 위로'">↑</button><button :disabled="index === draft.courses.length - 1" @click="move(draft.courses, index, 1)" :aria-label="item.title + ' 아래로'">↓</button></div>
            </div>
            <label class="tutorial-field">새 튜토리얼의 연습 문서<select v-model="newSource"><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.title }}{{ source.available === false ? ' (원본 없음)' : '' }}</option></select></label>
            <button @click="addCourse" data-testid="tutorial-add-course" :disabled="draft.courses.length >= 50">+ 튜토리얼 추가</button>
          </nav>
          <div class="tutorial-course-detail" v-if="course">
            <div class="row"><h3>선택한 튜토리얼</h3><span class="spacer"></span><button @click="removeCourse" data-testid="tutorial-remove-course">목록에서 제거</button></div>
            <label class="tutorial-field">튜토리얼 제목<input v-model="course.title" maxlength="160" data-testid="tutorial-course-title"></label>
            <label class="tutorial-field">목록 설명<textarea v-model="course.description" rows="2" maxlength="1000"></textarea></label>
            <label class="tutorial-toggle"><input type="checkbox" v-model="course.enabled" @change="syncEntry">튜토리얼 메뉴에 표시</label>
            <p class="muted">연습 문서: {{ sourceTitle(course.sourceId) }} <span v-if="sourceMissing(course.sourceId)" class="tour-error">· 원본 문서가 없어 시작할 수 없습니다.</span></p>
            <h3>진행 순서 <small>{{ course.modules.length }}개 모듈</small></h3>
            <p v-if="!course.modules.length" class="muted">아래 모듈 목록에서 실습이나 안내를 추가하세요.</p>
            <article v-for="(item, index) in course.modules" :key="item.key" class="tutorial-module-row" :data-module-key="item.key">
              <div class="row"><b>{{ index + 1 }}. {{ moduleTitle(item.moduleId) }}</b><span class="spacer"></span>
                <button :disabled="index === 0" @click="move(course.modules, index, -1)" :aria-label="moduleTitle(item.moduleId) + ' 모듈 위로'">↑</button>
                <button :disabled="index === course.modules.length - 1" @click="move(course.modules, index, 1)" :aria-label="moduleTitle(item.moduleId) + ' 모듈 아래로'">↓</button>
                <button @click="course.modules.splice(index, 1)" :aria-label="moduleTitle(item.moduleId) + ' 모듈 제거'">제거</button>
              </div>
              <label class="tutorial-toggle"><input type="checkbox" :checked="item.motion !== false" @change="item.motion = $event.target.checked">이 모듈의 포인터·타자 효과 사용</label>
              <details :open="item.moduleId === 'guide'"><summary>안내 문구 편집{{ item.title || item.text ? ' · 작성됨' : '' }}</summary>
                <p class="muted" v-if="item.moduleId !== 'guide'">작성한 안내가 이 실습 앞에 표시됩니다. 비워 두면 기본 실습으로 바로 진행합니다.</p>
                <label class="tutorial-field">안내 제목<input v-model="item.title" maxlength="160" :placeholder="moduleTitle(item.moduleId)"></label>
                <label class="tutorial-field">안내 내용<textarea v-model="item.text" rows="3" maxlength="6000" placeholder="학습자에게 안내할 내용을 적으세요."></textarea></label>
              </details>
              <TutorialStepEditor v-if="item.moduleId !== 'guide'" :module="item" :source-id="course.sourceId"/>
            </article>
            <h3>추가할 모듈</h3><p class="muted">이 연습 문서에서 실행할 수 있는 모듈입니다. 다른 문서의 실습은 튜토리얼을 추가한 뒤 순서대로 배치하세요.</p>
            <div class="tutorial-module-palette"><button v-for="module in compatibleModules" :key="module.id" @click="addModule(module)" :disabled="course.modules.length >= 64 || (!['guide', 'custom'].includes(module.id) && course.modules.some(item => item.moduleId === module.id))" :data-add-module="module.id"><b>+ {{ module.title }}</b><small>{{ module.description }}</small></button></div>
          </div>
          <p v-else class="muted">새 튜토리얼을 추가해 구성을 시작하세요.</p>
        </div>
      </fieldset>
      <div class="tutorial-editor-actions"><button class="primary" @click="save" :disabled="saving || !dirty" data-testid="tutorial-save-definition">{{ saving ? '저장 중…' : '구성 저장' }}</button><span role="status">{{ dirty ? '저장하지 않은 변경이 있습니다.' : '저장된 구성입니다.' }}</span><span class="spacer"></span><button @click="resetDraft" :disabled="saving || !dirty">변경 취소</button><button @click="restoreDefaults" :disabled="saving">기본 구성 불러오기</button></div>
    </template>
  </section>`,
  setup(_props, { emit }) {
    const draft = ref(null); const saved = ref(null); const revision = ref(null); const selectedId = ref('');
    const error = ref(''); const message = ref(''); const saving = ref(false); const newSource = ref('ai-advanced');
    const sources = ref(TUTORIAL_SOURCES); const modules = ref(TUTORIAL_MODULES); let active = true;
    const course = computed(() => draft.value?.courses.find(item => item.id === selectedId.value));
    const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value));
    const enabledCourses = computed(() => draft.value?.courses.filter(item => item.enabled) || []);
    const compatibleModules = computed(() => modules.value.filter(item => !item.sourceId || item.sourceId === course.value?.sourceId));
    const moduleTitle = id => modules.value.find(item => item.id === id)?.title || id;
    const sourceTitle = id => sources.value.find(item => item.id === id)?.title || id;
    const sourceMissing = id => sources.value.find(item => item.id === id)?.available === false;
    async function load() {
      error.value = '';
      try {
        const result = await api('/api/tutorial/definition'); if (!active) return;
        draft.value = clone(result.definition); saved.value = clone(result.definition); revision.value = result.revision;
        modules.value = result.modules || TUTORIAL_MODULES; sources.value = result.sources || TUTORIAL_SOURCES;
        selectedId.value = draft.value.courses[0]?.id || '';
      } catch (e) { if (active) error.value = `구성을 읽지 못했습니다: ${e.message}`; }
    }
    function move(items, index, direction) { const next = index + direction; if (next < 0 || next >= items.length) return; items.splice(next, 0, items.splice(index, 1)[0]); }
    function addCourse() {
      const defaults = defaultTutorialDefinition().courses.find(item => item.sourceId === newSource.value);
      const item = clone(defaults); item.id = freshKey('course', draft.value.courses.map(value => value.id)); item.title = `새 튜토리얼 — ${sourceTitle(item.sourceId)}`;
      draft.value.courses.push(item); selectedId.value = item.id;
    }
    function syncEntry() { if (!enabledCourses.value.some(item => item.id === draft.value.entryCourseId)) draft.value.entryCourseId = null; }
    function removeCourse() { draft.value.courses = draft.value.courses.filter(item => item.id !== selectedId.value); selectedId.value = draft.value.courses[0]?.id || ''; syncEntry(); }
    function addModule(module) {
      const key = freshKey(module.id, course.value.modules.map(item => item.key));
      course.value.modules.push({ key, moduleId: module.id, ...(module.id === 'guide' ? { title: '새 안내', text: '이 단계에서 알아둘 내용을 적으세요.' } : {}), ...(module.id === 'custom' ? { steps: [{ key: 'notice', kind: 'custom', actionId: 'notice', title: '새 행동', text: '이 단계에서 할 일을 적으세요.', params: {} }] } : {}) });
    }
    function resetDraft() { draft.value = clone(saved.value); selectedId.value = draft.value.courses[0]?.id || ''; error.value = ''; message.value = '저장 전 변경을 취소했습니다.'; }
    function restoreDefaults() { draft.value = defaultTutorialDefinition(); selectedId.value = draft.value.courses[0]?.id || ''; error.value = ''; message.value = '기본 구성을 불러왔습니다. 구성 저장을 누르면 적용됩니다.'; }
    async function save() {
      if (saving.value) return;
      error.value = ''; message.value = '';
      let definition;
      try { definition = normalizeTutorialDefinition(draft.value); validateTutorialStepReferences(definition); }
      catch (e) { error.value = e.message; return; }
      saving.value = true;
      try {
        const result = await api('/api/tutorial/definition', { method: 'PUT', body: { definition, revision: revision.value } });
        if (!active) return;
        draft.value = clone(result.definition); saved.value = clone(result.definition); revision.value = result.revision;
        message.value = '구성을 저장했습니다. 새 연습부터 적용되며 진행 중인 연습은 유지됩니다.'; emit('saved');
      } catch (e) { if (active) error.value = e.status === 409 ? '다른 관리자가 구성을 변경했습니다. 입력 내용은 유지됩니다. 변경 내용을 기록한 뒤 이 편집 화면을 다시 열어 최신 구성을 읽어 주세요.' : `저장하지 못했습니다: ${e.message}`; }
      finally { saving.value = false; }
    }
    function close() { if (dirty.value && !window.confirm('저장하지 않은 변경을 버리고 닫을까요?')) return; emit('close'); }
    const beforeUnload = event => { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } };
    onMounted(() => { load(); window.addEventListener('beforeunload', beforeUnload); });
    onBeforeUnmount(() => { active = false; window.removeEventListener('beforeunload', beforeUnload); });
    return { draft, course, selectedId, error, message, saving, newSource, sources, dirty, enabledCourses, compatibleModules, moduleTitle, sourceTitle, sourceMissing, load, move, addCourse, syncEntry, removeCourse, addModule, resetDraft, restoreDefaults, save, close };
  },
};
