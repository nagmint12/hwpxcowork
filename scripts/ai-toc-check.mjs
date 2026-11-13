// AI 차례 새로 고침 점검 — 실제 문서 사본으로 격리 서버(임시 data·config·빈 포트)를 띄우고, 차례 지시 두 건을 대기열에 넣은 뒤
// AI 에이전트가 처리하게 한다: ① 「차례 새로고침해줘」 ② 「차례 새로고침하고 … 차례제목·차례1·차례2 스타일 … 한 줄이 넘지 않게」.
// 끝나면(남은 차례 제안은 적용해) 차례가 새로 고쳐졌는지(편집기 엔진이 같은 문서로 새로 고친 차례와 같은 글), 차례 문단 스타일이
// 표준서식 규칙(engine/toc.js tocRole)대로인지, 항목이 모두 한 줄인지(편집기 엔진 줄 수)를 표로 알린다. 진짜 서버·data/·config.json 은 쓰지 않는다.
//
//   node scripts/ai-toc-check.mjs --doc <차례가 든 문서.hwpx> [--agent claude|scripted] [--model <id>] [--out <결과.hwpx>]
//     --agent claude   : Claude Code(claude -p) 가 MCP 로 대기열을 처리한다(이 PC 의 Claude Code 로그인, 격리 서버만 — --strict-mcp-config)
//     --agent scripted : 사람이 짠 에이전트(같은 MCP 도구) — AI 없이 서버·엔진 경로만 본다(기본)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { tocRegions, physicalParas, tocRole, docBytesSync } from '../engine/toc.js';
import { refreshTocInEngine, lineCountsInEngine } from '../server/toc-engine.js';

const INSTRUCTIONS = [
  { key: 'refresh', text: '차례 새로고침해줘' },
  { key: 'styled', text: '차례 새로고침하고 이를 차례제목 스타일 차례1 차례2 스타일로 적용을 다시해줘. 이후 한줄이 넘어가는 목차들을 한줄이 넘지 않게 설정해줘' },
];

function args(argv) {
  const o = { doc: null, agent: 'scripted', model: null, out: null, timeoutMin: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') o.doc = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
  }
  if (!o.doc) throw new Error('--doc <문서.hwpx> 가 필요합니다');
  return o;
}

function runClaude({ base, token, model, timeoutMin, work }) {
  const cfg = path.join(work, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { hwpx: { type: 'http', url: `${base}/mcp?agent=${encodeURIComponent('Claude Code')}`, headers: { Authorization: `Bearer ${token}` } } } }));
  const prompt = 'hwpx 문서 서버의 AI 작업 대기열을 처리해 줘. claim_next_request 로 none 이 나올 때까지 하나씩 맡아, 각 요청의 지시대로 처리하고 complete_request 로 끝내.';
  const argv = ['-p', prompt, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__hwpx', '--permission-mode', 'dontAsk', '--output-format', 'text', ...(model ? ['--model', model] : [])];
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return new Promise((resolve) => {
    const child = spawn(['claude', ...argv.map(quote)].join(' '), { cwd: work, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMin * 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** 사람이 짠 에이전트 — 지시 글을 보고 같은 MCP 도구로(서버·엔진 경로 점검용) */
async function scriptedAgent(call) {
  for (;;) {
    const r = JSON.parse((await call('claim_next_request', {})).content[0].text);
    if (r.none) break;
    const ins = r.instruction || '';
    const res = await call('propose_toc_update', { request_id: r.rid, expected_attempt: r.attempt ?? 1, apply_now: true, apply_styles: /스타일/.test(ins), one_line: /한\s*줄/.test(ins) });
    if (res.isError) throw new Error(res.content?.[0]?.text);
    await call('complete_request', { request_id: r.rid, expected_attempt: r.attempt ?? 1, summary: '차례를 새로 고쳤습니다.' });
  }
}

/** 문서의 첫 차례 → [{ ref, text, style, lineWrap }] */
function tocParas(d) {
  const reg = tocRegions(d)[0]; if (!reg) return [];
  const sec = d.sections[reg.sec]; const ph = physicalParas(sec);
  const styleName = new Map(d.formattingCatalog().styles.map((s) => [s.id, s.name]));
  return ph.slice(reg.start, reg.end + 1).map((p) => {
    const head = sec.xml.slice(p.start, p.start + 300);
    const pp = /paraPrIDRef="(\d+)"/.exec(head)[1];
    return { ref: p.rec.ref, text: d.text(p.rec.ref), style: styleName.get(/styleIDRef="(\d+)"/.exec(head)[1]), lineWrap: /lineWrap="(\w+)"/.exec(d.header.block('paraPr', pp) || '')?.[1] || 'BREAK' };
  });
}

export async function runCheck({ doc, agent = 'scripted', model = null, timeoutMin = 20, out = null, log = console.log }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-toc-check-'));
  const srv = await startServer({ ai: 'off' });
  let client;
  try {
    const up = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(doc));
    const api = srv.api('a'); const route = `/api/docs/${up.id}`;
    const start = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    const reg = tocRegions(start)[0];
    if (!reg) throw new Error('문서에 차례 필드가 없습니다');
    // 기대 차례 글: 편집기 엔진이 지금 문서로 새로 고친 차례
    const expected = await (async () => { const o = refreshTocInEngine(docBytesSync(start), { sec: reg.sec, para: reg.start }); const s = await HwpxDoc.load(o.bytes); return tocParas(s).map((p) => p.text); })();
    const before = tocParas(start).map((p) => p.text);
    log(`문서 ${path.basename(doc)} · 차례 ${reg.startRef}~${reg.endRef} · 지금 차례와 새로 고친 차례의 다른 줄 ${before.filter((t, i) => t !== expected[i]).length}개 · 에이전트 ${agent}`);
    const cases = [];
    for (const c of INSTRUCTIONS) cases.push({ ...c, rid: (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: c.text, route: 'queue', target: { ref: reg.startRef } } })).request.rid });
    client = new Client({ name: 'toc-check', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=check`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const call = (name, a) => client.callTool({ name, arguments: { ...a, doc_id: up.id } });
    const t0 = Date.now();
    let agentOut = null;
    if (agent === 'claude') agentOut = await runClaude({ base: srv.base, token: srv.tokens.a, model, timeoutMin, work });
    else await scriptedAgent(call);
    const secs = Math.round((Date.now() - t0) / 1000);
    const listed = await api(`${route}/requests`); const requests = listed.requests || listed;
    const proposals = await api(`${route}/proposals`);
    let pass = true;
    for (const c of cases) {
      const r = requests.find((x) => x.rid === c.rid) || {};
      const mine = proposals.filter((p) => p.rid === c.rid);
      const tocs = mine.filter((p) => p.type === 'toc');
      // 남은 차례 제안은 사람이 적용하듯 적용한다(바로 적용 권한이 없었던 경우)
      for (const p of tocs.filter((x) => x.status === 'pending')) { const res = await api.res(`${route}/proposals/${p.pid}/apply`, { method: 'POST' }); p.status = res.ok ? 'applied(사람)' : `적용 실패 ${res.data?.error}`; }
      c.ok = r.status === 'done' && tocs.length > 0 && tocs.every((p) => String(p.status).startsWith('applied'));
      c.detail = `상태 ${r.status} · 제안 ${mine.map((p) => `${p.type}:${p.status}${p.toc ? `(${[p.toc.styles ? '스타일' : '', p.toc.oneLine ? '한 줄' : ''].filter(Boolean).join('·') || '새로 고침만'})` : ''}`).join(', ') || '없음'}`;
      c.summary = r.summary || '';
      pass &&= c.ok;
    }
    // 마지막 문서 판정(②까지 처리한 뒤)
    const final = await HwpxDoc.load(await api(`${route}/file?kind=working`));
    if (out) fs.writeFileSync(out, Buffer.from(await api(`${route}/file?kind=working`)));
    const paras = tocParas(final);
    const textsOk = paras.length === expected.length && paras.every((p, i) => p.text === expected[i]);
    const want = { head: '차례제목', l1: '차례1', l2: '차례2', l3: '차례2', item: '차례1' };
    const has = new Set(final.formattingCatalog().styles.map((s) => s.name));
    const pick = (role) => { const n = want[role]; return has.has(n) ? n : n.replace(/^차례(\d)$/, '차례 $1').replace('차례제목', '차례 제목'); };
    const wrongStyle = paras.filter((p) => tocRole(p.text) && p.style !== pick(tocRole(p.text)));
    const freg = tocRegions(final)[0];
    const lines = lineCountsInEngine(docBytesSync(final), freg.sec, freg.start, freg.end);
    const multi = paras.filter((p, i) => p.text.trim() && lines[i] > 1);
    const checks = [
      { ok: textsOk, what: `차례 글 = 편집기 엔진으로 새로 고친 차례(${paras.length}문단)` },
      { ok: !wrongStyle.length, what: `차례 스타일(차례제목·차례1·차례2) — 어긋난 문단 ${wrongStyle.length}${wrongStyle.length ? `: ${wrongStyle.slice(0, 5).map((p) => `${p.text.slice(0, 16)}=${p.style}`).join(', ')}` : ''}` },
      { ok: !multi.length, what: `한 줄 — 두 줄 이상인 항목 ${multi.length}${multi.length ? `: ${multi.slice(0, 5).map((p) => p.text.slice(0, 16)).join(', ')}` : ''}` },
      { ok: paras.filter((p) => tocRole(p.text) && tocRole(p.text) !== 'head').every((p) => p.lineWrap === 'SQUEEZE'), what: '항목 문단 모양 = 한 줄로 입력(SQUEEZE)' },
    ];
    for (const c of cases) log(`\n${c.ok ? '✓' : '✗'} 「${c.text}」 — ${c.detail}${c.summary ? `\n   요약: ${c.summary}` : ''}`);
    log('\n마지막 문서:');
    for (const x of checks) { log(`   ${x.ok ? '·' : '✗'} ${x.what}`); pass &&= x.ok; }
    log(`\n${pass ? '모두 통과' : '실패 있음'} — ${secs}초${agentOut ? ` · claude 종료 코드 ${agentOut.code}` : ''}`);
    return { pass, secs, cases, checks, agentOut };
  } finally {
    try { await client?.close(); } catch {}
    await srv.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const o = args(process.argv.slice(2));
  const r = await runCheck(o);
  if (r.agentOut && (r.agentOut.code !== 0 || !r.pass)) console.log(`\nclaude 출력(끝 2000자):\n${r.agentOut.out.slice(-2000)}\n${r.agentOut.err.slice(-600)}`);
  process.exitCode = r.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(2); });
