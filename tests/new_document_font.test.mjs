import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { HwpxDoc } from '../engine/doc.js';
import { elements } from '../engine/page-layout.js';
import { HwpDocument } from './helpers/rhwp.mjs';

async function checkBody(engine, family) {
  const doc = await HwpxDoc.load(engine.exportHwpx());
  const style = doc.header.style({ name: '바탕글' });
  assert.equal(doc.header.charHeight(style.charPr), 1000);
  assert.ok(doc.sections[0].bodyParas[0].runs.every(run => run.charPr === style.charPr));
  const ref = elements(doc.header.block('charPr', style.charPr), 'hh:fontRef')[0];
  const groups = elements(doc.header.xml, 'hh:fontface');
  for (const slot of ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user']) {
    const group = groups.find(el => el.attrs.lang === slot.toUpperCase());
    const face = elements(group.xml, 'hh:font').find(el => el.attrs.id === ref.attrs[slot]);
    assert.equal(face.attrs.face, family, slot);
  }
}

test('편집기 새 문서의 첫 입력과 HWP·HWPX 재열기는 본고딕 10pt를 유지한다', async () => {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, 'a2.한');
    await checkBody(doc, 'Noto Sans KR');
    for (const bytes of [doc.exportHwp(), doc.exportHwpx()]) {
      const reopened = new HwpDocument(bytes);
      try { await checkBody(reopened, 'Noto Sans KR'); } finally { reopened.free(); }
    }
  } finally { doc.free(); }
});

test('같은 HWP 서식을 파일로 열면 원래 바탕글이 유지된다', async () => {
  const bytes = await fs.readFile(new URL('../vendor/rhwp/saved/blank2010.hwp', import.meta.url));
  const doc = new HwpDocument(bytes);
  try { await checkBody(doc, '함초롬바탕'); } finally { doc.free(); }
});
