import test from 'node:test';
import assert from 'node:assert/strict';
import { runResponsesAgent } from '../server/api-responses-agent.js';
import { runMessagesAgent } from '../server/api-messages-agent.js';
import { runGeminiAgent } from '../server/api-gemini-agent.js';
import { runToolLoop } from '../server/api-tool-loop.js';

for (const provider of ['openai', 'anthropic', 'gemini']) {
  for (const tool of [false, true]) test(`${provider}: single JSON turn ${tool ? 'rejects unexpected tool without retry' : 'returns valid output once'}`, async () => {
    let requests = 0;
    const result = provider === 'openai' ? { status: 'completed', output: tool ? [{ type: 'function_call', call_id: 'c1', name: 'read_document', arguments: '{}' }] : [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }
      : provider === 'anthropic' ? { id: 'msg1', type: 'message', role: 'assistant', stop_reason: tool ? 'tool_use' : 'end_turn', content: tool ? [{ type: 'tool_use', id: 'c1', name: 'read_document', input: {} }] : [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { candidates: [{ finishReason: 'STOP', content: { parts: tool ? [{ functionCall: { name: 'read_document', args: {} } }] : [{ text: '{"ok":true}' }] } }] };
    const ai = { cfg: { model: 'fake' }, key: 'fake', baseUrl: 'https://fake.invalid',
      _authHeaders: x => x, _jsonRequest: async () => { requests++; return result; },
      _fetch: async () => { requests++; return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }); } };
    const options = { singleTurn: true, allowHosted: false, parse: JSON.parse };
    const run = () => provider === 'openai' ? runResponsesAgent(ai, {}, { instructions: 'JSON', input: [] }, options)
      : provider === 'anthropic' ? runMessagesAgent(ai, {}, { model: 'fake', max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text: 'JSON' }] }] }, options)
        : runGeminiAgent(ai, {}, { model: 'fake', system: 'JSON', contents: [], generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } } }, options);
    if (tool) await assert.rejects(run(), e => {
      assert.equal(e.code, 'API_UNEXPECTED_TOOL');
      assert.equal(e.usage.modelCalls, 1); assert.equal(e.usage.toolCalls, 0);
      return true;
    });
    else { const output = await run(); assert.equal(output.ok, true); assert.equal(output.usage.modelCalls, 1); }
    assert.equal(requests, 1);
  });
}

test('single turn rejects more and never executes tools; native loop still completes second round', async () => {
  for (const singleTurn of [false, true]) {
    let sends = 0, writes = 0, closed = 0;
    const adapter = { send: async () => ++sends === 1 ? { calls: [{ id: 'c1', name: 'read_document', args: {} }], usage: {} } : { calls: [], text: '{"ok":true,"noChangesReason":"읽기만 하는 시험 — 문서 변경 없음"}', usage: {} },
      output: async x => x, reply: async () => {}, size: () => 1, close: async () => { closed++; } };
    const promise = runToolLoop({ cfg: {} }, {}, adapter, { singleTurn, parse: JSON.parse, toolContext: { call: async () => { writes++; return {}; } } });
    if (singleTurn) await assert.rejects(promise, { code: 'API_UNEXPECTED_TOOL' });
    else assert.equal((await promise).ok, true);
    assert.equal(sends, singleTurn ? 1 : 2); assert.equal(writes, singleTurn ? 0 : 1); assert.equal(closed, 1);
  }
  await assert.rejects(runToolLoop({ cfg: {} }, {}, { send: async () => ({ calls: [], more: true, usage: {} }) }, { singleTurn: true, parse: JSON.parse }), { code: 'API_UNEXPECTED_TOOL' });
});

test('unexpected hosted output is rejected before downloading or saving files', async () => {
  let saved = 0;
  await assert.rejects(runResponsesAgent({ cfg: {}, _jsonRequest: async () => ({ output: [{ type: 'image_generation_call', result: 'AAAA' }] }) }, {}, { instructions: '', input: [] },
    { singleTurn: true, parse: JSON.parse, toolContext: { tools: [], uploadFile: async () => { saved++; } } }), { code: 'API_UNEXPECTED_TOOL' });
  assert.equal(saved, 0);
});
