import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HwpxDoc } from '../engine/doc.js';
import { formattingPartsFor, importFormattingRefs } from '../engine/formatting.js';
import { pasteWithParagraphFormat } from '../studio/build/native-paste.mjs';
import { startServer, uploadDoc } from './helpers/server.mjs';

const pkg = path.resolve(process.env.RHWP_PKG || 'vendor/rhwp/pkg');
const { initSync, HwpDocument } = await import(pathToFileURL(path.join(pkg, 'rhwp.js')));
initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
const blank = fs.readFileSync(new URL('../server/templates/blank.hwpx', import.meta.url));
const ref = 's0/p0';
const ns = 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar';
const margin = (left, indent, unit = 'HWPUNIT') => `<hh:margin><hc:intent value="${indent}" unit="${unit}"/><hc:left value="${left}" unit="HWPUNIT"/></hh:margin>`;
const spacing = (type, value) => `<hh:lineSpacing type="${type}" value="${value}" unit="HWPUNIT"/>`;
const branches = (selected, fallback) => `<hp:switch><hp:case hp:required-namespace="${ns}">${selected}</hp:case><hp:default>${fallback}</hp:default></hp:switch>`;

async function fixture(version, units) {
  const doc = await HwpxDoc.load(blank);
  doc.container.setText('version.xml', doc.container.getText('version.xml').replace('xmlVersion="1.5"', `xmlVersion="${version}"`));
  const first = doc.header.block('paraPr', '0');
  doc.header.xml = doc.header.xml.replace(first, first.replace(/<hp:switch>.*?<\/hp:switch>/s, units));
  return doc;
}

test('평문 여백과 호환 줄간격 분기 및 홀수 고정 길이의 태그 쌍을 보존한다', async () => {
  const percent = spacing('PERCENT', 180);
  const onlySpacing = branches(percent, percent);
  const pairedFixed = spacing('FIXED', 2001).replace('/>', '></hh:lineSpacing>');
  const cases = [
    ['1.2', '1.5', margin(3200, 0) + onlySpacing, [10.7, 180, 'Percent']],
    ['1.5', '1.2', margin(1600, 0) + onlySpacing, [21.3, 180, 'Percent']],
    ['1.2', '1.5', margin(3200, 0) + pairedFixed, [21.3, 13.3, 'Fixed']],
  ];

  const readLayout = async (doc) => {
    const opened = new HwpDocument(await doc.save());
    try {
      const { marginLeft, lineSpacing, lineSpacingType } = JSON.parse(opened.getParaPropertiesAt(0, 0));
      return [marginLeft, lineSpacing, lineSpacingType];
    } finally { opened.free(); }
  };
  for (const [from, into, units, expected] of cases) {
    const source = await fixture(from, units);
    const target = await fixture(into, units);
    assert.deepEqual(await readLayout(source), expected);
    const parts = formattingPartsFor(source, target);
    target.header = parts.header;
    target.container.setText('version.xml', parts.versionXml);
    assert.deepEqual(await readLayout(target), expected, `${from} → ${into}`);
  }
});

test('서식 복사와 개체 참조가 판본별 길이를 양방향으로 옮기며 기존 정의와 원본을 보존한다', async () => {
  for (const [from, into, sourceUnits, expected] of [
    ['1.2', '1.10', margin(3200, -519) + spacing('FIXED', 2000), margin(1600, -260, 'CHAR') + spacing('FIXED', 1000)],
    ['1.5', '1.2', margin(1600, -260, 'CHAR') + spacing('BETWEEN_LINES', 1000), margin(3200, -519) + spacing('BETWEEN_LINES', 2000)],
    ['1.2', '1.4', branches(margin(3200, -519) + spacing('PERCENT', 180), margin(6400, -1038) + spacing('PERCENT', 180)),
      branches(margin(1600, -260, 'CHAR') + spacing('PERCENT', 180), margin(3200, -519) + spacing('PERCENT', 180))],
    ['1.5', '1.2', branches(margin(1600, -260) + spacing('AT_LEAST', 1000), margin(3200, -519) + spacing('AT_LEAST', 2001)),
      branches(margin(3200, -519) + spacing('AT_LEAST', 2001), margin(6400, -1038) + spacing('AT_LEAST', 4002))],
  ]) {
    const source = await fixture(from, sourceUnits);
    // 원시 XML이 같아도 두 문서의 실제 길이는 다르다.
    const target = await fixture(into, sourceUnits);
    const original = source.header.xml;
    const targetZero = target.header.block('paraPr', '0');
    const xml = importFormattingRefs(target, source, '<hp:p paraPrIDRef="0"/>');
    const id = /paraPrIDRef="(\d+)"/.exec(xml)[1];
    assert.notEqual(id, '0');
    assert.ok(target.header.block('paraPr', id).includes(expected), from + ' → ' + into);
    await target.copyFormattingBatch(source, [{ sourceRef: ref, targetRef: ref }]);
    assert.equal(target.inspectFormatting(ref).paraPrId, id);
    assert.equal(target.header.block('paraPr', '0'), targetZero);
    assert.equal(source.header.xml, original);
  }
});

test('홀수 고정 길이와 상대 내어쓰기 및 단위 없는 여백을 재저장할 수 있다', async () => {
  const source = await fixture('1.2', margin(3200, -519) + spacing('FIXED', 2001));
  const target = await HwpxDoc.load(blank);
  const modern = source.inFormattingUnitsOf(target);
  const selected = margin(1600, -260, 'CHAR') + spacing('FIXED', 1000);
  const fallback = margin(3200, -519) + spacing('FIXED', 2001);
  assert.ok(modern.header.block('paraPr', '0').includes(branches(selected, fallback)));
  const tabDefs = doc => doc.header.xml.match(/<hh:tabProperties\b.*?<\/hh:tabProperties>/s)[0];
  assert.equal(tabDefs(modern), tabDefs(source));
  const lengths = async doc => {
    const native = new HwpDocument(await doc.save());
    try {
      const { marginLeft, indent, lineSpacing, lineSpacingType } = JSON.parse(native.getParaPropertiesAt(0, 0));
      return { marginLeft, indent, lineSpacing, lineSpacingType };
    } finally { native.free(); }
  };
  assert.deepEqual(await lengths(modern), await lengths(source));
  assert.deepEqual(await lengths(modern.inFormattingUnitsOf(source)), await lengths(source));
  const independent = '<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/paragraph"><hh:heading type="OUTLINE" idRef="0" level="8"/></hp:case><hp:default><hh:heading type="NONE" idRef="0" level="0"/></hp:default></hp:switch>';
  const unitless = '<hh:margin right="2200"><hc:left value="3200"/></hh:margin>';
  const plain = await fixture('1.2', independent + unitless + spacing('PERCENT', 180));
  assert.equal(plain.inFormattingUnitsOf(target).header.block('paraPr', '0'), plain.header.block('paraPr', '0'));
  const mixed = await fixture('1.2', unitless + spacing('FIXED', 2001));
  const mixedModern = mixed.inFormattingUnitsOf(target);
  assert.deepEqual(await lengths(mixedModern), await lengths(mixed));
  assert.deepEqual(await lengths(mixedModern.inFormattingUnitsOf(mixed)), await lengths(mixed));
});

test('목차를 빈 문서와 글이 있는 문서에 붙여넣어 저장·재전송·재열기하면 글·여백·탭·용지가 보존된다', async () => {
  const source = await fixture('1.2', margin(3200, -800) + spacing('PERCENT', 180));
  const tab = source.header.addItem('tabProperties', 'tabPr', '<hh:tabPr id="0" autoTabLeft="0" autoTabRight="0">' +
    branches('<hh:tabItem pos="42520" type="RIGHT" leader="DASH" unit="HWPUNIT"/>', '<hh:tabItem pos="85040" type="RIGHT" leader="DASH"/>') + '</hh:tabPr>');
  const first = source.header.block('paraPr', '0');
  source.header.xml = source.header.xml.replace(first, first.replace('tabPrIDRef="0"', `tabPrIDRef="${tab}"`));
  source.insertTracked(ref, 0, '목 차', { author: '시험' });
  source.insertParagraphAfter(0, 0, '', { author: '시험' });
  source.insertParagraphAfter(0, 1, '제1장|3', { author: '시험' });
  source.acceptAll();
  const sec = source.sections[0];
  sec.load(sec.xml.replace('제1장|3', '제1장<hp:tab width="29920" leader="3" type="2"/>3')
    .replace(/(<hp:pagePr\b[^>]*\bwidth=")\d+"/, (_, prefix) => prefix + '50000"'));
  const native = new HwpDocument(await source.save());
  let fragment;
  try {
    native.convertToEditable();
    native.copySelection(0, 0, 0, 2, native.getParagraphLength(0, 2));
    fragment = native.exportClipboardHwpx();
    const portable = await HwpxDoc.load(fragment);
    const hancom = await HwpxDoc.load(native.exportClipboardHwpxHancom());
    assert.match(portable.header.xml, /<hh:tabItem pos="42520" type="RIGHT" leader="DASH" unit="HWPUNIT"\/>/);
    assert.match(hancom.container.getText('version.xml'), /xmlVersion="1\.2"/);
    assert.match(hancom.header.xml, /<hh:tabPr [^>]*><hh:tabItem pos="85040" type="RIGHT" leader="DASH"\/><\/hh:tabPr>/);
  } finally { native.free(); }

  const server = await startServer();
  const headers = { Authorization: 'Bearer ' + server.tokens.a, 'Content-Type': 'application/octet-stream' };
  try {
    for (const position of ['newDocument', 'afterText', 'emptyParagraph']) {
      const occupied = position !== 'newDocument';
      const firstToc = position === 'emptyParagraph' ? 1 : 0;
      const editor = new HwpDocument(blank);
      let bytes, record;
      try {
        editor.convertToEditable();
        if (occupied) editor.insertText(0, 0, 0, '기존 ');
        if (firstToc) editor.splitParagraph(0, 0, editor.getParagraphLength(0, 0));
        record = await uploadDoc(server.base, server.tokens.a, editor.exportHwpx(), '목차.hwpx');
        const result = JSON.parse(pasteWithParagraphFormat(editor, HwpDocument, 0, firstToc, '[]', editor.getParagraphLength(0, firstToc), fragment));
        assert.equal(result.ok, true);
        assert.equal(!!result.adoptedDocument, !occupied);
        bytes = editor.exportHwpx();
      } finally { editor.free(); }
      const url = server.base + '/api/docs/' + record.id;
      for (const seq of [41001, 41002]) {
        const response = await fetch(url + '/live?base=1&loaded=1&seq=' + seq, { method: 'PUT', headers, body: bytes });
        const out = await response.json();
        assert.equal(response.status, 200, JSON.stringify(out));
        assert.equal(out.clean, true);
        assert.equal(out.version, 2);
        assert.equal(out.unsupported, 0);
        if (seq === 41002) assert.deepEqual(out.applied, { changed: [], inserted: [], deleted: [] });
      }
      const response = await fetch(url + '/file?kind=working', { headers });
      assert.equal(response.status, 200);
      const saved = new Uint8Array(await response.arrayBuffer());
      const doc = await HwpxDoc.load(saved);
      assert.match(doc.container.getText('version.xml'), /xmlVersion="1\.5"/);
      const heading = position === 'afterText' ? '기존 목 차' : '목 차';
      assert.deepEqual(doc.bodyEntries()[0].map(p => p.text), [...(firstToc ? ['기존 '] : []), heading, '', '제1장\t3']);
      assert.match(doc.sections[0].xml, /<hp:tab\b[^>]*width="29920"[^>]*leader="3"[^>]*type="2"/);
      assert.equal(/<hp:pagePr\b[^>]*\bwidth="50000"/.test(doc.sections[0].xml), !occupied);
      const reopened = new HwpDocument(saved);
      try {
        const props = JSON.parse(reopened.getParaPropertiesAt(0, firstToc + 2));
        // 3200 / 200 = 16pt = 21.33px. 잘못된 1.5 평문 3200은 42.67px이 된다.
        assert.equal(props.marginLeft, 21.3);
        assert.equal(props.indent, -5.3);
        assert.equal(props.lineSpacing, 180);
        assert.deepEqual(props.tabStops, [{ position: 85040, type: 1, fill: 3 }]);
        assert.equal(JSON.parse(reopened.getParaPropertiesAt(0, firstToc)).marginLeft, position === 'afterText' ? 0 : 21.3);
        reopened.convertToEditable();
        const again = await fetch(url + '/live?base=2&loaded=2&seq=42001', { method: 'PUT', headers, body: reopened.exportHwpx() });
        const out = await again.json();
        assert.equal(again.status, 200, JSON.stringify(out));
        assert.equal(out.clean, true);
        assert.equal(out.version, 2);
      } finally { reopened.free(); }
    }
  } finally { await server.stop(); }
});
