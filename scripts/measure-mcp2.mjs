// 모델을 부르지 않는다. 같은 문서·같은 지시를 예전 연결(기본·lean)과 새 연결(v2 — server/mcp2.js)로 받아 모델이 읽게 될 글의 크기를 견준다.
//   node scripts/measure-mcp2.mjs [--doc <hwpx>] [--instruction "<지시>"] [--json <결과 파일>] [--tokens]
// · 임시 서버(tests/helpers/server.mjs — 임시 data·config)에 문서 사본을 올린다. 기본 문서는 tutorial/결과보고서.hwpx.
// · --tokens: 이 PC 의 python tiktoken(o200k_base)으로 토큰 수도 센다(없으면 글자 수만). 글자 수·토큰 수는 모델 사용량이 아니다 —
//   모델은 부를 때마다 대화 전체(도구 정의 + 지침 + 지금까지의 도구 응답)를 다시 읽으므로 실제 입력은 '호출 수 × 그때까지 쌓인 글'이다.
// docs/MCP_REDESIGN_2026-11-16.md 의 표가 이 출력이다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, uploadDoc } from '../tests/helpers/server.mjs';
import { TOOL_PROFILES } from '../server/tool-profiles.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const docPath = path.resolve(opt('doc', path.join(root, 'tutorial', '결과보고서.hwpx')));
const instruction = opt('instruction', '문서 전체의 내용을 표로 만들고 불필요한 양식 및 개체는 삭제해줘');
const jsonOut = opt('json'); const wantTokens = argv.includes('--tokens');

/** 글 목록의 토큰 수(o200k_base — python tiktoken). 못 세면 null */
function countTokens(texts) {
  if (!wantTokens) return null;
  // 표준 입력은 UTF-8 바이트로 읽는다(Windows 의 python 표준 입력 기본 부호화는 UTF-8 이 아니다 — 그대로 읽으면 한글이 깨져 토큰 수가 부풀려진다)
  const code = 'import sys,json,tiktoken\ne=tiktoken.get_encoding("o200k_base")\nprint(json.dumps([len(e.encode(t)) for t in json.loads(sys.stdin.buffer.read().decode("utf-8"))]))';
  const r = spawnSync('python', ['-I', '-c', code], { input: JSON.stringify(texts), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const srv = await startServer({ ai: 'off' });
const clients = [];
async function connect(query) {
  const client = new Client({ name: 'measure-mcp2', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp${query}`), { requestInit: { headers: { Authorization: `Bearer ${srv.tokens.a}` } } });
  await client.connect(transport); clients.push({ client, transport });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return text;
  };
  return { client, call };
}
const toolsText = (tools, names) => JSON.stringify(tools.filter((t) => !names || names.includes(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));

try {
  const api = srv.api('a');
  const doc = await uploadDoc(srv.base, srv.tokens.a, docPath);
  const D = `/api/docs/${doc.id}`;
  const make = async () => (await api(`${D}/requests`, { method: 'POST', body: { kind: 'instruct', instruction, target: { scope: 'document', ref: 's0/p0' }, route: 'queue' } })).request;
  const paragraphs = await api(`${D}/paragraphs`);
  const plain = paragraphs.filter((p) => p.text.trim()).map((p) => p.text).join('\n');
  const full = await connect(''); const lean = await connect('?lean=1'); const v2 = await connect('?v=2&tools=core'); const v2all = await connect('?v=2');
  const fullTools = (await full.client.listTools()).tools; const leanTools = (await lean.client.listTools()).tools;
  const v2Tools = (await v2.client.listTools()).tools; const v2AllTools = (await v2all.client.listTools()).tools;

  const items = [];   // { group, label, text, count? }
  const add = (group, label, text, extra = {}) => items.push({ group, label, text, ...extra });
  add('도구 정의', '예전 연결 — 전체', toolsText(fullTools), { tools: fullTools.length });
  add('도구 정의', '예전 연결 — Codex 실행기가 주는 도구', toolsText(fullTools, TOOL_PROFILES.codex), { tools: fullTools.filter((t) => TOOL_PROFILES.codex.includes(t.name)).length });
  add('도구 정의', '예전 연결 — lean(채널 에이전트)', toolsText(leanTools), { tools: leanTools.length });
  add('도구 정의', '새 연결 — 전체(사람이 정할 일·변경 요청·멀티에이전트 포함)', toolsText(v2AllTools), { tools: v2AllTools.length });
  add('도구 정의', '새 연결 — 작업 도구(Codex 실행기)', toolsText(v2Tools), { tools: v2Tools.length });
  add('서버 안내', '예전 연결 lean', lean.client.getInstructions() || '');
  add('서버 안내', '새 연결', v2.client.getInstructions() || '');

  // 요청 내용
  const a = await make();
  add('요청 내용', '예전 연결 get_request(Codex 실행기의 첫 입력에 통째로 실린다)', await full.call('get_request', { doc_id: doc.id, request_id: a.rid }));
  add('요청 내용', '예전 연결 lean start_request', await lean.call('start_request', { doc_id: doc.id, request_id: a.rid }));
  await api(`${D}/requests/${a.rid}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  const b = await make();
  const brief = await v2.call('task', {});
  add('요청 내용', '새 연결 task', brief);

  // 문서 전체 읽기
  let cursor; let pages = 0; let all = '';
  do {
    const text = await lean.call('read_document', { doc_id: doc.id, ...(cursor ? { cursor } : {}) });
    pages++; all += `${text}\n`;
    const m = /이어 읽기: (\{.*\})\s*$/.exec(text); cursor = m ? JSON.parse(m[1]).cursor : null;
  } while (cursor && pages < 200);
  add('문서 전체 읽기', `예전 연결 read_document(${pages}번 호출)`, all, { calls: pages });
  let cur; let pages2 = 0; let all2 = '';
  do {
    const text = await v2.call('read', { doc_id: doc.id, ...(cur ? { cursor: cur } : {}) });
    pages2++; all2 += `${text}\n`;
    cur = /cursor='(text:\d+:\d+)'/.exec(text)?.[1] || null;
  } while (cur && pages2 < 200);
  add('문서 전체 읽기', `새 연결 read view=text(${pages2}번 호출)`, all2, { calls: pages2 });
  const layout = await v2.call('read', { doc_id: doc.id, view: 'layout' });
  add('문서 전체 읽기', '새 연결 read view=layout(요약)', layout);
  add('문서 전체 읽기', '문서의 글만(문단 글을 줄바꿈으로 이은 것)', plain);

  // 새 연결의 쓰기 영수증(떠 있는 글상자 문서면 개체 → 본문, 아니면 메모 한 건)
  const floating = /⚠/.test(JSON.parse(brief).map || '');
  const ops = floating ? [{ op: 'objects_to_body' }] : [{ op: 'memo', at: 's0/p0', text: '측정용 의견' }];
  if (floating) add('쓰기', '새 연결 edit(objects_to_body, dry_run)', await v2.call('edit', { doc_id: doc.id, request_id: b.rid, ops, dry_run: true }));
  add('쓰기', `새 연결 edit(${floating ? 'objects_to_body' : 'memo'}, done)`, await v2.call('edit', { doc_id: doc.id, request_id: b.rid, ops, done: '측정용 요약입니다.' }));

  const tokens = countTokens(items.map((x) => x.text));
  const rows = items.map((x, i) => ({ group: x.group, label: x.label, chars: x.text.length, ...(tokens ? { tokens: tokens[i] } : {}), ...(x.tools ? { tools: x.tools } : {}), ...(x.calls ? { calls: x.calls } : {}) }));
  const out = { at: new Date().toISOString(), document: path.basename(docPath), documentBytes: fs.statSync(docPath).size, paragraphs: paragraphs.length, instruction, actualModelCalled: false,
    unit: tokens ? '글자 수와 o200k_base 토큰 수(모델 사용량 아님)' : '글자 수(모델 사용량 아님)', floating, rows };
  if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`); }
  let group = null;
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`\n[${group}]`); }
    console.log(`  ${r.label}: ${r.chars.toLocaleString('ko-KR')}자${r.tokens != null ? ` · ${r.tokens.toLocaleString('ko-KR')}토큰` : ''}${r.tools ? ` · 도구 ${r.tools}개` : ''}`);
  }
} finally {
  for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); }
  await srv.stop();
}
