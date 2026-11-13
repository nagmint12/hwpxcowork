// 모델·실제 문서 없이 문서 로딩 중 실행 취소/다음 회차가 겹치는 경합을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocumentOrchestration } from '../server/orchestration-service.js';

const user = { name: '경합 시험', role: 'editor' };
const session = 'test-conductor-session';

async function ready(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-orchestration-race-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^hwpx-orchestration-race-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const meta = { id: 'doc', version: 1 };
  let block = null;
  const writes = [];
  let orchestration;
  const service = {
    assertDocRead() {}, _meta: () => meta, _assertCanEdit() {},
    _tx: async (_id, fn) => fn(),
    async _load() {
      if (block) { block.enter(); await block.wait; }
      return { doc: {}, meta };
    },
    _ctx: () => ({}),
    _proposeCore() {
      const current = orchestration.getRun(user, run.id);
      writes.push({ status: current.status, round: current.round });
      return { pid: writes.length };
    },
    authorName: () => user.name,
    store: { log() {} },
    _finish: async () => 1,
    hub: { broadcast() {} },
  };
  orchestration = createDocumentOrchestration({ service, config: { dataDir: directory } });
  orchestration.saveProfile(user, { enabled: true });
  const run = orchestration.createRun(user, { doc_id: 'doc', goal: '시험 문서 개선' });
  const claim = orchestration.claim(user, { run_id: run.id, agent_id: 'codex', session });
  orchestration.plan(user, { run_id: run.id, session, lease_token: claim.lease_token, attempt: claim.attempt, tasks: [
    { id: 'draft', agent_id: 'claude-code', kind: 'work', title: '초안', instruction: '초안 작성', depends_on: [] },
    { id: 'final', agent_id: 'codex', kind: 'synthesize', title: '통합', instruction: '통합 작성', depends_on: ['draft'] },
  ] });
  const submit = (claim, result, by = session) => orchestration.submit(user, { run_id: run.id, task_id: claim.task.id, session: by, lease_token: claim.lease_token, attempt: claim.attempt, result });
  const draft = orchestration.claim(user, { run_id: run.id, agent_id: 'claude-code', session: 'worker-session' });
  submit(draft, { summary: '초안' }, 'worker-session');
  const synthesis = orchestration.claim(user, { run_id: run.id, agent_id: 'codex', session });
  submit(synthesis, { summary: '통합', proposals: [{ ref: 's0/p0', find: '원문', replace: '수정문' }] });
  return { orchestration, run, synthesis, writes, pauseLoading() {
    let enter; let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    block = { enter, wait };
    return { entered, release };
  } };
}

for (const action of ['cancel', 'revise']) {
  test(`발행 문서 로딩 중 ${action} 경합: 닫히거나 회차가 바뀐 실행 결과를 쓰지 않는다`, async t => {
    const x = await ready(t);
    const loading = x.pauseLoading();
    const publishing = x.orchestration.publish(user, { run_id: x.run.id, task_id: x.synthesis.task.id, session });
    await loading.entered;
    const advancing = Promise.resolve().then(() => x.orchestration.advance(user, { run_id: x.run.id, action, session }));
    // 동기 구현이면 advance가 먼저 끝나며, 직렬화 구현이면 발행 뒤까지 기다린다.
    await new Promise(resolve => setImmediate(resolve));
    loading.release();
    const outcomes = await Promise.allSettled([publishing, advancing]);
    assert.equal(outcomes[0].status, 'fulfilled', outcomes[0].reason?.message);
    assert.equal(x.writes.length, 1);
    assert.ok(x.writes.every(write => write.status === 'awaiting_review' && write.round === 1), JSON.stringify(x.writes));
  });
}
