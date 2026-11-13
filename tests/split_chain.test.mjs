// node --test tests/split_chain.test.mjs — 한 문단을 여러 번 나누는 바꿈 제안(줄바꿈 = 새 문단)의 반영·되돌리기(2026-11-10).
// 실제 문서에서: 앞서 반영해 아직 수락하지 않은 변경 추적(문단을 통째로 다시 쓴 제안) 안의 글을 문장마다 나누는 제안 11개가 [모두 반영]에서
// 하나도 반영되지 않았다(OVERLAP). 예전 적용은 고른 자리부터 문단 끝까지를 지우고 꼬리를 새 문단에 다시 넣어, 같은 문단의 다음 제안과 늘 겹쳤다.
// 이제 고른 자리만 바꾸고 그 뒤에서 문단을 가른다(꼬리는 글자 모양째 옮겨 감) — 제안마다 제 변경만 남고, 따로따로 되돌릴 수 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';

const user = { name: '나눔 시험', role: 'admin' };
const BASE = '첫 문장임. 둘째 문장임. 셋째 문장임. 넷째 문장임.';
const SPLIT = ['첫 문장임.', '둘째 문장임.', '셋째 문장임.', '넷째 문장임.'];
const REF = 's0/p2';

async function setup(t, settings, prepare = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-split-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hwpx-split-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  doc.mergeParagraphText(REF, BASE, { author: 'fixture' }); doc.acceptAll();
  if (prepare) prepare(doc);
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, tutorial: { enabled: false } }, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'split.hwpx', bytes: Buffer.from(await doc.save()), by: user.name, extra: { settings } }).id;
  const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '문단 나누기', route: 'queue' }, user)).request;
  const body = async () => (await store.doc(id)).paragraphs({ view: 'final', nested: false }).map((p) => p.text);
  const before = await body();
  const at = before.indexOf(BASE);
  assert.equal(`s0/p${at}`, REF, '받침 문단 자리');
  // 기대: 그 문단 자리에 SPLIT 네 문단
  const expected = [...before.slice(0, at), ...SPLIT, ...before.slice(at + 1)];
  const meta = () => store.readMeta(id);
  const prop = (pid) => meta().proposals.find((p) => p.pid === pid);
  const pending = async (pid) => { const p = prop(pid); const live = new Set((await store.doc(id)).changes().map((c) => Number(c.id))); return [...(p.changeIds || []), ...(p.split?.changeIds || [])].filter((c) => live.has(Number(c))).length; };
  // 문장 사이마다 나누는 제안 셋(찾을 글 '임. 둘째' → '임.\n둘째' 꼴 — 실제 AI 제안과 같은 꼴)
  const chain = async () => {
    const out = [];
    for (const word of ['둘째', '셋째', '넷째']) out.push(await service.propose(id, { rid: request.rid, ref: REF, find: `임. ${word}`, replace: `임.\n${word}` }, user));
    return out;
  };
  return { store, service, id, request, body, before, expected, meta, prop, pending, chain,
    applyAll: () => service.resolveRequest(id, request.rid, { apply: 'rest' }, user),
    apply: (p) => service.applyProposal(id, p.pid, user), undo: (p) => service.undoProposal(id, p.pid, user),
    acceptAll: async () => { for (;;) { const ids = (await store.doc(id)).changes().map((c) => c.id); if (!ids.length) break; await service.resolveChange(id, Math.max(...ids), 'accept', user); } } };
}

const TRACKED = { editMode: 'realtime', track: 'tracked' };
const FINAL = { editMode: 'realtime', track: 'final' };

test('변경 추적으로: 아직 수락하지 않은 변경 안의 글을 여러 번 나누는 제안이 [모두 반영]으로 모두 들어가고, 제안마다 제 변경이 남는다', async (t) => {
  // 앞선 제안이 문단을 통째로 다시 썼고(반영 — 변경 추적으로 남음) 사람이 아직 수락하지 않았다
  const draft = '첫 문장. 둘째 문장. 셋째 문장. 넷째 문장.';
  const s = await setup(t, TRACKED);
  const doc0 = await s.store.doc(s.id);
  assert.equal(doc0.text(REF, 'final'), BASE);
  const whole = await s.service.propose(s.id, { ref: REF, find: BASE, replace: draft }, user);
  await s.apply(whole);
  const back = await s.service.propose(s.id, { ref: REF, find: draft, replace: BASE }, user);
  await s.apply(back);
  assert.ok(await s.pending(back.pid) > 0, '통째 바꿈이 처리 안 된 변경으로 남음');
  const props = await s.chain();
  const out = await s.applyAll();
  assert.equal(out.counts.failed, 0, JSON.stringify(out.results.filter((x) => !x.ok)));
  assert.equal(out.counts.applied, 3);
  assert.deepEqual(await s.body(), s.expected);
  assert.equal(s.prop(back.pid).autoAccepted, true, '겹친 앞 제안은 수락해 둔다(되돌리기는 글로)');
  for (const p of props) {
    const now = s.prop(p.pid);
    assert.equal(now.status, 'applied');
    assert.equal(now.autoAccepted, undefined, '나눈 제안끼리는 겹치지 않아 저절로 수락되지 않는다');
    assert.equal(await s.pending(p.pid), now.split.total, `#${p.pid} 의 변경이 모두 처리 안 된 채 남음`);
    assert.ok(now.split.total >= 3, '지움·넣음·넣은 나눔');
  }
  // 저장한 파일을 새로 읽어도 같다
  const re = await HwpxDoc.load(s.store.currentBytes(s.id));
  assert.deepEqual(re.paragraphs({ view: 'final', nested: false }).map((p) => p.text), s.expected);
  // 가운데 제안 하나만 되돌리면 그 나눔만 없어진다(다른 제안의 변경은 그대로)
  const at = Number(REF.split('/p')[1]);
  await s.undo(props[1]);
  assert.deepEqual((await s.body()).slice(at, at + 3), ['첫 문장임.', '둘째 문장임. 셋째 문장임.', '넷째 문장임.']);
  await s.undo(props[0]); await s.undo(props[2]);
  assert.deepEqual(await s.body(), s.before);
});

test('변경 추적으로: 하나씩 반영해도(앞에서부터·뒤에서부터) 다음 제안이 나뉜 문단에서 제 글을 찾는다', async (t) => {
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2]]) {
    const s = await setup(t, TRACKED);
    const props = await s.chain();
    for (const i of order) await s.apply(props[i]);
    assert.deepEqual(await s.body(), s.expected, `차례 ${order.join(',')}`);
    // 되돌린 뒤 다시 열어 반영해도 같다(나뉜 문단으로 옮겨 간 제안이 제자리로 돌아온다)
    for (const i of order) await s.undo(props[i]);
    assert.deepEqual(await s.body(), s.before);
    for (const p of props) await s.service.reopenProposal(s.id, p.pid, user);
    const again = await s.applyAll();
    assert.equal(again.counts.applied, 3, JSON.stringify(again.results));
    assert.deepEqual(await s.body(), s.expected);
  }
});

test('변경 추적으로: 사람이 변경을 수락한 뒤(전부·일부) 되돌려도 글이 겹치지 않고 원문으로 돌아온다', async (t) => {
  // 전부 수락 → 뒤에서부터 글로 되돌림(나눈 문단을 다시 이음)
  const s = await setup(t, TRACKED);
  const props = await s.chain();
  await s.applyAll(); await s.acceptAll();
  for (const p of [...props].reverse()) await s.undo(p);
  assert.deepEqual(await s.body(), s.before);
  await s.acceptAll();
  assert.deepEqual(await s.body(), s.before, '되돌리기가 남긴 변경을 수락해도 원문');
  // 앞 제안을 먼저 되돌리려 하면(그 뒤 문단이 다시 나뉘어 있음) 아무것도 바꾸지 않고 STALE
  const s2 = await setup(t, TRACKED);
  const p2 = await s2.chain();
  await s2.applyAll(); await s2.acceptAll();
  await assert.rejects(s2.undo(p2[0]), (e) => e.code === 'STALE');
  assert.deepEqual(await s2.body(), s2.expected);
  // 일부만 수락(넣은 글 하나만): 예전에는 나눔을 거절해 문단을 합친 뒤 원문을 되살려 글이 두 번 들어갔다
  const s3 = await setup(t, TRACKED);
  const p3 = await s3.chain();
  await s3.apply(p3[0]);
  const ins = (await s3.store.doc(s3.id)).changes().find((c) => c.type === 'Insert' && !c.kind && c.ref === `s0/p${Number(REF.split('/p')[1]) + 1}`);
  assert.ok(ins, '꼬리 문단 머리에 넣은 글');
  await s3.service.resolveChange(s3.id, ins.id, 'accept', user);
  await s3.undo(p3[0]);
  assert.deepEqual(await s3.body(), s3.before);
});

test('변경 번호가 밀려도(다른 변경을 수락·거절) 여러 문단 제안의 되돌리기가 제 변경만 거절한다', async (t) => {
  const s = await setup(t, TRACKED);
  // 앞 문단에 다른 사람의 처리 안 된 변경(번호가 더 작다)
  const other = await s.service.propose(s.id, { ref: 's0/p1', find: '', replace: ' 덧붙임' }, user);
  await s.apply(other);
  const mid = await s.body();
  const props = await s.chain();
  await s.apply(props[0]);
  // 앞 변경을 수락하면 뒤 번호가 모두 당겨진다
  const first = (await s.store.doc(s.id)).changes().find((c) => c.ref === 's0/p1');
  await s.service.resolveChange(s.id, first.id, 'accept', user);
  assert.equal(await s.pending(props[0].pid), s.prop(props[0].pid).split.total, '넣은 문단·나눔의 번호도 따라 옮겨졌다');
  await s.undo(props[0]);
  assert.deepEqual(await s.body(), mid);
});

test('고친 글만: 꼬리의 글자 모양이 나뉜 문단으로 그대로 옮겨 가고, 되돌리면 원래대로', async (t) => {
  const bold = { start: [...BASE].indexOf('셋'), end: [...BASE].indexOf('셋') + 2 };
  const s = await setup(t, FINAL, (d) => { d.formatRange(REF, { char: { bold: true }, start: bold.start, end: bold.end }); });
  const shape = async (ref) => (await s.store.doc(s.id)).inspectFormatting(ref).runs.filter((r) => r.char.bold).map((r) => [r.start, r.end]);
  assert.deepEqual(await shape(REF), [[bold.start, bold.end]], '받침: 꼬리에 굵은 글');
  const f0 = JSON.stringify((await s.store.doc(s.id)).inspectFormatting(REF).runs.map((r) => [r.start, r.end, r.char]));
  const p = await s.service.propose(s.id, { rid: s.request.rid, ref: REF, find: '임. 둘째', replace: '임.\n\n둘째' }, user);
  await s.apply(p);
  const at = Number(REF.split('/p')[1]);
  assert.deepEqual((await s.body()).slice(at, at + 3), ['첫 문장임.', '', '둘째 문장임. 셋째 문장임. 넷째 문장임.'], '빈 줄은 빈 문단, 꼬리는 마지막 문단');
  const tailRef = `s0/p${at + 2}`;
  const moved = [...'둘째 문장임. 셋째 문장임. 넷째 문장임.'].indexOf('셋');
  assert.deepEqual(await shape(tailRef), [[moved, moved + 2]], '굵은 글이 꼬리 문단에 그대로');
  assert.equal((await s.store.doc(s.id)).changes().length, 0, '고친 글만 — 변경 추적을 남기지 않는다');
  await s.undo(p);
  assert.deepEqual(await s.body(), s.before);
  assert.equal(JSON.stringify((await s.store.doc(s.id)).inspectFormatting(REF).runs.map((r) => [r.start, r.end, r.char])), f0, '되돌린 뒤 글자 모양이 같다');
  assert.equal((await s.store.doc(s.id)).changes().length, 0);
});

test('변경 추적으로: 여러 문단 넣기 제안도 넣은 글만 수락된 뒤 되돌리면 글이 앞 문단에 붙어 남지 않는다', async (t) => {
  const s = await setup(t, TRACKED);
  const add = await s.service.propose(s.id, { rid: s.request.rid, afterRef: REF, text: '덧붙인 첫 문단\n덧붙인 둘째 문단' }, user);
  await s.apply(add);
  const at = Number(REF.split('/p')[1]);
  assert.deepEqual((await s.body()).slice(at, at + 3), [BASE, '덧붙인 첫 문단', '덧붙인 둘째 문단']);
  const ins = (await s.store.doc(s.id)).changes().find((c) => c.type === 'Insert' && !c.kind && c.ref === `s0/p${at + 1}`);
  await s.service.resolveChange(s.id, ins.id, 'accept', user);
  await s.undo(add);
  assert.deepEqual(await s.body(), s.before);
});

test('가장자리: 문단 맨 앞에서 나눔(첫 줄이 빈 글)·여러 줄(가운데 문단)도 두 방식 모두 반영·되돌리기가 맞는다', async (t) => {
  for (const settings of [TRACKED, FINAL]) {
    const s = await setup(t, settings);
    const at = Number(REF.split('/p')[1]);
    const head = await s.service.propose(s.id, { rid: s.request.rid, ref: REF, find: '첫 문장임. 둘째', replace: '\n첫 문장임. 둘째' }, user);
    await s.apply(head);
    assert.deepEqual((await s.body()).slice(at, at + 2), ['', BASE], `맨 앞 나눔(${settings.track})`);
    await s.undo(head);
    assert.deepEqual(await s.body(), s.before);
    const many = await s.service.propose(s.id, { rid: s.request.rid, ref: REF, find: '임. 둘째 문장임. 셋째', replace: '임.\n가운데 하나\n가운데 둘\n셋째' }, user);
    await s.apply(many);
    assert.deepEqual((await s.body()).slice(at, at + 4), ['첫 문장임.', '가운데 하나', '가운데 둘', '셋째 문장임. 넷째 문장임.'], `여러 줄(${settings.track})`);
    if (settings === TRACKED) await s.acceptAll();   // 수락한 뒤에는 글로 되돌린다(가운데 문단을 비우고 다시 이음)
    await s.undo(many);
    assert.deepEqual(await s.body(), s.before);
  }
});

test('문단을 나눈 뒤: 그 문단 뒤에 넣으려던 대기 제안은 나뉜 마지막 문단 뒤로 들어간다', async (t) => {
  const s = await setup(t, FINAL);
  const cut = await s.service.propose(s.id, { rid: s.request.rid, ref: REF, find: '임. 셋째', replace: '임.\n셋째' }, user);
  const add = await s.service.propose(s.id, { rid: s.request.rid, afterRef: REF, text: '덧붙인 문단' }, user);
  await s.apply(cut); await s.apply(add);
  const at = Number(REF.split('/p')[1]);
  assert.deepEqual((await s.body()).slice(at, at + 3), ['첫 문장임. 둘째 문장임.', '셋째 문장임. 넷째 문장임.', '덧붙인 문단']);
});
