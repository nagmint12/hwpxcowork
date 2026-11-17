// node --test tests/proposal_place.test.mjs — 제안 카드의 자리(web/proposal-place.js, 2026-11-10).
// 실제 문서에서: 문서 끝 문단(s0/p655) 뒤에 문단 31개를 차례로 넣는 제안을 [모두 반영]한 뒤, 카드 31개가 모두 's0/p655'(제안할 때의 기준 문단)를
// 보여 줬다 — 실제로 넣은 자리는 s0/p656 ~ s0/p686 이었다. 반영한 넣기 제안은 넣은 문단을, 대기 중이면 그 뒤에 넣을 문단을 보인다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proposalPlace, refWords, placeNote } from '../web/proposal-place.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { fixture } from './helpers/server.mjs';

test('넣기 제안: 대기 중이면 그 뒤에 넣을 문단, 반영하면 넣은 문단(여러 문단이면 끝 문단까지), 지워졌으면 자리 없음', () => {
  assert.deepEqual(proposalPlace({ type: 'insert', status: 'pending', ref: 's0/p655', afterRef: 's0/p655' }), { ref: 's0/p655', endRef: null, after: true, gone: false, count: 1 });
  // 차례로 쌓아 넣은 서른한 번째: 기준(ref)은 처음 그대로, 실제 자리는 insertedRef
  assert.deepEqual(proposalPlace({ type: 'insert', status: 'applied', ref: 's0/p655', afterRef: 's0/p685', insertedRef: 's0/p686' }), { ref: 's0/p686', endRef: null, after: false, gone: false, count: 1 });
  assert.deepEqual(proposalPlace({ type: 'insert', status: 'applied', ref: 's0/p2', afterRef: 's0/p2', insertedRef: 's0/p3', split: { refs: ['s0/p3', 's0/p4', 's0/p5'] } }),
    { ref: 's0/p3', endRef: 's0/p5', after: false, gone: false, count: 3 });
  assert.equal(proposalPlace({ type: 'table', status: 'applied', ref: 's0/p2', afterRef: 's0/p2', insertedRef: 's0/p3' }).ref, 's0/p3');
  assert.equal(proposalPlace({ type: 'figure', status: 'applied', ref: 's0/p2', afterRef: 's0/p2', insertedRef: 's0/p3' }).ref, 's0/p3');
  assert.equal(proposalPlace({ type: 'insert', status: 'applied', ref: 's0/p2', insertedRef: null, insertedGone: true }).gone, true);
  // 되돌리면 다시 '그 뒤에 넣을 문단'
  assert.deepEqual(proposalPlace({ type: 'insert', status: 'undone', ref: 's0/p655', afterRef: 's0/p655', insertedRef: null }), { ref: 's0/p655', endRef: null, after: true, gone: false, count: 1 });
  assert.equal(proposalPlace({ type: 'insert', status: 'pending', ref: 's0/p9', afterRef: 's0/p9', lost: true }).gone, true);
});

test('바꿈·서식·그림 교체: 고칠 문단 그대로, 나눠 반영한 바꿈은 나뉜 마지막 문단까지, 문단이 지워졌으면 자리 없음', () => {
  assert.deepEqual(proposalPlace({ type: 'replace', status: 'pending', ref: 's0/p7' }), { ref: 's0/p7', endRef: null, after: false, gone: false, count: 1 });
  assert.deepEqual(proposalPlace({ status: 'applied', ref: 's0/p7', split: { refs: ['s0/p8', 's0/p9'] } }), { ref: 's0/p7', endRef: 's0/p9', after: false, gone: false, count: 3 });
  assert.equal(proposalPlace({ type: 'replace', status: 'undone', ref: 's0/p7', split: { refs: [] } }).endRef, null);
  assert.equal(proposalPlace({ type: 'figure', status: 'applied', ref: 's0/p4', figure: { replace: { n: 1 } } }).ref, 's0/p4');
  assert.equal(proposalPlace({ type: 'replace', status: 'applied', ref: 's0/p7', refGone: true }).gone, true);
  assert.equal(proposalPlace(null).gone, true);
});

test('덧붙여 넣은 본문 문단(extraRefs — 2026-11-17 표 단위 줄·주석, 문단 옮기기)도 넣은 범위에 든다', () => {
  // 표 + 아래 주석 문단 둘
  assert.deepEqual(proposalPlace({ type: 'table', status: 'applied', afterRef: 's0/p2', insertedRef: 's0/p3', captionRef: 's0/p3/n0', extraRefs: ['s0/p4', 's0/p5'] }),
    { ref: 's0/p3', endRef: 's0/p5', after: false, gone: false, count: 3 });
  // 위 단위 줄(표 앞) — 시작은 문서 차례로 첫 문단
  assert.deepEqual(proposalPlace({ type: 'table', status: 'applied', afterRef: 's0/p8', insertedRef: 's0/p10', extraRefs: ['s0/p9'] }),
    { ref: 's0/p9', endRef: 's0/p10', after: false, gone: false, count: 2 });
  // 지워진 덧붙임(null)은 빼고, 대기 중이면 쓰지 않는다
  assert.equal(proposalPlace({ type: 'table', status: 'applied', insertedRef: 's0/p3', extraRefs: [null], insertedGone: true }).gone, true);
  assert.deepEqual(proposalPlace({ type: 'table', status: 'pending', afterRef: 's0/p2', extraRefs: ['s0/p4'] }), { ref: 's0/p2', endRef: null, after: true, gone: false, count: 1 });
  // 바꿈 등 그 밖의 제안: 고친 문단부터 덧붙인 마지막 문단까지
  assert.deepEqual(proposalPlace({ type: 'replace', status: 'applied', ref: 's0/p7', extraRefs: ['s0/p8', 's0/p10'] }), { ref: 's0/p7', endRef: 's0/p10', after: false, gone: false, count: 3 });
  assert.deepEqual(proposalPlace({ type: 'replace', status: 'applied', ref: 's0/p7', extraRefs: [] }), { ref: 's0/p7', endRef: null, after: false, gone: false, count: 1 });
});

test('주소를 사람 말로 · 카드 한 줄', () => {
  assert.equal(refWords('s0/p686'), '위에서 687번째 문단');
  assert.equal(refWords('s1/p4'), '구역 2 · 위에서 5번째 문단');
  assert.equal(refWords('s0/p3/n5'), '위에서 4번째 문단 안(표·글상자)의 6번째 문단');
  assert.equal(refWords('여기'), '');
  assert.equal(placeNote({ after: true, count: 1 }, '새 문단', { many: '문단' }), '이 문단 뒤에 새 문단');
  assert.equal(placeNote({ after: false, count: 1 }, '새 문단', { many: '문단' }), '넣은 문단');
  assert.equal(placeNote({ after: false, count: 3 }, '새 문단', { many: '문단' }), '넣은 문단 3개');
  assert.equal(placeNote({ after: false, count: 1 }, '3×4 표'), '넣은 3×4 표');
  assert.equal(placeNote({ after: true, count: 1 }, '그림'), '이 문단 뒤에 그림');
});

test('서버 기록과 맞는가: 같은 문단 뒤에 넣는 제안 셋을 [모두 반영]하면 카드 자리가 넣은 문단 셋을 차례로 가리킨다', async (t) => {
  const user = { name: '자리 시험', role: 'admin' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-place-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hwpx-place-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const doc = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  doc.acceptAll();
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, tutorial: { enabled: false } }, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'place.hwpx', bytes: Buffer.from(await doc.save()), by: user.name, extra: { settings: { editMode: 'realtime', track: 'final' } } }).id;
  const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '끝에 덧붙이기', route: 'queue' }, user)).request;
  const body = async () => (await store.doc(id)).paragraphs({ view: 'final', nested: false });
  const last = (await body()).at(-1).ref; const n = Number(last.split('/p')[1]);
  const texts = ['덧붙인 하나', '덧붙인 둘', '덧붙인 셋'];
  const props = [];
  for (const text of texts) props.push(await service.propose(id, { rid: request.rid, afterRef: last, text }, user));
  // 반영 전: 셋 모두 같은 기준 문단 '뒤'
  for (const p of props) assert.deepEqual(proposalPlace(store.readMeta(id).proposals.find((x) => x.pid === p.pid)), { ref: last, endRef: null, after: true, gone: false, count: 1 });
  const out = await service.resolveRequest(id, request.rid, { apply: 'rest' }, user);
  assert.equal(out.counts.applied, 3);
  const now = await body();
  props.forEach((p, i) => {
    const rec = store.readMeta(id).proposals.find((x) => x.pid === p.pid);
    const place = proposalPlace(rec);
    assert.equal(place.ref, `s0/p${n + 1 + i}`, `#${p.pid} 의 자리`);
    assert.equal(place.after, false);
    assert.equal(now.find((x) => x.ref === place.ref).text, texts[i], '그 주소의 문단이 넣은 글');
    assert.equal(rec.ref, last, '제안할 때의 기준 문단은 기록에 그대로 남는다(카드에는 쓰지 않는다)');
  });
});
