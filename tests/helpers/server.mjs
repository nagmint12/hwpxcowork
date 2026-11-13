// 시험 받침(docs/V3_SPEC.md §6.0): 임시 data 폴더 + 임시 config(토큰도 매번 새로 만듦)로 서버를 띄운다.
// 진짜 config.json·data/ 는 읽지도 쓰지도 않는다. 포트는 0(빈 포트) — 서버가 stdout 첫 줄 'LISTENING <port>', 둘째 줄 'NONCE <hex>'.
//   const srv = await startServer({ ai: 'mock' });          // 또는 ai: 'off'(기본)
//   const A = srv.api('a');                                  // = api(srv.base, srv.tokens.a)
//   await A('/api/me')                                       // 2xx 가 아니면 던진다 → 본문
//   const r = await A.res('/api/docs/x', { method: 'POST', body: {…} })   // 던지지 않음 → { status, ok, data, headers }
//   await srv.restart({ ai: 'off' });                        // 같은 포트·토큰·data 로 다시 띄움(nonce 는 바뀜)
//   await srv.stop();                                        // 서버 끄고 임시 폴더 지움
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixture = (name) => path.join(root, 'tests', 'fixtures', name);

const OUTPUT_MAX = 256 * 1024;
// WHATWG fetch 의 막힌 포트(https://fetch.spec.whatwg.org/#port-blocking) — Node fetch 가 'bad port' 로 거절한다
const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const newToken = () => crypto.randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 시험이 stop() 없이 끝나도(실패·Ctrl+C) 서버 프로세스와 임시 폴더를 남기지 않는다
const live = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  process.on('exit', () => { for (const s of live) s.killNow(); });
  process.once('SIGINT', () => { for (const s of live) s.killNow(); process.exit(130); });
}

function setAi(env, ai) {
  if (ai !== 'off' && ai !== 'mock') throw new Error(`ai 는 'off' 또는 'mock' 입니다: ${ai}`);
  delete env.HWPX_COWORK_AI; delete env.HWPX_COWORK_AI_MOCK;
  if (ai === 'off') env.HWPX_COWORK_AI = 'off'; else env.HWPX_COWORK_AI_MOCK = '1';
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.kill(); } catch { clearTimeout(t); resolve(); }
  });
}

/** 서버 프로세스 하나 띄우기. ready → { port, nonce }(port 0 이면 stdout 두 줄에서, 아니면 시작 알림 줄을 보고) */
function launch({ env, port, startTimeoutMs, onOutput }) {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root, env: { ...env, HWPX_COWORK_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const lines = [];
  let notify = () => {};
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (l) => { lines.push(l); onOutput(`${l}\n`); notify(); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => onOutput(s));
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, v) => {
      if (settled) return; settled = true; notify = () => {};
      clearTimeout(timer); child.off('exit', onExit); child.off('error', onError);
      if (err) reject(err); else resolve(v);
    };
    const onExit = (code, sig) => finish(new Error(`서버가 시작하다 끝났습니다(code ${code}, signal ${sig})`));
    const onError = (e) => finish(e);
    const timer = setTimeout(() => finish(new Error(`서버가 ${startTimeoutMs}ms 안에 뜨지 않았습니다`)), startTimeoutMs);
    child.once('exit', onExit); child.once('error', onError);
    notify = () => {
      if (port === 0) {
        if (lines.length && !/^LISTENING \d+$/.test(lines[0])) return finish(new Error(`stdout 첫 줄이 'LISTENING <port>' 가 아닙니다: ${lines[0]}`));
        if (lines.length < 2) return undefined;
        const m = /^NONCE ([0-9a-f]{8,})$/.exec(lines[1]);
        if (!m) return finish(new Error(`stdout 둘째 줄이 'NONCE <hex>' 가 아닙니다: ${lines[1]}`));
        return finish(null, { port: Number(lines[0].slice('LISTENING '.length)), nonce: m[1] });
      }
      if (lines.some((l) => l.startsWith('[hwpx-cowork '))) finish(null, { port, nonce: null });
      return undefined;
    };
  });
  return { child, lines, rl, ready };
}

/** /api/config 를 받아 온다: nonce 가 있고(옛 nonce 와 달라야 하면 다를 때까지) — 남은 옛 서버의 응답을 받지 않게 */
async function fetchConfig(base, notNonce, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs; let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.ok) { const c = await r.json(); if (c.nonce && c.nonce !== notNonce) return c; last = `nonce ${c.nonce}`; } else last = `HTTP ${r.status}`;
    } catch (e) { last = e.message; }
    await sleep(100);
  }
  throw new Error(`${base}/api/config 에서 이 서버의 nonce 를 받지 못했습니다(${last})`);
}

/**
 * startServer({ ai, port, users, env, config, log, startTimeoutMs })
 *   ai      'off'(기본: HWPX_COWORK_AI=off — 밖에서 받은 HWPX_COWORK_AI_MOCK=1 보다 우선) | 'mock'(HWPX_COWORK_AI_MOCK=1)
 *   port    0(기본, 빈 포트) 또는 고정 포트
 *   users   [{ name, role, token? }] — 없으면 관리자 + 편집자 a(홍길동)·b(김검토). 토큰이 없으면 새로 만든다
 *   env     서버에 더 줄 환경 변수(예: { HWPX_COWORK_STUDIO_DIR: 빈 폴더 }). 값이 null 이면 지운다.
 *           밖(process.env)의 HWPX_COWORK_* 는 넘기지 않는다.
 *   config  임시 config 에 덧붙일 값(예: { studio: { mode: 'remote' }, studioUrl: '…' })
 *   log     서버 출력을 덧붙여 쓸 파일 경로(선택)
 * → { base, port, nonce, config(/api/config 응답), users: { admin, a, b }, tokens: { admin, a, b }, userList,
 *     dataDir, configPath, tmpDir, child, lines(stdout 줄), output(), api(who), restart({ ai }), stop() }
 */
export async function startServer({ ai = 'off', port = 0, users, env: moreEnv = {}, config: moreConfig = {}, log, startTimeoutMs = 30000 } = {}) {
  hookExit();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-srv-'));
  const dataDir = path.join(tmpDir, 'data');
  const configPath = path.join(tmpDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const userList = (users || [
    { name: '관리자', role: 'admin' },
    { name: '홍길동', role: 'editor' },
    { name: '김검토', role: 'editor' },
  ]).map((u) => ({ role: 'editor', ...u, token: u.token || newToken() }));
  const editors = userList.filter((u) => u.role !== 'admin');
  const named = { admin: userList.find((u) => u.role === 'admin') || null, a: editors[0] || null, b: editors[1] || null };
  const tokens = { admin: named.admin?.token ?? null, a: named.a?.token ?? null, b: named.b?.token ?? null };

  const cfg = {
    host: '127.0.0.1', port, dataDir: './data', allowAgentApply: true, users: userList,
    // 키 파일은 없는 경로: 어떤 경우에도 실제 API 를 부르지 않는다(이 PC 에는 키가 없다 — 모의 AI 로만 시험)
    ai: { enabled: false, mock: false, keyFile: path.join(tmpDir, 'no-such-key.txt'), model: 'claude-opus-5-5', effort: 'medium', maxProposals: 10 },
    studio: { mode: 'local' }, agents: { leaseMinutes: 15, othersCanTake: false }, changeRequests: { requireApprovals: 1 },
    ...moreConfig,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 1));

  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^HWPX_COWORK_/i.test(k)) env[k] = v;
  Object.assign(env, { HWPX_COWORK_CONFIG: configPath, HWPX_COWORK_DATA_DIR: dataDir, HWPX_COWORK_HOST: '127.0.0.1' });
  // 후보 시험은 편집기와 서버 차례 경로도 같은 고정 패키지를 소비한다.
  if (process.env.RHWP_PKG) env.HWPX_COWORK_ENGINE_PKG = path.resolve(root, process.env.RHWP_PKG);
  setAi(env, ai);
  for (const [k, v] of Object.entries(moreEnv)) { if (v == null) delete env[k]; else env[k] = String(v); }

  let text = '';
  const logFd = log ? fs.openSync(log, 'a') : null;
  const onOutput = (s) => {
    text += s; if (text.length > OUTPUT_MAX) text = text.slice(-OUTPUT_MAX);
    if (logFd != null) { try { fs.writeSync(logFd, s); } catch { /* ignore */ } }
  };

  let cur = null; let stopped = false;
  const srv = {
    base: null, port: null, nonce: null, config: null,
    users: named, tokens, userList, dataDir, configPath, tmpDir, child: null, lines: [],
    output: () => text,
    /** who: 'admin'|'a'|'b' 또는 사용자 객체·토큰 문자열, null 이면 토큰 없이 */
    api: (who) => api(srv.base, who == null ? null : (typeof who === 'object' ? who.token : (tokens[who] ?? who))),
    async restart({ ai: ai2 } = {}) {
      if (stopped) throw new Error('이미 멈춘 서버입니다');
      const oldNonce = srv.nonce;
      await killChild(cur.child); cur.rl.close();
      if (ai2) setAi(env, ai2);
      await boot(srv.port, oldNonce);
      return srv;
    },
    async stop() {
      if (stopped) return; stopped = true; live.delete(srv);
      await killChild(cur?.child); cur?.rl.close();
      if (logFd != null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
      // 임시 폴더를 못 지워도 시험 실패로 치지 않는다(srv.cleanupError 에 남김)
      try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { srv.cleanupError = e; }
    },
    killNow() {
      try { cur?.child.kill(); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 프로세스가 아직 잡고 있으면 남는다 */ }
    },
  };

  async function boot(p, oldNonce) {
    cur = launch({ env, port: p, startTimeoutMs, onOutput });
    srv.child = cur.child; srv.lines = cur.lines;
    try {
      let info = await cur.ready;
      // 빈 포트로 받은 번호가 fetch(undici)가 막는 포트(6666 등)면 fetch 가 'bad port' 로 실패한다 — 다른 빈 포트로 다시 띄운다
      for (let i = 0; p === 0 && FETCH_BAD_PORTS.has(info.port) && i < 5; i++) {
        await killChild(cur.child); cur.rl.close();
        cur = launch({ env, port: 0, startTimeoutMs, onOutput });
        srv.child = cur.child; srv.lines = cur.lines;
        info = await cur.ready;
      }
      const base = `http://127.0.0.1:${info.port}`;
      const conf = await fetchConfig(base, oldNonce);
      if (info.nonce && conf.nonce !== info.nonce) throw new Error(`nonce 가 다릅니다(띄운 서버 ${info.nonce}, 응답 ${conf.nonce}) — 그 포트에 다른 서버가 있습니다`);
      Object.assign(srv, { base, port: info.port, nonce: conf.nonce, config: conf });
    } catch (e) {
      await killChild(cur.child);
      e.message += `\n--- 서버 출력(끝) ---\n${text.slice(-3000)}`;
      throw e;
    }
  }

  live.add(srv);
  try { await boot(port, null); } catch (e) { await srv.stop().catch(() => {}); throw e; }
  return srv;
}

/**
 * api(base, token) → (경로, 옵션) => 본문(JSON 이면 객체, text/* 면 글, 그 밖은 Buffer). 2xx 가 아니면 던진다.
 *   .res(경로, 옵션) → { status, ok, data, headers } (던지지 않음 — 오류 코드 확인용)
 *   옵션: { method, body, headers, token } — body 가 Buffer·Uint8Array 면 그대로(기본 application/octet-stream), 그 밖은 JSON
 */
export function api(base, token) {
  const res = async (p, { method = 'GET', body, headers = {}, token: tk = token } = {}) => {
    const h = { ...headers };
    const hasType = Object.keys(h).some((k) => k.toLowerCase() === 'content-type');
    if (tk) h.Authorization = `Bearer ${tk}`;
    let b;
    if (body !== undefined) {
      if (body instanceof Uint8Array || body instanceof ArrayBuffer) { b = body; if (!hasType) h['Content-Type'] = 'application/octet-stream'; }
      else { b = JSON.stringify(body); if (!hasType) h['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(new URL(p, base), { method, headers: h, body: b });
    const ct = r.headers.get('content-type') || '';
    const data = /json/i.test(ct) ? await r.json() : /^text\//i.test(ct) ? await r.text() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, data, headers: r.headers };
  };
  const call = async (p, opts = {}) => {
    const r = await res(p, opts);
    if (!r.ok) {
      const d = typeof r.data === 'string' ? r.data : Buffer.isBuffer(r.data) ? `(${r.data.length}B)` : JSON.stringify(r.data);
      throw new Error(`${opts.method || 'GET'} ${p} → ${r.status} ${d.slice(0, 300)}`);
    }
    return r.data;
  };
  call.res = res;
  return call;
}

/** 문서 올리기: file 은 경로(문자열) 또는 바이트 → 문서 요약 { id, title, version, … } */
export async function uploadDoc(base, token, file, name) {
  const bytes = typeof file === 'string' ? fs.readFileSync(file) : file;
  const fileName = name || (typeof file === 'string' ? path.basename(file) : 'document.hwpx');
  return api(base, token)('/api/docs', { method: 'POST', body: bytes, headers: { 'x-file-name': encodeURIComponent(fileName) } });
}

/** 문서 방 WebSocket 구독 → { msgs, ready, waitFor(조건, ms), close() } */
export function watchWs(base, token, docId) {
  const u = new URL('/ws', base); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token); u.searchParams.set('doc', docId);
  const ws = new WebSocket(u);
  const msgs = []; const waiters = new Set();
  ws.on('message', (m) => { let j; try { j = JSON.parse(String(m)); } catch { return; } msgs.push(j); for (const w of [...waiters]) w(); });
  ws.on('error', () => { /* ready 가 받는다 */ });
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('WebSocket 이 열리기 전에 닫혔습니다'))); });
  ready.catch(() => {});
  function waitFor(pred, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const check = () => { const hit = msgs.find(pred); if (!hit) return false; done(); resolve(hit); return true; };
      const t = setTimeout(() => { done(); reject(new Error('WebSocket 메시지를 기다리다 시간 초과')); }, timeoutMs);
      const done = () => { clearTimeout(t); waiters.delete(check); };
      if (!check()) waiters.add(check);
    });
  }
  return { ws, msgs, ready, waitFor, close: () => ws.close() };
}
