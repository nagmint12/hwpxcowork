// 문서함 화면 모델(web/library-model.js — docs/LIBRARY_SPEC.md §4): 자리 열쇠·폴더/문서 배치·위치 줄·권한·옮길 자리·꼬리표
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  locKey, parseLocKey, foldersAt, docsAt, permsAt, crumbs, sharedOwners, locExists, permColumns, togglePerm, moveTargets, docBadge, docLoc, PUBLIC_ROOT,
} from '../web/library-model.js';

const me = { name: '홍길동', role: 'editor' };
const lib = {
  publicRoot: { perms: ['read', 'write', 'edit'] },
  folders: [
    { id: 'f1aaaaaa', name: '기획', parentId: null, space: 'public', owner: null, perms: ['read', 'write'] },
    { id: 'f2aaaaaa', name: '2026', parentId: 'f1aaaaaa', space: 'public', owner: null, perms: ['read'] },
    { id: 'f3aaaaaa', name: '초안', parentId: null, space: 'private', owner: '홍길동', perms: ['read', 'write', 'edit', 'delete', 'manage'] },
    // 김검토의 개인 폴더 중 하위만 공유받음(위 폴더는 목록에 없음) → 김검토 문서함 맨 위에 보인다
    { id: 'f4aaaaaa', name: '공유된 하위', parentId: 'f9zzzzzz', space: 'private', owner: '김검토', perms: ['read'] },
  ],
  docs: [
    { id: 'd1', title: '안내', space: 'public', spaceOwner: null, folderId: null, perms: ['read'] },
    { id: 'd2', title: '계획', space: 'public', spaceOwner: null, folderId: 'f1aaaaaa', perms: ['read'] },
    { id: 'd3', title: '메모', space: 'private', spaceOwner: '홍길동', folderId: null, perms: ['read', 'manage'], access: { custom: false } },
    // 김검토 개인 폴더(목록에 없음) 안 문서를 문서만 공유받음 → 김검토 문서함 맨 위
    { id: 'd4', title: '의견', space: 'private', spaceOwner: '김검토', folderId: 'f8zzzzzz', perms: ['read'], access: { custom: true } },
  ],
};
const mine = { space: 'private', owner: '홍길동', folderId: null };
const kim = { space: 'private', owner: '김검토', folderId: null };

test('자리 열쇠는 오가며 같다(공용은 주인 없음)', () => {
  for (const loc of [PUBLIC_ROOT, mine, { space: 'public', owner: null, folderId: 'f1aaaaaa' }]) assert.deepEqual(parseLocKey(locKey(loc)), loc);
  assert.deepEqual(parseLocKey('public:누구:'), PUBLIC_ROOT);
  assert.deepEqual(parseLocKey(''), PUBLIC_ROOT);
});

test('폴더·문서 배치: 위 폴더가 안 보이면 그 문서함 맨 위에', () => {
  assert.deepEqual(foldersAt(lib, PUBLIC_ROOT).map((f) => f.id), ['f1aaaaaa']);
  assert.deepEqual(foldersAt(lib, { space: 'public', owner: null, folderId: 'f1aaaaaa' }).map((f) => f.id), ['f2aaaaaa']);
  assert.deepEqual(foldersAt(lib, kim).map((f) => f.id), ['f4aaaaaa']);
  assert.deepEqual(docsAt(lib, PUBLIC_ROOT).map((d) => d.id), ['d1']);
  assert.deepEqual(docsAt(lib, mine).map((d) => d.id), ['d3']);
  assert.deepEqual(docsAt(lib, kim).map((d) => d.id), ['d4']);
  assert.deepEqual(docLoc(lib.docs[3], new Set(lib.folders.map((f) => f.id))), kim);
});

test('권한: 폴더는 서버 값, 공용 맨 위는 publicRoot, 내 개인 맨 위는 전부, 남의 개인 맨 위는 없음(관리자는 전부)', () => {
  assert.deepEqual(permsAt(lib, PUBLIC_ROOT, me), ['read', 'write', 'edit']);
  assert.deepEqual(permsAt(lib, { space: 'public', owner: null, folderId: 'f2aaaaaa' }, me), ['read']);
  assert.equal(permsAt(lib, mine, me).length, 5);
  assert.deepEqual(permsAt(lib, kim, me), []);
  assert.equal(permsAt(lib, kim, { name: '관리자', role: 'admin' }).length, 5);
});

test('위치 줄 · 공유받은 문서함 · 자리가 남아 있는가', () => {
  assert.deepEqual(crumbs(lib, { space: 'public', owner: null, folderId: 'f2aaaaaa' }, me).map((c) => c.label), ['공용 문서함', '기획', '2026']);
  assert.deepEqual(crumbs(lib, mine, me).map((c) => c.label), ['개인 문서함']);
  assert.deepEqual(crumbs(lib, kim, me).map((c) => c.label), ['김검토']);
  assert.deepEqual(sharedOwners(lib, me), ['김검토']);
  assert.ok(locExists(lib, kim, me) && locExists(lib, mine, me));
  assert.ok(!locExists(lib, { space: 'private', owner: '아무개', folderId: null }, me));
  assert.ok(!locExists(lib, { space: 'public', owner: null, folderId: 'f0gone00' }, me));
});

test('권한 표: 문서는 작성 없음, 개인은 관리 없음 · 켜고 끄기는 보기와 묶임', () => {
  assert.deepEqual(permColumns('folder', 'public'), ['read', 'write', 'edit', 'delete', 'manage']);
  assert.deepEqual(permColumns('doc', 'public'), ['read', 'edit', 'delete', 'manage']);
  assert.deepEqual(permColumns('doc', 'private'), ['read', 'edit', 'delete']);
  assert.deepEqual(togglePerm([], 'edit', true), ['read', 'edit']);
  assert.deepEqual(togglePerm(['read', 'edit'], 'read', false), []);
  assert.deepEqual(togglePerm(['read', 'edit', 'delete'], 'edit', false), ['read', 'delete']);
});

test('옮길 자리: 작성 권한이 있는 곳만, 폴더는 같은 문서함에서 자기와 그 아래 빼고', () => {
  const t = moveTargets(lib, me).map((x) => x.label);
  assert.deepEqual(t, ['공용 문서함', '기획', '개인 문서함', '초안']);   // 2026(보기만)·김검토 문서함(권한 없음) 빠짐
  const ft = moveTargets(lib, me, lib.folders[0]).map((x) => x.label);
  assert.deepEqual(ft, ['공용 문서함']);   // 기획 자신·그 아래 2026 빠짐, 개인 문서함은 다른 문서함
});

test('꼬리표: 따로 정한 문서, 찾기 결과의 내 개인 문서', () => {
  assert.equal(docBadge(lib.docs[3], me).text, '따로');
  assert.equal(docBadge(lib.docs[2], me), null);
  assert.equal(docBadge(lib.docs[2], me, { searching: true }).icon, 'lock');
  assert.equal(docBadge(lib.docs[0], me, { searching: true }), null);
});

test('문서 정렬: 이름(숫자 붙은 제목도 사람 순서)·마지막 수정·올린 때, 머리 누르기는 방향만 바꿈', async () => {
  const { sortDocs, sortFolders, nextSort, sortOk, DEFAULT_SORT } = await import('../web/library-model.js');
  const docs = [
    { id: 'a', title: '10 보고서', updatedAt: '2026-10-30T01:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', title: '2 계획', updatedAt: '2026-10-31T01:00:00Z', createdAt: '2026-10-20T00:00:00Z' },
    { id: 'c', title: '가 안내', updatedAt: '2026-10-29T01:00:00Z' },   // 올린 때 없음(옛 문서) → 가장 오래된 것으로
  ];
  const ids = (s) => sortDocs(docs, s).map((d) => d.id).join('');
  assert.equal(ids('updated-desc'), 'bac');
  assert.equal(ids('updated-asc'), 'cab');
  assert.equal(ids('name-asc'), 'bac', '2 < 10 < 가(숫자는 크기 순)');
  assert.equal(ids('name-desc'), 'cab');
  assert.equal(ids('created-desc'), 'bac');
  assert.equal(ids('created-asc'), 'cab');
  assert.equal(ids('엉뚱한값'), ids(DEFAULT_SORT));
  assert.equal(docs.map((d) => d.id).join(''), 'abc', '원래 배열은 그대로');
  assert.deepEqual([nextSort('updated-desc', 'updated'), nextSort('updated-asc', 'name'), nextSort('name-asc', 'name'), nextSort('name-desc', 'updated')], ['updated-asc', 'name-asc', 'name-desc', 'updated-desc']);
  assert.deepEqual(sortFolders([{ id: 1 }, { id: 2 }], 'name-desc').map((f) => f.id), [2, 1]);
  assert.deepEqual(sortFolders([{ id: 1 }, { id: 2 }], 'created-asc').map((f) => f.id), [1, 2]);
  assert.equal(sortOk('name-asc') && !sortOk('size-asc'), true);
});
