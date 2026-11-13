// node --test tests/object_numbering.test.mjs — 개체 속성 '번호 종류'(없음·그림·표·수식)와 캡션 자동 번호 셈이 한/글과 같은가.
//  1) 한/글 2022 실측 시험지(tests/fixtures/numbering/ — 번호 종류 × 캡션 번호 종류 × 본문·칸·글상자 번호 × 새 번호로 시작)를 편집기 엔진이
//     열어 매긴 번호 = 한/글이 열고 다시 저장한 hp:autoNum num (hangul_numbers.json)
//  2) 편집기에서 새로 만든 표·그림·수식의 번호 종류(표·그림·수식 — 종전 표·그림은 '없음'이라 캡션이 모두 '표 1'), 캡션 넣기 글(번호 종류를
//     따라 '표 N '·'그림 N ', 없음이면 빈 캡션), 속성 창으로 번호 종류 바꾸기 → 번호 다시 매김 · 새 번호로 시작 77 → 77·78
//  3) 서버 diffDocs: 편집기에서 바꾼 표·그림 번호 종류가 서버 문서로 옮겨진다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const FXDIR = path.join(root, 'tests', 'fixtures', 'numbering');
const ORACLE = JSON.parse(fs.readFileSync(path.join(FXDIR, 'hangul_numbers.json'), 'utf8'));
const BASE = path.join(root, 'tests', 'fixtures', 'codes_hangul_cells.hwpx'); // 한/글 문서 — 캡션 표 하나('표 1')
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const sectionXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/section0.xml').async('string');
const hasNumbering = (doc) => 'numberingType' in JSON.parse(doc.getTableProperties(0, tablePara(doc), 0));
function tablePara(doc) {
  for (let p = 0; p < doc.getParagraphCount(0); p++) { try { doc.getTableProperties(0, p, 0); return p; } catch { /* 표 아님 */ } }
  return -1;
}
/** 시험지의 표지 글('T1:표 ') 다음 autoNum 의 번호 — 문서 차례 [표지, 종류, 번호] */
const labelled = (xml) => [...xml.matchAll(/<hp:t>([TBR]\d+c?:\S+) <\/hp:t><hp:ctrl><hp:autoNum num="(\d+)" numType="(\w+)"/g)].map((m) => [m[1], m[3], Number(m[2])]);
/** 표·그림 캡션 하나: 글(번호 부호 앞뒤)·번호 종류·번호 */
function captions(xml) {
  return [...xml.matchAll(/<hp:(tbl|pic|equation)\b[^>]*numberingType="(\w+)"[\s\S]*?(<hp:caption\b[\s\S]*?<\/hp:caption>|<\/hp:\1>)/g)].map((m) => {
    const cap = m[3].startsWith('<hp:caption') ? m[3] : null;
    const an = cap && /<hp:autoNum num="(\d+)" numType="(\w+)"/.exec(cap);
    return {
      kind: m[1], numbering: m[2], caption: cap != null,
      text: cap ? [...cap.matchAll(/<hp:t>([^<]*)<\/hp:t>|<hp:autoNum num="(\d+)"/g)].map((x) => x[1] ?? `{${x[2]}}`).join('') : null,
      num: an ? [an[2], Number(an[1])] : null,
    };
  });
}
/** 1×1 PNG */
function png() {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('한/글 실측 시험지: 편집기 엔진의 캡션·칸·글상자·본문 번호 = 한/글이 다시 센 번호', async () => {
  for (const [name, expected] of Object.entries(ORACLE.cases)) {
    const doc = open(fs.readFileSync(path.join(FXDIR, `${name}.hwpx`)));
    assert.deepEqual(labelled(await sectionXml(doc.exportHwpx())), expected, name);
  }
});

test('새 표·그림·수식의 번호 종류 · 캡션 넣기 글 · 번호 종류 바꾸기 · 새 번호로 시작', async (t) => {
  const doc = open(fs.readFileSync(BASE));
  if (!hasNumbering(doc)) { t.skip('엔진에 번호 종류 속성이 없습니다 — npm run build:engine'); return; }
  const last = () => doc.getParagraphCount(0) - 1;
  const newTable = () => { const r = JSON.parse(doc.createTable(0, last(), 0, 2, 2)); return [r.paraIdx, r.controlIdx]; };
  const tblProps = ([p, c]) => JSON.parse(doc.getTableProperties(0, p, c));
  const setTbl = ([p, c], o) => doc.setTableProperties(0, p, c, JSON.stringify(o));
  const caps = async () => captions(await sectionXml(doc.exportHwpx()));

  // 새 표: 번호 종류 '표'(한/글 새 표와 같음 — 종전 '없음'), 캡션 넣기 = '표 2 '(앞 한/글 표가 1)
  const t2 = newTable();
  assert.equal(tblProps(t2).numberingType, 'TABLE');
  setTbl(t2, { hasCaption: true });
  let c = await caps();
  assert.equal(c.length, 2);
  assert.deepEqual(c[1], { kind: 'tbl', numbering: 'TABLE', caption: true, text: '표 {2} ', num: ['TABLE', 2] });
  // 둘째 새 표 → 3
  const t3 = newTable(); setTbl(t3, { hasCaption: true });
  assert.deepEqual((await caps())[2].num, ['TABLE', 3]);

  // 번호 종류를 그림으로: 그 표는 그림 셈(그림 1)으로 세고 캡션의 '표' 번호도 그 그림 번호, 뒤 표는 2 로 당겨진다(한/글 실측 규칙)
  setTbl(t2, { numberingType: 'PICTURE' });
  assert.equal(tblProps(t2).numberingType, 'PICTURE');
  c = await caps();
  assert.equal(c[1].numbering, 'PICTURE'); assert.deepEqual(c[1].num, ['TABLE', 1]);
  assert.deepEqual(c[2].num, ['TABLE', 2]);
  // 없음: 그 표 캡션 번호는 1, 셈은 늘리지 않는다
  setTbl(t2, { numberingType: 'NONE' });
  c = await caps();
  assert.deepEqual([c[1].numbering, c[1].num, c[2].num], ['NONE', ['TABLE', 1], ['TABLE', 2]]);
  // 수식 → 표로 되돌리기
  setTbl(t2, { numberingType: 'EQUATION' });
  assert.equal((await caps())[1].numbering, 'EQUATION');
  setTbl(t2, { numberingType: 'TABLE' });
  assert.deepEqual((await caps()).map((x) => x.num?.[1]), [1, 2, 3]);

  // 번호 종류 없음인 표에 캡션 넣기 = 빈 캡션(한/글 캡션 넣기 실측) · 그림인 표에 캡션 넣기 = '그림 N '
  const t4 = newTable(); setTbl(t4, { numberingType: 'NONE', hasCaption: true });
  const t5 = newTable(); setTbl(t5, { numberingType: 'PICTURE', hasCaption: true });
  c = await caps();
  assert.deepEqual([c[3].caption, c[3].text, c[3].num], [true, '', null]);
  assert.deepEqual([c[4].text, c[4].num], ['그림 {1} ', ['PICTURE', 1]]);

  // 새 번호로 시작(표 77)을 첫 문단(첫 표 앞)에: 77·78·79 로 이어지고 그림 셈은 그대로
  doc.setNewNumber(JSON.stringify({ sec: 0, para: 0, charOffset: 0, numType: 'TABLE', number: 77 }));
  c = await caps();
  assert.deepEqual(c.map((x) => x.num), [['TABLE', 77], ['TABLE', 78], ['TABLE', 79], null, ['PICTURE', 1]]);
  assert.match(await sectionXml(doc.exportHwpx()), /<hp:newNum num="77" numType="TABLE"\/>/);

  // 새 그림: 번호 종류 '그림', 캡션 '그림 2 '(번호 종류 그림인 표가 그림 1)
  const r = JSON.parse(doc.insertPicture(0, last(), 0, '', png(), 2000, 2000, 1, 1, 'png', '', undefined, undefined));
  const pic = [r.paraIdx, r.controlIdx];
  assert.equal(JSON.parse(doc.getPictureProperties(0, ...pic)).numberingType, 'PICTURE');
  doc.setPictureProperties(0, ...pic, JSON.stringify({ hasCaption: true }));
  let pc = (await caps()).find((x) => x.kind === 'pic');
  assert.deepEqual([pc.numbering, pc.text, pc.num], ['PICTURE', '그림 {2} ', ['PICTURE', 2]]);
  doc.setPictureProperties(0, ...pic, JSON.stringify({ numberingType: 'NONE' }));
  pc = (await caps()).find((x) => x.kind === 'pic');
  assert.deepEqual([pc.numbering, pc.num], ['NONE', ['PICTURE', 1]]);
  assert.equal(JSON.parse(doc.getPictureProperties(0, ...pic)).numberingType, 'NONE');

  // 새 수식: 번호 종류 '수식' — 바꾸면 저장에도(종전 'EQUATION' 고정)
  const e = JSON.parse(doc.insertEquation(0, last(), 0, 'a+b', 1000, 0));
  const eq = [e.paraIdx, e.controlIdx];
  assert.equal(JSON.parse(doc.getEquationProperties(0, ...eq, -1, -1)).numberingType, 'EQUATION');
  doc.setEquationProperties(0, ...eq, -1, -1, JSON.stringify({ numberingType: 'NONE' }));
  assert.match(await sectionXml(doc.exportHwpx()), /<hp:equation\b[^>]*numberingType="NONE"/);

  // 다시 열어도 같다(번호 종류·번호가 저장된다)
  const again = open(doc.exportHwpx());
  assert.deepEqual(captions(await sectionXml(again.exportHwpx())).map((x) => [x.numbering, x.num]), (await caps()).map((x) => [x.numbering, x.num]));
});

test('서버 diffDocs: 편집기에서 바꾼 표·그림 번호 종류가 object 덩어리로 서버 문서에 옮겨진다', async (t) => {
  const src = open(fs.readFileSync(BASE));
  if (!hasNumbering(src)) { t.skip('엔진에 번호 종류 속성이 없습니다'); return; }
  // 서버 기준 = 편집기 내보내기(손대지 않은) — 그림 하나 넣은 문서
  const r = JSON.parse(src.insertPicture(0, src.getParagraphCount(0) - 1, 0, '', png(), 2000, 2000, 1, 1, 'png', '', undefined, undefined));
  const bytes = Buffer.from(src.exportHwpx());
  const base = await HwpxDoc.load(bytes);
  assert.equal((await diffDocs(base, await HwpxDoc.load(open(bytes).exportHwpx()))).hunks.length, 0, '손대지 않으면 덩어리 없음');
  const doc = open(bytes);
  const p = tablePara(doc);
  doc.setTableProperties(0, p, 0, JSON.stringify({ numberingType: 'PICTURE' }));
  doc.setPictureProperties(0, r.paraIdx, r.controlIdx, JSON.stringify({ numberingType: 'NONE' }));
  const head = await HwpxDoc.load(doc.exportHwpx());
  const d = await diffDocs(base, head);
  const obj = d.hunks.filter((h) => h.type === 'object');
  assert.ok(obj.length >= 1, `object 덩어리: ${d.hunks.map((h) => h.type).join(',')}`);
  for (const h of obj) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref), h.ref);
  const xml = base.sections[0].xml;
  assert.match(/<hp:tbl\b[^>]*>/.exec(xml)[0], /numberingType="PICTURE"/, '표 번호 종류 → 그림');
  assert.match(/<hp:pic\b[^>]*>/.exec(xml)[0], /numberingType="NONE"/, '그림 번호 종류 → 없음');
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤에는 차이 없음');
});
