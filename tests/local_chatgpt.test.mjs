import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexProposer } from '../server/codex-ai.js';
import { parseLocalArgs, resolveLocalSettings, checkLocal, startLocal, localStatus, stopLocal, runLocal } from '../scripts/local-chatgpt.mjs';

async function setup({ authenticated = true, serverUser = '시험 사용자' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-local-chatgpt-test-'));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ host: '0.0.0.0', port: 8787, users: [{ name: '시험 사용자', token: 'private-test-token' }] }));
  const settings = resolveLocalSettings(parseLocalArgs(['start', '--user', '시험 사용자']), { root, env: {} });
  const active = new Set(); const tasks = []; const launches = []; let started = 0; let stopped = 0;
  const dependencies = {
    root, env: { ...process.env, HWPX_COWORK_TOKEN: 'other-private-token', OPENAI_API_KEY: 'other-key' }, pollMs: 20, waitMs: 3000,
    alive: pid => pid === process.pid || active.has(pid),
    aiFactory: () => ({ check: async () => ({ ready: authenticated, authMode: authenticated ? 'chatgpt' : null, code: authenticated ? null : 'CODEX_AUTH_REQUIRED', version: 'test' }) }),
    checkConnection: async () => ({ connected: true, user: serverUser, toolsReady: true }),
    workerFactory: () => ({ stopped: false, start() { started++; }, async stop() { await new Promise(resolve => setTimeout(resolve, 35)); this.stopped = true; stopped++; }, stats: () => ({ completed: 0, failed: 0 }) }),
  };
  dependencies.spawn = (file, args, options) => {
    launches.push({ file, args, options });
    const pid = 900000 + launches.length; active.add(pid);
    const handle = new EventEmitter(); handle.pid = pid; handle.unref = () => {};
    const childOptions = resolveLocalSettings(parseLocalArgs(args.slice(1)), { root, env: options.env });
    tasks.push(Promise.resolve().then(() => runLocal(childOptions, { ...dependencies, env: options.env, pid })).finally(() => active.delete(pid)));
    return handle;
  };
  return { root, settings, dependencies, launches, active, counts: () => ({ started, stopped }),
    async close() { await Promise.allSettled(tasks); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^hwpx-local-chatgpt-test-/); await fs.rm(root, { recursive: true, force: true }); } };
}

test('튜토리얼 실행기는 일반 실행기와 분리된 관리 경로를 사용한다', async () => {
  const s=await setup();
  try {
    const options=parseLocalArgs(['start','--user','시험 사용자','--tutorial-only']);
    const tutorial=resolveLocalSettings(options,{root:s.root,env:{}});
    assert.equal(tutorial.tutorialOnly,true);assert.notEqual(tutorial.directory,s.settings.directory);
    let received;await checkLocal(tutorial,{...s.dependencies,workerFactory:options=>{received=options;return {stop:async()=>{}};}});
    assert.equal(received.tutorialOnly,true);assert.equal(received.timing.pollMs,1000);assert.equal(received.clientName,'hwpx-tutorial-codex-worker');
  } finally {await s.close();}
});

test('로컬 ChatGPT: 읽기 전용 check→백그라운드 시작→중복 차단→nonce 종료·완료 대기', { timeout: 10000 }, async () => {
  const s = await setup();
  try {
    assert.equal(localStatus(s.settings, s.dependencies).phase, 'not_started');
    const check = await checkLocal(s.settings, s.dependencies);
    assert.equal(check.ready, true); assert.equal(check.queueClaimed, false); assert.equal(s.counts().started, 0);
    const started = await startLocal(s.settings, s.dependencies);
    assert.equal(started.ready, true); assert.equal(started.running, true); assert.equal(s.counts().started, 1);
    const duplicate = await startLocal(s.settings, s.dependencies);
    assert.equal(duplicate.alreadyRunning, true); assert.equal(s.launches.length, 1);
    const launch = s.launches[0]; assert.equal(launch.options.detached, true); assert.equal(launch.options.windowsHide, true); assert.equal(launch.options.shell, false);
    assert.ok(!launch.args.join(' ').includes('private-test-token')); assert.equal(launch.options.env.HWPX_COWORK_TOKEN, undefined); assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
    // 실제 stopLocal처럼 원자적으로 공개해 폴링 중 부분 기록을 읽지 않게 한다.
    const stopMarker = path.join(s.settings.directory, 'stop.json');
    await fs.writeFile(`${stopMarker}.tmp`, JSON.stringify({ nonce: 'f'.repeat(64) }));
    await fs.rename(`${stopMarker}.tmp`, stopMarker);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(localStatus(s.settings, s.dependencies).running, true, '다른 실행 세대의 종료 요청은 무시');
    const stopped = await stopLocal(s.settings, s.dependencies);
    assert.equal(stopped.stopped, true); assert.equal(stopped.processAlive, false); assert.equal(stopped.phase, 'stopped'); assert.equal(s.active.size, 0);
    const state = await fs.readFile(path.join(s.settings.directory, 'state.json'), 'utf8');
    const log = await fs.readFile(path.join(s.settings.directory, 'worker.log'), 'utf8');
    assert.ok(!state.includes('private-test-token')); assert.ok(!log.includes('private-test-token'));
    assert.equal((await stopLocal(s.settings, s.dependencies)).alreadyStopped, true);
  } finally { if (localStatus(s.settings, s.dependencies).running) await stopLocal(s.settings, s.dependencies); await s.close(); }
});

test('로컬 ChatGPT: 백그라운드 --run은 기본 MCP v3와 명시한 버전를 받고 환경의 토큰은 받지 않는다', async (t) => {
  t.mock.method(CodexProposer.prototype, 'check', async () => ({ ready: true, authMode: 'chatgpt', version: 'test' }));
  for (const [requested, expected] of [[undefined, '3'], ['2', '2'], ['3', '3']]) {
    const s = await setup();
    try {
      s.dependencies.env = { HWPX_COWORK_TOKEN: 'other-private-token', OPENAI_API_KEY: 'other-key' };
      if (requested != null) s.dependencies.env.HWPX_COWORK_MCP = requested;
      delete s.dependencies.aiFactory;
      const makeWorker = s.dependencies.workerFactory;
      const workerConfig = [];
      s.dependencies.workerFactory = (options) => {
        workerConfig.push({ surface: options.ai.mcpSurface, token: options.token });
        return makeWorker(options);
      };

      assert.equal((await startLocal(s.settings, s.dependencies)).ready, true);
      const [launch] = s.launches;
      assert.equal(launch.args[1], '--run');
      assert.equal(launch.options.env.HWPX_COWORK_MCP, expected);
      assert.equal(launch.options.env.HWPX_COWORK_TOKEN, undefined);
      assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
      assert.ok(!launch.args.join(' ').includes('private-test-token'));
      assert.deepEqual(workerConfig, [{ surface: `v${expected}`, token: 'private-test-token' }]);
    } finally {
      if (localStatus(s.settings, s.dependencies).running) await stopLocal(s.settings, s.dependencies);
      await s.close();
    }
  }
});

test('로컬 ChatGPT: 정확한 사용자·서버 사용자·로그인 사전 점검 실패 시 자동 처리 시작 안 함', async () => {
  const s = await setup({ authenticated: false });
  try {
    assert.throws(() => parseLocalArgs(['start']), { code: 'LOCAL_ARGS' });
    assert.throws(() => parseLocalArgs(['--run', '--user', '시험 사용자', '--nonce', 'bad']), { code: 'LOCAL_ARGS' });
    assert.throws(() => resolveLocalSettings({ action: 'start', user: '시험 사용자 ' }, { root: s.root, env: {} }), { code: 'LOCAL_USER' });
    await assert.rejects(startLocal(s.settings, s.dependencies), { code: 'CODEX_AUTH_REQUIRED' });
    assert.equal(s.counts().started, 0); assert.equal(localStatus(s.settings, s.dependencies).phase, 'failed');
  } finally { await s.close(); }
  const other = await setup({ serverUser: '다른 사람' });
  try { await assert.rejects(checkLocal(other.settings, other.dependencies), { code: 'LOCAL_USER_MISMATCH' }); assert.equal(other.counts().started, 0); }
  finally { await other.close(); }
});

test('로컬 ChatGPT: 남아 있는 live PID는 보수적으로 중복 판정하고 kill하지 않음', async () => {
  const s = await setup();
  try {
    await fs.mkdir(s.settings.directory, { recursive: true });
    const nonce = 'a'.repeat(64); const pid = 7654321; s.active.add(pid);
    await fs.writeFile(path.join(s.settings.directory, 'state.json'), JSON.stringify({ user: s.settings.user, phase: 'running', nonce, pid }));
    assert.equal((await startLocal(s.settings, s.dependencies)).alreadyRunning, true); assert.equal(s.launches.length, 0);
    await assert.rejects(stopLocal(s.settings, { ...s.dependencies, waitMs: 100 }), { code: 'LOCAL_STOP_TIMEOUT' });
    assert.equal(s.active.has(pid), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(s.settings.directory, 'stop.json'), 'utf8')).nonce, nonce);
  } finally { s.active.clear(); await s.close(); }
});
