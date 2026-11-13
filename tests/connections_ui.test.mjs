import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionUrls, localAddress, webAddress } from '../web/connections.js';

test('원격 브라우저에 localhost publicUrl 을 복사하지 않는다', () => {
  const u = connectionUrls({ browserOrigin: 'http://192.168.10.8:8787', publicUrl: 'http://localhost:8787' });
  assert.equal(u.currentWebUrl, 'http://192.168.10.8:8787');
  assert.equal(u.sharedWebUrl, u.currentWebUrl);
  assert.equal(u.mcpUrl, 'http://192.168.10.8:8787/mcp');
  assert.equal(u.adjusted, true);
  assert.equal(u.localOnly, false);
});

test('지정한 외부 공유 주소는 보존하고 현재 접속 주소와 구분한다', () => {
  const u = connectionUrls({ browserOrigin: 'http://localhost:8787', publicUrl: 'https://cowork.example.org/' });
  assert.equal(u.currentWebUrl, 'http://localhost:8787');
  assert.equal(u.sharedWebUrl, 'https://cowork.example.org');
  assert.equal(u.source, 'configured');
  assert.equal(connectionUrls({ browserOrigin: 'http://localhost:8787', publicUrl: 'https://cowork.example.org/hwpx/' }).mcpUrl, 'https://cowork.example.org/hwpx/mcp');
});

test('로컬 화면에서 점검한 LAN 후보는 공유 주소 후보로 쓴다', () => {
  const u = connectionUrls({ browserOrigin: 'http://localhost:8787', publicUrl: 'http://127.0.0.1:8787', diagnostics: { recommended: { webUrl: 'http://10.1.2.3:8787' } } });
  assert.equal(u.sharedWebUrl, 'http://10.1.2.3:8787');
  assert.equal(u.source, 'diagnostic');
  assert.equal(u.localOnly, false);
});

test('원격 브라우저에서 잘 쓰는 주소를 임의의 NIC 후보로 바꾸지 않는다', () => {
  const u = connectionUrls({ browserOrigin: 'https://cowork.example.org', publicUrl: 'http://localhost:8787', diagnostics: { recommended: { webUrl: 'http://172.18.0.2:8787' } } });
  assert.equal(u.sharedWebUrl, 'https://cowork.example.org');
});

test('다중 NIC 에서는 후보를 자동 선택하지 않고 사용자가 고른 주소만 쓴다', () => {
  const options = { browserOrigin: 'http://localhost:8787', publicUrl: 'http://localhost:8787', diagnostics: { recommended: { webUrl: 'http://localhost:8787', selectionRequired: true }, lan: [{ webUrl: 'http://10.0.0.2:8787' }, { webUrl: 'http://192.168.0.2:8787' }] } };
  assert.equal(connectionUrls(options).localOnly, true);
  assert.equal(connectionUrls({ ...options, selectedWebUrl: 'http://192.168.0.2:8787' }).mcpUrl, 'http://192.168.0.2:8787/mcp');
  assert.equal(connectionUrls({ ...options, selectedWebUrl: 'https://other.example.org' }).localOnly, true);
});

test('로컬 전용 주소와 IPv6·wildcard 를 구분하고 URL 에 토큰을 남기지 않는다', () => {
  for (const s of ['http://localhost:8787', 'http://127.0.0.2:8787', 'http://[::1]:8787', 'http://0.0.0.0:8787', 'http://[::]:8787']) assert.equal(localAddress(s), true, s);
  assert.equal(localAddress('https://localhost.example.org'), false);
  assert.equal(connectionUrls({ browserOrigin: 'http://localhost:8787' }).localOnly, true);
  assert.equal(webAddress('https://cowork.example.org/#/t/secret'), 'https://cowork.example.org');
  assert.equal(webAddress('https://cowork.example.org/?token=secret'), 'https://cowork.example.org');
  assert.equal(webAddress('https://cowork.example.org/hwpx/mcp/t/secret'), 'https://cowork.example.org/hwpx');
  assert.equal(webAddress('https://person:secret@cowork.example.org'), '');
  assert.equal(webAddress('javascript:alert(1)'), '');
});
