// 기본 native API: 비용 없는 fake provider로 실제 MCP 스키마·대화·이어쓰기를 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server/mcp.js';
import { createApiToolContext } from '../server/api-mcp-tools.js';
import { AiProposer } from '../server/ai.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const result = { noChangesReason: '요청 범위의 문장을 확인했으며 추가 변경이 필요하지 않습니다.', proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '문서를 검토했으며 변경하지 않았습니다.', instructionSummary: '메모대로 표현 수정' };
const response = (provider, text, clipped = false) => provider === 'openai'
  ? json({ status: clipped ? 'incomplete' : 'completed', ...(clipped ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 10 } })
  : provider === 'anthropic' ? json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-model', stop_reason: clipped ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } })
    : json({ candidates: [{ finishReason: clipped ? 'MAX_TOKENS' : 'STOP', content: { role: 'model', parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } });
const toolReply = provider => provider === 'openai'
  ? json({ status: 'completed', output: [{ type: 'function_call', call_id: 'write_1', name: 'propose_changes', arguments: JSON.stringify({ proposals: [{ ref: 's0/p1', find: '둘째 문단', replace: '두 번째 문단' }] }) }] })
  : provider === 'anthropic' ? json({ id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'write_1', name: 'propose_changes', input: { proposals: [{ ref: 's0/p1', find: '둘째 문단', replace: '두 번째 문단' }] } }] })
    : json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'propose_changes', args: { proposals: [{ ref: 's0/p1', find: '둘째 문단', replace: '두 번째 문단' }] } }, thoughtSignature: 'native-signature' }] } }] });

async function actualTools(t) {
  const server = createMcpServer({ service: { orchestration: {}, drive: { aiEnabled: true } }, user: { name: '시험' } });
  const client = new Client({ name: 'native-api-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return (await client.listTools()).tools;
}
for (const provider of ['openai', 'anthropic', 'gemini']) test(`${provider}: 기본 실행에 전체 문서·60KB 넘는 모든 서식·native 도구와 결과 보존`, async t => {
  const source = await actualTools(t), sent = [], writes = [];
  const context = await createApiToolContext({ docId: 'bound-doc', requestId: 7, attempt: 2, listTools: async () => source,
    assertCurrent: async () => {}, callTool: async (name, args) => { writes.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify([{ pid: 5, status: 'pending', receipt: 'actual-mcp-receipt' }]) }] }; } });
  const formattingHeader = { styles: Array.from({ length: 800 }, (_, id) => ({ id: String(id), name: `서식${id}`, description: '서식정의'.repeat(40) })) };
  const original = structuredClone(formattingHeader);
  const ai = new AiProposer({ ai: { provider, gateway: 'baze', model: 'fake-model' } }, { key: 'fake-key', fetch: async (url, init) => {
    const body = JSON.parse(init.body); sent.push(body);
    const all = JSON.stringify(body); assert.ok(all.includes('전체문서끝') && all.includes('서식799') && all.includes('charPrId'));
    const native = provider === 'gemini' ? body.tools[0].functionDeclarations : body.tools;
    assert.equal(native.length, context.tools.length); assert.ok(native.some(t => t.name === 'propose_toc_update'));
    if (sent.length === 1) return toolReply(provider);
    assert.match(all, /actual-mcp-receipt/);
    if (provider === 'gemini') assert.match(all, /native-signature/);
    return response(provider, JSON.stringify(result));
  } });
  const done = await ai.run({ kind: 'instruct', instruction: '이 메모대로 문장을 고쳐 줘', target: { ref: 's0/p1', text: '둘째 문단' },
    context: [{ ref: 's0/p1', text: '둘째 문단', styleId: '799', paraPrId: '18', runs: [{ charPrId: '33' }] }],
    document: { title: '전체 문서', text: '전체문서시작\n' + '문서원문'.repeat(25000) + '\n전체문서끝' }, formattingHeader,
    followUp: { memoText: '둘째 문단을 두 번째 문단으로 고쳐 주세요.' }, options: {}, attachments: [] }, { toolContext: context });
  assert.deepEqual(formattingHeader, original); assert.equal(sent.length, 2); assert.equal(done.execution, 'tool-agent');
  assert.equal(done.usage.toolCalls, 1); assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].args.doc_id, writes[0].args.request_id, writes[0].args.expected_attempt], ['bound-doc', 7, 2]);
});
for (const provider of ['openai', 'anthropic', 'gemini']) test(`${provider}: 출력 길이 중단은 보존된 원문에서 내부 이어쓰기`, async () => {
  const full = JSON.stringify(result), split = Math.floor(full.length / 2); let calls = 0;
  const ai = new AiProposer({ ai: { provider, gateway: 'baze', model: 'fake-model' } }, { key: 'fake-key', fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (++calls === 1) return response(provider, full.slice(0, split), true);
    assert.match(JSON.stringify(body), /길이 한도/); assert.ok(JSON.stringify(body).includes(JSON.stringify(full.slice(0, split)).slice(1, -1)));
    return response(provider, full.slice(split));
  } });
  const done = await ai.run({ kind: 'review', instruction: '문서를 검토해 줘', context: [], attachments: [] });
  assert.equal(calls, 2); assert.equal(done.summary, result.summary); assert.equal(done.usage.modelCalls, 2);
});

test('native 대화: 4MB를 넘는 도구 결과도 다음 요청에서 원문과 끝까지 보존', async () => {
  const whole = '대용량원문'.repeat(850000) + '원문마지막표식'; let rounds = 0;
  const context = { tools: [{ name: 'read_document', parameters: { type: 'object', properties: {} } }], call: async () => ({ content: [{ type: 'text', text: whole }] }) };
  const ai = new AiProposer({ ai: { provider: 'openai', model: 'fake-model' } }, { key: 'fake-key', fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (++rounds === 1) return json({ status: 'completed', output: [{ type: 'function_call', call_id: 'read_full', name: 'read_document', arguments: '{}' }] });
    const saved = body.input.find(i => i.type === 'function_call_output');
    assert.equal(saved.output, whole); assert.ok(Buffer.byteLength(JSON.stringify(body.input)) > 4 * 1048576);
    return response('openai', JSON.stringify(result));
  } });
  const done = await ai.run({ kind: 'review', instruction: '문서 전체 검토', context: [], attachments: [] }, { toolContext: context });
  assert.equal(rounds, 2); assert.equal(done.usage.toolCalls, 1);
});

test('생성 요청은 기본 deadline 없이 취소 signal을 보존하고 명시 timeout만 적용', async () => {
  const originalTimeout = AbortSignal.timeout, armed = [];
  AbortSignal.timeout = ms => { armed.push(ms); return originalTimeout(ms); };
  try {
    const ai = new AiProposer({ ai: { provider: 'openai', model: 'fake-model' } }, { key: 'fake-key', fetch: async (url, init) => {
      assert.equal(init.signal, undefined); return json({ ok: true });
    } });
    await ai._jsonRequest('https://example.invalid/responses', {}, {});
    assert.deepEqual(armed, []);
    const cancellation = new AbortController();
    ai._fetch = async (url, init) => { assert.equal(init.signal, cancellation.signal); return json({ ok: true }); };
    await ai._jsonRequest('https://example.invalid/responses', {}, {}, cancellation.signal);
    assert.deepEqual(armed, []);
    ai.cfg.timeoutMs = 15;
    ai._fetch = async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      // 실제 HTTP 소켓처럼 timeout 신호를 기다리는 동안 이벤트 루프를 유지한다.
      const keepAlive = setTimeout(() => reject(new Error('명시 timeout이 적용되지 않음')), 1000);
      init.signal.addEventListener('abort', () => clearTimeout(keepAlive), { once: true });
    });
    await assert.rejects(ai._jsonRequest('https://example.invalid/responses', {}, {}), /응답 시간이 초과/);
    assert.deepEqual(armed, [15]);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('native 도구 인수 48만자 초과도 원문 그대로 실행', async () => {
  const source = '요청한본문'.repeat(110000); let rounds = 0, written;
  const context = { tools: [{ name: 'propose_insert', parameters: { type: 'object', properties: {} } }], call: async (name, args) => { written = args.text; return { content: [{ type: 'text', text: '{"pid":1}' }] }; } };
  const ai = new AiProposer({ ai: { provider: 'openai', model: 'fake-model' } }, { key: 'fake-key', fetch: async () => ++rounds === 1
    ? json({ status: 'completed', output: [{ type: 'function_call', call_id: 'large_write', name: 'propose_insert', arguments: JSON.stringify({ after_ref: 's0/p1', text: source }) }] })
    : response('openai', JSON.stringify(result)) });
  await ai.run({ kind: 'instruct', instruction: '본문을 완성해 줘', context: [], attachments: [] }, { toolContext: context });
  assert.equal(written, source); assert.equal(rounds, 2);
});

for (const provider of ['openai', 'anthropic', 'gemini']) test(`${provider}: 빈 보고서 성공 주장은 실패, 구체적 변경 불필요 사유는 허용`, async () => {
  const { noChangesReason, ...empty } = result;
  const ai = new AiProposer({ ai: { provider, gateway: 'baze', model: 'fake-model' } }, { key: 'fake-key', fetch: async () => response(provider, JSON.stringify({ ...empty, summary: '요청한 보고서 작성을 모두 완료했습니다.' })) });
  const input = { kind: 'instruct', instruction: '자료를 분석해 완성된 보고서를 작성해 줘', context: [], attachments: [] };
  await assert.rejects(ai.run(input), error => error.code === 'API_RESULT_INCOMPLETE' && error.usage.modelCalls === 1);
  ai._fetch = async () => response(provider, JSON.stringify({ ...empty, summary: '문서를 검토했으며 변경이 필요하지 않습니다.', noChangesReason: '대상 문단의 모든 인용 수치와 표 원자료를 대조했으며 차이가 없고 표현 오류도 없어 수정할 필요가 없습니다.' }));
  const done = await ai.run({ ...input, instruction: '원자료와 차이가 있는 문단을 검토해 줘' });
  assert.match(done.noChangesReason, /원자료/);
});
