// AI 사용량 보고(server/usage-report.js): 제공자별 입력 셈, 단가 찾기, 기간·AI별 합계
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceKey, splitTokens, costOf, usageReport } from '../server/usage-report.js';

test('모델 이름 → 단가 표 이름(앞머리·날짜 꼬리·별칭)', () => {
  assert.equal(priceKey('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(priceKey('openai/GPT-6.1-Sol'), 'gpt-6.1-sol');
  assert.equal(priceKey('claude-opus-5-5-20261101'), 'claude-opus-5-5');
  assert.equal(priceKey('claude-opus-5'), 'claude-opus-5');   // claude-opus-5-5 로 잘못 붙지 않는다
  assert.equal(priceKey('opus'), 'claude-opus-5-5');
  assert.equal(priceKey('gemini-9-pro'), null);
  assert.equal(priceKey(''), null);
});

test('입력 셈: OpenAI 는 input 에 캐시가 들어 있고 Claude 는 따로다', () => {
  // 14:47 운영 Codex 실행(gpt-6.1-sol): 입력 39,023 · 캐시 32,256 · 출력 206
  const g = splitTokens({ input: 39023, output: 206, cacheRead: 32256 }, 'gpt-6.1-sol');
  assert.deepEqual(g, { fresh: 6767, cacheRead: 32256, cacheWrite: 0, input: 39023, output: 206 });
  // 같은 날 손으로 낸 환산 $0.0188(새 입력×2 + 캐시×0.1 + 출력×10, 100만 토큰당)
  assert.equal(costOf(g, 'gpt-6.1-sol').toFixed(5), '0.01882');
  const c = splitTokens({ input: 1000, output: 500, cacheRead: 20000, cacheWrite: 3000 }, 'claude-opus-5-5');
  assert.deepEqual(c, { fresh: 1000, cacheRead: 20000, cacheWrite: 3000, input: 24000, output: 500 });
  assert.equal(costOf(c, 'claude-opus-5-5'), (1000 * 4 + 20000 * 0.2 + 3000 * 5 + 500 * 20) / 1e6);
  assert.equal(splitTokens(null, 'gpt-6.1-sol'), null);
  assert.equal(costOf(g, null), null);
});

test('보고서: AI 가 맡은 요청만, 최근 것부터, 기간·날짜·AI별 합계와 단가 없는 모델', () => {
  const now = new Date('2026-11-16T07:00:00Z');   // 한국 16:00
  const metas = [
    { id: 'd1', title: '문서 1', requests: [
      { rid: 1, at: '2026-11-16T05:47:52.933Z', doneAt: '2026-11-16T05:48:06.924Z', status: 'done', label: '지시', by: '관리자', handledBy: 'ChatGPT Codex', model: 'gpt-6.1-sol', usage: { input: 39023, output: 206, cacheRead: 32256 }, proposals: [1] },
      { rid: 2, at: '2026-11-15T16:30:00Z', status: 'done', label: '지시', handledBy: 'Claude Code', model: null },   // 한국 11-16 01:30, 사용량 없음
      { rid: 3, at: '2026-11-16T01:00:00Z', status: 'pending', label: '지시' },   // 사람·대기 — 빼기
      { rid: 4, at: '2026-11-16T02:00:00Z', status: 'done', label: '지시', handledBy: '예시 답변', model: '예시 답변', example: true, usage: { modelCalls: 0 } },   // 튜토리얼 예시 — 빼기
    ] },
    { id: 'd2', title: '문서 2', requests: [
      { rid: 1, at: '2026-11-01T00:00:00Z', doneAt: '2026-11-01T00:01:40Z', status: 'done', label: '지시', handledBy: 'API', model: 'gemini-9-pro', usage: { input: 1000, output: 10 } },
      { rid: 2, at: '2026-10-20T00:00:00Z', status: 'failed', label: '지시', handledBy: 'API', model: 'claude-sonnet-5-5', usage: { input: 100, output: 100, cacheRead: 900 } },
    ] },
  ];
  const r = usageReport(metas, { now });
  assert.deepEqual(r.rows.map((x) => `${x.docId}#${x.rid}`), ['d1#1', 'd1#2', 'd2#1', 'd2#2']);
  assert.equal(r.rows[0].seconds, 14);
  assert.equal(r.rows[1].tokens, null);
  assert.equal(r.totals.today.requests, 2);   // d1#1 + d1#2(사용량 없음도 요청으로 센다)
  assert.equal(r.totals.today.input, 39023);
  assert.equal(r.totals.month.requests, 3);
  assert.equal(r.totals.all.requests, 4);
  assert.equal(r.totals.month.unpriced, 1);
  const sonnet = (100 * 2 + 900 * 0.1 + 100 * 10) / 1e6;
  assert.ok(Math.abs(r.totals.all.cost - (costOf(splitTokens(metas[0].requests[0].usage, 'gpt-6.1-sol'), 'gpt-6.1-sol') + sonnet)) < 1e-12);
  assert.equal(r.days.length, 14);
  assert.equal(r.days.at(-1).date, '2026-11-16');
  assert.equal(r.days.at(-1).requests, 2);
  assert.deepEqual(r.missingPrices, ['gemini-9-pro']);
  const claude = r.byAi.find((a) => a.agent === 'Claude Code');
  assert.equal(claude.noUsage, 1);
});
