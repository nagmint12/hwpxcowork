// [hwpx-cowork 포터블] 관리자 앱 — 이 PC 에서만 열리는 관리 창에서 서버를 켜고·끄고·다시 켠다. 편집 화면(사용자 앱)과 따로 연다.
//   node app/portable/manager.mjs   → 관리자 앱이 이미 떠 있으면 관리 창만 다시 열고 끝. 아니면 관리 서버(127.0.0.1, 빈 포트)를 띄우고
//                                     서버를 켠 뒤(HWPX_COWORK_MANAGER_AUTOSTART=0 이면 켜지 않음) 관리 창을 연다(HWPX_COWORK_MANAGER_NO_WINDOW=1 이면 안 엶).
// 관리 API 는 창 주소의 #k=…(시작할 때마다 새로 뽑는 열쇠)를 X-Manager-Key 머리글로 받아야만 답한다. Host 가 127.0.0.1·localhost 가 아니면 거절한다
// (다른 웹 페이지의 요청·DNS 재바인딩 차단). 열쇠·포트는 userdata/manager.json(이 사용자만 읽기) — 다시 실행하면 같은 관리 앱을 찾는다.
// 서버는 server/launcher.js 의 startManagedServer 로 이 프로세스가 직접 관리한다 — 끄기는 저장 중 작업을 마치는 정상 종료(hwpx:stop).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { appDir, userDir, configFile, readConfig, writeConfig, portOf, prepareConfig, portState, freePort, adminToken, openWindow, TOKEN_RE, TOKEN_RULE, randomToken } from './portable-lib.mjs';

const here = path.join(appDir, 'portable');
const packageDir = path.resolve(appDir, '..');
const stateFile = path.join(userDir, 'manager.json');
const iconFile = path.join(appDir, 'web', 'favicon.ico');   // 이 창의 탭 아이콘(scripts/make-icons.mjs)
const shortcutIcon = path.join(appDir, 'web', 'icons', 'hwpx-cowork.ico');   // 바로 가기용 16~256px(scripts/make-icons.mjs)
const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 기록 ────────────────────────────────────────────────────────────────────
const lines = [];
const clock = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
function log(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(`${clock()}  ${line}`);
    if (lines.length > 600) lines.shift();
  }
}
function capture(child) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    stream.on('data', log);
  }
}

// ── 서버 켜기·끄기 ───────────────────────────────────────────────────────────
let controller = null;
let phase = 'stopped';   // stopped | starting | running | stopping
let startedAt = null;
let lastError = null;
let launcher = null;
let busy = Promise.resolve();
const serial = (job) => (busy = busy.then(job, job));   // 켜기·끄기를 겹치지 않게 차례로

const currentState = async () => { const cfg = readConfig(); const port = portOf(cfg); return { cfg, port, state: await portState(port, adminToken(cfg)) }; };
// 첫 실행: 관리자 토큰을 관리 창에서 직접 정할 때까지 설정을 만들지 않는다(HWPX_COWORK_ADMIN_TOKEN 을 주면 그 값으로 바로)
const needsSetup = () => !fs.existsSync(configFile);

async function startServer() {
  if (phase !== 'stopped') return;
  if (needsSetup()) { log('관리자 토큰을 먼저 정하세요.'); return; }
  const { moved } = await prepareConfig();
  if (moved) log(`포트 ${moved.from} 을 다른 프로그램이 쓰고 있어 ${moved.to} 을 씁니다.`);
  const { port, state } = await currentState();
  if (state === 'ours') { log(`이 폴더의 서버가 이미 다른 창에서 켜져 있습니다(포트 ${port}).`); return; }
  if (state !== 'free') {
    lastError = `포트 ${port} 을 ${state === 'other' ? '다른 hwpx-cowork 서버(예: 개발용 서버)가' : '다른 프로그램이'} 쓰고 있습니다`;
    log(lastError);
    return;
  }
  phase = 'starting';
  lastError = null;
  log('서버를 켭니다…');
  launcher ??= await import(pathToFileURL(path.join(appDir, 'server', 'launcher.js')).href);
  try {
    controller = await launcher.startManagedServer({
      root: appDir, stdio: 'pipe', handleSignals: false,
      env: { ...process.env, HWPX_COWORK_CONFIG: configFile, HWPX_COWORK_USERDATA: userDir },
      onSpawn: capture,
      onReady(info) { phase = 'running'; startedAt = Date.now(); log(`켜짐 — http://localhost:${info.port}/`); },
      onExit(code) {
        controller = null; startedAt = null;
        if (phase === 'running' && code) log(`서버가 멈췄습니다(종료 코드 ${code}).`);
        phase = 'stopped';
      },
    });
  } catch (error) {
    controller = null;
    phase = 'stopped';
    lastError = error.message;
    log(`켜지 못했습니다: ${error.message}`);
  }
}

/** 이 포터블의 서버를 실행 중인 다른 프로세스(start-server 로 켠 것)를 끈다 */
async function killExternal() {
  // Persist an intentional stop before any legacy forced-stop fallback.
  try {
    const { stopManagedServer } = await import(pathToFileURL(path.join(appDir, 'server/control-cli.js')).href);
    const result = await stopManagedServer({ root: appDir, env: { ...process.env, HWPX_COWORK_CONFIG: configFile } });
    if (result.ok) return;
  } catch { /* Older launchers have no control pipe; the existing scoped fallback follows. */ }
  const keys = ['launcher.js', 'index.js'].map((f) => path.join(appDir, 'server', f).toLowerCase());
  if (process.platform === 'win32') {
    const script = `$keys = $env:HWPX_KEYS -split '\\|'; $p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and ($c = $_.CommandLine.ToLowerInvariant()) -and ($keys | Where-Object { $c.Contains($_) }) }); foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count`;
    return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', script], { env: { ...process.env, HWPX_KEYS: keys.join('|') }, windowsHide: true }, () => resolve()));
  }
  for (const entry of fs.existsSync('/proc') ? fs.readdirSync('/proc') : []) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').toLowerCase();
      if (keys.some((k) => cmd.includes(k))) process.kill(Number(entry), 'SIGTERM');
    } catch { /* 이미 끝난 프로세스 */ }
  }
  return Promise.resolve();
}

async function stopServer() {
  if (controller) {
    phase = 'stopping';
    log('서버를 끕니다(저장 중인 작업을 마친 뒤)…');
    await controller.stop();
    log('서버를 껐습니다.');
    return;
  }
  if ((await currentState()).state !== 'ours') return;   // 다른 설치본·다른 프로그램은 끄지 않는다
  log('다른 창에서 켠 서버를 끕니다…');
  await killExternal();
  for (let i = 0; i < 20 && (await currentState()).state === 'ours'; i++) await sleep(250);
  log((await currentState()).state === 'ours' ? '다른 창의 서버를 끄지 못했습니다.' : '서버를 껐습니다.');
}

/** 포트가 다른 프로그램과 겹칠 때: 빈 포트로 설정을 바꾸고 켠다(사람이 누른 경우만) */
async function useFreePort() {
  if (phase !== 'stopped' || (await currentState()).state === 'ours') return;
  const cfg = readConfig();
  const to = await freePort(portOf(cfg) + 1);
  writeConfig({ ...cfg, port: to });
  log(`포트를 ${to} 으로 바꿨습니다(MCP·참여자 주소도 바뀝니다).`);
  await startServer();
}

// ── 상태 ────────────────────────────────────────────────────────────────────
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}
/** 관리자 토큰 바꾸기: 서버가 켜져 있으면 서버의 관리자 API 로(설정·실행 중 사용자 함께 바뀜), 꺼져 있으면 설정 파일을 직접 고친다 */
async function changeAdminToken(given) {
  if (given && !TOKEN_RE.test(given)) throw Object.assign(new Error(`토큰 형식이 아닙니다(${TOKEN_RULE})`), { status: 400 });
  const token = given || randomToken();
  const { cfg, port, state } = await currentState();
  const current = adminToken(cfg);
  if (state === 'ours') {
    const call = async (p, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${current}`, 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.message || body.error || `오류 ${res.status}`), { status: res.status });
      return body;
    };
    const list = await call('/api/admin/users');
    const me = list.users.find((u) => u.me);
    await call(`/api/admin/users/${encodeURIComponent(me.name)}/token`, { method: 'POST', body: JSON.stringify({ revision: list.revision, token }) });
  } else {
    const users = (cfg.users || []).map((u) => ({ ...u }));
    const admin = users.find((u) => u.role === 'admin');
    if (users.some((u) => u !== admin && u.token === token)) throw Object.assign(new Error('다른 사용자가 쓰는 토큰입니다'), { status: 409 });
    admin.token = token;
    writeConfig({ ...cfg, users });
  }
  log('관리자 토큰을 바꿨습니다.');
  return token;
}

async function status() {
  if (needsSetup()) return { phase: 'setup', needsSetup: true, version, node: process.version, platform: process.platform, userDir, lan: [], shortcuts: false, tokenRule: TOKEN_RULE };
  const { cfg, port, state } = await currentState();
  const effective = phase !== 'stopped' ? phase : state === 'ours' ? 'external' : state === 'free' ? 'stopped' : 'conflict';
  const host = process.env.HWPX_COWORK_HOST || cfg.host || '127.0.0.1';
  const everywhere = host === '0.0.0.0' || host === '::';
  const publicUrl = (process.env.HWPX_COWORK_PUBLIC_URL || cfg.publicUrl || '').replace(/\/$/, '') || null;
  const lan = everywhere ? lanAddresses().map((ip) => `http://${ip}:${port}/`) : [];
  return {
    phase: effective, port, host, version, node: process.version, platform: process.platform, userDir, startedAt, lastError,
    local: `http://localhost:${port}/`, lan, publicUrl, mcp: `${publicUrl || `http://localhost:${port}`}/mcp`,
    participantUrl: publicUrl ? `${publicUrl}/` : (lan[0] || `http://localhost:${port}/`),
    shortcuts: process.platform === 'win32', tokenRule: TOKEN_RULE,
  };
}

// ── 참여자용 사용자 앱 ZIP ────────────────────────────────────────────────────
async function userAppZip(serverUrl) {
  const zip = new JSZip();
  const dir = path.join(here, 'user-app');
  for (const name of fs.readdirSync(dir)) {
    let bytes = fs.readFileSync(path.join(dir, name));
    if (name === 'server-url.txt') bytes = Buffer.from(bytes.toString('utf8').replace('__SERVER_URL__', serverUrl), 'utf8');
    zip.file(`hwpx-cowork-user-app/${name}`, bytes);
  }
  const icon = [shortcutIcon, iconFile].find((f) => fs.existsSync(f));
  if (icon) zip.file('hwpx-cowork-user-app/hwpx-cowork.ico', fs.readFileSync(icon));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function runShortcut(args) {
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'user-app', 'make-shortcut.ps1'), ...args],
    { windowsHide: true }, (error, stdout) => resolve({ ok: !error, message: String(stdout || error?.message || '').trim() })));
}

function openFolder(dir) {
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref();
}

// ── 관리 서버 ────────────────────────────────────────────────────────────────
const key = crypto.randomBytes(24).toString('base64url');
let managerPort = 0;
const html = fs.readFileSync(path.join(here, 'manager.html'));
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
const keyOk = (value) => {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
async function readJson(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 10000) throw new Error('too large'); }
  return text ? JSON.parse(text) : {};
}

async function handle(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${managerPort}` && host !== `localhost:${managerPort}`) return send(res, 403, { error: 'host' });
  const url = new URL(req.url, `http://${host}`);
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
  if (req.method === 'GET' && url.pathname === '/favicon.ico' && fs.existsSync(iconFile)) return send(res, 200, fs.readFileSync(iconFile), 'image/x-icon');
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
  if (!keyOk(req.headers['x-manager-key'])) return send(res, 403, { error: 'key' });
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/ping') return send(res, 200, { ok: true, pid: process.pid });
  if (route === 'GET /api/status') return send(res, 200, await status());
  if (route === 'GET /api/logs') return send(res, 200, { lines });
  if (route === 'POST /api/setup') {
    if (!needsSetup()) return send(res, 409, { error: '이미 설정했습니다' });
    const { token } = await readJson(req);
    if (token && (typeof token !== 'string' || !TOKEN_RE.test(token))) return send(res, 400, { error: `토큰 형식이 아닙니다(${TOKEN_RULE})` });
    await serial(async () => {
      const { moved } = await prepareConfig(token || '');
      log(token ? '관리자 토큰을 정했습니다.' : '관리자 토큰을 자동으로 만들었습니다.');
      if (moved) log(`포트 ${moved.from} 을 다른 프로그램이 쓰고 있어 ${moved.to} 을 씁니다.`);
      await startServer();
    });
    return send(res, 200, await status());
  }
  if (needsSetup() && route !== 'POST /api/quit') return send(res, 409, { error: '관리자 토큰을 먼저 정하세요' });
  if (route === 'POST /api/start') { await serial(startServer); return send(res, 200, await status()); }
  if (route === 'POST /api/stop') { await serial(stopServer); return send(res, 200, await status()); }
  if (route === 'POST /api/restart') { await serial(async () => { await stopServer(); await startServer(); }); return send(res, 200, await status()); }
  if (route === 'POST /api/use-free-port') { await serial(useFreePort); return send(res, 200, await status()); }
  if (route === 'GET /api/admin-token') return send(res, 200, { token: adminToken(readConfig()) });
  if (route === 'POST /api/admin-token') {
    const { token } = await readJson(req);
    try { return send(res, 200, { token: await serial(() => changeAdminToken(typeof token === 'string' ? token.trim() : '')) }); }
    catch (error) { return send(res, error.status || 500, { error: error.message }); }
  }
  if (route === 'POST /api/open') {
    const { what } = await readJson(req);
    const s = await status();
    if (what === 'web') { if (s.phase !== 'running' && s.phase !== 'external') return send(res, 409, { error: '서버가 꺼져 있습니다' }); openWindow(s.local); }
    else if (what === 'folder') openFolder(userDir);
    else return send(res, 400, { error: 'what' });
    return send(res, 200, { ok: true });
  }
  if (route === 'POST /api/shortcuts') {
    if (process.platform !== 'win32') return send(res, 400, { error: 'Windows 에서만 만듭니다' });
    const s = await status();
    const adminBat = path.join(packageDir, 'admin-app.bat');
    const results = [await runShortcut(['-Name', 'hwpx-cowork 관리자', '-Command', adminBat, '-Icon', iconFile]), await runShortcut(['-Name', 'hwpx-cowork', '-Url', s.local, '-Icon', iconFile])];
    return send(res, results.every((r) => r.ok) ? 200 : 500, { results });
  }
  if (route === 'GET /api/user-app.zip') {
    const target = url.searchParams.get('url') || (await status()).participantUrl;
    if (!/^https?:\/\/[^\s"'<>]+$/.test(target)) return send(res, 400, { error: '서버 주소가 올바르지 않습니다' });
    return send(res, 200, await userAppZip(target), 'application/zip', { 'Content-Disposition': 'attachment; filename="hwpx-cowork-user-app.zip"' });
  }
  if (route === 'POST /api/quit') {
    send(res, 200, { ok: true });
    setTimeout(() => void shutdown(0), 50);
    return undefined;
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => { handle(req, res).catch((error) => { if (!res.headersSent) send(res, 500, { error: error.message }); }); });

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (controller) await stopServer(); } catch { /* 끄는 중 오류 */ }
  // fs.rmSync 는 Node 24.11 에서 한글 경로면 프로세스를 죽인다 — unlink 만 쓴다(server/fs-safe.js 참고)
  try { if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid === process.pid) fs.unlinkSync(stateFile); } catch { /* 없음 */ }
  server.close();
  process.exit(code);
}

async function existingManager() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${s.port}/api/ping`, { headers: { 'x-manager-key': s.key }, signal: AbortSignal.timeout(1500) });
    return res.ok ? s : null;
  } catch { return null; }
}
const adminUrl = (port, k) => `http://127.0.0.1:${port}/#k=${k}`;

if (process.env.HWPX_COWORK_ADMIN_TOKEN) await prepareConfig();   // 토큰을 미리 준 경우만 바로 설정을 만든다(없으면 관리 창에서 정함)
const running = await existingManager();
if (running) {
  console.log('관리자 앱이 이미 떠 있어 관리 창만 엽니다.');
  if (process.env.HWPX_COWORK_MANAGER_NO_WINDOW !== '1') openWindow(adminUrl(running.port, running.key), { width: 760, height: 900 });
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => void shutdown(0));
server.listen(Number(process.env.HWPX_COWORK_MANAGER_PORT || 0), '127.0.0.1', () => {
  managerPort = server.address().port;
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ port: managerPort, key, pid: process.pid }), { mode: 0o600 });
  console.log(`MANAGER ${managerPort}`);
  console.log('');
  console.log(' hwpx-cowork 관리자 앱');
  console.log('  - 관리 창에서 서버를 켜고 끕니다. 이 창을 닫으면 서버도 꺼집니다(작업 표시줄에 최소화해 두세요).');
  console.log(`  - 관리 창을 닫았다면 admin-app 을 다시 실행하세요. 설정·문서: ${userDir}`);
  log(`관리자 앱 시작 (hwpx-cowork ${version}, Node ${process.version})`);
  if (process.env.HWPX_COWORK_MANAGER_AUTOSTART !== '0') void serial(startServer);
  if (process.env.HWPX_COWORK_MANAGER_NO_WINDOW !== '1') openWindow(adminUrl(managerPort, key), { width: 760, height: 900 });
});
