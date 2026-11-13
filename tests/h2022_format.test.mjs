// node --test tests/h2022_format.test.mjs — 한/글 2022 서식·쪽 기능(2026-11-11, 원장 research/hangul2022-features-20261111/impl/ledger_format.md)
// 기대값은 한/글 2022 COM 이 같은 조작으로 저장한 HWPX(tests/fixtures/h2022_format/hangul_*.hwpx — artifacts/h2022-format/com/probe.py,
// 시작 문서 seed.hwpx = 한/글이 만든 세 문단 '가나다라마바사0~2').
//  1) 쪽 번호 매기기(setPageNumbering): pageNum·newNum(PAGE) 자리·값, 시작 번호 바꾸기(7→1), 시작 번호 1 은 넣지 않음, 다시 열기
//  2) 감추기(setPageHide): 캐럿 문단의 hp:pageHiding
//  3) 다단(setColumnDefAt·insertColumnDefBreak): 구분선 colLine, 다단 설정 나누기(문단 가름·단 정의 잇기), 현재 다단만 고치기, 단별 너비
//  4) 구역 나누기(splitSection): 한/글 BreakSection 과 같은 구역·문단
//  5) 번호 수준(changeParaNumberLevel), 각주 번호 위첨자(applyFootnoteShape numberCodeSuperscript → supscript)
//  6) 편집기 순수 변환(ui/h2022-format-model.ts)
//  7) 서버: 손대지 않은 내보내기는 덩어리 없음, 쪽 번호·감추기·구분선은 object 덩어리 → copyObjectsFrom,
//     구역 나누기·다단 설정 나누기는 실시간 밀어 넣기로 서버 문서에 실린다
// 엔진은 RHWP_PKG(기본 vendor/rhwp/pkg). 새 API 가 없는 옛 엔진이면 실패로 드러난다(건너뛰지 않음).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { startServer, uploadDoc } from './helpers/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const model = await import(pathToFileURL(path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/h2022-format-model.ts')).href);

const F = (n) => fs.readFileSync(path.join(root, 'tests/fixtures/h2022_format', n));
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const J = (s) => JSON.parse(s);
async function sections(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const names = Object.keys(z.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort();
  return Promise.all(names.map((n) => z.file(n).async('string')));
}
/** 본문 문단마다 { 글, 머리 컨트롤 태그 } — 문단 머리(secPr 는 빼고)의 colPr·pageNum·newNum·pageHiding 을 차례대로 */
function paras(xml) {
  const out = [];
  const body = xml.replace(/<hp:secPr\b[\s\S]*?<\/hp:secPr>/g, '');
  for (const m of body.matchAll(/<hp:p [^>]*>([\s\S]*?)<\/hp:p>/g)) {
    const inner = m[1];
    out.push({
      text: [...inner.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((t) => t[1]).join(''),
      ctrls: [...inner.matchAll(/<hp:(colPr|pageNum|newNum|pageHiding)\b[^>]*?\/?>(?:<hp:colLine[^>]*\/>)?/g)].map((t) => t[0].replace(/\s*\/?>$/, '')),
    });
  }
  return out;
}
const shape = async (bytes) => (await sections(bytes)).map(paras);

// ── 1) 쪽 번호 매기기 ──
test('쪽 번호 매기기: 위치·모양·줄표·시작 번호 7 = 한/글 PageNumPos(구역 첫 문단에 pageNum 뒤 newNum PAGE)', async () => {
  const doc = open(F('seed.hwpx'));
  J(doc.setPageNumbering(0, 5, 2, true, 7));
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_pagenum.hwpx')));
  const info = J(doc.getPageNumbering(0));
  assert.deepEqual([info.position, info.format, info.dash, info.startNumber], [5, 2, true, 7]);
  // 다시 열어도 같다
  const again = J(open(doc.exportHwpx()).getPageNumbering(0));
  assert.deepEqual([again.position, again.format, again.dash, again.startNumber], [5, 2, true, 7]);
  // 쪽 번호 글자(엔진 그림): 한/글이 저장한 같은 문서를 엔진이 그린 것과 같다
  const tail = (d) => [...d.renderPageSvg(0).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('').slice(-6);
  assert.equal(tail(doc), tail(open(F('hangul_pagenum.hwpx'))));
});

test('쪽 번호 매기기: 시작 번호 7 뒤 1 로 바꾸면 newNum num=1 이 남는다(한/글 실측), 새 번호가 없으면 1 은 넣지 않는다', async () => {
  const doc = open(F('seed.hwpx'));
  doc.setPageNumbering(0, 5, 0, true, 7);
  doc.setPageNumbering(0, 6, 0, true, 1);
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_v2_pagenum_reset.hwpx')));
  const fresh = open(F('seed.hwpx'));
  fresh.setPageNumbering(0, 2, 0, true, 1);
  const xml = (await sections(fresh.exportHwpx()))[0];
  assert.equal((xml.match(/<hp:newNum\b/g) || []).length, 0);
  assert.match(xml, /<hp:pageNum pos="TOP_CENTER" formatType="DIGIT" sideChar="-"\/>/);
});

// ── 2) 감추기 ──
test('감추기: 둘째 문단에 머리말·바탕쪽·쪽 번호 = 한/글 PageHiding Fields 0x25', async () => {
  const doc = open(F('seed.hwpx'));
  doc.setPageHide(0, 1, true, false, true, false, false, true);
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_pagehiding.hwpx')));
  const again = J(open(doc.exportHwpx()).getPageHide(0, 1));
  assert.deepEqual(model.hideFlagsFromEngine(again), { hideHeader: true, hideFooter: false, hideMasterPage: true, hideBorder: false, hideFill: false, hidePageNum: true });
});

// ── 3) 다단 ──
test('다단: 2단·간격 8mm·구분선(파선 0.25mm 빨강) = 한/글 MultiColumn ApplyTo=2', async () => {
  const doc = open(F('seed.hwpx'));
  doc.setColumnDefAt(0, 0, JSON.stringify({ columnCount: 2, sameWidth: true, spacing: 2268, separatorType: 2, separatorWidth: 4, separatorColor: '#ff0000' }));
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_v3_sep_apply2.hwpx')));
  const def = J(open(doc.exportHwpx()).getColumnDefAt(0, 2));
  assert.deepEqual([def.columnCount, def.spacing, def.separatorType, def.separatorWidth, def.separatorColor], [2, 2268, 2, 4, '#ff0000']);
});

test('다단 설정 나누기: 문단 가운데에서 가르고 뒤 문단 머리에 단 정의 = 한/글 BreakColDef', async () => {
  const doc = open(F('seed.hwpx'));
  const r = J(doc.insertColumnDefBreak(0, 1, 2, ''));
  assert.deepEqual([r.para, r.charOffset, r.inserted], [2, 0, true]);
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_coldefbreak_only.hwpx')));
});

test('다단 설정 나누기: 2단·구분선 다단 가운데에서 나누면 새 단 정의가 그대로 잇는다(한/글 실측)', async () => {
  const doc = open(F('seed.hwpx'));
  doc.setColumnDefAt(0, 0, JSON.stringify({ columnCount: 2, sameWidth: true, spacing: 2268, separatorType: 1, separatorWidth: 1, separatorColor: '#000000' }));
  doc.insertColumnDefBreak(0, 1, 1, '');
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_v3_in2col_break.hwpx')));
});

test('현재 다단: 둘째 다단에서 2단으로 바꾸면 그 다단만 바뀐다(한/글 ApplyTo=2 실측), 조판 단 수도 다단마다', async () => {
  const doc = open(F('seed.hwpx'));
  doc.insertColumnDefBreak(0, 1, 1, '');
  doc.setColumnDefAt(0, 3, JSON.stringify({ columnCount: 2 }));
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_v3_zone_current.hwpx')));
  assert.equal(J(doc.getColumnDefAt(0, 0)).columnCount, 1);
  assert.equal(J(doc.getColumnDefAt(0, 2)).columnCount, 2);
  assert.equal(J(doc.getColumnDefAt(0, 2)).sectionInitial, false);
});

test('다단: 단 방향 오른쪽부터 = 한/글 Layout=1(layout="RIGHT")', async () => {
  const doc = open(F('seed.hwpx'));
  doc.setColumnDefAt(0, 0, JSON.stringify({ columnCount: 2, direction: 1 }));
  assert.deepEqual(await shape(doc.exportHwpx()), await shape(F('hangul_v3_layout_right.hwpx')));
});

test('다단: 단별 너비(비율 32768) → colSz 로 저장되고 조판 단 폭이 비율대로', async () => {
  const doc = open(F('seed.hwpx'));
  const v = model.columnPreset('left', 42520, 8);
  const props = model.columnDialogToEngine(v);
  assert.equal(props.widths.reduce((a, b) => a + b, 0) + props.gaps.reduce((a, b) => a + b, 0), 32768);
  doc.setColumnDefAt(0, 0, JSON.stringify(props));
  const xml = (await sections(doc.exportHwpx()))[0];
  const sz = [...xml.matchAll(/<hp:colSz width="(\d+)" gap="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(sz.length, 2);
  assert.ok(sz[0][0] < sz[1][0], '왼쪽 단이 좁다');
  const back = model.columnDialogFromEngine(J(open(doc.exportHwpx()).getColumnDefAt(0, 0)));
  assert.equal(back.sameWidth, false);
  assert.ok(Math.abs(back.widthsMm[0] - v.widthsMm[0]) <= 0.2 && Math.abs(back.widthsMm[1] - v.widthsMm[1]) <= 0.2, JSON.stringify(back));
});

// ── 4) 구역 나누기 ──
test('구역 나누기: 문단 가운데에서 = 한/글 BreakSection(구역 둘·문단 가름·새 쪽)', async () => {
  const doc = open(F('seed.hwpx'));
  const r = J(doc.splitSection(0, 1, 2));
  assert.deepEqual([r.section, r.para, r.charOffset], [1, 0, 0]);
  assert.equal(doc.pageCount(), 2);
  const got = (await shape(doc.exportHwpx())).map((s) => s.map((p) => p.text));
  const want = (await shape(F('hangul_breaksection.hwpx'))).map((s) => s.map((p) => p.text));
  assert.deepEqual(got, want);
  const xml = await sections(doc.exportHwpx());
  assert.equal(xml.length, 2);
  for (const x of xml) assert.equal((x.match(/<hp:secPr\b/g) || []).length, 1);
});

// ── 5) 번호 수준·각주 위첨자 ──
test('번호 수준: 번호 문단 0→1→2, 0 에서 위로는 그대로(한/글 ParaNumberBulletLevelDown/Up 실측)', async () => {
  const doc = open(F('seed.hwpx'));
  const nid = doc.ensureDefaultNumbering();
  doc.applyParaFormat(0, 1, JSON.stringify({ headType: 'Number', numberingId: nid, paraLevel: 0 }));
  assert.equal(J(doc.changeParaNumberLevel(0, 1, 1)).level, 1);
  assert.equal(J(doc.changeParaNumberLevel(0, 1, 1)).level, 2);
  assert.equal(J(doc.changeParaNumberLevel(0, 1, -1)).level, 1);
  doc.changeParaNumberLevel(0, 1, -1);
  assert.equal(J(doc.changeParaNumberLevel(0, 1, -1)).changed, false, '0 에서 위로는 그대로');
  assert.equal(J(doc.changeParaNumberLevel(0, 0, 1)).changed, false, '번호 없는 문단은 그대로');
  doc.changeParaNumberLevel(0, 1, 1);
  doc.changeParaNumberLevel(0, 1, 1);
  const z = await JSZip.loadAsync(doc.exportHwpx());
  const sec = await z.file('Contents/section0.xml').async('string');
  const header = await z.file('Contents/header.xml').async('string');
  const pid = [...sec.matchAll(/<hp:p [^>]*paraPrIDRef="(\d+)"/g)].map((m) => m[1])[1];
  const pp = header.match(new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?</hh:paraPr>`))[0];
  assert.match(pp, /<hh:heading type="NUMBER" idRef="\d+" level="2"\/>/);
});

test('각주 모양: 각주 내용 번호 속성 작게(위첨자) = supscript="1", 다시 열면 그대로', async () => {
  const doc = open(F('seed.hwpx'));
  doc.applyFootnoteShape(0, JSON.stringify({ numberCodeSuperscript: true }));
  const xml = (await sections(doc.exportHwpx()))[0];
  assert.match(xml, /<hp:footNotePr><hp:autoNumFormat [^>]*supscript="1"\/>/);
  assert.equal(J(open(doc.exportHwpx()).getFootnoteShape(0)).numberCodeSuperscript, true);
});

// ── 6) 편집기 순수 변환 ──
test('편집기 변환: 쪽 번호·감추기·다단 창 값 ↔ 엔진', () => {
  assert.deepEqual(model.pageNumberingFromEngine({ ok: true, exists: false }), { position: 0, format: 0, dash: true, startNumber: 1 });
  assert.deepEqual(model.pageNumberingFromEngine({ exists: true, position: 5, format: 2, dash: false, startNumber: 7 }), { position: 5, format: 2, dash: false, startNumber: 7 });
  const flags = model.hideFlagsFromEngine({ exists: true, hideHeader: true, hideMasterPage: true, hidePageNum: true });
  assert.equal(model.hideFlagsToBits(flags), 0x25, '한/글 PageHiding Fields');
  assert.deepEqual(model.hideFlagsToArgs(flags), [true, false, true, false, false, true]);
  const same = model.columnDialogFromEngine({ columnCount: 2, sameWidth: true, spacing: 2268, bodyWidth: 42520, separatorType: 1, separatorWidth: 1, separatorColor: '#000000' });
  assert.deepEqual(same.widthsMm, [71, 71]);
  assert.deepEqual(model.columnDialogToEngine(same), { columnCount: 2, columnType: 0, direction: 0, sameWidth: true, spacing: 2268, separatorType: 1, separatorWidth: 1, separatorColor: '#000000' });
  const right = model.columnPreset('right', 42520, 8);
  assert.ok(right.widthsMm[0] > right.widthsMm[1]);
});

// ── 7) 서버 ──
test('서버 diffDocs: 손대지 않은 내보내기는 덩어리 없음, 쪽 번호·감추기·구분선은 object 덩어리 → copyObjectsFrom', async () => {
  // 손대지 않은 내보내기(한/글이 저장한 다단·구분선·다단 설정 나누기·쪽 번호·감추기 문서 포함)는 덩어리가 없다
  for (const name of ['seed.hwpx', 'hangul_v3_sep_apply2.hwpx', 'hangul_v3_in2col_break.hwpx', 'hangul_v3_zone_current.hwpx', 'hangul_pagenum.hwpx', 'hangul_pagehiding.hwpx', 'hangul_v3_layout_right.hwpx']) {
    const b = await HwpxDoc.load(F(name));
    const d0 = await diffDocs(b, await HwpxDoc.load(Buffer.from(open(F(name)).exportHwpx())));
    assert.equal(d0.hunks.length, 0, `손대지 않은 내보내기: ${name} ${JSON.stringify(d0.hunks.map((h) => [h.type, h.ref, h.objectSummary]))}`);
  }
  const base = await HwpxDoc.load(F('seed.hwpx'));
  const doc = open(F('seed.hwpx'));
  doc.setPageNumbering(0, 5, 2, true, 7);
  doc.setPageHide(0, 1, true, false, true, false, false, true);
  doc.setColumnDefAt(0, 0, JSON.stringify({ columnCount: 2, sameWidth: true, spacing: 2268, separatorType: 2, separatorWidth: 4, separatorColor: '#ff0000' }));
  const headBytes = Buffer.from(doc.exportHwpx());
  const head = await HwpxDoc.load(headBytes);
  const d = await diffDocs(base, head);
  assert.ok(d.hunks.length > 0);
  assert.equal(d.hunks.filter((h) => h.type === 'replace').length, 0, '글은 그대로');
  for (const h of d.hunks.filter((x) => x.type === 'object')) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref), JSON.stringify(h).slice(0, 200));
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  const saved = Buffer.from(await base.save());
  assert.deepEqual(await shape(saved), await shape(headBytes), '서버 문서 XML 에 pageNum·newNum·pageHiding·colPr 이 실린다');
});

test('개체 지문 판: 단 정의는 "~" 뒤에 따로 — 판 1(단 정의 이전) 기록은 종전 지문으로 견줘 거짓 충돌이 없다', async () => {
  // 한 단 문서: 지문은 종전과 같다(판이 달라도 같은 값)
  const one = await HwpxDoc.load(F('seed.hwpx'));
  assert.equal(one.objectPrint('s0/p0'), one.objectPrintLegacy('s0/p0'));
  assert.equal(one.objectPrint('s0/p0'), '');
  // 2단·구분선 문서(한/글 저장본): 구역 첫 문단 지문 = 종전('' — 종전 규칙은 단 정의를 보지 않았다) + '~단 정의'
  const two = await HwpxDoc.load(F('hangul_v3_sep_apply2.hwpx'));
  const now = two.objectPrint('s0/p0');
  assert.equal(two.objectPrintLegacy('s0/p0'), '');
  assert.match(now, /^~/);
  // 판 1 로 저장된 기록(변경 요청 baseObjectPrint·되돌리기 after — 판 표시 없음): 종전 지문과 같으면 같다고 본다
  assert.equal(two.matchesObjectPrint('s0/p0', '', undefined), true, '판 1 기록 = 거짓 충돌 없음');
  assert.equal(two.matchesObjectPrint('s0/p0', '', 2), false, '판 2 기록이면 단 정의까지 본다');
  assert.equal(two.matchesObjectPrint('s0/p0', now, 2), true);
  assert.equal(two.matchesObjectPrint('s0/p0', null, 2), false);
  // 다단 설정 나누기 문단도 같은 규칙
  const brk = await HwpxDoc.load(F('hangul_v3_in2col_break.hwpx'));
  assert.equal(brk.matchesObjectPrint('s0/p2', brk.objectPrintLegacy('s0/p2'), undefined), true);
  assert.notEqual(brk.objectPrint('s0/p2'), brk.objectPrintLegacy('s0/p2'));
  // 판 2 에서 남이 단 정의를 바꿨으면 충돌로 보인다
  const doc = open(F('hangul_v3_sep_apply2.hwpx'));
  doc.setColumnDefAt(0, 0, JSON.stringify({ columnCount: 3 }));
  const changed = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  assert.equal(changed.matchesObjectPrint('s0/p0', now, 2), false);
  assert.equal(changed.matchesObjectPrint('s0/p0', '', undefined), true, '판 1 기록은 단 정의를 몰랐다 — 종전처럼 충돌 아님');
  // 새로 만드는 덩어리에는 판 2 가 붙는다
  const d = await diffDocs(two, changed);
  const obj = d.hunks.find((h) => h.type === 'object');
  assert.ok(obj, JSON.stringify(d.hunks));
  assert.equal(obj.objectPrintVersion, 2);
  assert.equal(two.matchesObjectPrint(obj.ref, obj.baseObjectPrint, obj.objectPrintVersion), true);
  assert.equal(changed.matchesObjectPrint(obj.headRef, obj.newObjectPrint, obj.objectPrintVersion), true);
});

// ── 8) 형광펜(markpen) ──
/** 문단마다 hp:t 안쪽 글(형광펜 표지 포함, run·linesegarray 뺌) */
async function penParas(bytes) {
  const x = (await sections(bytes))[0].replace(/<hp:secPr\b[\s\S]*?<\/hp:secPr>/, '');
  return [...x.matchAll(/<hp:p [^>]*>([\s\S]*?)<\/hp:p>/g)].map((m) => [...m[1].matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((t) => t[1]).join(''));
}

test('형광펜: 칠하기·덧칠(나중 색이 이김)·색 없음(그 범위만 지움)·문단 넘기·같은 색 다시 = 한/글 MarkPenShape', async () => {
  const cases = [
    ['hangul_mp_apply.hwpx', (d) => d.applyMarkpen(0, 1, 2, 1, 5, '#ffff00')],
    ['hangul_mp_overlap.hwpx', (d) => { d.applyMarkpen(0, 1, 1, 1, 5, '#ffff00'); d.applyMarkpen(0, 1, 3, 1, 6, '#00ff00'); }],
    ['hangul_mp_none_ffffffff.hwpx', (d) => { d.applyMarkpen(0, 1, 1, 1, 6, '#ffff00'); d.applyMarkpen(0, 1, 3, 1, 4, ''); }],
    ['hangul_mp_cross.hwpx', (d) => d.applyMarkpen(0, 0, 4, 1, 3, '#ffff00')],
    ['hangul_mp_same_again.hwpx', (d) => { d.applyMarkpen(0, 1, 2, 1, 5, '#ffff00'); assert.equal(J(d.applyMarkpen(0, 1, 2, 1, 5, '#FFFF00')).changed, 0); }],
  ];
  for (const [name, act] of cases) {
    const doc = open(F('seed.hwpx'));
    act(doc);
    assert.deepEqual(await penParas(doc.exportHwpx()), await penParas(F(name)), name);
    // 다시 열어 내보내도 같다
    assert.deepEqual(await penParas(open(doc.exportHwpx()).exportHwpx()), await penParas(F(name)), `${name} 다시 열기`);
  }
});

test('형광펜: 한/글이 칠한 문서를 엔진이 그대로 읽고(덧칠·지우기도 같은 규칙) 다시 칠하면 같은 값', async () => {
  const doc = open(F('hangul_mp_overlap.hwpx'));
  // 초록 위를 노랑으로 덧칠 → 노랑 [1,6)
  doc.applyMarkpen(0, 1, 3, 1, 6, '#ffff00');
  assert.deepEqual((await penParas(doc.exportHwpx()))[1], '가<hp:markpenBegin color="#FFFF00"/>나다라마바<hp:markpenEnd/>사1');
  // 표 칸 API 는 칸이 없으면 오류
  assert.throws(() => doc.applyMarkpenInCell(0, 1, 0, 0, 0, 0, 2, '#ffff00'));
});

test('형광펜 그리기: 한/글이 저장한 HWPX 형광펜(markpen 표지)이 화면 층에 칠해진다(종전에는 HWP5 RangeTag 만 그렸다)', () => {
  const fills = (d) => [...d.getPageLayerTreeWithProfile(0, 'screen', true, true).matchAll(/"fillColor":"(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual(fills(open(F('seed.hwpx'))).filter((c) => c === '#ffff00' || c === '#00ff00'), []);
  const hangul = fills(open(F('hangul_mp_overlap.hwpx')));
  assert.ok(hangul.includes('#ffff00') && hangul.includes('#00ff00'), JSON.stringify(hangul));
  // 엔진이 칠한 것과 한/글 저장본을 엔진이 그린 것이 같은 칠(색·차례)
  const doc = open(F('seed.hwpx'));
  doc.applyMarkpen(0, 1, 1, 1, 5, '#ffff00');
  doc.applyMarkpen(0, 1, 3, 1, 6, '#00ff00');
  const rects = (d) => [...d.getPageLayerTreeWithProfile(0, 'screen', true, true).matchAll(/"fillColor":"(#ffff00|#00ff00)"/gi)].length;
  assert.equal(rects(doc), rects(open(F('hangul_mp_overlap.hwpx'))));
});

test('서버 diffDocs: 형광펜은 object 덩어리 → copyObjectsFrom, 범위 밖 글 고침은 형광펜 덩어리 없음, 손대지 않은 한/글 문서는 덩어리 없음', async () => {
  for (const name of ['hangul_mp_apply.hwpx', 'hangul_mp_overlap.hwpx', 'hangul_mp_cross.hwpx', 'hangul_mp_tracked.hwpx']) {
    const b = await HwpxDoc.load(F(name));
    const d0 = await diffDocs(b, await HwpxDoc.load(Buffer.from(open(F(name)).exportHwpx())));
    assert.equal(d0.hunks.length, 0, `손대지 않은 내보내기: ${name} ${JSON.stringify(d0.hunks.map((h) => [h.type, h.ref, h.objectSummary]))}`);
  }
  const base = await HwpxDoc.load(F('seed.hwpx'));
  const doc = open(F('seed.hwpx'));
  doc.applyMarkpen(0, 1, 1, 1, 5, '#ffff00');
  doc.applyMarkpen(0, 1, 3, 1, 6, '#00ff00');
  let head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  let d = await diffDocs(base, head);
  assert.deepEqual(d.hunks.map((h) => [h.type, h.ref]), [['object', 's0/p1']]);
  assert.match(d.hunks[0].objectSummary, /형광펜/);
  assert.ok(base.copyObjectsFrom(head, d.hunks[0].headRef, d.hunks[0].ref));
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  assert.deepEqual((await penParas(Buffer.from(await base.save())))[1], (await penParas(F('hangul_mp_overlap.hwpx')))[1], '서버 문서 = 한/글 덧칠 결과');
  // 범위 밖(뒤) 글을 고치면 글 덩어리만
  doc.insertText(0, 1, 8, 'X');
  head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  d = await diffDocs(base, head);
  assert.deepEqual(d.hunks.map((h) => h.type), ['replace']);
  // 지우기 → object 덩어리 → 서버도 지운다
  const cur = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  doc.applyMarkpen(0, 1, 0, 1, 9, '');
  head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  d = await diffDocs(cur, head);
  assert.deepEqual(d.hunks.map((h) => h.type), ['object']);
  assert.ok(cur.copyObjectsFrom(head, d.hunks[0].headRef, d.hunks[0].ref));
  assert.doesNotMatch((await penParas(Buffer.from(await cur.save())))[1], /markpen/);
});

// ── 8-2) 형광펜 3차: 머리말·각주·표 칸·중첩 표·글상자(경로), 지우기, 이동 ──
async function buildNested() {
  const d = open(F('seed.hwpx'));
  d.createHeaderFooter(0, true, 0); d.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리말 글입니다');
  const fn = J(d.insertFootnote(0, 1, 3)); d.insertTextInFootnote(0, 1, fn.controlIdx, 0, 0, '각주 글입니다');
  const t = J(d.createTable(0, 2, 8, 1, 2));
  d.insertTextInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0, '칸 글입니다');
  const nt = J(d.createTableInCellByPath(0, t.paraIdx, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 1, cellParaIndex: 0 }]), 0, JSON.stringify({ rows: 1, cols: 1 })));
  d.insertTextInCellByPath(0, t.paraIdx, JSON.stringify(nt.cellPath), 0, '안쪽 표 글');
  return { d, fn, t, nested: nt.cellPath };
}
// 엔진은 형광펜 표지 앞뒤로 hp:t 를 가를 수 있다(한/글은 다시 저장하며 합친다) — 갈린 hp:t 를 이어 붙여 견준다
const pens = (x) => (x.replace(/<\/hp:t><hp:t>/g, '').match(/<hp:markpenBegin color="#[0-9A-F]{6}"\/>[^<]*<hp:markpenEnd\/>/g) || []);

test('형광펜 3차: 머리말·각주·표 칸·중첩 표·글상자 문단에 markpen(applyMarkpenTarget) — 저장·다시 열기', async () => {
  const { d, fn, t, nested } = await buildNested();
  const hf = { kind: 'hf', sec: 0, isHeader: true, applyTo: 0, para: 0 };
  const note = { kind: 'note', sec: 0, para: fn.paraIdx, control: fn.controlIdx, notePara: 0 };
  const cell = { kind: 'path', sec: 0, parentPara: t.paraIdx, path: [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }] };
  const inner = { kind: 'path', sec: 0, parentPara: t.paraIdx, path: nested };
  assert.equal(J(d.applyMarkpenTarget(JSON.stringify(hf), 0, 3, '#ffff00')).changed, 1);
  assert.equal(J(d.applyMarkpenTarget(JSON.stringify(note), 0, 2, '#00ff00')).changed, 1);
  assert.equal(J(d.applyMarkpenTarget(JSON.stringify(cell), 0, 0x7fffffff, '#ffff00')).changed, 1, '칸 문단 끝까지');
  assert.equal(J(d.applyMarkpenTarget(JSON.stringify(inner), 0, 2, '#ff0000')).changed, 1);
  const xml = (await sections(d.exportHwpx()))[0];
  const got = pens(xml);
  for (const want of ['<hp:markpenBegin color="#FFFF00"/>머리말<hp:markpenEnd/>', '<hp:markpenBegin color="#00FF00"/>각주<hp:markpenEnd/>',
    '<hp:markpenBegin color="#FFFF00"/>칸 글입니다<hp:markpenEnd/>', '<hp:markpenBegin color="#FF0000"/>안쪽<hp:markpenEnd/>']) {
    assert.ok(got.includes(want), `${want} ∉ ${JSON.stringify(got)}`);
  }
  assert.deepEqual(pens((await sections(open(d.exportHwpx()).exportHwpx()))[0]), got, '다시 열어도 그대로');
  // 지우기(색 없음) = 그 범위만
  d.applyMarkpenTarget(JSON.stringify(cell), 0, 2, '');
  assert.ok(pens((await sections(d.exportHwpx()))[0]).includes('<hp:markpenBegin color="#FFFF00"/>글입니다<hp:markpenEnd/>'));
  // 글상자(한/글 저장본) 문단 — 경로 [그림 개체 0, 칸 0]
  const tb = open(fs.readFileSync(path.join(root, 'tests/fixtures/numbering/probe_textbox.hwpx')));
  assert.equal(J(tb.applyMarkpenTarget(JSON.stringify({ kind: 'path', sec: 0, parentPara: 3, path: [{ controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] }), 0, 2, '#ffff00')).changed, 1);
  const tx = (await sections(tb.exportHwpx()))[0];
  assert.match(tx, /<hp:drawText\b[\s\S]*?<hp:markpenBegin color="#FFFF00"\/>[\s\S]*?<\/hp:drawText>/, '글상자 안 문단에 형광펜');
});

test('형광펜 3차 서버: 머리말·각주·칸·중첩 표 형광펜도 object 덩어리 → copyObjectsFrom, 손대지 않은 내보내기는 덩어리 없음', async () => {
  const { d, fn, t, nested } = await buildNested();
  const baseBytes = Buffer.from(d.exportHwpx());
  const base = await HwpxDoc.load(baseBytes);
  assert.equal((await diffDocs(base, await HwpxDoc.load(Buffer.from(open(baseBytes).exportHwpx())))).hunks.length, 0, '손대지 않은 내보내기');
  d.applyMarkpenTarget(JSON.stringify({ kind: 'hf', sec: 0, isHeader: true, applyTo: 0, para: 0 }), 0, 3, '#ffff00');
  d.applyMarkpenTarget(JSON.stringify({ kind: 'note', sec: 0, para: fn.paraIdx, control: fn.controlIdx, notePara: 0 }), 0, 2, '#00ff00');
  d.applyMarkpenTarget(JSON.stringify({ kind: 'path', sec: 0, parentPara: t.paraIdx, path: [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }] }), 0, 2, '#ffff00');
  d.applyMarkpenTarget(JSON.stringify({ kind: 'path', sec: 0, parentPara: t.paraIdx, path: nested }), 0, 2, '#ff0000');
  const headBytes = Buffer.from(d.exportHwpx());
  const head = await HwpxDoc.load(headBytes);
  const r = await diffDocs(base, head);
  assert.ok(r.hunks.length >= 4, JSON.stringify(r.hunks.map((h) => [h.type, h.ref])));
  assert.deepEqual([...new Set(r.hunks.map((h) => h.type))], ['object']);
  for (const h of r.hunks) assert.ok(base.copyObjectsFrom(head, h.headRef, h.ref), `${h.ref} 옮기기`);
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  assert.deepEqual(pens((await sections(Buffer.from(await base.save())))[0]).sort(), pens((await sections(headBytes))[0]).sort(), '서버 문서에 같은 형광펜');
});

test('형광펜 이동 고르기(MarkPenNext/Prev 한/글 실측): 다음/이전 범위, 끝에서 처음으로 돌아감', async () => {
  const doc = open(F('hangul_mp_cross.hwpx'));
  const ranges = J(doc.getMarkpenRanges(0)).ranges;
  assert.deepEqual(ranges.map((x) => [x.para, x.start, x.end]), [[0, 4, 8], [1, 0, 3]], '한/글 실측 블록: 마바사0 / 가나다');
  {
    const R = ranges.map((x) => ({ sec: 0, ...x }));
    const pick = (para, offset, dir) => { const r = model.pickMarkpenRange(R, { sec: 0, para, offset }, dir); return [r.para, r.start]; };
    assert.deepEqual(pick(0, 0, 1), [0, 4]);
    assert.deepEqual(pick(0, 4, 1), [1, 0]);
    assert.deepEqual(pick(1, 0, 1), [0, 4], '끝에서 처음으로');
    assert.deepEqual(pick(2, 8, -1), [1, 0]);
    assert.deepEqual(pick(1, 0, -1), [0, 4]);
    assert.deepEqual(pick(0, 4, -1), [1, 0], '처음에서 마지막으로');
  }
});

// ── 9) 문단 번호 사용자 정의 ──
test('문단 번호 사용자 정의: 수준별 서식·모양·시작 번호·정렬·거리 → 새 번호 정의(hh:paraHead), 다시 열면 그대로, 번호 글자', async () => {
  const doc = open(F('seed.hwpx'));
  const rows = model.numberingRowsFromPreset(['(^1)', '^2.', '^3)'], [8, 0, 1], 1);
  rows[0] = { ...rows[0], start: 3, align: 2, textOffset: 120, autoIndent: false };
  const r = J(doc.createNumberingEx(JSON.stringify(model.numberingRowsToEngine(rows))));
  assert.ok(r.ok && r.id > 0);
  doc.applyParaFormat(0, 1, JSON.stringify({ headType: 'Number', numberingId: r.id, paraLevel: 0 }));
  const z = await JSZip.loadAsync(doc.exportHwpx());
  const header = await z.file('Contents/header.xml').async('string');
  const num = header.match(new RegExp(`<hh:numbering id="${r.id}"[\\s\\S]*?</hh:numbering>`))?.[0];
  assert.ok(num, header.slice(0, 300));
  assert.match(num, /<hh:paraHead start="3" level="1" align="RIGHT" useInstWidth="1" autoIndent="0" widthAdjust="0" textOffsetType="PERCENT" textOffset="120" numFormat="HANGUL_SYLLABLE"[^>]*>\(\^1\)<\/hh:paraHead>/);
  const back = model.numberingRowsFromEngine(J(open(doc.exportHwpx()).getNumberingDetail(r.id)));
  assert.deepEqual(back.slice(0, 3).map((x) => [x.format, x.numFormat, x.start, x.align, x.autoIndent, x.textOffset]), [['(^1)', 8, 3, 2, false, 120], ['^2.', 0, 1, 0, true, 50], ['^3)', 1, 1, 0, true, 50]]);
  // 미리 보기 = 엔진 번호 글자
  assert.equal(model.previewLevel(rows, 0), '(다)');
  const svgText = [...doc.renderPageSvg(0).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('');
  assert.ok(svgText.includes('(다)'), svgText.slice(0, 120));
  // 다른 문단이 쓰는 기존 정의는 그대로(새 정의를 만든다)
  assert.equal(J(doc.createNumberingEx('{"levels":[]}')).id, r.id + 1);
});

test('서버: 사용자 정의 번호를 단 문단 = format 덩어리 → copyFormattingFrom 이 번호 정의째 옮긴다', async () => {
  const base = await HwpxDoc.load(F('seed.hwpx'));
  const doc = open(F('seed.hwpx'));
  const rows = model.numberingRowsFromPreset(['(^1)'], [8], 3);
  const r = J(doc.createNumberingEx(JSON.stringify(model.numberingRowsToEngine(rows))));
  doc.applyParaFormat(0, 1, JSON.stringify({ headType: 'Number', numberingId: r.id, paraLevel: 0 }));
  const head = await HwpxDoc.load(Buffer.from(doc.exportHwpx()));
  const d = await diffDocs(base, head);
  assert.deepEqual(d.hunks.map((h) => [h.type, h.ref]), [['format', 's0/p1']]);
  base.copyFormattingFrom(head, d.hunks[0].headRef ?? 's0/p1', d.hunks[0].ref);
  assert.equal((await diffDocs(base, head)).hunks.length, 0, '옮긴 뒤 차이 없음');
  const saved = Buffer.from(await base.save());
  const again = open(saved);
  const nid = J(again.getParaPropertiesAt ? again.getParaPropertiesAt(0, 1) : '{}').numberingId;
  const header = await (await JSZip.loadAsync(saved)).file('Contents/header.xml').async('string');
  assert.match(header, /<hh:paraHead start="3" level="1"[^>]*numFormat="HANGUL_SYLLABLE"[^>]*>\(\^1\)<\/hh:paraHead>/, '서버 header 에 새 번호 정의');
  const svgText = [...again.renderPageSvg(0).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('');
  assert.ok(svgText.includes('(다)'), `서버 문서 번호 글자 ${nid ?? ''} ${svgText.slice(0, 80)}`);
});

test('서버(실시간): 구역 나누기·다단 설정 나누기가 서버 문서에 그대로 실린다', { timeout: 240000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, F('seed.hwpx'), '서식쪽.hwpx');
    const working = async () => { const w = await A.res(`/api/docs/${id}/file?kind=working`); return { doc: open(w.data), v: Number(w.headers.get('x-doc-version')) }; };
    const push = async (doc, v) => A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    const exported = async () => (await A.res(`/api/docs/${id}/file?kind=export`)).data;

    let { doc, v } = await working();
    doc.insertColumnDefBreak(0, 1, 2, JSON.stringify({ columnCount: 2, separatorType: 1 }));
    let res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    assert.deepEqual(await shape(await exported()), await shape(doc.exportHwpx()), '다단 설정 나누기');

    ({ doc, v } = await working());
    doc.splitSection(0, 3, 3);
    res = await push(doc, v);
    assert.equal(res.clean, true, JSON.stringify(res));
    const got = await shape(await exported());
    assert.equal(got.length, 2, '구역 파일 둘');
    assert.deepEqual(got.map((s) => s.map((p) => p.text)), (await shape(doc.exportHwpx())).map((s) => s.map((p) => p.text)));
    ({ doc } = await working());
    assert.equal(doc.getSectionCount(), 2);
    assert.equal(J(doc.getColumnDefAt(0, 2)).columnCount, 2);
  } finally {
    await srv.stop();
  }
});
