// MCP 2.0 HTTP 어댑터. 업무 도구/권한 검사는 기존 MCP SDK 서버를 그대로 호출한다.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, mcpInstructions } from './mcp.js';

export const MODERN_VERSION = '2026-07-28';
export const ALL_PROTOCOL_VERSIONS = [MODERN_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];
const key = suffix => `io.modelcontextprotocol/${suffix}`;
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message, data, status = 400) => Object.assign(new Error(message), { code, data, status });
const decodeHeader = value => {
  if (typeof value !== 'string') return value;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    try { return Buffer.from(value.slice(9, -2), 'base64').toString('utf8'); } catch { return null; }
  }
  return value;
};
export function isModernRequest(req) {
  const version = req.body?.params?._meta?.[key('protocolVersion')] || req.headers['mcp-protocol-version'];
  return req.body?.method === 'server/discover' || (typeof req.body?.method === 'string' && req.body.method.startsWith('events/')) || (!!version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version));
}

/** 이 요청의 클라이언트 이름(_meta 의 clientInfo.name — 2026-07-28 은 요청마다 싣는다). server/index.js 가 연결 종류(mcpSurface)를 정할 때 쓴다 */
export const modernClientName = (body) => {
  const info = body?.params?._meta?.[key('clientInfo')];
  return object(info) && typeof info.name === 'string' ? info.name : null;
};

/**
 * surface·toolset: 연결 종류(server/mcp2.js mcpSurface — 2026-11-17 부터 밝히지 않으면 'v2')와 새 연결의 도구 범위. 무상태라 요청마다 정해 받는다.
 * toolBackend 를 주는 관리자 경로(server/admin-mcp.js)는 그 도구·안내를 그대로 쓴다(surface 를 보지 않는다)
 */
export async function handleModernMcp({ req, res, user, principal, events, service, version, agentName, agentSession, trackOperation,
  toolBackend, instructions, serverName = 'hwpx-cowork', lean = false, surface = null, toolset = 'all' }) {
  const body = req.body; const id = body?.id ?? null;
  try {
    if (req.method !== 'POST') throw fail(-32600, 'POST required', undefined, 405);
    if (!object(body) || body.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof body.id) || typeof body.method !== 'string' || (body.params != null && !object(body.params))) throw fail(-32600, 'Invalid JSON-RPC request');
    const params = body.params || {}; const meta = params._meta || {};
    const requested = meta[key('protocolVersion')] || req.headers['mcp-protocol-version'];
    if (requested && requested !== MODERN_VERSION) throw fail(-32022, 'Unsupported protocol version', { supported: ALL_PROTOCOL_VERSIONS, requested });
    // discover의 버전 확인 probe만 메타데이터 없이도 허용한다. 이후 요청은 MCP 2.0 메타데이터/헤더를 요구한다.
    if (body.method !== 'server/discover' || requested) {
      if (req.headers['mcp-protocol-version'] !== MODERN_VERSION || meta[key('protocolVersion')] !== MODERN_VERSION || req.headers['mcp-method'] !== body.method) throw fail(-32020, 'MCP protocol/method header mismatch');
      const info = meta[key('clientInfo')];
      if (!object(info) || typeof info.name !== 'string' || !info.name || info.name.length > 200 || typeof info.version !== 'string' || !object(meta[key('clientCapabilities')])) throw fail(-32602, 'MCP client metadata is required');
      if (body.method === 'tools/call' && decodeHeader(req.headers['mcp-name']) !== params.name) throw fail(-32020, 'Mcp-Name header mismatch');
    }
    if (req.headers.origin) {
      let origin; try { origin = new URL(service.cfg.publicUrl).origin; } catch {}
      if (req.headers.origin !== origin) throw fail(-32024, 'Origin is not allowed', undefined, 403);
    }
    let result;
    if (body.method === 'server/discover') {
      result = { supportedVersions: ALL_PROTOCOL_VERSIONS, capabilities: { tools: {}, ...(events.enabled() ? { events: {} } : {}) }, serverInfo: { name: serverName, version }, instructions: instructions || mcpInstructions(user.name, service, { surface: toolBackend ? null : surface, lean, toolset }) };
    } else if (body.method === 'events/list') result = events.list(user, { surface: toolBackend ? null : surface });
    else if (body.method === 'events/subscribe') result = await events.subscribe(principal, params);
    else if (body.method === 'events/unsubscribe') result = await events.unsubscribe(principal, params);
    else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list' || body.method === 'tools/call') {
      if (toolBackend) {
        result = body.method === 'tools/list' ? toolBackend.list() : await toolBackend.call(params.name, params.arguments || {});
      } else {
      const info = meta[key('clientInfo')] || { name: 'chatgpt', version: 'mcp2' };
      const client = new Client(info);
      const server = createMcpServer({ service, user, version, agentName, agentSession, trackOperation, lean, surface: surface === 'v2' ? 'v2' : null, toolset });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        if (body.method === 'tools/list') result = await client.listTools({ ...(params.cursor ? { cursor: params.cursor } : {}) });
        else result = await client.callTool({ name: params.name, arguments: params.arguments || {} });
      } finally { await client.close(); await server.close(); }
      }
    } else throw fail(-32601, 'Method not found', undefined, 404);
    return res.set('Cache-Control', 'no-store').json({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete' } });
  } catch (error) {
    const known = Number.isInteger(error.code) && error.code < 0;
    return res.status(known ? error.status || 400 : 500).set('Cache-Control', 'no-store').json({ jsonrpc: '2.0', id, error: { code: known ? error.code : -32603, message: known ? error.message : 'Internal MCP error', ...(known && error.data ? { data: error.data } : {}) } });
  }
}
