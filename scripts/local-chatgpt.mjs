// 서버 PC 운영자용 편의 실행기. 일반 참여자는 ai-worker.mjs와 본인 토큰 환경 변수를 사용한다.
// 선택한 config 사용자의 토큰은 메모리에서만 읽고 명령행·상태·로그에 저장하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { CodexProposer, codexEnvironment } from '../server/codex-ai.js';
import { createApiWorker } from '../server/worker.js';
import { checkWorkerConnection } from './ai-worker.mjs';

const ENTRY = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(ENTRY), '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fault = (code, message) => Object.assign(new Error(message), { code });
const HELP = `서버 PC 운영자용 개인 ChatGPT 실행기
  node scripts/local-chatgpt.mjs check|start|status|stop --user "config.json의 정확한 사용자 이름"
  선택: --config <설정 파일> --url <MCP 주소> --model <모델 ID> --codex-command <실행 파일> --tutorial-only
  check: 로그인·서버·도구만 확인(모델 호출·요청 선점 없음)
  start: 숨겨진 개인 실행기 시작(기존 대기 요청부터 자동 처리)
  status: 실행 상태 확인 / stop: 실행기에 정상 종료 요청
  PC와 서버가 켜져 있어야 합니다. 재부팅 자동 시작이나 OS 서비스 설치는 하지 않습니다.`;

export function parseLocalArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const options = { action: argv[0] === '--run' ? 'run' : argv[0] };
  if (!['check', 'start', 'status', 'stop', 'run'].includes(options.action)) throw fault('LOCAL_ARGS', 'check, start, status, stop 중 하나를 지정해 주세요.');
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--tutorial-only') { options.tutorialOnly = true; continue; }
    if (!['--user', '--config', '--url', '--model', '--codex-command', '--nonce'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw fault('LOCAL_ARGS', '실행 옵션을 확인해 주세요. --help로 사용법을 볼 수 있습니다.');
    if (options[key.slice(2)] !== undefined) throw fault('LOCAL_ARGS', '같은 옵션을 두 번 지정할 수 없습니다.');
    options[key.slice(2)] = argv[++index];
  }
  if (typeof options.user !== 'string' || !options.user || /[\r\n\0]/.test(options.user)) throw fault('LOCAL_ARGS', '--user에 config.json의 정확한 사용자 이름을 지정해 주세요.');
  if ((options.action === 'run' && !/^[a-f0-9]{64}$/.test(options.nonce || '')) || (options.action !== 'run' && options.nonce)) throw fault('LOCAL_ARGS', '내부 실행 식별자가 올바르지 않습니다.');
  return options;
}

export function resolveLocalSettings(options, { env = process.env, root = ROOT } = {}) {
  const configFile = path.resolve(root, options.config || env.HWPX_COWORK_CONFIG || 'config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw fault('LOCAL_CONFIG', '서버 설정 파일을 읽을 수 없습니다. 경로와 JSON 형식을 확인해 주세요.'); }
  const users = (Array.isArray(config.users) ? config.users : []).filter(user => user?.name === options.user);
  if (users.length !== 1 || typeof users[0].token !== 'string' || !users[0].token.trim()) throw fault('LOCAL_USER', '정확히 일치하는 사용자와 유효한 사용자 토큰이 하나 있어야 합니다.');
  let host = env.HWPX_COWORK_HOST || config.host || '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]') host = '[::1]';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  const port = Number(env.HWPX_COWORK_PORT || config.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('LOCAL_CONFIG', '실행 중인 서버의 포트를 확인해 주세요.');
  const url = options.url || `http://${host}:${port}/mcp`;
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || !/\/mcp\/?$/.test(parsed.pathname) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(); }
  catch { throw fault('LOCAL_URL', '인증정보가 없는 http(s)://서버/mcp 주소를 지정해 주세요.'); }
  const key = crypto.createHash('sha256').update(JSON.stringify([configFile, options.user, ...(options.tutorialOnly ? ['tutorial-only'] : [])])).digest('hex').slice(0, 24);
  const directory = path.join(path.resolve(root), 'artifacts', 'local-chatgpt-worker', key);
  return { ...options, configFile, directory, url, token: users[0].token, model: options.model || env.HWPX_COWORK_CODEX_MODEL, command: options['codex-command'] || env.HWPX_COWORK_CODEX_COMMAND };
}

function files(settings) { return { state: path.join(settings.directory, 'state.json'), stop: path.join(settings.directory, 'stop.json'), lock: path.join(settings.directory, 'start.lock'), log: path.join(settings.directory, 'worker.log') }; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw fault('LOCAL_STATE', '실행기 상태 파일을 읽을 수 없습니다.'); } }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function stateFor(settings) {
  const state = readJson(files(settings).state);
  if (state && (state.user !== settings.user || !/^[a-f0-9]{64}$/.test(state.nonce || '') || !['starting', 'running', 'stopping', 'stopped', 'failed'].includes(state.phase) || (state.pid != null && (!Number.isInteger(state.pid) || state.pid < 1)))) throw fault('LOCAL_STATE', '실행기 상태 파일의 사용자·형식을 확인할 수 없습니다.');
  return state;
}
export function pidAlive(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function running(state, alive) { return !!state && ['starting', 'running', 'stopping'].includes(state.phase) && alive(state.pid || state.launcherPid); }
function safeStats(worker) { const stats = worker?.stats?.() || {}; return Object.fromEntries(['completed', 'failed', 'cancelled', 'reconnects', 'duplicated'].map(key => [key, Math.max(0, Number(stats[key]) || 0)])); }
function safeFailure(e) { const allowed = /^(CODEX_[A-Z_]+|LOCAL_[A-Z_]+|PREFLIGHT_FAILED|ABORTED)$/; return { code: allowed.test(e?.code || '') ? e.code : 'LOCAL_FAILED', message: '실행하지 못했습니다. 사용자·서버 연결·Codex 로그인·모델·기관 권한을 확인해 주세요.' }; }

export function localStatus(settings, { alive = pidAlive } = {}) {
  const state = stateFor(settings);
  if (!state) return { user: settings.user, phase: 'not_started', running: false, processAlive: false };
  return { user: settings.user, phase: state.phase, running: running(state, alive), processAlive: alive(state.pid), pid: state.pid, ready: state.phase === 'running' && alive(state.pid), startedAt: state.startedAt, heartbeatAt: state.heartbeatAt, stoppedAt: state.stoppedAt, stats: state.stats, error: state.error };
}

function localMcp(env) {
  const version = String(env.HWPX_COWORK_MCP ?? '').trim();
  return ['1', '2'].includes(version) ? version : '3';
}

async function makeReady(settings, dependencies = {}) {
  const env = dependencies.env || process.env;
  const ai = dependencies.aiFactory ? dependencies.aiFactory(settings) : new CodexProposer({ model: settings.model, command: settings.command, mcp: localMcp(env) }, { env });
  const auth = await ai.check();
  if (!auth.ready) throw fault(auth.code || 'CODEX_AUTH_REQUIRED', auth.reason || 'ChatGPT 로그인 상태를 확인해 주세요.');
  const worker = (dependencies.workerFactory || createApiWorker)({ url: settings.url, token: settings.token, ai, tutorialOnly: !!settings.tutorialOnly, timing: settings.tutorialOnly ? { pollMs: 1000 } : {}, agent: settings.tutorialOnly ? '관리자 Codex' : 'ChatGPT (Codex)', clientName: settings.tutorialOnly ? 'hwpx-tutorial-codex-worker' : 'hwpx-codex-worker', log: dependencies.log || (() => {}) });
  try {
    const connection = await (dependencies.checkConnection || checkWorkerConnection)(worker);
    if (connection.user !== settings.user) throw fault('LOCAL_USER_MISMATCH', '서버에서 확인한 사용자와 선택한 사용자가 일치하지 않습니다.');
    return { worker, summary: { provider: 'codex', ready: true, user: connection.user, authMode: auth.authMode, version: auth.version, modelCalled: false, queueClaimed: false } };
  } catch (e) { await worker.stop(); throw e; }
}

export async function checkLocal(settings, dependencies = {}) {
  const { worker, summary } = await makeReady(settings, dependencies);
  try { return summary; } finally { await worker.stop(); }
}

export async function startLocal(settings, dependencies = {}) {
  const alive = dependencies.alive || pidAlive; const paths = files(settings);
  fs.mkdirSync(settings.directory, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = fs.openSync(paths.lock, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = readJson(paths.lock);
    if (!prior || alive(prior.pid)) throw fault('LOCAL_STARTING', '다른 시작 작업이 진행 중입니다. status로 상태를 확인해 주세요.');
    fs.unlinkSync(paths.lock); lock = fs.openSync(paths.lock, 'wx', 0o600);
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce })); fs.closeSync(lock);
  try {
    const previous = stateFor(settings);
    if (running(previous, alive)) return { ...localStatus(settings, { alive }), alreadyRunning: true };
    atomic(paths.state, { user: settings.user, nonce, phase: 'starting', pid: null, launcherPid: process.pid, startedAt: new Date().toISOString() });
    const args = [ENTRY, '--run', '--user', settings.user, '--nonce', nonce, '--config', settings.configFile, '--url', settings.url];
    if (settings.model) args.push('--model', settings.model);
    if (settings.command) args.push('--codex-command', settings.command);
    if (settings.tutorialOnly) args.push('--tutorial-only');
    const logFd = fs.openSync(paths.log, 'a', 0o600);
    let child; let launchError = false;
    try {
      const env = dependencies.env || process.env;
      const workerEnv = { ...codexEnvironment(env), HWPX_COWORK_MCP: localMcp(env) };
      child = (dependencies.spawn || nodeSpawn)(process.execPath, args, { cwd: ROOT, env: workerEnv, detached: true, windowsHide: true, shell: false, stdio: ['ignore', logFd, logFd] });
      child.once('error', () => { launchError = true; }); child.unref();
    } finally { fs.closeSync(logFd); }
    const deadline = Date.now() + (dependencies.waitMs || 30000);
    while (Date.now() < deadline) {
      const state = stateFor(settings);
      if (state?.nonce !== nonce) throw fault('LOCAL_STATE', '실행기 시작 상태가 변경되었습니다.');
      if (launchError) { atomic(paths.state, { ...state, phase: 'failed', error: safeFailure({ code: 'LOCAL_SPAWN' }) }); throw fault('LOCAL_SPAWN', '백그라운드 실행기를 시작하지 못했습니다.'); }
      if (state.phase === 'running') return localStatus(settings, { alive });
      if (['failed', 'stopped'].includes(state.phase)) throw fault(state.error?.code || 'LOCAL_START_FAILED', '실행기가 시작되지 않았습니다. check 명령으로 준비 상태를 확인해 주세요.');
      await wait(dependencies.pollMs || 100);
    }
    atomic(paths.stop, { nonce, at: new Date().toISOString() });
    throw fault('LOCAL_START_TIMEOUT', '시작 확인 시간이 초과되어 중지를 요청했습니다. status로 종료 상태를 확인해 주세요.');
  } finally {
    if (readJson(paths.lock)?.nonce === nonce) fs.unlinkSync(paths.lock);
  }
}

export async function stopLocal(settings, dependencies = {}) {
  const alive = dependencies.alive || pidAlive; const paths = files(settings); const state = stateFor(settings);
  if (!state || !alive(state.pid || state.launcherPid)) return { ...localStatus(settings, { alive }), alreadyStopped: true };
  atomic(paths.stop, { nonce: state.nonce, at: new Date().toISOString() });
  const deadline = Date.now() + (dependencies.waitMs || 30000);
  while (Date.now() < deadline) {
    const current = stateFor(settings);
    if (current?.nonce !== state.nonce) throw fault('LOCAL_STATE', '실행기 세대가 변경되어 종료 확인을 중단했습니다.');
    if (!alive(current.pid || current.launcherPid)) return { ...localStatus(settings, { alive }), stopped: true };
    await wait(dependencies.pollMs || 100);
  }
  throw fault('LOCAL_STOP_TIMEOUT', '정상 종료를 요청했지만 아직 프로세스 종료가 확인되지 않았습니다. status로 다시 확인해 주세요.');
}

/** --run 전용. 해당 nonce의 실행기만 stop marker를 수락하며 임의 PID를 종료하지 않는다. */
export async function runLocal(settings, dependencies = {}) {
  const paths = files(settings); let state = stateFor(settings);
  if (!state || state.nonce !== settings.nonce || state.phase !== 'starting') throw fault('LOCAL_STATE', '일치하는 시작 요청이 없습니다.');
  state = { ...state, pid: dependencies.pid || process.pid, heartbeatAt: new Date().toISOString() };
  atomic(paths.state, state);
  const write = change => { const current = stateFor(settings); if (current?.nonce !== settings.nonce) throw fault('LOCAL_STATE', '실행기 상태가 변경되었습니다.'); state = { ...current, ...change }; atomic(paths.state, state); };
  const log = line => fs.appendFileSync(paths.log, `[${new Date().toISOString()}] ${String(line).split(settings.token).join('[REDACTED]')}\n`, { mode: 0o600 });
  let worker; let timer; let stopping; let polling = false; let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const stop = () => {
    if (stopping) return stopping;
    clearInterval(timer);
    stopping = (async () => {
      try {
        write({ phase: 'stopping' });
        await worker?.stop();
        await Promise.allSettled([worker?.drainTask, worker?.sseTask]);
        write({ phase: 'stopped', stoppedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), stats: safeStats(worker) });
        log('개인 ChatGPT 자동 처리를 중지했습니다.');
      } catch { /* 오류 원문에는 설정·요청 내용이 있을 수 있으므로 출력하지 않는다. */ }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); finish(); }
    })();
    return stopping;
  };
  try {
    ({ worker } = await makeReady(settings, { ...dependencies, log }));
    if (readJson(paths.stop)?.nonce === settings.nonce) { await stop(); return; }
    worker.start();
    write({ phase: 'running', heartbeatAt: new Date().toISOString(), stats: safeStats(worker) });
    log('개인 ChatGPT 자동 처리를 시작했습니다. 결과는 HWPX에서 확인할 수 있습니다.');
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    timer = setInterval(() => {
      if (polling || stopping) return; polling = true;
      void (async () => {
        try {
          if (readJson(paths.stop)?.nonce === settings.nonce || worker.stopped) await stop();
          else write({ heartbeatAt: new Date().toISOString(), stats: safeStats(worker) });
        } catch { await stop(); }
        finally { polling = false; }
      })();
    }, dependencies.pollMs || 1000);
    await ended;
  } catch (e) {
    clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await worker?.stop(); await Promise.allSettled([worker?.drainTask, worker?.sseTask]);
    const failed = safeFailure(e); write({ phase: 'failed', error: failed, stoppedAt: new Date().toISOString() }); log(failed.message);
  }
  // process.exit를 호출하지 않는다. 남은 Codex 자식 종료·파일 정리가 끝나야 자연 종료한다.
}

export async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  try {
    const options = parseLocalArgs(argv);
    if (options.help) { process.stdout.write(`${HELP}\n`); return; }
    const settings = resolveLocalSettings(options, { env, root: dependencies.root || ROOT });
    const deps = { ...dependencies, env };
    if (settings.action === 'run') { await runLocal(settings, deps); return; }
    const result = settings.action === 'check' ? await checkLocal(settings, deps) : settings.action === 'start' ? await startLocal(settings, deps) : settings.action === 'stop' ? await stopLocal(settings, deps) : localStatus(settings, deps);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (e) { process.stderr.write(`${JSON.stringify(safeFailure(e))}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
