// 브라우저와 서버가 함께 사용하는 튜토리얼 구성 계약. 실행 코드는 모듈 빌더에만 둔다.
import { normalizeTutorialActionParams } from './tutorial-action-definition.js';
export const TUTORIAL_SOURCES = [
  { id: 'report', title: '결과보고서' },
  { id: 'overview', title: '기본 편집 연습 문서' },
  { id: 'clipboard', title: '복사·편집 명령 연습 문서' },
  { id: 'ai-requests', title: 'AI 요청·검토 예시 문서' },
  { id: 'ai-connect', title: 'AI 연결 안내 문서' },
  { id: 'ai-advanced', title: 'AI 활용 심화 연습 보고서' },
  { id: 'admin', title: '관리자 참고 문서' },
];

export const TUTORIAL_MODULES = [
  { id: 'report-flow', title: '보고서로 AI 협업 시작', description: '글 선택부터 AI 요청, 메모, 차례 갱신까지 실습합니다.', sourceId: 'report', version: 1 },
  { id: 'editor-basics', title: '기본 편집과 메모', description: '글 고치기, 되돌리기, 메모와 답글, 저장을 실습합니다.', sourceId: 'overview', version: 1 },
  { id: 'clipboard-transfer', title: '한글과 복사·붙여넣기', description: '표·그림을 포함한 영역을 복사하고 붙여넣은 결과를 확인합니다.', sourceId: 'clipboard', version: 2 },
  { id: 'editing-commands', title: '편집 명령', description: '표·그림, 조판 부호, 글자·문단 모양, 표 단축키와 모양 복사를 익힙니다.', sourceId: 'clipboard', version: 1 },
  { id: 'ai-review', title: 'AI 요청과 제안 검토', description: '준비된 제안을 반영·거절·되돌리며 판단을 연습합니다.', sourceId: 'ai-requests', version: 1 },
  { id: 'ai-connections', title: '내 AI 연결', description: '내 PC의 Codex·Claude Code를 MCP로 먼저 연결하고, 필요하면 ChatGPT 웹(고급)·API 키(유료)를 고릅니다.', sourceId: 'ai-connect', version: 2 },
  { id: 'image-create', title: '그림 생성', description: '분석 기준 표를 바탕으로 그림을 생성하는 요청과 반영을 연습합니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'image-replace', title: '그림 변경', description: '기존 그림의 값과 위치를 유지하며 색을 바꾸는 연습입니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'table-format', title: '표 서식과 오탈자', description: '표 서식을 맞추고 문서의 오탈자를 고칩니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'document-proofread', title: '문서 교정', description: '표와 본문의 수치를 대조하고 과도한 해석을 검토합니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'conclusion', title: '결론 쓰기', description: '자료를 근거로 시사점과 정책 제언을 작성합니다.', sourceId: 'ai-advanced', version: 1 },
  // 'AI로 보고서 만들기'(2026-11-12): AI 작업 카드 3개(같은 연습 보고서·첨부 엑셀·예시 .skill)와 어느 튜토리얼에나 넣는 그림 장면 모듈 3개
  { id: 'topic-research', title: '주제 조사해 문단 쓰기', description: '주제를 조사해 출처와 함께 보고서 문체의 문단으로 넣습니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'excel-report', title: '엑셀로 절 쓰기', description: '첨부한 엑셀로 절 하나(본문·표 2개·그래프)를 한 번에 씁니다.', sourceId: 'ai-advanced', version: 1 },
  { id: 'skill-conclusion', title: '내 skill로 결론 쓰기', description: '첨부한 .skill의 작성 규칙대로 시사점·정책제언을 쓰고 차례를 새로 고칩니다. ‘결론 쓰기’와 같은 자리에 쓰므로 둘 중 하나만 넣으세요.', sourceId: 'ai-advanced', version: 1 },
  { id: 'ai-place', title: '한자리에서 하는 AI 작업', description: '자료·내 AI·제안·한/글 파일이 한 화면에서 이어지는 흐름을 그림으로 봅니다.', sourceId: null, version: 1 },
  { id: 'hangul-export', title: '한/글 파일로 가져가기', description: '반영한 문서를 한/글 파일로 저장하는 흐름을 그림으로 보고 [한글로 저장]을 누릅니다.', sourceId: null, version: 1 },
  { id: 'own-ai', title: '내 AI와 skill 그대로', description: '내가 쓰는 AI와 그 AI의 skill을 연결해 같은 작업을 맡기는 방법을 그림으로 봅니다.', sourceId: null, version: 1 },
  { id: 'admin-reference', title: '관리자 참고', description: '관리자 문서의 내용을 확인합니다.', sourceId: 'admin', version: 1 },
  { id: 'guide', title: '직접 작성한 안내', description: '어느 위치에나 제목과 설명을 직접 작성해 넣습니다.', sourceId: null, version: 1 },
  { id: 'custom', title: '직접 구성한 행동', description: '클릭·입력·글 선택·등록된 custom 동작을 단계별로 조합합니다.', sourceId: null, version: 1 },
];

const refs = (...ids) => ids.map(moduleId => ({ key: moduleId, moduleId }));
export const DEFAULT_TUTORIAL_DEFINITION = {
  version: 1,
  entryCourseId: 'report',
  courses: [
    { id: 'report', title: '결과보고서', description: 'AI 요청·제안 반영·메모·차례 갱신을 화면 안내로 연습합니다(3~5분).', sourceId: 'report', enabled: true, modules: refs('report-flow') },
    // 2026-11-12: AI 작업 중심으로 재구성 — 조사·엑셀·검토·skill 결론을 준비된 예시 답변으로 맡기고 한/글 파일로 가져간다(유료 호출 없음)
    { id: 'ai-work', title: 'AI로 보고서 만들기 — 조사·엑셀·검토', description: '주제 조사, 엑셀로 절 쓰기, 문서 교정, 내 skill로 결론 쓰기를 AI에게 맡기고 반영해 한/글 파일로 가져갑니다. 작업마다 [보내기]·[모두 반영] 두 번이면 됩니다(약 5분).', sourceId: 'ai-advanced', enabled: true, modules: refs('ai-place', 'topic-research', 'excel-report', 'document-proofread', 'skill-conclusion', 'hangul-export', 'own-ai') },
    { id: 'ai-requests', title: 'AI 작업 맡기기', description: 'AI 요청, 제안 검토와 반영, 메모와 답글을 연습합니다.', sourceId: 'ai-requests', enabled: true, modules: refs('ai-review') },
    // 2026-11-13: 연결 우선순위 — 내 PC의 구독 에이전트(Codex·Claude Code) 먼저, ChatGPT 웹(고급)·API 키(유료)는 선택
    { id: 'ai-connect', title: 'AI 연결 — 내 PC의 Codex·Claude Code', description: '내 PC에서 쓰는 Codex·Claude Code를 연결해 요청을 바로 처리하게 합니다. 구독 요금제 그대로라 추가 비용이 없습니다. ChatGPT 웹(고급)과 API 키(유료)는 필요할 때만 고릅니다.', sourceId: 'ai-connect', enabled: true, modules: refs('ai-connections') },
    { id: 'ai-advanced', title: 'AI 활용 심화 — 시각화·표·보고서', description: '그림 만들기·그림 바꾸기·표 서식과 오탈자·문서 교정·결론 쓰기 5가지를 준비된 AI 답변으로 맡기고 반영해 봅니다.', sourceId: 'ai-advanced', enabled: true, modules: refs('image-create', 'image-replace', 'table-format', 'document-proofread', 'conclusion') },
    // 한/글 편집 기능 소개는 AI 튜토리얼 뒤(부록)로 옮겼다(2026-11-12)
    { id: 'overview', title: '처음 쓰기 — 화면부터', description: '문서 열기와 편집, 메모, 저장을 둘러봅니다.', sourceId: 'overview', enabled: true, modules: refs('editor-basics') },
    { id: 'clipboard', title: '한글과 복사·붙여넣기', description: '한글과 복사·붙여넣기, 표와 그림 편집을 연습합니다.', sourceId: 'clipboard', enabled: true, modules: refs('clipboard-transfer', 'editing-commands') },
    { id: 'admin', title: '관리자 참고', description: '관리자 앱, 계정과 문서함 관리를 알아봅니다.', sourceId: 'admin', enabled: true, modules: refs('admin-reference') },
  ],
};

export const defaultTutorialDefinition = () => JSON.parse(JSON.stringify(DEFAULT_TUTORIAL_DEFINITION));
const fail = message => { throw new Error(message); };
const object = (value, at) => value && typeof value === 'object' && !Array.isArray(value) ? value : fail(`${at}: 객체가 필요합니다.`);
const keys = (value, allowed, at) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at}: 지원하지 않는 항목 ${key}`); };
const text = (value, at, max, required = true) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${at}: ${required ? '비어 있지 않은 ' : ''}${max}자 이내의 글이 필요합니다.`);
  return value.trim();
};
const id = (value, at) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail(`${at}: 영문 소문자·숫자·하이픈으로 1~64자 입력하세요.`);
  return value;
};

function optionalBoolean(value, field, at) {
  if (value[field] === undefined) return {};
  if (typeof value[field] !== 'boolean') fail(`${at}: ${field}는 true 또는 false여야 합니다.`);
  return { [field]: value[field] };
}

export function normalizeTutorialStepRefs(steps, sourceId, moduleId) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 128) fail('모듈의 행동 단계를 1~128개 구성하세요.');
  const used = new Set(); const builtins = new Set();
  const result = steps.map((step, index) => {
    const at = `행동 단계 ${index + 1}`; object(step, at);
    const common = ['key', 'kind', 'enabled', 'title', 'text', 'next', 'motion'];
    if (step.kind !== 'builtin' && step.kind !== 'custom') fail(`${at}: builtin 또는 custom 행동이어야 합니다.`);
    keys(step, [...common, ...(step.kind === 'builtin' ? ['stepId'] : ['actionId', 'params'])], at);
    const key = id(step.key, `${at} 키`);
    if (used.has(key)) fail(`${at}: 행동 키가 중복되었습니다: ${key}`);
    used.add(key);
    const required = step.kind === 'custom';
    const title = text(step.title, `${at} 제목`, 160, required);
    const body = text(step.text, `${at} 안내 문구`, 6000, required);
    const next = text(step.next, `${at} 다음 버튼`, 100, false);
    const base = { key, kind: step.kind, ...optionalBoolean(step, 'enabled', at), ...(title ? { title } : {}), ...(body ? { text: body } : {}), ...(next ? { next } : {}), ...optionalBoolean(step, 'motion', at) };
    if (step.kind === 'builtin') {
      if (['guide', 'custom'].includes(moduleId)) fail(`${at}: 직접 작성한 모듈에는 custom 행동을 추가하세요.`);
      const stepId = id(step.stepId, `${at} 내장 행동 ID`);
      if (builtins.has(stepId)) fail(`${at}: 같은 내장 행동을 두 번 넣을 수 없습니다.`);
      builtins.add(stepId);
      return { ...base, stepId };
    }
    const params = normalizeTutorialActionParams(step.actionId, step.params);
    if (step.actionId === 'registered-handler') {
      const handlerModule = TUTORIAL_MODULES.find(item => item.id === params.handlerId.split(':')[0]);
      if (!handlerModule || !handlerModule.sourceId || handlerModule.sourceId !== sourceId) fail(`${at}: 이 연습 문서에서 사용할 수 없는 등록 동작입니다.`);
    }
    return { ...base, actionId: step.actionId, params };
  });
  if (!result.some(step => step.enabled !== false)) fail('모듈에 사용할 행동을 하나 이상 남겨 주세요.');
  return result;
}

// 잘못된 조합은 저장 전에 거절한다. 모듈의 연습 대상이 없는 문서에서 안내가 멈추지 않도록 한다.
export function normalizeTutorialDefinition(input) {
  object(input, '구성'); keys(input, ['version', 'entryCourseId', 'courses'], '구성');
  if (input.version !== 1) fail('지원하지 않는 튜토리얼 구성 버전입니다.');
  if (!Array.isArray(input.courses) || input.courses.length > 50) fail('튜토리얼은 최대 50개까지 구성할 수 있습니다.');
  const courseIds = new Set();
  const courses = input.courses.map((value, index) => {
    const at = `튜토리얼 ${index + 1}`; object(value, at);
    keys(value, ['id', 'title', 'description', 'sourceId', 'enabled', 'modules'], at);
    const courseId = id(value.id, `${at} ID`);
    if (courseIds.has(courseId)) fail(`튜토리얼 ID가 중복되었습니다: ${courseId}`);
    courseIds.add(courseId);
    if (!TUTORIAL_SOURCES.some(source => source.id === value.sourceId)) fail(`${at}: 알 수 없는 연습 문서입니다.`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail(`${at}: 사용 여부는 true 또는 false여야 합니다.`);
    if (!Array.isArray(value.modules) || !value.modules.length || value.modules.length > 64) fail(`${at}: 모듈을 1~64개 선택하세요.`);
    const used = new Set(); const actions = new Set();
    const modules = value.modules.map((ref, n) => {
      const where = `${at}의 모듈 ${n + 1}`; object(ref, where);
      keys(ref, ['key', 'moduleId', 'title', 'text', 'motion', 'steps'], where);
      const key = id(ref.key, `${where} 키`);
      if (used.has(key)) fail(`${where}: 모듈 키가 중복되었습니다: ${key}`);
      used.add(key);
      const module = TUTORIAL_MODULES.find(item => item.id === ref.moduleId);
      if (!module) fail(`${where}: 알 수 없는 모듈 ${String(ref.moduleId)}`);
      if (!['guide', 'custom'].includes(module.id) && actions.has(module.id)) fail(`${where}: 같은 실습 모듈은 한 튜토리얼에 한 번만 넣을 수 있습니다.`);
      actions.add(module.id);
      if (module.sourceId && module.sourceId !== value.sourceId) fail(`${where}: ${module.title} 모듈은 ${TUTORIAL_SOURCES.find(source => source.id === module.sourceId).title}에서 사용하세요.`);
      const title = text(ref.title, `${where} 제목`, 160, module.id === 'guide');
      const body = text(ref.text, `${where} 안내 문구`, 6000, module.id === 'guide');
      if (module.id === 'guide' && ref.steps !== undefined) fail(`${where}: 안내 모듈의 행동을 편집하려면 직접 구성한 행동 모듈을 사용하세요.`);
      const steps = ref.steps === undefined && module.id !== 'custom' ? {} : { steps: normalizeTutorialStepRefs(ref.steps, value.sourceId, module.id) };
      return { key, moduleId: module.id, ...(title ? { title } : {}), ...(body ? { text: body } : {}), ...optionalBoolean(ref, 'motion', where), ...steps };
    });
    return { id: courseId, title: text(value.title, `${at} 제목`, 160), description: text(value.description, `${at} 설명`, 1000, false), sourceId: value.sourceId, enabled: value.enabled !== false, modules };
  });
  const entryCourseId = input.entryCourseId == null ? null : id(input.entryCourseId, '첫 접속 튜토리얼');
  if (entryCourseId && !courses.some(course => course.id === entryCourseId && course.enabled)) fail('첫 접속 튜토리얼은 사용 중인 항목에서 선택하세요.');
  return { version: 1, entryCourseId, courses };
}
