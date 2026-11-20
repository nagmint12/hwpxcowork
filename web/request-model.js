import { computed, nextTick, reactive, ref, useId } from '/vendor/vue.esm-browser.prod.js';
import { api } from './util.js';
import { requestRunLabel } from './request-wait.js';

// 연결의 모델 목록을 가져오되 선택값은 요청을 작성하는 동안만 보관한다.
export function useRequestModel(canChooseRun, agentSessions) {
  const runId = useId(); const runToggle = ref(null); const runSelect = ref(null); const runOpen = ref(false);
  const runView = ref(null); const runLoading = ref(false); const runLoadError = ref('');
  const runDraft = reactive({ kind: '', model: '', effort: '', custom: false });
  const runKinds = computed(() => (runView.value?.kinds || []).filter(k => k.applies === 'request'));
  const runKind = computed(() => runKinds.value.find(k => k.id === runDraft.kind));
  const runDefault = computed(() => runView.value?.settings?.[runDraft.kind] || {});
  const runModel = computed(() => runKind.value?.models.find(item => item.id === (runDraft.model || runDefault.value.model)));
  const runEfforts = computed(() => runModel.value?.efforts?.length ? runModel.value.efforts : (runKind.value?.efforts || []));
  const sessions = computed(() => agentSessions().filter(session => session.channel && session.runKind));
  const runOnline = computed(() => sessions.value.some(session => session.runKind === runDraft.kind));
  const runSettings = computed(() => canChooseRun.value && runKind.value && (runDraft.model || runDraft.effort)
    ? { kind: runDraft.kind, model: runDraft.model || null, effort: runDraft.effort || null } : null);
  const runError = computed(() => {
    if (!runSettings.value) return '';
    if (runDraft.model && !/^(?!-)[A-Za-z0-9._:/@-]{1,200}$/.test(runDraft.model)) return '모델 ID 형식을 확인해 주세요. 영문·숫자와 . _ : / @ - 를 쓸 수 있습니다.';
    return runDraft.effort && !runEfforts.value.includes(runDraft.effort) ? '이 모델에서 지원하는 추론 강도를 골라 주세요.' : '';
  });
  const runName = computed(() => requestRunLabel(runDraft.kind));
  const runTip = computed(() => runSettings.value ? [runName.value, runDraft.model, runDraft.effort].filter(Boolean).join(' · ') : '이 요청의 모델·추론 강도');

  async function loadRuns() {
    if (runLoading.value) return;
    runLoading.value = true; runLoadError.value = '';
    try {
      runView.value = await api('/api/me/ai-run');
      if (!runKind.value) {
        const online = sessions.value.findLast(session => runKinds.value.some(k => k.id === session.runKind));
        chooseRunKind(online?.runKind || runKinds.value[0]?.id || '');
      }
    } catch { runLoadError.value = '모델 목록을 불러오지 못했습니다.'; }
    finally { runLoading.value = false; }
  }
  function chooseRunKind(kind) { Object.assign(runDraft, { kind, model: '', effort: '', custom: false }); }
  function chooseRunModel(model) {
    runDraft.custom = model === '*';
    runDraft.model = runDraft.custom ? '' : model;
    if (!runEfforts.value.includes(runDraft.effort)) runDraft.effort = '';
  }
  async function toggleRun() {
    runOpen.value = !runOpen.value;
    if (!runOpen.value) return;
    await loadRuns();
    await nextTick();
    if (runOpen.value && document.activeElement === runToggle.value) runSelect.value?.focus();
  }
  function closeRun(e) {
    if (!canChooseRun.value || !runOpen.value) return;
    e.stopPropagation(); runOpen.value = false; runToggle.value?.focus();
  }
  function resetRun() { runOpen.value = false; chooseRunKind(''); }

  return { runId, runToggle, runSelect, runOpen, runTip, runLoading, runLoadError, runKinds, runKind, runDefault, runDraft, runModel, runEfforts,
    runError, runSettings, runOnline, runName, loadRuns, chooseRunKind, chooseRunModel, toggleRun, closeRun, resetRun, requestRunLabel };
}
