import { computed, ref } from '/vendor/vue.esm-browser.prod.js';
import { TUTORIAL_MODULES } from './tutorial-definition.js';
import { CUSTOM_TUTORIAL_ACTIONS } from './tutorial-action-definition.js';
import { describeTutorialModule } from './tutorial-modules/compose.js';

const fresh = (prefix, items) => { let key = prefix; let n = 1; while (items.some(item => item.key === key)) key = `${prefix}-${++n}`; return key; };
const describe = id => ['custom', 'guide'].includes(id) ? { steps: [] } : describeTutorialModule(id);
export const defaultModuleStepRefs = moduleId => describe(moduleId).steps.map(step => ({ key: step.stepId, kind: 'builtin', stepId: step.stepId }));

export const TutorialStepEditor = {
  props: ['module', 'sourceId'],
  template: `<section class="tutorial-step-editor" :data-steps-for="module.key">
    <div class="row"><h4>행동 단계 <span>{{ items.length }}개</span></h4><span class="spacer"></span><button v-if="module.steps && module.moduleId !== 'custom'" @click="restore">기본 단계로 되돌리기</button></div>
    <p class="muted">각 단계의 행동·대상·완료 조건을 확인하고 문구를 편집하세요. 준비 단계가 필요한 행동은 순서를 유지해야 합니다.</p>
    <ol class="tutorial-step-list">
      <li v-for="(item, index) in items" :key="item.key" class="tutorial-step-item" :data-step-key="item.key" :class="{ disabled: item.enabled === false }">
        <div class="row tutorial-step-heading"><b>{{ index + 1 }}. {{ shownTitle(item) }}</b><span class="spacer"></span>
          <label class="tutorial-step-use"><input type="checkbox" :checked="item.enabled !== false" @change="set(index, 'enabled', $event.target.checked)">사용</label>
          <button :disabled="index === 0" @click="move(index, -1)" :aria-label="shownTitle(item) + ' 단계 위로'">↑</button>
          <button :disabled="index === items.length - 1" @click="move(index, 1)" :aria-label="shownTitle(item) + ' 단계 아래로'">↓</button>
          <button @click="remove(index)" :aria-label="shownTitle(item) + ' 단계 제거'">제거</button>
        </div>
        <p class="tutorial-step-behavior"><strong>{{ behavior(item) }}</strong> · {{ metadata(item)?.completion || action(item)?.description }}</p>
        <p class="muted" v-if="metadata(item)?.target">대상: {{ metadata(item).target }}</p>
        <p class="tutorial-step-dependencies" v-if="dependencyTitles(item).length">준비 단계: {{ dependencyTitles(item).join(' → ') }}</p>
        <details><summary>문구·행동 편집</summary>
          <label class="tutorial-field">단계 제목<input :value="item.title ?? metadata(item)?.title ?? ''" @input="set(index, 'title', $event.target.value)" maxlength="160"></label>
          <label class="tutorial-field">안내 문구<textarea :value="item.text ?? metadata(item)?.text ?? ''" @input="set(index, 'text', $event.target.value)" maxlength="6000" rows="3"></textarea></label>
          <p class="muted" v-if="item.kind === 'builtin'">문구를 수정하면 이 단계의 안내를 교체합니다. 행동과 완료 조건은 유지됩니다.</p>
          <label v-if="item.actionId === 'notice' || metadata(item)?.nextLabel" class="tutorial-field">다음 버튼 문구 <small>(비워 두면 기본값)</small><input :value="item.next || ''" @input="set(index, 'next', $event.target.value)" maxlength="100"></label>
          <label class="tutorial-toggle"><input type="checkbox" :checked="item.motion !== false" :disabled="module.motion === false" @change="set(index, 'motion', $event.target.checked)">이 단계의 포인터·타자 효과 사용</label>
          <template v-if="item.kind === 'builtin'"><button @click="clearText(index)">기본 문구 복원</button> <button @click="convert(index)">등록된 custom 동작으로 전환</button></template>
          <template v-else>
            <label class="tutorial-field">행동 종류<select :value="item.actionId" @change="changeAction(index, $event.target.value)"><option v-for="option in actions" :key="option.id" :value="option.id">{{ option.title }}</option></select></label>
            <p class="muted">{{ action(item)?.description }}</p>
            <label v-if="fields(item).includes('scope')" class="tutorial-field">대상 위치<select :value="item.params?.scope || 'document'" @change="param(index, 'scope', $event.target.value)"><option value="document">앱 화면</option><option value="editor">문서 편집기 안</option></select></label>
            <label v-if="fields(item).includes('selector')" class="tutorial-field">대상 선택자<input :value="item.params?.selector || ''" @input="param(index, 'selector', $event.target.value)" placeholder="예: .composer-win .cmp-instr" maxlength="500"></label>
            <label v-if="fields(item).includes('value')" class="tutorial-field">입력할 예시<textarea :value="item.params?.value || ''" @input="param(index, 'value', $event.target.value)" rows="3" maxlength="6000"></textarea></label>
            <label v-if="fields(item).includes('text')" class="tutorial-field">선택할 문서의 글<input :value="item.params?.text || ''" @input="param(index, 'text', $event.target.value)" maxlength="1000"></label>
            <label v-if="fields(item).includes('handlerId')" class="tutorial-field">등록된 동작<select :value="item.params?.handlerId || ''" @change="param(index, 'handlerId', $event.target.value)"><option value="">동작을 선택하세요</option><option v-for="handler in handlers" :key="handler.handlerId" :value="handler.handlerId">{{ handler.moduleTitle }} / {{ handler.title }}</option></select></label>
          </template>
        </details>
      </li>
    </ol>
    <div class="tutorial-step-add"><label>추가할 행동 <select v-model="newAction"><option v-for="option in actions" :key="option.id" :value="option.id">{{ option.title }}</option></select></label><button @click="addCustom" :disabled="items.length >= 128" data-testid="tutorial-add-step">+ custom 행동 추가</button></div>
    <div v-if="removedSteps.length" class="tutorial-step-add"><label>기본 행동 다시 추가 <select v-model="restoreId"><option value="">단계를 선택하세요</option><option v-for="step in removedSteps" :key="step.stepId" :value="step.stepId">{{ step.title }}</option></select></label><button @click="addBuiltin" :disabled="!restoreId || items.length >= 128">선택한 단계 추가</button></div>
  </section>`,
  setup(props) {
    const newAction = ref('notice'); const restoreId = ref('');
    const catalog = computed(() => describe(props.module.moduleId));
    const items = computed(() => props.module.steps || defaultModuleStepRefs(props.module.moduleId));
    const handlers = computed(() => TUTORIAL_MODULES.filter(module => module.sourceId === props.sourceId).flatMap(module => describe(module.id).steps.map(step => ({ ...step, moduleTitle: module.title }))));
    const metadata = item => item.kind === 'builtin' ? catalog.value.steps.find(step => step.stepId === item.stepId) : item.actionId === 'registered-handler' ? handlers.value.find(step => step.handlerId === item.params?.handlerId) : null;
    const action = item => CUSTOM_TUTORIAL_ACTIONS.find(option => option.id === item.actionId);
    const shownTitle = item => item.title || metadata(item)?.title || action(item)?.title || '새 행동';
    const kindLabels = { notice: '안내 읽기', media: '실제 촬영 영상 보기', scene: '그림 장면 보기', 'click-target': '대상 클릭', 'select-text': '문서의 글 선택', 'type-text': '입력·전송', custom: '등록된 custom 동작' };
    const behavior = item => item.kind === 'builtin' ? kindLabels[metadata(item)?.actionKind] || '등록된 동작' : `custom · ${action(item)?.title || item.actionId}`;
    const fields = item => action(item)?.fields || [];
    const dependencyTitles = item => (metadata(item)?.dependsOn || []).map(id => {
      const owner = item.kind === 'builtin' ? catalog.value.steps : handlers.value.filter(handler => handler.handlerId.split(':')[0] === item.params?.handlerId?.split(':')[0]);
      return owner.find(step => step.stepId === id)?.title || id;
    });
    const removedSteps = computed(() => catalog.value.steps.filter(step => !items.value.some(item => item.kind === 'builtin' && item.stepId === step.stepId || item.kind === 'custom' && item.params?.handlerId === step.handlerId)));
    const ensure = () => props.module.steps ||= defaultModuleStepRefs(props.module.moduleId);
    function set(index, key, value) { ensure()[index][key] = value; }
    function param(index, key, value) { const step = ensure()[index]; step.params ||= {}; step.params[key] = value; }
    function move(index, direction) { const list = ensure(); const at = index + direction; if (at >= 0 && at < list.length) list.splice(at, 0, list.splice(index, 1)[0]); }
    function remove(index) { ensure().splice(index, 1); }
    function restore() { delete props.module.steps; }
    function clearText(index) { const step = ensure()[index]; delete step.title; delete step.text; delete step.next; }
    const parameters = actionId => actionId === 'registered-handler' ? { handlerId: '' } : actionId === 'select-text' ? { text: '' } : ['click-target', 'type-text'].includes(actionId) ? { scope: 'document', selector: '', ...(actionId === 'type-text' ? { value: '' } : {}) } : {};
    function changeAction(index, actionId) { const step = ensure()[index]; step.actionId = actionId; step.params = parameters(actionId); }
    function convert(index) {
      const old = items.value[index]; const spec = metadata(old);
      ensure()[index] = { key: old.key, kind: 'custom', actionId: 'registered-handler', params: { handlerId: spec.handlerId }, title: old.title || spec.title, text: old.text || spec.text || '안내에 따라 동작을 수행하세요.', ...(old.enabled === undefined ? {} : { enabled: old.enabled }), ...(old.motion === undefined ? {} : { motion: old.motion }), ...(old.next ? { next: old.next } : {}) };
    }
    function addCustom() { const list = ensure(); list.push({ key: fresh('custom', list), kind: 'custom', actionId: newAction.value, title: '새 행동', text: '이 단계에서 할 일을 적으세요.', params: parameters(newAction.value) }); }
    function addBuiltin() { if (!restoreId.value) return; const list = ensure(); list.push({ key: fresh(restoreId.value, list), kind: 'builtin', stepId: restoreId.value }); restoreId.value = ''; }
    return { items, newAction, restoreId, handlers, metadata, action, shownTitle, behavior, fields, dependencyTitles, removedSteps, actions: CUSTOM_TUTORIAL_ACTIONS, set, param, move, remove, restore, clearText, convert, changeAction, addCustom, addBuiltin };
  },
};
