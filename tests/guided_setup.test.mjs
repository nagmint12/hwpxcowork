// 로컬 임시 설정·가짜 CLI만 사용한다. 구독 모델·유료 API·사용자 로그인은 호출하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, parseSetupArgs, isolatedEnvironment, setupAppUrl } from '../scripts/setup-personal.mjs';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { fakeClaude } from './helpers/claude-cli.mjs';

const script = path.join(ROOT, 'scripts', 'setup-personal.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 60000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch {} await sleep(100); } throw new Error('설치 도우미 상태 확인 시간 초과'); }
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, env, windowsHide: true }); let output = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
}
async function shim(directory, ai, auth, receipt) {
  const fake = ai === 'codex' ? await fakeCodex(directory, { mode: 'slow', auth, receipt }) : await fakeClaude(directory, { mode: 'slow', auth, receipt });
  const command = path.join(directory, ai === 'codex' ? 'codex.cmd' : 'claude.cmd');
  const entry = ai === 'codex' ? path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  await fs.mkdir(path.dirname(entry), { recursive: true }); await fs.writeFile(command, '@echo off\r\n');
  await fs.writeFile(entry, `process.argv.splice(2,0,...${JSON.stringify(fake.args.slice(1))});import(${JSON.stringify(pathToFileURL(fake.args[0]).href)});`);
  return command;
}
test('설치 옵션·환경 격리 및 위험 포트 제한', () => {
  const entry = new URL(setupAppUrl(8790, 'fake!token'));
  assert.equal(entry.searchParams.get('welcome'), 'start', '새 설치는 자동 보고서 튜토리얼을 건너뛰고 문서함을 연다');
  assert.equal(entry.searchParams.get('teaser'), '0'); assert.equal(entry.hash, '#/t/fake!token');
  assert.ok(!entry.search.includes('fake!token'), '로그인 토큰은 서버에 전송하는 query가 아니라 fragment에 둔다');
  assert.equal(parseSetupArgs(['--mode', 'shared', '--ai', 'claude-code', '--start']).mode, 'shared');
  for (const args of [['--port', '8787'], ['--ai', 'anthropic'], ['--mode', 'x']]) assert.throws(() => parseSetupArgs(args));
  const env = isolatedEnvironment({ HOME: 'unchanged', HWPX_COWORK_TOKEN: 'operating-token', HWPX_COWORK_CONFIG: 'operating.json', HWPX_COWORK_PORT: '8787', HWPX_COWORK_CODEX_COMMAND: 'fake' }, 'isolated');
  assert.equal(env.HOME, 'unchanged'); assert.equal(env.HWPX_COWORK_TOKEN, undefined); assert.equal(env.HWPX_COWORK_PORT, undefined); assert.equal(env.HWPX_COWORK_CODEX_COMMAND, 'fake');
});
test('Windows bootstrap: Node 없음은 격리된 가짜 설치기, 재실행은 같은 Node 재사용', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-guided-bootstrap-'));
  try {
    const scripts = path.join(tmp, 'scripts'); const common = path.join(tmp, 'deploy', 'portable', 'common');
    await fs.mkdir(scripts, { recursive: true }); await fs.mkdir(common, { recursive: true });
    await fs.copyFile(path.join(ROOT, 'scripts', 'setup-user.ps1'), path.join(scripts, 'setup-user.ps1'));
    const receipt = path.join(tmp, 'args.json'); const installs = path.join(tmp, 'installs.txt');
    await fs.writeFile(path.join(scripts, 'setup-personal.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));`);
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    await fs.writeFile(path.join(common, 'install-node.ps1'), `param([string]$Target,[string]$Version)\nNew-Item -ItemType Directory -Force -Path $Target | Out-Null\nCopy-Item -LiteralPath ${literal(process.execPath)} -Destination (Join-Path $Target 'node.exe')\nAdd-Content -LiteralPath ${literal(installs)} -Value $Version\nexit 0\n`);
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = { ...process.env, PATH: [path.dirname(powershell), path.join(process.env.SystemRoot, 'System32')].join(';') }; delete env.Path;
    for (let i = 0; i < 2; i++) {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'setup-user.ps1'), '--mode', 'shared', '--ai', 'none', '--start'], { cwd: tmp, env, windowsHide: true }); let output = '';
        child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; }); child.once('error', reject); child.once('exit', code => resolve({ code, output }));
      });
      assert.equal(result.code, 0, result.output); assert.doesNotMatch(result.output, /SyntaxError/);
      assert.deepEqual(JSON.parse(await fs.readFile(receipt)), ['--mode', 'shared', '--ai', 'none', '--start']);
    }
    assert.equal((await fs.readFile(installs, 'utf8')).trim(), '24.22.2');
  } finally {
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir())); assert.match(path.basename(tmp), /^hwpx-guided-bootstrap-/);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('로그인 점검 도중 IPC 중지: 점검 CLI 취소 후 worker를 새로 띄우지 않는다', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-guided-auth-stop-'));
  const directory = path.join(tmp, 'userdata'); const auth = path.join(tmp, 'auth.txt'); const marker = path.join(tmp, 'checking.json');
  await fs.writeFile(auth, 'ready'); const command = await shim(tmp, 'codex', auth, path.join(tmp, 'model.json'));
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, HWPX_COWORK_CODEX_COMMAND: command };
  const args = ['--mode', 'personal', '--ai', 'codex', '--user-dir', directory, '--no-window'];
  const prepared = await run(args, env); assert.equal(prepared.code, 0, prepared.output);
  const entry = path.join(tmp, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const original = await fs.readFile(entry, 'utf8');
  await fs.writeFile(entry, `if(process.argv.includes('--version')){require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setTimeout(()=>{},20000);}else{${original}}`);
  const child = fork(script, [...args, '--serve'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const done = new Promise(resolve => child.once('exit', resolve)); let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  try {
    const checking = await until(async () => JSON.parse(await fs.readFile(marker)), 15000);
    child.send('stop');
    assert.equal(await Promise.race([done, sleep(10000).then(() => 'timeout')]), 0, output);
    await until(() => { try { process.kill(checking.pid, 0); return false; } catch { return true; } }, 5000);
    const state = JSON.parse(await fs.readFile(path.join(directory, 'setup-runtime.json'))); assert.equal(state.phase, 'stopped'); assert.equal(state.workerPid, null);
  } finally {
    if (child.connected) child.send('stop'); await Promise.race([done, sleep(10000)]);
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir())); assert.match(path.basename(tmp), /^hwpx-guided-auth-stop-/);
    if (child.exitCode !== null) await fs.rm(tmp, { recursive: true, force: true });
  }
});
test('개인·공동 서버: 충돌 회피·로그인 후 연결·반복실행으로 서버/worker 중복 없음', { timeout: 180000 }, async t => {
  for (const [mode, ai] of [['personal', 'codex'], ['shared', 'claude-code']]) await t.test(`${mode} / ${ai}`, { timeout: 90000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-guided-test-')); const auth = path.join(tmp, 'auth.txt'); const receipt = path.join(tmp, 'model-receipt.json'); const directory = path.join(tmp, 'userdata');
    const command = await shim(tmp, ai, auth, receipt); await fs.writeFile(auth, 'logout');
    const port = await freePort(); const busy = net.createServer(); await new Promise(resolve => busy.listen(port, '127.0.0.1', resolve));
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, HWPX_COWORK_CONFIG: path.join(tmp, 'must-not-use.json'), HWPX_COWORK_TOKEN: 'must-not-use-token', HWPX_COWORK_PORT: '8787', [ai === 'codex' ? 'HWPX_COWORK_CODEX_COMMAND' : 'HWPX_COWORK_CLAUDE_COMMAND']: command };
    const args = ['--mode', mode, '--ai', ai, '--user-dir', directory, '--port', String(port), '--no-window'];
    const prepared = await run(args, env); assert.equal(prepared.code, 0, prepared.output); assert.match(prepared.output, /로그인/);
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    assert.notEqual(config.port, port); assert.notEqual(config.port, 8787); assert.equal(config.host, '127.0.0.1'); assert.equal(config.local.enabled, mode === 'personal'); assert.ok(config.users[0].token.length >= 32); assert.ok(!prepared.output.includes(config.users[0].token));
    const child = fork(script, [...args, '--serve'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
    const done = new Promise(resolve => child.once('exit', resolve));
    const stateFile = path.join(directory, 'setup-runtime.json');
    try {
      const first = await until(async () => { const value = JSON.parse(await fs.readFile(stateFile)); return value.phase === 'running' && value; });
      assert.equal(first.workerReady, false); assert.equal(first.workerPid, null);
      assert.equal(await fs.stat(path.join(directory, 'data')).then(() => true), true);
      await fs.writeFile(auth, 'ready');
      const resumed = await run([...args, '--start'], env); assert.equal(resumed.code, 0, resumed.output); assert.match(resumed.output, /실행기 연결됨/);
      const second = JSON.parse(await fs.readFile(stateFile)); assert.equal(second.pid, first.pid); assert.equal(second.workerReady, true); assert.ok(second.workerPid);
      const repeated = await run([...args, '--start'], env); assert.equal(repeated.code, 0, repeated.output);
      const third = JSON.parse(await fs.readFile(stateFile)); assert.equal(third.pid, first.pid); assert.equal(third.workerPid, second.workerPid);
      const response = await fetch(`http://127.0.0.1:${config.port}/api/automation/status`, { headers: { Authorization: `Bearer ${config.users[0].token}` } });
      const status = await response.json(); assert.equal(status.channels.sessions.filter(item => item.client === `hwpx-${ai}-worker`).length, 1);
      await assert.rejects(fs.stat(receipt), { code: 'ENOENT' }); // 준비 검사·대기만: 실제 모델 경로 실행 0건
      await assert.rejects(fs.stat(path.join(tmp, 'must-not-use.json')), { code: 'ENOENT' });
      assert.ok(!log.includes(config.users[0].token));
      // 실제 모델 대신 20초 대기하는 가짜 native CLI를 요청에 붙여 정상 종료 때 자식까지 취소되는지 확인한다.
      const headers = { Authorization: `Bearer ${config.users[0].token}` };
      const base = `http://127.0.0.1:${config.port}`;
      const me = await (await fetch(`${base}/api/me`, { headers })).json();
      assert.equal(me.tutorial, true);
      assert.equal(me.tutorialIntroRequired, false);
      const catalog = await (await fetch(`${base}/api/tutorial`, { headers })).json();
      assert.equal(catalog.teaser, true);
      assert.ok(catalog.items.some(item => item.id === 'report'));
      const uploaded = await fetch(`${base}/api/docs`, { method: 'POST', headers: { ...headers, 'x-file-name': 'guided-test.hwpx' }, body: await fs.readFile(path.join(ROOT, 'tests', 'fixtures', 'tool_memo_tracked.hwpx')) });
      assert.equal(uploaded.status, 200); const doc = await uploaded.json();
      const paragraphs = await (await fetch(`${base}/api/docs/${doc.id}/paragraphs`, { headers })).json();
      const target = paragraphs.find(item => item.text?.trim()); assert.ok(target);
      const submitted = await fetch(`${base}/api/docs/${doc.id}/requests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'review', target: { ref: target.ref }, instruction: '가짜 CLI 종료 확인', route: 'agent' }) });
      assert.equal(submitted.status, 200);
      let native;
      try { native = await until(async () => JSON.parse(await fs.readFile(receipt)), 15000); }
      catch (error) {
        const requests = await (await fetch(`${base}/api/docs/${doc.id}/requests`, { headers })).json();
        throw new Error(`${error.message}\n${log}\nrequests: ${JSON.stringify(requests)}`);
      }
      const stopped = await run([...args, '--stop'], env); assert.equal(stopped.code, 0, stopped.output); assert.match(stopped.output, /정상 종료/);
      await until(() => { try { process.kill(native.pid, 0); return false; } catch { return true; } }, 5000);
      assert.equal(JSON.parse(await fs.readFile(stateFile)).phase, 'stopped');
    } finally {
      if (child.connected) child.send('stop'); await Promise.race([done, sleep(15000)]);
      await new Promise(resolve => busy.close(resolve));
      // 이 시험이 만든 임시 폴더만 정리한다.
      assert.equal(path.dirname(tmp), path.resolve(os.tmpdir())); assert.match(path.basename(tmp), /^hwpx-guided-test-/);
      if (child.exitCode !== null) await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
