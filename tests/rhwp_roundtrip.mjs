// @rhwp/core(WASM) 를 Node 에서 띄워 "엔진 → rhwp 열기 → rhwp 저장 → 엔진" 왕복이 되는지 본다.
// (브라우저 편집기가 내보낸 HWPX 를 서버 엔진이 다시 읽어 문단 글을 비교·병합할 수 있어야 한다)
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';

globalThis.measureTextWidth = (font, text) => text.length * 10; // 레이아웃용 폭 측정 스텁

const corePath = path.resolve('vendor/rhwp/pkg/rhwp.js');
const mod = await import('file:///' + corePath.replace(/\\/g, '/'));
const wasm = fs.readFileSync(path.resolve('vendor/rhwp/pkg/rhwp_bg.wasm'));
if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });

const file = process.argv[2] || 'tests/out/edited.hwpx';
const bytes = fs.readFileSync(file);
const t0 = Date.now();
const doc = new mod.HwpDocument(new Uint8Array(bytes));
console.log('rhwp 열기', Date.now() - t0, 'ms; sections', doc.getSectionCount(), 'paragraphs(sec0)', doc.getParagraphCount(0));
const n = doc.getParagraphCount(0);
for (let i = 0; i < Math.min(n, 6); i++) console.log(` rhwp p${i} len=${doc.getParagraphLength(0, i)} text=${JSON.stringify(doc.getTextRange(0, i, 0, doc.getParagraphLength(0, i)))}`);
const out = doc.exportHwpx();
fs.writeFileSync(file.replace(/\.hwpx$/, '_rhwp.hwpx'), out);
console.log('rhwp 저장', out.length, 'bytes');
const mine = await HwpxDoc.load(bytes); const re = await HwpxDoc.load(Buffer.from(out));
console.log('엔진 본문 문단 수', mine.paragraphs({ nested: false }).length, '→ rhwp 저장본', re.paragraphs({ nested: false }).length);
for (const [a, b] of mine.paragraphs({ nested: false }).map((p, i) => [p, re.paragraphs({ nested: false })[i]])) {
  if (!b || a.text !== b.text) console.log(' 차이:', JSON.stringify(a.text), '→', JSON.stringify(b && b.text));
}
console.log('rhwp 저장본 메모:', re.memos().map((m) => `${m.id}:${JSON.stringify(m.text)}@${m.ref}`), '변경:', re.changes().length);
