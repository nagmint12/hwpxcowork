// 두레이 드라이브 연결 — 2026-11-17 브라우저 확장프로그램 방식을 걷어 내고 두레이 서비스 API(개인 API 인증 토큰)로 바꿨다.
//   - 토큰은 각 사용자가 두레이(개인설정 > API > 개인 인증 토큰)에서 직접 만들어 cowork 에 한 번 넣는다. 두레이 로그인은 사용자가 직접 한다.
//     서버는 토큰을 암호문으로만 보관하고(server/secret-box.js — config 옆 .hwpx-cowork-secret 열쇠) 화면·AI·기록에 다시 보여 주지 않는다(끝 4자리만).
//   - 쓰는 범위: 그 토큰 주인의 '개인 드라이브'(GET /drive/v1/drives?type=private) + 사용자가 [프로젝트 추가]로 고른 프로젝트 드라이브(2026-11-18).
//     프로젝트 드라이브는 목록·내려받기·새 파일 올리기만(교체·이름 바꾸기·삭제는 개인 드라이브에서만). 추가한 목록 밖의 드라이브는 거절한다.
//   - 폴더 목록은 요청한 화면에 바로 건네고 서버에 저장하지 않는다. AI 는 드라이브를 쓰지 않는다(MCP 드라이브 도구 없음).
//   - 가져오기·업로드·교체·삭제(휴지통으로)·이름 바꾸기는 본인이 cowork 화면에서 직접 할 때만. 쓰기 전에 목록에서 본 revision 과 폴더를 다시 확인한다.
//   - 예전 확장 방식(연결 코드·작업 선점·WebSocket·확장 ZIP)의 사본: backups/dooray_drive_extension_2026-11-17/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ServiceError } from './service.js';
import { createSecretBox } from './secret-box.js';
import { DOORAY_CLOUDS, createDoorayClient, doorayEndpoint, normalizeDoorayToken } from './dooray-api.js';

export const DRIVE_MAX_BYTES = 50 * 1024 * 1024;
/** AI 드라이브 기능은 없다(예전 확장 방식의 AI 문맥·업로드 제안은 확장과 함께 걷어 냈다) */
export const DRIVE_AI_ENABLED = false;
export const DRIVE_PAGE_SIZE = 50;
const NAME_SCAN_PAGES = 40;   // 같은 이름 찾기: 100개씩 40쪽(4천 개)까지 본다
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(16).toString('hex');
const fail = (code, message, status = 400) => { throw new ServiceError(code, message, status); };
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(s);
const doorayId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const actions = new Set(['list', 'download', 'upload', 'delete', 'rename']);
const PERSONAL = 'personal';
const PROJECT_ACTIONS = new Set(['list', 'download', 'upload']);   // 프로젝트 드라이브: 목록·내려받기·새 파일 올리기만(교체·이름 바꾸기·삭제 없음)
const MAX_PROJECTS = 30;

export function fileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\\/\x00-\x1f]/.test(value) || ['.', '..'].includes(value.trim())) fail('DRIVE_NAME', '올바른 파일 이름을 지정하세요.');
  return value.trim();
}
const norm = (f) => ({ id: String(f.id), name: String(f.name || ''), type: f.type === 'folder' ? 'folder' : 'file', size: Math.max(0, Number(f.size) || 0), mime: String(f.mimeType || '').slice(0, 150), revision: String(f.revision ?? '').slice(0, 200) });

export class DriveService {
  /**
   * @param {{config:object, service?:object, now?:Function, fetchImpl?:Function, secretFile?:string|null, apiOverride?:string|null}} o
   *   apiOverride: 시험용 두레이 API 주소(loopback 만) — 기본은 환경 변수 HWPX_COWORK_DOORAY_API
   */
  constructor({ config, service, now = Date.now, fetchImpl = globalThis.fetch, secretFile = null, apiOverride = process.env.HWPX_COWORK_DOORAY_API || null }) {
    this.service = service; this.now = now; this.config = config; this.fetchImpl = fetchImpl; this.apiOverride = apiOverride || null;
    this.dir = path.join(config.dataDir, 'drive');
    this.aiEnabled = false;
    this.maxBytes = Math.min(config.attachments?.maxBytes || DRIVE_MAX_BYTES, DRIVE_MAX_BYTES);
    this.box = createSecretBox({ config, secretFile, purpose: 'dooray-token' });
    this.roots = new Map();      // 'owner:driveId' → rootId
    this.running = new Map();    // owner → 진행 중 작업 수
    this.using = new Set();      // 전송 중인 보관 파일 id
  }
  owner(user) { if (!user?.name) fail('DRIVE_AUTH', '로그인이 필요합니다.', 401); return hash(user.name); }
  read(user) {
    const p = path.join(this.dir, this.owner(user), 'index.json');
    let state;
    try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return { files: [], dooray: null, lastSite: null }; }
    // 예전 확장 방식의 흔적(확장 토큰 해시·폴더 목록·AI 제안)은 읽을 때 지운다
    if ('bridge' in state || 'context' in state || 'proposals' in state) { delete state.bridge; delete state.context; delete state.proposals; this.save(user, state); }
    state.files ||= []; state.dooray ||= null; state.lastSite ||= null;
    return state;
  }
  save(user, state) {
    const dir = path.join(this.dir, this.owner(user)); fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, 'index.tmp'); fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temp, path.join(dir, 'index.json'));
  }
  publicFile(f) { const { disk, ...out } = f; return out; }
  defaultSite() { const s = this.config.drive?.doorayUrl; return typeof s === 'string' && s.trim() ? s.trim() : null; }

  status(user) {
    const state = this.read(user); const c = state.dooray;
    return {
      connected: !!c, maxBytes: this.maxBytes, aiEnabled: false,
      writeProjects: c ? [PERSONAL] : [],
      // 2026-11-18 화면에 보일 드라이브: 내 드라이브 + 사용자가 [프로젝트 추가]로 고른 프로젝트 드라이브. can = 할 수 있는 작업
      drives: c ? [{ key: PERSONAL, name: '내 드라이브', kind: 'personal', can: [...actions] }, ...(c.projects || []).map((d) => ({ key: d.driveId, name: d.name, kind: 'project', scope: d.scope, can: [...PROJECT_ACTIONS] }))] : [],
      account: c ? { site: c.site, cloud: c.cloud, cloudLabel: c.cloudLabel, name: c.member?.name || '', keyHint: c.keyHint, connectedAt: c.connectedAt, checkedAt: c.checkedAt || null } : null,
      site: c?.site || state.lastSite || this.defaultSite(),
      clouds: DOORAY_CLOUDS.map(({ id, label, domain }) => ({ id, label, domain })),
      providers: [{ id: 'dooray', name: '두레이', scope: '개인 드라이브·추가한 프로젝트 드라이브' }],
      files: state.files.map((f) => this.publicFile(f)),
    };
  }

  client(endpoint, token) { return createDoorayClient({ apiBase: endpoint.apiBase, domain: endpoint.domain, token, fetchImpl: this.fetchImpl }); }
  /** 토큰으로 계정·개인 드라이브·최상위 폴더를 확인한다(쓰기 없음) */
  async probe(endpoint, token) {
    const client = this.client(endpoint, token);
    const me = (await client.me()).result;
    if (!me?.id) fail('DOORAY_AUTH', '두레이 계정 정보를 확인하지 못했습니다. 토큰을 다시 확인하세요.', 409);
    const drives = ((await client.drives({ type: 'private' })).result || []).filter((d) => d?.type === 'private' && doorayId(String(d.id ?? '')));
    if (drives.length !== 1) fail('DOORAY_DRIVE', drives.length ? '개인 드라이브가 여러 개라 고르지 못했습니다.' : '이 토큰의 계정에서 개인 드라이브를 찾지 못했습니다.', 409);
    const driveId = String(drives[0].id);
    const rootId = await this.findRoot(client, driveId);
    return { client, member: { id: String(me.id), name: String(me.name || me.nickname || '').slice(0, 80) }, driveId, rootId };
  }
  async findRoot(client, driveId) {
    const roots = ((await client.files(driveId, { type: 'folder', subTypes: 'root' })).result || []).filter((f) => f?.subType === 'root' && doorayId(String(f.id ?? '')));
    if (roots.length !== 1) fail('DOORAY_DRIVE', '드라이브의 최상위 폴더를 찾지 못했습니다.', 502);
    return String(roots[0].id);
  }

  async connect(user, body = {}) {
    this.owner(user);
    const endpoint = doorayEndpoint(body.site || this.defaultSite(), this.apiOverride);
    const token = normalizeDoorayToken(body.token);
    const { member, driveId, rootId } = await this.probe(endpoint, token);
    const at = new Date(this.now()).toISOString();
    const state = this.read(user);
    // 토큰만 바꾼 같은 계정·같은 사이트면 추가해 둔 프로젝트 목록을 그대로 둔다
    const prev = state.dooray; const keep = prev?.member?.id === member.id && prev?.site === endpoint.site ? prev.projects || [] : [];
    state.dooray = { site: endpoint.site, cloud: endpoint.cloud, cloudLabel: endpoint.cloudLabel, apiBase: endpoint.apiBase, domain: endpoint.domain,
      token: this.box.seal(token, user.name), keyHint: '…' + token.slice(-4), member, driveId, projects: keep, connectedAt: at, checkedAt: at };
    state.lastSite = endpoint.site;
    this.save(user, state); this.forgetRoots(user); this.roots.set(`${this.owner(user)}:${driveId}`, rootId);
    return this.status(user);
  }
  /** 저장한 토큰이 아직 쓰이는지 다시 확인(쓰기 없음) */
  async check(user) {
    const { c, client } = this.connection(user);
    const me = (await client.me()).result;
    if (!me?.id) fail('DOORAY_AUTH', '두레이 계정 정보를 확인하지 못했습니다.', 409);
    if (String(me.id) !== c.member.id) fail('DOORAY_ACCOUNT', '토큰의 두레이 계정이 등록할 때와 다릅니다. 토큰을 다시 등록하세요.', 409);
    const state = this.read(user); state.dooray.checkedAt = new Date(this.now()).toISOString(); this.save(user, state);
    return this.status(user);
  }
  disconnect(user) {
    const state = this.read(user);
    if (state.dooray) { state.lastSite = state.dooray.site || state.lastSite; state.dooray = null; this.save(user, state); }
    this.forgetRoots(user);
    return { ok: true };
  }
  connection(user) {
    const c = this.read(user).dooray;
    if (!c) fail('DRIVE_OFFLINE', '두레이 API 토큰을 먼저 등록하세요. [연결 설정]에서 등록합니다.', 409);
    const token = this.box.unseal(c.token, user.name);
    if (!token) fail('DOORAY_TOKEN_LOST', '저장한 두레이 토큰을 풀지 못했습니다(서버 암호 열쇠가 바뀜). 토큰을 다시 등록하세요.', 409);
    // API 주소는 등록 때 정한 것을 쓴다(시험 주소로 바꾼 서버에서는 시험 주소만)
    const endpoint = this.apiOverride ? doorayEndpoint(c.site, this.apiOverride) : { apiBase: c.apiBase, domain: c.domain };
    return { c, client: this.client(endpoint, token) };
  }
  forgetRoots(user) { const prefix = this.owner(user) + ':'; for (const k of [...this.roots.keys()]) if (k.startsWith(prefix)) this.roots.delete(k); }
  async rootOf(user, c, client) {
    const key = `${this.owner(user)}:${c.driveId}`; const known = this.roots.get(key);
    if (known) return known;
    const rootId = await this.findRoot(client, c.driveId); this.roots.set(key, rootId); return rootId;
  }
  /** 화면의 폴더 id('root' 또는 두레이 id) → 두레이 폴더 id. 고른 드라이브(c.driveId) 안의 폴더만 */
  async folderOf(user, c, client, folderId, verify) {
    const rootId = await this.rootOf(user, c, client);
    if (!folderId || folderId === 'root' || folderId === rootId) return rootId;
    if (!doorayId(folderId)) fail('DRIVE_TARGET', '폴더를 확인하세요.');
    if (verify) {
      const f = (await client.meta(c.driveId, folderId)).result;
      if (!f || f.type !== 'folder' || (f.driveId != null && String(f.driveId) !== c.driveId)) fail('DRIVE_SCOPE', '이 드라이브 안의 폴더가 아닙니다.', 403);
      if (f.subType === 'trash') fail('DRIVE_SCOPE', '휴지통에는 올리거나 고칠 수 없습니다.', 403);
    }
    return folderId;
  }
  /** 쓰기·내려받기 대상 파일: 고른 드라이브·선택한 폴더 바로 아래의 파일, 목록에서 본 revision 그대로 */
  async checkedFile(c, client, folderId, fileId, revision) {
    if (!doorayId(fileId)) fail('DRIVE_FILE_ID', '파일을 선택하세요.');
    const f = (await client.meta(c.driveId, fileId)).result;
    if (!f || f.type !== 'file') fail('DRIVE_FILE_ID', '파일이 아닙니다. 목록을 새로 읽어 주세요.', 409);
    if (f.driveId != null && String(f.driveId) !== c.driveId) fail('DRIVE_SCOPE', '이 드라이브 안의 파일이 아닙니다.', 403);
    if (String(f.parentFile?.id ?? '') !== folderId) fail('DRIVE_SCOPE', '선택한 폴더의 파일만 사용할 수 있습니다. 목록을 새로 읽어 주세요.', 409);
    if (revision && String(f.revision ?? '') !== String(revision)) fail('DRIVE_REVISION', '파일이 다른 곳에서 바뀌었습니다. 목록을 새로 읽고 확인하세요.', 409);
    return f;
  }
  async nameTaken(c, client, folderId, name, exceptId = null) {
    for (let page = 0; page < NAME_SCAN_PAGES; page++) {
      const r = await client.files(c.driveId, { parentId: folderId, page, size: 100 });
      const items = r.result || [];
      if (items.some((f) => f?.name === name && String(f.id) !== exceptId && f.subType !== 'trash')) return true;
      if (items.length < 100 || (r.totalCount != null && (page + 1) * 100 >= r.totalCount)) return false;
    }
    return false;   // 아주 큰 폴더는 끝까지 보지 않는다 — 두레이의 중복 거절(409)에 맡긴다
  }

  /** 작업 대상 드라이브: body.drive(옛 화면은 projectId) = 'personal' 또는 사용자가 추가한 프로젝트 드라이브 id. 추가하지 않은 드라이브는 거절 */
  driveOf(c, body) {
    const key = String(body.drive ?? body.projectId ?? PERSONAL);
    if (key === PERSONAL) return { key, driveId: c.driveId, kind: 'personal', can: actions };
    const d = (c.projects || []).find((x) => x.driveId === key);
    if (!d) fail('DRIVE_SCOPE', '[프로젝트 추가]로 허용한 프로젝트 드라이브만 열 수 있습니다.', 403);
    return { key, driveId: d.driveId, kind: 'project', can: PROJECT_ACTIONS };
  }
  /** 이 토큰으로 볼 수 있는 프로젝트 드라이브(두레이에서 그때그때 읽는다 — 서버에 저장하지 않는다). added = 이미 추가함 */
  async availableProjects(user) {
    const { c, client } = this.connection(user);
    const seen = new Map();
    for (const scope of ['private', 'public']) {
      const list = (await client.drives({ type: 'project', scope })).result || [];
      for (const d of list) {
        const id = String(d?.id ?? '');
        if (d?.type !== 'project' || !doorayId(id) || seen.has(id)) continue;
        seen.set(id, { driveId: id, projectId: String(d.project?.id ?? ''), name: String(d.name || '이름 없는 프로젝트').slice(0, 120), scope });
      }
    }
    const added = new Set((c.projects || []).map((d) => d.driveId));
    return { projects: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((d) => ({ ...d, added: added.has(d.driveId) })) };
  }
  /** 허용 목록 바꾸기: driveIds = 보일 프로젝트 드라이브 id 전체. 두레이에서 지금 볼 수 있는 것만 받는다 */
  async setProjects(user, driveIds) {
    if (!Array.isArray(driveIds) || driveIds.length > MAX_PROJECTS || driveIds.some((x) => !doorayId(String(x)))) fail('DRIVE_PROJECTS', `프로젝트는 ${MAX_PROJECTS}개까지 고를 수 있습니다.`);
    const wanted = [...new Set(driveIds.map(String))];
    const available = wanted.length ? new Map((await this.availableProjects(user)).projects.map((d) => [d.driveId, d])) : new Map();
    const missing = wanted.filter((id) => !available.has(id));
    if (missing.length) fail('DRIVE_PROJECTS', '두레이에서 볼 수 없는 프로젝트가 있습니다. 목록을 새로 읽어 주세요.', 409);
    const state = this.read(user);
    if (!state.dooray) fail('DRIVE_OFFLINE', '두레이 API 토큰을 먼저 등록하세요.', 409);
    const at = new Date(this.now()).toISOString();
    const before = new Map((state.dooray.projects || []).map((d) => [d.driveId, d]));
    state.dooray.projects = wanted.map((id) => { const d = available.get(id); return { driveId: id, projectId: d.projectId, name: d.name, scope: d.scope, addedAt: before.get(id)?.addedAt || at }; });
    this.save(user, state);
    return this.status(user);
  }

  async action(user, body = {}) {
    if (!actions.has(body.action)) fail('DRIVE_ACTION', '지원하지 않는 작업입니다.');
    const { c, client } = this.connection(user);
    // 대상 드라이브·권한 검사는 진행 수를 세기 전에(거절된 요청이 '진행 중'으로 남지 않게)
    const d = this.driveOf(c, body);
    if (!d.can.has(body.action) || (body.action === 'upload' && body.replaceId && d.kind !== 'personal')) fail('DRIVE_READONLY', '프로젝트 드라이브에서는 목록·내려받기·새 파일 올리기만 할 수 있습니다.', 403);
    const owner = this.owner(user);
    if ((this.running.get(owner) || 0) >= 3) fail('DRIVE_BUSY', '진행 중인 전송이 끝난 뒤 다시 시도하세요.', 409);
    this.running.set(owner, (this.running.get(owner) || 0) + 1);
    try { return await this.run(user, { ...c, driveId: d.driveId }, client, body); }
    finally { const n = (this.running.get(owner) || 1) - 1; if (n > 0) this.running.set(owner, n); else this.running.delete(owner); }
  }
  async run(user, c, client, body) {
    const write = ['upload', 'delete', 'rename'].includes(body.action);
    const folderId = await this.folderOf(user, c, client, body.folderId, write);
    if (body.action === 'list') {
      const page = Math.max(0, Math.min(1000, Math.floor(Number(body.page) || 0)));
      const r = await client.files(c.driveId, { parentId: folderId, page, size: DRIVE_PAGE_SIZE });
      const raw = (r.result || []).filter((f) => f && doorayId(String(f.id ?? '')) && f.subType !== 'trash' && f.subType !== 'root');
      if (raw.some((f) => f.driveId != null && String(f.driveId) !== c.driveId)) fail('DRIVE_SCOPE', '폴더 범위를 확인하지 못했습니다.', 502);
      const items = raw.slice(0, 100).map(norm).filter((f) => f.name && !/[\\/\x00-\x1f]/.test(f.name));
      const total = r.totalCount != null && Number.isFinite(r.totalCount) ? r.totalCount : items.length;
      return { items, total, nextPage: (page + 1) * DRIVE_PAGE_SIZE < total ? page + 1 : null };
    }
    if (body.action === 'download') {
      const f = await this.checkedFile(c, client, folderId, body.fileId, String(body.expectedRevision || ''));
      if (Number(f.size) > this.maxBytes) fail('DRIVE_SIZE', '파일 크기 한도를 초과했습니다.', 413);
      const bytes = await client.download(c.driveId, f.id, this.maxBytes);
      const entry = this.stage(user, bytes, fileName(String(f.name || 'file')), f.mimeType || 'application/octet-stream', { provider: 'dooray', driveId: c.driveId, fileId: String(f.id), revision: String(f.revision ?? '') });
      return { stagedId: entry.id, name: entry.name };
    }
    if (body.action === 'upload') {
      const state = this.read(user); const staged = state.files.find((f) => f.id === body.stagedId);
      if (!staged) fail('DRIVE_LOCAL_FILE', '서버 파일을 선택하세요.', 404);
      const name = fileName(body.name || staged.name);
      const bytes = fs.readFileSync(path.join(this.dir, this.owner(user), staged.id));
      this.using.add(staged.id);
      try {
        if (body.replaceId) {
          if (!body.expectedRevision) fail('DRIVE_REVISION', '교체 대상의 최신 정보를 다시 읽어 주세요.', 409);
          const f = await this.checkedFile(c, client, folderId, body.replaceId, String(body.expectedRevision));
          if (f.name !== name) fail('DRIVE_NAME', '교체 파일 이름은 원본과 같아야 합니다.');
          await client.update(c.driveId, f.id, name, bytes, staged.mime);
          return norm((await client.meta(c.driveId, f.id)).result || { ...f });
        }
        if (await this.nameTaken(c, client, folderId, name)) fail('DRIVE_EXISTS', '같은 이름의 파일이 있습니다. 목록에서 교체 대상을 선택하세요.', 409);
        const r = await client.upload(c.driveId, folderId, name, bytes, staged.mime);
        if (!r.result?.id) fail('DOORAY_ERROR', '업로드 결과를 확인하지 못했습니다. 두레이에서 확인하세요.', 502);
        return norm({ name, ...r.result });
      } finally { this.using.delete(staged.id); }
    }
    // 삭제 = 두레이 휴지통으로 옮김(두레이에서 되살릴 수 있다). 이름 바꾸기 = 같은 폴더에 같은 이름이 없을 때만. 둘 다 목록에서 본 revision 그대로일 때만
    if (!body.expectedRevision) fail('DRIVE_REVISION', '대상 파일의 최신 정보를 다시 읽어 주세요.', 409);
    const f = await this.checkedFile(c, client, folderId, body.fileId, String(body.expectedRevision));
    if (body.action === 'delete') {
      await client.move(c.driveId, f.id, 'trash');
      return { id: String(f.id), deleted: true };
    }
    const name = fileName(body.name);
    if (f.name === name) return norm(f);
    if (await this.nameTaken(c, client, folderId, name, String(f.id))) fail('DRIVE_EXISTS', '같은 이름의 파일이 있습니다.', 409);
    await client.rename(c.driveId, f.id, name);
    return norm((await client.meta(c.driveId, f.id)).result || { ...f, name });
  }

  stage(user, bytes, name, mime = 'application/octet-stream', source = null) {
    name = fileName(name); if (!Buffer.isBuffer(bytes) || bytes.length > this.maxBytes) fail('DRIVE_SIZE', '파일 크기 한도를 초과했습니다.', 413);
    const state = this.read(user); if (state.files.length >= 50 || state.files.reduce((s, f) => s + f.size, 0) + bytes.length > this.maxBytes * 5) fail('DRIVE_QUOTA', '서버 보관 파일을 정리한 뒤 다시 올려 주세요.', 409);
    const key = newId(); const dir = path.join(this.dir, this.owner(user)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, key), bytes, { mode: 0o600 });
    const entry = { id: key, name, size: bytes.length, mime: String(mime).slice(0, 150), sha256: hash(bytes), at: new Date(this.now()).toISOString(), source };
    state.files.push(entry); this.save(user, state); return entry;
  }
  bytes(user, key) { const f = this.read(user).files.find((f) => f.id === key); if (!f) fail('DRIVE_LOCAL_FILE', '서버 파일이 없습니다.', 404); return { entry: f, bytes: fs.readFileSync(path.join(this.dir, this.owner(user), f.id)) }; }
  async importDocument(user, key, location = null) {
    const file = this.bytes(user, key);
    // 외부 드라이브의 개인 전송 파일은 목적지를 생략해도 공용 문서함으로 노출하지 않는다.
    const target = location ?? { space: 'private', owner: user.name, folderId: null };
    if (!target || typeof target !== 'object' || Array.isArray(target) || (!target.space && !target.folderId)) fail('DRIVE_LIBRARY_TARGET', '저장할 문서함과 폴더를 선택하세요.');
    return this.service.createDocument({ fileName: file.entry.name, bytes: file.bytes, user, location: target });
  }
  async prepareDocument(user, docId, attachmentId = null) {
    this.service.assertDocRead(docId, user);
    const meta = this.service._meta(docId); const location = this.service.library.locOf(meta);
    if (attachmentId) { const f = await this.service.getAttachment(docId, attachmentId); return this.stage(user, f.bytes, f.entry.name, f.entry.mime, { kind: 'library-attachment', docId, attachmentId, location }); }
    const snapshot = await this.service.workingSnapshot(docId);
    return this.stage(user, Buffer.from(snapshot.bytes), `${meta.title || '공동 문서'}.hwpx`, 'application/vnd.hancom.hwpx', { kind: 'library', docId, version: snapshot.version, location });
  }
  deleteFile(user, key) {
    const s = this.read(user); const f = s.files.find((f) => f.id === key); if (!f) fail('DRIVE_LOCAL_FILE', '서버 파일이 없습니다.', 404);
    if (this.using.has(key)) fail('DRIVE_BUSY', '전송 중인 파일입니다.', 409);
    fs.unlinkSync(path.join(this.dir, this.owner(user), f.id)); s.files = s.files.filter((f) => f.id !== key); this.save(user, s); return { ok: true };
  }
}
