// ChatGPT용 OAuth 2.1 어댑터. 프로토콜 검증·DCR·PKCE는 MCP SDK를 사용한다.
// 기존 개인 토큰은 동의 화면에서만 받고 OAuth 토큰으로 전달하거나 저장하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const SCOPE = 'hwpx:access';
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const cookieName = (id) => `hwpx_oauth_${id}`;
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', path: '/oauth', maxAge: 10 * 60 * 1000 };
const accessLifetime = 60 * 60;
const grantLifetime = 30 * 24 * 60 * 60;

export function oauthStatus(config) {
  let base;
  try {
    const u = new URL(config.publicUrl);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error();
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && config.oauth?.allowInsecureLocalhost === true)) throw new Error();
    base = u.origin;
  } catch { /* 공개 HTTP에는 OAuth 로그인 폼을 제공하지 않는다. */ }
  const enabled = config.oauth?.enabled !== false && !!base;
  return { enabled, reason: config.oauth?.enabled === false ? 'OAuth가 설정에서 꺼져 있습니다.' : !base ? '관리자에서 고정된 외부 HTTPS 공유 주소를 설정하고 서버를 재시작하세요.' : '',
    ...(enabled ? { issuer: `${base}/`, mcpUrl: `${base}/mcp`, metadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`, scope: SCOPE } : {}) };
}

// Gemini 앱(맞춤 연결 앱)은 Google 고정 콜백을 쓴다(developers.google.com/connected-apps/mcp/oauth).
const GOOGLE_REDIRECT_ORIGINS = ['https://oauth-redirect.googleusercontent.com', 'https://oauth-redirect-sandbox.googleusercontent.com', 'https://oauth-redirect-test.googleusercontent.com'];
export function isGoogleRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  return !u.username && !u.password && !u.hash && !u.search && GOOGLE_REDIRECT_ORIGINS.includes(u.origin) && /^\/[ra]\/[A-Za-z0-9._-]+$/.test(u.pathname);
}
const isGoogleClient = (client) => !!client?.redirect_uris?.length && client.redirect_uris.every(isGoogleRedirect);

// 등록할 때와 인가할 때 모두 확인한다. 추가 클라이언트는 정확한 redirect URI만 관리자가 지정한다.
export function allowedOAuthRedirect(uri, config) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash || u.search) return false;
  if ((config.oauth?.redirectUris || []).includes(uri) && u.protocol === 'https:') return true;
  if (isGoogleRedirect(uri)) return true;
  if (u.origin === 'https://chatgpt.com' && (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname))) return true;
  return config.oauth?.allowLoopbackClients === true && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.pathname === '/callback';
}

function page(body) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 앱 연결 · HWPX 공동 검토</title><link rel="stylesheet" href="/oauth.css"></head><body><main>${body}</main></body></html>`;
}
function securePage(res, callbackOrigin = '') {
  // no-referrer는 브라우저의 폼 POST Origin을 null로 만들 수 있다.
  // same-origin은 외부 콜백으로 Referer를 보내지 않으면서 출처 검사를 유지한다.
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'self'; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`, 'X-Content-Type-Options': 'nosniff' });
}

export function createOAuthService({ config, now = () => Date.now() }) {
  const file = path.join(config.dataDir, 'oauth-state.json');
  let state;
  const pending = new Map();
  const codes = new Map();
  const failures = new Map();
  let router; let routerIssuer;
  const seconds = () => Math.floor(now() / 1000);
  function data() {
    if (!state) {
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('OAuth 저장 파일을 읽지 못했습니다. 파일을 복구한 뒤 재시작하세요.'); state = { version: 1, clients: {}, access: {}, refresh: {} }; }
      if (state.version !== 1 || !state.clients || !state.access || !state.refresh) throw new Error('OAuth 저장 파일 형식이 올바르지 않습니다.');
    }
    return state;
  }
  function prune() {
    for (const table of [data().access, data().refresh]) for (const [key, entry] of Object.entries(table)) if (entry.expiresAt <= seconds()) delete table[key];
    for (const map of [pending, codes, failures]) for (const [key, entry] of map) if (entry.expiresAt <= seconds()) map.delete(key);
  }
  function save() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data()), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function current() {
    const status = oauthStatus(config);
    if (!status.enabled) throw new InvalidTargetError('OAuth requires a configured HTTPS publicUrl');
    return status;
  }
  const userKey = (user) => hash(user.token);
  const findUser = (key) => config.users.find(u => u.token && equal(userKey(u), key));
  function valid(entry, client, resource) {
    const s = current();
    if (!entry || entry.expiresAt <= seconds() || entry.clientId !== client.client_id || entry.issuer !== s.issuer || entry.resource !== s.mcpUrl || !findUser(entry.userKey)) throw new InvalidGrantError('Grant is expired, revoked, or belongs to another client');
    if (resource && resource.href !== s.mcpUrl) throw new InvalidTargetError('Incorrect resource');
    return entry;
  }
  function checkScopes(scopes, fallback = [SCOPE], client = null) {
    // Gemini 는 자기 기본 범위(openid·profile·email 등)를 함께 보낼 수 있다. 이 서버의 범위는 하나뿐이니 그것만 준다.
    if (isGoogleClient(client)) return [SCOPE];
    const selected = scopes?.length ? scopes : fallback;
    if (selected.length !== 1 || selected[0] !== SCOPE) throw new InvalidScopeError('Only hwpx:access is supported');
    return selected;
  }
  function revokeFamily(family) {
    for (const table of [data().access, data().refresh]) for (const [key, entry] of Object.entries(table)) if (entry.family === family) delete table[key];
  }
  function issue(entry, keepRefresh = null) {
    prune();
    if (!keepRefresh && Object.keys(data().refresh).length >= 10000) throw new InvalidGrantError('Too many active connections');
    const access = `hwpx_at_${random()}`; const refresh = keepRefresh || `hwpx_rt_${random()}`;
    const common = { userKey: entry.userKey, clientId: entry.clientId, issuer: entry.issuer, resource: entry.resource, scopes: entry.scopes, family: entry.family || random(), grantExpiresAt: entry.grantExpiresAt || seconds() + grantLifetime };
    data().access[hash(access)] = { ...common, expiresAt: Math.min(seconds() + accessLifetime, common.grantExpiresAt) };
    data().refresh[hash(refresh)] = { ...common, expiresAt: common.grantExpiresAt };
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.min(accessLifetime, common.grantExpiresAt - seconds()), refresh_token: refresh, scope: common.scopes.join(' ') };
  }
  const provider = {
    clientsStore: {
      async getClient(id) { return Object.hasOwn(data().clients, id) ? data().clients[id] : undefined; },
      async registerClient(client) {
        const { redirect_uris: redirects, token_endpoint_auth_method: method } = client;
        if (!['none', 'client_secret_post'].includes(method) || !redirects?.length || redirects.length > 10 || !redirects.every(uri => allowedOAuthRedirect(uri, config))) throw new InvalidClientMetadataError('Use a ChatGPT or Gemini callback URI and none or client_secret_post authentication');
        if ((client.grant_types || ['authorization_code']).some(t => !['authorization_code', 'refresh_token'].includes(t)) || (client.response_types || ['code']).some(t => t !== 'code')) throw new InvalidClientMetadataError('Only authorization_code and refresh_token are supported');
        if (Object.keys(data().clients).length >= 1000) throw new InvalidClientMetadataError('Client registration limit reached');
        const stored = { client_id: client.client_id, client_id_issued_at: client.client_id_issued_at, redirect_uris: redirects, token_endpoint_auth_method: method,
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: String(client.client_name || (redirects.every(isGoogleRedirect) ? 'Gemini' : 'ChatGPT')).slice(0, 120),
          ...(client.client_secret ? { client_secret: client.client_secret, client_secret_expires_at: 0 } : {}) };
        data().clients[stored.client_id] = stored; save(); return stored;
      },
    },
    async authorize(client, params, res) {
      prune(); const s = current();
      if (!allowedOAuthRedirect(params.redirectUri, config)) throw new InvalidClientMetadataError('Callback is no longer allowed');
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('A valid S256 challenge is required');
      if (params.resource && params.resource.href !== s.mcpUrl) throw new InvalidTargetError('Incorrect resource');
      const scopes = checkScopes(params.scopes, [SCOPE], client);
      if (pending.size >= 1000) throw new InvalidGrantError('Too many pending authorizations');
      const id = random(); const csrf = random();
      pending.set(id, { clientId: client.client_id, ...params, resource: s.mcpUrl, issuer: s.issuer, scopes, csrfHash: hash(csrf), expiresAt: seconds() + 600, attempts: 0 });
      res.cookie(cookieName(id), csrf, { ...COOKIE_OPTIONS, secure: s.issuer.startsWith('https:') });
      securePage(res, new URL(params.redirectUri).origin);
      res.type('html').send(page(`<h1>내 AI 앱에 HWPX 연결</h1><p><strong>${escapeHtml(client.client_name)}</strong>에서 연결을 요청했습니다.</p><p>연결하면 본인 권한으로 문서를 읽고 검토 요청·제안·의견을 처리할 수 있습니다. 직접 반영 등 허용된 변경 도구도 사용할 수 있습니다.</p><p>관리자가 발급한 <strong>본인의 HWPX 접속 토큰</strong>으로 인증하세요. ChatGPT·Google 비밀번호와 API 키는 입력하지 마세요.</p><form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label for="token">HWPX 개인 접속 토큰</label><input id="token" name="token" type="password" autocomplete="off" required maxlength="512"><button type="submit" name="decision" value="allow">인증하고 연결 허용</button><button class="secondary" type="submit" name="decision" value="deny" formnovalidate>취소</button></form><p class="muted">토큰은 이 서버에서만 확인하고 AI 앱에는 별도 OAuth 토큰을 발급합니다. 일반 MCP 연결은 새 AI 요청을 자동 실행하지 않습니다.</p>`));
    },
    async challengeForAuthorizationCode(client, code) { return valid(codes.get(hash(code)), client).codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      const entry = valid(codes.get(hash(code)), client, resource);
      if (redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri must exactly match the authorization request');
      codes.delete(hash(code)); return issue(entry);
    },
    async exchangeRefreshToken(client, token, scopes, resource) {
      const entry = valid(data().refresh[hash(token)], client, resource);
      checkScopes(scopes, entry.scopes, client);
      if (entry.used) { revokeFamily(entry.family); save(); throw new InvalidGrantError('Refresh token reuse detected; reconnect your account'); }
      for (const [key, item] of Object.entries(data().access)) if (item.family === entry.family) delete data().access[key];
      if (isGoogleClient(client)) {
        // Google 연결 앱은 같은 refresh 토큰을 돌려받고 만료를 늘리기를 요구한다(회전하면 재사용으로 보여 연결이 끊긴다).
        delete data().refresh[hash(token)];
        return issue({ ...entry, grantExpiresAt: seconds() + grantLifetime }, token);
      }
      // 이미 사용한 refresh 지문도 보관해 재사용 시 해당 연결 전체를 폐기한다.
      entry.used = true;
      return issue(entry);
    },
    async verifyAccessToken(token) {
      const entry = data().access[hash(token)]; const s = current();
      if (!entry || entry.expiresAt <= seconds() || entry.issuer !== s.issuer || entry.resource !== s.mcpUrl || !entry.scopes.includes(SCOPE) || !findUser(entry.userKey)) throw new InvalidTokenError('Token is expired or revoked');
      return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, resource: new URL(entry.resource), extra: { user: findUser(entry.userKey) } };
    },
    async revokeToken(client, request) {
      const entry = data().access[hash(request.token)] || data().refresh[hash(request.token)];
      if (entry?.clientId === client.client_id) { revokeFamily(entry.family); save(); }
    },
  };
  function failure(res, message, status = 400) { securePage(res); return res.status(status).type('html').send(page(`<h1>연결을 완료하지 못했습니다</h1><p>${escapeHtml(message)}</p><p>AI 앱(ChatGPT·Gemini)으로 돌아가 연결을 다시 시작하세요.</p>`)); }
  function approve(req, res) {
    prune(); const s = current();
    const { request_id: id, csrf, decision, token } = req.body || {};
    const entry = typeof id === 'string' ? pending.get(id) : null;
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName(id)}=`))?.slice(cookieName(id).length + 1);
    if (!entry || entry.issuer !== s.issuer || typeof csrf !== 'string' || !cookie || !equal(hash(csrf), entry.csrfHash) || !equal(hash(cookie), entry.csrfHash) || req.headers.origin !== new URL(s.issuer).origin) return failure(res, '인증 요청이 만료되었거나 올바르지 않습니다.');
    const callback = new URL(entry.redirectUri);
    if (entry.state) callback.searchParams.set('state', entry.state);
    callback.searchParams.set('iss', entry.issuer);
    if (decision === 'deny') callback.searchParams.set('error', 'access_denied');
    else {
      const key = hash(req.socket.remoteAddress || 'unknown');
      const f = failures.get(key) || { count: 0, expiresAt: seconds() + 900 };
      if (f.count >= 10 || entry.attempts >= 5) return failure(res, '인증 시도가 너무 많습니다. 15분 뒤 다시 연결하세요.', 429);
      const user = typeof token === 'string' && token.length <= 512 ? config.users.find(u => u.token && equal(token, u.token)) : null;
      if (!user || decision !== 'allow') { entry.attempts++; f.count++; failures.set(key, f); return failure(res, '개인 접속 토큰이 올바르지 않습니다.', 401); }
      const code = random();
      codes.set(hash(code), { ...entry, userKey: userKey(user), expiresAt: seconds() + 120 });
      callback.searchParams.set('code', code);
    }
    pending.delete(id);
    res.clearCookie(cookieName(id), { path: '/oauth', secure: s.issuer.startsWith('https:'), httpOnly: true, sameSite: 'lax' });
    securePage(res, callback.origin); return res.redirect(303, callback.href);
  }
  return {
    status: () => oauthStatus(config), provider,
    async eventPrincipal(token) {
      if (typeof token !== 'string' || !token.startsWith('hwpx_at_') || !oauthStatus(config).enabled) return null;
      try {
        const verifiedToken = await provider.verifyAccessToken(token);
        const entry = data().access[hash(token)];
        return { user: verifiedToken.extra.user, grantId: entry.family, grantExpiresAt: entry.grantExpiresAt * 1000 };
      } catch (e) { if (e instanceof InvalidTokenError) return null; throw e; }
    },
    isEventGrantActive(grantId) {
      if (!oauthStatus(config).enabled) return false;
      const s = current();
      return Object.values(data().refresh).some(entry => !entry.used && entry.family === grantId && entry.expiresAt > seconds() && entry.issuer === s.issuer && entry.resource === s.mcpUrl && !!findUser(entry.userKey));
    },
    async resolveUser(token) {
      if (typeof token !== 'string' || !token.startsWith('hwpx_at_') || !oauthStatus(config).enabled) return null;
      try { return (await provider.verifyAccessToken(token)).extra.user; } catch (e) { if (e instanceof InvalidTokenError) return null; throw e; }
    },
    challenge(res) {
      const s = oauthStatus(config);
      if (s.enabled) res.set('WWW-Authenticate', `Bearer resource_metadata="${s.metadataUrl}", scope="${SCOPE}"`);
    },
    connections(user) {
      prune(); const found = new Map();
      for (const entry of Object.values(data().refresh)) if (!entry.used && entry.userKey === userKey(user)) found.set(entry.family, { id: entry.family, clientName: data().clients[entry.clientId]?.client_name || 'ChatGPT', expiresAt: entry.expiresAt });
      return [...found.values()];
    },
    disconnect(user, id) {
      const entry = Object.values(data().refresh).find(e => e.userKey === userKey(user) && e.family === id);
      if (entry) { revokeFamily(id); save(); }
      return !!entry;
    },
    middleware(req, res, next) {
      const isOAuth = ['/authorize', '/token', '/register', '/revoke', '/oauth/approve', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(req.path);
      if (!isOAuth) return next();
      const s = oauthStatus(config);
      if (!s.enabled) return res.status(503).set('Cache-Control', 'no-store').json({ error: 'oauth_unavailable', error_description: s.reason });
      try {
        if (!router || routerIssuer !== s.issuer) {
          routerIssuer = s.issuer;
          router = express.Router();
          router.post('/oauth/approve', express.urlencoded({ extended: false, limit: '8kb' }), approve);
          router.post('/token', express.urlencoded({ extended: false, limit: '8kb' }), (request, response, nextStep) => {
            if (request.body?.grant_type === 'authorization_code' && (typeof request.body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(request.body.code_verifier))) {
              return response.status(400).set('Cache-Control', 'no-store').json({ error: 'invalid_grant', error_description: 'A valid PKCE code_verifier is required' });
            }
            nextStep();
          });
          router.get('/.well-known/oauth-protected-resource', (_req, out) => out.set('Access-Control-Allow-Origin', '*').json({ resource: s.mcpUrl, authorization_servers: [s.issuer], scopes_supported: [SCOPE], resource_name: 'HWPX 공동 검토' }));
          router.use(mcpAuthRouter({ provider, issuerUrl: new URL(s.issuer), resourceServerUrl: new URL(s.mcpUrl), scopesSupported: [SCOPE], resourceName: 'HWPX 공동 검토', serviceDocumentationUrl: new URL('/help.html#chatgpt-oauth', s.issuer),
            clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { max: 100 } }, tokenOptions: { rateLimit: { max: 300 } } }));
        }
        return router(req, res, next);
      } catch (e) { return next(e); }
    },
  };
}
