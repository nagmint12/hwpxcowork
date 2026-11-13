// node --test tests/tutorial_tracked.test.mjs — 변경 추적(실시간 '변경 추적으로') 문서에서 튜토리얼 반영·되돌리기(2026-11-04).
// 1번 튜토리얼: 반영한 제안이 넣은 글 안을 다시 고치는 제안(엔진 OVERLAP)·넣은 글에 단 메모(되돌릴 때 CTRL_INSIDE)·차례 새로 고침.
// 6번 튜토리얼: 5작업을 모두 반영 → 거꾸로/앞에서부터 모두 되돌리면 원문. '고친 글만' 문서와 같은 결과여야 한다. 임시 저장소만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { TutorialStore as Store } from '../server/tutorial-store.js';
import { HwpxDoc } from '../engine/doc.js';
import { ADVANCED_TASKS } from '../web/tutorial-advanced-tasks.js';
import { withTrackChangeOn } from '../server/tutorial-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const admin = { name: '관리자', role: 'admin' };
const texts = (d) => d.paragraphs({ view: 'final', nested: true }).map((p) => `${p.ref}\t${p.text}`);

async function setup(t, file, track, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tut-trk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { tutorialExampleDelayMs: 0, root: ROOT, configFile: path.join(tmp, 'c.json'), dataDir: path.join(tmp, 'data'), ai: {}, agents: {} };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const settings = { ...service._normSettings(null), editMode: 'realtime', aiApply: 'manual', track, exportKind: track };
  let bytes = fs.readFileSync(path.join(ROOT, 'tutorial', file));
  if (track === 'tracked') bytes = await withTrackChangeOn(bytes);
  const id = store.create({ fileName: 'p.hwpx', bytes, by: admin.name, extra: { ...extra, settings } }).id;
  assert.equal((await store.doc(id)).header.trackingEnabled(), track === 'tracked', '실제 HWPX 추적 옵션도 시험 설정과 일치');
  return { service, store, id };
}

for (const track of ['final', 'tracked']) {
  test(`1번 흐름(${track}): 넣은 글 안을 다시 고치는 제안·그 글의 메모·차례 새로 고침을 반영하고 거꾸로 되돌리면 원문`, async (t) => {
    const { service, store, id } = await setup(t, '결과보고서.hwpx', track);
    const orig = texts(await store.doc(id));
    const ref = (await store.doc(id)).paragraphs({ view: 'final' }).find((x) => x.text.includes('일정 부분 기여한')).ref;
    const A = '본 사업은 교육과정 개선을 통해 학생 만족도 향상에 일정 부분 기여한 것으로 보인다.';
    const B = '사업 추진 후 학생 만족도는 전 영역에서 전년보다 높아졌으며, 수업 구성과 과제 부담은 각각 0.3점, 평가 공정성은 0.1점 올랐다(「영역별 만족도」 표).';
    const r = await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '고쳐', route: 'queue' }, admin);
    const propose = async (item) => (await service.proposeMany(id, [item], admin, 'Claude Code', { rid: r.request.rid }))[0].proposal;
    const p1 = await propose({ ref, find: A, replace: B, reason: 'r1' });
    await service.applyProposal(id, p1.pid, admin);
    const now = (await store.doc(id)).text(ref, 'final'); const k = [...now.slice(0, now.indexOf('학생 만족도'))].length;
    await service.addMemo(id, { ref, start: k, end: k + 6, text: '근거로 [표 1]을 함께 제시해 주세요.' }, admin);
    const p2 = await propose({ ref, find: '(「영역별 만족도」 표)', replace: '([표 1] 참조)', reason: 'r2' });
    await service.applyProposal(id, p2.pid, admin);   // 변경 추적 문서: 예전에는 OVERLAP
    assert.match((await store.doc(id)).text(ref, 'final'), /\(\[표 1\] 참조\)\.$/);
    const p3 = await propose({ type: 'toc', toc: {}, reason: '차례' });
    await service.applyProposal(id, p3.pid, admin);
    assert.ok(await HwpxDoc.load(store.currentBytes(id)), '저장본을 다시 읽을 수 있다');
    for (const p of [p3, p2, p1]) await service.undoProposal(id, p.pid, admin);   // 메모가 든 넣은 글: 예전에는 CTRL_INSIDE
    assert.deepEqual(texts(await store.doc(id)), orig);
    const left = (await store.doc(id)).changes();
    assert.equal(left.length, 0, JSON.stringify(left.slice(0, 6).map((c) => [c.id, c.type, c.kind, c.ref, c.author, String(c.text || '').slice(0, 30)])));
  });

  for (const order of ['reverse', 'forward']) {
    test(`6번 5작업(${track}, ${order}): 모두 반영 → 모두 되돌리면 원문, 저장본을 다시 읽는다`, { timeout: 180000 }, async (t) => {
      const { service, store, id } = await setup(t, 'AI 활용 심화 — 연습 보고서.hwpx', track, { tutorialOwnAi: true, tutorialId: 'ai-advanced' });
      const orig = texts(await store.doc(id));
      for (const task of ADVANCED_TASKS) {
        await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: task.prompt, tutorialStep: task.id }, admin);
        const r = service._meta(id).requests.at(-1);
        const res = await service.resolveRequest(id, r.rid, { apply: 'rest' }, admin);
        assert.equal(res.counts.failed, 0, `${task.id}: ${JSON.stringify(res.results.filter((x) => !x.ok))}`);
      }
      const applied = service._meta(id).proposals.filter((p) => p.status === 'applied').map((p) => p.pid);
      assert.equal(applied.length, 47);
      for (const pid of order === 'reverse' ? [...applied].reverse() : applied) await service.undoProposal(id, pid, admin);
      const d = await store.doc(id);
      assert.deepEqual(texts(d), orig);
      assert.equal(d.changes().length, 0);
      assert.deepEqual(texts(await HwpxDoc.load(store.currentBytes(id))), orig);
    });
  }
}

test('변경 추적 겹침 처리의 범위: 같은 문단의 겹치지 않는 남의 변경은 그대로, 되돌린 뒤 autoAccepted 는 지운다', async (t) => {
  const { service, store, id } = await setup(t, '결과보고서.hwpx', 'tracked');
  const d0 = await store.doc(id);
  const ref = d0.paragraphs({ view: 'final' }).find((x) => x.text.includes('일정 부분 기여한')).ref;
  const r = await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '고쳐', route: 'queue' }, admin);
  const propose = async (item) => (await service.proposeMany(id, [item], admin, 'Claude Code', { rid: r.request.rid }))[0].proposal;
  // 남의 변경(문단 앞쪽 '본 사업은' → '이 사업은')과 겹치지 않는 뒤쪽을 제안 #1 이 고치고, #2 가 #1 이 넣은 글 안을 고친다
  const other = await propose({ ref, find: '본 사업은', replace: '이 사업은', reason: '남' });
  await service.applyProposal(id, other.pid, { name: '다른사람', role: 'admin' });
  const p1 = await propose({ ref, find: '일정 부분 기여한 것으로 보인다', replace: '만족도 향상에 기여함(「영역별 만족도」 표)', reason: 'r1' });
  await service.applyProposal(id, p1.pid, admin);
  const p2 = await propose({ ref, find: '(「영역별 만족도」 표)', replace: '([표 1] 참조)', reason: 'r2' });
  await service.applyProposal(id, p2.pid, admin);
  const meta = service._meta(id);
  assert.ok(meta.proposals.find((p) => p.pid === other.pid).changeIds.length > 0, '겹치지 않는 남의 변경은 수락하지 않는다');
  assert.equal(meta.proposals.find((p) => p.pid === p1.pid).autoAccepted, true);
  for (const p of [p2, p1]) await service.undoProposal(id, p.pid, admin);
  assert.equal(service._meta(id).proposals.find((p) => p.pid === p1.pid).autoAccepted, undefined);
  assert.match((await store.doc(id)).text(ref, 'final'), /^이 사업은 .*일정 부분 기여한 것으로 보인다\.$/);
});

test('승인 방식 문서는 넣은 글 안 메모가 든 되돌리기를 예전처럼 막는다(CTRL_INSIDE)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tut-trk-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { root: ROOT, configFile: path.join(tmp, 'c.json'), dataDir: path.join(tmp, 'data'), ai: {}, agents: {}, changeRequests: { allowDirectApply: true } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'p.hwpx', bytes: fs.readFileSync(path.join(ROOT, 'tutorial', '결과보고서.hwpx')), by: admin.name, extra: { settings: { ...service._normSettings(null), editMode: 'review' } } }).id;
  const ref = (await store.doc(id)).paragraphs({ view: 'final' }).find((x) => x.text.includes('일정 부분 기여한')).ref;
  const p = await service.propose(id, { ref, find: '일정 부분 기여한 것으로 보인다', replace: '기여함', reason: 'r', memo: false }, admin);
  await service.applyProposal(id, p.pid, admin);
  const now = (await store.doc(id)).text(ref, 'final'); const k = [...now.slice(0, now.indexOf('기여함'))].length;
  await service.addMemo(id, { ref, start: k, end: k + 2, text: '메모' }, admin);
  await assert.rejects(service.undoProposal(id, p.pid, admin), { code: 'CTRL_INSIDE' });
});
