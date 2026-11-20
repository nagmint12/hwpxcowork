// 요청 상태는 실제 선점과 이벤트 수신 확인을 구분해서 표시한다.
const RUN_LABEL = { codex: 'Codex', 'claude-code': 'Claude Code', 'gemini-cli': 'Gemini CLI', antigravity: 'Antigravity', api: 'API' };
export const requestRunLabel = kind => RUN_LABEL[kind] || 'AI';

export function requestWait(r) {
  if (r?.options?.runSettings) {
    const name = requestRunLabel(r.options.runSettings.kind);
    return { label: `${name} 대기`, text: r.delivery ? `${name}에 전달했습니다. 작업을 시작하기를 기다립니다.` : `${name} 실행기가 요청을 맡기를 기다립니다.`,
      hint: `이 요청을 처리하려면 ${name} 실행기를 켜 주세요.`, manualCopy: false };
  }
  if (r?.automation?.method !== 'mcp-events') return null;
  switch (r.automation.state) {
    case 'delivered': return { label: 'ChatGPT 실행 대기', text: 'ChatGPT가 알림을 받았습니다. 작업을 시작하기를 기다리고 있습니다.', hint: '자동 처리 대기 중입니다. 프롬프트를 복사할 필요가 없습니다. ChatGPT가 요청을 맡으면 처리 중으로 바뀝니다.', manualCopy: false };
    case 'sending': return { label: 'ChatGPT 알림 전송 중', text: '관리자 ChatGPT에 튜토리얼 요청을 알리는 중입니다.', hint: '이벤트 알림 전송과 ChatGPT의 작업 시작은 별도 단계입니다.', manualCopy: false };
    case 'failed': return { label: 'ChatGPT 알림 실패', text: 'ChatGPT에 요청 알림을 전달하지 못했습니다.', hint: '관리자에게 ChatGPT 이벤트 연결 상태 확인을 요청하세요.', manualCopy: true };
    default: return { label: 'ChatGPT 연결 대기', text: '관리자 ChatGPT의 자동 처리 연결을 기다리고 있습니다.', hint: '요청은 저장되어 있습니다. 관리자 이벤트 구독이 필요합니다.', manualCopy: true };
  }
}

export function tutorialWaitText(r, environment = {}) {
  if (r?.status === 'failed') return `AI 처리에 실패했습니다: ${r.error || ''}`;
  if (r?.status === 'pending') return requestWait(r)?.text || (r.delivery ? '연결된 AI에 요청을 전달했습니다. AI가 작업을 시작하기를 기다리고 있습니다.' : '요청이 대기 중입니다. AI가 요청을 맡으면 처리가 시작됩니다.');
  // 튜토리얼 연습 문서는 준비된 예시 답변(서버 route 'example' — 2026-11-12 모든 튜토리얼)
  if (r?.status === 'working' && (r.route === 'example' || r.example)) return '미리 준비한 예시 답변을 문서에 넣고 있습니다.';
  if (r?.status === 'working') return `${r.automation?.method === 'mcp-events' || environment.sharedChatGPT ? '관리자 ChatGPT' : environment.connected || 'AI'}가 문서를 읽고 수정 제안을 작성하고 있습니다.`;
  return 'AI 요청 상태를 확인하고 있습니다.';
}
