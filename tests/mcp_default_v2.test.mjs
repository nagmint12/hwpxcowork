// MCP 기본 연결 = 새 연결(v2) 시험(2026-11-17 사용자 결정 — server/mcp2.js mcpSurface). 모델·실제 AI 를 부르지 않는다.
//  · 순수 함수: 연결 종류 고르기(mcpSurface — 머리글·주소·lean·설정·옛 클라이언트 호환·세션 없는 호출), 브리지 인자(bridgeSurface·parseBridgeArgs),
//    실행기 인자(ai-worker --mcp — 모든 제공자, 기본 2)
//  · 임시 서버(설정 없음 = 운영 기본): 밝히지 않은 연결은 v2('all'), 예전 연결은 X-Hwpx-Mcp: 1·?v=1·lean 일 때만, 'hwpx-…' 옛 실행기·브리지와
//    세션 없는 한 번짜리 호출은 예전 연결, 2026-07-28(무상태)도 같은 규칙 — 도구 목록·서버 안내·이벤트 설명이 연결에 맞게 나간다
//  · 임시 서버(설정 mcp.defaultSurface 'v1' — 시험 받침 기본): 밝히지 않으면 예전 연결, 밝힌 새 연결은 그대로
//  · 브리지 기본(인자 없음) = 새 연결(X-Hwpx-Mcp: 2), surface v1 = 예전 연결, 실행기의 모델 도구 연결(codex-mcp)은 요청 종류대로 밝힌다
//  · 에이전트 본보기(agent/CLAUDE.md = 새 연결, agent/v1/CLAUDE.md = 예전 연결)와 setup-agent 기본·묶음 목록
//   node --test tests/mcp_default_v2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startServer, root } from './helpers/server.mjs';
import { mcpSurface, requestedSurface, isV2Request, isLegacyClientName, v2Instructions } from '../server/mcp2.js';
import { createBridge, bridgeSurface, parseBridgeArgs, CHANNEL_INSTRUCTIONS_V2, CHANNEL_INSTRUCTIONS } from '../server/bridge.js';
import { createCodexMcpBridge } from '../server/codex-mcp.js';
import { parseWorkerArgs, createWorkerAi } from '../scripts/ai-worker.mjs';
import { main as setupAgent, mcpEntry, entrySurface, guideSurface } from '../scripts/setup-agent.mjs';

const req = (url = '/mcp', headers = {}) => ({ url, headers });
// 새 연결 'all'(task·read·edit·finish + 사람이 정할 일·변경 요청·멀티에이전트·새 문서)과 예전 연결의 대표 도구
const V2_MARK = ['task', 'read', 'edit', 'finish', 'list_documents', 'create_document', 'apply_proposal', 'review_change_request', 'claim_orchestration_task'];
const V1_MARK = ['read_document', 'propose_changes', 'claim_next_request', 'start_request', 'complete_request'];
const isV2 = (names) => V2_MARK.every((n) => names.includes(n)) && !V1_MARK.some((n) => names.includes(n));
const isV1 = (names) => V1_MARK.every((n) => names.includes(n)) && !['task', 'edit', 'finish'].some((n) => names.includes(n));

test('순수 함수: 연결 종류 고르기 — 기본 새 연결, 예전 연결은 밝힐 때·옛 클라이언트·세션 없는 호출·설정 v1', () => {
  const cfg2 = { mcp: { defaultSurface: 'v2' } }; const cfg1 = { mcp: { defaultSurface: 'v1' } };
  // 1) 밝힌 대로(머리글이 주소보다 먼저)
  assert.equal(requestedSurface(req()), null);
  assert.equal(requestedSurface(req('/mcp', { 'x-hwpx-mcp': '1' })), 'v1');
  assert.equal(requestedSurface(req('/mcp?v=2', { 'x-hwpx-mcp': '1' })), 'v1');
  assert.equal(requestedSurface(req('/mcp?v=1', { 'x-hwpx-mcp': '2' })), 'v2');
  assert.equal(requestedSurface(req('/mcp?v=1')), 'v1');
  assert.equal(requestedSurface(req('/mcp?v=4', { 'x-hwpx-mcp': 'x' })), null, '모르는 값은 밝히지 않은 것');
  assert.equal(isV2Request(req('/mcp?v=2')), true); assert.equal(isV2Request(req()), false, 'isV2Request 는 밝혔는지만 본다(기본은 mcpSurface)');
  // 2) 표: [요청, 설정, clientName, legacyCall] → 연결
  const rows = [
    [req(), null, null, false, 'v2', '설정 없음·밝히지 않음 = 새 연결(웹 AI 커넥터 포함)'],
    [req(), cfg2, 'chatgpt', false, 'v2', 'ChatGPT'],
    [req(), cfg2, 'claude-code', false, 'v2', 'Claude Code(사용자 HTTP 연결)'],
    [req('/mcp', { 'x-hwpx-mcp': '1' }), cfg2, 'chatgpt', false, 'v1', '머리글 X-Hwpx-Mcp: 1'],
    [req('/mcp?v=1'), cfg2, 'chatgpt', false, 'v1', '주소 ?v=1'],
    [req('/mcp', { 'x-hwpx-lean': '1' }), cfg2, 'claude-code', false, 'v1', 'lean 머리글 = 예전 연결의 얇은 흐름'],
    [req('/mcp?lean=1'), cfg2, 'claude-code', false, 'v1', '?lean=1'],
    [req('/mcp', { 'x-hwpx-lean': '1', 'x-hwpx-mcp': '2' }), cfg2, null, false, 'v2', '밝힌 새 연결이 lean 보다 먼저(예전 그대로)'],
    [req(), cfg1, 'chatgpt', false, 'v1', '설정 v1 = 모두 예전 연결'],
    [req('/mcp', { 'x-hwpx-mcp': '2' }), cfg1, 'chatgpt', false, 'v2', '설정 v1 이어도 밝힌 새 연결은 그대로'],
    [req(), cfg2, 'hwpx-codex-worker', false, 'v1', '옛 실행기(머리글 없음)'],
    [req(), cfg2, 'hwpx-cowork-bridge', false, 'v1', '옛 브리지(머리글 없음 — 예전 기본)'],
    [req(), cfg2, 'hwpx-orchestration-codex-1', false, 'v1', '옛 멀티에이전트 작업자'],
    [req('/mcp', { 'x-hwpx-mcp': '2' }), cfg2, 'hwpx-cowork-bridge', false, 'v2', '새 브리지는 밝힌다(X-Hwpx-Mcp: 2)'],
    [req(), cfg2, null, true, 'v1', '세션 없는 한 번짜리 tools/call(옛 길)'],
    [req('/mcp?v=2'), cfg2, null, true, 'v2', '세션 없는 호출도 밝히면 새 연결'],
  ];
  for (const [r, config, clientName, legacyCall, want, why] of rows) assert.equal(mcpSurface(r, { config, clientName, legacyCall }), want, why);
  assert.ok(isLegacyClientName('hwpx-claude-code-worker') && isLegacyClientName(' HWPX-api-worker') && !isLegacyClientName('chatgpt') && !isLegacyClientName(null) && !isLegacyClientName('xhwpx-'));
  // 서버 안내: 'all' 은 맡은 요청 없이 직접 시킬 때의 길을 한 줄 더한다(core·Codex 실행기는 뺀다)
  assert.match(v2Instructions('홍길동'), /list_documents 로 문서를 찾아 read → edit\(request_id 없이\)/);
  assert.ok(!/list_documents/.test(v2Instructions('홍길동', { toolset: 'core' })));
});

test('순수 함수: 브리지 기본 새 연결(bridgeSurface·명령줄)과 실행기 --mcp(모든 제공자, 기본 2)', () => {
  assert.deepEqual(bridgeSurface({}), { surface: 'v2', lean: false });
  assert.deepEqual(bridgeSurface({ lean: true }), { surface: 'v1', lean: true }, '--lean = 예전 연결의 얇은 흐름');
  assert.deepEqual(bridgeSurface({ surface: 'v1' }), { surface: 'v1', lean: false });
  assert.deepEqual(bridgeSurface({ v2: true, lean: true }), { surface: 'v2', lean: false }, '예전 인자 --v2 그대로');
  assert.deepEqual(bridgeSurface({ url: 'http://h/mcp?v=1' }), { surface: 'v1', lean: false });
  assert.equal(parseBridgeArgs([], {}).surface, null);
  assert.equal(parseBridgeArgs(['--v1'], {}).surface, 'v1'); assert.equal(parseBridgeArgs(['--mcp', '1'], {}).surface, 'v1');
  assert.equal(parseBridgeArgs(['--v2'], {}).surface, 'v2', '옛 플래그 --v2 도 받는다'); assert.equal(parseBridgeArgs(['--mcp=2'], {}).surface, 'v2');
  assert.equal(parseBridgeArgs(['--mcp', 'x'], {}).bad.length, 1);
  // 실행기: 모든 제공자가 --mcp 1|2 를 받고 기본은 2. 그 밖의 값은 오류
  const env = { HWPX_COWORK_TOKEN: 't', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k' };
  const providers = [['codex'], ['claude-code'], ['gemini-cli'], ['antigravity'], ['openai', '--model', 'm'], ['anthropic', '--model', 'm'], ['gemini', '--model', 'm']];
  for (const [provider, ...rest] of providers) {
    const argv = ['--provider', provider, ...rest];
    assert.equal(parseWorkerArgs(argv, env).mcp, '2', `${provider}: 기본 2`);
    assert.equal(parseWorkerArgs([...argv, '--mcp', '1'], env).mcp, '1', `${provider}: --mcp 1`);
    assert.equal(parseWorkerArgs(argv, { ...env, HWPX_COWORK_MCP: '1' }).mcp, '1', `${provider}: HWPX_COWORK_MCP=1`);
    assert.throws(() => parseWorkerArgs([...argv, '--mcp', '4'], env), /--mcp.*1.*2.*3/, `${provider}: 잘못된 값`);
  }
  // 모델에게 넘기는 값: 구독 CLI 는 mcpSurface, API 는 ai.mcp('v2'|'v1' — server/ai.js normalizeMcp), Google CLI 는 MCP 를 쓰지 않아 받기만 한다
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex'], env), env).mcpSurface, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'codex', '--mcp', '1'], env), env).mcpSurface, null);
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-code'], env), env).mcpSurface, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'openai', '--model', 'm'], env), env).cfg.mcp, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'anthropic', '--model', 'm', '--mcp', '1'], env), env).cfg.mcp, 'v1');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'gemini', '--model', 'm'], env), env).cfg.mcp, 'v2');
  for (const provider of ['gemini-cli', 'antigravity']) {
    const ai = createWorkerAi(parseWorkerArgs(['--provider', provider, '--mcp', '1'], env), env);
    assert.equal(typeof ai.runMcp, 'undefined', `${provider}: 모델 MCP 연결이 없다(--mcp 는 영향 없음)`);
  }
});

// ───────── 임시 서버 ─────────
const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
async function connect(srv, { name = 'claude-code', headers = {}, query = '' } = {}) {
  const client = new Client({ name, version: 'default-v2-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, ...headers } } });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  return { client, names, instructions: client.getInstructions() || '', close: async () => { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); } };
}
async function oneShot(srv, name, args, headers = {}) {
  const r = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text(); const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : raw);
}
const MODERN = '2026-07-28';
async function modern(srv, method, params = {}, { clientName = 'chatgpt', headers = {} } = {}) {
  const r = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method,
    ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), 'X-OpenAI-Session': 'default-v2-task', 'X-OpenAI-Subject': 'default-v2-user', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: clientName, version: 'default-v2-test' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  return r.json();
}

test('임시 서버(설정 없음 = 운영 기본): 밝히지 않은 연결은 새 연결, 예전 연결은 밝힐 때·옛 클라이언트·세션 없는 호출만', { timeout: 90000 }, async (t) => {
  // config.mcp 를 비워 운영 기본(설정 없음)을 잰다 — 시험 받침의 기본(mcp.defaultSurface 'v1')을 덮는다. https 공개 주소 = MCP 이벤트 켬
  const srv = await startServer({ ai: 'off', config: { mcp: {}, publicUrl: 'https://cowork.example' } });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  const conn = async (o) => { const c = await connect(srv, o); open.push(c); return c; };
  assert.equal(srv.config.features.mcpDefault, 'v2', '/api/config features.mcpDefault');

  // 밝히지 않은 표준 연결(ChatGPT·Claude.ai·Claude Code 의 사용자 HTTP 연결) = 새 연결 'all', 서버 안내도 새 연결용
  for (const name of ['chatgpt', 'claude-ai', 'claude-code']) {
    const c = await conn({ name });
    assert.ok(isV2(c.names), `${name}: ${c.names.join(',')}`);
    assert.match(c.instructions, /task\(맡기/); assert.match(c.instructions, /list_documents 로 문서를 찾아/); assert.ok(!/start_request|propose_changes/.test(c.instructions));
  }
  // 도구 범위 core 는 밝히지 않아도 새 연결의 범위로 본다
  const core = await conn({ headers: { 'X-Hwpx-Tools': 'core' } });
  assert.deepEqual(core.names.sort(), ['edit', 'export_figure', 'export_skill_resource', 'finish', 'preview_figure', 'read', 'read_skill_resource', 'task']);
  assert.ok(!/list_documents/.test(core.instructions), 'core 안내에는 없는 도구를 적지 않는다');
  // 예전 연결은 밝힐 때: 머리글·주소·lean(머리글·주소)
  for (const [o, lean] of [[{ headers: { 'X-Hwpx-Mcp': '1' } }, false], [{ query: '?v=1' }, false], [{ headers: { 'X-Hwpx-Lean': '1' } }, true], [{ query: '?lean=1' }, true]]) {
    const c = await conn(o);
    assert.ok(isV1(c.names), `${JSON.stringify(o)}: ${c.names.join(',')}`);
    assert.match(c.instructions, lean ? /start_request 또는 claim_next_request 가 맡으면서/ : /claim_next_request\(또는 list_requests → get_request → start_request\)/, JSON.stringify(o));
  }
  // 머리글이 주소보다 먼저
  assert.ok(isV2((await conn({ headers: { 'X-Hwpx-Mcp': '2' }, query: '?v=1' })).names));
  assert.ok(isV1((await conn({ headers: { 'X-Hwpx-Mcp': '1' }, query: '?v=2' })).names));
  // 옛 실행기·브리지(머리글을 보내지 않는 이미 배포된 판): clientInfo 'hwpx-…' 는 예전 연결 — 대기열 도구(claim_next_request 등)를 잃지 않는다
  for (const name of ['hwpx-codex-worker', 'hwpx-claude-code-worker', 'hwpx-codex-guard', 'hwpx-cowork-bridge', 'hwpx-orchestration-codex-1']) {
    assert.ok(isV1((await conn({ name })).names), name);
  }
  // 새 실행기(머리글 X-Hwpx-Mcp: 1 — server/worker.js)도 예전 연결, 새 브리지는 'hwpx-' 라도 밝힌 새 연결
  assert.ok(isV2((await conn({ name: 'hwpx-cowork-bridge', headers: { 'X-Hwpx-Mcp': '2' } })).names));

  // 세션 없는 한 번짜리 tools/call(initialize 없는 옛 길): 밝히지 않으면 예전 연결, 밝히면 새 연결
  const legacy = await oneShot(srv, 'claim_next_request', {});
  assert.ok(!legacy.error && !legacy.result.isError, JSON.stringify(legacy).slice(0, 300));
  assert.deepEqual(JSON.parse(textOf(legacy.result)), { none: true });
  const noTask = await oneShot(srv, 'task', {});
  assert.ok(noTask.error || noTask.result?.isError, '밝히지 않은 한 번짜리 호출에는 새 연결 도구가 없다');
  const task = await oneShot(srv, 'task', {}, { 'X-Hwpx-Mcp': '2' });
  assert.deepEqual(JSON.parse(textOf(task.result)), { none: true });

  // 2026-07-28(무상태 — ChatGPT 이벤트): 같은 규칙. 발견(server/discover)·도구 목록·이벤트 설명이 연결에 맞게 나간다
  const discover = await modern(srv, 'server/discover');
  assert.match(discover.result.instructions, /task\(맡기/);
  assert.ok(isV2((await modern(srv, 'tools/list')).result.tools.map((x) => x.name)), 'ChatGPT(2026-07-28) 기본 = 새 연결');
  assert.ok(isV1((await modern(srv, 'tools/list', {}, { headers: { 'X-Hwpx-Mcp': '1' } })).result.tools.map((x) => x.name)), '2026-07-28 도 X-Hwpx-Mcp: 1 이면 예전 연결');
  assert.ok(isV1((await modern(srv, 'tools/list', {}, { clientName: 'hwpx-codex-worker' })).result.tools.map((x) => x.name)), '2026-07-28 도 hwpx- 는 예전 연결');
  assert.match((await modern(srv, 'server/discover', {}, { headers: { 'X-Hwpx-Mcp': '1' } })).result.instructions, /claim_next_request/);
  const events2 = (await modern(srv, 'events/list')).result.events;
  assert.match(events2[0].description, /task\(doc_id=document_id, request_id\)/); assert.ok(!/get_request|start_request|complete_request/.test(events2[0].description));
  const events1 = (await modern(srv, 'events/list', {}, { headers: { 'X-Hwpx-Mcp': '1' } })).result.events;
  assert.match(events1[0].description, /get_request → start_request/);
  assert.equal(events2[0].name, events1[0].name, '같은 이벤트 — 설명의 도구 이름만 연결에 맞춘다');
  const called = await modern(srv, 'tools/call', { name: 'task', arguments: {} });
  assert.deepEqual(JSON.parse(textOf(called.result)), { none: true });

  // 브리지 기본(인자 없음) = 새 연결(X-Hwpx-Mcp: 2 — 이 브리지의 client 이름 hwpx-cowork-bridge 라도 밝혀서 새 연결), surface v1 = 예전 연결
  const seen = [];
  const fetchImpl = async (url, init) => { const h = new Headers(init?.headers); if (String(url).includes('/mcp')) seen.push(h.get('x-hwpx-mcp')); return fetch(url, init); };
  for (const [opts, check] of [[{}, isV2], [{ surface: 'v1' }, isV1], [{ lean: true }, isV1]]) {
    seen.length = 0;
    const bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, channel: false, fetchImpl, log() {}, ...opts });
    const client = new Client({ name: 'claude-code', version: 'default-v2-test' });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b); await client.connect(a);
      const names = (await client.listTools()).tools.map((x) => x.name);
      assert.ok(check(names), `${JSON.stringify(opts)}: ${names.join(',')}`);
      assert.ok(seen.length && seen.every((v) => v === (bridge.surface === 'v2' ? '2' : '1')), `${JSON.stringify(opts)}: 머리글 ${seen.join(',')}`);
      assert.equal(bridge.surface, opts.surface || (opts.lean ? 'v1' : 'v2'));
      if (!opts.surface && !opts.lean) assert.match(bridge.instructions, /task\(맡기/);
    } finally { await client.close().catch(() => {}); await bridge.stop(); }
  }
  const chan = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, channel: true, log() {} });
  assert.ok(chan.instructions.startsWith(CHANNEL_INSTRUCTIONS_V2) && !chan.instructions.startsWith(CHANNEL_INSTRUCTIONS), '채널 브리지 기본 = 새 연결 채널 안내');
  await chan.stop();

  // 실행기의 모델 도구 연결(server/codex-mcp.js — Codex·Claude Code 실행기): 브리지 기본이 새 연결이어도 요청 종류대로 밝힌다
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-default-v2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // (배정된 요청 하나만 다루는 허용 목록이라 claim_next_request 같은 대기열 도구는 원래 없다 — server/codex-mcp.js codexToolPolicy)
  const codexV1 = (n) => ['read_document', 'get_request', 'start_request', 'propose_changes', 'complete_request'].every((x) => n.includes(x)) && !n.includes('task') && !n.includes('edit');
  const codexV2 = (n) => ['task', 'read', 'edit', 'finish'].every((x) => n.includes(x)) && !n.includes('read_document') && !n.includes('get_request');
  for (const [job, check] of [[{ type: 'request', docId: 'doc_x', requestId: 1, attempt: 1 }, codexV1], [{ type: 'request', docId: 'doc_x', requestId: 1, attempt: 1, surface: 'v2' }, codexV2]]) {
    const bridge = await createCodexMcpBridge({ job, url: `${srv.base}/mcp`, token: srv.tokens.a, session: 'default-v2-session', filesDir: path.join(tmp, 'work'), log() {} });
    const client = new Client({ name: 'codex', version: 'default-v2-test' });
    try {
      const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b); await client.connect(a);
      const names = (await client.listTools()).tools.map((x) => x.name);
      assert.ok(check(names), `${job.surface || 'v1'} 작업: ${names.join(',')}`);
      assert.equal(bridge.surface, job.surface === 'v2' ? 'v2' : 'v1');
    } finally { await client.close().catch(() => {}); await bridge.stop(); }
  }
});

test('임시 서버(설정 mcp.defaultSurface v1 — 시험 받침 기본): 밝히지 않으면 예전 연결, 밝힌 새 연결·브리지 기본은 그대로 새 연결', { timeout: 60000 }, async (t) => {
  const srv = await startServer({ ai: 'off' });
  const open = [];
  t.after(async () => { for (const c of open) await c.close(); await srv.stop(); });
  assert.equal(srv.config.features.mcpDefault, 'v1');
  const plain = await connect(srv, { name: 'chatgpt' }); open.push(plain);
  assert.ok(isV1(plain.names), plain.names.join(','));
  const asked = await connect(srv, { name: 'chatgpt', headers: { 'X-Hwpx-Mcp': '2' } }); open.push(asked);
  assert.ok(isV2(asked.names), asked.names.join(','));
  const bridge = await createBridge({ url: `${srv.base}/mcp`, token: srv.tokens.a, log() {} });
  const client = new Client({ name: 'claude-code', version: 'default-v2-test' });
  try {
    const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b); await client.connect(a);
    assert.ok(isV2((await client.listTools()).tools.map((x) => x.name)), '브리지는 밝히므로 서버 설정과 상관없이 새 연결');
  } finally { await client.close().catch(() => {}); await bridge.stop(); }
});

test('에이전트 본보기·setup-agent 기본·묶음 목록: agent/CLAUDE.md = 새 연결, agent/v1/CLAUDE.md = 예전 연결', async (t) => {
  const v2Guide = fs.readFileSync(path.join(root, 'agent', 'CLAUDE.md'), 'utf8');
  const v1Guide = fs.readFileSync(path.join(root, 'agent', 'v1', 'CLAUDE.md'), 'utf8');
  assert.equal(guideSurface(v2Guide), 'v2'); assert.equal(guideSurface(v1Guide), 'v1');
  assert.ok(!fs.existsSync(path.join(root, 'agent', 'v2', 'CLAUDE.md')), '예전 자리(agent/v2/CLAUDE.md)는 없앴다 — 본보기는 하나씩');
  const example = JSON.parse(fs.readFileSync(path.join(root, 'agent', '.mcp.json.example'), 'utf8')).mcpServers.hwpx.args;
  assert.equal(entrySurface({ args: example }), 'v2'); assert.ok(!example.includes('--lean'));
  assert.deepEqual(mcpEntry('/b.js', 'http://x/mcp').args, ['/b.js', '--channel', '--v2', '--url', 'http://x/mcp']);
  // 배포 묶음·공개 저장소 목록이 새 자리를 싣는다(agent/v1/CLAUDE.md 가 없으면 --v1 로 준비할 때 지침을 쓰지 못한다)
  for (const file of ['scripts/package-portable.mjs', 'scripts/export-public-repo.mjs']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes("'agent/v1/CLAUDE.md'") && !text.includes("'agent/v2/CLAUDE.md'"), file);
  }
  // setup-agent 기본(인자 없음) = 새 연결
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-default-v2-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = console.log; console.log = () => {};
  try { assert.equal(await setupAgent(['--dir', dir, '--url', 'http://127.0.0.1:9/mcp', '--no-claude', '--no-server', '--no-registry'], { ...process.env, HWPX_COWORK_TOKEN: '' }), 0); }
  finally { console.log = log; }
  const args = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.hwpx.args;
  assert.equal(entrySurface({ args }), 'v2');
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), v2Guide);
});
