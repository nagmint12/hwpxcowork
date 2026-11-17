#!/usr/bin/env node
// [hwpx-cowork 개인용 앱] 이 PC 에서만 열리는 서버를 켜고 앱 창을 연다 — 중앙 서버 없이 내 PC 폴더의 HWPX 를 열어 고친다
// (docs/LOCAL_FOLDER_APP_2026-11-10.md). 배포물에서는 app/portable/personal.mjs, 개발 폴더에서는 `npm run personal`.
//   node app/portable/personal.mjs [폴더 …] [--folder <폴더>] [--port <번호>] [--name <이름>] [--ai "<실행기 인자>"] [--no-window] [--keep]
//     폴더        연결할 PC 폴더(여러 개). 처음 실행하고 폴더를 주지 않았으면 폴더 고르기 창을 띄운다
//     --name      문서에 남는 내 이름(메모·변경 추적 작성자). 처음 실행 때만 — 기본은 이 PC 의 사용자 이름
//     --ai        개인 AI 실행기(scripts/ai-worker.mjs)를 함께 켠다. 예: --ai "--provider codex" (또는 config.json 의 personal.ai)
//     --no-window 앱 창을 열지 않는다(서버만). --keep 앱 창을 닫아도 끄지 않는다
//   설정·기록은 HWPX_COWORK_USERDATA(없으면 묶음 폴더의 userdata-personal/) — config.json(127.0.0.1, 사용자 한 명, local.enabled), data/(문서 기록).
//   문서 파일 자체는 연결한 PC 폴더에 있다. 이미 떠 있으면 앱 창만 하나 더 열고 끝난다.
//   환경 변수: HWPX_COWORK_BROWSER=default(전용 창 대신 기본 브라우저) · HWPX_COWORK_APP_WINDOW(앱 창에 더 줄 브라우저 인자)
//             HWPX_COWORK_PERSONAL_NO_WINDOW=1 · HWPX_COWORK_PERSONAL_KEEP=1(--no-window · --keep 과 같음)
//   끄기: 앱 창 닫기(전용 창으로 열었을 때) · 이 창 닫기 · Ctrl+C · 표준 입력에 quit
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 앱이 준비되는 동안 부모가 닫히거나 stop을 보내도 놓치지 않는다.
const desktopManaged = process.env.HWPX_COWORK_DESKTOP_MANAGED === '1';
let desktopStopRequested = false;
let desktopStop = () => { desktopStopRequested = true; };
if (desktopManaged) {
  process.on('message', message => { if (message === 'stop') desktopStop(); });
  process.once('disconnect', () => desktopStop());
}
// 배포물: <묶음>/app/portable → 프로그램 = <묶음>/app. 개발 폴더: <저장소>/deploy/portable → 프로그램 = <저장소>
const packaged = fs.existsSync(path.join(here, '..', 'server', 'launcher.js'));
export const appDir = packaged ? path.resolve(here, '..') : path.resolve(here, '..', '..');
const homeDir = packaged ? path.resolve(appDir, '..') : appDir;
export const userDir = path.resolve(process.env.HWPX_COWORK_USERDATA || path.join(homeDir, 'userdata-personal'));
process.env.HWPX_COWORK_USERDATA = userDir;
const { listening, freePort, randomToken, windowsBrowsers, openWindow } = await import('./portable-lib.mjs');

const configFile = path.join(userDir, 'config.json');
const DEFAULT_PORT = 8790;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
const say = (text) => console.log(`${clock()}  ${text}`);

export function parseArgs(argv) {
  const o = { folders: [], port: null, name: null, ai: null, noWindow: process.env.HWPX_COWORK_PERSONAL_NO_WINDOW === '1', keep: process.env.HWPX_COWORK_PERSONAL_KEEP === '1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --ai 의 값은 실행기 인자 묶음이라 '--provider …' 로 시작한다
    const value = (dashed = false) => { if (argv[i + 1] == null || (!dashed && argv[i + 1].startsWith('--'))) throw new Error(`${a} 뒤에 값이 필요합니다`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--folder') o.folders.push(value());
    else if (a === '--port') { o.port = Number(value()); if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port 는 1~65535 입니다'); }
    else if (a === '--name') o.name = value();
    else if (a === '--ai') o.ai = value(true);
    else if (a === '--no-window') o.noWindow = true;
    else if (a === '--keep') o.keep = true;
    else if (a.startsWith('--')) throw new Error(`모르는 인자: ${a}`);
    else o.folders.push(a);   // 배치 파일에 끌어다 놓은 폴더
  }
  return o;
}

/** 문서에 남는 이름: 준 이름 → 이 PC 의 사용자 이름 → '나'. 제어 글자를 빼고 40자까지 */
export function authorName(given) {
  let name = String(given ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) { try { name = os.userInfo().username || ''; } catch { name = ''; } }
  return [...(name || '나')].slice(0, 40).join('');
}

/** 개인용 앱의 첫 설정: 이 PC 만(127.0.0.1), 사용자 한 명(관리자 — 무작위 토큰), PC 폴더 연결 켬, 고치면 바로 저장(승인 없음), 서버 AI 끔 */
export function personalConfig(example, { name, port, token }) {
  const ai = { ...(example.ai || {}), enabled: false, mock: false };
  delete ai.keyFile;
  const cfg = {
    ...example, host: '127.0.0.1', port, dataDir: './data', ai,
    users: [{ name, token, role: 'admin' }],
    local: { enabled: true },
    changeRequests: { requireApprovals: 0, allowDirectApply: true },
    documents: { ...(example.documents || {}), defaultEditMode: 'realtime' },
    manuals: { seed: false },
    // 첫 화면은 내 PC 폴더다 — 체험(튜토리얼) 문서로 보내지 않는다(관리자 공유 AI 가 없는 1인용. 쓰려면 enabled 를 true 로)
    tutorial: { enabled: false },
    personal: { app: true },
  };
  delete cfg.studioUrl;   // 늘 묶인 편집기(/studio/)
  delete cfg.publicUrl;
  return cfg;
}

function readConfig() {
  const text = fs.readFileSync(configFile, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
function writeConfig(cfg) {
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, configFile);
}
const adminOf = (cfg) => (cfg.users || []).find((u) => u.role === 'admin') || null;

/** 이 포트에서 이 앱의 서버가 답하는가(내 토큰이 통한다) */
async function ours(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function client(port, token) {
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `오류 ${res.status}`), { code: data.error, status: res.status });
    return data;
  };
}

/** 폴더를 연결한다(이미 연결한 폴더는 그대로) → 연결한 수 */
async function linkFolders(api, folders) {
  let done = 0;
  for (const folder of folders) {
    try { const out = await api('/api/local/links', { method: 'POST', body: { path: path.resolve(folder) } }); say(`폴더 연결: ${out.link.path}`); done++; } catch (e) {
      if (e.code === 'LINKED') say(`이미 연결한 폴더: ${path.resolve(folder)}`); else say(`폴더를 연결하지 못했습니다(${folder}): ${e.message}`);
    }
  }
  return done;
}

/** 앱 창: Windows 는 Edge·Chrome 의 전용 창(이 앱만의 프로필 — 창을 닫으면 그 프로세스가 끝나 앱도 끈다), 그 밖에는 기본 브라우저 → 창 프로세스 | null */
function openApp(url) {
  if (process.platform === 'win32' && process.env.HWPX_COWORK_BROWSER !== 'default') {
    const browser = windowsBrowsers()[0];
    if (browser) {
      const profile = path.join(userDir, 'browser');
      fs.mkdirSync(profile, { recursive: true });
      // HWPX_COWORK_APP_WINDOW: 앱 창에 더 줄 브라우저 인자(예: --start-maximized, --window-position=0,0)
      const extra = String(process.env.HWPX_COWORK_APP_WINDOW || '').split(/\s+/).filter(Boolean);
      return spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--window-size=1400,900', ...extra], { stdio: 'ignore', windowsHide: false });
    }
  }
  if (!openWindow(url)) say(`브라우저에서 여세요: ${url.replace(/#.*$/, '')}`);
  return null;
}

/** 개인 AI 실행기 명령: 이 앱의 서버 주소로, 내 토큰은 환경 변수로만 넘긴다 */
export function workerCommand(spec, { port, token, env = process.env }) {
  const args = String(spec || '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) return null;
  if (args.includes('--url')) throw new Error('--ai 에는 --url 을 넣지 않습니다(이 앱의 서버로 붙습니다)');
  return { command: process.execPath, args: [path.join(appDir, 'scripts', 'ai-worker.mjs'), ...args, '--url', `http://127.0.0.1:${port}/mcp`], env: { ...env, HWPX_COWORK_TOKEN: token } };
}

async function main() {
  const managedByDesktop = desktopManaged || process.connected === true;
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('hwpx-cowork 개인용 앱 — 내 PC 폴더의 HWPX 를 열어 고칩니다(중앙 서버 없이).');
    console.log('  personal-app [폴더 …] [--port <번호>] [--name <이름>] [--ai "--provider codex"] [--no-window] [--keep]');
    return;
  }
  fs.mkdirSync(userDir, { recursive: true });
  const first = !fs.existsSync(configFile);
  if (first) {
    const example = JSON.parse(fs.readFileSync(path.join(appDir, 'config.example.json'), 'utf8'));
    const port = o.port || (await listening(DEFAULT_PORT) ? await freePort(DEFAULT_PORT + 1) : DEFAULT_PORT);
    writeConfig(personalConfig(example, { name: authorName(o.name), port, token: randomToken() }));
  }
  let cfg = readConfig();
  const admin = adminOf(cfg);
  if (!admin?.token) throw new Error(`${configFile} 에 관리자 사용자가 없습니다`);
  if (o.port && Number(cfg.port) !== o.port) { cfg = { ...cfg, port: o.port }; writeConfig(cfg); }
  let port = Number(process.env.HWPX_COWORK_PORT || cfg.port || DEFAULT_PORT);
  // teaser=0: 첫 방문 소개 영상으로 보내지 않는다(web/intro.js). #/t/<토큰>: 로그인 없이 연다(토큰은 # 뒤라 서버로 가지 않는다)
  const appUrl = () => `http://localhost:${port}/?teaser=0#/t/${encodeURIComponent(admin.token)}`;

  // 이미 떠 있으면 폴더만 더 연결하고 창을 하나 더 연다
  if (await ours(port, admin.token)) {
    say(`이미 켜져 있습니다 — http://localhost:${port}/`);
    await linkFolders(client(port, admin.token), o.folders);
    if (!o.noWindow) openApp(appUrl());
    return;
  }
  if (await listening(port)) {
    const to = await freePort(port + 1);
    say(`포트 ${port} 을 다른 프로그램이 쓰고 있어 ${to} 을 씁니다.`);
    cfg = { ...cfg, port: to }; writeConfig(cfg); port = to;
  }

  let controller = null; let worker = null; let stopping = false;
  let startingServer = false; let stopRequested = false;
  async function shutdown(code) {
    if (startingServer) { stopRequested = true; return; }
    if (stopping) return;
    stopping = true;
    say('앱을 끕니다(저장 중인 작업을 마친 뒤)…');
    try { worker?.kill(); } catch { /* 이미 끝남 */ }
    try { await controller?.stop(); } catch { /* 끄는 중 오류 */ }
    process.exit(code);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => void shutdown(0));
  // 데스크톱 앱이 만든 자식만 IPC로 종료한다. 부모가 비정상 종료해도 개인 서버를 남기지 않는다.
  if (managedByDesktop) {
    if (desktopManaged) desktopStop = () => void shutdown(0);
    else {
      process.on('message', message => { if (message === 'stop') void shutdown(0); });
      process.once('disconnect', () => void shutdown(0));
    }
    if (desktopStopRequested || !process.connected) { await shutdown(0); return; }
  }
  // 표준 입력의 quit(시험·다른 프로그램이 정상 종료를 시킬 때)
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => { if (line.trim() === 'quit') void shutdown(0); });
  rl.on('error', () => {});

  const capture = (child) => {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (text) => { for (const line of String(text).split(/\r?\n/)) if (line.trim() && !/^(LISTENING|NONCE) /.test(line)) console.log(`  ${line}`); });
    }
  };
  say(`hwpx-cowork 개인용 앱 — 설정·기록 ${userDir}`);
  const launcher = await import(pathToFileURL(path.join(appDir, 'server', 'launcher.js')).href);
  startingServer = true;
  controller = await launcher.startManagedServer({
    root: appDir, stdio: 'pipe', handleSignals: false,
    env: { ...process.env, HWPX_COWORK_CONFIG: configFile, HWPX_COWORK_USERDATA: userDir, HWPX_COWORK_LOCAL: '1' },
    onSpawn: capture,
    onExit(code) { if (!stopping) { say(`서버가 멈췄습니다(종료 코드 ${code}).`); process.exit(code || 1); } },
  });
  startingServer = false;
  if (stopRequested) { await shutdown(0); return; }
  const api = client(port, admin.token);
  const linked = await linkFolders(api, o.folders);
  // 처음 실행: 연결한 폴더가 없으면 폴더 고르기 창을 띄운다(취소하면 문서함의 [PC 폴더 연결]로 나중에)
  if (!o.noWindow && !linked) {
    try {
      const view = await api('/api/local');
      if (!view.links.length) {
        say('연결할 PC 폴더를 고르세요(폴더 고르기 창)…');
        const picked = await api('/api/local/pick', { method: 'POST', body: {} });
        if (picked.path) await linkFolders(api, [picked.path]);
      }
    } catch (e) { say(`폴더 고르기 창을 열지 못했습니다 — 문서함의 [PC 폴더 연결]을 쓰세요(${e.message})`); }
  }
  console.log(`PERSONAL ${port}`);
  say(`켜짐 — http://localhost:${port}/  (MCP: http://localhost:${port}/mcp)`);

  const spec = o.ai ?? cfg.personal?.ai;
  if (spec) {
    try {
      const cmd = workerCommand(spec, { port, token: admin.token });
      worker = spawn(cmd.command, cmd.args, { cwd: appDir, env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      for (const stream of [worker.stdout, worker.stderr]) { stream.setEncoding('utf8'); stream.on('data', (text) => { for (const line of String(text).split(/\r?\n/)) if (line.trim()) console.log(`  [AI] ${line}`); }); }
      worker.once('exit', (code) => { if (!stopping) say(`AI 실행기가 끝났습니다(종료 코드 ${code}).`); worker = null; });
      say(`AI 실행기를 켰습니다(${spec}).`);
    } catch (e) { say(`AI 실행기를 켜지 못했습니다: ${e.message}`); }
  }

  if (o.noWindow) { say('앱 창 없이 켰습니다. 끄려면 Ctrl+C 또는 quit'); return; }
  const startedAt = Date.now();
  const win = openApp(appUrl());
  if (!win) { say('앱 창을 닫아도 꺼지지 않습니다 — 끄려면 이 창을 닫거나 Ctrl+C'); return; }
  say(o.keep ? '앱 창을 열었습니다. 끄려면 이 창을 닫거나 Ctrl+C' : '앱 창을 열었습니다. 앱 창을 닫으면 함께 꺼집니다.');
  win.once('error', () => say('앱 창을 열지 못했습니다 — 브라우저에서 위 주소를 여세요.'));
  win.once('exit', () => {
    if (o.keep || stopping) return;
    // 창 프로세스가 곧바로 끝났으면(이미 떠 있는 브라우저에 넘김 등) 창이 닫힌 것이 아니다 — 계속 켜 둔다
    if (Date.now() - startedAt < 4000) { say('앱 창이 닫히는 것을 알 수 없습니다 — 끄려면 이 창을 닫거나 Ctrl+C'); return; }
    void shutdown(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    console.error(`[hwpx-cowork 개인용 앱] ${error.message}`);
    await sleep(50);
    process.exit(1);
  });
}
