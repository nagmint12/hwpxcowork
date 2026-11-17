// API 모델에도 MCP 도구를 그대로 준다(범위 = server/tool-profiles.js 의 api 프로필). 문서·요청·시도는 실행기가 고정하며 파일 바이트는 모델을 거치지 않는다.
// MCP 도구 정의(zod → JSON Schema)가 단일 출처 — 여기서는 고정할 값만 떼고 { name, description, parameters } 로 넘기며, 제공자 꼴은 각 어댑터가 씌운다.
import { TOOL_PROFILES, isWriteTool } from './tool-profiles.js';
import { modelToolResult } from './editor-instructions.js';
import { leanToolSchema, leanToolResult } from './lean.js';

const ALLOWED = new Set(TOOL_PROFILES.api);
// complete(쓰기 도구의 완료 요약 — lean 연결에만 있다)도 뗀다: API 실행은 실행기가 완료한다
const BOUND = ['doc_id', 'request_id', 'expected_attempt', 'image_base64', 'complete'];
const fault = (code, message) => Object.assign(new Error(message), { code });
// 도구 결과가 이 오류면 모델에 되돌리지 않고 실행을 멈춘다(취소·다시 요청·선점 잃음). 그 밖의 오류 글(틀린 find 등)은 모델이 보고 고친다
const STOP_CODES = new Set(['ATTEMPT_CHANGED', 'REQUEST_CLOSED', 'CLAIMED', 'CLAIM_REQUIRED', 'NOT_OWNER', 'EDIT_SOURCE_CHANGED']);
const errorCode = result => /오류\(([A-Z_]+)\)/.exec((result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'))?.[1];
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

// 새 연결(v2)의 끝내는 도구: edit 의 done(공유 요약) 또는 finish — 그 호출 뒤 요청이 완료·실패로 닫혔으면 실행이 끝난다(api-tool-loop)
const finishing = (name, args) => name === 'finish' || (name === 'edit' && args?.done != null && String(args.done).trim() !== '' && args.dry_run !== true);
const jsonOf = result => { try { return JSON.parse((result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')); } catch { return null; } };

/**
 * 실행기는 api 프로필 전체를 native 도구로 전달한다. 문서·요청·시도 바인딩과 실제 결과 기록을 담당한다.
 * surface 'v2'(새 MCP 연결 — server/mcp2.js): 도구는 TOOL_PROFILES.apiV2(read·edit·finish + 그림·스킬 파일). 결과는 서버가 edit 에서 바로 제안·메모로 저장하고
 * 모델이 edit 의 done·finish 로 요청을 끝낸다 — 그 호출 뒤 requestStatus()(요청 상태만 — { status })가 완료·실패면 finished 에 적는다(api-tool-loop 가 멈춘다).
 * 같은 쓰기 되풀이 막기(receipts)·written 은 예전 연결(최종 JSON 의 중복 빼기)에만 쓴다 — 새 연결의 edit 는 서버가 한 호출을 다 저장하거나 하나도 저장하지 않는다
 */
export async function createApiToolContext({ listTools, callTool, assertCurrent, uploadFile, docId, requestId, attempt, existingFigures = 0, profile = 'api', surface = null, requestStatus = null }) {
  const v2 = surface === 'v2';
  if (v2 && typeof requestStatus !== 'function') throw fault('API_TOOL_UNSUPPORTED', '새 연결에는 요청 상태 확인(requestStatus)이 필요합니다.');
  const allowed = v2 ? new Set(TOOL_PROFILES.apiV2) : profile === 'workspace' ? new Set(TOOL_PROFILES.workspace) : ALLOWED;
  const page = await listTools(), selected = (page.tools || page).filter(t => allowed.has(t.name));
  const tools = selected.map(t => {
    // 모델에 주는 스키마는 'null 허용' 가지·값 범위를 뺀다(server/lean.js — 받는 쪽 zod 검사는 그대로, 라운드마다 다시 보내는 글자 수를 줄인다)
    const parameters = leanToolSchema(structuredClone(t.inputSchema || {}));
    parameters.type = 'object'; parameters.properties ||= {};
    for (const key of BOUND) delete parameters.properties[key];
    parameters.required = (parameters.required || []).filter(k => !BOUND.includes(k));
    parameters.additionalProperties = false;
    return { name: t.name, description: t.description || '', parameters };
  });
  const names = new Set(tools.map(t => t.name)); const receipts = new Map(); const written = [], savedFiles = []; let figures = Math.max(0, Number(existingFigures) || 0), nativeCharts = 0, stageAdvanced = null, finished = null;
  return {
    tools,
    /** 'v2' = 새 MCP 연결(작업 도구) — 어댑터·반복문이 지침·끝 판정을 이것으로 고른다 */
    surface: v2 ? 'v2' : null,
    get savedFiles() { return savedFiles; },
    get figures() { return figures; },
    get nativeCharts() { return nativeCharts; },
    get stageAdvanced() { return stageAdvanced; },
    /** 새 연결: 모델의 edit(done)·finish 로 요청이 닫혔으면 { status: 'done'|'failed', tool } */
    get finished() { return finished; },
    /** 이번 실행에서 도구로 남긴 결과(최종 JSON 의 같은 결과를 빼는 데 씀 — withoutToolDuplicates) */
    get written() { return written; },
    async call(name, args, signal) {
      signal?.throwIfAborted();
      if (!names.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw fault('API_TOOL_SCOPE', '허용하지 않은 API 도구입니다.');
      for (const [key, value] of [['doc_id', docId], ['request_id', requestId], ['expected_attempt', attempt]]) {
        if (args[key] != null && String(args[key]) !== String(value)) throw fault('API_TOOL_SCOPE', '다른 문서·요청에는 API 도구를 사용할 수 없습니다.');
      }
      if ('image_base64' in args) throw fault('API_TOOL_SCOPE', '인코딩 문자열 대신 실제 파일이나 차트 자료를 전달하세요.');
      if (finished) throw fault('REQUEST_CLOSED', '이 요청은 이미 끝났습니다.');
      await assertCurrent(signal);
      signal?.throwIfAborted();
      // 같은 실행 안에서 같은 쓰기를 다시 부르면(모델의 재시도 등) 처음 영수증을 돌려준다 — 제안·메모·그림이 두 번 생기지 않게
      const write = isWriteTool(name), key = JSON.stringify([name, canonical(args)]);
      if (write && receipts.has(key)) return receipts.get(key);
      const tool = selected.find(t => t.name === name);
      const bound = { ...args, doc_id: docId };
      if (tool.inputSchema?.properties?.request_id) bound.request_id = requestId;
      if (tool.inputSchema?.properties?.expected_attempt) bound.expected_attempt = attempt;
      const result = await callTool(name, bound, signal);
      if (v2) {
        // 새 연결의 멈춤: 오류 글(isError)은 아래 공통 검사, edit 의 영수증 stopped(저장 중 취소·다시 요청·선점 바뀜 — server/mcp2/service.js agentEdit)는 여기서
        const stopped = name === 'edit' && !result.isError ? jsonOf(result)?.stopped : null;
        if (stopped && STOP_CODES.has(stopped)) throw fault(stopped, '요청이 취소·다시 요청되었거나 선점이 바뀌었습니다.');
        if (!result.isError && finishing(name, args)) {
          // 끝내는 호출 뒤에는 요청 상태를 직접 본다(영수증 꼴에 기대지 않는다): 완료·실패 = 끝, 취소 = 멈춤, 처리 중 = 완료가 막힘(영수증의 complete_note 를 모델이 보고 고친다)
          const state = await requestStatus(signal);
          if (state?.status === 'done' || state?.status === 'failed') finished = { status: state.status, tool: name };
          else if (state?.status === 'cancelled') throw fault('REQUEST_CLOSED', '요청이 취소되었습니다.');
        }
      }
      if (profile === 'workspace' && name === 'edit_workspace' && !result.isError) {
        const value = JSON.parse(result.content.find(c => c.type === 'text').text);
        if (value.stageCompleted) stageAdvanced = value;
      }
      if (result.isError && STOP_CODES.has(errorCode(result))) throw fault(errorCode(result), '요청이 취소·다시 요청되었거나 선점이 바뀌었습니다.');
      // 모델에는 영수증만(방금 보낸 글·서식의 되풀이와 이력을 뺀다 — 대화에 쌓이는 글을 줄인다). 같은 쓰기를 다시 부르면 같은 영수증
      const shown = leanToolResult(name, modelToolResult(name, result));
      if (write && !result.isError) { receipts.set(key, shown); written.push({ name, args }); if (name === 'propose_figure') figures++; if (name === 'propose_chart') nativeCharts++; }
      return shown;
    },
    async saveFile(file, signal) {
      signal?.throwIfAborted(); await assertCurrent(signal); signal?.throwIfAborted();
      const saved = await uploadFile(file, signal);
      if (saved?.aid) savedFiles.push({ aid: saved.aid, name: saved.name || file.name });
      return saved;
    },
  };
}

/**
 * 도구로 이미 남긴 결과를 최종 JSON 에서 뺀다(모델이 같은 결과를 두 통로로 내도 한 번만 들어가게).
 * 글 제안은 ref·find·replace, 서식은 ref·find, 문단 추가는 자리·글, 표는 자리·칸, 표 고치기는 표, 의견은 ref·글로 견준다. 여러 안·차례·그림은 도구를 불렀으면 뺀다
 */
export function withoutToolDuplicates(value, written = []) {
  if (!written?.length || !value || typeof value !== 'object') return value;
  const trim = s => String(s ?? '').trim();
  const keys = new Set(); const called = new Set(written.map(w => w.name));
  const add = (...key) => keys.add(JSON.stringify(key));
  for (const { name, args } of written) {
    if (name === 'propose_change' || name === 'propose_changes') {
      for (const p of name === 'propose_changes' ? args.proposals || [] : [args]) {
        if (p?.type === 'format') add('format', p.ref, p.find ?? ''); else add('replace', p?.ref, p?.find ?? '', p?.replace ?? '');
      }
    } else if (name === 'propose_format') add('format', args.ref, args.find ?? '');
    else if (name === 'propose_insert') add('insert', args.after_ref, trim(args.text));
    else if (name === 'propose_table') add('table', args.after_ref, args.rows);
    else if (name === 'propose_table_edit') add('table_edit', args.table);
    else if (name === 'add_memo' && args.ref) add('memo', args.ref, trim(args.text));
  }
  const keep = (list, key) => (Array.isArray(list) ? list : []).filter(item => !keys.has(JSON.stringify(key(item))));
  return {
    ...value,
    proposals: keep(value.proposals, p => ['replace', p.ref, p.find ?? '', p.replace ?? '']),
    formats: keep(value.formats, p => ['format', p.ref, p.find ?? '']),
    inserts: keep(value.inserts, p => ['insert', p.afterRef, trim(p.text)]),
    tables: keep(value.tables, p => ['table', p.afterRef, p.rows]),
    tableEdits: keep(value.tableEdits, p => ['table_edit', p.table]),
    comments: keep(value.comments, c => ['memo', c.ref, trim(c.text)]),
    ...(called.has('propose_alternatives') ? { alternatives: [] } : {}),
    ...(called.has('propose_toc_update') ? { tocUpdates: [] } : {}),
    ...(called.has('propose_figure') ? { figures: [] } : {}),
  };
}

/** MCP 결과 → OpenAI Responses function_call_output */
export function mcpOutput(result) {
  const content = (result.content || []).flatMap(c => c.type === 'text' ? [{ type: 'input_text', text: c.text }]
    : c.type === 'image' ? [{ type: 'input_image', image_url: `data:${c.mimeType};base64,${c.data}` }]
      : c.type === 'resource_link' ? [{ type: 'input_text', text: JSON.stringify({ name: c.name, uri: c.uri }) }] : []);
  return content.some(c => c.type === 'input_image') ? content : content.map(c => c.text).join('\n');
}

/** MCP 결과 → Claude tool_result content(그림은 Claude 가 받는 PNG·JPEG·GIF·WebP 만 — read_attachment 가 BMP 를 PNG 로 바꿔 준다) */
export function mcpClaudeContent(result) {
  const content = (result.content || []).flatMap(c => c.type === 'text' ? [{ type: 'text', text: c.text }]
    : c.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType || '') ? [{ type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }]
      : c.type === 'resource_link' ? [{ type: 'text', text: JSON.stringify({ name: c.name, uri: c.uri }) }] : []);
  return content.length ? content : [{ type: 'text', text: '(빈 결과)' }];
}
