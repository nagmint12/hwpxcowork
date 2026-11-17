// 내 PC 의 구독 AI(ChatGPT 로그인 Codex·Claude 로그인 Claude Code) 또는 API 키로 자동 처리한다. 중앙 config·토큰 파일은 읽거나 쓰지 않는다.
// 권하는 차례(2026-11-13): 구독 AI(codex·claude-code — 추가 비용 없음) → Google CLI → API 키(사용료 별도)
import { AiProposer, AI_GATEWAYS, AI_EFFORTS, apiBaseUrl } from '../server/ai.js';
import { CodexProposer, CODEX_EFFORTS } from '../server/codex-ai.js';
import { GoogleCliProposer } from '../server/google-cli-ai.js';
import { createApiWorker } from '../server/worker.js';
import { apiBaseFrom } from '../server/bridge.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Claude Code 실행기(server/claude-cli-ai.js)는 예전 실행기 ZIP(server/worker-package.js 목록)에 아직 없을 수 있다 —
// 없으면 claude-code 만 못 쓰고 다른 제공자는 그대로 돈다. 그 모듈 안의 다른 오류는 숨기지 않는다.
let claudeCli = null;
try { claudeCli = await import('../server/claude-cli-ai.js'); }
catch (e) { if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes('claude-cli-ai')) throw e; }
const CLAUDE_MISSING = '이 실행기 묶음에는 Claude Code 실행기(server/claude-cli-ai.js)가 없습니다. 최신 실행기를 받아 주세요.';

const HELP = `개인 AI 자동 처리 실행기
  [기본 — 구독, 추가 비용 없음]
  ChatGPT 구독(Codex): node scripts/ai-worker.mjs --provider codex [--model <모델 ID>] [--effort ${CODEX_EFFORTS.join('|')}]
  Claude 구독(Claude Code): node scripts/ai-worker.mjs --provider claude-code [--model opus|sonnet|<모델 ID>] [--effort ${(claudeCli?.CLAUDE_EFFORTS || ['low', 'medium', 'high', 'xhigh', 'max']).join('|')}]
    claude auth login 으로 본인 Claude 계정에 먼저 로그인(API 키 로그인은 거절). 채널 없이 요청마다 claude -p 를 한 번 띄웁니다.
    실행 파일: --cli-command <경로> 또는 HWPX_COWORK_CLAUDE_COMMAND. 이 실행에는 명령·코드 실행 도구가 없습니다(그림은 SVG·차트 도구).
    모델·추론 강도는 웹 문서함의 'AI 모델·추론 강도'에서 정하면 요청마다 그 값이 우선합니다(실행할 때 준 값은 기본값)
  [선택 — 구독 로그인]
  개인 Google CLI: node scripts/ai-worker.mjs --provider gemini-cli|antigravity [--model <모델 ID>]
    gemini 또는 agy로 먼저 로그인. --cli-command <실행 파일> 또는 HWPX_COWORK_GEMINI_COMMAND / HWPX_COWORK_ANTIGRAVITY_COMMAND
    Google CLI --check는 설치·연결 점검이며 로그인·모델 권한의 실제 유효성은 요청 시 확인합니다.
  [선택 — 사용료 별도]
  개인 API: node scripts/ai-worker.mjs --provider openai|anthropic|gemini --model <모델 ID>
  선택: --url <중앙 MCP 주소> (기본 HWPX_COWORK_URL 또는 http://localhost:8787/mcp)
  필수 환경 변수: HWPX_COWORK_TOKEN
  --check: 로그인·서버 연결·필수 도구만 확인하고 종료(요청 선점·모델 호출 없음)
  MCP 연결(모든 제공자): --mcp 2(기본) = 새 MCP 연결 — 작업 도구 넷(task·read·edit·finish, 짧은 요청 내용·한 번에 쓰기),
    --mcp 1 = 예전 연결(start_request·propose_* 등). 환경 변수 HWPX_COWORK_MCP 로도 정합니다(명령줄이 먼저). Google CLI 는 MCP 를 쓰지 않아 영향이 없습니다
  codex: Codex CLI 설치 후 codex login으로 본인 ChatGPT 계정 로그인. API 키는 사용하지 않음.
    선택: --codex-command <codex 실행 파일 경로> 또는 HWPX_COWORK_CODEX_COMMAND
  API 제공자는 해당 키 환경 변수도 필요:
    openai: OPENAI_API_KEY / anthropic: ANTHROPIC_API_KEY / gemini: GEMINI_API_KEY 또는 GOOGLE_API_KEY
  API 연결 방식(선택): --gateway direct|baze (기본 direct = 제공자에 직접, 또는 HWPX_COWORK_AI_GATEWAY)
    baze: API 경유 — 키는 API에서 만든 키 하나(BAZE_API_KEY, 제공자 키는 쓰지 않음). 모델 ID는 API 목록의 ID
    --base-url <주소> --key-env <키 환경 변수 이름>: OpenAI·Claude·Gemini 호환 게이트웨이 주소를 직접 지정
      (HWPX_COWORK_AI_BASE_URL). 그 주소로 보낼 키는 --key-env 로 밝힌 변수에서만 읽음
  추론 강도(선택): --effort ${AI_EFFORTS.join('|')} (HWPX_COWORK_AI_EFFORT, OpenAI·Claude 추론 모델만)
  API 작업 도구: --workspace mcp|hosted (기본 mcp — 세 API 모두 MCP 도구, hosted 는 OpenAI 호환 API 작업공간)
    mcp: 기존 MCP 그림 도구 사용. hosted: API Code Interpreter도 사용(게이트웨이 지원·사용료 확인).
    예: npm run worker -- --provider openai --gateway baze --model gpt-6.1-sol --effort medium
  검토 요청을 자동으로 받아 제안·확인 의견·요약을 돌려줍니다. 문서 반영은 편집기에서 결정합니다.
  실행기를 켜 둔 동안 새 요청을 자동 처리하며, 시작할 때 기존 대기 요청도 처리합니다.
  codex·claude-code는 ChatGPT·Claude 구독의 사용 한도와 조직 권한을 따르고, API 방식은 별도 API 비용이 발생합니다.
  ChatGPT 웹 채팅에 메시지를 게시하는 방식은 아닙니다. 결과는 HWPX에 표시됩니다.`;

export function parseWorkerArgs(argv, env = process.env) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') return { help: true };
    if (key === '--check') { options.check = true; continue; }
    if (!['--provider', '--model', '--url', '--codex-command', '--cli-command', '--gateway', '--base-url', '--key-env', '--effort', '--workspace', '--mcp'].includes(key)) throw new Error('지원 옵션은 --provider, --model, --url, --gateway, --base-url, --key-env, --effort, --workspace, --mcp, --codex-command, --cli-command, --check, --help 입니다');
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('옵션 뒤에 값이 필요합니다');
    options[key.slice(2)] = argv[++i];
  }
  // 'claude' 는 예전부터 Claude API(anthropic)를 뜻한다 — Claude 구독(Claude Code)은 claude-code(또는 claude-cli)
  const aliases = { claude: 'anthropic', chatgpt: 'openai', google: 'gemini', 'claude-cli': 'claude-code' };
  options.provider = aliases[options.provider || env.HWPX_COWORK_AI_PROVIDER] || options.provider || env.HWPX_COWORK_AI_PROVIDER;
  if (!['codex', 'claude-code', 'gemini-cli', 'antigravity', 'openai', 'anthropic', 'gemini'].includes(options.provider)) throw new Error('--provider codex|claude-code|gemini-cli|antigravity|openai|anthropic|gemini 를 지정해 주세요');
  const googleCli = ['gemini-cli', 'antigravity'].includes(options.provider);
  const claudeCode = options.provider === 'claude-code';
  options.model ||= googleCli ? env[options.provider === 'gemini-cli' ? 'HWPX_COWORK_GEMINI_MODEL' : 'HWPX_COWORK_ANTIGRAVITY_MODEL'] : options.provider === 'codex' ? env.HWPX_COWORK_CODEX_MODEL : claudeCode ? env.HWPX_COWORK_CLAUDE_MODEL : env.HWPX_COWORK_AI_MODEL;
  if (options.model != null && !options.model.trim()) throw new Error('--model 값이 비어 있습니다');
  if (options.provider !== 'codex' && !claudeCode && !googleCli && !options.model?.trim()) throw new Error('--model 에 계정에서 사용할 모델 ID를 지정해 주세요');
  options.url ||= env.HWPX_COWORK_URL || 'http://localhost:8787/mcp';
  options.token = env.HWPX_COWORK_TOKEN;
  if (!options.token?.trim()) throw new Error('HWPX_COWORK_TOKEN 이 필요합니다');
  // 모델이 쓰는 MCP 연결(모든 제공자 — 2026-11-17 사용자 결정으로 기본 2): 2 = 새 연결(작업 도구 넷 task·read·edit·finish — server/mcp2.js,
  // docs/MCP_REDESIGN_2026-11-16.md), 1 = 예전 연결. 명령줄 --mcp 가 환경 변수 HWPX_COWORK_MCP 보다 먼저다.
  // 실행기 자신의 대기열 연결(server/worker.js)은 이 값과 상관없이 예전 연결(X-Hwpx-Mcp: 1)이다. Google CLI(gemini-cli·antigravity)는 MCP 를 쓰지 않아 받기만 한다
  options.mcp = String(options.mcp || env.HWPX_COWORK_MCP || '2').trim();
  if (!['1', '2'].includes(options.mcp)) throw new Error('--mcp 는 1(예전 연결) 또는 2(새 연결 — 작업 도구 넷)입니다');
  if (claudeCode) {
    // claude-code 는 본인 Claude 구독 로그인으로 공식 Claude Code(claude -p)를 부른다 — API 연결 방식은 없다(환경 변수의 API 설정도 넘기지 않음)
    if (!claudeCli) throw new Error(CLAUDE_MISSING);
    if (options.gateway || options['base-url'] || options['key-env'] || options.workspace || options['codex-command']) throw new Error('claude-code 는 본인 Claude 구독 로그인 전용이라 --gateway·--base-url·--key-env·--workspace·--codex-command 를 쓸 수 없습니다(실행 파일은 --cli-command)');
    options.command = options['cli-command'] || env.HWPX_COWORK_CLAUDE_COMMAND;
    delete options['cli-command'];
    options.effort = String(options.effort || env.HWPX_COWORK_AI_EFFORT || '').trim().toLowerCase() || null;
    if (options.effort && !claudeCli.CLAUDE_EFFORTS.includes(options.effort)) throw new Error(`--effort 는 ${claudeCli.CLAUDE_EFFORTS.join('|')} 중 하나입니다`);
    return options;
  }
  if (googleCli) {
    if (options.gateway || options['base-url'] || options['key-env'] || options.effort || options.workspace || options['codex-command']) throw new Error('Google CLI에는 --cli-command를 사용하세요. API·추론 강도·작업공간 옵션은 지원하지 않습니다.');
    options.command = options['cli-command'] || env[options.provider === 'gemini-cli' ? 'HWPX_COWORK_GEMINI_COMMAND' : 'HWPX_COWORK_ANTIGRAVITY_COMMAND'];
    delete options['cli-command'];
    return options;
  }
  if (options['cli-command']) throw new Error('--cli-command는 claude-code·gemini-cli·antigravity에서만 사용합니다.');
  options.command = options['codex-command'] || env.HWPX_COWORK_CODEX_COMMAND;
  delete options['codex-command'];
  if (options.provider === 'codex') {
    // codex 는 본인 ChatGPT 로그인으로 Codex CLI 를 부른다 — API 연결 방식은 없다(환경 변수의 API 설정은 무시)
    if (options.gateway || options['base-url'] || options['key-env'] || options.workspace) throw new Error('codex 는 본인 ChatGPT 로그인 전용이라 --gateway·--base-url·--key-env·--workspace 를 쓸 수 없습니다(API 키 방식에서 쓰세요)');
    // 추론 강도: --effort > HWPX_COWORK_AI_EFFORT(웹의 'AI 모델·추론 강도'에서 정하면 요청마다 그 값이 우선)
    options.effort = String(options.effort || env.HWPX_COWORK_AI_EFFORT || '').trim().toLowerCase() || null;
    if (options.effort && !CODEX_EFFORTS.includes(options.effort)) throw new Error(`--effort 는 ${CODEX_EFFORTS.join('|')} 중 하나입니다`);
    return options;
  }
  options.gateway = String(options.gateway || env.HWPX_COWORK_AI_GATEWAY || 'direct').trim().toLowerCase();
  options.workspace = options.workspace || env.HWPX_COWORK_AI_WORKSPACE || 'mcp';
  if (!['mcp', 'hosted'].includes(options.workspace) || (options.workspace === 'hosted' && options.provider !== 'openai')) throw new Error('--workspace hosted 는 OpenAI 호환 API에서만 사용할 수 있습니다(mcp|hosted).');
  if (!AI_GATEWAYS[options.gateway]) throw new Error(`--gateway 는 ${Object.keys(AI_GATEWAYS).join('|')} 중 하나입니다`);
  options.baseUrl = apiBaseUrl(options['base-url'] || env.HWPX_COWORK_AI_BASE_URL);
  const keyEnv = options['key-env'] || null;
  delete options['base-url']; delete options['key-env'];
  if (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw new Error('--key-env 에는 환경 변수 이름(예: MY_GATEWAY_KEY)을 적어 주세요');
  // 임의 주소는 어느 키를 보낼지 밝혀야 한다 — 환경에 있던 제공자 키가 남의 주소로 새지 않게
  if (options.baseUrl && !keyEnv) throw new Error('--base-url 을 쓰면 그 주소로 보낼 키의 환경 변수 이름을 --key-env 로 지정해 주세요');
  options.effort = String(options.effort || env.HWPX_COWORK_AI_EFFORT || '').trim().toLowerCase() || null;
  if (options.effort && !AI_EFFORTS.includes(options.effort)) throw new Error(`--effort 는 ${AI_EFFORTS.join('|')} 중 하나입니다`);
  // 게이트웨이(API 등)에는 그 게이트웨이 키만 보낸다 — 제공자 키를 다른 곳으로 보내지 않게
  const keyName = keyEnv || AI_GATEWAYS[options.gateway].keyEnv || { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' }[options.provider];
  options.key = env[keyName] || (options.provider === 'gemini' && options.gateway === 'direct' && !options.baseUrl ? env.GOOGLE_API_KEY : null);
  if (!options.key?.trim()) throw new Error(`${keyName} 환경 변수가 필요합니다`);
  return options;
}

export function createWorkerAi(options, env = process.env) {
  if (options.provider === 'claude-code') {
    if (!claudeCli) throw new Error(CLAUDE_MISSING);
    return new claudeCli.ClaudeCodeProposer({ model: options.model, effort: options.effort || undefined, command: options.command || undefined, mcp: options.mcp === '2' ? 'v2' : null }, { env });
  }
  if (['gemini-cli', 'antigravity'].includes(options.provider)) return new GoogleCliProposer({ provider: options.provider, model: options.model, command: options.command }, { env });
  return options.provider === 'codex'
    ? new CodexProposer({ model: options.model, effort: options.effort || undefined, command: options.command, mcp: options.mcp === '2' ? 'v2' : null }, { env })
    // API 제공자도 같은 --mcp 를 받는다(2026-11-17): ai.mcp 'v2' = 모델에게 새 연결 도구를, 'v1' = 예전 도구를 준다(그 쓰임은 server/ai.js normalizeMcp —
    // null 은 '정하지 않음'이라 --mcp 1 은 'v1' 로 밝혀 넘긴다. 이 값을 모르는 판은 보지 않고 예전 도구로 처리한다)
    : new AiProposer({ ai: { provider: options.provider, model: options.model, gateway: options.gateway, baseUrl: options.baseUrl, effort: options.effort, workspace: options.workspace, enabled: true, maxProposals: 10, mcp: options.mcp === '2' ? 'v2' : options.mcp === '1' ? 'v1' : null } }, { key: options.key });
}

/** 요청·메모에 남는 처리자 이름: 'OpenAI API', 'OpenAI API (게이트웨이)' */
export function workerAgentName(options) {
  if (options.provider === 'gemini-cli') return 'Gemini CLI';
  if (options.provider === 'antigravity') return 'Antigravity CLI';
  if (options.provider === 'codex') return 'ChatGPT (Codex)';
  if (options.provider === 'claude-code') return claudeCli?.CLAUDE_AGENT_NAME || 'Claude Code (실행기)';
  const name = `${{ openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini' }[options.provider]} API`;
  const via = options.baseUrl || options.gateway === 'baze' ? '게이트웨이' : AI_GATEWAYS[options.gateway]?.label;
  return via ? `${name} (${via})` : name;
}

/** 읽기 전용 사전 점검. 기존 작업을 선점하거나 AI를 호출하지 않는다. */
export async function checkWorkerConnection(worker, { fetchImpl = globalThis.fetch } = {}) {
  const required = ['claim_next_request', 'get_request', 'start_request', 'complete_request', 'fail_request', 'read_attachment', 'list_proposals', 'list_memos', 'propose_changes', 'propose_format', 'propose_alternatives', 'propose_insert', 'propose_table', 'add_memo'];
  if (worker.ai?.supportsTools) required.push('get_formatting', 'list_figures', 'export_figure', 'propose_figure');
  if (typeof worker.ai?.runMcp === 'function') required.push('read_document', 'get_formatting', 'get_writing_guide', 'read_skill_resource', 'export_skill_resource', 'get_page_layout', 'propose_page_layout', 'propose_table_edit', 'propose_toc_update', 'list_figures', 'export_figure', 'propose_figure');
  const response = await fetchImpl(`${apiBaseFrom(worker.url)}/api/me`, { headers: worker.headers(), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error('중앙 서버 주소와 본인 HWPX 토큰을 확인하세요.'), { code: 'PREFLIGHT_FAILED' });
  const user = await response.json();
  // 새 MCP 연결(--mcp 2)은 서버가 그 연결을 알아야 한다(/api/config features.mcp2)
  if (worker.ai?.mcpSurface === 'v2') {
    const config = await fetchImpl(`${apiBaseFrom(worker.url)}/api/config`, { redirect: 'error', signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // 2026-11-17 부터 --mcp 2 가 기본이라 옛 중앙 서버에서는 인자 없이 띄워도 여기서 멈춘다 — 예전 연결로 쓰는 길(--mcp 1)을 함께 알린다
    if (!config?.features?.mcp2) throw Object.assign(new Error('중앙 서버를 최신 버전으로 업데이트하세요. --mcp 2(새 MCP 연결 — 기본)를 지원하지 않는 서버입니다. 업데이트 전까지는 --mcp 1(예전 연결)로 실행하세요.'), { code: 'PREFLIGHT_FAILED' });
  }
  const client = await worker.connected();
  const tools = []; let cursor; const seen = new Set();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools); cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Object.assign(new Error('중앙 서버 도구 목록을 확인하지 못했습니다.'), { code: 'PREFLIGHT_FAILED' });
    if (cursor) seen.add(cursor);
  } while (cursor);
  const names = new Set(tools.map(tool => tool.name));
  if (required.some(name => !names.has(name))) throw Object.assign(new Error('중앙 서버를 최신 버전으로 업데이트하세요. 자동 처리에 필요한 도구가 없습니다.'), { code: 'PREFLIGHT_FAILED' });
  const guarded = ['start_request', 'complete_request', 'fail_request', 'propose_changes', 'propose_format', 'propose_alternatives', 'propose_insert', 'propose_table', 'add_memo'];
  if (guarded.some(name => !tools.find(tool => tool.name === name)?.inputSchema?.properties?.expected_attempt)) throw Object.assign(new Error('중앙 서버를 업데이트하세요. 취소·다시 요청을 구분하는 안전한 자동 처리 기능이 필요합니다.'), { code: 'PREFLIGHT_FAILED' });
  const rich = tools.find(tool => tool.name === 'propose_changes')?.inputSchema?.properties?.proposals?.items?.properties;
  if (!rich?.format || !rich?.runs || !rich?.type) throw Object.assign(new Error('중앙 서버를 업데이트하세요. 글자·문단 서식 제안을 보존하는 기능이 필요합니다.'), { code: 'PREFLIGHT_FAILED' });
  return { connected: true, user: user.name, toolsReady: true };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try { options = parseWorkerArgs(argv, env); }
  catch (e) { process.stderr.write(`${e.message}\n${HELP}\n`); process.exitCode = 1; return; }
  if (options.help) { process.stdout.write(`${HELP}\n`); return; }
  let worker;
  try {
    const ai = createWorkerAi(options, env);
    const auth = typeof ai.check === 'function' ? await ai.check() : { ready: true, authMode: 'api_key_configured', note: 'API 키의 실제 유효성은 모델 호출 시 확인됩니다.' };
    if (!auth.ready) throw Object.assign(new Error(auth.reason || (options.provider === 'claude-code' ? 'claude auth login으로 본인 Claude 계정에 로그인하세요.' : 'codex login으로 본인 ChatGPT 계정에 로그인하세요.')), { code: 'PREFLIGHT_FAILED' });
    worker = createApiWorker({ url: options.url, token: options.token, ai, agent: workerAgentName(options), clientName: ['codex', 'claude-code', 'gemini-cli', 'antigravity'].includes(options.provider) ? `hwpx-${options.provider}-worker` : 'hwpx-api-worker' });
    const connection = await checkWorkerConnection(worker);
    if (options.check) {
      process.stdout.write(`${JSON.stringify({ provider: options.provider, auth, ...connection, modelCalled: false, queueClaimed: false }, null, 2)}\n`);
      await worker.stop(); return;
    }
    process.stderr.write(`[hwpx 개인 AI] ${connection.user}의 요청을 처리합니다.\n`);
    worker.start();
    process.stderr.write('[hwpx 개인 AI] 자동 처리를 시작했습니다. 종료하려면 Ctrl+C를 누르세요.\n');
    const stop = async () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); await worker.stop(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) {
    await worker?.stop();
    process.stderr.write(`[hwpx 개인 AI] ${error.code === 'PREFLIGHT_FAILED' ? error.message : '실행하지 못했습니다. 중앙 주소·본인 토큰·로그인·모델 설정을 확인해 주세요.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
