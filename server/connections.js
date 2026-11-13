// 연결 안내만 계산하는 순수 함수. 설정의 토큰·사용자·파일 경로는 결과에 복사하지 않는다.
import { isIP } from 'node:net';

const unbracket = (host) => {
  let value = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 6) { try { value = new URL(`http://[${value}]`).hostname.slice(1, -1); } catch { /* 구역 ID가 든 링크 로컬은 후보에서 제외한다 */ } }
  return value;
};
const mappedV4 = (host) => {
  const match = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(host);
  if (!match) return host;
  const a = parseInt(match[1], 16); const b = parseInt(match[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
};
const loopback = (host) => host === 'localhost' || host.endsWith('.localhost') || (isIP(mappedV4(host)) === 4 && /^127\./.test(mappedV4(host))) || host === '::1';
const privateV4 = (host) => /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
const privateHost = (host) => (isIP(mappedV4(host)) === 4 && privateV4(mappedV4(host))) || /^(fc|fd|fe[89ab])[\da-f]*:/i.test(host) || (!host.includes('.') && !host.includes(':')) || /\.(local|internal|lan)$/.test(host);
const addressUrl = (host, port) => port ? `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}` : null;
const endpoints = (base) => ({ webUrl: base, mcpUrl: base ? `${base}/mcp` : null });

/** 주소의 인증정보·쿼리·fragment와 기존 토큰 경로는 공유 안내에 싣지 않는다. */
export function publicConnectionUrl(value) {
  if (!value || typeof value !== 'string') return { kind: 'none', ...endpoints(null), message: '공유 주소가 별도로 설정되지 않았습니다.' };
  let url; let path;
  try {
    url = new URL(value);
    path = decodeURIComponent(url.pathname);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('bad URL');
  } catch { return { kind: 'invalid', ...endpoints(null), message: '공유 주소 설정을 확인하세요. 인증정보가 없는 HTTP 또는 HTTPS 서버 주소가 필요합니다.' }; }
  const host = unbracket(url.hostname);
  if (host === '0.0.0.0' || host === '::') return { kind: 'invalid', ...endpoints(null), message: '0.0.0.0과 ::는 바인딩 주소입니다. 접속할 서버 IP 또는 도메인을 사용하세요.' };
  // /mcp/t/<token>을 서버 기본 주소로 잘못 적어도 토큰을 재출력하지 않는다.
  const tokenPath = /\/(?:mcp\/)?t(?:\/|$)/i.exec(path);
  if (tokenPath) path = path.slice(0, tokenPath.index);
  else path = url.pathname.replace(/\/mcp\/?$/i, '');
  url.pathname = path.replace(/\/+$/, '') || '/';
  url.search = ''; url.hash = '';
  const base = url.href.replace(/\/$/, '');
  const kind = loopback(host) ? 'local' : privateHost(host) ? 'lan' : 'internet';
  const message = kind === 'local' ? 'localhost 주소는 서버 PC에서만 사용합니다. 다른 PC에는 LAN 주소를 전달하세요.'
    : kind === 'lan' ? '설정한 내부망 주소입니다. 같은 네트워크 또는 VPN에서 연결 여부를 확인하세요.'
      : '설정한 인터넷 접속 주소입니다. DNS·HTTPS·라우팅의 실제 연결 여부는 확인하지 않았습니다.';
  return { kind, ...endpoints(base), message };
}

function interfaceAddresses(interfaces) {
  const seen = new Set(); const out = [];
  for (const [name, entries] of Object.entries(interfaces || {})) for (const info of entries || []) {
    const address = unbracket(info?.address);
    const family = isIP(address);
    if (!family || info.internal || loopback(address) || address === '0.0.0.0' || address === '::' || address.includes('%')) continue;
    // 링크 로컬 IPv6에는 접속 PC마다 다른 인터페이스 구역 ID가 필요하므로 공유 후보에서 제외한다.
    if ((family === 6 && /^fe[89ab]/i.test(address)) || (family === 4 && /^169\.254\./.test(address))) continue;
    if (seen.has(address)) continue;
    const label = String(name).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '').slice(0, 80);
    seen.add(address); out.push({ address, family: `IPv${family}`, label });
  }
  return out.sort((a, b) => {
    const score = (x) => (x.family === 'IPv4' ? 0 : 10) + (privateHost(x.address) ? 0 : 2) + (/^169\.254\./.test(x.address) ? 20 : 0);
    return score(a) - score(b) || a.address.localeCompare(b.address);
  });
}

/** cfg의 host/port/publicUrl/publicUrlAuto와 주입한 NIC 목록으로 연결 후보를 만든다. 연결 성공을 보증하지 않는다. */
export function buildConnectionInfo(cfg = {}, { interfaces = {} } = {}) {
  const host = unbracket(cfg.host || '127.0.0.1');
  const parsedPort = Number(cfg.port ?? 8787);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
  const isLocal = loopback(host);
  const scope = isLocal ? 'loopback' : host === '0.0.0.0' ? 'all-ipv4' : host === '::' ? 'all-ipv6' : isIP(host) ? 'specific' : 'hostname';
  const message = isLocal ? '이 PC의 루프백 주소에서만 받습니다. LAN의 다른 PC에서는 직접 접속할 수 없습니다.'
    : scope === 'all-ipv4' ? '서버 PC의 모든 IPv4 인터페이스에서 받습니다. 같은 네트워크에서 LAN 주소로 접속을 확인하세요.'
      : scope === 'all-ipv6' ? '모든 IPv6 인터페이스에서 받습니다. IPv4 접속은 운영체제의 이중 스택 설정에 따라 달라집니다.'
        : scope === 'specific' ? '지정한 IP에서만 받습니다. 아래 후보는 그 IP와 일치하는 인터페이스입니다.'
          : '호스트 이름의 실제 바인딩 IP를 이 진단만으로 확인할 수 없습니다.';
  const binding = { host, port, scope, loopbackOnly: isLocal, lanPossible: !isLocal, message };
  const localHost = scope === 'all-ipv4' || host === 'localhost' ? 'localhost' : scope === 'all-ipv6' ? '::1' : host;
  const local = endpoints(addressUrl(localHost, port));
  const candidates = interfaceAddresses(interfaces).filter((item) => !isLocal && (scope === 'all-ipv4' ? item.family === 'IPv4' : scope === 'all-ipv6' ? true : item.address === host || item.address === mappedV4(host)));
  const lan = port ? candidates.map((item) => ({
    ...item, ...endpoints(addressUrl(item.address, port)), verified: false,
    note: scope === 'all-ipv6' && item.family === 'IPv4' ? 'IPv4 이중 스택 수신 여부를 확인하세요. 방화벽·라우팅은 미검증입니다.' : '이 서버의 네트워크 주소 후보입니다. 방화벽·라우팅·다른 PC의 접속은 미검증입니다.',
  })) : [];
  const configured = publicConnectionUrl(cfg.publicUrlAuto ? null : cfg.publicUrl);
  const external = {
    configured: configured.kind === 'internet',
    ...endpoints(configured.kind === 'internet' ? configured.webUrl : null), verified: false,
    message: configured.kind === 'internet' ? configured.message : '인터넷 접속 주소 미설정. LAN 주소만으로 인터넷의 다른 네트워크에서 접속할 수 있다고 판단할 수 없습니다.',
  };
  const selected = configured.kind === 'internet' || (configured.kind === 'lan' && !isLocal) ? { ...endpoints(configured.webUrl), scope: configured.kind, source: 'publicUrl', selectionRequired: false }
    : lan.length === 1 ? { ...endpoints(lan[0].webUrl), scope: 'lan', source: 'network-interface', selectionRequired: false }
      : { ...local, scope: 'local', source: lan.length > 1 ? 'multiple-network-interfaces' : 'binding', selectionRequired: lan.length > 1,
        ...(lan.length > 1 ? { message: 'LAN 공유 주소는 선택이 필요합니다. 표시된 로컬 주소는 서버 PC용이며, 후보 중 이용자의 LAN 또는 VPN에 해당하는 주소를 고르세요.' } : {}) };
  const warnings = [];
  if (!port) warnings.push({ code: 'PORT_UNRESOLVED', message: '실제 포트를 아직 알 수 없습니다. 포트 0으로 시작한 서버는 시작 후 웹의 연결 안내에서 확인하세요.' });
  if (isLocal) warnings.push({ code: 'LOOPBACK_ONLY', message });
  if (configured.kind === 'local') warnings.push({ code: 'PUBLIC_URL_IS_LOCAL', message: configured.message });
  if (configured.kind === 'invalid') warnings.push({ code: 'PUBLIC_URL_INVALID', message: configured.message });
  if (configured.kind === 'lan' && isLocal) warnings.push({ code: 'INTERNAL_URL_WITH_LOOPBACK', message: '설정한 내부망 주소는 이 루프백 바인딩에 직접 연결되지 않습니다. 프록시를 사용하는 경우 해당 연결을 별도로 확인하세요.' });
  if (!isLocal && !lan.length) warnings.push({ code: 'NO_LAN_CANDIDATE', message: '바인딩과 일치하는 LAN 주소 후보를 찾지 못했습니다. 서버 PC의 네트워크와 바인딩 설정을 확인하세요.' });
  if (lan.length > 1) warnings.push({ code: 'MULTIPLE_ADDRESSES', message: '네트워크 주소 후보가 여러 개입니다. 이용자가 접속하는 LAN 또는 VPN의 주소를 선택하세요.' });
  return {
    binding, local, lan, configured, external, recommended: selected, warnings,
    guidance: [
      '서버 프로그램은 한 PC에서 실행하고, 다른 사람은 공유한 웹 주소를 브라우저에서 엽니다. 공동 편집에는 각자의 MCP 설치가 필요하지 않습니다.',
      'localhost는 주소를 연 사람 자신의 PC를 뜻합니다. 다른 PC에는 서버의 LAN IP 또는 설정한 외부 주소를 전달하세요.',
      '공유 링크에는 토큰을 넣지 않습니다. 각자 받은 사용자 토큰은 로그인 창 또는 MCP의 Authorization: Bearer 헤더에 입력합니다.',
      'MCP는 각자의 AI 앱으로 문서를 다룰 때만 연결합니다. 서버에서 AI 작업을 처리하는 운영 방식은 서버 관리자가 별도로 구성합니다.',
      'LAN 후보는 실제 네트워크 인터페이스에서 얻은 주소입니다. 169.254 자동 할당 주소와 링크 로컬 IPv6는 공유 후보에서 제외합니다. 방화벽·VPN·라우터·외부 HTTPS 공개 설정을 자동으로 변경하거나 연결 성공으로 판정하지 않습니다.',
    ],
  };
}
