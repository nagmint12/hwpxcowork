import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** 응답 크기 한도 기본값과 범위(글자) */
export const LIMIT_DEFAULTS = Object.freeze({ mcpResponseChars: 40000 });
export const LIMIT_RANGE = Object.freeze({ mcpResponseChars: [5000, 1000000] });
export function clampLimit(v, [min, max] = LIMIT_RANGE.mcpResponseChars) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : LIMIT_DEFAULTS.mcpResponseChars;
}

/**
 * 설정 읽기. 환경 변수(모두 선택):
 *   HWPX_COWORK_CONFIG       다른 config 파일 경로(시험·체험용 임시 config). 주면 그 파일이 꼭 있어야 한다 —
 *                            없으면 오류(새로 만들지 않는다). 그 파일 안의 상대 경로(dataDir)는 그 파일이 있는 폴더 기준.
 *   HWPX_COWORK_DATA_DIR     데이터 폴더(config.dataDir 대신)
 *   HWPX_COWORK_HOST·_PORT   듣는 주소·포트. PORT=0 이면 빈 포트 — 서버가 stdout 첫 줄에 'LISTENING <port>'
 *   HWPX_COWORK_STUDIO_DIR   편집기(rhwp-studio) 빌드 폴더(studio/dist 대신)
 *   HWPX_COWORK_ENGINE_PKG   서버 차례·/vendor/rhwp-core에 쓸 별도 엔진 패키지
 *   HWPX_COWORK_AI_MOCK=1    모의 AI
 *   HWPX_COWORK_AI=off       서버 AI 강제 끔
 *   HWPX_COWORK_AI_PROVIDER·_MODEL·_GATEWAY·_BASE_URL·_EFFORT  서버 AI 제공자·모델·연결 방식(direct|baze)·API 주소·추론 강도
 *   HWPX_COWORK_ATTACH_MAX_BYTES  첨부 한도(시험용)
 *   HWPX_COWORK_LOCAL=1      PC 폴더 연결 켜기(config.local.enabled 대신 — 개인용 앱), HWPX_COWORK_LOCAL_TRASH 지운 PC 파일을 옮길 폴더(시험용)
 */
export function loadConfig(root) {
  const alt = process.env.HWPX_COWORK_CONFIG;
  let file;
  if (alt) {
    file = path.resolve(root, alt);
    if (!fs.existsSync(file)) throw new Error(`HWPX_COWORK_CONFIG 의 config 파일이 없습니다: ${file} (자동으로 만들지 않습니다)`);
  } else {
    file = path.join(root, 'config.json');
    if (!fs.existsSync(file)) fs.copyFileSync(path.join(root, 'config.example.json'), file);
  }
  let cfg;
  try {
    const text = fs.readFileSync(file, 'utf-8');
    cfg = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);   // 메모장이 붙인 BOM 은 건너뛴다
  } catch (e) { throw new Error(`config 파일을 읽지 못했습니다: ${file} — ${e.message}`); }
  cfg.root = root;
  cfg.configFile = file;
  cfg.dataDir = process.env.HWPX_COWORK_DATA_DIR ? path.resolve(root, process.env.HWPX_COWORK_DATA_DIR) : path.resolve(path.dirname(file), cfg.dataDir || 'data');
  cfg.host = process.env.HWPX_COWORK_HOST || cfg.host || '127.0.0.1';
  cfg.port = Number(process.env.HWPX_COWORK_PORT || (cfg.port ?? 8787));
  // publicUrl 을 적지 않았으면 포트에서 만든다(포트 0 이면 서버가 듣기 시작한 뒤 실제 포트로 다시 만든다)
  cfg.publicUrlAuto = !cfg.publicUrl;
  if (process.env.HWPX_COWORK_PUBLIC_URL) { cfg.publicUrl = process.env.HWPX_COWORK_PUBLIC_URL; cfg.publicUrlAuto = false; }
  cfg.publicUrl = (cfg.publicUrl || `http://localhost:${cfg.port}`).replace(/\/$/, '');
  // 편집기: local(기본) = 서버가 /studio/ 로 내보내는 자체 빌드(cowork 플러그인 포함), remote = studioUrl(플러그인 없음)
  cfg.studio = { mode: 'local', ...obj(cfg.studio) };
  if (cfg.studio.mode !== 'remote') cfg.studio.mode = 'local';
  cfg.studioDir = path.resolve(root, process.env.HWPX_COWORK_STUDIO_DIR || path.join('studio', 'dist'));
  cfg.enginePkgDir = path.resolve(root, process.env.HWPX_COWORK_ENGINE_PKG || path.join('vendor', 'rhwp', 'pkg'));
  cfg.studioUrlSet = typeof cfg.studioUrl === 'string' && cfg.studioUrl.trim() !== '';   // 파일에 적혀 있었는지(local 이면 무시한다고 알림)
  cfg.studioUrl = cfg.studioUrlSet ? cfg.studioUrl.trim() : 'https://edwardkim.github.io/rhwp/';
  cfg.allowAgentApply = cfg.allowAgentApply !== false;
  cfg.users = (cfg.users || []).map((u) => ({ role: 'editor', ...u }));
  const aiSection = obj(cfg.ai);
  const provider = process.env.HWPX_COWORK_AI_PROVIDER || aiSection.provider || 'anthropic';
  const anthropic = ['anthropic', 'claude'].includes(provider);
  // effort 기본(medium)은 Claude 만 — OpenAI·Gemini 는 적었을 때만 보낸다(추론이 없는 모델은 reasoning 을 거절한다)
  cfg.ai = { enabled: false, provider, keyFile: anthropic ? '~/.needs/anthropic_api_key.txt' : null, model: anthropic ? 'claude-opus-5-5' : null, effort: anthropic ? 'medium' : null, maxProposals: 10, ...aiSection, provider };
  if (process.env.HWPX_COWORK_AI_MODEL) cfg.ai.model = process.env.HWPX_COWORK_AI_MODEL;
  // API 연결 방식(direct·baze)·기본 주소·추론 강도 — server/ai.js AI_GATEWAYS
  if (process.env.HWPX_COWORK_AI_GATEWAY) cfg.ai.gateway = process.env.HWPX_COWORK_AI_GATEWAY;
  if (process.env.HWPX_COWORK_AI_BASE_URL) cfg.ai.baseUrl = process.env.HWPX_COWORK_AI_BASE_URL;
  if (process.env.HWPX_COWORK_AI_EFFORT) cfg.ai.effort = process.env.HWPX_COWORK_AI_EFFORT;
  // 서버 AI 우선순위(앞이 이긴다): HWPX_COWORK_AI=off(강제 끔: enabled·mock 모두 false) > HWPX_COWORK_AI_MOCK=1(모의)
  //   > config.ai.mock > config.ai.enabled(+키 파일). 시험 받침은 AI 를 끌 때 off 를 써서, 밖에서 받은 MOCK=1 이 있어도 꺼지게 한다.
  if (process.env.HWPX_COWORK_AI_MOCK === '1') cfg.ai.mock = true;
  if (/^(off|0|false)$/i.test(String(process.env.HWPX_COWORK_AI || '').trim())) { cfg.ai.enabled = false; cfg.ai.mock = false; cfg.ai.forcedOff = true; }
  cfg.attachments = { maxBytes: 52428800, maxTextChars: 200000, maxPerDoc: 100, ...(cfg.attachments || {}) };
  // 시험용: 첨부 한도를 config.json 을 고치지 않고 낮춘다(413 경로 확인)
  if (Number(process.env.HWPX_COWORK_ATTACH_MAX_BYTES) > 0) cfg.attachments.maxBytes = Number(process.env.HWPX_COWORK_ATTACH_MAX_BYTES);
  if (cfg.ai.keyFile) cfg.ai.keyFile = cfg.ai.keyFile.replace(/^~(?=$|[\\/])/, os.homedir());
  // AI 에 보내는 응답 크기(관리자 → 서버 설정에서 바꿈): MCP 도구 한 번의 응답 글자 수 한도.
  // Claude Code 는 MCP 도구 결과가 2만 5천 토큰(MAX_MCP_OUTPUT_TOKENS 기본)을 넘으면 대화에 싣지 않고 파일로 돌린다 — 한글이 섞인 JSON 은 대략 2자 = 1토큰
  cfg.limits = { ...LIMIT_DEFAULTS, ...obj(cfg.limits) };
  cfg.limits.mcpResponseChars = clampLimit(cfg.limits.mcpResponseChars);
  // 개인 에이전트(§2.2): 요청 선점 lease(분), 요청자·관리자 아닌 사람도 맡을 수 있는지
  cfg.agents = { leaseMinutes: 15, othersCanTake: false, ...obj(cfg.agents) };
  cfg.agents.leaseMinutes = Number(cfg.agents.leaseMinutes) > 0 ? Number(cfg.agents.leaseMinutes) : 15;
  cfg.agents.othersCanTake = cfg.agents.othersCanTake === true;
  // PC 폴더 연결(server/local-folders.js — 개인용 앱): 서버 PC 의 폴더를 관리자의 개인 문서함에 비춘다. 기본 끔(중앙 서버에서는 켜지 않는다).
  // HWPX_COWORK_LOCAL=1 로도 켠다. writeDelayMs = 고친 뒤 PC 파일에 쓰기까지 모으는 시간, trash = 'recycle'(Windows 휴지통, 기본)|'folder'(<dataDir>/local-trash)
  cfg.local = { enabled: false, ...obj(cfg.local) };
  cfg.local.enabled = cfg.local.enabled === true || process.env.HWPX_COWORK_LOCAL === '1';
  // 변경 요청(§3.3): 작성자가 반영하려면 다른 사람 승인이 몇 개 필요한지(0 이면 승인 없이)
  const crSection = cfg.changeRequests && typeof cfg.changeRequests === 'object' && !Array.isArray(cfg.changeRequests);
  cfg.changeRequests = { requireApprovals: 1, ...obj(cfg.changeRequests) };
  const ra = Number(cfg.changeRequests.requireApprovals);
  cfg.changeRequests.requireApprovals = Number.isInteger(ra) && ra >= 0 ? ra : 1;
  // 제안 '기준에 바로 적용'(REST apply·applyNow, §5.1): false(기본)면 관리자만 — 편집자는 '내 수정본에 반영' 뒤 변경 요청으로.
  // changeRequests 구역이 아예 없는 config(v0.2 때 만든 파일)는 v0.2 처럼 누구나(true) — v0.2 계약(api_v2·api_smoke)을 그대로 지킨다.
  // 그때 directApplyLegacy = true(서버가 시작할 때 한 줄 알림). MCP apply_proposal 은 따로 allowAgentApply 를 본다
  const da = cfg.changeRequests.allowDirectApply;
  cfg.changeRequests.directApplyLegacy = !crSection && typeof da !== 'boolean';
  cfg.changeRequests.allowDirectApply = typeof da === 'boolean' ? da : cfg.changeRequests.directApplyLegacy;
  return cfg;
}

/**
 * 공용 서버 AI(config.ai — 서버에 둔 API 키)를 계정별로 제한하는가(2026-11-10).
 * config.ai.restrictUsers 가 true·false 면 그대로, 없으면 서버 AI 가 실제 API 키를 들고 있을 때만 제한한다 —
 * 키가 든 연결은 쓰는 만큼 돈이 나가고, 모의 AI·키 없는 로컬 모델(noAuth)은 비용이 없다.
 * @param ai AiProposer(server/ai.js) — key 가 있으면 실제 키
 */
export function serverAiRestricted(cfg, ai) {
  const v = cfg?.ai?.restrictUsers;
  return typeof v === 'boolean' ? v : !!(ai && ai.key && !ai.mock);
}

/** 이 사람이 공용 서버 AI 를 쓸 수 있는가: 제한하지 않으면 누구나, 제한하면 users[].serverAi === true 인 계정만(관리자도 같다) */
export function serverAiAllowed(cfg, ai, name) {
  if (!serverAiRestricted(cfg, ai)) return true;
  return !!name && !!cfg?.users?.some((u) => u.name === name && u.serverAi === true);
}

export function userByToken(cfg, token) {
  if (!token) return null;
  return cfg.users.find((u) => u.token && u.token === token) || null;
}

/** 요청에서 토큰을 찾는다: Authorization: Bearer, ?token=, 경로 /t/<token> */
export function tokenFromRequest(req, pathToken) {
  if (pathToken) return pathToken;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const x = req.headers['x-api-key']; if (x) return String(x);
  try { const u = new URL(req.url, 'http://x'); const q = u.searchParams.get('token'); if (q) return q; } catch { /* ignore */ }
  return null;
}
