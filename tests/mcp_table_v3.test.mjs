// 새 표 만들기 개선(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §20). 실제 Codex 실행(엑셀 첨부로 빠진 표 35개 넣기)에서:
// 칸 수치는 35/35 맞았는데 병합 칸 335개가 모두 빠지고(table op 에 병합이 없었다), 머리 칸 「t/F⏎(사후검정)」의 줄바꿈을 보냈는데 서버(normTable)가
// 공백으로 바꿨고, 단위 문구 '(base: …, 단위: …)' 를 안내('(단위: …)'로 감싼다)에 맞추느라 바꿔 냈다. 사용자 결정으로: 칸 안 줄바꿈 지키기·merges·like(본보기 표)·
// 단위 문구 그대로, 단위·주석의 자리는 정하지 않는다(v3 안내에서 절대 문구 뺌 — v2 는 그대로)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { normUnit } from '../engine/captions-notes.js';
import { parseOps, prepareOps, opsBrief, OPS_BRIEF, opsGuide } from '../server/mcp2/ops.js';
import { taskEditorInstructions } from '../server/editor-instructions.js';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const AGENT = 'claude-code';
const AFTER = 's1/p6';

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-table-v3-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, verify: { pages: false } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'report.hwpx', bytes: fs.readFileSync(REPORT), by: user.name }).id;
  return { store, service, docId };
}
// 표 하나 넣고 반영 → { key, table(엔진 표 기록), doc }
async function addTable(store, service, docId, table) {
  const p = await service.propose(docId, { type: 'table', afterRef: AFTER, table }, user, AGENT);
  await service.applyProposal(docId, p.pid, user);
  const after = (await service.listProposals(docId)).find((x) => x.pid === p.pid);
  const doc = await store.doc(docId);
  return { p: after, key: after.tableKey, table: doc.tables().find((x) => x.key === after.tableKey), doc };
}
// 단위 행·머리 행·본문 두 행·주석 행 — 엑셀 사례와 같은 꼴(단위·주석이 표 안 행, 가로로 합침)
const ROWS = [
  ['(단위: 명, 점: 5점 척도)', '', '', ''],
  ['구분', '', 'N', 't/F\n(사후검정)'],
  ['성별', '남성', '115', '1.984*'],
  ['', '여성', '211', ''],
  ['주) * p < .05', '', '', ''],
];
const MERGES = ['r0c0:r0c3', 'r1c0:r1c1', 'r2c0:r3c0', 'r2c3:r3c3', 'r4c0:r4c3'];
const spans = (t) => t.cells.filter((c) => c.rowSpan > 1 || c.colSpan > 1).map((c) => `r${c.row}c${c.col}:r${c.row + c.rowSpan - 1}c${c.col + c.colSpan - 1}`).sort();

test('칸 안 줄바꿈은 칸 안 줄 나눔으로 남고, merges 대로 합쳐진다', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const { table, doc, p } = await addTable(store, service, docId, { rows: ROWS, headerRows: 2, caption: '시험 표', merges: MERGES });
  assert.equal(p.status, 'applied');
  assert.deepEqual(spans(table), [...MERGES].sort());
  const head = table.cells.find((c) => c.row === 1 && c.col === 3);
  assert.equal(doc.text(head.refs[0], 'final'), 't/F\n(사후검정)', '줄바꿈이 공백이 되지 않는다');
  // 덮인 칸이 빈 글이면 왼쪽 위 칸 글만 남는다
  assert.equal(doc.text(table.cells.find((c) => c.row === 0 && c.col === 0).refs[0], 'final'), '(단위: 명, 점: 5점 척도)');
});

test('merges 꼴 검사: 표 밖·한 칸·겹침·꼴 틀림은 만들 때 거절', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  for (const [merges, re] of [[['r0c0:r9c0'], /표 밖/], [['r1c1:r1c1'], /칸 하나뿐/], [['r0c0:r1c1', 'r1c1:r2c2'], /겹칩니다/], [['A1:B2'], /'r0c0:r1c1' 꼴/], [['r1c1:r0c0'], /왼쪽 위:오른쪽 아래/]]) {
    await assert.rejects(service.propose(docId, { type: 'table', afterRef: AFTER, table: { rows: ROWS, merges } }, user, AGENT), re, JSON.stringify(merges));
  }
});

test('like: 크기가 같으면 칸마다 본보기 모양·열 폭·병합을 따르고, 크기가 다르면 모양만', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const src = await addTable(store, service, docId, { rows: ROWS, headerRows: 2, caption: '본보기', merges: MERGES });
  // 같은 크기 — merges 를 주지 않아도 본보기의 병합을 따른다
  const same = await addTable(store, service, docId, { rows: ROWS.map((r) => r.map((c) => (c === '115' ? '99' : c))), headerRows: 2, caption: '본뜬 표', like: src.key });
  assert.deepEqual(spans(same.table), [...MERGES].sort(), '병합까지');
  // 칸 모양 견주기는 엔진 안쪽 표 기록(테두리 번호·칸 폭)으로 — 본보기는 캡션 글로 찾는다(뒤에 넣은 표 때문에 주소가 밀렸다)
  const inner = (doc, caption) => { for (const sec of doc.sections) for (const tb of doc._tableIndex(sec).tables) { if (tb.captionParas.some((p) => doc.text(p.ref, 'final').includes(caption))) return tb; } return null; };
  const look = (tb) => tb.cells.map((c) => `${c.row},${c.col}:${c.attrs.get('borderFillIDRef')}:${c.width}`).sort().join('|');
  const a = inner(same.doc, '본보기'), b = inner(same.doc, '본뜬 표');
  assert.ok(a && b, '두 표를 캡션으로 찾는다');
  assert.equal(look(b), look(a), '칸마다 테두리·열 폭이 본보기와 같다');
  // 다른 크기 — 병합은 따르지 않는다(주면 준 대로)
  const diff = await addTable(store, service, docId, { rows: [['가', '나'], ['1', '2'], ['3', '4']], caption: '다른 크기', like: src.key });
  assert.equal(diff.p.status, 'applied'); assert.deepEqual(spans(diff.table), []);
  // 없는 본보기는 만들 때 거절
  await assert.rejects(service.propose(docId, { type: 'table', afterRef: AFTER, table: { rows: ROWS, like: 's9/p9#t0' } }, user, AGENT), /like 의 표를 찾지 못했습니다/);
});

// 검증 에이전트가 찾은 것(2026-11-20): 본보기가 넣을 자리 뒤에 있으면 단위 줄·표를 넣는 사이 열쇠가 밀려 병합·칸 모양이 조용히 빠졌고,
// 대기 중인 제안의 like 열쇠는 앞에 문단이 들고 날 때 따라 옮겨지지 않았다
test('like: 본보기가 넣을 자리 뒤에 있어도(단위 줄이 있어도) 병합·칸 모양을 따르고, 대기 제안의 like 는 문단이 밀려도 따라간다', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const src = await addTable(store, service, docId, { rows: ROWS, headerRows: 2, caption: '본보기', merges: MERGES });
  const inner = (doc, caption) => { for (const sec of doc.sections) for (const tb of doc._tableIndex(sec).tables) { if (tb.captionParas.some((p) => doc.text(p.ref, 'final').includes(caption))) return tb; } return null; };
  const look = (tb) => tb.cells.map((c) => `${c.row},${c.col}:${c.attrs.get('borderFillIDRef')}:${c.width}`).sort().join('|');
  for (const [caption, extra] of [['앞에 넣은 표', {}], ['앞에 넣은 단위 표', { unit: '명, %' }]]) {
    const key = (await service.listProposals(docId)).find((x) => x.pid === src.p.pid).tableKey;
    const p = await service.propose(docId, { type: 'table', afterRef: 's1/p2', table: { rows: ROWS, headerRows: 2, caption, like: key, ...extra } }, user, AGENT);
    await service.applyProposal(docId, p.pid, user);
    const doc = await store.doc(docId);
    const made = inner(doc, caption), model = inner(doc, '본보기');
    assert.deepEqual(spans(made), [...MERGES].sort(), `${caption}: 병합`);
    assert.equal(look(made), look(model), `${caption}: 칸 모양·열 폭`);
  }
  // 대기 제안의 like: 만든 뒤 본보기 앞에 문단을 넣어 반영하면 열쇠가 따라 옮겨진다
  const key = (await service.listProposals(docId)).find((x) => x.pid === src.p.pid).tableKey;
  const pend = await service.propose(docId, { type: 'table', afterRef: 's1/p2', table: { rows: ROWS, headerRows: 2, caption: '대기 표', like: key } }, user, AGENT);
  const ins = await service.propose(docId, { type: 'insert', afterRef: 's1/p1', text: '앞에 넣은 문단' }, user, AGENT);
  await service.applyProposal(docId, ins.pid, user);
  const now = (await service.listProposals(docId)).find((x) => x.pid === pend.pid);
  const modelKey = (await service.listProposals(docId)).find((x) => x.pid === src.p.pid).tableKey;
  assert.equal(now.table.like, modelKey, '대기 제안의 like 가 본보기의 새 주소를 따라간다');
  await service.applyProposal(docId, pend.pid, user);
  assert.deepEqual(spans(inner(await store.doc(docId), '대기 표')), [...MERGES].sort());
});

test('merges 가 한 행 전체를 위 행에 합치면(한/글이 그 행을 줄인다) 거절', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  await assert.rejects(service.propose(docId, { type: 'table', afterRef: AFTER, table: { rows: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']], merges: ['r0c0:r1c2'] } }, user, AGENT), /1행 전체를 위 행에 합쳐/);
  // 행마다 칸이 하나라도 시작하면 된다(세로 병합 + 그 행의 다른 칸)
  await service.propose(docId, { type: 'table', afterRef: AFTER, table: { rows: [['a', 'b', 'c'], ['', 'e', 'f'], ['g', 'h', 'i']], merges: ['r0c0:r1c0'] } }, user, AGENT);
});

test('단위 문구는 적은 그대로 — 괄호·"단위:"가 든 글은 그대로, 단위 낱말만이면 (단위: …)', () => {
  assert.equal(normUnit('(base: 봉사활동 참여자, 단위: 명, 회)'), '(base: 봉사활동 참여자, 단위: 명, 회)');
  assert.equal(normUnit('base: 봉사활동 참여자, 단위: 명, 회'), '(base: 봉사활동 참여자, 단위: 명, 회)');
  assert.equal(normUnit('단위: 명'), '(단위: 명)');
  assert.equal(normUnit('명, %'), '(단위: 명, %)');
});

test('편집기에서 대기 표의 칸 글만 고쳐도 병합·본보기는 남는다(크기가 바뀌면 병합만 뺀다)', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const p = await service.propose(docId, { type: 'table', afterRef: AFTER, table: { rows: ROWS, merges: MERGES } }, user, AGENT);
  const kept = await service.patchProposal(docId, p.pid, { table: { rows: ROWS.map((r) => r.map((c) => (c === '211' ? '210' : c))) } }, user);
  const now1 = (await service.listProposals(docId)).find((x) => x.pid === p.pid);
  assert.deepEqual(now1.table.merges, MERGES, JSON.stringify(kept).slice(0, 200));
  await service.patchProposal(docId, p.pid, { table: { rows: [['가', '나'], ['1', '2']] } }, user);
  const now2 = (await service.listProposals(docId)).find((x) => x.pid === p.pid);
  assert.equal(now2.table.merges, undefined, '크기가 바뀌어 맞지 않는 병합은 뺀다');
});

test('prepareOps: like 가 없으면 오류, 크기 같음/다름을 notes 로 알린다 · merges·like 가 제안 입력으로 간다', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const key = doc.tables()[0].key; const tb = doc.tables()[0];
  const sameRows = Array.from({ length: tb.rows }, () => Array.from({ length: tb.cols }, () => 'x'));
  const ok = prepareOps(doc, parseOps([{ op: 'table', after: AFTER, rows: sameRows, like: key, merges: ['r0c0:r0c1'] }]).ok);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.notes[0].note, /크기가 같아 칸마다 그 표의 모양·열 폭을 따른다/);
  const input = ok.steps[0].items[0].input.table; assert.equal(input.like, key); assert.deepEqual(input.merges, ['r0c0:r0c1']);
  const other = prepareOps(doc, parseOps([{ op: 'table', after: AFTER, rows: [['a', 'b']], like: key }]).ok);
  assert.match(other.notes[0].note, /크기가 달라.*행 종류별 모양만 따른다 — 병합은 merges 로 준다/);
  const bad = prepareOps(doc, parseOps([{ op: 'table', after: AFTER, rows: [['a']], like: 's9/p9#t0' }]).ok);
  assert.match(bad.errors[0].error, /like 의 표를 찾지 못했습니다/);
});

test('안내: v3 는 merges·like·단위 자리 판단을 싣고 절대 문구가 없다, v2 는 그대로', () => {
  const line = (s) => s.split('\n').find((l) => l.includes("op:'table'"));
  assert.match(line(opsBrief('v3')), /merges\?:\['r0c0:r0c5'/); assert.match(line(opsBrief('v3')), /like\?/);
  assert.match(line(opsBrief('v3')), /문서의 기존 표를 보고 정한다/);
  assert.doesNotMatch(line(opsBrief('v3')), /insert 로 따로 넣지 않는다/);
  assert.equal(opsBrief('v2'), OPS_BRIEF); assert.doesNotMatch(line(OPS_BRIEF), /merges|like/);
  assert.match(opsGuide('ops', 'v3'), /like:'s0\/p3#t0'/); assert.doesNotMatch(line(opsGuide('ops', 'v2')), /like/);
  assert.match(taskEditorInstructions('v3'), /새 표의 단위·주석·병합은 문서의 기존 표를 따르고/);
  assert.ok(taskEditorInstructions('v2').includes('표의 단위·주석은 table의 unit·notes,'));
});
