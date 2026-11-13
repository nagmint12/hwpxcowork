#!/usr/bin/env node
// 설치 폴더 안에서만 설정·로그를 만든다. 홈 CLI 설정·전역 환경 변수·기존 운영 config/data 는 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const setupAppUrl = (port, token) => `http://localhost:${port}/?teaser=0&welcome=start#/t/${encodeURIComponent(token)}`;
const SELF = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};
export function parseSetupArgs(argv) {
  const options = { mode: 'personal', ai: null, start: false, stop: false, installCli: false, noWindow: false, serve: false, status: false, userDir: null, name: null, port: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} 뒤에 값이 필요합니다.`); return argv[++i]; };
    if (key === '--mode') options.mode = value();
    else if (key === '--ai') options.ai = value();
    else if (key === '--user-dir') options.userDir = path.resolve(value());
    else if (key === '--name') options.name = value();
    else if (key === '--port') options.port = Number(value());
    else if (key === '--start') options.start = true;
    else if (key === '--stop') options.stop = true;
    else if (key === '--install-cli') options.installCli = true;
    else if (key === '--no-window') options.noWindow = true;
    else if (key === '--status') options.status = true;
    else if (key === '--serve') options.serve = true;
    else if (key === '--help' || key === '-h') options.help = true;
    else throw new Error(`지원하지 않는 옵션: ${key}`);
  }
  if (!['personal', 'shared'].includes(options.mode)) throw new Error('--mode personal|shared 를 선택하세요.');
  if (options.ai !== null && !['codex', 'claude-code', 'none'].includes(options.ai)) throw new Error('--ai codex|claude-code|none 을 선택하세요.');
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65435 || options.port === 8787)) throw new Error('--port 는 1024~65435 중 8787 외의 번호를 쓰세요.');
  return options;
}
export function isolatedEnvironment(env, directory) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
  // 실행 파일 선택만 보존한다. 기존 서버의 주소·설정·토큰·AI API 옵션은 물려주지 않는다.
  for (const key of ['HWPX_COWORK_CODEX_COMMAND', 'HWPX_COWORK_CLAUDE_COMMAND']) if (env[key]) clean[key] = env[key];
  return { ...clean, HWPX_COWORK_USERDATA: directory, HWPX_COWORK_CONFIG: path.join(directory, 'config.json'), HWPX_COWORK_AI: 'off' };
}
const alive = pid => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
async function request(port, token, endpoint = '/api/me') {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function dependencies() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 이상을 먼저 설치하세요.');
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'express', 'package.json')) && fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'))) return;
  console.log('이 설치 폴더의 의존성을 설치합니다(npm ci).');
  await npmRun(['ci', '--no-audit', '--no-fund'], process.env);
}
function npmRun(args, env) {
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const folders = [path.dirname(process.execPath), ...envPath.split(path.delimiter).filter(Boolean)];
  const entry = folders.map(folder => path.join(folder, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(file => fs.existsSync(file));
  return new Promise((resolve, reject) => {
    // Windows 명령 문자열을 만들지 않는다. npm 인자는 배열로 전달한다.
    if (!entry && process.platform === 'win32') return reject(new Error('Node.js와 함께 제공되는 npm을 찾지 못했습니다. scripts/setup-user.bat 로 다시 실행하세요.'));
    const child = spawn(entry ? process.execPath : 'npm', entry ? [entry, ...args] : args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('npm 설치에 실패했습니다. 설치 로그를 확인하세요.')));
  });
}
function portablePath() {
  const packaged = path.join(ROOT, 'portable', 'personal.mjs');
  return fs.existsSync(packaged) ? packaged : path.join(ROOT, 'deploy', 'portable', 'personal.mjs');
}
async function authCheck(ai, env, signal) {
  if (ai === 'none') return { ready: false, code: 'AI_NONE', reason: 'AI 없이 문서 편집을 사용합니다.' };
  if (ai === 'codex') {
    const { checkCodex } = await import('../server/codex-ai.js');
    return checkCodex({ env, command: env.HWPX_COWORK_CODEX_COMMAND || 'codex', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
  }
  const { checkClaudeCode } = await import('../server/claude-cli-ai.js');
  return checkClaudeCode({ env, command: env.HWPX_COWORK_CLAUDE_COMMAND || 'claude', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
}
async function installCli(ai, env) {
  const prefix = path.join(ROOT, '.hwpx-tools');
  const packageName = ai === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  console.log(`공식 CLI를 이 설치 폴더에만 설치합니다: ${packageName}`);
  await npmRun(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', packageName], env);
}
function localCliEnvironment(env) {
  const clean = { ...env }; const prefix = path.join(ROOT, '.hwpx-tools');
  const pathKey = Object.keys(clean).find(key => key.toLowerCase() === 'path') || 'PATH';
  clean[pathKey] = [process.platform === 'win32' ? prefix : path.join(prefix, 'bin'), path.dirname(process.execPath), clean[pathKey] || ''].join(path.delimiter);
  return clean;
}
function loginHint(ai, auth) {
  if (ai === 'none' || auth.ready) return;
  console.log(`AI 준비 필요: ${auth.reason}`);
  if (!auth.installed) console.log(ai === 'codex' ? 'Codex CLI 설치: https://developers.openai.com/codex/cli/' : 'Claude Code 설치: https://code.claude.com/docs/en/setup');
  const local = path.join(ROOT, '.hwpx-tools', ...(process.platform === 'win32' ? [] : ['bin']), ai === 'codex' ? (process.platform === 'win32' ? 'codex.cmd' : 'codex') : (process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  const command = fs.existsSync(local) ? `"${local}"` : ai === 'codex' ? 'codex' : 'claude';
  console.log(`본인 구독 계정으로 직접 로그인한 뒤 같은 설치 명령을 다시 실행하세요: ${process.platform === 'win32' && fs.existsSync(local) ? '& ' : ''}${command} ${ai === 'codex' ? 'login' : 'auth login'}`);
  console.log('VS Code 확장 로그인과 별도로 CLI 로그인이 필요할 수 있습니다. 사용자 로그인·동의와 계정 사용 한도는 자동으로 대신할 수 없습니다. API 키로 전환하지 않습니다.');
}
async function prepare(options) {
  const directory = options.userDir || path.join(ROOT, options.mode === 'personal' ? 'userdata-personal' : 'userdata-shared');
  // 루트 운영 설정과 data/ 를 설치 대상으로 받아들이지 않는다.
  if (directory === ROOT || directory === path.join(ROOT, 'data')) throw new Error('설정·기록에는 별도 설치 폴더를 지정하세요.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  const { personalConfig, authorName } = await import(pathToFileURL(portablePath()).href);
  const { freePort, randomToken } = await import(pathToFileURL(path.join(path.dirname(portablePath()), 'portable-lib.mjs')).href);
  if (!fs.existsSync(file)) {
    const example = read(path.join(ROOT, 'config.example.json'));
    let port = await freePort(options.port || 8790);
    if (port === 8787) port = await freePort(8788);
    const cfg = personalConfig(example, { name: authorName(options.name), token: randomToken(), port });
    if (options.mode === 'shared') {
      cfg.local = { enabled: false }; cfg.changeRequests = example.changeRequests; cfg.personal = { app: false };
    }
    cfg.installation = { guided: true, mode: options.mode };
    cfg.personal.ai = options.ai && options.ai !== 'none' ? `--provider ${options.ai}` : '';
    try { fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const config = read(file);
  if (!config.installation?.guided || config.installation.mode !== options.mode) throw new Error('기존 설정은 자동 변경하지 않습니다. 새 --user-dir 폴더를 지정하세요.');
  if (config.host !== '127.0.0.1' || Number(config.port) === 8787) throw new Error('이 설치 도우미는 127.0.0.1 및 8787 외의 포트만 사용합니다.');
  const user = config.users?.find(item => item.role === 'admin');
  if (!user?.token) throw new Error('설치 설정의 관리자 계정이 없습니다.');
  const savedAi = /--provider (codex|claude-code)\b/.exec(config.personal?.ai || '')?.[1] || 'none';
  return { directory, file, config, user, ai: options.ai ?? savedAi, env: localCliEnvironment(isolatedEnvironment(process.env, directory)), stateFile: path.join(directory, 'setup-runtime.json') };
}
async function runtime(options, state) {
  const lockFile = path.join(state.directory, 'setup-runtime.lock');
  if (fs.existsSync(lockFile)) {
    const lock = read(lockFile);
    if (alive(lock.pid)) throw new Error('이 설치의 실행 도우미가 이미 켜져 있습니다.');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const { startManagedServer } = await import('../server/launcher.js');
  const { freePort, listening } = await import(pathToFileURL(path.join(path.dirname(portablePath()), 'portable-lib.mjs')).href);
  let controller; let worker; let stopping = false; let connectionTask;
  const shutdown = new AbortController();
  const record = extra => write(state.stateFile, { pid: process.pid, port: state.config.port, ai: state.ai, serverOwned: !!controller, workerPid: worker?.pid || null, ...extra });
  async function stop(code = 0) {
    if (stopping) return; stopping = true;
    shutdown.abort();
    await connectionTask?.catch(() => {});
    if (worker?.connected) {
      const owned = worker;
      const exited = new Promise(resolve => owned.once('exit', resolve));
      owned.send('stop');
      await exited;
    }
    try { await controller?.stop(); } catch { /* server already exited */ }
    record({ phase: 'stopped' });
    if (fs.existsSync(lockFile) && read(lockFile).pid === process.pid) fs.unlinkSync(lockFile);
    process.exit(code);
  }
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
  // 시험·부모 실행기 IPC만 받는다. 공개 HTTP에 중지 API를 추가하지 않는다.
  process.on('message', message => { if (message === 'stop') void stop(); });
  try {
    const reusedServer = !!(await request(state.config.port, state.user.token));
    if (!reusedServer && await listening(state.config.port)) {
      state.config.port = await freePort(state.config.port + 1);
      if (state.config.port === 8787) state.config.port = await freePort(8788);
      write(state.file, state.config);
    }
    state.config.personal.ai = state.ai === 'none' ? '' : `--provider ${state.ai}`;
    write(state.file, state.config); record({ phase: 'starting' });
    if (!reusedServer) controller = await startManagedServer({ root: ROOT, env: state.env, stdio: 'pipe', handleSignals: false,
      onSpawn(child) { child.stdout?.pipe(process.stdout); child.stderr?.pipe(process.stderr); }, onExit(code) { if (!stopping) void stop(code || 1); } });
    let connecting = false;
    const connect = async () => {
    if (connecting || worker || stopping) return;
    connecting = true;
    const auth = await authCheck(state.ai, state.env, shutdown.signal);
    if (stopping) { connecting = false; return; }
    let workerReady = false;
    if (auth.ready) {
      // --check는 모델 호출·요청 선점 없이 먼저 연결을 점검한다.
      const check = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'ai-worker.mjs'), '--provider', state.ai, '--url', `http://127.0.0.1:${state.config.port}/mcp`, '--check'], { cwd: ROOT, env: { ...state.env, HWPX_COWORK_TOKEN: state.user.token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); child.once('error', reject); child.once('exit', resolve);
      });
      if (check === 0 && !stopping) {
        worker = spawn(process.execPath, [path.join(ROOT, 'scripts', 'setup-worker.mjs'), '--provider', state.ai, '--url', `http://127.0.0.1:${state.config.port}/mcp`], { cwd: ROOT, env: { ...state.env, HWPX_COWORK_TOKEN: state.user.token }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        worker.stdout.pipe(process.stdout); worker.stderr.pipe(process.stderr);
        worker.once('error', () => { worker = null; record({ phase: 'running', auth, workerReady: false }); });
        worker.once('exit', () => { worker = null; if (!stopping) record({ phase: 'running', auth, workerReady: false }); });
        for (let i = 0; i < 100 && worker && !stopping; i++) {
          const status = await request(state.config.port, state.user.token, '/api/automation/status');
          workerReady = !!status?.channels?.sessions?.some(item => item.client === `hwpx-${state.ai}-worker`);
          if (workerReady) break; await sleep(100);
        }
      }
    }
    if (!stopping) record({ phase: 'running', auth, workerReady });
    connecting = false;
    };
    connectionTask = connect(); await connectionTask;
    if (stopping) return;
    // 로그인 뒤 재실행하면 서버를 다시 띄우지 않고, 별도 실행기만 추가한다.
    setInterval(() => {
      const stopFile = path.join(state.directory, 'setup-stop.json');
      if (fs.existsSync(stopFile)) {
        const target = read(stopFile); fs.unlinkSync(stopFile);
        if (target.pid === process.pid) { void stop(); return; }
      }
      const control = path.join(state.directory, 'setup-connect.json');
      if (connecting || worker || !fs.existsSync(control)) return;
      const desired = read(control); fs.unlinkSync(control);
      if (!['codex', 'claude-code', 'none'].includes(desired.ai)) return;
      state.ai = desired.ai;
      state.config.personal.ai = state.ai === 'none' ? '' : `--provider ${state.ai}`;
      write(state.file, state.config);
      connectionTask = connect();
      void connectionTask.catch(error => { connecting = false; if (!stopping) record({ phase: 'running', workerReady: false, reason: error.message }); });
    }, 500);
  } catch (error) { console.error(error.message); await stop(1); }
}
export async function main(argv = process.argv.slice(2)) {
  const options = parseSetupArgs(argv);
  if (options.help) { console.log('node scripts/setup-personal.mjs --mode personal|shared --ai codex|claude-code|none [--install-cli] [--start|--stop|--status] [--no-window] [--user-dir <별도폴더>] [--port <번호>]'); return; }
  await dependencies();
  if (!fs.existsSync(path.join(ROOT, 'vendor', 'rhwp', 'pkg', 'rhwp_bg.wasm')) || !fs.existsSync(path.join(ROOT, 'studio', 'dist', 'index.html'))) throw new Error('미리 빌드한 엔진·편집기가 없습니다. 배포 사본 전체를 받으세요(일반 설치에는 Rust 빌드가 필요하지 않습니다).');
  const state = await prepare(options);
  if (options.serve) return runtime(options, state);
  let previous = fs.existsSync(state.stateFile) ? read(state.stateFile) : null;
  let running = previous && alive(previous.pid) && await request(previous.port, state.user.token);
  if (options.stop) {
    if (!running) { console.log('이 설치 도우미가 실행 중인 서버를 확인하지 못했습니다. 다른 프로세스는 중지하지 않습니다.'); return; }
    write(path.join(state.directory, 'setup-stop.json'), { pid: previous.pid });
    for (let i = 0; i < 200; i++) {
      if (read(state.stateFile).phase === 'stopped' && (!previous.serverOwned || !(await request(previous.port, state.user.token)))) { console.log('이 설치에서 시작한 서버·실행기를 정상 종료했습니다.'); return; }
      await sleep(100);
    }
    throw new Error('정상 종료를 아직 확인하지 못했습니다. setup-runtime.log 를 확인하세요.');
  }
  if (options.status) { console.log(JSON.stringify({ mode: options.mode, running: !!running, directory: state.directory, ...(running ? previous : {}), modelCalled: false, queueClaimed: false }, null, 2)); return; }
  console.log(`설정 준비: ${state.directory} (${options.mode === 'personal' ? '개인 서버' : '공동 서버'})`);
  let auth = await authCheck(state.ai, state.env);
  if (options.installCli && state.ai !== 'none' && !auth.installed) { await installCli(state.ai, state.env); auth = await authCheck(state.ai, state.env); }
  loginHint(state.ai, auth);
  if (running && previous.ai !== state.ai && alive(previous.workerPid)) throw new Error(`이미 ${previous.ai} 실행기가 연결돼 있습니다. 기존 실행기는 자동 종료하지 않습니다. 현재 설정으로 실행하거나 별도 --user-dir 를 쓰세요.`);
  if (options.start && running && !alive(previous.workerPid) && auth.ready && state.ai !== 'none') {
    write(path.join(state.directory, 'setup-connect.json'), { ai: state.ai });
    for (let i = 0; i < 1200; i++) {
      previous = read(state.stateFile);
      if (previous.workerReady && previous.ai === state.ai) break;
      await sleep(100);
    }
  }
  if (options.start && !running) {
    if (previous && alive(previous.pid)) throw new Error('설치 도우미가 아직 시작 중이거나 응답하지 않습니다. 중복 실행하지 않고 상태를 보존합니다. --status 로 확인하세요.');
    const logFile = path.join(state.directory, 'setup-runtime.log');
    const fd = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [SELF, '--serve', '--mode', options.mode, '--ai', state.ai, '--user-dir', state.directory], { cwd: ROOT, env: state.env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref(); fs.closeSync(fd);
    for (let i = 0; i < 1200; i++) {
      if (fs.existsSync(state.stateFile)) {
        previous = read(state.stateFile);
        if (previous.pid === child.pid && previous.phase === 'running') { running = await request(previous.port, state.user.token); break; }
        if (previous.pid === child.pid && previous.phase === 'stopped') break;
      }
      if (!alive(child.pid)) break; await sleep(100);
    }
    if (!running) throw new Error(`서버 준비를 확인하지 못했습니다. 로그: ${logFile}`);
  }
  if (running) {
    console.log(`서버 켜짐: http://localhost:${previous.port}/`);
    console.log(state.ai === 'none' ? 'AI 없이 실행 중입니다.' : previous.workerReady ? `구독 AI 실행기 연결됨: ${state.ai} (모델 응답은 아직 검증하지 않았습니다).` : '서버는 준비됐습니다. AI 실행기는 아직 연결되지 않았습니다.');
    if (!options.noWindow) {
      const { openWindow } = await import(pathToFileURL(path.join(path.dirname(portablePath()), 'portable-lib.mjs')).href);
      openWindow(setupAppUrl(previous.port, state.user.token));
    }
  } else console.log(`시작: node scripts/setup-personal.mjs --mode ${options.mode} --ai ${state.ai} --start`);
  if (options.mode === 'shared') console.log('공동 서버는 먼저 이 PC에서만 열립니다. 관리자 화면에서 사용자를 추가하고, 외부 공유는 HTTPS 주소·접속 정책을 정한 뒤 운영 안내를 따르세요. 연결한 구독 AI는 관리자 본인 요청만 처리하며, 참여자는 각자 본인 토큰·구독으로 연결합니다.');
  console.log(`관리자 토큰은 ${state.file} 에만 저장했습니다. 전역 환경 변수와 CLI 설정은 바꾸지 않았습니다.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(error => { console.error(`[설치 도우미] ${error.message}`); process.exitCode = 1; });
