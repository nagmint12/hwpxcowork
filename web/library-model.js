// 문서함 화면 모델(docs/LIBRARY_SPEC.md §4) — 순수 함수만(Vue·DOM 없음, tests/library_view.test.mjs). 화면 조각은 web/library.js.
// 자리(loc) = { space: 'public'|'private', owner: 개인 문서함 주인|null, folderId: 폴더 id|null }.
export const PERM_LABELS = Object.freeze({ read: '보기', write: '작성', edit: '편집', delete: '삭제', manage: '관리' });
export const PERM_TIPS = Object.freeze({
  read: '문서를 열어 읽고 메모·AI 요청을 남깁니다',
  write: '이 폴더에 문서를 올리고 하위 폴더를 만듭니다',
  edit: '문서 내용을 고칩니다',
  delete: '문서를 지웁니다',
  manage: '권한·이름을 바꾸고 옮기거나 폴더를 지웁니다',
});
const ALL = ['read', 'write', 'edit', 'delete', 'manage'];
export const PUBLIC_ROOT = Object.freeze({ space: 'public', owner: null, folderId: null });
export const everyoneLabel = (name) => (name === '*' ? '모든 사용자' : name);

/** 자리 → 문자열 열쇠(같은 자리 비교·저장용) */
export const locKey = (loc) => `${loc?.space || 'public'}:${loc?.owner || ''}:${loc?.folderId || ''}`;
/** 열쇠 → 자리 */
export function parseLocKey(key) {
  const [space, owner, folderId] = String(key || '').split(':');
  return { space: space === 'private' ? 'private' : 'public', owner: space === 'private' ? owner || null : null, folderId: folderId || null };
}
export const sameLoc = (a, b) => locKey(a) === locKey(b);
const folderLoc = (f) => ({ space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.id });

/** 문서가 보이는 자리: 문서의 폴더가 목록에 없으면(남의 개인 폴더 — 문서만 공유받음) 그 문서함 맨 위 */
export function docLoc(d, folderIds) {
  const space = d.space === 'private' ? 'private' : 'public';
  return { space, owner: space === 'private' ? d.spaceOwner || d.createdBy || null : null, folderId: d.folderId && folderIds.has(d.folderId) ? d.folderId : null };
}

/** 폴더의 위(부모)가 목록에 없으면 그 문서함 맨 위에 둔다(공유받은 하위 폴더) */
function parentLoc(f, folderIds) {
  return { space: f.space, owner: f.space === 'private' ? f.owner : null, folderId: f.parentId && folderIds.has(f.parentId) ? f.parentId : null };
}

/** 그 자리 바로 아래 폴더(이름 순) */
export function foldersAt(lib, loc) {
  const ids = new Set((lib?.folders || []).map((f) => f.id));
  return (lib?.folders || []).filter((f) => sameLoc(parentLoc(f, ids), loc)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 그 자리 바로 아래 문서(차례는 sortDocs 로) */
export function docsAt(lib, loc) {
  const ids = new Set((lib?.folders || []).map((f) => f.id));
  return (lib?.docs || []).filter((d) => sameLoc(docLoc(d, ids), loc));
}

// ── 문서 정렬(2026-10-31): 열쇠 = '<기준>-<asc|desc>'. 기준 name(제목) · updated(마지막 수정) · created(올린 때) ──
export const SORTS = Object.freeze([
  { key: 'updated-desc', label: '최근 수정순' },
  { key: 'updated-asc', label: '오래된 수정순' },
  { key: 'name-asc', label: '이름순' },
  { key: 'name-desc', label: '이름 역순' },
  { key: 'created-desc', label: '최근 올린순' },
  { key: 'created-asc', label: '먼저 올린순' },
]);
export const DEFAULT_SORT = 'updated-desc';
export const sortOk = (key) => SORTS.some((s) => s.key === key);
const byName = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'ko', { numeric: true, sensitivity: 'base' });
const timeOf = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

/** 문서 목록을 sort 열쇠대로(새 배열). 같으면 제목 → id 순. 올린 때(createdAt)가 없는 옛 문서는 가장 오래된 것으로 */
export function sortDocs(docs, sort = DEFAULT_SORT) {
  const [field, dir] = String(sortOk(sort) ? sort : DEFAULT_SORT).split('-');
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = field === 'name' ? (a, b) => byName(a.title, b.title)
    : (a, b) => timeOf(field === 'created' ? a.createdAt : a.updatedAt) - timeOf(field === 'created' ? b.createdAt : b.updatedAt);
  return [...(docs || [])].sort((a, b) => sign * cmp(a, b) || byName(a.title, b.title) || String(a.id).localeCompare(String(b.id)));
}

/** 폴더 차례: 이름 역순일 때만 거꾸로(그 밖에는 이름순 — 폴더는 늘 문서 위) */
export const sortFolders = (folders, sort = DEFAULT_SORT) => (sort === 'name-desc' ? [...folders].reverse() : folders);

/** 표 머리를 누른 다음 열쇠: 같은 기준이면 방향만 바꾸고, 새 기준이면 이름은 오름·날짜는 최근 먼저 */
export function nextSort(cur, field) {
  const [f, dir] = String(cur || DEFAULT_SORT).split('-');
  if (f === field) return `${field}-${dir === 'asc' ? 'desc' : 'asc'}`;
  return `${field}-${field === 'name' ? 'asc' : 'desc'}`;
}

/** 자리에서 내 권한: 폴더는 서버가 준 perms, 공용 맨 위는 publicRoot.perms, 내 개인 문서함 맨 위는 전부, 남의 개인 문서함 맨 위는 없음 */
export function permsAt(lib, loc, me) {
  if (loc.folderId) return (lib?.folders || []).find((f) => f.id === loc.folderId)?.perms || [];
  if (loc.space === 'public') return lib?.publicRoot?.perms || [];
  if (me?.role === 'admin' || loc.owner === me?.name) return [...ALL];
  return [];
}

/** 문서함 이름 */
export function rootLabel(loc, me) {
  if (loc.space === 'public') return '공용 문서함';
  return loc.owner === me?.name ? '개인 문서함' : `${loc.owner || ''}`;
}

/** 위치 줄: [{ label, loc }] — 문서함 맨 위부터 */
export function crumbs(lib, loc, me) {
  const byId = new Map((lib?.folders || []).map((f) => [f.id, f]));
  const out = []; const seen = new Set();
  for (let f = byId.get(loc.folderId); f && !seen.has(f.id); f = byId.get(f.parentId)) { seen.add(f.id); out.unshift({ label: f.name, loc: folderLoc(f) }); }
  out.unshift({ label: rootLabel(loc, me), loc: { space: loc.space, owner: loc.owner, folderId: null } });
  return out;
}

/** 남의 개인 문서함 중 내게 보이는 것(공유받음 — 관리자는 전부): 주인 이름 순 */
export function sharedOwners(lib, me) {
  const set = new Set();
  for (const f of lib?.folders || []) if (f.space === 'private' && f.owner && f.owner !== me?.name) set.add(f.owner);
  for (const d of lib?.docs || []) if (d.space === 'private' && d.spaceOwner && d.spaceOwner !== me?.name) set.add(d.spaceOwner);
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 자리가 아직 있는가(지운 폴더·사라진 공유를 기억하고 있으면 공용 맨 위로) */
export function locExists(lib, loc, me) {
  if (loc.folderId) return (lib?.folders || []).some((f) => f.id === loc.folderId);
  if (loc.space === 'public') return true;
  return loc.owner === me?.name || sharedOwners(lib, me).includes(loc.owner);
}

/** 권한 표의 칸: 문서는 작성 없음, 개인 문서함은 관리 없음(주인이 관리) */
export function permColumns(kind, space) {
  return ALL.filter((p) => !(kind === 'doc' && p === 'write') && !(space === 'private' && p === 'manage'));
}

/** 권한 하나 켜고 끄기: 보기를 끄면 전부 끄고, 무엇이든 켜면 보기도 켠다 */
export function togglePerm(perms, p, on) {
  if (!on) return p === 'read' ? [] : perms.filter((x) => x !== p);
  return ALL.filter((x) => x === p || x === 'read' || perms.includes(x));
}

/** 문서 권한 꼬리표: 이 문서만 따로 정함 · (찾기 결과에서) 내 개인 문서함 */
export function docBadge(d, me, { searching = false } = {}) {
  if (d.access?.custom) return { icon: 'people', text: '따로', title: d.access.acl ? `이 문서만 따로: ${d.access.acl.map((e) => `${everyoneLabel(e.name)}(${e.perms.map((p) => PERM_LABELS[p]).join('·')})`).join(', ') || '나만'}` : '이 문서만 따로 정한 권한' };
  if (searching && d.space === 'private' && d.spaceOwner === me?.name) return { icon: 'lock', text: '', title: '개인 문서함 — 나와 공유한 사람만' };
  return null;
}

/** 옮길 수 있는 자리(작성 권한): [{ loc, label, depth }]. folder 를 주면 같은 문서함 안에서 그 폴더와 그 아래는 뺀다 */
export function moveTargets(lib, me, folder = null) {
  const out = [];
  const roots = [PUBLIC_ROOT, { space: 'private', owner: me?.name, folderId: null }, ...sharedOwners(lib, me).map((o) => ({ space: 'private', owner: o, folderId: null }))];
  const banned = new Set();
  if (folder) {
    const stack = [folder.id];
    while (stack.length) { const id = stack.pop(); banned.add(id); for (const f of lib?.folders || []) if (f.parentId === id) stack.push(f.id); }
  }
  const walk = (loc, depth) => {
    for (const f of foldersAt(lib, loc)) {
      if (banned.has(f.id)) continue;
      const fl = folderLoc(f);
      if (permsAt(lib, fl, me).includes('write')) out.push({ loc: fl, label: f.name, depth });
      walk(fl, depth + 1);
    }
  };
  for (const r of roots) {
    if (folder && (r.space !== folder.space || (r.owner || null) !== (folder.space === 'private' ? folder.owner : null))) continue;
    if (permsAt(lib, r, me).includes('write')) out.push({ loc: r, label: rootLabel(r, me), depth: 0, root: true });
    walk(r, 1);
  }
  return out;
}
