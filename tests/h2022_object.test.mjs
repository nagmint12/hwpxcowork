// node --test tests/h2022_object.test.mjs — 한/글 2022 개체 기능(2026-11-11, 개체 영역): 순서·글 앞/뒤·개체 보호·모양 복사/붙이기·그림 바꾸기.
// 기대값은 한/글 2022(12.0.0.3146) COM 실측(artifacts/h2022-object/com_probe.py — 숨은 한/글에서 같은 액션 → HWPX 저장)에서 가져왔다.
//  1) 편집기 엔진(RHWP_PKG, 기본 vendor/rhwp/pkg) API 로 조작 → exportHwpx XML 이 한/글 저장본과 같은 값 → 다시 열어도 그대로
//  2) 서버 엔진 diffDocs: 손대지 않은 내보내기에는 object 덩어리가 없다 · 바꾼 개체는 object 덩어리 → copyObjectsFrom 뒤 서버 XML 에 실린다
// 근거·남은 차이: research/hangul2022-features-20261111/impl/ledger_object.md
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const SHAPES = path.join(root, 'tests', 'fixtures', 'shapes_hangul.hwpx'); // 한/글 저장본: 선·사각형·타원·호·다각형·사각형·연결선·묶음·곡선
const POLICE = path.join(root, 'tests', 'fixtures', 'layout', 'regression-20261103', 'inputs', 'REAL-police.hwpx');
const POLICE_ORACLE = path.join(root, 'tests', 'fixtures', 'h2022_object_police_zorder.json');
const MACRO = path.join(root, 'testdata', '매크로테스트용_저장.hwpx'); // 표 4·그림 3

const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const hasApi = (doc) => typeof doc.changeObjectZOrderH2022 === 'function';
const J = (s) => JSON.parse(s);
const OBJ_RE = /<hp:(rect|ellipse|line|pic|container|tbl|polygon|curve|arc|connectLine|equation|chart|ole|textart)\b([^>]*)>/g;
const attr = (a, k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(a) || [])[1];

async function sections(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml/.exec(a)[1]) - Number(/(\d+)\.xml/.exec(b)[1]));
  return Promise.all(names.map((n) => zip.file(n).async('string')));
}
/** 문서 차례의 [태그, zOrder, id, 여는 태그 속성](묶음 안 개체 제외) */
async function objectSeq(bytes) {
  const out = [];
  for (const xml of await sections(bytes)) {
    for (const m of xml.matchAll(OBJ_RE)) {
      const a = m[2];
      if ((attr(a, 'groupLevel') ?? '0') !== '0' || attr(a, 'zOrder') === undefined) continue;
      out.push({ tag: m[1], z: Number(attr(a, 'zOrder')), id: attr(a, 'id'), a, start: m.index, xml });
    }
  }
  return out;
}
/** 본문 문단을 훑어 zOrder → 주소(본문 개체만) */
function bodyAddrByZ(doc) {
  const map = new Map();
  const secs = doc.getSectionCount();
  for (let s = 0; s < secs; s++) {
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p++) for (let c = 0; c < 12; c++) {
      let info; try { info = J(doc.getObjectInfoH2022(s, p, '', c)); } catch { continue; }
      if (!map.has(info.zOrder)) map.set(info.zOrder, { sec: s, ppi: p, ci: c, info });
    }
  }
  return map;
}
/** 개체 XML 의 hp:sz [너비, 높이](속성 차례와 상관없이) */
function szOf(x) { const t = /<hp:sz\s[^>]*>/.exec(x)[0]; return [Number(attr(t, 'width')), Number(attr(t, 'height'))]; }
/** 개체 XML 조각(여는 태그부터 닫는 태그까지) */
function objXml(o) {
  const end = o.xml.indexOf(`</hp:${o.tag}>`, o.start);
  return o.xml.slice(o.start, end);
}

// 한/글 실측 — shapes_hangul.hwpx 의 맨 위 개체 9개 id → zOrder(종전 0..6, 9, 20)
const ID = { line: '2112282672', rect: '2112411928', ellipse: '2112460184', arc: '2112508440', polygon: '2112556696', rect2: '2112604952', connect: '2112653208', container: '1233862604', curve: '1987654321' };
const BASE_Z = { line: 0, rect: 1, ellipse: 2, arc: 3, polygon: 4, rect2: 5, connect: 6, container: 9, curve: 20 };
const HANGUL = {
  // ShapeObjBringToFront(사각형) — 빈틈없이 다시 매김, 사각형 = 맨 위(8)
  rect_front: { line: 0, rect: 8, ellipse: 1, arc: 2, polygon: 3, rect2: 4, connect: 5, container: 6, curve: 7 },
  // ShapeObjBringForward(선) — 겹치지 않는 바로 위 사각형과 자리 바꿈
  line_forward: { line: 1, rect: 0, ellipse: 2, arc: 3, polygon: 4, rect2: 5, connect: 6, container: 7, curve: 8 },
  // ShapeObjSendToBack(두째 사각형)
  rect2_back: { line: 1, rect: 2, ellipse: 3, arc: 4, polygon: 5, rect2: 0, connect: 6, container: 7, curve: 8 },
  // ShapeObjSendBack(타원)
  ellipse_backward: { line: 0, rect: 2, ellipse: 1, arc: 3, polygon: 4, rect2: 5, connect: 6, container: 7, curve: 8 },
  // ShapeObjBringToFront(이미 맨 위 곡선) — 그래도 다시 매긴다
  curve_front: { line: 0, rect: 1, ellipse: 2, arc: 3, polygon: 4, rect2: 5, connect: 6, container: 7, curve: 8 },
};
const CASES = [['rect_front', 'rect', 'front'], ['line_forward', 'line', 'forward'], ['rect2_back', 'rect2', 'back'], ['ellipse_backward', 'ellipse', 'backward'], ['curve_front', 'curve', 'front']];

test('개체 순서: 한/글 실측과 같은 zOrder(도형 9개 — 맨 앞·앞으로·맨 뒤·뒤로·이미 맨 앞)', async (t) => {
  const bytes = fs.readFileSync(SHAPES);
  if (!hasApi(open(bytes))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  for (const [name, who, op] of CASES) {
    const doc = open(bytes);
    const at = bodyAddrByZ(doc).get(BASE_Z[who]);
    assert.ok(at, `${who} 주소`);
    const r = J(doc.changeObjectZOrderH2022(at.sec, at.ppi, '', at.ci, op));
    assert.equal(r.ok, true);
    const out = doc.exportHwpx();
    const byId = new Map((await objectSeq(out)).map((o) => [o.id, o.z]));
    const got = Object.fromEntries(Object.keys(ID).map((k) => [k, byId.get(ID[k])]));
    assert.deepEqual(got, HANGUL[name], name);
    // 다시 열어도 그대로
    const again = new Map((await objectSeq(open(out).exportHwpx())).map((o) => [o.id, o.z]));
    assert.deepEqual(Object.fromEntries(Object.keys(ID).map((k) => [k, again.get(ID[k])])), HANGUL[name], `${name} 다시 열기`);
  }
  // 본문 도형의 종전 API(changeShapeZOrder)도 같은 규칙
  const doc = open(bytes);
  const at = bodyAddrByZ(doc).get(BASE_Z.rect);
  doc.changeShapeZOrder(at.sec, at.ppi, at.ci, 'front');
  const byId = new Map((await objectSeq(doc.exportHwpx())).map((o) => [o.id, o.z]));
  assert.equal(byId.get(ID.rect), 8);
});

test('개체 순서: 여러 구역·표 칸 안 개체까지 한 줄로 다시 매김(REAL-police 78개, 한/글 실측 전체 차례)', { skip: !fs.existsSync(POLICE) && 'REAL-police 없음' }, async (t) => {
  const bytes = fs.readFileSync(POLICE);
  if (!hasApi(open(bytes))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  const oracle = J(fs.readFileSync(POLICE_ORACLE, 'utf8'));
  const seqOf = async (b) => (await objectSeq(b)).map((o) => [o.tag, o.z]);
  assert.deepEqual(await seqOf(open(bytes).exportHwpx()), oracle.base, '손대지 않은 내보내기 = 한/글 원본 차례');
  for (const [key, z, op] of [['front_z3', 3, 'front'], ['back_z5', 5, 'back']]) {
    const doc = open(bytes);
    const at = bodyAddrByZ(doc).get(z);
    assert.ok(at, `zOrder ${z} 개체(본문 표)`);
    const r = J(doc.changeObjectZOrderH2022(at.sec, at.ppi, '', at.ci, op));
    assert.ok(r.moves.length > 0);
    assert.deepEqual(await seqOf(doc.exportHwpx()), oracle[key], key);
    // 되돌리기 쌍(applyShapeZOrderPairs — sec·path 포함)으로 원래대로
    const pairs = r.moves.map((m) => ({ sec: m.sec, ppi: m.ppi, ci: m.ci, path: m.path, z: m.before }));
    J(doc.applyShapeZOrderPairs(0, JSON.stringify(pairs)));
    assert.deepEqual(await seqOf(doc.exportHwpx()), oracle.base, `${key} 되돌리기`);
  }
});

test('글 앞으로·글 뒤로: textWrap 만 바뀌고 zOrder 그대로, 이미 그 배치면 바꾸지 않음', async (t) => {
  const bytes = fs.readFileSync(SHAPES);
  const doc = open(bytes);
  if (!hasApi(doc)) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  const at = bodyAddrByZ(doc).get(BASE_Z.rect);
  assert.equal(J(doc.setObjectWrapH2022(at.sec, at.ppi, '', at.ci, 'InFrontOfText')).changed, false, '이미 글 앞(한/글도 실패)');
  const r = J(doc.setObjectWrapH2022(at.sec, at.ppi, '', at.ci, 'BehindText'));
  assert.equal(r.changed, true); assert.equal(r.before, 'InFrontOfText');
  const o = (await objectSeq(doc.exportHwpx())).find((x) => x.id === ID.rect);
  assert.equal(attr(o.a, 'textWrap'), 'BEHIND_TEXT'); assert.equal(o.z, 1, 'zOrder 그대로(한/글 rect_behind)');
});

test('개체 보호하기 · 모든 보호 개체 해제하기: lock 저장·다시 열기·잠금 수', async (t) => {
  const bytes = fs.readFileSync(SHAPES);
  const doc = open(bytes);
  if (!hasApi(doc)) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  assert.equal(J(doc.unlockAllObjectsH2022()).count, 0, '보호된 개체가 없다');
  const at = bodyAddrByZ(doc).get(BASE_Z.rect);
  assert.equal(J(doc.setObjectLockH2022(at.sec, at.ppi, '', at.ci, true)).before, false);
  const out = doc.exportHwpx();
  assert.equal(attr((await objectSeq(out)).find((x) => x.id === ID.rect).a, 'lock'), '1');
  const re = open(out);
  assert.equal(J(re.getObjectInfoH2022(at.sec, at.ppi, '', at.ci)).locked, true, '다시 열어도 보호');
  assert.equal(J(re.unlockAllObjectsH2022()).count, 1);
  assert.equal(attr((await objectSeq(re.exportHwpx())).find((x) => x.id === ID.rect).a, 'lock'), '0');
});

/** shapes_hangul 의 첫 사각형에 선·채우기를 입힌 사본(한/글 실측 입력과 같은 손질 — styled.hwpx) */
async function styledShapes() {
  const zip = await JSZip.loadAsync(fs.readFileSync(SHAPES));
  let xml = await zip.file('Contents/section0.xml').async('string');
  const i = xml.indexOf(`<hp:rect id="${ID.rect}"`); const j = xml.indexOf('</hp:rect>', i);
  let s = xml.slice(i, j);
  s = s.replace('<hp:lineShape color="#000000" width="33" style="SOLID"', '<hp:lineShape color="#FF0000" width="141" style="DASH"');
  s = s.replace('<hc:winBrush faceColor="#FFFFFF" hatchColor="#000000" alpha="0"/>', '<hc:winBrush faceColor="#00C000" hatchColor="#000000" alpha="0"/>');
  zip.file('Contents/section0.xml', xml.slice(0, i) + s + xml.slice(j));
  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/hwp+zip' });
}

test('개체 모양 복사/붙이기: 한/글 실측(선·채우기·크기 — 고른 것만, 선에는 선·크기만)', async (t) => {
  const bytes = await styledShapes();
  const all = { line: true, fill: true, size: true, shadow: true, picEffect: true };
  {
    const doc = open(bytes);
    if (!hasApi(doc)) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
    const by = bodyAddrByZ(doc);
    const src = by.get(BASE_Z.rect); const poly = by.get(BASE_Z.polygon);
    const c = J(doc.copyObjectFormatH2022(src.sec, src.ppi, '', src.ci));
    assert.equal(c.line && c.fill && c.size && c.shadow, true);
    assert.deepEqual(J(doc.pasteObjectFormatH2022(poly.sec, poly.ppi, '', poly.ci, JSON.stringify(all))).applied.sort(), ['fill', 'line', 'shadow', 'size']);
    const o = (await objectSeq(doc.exportHwpx())).find((x) => x.id === ID.polygon);
    const x = objXml(o);
    // 한/글 copy_size: lineShape #FF0000/141/DASH, winBrush #00C000, sz 9500×6000
    assert.match(x, /<hp:lineShape color="#FF0000" width="141" style="DASH"/);
    assert.match(x, /<hc:winBrush faceColor="#00C000"/);
    assert.deepEqual(szOf(x), [9500, 6000]);
  }
  {
    // 채우기만(copy_fill): 선·크기 그대로
    const doc = open(bytes);
    const by = bodyAddrByZ(doc);
    const src = by.get(BASE_Z.rect); const ell = by.get(BASE_Z.ellipse);
    doc.copyObjectFormatH2022(src.sec, src.ppi, '', src.ci);
    assert.deepEqual(J(doc.pasteObjectFormatH2022(ell.sec, ell.ppi, '', ell.ci, JSON.stringify({ fill: true }))).applied, ['fill']);
    const x = objXml((await objectSeq(doc.exportHwpx())).find((o) => o.id === ID.ellipse));
    assert.match(x, /<hc:winBrush faceColor="#00C000"/);
    assert.match(x, /<hp:lineShape color="#000000" width="33" style="SOLID"/);
    assert.deepEqual(szOf(x), [10000, 6000]);
  }
  {
    // 선에 붙이기(copy_to_line): 선 모양·크기(9500×6000) — 채우기 없음
    const doc = open(bytes);
    const by = bodyAddrByZ(doc);
    const src = by.get(BASE_Z.rect); const ln = by.get(BASE_Z.line);
    doc.copyObjectFormatH2022(src.sec, src.ppi, '', src.ci);
    const r = J(doc.pasteObjectFormatH2022(ln.sec, ln.ppi, '', ln.ci, JSON.stringify(all)));
    assert.ok(r.applied.includes('line') && r.applied.includes('size'));
    const x = objXml((await objectSeq(doc.exportHwpx())).find((o) => o.id === ID.line));
    assert.match(x, /<hp:lineShape color="#FF0000" width="141" style="DASH"/);
    assert.deepEqual(szOf(x), [9500, 6000]);
  }
});

/** 아주 작은 PNG(w×h, 빨강) */
function png(w, h) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 200;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function firstPicture(doc) {
  for (let p = 0; p < doc.getParagraphCount(0); p++) for (let c = 0; c < 4; c++) {
    try { return { p, c, pr: J(doc.getPictureProperties(0, p, c)) }; } catch { /* 그림 아님 */ }
  }
  return null;
}

test('그림 바꾸기·서버 반영: 틀 크기 그대로·imgClip/imgDim = 새 그림, 그림 순서·보호는 object 덩어리로 서버에', { skip: !fs.existsSync(MACRO) && 'testdata 없음' }, async (t) => {
  const bytes = fs.readFileSync(MACRO);
  if (!hasApi(open(bytes))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  // 그림 바꾸기(한/글 PictureChange: sz 그대로, imgClip·imgDim = 새 그림 px×75)
  {
    const doc = open(bytes);
    const pic = firstPicture(doc);
    J(doc.changePictureH2022(0, pic.p, '', pic.c, png(200, 50), 200, 50, 'png'));
    const o = (await objectSeq(doc.exportHwpx())).find((x) => x.tag === 'pic');
    const x = objXml(o);
    assert.deepEqual(szOf(x), [pic.pr.width, pic.pr.height], '틀 크기 그대로');
    assert.match(x, /<hp:imgClip left="0" right="15000" top="0" bottom="3750"\/>/);
    assert.match(x, /<hp:imgDim dimwidth="15000" dimheight="3750"\/>/);
  }
  // 서버: 손대지 않은 내보내기 → object 덩어리 없음
  const base = await HwpxDoc.load(bytes);
  const same = await diffDocs(base, await HwpxDoc.load(open(bytes).exportHwpx()));
  assert.equal(same.hunks.filter((h) => h.type === 'object').length, 0, '가짜 object 덩어리가 없다');
  // 그림 맨 앞으로 + 보호 → object 덩어리 → 옮긴 뒤 서버 XML 에 zOrder·lock
  const doc = open(bytes);
  const pic = firstPicture(doc);
  const r = J(doc.changeObjectZOrderH2022(0, pic.p, '', pic.c, 'front'));
  const n = (await objectSeq(bytes)).length;
  assert.equal(r.zOrder, n - 1, '맨 위 = 개체 수 - 1');
  doc.setObjectLockH2022(0, pic.p, '', pic.c, true);
  const head = await HwpxDoc.load(doc.exportHwpx());
  const d = await diffDocs(base, head);
  const obj = d.hunks.filter((h) => h.type === 'object');
  assert.ok(obj.some((h) => h.ref === `s0/p${pic.p}`), `그림 문단 덩어리(${obj.map((h) => h.ref)})`);
  for (const h of obj) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref));
  const saved = await objectSeq(await base.save());
  const headSeq = await objectSeq(doc.exportHwpx());
  const savedPics = saved.filter((o) => o.tag === 'pic').map((o) => [o.z, attr(o.a, 'lock')]);
  const headPics = headSeq.filter((o) => o.tag === 'pic').map((o) => [o.z, attr(o.a, 'lock')]);
  assert.deepEqual(savedPics, headPics, '서버 문서의 그림 zOrder·lock = 편집기');
  assert.ok(savedPics.some(([z, l]) => z === n - 1 && l === '1'));
});

// ───────── 2차(2026-11-12): 그림 효과 · 여러 개체 맞춤 · 서버의 표 머리 속성(zOrder·lock) ─────────

const EFFECTS_BASE = path.join(root, 'tests', 'fixtures', 'h2022_object_effects_base.hwpx'); // 한/글 저장본: section1 에 떠 있는 그림(18000×12000)
const COLOR = (r, g, b) => `<hp:effectsColor type="RGB" schemeIdx="-1" systemIdx="-1" presetIdx="-1"><hp:rgb r="${r}" g="${g}" b="${b}"/></hp:effectsColor>`;
const EFFECTS = {
  shadow: `<hp:shadow style="OUTSIDE" alpha="0.5" radius="0" direction="0" distance="1000" alignStyle="TOP_LEFT" rotationStyle="0"><hp:skew x="0" y="0"/><hp:scale x="1" y="1"/>${COLOR(0, 0, 0)}</hp:shadow>`,
  shadow135: `<hp:shadow style="OUTSIDE" alpha="0.5" radius="0" direction="135" distance="1000" alignStyle="TOP_LEFT" rotationStyle="0"><hp:skew x="0" y="0"/><hp:scale x="1" y="1"/>${COLOR(0, 0, 0)}</hp:shadow>`,
  glow: `<hp:glow alpha="0.5" radius="1000">${COLOR(255, 0, 0)}</hp:glow>`,
  soft: '<hp:softEdge radius="1000"/>',
  refl: '<hp:reflection alignStyle="BOTTOM_LEFT" radius="0" direction="90" distance="0" rotationStyle="0" fadeDirection="90"><hp:skew x="0" y="0"/><hp:scale x="1" y="-1"/><hp:alpha start="0.5" end="0"/><hp:pos start="0" end="0.9"/></hp:reflection>',
};
/** 그림을 글 앞으로 두고 hp:effects 를 바꾼 사본(한/글 실측 입력과 같은 손질 — effect_probe.py) */
async function withEffects(xml) {
  const zip = await JSZip.loadAsync(fs.readFileSync(EFFECTS_BASE));
  const s1 = await zip.file('Contents/section1.xml').async('string');
  const i = s1.indexOf('<hp:pic '); const j = s1.indexOf('</hp:pic>', i);
  let pic = s1.slice(i, j).replace('textWrap="BEHIND_TEXT"', 'textWrap="IN_FRONT_OF_TEXT"');
  pic = pic.replace(/<hp:effects\/>|<hp:effects>[\s\S]*?<\/hp:effects>/, `<hp:effects>${xml}</hp:effects>`);
  zip.file('Contents/section1.xml', s1.slice(0, i) + pic + s1.slice(j));
  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/hwp+zip' });
}
/** 그림이 든 쪽 SVG 의 그림 자리(x, y)와 채운 반투명 사각형들(효과 띠) — px(96dpi) */
function pictureSvg(doc) {
  for (let pg = 0; pg < doc.pageCount(); pg++) {
    const svg = doc.renderPageSvg(pg);
    const tag = (/<image\b[^>]*>/.exec(svg) || [])[0];
    if (!tag) continue;
    const rects = [...svg.matchAll(/<rect\b([^>]*)\/?>/g)].map((r) => r[1]).filter((a) => /fill="#/.test(a) && /opacity/.test(a))
      .map((a) => ({ x: Number(attr(a, 'x')), y: Number(attr(a, 'y')), w: Number(attr(a, 'width')), h: Number(attr(a, 'height')), fill: attr(a, 'fill') }));
    return { svg, x: Number(attr(tag, 'x')), y: Number(attr(tag, 'y')), rects };
  }
  return null;
}
const HU = 96 / 7200; // HWPUNIT → px(96dpi)

test('그림 효과: 그림자·네온 읽기·쓰기·그리기(한/글 실측 자리), 옅은 테두리·반사는 읽고 쓰기', async (t) => {
  if (!hasApi(open(fs.readFileSync(SHAPES)))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  // 다시 저장해도 효과 XML 그대로(종전: glow·softEdge·reflection 이 사라졌다)
  for (const k of ['glow', 'soft', 'refl', 'shadow']) {
    const out = open(await withEffects(EFFECTS[k])).exportHwpx();
    const s1 = await (await JSZip.loadAsync(out)).file('Contents/section1.xml').async('string');
    const eff = /<hp:effects>([\s\S]*?)<\/hp:effects>/.exec(s1)?.[1] ?? '';
    assert.equal(eff, EFFECTS[k], `${k} 왕복`);
  }
  const none = pictureSvg(open(await withEffects('')));
  assert.ok(none && Number.isFinite(none.x), '그림 SVG');
  const W = 18000 * HU; const H = 12000 * HU;
  // 그림자 0°·1000: 그림 뒤 같은 크기 사각형이 오른쪽으로 1000HU(한/글: 오른쪽 끝 +20px@144dpi = 1000HU), 불투명도 0.5
  {
    const r = pictureSvg(open(await withEffects(EFFECTS.shadow)));
    const sh = r.rects.filter((x) => x.fill === '#000000');
    assert.equal(sh.length, 1, '흐림 없는 그림자 = 사각형 하나');
    assert.ok(Math.abs(sh[0].x - (none.x + 1000 * HU)) < 0.6 && Math.abs(sh[0].y - none.y) < 0.6 && Math.abs(sh[0].w - W) < 0.6 && Math.abs(sh[0].h - H) < 0.6, JSON.stringify(sh[0]));
    assert.ok(r.svg.indexOf('fill="#000000"') < r.svg.indexOf('<image'), '그림자가 그림보다 먼저(뒤에) 그려진다');
  }
  // 그림자 135°: 왼쪽 아래로 707HU — 한/글은 그림을 오른쪽으로 707HU(14px@144) 옮기고 그림자 왼쪽 끝을 원래 자리에
  {
    const r = pictureSvg(open(await withEffects(EFFECTS.shadow135)));
    assert.ok(Math.abs(r.x - (none.x + 707 * HU)) < 0.6, `그림 옮김 ${r.x - none.x}`);
    const sh = r.rects.filter((x) => x.fill === '#000000');
    assert.ok(Math.abs(sh[0].x - none.x) < 0.6, '그림자 왼쪽 끝 = 원래 그림 자리');
  }
  // 네온 1000: 한/글은 그림을 오른쪽·아래로 1000HU 옮긴다, 빨강 띠가 그림 둘레에(흐림 띠 여러 장)
  {
    const r = pictureSvg(open(await withEffects(EFFECTS.glow)));
    assert.ok(Math.abs(r.x - (none.x + 1000 * HU)) < 0.6 && Math.abs(r.y - (none.y + 1000 * HU)) < 0.6, `네온 그림 옮김 ${r.x - none.x},${r.y - none.y}`);
    const red = r.rects.filter((x) => x.fill === '#ff0000');
    assert.ok(red.length >= 5, `흐림 띠 ${red.length}`);
    const outer = Math.min(...red.map((x) => x.x));
    assert.ok(outer < r.x && outer > r.x - 1000 * HU * 1.5, '네온 띠가 그림 바깥 반지름 안팎');
  }
});

test('여러 개체 맞춤·간격·크기(기준 = 마지막에 고른 개체) → 서버 반영', async (t) => {
  const bytes = fs.readFileSync(SHAPES);
  if (typeof open(bytes).alignObjectsH2022 !== 'function') { t.skip('엔진에 alignObjectsH2022 가 없습니다'); return; }
  const posOf = async (b) => new Map((await objectSeq(b)).map((o) => {
    const x = objXml(o); const p = /<hp:pos\s[^>]*>/.exec(x)[0];
    const [w, h] = szOf(x);
    return [o.id, { x: Number(attr(p, 'horzOffset')), y: Number(attr(p, 'vertOffset')), w, h }];
  }));
  const addr = (doc, z) => { const a = bodyAddrByZ(doc).get(z); return { sec: a.sec, ppi: a.ppi, ci: a.ci }; };
  // 왼쪽 맞춤: 사각형·타원 → 호(마지막)의 왼쪽 끝(종이 기준 왼쪽 정렬이라 horzOffset 이 곧 자리)
  {
    const doc = open(bytes);
    const r = J(doc.alignObjectsH2022(JSON.stringify([addr(doc, BASE_Z.rect), addr(doc, BASE_Z.ellipse), addr(doc, BASE_Z.arc)]), 'left'));
    assert.equal(r.moved, 2);
    const p = await posOf(doc.exportHwpx());
    assert.equal(p.get(ID.rect).x, p.get(ID.arc).x); assert.equal(p.get(ID.ellipse).x, p.get(ID.arc).x);
    assert.equal(p.get(ID.rect).y, 25500, '세로는 그대로');
  }
  // 아래쪽 맞춤·너비 같게
  {
    const doc = open(bytes);
    doc.alignObjectsH2022(JSON.stringify([addr(doc, BASE_Z.rect), addr(doc, BASE_Z.polygon)]), 'bottom');
    doc.alignObjectsH2022(JSON.stringify([addr(doc, BASE_Z.rect), addr(doc, BASE_Z.polygon)]), 'width');
    const p = await posOf(doc.exportHwpx());
    assert.equal(p.get(ID.rect).y + p.get(ID.rect).h, p.get(ID.polygon).y + p.get(ID.polygon).h);
    assert.equal(p.get(ID.rect).w, p.get(ID.polygon).w);
  }
  // 세로 간격을 동일하게(4개): 맨 위·맨 아래는 그대로, 사이 간격이 같다 → 서버 반영
  {
    const doc = open(bytes);
    // 사각형(25500~31500)·타원·다각형·둘째 사각형(47500~) — 사이 간격이 -500·5000·-500 으로 다르다
    const ids = [ID.rect, ID.ellipse, ID.polygon, ID.rect2];
    const r = J(doc.alignObjectsH2022(JSON.stringify([BASE_Z.rect, BASE_Z.ellipse, BASE_Z.polygon, BASE_Z.rect2].map((z) => addr(doc, z))), 'vspace'));
    assert.equal(r.moved, 2, '맨 위·맨 아래를 뺀 둘만 옮긴다');
    const out = doc.exportHwpx();
    const p = await posOf(out);
    const ys = ids.map((id) => p.get(id)).sort((a, b) => a.y - b.y);
    assert.equal(ys[0].y, 25500); assert.equal(ys[3].y, 47500);
    const gaps = [1, 2, 3].map((k) => ys[k].y - (ys[k - 1].y + ys[k - 1].h));
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `간격 ${gaps}`);
    const base = await HwpxDoc.load(bytes);
    const head = await HwpxDoc.load(out);
    const d = await diffDocs(base, head);
    const obj = d.hunks.filter((h) => h.type === 'object');
    assert.ok(obj.length > 0, '도형 옮김 덩어리');
    for (const h of obj) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref));
    const sp = await posOf(await base.save());
    for (const id of ids) assert.equal(sp.get(id).y, p.get(id).y, `서버 ${id}`);
  }
});

test('서버: 표 머리 속성(zOrder·lock)만 바뀐 표는 여는 태그만 옮긴다(표째 바꾸지 않음)', { skip: !fs.existsSync(MACRO) && 'testdata 없음' }, async (t) => {
  const bytes = fs.readFileSync(MACRO);
  if (!hasApi(open(bytes))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  const doc = open(bytes);
  const pic = firstPicture(doc);
  doc.changeObjectZOrderH2022(0, pic.p, '', pic.c, 'back'); // 그림을 맨 뒤로 → 앞선 표들의 zOrder 가 하나씩 밀린다
  // 첫 표(본문 문단 5 근처)를 보호
  let tbl = null;
  for (let p = 0; p < doc.getParagraphCount(0) && !tbl; p++) for (let c = 0; c < 6; c++) {
    try { const i = J(doc.getObjectInfoH2022(0, p, '', c)); if (i.kind === 'table') { tbl = { p, c }; break; } } catch { /* */ }
  }
  doc.setObjectLockH2022(0, tbl.p, '', tbl.c, true);
  const out = doc.exportHwpx();
  const base = await HwpxDoc.load(bytes);
  const head = await HwpxDoc.load(out);
  const d = await diffDocs(base, head);
  const obj = d.hunks.filter((h) => h.type === 'object');
  assert.ok(obj.some((h) => /표 순서·보호/.test(h.objectSummary)), obj.map((h) => h.objectSummary).join(' / '));
  assert.ok(!obj.some((h) => /표 고침/.test(h.objectSummary)), '표째 고침이 아니다');
  const before = await sections(await base.save());
  for (const h of obj) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref));
  const after = await sections(await base.save());
  const tbls = (xs) => xs.flatMap((x) => [...x.matchAll(/<hp:tbl\b[^>]*>/g)].map((m) => m[0]));
  const za = (s) => [attr(s, 'zOrder'), attr(s, 'lock')];
  assert.deepEqual(tbls(after).map(za), tbls(await sections(out)).map(za), '서버 표 zOrder·lock = 편집기');
  // 표 칸 내용은 그대로 — 여는 태그·줄 정보를 빼면 같다
  const strip = (xs) => xs.join('').replace(/<hp:tbl\b[^>]*>/g, '<hp:tbl>').replace(/<hp:pic\b[^>]*>/g, '<hp:pic>').replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, '');
  const cells = (xs) => [...strip(xs).matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)].map((m) => m[0]);
  assert.deepEqual(cells(after), cells(before), '칸 내용은 손대지 않음');
  assert.equal((await diffDocs(base, head)).hunks.filter((h) => h.type === 'object').length, 0, '옮긴 뒤 차이 없음');
});

// ───────── 3차(2026-11-12): 글맵시 기본 그리기 · 그림 효과 값 API ─────────

const TEXTART = path.join(root, 'tests', 'fixtures', 'h2022_object_textart_rect.hwpx'); // 한/글 TextArtCreate(모양 42 RECTANGLE) 저장본

test('글맵시: 모델에 글·모양을 두고 hp:textart 로 다시 저장, 상자 대신 글을 그린다', async (t) => {
  const bytes = fs.readFileSync(TEXTART);
  if (!hasApi(open(bytes))) { t.skip('엔진에 h2022 개체 API 가 없습니다'); return; }
  const src = (await sections(bytes))[0];
  const want = /<hp:textart\b[\s\S]*?<\/hp:textart>/.exec(src)[0];
  const doc = open(bytes);
  const out = (await sections(doc.exportHwpx()))[0];
  const got = /<hp:textart\b[\s\S]*?<\/hp:textart>/.exec(out)?.[0];
  assert.ok(got, '내보내기에 hp:textart 가 남는다(종전: hp:rect 로 바뀜)');
  assert.equal(attr(got, 'text'), attr(want, 'text'));
  const pr = (x) => /<hp:textartPr\b[^>]*>/.exec(x)[0];
  for (const k of ['fontName', 'textShape', 'lineSpacing', 'charSpacing', 'align']) assert.equal(attr(pr(got), k), attr(pr(want), k), k);
  assert.match(got, /<hc:winBrush faceColor="#0000FF"/, '글자 채우기 색 보존');
  // 그리기: 상자는 칠하지 않고 글자 노드가 있다
  let svg = '';
  for (let p = 0; p < doc.pageCount(); p++) svg += doc.renderPageSvg(p);
  assert.ok(!/fill="#0000ff"[^>]*\/?>\s*<\/?rect|<rect[^>]*fill="#0000ff"/i.test(svg), '파란 상자를 칠하지 않는다');
  assert.ok(/#0000ff/i.test(svg), '파란 글자(채우기 색)가 그려진다');
});

test('그림 효과 값 API: 대화상자가 쓰는 읽기·쓰기 — 한/글 저장 꼴(문자열 수치·RGB)', async (t) => {
  const bytes = await withEffects('');
  const doc = open(bytes);
  if (typeof doc.setPictureEffectsH2022 !== 'function') { t.skip('엔진에 setPictureEffectsH2022 가 없습니다'); return; }
  // section1 의 그림 자리 찾기
  let at = null;
  for (let p = 0; p < doc.getParagraphCount(1) && !at; p++) for (let c = 0; c < 4; c++) { try { if (J(doc.getObjectInfoH2022(1, p, '', c)).kind === 'picture') { at = { p, c }; break; } } catch { /* */ } }
  assert.ok(at, '그림');
  assert.deepEqual(J(doc.getPictureEffectsH2022(1, at.p, '', at.c)), { ok: true, shadow: null, glow: null, softEdge: null, reflection: null });
  doc.setPictureEffectsH2022(1, at.p, '', at.c, JSON.stringify({ shadow: { alpha: 0.5, radius: 0, direction: 0, distance: 1000, color: '#000000' }, glow: { alpha: 0.5, radius: 1000, color: '#FF0000' } }));
  const s1 = (await sections(doc.exportHwpx()))[1];
  const eff = /<hp:effects>([\s\S]*?)<\/hp:effects>/.exec(s1)[1];
  assert.equal(eff, EFFECTS.shadow + EFFECTS.glow, '한/글 실측 입력과 같은 XML');
  const r = pictureSvg(doc);
  assert.ok(r.rects.some((x) => x.fill === '#000000') && r.rects.some((x) => x.fill === '#ff0000'), '그림자·네온이 그려진다');
  doc.setPictureEffectsH2022(1, at.p, '', at.c, JSON.stringify({ shadow: null }));
  const back = J(doc.getPictureEffectsH2022(1, at.p, '', at.c));
  assert.equal(back.shadow, null); assert.equal(back.glow.radius, 1000);
});
