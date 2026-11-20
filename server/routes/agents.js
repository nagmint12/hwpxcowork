// 개인 에이전트 경로(docs/V3_SPEC.md §2.1·§2.2): SSE GET /api/agent/events, GET /api/agent/status.
//   설치하면 등록부(AgentRegistry, server/agents.js)를 만들어 hub(접속 알림)·service(요청 경로 'agent'·푸시)에 넣고 돌려준다
//   (index.js 가 ctx.agents 로 collab 설치 함수에 넘긴다).
//   ctx = { app, service, hub, config, store, wrap, auth, raw, bodyBytes, safeDecode, pkg, root }
//   설치할 때 stdout 에 쓰지 않는다(포트 0 이면 stdout 첫 줄이 'LISTENING <port>' 이어야 한다 — 로그는 console.error).
import { AgentRegistry } from '../agents.js';
import { RUN_KINDS } from '../ai-run.js';

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;   // 세션 id(브리지가 만든 무작위 값) — MCP 머리글 X-Hwpx-Agent-Session 과 같은 규칙
const PING_MS = 20000;                          // ': ping' 주기(프록시·브라우저가 쉬는 연결을 끊지 않게)
// 이름·클라이언트 표기: 제어 문자(C0·C1)·줄 구분(U+2028·2029)·양방향 제어 문자(U+200E·200F·202A~202E·2066~2069)를 빼고 자른다
// (접속 알림·화면에 그대로 나간다). 소스에 그 문자를 직접 쓰지 않으려고 코드 값으로 거른다.
const badCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const clean = (v, max) => [...String(v ?? '')].filter((ch) => !badCp(ch.codePointAt(0))).join('').trim().slice(0, max);
const one = (v) => (Array.isArray(v) ? v[0] : v);

export function installAgentRoutes(ctx) {
  const { app, service, hub, config, wrap, auth, pkg } = ctx;
  const minutes = Number(config?.agents?.leaseMinutes);
  const registry = new AgentRegistry({ hub, leaseMs: Math.round((minutes > 0 ? minutes : 15) * 60000) });
  hub.agents = registry;       // 'presence' 메시지의 agents
  service.agents = registry;   // 요청 경로 'agent'·ai_request·ai_request_cancelled 푸시

  // 토큰은 머리글로만 받는다(주소에 넣으면 서버·프록시 로그에 남는다) — ?token= 이 있으면 머리글이 있어도 400
  const headerOnly = (req, res, next) => {
    if (Object.hasOwn(req.query || {}, 'token')) return res.status(400).json({ error: 'TOKEN_IN_QUERY', message: '이 경로는 토큰을 주소(?token=)로 받지 않습니다. Authorization: Bearer <토큰> 머리글을 쓰세요' });
    return next();
  };

  /**
   * SSE: GET /api/agent/events?session=&agent=&client=&channel=1
   *   연결 즉시 event: hello { user, session, server } → event: snapshot { requests: [내 pending + lease 끝난 working] },
   *   그 뒤 ai_request · ai_request_cancelled · (cr_event) 를 보내고 20초마다 ': ping'. 닫히면 등록부에서 지운다.
   *   머리글을 보낸 뒤에는 던지지 않는다(wrap 이 JSON 오류 응답을 쓰려다 다시 터지지 않게).
   */
  app.get('/api/agent/events', headerOnly, auth, wrap(async (req, res) => {
    const q = req.query || {};
    const agent = clean(one(q.agent), 40) || 'AI';
    const client = clean(one(q.client), 80);
    const runKind = RUN_KINDS.find(k => k.id === one(q.run_kind))?.id;
    const channel = ['1', 'true', 'yes', 'on'].includes(String(one(q.channel) ?? '').trim().toLowerCase());
    const given = String(one(q.session) ?? '').trim();
    if (given && !SESSION_RE.test(given)) return res.status(400).json({ error: 'BAD_SESSION', message: 'session 은 영문·숫자·_- 로 64자 이하여야 합니다' });
    const session = given || `${req.user.name}|${agent}`;   // MCP 쪽 기본 세션('사용자|에이전트')과 같게

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    try { req.socket?.setNoDelay?.(true); } catch { /* 무시 */ }

    let handle = null; let timer = null; let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      if (timer) clearInterval(timer);
      if (handle) registry.disconnect(handle);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    try {
      handle = registry.connect(req.user, { session, agent, client, channel, runKind }, res);
      registry.send(handle, 'hello', { user: req.user.name, session, server: pkg?.version ?? null });
      let requests = [];
      try { requests = service.agentSnapshot(req.user); } catch (e) { console.error('[agents] snapshot 실패:', e.message); }
      const orchestrationReady = () => {
        try { return service.orchestration?.readyTasks(req.user, { agent, client, channel }) || []; }
        catch { return []; } // 새 기능 저장 오류가 기존 단일 AI 채널까지 끊지 않게 한다.
      };
      registry.send(handle, 'snapshot', { requests, orchestrationReady: orchestrationReady() });
      timer = setInterval(() => {
        if (!registry.comment(handle, 'ping')) { cleanup(); return; }
        try {
          const ready = orchestrationReady();
          if (ready.length) registry.send(handle, 'snapshot', { orchestrationReady: ready });
        } catch { /* 문서 권한·저장 오류는 다음 알림 주기에 다시 확인 */ }
      }, PING_MS);
      timer.unref?.();
      if (res.destroyed || res.writableEnded) cleanup();
    } catch (e) {
      console.error('[agents] SSE 연결 처리 실패:', e);
      cleanup();
      try { res.end(); } catch { /* 이미 닫힘 */ }
    }
  }));

  /** GET /api/agent/status → { me: { online, sessions }, users: [{ user, agents: [{ agent, channel, since }] }] } */
  app.get('/api/agent/status', auth, wrap(async (req, res) => {
    res.json({ me: { online: registry.online(req.user.name), sessions: registry.sessions(req.user.name) }, users: registry.list() });
  }));

  return registry;
}
