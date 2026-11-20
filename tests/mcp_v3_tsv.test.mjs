// MCP v3 표 읽기 시험. 합성 HWPX와 루프백 임시 서버에서 실행하며 AI 호출은 끈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { floatingDoc } from './helpers/floating-doc.mjs';
import { root, startServer, uploadDoc } from './helpers/server.mjs';

const BEFORE = '첫 구역 표 앞 본문';
const AFTER = '첫 구역 표 뒤 본문';
const SECOND = '둘째 구역 제목';
const INNER = '중첩 칸에서만 찾는 식별자';
const MATCH = '안건 "인용"\n접은 줄\t|';
const PARAS = [MATCH, '이어지는 새 문단'];
const OUTER_GRID = [
  ['키|제목', '탭\t"인용"', '', '머리끝'],
  ['유일한 병합값', '', '안건 "인용"\n접은 줄\t|\n이어지는 새 문단', '오른쪽'],
  ['', '', '바깥 칸 본문', ''],
  ['마지막 | 행', '여백', '끝', '가😀𠮷'],
];
const INNER_GRID = [[INNER, '중첩 오른쪽'], ['', '중첩 | 끝']];
const SECOND_GRID = [['둘째 표 표제', '둘째 값']];

const textOf = (response) => response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
function successful(response) {
  assert.ok(!response.isError, textOf(response));
  return textOf(response);
}

async function openMcp(srv, close, query, headers = {}) {
  const client = new Client({ name: 'table-tsv-regression', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`/mcp${query}`, srv.base), {
    requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, ...headers } },
  });
  close.push(async () => {
    await transport.terminateSession().catch(() => {});
    await client.close();
  });
  await client.connect(transport);
  return client;
}

async function testServer(t) {
  const srv = await startServer({ ai: 'off', config: { mcp: {} } });
  const close = [];
  t.after(async () => {
    try { for (const stop of close) await stop(); }
    finally { await srv.stop(); }
  });
  return { srv, open: (query, headers) => openMcp(srv, close, query, headers) };
}

const tool = (client, name, args) => client.callTool({ name, arguments: args });
const read = async (client, doc_id, args = {}) => successful(await tool(client, 'read', { doc_id, ...args }));

// TSV 한 필드씩 읽는다. 인용 필드 안의 탭·줄바꿈은 값이고, 연달아 쓴 큰따옴표는 한 글자다.
function tsvRows(data, count) {
  const field = /(?:"((?:[^"]|"")*)"|([^"\t\r\n]*))(\t|\r?\n|$)/y;
  const rows = [[]];
  let end = 0;
  while (true) {
    const match = field.exec(data);
    assert.ok(match, `TSV 이스케이프 오류 위치 ${end}: ${JSON.stringify(data.slice(end, end + 80))}`);
    const [, quoted, plain, sep] = match;
    rows.at(-1).push(quoted == null ? plain : quoted.replaceAll('""', '"'));
    if (!sep || (sep !== '\t' && (rows.length === count || field.lastIndex === data.length))) {
      assert.equal(rows.length, count, 'TSV 머리말이 알린 행 수');
      return { rows, length: field.lastIndex - sep.length };
    }
    if (sep !== '\t') rows.push([]);
    end = field.lastIndex;
  }
}

function tableBlocks(result) {
  const open = '<document_context>\n';
  const start = result.indexOf(open);
  const end = result.lastIndexOf('\n</document_context>');
  assert.ok(start >= 0 && end > start, '문서 자료 영역이 있다');
  const doc = result.slice(start + open.length, end);
  const header = /^ *▦ (\S+) 표 (\d+)×(\d+)([^\n]*) · TSV r(\d+)\.\.r(\d+)(?: · 행 조각 (\d+)\.\.(\d+)\/(\d+))?\n/gm;
  const blocks = [];
  for (let match; (match = header.exec(doc)); ) {
    const [, key, nRows, nCols, meta, r0, r1, startField, endField, total] = match;
    const first = Number(r0);
    const last = Number(r1);
    assert.ok(first <= last && last < Number(nRows), match[0]);
    const data = doc.slice(header.lastIndex);
    if (startField != null) {
      assert.equal(first, last, '행 조각은 한 원본 행만 가리킨다');
      const start = Number(startField);
      const end = Number(endField);
      const raw = data.slice(0, end - start);
      assert.equal(raw.length, end - start, '행 조각 오프셋과 실제 UTF-16 길이');
      assert.doesNotMatch(raw, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u, 'UTF-16 대리쌍을 자르지 않는다');
      blocks.push({ key, first, last, start, end, total: Number(total), raw });
      header.lastIndex += raw.length;
      continue;
    }
    const parsed = tsvRows(data, last - first + 1);
    for (const row of parsed.rows) assert.equal(row.length, Number(nCols), `표 ${key}의 모든 TSV 행은 ${nCols}열`);
    blocks.push({ key, meta, first, last, rows: parsed.rows, raw: data.slice(0, parsed.length) });
    header.lastIndex += parsed.length;
  }
  return blocks;
}

const grids = (blocks) => blocks.map(({ key, first, last, rows }) => [key, first, last, rows]);
const cursorOf = (text) => /\bcursor='([^']+)'/.exec(text.slice(text.lastIndexOf('</document_context>') + '</document_context>'.length))?.[1];

function rowsFromPages(blocks, tableKey) {
  const received = new Map();
  let fragments = 0;
  for (const block of blocks) {
    assert.equal(block.key, tableKey);
    if (block.rows) {
      for (const [i, row] of block.rows.entries()) {
        const rowNum = block.first + i;
        assert.ok(!received.has(rowNum), `행 ${rowNum}이 중복됐다`);
        received.set(rowNum, row);
      }
    } else {
      assert.equal(block.first, 1);
      const prior = received.get(block.first);
      assert.ok(!Array.isArray(prior), `행 ${block.first}이 중복됐다`);
      const raw = prior?.raw || '';
      assert.equal(block.start, raw.length, '행 안 다음 글자부터 이어진다');
      assert.ok(block.end > block.start && block.end <= block.total);
      if (prior) assert.equal(block.total, prior.total);
      const joined = raw + block.raw;
      received.set(block.first, block.end === block.total ? tsvRows(joined, 1).rows[0] : { raw: joined, total: block.total });
      fragments++;
    }
  }
  return { rows: Array.from(received), fragments };
}

function cellRefs(doc, key, row, col) {
  return doc.tables().find((table) => table.key === key).cells.find((cell) => cell.row === row && cell.col === col).refs;
}

function takeTableXml(doc, ref) {
  const { sec, p } = doc.resolve(ref);
  const [table] = /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(p.start, p.end));
  sec.load(sec.xml.slice(0, p.start) + sec.xml.slice(p.end));
  return table;
}

async function blank() {
  return HwpxDoc.load(fs.readFileSync(path.join(root, 'server', 'templates', 'blank.hwpx')));
}

async function smallDocument() {
  const doc = await blank();
  doc.sections.push(new Section(doc.sections[0].xml, 1));
  doc._rewriteSectionFiles();
  doc.insertFinalParagraphsAfter(0, 0, [BEFORE]);
  const outer = doc.insertTableAfter(0, 1, { rows: [OUTER_GRID[0], [OUTER_GRID[1][0], '', MATCH, '오른쪽'], ...OUTER_GRID.slice(2)], headerRows: 1 });
  doc.editTable(outer.tableKey, [
    { op: 'merge', range: { row_from: 1, row_to: 2, col_from: 0, col_to: 1 } },
    { op: 'cell_paragraphs', row: 1, col: 2, count: 1, paragraphs: PARAS.map((text) => ({ text })) },
  ]);
  const temporary = doc.insertTableAfter(0, 2, { rows: INNER_GRID, headerRows: 0 });
  const innerXml = takeTableXml(doc, temporary.ref);
  const [innerOwner] = cellRefs(doc, outer.tableKey, 2, 2);
  const { sec, p: target } = doc.resolve(innerOwner);
  const updated = sec.xml.slice(target.start, target.end).replace('<hp:t>바깥 칸 본문</hp:t>', `<hp:t>바깥 칸 본문</hp:t>${innerXml}`);
  sec.load(sec.xml.slice(0, target.start) + updated + sec.xml.slice(target.end));
  doc.insertFinalParagraphsAfter(0, 2, [AFTER]);
  doc.insertFinalParagraphsAfter(1, 0, [SECOND]);
  const second = doc.insertTableAfter(1, 1, { rows: SECOND_GRID });
  const innerKey = `${innerOwner}#t0`;
  const refs = cellRefs(doc, outer.tableKey, 1, 2);
  const bytes = Buffer.from(await doc.save());
  const reloaded = await HwpxDoc.load(bytes);
  assert.deepEqual(reloaded.tables().map((table) => [table.key, table.rows, table.cols]), [[outer.tableKey, 4, 4], [innerKey, 2, 2], [second.tableKey, 1, 2]]);
  assert.deepEqual(refs.map((ref) => reloaded.text(ref, 'final')), PARAS);
  return { bytes, outerKey: outer.tableKey, innerKey, secondKey: second.tableKey, refs };
}

const LONG = '시작:' + '한\t글"😀𠮷\n가'.repeat(320) + ':끝';
const LONG_GRID = [['첫 행', '오른쪽'], [LONG, '같은 행 끝'], ['다음 행', '마지막 칸']];
async function longDocument(value = LONG) {
  const doc = await blank();
  doc.insertFinalParagraphsAfter(0, 0, [BEFORE]);
  const { tableKey } = doc.insertTableAfter(0, 1, { rows: [LONG_GRID[0], [value, LONG_GRID[1][1]], LONG_GRID[2]], headerRows: 1 });
  const bytes = Buffer.from(await doc.save());
  const reloaded = await HwpxDoc.load(bytes);
  const [ref] = cellRefs(reloaded, tableKey, 1, 0);
  assert.equal(reloaded.text(ref, 'final'), value);
  return { bytes, tableKey };
}

test('MCP v3 본문·구역·범위·표 단독의 TSV 보존과 v2 표시 유지', async (t) => {
  const { srv, open } = await testServer(t);
  const { bytes, outerKey, innerKey, secondKey } = await smallDocument();
  const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '합성 TSV.hwpx');
  const v3 = await open('?v=3&tools=core');
  const headerV3 = await open('?v=2&tools=core', { 'X-Hwpx-Mcp': '3' });
  const v2 = await open('?v=2&tools=core');
  assert.match((await v3.listTools()).tools.find((entry) => entry.name === 'read').description, /TSV/);
  assert.doesNotMatch((await v2.listTools()).tools.find((entry) => entry.name === 'read').description, /TSV/);
  const whole = await read(v3, id);
  const blocks = tableBlocks(whole);
  assert.deepEqual(grids(blocks), [
    [outerKey, 0, 3, OUTER_GRID], [innerKey, 0, 1, INNER_GRID], [secondKey, 0, 0, SECOND_GRID],
  ]);
  const mergeLine = whole.split('\n').find((line) => line.startsWith(`▦ ${outerKey} `) && line.includes('병합'));
  assert.match(mergeLine ?? '', /병합[^\n]*\br1c0:r2c1\b/);
  assert.ok(blocks[1].meta.includes(`상위 ${outerKey} r2c2`), '중첩 표가 들어간 상위 칸을 찾을 수 있다');
  assert.equal(blocks[0].rows.flat().filter((cell) => cell === '유일한 병합값').length, 1);
  assert.ok(blocks[0].raw.startsWith('키|제목\t"탭\t""인용"""\t\t머리끝\n'), '원래 |, 탭, 큰따옴표와 연속된 빈 칸');
  assert.ok(whole.indexOf(BEFORE) < whole.indexOf(outerKey) && whole.indexOf(AFTER) > whole.indexOf(innerKey));
  assert.deepEqual(grids(tableBlocks(await read(headerV3, id))), grids(blocks));
  const old = await read(v2, id);
  assert.deepEqual(tableBlocks(old), []);
  assert.match(old, /(?:^|\n)\s*r1 \|/);

  const range = await read(v3, id, { at: 's0/p2..s1/p1' });
  assert.deepEqual(grids(tableBlocks(range)), grids(blocks).slice(0, 2));
  assert.ok(!range.includes(BEFORE) && range.includes(AFTER) && range.includes(SECOND));
  const section = await read(v3, id, { at: 's1' });
  assert.deepEqual(grids(tableBlocks(section)), [[secondKey, 0, 0, SECOND_GRID]]);
  assert.ok(section.includes(SECOND) && !section.includes(AFTER));
  const only = await read(v3, id, { view: 'tables', id: outerKey });
  assert.deepEqual(grids(tableBlocks(only)), [[outerKey, 0, 3, OUTER_GRID]]);
  assert.doesNotMatch(only, /첫 구역 표 앞 본문|중첩 칸에서만 찾는 식별자/);
  const inventory = await read(v3, id, { view: 'tables' });
  assert.deepEqual(tableBlocks(inventory), []);
  for (const key of [outerKey, innerKey, secondKey]) assert.ok(inventory.includes(key));
});

test('MCP v3 검색은 원래 칸 글과 기준 행을 사용하고 칸 및 서식 정밀 읽기는 유지한다', async (t) => {
  const { srv, open } = await testServer(t);
  const { bytes, outerKey, innerKey, refs } = await smallDocument();
  const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '합성 TSV 검색.hwpx');
  const v3 = await open('?v=3&tools=core');
  const v2 = await open('?v=2&tools=core');
  const repeated = await read(v3, id, { find: '글이 없는 고유어' });
  assert.deepEqual(tableBlocks(repeated), []);
  const byOriginal = await read(v3, id, { find: MATCH });
  assert.deepEqual(grids(tableBlocks(byOriginal)), [[outerKey, 1, 1, [OUTER_GRID[1]]]], '인용하고 이스케이프하기 전 칸 글이 검색 대상');
  const nestedMatch = await read(v3, id, { find: INNER });
  assert.deepEqual(grids(tableBlocks(nestedMatch)), [[innerKey, 0, 0, [INNER_GRID[0]]]]);
  assert.deepEqual(grids(tableBlocks(await read(v3, id, { find: '|' }))), [
    [outerKey, 0, 1, OUTER_GRID.slice(0, 2)], [outerKey, 3, 3, [OUTER_GRID[3]]], [innerKey, 1, 1, [INNER_GRID[1]]],
  ]);

  const cell = { table: outerKey, row: 1, col: 2 };
  for (const at of [cell, refs[1], { table: outerKey, row: 2, col: 1 }]) {
    assert.equal(await read(v3, id, { at }), await read(v2, id, { at }));
  }
  assert.ok((await read(v3, id, { at: refs[1] })).includes(`*[${refs[1]}] 이어지는 새 문단`));
  assert.ok((await read(v3, id, { at: { table: outerKey, row: 2, col: 1 } })).includes('유일한 병합값'));
  const formats = JSON.parse(await read(v3, id, { view: 'format', at: cell }));
  assert.deepEqual(formats, JSON.parse(await read(v2, id, { view: 'format', at: cell })));
  assert.deepEqual(formats.paragraphs.map((p) => [p.ref, p.text]), [[refs[0], PARAS[0]], [refs[1], PARAS[1]]]);
});

test('MCP v3 같은 본문 문단의 표와 중첩 표는 XML 차례를 따르고 긴 캡션과 표 열쇠를 검색한다', async (t) => {
  const { srv, open } = await testServer(t);
  const { bytes, outerKey, innerKey, secondKey } = await smallDocument();
  const doc = await HwpxDoc.load(bytes);
  const owner = 's0/p2';
  const siblingKey = 's0/p2#t1';
  const lastWords = '캡션의 끝 고유어 𠮷';
  const caption = '이 표의 긴 캡션과  원래 띄어쓰기. '.repeat(10) + lastWords;
  const siblingGrid = [['같은 문단의 둘째 표', '둘째 표의 값'], ['형제 표 끝', '']];
  const sibling = doc.insertTableAfter(0, 2, { rows: siblingGrid, caption }, { author: '시험' });
  const tableXml = takeTableXml(doc, sibling.ref);
  const { sec, p } = doc.resolve(owner);
  const original = sec.xml.slice(p.start, p.end);
  const withSibling = original.replace(/<\/hp:run><\/hp:p>$/, `${tableXml}</hp:run></hp:p>`);
  assert.notEqual(withSibling, original, 'A를 품은 본문 문단에 B도 넣었다');
  sec.load(sec.xml.slice(0, p.start) + withSibling + sec.xml.slice(p.end));
  doc.acceptAll();
  const input = Buffer.from(await doc.save());
  const reloaded = await HwpxDoc.load(input);
  assert.deepEqual(reloaded.tables().map(({ key }) => key), [outerKey, innerKey, siblingKey, secondKey]);
  assert.ok(reloaded.tables().find(({ key }) => key === siblingKey).caption.text.includes(caption));

  const { id } = await uploadDoc(srv.base, srv.tokens.a, input, '같은 문단의 여러 표.hwpx');
  const v3 = await open('?v=3&tools=core');
  const expected = [[outerKey, 0, 3, OUTER_GRID], [innerKey, 0, 1, INNER_GRID], [siblingKey, 0, 1, siblingGrid]];
  const whole = await read(v3, id);
  assert.deepEqual(grids(tableBlocks(whole)), [...expected, [secondKey, 0, 0, SECOND_GRID]]);
  assert.deepEqual(grids(tableBlocks(await read(v3, id, { at: owner }))), expected);
  const siblingOnly = await read(v3, id, { view: 'tables', id: siblingKey });
  assert.deepEqual(grids(tableBlocks(siblingOnly)), [expected[2]]);
  for (const output of [whole, siblingOnly]) assert.ok(output.includes(caption), '긴 캡션 끝과 원래 띄어쓰기');

  for (const find of [lastWords, siblingKey]) {
    const match = await read(v3, id, { find });
    assert.ok(match.includes(`▦ ${siblingKey} 표 2×2`), `검색한 표의 실제 열쇠: ${find}`);
    assert.ok(!match.includes('▦ ' + outerKey) && !match.includes('▦ ' + innerKey));
    assert.deepEqual(tableBlocks(match), [], '캡션·표 열쇠 검색에 적중하지 않은 행은 싣지 않는다');
    if (find === lastWords) assert.ok(match.includes(caption));
  }
});

test('MCP v3 이어 읽기는 긴 행의 식별·원형을 유지하고 다른 문서와 바뀐 문서의 cursor를 거절한다', async (t) => {
  const { srv, open } = await testServer(t);
  const { bytes, tableKey } = await longDocument();
  const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '긴 표.hwpx');
  const { id: other } = await uploadDoc(srv.base, srv.tokens.a, bytes, '복제한 긴 표.hwpx');
  const v3 = await open('?v=3&tools=core');
  const args = { view: 'tables', id: tableKey, max_chars: 1000 };
  const allBlocks = [];
  let cursor, originalCursor, pages = 0;
  do {
    const result = await read(v3, id, { ...args, cursor });
    const blocks = tableBlocks(result);
    assert.ok(blocks.length, '매 페이지에 표와 원래 행 번호가 있다');
    const context = /<document_context>\n([\s\S]*)\n<\/document_context>/.exec(result)[1];
    assert.ok(context.length <= args.max_chars, 'TSV 자료는 요청한 페이지 한도를 지킨다');
    allBlocks.push(...blocks);
    cursor = cursorOf(result);
    originalCursor ??= cursor;
    assert.ok(++pages <= 20, 'cursor는 끝까지 진전해야 한다');
  } while (cursor);
  const assembled = rowsFromPages(allBlocks, tableKey);
  assert.ok(originalCursor && assembled.fragments > 1 && pages > 2, '긴 한 행을 여러 응답으로 이어서 읽었다');
  assert.deepEqual(assembled.rows, LONG_GRID.map((row, index) => [index, row]));

  const wrong = await tool(v3, 'read', { doc_id: other, ...args, cursor: originalCursor });
  assert.equal(wrong.isError, true);
  assert.match(textOf(wrong), /BAD_CURSOR/);
  const change = JSON.parse(successful(await tool(v3, 'edit', { doc_id: id, ops: [{ op: 'replace', at: 's0/p1', find: BEFORE, with: '바뀐 본문' }] })));
  assert.equal(change.saved.length, 1);
  await srv.api('a')(`/api/docs/${id}/proposals/${change.saved[0].pid}/apply`, { method: 'POST', body: {} });
  const stale = await tool(v3, 'read', { doc_id: id, ...args, cursor: originalCursor });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /READ_CHANGED/);
});

test('MCP v3 task/REST brief의 셀 선택은 좌표를 유지하고 TSV 값에 대상 표시를 넣지 않는다', async (t) => {
  const { srv, open } = await testServer(t);
  const { bytes, outerKey, innerKey, refs } = await smallDocument();
  const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '합성 TSV 요청.hwpx');
  const v3 = await open('?v=3&tools=core');
  const api = srv.api('a');
  const D = `/api/docs/${id}`;
  const { request } = await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '선택한 표 칸을 읽으세요.', target: { ref: refs[1], text: PARAS[1], start: 0, end: [...PARAS[1]].length } } });
  const reply = await tool(v3, 'task', { doc_id: id, request_id: request.rid });
  successful(reply);
  assert.deepEqual(reply.content.map((item) => item.type), ['text', 'text']);
  const metadata = JSON.parse(reply.content[0].text);
  assert.equal(metadata.request_id, request.rid);
  assert.equal(metadata.target.ref, refs[1]);
  assert.deepEqual(metadata.target.cell, { table: outerKey, row: 1, col: 2 });
  assert.ok(!Object.hasOwn(metadata, 'context'));
  const expected = [[outerKey, 0, 3, OUTER_GRID], [innerKey, 0, 1, INNER_GRID]];
  assert.deepEqual(grids(tableBlocks(reply.content[1].text)), expected);
  const brief = await api(`${D}/requests/${request.rid}/brief`, { headers: { 'X-Hwpx-Mcp': '3' } });
  assert.deepEqual(brief.target.cell, metadata.target.cell);
  assert.deepEqual(grids(tableBlocks(brief.context)), expected);
  successful(await tool(v3, 'finish', { doc_id: id, request_id: request.rid, no_changes_reason: '칸의 내용을 확인했습니다.' }));
  const none = await tool(v3, 'task', {});
  assert.equal(none.content.length, 1);
  assert.deepEqual(JSON.parse(successful(none)), { none: true });
});

test('MCP v3 문서 전체 brief는 혼합 문서에서 실제 본문과 표를 준다', async (t) => {
  const { srv, open } = await testServer(t);
  const doc = await floatingDoc({ pages: [{ title: '떠 있는 글상자 '.repeat(12) }] });
  doc.insertFinalParagraphsAfter(0, 0, ['혼합 문서의 본문']);
  const { tableKey } = doc.insertTableAfter(0, 1, { rows: SECOND_GRID });
  const { id } = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await doc.save()), '혼합 문서 TSV.hwpx');
  const api = srv.api('a');
  const D = `/api/docs/${id}`;
  const { request } = await api(`${D}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '문서 전체를 읽으세요.', target: { scope: 'document', ref: 's0/p0' } } });
  const v3 = await open('?v=3&tools=core');
  const reply = await tool(v3, 'task', { doc_id: id, request_id: request.rid });
  successful(reply);
  const summary = JSON.parse(reply.content[0].text);
  assert.match(summary.map, /⚠/u, '떠 있는 개체가 문서에서 차지하는 비중이 큰 경우');
  assert.deepEqual(summary.target, { scope: '문서 전체' });
  assert.match(reply.content[1].text, /혼합 문서의 본문/);
  assert.deepEqual(grids(tableBlocks(reply.content[1].text)), [[tableKey, 0, 0, SECOND_GRID]]);
  const legacy = await api(`${D}/requests/${request.rid}/brief`, { headers: { 'X-Hwpx-Mcp': '2' } });
  assert.match(legacy.context, /objects_to_body/);
  assert.deepEqual(tableBlocks(legacy.context), []);
});

test('MCP v3 범위 brief의 안내 그대로 이어 읽으면 표 범위와 원문을 보존한다', async (t) => {
  const { srv, open } = await testServer(t);
  const long = LONG.repeat(5);
  const { bytes, tableKey } = await longDocument(long);
  const { id } = await uploadDoc(srv.base, srv.tokens.a, bytes, '범위 TSV 요청.hwpx');
  const v3 = await open('?v=3&tools=core');
  const { request } = await srv.api('a')(`/api/docs/${id}/requests`, { method: 'POST', body: { route: 'queue', kind: 'instruct', instruction: '선택한 본문 범위만 읽으세요.', target: { scope: 'document', ref: 's0/p0', from: 2, to: 3 } } });
  const reply = await tool(v3, 'task', { doc_id: id, request_id: request.rid });
  successful(reply);
  const metadata = JSON.parse(reply.content[0].text);
  assert.deepEqual(metadata.target, { scope: '문서 전체', from: 2, to: 3 });
  const offered = /read\(view='text', at='([^']+)', cursor='([^']+)'\)/.exec(metadata.more);
  assert.ok(offered, '같은 범위를 이어 읽을 입력을 알려 준다');
  assert.equal(offered[1], 's0/p2..s0/p2');

  const pages = [reply.content[1].text];
  let cursor = offered[2];
  do {
    const next = await read(v3, id, { view: 'text', at: offered[1], cursor, max_chars: 4000 });
    pages.push(next);
    cursor = cursorOf(next);
    assert.ok(pages.length <= 16);
  } while (cursor);
  for (const page of pages) assert.ok(!page.includes(BEFORE), '범위 밖 본문이 섞이지 않는다');
  const assembled = rowsFromPages(pages.flatMap(tableBlocks), tableKey);
  assert.ok(assembled.fragments > 1);
  assert.deepEqual(assembled.rows, [[0, LONG_GRID[0]], [1, [long, LONG_GRID[1][1]]], [2, LONG_GRID[2]]]);
});
