// 시험용 가짜 두레이 서비스 API — 'dooray api 가이드.txt'(2026.11.09 판)의 드라이브·멤버 경로만 흉내 낸다. 실제 두레이를 부르지 않는다.
//   - 모든 요청은 'Authorization: dooray-api <토큰>' 이 맞아야 한다(없으면 가이드와 같은 401 JSON)
//   - 파일 올리기·내려받기(?media=raw·POST files)는 api 주소에서 307 + Location(fileOrigin) 을 주고, 파일 주소에서만 처리한다
//   - 드라이브 id 는 JSON 숫자(19자리)로 준다 — 클라이언트가 원문 문자열로 보존하는지 본다
import http from 'node:http';

export const FAKE_TOKEN = 'abcd1234:Zx9-test_TOKEN.value';
export const FAKE_DRIVE = '3000000000000000001';
export const OTHER_DRIVE = '3000000000000000002';
// 프로젝트 드라이브(2026-11-18): 일반 프로젝트 '검토팀'·공개 프로젝트 '공개 자료'. NOT_MINE 은 목록에 없는(권한 없는) 드라이브
export const PROJECT_DRIVE = '4000000000000000001';
export const PUBLIC_DRIVE = '4000000000000000009';
export const NOT_MINE_DRIVE = '4000000000000000077';

export function createFakeDooray({ apiOrigin, fileOrigin, token = FAKE_TOKEN } = {}) {
  let seq = 100, rev = 10;
  const files = new Map();
  const add = (f) => { files.set(f.id, { driveId: FAKE_DRIVE, revision: String(++rev), version: 1, bytes: null, mime: '', ...f }); return files.get(f.id); };
  add({ id: 'R1', name: '', type: 'folder', subType: 'root', parent: null });
  add({ id: 'T1', name: '휴지통', type: 'folder', subType: 'trash', parent: null });
  add({ id: 'F1', name: '자료', type: 'folder', subType: 'users', parent: 'R1' });
  add({ id: 'A1', name: '보고서.hwpx', type: 'file', subType: 'doc', parent: 'R1', bytes: Buffer.from('PK-hwpx-bytes'), mime: 'application/haansofthwpx' });
  add({ id: 'B1', name: '메모.txt', type: 'file', subType: 'etc', parent: 'F1', bytes: Buffer.from('메모 내용'), mime: 'text/plain' });
  add({ id: 'X1', name: '남의 파일.txt', type: 'file', subType: 'etc', parent: 'RX', driveId: OTHER_DRIVE, bytes: Buffer.from('x') });
  add({ id: 'PR1', name: '', type: 'folder', subType: 'root', parent: null, driveId: PROJECT_DRIVE });
  add({ id: 'PA1', name: '팀 보고서.hwpx', type: 'file', subType: 'doc', parent: 'PR1', driveId: PROJECT_DRIVE, bytes: Buffer.from('PK-team'), mime: 'application/haansofthwpx' });
  add({ id: 'QR1', name: '', type: 'folder', subType: 'root', parent: null, driveId: PUBLIC_DRIVE });
  add({ id: 'NR1', name: '', type: 'folder', subType: 'root', parent: null, driveId: NOT_MINE_DRIVE });
  const DRIVES = new Set([FAKE_DRIVE, PROJECT_DRIVE, PUBLIC_DRIVE]);
  const state = { calls: [], files, badLocation: false, rate429: 0, failStatus: null };

  const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const ok = (result, extra = {}) => json(200, { header: { isSuccessful: true, resultCode: 0, resultMessage: '' }, result, ...extra });
  const err = (status, message) => json(status, { header: { isSuccessful: false, resultCode: -1, resultMessage: message } });
  const view = (f) => ({ id: f.id, driveId: f.driveId, name: f.name, version: f.version, revision: f.revision, type: f.type, subType: f.subType, mimeType: f.mime || null, size: f.type === 'folder' ? null : f.bytes.length,
    parentFile: f.parent ? { id: f.parent, path: f.parent === 'R1' ? '/' : '/자료' } : undefined });

  /** @param {Request} req */
  async function handle(req) {
    const url = new URL(req.url);
    const onFileHost = url.origin === fileOrigin;
    const auth = req.headers.get('authorization');
    state.calls.push({ method: req.method, origin: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams), auth });
    if (!auth) return err(401, 'Authorization header is missing (xrid:test)');
    if (auth !== `dooray-api ${token}`) return err(401, 'Invalid token (xrid:test)');
    if (state.rate429 > 0) { state.rate429--; return err(429, 'Too many requests'); }
    if (state.failStatus) return err(state.failStatus, '시험 실패');
    const p = url.pathname;
    if (p === '/common/v1/members/me') return ok({ id: '1000000000000000001', name: '홍길동', userCode: 'hong' });
    if (p === '/drive/v1/drives') {
      if (url.searchParams.get('type') === 'project') {
        return ok(url.searchParams.get('scope') === 'public' ? [{ id: PUBLIC_DRIVE, project: { id: '92' }, name: '공개 자료', type: 'project' }]
          : [{ id: PROJECT_DRIVE, project: { id: '91' }, name: '검토팀', type: 'project' }]);
      }
      if (url.searchParams.get('type') !== 'private') return ok([]);
      return json(200, `{"header":{"isSuccessful":true,"resultCode":0,"resultMessage":""},"result":[{"id":${FAKE_DRIVE},"project":{"id":"9"},"name":null,"type":"private"}],"totalCount":1}`);
    }
    const m = /^\/drive\/v1\/drives\/([^/]+)\/files(?:\/([^/]+))?(\/move)?$/.exec(p);
    if (!m) return err(404, 'no route');
    const drive = m[1];
    if (!DRIVES.has(drive)) return err(403, 'no permission');
    const fileId = m[2], media = url.searchParams.get('media');
    // 파일 바이트가 오가는 요청은 파일 주소에서만
    const rawCall = (req.method === 'POST' && !fileId) || media === 'raw';
    if (rawCall && !onFileHost) {
      const location = state.badLocation ? 'https://evil.example.com' + p + url.search : fileOrigin + p + url.search;
      return new Response(null, { status: 307, headers: { location } });
    }
    if (!fileId && req.method === 'GET') {
      if (url.searchParams.get('subTypes')) {
        const want = url.searchParams.get('subTypes').split(',');
        return ok([...files.values()].filter((f) => f.driveId === drive && f.type === 'folder' && want.includes(f.subType)).map(view));
      }
      const parent = url.searchParams.get('parentId');
      const all = [...files.values()].filter((f) => f.driveId === drive && f.parent === parent);
      const page = Number(url.searchParams.get('page') || 0), size = Number(url.searchParams.get('size') || 20);
      return ok(all.slice(page * size, page * size + size).map(view), { totalCount: all.length });
    }
    if (!fileId && req.method === 'POST') {
      const form = await req.formData(); const file = form.get('file');
      if (!file || typeof file === 'string') return err(400, 'file field missing');
      const parent = url.searchParams.get('parentId');
      if (!files.has(parent)) return err(404, 'no parent');
      const f = add({ driveId: drive, id: 'N' + (++seq), name: file.name, type: 'file', subType: 'etc', parent, bytes: Buffer.from(await file.arrayBuffer()), mime: file.type });
      return ok(view(f));
    }
    const f = files.get(fileId);
    if (!f || f.driveId !== drive) return err(404, 'no file');
    if (m[3]) {
      const body = await req.json();
      if (body.destinationFileId === 'trash') f.parent = 'T1'; else f.parent = body.destinationFileId;
      f.revision = String(++rev); return ok(null);
    }
    if (req.method === 'GET' && media === 'meta') return ok(view(f));
    if (req.method === 'GET' && media === 'raw') return new Response(f.bytes, { status: 200, headers: { 'content-type': f.mime || 'application/octet-stream' } });
    if (req.method === 'PUT' && media === 'meta') { const body = await req.json(); f.name = body.name; f.revision = String(++rev); return ok(null); }
    if (req.method === 'PUT' && media === 'raw') {
      const form = await req.formData(); const file = form.get('file');
      if (!file || typeof file === 'string') return err(400, 'file field missing');
      f.bytes = Buffer.from(await file.arrayBuffer()); f.version++; f.revision = String(++rev);
      return ok({ id: f.id, version: f.version });
    }
    return err(400, 'unsupported');
  }
  /** DriveService 에 넣을 fetch — 실제 네트워크 없이 handle 로 */
  const fetchImpl = async (url, init = {}) => handle(new Request(url, { ...init, duplex: 'half' }));
  return { state, handle, fetchImpl, files };
}

/** HTTP 로 띄운 가짜 두레이(api·파일 주소 둘) — 시험 서버(별도 프로세스)가 HWPX_COWORK_DOORAY_API 로 부른다 */
export async function startFakeDoorayHttp(opts = {}) {
  const servers = [http.createServer(), http.createServer()];
  await Promise.all(servers.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const [apiOrigin, fileOrigin] = servers.map((s) => `http://127.0.0.1:${s.address().port}`);
  const fake = createFakeDooray({ ...opts, apiOrigin, fileOrigin });
  for (const [i, s] of servers.entries()) {
    s.on('request', async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const r = await fake.handle(new Request([apiOrigin, fileOrigin][i] + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' }));
        res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  }
  return { ...fake, apiOrigin, fileOrigin, close: () => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))) };
}
