import test from 'node:test';
import assert from 'node:assert/strict';
import { runResponsesAgent } from '../server/api-responses-agent.js';
import { runToolLoop, responseFailure } from '../server/api-tool-loop.js';
import { makePng } from './helpers/image.mjs';

test('fileOnly returns attachment JSON without document proposal instructions or missing-figure note', async () => {
  const bodies = [], png = makePng(4, 4); let saved = 0;
  const ai = { cfg: { model: 'fake' }, baseUrl: 'https://fake.invalid', key: 'fake', _jsonRequest: async (url, body) => {
    bodies.push(structuredClone(body));
    return { status: 'completed', model: 'file-model', usage: { input_tokens: 5, output_tokens: 2 }, output: bodies.length === 1
      ? [{ type: 'image_generation_call', id: 'img1', result: png.toString('base64') }]
      : [{ type: 'message', content: [{ type: 'output_text', text: '{"attachment_id":"a1"}' }] }] };
  } };
  const out = await runResponsesAgent(ai, { instruction: '그림 새로 그려', target: { ref: 's0/p0' } }, { instructions: '파일 JSON만', input: [] }, {
    imageGeneration: true, fileOnly: true, parse: JSON.parse,
    toolContext: { tools: [], saveFile: async ({ bytes }) => { assert.deepEqual(bytes, png); saved++; return { aid: 'a1', name: 'result.png' }; } },
  });
  assert.equal(saved, 1); assert.equal(out.attachment_id, 'a1'); assert.equal(out.figureMissing, undefined); assert.equal(out.comments, undefined);
  assert.equal(bodies.length, 2); assert.equal(bodies[0].instructions, '파일 JSON만');
  assert.ok(bodies[0].tools.some(t => t.type === 'image_generation'));
  assert.match(bodies[1].input.at(-1).content, /문서 제안은 상위 실행기/);
  assert.ok(!JSON.stringify(bodies[1]).includes('propose_figure'));
  assert.deepEqual(out.usage, { input: 10, output: 4, modelCalls: 2, toolCalls: 0 });
});

test('Responses rejected single-turn output and failed file recovery retain received usage', async () => {
  for (const singleTurn of [false, true]) {
    const ai = { cfg: {}, _jsonRequest: async () => ({ status: 'completed', model: 'received-model', usage: { input_tokens: 17, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }, output: [{ type: 'image_generation_call', result: 'AAAA' }] }) };
    await assert.rejects(runResponsesAgent(ai, {}, { instructions: '', input: [] }, { singleTurn, parse: JSON.parse }), e => {
      assert.equal(e.code, singleTurn ? 'API_UNEXPECTED_TOOL' : 'API_FILE_INVALID');
      assert.deepEqual(e.usage, { input: 17, output: 4, cacheRead: 3, modelCalls: 1, toolCalls: 0 });
      assert.equal(e.model, 'received-model'); return true;
    });
  }
});

test('failed next request does not count as model response; response-side failure accumulates exactly once', async () => {
  for (const received of [false, true]) {
    let sends = 0;
    const adapter = { send: async () => {
      if (++sends === 1) return { calls: [], more: true, usage: { input: 10, output: 2 }, model: 'first' };
      const e = new Error('safe failure');
      throw received ? responseFailure(e, { input: 7, output: 3, private: 'do not copy' }, 'second') : e;
    }, reply: async () => {}, size: () => 1 };
    await assert.rejects(runToolLoop({ cfg: {} }, {}, adapter, { parse: JSON.parse }), e => {
      assert.deepEqual(e.usage, { input: received ? 17 : 10, output: received ? 5 : 2, modelCalls: received ? 2 : 1, toolCalls: 0 });
      assert.equal(e.model, received ? 'second' : 'first'); assert.ok(!JSON.stringify(e).includes('do not copy')); return true;
    });
  }
});
