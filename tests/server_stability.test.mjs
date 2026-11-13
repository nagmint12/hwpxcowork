import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startManagedServer } from '../server/launcher.js';
import { createJournal, readJson, requestControl, recoveryPaths, setIntent, atomicJson } from '../server/recovery-state.js';
import { watchdogTick } from '../server/watchdog.js';
import { stopManagedServer } from '../server/control-cli.js';
import { startServer } from './helpers/server.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(20); } throw new Error('상태 확인 시간 초과'); }
function cleanup(dir) { const resolved = fs.realpathSync(dir); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('hwpx-stability-')); fs.rmSync(resolved, { recursive: true, force: true }); }

async function fixture(t, policy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stability-'));
  const config = path.join(dir, 'config.json'), entry = path.join(dir, 'app.mjs');
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: 0, dataDir: './data', users: [{ token: 'never-log-this-token' }] }));
  fs.writeFileSync(entry, `
    import http from 'node:http'; import fs from 'node:fs';
    import { createRuntimeControl } from ${JSON.stringify(pathToFileURL(path.join(root, 'server/runtime-control.js')).href)};
    import { createJournal, installProcessDiagnostics } from ${JSON.stringify(pathToFileURL(path.join(root, 'server/recovery-state.js')).href)};
    const journal=createJournal(process.env.HWPX_COWORK_RUNTIME_DIR,{secrets:['never-log-this-token']}); installProcessDiagnostics({journal});
    const failFile=process.env.HWPX_COWORK_CONFIG+'.fail';
    if(fs.existsSync(failFile)){const count=Number(fs.readFileSync(failFile,'utf8'));if(count>0){fs.writeFileSync(failFile,String(count-1));process.exit(23);}}
    const control=createRuntimeControl({onPrepareRestart:()=>new Promise(resolve=>server.close(resolve))});
    const server=http.createServer((req,res)=>{
      if(req.url==='/crash'){res.end('crashing');setTimeout(()=>{throw new Error('test-fatal never-log-this-token');},5);}
      else if(req.url==='/zero'){res.end('exiting');setTimeout(()=>process.exit(0),5);}
      else if(req.url==='/stop'){res.end('stop');setTimeout(()=>process.emit('SIGTERM'),5);}
      else if(req.url==='/hang'){res.end('hanging');setTimeout(()=>{for(;;){}},5);}
      else res.end('ok');
    });
    const heartbeat=setInterval(()=>{if(process.connected)process.send({type:'hwpx:heartbeat'});},20);heartbeat.unref();
    server.listen(0,'127.0.0.1',()=>control.markReady({host:'127.0.0.1',port:server.address().port,nonce:String(process.pid)}));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HWPX_COWORK_')));
  env.HWPX_COWORK_CONFIG = config;
  const history = [];
  const options = { root, entry, env, stdio: 'pipe', handleSignals: false, recovery: { minDelayMs: 30, maxDelayMs: 240, stableMs: 10000, checkIntervalMs: 20, heartbeatTimeoutMs: 3000, killGraceMs: 60, ...policy }, onReady: info => history.push(info) };
  const supervisor = await startManagedServer(options);
  t.after(async () => { await supervisor.stop(); cleanup(dir); });
  return { dir, config, options, supervisor, history, base: () => `http://127.0.0.1:${supervisor.info.port}` };
}

test('uncaught exception restarts the owned app, records fatal cause, and redacts credentials', async t => {
  const f = await fixture(t); const original = f.supervisor.info.pid;
  await fetch(`${f.base()}/crash`);
  await until(() => f.history.length === 2);
  assert.notEqual(f.supervisor.info.pid, original);
  assert.equal(await fetch(f.base()).then(r => r.text()), 'ok');
  const journal = fs.readFileSync(f.supervisor.journal, 'utf8');
  assert.match(journal, /test-fatal/); assert.match(journal, /recovery-scheduled/); assert.match(journal, /"event":"fatal"/);
  assert.ok(!journal.includes('never-log-this-token'));
});

test('an unmarked zero exit is unexpected and recovers too', async t => {
  const f = await fixture(t); await fetch(`${f.base()}/zero`); await until(() => f.history.length === 2);
  assert.equal(f.supervisor.status().lastExit.code, 0);
});

test('a forced app termination recovers without altering stored user data', async t => {
  const f = await fixture(t); const file = path.join(f.dir, 'data', 'user-document.bin'); fs.writeFileSync(file, 'preserve-this');
  f.supervisor.child.kill('SIGKILL'); await until(() => f.history.length === 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve-this');
});

test('explicit app stop remains stopped and persists the disabled recovery intent', async t => {
  const f = await fixture(t); await fetch(`${f.base()}/stop`); await until(() => f.supervisor.stopped); await delay(300);
  assert.equal(f.history.length, 1); assert.equal(readJson(f.supervisor.paths.intentFile).running, false);
});

test('the stop command cancels a queued retry and prevents revival', async t => {
  const f = await fixture(t, { minDelayMs: 400, maxDelayMs: 800 });
  f.supervisor.child.kill('SIGKILL'); await until(() => f.supervisor.status().phase === 'retrying');
  const stopped = await stopManagedServer({ root, env: f.options.env });
  assert.equal(stopped.ok, true); await delay(600); assert.equal(f.history.length, 1); assert.equal(f.supervisor.stopped, true);
});

test('repeated startup failures back off and recover after the cause is removed', async t => {
  const f = await fixture(t); fs.writeFileSync(`${f.config}.fail`, '2');
  f.supervisor.child.kill('SIGKILL'); await until(() => f.history.length === 2);
  const events = fs.readFileSync(f.supervisor.journal, 'utf8').trim().split('\n').map(JSON.parse);
  const pauses = events.filter(e => e.event === 'recovery-scheduled').map(e => e.delayMs);
  assert.deepEqual(pauses.slice(0, 3), [30, 60, 120]); assert.equal(f.supervisor.status().restarts, 3);
});

test('a hung event loop is terminated after the heartbeat grace and replaced', async t => {
  const f = await fixture(t, { heartbeatTimeoutMs: 100, killGraceMs: 60 });
  await fetch(`${f.base()}/hang`); await until(() => f.history.length === 2);
  assert.match(fs.readFileSync(f.supervisor.journal, 'utf8'), /unresponsive-app-terminated/);
  assert.equal(await fetch(f.base()).then(r => r.text()), 'ok');
});

test('duplicate launch cannot replace the control owner or change desired state', async t => {
  const f = await fixture(t); const before = readJson(f.supervisor.paths.stateFile);
  await assert.rejects(startManagedServer(f.options), { code: 'EADDRINUSE' });
  assert.equal(readJson(f.supervisor.paths.stateFile).controlToken, before.controlToken);
  assert.equal((await requestControl(f.supervisor.paths, 'status')).ok, true);
});

test('journal rotation is bounded and a broken log directory does not crash callers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stability-'));
  try {
    const log = createJournal(dir, { maxBytes: 120, archives: 2, secrets: ['fixture-secret'] });
    for (let i = 0; i < 12; i++) log.write('test', { message: 'Bearer abcdefghijkl ?token=fixture-secret', token: 'fixture-secret' });
    assert.ok(fs.readdirSync(dir).length <= 3);
    for (const file of fs.readdirSync(dir)) { const text = fs.readFileSync(path.join(dir, file), 'utf8'); assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('abcdefghijkl')); }
    const blocker = path.join(dir, 'not-a-directory'); fs.writeFileSync(blocker, 'x');
    assert.doesNotThrow(() => createJournal(blocker).write('fatal', { code: 'ENOSPC' }));
  } finally { cleanup(dir); }
});

test('temporary Windows sharing locks do not lose a persisted shutdown record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stability-'));
  const rename = fs.renameSync; let calls = 0;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (++calls <= 3) throw Object.assign(new Error('temporary sharing lock'), { code: 'EPERM' });
    return rename(...args);
  });
  try {
    const file = path.join(dir, 'state.json'); atomicJson(file, { phase: 'stopped' });
    assert.deepEqual(readJson(file), { phase: 'stopped' }); assert.equal(calls, 4);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  } finally { cleanup(dir); }
});

test('an independent watchdog revives a killed supervisor and then respects an intentional stop', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stability-'));
  const portProbe = net.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port, dataDir: './data', users: [{ name: 'test', role: 'admin', token: 'isolated-watchdog-test' }], ai: { enabled: false } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HWPX_COWORK_')));
  Object.assign(env, { HWPX_COWORK_CONFIG: config, HWPX_COWORK_AI: 'off' });
  const paths = recoveryPaths(root, env);
  let first;
  t.after(async () => {
    setIntent(paths, false, 'test-cleanup');
    try { await stopManagedServer({ root, env }); } catch {}
    if (first?.exitCode === null && first?.signalCode === null) first.kill('SIGKILL');
    cleanup(dir);
  });
  assert.equal((await watchdogTick({ root, env })).action, 'intentionally-stopped');
  first = spawn(process.execPath, [path.join(root, 'server/launcher.js')], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  await until(async () => { try { return (await requestControl(paths, 'status')).phase === 'running'; } catch { return false; } });
  const previous = readJson(paths.stateFile); const document = path.join(dir, 'data/important.txt'); fs.writeFileSync(document, 'keep');
  assert.equal((await watchdogTick({ root, env })).action, 'supervised');
  first.kill('SIGKILL'); await once(first, 'exit');
  await until(async () => { try { await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(100) }); return false; } catch { return true; } });
  const started = await until(async () => { const r = await watchdogTick({ root, env }); return r.action === 'started-supervisor' ? r : null; });
  assert.ok(started.launcherPid);
  await until(async () => { try { const v = await requestControl(paths, 'status'); return v.phase === 'running' && v.pid !== previous.pid; } catch { return false; } });
  assert.equal(fs.readFileSync(document, 'utf8'), 'keep');
  const headers = { Authorization: 'Bearer isolated-watchdog-test', 'Content-Type': 'application/json' };
  const api = `http://127.0.0.1:${port}`;
  const current = await fetch(`${api}/api/admin/server`, { headers }).then(r => r.json());
  assert.equal((await fetch(`${api}/api/admin/stop`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${api}/api/admin/stop`, { method: 'POST', headers, body: JSON.stringify({ revision: '0'.repeat(64) }) })).status, 409);
  assert.equal((await fetch(`${api}/api/admin/stop`, { method: 'POST', headers, body: JSON.stringify({ revision: current.revision }) })).status, 202);
  try { await until(() => readJson(paths.stateFile)?.phase === 'stopped', 15000); }
  catch (error) {
    const state = readJson(paths.stateFile);
    t.diagnostic(JSON.stringify({ phase: state?.phase, lastExit: state?.lastExit, intent: readJson(paths.intentFile),
      events: fs.readFileSync(path.join(paths.runtimeDir, 'events.jsonl'), 'utf8').slice(-7000) }));
    throw error;
  }
  assert.equal((await watchdogTick({ root, env })).action, 'intentionally-stopped');
});

test('the outer watchdog never claims or kills an unrelated occupied port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-stability-'));
  const server = net.createServer(socket => socket.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const config = path.join(dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ host: '127.0.0.1', port: server.address().port, dataDir: './data' }));
    const env = { HWPX_COWORK_CONFIG: config }; const paths = recoveryPaths(root, env); setIntent(paths, true, 'test');
    const result = await watchdogTick({ root, env, spawnProcess() { throw new Error('must not spawn'); } });
    assert.equal(result.action, 'port-in-use'); assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); cleanup(dir); }
});

test('bad WebSocket frames, invalid UTF-8 and oversized messages close only the offending connection', async () => {
  const srv = await startServer();
  try {
    const doc = await srv.api('a')('/api/library/docs', { method: 'POST', body: {} }); const nonce = srv.nonce;
    for (const send of [ws => ws._socket.write(Buffer.from([0x81, 0x01, 0x61])), ws => ws.send(Buffer.from([0xff]), { binary: false }), ws => ws.send('x'.repeat(65537))]) {
      const ws = new WebSocket(`${srv.base.replace('http:', 'ws:')}/ws?doc=${doc.id}&token=${srv.tokens.a}`);
      ws.on('error', () => {}); await once(ws, 'open');
      const closed = new Promise(resolve => ws.once('close', resolve)); send(ws); await closed;
      assert.equal((await fetch(`${srv.base}/api/config`).then(r => r.json())).nonce, nonce);
      assert.equal((await srv.api('a')(`/api/docs/${doc.id}`)).version, 1);
    }
  } finally { await srv.stop(); }
});
