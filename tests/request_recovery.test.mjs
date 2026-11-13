import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { Service } from '../server/service.js';
import { fixture, startServer, uploadDoc } from './helpers/server.mjs';

const user = { name: 'owner', role: 'admin' };
async function setup(t, { finish = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, tutorial: { enabled: false } },
    hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'test.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  const doc = await store.doc(id); const ref = 's0/p2'; const text = doc.text(ref, 'final');
  const r = (await service.createRequest(id, { kind: 'instruct', target: { ref }, instruction: '문장을 간결하게', route: 'queue' }, user)).request;
  const p = await service.propose(id, { rid: r.rid, ref, find: text, replace: '원래 의도에 맞춘 수정' }, user);
  if (finish) await service.completeRequest(id, r.rid, { summary: '검토 완료' }, user);
  return { store, service, id, r, p, ref, text };
}

test('사라진 대상도 현재 문서 전체를 다시 읽게 요청하며, 이미 반영한 제안은 다시 보내지 않는다', async t => {
  const { store, service, id, r, p, ref } = await setup(t, { finish: false });
  const applied = await service.propose(id, { rid: r.rid, afterRef: ref, text: '이미 반영한 문단' }, user);
  await service.applyProposal(id, applied.pid, user);
  await service.completeRequest(id, r.rid, { summary: '검토 완료' }, user);
  const meta = store.readMeta(id); const old = meta.proposals.find(x => x.pid === p.pid);
  old.lost = true; old.ref = null; store.saveMeta(meta);
  const out = await service.recoverRequest(id, r.rid, user);
  assert.equal(out.route, 'queue'); assert.equal(out.request.target.scope, 'document');
  assert.deepEqual(out.request.recoveryOf, { rid: r.rid, pids: [p.pid] });
  assert.match(out.request.instruction, /임의의 문단에 넣지 말고/);
  const context = JSON.parse(out.request.instruction.slice(out.request.instruction.indexOf('{')));
  assert.deepEqual(context.remainingProposals.map(x => x.pid), [p.pid]);
  assert.equal(store.readMeta(id).proposals.find(x => x.pid === p.pid).status, 'pending');
  await assert.rejects(service.recoverRequest(id, r.rid, user), { code: 'RECOVERY_PENDING' });
});

test('새 검토 성공 뒤에만 이전 제안을 보관하며 자동 반영 없이 새 제안을 검토한다', async t => {
  const { store, service, id, r, p, ref, text } = await setup(t);
  const out = await service.recoverRequest(id, r.rid, user); const next = out.request;
  const q = await service.propose(id, { rid: next.rid, ref, find: text, replace: '현재 문서에 맞춘 수정' }, user);
  const meta = store.readMeta(id); meta.settings = { aiApply: 'auto' }; store.saveMeta(meta);
  await service.completeRequest(id, next.rid, { summary: '현재 문서로 다시 검토' }, user);
  const after = store.readMeta(id);
  assert.equal(after.proposals.find(x => x.pid === p.pid).status, 'superseded');
  assert.equal(after.proposals.find(x => x.pid === p.pid).supersededByRequest, next.rid);
  assert.equal(after.proposals.find(x => x.pid === q.pid).status, 'pending');
  assert.equal((await store.doc(id)).text(ref, 'final'), text);
  await service.reopenProposal(id, p.pid, user);
  assert.equal(store.readMeta(id).proposals.find(x => x.pid === p.pid).status, 'pending');
});

test('재검토 실패·빈 답변이면 이전 제안을 유지하고 남의 요청은 다시 보내지 않는다', async t => {
  const { store, service, id, r, p } = await setup(t);
  await assert.rejects(service.recoverRequest(id, r.rid, { name: 'other', role: 'editor' }), { code: 'FORBIDDEN' });
  const next = (await service.recoverRequest(id, r.rid, user)).request;
  await service.startRequest(id, next.rid, user);
  await service.failRequest(id, next.rid, { error: '연결 실패' }, user);
  assert.equal(store.readMeta(id).proposals.find(x => x.pid === p.pid).status, 'pending');
  const empty = (await service.recoverRequest(id, r.rid, user)).request;
  await service.completeRequest(id, empty.rid, { summary: '대상 위치 확인 필요', noChangesReason: '대상 위치를 확인하지 못해 고칠 곳 없음' }, user);
  assert.equal(store.readMeta(id).proposals.find(x => x.pid === p.pid).status, 'pending');
});

test('HTTP 재검토 경로는 요청자 권한을 확인하고 새 요청으로 연결한다', async () => {
  const srv = await startServer({ config: { tutorial: { enabled: false } } });
  try {
    const api = srv.api('admin'); const other = srv.api('b');
    const { id } = await uploadDoc(srv.base, srv.tokens.admin, fs.readFileSync(fixture('tool_memo_tracked.hwpx')));
    const base = `/api/docs/${id}`;
    const { request } = await api(`${base}/requests`, { method: 'POST', body: { kind: 'instruct', target: { ref: 's0/p2' }, instruction: '검토', route: 'queue' } });
    await api(`${base}/proposals`, { method: 'POST', body: { rid: request.rid, afterRef: 's0/p2', text: '검토할 내용' } });
    await api(`${base}/requests/${request.rid}/cancel`, { method: 'POST' });
    assert.equal((await other.res(`${base}/requests/${request.rid}/recover`, { method: 'POST' })).status, 403);
    const out = await api(`${base}/requests/${request.rid}/recover`, { method: 'POST' });
    assert.equal(out.request.recoveryOf.rid, request.rid);
  } finally { await srv.stop(); }
});

test('관리자가 대신 재검토해도 원요청자는 새 결과를 확인하고 반영할 수 있다', async t => {
  const { service, id, r } = await setup(t);
  const out = await service.recoverRequest(id, r.rid, { name: 'review admin', role: 'admin' });
  const owner = { name: user.name, role: 'editor' };
  const view = await service.getRequestView(id, out.request.rid, owner);
  assert.equal(view.recoveryOwner, user.name); assert.equal(view.instructionHidden, false);
  assert.ok((await service.mcpListRequests(id, { mine: true, status: 'all' }, owner)).some(x => x.rid === out.request.rid));
  await service.patchRequest(id, out.request.rid, { summary: '원요청자가 확인' }, owner);
  assert.equal((await service.getRequestView(id, out.request.rid, owner)).summary, '원요청자가 확인');
});
