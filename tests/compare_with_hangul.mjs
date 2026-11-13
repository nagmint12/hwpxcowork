// 엔진이 만든 HWPX 를 한글이 읽은 결과(result.json)와 비교한다.
// 사용: node tests/compare_with_hangul.mjs <file.hwpx> <result.json> [saved.hwpx]
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';

const [file, resultPath, savedPath] = process.argv.slice(2);
const res = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
const doc = await HwpxDoc.load(fs.readFileSync(file));
const norm = (s) => (s || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/g, '')).filter((l) => l.trim() !== '').join('\n');
const mine = norm(doc.paragraphs({ nested: false }).map((p) => p.text).join('\n'));
const hangul = norm(res.text_final);
const flat = await doc.flattened();
// 한글 GetTextFile 은 메모 필드 경계에서 줄을 나누므로 줄바꿈·공백을 뺀 비교도 함께 본다
const squash = (s) => s.replace(/\s+/g, '').replace(/&#\d+;/g, '');
console.log('pages(한글):', res.pages, 'open:', res.open, 'is_track_change:', res.is_track_change);
console.log('최종본 텍스트 일치:', mine === hangul, '(줄바꿈 무시:', squash(mine) === squash(hangul) + ')');
if (res.text_after_apply != null) console.log('모두 적용 후 일치(줄바꿈 무시):', squash(norm(flat.paragraphs({ nested: false }).map((p) => p.text).join('\n'))) === squash(norm(res.text_after_apply)));
if (mine !== hangul && squash(mine) !== squash(hangul)) {
  const a = mine.split('\n'); const b = hangul.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log(` 줄 ${i}:\n  엔진: ${JSON.stringify(a[i])}\n  한글: ${JSON.stringify(b[i])}`); }
}
if (res.text_after_apply != null) {
  const mineAfter = norm(flat.paragraphs({ nested: false }).map((p) => p.text).join('\n'));
  console.log('모두 적용 후 텍스트 일치:', mineAfter === norm(res.text_after_apply));
}
if (savedPath && fs.existsSync(savedPath)) {
  const saved = await HwpxDoc.load(fs.readFileSync(savedPath));
  console.log('한글이 다시 저장한 파일: memos=', saved.memos().map((m) => `${m.id}:${m.author}:${JSON.stringify(m.text)}@${m.ref}[${m.start},${m.end})`), 'changes=', saved.changes().length, 'authors=', saved.authors().map((a) => a.name));
}
