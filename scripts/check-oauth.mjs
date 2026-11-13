// 공개 주소의 OAuth 준비 상태만 확인한다. 사용자 토큰이나 키는 읽거나 요청하지 않는다.
const args = process.argv.slice(2);
const text = args[0] === '--url' ? args[1] : args[0];
let base;
try {
  const u = new URL(text || 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error();
  base = u.origin;
} catch { console.error('사용법: npm run oauth:check -- --url https://실제-외부-호스트'); process.exit(1); }
try {
  const get = async (p) => {
    const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.json();
  };
  const config = await get('/api/config');
  if (!config.oauth?.enabled) throw new Error(config.oauth?.reason || '새 OAuth 서버가 실행 중인지 확인하세요.');
  if (config.oauth.mcpUrl !== `${base}/mcp`) throw new Error('접속 주소와 서버의 외부 공유 주소가 다릅니다. 관리자에서 실제 HTTPS 기본 주소를 맞추고 재시작하세요.');
  const resource = await get('/.well-known/oauth-protected-resource/mcp');
  const auth = await get('/.well-known/oauth-authorization-server');
  if (resource.resource !== `${base}/mcp` || !resource.authorization_servers?.includes(auth.issuer) || !auth.code_challenge_methods_supported?.includes('S256') || auth.registration_endpoint !== `${base}/register`) throw new Error('OAuth 메타데이터가 일치하지 않습니다.');
  const r = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (r.status !== 401 || !r.headers.get('www-authenticate')?.includes(config.oauth.metadataUrl)) throw new Error('MCP의 OAuth 인증 발견 응답을 확인하지 못했습니다. 프록시의 헤더 전달을 확인하세요.');
  console.log(`OAuth 주소 점검 통과\nChatGPT 서버 URL: ${config.oauth.mcpUrl}\n인증: OAuth / 클라이언트 등록: DCR / PKCE: S256\n실제 ChatGPT 계정에서 연결·동의 후 문서 목록 조회를 완료해야 최종 연결 확인입니다.`);
} catch (e) { console.error(`OAuth 점검 실패: ${e.message}`); process.exitCode = 1; }
