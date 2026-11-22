// AI 실행기 관리(2026-11-17 사용자 결정 — 저장소의 실행기 bat(start-codex-agent·start-claude-worker·start-gemini-agent …)을 앱이 대신한다).
//   실행기 하나 = { AI(codex·claude-code·gemini-cli·antigravity) · 서버(이 앱의 서버 'local' 또는 '다른 서버') · 자동 시작 · 연결 방식(v3 TSV 기본, v2, v1) }.
//   띄우는 것은 scripts/setup-worker.mjs → scripts/ai-worker.mjs(--provider · --url <서버>/mcp · --mcp 1|2|3) — 예전 bat 이 띄우던 실행기와 같은 코드다.
//   '다른 서버' 토큰은 Electron safeStorage(vault)로 암호화해 설정 폴더(runner-secrets.json)에 두고, 실행기에는 환경 변수 HWPX_COWORK_TOKEN 으로만
//   넘긴다 — 명령줄 인자·기록·화면·runners.json 에는 쓰지 않는다(기록 줄은 토큰 글자를 *** 로 가린다).
//   상태는 실행기의 '[hwpx 개인 AI] …' 줄(server/worker.js DEFAULT_LOG, scripts/ai-worker.mjs)에서 읽는다.
//   끌 때는 IPC 'stop'(setup-worker 의 정상 종료 — 진행 중인 MCP 호출을 닫고 끝낸다), 오래 걸리면 그 실행기 프로세스 묶음만 강제로 끈다.
//   뜻하지 않게 끝나면 간격을 늘려 몇 번 다시 띄우고, 넘으면 오류로 둔다. 로그인·업데이트처럼 다시 띄워도 낫지 않는 시작 점검 실패는 바로 오류.
// Electron 없이 시험할 수 있게 프로세스 띄우기·CLI 준비·암호화·fetch·타이머를 모두 넣어 받는다(tests/desktop_windows.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const LOCAL_SERVER = 'local';
/** managed = 앱이 공식 CLI 를 설치·로그인까지 돕는다(desktop-ai.mjs). mcp = 연결 방식(v1/v2/v3)을 고른다(Google CLI 는 MCP 로 일하지 않는다) */
export const RUNNER_AIS = Object.freeze({
  codex: Object.freeze({ label: 'Codex', account: 'ChatGPT 구독', command: 'codex', managed: true, mcp: true }),
  'claude-code': Object.freeze({ label: 'Claude Code', account: 'Claude 구독', command: 'claude', managed: true, mcp: true }),
  'gemini-cli': Object.freeze({ label: 'Gemini CLI', account: 'Google 계정', command: 'gemini', managed: false, mcp: false }),
  antigravity: Object.freeze({ label: 'Antigravity', account: 'Google 계정', command: 'agy', managed: false, mcp: false }),
});
/** 상태 칩 글(docs/UI_TERMS.md §1 — 상태는 하나) */
export const RUNNER_STATES = Object.freeze({ off: '꺼짐', preparing: '준비', connected: '연결됨', working: '처리 중', waiting: '대기', error: '오류' });
/** restartDelays: 뜻하지 않은 종료 뒤 다시 띄우기 전 기다림(횟수 = 길이) · stableMs: 이만큼 연결돼 있었으면 횟수를 다시 센다
 *  quietMs: '다시 시도합니다' 줄 뒤 이만큼 조용하면 다시 연결됨 · stopMs: 정상 종료를 기다리는 시간 · killWaitMs: 강제 종료 뒤 기다림 */
export const DEFAULT_TIMING = Object.freeze({ restartDelays: Object.freeze([5000, 15000, 45000, 120000, 300000]), stableMs: 10 * 60000, quietMs: 45000, stopMs: 45000, killWaitMs: 5000 });
/** 앱 묶음(payload/app)에 있어야 실행기가 도는 파일 — scripts/package-windows-desktop.mjs·package-macos-personal.mjs 가 묶은 뒤 확인한다 */
export const RUNNER_PAYLOAD_FILES = Object.freeze(['scripts/setup-worker.mjs', 'scripts/ai-worker.mjs', 'scripts/desktop-ai.mjs', 'scripts/cli-versions.mjs',
  'server/worker.js', 'server/bridge.js', 'server/codex-ai.js', 'server/claude-cli-ai.js', 'server/google-cli-ai.js']);

const LOG_KEEP = 200;               // 화면에 줄 수 있는 최근 줄(메모리)
const LOG_FILE_MAX = 1024 * 1024;   // 실행기마다 기록 파일 1MB 를 넘으면 .1 로 돌린다
const ROLE_LABEL = { admin: '관리자', editor: '편집자', viewer: '보기만' };
const cancelled = () => Object.assign(new Error('실행기 켜기를 취소했습니다.'), { code: 'CANCELLED' });

/** 사설·자기 PC 주소 — 여기만 http 를 허용한다(인터넷 주소는 https: 토큰이 암호화 없이 오가지 않게) */
export function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** '다른 서버' 주소(https://…/ 또는 …/mcp, 스킴 없이 적어도 됨) → { base: 'https://x/', mcpUrl: 'https://x/mcp' } */
export function serverAddress(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('서버 주소를 적어 주세요.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try { u = new URL(text); } catch { throw new Error('서버 주소 형식을 확인해 주세요.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('서버 주소는 https:// 로 적어 주세요.');
  if (u.username || u.password) throw new Error('주소에 아이디·비밀번호를 넣지 마세요. 토큰은 아래 칸에 적습니다.');
  if (u.search || u.hash) throw new Error('주소의 ? 나 # 뒤는 지워 주세요.');
  if (u.protocol === 'http:' && !privateHost(u.hostname)) throw new Error('인터넷 주소는 https:// 로 적어 주세요(토큰이 암호화 없이 오가지 않게).');
  let p = u.pathname.replace(/\/+$/, '');
  if (/\/mcp$/i.test(p)) p = p.slice(0, -4);
  return { base: `${u.origin}${p}/`, mcpUrl: `${u.origin}${p}/mcp` };
}

/** 화면에 보일 서버 이름(호스트 + 하위 경로) */
export function hostLabel(url) {
  try { const u = new URL(url); return u.host + (u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : ''); } catch { return String(url); }
}

/** 기록 줄에서 비밀 값(토큰)을 가린다 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***');
  return out;
}

const PREFIX = /^\[hwpx (?:개인 AI|Codex)\]\s*/;
/**
 * 실행기 한 줄 → { kind, user?, config?, text }
 *   user(…의 요청을 처리합니다 — 연결됨) · ready(자동 처리를 시작) · working(요청 처리 시작) · done(요청 끝) · retry(서버 연결 다시 시도)
 *   stopping(실행기가 스스로 멈춤 — 로그인·권한) · failed(실패 글 — 연결 전이면 시작 점검 실패, config=다시 띄워도 낫지 않음) · info · null(머리 없는 줄)
 * 줄 글은 server/worker.js 의 say(…)·scripts/ai-worker.mjs 의 stderr 줄과 맞춘다.
 */
export function runnerLine(line) {
  const raw = String(line ?? '');
  if (!PREFIX.test(raw)) return { kind: null, text: raw.trim() };
  const text = raw.replace(PREFIX, '').trim();
  const user = /^(.+?)의 요청을 처리합니다\.?$/.exec(text);
  if (user) return { kind: 'user', user: user[1], text };
  if (/^자동 처리를 시작했습니다/.test(text)) return { kind: 'ready', text };
  if (/실행기를 중지합니다/.test(text)) return { kind: 'stopping', text };
  if (/작업 도구\(task·read·edit·finish\)로|MCP로 요청 전문|^모델 \S.* · 추론 강도 |^Codex (?:자동 선택|판단 실패로 기본 설정 사용):/.test(text)) return { kind: 'working', text };
  if (/다시 시도합니다\.?$/.test(text)) return { kind: 'retry', text };
  if (/완료했습니다|사유를 MCP에 등록했습니다|묶음 제안으로 저장했습니다/.test(text)) return { kind: 'done', text };
  if (/^실행하지 못했습니다/.test(text)) return { kind: 'failed', config: false, text };   // 주소·네트워크 등 — 다시 띄우면 나을 수 있다
  if (/실패|못했습니다|않았습니다|필요합니다|확인하세요|확인해 주세요|요청해 주세요|업데이트|지원하지 않|로그인/.test(text)) {
    return { kind: 'failed', config: /로그인|업데이트|지원하지 않|찾지 못했습니다/.test(text), text };
  }
  return { kind: 'info', text };
}

/** 정상 종료를 기다리지 못한 실행기만 끈다 — Windows 는 그 프로세스 묶음(/T: 실행기가 띄운 codex·claude 포함) */
export function killTree(child, { platform = process.platform, run = spawnSync } = {}) {
  if (!child || child.exitCode != null || child.signalCode) return;
  try {
    if (platform === 'win32' && child.pid) run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    else child.kill('SIGKILL');
  } catch { /* 이미 끝남 */ }
}

// 저장된 목록에서 버전이 빠진 옛 실행기는 저장 당시의 v2로 다시 연다.
function runnerMcp(value) {
  const version = Number(value);
  return [1, 3].includes(version) ? version : 2;
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export class RunnerManager extends EventEmitter {
  #dir; #vault; #launch; #prepare; #cancelPrepare; #local; #env; #support; #fetch; #kill; #timers; #now; #timing; #localSupported;
  #list; #runtime = new Map(); #closing = false;

  constructor({ dir, vault = null, launch, prepare = async () => ({}), cancelPrepare = () => {}, local = () => null, env = () => ({}),
    support = () => ({ available: true, message: '' }), fetchImpl = globalThis.fetch, kill = killTree, timers = { setTimeout, clearTimeout },
    now = Date.now, timing = {}, localSupported = true, migrate = true } = {}) {
    super();
    if (!dir) throw new Error('설정 폴더가 필요합니다.');
    if (typeof launch !== 'function') throw new Error('실행기를 띄울 방법이 필요합니다.');
    this.#dir = dir; this.#vault = vault; this.#launch = launch; this.#prepare = prepare; this.#cancelPrepare = cancelPrepare; this.#local = local;
    this.#env = env; this.#support = support; this.#fetch = fetchImpl; this.#kill = kill; this.#timers = timers; this.#now = now;
    this.#timing = { ...DEFAULT_TIMING, ...timing }; this.#localSupported = localSupported !== false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#list = this.#load(migrate);
  }

  get listFile() { return path.join(this.#dir, 'runners.json'); }
  get secretFile() { return path.join(this.#dir, 'runner-secrets.json'); }
  get logDir() { return path.join(this.#dir, 'runner-logs'); }
  logFile(id) { return path.join(this.logDir, `${id}.log`); }

  // ── 목록(runners.json — 토큰 없음) ──
  #load(migrate) {
    let data = null; let missing = false;
    try { data = JSON.parse(fs.readFileSync(this.listFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') missing = true;
      // 망가진 목록은 지우지 않고 옆에 남긴 뒤 빈 목록으로 시작한다
      else try { fs.renameSync(this.listFile, `${this.listFile}.bad-${Date.now()}`); } catch { /* 그대로 둔다 */ }
    }
    const servers = []; const runners = [];
    for (const s of Array.isArray(data?.servers) ? data.servers : []) {
      if (typeof s?.id !== 'string' || !/^s-[0-9a-f]{8}$/.test(s.id) || servers.some((x) => x.id === s.id)) continue;
      let address; try { address = serverAddress(s.url); } catch { continue; }
      servers.push({ id: s.id, url: address.base, user: String(s.user || ''), role: String(s.role || ''), mcp2: s.mcp2 === true, mcp3: s.mcp3 === true, checkedAt: String(s.checkedAt || '') });
    }
    for (const r of Array.isArray(data?.runners) ? data.runners : []) {
      if (typeof r?.id !== 'string' || !/^r-[0-9a-f]{8}$/.test(r.id) || !RUNNER_AIS[r.ai] || runners.some((x) => x.id === r.id)) continue;
      if (r.server !== LOCAL_SERVER && !servers.some((s) => s.id === r.server)) continue;
      runners.push({ id: r.id, ai: r.ai, server: r.server, autoStart: r.autoStart !== false, mcp: runnerMcp(r.mcp) });
    }
    const list = { servers, runners };
    // 예전 '내 AI 연결'(desktop.json { ai: codex|claude-code }) → 이 앱 서버의 실행기 하나(자동 시작, 새 연결). desktop.json 은 그대로 둔다
    if (missing && migrate && this.#localSupported) {
      let old = null; try { old = JSON.parse(fs.readFileSync(path.join(this.#dir, 'desktop.json'), 'utf8')); } catch { /* 없음 */ }
      if (['codex', 'claude-code'].includes(old?.ai)) {
        list.runners.push({ id: this.#newId('r', list), ai: old.ai, server: LOCAL_SERVER, autoStart: true, mcp: 3 });
        this.#list = list; this.#save();
      }
    }
    return list;
  }
  #save() { writeAtomic(this.listFile, `${JSON.stringify({ version: 1, servers: this.#list.servers, runners: this.#list.runners }, null, 2)}\n`); }
  #newId(prefix, list = this.#list) {
    for (;;) {
      const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
      if (!list.servers.some((s) => s.id === id) && !list.runners.some((r) => r.id === id)) return id;
    }
  }
  #runner(id) { const r = this.#list.runners.find((x) => x.id === id); if (!r) throw new Error('없는 실행기입니다.'); return r; }
  #server(id) { const s = this.#list.servers.find((x) => x.id === id); if (!s) throw new Error('없는 서버입니다.'); return s; }

  // ── 토큰(runner-secrets.json — safeStorage 암호문만) ──
  #secrets() {
    try { const data = JSON.parse(fs.readFileSync(this.secretFile, 'utf8')); return data && typeof data.tokens === 'object' && data.tokens ? { ...data.tokens } : {}; }
    catch { return {}; }
  }
  #writeSecrets(tokens) {
    writeAtomic(this.secretFile, `${JSON.stringify({ version: 1, note: 'Electron safeStorage 로 암호화한 토큰 — 이 PC·이 사용자만 풉니다', tokens }, null, 2)}\n`);
  }
  #seal(token) {
    let ok = false; try { ok = this.#vault?.available?.() === true; } catch { ok = false; }
    if (!ok) throw new Error('이 PC에서 토큰을 안전하게 보관할 수 없어 저장하지 않았습니다.');
    const sealed = this.#vault.encrypt(token);
    if (typeof sealed !== 'string' || !sealed || sealed.includes(token)) throw new Error('토큰을 암호화하지 못했습니다.');
    return sealed;
  }
  #token(serverId) {
    const sealed = this.#secrets()[serverId];
    if (!sealed) throw new Error('저장한 토큰이 없습니다. 서버를 다시 추가해 주세요.');
    let token;
    try { token = this.#vault.decrypt(sealed); } catch { token = null; }
    if (typeof token !== 'string' || !token) throw new Error('저장한 토큰을 열지 못했습니다(다른 사용자·PC에서 만든 설정). 서버를 다시 추가해 주세요.');
    return token;
  }

  // ── 실행 상태(메모리) ──
  #state(id) {
    let rt = this.#runtime.get(id);
    if (!rt) {
      rt = { state: 'off', message: '', user: null, since: null, child: null, generation: 0, restarts: 0, connectedAt: null, stopRequested: false,
        stopping: false, haltSent: false, fatal: null, lastFailure: null, quiet: null, restartTimer: null, secrets: [], lines: [], count: 0, loaded: false,
        gone: null, markGone: null, exitTimer: null };
      this.#runtime.set(id, rt);
    }
    return rt;
  }
  #set(id, state, message = '') {
    const rt = this.#state(id);
    if (rt.state !== state) rt.since = new Date(this.#now()).toISOString();
    rt.state = state; rt.message = message;
    this.#changed();
  }
  #changed() { this.emit('change'); }
  #waitingLabel(rt) { return rt.user ? `${rt.user} · 요청을 기다립니다` : '요청을 기다립니다'; }
  #serverLabel(serverId) {
    if (serverId === LOCAL_SERVER) return '이 앱의 서버';
    const s = this.#list.servers.find((x) => x.id === serverId);
    return s ? `${hostLabel(s.url)}${s.user ? ` · ${s.user}` : ''}` : '(없는 서버)';
  }
  #serverView(s) {
    return { id: s.id, url: s.url, host: hostLabel(s.url), user: s.user, role: s.role, roleLabel: ROLE_LABEL[s.role] || s.role, mcp2: s.mcp2, mcp3: s.mcp3, checkedAt: s.checkedAt,
      inUse: this.#list.runners.some((r) => r.server === s.id) };
  }
  #view(r) {
    const rt = this.#state(r.id); const ai = RUNNER_AIS[r.ai];
    return { id: r.id, ai: r.ai, aiLabel: ai.label, account: ai.account, server: r.server, serverLabel: this.#serverLabel(r.server), autoStart: r.autoStart,
      mcp: ai.mcp ? r.mcp : null, state: rt.state, stateLabel: RUNNER_STATES[rt.state], message: rt.message, user: rt.user, since: rt.since, restarts: rt.restarts,
      active: !!rt.child || rt.state === 'preparing' || !!rt.restartTimer, stopping: rt.stopping, lines: rt.count };
  }
  snapshot() {
    let local = null; try { local = this.#localSupported ? this.#local() : null; } catch { local = null; }
    return { localSupported: this.#localSupported, localReady: !!local, logDir: this.logDir,
      servers: this.#list.servers.map((s) => this.#serverView(s)), runners: this.#list.runners.map((r) => this.#view(r)) };
  }
  running() { return this.#list.runners.filter((r) => this.#view(r).active).length; }

  // ── 기록(runner-logs/<id>.log + 최근 줄) ──
  #tail(id) {
    try {
      const file = this.logFile(id); const size = fs.statSync(file).size; const length = Math.min(size, 64 * 1024);
      const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(length);
      try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
      return buffer.toString('utf8').split('\n').slice(size > length ? 1 : 0).filter(Boolean).slice(-LOG_KEEP).map((line) => {
        const tab = line.indexOf('\t'); return tab > 0 ? { at: line.slice(0, tab), text: line.slice(tab + 1) } : { at: '', text: line };
      });
    } catch { return []; }
  }
  #log(id, text) {
    const rt = this.#state(id);
    if (!rt.loaded) { rt.loaded = true; rt.lines = this.#tail(id); }
    const at = new Date(this.#now()).toISOString();
    const line = redact(text, rt.secrets).replace(/[\r\n]+/g, ' ').slice(0, 2000);
    rt.lines.push({ at, text: line }); if (rt.lines.length > LOG_KEEP) rt.lines.splice(0, rt.lines.length - LOG_KEEP);
    rt.count++;
    try {
      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      const file = this.logFile(id);
      try { if (fs.statSync(file).size > LOG_FILE_MAX) fs.renameSync(file, `${file}.1`); } catch { /* 아직 없음 */ }
      fs.appendFileSync(file, `${at}\t${line}\n`, { mode: 0o600 });
    } catch { /* 기록을 못 남겨도 실행기는 그대로 */ }
    this.#changed();
  }
  lines(id, count = 80) {
    this.#runner(id);
    const rt = this.#state(id);
    if (!rt.loaded) { rt.loaded = true; rt.lines = this.#tail(id); }
    return rt.lines.slice(-Math.max(1, Math.min(LOG_KEEP, Number(count) || 80)));
  }

  // ── 다른 서버 ──
  /** /api/me(이름·권한)와 /api/config(features.mcp2)를 확인한다. 토큰은 머리글로만 보낸다 */
  async verify({ url, token } = {}) {
    const { base, mcpUrl } = serverAddress(url);
    const secret = String(token ?? '').trim();
    if (!secret) throw new Error('내 토큰을 적어 주세요.');
    if (/\s/.test(secret) || secret.length > 512) throw new Error('토큰 형식을 확인해 주세요.');
    const get = async (endpoint, auth) => {
      try {
        return await this.#fetch(new URL(endpoint, base), { headers: auth ? { Authorization: `Bearer ${secret}` } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) });
      } catch { throw new Error('서버에 연결하지 못했습니다. 주소와 인터넷 연결을 확인해 주세요.'); }
    };
    const me = await get('api/me', true);
    if (me.status === 401 || me.status === 403) throw new Error('토큰을 확인해 주세요. 이 서버에서 받은 내 토큰이어야 합니다.');
    if (!me.ok) throw new Error(`서버가 요청을 받지 못했습니다(HTTP ${me.status}). 주소를 확인해 주세요.`);
    let user = null; try { user = await me.json(); } catch { user = null; }
    if (!user || typeof user.name !== 'string' || !user.name) throw new Error('HWPX Cowork 서버가 아닙니다. 주소를 확인해 주세요.');
    if (user.tutorialApiOnly) throw new Error('체험 계정은 실행기를 연결할 수 없습니다.');
    let config = null;
    try { const r = await get('api/config', false); config = r.ok ? await r.json() : null; } catch { config = null; }
    return { base, mcpUrl, user: user.name, role: String(user.role || ''), mcp2: config?.features?.mcp2 === true, mcp3: config?.features?.mcp3 === true };
  }

  /** 서버를 확인해 저장한다(같은 주소면 토큰·이름을 새로 바꾼다) → 서버 보기 */
  async addServer({ url, token } = {}) {
    const secret = String(token ?? '').trim();
    const info = await this.verify({ url, token: secret });
    const sealed = this.#seal(secret);
    let server = this.#list.servers.find((s) => s.url === info.base);
    const id = server?.id || this.#newId('s');
    const tokens = this.#secrets(); tokens[id] = sealed; this.#writeSecrets(tokens);
    if (!server) { server = { id }; this.#list.servers.push(server); }
    Object.assign(server, { url: info.base, user: info.user, role: info.role, mcp2: info.mcp2, mcp3: info.mcp3, checkedAt: new Date(this.#now()).toISOString() });
    this.#save(); this.#changed();
    return this.#serverView(server);
  }
  removeServer(id) {
    this.#server(id);
    if (this.#list.runners.some((r) => r.server === id)) throw new Error('이 서버를 쓰는 실행기를 먼저 삭제해 주세요.');
    this.#list.servers = this.#list.servers.filter((s) => s.id !== id); this.#save();
    const tokens = this.#secrets(); delete tokens[id]; this.#writeSecrets(tokens);
    this.#changed();
  }
  /** 웹 화면을 열 주소(토큰은 넣지 않는다) */
  serverUrl(id) { return this.#server(id).url; }

  // ── 실행기 목록 ──
  addRunner({ ai, server, autoStart = true, mcp = 3 } = {}) {
    if (!RUNNER_AIS[ai]) throw new Error('AI를 골라 주세요.');
    if (server === LOCAL_SERVER) { if (!this.#localSupported) throw new Error('이 운영 방식에는 앱의 서버가 없습니다. 다른 서버를 골라 주세요.'); }
    else this.#server(server);
    const version = runnerMcp(mcp);
    this.#checkMcp(ai, server, version);
    if (this.#list.runners.some((r) => r.ai === ai && r.server === server)) throw new Error('같은 AI·서버의 실행기가 이미 있습니다.');
    const runner = { id: this.#newId('r'), ai, server, autoStart: autoStart !== false, mcp: version };
    this.#list.runners.push(runner); this.#save(); this.#changed();
    return this.#view(runner);
  }
  #checkMcp(ai, server, version) {
    if (!RUNNER_AIS[ai].mcp || version === 1 || server === LOCAL_SERVER) return;
    const remote = this.#server(server);
    if (version === 3 && !remote.mcp3) throw new Error('이 서버에서 MCP v3(TSV) 지원을 확인할 수 없습니다. 서버 연결을 다시 확인하거나 고급에서 서버가 지원하는 v2 또는 v1을 선택하세요.');
    if (version === 2 && !remote.mcp2) throw new Error('이 서버는 새 연결(v2)을 지원하지 않습니다. 고급에서 예전 연결(v1)을 고르거나 서버를 업데이트해 주세요.');
  }
  /** 자동 시작·연결 방식만 바꾼다(연결 방식은 다음에 켤 때부터) */
  updateRunner(id, { autoStart, mcp } = {}) {
    const runner = this.#runner(id);
    if (mcp !== undefined && mcp !== null) { const version = runnerMcp(mcp); this.#checkMcp(runner.ai, runner.server, version); runner.mcp = version; }
    if (autoStart !== undefined) runner.autoStart = autoStart === true;
    this.#save(); this.#changed();
    return this.#view(runner);
  }
  async removeRunner(id) {
    this.#runner(id);
    await this.stop(id);
    this.#list.runners = this.#list.runners.filter((r) => r.id !== id); this.#save();
    this.#runtime.delete(id); this.#changed();
  }

  // ── 켜기·끄기 ──
  #target(runner) {
    if (runner.server === LOCAL_SERVER) {
      const local = this.#localSupported ? this.#local() : null;
      if (!local?.mcpUrl || !local?.token) throw new Error(this.#localSupported ? '이 앱의 서버가 아직 준비되지 않았습니다.' : '이 운영 방식에는 앱의 서버가 없습니다.');
      return local;
    }
    const server = this.#server(runner.server);
    return { mcpUrl: serverAddress(server.url).mcpUrl, token: this.#token(server.id) };
  }

  /** 켠다(이미 켜져 있으면 그대로). interactive=false(자동 시작)이면 설치·로그인 창을 띄우지 않고 오류로 둔다 */
  start(id, { interactive = true } = {}) { return this.#start(id, { interactive, restart: false }); }

  async #start(id, { interactive, restart }) {
    const runner = this.#runner(id); const rt = this.#state(id); const kind = RUNNER_AIS[runner.ai];
    if (this.#closing) throw new Error('앱을 종료하고 있습니다.');
    if (rt.child || rt.state === 'preparing' || rt.stopping) return this.#view(runner);
    this.#timers.clearTimeout(rt.restartTimer); rt.restartTimer = null;
    if (!restart) rt.restarts = 0;
    const generation = ++rt.generation;
    Object.assign(rt, { stopRequested: false, haltSent: false, fatal: null, lastFailure: null, connectedAt: null, user: null });
    const active = () => { if (this.#closing || rt.generation !== generation) throw cancelled(); };
    this.#set(id, 'preparing', restart ? `다시 켜는 중(${rt.restarts}/${this.#timing.restartDelays.length})` : '켜는 중');
    this.#log(id, `[앱] ${restart ? '다시 켭니다' : '켭니다'} — ${kind.label} · ${this.#serverLabel(runner.server)}${kind.mcp ? ` · 연결 v${runner.mcp}` : ''}`);
    try {
      const support = this.#support() || {};
      if (support.available === false) throw new Error(support.message || '이 PC에서는 AI 실행기를 쓸 수 없습니다.');
      this.#target(runner);   // 서버·토큰 문제는 CLI 준비(설치·로그인)보다 먼저 알린다
      await this.#prepare(runner.ai, {
        interactive, active,
        note: (message) => { active(); this.#set(id, 'preparing', message); this.#log(id, `[앱] ${message}`); },
      });
      active();
      const target = this.#target(runner);
      rt.secrets = [target.token];
      const args = ['--provider', runner.ai, '--url', target.mcpUrl, ...(kind.mcp ? ['--mcp', String(runner.mcp)] : [])];
      const child = this.#launch(args, { ...this.#env(), HWPX_COWORK_TOKEN: target.token,
        ...(target.pipe ? { HWPX_COWORK_DESKTOP_PIPE: JSON.stringify(target.pipe) } : {}) });
      rt.child = child;
      rt.gone = new Promise((resolve) => { rt.markGone = resolve; });
      this.#attach(id, child);
      return this.#view(runner);
    } catch (error) {
      if (error?.code === 'CANCELLED' || rt.generation !== generation) return this.#view(runner);
      rt.secrets = [];
      this.#set(id, 'error', error?.message || '실행기를 켜지 못했습니다.');
      this.#log(id, `[앱] 켜지 못했습니다 — ${error?.message || '알 수 없는 오류'}`);
      throw error;
    }
  }

  #attach(id, child) {
    const rt = this.#state(id);
    const read = (stream) => {
      if (!stream) return;
      let buffer = '';
      stream.setEncoding?.('utf8');
      stream.on('data', (chunk) => {
        buffer += String(chunk);
        const parts = buffer.split(/\r?\n/); buffer = parts.pop();
        if (buffer.length > 16384) { parts.push(buffer); buffer = ''; }
        for (const part of parts) if (part.trim() && rt.child === child) this.#line(id, child, part);
      });
      stream.on('end', () => { if (buffer.trim() && rt.child === child) this.#line(id, child, buffer); buffer = ''; });
    };
    read(child.stdout); read(child.stderr);
    child.once('error', (error) => { if (rt.child !== child) return; this.#log(id, `[앱] 실행기 프로세스 오류 — ${error.message}`); this.#finish(id, child, null, null); });
    // 끝난 뒤 남은 출력(시작 점검 실패 글)까지 읽고 정리한다: 'close'(출력 닫힘)를 기다리되 오지 않으면 잠시 뒤 정리
    child.once('exit', (code, signal) => {
      if (rt.child !== child) return;
      rt.exitTimer = this.#timers.setTimeout(() => this.#finish(id, child, code, signal), 2000);
    });
    child.once('close', (code, signal) => this.#finish(id, child, code, signal));
  }

  #line(id, child, raw) {
    const rt = this.#state(id);
    this.#log(id, raw);
    const event = runnerLine(redact(raw, rt.secrets));
    switch (event.kind) {
      case 'user': rt.user = event.user; rt.connectedAt ??= this.#now(); this.#clearQuiet(rt); this.#set(id, 'connected', this.#waitingLabel(rt)); break;
      case 'ready': rt.connectedAt ??= this.#now(); if (rt.state !== 'working') this.#set(id, 'connected', this.#waitingLabel(rt)); break;
      case 'working': this.#clearQuiet(rt); this.#set(id, 'working', '요청 처리 중'); break;
      case 'done': this.#clearQuiet(rt); if (rt.connectedAt) this.#set(id, 'connected', this.#waitingLabel(rt)); break;
      case 'retry':
        if (rt.connectedAt && rt.state !== 'working') { this.#set(id, 'waiting', '서버 연결을 다시 시도하고 있습니다'); this.#armQuiet(id, rt); }
        break;
      case 'stopping': rt.fatal = event.text; void this.#halt(id, child); break;   // 로그인·권한 문제로 실행기가 스스로 멈춤 — 다시 띄우지 않는다
      case 'failed':
        if (rt.connectedAt) { if (['working', 'waiting'].includes(rt.state)) this.#set(id, 'connected', this.#waitingLabel(rt)); }
        else { rt.lastFailure = event.text; if (event.config) rt.fatal = event.text; }
        break;
      default: break;
    }
  }
  #armQuiet(id, rt) {
    this.#clearQuiet(rt);
    rt.quiet = this.#timers.setTimeout(() => { rt.quiet = null; if (rt.state === 'waiting' && rt.child) this.#set(id, 'connected', this.#waitingLabel(rt)); }, this.#timing.quietMs);
  }
  #clearQuiet(rt) { if (rt.quiet) this.#timers.clearTimeout(rt.quiet); rt.quiet = null; }

  #finish(id, child, code, signal) {
    const rt = this.#state(id);
    if (rt.child !== child) return;
    rt.child = null; rt.haltSent = false; this.#clearQuiet(rt);
    if (rt.exitTimer) this.#timers.clearTimeout(rt.exitTimer); rt.exitTimer = null;
    const connectedFor = rt.connectedAt ? this.#now() - rt.connectedAt : 0;
    this.#log(id, `[앱] 실행기가 끝났습니다(${code ?? signal ?? '알 수 없음'}).`);
    rt.secrets = []; rt.markGone?.(); rt.markGone = null;
    if (rt.fatal) { this.#set(id, 'error', rt.fatal); return; }
    if (rt.stopRequested || this.#closing) { this.#set(id, 'off', ''); return; }
    // 뜻하지 않은 종료 — 간격을 늘려 다시 띄운다. 오래(stableMs) 잘 돌았으면 횟수를 처음부터
    if (connectedFor >= this.#timing.stableMs) rt.restarts = 0;
    const delays = this.#timing.restartDelays;
    if (rt.restarts >= delays.length) {
      this.#set(id, 'error', `여러 번 다시 켜도 멈췄습니다.${rt.lastFailure ? ` ${rt.lastFailure}` : ''}`);
      this.#log(id, '[앱] 다시 켜기를 그만둡니다.');
      return;
    }
    const delay = delays[rt.restarts++];
    const seconds = Math.max(1, Math.round(delay / 1000));
    this.#set(id, 'waiting', `${seconds}초 뒤 다시 켭니다(${rt.restarts}/${delays.length})${rt.lastFailure ? ` — ${rt.lastFailure}` : ''}`);
    this.#log(id, `[앱] 뜻하지 않게 끝나 ${seconds}초 뒤 다시 켭니다(${rt.restarts}/${delays.length}).`);
    const generation = rt.generation;
    rt.restartTimer = this.#timers.setTimeout(() => {
      rt.restartTimer = null;
      if (rt.generation !== generation || this.#closing) return;
      this.#start(id, { interactive: false, restart: true }).catch(() => { /* 상태·기록에 남았다 */ });
    }, delay);
    this.#changed();
  }

  #within(promise, ms) {
    return new Promise((resolve) => {
      const timer = this.#timers.setTimeout(() => resolve(false), ms);
      promise.then(() => { this.#timers.clearTimeout(timer); resolve(true); });
    });
  }
  /** 실행기 프로세스를 정상 종료(IPC stop)로 끝내고 기다린다. 오래 걸리면 그 프로세스 묶음만 강제로 끈다 */
  async #halt(id, child) {
    const rt = this.#state(id);
    if (!child || rt.child !== child) return;
    rt.stopRequested = true;
    const gone = rt.gone || Promise.resolve();
    if (!rt.haltSent) {
      rt.haltSent = true;
      try { if (child.connected) child.send('stop'); else this.#kill(child); } catch { this.#kill(child); }
    }
    if (await this.#within(gone, this.#timing.stopMs)) return;
    this.#log(id, '[앱] 정상 종료를 기다리지 못해 강제로 끕니다.');
    this.#kill(child);
    if (await this.#within(gone, this.#timing.killWaitMs)) return;
    this.#finish(id, child, null, 'SIGKILL');
  }

  /** 끈다(준비 중이면 취소, 다시 켜기 예약도 지운다) */
  async stop(id) {
    const runner = this.#runner(id); const rt = this.#state(id);
    rt.generation++;
    this.#timers.clearTimeout(rt.restartTimer); rt.restartTimer = null;
    const child = rt.child;
    if (!child) {
      if (rt.state === 'preparing') {
        // CLI setup is shared by provider. Let other targets finish using it;
        // the generation check still cancels this particular runner.
        const shared = this.#list.runners.some(r => r.id !== id && r.ai === runner.ai && this.#runtime.get(r.id)?.state === 'preparing');
        if (!shared) { try { this.#cancelPrepare(runner.ai); } catch { /* 이미 끝남 */ } }
      }
      if (rt.state !== 'off') { this.#set(id, 'off', ''); this.#log(id, '[앱] 껐습니다.'); }
      return this.#view(runner);
    }
    rt.stopping = true; this.#changed();
    this.#log(id, '[앱] 끄는 중 — 진행 중인 저장을 마치고 끝냅니다.');
    try { await this.#halt(id, child); } finally { rt.stopping = false; this.#changed(); }
    return this.#view(runner);
  }
  async stopAll({ localOnly = false } = {}) {
    const runners = this.#list.runners.filter(r => !localOnly || r.server === LOCAL_SERVER);
    await Promise.allSettled(runners.map(r => this.stop(r.id)));
  }
  /** 앱을 끌 때: 새로 켜지 않게 막고 모두 정상 종료한다 */
  async shutdown() {
    this.#closing = true;
    for (const rt of this.#runtime.values()) { rt.generation++; this.#timers.clearTimeout(rt.restartTimer); rt.restartTimer = null; }
    await this.stopAll();
  }
  /** 자동 시작 실행기를 켠다(설치·로그인 창 없이) → 켜지 못한 것 [{ id, message }] */
  async startAuto(scope = 'all') {
    const failed = [];
    const runners = this.#list.runners.filter(r => r.autoStart && (scope === 'all' || (r.server === LOCAL_SERVER) === (scope === 'local')));
    await Promise.all(runners.map(async (r) => {
      try { await this.#start(r.id, { interactive: false, restart: false }); } catch (error) { failed.push({ id: r.id, message: error.message }); }
    }));
    return failed;
  }
}
