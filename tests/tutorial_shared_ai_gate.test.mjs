// 관리자 AI 계정 허용(2026-11-12 사용자 지시): 튜토리얼에서 나눠 쓰는 관리자 AI(공유 API 키·관리자 실행기·관리자 ChatGPT)는
// 관리자 화면 '사용자' 탭에서 체크한 계정(users[].serverAi)과 공유자 자신만 쓴다. 허용하지 않은 계정은 일반 계정처럼 본인 연결로 간다.
// 공유 경로 자체(라우팅·선점·알림)는 tutorial_api_only·tutorial_chatgpt_events 시험이 restrictUsers:false 로 본다. 외부 API 는 가짜 fetch.
// 2026-11-12 부터 연습 문서(tutorial)의 요청은 늘 예시 답변이라 관리자 AI 를 쓰지 않는다 — 연습 문서 쪽 문은 예시 답변을 끈(examples:false) 설정에서 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { fixture } from './helpers/server.mjs';

const admin = { name: '관리자', role: 'admin' };
const allowed = { name: '허용 계정', role: 'editor' };
const blocked = { name: '미허용 계정', role: 'editor' };
const demo = { name: 'test1', role: 'editor' };
const ADMIN_KEY = 'sk-gate-admin-test-0000';
const payload = { kind: 'instruct', instruction: '검토해 주세요', target: { ref: 's0/p0' } };

function setup(t, tutorial = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-shared-ai-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = {
    root: tmp, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: { maxProposals: 10 }, agents: { othersCanTake: false },
    users: [{ ...admin, token: 'admin-tok' }, { ...allowed, token: 'allowed-tok', serverAi: true }, { ...blocked, token: 'blocked-tok' }, { ...demo, token: 'demo-tok' }],
    tutorial: { users: [demo.name], shareFrom: [admin.name], examples: false, ...tutorial },
  };
  const seen = [];
  const personal = createPersonalAi({ config, fetchImpl: async (url, init) => {
    seen.push(new Headers(init.headers).get('authorization'));
    const output = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '검토했습니다.', instructionSummary: '검토', noChangesReason: '시험' };
    return new Response(JSON.stringify({ status: 'completed', model: 'test-api', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const store = new Store(path.join(tmp, 'store'));
  const deliveries = [];
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  service.personalAi = personal;
  service.agents = { online: () => true, sessions: () => [], deliver(name, type) { deliveries.push({ name, type }); return { session: `${name}-session`, agent: 'Claude Code' }; } };
  personal.save(admin, { provider: 'openai', model: 'test-api', key: ADMIN_KEY });
  const makeDoc = (user, tutorialDoc = false) => {
    const meta = store.create({ fileName: 'test.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name });
    if (tutorialDoc) { meta.tutorial = true; store.saveMeta(meta); }
    return meta.id;
  };
  return { config, service, store, personal, seen, deliveries, makeDoc };
}

test('허용한 계정만 체험 문서에서 관리자 API 키를 쓰고, 허용하지 않은 계정은 본인 연결로 간다', async (t) => {
  const s = setup(t);
  const ok = await s.service.createRequest(s.makeDoc(allowed, true), payload, allowed);
  assert.deepEqual([ok.route, ok.request.status], ['server', 'done']);
  assert.deepEqual(s.seen, [`Bearer ${ADMIN_KEY}`]);

  const id = s.makeDoc(blocked, true);
  const no = await s.service.createRequest(id, payload, blocked);
  assert.equal(no.route, 'agent');                                   // 본인 에이전트로(관리자 키 아님)
  assert.deepEqual(s.deliveries.map((d) => d.name), [blocked.name]);
  assert.equal(s.seen.length, 1);                                     // 관리자 키 호출이 늘지 않음
  assert.equal(s.service._summary(s.service._meta(id), blocked).tutorialApiOnly, undefined);
  assert.equal(s.service.tutorialAiStatus(blocked.name).allowed, false);
  assert.equal(s.service.tutorialAiStatus(blocked.name).available, false);
  assert.deepEqual(await s.service.claimNextRequest(admin, 'Codex', 'admin-cli', id), { none: true });   // 관리자 실행기도 못 가져감
  // 공유자 자신(관리자)은 자기 체험 문서에서 자기 키를 쓴다
  assert.equal((await s.service.createRequest(s.makeDoc(admin, true), payload, admin)).route, 'server');
});

test('체험 계정(tutorial.users)도 허용하지 않으면 모든 문서에서 관리자 API 대신 본인 키를 쓴다', async (t) => {
  const s = setup(t);
  s.personal.save(demo, { provider: 'openai', model: 'test-api', key: 'sk-own-demo-test-0000' });
  s.service.agents = { online: () => false, sessions: () => [], deliver() { return null; } };
  const done = await s.service.createRequest(s.makeDoc(demo), payload, demo);
  assert.deepEqual([done.route, done.request.status], ['server', 'done']);
  assert.deepEqual(s.seen, ['Bearer sk-own-demo-test-0000']);
  assert.equal(s.service._tutorialApiOnly(demo.name), false);
  // 관리자가 '관리자 AI' 칸을 체크하면 바로(재시작 없이) 관리자 키로 바뀐다
  s.config.users.find((u) => u.name === demo.name).serverAi = true;
  assert.equal(s.service._tutorialApiOnly(demo.name), true);
  const shared = await s.service.createRequest(s.makeDoc(demo), payload, demo);
  assert.equal(shared.route, 'server');
  assert.equal(s.seen.at(-1), `Bearer ${ADMIN_KEY}`);
});

test('관리자 실행기(shareAgent)·관리자 ChatGPT 도 허용한 계정의 체험 요청만 맡는다', async (t) => {
  const s = setup(t, { shareAgent: 'hwpx-codex-worker', shareChatGPT: [admin.name] });
  s.service.agents = {
    online: () => false, deliver() { return null; }, sendSession() { return true; },
    sessions: (name) => (name === admin.name ? [{ session: 'codex-1', agent: 'Codex', client: 'hwpx-codex-worker', channel: true }] : []),
  };
  const r = (by) => ({ by, tutorial: true, tutorialSession: true, status: 'pending' });
  assert.equal(s.service._tutorialAgentTakes(admin, r(allowed.name)), true);
  assert.equal(s.service._tutorialAgentTakes(admin, r(blocked.name)), false);
  assert.equal(s.service._tutorialChatGPTTakes(admin, r(allowed.name)), true);
  assert.equal(s.service._tutorialChatGPTTakes(admin, r(blocked.name)), false);
  assert.equal(s.service._tutorialChatGPTConfigured(r(blocked.name)), false);
  assert.equal(s.service._tutorialAgent(blocked.name, r(blocked.name)), null);
  assert.ok(s.service._tutorialAgent(allowed.name, r(allowed.name)));
  // 허용하지 않은 계정의 체험 문서 요청은 관리자 에이전트 알림 목록(snapshot)에 없다
  await s.service.createRequest(s.makeDoc(blocked, true), { ...payload, route: 'queue' }, blocked);
  assert.ok(!s.service.agentSnapshot(admin).length);
});

test('tutorial.restrictUsers:false 면 예전처럼 튜토리얼을 하는 누구나 관리자 AI 를 쓴다', async (t) => {
  const s = setup(t, { restrictUsers: false });
  assert.equal(s.service._sharedAiAllowed(blocked.name), true);
  const done = await s.service.createRequest(s.makeDoc(blocked, true), payload, blocked);
  assert.equal(done.route, 'server');
  assert.deepEqual(s.seen, [`Bearer ${ADMIN_KEY}`]);
  assert.equal(s.service._sharedAiAllowed(''), false);
});
