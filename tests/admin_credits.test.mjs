// 관리자 'AI 크레딧'(server/routes/admin.js aiCredits · personal-ai credits · ai.js gatewayCredits/gatewayUsage):
// API 잔액·사용량은 GET 만(과금 없음), 같은 계정의 키는 한 묶음, 체험 공유 키 표시, 키 없음·조회 실패. 실제 API 는 부르지 않는다(가짜 fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AiProposer } from '../server/ai.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { installAdminRoutes, aiCredits } from '../server/routes/admin.js';

// 개인 키 저장은 키 형식을 본다 — 시험용 긴 키(끝 4자가 화면에 보이는 키 표시)
const K1 = 'baze_TEST_KEY_ONE_abcdK001'; const K2 = 'baze_TEST_KEY_TWO_abcdK002'; const GONE = 'baze_TEST_KEY_GONE_abcGONE';
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const BALANCE = { object: 'credit_balance', monthly_allocated: { quota: 10000, used: 10009.7885, remaining: 0, renewal_date: '2026-12-01T00:00:00+09:00' },
  purchased: { quota: 0, used: 0, remaining: 0 }, org_granted: { quota: 0, used: 0, remaining: 0 }, total: { quota: 10000, used: 10009.79, remaining: 0 } };
const usage = (scope, rows) => ({ object: 'usage_summary', start_date: '2026-11-01', end_date: '2026-11-04', timezone: 'Asia/Seoul', group_by: 'day', scope,
  total: { call_count: rows.reduce((a, r) => a + r[1], 0), credits: rows.reduce((a, r) => a + r[2], 0) }, rows: rows.map(([key, call_count, credits]) => ({ key, call_count, credits })) });

/** 키마다 응답을 고르는 가짜 API — 부른 것을 seen 에 남긴다 */
function fakeGateway(byKey) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const auth = init.headers?.Authorization || '';
    seen.push({ method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), auth });
    const k = byKey[auth.replace(/^Bearer /, '')];
    if (!k) return json({ detail: 'Unauthorized' }, 401);
    if (u.pathname === '/v1/gateway/credits/') return json(k.balance);
    if (u.pathname === '/v1/gateway/usage/') return json(u.searchParams.get('scope') === 'member' ? k.member : k.key);
    return json({ detail: 'Not Found' }, 404);
  };
  return { seen, fetchImpl };
}

function setup(t, fetchImpl, ai = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-admin-credits-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { maxProposals: 10, ...ai }, tutorial: { shareFrom: ['관리자', '공유자'], users: ['test1'] } };
  return { config, personal: createPersonalAi({ config, fetchImpl, log() {} }) };
}

test('gatewayCredits·gatewayUsage: GET 만, Bearer 키, 기간·묶음·범위를 질의로, 응답을 정리한다', async () => {
  const { seen, fetchImpl } = fakeGateway({ K1: { balance: BALANCE, key: usage('key', [['2026-11-03', 45, 1252.61]]), member: usage('member', []) } });
  const ai = new AiProposer({ ai: { provider: 'openai', gateway: 'baze', model: 'gpt-6.1-sol' } }, { key: 'K1', fetch: fetchImpl });
  const b = await ai.gatewayCredits();
  assert.deepEqual(b.monthly, { quota: 10000, used: 10009.7885, remaining: 0 });
  assert.equal(b.renewalDate, '2026-12-01T00:00:00+09:00'); assert.equal(b.total.remaining, 0);
  const u = await ai.gatewayUsage({ from: '2026-11-01', to: '2026-11-04' });
  assert.deepEqual(u.rows, [{ key: '2026-11-03', calls: 45, credits: 1252.61 }]);
  assert.deepEqual(seen.map((s) => s.method), ['GET', 'GET'], '생성 호출(POST)은 하지 않는다');
  assert.deepEqual(seen[1].query, { from: '2026-11-01', to: '2026-11-04', by: 'day', scope: 'key' });
  assert.equal(seen[0].auth, 'Bearer K1');
  // 삭제한 키(401)
  const gone = new AiProposer({ ai: { provider: 'openai', gateway: 'baze', model: 'gpt-6.1-sol' } }, { key: 'GONE', fetch: fetchImpl });
  await assert.rejects(gone.gatewayCredits(), /삭제된 키/);
  // API가 아닌 키는 묻지 않는다
  const direct = new AiProposer({ ai: { provider: 'openai', model: 'gpt-x' } }, { key: 'K1', fetch: fetchImpl });
  await assert.rejects(direct.gatewayCredits(), /API 키에서만/);
  assert.equal(seen.length, 3);
});

test('credits: 이번 달(한국 시각) 1일부터, 1분 안에는 다시 묻지 않고 refresh 면 새로', async (t) => {
  const g = fakeGateway({ [K1]: { balance: BALANCE, key: usage('key', [['2026-12-01', 2, 3.5]]), member: usage('member', [['2026-12-01', 2, 3.5]]) } });
  const s = setup(t, g.fetchImpl);
  s.personal.save({ name: '관리자' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K1 });
  const now = new Date('2026-11-30T16:30:00Z');   // 한국 시각 12월 1일 01:30
  const c = await s.personal.credits('관리자', { now });
  assert.equal(c.usage.from, '2026-12-01'); assert.equal(c.usage.to, '2026-12-01');
  assert.deepEqual(c.usage.days, [{ date: '2026-12-01', calls: 2, credits: 3.5 }]);
  assert.equal(g.seen.length, 3);   // 잔액 + 키 사용량 + 계정 사용량
  assert.deepEqual(g.seen.filter((x) => x.path === '/v1/gateway/usage/').map((x) => x.query.scope).sort(), ['key', 'member']);
  await s.personal.credits('관리자', { now });
  assert.equal(g.seen.length, 3, '1분 안에는 앞의 답');
  await s.personal.credits('관리자', { now, refresh: true });
  assert.equal(g.seen.length, 6);
  await assert.rejects(s.personal.credits('없는사람'), { code: 'NO_PERSONAL_AI' });
});

test('aiCredits: 같은 계정의 키는 한 묶음, 체험 공유 키·그 밖 사용, 키 없는 공유자와 조회 실패는 따로', async (t) => {
  const member = usage('member', [['2026-11-01', 61, 574.57], ['2026-11-04', 234, 5114.92]]);
  const g = fakeGateway({
    [K1]: { balance: BALANCE, key: usage('key', [['2026-11-01', 61, 574.57], ['2026-11-04', 234, 5114.92]]), member },
    [K2]: { balance: BALANCE, key: usage('key', []), member },
  });
  const s = setup(t, g.fetchImpl);
  s.personal.save({ name: '공유자' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K2 });
  s.personal.save({ name: '나' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K1 });
  const r = await aiCredits(s.personal, s.config, '나');
  assert.equal(r.accounts.length, 1, '잔액이 같은 키 = 같은 계정');
  const a = r.accounts[0];
  assert.equal(a.apiCredits, 5689.49); assert.equal(a.otherCredits, 4320.3);
  assert.deepEqual(a.keys.map((k) => [k.owner, k.keyHint, k.sharing, k.me]), [['공유자', '…K002', true, false], ['나', '…K001', false, true]]);
  assert.equal(a.keys[1].usage.calls, 295);
  assert.deepEqual(r.others.map((k) => [k.owner, k.configured, k.shared]), [['관리자', false, true]], '공유 목록에 있지만 키를 지운 사람');
  assert.ok(!JSON.stringify(r).includes(K1) && !JSON.stringify(r).includes(K2), '키 원문은 싣지 않는다(끝 몇 자만)');
  // 키가 삭제돼(401) 조회 실패
  s.personal.save({ name: '관리자' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: GONE });
  const r2 = await aiCredits(s.personal, s.config, '나');
  const bad = r2.others.find((k) => k.owner === '관리자');
  assert.equal(bad.configured, true); assert.match(bad.error, /삭제된 키/);
  assert.equal(r2.accounts[0].keys.find((k) => k.owner === '공유자').sharing, false, '체험 공유는 shareFrom 의 첫 키(관리자)');
  assert.ok(g.seen.every((x) => x.method === 'GET'));
});

test('모의 AI 서버에서는 잔액을 묻지 않는다', async (t) => {
  const g = fakeGateway({ [K1]: { balance: BALANCE, key: usage('key', []), member: usage('member', []) } });
  const s = setup(t, g.fetchImpl, { mock: true });
  s.personal.save({ name: '나' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K1 });
  const r = await aiCredits(s.personal, s.config, '나');
  assert.equal(r.accounts.length, 0);
  assert.match(r.others.find((k) => k.owner === '나').error, /부르지 않습니다/);
  assert.equal(g.seen.length, 0);
});

test('REST /api/admin/ai-credits: 관리자만', async (t) => {
  const g = fakeGateway({});
  const s = setup(t, g.fetchImpl);
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { const role = (req.get('authorization') || '').replace('Bearer ', ''); if (!role) return res.status(401).json({ error: 'unauthorized' }); req.user = { name: role, role }; next(); };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.code, message: e.message }));
  installAdminRoutes({ app, config: s.config, auth, wrap, adminSettings: {}, adminAccounts: {}, personalAi: s.personal });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const call = async (role) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/ai-credits`, { headers: role ? { Authorization: `Bearer ${role}` } : {} }); return { status: res.status, body: await res.json() }; };
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('editor')).status, 403);
  const ok = await call('admin');
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.accounts, []);
  assert.deepEqual(ok.body.others.map((k) => k.owner), ['관리자', '공유자', 'admin']);
});

test('ownOnly(웹 내 AI 키): 체험 공유 키는 빼고 내 키만', async (t) => {
  const member = usage('member', [['2026-11-02', 3, 12.5]]);
  const g = fakeGateway({ [K1]: { balance: BALANCE, key: usage('key', [['2026-11-02', 3, 12.5]]), member }, [K2]: { balance: BALANCE, key: usage('key', []), member } });
  const s = setup(t, g.fetchImpl);
  s.personal.save({ name: '공유자' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K2 });
  s.personal.save({ name: '참여자' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: K1 });
  const r = await aiCredits(s.personal, s.config, '참여자', false, { ownOnly: true });
  assert.deepEqual(r.accounts.flatMap((a) => a.keys.map((k) => [k.owner, k.sharing])), [['참여자', false]]);
  assert.deepEqual(r.others, []);
  const none = await aiCredits(s.personal, s.config, '키없음', false, { ownOnly: true });
  assert.deepEqual([none.accounts.length, none.others.map((k) => [k.owner, k.configured])], [0, [['키없음', false]]]);
  assert.ok(!g.seen.some((x) => x.auth === `Bearer ${K2}`), '남의 키로는 묻지 않는다');
});
