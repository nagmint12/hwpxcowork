// 표 칸 안 문단(2026-11-19 — docs/MCP_REDESIGN_2026-11-16.md §17) 회귀 시험. 모델을 부르지 않는다.
// 실제 Codex 실행 3건(gpt-6.2-sol)이 회의록 서식의 내용 칸(문단 21개)을 다시 쓰지 못했다: 본문 보기가 칸 문단을 ⏎ 로 이은 한 줄로 보였고, read 는 칸 주소를 받지 않았고,
// 칸 주소의 whole:true 는 첫 문단만 바꿨고, 칸 문단 뒤 insert 는 표 밖으로 갔고, delete_paragraphs 는 칸 문단을 받지 않았다.
//  · 엔진: 칸 문단 다시 짜기(engine/table-edit.js cell_paragraphs) — 통째로 다시 쓰기·남기기·넣기·지우기, 새 문단의 모양 고르기, 기준 지문(STALE), 되돌리기
//  · op 풀기(server/mcp2/ops.js prepareOps): 칸 주소 = 칸의 문단 전체, whole 의 줄바꿈 = 문단 나눔, 칸 안 insert·delete_paragraphs, 한 호출의 같은 칸 op 는 제안 하나
//  · 임시 서버: 요청 내용·읽기에 칸 문단 주소, 제안 → 반영(어느 차례로든) → 되돌리기, 칸 뒤 문단 주소 옮기기
//   node --test tests/mcp_v2_cell_paragraphs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { startServer, uploadDoc } from './helpers/server.mjs';
import { formCellDoc, FORM_SHAPES, FORM_LINES, FORM_SIGN } from './helpers/form-cell-doc.mjs';
import { TABLE_OPS, CELL_OPS, paraMarker } from '../engine/table-edit.js';
import { TableOpSchema, normalizeTableOps } from '../server/table-schema.js';
import { parseOps, prepareOps, opGuide, OPS_BRIEF } from '../server/mcp2/ops.js';
import { tableLines, CELL_LIST_MIN } from '../server/mcp2/views.js';

const textOf = (result) => (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (result) => { assert.ok(!result.isError, textOf(result)); return JSON.parse(textOf(result)); };
const errorOf = (result) => { assert.equal(result.isError, true, textOf(result).slice(0, 200)); return textOf(result); };
const TEXTS = FORM_LINES.map(([, text]) => text);

async function connect(srv, who, { query = '' } = {}) {
  const client = new Client({ name: 'v2-cell-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens[who]}` } } });
  await client.connect(transport);
  return { client, call: (name, args = {}) => client.callTool({ name, arguments: args }), close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); } };
}

/** 문서의 그 칸(줄, 칸) */
const cellOf = (doc, key, row = 2, col = 1) => doc.tables().find((t) => t.key === key).cells.find((c) => c.row === row && c.col === col);
const cellTexts = (doc, key, row = 2, col = 1) => cellOf(doc, key, row, col).refs.map((r) => doc.text(r, 'final'));
/** 칸 문단들의 [문단 모양, 글자 모양(글이 든 run — 빈 문단은 빈 run)] */
const cellShapes = (doc, key, row = 2, col = 1) => cellOf(doc, key, row, col).refs.map((r) => {
  const { sec, p } = doc.resolve(r); const xml = sec.xml.slice(p.start, p.end);
  return [(/paraPrIDRef="(\d+)"/.exec(xml) || [])[1], (/<hp:run charPrIDRef="(\d+)"(?:><hp:t>|\/>)/.exec(xml) || [])[1]];
});
const cellXml = (doc, key, row = 2, col = 1) => { const c = cellOf(doc, key, row, col); const a = doc.resolve(c.refs[0]); const b = doc.resolve(c.refs[c.refs.length - 1]); return a.sec.xml.slice(a.p.start, b.p.end); };
const paragraphXml = (doc, ref) => { const { sec, p } = doc.resolve(ref); return sec.xml.slice(p.start, p.end); };
const columnDefs = (xml) => xml.match(/<hp:colPr\b[^>]*\/>/g) || [];
const H = [FORM_SHAPES.H.para, FORM_SHAPES.H.char]; const I = [FORM_SHAPES.I.para, FORM_SHAPES.I.char];
const cellOp = (paragraphs, more = {}) => ({ op: 'cell_paragraphs', row: 2, col: 1, count: 9, paragraphs, ...more });

test('시험 받침: 서식 문서의 내용 칸은 문단 9개, 서명 칸은 2개, 문단 안 줄바꿈이 든 칸 하나', async () => {
  const { doc, key } = await formCellDoc();
  assert.equal(key, 's0/p2#t0');
  assert.deepEqual(cellTexts(doc, key), TEXTS);
  assert.deepEqual(cellShapes(doc, key), FORM_LINES.map(([kind]) => (kind === 'H' ? H : I)));
  assert.deepEqual(cellTexts(doc, key, 3, 0), FORM_SIGN);
  assert.deepEqual(cellTexts(doc, key, 2, 0), ['안건 및\n회의내용']);
  assert.ok(/<hp:colPr\b/.test(cellXml(doc, key)), '내용 칸 첫 문단에 단 정의');
  // 저장하고 다시 읽어도 같다(시험 문서가 온전한 HWPX 인가)
  const again = await HwpxDoc.load(Buffer.from(await doc.save()));
  assert.deepEqual(cellTexts(again, key), TEXTS);
});

test('엔진: 칸 문단 다시 짜기 — 통째로 다시 쓰기(모양은 같은 글머리의 가까운 문단), 기준 지문, 되돌리기', async () => {
  const { doc, key } = await formCellDoc();
  // 도구가 받는 표 고치기 목록은 그대로다(숨긴 op — 예전 연결·새 연결의 도구 꼴에 싣지 않는다)
  assert.equal(TABLE_OPS.length, 12); assert.ok(!TABLE_OPS.includes('cell_paragraphs')); assert.deepEqual(CELL_OPS, ['cell_paragraphs']);
  assert.equal(TableOpSchema.safeParse({ op: 'cell_paragraphs', row: 0, col: 0 }).success, false);
  const others = () => doc.tables().find((t) => t.key === key).cells.filter((c) => !(c.row === 2 && c.col === 1)).map((c) => c.text);
  const before = others();
  const first = doc.resolve(cellOf(doc, key).refs[0]).p.nested;
  const lines = ['□ 새 목적', 'ㅇ 새 항목 하나', '', '□ 새 안건', 'ㅇ 새 항목 둘', '- 붙임 자료'];
  const op = cellOp(lines.map((text) => ({ text })));

  // 미리 해 보기: 문서는 그대로, 카드에 보일 글·기준 지문·주소 옮김표
  const dry = doc.editTable(key, [op], { dryRun: true });
  assert.deepEqual(cellTexts(doc, key), TEXTS);
  assert.match(dry.labels[0], /^셀\(3번째 줄 2번째 칸\) 글 다시 쓰기 — 문단 9 → 6개: □ 새 목적 ⏎ ㅇ 새 항목 하나 ⏎ {2}⏎ □ 새 안건 ⏎ ㅇ 새 항목 둘 ⏎ - 붙임 자료$/);
  assert.equal(dry.stamps[0].length, 9, '사라질 문단 9개의 글 지문');
  assert.deepEqual(dry.cellMoves, [{ parent: 's0/p2', first, map: new Array(9).fill(null), count: 6 }]);

  // 반영(제안 때 적어 둔 지문과 함께)
  const res = doc.editTable(key, [{ ...op, expect: dry.stamps[0] }]);
  assert.deepEqual(cellTexts(doc, key), lines);
  // □ 줄은 제목 문단의 모양, ㅇ 줄·빈 줄은 항목 문단의 모양, 처음 보는 글머리('-')는 그 자리 문단의 모양
  assert.deepEqual(cellShapes(doc, key), [H, I, I, H, I, I]);
  assert.ok(/<hp:colPr\b/.test(doc.resolve(cellOf(doc, key).refs[0]).sec.xml.slice(doc.resolve(cellOf(doc, key).refs[0]).p.start, doc.resolve(cellOf(doc, key).refs[0]).p.end)), '첫 문단의 단 정의는 새 첫 문단으로');
  assert.ok(!/<hp:linesegarray/.test(cellXml(doc, key)), '다시 짠 칸의 줄 정보는 지운다');
  assert.deepEqual(others(), before, '다른 칸은 그대로');
  assert.deepEqual(doc.tables().find((t) => t.key === key).cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan]).slice(0, 4), [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1], [0, 3, 1, 1]]);
  // 저장·다시 읽기
  const again = await HwpxDoc.load(Buffer.from(await doc.save()));
  assert.deepEqual(cellTexts(again, key), lines);

  // 되돌리기: 그 칸은 고치기 전 문단으로
  doc.restoreTable(key, res.before, res.undo);
  assert.deepEqual(cellTexts(doc, key), TEXTS);
  assert.deepEqual(cellShapes(doc, key), FORM_LINES.map(([kind]) => (kind === 'H' ? H : I)));

  // 다시 반영한 뒤 그 칸의 글이 바뀌면 되돌리지 않는다(뒤에 고친 글을 버리지 않는다)
  const res2 = doc.editTable(key, [{ ...op, expect: dry.stamps[0] }]);
  const ref1 = cellOf(doc, key).refs[1]; const s = doc.resolve(ref1);
  s.sec.load(s.sec.xml.replace('ㅇ 새 항목 하나', 'ㅇ 사람이 고친 항목'));
  assert.throws(() => doc.restoreTable(key, res2.before, res2.undo), (e) => e.code === 'STALE');
  // 글이 처음대로 돌아오면 되돌릴 수 있다
  const s2 = doc.resolve(ref1); s2.sec.load(s2.sec.xml.replace('ㅇ 사람이 고친 항목', 'ㅇ 새 항목 하나'));
  doc.restoreTable(key, res2.before, res2.undo);
  assert.deepEqual(cellTexts(doc, key), TEXTS);
});

test('엔진: 칸 문단 남기기·넣기·지우기와 거절하는 것(문단 수·지울 문단의 글이 바뀜, 조판 부호가 든 문단, 꼴)', async () => {
  const { doc, key } = await formCellDoc();
  const keep = (k) => ({ keep: k });
  // 남기기 + 넣기 + 지우기: 2·5·6 번째를 지우고 1 번째 뒤에 하나 넣는다
  const mixed = cellOp([keep(0), keep(1), { text: 'ㅇ 넣은 항목', near: 1 }, keep(3), keep(4), keep(7), keep(8)]);
  const dry = doc.editTable(key, [mixed], { dryRun: true });
  assert.deepEqual(dry.cellMoves[0].map, [0, 1, null, 3, 4, null, null, 5, 6]); assert.equal(dry.cellMoves[0].count, 7);
  assert.match(dry.labels[0], /^셀\(3번째 줄 2번째 칸\)의 문단 3개를 1개로 바꾸기: ㅇ 넣은 항목$/);
  const keptXml = (() => { const c = cellOf(doc, key); const { sec, p } = doc.resolve(c.refs[3]); return sec.xml.slice(p.start, p.end); })();
  doc.editTable(key, [{ ...mixed, expect: dry.stamps[0] }]);
  assert.deepEqual(cellTexts(doc, key), [TEXTS[0], TEXTS[1], 'ㅇ 넣은 항목', TEXTS[3], TEXTS[4], TEXTS[7], TEXTS[8]]);
  assert.deepEqual(cellShapes(doc, key), [H, I, I, H, I, H, I]);
  // 남긴 문단은 원문 그대로(줄 정보만 지운다)
  const nowXml = (() => { const c = cellOf(doc, key); const { sec, p } = doc.resolve(c.refs[3]); return sec.xml.slice(p.start, p.end); })();
  assert.equal(nowXml, keptXml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/, ''));

  // 지우기만·넣기만의 카드 글
  const b = await formCellDoc();
  assert.match(b.doc.editTable(b.key, [cellOp([0, 1, 3, 4, 5, 7, 8].map(keep))], { dryRun: true }).labels[0], /^셀\(3번째 줄 2번째 칸\)의 문단 2개 지우기$/);
  assert.match(b.doc.editTable(b.key, [cellOp([0, 1, 3, 4, 5, 6, 8].map(keep))], { dryRun: true }).labels[0], /^셀\(3번째 줄 2번째 칸\)의 문단 2개 지우기: □ 결정사항$/);
  assert.match(b.doc.editTable(b.key, [cellOp([...[0, 1, 2, 3, 4, 5].map(keep), { text: 'ㅇ (비고) 새 줄' }, ...[6, 7, 8].map(keep)])], { dryRun: true }).labels[0], /^셀\(3번째 줄 2번째 칸\)에 문단 1개 넣기: ㅇ \(비고\) 새 줄$/);
  // 합친 칸은 덮는 자리 어디로 가리켜도 같은 칸
  assert.match(b.doc.editTable(b.key, [{ ...cellOp([{ text: '한 줄' }]), col: 3 }], { dryRun: true }).labels[0], /^셀\(3번째 줄 2번째 칸\) 글 다시 쓰기 — 문단 9 → 1개: 한 줄$/);

  // 문단 수가 읽은 주소의 수와 다르다(제안 전) / 제안 뒤 문단 수가 바뀌었다
  const whole = cellOp([{ text: '새 글' }]);
  assert.throws(() => b.doc.editTable(b.key, [{ ...whole, count: 8 }], { dryRun: true }), (e) => e.code === 'TABLE_CELL_SHAPE');
  const stamp = b.doc.editTable(b.key, [whole], { dryRun: true }).stamps[0];
  assert.throws(() => b.doc.editTable(b.key, [{ ...whole, count: 8, expect: stamp }], { dryRun: true }), (e) => e.code === 'STALE');
  // 제안 뒤 지울 문단의 글이 바뀌었다 → STALE. 그새 비워진 문단은 괜찮다
  const del5 = cellOp([0, 1, 2, 3, 4, 6, 7, 8].map(keep)); const stamp5 = b.doc.editTable(b.key, [del5], { dryRun: true }).stamps[0];
  const r5 = cellOf(b.doc, b.key).refs[5]; let s = b.doc.resolve(r5);
  s.sec.load(s.sec.xml.replace('응답 96명', '응답 97명'));
  assert.throws(() => b.doc.editTable(b.key, [{ ...del5, expect: stamp5 }], { dryRun: true }), (e) => e.code === 'STALE' && /지울 문단의 글이 바뀌었습니다/.test(e.message));
  s = b.doc.resolve(r5); s.sec.load(s.sec.xml.replace(`<hp:t>${'ㅇ (결과) 응답 97명 — 응답률 80%'}</hp:t>`, '<hp:t></hp:t>'));
  assert.equal(b.doc.text(r5, 'final'), '');
  assert.equal(b.doc.editTable(b.key, [{ ...del5, expect: stamp5 }], { dryRun: true }).cellMoves[0].count, 8);

  // 조판 부호(책갈피)가 든 문단은 지우거나 통째로 바꾸지 못한다 — 남기면 된다
  const c = await formCellDoc({ bookmarkAt: 4 });
  assert.throws(() => c.doc.editTable(c.key, [cellOp([{ text: '새 글' }])], { dryRun: true }), (e) => e.code === 'TABLE_CELL_OBJECT' && /5번째 문단/.test(e.message));
  assert.equal(c.doc.editTable(c.key, [cellOp([{ text: '□ 새 제목' }, keep(4), { text: 'ㅇ 새 항목' }])], { dryRun: true }).cellMoves[0].count, 3);
  // 꼴: keep 은 차례대로 한 번씩, 같은 칸은 한 번만, 칸은 표 안
  assert.throws(() => c.doc.editTable(c.key, [cellOp([keep(3), keep(1)])], { dryRun: true }), (e) => e.code === 'TABLE_SPEC');
  assert.throws(() => c.doc.editTable(c.key, [cellOp([keep(9)])], { dryRun: true }), (e) => e.code === 'TABLE_RANGE');
  assert.throws(() => b.doc.editTable(b.key, [cellOp([keep(0)]), cellOp([keep(1)])], { dryRun: true }), (e) => e.code === 'TABLE_SPEC' && /두 번 다시 짤 수 없습니다/.test(e.message));
  assert.throws(() => c.doc.editTable(c.key, [{ ...cellOp([keep(0)]), row: 9 }], { dryRun: true }), (e) => e.code === 'TABLE_RANGE');

  // 서비스 입력 검사: 칸 문단 다시 짜기가 든 목록만 그 꼴을 받는다(모르는 키는 거절), 그 밖의 목록은 예전 그대로
  assert.deepEqual(normalizeTableOps([cellOp([keep(0), { text: '글', near: 0 }])]), [cellOp([keep(0), { text: '글', near: 0 }])]);
  assert.throws(() => normalizeTableOps([cellOp([{ keep: 0, text: '둘 다' }])]));
  assert.throws(() => normalizeTableOps([{ ...cellOp([keep(0)]), extra: 1 }]));
  assert.deepEqual(normalizeTableOps([{ op: 'delete_rows', rows: [1], cols: null }]), [{ op: 'delete_rows', rows: [1] }]);

  // 글머리 갈래
  assert.deepEqual(['', ' ', '□ 가', '  ㅇ 나', '- 다', '1. 라', '(2) 마', '가. 바', '(나) 사', '① 아', '그냥 글', 'Abc'].map(paraMarker), ['blank', 'blank', '□', 'ㅇ', '-', '1.', '(1)', '가.', '(가)', '①', 'text', 'text']);
});

test('엔진: 칸의 첫 문단을 지울 때 다음 문단의 단 정의를 유지하고 없으면 첫 문단의 단 정의를 넘긴다', async () => {
  for (const hasOwn of [false, true]) {
    const { doc, key } = await formCellDoc();
    const [first, second] = cellOf(doc, key).refs;
    const [original] = columnDefs(paragraphXml(doc, first));
    assert.ok(original);
    const own = original.replace('sameGap="0"', 'sameGap="345"');
    assert.notEqual(own, original);
    if (hasOwn) {
      const { sec, p } = doc.resolve(second);
      const xml = paragraphXml(doc, second).replace(/<hp:run\b[^>]*>/, (run) => `${run}<hp:ctrl>${own}</hp:ctrl></hp:run>${run}`);
      sec.load(sec.xml.slice(0, p.start) + xml + sec.xml.slice(p.end));
    }
    const before = cellXml(doc, key);
    const op = cellOp(TEXTS.slice(1).map((_, i) => ({ keep: i + 1 })));
    const { stamps } = doc.editTable(key, [op], { dryRun: true });
    const res = doc.editTable(key, [{ ...op, expect: stamps[0] }]);
    const saved = await HwpxDoc.load(Buffer.from(await doc.save()));
    assert.deepEqual(cellTexts(saved, key), TEXTS.slice(1));
    assert.deepEqual(cellShapes(saved, key), FORM_LINES.slice(1).map(([kind]) => (kind === 'H' ? H : I)));
    assert.deepEqual(columnDefs(paragraphXml(saved, cellOf(saved, key).refs[0])), [hasOwn ? own : original]);
    assert.deepEqual(columnDefs(cellXml(saved, key)), [hasOwn ? own : original]);

    doc.restoreTable(key, res.before, res.undo);
    assert.equal(cellXml(doc, key), before);
  }
});

test('op 풀기: 칸 주소 = 칸의 문단 전체, whole 의 줄바꿈 = 문단 나눔, 칸 안 넣기·지우기 — 한 호출의 같은 칸 op 는 표 고치기 제안 하나', async () => {
  const { doc, key } = await formCellDoc();
  const refs = cellOf(doc, key).refs; const cell = { table: key, row: 2, col: 1 };
  const prep = (ops) => { const parsed = parseOps(ops); assert.deepEqual(parsed.errors, []); return prepareOps(doc, parsed.ok); };
  const inputs = (out) => out.steps.flatMap((s) => (s.kind === 'proposals' ? s.items : [])).map((x) => ({ op: x.index, ...x.input }));
  const paras = (out) => inputs(out).filter((x) => x.type === 'table_edit').map((x) => x.tableEdit.ops);
  const keep = (k) => ({ keep: k });

  // 칸 통째로 다시 쓰기(실제 Codex 실행의 첫 호출 꼴): 줄마다 한 문단, 끝의 빈 줄은 뺀다. 합친 칸은 덮는 자리 어디로 가리켜도 같다
  for (const at of [cell, { ...cell, col: 3 }]) {
    const out = prep([{ op: 'replace', at, whole: true, with: '□ 가\nㅇ 나\n\nㅇ 다\n', reason: '다시 씀' }]);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(inputs(out), [{ op: 0, type: 'table_edit', tableEdit: { table: key, ops: [cellOp([{ text: '□ 가' }, { text: 'ㅇ 나' }, { text: '' }, { text: 'ㅇ 다' }])] }, reason: '다시 씀' }]);
    assert.ok(out.notes.some((n) => n.op === 0 && /표 고치기 제안 하나로 냈습니다.*변경 추적 없이/.test(n.note)), JSON.stringify(out.notes));
  }
  // find 가 칸 글 전체(문단마다 줄바꿈)여도 통째로 다시 쓰기
  assert.deepEqual(paras(prep([{ op: 'replace', at: cell, find: TEXTS.join('\n'), with: '한 줄' }])), [[cellOp([{ text: '한 줄' }])]]);
  // 서식을 함께 주면 조용히 첫 문단만 바꾸지 않고 알린다
  assert.match(prep([{ op: 'replace', at: cell, whole: true, with: '가', style: '바탕글' }]).errors[0].error, /문단이 9개 있습니다 — 서식\(style·format·runs\)을 함께 주는 바꿈은 문단 하나에만/);

  // 칸 주소 + find: 칸의 문단을 차례로 찾는다(occurrence 는 칸 전체에서 센다) → 그 문단의 바꿈 제안
  assert.deepEqual(inputs(prep([{ op: 'replace', at: cell, find: '96명', with: '97명' }])).map((x) => [x.type, x.ref, x.find, x.replace, x.occurrence]), [['replace', refs[5], '96명', '97명', 1]]);
  assert.deepEqual(inputs(prep([{ op: 'replace', at: cell, find: 'ㅇ', with: '○', occurrence: 3 }])).map((x) => [x.ref, x.occurrence]), [[refs[5], 1]]);
  assert.match(prep([{ op: 'replace', at: cell, find: '없는 글', with: '가' }]).errors[0].error, /칸\(2, 1\)의 문단 9개 어디에도 「없는 글」 이 없습니다/);
  assert.match(prep([{ op: 'replace', at: cell, find: `${TEXTS[4]}\n${TEXTS[5]}`, with: '' }]).errors[0].error, /find 가 칸\(2, 1\)의 여러 문단에 걸칩니다.*delete_paragraphs/);

  // 칸 문단 하나의 글 전체를 여러 줄로(실제 Codex 실행의 셋째 요청 꼴) = 그 문단을 줄마다 한 문단으로
  assert.deepEqual(paras(prep([{ op: 'replace', at: refs[1], whole: true, with: 'ㅇ 하나\nㅇ 둘' }])), [[cellOp([keep(0), { text: 'ㅇ 하나', near: 1 }, { text: 'ㅇ 둘', near: 1 }, ...[2, 3, 4, 5, 6, 7, 8].map(keep)])]]);
  assert.deepEqual(paras(prep([{ op: 'replace', at: { ...cell, para: 8 }, find: TEXTS[8], with: 'ㅇ 가\nㅇ 나' }])), [[cellOp([...[0, 1, 2, 3, 4, 5, 6, 7].map(keep), { text: 'ㅇ 가', near: 8 }, { text: 'ㅇ 나', near: 8 }])]]);
  // 글 일부만 바꾸는 줄바꿈은 예전처럼 같은 문단 안 줄 나눔 — 영수증 notes 로 알린다
  const part = prep([{ op: 'replace', at: refs[5], find: ' — ', with: '\n' }]);
  assert.deepEqual(inputs(part).map((x) => [x.type, x.ref, x.replace]), [['replace', refs[5], '\n']]);
  assert.ok(part.notes.some((n) => /줄 나눔\(같은 문단\)/.test(n.note)));
  // 줄바꿈 없는 문단 바꿈은 예전 그대로(문단마다의 바꿈 제안 — 변경 추적)
  assert.deepEqual(inputs(prep([{ op: 'replace', at: refs[8], whole: true, with: 'ㅇ 고친 줄' }])).map((x) => [x.type, x.ref, x.find, x.replace]), [['replace', refs[8], TEXTS[8], 'ㅇ 고친 줄']]);

  // 한 호출의 같은 칸 op 는 모두 읽은 주소 그대로 받아 제안 하나로: 넣기(같은 자리는 낸 차례대로) + 지우기 + 문단 바꿈
  const many = prep([
    { op: 'insert', after: refs[4], paragraphs: [{ text: 'ㅇ 넣음 1' }, { text: 'ㅇ 넣음 2', style: '없는 스타일이어도 쓰지 않는다' }] },
    { op: 'delete_paragraphs', at: [refs[6], refs[2]] },
    { op: 'replace', at: refs[8], whole: true, with: 'ㅇ 고친 줄' },
    { op: 'insert', after: refs[4], text: 'ㅇ 넣음 3' },
    { op: 'delete_paragraphs', at: `${refs[7]}` },
  ]);
  assert.deepEqual(many.errors, []);
  assert.deepEqual(inputs(many).map((x) => [x.op, x.type]), [[2, 'replace'], [0, 'table_edit']], '글 제안이 먼저, 칸의 문단 구조 바꾸기는 맨 뒤');
  assert.deepEqual(paras(many), [[cellOp([keep(0), keep(1), keep(3), keep(4), { text: 'ㅇ 넣음 1', near: 4 }, { text: 'ㅇ 넣음 2', near: 4 }, { text: 'ㅇ 넣음 3', near: 4 }, keep(5), keep(8)])]]);
  assert.ok(many.notes.some((n) => /ops\[0, 1, 3, 4\]: 표 s0\/p2#t0 의 칸 문단 수를 바꾸는 것\(칸\(2, 1\) 문단 9 → 9개\)/.test(n.note)), JSON.stringify(many.notes));
  assert.ok(many.notes.some((n) => n.op === 0 && /글만 받습니다/.test(n.note)));
  // 범위 꼴
  assert.deepEqual(paras(prep([{ op: 'delete_paragraphs', at: `${refs[4]}..n${Number(/n(\d+)$/.exec(refs[6])[1])}` }])), [[cellOp([0, 1, 2, 3, 7, 8].map(keep))]]);
  assert.deepEqual(paras(prep([{ op: 'delete_paragraphs', at: `${refs[0]}..${refs[8]}` }])), [[cellOp([{ text: '', near: 0 }])]], '칸의 문단을 모두 지우면 빈 문단 하나가 남는다');

  // 섞어 쓸 수 없는 것
  assert.match(prep([{ op: 'replace', at: cell, whole: true, with: '가\n나' }, { op: 'insert', after: refs[0], text: '다' }]).errors[0].error, /통째로 다시 쓰는 op 와 그 칸의 문단을 넣거나 지우는 op 를 한 호출에 함께 낼 수 없습니다/);
  assert.match(prep([{ op: 'delete_paragraphs', at: refs[3] }, { op: 'insert', after: refs[3], text: '다' }]).errors[0].error, /넣을 자리\(after .*\)의 문단을 같은 호출의 다른 op 가 지우거나/);
  assert.match(prep([{ op: 'delete_paragraphs', at: [refs[3], 's0/p1'] }]).errors[0].error, /본문 문단과 표 칸 안 문단을 한 op 에 섞을 수 없습니다/);
  assert.match(prep([{ op: 'delete_paragraphs', at: [refs[3], cellOf(doc, key, 3, 0).refs[0]] }]).errors[0].error, /여러 칸의 문단이 섞였습니다/);
  assert.match(prep([{ op: 'delete_paragraphs', at: 's0/p2/n999' }]).errors[0].error, /표 칸 문단이 아닙니다/);

  // 문단이 하나뿐인 칸: 줄바꿈이 없으면 예전 그대로(그 문단의 바꿈 제안), 줄바꿈이 있으면 문단 여럿으로
  const date = { table: key, row: 0, col: 1 }; const dateRef = cellOf(doc, key, 0, 1).refs[0];
  assert.deepEqual(inputs(prep([{ op: 'replace', at: date, whole: true, with: '2031. 6. 3.' }])).map((x) => [x.type, x.ref, x.replace]), [['replace', dateRef, '2031. 6. 3.']]);
  assert.deepEqual(paras(prep([{ op: 'replace', at: date, whole: true, with: '2031. 6. 3.\n(화)' }])), [[{ op: 'cell_paragraphs', row: 0, col: 1, count: 1, paragraphs: [{ text: '2031. 6. 3.' }, { text: '(화)' }] }]]);
  // 여러 칸을 한 호출에: 표마다 제안 하나
  const two = prep([{ op: 'replace', at: date, whole: true, with: '가\n나' }, { op: 'replace', at: cell, whole: true, with: '다\n라' }]);
  assert.equal(inputs(two).length, 1); assert.deepEqual(paras(two)[0].map((x) => [x.row, x.col, x.count, x.paragraphs.length]), [[0, 1, 1, 2], [2, 1, 9, 2]]);

  // 서식: 칸 주소는 그 칸의 문단 전체(예전에는 첫 문단만), find 를 주면 그 글이 든 칸 문단
  assert.deepEqual(inputs(prep([{ op: 'format', at: cell, char: { bold: true } }])).map((x) => [x.type, x.ref]), refs.map((r) => ['format', r]));
  assert.deepEqual(inputs(prep([{ op: 'format', at: cell, find: '96명', char: { bold: true } }])).map((x) => [x.type, x.ref, x.find]), [['format', refs[5], '96명']]);
  // 메모도 칸 주소 + find 면 그 글이 든 칸 문단
  assert.deepEqual(prep([{ op: 'memo', at: cell, find: '최종안', text: '의견' }]).steps.map((s) => [s.kind, s.input.ref]), [['memo', refs[8]]]);

  // op 이름으로 묻는 안내, 도구 설명
  assert.match(opGuide('replace'), /^· \{op:'replace'.*at 이 표 칸 \{table,row,col\} 이면 그 칸의 문단 전체가 대상이다/s);
  assert.match(opGuide('delete_paragraphs'), /표 칸 안 문단도 통째로 지운다/); assert.match(opGuide('paper'), /op:'paper'/);
  assert.equal(opGuide('chart'), null); assert.equal(opGuide('restyle'), null); assert.equal(opGuide('paragraphs'), null);
  assert.match(OPS_BRIEF, /whole:true 의 with 줄바꿈은 문단 나눔\. at 이 칸\(\{table,row,col\}\)이면 find 는 칸 전체에서 찾고 whole:true 는 칸의 문단 전체를 with 의 줄들로 다시 쓴다/);
  assert.match(OPS_BRIEF, /after 가 표 칸 문단이면 그 칸 안에 — 글만/); assert.match(OPS_BRIEF, /표 칸 안 문단 's0\/p3\/n9'·'s0\/p3\/n9\.\.n12'·목록\(한 칸\)/);
});

test('읽기 보기: 칸 안 문단 나눔은 ¶, 문단이 많은 칸은 줄 아래에 문단마다 주소', async () => {
  const { doc, key } = await formCellDoc();
  const t = doc.tables().find((x) => x.key === key); const refs = cellOf(doc, key).refs;
  const textOf2 = (ref) => doc.text(ref, 'final');
  assert.equal(CELL_LIST_MIN, 3);
  const lines = tableLines(t, { textOf: textOf2 });
  assert.equal(lines[0], ' r0 | 회의일시 | 2031. 3. 4.(화) 10:00 ~ 11:00 | 회의장소 | 소회의실 |');
  assert.equal(lines[2], ' r2 | 안건 및 ⏎ 회의내용 | (문단 9개 ↓) | ← | ← |', '문단 안 줄바꿈은 ⏎ 그대로, 문단이 많은 칸은 아래에 펼친다');
  assert.equal(lines[3], '   ↳ r2·c1 칸의 문단 9개');
  assert.deepEqual(lines.slice(4, 13), refs.map((r, i) => `   [${r}] ${TEXTS[i]}`.trimEnd()));
  assert.equal(lines[13], ` r3 | ${FORM_SIGN.join(' ¶ ')} | ← | ← | ← |`, '문단 둘인 칸은 줄 안에서 ¶');
  assert.equal(lines.length, 14);
  // 문단 글을 주지 않으면(좌표로 읽은 배치 보기의 표 등) 예전처럼 칸 글 그대로 한 줄
  const plain = tableLines(t);
  assert.equal(plain.length, 4);
  assert.ok(plain[2].includes('□ 회의 목적 ⏎ ㅇ 지난 분기 설문 결과를 공유하고 다음 일정 확정 ⏎ □ 안건 1. 설문 결과') && !plain[2].includes('문단 9개'), plain[2]);
  // 문단 줄에는 주소가 달린다
  assert.deepEqual(tableLines(t, { textOf: textOf2, rich: true }).filter((x) => x.kind === 'para').map((x) => x.ref), refs);
});

test('임시 서버: 칸 주소로 문단 안 줄바꿈이 든 글을 바꾸고 실제 문단 경계는 건너뛰지 않는다', async (t) => {
  const srv = await startServer({ ai: 'off', config: { mcp: {}, documents: { defaultAiMemo: 'none' } } });
  let v2;
  t.after(async () => { try { await v2?.close(); } finally { await srv.stop(); } });
  v2 = await connect(srv, 'a', { query: '?tools=core' });
  const api = srv.api('a');
  const { doc, key } = await formCellDoc();
  const cell = { table: key, row: 2, col: 1 };
  const signature = { table: key, row: 3, col: 0 };
  const refs = cellOf(doc, key).refs;
  const signRefs = cellOf(doc, key, 3, 0).refs;
  for (const [ref, newText] of [
    [refs[1], '앞글 항목A<hp:lineBreak/>항목B 뒷글'], [refs[5], '둘째 앞글 항목A<hp:lineBreak/>항목B 뒷글'],
    [signRefs[0], '서명 왼쪽 항목A'], [signRefs[1], '항목B 서명 오른쪽'],
  ]) {
    const { sec, p } = doc.resolve(ref);
    const xml = paragraphXml(doc, ref).replace(/<hp:t>.*?<\/hp:t>/s, `<hp:t>${newText}</hp:t>`);
    sec.load(sec.xml.slice(0, p.start) + xml + sec.xml.slice(p.end));
  }
  const { id: doc_id } = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await doc.save()), '줄바꿈서식.hwpx');
  const D = `/api/docs/${doc_id}`;
  const { request } = await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '두 번째 항목의 줄바꿈을 없앱니다.', target: { scope: 'document', ref: 's0/p0' } } });
  const ids = { doc_id, request_id: request.rid, expected_attempt: 1 };
  assert.equal(json(await v2.call('task', ids)).request_id, request.rid);
  assert.match(textOf(await v2.call('read', { doc_id, at: cell })), /항목A ⏎ 항목B/);

  const find = '항목A\n항목B';
  const replace = (at, query, occurrence) => ({ op: 'replace', at, find: query, occurrence, with: '이음' });
  const tryEdit = async (op) => json(await v2.call('edit', { ...ids, dry_run: true, ops: [op] }));
  const cross = await tryEdit(replace(signature, find));
  assert.match(cross.failed[0].error, /여러 문단에 걸칩니다/);
  const absent = await tryEdit(replace(cell, '없는왼쪽\n없는오른쪽'));
  assert.match(absent.failed[0].error, /어디에도/);
  assert.deepEqual(await api(`${D}/proposals`), []);
  const edit = json(await v2.call('edit', { ...ids, ops: [replace(cell, find, 2)] }));
  assert.ok(!edit.failed?.length, JSON.stringify(edit.failed));
  assert.deepEqual(edit.saved.map((item) => item.ref), [refs[5]]);
  assert.equal(json(await v2.call('finish', { ...ids, summary: '두 번째 항목의 줄바꿈을 없앴습니다.' })).status, 'done');
  await api(`${D}/proposals/${edit.saved[0].pid}/apply`, { method: 'POST', body: {} });

  const exported = await HwpxDoc.load(await api(`${D}/file?kind=export`));
  const expected = [...TEXTS];
  expected[1] = '앞글 항목A\n항목B 뒷글';
  expected[5] = '둘째 앞글 이음 뒷글';
  assert.deepEqual(cellTexts(exported, key), expected);
  assert.match(paragraphXml(exported, refs[1]), /<hp:lineBreak\s*\/>/);
  assert.doesNotMatch(paragraphXml(exported, refs[5]), /<hp:lineBreak\b/);
  assert.equal(cellXml(exported, key, 3, 0), cellXml(doc, key, 3, 0));
});

test('임시 서버: 서식 문서의 내용 칸 — 요청 내용·읽기에 칸 문단 주소가 오고, 칸 통째로 다시 쓰기·칸 안 넣기·지우기가 제안 → 반영 → 되돌리기까지 된다', async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const api = srv.api('a');
  const { doc: source, key } = await formCellDoc();
  const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await source.save()), '회의록서식.hwpx');
  const D = `/api/docs/${doc.id}`;
  const make = async (body) => (await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', ...body } })).request;
  const cellParas = async (row = 2, col = 1) => (await api(`${D}/paragraphs`)).filter((p) => p.cell && p.cell.table === key && p.cell.row === row && p.cell.col === col);
  const refs = (await cellParas()).map((p) => p.ref);
  const signRefs = (await cellParas(3, 0)).map((p) => p.ref);
  assert.equal(refs.length, 9); assert.equal(signRefs.length, 2);
  const cell = { table: key, row: 2, col: 1 };
  const v2 = await connect(srv, 'a', { query: '?v=2&tools=core' }); open.push(v2);

  // ── 요청 내용(문서 전체 대상 — 실제 Codex 실행의 첫 요청 꼴): 내용 칸의 문단이 주소와 함께 온다 ──
  const r1 = await make({ kind: 'instruct', instruction: '회의록을 새 안건으로 다시 써 줘', target: { scope: 'document', ref: 's0/p0' } });
  const brief = json(await v2.call('task'));
  assert.equal(brief.request_id, r1.rid);
  assert.ok(brief.context.includes(`▦ ${key} 표 4×4`), brief.context);
  assert.ok(brief.context.includes('| 안건 및 ⏎ 회의내용 | (문단 9개 ↓) | ← | ← |'), brief.context);
  assert.ok(brief.context.includes('↳ r2·c1 칸의 문단 9개'));
  for (let i = 0; i < 9; i++) assert.ok(brief.context.includes(`[${refs[i]}] ${TEXTS[i]}`.trimEnd()), `칸 문단 ${i} 의 주소 줄`);
  assert.ok(brief.context.includes(`| ${FORM_SIGN.join(' ¶ ')} |`), '문단 둘인 칸은 ¶');

  // ── 읽기: 칸 주소·칸 문단 주소로 그 칸의 문단, 서식 보기의 칸 주소·칸 문단 범위, op 이름으로 묻는 안내, 찾기 ──
  const byCell = textOf(await v2.call('read', { doc_id: doc.id, at: cell }));
  assert.match(byCell, new RegExp(`^표 ${key.replace(/[#/]/g, '\\$&')} 의 r2·c1 칸 — 문단 9개`));
  for (let i = 0; i < 9; i++) assert.ok(byCell.includes(`[${refs[i]}] ${TEXTS[i]}`.trimEnd()));
  assert.ok(!byCell.includes('회의일시'), '그 칸의 문단만');
  const byPara = textOf(await v2.call('read', { doc_id: doc.id, at: refs[4] }));
  assert.ok(byPara.includes(`*[${refs[4]}] ${TEXTS[4]}`) && byPara.includes(` [${refs[0]}] ${TEXTS[0]}`), byPara);
  const byJson = textOf(await v2.call('read', { doc_id: doc.id, at: JSON.stringify(cell) }));
  assert.equal(byJson, byCell, '칸 주소를 JSON 글로 줘도 같다');
  assert.match(errorOf(await v2.call('read', { doc_id: doc.id, at: { table: key, row: 9, col: 0 } })), /오류\(NO_CELL\).*칸이 없습니다/);
  const whole = textOf(await v2.call('read', { doc_id: doc.id }));
  assert.ok(whole.includes('(문단 9개 ↓)') && whole.includes(`[${refs[8]}] ${TEXTS[8]}`));
  const found = textOf(await v2.call('read', { doc_id: doc.id, find: '96명' }));
  assert.ok(found.includes(`▦ ${key}`) && found.includes(`[${refs[5]}]`) && !found.includes(`[${refs[4]}]`), found);
  const fmtCell = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: cell }));
  assert.deepEqual(fmtCell.paragraphs.map((p) => p.ref), refs);
  assert.deepEqual(fmtCell.paragraphs.map((p) => p.paraPrId), FORM_LINES.map(([kind]) => FORM_SHAPES[kind].para));
  const fmtRange = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: `${refs[1]}..n999` }));
  assert.equal(fmtRange.paragraphs[0].ref, refs[1]);
  assert.ok(fmtRange.paragraphs.every((p) => /\/n\d+$/.test(p.ref)) && fmtRange.paragraphs.length === 8 + signRefs.length, '칸 문단 범위는 칸 문단으로(본문 문단이 아니다) — 있는 문단까지만');
  const guide = textOf(await v2.call('read', { doc_id: doc.id, view: 'guide', id: 'replace' }));
  assert.ok(guide.startsWith("· {op:'replace'") && !guide.includes('표준서식'), guide.slice(0, 120));

  // ── 미리 해 보기 → 저장(done): 날짜 칸·내용 칸 통째로·서명 칸의 글(칸 주소 + find) ──
  const ids = { doc_id: doc.id, request_id: r1.rid, expected_attempt: 1 };
  const NEW = ['□ 회의 목적', 'ㅇ 3분기 설문 마감 결과를 공유하고 후속 절차 검토', '□ 안건 1. 응답 현황', 'ㅇ 응답 104명으로 마감', '□ 결정사항', 'ㅇ 결과 보고서 초안을 다음 주까지 작성'];
  const ops = [
    { op: 'replace', at: { table: key, row: 0, col: 1 }, whole: true, with: '2031. 6. 3.(화) 12:00 ~ 14:00' },
    { op: 'replace', at: cell, whole: true, with: NEW.join('\n') },
    { op: 'replace', at: { table: key, row: 3, col: 0 }, find: '임꺽정', with: '성춘향' },
  ];
  const dry = json(await v2.call('edit', { ...ids, ops, dry_run: true }));
  assert.equal(dry.dry_run, true); assert.ok(!dry.failed?.length, JSON.stringify(dry.failed));
  assert.ok(dry.notes.some((n) => /표 고치기 제안 하나로 냈습니다/.test(n.note)), JSON.stringify(dry.notes));
  assert.equal((await api(`${D}/proposals`)).length, 0, '미리 해 보기는 저장하지 않는다');
  const out = json(await v2.call('edit', { ...ids, ops, done: '회의 일시를 고치고 회의 내용을 새 안건으로 다시 썼습니다.' }));
  assert.equal(out.completed, true, JSON.stringify(out)); assert.ok(!out.failed);
  assert.deepEqual(out.saved.map((x) => x.op), [0, 1, 2]);
  assert.equal(out.saved[1].table, key);
  const proposals = await api(`${D}/proposals`);
  assert.deepEqual(proposals.map((p) => [p.type, p.rid]), [['replace', r1.rid], ['replace', r1.rid], ['table_edit', r1.rid]], '글 제안 둘 + 표 고치기 하나(맨 뒤)');
  const [pDate, pSign, pCell] = proposals;
  assert.equal(pSign.ref, signRefs[1], '칸 주소 + find 는 그 글이 든 칸 문단');
  assert.match(pCell.tableEdit.labels[0], /^셀\(3번째 줄 2번째 칸\) 글 다시 쓰기 — 문단 9 → 6개: □ 회의 목적 ⏎ ㅇ 3분기 설문 마감 결과를/);
  assert.ok(!('tableUndo' in pCell));
  assert.ok(Array.isArray(pCell.tableEdit.ops[0].expect) && pCell.tableEdit.ops[0].expect.length === 9, '사라질 문단의 글 지문을 제안에 적어 둔다');

  // ── 사람이 표 고치기부터 반영해도(카드 차례와 다르게) 뒤 칸의 대기 제안이 제 문단을 따라간다 ──
  await api(`${D}/proposals/${pCell.pid}/apply`, { method: 'POST', body: {} });
  assert.deepEqual((await cellParas()).map((p) => p.text), NEW);
  const signNow = (await cellParas(3, 0)).map((p) => p.ref);
  assert.notDeepEqual(signNow, signRefs, '내용 칸 문단이 줄어 서명 칸 문단의 주소가 당겨졌다');
  assert.equal((await api(`${D}/proposals`)).find((p) => p.pid === pSign.pid).ref, signNow[1], '대기 제안의 주소도 옮겨졌다');
  await api(`${D}/proposals/${pSign.pid}/apply`, { method: 'POST', body: {} });
  await api(`${D}/proposals/${pDate.pid}/apply`, { method: 'POST', body: {} });
  assert.deepEqual((await cellParas(3, 0)).map((p) => p.text), [FORM_SIGN[0], FORM_SIGN[1].replace('임꺽정', '성춘향')]);
  assert.deepEqual((await cellParas(0, 1)).map((p) => p.text), ['2031. 6. 3.(화) 12:00 ~ 14:00']);
  // 새 문단의 모양: □ 줄은 제목 문단, ㅇ 줄은 항목 문단
  const fmtNew = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: cell }));
  assert.deepEqual(fmtNew.paragraphs.map((p) => [p.text, p.paraPrId]), NEW.map((text) => [text, FORM_SHAPES[text.startsWith('□') ? 'H' : 'I'].para]));

  // ── 표 고치기 되돌리기: 내용 칸은 고치기 전 문단으로, 다른 칸에서 그 뒤 고친 글은 그대로, 주소도 되돌아온다 ──
  await api(`${D}/proposals/${pCell.pid}/undo`, { method: 'POST', body: {} });
  assert.deepEqual((await cellParas()).map((p) => p.text), TEXTS);
  assert.deepEqual((await cellParas(3, 0)).map((p) => p.ref), signRefs);
  assert.deepEqual((await cellParas(3, 0)).map((p) => p.text), [FORM_SIGN[0], FORM_SIGN[1].replace('임꺽정', '성춘향')]);
  assert.equal((await api(`${D}/proposals`)).find((p) => p.pid === pSign.pid).ref, signRefs[1]);

  // ── 둘째 요청(칸 문단 대상 — 실제 Opus 실행의 요청 꼴): 대상 칸 문단에 * 표시, 문단별 바꿈 + 칸 안 넣기·지우기를 한 호출에 → [모두 반영] ──
  const r2 = await make({ kind: 'instruct', instruction: '안건 1 에 항목을 하나 더 넣고 빈 줄은 지워 줘', target: { ref: refs[4], text: TEXTS[4], start: 0, end: [...TEXTS[4]].length } });
  const b2 = json(await v2.call('task'));
  assert.equal(b2.request_id, r2.rid);
  assert.deepEqual(b2.target.cell, cell);
  assert.ok(b2.context.split('\n').some((l) => l.startsWith('*') && l.includes(`[${refs[4]}]`)), b2.context);
  assert.ok(!b2.context.split('\n').some((l) => l.startsWith('*') && l.includes(`[${refs[5]}]`)), '대상 문단만 * 표시');
  const out2 = json(await v2.call('edit', { doc_id: doc.id, request_id: r2.rid, expected_attempt: 1, ops: [
    { op: 'insert', after: refs[5], paragraphs: [{ text: 'ㅇ (비고) 미응답 24명' }] },
    { op: 'delete_paragraphs', at: [refs[2], refs[6]] },
    { op: 'replace', at: refs[8], whole: true, with: 'ㅇ 다음 회의에서 최종안을 확정하기로 함' },
  ], done: '안건 1 에 비고 항목을 넣고 빈 줄을 지웠습니다.' }));
  assert.equal(out2.completed, true, JSON.stringify(out2));
  const mine = (await api(`${D}/proposals`)).filter((p) => p.rid === r2.rid);
  assert.deepEqual(mine.map((p) => p.type), ['replace', 'table_edit']);
  assert.match(mine[1].tableEdit.labels[0], /^셀\(3번째 줄 2번째 칸\)의 문단 2개를 1개로 바꾸기: ㅇ \(비고\) 미응답 24명$/);
  const res = await api(`${D}/requests/${r2.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
  assert.ok(res, '모두 반영');
  const after = await cellParas();
  assert.deepEqual(after.map((p) => p.text), [TEXTS[0], TEXTS[1], TEXTS[3], TEXTS[4], TEXTS[5], 'ㅇ (비고) 미응답 24명', TEXTS[7], 'ㅇ 다음 회의에서 최종안을 확정하기로 함']);
  assert.ok((await api(`${D}/proposals`)).filter((p) => p.rid === r2.rid).every((p) => p.status === 'applied'));
  const fmt2 = json(await v2.call('read', { doc_id: doc.id, view: 'format', at: after[5].ref }));
  assert.equal(fmt2.paragraphs[0].paraPrId, FORM_SHAPES.I.para, '넣은 항목 줄은 항목 문단의 모양');

  // ── 셋째 요청: 칸 문단 하나를 여러 줄로(문단 나눔 — 실제 Codex 실행의 셋째 요청 꼴), 표 밖 본문에는 예전처럼 넣는다 ──
  const r3 = await make({ kind: 'instruct', instruction: '결과 항목을 두 줄로 나눠 줘', target: { scope: 'document', ref: 's0/p0' } });
  json(await v2.call('task'));
  assert.equal(after[4].text, TEXTS[5]);
  const out3 = json(await v2.call('edit', { doc_id: doc.id, request_id: r3.rid, expected_attempt: 1, ops: [
    { op: 'replace', at: after[4].ref, whole: true, with: 'ㅇ (결과) 응답 96명\nㅇ (응답률) 80%' },
    { op: 'insert', after: 's0/p2', text: '표 아래 본문 문단' },
  ], done: '결과 항목을 두 줄로 나눴습니다.' }));
  assert.equal(out3.completed, true, JSON.stringify(out3));
  await api(`${D}/requests/${r3.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
  assert.deepEqual((await cellParas()).map((p) => p.text).slice(4, 6), ['ㅇ (결과) 응답 96명', 'ㅇ (응답률) 80%']);
  assert.equal((await cellParas()).length, 9);
  const body = (await api(`${D}/paragraphs`)).filter((p) => !p.parent).map((p) => p.text);
  assert.equal(body[3], '표 아래 본문 문단', JSON.stringify(body));

  // 조판 부호가 든 문단이 있는 칸을 통째로 다시 쓰려 하면 저장 전에 그 op 번호로 알린다(아무것도 저장하지 않는다)
  const marked = await formCellDoc({ bookmarkAt: 4 });
  const doc2 = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await marked.doc.save()), '책갈피서식.hwpx');
  const before2 = (await api(`/api/docs/${doc2.id}/proposals`)).length;
  const bad = json(await v2.call('edit', { doc_id: doc2.id, ops: [{ op: 'replace', at: cell, whole: true, with: '가\n나' }] }));
  assert.match(bad.failed[0].error, /TABLE_CELL_OBJECT.*5번째 문단/); assert.deepEqual(bad.saved, []);
  assert.equal((await api(`/api/docs/${doc2.id}/proposals`)).length, before2);
});
