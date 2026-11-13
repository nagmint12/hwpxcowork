import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recoveryPaths, readJson, requestControl, createJournal } from './recovery-state.js';

export async function watchdogTick({ root, env = process.env, spawnProcess = spawn } = {}) {
  const paths = recoveryPaths(root, env);
  if (readJson(paths.intentFile)?.running !== true) return { action: 'intentionally-stopped' };
  try {
    const state = await requestControl(paths, 'status', { timeoutMs: 2000 });
    if (state.ok) return { action: 'supervised', phase: state.phase, childPid: state.childPid };
  } catch {}
  const state = readJson(paths.stateFile);
  if (state?.pid && Date.now() - Date.parse(state.supervisorHeartbeatAt || '') < 30000) {
    try { process.kill(state.pid, 0); return { action: 'supervisor-starting' }; } catch {}
  }
  // A different or still-running server owns the port: never terminate it or
  // start competing writers. An orphaned child exits when its IPC parent dies.
  const host = ['0.0.0.0', '::', undefined].includes(paths.config.host) ? '127.0.0.1' : paths.config.host;
  const port = Number(env.HWPX_COWORK_PORT || paths.config.port || 8787);
  const occupied = await new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(true)); // Unknown ownership is not a free port.
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
  if (occupied) return { action: 'port-in-use' };
  if (readJson(paths.intentFile)?.running !== true) return { action: 'intentionally-stopped' };
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  const journal = createJournal(paths.runtimeDir);
  const output = path.join(paths.runtimeDir, 'watchdog-launcher.log');
  try { if (fs.statSync(output).size > 2 * 1024 * 1024) fs.renameSync(output, `${output}.old`); } catch {}
  const fd = fs.openSync(output, 'a', 0o600);
  try {
    const child = spawnProcess(process.execPath, [path.join(root, 'server/launcher.js')], {
      cwd: root, env: { ...env, HWPX_COWORK_CONFIG: paths.configFile, HWPX_COWORK_WATCHDOG: '1' }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
    child.once('error', error => journal.write('watchdog-spawn-error', { code: error.code }));
    child.unref(); journal.write('watchdog-started-supervisor', { launcherPid: child.pid });
    return { action: 'started-supervisor', launcherPid: child.pid };
  } finally { fs.closeSync(fd); }
}

export async function watchContinuously({ root, env = process.env, intervalMs = 15000 } = {}) {
  const paths = recoveryPaths(root, env);
  const lease = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { lease.once('error', reject); lease.listen(`${paths.endpoint}-watchdog`, resolve); });
  let stopped = false, timer;
  const tick = async () => {
    try { await watchdogTick({ root, env }); } catch (error) { createJournal(paths.runtimeDir).write('watchdog-error', { code: error.code, message: error.message }); }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  await tick();
  return { stop() { stopped = true; clearTimeout(timer); lease.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  try {
    if (process.argv.includes('--watch')) {
      const watcher = await watchContinuously({ root });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => watcher.stop());
    } else console.log(JSON.stringify(await watchdogTick({ root })));
  } catch (error) { if (error.code !== 'EADDRINUSE') { console.error(error.message); process.exitCode = 1; } }
}
