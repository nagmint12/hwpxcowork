// AI 작업 해결로 생기는 사람용 버전(§9.4 kind 'request')의 간격 — docs/V4_SPEC.md §2.6(v0.4.x):
// 마지막 사람용 버전에서 config.documents.aiMilestoneMinutes(기본 30분)가 지나야 만든다. 그 전에 해결된 AI 작업의 적용은 다음 버전에 함께 담긴다
// (note = 마지막 버전 뒤로 기준에 적용된 제안이 있는 해결된 요청 모두와 그 적용 수의 합). 0 이면 예전처럼 해결마다.
// 서버를 띄우지 않고 Service.prototype._txMilestone 을 가짜 ctx 로 부른다(서버 흐름은 tests/api_resolve.mjs §7·§8, tests/api_live.mjs §10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Service } from '../server/service.js';

const MIN = 60 * 1000;
function svc(documents) { const s = Object.create(Service.prototype); s.cfg = documents === undefined ? {} : { documents }; return s; }
/** 마지막 이정표: n = 10, ago 분 전. 요청 #1(이미 해결 — 버전 뒤 적용 2건), #2(이번에 해결 — 적용 1건), #3(안 해결 — 적용 1건), #4(이번에 해결 — 적용은 버전 전) */
function ctxOf({ ago = 5, at, resolvedNow = [2] } = {}) {
  const meta = {
    version: 14,
    milestones: [{ v: 1, n: 1, at: new Date(Date.now() - 999 * MIN).toISOString(), kind: 'upload', note: '올림' },
      { v: 2, n: 10, at: at !== undefined ? at : new Date(Date.now() - ago * MIN).toISOString(), kind: 'manual', note: '버전 저장' }],
    proposals: [
      { pid: 1, status: 'applied', appliedVersion: 11 }, { pid: 2, status: 'applied', appliedVersion: 12 }, { pid: 3, status: 'rejected' },
      { pid: 4, status: 'applied', appliedVersion: 15 },
      { pid: 5, status: 'applied', appliedVersion: 13 }, { pid: 6, status: 'pending' },
      { pid: 7, status: 'applied', appliedVersion: 9 },
    ],
    requests: [
      { rid: 1, proposals: [1, 2, 3], resolvedAt: '2026-10-28T00:00:00.000Z' },
      { rid: 2, proposals: [4], resolvedAt: '2026-10-28T00:10:00.000Z' },
      { rid: 3, proposals: [5, 6], resolvedAt: null },
      { rid: 4, proposals: [7], resolvedAt: '2026-10-28T00:10:00.000Z' },
    ],
  };
  return { meta, milestone: null, resolvedNow: resolvedNow.map((rid) => ({ rid })) };
}

test('AI 작업 해결 버전: 마지막 버전에서 30분(기본) 안이면 만들지 않음', () => {
  assert.equal(svc()._txMilestone(ctxOf({ ago: 5 })), null);
  assert.equal(svc()._txMilestone(ctxOf({ ago: 29 })), null);
  assert.equal(svc()._aiMilestoneMs(), 30 * MIN);
});

test('AI 작업 해결 버전: 30분이 지나면 하나 — 그동안 쌓인 적용(이미 해결된 요청 + 이번 요청)을 note 에, 안 해결된 요청은 글에서 뺌', () => {
  const ms = svc()._txMilestone(ctxOf({ ago: 31 }));
  assert.deepEqual(ms, { kind: 'request', note: 'AI 작업 #1·#2 해결 — 적용 3건' });
});

test('AI 작업 해결 버전: 이번에 해결된 요청에 마지막 버전 뒤 적용이 없으면 시간이 지나도 만들지 않음', () => {
  assert.equal(svc()._txMilestone(ctxOf({ ago: 120, resolvedNow: [4] })), null);
  assert.equal(svc()._txMilestone(ctxOf({ ago: 120, resolvedNow: [] })), null);
});

test('AI 작업 해결 버전: config.documents.aiMilestoneMinutes — 0 이면 해결마다, 숫자면 그 분, 이상한 값은 기본 30', () => {
  assert.deepEqual(svc({ aiMilestoneMinutes: 0 })._txMilestone(ctxOf({ ago: 0 })), { kind: 'request', note: 'AI 작업 #1·#2 해결 — 적용 3건' });
  assert.equal(svc({ aiMilestoneMinutes: 10 })._txMilestone(ctxOf({ ago: 9 })), null);
  assert.equal(svc({ aiMilestoneMinutes: 10 })._txMilestone(ctxOf({ ago: 11 }))?.kind, 'request');
  for (const bad of [-1, '0', null, NaN, Infinity]) assert.equal(svc({ aiMilestoneMinutes: bad })._aiMilestoneMs(), 30 * MIN, String(bad));
  assert.equal(svc(null)._aiMilestoneMs(), 30 * MIN);
});

test('AI 작업 해결 버전: 시각을 읽을 수 없는 옛 이정표는 지난 것으로 봄 · ctx.milestone(반영·복구·올림)은 간격과 상관없이 이김', () => {
  assert.equal(svc()._txMilestone(ctxOf({ at: null }))?.kind, 'request');
  const c = ctxOf({ ago: 1 }); c.milestone = { kind: 'merge', note: '변경 요청 #1 반영' };
  assert.deepEqual(svc()._txMilestone(c), { kind: 'merge', note: '변경 요청 #1 반영' });
});
