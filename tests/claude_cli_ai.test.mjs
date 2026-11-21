// Claude Code 실행기(server/claude-cli-ai.js — 채널 없이 claude -p 로 요청마다 처리, 2026-11-13).
// 실제 Claude 로그인·모델 없이 가짜 CLI(tests/helpers/claude-cli.mjs)와 임시 서버로 프로세스 경계·격리·완료 기록을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeProposer, CLAUDE_AGENT_NAME, CLAUDE_EFFORTS, checkClaudeCode, claudeArgs, claudeAuthState, claudeEnvironment, parseClaudeStream, resolveClaudeCommand, claudeMcpPromptV2 } from '../server/claude-cli-ai.js';
import { EDITOR_INSTRUCTIONS, EDITOR_INSTRUCTIONS_V2 } from '../server/editor-instructions.js';
import { codexCodeModeHintV2 } from '../server/codex-ai.js';
import { createApiWorker } from '../server/worker.js';
import { parseWorkerArgs, createWorkerAi, workerAgentName, checkWorkerConnection } from '../scripts/ai-worker.mjs';
import { RUN_KINDS } from '../server/ai-run.js';
import { fakeClaude, fakeClaudeInstall } from './helpers/claude-cli.mjs';
import { startServer, uploadDoc, fixture } from './helpers/server.mjs';

const job = { type: 'request', docId: 'test-document', requestId: 7, attempt: 2 };
const connection = { url: 'http://localhost:8787/mcp', token: 'private-hwpx-token', session: 'owned-test-session' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'expected state not reached', timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch { /* 다시 */ } await sleep(20); }
  assert.fail(message);
}
async function setup(mode = 'inspect', extra = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-claude-test-'));
  const receipt = path.join(base, 'receipt.json');
  const launch = await fakeClaude(base, { mode, receipt, ...extra });
  return { base, receipt, launch, read: async () => JSON.parse(await fs.readFile(receipt, 'utf8')),
    dependencies: { tempRoot: base, env: { ...process.env, ANTHROPIC_API_KEY: 'private-api-key', ANTHROPIC_BASE_URL: 'https://private.invalid', CLAUDECODE: '1', NODE_OPTIONS: '--untrusted' }, resolveCommand: async () => launch },
    async close() { assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^hwpx-claude-test-/); await fs.rm(base, { recursive: true, force: true }); } };
}

test('claude -p 인자: 사용자 설정·명령 실행 도구를 빼고 이 요청의 hwpx MCP 만, 허용 밖은 묻지 않고 거절', () => {
  const args = claudeArgs({ model: 'sonnet', effort: 'high', mcpConfigFile: 'C:/job/mcp.json' });
  for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep', 'Bash·PowerShell·웹 도구 없음');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__hwpx,Read,Write,Edit,Glob,Grep');
  assert.equal(args[args.indexOf('--system-prompt') + 1], EDITOR_INSTRUCTIONS);
  assert.deepEqual(args.slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  // 여러 값을 받는 옵션(--tools·--mcp-config·--allowedTools) 뒤에는 값 하나와 곧바로 다른 옵션 — 프롬프트 자리 인자는 없다(stdin)
  for (const flag of ['--tools', '--mcp-config', '--allowedTools']) assert.match(args[args.indexOf(flag) + 2], /^--/, flag);
  assert.ok(!args.includes('--bare'), '--bare 는 구독 로그인(OAuth)을 읽지 않는다');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!claudeArgs({ mcpConfigFile: 'x' }).includes('--model'));
});

test('환경 정리: API 키·주소·바깥 세션 표시·NODE_OPTIONS·HWPX 토큰은 넘기지 않고 로그인 저장소는 남긴다', () => {
  const original = { Path: 'path', USERPROFILE: 'home', CLAUDE_CONFIG_DIR: 'login-location', CLAUDE_CODE_OAUTH_TOKEN: 'setup-token', 'ProgramFiles(x86)': 'pf86',
    ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://elsewhere', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', HWPX_COWORK_TOKEN: 'secret', NODE_OPTIONS: 'untrusted' };
  const clean = claudeEnvironment(original);
  for (const key of ['Path', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ProgramFiles(x86)']) assert.equal(clean[key], original[key], key);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'HWPX_COWORK_TOKEN', 'NODE_OPTIONS']) assert.equal(clean[key], undefined, key);
  assert.equal(clean.DISABLE_AUTOUPDATER, '1');
});

test('구독 로그인만: claude.ai·setup-token 은 받고 API 키·클라우드 제공자·로그아웃은 거절, 개인 정보는 돌려주지 않는다', () => {
  assert.deepEqual(claudeAuthState({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro', email: 'x@example.invalid' }), { ready: true, authMode: 'claude.ai', subscription: 'pro' });
  assert.equal(claudeAuthState({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }).ready, true);
  assert.equal(claudeAuthState({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }).code, 'CODEX_API_AUTH');
  assert.equal(claudeAuthState({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }).code, 'CODEX_API_AUTH');
  assert.equal(claudeAuthState({ loggedIn: false, authMethod: 'none' }).code, 'CODEX_AUTH_REQUIRED');
  assert.equal(claudeAuthState(null).code, 'CODEX_AUTH_REQUIRED');
});

test('요청 하나: 이 요청의 MCP 연결·작업 번호로 실행하고 토큰은 환경 변수로만, 사용량·실제 모델을 돌려주고 임시 폴더를 지운다', async () => {
  const x = await setup();
  try {
    const ai = new ClaudeCodeProposer({ model: 'sonnet', effort: 'high' }, x.dependencies);
    const checked = await ai.check();
    assert.equal(checked.ready, true); assert.equal(checked.authMode, 'claude.ai'); assert.equal(checked.subscription, 'max'); assert.equal(checked.version, '2.1.999');
    assert.ok(!JSON.stringify(checked).includes('private-person') && !JSON.stringify(checked).includes('PRIVATE_ORG'), '이메일·조직 이름은 돌려주지 않는다');
    assert.equal(typeof ai.run, 'undefined', 'JSON 결과 경로 없음 — MCP 직접 처리만');
    const result = await ai.runMcp(job, connection);
    assert.deepEqual(result.usage, { modelCalls: 1, toolCalls: 1, input: 200, output: 20, cacheRead: 40 });
    assert.equal(result.model, 'claude-opus-5-5', 'init 줄의 실제 모델');
    assert.equal(result.execution, 'tool-agent'); assert.equal(result.directMcp, true);
    const receipt = await x.read();
    assert.ok(receipt.args.includes('--restricted')); assert.equal(receipt.args[receipt.args.indexOf('--effort') + 1], 'high');
    assert.equal(receipt.systemPrompt, EDITOR_INSTRUCTIONS);
    assert.equal(receipt.env.HWPX_COWORK_TOKEN, connection.token);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'NODE_OPTIONS']) assert.equal(receipt.env[key], undefined, key);
    const taskTemp = path.join(receipt.cwd, 'work', 'tmp');
    for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(receipt.env[key], taskTemp);
    const bound = JSON.parse(receipt.env.HWPX_CODEX_JOB);
    assert.deepEqual(bound.job, { ...job, agentId: CLAUDE_AGENT_NAME });
    assert.equal(bound.url, connection.url); assert.equal(bound.session, connection.session); assert.equal(bound.filesDir, path.join(receipt.cwd, 'work'));
    // MCP 설정 파일·명령줄·프롬프트에는 토큰이 없다
    assert.deepEqual(Object.keys(receipt.mcp.mcpServers), ['hwpx']);
    assert.equal(receipt.mcp.mcpServers.hwpx.command, process.execPath); assert.match(receipt.mcp.mcpServers.hwpx.args[0], /codex-mcp\.js$/);
    assert.equal(receipt.mcp.mcpServers.hwpx.env, undefined);
    for (const text of [JSON.stringify(receipt.mcp), receipt.args.join(' '), receipt.prompt]) assert.ok(!text.includes(connection.token));
    assert.match(receipt.prompt, /get_request/); assert.match(receipt.prompt, /명령·코드 실행 도구/); assert.match(receipt.prompt, /propose_figure\(svg\)/);
    await assert.rejects(fs.stat(receipt.cwd), { code: 'ENOENT' });
  } finally { await x.close(); }
});

test('준비 점검: API 키 로그인·로그아웃·옛 판·없는 실행 파일을 모델 호출 전에 거절한다(실행기 중지 코드)', async () => {
  for (const [mode, code] of [['api', 'CODEX_API_AUTH'], ['logout', 'CODEX_AUTH_REQUIRED'], ['old', 'CODEX_UNSUPPORTED']]) {
    const x = await setup(mode);
    try {
      const ai = new ClaudeCodeProposer({}, x.dependencies);
      const state = await ai.check(); assert.equal(state.code, code, mode); assert.equal(state.ready, false);
      await assert.rejects(ai.runMcp(job, connection), { code });
      await assert.rejects(fs.stat(x.receipt), { code: 'ENOENT' }, `${mode}: claude -p 를 띄우지 않는다`);
    } finally { await x.close(); }
  }
  const missing = await checkClaudeCode({ command: path.join(os.tmpdir(), 'missing-claude-binary-never-exists.exe') });
  assert.equal(missing.code, 'CODEX_NOT_FOUND'); assert.match(missing.reason, /Claude Code/);
});

test('실패: 원시 오류를 드러내지 않고 사용 한도·로그인 끊김·MCP 연결 실패를 구분하며 임시 폴더를 정리한다', async () => {
  for (const [mode, code, says] of [['fail', 'CODEX_FAILED', /완료하지 못했습니다/], ['limit', 'CODEX_FAILED', /사용 한도/], ['session-lost', 'CODEX_AUTH_REQUIRED', /claude auth login/], ['mcp-down', 'CLAUDE_MCP_FAILED', /MCP 연결/]]) {
    const x = await setup(mode);
    try {
      await assert.rejects(new ClaudeCodeProposer({}, x.dependencies).runMcp(job, connection), (e) => {
        assert.equal(e.code, code, mode); assert.match(e.message, says);
        assert.ok(!e.message.includes('secret-token'), '제공자 오류 원문을 싣지 않는다');
        assert.equal(e.execution, 'tool-agent');
        return true;
      });
      await assert.rejects(fs.stat((await x.read()).cwd), { code: 'ENOENT' });
    } finally { await x.close(); }
  }
});

test('취소·제한 시간은 띄운 claude 프로세스를 끝내고 임시 폴더를 지운다', async () => {
  for (const timeout of [false, true]) {
    const x = await setup('slow');
    try {
      const controller = new AbortController();
      const pending = new ClaudeCodeProposer({ timeoutMs: timeout ? 1000 : 20000 }, x.dependencies).runMcp(job, { ...connection, signal: controller.signal });
      const rejected = assert.rejects(pending, { code: timeout ? 'CODEX_TIMEOUT' : 'ABORTED' });
      await until(async () => (await fs.stat(x.receipt)).isFile()); const receipt = await x.read();
      if (!timeout) controller.abort(); await rejected;
      await until(() => { try { process.kill(receipt.pid, 0); return false; } catch { return true; } }, 'claude 프로세스가 남아 있음');
      await assert.rejects(fs.stat(receipt.cwd), { code: 'ENOENT' });
    } finally { await x.close(); }
  }
});

test('범위·입력 검사: 협업 작업·다른 요청의 문맥·잘못된 주소·모델·추론 강도를 거절한다', async () => {
  const ai = new ClaudeCodeProposer({}, { resolveCommand: async () => assert.fail('실행하지 않아야 함') });
  await assert.rejects(ai.runMcp({ type: 'orchestration', docId: 'd', runId: 'r', taskId: 't', agentId: 'a', taskKind: 'work', leaseToken: 'l', attempt: 1 }, connection), { code: 'CLAUDE_INPUT_INVALID' });
  await assert.rejects(ai.runMcp(job, { ...connection, requestContext: { docId: job.docId, rid: job.requestId, attempt: 1 } }), { code: 'CLAUDE_INPUT_INVALID' });
  await assert.rejects(ai.runMcp(job, { ...connection, url: 'http://user:pw@localhost:8787/mcp' }), { code: 'CLAUDE_INPUT_INVALID' });
  assert.throws(() => new ClaudeCodeProposer({ model: '--dangerously-skip-permissions' }), { code: 'CLAUDE_INPUT_INVALID' });
  assert.throws(() => new ClaudeCodeProposer({ effort: 'ultra' }), { code: 'CLAUDE_INPUT_INVALID' });
  ai.setRunSettings({ model: 'opus', effort: 'max' }); assert.deepEqual(ai.runSettings, { model: 'opus', effort: 'max' });
  ai.setRunSettings({}); assert.deepEqual(ai.runSettings, { model: null, effort: null });
  assert.equal(ai.runKind, 'claude-code');
  assert.deepEqual(CLAUDE_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('stream-json 집계: 응답·도구 호출은 고유 id 로 세고, 결과 줄의 합계를 쓴다(없으면 응답마다 더함)', () => {
  const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n');
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1' }, { type: 'tool_use', id: 't2' }], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '…' }], usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't3' }], usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5 } } },
  ];
  const partial = parseClaudeStream(`not json\n${lines(events)}`);
  assert.equal(partial.init.model, 'claude-sonnet-5-5'); assert.equal(partial.result, null);
  assert.deepEqual(partial.usage, { modelCalls: 2, toolCalls: 3, input: 30, output: 5, cacheRead: 5 });
  const done = parseClaudeStream(lines([...events, { type: 'result', is_error: false, usage: { input_tokens: 31, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 } }]));
  assert.deepEqual(done.usage, { modelCalls: 2, toolCalls: 3, input: 31, output: 6, cacheRead: 7, cacheWrite: 9 });
  assert.deepEqual(parseClaudeStream('').usage, { modelCalls: 0, toolCalls: 0 }, '알리지 않은 토큰은 0 으로 꾸미지 않는다');
});

test('실행 파일 찾기: npm 의 claude.cmd 는 shell 없이 같은 설치의 실행 파일(bin/claude.exe·옛 cli.js)로', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-claude-resolve-'));
  try {
    const exe = path.join(base, 'native', 'claude-custom.exe'); await fs.mkdir(path.dirname(exe)); await fs.writeFile(exe, '');
    assert.deepEqual(await resolveClaudeCommand(exe, {}), { file: exe, args: [] }, '지정한 경로는 그대로');
    await assert.rejects(resolveClaudeCommand('claude', { PATH: path.join(base, 'empty') }), { code: 'CODEX_NOT_FOUND' });
    if (process.platform !== 'win32') { t.diagnostic('claude.cmd 풀이는 Windows 에서만'); return; }
    const npm = path.join(base, 'npm'); const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
    await fs.writeFile(path.join(npm, 'claude.cmd'), '@echo off\r\n');
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/claude.exe' } }));
    await fs.writeFile(path.join(pkg, 'bin', 'claude.exe'), '');
    assert.deepEqual(await resolveClaudeCommand('claude', { PATH: npm }), { file: path.join(pkg, 'bin', 'claude.exe'), args: [] });
    await fs.rm(path.join(pkg, 'bin'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
    await fs.writeFile(path.join(pkg, 'cli.js'), '');
    assert.deepEqual(await resolveClaudeCommand('claude', { PATH: npm }), { file: process.execPath, args: [path.join(pkg, 'cli.js')] });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('실행기 인자: --provider claude-code(별칭 claude-cli)는 구독 전용 — API 옵션 거절, claude 는 예전처럼 Claude API', () => {
  const env = { HWPX_COWORK_TOKEN: 'personal-token' };
  const o = parseWorkerArgs(['--provider', 'claude-code', '--model', 'opus', '--effort', 'HIGH', '--cli-command', 'C:/Tools/claude.exe'], env);
  assert.equal(o.provider, 'claude-code'); assert.equal(o.model, 'opus'); assert.equal(o.effort, 'high'); assert.equal(o.command, 'C:/Tools/claude.exe');
  assert.equal(o.key, undefined, 'API 키를 읽지 않는다');
  assert.equal(parseWorkerArgs(['--provider', 'claude-cli'], { ...env, HWPX_COWORK_CLAUDE_MODEL: 'sonnet', HWPX_COWORK_CLAUDE_COMMAND: 'claude2' }).model, 'sonnet');
  assert.equal(parseWorkerArgs(['--provider', 'claude-cli'], { ...env, HWPX_COWORK_CLAUDE_COMMAND: 'claude2' }).command, 'claude2');
  for (const extra of [['--gateway', 'baze'], ['--base-url', 'http://x'], ['--workspace', 'mcp'], ['--codex-command', 'codex']]) assert.throws(() => parseWorkerArgs(['--provider', 'claude-code', ...extra], env), /구독 로그인 전용/);
  assert.throws(() => parseWorkerArgs(['--provider', 'claude-code', '--effort', 'ultra'], env), /--effort/);
  assert.throws(() => parseWorkerArgs(['--provider', 'claude'], { ...env, ANTHROPIC_API_KEY: 'k' }), /--model/, "'claude' 는 여전히 Claude API(모델 필수)");
  assert.ok(createWorkerAi(o, env) instanceof ClaudeCodeProposer);
  assert.equal(workerAgentName(o), CLAUDE_AGENT_NAME);
  const kind = RUN_KINDS.find((k) => k.id === 'claude-code');
  // 2026-11-17: start-claude-worker.bat 을 지웠다(사용자 결정) — 켜는 곳은 Windows 앱 [AI → 실행기 관리…]·명령줄 npm run worker(server/ai-run.js RUN_KINDS[].start)
  assert.equal(kind.applies, 'request', '실행기는 요청마다 웹 설정을 읽는다'); assert.match(kind.start, /실행기 관리/); assert.match(kind.start, /npm run worker -- --provider claude-code/);
  assert.doesNotMatch(kind.start, /\.bat/, '지운 bat 을 안내하지 않는다'); assert.match(kind.launchNote, /start-agent\.bat/);
  assert.deepEqual(RUN_KINDS.map((k) => k.id).slice(0, 2), ['codex', 'claude-code'], '구독 AI 가 먼저');
});

test('웹 요청 → Claude Code 실행기(채널 없이) → MCP 결과 저장, 로그인이 끊기면 실행기를 멈추고 남은 대기열을 보존', { timeout: 40000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-claude-flow-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const paragraphs = await api(`${route}/paragraphs`);
    const target = paragraphs.find(p => p.ref === 's0/p1'); assert.ok(target?.text);
    const original = paragraphs.map(p => p.text);
    const auth = path.join(temp, 'fake-auth-state.txt'); await fs.writeFile(auth, 'ready');
    const receipt = path.join(temp, 'receipt.json');
    const launch = await fakeClaude(temp, { mode: 'mcp', auth, receipt, model: 'claude-sonnet-5-5' });
    const ai = new ClaudeCodeProposer({ model: 'sonnet' }, { tempRoot: temp, env: { ...process.env, HWPX_COWORK_TOKEN: 'outer-token-not-used' }, resolveCommand: async () => launch });
    worker = createApiWorker({ url: `${srv.base}/mcp`, token: srv.tokens.a, ai, agent: CLAUDE_AGENT_NAME, clientName: 'hwpx-claude-code-worker',
      // 점검 중에는 60초 폴링이 돌지 않는다. 첫 빈 대기열 확인이 끝난 뒤 새 요청 알림만으로 깨어나야 한다.
      timing: { pollMs: 60000, connectTimeoutMs: 3000, callTimeoutMs: 5000, backoffMs: 30, maxBackoffMs: 60, deadMs: 5000 }, log() {} });
    assert.equal((await checkWorkerConnection(worker)).toolsReady, true);
    worker.start();
    const online = await until(async () => { const s = await api('/api/automation/status'); return s.channels.online && s; }, '실행기가 연결되지 않음');
    assert.equal(online.automatic.method, 'channel'); assert.equal(online.channels.primary.agent, CLAUDE_AGENT_NAME); assert.equal(online.channels.primary.client, 'hwpx-claude-code-worker');
    await until(() => !worker.drainTask && !worker.wakeRequested, '시작 시 빈 대기열 확인이 끝나지 않음');
    const create = instruction => api(`${route}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: target.ref }, instruction, route: 'auto' } });
    const first = (await create('문장 표현을 검토해 주세요.')).request;
    assert.equal(first.route, 'agent', '자동 경로가 Claude Code 실행기로 전달');
    await until(() => worker.stats().completed === 1 || worker.stats().failed, 'Claude Code 결과가 돌아오지 않음', 20000);
    const state = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(worker.stats().failed, 0, state.error);
    const completed = await api(`${route}/requests/${first.rid}`);
    assert.equal(completed.status, 'done'); assert.equal(completed.summary, '표현 보완안과 확인 의견을 남겼습니다.');
    assert.equal(completed.execution, 'tool-agent'); assert.equal(completed.model, 'claude-sonnet-5-5');
    assert.equal(completed.usage.input, 300); assert.equal(completed.usage.output, 30); assert.equal(completed.usage.cacheRead, 1000); assert.equal(completed.usage.cacheWrite, 50);
    assert.equal(completed.usage.toolCalls, state.toolCount);
    const proposals = await api(`${route}/proposals`);
    assert.equal(proposals.length, 1); assert.equal(proposals[0].rid, first.rid); assert.equal(proposals[0].status, 'pending');
    assert.ok((await api(`${route}/memos`)).some(m => m.link?.rid === first.rid && m.body === 'Claude 검토 의견입니다.'));
    assert.deepEqual((await api(`${route}/paragraphs`)).map(p => p.text), original, '본문은 그대로 — 제안·의견만');
    assert.equal(state.env.HWPX_COWORK_TOKEN, srv.tokens.a, '이 요청의 토큰(바깥 환경의 값이 아님)');
    assert.equal(state.request.instruction, '문장 표현을 검토해 주세요.', '모델이 MCP 로 원문을 읽었다');
    await assert.rejects(fs.stat(state.cwd), { code: 'ENOENT' });
    // 로그인이 끊기면: 그 요청은 실패, 실행기는 멈추고 다음 요청은 대기열에 그대로
    await fs.writeFile(auth, 'logout');
    const failed = (await create('다음 요청입니다.')).request;
    const remaining = (await create('로그인 복구 뒤 처리할 요청입니다.')).request;
    await until(() => worker.stats().failed === 1 && worker.stopped && !worker.stats().active, '로그인 실패 뒤 실행기가 멈추지 않음', 15000);
    assert.equal((await api(`${route}/requests/${failed.rid}`)).status, 'failed');
    const pending = await api(`${route}/requests/${remaining.rid}`);
    assert.equal(pending.status, 'pending'); assert.equal(pending.claim, null);
    assert.equal((await api(`${route}/proposals`)).length, 1);
  } finally {
    await worker?.stop();
    await srv.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^hwpx-claude-flow-/);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

// 2026-11-17: Claude Code 실행기도 새 MCP 연결(v2 — 작업 도구 넷 task·read·edit·finish)로 돈다(--mcp 2 · HWPX_COWORK_MCP=2 · Windows 앱 실행기).
// 같은 날 Claude(예전 도구 48개)가 글상자 문서를 31분·51턴에 걸쳐 다시 친 일 — Codex v2 는 objects_to_body 한 번(1분 반)이었다.
const V2_TOOLS = ['download_attachment_file', 'edit', 'export_figure', 'export_skill_resource', 'finish', 'preview_figure', 'read', 'read_skill_resource', 'task', 'upload_result_file'];
const OLD_TOOL_NAMES = /\bpropose_[a-z_]+|get_request|complete_request|fail_request|read_document|claim_next_request|start_request|add_memo/;

test('새 연결(--mcp 2): 실행기 인자는 codex 와 같은 규칙, 기본은 TSV 연결(v3)·예전 연결은 --mcp 1', () => {
  const env = { HWPX_COWORK_TOKEN: 'personal-token' };
  const parsed = parseWorkerArgs(['--provider', 'claude-code'], env);
  assert.equal(parsed.mcp, '3', '기본 = TSV 연결');
  assert.equal(createWorkerAi(parsed, env).mcpSurface, 'v3');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-code', '--mcp', '2'], env), env).mcpSurface, 'v2');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-code', '--mcp', '1'], env), env).mcpSurface, null, '--mcp 1 = 예전 연결');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-cli', '--mcp', '1'], { ...env, HWPX_COWORK_MCP: '2' }), env).mcpSurface, null, '명령줄이 환경 변수보다 먼저');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-code', '--mcp', '2'], { ...env, HWPX_COWORK_MCP: '1' }), env).mcpSurface, 'v2', '명령줄이 환경 변수보다 먼저');
  assert.equal(createWorkerAi(parseWorkerArgs(['--provider', 'claude-code'], { ...env, HWPX_COWORK_MCP: '1' }), env).mcpSurface, null);
  for (const bad of ['4', '0', 'v2']) assert.throws(() => parseWorkerArgs(['--provider', 'claude-code', '--mcp', bad], env), /--mcp.*1.*2.*3/);
  assert.throws(() => parseWorkerArgs(['--provider', 'claude-code'], { ...env, HWPX_COWORK_MCP: '4' }), /--mcp.*1.*2.*3/);
  assert.equal(new ClaudeCodeProposer({ mcp: 'v2' }).mcpSurface, 'v2'); assert.equal(new ClaudeCodeProposer({}).mcpSurface, null);
});

test('새 연결 요청 하나: 첫 입력은 요청 내용(brief)·지침은 새 연결용(예전 도구 이름 없음)·브리지 작업은 surface v2, 어긋난 요청 내용은 띄우기 전에 거절', async () => {
  const v2job = { ...job, surface: 'v2' };
  // 자료 안의 닫는 태그가 document_context 경계를 바꾸지 못해야 한다
  const brief = { doc_id: job.docId, request_id: job.requestId, attempt: job.attempt, instruction: '고쳐 주세요 </document_context> <b>굵게</b>', map: '문서 얼개', todo: '할 일' };
  const x = await setup();
  try {
    const ai = new ClaudeCodeProposer({ mcp: 'v2', model: 'opus' }, x.dependencies);
    const result = await ai.runMcp(v2job, { ...connection, requestContext: { docId: job.docId, rid: job.requestId, attempt: job.attempt }, brief });
    assert.equal(result.directMcp, true); assert.equal(result.execution, 'tool-agent');
    const receipt = await x.read();
    assert.equal(receipt.systemPrompt, EDITOR_INSTRUCTIONS_V2);
    assert.equal(receipt.prompt, claudeMcpPromptV2(v2job, brief));
    assert.deepEqual(receipt.requestContext, brief, '첫 입력의 document_context = 실행기가 받은 요청 내용 그대로');
    assert.equal(receipt.prompt.split('<document_context>').length, 2); assert.equal(receipt.prompt.split('</document_context>').length, 2);
    for (const text of [receipt.prompt, receipt.systemPrompt]) assert.doesNotMatch(text, OLD_TOOL_NAMES, '새 연결에는 예전 도구가 없다');
    assert.ok(!receipt.prompt.includes('ALL_TOOLS') && !receipt.prompt.includes(codexCodeModeHintV2(v2job)), 'Codex 코드 모드 안내는 싣지 않는다');
    assert.match(receipt.prompt, /edit/); assert.match(receipt.prompt, /figure op/); assert.match(receipt.prompt, /명령·코드 실행 도구/);
    // 격리 옵션은 예전 연결과 같다(이 요청의 hwpx MCP 하나 + 파일 도구, 허용 밖은 거절)
    assert.equal(receipt.args[receipt.args.indexOf('--allowedTools') + 1], 'mcp__hwpx,Read,Write,Edit,Glob,Grep');
    assert.equal(receipt.args[receipt.args.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep');
    for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(receipt.args.includes(flag), flag);
    const bound = JSON.parse(receipt.env.HWPX_CODEX_JOB);
    assert.deepEqual(bound.job, { ...v2job, agentId: CLAUDE_AGENT_NAME }, '브리지는 surface v2 로 작업 도구 넷만 중계한다');
    assert.equal(receipt.env.HWPX_COWORK_TOKEN, connection.token);
    for (const text of [JSON.stringify(receipt.mcp), receipt.args.join(' '), receipt.prompt]) assert.ok(!text.includes(connection.token));
  } finally { await x.close(); }
  const guard = new ClaudeCodeProposer({ mcp: 'v2' }, { resolveCommand: async () => assert.fail('실행하지 않아야 함') });
  for (const bad of [undefined, { ...brief, request_id: 8 }, { ...brief, attempt: 1 }, { ...brief, doc_id: 'another-document' }, { ...brief, instruction_hidden: true }]) {
    await assert.rejects(guard.runMcp(v2job, { ...connection, brief: bad }), { code: 'CLAUDE_INPUT_INVALID' }, JSON.stringify(bad));
  }
});

test('새 연결 사전 점검: 서버가 새 연결을 모르면(features.mcp2 없음) 도구 목록을 보기 전에 멈춘다', async () => {
  const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/api/me') ? { name: '시험' } : { features: {} }) });
  const worker = { url: new URL('http://localhost:1/mcp'), headers: () => ({}), ai: new ClaudeCodeProposer({ mcp: 'v2' }), connected: async () => assert.fail('도구 목록까지 가지 않는다') };
  await assert.rejects(checkWorkerConnection(worker, { fetchImpl }), (e) => e.code === 'PREFLIGHT_FAILED' && /--mcp 2/.test(e.message));
});

test('웹 요청 → Claude Code 실행기(--mcp 2) → 작업 도구 넷으로 처리: 사전 점검·요청 내용·사용량·제안', { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-claude-v2-flow-'));
  const srv = await startServer({ ai: 'off' }); let worker;
  try {
    const api = srv.api('a');
    const doc = await uploadDoc(srv.base, srv.tokens.a, fixture('tool_memo_tracked.hwpx'));
    const route = `/api/docs/${doc.id}`;
    const original = (await api(`${route}/paragraphs`)).map(p => p.text);
    const receipt = path.join(temp, 'receipt.json');
    const launch = await fakeClaude(temp, { mode: 'v2', receipt, model: 'claude-sonnet-5-5' });
    const env = { HWPX_COWORK_TOKEN: srv.tokens.a };
    const options = parseWorkerArgs(['--provider', 'claude-code', '--mcp', '2', '--model', 'sonnet', '--url', `${srv.base}/mcp`], env);
    const ai = new ClaudeCodeProposer({ model: options.model, mcp: options.mcp === '2' ? 'v2' : null }, { tempRoot: temp, env: { ...process.env, HWPX_COWORK_TOKEN: 'outer-token-not-used' }, resolveCommand: async () => launch });
    worker = createApiWorker({ url: options.url, token: srv.tokens.a, ai, agent: workerAgentName(options), clientName: 'hwpx-claude-code-worker',
      timing: { pollMs: 80, connectTimeoutMs: 3000, callTimeoutMs: 15000, backoffMs: 30, maxBackoffMs: 60, deadMs: 5000 }, log() {} });
    assert.equal((await checkWorkerConnection(worker)).toolsReady, true, '서버가 새 연결을 안다(/api/config features.mcp2)');
    worker.start();
    const req = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'review', instruction: '문장 표현을 검토해 주세요.', target: { ref: 's0/p1' }, route: 'queue' } })).request;
    await until(() => worker.stats().completed + worker.stats().failed >= 1, 'Claude Code 결과가 돌아오지 않음', 40000);
    const sub = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(sub.error, undefined, sub.error);
    assert.equal(worker.stats().completed, 1);
    const done = await api(`${route}/requests/${req.rid}`);
    assert.deepEqual([done.status, done.summary, done.execution, done.model], ['done', 'Claude 새 연결로 처리했습니다.', 'tool-agent', 'claude-sonnet-5-5']);
    assert.deepEqual([done.usage.input, done.usage.cacheRead, done.usage.cacheWrite, done.usage.output, done.usage.toolCalls], [35, 10000, 600, 68, 3], '결과 줄의 합계·도구 호출 수');
    // Claude 가 본 것: 작업 도구 넷과 그림·파일 도구만, 새 연결 지침, 첫 입력의 요청 내용(brief)
    assert.deepEqual(sub.tools, V2_TOOLS);
    assert.equal(sub.systemPrompt, EDITOR_INSTRUCTIONS_V2);
    assert.deepEqual([sub.requestContext.doc_id, sub.requestContext.request_id, sub.requestContext.attempt], [doc.id, req.rid, 1]);
    assert.equal(sub.requestContext.instruction, '문장 표현을 검토해 주세요.');
    assert.equal(sub.receipt.completed, true);
    assert.equal(JSON.parse(sub.env.HWPX_CODEX_JOB).job.surface, 'v2');
    const proposals = (await api(`${route}/proposals`)).filter(p => p.rid === req.rid);
    assert.deepEqual(proposals.map(p => [p.type, p.ref, p.status]), [['replace', 's0/p1', 'pending']]);
    assert.deepEqual((await api(`${route}/paragraphs`)).map(p => p.text), original, '본문은 그대로 — 제안만');
    const activity = await api(`${route}/requests/${req.rid}/activity`);
    assert.deepEqual(activity.items.map((i) => i.label).filter((l) => !/조판 확인/.test(l)), ['요청을 맡음', '문서 얼개 확인', '수정 제안 · 완료', '완료']);
    await assert.rejects(fs.stat(sub.cwd), { code: 'ENOENT' });
  } finally {
    await worker?.stop();
    await srv.stop();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^hwpx-claude-v2-flow-/);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('가짜 claude 설치 꼴(claude.cmd + npm 패키지): 실행 파일 경로만으로 준비 점검이 돈다(agent-run-once --cli-command 예행연습용)', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpx-claude-install-'));
  try {
    const cmd = await fakeClaudeInstall(path.join(base, 'fake'), { mode: 'v2' });
    const resolved = await resolveClaudeCommand(cmd, {});
    assert.equal(resolved.file, process.execPath); assert.match(resolved.args[0], /cli\.mjs$/, 'claude.cmd 를 shell 로 띄우지 않는다');
    const state = await new ClaudeCodeProposer({ command: cmd }).check();
    assert.deepEqual([state.ready, state.version, state.authMode], [true, '2.1.999', 'claude.ai']);
  } finally {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); assert.match(path.basename(base), /^hwpx-claude-install-/);
    await fs.rm(base, { recursive: true, force: true });
  }
});

// 2026-11-17: start-claude-worker.bat·start-claude-worker-v2.bat 을 지웠다(사용자 결정 — Windows 앱 [AI → 실행기 관리]가 대신한다,
// 사본 backups/v2_default_gui_2026-11-17/). 그 bat 의 CRLF·인자 넘김을 보던 시험도 함께 지웠다. 앱이 Claude Code 실행기를
// --provider claude-code --mcp 2(또는 1)·토큰 환경 변수로 띄우는지는 tests/desktop_windows.test.mjs 가 본다.
