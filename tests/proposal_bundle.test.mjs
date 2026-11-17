// node --test tests/proposal_bundle.test.mjs — 묶음 제안(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-11, docs/UI_TERMS.md §9). 모델을 부르지 않는다.
//  · 새 연결 edit 한 번(논문 꼴 ops): op 하나가 여럿으로 풀린 것·같은 after 에 잇단 넣기(insert·table·figure)는 한 묶음, 제안 하나는 묶음 없음,
//    메모가 끊은 뒤의 넣기는 따로, 여러 안(gid)과 섞이지 않음
//  · 묶음 pid 로 resolve apply → 낸 차례로 놓인다(pid 차례 — server/service.js _insertAfterRef)
//  · 일부 반영 뒤 상태(남음) → 나머지 거절 뒤 반영 — 서버 requestOutcome 과 웹 requestProgress 가 같은 셈
//  · 예전 연결 propose_insert(paragraphs): 둘 이상이면 한 묶음, 하나면 묶음 없음(응답 꼴 그대로)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import * as mod from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requestOutcome, requestSummaryResultLine, renderRequestMemo } from '../server/memotext.js';
import { fixture, startServer, uploadDoc } from './helpers/server.mjs';

// 웹 모듈(web/util.js)은 '/vendor/vue.esm-browser.prod.js' 를 부른다 — tests/util.test.mjs 처럼 node_modules 의 vue 로 잇는다
const root = fileURLToPath(new URL('..', import.meta.url));
const VUE = pathToFileURL(`${root}/node_modules/vue/dist/vue.esm-browser.prod.js`).href;
const SPEC = '/vendor/vue.esm-browser.prod.js';
if (typeof mod.registerHooks === 'function') mod.registerHooks({ resolve: (s, c, next) => (s === SPEC ? { url: VUE, format: 'module', shortCircuit: true } : next(s, c)) });
else mod.register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) { return s === ${JSON.stringify(SPEC)} ? { url: ${JSON.stringify(VUE)}, format: 'module', shortCircuit: true } : n(s, c); }`)}`);
globalThis.location ??= { hash: '#/', protocol: 'http:', host: 'localhost' };
const { requestProgress, bundleLabel } = await import(pathToFileURL(`${root}/web/util.js`).href);

const user = { name: '묶음 시험', role: 'admin', agentSession: 'sess-b' };
const AGENT = 'claude-code';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120"><rect x="10" y="10" width="280" height="100" fill="#dde"/></svg>';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-bundle-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  doc.acceptAll();
  const bytes = Buffer.from(await doc.save());
  const store = new Store(path.join(dir, 'store'));
  const config = { dataDir: path.join(dir, 'data'), configFile: path.join(dir, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, tutorial: { enabled: false } };
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'bundle.hwpx', bytes, by: user.name, extra: { settings: { editMode: 'realtime', track: 'changes' } } }).id;
  const newRequest = async () => {
    const r = (await service.createRequest(id, { kind: 'instruct', instruction: '묶음 시험', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
    await service.agentTake(user, AGENT, 'sess-b', { docId: id, rid: r.rid });
    return r.rid;
  };
  const meta = () => store.readMeta(id);
  const props = (rid) => meta().proposals.filter((p) => p.rid === rid);
  const req = (rid) => meta().requests.find((r) => r.rid === rid);
  return { store, service, id, newRequest, meta, props, req };
}
const bundles = (list) => { const m = new Map(); for (const p of list) if (p.bundle != null) { if (!m.has(p.bundle)) m.set(p.bundle, []); m.get(p.bundle).push(p); } return [...m.values()]; };

test('새 연결 edit: 논문 꼴 ops — 넣기 잇달음은 한 묶음, op 하나의 여럿은 한 묶음, 하나·메모 뒤·여러 안은 따로; 묶음 pid 로 반영하면 낸 차례', { timeout: 120000 }, async (t) => {
  const s = await setup(t);
  const rid = await s.newRequest();
  const doc0 = await s.store.doc(s.id);
  const p1 = doc0.text('s0/p1', 'final');
  assert.ok(p1.length >= 2, '시험 문서의 둘째 문단에 글이 있어야 한다');
  const ops = [
    { op: 'replace', at: 's0/p1', find: p1.slice(0, 2), with: '바꾼' },                                    // 0: 하나 → 묶음 없음
    { op: 'insert', after: 's0/p0', paragraphs: [{ text: '묶음 첫째' }, { text: '묶음 둘째' }, { text: '묶음 셋째' }] },   // 1 ┐
    { op: 'table', after: 's0/p0', rows: [['가', '나'], ['1', '2']], caption: '묶음 표' },                   // 2 │ 같은 after 의 넣기 잇달음 = 묶음 A
    { op: 'insert', after: 's0/p0', paragraphs: [{ text: '묶음 넷째' }, { text: '묶음 다섯째' }] },          // 3 │
    { op: 'figure', after: 's0/p0', svg: SVG, caption: '묶음 그림' },                                       // 4 ┘
    { op: 'memo', at: 's0/p0', text: '메모가 넣기 잇달음을 끊는다' },                                          // 5
    { op: 'insert', after: 's0/p0', text: '메모 뒤 하나' },                                                  // 6: 하나 → 묶음 없음
    { op: 'format', at: ['s0/p0', 's0/p2'], char: { bold: true } },                                         // 7: op 하나가 둘 = 묶음 B
    { op: 'alternatives', at: 's0/p2', find: doc0.text('s0/p2', 'final').slice(0, 2), options: [{ text: '안하나' }, { text: '안둘' }] },   // 8: 여러 안(gid)
  ];
  const out = await s.service.agentEdit(s.id, { ops, rid }, user, AGENT);
  assert.ok(!out.failed?.length, JSON.stringify(out.failed));
  const list = s.props(rid);
  const bs = bundles(list);
  assert.equal(bs.length, 2, `묶음 둘(넣기 잇달음·서식 목록): ${JSON.stringify(list.map((p) => [p.pid, p.type, p.bundle ?? null, p.gid ?? null]))}`);
  const [A, B] = bs.sort((x, y) => y.length - x.length);
  assert.deepEqual(A.map((p) => p.type), ['insert', 'insert', 'insert', 'table', 'insert', 'insert', 'figure'], '묶음 A = 낸 차례');
  assert.deepEqual(B.map((p) => p.type), ['format', 'format']);
  assert.notEqual(A[0].bundle, B[0].bundle);
  // 하나뿐인 것·메모 뒤 넣기·여러 안은 묶음 없음, 여러 안은 gid 만
  const lone = list.filter((p) => p.bundle == null);
  assert.deepEqual(lone.map((p) => p.type).sort(), ['insert', 'replace', 'replace', 'replace'].sort());
  assert.ok(list.filter((p) => p.gid != null).length === 2 && list.every((p) => !(p.gid != null && p.bundle != null)), '여러 안과 묶음이 섞이지 않는다');
  assert.equal(bundleLabel(A), '새 문단 5 · 표 1 · 그림 1 넣기');
  assert.equal(bundleLabel(B), '서식 2곳');

  // 셈: 항목 = 바꿈 1 + 묶음 A + 메모 뒤 넣기 1 + 묶음 B + 여러 안 1 = 5(제안은 13건)
  const o = requestOutcome(s.req(rid), list);
  assert.equal(list.length, 13);
  assert.equal(o.items, 5); assert.equal(o.open, 5);
  const g = requestProgress(s.req(rid), list);
  assert.equal(g.items, 5); assert.equal(g.open, 5); assert.equal(g.openAlt, 1);
  assert.deepEqual(g.openPids, o.openPids.filter((pid) => list.find((p) => p.pid === pid).gid == null), '웹 openPids = 서버 openPids 에서 여러 안 뺀 것');
  assert.equal(g.tables, 2, '표·그림 구성원(제안 수)');
  assert.equal(g.adoptOpen, 4, '수정본에 넣을 것이 있는 남은 항목: 바꿈·묶음 A·메모 뒤 넣기·묶음 B');
  const entryA = g.entries.find((it) => it.bundle === A[0].bundle);
  assert.deepEqual(entryA.open, A.map((p) => p.pid));

  // 묶음 A 의 pid 로만 반영(실시간 [반영] = resolve apply) → 낸 차례로 놓이고 다른 제안은 그대로
  const res = await s.service.resolveRequest(s.id, rid, { apply: A.map((p) => p.pid) }, user);
  assert.equal(res.counts.failed, 0, JSON.stringify(res.results));
  assert.equal(res.counts.applied, 7);
  const doc1 = await s.store.doc(s.id);
  const paras = doc1.sections[0].bodyParas.map((p) => doc1.text(p.ref, 'final'));
  const at = (w) => paras.findIndex((x) => x.includes(w));
  const order = ['묶음 첫째', '묶음 둘째', '묶음 셋째', '묶음 넷째', '묶음 다섯째'].map(at);
  assert.ok(order.every((i) => i > 0), JSON.stringify(paras.slice(0, 14)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `낸 차례: ${JSON.stringify(paras.slice(0, 14))}`);
  // 표 문단은 셋째 바로 뒤(넷째 앞), 그림 문단은 다섯째 바로 뒤(캡션은 개체 안 문단이라 본문 글에 없다)
  const refs = doc1.sections[0].bodyParas.map((p) => p.ref);
  const kinds = (i) => doc1.ownObjects(refs[i]).map((o) => o.kind);
  assert.equal(order[3], order[2] + 2, `표 자리: ${JSON.stringify(paras.slice(0, 10))}`);
  assert.ok(kinds(order[2] + 1).includes('table'), `표 문단의 개체: ${kinds(order[2] + 1)}`);
  assert.ok(kinds(order[4] + 1).length > 0 && !kinds(order[4] + 1).includes('table'), `그림 문단의 개체: ${kinds(order[4] + 1)}`);
  const after = s.props(rid);
  assert.ok(after.filter((p) => p.bundle === A[0].bundle).every((p) => p.status === 'applied'));
  assert.ok(after.filter((p) => p.bundle !== A[0].bundle).every((p) => p.status === 'pending'), '다른 제안은 그대로');
  const o2 = requestOutcome(s.req(rid), after);
  assert.equal(o2.accepted, 1); assert.equal(o2.open, 4);

  // 묶음 B: 하나만 반영 → 남음(일부 반영돼도), 나머지 거절 → 반영
  const [b1, b2] = after.filter((p) => p.bundle === B[0].bundle);
  await s.service.applyProposal(s.id, b1.pid, user);
  let now = s.props(rid);
  const o3 = requestOutcome(s.req(rid), now); const g3 = requestProgress(s.req(rid), now);
  assert.equal(o3.open, 4, '일부 반영된 묶음은 남음'); assert.equal(g3.open, 4);
  assert.ok(o3.openPids.includes(b2.pid) && !o3.openPids.includes(b1.pid));
  assert.deepEqual(g3.entries.find((it) => it.bundle === B[0].bundle).open, [b2.pid]);
  await s.service.resolveRequest(s.id, rid, { reject: [b2.pid] }, user);
  now = s.props(rid);
  const o4 = requestOutcome(s.req(rid), now); const g4 = requestProgress(s.req(rid), now);
  assert.equal(o4.accepted, 2); assert.equal(g4.accepted, 2); assert.equal(o4.open, 3); assert.equal(g4.open, 3);
  assert.equal(o4.items, 5); assert.equal(g4.items, 5);
  // 메모 글: 요약 줄은 항목 수, 자세히 목록은 묶음 한 줄
  assert.equal(requestSummaryResultLine(s.req(rid), now, o4), "결과: 반영 2건 · 의견 1건 · 남은 제안 3건");
  const memo = renderRequestMemo(s.req(rid), now);
  assert.match(memo, /새 문단 5 · 표 1 · 그림 1 넣기: 문단 추가 「묶음 첫째」 외 6건/);
  assert.match(memo, /서식 2곳\(2건 중 1건\): /);
});

test('거둔 제안은 셈에서 빠지고, 구성원 하나만 남은 묶음은 보통 항목', () => {
  const ps = [
    { pid: 1, rid: 1, type: 'insert', status: 'pending', bundle: 'bx', text: '가' },
    { pid: 2, rid: 1, type: 'insert', status: 'withdrawn', bundle: 'bx', text: '나' },
    { pid: 3, rid: 1, type: 'replace', status: 'pending', find: 'a', replace: 'b' },
  ];
  const r = { status: 'done' };
  const o = requestOutcome(r, ps); const g = requestProgress(r, ps);
  assert.equal(o.items, 2); assert.equal(g.items, 2);
  assert.ok(g.entries.every((it) => it.bundle == null), '구성원 하나면 보통 항목');
  assert.deepEqual(o.openPids, [1, 3]); assert.deepEqual(g.openPids, [1, 3]);
  // 거절 + 대기 없음 = 거절, 반영해 둠(수정본) + 대기 없음 = 반영(via adopted)
  const q = [
    { pid: 1, type: 'insert', status: 'rejected', bundle: 'b2' }, { pid: 2, type: 'insert', status: 'rejected', bundle: 'b2' },
    { pid: 3, type: 'insert', status: 'pending', bundle: 'b3', adoptedBy: { 남: { at: 'x' } } }, { pid: 4, type: 'insert', status: 'rejected', bundle: 'b3' },
  ];
  const o2 = requestOutcome(r, q); const g2 = requestProgress(r, q, { me: '나' });
  assert.deepEqual([o2.declined, o2.accepted, o2.open], [1, 1, 0]);
  assert.deepEqual([g2.declined, g2.accepted, g2.open], [1, 1, 0]);
  assert.equal(g2.entries[1].via, 'adopted');
});

test('예전 연결 propose_insert(paragraphs): 둘 이상이면 한 묶음, 하나면 묶음 없음 — 응답 꼴 그대로', { timeout: 120000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  t.after(() => srv.stop());
  const doc = await uploadDoc(srv.base, srv.tokens.admin, fixture('tool_memo_tracked.hwpx'));
  const client = new Client({ name: 'bundle-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.admin}` } } });
  await client.connect(transport);
  t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); });
  const call = async (args) => { const r = await client.callTool({ name: 'propose_insert', arguments: { doc_id: doc.id, after_ref: 's0/p0', ...args } }); assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content[0].text); };
  const many = await call({ paragraphs: [{ text: '옛 첫째' }, { text: '옛 둘째' }, { text: '옛 셋째' }] });
  assert.ok(Array.isArray(many) && many.length === 3 && many.every((x) => x.ok), '응답은 예전처럼 결과 배열');
  const one = await call({ paragraphs: [{ text: '옛 하나' }] });
  const single = await call({ text: '옛 text' });
  const props = await srv.api('admin')(`/api/docs/${doc.id}/proposals`);
  const list = Array.isArray(props) ? props : props.proposals;
  const of = (w) => list.find((p) => p.text === w);
  const b = of('옛 첫째').bundle;
  assert.ok(b && of('옛 둘째').bundle === b && of('옛 셋째').bundle === b, '여러 문단 = 한 묶음');
  assert.equal(of('옛 하나').bundle, undefined); assert.equal(of('옛 text').bundle, undefined);
  assert.ok(one && single);
});

// 2026-11-17(REPORT.md 문제 5 — artifacts/mcp-round3-20261117/codex/REPORT.md X06 '줄이기' 제안 24 = 카드 24): 한 호출 안의 같은 종류 제안은 op 가 달라도 한 묶음
test('같은 종류 묶음: 바꿈끼리·문단 지우기끼리·서식끼리(op 가 달라도, 떨어져 있어도), 넣기·메모는 따로 — 묶음 반영', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-bundle-kind-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const store = new Store(path.join(dir, 'store'));
  const config = { dataDir: path.join(dir, 'data'), configFile: path.join(dir, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, tutorial: { enabled: false }, verify: { pages: false } };
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'report.hwpx', bytes: fs.readFileSync(path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx')), by: user.name, extra: { settings: { editMode: 'realtime', track: 'changes' } } }).id;
  const r = (await service.createRequest(id, { kind: 'instruct', instruction: '줄여 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-b', { docId: id, rid: r.rid });
  const doc0 = await store.doc(id);
  const n0 = doc0.sections[1].bodyParas.length;   // store.doc 은 반영 뒤 바뀔 수 있다 — 지금 수를 적어 둔다
  assert.match(doc0.text('s1/p6', 'final'), /꾸준이/); assert.match(doc0.text('s1/p12', 'final'), /관련이있는가/);
  assert.equal(doc0.text('s1/p7', 'final'), ''); assert.equal(doc0.text('s1/p18', 'final'), '');
  const out = await service.agentEdit(id, { rid: r.rid, ops: [
    { op: 'replace', at: 's1/p6', find: '꾸준이', with: '꾸준히' },                 // 0 ┐ 바꿈 묶음
    { op: 'memo', at: 's1/p5', text: '메모는 묶지 않는다' },                        // 1
    { op: 'replace', at: 's1/p12', find: '관련이있는가', with: '관련이 있는가' },     // 2 ┘
    { op: 'delete_paragraphs', at: 's1/p7' },                                      // 3 ┐ 문단 지우기 묶음
    { op: 'insert', after: 's1/p9', text: '하나뿐인 넣기' },                         // 4   묶음 없음
    { op: 'delete_paragraphs', at: 's1/p18' },                                     // 5 ┘
    { op: 'format', at: 's1/p10', char: { bold: true } },                          // 6 ┐ 서식 묶음(op 둘, 제안 셋)
    { op: 'format', at: ['s1/p11', 's1/p13'], char: { italic: true } },            // 7 ┘
  ] }, user, AGENT);
  assert.ok(!out.failed?.length, JSON.stringify(out));
  const list = store.readMeta(id).proposals.filter((p) => p.rid === r.rid);
  const bs = bundles(list);
  const byType = Object.fromEntries(bs.map((b) => [b[0].type, b]));
  assert.equal(bs.length, 3, JSON.stringify(list.map((p) => [p.pid, p.type, p.bundle ?? null])));
  assert.equal(byType.replace.length, 2); assert.equal(byType.para_delete.length, 2); assert.equal(byType.format.length, 3);
  assert.ok(bs.every((b) => b.every((p) => p.type === b[0].type)), '한 묶음은 한 종류');
  assert.equal(list.find((p) => p.type === 'insert').bundle, undefined, '하나뿐인 넣기는 묶음 없음');
  assert.equal(bundleLabel(byType.replace), '바꿈 2곳');
  assert.equal(bundleLabel(byType.para_delete), '문단 지우기 2곳');
  assert.equal(bundleLabel(byType.format), '서식 3곳');
  const req = store.readMeta(id).requests.find((x) => x.rid === r.rid);
  assert.equal(requestOutcome(req, list).items, 4); assert.equal(requestProgress(req, list).items, 4);
  // 묶음마다 반영(실시간 [반영] = resolve apply 그 묶음 pid) — 실패 0
  for (const b of [byType.replace, byType.format, byType.para_delete]) {
    const res = await service.resolveRequest(id, r.rid, { apply: b.map((p) => p.pid) }, user);
    assert.equal(res.counts.failed, 0, JSON.stringify(res.results));
  }
  assert.ok(store.readMeta(id).proposals.filter((p) => p.bundle != null).every((p) => p.status === 'applied'));
  // 변경 추적 문서라 지운 문단은 추적으로 남는다 — 사본에서 수락한 최종본으로 센다
  const doc1 = await (await HwpxDoc.load(store.currentBytes(id))).flattened(); doc1.acceptAll();
  const all = doc1.sections[1].bodyParas.map((p) => doc1.text(p.ref, 'final')).join('\n');
  assert.ok(all.includes('꾸준히') && all.includes('관련이 있는가') && !all.includes('꾸준이'), '바꿈 반영');
  assert.equal(doc1.sections[1].bodyParas.length, n0 - 2, '빈 문단 둘이 지워졌다');
});
