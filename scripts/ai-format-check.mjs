// AI 서식 요청 점검 — 실제 문서 사본으로 격리 서버(임시 data·config·빈 포트)를 띄우고, 글자모양·문단모양·스타일을 바꾸라는
// 지시를 대기열에 넣은 뒤 AI 에이전트가 처리하게 한다. 끝나면 서식 제안을 모두 적용해 지시대로 바뀌었는지 서버 문서(서식 값)와
// 편집기 엔진(rhwp: 편집기가 그리는 값)으로 확인하고 표로 알린다. 진짜 서버(:8787)·data/·config.json 은 쓰지 않는다.
//
//   node scripts/ai-format-check.mjs --doc <문서.hwpx> [--agent claude|scripted] [--model <id>] [--keep] [--json <out.json>]
//     --agent claude   : Claude Code(claude -p) 가 MCP 로 대기열을 처리한다(이 PC 의 Claude Code 로그인 사용, 격리 서버만 연결 — --strict-mcp-config)
//     --agent scripted : 사람이 짠 에이전트(같은 MCP 도구) — AI 없이 서버·엔진 경로만 본다(기본)
//   API 같은 API 모델 경로는 유료 API 라 여기서 부르지 않는다 — tests/format_requests.test.mjs 가 가짜 응답으로 같은 확인을 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function args(argv) {
  const o = { doc: null, agent: 'scripted', model: null, keep: false, json: null, timeoutMin: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--doc') o.doc = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--timeout-min') o.timeoutMin = Number(argv[++i]);
  }
  if (!o.doc) throw new Error('--doc <문서.hwpx> 가 필요합니다');
  if (!['claude', 'scripted'].includes(o.agent)) throw new Error(`--agent 는 claude 또는 scripted: ${o.agent}`);
  return o;
}

/** 시험할 문단 고르기 — 본문 문단(표 칸 제외)에서 제목 하나, '(표제) 본문' 꼴 긴 문단 넷 */
export function pickTargets(paragraphs) {
  const body = paragraphs.filter((p) => !p.parent && p.body != null && typeof p.text === 'string');
  const long = body.filter((p) => p.text.trim().length > 60);
  const headed = long.filter((p) => /^\([^)]{1,20}\)/.test(p.text));
  const pool = [...headed, ...long.filter((p) => !headed.includes(p))];
  const heading = body.find((p) => { const t = p.text.trim(); return t.length >= 6 && t.length <= 40 && t === p.text && !/^[(\[]/.test(t) && !/[.。]$/.test(t); });
  if (pool.length < 4 || !heading) throw new Error('시험할 문단(긴 본문 4개·제목 1개)을 찾지 못했습니다');
  return { open: pool[0], headed: pool.find((p, i) => i > 0 && /^\([^)]{1,20}\)/.test(p.text)) || pool[1], heading, spacing: pool[2], style: pool[3] };
}

/**
 * 요청과 기대(적용 뒤 서식 값으로 판정). 지금 서식과 다른 결과를 요구하는 지시만 낸다 — 이미 그런 문단에 같은 지시를 주면
 * 제안이 없어도 맞는 것처럼 보인다. t.* 는 { ref, text, formatting(inspectFormatting) }.
 */
export function buildCases(t, styles) {
  const prefix = /^\([^)]{1,20}\)/.exec(t.headed.text)?.[0] || t.headed.text.slice(0, 4);
  const n = [...prefix].length;
  const headRuns = t.headed.formatting.runs.filter((r) => r.start < n);
  const prefixBold = headRuns.length > 0 && headRuns.every((r) => r.char?.bold === true);
  const title = t.heading.formatting;
  const align = title.paragraph?.align === 'CENTER' ? 'RIGHT' : 'CENTER';
  const sizes = new Set(title.runs.map((r) => r.char?.sizePt));
  const sizePt = sizes.size === 1 && sizes.has(16) ? 18 : 16;
  const spacing = t.spacing.formatting.paragraph || {};
  const pct = spacing.lineSpacing?.type === 'PERCENT' && spacing.lineSpacing.value === 160 ? 150 : 160;
  const after = spacing.spaceAfterPt === 6 ? 8 : 6;
  const current = t.style.formatting.styleId;
  const style = styles.find((s) => s.type === 'PARA' && s.id !== current && /개요\s*[1-3]|제목|본문/.test(s.name)) || styles.find((s) => s.type === 'PARA' && s.id !== current);
  return [
    { key: 'open', ref: t.open.ref, instruction: '서식을 좀 고쳐줘', expect: { anyFormat: true } },
    prefixBold
      ? { key: 'bold', ref: t.headed.ref, instruction: `이 문단 맨 앞 표제 '${prefix}'의 굵게를 해제하고 기울임꼴로 바꿔줘. 나머지 글은 그대로 둬`, expect: { prefix, prefixChar: { bold: false, italic: true } } }
      : { key: 'bold', ref: t.headed.ref, instruction: `이 문단 맨 앞 표제 '${prefix}'만 굵게 해줘`, expect: { prefix, prefixChar: { bold: true } } },
    { key: 'title', ref: t.heading.ref, instruction: `이 제목을 ${align === 'CENTER' ? '가운데' : '오른쪽'} 정렬하고 글자 크기를 ${sizePt}pt로 바꿔줘`, expect: { align, sizePt } },
    { key: 'spacing', ref: t.spacing.ref, instruction: `이 문단의 줄 간격을 ${pct}%로, 문단 아래 간격을 ${after}pt로 바꿔줘`, expect: { lineSpacing: { type: 'PERCENT', value: pct }, spaceAfterPt: after } },
    ...(style ? [{ key: 'style', ref: t.style.ref, instruction: `이 문단에 '${style.name}' 스타일을 적용해줘`, expect: { styleId: style.id, styleName: style.name } }] : []),
  ];
}

/** 적용 뒤 서식이 기대와 맞는가 → [{ ok, what }] */
export function judge(c, f) {
  const out = [];
  const e = c.expect;
  if (e.prefix) {
    const n = [...e.prefix].length;
    const head = f.runs.filter((r) => r.start < n);
    for (const [k, v] of Object.entries(e.prefixChar)) {
      out.push({ ok: head.length > 0 && head.every((r) => (r.char?.[k] === true) === v), what: `표제 '${e.prefix}' ${k === 'bold' ? '굵게' : '기울임'} ${v ? '켬' : '끔'}` });
    }
  }
  if (e.align) out.push({ ok: f.paragraph?.align === e.align, what: `정렬 ${e.align} (지금 ${f.paragraph?.align})` });
  if (e.sizePt != null) out.push({ ok: f.runs.length > 0 && f.runs.every((r) => Math.abs((r.char?.sizePt ?? 0) - e.sizePt) < 0.01), what: `글자 크기 ${e.sizePt}pt (지금 ${[...new Set(f.runs.map((r) => r.char?.sizePt))].join('/')})` });
  if (e.lineSpacing) out.push({ ok: f.paragraph?.lineSpacing?.type === e.lineSpacing.type && f.paragraph?.lineSpacing?.value === e.lineSpacing.value, what: `줄 간격 ${e.lineSpacing.value}% (지금 ${JSON.stringify(f.paragraph?.lineSpacing)})` });
  if (e.spaceAfterPt != null) out.push({ ok: Math.abs((f.paragraph?.spaceAfterPt ?? -1) - e.spaceAfterPt) < 0.01, what: `문단 아래 간격 ${e.spaceAfterPt}pt (지금 ${f.paragraph?.spaceAfterPt})` });
  if (e.styleId != null) out.push({ ok: String(f.styleId) === String(e.styleId), what: `스타일 '${e.styleName}' (지금 ${f.styleId})` });
  return out;
}

/** 편집기 엔진(rhwp)이 같은 값을 그리는가 — 서버가 편집기에 주는 작업본을 읽는다 */
async function rhwpView(bytes, cases, formats) {
  const pkg = path.join(root, 'vendor', 'rhwp', 'pkg');
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  const mod = await import(pathToFileURL(path.join(pkg, 'rhwp.js')).href);
  if (!globalThis.__rhwpEngineReady?.has(pkg)) { mod.initSync({ module: fs.readFileSync(path.join(pkg, 'rhwp_bg.wasm')) }); (globalThis.__rhwpEngineReady ??= new Set()).add(pkg); }
  const doc = new mod.HwpDocument(new Uint8Array(bytes));
  try {
    const out = {};
    for (const c of cases) {
      const m = /^s(\d+)\/p(\d+)$/.exec(c.ref); if (!m) continue;
      const [sec, para] = [Number(m[1]), Number(m[2])];
      const f = formats[c.key]; const checks = [];
      const charAt = (off) => JSON.parse(doc.getCharPropertiesAt(sec, para, off));
      const paraP = JSON.parse(doc.getParaPropertiesAt(sec, para));
      if (c.expect.prefix) {
        const cp = charAt(1);
        for (const [k, v] of Object.entries(c.expect.prefixChar)) checks.push({ ok: (cp[k] === true) === v, what: `편집기: 표제 ${k} ${cp[k]}` });
      }
      if (c.expect.align) checks.push({ ok: String(paraP.alignment || '').toLowerCase() === c.expect.align.toLowerCase(), what: `편집기: 정렬 ${paraP.alignment}` });
      if (c.expect.sizePt != null) { const pt = (charAt(1).fontSize ?? 0) / 100; checks.push({ ok: Math.abs(pt - c.expect.sizePt) < 0.01, what: `편집기: 글자 크기 ${pt}pt` }); }
      if (c.expect.lineSpacing) checks.push({ ok: Number(paraP.lineSpacing) === c.expect.lineSpacing.value, what: `편집기: 줄 간격 ${paraP.lineSpacing}` });
      if (c.expect.styleId != null) { const st = JSON.parse(doc.getStyleAt(sec, para)); checks.push({ ok: st.name === c.expect.styleName, what: `편집기: 스타일 ${st.name}` }); }
      out[c.key] = checks;
    }
    return out;
  } finally { doc.free(); }
}

/** 사람이 짠 에이전트 — AI 대신 같은 MCP 도구로 지시대로 서식 제안(서버·엔진 경로 점검용) */
async function scriptedAgent(call, cases) {
  for (;;) {
    const r = JSON.parse((await call('claim_next_request', {})).content[0].text);
    if (r.none) break;
    const c = cases.find((x) => x.rid === r.rid);
    const base = { request_id: r.rid, expected_attempt: r.attempt ?? 1, ref: c.ref };
    const len = [...r.contextItems.find((x) => x.ref === c.ref).text].length;
    const e = c.expect;
    const send = async (o) => { const res = await call('propose_format', { ...base, ...o }); if (res.isError) throw new Error(res.content?.[0]?.text); };
    if (e.anyFormat) await send({ start: 0, end: len, format: { paragraph: { spaceAfterPt: 9 } }, reason: '문단 사이 간격 정돈' });
    if (e.prefix) await send({ start: 0, end: [...e.prefix].length, format: { char: e.prefixChar } });
    if (e.align || e.sizePt) await send({ start: 0, end: len, format: { ...(e.align ? { paragraph: { align: e.align } } : {}), ...(e.sizePt ? { char: { sizePt: e.sizePt } } : {}) } });
    if (e.lineSpacing) await send({ start: 0, end: len, format: { paragraph: { lineSpacing: e.lineSpacing, spaceAfterPt: e.spaceAfterPt } } });
    if (e.styleId != null) await send({ start: 0, end: len, format: { styleId: String(e.styleId) } });
    await call('complete_request', { request_id: r.rid, expected_attempt: base.expected_attempt, summary: '지시대로 서식 제안을 남겼습니다.' });
  }
}

function runClaude({ base, token, model, timeoutMin, work }) {
  const cfg = path.join(work, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { hwpx: { type: 'http', url: `${base}/mcp?agent=${encodeURIComponent('Claude Code')}`, headers: { Authorization: `Bearer ${token}` } } } }));
  const prompt = 'hwpx 문서 서버의 AI 작업 대기열을 처리해 줘. claim_next_request 로 none 이 나올 때까지 하나씩 맡아, 각 요청의 지시대로 제안·메모를 남기고 complete_request 로 끝내.';
  // 격리 서버만(--strict-mcp-config), hwpx 도구만 허용하고 나머지는 묻지 않고 막는다(dontAsk)
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

/**
 * 점검 한 번: 격리 서버 + 문서 사본 → 서식 지시 대기열 → 에이전트 → 제안 적용 → 판정. 반환 { pass, secs, report, agentOut }.
 * agent: 'scripted' | 'claude' | async (call, cases) => {}(직접 짠 에이전트)
 */
export async function runCheck({ doc, agent = 'scripted', model = null, timeoutMin = 20, keep = false, log = console.log }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-format-check-'));
  const srv = await startServer({ ai: 'off' });
  let client;
  try {
    const up = await uploadDoc(srv.base, srv.tokens.a, fs.readFileSync(doc));
    const api = srv.api('a'); const route = `/api/docs/${up.id}`;
    client = new Client({ name: 'format-check', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp?agent=check`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } }));
    const call = (name, a) => client.callTool({ name, arguments: { ...a, doc_id: up.id } });
    const inspect = async (ref) => (await api(`${route}/formatting?ref=${encodeURIComponent(ref)}`)).paragraph;
    const picked = pickTargets(await api(`${route}/paragraphs`));
    const targets = Object.fromEntries(await Promise.all(Object.entries(picked).map(async ([k, p]) => [k, { ...p, formatting: await inspect(p.ref) }])));
    const cases = buildCases(targets, (await api(`${route}/formatting`)).catalog.styles);
    for (const c of cases) c.rid = (await api(`${route}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: c.instruction, route: 'queue', target: { ref: c.ref } } })).request.rid;
    log(`문서 ${path.basename(doc)} · 요청 ${cases.length}건 · 에이전트 ${typeof agent === 'string' ? agent : 'custom'}`);
    const t0 = Date.now();
    let agentOut = null;
    if (agent === 'claude') agentOut = await runClaude({ base: srv.base, token: srv.tokens.a, model, timeoutMin, work });
    else await (agent === 'scripted' ? scriptedAgent : agent)(call, cases);
    const secs = Math.round((Date.now() - t0) / 1000);
    const listed = await api(`${route}/requests`); const requests = listed.requests || listed;
    const proposals = await api(`${route}/proposals`);
    const report = [];
    for (const c of cases) {
      const r = requests.find((x) => x.rid === c.rid) || {};
      const mine = proposals.filter((p) => p.rid === c.rid);
      const formatLike = mine.filter((p) => p.type === 'format' || p.format || p.runs);
      const applied = []; const applyErrors = [];
      for (const p of formatLike) {
        const res = await api.res(`${route}/proposals/${p.pid}/apply`, { method: 'POST' });
        // SAME = 이미 그 서식(바꿀 것 없음) — 실패가 아니다
        if (res.ok || res.data?.error === 'SAME') applied.push(p.pid); else applyErrors.push(`${p.pid}:${res.data?.error || res.status}`);
      }
      report.push({ ...c, status: r.status, handledBy: r.handledBy, summary: r.summary || r.aiSummary || '', proposals: mine.length, formatProposals: formatLike.length, applied, applyErrors, kinds: mine.map((p) => p.type) });
    }
    const texts = {};
    for (const c of report) {
      const f = await inspect(c.ref); texts[c.key] = f.text;
      c.server = c.expect.anyFormat ? [{ ok: c.formatProposals > 0 && c.applied.length > 0, what: '서식 제안을 남기고 적용됨' }] : judge(c, f);
    }
    const working = Buffer.from(await (await fetch(`${srv.base}${route}/file?kind=working`, { headers: { Authorization: `Bearer ${srv.tokens.a}` } })).arrayBuffer());
    const view = await rhwpView(working, report.filter((c) => !c.expect.anyFormat), texts);
    let pass = true;
    for (const c of report) {
      c.checks = [...c.server, ...(view[c.key] || [])];
      c.ok = c.status === 'done' && !c.applyErrors.length && c.checks.every((x) => x.ok);
      pass &&= c.ok;
      log(`\n${c.ok ? '✓' : '✗'} [${c.key}] ${c.ref} "${c.instruction}"`);
      log(`   상태 ${c.status} · 처리 ${c.handledBy || '-'} · 제안 ${c.proposals}(서식 ${c.formatProposals}, 적용 ${c.applied.length}${c.applyErrors.length ? `, 적용 실패 ${c.applyErrors.join(' ')}` : ''})`);
      if (c.summary) log(`   요약: ${c.summary}`);
      for (const x of c.checks) log(`   ${x.ok ? '·' : '✗'} ${x.what}`);
    }
    log(`\n${pass ? '모두 통과' : '실패 있음'} — ${secs}초${agentOut ? ` · claude 종료 코드 ${agentOut.code}` : ''}`);
    return { pass, secs, report, agentOut };
  } finally {
    try { await client?.close(); } catch {}
    await srv.stop();
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const o = args(process.argv.slice(2));
  const out = await runCheck({ doc: o.doc, agent: o.agent, model: o.model, timeoutMin: o.timeoutMin, keep: o.keep });
  if (out.agentOut && (out.agentOut.code !== 0 || !out.pass)) console.log(`\nclaude 출력(끝 2000자):\n${out.agentOut.out.slice(-2000)}\n${out.agentOut.err.slice(-600)}`);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ doc: o.doc, agent: o.agent, ...out }, null, 1));
  process.exitCode = out.pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(2); });
