// 실제 에이전트(내 PC 의 Codex·Claude Code 구독 로그인)로 요청 한 건을 격리된 임시 서버에서 처리해 보고 호출·토큰·결과를 모은다.
//   node scripts/agent-run-once.mjs --doc <hwpx> --instruction "<지시>" --mcp 2 --yes-real-ai [--provider codex|claude-code] [--model <ID>] [--effort <강도>]
//        [--target document|<문단 주소>] [--out <결과 폴더>] [--apply] [--timeout-min 15] [--codex-command <codex 실행 파일>] [--cli-command <claude 실행 파일>]
// · 운영 서버(:8787)·data/·config.json 은 쓰지 않는다 — 임시 data·임시 토큰·빈 포트(tests/helpers/server.mjs)에 문서 사본을 올린다.
// · 실제 AI 를 부른다(구독 사용량이 든다) — 사용자가 실측을 요청했을 때만, --yes-real-ai 를 줘야 돈다. 모델 없는 비교는 scripts/measure-mcp2.mjs.
//   모델 없는 예행연습: --codex-command <가짜 codex> · --cli-command <가짜 claude>(tests/helpers/claude-cli.mjs fakeClaudeInstall 의 claude.cmd)
// · --provider codex(기본) = Codex 실행기, claude-code = Claude Code 실행기(server/claude-cli-ai.js — 요청마다 claude -p 한 번).
// · --mcp 1 = 예전 연결, 2 = 새 연결(작업 도구 넷 — docs/MCP_REDESIGN_2026-11-16.md). 같은 문서·지시로 둘을 견줄 수 있다.
// · --apply: 끝난 뒤 그 요청의 대기 제안을 차례로 반영하고 저장된 문서를 <out>/result.hwpx 로 받는다(임시 서버 안에서만).
// · 실행기는 이 실행만의 임시 폴더(TEMP)에서 Codex 를 띄운다 — 같은 날 돈 다른 Codex 대화 기록과 섞이지 않게 그 폴더 이름으로 이 실행의 기록만 고른다.
//   Claude Code 는 대화 기록을 남기지 않으므로(--no-session-persistence) 실행기 원본 기록(ai-debug 의 cli.stdout — claude stream-json)을 읽는다.
// 결과: <out>/result.json(요청 상태·요약·사용량·제안·진행 기록·응답별 토큰·모델이 부른 도구), worker.log, server.log,
//       ai-debug/(실행기 원본 기록), codex-rollout-*.jsonl(Codex 대화 기록 사본) 또는 claude-stream-*.jsonl(Claude stream-json 사본)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';
import { removeTree } from '../server/fs-safe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE = '사용: node scripts/agent-run-once.mjs --doc <hwpx> --instruction "<지시>" --mcp 1|2 --yes-real-ai [--provider codex|claude-code] [--model ID] [--effort 강도] [--target document|<주소>] [--out <폴더>] [--apply] [--timeout-min 15] [--codex-command <codex 실행 파일>] [--cli-command <claude 실행 파일>]\n실제 AI(구독 사용량)를 부르므로 --yes-real-ai 가 필요합니다.\n';

const docPath = opt('doc'); const instruction = opt('instruction');
if (!docPath || !instruction || !flag('yes-real-ai')) { process.stderr.write(USAGE); process.exit(2); }
const provider = opt('provider', 'codex'); const mcp = opt('mcp', '2'); const model = opt('model'); const effort = opt('effort');
// 새 연결(--mcp 2)은 Codex·Claude Code 실행기에만 있다 — 다른 제공자를 주면 조용히 예전 흐름으로 돌아 결과가 헷갈린다
if (!['codex', 'claude-code'].includes(provider)) { process.stderr.write(`--provider 는 codex 또는 claude-code 입니다(받은 값: ${provider}).\n`); process.exit(2); }
if (!['1', '2'].includes(mcp)) { process.stderr.write('--mcp 는 1(예전 연결) 또는 2(새 연결)입니다.\n'); process.exit(2); }
// 실행 파일 옵션이 제공자와 어긋나면 멈춘다 — 가짜 CLI 로 예행연습하려다 진짜 CLI(구독 사용량)를 부르지 않게
if (provider === 'codex' && flag('cli-command')) { process.stderr.write('--cli-command 는 --provider claude-code 용입니다(Codex 는 --codex-command).\n'); process.exit(2); }
if (provider === 'claude-code' && flag('codex-command')) { process.stderr.write('--codex-command 는 --provider codex 용입니다(Claude Code 는 --cli-command).\n'); process.exit(2); }
const target = opt('target', 'document'); const timeoutMs = Number(opt('timeout-min', '15')) * 60000;
const codexCommand = provider === 'codex' ? opt('codex-command', process.env.HWPX_COWORK_CODEX_COMMAND || null) : null;
const claudeCommand = provider === 'claude-code' ? opt('cli-command', process.env.HWPX_COWORK_CLAUDE_COMMAND || null) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(opt('out', path.join(root, 'artifacts', `agent-run-${stamp}`)));
fs.mkdirSync(out, { recursive: true });
const log = (line) => process.stderr.write(`[agent-run] ${line}\n`);

/** 실행기와 그 자식(Codex·브리지)을 함께 끝낸다 — 시간 초과로 멈출 때 Codex 가 남아 사용량을 더 쓰지 않게 */
function killTree(child) {
  if (!child || child.exitCode != null || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') { try { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch { /* 아래로 */ } }
  try { child.kill(); } catch { /* 이미 끝남 */ }
}

/** Codex 대화 기록(rollout) 가운데 이 실행의 것(작업 폴더가 tempRoot 아래)만 읽는다 → [{ file, cwd, startedAt, model, effort, responses, mcpCalls, execCalls, messages, rateLimits }] */
function readRollouts(tempRoot, startedAt) {
  const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const mark = path.basename(tempRoot).toLowerCase();
  const two = (n) => String(n).padStart(2, '0');
  const dirs = new Set();
  for (const t of [startedAt, startedAt + 86400000]) {
    const d = new Date(t);
    dirs.add(path.join(base, String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())));
    dirs.add(path.join(base, String(d.getUTCFullYear()), two(d.getUTCMonth() + 1), two(d.getUTCDate())));
  }
  const found = [];
  for (const dir of dirs) {
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.filter((x) => x.startsWith('rollout-') && x.endsWith('.jsonl'))) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < startedAt) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const meta = lines.find((x) => x.type === 'session_meta')?.payload;
      if (!meta || !String(meta.cwd || '').toLowerCase().includes(mark)) continue;
      const turn = lines.find((x) => x.type === 'turn_context')?.payload || {};
      const responses = []; const seen = new Set(); const mcpCalls = []; const messages = []; const limits = []; let execCalls = 0;
      for (const x of lines) {
        const p = x.payload || {};
        if (x.type === 'token_usage_record' && !seen.has(p.response_id)) {
          seen.add(p.response_id);
          responses.push({ at: x.timestamp, input: p.usage?.input_tokens ?? 0, cached: p.usage?.cached_input_tokens ?? 0, output: p.usage?.output_tokens ?? 0, reasoning: p.usage?.reasoning_output_tokens ?? 0 });
        } else if (x.type === 'response_item' && p.type === 'custom_tool_call') execCalls += 1;
        else if (x.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'McpToolCall') {
          const args = JSON.stringify(p.item.arguments ?? null);
          const text = JSON.stringify(p.item.result ?? null);
          mcpCalls.push({ at: x.timestamp, tool: p.item.tool, status: p.item.status, error: Boolean(p.item.result?.isError ?? p.item.result?.is_error ?? p.item.error) || undefined,
            ms: p.item.duration ? Math.round((p.item.duration.secs || 0) * 1000 + (p.item.duration.nanos || 0) / 1e6) : null,
            args: args.length > 2000 ? `${args.slice(0, 2000)} …(+${args.length - 2000}자)` : args, resultChars: text.length });
        } else if (x.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'AgentMessage') {
          const said = (p.item.content || []).map((c) => c.text || '').join('').trim();
          if (said) messages.push({ at: x.timestamp, phase: p.item.phase || null, text: said.length > 400 ? `${said.slice(0, 400)} …` : said });
        } else if (x.type === 'event_msg' && p.type === 'token_count' && p.rate_limits?.primary) limits.push({ usedPercent: p.rate_limits.primary.used_percent, windowMinutes: p.rate_limits.primary.window_minutes });
      }
      fs.copyFileSync(file, path.join(out, `codex-${name}`));
      found.push({ file: name, cwd: meta.cwd, startedAt: meta.timestamp, cliVersion: meta.cli_version || null, model: turn.model || null, effort: turn.effort || null,
        responses, mcpCalls, execCalls, messages, rateLimits: limits.length ? { first: limits[0], last: limits[limits.length - 1] } : null });
    }
  }
  return found.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} …(+${text.length - max}자)` : text);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const MCP_PREFIX = 'mcp__hwpx__';

/**
 * Claude Code(claude -p --output-format stream-json)가 낸 줄을 실행기 원본 기록에서 읽는다(server/codex-ai.js runProcess → ai-debug 의 cli.stdout-*.bin).
 * 같은 실행의 준비 점검(--version·--help·auth status) 출력은 stream-json 이 아니라 빠진다. 읽은 것은 <out>/claude-stream-<n>.jsonl 로 옮겨 둔다.
 * → [{ file, bytes, init, result, responses:[{ id, input, cached, cacheWrite, uncached, output, tools }], calls:[{ tool, args, error, resultChars }] }]
 */
function readClaudeStreams(debugDir) {
  const files = [];
  const walk = (dir) => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/^cli\.stdout-.*\.bin$/.test(e.name)) files.push(p); } };
  walk(debugDir);
  const found = [];
  for (const file of files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)) {
    const text = fs.readFileSync(file, 'utf8');
    const events = text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && typeof e === 'object' && ['system', 'assistant', 'user', 'result'].includes(e.type));
    if (!events.some((e) => (e.type === 'system' && e.subtype === 'init') || e.type === 'result')) continue;
    let init = null; let result = null;
    const messages = new Map(); const uses = new Map(); const outcomes = new Map();
    for (const e of events) {
      if (e.type === 'system' && e.subtype === 'init') init ||= e;
      else if (e.type === 'result') result = e;
      else if (e.type === 'assistant' && e.message) {
        // 응답 하나가 내용 조각마다 여러 줄로 온다(같은 message.id) — 사용량은 마지막 줄의 것, 도구 호출은 고유 id 로 모은다
        const id = e.message.id || `message-${messages.size}`;
        const m = messages.get(id) || { id, usage: null, tools: [] }; messages.set(id, m);
        if (e.message.usage) m.usage = e.message.usage;
        for (const b of Array.isArray(e.message.content) ? e.message.content : []) {
          if (b?.type !== 'tool_use') continue;
          const key = b.id || `tool-${uses.size}`;
          if (uses.has(key)) continue;
          const tool = String(b.name || '?');
          uses.set(key, { tool: tool.startsWith(MCP_PREFIX) ? tool.slice(MCP_PREFIX.length) : tool, mcp: tool.startsWith(MCP_PREFIX), args: clip(JSON.stringify(b.input ?? null), 2000) });
          m.tools.push(uses.get(key).tool);
        }
      } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
          const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null);
          outcomes.set(b.tool_use_id, { error: b.is_error === true, chars: body.length });
        }
      }
    }
    const name = `claude-stream-${found.length + 1}.jsonl`;
    fs.copyFileSync(file, path.join(out, name));
    found.push({ file: name, source: path.relative(out, file), bytes: Buffer.byteLength(text), init, result,
      responses: [...messages.values()].map((m) => {
        const u = m.usage || {};
        const uncached = num(u.input_tokens); const cached = num(u.cache_read_input_tokens); const cacheWrite = num(u.cache_creation_input_tokens);
        return { id: m.id, input: uncached + cached + cacheWrite, cached, cacheWrite, uncached, output: num(u.output_tokens), tools: m.tools };
      }),
      calls: [...uses.entries()].map(([id, u]) => ({ tool: u.tool, mcp: u.mcp, error: outcomes.get(id)?.error || undefined, resultChars: outcomes.get(id)?.chars ?? null, args: u.args })) });
  }
  return found;
}

/** Claude stream-json 집계 → result.json 의 modelResponses·toolCalls·claude(턴 수·토큰 합계·걸린 시간). 토큰의 input 은 캐시 읽기·쓰기를 더한 전체 입력이다(Codex 의 input 과 같은 뜻) */
function claudeSummary(streams) {
  const responses = streams.flatMap((s) => s.responses);
  const sum = (k) => responses.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const calls = streams.flatMap((s) => s.calls);
  const tally = {}; for (const c of calls) tally[c.tool] = (tally[c.tool] || 0) + 1;
  // CLI 가 결과 줄에 알린 합계(없으면 — 시간 초과 등 — 응답마다 받은 값의 합)
  const reported = streams.filter((s) => s.result?.usage);
  const usage = reported.length === streams.length && streams.length
    ? reported.reduce((t, s) => ({ input: t.input + num(s.result.usage.input_tokens), cacheRead: t.cacheRead + num(s.result.usage.cache_read_input_tokens), cacheWrite: t.cacheWrite + num(s.result.usage.cache_creation_input_tokens), output: t.output + num(s.result.usage.output_tokens), source: 'result' }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
    : { input: sum('uncached'), cacheRead: sum('cached'), cacheWrite: sum('cacheWrite'), output: sum('output'), source: 'responses' };
  const turns = streams.some((s) => s.result?.num_turns != null) ? streams.reduce((n, s) => n + num(s.result?.num_turns), 0) : null;
  return {
    modelResponses: responses.length ? { count: responses.length, input: sum('input'), cached: sum('cached'), cacheWrite: sum('cacheWrite'), uncached: sum('uncached'), output: sum('output'), firstInput: responses[0]?.input, maxInput: Math.max(...responses.map((r) => r.input)), perResponse: responses } : null,
    toolCalls: { count: calls.length, byTool: tally, errors: calls.filter((c) => c.error).length, builtinCalls: calls.filter((c) => !c.mcp).length, calls },
    claude: {
      turns, usage, durationMs: streams.some((s) => s.result?.duration_ms != null) ? streams.reduce((n, s) => n + num(s.result?.duration_ms), 0) : null,
      runs: streams.map((s) => ({ file: s.file, source: s.source, bytes: s.bytes, model: s.init?.model || null, cliVersion: s.init?.claude_code_version || null, permissionMode: s.init?.permissionMode || null,
        mcp: (s.init?.mcp_servers || []).find((x) => x?.name === 'hwpx')?.status || null, tools: Array.isArray(s.init?.tools) ? s.init.tools.length : null,
        hwpxTools: Array.isArray(s.init?.tools) ? s.init.tools.filter((t) => String(t).startsWith(MCP_PREFIX)).map((t) => String(t).slice(MCP_PREFIX.length)) : null,
        turns: s.result?.num_turns ?? null, durationMs: s.result?.duration_ms ?? null, durationApiMs: s.result?.duration_api_ms ?? null,
        // 구독 실행이라 실제로 청구되지 않는다 — CLI 가 알린 API 단가 환산값(참고)
        reportedCostUsd: s.result?.total_cost_usd ?? null, isError: s.result ? s.result.is_error === true : null, subtype: s.result?.subtype || null,
        permissionDenials: Array.isArray(s.result?.permission_denials) ? s.result.permission_denials.length : null,
        finalText: typeof s.result?.result === 'string' ? clip(s.result.result.trim(), 400) : null, responses: s.responses.length, calls: s.calls.length })),
    },
  };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-agent-run-'));
const srv = await startServer({ ai: 'off', log: path.join(out, 'server.log') });
let worker = null;
const startedAt = Date.now();
try {
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, path.resolve(docPath));
  const D = `/api/docs/${doc.id}`;
  const before = await api(`${D}`);
  const body = { kind: 'instruct', instruction, target: target === 'document' ? { scope: 'document', ref: 's0/p0' } : { ref: target }, route: 'queue' };
  const req = (await api(`${D}/requests`, { method: 'POST', body })).request;
  log(`임시 서버 ${srv.base} · 문서 ${doc.id} · 요청 #${req.rid} — 실행기(${provider}, MCP ${mcp})를 띄웁니다`);

  // 실행기 환경: 밖의 HWPX_COWORK_* 는 넘기지 않는다(운영 주소·토큰·설정이 섞이지 않게). TEMP 는 이 실행만의 폴더
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^HWPX_COWORK_/i.test(k) && !/^(TEMP|TMP|TMPDIR)$/i.test(k)) env[k] = v;
  Object.assign(env, { HWPX_COWORK_TOKEN: srv.tokens.a, HWPX_COWORK_DEBUG_DIR: path.join(out, 'ai-debug'), TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot });
  const args = [path.join(root, 'scripts', 'ai-worker.mjs'), '--provider', provider, '--mcp', mcp, '--url', `${srv.base}/mcp`,
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(codexCommand ? ['--codex-command', codexCommand] : []), ...(claudeCommand ? ['--cli-command', claudeCommand] : [])];
  const workerLog = fs.createWriteStream(path.join(out, 'worker.log'));
  worker = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  worker.stdout.pipe(workerLog); worker.stderr.pipe(workerLog);
  let exited = null; worker.once('exit', (code) => { exited = code ?? -1; });

  // 요청이 끝날 때까지 본다. 끝난 뒤에도 Codex 가 마지막 답을 쓰고 실행기가 사용량을 요청에 남길 때까지(usage) 기다린다 —
  // 바로 멈추면 마지막 응답의 토큰이 빠진다. 1초마다 보는 응답 시간의 최댓값은 서버가 멈췄는지의 증거다
  let view = null; let closedAt = null; let maxPollMs = 0; let timedOut = false; let pollRetries = 0;
  const deadline = Date.now() + timeoutMs;
  // 큰 문서의 구조 op 는 서버 스레드에서 수 초 걸린다(동기 엔진) — 그 사이 keep-alive 연결이 끊겨 조회 fetch 가 ECONNRESET 으로
  // 실패할 수 있다(2026-11-17 16MB 문서 Codex 실측이 그렇게 멈췄다). 서버가 살아 있으면 잠깐 뒤 다시 묻는다
  const poll = async (url) => {
    for (let i = 0; ; i++) {
      try { return await api(url); }
      catch (e) {
        const transient = e?.message === 'fetch failed' || ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(e?.cause?.code);
        if (!transient || srv.child?.exitCode != null || i >= 30) throw e;
        pollRetries += 1;
        log(`조회가 끊겼습니다(${e?.cause?.code || e.message}) — 서버는 살아 있어 다시 묻습니다(${i + 1})`);
        await sleep(1000);
      }
    }
  };
  for (;;) {
    await sleep(1000);
    const t0 = Date.now();
    view = await poll(`${D}/requests/${req.rid}`);
    maxPollMs = Math.max(maxPollMs, Date.now() - t0);
    const closed = ['done', 'failed', 'cancelled'].includes(view.status);
    if (closed && closedAt == null) { closedAt = Date.now(); log(`요청 상태 ${view.status} — 실행기가 사용량을 남길 때까지 기다립니다`); }
    if (closed && (view.usage || view.execution || Date.now() - closedAt > 180000)) break;
    if (exited != null) { log(`실행기가 먼저 끝났습니다(종료 코드 ${exited})`); break; }
    if (Date.now() > deadline) { timedOut = true; log('시간 초과 — 실행기를 멈춥니다'); break; }
  }
  const closedMs = closedAt != null ? closedAt - startedAt : null; const elapsedMs = Date.now() - startedAt;
  await sleep(1500);
  view = await poll(`${D}/requests/${req.rid}`);
  if (exited == null) { killTree(worker); await Promise.race([new Promise((r) => worker.once('exit', r)), sleep(8000)]); }

  const proposals = await api(`${D}/proposals`);
  const activity = await api(`${D}/requests/${req.rid}/activity`).catch(() => ({ items: [] }));
  const memos = await api(`${D}/memos`).catch(() => []);
  let applied = null;
  if (flag('apply') && view.status === 'done') {
    applied = [];
    for (const p of proposals.filter((x) => x.rid === req.rid && x.status === 'pending')) {
      const t0 = Date.now();
      const r = await api.res(`${D}/proposals/${p.pid}/apply`, { method: 'POST', body: {} });
      applied.push({ pid: p.pid, type: p.type, ok: r.ok, ms: Date.now() - t0, ...(r.ok ? {} : { error: r.data?.message || r.status }) });
    }
    // 저장된 문서 그대로(kind=tracked) — 반영 결과를 엔진·한/글로 다시 확인할 수 있게
    const file = await api.res(`${D}/file?kind=tracked`);
    if (file.ok && Buffer.isBuffer(file.data)) fs.writeFileSync(path.join(out, 'result.hwpx'), file.data);
    else applied.push({ download: false, status: file.status });
  }
  const after = await api(`${D}`);
  const serverAlive = srv.child?.exitCode == null;

  const common = (modelResponses, toolCalls) => ({
    at: new Date().toISOString(), isolatedServer: true, provider, mcp, model: view.model || model || null, effort: effort || null, timedOut,
    document: { file: path.basename(docPath), bytes: fs.statSync(path.resolve(docPath)).size, before: { sections: before.sections, bodyParagraphs: before.bodyParagraphs }, after: { sections: after.sections, bodyParagraphs: after.bodyParagraphs } },
    instruction, request: { rid: req.rid, status: view.status, summary: view.summary || null, error: view.error || null, usage: view.usage || null, execution: view.execution || null },
    elapsedMs, closedMs, server: { alive: serverAlive, maxPollMs, pollRetries },
    modelResponses, toolCalls,
    activity: (activity.items || []).map((i) => ({ at: i.at, label: i.label, ok: i.ok, ms: i.ms })),
    proposals: proposals.filter((p) => p.rid === req.rid).map((p) => ({ pid: p.pid, type: p.type, status: p.status, ref: p.ref || p.afterRef, labels: p.pageLayout?.labels || p.tableEdit?.labels || null, result: p.pageLayout?.result || null })),
    memos: memos.filter((m) => m.link?.rid === req.rid && m.link?.type === 'comment').length,
    applied,
  });
  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
  if (provider === 'claude-code') {
    const streams = readClaudeStreams(path.join(out, 'ai-debug'));
    const summary = claudeSummary(streams);
    const result = { ...common(summary.modelResponses, summary.toolCalls), claude: summary.claude };
    fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const u = summary.claude.usage;
    log(`끝: ${view.status} · ${Math.round(elapsedMs / 1000)}초 · 턴 ${summary.claude.turns ?? '미확인'} · 모델 응답 ${summary.modelResponses?.count || 0}회 · 입력 ${fmt(u.input)}(캐시 읽기 ${fmt(u.cacheRead)} · 캐시 쓰기 ${fmt(u.cacheWrite)}) · 출력 ${fmt(u.output)} · 한 응답 최대 문맥 ${fmt(summary.modelResponses?.maxInput)} · 도구 ${summary.toolCalls.count}회 → ${path.join(out, 'result.json')}`);
  } else {
    const rollouts = readRollouts(tempRoot, startedAt);
    const responses = rollouts.flatMap((r) => r.responses);
    const sum = (k) => responses.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const calls = rollouts.flatMap((r) => r.mcpCalls);
    const tally = {}; for (const c of calls) tally[c.tool] = (tally[c.tool] || 0) + 1;
    const result = {
      ...common(responses.length ? { count: responses.length, input: sum('input'), cached: sum('cached'), uncached: sum('input') - sum('cached'), output: sum('output'), reasoning: sum('reasoning'), firstInput: responses[0]?.input, maxInput: Math.max(...responses.map((r) => r.input)), perResponse: responses } : null,
        { count: calls.length, byTool: tally, maxMs: calls.length ? Math.max(...calls.map((c) => c.ms || 0)) : null, execCalls: rollouts.reduce((s, r) => s + r.execCalls, 0), calls }),
      rollouts: rollouts.map((r) => ({ file: r.file, startedAt: r.startedAt, cliVersion: r.cliVersion, model: r.model, effort: r.effort, responses: r.responses.length, mcpCalls: r.mcpCalls.length, execCalls: r.execCalls, messages: r.messages, rateLimits: r.rateLimits })),
    };
    fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    log(`끝: ${view.status} · ${Math.round(elapsedMs / 1000)}초 · 모델 응답 ${responses.length}회 · 입력 ${sum('input').toLocaleString('ko-KR')}(캐시 ${sum('cached').toLocaleString('ko-KR')}) · 출력 ${sum('output').toLocaleString('ko-KR')} · 도구 ${calls.length}회 → ${path.join(out, 'result.json')}`);
  }
} finally {
  killTree(worker);
  await srv.stop();
  try { removeTree(tempRoot); } catch (e) { log(`임시 폴더를 지우지 못했습니다(${tempRoot}): ${e.message}`); }
}
