// MCP stdio 브리지 명령줄 껍데기(docs/V3_SPEC.md §2.3) — 인자를 읽어 server/bridge.js 의 createBridge 를 StdioServerTransport 로 시작한다.
// Claude Desktop(로컬 MCP)·Claude Code·Cursor 처럼 로컬 프로세스를 띄우는 클라이언트가 교내 LAN 의 서버(/mcp)에 붙게 해 준다.
//   v0.2 그대로(도구만 중계): node server/mcp-stdio.js --url http://서버:8787/mcp --token <내 토큰> [--agent Claude]
//   개인 에이전트(Claude Code 채널): node server/mcp-stdio.js --channel --url http://서버:8787/mcp   (토큰은 환경 변수 HWPX_COWORK_TOKEN)
//   로컬 파일 도구: --files-dir <작업 폴더>(또는 HWPX_COWORK_FILES_DIR) — 첨부 원본 내려받기·결과 파일 올리기(그 폴더 안만)
//   연결 종류(2026-11-17 부터 기본 = 새 연결): 작업 도구 넷(task·read·edit·finish — server/mcp2.js, docs/MCP_REDESIGN_2026-11-16.md).
//     --tools core 는 작업 도구와 그림·스킬 파일만. 서버에 머리글 X-Hwpx-Mcp: 2 를 보낸다(옛 서버는 모르는 머리글이라 예전 도구로 답한다)
//   예전 연결: --v1(또는 --mcp 1, 주소 ?v=1) — 머리글 X-Hwpx-Mcp: 1. --lean(또는 주소 ?lean=1)은 예전 연결의 얇은 흐름 —
//     서버가 모델용 요약·영수증으로 답한다(start_request 가 요청 내용을 함께 주고 쓰기의 complete 로 완료 — docs/MCP_LEAN_FLOW_2026-11-10.md)
//   --v2(또는 --mcp 2)는 예전 인자 그대로 받는다(새 연결). 연결 종류 인자가 여럿이면 마지막 것(인자 읽기는 server/bridge.js parseBridgeArgs)
//   그 밖: --no-tools(알림만), 환경 변수 HWPX_COWORK_URL·HWPX_COWORK_TOKEN·HWPX_COWORK_AGENT
//   stdout 은 MCP 통로 — 안내·로그는 모두 stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, installShutdown, redactUrl, parseBridgeArgs, DEFAULT_URL } from './bridge.js';
import { createDebugStdioTransport } from './ai-debug.js';

const USAGE = `hwpx-cowork MCP stdio 브리지
  node server/mcp-stdio.js [--channel] [--v1 [--lean] | --v2 [--tools core|all]] [--url <MCP 주소>] [--token <토큰>] [--agent <이름>] [--no-tools]
    --url       서버 MCP 주소(기본 ${DEFAULT_URL}, 또는 HWPX_COWORK_URL)
    --token     내 토큰(또는 환경 변수 HWPX_COWORK_TOKEN — 이쪽을 권장: 명령줄은 다른 프로그램에 보일 수 있다)
    --agent     에이전트 이름(기본: MCP 클라이언트 이름, claude-code → Claude Code)
    --channel   Claude Code 채널 알림 켜기(웹 편집기에서 맡긴 AI 작업이 생기면 세션에 알림)
    (기본)      새 연결: 작업 도구 넷(task 맡기·read 읽기·edit 고치기·finish 끝내기). 요청 내용·읽기는 글과 주소만, 쓰기는 ops 를 한 번에
    --v1        예전 연결(start_request·propose_* 등 예전 도구). --mcp 1 과 같다. --v2·--mcp 2 는 새 연결(기본과 같다)
    --lean      예전 연결의 얇은 흐름: 요청 내용·도구 응답을 모델용으로 짧게 받는다(start_request 가 내용을 줌, 쓰기의 complete 로 완료) — --v2 가 없으면 예전 연결
    --tools     새 연결의 도구 범위: all(기본 — 사람이 정할 일·변경 요청·멀티에이전트 도구 포함) | core(작업 도구와 그림·스킬 파일만)
    --no-tools  도구는 중계하지 않고 알림만(--channel 과 함께)
    --files-dir 로컬 파일 도구를 켠다: 첨부 원본을 이 폴더(in/)로 내려받고, 이 폴더 안 결과 파일을 요청 결과 첨부로 올린다
                (또는 HWPX_COWORK_FILES_DIR)
  Claude Code: claude --dangerously-load-development-channels server:hwpx  (docs/AGENT_SETUP.md)
`;

const log = (msg) => { try { process.stderr.write(`[hwpx 브리지] ${msg}\n`); } catch { /* stderr 도 닫힘 */ } };
// 처리 안 된 rejection 으로 프로세스가 죽지 않게(Node 22+) — 기록만 하고 계속 돈다
process.on('unhandledRejection', (e) => log(`처리 안 된 오류: ${e?.message || e}`));

const opts = parseBridgeArgs(process.argv.slice(2), process.env);
if (opts.help) { process.stderr.write(USAGE); process.exit(0); }
// 연결 종류를 잘못 적었으면(--mcp 3 등) 기본으로 짐작해 붙지 않는다 — 지침과 도구가 어긋나지 않게
if (opts.bad.length) { log(opts.bad.join(' · ')); process.exit(2); }
if (opts.unknown.length) log(`모르는 인자는 무시합니다: ${opts.unknown.join(' ')}`);

let bridge;
try {
  bridge = await createBridge({ url: opts.url, token: opts.token, agent: opts.agent, channel: opts.channel, tools: opts.tools, filesDir: opts.filesDir, lean: opts.lean, surface: opts.surface, toolset: opts.toolset, log });
  if (opts.filesDir && opts.tools) log(`로컬 파일 도구 켬 — 작업 폴더 ${opts.filesDir}`);
} catch (e) {
  log(e.message);
  process.exit(2);
}
installShutdown(bridge, { log });
await bridge.start(createDebugStdioTransport(StdioServerTransport, { context: { route: opts.channel ? 'claude-channel-wire' : 'stdio-wire', session: bridge.session } }));
log(`시작 — ${redactUrl(opts.url)} · ${opts.tools ? '도구 중계' : '도구 없음'}${opts.channel ? ' + 알림(채널)' : ''} · ${bridge.surface === 'v2' ? '새 연결(v2)' : bridge.lean ? '예전 연결(얇은 흐름 lean)' : '예전 연결(v1)'}`);
