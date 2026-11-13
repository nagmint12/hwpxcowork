// 설정 저장·인증·재시작 승인만 임시 config와 작은 HTTP 서버로 검증한다. 실제 config/data는 사용하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createAdminSettings, validateServerSetting } from '../server/admin-settings.js';
import { installAdminRoutes } from '../server/routes/admin.js';

function fixture(t, { raw = {}, running = {}, env = {}, restartControl, fsImpl } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-admin-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(directory, 'config.json');
  const original = {
    host: '127.0.0.1', port: 8787, dataDir: './SECRET-DOCUMENTS',
    users: [{ name: '관리자', role: 'admin', token: 'SECRET-ADMIN-TOKEN' }],
    ai: { keyFile: 'SECRET-KEY-PATH', provider: 'unknown-future-provider', extra: { untouched: true } },
    future: { unknown: [1, { key: 'KEEP-UNKNOWN-VALUE' }] },
    ...raw,
  };
  fs.writeFileSync(file, `\uFEFF${JSON.stringify(original, null, 1)}\n`);
  const config = { configFile: file, host: '127.0.0.1', port: 8787, publicUrl: 'http://localhost:8787', publicUrlAuto: true, ...running };
  const settings = createAdminSettings({ config, env, restartControl, instanceId: 'PROCESS-INSTANCE', fsImpl });
  return { settings, config, file, directory, original, read: () => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
}

test('서버 설정은 세 항목만 원자 저장하고 토큰·알 수 없는 원본 설정을 보존한다', (t) => {
  const f = fixture(t);
  const before = f.settings.snapshot();
  assert.equal(before.restartRequired, false);
  assert.equal(before.running.instanceId, 'PROCESS-INSTANCE');
  const after = f.settings.save({ host: '0.0.0.0', port: '8790', publicUrl: 'https://shared.example/' }, before.revision);
  assert.deepEqual(after.saved, { host: '0.0.0.0', port: 8790, publicUrl: 'https://shared.example' });
  assert.deepEqual(after.running, before.running);
  assert.equal(after.restartRequired, true);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(f.read(), { ...f.original, ...after.saved });
  assert.deepEqual(fs.readdirSync(f.directory), ['config.json']);
  for (const secret of ['SECRET-ADMIN-TOKEN', 'SECRET-KEY-PATH', 'SECRET-DOCUMENTS', 'KEEP-UNKNOWN-VALUE', f.file]) assert.ok(!JSON.stringify(after).includes(secret));
  const restored = f.settings.save({ host: '127.0.0.1', port: 8787, publicUrl: '' }, after.revision);
  assert.equal(restored.restartRequired, false);
});

test('파일 전체 revision은 외부 설정 변경을 감지하고 오래된 저장을 거절한다', (t) => {
  const f = fixture(t);
  const before = f.settings.snapshot();
  fs.writeFileSync(f.file, JSON.stringify({ ...f.original, future: { changedElsewhere: true } }));
  const external = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.settings.save({ port: 8790 }, before.revision), { code: 'CONFIG_CHANGED', status: 409 });
  assert.equal(fs.readFileSync(f.file, 'utf8'), external);
  assert.throws(() => f.settings.save({ port: 8790 }), { code: 'REVISION_REQUIRED', status: 400 });
});

test('잘못된 입력과 허용하지 않은 설정은 파일을 변경하지 않는다', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const revision = f.settings.snapshot().revision;
  const invalid = [
    {}, [], null, { users: [] }, { host: 'server.example' }, { host: '127.1' }, { host: '[::1]' }, { host: '::1%eth0' },
    { port: 0 }, { port: -1 }, { port: 65536 }, { port: 1.1 }, { port: true }, { port: '1e3' },
    { publicUrl: 'ftp://example.test' }, { publicUrl: 'https://user:password@example.test' },
    { publicUrl: 'https://example.test/t/SECRET' }, { publicUrl: 'https://example.test/?token=SECRET' },
    { publicUrl: 'https://example.test/#SECRET' }, { publicUrl: 'https://example.test/a/..' },
    { publicUrl: 'https://example.test\\evil' }, { publicUrl: 'https://example.test:0' },
  ];
  for (const settings of invalid) assert.throws(() => f.settings.save(settings, revision), { code: 'INVALID_SERVER_SETTINGS', status: 400 });
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(validateServerSetting('host', ' ::1 '), '::1');
  assert.equal(validateServerSetting('host', 'LOCALHOST'), 'localhost');
  assert.equal(validateServerSetting('port', 65535), 65535);
  assert.equal(validateServerSetting('publicUrl', 'http://[::1]:8787/'), 'http://[::1]:8787');
});

test('환경 변수로 고정한 필드를 표시하고 다른 값으로 바꾸는 저장을 거절한다', (t) => {
  const f = fixture(t, {
    env: { HWPX_COWORK_HOST: '0.0.0.0', HWPX_COWORK_PORT: '9797', HWPX_COWORK_PUBLIC_URL: 'https://env.example' },
    running: { host: '0.0.0.0', port: 9797, publicUrl: 'https://env.example', publicUrlAuto: false },
  });
  const state = f.settings.snapshot();
  assert.equal(state.restartRequired, false);
  for (const field of ['host', 'port', 'publicUrl']) assert.equal(state.overrides[field].locked, true);
  assert.equal(state.overrides.publicUrl.source, 'HWPX_COWORK_PUBLIC_URL');
  assert.throws(() => f.settings.save({ host: '::' }, state.revision), { code: 'ENV_OVERRIDE', status: 409, extra: { field: 'host' } });
  assert.throws(() => f.settings.save({ port: 9798 }, state.revision), { code: 'ENV_OVERRIDE', status: 409 });
  assert.throws(() => f.settings.save({ publicUrl: 'https://other.example' }, state.revision), { code: 'ENV_OVERRIDE', status: 409 });
  const aligned = f.settings.save({ host: '0.0.0.0', port: 9797, publicUrl: 'https://env.example' }, state.revision);
  assert.equal(aligned.restartRequired, false);
});

test('자동 포트가 실제 포트로 바뀌어도 저장 변경으로 오인하지 않는다', (t) => {
  const f = fixture(t, { raw: { port: 0 }, running: { port: 0, publicUrl: 'http://localhost:0' }, env: { HWPX_COWORK_PORT: '0' } });
  f.config.port = 49152;
  f.config.publicUrl = 'http://localhost:49152';
  const state = f.settings.snapshot();
  assert.equal(state.running.port, 49152);
  assert.equal(state.saved.port, 0);
  assert.equal(state.restartRequired, false);
});

test('기존 URL의 계정·토큰·경로와 손상된 파일 내용은 API 응답에 노출하지 않는다', (t) => {
  const dangerous = 'https://SECRET-USER:SECRET-PASSWORD@shared.example/t/SECRET-TOKEN?token=SECRET-QUERY#SECRET-HASH';
  const f = fixture(t, { raw: { publicUrl: dangerous }, running: { publicUrl: dangerous, publicUrlAuto: false } });
  const state = f.settings.snapshot();
  assert.equal(state.saved.publicUrl, 'https://shared.example');
  assert.deepEqual(state.invalidFields.saved, ['publicUrl']);
  for (const value of ['SECRET-USER', 'SECRET-PASSWORD', 'SECRET-TOKEN', 'SECRET-QUERY', 'SECRET-HASH']) assert.ok(!JSON.stringify(state).includes(value));
  fs.writeFileSync(f.file, '{"SECRET-BROKEN-JSON');
  assert.throws(() => f.settings.snapshot(), (error) => error.code === 'CONFIG_UNAVAILABLE' && !error.message.includes('SECRET') && !error.message.includes(f.file));
});

test('원자 교체에 실패하면 기존 파일을 보존하고 임시 파일을 정리한다', (t) => {
  const f = fixture(t, { fsImpl: { ...fs, renameSync() { throw new Error('SECRET-OS-ERROR'); } } });
  const before = fs.readFileSync(f.file);
  assert.throws(() => f.settings.save({ port: 8790 }, f.settings.snapshot().revision), (error) => error.code === 'CONFIG_SAVE_FAILED' && !error.message.includes('SECRET-OS-ERROR'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.directory), ['config.json']);
});

test('임시 파일을 쓰는 사이 외부 변경이 생기면 덮어쓰지 않는다', (t) => {
  let f;
  let mutated = false;
  f = fixture(t, { fsImpl: { ...fs, fsyncSync(fd) {
    fs.fsyncSync(fd);
    if (!mutated) { mutated = true; fs.writeFileSync(f.file, JSON.stringify({ ...f.original, future: { external: true } })); }
  } } });
  const revision = f.settings.snapshot().revision;
  assert.throws(() => f.settings.save({ port: 8790 }, revision), { code: 'CONFIG_CHANGED', status: 409 });
  assert.equal(f.read().port, 8787);
  assert.deepEqual(f.read().future, { external: true });
  assert.deepEqual(fs.readdirSync(f.directory), ['config.json']);
});

async function httpFixture(t, options = {}) {
  const f = fixture(t, options);
  const app = express();
  app.use(express.json());
  const auth = (req, res, next) => {
    const token = req.get('authorization');
    if (!['Bearer admin', 'Bearer editor', 'Bearer viewer'].includes(token)) return res.status(401).json({ error: 'unauthorized' });
    req.user = { role: token.slice('Bearer '.length) };
    next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((error) => res.status(error.status || 500).json({ error: error.code, message: error.message, ...error.extra }));
  installAdminRoutes({ app, config: f.config, auth, wrap, adminSettings: f.settings });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (route = '/api/admin/server', { role = 'admin', method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, headers: { ...(role ? { Authorization: `Bearer ${role}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { ...f, call };
}

test('세 관리 API는 인증과 admin 역할을 모두 요구하고 저장 API는 동작한다', async (t) => {
  const f = await httpFixture(t);
  const before = fs.readFileSync(f.file);
  for (const [route, method] of [['/api/admin/server', 'GET'], ['/api/admin/server', 'PATCH'], ['/api/admin/restart', 'POST']]) {
    assert.equal((await f.call(route, { method, role: null })).status, 401);
    for (const role of ['editor', 'viewer']) assert.equal((await f.call(route, { method, role, ...(method !== 'GET' ? { body: { settings: { port: 8790 } } } : {}) })).status, 403);
  }
  assert.deepEqual(fs.readFileSync(f.file), before);
  const current = await f.call();
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('cache-control'), 'no-store');
  const saved = await f.call('/api/admin/server', { method: 'PATCH', body: { settings: { port: 8790 }, revision: current.body.revision } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved.port, 8790);
  assert.equal(saved.body.running.port, 8787);
  assert.equal(saved.body.restartRequired, true);
  const unsupported = await f.call('/api/admin/restart', { method: 'POST', body: { revision: saved.body.revision } });
  assert.equal(unsupported.status, 503);
  assert.equal(unsupported.body.error, 'RESTART_UNSUPPORTED');
});

test('재시작은 revision과 준비 상태를 검사하고 202 응답이 끝난 뒤 한 번만 실행한다', async (t) => {
  let busy = false; let committed = 0; let prepared = 0;
  const f = await httpFixture(t, { restartControl: {
    status: () => ({ supported: true, busy, privatePath: 'SECRET-RUNTIME-PATH' }),
    async requestRestart() {
      prepared += 1; busy = true;
      return { restartId: 'restart-test', commit() { committed += 1; }, cancel() { busy = false; } };
    },
  } });
  const current = await f.call();
  assert.deepEqual(current.body.restart, { supported: true, busy: false });
  assert.ok(!JSON.stringify(current.body).includes('SECRET-RUNTIME-PATH'));
  const stale = await f.call('/api/admin/restart', { method: 'POST', body: { revision: '0'.repeat(64) } });
  assert.equal(stale.status, 409);
  assert.equal(prepared, 0);
  const response = await f.call('/api/admin/restart', { method: 'POST', body: { revision: current.body.revision } });
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.restartId, 'restart-test');
  await new Promise(setImmediate);
  assert.equal(committed, 1);
  const savingDuringRestart = await f.call('/api/admin/server', { method: 'PATCH', body: { settings: { port: 8790 }, revision: current.body.revision } });
  assert.equal(savingDuringRestart.status, 409);
  assert.equal(savingDuringRestart.body.error, 'RESTART_BUSY');
  const again = await f.call('/api/admin/restart', { method: 'POST', body: { revision: current.body.revision } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'RESTART_BUSY');
  assert.equal(prepared, 1);
  assert.equal(committed, 1);
});

test('재시작 사전 검사 실패는 기존 서버를 유지하며 내부 오류를 숨긴다', async (t) => {
  const f = await httpFixture(t, { restartControl: {
    supported: true, busy: false,
    async requestRestart() { throw Object.assign(new Error('SECRET-CONFIG-PATH'), { code: 'RESTART_TARGET_UNAVAILABLE', status: 409 }); },
  } });
  const current = await f.call();
  const response = await f.call('/api/admin/restart', { method: 'POST', body: { revision: current.body.revision } });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'RESTART_TARGET_UNAVAILABLE');
  assert.ok(!JSON.stringify(response.body).includes('SECRET-CONFIG-PATH'));
  assert.equal((await f.call()).status, 200);
});

test('재시작 사전 검사 중 외부 config 변경은 예약을 취소하고 409를 반환한다', async (t) => {
  let f; let cancelled = 0; let committed = 0;
  f = await httpFixture(t, { restartControl: {
    supported: true, busy: false,
    async requestRestart() {
      fs.writeFileSync(f.file, JSON.stringify({ ...f.original, port: 9797 }));
      return { restartId: 'stale-target', cancel() { cancelled += 1; }, commit() { committed += 1; } };
    },
  } });
  const current = await f.call();
  const response = await f.call('/api/admin/restart', { method: 'POST', body: { revision: current.body.revision } });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'CONFIG_CHANGED');
  assert.equal(cancelled, 1);
  assert.equal(committed, 0);
});
