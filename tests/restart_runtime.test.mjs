import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntimeControl } from '../server/runtime-control.js';
import { startManagedServer } from '../server/launcher.js';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function removeTemporaryDirectory(directory, prefix) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(directory);
  const relative = path.relative(temporaryRoot, resolved);
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`), '정리 대상은 시스템 임시 폴더 안이어야 한다');
  assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith(prefix), '이 시험에서 만든 임시 폴더만 정리한다');
  fs.rmSync(resolved, { recursive: true, force: true });
}
async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await wait(30); }
  throw new Error('조건을 기다리다 시간 초과');
}

class FakeProcess extends EventEmitter {
  env = { HWPX_COWORK_MANAGED: '1' };
  connected = true;
  sent = [];
  send(message, callback) { this.sent.push(message); callback?.(); }
  exit(code) { this.exitCode = code; }
}

test('restart reservation is exclusive and can be cancelled before commit', async () => {
  const child = new FakeProcess();
  let drains = 0;
  const control = createRuntimeControl({ processRef: child, onPrepareRestart: async () => { drains++; } });
  const pending = control.requestRestart();
  await assert.rejects(control.requestRestart(), { code: 'RESTART_BUSY', status: 409 });
  const request = child.sent.find((message) => message.type === 'hwpx:restart-reserve');
  child.emit('message', { type: 'hwpx:restart-result', id: request.id, ok: true });
  const ticket = await pending;
  assert.equal(control.state, 'reserved');
  ticket.cancel();
  ticket.commit();
  assert.equal(control.busy, false);
  assert.equal(drains, 0);
  const second = control.requestRestart();
  const secondRequest = child.sent.filter((message) => message.type === 'hwpx:restart-reserve').at(-1);
  child.emit('message', { type: 'hwpx:restart-result', id: secondRequest.id, ok: true });
  (await second).commit();
  await until(() => child.exitCode === 0);
  assert.equal(drains, 1);
});

test('plain node server reports unsupported restart without reserving', async () => {
  const child = new FakeProcess();
  child.env = {};
  const control = createRuntimeControl({ processRef: child });
  await assert.rejects(control.requestRestart(), { code: 'RESTART_UNSUPPORTED', status: 503 });
  assert.equal(control.busy, false);
});

async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-restart-'));
  const configFile = path.join(temporary, 'config.json');
  const entry = path.join(temporary, 'server.mjs');
  const runtimeUrl = pathToFileURL(path.join(root, 'server', 'runtime-control.js')).href;
  fs.writeFileSync(configFile, JSON.stringify({ host: '127.0.0.1', port: 0, users: [{ token: 'fixture-secret' }], ai: { enabled: false } }));
  fs.writeFileSync(entry, `
    import http from 'node:http';
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    import { createRuntimeControl } from ${JSON.stringify(runtimeUrl)};
    const config = JSON.parse(fs.readFileSync(process.env.HWPX_COWORK_CONFIG, 'utf8'));
    if (config.failOnce) {
      delete config.failOnce;
      config.unrelated = 'preserved';
      fs.writeFileSync(process.env.HWPX_COWORK_CONFIG, JSON.stringify(config));
      process.exit(1);
    }
    let draining = false;
    const jobs = new Set();
    const nonce = crypto.randomUUID();
    const control = createRuntimeControl({ onPrepareRestart: async () => {
      draining = true;
      await Promise.allSettled([...jobs]);
      await new Promise((resolve) => server.close(resolve));
    }});
    const server = http.createServer(async (req, res) => {
      if (req.url === '/status') { res.end(JSON.stringify({ nonce, ...control.status() })); return; }
      if (draining) { res.writeHead(503).end(); return; }
      if (req.url === '/work') {
        const job = new Promise((resolve) => setTimeout(resolve, 250));
        jobs.add(job);
        await job;
        jobs.delete(job);
        fs.writeFileSync(process.env.HWPX_COWORK_CONFIG + '.work', 'saved');
        res.end('saved'); return;
      }
      try {
        const ticket = await control.requestRestart();
        res.once('finish', ticket.commit);
        res.writeHead(202).end(JSON.stringify({ restartId: ticket.restartId }));
      } catch (error) { res.writeHead(error.status || 500).end(JSON.stringify({ code: error.code })); }
    });
    server.listen(config.port, config.host, () => control.markReady({ host: config.host, port: server.address().port, nonce }));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
  env.HWPX_COWORK_CONFIG = configFile;
  const history = [];
  let output = '';
  const launcher = await startManagedServer({ root, entry, env, stdio: 'pipe', handleSignals: false, onReady(info, child) {
    history.push(info);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
  } });
  t.after(async () => { await launcher.stop(); removeTemporaryDirectory(temporary, 'hwpx-restart-'); });
  return { launcher, history, configFile, output: () => output, base: () => `http://127.0.0.1:${launcher.info.port}` };
}

test('managed restart waits for accepted work and creates a new server identity', async (t) => {
  const f = await fixture(t);
  const initial = f.launcher.info;
  const work = fetch(`${f.base()}/work`).then((response) => response.text());
  await wait(60);
  const response = await fetch(`${f.base()}/restart`, { method: 'POST' });
  assert.equal(response.status, 202);
  assert.equal(await work, 'saved');
  await until(() => f.history.length === 2);
  assert.equal(fs.readFileSync(`${f.configFile}.work`, 'utf8'), 'saved');
  assert.notEqual(f.launcher.info.nonce, initial.nonce);
  assert.notEqual(f.launcher.info.pid, initial.pid);
  assert.equal((await fetch(`${f.base()}/status`)).status, 200);
});

test('managed restart accepts a saved port change and preflights occupied ports', async (t) => {
  const f = await fixture(t);
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const occupied = blocker.address().port;
  const cfg = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  fs.writeFileSync(f.configFile, JSON.stringify({ ...cfg, port: occupied }));
  const rejected = await fetch(`${f.base()}/restart`, { method: 'POST' });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'RESTART_TARGET_UNAVAILABLE');
  assert.equal(f.history.length, 1);
  assert.equal((await fetch(`${f.base()}/status`).then((response) => response.json())).busy, false);
  const free = net.createServer();
  free.listen(0, '127.0.0.1');
  await once(free, 'listening');
  const port = free.address().port;
  await new Promise((resolve) => free.close(resolve));
  fs.writeFileSync(f.configFile, JSON.stringify({ ...cfg, port }));
  assert.equal((await fetch(`${f.base()}/restart`, { method: 'POST' })).status, 202);
  await until(() => f.history.length === 2);
  assert.equal(f.launcher.info.port, port);
});

test('failed replacement restores connection settings and preserves unrelated settings', async (t) => {
  const f = await fixture(t);
  const original = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  fs.writeFileSync(f.configFile, JSON.stringify({ ...original, publicUrl: 'http://new.invalid', failOnce: true }));
  assert.equal((await fetch(`${f.base()}/restart`, { method: 'POST' })).status, 202);
  await until(() => f.history.length === 2);
  const recovered = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.equal(recovered.publicUrl, undefined);
  assert.equal(recovered.unrelated, 'preserved');
  assert.deepEqual(recovered.users, original.users);
  assert.equal((await fetch(`${f.base()}/status`)).status, 200);
});

test('same-port binding scope changes permit the current listener overlap', async (t) => {
  const f = await fixture(t);
  const port = f.launcher.info.port;
  const cfg = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const previousCount = f.history.length;
    fs.writeFileSync(f.configFile, JSON.stringify({ ...cfg, host, port }));
    assert.equal((await fetch(`${f.base()}/restart`, { method: 'POST' })).status, 202);
    await until(() => f.history.length > previousCount);
    assert.equal(f.launcher.info.host, host);
    assert.equal(f.launcher.info.port, port);
  }
  fs.writeFileSync(f.configFile, JSON.stringify({ ...cfg, host: '203.0.113.254', port }));
  assert.equal((await fetch(`${f.base()}/restart`, { method: 'POST' })).status, 409);
  assert.equal(f.history.length, 3);
});

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('actual admin restart closes MCP/agent streams, changes port, and finishes an admitted upload', { timeout: 30000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-admin-restart-'));
  const configFile = path.join(temporary, 'config.json');
  const users = [{ name: '관리자', role: 'admin', token: 'isolated-admin-token' }, { name: '편집자', role: 'editor', token: 'isolated-editor-token' }];
  const port = await unusedPort();
  fs.writeFileSync(configFile, JSON.stringify({ host: '127.0.0.1', port, dataDir: './data', users, ai: { enabled: false }, changeRequests: { requireApprovals: 1 } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
  Object.assign(env, { HWPX_COWORK_CONFIG: configFile, HWPX_COWORK_AI: 'off' });
  const history = [];
  const streams = [];
  let ws;
  let uploadRequest;
  const launcher = await startManagedServer({ root, env, stdio: 'pipe', handleSignals: false, onReady(info, child) {
    history.push(info);
    child.stdout.resume(); child.stderr.resume();
  } });
  t.after(async () => {
    for (const stream of streams) stream.controller.abort();
    uploadRequest?.destroy();
    ws?.terminate();
    await launcher.stop();
    removeTemporaryDirectory(temporary, 'hwpx-admin-restart-');
  });
  const originalNonce = launcher.info.nonce;
  const base = () => `http://127.0.0.1:${launcher.info.port}`;
  const headers = { Authorization: `Bearer ${users[0].token}` };
  const call = async (url, method = 'GET', body) => {
    const response = await fetch(`${base()}${url}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const documentBytes = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'hangul_tracked.hwpx'));
  const uploaded = await fetch(`${base()}/api/docs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'existing.hwpx' }, body: documentBytes }).then((response) => response.json());
  assert.ok(uploaded.id);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${users[1].token}&doc=${uploaded.id}`);
  const messages = [];
  ws.on('message', (bytes) => messages.push(JSON.parse(String(bytes))));
  await once(ws, 'open');
  const initialize = await fetch(`${base()}/mcp`, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' },
    } }),
  });
  assert.equal(initialize.status, 200);
  const mcpSession = initialize.headers.get('mcp-session-id');
  assert.ok(mcpSession);
  assert.match(await initialize.text(), /protocolVersion/);
  async function openStream(url, extraHeaders = {}) {
    const controller = new AbortController();
    const stream = { controller, closed: false, failed: false, chunks: '' };
    streams.push(stream);
    const response = await fetch(`${base()}${url}`, { headers: { ...headers, Accept: 'text/event-stream', ...extraHeaders }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    // 소비는 유지하되 종료할 때까지 기다리지 않아 장기 GET 연결을 그대로 둔다.
    stream.done = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of response.body) stream.chunks += decoder.decode(chunk, { stream: true });
      stream.closed = true;
    })().catch(() => { stream.failed = true; });
    return stream;
  }
  const mcpStream = await openStream('/mcp', { 'Mcp-Session-Id': mcpSession });
  const agentStream = await openStream('/api/agent/events?session=restart_integration&agent=RestartTest');
  await until(() => agentStream.chunks.includes('event: hello'));
  assert.equal(mcpStream.closed, false);
  assert.equal(agentStream.closed, false);

  // 요청은 먼저 수락되지만 본문은 재시작의 새 요청 차단이 시작된 뒤에 완성한다.
  const uploadComplete = new Promise((resolve, reject) => {
    uploadRequest = http.request(`${base()}/api/docs`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'slow-upload.hwpx', 'Content-Length': documentBytes.length } }, (response) => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    uploadRequest.once('error', reject);
    uploadRequest.write(documentBytes.subarray(0, 100));
  });
  await wait(60);
  const current = (await call('/api/admin/server')).body;
  assert.equal(current.restart.supported, true);
  const newPort = await unusedPort();
  const saved = await call('/api/admin/server', 'PATCH', { revision: current.revision, settings: { port: newPort } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.restartRequired, true);
  const accepted = await call('/api/admin/restart', 'POST', { revision: saved.body.revision });
  assert.equal(accepted.status, 202);
  assert.equal((await call('/api/admin/restart', 'POST', { revision: saved.body.revision })).status, 409);
  await until(() => messages.some((message) => message.type === 'server' && message.action === 'restarting'));
  await wait(1400);
  assert.equal(history.length, 1, '본문을 받고 있는 요청이 끝날 때까지 이전 서버를 유지한다');
  uploadRequest.end(documentBytes.subarray(100));
  const finished = await uploadComplete;
  assert.equal(finished.status, 200);
  await until(() => history.length === 2);
  await until(() => mcpStream.closed && agentStream.closed);
  assert.equal(mcpStream.failed, false, 'MCP GET 연결은 서버 종료 때 정상적으로 닫힌다');
  assert.equal(agentStream.failed, false, '에이전트 SSE는 closeAll로 정상적으로 닫힌다');
  assert.equal(launcher.info.port, newPort);
  assert.notEqual(launcher.info.nonce, originalNonce);
  assert.equal((await call(`/api/docs/${finished.body.id}`)).status, 200);
  const after = await call('/api/admin/server');
  assert.equal(after.body.restartRequired, false);
  assert.equal(after.body.running.port, newPort);
  assert.equal(JSON.stringify(after.body).includes(users[0].token), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).users, users);
});
