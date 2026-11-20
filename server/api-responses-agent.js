import crypto from 'node:crypto';
import { validateImage } from './image-integrity.js';
import { imageInfo } from '../engine/picture.js';
import { mcpOutput } from './api-mcp-tools.js';
import { isTaskSurface } from './tool-profiles.js';
import { runToolLoop, toolRules, fail, responseFailure, V2_CONTINUE } from './api-tool-loop.js';

const MAX_BYTES = 10 * 1048576;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const replayItem = o => (o.type === 'image_generation_call' && o.id ? { type: o.type, id: o.id } : o);

/**
 * OpenAI Responses 어댑터: function calling + provider 생성 파일 회수(hosted 작업공간). BAZE도 같은 API 규격을 지원할 때 사용한다.
 * 새 MCP 연결(toolContext.surface 'v2'): 도구 규칙은 시스템 지시(server/ai.js runV2)에 이미 있고 최종 JSON 형식이 없다. 만든 파일은 edit 의 figure op(attachment_id)로 넣게 알린다.
 */
export async function runResponsesAgent(ai, input, body, { signal, toolContext, parse, allowHosted = true, imageGeneration = false, singleTurn = false, fileOnly = false }) {
  const v2 = isTaskSurface(toolContext?.surface);
  const tools = (toolContext?.tools || []).map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  const hosted = allowHosted && ai.cfg.workspace === 'hosted';
  if (hosted) tools.push({ type: 'code_interpreter', container: { type: 'auto' } });
  if (imageGeneration) tools.push({ type: 'image_generation' });
  const messages = structuredClone(body.input), saved = new Set(), uploaded = new Set(), inputFiles = new Map();
  const fetchImpl = ai._fetch || fetch;
  let fresh = [], partialText = '', repairing = false, last = [];
  // 원본 이미지/PDF를 API 작업공간에 파일로 올린다. 모델은 인코딩 문자열을 다시 작성하지 않는다.
  const upload = async (bytes, name, signal) => {
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (inputFiles.has(digest)) return inputFiles.get(digest);
    const form = new FormData(); form.set('purpose', 'user_data'); form.set('file', new Blob([bytes]), name);
    const response = await fetchImpl(`${ai.baseUrl}/files`, { method: 'POST', body: form, headers: { Authorization: `Bearer ${ai.key}` }, redirect: 'error', signal });
    if (!response.ok) throw fail('API_FILE_UPLOAD', 'API 작업공간에 원본 파일을 전달하지 못했습니다. 게이트웨이의 Files API 지원을 확인하세요.');
    const file = await response.json();
    if (!id(file.id)) throw fail('API_FILE_INVALID', 'API 원본 파일 참조가 올바르지 않습니다.');
    uploaded.add(file.id);
    inputFiles.set(digest, file.id);
    return file.id;
  };
  const adapter = {
    init: hosted ? async signal => {
      const fileIds = [];
      for (const a of input.attachments || []) if (a.base64) {
        const bytes = Buffer.from(a.base64, 'base64');
        if (!bytes.length || bytes.length > 32 * 1048576) throw fail('API_FILE_SIZE', 'API 원본 파일은 32MB 이하로 전달하세요.');
        // 그림은 실제 형식의 확장자로(BMP 는 보기용 PNG 로 바뀌어 온다)
        const ext = a.kind === 'image' ? imageInfo(bytes)?.ext : null;
        fileIds.push(await upload(bytes, ext ? `${String(a.name || 'input').replace(/.[A-Za-z0-9]{1,8}$/, '')}.${ext}` : a.name || (a.kind === 'pdf' ? 'input.pdf' : 'input.png'), signal));
      }
      if (fileIds.length) tools.find(t => t.type === 'code_interpreter').container.file_ids = fileIds;
    } : null,
    async send(signal) {
      fresh = [];
      let res;
      try { res = await ai._jsonRequest(`${ai.baseUrl}/responses`, {
        ...body, instructions: body.instructions + (tools.length && !fileOnly && !v2 ? toolRules(tools.map(t => t.name)) : ''), input: messages,
        // 한 응답에 도구 여럿(문단·표·그림을 한 번에) — 반복문이 받은 차례대로 하나씩 실행하고 결과를 모두 돌려준다(api-tool-loop).
        // 예전에는 false(응답마다 도구 하나)라 3쪽 절 쓰기가 24번 오갔다(2026-11-04 C2) — Claude·Gemini 연결은 처음부터 여럿
        ...(tools.length && !repairing ? { tools, parallel_tool_calls: true, include: ['reasoning.encrypted_content'] } : {}),
      }, { Authorization: `Bearer ${ai.key}` }, signal); }
      catch (e) { if (tools.length && !repairing && /HTTP (400|404|422)/.test(e.message)) throw fail('API_TOOLS_UNAVAILABLE', 'API 도구 요청이 거절됐습니다. 모델·게이트웨이의 도구 규격과 작업공간 지원을 확인하세요.'); throw e; }
      try {
      const output = res.output || [];
      const continuation = res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens';
      if (res.status && res.status !== 'completed' && !continuation) throw fail('API_INCOMPLETE', 'API 작업이 완료되지 않았습니다. 도구 지원·모델·사용 한도를 확인하세요.');
      if (continuation) {
        const text = output.filter(o => o.type === 'message').flatMap(o => o.content || []).filter(b => b.type === 'output_text').map(b => b.text).join('');
        partialText += text;
        // 완성되지 않은 도구 인수는 실행하지 않는다. 원 응답도 자료로 보존하여 완전한 호출을 다시 받는다.
        if (output.some(o => o.type === 'function_call')) messages.push({ role: 'user', content: `응답 길이 한도로 중단된 도구 응답(자료, 아직 실행하지 않음): ${JSON.stringify(output)}. 인수를 완성한 도구 호출을 다시 내고 남은 작업을 계속하세요.` });
        else {
          messages.push(...output);
          messages.push({ role: 'user', content: v2 ? V2_CONTINUE : text ? '응답 길이 한도로 끊겼습니다. 앞서 출력한 JSON의 정확한 다음 문자부터 이어 쓰세요. 처음부터 반복하거나 코드펜스를 넣지 마세요. 기존 도구 결과와 전체 목표를 보존하세요.' : '응답 길이 한도로 끊겼습니다. 보존된 대화와 도구 결과에서 이어서 전체 작업을 완료하세요.' });
        }
        return { calls: [], more: true, text: '', usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.input_tokens_details?.cached_tokens }, model: res.model };
      }
      // 단일 JSON 판단에서는 요청하지 않은 도구/파일 결과를 실행·저장하지 않는다.
      if (singleTurn && output.some(o => /_call$/.test(o.type || '') || (o.content || []).some(c => (c.annotations || []).some(a => a.type === 'container_file_citation')))) throw fail('API_UNEXPECTED_TOOL', '단일 판단 응답에 예기치 않은 도구 호출이 포함되었습니다.');
      const calls = output.filter(o => o.type === 'function_call');
      const fileRefs = output.filter(o => o.type === 'message').flatMap(o => o.content || []).flatMap(c => c.annotations || []).filter(a => a.type === 'container_file_citation');
      const images = output.filter(o => o.type === 'image_generation_call' && o.result);
      if (repairing && (calls.length || fileRefs.length || images.length)) throw fail('API_UNEXPECTED_TOOL', '최종 JSON 형식 수정 중 예기치 않은 도구 결과가 포함되었습니다.');
      for (const ref of fileRefs) {
        if (!id(ref.container_id) || !id(ref.file_id)) throw fail('API_FILE_INVALID', 'API 생성 파일 참조가 올바르지 않습니다.');
        const key = `${ref.container_id}/${ref.file_id}`;
        if (saved.has(key)) continue;
        if (!toolContext) throw fail('API_FILE_UNSUPPORTED', '생성 파일을 저장할 MCP 연결이 없습니다.');
        // provider가 준 임의 URL에는 인증 키를 보내지 않는다. 설정한 API 주소의 파일 경로만 요청한다.
        const response = await fetchImpl(`${ai.baseUrl}/containers/${ref.container_id}/files/${ref.file_id}/content`, { headers: { Authorization: `Bearer ${ai.key}` }, signal, redirect: 'error' });
        if (!response.ok) throw fail('API_FILE_DOWNLOAD', 'API 생성 파일을 받지 못했습니다. 게이트웨이의 컨테이너 파일 다운로드 지원을 확인하세요.');
        const bytes = await readBytes(response, signal);
        const file = await save(bytes, ref.filename || 'result.png', `api:${key}`, toolContext, signal);
        saved.add(key); fresh.push(file);
      }
      for (const img of images) {
        const key = img.id || crypto.createHash('sha256').update(img.result).digest('hex');
        if (saved.has(key)) continue;
        if (typeof img.result !== 'string' || img.result.length > 14000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(img.result)) throw fail('API_FILE_INVALID', 'API 이미지 결과가 올바르지 않습니다.');
        const bytes = Buffer.from(img.result, 'base64');
        const file = await save(bytes, 'result.png', `api:image:${key}`, toolContext, signal);
        saved.add(key); fresh.push(file);
      }
      // store:false에서도 추론·도구 호출 항목을 빠짐없이 다음 요청에 되돌린다.
      if (calls.length || fresh.length) messages.push(...output.map(replayItem));
      last = calls.length || fresh.length ? [] : output;
      const blocks = output.filter(o => o.type === 'message').flatMap(o => o.content || []);
      return {
        calls: calls.map(c => ({ id: id(c.call_id) ? c.call_id : '\u0000', name: c.name, args: typeof c.arguments === 'string' ? c.arguments : '' })), more: fresh.length > 0,
        refusal: blocks.some(b => b.type === 'refusal'), text: partialText + blocks.filter(b => b.type === 'output_text').map(b => b.text).join(''),
        usage: { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.input_tokens_details?.cached_tokens, cacheWrite: res.usage?.input_tokens_details?.cache_write_tokens }, model: res.model,
      };
      } catch (e) { throw responseFailure(e, { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.input_tokens_details?.cached_tokens, cacheWrite: res.usage?.input_tokens_details?.cache_write_tokens }, res.model); }
    },
    async output(executed, signal) {
      if (hosted) for (const image of (executed.content || []).filter(c => c.type === 'image')) {
        const bytes = Buffer.from(image.data, 'base64'); const info = validateImage(bytes);
        await upload(bytes, `attachment.${info.ext}`, signal);
        tools.find(t => t.type === 'code_interpreter').container.file_ids = [...uploaded];
      }
      return mcpOutput(executed);
    },
    failure: text => text,
    async repair(text) {
      repairing = true; partialText = '';
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: '직전 최종 응답이 지정된 JSON 스키마와 맞지 않아 완료되지 않았습니다. 도구를 다시 호출하지 말고 기존 실행 결과를 보존하여 최종 JSON 객체 하나만 반환하세요. 설명문·Markdown·코드블록은 넣지 마세요. 모든 필수 키(proposals, alternatives, comments, inserts, tables, summary, instructionSummary)를 포함하고 사용하지 않는 목록은 []로 쓰세요. 도구로 이미 저장한 결과는 다시 제출하지 마세요. 미완료 작업을 완료했다고 쓰거나 변경 불필요 사유로 바꾸지 마세요.' });
    },
    async reply(results) {
      for (const { call, output } of results) messages.push({ type: 'function_call_output', call_id: call.id, output });
      if (fresh.length) messages.push({ role: 'user', content: `실행기가 실제 생성 파일을 결과 첨부로 저장했습니다: ${JSON.stringify(fresh)}. ${fileOnly ? '문서 제안은 상위 실행기가 담당합니다. 저장된 attachment_id를 사용해 지정된 JSON 스키마의 파일 결과만 반환하세요.'
        : v2 ? "그림 파일은 이 attachment_id로 edit 의 {op:'figure', after|replace, attachment_id} 를 내 삽입·교체 제안을 남기고, 일이 끝나면 done 으로 요청을 끝내세요."
          : '그림 파일은 이 attachment_id로 propose_figure를 호출해 삽입·교체 제안을 남긴 뒤 최종 JSON을 반환하세요.'} 이 자료는 파일 저장 결과입니다.` });
    },
    // 새 연결: 도구 없이 끝난 차례(추론·글 항목 그대로)를 남기고 사용자 글 하나를 잇는다
    async nudge(text) {
      messages.push(...(last.length ? last.map(replayItem) : [{ role: 'assistant', content: '(응답 없음)' }]), { role: 'user', content: text });
      partialText = ''; last = [];
    },
    size: () => Buffer.byteLength(JSON.stringify(messages)),
    // 이번 실행기가 새로 올린 입력 사본만 정리한다. provider가 생성한 원본 결과 파일은 삭제하지 않는다.
    async close() { await Promise.allSettled([...uploaded].map(fileId => fetchImpl(`${ai.baseUrl}/files/${fileId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ai.key}` }, redirect: 'error', signal: AbortSignal.timeout(5000) }))); },
  };
  return runToolLoop(ai, input, adapter, { signal, toolContext, parse, singleTurn, requireResult: !singleTurn && !fileOnly });
}

async function readBytes(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw fail('API_FILE_SIZE', 'API 생성 파일은 10MB 이하로 전달하세요.');
  const parts = []; let size = 0;
  for await (const part of response.body) { signal.throwIfAborted(); size += part.length; if (size > MAX_BYTES) throw fail('API_FILE_SIZE', 'API 생성 파일은 10MB 이하로 전달하세요.'); parts.push(part); }
  return Buffer.concat(parts);
}
async function save(bytes, name, sourceFileId, context, signal) {
  if (!context || !bytes.length || bytes.length > MAX_BYTES) throw fail('API_FILE_INVALID', 'API 결과 파일을 저장할 수 없습니다.');
  const isImage = /\.(png|jpe?g|gif|bmp)$/i.test(name);
  if (isImage) validateImage(bytes);
  const file = await context.saveFile({ bytes, name, sourceFileId }, signal);
  return { attachment_id: file.aid, file_name: file.name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), image: isImage };
}
