// 한/글이 다시 저장한 파일을 우리 엔진으로 읽어 본문·추적 옵션·새 수정 이력을 검증한다.
// node tests/tutorial_tracking_roundtrip.mjs <API 출력 폴더> <한글 결과 폴더>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
const [source, dest] = process.argv.slice(2);
const evidence = JSON.parse(fs.readFileSync(path.join(dest, 'hangul-evidence.json'), 'utf8'));
assert.equal(evidence.passed, true);
const text = (d, view = 'final') => d.paragraphs({ view, nested: true }).map(p => p.text);
const rows = [];
for (const row of evidence.cases) {
  const stem = path.basename(row.file, '.hwpx');
  const before = await HwpxDoc.load(fs.readFileSync(path.join(source, row.file)));
  const after = await HwpxDoc.load(fs.readFileSync(path.join(dest, `${stem}-roundtrip.hwpx`)));
  // 한/글은 비어 있는 누름틀의 안내문을 저장 시 본문으로 구체화한다(3번 원본에 들어 있는 필드).
  // 그 알려진 한 항목만 별도 기록하고, 나머지 모든 본문은 글자 단위로 비교한다.
  const prompt = '여기를 눌러 이름을 적으세요';
  const materialized = row.file.startsWith('3-') && !text(before).some(p => p.includes(prompt)) && text(after).some(p => p.includes(prompt));
  if (materialized) assert.ok(before.sections.some(s => s.xml.includes(prompt)), '원본 누름틀에 있던 안내문만 허용');
  assert.deepEqual(text(after).map(p => materialized ? p.replace(prompt, '') : p), text(before), `${stem}: 한글 왕복 본문 보존`);
  assert.deepEqual(text(after, 'original').map(p => materialized ? p.replace(prompt, '') : p), text(before, 'original'), `${stem}: 원본 보기 보존`);
  // 한/글은 문단 글 삽입 + 문단 나눔 삽입을 한 항목으로 묶을 수 있다(심화 70 → 62).
  // 번호/개수 대신 모든 변경의 종류·작성자·내용이 남았는지 비교한다.
  for (const c of before.changes().filter(c => c.text)) {
    assert.ok(after.changes().some(x => x.type === c.type && x.author === c.author && x.text === c.text), `${stem}: 변경 내용 보존 ${c.id}`);
  }
  for (const m of before.memos()) assert.ok(after.memos().some(x => x.text === m.text && x.author === m.author), `${stem}: 메모 보존`);
  assert.equal(after.header.trackingEnabled(), true);
  const edited = await HwpxDoc.load(fs.readFileSync(path.join(dest, `${stem}-native-edit.hwpx`)));
  assert.ok(edited.changes().some(c => c.type === 'Insert' && String(c.text).includes('한글실제추적검증')), `${stem}: 한글 입력이 실제 삽입 이력`);
  assert.ok(text(edited).some(p => p.includes('한글실제추적검증')));
  assert.ok(!text(edited, 'original').some(p => p.includes('한글실제추적검증')), `${stem}: 원본에는 새 입력이 없음`);
  assert.equal(edited.header.trackingEnabled(), true);
  rows.push({ file: row.file, bodyPreserved: true, originalViewPreserved: true, changeContentsPreserved: true, memosPreserved: true, fieldPromptMaterialized: materialized, changesBefore: before.changes().length, changesAfter: after.changes().length, nativeEditTracked: true });
  console.log(`PASS ${stem}: body preserved, native edit tracked`);
}
fs.writeFileSync(path.join(dest, 'engine-evidence.json'), JSON.stringify({ passed: true, cases: rows }, null, 2));
