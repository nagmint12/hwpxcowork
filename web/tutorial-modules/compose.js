// 모듈 등록과 조합. 모듈 내부의 이동 좌표를 실제 조합 순서로 변환합니다.
import { TUTORIAL_MODULES, DEFAULT_TUTORIAL_DEFINITION } from '../tutorial-definition.js';
import { TUTORIAL_AI_TASKS } from '../tutorial-advanced-tasks.js';
import { buildEditorBasics } from './editor-basics.js';
import { buildClipboard } from './clipboard.js';
import { buildAiReview } from './ai-review.js';
import { buildAiConnections } from './ai-connections.js';
import { buildAdvanced } from './advanced.js';
import { buildReportFlow } from './report-flow.js';
import { buildAiPlace, buildHangulExport, buildOwnAi } from './ai-work.js';
import { stepHelpers } from './common.js';
import { buildCustomAction } from './custom-actions.js';
import { normalizeTutorialActionParams } from '../tutorial-action-definition.js';
import { tutorialStepKey } from '../tutorial-step-id.js';

// AI 작업 모듈 → 작업 번호(web/tutorial-advanced-tasks.js). R1·X1·K1 = 'AI로 보고서 만들기' 코스의 AI 작업 카드(2026-11-12)
const advancedIds = { 'image-create': 'S1', 'image-replace': 'S2', 'table-format': 'S3', 'document-proofread': 'S4', conclusion: 'S5', 'topic-research': 'R1', 'excel-report': 'X1', 'skill-conclusion': 'K1' };
const builders = { 'report-flow': buildReportFlow, 'editor-basics': buildEditorBasics, 'ai-review': buildAiReview, 'ai-connections': buildAiConnections,
  'ai-place': buildAiPlace, 'hangul-export': buildHangulExport, 'own-ai': buildOwnAi };
const contentIndexes = steps => steps.map((_, i) => i).slice(1, -1);
const displayTitle = title => String(title).replace(/^\d+\.\s*/, '');
// 제목 수정 UI는 모듈 안내만 바꿉니다. 실행 단계 ID는 원래 제목과 모듈 키로 고정합니다.
export const stepToken = title => { let hash = 2166136261; for (const ch of String(title)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619); return (hash >>> 0).toString(36); };
// 안내 방식을 바꾸면서 제목을 다듬어도 이미 저장한 단계 선택과 진행 위치는 유지합니다.
const identityFor = step => step.stepId || stepToken(step.title);

export function buildTutorialModule(moduleId, env) {
  if (builders[moduleId]) { const steps = builders[moduleId](env); return { steps, indexes: contentIndexes(steps) }; }
  if (advancedIds[moduleId]) {
    const steps = buildAdvanced(env, TUTORIAL_AI_TASKS.filter(task => task.id === advancedIds[moduleId]));
    return { steps, indexes: contentIndexes(steps) };
  }
  if (moduleId === 'clipboard-transfer' || moduleId === 'editing-commands') {
    const steps = buildClipboard(env);
    const boundary = steps.findIndex(step => step.title === '표의 병합과 칸 너비');
    const reverse = steps.findIndex(step => step.title === '한/글에서 웹 편집기로 붙여넣기');
    const indexes = moduleId === 'clipboard-transfer'
      ? [...steps.map((_, i) => i).filter(i => i > 0 && i < boundary), reverse]
      : steps.map((_, i) => i).filter(i => i >= boundary && i < reverse);
    if (moduleId === 'editing-commands') {
      const { frameButton } = stepHelpers(env);
      const { q, pad, rectOf } = env;
      // 복사 모듈 없이 단독 배치해도 편집 메뉴부터 켤 수 있습니다.
      steps.push({ title: '편집 명령을 위한 도구 막대', text: '위 [문서 작업]에서 [편집 메뉴 및 서식 막대]를 켜세요. 이미 켜져 있으면 다음으로 넘어갑니다.',
        ring: () => pad(rectOf(q('[data-testid="toggle-editor-tools"]') || q('[data-testid="bar-more-toggle"]')), 4),
        until: () => !!frameButton('글자모양', '문단모양', '복사하기') });
      indexes.unshift(steps.length - 1);
    }
    return { steps, indexes, finishIndex: steps.findIndex(step => step.last) };
  }
  if (moduleId === 'admin-reference') {
    const { intro, finish } = stepHelpers(env);
    return { steps: [intro('관리자 참고', '문서의 안내를 읽고 필요한 항목을 확인하세요.'), { title: '관리자 문서 살펴보기', text: '연습 문서의 내용을 자유롭게 읽으세요. 확인을 마친 뒤 다음 단계로 이동합니다.', center: true, next: '확인했습니다' }, finish], indexes: [1] };
  }
  throw new Error(`등록되지 않은 튜토리얼 모듈입니다: ${moduleId}`);
}

// 단계 목록을 만드는 동안 실제 문서/DOM/네트워크를 읽지 않는 설명용 환경입니다.
const describeEnvironment = () => ({ describe: true, d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [], draft: {} }, ctx: {}, config: { publicUrl: 'https://document.example' }, clipboard: {},
  dragHow: '마우스로 끌어', saveButton() {}, focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {}, locate() {}, phraseRect() {}, cw() {}, toolbarShown: () => false, selHas: () => false });
const reportNotes = [
  ['select-text', '‘일정 부분 기여한 것으로 보인다’ 문장', '글을 선택하고 작은 도구 막대가 나타나면 이동'],
  ['click-target', '작은 도구 막대의 AI에게 맡기기', 'AI 요청 창이 열리면 이동'],
  ['type-text', 'AI 요청 창의 지시 입력 칸과 보내기', '사용자가 요청을 보내면 이동', '무엇을 바랄지 적으세요. 예: 「‘보인다’ 말고, 적절한 표현으로」'],
  ['custom', '현재 AI 요청', 'AI 작업이 완료되고 검토할 제안이 생기면 이동', 'AI 요청의 처리 상태를 확인하며 결과를 기다립니다. 실패하면 다시 요청할 수 있습니다.'],
  ['custom', '첫 번째 AI 요청의 제안 반영 버튼', '제안이 실제 반영되면 이동'],
  ['select-text', '‘학생 만족도’ 문구', '글을 선택하고 작은 도구 막대가 나타나면 이동'],
  ['click-target', '작은 도구 막대의 메모', '메모 입력 창이 열리면 이동'],
  ['type-text', '메모 입력 칸', '새 메모가 저장되면 이동', '의견을 적으세요. 예: 「근거로 [표 1]을 함께 제시해 주세요.」'],
  ['custom', '방금 작성한 메모의 답글', '해당 메모의 답글 창이 열리면 이동', '방금 작성한 메모에서 답글을 엽니다. 답글을 AI에게 요청할 수 있습니다.'],
  ['type-text', '메모 답글 입력 칸과 AI에게 요청', '새 후속 AI 요청이 만들어지면 이동', '답글을 적고 AI에게 요청을 누르세요. 예: 「이 메모대로 문장을 고쳐 줘」'],
  ['custom', '메모에서 보낸 AI 요청', '후속 요청이 완료되고 제안이 생기면 이동', '메모의 요청을 처리하는 동안 기다립니다. 실패하면 다시 요청할 수 있습니다.'],
  ['custom', '후속 AI 요청의 제안 반영 버튼', '후속 제안이 실제 반영되면 이동', '메모대로 고친 제안의 반영 버튼을 누르세요.'],
  ['custom', '제목 차례 문단과 AI 요청 창', '차례 갱신 요청이 만들어지면 이동', '제목 차례를 골라 AI에게 「차례 새로고침해줘」라고 요청합니다.'],
  ['custom', '차례 갱신 요청', '차례 요청이 처리된 뒤 이동', '차례를 새로 고친 결과를 문서에서 확인합니다.'],
  ['click-target', '한글로 저장 버튼', '사용자가 한글로 저장을 클릭하면 이동', '고친 문서를 한/글 파일(HWPX)로 내려받습니다. 한글로 저장을 누르세요.'],
];

export function describeTutorialModule(moduleId) {
  const descriptor = TUTORIAL_MODULES.find(module => module.id === moduleId);
  if (!descriptor) throw new Error(`등록되지 않은 튜토리얼 모듈입니다: ${moduleId}`);
  if (moduleId === 'guide' || moduleId === 'custom') return { ...descriptor, steps: [] };
  const env = describeEnvironment();
  // 휴대폰 전용 준비 단계도 편집 목록에 표시하며 PC 실행에서는 자동 생략합니다.
  if (moduleId === 'clipboard-transfer') env.touch = true;
  const local = buildTutorialModule(moduleId, env);
  const descriptions = local.indexes.map((index, position) => {
    const step = local.steps[index]; const report = moduleId === 'report-flow' ? reportNotes[position] : null;
    const title = displayTitle(step.title); const stepId = identityFor(step);
    const actionKind = report?.[0] || (step.scene ? 'scene' : step.media ? 'media' : step.wait ? 'custom' : step.click ? 'click-target' : /고르기|선택/.test(title) ? 'select-text' : /입력|쓰[기고]|말하기/.test(title) ? 'type-text' : step.next && !step.until ? 'notice' : 'custom');
    return { stepId, title, text: typeof step.text === 'string' ? step.text : report?.[3] || `${title} 단계입니다. 화면 상태에 따라 원래 안내가 바뀝니다. 문구를 입력하면 이 단계의 안내를 바꿀 수 있습니다.`,
      dynamicText: typeof step.text === 'function', actionKind, actionLabel: step.action?.label || (typeof step.press === 'string' ? step.press : '') || step.next || '', nextLabel: step.next || '',
      target: report?.[1] || (step.scene ? '안내창 안의 그림 장면' : step.media ? '실제 한글 촬영 영상의 재생 버튼' : step.center ? '안내창' : step.click ? '강조된 버튼' : step.ring ? '강조된 문서 영역 또는 입력 칸' : '현재 문서와 작업 상태'),
      completion: report?.[2] || (step.scene ? '그림 장면을 보고 다음 버튼으로 이동합니다. 끝까지 보지 않아도 됩니다.' : step.media ? '원할 때 영상을 재생하고 다음 버튼으로 이동합니다. 영상 시청은 필수가 아닙니다.' : step.until ? '현재 문서·요청 상태의 조건을 만족하면 이동합니다. 관련 준비 단계를 함께 배치하세요.' : step.click ? '대상을 직접 클릭하면 이동합니다.' : '다음 버튼을 누르면 이동합니다.'),
      handlerId: `${moduleId}:${stepId}`, dependsOn: [], ...(step.title === '편집 도구 막대 켜기' ? { conditional: 'touch' } : {}) };
  });
  if (moduleId === 'report-flow') for (let n = 0; n < descriptions.length; n++) {
    if (![0, 5, 12, 14].includes(n)) descriptions[n].dependsOn = [descriptions[n - 1].stepId];
  }
  if (advancedIds[moduleId] && descriptions.length > 1) descriptions[1].dependsOn = [descriptions[0].stepId];
  return { ...descriptor, steps: descriptions };
}

const descriptorFor = (moduleId, stepId) => describeTutorialModule(moduleId).steps.find(step => step.stepId === stepId);
function handlerParts(handlerId) {
  const parts = String(handlerId || '').split(':');
  if (parts.length !== 2 || !parts.every(Boolean)) throw new Error('등록된 custom 동작 ID가 올바르지 않습니다.');
  return parts;
}

// 구조 검증 이후 호출합니다. 원본 단계와 의존성은 실제 등록부를 기준으로 확인합니다.
export function validateTutorialStepReferences(definition) {
  for (const course of definition.courses || []) for (const entry of course.modules || []) {
    if (entry.steps == null) continue;
    const selected = new Set();
    for (const ref of entry.steps) {
      let moduleId = entry.moduleId; let stepId = ref.stepId;
      if (ref.kind === 'custom') {
        normalizeTutorialActionParams(ref.actionId, ref.params);
        if (ref.actionId !== 'registered-handler') continue;
        [moduleId, stepId] = handlerParts(ref.params?.handlerId);
      }
      const module = TUTORIAL_MODULES.find(item => item.id === moduleId);
      if (!module || (module.sourceId && module.sourceId !== course.sourceId)) throw new Error(`‘${entry.key}’의 custom 동작과 연습 문서가 맞지 않습니다.`);
      const step = descriptorFor(moduleId, stepId);
      if (!step) throw new Error(`‘${entry.key}’에 등록되지 않은 단계가 있습니다: ${String(stepId)}`);
      if (ref.enabled === false) continue;
      const identity = `${moduleId}:${stepId}`;
      if (selected.has(identity)) throw new Error(`‘${step.title}’ 동작은 같은 모듈 안에 한 번만 배치하세요.`);
      for (const dependency of step.dependsOn) if (!selected.has(`${moduleId}:${dependency}`)) {
        const before = descriptorFor(moduleId, dependency);
        throw new Error(`‘${step.title}’ 앞에 준비 단계 ‘${before?.title || dependency}’를 배치하세요. 관련 실습을 뺄 때는 이어지는 단계도 함께 제거하세요.`);
      }
      selected.add(identity);
    }
  }
  return definition;
}

export function buildComposedTutorialSteps(course, env) {
  const defaults = DEFAULT_TUTORIAL_DEFINITION.courses.find(item => item.id === course.sourceId);
  const entries = course.modules || defaults?.modules || [];
  if (!entries.length) throw new Error('튜토리얼에 실행할 모듈이 없습니다.');
  validateTutorialStepReferences({ courses: [{ ...course, modules: entries }] });
  const contexts = env.ctx.modules || (env.ctx.modules = {});
  const groups = entries.map(entry => {
    const descriptor = TUTORIAL_MODULES.find(module => module.id === entry.moduleId);
    if (!descriptor) throw new Error(`등록되지 않은 튜토리얼 모듈입니다: ${entry.moduleId}`);
    if (descriptor.sourceId && descriptor.sourceId !== course.sourceId) throw new Error('연습 문서와 튜토리얼 모듈이 맞지 않습니다.');
    const context = Object.hasOwn(contexts, entry.key) ? contexts[entry.key] : (contexts[entry.key] = {});
    const group = { entry, descriptor, selected: [], activeMotion: entry.motion !== false, cache: new Map() };
    const scopedEnv = { ...env, ctx: context, moduleKey: entry.key, isCurrentStep: title => env.isCurrentStep?.(title, entry.key), motionReduced: () => !group.activeMotion || !!env.motionReduced?.() };
    const localFor = moduleId => {
      if (!group.cache.has(moduleId)) group.cache.set(moduleId, buildTutorialModule(moduleId, scopedEnv));
      return group.cache.get(moduleId);
    };
    if (entry.moduleId === 'guide') {
      group.selected.push({ ref: {}, original: { title: entry.title, text: entry.text, center: true, next: '다음 단계' }, moduleId: 'guide' });
    } else {
      const local = entry.moduleId === 'custom' ? null : localFor(entry.moduleId);
      const refs = entry.steps || local.indexes.map(index => ({ key: identityFor(local.steps[index]), kind: 'builtin', stepId: identityFor(local.steps[index]) }));
      for (const ref of refs.filter(item => item.enabled !== false)) {
        if (ref.kind === 'custom' && ref.actionId !== 'registered-handler') {
          normalizeTutorialActionParams(ref.actionId, ref.params);
          group.selected.push({ ref, original: buildCustomAction(ref, scopedEnv), moduleId: 'custom' });
          continue;
        }
        const [moduleId, stepId] = ref.kind === 'custom' ? handlerParts(ref.params.handlerId) : [entry.moduleId, ref.stepId];
        const source = localFor(moduleId); const index = source.indexes.find(index => identityFor(source.steps[index]) === stepId);
        if (index == null && descriptorFor(moduleId, stepId)?.conditional === 'touch' && !env.touch) continue;
        if (index == null) throw new Error(`실행할 튜토리얼 단계를 찾을 수 없습니다: ${stepId}`);
        group.selected.push({ ref, original: source.steps[index], source, index, moduleId });
      }
    }
    return group;
  });
  const fallback = stepHelpers(env);
  const moduleNames = groups.map(group => group.entry.title || group.descriptor.title).join(' → ');
  const note = course.sourceId === 'ai-advanced' ? ' 준비된 예시 답변으로 연습하므로 AI 연결이나 사용료가 필요 없습니다. 문서의 수치는 모두 연습용 가상 자료입니다.' : '';
  // 소개 글: 설명 · 순서 · 임시 문서 안내 · 잘못 눌렀을 때의 [다시 하기](2026-11-18 — 게임의 재시작처럼 단계마다 되돌릴 수 있음을 처음에 알린다)
  const intro = fallback.intro(course.title || defaults?.title || '튜토리얼', `${course.description ?? defaults?.description ?? '선택한 모듈을 따라 해 봅니다.'}\n${groups.length > 1 ? `순서: ${moduleNames}\n` : ''}임시 문서에서 연습하며 완료할 때 내 문서함에 저장합니다.${note}\n잘못 눌러도 괜찮아요 — [↻ 다시 하기]로 그 단계를 처음부터 다시 할 수 있습니다.`);
  const steps = [{ ...intro, id: 'course/intro', moduleKey: null, originalTitle: intro.title }];
  for (const group of groups) {
    const { entry, descriptor, selected } = group;
    if (entry.moduleId !== 'guide' && (entry.title || entry.text)) steps.push({ title: entry.title || descriptor.title, text: entry.text || descriptor.description, center: true, next: '모듈 시작', id: `${entry.key}/intro`, moduleKey: entry.key, motionEnabled: entry.motion !== false });
    const start = steps.length; const end = start + selected.length;
    const mapped = new Map(selected.filter(item => item.source).map(item => [`${item.moduleId}:${item.index}`, start + selected.indexOf(item)]));
    for (const [position, item] of selected.entries()) {
      const { ref, original, source, moduleId } = item;
      const motionEnabled = entry.motion !== false && ref.motion !== false;
      const invoke = fn => (...args) => { group.activeMotion = motionEnabled; return fn(...args); };
      const remap = (target, lost = false) => {
        if (typeof target !== 'number' || !Number.isInteger(target)) return target;
        const result = mapped.get(`${moduleId}:${target}`);
        if (result != null) return result;
        // 없어진 준비 단계로 되감지 않습니다. 다음 진행은 다음 남은 단계로 이어집니다.
        if (lost) return null;
        if (target === (source?.finishIndex ?? (source?.steps.length || 0) - 1)) return end;
        return Math.min(start + position + 1, end);
      };
      const step = { ...original, title: ref.title ?? displayTitle(original.title), text: ref.text ?? original.text, originalTitle: original.title,
        id: ref.kind === 'custom' ? `${entry.key}/custom/${ref.key}` : `${entry.key}/${descriptor.version}/${identityFor(original)}`, moduleKey: entry.key, moduleId: entry.moduleId, motionEnabled };
      // 문구 편집으로 자동 완료 조건을 건너뛰는 버튼을 새로 만들지는 않습니다.
      if (ref.next && original.next) step.next = ref.next;
      delete step.last;
      if (original.next && !ref.next && !original.nextTo && source) {
        const following = selected[position + 1];
        const originalNextKept = following?.source === source && following.index === item.index + 1;
        // 제거한 단계의 이름을 다음 버튼에 계속 보여 주지 않습니다. 직접 편집한 버튼 문구는 보존합니다.
        if (!originalNextKept) step.next = following ? '다음 단계' : group === groups.at(-1) ? '연습 마치기' : '다음 모듈로';
      }
      if (original.nextTo) {
        const targetIndex = source.steps.findIndex(candidate => candidate.title === original.nextTo);
        step.nextIndex = mapped.has(`${moduleId}:${targetIndex}`) ? remap(targetIndex) : end;
        delete step.nextTo;
      }
      for (const name of ['enter', 'leave', 'until', 'motion', 'example']) if (typeof original[name] === 'function') step[name] = invoke(original[name]);
      if (original.lost) step.lost = invoke(() => remap(original.lost(), true));
      if (original.action?.run) step.action = { ...original.action, run: invoke((...args) => {
        const value = original.action.run(...args); return value && typeof value.then === 'function' ? value.then(result => remap(result)) : remap(value);
      }) };
      steps.push(step);
    }
  }
  const last = groups.at(-1); const finish = [...last.cache.values()].flatMap(local => local.steps).find(step => step.last) || fallback.finish;
  steps.push({ ...finish, id: 'course/finish', moduleKey: null });
  return steps;
}

export function resolveTutorialPosition(steps, progress, showIntro = false) {
  const key = tutorialStepKey(progress.ctx?.currentStepId);
  const found = key ? steps.findIndex(step => tutorialStepKey(step.id) === key) : -1;
  const saved = found >= 0 ? found : Math.max(0, Math.min(steps.length - 1, Number(progress.i) || 0));
  return { index: showIntro ? 0 : saved, resumeAfterIntro: showIntro && saved > 0 ? saved : null };
}
