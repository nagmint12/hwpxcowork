import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { HwpDocument } from './helpers/rhwp.mjs';
const section = async b => (await JSZip.loadAsync(b)).file('Contents/section0.xml').async('string');
const count = (s, name) => (s.match(new RegExp(`<hp:${name}\\b`, 'g')) || []).length;
const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQmQAAAAASUVORK5CYII=';

function blankClipboardDoc() {
  const doc = HwpDocument.createEmpty();
  doc.createBlankDocument();
  return doc;
}

function clipboardTable(doc, rows, cols) {
  const { paraIdx, controlIdx } = JSON.parse(doc.createTable(0, 0, 0, rows, cols));
  return { paraIdx, controlIdx };
}

const cellPath = (table, cellIndex = 0) => JSON.stringify([{ controlIndex: table.controlIdx, cellIndex, cellParaIndex: 0 }]);
const tableDimensions = (doc, table) => JSON.parse(doc.getTableDimensions(0, table.paraIdx, table.controlIdx));
const tableCell = (doc, table, r, c) => doc.getTableCellIndexAt(0, table.paraIdx, table.controlIdx, r, c);
const cellText = (doc, table, index) => doc.getTextInCell(
  0, table.paraIdx, table.controlIdx, index, 0, 0,
  doc.getCellParagraphLength(0, table.paraIdx, table.controlIdx, index, 0),
);

test('HTML 복합 문단을 표 셀에 붙일 때 표와 그림이 구조로 남는다', async () => {
  const doc = blankClipboardDoc();
  try {
    const table = clipboardTable(doc, 1, 1);
    const html = `<p>begin</p><table><tr><td>inside</td></tr></table><p><img src="data:image/png;base64,${pngData}"></p><p>end</p>`;
    assert.equal(JSON.parse(doc.pasteHtmlInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, html)).ok, true);
    const xml = await section(doc.exportHwpx());
    assert.equal(count(xml, 'tbl'), 2);
    assert.equal(count(xml, 'pic'), 1);
    assert.match(xml, /begin[\s\S]*inside[\s\S]*<hp:pic\b[\s\S]*end/);
  } finally { doc.free(); }
});

test('셀 블록 복사로 선택한 병합 셀과 인접 셀 구조를 옮긴다', async () => {
  const source = blankClipboardDoc();
  const target = blankClipboardDoc();
  try {
    const a = clipboardTable(source, 3, 3);
    source.mergeTableCells(0, a.paraIdx, a.controlIdx, 0, 0, 0, 1);
    source.insertTextInCell(0, a.paraIdx, a.controlIdx, tableCell(source, a, 0, 0), 0, 0, 'merged');
    source.insertTextInCell(0, a.paraIdx, a.controlIdx, tableCell(source, a, 1, 1), 0, 0, 'next');
    source.insertTextInCell(0, a.paraIdx, a.controlIdx, tableCell(source, a, 2, 2), 0, 0, 'outside');
    source.copyCellBlock(0, a.paraIdx, cellPath(a), 0, 1, 1, 1);
    assert.match(source.exportCellBlockHtml(), /colspan="2"/);
    assert.doesNotMatch(source.exportCellBlockHtml(), /outside/);
    const fragment = source.exportClipboardHwpx();
    const b = clipboardTable(target, 3, 3);
    assert.ok(target.canPasteCells(0, b.paraIdx, cellPath(b), 'document', fragment));
    target.pasteCells(0, b.paraIdx, cellPath(b), 0, 'document', fragment, 'overwrite', 'null');
    assert.equal(tableCell(target, b, 0, 0), tableCell(target, b, 0, 1));
    assert.equal(cellText(target, b, tableCell(target, b, 0, 0)), 'merged');
    assert.equal(cellText(target, b, tableCell(target, b, 1, 1)), 'next');
    const xml = await section(target.exportHwpx());
    assert.equal(count(xml, 'tbl'), 1);
    assert.match(xml, /colSpan="2"/);
    assert.doesNotMatch(xml, /outside/);
  } finally { source.free(); target.free(); }
});

test('셀 붙이기 일곱 방식과 실행 취소 후 원래 표를 확인한다', async () => {
  const fragment = new TextEncoder().encode('<table><tr><td style="background-color: #ff0000">source</td></tr></table>');
  const body = new TextEncoder().encode('<p>text</p><table><tr><td>source</td></tr></table>');
  const outcomes = {
    overwrite: [2, 2, 0, 0], contents: [2, 2, 0, 0],
    above: [3, 2, 0, 0], below: [3, 2, 1, 0],
    left: [2, 3, 0, 0], right: [2, 3, 0, 1],
  };
  for (const mode of [...Object.keys(outcomes), 'nested']) {
    const doc = blankClipboardDoc();
    try {
      const table = clipboardTable(doc, 2, 2);
      doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 0, 0, 0, 'existing');
      doc.insertTextInCell(0, table.paraIdx, table.controlIdx, 3, 0, 0, 'untouched');
      const path = cellPath(table);
      assert.ok(doc.canPasteCells(0, table.paraIdx, path, 'html', fragment), mode);
      assert.equal(doc.canPasteCells(0, table.paraIdx, path, 'html', body), false);
      const before = await section(doc.exportHwpx());
      const beforeCell = JSON.parse(doc.getCellProperties(0, table.paraIdx, table.controlIdx, 0));
      const undo = doc.saveSnapshot();
      assert.equal(JSON.parse(doc.pasteCells(0, table.paraIdx, path, 0, 'html', fragment, mode, 'null')).ok, true);
      const after = await section(doc.exportHwpx());
      if (mode === 'nested') {
        assert.equal(count(after, 'tbl'), 2);
        assert.match(after, /source[\s\S]*existing/);
        assert.equal(doc.pageCount(), 1);
      } else {
        const [rows, cols, row, col] = outcomes[mode];
        const dims = tableDimensions(doc, table);
        const index = tableCell(doc, table, row, col);
        assert.deepEqual([dims.rowCount, dims.colCount], [rows, cols], mode);
        assert.equal(cellText(doc, table, index), 'source', mode);
        assert.equal(cellText(doc, table, tableCell(doc, table, rows - 1, cols - 1)), 'untouched', mode);
        if (mode === 'contents' || mode === 'overwrite') {
          const afterCell = JSON.parse(doc.getCellProperties(0, table.paraIdx, table.controlIdx, index));
          assert.equal(afterCell.borderFillId === beforeCell.borderFillId, mode === 'contents');
        }
      }
      doc.restoreSnapshot(undo);
      assert.equal(await section(doc.exportHwpx()), before, mode);
    } finally { doc.free(); }
  }
});

test('병합된 대상 셀 하나에 붙여도 기존 셀 경계와 다른 셀을 유지한다', () => {
  const doc = blankClipboardDoc();
  try {
    const table = clipboardTable(doc, 2, 2);
    doc.mergeTableCells(0, table.paraIdx, table.controlIdx, 0, 0, 0, 1);
    const neighbor = tableCell(doc, table, 1, 1);
    doc.insertTextInCell(0, table.paraIdx, table.controlIdx, neighbor, 0, 0, 'neighbor');
    const path = cellPath(table);
    const fragment = new TextEncoder().encode('<table><tr><td>new text</td></tr></table>');
    doc.pasteCells(0, table.paraIdx, path, 0, 'html', fragment, 'overwrite', 'null');
    assert.equal(tableCell(doc, table, 0, 0), tableCell(doc, table, 0, 1));
    assert.equal(cellText(doc, table, 0), 'new text');
    assert.equal(cellText(doc, table, neighbor), 'neighbor');
  } finally { doc.free(); }
});

test('차트 단독과 그림·차트 동시 선택을 복사하면 캡션과 원본 개체가 남는다', async () => {
  const source = new HwpDocument(fs.readFileSync(new URL('./fixtures/chart_hangul_caption.hwpx', import.meta.url)));
  const target = blankClipboardDoc();
  try {
    const chart = JSON.parse(source.listCharts())[0];
    const image = JSON.parse(source.insertPicture(0, chart.paragraph, 0, '', Buffer.from(pngData, 'base64'),
      1500, 1500, 1, 1, 'png', 'clipboard picture'));
    const updatedChart = JSON.parse(source.listCharts())[0];
    source.copyControl(updatedChart.section, updatedChart.paragraph, '[]', updatedChart.control);
    const single = source.exportClipboardHwpx();
    const table = clipboardTable(target, 1, 1);
    assert.equal(target.canPasteCells(0, table.paraIdx, cellPath(table), 'document', single), false);
    target.pasteDocumentFragment(0, table.paraIdx, cellPath(table), 0, single);
    const singlePaste = await JSZip.loadAsync(target.exportHwpx());
    assert.ok(singlePaste.file('Chart/chart1.xml'));
    assert.deepEqual(
      await singlePaste.file('Chart/chart1.xml').async('uint8array'),
      await (await JSZip.loadAsync(single)).file('Chart/chart1.xml').async('uint8array'),
    );
    const refs = [[updatedChart.section, updatedChart.paragraph, [], updatedChart.control],
      [0, image.paraIdx ?? chart.paragraph, [], image.controlIdx]];
    source.copyControls(JSON.stringify(refs));
    assert.equal(source.clipboardHasControl(), false);
    const multi = source.exportClipboardHwpx();
    const xml = await section(multi);
    assert.equal(count(xml, 'chart'), 1);
    assert.equal(count(xml, 'pic'), 1);
    assert.ok(count(xml, 'caption') >= 1);
    const zip = await JSZip.loadAsync(multi);
    assert.ok(Object.keys(zip.files).some(name => name.startsWith('Chart/') && name.endsWith('.xml')));
    target.pasteDocumentFragment(0, table.paraIdx, cellPath(table), 0, multi);
    const pastedBytes = target.exportHwpx();
    const pasted = await section(pastedBytes);
    assert.equal(count(pasted, 'chart'), 2);
    assert.equal(count(pasted, 'pic'), 1);
    assert.ok(count(pasted, 'caption') >= 2);
    const pkg = await JSZip.loadAsync(pastedBytes);
    const chartRefs = [...pasted.matchAll(/chartIDRef="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(chartRefs).size, 2);
    for (const ref of chartRefs) assert.ok(pkg.file(ref), ref);
    const pictureRef = /<hp:pic\b[\s\S]*?<hc:img\b[^>]*binaryItemIDRef="([^"]+)"/.exec(pasted)?.[1];
    assert.ok(pictureRef);
    assert.deepEqual(await pkg.file(`BinData/${pictureRef}.png`).async('nodebuffer'), Buffer.from(pngData, 'base64'));
  } finally { source.free(); target.free(); }
});
