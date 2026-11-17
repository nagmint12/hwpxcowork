// 개인 AI 키(서버 보관, server/personal-ai.js): 저장·암호화·키 비노출·보낼 곳 바꿀 때 키 다시 받기·요청 경로(서비스 단독)·REST.
// 실제 API 는 부르지 않는다(가짜 fetch). 사용자 data/·config.json 은 쓰지 않는다(임시 폴더).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonalAi } from '../server/personal-ai.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { startServer, fixture } from './helpers/server.mjs';

const KEY = 'baze_TEST_KEY_abcdefWXYZ';
// 빈 결과는 변경 불필요 사유가 있어야 완료(api-tool-loop requireResult) — 검토만 하는 가짜 답은 사유를 단다
const result = (over = {}) => ({ proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '개인 키로 검토했습니다.', instructionSummary: '검토', noChangesReason: '시험 — 고칠 곳 없음', ...over });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function setup(t, { ai = {}, fetchImpl } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-personal-ai-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: { maxProposals: 10, ...ai }, agents: { leaseMinutes: 15 }, attachments: { maxBytes: 1e7, maxTextChars: 200000, maxPerDoc: 100 } };
  const logs = [];
  const personal = createPersonalAi({ config, fetchImpl, log: (m) => logs.push(m) });
  return { tmp, config, personal, logs, file: path.join(config.dataDir, 'personal-ai.json'), secret: path.join(tmp, '.hwpx-cowork-secret') };
}

test('로컬 API: 키 없이 저장·재시작 복원·모델 목록/연결 확인, 같은 Responses 경로 사용', async t => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error', '로컬 주소에서 다른 서버로 리다이렉트하지 않는다');
    seen.push({ url, method: init.method, auth: new Headers(init.headers).get('authorization') });
    if (url.endsWith('/models')) return json({ data: [{ id: 'qwen/qwen3.8-27b' }] });
    return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()) }] }] });
  };
  const s = setup(t, { fetchImpl }); const user = { name: '로컬 사용자', role: 'admin' };   // 로컬 AI 는 관리자만(2026-11-12)
  const saved = s.personal.save(user, { gateway: 'local', provider: 'openai', model: 'qwen/qwen3.8-27b' });
  assert.equal(saved.baseUrl, 'http://localhost:1234/v1'); assert.equal(saved.keyHint, null);
  assert.equal(s.personal.save(user, { gateway: 'local', provider: 'openai', model: 'qwen/qwen3.8-27b', effort: 'medium' }).keyHint, null);
  assert.deepEqual(await s.personal.models(user), { models: [{ id: 'qwen/qwen3.8-27b' }] });
  assert.equal((await s.personal.check(user)).lastCheck.ok, true);
  assert.ok(seen.every(c => c.method === 'GET' && c.url === 'http://localhost:1234/v1/models'));
  const restored = createPersonalAi({ config: s.config, fetchImpl });
  const ai = restored.forUser(user.name);
  assert.equal(ai.agentName, '로컬 AI qwen/qwen3.8-27b');
  await ai.run({ kind: 'review', target: { ref: 's0/p0' }, contextItems: [{ ref: 's0/p0', text: '글', isTarget: true }] });
  assert.equal(seen.at(-1).url, 'http://localhost:1234/v1/responses');
  assert.ok(seen.every(c => c.auth === null), '무인증 로컬 연결에는 인증 헤더를 보내지 않는다');
  assert.equal(seen.length, 3);
});

test('로컬 API 주소 제한·기존 키의 목적지 격리·선택 키 암호화', async t => {
  const s = setup(t); const user = { name: '로컬 사용자', role: 'admin' };
  const local = { gateway: 'local', provider: 'openai', model: 'local-model' };
  for (const baseUrl of ['https://evil.example/v1', 'http://192.168.0.1/v1', 'http://localhost.evil.example/v1', 'http://user:password@localhost:1234/v1', 'http://localhost:1234/v1?key=secret', 'http://localhost:1234/v1#secret', 'file:///etc/passwd']) {
    assert.throws(() => s.personal.save(user, { ...local, baseUrl }), { code: 'BAD_PERSONAL_AI' });
  }
  assert.throws(() => s.personal.save(user, { ...local, provider: 'anthropic' }), /OpenAI 호환/);
  assert.throws(() => s.personal.save(user, { ...local, workspace: 'hosted' }), /mcp/);
  s.personal.save(user, { gateway: 'baze', provider: 'openai', model: 'cloud-model', key: KEY });
  s.personal.save(user, local);
  assert.notEqual(s.personal.forUser(user.name).key, KEY, '게이트웨이 키가 로컬 주소로 가지 않는다');
  assert.throws(() => s.personal.save(user, { gateway: 'direct', provider: 'openai', model: 'cloud-model' }), /키를 다시/);
  const secret = 'local-secret-123456';
  s.personal.save(user, { ...local, baseUrl: 'http://127.0.0.1:1234/v1/', key: secret });
  assert.equal(s.personal.forUser(user.name).key, secret);
  assert.ok(!JSON.stringify(s.personal.status(user)).includes(secret));
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(secret));
  s.personal.save(user, { ...local, effort: 'low' });
  assert.equal(s.personal.forUser(user.name).key, secret, '같은 로컬 주소에서는 저장한 키 유지');
  s.personal.save(user, { ...local, baseUrl: 'http://[::1]:1234/v1' });
  assert.notEqual(s.personal.forUser(user.name).key, secret, '다른 주소로 키를 재사용하지 않는다');
  assert.equal(s.personal.status(user).keyHint, null);
  s.personal.save(user, { ...local, model: 'missing' });
  const checked = createPersonalAi({ config: s.config, fetchImpl: async () => json({ data: [{ id: 'other' }] }) });
  await assert.rejects(checked.check(user), /모델 목록에/);
});

test('로컬 API도 모의·강제 끔·personal:false에서는 실행하지 않는다', t => {
  for (const ai of [{ mock: true }, { forcedOff: true }, { personal: false }]) {
    const s = setup(t, { ai, fetchImpl: () => assert.fail('실제 API 호출 금지') });
    s.personal.save({ name: '로컬', role: 'admin' }, { gateway: 'local', provider: 'openai', model: 'm' });
    assert.equal(s.personal.forUser('로컬'), null);
  }
});

test('REST: 키 없는 로컬 API 주소 저장·복원·삭제(관리자만 — 다른 계정은 403)', async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const api = srv.api('admin');
    const local = { gateway: 'local', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.8-27b' };
    const saved = await api('/api/me/ai', { method: 'PUT', body: local });
    assert.equal(saved.gateway, 'local'); assert.equal(saved.keyHint, null);
    assert.equal((await api('/api/me')).personalAi.baseUrl, 'http://localhost:1234/v1');
    assert.equal((await srv.api('b')('/api/me/ai')).configured, false);
    assert.equal((await api('/api/me/ai', { method: 'DELETE' })).configured, false);
    // 2026-11-12 보안 점검: 편집자가 서버 PC 의 localhost 주소(다른 포트·경로)로 서버가 요청을 보내게 할 수 없다
    for (const baseUrl of ['http://localhost:1234/v1', 'http://127.0.0.1:2019/config/?x=', 'http://[::1]:8787/api/me/ai']) {
      const r = await srv.api('a').res('/api/me/ai', { method: 'PUT', body: { ...local, baseUrl } });
      assert.equal(r.status, 403); assert.equal(r.data.error, 'LOCAL_AI_ADMIN_ONLY');
    }
    assert.equal((await srv.api('a')('/api/me/ai')).configured, false);
  } finally { await srv.stop(); }
});

test('예전에 저장된 비관리자 로컬 연결은 쓰지 않는다(요청·모델 목록·확인 모두)', (t) => {
  const s = setup(t);
  s.config.users = [{ name: '관리자', role: 'admin' }, { name: '편집자', role: 'editor' }];
  s.personal.save({ name: '관리자', role: 'admin' }, { gateway: 'local', provider: 'openai', model: 'm' });
  // 관리자 항목을 그대로 편집자 이름으로 옮겨 '예전 저장분'을 흉내 낸다(암호문은 이름에 묶여 있어 풀리지 않아도 forUser 가 먼저 막아야 한다)
  const file = path.join(s.config.dataDir, 'personal-ai.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.users['편집자'] = raw.users['관리자']; fs.writeFileSync(file, JSON.stringify(raw));
  const fresh = createPersonalAi({ config: s.config });
  assert.ok(fresh.forUser('관리자'));
  assert.equal(fresh.forUser('편집자'), null);
  s.config.users[1].role = 'admin';
  assert.equal(createPersonalAi({ config: s.config }).forUser('편집자') === null, true, '암호문은 이름에 묶여 다른 이름으로는 풀리지 않는다');
});

test('키는 암호화해 저장하고 API 로 다시 내보내지 않으며, 보낼 곳을 바꾸면 키를 다시 받는다', (t) => {
  const s = setup(t);
  const A = { name: '홍길동' }; const B = { name: '김검토' };
  assert.deepEqual(s.personal.status(A), { configured: false, active: false, available: true });
  assert.throws(() => s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol' }), /API 키를 넣어/);
  const saved = s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium', key: KEY });
  assert.equal(saved.configured, true); assert.equal(saved.keyHint, '…WXYZ'); assert.equal(saved.effort, 'medium');
  assert.ok(!JSON.stringify(saved).includes(KEY) && !JSON.stringify(s.personal.status(A)).includes(KEY));
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(KEY), '저장 파일에 평문 키 없음');
  assert.ok(fs.existsSync(s.secret), '암호 열쇠는 config 옆(데이터 폴더 밖)');
  assert.ok(!fs.readdirSync(s.config.dataDir).some((f) => f.includes('secret')));
  // BAZE 안에서 제공자만 바꾸면 같은 BAZE 키를 쓴다. 직접 연결로 바꾸면 키를 다시 받아야 한다
  assert.equal(s.personal.save(A, { gateway: 'baze', provider: 'anthropic', model: 'claude-haiku-5-5' }).provider, 'anthropic');
  assert.throws(() => s.personal.save(A, { gateway: 'direct', provider: 'anthropic', model: 'claude-haiku-5-5' }), /키를 다시/);
  s.personal.save(B, { gateway: 'direct', provider: 'openai', model: 'gpt-x', key: 'sk-direct-key-1234' });
  assert.throws(() => s.personal.save(B, { gateway: 'direct', provider: 'gemini', model: 'g' }), /키를 다시/);
  for (const input of [{ gateway: 'custom', provider: 'openai', model: 'm', key: KEY }, { gateway: 'baze', provider: 'x', model: 'm', key: KEY }, { gateway: 'baze', provider: 'openai', model: 'm m', key: KEY }, { gateway: 'baze', provider: 'openai', model: 'm', effort: 'turbo', key: KEY }, { gateway: 'baze', provider: 'openai', model: 'm', key: 'a b c d e f g h' }, null, []]) {
    assert.throws(() => s.personal.save({ name: '새사람' }, input), { code: 'BAD_PERSONAL_AI' });
  }
  // 임의 주소는 받지 않는다(서버가 남이 정한 곳으로 키를 보내지 않게)
  s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', baseUrl: 'https://evil.example/v1', key: KEY });
  assert.equal(s.personal.forUser(A.name).baseUrl, 'https://api.baze.co/v1/gateway');
  assert.equal(s.personal.remove(A).removed, true);
  assert.equal(s.personal.status(A).configured, false);
  assert.equal(s.personal.forUser(A.name), null);
});

test('저장한 키로 만든 AI 는 BAZE 주소로 그 사람 키를 보내고, 다른 사람 칸으로 옮긴 암호문은 풀리지 않는다', async (t) => {
  const seen = [];
  const s = setup(t, { fetchImpl: async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : null });
    return json({ status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()) }] }], usage: { input_tokens: 3, output_tokens: 2 } });
  } });
  s.personal.save({ name: '홍길동' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium', key: KEY });
  const ai = s.personal.forUser('홍길동');
  assert.equal(ai.agentName, 'API gpt-6.1-sol · 개인 키');
  assert.equal(s.personal.forUser('홍길동'), ai, '바뀌지 않았으면 같은 AI 를 다시 쓴다');
  await ai.run({ kind: 'review', target: { ref: 's0/p0', text: '글' }, context: [{ ref: 's0/p0', text: '글', isTarget: true }], options: { count: 1 } });
  assert.equal(seen[0].url, 'https://api.baze.co/v1/gateway/responses');
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.deepEqual(seen[0].body.reasoning, { effort: 'medium' });
  // 암호문을 다른 사람 칸으로 옮기면(AAD = 이름) 풀리지 않는다
  const stored = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  stored.users['김검토'] = stored.users['홍길동'];
  fs.writeFileSync(s.file, JSON.stringify(stored));
  const again = createPersonalAi({ config: s.config, fetchImpl: async () => json({}), log: (m) => s.logs.push(m) });
  assert.equal(again.forUser('김검토'), null);
  assert.ok(s.logs.some((m) => m.includes('김검토')) && !s.logs.some((m) => m.includes(KEY)));
  assert.equal(again.forUser('홍길동').key, KEY);
});

test('모의·강제 끔·personal:false 에서는 개인 키로 실제 API 를 부르지 않는다', (t) => {
  for (const ai of [{ mock: true }, { forcedOff: true }, { personal: false }]) {
    const s = setup(t, { ai });
    const view = s.personal.save({ name: '홍길동' }, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: KEY });
    assert.equal(view.active, false, JSON.stringify(ai));
    assert.equal(s.personal.forUser('홍길동'), null);
  }
});

test('연결 확인은 모델 정보만 조회하고(생성 호출 없음) 결과를 남긴다', async (t) => {
  const calls = [];
  let models = [{ id: 'gpt-6.1-sol', endpoints: ['/v1/gateway/chat/completions/', '/v1/gateway/responses/'] }, { id: 'grok-4.7', endpoints: ['/v1/gateway/chat/completions/'] }];
  const s = setup(t, { fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init.method, auth: new Headers(init.headers).get('authorization') }); return json({ data: models }); } });
  const A = { name: '홍길동' };
  await assert.rejects(s.personal.check(A), { code: 'NO_PERSONAL_AI' });
  s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: KEY });
  const ok = await s.personal.check(A);
  assert.equal(ok.lastCheck.ok, true);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [['GET', 'https://api.baze.co/v1/gateway/models/', `Bearer ${KEY}`]]);
  s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'grok-4.7' });
  await assert.rejects(s.personal.check(A), (e) => e.code === 'PERSONAL_AI_CHECK' && /제공자 방식/.test(e.message));
  assert.equal(s.personal.status(A).lastCheck.ok, false);
  s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'no-such-model' });
  await assert.rejects(s.personal.check(A), /모델 목록에/);
  models = [];
  const direct = setup(t, { fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init.method }); return json({ error: { message: `${KEY} 원문` } }, 401); } });
  direct.personal.save(A, { gateway: 'direct', provider: 'openai', model: 'gpt-x', key: 'sk-direct-key-1234' });
  await assert.rejects(direct.personal.check(A), (e) => /API 키가 맞지/.test(e.message) && !e.message.includes(KEY));
  assert.deepEqual(calls.at(-1), { url: 'https://api.openai.com/v1/models/gpt-x', method: 'GET' });
});

test('서비스: 키를 등록한 사람의 요청은 서버가 그 사람 키로 처리하고, 등록하지 않은 사람은 대기열로 간다', async (t) => {
  const seen = [];
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const s = setup(t, { ai: { mcp: 'v1' }, fetchImpl: async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    return json({ status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result({ comments: [{ ref: 's0/p0', find: '', text: '개인 키 의견' }] })) }] }], usage: { input_tokens: 5, output_tokens: 4 } });
  } });
  const store = new Store(path.join(s.tmp, 'store'));
  const hub = { msgs: [], broadcast(id, m) { this.msgs.push(m); }, broadcastAll(m) { this.msgs.push(m); } };
  const svc = new Service({ store, hub, config: s.config, ai: { enabled: false, agentName: '공용 서버 AI' } });
  svc.personalAi = s.personal;
  const A = { name: '홍길동', role: 'editor' }; const B = { name: '김검토', role: 'editor' };
  const id = store.create({ fileName: '개인키.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: A.name }).id;
  s.personal.save(A, { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', key: KEY });
  assert.equal(svc.aiFor(A.name).agentName, 'API gpt-6.1-sol · 개인 키');
  assert.equal(svc.aiFor(B.name), null);
  const done = await svc.createRequest(id, { kind: 'review', target: { ref: 's0/p0' } }, A);
  assert.equal(done.route, 'server');
  assert.equal(done.request.status, 'done');
  assert.equal(done.request.handledBy, 'API gpt-6.1-sol · 개인 키');
  assert.equal(seen.length, 1); assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.ok(hub.msgs.some((m) => m.type === 'request' && m.action === 'working' && m.by === 'API gpt-6.1-sol · 개인 키'));
  const queued = await svc.createRequest(id, { kind: 'review', target: { ref: 's0/p0' } }, B);
  assert.equal(queued.route, 'queue'); assert.equal(seen.length, 1, '남의 키로 처리하지 않는다');
  // 다시 요청(관리자가 눌러도)도 요청자 키로
  const admin = { name: '관리자', role: 'admin' };
  const retried = await svc.retryRequest(id, done.request.rid, admin);
  assert.equal(retried.route, 'server'); assert.equal(seen.length, 2); assert.equal(seen[1].auth, `Bearer ${KEY}`);
  // 키를 지우면 대기열
  s.personal.remove(A);
  assert.equal((await svc.createRequest(id, { kind: 'review', target: { ref: 's0/p0' } }, A)).route, 'queue');
});

test('REST: /api/me 에 내 AI 키 상태(키 없이), 저장·삭제는 본인 것만, 저장 파일에 평문 키 없음', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const a = srv.api('a'); const b = srv.api('b');
    assert.deepEqual((await a('/api/me')).personalAi, { configured: false, active: false, available: false });
    const bad = await a.res('/api/me/ai', { method: 'PUT', body: { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol' } });
    assert.equal(bad.status, 400); assert.equal(bad.data.error, 'BAD_PERSONAL_AI');
    const saved = await a('/api/me/ai', { method: 'PUT', body: { gateway: 'baze', provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium', key: KEY } });
    assert.equal(saved.configured, true); assert.equal(saved.keyHint, '…WXYZ');
    assert.equal(saved.active, false, 'HWPX_COWORK_AI=off 시험 서버에서는 쓰지 않는다');
    assert.ok(!JSON.stringify(await a('/api/me')).includes(KEY));
    assert.equal((await b('/api/me/ai')).configured, false, '남의 설정은 안 보인다');
    assert.ok(!fs.readFileSync(path.join(srv.dataDir, 'personal-ai.json'), 'utf8').includes(KEY));
    assert.ok(fs.existsSync(path.join(srv.tmpDir, '.hwpx-cowork-secret')), '암호 열쇠는 임시 config 옆');
    const off = await a.res('/api/me/ai/check', { method: 'POST' });
    assert.equal(off.status, 409); assert.equal(off.data.error, 'PERSONAL_AI_OFF');
    assert.equal((await a('/api/me/ai', { method: 'DELETE' })).removed, true);
    assert.equal((await srv.api(null).res('/api/me/ai')).status, 401);
  } finally { await srv.stop(); }
});
