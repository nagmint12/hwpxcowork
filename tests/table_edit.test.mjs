// node --test tests/table_edit.test.mjs — 표 고치기(engine/table-edit.js · propose_table_edit · 서버 AI tableEdits)와
// 메모 답장 'AI에게 요청하기'(POST /memos/:id/ask-ai), 글자 모양 더(취소선·첨자·장평·자간·음영). 한/글 2022 확인은 tests/hangul_roundtrip.py 로 따로 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { parseTable, editTableXml } from '../engine/table-edit.js';
import { normalizeTableOps } from '../server/table-schema.js';
import { parseResult } from '../server/ai.js';
import * as MT from '../server/memotext.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const author = '홍길동(Claude)';
const reload = async (d) => HwpxDoc.load(await d.save());
const ROWS = [['구분', '항목', '내용'], ['가', '하나', '1'], ['가', '둘', '2'], ['나', '셋', '3'], ['나', '넷', '4']];

/** 5행×3열 표(캡션 '시험 표')가 s0/p1 에 든 문서 */
async function docWithTable() {
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  d.insertTableAfter(0, 0, { rows: ROWS, headerRows: 1, caption: '시험 표' }, { author });
  d.acceptAll();
  return reload(d);
}
const grid = (d, key) => { const t = d.tables().find((x) => x.key === key); return { rows: t.rows, cols: t.cols, cells: t.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.text]) }; };
const tblXml = (d, key) => { const sec = d.sections[0]; const t = d._tableIndex(sec).tables.find((x) => x.key === key); return sec.xml.slice(t.start, t.end); };
const sideOf = (d, xml, r, c, side) => {
  const m = parseTable(xml); const cell = m.cells.find((x) => x.row === r && x.col === c);
  const bf = /borderFillIDRef="(\d+)"/.exec(cell.open)[1];
  return (new RegExp(`<hh:${side}Border type="(\\w+)" width="([^"]+)"`).exec(d.header.block('borderFill', bf)) || []).slice(1).join(' ');
};

test('editTable: 줄·칸 지우기(표 폭 유지)·넣기·셀 합치기·나누기 — 격자·셀 주소·폭이 맞고 restoreTable 로 그대로 돌아온다', async () => {
  const d = await docWithTable();
  const key = 's0/p1#t0';
  const before = tblXml(d, key);
  const width0 = /<hp:sz width="(\d+)"/.exec(before)[1];
  const r = d.editTable('s0/p1/n4', [{ op: 'delete_cols', cols: [0] }, { op: 'delete_rows', rows: [2] }]);   // 칸 ref 로도 표를 찾는다
  assert.deepEqual([r.key, r.rows, r.cols, r.labels], [key, 4, 2, ['칸 1개 지우기', '줄 1개 지우기']]);
  const re = await reload(d);
  assert.deepEqual(grid(re, key).cells.map((c) => c[4]), ['항목', '내용', '하나', '1', '셋', '3', '넷', '4']);
  const x = tblXml(re, key);
  assert.match(x, /rowCnt="4" colCnt="2"/);
  assert.equal(/<hp:sz width="(\d+)"/.exec(x)[1], width0, '칸을 지워도 표 폭 유지(keep_width 기본)');
  assert.equal(parseTable(x).cells.filter((c) => c.row === 0).reduce((s, c) => s + c.width, 0), Number(width0));
  assert.match(x, /lastWidth="\d+"/);
  assert.equal(re.restoreTable(key, r.before, r.undo), true);
  assert.equal(tblXml(re, key), before);
  assert.throws(() => re.restoreTable(key, r.before, r.undo), (e) => e.code === 'STALE');
});

test('editTable: 셀 합치기·합친 칸 가운데 줄 넣기·칸 넣기·나누기, 잘못된 고치기는 TABLE_RANGE·NO_TABLE', async () => {
  const d = await docWithTable();
  const key = 's0/p1#t0';

  // 합치기: 글은 차례대로 한 칸에, 합친 칸 아래 줄 넣기는 합친 칸을 늘린다. 나누기는 빈 칸을 되살린다
  const m = d.editTable(key, [{ op: 'merge', range: { row_from: 1, row_to: 2, col_from: 0, col_to: 0 } }]);
  assert.equal(m.rows, 5);
  let g = grid(await reload(d), key);
  assert.deepEqual(g.cells.find((c) => c[0] === 1 && c[1] === 0), [1, 0, 2, 1, '가\n가']);
  assert.equal(g.cells.length, 14);
  d.editTable(key, [{ op: 'insert_rows', row: 1, count: 2 }, { op: 'insert_cols', col: 2, position: 'left' }]);
  g = grid(await reload(d), key);
  assert.deepEqual([g.rows, g.cols], [7, 4]);
  assert.deepEqual(g.cells.find((c) => c[0] === 1 && c[1] === 0).slice(0, 4), [1, 0, 4, 1], '합친 칸 가운데에 넣은 줄은 합친 칸이 덮는다');
  assert.equal(g.cells.filter((c) => c[1] === 2).every((c) => c[4] === ''), true, '넣은 칸은 비어 있다');
  d.editTable(key, [{ op: 'unmerge', row: 1, col: 0 }]);
  g = grid(await reload(d), key);
  assert.equal(g.cells.length, 28);
  // 잘못된 고치기
  assert.throws(() => d.editTable(key, [{ op: 'delete_rows', rows: [0, 1, 2, 3, 4, 5, 6] }]), (e) => e.code === 'TABLE_RANGE');
  assert.throws(() => d.editTable(key, [{ op: 'delete_cols', cols: [9] }]), (e) => e.code === 'TABLE_RANGE');
  assert.throws(() => d.editTable('s0/p0', [{ op: 'fill', color: '#FFFFFF' }]), (e) => e.code === 'NO_TABLE');
});

test('editTable: 줄·칸 넣기의 values — 새 줄(합계 줄)·새 칸의 글을 한 번에, 틀린 values 는 TABLE_SPEC', async () => {
  const d = await docWithTable(); const key = d.tables()[0].key;
  d.editTable(key, [{ op: 'insert_rows', row: 4, values: [['합계', '', '10']] }, { op: 'insert_cols', col: 2, values: [['비고', '-', '', '&<x>', '', '끝']] }]);
  const r = await reload(d); const g = grid(r, key);
  assert.equal(g.rows, 6); assert.equal(g.cols, 4);
  const at = (row, col) => g.cells.find((c) => c[0] === row && c[1] === col)?.[4];
  assert.deepEqual([at(5, 0), at(5, 1), at(5, 2)], ['합계', '', '10']);
  assert.deepEqual([at(0, 3), at(1, 3), at(3, 3), at(5, 3)], ['비고', '-', '&<x>', '끝']);
  assert.throws(() => d.editTable(key, [{ op: 'insert_rows', row: 1, values: [['a'], ['b']] }]), (e) => e.code === 'TABLE_SPEC');
  assert.throws(() => d.editTable(key, [{ op: 'insert_rows', row: 1, values: [[1]] }]), (e) => e.code === 'TABLE_SPEC');
  assert.deepEqual(normalizeTableOps([{ op: 'insert_rows', row: 1, values: [['합계', '3']] }])[0].values, [['합계', '3']]);
});

test('editTable: 테두리(위·아래 바깥선만 굵게)·배경·세로 정렬·표 속성 — 맞닿은 칸 변을 함께, 바뀌지 않은 셀 XML 은 그대로', async () => {
  const d = await docWithTable();
  const key = 's0/p1#t0';
  const x0 = tblXml(d, key);
  const dry = d.editTable(key, [{ op: 'border', sides: ['top', 'bottom'], line: { width_mm: 0.42 } }], { dryRun: true });
  assert.equal(tblXml(d, key), x0, 'dryRun 은 문서를 바꾸지 않는다');
  assert.equal(dry.geometry, false);
  d.editTable(key, [{ op: 'border', sides: ['top', 'bottom'], line: { width_mm: 0.42 } }]);
  const x1 = tblXml(d, key);
  for (let c = 0; c < 3; c++) {
    assert.match(sideOf(d, x1, 0, c, 'top'), / 0\.4 mm$/);
    assert.match(sideOf(d, x1, 4, c, 'bottom'), / 0\.4 mm$/);
    assert.equal(sideOf(d, x1, 2, c, 'top'), sideOf(d, x0, 2, c, 'top'), '안쪽 선은 그대로');
  }
  assert.equal(parseTable(x1).cells[7].kids.find((k) => k.name === 'hp:subList').xml, parseTable(x0).cells[7].kids.find((k) => k.name === 'hp:subList').xml);
  d.editTable(key, [{ op: 'border', sides: ['inner_h'], range: { row_from: 0, row_to: 1 }, line: { type: 'DOUBLE_SLIM', width_mm: 0.5 } },
    { op: 'fill', range: { row_from: 0, row_to: 0 }, color: '#ddebf7' }, { op: 'cell_align', vert_align: 'TOP' },
    { op: 'table', repeat_header: false, align: 'CENTER', width_mm: 120 }]);
  const x2 = tblXml(d, key);
  assert.equal(sideOf(d, x2, 0, 1, 'bottom'), 'DOUBLE_SLIM 0.5 mm');
  assert.equal(sideOf(d, x2, 1, 1, 'top'), 'DOUBLE_SLIM 0.5 mm');
  const bf = /borderFillIDRef="(\d+)"/.exec(parseTable(x2).cells[0].open)[1];
  assert.match(d.header.block('borderFill', bf), /faceColor="#DDEBF7"/);
  assert.match(x2, /repeatHeader="0"/);
  assert.match(x2, /horzAlign="CENTER"/);
  assert.match(x2, /<hp:sz width="3401[56]"/);
  assert.ok(parseTable(x2).cells.every((c) => /vertAlign="TOP"/.test(c.kids[0].xml)));
  // 한/글 순서·꼴로 다시 읽힌다
  const re = await reload(d);
  assert.deepEqual([grid(re, key).rows, grid(re, key).cols], [5, 3]);
  assert.throws(() => editTableXml(x2, [{ op: 'border', line: {} }], { header: d.header }), (e) => e.code === 'TABLE_SPEC');
  assert.throws(() => editTableXml(x2, [{ op: 'merge', range: { row_from: 0, row_to: 0, col_from: 0, col_to: 0 } }], { header: d.header }), (e) => e.code === 'TABLE_RANGE');
});

test('표 고치기 입력: null 은 빼고, Claude·OpenAI JSON 결과의 ops 문자열을 펼치며 틀린 항목만 뺀다', () => {
  assert.deepEqual(normalizeTableOps([{ op: 'border', sides: ['top'], line: { width_mm: 0.4, type: null }, range: null }]), [{ op: 'border', sides: ['top'], line: { width_mm: 0.4 } }]);
  assert.throws(() => normalizeTableOps([{ op: 'paint' }]));
  const empty = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: 's', instructionSummary: 'i' };
  const r = parseResult(JSON.stringify({ ...empty, tableEdits: [
    { table: 's0/p1#t0', ops: '[{"op":"delete_cols","cols":[1]}]', reason: '열 삭제' },
    { table: 's0/p1#t0', ops: '[{"op":"nope"}]', reason: '틀림' },
  ] }));
  assert.deepEqual(r.tableEdits.map((x) => x.ops), [[{ op: 'delete_cols', cols: [1] }]]);
  assert.equal(r.badTableEdits, 1);
});

/** MCP 도구 한 번 → 결과 JSON | { error } */
async function mcp(srv, name, args, session = 'sessT') {
  const r = await fetch(`${srv.base}/mcp?agent=TableTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('서버: propose_table_edit → 적용(변경 추적 없이 바로)·되돌리기, 작업 기록 메모, 메모 답장 AI에게 요청하기 → 서버 AI 표 고치기', { timeout: 90000 }, async () => {
  const srv = await startServer({ ai: 'mock' });
  try {
    const d0 = await docWithTable();
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await d0.save()), 'table.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const req = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '첫 열을 지워 줘', route: 'queue', target: { ref: 's0/p1/n2' } } })).request;
    const got = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: req.rid });
    assert.equal(got.tables[0].key, 's0/p1#t0');
    assert.match(got.howTo, /propose_table_edit/);
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req.rid });
    const bad = await mcp(srv, 'propose_table_edit', { doc_id: doc.id, table: 's0/p1#t0', ops: [{ op: 'delete_cols', cols: [7] }], request_id: req.rid });
    assert.match(bad.error, /TABLE_RANGE|표 밖|칸이 3개/);
    const p = await mcp(srv, 'propose_table_edit', { doc_id: doc.id, table: 's0/p1#t0', ops: [{ op: 'delete_cols', cols: [0] }, { op: 'border', sides: ['top', 'bottom'], line: { width_mm: 0.4 } }], reason: '구분 열 삭제', request_id: req.rid, expected_attempt: 1 });
    assert.deepEqual([p.type, p.ref, p.tableKey, p.tableEdit.labels, p.tableEdit.caption, p.tableEdit.result], ['table_edit', 's0/p1', 's0/p1#t0', ['칸 1개 지우기', '테두리(top·bottom 0.4mm)'], '시험 표', [5, 2]]);
    let file = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.equal(file.tables()[0].cols, 3, '적용 전에는 그대로');
    await mcp(srv, 'complete_request', { doc_id: doc.id, request_id: req.rid, summary: '표 첫 열 삭제를 제안함.', expected_attempt: 1 });
    const ap = await A(`${D}/proposals/${p.pid}/apply`, { method: 'POST' });
    assert.equal(ap.status, 'applied');
    file = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual([file.tables()[0].cols, file.tables()[0].cells[0].text, file.changes().length], [2, '항목', 0]);
    const memo = (await A(`${D}/memos`)).find((m) => m.link?.type === 'request' && m.link.rid === req.rid);
    assert.match(memo.text, /반영 1건/);
    assert.ok(MT.renderProposalMemo(ap).includes('이 표 「시험 표」 고치기: 칸 1개 지우기, 테두리(top·bottom 0.4mm)'));
    const un = await A(`${D}/proposals/${p.pid}/undo`, { method: 'POST' });
    assert.equal(un.status, 'undone');
    file = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual([file.tables()[0].cols, file.tables()[0].cells[0].text], [3, '구분']);
    // 수정본 반영은 안 된다(표는 바로 적용만)
    await A(`${D}/proposals/${p.pid}/reopen`, { method: 'POST' });
    const adopt = await A.res(`${D}/proposals/${p.pid}/adopt`, { method: 'POST' });
    assert.equal(adopt.status, 400);

    // AI 의견 메모(앞 작업이 '못 한다'고 남긴 것)에 답장 → AI에게 요청하기(서버 모의 AI) → 표 고치기 제안
    const req2 = (await A(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표 테두리를 굵게', route: 'queue', target: { ref: 's0/p1/n0' } } })).request;
    await mcp(srv, 'start_request', { doc_id: doc.id, request_id: req2.rid });
    const c = await mcp(srv, 'add_memo', { doc_id: doc.id, ref: 's0/p1/n0', text: '표 테두리는 편집기에서 직접 바꾸어야 함.', request_id: req2.rid });
    await mcp(srv, 'complete_request', { doc_id: doc.id, request_id: req2.rid, summary: '테두리 안내 메모를 남김.' });
    const memoId = c.id || c.memoId || (await A(`${D}/memos`)).find((m) => m.link?.type === 'comment' && m.link.rid === req2.rid).id;
    const empty = await A.res(`${D}/memos/${memoId}/ask-ai`, { method: 'POST', body: { text: '  ' } });
    assert.equal(empty.status, 400);
    const ask = await A(`${D}/memos/${memoId}/ask-ai`, { method: 'POST', body: { text: '위아래 바깥쪽만 굵게해줘', route: 'server' } });
    const r3 = (await A(`${D}/requests`)).find((x) => x.rid === ask.request.rid) || ask.request;
    assert.equal(r3.instruction, '위아래 바깥쪽만 굵게해줘');
    const view = await mcp(srv, 'get_request', { doc_id: doc.id, request_id: r3.rid });
    assert.deepEqual([view.followUp.memoId, view.followUp.rid, view.followUp.memoText], [memoId, req2.rid, '표 테두리는 편집기에서 직접 바꾸어야 함.']);
    assert.equal(view.target.tableKey, 's0/p1#t0');
    const props = (await A(`${D}/proposals`)).filter((x) => x.rid === r3.rid);
    assert.deepEqual(props.map((x) => [x.type, x.tableEdit?.ops?.[0]?.op]), [['table_edit', 'border']]);
    const th = (await A(`${D}/memos`)).find((m) => m.id === memoId).thread;
    assert.equal(th.replies.at(-1).text, `AI 작업 #${r3.rid} 요청: 위아래 바깥쪽만 굵게해줘`);
  } finally { await srv.stop(); }
});

test('글자 모양 더: 취소선·위/아래첨자(하나만)·장평·자간·음영 — 서식 제안 입력·엔진·카탈로그', async () => {
  const { normalizeFormat } = await import('../server/format-schema.js');
  assert.deepEqual(normalizeFormat({ char: { strikeout: true, shadeColor: '#ffff00', ratioPct: 90, spacingPct: null } }), { char: { strikeout: true, shadeColor: '#FFFF00', ratioPct: 90 } });
  assert.throws(() => normalizeFormat({ char: { ratioPct: 20 } }));
  const d = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
  assert.throws(() => d.formatRange('s0/p0', { start: 0, end: 2, char: { superscript: true, subscript: true } }), (e) => e.code === 'FORMAT_SPEC');
  const r = d.formatRange('s0/p0', { start: 0, end: 4, char: { strikeout: true, superscript: true, ratioPct: 90, spacingPct: -5, shadeColor: '#FFFF00' } });
  const props = d.formattingCatalog().charProperties.find((c) => c.id === r.after.runs[0].charPrId).props;
  assert.deepEqual([props.strikeout, props.superscript, props.subscript, props.ratioPct, props.spacingPct, props.shadeColor], [true, true, false, 90, -5, '#FFFF00']);
  const r2 = d.formatRange('s0/p0', { start: 0, end: 4, char: { strikeout: false, subscript: true, shadeColor: 'none' } });
  const xml = d.header.block('charPr', r2.after.runs[0].charPrId);
  assert.match(xml, /<hh:strikeout shape="NONE"/);
  assert.ok(xml.includes('<hh:subscript/>') && !xml.includes('<hh:supscript/>') && /shadeColor="none"/.test(xml));
  assert.equal(MT.formatSummary({ char: { strikeout: true, ratioPct: 90, shadeColor: 'none' } }), '취소선 켬 · 장평 90% · 음영 없음');
});
