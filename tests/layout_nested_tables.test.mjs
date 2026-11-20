// 합성 HWPX를 한/글 2022 12.0.0.3146에서 열어 CreatePageImage(96dpi)와
// 재저장 HWPX를 측정했다. 75HU = 1px. 표와 칸 경계는 편집기 렌더 트리에서 읽는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadEngine } from '../scripts/layout-trace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures/layout/nested-tables-20261120');
const pkg = path.resolve(process.env.RHWP_PKG || path.join(here, '../vendor/rhwp/pkg'));
const engine = await loadEngine(pkg);
const huPerPx = 75;

function firstPage(fixture) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(fixtureDir, `${fixture}.hwpx`)));
  const doc = new engine.HwpDocument(bytes);
  try {
    doc.convertToEditable();
    assert.equal(doc.pageCount(), 1);
    return JSON.parse(doc.getPageRenderTree(0));
  } finally {
    doc.free();
  }
}

function tables(node) {
  return [...(node.type === 'Table' ? [node] : []), ...(node.children ?? []).flatMap(tables)];
}

const cells = (table) => table.children.filter((node) => node.type === 'Cell');
const right = ({ x, w }) => x + w;
const near = (actual, expected, label, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} px ↔ 한/글 ${expected} px`);

for (const variant of ['absent', 'stored', 'complete']) {
  test(`중첩 표 뒤 문단의 저장 줄 상태(${variant})에 관계없이 행이 모두 나온다`, () => {
    const frames = tables(firstPage(`deep-3-rows-2-${variant}`));
    assert.deepEqual(frames.map(({ rows, cols }) => [rows, cols]), [[1, 1], [2, 2], [2, 3], [5, 2]]);
    // 세 파일의 재저장 표 높이는 27000, 19676, 16828, 12000HU로 같았다.
    const heights = [27000, 19676, 16828, 12000];
    frames.forEach(({ bbox }, i) => near(bbox.h, heights[i] / huPerPx, `표 ${i + 1} 높이`));
    const inner = frames.at(-1);
    // 96dpi 쪽 그림의 가장 안쪽 표 채움 [304, 232, 328, 392].
    near(inner.bbox.x, 304, '중첩 표 왼쪽', 2);
    near(inner.bbox.y, 232, '중첩 표 위쪽', 2);
    const innerCells = cells(inner);
    assert.deepEqual(innerCells.map(({ row, col }) => [row, col]), Array.from({ length: 10 }, (_, i) => [Math.floor(i / 2), i % 2]));
    for (const { row, bbox } of innerCells) {
      near(bbox.y, inner.bbox.y + row * 32, `행 ${row + 1} 위쪽`);
      near(bbox.h, 2400 / huPerPx, `행 ${row + 1} 높이`);
    }
  });
}

const widths = [
  // 실제 두 열의 너비가 1500+1500HU인 정상 표.
  { variant: 'normal', width: 3000, boundary: 148, visibleRight: 168 },
  // 셀에 500HU씩 저장한 표는 선언 폭 10000HU를 셀별 최소 폭 합 2606HU로 다시 잰다.
  { variant: 'narrow-wide-declaration', width: 2606, boundary: 145, visibleRight: 162 },
  // 실제 두 열이 5000+5000HU인 표는 폭을 보존하고, 부모 칸 우변 x=237px에서 클립한다.
  { variant: 'wide', width: 10000, boundary: 194, visibleRight: 237 },
];
for (const mode of ['inline', 'float']) {
  for (const { variant, width, boundary, visibleRight } of widths) {
    test(`칸 안 ${mode} 표의 열 경계와 부모 칸 클립(${variant})`, () => {
      const [outer, inner] = tables(firstPage(`${mode}-${variant}`));
      assert.ok(outer && inner);
      const parent = cells(outer).find(({ row, col }) => row === 0 && col === 0);
      assert.ok(parent?.clip, '부모 칸에 클립 영역이 있다');
      const innerCells = cells(inner);
      assert.equal(innerCells.length, 4);
      // 재저장 HWPX는 표 폭을, 96dpi 두 색 채움은 열 경계와 부모 클립 뒤 우변을 보여 준다.
      near(inner.bbox.w, width / huPerPx, '칸 안 표 폭');
      near(inner.bbox.x, 128, '칸 안 표 왼쪽');
      near(inner.bbox.y, mode === 'inline' ? 194 : 210, '칸 안 표 위쪽');
      near(right(parent.clip), 237, '부모 칸 클립 우변');
      for (const row of [0, 1]) {
        const left = innerCells.find((cell) => cell.row === row && cell.col === 0);
        const rightCell = innerCells.find((cell) => cell.row === row && cell.col === 1);
        assert.ok(left?.clip && rightCell?.clip);
        near(right(left.bbox), boundary, `행 ${row + 1} 왼쪽 열 우변`);
        near(rightCell.bbox.x, boundary, `행 ${row + 1} 오른쪽 열 좌변`);
        near(Math.min(right(rightCell.clip), right(parent.clip)), visibleRight, `행 ${row + 1} 보이는 우변`);
      }
    });
  }
}
