// Windows 데스크톱 앱(2026-11-17): 운영 방식(혼자/함께/AI 실행기만), 공동 작업용 설정, 외부 접속(터널) 열기·닫기, cloudflared 서명 규칙,
// AI 실행기 관리(runners.mjs — 목록·다른 서버·토큰 보관·켜기/끄기·상태·기록·다시 띄우기)와 그것이 대신하는 루트 실행기 bat.
// 실제 터널·인터넷·Electron·AI CLI 없이 모의 자식 프로세스(또는 가짜 ai-worker 를 단 진짜 setup-worker 프로세스)로 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerTray } from '../deploy/desktop/server-tray.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DesktopHost, desktopEnvironment, runnerEnvironment, placeName } from '../deploy/desktop/host.mjs';
import { savedMode, saveMode, modeFromArgs, relaunchArgs, MODE_CHOICE, MODES, MODE_LABELS } from '../deploy/desktop/mode.mjs';
import { shareUrlFromLine, signedByCloudflare, findCloudflared, installCloudflared, cloudflaredPath } from '../deploy/desktop/share.mjs';
import { RunnerManager, RUNNER_AIS, RUNNER_STATES, RUNNER_PAYLOAD_FILES, LOCAL_SERVER, serverAddress, runnerLine, redact, privateHost, hostLabel } from '../deploy/desktop/runners.mjs';
import { personalConfig, sharedConfig } from '../deploy/portable/personal.mjs';
import { parseWorkerArgs } from '../scripts/ai-worker.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-desktop-win-'));
const cleanup = (dir) => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('알림 영역은 실제 서버 상태를 표시하고 창 복원과 정상 종료를 요청한다', () => {
  let tray;
  const actions = [];
  class FakeTray {
    constructor() { tray = this; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(items) { this.items = items; }
    on(event, handler) { this[event] = handler; }
    destroy() { this.destroyed = true; }
  }
  for (const [mode, name] of [['personal', '개인 서버'], ['shared', '공동 작업 서버']]) {
    const control = createServerTray({ Tray: FakeTray, Menu: { buildFromTemplate: items => items }, icon: {}, mode,
      showWindow: () => actions.push('open'), quit: () => actions.push('quit') });
    assert.equal(tray.tooltip, `Hwpx Cowork · ${name} · 시작 중`);
    control.update('ready');
    assert.equal(tray.items[0].label, `${name} · 실행 중`);
    tray.click(); tray.items.find(item => item.label === '앱과 서버 종료').click();
    assert.deepEqual(actions.splice(0), ['open', 'quit']);
    assert.equal(tray.destroyed, undefined, '종료가 취소되면 아이콘을 유지한다');
    control.update('stopping'); assert.equal(tray.items.at(-1).enabled, false);
    control.update('error'); assert.equal(tray.items.at(-1).enabled, true);
    control.destroy(); assert.equal(tray.destroyed, true);
  }
});

test('운영 방식: 명령줄 → 저장값 → 예전 개인용 설치는 개인용 → 처음이면 null(묻기). 세 방식(혼자·함께·AI 실행기만)', () => {
  const dir = temporary();
  try {
    assert.equal(modeFromArgs(['app.exe', '--mode', 'shared']), 'shared');
    assert.equal(modeFromArgs(['--mode=personal']), 'personal');
    assert.equal(modeFromArgs(['--mode', 'runner']), 'runner');
    assert.equal(modeFromArgs(['--mode', 'server']), null);
    assert.equal(savedMode(dir), null);
    fs.mkdirSync(path.join(dir, 'personal')); fs.writeFileSync(path.join(dir, 'personal', 'config.json'), '{}');
    assert.equal(savedMode(dir), 'personal', '방식을 고르기 전 판의 개인용 설치');
    saveMode(dir, 'shared'); assert.equal(savedMode(dir), 'shared');
    saveMode(dir, 'runner'); assert.equal(savedMode(dir), 'runner');
    assert.throws(() => saveMode(dir, 'admin'));
    assert.deepEqual(relaunchArgs(['--verbose', '--mode', 'shared', '--mode=personal', 'x']), ['--verbose', 'x']);
    assert.deepEqual(MODES, ['personal', 'shared', 'runner']);
    assert.deepEqual(MODE_CHOICE.modes, MODES); assert.equal(MODE_CHOICE.buttons.length, 3);
    assert.equal(MODE_CHOICE.modes[0], 'personal', '창을 닫으면(취소) 혼자 쓰기');
    for (const m of MODES) assert.ok(MODE_LABELS[m]);
    assert.match(MODE_CHOICE.detail, /AI 실행기만/);
  } finally { cleanup(dir); }
});

test('공동 작업용 첫 설정: PC 폴더 연결 끔·변경 요청 규칙은 예제대로, 나머지는 개인용과 같음(127.0.0.1·관리자 한 명)', () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const p = personalConfig(example, { name: '나', port: 8790, token: 't'.repeat(32) });
  const s = sharedConfig(example, { name: '나', port: 8790, token: 't'.repeat(32) });
  assert.equal(p.local.enabled, true); assert.equal(s.local.enabled, false);
  assert.deepEqual(s.changeRequests, example.changeRequests); assert.equal(s.personal.app, false);
  assert.equal(s.host, '127.0.0.1'); assert.equal(s.users.length, 1); assert.equal(s.users[0].role, 'admin');
  assert.equal(s.ai.enabled, false); assert.equal(s.publicUrl, undefined);
});

test('데스크톱 환경: 공동 작업용·실행기만은 PC 폴더 연결 환경 변수를 켜지 않고, 안내 글은 Windows 에서 "이 PC"', () => {
  assert.equal(desktopEnvironment({}, '/u', '/n/node.exe', 'personal').HWPX_COWORK_LOCAL, '1');
  assert.equal(desktopEnvironment({ HWPX_COWORK_LOCAL: '1' }, '/u', '/n/node.exe', 'shared').HWPX_COWORK_LOCAL, undefined);
  assert.equal(desktopEnvironment({}, '/u', '/n/node.exe', 'runner').HWPX_COWORK_LOCAL, undefined);
  assert.equal(placeName('win32'), '이 PC'); assert.equal(placeName('darwin'), '내 Mac');
  const dir = temporary();
  try {
    const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'win32' });
    assert.match(host.state.message, /이 PC/); assert.equal(host.state.shareSupported, true); assert.equal(host.state.mode, 'shared');
    assert.equal(new DesktopHost({ payload: root, node: process.execPath, userdata: dir, platform: 'win32' }).state.shareSupported, false, '개인용은 외부 접속 없음');
    assert.equal(new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'darwin' }).state.shareSupported, false, 'Mac 은 아직 없음');
  } finally { cleanup(dir); }
});

// quick-tunnel.mjs 를 흉내 내는 자식: 'stop' 을 받으면 공유 주소를 되돌리고 끝난다
function fakeTunnel({ lines = [], failWith = null } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.connected = true;
    child.send = (m) => { if (m === 'stop') setImmediate(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0); }); };
    child.kill = () => child.send('stop');
    setImmediate(() => {
      if (failWith) { child.stderr.write(`[오류] ${failWith}\n`); setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); }); return; }
      for (const l of lines) child.stdout.write(l + '\n');
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('외부 접속 열기: quick-tunnel 을 cloudflared 경로와 IPC 로 띄우고 발급 주소를 상태에 싣는다 → 닫기는 IPC stop', async () => {
  const dir = temporary();
  const { spawnImpl, calls } = fakeTunnel({ lines: ['Cloudflare Quick Tunnel 을 엽니다', '   - 웹:  https://calm-river-12.trycloudflare.com/', '   - MCP: https://calm-river-12.trycloudflare.com/mcp'] });
  const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'win32', spawnImpl });
  host.state.phase = 'ready';
  const states = []; host.on('state', (s) => states.push(s.share));
  try {
    const url = await host.openShare('C:\\tools\\cloudflared.exe');
    assert.equal(url, 'https://calm-river-12.trycloudflare.com');
    assert.equal(host.state.share, 'on'); assert.equal(host.state.shareUrl, url);
    assert.ok(calls[0].args.some((a) => a.endsWith(path.join('scripts', 'quick-tunnel.mjs'))));
    assert.deepEqual(calls[0].args.slice(-2), ['--cloudflared', 'C:\\tools\\cloudflared.exe']);
    assert.ok(calls[0].options.stdio.includes('ipc'), '정상 종료(공유 주소 되돌리기)는 IPC 로');
    assert.equal(calls[0].options.env.HWPX_COWORK_CONFIG, path.join(dir, 'config.json'));
    await assert.rejects(host.openShare('x'), /이미 열려/);
    await host.closeShare();
    assert.equal(host.state.share, 'off'); assert.equal(host.tunnel, null);
    assert.deepEqual(states.slice(0, 2), ['opening', 'on']);
  } finally { cleanup(dir); }
});

test('외부 접속 실패: 주소 전에 끝나면 오류 글(quick-tunnel 의 [오류] 줄)을 알리고 상태는 error', async () => {
  const dir = temporary();
  const { spawnImpl } = fakeTunnel({ failWith: '60초 안에 터널이 열리지 않았습니다.' });
  const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'win32', spawnImpl });
  host.state.phase = 'ready';
  try {
    await assert.rejects(host.openShare('cf.exe'), /60초 안에 터널이 열리지 않았습니다/);
    assert.equal(host.state.share, 'error'); assert.equal(host.tunnel, null);
    host.state.phase = 'starting';
    await assert.rejects(host.openShare('cf.exe'), /준비된 뒤/);
  } finally { cleanup(dir); }
});

test('cloudflared: 주소 줄 읽기·서명 규칙(Cloudflare 유효 서명만)·찾는 순서·서명이 틀리면 지우고 거절', async () => {
  assert.equal(shareUrlFromLine('   - 웹:  https://Calm-1.trycloudflare.com/'), 'https://calm-1.trycloudflare.com');
  assert.equal(shareUrlFromLine('2026 INF |  https://api.trycloudflare.com'), null);
  assert.equal(signedByCloudflare({ status: 'Valid', subject: 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", L=San Francisco' }), true);
  assert.equal(signedByCloudflare({ status: 'NotSigned', subject: '' }), false);
  assert.equal(signedByCloudflare({ status: 'Valid', subject: 'CN=Someone, O=Other' }), false);
  const dir = temporary();
  try {
    const exists = (p) => p === path.join('C:', 'bin', 'cloudflared.exe');
    assert.equal(findCloudflared(dir, { env: { PATH: [path.join('C:', 'bin')].join(path.delimiter) }, exists }), path.join('C:', 'bin', 'cloudflared.exe'));
    assert.equal(findCloudflared(dir, { env: {}, exists: () => false }), null);
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('MZ fake').buffer });
    await assert.rejects(installCloudflared(dir, { fetchImpl, signature: () => ({ status: 'NotSigned', subject: '' }) }), /서명을 확인하지 못해/);
    assert.equal(fs.existsSync(cloudflaredPath(dir)), false); assert.equal(fs.existsSync(cloudflaredPath(dir) + '.part'), false);
    const file = await installCloudflared(dir, { fetchImpl, signature: () => ({ status: 'Valid', subject: 'O="Cloudflare, Inc."' }) });
    assert.equal(file, cloudflaredPath(dir)); assert.equal(fs.readFileSync(file, 'utf8'), 'MZ fake');
    assert.equal(findCloudflared(dir, { env: {} }), file, '앱이 받아 둔 것을 먼저');
  } finally { cleanup(dir); }
});

// ── AI 실행기(runners.mjs) ──────────────────────────────────────────────────────────────────────
const TOKEN = 'remote-token-NEVER-IN-LOGS-0123456789';
const LOCAL_TOKEN = 'local-admin-token-NEVER-IN-LOGS-9876';
// safeStorage 대역: 되돌릴 수 있지만 평문이 보이지 않는 암호문
const vault = { available: () => true, encrypt: (text) => `sealed:${Buffer.from(text).reverse().toString('base64')}`, decrypt: (sealed) => Buffer.from(String(sealed).slice(7), 'base64').reverse().toString() };
function fakeFetch({ me = { name: '홍길동', role: 'editor' }, meStatus = 200, config = { features: { mcp2: true, mcp3: true } }, meText = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization || null, redirect: init.redirect });
    const u = new URL(url);
    if (u.pathname.endsWith('/api/me')) return { ok: meStatus >= 200 && meStatus < 300, status: meStatus, json: async () => { if (meText) throw new SyntaxError('not json'); return me; } };
    if (u.pathname.endsWith('/api/config')) return { ok: true, status: 200, json: async () => config };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}
// setup-worker.mjs 를 흉내 내는 자식: 'stop'(IPC)을 받으면 끝나고, 'exit' 뒤 출력이 닫히면 'close'
function fakeRunners() {
  const children = [];
  const launch = (args, env) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, connected: true, pid: 4000 + children.length, sent: [], args, env, exitOnStop: true });
    child.send = (m) => { child.sent.push(m); if (m === 'stop' && child.exitOnStop) setImmediate(() => child.exit(0)); };
    child.exit = (code = 0) => {
      if (child.exitCode !== null) return;
      child.exitCode = code; child.connected = false; child.emit('exit', code, null);
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', code, null); });
    };
    child.say = (text) => child.stderr.write(`[hwpx 개인 AI] ${text}\n`);
    children.push(child);
    return child;
  };
  return { launch, children };
}
// 다시 띄우기·정상 종료 기다림을 손으로 진행하는 타이머
function fakeTimers() {
  let seq = 0; const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    delays: () => [...pending.values()].map((t) => t.ms).sort((a, b) => a - b),
    run(ms) { let ran = 0; for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); ran++; } return ran; },
  };
}
function manager(dir, options = {}) {
  const runners = fakeRunners(); const timers = fakeTimers(); const { fetchImpl, calls } = fakeFetch(options.fetch);
  const prepared = []; const killed = [];
  const m = new RunnerManager({
    dir, vault, launch: runners.launch, timers, fetchImpl,
    prepare: options.prepare || (async (ai, opts) => { prepared.push({ ai, interactive: opts.interactive }); }),
    cancelPrepare: options.cancelPrepare || (() => {}),
    local: options.local || (() => ({ mcpUrl: 'http://127.0.0.1:47123/mcp', token: LOCAL_TOKEN })),
    env: () => ({ PATH: 'x', HWPX_COWORK_DESKTOP_MANAGED: '1' }),
    kill: (child) => { killed.push(child.pid); child.exit(1); },
    now: options.now || Date.now, localSupported: options.localSupported, migrate: options.migrate,
    timing: { restartDelays: [5000, 15000, 45000], stableMs: 600000, quietMs: 45000, stopMs: 45000, killWaitMs: 5000, ...options.timing },
  });
  return { m, runners, timers, calls, prepared, killed };
}
const view = (m, id) => m.snapshot().runners.find((r) => r.id === id);
const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));

test('다른 서버 주소: https://…/·…/mcp·스킴 없이 → 기준 주소와 MCP 주소, 인터넷 http·인증정보·?# 는 거절', () => {
  assert.deepEqual(serverAddress('https://cowork.example.com/'), { base: 'https://cowork.example.com/', mcpUrl: 'https://cowork.example.com/mcp' });
  assert.deepEqual(serverAddress('https://cowork.example.com/mcp'), serverAddress('cowork.example.com'));
  assert.deepEqual(serverAddress(' https://x.example/hwpx/mcp/ '), { base: 'https://x.example/hwpx/', mcpUrl: 'https://x.example/hwpx/mcp' });
  assert.equal(serverAddress('http://localhost:8787').mcpUrl, 'http://localhost:8787/mcp', '이 PC 의 운영 서버');
  assert.equal(serverAddress('http://192.168.0.10:8787/').base, 'http://192.168.0.10:8787/');
  assert.throws(() => serverAddress('http://cowork.example.com'), /https/);
  assert.throws(() => serverAddress('https://me:pw@cowork.example.com'), /아이디·비밀번호/);
  assert.throws(() => serverAddress('https://cowork.example.com/?token=x'), /\? 나 #/);
  assert.throws(() => serverAddress('ftp://cowork.example.com'), /https/);
  assert.throws(() => serverAddress(''), /주소/);
  for (const h of ['localhost', '127.0.0.1', '[::1]', '10.1.2.3', '172.20.0.1', '192.168.1.5', '100.100.1.1', 'nas.local']) assert.equal(privateHost(h), true, h);
  for (const h of ['8.8.8.8', '172.32.0.1', 'cowork.example.com', '100.128.0.1']) assert.equal(privateHost(h), false, h);
  assert.equal(hostLabel('https://x.example/hwpx/'), 'x.example/hwpx');
});

test('실행기 줄 읽기: server/worker.js·ai-worker.mjs 가 남기는 줄 → 연결됨·처리 중·끝·다시 시도·스스로 멈춤·시작 점검 실패', () => {
  const k = (text) => runnerLine(`[hwpx 개인 AI] ${text}`);
  assert.deepEqual(k('홍길동의 요청을 처리합니다.'), { kind: 'user', user: '홍길동', text: '홍길동의 요청을 처리합니다.' });
  assert.equal(k('김의진의 요청을 처리합니다.').user, '김의진');
  assert.equal(k('자동 처리를 시작했습니다. 종료하려면 Ctrl+C를 누르세요.').kind, 'ready');
  assert.equal(k('Codex가 작업 도구(task·read·edit·finish)로 필요한 범위만 읽고 결과를 직접 등록합니다.').kind, 'working');
  assert.equal(k('Claude Code가 MCP로 요청 전문·전체 문서와 서식을 읽고 결과를 직접 등록합니다.').kind, 'working');
  assert.equal(k('모델 gpt-5.5 · 추론 강도 high(웹 설정)').kind, 'working');
  assert.equal(k('Codex 판단 실패로 기본 설정 사용: gpt-5 · 추론 강도 기본').kind, 'working', '"실패"가 들어 있어도 처리 중 줄');
  assert.equal(k('Codex MCP 작업을 완료했습니다. 결과는 편집기에서 확인할 수 있습니다.').kind, 'done');
  assert.equal(k('내 AI 작업 한 건을 완료했습니다. 결과는 편집기에서 확인할 수 있습니다.').kind, 'done');
  assert.equal(k('Codex가 수행하지 못한 사유를 MCP에 등록했습니다.').kind, 'done');
  assert.equal(k('요청 알림 연결을 다시 시도합니다.').kind, 'retry');
  assert.equal(k('중앙 서버 연결을 확인한 뒤 다시 시도합니다.').kind, 'retry');
  assert.equal(k('개인 AI 실행기를 중지합니다. 로그인·사용 권한·모델·API 도구 설정을 점검하고 다시 켜 주세요. 남은 대기 요청은 유지됩니다.').kind, 'stopping');
  assert.deepEqual([k('codex login으로 본인 ChatGPT 계정에 로그인해 주세요.').kind, k('codex login으로 본인 ChatGPT 계정에 로그인해 주세요.').config], ['failed', true]);
  assert.equal(k('중앙 서버를 최신 버전으로 업데이트하세요. --mcp 2(새 MCP 연결)를 지원하지 않는 서버입니다.').config, true);
  assert.equal(k('중앙 서버 주소와 본인 HWPX 토큰을 확인하세요.').config, false, '주소·토큰(일시적인 502 등)은 다시 띄워 본다');
  assert.equal(k('실행하지 못했습니다. 중앙 주소·본인 토큰·로그인·모델 설정을 확인해 주세요.').config, false, '네트워크 오류일 수 있다');
  assert.equal(k('AI 사용량: 입력 10, 캐시 0, 출력 5').kind, 'info');
  assert.equal(runnerLine('Error: something').kind, null);
  // 줄 글의 출처와 맞춘다 — 실행기 쪽 문구가 바뀌면 이 시험이 runnerLine 을 고치라고 알린다
  const worker = fs.readFileSync(path.join(root, 'server/worker.js'), 'utf8'); const aiWorker = fs.readFileSync(path.join(root, 'scripts/ai-worker.mjs'), 'utf8');
  for (const phrase of ['작업 도구(task·read·edit·finish)로', 'MCP로 요청 전문', 'MCP 작업을 완료했습니다', '작업 한 건을 완료했습니다', '사유를 MCP에 등록했습니다', '다시 시도합니다', '실행기를 중지합니다', '[hwpx 개인 AI]', '모델 ${run.model']) assert.ok(worker.includes(phrase), `server/worker.js: ${phrase}`);
  for (const phrase of ['의 요청을 처리합니다.', '자동 처리를 시작했습니다', '[hwpx 개인 AI]']) assert.ok(aiWorker.includes(phrase), `scripts/ai-worker.mjs: ${phrase}`);
  assert.equal(redact(`token ${TOKEN} again ${TOKEN}`, [TOKEN]), 'token *** again ***');
});

test('다른 서버 추가: /api/me·/api/config 확인 → 토큰은 safeStorage 암호문으로만 저장(목록·기록·명령줄에 없음), 실행기에는 환경 변수로', async () => {
  const dir = temporary();
  try {
    const { m, runners, calls } = manager(dir);
    const server = await m.addServer({ url: 'https://cowork.example.com/mcp', token: ` ${TOKEN} ` });
    assert.deepEqual([server.url, server.host, server.user, server.roleLabel, server.mcp2], ['https://cowork.example.com/', 'cowork.example.com', '홍길동', '편집자', true]);
    assert.deepEqual(calls.map((c) => [new URL(c.url).pathname, c.auth, c.redirect]), [['/api/me', `Bearer ${TOKEN}`, 'error'], ['/api/config', null, 'error']], '토큰은 /api/me 머리글로만');
    const runner = m.addRunner({ ai: 'codex', server: server.id });
    assert.deepEqual([runner.mcp, runner.autoStart, runner.state, runner.stateLabel], [3, true, 'off', '꺼짐'], '기본: TSV 연결(v3)·자동 시작');
    await m.start(runner.id);
    const child = runners.children[0];
    assert.deepEqual(child.args, ['--provider', 'codex', '--url', 'https://cowork.example.com/mcp', '--mcp', '3']);
    assert.equal(child.env.HWPX_COWORK_TOKEN, TOKEN, '토큰은 환경 변수로만');
    child.say(`홍길동의 요청을 처리합니다.`); child.stdout.write(`잘못 찍힌 토큰 ${TOKEN}\n`);
    await settle();
    assert.equal(view(m, runner.id).state, 'connected');
    await m.stop(runner.id);
    assert.deepEqual(child.sent, ['stop'], '정상 종료는 IPC stop');
    // 디스크·화면 어디에도 평문 토큰이 없다
    for (const file of filesUnder(dir)) assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN), file);
    assert.ok(!JSON.stringify(m.snapshot()).includes(TOKEN));
    assert.ok(m.lines(runner.id).some((l) => l.text === '잘못 찍힌 토큰 ***'), '실행기가 토큰을 찍어도 기록에는 가린다');
    assert.ok(!JSON.stringify(child.args).includes(TOKEN));
    const secrets = JSON.parse(fs.readFileSync(m.secretFile, 'utf8'));
    assert.equal(vault.decrypt(secrets.tokens[server.id]), TOKEN, '암호문은 vault 로만 풀린다');
    assert.ok(!fs.readFileSync(m.listFile, 'utf8').includes('sealed:'), '목록 파일에는 암호문도 두지 않는다');
    // 같은 주소를 다시 추가하면 토큰·이름만 바꾼다
    const again = await m.addServer({ url: 'cowork.example.com', token: 'other-token-123456' });
    assert.equal(again.id, server.id); assert.equal(m.snapshot().servers.length, 1);
    assert.throws(() => m.removeServer(server.id), /실행기를 먼저 삭제/);
    await m.removeRunner(runner.id); m.removeServer(server.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(m.secretFile, 'utf8')).tokens, {}, '서버를 지우면 토큰도 지운다');
  } finally { cleanup(dir); }
});

test('다른 서버 확인 실패: 토큰 틀림·서버 아님·체험 계정·암호화 불가면 저장하지 않는다', async () => {
  const dir = temporary();
  try {
    await assert.rejects(manager(dir, { fetch: { meStatus: 401 } }).m.addServer({ url: 'https://a.example', token: TOKEN }), /토큰을 확인/);
    await assert.rejects(manager(dir, { fetch: { meText: true } }).m.addServer({ url: 'https://a.example', token: TOKEN }), /HWPX Cowork 서버가 아닙니다/);
    await assert.rejects(manager(dir, { fetch: { me: { name: 'test1', role: 'editor', tutorialApiOnly: true } } }).m.addServer({ url: 'https://a.example', token: TOKEN }), /체험 계정/);
    await assert.rejects(manager(dir).m.addServer({ url: 'https://a.example', token: '' }), /토큰/);
    const locked = new RunnerManager({ dir, vault: { available: () => false }, launch: () => { throw new Error('no'); }, fetchImpl: fakeFetch().fetchImpl });
    await assert.rejects(locked.addServer({ url: 'https://a.example', token: TOKEN }), /안전하게 보관할 수 없어/);
    assert.equal(fs.existsSync(path.join(dir, 'runner-secrets.json')), false);
    assert.deepEqual(manager(dir).m.snapshot().servers, []);
  } finally { cleanup(dir); }
});

test('연결 방식: 새 연결을 모르는 서버에는 v2 를 막고 v1 은 허용, Google CLI 는 --mcp 없이, 같은 AI·서버는 하나만', async () => {
  const dir = temporary();
  try {
    const { m, runners } = manager(dir, { fetch: { config: { features: {} } } });
    const old = await m.addServer({ url: 'https://old.example', token: TOKEN });
    assert.equal(old.mcp2, false);
    assert.throws(() => m.addRunner({ ai: 'claude-code', server: old.id }), /MCP v3\(TSV\) 지원을 확인할 수 없습니다/);
    const v1 = m.addRunner({ ai: 'claude-code', server: old.id, mcp: 1, autoStart: false });
    assert.deepEqual([v1.mcp, v1.autoStart], [1, false]);
    assert.throws(() => m.updateRunner(v1.id, { mcp: 2 }), /지원하지 않습니다/);
    assert.throws(() => m.addRunner({ ai: 'claude-code', server: old.id, mcp: 1 }), /이미 있습니다/);
    const gemini = m.addRunner({ ai: 'gemini-cli', server: old.id });
    assert.equal(gemini.mcp, null, 'Google CLI 는 MCP 로 일하지 않는다');
    await m.start(gemini.id);
    assert.deepEqual(runners.children[0].args, ['--provider', 'gemini-cli', '--url', 'https://old.example/mcp']);
    await m.start(v1.id);
    assert.deepEqual(runners.children[1].args.slice(-2), ['--mcp', '1']);
    assert.throws(() => m.addRunner({ ai: 'openai', server: old.id }), /AI를 골라/, 'API 키 실행기는 이 창에서 다루지 않는다');
    assert.throws(() => m.addRunner({ ai: 'codex', server: 's-00000000' }), /없는 서버/);
    await m.stopAll();
  } finally { cleanup(dir); }
});

test('실행기 MCP v3 선택을 저장·다시 불러와 시작하고 v2 전용 서버의 v3 선택을 막는다', async () => {
  const dir = temporary();
  let loaded;
  try {
    const initial = manager(dir, { fetch: { config: { features: { mcp2: true, mcp3: true } } } }).m;
    const server = await initial.addServer({ url: 'https://tsv.example', token: TOKEN });
    assert.equal(server.mcp3, true);
    const remote = initial.addRunner({ ai: 'codex', server: server.id, autoStart: false });
    assert.equal(remote.mcp, 3, '연결 방식의 기본은 v3');
    assert.equal(initial.updateRunner(remote.id, { mcp: 3 }).mcp, 3);
    const local = initial.addRunner({ ai: 'claude-code', server: LOCAL_SERVER, autoStart: false, mcp: 3 });

    loaded = manager(dir, { fetch: { config: { features: { mcp2: true } } } });
    assert.equal(loaded.m.snapshot().servers[0].mcp3, true);
    for (const r of [remote, local]) {
      assert.equal(view(loaded.m, r.id).mcp, 3);
      await loaded.m.start(r.id);
      const child = loaded.runners.children.at(-1);
      assert.deepEqual(child.args.slice(-2), ['--mcp', '3']);
      assert.equal(parseWorkerArgs(child.args, child.env).mcp, '3');
    }

    const older = await loaded.m.addServer({ url: 'https://old.example', token: TOKEN });
    assert.deepEqual([older.mcp2, older.mcp3], [true, false]);
    assert.throws(() => loaded.m.addRunner({ ai: 'codex', server: older.id, mcp: 3 }), /MCP v3\(TSV\) 지원을 확인할 수 없습니다/);
    const v2 = loaded.m.addRunner({ ai: 'codex', server: older.id, mcp: 2 });
    assert.throws(() => loaded.m.updateRunner(v2.id, { mcp: 3 }), /MCP v3\(TSV\) 지원을 확인할 수 없습니다/);
    assert.equal(view(loaded.m, v2.id).mcp, 2);
    assert.equal(loaded.runners.children.length, 2, '거절한 선택으로 실행기를 시작하지 않는다');
  } finally {
    await loaded?.m.stopAll();
    cleanup(dir);
  }
});

test('실행기 추가와 설정 화면의 연결 선택에 v3 TSV가 있으며 추가의 기본 선택은 v3다', () => {
  const html = fs.readFileSync(path.join(root, 'deploy', 'desktop', 'runners.html'), 'utf8');
  const panel = /<select\b[^>]*\bid="mcp"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(panel, '추가 화면의 연결 선택');
  assert.deepEqual([...panel[1].matchAll(/<option\b[^>]*\bvalue="([123])"/g)].map((match) => match[1]), ['3', '2', '1']);
  assert.match(panel[1], /<option\b[^>]*\bvalue="3"[^>]*>[^<]*TSV/);
  const js = fs.readFileSync(path.join(root, 'deploy', 'desktop', 'runners.js'), 'utf8');
  const edit = js.slice(js.indexOf('function settingsPanel('), js.indexOf('function runnerRow('));
  assert.match(edit, /el\('option',\s*\{\s*value:\s*'3',\s*text:\s*'[^']*TSV/);
});

test('앱 인자는 실제 ai-worker 가 받는 꼴이다(토큰은 환경 변수): codex·claude-code 는 --mcp 2/1, Google CLI 는 MCP 없이', () => {
  const env = { HWPX_COWORK_TOKEN: TOKEN };
  const codex = parseWorkerArgs(['--provider', 'codex', '--url', 'https://cowork.example.com/mcp', '--mcp', '2'], env);
  assert.deepEqual([codex.provider, codex.url, codex.mcp, codex.token], ['codex', 'https://cowork.example.com/mcp', '2', TOKEN]);
  assert.equal(parseWorkerArgs(['--provider', 'claude-code', '--url', 'http://127.0.0.1:47123/mcp', '--mcp', '1'], env).mcp, '1');
  for (const ai of ['gemini-cli', 'antigravity']) assert.equal(parseWorkerArgs(['--provider', ai, '--url', 'https://cowork.example.com/mcp'], env).provider, ai);
  assert.deepEqual(Object.keys(RUNNER_AIS), ['codex', 'claude-code', 'gemini-cli', 'antigravity']);
  assert.deepEqual(Object.values(RUNNER_STATES), ['꺼짐', '준비', '연결됨', '처리 중', '대기', '오류']);
});

test('상태: 준비 → 연결됨(사용자) → 처리 중 → 연결됨, 연결 다시 시도 = 대기(조용해지면 연결됨), 기록 파일은 설정 폴더 runner-logs', async () => {
  const dir = temporary();
  try {
    const { m, runners, timers, prepared } = manager(dir);
    const runner = m.addRunner({ ai: 'claude-code', server: LOCAL_SERVER });
    await m.start(runner.id);
    assert.deepEqual(prepared, [{ ai: 'claude-code', interactive: true }], '직접 켜면 설치·로그인 창을 띄울 수 있다');
    const child = runners.children[0];
    assert.deepEqual(child.args, ['--provider', 'claude-code', '--url', 'http://127.0.0.1:47123/mcp', '--mcp', '3']);
    assert.equal(child.env.HWPX_COWORK_TOKEN, LOCAL_TOKEN);
    assert.equal(view(m, runner.id).state, 'preparing'); assert.equal(view(m, runner.id).active, true);
    child.say('관리자의 요청을 처리합니다.'); child.say('자동 처리를 시작했습니다. 종료하려면 Ctrl+C를 누르세요.'); await settle();
    assert.deepEqual([view(m, runner.id).state, view(m, runner.id).user, view(m, runner.id).serverLabel], ['connected', '관리자', '이 앱의 서버']);
    child.say('Claude Code가 작업 도구(task·read·edit·finish)로 필요한 범위만 읽고 결과를 직접 등록합니다.'); await settle();
    assert.equal(view(m, runner.id).stateLabel, '처리 중');
    child.say('요청 알림 연결을 다시 시도합니다.'); await settle();
    assert.equal(view(m, runner.id).state, 'working', '처리 중에는 알림 재연결로 바꾸지 않는다');
    child.say('Claude Code MCP 작업을 완료했습니다. 결과는 편집기에서 확인할 수 있습니다.'); await settle();
    assert.equal(view(m, runner.id).state, 'connected');
    child.say('중앙 서버 연결을 확인한 뒤 다시 시도합니다.'); await settle();
    assert.equal(view(m, runner.id).state, 'waiting');
    assert.equal(timers.run(45000), 1); assert.equal(view(m, runner.id).state, 'connected', '조용해지면 다시 연결됨');
    child.say('Claude Code가 작업 도구(task·read·edit·finish)로 필요한 범위만 읽고 결과를 직접 등록합니다.'); await settle();
    child.say('개인 AI 처리에 실패했습니다. 개인 PC의 AI 로그인(Codex·Claude Code) 또는 API 키·모델·연결 상태를 확인한 뒤 다시 요청해 주세요.'); await settle();
    assert.equal(view(m, runner.id).state, 'connected', '요청 실패 뒤에도 실행기는 계속 연결됨');
    const lines = m.lines(runner.id).map((l) => l.text);
    assert.ok(lines.some((t) => t.startsWith('[앱] 켭니다 — Claude Code · 이 앱의 서버 · 연결 v3')));
    assert.ok(lines.includes('[hwpx 개인 AI] 관리자의 요청을 처리합니다.'));
    await m.stop(runner.id);
    assert.deepEqual([view(m, runner.id).state, view(m, runner.id).active], ['off', false]);
    const file = fs.readFileSync(m.logFile(runner.id), 'utf8');
    assert.ok(m.logFile(runner.id).startsWith(path.join(dir, 'runner-logs')));
    assert.match(file, /\t\[hwpx 개인 AI\] 관리자의 요청을 처리합니다\.\n/); assert.match(file, /\[앱\] 실행기가 끝났습니다\(0\)/);
    assert.ok(!file.includes(LOCAL_TOKEN));
    // 앱을 다시 켜면(새 관리자) 앞 실행의 최근 줄을 기록 파일에서 읽어 보인다
    const reopened = manager(dir).m;
    assert.ok(reopened.lines(runner.id).some((l) => l.text === '[hwpx 개인 AI] 관리자의 요청을 처리합니다.'));
  } finally { cleanup(dir); }
});

test('뜻하지 않은 종료: 간격을 늘려 다시 띄우고, 한도를 넘으면 오류. 오래 잘 돌았으면 횟수를 다시 센다', async () => {
  const dir = temporary();
  try {
    let clock = 1_000_000;
    const { m, runners, timers, prepared } = manager(dir, { now: () => clock });
    const runner = m.addRunner({ ai: 'codex', server: LOCAL_SERVER });
    await m.start(runner.id);
    runners.children[0].say('관리자의 요청을 처리합니다.'); await settle();
    runners.children[0].exit(3); await settle();
    assert.equal(view(m, runner.id).state, 'waiting'); assert.match(view(m, runner.id).message, /5초 뒤 다시 켭니다\(1\/3\)/);
    assert.deepEqual(timers.delays(), [5000]); assert.equal(view(m, runner.id).active, true, '다시 켜기를 기다리는 동안은 [끄기]');
    timers.run(5000); await settle();
    assert.equal(runners.children.length, 2); assert.equal(prepared.at(-1).interactive, false, '다시 띄울 때는 로그인 창을 띄우지 않는다');
    runners.children[1].exit(1); await settle();
    assert.deepEqual(timers.delays(), [15000]);
    timers.run(15000); await settle();
    runners.children[2].say('관리자의 요청을 처리합니다.'); await settle();
    clock += 11 * 60000;   // 10분 넘게 잘 돌다가 끝남 → 처음부터 다시 센다
    runners.children[2].exit(1); await settle();
    assert.deepEqual(timers.delays(), [5000]);
    timers.run(5000); await settle(); runners.children[3].exit(1); await settle();
    timers.run(15000); await settle(); runners.children[4].exit(1); await settle();
    timers.run(45000); await settle();
    runners.children[5].say('실행하지 못했습니다. 중앙 주소·본인 토큰·로그인·모델 설정을 확인해 주세요.'); await settle();
    runners.children[5].exit(1); await settle();
    assert.equal(view(m, runner.id).state, 'error'); assert.match(view(m, runner.id).message, /여러 번 다시 켜도 멈췄습니다\. 실행하지 못했습니다/);
    assert.deepEqual(timers.delays(), [], '더 다시 띄우지 않는다');
    assert.equal(runners.children.length, 6);
  } finally { cleanup(dir); }
});

test('다시 띄워도 낫지 않는 경우: 시작 점검의 로그인 오류·실행기가 스스로 멈춤은 바로 오류(다시 띄우지 않음)', async () => {
  const dir = temporary();
  try {
    const { m, runners, timers } = manager(dir);
    const runner = m.addRunner({ ai: 'codex', server: LOCAL_SERVER });
    await m.start(runner.id);
    runners.children[0].say('codex login으로 본인 ChatGPT 계정에 로그인해 주세요.'); await settle();
    runners.children[0].exit(1); await settle();
    assert.equal(view(m, runner.id).state, 'error'); assert.match(view(m, runner.id).message, /codex login/);
    assert.deepEqual(timers.delays(), []);
    await m.start(runner.id);   // 오류에서 다시 켜기
    const child = runners.children[1];
    child.say('관리자의 요청을 처리합니다.'); await settle();
    child.say('개인 AI 실행기를 중지합니다. 로그인·사용 권한·모델·API 도구 설정을 점검하고 다시 켜 주세요. 남은 대기 요청은 유지됩니다.'); await settle(20);
    assert.deepEqual(child.sent, ['stop'], '스스로 멈춘 실행기(IPC 가 남아 살아 있음)를 앱이 정상 종료');
    assert.equal(view(m, runner.id).state, 'error'); assert.match(view(m, runner.id).message, /실행기를 중지합니다/);
    assert.deepEqual(timers.delays(), []);
  } finally { cleanup(dir); }
});

test('끄기: 정상 종료를 기다리지 못하면 그 실행기만 강제로 끄고, 준비 중에 끄면 CLI 준비를 멈추고 띄우지 않는다', async () => {
  const dir = temporary();
  try {
    const { m, runners, timers, killed } = manager(dir);
    const runner = m.addRunner({ ai: 'codex', server: LOCAL_SERVER });
    await m.start(runner.id);
    runners.children[0].exitOnStop = false;
    const stopping = m.stop(runner.id); await settle();
    assert.equal(view(m, runner.id).stopping, true);
    assert.deepEqual(timers.delays(), [45000]);
    timers.run(45000); await stopping;
    assert.deepEqual(killed, [runners.children[0].pid]);
    assert.equal(view(m, runner.id).state, 'off');
    assert.ok(m.lines(runner.id).some((l) => l.text.includes('강제로 끕니다')));
    // 준비(설치·로그인) 중에 끄기
    let finish; const cancelled = [];
    const slow = manager(dir, { prepare: () => new Promise((resolve) => { finish = resolve; }), cancelPrepare: (ai) => cancelled.push(ai) });
    const r2 = slow.m.addRunner({ ai: 'gemini-cli', server: LOCAL_SERVER });
    const starting = slow.m.start(r2.id); await settle();
    assert.equal(view(slow.m, r2.id).state, 'preparing');
    await slow.m.stop(r2.id); finish();
    assert.equal((await starting).state, 'off');
    assert.deepEqual(cancelled, ['gemini-cli']); assert.equal(slow.runners.children.length, 0, '취소 뒤 실행기를 띄우지 않는다');
  } finally { cleanup(dir); }
});

test('자동 시작: 자동 시작 실행기만 설치·로그인 창 없이 켜고, 켜지 못한 것을 돌려준다. 앱 종료는 모두 정상 종료하고 다시 띄우지 않는다', async () => {
  const dir = temporary();
  try {
    const { m, runners, timers, prepared } = manager(dir, { prepare: async (ai, opts) => { if (ai === 'claude-code') throw new Error('Claude 구독 로그인이 필요합니다. [켜기]를 누르면 브라우저에서 로그인합니다.'); prepared.push({ ai, interactive: opts.interactive }); } });
    const a = m.addRunner({ ai: 'codex', server: LOCAL_SERVER });
    const b = m.addRunner({ ai: 'claude-code', server: LOCAL_SERVER });
    m.addRunner({ ai: 'antigravity', server: LOCAL_SERVER, autoStart: false });
    const failed = await m.startAuto();
    assert.deepEqual(failed.map((f) => f.id), [b.id]); assert.match(view(m, b.id).message, /로그인이 필요합니다/);
    assert.deepEqual(prepared, [{ ai: 'codex', interactive: false }]);
    assert.equal(runners.children.length, 1); assert.equal(m.running(), 1);
    runners.children[0].say('관리자의 요청을 처리합니다.'); await settle();
    await m.shutdown();
    assert.deepEqual(runners.children[0].sent, ['stop']);
    assert.equal(view(m, a.id).state, 'off'); assert.deepEqual(timers.delays(), []);
    await assert.rejects(m.start(a.id), /종료하고 있습니다/);
  } finally { cleanup(dir); }
});

test('예전 "내 AI 연결"(desktop.json { ai }) → 이 앱 서버의 자동 시작 실행기 하나로 옮김. AI 실행기만 방식에는 앱 서버가 없다', () => {
  const dir = temporary(); const other = temporary();
  try {
    fs.writeFileSync(path.join(dir, 'desktop.json'), JSON.stringify({ ai: 'claude-code' }));
    const { m } = manager(dir);
    assert.deepEqual(m.snapshot().runners.map((r) => [r.ai, r.server, r.autoStart, r.mcp]), [['claude-code', LOCAL_SERVER, true, 3]]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'desktop.json'), 'utf8')).ai, 'claude-code', '예전 파일은 그대로 둔다');
    assert.equal(manager(dir).m.snapshot().runners.length, 1, '한 번만 옮긴다');
    fs.writeFileSync(path.join(other, 'desktop.json'), JSON.stringify({ ai: 'codex' }));
    const runnerOnly = manager(other, { localSupported: false }).m;
    assert.deepEqual(runnerOnly.snapshot().runners, []);
    assert.equal(runnerOnly.snapshot().localSupported, false);
    assert.throws(() => runnerOnly.addRunner({ ai: 'codex', server: LOCAL_SERVER }), /앱의 서버가 없습니다/);
    // 망가진 목록은 옆에 남기고 빈 목록으로
    fs.writeFileSync(path.join(other, 'runners.json'), '{ broken');
    assert.deepEqual(manager(other, { localSupported: false }).m.snapshot().runners, []);
    assert.ok(fs.readdirSync(other).some((n) => n.startsWith('runners.json.bad-')));
  } finally { cleanup(dir); cleanup(other); }
});

test('DesktopHost: AI 실행기만 방식은 서버를 띄우지 않고, 실행기는 setup-worker 를 IPC·토큰 환경 변수로(앱 서버 설정은 넘기지 않음) 띄운다', async () => {
  const dir = temporary();
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    spawned.push({ file, args, options });
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, connected: true, pid: 77 });
    child.send = (m) => { if (m === 'stop') setImmediate(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0, null); child.emit('close', 0, null); }); };
    return child;
  };
  try {
    const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'runner', platform: 'win32', spawnImpl, vault, runnerOptions: { fetchImpl: fakeFetch().fetchImpl } });
    assert.equal(await host.start(), null); assert.equal(host.state.phase, 'ready'); assert.equal(spawned.length, 0, '서버 없음');
    assert.equal(host.localTarget(), null); assert.equal(host.runners.snapshot().localSupported, false);
    host.prepareCli = async () => ({ ready: true });
    const server = await host.runners.addServer({ url: 'https://cowork.example.com/', token: TOKEN });
    const runner = host.runners.addRunner({ ai: 'codex', server: server.id });
    await host.runners.start(runner.id);
    const { file, args, options } = spawned[0];
    assert.equal(file, process.execPath);
    assert.equal(args[0], path.join(root, 'scripts/setup-worker.mjs'));
    assert.deepEqual(args.slice(1), ['--provider', 'codex', '--url', 'https://cowork.example.com/mcp', '--mcp', '3']);
    assert.ok(options.stdio.includes('ipc')); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.env.HWPX_COWORK_TOKEN, TOKEN); assert.equal(options.env.HWPX_COWORK_DESKTOP_MANAGED, '1');
    for (const key of ['HWPX_COWORK_CONFIG', 'HWPX_COWORK_USERDATA', 'HWPX_COWORK_LOCAL', 'HWPX_COWORK_AI']) assert.equal(options.env[key], undefined, key);
    assert.equal(runnerEnvironment({ HWPX_COWORK_TOKEN: 'leak', PATH: 'p' }).HWPX_COWORK_TOKEN, undefined, '물려받은 토큰은 지운다');
    await host.stop();
    assert.equal(host.runners.snapshot().runners[0].state, 'off');
  } finally { cleanup(dir); }
});

test('DesktopHost CLI 준비: 자동 시작은 설치·로그인 없이 오류, 직접 켜기는 설치 → 로그인, Google CLI 는 설치만 확인, 같은 AI 는 하나씩', async () => {
  const dir = temporary();
  try {
    const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, platform: 'win32', spawnImpl: () => { throw new Error('실제 CLI 를 띄우지 않는다'); } });
    host.state.aiSupported = true;
    const ran = []; let answers = [];
    host.auth = async (provider) => { ran.push(`auth:${provider}`); return answers.shift(); };
    host.run = async (script, args) => { ran.push(args[args.indexOf('--action') + 1]); return ''; };
    answers = [{ installed: false, ready: false }];
    await assert.rejects(host.prepareCli('codex', { interactive: false }), /\[켜기\]를 누르면 설치/);
    answers = [{ installed: true, ready: false, reason: 'codex login…' }];
    await assert.rejects(host.prepareCli('codex', { interactive: false }), /로그인이 필요합니다/);
    assert.deepEqual(ran, ['auth:codex', 'auth:codex'], '자동 시작은 설치·로그인을 띄우지 않는다');
    ran.length = 0; const notes = [];
    answers = [{ installed: false, ready: false }, { installed: true, ready: false }, { installed: true, ready: true }];
    assert.equal((await host.prepareCli('codex', { interactive: true, note: (t) => notes.push(t) })).ready, true);
    assert.deepEqual(ran, ['auth:codex', 'install', 'auth:codex', 'login', 'auth:codex']);
    assert.equal(notes.length, 2); assert.match(notes[1], /브라우저/);
    ran.length = 0;
    answers = [{ installed: false, ready: false, reason: 'Gemini CLI를 찾지 못했습니다. 설치 후 gemini로 먼저 로그인하세요.' }];
    await assert.rejects(host.prepareCli('gemini-cli', { interactive: true }), /Gemini CLI를 찾지 못했습니다/);
    assert.deepEqual(ran, ['auth:gemini-cli'], 'Google CLI 는 설치·로그인을 앱이 하지 않는다');
    answers = [{ installed: true, ready: true, note: '로그인 유효성은 실제 요청에서 확인됩니다' }];
    assert.equal((await host.prepareCli('antigravity')).installed, true);
    // 같은 AI 의 준비는 겹치지 않는다
    ran.length = 0; let release;
    host.auth = async (provider) => { ran.push(`start:${provider}`); if (!release) await new Promise((r) => { release = r; }); ran.push(`end:${provider}`); return { installed: true, ready: true }; };
    const first = host.prepareCli('claude-code'); const second = host.prepareCli('claude-code');
    await settle(); assert.deepEqual(ran, ['start:claude-code']);
    release(); await Promise.all([first, second]);
    assert.deepEqual(ran, ['start:claude-code', 'end:claude-code', 'start:claude-code', 'end:claude-code']);
    host.state.aiSupported = false; host.state.aiSupportMessage = 'macOS 13 required';
    await assert.rejects(host.prepareCli('codex'), /macOS 13 required/);
  } finally { cleanup(dir); }
});

test('앱 종료: 실행기를 먼저 정상 종료하고, 열린 터널을 닫은 뒤(공유 주소 되돌림) 서버를 끈다', async () => {
  const dir = temporary();
  const order = [];
  const { spawnImpl: tunnelSpawn } = fakeTunnel({ lines: ['   - 웹:  https://a-b.trycloudflare.com/'] });
  const spawnImpl = (file, args, options) => {
    if (!args[0].endsWith('setup-worker.mjs')) return tunnelSpawn(file, args, options);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, connected: true, pid: 99 });
    child.send = (m) => { if (m === 'stop') setImmediate(() => { order.push('runner'); child.exitCode = 0; child.connected = false; child.emit('exit', 0, null); child.emit('close', 0, null); }); };
    return child;
  };
  const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'win32', spawnImpl });
  host.state.phase = 'ready'; host.port = 47123; host.token = LOCAL_TOKEN; host.prepareCli = async () => ({ ready: true });
  try {
    await host.openShare('cf.exe');
    const runner = host.runners.addRunner({ ai: 'codex', server: LOCAL_SERVER });
    await host.runners.start(runner.id);
    const tunnel = host.tunnel;
    tunnel.once('exit', () => order.push('tunnel'));
    host.server = Object.assign(new EventEmitter(), { exitCode: null, connected: true, send(m) { if (m === 'stop') setImmediate(() => { order.push('server'); this.exitCode = 0; this.emit('exit', 0); }); } });
    await host.stop();
    assert.deepEqual(order, ['runner', 'tunnel', 'server']);
  } finally { cleanup(dir); }
});

test('진짜 프로세스: setup-worker(그대로) + 가짜 ai-worker — 상태 줄을 읽고, [끄기]는 IPC 로 정상 종료, 토큰은 기록에 남지 않는다', { timeout: 30000 }, async () => {
  const dir = temporary(); const payload = path.join(dir, 'payload'); const userdata = path.join(dir, '설정');
  fs.mkdirSync(path.join(payload, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-worker.mjs'), path.join(payload, 'scripts/setup-worker.mjs'));
  fs.writeFileSync(path.join(payload, 'scripts/ai-worker.mjs'), [
    'export async function main() {',
    '  const timer = setInterval(() => {}, 1000);',
    "  process.on('SIGTERM', () => { clearInterval(timer); process.stderr.write('[hwpx 개인 AI] 끝냅니다\\n'); });",
    "  process.stderr.write('[hwpx 개인 AI] 홍길동의 요청을 처리합니다.\\n');",
    "  process.stderr.write('[hwpx 개인 AI] 자동 처리를 시작했습니다. 종료하려면 Ctrl+C를 누르세요.\\n');",
    "  process.stdout.write('args ' + JSON.stringify(process.argv.slice(2)) + ' token ' + process.env.HWPX_COWORK_TOKEN + '\\n');",
    '}',
  ].join('\n'));
  const host = new DesktopHost({ payload, node: process.execPath, userdata, mode: 'runner', vault, runnerOptions: { fetchImpl: fakeFetch().fetchImpl } });
  host.prepareCli = async () => ({ ready: true });
  try {
    await host.start();
    const server = await host.runners.addServer({ url: 'https://cowork.example.com', token: TOKEN });
    const runner = host.runners.addRunner({ ai: 'codex', server: server.id });
    await host.runners.start(runner.id);
    const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await settle(50); } throw new Error('시간 초과'); };
    await until(() => view(host.runners, runner.id).state === 'connected');
    await until(() => host.runners.lines(runner.id).some((l) => l.text.startsWith('args ')));
    const echoed = host.runners.lines(runner.id).find((l) => l.text.startsWith('args ')).text;
    assert.equal(echoed, 'args ["--provider","codex","--url","https://cowork.example.com/mcp","--mcp","3"] token ***');
    await host.runners.stop(runner.id);
    assert.equal(view(host.runners, runner.id).state, 'off');
    const log = fs.readFileSync(host.runners.logFile(runner.id), 'utf8');
    assert.match(log, /\[hwpx 개인 AI\] 끝냅니다/, 'setup-worker 의 IPC stop → SIGTERM 정상 종료 경로');
    assert.match(log, /실행기가 끝났습니다\(0\)/);
    assert.ok(!log.includes(TOKEN));
    await host.stop();
  } finally { await host.stop(); cleanup(dir); }
});

// ── 2026-11-17 루트 bat 정리: 아래 bat 을 지우고 앱(AI 실행기 창·운영 방식)이 같은 일을 한다(사본: backups/v2_default_gui_2026-11-17/) ──
//   start-codex-agent(-v2)·start-claude-worker(-v2)·start-gemini-agent·start-antigravity-agent·start-google-agent → [AI → 실행기 관리]의 실행기
//   start-server·stop-server → 앱이 자기 서버를 켜고 끈다(혼자/함께 쓰기), 개발 폴더는 npm start(server/launcher.js)·node server/control-cli.js stop
//   start-tunnel → [함께 쓰기 → 외부 접속 열기](scripts/quick-tunnel.mjs), start-https → 서버 감시 작업이 https/run-https.mjs 를 띄운다(docs/SERVER_RECOVERY.md)
//   그 bat 만 보던 시험은 함께 지웠다: tests/start_server_batch.test.mjs(관리 실행기의 시작·중복·재시작은 restart_runtime·server_stability 가 본다),
//   codex_agent_launcher·claude_cli_ai·quick_tunnel 시험의 bat 항목(각 파일의 주석).
const REMOVED_BATS = {
  'start-codex-agent.bat': { ai: 'codex', mcp: 1 }, 'start-codex-agent-v2.bat': { ai: 'codex', mcp: 2 },
  'start-claude-worker.bat': { ai: 'claude-code', mcp: 1 }, 'start-claude-worker-v2.bat': { ai: 'claude-code', mcp: 2 },
  'start-gemini-agent.bat': { ai: 'gemini-cli' }, 'start-antigravity-agent.bat': { ai: 'antigravity' }, 'start-google-agent.bat': { ai: 'gemini-cli' },
  'start-server.bat': null, 'stop-server.bat': null, 'start-tunnel.bat': null, 'start-https.bat': null,
};
test('지운 실행기 bat 이 하던 일을 앱 실행기가 같은 실행기·같은 인자로 한다(bat 은 저장소·공개 목록에 없다)', async () => {
  for (const name of Object.keys(REMOVED_BATS)) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `${name} 은 지웠다`);
    assert.ok(fs.existsSync(path.join(root, 'backups/v2_default_gui_2026-11-17', name)), `${name} 사본`);
  }
  const exportList = fs.readFileSync(path.join(root, 'scripts/export-public-repo.mjs'), 'utf8');
  for (const name of Object.keys(REMOVED_BATS)) assert.ok(!exportList.includes(`'${name}'`), `공개 목록에 ${name} 없음`);
  const dir = temporary();
  try {
    const { m, runners } = manager(dir);
    for (const [name, want] of Object.entries(REMOVED_BATS)) {
      if (!want || name === 'start-google-agent.bat') continue;
      const runner = m.snapshot().runners.find((r) => r.ai === want.ai) || m.addRunner({ ai: want.ai, server: LOCAL_SERVER, mcp: want.mcp ?? 2 });
      if (want.mcp) m.updateRunner(runner.id, { mcp: want.mcp });
      await m.start(runner.id);
      const child = runners.children.at(-1);
      // 예전 bat: node scripts\ai-worker.mjs(codex 는 codex-agent.mjs — 같은 ai-worker 실행기, AI 협업 큐는 기본 꺼짐) --provider <ai> [--mcp 2]
      assert.deepEqual(child.args, ['--provider', want.ai, '--url', 'http://127.0.0.1:47123/mcp', ...(want.mcp ? ['--mcp', String(want.mcp)] : [])], name);
      assert.equal(child.env.HWPX_COWORK_TOKEN, LOCAL_TOKEN, `${name}: setx 로 둔 토큰 대신 앱이 환경 변수로`);
      await m.stop(runner.id);
    }
  } finally { cleanup(dir); }
});

test('앱 묶음에 실행기가 쓰는 파일이 다 들어간다: setup-worker·desktop-ai 가 부르는 파일은 server/·engine/ 트리이거나 묶을 때 넣는 목록', () => {
  // personal-lite 묶음은 server/·engine/ 를 통째로, scripts 는 허용 목록만 싣는다 — 실행기 쪽 scripts 는 RUNNER_PAYLOAD_FILES 로 확인
  const seen = new Set(); const queue = ['scripts/setup-worker.mjs', 'deploy/desktop/desktop-ai.mjs'];
  const inPayload = (rel) => rel.startsWith('server/') || rel.startsWith('engine/') || RUNNER_PAYLOAD_FILES.includes(rel) || rel === 'deploy/desktop/desktop-ai.mjs' || rel === 'deploy/desktop/cli-versions.mjs';
  while (queue.length) {
    const rel = queue.shift(); if (seen.has(rel)) continue; seen.add(rel);
    assert.ok(inPayload(rel), `앱 묶음에 없는 파일을 부른다: ${rel}`);
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
  for (const need of ['scripts/ai-worker.mjs', 'server/worker.js', 'server/google-cli-ai.js', 'server/claude-cli-ai.js', 'server/codex-ai.js']) assert.ok(seen.has(need), need);
  for (const file of RUNNER_PAYLOAD_FILES.filter((f) => !['scripts/desktop-ai.mjs', 'scripts/cli-versions.mjs'].includes(f))) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const script of ['scripts/package-windows-desktop.mjs', 'scripts/package-macos-personal.mjs']) {
    const text = fs.readFileSync(path.join(root, script), 'utf8');
    assert.match(text, /RUNNER_PAYLOAD_FILES/, `${script} 가 묶은 뒤 확인한다`);
    assert.match(text, /desktop-ai\.mjs/); assert.match(text, /setup-worker\.mjs/);
  }
  const portable = fs.readFileSync(path.join(root, 'scripts/package-portable.mjs'), 'utf8');
  assert.match(portable, /const SERVER_TREES = \['server', 'engine'/); assert.match(portable, /'scripts\/ai-worker\.mjs'/);
  for (const file of ['runners.mjs', 'runners.html', 'runners.js', 'runners.css', 'preload.cjs']) assert.ok(fs.existsSync(path.join(root, 'deploy/desktop', file)), file);
  const html = fs.readFileSync(path.join(root, 'deploy/desktop/runners.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'"/);
  assert.match(html, /<script src="runners\.js"><\/script>/);
});
