// 채널 끝에서 끝까지 시험(docs/V3_SPEC.md §2.2·§2.3·§6.1) — 가짜 서버가 아니라 진짜 서버 + 진짜 브리지 프로세스.
//   서버: 시험 받침(tests/helpers/server.mjs) — 빈 포트, 서버 AI 끔, 임시 data·config(토큰도 새로).
//   브리지: node server/mcp-stdio.js --channel --url <base>/mcp --token <a 토큰> 을 SDK StdioClientTransport 로 띄운다
//          (Claude Code 가 하는 것처럼 — 클라이언트 이름 claude-code, 알림은 notifications/claude/channel).
//   1) 브리지가 붙으면 /api/agent/status 에 a 는 online(채널 세션 1개), b 는 offline
//   2) b 의 요청(route auto → 대기열)은 a 의 브리지에 오지 않음. a 가 REST 로 요청(route auto) → route 'agent'·delivery.session = 브리지 세션·
//      WS delivered(owner a) → 브리지가 notifications/claude/channel 을 꼭 한 번(meta·고정 문구, 지시 원문 없음, 시작 모음 5초 뒤)
//   3) 브리지 도구: get_request(<document_context>) → start_request → 선점(claim.session = SSE 세션 = MCP 머리글 세션)
//      → 다른 세션(MCP 머리글)의 start_request 는 CLAIMED → propose_change(request_id) → complete_request(summary)
//      → REST 로 done·handledBy·요약·제안 묶임 확인, WS working·done(owner a)
//   4) 끝까지 알림은 한 번(다시 알림 없음), stdin 을 닫으면 브리지가 스스로(코드 0) 끝나고 a 는 offline
// 진짜 서버(:8787)·config.json·data/ 는 건드리지 않는다(끝에 그대로인지 확인). 다시 돌리려면: node tests/channel_e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, uploadDoc, watchWs, fixture, root } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';

const BRIDGE_CLI = path.join(root, 'server', 'mcp-stdio.js');
const SECRET = 'E2E-지시-원문-7f3a';            // 알림(초인종)에 섞이면 안 되는 지시 원문
const SUMMARY = '둘째 문단 표현 하나를 다듬자고 제안함(시험)';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`FAIL: 시간 초과(${ms}ms) — ${what}`);
    await sleep(50);
  }
}

// 진짜 파일이 그대로인지(시험이 건드리지 않음)
const realCfg = path.join(root, 'config.json');
const stamp = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };
function dataListing() {
  const d = path.join(root, 'data', 'docs');
  try { return fs.readdirSync(d).sort().map((id) => `${id}:${stamp(path.join(d, id, 'meta.json'))}`).join('|'); } catch { return 'none'; }
}
const before = { cfg: stamp(realCfg), data: dataListing() };

/** 도구 결과 → { error: 'CODE'|null, text, json } (서버 도구는 오류를 '오류(CODE): …' + isError 로 돌려준다) */
function toolOut(res) {
  const text = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const error = res?.isError ? (/^오류\(([A-Z_]+)\)/.exec(text)?.[1] || 'ERR') : null;
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { error, text, json };
}

/** 서버 MCP 를 브리지 없이 직접(무상태 HTTP, JSON-RPC 한 번) — 다른 세션의 선점 시도용 */
async function mcpDirect(base, token, session, name, args) {
  const r = await fetch(`${base}/mcp?agent=${encodeURIComponent('다른 에이전트')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Hwpx-Agent-Session': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:'));
  const msg = JSON.parse(line ? line.slice(5) : raw);
  if (msg.error) throw new Error(`MCP ${name}: ${msg.error.message}`);
  return toolOut(msg.result);
}

let srv = null; let ws = null; let client = null; let child = null;
const out = { stderr: '', exit: null, exited: null };
const guard = setTimeout(() => {
  console.error('\nCHANNEL E2E FAILED: 전체 시간 초과(120초)');
  if (out.stderr) console.error(`--- 브리지 stderr ---\n${out.stderr.slice(-3000)}`);
  try { child?.kill(); } catch { /* 무시 */ }
  try { srv?.killNow(); } catch { /* 무시 */ }
  process.exit(1);
}, 120000);
guard.unref();

try {
  srv = await startServer({ ai: 'off' });
  const A = srv.api('a'); const B = srv.api('b');
  const nameA = srv.users.a.name;

  // 시험 문서: 도구 메모 문서를 평탄화한 것(s0/p1 = '둘째 문단입니다. 있던 낱말을 …')
  const flat = await (await HwpxDoc.load(fs.readFileSync(fixture('tool_memo_tracked.hwpx')))).flattened();
  const d = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await flat.save()), '채널 시험.hwpx');
  const docId = d.id;
  ws = watchWs(srv.base, srv.tokens.a, docId); await ws.ready;

  // ───────── 1. 브리지 띄우기 ─────────
  section('브리지 프로세스(--channel --url <base>/mcp --token <a>) → SSE 연결');
  // env 를 주지 않으면 SDK 는 허용 목록 환경 변수만 물려준다(밖의 HWPX_COWORK_TOKEN 등은 안 넘어감) — 토큰은 인자로만
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE_CLI, '--channel', '--url', `${srv.base}/mcp`, '--token', srv.tokens.a], stderr: 'pipe', cwd: root });
  transport.stderr?.on('data', (s) => { out.stderr += s; });
  const origStart = transport.start.bind(transport);
  transport.start = async () => {
    await origStart();
    // 시험용으로 SDK 내부 필드(_process)를 엿본다: 스스로 끝나는지(신호 없이 코드 0) 지켜보기
    child = transport._process;
    out.exited = new Promise((resolve) => child.once('exit', (code, signal) => { out.exit = { code, signal, at: Date.now() }; resolve(out.exit); }));
  };
  client = new Client({ name: 'claude-code', version: '2.1.999-e2e' });
  const notes = [];
  client.fallbackNotificationHandler = async (n) => { notes.push({ n, at: Date.now() }); };
  const channelNotes = () => notes.filter((x) => x.n.method === 'notifications/claude/channel');
  await client.connect(transport);
  const tInit = Date.now();   // client.connect 끝 = initialized 를 보낸 때(브리지 시작 모음의 기준)
  const caps = client.getServerCapabilities();
  ok(caps?.experimental?.['claude/channel'] && !('claude/channel/permission' in caps.experimental) && caps.tools, '능력: claude/channel(permission 없음) + 도구');
  const ins = client.getInstructions() || '';
  ok(ins.length <= 2048 && ins.includes('<channel source="hwpx"') && ins.includes(`사용자(${nameA})`), `instructions ${ins.length}자: 채널 안내 + 진짜 서버 안내(사용자 ${nameA})`);

  const st = await until(async () => { const s = await A('/api/agent/status'); return s.me.online ? s : null; }, 'a 의 에이전트 online(브리지 SSE 연결)', 10000);
  const sess = st.me.sessions[0];
  ok(st.me.sessions.length === 1 && sess.channel === true && sess.agent === 'Claude Code' && /^[A-Za-z0-9_-]{8,64}$/.test(sess.session), `a online: 채널 세션 1개(${sess.agent}, 세션 ${sess.session})`);
  ok((await B('/api/agent/status')).me.online === false, 'b 는 offline(브리지는 a 의 토큰으로만 붙음)');
  const tools = (await client.listTools()).tools.map((t) => t.name);
  ok(['get_request', 'start_request', 'complete_request', 'claim_next_request', 'propose_change'].every((n) => tools.includes(n)), `브리지 tools/list = 진짜 서버 도구 ${tools.length}개`);

  // ───────── 2. 요청 → 초인종 한 번 ─────────
  section('REST 요청(route auto) → route agent → notifications/claude/channel 꼭 한 번');
  const rb = await B(`/api/docs/${docId}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'auto' } });
  ok(rb.route === 'queue' && rb.request.delivery === null, `b 의 요청 #${rb.request.rid}: b 의 에이전트가 없고 서버 AI 꺼짐 → 대기열`);
  const ra = await A(`/api/docs/${docId}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: SECRET, target: { ref: 's0/p1' }, route: 'auto' } });
  const rid = ra.request.rid;
  ok(ra.route === 'agent' && ra.request.status === 'pending' && ra.request.routeWanted === 'auto' && ra.request.delivery?.session === sess.session && ra.request.delivery?.agent === 'Claude Code',
    `a 의 요청 #${rid}: route agent·pending·delivery.session = 브리지 SSE 세션`);
  const dv = await ws.waitFor((m) => m.type === 'request' && m.action === 'delivered' && m.rid === rid, 5000);
  ok(dv.owner === nameA && dv.agent === 'Claude Code', `WS request delivered(owner ${dv.owner}, agent ${dv.agent})`);

  await until(() => channelNotes().length >= 1, '채널 알림(초인종)', 15000);
  await sleep(1500);   // 더 오지 않는지(묶음 창·중복) 조금 더 본다
  const ch = channelNotes();
  ok(ch.length === 1, `채널 알림 정확히 1번(받은 알림 ${ch.length}개)`);
  const note = ch[0].n.params;
  ok(note.meta.event === 'ai_request' && note.meta.doc_id === docId && note.meta.request_id === String(rid) && note.meta.kind === 'instruct' && note.meta.attempt === '1' && note.meta.event_id === `${docId}_${rid}_1`,
    `meta: event ai_request · doc_id · request_id ${note.meta.request_id} · kind · event_id ${note.meta.event_id}`);
  ok(Object.entries(note.meta).every(([k, v]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && typeof v === 'string') && note.meta.doc_title === '채널 시험', 'meta 키는 [A-Za-z_][A-Za-z0-9_]*, 값은 모두 문자열, doc_title 정리됨');
  ok(note.content.includes(`#${rid}`) && note.content.includes('get_request') && !JSON.stringify(note).includes(SECRET), '알림 글: 고정 문구 + 번호, 지시 원문 없음');
  ok(!ch.some((x) => x.n.params.meta.request_id === String(rb.request.rid)), `b 의 요청 #${rb.request.rid} 은 a 의 브리지에 알림 없음`);
  ok(ch[0].at - tInit >= 4800, `시작 직후 알림은 브리지 시작 모음(5초) 뒤에 옴(${ch[0].at - tInit}ms)`);

  // ───────── 3. 브리지 도구로 처리 ─────────
  section('브리지 도구: get_request → start_request(선점) → 다른 세션 CLAIMED → propose_change → complete_request');
  const g = toolOut(await client.callTool({ name: 'get_request', arguments: { doc_id: docId, request_id: rid } }));
  ok(!g.error && g.json?.context?.startsWith('<document_context>') && g.json.context.trimEnd().endsWith('</document_context>') && g.text.includes(SECRET) && g.json.claim === null,
    'get_request: 문맥은 <document_context> 로 감쌈, 요청자 본인의 에이전트라 지시 원문 받음, 아직 선점 없음');
  const s1 = toolOut(await client.callTool({ name: 'start_request', arguments: { doc_id: docId, request_id: rid } }));
  ok(!s1.error && s1.json?.status === 'working' && s1.json.claim?.session === sess.session && s1.json.claim.agent === 'Claude Code' && s1.json.claim.by === nameA && !s1.json.claim.server,
    `start_request → working, claim.session = SSE 세션(MCP 머리글 X-Hwpx-Agent-Session 과 같은 값), agent Claude Code, by ${nameA}`);
  const wk = await ws.waitFor((m) => m.type === 'request' && m.action === 'working' && m.rid === rid, 5000);
  ok(wk.owner === nameA, 'WS request working(owner a)');
  const other = await mcpDirect(srv.base, srv.tokens.a, 'otherSession_e2e', 'start_request', { doc_id: docId, request_id: rid });
  ok(other.error === 'CLAIMED', `같은 사용자의 다른 세션이 start_request → ${other.error}`);
  const g2 = toolOut(await client.callTool({ name: 'get_request', arguments: { doc_id: docId, request_id: rid } }));
  ok(g2.json?.claim?.mine === true && g2.json.claim.expired === false && !('session' in g2.json.claim), 'get_request: claim.mine = true(이 세션), 세션 id 는 MCP 보기에 싣지 않음');
  const pc = toolOut(await client.callTool({ name: 'propose_change', arguments: { doc_id: docId, ref: 's0/p1', find: '있던 낱말', replace: '기존 낱말', reason: '시험 제안', request_id: rid } }));
  ok(!pc.error && Number.isInteger(pc.json?.pid) && pc.json.rid === rid && pc.json.by === `${nameA}(Claude Code)`, `propose_change(request_id) → 제안 #${pc.json?.pid}(${pc.json?.by})`);
  const done = toolOut(await client.callTool({ name: 'complete_request', arguments: { doc_id: docId, request_id: rid, summary: SUMMARY } }));
  ok(!done.error && done.json?.status === 'done', 'complete_request → done');
  const dn = await ws.waitFor((m) => m.type === 'request' && m.action === 'done' && m.rid === rid, 5000);
  ok(dn.owner === nameA, 'WS request done(owner a)');

  const view = await A(`/api/docs/${docId}/requests/${rid}`);
  ok(view.status === 'done' && view.handledBy === 'Claude Code' && view.doneBy === `${nameA}(Claude Code)` && view.summary === SUMMARY && view.summaryBy === 'ai',
    `REST: #${rid} done · handledBy ${view.handledBy} · doneBy ${view.doneBy} · 공유 요약 = 에이전트 요약`);
  ok(view.proposals.includes(pc.json.pid) && view.claim?.session === sess.session && view.route === 'agent', `REST: 제안 #${pc.json.pid} 이 요청에 묶임, claim 은 브리지 세션, route agent`);
  ok((await A(`/api/docs/${docId}/requests/${rb.request.rid}`)).status === 'pending', `b 의 요청 #${rb.request.rid} 은 손대지 않음(pending)`);
  const after = toolOut(await client.callTool({ name: 'propose_change', arguments: { doc_id: docId, ref: 's0/p1', find: '새 낱말', replace: '새로운 낱말', request_id: rid } }));
  ok(after.error === 'REQUEST_CLOSED', `완료한 요청에 request_id 를 단 제안 → ${after.error}`);

  // ───────── 4. 끝 ─────────
  section('끝: 알림은 처음 한 번뿐 · stdin 을 닫으면 브리지가 끝나고 a 는 offline');
  await sleep(1000);
  ok(channelNotes().length === 1, `처리하는 동안 더 온 채널 알림 없음(모두 ${channelNotes().length}개)`);
  const t0 = Date.now();
  child.stdin.end();
  const ex = await Promise.race([out.exited, sleep(8000).then(() => null)]);
  ok(ex && ex.code === 0 && ex.signal == null, `stdin 을 닫으면 ${ex ? ex.at - t0 : '8000+'}ms 만에 스스로 끝남(코드 ${ex?.code})`);
  await until(async () => (await A('/api/agent/status')).me.online === false, '브리지가 끝나면 a offline', 5000);
  ok(true, 'a offline(SSE 정리)');
  ok(!/처리 안 된 오류/.test(out.stderr) && /알림 연결됨/.test(out.stderr), '브리지 stderr: 알림 연결됨, 처리 안 된 오류 없음');
  ok(!out.stderr.includes(srv.tokens.a), '브리지 로그에 토큰이 찍히지 않음');

  await client.close().catch(() => {}); client = null;
  ws.close(); ws = null;
  await srv.stop(); srv = null;

  section('진짜 config.json·data/ 그대로');
  ok(stamp(realCfg) === before.cfg, `config.json 시각·크기 그대로(${before.cfg})`);
  ok(dataListing() === before.data, 'data/docs 목록·meta.json 시각 그대로');
  console.log(`\nCHANNEL E2E OK — ${passed}개 확인`);
} catch (e) {
  console.error('\nCHANNEL E2E FAILED:', e.stack || e.message);
  if (out.stderr) console.error(`--- 브리지 stderr(끝) ---\n${out.stderr.slice(-3000)}`);
  if (srv?.output) console.error(`--- 서버 ${srv.base} 출력(끝) ---\n${srv.output().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 무시 */ }
  if (client) await client.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { /* 무시 */ } }
  if (srv) await srv.stop().catch(() => {});
  clearTimeout(guard);
}
