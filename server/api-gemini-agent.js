// Gemini generateContent 어댑터: functionCall → MCP → functionResponse. 최종 결과는 responseJsonSchema.
// Gemini 함수 선언은 JSON Schema 의 일부만 받으므로 투영 때 다듬는다(값 범위·패턴 빼기, oneOf → anyOf, const → enum).
// 도구와 구조화 출력을 함께 거절하는 모델·게이트웨이(HTTP 400)는 구조화 출력 없이 한 번 더 보내고(스키마는 지시 글로) 답에서 JSON 을 꺼낸다.
// 새 MCP 연결(toolContext.surface 'v2'): 구조화 출력이 없으므로(server/ai.js runV2) 400 은 곧 도구 거절이다. 도구 규칙은 시스템 지시에 이미 있다.
import { runToolLoop, toolRules, fail, responseFailure, V2_CONTINUE } from './api-tool-loop.js';
import { withoutBounds } from './format-schema.js';

function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    if (key === 'oneOf') out.anyOf = geminiSchema(value);
    else if (key === 'const') out.enum = [value];
    else if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, geminiSchema(item)]));
    else out[key] = geminiSchema(value);
  }
  return out;
}
const jsonText = text => { const s = text.indexOf('{'), e = text.lastIndexOf('}'); return s >= 0 && e > s ? text.slice(s, e + 1) : text; };

export async function runGeminiAgent(ai, input, request, { signal, toolContext, parse, singleTurn = false }) {
  const v2 = toolContext?.surface === 'v2';
  const declarations = (toolContext?.tools || []).map(t => ({ name: t.name, description: t.description || '', parametersJsonSchema: withoutBounds(geminiSchema(t.parameters)) }));
  const contents = structuredClone(request.contents);
  const url = `${ai.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;
  const headers = ai._authHeaders({ 'x-goog-api-key': ai.key });
  const { responseMimeType, responseJsonSchema, ...generation } = request.generationConfig;
  let plain = false, partialText = '', last = [];
  const body = () => ({
    systemInstruction: { parts: [{ text: request.system + (declarations.length && !v2 ? toolRules(declarations.map(d => d.name)) : '')
      + (plain ? `\n최종 답은 설명 없이 아래 JSON Schema 를 따르는 JSON 객체 하나로만 낸다(모든 키를 넣는다):\n${JSON.stringify(responseJsonSchema)}` : '') }] },
    contents,
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: plain ? generation : request.generationConfig,
  });
  const adapter = {
    async send(signal) {
      let res;
      try { res = await ai._jsonRequest(url, body(), headers, signal); } catch (e) {
        if (!declarations.length || !/HTTP (400|404|422)/.test(e.message)) throw e;
        // 구조화 출력이 없는 요청(새 연결)은 다시 보내 볼 것이 없다 — 400 은 도구 거절
        if (plain || !responseJsonSchema || !/HTTP 400/.test(e.message)) throw fail('API_TOOLS_UNAVAILABLE', 'API 도구 요청이 거절됐습니다. 모델·게이트웨이의 함수 호출 지원을 확인하세요.');
        plain = true;
        try { res = await ai._jsonRequest(url, body(), headers, signal); } catch (again) {
          if (/HTTP (400|404|422)/.test(again.message)) throw fail('API_TOOLS_UNAVAILABLE', 'API 도구 요청이 거절됐습니다. 모델·게이트웨이의 함수 호출 지원을 확인하세요.');
          throw again;
        }
      }
      try {
      const candidate = res.candidates?.[0];
      if (!candidate || res.promptFeedback?.blockReason || (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason))) throw new Error('Gemini 응답이 차단되거나 완료되지 않았습니다');
      const parts = candidate.content?.parts || [];
      if (candidate.finishReason === 'MAX_TOKENS') {
        const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
        partialText += text;
        if (parts.some(p => p.functionCall)) contents.push({ role: 'user', parts: [{ text: `응답 길이 한도로 중단된 도구 응답(자료, 아직 실행하지 않음): ${JSON.stringify(parts)}. 완전한 도구 호출을 다시 내고 남은 작업을 계속하세요.` }] });
        else {
          contents.push({ role: 'model', parts });
          contents.push({ role: 'user', parts: [{ text: v2 ? V2_CONTINUE : text ? '길이 한도로 끊긴 JSON의 정확한 다음 문자부터 이어 쓰세요. 반복·코드펜스 없이 기존 도구 결과와 전체 목표를 보존하세요.' : '보존된 대화와 실제 도구 결과에서 이어서 전체 작업을 완료하세요.' }] });
        }
        return { calls: [], more: true, text: '', usage: { input: res.usageMetadata?.promptTokenCount, output: res.usageMetadata?.candidatesTokenCount, cacheRead: res.usageMetadata?.cachedContentTokenCount }, model: res.modelVersion || request.model };
      }
      const calls = parts.filter(p => p.functionCall);
      // 생각 서명(thoughtSignature)이 붙은 부분까지 그대로 되돌린다
      if (calls.length) contents.push({ role: 'model', parts });
      last = parts;
      const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
      const usage = res.usageMetadata || {};
      return {
        calls: calls.map(p => ({ id: p.functionCall.id ?? null, name: p.functionCall.name, args: p.functionCall.args ?? {} })),
        text: plain ? jsonText(partialText + text) : partialText + text,
        usage: { input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, cacheRead: usage.cachedContentTokenCount }, model: res.modelVersion || request.model,
      };
      } catch (e) { throw responseFailure(e, { input: res.usageMetadata?.promptTokenCount, output: res.usageMetadata?.candidatesTokenCount, cacheRead: res.usageMetadata?.cachedContentTokenCount }, res.modelVersion || request.model); }
    },
    output: async executed => executed,
    failure: text => ({ isError: true, content: [{ type: 'text', text }] }),
    // 새 연결: 도구 없이 끝난 차례(생각 서명 포함 그대로)를 남기고 사용자 글 하나를 잇는다
    async nudge(text) {
      contents.push({ role: 'model', parts: last.length ? last : [{ text: '(응답 없음)' }] });
      contents.push({ role: 'user', parts: [{ text }] });
      partialText = ''; last = [];
    },
    // 결과 글은 functionResponse 로, 그림(read_attachment 등)은 같은 차례의 inlineData 로. 결과가 없는 차례(길이 한도 이어쓰기)는 빈 차례를 넣지 않는다
    async reply(results) {
      if (!results.length) return;
      const parts = [], images = [];
      for (const { call, output } of results) {
        const text = (output.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        parts.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: output.isError ? { error: text } : { result: text } } });
        for (const c of output.content || []) if (c.type === 'image' && /^image\/(png|jpeg|webp)$/.test(c.mimeType || '')) images.push({ inlineData: { mimeType: c.mimeType, data: c.data } });
      }
      contents.push({ role: 'user', parts: [...parts, ...images] });
    },
    size: () => Buffer.byteLength(JSON.stringify(contents)),
  };
  return runToolLoop(ai, input, adapter, { signal, toolContext, parse, singleTurn });
}
