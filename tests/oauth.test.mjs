import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from './helpers/server.mjs';
import { createOAuthService, oauthStatus, allowedOAuthRedirect } from '../server/oauth.js';

const publicUrl = 'https://cowork.example';
const resource = `${publicUrl}/mcp`;
const callback = 'https://chatgpt.com/connector/oauth/test_connection';
const verifier = () => crypto.randomBytes(48).toString('base64url');
const challenge = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const body = async (r) => ({ status: r.status, data: await r.json() });
const register = async (s, extra = {}) => body(await fetch(`${s.base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'ChatGPT 시험', grant_types: ['authorization_code', 'refresh_token'], ...extra }) }));
const exchange = async (s, c, values) => body(await fetch(`${s.base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.client_id, ...(c.client_secret ? { client_secret: c.client_secret } : {}), ...values }) }));
async function authorize(s, c, extra = {}) {
  const v = verifier();
  const query = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: callback, state: 'state_must_round_trip', resource, scope: 'hwpx:access', code_challenge: challenge(v), code_challenge_method: 'S256', ...extra });
  const res = await fetch(`${s.base}/authorize?${query}`, { redirect: 'manual' });
  const html = await res.text();
  return { res, html, v, cookie: res.headers.get('set-cookie')?.split(';')[0], id: /name="request_id" value="([^"]+)"/.exec(html)?.[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
}
async function approve(s, a, token = s.tokens.a, changes = {}, headers = {}) {
  return fetch(`${s.base}/oauth/approve`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: a.cookie || '', Origin: publicUrl, ...headers }, body: new URLSearchParams({ request_id: a.id, csrf: a.csrf, token, decision: 'allow', ...changes }) });
}
async function grant(s, c, token = s.tokens.a) {
  const a = await authorize(s, c); assert.equal(a.res.status, 200);
  const approved = await approve(s, a, token); assert.equal(approved.status, 303);
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), 'state_must_round_trip');
  assert.equal(redirect.searchParams.get('iss'), `${publicUrl}/`);
  const code = redirect.searchParams.get('code');
  const result = await exchange(s, c, { grant_type: 'authorization_code', code, code_verifier: a.v, redirect_uri: callback, resource });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function withServer(fn, config = {}) {
  const s = await startServer({ config: { publicUrl, ...config } });
  try { await fn(s); } finally { await s.stop(); }
}

test('OAuth 공개 HTTP 차단 및 ChatGPT 콜백 allowlist', () => {
  for (const url of ['http://203.0.113.20:8787', 'https://user:pw@example.com', 'https://example.com/path', 'https://example.com/?token=abc']) assert.equal(oauthStatus({ publicUrl: url }).enabled, false);
  assert.equal(oauthStatus({ publicUrl }).enabled, true);
  assert.equal(oauthStatus({ publicUrl, oauth: { enabled: false } }).enabled, false);
  assert.equal(oauthStatus({ publicUrl: 'http://127.0.0.1:1234', oauth: { allowInsecureLocalhost: true } }).enabled, true);
  for (const uri of [callback, 'https://chatgpt.com/connector_platform_oauth_redirect']) assert.equal(allowedOAuthRedirect(uri, {}), true);
  for (const uri of ['https://chatgpt.com.evil.example/connector/oauth/x', 'https://chatgpt.com/evil', `${callback}?redirect=evil`, `${callback}#x`, 'http://chatgpt.com/connector/oauth/x', 'http://localhost:4321/callback']) assert.equal(allowedOAuthRedirect(uri, {}), false, uri);
  for (const uri of ['https://oauth-redirect.googleusercontent.com/r/my-project-1', 'https://oauth-redirect-sandbox.googleusercontent.com/a/abc']) assert.equal(allowedOAuthRedirect(uri, {}), true, uri);
  for (const uri of ['https://oauth-redirect.googleusercontent.com.evil.example/r/x', 'https://oauth-redirect.googleusercontent.com/evil', 'https://oauth-redirect.googleusercontent.com/r/x?next=evil', 'http://oauth-redirect.googleusercontent.com/r/x', 'https://evil.googleusercontent.com/r/x']) assert.equal(allowedOAuthRedirect(uri, {}), false, uri);
});

test('Gemini 연결 앱: Google 콜백 DCR·기본 범위 허용·refresh 토큰 유지', async () => withServer(async s => {
  const gcb = 'https://oauth-redirect.googleusercontent.com/r/gemini-test';
  const { data: c, status } = await register(s, { redirect_uris: [gcb], client_name: undefined }); assert.equal(status, 201, JSON.stringify(c));
  const v = verifier();
  const query = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: gcb, state: 'g_state', scope: 'openid profile email', code_challenge: challenge(v), code_challenge_method: 'S256' });
  const res = await fetch(`${s.base}/authorize?${query}`, { redirect: 'manual' }); const html = await res.text();
  assert.equal(res.status, 200, html); assert.match(html, /Gemini/);
  assert.match(res.headers.get('content-security-policy'), /form-action 'self' https:\/\/oauth-redirect\.googleusercontent\.com/);
  const a = { cookie: res.headers.get('set-cookie')?.split(';')[0], id: /name="request_id" value="([^"]+)"/.exec(html)?.[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] };
  const approved = await approve(s, a); assert.equal(approved.status, 303);
  const to = new URL(approved.headers.get('location')); assert.equal(to.origin + to.pathname, gcb);
  const t = await exchange(s, c, { grant_type: 'authorization_code', code: to.searchParams.get('code'), code_verifier: v, redirect_uri: gcb });
  assert.equal(t.status, 200, JSON.stringify(t.data)); assert.equal(t.data.scope, 'hwpx:access');
  const r1 = await exchange(s, c, { grant_type: 'refresh_token', refresh_token: t.data.refresh_token, scope: 'openid email' });
  assert.equal(r1.status, 200, JSON.stringify(r1.data)); assert.equal(r1.data.refresh_token, t.data.refresh_token);
  assert.notEqual(r1.data.access_token, t.data.access_token);
  const r2 = await exchange(s, c, { grant_type: 'refresh_token', refresh_token: t.data.refresh_token });
  assert.equal(r2.status, 200, '같은 refresh 토큰을 거듭 써도 연결 유지');
  assert.equal((await fetch(`${s.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${r1.data.access_token}` } })).status === 401, true, '갱신하면 이전 액세스 토큰은 폐기');
  assert.equal(await (await import('../server/oauth.js')).isGoogleRedirect(gcb), true);
}));

test('메타데이터·401 발견·DCR 검증·동의 화면 HTML escaping', async () => withServer(async s => {
  const meta = await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, `${publicUrl}/`);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal(meta.registration_endpoint, `${publicUrl}/register`);
  for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const prm = await (await fetch(`${s.base}${route}`)).json(); assert.equal(prm.resource, resource); assert.deepEqual(prm.authorization_servers, [`${publicUrl}/`]);
  }
  for (const method of ['GET', 'POST']) {
    const r = await fetch(`${s.base}/mcp`, { method, headers: { Host: 'untrusted.example' } });
    assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /https:\/\/cowork.example\/\.well-known\/oauth-protected-resource\/mcp/);
  }
  assert.equal((await register(s, { redirect_uris: ['https://evil.example/callback'] })).status, 400);
  assert.equal((await register(s, { token_endpoint_auth_method: 'client_secret_basic' })).status, 400);
  const { data: c, status } = await register(s, { client_name: '<script>alert(1)</script>' }); assert.equal(status, 201);
  const a = await authorize(s, c); assert.equal(a.res.status, 200);
  assert.doesNotMatch(a.html, /<script>/); assert.match(a.html, /&lt;script&gt;/);
  assert.match(a.res.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(a.res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(a.res.headers.get('referrer-policy'), 'same-origin');
  assert.match(a.res.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt.com/);
  assert.equal((await authorize(s, c, { resource: 'https://other.example/mcp' })).res.status, 302);
  assert.equal((await authorize(s, c, { code_challenge_method: 'plain' })).res.status, 302);
  assert.equal((await authorize(s, c, { redirect_uri: 'https://evil.example' })).res.status, 400);
}));

test('동의 CSRF·Origin·사용자 토큰 검사 및 취소', async () => withServer(async s => {
  const { data: c } = await register(s);
  const a = await authorize(s, c);
  assert.equal((await approve(s, a, s.tokens.a, {}, { Cookie: '' })).status, 400);
  assert.equal((await approve(s, a, s.tokens.a, {}, { Origin: 'https://evil.example' })).status, 400);
  assert.equal((await approve(s, a, s.tokens.a, { csrf: 'wrong' })).status, 400);
  assert.equal((await approve(s, a, 'bad-token')).status, 401);
  const denied = await approve(s, a, '', { decision: 'deny' });
  assert.equal(denied.status, 303); const to = new URL(denied.headers.get('location'));
  assert.equal(to.searchParams.get('error'), 'access_denied'); assert.equal(to.searchParams.get('state'), 'state_must_round_trip');
  assert.equal((await approve(s, a)).status, 400);
}));

test('PKCE·redirect·resource·클라이언트 바인딩·코드 일회성 및 OAuth MCP 호출', async () => withServer(async s => {
  const { data: c } = await register(s); const { data: other } = await register(s);
  const a = await authorize(s, c); const approved = await approve(s, a);
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const params = { grant_type: 'authorization_code', code, code_verifier: a.v, redirect_uri: callback, resource };
  assert.equal((await exchange(s, c, { ...params, code_verifier: 'short' })).status, 400);
  assert.equal((await exchange(s, c, { ...params, code_verifier: verifier() })).status, 400);
  assert.equal((await exchange(s, c, { ...params, redirect_uri: 'https://evil.example' })).status, 400);
  assert.equal((await exchange(s, c, { ...params, resource: 'https://other.example/mcp' })).status, 400);
  assert.equal((await exchange(s, other, params)).status, 400);
  const result = await exchange(s, c, params); assert.equal(result.status, 200);
  assert.equal((await exchange(s, c, params)).status, 400);
  const tokens = result.data;
  assert.notEqual(tokens.access_token, s.tokens.a);
  const client = new Client({ name: 'chatgpt', version: 'oauth-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  try {
    await client.connect(transport);
    assert.ok(client.getInstructions().includes(s.users.a.name));
    assert.ok((await client.listTools()).tools.some(t => t.name === 'claim_next_request'));
    assert.equal((await client.callTool({ name: 'list_documents', arguments: {} })).isError, undefined);
  } finally { await transport.terminateSession(); await client.close(); }
  assert.equal((await fetch(`${s.base}/api/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401, 'OAuth 토큰으로 관리자/REST API에 접근하지 못함');
  assert.equal((await fetch(`${s.base}/mcp?token=${tokens.access_token}`, { method: 'POST' })).status, 401, 'OAuth 토큰은 Authorization 헤더에서만 허용');
  const stored = fs.readFileSync(path.join(s.dataDir, 'oauth-state.json'), 'utf8');
  for (const secret of [s.tokens.a, tokens.access_token, tokens.refresh_token, code]) assert.ok(!stored.includes(secret), '토큰 원문/인가 코드를 저장하지 않음');
}));

test('client_secret_post·재시작 유지·갱신 회전 및 refresh 재사용 시 전체 폐기', async () => withServer(async s => {
  const { data: c, status } = await register(s, { token_endpoint_auth_method: 'client_secret_post' }); assert.equal(status, 201);
  assert.equal(c.client_secret_expires_at, 0);
  const tokens = await grant(s, c);
  await s.restart();
  const service = createOAuthService({ config: { dataDir: s.dataDir, publicUrl, users: s.userList } });
  assert.equal((await service.resolveUser(tokens.access_token)).name, s.users.a.name);
  const fresh = await exchange(s, c, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource }); assert.equal(fresh.status, 200);
  assert.notEqual(fresh.data.refresh_token, tokens.refresh_token);
  assert.equal((await exchange(s, c, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource })).status, 400);
  assert.equal((await exchange(s, c, { grant_type: 'refresh_token', refresh_token: fresh.data.refresh_token, resource })).status, 400, '재사용 감지 뒤 새 토큰도 폐기');
}));

test('사용자별 연결 분리·본인 해제·원본 사용자 토큰 변경·만료', async () => withServer(async s => {
  const { data: c } = await register(s);
  const a = await grant(s, c); const b = await grant(s, c, s.tokens.b);
  const A = s.api('a'); const B = s.api('b');
  const listA = await A('/api/oauth/connections'); const listB = await B('/api/oauth/connections');
  assert.equal(listA.length, 1); assert.equal(listB.length, 1); assert.notEqual(listA[0].id, listB[0].id);
  assert.equal((await B(`/api/oauth/connections/${listA[0].id}`, { method: 'DELETE' })).revoked, false);
  assert.equal((await A(`/api/oauth/connections/${listA[0].id}`, { method: 'DELETE' })).revoked, true);
  assert.equal((await exchange(s, c, { grant_type: 'refresh_token', refresh_token: a.refresh_token, resource })).status, 400);
  const cfg = { dataDir: s.dataDir, publicUrl, users: s.userList.map(u => ({ ...u })) };
  const service = createOAuthService({ config: cfg });
  assert.equal((await service.resolveUser(b.access_token)).name, s.users.b.name);
  cfg.users.find(u => u.name === s.users.b.name).token = 'rotated-original-token';
  assert.equal(await service.resolveUser(b.access_token), null);
  const expired = createOAuthService({ config: { ...cfg, users: s.userList }, now: () => Date.now() + 3601000 });
  assert.equal(await expired.resolveUser(b.access_token), null);
  assert.equal((await createOAuthService({ config: { ...cfg, publicUrl: 'https://different.example', users: s.userList } }).resolveUser(b.access_token)), null);
}));

test('공개 HTTP 설정은 OAuth를 열지 않고 기존 토큰 MCP는 유지', async () => withServer(async s => {
  assert.equal((await fetch(`${s.base}/register`, { method: 'POST' })).status, 503);
  assert.equal((await fetch(`${s.base}/.well-known/oauth-authorization-server`)).status, 503);
  assert.equal(s.config.oauth.enabled, false);
  assert.equal((await s.api('a')('/api/me')).name, s.users.a.name);
}, { publicUrl: 'http://203.0.113.20:8787' }));

test('이벤트 구독의 OAuth 연결은 액세스 토큰 갱신 후 유지되고 연결 해제 후 차단', async () => withServer(async s => {
  const { data: c } = await register(s); const tokens = await grant(s, c);
  const service = createOAuthService({ config: { dataDir: s.dataDir, publicUrl, users: s.userList } });
  const principal = await service.eventPrincipal(tokens.access_token);
  assert.equal(principal.user.name, s.users.a.name); assert.ok(principal.grantId);
  assert.equal(service.isEventGrantActive(principal.grantId), true);
  const client = await service.provider.clientsStore.getClient(c.client_id);
  const refreshed = await service.provider.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(resource));
  assert.equal(service.isEventGrantActive(principal.grantId), true);
  assert.equal((await service.eventPrincipal(refreshed.access_token)).grantId, principal.grantId);
  await service.provider.revokeToken(client, { token: refreshed.refresh_token });
  assert.equal(service.isEventGrantActive(principal.grantId), false);
}));
