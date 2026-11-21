// HWPX 공동 검토 서버: 웹 UI + REST API + WebSocket + MCP(Streamable HTTP) + 편집기(/studio/)
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, userByToken, tokenFromRequest } from './config.js';
import { TutorialStore as Store } from './tutorial-store.js';
import { Hub } from './hub.js';
import { Service, ServiceError } from './service.js';
import { AiProposer } from './ai.js';
import { createMcpServer, agentFromRequest, cleanName } from './mcp.js';
import { isLeanRequest } from './lean.js';
import { mcpSurface, requestedSurface, v2Toolset } from './mcp2.js';
import { KINDS, PRESETS, fmtTime } from './memotext.js';
import { installAgentRoutes } from './routes/agents.js';
import { installCollabRoutes } from './routes/collab.js';
import { installConnectionRoutes } from './routes/connections.js';
import { installDriveRoutes } from './routes/drive.js';
import { createWorkerPackage } from './worker-package.js';
import { installAdminRoutes, aiCredits } from './routes/admin.js';
import { installLibraryRoutes } from './routes/library.js';
import { createRuntimeControl } from './runtime-control.js';
import { createOAuthService } from './oauth.js';
import { openAiClaimSession } from './mcp-session.js';
import { createMcpEvents } from './mcp-events.js';
import { handleModernMcp, isModernRequest, modernClientName } from './mcp-modern.js';
import { automationStatus } from './automation-status.js';
import { createWorkFiles } from './work-files.js';
import { createPersonalAi } from './personal-ai.js';
import { createTutorial } from './tutorial.js';
import { createAiRun } from './ai-run.js';
import { createDocumentOrchestration } from './orchestration-service.js';
import { installOrchestrationRoutes } from './routes/orchestration.js';
import { createNativeClipboard, isLocalClipboardRequest, isClipboardProofOrigin } from './native-clipboard.js';
import { createClipboardBridge } from './clipboard-bridge.js';
import { seedManualsOnce } from './manual-seed.js';
import { installReleaseDownloads } from './release-downloads.js';
import { compressedStatic } from './static-compress.js';
import { installClientLog } from './client-log.js';
import { createJournal, installProcessDiagnostics } from './recovery-state.js';
import { createAdminMcp, ADMIN_MCP_PATH } from './admin-mcp.js';
import { createLocalFolders } from './local-folders.js';
import { installLocalRoutes } from './routes/local.js';
import { withAiDebug, debugRecord, debugError, currentAiDebug, createAiDebug, debugServiceState } from './ai-debug.js';

// URL.pathname 은 공백·한글을 %xx 로 남긴다 — 포터블을 '새 폴더'·한글 경로에 풀어도 되게 fileURLToPath 로 푼다
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const cfg = loadConfig(root);
const runtimeJournal = createJournal(process.env.HWPX_COWORK_RUNTIME_DIR || path.join(cfg.dataDir, 'runtime'), { secrets: cfg.users.map(u => u.token) });
installProcessDiagnostics({ journal: runtimeJournal });
const oauth = createOAuthService({ config: cfg });
const store = new Store(cfg.dataDir);
const hub = new Hub({ onConnectionError: error => runtimeJournal.write('websocket-connection-error', { code: error.code, name: error.name }) });
const ai = new AiProposer(cfg);
if (cfg.ai.forcedOff) ai.reason = 'HWPX_COWORK_AI=off(환경 변수로 끔)';
const service = new Service({ store, hub, config: cfg, ai });
service.orchestration = createDocumentOrchestration({ service, config: cfg });
// 개인 AI 키: 각자 웹에서 등록한 키로 그 사람의 요청을 서버가 처리(server/personal-ai.js)
const personalAi = createPersonalAi({ config: cfg });
service.personalAi = personalAi;
// 튜토리얼: 임시 연습 문서·완료 저장·관리자 API 공유(server/tutorial.js)
const tutorial = createTutorial({ service, config: cfg });
// 연결별 모델·추론 강도(웹에서 정하고 내 PC 실행기·채널 에이전트가 읽는다 — server/ai-run.js)
const aiRun = createAiRun({ config: cfg });
service.aiRun = aiRun;
service.workFiles = createWorkFiles({ config: cfg, service });
const mcpEvents = createMcpEvents({ config: cfg, service, hub, oauth });
service.tutorialChatGPTReady = () => mcpEvents.hasTutorialSubscriber();
service.tutorialChatGPTDelivery = (docId, rid, attempt) => mcpEvents.tutorialRequestStatus(docId, rid, attempt);
// 이 프로세스의 표식: 시험 받침이 '내가 띄운 서버'인지 확인한다(남은 옛 서버와 섞이지 않게, §6.0)
const NONCE = crypto.randomBytes(8).toString('hex');
// PC 폴더 연결(개인용 앱 — config.local.enabled): 이 PC 의 폴더를 관리자의 개인 문서함에 비추고, 고친 문서를 그 파일에 쓴다(server/local-folders.js)
if (cfg.local.enabled) service.local = createLocalFolders({ config: cfg, service, instanceId: NONCE });
// 응답 연결이 끊겨도 이미 실행 중인 저장·AI·MCP 작업은 마친 뒤 재시작한다.
const activeOperations = new Set();
const activeRequests = new Set();
let draining = false;
function trackOperation(fn) {
  const pending = Promise.resolve().then(fn);
  activeOperations.add(pending);
  pending.then(() => activeOperations.delete(pending), () => activeOperations.delete(pending));
  return pending;
}
const restartControl = createRuntimeControl({ onPrepareRestart: prepareShutdown });

const app = express();
app.disable('x-powered-by');
installReleaseDownloads(app, { root });
app.use((req, res, next) => {
  const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const apiPath = /^\/(api(?:\/|$)|mcp(?:\/|$))/.test(req.path);
  const statusRead = readOnly && ['/api/config', '/api/me', '/api/admin/server'].includes(req.path);
  if (draining && (!readOnly || (apiPath && !statusRead))) {
    return res.status(503).set('Retry-After', '2').json({ error: 'SERVER_RESTARTING', message: '서버를 재시작하고 있습니다. 잠시 후 다시 저장하세요.' });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // 본문 업로드를 받는 중인 요청도 포함한다. 작업 자체의 수명은 trackOperation이 따로 지킨다.
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    activeRequests.add(pending);
    const done = () => { activeRequests.delete(pending); release(); };
    res.once('finish', done); res.once('close', done);
  }
  next();
});
// 파일 바이트를 받는 경로는 JSON 해석을 건너뛴다(.json 첨부가 객체로 바뀌지 않게). 수정본 저장(PUT drafts/mine)도 HWPX 바이트
const jsonParser = express.json({ limit: '20mb', verify(req, res, bytes) {
  if (/^\/mcp(?:\/|$)/.test(req.path)) req.aiDebugRaw = Buffer.from(bytes);
} });
const clipboardParser = express.json({ limit: '30mb' });
const nativeImportParser = express.json({ limit: '44mb' });
// v0.4 실시간 밀어 넣기(PUT /live)도 편집기 내보내기 HWPX 바이트
const RAW_ROUTES = [/^\/api\/docs\/?$/, /^\/api\/docs\/[^/]+\/attachments\/?$/, /^\/api\/docs\/[^/]+\/upload\/?$/, /^\/api\/docs\/[^/]+\/drafts\/mine\/?$/, /^\/api\/docs\/[^/]+\/live\/?$/, /^\/api\/docs\/[^/]+\/requests\/[^/]+\/files\/?$/];
RAW_ROUTES.push(/^\/api\/drive\/files\/?$/);
app.use((req, res, next) => req.path === '/api/clipboard/import' ? nativeImportParser(req, res, next) : req.path === '/api/clipboard/native' ? clipboardParser(req, res, next)
  : ((req.method === 'POST' || req.method === 'PUT') && RAW_ROUTES.some((re) => re.test(req.path)) ? next() : jsonParser(req, res, next)));
app.use(oauth.middleware);
// GitHub Pages 에 끼워 연 화면(web/pages-host.js 가 X-Hwpx-Host: github-pages 를 붙인다 — deploy/github-pages/app.html)에서는
// 개인 API 키·두레이 토큰을 저장하지 않는다(2026-11-18 사용자 결정 — 누구나 여는 공개 페이지라 위험, GitHub 페이지에만 적용). 서버 주소로 직접 연 화면은 그대로
const PAGES_SECRET_ROUTES = [['PUT', '/api/me/ai'], ['PUT', '/api/drive/connection']];
app.use((req, res, next) => {
  if (String(req.get('x-hwpx-host') || '').toLowerCase() === 'github-pages' && PAGES_SECRET_ROUTES.some(([m, p]) => req.method === m && req.path === p)) {
    return res.status(403).set('Cache-Control', 'no-store').json({ error: 'PAGES_NO_SECRETS', message: 'GitHub 페이지에서는 API 키·토큰을 저장하지 않습니다. 서버 주소에서 직접 열어 저장하세요.' });
  }
  next();
});

// ── 인증 ──
function auth(req, res, next) {
  const user = userByToken(cfg, tokenFromRequest(req));
  if (!user) return res.status(401).json({ error: 'unauthorized', message: '토큰이 올바르지 않습니다' });
  req.user = user; next();
}
const wrap = (fn) => (req, res) => trackOperation(() => fn(req, res)).catch((e) => {
  if (e instanceof ServiceError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.extra || {}) });
  if (e?.code === 'BAD_ARG') return res.status(400).json({ error: e.code, message: e.message });   // 저장소 인자 검사(문서 id·번호)
  console.error(e); res.status(500).json({ error: 'internal', message: e.message });
});
const raw = express.raw({ type: () => true, limit: '300mb' });
const rawAttachment = express.raw({ type: () => true, limit: cfg.attachments.maxBytes });
const bodyBytes = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
const safeDecode = (s, d) => { try { return decodeURIComponent(s); } catch { return d; } };

const nativeClipboard = createNativeClipboard();
const clipboardBridge = createClipboardBridge({ enabled: cfg.clipboardBridge?.enabled === true });
clipboardBridge.start();
app.get('/api/clipboard/status', auth, wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(isLocalClipboardRequest(req)
    ? { ...await nativeClipboard.status(), bridge: clipboardBridge.status() } : { available: false, reason: 'SAME_PC_REQUIRED' });
}));
app.post('/api/clipboard/native', auth, wrap(async (req, res) => {
  const local = isLocalClipboardRequest(req);
  if (!local && !isClipboardProofOrigin(req, cfg.publicUrl)) return res.status(403).json({ ok: false, reason: 'SAME_PC_REQUIRED' });
  const result = await nativeClipboard.write(req.body, { requireClipboardProof: !local });
  res.set('Cache-Control', 'no-store').status(result.ok ? 200 : result.reason === 'SAME_PC_REQUIRED' ? 403 : 409).json(result);
}));
app.post('/api/clipboard/read-native', auth, wrap(async (req, res) => {
  if (!isLocalClipboardRequest(req)) return res.status(403).json({ ok: false, reason: 'SAME_PC_REQUIRED' });
  const result = await nativeClipboard.read(req.body);
  res.set('Cache-Control', 'no-store').status(result.ok ? 200 : 409).json(result);
}));
app.post('/api/clipboard/import', auth, wrap(async (req, res) => {
  if (!isLocalClipboardRequest(req) && !isClipboardProofOrigin(req, cfg.publicUrl)) return res.status(403).json({ ok: false, reason: 'SAME_ORIGIN_REQUIRED' });
  const result = await nativeClipboard.importFragment(req.body);
  res.set('Cache-Control', 'no-store').status(result.ok ? 200 : result.reason === 'IMPORT_BUSY' ? 429 : 409).json(result);
}));

// MCP에서 발급한 파일 하나·요청 한 시도에만 유효한 만료 링크. 사용자 토큰은 URL에 넣지 않는다.
app.get('/api/work-files/:ticket', wrap(async (req, res) => {
  const { entry, bytes } = await service.workFiles.resolve(req.params.ticket);
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(bytes);
}));

// ── 편집기 빌드 상태(§1.1): 요청마다 본다(서버를 켠 채 npm run build:studio 해도 바로 반영) ──
function studioInfo() {
  const built = fs.existsSync(path.join(cfg.studioDir, 'index.html'));
  let buildInfo = null;
  if (built) { try { buildInfo = JSON.parse(fs.readFileSync(path.join(cfg.studioDir, 'cowork-build.json'), 'utf-8')); } catch { buildInfo = null; } }
  return { mode: cfg.studio.mode, built, buildInfo };
}
// local: 언제나 같은 출처 /studio/(빌드가 없으면 그 주소가 503 + 빌드 안내), remote: config.studioUrl(cowork 플러그인 없음)
const studioUrlOf = (st) => (st.mode === 'remote' ? cfg.studioUrl : '/studio/');

// 로그인 화면의 체험 토큰 안내(2026-11-17): 체험이 켜져 있고 이름이 곧 토큰인 testN 계정이 있을 때만 'test1 ~ test100' 꼴, 없으면 null(안내 없음).
// 예전에는 화면이 'test1 ~ test100' 을 늘 보여 체험 계정이 없는 설치(개인용·새 공동 서버)에서도 없는 토큰을 안내했다. 이름만 보이고 다른 토큰은 내보내지 않는다
function tutorialLoginHint() {
  try {
    const c = tutorial.conf(); if (!c.on) return null;
    const nums = (cfg.users || []).filter((u) => /^test\d+$/.test(u.name) && u.token === u.name && (c.everyone || c.users.has(u.name)))
      .map((u) => Number(u.name.slice(4))).sort((a, b) => a - b);
    if (!nums.length) return null;
    return nums.length === 1 ? `test${nums[0]}` : `test${nums[0]} ~ test${nums.at(-1)}`;
  } catch { return null; }
}

// ── 공개 정보 ──
app.get('/api/config', (req, res) => {
  const studio = studioInfo();
  res.json({
    name: pkg.name, version: pkg.version, studioUrl: studioUrlOf(studio), publicUrl: cfg.publicUrl,
    aiEnabled: !!ai.enabled, aiMock: !!ai.mock, aiReason: ai.reason || null, aiModel: ai.mock ? 'mock' : cfg.ai.model, aiProvider: ai.provider, aiGateway: ai.gateway, allowAgentApply: cfg.allowAgentApply,
    // 제안 '기준에 바로 적용'을 관리자 아닌 사람도 쓰는지(config.changeRequests.allowDirectApply, 기본 false — routes/collab.js 가 막는다)
    allowDirectApply: cfg.changeRequests?.allowDirectApply === true,
    attachments: { maxBytes: cfg.attachments.maxBytes, maxPerDoc: cfg.attachments.maxPerDoc }, presets: PRESETS, kinds: KINDS,
    nonce: NONCE, studio,
    // mcp2: 새 MCP 연결(작업 도구 넷 — server/mcp2.js)과 요청 내용 REST(GET …/requests/:rid/brief)를 이 서버가 안다(실행기가 --mcp 2 로 붙기 전에 확인한다)
    // contentFormatWorkflow: 내용·형식 나눠 처리(실험)를 받는가 — config.experiments.contentFormat(기본 끔, 2026-11-16). 꺼져 있으면 편집기가 그 선택 칸을 보이지 않는다
    // mcpDefault: 머리글·주소로 밝히지 않은 MCP 연결을 무엇으로 여는가('v3' 기본 | 'v2' | 'v1' — config.mcp.defaultSurface). 연결 안내 화면이 기본·예전 연결 주소를 고를 때 본다
    // adminFeatures: 관리자 [기능 설정] 탭(GET/PATCH /api/admin/features)을 이 서버가 안다(2026-11-18 — 옛 서버면 탭을 숨긴다)
    features: { contentFormatWorkflow: cfg.experiments?.contentFormat === true, mcp2: true, mcp3: true, mcpDefault: cfg.mcp.defaultSurface, adminFeatures: true, requestRunSettings: true },
    // 로그인 화면의 [개인 토큰 발급받기](POST /api/self-token) — 관리자가 [기능 설정]에서 켰을 때만(config.accounts.selfIssue, 바로 적용)
    selfIssue: cfg.accounts?.selfIssue?.enabled === true,
    local: !!service.local,   // PC 폴더 연결(개인용 앱)이 켜져 있는가
    tutorialLogin: tutorialLoginHint(),   // 로그인 화면 체험 토큰 안내 글(없으면 null)
    oauth: oauth.status(),
    mcpEvents: { enabled: mcpEvents.enabled(), protocolVersion: '2026-07-28', event: 'ai_request.created' },
  });
});
installClientLog(app, { auth, dir: process.env.HWPX_COWORK_RUNTIME_DIR || path.join(cfg.dataDir, 'runtime') });
app.get('/api/me', auth, (req, res) => {
  // 개인 AI 설정 파일이 망가져도 로그인은 된다(화면은 토큰 확인에 /api/me 를 쓴다)
  let personal; try { personal = personalAi.status(req.user); } catch (e) { personal = { configured: false, active: false, error: e.message }; }
  // 체험 계정은 관리자 API만 사용하며, 개인 키·개인 실행기를 대체 경로로 쓰지 않는다.
  if (tutorial.isUser(req.user.name)) personal = service.tutorialAiStatus(req.user.name);
  // tutorial은 메뉴 사용 여부. tutorialAuto는 이전 클라이언트의 자동 시작 호환용이다.
  const tour = tutorial.canUse(req.user.name);
  // serverAi: 이 계정이 공용 서버 AI 를 쓸 수 있는가(켜져 있고 허용된 계정 — 관리자 화면 '사용자' 탭의 서버 AI 칸)
  res.set('Cache-Control', 'no-store').json({ name: req.user.name, role: req.user.role, personalAi: personal, serverAi: service.aiOn && service.serverAiAllowed(req.user.name), ...(tutorial.isUser(req.user.name) ? { tutorialApiOnly: true } : {}), ...(tour ? { tutorial: true, tutorialIntroRequired: tutorial.introFor(req.user), tutorialAi: service.tutorialAiStatus(req.user.name), ...(tutorial.autoFor(req.user.name) ? { tutorialAuto: true } : {}) } : {}) });
});
// 튜토리얼: 목록 조회·새 임시 문서 시작·완료 저장·버리기. 조회에는 문서를 만들지 않는다.
app.get('/api/tutorial', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.status(req.user))));
app.get('/api/tutorial/definition', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.definition(req.user))));
app.put('/api/tutorial/definition', auth, wrap(async (req, res) => res.json(tutorial.saveDefinition(req.user, req.body))));
app.post('/api/tutorial/visit', auth, wrap(async (req, res) => res.json(tutorial.visit(req.user))));
app.post('/api/tutorial/entry', auth, wrap(async (req, res) => res.json(await tutorial.entry(req.user))));
app.post('/api/tutorial/start', auth, wrap(async (req, res) => res.json(await tutorial.start(req.user, { auto: !!req.body?.auto, tutorialId: req.body?.tutorialId }))));
app.get('/api/tutorial/:id/progress', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(tutorial.progress(req.user, req.params.id))));
app.put('/api/tutorial/:id/progress', auth, wrap(async (req, res) => res.json(await tutorial.saveProgress(req.user, req.params.id, req.body))));
app.post('/api/tutorial/:id/restore', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await tutorial.restore(req.user, req.params.id, req.body))));
app.post('/api/tutorial/:id/complete', auth, wrap(async (req, res) => res.json(await tutorial.complete(req.user, req.params.id))));
app.delete('/api/tutorial/:id', auth, wrap(async (req, res) => res.json(await tutorial.discard(req.user, req.params.id))));
// 내 AI 키(개인 키를 서버에 맡겨 서버가 내 요청을 처리): 키는 다시 내보내지 않는다(끝 4자리만). check 는 모델 정보 조회만(과금 없음)
app.get('/api/me/ai', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(personalAi.status(req.user))));
app.put('/api/me/ai', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(personalAi.save(req.user, req.body))));
app.delete('/api/me/ai', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(personalAi.remove(req.user))));
app.post('/api/me/ai/check', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await personalAi.check(req.user))));
app.get('/api/me/ai/models', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await personalAi.models(req.user))));
// 내 키의 API 잔액·이번 달 사용량(GET 만 — 과금 없음). 키를 등록한 사람은 누구나 자기 것만
app.get('/api/me/ai/credits', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await aiCredits(personalAi, cfg, req.user.name, req.query.refresh === '1', { ownOnly: true }))));
// 연결별 모델·추론 강도(server/ai-run.js): 웹에서 정하고, 내 PC 실행기·채널 에이전트가 읽어 쓴다. catalog = 실행기가 알려 주는 모델 목록
app.get('/api/me/ai-run', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(aiRun.view(req.user))));
app.put('/api/me/ai-run', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(aiRun.save(req.user, req.body || {}))));
app.put('/api/me/ai-run/catalog', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(aiRun.report(req.user, req.body || {}))));
app.get('/api/oauth/connections', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(oauth.connections(req.user))));
app.delete('/api/oauth/connections/:id', auth, wrap(async (req, res) => res.json({ revoked: oauth.disconnect(req.user, req.params.id) })));
app.get('/api/events/status', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(mcpEvents.status(req.user))));
app.get('/api/automation/status', auth, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(automationStatus({ user: req.user, service, events: mcpEvents, ai, config: cfg, personalAi }))));
// 사람 목록(V4 §1 — 문서 설정 창의 수정 권한 고르기): [{ name, role }] — 로그인한 사람 누구나, 토큰은 절대 싣지 않는다
app.get('/api/users', auth, (req, res) => res.json(service.listUsers()));

// ── v0.3 라우터(웨이브 1 이 채운다): 개인 에이전트(§2) · 수정본·변경 요청·메모 스레드(§3) ──
// 기존 문서 경로보다 먼저 끼운다 — 새 경로를 더하고, 필요하면 같은 경로(예: /file?reviews=1)를 먼저 받아 처리하거나 next() 로 넘긴다.
// installAgentRoutes 가 돌려주는 값(예: 에이전트 등록부)은 ctx.agents 로 collab 에 넘어간다.
const routeCtx = { app, service, hub, config: cfg, store, wrap, auth, raw, bodyBytes, safeDecode, pkg, root, restartControl, instanceId: NONCE };
installOrchestrationRoutes(routeCtx);
// 문서함 접근 문(docs/LIBRARY_SPEC.md): /api/docs/:id 아래 모든 경로(collab·agents 라우터 것도)보다 먼저 — 볼 수 없는 문서는 없는 것처럼 404.
// 그 뒤 쓰기 권한(편집·삭제·관리)은 서비스가 문서마다 본다(canEdit·docPerms)
// PC 폴더의 아직 열지 않은 파일은 그 id 로 처음 부를 때 문서로 등록한다(local.ensure — 지우기는 등록하지 않고 파일만 지운다)
app.use('/api/docs/:id', auth, async (req, res, next) => {
  try {
    if (service.local && !(req.method === 'DELETE' && req.path === '/')) await trackOperation(() => service.local.ensure(req.params.id, req.user));
    service.assertDocRead(req.params.id, req.user);
  } catch (e) { return res.status(e.status || 404).json({ error: e.code || 'NO_DOC', message: e.message }); }
  next();
});
installLibraryRoutes(routeCtx);
installLocalRoutes(routeCtx);
installConnectionRoutes(routeCtx);
routeCtx.drive=installDriveRoutes({ ...routeCtx, rawAttachment });
installAdminRoutes(routeCtx);
app.get('/api/worker-package', auth, wrap(async (req, res) => {
  const bytes = await createWorkerPackage(root);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="hwpx-ai-worker.zip"', 'Cache-Control': 'no-store' }).send(bytes);
}));
app.get('/manual.md', (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'DEPLOYMENT_AND_AI_GUIDE.md')));
// 설명서 안의 보조 자료만 허용한다. 임의 파일 경로를 받지 않는다.
app.get('/manual-resources/AGENT_SETUP.md', (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'AGENT_SETUP.md')));
app.get('/manual-resources/MCP_EVENTS_GUIDE.md', (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'MCP_EVENTS_GUIDE.md')));
app.get('/manual-resources/CHATGPT_WORK_FILES.md', (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'CHATGPT_WORK_FILES.md')));
app.get('/manual-resources/AUTOMATIC_AI_GUIDE.md', (req, res) => res.type('text/markdown').sendFile(path.join(root, 'docs', 'AUTOMATIC_AI_GUIDE.md')));
app.get('/manual-resources/Caddyfile.example', (req, res) => res.type('text/plain').sendFile(path.join(root, 'deploy', 'Caddyfile.example')));
routeCtx.agents = (await installAgentRoutes(routeCtx)) ?? null;
routeCtx.collab = (await installCollabRoutes(routeCtx)) ?? null;

// ── 문서 ──
app.get('/api/docs', auth, wrap(async (req, res) => res.json(await service.listDocuments(req.user))));
app.post('/api/docs', auth, raw, wrap(async (req, res) => {
  const fileName = safeDecode(req.headers['x-file-name'] || 'document.hwpx', 'document.hwpx');
  // 올릴 자리(문서함·폴더): x-space public|private, x-folder-id — 없으면 공용 문서함 맨 위(작성 권한이 없으면 내 개인 문서함)
  const head = (k) => (req.headers[k] ? safeDecode(String(req.headers[k]), '') : '');
  const location = head('x-folder-id') || head('x-space') ? { space: head('x-space') || undefined, owner: head('x-space-owner') || undefined, folderId: head('x-folder-id') || undefined } : null;
  res.json(await service.createDocument({ fileName, bytes: bodyBytes(req), user: req.user, location }));
}));
app.get('/api/docs/:id', auth, wrap(async (req, res) => res.json(await service.getDocument(req.params.id, req.user))));
app.delete('/api/docs/:id', auth, wrap(async (req, res) => res.json({ ok: await service.deleteDocument(req.params.id, req.user) })));
// 문서 이름(제목) 바꾸기 { title } → 문서 요약
app.patch('/api/docs/:id', auth, wrap(async (req, res) => res.json(await service.renameDocument(req.params.id, req.body?.title, req.user))));
app.get('/api/docs/:id/file', auth, wrap(async (req, res) => {
  const kind = req.query.kind || 'working';
  // 한글로 저장 단추 하나(V4 §3): 문서 설정 exportKind 대로 — final = 최종본 + 메모(최종본을 못 만들면 변경 추적 포함으로 바꿔 내고
  // X-Export-Fallback: tracked), tracked = 변경 추적 + 메모. 메모 = 문서의 메모 전부 + 승인 방식이면 진행 중 변경 요청의 검토 메모(V3 §3.7).
  // 파일 이름 <제목>.hwpx, 머리글 X-Export-Kind = 실제로 낸 것(final|tracked)
  if (kind === 'export' && routeCtx.collab?.crs) {
    const meta = service._meta(req.params.id);
    const s = service._settings(meta);
    const reviews = s.editMode === 'review';
    let out; let fallback = null; let made = s.exportKind;
    if (s.exportKind === 'final') {
      try { out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'final', { reviews, strict: true }); } catch (e) {
        if (!(e instanceof ServiceError) || e.code !== 'CANNOT_FLATTEN') throw e;
        out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'tracked', { reviews }); fallback = 'tracked'; made = 'tracked';
      }
    } else out = await routeCtx.collab.crs.exportWithReviews(req.params.id, 'tracked', { reviews });
    res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${out.title || meta.title || 'document'}.hwpx`)}`);
    res.setHeader('X-Doc-Version', String(out.version));
    res.setHeader('X-Review-Memos', String(out.memos));
    res.setHeader('X-Export-Kind', made);
    if (fallback) res.setHeader('X-Export-Fallback', fallback);
    return res.send(Buffer.from(out.bytes));
  }
  // 한글로 저장(V3 §3.7): tracked|final + reviews=1 → 진행 중인 변경 요청 덩어리마다 검토 메모를 더한 사본(원본·버전은 그대로)
  if (req.query.reviews === '1' && (kind === 'tracked' || kind === 'final') && routeCtx.collab?.crs) {
    const out = await routeCtx.collab.crs.exportWithReviews(req.params.id, kind);
    res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
    res.setHeader('X-Doc-Version', String(out.version));
    res.setHeader('X-Review-Memos', String(out.memos));
    return res.send(Buffer.from(out.bytes));
  }
  // working(final 도 같음): 사본과 버전을 같은 커밋 상태에서 함께 뽑는다(X-Doc-Version 이 바이트와 어긋나지 않게)
  let bytes; let version = null;
  if (kind === 'tracked') bytes = service.trackedCopy(req.params.id);
  else if (kind === 'version') bytes = service.versionCopy(req.params.id, req.query.n);
  else ({ bytes, version } = await service.workingSnapshot(req.params.id));
  const meta = store.readMeta(req.params.id);
  // 기록(kind=version&n=기록 번호) 내려받기 이름은 웹과 같은 꼴(V3 §9.7): 그 기록이 사람용 버전이면 '_v3', 아니면 '_10-23_0116' —
  // 기록 번호(내부 판)를 'v' 로 이름에 쓰지 않는다
  const versionTag = () => {
    const m = service._meta(req.params.id); const n = Number(req.query.n);
    const ms = (m.milestones || []).find((x) => x.n === n);
    if (ms) return `_v${ms.v}`;
    const at = (m.versions || []).find((x) => x.n === n)?.at;
    return `_${(at ? fmtTime(at).replace(' ', '_').replace(':', '') : '') || '기록'}`;
  };
  res.setHeader('Content-Type', 'application/vnd.hancom.hwpx');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((meta?.title || 'document') + (kind === 'tracked' ? '_변경추적' : kind === 'version' ? versionTag() : kind === 'final' ? '_최종' : '_최종본') + '.hwpx')}`);
  res.setHeader('X-Doc-Version', String(version ?? meta?.version ?? 0));
  res.send(Buffer.from(bytes));
}));
app.get('/api/docs/:id/paragraphs', auth, wrap(async (req, res) => res.json(await service.paragraphs(req.params.id, { view: req.query.view || 'final', nested: req.query.nested !== '0' }))));
app.get('/api/docs/:id/tables', auth, wrap(async (req, res) => res.json(await service.tables(req.params.id))));
app.get('/api/docs/:id/search', auth, wrap(async (req, res) => res.json(await service.search(req.params.id, req.query.q))));
app.get('/api/docs/:id/history', auth, wrap(async (req, res) => res.json(await service.history(req.params.id))));
// [버전 저장](V3 §9.4): 지금 기록에 사람용 버전 하나 { note? } → { milestone } / 409 NO_CHANGES — 로그인한 사람 누구나(글을 바꾸지 않음)
app.post('/api/docs/:id/milestones', auth, wrap(async (req, res) => res.json(await service.saveMilestone(req.params.id, req.body || {}, req.user))));
app.put('/api/docs/:id/upload', auth, raw, wrap(async (req, res) => res.json(await service.uploadEdited(req.params.id, bodyBytes(req), { baseVersion: req.query.base, user: req.user, live: req.query.live === '1' }))));
app.post('/api/docs/:id/versions/:n/restore', auth, wrap(async (req, res) => res.json(await service.restoreVersion(req.params.id, Number(req.params.n), req.user))));

// ── 첨부 ──
app.get('/api/docs/:id/attachments', auth, wrap(async (req, res) => res.json(await service.listAttachments(req.params.id))));
app.post('/api/docs/:id/attachments', auth, rawAttachment, wrap(async (req, res) => {
  const name = safeDecode(req.headers['x-file-name'] || 'file', 'file');
  res.json(await service.addAttachment(req.params.id, { name, bytes: bodyBytes(req) }, req.user));
}));
app.get('/api/docs/:id/attachments/:aid', auth, wrap(async (req, res) => {
  // MCP v3 실험(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §21): 'template' = 이 문서의 스타일·쪽 설정만 가진 빈 서식, 'document' = 이 문서 사본(최종본).
  // 개인 브리지의 download_attachment_file 이 그대로 받는다(첨부 aid 는 a1·a2… 이라 겹치지 않는다). 읽기 권한은 위 /api/docs/:id 문이 본다
  if (req.params.aid === 'template' || req.params.aid === 'document') {
    const f = await service.documentFile(req.params.id, req.params.aid);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.send(f.bytes);
  }
  const { entry, bytes } = await service.getAttachment(req.params.id, req.params.aid);
  const inline = entry.kind === 'image' || entry.kind === 'pdf';
  res.setHeader('Content-Type', inline ? entry.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(bytes);
}));
// 개인 브리지의 로컬 파일 도구(upload_result_file)가 내 PC 작업 폴더의 결과 파일을 요청 결과 첨부로 올린다.
// 요청자·현재 시도(?attempt=)·선점 세션(X-Hwpx-Agent-Session — 브리지의 MCP 호출과 같은 값) 검사는 MCP save_result_file 과 같다. 같은 시도·같은 내용은 한 번만
app.post('/api/docs/:id/requests/:rid/files', auth, rawAttachment, wrap(async (req, res) => {
  const rawSession = String(req.headers['x-hwpx-agent-session'] ?? '').trim();
  if (rawSession && !/^[A-Za-z0-9_-]{1,64}$/.test(rawSession)) return res.status(400).json({ error: 'BAD_SESSION', message: '에이전트 세션 id 가 올바르지 않습니다' });
  const attempt = Number(req.query.attempt);
  const user = { ...req.user, ...(rawSession ? { agentSession: rawSession } : {}), ...(Number.isInteger(attempt) && attempt > 0 ? { agentAttempt: attempt } : {}) };
  const bytes = bodyBytes(req);
  const name = safeDecode(String(req.headers['x-file-name'] || ''), '') || '결과 파일';
  const sourceFileId = `local:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  res.json(await service.addRequestFile(req.params.id, { rid: Number(req.params.rid), sourceFileId, name, bytes }, user, cleanName(req.query.agent) || 'AI'));
}));
app.get('/api/docs/:id/attachments/:aid/text', auth, wrap(async (req, res) => res.json(await service.attachmentText(req.params.id, req.params.aid, Number(req.query.max) || 20000))));
app.delete('/api/docs/:id/attachments/:aid', auth, wrap(async (req, res) => res.json({ ok: await service.deleteAttachment(req.params.id, req.params.aid, req.user) })));

// ── 메모 ──
app.get('/api/docs/:id/memos', auth, wrap(async (req, res) => res.json(await service.memos(req.params.id, req.user))));
app.post('/api/docs/:id/memos', auth, wrap(async (req, res) => res.json(await service.addMemo(req.params.id, req.body || {}, req.user))));
app.patch('/api/docs/:id/memos/:memoId', auth, wrap(async (req, res) => res.json(await service.patchMemo(req.params.id, req.params.memoId, req.body?.text, req.user))));
app.delete('/api/docs/:id/memos/:memoId', auth, wrap(async (req, res) => res.json({ ok: await service.deleteMemo(req.params.id, req.params.memoId, req.user) })));

// ── 제안 ──
app.get('/api/docs/:id/proposals', auth, wrap(async (req, res) => res.json(await service.listProposals(req.params.id, req.query.status))));
app.post('/api/docs/:id/proposals', auth, wrap(async (req, res) => {
  const b = req.body || {};
  // 그림 제안은 그림 출처(첨부 aid·imageBase64·chart)를 먼저 첨부로 만든다(service.proposeFigure)
  if (b.type === 'figure') return res.json(await service.proposeFigure(req.params.id, { ...b, ...(b.figure || {}) }, req.user));
  res.json(await service.propose(req.params.id, b, req.user));
}));
app.patch('/api/docs/:id/proposals/:pid', auth, wrap(async (req, res) => res.json(await service.patchProposal(req.params.id, req.params.pid, req.body || {}, req.user))));
app.post('/api/docs/:id/proposals/:pid/apply', auth, wrap(async (req, res) => res.json(await service.applyProposal(req.params.id, req.params.pid, req.user))));
app.post('/api/docs/:id/proposals/:pid/reject', auth, wrap(async (req, res) => res.json(await service.rejectProposal(req.params.id, req.params.pid, req.user))));
app.post('/api/docs/:id/proposals/:pid/undo', auth, wrap(async (req, res) => res.json(await service.undoProposal(req.params.id, req.params.pid, req.user))));
app.post('/api/docs/:id/proposals/:pid/reopen', auth, wrap(async (req, res) => res.json(await service.reopenProposal(req.params.id, req.params.pid, req.user))));

// ── 변경 추적 ──
app.get('/api/docs/:id/changes', auth, wrap(async (req, res) => res.json(await service.changes(req.params.id))));
app.post('/api/docs/:id/changes/accept-all', auth, wrap(async (req, res) => res.json({ accepted: await service.acceptAll(req.params.id, req.user) })));
// 묶음(교체·개체 짝)을 한 번에: { ids: number[], mode: 'accept'|'reject' } → { ok, done, gone } — 번호 다시 매김을 서버가 따라간다
app.post('/api/docs/:id/changes/resolve', auth, wrap(async (req, res) => res.json(await service.resolveChangeList(req.params.id, req.body?.ids, req.body?.mode, req.user))));
app.post('/api/docs/:id/changes/:cid/accept', auth, wrap(async (req, res) => res.json({ ok: await service.resolveChange(req.params.id, Number(req.params.cid), 'accept', req.user) })));
app.post('/api/docs/:id/changes/:cid/reject', auth, wrap(async (req, res) => res.json({ ok: await service.resolveChange(req.params.id, Number(req.params.cid), 'reject', req.user) })));

// ── AI 작업(요청) / 잠금 ──
app.get('/api/docs/:id/requests', auth, wrap(async (req, res) => res.json(await service.listRequests(req.params.id, { status: req.query.status }, req.user))));
app.post('/api/docs/:id/requests', auth, wrap(async (req, res) => res.json(await service.createRequest(req.params.id, req.body || {}, req.user))));
app.get('/api/docs/:id/requests/:rid', auth, wrap(async (req, res) => res.json(await service.getRequestView(req.params.id, req.params.rid, req.user))));
app.get('/api/docs/:id/requests/:rid/workspace-file', auth, wrap(async (req, res) => {
  const kind = req.query.kind || 'hwpx';
  const bytes = await service.editWorkspaceFile(req.params.id, req.params.rid, { kind, attempt: req.query.attempt, revision: req.query.revision }, req.user);
  res.set('Cache-Control', 'no-store').type(kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/vnd.hancom.hwpx');
  res.set('Content-Disposition', `attachment; filename="request-${Number(req.params.rid)}-draft.${kind === 'markdown' ? 'md' : 'hwpx'}"`).send(bytes);
}));
// AI 작업 진행 기록(server/activity.js — AI 가 부른 도구를 한 줄씩. 새 줄은 WebSocket { type:'activity' } 로 온다)
app.get('/api/docs/:id/requests/:rid/activity', auth, wrap(async (req, res) => res.json(service.requestActivity(req.params.id, req.params.rid, req.user))));
// 새 MCP 연결의 요청 내용(task 응답과 같다 — server/mcp2/service.js agentBrief): 실행기가 모델의 첫 입력에 실어 task 호출 한 번을 아낀다
app.get('/api/docs/:id/requests/:rid/brief', auth, wrap(async (req, res) => {
  service.assertDocRead(req.params.id, req.user);
  const session = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.headers['x-hwpx-agent-session'] || '')) ? String(req.headers['x-hwpx-agent-session']) : null;
  res.set('Cache-Control', 'no-store').json(await service.agentBrief(req.params.id, Number(req.params.rid), req.user, { session, surface: requestedSurface(req) === 'v3' ? 'v3' : 'v2' }));
}));
// 요청의 선점 상태만(문서를 읽지 않는다 — server/mcp2/service.js agentClaimState): 새 연결의 실행기 도구 연결(server/codex-mcp.js)이 쓰기 직전에 본다
app.get('/api/docs/:id/requests/:rid/claim', auth, wrap(async (req, res) => {
  const session = /^[A-Za-z0-9_-]{1,64}$/.test(String(req.headers['x-hwpx-agent-session'] || '')) ? String(req.headers['x-hwpx-agent-session']) : null;
  res.set('Cache-Control', 'no-store').json(service.agentClaimState(req.params.id, Number(req.params.rid), req.user, session));
}));
app.patch('/api/docs/:id/requests/:rid', auth, wrap(async (req, res) => res.json(await service.patchRequest(req.params.id, req.params.rid, req.body || {}, req.user))));
app.post('/api/docs/:id/requests/:rid/cancel', auth, wrap(async (req, res) => res.json(await service.cancelRequest(req.params.id, req.params.rid, req.user))));
app.post('/api/docs/:id/requests/:rid/retry', auth, wrap(async (req, res) => res.json(await service.retryRequest(req.params.id, req.params.rid, req.user))));
app.post('/api/docs/:id/requests/:rid/recover', auth, wrap(async (req, res) => res.json(await service.recoverRequest(req.params.id, req.params.rid, req.user))));
// AI 작업 하나를 한 번에 정하기(V3 §9.5): { adopt?, apply?: pid[]|'rest', reject?: pid[]|'rest', cid? } → { request, results, counts, version, milestone }
app.post('/api/docs/:id/requests/:rid/resolve', auth, wrap(async (req, res) => res.json(await service.resolveRequest(req.params.id, req.params.rid, req.body || {}, req.user))));
app.post('/api/docs/:id/locks', auth, wrap(async (req, res) => res.json(await service.lock(req.params.id, req.body?.ref, req.user))));
app.delete('/api/docs/:id/locks', auth, wrap(async (req, res) => res.json({ ok: await service.unlock(req.params.id, req.query.ref, req.user) })));

// ── MCP (Streamable HTTP: 표준 세션 + 초기화 없는 옛 도구 호출) ──
// 주소: /mcp (Authorization: Bearer 토큰) · /mcp/t/<토큰> · /mcp/t/<토큰>/<에이전트이름> · ?agent=Claude
// HTTP 전송 세션과 작업 선점을 구분한다. OpenAI 호스트 작업 ID는 재연결에도 유지한다.
// 표준 세션은 요청 응답이 끝나도 유지하고 DELETE/30분 유휴/256개 상한에서 정리한다.
// 연결 종류(2026-11-17 사용자 결정 — server/mcp2.js mcpSurface): 밝히지 않으면 새 연결(작업 도구 넷, 'all'). 예전 연결은 X-Hwpx-Mcp: 1·?v=1·lean·
// config.mcp.defaultSurface 'v1' 일 때와, 밝히지 않는 옛 실행기·브리지(clientInfo 'hwpx-…')·세션 없는 한 번짜리 호출일 때. 세션은 initialize 때 정해 끝까지 쓴다.
const mcpSessions = new Map();
const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
const MCP_SESSION_MAX = 256;
function closeMcpSession(id) {
  const entry = mcpSessions.get(id);
  if (!entry) return;
  mcpSessions.delete(id);
  entry.server.close().catch((e) => console.error('[mcp] 세션 정리 실패:', e.message));
}
function sweepMcpSessions(now = Date.now()) {
  for (const [id, entry] of mcpSessions) if (now - entry.lastSeen >= MCP_SESSION_IDLE_MS) closeMcpSession(id);
}
const mcpSessionTimer = setInterval(sweepMcpSessions, 60000);
mcpSessionTimer.unref();
const mcpHttpError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
async function handleMcp(req, res, pathToken, pathAgent) {
  const sessionId = req.headers['mcp-session-id'];
  const suppliedToken = tokenFromRequest(req, pathToken);
  const oauthToken = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1].trim();
  const user = userByToken(cfg, suppliedToken) || await oauth.resolveUser(oauthToken);
  if (!user) {
    oauth.challenge(res);
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: '토큰이 올바르지 않습니다' }, id: null });
  }
  // 에이전트 세션 id(§2.2 선점): 브리지가 X-Hwpx-Agent-Session 머리글로 보낸다(영문·숫자·_- 64자 이하, SSE ?session= 과 같은 값).
  // initialize에서는 없으면 새 선점 ID를 만든다. 초기화 없는 옛 호출은 mcp.js의 기본값을 유지한다.
  const rawSession = req.headers['x-hwpx-agent-session'];
  const agentSession = rawSession == null || String(rawSession).trim() === '' ? null : String(rawSession).trim();
  if (agentSession != null && !/^[A-Za-z0-9_-]{1,64}$/.test(agentSession)) {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'X-Hwpx-Agent-Session 은 영문·숫자·_- 로 64자 이하여야 합니다' }, id: null });
  }
  const claimOwner = agentSession || openAiClaimSession(req.headers, user);
  if (isModernRequest(req)) {
    const principal = await oauth.eventPrincipal(oauthToken) || { user };
    // 2026-07-28 은 무상태 — 연결 종류를 요청마다 정한다(clientInfo 는 요청의 _meta 에 실린다)
    const surface = mcpSurface(req, { config: cfg, clientName: modernClientName(req.body) });
    return handleModernMcp({ req, res, user, principal, events: mcpEvents, service, version: pkg.version, agentName: agentFromRequest(req, pathAgent), agentSession: claimOwner, trackOperation, lean: isLeanRequest(req), surface, toolset: v2Toolset(req) });
  }
  if (!sessionId && req.method !== 'POST') return mcpHttpError(res, 405, -32000, 'Method not allowed (without MCP session: POST only)');
  sweepMcpSessions();
  if (sessionId) {
    const entry = mcpSessions.get(sessionId);
    // 다른 사용자 토큰으로 세션을 재사용할 수 없다. 존재 유무도 같은 404로 응답한다.
    if (!entry || entry.user !== user) return mcpHttpError(res, 404, -32001, 'Session not found');
    if (claimOwner && claimOwner !== entry.agentSession) return mcpHttpError(res, 400, -32602, 'Agent session does not match the initialized session');
    entry.lastSeen = Date.now();
    return entry.transport.handleRequest(req, res, req.body);
  }
  if (isInitializeRequest(req.body)) {
    while (mcpSessions.size >= MCP_SESSION_MAX) {
      const oldest = [...mcpSessions].reduce((a, b) => a[1].lastSeen <= b[1].lastSeen ? a : b);
      closeMcpSession(oldest[0]);
    }
    const id = crypto.randomUUID();
    const claimSession = claimOwner || crypto.randomUUID();
    // 연결 종류(새 연결 v2 | 예전 연결 — lean 이면 얇은 흐름, server/lean.js)는 initialize 때 정해 그 세션 내내 쓴다(server/mcp2.js mcpSurface).
    // clientInfo 이름이 'hwpx-' 인 옛 실행기·브리지는 밝히지 않으면 예전 연결이다(업데이트하지 않은 참여자 PC 가 대기열 도구를 잃지 않게)
    const surface = mcpSurface(req, { config: cfg, clientName: req.body?.params?.clientInfo?.name });
    const server = createMcpServer({ service, user, version: pkg.version, agentName: agentFromRequest(req, pathAgent), agentSession: claimSession, trackOperation, lean: isLeanRequest(req), surface, toolset: v2Toolset(req) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessionclosed: () => { mcpSessions.delete(id); },
    });
    transport.onclose = () => { mcpSessions.delete(id); };
    // 첫 await 전에 자리를 잡는다 — 동시 initialize에서도 상한을 넘지 않게.
    mcpSessions.set(id, { server, transport, user, agentSession: claimSession, lastSeen: Date.now() });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (!transport.sessionId) closeMcpSession(id); // 초기화 검증에 실패한 연결은 남기지 않는다.
    } catch (e) { closeMcpSession(id); throw e; }
    return;
  }
  // initialize 없는 기존 단발 tools/call은 응답이 닫히면 정리한다.
  // 이 길은 예전 도구를 이름으로 부르는 스크립트용 옛 길이라(표준 MCP 클라이언트는 initialize 한다) 밝히지 않으면 예전 연결이다 — 새 연결은 X-Hwpx-Mcp: 2·?v=2
  const surface = mcpSurface(req, { config: cfg, legacyCall: true });
  const server = createMcpServer({ service, user, version: pkg.version, agentName: agentFromRequest(req, pathAgent), agentSession: claimOwner, trackOperation, lean: isLeanRequest(req), surface, toolset: v2Toolset(req) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
const mcpErr = (res) => (e) => { console.error(e); if (!res.headersSent) res.status(500).end(); };
// GET SSE는 연결이 닫힐 때까지 SDK가 기다린다. 작업 drain에는 도구 실행만 포함하고
// 수신 스트림 자체는 마지막 전송 정리 단계에서 닫아 순환 대기를 피한다.
const recordedMcpHttp = (req, res, handle) => req.method !== 'POST' ? handle() : withAiDebug({
    directory: path.join(cfg.dataDir, 'runtime', 'ai-debug'),
    context: { route: req.path.startsWith(ADMIN_MCP_PATH) ? 'admin-mcp-http' : 'mcp-http', rpcId: req.body?.id, tool: req.body?.params?.name,
      docId: req.body?.params?.arguments?.doc_id, requestId: req.body?.params?.arguments?.request_id, attempt: req.body?.params?.arguments?.expected_attempt },
    state: () => debugServiceState(service, req.body?.params?.arguments),
  }, async () => {
    debugRecord('http.mcp.body', req.aiDebugRaw ?? req.body);
    const trace = currentAiDebug(), json = res.json.bind(res);
    res.json = value => { trace.record('http.mcp.result', value, { status: res.statusCode }); return json(value); };
    await handle();
    debugRecord('http.mcp.finished', { status: res.statusCode });
  });
const mcpRoute = (req, res) => {
  const run = () => recordedMcpHttp(req, res, () => handleMcp(req, res, req.params.token, req.params.agent));
  return (req.method === 'GET' ? run() : trackOperation(run)).catch(mcpErr(res));
};
const adminMcp = createAdminMcp({ service, config: cfg, oauth, events: mcpEvents, version: pkg.version, trackOperation });
const adminMcpRoute = (req, res) => {
  const run = () => recordedMcpHttp(req, res, () => adminMcp.handle(req, res));
  return (req.method === 'GET' ? run() : trackOperation(run)).catch(mcpErr(res));
};
app.all(ADMIN_MCP_PATH, adminMcpRoute);
app.all(`${ADMIN_MCP_PATH}/full`, adminMcpRoute);
app.get('/api/admin/mcp-test', auth, wrap(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ADMIN_REQUIRED' });
  res.set('Cache-Control', 'no-store').json(adminMcp.status(req.user));
}));
app.all('/mcp', mcpRoute);
app.all('/mcp/t/:token', mcpRoute);
app.all('/mcp/t/:token/:agent', mcpRoute);

// ── 정적 파일 ──
// .wasm 은 언제나 application/wasm(스트리밍 컴파일), .html 은 늘 새로 확인(no-cache)
function staticHeaders(res, file) {
  if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
  if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
}
// 편집기(rhwp-studio 자체 빌드, §1.1): 이름에 해시가 든 assets/ 는 1년 불변 캐시(다시 빌드하면 이름이 바뀌어 새로 받는다),
// 글꼴(fonts/, 이름에 해시 없음)은 30일, 나머지(index.html·init 스크립트·cowork-build.json)는 늘 새로 확인(no-cache).
// js·css·wasm 등은 compressedStatic 이 br/gzip 으로 보낸다. 빌드가 없으면 503 + 안내
const STUDIO_MISSING = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>편집기 빌드 필요</title></head>'
  + '<body style="font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.6"><h1>편집기(rhwp-studio)가 아직 빌드되지 않았습니다</h1>'
  + '<p>서버 폴더에서 <code>npm run build:studio</code> 를 먼저 실행하세요. 빌드가 끝나면 이 페이지를 새로 고치면 됩니다(서버를 다시 켤 필요 없음).</p></body></html>';
const studioAssets = path.join(cfg.studioDir, 'assets') + path.sep;
const studioFonts = path.join(cfg.studioDir, 'fonts') + path.sep;
function studioHeaders(res, file) {
  staticHeaders(res, file);
  res.setHeader('Cache-Control', file.startsWith(studioAssets) ? 'public, max-age=31536000, immutable'
    : file.startsWith(studioFonts) ? 'public, max-age=2592000' : 'no-cache');
}
const studioCompressed = compressedStatic(cfg.studioDir, { setHeaders: studioHeaders });
const studioStatic = express.static(cfg.studioDir, { setHeaders: studioHeaders });
app.use('/studio', (req, res, next) => {
  if (!fs.existsSync(path.join(cfg.studioDir, 'index.html'))) return res.status(503).set('Cache-Control', 'no-store').type('html').send(STUDIO_MISSING);
  studioCompressed(req, res, () => studioStatic(req, res, next));
});
app.use('/studio', (req, res) => res.status(404).type('text/plain').send('Not found'));
// rhwp 는 고정 스냅샷(vendor/rhwp, v0.8.7)에서 내보낸다(node_modules/@rhwp 에 기대지 않음)
function staticDir(dir, opts = {}) {
  return [compressedStatic(dir, opts), express.static(dir, opts)];
}
app.use('/vendor/rhwp-editor', staticDir(path.join(root, 'vendor/rhwp/npm/editor'), { setHeaders: staticHeaders }));
app.use('/vendor/rhwp-core', staticDir(cfg.enginePkgDir, { setHeaders: staticHeaders }));
app.use('/vendor/vue.esm-browser.prod.js', express.static(path.join(root, 'node_modules/vue/dist/vue.esm-browser.prod.js')));
// 소개 화면(web/teaser·teaser3)이 빠진 배포 묶음에서는
// 첫 방문 이동(web/intro.js)과 '소개 영상' 링크는 next 주소(같은 사이트 경로만)로 바로 넘긴다
for (const intro of ['teaser', 'teaser3']) {
  if (fs.existsSync(path.join(root, 'web', intro, 'index.html'))) continue;
  app.get([`/${intro}`, `/${intro}/`, `/${intro}/index.html`], (req, res) => {
    const raw = typeof req.query.next === 'string' ? req.query.next : '/';
    const url = new URL(/^\/(?![/\\])/.test(raw) && !/[\\\x00-\x20]/.test(raw) ? raw : '/', 'http://local.invalid');
    url.searchParams.set('teaser', '0');
    res.set('Cache-Control', 'no-store').redirect(302, `${url.pathname}${url.search}`);
  });
}
app.use('/', staticDir(path.join(root, 'web')));

// ── 본문 해석 오류(크기 초과 등)는 JSON 으로 ──
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.aiDebugRaw) {
    try { createAiDebug({ directory: path.join(cfg.dataDir, 'runtime', 'ai-debug'), context: { route: 'mcp-http', stage: 'body-parser' } })
      .record('http.mcp.rejected', req.aiDebugRaw, { error: debugError(err) }); }
    catch (loggingError) { return res.status(500).json({ error: loggingError.code, message: loggingError.message }); }
  }
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: `파일·본문이 너무 큽니다(최대 ${Math.round((err.limit || cfg.attachments.maxBytes) / 1048576)}MB)` });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: 'JSON 본문을 읽지 못했습니다' });
  console.error(err);
  res.status(err?.status || 500).json({ error: 'internal', message: err?.message || String(err) });
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  if (draining) { socket.destroy(); return; }
  let u; try { u = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
  if (u.pathname !== '/ws') { socket.destroy(); return; }
  const user = userByToken(cfg, u.searchParams.get('token')); const docId = u.searchParams.get('doc');
  let meta = null; try { meta = docId ? store.readMeta(docId) : null; } catch { meta = null; }
  if (!user || !meta || !service.canRead(user, meta)) { socket.destroy(); return; }
  hub.wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, { docId, user }));
});
server.on('error', (e) => {
  runtimeJournal.write('http-server-error', { code: e.code, message: e.message });
  console.error(e.code === 'EADDRINUSE' ? `[hwpx-cowork] 포트 ${cfg.port} 를 이미 쓰고 있습니다(${cfg.host}). 다른 서버를 끄거나 HWPX_COWORK_PORT 를 바꾸세요.` : `[hwpx-cowork] 서버 오류: ${e.message}`);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  if (cfg.port === 0) {
    // 시험 받침(§6.0): 빈 포트로 띄우면 실제 포트를 stdout 첫 줄에, 이 프로세스 표식(nonce)을 둘째 줄에 알린다
    cfg.port = server.address().port;
    if (cfg.publicUrlAuto) cfg.publicUrl = `http://localhost:${cfg.port}`;
    console.log(`LISTENING ${cfg.port}`);
    console.log(`NONCE ${NONCE}`);
  }
  restartControl.markReady({ host: cfg.host, port: cfg.port, nonce: NONCE, publicUrl: cfg.publicUrl });
  console.log(`[hwpx-cowork ${pkg.version}] http://${cfg.host}:${cfg.port}  (publicUrl ${cfg.publicUrl})`);
  console.log(`  MCP endpoint: ${cfg.publicUrl}/mcp  (Authorization: Bearer <token>)  또는 ${cfg.publicUrl}/mcp/t/<token>`);
  console.log(`  서버 AI: ${ai.enabled ? (ai.mock ? '모의 AI' : '켜짐 (' + ai.agentName + ' · ' + cfg.ai.model + ')') : '꺼짐 — ' + ai.reason}`);
  console.log(`  사용자 ${cfg.users.length}명, 문서 ${store.list().length}건, 데이터 ${cfg.dataDir}`);
  const st = studioInfo();
  if (st.mode === 'remote') console.log(`  편집기: ${cfg.studioUrl} (studio.mode=remote — cowork 플러그인 없음, 편집기 안 검토 기능은 꺼짐)`);
  else {
    console.log(st.built ? `  편집기: /studio/ (${cfg.studioDir}${st.buildInfo?.builtAt ? `, 빌드 ${st.buildInfo.builtAt}` : ''})` : '  편집기: 빌드가 없습니다 — npm run build:studio 를 먼저 실행하세요(그때까지 /studio/ 는 503)');
    if (cfg.studioUrlSet && /^https?:/i.test(cfg.studioUrl)) console.log(`  config.studioUrl(${cfg.studioUrl}) 은 쓰지 않습니다 — studio.mode=local 이라 /studio/ 를 씁니다(remote 일 때만 씀)`);
  }
  if (service.local) {
    const links = service.local.links();
    console.log(`  PC 폴더 연결: 켜짐 — ${links.length ? links.map((l) => l.path).join(', ') : '연결한 폴더 없음(문서함의 [PC 폴더 연결])'}`);
    service.local.scan().catch(() => {});   // 지난 실행에서 못 쓴 기록·그사이 밖에서 바뀐 파일을 맞춘다
  }
  if (cfg.configFile !== path.join(root, 'config.json')) console.log(`  설정 파일: ${cfg.configFile}`);
  // 이전 manuals.seed 설정과의 호환. 설명서는 이제 튜토리얼 메뉴에서 시작하므로 미리 배포하지 않는다.
  seedManualsOnce({ cfg, root, port: cfg.port, log: (m) => console.log(`  사용 설명서: ${m}`) })
    .catch((e) => console.error(`  사용 설명서를 넣지 못했습니다: ${e.message}`));
});

async function prepareShutdown({ reason = 'restart' } = {}) {
  runtimeJournal.write('drain-start', { reason, requests: activeRequests.size, operations: activeOperations.size, queues: store.queues.size });
  // 다른 편집기에도 마지막 자동 저장 기회를 준 뒤 새 쓰기 요청을 닫는다.
  hub.broadcastAll({ type: 'server', action: 'restarting', reason, delayMs: 1200 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  draining = true;
  await clipboardBridge.stop();
  await mcpEvents.close();
  for (;;) {
    // PC 폴더 문서: 아직 PC 파일에 쓰지 않은 기록을 지금 쓴다(문서 큐를 거친다 — 아래에서 함께 기다린다)
    if (service.local) await service.local.flush().catch((e) => console.error('[PC 폴더] 끄기 전 저장:', e.message));
    const pending = [...activeRequests, ...activeOperations, ...store.queues.values()];
    if (pending.length) await Promise.allSettled(pending);
    await new Promise((resolve) => setImmediate(resolve));
    if (!activeRequests.size && !activeOperations.size && !store.queues.size) break;
  }
  runtimeJournal.write('drain-work-complete', { reason });
  clearInterval(mcpSessionTimer);
  await adminMcp.close();
  routeCtx.agents?.closeAll();
  // 긴 SSE·MCP·WS 연결은 저장이 끝난 다음 정리한다.
  const sessions = [...mcpSessions.values()]; mcpSessions.clear();
  await Promise.race([
    Promise.allSettled(sessions.map((entry) => entry.server.close())),
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]);
  for (const ws of hub.wss.clients) ws.close(1001, 'Server restart');
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  const forceTransports = setTimeout(() => {
    for (const ws of hub.wss.clients) ws.terminate();
    server.closeAllConnections?.();
  }, 800);
  await closed;
  clearTimeout(forceTransports);
  hub.wss.close();
  runtimeJournal.write('drain-complete', { reason });
}
