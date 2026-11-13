import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from '../server/bridge.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';
import { adminConnection } from '../server/admin-mcp-stdio.js';
const json = result => { assert.ok(!result.isError, result.content?.[0]?.text); return JSON.parse(result.content.find(c => c.type === 'text').text); };
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
async function connect(srv, endpoint, token = srv.tokens.admin) {
  const client = new Client({ name: 'codex', version: 'admin-route-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}${endpoint}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return { client, transport, async close() { await transport.terminateSession().catch(() => {}); await client.close(); } };
}
const raw = (srv, endpoint, token, body, session) => fetch(`${srv.base}${endpoint}`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body) });

test('admin route rejects unauthenticated/editors before discovery and separates normal sessions', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' }); const connections = [];
  try {
    const query = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} };
    assert.equal((await raw(srv, '/mcp/admin-test', null, query)).status, 401);
    assert.equal((await raw(srv, '/mcp/admin-test', srv.tokens.a, query)).status, 403);
    assert.equal((await srv.api('a').res('/api/admin/mcp-test')).status, 403);
    const normal = await connect(srv, '/mcp'); connections.push(normal);
    const admin = await connect(srv, '/mcp/admin-test'); connections.push(admin);
    const tools = (await admin.client.listTools()).tools;
    assert.equal(tools.length, 13);
    assert.ok(JSON.stringify(tools).length < JSON.stringify((await normal.client.listTools()).tools).length / 2);
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    assert.equal((await raw(srv, '/mcp/admin-test', srv.tokens.admin, list, normal.transport.sessionId)).status, 404);
    assert.equal((await raw(srv, '/mcp', srv.tokens.admin, list, admin.transport.sessionId)).status, 404);
    assert.equal((await raw(srv, '/mcp/admin-test', srv.tokens.a, list, admin.transport.sessionId)).status, 403);
  } finally { for (const c of connections) await c.close(); await srv.stop(); }
});

test('admin compact route preserves web request and writes through the same live service', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' }); const connections = [];
  try {
    const doc = await uploadDoc(srv.base, srv.tokens.admin, fixture('tool_memo_tracked.hwpx'));
    const api = srv.api('admin');
    const paragraphs = await api(`/api/docs/${doc.id}/paragraphs`);
    const source = paragraphs.find(p => p.ref === 's0/p0').text;
    const request = (await api(`/api/docs/${doc.id}/requests`, { method: 'POST', body: { kind: 'instruct', route: 'queue', target: { ref: 's0/p0' }, instruction: '원문과 서식을 보존하며 시험 메모와 문장 수정을 저장합니다.' } })).request;
    const args = { doc_id: doc.id, request_id: request.rid, expected_attempt: request.attempt || 1 };
    const normal = await connect(srv, '/mcp'); connections.push(normal);
    const admin = await connect(srv, '/mcp/admin-test'); connections.push(admin);
    const original = json(await call(normal.client, 'get_request', args));
    const reduced = json(await call(admin.client, 'get_request', args));
    assert.equal(reduced.instruction, original.instruction); assert.deepEqual(reduced.contextItems, original.contextItems);
    assert.ok(JSON.stringify(reduced).length < JSON.stringify(original).length);
    assert.equal(reduced.context, undefined); assert.equal(reduced.howTo, undefined);
    json(await call(admin.client, 'start_request', args));
    const proposal = json(await call(admin.client, 'propose_changes', { ...args, proposals: [{ ref: 's0/p0', find: source, replace: `${source} 관리자 경로 확인` }] }));
    assert.ok(proposal);
    json(await call(admin.client, 'add_memo', { ...args, ref: 's0/p0', text: '관리자 실험 경로의 검토 메모' }));
    json(await call(admin.client, 'complete_request', { ...args, summary: '시험 제안과 메모를 저장했습니다.' }));
    assert.ok((await api(`/api/docs/${doc.id}/proposals`)).length);
    json(await call(admin.client, 'enable_tools', { groups: ['formatting', 'toc', 'figures', 'files'] }));
    const loaded = (await admin.client.listTools()).tools.map(t => t.name);
    for (const name of ['audit_formatting', 'inspect_toc', 'render_figure_preview', 'get_attachment_file', 'save_result_file']) assert.ok(loaded.includes(name), name);
    assert.ok(!loaded.includes('download_attachment_file'), 'server must not expose its local filesystem');
    const status = await api('/api/admin/mcp-test'); assert.equal(status.adminOnly, true); assert.equal(status.modelTokens, null);
    assert.ok(!JSON.stringify(status).includes(source)); assert.ok(!JSON.stringify(status).includes(srv.tokens.admin));
  } finally { for (const c of connections) await c.close(); await srv.stop(); }
});

test('modern admin discovery keeps a fixed tool list and normal modern MCP remains available', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const discovery = await raw(srv, '/mcp/admin-test', srv.tokens.admin, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
    assert.equal((await discovery.json()).result.serverInfo.name, 'hwpx-admin-test');
    const invoke = async (name, args) => {
      const method = name ? 'tools/call' : 'tools/list';
      const params = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} }, ...(name ? { name, arguments: args } : {}) };
      const result = await fetch(`${srv.base}/mcp/admin-test`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.admin}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, ...(name ? { 'MCP-Name': name } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) });
      assert.equal(result.status, 200); return (await result.json()).result;
    };
    const before = (await invoke()).tools;
    json(await invoke('enable_tools', { groups: ['all'] }));
    assert.deepEqual((await invoke()).tools, before);
    assert.ok(before.some(t => t.name === 'inspect_toc'));
    const standard = await raw(srv, '/mcp', srv.tokens.a, { jsonrpc: '2.0', id: 3, method: 'server/discover' });
    assert.equal((await standard.json()).result.serverInfo.name, 'hwpx-cowork');
  } finally { await srv.stop(); }
});

test('Codex connector reads admin credential privately and uses same HTTPS origin', async () => {
  const srv = await startServer({ ai: 'off' });
  try {
    const config = JSON.parse(fs.readFileSync(srv.configPath, 'utf8'));
    const privateConfig = path.join(srv.tmpDir, 'connector.json');
    fs.writeFileSync(privateConfig, JSON.stringify({ ...config, publicUrl: 'https://example.test/hwpx' }));
    const connection = adminConnection({ configFile: privateConfig });
    assert.equal(connection.url, 'https://example.test/hwpx/mcp/admin-test');
    assert.equal(connection.token, srv.tokens.admin);
    assert.throws(() => adminConnection({ configFile: privateConfig, adminName: srv.users.a.name }), /관리자/);
  } finally { await srv.stop(); }
});

test('Codex bridge forwards tool enablement notifications and keeps file bytes on the client', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' }); let bridge, client;
  try {
    bridge = await createBridge({ url: `${srv.base}/mcp/admin-test`, token: srv.tokens.admin,
      filesDir: path.join(srv.tmpDir, 'codex-files'), forwardToolListChanges: true, log: () => {} });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await bridge.start(right);
    client = new Client({ name: 'codex', version: 'bridge-test' });
    let notices = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notices++; });
    await client.connect(left);
    assert.equal((await client.listTools()).tools.length, 15);
    json(await call(client, 'enable_tools', { groups: ['formatting'] }));
    assert.ok(notices > 0);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('audit_formatting')); assert.ok(names.includes('upload_result_file'));
    assert.ok(!names.includes('save_result_file'));
  } finally { await client?.close(); await bridge?.stop(); await srv.stop(); }
});
