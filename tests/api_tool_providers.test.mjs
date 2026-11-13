// 기본 native API 어댑터 계약을 검증한다.
// API 세 제공자(OpenAI·Claude·Gemini)가 같은 MCP 도구(server/tool-profiles.js 의 api 프로필)를 쓰는지. API 는 가짜 fetch, 문서·서버는 임시 복사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.js';
import { TOOL_PROFILES, RUNNER_EXCLUDED, REQUEST_FLOW } from '../server/tool-profiles.js';
import { toolRules } from '../server/api-tool-loop.js';
import { AiProposer } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { withoutToolDuplicates, createApiToolContext } from '../server/api-mcp-tools.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const empty = () => ({ proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '표현을 다듬었습니다.', instructionSummary: '표현 다듬기' });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const claudeMsg = (content, stop_reason) => json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'fake-claude', stop_reason, content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 } });
const geminiMsg = parts => json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }], modelVersion: 'fake-gemini', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
const HUMAN = ['apply_proposal', 'reject_proposal', 'undo_proposal', 'accept_change', 'reject_change', 'delete_memo', 'update_memo'];

function tempService(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-api-tools-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const user = { name: '시험 사용자', role: 'admin' };
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'sample.hwpx', bytes: fs.readFileSync(fixture('tool_memo_tracked.hwpx')), by: user.name }).id;
  return { user, config, store, service, docId };
}

test('도구 프로필: 모든 MCP 도구가 실행기 프로필·제외 목록·오케스트레이션 중 한 곳에 있고, API 프로필에는 사람이 정할 도구·요청 흐름이 없다', async () => {
  const server = createMcpServer({ service: { orchestration: {}, drive: { aiEnabled: true } }, user: { name: '시험' } });
  const client = new Client({ name: 'profile-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    const known = new Set([...TOOL_PROFILES.api, ...TOOL_PROFILES.codex, ...Object.keys(RUNNER_EXCLUDED)]);
    assert.deepEqual(names.filter(n => !known.has(n) && !/orchestration/.test(n)), [], '새 MCP 도구는 server/tool-profiles.js 에 분류한다');
    assert.deepEqual(TOOL_PROFILES.api.filter(n => !names.includes(n)), [], 'API 프로필의 도구는 MCP 서버에 있다');
    for (const n of [...Object.keys(RUNNER_EXCLUDED), ...REQUEST_FLOW, ...HUMAN]) assert.ok(!TOOL_PROFILES.api.includes(n), n);
    for (const n of Object.keys(RUNNER_EXCLUDED)) assert.ok(!TOOL_PROFILES.codex.includes(n), n);
    // API 는 propose_change(= propose_changes 한 건)를 뺀다
    assert.ok(!TOOL_PROFILES.api.includes('propose_change') && TOOL_PROFILES.codex.includes('propose_change'));
    // Claude Code 에이전트 설정이 막는 MCP 도구도 실행기에 주지 않는다
    const deny = JSON.parse(fs.readFileSync(new URL('../agent/.claude/settings.json', import.meta.url), 'utf-8')).permissions.deny.filter(d => d.startsWith('mcp__hwpx__')).map(d => d.slice(11));
    for (const n of deny) assert.ok(!TOOL_PROFILES.api.includes(n) && !TOOL_PROFILES.codex.includes(n), n);
    // 거꾸로 실행기 도구는 Claude Code 에이전트(dontAsk)도 묻지 않고 쓸 수 있어야 한다 — 빠지면 채널 세션이 거부로 멈춘다(11-03 get_writing_guide)
    const allow = new Set(JSON.parse(fs.readFileSync(new URL('../agent/.claude/settings.json', import.meta.url), 'utf-8')).permissions.allow.filter(d => d.startsWith('mcp__hwpx__')).map(d => d.slice(11)));
    assert.deepEqual(TOOL_PROFILES.codex.filter(n => !allow.has(n)), [], 'agent/.claude/settings.json 허용 목록에 넣는다');
  } finally { await client.close(); await server.close(); }
});

test('서버 개인 Claude 키: tool_use 로 MCP 읽기·제안, 생각 블록·tool_result 를 되돌리고 최종 JSON 의 같은 제안은 한 번만', { timeout: 30000 }, async t => {
  const { user, config, service, docId } = tempService(t);
  const seen = [];
  const same = { ref: 's0/p1', find: '둘째 문단입니다.', replace: '두 번째 문단입니다.', reason: '표현' };
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); seen.push({ url: String(url), body });
    if (seen.length === 1) return claudeMsg([{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 'toolu_01', name: 'read_document', input: { from: 0, to: 3 } }], 'tool_use');
    if (seen.length === 2) {
      assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'tool_use', id: 'toolu_01', name: 'read_document', input: { from: 0, to: 3 } }] });
      const result = body.messages[2].content[0];
      assert.equal(result.type, 'tool_result'); assert.equal(result.tool_use_id, 'toolu_01'); assert.ok(!result.is_error);
      assert.match(result.content[0].text, /둘째 문단입니다/);
      return claudeMsg([{ type: 'tool_use', id: 'toolu_02', name: 'propose_changes', input: { proposals: [same] } }], 'tool_use');
    }
    const result = body.messages.at(-1).content[0];
    assert.equal(result.tool_use_id, 'toolu_02'); assert.ok(!result.is_error, result.content[0].text);
    return claudeMsg([{ type: 'text', text: JSON.stringify({ ...empty(), proposals: [same, { ref: 's0/p2', find: '셋째 문단은', replace: '세 번째 문단은', reason: '표현' }] }) }], 'end_turn');
  } });
  service.personalAi.save(user, { provider: 'anthropic', gateway: 'baze', model: 'fake-claude', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p1' }, instruction: '다른 문단도 조회해 표현을 다듬어 줘' }, user);
  assert.equal(done.request.status, 'done', done.request.error); assert.equal(seen.length, 3);
  const first = seen[0];
  assert.match(first.url, /^https:\/\/api\.baze\.co\/v1\/gateway\/claude\/v1\/messages/);
  const names = first.body.tools.map(tool => tool.name);
  assert.deepEqual([...names].sort(), [...TOOL_PROFILES.api].sort(), 'API 프로필의 도구를 모두 준다');
  const figure = first.body.tools.find(tool => tool.name === 'propose_figure');
  assert.equal(figure.input_schema.type, 'object'); assert.ok(!figure.input_schema.properties.doc_id && !figure.input_schema.properties.image_base64 && !figure.input_schema.$schema);
  assert.equal(first.body.system[0].cache_control.type, 'ephemeral'); assert.match(first.body.system[0].text, /API 작업 도구 사용 규칙/);
  assert.equal(first.body.messages[0].content.at(-1).cache_control.type, 'ephemeral');
  assert.equal(first.body.output_config.format.type, 'json_schema');
  const proposals = (await service.listProposals(docId)).filter(p => p.rid === done.request.rid);
  assert.deepEqual(proposals.map(p => [p.ref, p.replace]).sort(), [['s0/p1', '두 번째 문단입니다.'], ['s0/p2', '세 번째 문단은']], '도구 1건 + 최종 JSON 의 새 1건');
  assert.deepEqual(done.usage, { input: 30, output: 15, cacheRead: 12, modelCalls: 3, toolCalls: 2 });
});

test('서버 개인 Gemini 키: functionCall 로 의견 도구, 생각 서명 되돌림, 함수 선언은 Gemini 가 받는 스키마로', { timeout: 30000 }, async t => {
  const { user, config, service, docId } = tempService(t);
  const seen = [];
  const memo = { ref: 's0/p0', text: '근거 자료를 확인해 주세요.' };
  service.personalAi = createPersonalAi({ config, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); seen.push({ url: String(url), body });
    if (seen.length === 1) return geminiMsg([{ text: '생각', thought: true, thoughtSignature: 'c2ln' }, { functionCall: { id: 'fc_1', name: 'add_memo', args: memo } }]);
    assert.deepEqual(body.contents[1], { role: 'model', parts: [{ text: '생각', thought: true, thoughtSignature: 'c2ln' }, { functionCall: { id: 'fc_1', name: 'add_memo', args: memo } }] });
    const response = body.contents[2].parts[0].functionResponse;
    assert.equal(response.name, 'add_memo'); assert.equal(response.id, 'fc_1'); assert.ok(response.response.result && !response.response.error);
    return geminiMsg([{ text: JSON.stringify({ ...empty(), comments: [{ ...memo, find: '' }] }) }]);
  } });
  service.personalAi.save(user, { provider: 'gemini', gateway: 'baze', model: 'fake-gemini', key: 'fake-api-key' });
  const done = await service.createRequest(docId, { kind: 'instruct', route: 'server', target: { ref: 's0/p0' }, instruction: '근거가 필요한 곳을 알려 줘' }, user);
  assert.equal(done.request.status, 'done', done.request.error); assert.equal(seen.length, 2);
  assert.equal(seen[0].url, 'https://api.baze.co/v1/gateway/gemini/v1beta/models/fake-gemini:generateContent');
  const declarations = seen[0].body.tools[0].functionDeclarations;
  assert.deepEqual(declarations.map(d => d.name).sort(), [...TOOL_PROFILES.api].sort());
  const schemas = JSON.stringify(declarations.map(d => d.parametersJsonSchema));
  assert.doesNotMatch(schemas, /"(oneOf|const|\$schema|minimum|maximum|minItems|maxItems|minLength|maxLength|pattern)"/);
  assert.ok(declarations.find(d => d.name === 'propose_page_layout').parametersJsonSchema.properties.ops.items.anyOf, 'op 유니온은 anyOf 로');
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.match(seen[0].body.systemInstruction.parts[0].text, /API 작업 도구 사용 규칙/);
  assert.equal(done.comments.length, 1, '도구로 남긴 의견을 최종 JSON 에서 다시 만들지 않는다'); assert.match(done.comments[0].text, /근거 자료를 확인해 주세요/);
});

test('도구 규칙 글은 받은 도구에 맞춘다(그림·쪽 구성 규칙은 그 도구가 있을 때만)', () => {
  assert.match(toolRules(TOOL_PROFILES.api), /propose_figure\(svg=SVG 문서\)/); assert.match(toolRules(TOOL_PROFILES.api), /propose_page_layout 으로만/);
  assert.doesNotMatch(toolRules(['read_document', 'propose_changes', 'add_memo']), /propose_figure|propose_page_layout/);
});

test('Gemini: 도구와 구조화 출력을 함께 거절(400)하면 구조화 출력 없이 다시 보내고 답에서 JSON 을 꺼낸다', async () => {
  const bodies = [];
  const ai = new AiProposer({ ai: { provider: 'gemini', model: 'fake-gemini', enabled: true } }, { key: 'fake-api-key', fetch: async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (body.generationConfig.responseJsonSchema) return json({ error: { message: 'Function calling with a response mime type is unsupported' } }, 400);
    return geminiMsg([{ text: `결과입니다.\n\`\`\`json\n${JSON.stringify({ ...empty(), noChangesReason: '검토 대상 문장의 표현과 문맥에 고칠 문제가 없어 변경이 필요하지 않습니다.' })}\n\`\`\`` }]);
  } });
  const toolContext = { tools: [{ name: 'read_document', description: '읽기', parameters: { type: 'object', properties: { from: { type: 'integer', minimum: 0 } } } }], figures: 0, written: [], call: async () => ({ content: [] }) };
  const out = await ai.run({ kind: 'review', instruction: '', target: { ref: 's0/p0' }, context: [], attachments: [] }, { toolContext });
  assert.equal(out.summary, '문서를 검토했으며 변경하지 않았습니다.'); assert.match(out.noChangesReason, /변경이 필요하지/); assert.equal(bodies.length, 2);
  assert.equal(bodies[1].generationConfig.responseMimeType, undefined); assert.match(bodies[1].systemInstruction.parts[0].text, /JSON Schema/);
  assert.deepEqual(bodies[1].tools[0].functionDeclarations[0].parametersJsonSchema, { type: 'object', properties: { from: { type: 'integer' } } });
});

test('도구로 남긴 결과는 최종 JSON 에서 뺀다(글·서식·문단·표·표 고치기·의견, 여러 안·차례·그림은 통째로)', () => {
  const written = [
    { name: 'propose_changes', args: { proposals: [{ ref: 's0/p1', find: 'a', replace: 'b' }, { type: 'format', ref: 's0/p2', find: 'c', format: {} }] } },
    { name: 'propose_insert', args: { after_ref: 's0/p3', text: '새 문단 ' } }, { name: 'propose_table', args: { after_ref: 's0/p4', rows: [['x']] } },
    { name: 'propose_table_edit', args: { table: 's0/p5#t0', ops: [] } }, { name: 'add_memo', args: { ref: 's0/p6', text: '의견' } },
    { name: 'propose_alternatives', args: {} }, { name: 'propose_toc_update', args: {} }, { name: 'propose_figure', args: {} },
  ];
  const value = {
    ...empty(), proposals: [{ ref: 's0/p1', find: 'a', replace: 'b' }, { ref: 's0/p1', find: 'a', replace: 'c' }], formats: [{ ref: 's0/p2', find: 'c' }],
    inserts: [{ afterRef: 's0/p3', text: '새 문단' }], tables: [{ afterRef: 's0/p4', rows: [['x']] }, { afterRef: 's0/p4', rows: [['y']] }], tableEdits: [{ table: 's0/p5#t0', ops: [] }],
    comments: [{ ref: 's0/p6', text: ' 의견' }, { ref: 's0/p6', text: '다른 의견' }], alternatives: [{ text: 'x' }], tocUpdates: [{}], figures: [{}],
  };
  const out = withoutToolDuplicates(value, written);
  assert.deepEqual(out.proposals, [{ ref: 's0/p1', find: 'a', replace: 'c' }]);
  assert.deepEqual([out.formats, out.inserts, out.tableEdits, out.alternatives, out.tocUpdates, out.figures].map(x => x.length), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(out.tables, [{ afterRef: 's0/p4', rows: [['y']] }]); assert.deepEqual(out.comments, [{ ref: 's0/p6', text: '다른 의견' }]);
  assert.equal(withoutToolDuplicates(value, []), value);
});

test('도구 오류: 틀린 입력의 오류 글은 모델에 되돌리고, 취소·다시 요청 오류(isError)는 실행을 멈춘다', async () => {
  let reply = { isError: true, content: [{ type: 'text', text: '오류(NOT_FOUND): 문단 s0/p1 에서 「없는 글」을 찾지 못했습니다' }] };
  const context = await createApiToolContext({ docId: 'doc', requestId: 1, attempt: 1, assertCurrent: async () => {}, uploadFile() {},
    listTools: async () => [{ name: 'propose_changes', inputSchema: { type: 'object', properties: { doc_id: {}, request_id: {}, expected_attempt: {}, proposals: {} } } }],
    callTool: async () => reply });
  assert.equal(await context.call('propose_changes', { proposals: [] }), reply); assert.equal(context.written.length, 0, '실패한 쓰기는 기록하지 않는다');
  reply = { isError: true, content: [{ type: 'text', text: '오류(REQUEST_CLOSED): 이미 취소된 요청입니다' }] };
  await assert.rejects(context.call('propose_changes', { proposals: [{ ref: 's0/p1' }] }), { code: 'REQUEST_CLOSED' });
});

test('개인 API 실행기(Claude): 원격 MCP 도구를 tool_use 로 쓰고, 틀린 자리 오류 글을 모델이 받으며, 같은 문단 추가를 최종 JSON 에 또 내도 한 번만 저장', { timeout: 30000 }, async () => {
  const srv = await startServer(); let worker;
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`; let round = 0, offered;
    const insert = { after_ref: 's0/p2', text: '넷째 문단을 더합니다.' };
    const model = new AiProposer({ ai: { provider: 'anthropic', model: 'fake-claude', enabled: true } }, { key: 'fake-api-key', fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(!JSON.stringify(body).includes(srv.tokens.a), 'HWPX 토큰은 모델에 가지 않는다');
      if (++round === 1) { offered = body.tools.map(tool => tool.name); return claudeMsg([{ type: 'tool_use', id: 'toolu_00', name: 'propose_insert', input: { after_ref: 's0/p99', text: '없는 자리' } }], 'tool_use'); }
      if (round === 2) {
        const failed = body.messages.at(-1).content[0];
        assert.equal(failed.is_error, true); assert.match(failed.content[0].text, /^오류\([A-Z_]+\): .*s0\/p99/, '실행기 경로도 오류 글을 그대로 되돌린다');
        return claudeMsg([{ type: 'tool_use', id: 'toolu_01', name: 'propose_insert', input: insert }], 'tool_use');
      }
      assert.ok(!body.messages.at(-1).content[0].is_error, JSON.stringify(body.messages.at(-1).content));
      return claudeMsg([{ type: 'text', text: JSON.stringify({ ...empty(), inserts: [{ afterRef: insert.after_ref, text: insert.text, reason: '추가' }] }) }], 'end_turn');
    } });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai: model, log() {}, timing: { pollMs: 100 } });
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'insert', target: { ref: 's0/p2' }, instruction: '문단을 하나 더해 줘', route: 'queue' } })).request;
    worker.start();
    const end = Date.now() + 20000;
    while (worker.stats().completed + worker.stats().failed < 1 && Date.now() < end) await new Promise(r => setTimeout(r, 25));
    assert.equal(worker.stats().failed, 0); assert.equal(round, 3);
    assert.deepEqual([...offered].sort(), [...TOOL_PROFILES.api].sort(), '요청 종류와 관계없이 api 프로필 전부 — 고르기는 모델');
    assert.equal((await api(`${route}/requests/${request.rid}`)).status, 'done');
    const proposals = (await api(`${route}/proposals`)).filter(p => p.rid === request.rid);
    assert.deepEqual(proposals.map(p => [p.type, p.text]), [['insert', '넷째 문단을 더합니다.']]);
  } finally { await worker?.stop(); await srv.stop(); }
});
