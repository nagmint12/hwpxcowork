// 저장을 마치는 정상 재시작 + supervisor의 장애 복구. 소유한 자식 외의 프로세스를 종료하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supervise } from './supervisor.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTION_KEYS = ['host', 'port', 'publicUrl'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function readLaunchConfiguration(root, env) {
  const file = env.HWPX_COWORK_CONFIG ? path.resolve(root, env.HWPX_COWORK_CONFIG) : path.join(root, 'config.json');
  if (!fs.existsSync(file) && !env.HWPX_COWORK_CONFIG) fs.copyFileSync(path.join(root, 'config.example.json'), file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const host = env.HWPX_COWORK_HOST || raw.host || '127.0.0.1';
  const port = Number(env.HWPX_COWORK_PORT || (raw.port ?? 8787));
  if (typeof host !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('서버 주소 또는 포트 설정이 올바르지 않습니다.');
  return { file, raw, host, port };
}

function probe(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen({ host, port, exclusive: true }, () => socket.close((error) => error ? reject(error) : resolve()));
  });
}

// 실패한 새 서버의 연결 설정만 되돌린다. 사용자/토큰/기타 설정은 현재 파일 그대로 둔다.
function restoreConnectionSettings(previous, attempted) {
  const current = JSON.parse(fs.readFileSync(attempted.file, 'utf8').replace(/^\uFEFF/, ''));
  let changed = false;
  for (const key of CONNECTION_KEYS) {
    if (own(current, key) !== own(attempted.raw, key) || JSON.stringify(current[key]) !== JSON.stringify(attempted.raw[key])) continue;
    if (own(previous.raw, key)) current[key] = previous.raw[key]; else delete current[key];
    changed = true;
  }
  if (!changed) return;
  const temporary = `${attempted.file}.${process.pid}.restart-tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, attempted.file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** 시험에서도 임시 config/데이터를 주입할 수 있는 관리 실행기.
 *  onSpawn(child): 서버 자식을 띄울 때마다(재시작 포함) — stdio 'pipe' 로 쓰는 쪽(포터블 관리자 앱)이 시작 실패 출력까지 읽게 */
async function startManagedChild({ root = projectRoot, entry = path.join(root, 'server', 'index.js'), env = process.env, stdio = 'inherit', startupTimeoutMs = 30000, handleSignals = true, onSpawn = () => {}, onReady = () => {}, onExit = () => {} } = {}) {
  const childEnv = { ...env, HWPX_COWORK_MANAGED: '1' };
  let active = null;
  let reservation = null;
  let stopping = false;
  let stopPromise = null;
  let readyInfo = null;
  let lastGood = null;
  let previousGood = null;
  let finished = false;
  const signals = ['SIGINT', 'SIGTERM'];
  const output = stdio === 'inherit' ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'pipe', 'pipe', 'ipc'];

  function finish(code) {
    if (finished) return;
    finished = true;
    for (const signal of signals) process.off(signal, signalStop);
    onExit(code);
  }
  function send(child, message) {
    if (!child.connected) return;
    try { child.send(message, () => {}); } catch { /* 종료된 자식 */ }
  }
  async function preflight(child, message) {
    if (stopping || reservation || child !== active?.child || !lastGood) {
      send(child, { type: 'hwpx:restart-result', id: message.id, ok: false, code: 'RESTART_UNAVAILABLE' });
      return;
    }
    const ticket = { id: message.id, committed: false, config: null };
    reservation = ticket;
    try {
      ticket.config = readLaunchConfiguration(root, childEnv);
      if (ticket.config.port && (ticket.config.port !== readyInfo.port || ticket.config.host !== readyInfo.host)) {
        try { await probe(ticket.config.host, ticket.config.port); }
        catch (error) {
          // 127.0.0.1 ↔ 0.0.0.0 처럼 같은 포트의 범위를 바꾸면 현재 자식 자신과 겹친다.
          // 주소 자체의 EADDRNOTAVAIL 등은 거절하고, 이 경우의 점유만 실제 재실행/복구로 판정한다.
          if (!(error.code === 'EADDRINUSE' && ticket.config.port === readyInfo.port && ticket.config.host !== readyInfo.host)) throw error;
        }
      }
      if (stopping || reservation !== ticket || child !== active?.child) return;
      send(child, { type: 'hwpx:restart-result', id: ticket.id, ok: true });
    } catch {
      if (reservation === ticket) reservation = null;
      send(child, { type: 'hwpx:restart-result', id: ticket.id, ok: false, code: 'RESTART_TARGET_UNAVAILABLE' });
    }
  }
  async function launch({ recovery = false, snapshot } = {}) {
    const configuration = snapshot || readLaunchConfiguration(root, childEnv);
    const child = fork(entry, [], { cwd: root, env: childEnv, stdio: output, windowsHide: true });
    onSpawn(child);
    const record = { child, config: configuration, ready: false, drained: false, timer: null, failedStartTimer: null };
    active = record;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(record.timer);
        if (error) reject(error); else resolve(value);
      };
      record.timer = setTimeout(() => {
        send(child, { type: 'hwpx:stop' });
        // 아직 준비 완료하지 않은 자식만 정리한다. 이미 받은 문서 작업의 drain 에는 시간 제한을 걸지 않는다.
        record.failedStartTimer = setTimeout(() => {
          if (!record.ready && child.exitCode === null && child.signalCode === null) child.kill();
        }, 2000);
        record.failedStartTimer.unref?.();
        settle(new Error('서버 시작 응답을 기다리다 시간이 초과되었습니다.'));
      }, startupTimeoutMs);
      record.timer.unref?.();
      child.on('message', (message) => {
        if (!message || typeof message !== 'object' || active !== record) return;
        if (message.type === 'hwpx:ready' && !record.ready) {
          record.ready = true;
          clearTimeout(record.failedStartTimer);
          readyInfo = { host: message.host, port: message.port, nonce: message.nonce, publicUrl: message.publicUrl, pid: child.pid };
          lastGood = configuration;
          reservation = null;
          onReady(readyInfo, child);
          settle(null, readyInfo);
        } else if (message.type === 'hwpx:restart-reserve') {
          void preflight(child, message);
        } else if (message.type === 'hwpx:restart-cancel' && reservation?.id === message.id && !reservation.committed) {
          reservation = null;
        } else if (message.type === 'hwpx:restart-commit' && reservation?.id === message.id) {
          reservation.committed = true;
          previousGood = lastGood;
        } else if (message.type === 'hwpx:drained') {
          record.drained = true;
        }
      });
      child.once('error', (error) => settle(error));
      child.once('exit', (code, signal) => {
        clearTimeout(record.timer);
        clearTimeout(record.failedStartTimer);
        settle(new Error(`서버가 시작 중 종료되었습니다 (${code ?? signal}).`));
        if (active !== record) return;
        active = null;
        if (stopping) { finish(0); return; }
        const ticket = reservation;
        if (record.ready && ticket?.committed && record.drained && code === 0) {
          reservation = null;
          void launch({ snapshot: ticket.config }).catch(async () => {
            if (stopping || recovery) { finish(1); return; }
            try {
              // 시작 실패한 자식의 종료를 기다린 뒤 딱 한 번 복구한다.
              if (active?.child && active.child.exitCode === null && active.child.signalCode === null) {
                send(active.child, { type: 'hwpx:stop' });
                await new Promise((done) => active.child.once('exit', done));
              }
              restoreConnectionSettings(previousGood, ticket.config);
              console.error('[hwpx-cowork] 새 설정으로 시작하지 못해 이전 연결 설정으로 복구합니다.');
              await launch({ recovery: true });
            } catch { console.error('[hwpx-cowork] 서버 복구에 실패했습니다. 시작 파일로 다시 실행해 주세요.'); finish(1); }
          });
        } else if (record.ready || recovery) {
          finish(code || 1);
        }
      });
    });
  }
  function signalStop() { void stop(); }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    reservation = null;
    stopPromise = new Promise((resolve) => {
      const child = active?.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) { finish(0); resolve(); return; }
      child.once('exit', resolve);
      send(child, { type: 'hwpx:stop' });
    });
    return stopPromise;
  }
  if (handleSignals) for (const signal of signals) process.once(signal, signalStop);
  const controller = { get child() { return active?.child || null; }, get info() { return readyInfo; }, get stopped() { return finished; }, stop };
  try { await launch(); } catch (error) { await stop(); throw error; }
  return controller;
}

export function startManagedServer(options = {}) {
  return supervise({ root: projectRoot, ...options, startChild: startManagedChild });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startManagedServer({ onExit(code) { process.exitCode = code; } });
  } catch (error) {
    console.error('[hwpx-cowork] 서버를 시작하지 못했습니다:', error.message);
    process.exitCode = 1;
  }
}
