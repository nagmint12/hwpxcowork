// 실제 모델·로그인 없이 Claude Code(claude -p)의 프로세스 경계를 흉내 내는 시험용 CLI(server/claude-cli-ai.js 시험).
// 진짜 claude 처럼 --mcp-config 의 stdio 서버를 자기 환경 변수를 물려 띄우고(2026-11-13 실제 claude 2.1.322 로 확인한 동작),
// stream-json 으로 init·assistant(tool_use)·result 줄을 낸다. 로그인 상태는 auth 파일 글('ready'·'logout')로 바꾼다.
import fs from 'node:fs/promises';
import path from 'node:path';

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
if (prompt.includes('<document_context>')) state.requestContext = JSON.parse(prompt.split('<document_context>')[1].split('</document_context>')[0]);
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
