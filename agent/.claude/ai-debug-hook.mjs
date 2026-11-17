// Claude 채널의 MCP 밖 마지막 답변과 원래 세션 기록도 보존한다. stdout에는 모델 지시를 추가하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { createAiDebug, debugError } from '../../server/ai-debug.js';

export function captureClaudeHook(bytes, { directory = process.env.HWPX_COWORK_DEBUG_DIR || path.resolve(import.meta.dirname, '../../logs/ai-debug') } = {}) {
  const trace = createAiDebug({ directory, context: { route: 'claude-channel-transcript' } });
  const original = trace.record('claude.hook.input', bytes);
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch (error) { trace.record('claude.hook.parse.error', debugError(error), { validator: 'JSON.parse', original }); throw error; }
  const args = input.tool_input || {};
  Object.assign(trace.context, { session: input.session_id, event: input.hook_event_name, docId: args.doc_id, requestId: args.request_id, attempt: args.expected_attempt });
  trace.record('claude.hook.context', { original });
  // Stop 때 최종 메시지가 transcript에 아직 없을 수 있어 hook의 last_assistant_message도 독립 보존한다.
  if (typeof input.last_assistant_message === 'string') trace.record('claude.last_assistant_message', input.last_assistant_message);
  for (const file of new Set([input.transcript_path, input.agent_transcript_path].filter(Boolean))) {
    try { trace.record('claude.transcript', fs.readFileSync(file), { source: file }); }
    catch (error) { trace.record('claude.transcript.unavailable', debugError(error), { source: file }); throw error; }
  }
  return trace.directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    captureClaudeHook(Buffer.concat(chunks));
  } catch (error) {
    process.stderr.write(`[hwpx AI debug] 원문 기록 실패: ${error.code || error.message}\n`);
    process.exitCode = 1;
  }
}
