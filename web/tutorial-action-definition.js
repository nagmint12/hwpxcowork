// 사용자 구성에 저장하는 행동 계약. 실행 함수는 tutorial-modules에 등록한다.
export const CUSTOM_TUTORIAL_ACTIONS = [
  { id: 'notice', title: '안내 읽기', description: '문구를 읽은 뒤 다음 버튼으로 진행합니다.', fields: [] },
  { id: 'click-target', title: '대상 클릭', description: '지정한 버튼을 가리키고 사용자가 직접 클릭하면 진행합니다.', fields: ['scope', 'selector'] },
  { id: 'type-text', title: '예시 입력', description: '입력 버튼을 누르면 지정한 입력 칸에 예시를 타이핑합니다. 전송은 하지 않습니다.', fields: ['scope', 'selector', 'value'] },
  { id: 'select-text', title: '문서의 글 선택', description: '연습 문서의 지정한 글을 선택합니다.', fields: ['text'] },
  { id: 'registered-handler', title: '등록된 custom 동작', description: '요청 대기·제안 반영·메모처럼 상태가 필요한 기존 동작을 연결합니다. 준비 단계도 함께 배치하세요.', fields: ['handlerId'] },
];

export function normalizeTutorialActionParams(actionId, value = {}) {
  const action = CUSTOM_TUTORIAL_ACTIONS.find(item => item.id === actionId);
  if (!action) throw new Error(`등록되지 않은 행동입니다: ${String(actionId)}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('행동 설정은 객체여야 합니다.');
  for (const key of Object.keys(value)) if (!action.fields.includes(key)) throw new Error(`행동 ${actionId}에서 지원하지 않는 설정: ${key}`);
  const result = {};
  for (const field of action.fields) {
    const input = value[field];
    if (field === 'scope') {
      if (input !== 'document' && input !== 'editor') throw new Error('대상 위치는 document 또는 editor여야 합니다.');
      result[field] = input;
    } else {
      const max = field === 'value' ? 6000 : field === 'text' ? 1000 : 500;
      if (typeof input !== 'string' || !input.trim() || input.length > max) throw new Error(`${field}: 비어 있지 않은 ${max}자 이내의 글을 입력하세요.`);
      result[field] = input.trim();
      if (field === 'handlerId' && !/^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/.test(input)) throw new Error('등록 동작 ID가 올바르지 않습니다.');
    }
  }
  return result;
}
