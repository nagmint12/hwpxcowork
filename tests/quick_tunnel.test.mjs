// Cloudflare Quick Tunnel 실행기(scripts/quick-tunnel.mjs)의 순수 함수 — cloudflared·실제 서버 없이
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTunnelUrl, isRegistered, originHost, adminToken, findCloudflared, applyPublicUrl } from '../scripts/quick-tunnel.mjs';

test('cloudflared 로그에서 발급 주소만 뽑고 발급 요청 주소(api.)는 넘긴다', () => {
  assert.equal(parseTunnelUrl('2026-10-30T06:56:40Z INF |  https://Tribunal-Touch-Solve.trycloudflare.com                |'), 'https://tribunal-touch-solve.trycloudflare.com');
  assert.equal(parseTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'), null);
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.ok(isRegistered('2026-10-30T06:56:42Z INF Registered tunnel connection connIndex=0 connection=abc location=icn01 protocol=quic'));
  assert.ok(!isRegistered('INF Starting metrics server'));
});

test('터널이 붙을 주소: 모든 주소·localhost 는 127.0.0.1, IPv6 는 대괄호', () => {
  for (const h of ['0.0.0.0', '::', 'localhost', '127.0.0.1', '', undefined]) assert.equal(originHost(h), '127.0.0.1');
  assert.equal(originHost('::1'), '[::1]');
  assert.equal(originHost('192.168.0.5'), '192.168.0.5');
});

test('관리자 토큰은 config 의 첫 관리자, 없으면 HWPX_COWORK_TOKEN', () => {
  const raw = { users: [{ name: 'e', role: 'editor', token: 'E' }, { name: 'a', role: 'admin', token: 'A' }, { name: 'b', role: 'admin', token: 'B' }] };
  assert.equal(adminToken(raw, {}), 'A');
  assert.equal(adminToken({ users: [{ role: 'editor', token: 'E' }] }, { HWPX_COWORK_TOKEN: 'T' }), 'T');
  assert.equal(adminToken({}, {}), null);
});

test('cloudflared 찾기: CLOUDFLARED → PATH → 설치 폴더', () => {
  const exists = (p) => p === 'C:\\x\\cf.exe' || p === path.join('C:\\PF86', 'cloudflared', 'cloudflared.exe');
  assert.equal(findCloudflared({ env: { CLOUDFLARED: 'C:\\x\\cf.exe' }, exists, which: () => 'C:\\path\\cloudflared.exe' }), 'C:\\x\\cf.exe');
  assert.equal(findCloudflared({ env: { CLOUDFLARED: 'C:\\none.exe' }, exists, which: () => 'C:\\path\\cloudflared.exe' }), null);
  assert.equal(findCloudflared({ env: {}, exists, which: () => 'C:\\path\\cloudflared.exe' }), 'C:\\path\\cloudflared.exe');
  assert.equal(findCloudflared({ env: { 'ProgramFiles(x86)': 'C:\\PF86' }, exists, which: () => null }), path.join('C:\\PF86', 'cloudflared', 'cloudflared.exe'));
  assert.equal(findCloudflared({ env: {}, exists, which: () => null }), null);
});

/** 관리 API 흉내: saved/running 공유 주소와 재시작 지원 여부 */
function fakeServer({ saved = '', running = 'http://localhost:8787', locked = false, supported = true } = {}) {
  const s = { saved, running, calls: [] };
  const snap = () => ({
    saved: { publicUrl: s.saved }, running: { publicUrl: s.running }, revision: `r-${s.saved}`,
    restartRequired: (s.saved || 'http://localhost:8787') !== s.running,
    overrides: locked ? { publicUrl: { locked: true } } : {}, restart: { supported, busy: false },
  });
  s.call = async (method, p, body) => {
    s.calls.push(`${method} ${p}`);
    if (method === 'GET') return snap();
    assert.equal(body.revision, `r-${s.saved}`);
    if (method === 'PATCH') { s.saved = body.settings.publicUrl; return snap(); }
    s.running = s.saved || 'http://localhost:8787'; return { accepted: true };
  };
  return s;
}

test('공유 주소 저장 → 재시작, 되돌릴 때는 그 주소일 때만', async () => {
  const url = 'https://a-b.trycloudflare.com';
  const s = fakeServer();
  assert.deepEqual(await applyPublicUrl(s.call, url), { restarted: true });
  assert.deepEqual(s.calls, ['GET /api/admin/server', 'PATCH /api/admin/server', 'POST /api/admin/restart']);
  assert.equal(s.running, url);
  assert.deepEqual(await applyPublicUrl(s.call, url), { restarted: false });   // 이미 반영됨
  assert.deepEqual(await applyPublicUrl(s.call, '', { expect: url }), { restarted: true });
  assert.equal(s.saved, ''); assert.equal(s.running, 'http://localhost:8787');

  const other = fakeServer({ saved: 'https://other.example', running: 'https://other.example' });
  assert.deepEqual(await applyPublicUrl(other.call, '', { expect: url }), { skipped: true });
  assert.equal(other.saved, 'https://other.example');
});

test('환경 변수로 고정이면 바꾸지 않고, 웹 재시작이 안 되면 저장만 한다', async () => {
  const locked = fakeServer({ locked: true });
  assert.deepEqual(await applyPublicUrl(locked.call, 'https://x.trycloudflare.com'), { locked: true });
  assert.deepEqual(locked.calls, ['GET /api/admin/server']);
  const plain = fakeServer({ supported: false });
  assert.deepEqual(await applyPublicUrl(plain.call, 'https://x.trycloudflare.com'), { restarted: false, restartUnsupported: true });
  assert.equal(plain.saved, 'https://x.trycloudflare.com');
});

// 2026-11-17: start-tunnel.bat·start-server.bat 을 지웠다(사용자 결정 — Windows 앱의 [함께 쓰기 → 외부 접속 열기]가 이 실행기를 IPC 로 띄우고,
// 개발 폴더는 npm run tunnel·npm start). 그 bat 의 CRLF·호출 순서를 보던 시험은 지우고, 앱 쪽 경로는 tests/desktop_windows.test.mjs 가 본다.
test('안내 글은 지운 bat(start-tunnel·start-server) 대신 npm 명령을 알린다', () => {
  assert.equal(fs.existsSync(fileURLToPath(new URL('../start-tunnel.bat', import.meta.url))), false);
  const source = fs.readFileSync(fileURLToPath(new URL('../scripts/quick-tunnel.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /start-(tunnel|server)\.bat/);
  assert.match(source, /npm start/);
});
