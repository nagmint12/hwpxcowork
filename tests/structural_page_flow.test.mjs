// 자연 흐름의 잠정 쪽은 그 사이에 다음 글자를 입력해도 끝까지 조판해야 한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { HwpDocument } from './helpers/rhwp.mjs';

const sourceDirectory = fileURLToPath(new URL('../benchmarks/typing-latency/', import.meta.url));
const sourceName = fs.readdirSync(sourceDirectory).find(name => /^08_.*\.hwpx$/.test(name));
const hash = value => createHash('sha256').update(value).digest('hex');

async function naturalParagraphs() {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(sourceDirectory, sourceName)));
  const sectionName = 'Contents/section0.xml';
  const source = await zip.file(sectionName).async('string');
  const styles = source.match(/<hp:p\s[\s\S]*?<\/hp:p>/g);
  assert.ok(styles?.[7]);
  const sentence = '자료 범위와 검토 기준을 확인한 뒤 같은 간격으로 기록합니다. ';
  const paragraphs = Array.from({ length: 216 }, (_, index) => {
    const paragraph = index === 0 ? styles[0] : styles[7];
    const marker = 'P' + String(index + 1).padStart(5, '0');
    return paragraph.replace(/\bid="\d+"/, `id="${index + 1}"`)
      .replace(/<hp:t>[^<]*<\/hp:t>/, `<hp:t>${marker} ${sentence.repeat(12)}${marker}</hp:t>`);
  });
  assert.ok(paragraphs.every(paragraph => !/pageBreak="1"|<hp:linesegarray\b/.test(paragraph)));
  zip.file(sectionName, source.slice(0, source.indexOf(styles[0])) + paragraphs.join('') + '</hs:sec>');
  return zip.generateAsync({ type: 'uint8array' });
}

function open(bytes, defer) {
  const doc = HwpDocument.openProgressive(bytes, 2);
  doc.setTypesetTailDeferral(defer);
  let state = JSON.parse(doc.progressiveOpenState());
  while (state.state === 'pending') state = JSON.parse(doc.stepProgressiveOpen(16));
  assert.equal(state.state, 'complete');
  if (!defer) doc.setTypesetResumeEnabled(false);
  return doc;
}

function assertSuccess(raw) {
  const result = JSON.parse(raw);
  assert.equal(result.ok, true, raw);
  return result;
}

function finish(doc, save) {
  if (!save) {
    for (let count = 0; doc.typesetTailPending(); count++) {
      assert.ok(count < 1000, '뒤쪽 조판이 계속 전진해야 합니다');
      assertSuccess(doc.stepTypesetTail(8));
    }
  }
  // Studio는 명시 저장에서 셀/텍스트 지연과 뒤쪽 조판을 모두 마칩니다.
  assertSuccess(doc.flushDeferredPagination());
  if (doc.typesetTailPending()) assertSuccess(doc.flushTypesetTail());
  assert.equal(doc.typesetTailPending(), false);
}

function equalPages(actual, expected) {
  assert.equal(actual.pageCount(), expected.pageCount(), '최종 쪽 수');
  for (let page = 0; page < expected.pageCount(); page++) {
    assert.equal(actual.getPositionOfPage(page), expected.getPositionOfPage(page), `${page + 1}쪽 시작 주소`);
    assert.equal(hash(actual.getPageTextLayout(page)), hash(expected.getPageTextLayout(page)), `${page + 1}쪽 텍스트 조판`);
  }
}

function equalSavedPages(actual, expected) {
  const expectedSaved = open(expected.exportHwpx(), false);
  const actualSaved = open(actual.exportHwpx(), false);
  try { equalPages(actualSaved, expectedSaved); }
  finally { actualSaved.free(); expectedSaved.free(); }
}

const input = await naturalParagraphs();
for (const [label, edit] of [
  ['Enter', (doc, sec, para) => doc.splitParagraph(sec, para, 24)],
  ['Ctrl+Enter', (doc, sec, para) => doc.insertPageBreak(sec, para, 24)],
]) {
  for (const save of [false, true]) {
    test(`${label} 뒤 첫 조판 조각과 다음 글자 입력을 거친 ${save ? '저장' : '유휴 조판'}은 전체 조판과 같다`, () => {
      const reference = open(input, false);
      const candidate = open(input, true);
      try {
        assert.equal(candidate.pageCount(), reference.pageCount());
        const middle = Math.floor(reference.pageCount() / 2);
        const { sec, para } = JSON.parse(reference.getPositionOfPage(middle));
        const target = para + 1;
        const expected = assertSuccess(edit(reference, sec, target));
        const actual = assertSuccess(edit(candidate, sec, target));
        assert.equal(actual.paraIdx, expected.paraIdx);
        assert.ok(candidate.typesetTailPending(), '이 시험지는 첫 편집 뒤에 남은 조판이 있어야 합니다');
        assert.equal(assertSuccess(candidate.stepTypesetTail(0)).status, 'pending', '다음 글자 직전에도 뒤쪽 조판이 진행 중입니다');
        for (const doc of [reference, candidate]) {
          const next = assertSuccess(doc.replaceBodyTextLocal(sec, actual.paraIdx, 0, 0, '새'));
          assert.equal(next.charOffset, 1);
          assert.equal(next.flowChanged, false, '다음 한 글자는 같은 줄에 들어갑니다');
        }
        const cursor = doc => JSON.parse(doc.getCursorRect(sec, actual.paraIdx, 1));
        assert.deepEqual(cursor(candidate), cursor(reference));
        finish(reference, save);
        finish(candidate, save);
        equalPages(candidate, reference);
        if (save) equalSavedPages(candidate, reference);
      } finally {
        candidate.free();
        reference.free();
      }
    });
  }
}

test('앞 구역에서 표를 추가해도 마지막 구역에 보류된 조판은 정확히 끝난다', async () => {
  const builder = new HwpDocument(input);
  let split;
  try {
    assertSuccess(builder.splitSection(0, 2, 0));
    assert.equal(builder.getSectionCount(), 2);
    split = builder.exportHwpx();
  } finally { builder.free(); }
  const archive = await JSZip.loadAsync(split);
  for (const name of ['Contents/section0.xml', 'Contents/section1.xml']) {
    const section = await archive.file(name).async('string');
    archive.file(name, section.replace(/<hp:linesegarray\b[^>]*>[\s\S]*?<\/hp:linesegarray>/g, ''));
  }
  const bytes = await archive.generateAsync({ type: 'uint8array' });
  const reference = open(bytes, false);
  const candidate = open(bytes, true);
  try {
    const middle = Math.floor(reference.pageCount() / 2);
    const { sec, para } = JSON.parse(reference.getPositionOfPage(middle));
    assert.equal(sec, 1, '편집 위치는 마지막 자연 흐름 구역');
    for (const doc of [reference, candidate]) assertSuccess(doc.insertPageBreak(sec, para + 1, 24));
    assert.ok(candidate.typesetTailPending());
    assert.equal(assertSuccess(candidate.stepTypesetTail(0)).status, 'pending');
    for (const doc of [reference, candidate]) {
      assertSuccess(doc.createTable(0, 1, 0, 2, 2));
      finish(doc, true);
    }
    equalPages(candidate, reference);
    equalSavedPages(candidate, reference);
  } finally {
    candidate.free();
    reference.free();
  }
});

test('긴 표에서 쪽 경계를 넘긴 줄은 즉시 보이고 연속 Enter와 앞 행 편집을 거쳐 저장된다', (t) => {
  // 8,000HU 88행×2열 단일 표. 5쪽 마지막 R0045의 오른쪽 칸에 다섯 문단이 있다.
  const bytes = fs.readFileSync(new URL('./fixtures/layout/structural-table-window.hwpx', import.meta.url));
  const reference = open(bytes, false);
  const candidate = open(bytes, true);
  try {
    const table = JSON.parse(reference.getObjects()).find(object => object.kind === 'table');
    assert.deepEqual({ para: table.para, control: table.controlIndex }, { para: 0, control: 2 });
    assert.equal(reference.pageCount(), 10);
    const edit = (cell, paragraph, offset) => {
      for (const doc of [reference, candidate]) {
        const result = assertSuccess(doc.splitParagraphInCell(0, table.para, table.controlIndex, cell, paragraph, offset));
        assert.equal(result.cellParaIndex, paragraph + 1);
      }
    };
    const visible = (doc, page) => JSON.parse(doc.getPageTextLayout(page)).runs;
    const caret = (doc, cell, paragraph, hint) => JSON.parse(doc.getCursorRectByPathNear(
      0, table.para, JSON.stringify([{ controlIndex: table.controlIndex, cellIndex: cell, cellParaIndex: paragraph }]), 0, hint,
    ));
    const matchWindow = (firstPage, cell, paragraph, expectedCaretPage) => {
      const expected = caret(reference, cell, paragraph, firstPage);
      assert.equal(expected.pageIndex, expectedCaretPage);
      assert.deepEqual(caret(candidate, cell, paragraph, firstPage), expected);
      for (const page of [firstPage, firstPage + 1]) {
        assert.deepEqual(visible(candidate, page), visible(reference, page), `${page + 1}쪽의 즉시 표시`);
        assert.equal(candidate.getPageRenderTree(page), reference.getPageRenderTree(page), `${page + 1}쪽의 그리기 트리`);
        assert.equal(candidate.getPageControlLayout(page), reference.getPageControlLayout(page), `${page + 1}쪽의 표와 칸 주소`);
      }
    };

    assert.ok(visible(reference, 4).some(run => run.cellIdx === 88 && run.text === 'R0045'));
    const tablePaints = doc => JSON.parse(doc.typesetResumeStats()).tablePaints;
    const paintsBefore = tablePaints(candidate);
    edit(89, 4, 1);
    matchWindow(4, 89, 5, 5);
    if (typeof paintsBefore === 'number') {
      const painted = tablePaints(candidate) - paintsBefore;
      assert.ok(painted > 0, '현재 두 쪽의 실제 부분 그리기');
      t.diagnostic(`현재/다음 쪽 부분 그리기 ${painted}회`);
    }
    assert.ok(visible(candidate, 5).some(run => run.cellIdx === 89 && run.cellParaIdx === 5 && run.text === '기'));
    if (candidate.typesetTailPending()) assertSuccess(candidate.stepTypesetTail(0));
    edit(89, 5, 0);
    matchWindow(4, 89, 6, 5);

    // 우선 처리한 칸의 뒤쪽 조판이 진행 중인 상태에서 앞의 다른 행을 편집한다.
    if (typeof paintsBefore === 'number') t.diagnostic(`앞 행 편집 직전 뒤쪽 조판 대기 ${candidate.typesetTailPending()}`);
    assert.ok(visible(reference, 2).some(run => run.cellIdx === 44 && run.text === 'R0023'));
    edit(45, 0, 1);
    matchWindow(2, 45, 1, 2);
    finish(reference, true);
    finish(candidate, true);
    equalPages(candidate, reference);
    matchWindow(4, 89, 6, 5);
    equalSavedPages(candidate, reference);
  } finally {
    candidate.free();
    reference.free();
  }
});
