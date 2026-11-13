// HWPX 하나를 엔진으로 읽어 메모·표·변경 추적을 JSON 으로 보여 준다(한글이 다시 저장한 파일 확인용).
// 사용: node tests/inspect_hwpx.mjs <file.hwpx> [--full]
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('사용: node tests/inspect_hwpx.mjs <file.hwpx> [--full]'); process.exit(2); }
const doc = await HwpxDoc.load(fs.readFileSync(file));
const changes = doc.changes();
const byAuthor = {};
for (const c of changes) byAuthor[`${c.author}:${c.type}`] = (byAuthor[`${c.author}:${c.type}`] || 0) + 1;
const out = {
  file,
  sections: doc.sections.length,
  bodyParagraphs: doc.sections.reduce((n, s) => n + s.bodyParas.length, 0),
  tracking: doc.trackingEnabled(),
  memos: doc.memos().map((m) => ({ id: m.id, author: m.author, ref: m.ref, start: m.start, end: m.end, anchor: m.anchorText, text: m.text })),
  tables: doc.tables().map((t) => ({ key: t.key, rows: t.rows, cols: t.cols, caption: t.caption?.text || null, ...(flag === '--full' ? { cells: t.cells.map((c) => c.text) } : { firstRow: t.cells.filter((c) => c.row === 0).map((c) => c.text) }) })),
  changes: changes.length,
  changesByAuthor: byAuthor,
  changeList: changes.map((c) => ({ id: c.id, type: c.type, author: c.author, ref: c.ref, text: c.text })),
};
process.stdout.write(JSON.stringify(out, null, 1));
process.exit(0);
