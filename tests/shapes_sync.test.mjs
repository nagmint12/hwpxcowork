// node --test tests/shapes_sync.test.mjs — 도형(선·사각형·글상자·타원·호·다각형·곡선·연결선·묶음) 옮기기·크기·지우기·넣기·묶기가 공유 문서까지 가는가(2026-10-30).
//  1) 편집기 엔진(rhwp, vendor/rhwp/pkg): 도형 지우기가 뒤 글자 모양 경계를 같이 당긴다 · 사각형 크기를 바꿔도 꼭짓점은 로컬 좌표(orgSz) ·
//     '개체 묶기'로 만든 묶음 안 개체의 이동 행렬에 묶음 안 자리(offset)
//  2) 손대지 않은 문서의 편집기 왕복(열기 → 내보내기)은 object 덩어리가 없다(한/글 도형 문서·보고서 표본) — 거짓 덩어리는 다른 창을 다시 열게 한다
//  3) 편집기에서 옮김·크기·지움 → diffDocs object 덩어리 → copyObjectsFrom 결과 = 한/글이 같은 편집으로 저장한 도형 XML
//     (tests/fixtures/shapes_hangul_edits.json — 한글 COM 실측. 묶음 안 개체 회전 중심만 ±1 반올림 차이)
//  4) 실시간 밀어 넣기(PUT /live): 넣기·묶기·풀기·끝점 옮기기·글상자 글과 옮기기·도형 문단 지우기 → clean, 다시 보내도 그대로, 서버 문서를
//     편집기로 다시 열어 내보내도 덩어리 0, 한글로 저장(kind=export)에 실린다
// 서버는 시험 받침(빈 포트·임시 data·임시 config·AI 끔)으로 띄운다. 진짜 data/·config.json 은 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, uploadDoc, root } from './helpers/server.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { SHAPE_TAGS } from '../engine/shapes.js';

const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
globalThis.measureTextWidth ??= (font, text) => text.length * 10;
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }

// 한/글로 저장한 도형 문서: s0/p2 선 · p3 사각형 · p4 타원 · p5 호 · p6 다각형 · p7 글상자('글상자 안 글') · p8 연결선 · p9 묶음(사각형+타원) · p11 곡선
const FX = path.join(root, 'tests', 'fixtures', 'shapes_hangul.hwpx');
const HANGUL = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'shapes_hangul_edits.json'), 'utf8'));
const REPORT = path.join(root, 'tests', 'samples', '2025년_전체종합보고서.hwpx');
const hasReport = fs.existsSync(REPORT);

const open = (bytes) => new mod.HwpDocument(new Uint8Array(bytes));
const exportOf = (doc) => Buffer.from(doc.exportHwpx());
/** 편집기 문서의 그리기 개체(문서 차례 — 그림 제외) [{ p, ci, sp }] */
function shapes(doc) {
  const out = [];
  for (let p = 0; p < doc.getParagraphCount(0); p++) for (let ci = 0; ci < 12; ci++) {
    try { const sp = JSON.parse(doc.getShapeProperties(0, p, ci)); if (sp && sp.width != null) out.push({ p, ci, sp }); } catch { /* 도형 아님 */ }
  }
  return out;
}
/** 한/글 시험과 같은 편집(i = 문서 차례 i 번째 도형): move(dx, dy)·size(w, h)·del */
function applyOps(doc, ops) {
  for (const o of ops) {
    const s = shapes(doc)[o.i];
    assert.ok(s, `도형 ${o.i}`);
    if (o.op === 'del') { doc.deleteShapeControl(0, s.p, s.ci); continue; }
    const props = o.op === 'move' ? { horzOffset: s.sp.horzOffset + o.dx, vertOffset: s.sp.vertOffset + o.dy } : { width: o.w, height: o.h };
    doc.setShapeProperties(0, s.p, s.ci, JSON.stringify(props));
  }
}
/** 문서의 문단 ref → 그 문단이 직접 가진 도형 XML 들 */
function shapeXml(doc) {
  const out = {};
  for (const sec of doc.sections) for (const p of sec.bodyParas) out[p.ref] = p.anchors.filter((a) => a.kind === 'ctrl' && SHAPE_TAGS.has(a.name)).map((a) => sec.xml.slice(a.start, a.end));
  return out;
}
/** 요소·속성 차례대로 견준다(회전 중심은 ±1 — 한/글 묶음 안 개체 반올림) → 다른 곳 목록 */
function xmlDiff(a, b) {
  const els = (x) => [...x.matchAll(/<([\w:]+)\b([^>]*?)\/?>/g)].map((m) => [m[1], Object.fromEntries([...m[2].matchAll(/([\w:]+)="([^"]*)"/g)].map((q) => [q[1], q[2]]))]);
  const A = els(a); const B = els(b); const out = [];
  if (A.map((e) => e[0]).join() !== B.map((e) => e[0]).join()) return [`요소 차례: ${A.map((e) => e[0]).join(' ')} ↔ ${B.map((e) => e[0]).join(' ')}`];
  A.forEach(([tag, x], i) => {
    const y = B[i][1];
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[k] === y[k]) continue;
      if (tag === 'hp:rotationInfo' && (k === 'centerX' || k === 'centerY') && Math.abs(Number(x[k]) - Number(y[k])) <= 1) continue;
      out.push(`${tag} ${k}: ${x[k]} ↔ ${y[k]}`);
    }
  });
  if (a.replace(/<[^>]*>/g, '') !== b.replace(/<[^>]*>/g, '')) out.push('글이 다름');
  return out;
}
/** 서버 쪽 반영(실시간 밀어 넣기의 object 덩어리와 같은 일): base 를 head 로 견주고 object 덩어리마다 copyObjectsFrom */
async function applyObjects(baseBytes, headBytes) {
  const base = await HwpxDoc.load(baseBytes); const head = await HwpxDoc.load(headBytes);
  const r = await diffDocs(base, head);
  for (const h of r.hunks) if (h.type === 'object') base.copyObjectsFrom(head, h.headRef, h.ref);
  return { base, head, r };
}
const brief = (r) => r.hunks.map((h) => [h.type, h.ref, h.objectSummary ?? h.formatSummary ?? '']);

test('편집기 엔진: 도형 지우기는 뒤 글자 모양을 지킨다 · 사각형 크기는 꼭짓점을 로컬 좌표에 · 묶음 안 개체 행렬에 자리', async () => {
  // 사각형(p3) 크기 9500×6000 → 12500×7000: 한/글은 꼭짓점을 orgSz 좌표 그대로 둔다(크기 좌표로 쓰면 한/글이 배율을 한 번 더 걸어 16447 로 그렸다)
  const d = open(fs.readFileSync(FX));
  const rect = shapes(d)[1];
  d.setShapeProperties(0, rect.p, rect.ci, JSON.stringify({ width: 12500, height: 7000 }));
  const xml = shapeXml(await HwpxDoc.load(exportOf(d)))['s0/p3'][0];
  assert.match(xml, /<hc:pt1 x="9500" y="0"\/><hc:pt2 x="9500" y="6000"\/>/);
  assert.match(xml, /<hp:sz width="12500" widthRelTo="ABSOLUTE" height="7000"/);
  // 개체 묶기: 묶음 안 둘째 개체(타원, 묶음 안 자리 3000,5500 — 한/글 저장본과 같은 꼴)의 transMatrix 에 자리
  const g = open(fs.readFileSync(FX));
  const ss = shapes(g);
  JSON.parse(g.groupShapes(JSON.stringify({ sectionIdx: 0, targets: [ss[1], ss[2]].map((s) => ({ paraIdx: s.p, controlIdx: s.ci })) })));
  const gx = Object.values(shapeXml(await HwpxDoc.load(exportOf(g)))).flat().find((x) => x.startsWith('<hp:container'));
  const kid = /<hp:ellipse\b[\s\S]*?<\/hp:ellipse>/.exec(gx)[0];
  const off = /<hp:offset x="(\d+)" y="(\d+)"\/>/.exec(kid);
  assert.ok(Number(off[1]) > 0 || Number(off[2]) > 0, '타원은 묶음 원점에서 떨어져 있다');
  assert.match(kid, new RegExp(`<hc:transMatrix e1="1" e2="0" e3="${off[1]}" e4="0" e5="1" e6="${off[2]}"/>`), '이동 행렬 = 묶음 안 자리(한/글은 이 행렬로 자식 자리를 잰다)');
});

test('편집기 엔진: 보고서 표지의 선을 지워도 뒤 글자 모양이 그대로(덩어리는 도형 지움 하나)', { skip: !hasReport && '표본 없음' }, async () => {
  const src = fs.readFileSync(REPORT);
  const d = open(src);
  const base = exportOf(d);
  const s = shapes(d)[0];
  assert.equal(s.p, 0);
  d.deleteShapeControl(0, s.p, s.ci);
  const r = await diffDocs(base, exportOf(d));
  // 종전: 지운 선 뒤 8글자가 앞 run 의 글자 모양을 받아 format 덩어리('글꼴·크기·굵게')가 함께 생겼다
  assert.deepEqual(brief(r), [['object', 's0/p0', '도형 지움: 선']]);
  assert.deepEqual(r.unsupported, []);
});

test('손대지 않은 문서의 편집기 왕복은 object 덩어리 0 — 두 번 왕복해도', async () => {
  const files = [FX, path.join(root, 'tests', 'fixtures', 'toc_source.hwpx'), ...(hasReport ? [REPORT] : [])];
  for (const f of files) {
    const src = fs.readFileSync(f);
    const rt = exportOf(open(src));
    const r = await diffDocs(src, rt);
    assert.deepEqual(r.hunks.filter((h) => h.type === 'object').map((h) => [h.ref, h.objectSummary]), [], `${path.basename(f)}: 한/글 원본 ↔ 편집기 내보내기`);
    const r2 = await diffDocs(rt, exportOf(open(rt)));
    assert.deepEqual(brief(r2), [], `${path.basename(f)}: 편집기 내보내기 ↔ 다시 내보내기`);
  }
  // 도형 문서: 지문(objectPrint)도 같다(실시간 clean 판정)
  const src = fs.readFileSync(FX); const a = await HwpxDoc.load(src); const b = await HwpxDoc.load(exportOf(open(src)));
  for (const ref of Object.keys(shapeXml(a))) assert.equal(a.objectPrint(ref), b.objectPrint(ref), ref);
});

for (const kind of ['move', 'size', 'del']) {
  test(`편집기에서 도형 ${kind === 'move' ? '옮기기' : kind === 'size' ? '크기 바꾸기' : '지우기'} → object 덩어리 → 반영 결과 = 한/글이 같은 편집으로 저장한 XML(9가지 도형)`, async () => {
    const src = fs.readFileSync(FX);
    const d = open(src); applyOps(d, HANGUL[kind].ops);
    const { base, r } = await applyObjects(src, exportOf(d));
    assert.deepEqual(r.unsupported, []);
    assert.ok(r.hunks.length > 0 && r.hunks.every((h) => h.type === 'object'), JSON.stringify(brief(r)));
    const want = { move: '옮김', size: '크기', del: '도형 지움' }[kind];
    assert.ok(r.hunks.every((h) => h.objectSummary.includes(want)), JSON.stringify(brief(r)));
    const got = shapeXml(base);
    for (const [ref, xs] of Object.entries(HANGUL[kind].shapes)) {
      assert.equal(got[ref].length, xs.length, `${ref}: 도형 수`);
      xs.forEach((x, k) => assert.deepEqual(xmlDiff(x, got[ref][k]), [], `${ref} 도형 ${k}`));
    }
    // 다시 견주면 그대로(보낸 창이 다시 보내도 바뀔 것 없음)
    assert.deepEqual(brief(await diffDocs(base, await HwpxDoc.load(exportOf(d)))), []);
  });
}

test('보고서 표지 선: 크기(curSz 가 이미 있는 선 — curSz·회전 중심·배율 행렬)·옮기기 = 한/글 저장 XML', { skip: !hasReport && '표본 없음' }, async () => {
  const src = fs.readFileSync(REPORT);
  const d = open(src); applyOps(d, HANGUL.report.ops);
  const { base, r } = await applyObjects(src, exportOf(d));
  assert.deepEqual(brief(r), [['object', 's0/p0', '선 크기 155×0mm → 106×1mm'], ['object', 's0/p4', '선 옮김']]);
  const got = shapeXml(base);
  for (const [ref, xs] of Object.entries(HANGUL.report.shapes)) xs.forEach((x, k) => assert.deepEqual(xmlDiff(x, got[ref][k]), [], `${ref} 도형 ${k}`));
});

test('실시간 밀어 넣기: 도형 넣기·묶기·풀기·끝점·글상자 글과 옮기기·도형 문단 지우기 → clean, 다시 보내도 그대로, 한글로 저장에 실림', { timeout: 180000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const A = srv.api('a');
  const { id } = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(FX), '도형.hwpx');
  /** 지금 서버 문서를 편집기로 열어 edit 하고 밀어 넣는다 → { r(응답), head, doc(서버 문서) } */
  const step = async (name, edit, { formatting = true } = {}) => {
    const w = await A.res(`/api/docs/${id}/file?kind=working`);
    const v = Number(w.headers.get('x-doc-version'));
    const d = open(w.data);
    assert.deepEqual(brief(await diffDocs(Buffer.from(w.data), exportOf(d))), [], `${name}: 서버 문서의 편집기 왕복은 덩어리 0`);
    edit(d);
    const head = exportOf(d);
    const r = await A(`/api/docs/${id}/live?base=${v}`, { method: 'PUT', body: head });
    assert.equal(r.clean, true, `${name}: clean`);
    assert.equal(r.unsupported, 0, `${name}: 반영 안 되는 변경 없음`);
    assert.equal(r.version, v + 1, `${name}: 커밋 하나`);
    // 도형을 고친 커밋은 서식 커밋처럼 다른 창이 다시 연다(글만 맞추기로는 도형이 따라오지 않는다). 문단째 지우기는 글 맞추기로 따라간다
    if (formatting) assert.equal(r.formatVersion, r.version, `${name}: 개체 커밋(다른 창은 다시 연다)`);
    // 같은 창이 같은 문서를 다시 보낸다(편집기는 formatVersion 으로 다시 열지 않는다 — 새 도형의 id 를 서버가 다시 매겨도 같은 도형)
    const again = await A(`/api/docs/${id}/live?base=${r.version}`, { method: 'PUT', body: head });
    assert.deepEqual([again.version, again.applied], [r.version, { changed: [], inserted: [], deleted: [] }], `${name}: 다시 보내도 그대로`);
    const doc = await HwpxDoc.load((await A.res(`/api/docs/${id}/file?kind=working`)).data);
    assert.deepEqual(brief(await diffDocs(doc, await HwpxDoc.load(head))), [], `${name}: 서버 문서 = 보낸 문서`);
    return { r, doc };
  };
  const find = (d, para) => shapes(d).filter((s) => s.p === para);

  // 넣기: 빈 문단(p1)에 타원·사각형, 글 문단(p3) 글자 2 앞에 선
  let { r, doc } = await step('넣기', (d) => {
    for (const [para, off, type, x, y] of [[1, 0, 'ellipse', 40000, 20000], [1, 0, 'rectangle', 40000, 30000], [3, 2, 'line', 45000, 40000]]) {
      d.createShapeControl(JSON.stringify({ sectionIdx: 0, paraIdx: para, charOffset: off, width: 8000, height: 4000, horzOffset: x, vertOffset: y, shapeType: type, treatAsChar: false, textWrap: 'InFrontOfText' }));
    }
  });
  assert.deepEqual(r.applied.changed, ['s0/p1', 's0/p3']);
  let xs = shapeXml(doc);
  assert.deepEqual([xs['s0/p1'].length, xs['s0/p3'].length], [2, 2]);
  assert.match(xs['s0/p1'].join(''), /<hp:pos [^>]*vertOffset="30000" horzOffset="40000"\/>/);
  assert.equal(doc.text('s0/p3'), '도형 문단 2 — rectangle', '도형을 넣어도 글은 그대로');

  // 묶기(p3 의 원래 사각형 + p4 타원) — 편집기 묶음은 id 0, 서버가 새로 매긴다
  ({ r, doc } = await step('묶기', (d) => {
    const ss = [...find(d, 3).filter((s) => s.sp.width === 9500), ...find(d, 4)];
    assert.equal(ss.length, 2);
    d.groupShapes(JSON.stringify({ sectionIdx: 0, targets: ss.map((s) => ({ paraIdx: s.p, controlIdx: s.ci })) }));
  }));
  xs = shapeXml(doc);
  const grp = Object.values(xs).flat().filter((x) => x.startsWith('<hp:container'));
  assert.equal(grp.length, 2, '원래 묶음 + 새 묶음');
  for (const g of grp) assert.doesNotMatch(/^<hp:container\b[^>]*>/.exec(g)[0], /\sid="0"/, '묶음 id 를 매겼다');
  assert.equal(xs['s0/p4'].length, 0, '묶은 타원은 묶음 안으로');

  // 풀기(원래 묶음 p9) → 사각형·타원 두 개체
  ({ r, doc } = await step('풀기', (d) => { const g = find(d, 9)[0]; d.ungroupShape(0, g.p, g.ci); }));
  assert.deepEqual(shapeXml(doc)['s0/p9'].map((x) => /^<([\w:]+)/.exec(x)[1]), ['hp:rect', 'hp:ellipse']);

  // 선 끝점 옮기기(p2): 기울기가 바뀐 선 — 로컬 좌표(orgSz·꼭짓점)를 편집기 것으로
  ({ r, doc } = await step('끝점', (d) => { const s = find(d, 2)[0]; d.moveLineEndpoint(0, s.p, s.ci, 8000, 23000, 20000, 20000); }));
  const line = shapeXml(doc)['s0/p2'][0];
  assert.match(line, /<hc:startPt x="0" y="3000"\/><hc:endPt x="12000" y="0"\/>/);
  assert.match(line, /<hp:sz width="12000" widthRelTo="ABSOLUTE" height="3000"/);

  // 글상자 글 + 옮기기(같은 문단): 글은 글상자 문단 덩어리, 자리는 object 덩어리
  ({ r, doc } = await step('글상자', (d) => {
    const s = find(d, 7)[0];
    d.insertTextInCell(0, 7, s.ci, 0, 0, 0, '앞 ');
    d.setShapeProperties(0, s.p, s.ci, JSON.stringify({ horzOffset: s.sp.horzOffset + 500 }));
  }));
  assert.deepEqual(r.applied.changed, ['s0/p7', 's0/p7/n0']);
  assert.equal(doc.text('s0/p7/n0'), '앞 글상자 안 글');
  assert.match(shapeXml(doc)['s0/p7'][0], /horzOffset="23500"\/>/);

  // 도형이 든 문단 지우기: 곡선을 지우고 그 문단(p11)을 앞 문단에 합침 → 기준의 곡선 문단 = delete(objects) — 문단째 지우고 글은 앞 문단에.
  // (편집기의 범위 지우기는 떠 있는 도형을 지우지 않고 남은 문단으로 옮긴다 — 그때는 '도형 넣음'으로 그대로 따라간다)
  const before = await HwpxDoc.load((await A.res(`/api/docs/${id}/file?kind=working`)).data);
  const n0 = before.sections[0].bodyParas.length;
  ({ r, doc } = await step('문단 지우기', (d) => { const s = find(d, 11)[0]; d.deleteShapeControl(0, s.p, s.ci); d.mergeParagraph(0, 11); }, { formatting: false }));
  assert.deepEqual([r.applied.deleted, doc.sections[0].bodyParas.length], [['s0/p11'], n0 - 1]);
  assert.equal(doc.text('s0/p10'), `${before.text('s0/p10')}${before.text('s0/p11')}`);
  assert.doesNotMatch(doc.sections[0].xml, /<hp:curve\b/);

  // 한글로 저장: 넣은 도형·묶음·글상자 자리가 실린다
  const ex = await HwpxDoc.load((await A.res(`/api/docs/${id}/file?kind=export`)).data);
  const all = Object.values(shapeXml(ex)).flat().join('');
  assert.match(all, /<hp:pos [^>]*vertOffset="30000" horzOffset="40000"\/>/);
  assert.match(all, /horzOffset="23500"\/>/);
  assert.equal((all.match(/<hp:container\b/g) || []).length, 1, '새 묶음 하나(원래 묶음은 풀었다)');
});
