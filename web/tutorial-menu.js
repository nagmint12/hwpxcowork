import { ref, computed, onMounted, onBeforeUnmount } from '/vendor/vue.esm-browser.prod.js';
import { api, state, toast, toastError } from './util.js';
import { saveTour, clearTour } from './tutorial.js';
import { TutorialEditor } from './tutorial-editor.js';
import { TUTORIAL_MODULES } from './tutorial-definition.js';

export const TutorialMenu = {
  components: { TutorialEditor },
  template: `<main class="tutorial-menu" data-testid="tutorial-menu">
    <div class="row"><a class="btnlike" href="#/">← 문서함</a><h1>튜토리얼</h1><span class="spacer"></span><button v-if="canEdit && !showEditor" @click="showEditor = true" data-testid="tutorial-edit-definition">구성 편집</button></div>
    <TutorialEditor v-if="canEdit && showEditor" @saved="load" @close="showEditor = false"/>
    <p>새 임시 문서에서 연습합니다. <b>완료하고 문서함에 저장</b>을 누르면 연습한 문서만 내 문서함에 저장됩니다.</p>
    <p class="muted">처음부터 시작하면 새 연습 문서가 열립니다. 완료한 문서는 그대로 보관됩니다.</p>
    <p v-if="error" role="alert">{{ error }} <button @click="load">다시 읽기</button></p>
    <p v-else-if="!loaded">튜토리얼을 읽는 중…</p>
    <p v-else-if="!data.enabled">현재 튜토리얼을 사용할 수 없습니다.</p>
    <p v-else-if="!data.items?.length">튜토리얼을 준비 중입니다. 잠시 후 다시 열어 주세요.</p>
    <div class="tutorial-grid"><article v-for="item in data.items" :key="item.id" class="tutorial-card" :data-tutorial="item.id">
      <h2><span class="tutorial-number">{{ item.number }}</span>{{ item.title }}</h2><p>{{ item.description }}</p>
      <ol v-if="item.modules?.length" class="tutorial-module-summary"><li v-for="module in item.modules" :key="module.key">{{ module.title || moduleTitle(module.moduleId) }}</li></ol>
      <p class="muted">{{ item.guided ? '안내를 따라하여 진행' : '관리자 참고 문서 · 실습 없음' }}</p>
      <button class="primary" :disabled="!!busy" @click="start(item)">{{ busy===item.id ? '준비 중…' : item.reference ? '참고 문서 열기' : '처음부터 시작' }}</button>
    </article></div>
    <section v-if="data.sessions?.length" class="tutorial-sessions"><h2>진행 중인 튜토리얼</h2>
      <div v-for="session in data.sessions" :key="session.docId" class="tutorial-session" :data-session="session.docId">
        <span>{{ session.title }}</span><span class="spacer"></span>
        <button :disabled="!!busy" @click="resume(session)">이어하기</button>
        <button :disabled="!!busy" @click="discard(session)">연습 문서 버리기</button>
      </div>
    </section>
  </main>`,
  setup() {
    const showEditor = ref(false); const canEdit = computed(() => state.me?.role === 'admin');
    const moduleTitle = id => TUTORIAL_MODULES.find(item => item.id === id)?.title || id;
    const data = ref({}); const busy = ref(''); const loaded = ref(false); const error = ref('');
    let active = true;
    onBeforeUnmount(() => { active = false; });
    async function load() {
      error.value = '';
      const visitor = state.me?.name; const token = state.token;
      try {
        const result = await api('/api/tutorial');
        if (!active || state.me?.name !== visitor || state.token !== token) return;
        data.value = result; loaded.value = true;
      }
      catch (e) { error.value = `튜토리얼을 읽지 못했습니다: ${e.message}`; }
    }
    async function start(item) {
      if (busy.value) return;
      busy.value = item.id;
      try {
        const r = await api('/api/tutorial/start', { method: 'POST', body: { tutorialId: item.id } });
        saveTour(r.guided ? { docId: r.docId, i: 0 } : null);
        location.hash = `#/doc/${r.docId}`;
      } catch (e) { toastError(e, '튜토리얼을 시작하지 못했습니다: '); }
      finally { busy.value = ''; }
    }
    function resume(session) {
      state.tutorialResumeDocId = session.docId;
      location.hash = `#/doc/${session.docId}`;
    }
    async function discard(session) {
      if (busy.value) return;
      busy.value = session.docId;
      try {
        await api(`/api/tutorial/${session.docId}`, { method: 'DELETE' });
        clearTour(session.docId);
        toast('연습 문서를 버렸습니다'); await load();
      } catch (e) { toastError(e); }
      finally { busy.value = ''; }
    }
    onMounted(load);
    return { data, busy, loaded, error, load, start, resume, discard, canEdit, showEditor, moduleTitle };
  },
};
