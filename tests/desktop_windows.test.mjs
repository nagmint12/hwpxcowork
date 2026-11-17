// Windows 데스크톱 앱(2026-11-17): 운영 방식(혼자/함께), 공동 작업용 설정, 외부 접속(터널) 열기·닫기, cloudflared 서명 규칙.
// 실제 터널·인터넷·Electron 없이 모의 자식 프로세스로 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DesktopHost, desktopEnvironment, placeName } from '../deploy/desktop/host.mjs';
import { savedMode, saveMode, modeFromArgs, relaunchArgs, MODE_CHOICE } from '../deploy/desktop/mode.mjs';
import { shareUrlFromLine, signedByCloudflare, findCloudflared, installCloudflared, cloudflaredPath } from '../deploy/desktop/share.mjs';
import { personalConfig, sharedConfig } from '../deploy/portable/personal.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-desktop-win-'));
const cleanup = (dir) => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); };

test('운영 방식: 명령줄 → 저장값 → 예전 개인용 설치는 개인용 → 처음이면 null(묻기)', () => {
  const dir = temporary();
  try {
    assert.equal(modeFromArgs(['app.exe', '--mode', 'shared']), 'shared');
    assert.equal(modeFromArgs(['--mode=personal']), 'personal');
    assert.equal(modeFromArgs(['--mode', 'server']), null);
    assert.equal(savedMode(dir), null);
    fs.mkdirSync(path.join(dir, 'personal')); fs.writeFileSync(path.join(dir, 'personal', 'config.json'), '{}');
    assert.equal(savedMode(dir), 'personal', '방식을 고르기 전 판의 개인용 설치');
    saveMode(dir, 'shared'); assert.equal(savedMode(dir), 'shared');
    assert.throws(() => saveMode(dir, 'admin'));
    assert.deepEqual(relaunchArgs(['--verbose', '--mode', 'shared', '--mode=personal', 'x']), ['--verbose', 'x']);
    assert.deepEqual(MODE_CHOICE.modes, ['personal', 'shared']); assert.equal(MODE_CHOICE.buttons.length, 2);
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

test('데스크톱 환경: 공동 작업용은 PC 폴더 연결 환경 변수를 켜지 않고, 안내 글은 Windows 에서 "이 PC"', () => {
  assert.equal(desktopEnvironment({}, '/u', '/n/node.exe', 'personal').HWPX_COWORK_LOCAL, '1');
  assert.equal(desktopEnvironment({ HWPX_COWORK_LOCAL: '1' }, '/u', '/n/node.exe', 'shared').HWPX_COWORK_LOCAL, undefined);
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

test('앱 종료: 열린 터널을 먼저 닫고(공유 주소 되돌림) 서버를 끈다', async () => {
  const dir = temporary();
  const { spawnImpl } = fakeTunnel({ lines: ['   - 웹:  https://a-b.trycloudflare.com/'] });
  const host = new DesktopHost({ payload: root, node: process.execPath, userdata: dir, mode: 'shared', platform: 'win32', spawnImpl });
  host.state.phase = 'ready';
  try {
    await host.openShare('cf.exe');
    const order = []; const tunnel = host.tunnel;
    tunnel.once('exit', () => order.push('tunnel'));
    host.server = Object.assign(new EventEmitter(), { exitCode: null, connected: true, send(m) { if (m === 'stop') setImmediate(() => { order.push('server'); this.exitCode = 0; this.emit('exit', 0); }); } });
    await host.stop();
    assert.deepEqual(order, ['tunnel', 'server']);
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
