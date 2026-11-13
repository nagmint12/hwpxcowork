import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { recoveryPaths, createJournal, atomicJson, readJson, setIntent, installProcessDiagnostics } from './recovery-state.js';

export async function supervise({ root, entry, env = process.env, stdio = 'inherit', handleSignals = true,
  startupTimeoutMs, startChild, onSpawn = () => {}, onReady = () => {}, onExit = () => {}, recovery = {} }) {
  const policy = { enabled: true, minDelayMs: 1000, maxDelayMs: 60000, stableMs: 60000, heartbeatTimeoutMs: 120000, checkIntervalMs: 10000, killGraceMs: 5000, ...recovery };
  const paths = recoveryPaths(root, env);
  if (env.HWPX_COWORK_WATCHDOG === '1' && readJson(paths.intentFile)?.running !== true) throw new Error('WATCHDOG_STOPPED');
  const journal = createJournal(paths.runtimeDir, { secrets: (paths.config.users || []).map(u => u.token) });
  const controlToken = crypto.randomBytes(24).toString('hex');
  const childEnv = { ...env, HWPX_COWORK_RUNTIME_DIR: paths.runtimeDir };
  let managed, bootPromise, retryTimer, healthTimer, killTimer, stopPromise;
  let info = null, child = null, phase = 'starting', stopping = false, finished = false, everReady = false;
  let readyAt = 0, heartbeatAt = 0, failures = 0, restarts = 0, nextRetryAt = null, lastExit = null, intent = null;
  let healthRecovery = false, explicitChildStop = false, booting = false;
  const sockets = new Set();
  const status = () => ({ phase, enabled: policy.enabled, pid: process.pid, childPid: child?.pid || null, info, restarts, failures, nextRetryAt, lastExit,
    heartbeatAt: heartbeatAt ? new Date(heartbeatAt).toISOString() : null, supervisorHeartbeatAt: new Date().toISOString() });
  const persist = () => { try { atomicJson(paths.stateFile, { ...status(), configFile: paths.configFile, controlToken }); } catch (error) { journal.write('state-write-error', { code: error.code }); } };
  const desired = running => { intent = running; try { setIntent(paths, running, running ? 'start' : 'intentional-stop'); } catch (error) { journal.write('intent-write-error', { code: error.code }); if (!running) throw error; } };
  const control = net.createServer(socket => {
    sockets.add(socket); let input = ''; socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => socket.destroy()); socket.once('close', () => sockets.delete(socket));
    socket.on('data', bytes => {
      input += bytes;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let request; try { request = JSON.parse(input.split('\n')[0]); } catch { socket.destroy(); return; }
      if (request.token !== controlToken) { socket.end('{"ok":false}\n'); return; }
      if (request.action === 'status') socket.end(JSON.stringify({ ok: true, ...status() }) + '\n');
      else if (request.action === 'stop') {
        try { desired(false); } catch { socket.end('{"ok":false,"code":"STOP_NOT_PERSISTED"}\n'); return; }
        socket.end('{"ok":true,"accepted":true}\n');
        setImmediate(() => { void stop().catch(error => journal.write('stop-error', { message: error.message })); });
      } else socket.end('{"ok":false}\n');
    });
  });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  if (process.platform !== 'win32' && fs.existsSync(paths.endpoint)) {
    // The socket file can survive SIGKILL. Never unlink a live owner's socket.
    const live = await new Promise(resolve => { const s = net.connect(paths.endpoint); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (!live) fs.unlinkSync(paths.endpoint);
  }
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(paths.endpoint, resolve); });
  control.removeAllListeners('error'); control.on('error', error => journal.write('control-error', { code: error.code }));
  const uninstallDiagnostics = installProcessDiagnostics({ journal });
  if (env.HWPX_COWORK_WATCHDOG === '1' && readJson(paths.intentFile)?.running !== true) { control.close(); uninstallDiagnostics(); throw new Error('WATCHDOG_STOPPED'); }
  desired(true); persist(); journal.write('supervisor-start', { ppid: process.ppid, node: process.version });

  function finish(code) {
    if (finished) return;
    finished = true; phase = stopping ? 'stopped' : 'failed';
    clearTimeout(retryTimer); clearTimeout(killTimer); clearInterval(healthTimer);
    if (handleSignals) for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, signalStop);
    persist(); journal.write('supervisor-exit', { code, intentional: stopping });
    for (const socket of sockets) socket.destroy(); control.close(); uninstallDiagnostics(); onExit(code);
  }
  function capture(stream, name, pid) {
    const decoder = new StringDecoder('utf8'); let pending = '', discarding = false;
    const line = text => {
      if (!text) return;
      journal.write(`app-${name}`, { childPid: pid, text });
      if (stdio === 'inherit') { try { (name === 'stderr' ? process.stderr : process.stdout).write(journal.redact(text) + '\n'); } catch {} }
    };
    stream.on('data', bytes => {
      pending += decoder.write(bytes);
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const text of lines) { if (discarding) { discarding = false; continue; } line(text); }
      if (pending.length > 32000) { journal.write('oversized-app-output-omitted', { childPid: pid, stream: name }); pending = ''; discarding = true; }
    });
    stream.once('end', () => { pending += decoder.end(); if (!discarding) line(pending); });
  }
  function scheduleRecovery(reason) {
    if (stopping || finished || retryTimer) return;
    if (!policy.enabled) { finish(lastExit?.code || 1); return; }
    if (readyAt && Date.now() - readyAt >= policy.stableMs) failures = 0;
    readyAt = 0;
    failures++;
    const delayMs = Math.min(policy.maxDelayMs, policy.minDelayMs * 2 ** Math.min(failures - 1, 20));
    phase = 'retrying'; nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    journal.write('recovery-scheduled', { reason, delayMs, failures, lastExit }); persist();
    retryTimer = setTimeout(() => {
      retryTimer = null; nextRetryAt = null;
      if (readJson(paths.intentFile)?.running === false) { void stop(); return; }
      restarts++; bootPromise = boot(); void bootPromise.catch(error => { journal.write('recovery-start-failed', { message: error.message }); scheduleRecovery('startup-failure'); });
    }, delayMs);
  }
  async function boot() {
    booting = true; phase = 'starting'; explicitChildStop = false; healthRecovery = false; persist();
    try {
      managed = await startChild({ root, entry, env: childEnv, stdio: 'pipe', startupTimeoutMs, handleSignals: false,
        onSpawn(spawned) {
          child = spawned; capture(spawned.stdout, 'stdout', spawned.pid); capture(spawned.stderr, 'stderr', spawned.pid);
          spawned.on('message', message => {
            if (child !== spawned || !message) return;
            if (message.type === 'hwpx:heartbeat') {
              heartbeatAt = Date.now();
              if (healthRecovery) { clearTimeout(killTimer); killTimer = null; }
            }
            if (message.type === 'hwpx:stopping' || message.type === 'hwpx:drained') {
              journal.write('app-shutdown', { reason: message.reason, childPid: spawned.pid });
              if (message.reason === 'stop' && !healthRecovery) explicitChildStop = true;
            }
          });
          spawned.once('exit', (code, signal) => {
            if (child !== spawned) return;
            lastExit = { at: new Date().toISOString(), code, signal, uptimeMs: readyAt ? Date.now() - readyAt : 0 };
            journal.write('app-exit-observed', lastExit); persist();
          });
          onSpawn(spawned);
        },
        onReady(ready, spawned) {
          info = ready; child = spawned; everReady = true; readyAt = heartbeatAt = Date.now();
          phase = 'running'; clearTimeout(killTimer); journal.write('app-ready', { childPid: ready.pid, nonce: ready.nonce, port: ready.port }); persist();
          onReady(ready, spawned);
        },
        onExit(code) {
          clearTimeout(killTimer);
          if (stopping) { finish(0); return; }
          if (explicitChildStop) { desired(false); stopping = true; finish(0); return; }
          if (!booting && everReady) scheduleRecovery('unexpected-exit');
        },
      });
      if (stopping) await managed.stop();
    } finally { booting = false; }
  }
  function signalStop() { void stop().catch(error => journal.write('stop-error', { message: error.message })); }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true; desired(false); phase = 'stopping'; nextRetryAt = null;
    clearTimeout(retryTimer); retryTimer = null; clearInterval(healthTimer); clearTimeout(killTimer);
    journal.write('intentional-stop'); persist();
    stopPromise = (async () => {
      if (booting && bootPromise) await bootPromise.catch(() => {});
      await managed?.stop(); finish(0);
    })();
    return stopPromise;
  }
  if (handleSignals) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, signalStop);
  healthTimer = setInterval(() => {
    if (finished || stopping) return;
    if (readJson(paths.intentFile)?.running === false) { void stop(); return; }
    if (phase === 'running' && child?.connected && Date.now() - heartbeatAt > policy.heartbeatTimeoutMs) {
      if (!healthRecovery) {
        healthRecovery = true; phase = 'unresponsive'; journal.write('heartbeat-timeout', { childPid: child.pid, silentMs: Date.now() - heartbeatAt });
        try { child.send({ type: 'hwpx:stop' }, () => {}); } catch {}
        const stalled = child;
        killTimer = setTimeout(() => { if (!stopping && child === stalled && stalled.exitCode === null && stalled.signalCode === null) { journal.write('unresponsive-app-terminated', { childPid: stalled.pid }); stalled.kill(); } }, policy.killGraceMs);
      }
    }
    persist();
  }, policy.checkIntervalMs);
  healthTimer.unref();
  const controller = { get child() { return child; }, get info() { return info; }, get stopped() { return finished; }, status, stop, journal: journal.file, paths };
  try { bootPromise = boot(); await bootPromise; }
  catch (error) {
    if (env.HWPX_COWORK_WATCHDOG === '1' && policy.enabled) {
      journal.write('initial-start-failed', { message: error.message }); scheduleRecovery('startup-failure');
    } else { finish(1); throw error; }
  }
  return controller;
}
