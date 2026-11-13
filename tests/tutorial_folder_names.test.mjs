import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, root } from './helpers/server.mjs';
import { LEGACY_TUTORIAL_FOLDER_NAME, legacyTutorialFolder } from '../server/tutorial-catalog.js';

test('튜토리얼은 일반 폴더 이름: 생성·이름 변경·하위 폴더·문서·재시작 뒤에도 실제 이름과 ID를 보존한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const folder = await A('/api/folders', { method: 'POST', body: { name: '튜토리얼' } });
    for (const who of ['a', 'b', 'admin']) {
      const visible = (await srv.api(who)('/api/library')).folders.find(f => f.id === folder.id);
      assert.equal(visible?.name, '튜토리얼', `${who}: 빈 폴더도 생성 직후 표시`);
    }
    const duplicate = await A.res('/api/folders', { method: 'POST', body: { name: '튜토리얼' } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, 'NAME_TAKEN');
    const child = await A('/api/folders', { method: 'POST', body: { name: '튜토리얼', parentId: folder.id } });
    const personal = await A('/api/folders', { method: 'POST', body: { name: '튜토리얼', space: 'private' } });
    const doc = await A('/api/docs', { method: 'POST', body: fs.readFileSync(path.join(root, 'server/templates/blank.hwpx')), headers: {
      'x-file-name': encodeURIComponent('00 따라하기 자료.hwpx'), 'x-folder-id': folder.id,
    } });
    assert.equal((await A('/api/library')).docs.find(d => d.id === doc.id)?.title, '00 따라하기 자료', '일반 폴더 문서의 제목·표시를 바꾸지 않는다');
    assert.ok((await A('/api/docs')).some(d => d.id === doc.id));
    await A(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name: '다른 이름' } });
    await A(`/api/folders/${folder.id}`, { method: 'PATCH', body: { name: '튜토리얼' } });
    const before = fs.readFileSync(path.join(srv.dataDir, 'folders.json'));
    await srv.restart();
    assert.deepEqual(fs.readFileSync(path.join(srv.dataDir, 'folders.json')), before, '기존 폴더의 ID·권한·경로를 다시 쓰지 않는다');
    const lib = await A('/api/library');
    for (const id of [folder.id, child.id, personal.id]) assert.equal(lib.folders.find(f => f.id === id)?.name, '튜토리얼');
    assert.equal(lib.folders.find(f => f.id === child.id).parentId, folder.id);
    assert.equal(lib.docs.find(d => d.id === doc.id)?.folderId, folder.id);
    assert.ok(!(await srv.api('b')('/api/library')).folders.some(f => f.id === personal.id));
  } finally { await srv.stop(); }
});

test('내부 폴더명은 튜토리얼hidden 한 곳에서 관리하고 개인 폴더에는 숨김·제목 치환을 적용하지 않는다', async () => {
  assert.equal(LEGACY_TUTORIAL_FOLDER_NAME, '튜토리얼hidden');
  assert.equal(legacyTutorialFolder({ name: '튜토리얼', space: 'public' }), false);
  assert.equal(legacyTutorialFolder({ name: LEGACY_TUTORIAL_FOLDER_NAME, space: 'public' }), true);
  assert.equal(legacyTutorialFolder({ name: '따라하기 설명서', space: 'public' }), true);
  assert.equal(legacyTutorialFolder({ name: LEGACY_TUTORIAL_FOLDER_NAME, space: 'private' }), false);
  const srv = await startServer();
  try {
    const A = srv.api('a'); const Admin = srv.api('admin');
    const internal = await Admin('/api/folders', { method: 'POST', body: { name: LEGACY_TUTORIAL_FOLDER_NAME } });
    assert.ok(!(await A('/api/library')).folders.some(f => f.id === internal.id));
    assert.equal((await Admin('/api/library?includeTutorialTemplates=1')).folders.find(f => f.id === internal.id)?.name, LEGACY_TUTORIAL_FOLDER_NAME);
    const bytes = fs.readFileSync(path.join(root, 'server/templates/blank.hwpx'));
    const upload = (folderId) => A('/api/docs', { method: 'POST', body: bytes, headers: { 'x-file-name': encodeURIComponent('00 따라하기 자료.hwpx'), 'x-folder-id': folderId } });
    const template = await upload(internal.id);
    assert.ok(!(await A('/api/docs')).some(d => d.id === template.id));
    assert.ok((await Admin('/api/library?includeTutorialTemplates=1')).docs.some(d => d.id === template.id));
    const p = (await A(`/api/docs/${template.id}/paragraphs`))[0];
    await A(`/api/docs/${template.id}/memos`, { method: 'POST', body: { ref: p.ref, text: '이전 연습 기록 보존' } });
    const kept = await A('/api/library');
    assert.ok(kept.docs.some(d => d.id === template.id));
    assert.equal(kept.folders.find(f => f.id === internal.id)?.name, '이전 튜토리얼 기록');
    for (const name of [LEGACY_TUTORIAL_FOLDER_NAME, '따라하기 설명서']) {
      const f = await A('/api/folders', { method: 'POST', body: { name, space: 'private' } });
      assert.equal((await A('/api/library')).folders.find(x => x.id === f.id)?.name, name, '개인 빈 폴더도 보존');
      const d = await upload(f.id);
      assert.equal((await A('/api/library')).docs.find(x => x.id === d.id)?.title, '00 따라하기 자료');
      assert.ok((await A('/api/docs')).some(x => x.id === d.id));
    }
  } finally { await srv.stop(); }
});
