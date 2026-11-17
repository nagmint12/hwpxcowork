// 쪽 수 어림(server/page-estimate.js — 2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-7·나-9) 시험. 모델을 부르지 않는다.
//  · 빈 문서에 문단 넣기 dry_run → 사본에서 제안을 만들어 반영해 본 쪽 수(pages.now·all_applied), 실제 meta·문서·방송은 그대로
//  · 같은 ops 를 저장 → 영수증의 쪽 수가 dry_run 과 같다, 사람이 [모두 반영]한 뒤의 실제 쪽 수도 같다
//  · 앞선 호출의 대기 제안이 다음 dry_run 의 반영 흉내에 든다 · 한도를 넘기면 '모두 반영하면'이 빠지고 이유 한 줄
//  · read(view='format') 의 범위 판정(표 칸 주소가 범위로 잘못 풀리던 버그 — 2026-11-17 같은 작업)
//  · 조판 작업자 큐: 쪽 수 어림은 기다리는 편집 뒤 검사(V3)보다 먼저, 도는 검사가 오래 걸리면 기다림 한도 뒤 busy(가짜 작업자 — 엔진 없음)
//   node --test tests/page_estimate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { layoutChecker, LayoutChecker } from '../server/layout-check.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLANK = path.join(root, 'server', 'templates', 'blank.hwpx');
// 에이전트 쓰기는 맡은 세션으로(server/mcp.js actor — agentSession)
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const AGENT = 'claude-code';
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-page-estimate-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const sent = [];
  const service = new Service({ store, hub: { broadcast: (...a) => sent.push(a), broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'blank.hwpx', bytes: fs.readFileSync(BLANK), by: user.name }).id;
  return { tmp, store, service, docId, sent };
}
async function request(service, docId, instruction = '본문을 써 줘') {
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction, target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: r.rid });
  return r.rid;
}
// 영수증의 제안 번호들: 같은 op 에서 잇달아 저장된 제안은 한 줄 { op, pids:'12-15', count }(2026-11-17 작업 F — §10.4 나-10)
const pidsOf = (rows) => (rows || []).flatMap((x) => (Number.isInteger(x.pid) ? [x.pid] : String(x.pids || '').split(',').filter(Boolean).flatMap((r) => { const [a, b = a] = r.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, k) => a + k); })));
const para = (i) => ({ text: `${i + 1}번째 문단입니다. 쪽 수를 미리 알기 위한 시험 글을 길게 씁니다. `.repeat(6) });
const paras = (n, from = 0) => Array.from({ length: n }, (_, i) => para(from + i));
const reqStatus = (store, docId, rid) => store.readMeta(docId).requests.find((r) => r.rid === rid)?.status;
/** 실제 상태 지문: meta(제안·요청·버전)·문서 파일 */
const state = (store, docId) => {
  const meta = store.readMeta(docId);
  return { version: meta.version, proposals: JSON.stringify(meta.proposals), requests: JSON.stringify(meta.requests), file: hash(path.join(store.dir, docId, 'current.hwpx')) };
};

test('dry_run: 사본에서 문단을 넣어 본 쪽 수 — 실제 meta·문서·방송은 그대로, 저장한 영수증·실제 [모두 반영] 뒤 쪽 수와 같다', { timeout: 120000 }, async (t) => {
  const { store, service, docId, sent } = setup(t);
  const rid = await request(service, docId);
  const ops = [{ op: 'insert', after: 's0/p0', paragraphs: paras(40) }];
  const before = state(store, docId); const sentBefore = sent.length;
  const dry = await service.agentEdit(docId, { ops, rid, dryRun: true }, user, AGENT);
  assert.equal(dry.dry_run, true);
  assert.ok(dry.made >= 1, JSON.stringify(dry).slice(0, 400));
  assert.ok(!dry.failed, JSON.stringify(dry.failed));
  assert.ok(!dry.pages.skipped, dry.pages.skipped);
  assert.equal(dry.pages.now, 1);
  assert.ok(dry.pages.all_applied > 1, JSON.stringify(dry.pages));
  assert.ok(dry.pages.last_page_fill > 0 && dry.pages.last_page_fill <= 1, JSON.stringify(dry.pages));
  assert.match(dry.pages.basis, /어림/);
  assert.match(dry.note, /사본에서 제안/);
  // 실제 상태는 그대로(제안·요청·버전·문서 파일), 방송 없음
  assert.deepEqual(state(store, docId), before);
  assert.equal(sent.length, sentBefore);

  // 저장: 영수증의 쪽 수 = dry_run 의 쪽 수
  const saved = await service.agentEdit(docId, { ops, rid }, user, AGENT);
  assert.ok(pidsOf(saved.saved).length >= 1 && !saved.failed, JSON.stringify(saved).slice(0, 400));
  assert.equal(saved.pages.now, 1);
  assert.equal(saved.pages.all_applied, dry.pages.all_applied);
  assert.equal(saved.pages.pending, pidsOf(saved.saved).length);

  // 앞선 호출의 대기 제안이 다음 dry_run 반영 흉내에 든다
  const more = await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', paragraphs: paras(40, 40) }], rid, dryRun: true }, user, AGENT);
  assert.equal(more.pages.pending, pidsOf(saved.saved).length + more.made);
  assert.ok(more.pages.all_applied > saved.pages.all_applied, JSON.stringify(more.pages));

  // read(view='page'): 지금 쪽 수, id=요청 번호면 모두 반영하면
  const page = JSON.parse((await service.agentRead(docId, { view: 'page', item: String(rid) }, user)).text);
  assert.equal(page.pages.now, 1); assert.equal(page.pages.all_applied, dry.pages.all_applied);
  assert.equal(JSON.parse((await service.agentRead(docId, { view: 'page' }, user)).text).pages.all_applied, undefined);

  // 사람이 [모두 반영] → 실제 쪽 수가 흉내와 같다
  const done = await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  assert.equal(done.counts.failed, 0); assert.equal(done.counts.applied, pidsOf(saved.saved).length);
  const real = JSON.parse((await service.agentRead(docId, { view: 'page' }, user)).text).pages;
  assert.equal(real.now, dry.pages.all_applied);
  await layoutChecker().drain();
});

test('한도: 문서가 한도보다 크면 반영 흉내를 하지 않고 이유 한 줄 — 지금 쪽 수는 그대로, dry_run 은 예전 안내', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  service.cfg.verify = { pages: { maxChars: 10 } };
  const dry = await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', paragraphs: paras(3) }], rid, dryRun: true }, user, AGENT);
  assert.equal(dry.made, undefined);
  assert.match(dry.note, /검사는 통과/);
  assert.equal(dry.pages.now, 1); assert.equal(dry.pages.all_applied, undefined);
  assert.match(dry.pages.note, /커서.*반영 흉내를 하지 않았다/);
  // 대기 제안 수 한도
  service.cfg.verify = { pages: { maxPending: 1 } };
  const saved = await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', paragraphs: paras(3) }], rid }, user, AGENT);
  assert.equal(pidsOf(saved.saved).length, 3); assert.equal(saved.saved.length, 1); assert.equal(saved.saved[0].count, 3);   // 한 op 의 문단 셋 = 영수증 한 줄
  assert.match(saved.pages.note, /대기 제안이 많아/); assert.equal(saved.pages.all_applied, undefined);
  // 끄기
  service.cfg.verify = { pages: false };
  const off = await service.agentEdit(docId, { ops: [{ op: 'memo', at: 's0/p0', text: '확인' }], rid }, user, AGENT);
  assert.match(off.pages.skipped, /꺼져/);
  await layoutChecker().drain();
});

test('dry_run: 저장해도 실패할 op 와 반영에서 실패할 제안을 알려 준다', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const dry = await service.agentEdit(docId, { ops: [
    { op: 'insert', after: 's0/p0', paragraphs: paras(2) },
    { op: 'replace', at: 's0/p0', find: '문서에 없는 글', with: '가' },
    { op: 'memo', at: 's0/p0', text: '메모는 만들어 보지 않는다' },
  ], rid, dryRun: true }, user, AGENT);
  assert.deepEqual(dry.failed.map((x) => x.op), [1]);
  assert.match(dry.failed[0].error, /찾지 못했습니다/);
  assert.equal(dry.made, 2);
  assert.equal(dry.pages.pending, 2);
  await layoutChecker().drain();
});

// 2026-11-17(작업 I — 갈래 B·C·D·F 맞추기): 새 op(문단 지우기·옮기기·일괄 바꾸기·거두기·표 단위·주석·차트 캡션)도 반영 흉내에 든다 —
// skipped_ops 가 비고, 문단을 지우는 dry_run 이면 '모두 반영하면' 쪽 수가 지금보다 준다. 실제로 저장해 [모두 반영]한 쪽 수도 같다
test('dry_run: 새 op(delete_paragraphs·move_paragraphs·replace_all·withdraw·table unit·notes·chart caption)도 쪽 수를 어림한다', { timeout: 180000 }, async (t) => {
  const { store, service, docId } = setup(t);
  // 준비: 문단 60개를 넣어 반영(여러 쪽 문서)
  const r0 = await request(service, docId, '준비');
  await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', paragraphs: paras(60) }], rid: r0, done: '준비' }, user, AGENT);
  assert.equal((await service.resolveRequest(docId, r0, { apply: 'rest' }, user)).counts.failed, 0);
  const rid = await request(service, docId, '줄여 줘');
  // 거둘 대기 제안 하나(같은 요청·같은 작성자)
  const first = await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p60', paragraphs: paras(5, 100) }], rid }, user, AGENT);
  const pulled = pidsOf(first.saved);
  assert.equal(pulled.length, 5);
  const ops = [
    { op: 'withdraw', pids: pulled },
    { op: 'delete_paragraphs', at: 's0/p1..p40' },
    { op: 'move_paragraphs', at: 's0/p41..p42', after: 's0/p50' },
    { op: 'replace_all', find: '시험 글', with: '보기 글', at: 's0/p55..p58' },
    { op: 'table', after: 's0/p59', rows: [['구분', '값'], ['가', '1']], caption: '시험 표', unit: '명', notes: ['주: 가상 자료.'] },
    { op: 'chart', after: 's0/p60', chart: { type: 'bar', categories: ['가', '나'], series: [{ name: '값', values: [1, 2] }] }, caption: '시험 차트' },
  ];
  const before = state(store, docId);
  const dry = await service.agentEdit(docId, { ops, rid, dryRun: true }, user, AGENT);
  assert.ok(!dry.failed, JSON.stringify(dry.failed));
  assert.equal(dry.skipped_ops, undefined, JSON.stringify(dry.skipped_ops));
  assert.ok(!dry.pages.skipped && !dry.pages.apply_failed, JSON.stringify(dry.pages));
  assert.ok(dry.pages.now >= 3, JSON.stringify(dry.pages));
  assert.ok(dry.pages.all_applied < dry.pages.now, `지운 만큼 준다: ${JSON.stringify(dry.pages)}`);
  assert.equal(dry.pages.pending, dry.made, '거둔 제안은 반영 흉내에서 빠진다');
  assert.deepEqual(state(store, docId), before, '실제 상태는 그대로');
  // 저장 → [모두 반영]: 실제 쪽 수 = 흉내
  const saved = await service.agentEdit(docId, { ops, rid }, user, AGENT);
  assert.ok(!saved.failed, JSON.stringify(saved).slice(0, 400));
  assert.equal(saved.pages.all_applied, dry.pages.all_applied);
  const done = await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  assert.equal(done.counts.failed, 0, JSON.stringify(done.counts));
  assert.equal(JSON.parse((await service.agentRead(docId, { view: 'page' }, user)).text).pages.now, dry.pages.all_applied);
  await layoutChecker().drain();
});

test('read(view=format): 표 칸 주소는 그 칸 그대로, 범위·구역만 본문 문단으로 푼다', { timeout: 60000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const saved = await service.agentEdit(docId, { ops: [{ op: 'table', after: 's0/p0', rows: [['구분', '값'], ['가', '1']], caption: '시험 표' }], rid }, user, AGENT);
  await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  const doc = await service.store.doc(docId);
  const tb = doc.tables()[0]; const cell = tb.cells.find((c) => c.row === 1 && c.col === 1).refs[0];
  assert.match(cell, /^s0\/p\d+\/n\d+/, `표 칸 주소: ${cell} (${saved.saved.length})`);
  const one = JSON.parse((await service.agentRead(docId, { view: 'format', at: cell }, user)).text);
  assert.deepEqual(one.paragraphs.map((p) => p.ref), [cell]);
  assert.equal(one.paragraphs[0].text, '1');
  const range = JSON.parse((await service.agentRead(docId, { view: 'format', at: 's0/p0..p1' }, user)).text);
  assert.deepEqual(range.paragraphs.map((p) => p.ref), ['s0/p0', 's0/p1']);
  const sec = JSON.parse((await service.agentRead(docId, { view: 'format', at: 's0' }, user)).text);
  assert.ok(sec.paragraphs.length >= 2 && sec.paragraphs.every((p) => /^s0\/p\d+$/.test(p.ref)));
  await layoutChecker().drain();
});

test('조판 작업자 큐: 쪽 수 어림은 기다리는 편집 뒤 검사보다 먼저 돌고, 도는 검사가 길면 기다림 한도 뒤 busy', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-page-estimate-q-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  // 가짜 작업자: 검사는 delay ms 뒤, 쪽 수 어림은 바로 답한다 — 받은 차례를 결과에 싣는다
  const workerFile = path.join(tmp, 'fake-worker.mjs');
  fs.writeFileSync(workerFile, [
    "import { parentPort } from 'node:worker_threads';",
    'let seq = 0;',
    "parentPort.on('message', (m) => {",
    '  const order = ++seq;',
    "  if (m.kind === 'pages') return parentPort.postMessage({ job: m.job, ok: true, order, results: m.docs.map(() => ({ pages: 3, sections: [3], lastFill: 0.5 })) });",
    "  setTimeout(() => parentPort.postMessage({ job: m.job, ok: true, order, before: { pages: 1 }, after: { pages: 1 }, changedPages: [], refPages: [], overflow: [], ms: 1 }), Number(m.id.split(':')[1]));",
    '});',
  ].join('\n'));
  const file = path.join(tmp, 'v.hwpx'); fs.writeFileSync(file, 'x');
  const lc = new LayoutChecker({ workerFile, pkgDir: tmp });
  t.after(() => lc.stop());
  const got = [];
  const check = (key, delay) => lc.enqueue({ key: `${key}:${delay}`, id: key, file, beforeFile: file, version: 2, beforeVersion: 1, deliver: (r) => got.push([key, r.order]) });
  check('a', 300); check('b', 10);
  await new Promise((r) => setTimeout(r, 50));   // 'a' 가 돌기 시작한 뒤
  const est = await lc.estimate([{ bytes: new Uint8Array([1]) }]);
  assert.equal(est.ok, true); assert.equal(est.results[0].pages, 3);
  await lc.drain();
  // 'a' 는 이미 돌고 있었고(끊지 않음), 쪽 수 어림이 기다리던 'b' 보다 먼저
  assert.deepEqual(got, [['a', 1], ['b', 3]]); assert.equal(est.order, 2);
  // 도는 검사가 기다림 한도보다 길면 busy(줄에서 빠진다 — 뒤에 작업자에게 가지 않는다)
  check('c', 600);
  await new Promise((r) => setTimeout(r, 50));
  const busy = await lc.estimate([{ bytes: new Uint8Array([1]) }], { waitMs: 100 });
  assert.deepEqual(busy, { ok: false, reason: 'busy' });
  await lc.drain();
  assert.equal(lc.estStats.busy, 1); assert.equal(lc.estStats.done, 1);
});

// 2026-11-17(artifacts/mcp-round3-20261117/codex/REPORT.md 문제 1): [모두 반영]하면 실패할 제안이 있으면 done 이 있어도 완료하지 않는다 —
// X02 는 영수증 pages.apply_failed 가 실패를 알렸는데 같은 호출의 done 으로 완료돼 고칠 길(withdraw·다시 내기)이 REQUEST_CLOSED 로 막혔다.
// 확실한 충돌: 같은 글을 서로 다르게 바꾸는 두 replace(둘째는 반영할 때 STALE)
test('완료 막기: 반영하면 실패할 제안 + done → completed:false·요청은 처리 중·apply_failed 는 맨 위 칸, 거두고 다시 done → 완료', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId, '고쳐 줘');
  await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', text: '바꿀 낱말이 있는 문단입니다.' }], rid }, user, AGENT);
  assert.equal((await service.resolveRequest(docId, rid, { apply: 'rest' }, user)).counts.failed, 0);
  assert.equal((await store.doc(docId)).text('s0/p1', 'final'), '바꿀 낱말이 있는 문단입니다.');
  const out = await service.agentEdit(docId, { rid, done: '낱말을 바꿨습니다', ops: [
    { op: 'replace', at: 's0/p1', find: '낱말', with: '단어' },
    { op: 'replace', at: 's0/p1', find: '낱말', with: '어휘' },
  ] }, user, AGENT);
  assert.ok(!out.failed, JSON.stringify(out));
  assert.equal(pidsOf(out.saved).length, 2, '저장은 된다');
  assert.equal(out.completed, false, JSON.stringify(out));
  assert.equal(Object.keys(out)[0], 'apply_failed', `맨 위 칸: ${Object.keys(out)}`);
  assert.equal(out.apply_failed.length, 1); assert.match(out.apply_failed[0].error, /STALE/);
  const bad = out.apply_failed[0].pid;
  assert.ok(pidsOf(out.saved).includes(bad), JSON.stringify(out.apply_failed));
  assert.match(out.complete_note, /완료하지 않았습니다/); assert.match(out.complete_note, /withdraw/);
  assert.equal(reqStatus(store, docId, rid), 'working', '요청은 처리 중 그대로');
  // 모델이 고친다: 실패할 제안을 거두고 다시 done → 완료
  const fixed = await service.agentEdit(docId, { rid, done: '낱말을 바꿨습니다', ops: [{ op: 'withdraw', pids: [bad] }] }, user, AGENT);
  assert.equal(fixed.completed, true, JSON.stringify(fixed));
  assert.equal(fixed.apply_failed, undefined);
  assert.equal(reqStatus(store, docId, rid), 'done');
  // 마지막 쪽 알림(문제 2): 0.9 이상일 때만
  for (const p of [out.pages, fixed.pages]) assert.equal(/거의 찼다/.test(p.note || ''), (p.last_page_fill ?? 0) >= 0.9, JSON.stringify(p));
  await layoutChecker().drain();
});

test('마지막 쪽이 거의 차면(0.9 이상) pages.note 에 한/글 넘침 알림 — 그 아래는 없음', { timeout: 180000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  // 문단 수를 늘려 가며 마지막 쪽 채움이 0.9 이상인 것과 아래인 것을 하나씩 찾는다(dry_run — 저장하지 않음)
  const seen = { high: null, low: null };
  for (let n = 4; n <= 40 && !(seen.high && seen.low); n += 1) {
    const dry = await service.agentEdit(docId, { ops: [{ op: 'insert', after: 's0/p0', paragraphs: paras(n) }], rid, dryRun: true }, user, AGENT);
    const p = dry.pages; assert.ok(!p.skipped, p.skipped);
    if (p.last_page_fill >= 0.9) seen.high ??= p; else seen.low ??= p;
  }
  assert.ok(seen.high && seen.low, JSON.stringify(seen));
  assert.match(seen.high.note, /마지막 쪽이 거의 찼다 — 한\/글에서는 한 쪽 넘칠 수 있다/);
  assert.ok(!/거의 찼다/.test(seen.low.note || ''), JSON.stringify(seen.low));
  await layoutChecker().drain();
});
