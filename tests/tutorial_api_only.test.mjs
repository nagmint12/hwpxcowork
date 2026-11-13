// API 연결은 가짜 fetch로 검증한다. 개인 실행기나 실제 외부 API를 실행하지 않는다.
// 2026-11-12 부터 튜토리얼 연습 문서의 요청은 늘 예시 답변이다(tests/tutorial_report_examples.test.mjs). 이 파일은 관리자 AI 공유 경로 —
// 체험 계정(tutorial.users)의 자기 문서와, 예시 답변을 끈(examples:false) 연습 문서 — 를 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { fixture } from './helpers/server.mjs';
import { tutorialOwnerKey } from '../server/tutorial-identity.js';
import { shareAgentMatches } from '../server/tutorial.js';

const admin = { name: '관리자', role: 'admin' };
const demoNames = ['test1', 'test2', 'test3', 'test4', 'test5'];
const ADMIN_KEY = 'sk-tutorial-admin-test-0000';
const payload = { kind: 'instruct', instruction: '검토해 주세요', target: { ref: 's0/p0' } };
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-api-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { root: tmp, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: { maxProposals: 10 }, agents: { othersCanTake: true }, tutorial: { users: demoNames, shareFrom: [admin.name], restrictUsers: false, examples: false } };
  const seen = []; const deliveries = []; const events = []; let rejectApi = false;
  const personal = createPersonalAi({ config, fetchImpl: async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    if (rejectApi) return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    const output = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: 'API로 검토했습니다.', instructionSummary: '검토', noChangesReason: '시험 — 고칠 곳 없음' };
    return new Response(JSON.stringify({ status: 'completed', model: 'test-api', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast(id, event) { events.push(event); }, broadcastAll(event) { events.push(event); } }, ai: { enabled: false } });
  service.personalAi = personal;
  service.agents = { online: () => true, deliver(name, type) { deliveries.push({ name, type }); return { session: 'personal-session', agent: 'Codex / Claude Code' }; } };
  const saveApi = (user, key = ADMIN_KEY) => personal.save(user, { provider: 'openai', model: 'test-api', key });
  const makeDoc = (user, tutorial = false) => {
    const meta = store.create({ fileName: 'test.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name });
    if (tutorial) { meta.tutorial = true; store.saveMeta(meta); }
    return meta.id;
  };
  return { config, service, store, personal, seen, deliveries, events, saveApi, makeDoc, rejectApi(value) { rejectApi = value; } };
}

test('test1~test5: 관리자 API만 실행하고 개인 Codex·Claude Code·요청자 키와 대기열 선택을 사용하지 않는다', async (t) => {
  const s = setup(t); s.saveApi(admin);
  for (const name of demoNames) {
    const user = { name, role: 'editor' }; const id = s.makeDoc(user);
    s.saveApi(user, `sk-own-${name}-000000`);
    for (const route of ['auto', 'agent', 'server', 'queue']) {
      const done = await s.service.createRequest(id, { ...payload, route }, user);
      assert.deepEqual([done.route, done.queued, done.request.status], ['server', false, 'done']);
    }
  }
  assert.equal(s.seen.length, 20);
  assert.ok(s.seen.every(item => item.auth === `Bearer ${ADMIN_KEY}`));
  assert.deepEqual(s.deliveries, []);
  assert.ok(!s.events.some(event => event.action === 'delivered'));
});

test('관리자 로컬 API 등록 후 튜토리얼은 실행기 없이 서버에서 즉시 처리한다', async t => {
  const s = setup(t);
  s.personal.save(admin, { gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.8-27b' });
  s.service.agents = { online: () => false, deliver() { assert.fail('실행기로 보내면 안 됨'); } };
  const user = { name: 'test1', role: 'editor' };
  const id = s.makeDoc(user, true);
  const done = await s.service.createRequest(id, payload, user);
  assert.equal(done.route, 'server'); assert.equal(done.queued, false); assert.equal(done.request.status, 'done');
  assert.equal(done.request.handledBy, '로컬 AI qwen/qwen3.8-27b');
  assert.equal(s.seen.length, 1); assert.equal(s.seen[0].url, 'http://localhost:1234/v1/responses');
  assert.notEqual(s.seen[0].auth, `Bearer ${ADMIN_KEY}`);
  assert.equal(s.service.tutorialAiStatus(user.name).gateway, 'local');
});

test('일반 사용자의 체험 문서도 관리자 API 전용이며, 일반 문서는 개인 실행기 경로를 유지한다', async (t) => {
  const s = setup(t); s.saveApi(admin);
  const user = { name: '일반 사용자', role: 'editor' };
  const tutorialId = s.makeDoc(user, true); const normalId = s.makeDoc(user);
  const done = await s.service.createRequest(tutorialId, payload, user);
  assert.equal(done.route, 'server');
  assert.equal(s.service._summary(s.service._meta(tutorialId), user).tutorialApiOnly, true);
  const normal = await s.service.createRequest(normalId, payload, user);
  assert.equal(normal.route, 'agent'); assert.equal(s.deliveries.length, 1);
  assert.equal(s.service._summary(s.service._meta(normalId), user).tutorialApiOnly, undefined);
  // 관리자도 자기 체험 문서에서 공유 대상으로 지정된 자신의 API를 쓸 수 있다.
  assert.equal((await s.service.createRequest(s.makeDoc(admin, true), payload, admin)).route, 'server');
});

test('공유 API가 없으면 사용자 키·공용 모의 AI·온라인 개인 실행기로 넘기지 않고 503으로 중단한다', async (t) => {
  const s = setup(t); const user = { name: 'test1', role: 'editor' }; const id = s.makeDoc(user);
  s.saveApi(user, 'sk-own-user-test-0000');
  s.service.ai = { enabled: true, mock: true, runKind: 'api', agentName: '모의 AI' };
  for (const route of ['auto', 'agent', 'server', 'queue']) await assert.rejects(s.service.createRequest(id, { ...payload, route }, user), { code: 'TUTORIAL_API_UNAVAILABLE', status: 503 });
  assert.equal(s.store.readMeta(id).requests.length, 0);
  assert.equal(s.seen.length, 0); assert.deepEqual(s.deliveries, []);
  assert.deepEqual([s.service.tutorialAiStatus(user.name).apiOnly, s.service.tutorialAiStatus(user.name).active], [true, false]);
});

test('API 인증 실패는 failed 상태·502로 남고, API를 복구하기 전에는 재시도나 실행기 대체가 작동하지 않는다', async (t) => {
  const s = setup(t); s.saveApi(admin); s.rejectApi(true);
  const user = { name: 'test1', role: 'editor' }; const id = s.makeDoc(user);
  await assert.rejects(s.service.createRequest(id, payload, user), { code: 'AI_FAILED', status: 502 });
  let req = s.service._meta(id).requests[0];
  assert.deepEqual([req.status, req.route, req.delivery], ['failed', 'server', null]);
  assert.deepEqual(await s.service.claimNextRequest(admin, 'Codex', 'admin-cli', id), { none: true });
  s.personal.remove(admin);
  await assert.rejects(s.service.retryRequest(id, req.rid, user), { code: 'TUTORIAL_API_UNAVAILABLE', status: 503 });
  assert.equal(s.service._meta(id).requests[0].status, 'failed');
  s.saveApi(admin); s.rejectApi(false);
  const retried = await s.service.retryRequest(id, req.rid, user);
  assert.deepEqual([retried.route, retried.request.status], ['server', 'done']);
  assert.deepEqual(s.deliveries, []);
});

test('기존 대기 요청도 개인 실행기의 알림·자동 선점·수동 시작·결과 제출에서 제외한다', async (t) => {
  const s = setup(t); const user = { name: 'test1', role: 'editor' }; const id = s.makeDoc(user);
  s.config.tutorial.enabled = false;
  const old = await s.service.createRequest(id, { ...payload, route: 'queue' }, user);
  s.config.tutorial.enabled = true;
  assert.deepEqual(s.service.agentSnapshot(user), []);
  assert.deepEqual(s.service.agentSnapshot(admin), []);
  for (const actor of [user, admin]) {
    assert.deepEqual(await s.service.claimNextRequest(actor, 'Claude Code', 'cli', id), { none: true });
    await assert.rejects(s.service.startRequest(id, old.request.rid, actor, 'Codex', { session: 'cli' }), { status: 403 });
    await assert.rejects(s.service.completeRequest(id, old.request.rid, { session: 'cli', summary: '개인 실행기 결과' }, actor, 'Codex'), { code: 'TUTORIAL_API_ONLY', status: 403 });
  }
  assert.equal(s.service._meta(id).requests[0].status, 'pending');
});


test('shareAgent: 공유자의 Codex 실행기 세션에만 알리고 그 실행기가 연습 문서를 맡아 완료한다(화면 이름은 관리자 API, 실행기가 없으면 API)', async (t) => {
  const s = setup(t); s.saveApi(admin);
  s.config.tutorial.shareAgent = 'hwpx-codex-worker';
  const sent = []; let codexOn = true;
  s.service.agents = {
    online: () => true,
    sessions: (name) => name !== admin.name ? [] : [{ session: 'claude-desktop', agent: 'Claude', client: 'bridge', channel: true },
      ...(codexOn ? [{ session: 'codex-1', agent: 'ChatGPT (Codex)', client: 'hwpx-codex-worker', channel: true }] : [])],
    sendSession(name, session, type) { sent.push({ name, session, type }); return true; },
    deliver(name, type) { s.deliveries.push({ name, type }); return { session: 'x', agent: 'x' }; },
  };
  const user = { name: 'test1', role: 'editor', token: 'test1-token' }; const other = { name: 'test2', role: 'editor', token: 'test2-token' };
  const id = s.makeDoc(user);
  const meta = s.store.readMeta(id); Object.assign(meta, { tutorial: true, tutorialSession: true, tutorialOwnerKey: tutorialOwnerKey(user) }); s.store.saveMeta(meta);
  assert.equal(s.service.tutorialAiStatus(user.name).active, true);
  assert.equal(s.service.canRead(admin, s.store.readMeta(id)), false);   // 열린 요청이 없으면 관리자도 못 본다

  const made = await s.service.createRequest(id, { ...payload, route: 'server' }, user);
  assert.deepEqual([made.route, made.queued, made.request.status], ['agent', true, 'pending']);
  assert.match(made.hint, /관리자 API/); assert.doesNotMatch(made.hint, /Codex/);
  assert.deepEqual(sent, [{ name: admin.name, session: 'codex-1', type: 'ai_request' }]);
  assert.deepEqual([s.seen.length, s.deliveries.length], [0, 0]);
  assert.equal(s.service._meta(id).requests[0].delivery.agent, '관리자 API');
  assert.ok(s.events.some(e => e.action === 'delivered' && e.agent === '관리자 API'));
  // 문서 목록에는 넣지 않고, 요청이 열린 동안만 읽는다. 다른 체험 계정·요청자 본인 세션은 맡지 못한다
  assert.ok(!(await s.service.listDocuments(admin)).some(d => d.id === id));
  assert.equal(s.service.canRead(admin, s.store.readMeta(id)), true);
  assert.equal(s.service.canRead(other, s.store.readMeta(id)), false);
  assert.deepEqual(s.service.agentSnapshot(admin).map(x => x.docId), [id]);
  assert.deepEqual(s.service.agentSnapshot(user), []);
  assert.deepEqual(await s.service.claimNextRequest(user, 'Claude Code', 'cli'), { none: true });

  const claimed = await s.service.claimNextRequest(admin, 'ChatGPT (Codex)', 'codex-1');
  assert.deepEqual([claimed.claimed, claimed.docId, claimed.rid], [true, id, made.request.rid]);
  await s.service.addMemo(id, { ref: 's0/p0', text: 'Codex 의견', rid: made.request.rid }, { ...admin, agentSession: 'codex-1' }, 'ChatGPT (Codex)');
  const done = await s.service.completeRequest(id, made.request.rid, { session: 'codex-1', summary: 'Codex 로 검토했습니다.' }, admin, 'ChatGPT (Codex)');
  assert.equal(done.request?.status ?? s.service._meta(id).requests[0].status, 'done');
  assert.equal(s.service.canRead(admin, s.store.readMeta(id)), true);   // 끝난 뒤 10분은 실행기가 완료를 확인할 수 있게
  const old = s.store.readMeta(id); old.requests[0].doneAt = new Date(Date.now() - 11 * 60000).toISOString();
  assert.equal(s.service.canRead(admin, old), false);

  // 실행기가 꺼지면 종전대로 공유 API
  codexOn = false;
  assert.equal((await s.service.createRequest(id, payload, user)).route, 'server');
  assert.equal(s.seen.length, 1);
});

test('shareAgent: 판 번호 없는 client 이름(claude-code)은 Claude Code 채널 세션(claude-code/2.1.x)에 맞고 다른 세션은 아니다', async (t) => {
  assert.equal(shareAgentMatches('claude-code', 'claude-code/2.1.317'), true);
  assert.equal(shareAgentMatches('claude-code', 'claude-code'), true);
  assert.equal(shareAgentMatches('claude-code', 'claude-code-x/1'), false);
  assert.equal(shareAgentMatches('claude-code', 'hwpx-codex-worker'), false);
  assert.equal(shareAgentMatches('hwpx-codex-worker', 'hwpx-codex-worker'), true);
  assert.equal(shareAgentMatches(true, 'bridge'), true);
  assert.equal(shareAgentMatches(null, 'claude-code/2'), false);

  const s = setup(t); s.saveApi(admin);
  s.config.tutorial.shareAgent = 'claude-code';
  const sent = [];
  s.service.agents = {
    online: () => true,
    sessions: (name) => name !== admin.name ? [] : [{ session: 'codex-1', agent: 'ChatGPT (Codex)', client: 'hwpx-codex-worker', channel: true },
      { session: 'cc-1', agent: 'Claude Code', client: 'claude-code/2.1.317', channel: true }],
    sendSession(name, session, type) { sent.push({ name, session, type }); return true; },
    deliver(name, type) { s.deliveries.push({ name, type }); return { session: 'x', agent: 'x' }; },
  };
  const user = { name: 'test1', role: 'editor', token: 'test1-token' };
  const id = s.makeDoc(user);
  const meta = s.store.readMeta(id); Object.assign(meta, { tutorial: true, tutorialSession: true, tutorialOwnerKey: tutorialOwnerKey(user) }); s.store.saveMeta(meta);
  const made = await s.service.createRequest(id, { ...payload, route: 'server' }, user);
  assert.equal(made.route, 'agent');
  assert.deepEqual(sent, [{ name: admin.name, session: 'cc-1', type: 'ai_request' }]);
});

test('provider(관리자 튜토리얼 AI): 고른 연결 하나로만 처리한다 — claude-code 는 그 채널에만, 꺼지면 공유 키 대신 대기열', async (t) => {
  assert.equal(shareAgentMatches(['hwpx-tutorial-codex-worker', 'hwpx-codex-worker'], 'hwpx-codex-worker'), true);
  assert.equal(shareAgentMatches(['claude-code'], 'hwpx-codex-worker'), false);
  const s = setup(t); s.saveApi(admin);
  Object.assign(s.config.tutorial, { provider: 'claude-code', shareAgent: 'hwpx-codex-worker', shareChatGPT: [admin.name] });
  const sent = []; let ccOn = true;
  s.service.agents = {
    online: () => true,
    sessions: (name) => name !== admin.name ? [] : [{ session: 'codex-1', agent: 'ChatGPT (Codex)', client: 'hwpx-codex-worker', channel: true },
      ...(ccOn ? [{ session: 'cc-1', agent: 'Claude Code', client: 'claude-code/2.1.319', channel: true }] : [])],
    sendSession(name, session, type) { sent.push({ name, session, type }); return true; },
    deliver(name, type) { s.deliveries.push({ name, type }); return { session: 'x', agent: 'x' }; },
  };
  const user = { name: 'test1', role: 'editor', token: 'test1-token' };
  const id = s.makeDoc(user);
  const meta = s.store.readMeta(id); Object.assign(meta, { tutorial: true, tutorialSession: true, tutorialOwnerKey: tutorialOwnerKey(user) }); s.store.saveMeta(meta);
  assert.equal(s.service.tutorialAiStatus(user.name).active, true);
  const made = await s.service.createRequest(id, { ...payload, route: 'server' }, user);
  assert.equal(made.route, 'agent');
  assert.deepEqual(sent, [{ name: admin.name, session: 'cc-1', type: 'ai_request' }]);
  // 채널이 꺼지면 공유 키(관리자 API)로 넘기지 않고 대기열 — 다시 붙으면 claim_next_request 로 가져간다
  ccOn = false;
  assert.equal(s.service.tutorialAiStatus(user.name).active, false);
  const waiting = await s.service.createRequest(id, payload, user);
  assert.deepEqual([waiting.route, waiting.queued, waiting.request.status], ['queue', true, 'pending']);
  assert.deepEqual([s.seen.length, s.deliveries.length], [0, 0]);
  // 같은 관리자의 다른 실행기(Codex)·채널 아닌 세션은 맡지 못하고, Claude Code 채널 세션만 맡는다(2026-11-09 라이브: Codex 가 먼저 가져갔다)
  ccOn = true;
  assert.deepEqual(await s.service.claimNextRequest(admin, 'ChatGPT (Codex)', 'codex-1'), { none: true });
  await assert.rejects(s.service.startRequest(id, waiting.request.rid, admin, 'ChatGPT (Codex)', { session: 'codex-1' }), { code: 'NOT_OWNER' });
  assert.deepEqual(await s.service.claimNextRequest(admin, 'Claude Code', 'cc-unknown'), { none: true });
  const claimed = await s.service.claimNextRequest(admin, 'Claude Code', 'cc-1');
  assert.equal(claimed.claimed, true);
});

test('provider api·local: 공유자 키 가운데 그 연결 방식의 키만 쓴다', async (t) => {
  const s = setup(t);
  const sub = { name: '공유자', role: 'editor' };
  s.config.tutorial.shareFrom = [admin.name, sub.name];
  s.personal.save(admin, { gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.8-27b' });
  s.personal.save(sub, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: 'sk-baze-sub-000000' });
  const user = { name: 'test1', role: 'editor' }; const id = s.makeDoc(user);
  s.config.tutorial.provider = 'api';
  assert.equal((await s.service.createRequest(id, payload, user)).route, 'server');
  assert.match(s.seen.at(-1).url, /api\.baze\.co/);
  s.config.tutorial.provider = 'local';
  assert.equal((await s.service.createRequest(id, payload, user)).route, 'server');
  assert.match(s.seen.at(-1).url, /localhost:1234/);
  // 그 방식의 키가 없으면 다른 키로 넘기지 않는다
  s.personal.remove(sub); s.config.tutorial.provider = 'api';
  await assert.rejects(s.service.createRequest(id, payload, user), { code: 'TUTORIAL_API_UNAVAILABLE' });
});
