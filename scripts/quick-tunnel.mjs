// Cloudflare Quick Tunnel(임시 https://….trycloudflare.com 주소)로 이 PC 서버를 인터넷에 잠깐 연다.
// 켜면 발급 주소를 서버 공유 주소(publicUrl)로 저장하고 서버를 다시 시작한다. 끄면(Ctrl+C·창 닫기·터널 끊김) 공유 주소를 비워 로컬로 되돌린다.
//   node scripts/quick-tunnel.mjs [--cloudflared <cloudflared.exe>]      (두 번 클릭은 start-tunnel.bat)
// · 계정·도메인이 필요 없는 대신(Cloudflare 공식 제한) 켤 때마다 주소가 바뀌고, 동시 요청 200개, SSE 미지원, 가동 보장 없음.
//   웹 공동 편집은 WebSocket 이라 되지만 SSE 를 쓰는 원격 MCP 스트림·원격 채널 알림은 안 된다. 이 PC 의 에이전트는 localhost 로 붙으므로 상관없다.
// · 관리자 토큰은 config.json 의 첫 관리자(없으면 HWPX_COWORK_TOKEN). 토큰·주소 외 설정은 건드리지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (s = '') => console.log(s);
const err = (s) => console.error(`[오류] ${s}`);

// api.trycloudflare.com 은 발급 요청 주소(실패 로그에 나온다)라 빼고 찾는다
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/** cloudflared 로그 한 줄에서 발급 주소 → 'https://….trycloudflare.com' 또는 null */
export function parseTunnelUrl(line) {
  const m = TUNNEL_URL.exec(String(line));
  return m ? m[0].toLowerCase() : null;
}

/** cloudflared 가 터널 연결을 하나라도 맺었는지(이 뒤로 발급 주소가 실제로 응답한다) */
export const isRegistered = (line) => /Registered tunnel connection/i.test(line);

/** 서버 듣는 주소 → cloudflared 가 붙을 주소의 호스트(모든 주소로 들으면 127.0.0.1 — Go 는 localhost 를 ::1 로 먼저 풀 수 있다) */
export function originHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h === '0.0.0.0' || h === '::' || h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  return h.includes(':') ? `[${h}]` : h;
}

/** config 원본에서 관리자 토큰 → 토큰 또는 null */
export function adminToken(raw, env = process.env) {
  const admin = (Array.isArray(raw?.users) ? raw.users : []).find((u) => u?.role === 'admin' && typeof u.token === 'string' && u.token);
  return admin?.token || env.HWPX_COWORK_TOKEN || null;
}

/** config.json(HWPX_COWORK_CONFIG·HWPX_COWORK_PORT 반영) → { port, host, token } */
export function readLocalSettings(env = process.env) {
  const file = env.HWPX_COWORK_CONFIG ? path.resolve(root, env.HWPX_COWORK_CONFIG) : path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return { port: Number(env.HWPX_COWORK_PORT || (raw.port ?? 8787)), host: env.HWPX_COWORK_HOST || raw.host || '127.0.0.1', token: adminToken(raw, env) };
}

/** cloudflared 실행 파일 찾기: CLOUDFLARED → PATH → winget 기본 설치 폴더. 못 찾으면 null */
export function findCloudflared({ env = process.env, exists = fs.existsSync, which = whichCloudflared } = {}) {
  if (env.CLOUDFLARED) return exists(env.CLOUDFLARED) ? env.CLOUDFLARED : null;
  const found = which();
  if (found) return found;
  const bases = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  return bases.map((b) => path.join(b, 'cloudflared', 'cloudflared.exe')).find((p) => exists(p)) || null;
}

function whichCloudflared() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null : null;
}

/** 관리 API 호출기. 2xx 가 아니면 { code, status } 를 단 오류를 던진다 */
export function adminClient(base, token, fetchImpl = globalThis.fetch) {
  return async (method, p, body) => {
    const res = await fetchImpl(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.error, status: res.status });
    return data;
  };
}

/**
 * 공유 주소를 저장하고, 실행 중인 서버와 다르면 다시 시작한다.
 * expect 를 주면(되돌릴 때) 저장된 주소가 그 값일 때만 바꾼다 — 그사이 관리자가 다른 주소로 바꿨으면 그대로 둔다.
 * → { locked } | { skipped } | { restarted, restartUnsupported }
 */
export async function applyPublicUrl(call, url, { expect } = {}) {
  const snap = await call('GET', '/api/admin/server');
  if (snap.overrides?.publicUrl?.locked) return { locked: true };
  if (expect !== undefined && snap.saved.publicUrl !== expect) return { skipped: true };
  const current = snap.saved.publicUrl === url ? snap : await call('PATCH', '/api/admin/server', { settings: { publicUrl: url }, revision: snap.revision });
  if (!current.restartRequired) return { restarted: false };
  if (!current.restart?.supported) return { restarted: false, restartUnsupported: true };
  await call('POST', '/api/admin/restart', { revision: current.revision });
  return { restarted: true };
}

/** 다시 시작한 서버가 running.publicUrl 을 바꿀 때까지 기다린다(재시작 중 연결 실패는 넘긴다) → 맞으면 true */
export async function waitRunning(call, ok, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (ok((await call('GET', '/api/admin/server')).running.publicUrl)) return true; } catch { /* 재시작 중 */ }
    await sleep(intervalMs);
  }
  return false;
}

/** 발급 주소가 인터넷 쪽에서 이 서버로 응답하는지(새 주소는 DNS 가 퍼지는 데 몇 초 걸린다) */
async function reachable(url, { timeoutMs = 45000, fetchImpl = globalThis.fetch } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetchImpl(`${url}/api/config`, { signal: AbortSignal.timeout(8000) });
      if (res.ok && (await res.json().catch(() => null))?.name === 'hwpx-cowork') return true;
    } catch { /* 아직 */ }
    await sleep(2000);
  }
  return false;
}

function parseArgs(argv) {
  const o = { cloudflared: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') o.help = true;
    else if (argv[i] === '--cloudflared') o.cloudflared = argv[++i] || null;
    else o.unknown.push(argv[i]);
  }
  return o;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  if (o.help) { out('node scripts/quick-tunnel.mjs [--cloudflared <cloudflared.exe>]\nCloudflare Quick Tunnel 로 이 PC 서버를 임시 HTTPS 주소에 연다. 끄면 공유 주소를 로컬로 되돌린다.'); return 0; }
  if (o.unknown.length) { err(`모르는 인자: ${o.unknown.join(' ')} (--help)`); return 2; }

  let local;
  try { local = readLocalSettings(env); } catch { err('config.json 을 읽지 못했습니다.'); return 1; }
  const base = `http://${originHost(local.host)}:${local.port}`;
  try { await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(3000) }); } catch { err(`서버가 꺼져 있습니다(${base}). start-server.bat 로 먼저 켜세요.`); return 1; }
  if (!local.token) { err('관리자 토큰을 찾지 못했습니다(config.json 의 role "admin" 사용자 또는 HWPX_COWORK_TOKEN).'); return 1; }
  const call = adminClient(base, local.token);
  try { await call('GET', '/api/admin/server'); } catch (e) { err(e.status === 403 ? '관리자 토큰이 아닙니다 — 공유 주소를 바꿀 수 없습니다.' : `관리 API 에 붙지 못했습니다: ${e.message}`); return 1; }

  const exe = o.cloudflared || findCloudflared({ env });
  if (!exe) { err('cloudflared 가 없습니다. 한 번만 설치하세요:  winget install --id Cloudflare.cloudflared -e'); return 1; }
  // ~/.cloudflared/config.yml 이 있으면 Quick Tunnel 이 그 설정을 읽어 실패한다(정식 터널 설정)
  const named = ['config.yml', 'config.yaml'].map((n) => path.join(os.homedir(), '.cloudflared', n)).find((p) => fs.existsSync(p));
  if (named) { err(`${named} 이 있어 Quick Tunnel 을 열 수 없습니다. 정식 터널을 쓰는 중이면 그 터널을 쓰고, 아니면 파일 이름을 바꾼 뒤 다시 실행하세요.`); return 1; }

  out(`Cloudflare Quick Tunnel 을 엽니다 → ${base}`);
  const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', base], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let url = null; let applied = false; let stopping = null;

  const finish = (code) => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (applied) {
        try {
          const r = await applyPublicUrl(call, '', { expect: url });
          out(r.skipped ? '공유 주소가 그사이 바뀌어 그대로 두었습니다.' : r.restartUnsupported ? '공유 주소를 비웠습니다 — 서버를 다시 켜야 로컬로 돌아갑니다.' : '공유 주소를 로컬로 되돌렸습니다.');
        } catch (e) { err(`공유 주소를 되돌리지 못했습니다(${e.message}). 관리자 화면에서 공유 주소를 비우세요.`); }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await Promise.race([gone, sleep(5000)]);
      }
      process.exit(code);
    })();
    return stopping;
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { out('\n터널을 끕니다...'); finish(0); });
  // 데스크톱 앱이 띄운 경우: Windows 에서는 신호로 끌 수 없어(강제 종료 → 공유 주소가 남는다) IPC 'stop'·부모 끊김으로 정상 종료한다
  if (process.connected) {
    process.on('message', (m) => { if (m === 'stop') finish(0); });
    process.once('disconnect', () => finish(0));
  }
  child.on('error', (e) => { err(`cloudflared 를 실행하지 못했습니다: ${e.message}`); finish(1); });
  child.on('exit', (code) => { if (!stopping) { err(`터널이 끊겼습니다(cloudflared 종료 코드 ${code}). 다시 켜면 새 주소가 나옵니다.`); finish(1); } });

  const opened = setTimeout(() => { if (!applied) { err('60초 안에 터널이 열리지 않았습니다. 인터넷·방화벽(UDP 7844 / TCP 443)을 확인하세요.'); finish(1); } }, 60000);
  const onLine = async (line) => {
    url ||= parseTunnelUrl(line);
    if (/\b(ERR|WRN)\b/.test(line)) console.error(`[cloudflared] ${line.replace(/^\S+\s+/, '')}`);
    if (!url || applied || stopping || !isRegistered(line)) return;
    applied = true; clearTimeout(opened);
    let r;
    try { r = await applyPublicUrl(call, url); } catch (e) { err(`공유 주소를 저장하지 못했습니다: ${e.message}`); finish(1); return; }
    if (r.locked) out('[주의] 서버의 공유 주소가 환경 변수 HWPX_COWORK_PUBLIC_URL 로 고정되어 있어 바꾸지 않았습니다. 웹 접속은 되지만 안내·OAuth 주소는 예전 값입니다.');
    else if (r.restartUnsupported) out('[주의] 공유 주소는 저장했지만 이 서버는 웹 재시작을 못 합니다 — start-server.bat 로 다시 켜야 반영됩니다.');
    else if (r.restarted) out((await waitRunning(call, (u) => u === url)) ? '공유 주소를 저장하고 서버를 다시 시작했습니다.' : '[주의] 서버 재시작을 확인하지 못했습니다. 서버 창을 보세요.');
    out(`
 인터넷 주소(임시) — 이 창을 켜 둔 동안만 열립니다
   - 웹:  ${url}/
   - MCP: ${url}/mcp
   - 끄기: Ctrl+C 또는 이 창 닫기 → 공유 주소가 로컬(http://localhost:${local.port})로 돌아갑니다
   - 켤 때마다 주소가 바뀝니다. ChatGPT 등 외부 연결은 새 주소로 다시 등록하세요.
   - 제한: 동시 요청 200개, SSE 스트림 안 됨(웹 공동 편집은 됨), 가동 보장 없음
`);
    out((await reachable(url)) ? '인터넷 쪽에서 응답을 확인했습니다.' : '[주의] 아직 인터넷 쪽 응답을 확인하지 못했습니다(DNS 가 늦게 퍼질 수 있음). 잠시 뒤 브라우저로 열어 보세요.');
  };
  for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => { onLine(l).catch((e) => err(e.message)); });
  return new Promise(() => {});   // 끝내기는 finish() 의 process.exit
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().then((code) => { if (code) process.exit(code); });
