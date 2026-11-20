// 개체 → 본문(objects_to_body) 안전장치(2026-11-17) — '글자는 다 남았는데 문서는 망가진' 결과가 통과하지 않게(engine/flow.js·server/page-estimate.js·server/layout-worker.js).
// 실제 일: 24쪽 PDF 변환 문서(구역마다 쪽 배경 그림 + 글상자 수백 개)를 옮기자 쪽 배경 그림이 글 앞에 남아 16쪽의 글을 덮고, 구역을 합치지 못하고
// 글자처럼 취급한 표가 쪽을 넘어 48쪽(그림만 있는 쪽 8)이 됐으며, 숫자 두 개가 붙어도('2.59'+'2.75') 글자 수 검사는 통과했다. 큰 문서라 쪽 수 어림도 건너뛰었다.
// 시험 문서는 지어낸 것이다(tests/helpers/floating-doc.mjs + 쪽 배경 그림 tests/helpers/page-background.mjs). 모델을 부르지 않는다.
//   node --test tests/objects_to_body_safety.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { objectsToBody, numberCheck, compressionRatio } from '../engine/flow.js';
import { editPageLayout } from '../engine/page-layout.js';
import { normalizePageLayoutOps } from '../server/page-layout-schema.js';
import { LayoutChecker } from '../server/layout-check.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { floatingDoc } from './helpers/floating-doc.mjs';
import { addPageBackground, plainPng, contentPng } from './helpers/page-background.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLS = [6000, 14000, 11000, 16800];
const HEAD = ['구분', '항목', '값', '비고'];
/** 지어낸 통계 쪽 하나: 제목 + 머리행 있는 표 + 쪽 번호 */
const page = (i, rows = 6) => ({ title: `제${i}장 통계`, pageNumber: String(i), table: { cols: COLS, header: true, rows: [HEAD, ...Array.from({ length: rows }, (_, r) => [`가${r}`, `항목 ${i}-${r}`, `${i}.${r}5`, `설명 ${r}`])] } });
const pics = (doc) => doc.sections.flatMap((s) => [...s.xml.matchAll(/<hp:pic\b[^>]*>/g)].map((m) => (/textWrap="([^"]*)"/.exec(m[0]) || [])[1]));

// 편집기 엔진(우리 fork WASM — 서버 조판 작업자와 같은 것)으로 쪽마다 표 높이·본문 높이를 잰다(웹 표시 확인은 엔진 계산값 — AGENTS.md §2.1)
let rhwp = null;
async function engine() {
  if (rhwp) return rhwp;
  // 후보 엔진을 절대 경로로 줘도 되게 resolve 로 잇는다(join 은 절대 경로를 루트 뒤에 붙여 깨뜨렸다 — 2026-11-19 재검).
  const pkg = path.resolve(root, process.env.HWPX_COWORK_ENGINE_PKG || path.join('vendor', 'rhwp', 'pkg'));
  rhwp = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
  globalThis.measureTextWidth ??= (font, text) => String(text).length * 10;
  rhwp.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
  return rhwp;
}
async function pageTables(bytes) {
  const m = await engine(); const d = new m.HwpDocument(new Uint8Array(bytes));
  try {
    const out = [];
    for (let p = 0; p < d.pageCount(); p++) {
      const info = JSON.parse(d.getPageInfo(p));
      const body = (info.footerArea ? info.footerArea.y : info.height) - (info.headerArea ? info.headerArea.y + info.headerArea.height : 0);
      const tables = (JSON.parse(d.getPageControlLayout(p)).controls || []).filter((c) => c.type === 'table');
      out.push({ body, tables: tables.map((t) => t.h) });
    }
    return out;
  } finally { d.free?.(); }
}

test('그림 압축률과 숫자 보존 검사(순수 함수)', () => {
  // 무늬 없는 쪽 바탕은 아주 잘 줄고(≤ 0.02), 글줄처럼 촘촘한 점이 든 그림(스캔한 쪽의 대역)은 덜 준다
  assert.ok(compressionRatio(plainPng()) <= 0.02, `바탕 ${compressionRatio(plainPng())}`);
  assert.ok(compressionRatio(contentPng()) > 0.02, `내용 ${compressionRatio(contentPng())}`);
  assert.equal(compressionRatio(new Uint8Array(64)), null);   // 모르는 형식
  const M = (o) => new Map(Object.entries(o));
  // 붙음: 두 수가 사이 글자 없이 하나가 된다
  assert.match(numberCheck(M({ '2.59': 1, '2.75': 1, 7: 1 }), M({ '2.592.75': 1, 7: 1 })).problems.join(), /붙은 숫자 1개\(2\.592\.75 ← 2\.59 \+ 2\.75\)/);
  // 갈라짐: 한 수가 둘로
  assert.match(numberCheck(M({ '1,234': 1 }), M({ 1: 1, 234: 1 })).problems.join(), /갈라진 숫자 1개\(1,234 → 1 · 234\)/);
  // 조각 경계에서 갈라졌던 수를 다시 이은 것('2.' + '59' → '2.59')은 괜찮다
  assert.deepEqual(numberCheck(M({ 2: 1, 59: 1 }), M({ '2.59': 1 })).problems, []);
  // 같은 다중집합이면 문제 없음, 사라짐·늘어남
  assert.deepEqual(numberCheck(M({ 3: 2, '4.5': 1 }), M({ '4.5': 1, 3: 2 })), { checked: 3, problems: [] });
  assert.match(numberCheck(M({ 3: 2 }), M({ 3: 1, 8: 1 })).problems.join(' / '), /사라진 숫자 1개\(3\) \/ 늘어난 숫자 1개\(8\)/);
});

test('쪽 배경 그림(무늬 없는 바탕, 글 앞·글상자 밑): 기본으로 지우고 구역을 합친다 — 남는 그림 없음, 엔진 조판에서 가려진 쪽·그림만 있는 쪽 없음', { timeout: 60000 }, async (t) => {
  const doc = await floatingDoc({ pages: [page(1), page(2), page(3)] });
  assert.equal(addPageBackground(doc, { kind: 'plain' }), 3);
  const { report } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual(report.backgrounds, { mode: 'remove', removed: 3, behind: 0, content: 0 });
  assert.equal(report.kept, 0);
  assert.deepEqual(report.sections, [3, 1]);   // 첫 문단이 비어 구역을 합친다(남기면 원래 쪽마다 새 쪽 — 쪽 폭증)
  assert.deepEqual(pics(doc), []);
  assert.equal(report.covering, undefined);
  assert.ok(report.text.numbers > 0 && report.text.lost === 0);
  // 엔진 조판(작업자 — server/page-estimate.js 와 같은 길): 가려진 쪽 없음
  const lc = new LayoutChecker(); t.after(() => lc.stop());
  const est = await lc.estimate([{ bytes: await doc.save(), covered: true }], { sparseBelow: 0.15 });
  assert.equal(est.ok, true, JSON.stringify(est));
  assert.deepEqual(est.results[0].covered, []);
  assert.deepEqual(est.results[0].sections, [est.results[0].pages]);
});

test("쪽 배경 그림 background:'behind': 지우지 않고 글 뒤로 — 그 구역은 합치지 않는다(원래 쪽마다 새 쪽)", async () => {
  const doc = await floatingDoc({ pages: [page(1), page(2)] });
  addPageBackground(doc, { kind: 'plain' });
  const { report } = objectsToBody(doc, { background: 'behind', author: '시험' });
  assert.deepEqual(report.backgrounds, { mode: 'behind', removed: 0, behind: 2, content: 0 });
  assert.deepEqual(pics(doc), ['BEHIND_TEXT', 'BEHIND_TEXT']);
  assert.deepEqual(report.sections, [2, 2]);
  assert.equal(report.covering, undefined);
  // 쪽 구성 op 꼴과 결과 줄
  const out = editPageLayout(await (async () => { const d = await floatingDoc({ pages: [page(1)] }); addPageBackground(d); return d; })(), normalizePageLayoutOps([{ op: 'objects_to_body', background: 'behind' }]), { author: '시험' });
  assert.match(out.labels[0], / · 쪽 배경 그림 1장 글 뒤로/);
  assert.throws(() => normalizePageLayoutOps([{ op: 'objects_to_body', background: 'keep' }]));
});

test('내용으로 보이는 쪽 그림(스캔한 쪽 꼴)은 지우지 않고 글 뒤로 보낸다 — 무늬 없는 배경만 지운다', async () => {
  const doc = await floatingDoc({ pages: [page(1), page(2), page(3)] });
  addPageBackground(doc, { sections: [0, 2], kind: 'plain' });
  addPageBackground(doc, { sections: [1], kind: 'content' });
  const { report } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual(report.backgrounds, { mode: 'remove', removed: 2, behind: 1, content: 1 });
  assert.deepEqual(pics(doc), ['BEHIND_TEXT']);
  // 1구역은 첫 문단에 그림이 남아 합치지 않는다. 2구역은 그 뒤(글 뒤 그림 — 글을 덮지 않는다)에 합친다
  assert.deepEqual(report.sections, [3, 2]);
  assert.match(editPageLayout(await (async () => { const d = await floatingDoc({ pages: [page(1)] }); addPageBackground(d, { kind: 'content' }); return d; })(), normalizePageLayoutOps([{ op: 'objects_to_body' }]), { author: '시험' }).labels[0],
    / · 쪽 배경 그림 1장 글 뒤로\(내용으로 보여 지우지 않음 1장\)/);
});

test('쪽 배경이 아닌 쪽 크기 그림(캡션 있음 · 글상자 위에 놓임)은 그대로 두고, 옮긴 글을 덮을 수 있다고 알린다 — 엔진 조판에서 가려진 쪽', { timeout: 60000 }, async (t) => {
  // 캡션 글이 있는 그림 = 내용
  const cap = await floatingDoc({ pages: [page(1)] });
  addPageBackground(cap, { caption: '그림 설명' });
  const a = objectsToBody(cap, { author: '시험' }).report;
  assert.equal(a.backgrounds, undefined);
  assert.equal(a.covering.count, 1);
  assert.deepEqual(a.covering.items.map((x) => [x.ref, x.name, x.share]), [['s0/p0', '그림', 1]]);
  // 글상자보다 위 차례(zOrder)의 글 앞 그림 = 원래도 글을 덮던 것(배경이 아니다)
  const over = await floatingDoc({ pages: [page(1), page(2)] });
  addPageBackground(over, { sections: [1], zOrder: 100000 });
  const b = objectsToBody(over, { author: '시험' }).report;
  assert.equal(b.backgrounds, undefined);
  assert.equal(b.covering.count, 1);
  assert.deepEqual(pics(over), ['IN_FRONT_OF_TEXT']);
  // 쪽을 차지하는 글 앞 그림이 있는 1구역에는 2구역을 합치지 않는다 — 결과 줄에 경고
  assert.deepEqual(b.sections, [2, 2]);
  const label = editPageLayout(await (async () => { const d = await floatingDoc({ pages: [page(1)] }); addPageBackground(d, { zOrder: 100000 }); return d; })(), normalizePageLayoutOps([{ op: 'objects_to_body' }]), { author: '시험' }).labels[0];
  assert.match(label, / · ⚠ 글 앞 개체 1개가 옮긴 글 영역에 겹침$/);
  // 엔진 조판: 그 그림 밑으로 본문 글이 그려지는 쪽을 가려진 쪽으로 잰다(쪽 번호 0부터)
  const lc = new LayoutChecker(); t.after(() => lc.stop());
  const est = await lc.estimate([{ bytes: await cap.save(), covered: true }], {});
  assert.equal(est.ok, true, JSON.stringify(est));
  assert.deepEqual(est.results[0].covered, [0]);
});

test('그림만 있는 쪽(글상자 없는 구역의 쪽 크기 글 앞 그림) 뒤 구역은 그 쪽에 합치지 않는다', async () => {
  const doc = await floatingDoc({ pages: [page(1), {}, page(3)] });
  addPageBackground(doc, { sections: [1], kind: 'content' });
  // 여백을 그대로(모두 0) 두어 구역 정의가 같게 — 여백이 달라 합치지 않는 경우와 가린다
  const { report } = objectsToBody(doc, { margins: 'keep', author: '시험' });
  // 그 쪽은 옮길 글이 없어 손대지 않는다(그림 그대로 글 앞). 2구역을 합치면 글이 그 그림 밑으로 흐른다
  assert.deepEqual(report.sections, [3, 3]);
  assert.deepEqual(pics(doc), ['IN_FRONT_OF_TEXT']);
  assert.equal(report.covering, undefined);
});

test('옮긴 표는 자리차지·셀 단위로 나눔 — 칸 글이 접혀 한 쪽보다 길어진 표가 쪽에서 나뉜다(엔진 조판: 쪽 본문보다 높은 표 조각 없음)', { timeout: 60000 }, async () => {
  // 칸 글이 원래 쪽에서 다섯 줄씩(줄마다 낱말 조각) — 넣을 때의 높이 어림(줄마다 한 줄)보다 실제 표가 훨씬 길다
  const long = (i) => Array.from({ length: 5 }, (_, k) => `설명 ${i}-${k} 줄은 길게`).join('\n');
  const rows = (from) => Array.from({ length: 8 }, (_, r) => [`가${from + r}`, `항목 ${from + r}`, `${from + r}.5`, long(from + r)]);
  const doc = await floatingDoc({ pages: [
    { title: '긴 표', pageNumber: '1', table: { cols: COLS, header: true, rows: [HEAD, ...rows(0)] } },
    { pageNumber: '2', table: { cols: COLS, rows: rows(8) } },
  ] });
  const { report } = objectsToBody(doc, { author: '시험' });
  assert.deepEqual(report.tables.map((x) => [x.rows, x.pages]), [[17, 2]]);
  const tbl = /<hp:tbl\b[^>]*>[\s\S]*?<hp:pos\b[^>]*>/.exec(doc.sections[0].xml)[0];
  assert.match(tbl, /pageBreak="CELL"/); assert.match(tbl, /treatAsChar="0"/);
  const pages = await pageTables(await doc.save());
  assert.ok(pages.length >= 2, `쪽 ${pages.length}`);
  for (const [i, p] of pages.entries()) for (const h of p.tables) assert.ok(h <= p.body + 1, `${i + 1}쪽 표 조각 ${h}px > 본문 ${p.body}px`);
});

test('숫자가 붙은 채 조용히 통과하지 않는다: 붙어 있던 두 숫자 조각 — 글자 수는 같아도 숫자 토큰이 다르면 FLOW_VERIFY, 아니면 두 숫자가 따로 남는다', async () => {
  // 한 줄에 틈 없이 붙은 두 숫자 글상자(조각 끝에 빈칸 없음) — 줄로 이을 때 빈칸을 넣지 않으면 '2.592.75'
  const doc = await floatingDoc({ pages: [{ title: '값', lines: [{ x: 6000, y: 20000, text: '2.59' }, { x: 6000 + 4 * 520, y: 20000, text: '2.75' }] }] });
  let report = null;
  try { report = objectsToBody(doc, { author: '시험' }).report; } catch (e) {
    assert.equal(e.code, 'FLOW_VERIFY');
    assert.match(e.message, /붙은 숫자 1개\(2\.592\.75 ← 2\.59 \+ 2\.75\)/);
    return;
  }
  const text = doc.paragraphs({ nested: true }).map((p) => p.text).join('\n');
  assert.ok(!/2\.592\.75/.test(text), text);
  assert.deepEqual([...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).sort(), ['2.59', '2.75']);
  assert.equal(report.text.numbers, 2);
});

test('큰 문서(한도를 넘는 XML)도 개체 → 본문이면 조판 작업자가 결과로 쪽 수를 어림한다 — dry_run·저장 영수증의 all_applied, 결과 미리 보기의 그림 표지', { timeout: 180000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-o2b-safety-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config: { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 } }, ai: { enabled: false } });
  const src = await floatingDoc({ pages: [page(1, 10), page(2, 10), page(3, 10)] });
  addPageBackground(src, { kind: 'plain' });
  const docId = store.create({ fileName: 'floating.hwpx', bytes: Buffer.from(await src.save()), by: user.name }).id;
  const take = async () => {
    const r = (await service.createRequest(docId, { kind: 'instruct', instruction: '본문으로 옮겨 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
    await service.agentTake(user, 'claude-code', 'sess-1', { docId, rid: r.rid });
    return r.rid;
  };
  const rid = await take();
  service.cfg.verify = { pages: { maxChars: 10 } };   // 문서를 '큰 문서'로
  const ops = [{ op: 'objects_to_body', margins: { left: 30, right: 30, top: 20, bottom: 15, header: 15, footer: 15 } }];
  const dry = await service.agentEdit(docId, { ops, rid, dryRun: true }, user, 'claude-code');
  assert.ok(!dry.pages.skipped, JSON.stringify(dry.pages));
  assert.equal(dry.pages.now, 3);
  assert.equal(typeof dry.pages.all_applied, 'number', JSON.stringify(dry.pages));
  assert.match(dry.pages.note, /커서.*조판 작업자에서 구조 op\(개체 → 본문·쪽 구성\)만 반영해 어림했다/);
  assert.equal(dry.pages.covered, undefined);
  assert.equal(dry.structure.result[0].backgrounds, '3장 지움');
  assert.match(dry.structure.result[0].numbers, /^숫자 \d+개 그대로$/);
  assert.match(dry.structure.labels[0], / · 쪽 배경 그림 3장 지움/);
  assert.ok(!/▣ 그림/.test(dry.structure.after), dry.structure.after);
  // 글 뒤로 남기면 결과 미리 보기에 그 그림이 '(글 뒤)' 로 보이고, 구역을 합치지 않는다
  const behind = await service.agentEdit(docId, { ops: [{ ...ops[0], background: 'behind' }], rid, dryRun: true }, user, 'claude-code');
  assert.match(behind.structure.after, /▣ 그림 210×297mm\(글 뒤\)/);
  assert.equal(behind.structure.result[0].backgrounds, '3장 글 뒤로');
  assert.equal(typeof behind.pages.all_applied, 'number');
  assert.ok(behind.pages.all_applied >= 3 && behind.pages.sections?.length === 3, JSON.stringify(behind.pages));
  // 배치 요약(요청 내용·read view='layout')도 쪽 배경 그림을 지운다고 알린다
  assert.match(JSON.parse(JSON.stringify(await service.agentRead(docId, { view: 'layout' }, user))).text, /쪽 배경 그림 3장은 지움\(남기려면 background:'behind'\) · 남는 개체 없음/);
  // 저장: 영수증의 쪽 수 = dry_run 의 쪽 수(대기 제안인 쪽 구성 제안을 작업자가 반영)
  const saved = await service.agentEdit(docId, { ops, rid }, user, 'claude-code');
  assert.ok(saved.structure?.pid && !saved.failed, JSON.stringify(saved).slice(0, 400));
  assert.equal(saved.pages.all_applied, dry.pages.all_applied);
});

test('쪽을 넘는 표(join_pages 기본): 한 표로 잇고 되풀이 머리행은 버린 줄로 알린다 — 배치 요약·dry_run 영수증에 그대로', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-o2b-join-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config: { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 } }, ai: { enabled: false } });
  const rows = (from) => Array.from({ length: 5 }, (_, r) => [`가${from + r}`, `항목 ${from + r}`, `${from + r}.5`, `설명 ${from + r}`]);
  const src = await floatingDoc({ pages: [
    { title: '이어지는 표', pageNumber: '1', table: { cols: COLS, header: true, rows: [HEAD, ...rows(0)] } },
    { pageNumber: '2', table: { cols: COLS, header: true, rows: [HEAD, ...rows(5)] } },   // 머리행이 쪽마다 되풀이된다
  ] });
  const docId = store.create({ fileName: 'join.hwpx', bytes: Buffer.from(await src.save()), by: user.name }).id;
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction: '본문으로 옮겨 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, 'claude-code', 'sess-1', { docId, rid: r.rid });
  const layout = (await service.agentRead(docId, { view: 'layout' }, user)).text;
  assert.match(layout, /objects_to_body 로 옮기면: 표 1개 — ① s0\/p0~s1\/p0 11줄×4칸 · 문단 1개 · 버릴 줄 \d+개\(쪽 번호·되풀이 머리행\)/);
  assert.match(layout, / · 쪽을 넘는 표 1개는 한 표로 이음\(쪽마다 따로는 join_pages:false\)/);
  const dry = await service.agentEdit(docId, { ops: [{ op: 'objects_to_body' }], rid: r.rid, dryRun: true }, user, 'claude-code');
  const res = dry.structure.result[0];
  assert.deepEqual(res.tables.map((x) => [x.rows, x.pages]), [[11, 2]]);
  assert.match(res.joined, /^쪽을 넘는 표 1개를 한 표로 이었다/);
  assert.match(res.dropped.why, /되풀이 머리행/);
  assert.match(res.text, /\(빠진 글자 0\)$/);
  // false = 쪽마다 따로 표(머리행을 버리지 않는다)
  const apart = (await service.agentEdit(docId, { ops: [{ op: 'objects_to_body', join_pages: false }], rid: r.rid, dryRun: true }, user, 'claude-code')).structure.result[0];
  assert.deepEqual(apart.tables.map((x) => [x.rows, x.pages]), [[6, 1], [6, 1]]);
  assert.equal(apart.joined, undefined);
  assert.ok(!/되풀이 머리행/.test(apart.dropped?.why || ''));
});
