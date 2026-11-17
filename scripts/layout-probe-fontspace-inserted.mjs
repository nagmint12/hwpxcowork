// [hwpx-cowork] 2026-11-16 '끼운 문단 뒤 복원 구간' 시험지 — fontspace 시험지를 한/글 2022 가 다시 저장한 판(모든 문단에
// 한/글 줄 정보가 있다)에서 맨 앞 문단의 linesegarray 만 뺀다(편집기·AI 가 저장 줄 없이 끼운 문단과 같은 꼴).
// 엔진은 그 뒤 한/글 저장 문단에 합성 표시를 붙이는데(세로 좌표만 근거에서 뺌), 줄 나눔(textpos)은 한/글 것이라
// 그대로 써야 한다 — 기대값은 한/글 저장 textpos(= fontspace_hangul.json). 글은 지어낸 것(가·나 반복)이다.
//
//   node scripts/layout-probe-fontspace-inserted.mjs <한/글 재저장 saved.hwpx>
//     → tests/fixtures/layout/fontspace-20261116/fontspace_saved_inserted.hwpx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tests/fixtures/layout/fontspace-20261116/fontspace_saved_inserted.hwpx');
const src = process.argv[2];
if (!src) throw new Error('한/글이 다시 저장한 fontspace saved.hwpx 경로가 필요합니다');
const zip = await JSZip.loadAsync(fs.readFileSync(src));
const name = 'Contents/section0.xml';
const xml = await zip.file(name).async('string');
// 첫 최상위 문단의 (그 문단 자신의) linesegarray 하나를 뺀다 — 첫 문단에는 중첩 문단이 없다.
const firstEnd = xml.indexOf('</hp:p>');
const head = xml.slice(0, firstEnd);
const at = head.lastIndexOf('<hp:linesegarray>');
if (at < 0 || head.indexOf('<hp:p ', head.indexOf('<hp:p ') + 1) >= 0) throw new Error('첫 문단 꼴이 예상과 다르다');
const close = xml.indexOf('</hp:linesegarray>', at) + '</hp:linesegarray>'.length;
zip.file(name, xml.slice(0, at) + xml.slice(close));
fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/hwp+zip' }));
console.log('→', path.relative(root, out));
