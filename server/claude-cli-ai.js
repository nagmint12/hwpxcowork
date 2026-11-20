// 본인 Claude 구독 로그인으로 공식 Claude Code CLI(claude -p)를 실행하고, 배정된 요청을 MCP 도구로 직접 처리한다(2026-11-13).
// 채널 없이 실시간으로 처리하는 Claude Code 실행기 — Codex 실행기(server/codex-ai.js)와 같은 꼴이다:
//   실행기(server/worker.js)가 새 요청 알림·선점·임대 갱신을 맡고, 요청마다 claude -p 를 한 번 띄운다.
//   모델은 이 요청에 묶인 hwpx MCP(server/codex-mcp.js — 문서·요청·시도 고정, 본문 반영 도구 없음)로 읽고 제안하고 complete_request 로 끝낸다.
// 허용 범위(docs/SUBSCRIPTION_LOGIN_PLAN_2026-11-10.md §4.2): 수정하지 않은 공식 Claude Code 에 사용자가 자기 구독으로 로그인해
//   자기 요청만 처리한다 — 실행기는 로그인 정보·토큰을 읽거나 Anthropic 을 직접 부르지 않는다. claude -p 사용분은 구독 한도에서 나간다.
// 격리(2026-11-13 가짜 키·이 PC 의 401/400 서버로 확인 — 실제 모델 호출 없음):
//   --restricted  : 사용자·프로젝트·로컬 설정(훅·권한·MCP)과 사용자 CLAUDE.md 를 읽지 않고, 명령·코드 실행 도구와 웹 가져오기를 빼며,
//                   파일 도구를 작업 폴더 안에 가둔다. 구독 로그인(OAuth)은 그대로 쓴다.
//   --tools …     : 내장 도구는 파일 도구(Read·Write·Edit·Glob·Grep)만 — 명령 실행(Bash·PowerShell)·웹 검색 없음
//   --strict-mcp-config --mcp-config : 이 요청의 hwpx 브리지 하나만. 브리지는 claude 의 환경 변수(토큰·작업)를 물려받는다 — 토큰을 파일·명령줄에 쓰지 않는다
//   --permission-mode dontAsk + --allowedTools : 허용한 도구 밖은 묻지 않고 거절
// API 키로 돌지 않게: ANTHROPIC_* 환경 변수는 넘기지 않고, 'claude auth status' 가 Claude 구독 로그인(claude.ai·setup-token)일 때만 시작한다.
// 새 MCP 연결(2026-11-17 — mcp:'v2', 실행기 --mcp 2): Codex 실행기와 같이 실행기가 받은 요청 내용(brief)을 첫 입력에 싣고, 지침은 EDITOR_INSTRUCTIONS_V2,
//   브리지는 작업 도구 넷(task·read·edit·finish)과 그림·파일 도구만 중계한다(job.surface 'v2'). 기본(mcp 없음)은 예전 연결 그대로.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { runProcess, codexMcpPrompt } from './codex-ai.js';
import { validateCodexJob } from './codex-mcp.js';
import { withAiDebug, debugRecord, debugError, currentAiDebug } from './ai-debug.js';
import { isTaskSurface } from './tool-profiles.js';
import { EDITOR_INSTRUCTIONS, taskEditorInstructions, modelBriefText, V3_BRIEF_INTRO } from './editor-instructions.js';

const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
// server/worker.js 가 실행기를 멈추는 오류 코드(이름은 Codex 때 지었지만 뜻은 같다 — 설치·판·로그인·실행 실패).
// 멈추면 남은 대기 요청을 실패로 만들지 않고 보존한다.
const STOP = Object.freeze({ notFound: 'CODEX_NOT_FOUND', unsupported: 'CODEX_UNSUPPORTED', auth: 'CODEX_AUTH_REQUIRED', apiAuth: 'CODEX_API_AUTH', failed: 'CODEX_FAILED' });
/** claude --effort 가 받는 값(Claude Code 2.1.x) */
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** 요청·메모·연결 목록에 보이는 이름(웹은 'Claude Code' 로 줄여 보인다 — web/util.js agentEnvName) */
export const CLAUDE_AGENT_NAME = 'Claude Code (실행기)';
const FILE_TOOLS = 'Read,Write,Edit,Glob,Grep';
// 실행기에 꼭 필요한 옵션 — 없는 판이면 업데이트를 안내한다
const REQUIRED_FLAGS = ['--print', '--output-format', '--mcp-config', '--strict-mcp-config', '--restricted', '--tools', '--allowedTools', '--permission-mode', '--no-session-persistence', '--system-prompt', '--disable-slash-commands'];
const SUBSCRIPTION_AUTH = new Set(['claude.ai', 'oauth_token']);   // claude.ai = 구독 계정 로그인, oauth_token = claude setup-token(구독 전용 장기 토큰)
const ABORTED = () => fault('ABORTED', '개인 AI 요청이 취소되었습니다.');
// 이 실행에는 명령·코드 실행 도구가 없다 — Codex 공통 지시의 'Python 으로 파일' 대신 쓸 길
const CLAUDE_NOTE = `
이 실행(Claude Code 실행기)에는 명령·코드 실행 도구(Bash·PowerShell·Python)가 없습니다. 그림·차트·그래프는 propose_figure(svg)로 직접 그리고(그린 모습은 preview_figure로 확인), 결과 파일이 꼭 필요하면 Write 도구로 work/out/ 에 글 형식(SVG·CSV·Markdown 등)으로 쓴 뒤 upload_result_file로 올립니다. 파일 도구는 이 작업 폴더 안에서만 씁니다.`;
// 새 MCP 연결(v2 — 작업 도구 넷)의 같은 안내: 예전 도구 이름(propose_*)은 쓰지 않는다. 그림·차트·그래프는 edit 의 figure op(svg 로 직접 그린다 — 2026-11-18, 한/글 차트 개체 chart op 는 숨긴 op: server/mcp2/ops.js HIDDEN_OPS)
const CLAUDE_NOTE_V2 = '이 실행(Claude Code 실행기)에는 명령·코드 실행 도구(Bash·PowerShell·Python)가 없습니다. 그림·차트·그래프는 edit 의 figure op(svg 로 직접 그린다 — 그린 모습은 preview_figure 로 확인)로 만들고, 결과 파일이 꼭 필요하면 Write 도구로 work/out/ 에 글 형식(SVG·CSV·Markdown 등)으로 쓴 뒤 upload_result_file로 올립니다. 파일 도구는 이 작업 폴더 안에서만 씁니다.';

/**
 * 새 MCP 연결(job.surface 'v2' — server/mcp2.js)의 첫 입력. 일하는 방식은 모델 지침(EDITOR_INSTRUCTIONS_V2)과 도구 설명(edit 의 op 꼴 포함)에 있으므로
 * 여기는 배정 번호·요청 내용(brief — task 응답과 같다)·이 실행의 도구 한계만 싣는다. Codex 첫 입력(codexMcpPromptV2)과 같은 뜻이되,
 * Codex 코드 모드 안내(codexCodeModeHintV2 — exec·ALL_TOOLS)는 Claude Code 와 맞지 않아 싣지 않는다(Claude 는 MCP 도구를 도구 설명째 직접 부른다).
 * 자료 JSON 의 태그 문자는 escape 해 자료 안의 닫는 태그가 document_context 경계를 바꾸지 못하게 한다.
 */
export function claudeMcpPromptV2(job, brief) {
  return `hwpx MCP 도구로 배정된 작업 하나를 처리하세요. 문서=${job.docId} 요청=${job.requestId} 시도=${job.attempt}(도구의 doc_id·request_id·expected_attempt 에 이 값을 씁니다).
${brief?.surface === 'v3' ? V3_BRIEF_INTRO : '아래 document_context 는 이 요청의 내용입니다(task 응답과 같습니다 — task 를 다시 부르지 않아도 됩니다): 지시(instruction)·대상(target)·문서 얼개(map)·대상 주변 글(context)·할 일(todo).'}
받은 내용으로 충분하면 바로 edit 를 부르고, 더 볼 것이 있을 때만 read 로 필요한 범위만 읽습니다. 결과는 edit 의 ops 에 모아 내고(op 꼴은 edit 도구 설명, 자세한 인자는 read(view='guide', id='ops')), 일이 끝나는 호출에 done="공유 요약 1~2문장" 을 줍니다.
${CLAUDE_NOTE_V2} 최종 답변은 처리 사실 한 줄이면 됩니다.
${modelBriefText(brief)}`;
}

/** OS·로그인 저장소·네트워크에 필요한 값만 남긴다(ANTHROPIC_* 키·주소, 클라우드 제공자 설정, 바깥 Claude Code 세션 표시는 넘기지 않는다) */
export function claudeEnvironment(env = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|USERNAME|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_GIT_BASH_PATH|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|LANG|LC_ALL)$/i;
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.test(key) && typeof value === 'string'));
  clean.NO_COLOR = '1';
  clean.DISABLE_AUTOUPDATER = '1';   // 요청을 처리하는 도중 스스로 업데이트하지 않는다(업데이트는 사용자가 claude update)
  return clean;
}

/** claude -p 인자. 프롬프트는 stdin 으로 준다(명령줄에 문서·지시·토큰을 싣지 않는다). 여러 값을 받는 옵션 뒤에는 늘 다른 옵션이 온다 */
export function claudeArgs({ model, effort, mcpConfigFile, systemPrompt = EDITOR_INSTRUCTIONS } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--tools', FILE_TOOLS,
    '--strict-mcp-config', '--mcp-config', mcpConfigFile,
    '--permission-mode', 'dontAsk', '--allowedTools', `mcp__hwpx,${FILE_TOOLS}`,
    '--disable-slash-commands', '--no-session-persistence', '--system-prompt', systemPrompt];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Windows npm 의 claude.cmd 는 shell 로 실행하지 않고 같은 설치의 실행 파일(bin/claude.exe — 옛 판은 cli.js)을 바로 띄운다 */
export async function resolveClaudeCommand(command = 'claude', env = process.env) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\r\n\0]/.test(command)) throw fault(STOP.notFound, 'Claude Code 실행 파일 경로를 확인해 주세요.');
  const explicit = path.isAbsolute(command) || /[\\/]/.test(command);
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const home = env.USERPROFILE || env.HOME;
  // 공식 설치 프로그램(native)은 ~/.local/bin 에 둔다 — PATH 에 없어도 찾는다
  const folders = explicit ? [''] : [...envPath.split(path.delimiter).filter(Boolean), ...(home ? [path.join(home, '.local', 'bin')] : [])];
  const names = process.platform === 'win32' && !path.extname(command) ? [`${command}.exe`, `${command}.cmd`] : [command];
  for (const folder of folders) for (const name of names) {
    const file = path.resolve(folder, name);
    try { if (!(await fs.stat(file)).isFile()) continue; } catch { continue; }
    if (/\.cmd$/i.test(file)) {
      if (path.basename(file).toLowerCase() !== 'claude.cmd') continue;
      const packageDir = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
      const entries = [];
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.claude;
        if (manifest.name === '@anthropic-ai/claude-code' && typeof bin === 'string') {
          const entry = path.resolve(packageDir, bin);
          const relative = path.relative(packageDir, entry);
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) entries.push(entry);
        }
      } catch { /* 아래 고정 경로도 본다 */ }
      entries.push(path.join(packageDir, 'bin', 'claude.exe'), path.join(packageDir, 'cli.js'));
      for (const entry of entries) {
        try {
          if (!(await fs.stat(entry)).isFile()) continue;
          return /\.(c|m)?js$/i.test(entry) ? { file: process.execPath, args: [entry] } : { file: entry, args: [] };
        } catch { /* 다음 후보 */ }
      }
      continue;
    }
    if (/\.(bat|ps1)$/i.test(file)) continue;
    return { file, args: [] };
  }
  throw fault(STOP.notFound, 'Claude Code를 찾지 못했습니다. 설치한 뒤 claude auth login 으로 로그인하세요. 실행 파일은 --cli-command 로 지정할 수 있습니다.');
}

/** 'claude auth status --json' 결과 → 구독 로그인인가. 이메일·조직 같은 개인 정보는 돌려주지 않는다 */
export function claudeAuthState(status) {
  if (!status || status.loggedIn !== true) return { ready: false, code: STOP.auth, reason: 'claude auth login 으로 본인 Claude 계정(구독)에 로그인해 주세요.' };
  if (status.apiProvider && status.apiProvider !== 'firstParty') return { ready: false, code: STOP.apiAuth, authMode: String(status.apiProvider), reason: 'Bedrock·Vertex 같은 클라우드 연결은 이 실행기에서 쓰지 않습니다. Claude 구독 계정으로 로그인해 주세요.' };
  const method = String(status.authMethod || '');
  if (!SUBSCRIPTION_AUTH.has(method)) return { ready: false, code: STOP.apiAuth, authMode: method || null, reason: 'API 키(사용료 별도) 로그인 상태입니다. 이 실행기는 Claude 구독 로그인만 씁니다 — claude auth login 으로 Claude 계정에 로그인해 주세요.' };
  return { ready: true, authMode: method, subscription: typeof status.subscriptionType === 'string' ? status.subscriptionType : null };
}

/** 모델을 부르지 않는 준비 점검(설치·판·구독 로그인). 비밀 정보·원시 출력은 돌려주지 않는다 */
export async function checkClaudeCode({ command = 'claude', spawn = nodeSpawn, env = process.env, resolveCommand = resolveClaudeCommand, signal } = {}) {
  const state = { installed: false, authenticated: false, authMode: null, subscription: null, ready: false, version: null, effortOption: false, reason: '', code: null };
  try {
    const launch = await resolveCommand(command, env);
    const options = { spawn, env: claudeEnvironment(env), signal, outputLimit: 256 * 1024, timeoutMs: 30000 };
    const version = await runProcess(launch, ['--version'], options);
    if (version.code !== 0) throw fault(STOP.notFound, 'Claude Code 판을 확인하지 못했습니다.');
    state.installed = true;
    state.version = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(version.stdout + version.stderr)?.[1] || null;
    const help = await runProcess(launch, ['--help'], options);
    const text = help.stdout + help.stderr;
    if (help.code !== 0 || REQUIRED_FLAGS.some(flag => !text.includes(flag))) throw fault(STOP.unsupported, 'Claude Code를 업데이트해 주세요(claude update). 지금 판은 실행기에 필요한 격리 옵션(--restricted 등)을 지원하지 않습니다.');
    state.effortOption = text.includes('--effort');
    const auth = await runProcess(launch, ['auth', 'status', '--json'], options);
    let status = null; try { status = JSON.parse(auth.stdout); } catch { status = null; }
    const login = claudeAuthState(status);
    state.authMode = login.authMode || null;
    if (!login.ready) throw fault(login.code, login.reason);
    state.authenticated = true; state.subscription = login.subscription; state.ready = true;
  } catch (e) {
    if (e.code === 'ABORTED') throw e;
    state.code = e.code === 'CODEX_TIMEOUT' || e.code === 'CODEX_OUTPUT_LIMIT' ? STOP.failed : e.code || STOP.failed;
    state.reason = e.code?.startsWith?.('CODEX_') && /Codex/.test(e.message || '') ? 'Claude Code 준비 상태를 확인하지 못했습니다.' : e.message || 'Claude Code 준비 상태를 확인하지 못했습니다.';
  }
  return state;
}

/** stream-json 출력 → { init, result, usage }. 사용량은 CLI 가 알린 토큰과 확인한 모델 응답·도구 호출 수만 센다 */
export function parseClaudeStream(stdout = '') {
  let init = null; let result = null;
  const messages = new Map(); const tools = new Set();
  for (const line of String(stdout).split('\n')) {
    let event; try { event = JSON.parse(line); } catch (cause) { if (line.trim()) debugRecord('claude.stream.line.rejected', line, { validator: 'JSON.parse', error: debugError(cause) }); continue; }
    if (event?.type === 'system' && event.subtype === 'init') init = event;
    else if (event?.type === 'result') result = event;
    else if (event?.type === 'assistant' && event.message) {
      const id = event.message.id || `message-${messages.size}`;
      messages.set(id, event.message.usage || messages.get(id) || null);
      for (const block of Array.isArray(event.message.content) ? event.message.content : []) if (block?.type === 'tool_use') tools.add(block.id || `tool-${tools.size}`);
    }
  }
  const count = v => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const usage = { modelCalls: messages.size, toolCalls: tools.size };
  // 결과 줄의 usage 는 이번 실행 전체의 합 — 없으면 응답마다 받은 usage 를 더한다
  const totals = result?.usage ? [result.usage] : [...messages.values()].filter(Boolean);
  if (totals.length) {
    usage.input = 0; usage.output = 0; let cacheRead = 0; let cacheWrite = 0;
    for (const u of totals) { usage.input += count(u.input_tokens); usage.output += count(u.output_tokens); cacheRead += count(u.cache_read_input_tokens); cacheWrite += count(u.cache_creation_input_tokens); }
    if (cacheRead) usage.cacheRead = cacheRead;
    if (cacheWrite) usage.cacheWrite = cacheWrite;
  }
  return { init, result, usage };
}

export class ClaudeCodeProposer {
  constructor({ model, effort, command = 'claude', timeoutMs = null, mcp = null } = {}, dependencies = {}) {
    checkModel(model); checkEffort(effort);
    if (timeoutMs != null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) throw fault('CLAUDE_INPUT_INVALID', '응답 제한 시간은 양의 정수(ms)로 설정해 주세요.');
    this.model = model?.trim() || undefined; this.effort = effort || undefined; this.command = command || 'claude'; this.timeoutMs = timeoutMs;
    // 새 MCP 연결(--mcp 2 — server/mcp2.js, Codex 실행기와 같은 값): 실행기(server/worker.js)가 짧은 요청 내용(brief)을 받아 넘기고 Claude 는 작업 도구 넷으로 처리한다
    this.mcpSurface = isTaskSurface(mcp) ? mcp : ['2', '3'].includes(String(mcp)) ? `v${mcp}` : null;
    this.spawn = dependencies.spawn || nodeSpawn; this.env = dependencies.env || process.env;
    this.resolveCommand = dependencies.resolveCommand || resolveClaudeCommand;
    this.tempRoot = dependencies.tempRoot || os.tmpdir(); this.enabled = true;
    this.provider = 'claude-code'; this.agentName = CLAUDE_AGENT_NAME;
  }

  check({ signal } = {}) { return checkClaudeCode({ command: this.command, spawn: this.spawn, env: this.env, resolveCommand: this.resolveCommand, signal }); }

  // 웹의 연결별 모델·추론 강도(server/ai-run.js 'claude-code') — 실행기가 요청마다 바꿔 끼운다
  get runKind() { return 'claude-code'; }
  get runSettings() { return { model: this.model || null, effort: this.effort || null }; }
  setRunSettings({ model = null, effort = null } = {}) {
    checkModel(model); checkEffort(effort);
    this.model = model?.trim() || undefined; this.effort = effort || undefined;
  }

  async runMcp(job, { url, token, session, signal, requestContext, brief } = {}) {
    return withAiDebug({ context: { route: 'claude-cli', docId: job?.docId, requestId: job?.requestId, attempt: job?.attempt } },
      () => this._runMcpRecorded(job, { url, token, session, signal, requestContext, brief }));
  }

  async _runMcpRecorded(job, { url, token, session, signal, requestContext, brief } = {}) {
    validateCodexJob(job);
    if (job.type !== 'request') throw fault('CLAUDE_INPUT_INVALID', 'Claude Code 실행기는 일반 AI 요청만 처리합니다.');
    // 새 연결(job.surface 'v2'): 첫 입력은 실행기가 받은 요청 내용(brief) — 배정된 요청·시도와 같아야 한다(Codex 실행기와 같은 검사)
    const v2 = isTaskSurface(job.surface);
    if (v2 && (!brief || brief.doc_id !== job.docId || brief.request_id !== job.requestId || (brief.attempt ?? 1) !== job.attempt || brief.instruction_hidden || (job.surface === 'v3' && brief.surface !== 'v3'))) throw fault('CLAUDE_INPUT_INVALID', '요청 내용이 배정된 요청·시도와 일치하지 않습니다.');
    if (requestContext != null && (requestContext.docId !== job.docId || requestContext.rid !== job.requestId || (requestContext.attempt ?? 1) !== job.attempt || requestContext.instructionHidden)) throw fault('CLAUDE_INPUT_INVALID', '문서 문맥이 배정된 요청·시도와 일치하지 않습니다.');
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !/\/mcp\/?$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token || !/^[A-Za-z0-9_-]{1,64}$/.test(session || '')) throw fault('CLAUDE_INPUT_INVALID', '작업의 MCP 연결 정보를 확인하세요.');
    if (signal?.aborted) throw ABORTED();
    const checked = await this.check({ signal });
    if (!checked.ready) throw fault(checked.code || STOP.auth, checked.reason);
    if (this.effort && !checked.effortOption) throw fault(STOP.unsupported, 'Claude Code를 업데이트해 주세요(claude update). 지금 판은 추론 강도(--effort)를 지원하지 않습니다.');
    if (signal?.aborted) throw ABORTED();
    const base = await fs.realpath(this.tempRoot);
    const directory = await fs.mkdtemp(path.join(base, 'hwpx-claude-'));
    try {
      await fs.chmod(directory, 0o700);
      const work = path.join(directory, 'work');
      for (const sub of ['in', 'out', 'tmp']) await fs.mkdir(path.join(work, sub), { recursive: true });
      const temp = path.join(work, 'tmp');
      // MCP 설정에는 비밀이 없다 — 브리지는 claude 의 환경 변수(HWPX_COWORK_TOKEN·HWPX_CODEX_JOB)를 물려받는다
      const mcpConfigFile = path.join(directory, 'mcp.json');
      const bridge = fileURLToPath(new URL('./codex-mcp.js', import.meta.url));
      await fs.writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { hwpx: { type: 'stdio', command: process.execPath, args: [bridge] } } }), { encoding: 'utf8', mode: 0o600 });
      const launch = await this.resolveCommand(this.command, this.env);
      // 새 연결이면 지침도 새 연결용(작업 도구 넷 — 예전 도구 이름 없음). 브리지(server/codex-mcp.js)는 HWPX_CODEX_JOB 의 job.surface 'v2' 로 작업 도구 넷만 중계한다
      const args = claudeArgs({ model: this.model, effort: this.effort, mcpConfigFile, systemPrompt: v2 ? taskEditorInstructions(job.surface) : EDITOR_INSTRUCTIONS });
      const env = { ...claudeEnvironment(this.env), TEMP: temp, TMP: temp, TMPDIR: temp, HWPX_COWORK_DEBUG_DIR: currentAiDebug()?.directory, HWPX_COWORK_TOKEN: token,
        HWPX_CODEX_JOB: JSON.stringify({ job: { ...job, agentId: this.agentName }, url, session, filesDir: work }) };
      const prompt = v2 ? claudeMcpPromptV2(job, brief) : codexMcpPrompt(job, requestContext) + (job.workflow === 'content_format'
        ? '\n명령·코드 실행 도구는 없습니다. 그림은 edit_workspace의 figure(svg)·chart 동작으로 만듭니다. 별도 결과 파일은 Write로 work/out/에 쓴 뒤 upload_result_file로 저장한 첨부 id를 사용합니다.' : CLAUDE_NOTE);
      const metadata = (usage) => ({ usage, model: this.model || 'claude-code-default', effort: this.effort, execution: 'tool-agent' });
      let result;
      try { result = await runProcess(launch, args, { spawn: this.spawn, env, cwd: directory, input: prompt, signal, timeoutMs: this.timeoutMs }); }
      catch (e) {
        // runProcess 의 문구는 Codex 기준 — 코드는 그대로 두고(실행기 중지 판단) 글만 바꾼다. 중간 출력은 없으니 사용량은 '미확인'
        const message = e.code === 'ABORTED' ? '개인 AI 요청이 취소되었습니다.' : e.code === 'CODEX_TIMEOUT' ? '설정한 Claude Code 응답 제한 시간이 지났습니다.'
          : e.code === 'CODEX_OUTPUT_LIMIT' ? 'Claude Code 실행 기록이 메모리 보호 한도를 넘었습니다. 결과는 서버에서 확인해야 합니다.' : 'Claude Code를 시작하지 못했습니다.';
        throw Object.assign(e, { message }, metadata({ modelCallsUnknown: true, unknownModelTasks: 1 }));
      }
      const parsed = parseClaudeStream(result.stdout);
      debugRecord('claude.stream.parsed', parsed, { exitCode: result.code });
      const meta = { ...metadata(parsed.usage), ...(parsed.init?.model ? { model: String(parsed.init.model).slice(0, 200) } : {}) };
      if (signal?.aborted) throw Object.assign(ABORTED(), meta);
      const hwpx = (parsed.init?.mcp_servers || []).find(s => s?.name === 'hwpx');
      if (parsed.init && hwpx?.status !== 'connected') throw fault('CLAUDE_MCP_FAILED', 'Claude Code가 hwpx MCP 연결을 열지 못했습니다. 서버 주소·토큰을 확인해 주세요.', meta);
      if (result.code !== 0 || !parsed.result || parsed.result.is_error) {
        const said = String(parsed.result?.result || '');
        if (/not logged in|\/login|log ?in again|authenticat|oauth|credential/i.test(said)) throw fault(STOP.auth, 'Claude 로그인이 끊겼습니다. claude auth login 으로 다시 로그인해 주세요.', meta);
        if (/limit|한도/i.test(said)) throw fault(STOP.failed, 'Claude 사용 한도에 도달했습니다. 한도가 풀린 뒤 실행기를 다시 켜 주세요.', meta);
        throw fault(STOP.failed, 'Claude Code가 작업을 완료하지 못했습니다. 로그인·모델·사용 한도를 확인해 주세요.', meta);
      }
      return { directMcp: true, ...meta };
    } finally {
      // 만든 임시 폴더만 지운다. 실제 data/·config.json 에는 닿지 않는다
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('hwpx-claude-')) throw new Error('Claude Code 임시 폴더 정리 경로를 확인할 수 없습니다.');
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

function checkModel(model) {
  if (model != null && (typeof model !== 'string' || !model.trim() || model.trim().startsWith('-') || model.length > 200 || /[\r\n\0\s]/.test(model.trim()))) throw fault('CLAUDE_INPUT_INVALID', '모델 ID를 확인해 주세요(예: opus·sonnet 또는 claude-opus-5-5).');
}
function checkEffort(effort) {
  if (effort != null && !CLAUDE_EFFORTS.includes(effort)) throw fault('CLAUDE_INPUT_INVALID', `추론 강도는 ${CLAUDE_EFFORTS.join('·')} 중 하나입니다.`);
}
