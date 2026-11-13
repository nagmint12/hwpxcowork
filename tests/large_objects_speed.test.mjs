// node --test tests/large_objects_speed.test.mjs — 개체가 많은 문서의 밀어 넣기 속도 고침(2026-11-10)이 결과를 바꾸지 않는가.
// 계기: 구역 XML 8.5MB·글상자 4천여 개 문서에서 빈 문단과 다음 쪽 문단을 합친 밀어 넣기 한 번이 7초 걸리고 그동안 서버가 최대 5초 멈췄다.
// 고친 것: ① 개체를 옮길 때 id 가 겹치는지 문서 전체 글을 개체마다 다시 훑던 것을 id 색인으로(idTaken) ② 같은 문서 상태의 _objectInfo 를
// 다시 세지 않음(구역 읽은 차례 stamp 열쇠) ③ 도형 비교 속성을 셀 때 글상자 글(hp:subList 안)을 나무로 만들지 않음 + 같은 XML 은 기억
// ④ diffDocs·밀어 넣기가 큰 단계 사이에 이벤트 루프에 차례를 내줌(yieldEvery). 시간 한도는 시험하지 않는다(PC 마다 다르다) — 결과가 같은지만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { shapeProps, shapePrintText } from '../engine/shapes.js';
import { fixture } from './helpers/server.mjs';

const reload = async (d) => HwpxDoc.load(await d.save());
const BOX = 's0/p7';   // shapes_hangul: 글상자('글상자 안 글')

/** 글상자 문단(s0/p7)의 글상자를 n 개로 늘린 문서 — 사본마다 id·instid·글을 새로(id 는 1000+i) */
async function manyBoxes(n) {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('shapes_hangul.hwpx')));
  const sec = d.sections[0]; const a = d.resolve(BOX).p.anchors.find((x) => x.kind === 'ctrl' && x.name === 'hp:rect');
  const one = sec.xml.slice(a.start, a.end);
  let add = '';
  for (let i = 0; i < n - 1; i++) {
    add += one.replace(/^<hp:rect\b[^>]*>/, (o) => o.replace(/\sid="\d+"/, ` id="${1000 + i}"`).replace(/\sinstid="\d+"/, ` instid="${5000 + i}"`)).replace('글상자 안 글', `상자 ${i}`);
  }
  sec.load(sec.xml.slice(0, a.end) + add + sec.xml.slice(a.end));
  return reload(d);
}

test('도형 비교 속성: 글상자 글(hp:subList 안)만 다른 두 글상자는 같고, 상자 속성이 다르면 다르다', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('shapes_hangul.hwpx')));
  const sec = d.sections[0]; const a = d.resolve(BOX).p.anchors.find((x) => x.kind === 'ctrl' && x.name === 'hp:rect');
  const xml = sec.xml.slice(a.start, a.end);
  const other = xml.replace('글상자 안 글', '전혀 다른 글<hp:lineBreak/>둘째 줄');
  assert.notEqual(other, xml);
  assert.equal(shapePrintText(shapeProps(other)), shapePrintText(shapeProps(xml)));
  const wider = xml.replace(/<hp:sz width="(\d+)"/, (m, w) => `<hp:sz width="${Number(w) + 100}"`);
  assert.notEqual(shapePrintText(shapeProps(wider)), shapePrintText(shapeProps(xml)));
  // 글 목록 짝이 깨진 XML 은 그대로 센다(던지지 않는다)
  assert.doesNotThrow(() => shapeProps(xml.replace('</hp:subList>', '')));
});

test('_objectInfo 기억: 같은 상태면 같은 결과, 도형을 고치거나 구역을 통째로 바꾸면 다시 센다', async () => {
  const d = await manyBoxes(5);
  const p0 = d.objectPrint(BOX);
  assert.equal(d._objectInfo(BOX), d._objectInfo(BOX), '같은 상태는 같은 값');
  assert.equal(d._objectInfo(BOX).shapes.length, 5);
  // 첫 글상자 폭을 바꿈(구역을 다시 읽음) → 지문이 바뀐다
  const sec = d.sections[0]; const a = d.resolve(BOX).p.anchors.find((x) => x.kind === 'ctrl' && x.name === 'hp:rect');
  const hd = sec.xml.indexOf('<hp:sz width="', a.start);
  sec.load(sec.xml.slice(0, hd) + sec.xml.slice(hd).replace(/<hp:sz width="(\d+)"/, (m, w) => `<hp:sz width="${Number(w) + 200}"`));
  assert.notEqual(d.objectPrint(BOX), p0);
  // 구역을 통째로 바꿔 끼움(flattenSections — 새 Section) → 그 구역의 새 값
  const two = await reload(d);
  const before = two.objectPrint('s1/p0');
  two.flattenSections();
  const after = two.paragraphs({ nested: false }).map((p) => p.ref);
  assert.ok(after.every((r) => r.startsWith('s0/')));
  assert.equal(typeof two.objectPrint('s0/p0'), 'string');
  assert.equal(typeof before, 'string');
});

test('copyObjectsFrom: 글상자 수십 개를 옮겨 와도(id 색인 길) 겹치는 id·instid 는 새 번호, 결과 지문은 보낸 문단과 같다', async () => {
  const src = await manyBoxes(30);
  // 대상: 글상자 문단을 비운 문서 — 옮겨 올 글상자와 같은 id 가 다른 문단(s0/p9 묶음 등)에 있을 수도 있게, 원래 글상자 하나는 다른 문단에 남긴다
  const dst = await manyBoxes(30);
  dst.removeOwnObjects(BOX);
  // 같은 id 를 쓰는 글상자를 문서에 남겨 두어 겹치게: s0/p3(사각형) 문단에 원본 글상자 사본(id 1000~1029 그대로)
  const sec = dst.sections[0]; const p3 = dst.resolve('s0/p3').p; const at = p3.anchors.find((x) => x.kind === 'ctrl').end;
  const srcSec = src.sections[0]; const own = src.resolve(BOX).p.anchors.filter((x) => x.kind === 'ctrl' && x.name === 'hp:rect');
  sec.load(sec.xml.slice(0, at) + own.slice(1, 11).map((x) => srcSec.xml.slice(x.start, x.end)).join('') + sec.xml.slice(at));
  assert.equal(dst.copyObjectsFrom(src, BOX, BOX), true);
  const r = await reload(dst);
  assert.equal(r.objectPrint(BOX), src.objectPrint(BOX));
  const all = r.sections.map((s) => s.xml).join('');
  for (const k of ['id', 'instid']) {
    const vals = [...all.matchAll(new RegExp(`<hp:(?:rect|line|ellipse|arc|polygon|curve|connectLine|container|pic|tbl)\\b[^>]*?\\s${k}="(\\d+)"`, 'g'))].map((m) => m[1]).filter((v) => v !== '0');
    assert.equal(new Set(vals).size, vals.length, `${k} 가 겹치지 않는다`);
  }
});

test('diffDocs: yieldEvery 로 나눠 돌아도 덩어리가 같다(같은 구역 수 · 구역 수가 다른 이은 비교)', async () => {
  const base = await manyBoxes(40);
  const head = await reload(base);
  // 글상자 글 하나·본문 글 하나를 고치고 한 글상자 폭을 바꾼다
  const hs = head.sections[0];
  hs.load(hs.xml.replace('상자 3<', '상자 셋<').replace('AAAA two', 'AAAA 둘'));
  const plain = await diffDocs(base, head);
  const sliced = await diffDocs(base, head, { yieldEvery: 1 });
  const key = (r) => JSON.stringify(r.hunks.map((h) => [h.type, h.ref, h.newText]));
  assert.equal(key(sliced), key(plain));
  assert.ok(plain.hunks.length >= 2);
  // 구역 수가 다르면(이은 비교) 안에서 나눠 돈다 — 덩어리는 나누지 않은 것과 같다
  const merged = await reload(head); merged.flattenSections();
  const a = await diffDocs(base, merged); const b = await diffDocs(base, merged, { yieldEvery: 1 });
  assert.equal(key(b), key(a));
  assert.ok(a.sections);
});
