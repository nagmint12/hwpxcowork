import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { HwpxContainer } from '../engine/container.js';

const require = createRequire(import.meta.url);
const pako = require('pako');
const image = Uint8Array.from({ length: 128 * 1024 }, (_, i) => (i * 19 + (i >> 7)) % 256);

async function fixture() {
  const zip = new JSZip();
  // 입력 순서와 압축 수준을 다르게 하여 저장의 순서 보정/원래 압축 스트림 재사용을 확인한다.
  zip.file('BinData/image1.bmp', image);
  zip.file('Contents/section0.xml', '<section>가나다</section>');
  zip.file('version.xml', '<version/>', { compression: 'DEFLATE' });
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}

function localEntries(buffer) {
  const entries = new Map(); let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const method = buffer.readUInt16LE(at + 8);
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
    const start = at + 30 + nameLength + extraLength;
    entries.set(name, { method, data: buffer.subarray(start, start + size) });
    at = start + size;
  }
  return entries;
}

async function countDeflates(action) {
  const original = pako.Deflate; let count = 0;
  pako.Deflate = function (...args) { count++; return new original(...args); };
  try { return { result: await action(), count }; }
  finally { pako.Deflate = original; }
}

test('한 글자 수정은 XML만 압축하고 원래 이진 압축 스트림을 재사용하며 다음 저장도 정확하다', async () => {
  const original = await fixture();
  const container = await HwpxContainer.load(original);
  container.setText('Contents/section0.xml', '<section>가나다라</section>');
  const first = await countDeflates(() => container.save());
  assert.equal(first.count, 1, '변경 XML 하나만 DEFLATE');
  const entries = localEntries(first.result);
  assert.deepEqual([...entries.keys()].slice(0, 2), ['mimetype', 'version.xml']);
  assert.equal(entries.get('mimetype').method, 0);
  assert.equal(entries.get('version.xml').method, 0);
  assert.deepEqual(entries.get('BinData/image1.bmp').data, localEntries(original).get('BinData/image1.bmp').data);
  assert.deepEqual([...entries.keys()].filter(n => !n.endsWith('/')), ['mimetype', 'version.xml', 'BinData/image1.bmp', 'Contents/section0.xml']);
  const reopened = await HwpxContainer.load(first.result);
  assert.equal(reopened.getText('Contents/section0.xml'), '<section>가나다라</section>');
  assert.deepEqual(reopened.getBytes('BinData/image1.bmp'), image);

  container.setText('Contents/section0.xml', '<section>가나다라</section>');
  assert.equal((await countDeflates(() => container.save())).count, 0, '동일 내용의 setText도 재압축하지 않음');
  container.setText('Contents/section0.xml', '<section>가나다라마</section>');
  const second = await countDeflates(() => container.save());
  assert.equal(second.count, 1);
  assert.equal((await HwpxContainer.load(second.result)).getText('Contents/section0.xml'), '<section>가나다라마</section>');
});

test('setBytes, 직접 Map 쓰기, 제자리 배열 변경, 제거/재추가를 모두 저장한다', async () => {
  const container = await HwpxContainer.load(await fixture());
  container.setBytes('BinData/image1.bmp', Buffer.from([10, 20, 30]));
  let saved = await countDeflates(() => container.save());
  assert.equal(saved.count, 1);
  assert.deepEqual((await HwpxContainer.load(saved.result)).getBytes('BinData/image1.bmp'), new Uint8Array([10, 20, 30]));

  container.getBytes('BinData/image1.bmp')[1] = 99;
  container.files.set('BinData/direct.bin', new Uint8Array([4, 5, 6]));
  saved = await countDeflates(() => container.save());
  assert.equal(saved.count, 2, '직접 수정한 두 파일만 압축');
  let reopened = await HwpxContainer.load(saved.result);
  assert.deepEqual(reopened.getBytes('BinData/image1.bmp'), new Uint8Array([10, 99, 30]));
  assert.deepEqual(reopened.getBytes('BinData/direct.bin'), new Uint8Array([4, 5, 6]));

  container.files.get('BinData/direct.bin')[0] = 9;
  container.files.delete('BinData/image1.bmp');
  saved = await countDeflates(() => container.save());
  assert.equal(saved.count, 1);
  reopened = await HwpxContainer.load(saved.result);
  assert.equal(reopened.has('BinData/image1.bmp'), false);
  assert.deepEqual(reopened.getBytes('BinData/direct.bin'), new Uint8Array([9, 5, 6]));
  container.remove('BinData/direct.bin');
  container.setBytes('BinData/image1.bmp', new Uint8Array([7, 8]));
  container.setBytes('BinData/empty.bin', new Uint8Array(0));
  saved = await countDeflates(() => container.save());
  assert.equal(saved.count, 1);
  reopened = await HwpxContainer.load(saved.result);
  assert.equal(reopened.has('BinData/direct.bin'), false);
  assert.deepEqual(reopened.getBytes('BinData/image1.bmp'), new Uint8Array([7, 8]));
  assert.equal(reopened.getBytes('BinData/empty.bin').length, 0);
  assert.equal((await countDeflates(() => container.save())).count, 0);
});

test('입출력 버퍼 및 저장 중 변경은 이후 저장의 압축 캐시를 오염시키지 않는다', async () => {
  const input = await fixture();
  const container = await HwpxContainer.load(input);
  input.fill(0);
  let output = await container.save();
  assert.deepEqual((await HwpxContainer.load(output)).getBytes('BinData/image1.bmp'), image);
  output.fill(0);
  output = await container.save();
  assert.deepEqual((await HwpxContainer.load(output)).getBytes('BinData/image1.bmp'), image);

  const replacement = Buffer.from([1, 2, 3]);
  container.setBytes('BinData/image1.bmp', replacement);
  const pending = container.save();
  replacement[0] = 8;
  const snapshot = await HwpxContainer.load(await pending);
  assert.deepEqual(snapshot.getBytes('BinData/image1.bmp'), new Uint8Array([1, 2, 3]));
  const latest = await HwpxContainer.load(await container.save());
  assert.deepEqual(latest.getBytes('BinData/image1.bmp'), new Uint8Array([8, 2, 3]));
});

test('Map으로 직접 생성한 컨테이너도 반복 저장과 전체 삭제가 가능하다', async () => {
  const container = new HwpxContainer(new Map([['mimetype', new TextEncoder().encode('application/hwp+zip')], ['Contents/section0.xml', new Uint8Array([1, 2])]]), ['mimetype', 'Contents/section0.xml']);
  assert.equal((await countDeflates(() => container.save())).count, 1);
  assert.equal((await countDeflates(() => container.save())).count, 0);
  container.files.clear();
  assert.equal((await HwpxContainer.load(await container.save())).files.size, 0);
});
