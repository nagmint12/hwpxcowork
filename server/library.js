// 문서함(docs/LIBRARY_SPEC.md): 공용 문서함 하나 + 개인 문서함(사람마다 하나), 그 안의 폴더, 폴더·문서별 접근 권한.
// 폴더 목록은 <dataDir>/folders.json 하나(원자적 쓰기, 이 프로세스가 메모리에 들고 고칠 때마다 쓴다). 문서의 자리는 문서 meta 에 둔다:
//   meta.space = 'public'(없으면 — 옛 문서) | 'private' · meta.spaceOwner = 개인 문서함 주인 · meta.folderId = 폴더 id(없으면 문서함 맨 위)
//   meta.access = null(폴더 권한 따름) | { acl: [{ name, perms }] }(이 문서만 따로 — 폴더 권한 대신)
// 권한(perms): read 보기 · write 작성(올리기·하위 폴더) · edit 편집 · delete 삭제 · manage 관리(권한·이름·옮기기·폴더 지우기).
// read 말고 무엇이든 있으면 read 도 있다. 이름 '*' = 모든 사용자(공용 문서함에서만).
// 누가 무엇을 하나:
//   관리자(role admin) — 언제나 전부(개인 문서함도).
//   개인 문서함 주인 — 자기 문서함의 폴더·문서 전부. 다른 사람은 폴더·문서에 적힌(acl) 만큼만.
//   공용 문서함 — 폴더의 acl(상위 폴더를 따르면 위로 올라가 맨 위 publicRoot.acl — 기본: 모든 사용자 보기·작성·편집, 삭제·관리는 관리자).
//   문서를 올린 사람 — 그 문서 보기·편집·관리(삭제는 폴더 권한대로). 폴더 관리 권한이 있으면 그 안 문서도 관리.
//   폴더를 만든 사람 — 그 폴더 보기·작성·관리.
//   역할 viewer — 남의 문서함에서는 보기만(자기 개인 문서함은 주인이라 전부).
import fs from 'node:fs';
import { ownsTutorial } from './tutorial-identity.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './store.js';
import { ServiceError } from './service.js';

export const PERMS = Object.freeze(['read', 'write', 'edit', 'delete', 'manage']);
export const EVERYONE = '*';
export const SPACES = Object.freeze(['public', 'private']);
export const DEFAULT_PUBLIC_ACL = Object.freeze([{ name: EVERYONE, perms: ['read', 'write', 'edit'] }]);
const ALL = [...PERMS];
const FOLDER_ID_RE = /^f[0-9a-z]{6,40}$/;
const NAME_MAX = 60;
const ACL_MAX = 200;
const DEPTH_MAX = 8;
const fail = (code, message, status = 400) => new ServiceError(code, message, status);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// 이름: 제어·줄 구분·양방향 제어·BOM 글자를 빼고 공백을 줄인다. 폴더 이름의 / \ 는 경로 표시와 헷갈리므로 뺀다
const badCp = (c) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
const cleanText = (s) => [...String(s ?? '')].filter((ch) => !badCp(ch.codePointAt(0))).join('').replace(/\s+/g, ' ').trim();

/** 권한 목록 정리: 아는 것만, PERMS 순서로, 하나라도 있으면 read 도 */
export function normPerms(list) {
  const s = new Set((Array.isArray(list) ? list : []).filter((p) => PERMS.includes(p)));
  if (s.size) s.add('read');
  return PERMS.filter((p) => s.has(p));
}

/**
 * 접근 목록 정리 → [{ name, perms }](같은 이름은 합친다, 권한이 빈 줄은 뺀다).
 * strict 면 꼴이 틀린 줄에 400 BAD_ACL. everyone=false(개인 문서함)면 '*' 줄은 받지 않는다. skip = 넣지 않을 이름(개인 문서함 주인)
 */
export function normAcl(acl, { strict = false, everyone = true, skip = null } = {}) {
  if (acl == null) return [];
  if (!Array.isArray(acl)) { if (strict) throw fail('BAD_ACL', 'acl 은 [{ name, perms }] 배열이어야 합니다'); return []; }
  const map = new Map();
  for (const e of acl) {
    if (!object(e)) { if (strict) throw fail('BAD_ACL', 'acl 의 항목은 { name, perms } 입니다'); continue; }
    const name = e.name === EVERYONE ? EVERYONE : cleanText(e.name);
    if (!name || [...name].length > 100) { if (strict) throw fail('BAD_ACL', '사람 이름이 올바르지 않습니다'); continue; }
    if (name === EVERYONE && !everyone) { if (strict) throw fail('BAD_ACL', "개인 문서함에는 '모든 사용자'를 넣을 수 없습니다"); continue; }
    if (skip && name === skip) continue;
    if (e.perms != null && !Array.isArray(e.perms)) { if (strict) throw fail('BAD_ACL', 'perms 는 배열이어야 합니다'); continue; }
    if (strict && (e.perms || []).some((p) => !PERMS.includes(p))) throw fail('BAD_ACL', `권한은 ${PERMS.join('·')} 중에서 고릅니다`);
    const perms = normPerms([...(map.get(name) || []), ...(e.perms || [])]);
    if (perms.length) map.set(name, perms); else map.delete(name);
  }
  if (map.size > ACL_MAX) { if (strict) throw fail('BAD_ACL', `접근 목록은 ${ACL_MAX}줄까지입니다`); }
  return [...map].slice(0, ACL_MAX).map(([name, perms]) => ({ name, perms }));
}

/** 접근 목록에서 그 사람의 권한(이름 줄 + '*' 줄을 합친다 — 개인 문서함은 '*' 를 보지 않는다) */
function aclPerms(acl, user, space) {
  const s = new Set();
  for (const e of acl || []) {
    if (e.name === user.name || (e.name === EVERYONE && space === 'public')) for (const p of e.perms || []) s.add(p);
  }
  return normPerms([...s]);
}

/** 역할 viewer 는 남의 문서함에서 보기만 */
const capRole = (user, perms) => (user?.role === 'viewer' ? perms.filter((p) => p === 'read') : perms);

// PC 폴더 연결(server/local-folders.js): 연결한 PC 폴더와 그 하위 폴더는 주인의 개인 문서함에 비친 폴더다 — local = { link: 연결 id, rel: 연결 뿌리에서의 길('' = 뿌리) }
const LINK_ID_RE = /^k[0-9a-f]{8,40}$/;
const cleanLocal = (v) => (object(v) && LINK_ID_RE.test(String(v.link)) && typeof v.rel === 'string' ? { link: String(v.link), rel: v.rel } : null);
/** 폴더 이름표(저장·표시용): 제어 글자를 빼고 60자까지 — PC 폴더 이름도 같은 꼴로 보인다(실제 길은 local.rel) */
export const folderLabel = (name) => cleanText(name).slice(0, NAME_MAX) || '이름 없음';
const cleanFolder = (f) => (object(f) && FOLDER_ID_RE.test(String(f.id)) && SPACES.includes(f.space) && typeof f.name === 'string'
  ? {
    id: f.id, name: folderLabel(f.name), parentId: FOLDER_ID_RE.test(String(f.parentId)) ? f.parentId : null,
    space: f.space, owner: f.space === 'private' ? cleanText(f.owner) || null : null,
    inherit: f.inherit !== false, acl: normAcl(f.acl, { everyone: f.space === 'public' }),
    createdBy: f.createdBy ?? null, createdAt: f.createdAt ?? null, updatedAt: f.updatedAt ?? null,
    ...(f.space === 'private' && cleanLocal(f.local) ? { local: cleanLocal(f.local) } : {}),
  }
  : null);

export class Library {
  /** dataDir: 데이터 폴더(folders.json 이 여기). 파일이 망가졌으면 읽기만 하고 쓰기는 막는다(덮어써서 지우지 않게) */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'folders.json');
    this.broken = null;
    this.data = this._read();
    // PC 폴더 연결(server/local-folders.js)이 넣는다: 비친 폴더를 만들고·옮기고·지울 때 PC 의 실제 폴더를 함께 바꾼다
    //   { createFolder(parent, name) → { id, local }, moveFolder(folder, name, parent) → 새 폴더, removeFolder(folder) }
    this.localHooks = null;
  }

  /**
   * PC 폴더 연결의 비친 폴더 맞추기: desired = 지금 있어야 할 폴더 [{ id, name, parentId, owner, local }](주인의 개인 문서함).
   * 없는 것은 만들고 이름·위가 달라졌으면 고치며, 목록에 없는 비친 폴더는 뺀다. 권한(inherit·acl)은 그대로 둔다. 바뀐 것이 있을 때만 쓴다 → 바뀌었는가
   */
  mirrorLocal(desired) {
    const want = new Map(desired.map((d) => [d.id, d]));
    let changed = false;
    const kept = [];
    for (const f of this.data.folders) {
      if (!f.local) { kept.push(f); continue; }
      const d = want.get(f.id);
      if (!d) { changed = true; continue; }
      if (f.name !== d.name || f.parentId !== (d.parentId || null) || f.owner !== d.owner || f.local.link !== d.local.link || f.local.rel !== d.local.rel) {
        f.name = d.name; f.parentId = d.parentId || null; f.owner = d.owner; f.local = { ...d.local }; f.updatedAt = new Date().toISOString();
        changed = true;
      }
      kept.push(f); want.delete(f.id);
    }
    const now = new Date().toISOString();
    for (const d of want.values()) {
      if (kept.some((f) => f.id === d.id)) continue;   // 같은 id 의 보통 폴더가 있으면(있을 수 없는 일) 건드리지 않는다
      kept.push({ id: d.id, name: d.name, parentId: d.parentId || null, space: 'private', owner: d.owner, inherit: d.inherit !== false, acl: Array.isArray(d.acl) ? d.acl : [], createdBy: d.owner, createdAt: now, updatedAt: now, local: { ...d.local } });
      changed = true;
    }
    if (changed) { this.data.folders = kept; if (!this.broken) this._save(); }
    return changed;
  }

  _read() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch (e) {
      if (e.code !== 'ENOENT') { this.broken = e.message; console.error(`[문서함] ${this.file} 을 읽지 못했습니다 — 폴더 바꾸기를 막습니다: ${e.message}`); }
    }
    const folders = (Array.isArray(j?.folders) ? j.folders : []).map(cleanFolder).filter(Boolean);
    const rootAcl = Array.isArray(j?.publicRoot?.acl) ? normAcl(j.publicRoot.acl) : DEFAULT_PUBLIC_ACL.map((e) => ({ ...e, perms: [...e.perms] }));
    return { folders, publicRoot: { acl: rootAcl } };
  }

  _save() {
    if (this.broken) throw fail('LIBRARY_BROKEN', `폴더 목록 파일(folders.json)이 망가져 바꿀 수 없습니다: ${this.broken}`, 500);
    writeFileAtomic(this.file, JSON.stringify({ version: 1, ...this.data }, null, 1));
  }

  folder(id) { return id ? this.data.folders.find((f) => f.id === id) || null : null; }
  children(id) { return this.data.folders.filter((f) => f.parentId === (id || null)); }

  /** 폴더 → 위로 올라가는 줄(자기 포함, 맨 위가 끝). 고리는 끊는다 */
  chain(id) {
    const out = []; const seen = new Set();
    for (let f = this.folder(id); f && !seen.has(f.id); f = this.folder(f.parentId)) { seen.add(f.id); out.push(f); }
    return out;
  }

  /** 폴더의 자리 { space, owner, folderId } */
  folderLoc(f) { return { space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.id }; }

  /**
   * 문서의 자리 { space, owner, folderId }. 옛 문서(space 없음)는 공용 문서함 맨 위. 폴더가 없어졌거나 다른 문서함의 폴더면 그 문서함 맨 위.
   * 개인 문서함 주인이 없으면 올린 사람
   */
  locOf(meta) {
    const space = meta?.space === 'private' ? 'private' : 'public';
    const owner = space === 'private' ? (meta.spaceOwner || meta.createdBy || null) : null;
    const f = this.folder(meta?.folderId);
    const ok = f && f.space === space && (space === 'public' || f.owner === owner);
    return { space, owner, folderId: ok ? f.id : null };
  }

  /** 자리의 실제 접근 목록: 폴더가 '상위 따름'이면 위로 — 맨 위는 공용이면 publicRoot.acl, 개인이면 [](주인만) */
  aclAt(loc) {
    for (const f of this.chain(loc.folderId)) if (f.inherit === false) return f.acl;
    return loc.space === 'public' ? this.data.publicRoot.acl : [];
  }

  /** 그 사람이 자리(폴더·문서함 맨 위)에서 가진 권한 */
  permsAt(user, loc) {
    if (!user) return [];
    if (user.role === 'admin') return [...ALL];
    if (loc.space === 'private' && loc.owner && loc.owner === user.name) return [...ALL];
    const s = new Set(aclPerms(this.aclAt(loc), user, loc.space));
    // 폴더를 만든 사람은 그 폴더 보기·작성·관리(문서를 올린 사람이 그 문서를 관리하듯 — 하위 폴더로 물려주지는 않는다)
    const f = this.folder(loc.folderId);
    if (f && f.createdBy != null && f.createdBy === user.name) for (const p of ['read', 'write', 'manage']) s.add(p);
    return capRole(user, PERMS.filter((p) => s.has(p)));
  }

  /** 그 사람이 문서에 가진 권한(파일 맨 위 설명) */
  docPerms(user, meta) {
    if (!user || !meta) return [];
    // 임시 연습 문서는 본인만 열고 편집한다. 완료 전에는 공유·이동할 수 없다.
    if (meta.tutorialSession) return ownsTutorial(user, meta) ? ['read', 'edit', 'delete'] : [];
    if (user.role === 'admin') return [...ALL];
    const loc = this.locOf(meta);
    if (loc.space === 'private' && loc.owner && loc.owner === user.name) return [...ALL];
    const at = this.permsAt(user, loc);
    const s = new Set(object(meta.access) && Array.isArray(meta.access.acl) ? aclPerms(meta.access.acl, user, loc.space) : at);
    if (at.includes('manage')) { s.add('read'); s.add('manage'); }
    if (meta.createdBy != null && meta.createdBy === user.name) { s.add('read'); s.add('edit'); s.add('manage'); }
    s.delete('write');   // 문서에는 '작성'이 없다(올리기는 폴더 권한)
    return capRole(user, PERMS.filter((p) => s.has(p)));
  }

  canReadDoc(user, meta) { return this.docPerms(user, meta).includes('read'); }

  /**
   * 화면에 보일 폴더 목록: 보기 권한이 있는 폴더 + (공용 문서함이면) 그 위 폴더들(길 찾기용 — perms 빈 배열, nav: true).
   * readableDocs = 이 사람이 볼 수 있는 문서 meta(그 문서가 든 공용 폴더의 위도 길로 넣는다).
   * 관리 권한이 있는 폴더는 acl·실제 목록(effective)도 싣는다
   */
  foldersFor(user, readableDocs = []) {
    const out = new Map();
    const view = (f, perms, nav = false) => {
      const v = { id: f.id, name: f.name, parentId: f.parentId, space: f.space, owner: f.owner, inherit: f.inherit, perms, createdBy: f.createdBy, createdAt: f.createdAt };
      if (nav) v.nav = true;
      // PC 폴더 연결: 비친 폴더 표시(root = 연결한 폴더 자체 — 지우기 대신 연결 끊기)
      if (f.local) v.local = { link: f.local.link, root: f.local.rel === '' };
      if (perms.includes('manage')) { v.acl = f.acl.map((e) => ({ ...e, perms: [...e.perms] })); v.effective = this.aclAt(this.folderLoc(f)).map((e) => ({ ...e, perms: [...e.perms] })); }
      return v;
    };
    const navUp = (id) => {
      for (const f of this.chain(id)) { if (out.has(f.id)) continue; if (f.space !== 'public') break; out.set(f.id, view(f, [], true)); }
    };
    for (const f of this.data.folders) {
      const perms = this.permsAt(user, this.folderLoc(f));
      if (perms.includes('read')) out.set(f.id, view(f, perms));
    }
    for (const v of [...out.values()]) if (v.space === 'public' && v.parentId) navUp(v.parentId);
    for (const m of readableDocs) { const loc = this.locOf(m); if (loc.space === 'public' && loc.folderId) navUp(loc.folderId); }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  /** 공용 문서함 맨 위 정보 { perms, acl? }(관리 권한이 있으면 acl) */
  publicRootFor(user) {
    const perms = this.permsAt(user, { space: 'public', owner: null, folderId: null });
    return { perms, ...(perms.includes('manage') ? { acl: this.data.publicRoot.acl.map((e) => ({ ...e, perms: [...e.perms] })) } : {}) };
  }

  /**
   * 올릴·옮길 자리 정하기: { space, owner?, folderId? } → 자리 { space, owner, folderId }. folderId 가 있으면 그 폴더의 문서함을 따른다.
   * 개인 문서함 맨 위는 owner(없으면 그 사람 자신). 없는 폴더 → 404 NO_FOLDER
   */
  resolveTarget(user, target) {
    const t = object(target) ? target : {};
    if (t.folderId) {
      const f = this.folder(String(t.folderId));
      if (!f) throw fail('NO_FOLDER', `폴더가 없습니다: ${String(t.folderId).slice(0, 40)}`, 404);
      return this.folderLoc(f);
    }
    const space = t.space === 'private' ? 'private' : t.space == null || t.space === 'public' ? 'public' : null;
    if (!space) throw fail('BAD_SPACE', "문서함은 'public'(공용) 또는 'private'(개인)입니다");
    return { space, owner: space === 'private' ? (cleanText(t.owner) || user.name) : null, folderId: null };
  }

  /** 자리에 권한이 있는지 — 없으면 403 FORBIDDEN */
  assertAt(user, loc, perm, message) {
    if (!this.permsAt(user, loc).includes(perm)) throw fail('FORBIDDEN', message, 403);
  }

  _name(name) {
    const n = cleanText(name).replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > NAME_MAX) throw fail('BAD_NAME', `폴더 이름은 1~${NAME_MAX}자로 입력해 주세요`);
    return n;
  }

  _assertUnique(loc, parentId, name, selfId = null) {
    const clash = this.data.folders.some((f) => f.id !== selfId && f.parentId === (parentId || null) && f.space === loc.space && f.owner === loc.owner && f.name === name);
    if (clash) throw fail('NAME_TAKEN', `같은 이름의 폴더가 이미 있습니다: ${name}`, 409);
  }

  _folderOr404(id) {
    const f = this.folder(String(id ?? ''));
    if (!f) throw fail('NO_FOLDER', `폴더가 없습니다: ${String(id ?? '').slice(0, 40)}`, 404);
    return f;
  }

  /** 폴더 만들기 { name, parentId?, space? } — 상위 폴더(또는 문서함 맨 위)의 '작성' 권한. 개인 문서함 맨 위는 주인만 */
  createFolder(user, { name, parentId = null, space = 'public' } = {}) {
    const clean = this._name(name);
    const loc = parentId ? this.folderLoc(this._folderOr404(parentId)) : this.resolveTarget(user, { space, owner: user.name });
    this.assertAt(user, loc, 'write', '이 자리에 폴더를 만들 권한이 없습니다');
    if (parentId && this.chain(parentId).length >= DEPTH_MAX) throw fail('TOO_DEEP', `폴더는 ${DEPTH_MAX}단계까지 만들 수 있습니다`);
    this._assertUnique(loc, parentId, clean);
    // PC 폴더 안이면 PC 에 실제 폴더를 만든다(id 는 그 길에서 정해진다)
    const parent = parentId ? this.folder(parentId) : null;
    const made = parent?.local ? this._hooks().createFolder(parent, clean) : null;
    const now = new Date().toISOString();
    const f = {
      id: made?.id || `f${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`, name: clean, parentId: parentId || null,
      space: loc.space, owner: loc.owner, inherit: true, acl: [], createdBy: user.name, createdAt: now, updatedAt: now,
      ...(made ? { local: made.local } : {}),
    };
    if (made && this.data.folders.some((x) => x.id === f.id)) return this.folder(f.id);   // 그사이 훑기가 먼저 비춰 놓았다
    this.data.folders.push(f);
    this._save();
    return f;
  }

  /** 폴더 이름 바꾸기·옮기기 { name?, parentId? } — 그 폴더의 '관리' 권한(옮기면 새 상위의 '작성'도). 다른 문서함으로는 옮기지 않는다 */
  updateFolder(user, id, { name, parentId } = {}) {
    const f = this._folderOr404(id);
    this.assertAt(user, this.folderLoc(f), 'manage', '이 폴더를 바꿀 권한이 없습니다');
    const nextName = name === undefined ? f.name : this._name(name);
    let nextParent = f.parentId;
    if (parentId !== undefined) {
      nextParent = parentId || null;
      const loc = nextParent ? this.folderLoc(this._folderOr404(nextParent)) : { space: f.space, owner: f.owner, folderId: null };
      if (loc.space !== f.space || loc.owner !== f.owner) throw fail('BAD_MOVE', '폴더는 같은 문서함 안에서만 옮길 수 있습니다');
      if (nextParent && this.chain(nextParent).some((x) => x.id === f.id)) throw fail('BAD_MOVE', '폴더를 자기 안으로 옮길 수 없습니다');
      if (nextParent !== f.parentId) this.assertAt(user, loc, 'write', '옮길 자리에 폴더를 둘 권한이 없습니다');
      const depth = (nextParent ? this.chain(nextParent).length : 0) + this._height(f.id);
      if (depth > DEPTH_MAX) throw fail('TOO_DEEP', `폴더는 ${DEPTH_MAX}단계까지입니다`);
    }
    this._assertUnique({ space: f.space, owner: f.owner }, nextParent, nextName, f.id);
    // PC 폴더 연결: 연결한 폴더 자체는 이름표만 바꾸고(PC 폴더 이름은 그대로) 옮기지 않는다. 그 아래 폴더는 PC 의 실제 폴더를 바꾸거나 옮긴다
    // (같은 연결 안에서만). 보통 폴더를 PC 폴더 안으로, PC 폴더를 밖으로 옮기지는 않는다
    const target = nextParent ? this.folder(nextParent) : null;
    const moved = nextParent !== f.parentId;
    if (f.local) {
      if (f.local.rel === '') {
        if (moved) throw fail('BAD_MOVE', '연결한 PC 폴더는 옮길 수 없습니다(연결을 끊고 다시 연결하세요)');
        f.name = nextName; f.updatedAt = new Date().toISOString();
        this._hooks().renameLink(f, nextName);
        this._save();
        return f;
      }
      if (moved && target?.local?.link !== f.local.link) throw fail('BAD_MOVE', 'PC 폴더는 같은 연결 폴더 안에서만 옮길 수 있습니다');
      if (!moved && nextName === f.name) return f;
      return this._hooks().moveFolder(f, nextName, moved ? target : this.folder(f.parentId));
    }
    if (moved && target?.local) throw fail('BAD_MOVE', '문서함 폴더를 PC 폴더 안으로 옮길 수 없습니다(문서를 옮기세요)');
    f.name = nextName; f.parentId = nextParent; f.updatedAt = new Date().toISOString();
    this._save();
    return f;
  }

  /** PC 폴더 연결 기능(server/local-folders.js) — 꺼져 있는데 비친 폴더가 남아 있으면 바꾸지 못하게 막는다 */
  _hooks() {
    if (!this.localHooks) throw fail('LOCAL_OFF', 'PC 폴더 연결이 꺼져 있어 이 폴더를 바꿀 수 없습니다', 409);
    return this.localHooks;
  }

  /** 폴더 항목을 목록에서 뺀다(PC 폴더 연결 끊기·비친 폴더 정리 — 권한 검사 없음, 부르는 쪽이 한다) */
  dropFolders(ids) {
    const set = new Set(ids);
    const before = this.data.folders.length;
    this.data.folders = this.data.folders.filter((f) => !set.has(f.id));
    if (this.data.folders.length !== before && !this.broken) this._save();
  }

  /** 폴더 아래 깊이(자기 포함) */
  _height(id, seen = new Set()) {
    if (seen.has(id)) return 0; seen.add(id);
    return 1 + Math.max(0, ...this.children(id).map((c) => this._height(c.id, seen)));
  }

  /**
   * 폴더 권한 { inherit?, acl? } — 그 폴더의 '관리' 권한. inherit true = 상위 폴더 따름(acl 은 남겨 두되 쓰지 않음), false = acl 로.
   * 개인 문서함은 '*' 없이 사람만(주인은 언제나 전부라 목록에서 뺀다)
   */
  setFolderAccess(user, id, { inherit, acl } = {}) {
    const f = this._folderOr404(id);
    this.assertAt(user, this.folderLoc(f), 'manage', '이 폴더의 권한을 바꿀 권한이 없습니다');
    if (acl !== undefined) f.acl = normAcl(acl, { strict: true, everyone: f.space === 'public', skip: f.owner });
    if (inherit !== undefined) f.inherit = inherit !== false;
    else if (acl !== undefined) f.inherit = false;
    f.updatedAt = new Date().toISOString();
    this._save();
    return f;
  }

  /** 공용 문서함 맨 위 권한 — 맨 위 '관리' 권한(기본: 관리자만) */
  setPublicRootAccess(user, acl) {
    this.assertAt(user, { space: 'public', owner: null, folderId: null }, 'manage', '공용 문서함 권한은 관리자만 바꿀 수 있습니다');
    this.data.publicRoot.acl = normAcl(acl, { strict: true });
    this._save();
    return this.data.publicRoot;
  }

  /** 폴더 지우기 — '관리' 권한, 비어 있어야(하위 폴더·문서 없음 — 문서 수는 부르는 쪽이 센다, 볼 수 없는 문서도 센다) */
  deleteFolder(user, id, docCount = 0) {
    const f = this._folderOr404(id);
    this.assertAt(user, this.folderLoc(f), 'manage', '이 폴더를 지울 권한이 없습니다');
    if (f.local?.rel === '') throw fail('LOCAL_ROOT', '연결한 PC 폴더는 지우지 않습니다 — [연결 끊기]를 쓰세요(PC 의 파일은 그대로 남습니다)', 409);
    if (this.children(f.id).length || docCount > 0) throw fail('NOT_EMPTY', '폴더가 비어 있어야 지울 수 있습니다(안의 문서·폴더를 먼저 옮기거나 지우세요)', 409);
    // PC 폴더: PC 의 실제 폴더를 지운다(HWPX 가 아닌 파일이 남아 있으면 409 NOT_EMPTY)
    if (f.local) this._hooks().removeFolder(f);
    this.data.folders = this.data.folders.filter((x) => x.id !== f.id);
    this._save();
    return true;
  }
}
