import test from 'node:test';
import assert from 'node:assert/strict';
import { automationStatus } from '../server/automation-status.js';
import { AgentRegistry } from '../server/agents.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const now = Date.parse('2026-10-26T06:00:00Z');
const user = { name: 'A', token: 'secret-token-A' };
function setup(over = {}) {
  const agents = new AgentRegistry();
  const config = { ai: { provider: 'openai', model: 'test-model', key: 'PRIVATE_API_KEY' } };
  const docs = [{ id: 'private-doc', title: 'PRIVATE_TITLE', requests: [
    { by: 'A', status: 'pending', route: 'queue', instruction: 'PRIVATE_INSTRUCTION' },
    { by: 'A', status: 'pending', route: 'agent' },
    { by: 'A', status: 'working', claim: { session: 'PRIVATE_SESSION', expires: new Date(now - 1).toISOString() } },
    { by: 'A', status: 'working', claim: { expires: new Date(now + 1000).toISOString() } },
    { by: 'A', status: 'done' },
    { by: 'B', status: 'pending', route: 'queue' },
  ] }];
  const service = { agents, store: { list: () => docs }, _claimExpired: (claim, time) => !(Date.parse(claim?.expires || '') > time) };
  const eventState = { enabled: true, event: 'ai_request.created', protocolVersion: '2026-07-28', activeSubscriptions: 0, subscriptions: [] };
  return { user, service, config, ai: { enabled: false, provider: 'openai' }, events: { status: () => eventState }, now, eventState, ...over };
}

test('자동 처리 상태는 자기 요청 숫자만 반환하고 연결·구독 없음을 정확히 표시', () => {
  const s = setup(); const value = automationStatus(s);
  assert.equal(value.automatic.available, false); assert.equal(value.automatic.state, 'needs_setup');
  assert.deepEqual(value.queue, { pending: 2, working: 2, expiredWorking: 1, pendingByRoute: { queue: 1, agent: 1, server: 0 } });
  const text = JSON.stringify(value);
  for (const secret of ['PRIVATE_', 'secret-token', 'private-doc']) assert.ok(!text.includes(secret));
  assert.equal(value.checkedAt, new Date(now).toISOString());
});

test('진행 중 튜토리얼 문서도 본인 대기·처리·만료·경로별 집계에 포함하고 중복 문서는 한 번만 센다',()=>{
  const s=setup();const normal=s.service.store.list();
  s.service.store.listSessions=()=>[normal[0],{id:'PRIVATE_TUTORIAL',requests:[
    {by:'A',status:'pending',route:'agent',instruction:'PRIVATE_TUTORIAL_INSTRUCTION'},
    {by:'A',status:'working',claim:{expires:new Date(now-1).toISOString()}},
    {by:'A',status:'cancelled',route:'agent'},{by:'A',status:'done'},
    {by:'B',status:'pending',route:'agent'},
  ]}];
  const value=automationStatus(s);
  assert.deepEqual(value.queue,{pending:3,working:3,expiredWorking:2,pendingByRoute:{queue:1,agent:2,server:0}});
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'));
});

test('튜토리얼의 준비된 대기 예시는 집계하지 않고 취소된 이전 요청도 대기 수에서 빠진다',()=>{
  const s=setup();s.service.store.list=()=>[];
  s.service.store.listSessions=()=>[{id:'tutorial',requests:[
    {by:'A',status:'pending',route:'queue',example:true},
    {by:'A',status:'working',route:'server',example:true},
    {by:'A',status:'cancelled',route:'agent'},
    {by:'A',status:'working',route:'agent',claim:{expires:new Date(now+1000).toISOString()}},
  ]}];
  assert.deepEqual(automationStatus(s).queue,{pending:0,working:1,expiredWorking:0,pendingByRoute:{queue:0,agent:0,server:0}});
});

test('채널·서버 우선순위, 이벤트 구독은 자동 처리로 치지 않음, 채널 없는 일반 연결 구분, 안내 글에 이벤트·서버 AI 없음', () => {
  const s = setup();
  const response = () => ({ destroyed: false, writableEnded: false, write() {}, end() { this.writableEnded = true; } });
  const plain = (value) => { assert.doesNotMatch(value.automatic.message, /이벤트|서버 AI|SSE|구독|예약/); return value; };
  s.service.agents.connect(user, { session: 'PRIVATE_SESSION', agent: '일반 MCP', channel: false }, response());
  assert.equal(plain(automationStatus(s)).automatic.available, false);
  // ChatGPT 이벤트 구독·예약 실행은 쓰지 않는다 — 구독이 남아 있어도 자동 처리로 치지 않고(events 칸은 호환으로 남김) 대기열 안내
  s.eventState.activeSubscriptions = 1;
  s.eventState.subscriptions = [{ id: 'sub-test', active: true, documentId: 'only-one-doc', lastDelivery: { status: 'pending', httpStatus: 503 } }];
  let value = plain(automationStatus(s));
  assert.equal(value.automatic.method, null); assert.equal(value.automatic.state, 'needs_setup');
  assert.equal(value.automatic.recommendedRoute, 'queue'); assert.match(value.automatic.message, /대기열/);
  assert.equal(value.events.coverage, 'filtered'); assert.equal(value.events.deliveryIssues, 1);
  s.ai.enabled = true;
  value = plain(automationStatus(s)); assert.equal(value.automatic.method, 'server'); assert.equal(value.automatic.recommendedRoute, 'auto');
  const handle = s.service.agents.connect(user, { session: 'PRIVATE_ACTIVE_SESSION', agent: '내 ChatGPT', client: 'hwpx-codex-worker', channel: true }, response());
  value = plain(automationStatus(s));
  assert.equal(value.automatic.method, 'channel'); assert.equal(value.channels.primary.client, 'hwpx-codex-worker');
  assert.equal(value.automatic.recommendedRoute, 'auto'); assert.ok(!JSON.stringify(value).includes('PRIVATE_ACTIVE_SESSION'));
  s.service.agents.disconnect(handle); assert.equal(plain(automationStatus(s)).automatic.method, 'server');
});

test('체험 계정 상태는 개인 채널·자기 키·공용 모의 AI보다 관리자 공유 API를 표시하고 API 미연결 시 중단을 안내한다', () => {
  const s = setup();
  s.service._tutorialApiOnly = name => name === user.name;
  s.ai = { enabled: true, mock: true, provider: 'openai' };
  s.service.agents.connect(user, { session: 'demo-cli', agent: 'Codex / Claude Code', channel: true }, { write() {}, end() {} });
  s.personalAi = { status() { assert.fail('체험 상태 조회는 사용자 개인 키를 선택하지 않아야 한다'); } };
  s.service.personalAi = { forUser() { assert.fail('체험 상태 조회는 사용자 개인 키를 실행 경로로 확인하지 않아야 한다'); } };
  for (const active of [true, false]) {
    const shared = { active, configured: active, apiOnly: true, shared: true, provider: active ? 'anthropic' : null, model: active ? 'shared-api-model' : null, gateway: active ? 'baze' : null };
    s.service.tutorialAiStatus = name => { assert.equal(name, user.name); return shared; };
    const value = automationStatus(s);
    assert.equal(value.apiOnly, true);
    assert.deepEqual([value.automatic.available, value.automatic.method, value.automatic.recommendedRoute], [active, 'server', 'server']);
    assert.equal(value.automatic.state, active ? 'connected' : 'needs_setup');
    assert.equal(value.channels.online, true, '개인 채널의 연결 정보는 보존하지만 자동 처리 경로로 홍보하지 않는다');
    assert.deepEqual(value.personalAi, shared);
    assert.deepEqual(value.serverAi, { enabled: active, provider: shared.provider, gateway: shared.gateway, model: shared.model, mock: false });
    assert.match(value.automatic.message, /관리자 API|관리자가 공유한 API/);
    assert.doesNotMatch(value.automatic.message, /Codex|Claude Code|내 AI|개인 실행기|대기열|사용료|내 키/);
    assert.match(value.automatic.message, active ? /중단/ : /연결 확인/);
  }
});

test('연결 안내 차례(2026-11-13): 내 PC 의 Codex·Claude Code(추가 비용 없음) 먼저, ChatGPT 앱·내 AI 키(사용료 별도)는 뒤', () => {
  const none = automationStatus(setup()).automatic.message;
  const at = (word) => { const i = none.indexOf(word); assert.ok(i >= 0, `${word} 없음: ${none}`); return i; };
  assert.ok(at('Codex') < at('ChatGPT 앱') && at('Claude Code') < at('ChatGPT 앱') && at('ChatGPT 앱') < at('내 AI 키'));
  assert.match(none, /추가 비용 없이/); assert.ok(none.includes('내 AI 키(사용료 별도)'));
  // 내 키로 처리 중이어도 구독 AI 를 켜면 그쪽이 먼저라는 것을 알린다(라우팅: 채널 → 내 키 → 대기열)
  const s = setup({ personalAi: { status: () => ({ configured: true, active: true, provider: 'openai', gateway: 'baze' }) } });
  s.service.personalAi = { forUser: () => ({ enabled: true }) };
  const personal = automationStatus(s).automatic;
  assert.equal(personal.method, 'personal'); assert.match(personal.message, /사용료는 내 키에 부과/); assert.match(personal.message, /Codex나 Claude Code 실행기를 켜 두면 그쪽이 먼저/);
});

test('HTTP 자동 처리 상태는 인증·no-store 적용, 요청을 선점하지 않고 사용자별 수를 반환', { timeout: 30000 }, async () => {
  const srv = await startServer({ config: { publicUrl: 'https://example.test' } });
  try {
    assert.equal((await fetch(`${srv.base}/api/automation/status`)).status, 401);
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const create = who => srv.api(who)(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', instruction: 'PRIVATE_TEST_INSTRUCTION', target: { ref: 's0/p0' } } });
    const first = await create('a'); await create('b');
    const result = await srv.api('a').res('/api/automation/status');
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.data.queue.pending, 1); assert.equal(result.data.automatic.available, false);
    assert.equal(result.data.events.enabled, true); assert.equal(result.data.events.activeSubscriptions, 0);
    assert.ok(!JSON.stringify(result.data).includes('PRIVATE_TEST_INSTRUCTION'));
    const unchanged = await srv.api('a')(`/api/docs/${doc.id}/requests/${first.request.rid}`);
    assert.equal(unchanged.status, 'pending'); assert.equal(unchanged.claim, null);
  } finally { await srv.stop(); }
});

test('HTTP에서 실제 임시 튜토리얼 요청을 집계하고 취소 후 빼며 다른 사용자에게는 노출하지 않는다',{timeout:30000},async()=>{
  // 2026-11-12 부터 연습 문서의 요청은 모두 예시 답변으로 바로 끝난다 — 대기 중인 임시 연습 요청을 만들려고 예시 답변을 끈다(examples:false — 예전 경로)
  const srv=await startServer({config:{tutorial:{examples:false}}});
  try{
    const A=srv.api('a'),B=srv.api('b');
    const session=await A('/api/tutorial/start',{method:'POST',body:{tutorialId:'report'}});
    const base=(await A('/api/automation/status')).queue;
    const made=await A(`/api/docs/${session.docId}/requests`,{method:'POST',body:{kind:'instruct',target:{scope:'document'},instruction:'PRIVATE_TEMP_REQUEST',route:'queue'}});
    assert.equal(made.route,'queue');
    const status=await A('/api/automation/status');assert.equal(status.queue.pending,base.pending+1);assert.equal(status.queue.pendingByRoute.queue,(base.pendingByRoute?.queue||0)+1);
    assert.equal((await B('/api/automation/status')).queue.pending,0);
    assert.ok(!JSON.stringify(status).includes('PRIVATE_TEMP_REQUEST'));assert.ok(!JSON.stringify(status).includes(session.docId));
    const untouched=await A(`/api/docs/${session.docId}/requests/${made.request.rid}`);assert.equal(untouched.status,'pending');assert.equal(untouched.claim,null);
    await A(`/api/docs/${session.docId}/requests/${made.request.rid}/cancel`,{method:'POST',body:{}});
    assert.equal((await A('/api/automation/status')).queue.pending,base.pending);
  }finally{await srv.stop();}
});
