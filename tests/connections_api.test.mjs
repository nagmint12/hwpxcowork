// 서버를 실제로 띄워 인증·실제 포트·환경 변수와 연결 안내 라우터의 통합을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

test('연결 안내 API는 로그인 후 실제 포트를 반환하고 민감 설정을 노출하지 않는다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off', config: { ai: { enabled: false, mock: false, keyFile: 'NEVER-EXPOSE-KEY-PATH' } } });
  try {
    const anonymous = await srv.api(null).res('/api/connections');
    assert.equal(anonymous.status, 401);
    const response = await srv.api('a').res('/api/connections');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const info = response.data;
    assert.equal(info.binding.port, srv.port);
    assert.equal(info.binding.loopbackOnly, true);
    assert.equal(info.local.webUrl, srv.base);
    assert.equal(info.local.mcpUrl, `${srv.base}/mcp`);
    assert.deepEqual(info.lan, []);
    assert.equal(info.external.configured, false);
    assert.equal(info.external.webUrl, null);
    const text = JSON.stringify(info);
    for (const privateValue of [...Object.values(srv.tokens), srv.configPath, srv.dataDir, 'NEVER-EXPOSE-KEY-PATH']) assert.ok(!text.includes(privateValue));
    assert.ok(!Object.hasOwn(info, 'users'));
    assert.ok(!Object.hasOwn(info, 'ai'));
    assert.deepEqual((await srv.api('admin')('/api/connections')).binding, info.binding);
    assert.equal((await srv.api('invalid-connection-token').res('/api/connections')).status, 401);
  } finally {
    await srv.stop();
  }
});

test('공유 주소 환경 변수와 실제 IPv4 NIC를 사용하되 토큰이 든 URL은 안내에서 제거한다', { timeout: 30000 }, async () => {
  const secret = 'NEVER-EXPOSE-CONNECTION-URL-TOKEN';
  const srv = await startServer({ ai: 'off', env: { HWPX_COWORK_HOST: '0.0.0.0', HWPX_COWORK_PUBLIC_URL: `https://shared.example/hwpx/?token=${secret}#${secret}` } });
  try {
    const info = await srv.api('b')('/api/connections');
    assert.equal(info.binding.host, '0.0.0.0');
    assert.equal(info.binding.scope, 'all-ipv4');
    assert.equal(info.binding.port, srv.port);
    assert.equal(info.external.configured, true);
    assert.equal(info.external.webUrl, 'https://shared.example/hwpx');
    assert.equal(info.external.mcpUrl, 'https://shared.example/hwpx/mcp');
    assert.equal(info.external.verified, false);
    assert.equal(info.recommended.source, 'publicUrl');
    assert.equal(info.recommended.selectionRequired, false);
    assert.ok(info.lan.every((candidate) => candidate.family === 'IPv4' && candidate.verified === false && typeof candidate.label === 'string' && !candidate.address.startsWith('169.254.')));
    assert.ok(!JSON.stringify(info).includes(secret));
  } finally {
    await srv.stop();
  }
});
