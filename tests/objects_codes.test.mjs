// node --test tests/objects_codes.test.mjs — 그림 속성(크기)·조판 부호(자동 번호·새 번호로 시작) 편집이 저장·한글로 저장까지 가는가.
//  1) 편집기 엔진(rhwp WASM, vendor/rhwp/pkg): 캡션 자동 번호 Backspace(번호만 지움 — 종전에는 앞 공백이 지워지고 번호가 남았다)·
//     표 캡션 선택 지우기(…ByPath — 종전 '셀 65534 범위 초과')·새 번호로 시작 넣기/고치기/지우기와 캡션 번호 다시 매기기
//  2) 서버 엔진 diffDocs: 손대지 않은 편집기 내보내기는 object 덩어리가 없다 · 그림 크기·부호 변경은 object 덩어리 → copyObjectsFrom 로 옮긴다
//  3) 실시간 밀어 넣기(PUT /live) → 한글로 저장(kind=export)에 그림 크기·지운 번호·새 번호가 실린다 · 응답 formatVersion · WS formatting 에 seq
//  4) 변경 요청(PUT /drafts/mine → merge)도 같은 덩어리를 반영한다
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { startServer, uploadDoc, watchWs, root } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

// 그림 3(글자처럼, 아래 캡션 '[그림 n] …' — s0/p7·p12·p25) · 표 4(위 캡션 '[표 n] 표' — s0/p5·p11·p19·p24)
const FX = path.join(root, 'testdata', '매크로테스트용_저장.hwpx');
const SKIP = !fs.existsSync(FX) && 'testdata 없음';
const hasCodes = (d) => typeof d.getCodeControlAt === 'function';

const sectionXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/section0.xml').async('string');
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
/** 본문 문단 p 의 표 캡션(셀 65534) */
function tableCaption(doc, p) {
  for (let c = 0; c < 6; c++) {
    let len; try { len = doc.getCellParagraphLength(0, p, c, 65534, 0); } catch { continue; }
    return { p, c, text: () => doc.getTextInCell(0, p, c, 65534, 0, 0, doc.getCellParagraphLength(0, p, c, 65534, 0)), len };
  }
  return null;
}
const capTarget = (t) => ({ sec: 0, para: t.p, cellPath: [{ controlIndex: t.c, cellIndex: 65534, cellParaIndex: 0 }] });
const codes = (doc, target) => JSON.parse(doc.getCodeControls(JSON.stringify(target)));
const codeAt = (doc, target, charOffset, direction) => JSON.parse(doc.getCodeControlAt(JSON.stringify({ ...target, charOffset, direction })));
function firstPicture(doc) {
  for (let p = 0; p < doc.getParagraphCount(0); p++) for (let c = 0; c < 4; c++) {
    try { return { p, c, pr: JSON.parse(doc.getPictureProperties(0, p, c)) }; } catch { /* 그림 아님 */ }
  }
  return null;
}
/** 편집기에서 할 세 가지: 첫 그림 크기 반, 첫 표 캡션 번호 Backspace, 본문 s0/p3 앞에 새 번호(표 5) */
function editInEditor(bytes) {
  const doc = open(bytes);
  const pic = firstPicture(doc);
  doc.setPictureProperties(0, pic.p, pic.c, JSON.stringify({ width: Math.round(pic.pr.width / 2), height: Math.round(pic.pr.height / 2) }));
  const cap = tableCaption(doc, 5);
  const hit = codeAt(doc, capTarget(cap), 4, 'backward');
  doc.deleteCodeControl(JSON.stringify({ ...capTarget(cap), codeIndex: hit.codeIndex }));
  doc.setNewNumber(JSON.stringify({ sec: 0, para: 3, charOffset: 0, numType: 'TABLE', number: 5 }));
  return { bytes: Buffer.from(doc.exportHwpx()), width: Math.round(pic.pr.width / 2) };
}
/** 첫 표의 캡션 XML */
const firstTableCaptionXml = (xml) => { const t = xml.indexOf('<hp:tbl'); return xml.slice(xml.indexOf('<hp:caption', t), xml.indexOf('</hp:caption>', t)); };
/** 저장된 문서에서 볼 것: 첫 그림 sz 폭, 첫 표 캡션에 자동 번호가 있는가, 새 번호(표 5)가 있는가 */
async function inspect(bytes) {
  const xml = await sectionXml(bytes);
  const pic = /<hp:pic\b[\s\S]*?<hp:sz width="(\d+)"/.exec(xml);
  return {
    picWidth: pic ? Number(pic[1]) : null,
    captionHasNumber: /<hp:autoNum\b/.test(firstTableCaptionXml(xml)),
    newNum: /<hp:newNum num="5" numType="TABLE"\/>/.test(xml),
  };
}

test('편집기 엔진: 자동 번호 Backspace · 표 캡션 선택 지우기 · 새 번호로 시작 넣기/고치기/지우기', { skip: SKIP }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다 — npm run build:engine'); return; }

  // Backspace: '[표 1|] 표' 에서 번호 하나만 지운다(앞 공백·] 는 그대로), 다음 표 번호는 2 그대로(한/글은 개체가 번호를 센다)
  {
    const doc = open(bytes);
    const cap = tableCaption(doc, 5); const next = tableCaption(doc, 11);
    assert.equal(cap.text(), '[표  ] 표', '자동 번호 자리표(공백 한 칸)가 글에 있다');
    assert.equal(codes(doc, capTarget(next))[0].number, 2);
    assert.equal(codeAt(doc, capTarget(cap), 3, 'backward').found, false, '번호 앞(공백 뒤) Backspace 는 공백을 지운다(부호 아님)');
    const hit = codeAt(doc, capTarget(cap), 4, 'backward');
    assert.equal(hit.found, true); assert.equal(hit.kind, 'autoNum'); assert.equal(hit.numType, 'TABLE'); assert.equal(hit.placeholder, true);
    assert.equal(codeAt(doc, capTarget(cap), 3, 'forward').codeIndex, hit.codeIndex, 'Delete 는 번호 앞에서 같은 부호');
    const r = JSON.parse(doc.deleteCodeControl(JSON.stringify({ ...capTarget(cap), codeIndex: hit.codeIndex })));
    assert.equal(r.charOffset, 3);
    assert.equal(cap.text(), '[표 ] 표');
    assert.equal(codes(doc, capTarget(cap)).length, 0);
    assert.equal(codes(doc, capTarget(next))[0].number, 2, '번호 부호만 지운 표도 번호 하나를 차지한다(한/글: 남은 표 2·3·4)');
    const out = doc.exportHwpx();
    assert.equal((await inspect(out)).captionHasNumber, false, '내보내기에 번호가 없다');
    assert.equal((await HwpxDoc.load(out)).text('s0/p5/n0', 'final'), '[표 ] 표', '번호 앞뒤 글은 그대로(뒤따르는 메모 필드도 제자리)');
  }
  // 캡션 번호 그리기·캐럿·복사: '[표 1] 표' 로 보이고(번호 뒤 빈칸 없음 — 종전 '[표 1 ] 표'), ']' 앞 캐럿 = ']' 글자 자리(종전 한 칸 밀려
  // ']' 앞에서 Backspace 를 누르면 ']' 가 지워졌다), 복사 글은 번호째 '[표 1] 표'(종전 '[표  ] 표'). 평면(캡션 편집 진입) 복사도 된다
  {
    const doc = open(bytes);
    const cap = tableCaption(doc, 5);
    const page = JSON.parse(doc.getCursorRectInCell(0, cap.p, cap.c, 65534, 0, 0)).pageIndex;
    const items = [...doc.renderPageSvg(page).matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)]
      .map((m) => ({ t: m[2], x: Number(/\sx="([\d.]+)"/.exec(m[1])?.[1] ?? /translate\(([\d.]+)/.exec(m[1])?.[1]) }));
    const at = items.findIndex((x, i) => x.t === '[' && items[i + 1]?.t === '표' && items[i + 2]?.t === '1' && items[i + 3]?.t === ']');
    assert.ok(at >= 0, '캡션이 [ 표 1 ] 차례로 그려진다');
    const caret = (off) => JSON.parse(doc.getCursorRectInCell(0, cap.p, cap.c, 65534, 0, off)).x;
    assert.ok(Math.abs(caret(3) - items[at + 2].x) < 0.5, '번호 앞 캐럿 = 번호 자리');
    assert.ok(Math.abs(caret(4) - items[at + 3].x) < 0.5, `번호 뒤 캐럿 = ']' 자리(${caret(4)} ↔ ${items[at + 3].x})`);
    const pathJson = JSON.stringify([{ controlIndex: cap.c, cellIndex: 65534, cellParaIndex: 0 }]);
    assert.equal(JSON.parse(doc.copySelectionInCellByPath(0, cap.p, pathJson, 0, 0, 0, 7)).text, '[표 1] 표');
    assert.equal(JSON.parse(doc.copySelectionInCell(0, cap.p, cap.c, 65534, 0, 0, 0, 7)).text, '[표 1] 표');
    // 캡션 안 Enter·Backspace(문단 나누기·합치기 — …ByPath)
    assert.equal(JSON.parse(doc.splitParagraphInCellByPath(0, cap.p, pathJson, 7)).cellParaIndex, 1);
    const path1 = JSON.stringify([{ controlIndex: cap.c, cellIndex: 65534, cellParaIndex: 1 }]);
    assert.equal(JSON.parse(doc.mergeParagraphInCellByPath(0, cap.p, path1)).cellParaIndex, 0);
  }
  // 선택 지우기(표 캡션 cellPath — 적중 판정이 주는 모양): '[표 1] ' 이 번호째 지워진다
  {
    const doc = open(bytes);
    const cap = tableCaption(doc, 5);
    const pathJson = JSON.stringify([{ controlIndex: cap.c, cellIndex: 65534, cellParaIndex: 0 }]);
    doc.deleteRangeInCellByPath(0, cap.p, pathJson, 0, 0, 0, 6);
    assert.equal(cap.text(), '표');
    assert.equal((await inspect(doc.exportHwpx())).captionHasNumber, false, '지운 캡션에 번호가 남지 않는다(종전: 글 끝으로 옮겨 갔다)');
  }
  // 새 번호로 시작: 넣기(표 5) → 고치기(표 9) → 지우기, 그 뒤 표 캡션 번호가 따라간다
  {
    const doc = open(bytes);
    const cap = tableCaption(doc, 5);
    const body = { sec: 0, para: 3 };
    const ins = JSON.parse(doc.setNewNumber(JSON.stringify({ ...body, charOffset: 0, numType: 'TABLE', number: 5 })));
    assert.equal(codes(doc, capTarget(cap))[0].number, 5);
    const at = codeAt(doc, body, 0, 'forward');
    assert.equal(at.kind, 'newNum'); assert.equal(at.codeIndex, ins.codeIndex); assert.equal(at.number, 5);
    assert.equal(codeAt(doc, body, 0, 'backward').found, false, '문단 맨 앞 Backspace 는 문단 합치기(부호 아님)');
    doc.setNewNumber(JSON.stringify({ ...body, numType: 'TABLE', number: 9, codeIndex: at.codeIndex }));
    assert.equal(codes(doc, capTarget(cap))[0].number, 9);
    assert.match(await sectionXml(doc.exportHwpx()), /<hp:newNum num="9" numType="TABLE"\/>/);
    doc.deleteCodeControl(JSON.stringify({ ...body, codeIndex: at.codeIndex }));
    assert.equal(codes(doc, capTarget(cap))[0].number, 1);
    assert.equal(codes(doc, body).length, 0);
    assert.ok(!/<hp:newNum\b/.test(await sectionXml(doc.exportHwpx())));
  }
});

test('캡션 번호는 개체가 센다(한/글 실측과 같게) · 편집기에서 표를 지우면 뒤 번호가 당겨진다', { skip: SKIP }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다 — npm run build:engine'); return; }
  /** section0.xml 을 고친 사본 */
  const variant = async (fn) => {
    const zip = await JSZip.loadAsync(bytes);
    zip.file('Contents/section0.xml', fn(await zip.file('Contents/section0.xml').async('string')));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  /** 편집기 엔진이 매긴 캡션 번호(내보낸 autoNum 차례) — '표1 그림1 …' */
  const numbers = async (b) => [...(await sectionXml(open(b).exportHwpx())).matchAll(/<hp:autoNum num="(\d+)" numType="(\w+)"/g)]
    .map((m) => (m[2] === 'TABLE' ? '표' : '그림') + m[1]).join(' ');
  assert.equal(await numbers(bytes), '표1 그림1 표2 그림2 표3 표4 그림3');
  // 한/글 PDF(2026-10-28): 첫 표의 캡션을 통째로 빼도 남은 표는 2·3·4 — 캡션 없는 표도 번호 하나를 차지한다
  const noCaption = await variant((x) => { const i = x.indexOf('<hp:caption'); return x.slice(0, i) + x.slice(x.indexOf('</hp:caption>', i) + 13); });
  assert.equal(await numbers(noCaption), '그림1 표2 그림2 표3 표4 그림3');
  // 첫 표의 번호 종류 NONE: 그 표는 세지 않고(캡션 번호는 다음 번호 1), 다음 표도 1
  const none = await variant((x) => { const i = x.indexOf('numberingType="TABLE"', x.indexOf('<hp:tbl ')); return x.slice(0, i) + 'numberingType="NONE"' + x.slice(i + 21); });
  assert.equal(await numbers(none), '표1 그림1 표1 그림2 표2 표3 그림3');
  // 캡션 없는 그림(번호 종류 그림)을 맨 앞에: 뒤 그림이 2·3·4
  const extraPic = await variant((x) => {
    const pic = x.slice(x.indexOf('<hp:pic '), x.indexOf('</hp:pic>') + 9).replace(/<hp:caption[\s\S]*?<\/hp:caption>/, '')
      .replace(/\bid="\d+"/, 'id="1999999901"').replace(/\binstid="\d+"/, 'instid="999999901"');
    const r = x.indexOf('>', x.indexOf('<hp:run ', x.indexOf('<hp:p '))) + 1;
    return x.slice(0, r) + pic + x.slice(r);
  });
  assert.equal(await numbers(extraPic), '표1 그림2 표2 그림3 표3 표4 그림4');
  // 편집기에서 첫 표(s0/p5)를 지우면 다음 표 캡션 번호가 2 → 1
  const doc = open(bytes);
  const next = tableCaption(doc, 11);
  assert.equal(codes(doc, capTarget(next))[0].number, 2);
  doc.deleteTableControl(0, 5, tableCaption(doc, 5).c);
  assert.equal(codes(doc, capTarget(tableCaption(doc, 11)))[0].number, 1, '표를 지운 뒤 다시 조판하면 번호가 당겨진다');
});

test('개체도 조판 부호: 그림 뒤 Backspace·앞 Delete, 표 아래 빈 줄 Backspace 가 개체를 가리킨다 · 표 아래 빈 줄에 캐럿 자리', { skip: SKIP }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다 — npm run build:engine'); return; }
  const doc = open(bytes);
  const at = (para, charOffset, direction) => codeAt(doc, { sec: 0, para }, charOffset, direction);
  // s0/p7: 글자처럼 취급한 그림 하나(캐럿 자리 0 = 그림 앞, 1 = 그림 뒤)
  assert.deepEqual(
    (({ found, kind, objectType, inline, label, charPos }) => ({ found, kind, objectType, inline, label, charPos }))(at(7, 1, 'backward')),
    { found: true, kind: 'object', objectType: 'picture', inline: true, label: '그림', charPos: 0 }, '그림 뒤 Backspace');
  assert.equal(at(7, 0, 'forward').objectType, 'picture', '그림 앞 Delete');
  assert.equal(at(7, 0, 'backward').found, false, '그림 앞 Backspace 는 문단 합치기(개체 아님)');
  assert.equal(at(7, 1, 'forward').found, false, '그림 뒤 Delete 는 다음 문단 합치기');
  // 자리를 차지하는 표(s0/p5·p11·p19·p24 — p11 은 쪽을 넘김): 표 아래 빈 줄 = 그 문단 자리 0. 한/글처럼 Backspace 만 표를 가리킨다
  for (const p of [5, 11, 19, 24]) {
    const bs = at(p, 0, 'backward');
    assert.equal(bs.kind, 'object', `p${p} Backspace`); assert.equal(bs.objectType, 'table'); assert.equal(bs.label, '표'); assert.equal(bs.inline, false);
    // (p24 는 표 뒤에 붙은 글 없는 메모가 있어 Delete 가 그 메모 부호를 가리킨다 — 메모 지우기, tests/memo_delete.test.mjs)
    const del = at(p, 0, 'forward');
    assert.ok(!del.found || del.kind === 'memo', `p${p} Delete 는 개체가 아님: ${JSON.stringify(del)}`);
    const r = JSON.parse(doc.getCursorRect(0, p, 0));
    assert.ok(Number.isFinite(r.y), `p${p} 표 아래 빈 줄에 캐럿 자리가 있다(종전 '커서 위치를 찾을 수 없습니다')`);
    assert.equal(JSON.parse(doc.navigateNextEditable(0, p + 1, 0, -1, '[]')).para, p, `p${p + 1} 앞에서 ← 는 표 아래 빈 줄로`);
    // [2026-10-30 숨긴 한/글 재실측] 표 아래 빈 줄은 글머리표 문단 — 조판 부호 보기를 꺼도 Backspace 가 '[표] 를 지울까요?'(종전 판단 그대로).
    // 보기를 켜면 캐럿이 표 앞(틈 0)·뒤(틈 1)에 서고 표 뒤 Backspace 만 묻는다(표 앞은 한/글이 글머리표를 지운다 — 부호 아님).
    // 글머리표 없는 문단 머리의 숨은 부호는 보기를 끄면 문단 합치기다(tests/codes_view.test.mjs).
    if (typeof doc.getCodeDeleteTarget === 'function' && p !== 24) {
      const tgt = (o) => JSON.parse(doc.getCodeDeleteTarget(JSON.stringify({ sec: 0, para: p, charOffset: 0, direction: 'backward', ...o })));
      assert.equal(tgt({ codes: false }).objectType, 'table', `p${p} 보기 끔 Backspace`);
      assert.equal(tgt({ codes: true, gap: 1 }).objectType, 'table', `p${p} 보기 켬·표 뒤 Backspace`);
      assert.equal(tgt({ codes: true, gap: 0 }).found, false, `p${p} 보기 켬·표 앞 Backspace`);
    }
  }
  // 캡션 자동 번호는 한/글 이름 '번호 넣기'
  assert.equal(codeAt(doc, capTarget(tableCaption(doc, 5)), 4, 'backward').label, '번호 넣기');
  // 그림·표 지우기 API 로 지우면 사라진다(편집기 지우기 창의 [지움])
  doc.deletePictureControl(0, 7, 0);
  assert.equal(at(7, 1, 'backward').found, false);
  doc.deleteTableControl(0, 5, 0);
  assert.equal(at(5, 0, 'backward').found, false);
});

test('서버 diffDocs: 손대지 않은 내보내기는 object 덩어리 없음 · 그림 크기·부호 변경 → object 덩어리 → copyObjectsFrom', { skip: SKIP }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다'); return; }
  const base = await HwpxDoc.load(bytes);
  const same = await diffDocs(base, await HwpxDoc.load(open(bytes).exportHwpx()));
  assert.equal(same.hunks.filter((h) => h.type === 'object').length, 0, '가짜 object 덩어리(모두 다시 열기)가 없다');

  const head = await HwpxDoc.load(editInEditor(bytes).bytes);
  const d = await diffDocs(base, head);
  const obj = d.hunks.filter((h) => h.type === 'object');
  assert.deepEqual(obj.map((h) => h.ref).sort(), ['s0/p3', 's0/p5/n0', 's0/p7']);
  assert.match(obj.find((h) => h.ref === 's0/p7').objectSummary, /그림 크기 150×75mm → 75×38mm/);
  assert.match(obj.find((h) => h.ref === 's0/p5/n0').objectSummary, /조판 부호 지움: 번호\(표\)/);
  assert.match(obj.find((h) => h.ref === 's0/p3').objectSummary, /조판 부호 넣음: 새 번호\(표 5\)/);
  assert.equal(d.hunks.length, 3, '글 덩어리는 없다');
  for (const h of obj) {
    assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref));
    assert.equal(base.objectPrint(h.ref), h.newObjectPrint);
  }
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤에는 차이 없음');
  const xml = await sectionXml(await base.save());
  const pic = /<hp:pic\b[\s\S]*?<\/hp:caption>/.exec(xml)[0];
  assert.match(pic, /<hp:curSz width="21260" height="10630"\/>/);
  assert.match(pic, /<hp:rotationInfo angle="0" centerX="10630" centerY="5315"/, '회전 중심을 새 크기로');
  assert.match(pic, /<hc:scaMatrix e1="0\.141733"/, '배율 = 보이는 크기 / 원본 크기');
  assert.match(pic, /lastWidth="21260"/, '캡션 폭이 그림 폭을 따라간다');
  assert.ok(!/<hp:autoNum\b/.test(firstTableCaptionXml(xml)), '첫 표 캡션의 번호를 뺐다');
  assert.equal(base.text('s0/p5/n0', 'final'), '[표 ] 표');
  assert.equal(base.memos().length, (await HwpxDoc.load(bytes)).memos().length, '캡션의 메모는 그대로');
});

/** 단색 PNG(w×h) — 시험용 새 그림 */
function solidPng(w, h, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/** 저장된 문서의 그림 요약: 그림 수, 그림 파일 참조(차례), 매니페스트 그림 항목(파일 없으면 표시), 본문 문단 수 */
async function picSummary(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const xml = await z.file('Contents/section0.xml').async('string');
  const hpf = await z.file('Contents/content.hpf').async('string');
  return {
    pics: (xml.match(/<hp:pic\b/g) || []).length,
    refs: [...xml.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]),
    bins: [...hpf.matchAll(/<opf:item\b[^>]*id="(image\d+)"[^>]*href="([^"]+)"/g)].map((m) => (z.file(m[2]) ? m[1] : `${m[1]}(파일 없음)`)),
    paras: (await HwpxDoc.load(bytes)).sections[0].bodyParas.length,
  };
}

test('다른 문서에서 복사한 그림은 픽셀×75로 바꾸지 않고 원래 크기·자르기·행렬을 보존한다', {skip:SKIP}, async()=>{
  const source=await HwpxDoc.load(fs.readFileSync(FX)),target=await HwpxDoc.load(fs.readFileSync(FX));
  const {sec,p}=source.resolve('s0/p7');const old=sec.xml.slice(p.start,p.end);
  // HWPUNIT is a physical unit; original bitmap dimensions need not be 96 dpi.
  const modified=old.replace(/(<hp:orgSz\b[^>]*width=")\d+("[^>]*height=")\d+("\/?>)/,(_all,a,b,c)=>a+'43210'+b+'21605'+c);
  assert.match(modified,/<hp:orgSz width="43210" height="21605"/);
  sec.load(sec.xml.slice(0,p.start)+modified+sec.xml.slice(p.end));
  const before=source.resolve('s0/p7');const expected=before.sec.xml.slice(before.p.start,before.p.end);
  target.removeOwnObjects('s0/p7');assert.ok(target.copyObjectsFrom(source,'s0/p7','s0/p7'));
  const after=target.resolve('s0/p7'),actual=after.sec.xml.slice(after.p.start,after.p.end);
  for(const tag of ['orgSz','curSz','sz','pos','imgClip','imgDim','rotationInfo'])assert.equal(new RegExp('<hp:'+tag+'\\b[^>]*>').exec(actual)?.[0],new RegExp('<hp:'+tag+'\\b[^>]*>').exec(expected)?.[0],tag);
});

test('그림 지우기·넣기·바꾸기 → 실시간 밀어 넣기 → 한글로 저장(경고 없음, 그림 파일 정리)', { skip: SKIP, timeout: 180000 }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다'); return; }
  const png = solidPng(120, 60, [220, 40, 40]);
  const N = 120 * 75; const M = 60 * 75;
  // 편집기에서 할 일 → 기대(그림 수·참조·그림 파일·문단 수 — 원본: 그림 3(image1·2·3), 문단 33. s0/p7 = 첫 그림 문단, s0/p4 = 글 문단)
  const cases = [
    ['그림만 지움(문단은 남음)', (d) => d.deletePictureControl(0, 7, 0), { pics: 2, refs: ['image2', 'image3'], bins: ['image2', 'image3'], paras: 33 }, ['s0/p7'], []],
    ['그림 문단째 지움', (d) => d.deleteParagraph(0, 7), { pics: 2, refs: ['image2', 'image3'], bins: ['image2', 'image3'], paras: 32 }, [], ['s0/p7']],
    ['글 문단에 그림 넣음', (d) => d.insertPicture(0, 3, 10, '', png, N, M, 120, 60, 'png', ''), { pics: 4, refs: ['image4', 'image1', 'image2', 'image3'], bins: ['image1', 'image2', 'image3', 'image4'], paras: 33 }, ['s0/p3'], []],
    ['새 문단에 그림 넣음', (d) => { d.splitParagraph(0, 3, d.getParagraphLength(0, 3)); d.insertPicture(0, 4, 0, '', png, N, M, 120, 60, 'png', ''); }, { pics: 4, refs: ['image4', 'image1', 'image2', 'image3'], bins: ['image1', 'image2', 'image3', 'image4'], paras: 34 }, [], [], ['s0/p4']],
    ['그림 바꿈', (d) => d.assignPictureImage(0, 7, '', 0, png, 120, 60, 'png'), { pics: 3, refs: ['image4', 'image2', 'image3'], bins: ['image2', 'image3', 'image4'], paras: 33 }, ['s0/p7'], []],
  ];
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  for (const [name, edit, want, changed, deleted, inserted = []] of cases) {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, `${name}.hwpx`);
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const doc = open(w.data); edit(doc);
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    assert.equal(r.unsupported, 0, `${name}: '지원하지 않는 그림·표 구조 변경' 경고 없음`);
    assert.deepEqual(r.applied, { changed, inserted, deleted }, `${name}: 반영 자리`);
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    assert.deepEqual(await picSummary(ex.data), want, `${name}: 한글로 저장`);
    const xml = await sectionXml(ex.data);
    for (const m of xml.matchAll(/<hp:pic\b[^>]*>/g)) assert.ok(!/\sid="0"/.test(m[0]), `${name}: 새 그림도 개체 번호가 있다`);
    if (name === '그림 바꿈') {
      // 편집기는 옛 그림의 원본 크기를 그대로 내보낸다 — 새 그림 파일 크기(120×60px = 9000×4500)로 맞춰야 한/글이 제 크기로 그린다
      const pic = xml.slice(xml.indexOf('<hp:pic'), xml.indexOf('</hp:pic>'));
      assert.match(pic, /<hp:orgSz width="9000" height="4500"\/>/);
      assert.match(pic, /<hp:imgDim dimwidth="9000" dimheight="4500"\/>/);
    }
    open(ex.data).getParagraphCount(0);   // 편집기 엔진으로 다시 열린다
  }
  // 변경 요청(수정본 저장 → 반영): 첫 그림 문단째 지우고 글 문단 뒤 새 문단에 그림 — 덩어리 둘, 반영 뒤 그림 3(새 그림 하나 + 남은 둘)
  {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '그림_변경요청.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const doc = open(w.data);
    doc.deleteParagraph(0, 7);
    doc.splitParagraph(0, 3, doc.getParagraphLength(0, 3)); doc.insertPicture(0, 4, 0, '', png, N, M, 120, 60, 'png', '');
    const saved = await A(`/api/docs/${id}/drafts/mine?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    const view = await A(`/api/docs/${id}/change-requests/${saved.cr.cid}`);
    assert.deepEqual(view.hunks.map((h) => [h.type, !!h.objects]), [['insert', true], ['delete', true]], '그림 문단 넣기·지우기 덩어리');
    assert.equal(view.unsupported.length, 0);
    await A(`/api/docs/${id}/change-requests/${saved.cr.cid}/merge`, { method: 'POST' });
    const s = await picSummary((await A.res(`/api/docs/${id}/file?kind=export`)).data);
    assert.equal(s.pics, 3); assert.deepEqual(s.refs, ['image4', 'image2', 'image3']);
  }
});

/** 저장된 문서의 본문 표 요약: 본문 문단 수, 표마다 '주인 ref:행x열:폭', 첫 표 첫 칸 크기 */
async function tableSummary(bytes) {
  const d = await HwpxDoc.load(bytes);
  const t = d.tables().filter((x) => !/\/n\d+/.test(x.ref));
  const xml = await sectionXml(bytes);
  const tbl = (/<hp:tbl\b[\s\S]*?<hp:cellSz width="(\d+)" height="(\d+)"/.exec(xml) || []).slice(1).join('x');
  return { paras: d.sections[0].bodyParas.length, tables: t.map((x) => `${x.ref}:${x.rows}x${x.cols}`), firstCell: tbl };
}

test('표 지우기·넣기·크기·줄/칸 → 실시간 밀어 넣기 → 한글로 저장(경고 없음)', { skip: SKIP, timeout: 180000 }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다'); return; }
  // 원본: 본문 표 4개(s0/p5 5x8 · p11 13x7 · p19 6x8 · p24 6x7), 문단 33
  const cases = [
    ['표만 지움(문단은 남음)', (d) => d.deleteTableControl(0, 5, 0), { changed: ['s0/p5'], inserted: [], deleted: [] }, (s) => s.tables.length === 3 && s.paras === 33],
    ['표 칸 너비 바꿈', (d) => d.resizeTableCells(0, 5, 0, JSON.stringify([{ cellIdx: 0, widthDelta: -1500 }, { cellIdx: 1, widthDelta: 1500 }])), { changed: ['s0/p5'], inserted: [], deleted: [] }, (s) => s.firstCell.startsWith('2914x')],
    ['표 줄 높이 + 칸 글', (d) => { d.insertTextInCell(0, 5, 0, 8, 0, 0, '★'); d.resizeTableCells(0, 5, 0, JSON.stringify([{ cellIdx: 0, heightDelta: 600 }])); }, { changed: ['s0/p5'], inserted: [], deleted: [] }, (s) => s.firstCell.endsWith('x1712')],
    ['표 줄 넣기', (d) => d.insertTableRow(0, 5, 0, 1, true), { changed: ['s0/p5'], inserted: [], deleted: [] }, (s) => s.tables[0] === 's0/p5:6x8'],
    ['표 칸 지우기', (d) => d.deleteTableColumn(0, 5, 0, 2), { changed: ['s0/p5'], inserted: [], deleted: [] }, (s) => s.tables[0] === 's0/p5:5x7'],
    ['새 문단에 표 넣기', (d) => { d.splitParagraph(0, 3, d.getParagraphLength(0, 3)); d.createTable(0, 4, 0, 2, 3); }, { changed: [], inserted: ['s0/p4', 's0/p5'], deleted: [] }, (s) => s.tables[0] === 's0/p4:2x3' && s.tables.length === 5],
  ];
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  for (const [name, edit, applied, check] of cases) {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, `${name}.hwpx`);
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const doc = open(w.data); edit(doc);
    const head = Buffer.from(doc.exportHwpx());
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: head });
    assert.equal(r.unsupported, 0, `${name}: '표 구조…아직 공유 문서에 들어가지 않습니다' 경고 없음`);
    assert.equal(r.clean, true, `${name}: 서버 문서 = 보낸 문서`);
    assert.deepEqual(r.applied, applied, `${name}: 반영 자리`);
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    const sum = await tableSummary(ex.data);
    assert.deepEqual(sum, await tableSummary(head), `${name}: 한글로 저장 = 편집기`);
    assert.ok(check(sum), `${name}: ${JSON.stringify(sum)}`);
    open(ex.data).getParagraphCount(0);
  }
});

test('실시간 밀어 넣기·변경 요청 반영 → 한글로 저장에 그림 크기·지운 번호·새 번호가 실린다', { skip: SKIP, timeout: 120000 }, async (t) => {
  const bytes = fs.readFileSync(FX);
  if (!hasCodes(open(bytes))) { t.skip('엔진에 조판 부호 API 가 없습니다'); return; }
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  assert.deepEqual(await inspect(bytes), { picWidth: 42520, captionHasNumber: true, newNum: false });

  // 실시간(기본 설정)
  {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '그림부호.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const head = editInEditor(w.data);
    const ws = watchWs(srv.base, srv.tokens.a, id); await ws.ready;
    const r = await A(`/api/docs/${id}/live?base=${v}&seq=7`, { method: 'PUT', body: head.bytes });
    assert.equal(r.clean, true, '서버 문서 = 보낸 문서(그림·부호까지)');
    assert.ok(r.version > v);
    assert.equal(r.formatVersion, r.version, '서식 판 = 이 커밋(보낸 창은 다시 열지 않는다)');
    assert.deepEqual(r.applied.changed, ['s0/p3', 's0/p5/n0', 's0/p7']);
    const fmt = await ws.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.formatting);
    assert.equal(fmt.seq, 7, 'formatting WS 에 밀어 넣기 차례');
    ws.close();
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    assert.equal(ex.status, 200);
    assert.deepEqual(await inspect(ex.data), { picWidth: head.width, captionHasNumber: false, newNum: true });
    // 같은 것을 다시 보내면 바꿀 것이 없다
    const again = await A(`/api/docs/${id}/live?base=${r.version}`, { method: 'PUT', body: head.bytes });
    assert.equal(again.version, r.version); assert.equal(again.clean, true);
  }
  // 변경 요청(수정본 저장 → 반영)
  {
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '그림부호_변경요청.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const head = editInEditor(w.data);
    const saved = await A(`/api/docs/${id}/drafts/mine?base=${v}`, { method: 'PUT', body: head.bytes });
    const cid = saved.cr?.cid;
    assert.ok(cid, '변경 요청이 생긴다');
    const view = await A(`/api/docs/${id}/change-requests/${cid}`);
    assert.deepEqual(view.hunks.map((h) => h.type), ['object', 'object', 'object']);
    await A(`/api/docs/${id}/change-requests/${cid}/merge`, { method: 'POST' });
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    assert.deepEqual(await inspect(ex.data), { picWidth: head.width, captionHasNumber: false, newNum: true });
  }
});
