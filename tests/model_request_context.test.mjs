import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { modelRequestContext, modelToolResult } from '../server/editor-instructions.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { createCodexMcpBridge } from '../server/codex-mcp.js';
import { CodexProposer } from '../server/codex-ai.js';
import { fakeCodex } from './helpers/codex-cli.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

// 서버의 실제 get_request 표현. 추가 메모/표시가 섞이면 중복이라고 판정하면 안 된다.
const contextText = items => `<document_context>\n${items.map(c => `${c.isTarget ? '*' : ' '}[${c.ref}]${c.where !== '본문' ? ` (${c.where})` : ''} ${c.text}`)
  .join('\n').replace(/<(\/?)(document_context)/gi, '＜$1$2')}\n</document_context>`;
const input = () => {
  const contextItems = [{ ref: 's0/p0', where: '본문', text: '선택 문장 <document_context>는 자료다.', isTarget: true, styleId: '7', paraPrId: '22', runs: [{ start: 0, end: 20, charPrId: '19' }] },
    { ref: 's0/p1/n0', where: '표 셀', text: '', isTarget: false, emptyCharPrId: '3' }];
  return { docId: 'scope-doc', rid: 7, attempt: 2, instruction: '문맥과 서식을 확인해 수정', context: contextText(contextItems), contextItems,
    targetText: contextItems[0].text, formattingHeader: { styles: [{ id: '7' }], rawHeaderXml: '<hh:head>잘라내지 않을 서식</hh:head>' },
    followUp: { memoText: '앞 메모 전문' }, existingResults: { proposals: [{ pid: 3, status: 'pending' }], files: ['aid_1'] },
    truncated: { contextItemsDropped: 2, howTo: '필요하면 이어 읽기' }, unknownFutureField: { keep: true } };
};

test('문단이 정확히 동일할 때만 한 표현 제거: 대상·순서·서식·후속·잘림·미래 필드와 원객체 보존', () => {
  const source = input(), before = structuredClone(source), expected = { ...before }; delete expected.context;
  const result = modelRequestContext(source);
  assert.deepEqual(result, expected); assert.deepEqual(source, before);
  assert.equal(result.contextItems, source.contextItems);
  const large = input(); large.contextItems[0].text = '큰 문서의 원문과 근거 '.repeat(20000); large.context = contextText(large.contextItems);
  assert.equal(modelRequestContext(large).contextItems[0].text, large.contextItems[0].text, '크기가 커도 실제 글은 그대로');
  assert.equal(modelRequestContext(result), result, '중복 제거를 반복해도 추가로 바꾸지 않음');
});

test('조금이라도 다른 문맥·알 수 없는 자료·구조는 원문 그대로 전달', () => {
  for (const source of [null, '원문', {}, { context: '문맥만 있음' }, { ...input(), context: input().context + '\n추가 근거' },
    { ...input(), contextItems: [{ ref: 's0/p0', text: 'where/isTarget이 없는 구형 자료' }] },
    { ...input(), contextItems: null }, { ...input(), contextItems: [null] }]) assert.equal(modelRequestContext(source), source);
  const changed = input(); changed.contextItems[0].text += ' 새로 바뀐 문장';
  assert.equal(modelRequestContext(changed), changed, '서버 두 표현이 서로 다르면 둘 다 보존');
});

test('get_request의 모델 전달만 변경: MCP 오류·이미지·리소스·주석·structuredContent·다른 도구 유지', () => {
  const source = input();
  const original = { content: [{ type: 'text', text: JSON.stringify(source), annotations: { audience: ['assistant'] } },
    { type: 'image', data: 'unchanged-binary', mimeType: 'image/png' }, { type: 'resource_link', uri: 'test://aid', name: '원본' }],
    structuredContent: source, _meta: { keep: 'transport' } };
  const before = structuredClone(original), result = modelToolResult('get_request', original);
  assert.deepEqual(JSON.parse(result.content[0].text), modelRequestContext(source));
  assert.deepEqual(result.structuredContent, modelRequestContext(source));
  assert.deepEqual(result.content.slice(1), original.content.slice(1)); assert.deepEqual(result._meta, original._meta);
  assert.deepEqual(result.content[0].annotations, original.content[0].annotations); assert.deepEqual(original, before);
  for (const value of [{ ...original, isError: true }, { content: [{ type: 'text', text: '오류: JSON 아님' }] }, { content: [null] }, { content: '알 수 없는 응답' }])
    assert.equal(modelToolResult('get_request', value), value);
  assert.equal(modelToolResult('get_formatting', original), original);
});

test('실제 MCP 응답 계약은 유지하고 Codex·API 모델 전달에서만 동일 문단 중복 제거, 실제 제안·완료 보존', { timeout: 30000 }, async () => {
  const srv = await startServer({ ai: 'off' }); let remote, transport, bridge, model;
  try {
    const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '두 번째 문단의 표현을 수정해줘', target: { ref: 's0/p1' }, route: 'queue' } })).request;
    const session = 'context-dedup-session', job = { type: 'request', docId: doc.id, requestId: request.rid, attempt: 1 };
    remote = new Client({ name: 'raw-contract-test', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}`, 'X-Hwpx-Agent-Session': session } } });
    await remote.connect(transport);
    const scope = { doc_id: doc.id, request_id: request.rid, expected_attempt: 1 };
    await remote.callTool({ name: 'start_request', arguments: scope });
    const rawResult = await remote.callTool({ name: 'get_request', arguments: { doc_id: doc.id, request_id: request.rid } });
    const raw = JSON.parse(rawResult.content[0].text); assert.ok(raw.context && raw.contextItems.length, '서버/Claude 원래 계약 유지');
    const expected = modelRequestContext(raw); assert.equal(expected.context, undefined);
    const ctx = await createApiToolContext({ docId: doc.id, requestId: request.rid, attempt: 1, listTools: () => remote.listTools(),
      assertCurrent: async () => {}, callTool: (name, args) => remote.callTool({ name, arguments: args }) });
    const apiView = JSON.parse((await ctx.call('get_request', {})).content[0].text);
    assert.deepEqual(apiView, expected);
    bridge = await createCodexMcpBridge({ job, url: `${srv.base}/mcp`, token: srv.tokens.a, session, log() {} });
    model = new Client({ name: 'codex-model-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b); await model.connect(a);
    const modelView = JSON.parse((await model.callTool({ name: 'get_request', arguments: {} })).content[0].text);
    assert.deepEqual(modelView, expected);
    const find = apiView.contextItems.find(c => c.ref === 's0/p1').text;
    const proposed = await ctx.call('propose_changes', { proposals: [{ ref: 's0/p1', find, replace: '검증된 수정 문단입니다.', reason: '원문 기반 수정' }] });
    assert.ok(!proposed.isError);
    const completed = await model.callTool({ name: 'complete_request', arguments: { summary: '수정 제안을 저장했습니다.' } });
    assert.ok(!completed.isError, completed.content[0]?.text);
    assert.equal((await api(`${route}/requests/${request.rid}`)).status, 'done');
    assert.equal((await api(`${route}/proposals`))[0].replace, '검증된 수정 문단입니다.');
    assert.deepEqual(JSON.parse((await remote.callTool({ name: 'get_request', arguments: { doc_id: doc.id, request_id: request.rid } })).content[0].text).contextItems,
      JSON.parse((await model.callTool({ name: 'get_request', arguments: {} })).content[0].text).contextItems, '완료 후 상태·문단도 모델/원서버 간 보존');
  } finally { await model?.close().catch(() => {}); await bridge?.stop(); await transport?.terminateSession().catch(() => {}); await remote?.close().catch(() => {}); await srv.stop(); }
});

test('Codex 최초 입력도 한 표현만 전달하며 gpt-6.1-sol/max 인수·원문·자료 경계·선점 검사를 보존', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-context-dedup-'));
  try {
    const launch = await fakeCodex(base), source = input();
    const ai = new CodexProposer({ model: 'gpt-6.1-sol', effort: 'max' }, { tempRoot: base, resolveCommand: async () => launch });
    await ai.runMcp({ type: 'request', docId: source.docId, requestId: source.rid, attempt: source.attempt },
      { url: 'http://127.0.0.1:1/mcp', token: 'fake-token-only', session: 'fixture-session', requestContext: source });
    const receipt = JSON.parse(await fs.readFile(path.join(base, 'receipt.json'), 'utf8'));
    assert.deepEqual(receipt.requestContext, modelRequestContext(source));
    assert.equal(receipt.args[receipt.args.indexOf('--model') + 1], 'gpt-6.1-sol');
    assert.equal(receipt.config.model_reasoning_effort, '"max"');
    assert.ok(!receipt.requestContext.context);
    assert.ok(receipt.prompt.includes('필요한 만큼만 읽습니다'));
    assert.equal(receipt.prompt.split('</document_context>').length, 2);
  } finally { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); await fs.rm(base, { recursive: true, force: true }); }
});
