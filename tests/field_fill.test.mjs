// 누름틀(CLICK_HERE) 채우기 — 편집기 엔진과 AI 도구의 결과 맞추기(2026-11-12, research/edit-preservation-20261112/range).
//  · 엔진(engine/fields.js): 목록·안내문 자리 글·고르기 실패(없음·여럿)
//  · 동등성: 같은 seed 에 같은 값을 (a) 편집기 엔진 WASM(rhwp setFieldValue) (b) 서버 엔진 변경 추적 채우기 → 모두 수락 으로 넣고 견준다
//  · 임시 서버 MCP: list_fields → propose_fill_fields(실패 항목 포함) → 사람이 반영 → 파일 → 견줌, 되돌리기, lean 영수증
// seed tests/fixtures/field_fill_seed.hwpx = 편집기 엔진으로 누름틀 4칸(안내문만·값 있음·같은 이름 둘)을 넣고 한/글 2022(12.0.0.3146)가 다시 저장한 문서.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';
import { listFields, pickField, fillFieldTracked, expandFieldFill } from '../engine/fields.js';
import { startServer, uploadDoc, fixture, root } from './helpers/server.mjs';

const SEED = fixture('field_fill_seed.hwpx');
const VALUES = [['신청인', 0, '홍길동'], ['소속', 0, '기획처'], ['날짜', 0, '2026-11-12'], ['날짜', 1, '11월']];

/** 견줄 꼴: 문단 최종본 글, 누름틀(이름·차례·값·dirty·값 글자 모양) — 변경 추적 표식은 모두 수락한 뒤 */
export function fieldView(doc) {
  const fields = listFields(doc).map((f) => {
    const { sec, p } = doc.resolve(f.ref);
    const a = Section_fieldBegin(p, f.id);
    const fc = visible(p);
    const shapes = [...new Set(fc.slice(f.start, f.end).map((c) => c.run?.charPr ?? '?'))];
    return { name: f.name, occurrence: f.occurrence, ref: f.ref, value: f.value, isGuide: f.isGuide, dirty: a?.innerAttrs?.get('dirty') ?? null, charPr: shapes, inSec: sec.index };
  });
  return { paragraphs: doc.paragraphs({ nested: true }).map((p) => [p.ref, p.text]), fields };
}
let Section;
const visible = (p) => Section.visibleChars(p, 'final');
const Section_fieldBegin = (p, id) => Section.fieldCtrls(p).find((a) => a.inner === 'hp:fieldBegin' && a.innerAttrs?.get('id') === id);

async function loadWasm() {
  const pkg = path.join(root, 'vendor/rhwp/pkg');
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
  mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) });
  return mod;
}

/** (a) 편집기 엔진 경로: 이름·차례 → rhwp 필드 목록의 fieldId → setFieldValue → exportHwpx */
async function editorFill(bytes, values) {
  const mod = await loadWasm();
  const d = new mod.HwpDocument(new Uint8Array(bytes));
  const list = JSON.parse(d.getFieldList());
  for (const [name, occ, value] of values) {
    const f = list.filter((x) => x.name === name)[occ];
    assert.ok(f, `편집기 엔진 필드 ${name}[${occ}]`);
    const r = JSON.parse(d.setFieldValue(f.fieldId, value));
    assert.equal(r.ok, true);
  }
  return HwpxDoc.load(Buffer.from(d.exportHwpx()));
}

test.before(async () => { ({ Section } = await import('../engine/section.js')); });

test('엔진: 누름틀 목록 — 안내문 자리 글은 빈 값, 같은 이름은 차례, 메모와 섞지 않음', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(SEED));
  const list = listFields(doc);
  assert.deepEqual(list.map((f) => [f.name, f.occurrence, f.total, f.ref, f.value, f.isGuide]), [
    ['신청인', 0, 1, 's0/p0', '', true], ['소속', 0, 1, 's0/p1', '대학혁신센터', false], ['날짜', 0, 2, 's0/p2', '', false], ['날짜', 1, 2, 's0/p2', '', true]]);
  assert.equal(list[0].guide, '이름을 쓰세요');
  assert.equal(doc.memos().length, 0);
  assert.equal(pickField(doc, { name: '날짜' }).id, list[2].id, '차례 없이 고르면 첫 칸(한/글 GetFieldText("날짜") = 첫 칸 값)');
  assert.throws(() => pickField(doc, { name: '날짜', occurrence: 2 }), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => pickField(doc, { name: '없는칸' }), (e) => e.code === 'NOT_FOUND');
  assert.equal(pickField(doc, { name: '날짜', occurrence: 1 }).id, list[3].id);
});

test('동등성: 편집기 엔진(WASM setFieldValue)과 서버 엔진 변경 추적 채우기 → 모두 수락이 같은 결과', { timeout: 60000 }, async () => {
  const bytes = fs.readFileSync(SEED);
  const editor = await editorFill(bytes, VALUES);
  const server = await HwpxDoc.load(bytes);
  for (const [name, occ, value] of VALUES) {
    const f = listFields(server).filter((x) => x.name === name)[occ];
    const r = fillFieldTracked(server, f.ref, f.id, value, { author: '시험' });
    assert.ok(r.changeIds.length >= 1);
  }
  assert.ok(server.changes().length > 0, '변경 추적으로 남는다');
  const tracked = fieldView(server);
  assert.deepEqual(tracked.fields.map((f) => f.value), VALUES.map((v) => v[2]), '최종본에서 값이 칸 안에 보인다');
  server.acceptAll({ tolerant: true });
  assert.deepEqual(fieldView(server), fieldView(editor));
});

test('엔진: 빈 누름틀은 칸 안에 넣는다(최종본 자리로 넣으면 칸 밖) · 줄바꿈 거절', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(SEED));
  const f = listFields(doc).find((x) => x.name === '날짜' && x.occurrence === 0);
  fillFieldTracked(doc, f.ref, f.id, '오늘', { author: '시험' });
  assert.equal(listFields(doc).find((x) => x.id === f.id).value, '오늘');
  const plain = await HwpxDoc.load(fs.readFileSync(SEED));
  plain.insertTracked(f.ref, f.start, '오늘', { author: '시험' });
  assert.equal(listFields(plain).find((x) => x.id === f.id).value, '', '예전 바꿈 제안(빈 글 자리 넣기)은 칸 밖에 들어갔다');
  assert.throws(() => fillFieldTracked(doc, f.ref, f.id, '한 줄\n두 줄', { author: '시험' }), (e) => e.code === 'BAD_VALUE');
});

for (const mode of ['realtime-tracked', 'realtime-final']) test(`임시 서버 MCP(${mode}): list_fields → propose_fill_fields → 사람이 반영 → 편집기 엔진과 같은 문서, 되돌리기, lean 영수증`, { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const clients = [];
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, SEED);
    const route = `/api/docs/${doc.id}`;
    // realtime-tracked = 실시간 '변경 추적으로'(반영하면 변경 추적), realtime-final = 새 문서 기본(실시간 '고친 글만' — 반영하면 바로 최종 글, 되돌리기는 글로)
    if (mode === 'realtime-tracked') await api(`${route}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
    const connect = async (lean = false) => {
      const client = new Client({ name: 'field-fill-test', version: 'test' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${lean ? '?lean=1' : ''}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
      return (tool, args) => client.callTool({ name: tool, arguments: args });
    };
    const call = await connect();
    const read = (r) => { assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };
    const fields = read(await call('list_fields', { doc_id: doc.id }));
    assert.equal(fields.length, 4);
    assert.ok(!('id' in fields[0]), '내부 필드 id 는 싣지 않는다');
    const res = read(await call('propose_fill_fields', { doc_id: doc.id, fields: [
      { name: '신청인', value: '홍길동' }, { name: '소속', value: '기획처' },
      { name: '날짜{{2}}', value: '모름' }, { name: '없는칸', value: 'x' }, { name: '소속', value: '대학혁신센터' },
      { name: '날짜', occurrence: 0, value: '2026-11-12' }, { name: '날짜', occurrence: 1, value: '11월' }] }));
    assert.deepEqual(res.map((x) => x.ok), [true, true, false, false, false, true, true]);
    assert.match(res[2].error, /2번째.*없습니다/, '차례 넘침 = 그 항목만 실패(한/글 PutFieldText 는 아무것도 바꾸지 않는다)');
    assert.match(res[3].error, /없습니다/);
    assert.match(res[4].error, /이미 그 값/);
    const made = res.filter((x) => x.ok).map((x) => x.proposal);
    assert.ok(made.every((p) => p.type === 'replace' && p.field?.name), '바꿈 제안(field 표시) — 카드는 예전 바꿈 제안 꼴');
    assert.deepEqual(made.map((p) => [p.ref, p.find, p.replace]), [['s0/p0', '이름을 쓰세요', '홍길동'], ['s0/p1', '대학혁신센터', '기획처'], ['s0/p2', '', '2026-11-12'], ['s0/p2', '날짜', '11월']]);
    for (const p of made) { const r = await api.res(`${route}/proposals/${p.pid}/apply`, { method: 'POST' }); assert.ok(r.ok, JSON.stringify(r.data)); }
    const changes = await api(`${route}/changes`);
    if (mode === 'realtime-tracked') assert.ok(changes.length >= 4, `변경 추적으로 반영(${changes.length})`);
    else assert.equal(changes.length, 0, '고친 글만: 바로 최종 글');
    const saved = await HwpxDoc.load(await api(`${route}/file`));
    saved.acceptAll({ tolerant: true });
    const editor = await editorFill(fs.readFileSync(SEED), VALUES);
    assert.deepEqual(fieldView(saved), fieldView(editor), 'MCP 제안 → 반영 → (모두 수락) = 편집기 엔진 채우기');

    // 되돌리기: 안내문 자리 칸(신청인)은 안내문이 돌아오고 dirty 도 0 — 다시 빈 칸으로 읽힌다. 빈 칸(날짜[0])은 다시 빈 칸
    for (const p of [made[0], made[2]]) { const u = await api.res(`${route}/proposals/${p.pid}/undo`, { method: 'POST' }); assert.ok(u.ok, JSON.stringify(u.data)); }
    const after = read(await call('list_fields', { doc_id: doc.id }));
    assert.deepEqual(after.map((f) => [f.name, f.value, f.isGuide]), [['신청인', '', true], ['소속', '기획처', false], ['날짜', '', false], ['날짜', '11월', false]]);

    // lean 연결: 같은 도구, 영수증 꼴
    const lean = await connect(true);
    const rr = read(await lean('propose_fill_fields', { doc_id: doc.id, fields: [{ name: '신청인', value: '김철수' }, { name: '없는칸', value: 'x' }] }));
    assert.ok(Array.isArray(rr.results) && rr.results.length === 2 && rr.results[0].ok === true && rr.results[1].ok === false, JSON.stringify(rr));
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await srv.stop();
  }
});

// GPT 검토 지적(2026-11-12) 회귀: P1 오래된 채우기 제안이 사람이 그새 넣은 값을 덮어씀 · P2 '고친 글만'에서 비운 칸을 되돌리면 원래 값이 칸 밖에 돌아옴
for (const track of ['final', 'tracked']) test(`검토 회귀(${track}): 그새 바뀐 칸에 오래된 채우기 제안은 STALE, 비운 칸 되돌리기는 칸 안으로`, { timeout: 120000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const client = new Client({ name: 'field-fill-review', version: 'test' });
  try {
    const api = srv.api('a');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const call = async (tool, args) => { const r = await client.callTool({ name: tool, arguments: args }); assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };
    const open = async () => { const doc = await uploadDoc(srv.base, srv.tokens.a, SEED); await api(`/api/docs/${doc.id}/settings`, { method: 'PATCH', body: { track } }); return doc; };
    const field = async (id, name) => (await call('list_fields', { doc_id: id })).find((x) => x.name === name);
    // P1
    const d1 = await open(); const r1 = `/api/docs/${d1.id}`;
    const [fill] = await call('propose_fill_fields', { doc_id: d1.id, fields: [{ name: '소속', value: 'proposal' }] });
    const [human] = await call('propose_changes', { doc_id: d1.id, proposals: [{ ref: 's0/p1', find: '대학혁신센터', replace: 'person' }] });
    assert.ok((await api.res(`${r1}/proposals/${human.proposal.pid}/apply`, { method: 'POST' })).ok);
    const stale = await api.res(`${r1}/proposals/${fill.proposal.pid}/apply`, { method: 'POST' });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.error, 'STALE');
    assert.equal((await field(d1.id, '소속')).value, 'person', '사람이 넣은 값이 남는다');
    // P2
    const d2 = await open(); const r2 = `/api/docs/${d2.id}`;
    const [clear] = await call('propose_fill_fields', { doc_id: d2.id, fields: [{ name: '소속', value: '' }] });
    assert.ok((await api.res(`${r2}/proposals/${clear.proposal.pid}/apply`, { method: 'POST' })).ok);
    assert.equal((await field(d2.id, '소속')).value, '');
    const u = await api.res(`${r2}/proposals/${clear.proposal.pid}/undo`, { method: 'POST' });
    assert.ok(u.ok, JSON.stringify(u.data));
    assert.equal((await field(d2.id, '소속')).value, '대학혁신센터', '원래 값이 칸 안으로 돌아온다');
    assert.equal((await api(`${r2}/paragraphs`)).find((p) => p.ref === 's0/p1').text, '가나다라마바사1 소속:대학혁신센터');
  } finally {
    await client.close().catch(() => {});
    await srv.stop();
  }
});

// 한/글 2022(12.0.0.3146) COM 실측(research/edit-preservation-20261112/range/hangul_same_name.md): 같은 이름 누름틀은 만들 수 있고(CreateField·RenameField 거부 없음, 다시 저장해도 이름 유지)
// PutFieldText("이름", 값) 은 같은 이름 칸 **모두**에 넣고, "이름{{n}}"(0부터)은 그 칸만, 차례 넘침·없는 이름은 아무것도 바꾸지 않는다, "" 는 모두 비운다
test('한/글 실측: 같은 이름 누름틀 — 이름만 주면 모든 칸, 이름{{n}} 은 그 칸, 넘침·없는 이름은 바꾸지 않음', { timeout: 120000 }, async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(SEED));
  assert.deepEqual(expandFieldFill(doc, { fieldFill: { name: '날짜', occurrence: null }, replace: 'D' }).map((x) => x.fieldFill.occurrence), [0, 1]);
  assert.deepEqual(expandFieldFill(doc, { fieldFill: { name: '날짜{{1}}', occurrence: null }, replace: 'E' }).map((x) => [x.fieldFill.name, x.fieldFill.occurrence]), [['날짜', 1]]);
  const srv = await startServer({ ai: 'off' });
  const client = new Client({ name: 'field-fill-same-name', version: 'test' });
  try {
    const api = srv.api('a');
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const call = async (tool, args) => { const r = await client.callTool({ name: tool, arguments: args }); assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };
    const d = await uploadDoc(srv.base, srv.tokens.a, SEED); const route = `/api/docs/${d.id}`;
    const fill = async (fields) => {
      const res = await call('propose_fill_fields', { doc_id: d.id, fields });
      for (const x of res.filter((y) => y.ok)) assert.ok((await api.res(`${route}/proposals/${x.proposal.pid}/apply`, { method: 'POST' })).ok);
      return res;
    };
    const values = async () => (await call('list_fields', { doc_id: d.id })).filter((f) => f.name === '날짜').map((f) => f.value);
    const para = async () => (await api(`${route}/paragraphs`)).find((p) => p.ref === 's0/p2').text;
    // 한/글 B: PutFieldText('날짜','D') → 'D가나다라마바사2 날짜:D'
    const r1 = await fill([{ name: '날짜', value: 'D' }]);
    assert.deepEqual(r1.map((x) => [x.ok, x.proposal?.field?.occurrence]), [[true, 0], [true, 1]], '칸마다 제안 하나');
    assert.deepEqual(await values(), ['D', 'D']);
    assert.equal(await para(), 'D가나다라마바사2 날짜:D');
    // 한/글 B: PutFieldText('날짜{{1}}','E') → 'D가나다라마바사2 날짜:E'
    const r2 = await fill([{ name: '날짜{{1}}', value: 'E' }]);
    assert.equal(r2.length, 1);
    assert.equal(await para(), 'D가나다라마바사2 날짜:E');
    // occurrence 인자도 같은 뜻(0부터)
    await fill([{ name: '날짜', occurrence: 0, value: 'F' }]);
    assert.deepEqual(await values(), ['F', 'E']);
    // 한/글 A: '이름{{9}}'·'없는칸' 은 아무것도 바꾸지 않는다(우리는 그 항목을 실패로 알린다)
    const r3 = await fill([{ name: '날짜{{9}}', value: 'x' }, { name: '없는칸', value: 'x' }]);
    assert.deepEqual(r3.map((x) => x.ok), [false, false]);
    assert.deepEqual(await values(), ['F', 'E']);
    // 한/글 C: PutFieldText('날짜','') → 모두 비움
    const r4 = await fill([{ name: '날짜', value: '' }]);
    assert.equal(r4.filter((x) => x.ok).length, 2);
    assert.deepEqual(await values(), ['', '']);
    assert.equal(await para(), '가나다라마바사2 날짜:');
  } finally {
    await client.close().catch(() => {});
    await srv.stop();
  }
});
