// Claude Messages API 어댑터: tool_use → MCP → tool_result. 최종 결과는 구조화 출력(output_config.format — 도구와 함께 쓴다).
// 도구 정의·시스템 지시·첫 사용자 글(문맥·첨부)은 라운드마다 같으므로 cache_control 로 캐시한다.
// 새 MCP 연결(toolContext.surface 'v2'): 도구 규칙은 시스템 지시(server/ai.js runV2 — EDITOR_INSTRUCTIONS_API_V2)에 이미 있고, 구조화 출력이 없으며,
// 끝내는 도구 없이 끝난 차례는 nudge 로 다시 부른다(server/api-tool-loop.js).
import { isTaskSurface } from './tool-profiles.js';
import { runToolLoop, toolRules, fail, responseFailure, V2_CONTINUE } from './api-tool-loop.js';
import { mcpClaudeContent } from './api-mcp-tools.js';

const cached = { type: 'ephemeral' };

export async function runMessagesAgent(ai, input, request, { signal, toolContext, parse, singleTurn = false }) {
  const v2 = isTaskSurface(toolContext?.surface);
  const tools = (toolContext?.tools || []).map(t => ({ name: t.name, description: t.description || '', input_schema: t.parameters }));
  const messages = structuredClone(request.messages);
  let partialText = '', last = [];
  if (tools.length) { const first = messages[0].content; first[first.length - 1] = { ...first.at(-1), cache_control: cached }; }
  const body = { ...request, ...(tools.length ? { tools, system: [{ type: 'text', text: request.system + (v2 ? '' : toolRules(tools.map(t => t.name))), cache_control: cached }] } : {}) };
  const { betas = [], ...nativeBody } = body;
  // SDK의 암묵적 10분 deadline도 두지 않는다. native Messages 형식과 beta 헤더는 그대로 유지한다.
  const headers = { ...(ai.anthropicHeaders?.() ?? { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' }), ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}) };
  const adapter = {
    async send(signal) {
      let res;
      try { res = await ai._jsonRequest(`${ai.baseUrl || 'https://api.anthropic.com'}/v1/messages?beta=true`, { ...nativeBody, messages }, headers, signal); } catch (e) {
        if (signal.aborted) throw new Error(signal.reason?.name === 'TimeoutError' ? 'AI 응답 시간이 초과되었습니다' : 'AI 요청이 취소되었습니다');
        if (/HTTP 400/.test(e.message) && ai.needsAnthropicWorkspace) throw fail('API_WORKSPACE_REQUIRED', '이 Claude 키(계정·서비스 계정 연결형)는 워크스페이스 ID가 필요합니다. 내 AI 키에서 워크스페이스 ID(wrkspc_…)를 넣어 주세요.');
        if (tools.length && /HTTP (400|404|422)/.test(e.message)) throw fail('API_TOOLS_UNAVAILABLE', 'API 도구 요청이 거절됐습니다. 모델·게이트웨이의 도구 규격 지원을 확인하세요.');
        throw e;
      }
      try {
      if (res.stop_reason === 'refusal') throw new Error(`모델이 요청을 거절했습니다${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`);
      const content = res.content || [];
      if (res.stop_reason === 'max_tokens' || res.stop_reason === 'pause_turn') {
        const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (res.stop_reason === 'max_tokens') partialText += text;
        if (content.some(b => b.type === 'tool_use')) messages.push({ role: 'user', content: [{ type: 'text', text: `응답 길이 한도로 중단된 도구 응답(자료, 아직 실행하지 않음): ${JSON.stringify(content)}. 완전한 도구 호출을 다시 내고 남은 작업을 계속하세요.` }] });
        else {
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: [{ type: 'text', text: v2 ? V2_CONTINUE : text && res.stop_reason === 'max_tokens' ? '길이 한도로 끊긴 JSON의 정확한 다음 문자부터 이어 쓰세요. 반복·코드펜스 없이 기존 도구 결과와 전체 목표를 보존하세요.' : '보존된 대화와 실제 도구 결과에서 이어서 전체 작업을 완료하세요.' }] });
        }
        return { calls: [], more: true, text: '', usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.cache_read_input_tokens, cacheWrite: res.usage?.cache_creation_input_tokens }, model: res.model };
      }
      const calls = content.filter(b => b.type === 'tool_use');
      // 생각(thinking)·글·도구 호출 블록을 그대로 되돌린다(생각 블록은 바꾸면 안 된다)
      if (calls.length) messages.push({ role: 'assistant', content });
      last = content;
      const usage = res.usage || {};
      return {
        calls: calls.map(b => ({ id: b.id, name: b.name, args: b.input ?? {} })),
        text: partialText + content.filter(b => b.type === 'text').map(b => b.text).join(''),
        usage: { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }, model: res.model,
      };
      } catch (e) { throw responseFailure(e, { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.cache_read_input_tokens, cacheWrite: res.usage?.cache_creation_input_tokens }, res.model); }
    },
    output: async executed => mcpClaudeContent(executed),
    failure: text => [{ type: 'text', text }],
    // 한 차례의 도구 결과는 모두 한 사용자 메시지에(나눠 보내면 병렬 호출이 줄어든다). 결과가 없는 차례(길이 한도 이어쓰기 — send 가 이어 쓸 글을 이미 넣음)는 빈 메시지를 넣지 않는다
    async reply(results) {
      if (!results.length) return;
      messages.push({ role: 'user', content: results.map(({ call, output, isError }) => ({ type: 'tool_result', tool_use_id: call.id, content: output, ...(isError ? { is_error: true } : {}) })) });
    },
    // 새 연결: 도구 없이 끝난 차례(생각·글 블록 그대로)를 남기고 사용자 글 하나를 잇는다
    async nudge(text) {
      messages.push({ role: 'assistant', content: last.length ? last : [{ type: 'text', text: '(응답 없음)' }] });
      messages.push({ role: 'user', content: [{ type: 'text', text }] });
      partialText = ''; last = [];
    },
    size: () => Buffer.byteLength(JSON.stringify(messages)),
  };
  return runToolLoop(ai, input, adapter, { signal, toolContext, parse, singleTurn });
}
