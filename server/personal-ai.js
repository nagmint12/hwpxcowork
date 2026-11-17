// 개인 AI 키(서버 보관): 참여자가 웹에서 자기 API 키(API(gateway 'baze')·OpenAI·Claude·Gemini)와 모델을 한 번 넣으면,
// 그 사람의 AI 요청을 서버가 그 사람 키로 처리한다(참여자 PC 에는 설치·실행할 것이 없다). 비용은 그 사람 키에 붙는다.
//   저장: <dataDir>/personal-ai.json — 키는 AES-256-GCM 암호문(사용자 이름을 AAD 로 묶어 다른 사람 칸으로 옮겨도 풀리지 않음)
//   암호 열쇠: config 파일 옆 .hwpx-cowork-secret(데이터 폴더만 복사·백업해서는 키가 풀리지 않게). 열쇠 파일을 잃으면 각자 키를 다시 넣는다
//   API 는 키를 다시 돌려주지 않는다(끝 4자리만). local 연결은 서버 PC의 loopback 주소만 받고,
//   direct·baze는 기존 고정 주소를 쓴다. 다른 연결의 비밀 키를 로컬 주소로 가져오지 않는다.
//   config.ai.personal=false 면 끔. 모의 AI(HWPX_COWORK_AI_MOCK)·HWPX_COWORK_AI=off 일 때는 개인 키로 실제 API 를 부르지 않는다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AiProposer, AI_EFFORTS, apiBaseUrl } from './ai.js';
import { ServiceError } from './service.js';
import { writeFileAtomic } from './store.js';

const PROVIDERS = ['openai', 'anthropic', 'gemini'];
const GATEWAYS = ['direct', 'baze', 'local'];
const LOCAL_KEY = 'local-no-auth';
function localBaseUrl(raw) {
  let base;
  try { base = apiBaseUrl(raw || 'http://localhost:1234/v1'); } catch { throw bad('로컬 API 주소를 확인하세요(예: http://localhost:1234/v1)'); }
  if (!base || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw bad('로컬 API 주소는 서버 PC의 localhost·127.0.0.1·[::1]만 사용할 수 있습니다');
  return base;
}
const ALIASES = { claude: 'anthropic', chatgpt: 'openai', google: 'gemini' };
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
// Claude API 워크스페이스 ID: 계정·서비스 계정 연결형 키(sk-ant-usr-·sk-ant-svc…)는 요청마다 anthropic-workspace-id 머리글이 있어야 한다(2026-11-10)
export const ANTHROPIC_WORKSPACE_RE = /^wrkspc_[A-Za-z0-9]{8,64}$/;
const bad = (message) => new ServiceError('BAD_PERSONAL_AI', message, 400);

export function createPersonalAi({ config, fetchImpl = null, secretFile = null, log = (message) => console.error(message) }) {
  const file = path.join(config.dataDir, 'personal-ai.json');
  const keyPath = secretFile || path.join(path.dirname(config.configFile || path.join(config.root || process.cwd(), 'config.json')), '.hwpx-cowork-secret');
  let state = null; let master = null;
  const cache = new Map();   // 이름 → { updatedAt, ai }
  const creditCache = new Map();   // 이름 → { at, updatedAt, value } — 잔액 조회(credits)

  // 로컬 AI(서버 PC 의 localhost 주소)는 관리자 계정만(2026-11-12 보안 점검): 다른 계정이 서버 PC 안의 다른 서비스
  // (127.0.0.1 의 임의 포트·경로)로 서버가 대신 요청을 보내게 해 응답을 엿보거나 조작하지 못하게 한다. 개인용 앱의 계정은 관리자다.
  // (사용자 목록이 없는 단위 시험 설정에서는 저장 때 넘긴 계정의 역할로만 본다)
  const localAllowed = (name) => !Array.isArray(config.users) || config.users.some((u) => u.name === name && u.role === 'admin');

  /** 기능이 켜져 있는지(꺼져 있으면 저장은 되지만 요청 처리에 쓰지 않는다) */
  function active() { return config.ai?.personal !== false && !config.ai?.mock && !config.ai?.forcedOff; }

  function data() {
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) {
        if (e.code !== 'ENOENT') throw new ServiceError('PERSONAL_AI_STORAGE', '개인 AI 설정 파일을 읽지 못했습니다(관리자에게 알리세요)', 500);
        state = { version: 1, users: {} };
      }
      if (state.version !== 1 || !state.users || typeof state.users !== 'object') throw new ServiceError('PERSONAL_AI_STORAGE', '개인 AI 설정 파일 형식이 올바르지 않습니다(관리자에게 알리세요)', 500);
    }
    return state;
  }
  function save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(data(), null, 1));
    try { fs.chmodSync(file, 0o600); } catch { /* Windows 는 사용자 폴더 권한을 따른다 */ }
  }

  function masterKey() {
    if (master) return master;
    for (let attempt = 0; attempt < 2 && !master; attempt++) {
      try {
        const bytes = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
        if (bytes.length !== 32) throw new ServiceError('PERSONAL_AI_SECRET', '개인 AI 암호 열쇠 파일이 손상되었습니다(관리자에게 알리세요)', 500);
        master = bytes;
      } catch (e) {
        if (e instanceof ServiceError) throw e;
        if (e.code !== 'ENOENT') throw new ServiceError('PERSONAL_AI_SECRET', '개인 AI 암호 열쇠 파일을 읽지 못했습니다(관리자에게 알리세요)', 500);
        // 처음: 새 열쇠. 이미 있는 파일은 덮어쓰지 않는다(wx) — 동시에 만들었으면 다시 읽는다
        try { fs.writeFileSync(keyPath, `${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' }); }
        catch (w) { if (w.code !== 'EEXIST') throw new ServiceError('PERSONAL_AI_SECRET', '개인 AI 암호 열쇠 파일을 만들지 못했습니다(관리자에게 알리세요)', 500); }
      }
    }
    return master;
  }
  const aad = (name) => Buffer.from(`hwpx-personal-ai:${name}`, 'utf8');
  function seal(text, name) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv); cipher.setAAD(aad(name));
    const box = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), data: box.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }
  function unseal(box, name) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(box.iv, 'base64'));
    decipher.setAAD(aad(name)); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
  }

  function view(entry) {
    if (!entry) return { configured: false, active: false, available: active() };
    return { configured: true, active: active(), available: active(), provider: entry.provider, gateway: entry.gateway, ...(entry.gateway === 'local' ? { baseUrl: entry.baseUrl } : {}), model: entry.model, effort: entry.effort || null, workspace: entry.workspace || 'mcp', ...(entry.anthropicWorkspaceId ? { anthropicWorkspaceId: entry.anthropicWorkspaceId } : {}), keyHint: entry.keyHint, updatedAt: entry.updatedAt, lastCheck: entry.lastCheck || null };
  }

  function normalize(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('설정 값이 올바르지 않습니다');
    const provider = ALIASES[input.provider] || input.provider;
    if (!PROVIDERS.includes(provider)) throw bad('제공자는 openai·anthropic·gemini 중 하나입니다');
    const gateway = String(input.gateway || 'direct').trim().toLowerCase();
    if (!GATEWAYS.includes(gateway)) throw bad('연결 방식은 direct(제공자에 직접)·baze(API)·local(로컬 API) 중 하나입니다');
    if (gateway === 'local' && provider !== 'openai') throw bad('로컬 AI는 OpenAI 호환 API로 연결하세요');
    const baseUrl = gateway === 'local' ? localBaseUrl(input.baseUrl ?? (previous?.gateway === 'local' ? previous.baseUrl : null)) : null;
    const model = String(input.model ?? '').trim();
    if (!MODEL_RE.test(model)) throw bad('모델 ID를 확인하세요(공백·특수 문자 없이)');
    const effort = input.effort == null || input.effort === '' ? null : String(input.effort).trim().toLowerCase();
    if (effort && !AI_EFFORTS.includes(effort)) throw bad(`추론 강도는 ${AI_EFFORTS.join('·')} 중 하나입니다`);
    const workspace = input.workspace || (gateway === 'local' ? 'mcp' : previous?.workspace || 'mcp');
    if (!['mcp', 'hosted'].includes(workspace) || (workspace === 'hosted' && provider !== 'openai')) throw bad('API 작업공간은 mcp 또는 hosted(OpenAI 호환 API)로 지정하세요');
    if (gateway === 'local' && workspace !== 'mcp') throw bad('로컬 AI는 문서 도구(mcp) 작업공간을 사용하세요');
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key && (key.length < 8 || key.length > 512 || /[\s\0]/.test(key))) throw bad('API 키 형식을 확인하세요');
    if (!key && !previous && gateway !== 'local') throw bad('API 키를 넣어 주세요');
    // 키를 그대로 두고 보낼 곳을 바꾸면 그 키가 다른 회사로 간다 — API(baze) 안에서 제공자만 바꿀 때 말고는 키를 다시 받는다
    const sameDestination = previous && (previous.gateway === 'baze' ? gateway === 'baze' : gateway === previous.gateway && provider === previous.provider && (gateway !== 'local' || baseUrl === previous.baseUrl));
    if (!key && !sameDestination && gateway !== 'local') throw bad('연결 방식이나 제공자를 바꾸면 API 키를 다시 넣어 주세요');
    // 로컬 무인증 연결은 별도 값으로 저장한다. 다른 제공자·주소의 기존 비밀 키를 가져오지 않는다.
    const noAuth = gateway === 'local' && !key && (!sameDestination || previous.noAuth);
    // Claude 직접 연결만: 워크스페이스 ID(비우면 없음, 안 보내면 이전 값 유지)
    let anthropicWorkspaceId = null;
    if (provider === 'anthropic' && gateway === 'direct') {
      const raw = input.anthropicWorkspaceId === undefined ? (sameDestination ? previous?.anthropicWorkspaceId : null) : input.anthropicWorkspaceId;
      anthropicWorkspaceId = raw == null ? null : String(raw).trim() || null;
      if (anthropicWorkspaceId && !ANTHROPIC_WORKSPACE_RE.test(anthropicWorkspaceId)) throw bad('워크스페이스 ID는 wrkspc_ 로 시작합니다(Console → Settings → Workspaces)');
    }
    return { provider, gateway, baseUrl, model, effort, workspace, anthropicWorkspaceId, key: noAuth ? LOCAL_KEY : key, noAuth };
  }

  function entryOf(user) { return data().users[user.name] || null; }

  return {
    active,
    status(user) { return view(entryOf(user)); },

    save(user, input) {
      const previous = entryOf(user);
      const wantsLocal = String(input?.gateway || '').trim().toLowerCase() === 'local';
      if (wantsLocal && !(user?.role === 'admin' && localAllowed(user.name))) throw new ServiceError('LOCAL_AI_ADMIN_ONLY', '로컬 AI(서버 PC 의 주소)는 관리자만 등록할 수 있습니다', 403);
      const next = normalize(input, previous);
      const entry = {
        provider: next.provider, gateway: next.gateway, ...(next.baseUrl ? { baseUrl: next.baseUrl, noAuth: next.noAuth } : {}), model: next.model, effort: next.effort, workspace: next.workspace, ...(next.anthropicWorkspaceId ? { anthropicWorkspaceId: next.anthropicWorkspaceId } : {}),
        secret: next.key ? seal(next.key, user.name) : previous.secret,
        keyHint: next.noAuth ? null : next.key ? `…${next.key.slice(-4)}` : previous.keyHint,
        updatedAt: new Date().toISOString(), lastCheck: null,
      };
      data().users[user.name] = entry; save(); cache.delete(user.name);
      return view(entry);
    },

    remove(user) {
      const had = !!entryOf(user);
      if (had) { delete data().users[user.name]; save(); }
      cache.delete(user.name);
      return { removed: had, ...view(null) };
    },

    /** 이 사람의 요청을 처리할 AI(개인 키) — 없거나 꺼져 있으면 null */
    forUser(name) {
      if (!name || !active()) return null;
      const entry = data().users[name];
      if (!entry) return null;
      if (entry.gateway === 'local' && !localAllowed(name)) return null;   // 예전에 저장된 비관리자 로컬 연결도 쓰지 않는다
      const hit = cache.get(name);
      if (hit && hit.updatedAt === entry.updatedAt) return hit.ai;
      let key;
      try { key = unseal(entry.secret, name); }
      catch (e) { log(`[개인 AI] ${name}의 키를 풀지 못했습니다(암호 열쇠가 바뀌었으면 키를 다시 넣어야 합니다)`); return null; }
      const local = entry.gateway === 'local';
      const baseUrl = local ? localBaseUrl(entry.baseUrl) : undefined;
      const label = local ? `로컬 AI ${entry.model}` : `${entry.gateway === 'baze' ? 'API ' : ''}${entry.model} · 개인 키`;
      const localFetch = local ? (url, init = {}) => {
        if (new URL(url).origin !== new URL(baseUrl).origin) throw bad('등록한 로컬 API 주소로만 요청할 수 있습니다');
        const headers = new Headers(init.headers);
        if (entry.noAuth) headers.delete('Authorization');
        return (fetchImpl || fetch)(url, { ...init, headers, redirect: 'error' });
      } : fetchImpl;
      // MCP 연결(ai.mcp — server/ai.js normalizeMcp)은 서버 설정을 따른다: config.ai.mcp 가 없으면 정하지 않음 → 서버가 새 연결(v2)로 돌린다(service._serverAiV2)
      const ai = new AiProposer({ ai: { provider: entry.provider, gateway: local ? 'direct' : entry.gateway, ...(local ? { baseUrl } : {}), model: entry.model, effort: entry.effort, workspace: entry.workspace || 'mcp', ...(entry.anthropicWorkspaceId ? { anthropicWorkspaceId: entry.anthropicWorkspaceId } : {}), enabled: true, timeoutMs: config.ai?.timeoutMs, mcp: config.ai?.mcp } }, { key, fetch: localFetch, label });
      cache.set(name, { updatedAt: entry.updatedAt, ai });
      return ai;
    },

    /** 키·모델 확인(모델 정보 조회만 — 생성 호출·과금 없음) */
    async check(user) {
      const entry = entryOf(user);
      if (!entry) throw new ServiceError('NO_PERSONAL_AI', '등록한 개인 AI 키가 없습니다', 404);
      if (!active()) throw new ServiceError('PERSONAL_AI_OFF', '이 서버는 지금 개인 키로 AI 를 부르지 않습니다(모의·꺼짐 설정)', 409);
      const ai = this.forUser(user.name);
      if (!ai?.enabled) throw new ServiceError('PERSONAL_AI_BROKEN', '저장한 키를 읽지 못했습니다. 키를 다시 넣어 주세요', 409);
      let result;
      try {
        if (entry.gateway === 'local') {
          const models = await ai.listModels();
          if (!models.some(m => m.id === entry.model)) throw new Error('로컬 AI 모델 목록에 등록한 모델 ID가 없습니다. 로컬 서버에서 모델을 확인하세요.');
          result = { model: entry.model };
        } else result = await ai.checkModel();
      }
      catch (e) { entry.lastCheck = { at: new Date().toISOString(), ok: false, message: e.message }; save(); throw new ServiceError('PERSONAL_AI_CHECK', e.message, 502); }
      entry.lastCheck = { at: new Date().toISOString(), ok: true, message: `${result.model} 사용 가능` }; save();
      return view(entry);
    },

    /**
     * API 잔액과 이번 달 사용량(GET 만 — 과금 없음). 월 할당은 계정 단위라 같은 계정의 키는 잔액이 같다.
     * 1분 안에 다시 물으면 앞의 답을 쓴다(refresh 면 새로).
     * → { balance: { monthly, purchased, orgGranted, total, renewalDate }, usage: { from, to, key, account, days: [{ date, calls, credits }] }, checkedAt }
     */
    async credits(name, { refresh = false, now = new Date() } = {}) {
      const entry = data().users[name];
      if (!entry) throw new ServiceError('NO_PERSONAL_AI', '등록한 개인 AI 키가 없습니다', 404);
      if (entry.gateway !== 'baze') throw new ServiceError('NOT_GATEWAY_KEY', '잔액은 API 키에서만 조회할 수 있습니다', 409);
      if (!active()) throw new ServiceError('PERSONAL_AI_OFF', '이 서버는 지금 개인 키로 AI 를 부르지 않습니다(모의·꺼짐 설정)', 409);
      const ai = this.forUser(name);
      if (!ai?.enabled) throw new ServiceError('PERSONAL_AI_BROKEN', '저장한 키를 읽지 못했습니다. 키를 다시 넣어 주세요', 409);
      const hit = creditCache.get(name);
      if (!refresh && hit && hit.updatedAt === entry.updatedAt && Date.now() - hit.at < 60000) return hit.value;
      // API는 한국 시각으로 날을 세고 월 할당도 1일 0시에 다시 찬다
      const to = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
      const from = `${to.slice(0, 8)}01`;
      let value;
      try {
        const [balance, key, account] = await Promise.all([ai.gatewayCredits(), ai.gatewayUsage({ from, to, by: 'day', scope: 'key' }), ai.gatewayUsage({ from, to, by: 'day', scope: 'member' })]);
        value = { balance, usage: { from, to, key: key.total, account: account.total, days: key.rows.map((r) => ({ date: r.key, calls: r.calls, credits: r.credits })) }, checkedAt: new Date().toISOString() };
      } catch (e) { throw new ServiceError('GATEWAY_CREDITS', e.message, 502); }
      creditCache.set(name, { at: Date.now(), updatedAt: entry.updatedAt, value });
      return value;
    },

    /** 이 키로 쓸 수 있는 모델 목록(목록 조회만 — 생성 호출·과금 없음) → { models: [{ id, label? }] } */
    async models(user) {
      const entry = entryOf(user);
      if (!entry) throw new ServiceError('NO_PERSONAL_AI', '등록한 개인 AI 키가 없습니다 — 키를 먼저 저장하세요', 404);
      if (!active()) throw new ServiceError('PERSONAL_AI_OFF', '이 서버는 지금 개인 키로 AI 를 부르지 않습니다(모의·꺼짐 설정)', 409);
      const ai = this.forUser(user.name);
      if (!ai?.enabled) throw new ServiceError('PERSONAL_AI_BROKEN', '저장한 키를 읽지 못했습니다. 키를 다시 넣어 주세요', 409);
      try { return { models: await ai.listModels() }; }
      catch (e) { throw new ServiceError('PERSONAL_AI_MODELS', e.message, 502); }
    },
  };
}
