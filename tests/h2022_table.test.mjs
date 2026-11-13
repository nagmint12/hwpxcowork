// node --test tests/h2022_table.test.mjs — 한/글 2022 표 기능(h2022 표 영역, 2026-11-11)이 엔진·저장·서버까지 가는가.
//  기대값은 모두 한/글 2022 COM 이 같은 조작으로 저장한 문서(tests/fixtures/h2022_table/*_hangul.hwpx, 만든 스크립트
//  artifacts/h2022-table/com/probe_table.py)에서 온다. 엔진 결과를 정답으로 고정하지 않는다.
//  1) 자릿점 넣기/빼기(TableInsertComma/TableDeleteComma) — 셀 글이 한/글과 같고, 저장·다시 열기 뒤에도 같다
//  2) 계산식 필드: 블록 합계(한/글 식 모양 =SUM(A?:B?)·=SUM(?1:?2)·모서리)·쉬운 계산식이 FORMULA 필드로 저장되고,
//     셀을 고치면 다시 계산된다(한/글 12.30·2022: 표의 셀을 고치면 계산식 모두 다시 계산)
//  3) 셀 너비를 같게(TableDistributeCellWidth) — 열 블록·한 줄 블록(격자 다시 나눔)이 한/글 저장본과 같은 셀 격자·폭
//  4) 셀 정렬 9방향(TableCellAlign*) — 세로 정렬·문단 정렬이 한/글과 같은 값
//  5) 서버: 손대지 않은 내보내기는 덩어리가 없고, 위 변경을 실시간 밀어 넣기 → 한글로 저장에 그대로 실린다
// 엔진 pkg: RHWP_PKG(기본 vendor/rhwp/pkg). 서버는 시험 받침(빈 포트·임시 data·AI 끔)으로 띄운다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, root } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const { planHangulBlockCalculation, easyFormula, cellAlign9Props } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/command/h2022-block-calc.ts')).href);

const FX = path.join(root, 'tests/fixtures/h2022_table');
const fx = (name) => fs.readFileSync(path.join(FX, name));
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const HAS_API = typeof mod.HwpDocument.prototype.applyTableThousandsSeparator === 'function';
const SKIP = !HAS_API && `엔진(${pkgDir})에 h2022 표 API 가 없습니다 — RHWP_PKG=artifacts/h2022-table/engine-pkg`;

/** 문서의 첫 표 자리 */
function firstTable(doc) {
  for (let p = 0; p < 4; p++) for (let c = 0; c < 6; c++) {
    try { const d = JSON.parse(doc.getTableDimensions(0, p, c)); if (d.cellCount) return { p, c, ...d }; } catch { /* 표 아님 */ }
  }
  throw new Error('표 없음');
}
const cellText = (doc, t, i) => doc.getTextInCell(0, t.p, t.c, i, 0, 0, doc.getCellParagraphLength(0, t.p, t.c, i, 0));
/** 저장된 HWPX 의 첫 표 셀(격자·폭·세로 정렬·문단 정렬·글·계산식 Command) */
async function cells(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const xml = await z.file('Contents/section0.xml').async('string');
  const header = await z.file('Contents/header.xml').async('string');
  const aligns = Object.fromEntries([...header.matchAll(/<hh:paraPr id="(\d+)"[^>]*>\s*<hh:align horizontal="(\w+)"/g)].map((m) => [m[1], m[2]]));
  const tbl = /<hp:tbl\b[^>]*rowCnt="(\d+)" colCnt="(\d+)"/.exec(xml);
  const list = [...xml.matchAll(/<hp:tc\b[^>]*>([\s\S]*?)<\/hp:tc>/g)].map(([, body]) => {
    const addr = /<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"/.exec(body);
    const span = /<hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"/.exec(body);
    return {
      at: `${addr[2]}:${addr[1]}`,
      span: `${span[2]}x${span[1]}`,
      width: Number(/<hp:cellSz width="(\d+)"/.exec(body)[1]),
      vAlign: /<hp:subList\b[^>]*vertAlign="(\w+)"/.exec(body)?.[1],
      hAlign: [...body.matchAll(/<hp:p\b[^>]*paraPrIDRef="(\d+)"/g)].map((m) => aligns[m[1]]),
      text: [...body.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join(''),
      commands: [...body.matchAll(/name="Command">([^<]*)</g)].map((m) => m[1]),
    };
  }).sort((a, b) => a.at.localeCompare(b.at, 'en', { numeric: true }));
  return { size: tbl ? `${tbl[1]}x${tbl[2]}` : null, list };
}
const pick = (c, keys) => c.list.map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])));

test('자릿점 넣기/빼기 = 한/글 2022 TableInsertComma/TableDeleteComma(셀 블록 전체)', { skip: SKIP }, async () => {
  const doc = open(fx('numbers_4x2.hwpx'));
  const t = firstTable(doc);
  const all = [...Array(t.cellCount).keys()];
  const r = JSON.parse(doc.applyTableThousandsSeparator(0, t.p, t.c, JSON.stringify(all), true));
  assert.ok(r.ok);
  const want = pick(await cells(fx('numbers_4x2_comma_hangul.hwpx')), ['at', 'text']);
  const inserted = doc.exportHwpx();
  assert.deepEqual(pick(await cells(inserted), ['at', 'text']), want, '넣기 결과 = 한/글 저장본');
  // 다시 열어도 같다
  const again = open(inserted); const t2 = firstTable(again);
  assert.deepEqual(all.map((i) => cellText(again, t2, i)), all.map((i) => cellText(doc, t, i)));
  // 빼기: 한/글은 '12,345' 처럼 원래 쉼표가 있던 칸도 쉼표를 지웠다
  doc.applyTableThousandsSeparator(0, t.p, t.c, JSON.stringify(all), false);
  const deleted = pick(await cells(doc.exportHwpx()), ['at', 'text']).map((x) => x.text);
  assert.deepEqual(deleted, ['1234567', '1234.5678', 'abc 12345 def', '-9876543.21', '1234567원', '12345', '0012345', '12345 67890']);
  // 한 칸만(F5 한 칸 블록 — 한/글 thousands_one: 고른 칸만 바뀐다)
  const one = open(fx('numbers_4x2.hwpx'));
  one.applyTableThousandsSeparator(0, t.p, t.c, '[0]', true);
  assert.equal(cellText(one, t, 0), '1,234,567');
  assert.equal(cellText(one, t, 1), '1234.5678');
});

test('블록 합계(한/글 식 모양)·쉬운 계산식 → FORMULA 필드 저장 · 셀을 고치면 다시 계산', { skip: SKIP }, async () => {
  // 한/글 block_sum_full: 1 2 / 3 4 의 꽉 찬 A1:B2 블록 → C1·C2·A3·B3·C3
  const expected = await cells(fx('block_sum_full_hangul.hwpx'));
  const jobs = planHangulBlockCalculation({
    range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    cells: [[{ empty: false }, { empty: false }], [{ empty: false }, { empty: false }]],
    rowCount: 3, colCount: 3, functionName: 'SUM',
  });
  const wantCommands = expected.list.filter((x) => x.commands.length).map((x) => [x.at, x.commands[0]]);
  // 엔진에 넣기 전 식 모양 = 한/글 Command 의 식·형식(결과는 엔진이 셈)
  assert.deepEqual(jobs.map((j) => [`${j.targetRow}:${j.targetCol}`, `${j.formula}??${j.resultFormat}`]).sort(),
    wantCommands.map(([at, cmd]) => [at, cmd.replace(/;;.*$/, '')]).sort());
  // 한/글 저장본에서 계산식을 지우고 글을 비운 문서 = 블록 계산 전 문서
  const doc = open(fx('block_sum_full_hangul.hwpx'));
  const t = firstTable(doc);
  const cellAt = (r, c) => [...Array(t.cellCount).keys()].find((i) => { const info = JSON.parse(doc.getCellInfo(0, t.p, t.c, i)); return info.row === r && info.col === c; });
  for (const j of jobs) {
    const i = cellAt(j.targetRow, j.targetCol);
    doc.removeTableCellFormulas(0, t.p, t.c, i);
    doc.deleteTextInCell(0, t.p, t.c, i, 0, 0, doc.getCellParagraphLength(0, t.p, t.c, i, 0));
  }
  assert.equal((await cells(doc.exportHwpx())).list.filter((x) => x.commands.length).length, 0);
  for (const j of jobs) doc.setTableCellFormula(0, t.p, t.c, cellAt(j.targetRow, j.targetCol), j.formula, j.resultFormat);
  const got = await cells(doc.exportHwpx());
  assert.deepEqual(pick(got, ['at', 'text', 'commands']), pick(expected, ['at', 'text', 'commands']), '블록 합계 결과·Command = 한/글 저장본');
  // 셀을 고치면(A1 1 → 91) 다시 계산: C1 93, A3 94, C3 100 — 한/글은 식이 쓰는 셀이 바뀌면 다시 계산한다
  doc.insertTextInCell(0, t.p, t.c, cellAt(0, 0), 0, 0, '9');
  const after = Object.fromEntries((await cells(doc.exportHwpx())).list.map((x) => [x.at, [x.text, x.commands[0]]]));
  assert.deepEqual(after['0:2'], ['93', '=SUM(A?:B?)??%g;;93']);
  assert.deepEqual(after['2:0'], ['94', '=SUM(?1:?2)??%g;;94']);
  assert.deepEqual(after['2:2'], ['100', '=SUM(A1:B2)??%g;;100']);
  // 지워도 다시 계산(91 → 1)
  doc.deleteTextInCell(0, t.p, t.c, cellAt(0, 0), 0, 0, 1);
  const back = Object.fromEntries((await cells(doc.exportHwpx())).list.map((x) => [x.at, x.text]));
  assert.equal(back['2:2'], '10');
  // 다시 열면 식이 남아 있다(조회 API)
  const reopened = open(doc.exportHwpx());
  assert.deepEqual(JSON.parse(reopened.getTableCellFormula(0, t.p, t.c, cellAt(2, 2))), { formula: '=SUM(A1:B2)', resultFormat: '%g', lastResult: '10' });
  assert.deepEqual(JSON.parse(reopened.getTableCellFormula(0, t.p, t.c, cellAt(0, 0))), {});
  // 쉬운 계산식 식 모양 = 한/글 easy 저장본(TableFormulaSumHor·AvgHor·SumVer·ProVer·ProHor)
  const easy = Object.fromEntries((await cells(fx('easy_hangul.hwpx'))).list.filter((x) => x.commands.length).map((x) => [x.at, x.commands[0].replace(/;;.*$/, '')]));
  const f = (fn, dir) => { const e = easyFormula(fn, dir); return `${e.formula}??${e.resultFormat}`; };
  assert.deepEqual(easy, { '0:2': f('SUM', 'horizontal'), '1:2': f('AVG', 'horizontal'), '2:0': f('SUM', 'vertical'), '2:1': f('PRODUCT', 'vertical'), '2:2': f('PRODUCT', 'horizontal') });
});

test('셀 너비를 같게 = 한/글 2022 TableDistributeCellWidth(열 블록·한 줄 블록)', { skip: SKIP }, async () => {
  const keys = ['at', 'span', 'width', 'text'];
  for (const [block, want] of [[[0, 0, 2, 1], 'equal_width_cols_hangul.hwpx'], [[0, 0, 0, 1], 'equal_width_row_hangul.hwpx']]) {
    const doc = open(fx('widths_3x3.hwpx'));
    const t = firstTable(doc);
    JSON.parse(doc.equalizeTableCellSizes(0, t.p, t.c, ...block, 'width'));
    const got = await cells(doc.exportHwpx());
    const exp = await cells(fx(want));
    // 한/글 자동 고침이 i 를 I 로 바꾼 것은 글 입력의 일이다(셀 크기와 무관) — 글은 견주지 않는다
    assert.equal(got.size, exp.size, `${want}: 표 격자`);
    assert.deepEqual(pick(got, keys.slice(0, 3)), pick(exp, keys.slice(0, 3)), `${want}: 셀 격자·폭`);
  }
});

test('셀 정렬 9방향 = 한/글 2022 TableCellAlign*(왼쪽 = 양쪽 정렬)', { skip: SKIP }, async () => {
  const doc = open(fx('widths_3x3.hwpx'));
  const t = firstTable(doc);
  // 한/글 align_left: 1x3 표의 a=LeftTop, b=CenterBottom, c=RightCenter
  for (const [i, align] of [[0, 'left-top'], [1, 'center-bottom'], [2, 'right-center']]) {
    const { alignment, verticalAlign } = cellAlign9Props(align);
    doc.setCellProperties(0, t.p, t.c, i, JSON.stringify({ verticalAlign }));
    doc.applyParaFormatInCell(0, t.p, t.c, i, 0, JSON.stringify({ alignment }));
  }
  const got = (await cells(doc.exportHwpx())).list.slice(0, 3).map((x) => [x.vAlign, x.hAlign[0]]);
  const exp = (await cells(fx('align_hangul.hwpx'))).list.map((x) => [x.vAlign, x.hAlign[0]]);
  assert.deepEqual(got, exp);
});

test('표를 문자열로·문자열을 표로(편집기 명령과 같은 엔진 호출 차례) = 한/글 2022 기본(탭)', { skip: SKIP }, async () => {
  const { cellsToLines, linesToCells } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/command/h2022-table-text.ts')).href);
  // 표 → 문자열: 4×2 숫자 표 → 문단 4개, 칸 사이 탭(한/글 table_to_str: 'a<tab>b<tab>c', 빈 칸은 탭만)
  const doc = open(fx('numbers_4x2.hwpx'));
  const t = firstTable(doc);
  const rows = [0, 1, 2, 3].map((r) => [0, 1].map((c) => cellText(doc, t, r * 2 + c)));
  const lines = cellsToLines(rows, { delimiter: 'auto' });
  assert.deepEqual(cellsToLines([['a', 'b', 'c'], ['1', '', '3']], { delimiter: 'tab' }), ['a\tb\tc', '1\t\t3']);
  const off = JSON.parse(doc.getControlTextPositions(0, t.p))[t.c] ?? 0;
  const before = doc.getParagraphCount(0);
  doc.deleteTableControl(0, t.p, t.c);
  let para = t.p; let o = off;
  lines.forEach((line, i) => {
    const r = JSON.parse(doc.insertText(0, para, o, line) || '{}');
    o = typeof r.charOffset === 'number' ? r.charOffset : o + line.length;
    if (i < lines.length - 1) { doc.splitParagraph(0, para, o); para += 1; o = 0; }
  });
  assert.equal(doc.getParagraphCount(0), before + 3);
  const xml = await (await JSZip.loadAsync(doc.exportHwpx())).file('Contents/section0.xml').async('string');
  assert.ok(!/<hp:tbl\b/.test(xml), '표가 없어졌다');
  assert.match(xml, /1234567<hp:tab\b[^>]*\/>1234\.5678/, '탭은 한/글처럼 hp:tab 으로 저장');
  // 문자열 → 표: 그 문단 넷을 다시 표로 — 4×2, 칸 글이 원래와 같다(한/글 str_to_table: 줄 = 행, 탭 = 칸)
  const texts = [0, 1, 2, 3].map((k) => doc.getTextRange(0, t.p + k, 0, doc.getParagraphLength(0, t.p + k)));
  const cells2 = linesToCells(texts, { delimiter: 'auto' });
  assert.deepEqual(cells2, rows);
  doc.deleteRange(0, t.p, 0, t.p + 3, doc.getParagraphLength(0, t.p + 3));
  const made = JSON.parse(doc.createTable(0, t.p, 0, 4, 2));
  cells2.forEach((row, r) => row.forEach((text, c) => { if (text) doc.insertTextInCell(0, made.paraIdx, made.controlIdx, r * 2 + c, 0, 0, text); }));
  const back = await cells(doc.exportHwpx());
  assert.equal(back.size, '4x2');
  assert.deepEqual(back.list.map((x) => x.text), rows.flat());
  // 짧은 줄은 빈 칸(한/글 x<tab>y → 3칸 표의 마지막 칸 빈칸)
  assert.deepEqual(linesToCells(['a\tb\tc', 'x\ty'], { delimiter: 'auto' }), [['a', 'b', 'c'], ['x', 'y', '']]);
  assert.deepEqual(linesToCells(['a,b'], { delimiter: 'comma', keepSeparator: true }), [['a,', 'b']]);
});

test('서버: 손대지 않은 내보내기는 덩어리 없음 · 자릿점·계산식·셀 너비·정렬이 실시간 밀어 넣기 → 한글로 저장에 실린다', { skip: SKIP, timeout: 180000 }, async (t) => {
  // 덩어리 없음(엔진으로 열어 그대로 내보낸 것)
  for (const name of ['numbers_4x2.hwpx', 'block_sum_full_hangul.hwpx', 'widths_3x3.hwpx']) {
    const base = await HwpxDoc.load(fx(name));
    const same = await diffDocs(base, await HwpxDoc.load(open(fx(name)).exportHwpx()));
    assert.equal(same.hunks.length, 0, `${name}: 손대지 않은 내보내기에 덩어리 없음`);
  }
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  let pushed = 0;
  const push = async (name, edit) => {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, fx(name), name);
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const doc = open(w.data); const tb = firstTable(doc); edit(doc, tb);
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    // 한/글 COM 확인용으로 서버 저장본을 남긴다(H2022_TABLE_OUT=<임시 폴더>)
    if (process.env.H2022_TABLE_OUT) { fs.mkdirSync(process.env.H2022_TABLE_OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.H2022_TABLE_OUT, `server_${++pushed}_${name}`), ex.data); }
    return { r, editor: await cells(doc.exportHwpx()), saved: await cells(ex.data), exported: ex.data };
  };
  // 1) 자릿점 넣기
  {
    const { r, editor, saved } = await push('numbers_4x2.hwpx', (d, tb) => d.applyTableThousandsSeparator(0, tb.p, tb.c, JSON.stringify([...Array(tb.cellCount).keys()]), true));
    assert.equal(r.unsupported, 0);
    assert.deepEqual(pick(saved, ['at', 'text']), pick(editor, ['at', 'text']), '자릿점: 서버 저장본 = 편집기');
  }
  // 2) 계산식 필드: 블록 합계 문서에서 A1 을 고친 결과(다시 계산) — 칸 안 FORMULA 필드가 서버 저장본에 남는가
  {
    const { r, editor, saved, exported } = await push('block_sum_full_hangul.hwpx', (d, tb) => d.insertTextInCell(0, tb.p, tb.c, 0, 0, 0, '9'));
    assert.equal(r.unsupported, 0);
    assert.deepEqual(pick(saved, ['at', 'text', 'commands']), pick(editor, ['at', 'text', 'commands']), '계산식: 서버 저장본 = 편집기(식·결과)');
    assert.ok(saved.list.some((x) => x.commands[0] === '=SUM(A1:B2)??%g;;100'));
    // 서버 저장본을 다시 열면 계산식 필드가 그대로(조회 API) — 필드 시작·끝 짝이 맞다
    const re = open(exported); const rt = firstTable(re);
    assert.equal(JSON.parse(re.getTableCellFormula(0, rt.p, rt.c, 8)).lastResult, '100');
    assert.equal(cellText(re, rt, 8), '100');
  }
  // 3) 새 계산식(쉬운 계산식 가로 합계)을 빈 칸에 넣기 — 표 뼈대는 그대로, 칸 안 필드만 생긴다
  {
    const { r, editor, saved } = await push('numbers_4x2.hwpx', (d, tb) => {
      d.deleteTextInCell(0, tb.p, tb.c, 1, 0, 0, d.getCellParagraphLength(0, tb.p, tb.c, 1, 0));
      const e = easyFormula('SUM', 'horizontal');
      d.setTableCellFormula(0, tb.p, tb.c, 1, e.formula, e.resultFormat);
    });
    assert.equal(r.unsupported, 0);
    assert.deepEqual(editor.list[1].commands, ['=SUM(LEFT)??%g;;1234567']);
    assert.deepEqual(pick(saved, ['at', 'text', 'commands']), pick(editor, ['at', 'text', 'commands']), '새 계산식: 서버 저장본 = 편집기');  }
  // 4) 셀 너비를 같게(한 줄 블록 — 격자 다시 나눔: 표 뼈대가 바뀐다)·정렬
  {
    const { r, editor, saved } = await push('widths_3x3.hwpx', (d, tb) => {
      d.equalizeTableCellSizes(0, tb.p, tb.c, 0, 0, 0, 1, 'width');
      d.setCellProperties(0, tb.p, tb.c, 0, JSON.stringify({ verticalAlign: 2 }));
      d.applyParaFormatInCell(0, tb.p, tb.c, 0, 0, JSON.stringify({ alignment: 'right' }));
    });
    assert.equal(r.unsupported, 0);
    assert.equal(saved.size, '3x4');
    assert.deepEqual(pick(saved, ['at', 'span', 'width', 'vAlign', 'hAlign']), pick(editor, ['at', 'span', 'width', 'vAlign', 'hAlign']), '셀 너비·정렬: 서버 저장본 = 편집기');
  }
  // 5) 정렬만(표 뼈대 그대로 — 칸 속성·문단 모양만 바뀜)
  {
    const { r, editor, saved } = await push('numbers_4x2.hwpx', (d, tb) => {
      d.setCellProperties(0, tb.p, tb.c, 3, JSON.stringify({ verticalAlign: 2 }));
      d.applyParaFormatInCell(0, tb.p, tb.c, 3, 0, JSON.stringify({ alignment: 'center' }));
    });
    assert.equal(r.unsupported, 0);
    assert.deepEqual(pick(saved, ['at', 'vAlign', 'hAlign']), pick(editor, ['at', 'vAlign', 'hAlign']), '정렬만: 서버 저장본 = 편집기');
  }
  // 6) 셀 음영만(칸 배경 — borderFill)
  {
    const { r, exported } = await push('numbers_4x2.hwpx', (d, tb) => {
      d.setCellProperties(0, tb.p, tb.c, 0, JSON.stringify({ fillType: 'solid', fillColor: '#E5E5E5' }));
    });
    assert.equal(r.unsupported, 0);
    const z = await JSZip.loadAsync(exported);
    const header = await z.file('Contents/header.xml').async('string');
    const sec = await z.file('Contents/section0.xml').async('string');
    const ref = /<hp:tc\b[^>]*borderFillIDRef="([0-9]+)"/.exec(sec)[1];
    const bf = header.split('<hh:borderFill ').find((x) => x.startsWith(`id="${ref}"`)) ?? '';
    assert.match(bf, /faceColor="#E5E5E5"/, '첫 칸 배경이 서버 저장본에 실린다');
  }
  // 7) 표 뒤집기(좌우 — 뼈대 같고 칸 글·폭 자리만 바뀜)
  {
    const { r, editor, saved } = await push('swap_base_hangul.hwpx', (d, tb) => d.swapTable(0, tb.p, tb.c, 1));
    assert.equal(r.unsupported, 0);
    assert.deepEqual(pick(saved, ['at', 'span', 'width', 'text']), pick(editor, ['at', 'span', 'width', 'text']), '표 뒤집기: 서버 저장본 = 편집기');
  }
});

// ─── 2차(2026-11-12): 다시 계산 경로 넓히기 · '3x' · 표 뒤집기 · 셀 음영 ───────────────────────────────

/** 문서 첫 표의 (행:열) → 글(계산식이면 Command 를 덧붙임) */
async function grid(bytes) {
  return Object.fromEntries((await cells(bytes)).list.map((x) => [x.at, x.text + (x.commands[0] ? ` {${x.commands[0]}}` : '')]));
}

test('다시 계산: 셀 문단 나누기·합치기·범위 지우기·HTML 붙여넣기 뒤에도 계산식이 다시 계산된다(한/글 12.30: 셀을 고치면 다시 계산)', { skip: SKIP }, async () => {
  // 한/글 2022 저장본: 1 2 C1=SUM(LEFT) / 3 4 C2=SUM(LEFT) / A3=SUM(ABOVE)
  const base = fx('recalc_base_hangul.hwpx');
  const at = (doc, t, r, c) => [...Array(t.cellCount).keys()].find((i) => { const x = JSON.parse(doc.getCellInfo(0, t.p, t.c, i)); return x.row === r && x.col === c; });
  // 문단 나누기: A1 '1' 앞에서 Enter → 첫 문단이 빈 글(값 없음) → C1 = 2, A3 = 3
  {
    const doc = open(base); const t = firstTable(doc);
    doc.splitParagraphInCell(0, t.p, t.c, at(doc, t, 0, 0), 0, 0);
    const g = await grid(doc.exportHwpx());
    assert.equal(g['0:2'], '2 {=SUM(LEFT)??%g;;2}', '나누기 뒤 다시 계산');
    assert.equal(g['2:0'], '3 {=SUM(ABOVE)??%g;;3}');
    // 합치기(Backspace) → 원래대로
    doc.mergeParagraphInCell(0, t.p, t.c, at(doc, t, 0, 0), 1);
    const h = await grid(doc.exportHwpx());
    assert.equal(h['0:2'], '3 {=SUM(LEFT)??%g;;3}', '합치기 뒤 다시 계산');
  }
  // 칸 안 범위 지우기(셀 블록 지우기·선택 지우기 경로): B2 '4' 지움 → C2 = 3
  {
    const doc = open(base); const t = firstTable(doc);
    doc.deleteRangeInCell(0, t.p, t.c, at(doc, t, 1, 1), 0, 0, 0, 1);
    assert.equal((await grid(doc.exportHwpx()))['1:2'], '3 {=SUM(LEFT)??%g;;3}');
  }
  // HTML 붙여넣기: B1 에 '10' 붙여넣기 → '102' 또는 '210' 이 되어 C1 이 바뀐다
  {
    const doc = open(base); const t = firstTable(doc);
    doc.pasteHtmlInCell(0, t.p, t.c, at(doc, t, 0, 1), 0, 0, '<p>10</p>');
    const g = await grid(doc.exportHwpx());
    const b1 = Number(g['0:1']);
    assert.equal(g['0:2'], `${1 + b1} {=SUM(LEFT)??%g;;${1 + b1}}`, `붙여넣기 뒤 다시 계산(B1=${g['0:1']})`);
  }
});

test('다시 계산: 중첩 표(표 안 표)의 칸을 고쳐도 계산식이 다시 계산된다', { skip: SKIP }, async () => {
  // 한/글 2022 저장본: 바깥 1×1 표 칸 안에 2×3 표(1 2 C1=SUM(LEFT) / 3 4 C2=SUM(LEFT))
  const doc = open(fx('nested_formula_hangul.hwpx'));
  const outer = firstTable(doc);
  // 안쪽 표: 바깥 칸 0 의 문단 0, 컨트롤 0
  const path = (cell) => JSON.stringify([{ controlIndex: outer.c, cellIndex: 0, cellParaIndex: 0 }, { controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }]);
  doc.insertTextInCellByPath(0, outer.p, path(0), 0, '9');   // A1 1 → 91
  const xml = await (await JSZip.loadAsync(doc.exportHwpx())).file('Contents/section0.xml').async('string');
  const cmds = [...xml.matchAll(/name="Command">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(cmds, ['=SUM(LEFT)??%g;;93', '=SUM(LEFT)??%g;;7'], '안쪽 표 C1 이 다시 계산됐다');
  assert.match(xml, /<hp:t>93<\/hp:t>/);
  doc.deleteTextInCellByPath(0, outer.p, path(0), 0, 1);     // 91 → 1
  const back = await (await JSZip.loadAsync(doc.exportHwpx())).file('Contents/section0.xml').async('string');
  assert.deepEqual([...back.matchAll(/name="Command">([^<]*)</g)].map((m) => m[1]), ['=SUM(LEFT)??%g;;3', '=SUM(LEFT)??%g;;7']);
});

test("블록 합계: 결과 칸에 글이 있으면 결과를 앞에 넣고 글을 남긴다(한/글 '3x')", { skip: SKIP }, async () => {
  const doc = open(fx('block_sum_full_hangul.hwpx'));
  const t = firstTable(doc);
  // C1(칸 2) 계산식을 지우고 글을 'x' 로 → 한/글 block_busy 와 같은 시작
  doc.removeTableCellFormulas(0, t.p, t.c, 2);
  doc.deleteTextInCell(0, t.p, t.c, 2, 0, 0, doc.getCellParagraphLength(0, t.p, t.c, 2, 0));
  doc.insertTextInCell(0, t.p, t.c, 2, 0, 0, 'x');
  doc.setTableCellFormulaEx(0, t.p, t.c, 2, '=SUM(A?:B?)', '%g', true);
  assert.equal((await grid(doc.exportHwpx()))['0:2'], '3x {=SUM(A?:B?)??%g;;3}', '한/글 block_busy: C1 = "3x", 필드 결과 3');
});

test('표 뒤집기 Type 0~5(병합 칸 포함) = 한/글 2022 TableSwap 저장본', { skip: SKIP }, async () => {
  const keys = ['at', 'span', 'width', 'text'];
  for (const merged of ['', 'm']) {
    for (let kind = 0; kind <= 5; kind++) {
      const doc = open(fx(`swap_base${merged}_hangul.hwpx`));
      const t = firstTable(doc);
      JSON.parse(doc.swapTable(0, t.p, t.c, kind));
      const got = await cells(doc.exportHwpx());
      const exp = await cells(fx(`swap${kind}${merged}_hangul.hwpx`));
      assert.equal(got.size, exp.size, `Type ${kind}${merged}: 격자`);
      assert.deepEqual(pick(got, keys), pick(exp, keys), `Type ${kind}${merged}: 칸 자리·병합·폭·글`);
    }
  }
});

test('셀 음영 한 단계 어둡게/밝게 = 한/글 2022 TableCellShadeInc/Dec 회색 사다리', async () => {
  const { shadeStep } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/command/h2022-block-calc.ts')).href);
  // 한/글 실측: 배경 없음에서 어둡게 10번, 거기서 밝게 12번
  const inc = ['#F2F2F2', '#E5E5E5', '#D8D8D8', '#CCCCCC', '#BFBFBF', '#B2B2B2', '#A5A5A5', '#999999', '#8C8C8C', '#7F7F7F'];
  const dec = ['#8C8C8C', '#999999', '#A5A5A5', '#B2B2B2', '#BFBFBF', '#CCCCCC', '#D8D8D8', '#E5E5E5', '#F2F2F2', '#F2F2F2', '#F2F2F2', '#F2F2F2'];
  let c = null; const a = [];
  for (let i = 0; i < 10; i++) { c = shadeStep(c, 1) ?? c; a.push(c); }
  assert.deepEqual(a, inc);
  const b = [];
  for (let i = 0; i < 12; i++) { c = shadeStep(c, -1) ?? c; b.push(c); }
  assert.deepEqual(b, dec);
  assert.equal(shadeStep(null, -1), null, '배경 없음에서 밝게는 그대로');
  assert.equal(shadeStep('#FF0000', 1), null, '회색 아닌 색은 미실측 — 바꾸지 않는다');
});

// ─── 3차(2026-11-12): 표 자동 채우기 ───────────────────────────────────────────

test('표 자동 채우기 규칙 = 한/글 2022 TableAutoFill 실측(1×7 시작 값 41종 + 블록 모양 3종)', async () => {
  const { planAutofill } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/command/h2022-autofill.ts')).href);
  const { results } = JSON.parse(fs.readFileSync(path.join(FX, 'autofill_hangul.json'), 'utf8'));
  const shapes = {
    shape3x3: [['1', '2', ''], ['5', '', ''], ['', '', '']],
    shape2x5: [['1', '2', '', '', ''], ['5', '', '', '', '']],
    shape5x2: [['1', '2'], ['5', ''], ['', ''], ['', ''], ['', '']],
  };
  const mismatch = [];
  for (const [key, want] of Object.entries(results)) {
    const block = shapes[key] ?? [[...key.split('|'), ...Array(7 - key.split('|').length).fill('')]];
    const got = block.map((r) => [...r]);
    for (const c of planAutofill(block)) got[c.row][c.col] = c.text;
    const flat = shapes[key] ? got : got[0];
    if (JSON.stringify(flat) !== JSON.stringify(want)) mismatch.push(`${key}: ${JSON.stringify(flat)} ≠ 한/글 ${JSON.stringify(want)}`);
  }
  // 알려진 차이 하나: '12월,1월' 을 한/글은 -10월,-8월,… 로 채웠다(규칙 불명). 이 편집기는 등차(-10월,-21월…).
  assert.deepEqual(mismatch.filter((m) => !m.startsWith('12월|1월')), []);
  assert.equal(mismatch.length, 1, '알려진 차이(12월|1월) 하나만 남는다');
});

test('표 자동 채우기: 편집기 명령과 같은 엔진 호출로 채운 문서 = 한/글 5×2 저장본', { skip: SKIP }, async () => {
  const { planAutofill } = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/command/h2022-autofill.ts')).href);
  // 한/글 저장본에서 시작 값만 남기고(1 2 / 5) 나머지를 비운 뒤 채운다
  const doc = open(fx('autofill_5x2_hangul.hwpx'));
  const t = firstTable(doc);
  const at = (r, c) => [...Array(t.cellCount).keys()].find((i) => { const x = JSON.parse(doc.getCellInfo(0, t.p, t.c, i)); return x.row === r && x.col === c; });
  const keep = new Set(['0:0', '0:1', '1:0']);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++) {
    if (keep.has(`${r}:${c}`)) continue;
    const i = at(r, c); const len = doc.getCellParagraphLength(0, t.p, t.c, i, 0);
    if (len) doc.deleteTextInCell(0, t.p, t.c, i, 0, 0, len);
  }
  const block = [0, 1, 2, 3, 4].map((r) => [0, 1].map((c) => cellText(doc, t, at(r, c))));
  for (const cell of planAutofill(block)) doc.insertTextInCell(0, t.p, t.c, at(cell.row, cell.col), 0, 0, cell.text);
  assert.deepEqual(pick(await cells(doc.exportHwpx()), ['at', 'text']), pick(await cells(fx('autofill_5x2_hangul.hwpx')), ['at', 'text']));
});
