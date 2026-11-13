// LM Studio 로그에서 확인한 실패: 도구 저장 뒤 일반 설명문/코드블록을 반환한다.
// API는 fake fetch, 문서는 임시 서버의 fixture 사본만 사용한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiProposer, parseResult } from '../server/ai.js';
import { createApiWorker } from '../server/worker.js';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const empty = { proposals: [], alternatives: [], comments: [], inserts: [], tables: [], summary: '문장을 다듬는 제안을 저장했습니다.', instructionSummary: '문장 다듬기' };
const response = output => new Response(JSON.stringify({ status: 'completed', model: 'fake-local', output, usage: { input_tokens: 10, output_tokens: 5 } }));
const message = text => response([{ type: 'message', content: [{ type: 'output_text', text }] }]);
const input = { kind: 'instruct', instruction: '문장을 다듬어 주세요', target: { ref: 's0/p1' }, targetText: '원문', contextItems: [{ ref: 's0/p1', text: '원문', isTarget: true }] };
const makeAi = fetch => new AiProposer({ ai: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'fake-local', enabled: true } }, { key: 'fake-local-key', fetch });

for (const text of ['수정 제안 한 건을 저장했습니다.', '수정했습니다.\n```json\n' + JSON.stringify(empty) + '\n```']) {
  test(`로컬 worker: ${text.startsWith('수정했습니다') ? '코드블록' : '설명문'} 최종 응답을 한 번 교정하고 중복 없이 완료`, async () => {
    assert.throws(() => parseResult(text), { code: 'API_RESULT_FORMAT' }, '수정 전 실패 원인인 파서 거절을 확인');
    const srv = await startServer(); let worker;
    try {
      const api = srv.api('a'), doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
      const route = `/api/docs/${doc.id}`, target = (await api(`${route}/paragraphs`)).find(p => p.ref === 's0/p1');
      let rounds = 0;
      const ai = makeAi(async (url, init) => {
        assert.equal(url, 'http://localhost:1234/v1/responses');
        const body = JSON.parse(init.body);
        rounds++;
        if (rounds === 1) return response([{ type: 'function_call', call_id: 'call_1', name: 'propose_changes', arguments: JSON.stringify({ proposals: [{ ref: target.ref, find: target.text, replace: target.text + ' 수정', reason: '시험' }] }) }]);
        if (rounds === 2) return message(text);
        assert.equal(rounds, 3, '형식 교정은 한 번만 호출');
        assert.equal(body.tools, undefined, '형식 교정에서는 쓰기 도구를 제공하지 않는다');
        assert.ok(body.input.some(i => i.type === 'function_call_output'), '기존 도구 결과 보존');
        assert.equal(body.input.at(-2).content, text);
        assert.match(body.input.at(-1).content, /JSON 객체 하나/);
        return message(JSON.stringify(empty));
      });
      worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, log() {} });
      const request = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', target: { ref: target.ref }, instruction: '문장을 다듬어 주세요', route: 'queue' } })).request;
      worker.start();
      const deadline = Date.now() + 15000;
      while (worker.stats().completed + worker.stats().failed === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      const finished = await api(`${route}/requests/${request.rid}`);
      assert.equal(finished.status, 'done', finished.error);
      assert.equal((await api(`${route}/proposals`)).length, 1);
      assert.equal(rounds, 3);
      assert.equal(finished.usage.modelCalls, 3);
    } finally { await worker?.stop(); await srv.stop(); }
  });
}

test('로컬 형식 교정도 실패하면 두 번만 호출하고 형식 오류·사용량 보존', async () => {
  let rounds = 0;
  const ai = makeAi(async () => { rounds++; return message('완료했습니다.'); });
  await assert.rejects(ai.run(input), e => e.code === 'API_RESULT_FORMAT' && e.usage.modelCalls === 2);
  assert.equal(rounds, 2);
});

test('교정 JSON이 유효해도 실제 결과·변경 불필요 사유 없이는 완료하지 않는다', async () => {
  let rounds = 0;
  const ai = makeAi(async () => ++rounds === 1 ? message('완료했습니다.') : message(JSON.stringify(empty)));
  await assert.rejects(ai.run(input), { code: 'API_RESULT_INCOMPLETE' });
  assert.equal(rounds, 2);
});

test('처음부터 유효한 JSON이면 교정 호출 없이 기존 경로 유지', async () => {
  let rounds = 0;
  const ai = makeAi(async () => { rounds++; return message(JSON.stringify({ ...empty, noChangesReason: '대상 문장을 확인했으며 수정할 표현이 없습니다.' })); });
  assert.equal((await ai.run(input)).usage.modelCalls, 1);
  assert.equal(rounds, 1);
});

test('형식 교정 중 예기치 않은 쓰기 도구는 실행하지 않는다', async () => {
  let rounds = 0, writes = 0;
  const ai = makeAi(async () => ++rounds === 1 ? message('완료했습니다.') : response([{ type: 'function_call', call_id: 'call_bad', name: 'add_memo', arguments: '{}' }]));
  await assert.rejects(ai.run(input, { toolContext: { tools: [], written: [], call() { writes++; } } }), { code: 'API_UNEXPECTED_TOOL' });
  assert.equal(writes, 0);
  assert.equal(rounds, 2);
});

test('도구 없는 교정 요청의 HTTP 400을 도구 미지원으로 오분류하지 않는다', async () => {
  let rounds = 0;
  const ai = makeAi(async () => ++rounds === 1 ? message('완료했습니다.') : new Response('{}', { status: 400 }));
  await assert.rejects(ai.run(input, { toolContext: { tools: [{ name: 'read_document', parameters: { type: 'object' } }], written: [] } }), e => {
    assert.match(e.message, /HTTP 400/);
    assert.notEqual(e.code, 'API_TOOLS_UNAVAILABLE');
    return true;
  });
  assert.equal(rounds, 2);
});

test('교정 재요청 직전 취소되면 모델을 다시 호출하지 않는다', async () => {
  let rounds = 0;
  const controller = new AbortController();
  const ai = makeAi(async () => { rounds++; return message('완료했습니다.'); });
  // 응답 JSON을 읽은 직후 취소되는 경합을 재현한다.
  ai._fetch = async () => { rounds++; const result = message('완료했습니다.'); const read = result.json.bind(result); result.json = async () => { const value = await read(); controller.abort(); return value; }; return result; };
  await assert.rejects(ai.run(input, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(rounds, 1);
});
