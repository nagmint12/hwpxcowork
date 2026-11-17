// 원문 보존·판정 근거를 네트워크/모델 호출 없이 실제 파일과 비교한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAiDebug, withAiDebug, debugRecord, createDebugStdioTransport, debugStream } from '../server/ai-debug.js';
import { AiProposer, parseResult } from '../server/ai.js';
import { runProcess, CodexProposer } from '../server/codex-ai.js';
import { ClaudeCodeProposer } from '../server/claude-cli-ai.js';
import { createMcpServer } from '../server/mcp.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { captureClaudeHook } from '../agent/.claude/ai-debug-hook.mjs';
import { startServer, fixture } from './helpers/server.mjs';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { fakeClaude } from './helpers/claude-cli.mjs';

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-ai-debug-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function events(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return events(file);
    if (entry.name !== 'events.jsonl') return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => ({ ...JSON.parse(line), folder: dir }));
  });
}
const raw = event => fs.readFileSync(path.join(event.folder, event.file));
const payload = event => JSON.parse(raw(event));
const empty = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '검토했습니다.', instructionSummary: '검토', noChangesReason: '대상 문장의 문맥과 표현이 적절하여 변경이 필요하지 않습니다.' };
const input = { kind: 'instruct', target: { ref: 's0/p1' }, context: [{ ref: 's0/p1', text: '둘째 문단입니다.', isTarget: true }], attachments: [], instruction: '표현 확인' };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function envelope(provider, text) {
  return provider === 'anthropic' ? { model: 'test', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: {} }
    : provider === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: {} }
    : { status: 'completed', model: 'test', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: {} };
}

test('큰 한글·바이너리 원문을 자르지 않고 SHA256으로 확인하며 시도별 증거를 보존한다', t => {
  const dir = workspace(t), bytes = Buffer.concat([Buffer.from('한글 원문\r\n'.repeat(50000)), Buffer.from([0, 255, 10])]);
  const traces = [1, 2, 2].map(attempt => createAiDebug({ directory: dir, context: { docId: '..', requestId: 7, attempt } }));
  for (const trace of traces) {
    assert.ok(trace.directory.startsWith(dir + path.sep));
    trace.record('original', bytes);
  }
  assert.equal(new Set(traces.map(trace => trace.directory)).size, 3);
  for (const event of events(dir)) {
    assert.deepEqual(raw(event), bytes);
    assert.equal(event.bytes, bytes.length);
    assert.equal(event.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
});

test('동시 요청의 비동기 문맥과 원문이 섞이지 않는다', async t => {
  const dir = workspace(t);
  await Promise.all([1, 2, 3].map(requestId => withAiDebug({ directory: dir, context: { docId: 'doc', requestId } }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5 * (4 - requestId)));
    debugRecord('original', `request-${requestId}`);
  })));
  for (const event of events(dir).filter(event => event.kind === 'original')) assert.equal(raw(event).toString(), `request-${event.context.requestId}`);
});

for (const provider of ['anthropic', 'openai', 'gemini']) for (const valid of [false, true]) test(`${provider}: ${valid ? '성공' : '스키마 실패'} 응답 원문과 실제 파서 입력·판정 보존`, async t => {
  const dir = workspace(t), text = JSON.stringify(valid ? empty : { ...empty, proposals: [{ ref: 19, find: '원문', replace: '새 글', reason: '서식 오류 재현' }] });
  const body = JSON.stringify(envelope(provider, text));
  const ai = new AiProposer({ ai: { provider, enabled: true, model: 'test', effort: 'medium' } }, { key: 'test-private-key', fetch: async () => new Response(body) });
  const execute = () => withAiDebug({ directory: dir, context: { docId: 'doc', requestId: 4, attempt: 2 } }, () => ai.run(input));
  if (valid) await execute(); else await assert.rejects(execute(), { code: 'API_RESULT_FORMAT' });
  const all = events(dir), http = all.filter(event => event.kind === 'http.response');
  assert.ok(http.length >= 1); for (const event of http) assert.equal(raw(event).toString(), body);
  assert.equal(raw(all.find(event => event.kind === 'result.parse.input')).toString(), text);
  if (!valid) {
    const failure = all.find(event => event.kind === 'result.validation.error');
    assert.equal(failure.validator, 'RunSchema');
    assert.ok(failure.error.issues.some(issue => issue.path[0] === 'proposals'));
  }
  assert.ok(!all.some(event => raw(event).toString().includes('test-private-key')), '인증 헤더는 기록하지 않는다');
});

for (const status of [200, 429]) test(`HTTP ${status}: JSON 해석 불가/오류 본문도 수신 바이트 그대로 저장`, async t => {
  const dir = workspace(t), text = 'not JSON\r\n원격 오류 원문';
  const ai = new AiProposer({ ai: { provider: 'anthropic', enabled: true, model: 'test' } }, { key: 'fake', fetch: async () => new Response(text, { status }) });
  await assert.rejects(withAiDebug({ directory: dir }, () => ai.run(input)));
  const e = events(dir).find(e => e.kind === 'http.response');
  assert.equal(e.status, status); assert.equal(raw(e).toString(), text);
});

test('JSON 문법·Claude 중첩 JSON·필수 항목 오류를 서로 구별하고 원래 예외를 유지한다', async t => {
  const dir = workspace(t);
  for (const [text, options, validator] of [['{broken', {}, 'JSON.parse'], [JSON.stringify({ ...empty, proposals: '[broken' }), { jsonText: true }, 'inflateJsonText'], ['{}', {}, 'RunSchema']]) {
    await withAiDebug({ directory: dir }, () => assert.throws(() => parseResult(text, options), error => error.code === 'API_RESULT_FORMAT' && error.cause != null));
    assert.equal(events(dir).filter(e => e.kind === 'result.validation.error').at(-1).validator, validator);
  }
});

test('기록 폴더를 쓸 수 없으면 원문 기록 없이 모델을 실행하지 않는다', async t => {
  const dir = workspace(t), invalid = path.join(dir, 'file'); fs.writeFileSync(invalid, 'file');
  let called = false;
  await assert.rejects(withAiDebug({ directory: invalid }, () => { called = true; }), { code: 'AI_DEBUG_WRITE_FAILED' });
  assert.equal(called, false);
});

test('스트림 기록 도중 I/O가 실패하면 구체적인 진단 저장 실패 코드로 중단한다', async t => {
  const dir = workspace(t);
  await withAiDebug({ directory: dir }, () => {
    const stream = debugStream('test.stream'), write = fs.writeFileSync;
    try {
      fs.writeFileSync = (fd, data, ...rest) => {
        if (Buffer.isBuffer(data) && data.toString() === 'fail-this-write') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return write(fd, data, ...rest);
      };
      assert.throws(() => stream.write(Buffer.from('fail-this-write')), error => error.code === 'AI_DEBUG_WRITE_FAILED' && error.cause.code === 'ENOSPC');
    } finally { fs.writeFileSync = write; stream.close(); }
  });
});

test('CLI 실패의 stdout/stderr 바이트는 임시 작업 폴더와 독립적으로 남는다', async t => {
  const dir = workspace(t);
  await withAiDebug({ directory: dir, context: { route: 'codex-cli' } }, async () => {
    const r = await runProcess({ file: process.execPath, args: [] }, ['-e', 'process.stdout.write(Buffer.from([0,255,10]));process.stderr.write("original stderr");process.exitCode=7;'], { cwd: dir, timeoutMs: 5000 });
    assert.equal(r.code, 7);
  });
  const all = events(dir).filter(e => e.kind === 'stream.end').map(e => ({ e, value: payload(e) }));
  const out = all.find(x => x.value.kind === 'cli.stdout'), err = all.find(x => x.value.kind === 'cli.stderr');
  assert.deepEqual(fs.readFileSync(path.join(out.e.folder, out.value.file)), Buffer.from([0, 255, 10]));
  assert.equal(fs.readFileSync(path.join(err.e.folder, err.value.file), 'utf8'), 'original stderr');
});

test('CLI 메모리 한도에서 거절한 청크도 파일 원문에서 빠지지 않는다', async t => {
  const dir = workspace(t);
  await assert.rejects(withAiDebug({ directory: dir }, () => runProcess({ file: process.execPath, args: [] }, ['-e', 'process.stdout.write("x".repeat(4096));'], { cwd: dir, outputLimit: 10, timeoutMs: 5000 })), { code: 'CODEX_OUTPUT_LIMIT' });
  const e = events(dir).find(e => e.kind === 'stream.end' && payload(e).kind === 'cli.stdout'), v = payload(e);
  assert.equal(fs.readFileSync(path.join(e.folder, v.file), 'utf8'), 'x'.repeat(4096));
});

test('CLI 취소 때도 중단 전 stdout 원문과 ABORTED 판정을 보존한다', async t => {
  const dir = workspace(t), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600);
  try {
    await assert.rejects(withAiDebug({ directory: dir }, () => runProcess({ file: process.execPath, args: [] }, ['-e', 'process.stdout.write("before-cancel");setInterval(()=>{},1000);'], { cwd: dir, signal: controller.signal, timeoutMs: 5000 })), { code: 'ABORTED' });
  } finally { clearTimeout(timer); }
  const e = events(dir).find(e => e.kind === 'stream.end' && payload(e).kind === 'cli.stdout'), v = payload(e);
  assert.equal(fs.readFileSync(path.join(e.folder, v.file), 'utf8'), 'before-cancel');
  assert.equal(v.failure.code, 'ABORTED');
});

for (const name of ['codex', 'claude']) test(`${name}: 실제 Proposer의 가짜 CLI 실패 원문은 작업 폴더 삭제 뒤에도 남는다`, async t => {
  const dir = workspace(t), work = path.join(dir, 'work'); fs.mkdirSync(work);
  const launch = await (name === 'codex' ? fakeCodex : fakeClaude)(dir, { mode: 'fail' });
  const ai = new (name === 'codex' ? CodexProposer : ClaudeCodeProposer)({ model: 'test' }, { tempRoot: work, resolveCommand: async () => launch });
  await assert.rejects(withAiDebug({ directory: path.join(dir, 'debug'), context: { docId: 'test-document', requestId: 7, attempt: 2 } }, () => ai.runMcp(
    { type: 'request', docId: 'test-document', requestId: 7, attempt: 2 }, { url: 'http://localhost:8787/mcp', token: 'fake-token', session: 'test-session' })), { code: 'CODEX_FAILED' });
  assert.deepEqual(fs.readdirSync(work), []);
  const streams = events(path.join(dir, 'debug')).filter(e => e.kind === 'stream.end').map(e => fs.readFileSync(path.join(e.folder, payload(e).file), 'utf8'));
  assert.ok(streams.some(text => text.includes('private provider secret-token')));
});

test('HTTP 응답 수신 도중 끊기면 받은 부분과 incomplete 상태를 보존한다', async t => {
  const dir = workspace(t), prefix = Buffer.from('partial-wire');
  const ai = new AiProposer({ ai: { provider: 'anthropic', enabled: true, model: 'test' } }, { key: 'fake', fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(prefix); setTimeout(() => controller.error(new Error('connection reset')), 30); },
  })) });
  await assert.rejects(withAiDebug({ directory: dir }, () => ai.run(input)));
  const e = events(dir).find(e => e.kind === 'http.response');
  assert.equal(e.complete, false); assert.deepEqual(raw(e), prefix);
});

test('채널/MCP의 SDK 인자 검사 이전 원문과 거절 응답을 한 실행으로 연결한다', async t => {
  const dir = workspace(t), config = { dataDir: dir, ai: {}, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(dir, 'docs')), service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const doc = store.create({ fileName: 'fixture.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: 'tester' });
  const client = new Client({ name: 'claude-code', version: 'test' });
  const server = createMcpServer({ service, user: { name: 'tester', role: 'admin' }, agentName: 'Claude Code', session: 'channel-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const args = { doc_id: doc.id, request_id: 'not-a-number', proposals: [{ ref: 's0/p1', find: '문단', replace: '변경' }] };
  try { const result = await client.callTool({ name: 'propose_changes', arguments: args }); assert.equal(result.isError, true); }
  finally { await client.close(); await server.close(); }
  const received = events(path.join(dir, 'runtime/ai-debug')).find(e => e.kind === 'mcp.in' && e.context.tool === 'propose_changes');
  assert.deepEqual(payload(received).params.arguments, args);
  const rejected = events(path.join(dir, 'runtime/ai-debug')).find(e => e.kind === 'mcp.out' && e.runId === received.runId);
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.state.version, doc.version);
});

test('사용자 실패와 같은 서버 개인 Claude 키 경로: 도구 저장 후 최종 실패 원문·부분 결과·엔진 상태 보존', async t => {
  // 예전 연결(v1) 시험 — 서버 AI 기본이 새 연결(v2)이 된 뒤(2026-11-17) config.ai.mcp 로 예전 연결을 고른다
  const dir = workspace(t), user = { name: 'tester', role: 'admin' }, config = { dataDir: dir, configFile: path.join(dir, 'config.json'), ai: { mcp: 'v1' }, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(dir, 'docs')), service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const doc = store.create({ fileName: 'fixture.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name });
  let round = 0;
  const invalid = JSON.stringify({ summary: '저장 완료', proposals: [] });
  service.personalAi = createPersonalAi({ config, fetchImpl: async () => ++round === 1 ? response({ model: 'test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_changes', input: { proposals: [{ ref: 's0/p1', find: '둘째 문단입니다.', replace: '두 번째 문단입니다.', reason: '표현' }] } }], usage: {} }) : response(envelope('anthropic', invalid)) });
  service.personalAi.save(user, { provider: 'anthropic', model: 'test', key: 'fake-key' });
  let request;
  await assert.rejects(service.createRequest(doc.id, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '표현 수정' }, user), error => {
    request = error.extra?.request; return error.code === 'AI_FAILED' && request.status === 'failed';
  });
  assert.equal(round, 2);
  assert.equal((await service.listProposals(doc.id)).length, 1);
  const all = events(path.join(dir, 'runtime/ai-debug')), failure = all.find(e => e.kind === 'result.validation.error');
  assert.equal(raw(failure).toString(), invalid);
  assert.equal(failure.context.requestId, request.rid);
  assert.equal(failure.state.request.status, 'working');
  assert.ok(failure.error.issues.some(issue => issue.path[0] === 'alternatives'));
  assert.ok(all.some(e => e.kind === 'service.request.failed' && e.state.request.status === 'failed'));
});

test('HTTP MCP: JSON 해석 자체가 실패해도 공백·줄바꿈 포함 원문을 남긴다', async () => {
  const srv = await startServer();
  try {
    const text = '  {"jsonrpc": "2.0",\r\n broken';
    const r = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${srv.tokens.a}`, 'Content-Type': 'application/json' }, body: text });
    assert.equal(r.status, 400);
    const e = events(path.join(srv.dataDir, 'runtime/ai-debug')).find(e => e.kind === 'http.mcp.rejected');
    assert.equal(raw(e).toString(), text); assert.equal(e.error.type, 'entity.parse.failed');
  } finally { await srv.stop(); }
});

test('HTTP MCP: SDK의 내부 콜백 전달을 유지하고 initialize·도구 응답을 기록한다', async () => {
  const srv = await startServer(), client = new Client({ name: 'chatgpt', version: 'debug-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
  try {
    await client.connect(transport, { timeout: 3000 });
    const result = await client.callTool({ name: 'list_documents', arguments: {} }, undefined, { timeout: 3000 });
    assert.equal(result.isError, undefined);
    const all = events(path.join(srv.dataDir, 'runtime/ai-debug'));
    assert.ok(all.some(e => e.kind === 'mcp.in' && e.context.tool === 'list_documents'));
    assert.ok(all.some(e => e.kind === 'http.mcp.body' && e.context.tool === 'list_documents'));
    assert.ok(all.some(e => e.kind === 'mcp.out' && e.context.tool === 'list_documents'));
  } finally { await transport.terminateSession().catch(() => {}); await client.close(); await srv.stop(); }
});

test('Claude 채널 Stop hook: 마지막 답변과 transcript의 원문을 별도로 보존한다', t => {
  const dir = workspace(t), transcript = path.join(dir, 'source.jsonl'), original = Buffer.from('{"type":"assistant","message":"원문"}\r\n');
  fs.writeFileSync(transcript, original);
  const bytes = Buffer.from(JSON.stringify({ session_id: 'claude-session', hook_event_name: 'Stop', transcript_path: transcript, last_assistant_message: '마지막 답변 원문' }));
  captureClaudeHook(bytes, { directory: path.join(dir, 'debug') });
  const all = events(path.join(dir, 'debug'));
  assert.deepEqual(raw(all.find(e => e.kind === 'claude.hook.input')), bytes);
  assert.deepEqual(raw(all.find(e => e.kind === 'claude.transcript')), original);
  assert.equal(raw(all.find(e => e.kind === 'claude.last_assistant_message')).toString(), '마지막 답변 원문');
});

test('Claude hook 입력 JSON 자체가 손상돼도 해석 전 원문과 원래 오류를 보존한다', t => {
  const dir = workspace(t), bytes = Buffer.from(' { broken hook\r\n');
  assert.throws(() => captureClaudeHook(bytes, { directory: dir }), SyntaxError);
  const all = events(dir);
  assert.deepEqual(raw(all.find(e => e.kind === 'claude.hook.input')), bytes);
  assert.ok(all.some(e => e.kind === 'claude.hook.parse.error' && e.validator === 'JSON.parse'));
});

test('기존 외부 채널 작업공간에 사용자 설정을 보존해 hook을 병합하고 실제 실행한다', t => {
  const dir = workspace(t), settingsFile = path.join(dir, '.claude/settings.json'); fs.mkdirSync(path.dirname(settingsFile));
  const settings = { permissions: { allow: ['Read(/work/**)'] }, custom: 'preserve', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-original-command' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const setup = fileURLToPath(new URL('../scripts/setup-agent.mjs', import.meta.url));
  const args = [setup, '--dir', dir, '--url', 'http://localhost:1/mcp', '--no-server', '--no-claude', '--no-registry'].map(String);
  execFileSync(process.execPath, args, { cwd: dir });
  const merged = JSON.parse(fs.readFileSync(settingsFile)), hook = path.join(dir, '.claude/ai-debug-hook.mjs');
  assert.deepEqual(merged.permissions, settings.permissions); assert.equal(merged.custom, 'preserve');
  assert.deepEqual(merged.hooks.Stop[0], settings.hooks.Stop[0]); assert.equal(merged.hooks.Stop.length, 2);
  execFileSync(process.execPath, args, { cwd: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)).hooks, merged.hooks, '두 번 준비해도 hook 중복 없음');
  const bytes = Buffer.from(JSON.stringify({ session_id: 'outside', hook_event_name: 'Stop', last_assistant_message: '끝' }));
  execFileSync(process.execPath, [hook], { cwd: dir, input: bytes, env: { ...process.env, HWPX_COWORK_DEBUG_DIR: path.join(dir, 'debug') } });
  assert.deepEqual(raw(events(path.join(dir, 'debug')).find(e => e.kind === 'claude.hook.input')), bytes);
});

test('관리자 MCP 실험 경로도 원시 HTTP·SDK 입력·Ajv 거절 근거를 기록한다', async () => {
  const srv = await startServer(), client = new Client({ name: 'codex', version: 'debug-test' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp/admin-test`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.admin}` } } });
  try {
    await client.connect(transport, { timeout: 3000 });
    const result = await client.callTool({ name: 'enable_tools', arguments: { groups: ['invalid-group'] } }, undefined, { timeout: 3000 });
    assert.equal(result.isError, true);
    const all = events(path.join(srv.dataDir, 'runtime/ai-debug'));
    assert.ok(all.some(e => e.kind === 'http.mcp.body' && e.context.route === 'admin-mcp-http' && e.context.tool === 'enable_tools'));
    assert.ok(all.some(e => e.kind === 'mcp.in' && e.context.route === 'admin-mcp' && e.context.tool === 'enable_tools'));
    assert.ok(all.some(e => e.kind === 'lab.tool.schema.error' && e.validator === 'AjvJsonSchemaValidator'));
  } finally { await transport.terminateSession().catch(() => {}); await client.close(); await srv.stop(); }
});

test('stdio wire: 잘못된 JSON도 SDK 해석 전 수신 바이트로 보존한다', async t => {
  const dir = workspace(t), stdin = new PassThrough(), stdout = new PassThrough();
  const transport = createDebugStdioTransport(StdioServerTransport, { directory: dir, stdin, stdout });
  transport.onmessage = () => {}; transport.onerror = () => {};
  await transport.start(); stdin.write('  broken json\r\n');
  await new Promise(resolve => setTimeout(resolve, 10)); await transport.close();
  const e = events(dir).find(e => e.kind === 'stream.end'), value = payload(e);
  assert.equal(fs.readFileSync(path.join(e.folder, value.file), 'utf8'), '  broken json\r\n');
});
