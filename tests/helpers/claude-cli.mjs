// 실제 모델·로그인 없이 Claude Code(claude -p)의 프로세스 경계를 흉내 내는 시험용 CLI(server/claude-cli-ai.js 시험).
// 진짜 claude 처럼 --mcp-config 의 stdio 서버를 자기 환경 변수를 물려 띄우고(2026-11-13 실제 claude 2.1.322 로 확인한 동작),
// stream-json 으로 init·assistant(tool_use)·result 줄을 낸다. 로그인 상태는 auth 파일 글('ready'·'logout')로 바꾼다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function fakeClaude(base, { mode = 'inspect', auth = '-', receipt = path.join(base, 'claude-receipt.json'), model = 'claude-opus-5-5' } = {}) {
  const script = path.join(base, 'fake-claude.mjs');
  const client = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url).href;
  const stdio = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js', import.meta.url).href;
  await fs.writeFile(script, `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from ${JSON.stringify(client)};
import { StdioClientTransport } from ${JSON.stringify(stdio)};
const [mode, receipt, auth, ...args] = process.argv.slice(2);
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (args.includes('--version')) { console.log('2.1.999 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') {
  console.log(mode === 'old' ? '-p, --print --output-format --mcp-config --model'
    : '-p, --print --output-format --mcp-config --strict-mcp-config --restricted --tools --allowedTools, --allowed-tools --permission-mode --no-session-persistence --system-prompt --disable-slash-commands --effort --model');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedOut = mode === 'logout' || (auth !== '-' && fs.readFileSync(auth, 'utf8') !== 'ready');
  if (loggedOut) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })); process.exit(1); }
  if (mode === 'api') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })); process.exit(0); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'private-person@example.invalid', orgName: 'PRIVATE_ORG' }));
  process.exit(0);
}
if (!args.includes('-p')) { console.error('unexpected args'); process.exit(9); }
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const value = (flag) => args[args.indexOf(flag) + 1];
const mcp = JSON.parse(fs.readFileSync(value('--mcp-config'), 'utf8'));
const state = { pid: process.pid, args, prompt, cwd: process.cwd(), env: process.env, mcp, systemPrompt: value('--system-prompt') };
if (mode === 'v3') {
  state.requestContext = JSON.parse(prompt.split('<request_brief>')[1].split('</request_brief>')[0]);
  state.documentContext = prompt.split('<document_context>')[1].split('</document_context>')[0];
} else if (prompt.includes('<document_context>')) state.requestContext = JSON.parse(prompt.split('<document_context>')[1].split('</document_context>')[0]);
const failure = (e) => { state.error = e?.stack || String(e); fs.writeFileSync(receipt, JSON.stringify(state)); process.exit(2); };
process.on('uncaughtException', failure); process.on('unhandledRejection', failure);
fs.writeFileSync(receipt, JSON.stringify(state));
const server = mcp.mcpServers.hwpx;
const init = (status, tools = []) => say({ type: 'system', subtype: 'init', model: ${JSON.stringify(model)}, permissionMode: value('--permission-mode'), tools: ['Edit', 'Glob', 'Grep', 'Read', 'Write', ...tools.map((t) => 'mcp__hwpx__' + t)], mcp_servers: [{ name: 'hwpx', status }] });
if (mode === 'slow') { init('connected'); await new Promise((r) => setTimeout(r, 20000)); }
if (mode === 'fail') { init('connected'); console.error('private provider secret-token'); say({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 private-secret-token', usage: { input_tokens: 10, output_tokens: 0 } }); process.exit(1); }
if (mode === 'limit') { init('connected'); say({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1794600000' }); process.exit(1); }
if (mode === 'session-lost') { init('connected'); say({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }); process.exit(1); }
if (mode === 'mcp-down') { init('failed'); say({ type: 'result', subtype: 'success', is_error: false, result: '도구가 없어 처리하지 못했습니다', usage: { input_tokens: 5, output_tokens: 5 } }); process.exit(0); }
if (mode === 'workspace') {
 const c=new Client({name:'claude-workspace-test',version:'1'});const transport=new StdioClientTransport({command:server.command,args:server.args,env:process.env,stderr:'pipe'});transport.stderr?.on('data',()=>{});
 try {
  await c.connect(transport);const names=(await c.listTools()).tools.map(t=>t.name);assert.ok(names.includes('edit_workspace'));assert.ok(!names.includes('propose_changes'));init('connected',names);
  const w=state.requestContext.editWorkflow,stage=w.stage;
  const operations=stage==='content'?[{op:'replace',args:{ref:'s0/p1',find:'둘째',replace:'두 번째'}}]:[{op:'format',args:{refs:['s0/p1'],format:{char:{bold:true}}}}];
  const r=await c.callTool({name:'edit_workspace',arguments:{stage,revision:w.revision,operations,complete_stage:true,summary:stage+' completed'}});assert.ok(!r.isError,JSON.stringify(r));
  fs.appendFileSync(receipt+'.workspace.jsonl',JSON.stringify({pid:process.pid,cwd:process.cwd(),stage,prompt})+'\\n');
 } finally {await c.close();await transport.close()}
 say({type:'result',subtype:'success',is_error:false,result:'stage completed',usage:{input_tokens:200,output_tokens:20,cache_read_input_tokens:40}});process.exit(0);
}
if (mode === 'v2' || mode === 'v3') {
  // 새 MCP 연결은 brief를 받은 뒤 필요한 문서를 읽고 edit(done)으로 끝낸다.
  // 진짜 claude 의 stream-json 처럼 응답마다 assistant(tool_use·usage)와 user(tool_result) 줄을 낸다(scripts/agent-run-once.mjs 집계 예행연습용)
  const c = new Client({ name: 'claude-code-test', version: 'test' });
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: process.env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await c.connect(transport);
    state.tools = (await c.listTools()).tools.map((t) => t.name).sort();
    init('connected', state.tools);
    const brief = state.requestContext;
    assert.ok(brief && brief.request_id, '첫 입력에 요청 내용(brief)이 있어야 한다');
    let n = 0;
    const call = async (name, a = {}, { expectError = false } = {}) => {
      const id = 'toolu_' + (++n);
      say({ type: 'assistant', message: { id: 'msg_' + n, content: [{ type: 'tool_use', id, name: 'mcp__hwpx__' + name, input: a }], usage: { input_tokens: 10, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 200, output_tokens: 20 } } });
      const r = await c.callTool({ name, arguments: a });
      const text = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\\n');
      say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: !!r.isError }] } });
      if (expectError) { assert.ok(r.isError, name + ' 은 거절돼야 한다'); return null; }
      assert.ok(!r.isError, text);
      return text;
    };
    await call('read_document', {}, { expectError: true });   // 예전 도구는 새 연결에 없다
    assert.ok((await c.callTool({ name: 'edit', arguments: { doc_id: 'another-document', ops: [{ op: 'memo', at: 's0/p0', text: 'x' }] } })).isError, '다른 문서는 거절');
    if (mode === 'v3') state.documentRead = await call('read', { view: 'text' });
    else state.map = await call('read', { view: 'map' });
    const targetRef = mode === 'v3' ? 's0/p1' : brief.target?.ref;
    const ops = mode === 'v2' && String(brief.map || '').includes('⚠') ? [{ op: 'objects_to_body' }]
      : targetRef ? [{ op: 'replace', at: targetRef, whole: true, with: '자동 검토한 문장' }]
      : [{ op: 'memo', at: 's0/p0', text: 'Claude 새 연결 검토 의견입니다.' }];
    state.receipt = JSON.parse(await call('edit', { ops, done: 'Claude 새 연결로 처리했습니다.' }));
    if (mode === 'v3') assert.equal(state.receipt.completed, true, JSON.stringify(state.receipt));
    say({ type: 'assistant', message: { id: 'msg_end', content: [{ type: 'text', text: '처리했습니다.' }], usage: { input_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 8 } } });
    state.toolCount = n; fs.writeFileSync(receipt, JSON.stringify(state));
  } finally { await c.close(); }
  say({ type: 'result', subtype: 'success', is_error: false, result: '처리했습니다.', num_turns: 5, duration_ms: 4321, duration_api_ms: 3210, total_cost_usd: 0.0123,
    usage: { input_tokens: 35, cache_read_input_tokens: 10000, cache_creation_input_tokens: 600, output_tokens: 68 } });
  process.exit(0);
}
if (mode === 'mcp') {
  const c = new Client({ name: 'claude-code-test', version: 'test' });
  // 진짜 claude 처럼 설정의 env 없이 자기 환경 변수를 그대로 물려준다(토큰·작업은 환경 변수로만 전달된다)
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: process.env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await c.connect(transport);
    state.tools = (await c.listTools()).tools.map((t) => t.name);
    init('connected', state.tools);
    let n = 0;
    const call = async (name, a = {}) => {
      const id = 'toolu_' + (++n);
      say({ type: 'assistant', message: { id: 'msg_' + n, content: [{ type: 'tool_use', id, name: 'mcp__hwpx__' + name, input: a }], usage: { input_tokens: 100, output_tokens: 10 } } });
      const r = await c.callTool({ name, arguments: a });
      assert.ok(!r.isError, r.content?.[0]?.text);
      return JSON.parse(r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\\n'));
    };
    assert.ok(state.tools.includes('propose_changes')); assert.ok(state.tools.includes('upload_result_file'));
    assert.ok(!state.tools.includes('apply_proposal'), '본문 반영 도구는 없다');
    const r = await call('get_request'); state.request = r;
    assert.ok((await c.callTool({ name: 'get_request', arguments: { doc_id: 'another-document' } })).isError, '다른 문서는 거절');
    const find = r.targetText || r.target.text || '';
    await call('propose_changes', { proposals: [{ ref: r.target.ref, find, replace: find + ' 자동 검토', reason: '표현 보완' }] });
    await call('add_memo', { ref: r.target.ref, text: 'Claude 검토 의견입니다.' });
    await call('complete_request', { summary: '표현 보완안과 확인 의견을 남겼습니다.' });
    say({ type: 'assistant', message: { id: 'msg_end', content: [{ type: 'text', text: '완료했습니다.' }], usage: { input_tokens: 100, output_tokens: 10 } } });
    state.toolCount = n; fs.writeFileSync(receipt, JSON.stringify(state));
  } finally { await c.close(); }
  say({ type: 'result', subtype: 'success', is_error: false, result: '완료했습니다.', num_turns: 5, usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } });
  process.exit(0);
}
// inspect: 연결만 확인하고 끝
init('connected');
say({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__hwpx__get_request', input: {} }], usage: { input_tokens: 120, output_tokens: 12 } } });
say({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '…' }], usage: { input_tokens: 120, output_tokens: 12 } } });
say({ type: 'result', subtype: 'success', is_error: false, result: '확인했습니다.', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 40 } });
`, 'utf8');
  return { file: process.execPath, args: [script, mode, receipt, auth] };
}

/**
 * 같은 가짜 CLI 를 npm 설치 꼴(<dir>/claude.cmd + node_modules/@anthropic-ai/claude-code)로 둔다 → 그 claude.cmd 경로.
 * 실행 파일 경로만 받는 곳(scripts/ai-worker.mjs --cli-command · scripts/agent-run-once.mjs --cli-command)에서 모델 없이 예행연습할 때 쓴다.
 * server/claude-cli-ai.js resolveClaudeCommand 는 claude.cmd 를 shell 로 띄우지 않고 같은 설치의 cli.mjs 를 node 로 띄운다.
 */
export async function fakeClaudeInstall(dir, options = {}) {
  await fs.mkdir(dir, { recursive: true });
  const launch = await fakeClaude(dir, options);
  const [script, ...fixed] = launch.args;
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.999', bin: { claude: 'cli.mjs' } }));
  await fs.writeFile(path.join(pkg, 'cli.mjs'), `process.argv.splice(2, 0, ...${JSON.stringify(fixed)});\nawait import(${JSON.stringify(pathToFileURL(script).href)});\n`, 'utf8');
  const cmd = path.join(dir, 'claude.cmd');
  await fs.writeFile(cmd, '@echo off\r\nrem 시험용 가짜 claude — server/claude-cli-ai.js 는 이 파일을 실행하지 않고 같은 설치의 cli.mjs 를 띄운다\r\nexit /b 9\r\n', 'utf8');
  return cmd;
}
