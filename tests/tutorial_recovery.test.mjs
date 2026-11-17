import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { TutorialStore } from '../server/tutorial-store.js';
import { createTutorialRecovery } from '../server/tutorial-recovery.js';

const directory = (srv, id) => path.join(srv.dataDir, 'tutorial-sessions', 'docs', id);
const metaOf = (srv, id) => JSON.parse(fs.readFileSync(path.join(directory(srv, id), 'meta.json'), 'utf8'));
const writeMeta = (srv, id, value) => fs.writeFileSync(path.join(directory(srv, id), 'meta.json'), JSON.stringify(value));
const currentBytes = (srv, id) => fs.readFileSync(path.join(directory(srv, id), 'current.hwpx'));
const put = (api, id, i, ctx, revision) => api(`/api/tutorial/${id}/progress`, { method: 'PUT', body: { i, ctx, revision } });
const restore = (api, id, body) => api(`/api/tutorial/${id}/restore`, { method: 'POST', body });

test('단계 복구: HWPX·메모·첨부·ctx 일치, 새 기록·ID 단조증가, 실패 증거·이전 버전 보존과 재접속', { timeout: 90000 }, async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'report' } });
    const memo = await A(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '복구 기준 메모' } });
    const raw = await fetch(`${srv.base}/api/docs/${id}/attachments`, { method: 'POST',
      headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'baseline.txt' }, body: '기준 첨부' });
    assert.equal(raw.ok, true); const attachment = await raw.json();
    const baseline = currentBytes(srv, id);
    const p1 = await put(A, id, 2, { currentStepId: 'memo-step', memoId: memo.id, attachmentId: attachment.aid }, 0);
    assert.equal(p1.revision, 1); assert.ok(p1.checkpointId);
    await A(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '잘못 추가한 메모' } });
    await A(`/api/docs/${id}/attachments/${attachment.aid}`, { method: 'DELETE' });
    const old = metaOf(srv, id); old.seq.request = 21; old.seq.proposal = 32; old.seq.attachment = 8; writeMeta(srv, id, old);
    const p2 = await put(A, id, 3, { currentStepId: 'later', wrong: true }, p1.revision);
    const before = metaOf(srv, id); const versionFiles = fs.readdirSync(path.join(directory(srv, id), 'versions'));
    const operation = { checkpointId: p1.checkpointId, revision: p2.revision, operationId: 'restore-baseline-001' };
    const result = await restore(A, id, operation);
    assert.deepEqual(result.ctx, p1.ctx); assert.equal(result.i, 2);
    assert.equal(result.version, before.version + 1); assert.equal(result.revision, p2.revision + 1);
    assert.deepEqual(currentBytes(srv, id), baseline);
    const next = metaOf(srv, id);
    assert.deepEqual(next.seq, before.seq); assert.equal(typeof next.memoThreads, 'object');
    assert.equal((await A(`/api/docs/${id}/memos`)).length, 1);
    assert.equal((await A(`/api/docs/${id}/attachments`))[0].aid, attachment.aid);
    assert.equal(fs.readFileSync(path.join(directory(srv, id), 'attachments', attachment.file), 'utf8'), '기준 첨부');
    assert.equal(result.checkpoints.length, 1, '복구 뒤 도달하지 않은 단계의 옛 기준은 활성 목록에서 제외');
    for (const file of versionFiles) assert.ok(fs.existsSync(path.join(directory(srv, id), 'versions', file)));
    const archive = next.tutorialRestores[0].archiveId;
    assert.ok(fs.existsSync(path.join(directory(srv, id), 'tutorial-recovery', archive, 'document.hwpx')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory(srv, id), 'tutorial-recovery', archive, 'snapshot.json'))).meta.version, before.version);
    const duplicate = await restore(A, id, operation);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.version, result.version);
    const nextStage = await put(A, id, 3, { newRequest: 22 }, result.revision);
    assert.notEqual(nextStage.checkpointId, p2.checkpointId, '새 시도의 다음 단계는 새 ctx와 기준');
    await srv.restart();
    const resumed = await srv.api('a')(`/api/tutorial/${id}/progress`);
    assert.deepEqual(resumed.ctx, { newRequest: 22 }); assert.equal(resumed.revision, nextStage.revision);
  } finally { await srv.stop(); }
});

test('복구 API: 소유 토큰·완료본·일반문서 보호, CAS·동시중복·늦은 진행 저장 거절', { timeout: 90000 }, async () => {
  const srv = await startServer({ users: [{ name: '관리자', role: 'admin' }, { name: '같은이름' }, { name: '같은이름' }] });
  try {
    const A = srv.api('a'); const B = srv.api('b');
    const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: {} });
    const p = await put(A, id, 0, {}, 0);
    const body = { checkpointId: p.checkpointId, revision: p.revision, operationId: 'restore-concurrent-001' };
    for (const other of [B, srv.api('admin')]) assert.equal((await other.res(`/api/tutorial/${id}/restore`, { method: 'POST', body })).status, 404);
    const pair = await Promise.all([restore(A, id, body), restore(A, id, body)]);
    assert.equal(pair[0].version, pair[1].version); assert.ok(pair.some(x => x.duplicate));
    for (const revision of [undefined, 0, p.revision]) {
      const late = await A.res(`/api/tutorial/${id}/progress`, { method: 'PUT', body: { i: 1, ctx: { late: true }, revision } });
      assert.equal(late.status, revision === undefined ? 400 : 409);
    }
    assert.equal((await A.res(`/api/tutorial/${id}/restore`, { method: 'POST', body: { ...body, i: 2 } })).status, 409);
    const current = await A(`/api/tutorial/${id}/progress`);
    const conflicts = await Promise.all(['first-different-operation', 'second-different-operation'].map(operationId => A.res(`/api/tutorial/${id}/restore`, { method: 'POST', body: { ...body, operationId, revision: current.revision } })));
    assert.deepEqual(conflicts.map(x => x.status).sort(), [200, 409]);
    await A(`/api/tutorial/${id}/complete`, { method: 'POST', body: {} });
    const completed = fs.readFileSync(path.join(srv.dataDir, 'docs', id, 'current.hwpx'));
    assert.equal((await A.res(`/api/tutorial/${id}/restore`, { method: 'POST', body })).status, 409);
    assert.deepEqual(fs.readFileSync(path.join(srv.dataDir, 'docs', id, 'current.hwpx')), completed);
    const normal = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'), 'normal.hwpx');
    assert.equal((await A.res(`/api/tutorial/${normal.id}/restore`, { method: 'POST', body })).status, 404);
  } finally { await srv.stop(); }
});

test('모바일과 PC에서 단계 번호가 겹쳐도 행동별 문서 상태를 복구한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'clipboard' } });
    const tools = await put(A, id, 1, { currentStepId: 'copy/2/tools' }, 0);
    const memo = await A(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '선택 전에 달린 연습 메모' } });
    const select = await put(A, id, 2, { currentStepId: 'copy/2/select', memoId: memo.id }, tools.revision);
    // 이전 버전의 목록에는 행동 ID가 없고, 불변 사본에만 들어 있습니다.
    const old = metaOf(srv, id);
    for (const point of old.tutorialCheckpoints) delete point.stepId;
    writeMeta(srv, id, old);
    const desktop = await put(A, id, 1, { currentStepId: 'copy/3/select', memoId: memo.id }, select.revision);
    assert.equal(desktop.checkpointId, select.checkpointId);
    assert.notEqual(desktop.checkpointId, tools.checkpointId);
    const later = await put(A, id, 2, { currentStepId: 'copy/3/execute' }, desktop.revision);
    assert.notEqual(later.checkpointId, select.checkpointId);
    await A(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: '나중에 달린 연습 메모' } });
    const value = await restore(A, id, { i: 2, checkpointId: select.checkpointId, revision: later.revision, operationId: 'restore-desktop-step' });
    assert.equal(value.ctx.currentStepId, 'copy/2/select');
    assert.deepEqual(value.checkpoints.map(point => point.stepId), ['copy/tools', 'copy/select']);
    const memos = await A(`/api/docs/${id}/memos`);
    assert.deepEqual(memos.map(m => m.id), [memo.id]);
  } finally { await srv.stop(); }
});

test('실행 중 단계는 요청 전 안전 단계로 복구하고 기준 요청의 attempt와 새 ID 상한을 지킨다', { timeout: 90000 }, async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: {} });
    const meta = metaOf(srv, id);
    meta.requests.push({ rid: 1, status: 'done', by: srv.users.a.name, log: [{ action: 'retry' }], proposals: [], comments: [] });
    meta.seq.request = 1; writeMeta(srv, id, meta);
    const safe = await put(A, id, 1, { rid1: 1, currentStepId: 'send' }, 0);
    const active = metaOf(srv, id);
    active.requests[0].log.push({ action: 'retry' }, { action: 'retry' });
    active.requests.push({ rid: 2, status: 'working', by: srv.users.a.name, log: [], claim: { server: true, run: 'late-run' } });
    active.seq.request = 2; writeMeta(srv, id, active);
    const wait = await put(A, id, 2, { rid2: 2, currentStepId: 'wait' }, safe.revision);
    assert.equal(wait.checkpoints.find(x => x.i === 2).resumable, false);
    const result = await restore(A, id, { i: 2, revision: wait.revision, operationId: 'restore-inflight-001' });
    assert.deepEqual(result.recoveryFallback, { requestedI: 2, reason: 'AI_IN_FLIGHT' });
    assert.equal(result.i, 1); assert.deepEqual(result.ctx, safe.ctx);
    const restored = metaOf(srv, id);
    assert.equal(restored.requests.length, 1); assert.equal(restored.seq.request, 2);
    assert.equal(1 + restored.requests[0].log.filter(x => x.action === 'retry').length, 5);
    assert.equal(restored.requests[0].claim, null);
  } finally { await srv.stop(); }
});

test('불변 checkpoint 바이트가 손상되면 현재 문서와 진행을 바꾸지 않고 복구를 거절한다', { timeout: 90000 }, async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a'); const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: {} });
    const p = await put(A, id, 0, {}, 0); const before = currentBytes(srv, id);
    fs.appendFileSync(path.join(directory(srv, id), 'tutorial-recovery', p.checkpointId, 'document.hwpx'), 'tamper');
    const response = await A.res(`/api/tutorial/${id}/restore`, { method: 'POST', body: { i: 0, revision: p.revision, operationId: 'restore-corrupt-001' } });
    assert.equal(response.status, 409); assert.equal(response.data.error, 'TUTORIAL_CHECKPOINT_CORRUPT');
    assert.deepEqual(currentBytes(srv, id), before);
    assert.equal((await A(`/api/tutorial/${id}/progress`)).revision, p.revision);
  } finally { await srv.stop(); }
});

test('실제 예시 답변 실행 도중 복구한 뒤 도착한 AI 결과는 메모·제안·문서를 되살리지 않는다', { timeout: 90000 }, async () => {
  const srv = await startServer({ config: { tutorialExampleDelayMs: 3000 } });
  try {
    const A = srv.api('a'); const { docId: id } = await A('/api/tutorial/start', { method: 'POST', body: {} });
    const safe = await put(A, id, 0, { currentStepId: 'before-send' }, 0);
    const original = currentBytes(srv, id);
    let earlyResponse = null;
    const request = A.res(`/api/docs/${id}/requests`, { method: 'POST', body: {
      kind: 'instruct', instruction: '차례 새로고침해줘', route: 'queue', target: { ref: 's0/p20' },
    } }).then(value => { earlyResponse = value; return value; });
    const until = Date.now() + 5000;
    while (!metaOf(srv, id).requests.some(r => r.status === 'working')) {
      assert.equal(earlyResponse, null, `실행 중 복구를 확인하기 전에 요청이 끝남: ${JSON.stringify(earlyResponse)}`);
      assert.ok(Date.now() < until, '예시 답변 실행을 시작해야 한다');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const wait = await put(A, id, 1, { currentStepId: 'waiting' }, safe.revision);
    const restored = await restore(A, id, { i: 1, revision: wait.revision, operationId: 'restore-late-example-001' });
    const late = await request;
    assert.equal(late.ok, false); assert.equal(late.status, 404); assert.equal(late.data.error, 'NO_REQUEST');
    const final = metaOf(srv, id);
    assert.equal(final.version, restored.version);
    assert.equal(final.requests.length, 0); assert.equal(final.proposals.length, 0);
    assert.deepEqual(currentBytes(srv, id), original);
  } finally { await srv.stop(); }
});

test('누락 checkpoint asset은 내용 무변경 거절, commit 실패는 기존 undo 파일을 되돌리고 실패 사본을 보존한다', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-recovery-fault-'));
  try {
    const store = new TutorialStore(temp);
    const service = { store, _attempt: r => 1 + (r.log || []).filter(x => x.action === 'retry').length, hub: { broadcast() {} } };
    const recovery = createTutorialRecovery({ service });
    const bytes = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));
    const meta = store.create({ fileName: 'practice.hwpx', bytes, by: '시험', extra: { tutorialSession: true, tutorialOwnerKey: 'test-owner' } });
    const assetDir = path.join(store._docDir(meta.id), 'undo'); fs.mkdirSync(assetDir);
    const asset = path.join(assetDir, 'p1.hwpx'); fs.writeFileSync(asset, 'baseline-undo');
    const baseline = recovery.save(meta, { i: 0, ctx: {}, revision: 0 });
    const checkpointAsset = path.join(store._docDir(meta.id), 'tutorial-recovery', baseline.checkpointId, 'undo', 'p1.hwpx');
    fs.unlinkSync(checkpointAsset);
    const body = { i: 0, revision: baseline.revision, operationId: 'restore-fault-unit-001' };
    await assert.rejects(() => recovery.restore(store.readMeta(meta.id), body, { name: '시험' }), e => e.code === 'TUTORIAL_CHECKPOINT_CORRUPT');
    assert.equal(fs.readFileSync(asset, 'utf8'), 'baseline-undo');
    assert.deepEqual(store.currentBytes(meta.id), bytes);
    assert.equal(store.readMeta(meta.id).tutorialProgress.revision, baseline.revision);
    fs.writeFileSync(checkpointAsset, 'baseline-undo');
    fs.writeFileSync(asset, 'failed-state-undo');
    const commit = store.commit;
    store.commit = async () => { const e = new Error('simulated disk failure'); e.code = 'EIO'; throw e; };
    await assert.rejects(() => recovery.restore(store.readMeta(meta.id), body, { name: '시험' }), e => e.code === 'TUTORIAL_RESTORE_IO');
    store.commit = commit;
    assert.equal(fs.readFileSync(asset, 'utf8'), 'failed-state-undo', '커밋하지 못하면 기존 파일을 원상복원');
    assert.deepEqual(store.currentBytes(meta.id), bytes);
    assert.equal(store.readMeta(meta.id).tutorialProgress.revision, baseline.revision);
    const archives = fs.readdirSync(path.join(store._docDir(meta.id), 'tutorial-recovery')).filter(key => key !== baseline.checkpointId);
    assert.equal(archives.length, 1);
    const archive = path.join(store._docDir(meta.id), 'tutorial-recovery', archives[0]);
    assert.equal(fs.readFileSync(path.join(archive, 'undo', 'p1.hwpx'), 'utf8'), 'failed-state-undo');
    assert.equal(JSON.parse(fs.readFileSync(path.join(archive, 'restore-failed.json'))).committed, false);

    const currentFile = path.join(store._docDir(meta.id), 'current.hwpx');
    const beforeFailedRestore = Buffer.concat([bytes, Buffer.from('current-before-restore')]);
    fs.writeFileSync(currentFile, beforeFailedRestore);
    const saveMeta = store.saveMeta;
    store.saveMeta = () => { throw Object.assign(new Error('simulated metadata lock'), { code: 'EPERM' }); };
    await assert.rejects(() => recovery.restore(store.readMeta(meta.id), body, { name: '시험' }), e =>
      e.code === 'TUTORIAL_RESTORE_IO' && !e.extra.recoveryRequired);
    store.saveMeta = saveMeta;
    assert.deepEqual(store.currentBytes(meta.id), beforeFailedRestore, 'meta 쓰기 실패 시 현재 HWPX도 복구 전 바이트로 되돌린다');
    assert.equal(fs.readFileSync(asset, 'utf8'), 'failed-state-undo');
    assert.equal(store.readMeta(meta.id).tutorialProgress.revision, baseline.revision);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
