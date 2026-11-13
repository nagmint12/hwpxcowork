// node --test tests/toc.test.mjs — 차례 만들기·새로 고침·제목 차례 표시(도구 > 차례/색인)가 한/글과 같은 차례를 만들고 서버까지 가는가.
//  1) 편집기 엔진(rhwp WASM): 시험지(tests/fixtures/toc_source.hwpx — 개요 1~4·차례 숨김·제목 차례 표시·쪽 새 번호·표/그림/수식 캡션)에
//     선택 사항별로 차례를 만들어 한/글 2022 가 같은 선택으로 만든 차례(tests/fixtures/toc_hangul.json — 문단 스타일·글·쪽·링크 종류·필드 Command)와 견준다.
//  2) 새로 고침(개요 문단을 더하면 항목이 생긴다 — 한/글 UpdateAllContents 와 같은 꼴), 고치기(선택 사항 바꿔 다시 만들기)
//  3) 하이퍼링크: 문서 안 대상(문단 id·개체 id)으로 찾아간다, 고유 id 가 없던 문단은 새 id 를 받고 저장해도 id 가 그대로다
//  4) 제목 차례 표시·차례 숨기기 켜고 끄기, 수식 캡션 보존(종전에는 저장하면 사라졌다), 차례 스타일이 없는 문서는 바탕글로
//  5) 서버: 실시간 밀어 넣기 → 한글로 저장에 차례 필드·하이퍼링크·오른쪽 탭·대상 문단 id 가 실리고, 다시 비교하면 차이가 없다
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

const SRC = fixture('toc_source.hwpx');
const ORACLE = JSON.parse(fs.readFileSync(fixture('toc_hangul.json'), 'utf8'));
const PLAN = path.join(root, 'testdata', '데이터 분석계획서_재수강분석.hwpx');
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const hasToc = (d) => typeof d.makeTableOfContents === 'function';
const SKIP = !hasToc(open(fs.readFileSync(SRC))) && '엔진에 차례 API 가 없습니다 — npm run build:engine';

const sectionXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/section0.xml').async('string');
const headerXml = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/header.xml').async('string');

/** 본문 최상위 문단들 → { id, style(이름), text(탭 '\t'), link(1 개요·2 표·3 그림·4 수식), toc(차례 필드 시작), end(차례 필드 끝) } */
async function bodyParas(bytes) {
  const s = await sectionXml(bytes); const h = await headerXml(bytes);
  const styleName = new Map([...h.matchAll(/<hh:style id="(\d+)"[^>]*\sname="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const out = []; let depth = 0; let start = -1;
  for (const m of s.matchAll(/<hp:p [^>]*>|<\/hp:p>/g)) {
    if (m[0].startsWith('<hp:p ')) { if (depth === 0) start = m.index; depth++; continue; }
    depth--; if (depth !== 0) continue;
    const p = s.slice(start, m.index + m[0].length);
    const head = /<hp:p [^>]*>/.exec(p)[0];
    const text = p.replace(/<hp:parameters[\s\S]*?<\/hp:parameters>/g, '').replace(/<hp:caption[\s\S]*?<\/hp:caption>/g, '').replace(/<hp:tab[^>]*\/>/g, '\t')
      .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const link = /<hp:stringParam name="Command">\?#(\d+);0;(\d);0;<\/hp:stringParam>/.exec(p);
    out.push({
      id: /\sid="(\d+)"/.exec(head)[1], style: styleName.get(/styleIDRef="(\d+)"/.exec(head)[1]), text, xml: p,
      link: link ? Number(link[2]) : null, target: link ? link[1] : null,
      toc: /type="TABLEOFCONTENTS"/.test(p), end: /<hp:fieldEnd\b/.test(p) && !link,
    });
  }
  return out;
}

/** 한/글 시험과 같은 자리: 첫 문단 끝에서 Enter 친 빈 문단(캐럿) */
function caretAfterFirst(doc) {
  doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0));
  return 1;
}

/** 만든 차례 자리의 문단 — 필드면 시작~끝, 문자열이면 캐럿 빈 문단 다음부터 '서론' 앞까지 */
function tocSlice(paras, field) {
  if (field) {
    const a = paras.findIndex((x) => x.toc); const b = paras.findIndex((x, i) => i > a && x.end);
    return paras.slice(a, b + 1);
  }
  return paras.slice(2, paras.findIndex((x) => x.text === '서론'));
}

const pick = (p) => ({ style: p.style, text: p.text, ...(p.link ? { link: p.link } : {}) });

test('차례 만들기: 선택 사항마다 한/글 2022 와 같은 차례(스타일·글·쪽·링크·필드 Command)', { skip: SKIP }, async () => {
  for (const [name, v] of Object.entries(ORACLE.variants)) {
    const doc = open(fs.readFileSync(SRC));
    const para = caretAfterFirst(doc);
    const r = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para, options: v.options })));
    assert.equal(r.ok, true, name);
    const out = Buffer.from(doc.exportHwpx());
    const paras = await bodyParas(out);
    const field = v.options.field !== false;
    assert.deepEqual(tocSlice(paras, field).map(pick), v.paragraphs, `${name}: 차례 문단`);
    if (field) {
      const cmd = /<hp:stringParam name="Command" xml:space="preserve">([^<]*)<\/hp:stringParam>/.exec(await sectionXml(out))?.[1];
      assert.equal(cmd, v.command, `${name}: 차례 필드 Command`);
      assert.equal(paras[1].toc, true, `${name}: 빈 캐럿 문단 자리에 들어간다(필드로 넣기)`);
    } else {
      assert.equal(paras[1].text, '', `${name}: 문자열로 넣기는 빈 캐럿 문단을 남긴다`);
      assert.ok(!paras.some((p) => p.toc), `${name}: 문자열로 넣기는 차례 필드가 없다`);
    }
    // 탭: 오른쪽 탭이면 채움 점선(3)·오른쪽(2), 자동 탭이면 채움 없음
    const tab = /<hp:tab width="\d+" leader="(\d+)" type="(\d+)"\/>/.exec(tocSlice(paras, field).map((p) => p.xml).join(''));
    if (tab) assert.deepEqual([tab[1], tab[2]], v.options.autoTab ? ['0', '2'] : ['3', '2'], `${name}: 탭`);
  }
});

test('캐럿이 글 있는 문단이면 그 문단 뒤에 넣는다(한/글 실측) · 차례 탭 정의는 단 너비 오른쪽 점선 탭', { skip: SKIP }, async () => {
  const doc = open(fs.readFileSync(SRC));
  const r = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 0, options: { table: false, picture: false, equation: false, hyperlink: false } })));
  assert.deepEqual([r.start, r.end], [1, 8]);
  const out = Buffer.from(doc.exportHwpx());
  const paras = await bodyParas(out);
  assert.equal(paras[0].text, '시험 보고서');
  assert.equal(paras[1].text, '<제목 차례>');
  const header = await headerXml(out);
  assert.match(header, /<hh:tabItem pos="42520" type="RIGHT" leader="DASH" unit="HWPUNIT"\/>/, '단 너비(A4·30mm 여백 = 42520) 오른쪽 점선 탭');
});

test('새로 고침: 개요 문단을 더하면 항목이 생기고 쪽 번호가 다시 매겨진다 · 고치기(선택 사항 바꿔 다시)', { skip: SKIP }, async () => {
  const doc = open(fs.readFileSync(SRC));
  const made = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para: caretAfterFirst(doc), options: {} })));
  const styles = JSON.parse(doc.getStyleList());
  const outline1 = styles.find((s) => s.name === '개요 1').id;
  const last = doc.getParagraphCount(0) - 1;
  doc.splitParagraph(0, last, doc.getParagraphLength(0, last));
  doc.insertText(0, last + 1, 0, '새 장');
  doc.applyStyle(0, last + 1, outline1);
  const at = JSON.parse(doc.getTableOfContentsAt(JSON.stringify({ sec: 0, para: made.start + 2 })));
  assert.equal(at.found, true);
  assert.equal(at.options.hyperlink, true);
  const u = JSON.parse(doc.updateTableOfContents(JSON.stringify({ sec: 0, para: made.start + 2 })));
  assert.equal(u.ok, true);
  const paras = tocSlice(await bodyParas(Buffer.from(doc.exportHwpx())), true);
  const entry = paras.find((p) => p.text.startsWith('4. 새 장\t'));
  assert.ok(entry, '새 개요 1 문단이 차례에 들어온다');
  assert.equal(entry.style, '차례 1');
  // 고치기: 표·그림·수식 차례 빼고 하이퍼링크 없이
  doc.updateTableOfContents(JSON.stringify({ sec: 0, para: u.start, options: { table: false, picture: false, equation: false, hyperlink: false } }));
  const after = tocSlice(await bodyParas(Buffer.from(doc.exportHwpx())), true);
  assert.ok(!after.some((p) => p.text === '<표 차례>'), '표 차례가 빠진다');
  assert.ok(!after.some((p) => p.link), '하이퍼링크가 빠진다');
  assert.equal(JSON.parse(doc.listTablesOfContents()).length, 1, '차례는 하나 그대로');
  assert.equal(JSON.parse(doc.updateAllTablesOfContents()).count, 1);
});

/** 편집기에서 문서 끝에 개요 1 문단 '부록'(새 문단 — 저장된 id 없음)을 더한다 */
function addHeading(doc, text = '부록') {
  const styles = JSON.parse(doc.getStyleList());
  const last = doc.getParagraphCount(0) - 1;
  doc.splitParagraph(0, last, doc.getParagraphLength(0, last));
  doc.insertText(0, last + 1, 0, text);
  doc.applyStyle(0, last + 1, styles.find((s) => s.name === '개요 1').id);
  return last + 1;
}

test('하이퍼링크: 문서 안 대상으로 찾아간다 · 고유 id 없는 새 제목은 새 id · 저장해도 문단 id 그대로 · 차례 코드로 모은 제목은 링크 없음(한/글)', { skip: SKIP }, async () => {
  const doc = open(fs.readFileSync(SRC));
  addHeading(doc);
  doc.makeTableOfContents(JSON.stringify({ sec: 0, para: caretAfterFirst(doc), options: { code: true } }));
  const out = Buffer.from(doc.exportHwpx());
  const paras = await bodyParas(out);
  const links = paras.filter((p) => p.link);
  assert.ok(links.length >= 9);
  for (const p of links) {
    const hit = JSON.parse(doc.findHyperlinkTarget(`?#${p.target};0;${p.link};0;`));
    assert.equal(hit.found, true, `${p.text} → 대상`);
    if (p.link === 1) assert.ok(paras.some((q) => q.id === p.target), `${p.text}: 대상 문단 id 가 저장본에 있다`);
  }
  // 새 개요 문단('부록' — 편집기에서 만든 문단이라 저장된 id 가 없다)은 새 고유 id 를 받고 차례 항목이 그 id 를 가리킨다
  const added = paras.find((p) => p.text === '부록');
  assert.ok(added && added.id !== '0' && added.id !== '2147483648', `새 고유 id: ${added?.id}`);
  assert.ok(links.some((p) => p.target === added.id && p.text.startsWith('4. 부록')), '차례 항목이 그 id 를 가리킨다');
  // 원래 고유 id 는 그대로 저장된다(종전 rhwp 는 0,1,2… 로 다시 매겨 한/글 링크가 끊겼다)
  assert.ok(paras.some((p) => p.id === '159318310' && p.text === '서론'));
  // 차례 코드(제목 차례 표시)로 모은 제목은 링크가 없다 — 한/글 새로 고침과 같다
  const toc = tocSlice(paras, true);
  for (const t of ['표시한 제목', '나. 개요2 표시']) {
    const e = toc.find((p) => p.text.startsWith(t + '	'));
    assert.ok(e && !e.link && e.style === '차례 1', `${t}: 수준 1·링크 없음`);
  }
});

test('제목 차례 표시·차례 숨기기 켜고 끄기 · 숨긴 개요 문단은 차례에서 빠진다', { skip: SKIP }, async () => {
  const doc = open(fs.readFileSync(SRC));
  // 2 = '서론 본문입니다.'(본문 스타일)
  assert.equal(JSON.parse(doc.setTitleMark(JSON.stringify({ sec: 0, para: 2, kind: 'title' }))).state, 'title');
  assert.equal(JSON.parse(doc.getTitleMark(JSON.stringify({ sec: 0, para: 2 }))).state, 'title');
  let p2 = (await bodyParas(Buffer.from(doc.exportHwpx())))[2];
  assert.match(p2.xml, /<hp:titleMark ignore="1"\/>/, '제목 차례 표시 = ignore="1"(HWP5 Mtit)');
  assert.equal(JSON.parse(doc.setTitleMark(JSON.stringify({ sec: 0, para: 2, kind: 'title' }))).state, 'none', '다시 하면 지운다');
  // 1 = '서론'(개요 1) 을 차례 숨김 → 개요 차례에서 빠진다
  assert.equal(JSON.parse(doc.setTitleMark(JSON.stringify({ sec: 0, para: 1, kind: 'hide' }))).state, 'hide');
  p2 = (await bodyParas(Buffer.from(doc.exportHwpx())))[1];
  assert.match(p2.xml, /<hp:titleMark ignore="0"\/>/, '차례 숨김 = ignore="0"(HWP5 Mign)');
  doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 0, options: { table: false, picture: false, equation: false, hyperlink: false } }));
  const toc = tocSlice(await bodyParas(Buffer.from(doc.exportHwpx())), true);
  assert.ok(!toc.some((p) => p.text.startsWith('1. 서론')), '숨긴 개요 문단은 빠진다');
});

test('수식 캡션은 저장해도 남는다(종전에는 사라졌다) · 차례 스타일이 없는 문서는 바탕글로 만든다', { skip: SKIP }, async () => {
  const xml = await sectionXml(Buffer.from(open(fs.readFileSync(SRC)).exportHwpx()));
  const eq = xml.slice(xml.indexOf('<hp:equation'), xml.indexOf('</hp:equation>'));
  assert.match(eq, /<hp:caption\b/, '수식 캡션');
  assert.match(eq, /<hp:autoNum num="1" numType="EQUATION"/);
  if (fs.existsSync(PLAN)) {
    const doc = open(fs.readFileSync(PLAN));
    doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 0, options: {} }));
    const paras = await bodyParas(Buffer.from(doc.exportHwpx()));
    const toc = tocSlice(paras, true);
    assert.ok(toc.length >= 4);
    assert.ok(toc.every((p) => p.style === '바탕글'), '차례 스타일이 없으면 바탕글(한/글 실측)');
    assert.ok(toc.some((p) => p.text === '<표 차례>'));
  }
});

/** 차례 필드 표지 수(시작·끝)와 구역 나누기 수 */
const markCount = (xml) => ({
  begin: (xml.match(/type="TABLEOFCONTENTS"/g) || []).length,
  end: (xml.match(/<hp:fieldEnd beginIDRef="\d+" fieldid="628387683"/g) || []).length,
  secPr: (xml.match(/<hp:secPr\b/g) || []).length,
});
const tocRanges = (doc) => JSON.parse(doc.listTablesOfContents()).map((t) => [t.start, t.end]);
const noTocOpts = { table: false, picture: false, equation: false };

test('차례 지우기: 다 골라 지우면 필드째 없어지고 되돌리면 그대로 · 일부만 지우면 남은 줄까지로 줄어든다 · 줄마다 비우고 Backspace 해도 없어진다', { skip: SKIP }, async () => {
  const fresh = () => {
    const doc = open(fs.readFileSync(SRC));
    const r = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para: caretAfterFirst(doc), options: noTocOpts })));
    return { doc, r };
  };
  {
    // 차례 첫 줄 처음 ~ 마지막 줄 끝을 골라 지움(편집기 선택 지우기 = 조각 저장 → deleteRange)
    const { doc, r } = fresh();
    const n = doc.getParagraphCount(0);
    const frag = doc.captureDeleteRange(0, r.start, r.end);
    doc.deleteRange(0, r.start, 0, r.end, doc.getParagraphLength(0, r.end));
    assert.deepEqual(tocRanges(doc), [], '차례 필드가 없어진다(종전: 시작 표지만 남아 서버에 깨진 차례가 남았다)');
    assert.deepEqual(markCount(await sectionXml(Buffer.from(doc.exportHwpx()))), { begin: 0, end: 0, secPr: 1 });
    doc.restoreDeleteFragment(frag);
    assert.deepEqual(tocRanges(doc), [[r.start, r.end]], '되돌리면 차례 그대로');
    assert.equal(doc.getParagraphCount(0), n);
  }
  {
    // 차례 셋째 줄 가운데 ~ 차례 뒤 문단 처음: 차례가 지운 자리까지로 줄어든다(되돌리면 그대로)
    const { doc, r } = fresh();
    const frag = doc.captureDeleteRange(0, r.start + 2, r.end + 1);
    doc.deleteRange(0, r.start + 2, 3, r.end + 1, 0);
    assert.deepEqual(tocRanges(doc), [[r.start, r.start + 2]]);
    assert.deepEqual(markCount(await sectionXml(Buffer.from(doc.exportHwpx()))), { begin: 1, end: 1, secPr: 1 });
    doc.restoreDeleteFragment(frag);
    assert.deepEqual(tocRanges(doc), [[r.start, r.end]]);
  }
  {
    // 차례 앞 문단 끝 ~ 차례 셋째 줄 가운데: 시작이 사라지면 남은 끝 표지는 저장하지 않는다(한/글은 짝 없는 끝이 문단 머리에 있으면 파일을 못 연다)
    const { doc, r } = fresh();
    doc.deleteRange(0, r.start - 1, doc.getParagraphLength(0, r.start - 1), r.start + 2, 1);
    assert.deepEqual(tocRanges(doc), []);
    assert.deepEqual(markCount(await sectionXml(Buffer.from(doc.exportHwpx()))), { begin: 0, end: 0, secPr: 1 });
  }
  {
    // 줄마다 글을 지우고 Backspace 로 앞 줄과 합치기를 끝까지 — 마지막에 차례가 없어진다. 마지막 줄 하나만 합치면 차례는 남는다
    const { doc, r } = fresh();
    doc.mergeParagraph(0, r.end);
    assert.deepEqual(tocRanges(doc), [[r.start, r.end - 1]], '빈 마지막 줄(필드 끝)을 합쳐도 차례는 닫힌 채 남는다');
    for (let i = r.end - 1; i > r.start; i--) {
      const len = doc.getParagraphLength(0, i);
      if (len) doc.deleteRange(0, i, 0, i, len);
      doc.mergeParagraph(0, i);
    }
    doc.deleteRange(0, r.start, 0, r.start, doc.getParagraphLength(0, r.start));
    assert.deepEqual(tocRanges(doc), []);
    assert.deepEqual(markCount(await sectionXml(Buffer.from(doc.exportHwpx()))), { begin: 0, end: 0, secPr: 1 });
  }
});

/** 한/글 2022 '만들 위치: 현재 문서의 새 구역'(제목 차례만·하이퍼링크 없이)으로 만든 뒤 한/글이 새로 고친 차례(out_ns 실측 2026-10-29) */
const NEW_SECTION_TOC = ['<제목 차례>', '1. 서론\t3', '나. 연구 목적\t3', '2. 방법\t5', '1) 세부 방법\t5', '나. 개요2 표시\t5', '3. 결론\t6', ''];

test('만들 위치 새 구역: 캐럿 문단 뒤에서 구역을 나눠 차례만 든 구역, 그 뒤는 다시 새 구역(한/글 2022 실측) · 새로 고침해도 그대로', { skip: SKIP }, async () => {
  const doc = open(fs.readFileSync(SRC));
  const pages = doc.pageCount();
  const r = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 0, options: { ...noTocOpts, hyperlink: false }, newSection: true })));
  assert.deepEqual([r.start, r.end], [1, 8], '캐럿 문단(0) 뒤');
  assert.equal(doc.pageCount(), pages + 2, '차례 구역 한 쪽 + 뒤 구역이 새 쪽에서');
  const check = async (label) => {
    const out = Buffer.from(doc.exportHwpx());
    const paras = await bodyParas(out);
    assert.deepEqual(paras.slice(1, 9).map((p) => p.text), NEW_SECTION_TOC, `${label}: 차례 글·쪽(한/글 새로 고침과 같음)`);
    assert.deepEqual(paras.map((p, i) => (/<hp:secPr\b/.test(p.xml) ? i : -1)).filter((i) => i >= 0), [0, 1, 9], `${label}: 구역 나누기 = 첫 문단·차례 첫 문단·'서론'`);
    assert.ok(paras[1].toc, `${label}: 차례 첫 문단에 차례 필드`);
    assert.equal(paras[9].text, '서론');
    for (const i of [1, 9]) assert.match(paras[i].xml, /<hp:startNum pageStartsOn="BOTH" page="0"/, `${label}: 쪽 번호 이어서`);
    return out;
  };
  const out = await check('만들기');
  JSON.parse(doc.updateTableOfContents(JSON.stringify({ sec: 0, para: r.start })));
  await check('새로 고침');
  const again = open(out);
  assert.equal(again.pageCount(), pages + 2, '다시 열어도 구역·쪽 그대로');
  assert.deepEqual(tocRanges(again), [[1, 8]]);
});

test('서버: 새 구역 차례 · 차례 흔적 빈 줄 하나 지우기 · 차례 지우기가 실시간으로 그대로 들어간다(서식 덩어리·되돌아감 없음)', { skip: SKIP, timeout: 180000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(SRC), '새구역차례.hwpx');
    const working = async () => { const w = await A.res(`/api/docs/${id}/file?kind=working`); return { doc: open(w.data), v: Number(w.headers.get('x-doc-version')) }; };
    const push = async (doc, v) => A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: Buffer.from(doc.exportHwpx()) });
    const exported = async () => (await A.res(`/api/docs/${id}/file?kind=export`)).data;

    // 1) 새 구역 차례
    let { doc, v } = await working();
    const r = JSON.parse(doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 0, options: noTocOpts, newSection: true })));
    let res = await push(doc, v);
    assert.equal(res.clean, true);
    let ex = await exported();
    let paras = await bodyParas(ex);
    assert.deepEqual(paras.map((p, i) => (/<hp:secPr\b/.test(p.xml) ? i : -1)).filter((i) => i >= 0), [0, r.start, r.end + 1], '서버 문서에도 구역 나누기 셋');
    assert.ok(paras[r.start].toc && paras[r.end].end);
    assert.equal(open(ex).pageCount(), doc.pageCount(), '서버 문서 쪽 수 = 편집기');
    const same = await diffDocs(await HwpxDoc.load(ex), await HwpxDoc.load(Buffer.from(doc.exportHwpx())));
    assert.deepEqual((same.hunks || same).filter((h) => h.type !== 'format').map((h) => [h.type, h.ref, h.objectSummary ?? h.newText]), [], '서버 문서 = 편집기 문서');

    // 2) 차례 줄 글만 모두 지운다 → 모양(차례 제목·차례 1·차례 2·빈 줄)이 다른 빈 줄이 남는다 → 그 가운데 한 줄을 Backspace
    ({ doc, v } = await working());
    for (let i = r.start; i <= r.end; i++) { const len = doc.getParagraphLength(0, i); if (len) doc.deleteRange(0, i, 0, i, len); }
    res = await push(doc, v);
    assert.equal(res.clean, true);
    ({ doc, v } = await working());
    doc.mergeParagraph(0, r.start + 3);
    res = await push(doc, v);
    assert.equal(res.clean, true, '빈 줄 하나 지우기 = 깨끗(종전: 다른 빈 줄이 지워지고 서식 덩어리 수십 개 → 편집기가 다시 열렸다)');
    assert.equal(res.applied.deleted.length, 1);
    // 바뀐 문단은 합친 앞 줄 하나뿐(지운 줄의 빈 하이퍼링크 필드를 이어 받음 — 부호 덩어리) · 서식 덩어리 없음
    assert.ok(res.applied.changed.every((ref) => ref === `s0/p${r.start + 2}`), JSON.stringify(res.applied));
    ex = await exported();
    assert.equal(open(ex).getParagraphCount(0), doc.getParagraphCount(0));

    // 3) 남은 차례를 다 골라 지운다 → 서버 문서에도 차례 표지가 남지 않는다
    ({ doc, v } = await working());
    const [t] = JSON.parse(doc.listTablesOfContents());
    doc.deleteRange(0, t.start, 0, t.end, doc.getParagraphLength(0, t.end));
    res = await push(doc, v);
    assert.equal(res.clean, true);
    ex = await exported();
    const m = markCount(await sectionXml(ex));
    assert.deepEqual([m.begin, m.end], [0, 0], '차례 필드 시작·끝 모두 없음');
    assert.deepEqual(tocRanges(open(ex)), []);
  } finally {
    await srv.stop();
  }
});

test('서버: 짝 시작이 없는 차례 필드 끝(지운 차례의 흔적)은 편집기가 저장하지 않고 서버도 지운다 — 한/글이 파일을 못 열던 꼴', { skip: SKIP, timeout: 180000 }, async () => {
  // 차례를 만든 문서에서 차례 필드 시작만 떼어 낸 문서(사용자 문서에 생긴 꼴: 빈 문단 머리에 짝 없는 fieldEnd)
  const doc0 = open(fs.readFileSync(SRC));
  doc0.makeTableOfContents(JSON.stringify({ sec: 0, para: caretAfterFirst(doc0), options: noTocOpts }));
  const zip = await JSZip.loadAsync(Buffer.from(doc0.exportHwpx()));
  const xml = await zip.file('Contents/section0.xml').async('string');
  const broken = xml.replace(/<hp:ctrl><hp:fieldBegin [^>]*type="TABLEOFCONTENTS"[\s\S]*?<\/hp:fieldBegin><\/hp:ctrl>/, '');
  assert.notEqual(broken, xml);
  zip.file('Contents/section0.xml', broken);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '짝없는끝.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const doc = open(w.data);
    const head = Buffer.from(doc.exportHwpx());
    assert.equal(markCount(await sectionXml(head)).end, 0, '편집기 저장본에 짝 없는 끝이 없다');
    const d = await diffDocs(await HwpxDoc.load(w.data), await HwpxDoc.load(head));
    assert.deepEqual((d.hunks || d).filter((h) => h.type !== 'format').map((h) => [h.type, h.objectSummary]), [['object', '조판 부호 지움: 짝 없는 필드 끝']]);
    const res = await A(`/api/docs/${id}/live?base=${Number(w.headers.get('x-doc-version'))}`, { method: 'PUT', body: head });
    assert.equal(res.clean, true);
    const ex = (await A.res(`/api/docs/${id}/file?kind=export`)).data;
    assert.equal(markCount(await sectionXml(ex)).end, 0, '서버 문서에서도 지워진다');
  } finally {
    await srv.stop();
  }
});

test('서버: 실시간 밀어 넣기 → 한글로 저장에 차례 필드·하이퍼링크·오른쪽 탭·대상 문단 id · 다시 비교하면 차이 없음', { skip: SKIP, timeout: 180000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const A = srv.api('a');
    const { id } = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(SRC), '차례시험.hwpx');
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const doc = open(w.data);
    doc.setTitleMark(JSON.stringify({ sec: 0, para: 2, kind: 'title' }));
    addHeading(doc);
    doc.makeTableOfContents(JSON.stringify({ sec: 0, para: caretAfterFirst(doc), options: { code: true } }));
    const head = Buffer.from(doc.exportHwpx());
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: head });
    assert.equal(r.unsupported, 0, '지원하지 않는 변경 경고 없음');
    const ex = await A.res(`/api/docs/${id}/file?kind=export`);
    const paras = await bodyParas(ex.data);
    const toc = tocSlice(paras, true);
    const want = tocSlice(await bodyParas(head), true).map(pick);
    assert.deepEqual(toc.map(pick), want, '편집기 차례 그대로');
    assert.ok(/fieldid="628387683"/.test(toc[0].xml), '차례 필드 시작');
    assert.ok(toc[toc.length - 1].end, '차례 필드 끝');
    for (const p of toc.filter((x) => x.link)) {
      assert.match(p.xml, /<hp:tab width="\d+" leader="3" type="2"\/>/, `${p.text}: 오른쪽 점선 탭(종전 <hp:tab/> 이면 한/글이 왼쪽 탭으로 그린다)`);
      if (p.link === 1) assert.ok(paras.some((q) => q.id === p.target), `${p.text}: 링크 대상 문단 id 가 서버 문서에 있다`);
    }
    assert.match(paras.find((p) => p.text === '서론 본문입니다.').xml, /<hp:titleMark ignore="1"\/>/, '제목 차례 표시');
    const added = paras.find((p) => p.text === '부록');
    assert.ok(toc.some((p) => p.link === 1 && p.target === added?.id), `새 제목 문단의 id(${added?.id})가 서버 문서에 실리고 차례 링크가 가리킨다`);
    const again = await diffDocs(await HwpxDoc.load(ex.data), await HwpxDoc.load(head));
    assert.deepEqual((again.hunks || again).filter((h) => h.type !== 'format').map((h) => [h.type, h.ref, h.objectSummary ?? h.newText]), [], '서버 문서 = 편집기 문서');
    open(ex.data).getParagraphCount(0); // 편집기 엔진으로 다시 열린다
  } finally {
    await srv.stop();
  }
});
