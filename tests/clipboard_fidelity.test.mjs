import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { HwpDocument, hwpxToHwpJson } from './helpers/rhwp.mjs';

const manual = fs.readFileSync(new URL('../docs/manuals/01 따라하기 — 한글과 복사·붙여넣기.hwpx', import.meta.url));
const shapes = fs.readFileSync(new URL('./fixtures/shapes_hangul.hwpx', import.meta.url));
const section = async (bytes, index = 0) => (await JSZip.loadAsync(bytes)).file(`Contents/section${index}.xml`).async('string');
const paragraphs = xml => {
  let depth = 0;
  const out = [];
  for (const match of xml.matchAll(/<hp:p\b[^>]*>|<\/hp:p>/g)) {
    if (match[0] === '</hp:p>') depth--;
    else if (depth++ === 0) out.push(match[0]);
  }
  return out;
};
const board = doc => JSON.parse(/<!--\[data-hwpjson\]([\s\S]*?)-->/.exec(doc.exportClipboardHancomHtml())[1]);
const rectangle = model => Object.values(model.cs).find(c => c.rc?.ci === 611476835);
const corners = rect => Array.from({ length: 4 }, (_, i) => [rect.rc[`x${i}`], rect.rc[`y${i}`]]);

test('portable 복사는 원본 쪽 나누기를 보존하고 자동 경계는 HTML 표시 사본에만 싣는다', async () => {
  const doc = new HwpDocument(manual);
  try {
    const saved = await section(doc.exportHwpx(), 1);
    const original = paragraphs(saved);
    const last = doc.getParagraphCount(1) - 1;
    const starts = [];
    for (let i = 1; i <= last; i++) {
      const previousEnd = JSON.parse(doc.getCursorRect(1, i - 1, doc.getParagraphLength(1, i - 1))).pageIndex;
      const currentStart = JSON.parse(doc.getCursorRect(1, i, 0)).pageIndex;
      if (currentStart > previousEnd && /pageBreak="0"/.test(original[i])) starts.push(i);
    }
    assert.ok(starts.length > 0, '기존 한글 표본에 자동 쪽 경계가 있다');
    doc.copySelection(1, 0, 0, last, doc.getParagraphLength(1, last));
    const copied = paragraphs(await section(doc.exportClipboardHwpx()));
    const flags = rows => rows.map(p => [p.match(/pageBreak="([^"]*)"/)?.[1], p.match(/columnBreak="([^"]*)"/)?.[1]]);
    assert.deepEqual(flags(copied), flags(original), '자동 쪽 경계로 원본의 강제 나누기 속성을 바꾸지 않는다');
    assert.ok(Object.values(board(doc).ro).some(p => p?.ru && (p.bf & 4)), '기존 HTML 대체 경로에는 표시용 쪽 경계를 유지한다');
    assert.equal(await section(doc.exportHwpx(), 1), saved, '복사는 원문 쪽 나눔을 수정하지 않는다');

    doc.copySelection(1, 0, 0, last - 1, 0);
    const partial = paragraphs(await section(doc.exportClipboardHwpx()));
    assert.deepEqual(flags(partial), flags(original.slice(0, partial.length)), '부분 선택도 원본의 강제 나누기만 보존한다');
  } finally { doc.free(); }
});

test('튜토리얼 HTML 표시 사본은 쪽 경계를 싣고 portable 조각은 원본 나누기를 유지한다', async () => {
  const doc = new HwpDocument(manual);
  try {
    const text = p => doc.getTextRange(1, p, 0, doc.getParagraphLength(1, p));
    const indices = Array.from({ length: doc.getParagraphCount(1) }, (_, i) => i);
    const before = indices.find(i => text(i).startsWith('쪽 아래 꼬리말에는'));
    const heading = indices.find(i => text(i) === '4) 엉뚱한 서식');
    const start = indices.find(i => text(i).startsWith('▼'));
    const end = indices.find(i => text(i).startsWith('▲'));
    assert.ok(before >= 0 && heading > before && start < before && end > heading);
    // 독립 기준: 웹에서 이 안내는 앞 쪽, 제목·굵게/기울임 예시는 다음 쪽이다.
    assert.ok(JSON.parse(doc.getCursorRect(1, heading, 0)).pageIndex >
      JSON.parse(doc.getCursorRect(1, before, doc.getParagraphLength(1, before))).pageIndex);
    const original = await section(doc.exportHwpx(), 1);
    for (const [name, a, b] of [['튜토리얼 영역', start, end], ['경계 부분', before, heading + 1]]) {
      doc.copySelection(1, a, 0, b, doc.getParagraphLength(1, b));
      const xml = await section(doc.exportClipboardHwpx());
      const from = xml.indexOf('쪽 아래 꼬리말에는');
      const to = xml.indexOf('4) 엉뚱한 서식', from);
      assert.ok(from >= 0 && to > from);
      const flags = rows => rows.map(p => p.match(/pageBreak="([^"]*)"/)?.[1]);
      const selected = paragraphs(xml);
      assert.deepEqual(flags(selected), flags(paragraphs(original).slice(a, a + selected.length)), `${name}: portable 조각은 원본의 강제 쪽 나누기를 유지한다`);
      const model = board(doc);
      const modelParagraphs = Object.values(model.ro).filter(v => v && typeof v === 'object');
      const paragraphText = p => p.ru.flatMap(r => r.ch).map(c => c.t || '').join('');
      const left = modelParagraphs.findIndex(p => paragraphText(p).startsWith('쪽 아래 꼬리말에는'));
      const right = modelParagraphs.findIndex(p => paragraphText(p) === '4) 엉뚱한 서식');
      assert.ok(modelParagraphs.slice(left + 1, right + 1).some(p => (p.bf & 4) !== 0), `${name}: 한글 HTML 모델에도 쪽 나눔`);
    }
    doc.copySelection(1, heading, 0, heading + 3, doc.getParagraphLength(1, heading + 3));
    assert.ok(paragraphs(await section(doc.exportClipboardHwpx())).every(p => /pageBreak="0"/.test(p)),
      '같은 쪽에서 시작하는 부분 선택은 첫 문단에 원본의 자동 쪽 나눔을 새로 넣지 않는다');
    assert.equal(await section(doc.exportHwpx(), 1), original, '복사는 원문을 수정하지 않는다');
  } finally { doc.free(); }
});

test('한글 문서모델: 쪽 나누기와 단 나누기를 서로 다른 속성으로 왕복한다', async () => {
  const zip = await JSZip.loadAsync(shapes);
  let index = -1;
  let depth = 0;
  const xml = (await section(shapes)).replace(/<hp:p\b[^>]*>|<\/hp:p>/g, tag => {
    if (tag === '</hp:p>') { depth--; return tag; }
    if (depth++ !== 0) return tag;
    index++;
    if (index === 3) return tag.replace('pageBreak="0"', 'pageBreak="1"');
    if (index === 4) return tag.replace('columnBreak="0"', 'columnBreak="1"');
    return tag;
  });
  zip.file('Contents/section0.xml', xml);
  const model = JSON.parse(hwpxToHwpJson(await zip.generateAsync({ type: 'uint8array' }), true)).json;
  const target = HwpDocument.createEmpty();
  try {
    assert.equal(JSON.parse(target.pasteHwpJsonFragment(0, 0, '[]', 0, JSON.stringify(model))).ok, true);
    const out = paragraphs(await section(target.exportHwpx()));
    assert.match(out[3], /pageBreak="1"/);
    assert.match(out[3], /columnBreak="0"/);
    assert.match(out[4], /pageBreak="0"/);
    assert.match(out[4], /columnBreak="1"/);
    assert.ok(out.every(p => /merged="0"/.test(p)), '단 나누기는 문단 합치기 표식이 아니다');
  } finally { target.free(); }
});

for (const angle of [34, 90, 180, 270, -45]) test(`회전 사각형 ${angle}도: 한글용 꼭짓점·각도·선·채우기와 재복사를 보존한다`, async () => {
  const doc = new HwpDocument(shapes);
  const target = HwpDocument.createEmpty();
  try {
    doc.copyControl(0, 3, '', 0);
    const before = rectangle(board(doc));
    doc.setShapeProperties(0, 3, 0, JSON.stringify({ rotationAngle: angle }));
    doc.copyControl(0, 3, '', 0);
    const copied = rectangle(board(doc));
    const pts = corners(copied);
    assert.equal(copied.rc.ra, angle);
    const radians = angle * Math.PI / 180;
    const width = 9500;
    assert.ok(Math.abs((pts[1][0] - pts[0][0]) - width * Math.cos(radians)) <= 1, '윗변 가로 성분');
    assert.ok(Math.abs((pts[1][1] - pts[0][1]) - width * Math.sin(radians)) <= 1, '윗변 세로 성분');
    assert.deepEqual(copied.rc.ls, before.rc.ls);
    assert.deepEqual(copied.rc.fb, before.rc.fb);
    for (const key of ['pta', 'tw', 'tf', 'lo', 'zo', 'spr', 'pvr', 'phr', 'pvo', 'ph2']) assert.equal(copied[key], before[key], key);
    assert.equal(Object.values(board(doc).cs).filter(c => c.rc?.ci === 611346787).length, 0, '그림으로 바꾸지 않는다');
    const portable = await section(doc.exportClipboardHwpx());
    assert.ok(portable.includes(`<hp:rotationInfo angle="${angle}"`));
    assert.match(portable, /<hc:pt1 x="9500" y="0"/);
    assert.match(portable, /<hp:sz width="9500"/);

    target.pasteHwpJsonFragment(0, 0, '[]', 0, JSON.stringify(board(doc)));
    target.copyControl(0, 0, '', 0);
    assert.deepEqual(corners(rectangle(board(target))), pts, '다시 복사할 때 회전을 중복 적용하지 않는다');
  } finally { doc.free(); target.free(); }
});
