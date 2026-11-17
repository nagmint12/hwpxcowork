// MCP stdio 브리지 명령줄 껍데기(docs/V3_SPEC.md §2.3) — 인자를 읽어 server/bridge.js 의 createBridge 를 StdioServerTransport 로 시작한다.
// Claude Desktop(로컬 MCP)·Claude Code·Cursor 처럼 로컬 프로세스를 띄우는 클라이언트가 교내 LAN 의 서버(/mcp)에 붙게 해 준다.
//   v0.2 그대로(도구만 중계): node server/mcp-stdio.js --url http://서버:8787/mcp --token <내 토큰> [--agent Claude]
//   개인 에이전트(Claude Code 채널): node server/mcp-stdio.js --channel --url http://서버:8787/mcp   (토큰은 환경 변수 HWPX_COWORK_TOKEN)
//   로컬 파일 도구: --files-dir <작업 폴더>(또는 HWPX_COWORK_FILES_DIR) — 첨부 원본 내려받기·결과 파일 올리기(그 폴더 안만)
//   얇은 흐름: --lean(또는 주소 ?lean=1) — 서버가 모델용 요약·영수증으로 답한다(start_request 가 요청 내용을 함께 주고 쓰기의 complete 로 완료 —
//   docs/MCP_LEAN_FLOW_2026-11-10.md). 옛 서버에 붙으면 예전 꼴 그대로 온다
//   새 연결: --v2(또는 주소 ?v=2) — 작업 도구 넷(task·read·edit·finish — server/mcp2.js, docs/MCP_REDESIGN_2026-11-16.md). --tools core 는 작업 도구와 그림·스킬 파일만
//   그 밖: --no-tools(알림만), 환경 변수 HWPX_COWORK_URL·HWPX_COWORK_TOKEN·HWPX_COWORK_AGENT
//   stdout 은 MCP 통로 — 안내·로그는 모두 stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, installShutdown, redactUrl, DEFAULT_URL } from './bridge.js';
import { createDebugStdioTransport } from './ai-debug.js';

const USAGE = `hwpx-cowork MCP stdio 브리지
  node server/mcp-stdio.js [--channel] [--v2 [--tools core|all]] [--lean] [--url <MCP 주소>] [--token <토큰>] [--agent <이름>] [--no-tools]
    --url       서버 MCP 주소(기본 ${DEFAULT_URL}, 또는 HWPX_COWORK_URL)
    --token     내 토큰(또는 환경 변수 HWPX_COWORK_TOKEN — 이쪽을 권장: 명령줄은 다른 프로그램에 보일 수 있다)
    --agent     에이전트 이름(기본: MCP 클라이언트 이름, claude-code → Claude Code)
    --channel   Claude Code 채널 알림 켜기(웹 편집기에서 맡긴 AI 작업이 생기면 세션에 알림)
    --lean      얇은 흐름: 요청 내용·도구 응답을 모델용으로 짧게 받는다(start_request 가 내용을 함께 줌, 쓰기의 complete 로 완료)
    --v2        새 연결: 작업 도구 넷(task 맡기·read 읽기·edit 고치기·finish 끝내기). 요청 내용·읽기는 글과 주소만, 쓰기는 ops 를 한 번에
    --tools     새 연결의 도구 범위: all(기본 — 사람이 정할 일·변경 요청·멀티에이전트 도구 포함) | core(작업 도구와 그림·스킬 파일만)
    --no-tools  도구는 중계하지 않고 알림만(--channel 과 함께)
    --files-dir 로컬 파일 도구를 켠다: 첨부 원본을 이 폴더(in/)로 내려받고, 이 폴더 안 결과 파일을 요청 결과 첨부로 올린다
                (또는 HWPX_COWORK_FILES_DIR)
  Claude Code: claude --dangerously-load-development-channels server:hwpx  (docs/AGENT_SETUP.md)
`;

function parseArgs(argv, env) {
  const o = { url: null, token: null, agent: null, channel: false, tools: true, filesDir: null, lean: false, v2: false, toolset: null, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--url': o.url = val(); break;
      case '--token': o.token = val(); break;
      case '--agent': o.agent = val(); break;
      case '--channel': o.channel = true; break;
      case '--no-channel': o.channel = false; break;
      case '--no-tools': o.tools = false; break;
      case '--lean': o.lean = true; break;
      case '--no-lean': o.lean = false; break;
      case '--v2': o.v2 = true; break;
      case '--tools': o.toolset = val(); break;
      case '--files-dir': o.filesDir = val(); break;
      case '-h': case '--help': o.help = true; break;
      default: o.unknown.push(a);
    }
  }
  o.url = o.url || env.HWPX_COWORK_URL || DEFAULT_URL;
  o.token = o.token || env.HWPX_COWORK_TOKEN || null;
  o.agent = o.agent || env.HWPX_COWORK_AGENT || null;
  o.filesDir = o.filesDir || env.HWPX_COWORK_FILES_DIR || null;
  return o;
}

const log = (msg) => { try { process.stderr.write(`[hwpx 브리지] ${msg}\n`); } catch { /* stderr 도 닫힘 */ } };
// 처리 안 된 rejection 으로 프로세스가 죽지 않게(Node 22+) — 기록만 하고 계속 돈다
process.on('unhandledRejection', (e) => log(`처리 안 된 오류: ${e?.message || e}`));

const opts = parseArgs(process.argv.slice(2), process.env);
if (opts.help) { process.stderr.write(USAGE); process.exit(0); }
if (opts.unknown.length) log(`모르는 인자는 무시합니다: ${opts.unknown.join(' ')}`);

let bridge;
try {
  bridge = await createBridge({ url: opts.url, token: opts.token, agent: opts.agent, channel: opts.channel, tools: opts.tools, filesDir: opts.filesDir, lean: opts.lean, v2: opts.v2, toolset: opts.toolset, log });
  if (opts.filesDir && opts.tools) log(`로컬 파일 도구 켬 — 작업 폴더 ${opts.filesDir}`);
} catch (e) {
  log(e.message);
  process.exit(2);
}
installShutdown(bridge, { log });
await bridge.start(createDebugStdioTransport(StdioServerTransport, { context: { route: opts.channel ? 'claude-channel-wire' : 'stdio-wire', session: bridge.session } }));
log(`시작 — ${redactUrl(opts.url)} · ${opts.tools ? '도구 중계' : '도구 없음'}${opts.channel ? ' + 알림(채널)' : ''}${opts.v2 ? ' · 새 연결(v2)' : opts.lean ? ' · 얇은 흐름(lean)' : ''}`);
