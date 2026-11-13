import test from 'node:test';
import assert from 'node:assert/strict';
import { AiProposer, outputJsonSchema, looseOutputJsonSchema, claudeOutputJsonSchema } from '../server/ai.js';

const result = () => ({ proposals: [{ ref: 's0/p0', find: '원문', replace: '권장 문장', reason: '표현 개선' }], alternatives: [], comments: [], inserts: [], tables: [], summary: '표현을 개선하도록 제안했습니다.', instructionSummary: '표현 검토' });
const input = { kind: 'review', label: 'AI 검토', instruction: '간결하게', target: { ref: 's0/p0', text: '원문' }, context: [{ ref: 's0/p0', text: '원문', isTarget: true }], options: { count: 1 } };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const make = (provider, handler, more = {}) => new AiProposer({ ai: { provider, model: 'test-model', enabled: true, ...more } }, { key: 'unit-test-key', fetch: handler });

test('OpenAI Responses: 구조화 결과·usage와 첨부를 처리하고 추론 블록을 본문으로 읽지 않는다', async () => {
  let request;
  const ai = make('openai', async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return json({ status: 'completed', model: 'test-openai', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()) }] }], usage: { input_tokens: 30, output_tokens: 20 } });
  });
  const out = await ai.run({ ...input, attachments: [
    { name: '자료.pdf', kind: 'pdf', base64: 'PDFTEST' },
    { name: '그림.png', kind: 'image', mime: 'image/png', base64: 'IMGTEST' },
    { name: '자료.csv', kind: 'sheet', text: '원문,자료' },
  ], previousResults: { proposals: [{ pid: 4 }] } });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.Authorization, 'Bearer unit-test-key');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
  assert.deepEqual(request.body.input[0].content.map((b) => b.type), ['input_file', 'input_image', 'input_text', 'input_text']);
  assert.match(request.body.input[0].content.at(-1).text, /이전 실행에서 이미 저장한 결과/);
  assert.equal(out.proposals[0].replace, '권장 문장');
  assert.deepEqual(out.usage, { input: 30, output: 20, modelCalls: 1, toolCalls: 0 });
  assert.equal(ai.agentName, 'OpenAI API');
});

test('Gemini REST: 키는 헤더에만 보내고 JSON schema·이미지·표 결과를 정규화한다', async () => {
  let request;
  const ai = make('gemini', async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '내부 추론' }, { text: JSON.stringify(result()) }] } }], modelVersion: 'test-gemini', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } });
  });
  const out = await ai.run({ ...input, attachments: [{ name: '그림.png', kind: 'image', mime: 'image/png', base64: 'TEST' }] });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
  assert.ok(!request.url.includes('unit-test-key'));
  assert.equal(request.headers['x-goog-api-key'], 'unit-test-key');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.body.generationConfig.responseJsonSchema.type, 'object');
  assert.equal(request.body.contents[0].parts[1].inlineData.data, 'TEST');
  assert.equal(out.summary, result().summary);
  assert.deepEqual(out.usage, { input: 12, output: 7, modelCalls: 1, toolCalls: 0 });
});

test('API 인증 오류 본문이나 잘못된 출력에 든 키·원문을 오류 기록에 복사하지 않는다', async () => {
  for (const provider of ['openai', 'gemini']) {
    const denied = make(provider, async () => json({ error: { message: 'unit-test-key 민감한 문서 원문' } }, 401));
    await assert.rejects(denied.run(input), (e) => /HTTP 401/.test(e.message) && !/unit-test-key|민감한/.test(e.message));
    const malformed = make(provider, async () => provider === 'openai'
      ? json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{unit-test-key' }] }] })
      : json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{unit-test-key' }] } }] }));
    await assert.rejects(malformed.run(input), (e) => /형식/.test(e.message) && !/unit-test-key/.test(e.message));
  }
});

test('거절·복구 불가 중단·차단 결과는 완료 데이터로 채택하지 않는다', async () => {
  for (const output of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '거절' }] }] },
  ]) await assert.rejects(make('openai', async () => json(output)).run(input));
  for (const output of [
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] },
  ]) await assert.rejects(make('gemini', async () => json(output)).run(input));
});

test('API 호출 전·중 취소가 실제 fetch에 전파되어 결과를 만들지 않는다', async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  const ai = make('openai', async (url, init) => { calls++; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('secret-key')), { once: true })); });
  await assert.rejects(ai.run(input, { signal: before.signal })); assert.equal(calls, 0);
  const during = new AbortController(); const pending = ai.run(input, { signal: during.signal });
  during.abort(); await assert.rejects(pending, /취소/); assert.equal(calls, 1);
});

test('BAZE 게이트웨이: 제공자별 BAZE 주소·Bearer 인증·추론 강도, 처리자 이름에 경유 표시', async () => {
  const seen = [];
  const handler = async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    if (String(url).includes('/responses')) return json({ status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result()) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    if (String(url).includes(':generateContent')) return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result()) }] } }] });
    return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result()) }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const openai = make('openai', handler, { gateway: 'baze', model: 'gpt-6.1-sol', effort: 'medium' });
  assert.equal(openai.agentName, 'OpenAI API (게이트웨이)');
  await openai.run(input);
  assert.equal(seen[0].url, 'https://api.baze.co/v1/gateway/responses');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer unit-test-key');
  assert.deepEqual(seen[0].body.reasoning, { effort: 'medium' });
  await make('gemini', handler, { gateway: 'baze' }).run(input);
  assert.equal(seen[1].url, 'https://api.baze.co/v1/gateway/gemini/v1beta/models/test-model:generateContent');
  assert.equal(seen[1].headers.get('authorization'), 'Bearer unit-test-key');
  assert.equal(seen[1].headers.get('x-goog-api-key'), null);
  await make('anthropic', handler, { gateway: 'baze', effort: 'low' }).run(input);
  assert.match(seen[2].url, /^https:\/\/api\.baze\.co\/v1\/gateway\/claude\/v1\/messages/);
  assert.equal(seen[2].headers.get('x-api-key'), 'unit-test-key');
  assert.equal(seen[2].body.output_config.effort, 'low');
  // 직접 연결은 effort 를 적었을 때만 reasoning 을 보낸다(추론 없는 모델 보호)
  await make('openai', handler).run(input);
  assert.equal(seen[3].url, 'https://api.openai.com/v1/responses');
  assert.equal(seen[3].body.reasoning, undefined);
  // 사용자 지정 주소: 끝 / 를 떼고, 계정·질의가 든 주소·http 원격 주소는 거절
  await make('openai', handler, { baseUrl: 'https://gateway.example/v1/' }).run(input);
  assert.equal(seen[4].url, 'https://gateway.example/v1/responses');
  for (const baseUrl of ['http://gateway.example/v1', 'https://user:pw@gateway.example/v1', 'https://gateway.example/v1?key=x', 'not a url']) {
    assert.equal(make('openai', handler, { baseUrl }).enabled, false, baseUrl);
  }
  assert.equal(make('openai', handler, { baseUrl: 'http://localhost:4000/v1' }).baseUrl, 'http://localhost:4000/v1');
  assert.equal(make('openai', handler, { gateway: 'unknown' }).enabled, false);
  assert.equal(make('openai', handler, { effort: 'turbo' }).enabled, false);
});

test('게이트웨이 키는 BAZE_API_KEY 에서만 — 제공자 키·키 파일을 게이트웨이로 보내지 않는다', () => {
  const ai = (provider, env, extra = {}) => new AiProposer({ ai: { provider, enabled: true, model: 'test-model', ...extra } }, { env });
  assert.equal(ai('openai', { BAZE_API_KEY: 'baze-key', OPENAI_API_KEY: 'openai-key' }, { gateway: 'baze' }).key, 'baze-key');
  const noKey = ai('anthropic', { ANTHROPIC_API_KEY: 'anthropic-key' }, { gateway: 'baze', keyFile: 'SHOULD-NOT-READ' });
  assert.equal(noKey.enabled, false); assert.match(noKey.reason, /BAZE_API_KEY/);
  assert.equal(ai('gemini', { GOOGLE_API_KEY: 'google-key' }, { gateway: 'baze' }).enabled, false);
  assert.equal(ai('openai', { CUSTOM_GATEWAY_KEY: 'custom' }, { baseUrl: 'https://gateway.example/v1', keyEnv: 'CUSTOM_GATEWAY_KEY' }).key, 'custom');
  assert.equal(ai('openai', {}, { baseUrl: 'https://gateway.example/v1', keyFile: 'SHOULD-NOT-READ' }).enabled, false);
  // 임의 주소는 keyEnv 를 꼭 밝힌다 — 환경의 OPENAI_API_KEY 를 그 주소로 보내지 않는다(BAZE 와 함께 줘도 같다)
  for (const extra of [{ baseUrl: 'https://gateway.example/v1' }, { gateway: 'baze', baseUrl: 'https://gateway.example/v1' }]) {
    const unsafe = ai('openai', { OPENAI_API_KEY: 'openai-key', BAZE_API_KEY: 'baze-key' }, extra);
    assert.equal(unsafe.enabled, false); assert.equal(unsafe.key, null); assert.match(unsafe.reason, /keyEnv/);
  }
});

test('Claude·Gemini 출력 스키마: 값 범위·패턴 없이, Claude 는 nullable 매개변수 16개 이하이고 서식을 JSON 문자열로 받는다', async () => {
  const bounds = /"(pattern|minimum|maximum|minItems|maxItems|minLength|maxLength)"/;
  assert.ok(bounds.test(JSON.stringify(outputJsonSchema())), 'OpenAI strict 스키마는 그대로');
  // reason 이 마지막 키여야 한다 — 뒤에 null 이 되기 쉬운 format·runs 가 오면 strict 출력이 공백만 끝없이 낸다(실측)
  for (const list of ['proposals', 'alternatives', 'inserts']) assert.equal(Object.keys(outputJsonSchema().properties[list].items.properties).at(-1), 'reason', list);
  assert.ok(!bounds.test(JSON.stringify(looseOutputJsonSchema())));
  const claude = claudeOutputJsonSchema();
  assert.ok(!bounds.test(JSON.stringify(claude)));
  let unions = 0;
  const count = (node) => { if (Array.isArray(node)) return node.forEach(count); if (!node || typeof node !== 'object') return; if (node.anyOf || Array.isArray(node.type)) unions++; Object.values(node).forEach(count); };
  count(claude);
  assert.ok(unions <= 16, `nullable 매개변수 ${unions}개`);
  // 2026-11-10 Claude API 직접 실측: 항목 모양이 다 든 스키마는 'compiled grammar is too large'(400) — 목록마다 JSON 배열 글 하나로 받고 모양은 설명으로
  assert.equal(claude.properties.proposals.type, 'string');
  assert.match(claude.properties.proposals.description, /bold:true\|false/);
  // 받은 JSON 문자열을 펼치고 빈 값('' charPrId)은 지정 안 함으로 본다
  let request;
  const ai = make('anthropic', async (url, init) => {
    request = JSON.parse(init.body);
    const text = JSON.stringify({ ...result(), proposals: [{ ref: 's0/p0', find: '원문', replace: '새 글', reason: '굵게', format: '', runs: JSON.stringify([{ text: '새 ', charPrId: '' }, { text: '글', charPrId: '', char: { bold: true, color: '' } }]) }], formats: [{ ref: 's0/p0', find: '원문', occurrence: null, format: '{"char":{"italic":true}}', reason: '기울임' }] });
    return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const out = await ai.run(input);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(out.proposals[0].runs, [{ text: '새 ' }, { text: '글', char: { bold: true } }]);
  assert.equal(out.proposals[0].format, undefined);
  assert.deepEqual(out.formats[0].format, { char: { italic: true } });
  const broken = make('anthropic', async () => json({ id: 'msg', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...result(), proposals: [{ ref: 's0/p0', find: '원문', replace: '새 글', reason: 'r', format: '{깨진', runs: '' }] }) }], usage: {} }));
  await assert.rejects(broken.run(input), /형식/);
});

test('제공자별 환경키 선택, 모델 누락·호출 꺼짐·알 수 없는 제공자 검사', async () => {
  const ai = (provider, env, extra = {}) => new AiProposer({ ai: { provider, enabled: true, model: 'test-model', ...extra } }, { env });
  assert.equal(ai('openai', { OPENAI_API_KEY: 'test-openai' }).key, 'test-openai');
  assert.equal(ai('gemini', { GOOGLE_API_KEY: 'test-google' }).key, 'test-google');
  assert.equal(ai('claude', { ANTHROPIC_API_KEY: 'test-anthropic' }).provider, 'anthropic');
  assert.equal(ai('openai', { ANTHROPIC_API_KEY: 'wrong-provider' }).enabled, false);
  assert.equal(ai('openai', { OPENAI_API_KEY: 'test' }, { enabled: false }).enabled, false);
  assert.equal(ai('openai', { OPENAI_API_KEY: 'test' }, { model: null }).enabled, false);
  assert.equal(ai('invalid', {}).enabled, false);
});
