// GitHub Pages 입구(2026-11-18): Pages 가 이 서버 화면을 iframe 으로 보여 줄 때(web/pages-host.js — X-Hwpx-Host: github-pages)
// 개인 API 키·두레이 토큰 저장은 서버가 거절한다. 같은 요청을 서버 주소로 직접 연 화면(머리글 없음)은 그대로 처리한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

const PAGES = { 'X-Hwpx-Host': 'github-pages' };

test('서버: GitHub 페이지 화면의 API 키·두레이 토큰 저장은 거절, 다른 요청과 직접 연 화면은 그대로', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const key = { gateway: 'direct', provider: 'openai', model: 'gpt-test', key: 'sk-test-0000000000000000000000' };
    for (const [path, body] of [['/api/me/ai', key], ['/api/drive/connection', { site: 'https://example.dooray.com', token: 'abcd:efgh' }]]) {
      const r = await A.res(path, { method: 'PUT', body, headers: PAGES });
      assert.equal(r.status, 403, path); assert.equal(r.data.error, 'PAGES_NO_SECRETS', path);
      const h = await A.res(path, { method: 'PUT', body, headers: { 'X-Hwpx-Host': 'GitHub-Pages' } });
      assert.equal(h.data.error, 'PAGES_NO_SECRETS', '머리글 값의 대소문자는 가리지 않는다');
      const direct = await A.res(path, { method: 'PUT', body });
      assert.notEqual(direct.data?.error, 'PAGES_NO_SECRETS', `${path}: 직접 연 화면은 막지 않는다`);
    }
    // 읽기·지우기와 다른 머리글 값은 막지 않는다
    assert.equal((await A.res('/api/me/ai', { headers: PAGES })).status, 200);
    assert.equal((await A.res('/api/me', { headers: PAGES })).status, 200);
    assert.notEqual((await A.res('/api/me/ai', { method: 'DELETE', headers: PAGES })).data?.error, 'PAGES_NO_SECRETS');
    assert.notEqual((await A.res('/api/me/ai', { method: 'PUT', body: key, headers: { 'X-Hwpx-Host': 'other' } })).data?.error, 'PAGES_NO_SECRETS');
  } finally { await srv.stop(); }
});
