import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { fixture, startServer, uploadDoc, watchWs } from './helpers/server.mjs';
import { liveFixture } from './helpers/live-batch.mjs';

test('이력의 HWPX로 교체하면 글이 같아도 서식이 돌아오고 이전 파일을 다시 선택할 수 있다', { timeout: 30000 }, async () => {
  const srv = await startServer({ config: { documents: { defaultEditMode: 'realtime' } }, users: [
    { name: '관리자', role: 'admin' }, { name: '읽기 전용', role: 'viewer' },
  ] });
  const api = srv.api('admin');
  let ws;
  try {
    const original = fs.readFileSync(fixture(path.join('sections', 'base.hwpx')));
    const doc = await uploadDoc(srv.base, srv.tokens.admin, original, '쪽 설정 교체.hwpx');
    const base = `/api/docs/${doc.id}`;
    const tracked = () => api(`${base}/file?kind=tracked`);
    const record = n => api(`${base}/file?kind=version&n=${n}`);
    const replace = n => api(`${base}/versions/${n}/restore`, { method: 'POST' });
    const working = await api(`${base}/file?kind=working`);
    const zip = await JSZip.loadAsync(working);
    const part = 'Contents/section0.xml';
    const xml = await zip.file(part).async('string');
    const wider = xml.replace(/(<hp:pagePr\b[^>]*\bwidth=")(\d+)/, (_, attr, width) => attr + (Number(width) + 1000));
    assert.notEqual(wider, xml);
    zip.file(part, wider);
    const edited = await zip.generateAsync({ type: 'nodebuffer' });
    const paragraphs = await api(`${base}/paragraphs`);
    const saved = await api(`${base}/live?base=1`, { method: 'PUT', body: edited });
    assert.equal(saved.version, 2);
    assert.deepEqual(await api(`${base}/paragraphs`), paragraphs, '쪽 너비만 변경');
    const before = await tracked();
    assert.notDeepEqual(before, original);

    const denied = await srv.api('a').res(`${base}/versions/1/restore`, { method: 'POST' });
    assert.equal(denied.status, 403);
    const missing = await api.res(`${base}/versions/99/restore`, { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.deepEqual(await tracked(), before);
    assert.equal((await api(base)).version, 2);

    ws = watchWs(srv.base, srv.tokens.admin, doc.id);
    await ws.ready;
    const chosen = await record(1);
    const result = await replace(1);
    assert.equal(result.version, 3);
    assert.equal(result.v, 2);
    assert.deepEqual(await tracked(), chosen);
    assert.deepEqual(await record(result.version), chosen);
    assert.deepEqual(await record(2), before);
    assert.deepEqual(await api(`${base}/paragraphs`), paragraphs);
    const changed = await ws.waitFor(m => m.type === 'doc' && m.action === 'changed' && m.version === result.version);
    assert.equal(changed.formatting, true);
    assert.equal(changed.formatVersion, result.version);
    assert.deepEqual(await replace(1), { version: result.version, unchanged: true });

    const badRecord = path.join(srv.dataDir, 'docs', doc.id, 'versions', '99.hwpx');
    fs.writeFileSync(badRecord, '손상된 시험 파일');
    const corrupt = await api.res(`${base}/versions/99/restore`, { method: 'POST' });
    assert.equal(corrupt.status, 400);
    assert.equal(corrupt.data.error, 'BAD_FILE');
    assert.equal((await api(base)).version, result.version);

    for (const query of ['base=2', `base=${result.version}&loaded=2`]) {
      const late = await api.res(`${base}/live?${query}`, { method: 'PUT', body: edited });
      assert.equal(late.status, 409);
      assert.equal(late.data.error, 'FILE_REPLACED');
    }
    assert.deepEqual(await tracked(), chosen);
    assert.equal((await replace(2)).version, 4);
    assert.deepEqual(await tracked(), before);
  } finally {
    ws?.close();
    await srv.stop();
  }
});

test('교체 메타데이터 저장이 실패하면 원래 파일과 이력이 남고 재시도할 수 있다', async t => {
  const source = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));
  const before = fs.readFileSync(fixture(path.join('sections', 'base.hwpx')));
  const user = { name: '시험 관리자', role: 'admin' };
  const { service, store, id, close } = await liveFixture(source);
  try {
    await service.replaceContent(id, before, { by: user.name });
    const meta = store.readMeta(id);
    const save = t.mock.method(store, 'saveMeta', () => { throw new Error('시험용 저장 실패'); });
    const publish = t.mock.method(service.hub, 'broadcast');
    await assert.rejects(service.restoreVersion(id, 1, user), { message: '시험용 저장 실패' });
    assert.deepEqual(store.readMeta(id), meta);
    assert.deepEqual(store.currentBytes(id), before);
    assert.deepEqual(store.versionBytes(id, 1), source);
    assert.equal(store.versionBytes(id, 3), null);
    assert.equal(publish.mock.callCount(), 0);

    save.mock.restore();
    assert.deepEqual(await service.restoreVersion(id, 1, user), { version: 3, v: 3 });
    assert.deepEqual(store.currentBytes(id), source);
    assert.deepEqual(store.versionBytes(id, 2), before);
  } finally {
    close();
  }
});
