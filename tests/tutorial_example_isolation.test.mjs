// node --test tests/tutorial_example_isolation.test.mjs — 튜토리얼 예시 요청은 실제 AI 로 가지 않는다(2026-11-18 점검).
// 연습 문서의 새 요청은 고른 경로(auto·agent·server·queue)와 관계없이 '예시 답변'으로 끝나고, 'AI 작업 맡기기'에 미리 넣은 대기 예시(r.example)는
// 학습자 본인 실행기·관리자 실행기의 대기열 처리(claim_next)·직접 맡기(start)·결과 붙이기(제안)에 걸리지 않는다.
// 고치기 전에는 관리자 공유 AI 대상이 아닌 학습자(운영의 보통 계정)의 본인 실행기가 대기 예시를 맡았다. 실제 AI·외부 호출 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { TutorialStore as Store } from '../server/tutorial-store.js';
import { createTutorial } from '../server/tutorial.js';
import { EXAMPLE_AGENT } from '../server/tutorial-advanced.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const admin = { name: '관리자', role: 'admin' };
const learner = { name: '김학습', role: 'editor' };   // shareFrom·serverAi 아님 — 관리자 공유 AI 대상이 아닌 보통 계정
const P1 = '일정 부분 기여한 것으로 보인다';

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-isolation-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { tutorialExampleDelayMs: 0, root: ROOT, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: {}, allowAgentApply: true,
    users: [{ ...admin, token: 'admin-token' }, { ...learner, token: 'learner-token' }],
    // 운영과 같은 꼴: 관리자 실행기 공유(shareAgent)가 켜져 있어 연습 문서도 대기열 후보 목록에 오른다
    tutorial: { shareFrom: [admin.name], shareAgent: 'hwpx-api-worker', provider: 'claude-code', everyone: true, enabled: true } };
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const deliveries = [];
  // 학습자·관리자의 채널 실행기가 모두 붙어 있어도 쓰지 않아야 한다
  service.agents = { online: () => true, sessions: () => [], sendSession() { return true; }, deliver(name, type) { deliveries.push({ name, type }); return { session: `${name}-s`, agent: 'Codex' }; } };
  const tut = createTutorial({ service, config });
  return { service, tut, deliveries };
}

test('연습 문서의 새 요청은 고른 경로와 관계없이 예시 답변으로 끝나고 실행기에 전달되지 않는다', async (t) => {
  const { service, tut, deliveries } = setup(t);
  const { docId } = await tut.start(learner, { tutorialId: 'report' });
  const doc = await service.store.doc(docId);
  const p = doc.paragraphs({ view: 'final', nested: true }).find(x => String(x.text).includes(P1));
  const start = [...String(p.text).slice(0, String(p.text).indexOf(P1))].length;
  for (const route of ['auto', 'agent', 'server', 'queue']) {
    const res = await service.createRequest(docId, { kind: 'instruct', instruction: '‘보인다’ 말고, 적절한 표현으로', route,
      target: { ref: p.ref, start, end: start + [...P1].length, text: P1 } }, learner);
    assert.equal(res.route, 'example', route);
    const r = service._meta(docId).requests.find(x => x.rid === res.request.rid);
    assert.equal(r.example, true, route); assert.equal(r.handledBy, EXAMPLE_AGENT, route); assert.equal(r.usage ?? null, null, route);
  }
  assert.deepEqual(deliveries, []);
});

test('AI 작업 맡기기의 대기 예시는 학습자 본인·관리자 실행기가 맡거나 결과를 붙일 수 없다', async (t) => {
  const { service, tut } = setup(t);
  const { docId } = await tut.start(learner, { tutorialId: 'ai-requests' });
  const pending = service._meta(docId).requests.filter(r => r.status === 'pending');
  assert.ok(pending.length > 0, '대기 예시가 있어야 한다');
  assert.ok(pending.every(r => r.example === true));
  for (const who of [learner, admin]) {
    const claimed = await service.claimNextRequest(who, 'Codex', `${who.name}-s`);
    assert.equal(claimed?.none, true, `${who.name} 의 대기열 처리에 예시가 걸렸다`);
    await assert.rejects(service.startRequest(docId, pending[0].rid, who, 'Codex', { session: `${who.name}-s` }), e => e.code === 'REQUEST_CLOSED' && /예시 요청/.test(e.message));
  }
  const doc = await service.store.doc(docId);
  const p = doc.paragraphs({ view: 'final', nested: true }).find(x => String(x.text).trim().length > 4);
  await assert.rejects(service.proposeMany(docId, [{ ref: p.ref, find: [...String(p.text)].slice(0, 3).join(''), replace: '시험', reason: '시험' }], learner, 'Codex', { rid: pending[0].rid }),
    e => e.code === 'REQUEST_CLOSED');
  assert.ok(service._meta(docId).requests.filter(r => r.status === 'pending').every(r => !r.claim), '대기 예시가 그대로 대기여야 한다');
});
