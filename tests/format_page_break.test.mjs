// 문단 앞 쪽 나눔(paragraph.pageBreakBefore — 2026-11-17 작업 P) 회귀 시험. 모델을 부르지 않는다.
//  배경: 실제 Codex 재시험 Y05(artifacts/mcp-round3-20261117/codex/REPORT-G2.md 새 문제 1)는 쪽 나눔을 끌 키가 없어 장 제목을 지우고 다시 넣었다
//  (쪽 나눔과 함께 문단 모양의 '다음 문단과 함께'도 잃었다). 한/글 2022 실측(artifacts/mcp-round3-20261117/P/DESIGN.md §2):
//  연습 보고서의 '장은 새 쪽에서' = 문단 태그 pageBreak="1"(2·3·4장·참고문헌 제목 4개), 원본 10쪽 · 그 넷을 끄면 8쪽,
//  문단 모양 breakSetting pageBreakBefore 도 따로 저장되고 그 문단 앞에서 쪽을 나눈다.
//  · 엔진: 끄기·켜기·되돌리기·문단 모양 쪽 나눔 끄기·표 칸 거절, 예전 꼴(FormatSchema)은 그대로
//  · 새 연결: read view='format' 표시 → edit(format 끄기 + insert 의 format 켜기) → [모두 반영] → XML·엔진 쪽 수 → 되돌리기
//   node --test tests/format_page_break.test.mjs   (엔진은 RHWP_PKG, 기본 vendor/rhwp/pkg. 결과 문서를 남기려면 PAGE_BREAK_OUT=<폴더>)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { forcedPageBreak, validateFormatSpec } from '../engine/formatting.js';
import { FormatSchema, ParagraphFormatSchema, normalizeFormat } from '../server/format-schema.js';
import { parseOps } from '../server/mcp2/ops.js';
import { formatSummary } from '../server/memotext.js';
import { formatSummary as webFormatSummary } from '../web/formatting.js';
import { startServer, uploadDoc, root } from './helpers/server.mjs';

const PRACTICE = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const CHAPTERS = ['s1/p14', 's1/p30', 's1/p61', 's1/p67'];   // 2·3·4장·참고문헌 — 문단 태그 쪽 나눔(한/글 Ctrl+Enter)
const pkgDir = path.resolve(root, process.env.RHWP_PKG || 'vendor/rhwp/pkg');
const mod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
globalThis.measureTextWidth ??= (font, text) => String(text).length * 10;
if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { mod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
const pages = (bytes) => new mod.HwpDocument(new Uint8Array(bytes)).pageCount();
const tagBreaks = async (bytes, sec = 1) => ((await (await JSZip.loadAsync(bytes)).file(`Contents/section${sec}.xml`).async('string')).match(/<hp:p [^>]*pageBreak="1"/g) || []).length;
const whole = (d, ref) => ({ start: 0, end: [...d.text(ref, 'final')].length });

test('엔진: 문단 태그 쪽 나눔 끄기·켜기·되돌리기 — 한/글 실측 쪽 수(10 → 8)', async () => {
  const bytes = fs.readFileSync(PRACTICE);
  assert.equal(pages(bytes), 10, '원본 쪽 수(한/글 2022 10쪽)');
  const d = await HwpxDoc.load(bytes);
  assert.deepEqual(CHAPTERS.map((r) => forcedPageBreak(d, r)), [true, true, true, true]);
  assert.equal(forcedPageBreak(d, 's1/p3'), false);
  const undos = [];
  for (const ref of CHAPTERS) {
    const r = d.formatRange(ref, { ...whole(d, ref), paragraph: { pageBreakBefore: false } });
    assert.equal(r.changed, true, ref);
    assert.equal(r.after.pageBreak, false, ref);
    assert.equal(r.after.paraPrId, r.before.paraPrId, `${ref} 문단 모양은 그대로(다음 문단과 함께 등)`);
    undos.push(r.undo);
  }
  // 이미 꺼진 문단에 다시 끄기 = 바뀜 없음
  assert.equal(d.formatRange('s1/p14', { ...whole(d, 's1/p14'), paragraph: { pageBreakBefore: false } }).changed, false);
  const off = await d.save();
  assert.equal(await tagBreaks(off), 0);
  assert.equal(pages(off), 8, '장 제목 쪽 나눔 넷을 끈 쪽 수(한/글 2022 8쪽)');
  // 되돌리기 → 원래 쪽 나눔
  for (const u of undos.reverse()) d.undoFormatting(u);
  const back = await d.save();
  assert.equal(await tagBreaks(back), 4);
  assert.equal(pages(back), 10);
  // 켜기: 쪽 나눔이 없던 절 제목에 → 문단 태그
  const on = d.formatRange('s1/p31', { ...whole(d, 's1/p31'), paragraph: { pageBreakBefore: true } });
  assert.equal(on.after.pageBreak, true); assert.equal(forcedPageBreak(d, 's1/p31'), true);
  assert.equal(await tagBreaks(await d.save()), 5);
});

test('엔진: 문단 모양 쪽 나눔(breakSetting pageBreakBefore)은 그 문단만 끄고, 켜져 있으면 문단 태그를 더 걸지 않는다', async () => {
  // 장 제목 문단 모양 28 에 '문단 앞에서 항상 쪽 나눔'을 켜고 문단 태그는 끈 변형(한/글 2022: 11쪽 — 1장 제목도 새 쪽)
  const z = await JSZip.loadAsync(fs.readFileSync(PRACTICE));
  z.file('Contents/header.xml', (await z.file('Contents/header.xml').async('string')).replace(/(<hh:paraPr id="28"[\s\S]*?<hh:breakSetting [^>]*?)pageBreakBefore="0"/, '$1pageBreakBefore="1"'));
  z.file('Contents/section1.xml', (await z.file('Contents/section1.xml').async('string')).replace(/(<hp:p [^>]*?)pageBreak="1"/g, '$1pageBreak="0"'));
  const bytes = await z.generateAsync({ type: 'nodebuffer' });
  assert.equal(pages(bytes), 11, '한/글 2022 11쪽');
  const d = await HwpxDoc.load(bytes);
  assert.equal(forcedPageBreak(d, 's1/p3'), true, '1장 제목 — 문단 모양으로');
  // 켜기: 이미 문단 모양이 켜 둔 문단은 바꿀 것이 없다
  assert.equal(d.formatRange('s1/p14', { ...whole(d, 's1/p14'), paragraph: { pageBreakBefore: true } }).changed, false);
  // 끄기: 1장 제목만 새 문단 모양(쪽 나눔 0) — 다른 속성(다음 문단과 함께)은 그대로, 다른 장 제목은 모양 28 그대로
  const r = d.formatRange('s1/p3', { ...whole(d, 's1/p3'), paragraph: { pageBreakBefore: false } });
  assert.equal(r.changed, true); assert.notEqual(r.after.paraPrId, '28');
  const pp = d.header.block('paraPr', r.after.paraPrId);
  assert.match(pp, /keepWithNext="1"/); assert.match(pp, /pageBreakBefore="0"/);
  assert.equal(forcedPageBreak(d, 's1/p3'), false); assert.equal(forcedPageBreak(d, 's1/p14'), true);
  assert.equal(pages(await d.save()), 10, '1장 제목만 앞 쪽에 붙는다(원본과 같은 10쪽)');
  // 되돌리기 → 모양 28
  d.undoFormatting(r.undo);
  assert.equal(d.inspectFormatting('s1/p3').paraPrId, '28');
});

test('엔진·꼴: 표 칸 문단은 거절, true/false 만, 예전 연결 꼴은 그대로, 이름표', async () => {
  const d = await HwpxDoc.load(fs.readFileSync(PRACTICE));
  const cell = d.paragraphs({ view: 'final', nested: true }).find((p) => /\/n\d+/.test(p.ref) && p.text);
  assert.ok(cell, '표 칸 문단');
  assert.throws(() => d.formatRange(cell.ref, { ...whole(d, cell.ref), paragraph: { pageBreakBefore: true } }), /본문 문단에만/);
  assert.equal(forcedPageBreak(d, cell.ref), false);
  assert.throws(() => validateFormatSpec({ paragraph: { pageBreakBefore: 1 } }), /true\/false/);
  // 예전 연결 도구(propose_format 등)·서버 AI 의 꼴은 그 키를 모른다 — 새 연결 op 와 서비스 정규화만 받는다
  assert.throws(() => FormatSchema.parse({ paragraph: { pageBreakBefore: true } }));
  assert.throws(() => ParagraphFormatSchema.parse({ pageBreakBefore: true }));
  assert.deepEqual(normalizeFormat({ paragraph: { pageBreakBefore: false } }), { paragraph: { pageBreakBefore: false } });
  const parsed = parseOps([{ op: 'format', at: ['s1/p14', 's1/p30'], paragraph: { pageBreakBefore: false } },
    { op: 'insert', after: 's1/p13', paragraphs: [{ text: '부록', style: '&본문 1.', format: { paragraph: { pageBreakBefore: true } } }] },
    { op: 'replace', at: 's1/p14', whole: true, with: '2. 분석 기준', format: { paragraph: { pageBreakBefore: true } } },
    { op: 'format', at: 's1/p14', paragraph: { keepWithNext: true } }]);
  assert.equal(parsed.ok.length, 3);
  assert.match(parsed.errors[0].error, /받는 키: .*pageBreakBefore/);
  assert.equal(formatSummary({ paragraph: { pageBreakBefore: false } }), '쪽 나눔 끔');
  assert.deepEqual(webFormatSummary({ paragraph: { pageBreakBefore: true } }), ['쪽 나눔 켬']);
  assert.deepEqual(webFormatSummary({ paragraph: { oneLine: true } }), ['한 줄로 입력 켬'], '그 키가 없는 응답은 예전과 같다');
});

test('새 연결: format 보기 → 쪽 나눔 끄기·새 장 제목 켜기 제안 → [모두 반영] → XML·쪽 수 → 되돌리기', { timeout: 240000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  try {
    for (const mode of ['final', 'review']) {
      const doc = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(PRACTICE), `쪽나눔-${mode}.hwpx`);
      const A = srv.api('a'); const M = srv.api('admin'); const D = `/api/docs/${doc.id}`;
      await A(`${D}/settings`, { method: 'PATCH', body: mode === 'final' ? { track: 'final' } : { editMode: 'review' } });
      const client = new Client({ name: 'page-break-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?v=2&tools=core`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
      await client.connect(transport); open.push(async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); });
      const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map((c) => c.text).join('\n'); assert.ok(!r.isError, t); return JSON.parse(t); };
      const req = (await A(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '장 제목의 쪽 나눔을 없애고 끝에 부록 장을 새 쪽에서', target: { scope: 'document', ref: 's1/p0' } } })).request;
      const brief = await call('task', { doc_id: doc.id, request_id: req.rid });
      // 읽기: 쪽 나눔이 걸린 문단만 pageBreakBefore:true
      const fmt = await call('read', { doc_id: doc.id, view: 'format', at: 's1/p3..p14' });
      assert.deepEqual(fmt.paragraphs.filter((p) => p.pageBreakBefore).map((p) => p.ref), ['s1/p14'], mode);
      const last = `s1/p${(await HwpxDoc.load(fs.readFileSync(PRACTICE))).sections[1].bodyParas.length - 1}`;
      const saved = await call('edit', { doc_id: doc.id, request_id: req.rid, expected_attempt: brief.attempt, done: '장 제목 쪽 나눔을 끄고 부록 장을 새 쪽에서 시작하게 했습니다',
        ops: [{ op: 'format', at: CHAPTERS, paragraph: { pageBreakBefore: false }, reason: '쪽 나눔 없이 이어 배치' },
          { op: 'insert', after: last, paragraphs: [{ text: '부록', style: '&본문 1.', format: { paragraph: { pageBreakBefore: true } } }], reason: '부록 장(새 쪽)' }] });
      assert.ok(!saved.failed, JSON.stringify(saved)); assert.equal(saved.completed, true, JSON.stringify(saved));
      const props = (await A(`${D}/proposals`)).filter((p) => p.rid === req.rid);
      assert.deepEqual(props.map((p) => p.type), ['format', 'format', 'format', 'format', 'insert'], mode);
      assert.deepEqual(props[0].format, { paragraph: { pageBreakBefore: false } });
      assert.equal(props[4].format.paragraph.pageBreakBefore, true); assert.ok(props[4].format.styleId != null);
      const res = await M(`${D}/requests/${req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
      assert.ok(res.results.length === 5 && res.results.every((r) => r.ok), `${mode} ${JSON.stringify(res.results)}`);
      const file = await A(`${D}/file?kind=working`);
      if (process.env.PAGE_BREAK_OUT) fs.writeFileSync(path.join(process.env.PAGE_BREAK_OUT, `result-${mode}.hwpx`), file);
      const f = await HwpxDoc.load(file);
      const appendix = `s1/p${f.sections[1].bodyParas.length - 1}`;
      assert.equal(f.text(appendix, 'final'), '부록', mode);
      assert.deepEqual([...CHAPTERS.map((r) => forcedPageBreak(f, r)), forcedPageBreak(f, appendix)], [false, false, false, false, true], mode);
      assert.equal(await tagBreaks(file), 1, `${mode} 본문 구역의 쪽 나눔 = 부록 하나`);
      // 장 제목 넷을 끈 8쪽 + 새 쪽의 부록 1쪽 = 9쪽 — 이 시험의 result-final 을 한/글 2022(12.0.0.3146)로 열어 9쪽, 다시 저장한 XML 의 본문 쪽 나눔은
      // 부록 제목 하나(artifacts/mcp-round3-20261117/P/hangul2022/result-final-pages.json)
      assert.equal(pages(file), 9, mode);
      const after = await call('read', { doc_id: doc.id, view: 'format', at: appendix });
      assert.equal(after.paragraphs[0].pageBreakBefore, true);
      // 되돌리기(서식 제안 하나) → 그 장 제목만 쪽 나눔이 돌아온다
      await M(`${D}/proposals/${props[0].pid}/undo`, { method: 'POST', body: {} });
      const u = await HwpxDoc.load(await A(`${D}/file?kind=working`));
      assert.deepEqual(CHAPTERS.map((r) => forcedPageBreak(u, r)), [true, false, false, false], mode);
    }
  } finally { for (const c of open) await c(); await srv.stop(); }
});
