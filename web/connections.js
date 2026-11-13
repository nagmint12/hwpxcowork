// 연결 주소 표시 규칙. 서버 publicUrl 이 localhost 여도 원격 사용자가 자기 PC 주소를 복사하지 않도록 한다.
// DOM·Vue 없이 도움말·앱과 Node 시험이 함께 쓴다. 주소에 사용자 토큰을 넣지 않는다.
export function webAddress(value) {
  if (!value) return '';
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
    // 관리자가 공개 프록시 경로를 지정했으면 보존한다. 쿼리·해시·옛 토큰 경로는 복사 주소에서 제외한다.
    const prefix = u.pathname.split('/mcp/t/')[0].replace(/\/+$/, '');
    return u.origin + prefix;
  } catch { return ''; }
}

export function localAddress(value) {
  try {
    const h = new URL(value).hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || ['[::1]', '[::]', '0.0.0.0'].includes(h);
  } catch { return false; }
}

/** browserOrigin: 지금 접속한 주소. publicUrl: 관리자가 정한 공유 주소. diagnostics: /api/connections 결과(선택). */
export function connectionUrls({ browserOrigin, publicUrl, diagnostics, selectedWebUrl } = {}) {
  const current = webAddress(browserOrigin);
  const configured = webAddress(publicUrl);
  const recommended = webAddress(diagnostics?.recommended?.webUrl);
  const selected = webAddress(selectedWebUrl);
  let shared = configured; let source = configured ? 'configured' : 'browser';
  if (selected && (diagnostics?.lan || []).some((x) => webAddress(x.webUrl) === selected)) { shared = selected; source = 'selected'; }
  else if (!shared || localAddress(shared)) {
    if (current && !localAddress(current)) { shared = current; source = 'browser'; }
    else if (recommended && !localAddress(recommended)) { shared = recommended; source = 'diagnostic'; }
    else { shared = current || configured || recommended; source = 'browser'; }
  }
  return {
    currentWebUrl: current, sharedWebUrl: shared, mcpUrl: shared ? `${shared}/mcp` : '',
    localOnly: !!shared && localAddress(shared), source,
    adjusted: !!configured && localAddress(configured) && !!shared && !localAddress(shared),
  };
}
