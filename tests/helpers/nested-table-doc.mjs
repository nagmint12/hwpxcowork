// 시험 받침: 표 안의 표 안의 표 안의 표(4단) — 병합 칸이 있고 모든 칸이 빈칸인 서식(글은 지어낸 제목 한 줄뿐). 2026-11-20 v3 TSV 검증(docs/MCP_REDESIGN_2026-11-16.md §22).
//   T0 s0/p2#t0 5×3 : 병합 r0c0:r0c2, r1c0:r2c0
//     T1 s0/p2/n2#t0 3×3 (T0 r1c1 안) : 병합 r0c0:r0c1
//       T2 s0/p2/n2/n4#t0 2×2 (T1 r1c2 안) : 병합 r1c0:r1c1
//         T3 s0/p2/n2/n4/n1#t0 2×3 (T2 r0c1 안) : 병합 r0c1:r1c1
//     T1b s0/p2/n8#t0 2×2 (T0 r3c2 안)
// 같은 문서를 만드는 실험 도구: artifacts/mcp-tsv-nested-20261120/tools/make-docs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NESTED = { T0: 's0/p2#t0', T1: 's0/p2/n2#t0', T2: 's0/p2/n2/n4#t0', T3: 's0/p2/n2/n4/n1#t0', T1b: 's0/p2/n8#t0' };

const blank = () => HwpxDoc.load(fs.readFileSync(path.join(root, 'server', 'templates', 'blank.hwpx')));
const cellOf = (doc, key, row, col) => doc.tables().find((t) => t.key === key).cells.find((c) => c.row === row && c.col === col);
function setCellParagraphs(doc, key, row, col, xml) {
  const cell = cellOf(doc, key, row, col);
  const a = doc.resolve(cell.refs[0]); const b = doc.resolve(cell.refs[cell.refs.length - 1]);
  a.sec.load(a.sec.xml.slice(0, a.p.start) + xml + a.sec.xml.slice(b.p.end));
}
function putTableInCell(doc, key, row, col, innerXml) {
  const cell = cellOf(doc, key, row, col); const r = doc.resolve(cell.refs[0]);
  const x = r.sec.xml.slice(r.p.start, r.p.end);
  const head = /^<hp:p\b[^>]*>/.exec(x)[0]; const char = (/charPrIDRef="(\d+)"/.exec(x) || [])[1] || '0';
  const tc = r.sec.xml.lastIndexOf('<hp:tc ', r.p.start); const tail = r.sec.xml.slice(tc, r.sec.xml.indexOf('</hp:tc>', tc));
  const w = Number((/<hp:cellSz width="(\d+)"/.exec(tail) || [])[1] || 20000) - 1020;
  const k = w / Number(/<hp:sz width="(\d+)"/.exec(innerXml)[1]);
  const fitted = innerXml.replace(/(<hp:pos\b[^>]*\streatAsChar=")0(")/, '$11$2').replace(/<hp:sz width="\d+"/, `<hp:sz width="${Math.round(w)}"`)
    .replace(/<hp:cellSz width="(\d+)"/g, (m, v) => `<hp:cellSz width="${Math.max(600, Math.round(Number(v) * k))}"`);
  setCellParagraphs(doc, key, row, col, `${head}<hp:run charPrIDRef="${char}">${fitted}<hp:t/></hp:run></hp:p>`);
}
async function emptyTable(rows, cols, merges = []) {
  const doc = await blank();
  const { tableKey } = doc.insertTableAfter(0, 0, { headerRows: 0, rows: Array.from({ length: rows }, () => Array(cols).fill('')) }, { author: '시험' });
  if (merges.length) doc.editTable(tableKey, merges.map(([r0, c0, r1, c1]) => ({ op: 'merge', range: { row_from: r0, row_to: r1, col_from: c0, col_to: c1 } })));
  return { doc, key: tableKey };
}
const tblXml = (doc) => { const x = doc.sections[0].xml; return x.slice(x.indexOf('<hp:tbl '), x.lastIndexOf('</hp:tbl>') + '</hp:tbl>'.length); };

/** → HwpxDoc(4단 중첩 빈칸 표 — 위 그림) */
export async function nestedTableDoc() {
  const t3 = await emptyTable(2, 3, [[0, 1, 1, 1]]);
  const t2 = await emptyTable(2, 2, [[1, 0, 1, 1]]);
  putTableInCell(t2.doc, t2.key, 0, 1, tblXml(t3.doc));
  const t1 = await emptyTable(3, 3, [[0, 0, 0, 1]]);
  putTableInCell(t1.doc, t1.key, 1, 2, tblXml(t2.doc));
  const t1b = await emptyTable(2, 2);
  const doc = await blank();
  doc.insertFinalParagraphsAfter(0, 0, ['점검 양식(빈칸)']);
  const { tableKey: k0 } = doc.insertTableAfter(0, 1, { headerRows: 0, rows: Array.from({ length: 5 }, () => ['', '', '']) }, { author: '시험' });
  doc.editTable(k0, [{ op: 'merge', range: { row_from: 0, row_to: 0, col_from: 0, col_to: 2 } }, { op: 'merge', range: { row_from: 1, row_to: 2, col_from: 0, col_to: 0 } }]);
  putTableInCell(doc, k0, 3, 2, tblXml(t1b.doc));
  putTableInCell(doc, k0, 1, 1, tblXml(t1.doc));
  let n = 1900000001;
  for (const s of doc.sections) s.load(s.xml.replace(/(<hp:tbl\b[^>]*?\sid=")\d+(")/g, (m, a, b) => `${a}${n++}${b}`));
  return doc;
}
