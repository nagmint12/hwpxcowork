import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalFiles, assetPath } from '../deploy/local-editor/files.mjs';
import { installLocalHost } from '../deploy/local-editor/host.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-local-files-'));
  const original = path.join(dir, '원본 문서.hwpx'); await fs.writeFile(original, 'original');
  const cleanup = async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); };
  return { dir, original, cleanup };
}
test('선택한 원본만 갱신하고 다른 이름 저장은 원본을 보존한다', async () => {
  const f = await fixture(); const files = new LocalFiles();
  try {
    const handle = await files.grant(f.original);
    await assert.rejects(files.write('unknown', new Uint8Array([1])), /다시 열어/);
    await files.write(handle.id, new TextEncoder().encode('edited'));
    assert.equal(await fs.readFile(f.original, 'utf8'), 'edited');
    const copy = path.join(f.dir, '사본.hwpx'); const next = await files.grant(copy, { creating: true });
    await files.write(next.id, new TextEncoder().encode('copy'));
    assert.equal(await fs.readFile(copy, 'utf8'), 'copy'); assert.equal(await fs.readFile(f.original, 'utf8'), 'edited');
    assert.equal(await files.same(handle.id, next.id), false);
    assert.deepEqual((await fs.readdir(f.dir)).sort(), ['사본.hwpx', '원본 문서.hwpx'].sort());
  } finally { await f.cleanup(); }
});
test('외부 변경·읽기 전용·잘못된 데이터에서 원본을 훼손하지 않는다', async () => {
  const f = await fixture(); const files = new LocalFiles();
  try {
    let handle = await files.grant(f.original);
    await fs.writeFile(f.original, 'external edit changed length');
    await assert.rejects(files.write(handle.id, new Uint8Array([1])), /바뀌었습니다/);
    assert.equal(await fs.readFile(f.original, 'utf8'), 'external edit changed length');
    handle = await files.grant(f.original);
    await assert.rejects(files.write(handle.id, new Uint8Array()), /데이터/);
    await fs.chmod(f.original, 0o444);
    await assert.rejects(files.write(handle.id, new Uint8Array([1])), /읽기 전용/);
    await fs.chmod(f.original, 0o600);
    assert.equal(await fs.readFile(f.original, 'utf8'), 'external edit changed length');
  } finally { await fs.chmod(f.original, 0o600).catch(() => {}); await f.cleanup(); }
});
test('앱 자원 주소가 문서·다른 폴더·외부 주소로 벗어날 수 없다', () => {
  const root = path.resolve('asset-fixture');
  assert.equal(assetPath(root, 'hwpx-local://editor/assets/editor/assets/engine.wasm'), path.join(root, 'assets/engine.wasm'));
  for (const url of ['https://example.com/a', 'hwpx-local://other/assets/editor/a', 'hwpx-local://editor/assets/editor/%2e%2e%2fsecret', 'hwpx-local://editor/assets/editor/%5csecret', 'hwpx-local://editor/config.json']) assert.throws(() => assetPath(root, url));
});
test('원래 편집기의 파일 핸들: 저장 완료 후에만 쓰기가 끝나고, 취소·실패를 전파한다', async () => {
  const f = await fixture(); const files = new LocalFiles(); const handle = await files.grant(f.original);
  const native = { open: async () => handle, saveAs: async () => null, read: id => files.read(id), write: (id, bytes) => files.write(id, bytes), same: (a, b) => files.same(a, b), onOpen: () => {}, ready: async () => null, dirty: () => {} };
  const previous = Object.fromEntries(['hwpxLocal', 'showOpenFilePicker', 'showSaveFilePicker'].map(k => [k, globalThis[k]]));
  try {
    globalThis.hwpxLocal = native;
    installLocalHost({ ready: async () => {}, subscribe: () => {}, isDirty: () => false });
    const [file] = await showOpenFilePicker();
    const writable = await file.createWritable(); await writable.write(new Blob(['serialized document']));
    assert.equal(await fs.readFile(f.original, 'utf8'), 'original');
    await writable.close(); assert.equal(await fs.readFile(f.original, 'utf8'), 'serialized document');
    assert.equal(await (await file.getFile()).text(), 'serialized document');
    await assert.rejects(showSaveFilePicker({ suggestedName: '사본.hwpx' }), { name: 'AbortError' });
    native.write = async () => { throw new Error('disk-full'); };
    const failed = await file.createWritable(); await failed.write(new Blob(['lost'])); await assert.rejects(failed.close(), /disk-full/);
    assert.equal(await fs.readFile(f.original, 'utf8'), 'serialized document');
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } await f.cleanup(); }
});
