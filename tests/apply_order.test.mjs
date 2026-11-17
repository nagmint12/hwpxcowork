// node --test tests/apply_order.test.mjs — 반영 경로의 범위·차례(2026-11-17, docs/MCP_REDESIGN_2026-11-16.md §10.4 나-2·나-3).
//  나-2: 글을 바꾼 문단에 '따로' 낸 스타일(문단) 서식 제안이 반영에서 FORMAT_PARAGRAPH_RANGE 로 실패했다(논문 실험 2건 — 빈 문단에 제목 넣기 + 제목 스타일).
//        제안 때 문단 전체를 덮은 스타일·문단 서식(빈 문단 0..0 포함)은 다른 제안이 그 문단 글을 바꿔도 '문단 전체'를 따라간다 —
//        [모두 반영](_orderedApplier)과 하나씩 반영(_pendingFormatTargets·_advancePendingFormats) 모두.
//  나-3: 같은 기준 문단 뒤에 넣는 제안 여럿을 카드에서 하나씩 번호순으로 반영하면 차례가 거꾸로 됐다(T03 문단 3개가 3·2·1, T08 그림 앞에 빈 줄).
//        같은 요청·같은 기준 문단의 넣기 제안은 반영 순서와 상관없이 번호(pid) 차례로 놓인다(_insertAfterRef — 단건·모두 반영 한 규칙).
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
import { fixture, root, startServer, uploadDoc } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';

const user = { name: '차례 시험', role: 'admin' };
const BLANK = path.join(root, 'server', 'templates', 'blank.hwpx');
// 실시간 '고친 글만' · 실시간 '변경 추적으로' · 승인 방식(변경 추적)
const MODES = [{ editMode: 'realtime', track: 'final' }, { editMode: 'realtime', track: 'changes' }, { editMode: 'approval', track: 'changes' }];
const label = (s) => `${s.editMode}/${s.track}`;

async function setup(t, { settings = MODES[0], file = 'memo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-order-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hwpx-order-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let bytes;
  if (file === 'blank') bytes = fs.readFileSync(BLANK);
  else {
    const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
    doc.mergeParagraphText('s0/p2', '셋째 문단은 그대로 둡니다', { author: 'fixture' }); doc.acceptAll();
    bytes = Buffer.from(await doc.save());
  }
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, tutorial: { enabled: false } }, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'order.hwpx', bytes, by: user.name, extra: { settings } }).id;
  const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '차례 시험', route: 'queue' }, user)).request;
  const doc = () => store.doc(id);
  const prop = (pid) => store.readMeta(id).proposals.find((p) => p.pid === pid);
  const styleId = async (name) => (await doc()).formattingCatalog().styles.find((s) => s.name === name).id;
  return {
    store, service, id, request, doc, prop, styleId,
    propose: (body) => service.propose(id, { rid: request.rid, ...body }, user),
    apply: (pid) => service.applyProposal(id, pid, user),
    applyRest: () => service.resolveRequest(id, request.rid, { apply: 'rest' }, user),
    undo: (pid) => service.undoProposal(id, pid, user),
    fmt: async (ref) => (await doc()).inspectFormatting(ref),
  };
}

/** 반영 결과에 실패가 없음 */
const noFail = (out) => assert.equal(out.counts.failed, 0, JSON.stringify(out.results));

// ───────── 나-2: 글을 바꾼 문단의 스타일 제안 ─────────

test('빈 문단에 글 넣기 + 따로 낸 스타일: [모두 반영]·하나씩(글 → 스타일, 스타일 → 글) 모두 반영되고 제목 스타일이 남는다', async (t) => {
  for (const settings of MODES) {
    for (const order of ['rest', 'one', 'reverse', 'many', 'norid']) {
      const s = await setup(t, { settings, file: 'blank' });
      const title = await s.styleId('&본문제목');
      let a; let b;
      if (order === 'norid') {
        // 요청 없이 낸 제안(예전 연결 propose_change 를 request_id 없이) — 같은 작성자의 것끼리 하나씩
        a = await s.service.propose(s.id, { ref: 's0/p0', find: '', replace: '논문 제목' }, user);
        b = await s.service.propose(s.id, { type: 'format', ref: 's0/p0', start: 0, end: 0, format: { styleId: title } }, user);
      } else if (order === 'many') {
        // 예전 연결 propose_changes·propose_format 처럼 한 번에 여럿(proposeMany)
        const res = await s.service.proposeMany(s.id, [{ ref: 's0/p0', find: '', replace: '논문 제목' }, { type: 'format', ref: 's0/p0', start: 0, end: 0, format: { styleId: title } }], user, null, { rid: s.request.rid });
        assert.ok(res.every((x) => x.ok), JSON.stringify(res)); [a, b] = res.map((x) => x.proposal);
      } else {
        a = await s.propose({ ref: 's0/p0', find: '', replace: '논문 제목' });
        b = await s.propose({ type: 'format', ref: 's0/p0', start: 0, end: 0, format: { styleId: title } });
      }
      if (order === 'rest' || order === 'many') noFail(await s.applyRest());
      else if (order === 'one' || order === 'norid') { await s.apply(a.pid); await s.apply(b.pid); }
      else { await s.apply(b.pid); await s.apply(a.pid); }
      const f = await s.fmt('s0/p0');
      assert.equal(f.text, '논문 제목', `${label(settings)} ${order}`);
      assert.equal(f.styleId, title, `${label(settings)} ${order}: 제목 스타일`);
      assert.equal(s.prop(b.pid).status, 'applied');
    }
  }
});

test('글이 있는 문단: 글 전체 바꾸기·일부 바꾸기 + 문단 전체 스타일도 [모두 반영]·하나씩 모두 반영된다', async (t) => {
  for (const settings of MODES) {
    for (const kind of ['whole', 'part']) {
      for (const order of ['rest', 'one']) {
        const s = await setup(t, { settings });
        const text = (await s.fmt('s0/p2')).text;
        const outline = await s.styleId('개요 1');
        const a = kind === 'whole'
          ? await s.propose({ ref: 's0/p2', find: text, replace: '완전히 새로 쓴 셋째 문단' })
          : await s.propose({ ref: 's0/p2', find: '그대로', replace: '고쳐서' });
        const b = await s.propose({ type: 'format', ref: 's0/p2', start: 0, end: [...text].length, format: { styleId: outline } });
        if (order === 'rest') noFail(await s.applyRest()); else { await s.apply(a.pid); await s.apply(b.pid); }
        const f = await s.fmt('s0/p2');
        assert.equal(f.text, kind === 'whole' ? '완전히 새로 쓴 셋째 문단' : '셋째 문단은 고쳐서 둡니다', `${label(settings)} ${kind} ${order}`);
        assert.equal(f.styleId, outline, `${label(settings)} ${kind} ${order}: 스타일`);
      }
    }
  }
});

test('글자 서식만: 빈 문단 것은 들어간 글 전체를 따라가고(서식 먼저 반영한 것과 같다), 글 있는 문단의 겹친 글자 서식은 그대로 충돌로 남는다', async (t) => {
  for (const settings of [MODES[0], MODES[2]]) {
    for (const order of ['rest', 'one']) {
      const s = await setup(t, { settings, file: 'blank' });
      const a = await s.propose({ ref: 's0/p0', find: '', replace: '굵은 제목' });
      const b = await s.propose({ type: 'format', ref: 's0/p0', start: 0, end: 0, format: { char: { bold: true } } });
      if (order === 'rest') noFail(await s.applyRest()); else { await s.apply(a.pid); await s.apply(b.pid); }
      const f = await s.fmt('s0/p0');
      assert.deepEqual(f.runs.map((r) => [r.start, r.end, !!r.char?.bold]), [[0, 5, true]], `${label(settings)} ${order}`);
    }
    // 글 있는 문단: 문단 전체 굵게 + 그 안 글을 바꾸는 제안 — 바뀐 글에 글자 서식을 넓혀 주지 않는다(예전 규칙: STALE)
    for (const order of ['rest', 'one']) {
      const s = await setup(t, { settings });
      const text = (await s.fmt('s0/p2')).text;
      const a = await s.propose({ ref: 's0/p2', find: '그대로', replace: '고쳐서' });
      const b = await s.propose({ type: 'format', ref: 's0/p2', start: 0, end: [...text].length, format: { char: { bold: true } } });
      if (order === 'rest') {
        const out = await s.applyRest();
        assert.equal(out.results.find((r) => r.pid === a.pid).ok, true);
        assert.equal(out.results.find((r) => r.pid === b.pid).ok, false, JSON.stringify(out.results));
      } else {
        await s.apply(a.pid);
        await assert.rejects(s.apply(b.pid), (e) => ['STALE', 'FORMAT_CONFLICT'].includes(e.code));
      }
      assert.equal(s.prop(b.pid).status, 'pending');
    }
  }
});

// ───────── 나-3: 같은 기준 문단 뒤에 넣는 제안의 차례 ─────────

/** 제안이 넣은 본문 문단들(문서 차례) */
const placed = (p) => [p.insertedRef, ...(p.split?.refs || []), ...(p.extraRefs || [])].filter(Boolean).map((r) => /^s\d+\/p\d+/.exec(r)[0])
  .filter((r, i, a) => a.indexOf(r) === i).sort((x, y) => Number(x.split('/p')[1]) - Number(y.split('/p')[1]));

/** 넣은 문단들이 기준 문단 바로 뒤부터 pid 차례로 빈틈없이 이어졌는가 */
function assertOrder(s, anchor, pids, msg) {
  const n = Number(anchor.split('/p')[1]);
  const got = pids.flatMap((pid) => placed(s.prop(pid)));
  assert.deepEqual(got, got.map((_, i) => `s0/p${n + 1 + i}`), `${msg}: ${JSON.stringify(pids.map((pid) => [pid, placed(s.prop(pid))]))}`);
}

test('같은 자리 넣기 셋을 하나씩: 1·2·3 / 3·1·2 / 2·3·1 / 하나 반영 뒤 [모두 반영] — 모두 번호 차례로 놓인다', async (t) => {
  for (const settings of MODES) {
    for (const seq of [[0, 1, 2], [2, 0, 1], [1, 2, 0], [1, 'rest'], [2, 'rest'], ['rest']]) {
      const s = await setup(t, { settings });
      const props = [];
      for (const text of ['넣은 하나', '넣은 둘\n둘의 둘째 줄', '넣은 셋']) props.push(await s.propose({ afterRef: 's0/p0', text }));
      for (const k of seq) { if (k === 'rest') noFail(await s.applyRest()); else await s.apply(props[k].pid); }
      assertOrder(s, 's0/p0', props.map((p) => p.pid), `${label(settings)} ${seq.join('·')}`);
      const texts = (await s.doc()).paragraphs({ view: 'final', nested: false }).map((p) => p.text);
      assert.deepEqual(texts.slice(1, 5), ['넣은 하나', '넣은 둘', '둘의 둘째 줄', '넣은 셋'], `${label(settings)} ${seq.join('·')}`);
      assert.match(texts[5], /^둘째 문단입니다/, '기준 다음 원래 문단은 넣은 문단들 뒤');
    }
  }
});

test('예전 연결 propose_insert(paragraphs) 꼴(proposeMany)과 문단·빈 줄·표·그림 섞기: 하나씩 거꾸로 반영해도 낸 차례, 되돌린 뒤 다시 반영해도 제자리', async (t) => {
  for (const settings of [MODES[0], MODES[2]]) {
    const s = await setup(t, { settings });
    const res = await s.service.proposeMany(s.id, [{ type: 'insert', afterRef: 's0/p0', text: '섞은 첫 문단' }, { type: 'insert', afterRef: 's0/p0', text: '', blank: true }], user, null, { rid: s.request.rid });
    assert.ok(res.every((x) => x.ok), JSON.stringify(res));
    const table = await s.propose({ type: 'table', afterRef: 's0/p0', table: { rows: [['머리', '값'], ['가', '1']], caption: '섞은 표' } });
    const figure = await s.service.proposeFigure(s.id, { rid: s.request.rid, afterRef: 's0/p0', imageBase64: makePng(80, 40).toString('base64'), caption: '섞은 그림' }, user);
    const last = await s.propose({ afterRef: 's0/p0', text: '섞은 끝 문단' });
    const pids = [...res.map((x) => x.proposal.pid), table.pid, figure.pid, last.pid];
    for (const pid of [...pids].reverse()) await s.apply(pid);
    assertOrder(s, 's0/p0', pids, `${label(settings)} 거꾸로`);
    // 가운데(표)를 되돌렸다가 다시 반영: 앞 형제(빈 줄)의 꼬리 뒤 = 그림 앞
    await s.undo(table.pid);
    await s.service.reopenProposal(s.id, table.pid, user);
    await s.apply(table.pid);
    assertOrder(s, 's0/p0', pids, `${label(settings)} 되돌린 뒤 다시`);
    const all = (await s.doc()).paragraphs({ view: 'final', nested: true }).map((p) => p.text);
    const at = ['섞은 첫 문단', '섞은 표', '섞은 그림', '섞은 끝 문단'].map((x) => all.findIndex((y) => y.includes(x)));
    assert.ok(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), JSON.stringify(all.slice(0, 12)));
  }
});

test('다른 요청의 넣기는 서로 형제가 아니다 — 나중 요청의 넣기는 예전처럼 기준 문단 바로 뒤', async (t) => {
  const s = await setup(t);
  const other = (await s.service.createRequest(s.id, { kind: 'instruct', target: { scope: 'document' }, instruction: '다른 요청', route: 'queue' }, user)).request;
  const mine = await s.propose({ afterRef: 's0/p0', text: '첫 요청 문단' });
  const theirs = await s.service.propose(s.id, { rid: other.rid, afterRef: 's0/p0', text: '둘째 요청 문단' }, user);
  await s.apply(mine.pid); await s.apply(theirs.pid);
  const texts = (await s.doc()).paragraphs({ view: 'final', nested: false }).map((p) => p.text);
  assert.deepEqual(texts.slice(1, 3), ['둘째 요청 문단', '첫 요청 문단']);
});

test('넣을 자리 셈(_insertAfterRef): 꼬리 = 넣은 문단·캡션·split.refs·extraRefs 가운데 문서 차례로 마지막, 예전 기록(afterRef 를 앞 형제 꼬리로 적음)도 형제', () => {
  const service = Object.create(Service.prototype);
  const ctx = (proposals) => ({ doc: null, meta: { proposals } });
  const at = (pid, extra = {}) => ({ pid, type: 'insert', rid: 1, by: 'AI', status: 'applied', afterRef: 's0/p3', ...extra });
  const me = { pid: 9, type: 'table', rid: 1, by: 'AI', status: 'pending', afterRef: 's0/p3' };
  // 표 + 덧붙인 주석 문단(extraRefs) — 꼬리는 주석 문단
  assert.equal(service._insertAfterRef(ctx([at(2, { type: 'table', insertedRef: 's0/p4', captionRef: 's0/p4/n0', extraRefs: ['s0/p5', 's0/p6'] })]), me), 's0/p6');
  // 번호 큰 형제만 반영됐으면 기준 문단 바로 뒤
  assert.equal(service._insertAfterRef(ctx([at(12, { insertedRef: 's0/p4' })]), me), 's0/p3');
  // 다른 요청·다른 작성자(요청 없음)·여러 안 묶음의 다른 안은 형제가 아니다
  assert.equal(service._insertAfterRef(ctx([at(2, { rid: 7, insertedRef: 's0/p4' })]), me), 's0/p3');
  assert.equal(service._insertAfterRef(ctx([at(2, { rid: null, insertedRef: 's0/p4' })]), { ...me, rid: null, by: '사람' }), 's0/p3');
  assert.equal(service._insertAfterRef(ctx([at(2, { rid: null, insertedRef: 's0/p4' })]), { ...me, rid: null }), 's0/p4');
  // 예전 [모두 반영] 기록: 둘째가 afterRef 를 첫째 꼬리(s0/p4)로 적어 둠 → 사슬로 이어 형제, 셋째는 둘째 꼬리 뒤
  assert.equal(service._insertAfterRef(ctx([at(2, { insertedRef: 's0/p4' }), at(3, { afterRef: 's0/p4', insertedRef: 's0/p5', split: { refs: ['s0/p5', 's0/p6'] } })]), me), 's0/p6');
  // 넣은 문단이 지워진 형제(insertedGone — 주소 null)는 건너뛴다
  assert.equal(service._insertAfterRef(ctx([at(2, { insertedRef: 's0/p4' }), at(3, { insertedRef: null, insertedGone: true, split: { refs: [null] } })]), me), 's0/p4');
  // 그림 교체·바꿈은 자리 셈을 하지 않는다(기준 그대로)
  assert.equal(service._insertAfterRef(ctx([at(2, { insertedRef: 's0/p4' })]), { ...me, type: 'figure', figure: { replace: { n: 1 } } }), 's0/p3');
});

// ───────── 새 연결(edit) 길 ─────────

const textOf = (result) => (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (result) => { assert.ok(!result.isError, textOf(result)); return JSON.parse(textOf(result)); };

test('새 연결: 글과 스타일을 따로 낸 edit 두 호출, 넣기 셋을 카드에서 하나씩 — 반영 실패 없이 낸 차례', async () => {
  const srv = await startServer({ ai: 'off' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?v=2&tools=core`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
  const client = new Client({ name: 'apply-order', version: '1' });
  try {
    await client.connect(transport);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const api = srv.api('a');
    // ① 빈 문단에 글(replace) → 다른 호출로 스타일(format): 합쳐지지 않고 제안 둘 — [모두 반영]
    for (const how of ['rest', 'one']) {
      const blank = await uploadDoc(srv.base, srv.tokens.a, BLANK);
      const req = (await api(`/api/docs/${blank.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '제목', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
      json(await call('task', { doc_id: blank.id, request_id: req.rid }));
      const r1 = json(await call('edit', { doc_id: blank.id, request_id: req.rid, expected_attempt: 1, ops: [{ op: 'replace', at: 's0/p0', find: '', with: '논문 제목' }] }));
      const r2 = json(await call('edit', { doc_id: blank.id, request_id: req.rid, expected_attempt: 1, ops: [{ op: 'format', at: 's0/p0', style: '&본문제목' }], done: '제목' }));
      assert.equal(r1.saved.length + r2.saved.length, 2, JSON.stringify([r1, r2]));
      if (how === 'rest') {
        const out = await api(`/api/docs/${blank.id}/requests/${req.rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
        assert.equal(out.counts.failed, 0, JSON.stringify(out.results)); assert.equal(out.counts.applied, 2);
      } else {
        for (const x of [...r1.saved, ...r2.saved]) await api(`/api/docs/${blank.id}/proposals/${x.pid}/apply`, { method: 'POST', body: {} });
      }
      const fmt = json(await call('read', { doc_id: blank.id, view: 'format', at: 's0/p0' }));
      assert.equal(fmt.paragraphs[0].text, '논문 제목');
      assert.equal(fmt.header.styles.find((x) => x.id === fmt.paragraphs[0].styleId)?.name, '&본문제목', how);
    }
    // ② 넣기 op 하나의 문단 셋(제안 셋)을 카드에서 번호순으로 하나씩 반영
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const req = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '요약 셋', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
    json(await call('task', { doc_id: doc.id, request_id: req.rid }));
    const r = json(await call('edit', { doc_id: doc.id, request_id: req.rid, expected_attempt: 1, done: '요약', ops: [{ op: 'insert', after: 's0/p0', paragraphs: [{ text: '요약 하나' }, { text: '요약 둘' }, { text: '요약 셋' }] }] }));
    // 같은 op 의 제안 셋 이상은 영수증 한 줄 { op, pids:'12-14', count }(2026-11-17 작업 F — MCP_REDESIGN §10.4 나-10)
    const pids = r.saved.flatMap((x) => (Number.isInteger(x.pid) ? [x.pid] : String(x.pids).split(',').flatMap((s) => { const [a, b = a] = s.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, k) => a + k); }))).sort((a, b) => a - b);
    assert.equal(pids.length, 3, '문단마다 제안 하나(T03 과 같은 꼴)');
    for (const pid of pids) await api(`/api/docs/${doc.id}/proposals/${pid}/apply`, { method: 'POST', body: {} });
    const texts = (await api(`/api/docs/${doc.id}/paragraphs?view=final&nested=0`)).map((p) => p.text);
    assert.deepEqual(texts.slice(1, 4), ['요약 하나', '요약 둘', '요약 셋'], JSON.stringify(texts.slice(0, 6)));
  } finally {
    await transport.terminateSession().catch(() => {}); await client.close().catch(() => {});
    await srv.stop();
  }
});
