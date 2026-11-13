// 표준 Mcp-Session-Id만 사용하는 클라이언트의 선점 분리와 기존 단발 호출 호환을 함께 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { openAiClaimSession } from '../server/mcp-session.js';

test('OpenAI 선점 ID는 인증된 사용자·작업·주체에 묶이며 헤더 원문을 노출하지 않는다', () => {
  const user = { name: '사용자', token: 'private-user-token' };
  const headers = { 'x-openai-session': 'task-A', 'x-openai-subject': 'subject-A' };
  const id = openAiClaimSession(headers, user);
  assert.match(id, /^openai_[a-f0-9]{56}$/);
  assert.equal(id, openAiClaimSession({ ...headers }, user));
  assert.notEqual(id, openAiClaimSession({ ...headers, 'x-openai-session': 'task-B' }, user));
  assert.notEqual(id, openAiClaimSession({ ...headers, 'x-openai-subject': 'subject-B' }, user));
  assert.notEqual(id, openAiClaimSession(headers, { ...user, token: 'another-user-token' }));
  assert.equal(openAiClaimSession({}, user), null);
  assert.equal(openAiClaimSession({ 'x-openai-session': ['duplicate', 'value'] }, user), null);
});

test('ChatGPT는 호출마다 MCP 연결을 바꿔도 같은 작업의 시작→제안→완료를 이어간다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const connections = [];
  try {
    const connect = async ({ task = 'openai-task-A', subject = 'openai-user', token = srv.tokens.a, explicit } = {}) => {
      const client = new Client({ name: 'chatgpt', version: 'reconnect-test' });
      const headers = { Authorization: `Bearer ${token}`, 'X-OpenAI-Session': task, 'X-OpenAI-Subject': subject, ...(explicit ? { 'X-Hwpx-Agent-Session': explicit } : {}) };
      const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers } });
      connections.push({ client, transport }); await client.connect(transport); return { client, transport };
    };
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const request = (await srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const target = { doc_id: doc.id, request_id: request.rid };
    const a = await connect();
    value(await a.client.callTool(args('start_request', target)));
    await a.transport.terminateSession(); await a.client.close();
    const b = await connect();
    assert.notEqual(a.transport.sessionId, b.transport.sessionId);
    assert.equal(value(await b.client.callTool(args('get_request', target))).claim.mine, true);
    for (const options of [{ task: 'openai-task-B' }, { subject: 'different-subject' }]) {
      const other = await connect(options);
      const blocked = await other.client.callTool(args('start_request', target));
      assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /CLAIMED/);
    }
    const userB = await connect({ token: srv.tokens.b });
    assert.equal((await userB.client.callTool(args('start_request', target))).isError, true);
    const paragraphs = await srv.api('a')(`/api/docs/${doc.id}/paragraphs`);
    const original = paragraphs.find(p => p.ref === 's0/p0').text;
    value(await b.client.callTool(args('propose_changes', { ...target, proposals: [{ ref: 's0/p0', find: original, replace: `${original} 재연결 확인` }] })));
    const c = await connect();
    assert.equal(value(await c.client.callTool(args('complete_request', { ...target, summary: '재연결 후 제안과 완료 성공' }))).status, 'done');
    const legacyRequest = (await srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const bridge = await connect({ explicit: 'bridge-explicit-session' });
    assert.equal(value(await bridge.client.callTool(args('start_request', { doc_id: doc.id, request_id: legacyRequest.rid }))).claim.session, 'bridge-explicit-session');
    const wrongContext = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': b.transport.sessionId, 'X-OpenAI-Session': 'another-task', 'X-OpenAI-Subject': 'openai-user' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) });
    assert.equal(wrongContext.status, 400);
  } finally {
    await Promise.allSettled(connections.map(async ({ client, transport }) => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); }));
    await srv.stop();
  }
});

const args = (name, arguments_ = {}) => ({ name, arguments: arguments_ });
const value = (result) => {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content.find((c) => c.type === 'text').text);
};
async function raw(srv, body, { session, token = srv.tokens.a, method = 'POST' } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  if (session) headers['Mcp-Session-Id'] = session;
  const response = await fetch(`${srv.base}/mcp`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  const event = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  return { response, json: text ? JSON.parse(event ? event.slice(5) : text) : null };
}

test('커스텀 헤더 없는 같은 ChatGPT 두 연결도 세션·선점을 분리하고 다른 사용자 세션 접근을 막는다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  const connections = [];
  try {
    const connect = async (session) => {
      const client = new Client({ name: 'chatgpt', version: 'test' });
      const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, ...(session ? { 'X-Hwpx-Agent-Session': session } : {}) } },
      });
      const connection = { client, transport }; connections.push(connection);
      await client.connect(transport);
      return connection;
    };
    const a = await connect(); const b = await connect();
    assert.ok(a.transport.sessionId);
    assert.notEqual(a.transport.sessionId, b.transport.sessionId);
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const api = srv.api('a');
    const create = async () => (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const request = await create();
    const target = { doc_id: doc.id, request_id: request.rid };
    const claimed = value(await a.client.callTool(args('claim_next_request', { doc_id: doc.id })));
    assert.equal(claimed.rid, request.rid);
    assert.equal(claimed.claim.mine, true);
    const other = value(await b.client.callTool(args('get_request', target)));
    assert.equal(other.claim.mine, false);
    const paragraphs = await api(`/api/docs/${doc.id}/paragraphs`);
    const original = paragraphs.find((p) => p.ref === 's0/p0').text;
    for (const [name, body] of [
      ['start_request', target],
      ['propose_change', { ...target, ref: 's0/p0', find: original, replace: `${original} 중복` }],
      ['complete_request', { ...target, summary: '다른 대화의 완료' }],
    ]) {
      const denied = await b.client.callTool(args(name, body));
      assert.equal(denied.isError, true, name);
      assert.match(denied.content[0].text, /CLAIMED/, name);
    }
    const proposal = value(await a.client.callTool(args('propose_change', { ...target, ref: 's0/p0', find: original, replace: `${original} 확인` })));
    assert.match(proposal.by, /\(ChatGPT\)$/, 'initialize의 clientInfo 이름이 이후 호출에도 유지되어야 함');
    const done = value(await a.client.callTool(args('complete_request', { ...target, summary: '연결별 선점을 확인했습니다.' })));
    assert.equal(done.status, 'done');
    // SDK가 열어 둔 GET 스트림이 있으면 표준 409, 없으면 새 SSE 200을 돌려준다(405가 아님).
    const stream = await fetch(`${srv.base}/mcp`, { headers: {
      Authorization: `Bearer ${srv.tokens.a}`, 'Mcp-Session-Id': a.transport.sessionId, Accept: 'text/event-stream',
    }, signal: AbortSignal.timeout(3000) });
    assert.ok([200, 409].includes(stream.status), `표준 세션 GET: ${stream.status}`);
    await stream.body?.cancel();
    for (const method of ['POST', 'GET', 'DELETE']) {
      const denied = await raw(srv, method === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } : null, { session: a.transport.sessionId, token: srv.tokens.b, method });
      assert.equal(denied.response.status, 404, `다른 사용자 ${method}`);
    }
    const unknown = await raw(srv, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { session: 'no-such-session' });
    assert.equal(unknown.response.status, 404);
    const explicit = await connect('bridge_existing_session');
    const bridgeRequest = await create();
    const bridgeClaim = value(await explicit.client.callTool(args('start_request', { doc_id: doc.id, request_id: bridgeRequest.rid })));
    assert.equal(bridgeClaim.claim.session, 'bridge_existing_session', 'Claude 브리지의 기존 SSE 선점 ID를 유지');
    const oldSession = a.transport.sessionId;
    await a.transport.terminateSession();
    const deleted = await raw(srv, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { session: oldSession });
    assert.equal(deleted.response.status, 404, 'DELETE 뒤 세션을 재사용할 수 없음');
    assert.ok(value(await b.client.callTool(args('list_documents'))).some((d) => d.id === doc.id), '다른 연결은 유지');
    const legacy = await raw(srv, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: args('list_documents') });
    assert.equal(legacy.response.status, 200);
    assert.equal(legacy.response.headers.get('mcp-session-id'), null);
    assert.ok(value(legacy.json.result).some((d) => d.id === doc.id));
    assert.equal((await raw(srv, null, { method: 'GET' })).response.status, 405);
    assert.equal((await raw(srv, null, { method: 'DELETE' })).response.status, 405);
  } finally {
    await Promise.allSettled(connections.map(async ({ client, transport }) => { await transport.terminateSession().catch(() => {}); await client.close(); }));
    await srv.stop();
  }
});

test('표준 MCP 세션 256개 상한에서 오래된 연결만 정리하고 최근 연결은 유지한다', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    let first; let last;
    for (let i = 0; i < 257; i++) {
      const init = await raw(srv, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'chatgpt', version: 'test' },
      } });
      assert.equal(init.response.status, 200);
      last = init.response.headers.get('mcp-session-id');
      assert.ok(last);
      first ||= last;
    }
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    assert.equal((await raw(srv, body, { session: first })).response.status, 404);
    assert.equal((await raw(srv, body, { session: last })).response.status, 200);
    assert.equal((await raw(srv, null, { session: last, method: 'DELETE' })).response.status, 200);
    assert.equal((await raw(srv, body, { session: last })).response.status, 404);
  } finally {
    await srv.stop();
  }
});

test('브리지(Claude Code 채널): 서버가 MCP 세션을 잊어도(30분 유휴 정리·서버 재시작) 다음 도구 호출이 새 세션으로 이어지고 선점도 그대로', { timeout: 30000 }, async () => {
  const { createBridge } = await import('../server/bridge.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const srv = await startServer({ ai: 'off' });
  let sid = null;
  const fetchImpl = async (url, init) => { const res = await fetch(url, init); sid = res.headers.get('mcp-session-id') || sid; return res; };
  const bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, channel: false, fetchImpl, log: () => {} });
  const client = new Client({ name: 'claude-code', version: 'expiry-test' });
  try {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await bridge.server.connect(st); await client.connect(ct);
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const request = (await srv.api('a')(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'review', route: 'queue', target: { ref: 's0/p0' } } })).request;
    const target = { doc_id: doc.id, request_id: request.rid };
    value(await client.callTool(args('start_request', target)));
    const first = sid;
    const gone = await fetch(`${srv.base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Mcp-Session-Id': first, 'X-Hwpx-Agent-Session': bridge.session } });
    assert.equal(gone.status, 200);
    assert.equal(value(await client.callTool(args('get_request', target))).claim.mine, true, '새 MCP 세션에서도 같은 선점');
    assert.notEqual(sid, first);
    assert.ok((await client.listTools()).tools.length > 10);
    assert.equal(value(await client.callTool(args('complete_request', { ...target, summary: '세션 정리 뒤 검토 완료', no_changes_reason: '대상 문단을 검토했으며 수정할 내용이 없습니다.' }))).status, 'done');
  } finally {
    await client.close().catch(() => {}); await bridge.stop(); await srv.stop();
  }
});

test('브리지: 새 세션으로 다시 붙은 뒤(서버 재시작) 도구 목록이 바뀌었으면 notifications/tools/list_changed, 같으면 알리지 않는다', { timeout: 30000 }, async () => {
  const { createBridge } = await import('../server/bridge.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const srv = await startServer({ ai: 'off' });
  let sid = null; let newTool = false;
  // 서버를 다시 띄워 새 도구가 생긴 것처럼: 켜면 tools/list 응답 맨 앞에 도구 하나를 더한다
  const fetchImpl = async (url, init) => {
    const res = await fetch(url, init); sid = res.headers.get('mcp-session-id') || sid;
    if (!newTool || !String(init?.body || '').includes('"tools/list"')) return res;
    const body = (await res.text()).replace('"tools":[', '"tools":[{"name":"zz_new_tool","inputSchema":{"type":"object"}},');
    const headers = new Headers(res.headers); headers.delete('content-length');
    return new Response(body, { status: res.status, headers });
  };
  const bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, channel: false, fetchImpl, log: () => {} });
  const client = new Client({ name: 'claude-code', version: 'list-changed-test' });
  let notices = 0;
  const until = async (fn, what) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > 5000) throw new Error(`${what} — 5초 안에 안 됨`); await new Promise((r) => setTimeout(r, 50)); } };
  const forget = async () => assert.equal((await fetch(`${srv.base}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Mcp-Session-Id': sid, 'X-Hwpx-Agent-Session': bridge.session } })).status, 200);
  try {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notices++; });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await bridge.server.connect(st); await client.connect(ct);
    const before = (await client.listTools()).tools.map((t) => t.name);
    // 같은 서버(목록 그대로)로 다시 붙음 → 알리지 않는다
    await forget();
    value(await client.callTool(args('list_documents', {})));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(notices, 0, '목록이 같으면 list_changed 없음');
    // 새 도구가 생긴 서버로 다시 붙음 → list_changed, 다시 받은 목록에 새 도구
    newTool = true;
    await forget();
    value(await client.callTool(args('list_documents', {})));
    await until(() => notices === 1, '도구가 바뀌면 list_changed');
    const after = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(after.includes('zz_new_tool') && !before.includes('zz_new_tool'));
  } finally {
    await client.close().catch(() => {}); await bridge.stop(); await srv.stop();
  }
});
