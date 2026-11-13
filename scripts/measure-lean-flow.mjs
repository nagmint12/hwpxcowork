// 모델을 부르지 않는다. 임시 서버(tests/helpers/server.mjs — 임시 data·config)와 tutorial/결과보고서.hwpx 사본에서
// 같은 요청을 기본 연결과 얇은 흐름(lean — server/lean.js) 연결로 처리해 도구 정의·응답 글자 수와 호출 수를 견준다.
//   node scripts/measure-lean-flow.mjs [--json <결과 파일>] [--dump]
// docs/MCP_LEAN_FLOW_2026-11-10.md 의 표가 이 출력이다. 글자 수는 모델 토큰이 아니다(한글 글은 대략 글자 수 ≈ 토큰 수).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';
import { TOOL_PROFILES } from '../server/tool-profiles.js';
import { leanToolSchema } from '../server/lean.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const dump = argv.includes('--dump');

const srv = await startServer({ ai: 'off' });
const clients = [];
async function connect(lean) {
  const client = new Client({ name: lean ? 'lean-audit' : 'full-audit', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${lean ? '?lean=1' : ''}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
  await client.connect(transport); clients.push({ client, transport });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text.slice(0, 200)}`);
    if (dump) console.error(`\n=== ${lean ? 'lean' : '기본'} / ${name} (${text.length}자) ===\n${text.slice(0, 1800)}`);
    return { text, chars: text.length, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { client, call };
}

try {
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, path.join(root, 'tutorial/결과보고서.hwpx'));
  const route = `/api/docs/${doc.id}`; const paragraphs = await api(`${route}/paragraphs`);
  const para = paragraphs.find((p) => p.text.includes('일정 부분 기여한 것으로 보인다')) || paragraphs.find((p) => p.text.trim().length > 40);
  const find = para.text.includes('보인다') ? '보인다' : para.text.trim().slice(0, 6);
  const full = await connect(false); const lean = await connect(true);

  // 도구 정의(tools/list — 이름·설명·입력 스키마 JSON 글자 수)
  const size = (tools, names) => tools.filter((t) => !names || names.includes(t.name)).reduce((a, t) => a + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length, 0);
  const fullTools = (await full.client.listTools()).tools; const leanTools = (await lean.client.listTools()).tools;
  const apiNames = TOOL_PROFILES.api; const codexNames = TOOL_PROFILES.codex;
  const apiModel = fullTools.filter((t) => apiNames.includes(t.name)).map((t) => ({ ...t, inputSchema: leanToolSchema(t.inputSchema) }));
  const tools = {
    '전체 도구(채널·ChatGPT)': { count: fullTools.length, before: size(fullTools), after: size(leanTools) },
    'API 실행기가 모델에 주는 도구': { count: apiModel.length, before: size(fullTools, apiNames), after: size(apiModel) },
    'Codex 실행기 도구': { count: fullTools.filter((t) => codexNames.includes(t.name)).length, before: size(fullTools, codexNames), after: size(leanTools, codexNames) },
  };

  const cases = [
    { label: '낱말 고치기(문단 일부 선택)', body: { kind: 'instruct', instruction: '‘보인다’ 말고, 적절한 표현으로', target: { ref: para.ref, text: find, start: [...para.text.slice(0, para.text.indexOf(find))].length, end: [...para.text.slice(0, para.text.indexOf(find))].length + [...find].length } },
      write: ['propose_changes', { proposals: [{ ref: para.ref, find, replace: '판단된다', reason: '단정 표현으로' }] }] },
    { label: '차례 새로 고침', body: { kind: 'instruct', instruction: '차례 새로고침해줘', target: { ref: para.ref } }, write: ['propose_toc_update', {}] },
    { label: '서식 지시(숫자만 굵게)', body: { kind: 'instruct', instruction: '이 문단의 숫자만 굵게 해 줘', target: { ref: para.ref } },
      write: ['propose_format', { ref: para.ref, find, format: { char: { bold: true } } }] },
    { label: '문서 전체 검토', body: { kind: 'review', instruction: '', target: { scope: 'document' } }, write: ['add_memo', { ref: para.ref, text: '근거 수치 확인 필요' }] },
  ];
  const summary = '요청한 표현을 고쳤습니다.';
  const flows = [];
  for (const c of cases) {
    const make = async () => (await api(`${route}/requests`, { method: 'POST', body: { ...c.body, route: 'queue' } })).request;
    // 기본: get_request → start_request → 쓰기 → complete_request
    const a = await make(); const ids = { doc_id: doc.id, request_id: a.rid, expected_attempt: 1 };
    const before = [];
    const g = await full.call('get_request', { doc_id: doc.id, request_id: a.rid }); before.push(['get_request', g.chars]);
    before.push(['start_request', (await full.call('start_request', ids)).chars]);
    before.push([c.write[0], (await full.call(c.write[0], { ...ids, ...c.write[1] })).chars]);
    before.push(['complete_request', (await full.call('complete_request', { ...ids, summary })).chars]);
    // lean: start_request(내용 포함) → 쓰기(complete)
    const b = await make(); const ids2 = { doc_id: doc.id, request_id: b.rid, expected_attempt: 1 };
    const after = [];
    const s = await lean.call('start_request', ids2); after.push(['start_request', s.chars]);
    const w = await lean.call(c.write[0], { ...ids2, ...c.write[1], complete: summary }); after.push([`${c.write[0]}(complete)`, w.chars]);
    const done = (await api(`${route}/requests/${b.rid}`)).status;
    if (done !== 'done' || w.json?.completed !== true) throw new Error(`${c.label}: lean 완료가 안 됨(${done}, ${w.text.slice(0, 120)})`);
    const sum = (steps) => steps.reduce((n, x) => n + x[1], 0);
    flows.push({ label: c.label, before: { calls: before.length, chars: sum(before), steps: before }, after: { calls: after.length, chars: sum(after), steps: after },
      reduction: `${Math.round(100 * (1 - sum(after) / sum(before)))}%`, contextParagraphs: g.json?.contextItems?.length ?? null });
  }
  const out = { at: new Date().toISOString(), source: 'tutorial/결과보고서.hwpx(사본, 임시 서버)', actualModelCalled: false, unit: '글자 수(JSON 글) — 모델 토큰이 아님', tools, flows };
  if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`); }
  console.log('도구 정의(글자 수)');
  for (const [k, v] of Object.entries(tools)) console.log(`  ${k}: ${v.count}개 ${v.before} → ${v.after} (${Math.round(100 * (1 - v.after / v.before))}% 줄임)`);
  console.log('요청 흐름(도구 호출 수 · 응답 글자 수)');
  for (const f of flows) {
    console.log(`  ${f.label}: ${f.before.calls}회 ${f.before.chars}자 → ${f.after.calls}회 ${f.after.chars}자 (${f.reduction} 줄임)`);
    console.log(`     기본: ${f.before.steps.map(([n, c]) => `${n} ${c}`).join(' · ')}`);
    console.log(`     lean: ${f.after.steps.map(([n, c]) => `${n} ${c}`).join(' · ')}`);
  }
} finally {
  for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); }
  await srv.stop();
}
