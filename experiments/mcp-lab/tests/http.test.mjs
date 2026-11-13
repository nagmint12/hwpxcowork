import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLabRuntime } from '../runtime.mjs';
import { startLabHttp } from '../http.mjs';
import { seedLab, parseOptions } from '../serve.mjs';

test('loopback test route initializes MCP, isolates users and exports an actual copy', async () => {
  const runtime = createLabRuntime(); let http, client;
  try {
    const seed = await seedLab(runtime);
    http = await startLabHttp(runtime);
    const auth = { Authorization: `Bearer ${runtime.users.owner.token}` };
    assert.equal((await fetch(`${http.base}/health`)).status, 200);
    assert.equal((await fetch(`${http.base}/lab/documents`)).status, 401);
    assert.equal((await fetch(`${http.base}/lab/documents`, { headers: { ...auth, Origin: 'https://example.invalid' } })).status, 403);
    client = new Client({ name: 'lab-http-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${http.base}/mcp`), { requestInit: { headers: auth } });
    await client.connect(transport);
    const list = await client.listTools(); assert.ok(list.tools.length < 20);
    const result = await client.callTool({ name: 'get_request', arguments: seed });
    assert.ok(!result.isError, JSON.stringify(result));
    const raw = await fetch(`${http.base}/lab/documents/${seed.doc_id}/file`, { headers: auth });
    assert.equal(raw.status, 200); assert.ok((await raw.arrayBuffer()).byteLength > 1000);
    const other = { Authorization: `Bearer ${runtime.users.other.token}` };
    assert.equal((await fetch(`${http.base}/lab/documents/${seed.doc_id}/file`, { headers: other })).status, 404);
    const badInstruction = await fetch(`${http.base}/lab/guidance`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_id: seed.doc_id, request_id: seed.request_id, user_instruction: 'replacement' }) });
    assert.equal(badInstruction.status, 400);
    const trace = await (await fetch(`${http.base}/lab/metrics`, { headers: auth })).json();
    assert.equal(trace.sessions[0].modelTokens, null);
    await transport.terminateSession();
  } finally { await client?.close(); await http?.close(); await runtime.close(); }
});

test('launcher rejects unknown switches and live default port', async () => {
  assert.throws(() => parseOptions(['--production']), /Unknown/);
  const runtime = createLabRuntime();
  try { await assert.rejects(startLabHttp(runtime, { port: 8787 }), /forbidden/); }
  finally { await runtime.close(); }
});

test('rejected MCP initialization does not reserve unreachable sessions', async () => {
  const runtime = createLabRuntime(); let http;
  try {
    http = await startLabHttp(runtime);
    const response = await fetch(`${http.base}/mcp`, { method: 'POST',
      headers: { Authorization: `Bearer ${runtime.users.owner.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rejected-test', version: '1' } } }) });
    assert.equal(response.status, 406);
    assert.equal(http.sessions.size, 0);
  } finally { await http?.close(); await runtime.close(); }
});
