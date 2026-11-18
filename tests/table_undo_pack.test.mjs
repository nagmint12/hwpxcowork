// node --test tests/table_undo_pack.test.mjs — 표 고치기 되돌리기 자료(tableUndo)의 보관·노출(2026-11-18).
// 큰 표를 고친 제안마다 고치기 전 표 XML 이 meta.json 에 그대로 쌓여(2,000칸 표 = 제안 하나 1.4MB) 요청마다 읽는 meta.json 과
// 화면이 받는 제안 목록(GET /proposals)이 수 MB 가 됐다. 이제 ① 큰 XML 은 눌러서(tableUndo.beforeZ) 두고 ② 화면·도구 목록에는 싣지 않는다.
// ③ 예전 기록(before 그대로)도 되돌릴 수 있고 ④ 그 문서를 다음에 저장할 때 눌러 둔다. 임시 서버(빈 포트 — tests/helpers/server.mjs)만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
import { packTableUndo, tableUndoBefore, packProposalUndo } from '../server/service.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const author = '홍길동(Claude)';
const ROWS = [['구분', '항목', '내용', '비고'], ...Array.from({ length: 80 }, (_, i) => [`구분 ${i % 7}`, `항목 ${i}`, `내용 ${i} — 되돌리기 자료 시험`, i % 3 ? '' : '확인'])];

async function mcp(srv, name, args, session = 'sessUndoPack') {
  const r = await fetch(`${srv.base}/mcp?agent=UndoPackTest`, {
    method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const res = JSON.parse(line ? line.slice(5) : raw).result;
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
}

test('되돌리기 표 XML: 큰 것만 누르고(무손실) 작은 것·없는 것은 그대로, 예전 기록 묶음도 저장 직전에 누른다', () => {
  const xml = `<hp:tbl>${'<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가나다 &amp; 라</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr>'.repeat(400)}</hp:tbl>`;
  const big = { before: xml, skeleton: 'abc', origins: [[0, 0, 0]] };
  assert.equal(packTableUndo(big), true);
  assert.equal(big.before, undefined);
  assert.ok(typeof big.beforeZ === 'string' && big.beforeZ.length < xml.length / 10, `눌러서 10분의 1 아래(${big.beforeZ.length} / ${xml.length})`);
  assert.equal(tableUndoBefore(big), xml, '풀면 글자 하나까지 같다');
  assert.deepEqual([big.skeleton, big.origins], ['abc', [[0, 0, 0]]], '다른 되돌리기 값은 그대로');
  assert.equal(packTableUndo(big), false, '이미 눌렀으면 다시 누르지 않는다');

  const small = { before: '<hp:tbl/>', skeleton: 'x' };
  assert.equal(packTableUndo(small), false);
  assert.equal(tableUndoBefore(small), '<hp:tbl/>');
  assert.equal(tableUndoBefore(null), null);
  assert.equal(tableUndoBefore({ skeleton: 'x' }), null);
  assert.equal(packTableUndo(null), false);

  const meta = { proposals: [{ pid: 1, type: 'table_edit', tableUndo: { before: xml } }, { pid: 2, type: 'replace' }, { pid: 3, type: 'table_edit', tableUndo: { before: '<hp:tbl/>' } }, null] };
  assert.equal(packProposalUndo(meta), 1);
  assert.equal(tableUndoBefore(meta.proposals[0].tableUndo), xml);
  assert.equal(meta.proposals[2].tableUndo.before, '<hp:tbl/>');
  assert.equal(packProposalUndo(meta), 0);
  assert.equal(packProposalUndo({}), 0);
});

test('서버: 큰 표 고치기 — meta.json 에는 눌러서, 제안 목록에는 없이, 되돌리기는 그대로(예전 기록 포함)', { timeout: 90000 }, async () => {
  const srv = await startServer();
  try {
    const d0 = await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
    d0.insertTableAfter(0, 0, { rows: ROWS, headerRows: 1, caption: '큰 표' }, { author });
    d0.acceptAll();
    const doc = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await d0.save()), 'big-table.hwpx');
    const A = srv.api('a'); const D = `/api/docs/${doc.id}`;
    const metaFile = path.join(srv.dataDir, 'docs', doc.id, 'meta.json');
    const readMeta = () => JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const cols = async () => (await HwpxDoc.load(await A(`${D}/file?kind=working`))).tables()[0].cols;
    const key = (await HwpxDoc.load(await A(`${D}/file?kind=working`))).tables()[0].key;

    // ① 고치기 → 반영: 저장된 되돌리기 자료는 눌린 것(beforeZ)뿐
    const p1 = await mcp(srv, 'propose_table_edit', { doc_id: doc.id, table: key, ops: [{ op: 'delete_cols', cols: [3] }], reason: '비고 열 삭제' });
    assert.ok(p1.pid, JSON.stringify(p1).slice(0, 200));
    assert.equal((await A(`${D}/proposals/${p1.pid}/apply`, { method: 'POST' })).status, 'applied');
    assert.equal(await cols(), 3);
    const saved1 = readMeta().proposals.find((p) => p.pid === p1.pid);
    assert.equal(saved1.tableUndo.before, undefined, '큰 표 XML 을 그대로 두지 않는다');
    const beforeXml = tableUndoBefore(saved1.tableUndo);
    assert.ok(beforeXml.startsWith('<hp:tbl') && beforeXml.length > 4096 && saved1.tableUndo.beforeZ.length < beforeXml.length / 4, `눌러서 보관(${saved1.tableUndo.beforeZ.length} / ${beforeXml.length})`);
    assert.ok(saved1.tableUndo.skeleton, '뼈대 지문은 그대로');

    // ② 화면·도구가 받는 제안에는 되돌리기 자료가 없다(목록·반영 응답)
    const listed = (await A(`${D}/proposals`)).find((p) => p.pid === p1.pid);
    assert.deepEqual([listed.status, listed.tableUndo, listed.layoutUndo], ['applied', undefined, undefined]);
    assert.deepEqual(listed.tableEdit, saved1.tableEdit);
    assert.ok(JSON.stringify(await A(`${D}/proposals`)).length < 20000, '제안 목록이 표 크기만큼 커지지 않는다');

    // ③ 눌린 기록으로 되돌리기
    assert.equal((await A(`${D}/proposals/${p1.pid}/undo`, { method: 'POST' })).status, 'undone');
    assert.equal(await cols(), 4);

    // ④ 예전 기록(before 그대로 — 2026-11-18 전 서버가 쓴 꼴)도 되돌리고, 그 문서를 다음에 저장할 때 눌러 둔다
    const p2 = await mcp(srv, 'propose_table_edit', { doc_id: doc.id, table: key, ops: [{ op: 'delete_cols', cols: [0] }], reason: '구분 열 삭제' });
    assert.equal((await A(`${D}/proposals/${p2.pid}/apply`, { method: 'POST' })).status, 'applied');
    const p3 = await mcp(srv, 'propose_table_edit', { doc_id: doc.id, table: key, ops: [{ op: 'delete_cols', cols: [0] }], reason: '항목 열 삭제' });
    assert.equal((await A(`${D}/proposals/${p3.pid}/apply`, { method: 'POST' })).status, 'applied');
    assert.equal(await cols(), 2);
    const old = readMeta();
    for (const p of old.proposals) if (p.tableUndo?.beforeZ) { p.tableUndo.before = tableUndoBefore(p.tableUndo); delete p.tableUndo.beforeZ; }
    fs.writeFileSync(metaFile, JSON.stringify(old, null, 1));
    const oldSize = fs.statSync(metaFile).size;
    assert.ok(readMeta().proposals.find((p) => p.pid === p3.pid).tableUndo.before.length > 4096);
    assert.equal((await A(`${D}/proposals/${p3.pid}/undo`, { method: 'POST' })).status, 'undone', '예전 기록으로 되돌리기');
    assert.equal(await cols(), 3);
    const after = readMeta();
    assert.equal(after.proposals.find((p) => p.pid === p2.pid).tableUndo.before, undefined, '저장하면서 남은 예전 기록을 눌렀다');
    assert.ok(fs.statSync(metaFile).size < oldSize / 2, 'meta.json 이 줄었다');
    assert.equal((await A(`${D}/proposals/${p2.pid}/undo`, { method: 'POST' })).status, 'undone', '눌린 예전 기록으로 되돌리기');
    assert.equal(await cols(), 4);
    const end = await HwpxDoc.load(await A(`${D}/file?kind=working`));
    assert.deepEqual(end.tables()[0].cells.slice(0, 4).map((c) => c.text), ROWS[0], '표가 처음 그대로');
  } finally { await srv.stop(); }
});
