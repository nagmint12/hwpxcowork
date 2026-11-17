// 표·그림·차트에 딸린 글(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-8 — engine/captions-notes.js): 표의 단위 줄·주석, 그림·차트의 주석, 차트 캡션.
//  · 엔진: 표준서식 문서(tutorial 'AI 활용 심화 — 연습 보고서' 사본 — 읽기만)에서는 그 문서의 표·그림 + 주석 문단 모양 그대로
//    (단위 줄 '&표단위' 문단, [개체][줄 바꿈][주석] 한 문단 '&표주석', 표 앵커 1pt), 보통 문서에서는 단위 줄 오른쪽 문단·주석 따로 문단
//  · 임시 서버: 새 연결 edit 의 table(unit·notes)·chart(caption·notes)·figure(notes) → 제안 → 같은 자리 문단 넣기와 섞어 [모두 반영] →
//    문단 차례·스타일·글·extraRefs → 되돌리기 → 원래대로(고친 글만·변경 추적 두 방식)
//   node --test tests/captions_notes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { insertUnitParagraph, attachNotes, addChartCaption, normUnit, normNotes } from '../engine/captions-notes.js';
import { nativeChartDocument } from '../server/native-chart.js';
import { parseOps } from '../server/mcp2/ops.js';
import { startServer, uploadDoc, fixture, root } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const PRACTICE = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const hasPractice = fs.existsSync(PRACTICE);
const PLAIN = fixture('tool_memo_tracked.hwpx');
const author = '시험(Claude)';
const chartSpec = { type: 'bar', categories: ['2024', '2025'], series: [{ name: '인원', values: [10, 20] }] };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#cccccc"/></svg>';

const styleName = (d, ref) => { const id = d.inspectFormatting(ref).styleId; return d.formattingCatalog().styles.find((s) => String(s.id) === String(id))?.name; };
const paraXml = (d, ref) => { const { sec, p } = d.resolve(ref); return sec.xml.slice(p.start, p.end); };
const openAttr = (xml, name) => (new RegExp(`^<hp:p\\b[^>]*\\b${name}="(\\d+)"`).exec(xml) || [])[1];
const body = (d) => d.paragraphs({ nested: false }).map((p) => p.ref);
const bodyTexts = (d) => d.paragraphs({ nested: false }).map((p) => p.text);

test('글 정리: 단위 줄 꼴·주석 줄', () => {
  assert.equal(normUnit('명, %'), '(단위: 명, %)');
  assert.equal(normUnit('단위: 건'), '(단위: 건)');
  assert.equal(normUnit('(단위: 천 원)'), '(단위: 천 원)');
  assert.equal(normUnit(''), '');
  assert.deepEqual(normNotes('주: 가.\n자료: 나'), ['주: 가.', '자료: 나']);
  assert.deepEqual(normNotes(['주: 가.', '  ', '자료: 나']), ['주: 가.', '자료: 나']);
  assert.equal(normNotes([]), null);
  assert.throws(() => normNotes(Array(21).fill('주')), (e) => e.code === 'BAD_NOTES');
  // op 꼴: 표 unit·notes, 차트 caption·notes, 그림 notes 를 받는다
  const ok = parseOps([
    { op: 'table', after: 's0/p1', rows: [['a']], unit: '명', notes: ['주: 가'] },
    { op: 'chart', after: 's0/p1', chart: chartSpec, caption: '차트', notes: '주: 나' },
    { op: 'figure', after: 's0/p1', svg: SVG, caption: '그림', notes: '주: 다' },
  ]);
  assert.deepEqual(ok.errors, []);
  assert.equal(parseOps([{ op: 'table', after: 's0/p1', rows: [['a']], notes: Array(21).fill('주') }]).errors.length, 1);
});

test('엔진 — 표준서식(연습 보고서 사본): 문서에 있는 단위 줄·표 + 주석·그림 + 주석 문단 모양 그대로', { skip: !hasPractice && '연습 보고서 없음' }, async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  // 본보기(연습 보고서의 실제 표 하나): 단위 줄 → 표 + 주석 문단
  const tbl = d.tables().find((t) => !t.ref.includes('/n'));
  const model = { unit: paraXml(d, `s1/p${Number(/p(\d+)$/.exec(tbl.ref)[1]) - 1}`), table: paraXml(d, tbl.ref) };
  assert.equal(styleName(d, `s1/p${Number(/p(\d+)$/.exec(tbl.ref)[1]) - 1}`), '&표단위');
  const pic = d.figures()[0]; const picXml = paraXml(d, pic.ref);
  const A = 's1/p33'; const a = 33;
  const u = insertUnitParagraph(d, 1, a, '명, %', { author });
  const t = d.insertTableAfter(1, a + 1, { rows: [['구분', '값'], ['가', '1']], caption: '시험 표' }, { author });
  const n = attachNotes(d, t.ref, ['주: 가상 자료.', '자료: 시험'], { kind: 'table', author });
  assert.deepEqual([u.ref, t.ref, n.inline, n.ref], ['s1/p34', 's1/p35', true, null]);
  assert.equal(styleName(d, u.ref), '&표단위'); assert.equal(d.text(u.ref, 'final'), '(단위: 명, %)');
  assert.equal(openAttr(paraXml(d, u.ref), 'paraPrIDRef'), openAttr(model.unit, 'paraPrIDRef'), '단위 줄 문단 모양 = 문서의 단위 줄');
  assert.equal(styleName(d, t.ref), '&표주석');
  assert.equal(d.text(t.ref, 'final'), '\n주: 가상 자료.\n자료: 시험');
  const tx = paraXml(d, t.ref);
  assert.equal(openAttr(tx, 'paraPrIDRef'), openAttr(model.table, 'paraPrIDRef'), '표 + 주석 문단 모양 = 문서의 표 + 주석');
  // 표 앵커·줄 바꿈 런은 문서 본보기의 1pt 글자, 주석은 주석 글자 모양(본보기 표 문단의 런 차례와 같다)
  const runs = (x) => [...x.matchAll(/<hp:run charPrIDRef="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(runs(tx.replace(/<hp:tbl\b[\s\S]*<\/hp:tbl>/, '')), runs(model.table.replace(/<hp:tbl\b[\s\S]*<\/hp:tbl>/, '')).slice(0, 2));
  assert.equal(d.header.charHeight(runs(tx)[0]), 100);
  assert.match(tx, /<\/hp:tbl><hp:t><hp:insertBegin [^>]*\/><hp:lineBreak\/><hp:insertEnd [^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="\d+"><hp:t><hp:insertBegin [^>]*\/>주: 가상 자료\.<hp:lineBreak\/>자료: 시험<hp:insertEnd/);
  assert.equal(d.tables().find((x) => x.ref === t.ref).caption.text, '[표 ] 시험 표');
  // 그림 주석: [그림][줄 바꿈][주석] 한 문단 — 문서의 그림 + 주석 문단 모양
  const f = d.insertPictureAfter(1, a + 2, { data: makePng(400, 200), caption: '시험 그림' }, { author });
  const fn = attachNotes(d, f.ref, '주: 그림 주석', { kind: 'figure', author });
  assert.equal(fn.inline, true); assert.equal(styleName(d, f.ref), '&표주석');
  assert.equal(openAttr(paraXml(d, f.ref), 'paraPrIDRef'), openAttr(picXml, 'paraPrIDRef'));
  assert.equal(d.text(f.ref, 'final'), '\n주: 그림 주석');
  // 차트: 캡션('[그림 N] 제목' — 차트 안 캡션, 번호 종류 그림) + 주석
  const donor = nativeChartDocument(chartSpec, { width: 32250, height: 18750 });
  const cref = d.insertParagraphAfter(1, a + 3, '', { author });
  d.copyObjectsFrom(donor, 's0/p1', cref);
  assert.equal(addChartCaption(d, cref, '시험 차트', { author }), `${cref}/n0`);
  attachNotes(d, cref, '주: 차트 주석', { kind: 'chart', author });
  assert.equal(d.text(`${cref}/n0`, 'final'), '[그림 ] 시험 차트');
  assert.equal(d.text(cref, 'final'), '\n주: 차트 주석'); assert.equal(styleName(d, cref), '&표주석');
  const cx = paraXml(d, cref);
  assert.match(cx, /<hp:chart\b[^>]*numberingType="PICTURE"[\s\S]*<hp:caption side="BOTTOM"[\s\S]*<hp:autoNum num="\d+" numType="PICTURE"[\s\S]*<\/hp:caption><\/hp:chart>/);
  // 다시 읽어도 같다
  const re = await HwpxDoc.load(await d.save());
  assert.equal(re.text(cref, 'final'), '\n주: 차트 주석'); assert.equal(re.text(`${cref}/n0`, 'final'), '[그림 ] 시험 차트');
  assert.deepEqual(re.ownObjects(cref), [{ kind: 'chart', name: '차트' }]);
});

test('엔진 — 보통 문서: 단위 줄은 표 앞 오른쪽 문단, 주석은 개체 뒤 왼쪽 문단(바탕글)', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PLAIN));
  const u = insertUnitParagraph(d, 0, 0, '명', { author });
  const t = d.insertTableAfter(0, 1, { rows: [['가', '나']], caption: '' }, { author });
  const n = attachNotes(d, t.ref, ['주: 가.', '자료: 나'], { kind: 'table', author });
  assert.deepEqual([u.ref, t.ref, n.inline, n.ref], ['s0/p1', 's0/p2', false, 's0/p3']);
  const align = (ref) => /<hh:align horizontal="(\w+)"/.exec(d.header.block('paraPr', d.inspectFormatting(ref).paraPrId))[1];
  assert.deepEqual([styleName(d, u.ref), align(u.ref), d.text(u.ref, 'final')], ['바탕글', 'RIGHT', '(단위: 명)']);
  assert.match(d.header.block('paraPr', d.inspectFormatting(u.ref).paraPrId), /keepWithNext="1"/);
  assert.deepEqual([styleName(d, n.ref), align(n.ref), d.text(n.ref, 'final')], ['바탕글', 'LEFT', '주: 가.\n자료: 나']);
  assert.equal(d.text(t.ref, 'final'), '', '표 문단에는 글을 넣지 않는다');
});

// ───────── 임시 서버: 새 연결 op → 제안 → [모두 반영] → 되돌리기 ─────────

async function connect(srv, who, query) {
  const client = new Client({ name: 'captions-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}` } } });
  await client.connect(transport);
  const text = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return {
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, text(r)); return JSON.parse(text(r)); },
    close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); },
  };
}

const CASES = [
  ...(hasPractice ? [{ name: '표준서식', file: PRACTICE, anchor: 's1/p33', standard: true }] : []),
  { name: '보통 문서', file: PLAIN, anchor: 's0/p0', standard: false },
];

for (const track of ['final', 'tracked']) {
  test(`임시 서버(${track === 'final' ? '고친 글만' : '변경 추적으로'}): table·chart·figure op → 같은 자리 문단 넣기와 [모두 반영] → 차례·스타일·extraRefs → 되돌리기`, async (t) => {
    const srv = await startServer({ ai: 'off' });
    const open = [];
    t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
    const api = srv.api('a');
    const v2 = await connect(srv, 'a', '?v=2'); open.push(v2);
    for (const c of CASES) {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(c.file), `${c.name}.hwpx`);
      const D = `/api/docs/${doc.id}`;
      if (track === 'tracked') await api(`${D}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
      const orig = await HwpxDoc.load(await api(`${D}/file`));
      const before = bodyTexts(orig);
      const r = (await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '표와 차트를 넣어 주세요', target: { ref: c.anchor } } })).request;
      await v2.call('task', { doc_id: doc.id, request_id: r.rid });
      const out = await v2.call('edit', { doc_id: doc.id, request_id: r.rid, done: '표·차트·그림을 제안했습니다.', ops: [
        { op: 'insert', after: c.anchor, text: '앞 문단' },
        { op: 'table', after: c.anchor, rows: [['구분', '값'], ['가', '1']], caption: '시험 표', unit: '명, %', notes: ['주: 가상 자료.', '자료: 시험 자료'] },
        { op: 'chart', after: c.anchor, chart: chartSpec, caption: '시험 차트', notes: '주: 차트 주석' },
        { op: 'figure', after: c.anchor, svg: SVG, caption: '시험 그림', notes: '주: 그림 주석', width_mm: 60 },
        { op: 'insert', after: c.anchor, text: '뒤 문단' },
      ] });
      assert.ok(!out.failed, JSON.stringify(out.failed));
      assert.equal(out.saved.length, 5);
      let props = await api(`${D}/proposals`);
      const byType = (type, pred = () => true) => props.find((p) => p.type === type && pred(p));
      assert.deepEqual([byType('table').table.unit, byType('table').table.notes], ['(단위: 명, %)', ['주: 가상 자료.', '자료: 시험 자료']]);
      assert.deepEqual([byType('figure', (p) => p.figure.nativeChart).figure.chartCaption, byType('figure', (p) => p.figure.nativeChart).figure.notes], ['시험 차트', ['주: 차트 주석']]);
      assert.deepEqual(byType('figure', (p) => !p.figure.nativeChart).figure.notes, ['주: 그림 주석']);

      // [모두 반영]: 낸 차례대로 — 앞 문단, (단위 줄) 표(+주석), 차트(+주석), 그림(+주석), 뒤 문단
      const res = await api(`${D}/requests/${r.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
      assert.equal(res.counts?.applied ?? res.applied, 5, JSON.stringify(res).slice(0, 600));
      const d = await HwpxDoc.load(await api(`${D}/file`));
      const refs = body(d); const at = refs.indexOf(c.anchor);
      const seq = refs.slice(at + 1, at + (c.standard ? 7 : 10)).map((ref) => ({ ref, text: d.text(ref, 'final'), style: styleName(d, ref), objs: d.ownObjects(ref).map((o) => o.kind).join() }));
      const want = c.standard ? [
        ['앞 문단', null, ''], ['(단위: 명, %)', '&표단위', ''], ['\n주: 가상 자료.\n자료: 시험 자료', '&표주석', 'table'],
        ['\n주: 차트 주석', '&표주석', 'chart'], ['\n주: 그림 주석', '&표주석', 'figure'], ['뒤 문단', null, ''],
      ] : [
        ['앞 문단', null, ''], ['(단위: 명, %)', '바탕글', ''], ['', null, 'table'], ['주: 가상 자료.\n자료: 시험 자료', '바탕글', ''],
        ['', null, 'chart'], ['주: 차트 주석', '바탕글', ''], ['', null, 'figure'], ['주: 그림 주석', '바탕글', ''], ['뒤 문단', null, ''],
      ];
      assert.deepEqual(seq.map((x, i) => [x.text, want[i][1] == null ? null : x.style, x.objs]), want, `${c.name}: ${JSON.stringify(seq)}`);
      // 캡션: 표는 '[표 N] 시험 표', 차트·그림은 '[그림 N] …'(차트도 그림 번호)
      const capText = (ref) => d.paragraphs().find((p) => p.parent === ref && /^\[/.test(p.text))?.text;
      assert.match(capText(seq[c.standard ? 2 : 2].ref), /^\[표 \] 시험 표$/);
      assert.match(capText(seq[c.standard ? 3 : 4].ref), /^\[그림 \] 시험 차트$/);
      assert.match(capText(seq[c.standard ? 4 : 6].ref), /^\[그림 \] 시험 그림$/);
      // extraRefs: 덧붙인 본문 문단(문서 차례) — 뒤 제안이 들어와 주소가 밀려도 맞다
      props = await api(`${D}/proposals`);
      const tp = byType('table'); const cp = byType('figure', (p) => p.figure.nativeChart); const fp = byType('figure', (p) => !p.figure.nativeChart);
      if (c.standard) {
        assert.deepEqual([tp.extraRefs, cp.extraRefs, fp.extraRefs], [[seq[1].ref], undefined, undefined]);
      } else {
        assert.deepEqual([tp.extraRefs, cp.extraRefs, fp.extraRefs], [[seq[1].ref, seq[3].ref], [seq[5].ref], [seq[7].ref]]);
      }
      assert.equal(tp.insertedRef, seq[2].ref);
      // 되돌리기: 표·차트·그림을 하나씩(덧붙인 문단도 함께) → 넣은 두 문단만 남는다 → 그것도 되돌리면 원래대로
      for (const p of [tp, cp, fp]) await api(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
      const mid = await HwpxDoc.load(await api(`${D}/file`));
      assert.deepEqual(bodyTexts(mid), [...before.slice(0, at + 1), '앞 문단', '뒤 문단', ...before.slice(at + 1)], c.name);
      assert.equal(mid.tables().length, orig.tables().length); assert.equal(mid.figures().length, orig.figures().length);
      assert.equal(mid.paragraphs().filter((p) => /시험 (표|차트|그림)/.test(p.text)).length, 0);
      props = await api(`${D}/proposals`);
      assert.ok([tp, cp, fp].every((x) => { const q = props.find((y) => y.pid === x.pid); return q.status === 'undone' && !q.extraRefs && !q.extraLayout; }));
      for (const p of props.filter((x) => x.type === 'insert')) await api(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
      assert.deepEqual(bodyTexts(await HwpxDoc.load(await api(`${D}/file`))), before, `${c.name}: 원래대로`);
      // 다시 하나씩 반영해도(단건) 표는 단위 줄 뒤·주석과 함께
      await api(`${D}/proposals/${tp.pid}/reopen`, { method: 'POST' });
      await api(`${D}/proposals/${tp.pid}/apply`, { method: 'POST' });
      const again = await HwpxDoc.load(await api(`${D}/file`));
      const ar = body(again); const ai = ar.indexOf(c.anchor);
      assert.equal(again.text(ar[ai + 1], 'final'), '(단위: 명, %)');
      assert.equal(again.ownObjects(ar[ai + 2]).map((o) => o.kind).join(), 'table');
      assert.equal(again.text(c.standard ? ar[ai + 2] : ar[ai + 3], 'final').replace(/^\n/, ''), '주: 가상 자료.\n자료: 시험 자료');
    }
  });
}

test('되돌리기 안전: 덧붙인 단위 줄을 고친 뒤면 아무것도 지우지 않고 STALE', async (t) => {
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PLAIN), 'plain.hwpx');
  const D = `/api/docs/${doc.id}`;
  const p = await api(`${D}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p0', table: { rows: [['가']], unit: '건', notes: '주: 가' } } });
  await api(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
  const applied = (await api(`${D}/proposals`)).find((x) => x.pid === p.pid);
  assert.deepEqual(applied.extraRefs, ['s0/p1', 's0/p3']);
  // 단위 줄 글을 바꾸는 제안을 반영 → 되돌리기는 STALE, 문서는 그대로
  const edit = await api(`${D}/proposals`, { method: 'POST', body: { type: 'replace', ref: 's0/p1', find: '건', replace: '명' } });
  await api(`${D}/proposals/${edit.pid}/apply`, { method: 'POST' });
  const before = bodyTexts(await HwpxDoc.load(await api(`${D}/file`)));
  const r = await api.res(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
  assert.equal(r.status, 409); assert.match(JSON.stringify(r.data), /STALE|단위 줄/);
  assert.deepEqual(bodyTexts(await HwpxDoc.load(await api(`${D}/file`))), before);
});
