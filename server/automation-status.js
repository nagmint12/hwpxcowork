// 실행기를 시작하거나 요청을 선점하지 않고, 본인의 자동 처리 연결과 대기 상태만 설명한다.
// 채널 연결 확인은 모델 응답이나 요청 완료의 증거가 아니다.
export function automationStatus({ user, service, events, ai, config, personalAi = null, now = Date.now() }) {
  const apiOnly = !!service._tutorialApiOnly?.(user.name);
  const registry = service.agents;
  const sessions = (registry?.sessions(user.name) || []).map(({ agent, client, channel, since, lastSeen }) => ({ agent, client, channel, since, lastSeen }));
  const primary = registry?.primary(user.name);
  const channels = {
    online: !!registry?.online(user.name), sessions,
    primary: primary ? { agent: primary.agent, client: primary.client, since: primary.since } : null,
  };
  const eventState = events.status(user);
  const activeEvents = eventState.subscriptions.filter(sub => sub.active);
  const coverage = !activeEvents.length ? 'none' : activeEvents.some(sub => !sub.documentId) ? 'all' : 'filtered';
  const deliveryIssues = eventState.subscriptions.filter(sub => sub.active && (
    sub.lastDelivery?.status === 'failed' || (sub.lastDelivery?.status === 'pending' && (sub.lastDelivery.httpStatus || sub.lastDelivery.reason))
  )).length;
  // 내 개인 AI 키(서버 보관) — 키 자체는 싣지 않는다
  let personal = null;
  try { personal = apiOnly ? service.tutorialAiStatus(user.name) : personalAi?.status(user) || null; } catch { personal = null; }
  const serverAi = apiOnly
    ? { enabled: !!personal?.active, provider: personal?.provider || null, gateway: personal?.gateway || null, model: personal?.model || null, mock: false }
    : { enabled: !!ai.enabled, provider: ai.provider || config.ai?.provider || null, gateway: ai.gateway || null, model: ai.mock ? 'mock' : config.ai?.model || null, mock: !!ai.mock };
  const personalReady = !apiOnly && !!(personal?.configured && personal.active && service.personalAi?.forUser(user.name)?.enabled);
  const queue = { pending: 0, working: 0, expiredWorking: 0, pendingByRoute: { queue: 0, agent: 0, server: 0 } };
  // 진행 중인 튜토리얼은 문서함 밖에 있다. 완료·이동 중 중복 문서는 한 번만 센다.
  const documents = new Map([...service.store.list(), ...(service.store.listSessions?.() || [])].map(doc => [doc.id, doc]));
  for (const doc of documents.values()) for (const request of doc.requests || []) {
    // 준비된 대기 요청(튜토리얼 4 예시)은 실제 실행 큐에 들어가지 않는다.
    if (request.by !== user.name || request.example) continue;
    if (request.status === 'pending') {
      queue.pending++;
      if (Object.hasOwn(queue.pendingByRoute, request.route)) queue.pendingByRoute[request.route]++;
    } else if (request.status === 'working') {
      queue.working++;
      if (service._claimExpired(request.claim, now)) queue.expiredWorking++;
    }
  }
  // 기존 요청 라우팅 순서(채널 → 서버(내 키·공용) → 대기열)와 일치시킨다. 연결 안내는 내 PC 의 구독 AI(Codex·Claude Code — 추가 비용 없음)를 먼저,
  // 내 AI 키(사용료 별도)는 마지막 선택으로 말한다(2026-11-13 운영 결정 — 웹 web/util.js NO_AI_TIP 과 같은 차례). 사용자에게 보이는 message 에는 이벤트 구독·'서버 AI' 를 말하지 않는다
  // (ChatGPT 이벤트 구독·예약 실행은 쓰지 않는다 — events 칸은 옛 화면 호환으로만 남기고 자동 처리로 치지 않는다. 공용 서버 AI 는 배포 전이라 이름을 숨긴다)
  const automatic = apiOnly && personal?.method === 'mcp-events'
    ? { available: !!personal.active, method: 'mcp-events', state: personal.active ? 'connected' : 'needs_subscription', recommendedRoute: 'queue', message: personal.active ? '튜토리얼 요청은 관리자 ChatGPT가 처리합니다. 결과는 AI 작업 탭에서 확인하세요.' : '튜토리얼 요청은 대기열에 저장됩니다. 관리자 ChatGPT의 이벤트 구독이 필요합니다.' }
    : apiOnly
    ? { available: serverAi.enabled, method: 'server', state: serverAi.enabled ? 'connected' : 'needs_setup', recommendedRoute: 'server', message: serverAi.enabled
      ? '체험 요청은 관리자가 공유한 API로만 처리합니다. API 연결이 없거나 실패하면 요청이 중단됩니다. 결과는 AI 작업 탭에서 확인하세요.'
      : '체험용 관리자 API가 연결되어 있지 않습니다. 관리자에게 API 연결 확인을 요청하세요.' }
    : channels.online
    ? { available: true, method: 'channel', state: 'connected', recommendedRoute: 'auto', message: '연결된 AI 작업 환경으로 새 요청을 바로 보냅니다. 처리 결과는 AI 작업 탭에서 확인하세요.' }
    : personalReady
      ? { available: true, method: 'personal', state: 'connected', recommendedRoute: 'auto', message: '등록한 내 AI 키로 바로 처리합니다. 사용료는 내 키에 부과됩니다. 내 PC의 Codex나 Claude Code 실행기를 켜 두면 그쪽이 먼저 처리합니다(추가 비용 없음). 처리 결과는 AI 작업 탭에서 확인하세요.' }
    : serverAi.enabled
      ? { available: true, method: 'server', state: 'connected', recommendedRoute: 'auto', message: '새 요청을 AI가 자동으로 처리합니다. 처리 결과는 AI 작업 탭에서 확인하세요.' }
      : { available: false, method: null, state: 'needs_setup', recommendedRoute: 'queue', message: '연결된 AI가 없습니다. 요청은 대기열에 보관됩니다. 내 PC에서 Codex(ChatGPT 로그인)나 Claude Code(Claude 로그인) 실행기를 켜 두면 추가 비용 없이 바로 처리합니다. ChatGPT 앱 연결이나 내 AI 키(사용료 별도)도 쓸 수 있습니다.' };
  return { checkedAt: new Date(now).toISOString(), ...(apiOnly ? { apiOnly: true } : {}), channels, events: { ...eventState, deliveryIssues, coverage }, serverAi, personalAi: personal, automatic, queue };
}
