import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

export function recoveryPaths(root, env = process.env) {
  const configFile = path.resolve(root, env.HWPX_COWORK_CONFIG || 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const dataDir = env.HWPX_COWORK_DATA_DIR ? path.resolve(root, env.HWPX_COWORK_DATA_DIR) : path.resolve(path.dirname(configFile), config.dataDir || 'data');
  const runtimeDir = path.join(dataDir, 'runtime');
  const key = crypto.createHash('sha256').update(process.platform === 'win32' ? configFile.toLowerCase() : configFile).digest('hex').slice(0, 20);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\hwpx-cowork-${key}` : path.join(runtimeDir, 'control.sock');
  return { configFile, runtimeDir, endpoint, stateFile: path.join(runtimeDir, 'server-state.json'), intentFile: path.join(runtimeDir, 'intent.json'), key, config };
}

export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); break; }
      catch (error) {
        if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function setIntent(paths, running, reason) {
  atomicJson(paths.intentFile, { running, reason, at: new Date().toISOString() });
}

export function requestControl(paths, action, { timeoutMs = 3000 } = {}) {
  const state = readJson(paths.stateFile);
  if (!state?.controlToken) return Promise.reject(Object.assign(new Error('관리 실행기 상태 기록이 없습니다'), { code: 'NO_SUPERVISOR' }));
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.endpoint); let data = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Object.assign(new Error('관리 실행기 응답 시간 초과'), { code: 'CONTROL_TIMEOUT' })), timeoutMs);
    socket.once('error', error => finish(error));
    socket.once('connect', () => socket.write(JSON.stringify({ action, token: state.controlToken }) + '\n'));
    socket.on('data', bytes => {
      data += bytes;
      if (data.length > 8192) { finish(new Error('잘못된 관리 응답')); return; }
      if (!data.includes('\n')) return;
      try { finish(null, JSON.parse(data.split('\n')[0])); } catch (error) { finish(error); }
    });
    socket.once('end', () => { if (!settled) finish(new Error('관리 연결 종료')); });
  });
}

export function createJournal(runtimeDir, { secrets = [], maxBytes = 2 * 1024 * 1024, archives = 3 } = {}) {
  const file = path.join(runtimeDir, 'events.jsonl');
  const clean = value => {
    let text = String(value);
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
      .replace(/([?&](?:token|key|access_token|api_key)=)[^\s&"'<>]+/gi, '$1[redacted]')
      .replace(/(\/mcp\/t\/)[^\s/?#"'<>]+/gi, '$1[redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]').slice(0, 16000);
  };
  const sanitize = (value, depth = 0) => {
    if (typeof value === 'string') return clean(value);
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 3) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, /token|password|secret|api.?key|authorization/i.test(k) ? '[redacted]' : sanitize(v, depth + 1)]));
  };
  return {
    file,
    redact: clean,
    write(event, details = {}) {
      try {
        fs.mkdirSync(runtimeDir, { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
          try { fs.unlinkSync(`${file}.${archives}`); } catch {}
          for (let i = archives - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
          fs.renameSync(file, `${file}.1`);
        }
        fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...sanitize(details) }) + '\n', { mode: 0o600 });
      } catch { /* A full disk must not kill the supervisor or prevent a stop. */ }
    },
  };
}

export function installProcessDiagnostics({ journal, processRef = process } = {}) {
  const fatal = (error, origin) => journal?.write('fatal', { origin, name: error?.name, code: error?.code, message: error?.message, stack: error?.stack, uptime: processRef.uptime?.(), memory: processRef.memoryUsage?.() });
  const exited = code => journal?.write('app-exit', { code, uptime: processRef.uptime?.() });
  processRef.on('uncaughtExceptionMonitor', fatal); // Observe; preserve Node's fatal exit behavior.
  processRef.on('exit', exited);
  return () => { processRef.off('uncaughtExceptionMonitor', fatal); processRef.off('exit', exited); };
}
