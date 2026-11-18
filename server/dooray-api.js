// 두레이 서비스 API(공개 API) 클라이언트 — 2026-11-17 브라우저 확장프로그램 방식 대신 쓴다.
// 근거: 두레이 '서비스 API' 가이드(2026.11.09 판, 프로젝트 루트 'dooray api 가이드.txt')
//   - 인증: 개인 API 인증 토큰(두레이 개인설정 > API > 개인 인증 토큰에서 사용자가 직접 만든다) — 머리글 'Authorization: dooray-api {TOKEN}'
//     토큰은 만든 계정과 같은 권한이고 IP ACL·User ACL 도 그대로 적용된다(서버에서 부르면 서버 IP 가 기준).
//   - 끝점: 민간 api.dooray.com / 공공 api.gov-dooray.com / 공공 업무망 api.gov-dooray.co.kr / 금융 api.dooray.co.kr
//   - 응답: { header:{isSuccessful,resultCode,resultMessage}, result, totalCount }. resultMessage 는 사람에게 보여 줄 글이지 판정에 쓰지 않는다.
//   - 파일 올리기·내려받기(?media=raw)는 api 주소로 부르면 307 과 Location(file-api 주소)을 준다 → 같은 요청을 Location 으로 다시 보낸다.
//     fetch 는 다른 출처로 넘어갈 때 Authorization 을 지우므로 직접 따라가고, 두레이 도메인 안의 https 주소에만 토큰을 다시 붙인다.
//   - 429(요청 제한)는 잠시 뒤 한 번 다시 보낸다(처리되지 않은 요청이라 쓰기도 다시 보내도 된다).
import { ServiceError } from './service.js';

export const DOORAY_CLOUDS = [
  { id: 'dooray', label: '민간 클라우드', domain: 'dooray.com', api: 'https://api.dooray.com' },
  { id: 'gov', label: '공공 클라우드', domain: 'gov-dooray.com', api: 'https://api.gov-dooray.com' },
  { id: 'gov-intranet', label: '공공 업무망 클라우드', domain: 'gov-dooray.co.kr', api: 'https://api.gov-dooray.co.kr' },
  { id: 'finance', label: '금융 클라우드', domain: 'dooray.co.kr', api: 'https://api.dooray.co.kr' },
];
const underDomain = (host, domain) => host === domain || host.endsWith('.' + domain);
const fail = (code, message, status = 400) => { throw new ServiceError(code, message, status); };

/**
 * 사용자가 넣은 두레이 사이트 주소(예: https://회사.dooray.com, 회사.dooray.com)에서 클라우드와 API 끝점을 정한다.
 * override(시험용 HWPX_COWORK_DOORAY_API — loopback http 주소)가 있으면 그 주소를 API 끝점으로 쓴다.
 */
export function doorayEndpoint(site, override = null) {
  let raw = String(site || '').trim();
  if (!raw) fail('DOORAY_SITE', '두레이 사이트 주소를 넣으세요(예: https://회사.dooray.com).');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u; try { u = new URL(raw); } catch { fail('DOORAY_SITE', '두레이 사이트 주소를 확인하세요(예: https://회사.dooray.com).'); }
  if (override) {
    const api = loopbackApi(override);
    return { site: u.origin, cloud: 'test', cloudLabel: '시험', apiBase: api.origin, domain: api.hostname };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) fail('DOORAY_SITE', '두레이 사이트 주소는 https 기본 주소만 받습니다(예: https://회사.dooray.com).');
  const cloud = DOORAY_CLOUDS.find((c) => underDomain(host, c.domain));
  if (!cloud) fail('DOORAY_SITE', '두레이 주소가 아닙니다. 두레이에 접속할 때 쓰는 주소(예: https://회사.dooray.com)를 넣으세요.');
  if (host === cloud.domain || /^(api|file-api)\./.test(host)) fail('DOORAY_SITE', 'API 주소가 아니라 두레이에 접속할 때 쓰는 사이트 주소(예: https://회사.dooray.com)를 넣으세요.');
  return { site: `https://${host}`, cloud: cloud.id, cloudLabel: cloud.label, apiBase: cloud.api, domain: cloud.domain };
}
function loopbackApi(override) {
  let u; try { u = new URL(override); } catch { fail('DOORAY_SITE', '시험용 두레이 API 주소가 올바르지 않습니다.', 500); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) fail('DOORAY_SITE', '시험용 두레이 API 주소는 loopback 만 받습니다.', 500);
  return u;
}

/** 붙여 넣은 토큰 다듬기 — 'dooray-api ' 머리를 함께 붙여 넣었으면 뗀다. 원문은 돌려주거나 기록하지 않는다 */
export function normalizeDoorayToken(value) {
  let t = String(value ?? '').trim().replace(/^(authorization:\s*)?dooray-api\s+/i, '').trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(t)) fail('DOORAY_TOKEN', '두레이 개인 인증 토큰을 그대로 붙여 넣으세요(공백·한글 없이).');
  return t;
}

// 16자리가 넘는 숫자 ID 는 원문 문자열로 보존한다(JSON 숫자로 읽으면 끝자리가 바뀐다)
const parseJson = (s) => JSON.parse(s.replace(/"(?:\\.|[^"\\])*"|(-?\d{16,})(?=\s*[,}\]])/g, (m, n) => (n ? JSON.stringify(n) : m)));
const segment = (id) => { const s = String(id ?? ''); if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) fail('DRIVE_FILE_ID', '파일 또는 폴더 ID 가 올바르지 않습니다.'); return encodeURIComponent(s); };
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{apiBase:string, domain:string, token:string, fetchImpl?:Function, timeoutMs?:number, retryMs?:number}} o
 *   domain: 리다이렉트를 따라갈 때 토큰을 다시 붙여도 되는 도메인(dooray.com 등 — 시험 때는 loopback 호스트)
 */
export function createDoorayClient({ apiBase, domain, token, fetchImpl = globalThis.fetch, timeoutMs = 60000, retryMs = 1200 }) {
  const base = new URL(apiBase);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  const trusted = (u) => loopback ? u.hostname === base.hostname : (u.protocol === 'https:' && !u.username && !u.password && underDomain(u.hostname.toLowerCase(), domain));

  async function errorOf(res) {
    let message = '';
    try { const j = parseJson((await res.text()).slice(0, 65536)); message = String(j?.header?.resultMessage || '').replace(/\s*\(xrid:[^)]*\)\s*$/, '').slice(0, 300); } catch { /* 본문이 JSON 이 아님 */ }
    const tail = message ? ` (두레이: ${message})` : '';
    switch (res.status) {
      case 401: return new ServiceError('DOORAY_AUTH', '두레이 API 토큰이 맞지 않거나 폐기되었습니다. 두레이에서 새 토큰을 만들어 다시 등록하세요.', 409);
      case 403: return new ServiceError('DOORAY_FORBIDDEN', `두레이에서 이 작업 권한이 없습니다. 접속 위치 제한(IP ACL)이 있으면 관리자에게 cowork 서버 주소 허용을 요청하세요.${tail}`, 403);
      case 404: return new ServiceError('DOORAY_NOT_FOUND', `두레이에서 대상을 찾지 못했습니다. 목록을 새로 읽어 주세요.${tail}`, 404);
      case 409: return new ServiceError('DOORAY_CONFLICT', `두레이에서 같은 대상이 이미 있거나 충돌했습니다.${tail}`, 409);
      case 413: return new ServiceError('DRIVE_SIZE', '두레이가 받을 수 있는 파일 크기를 넘었습니다.', 413);
      case 429: return new ServiceError('DOORAY_RATE', '두레이 요청이 많습니다. 잠시 뒤 다시 시도하세요.', 429);
      default: return new ServiceError('DOORAY_ERROR', `두레이 응답 오류 ${res.status}${tail}`, 502);
    }
  }

  async function readCapped(res, maxBytes) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body?.cancel?.(); fail('DRIVE_SIZE', '파일 크기 한도를 초과했습니다.', 413); }
    const parts = []; let size = 0;
    for await (const chunk of res.body || []) {
      size += chunk.length;
      if (size > maxBytes) fail('DRIVE_SIZE', '파일 크기 한도를 초과했습니다.', 413);
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts, size);
  }

  /**
   * @param {string} method
   * @param {string} route  '/drive/v1/...'
   * @param {{query?:object, json?:any, form?:FormData, raw?:boolean, maxBytes?:number}} o
   * @returns {Promise<{result:any,totalCount:number|null}|Buffer>}
   */
  async function request(method, route, { query = null, json, form, raw = false, maxBytes = 50 * 1024 * 1024 } = {}) {
    let url = new URL(route, base);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
    let retried = false;
    for (let hop = 0; hop < 5; hop++) {
      const headers = { Authorization: `dooray-api ${token}`, Accept: raw ? '*/*' : 'application/json' };
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : form, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        fail('DOORAY_NETWORK', `두레이 API 에 연결하지 못했습니다(${e?.name === 'TimeoutError' ? '응답 시간 초과' : e?.cause?.code || e?.message || e}). 서버의 인터넷 연결을 확인하세요.`, 502);
      }
      if (REDIRECT.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel?.().catch?.(() => {});
        if (!location) fail('DOORAY_REDIRECT', '두레이가 옮겨 갈 주소를 알려 주지 않았습니다.', 502);
        const next = new URL(location, url);
        // 토큰은 두레이 도메인 안의 https 주소에만 다시 보낸다
        if (!trusted(next)) fail('DOORAY_REDIRECT', '두레이가 알려 준 파일 주소가 두레이 도메인 밖이라 따라가지 않았습니다.', 502);
        // 본문이 있는 요청은 307·308 일 때만 같은 꼴로 다시 보낼 수 있다
        if (method !== 'GET' && ![307, 308].includes(res.status)) fail('DOORAY_REDIRECT', `두레이가 예상하지 못한 이동(${res.status})을 알렸습니다.`, 502);
        url = next; continue;
      }
      if (res.status === 429 && !retried) {
        retried = true; await res.body?.cancel?.().catch?.(() => {});
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : retryMs);
        hop--; continue;
      }
      if (!res.ok) throw await errorOf(res);
      const type = res.headers.get('content-type') || '';
      if (raw) {
        if (/text\/html/i.test(type)) { await res.body?.cancel?.(); fail('DOORAY_ERROR', '두레이가 파일 대신 웹 화면을 돌려주었습니다. 토큰과 파일 권한을 확인하세요.', 502); }
        return readCapped(res, maxBytes);
      }
      const text = await res.text();
      let body; try { body = text ? parseJson(text) : {}; } catch { fail('DOORAY_ERROR', '두레이 응답 형식을 읽지 못했습니다.', 502); }
      if (body?.header?.isSuccessful === false) fail('DOORAY_ERROR', `두레이 작업이 실패했습니다.${body.header.resultMessage ? ` (두레이: ${String(body.header.resultMessage).slice(0, 300)})` : ''}`, 502);
      return { result: body?.result ?? null, totalCount: body?.totalCount == null ? null : Number(body.totalCount) };
    }
    fail('DOORAY_REDIRECT', '두레이 주소 이동이 너무 많습니다.', 502);
  }

  const fileForm = (name, bytes, mime) => { const form = new FormData(); form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name); return form; };
  const filesRoute = (driveId) => `/drive/v1/drives/${segment(driveId)}/files`;
  return {
    request,
    me: () => request('GET', '/common/v1/members/me'),
    drives: (query) => request('GET', '/drive/v1/drives', { query }),
    files: (driveId, query) => request('GET', filesRoute(driveId), { query }),
    meta: (driveId, fileId) => request('GET', `${filesRoute(driveId)}/${segment(fileId)}`, { query: { media: 'meta' } }),
    download: (driveId, fileId, maxBytes) => request('GET', `${filesRoute(driveId)}/${segment(fileId)}`, { query: { media: 'raw' }, raw: true, maxBytes }),
    upload: (driveId, parentId, name, bytes, mime) => request('POST', filesRoute(driveId), { query: { parentId: String(parentId) }, form: fileForm(name, bytes, mime) }),
    update: (driveId, fileId, name, bytes, mime) => request('PUT', `${filesRoute(driveId)}/${segment(fileId)}`, { query: { media: 'raw' }, form: fileForm(name, bytes, mime) }),
    rename: (driveId, fileId, name) => request('PUT', `${filesRoute(driveId)}/${segment(fileId)}`, { query: { media: 'meta' }, json: { name } }),
    move: (driveId, fileId, destinationFileId) => request('POST', `${filesRoute(driveId)}/${segment(fileId)}/move`, { json: { destinationFileId } }),
  };
}
