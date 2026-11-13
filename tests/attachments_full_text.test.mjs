// 원본/설정은 임시 폴더만 사용한다. 외부 API나 실제 data/config에 접근하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Attachments, extractText } from '../server/attachments.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-full-attachment-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  // 예전 자동 설정값이 남아 있어도 새 업로드나 기본 조회를 자르지 않는다.
  return new Attachments({ docsDir: root, cfg: { attachments: { maxTextChars: 200000 } } });
}
const source = '문서근거\n'.repeat(45000) + '마지막근거보존';

test('큰 신규 첨부는 전체 추출·캐시·기본 조회, 명시적 max에만 truncated 표시', async t => {
  const attachments = fixture(t), bytes = Buffer.from(source);
  const entry = await attachments.save('doc', 'a1', '큰근거.txt', bytes);
  assert.ok(source.length > 200000); assert.deepEqual(entry.text, { chars: source.length, truncated: false });
  assert.equal(fs.readFileSync(attachments.textPath('doc', entry), 'utf8'), source);
  assert.deepEqual(attachments.readText('doc', entry), { text: source, truncated: false });
  assert.deepEqual(await attachments.fullText('doc', entry), { text: source, truncated: false });
  assert.deepEqual(attachments.readText('doc', entry, 35), { text: source.slice(0, 35), truncated: true });
  assert.equal(attachments.readText('doc', entry, source.length + 100).truncated, false);
  assert.deepEqual(attachments.bytes('doc', entry), bytes);
});

test('과거 20만자에서 잘린 캐시는 원본으로 복원하며 원본·캐시·entry를 변경하지 않음', async t => {
  const attachments = fixture(t), bytes = Buffer.from(source);
  const entry = await attachments.save('doc', 'a1', '옛근거.txt', bytes);
  const old = source.slice(0, 200000);
  fs.writeFileSync(attachments.textPath('doc', entry), old);
  entry.text = { chars: old.length, truncated: true };
  const before = structuredClone(entry), files = fs.readdirSync(attachments.dir('doc'));
  assert.equal(attachments.readText('doc', entry).truncated, true, '동기 캐시 조회는 과거 생략 사실을 숨기지 않음');
  assert.deepEqual(await attachments.fullText('doc', entry), { text: source, truncated: false });
  assert.deepEqual(entry, before); assert.deepEqual(fs.readdirSync(attachments.dir('doc')), files);
  assert.equal(fs.readFileSync(attachments.textPath('doc', entry), 'utf8'), old);
  assert.deepEqual(attachments.bytes('doc', entry), bytes);
});

test('CSV 신규·과거 캐시 모두 마지막 행과 전체 sheets 정보를 유지', async t => {
  const attachments = fixture(t), csv = '항목,근거\n' + Array.from({ length: 18000 }, (_, n) => `${n},긴근거문자열`).join('\n') + '\n끝행,최종근거';
  const entry = await attachments.save('doc', 'sheet1', '큰자료.csv', Buffer.from(csv));
  assert.ok(entry.text.chars > 200000); assert.equal(entry.text.truncated, false);
  const complete = await attachments.fullText('doc', entry);
  assert.match(complete.text, /끝행\t최종근거$/); assert.deepEqual(complete.sheets, [{ name: '큰자료', rows: 18002, cols: 2 }]);
  fs.writeFileSync(attachments.textPath('doc', entry), complete.text.slice(0, 200000));
  entry.text = { ...entry.text, chars: 200000, truncated: true };
  assert.deepEqual(await attachments.fullText('doc', entry), complete);
});

test('추출 기본은 전체, max 명시만 자르고 missing 캐시는 원본에서 읽음', async t => {
  assert.deepEqual(await extractText(Buffer.from(source), '.txt'), { text: source, truncated: false });
  assert.deepEqual(await extractText(Buffer.from(source), '.txt', { maxChars: 10 }), { text: source.slice(0, 10), truncated: true });
  const attachments = fixture(t), entry = await attachments.save('doc', 'a1', '근거.txt', Buffer.from(source));
  fs.unlinkSync(attachments.textPath('doc', entry));
  assert.deepEqual(await attachments.fullText('doc', entry), { text: source, truncated: false });
  fs.unlinkSync(attachments.filePath('doc', entry));
  const failed = await attachments.fullText('doc', entry);
  assert.equal(failed.text, null); assert.match(failed.error, /글을 뽑지 못했습니다/);
});
