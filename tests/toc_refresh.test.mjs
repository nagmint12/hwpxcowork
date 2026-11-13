// node --test tests/toc_refresh.test.mjs — 'AI 에게 차례 새로 고침 시키기'(2026-10-30):
//  1) 서버 엔진: 동기 ZIP(engine/zip-sync.js)·차례 자리(engine/toc.js tocRegions)·차례 문단 역할(tocRole — 표준서식 마무리 규칙)
//  2) 문단 모양 '한 줄로 입력'(paragraph.oneLine → lineWrap SQUEEZE) — 편집기 엔진(rhwp)이 그 문단을 한 줄로 그린다
//  3) 서버: 지시 '차례 새로고침해줘'(모의 서버 AI → tocUpdates applyNow) → 바로 새로 고침(새 제목 항목·링크 대상 id 맞춤·요청 메모)
//  4) MCP propose_toc_update(apply_styles·one_line) → 사람이 적용 → 차례 스타일·되돌리기, 차례 없는 문서는 NO_TOC
// 서버는 시험 받침(빈 포트·임시 data·모의 AI)으로 띄운다. 한/글 2022 확인은 scratchpad 의 한글 COM 으로 따로 했다(CHANGELOG).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, uploadDoc, root, fixture } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { tocRegions, physicalParas, tocRole, docBytesSync, containerFromBytesSync } from '../engine/toc.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const SRC = fixture('toc_source.hwpx');
const SKIP = typeof open(fs.readFileSync(SRC)).updateTableOfContents !== 'function' && '엔진에 차례 API 가 없습니다 — npm run build:engine';

/** 차례를 만든 뒤 개요 1 문단 '부록'(새 문단 — 고유 id 없음)을 더해 차례가 낡은 문서 */
function staleTocDoc() {
  const doc = open(fs.readFileSync(SRC));
  doc.splitParagraph(0, 0, doc.getParagraphLength(0, 0));
  doc.makeTableOfContents(JSON.stringify({ sec: 0, para: 1, options: {} }));
  const styles = JSON.parse(doc.getStyleList());
  const last = doc.getParagraphCount(0) - 1;
  doc.splitParagraph(0, last, doc.getParagraphLength(0, last));
  doc.insertText(0, last + 1, 0, '부록');
  doc.applyStyle(0, last + 1, styles.find((s) => s.name === '개요 1').id);
  const out = Buffer.from(doc.exportHwpx()); doc.free();
  return out;
}
const tocTexts = (d) => { const r = tocRegions(d)[0]; const ph = physicalParas(d.sections[r.sec]); return ph.slice(r.start, r.end + 1).map((p) => d.text(p.rec.ref)); };

test('서버 엔진: 동기 ZIP 왕복·차례 자리·차례 문단 역할(표준서식 규칙)', { skip: SKIP }, async () => {
  const d = await HwpxDoc.load(staleTocDoc());
  const regs = tocRegions(d);
  assert.equal(regs.length, 1);
  assert.match(regs[0].command, /^TableOfContents:set:\d+:ContentsMake:uint:31 /);
  assert.equal(tocTexts(d)[0], '<제목 차례>');
  assert.ok(!tocTexts(d).some((t) => t.startsWith('4. 부록')), '더한 제목은 아직 차례에 없다');
  // 동기 ZIP: 쓰고 다시 읽으면 같은 구역 XML
  const back = new HwpxDoc(containerFromBytesSync(docBytesSync(d)));
  assert.equal(back.sections[0].xml, d.sections[0].xml);
  assert.equal(back.header.xml, d.header.xml);
  const roles = ['<제목 차례>', '<표 차례>', '1. 분석 개요\t1', '부록\t57', '1) 추진 배경\t3', '가. 세부\t4', '[표 3] 분석 표본\t5', '그림 2 흐름도\t6', '', '제2장 방법\t3', '1.2 범위\t4'].map(tocRole);
  assert.deepEqual(roles, ['head', 'head', 'l1', 'l1', 'l2', 'l3', 'item', 'item', null, 'l1', 'l2']);
});

test('한 줄로 입력(paragraph.oneLine): lineWrap SQUEEZE — 편집기 엔진이 넘치는 문단을 한 줄로 그린다', { skip: SKIP }, async () => {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  const ref = 's0/p0';
  const long = '차례 항목처럼 긴 제목 글이 한 줄을 넘어가면 한/글은 한 줄로 입력 문단에서 자간을 줄여 한 줄에 담는다 '.repeat(2);
  d.replaceTracked(ref, 0, [...d.text(ref)].length, long, { author: '시험' });
  d.acceptAll();
  const lines = async () => { const e = open(await d.save()); try { return JSON.parse(e.getLineInfo(0, 0, 0)).lineCount; } finally { e.free(); } };
  assert.ok(await lines() > 1, '그냥은 여러 줄');
  const r = d.formatRange(ref, { start: 0, end: [...d.text(ref)].length, paragraph: { oneLine: true } });
  assert.equal(r.changed, true);
  assert.match(d.header.block('paraPr', r.after.paraPrId), /lineWrap="SQUEEZE"/);
  assert.equal(r.after.paragraph.oneLine, true);
  assert.equal(await lines(), 1, '한 줄로 입력이면 한 줄');
  d.formatRange(ref, { start: 0, end: [...d.text(ref)].length, paragraph: { oneLine: false } });
  assert.ok(await lines() > 1);
});

/** MCP 도구 한 번 → 결과 JSON | { error } */
async function mcp(srv, name, args) {
  const r = await fetch(`${srv.base}/mcp?agent=TocTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': 'sessT', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('서버: 「차례 새로고침해줘」 → 모의 서버 AI 가 바로 새로 고침, MCP propose_toc_update(스타일·한 줄) → 적용·되돌리기', { skip: SKIP, timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'mock' });
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.a, staleTocDoc(), 'toc.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const before = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    const startRef = tocRegions(before)[0].startRef;
    // 1) 지시 → 모의 서버 AI → 바로 적용
    const res = await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '차례 새로고침해줘', route: 'server', target: { ref: startRef } } });
    const p1 = (await A(`${D}/proposals`)).find((p) => p.rid === res.request.rid);
    assert.deepEqual([p1.type, p1.status], ['toc', 'applied']);
    assert.ok(p1.tocResult.entries > 0);
    let now = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    const texts = tocTexts(now);
    const entry = texts.find((t) => /^\d+\. 부록\t\d+$/.test(t));
    assert.ok(entry, `새 제목이 차례에 들어온다: ${texts.join(' | ')}`);
    // 하이퍼링크 대상: 새 제목 문단이 받은 id 가 이 문서에도 있다
    const sec = now.sections[0].xml;
    const target = [...sec.matchAll(/<hp:stringParam name="Command">\?#(\d+);0;1;0;<\/hp:stringParam>/g)].map((m) => m[1]);
    assert.ok(target.length > 0);
    for (const id of target) assert.match(sec, new RegExp(`<hp:p id="${id}"`), `링크 대상 문단 id ${id}`);
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === res.request.rid);
    assert.match(memo.text, /반영 1건/);
    // 2) MCP: 스타일 다시 주기 + 한 줄로(대기 제안) → 사람이 적용 → 되돌리기
    const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '차례 스타일 다시', route: 'queue', target: { ref: startRef } } })).request;
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid });
    const bad = await mcp(srv, 'propose_toc_update', { doc_id: doc.id, apply_styles: true, styles: { level1: '없는 스타일' }, request_id: req.rid });
    assert.match(bad.error, /STYLE_MISSING|없는 스타일/);
    const p2 = await mcp(srv, 'propose_toc_update', { doc_id: doc.id, toc_ref: startRef, apply_styles: true, one_line: true, request_id: req.rid, expected_attempt: 1 });
    assert.deepEqual([p2.type, p2.status, p2.toc.styles.title, p2.toc.styles.level1, p2.toc.oneLine], ['toc', 'pending', '차례 제목', '차례 1', true]);
    const ap = await A(`${D}/proposals/${p2.pid}/apply`, { method: 'POST' });
    assert.equal(ap.status, 'applied');
    now = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    const r = tocRegions(now)[0]; const ph = physicalParas(now.sections[r.sec]);
    const styleName = new Map(now.formattingCatalog().styles.map((s) => [s.id, s.name]));
    const styleOf = (p) => styleName.get(/styleIDRef="(\d+)"/.exec(now.sections[r.sec].xml.slice(p.start, p.start + 300))[1]);
    const head = ph.slice(r.start, r.end + 1).find((p) => now.text(p.rec.ref) === '<제목 차례>');
    assert.equal(styleOf(head), '차례 제목');
    const l1 = ph.slice(r.start, r.end + 1).find((p) => /^1\. /.test(now.text(p.rec.ref)));
    assert.equal(styleOf(l1), '차례 1');
    const un = await A(`${D}/proposals/${p2.pid}/undo`, { method: 'POST' });
    assert.equal(un.status, 'undone');
    const back = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(tocTexts(back), texts, '되돌리면 1) 의 차례로');
    // 수정본 반영은 안 된다(바로 적용만)
    await A(`${D}/proposals/${p2.pid}/reopen`, { method: 'POST' });
    assert.equal((await A.res(`${D}/proposals/${p2.pid}/adopt`, { method: 'POST' })).status, 400);
    // 3) 차례 없는 문서
    const plain = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(fixture('tool_memo_tracked.hwpx')), 'plain.hwpx');
    const none = await mcp(srv, 'propose_toc_update', { doc_id: plain.id, apply_now: true });
    assert.match(none.error, /NO_TOC/);
  } finally { await srv.stop(); }
});
