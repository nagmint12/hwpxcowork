// v3 TSV 검증(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §22): 표 안의 표 안의 표 안의 표 + 병합 + 빈칸 서식에서 칸 주소로 정확한 자리에 쓰는지,
// 칸 안 줄바꿈이 TSV 에서 한 칸으로 남는지, 칸 안 새 표·그림 넣기를 조용히 표 밖으로 옮기지 않는지, 덮인 칸 주소를 알리는지
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { docBytesSync } from '../engine/toc.js';
import { textLines } from '../server/mcp2/views.js';
import { pageTsvLines } from '../server/mcp2/tsv-view.js';
import { parseOps, prepareOps } from '../server/mcp2/ops.js';
import { nestedTableDoc, NESTED } from './helpers/nested-table-doc.mjs';

const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const { T0, T1, T2, T3, T1b } = NESTED;

async function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-v3-nested-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config: { dataDir: path.join(tmp, 'd'), configFile: path.join(tmp, 'c.json'), ai: {}, agents: { leaseMinutes: 10 }, verify: { pages: false } }, ai: { enabled: false } });
  const docId = store.create({ fileName: 'nested.hwpx', bytes: Buffer.from(docBytesSync(await nestedTableDoc())), by: user.name }).id;
  const rid = (await service.createRequest(docId, { kind: 'instruct', instruction: '빈칸 채우기', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request.rid;
  await service.agentTake(user, 'codex', 'sess-1', { docId, rid });
  return { store, service, docId, rid };
}
const cellText = (doc, key, row, col) => doc.tables().find((t) => t.key === key).cells.find((c) => c.row === row && c.col === col).text;

test('v3 TSV: 안쪽 표마다 따로 블록 — 머리에 상위 표 열쇠와 칸(r·c), 병합 범위', async () => {
  const doc = await nestedTableDoc();
  const text = pageTsvLines(textLines(doc, { surface: 'v3' }).lines).text;
  for (const [key, parent] of [[T1, `${T0} r1c1`], [T2, `${T1} r1c2`], [T3, `${T2} r0c1`], [T1b, `${T0} r3c2`]]) assert.match(text, new RegExp(`▦ ${key.replace(/[/#]/g, (m) => `\\${m}`)} 표 \\d×\\d · 상위 ${parent.replace(/[/#]/g, (m) => `\\${m}`)} · TSV`), key);
  assert.match(text, /▦ s0\/p2#t0 표 5×3 · 병합 r0c0:r0c2, r1c0:r2c0/);
  assert.match(text, /▦ s0\/p2\/n2\/n4\/n1#t0 표 2×3 · 상위 .* · 병합 r0c1:r1c1/);
});

test('v3: 4단 중첩·병합 칸에 칸 주소로 넣으면 그 칸에 들어간다(바깥·안쪽 다른 칸은 그대로)', { timeout: 60000 }, async (t) => {
  const { store, service, docId, rid } = await setup(t);
  const want = [[T0, 0, 0, '사업 점검표'], [T0, 1, 0, '추진 내용'], [T1, 0, 0, '세부 항목'], [T1, 2, 0, 'B2'], [T2, 1, 0, 'C3'], [T3, 0, 1, 'D-가운데'], [T3, 1, 2, 'D4'], [T1b, 1, 1, 'E2'], [T0, 4, 1, 'A5']];
  const saved = await service.agentEdit(docId, { surface: 'v3', rid, ops: want.map(([table, row, col, w]) => ({ op: 'replace', at: { table, row, col }, find: '', with: w })) }, user, 'codex');
  assert.ok(!saved.failed, JSON.stringify(saved.failed));
  for (const p of (await service.listProposals(docId)).filter((x) => x.status === 'pending')) await service.applyProposal(docId, p.pid, user);
  const doc = await store.doc(docId);
  for (const [k, r, c, w] of want) assert.equal(cellText(doc, k, r, c), w, `${k} r${r}c${c}`);
  const filled = doc.tables().flatMap((x) => x.cells.filter((c) => c.text).map((c) => `${x.key} r${c.row}c${c.col}`));
  assert.equal(filled.length, want.length, filled.join(' · '));
});

test('덮인 칸 주소: 그 병합 칸으로 받고 영수증 notes 에 알린다', { timeout: 60000 }, async (t) => {
  const { service, docId, rid } = await setup(t);
  const out = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'replace', at: { table: T3, row: 1, col: 1 }, find: '', with: 'X' }, { op: 'replace', at: { table: T3, row: 0, col: 1 }, find: '', with: 'Y' }] }, user, 'codex');
  assert.ok(!out.failed, JSON.stringify(out.failed));
  assert.equal(out.notes.length, 1, JSON.stringify(out.notes));
  assert.match(out.notes[0].note, /칸 \(1, 1\)은 병합 칸 r0c1:r1c1 에 덮인 자리라 그 병합 칸\(row 0, col 1\)에 반영한다/);
});

test('칸 안 문단을 after 로 준 표·그림: v2 는 거절(조용히 표 밖에 두지 않는다), v3 는 표를 그 칸 안에(표 고치기 제안) · 그림은 둘 다 거절', async () => {
  const doc = await nestedTableDoc();
  const cellRef = doc.tables().find((x) => x.key === T0).cells.find((c) => c.row === 4 && c.col === 2).refs[0];
  const ops = [{ op: 'table', after: cellRef, rows: [['가', '나']] }, { op: 'figure', after: cellRef, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>' }];
  const v2 = prepareOps(doc, parseOps(ops).ok, { surface: 'v2' });
  assert.equal(v2.errors.length, 2, JSON.stringify(v2.errors));
  assert.match(v2.errors[0].error, /표 s0\/p2#t0 의 칸\(4, 2\) 안 문단입니다 — 표는 본문 문단 뒤에만/);
  assert.match(v2.errors[0].error, /after:'s0\/p2'/);
  assert.match(v2.errors[0].error, /insert 로 따로 넣지 않는다/);   // v2 오류의 꼴은 v2 꼴
  assert.match(v2.errors[1].error, /그림은 본문 문단 뒤에만/);
  const v3 = prepareOps(doc, parseOps(ops, { surface: 'v3' }).ok, { surface: 'v3', textRanges: true });
  assert.equal(v3.errors.length, 1, JSON.stringify(v3.errors));
  assert.match(v3.errors[0].error, /그림은 본문 문단 뒤에만/);
  const v3t = prepareOps(doc, parseOps([ops[0]], { surface: 'v3' }).ok, { surface: 'v3', textRanges: true });
  assert.deepEqual(v3t.errors, []);
  const item = v3t.steps.flatMap((x) => x.items || []).find((x) => x.input.type === 'table_edit');
  assert.ok(item, JSON.stringify(v3t.steps));
  assert.deepEqual(item.input.tableEdit.ops, [{ op: 'cell_paragraphs', row: 4, col: 2, count: 1, paragraphs: [{ table: { rows: [['가', '나']], headerRows: 1 }, near: 0 }, { text: '', near: 0 }] }]);
  // 캡션·단위·주석은 칸 안 표에 받지 않는다(v3 오류의 꼴은 v3 표 꼴 — 단위·주석 자리를 정하지 않는다)
  const cap = prepareOps(doc, parseOps([{ ...ops[0], caption: '제목' }], { surface: 'v3' }).ok, { surface: 'v3' });
  assert.match(cap.errors[0]?.error || '', /칸 안 표에는 caption·unit·notes 를 줄 수 없습니다/);
  assert.doesNotMatch(cap.errors[0].error, /insert 로 따로 넣지 않는다/);
  // 본문 문단 뒤는 예전 그대로(두 연결)
  for (const surface of ['v2', 'v3']) assert.deepEqual(prepareOps(doc, parseOps([{ op: 'table', after: 's0/p2', rows: [['가', '나']] }], { surface }).ok, { surface }).errors, []);
});

const tableXmlAt = (doc, key) => { const t = doc.tables().find((x) => x.key === key); const r = doc.resolve(t.ref); const x = r.sec.xml.slice(r.p.start, r.p.end); return x.slice(x.indexOf('<hp:tbl'), x.lastIndexOf('</hp:tbl>') + 9); };
const paraXmlAt = (doc, ref) => { const r = doc.resolve(ref); return r.sec.xml.slice(r.p.start, r.p.end); };
const cellAt = (d, key, r, c) => d.tables().find((x) => x.key === key).cells.find((x) => x.row === r && x.col === c);

test('v3 칸 안 새 표: 빈 칸 → 표만 든 문단 + 빈 문단(한/글·편집기 엔진 꼴), 칸 안쪽 폭에 맞춤, 다른 대기 제안 주소는 따라가고, 되돌리면 원래대로', { timeout: 60000 }, async (t) => {
  const { store, service, docId, rid } = await setup(t);
  let doc = await store.doc(docId);
  const anchor = cellAt(doc, T0, 3, 1).refs[0];   // 바깥 표 넷째 줄 가운데(빈칸) — 뒤에 r3c2(안쪽 표)·r4 칸들이 있다
  const before = { tables: doc.tables().length, r4c1: cellAt(doc, T0, 4, 1).refs[0] };
  // 같은 요청에서 먼저 뒤 칸(r4c1) 바꿈 제안을 하나 둔다 — 칸 문단이 늘면 그 주소가 밀린다
  const first = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'replace', at: { table: T0, row: 4, col: 1 }, find: '', with: 'A5' }] }, user, 'codex');
  assert.ok(!first.failed, JSON.stringify(first.failed));
  const saved = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'table', after: anchor, rows: [['가', '나', '다'], ['1', '2', '3']], header_rows: 0 }] }, user, 'codex');
  assert.ok(!saved.failed, JSON.stringify(saved.failed));
  const te = (await service.listProposals(docId)).find((p) => p.type === 'table_edit');
  assert.match(te.tableEdit.labels.join(' '), /셀\(4번째 줄 2번째 칸\)에 표 1개 넣기: \[표 2×3\]/);
  await service.applyProposal(docId, te.pid, user);
  doc = await store.doc(docId);
  assert.equal(doc.tables().length, before.tables + 1);
  const cell = cellAt(doc, T0, 3, 1);
  assert.equal(cell.refs.length, 2, '표 문단 + 빈 문단');
  const key = `${cell.refs[0]}#t0`;
  const x = tableXmlAt(doc, key);
  assert.match(paraXmlAt(doc, cell.refs[0]), /^<hp:p\b[^>]*><hp:run charPrIDRef="\d+"><hp:tbl\b[\s\S]*<\/hp:tbl><hp:t\/><\/hp:run><\/hp:p>$/, '표만 든 문단');
  assert.equal(doc.text(cell.refs[1], 'final'), '', '표 뒤 빈 문단');
  assert.match(x, /<hp:pos treatAsChar="1"[^>]*vertRelTo="PARA" horzRelTo="COLUMN"/);
  assert.match(x, /<hp:outMargin left="283" right="283" top="283" bottom="283"\/>/);
  assert.match(x, /<hp:inMargin left="510" right="510" top="141" bottom="141"\/>/);
  assert.match(x, /numberingType="NONE"[\s\S]*repeatHeader="0"/);
  const w = Number(/<hp:sz width="(\d+)"/.exec(x)[1]); const cw = [...x.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(cw.length, 6); assert.ok(cw.every((v) => v === cw[0]), `열 폭 고르게 ${cw}`); assert.equal(w, cw[0] * 3);
  assert.deepEqual(doc.tables().find((q) => q.key === key).cells.map((c) => c.text), ['가', '나', '다', '1', '2', '3']);
  // 앞서 낸 뒤 칸 바꿈 제안은 밀린 주소를 따라가 r4c1 에 들어간다
  const rp = (await service.listProposals(docId)).find((p) => p.type === 'replace' && p.status === 'pending');
  assert.notEqual(rp.ref, before.r4c1, '주소가 옮겨졌다');
  await service.applyProposal(docId, rp.pid, user);
  doc = await store.doc(docId);
  assert.equal(cellAt(doc, T0, 4, 1).text, 'A5');
  // 표 넣기 되돌리기(뒤에 바꿈을 반영했어도 그 칸은 그대로라 되돌릴 수 있다) → 칸 문단 하나, 표 수 원래대로, 바꾼 글은 남는다
  await service.undoProposal(docId, te.pid, user);
  doc = await store.doc(docId);
  assert.equal(doc.tables().length, before.tables);
  assert.equal(cellAt(doc, T0, 3, 1).refs.length, 1);
  assert.equal(cellAt(doc, T0, 4, 1).text, 'A5');
});

test('v3 칸 안 새 표: 글이 있는 칸 문단 뒤(문단은 그대로) · 가장 안쪽 표의 칸에도 · like 는 그 표의 칸 테두리 · 병합', { timeout: 60000 }, async (t) => {
  const { store, service, docId, rid } = await setup(t);
  await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'replace', at: { table: T3, row: 1, col: 2 }, find: '', with: '안쪽 칸 글' }] }, user, 'codex');
  for (const p of (await service.listProposals(docId)).filter((x) => x.status === 'pending')) await service.applyProposal(docId, p.pid, user);
  let doc = await store.doc(docId);
  const deep = cellAt(doc, T3, 1, 2).refs[0];
  const likeXml = tableXmlAt(doc, T1b);
  const likeBf = /borderFillIDRef="(\d+)"/.exec(likeXml.slice(likeXml.indexOf('<hp:tc')))[1];
  const saved = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'table', after: deep, rows: [['a', 'b'], ['c', '']], header_rows: 0, merges: ['r1c0:r1c1'], like: T1b }] }, user, 'codex');
  assert.ok(!saved.failed, JSON.stringify(saved.failed));
  for (const p of (await service.listProposals(docId)).filter((x) => x.status === 'pending')) await service.applyProposal(docId, p.pid, user);
  doc = await store.doc(docId);
  const cell = cellAt(doc, T3, 1, 2);
  assert.equal(cell.refs.length, 3, '글 문단 + 표 문단 + 빈 문단');
  assert.equal(doc.text(cell.refs[0], 'final'), '안쪽 칸 글');
  const key = `${cell.refs[1]}#t0`;
  const nt = doc.tables().find((x) => x.key === key);
  assert.ok(nt, doc.tables().map((x) => x.key).join(' '));
  assert.deepEqual([nt.rows, nt.cols], [2, 2]);
  assert.deepEqual(nt.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan, c.text]), [[0, 0, 1, 1, 'a'], [0, 1, 1, 1, 'b'], [1, 0, 1, 2, 'c']]);
  assert.match(tableXmlAt(doc, key), new RegExp(`<hp:tc\\b[^>]*borderFillIDRef="${likeBf}"`), 'like 표의 칸 테두리');
  assert.match(tableXmlAt(doc, key), /<hp:pos treatAsChar="1"[^>]*vertRelTo="PARA" horzRelTo="COLUMN"/, 'like 여도 칸 안 표 위치');
  assert.equal(cellAt(doc, T0, 0, 0).text, '');
});

test('칸 안 새 표의 꼴이 편집기 엔진(rhwp createTableInCellByPath — 한/글 2020 표본 규칙)이 만든 표와 같다', { timeout: 60000 }, async (t) => {
  const { HwpDocument } = await import('./helpers/rhwp.mjs');
  const { HwpxDoc } = await import('../engine/doc.js');
  const { containerFromBytesSync } = await import('../engine/toc.js');
  const eng = new HwpDocument(new Uint8Array(docBytesSync(await nestedTableDoc())));
  // 바깥 표 다섯째 줄 오른쪽 칸(XML 차례 12번째 칸 = cellIndex 11)의 첫 문단에 2×2
  JSON.parse(eng.createTableInCellByPath(0, 2, JSON.stringify([{ controlIndex: 0, cellIndex: 11, cellParaIndex: 0 }]), 0, JSON.stringify({ rowCount: 2, colCount: 2 })));
  const ref = new HwpxDoc(containerFromBytesSync(eng.exportHwpx()));
  const { store, service, docId, rid } = await setup(t);
  let doc = await store.doc(docId);
  const anchor = cellAt(doc, T0, 4, 2).refs[0];
  await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'table', after: anchor, rows: [['', ''], ['', '']], header_rows: 0 }] }, user, 'codex');
  for (const p of (await service.listProposals(docId)).filter((x) => x.status === 'pending')) await service.applyProposal(docId, p.pid, user);
  doc = await store.doc(docId);
  const shape = (d) => {
    const cell = cellAt(d, T0, 4, 2);
    const x = tableXmlAt(d, `${cell.refs[0]}#t0`);
    const pick = (re) => (re.exec(x) || [null])[0];
    return { paras: cell.refs.length, para: /^<hp:p\b[^>]*>/.exec(paraXmlAt(d, cell.refs[0]))[0].replace(/\sid="\d+"/, ''), sz: pick(/<hp:sz\b[^>]*\/>/), pos: pick(/<hp:pos\b[^>]*\/>/),
      out: pick(/<hp:outMargin\b[^>]*\/>/), inM: pick(/<hp:inMargin\b[^>]*\/>/), cells: [...x.matchAll(/<hp:cellSz\b[^>]*\/><hp:cellMargin\b[^>]*\/>/g)].map((m) => m[0]),
      valign: [...x.matchAll(/<hp:subList\b[^>]*vertAlign="(\w+)"/g)].map((m) => m[1]), tail: d.text(cell.refs[1], 'final') };
  };
  assert.deepEqual(shape(doc), shape(ref));
});

test('v3 TSV: 칸 안 줄바꿈·큰따옴표는 큰따옴표로 감싼 한 칸(문단 나눔과 줄 나눔 모두 줄바꿈)', async () => {
  const doc = await nestedTableDoc();
  const { tableKey } = doc.insertTableAfter(0, 1, { headerRows: 0, rows: [['일정', '1단계\n2단계', '"가나" 팀']] }, { author: '시험' });
  const lines = textLines(doc, { surface: 'v3' }).lines.filter((l) => l.table === tableKey && l.kind === 'tsv');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '일정\t"1단계\n2단계"\t"""가나"" 팀"');
});
