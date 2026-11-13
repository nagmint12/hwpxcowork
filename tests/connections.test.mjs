import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildConnectionInfo, publicConnectionUrl } from '../server/connections.js';
import { installConnectionRoutes } from '../server/routes/connections.js';

const interfaces = {
  Ethernet: [
    { address: '192.168.10.20', family: 'IPv4', internal: false, mac: 'not-for-output' },
    { address: 'fd00::10', family: 'IPv6', internal: false },
    { address: 'fe80::1%12', family: 'IPv6', internal: false },
  ],
  VPN: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
};

test('전체 IPv4 바인딩에서 localhost 설정과 실제 LAN 후보를 구분하고 인터넷 주소를 지어내지 않는다', () => {
  const info = buildConnectionInfo({ host: '0.0.0.0', port: 8787, publicUrl: 'http://localhost:8787' }, { interfaces });
  assert.equal(info.binding.scope, 'all-ipv4');
  assert.equal(info.local.webUrl, 'http://localhost:8787');
  assert.deepEqual(info.lan.map((item) => item.address).sort(), ['10.8.0.2', '192.168.10.20']);
  assert.ok(info.lan.every((item) => item.verified === false && item.mcpUrl === `${item.webUrl}/mcp`));
  assert.equal(info.configured.kind, 'local');
  assert.equal(info.external.configured, false);
  assert.equal(info.external.webUrl, null);
  assert.match(info.external.message, /인터넷 접속 주소 미설정/);
  assert.equal(info.recommended.scope, 'local');
  assert.equal(info.recommended.selectionRequired, true);
  assert.equal(info.recommended.source, 'multiple-network-interfaces');
  assert.ok(!info.lan.some((item) => item.webUrl === info.recommended.webUrl));
  assert.ok(info.lan.some((item) => item.label === 'Ethernet'));
  assert.ok(info.warnings.some((w) => w.code === 'MULTIPLE_ADDRESSES'));
  assert.ok(!JSON.stringify(info).includes('not-for-output'));
});

test('IPv4/IPv6 루프백은 다른 PC용 LAN 후보를 제시하지 않는다', () => {
  for (const host of ['127.0.0.1', '127.10.0.2', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    const info = buildConnectionInfo({ host, port: 8787 }, { interfaces });
    assert.equal(info.binding.loopbackOnly, true, host);
    assert.deepEqual(info.lan, [], host);
    assert.equal(info.recommended.scope, 'local', host);
    assert.ok(info.warnings.some((w) => w.code === 'LOOPBACK_ONLY'));
  }
  const mismatch = buildConnectionInfo({ host: '127.0.0.1', port: 8787, publicUrl: 'http://192.168.10.20:8787' }, { interfaces });
  assert.equal(mismatch.recommended.scope, 'local');
  assert.ok(mismatch.warnings.some((w) => w.code === 'INTERNAL_URL_WITH_LOOPBACK'));
});

test('IPv6 전체/지정 IP 바인딩과 포트 0을 사실대로 표시한다', () => {
  const ipv6 = buildConnectionInfo({ host: '::', port: 8787 }, { interfaces });
  assert.equal(ipv6.binding.scope, 'all-ipv6');
  assert.equal(ipv6.local.webUrl, 'http://[::1]:8787');
  assert.ok(ipv6.lan.some((item) => item.webUrl === 'http://[fd00::10]:8787'));
  assert.ok(!ipv6.lan.some((item) => item.address.startsWith('fe80')));
  assert.ok(ipv6.lan.filter((item) => item.family === 'IPv4').every((item) => /이중 스택/.test(item.note)));
  const specific = buildConnectionInfo({ host: '192.168.10.20', port: 8787 }, { interfaces });
  assert.deepEqual(specific.lan.map((item) => item.address), ['192.168.10.20']);
  assert.equal(specific.local.webUrl, 'http://192.168.10.20:8787');
  assert.equal(specific.recommended.selectionRequired, false);
  assert.equal(specific.recommended.scope, 'lan');
  const linkLocal = buildConnectionInfo({ host: '0.0.0.0', port: 8787 }, { interfaces: { Ethernet: [{ address: '169.254.1.2', internal: false }] } });
  assert.deepEqual(linkLocal.lan, []);
  const unresolved = buildConnectionInfo({ host: '0.0.0.0', port: 0 }, { interfaces });
  assert.equal(unresolved.local.webUrl, null);
  assert.equal(unresolved.recommended.webUrl, null);
  assert.ok(unresolved.warnings.some((w) => w.code === 'PORT_UNRESOLVED'));
});

test('외부 설정 주소는 연결 미검증으로 표시하고 공유 링크의 토큰·쿼리·fragment를 제거한다', () => {
  const info = buildConnectionInfo({ host: '127.0.0.1', port: 8787, publicUrl: 'https://cowork.example/hwpx/?token=SECRET#SECRET' });
  assert.equal(info.external.configured, true);
  assert.equal(info.external.verified, false);
  assert.equal(info.recommended.webUrl, 'https://cowork.example/hwpx');
  assert.equal(info.external.mcpUrl, 'https://cowork.example/hwpx/mcp');
  assert.ok(!JSON.stringify(info).includes('SECRET'));
  for (const input of ['https://cowork.example/mcp/t/SECRET/ChatGPT?token=SECRET', 'https://cowork.example/base/%6dcp/t/SECRET', 'https://cowork.example/t/SECRET']) {
    const safe = publicConnectionUrl(input);
    assert.ok(!JSON.stringify(safe).includes('SECRET'), input);
    assert.ok(!safe.mcpUrl?.includes('/mcp/mcp'));
  }
  for (const input of ['https://user:SECRET@cowork.example', 'javascript:SECRET', 'http://0.0.0.0:8787', 'http://[::]:8787']) {
    const safe = publicConnectionUrl(input);
    assert.equal(safe.kind, 'invalid');
    assert.equal(safe.webUrl, null);
    assert.ok(!JSON.stringify(safe).includes('SECRET'));
  }
  assert.equal(publicConnectionUrl('http://[::ffff:192.168.10.20]:8787').kind, 'lan');
  assert.equal(publicConnectionUrl('http://[::ffff:127.0.0.1]:8787').kind, 'local');
});

test('로그인한 사용자 연결 진단은 민감 설정을 제외하고 no-store로 응답한다', async () => {
  const app = express();
  const config = { host: '0.0.0.0', port: 8787, publicUrl: 'http://localhost:8787', users: [{ token: 'NEVER-USER-TOKEN' }], ai: { keyFile: 'NEVER-KEY-PATH' }, dataDir: 'NEVER-DATA-PATH' };
  const auth = (req, res, next) => req.headers.authorization === 'Bearer test-login' ? next() : res.status(401).json({ error: 'unauthorized' });
  const wrap = (fn) => (req, res) => fn(req, res).catch(() => res.status(500).end());
  installConnectionRoutes({ app, config, auth, wrap }, { networkInterfaces: () => interfaces });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/connections`)).status, 401);
    const response = await fetch(`${base}/api/connections`, { headers: { Authorization: 'Bearer test-login' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = await response.json();
    assert.equal(json.lan.length, 2);
    assert.ok(!/NEVER-|test-login/.test(JSON.stringify(json)));
    assert.match(json.guidance.join(' '), /MCP 설치가 필요하지 않습니다/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('읽기 전용 CLI는 토큰·키·데이터 경로를 출력하거나 설정을 생성하지 않는다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-connection-info-'));
  const script = fileURLToPath(new URL('../scripts/connection-info.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HWPX_COWORK_/i.test(key)));
  try {
    const file = path.join(tmp, 'config.json');
    const config = { host: '127.0.0.1', port: 0, publicUrl: 'https://cowork.example/mcp/t/NEVER-PATH-TOKEN?token=NEVER-QUERY-TOKEN', users: [{ token: 'NEVER-USER-TOKEN' }], ai: { keyFile: 'NEVER-KEY-PATH' }, dataDir: 'NEVER-DATA-PATH' };
    fs.writeFileSync(file, JSON.stringify(config));
    const before = fs.readFileSync(file);
    const output = execFileSync(process.execPath, [script, '--json'], { env: { ...env, HWPX_COWORK_CONFIG: file }, encoding: 'utf8', windowsHide: true });
    const json = JSON.parse(output);
    assert.equal(json.binding.port, null);
    assert.ok(!/NEVER-/.test(output));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(tmp), ['config.json']);
    const overridden = JSON.parse(execFileSync(process.execPath, [script, '--json'], { env: { ...env, HWPX_COWORK_CONFIG: file, HWPX_COWORK_PUBLIC_URL: 'https://override.example/shared?token=NEVER-ENV-TOKEN' }, encoding: 'utf8', windowsHide: true }));
    assert.equal(overridden.external.webUrl, 'https://override.example/shared');
    assert.ok(!JSON.stringify(overridden).includes('NEVER-'));
    const missing = path.join(tmp, 'missing.json');
    assert.throws(() => execFileSync(process.execPath, [script], { env: { ...env, HWPX_COWORK_CONFIG: missing }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), (error) => error.status === 1 && /읽지 못했습니다/.test(String(error.stderr)));
    assert.equal(fs.existsSync(missing), false);
  } finally {
    // 이 시험이 직접 만든 OS 임시 폴더만 삭제한다.
    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
