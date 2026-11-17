// v0.2 서버 시험(docs/V2_SPEC.md §3·§5): 임시 data 폴더 + 모의 AI + 포트 8796.
//   1부(모의 AI 켬): 첨부·요청 종류 전부·여러 안 적용/복구·다시 열기·고쳐서 적용·직접 고쳐 쓰기·메모 고치기/권한·
//                    요약 보존·지시 원문 숨김·참조 재매김·표 채우기/만들기·버전 복구·편집본 병합·옛 meta.json
//   2부(AI 끔, 같은 data 폴더로 다시 띄움): 대기열 → MCP 도구로 처리, 취소·다시 요청
// 저장소의 사용자 config 파일은 읽지 않는다 — 임시 폴더에 data 와 임시 config(관리자 + 편집자 2, 토큰은 매번 새로)를 만들어
// HWPX_COWORK_CONFIG 로 띄운다(받침 tests/helpers/server.mjs 와 같은 꼴, 포트는 고정 8796). 사용자 자료(data/)는 쓰지 않고,
// '옛 meta.json' 절에서 사용자 문서 하나를 임시 data 폴더로 베낄 때만 읽는다(없으면 그 절을 건너뜀).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = 8796; const BASE = `http://127.0.0.1:${PORT}`;
// 서버가 알리는 판(/api/config version) = package.json 판(0.2.0 → 0.3.0 처럼 판을 올려도 이 시험은 그대로)
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;

const BIZ = path.resolve(root, 'tests', 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx');
const USER_DOC = path.join(root, 'data/docs/mvht6tkp816276');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-v2-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir);
const users = [{ name: '관리자', role: 'admin' }, { name: '홍길동', role: 'editor' }, { name: '김검토', role: 'editor' }]
  .map((u) => ({ ...u, token: crypto.randomBytes(16).toString('hex') }));
const configPath = path.join(tmpDir, 'config.json');
// changeRequests 구역은 일부러 두지 않는다: v0.2 설정 → 편집자도 '기준에 바로 적용'·편집본 올리기(이 시험이 확인하는 v0.2 계약).
// 서버 AI 는 config 에서 끄고(키 파일은 없는 경로 — 실제 API 를 부르지 않는다) 1부만 HWPX_COWORK_AI_MOCK=1 로 모의 AI 를 켠다
fs.writeFileSync(configPath, JSON.stringify({
  host: '127.0.0.1', port: PORT, dataDir: './data', allowAgentApply: true, users,
  ai: { enabled: false, mock: false, keyFile: path.join(tmpDir, 'no-such-key.txt'), model: 'claude-opus-5-5', effort: 'medium', maxProposals: 10 },
  // v0.4: 기본 편집 방식은 실시간(V4 §1) — 이 시험은 v0.2 계약(변경 추적으로 적용·되돌리기·편집본 병합 마크업·자세한 작업 기록 메모)을 보므로
  // 문서 기본값을 승인 방식·자세한 메모로 둔다(실시간 문서는 tests/api_live.mjs)
  documents: { defaultEditMode: 'review', defaultAiMemo: 'detail' },
  // MCP 기본 연결: 운영 기본은 새 연결(v2 — 2026-11-17)이지만 이 시험은 예전 연결 도구(read_document·propose_changes 등)의 계약을 잰다 — tests/helpers/server.mjs 와 같다
  mcp: { defaultSurface: 'v1' },
}, null, 1));
const admin = users[0]; const A = users[1]; const B = users[2];

fs.mkdirSync(path.join(root, 'tests/out'), { recursive: true });
const logFile = path.join(root, 'tests/out/api_v2_server.log');
fs.writeFileSync(logFile, '');

// 밖(process.env)의 HWPX_COWORK_*(CONFIG·AI_MOCK·AI 등)는 넘기지 않는다
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HWPX_COWORK_/i.test(k)));
let child = null;
function startServer(mock) {
  const fd = fs.openSync(logFile, 'a');
  // 첨부 한도는 시험용으로 8MB(413 경로를 실제로 확인; 시험 첨부는 모두 그보다 작다)
  const env = { ...baseEnv, HWPX_COWORK_CONFIG: configPath, HWPX_COWORK_PORT: String(PORT), HWPX_COWORK_HOST: '127.0.0.1', HWPX_COWORK_DATA_DIR: dataDir, HWPX_COWORK_ATTACH_MAX_BYTES: String(8 * 1048576) };
  if (mock) env.HWPX_COWORK_AI_MOCK = '1';
  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', fd, fd] });
}
async function stopServer() {
  if (!child) return;
  const c = child; child = null;
  await new Promise((r) => { c.once('exit', r); try { c.kill(); } catch { r(); } setTimeout(r, 3000); });
}
process.on('exit', () => { try { child?.kill(); } catch { /* ignore */ } try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function waitUp() {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return r.json(); } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('서버가 뜨지 않음');
}
async function call(p, { method = 'GET', body, raw, token = A.token, headers = {} } = {}) {
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let b = body;
  if (body !== undefined && !raw) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  if (raw && !h['Content-Type']) h['Content-Type'] = 'application/octet-stream';
  const r = await fetch(`${BASE}${p}`, { method, headers: h, body: b });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, headers: r.headers };
}
async function api(p, opts) {
  const r = await call(p, opts);
  if (r.status < 200 || r.status >= 300) throw new Error(`${opts?.method || 'GET'} ${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}
let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const cp = (s) => [...s].length;
const cpIndex = (s, sub) => { const i = s.indexOf(sub); return i < 0 ? -1 : cp(s.slice(0, i)); };
const paras = async (id, view = 'final') => api(`/api/docs/${id}/paragraphs?view=${view}`);
const textOf = async (id, ref) => (await paras(id)).find((p) => p.ref === ref)?.text;
const memoOf = async (id, memoId, token = A.token) => (await api(`/api/docs/${id}/memos`, { token })).find((m) => m.id === memoId);
const upload = (id, name, bytes, token = A.token) => api(`/api/docs/${id}/attachments`, { method: 'POST', body: bytes, raw: true, token, headers: { 'x-file-name': encodeURIComponent(name) } });

// ── 시험 자료 만들기 ──
async function makeXlsx(table) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('응답률');
  // 문서 표의 머리행·첫 열을 그대로, 본문 칸은 원래 값 + 1000
  const grid = Array.from({ length: table.rows }, () => Array(table.cols).fill(''));
  for (const c of table.cells) grid[c.row][c.col] = c.text;
  grid.forEach((row, r) => ws.addRow(row.map((v, c) => (r > 0 && c > 0 && /^\d+$/.test(v) ? Number(v) + 1000 : v))));
  ws.getCell('H2').value = { formula: 'B2*2', result: 2536 };
  ws.getCell('H3').value = new Date(Date.UTC(2025, 2, 4));
  const ws2 = wb.addWorksheet('메모'); ws2.addRow(['비고']); ws2.addRow(['둘째 시트']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const cell = (t) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>`
    + '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>기준표 설명</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> &amp; 주석</w:t></w:r></w:p>'
    + `<w:tbl><w:tblPr/><w:tr>${cell('구분')}${cell('2025')}</w:tr><w:tr>${cell('학부')}${cell('1,234')}</w:tr></w:tbl>`
    + '<w:p><w:r><w:t>끝 문단</w:t></w:r></w:p></w:body></w:document>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** 옛 meta.json(attachments·seq.attachment 없음) 그대로 사용자 문서 사본을 임시 data 폴더에 둔다 */
function seedOldDoc() {
  if (!fs.existsSync(path.join(USER_DOC, 'meta.json'))) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(USER_DOC, 'meta.json'), 'utf-8'));
  const d = path.join(dataDir, 'docs', meta.id);
  fs.mkdirSync(path.join(d, 'versions'), { recursive: true });
  fs.copyFileSync(path.join(USER_DOC, 'current.hwpx'), path.join(d, 'current.hwpx'));
  for (const f of fs.readdirSync(path.join(USER_DOC, 'versions'))) fs.copyFileSync(path.join(USER_DOC, 'versions', f), path.join(d, 'versions', f));
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta, null, 1));
  return meta.id;
}

function watch(id, token = A.token) {
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}&doc=${id}`);
  ws.on('message', (m) => { try { msgs.push(JSON.parse(String(m))); } catch { /* ignore */ } });
  return { msgs, ready: new Promise((r) => ws.once('open', r)), close: () => ws.close() };
}

async function mcpClient(user, agent = 'Claude') {
  const client = new Client({ name: 'claude-ai', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?agent=${agent}`), { requestInit: { headers: { Authorization: `Bearer ${user.token}` } } }));
  const tool = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`MCP ${name}: ${r.content[0].text}`);
    return r;
  };
  const json = async (name, args) => JSON.parse((await tool(name, args)).content[0].text);
  return { client, tool, json };
}

const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/tool_memo_tracked.hwpx'));
const original = await HwpxDoc.load(fixture);
const origTexts = original.sections[0].bodyParas.map((_, i) => original.text(`s0/p${i}`));

/** 서버 AI 실제 모드의 요청 모양(가짜 fetch — 네트워크·키 없음) */
async function checkRealModeShape() {
  section('서버 AI 실제 모드 요청 모양(가짜 fetch, 네트워크 없음)');
  const { AiProposer } = await import('../server/ai.js');
  const calls = [];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  let next = 'ok';
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const base = { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null, usage: { input_tokens: 123, output_tokens: 45 } };
    if (next === 'refusal') return reply({ ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } });
    const out = { proposals: [{ ref: 's0/p1', find: '있던', replace: '남아 있던', reason: '뜻 분명히' }], alternatives: [], comments: [{ ref: 's0/p1', find: '', text: '의견' }], inserts: [], tables: [], summary: '공유 요약', instructionSummary: '한 줄 요약' };
    return reply({ ...base, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn' });
  };
  const real = new AiProposer({ ai: { enabled: true, model: 'claude-opus-5-5', effort: 'medium' } }, { key: 'sk-test-not-real', fetch: fakeFetch });
  const input = {
    kind: 'review', preset: null, label: 'AI 검토', instruction: '', target: { ref: 's0/p1', start: 0, end: 5, text: '둘째 문단', refs: ['s0/p1'] },
    context: [{ ref: 's0/p0', where: '본문', text: '첫째', isTarget: false }, { ref: 's0/p1', where: '본문', text: '둘째 문단', isTarget: true }],
    tables: [], options: { count: 3 }, docTitle: '시험',
    attachments: [{ aid: 'a1', name: '기준표.pdf', kind: 'pdf', mime: 'application/pdf', base64: 'JVBERi0xLjQK' }, { aid: 'a2', name: '그림.png', kind: 'image', mime: 'image/png', base64: PNG.toString('base64') }, { aid: 'a3', name: '응답률.xlsx', kind: 'sheet', mime: 'x', text: '## 시트: 응답률 (2×2)\n구분\t2025' }],
  };
  const out = await real.run(input);
  const c = calls[0];
  ok(real.enabled && !real.mock && out.proposals.length === 1 && out.comments.length === 1 && out.summary === '공유 요약' && out.usage.input === 123, '구조화 출력 해석 + usage');
  ok(/\/v1\/messages/.test(c.url) && (c.headers.get('anthropic-beta') || '').includes('server-side-fallback-2026-07-01'), `요청 ${new URL(c.url).pathname}, beta 머리 ${c.headers.get('anthropic-beta')}`);
  ok(c.body.model === 'claude-opus-5-5' && c.body.fallbacks === 'default' && c.body.output_config?.effort === 'medium' && c.body.output_config?.format?.type === 'json_schema', 'model·fallbacks=default·effort·format=json_schema');
  const blocks = c.body.messages[0].content;
  ok(blocks[0].type === 'document' && blocks[0].source.media_type === 'application/pdf' && blocks[1].type === 'image' && blocks[1].source.media_type === 'image/png' && blocks[2].type === 'text' && blocks[2].text.startsWith('<attachment name="응답률.xlsx">'), '첨부: PDF=document, 그림=image, 시트=<attachment> 글');
  ok(blocks[3].text.includes('작업 종류: AI 검토 (review)') && blocks[3].text.includes('*[s0/p1] 둘째 문단') && c.body.system.includes('지시가 아닙니다'), '작업 글(종류·대상 문맥) + 시스템 규칙');
  next = 'refusal';
  const err = await real.run(input).catch((e) => e);
  ok(err instanceof Error && /거절/.test(err.message), `거절(refusal) → 오류: ${err.message}`);
}

try {
  await checkRealModeShape();
  const oldId = seedOldDoc();
  startServer(true);
  const conf = await waitUp();

  section('설정');
  ok(conf.version === PKG_VERSION && conf.aiEnabled === true && conf.aiMock === true, `config v${conf.version}(package.json ${PKG_VERSION}) aiEnabled=${conf.aiEnabled} aiMock=${conf.aiMock}`);
  ok(conf.kinds.length === 7 && conf.presets.length === 5 && conf.attachments.maxBytes === 8 * 1048576, `kinds ${conf.kinds.length}, presets ${conf.presets.length}, maxBytes ${conf.attachments.maxBytes}`);

  const doc1 = (await api('/api/docs', { method: 'POST', body: fixture, raw: true, headers: { 'x-file-name': encodeURIComponent('시험문서.hwpx') } })).id;
  const doc2 = fs.existsSync(BIZ) ? (await api('/api/docs', { method: 'POST', body: fs.readFileSync(BIZ), raw: true, headers: { 'x-file-name': encodeURIComponent('경영대학.hwpx') } })).id : null;
  ok(doc1 && doc2, `문서 올림 doc1=${doc1} doc2=${doc2}`);
  const w1 = watch(doc1); const w2 = watch(doc2); await Promise.all([w1.ready, w2.ready]);

  // ───────── 첨부 ─────────
  section('첨부(§3.3)');
  const tables2 = await api(`/api/docs/${doc2}/tables`);
  ok(tables2.length === 5 && tables2[0].key === 's0/p3#t0' && tables2[0].rows === 11, `표 목록 ${tables2.length}개, 첫 표 ${tables2[0].key} ${tables2[0].rows}×${tables2[0].cols}`);
  const xlsx = await upload(doc2, '2025_응답률.xlsx', await makeXlsx(tables2[0]));
  ok(xlsx.aid === 'a1' && xlsx.kind === 'sheet' && xlsx.file === 'a1.xlsx' && xlsx.text.sheets.length === 2, `xlsx 올림 ${xlsx.aid} ${xlsx.file} 시트 ${xlsx.text.sheets.map((s) => `${s.name}(${s.rows}×${s.cols})`).join(',')}`);
  const xt = await api(`/api/docs/${doc2}/attachments/a1/text?max=5000`);
  ok(xt.text.startsWith('## 시트: 응답률 (11×8)') && xt.text.includes('구분\t2021년') && xt.text.includes('경영대학(학부)\t1268') && xt.text.includes('2536') && xt.text.includes('2025-03-04') && xt.text.includes('## 시트: 메모 (2×1)'), 'xlsx 글: 시트 머리·탭 구분 행·수식 결과·날짜');
  const csv = await upload(doc2, '기준.csv', Buffer.from('\uFEFF구분,2025\n"학부, 본교",1234\n', 'utf-8'));
  const ct = await api(`/api/docs/${doc2}/attachments/${csv.aid}/text`);
  ok(csv.kind === 'sheet' && ct.text === '## 시트: 기준 (2×2)\n구분\t2025\n학부, 본교\t1234', `csv(BOM·따옴표) → ${JSON.stringify(ct.text)}`);
  let iconv = null; try { iconv = (await import('iconv-lite')).default; } catch { /* 없음 */ }
  if (iconv) {
    const ek = await upload(doc2, 'euckr.csv', iconv.encode('학과,인원\n경영,10\n', 'euc-kr'));
    ok((await api(`/api/docs/${doc2}/attachments/${ek.aid}/text`)).text.includes('경영\t10'), 'EUC-KR csv 재시도 디코딩');
  }
  const docx = await upload(doc2, '기준표.docx', await makeDocx());
  const dt = await api(`/api/docs/${doc2}/attachments/${docx.aid}/text`);
  ok(dt.text === '기준표 설명\t & 주석\n구분\t2025\n학부\t1,234\n끝 문단', `docx(문단 + 표 탭 구분, 탭 정의 무시) → ${JSON.stringify(dt.text)}`);
  const png = await upload(doc2, '그림.png', PNG);
  ok(png.kind === 'image' && png.text === null && png.mime === 'image/png', 'png 올림(글 없음)');
  const evil = await upload(doc2, '../../evil.txt', Buffer.from('평범한 글'));
  ok(evil.name === 'evil.txt' && /^a\d+\.txt$/.test(evil.file), `경로 조각 이름 → name=${evil.name} file=${evil.file}`);
  const dl = await call(`/api/docs/${doc2}/attachments/a1`);
  ok(dl.status === 200 && Buffer.compare(dl.data, await (async () => { const r = await call(`/api/docs/${doc2}/attachments/a1`); return r.data; })()) === 0 && dl.headers.get('content-type') === 'application/octet-stream' && dl.headers.get('x-content-type-options') === 'nosniff' && /attachment; filename\*=UTF-8''2025_/.test(dl.headers.get('content-disposition')), 'xlsx 내려받기: octet-stream + nosniff + attachment');
  const dlp = await call(`/api/docs/${doc2}/attachments/${png.aid}`);
  ok(dlp.headers.get('content-type') === 'image/png' && Buffer.compare(dlp.data, PNG) === 0, '그림 내려받기: image/png, 같은 바이트');
  ok((await call(`/api/docs/${doc2}/attachments/${evil.aid}`, { method: 'DELETE', token: B.token })).status === 403, '남의 첨부 삭제 → 403');
  await api(`/api/docs/${doc2}/attachments/${evil.aid}`, { method: 'DELETE' });
  ok(!(await api(`/api/docs/${doc2}/attachments`)).some((a) => a.aid === evil.aid), '내 첨부 삭제');
  ok((await call(`/api/docs/${doc2}/attachments`, { method: 'POST', body: Buffer.alloc(0), raw: true, headers: { 'x-file-name': 'x.txt' } })).status === 400, '빈 파일 → 400');
  const big = await call(`/api/docs/${doc2}/attachments`, { method: 'POST', body: Buffer.alloc(8 * 1048576 + 1024, 65), raw: true, headers: { 'x-file-name': 'big.txt' } });
  ok(big.status === 413 && big.data?.error === 'TOO_LARGE', `한도(8MB, HWPX_COWORK_ATTACH_MAX_BYTES) 넘는 첨부 → 413 ${big.data?.error}`);

  // ───────── 문장 제안(여러 안) ─────────
  section('문장 제안 → 여러 안 적용·복구·다시 열기·고쳐서 적용(§3.4·§3.5)');
  const p0 = await textOf(doc1, 's0/p0');
  const sel = '메모 대상 문장이 여기 있습니다.'; const s0 = cpIndex(p0, sel);
  ok((await call(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'suggest', target: { ref: 's0/p0', start: s0, end: s0 + cp(sel), text: '다른 글' } } })).status === 409, '선택 글이 다르면 409 STALE');
  ok((await call(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'nope', target: { ref: 's0/p0' } } })).status === 400, '없는 종류 → 400');
  const bad = await fetch(`${BASE}/api/docs/${doc1}/requests`, { method: 'POST', headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' }, body: '{"kind":' });
  ok(bad.status === 400 && (await bad.json()).error === 'BAD_JSON', '깨진 JSON → 400 BAD_JSON');
  const v0 = (await api(`/api/docs/${doc1}`)).version;
  const sg = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'suggest', instruction: '더 매끄럽게', target: { ref: 's0/p0', start: s0, end: s0 + cp(sel), text: sel, refs: ['s0/p0'] }, options: { count: 3 } } });
  const rid1 = sg.request.rid;
  ok((await api(`/api/docs/${doc1}`)).version === v0 + 1, `요청 하나(메모 + 안 3개) = 버전 하나 (v${v0} → v${v0 + 1})`);
  ok(sg.queued === false && sg.request.status === 'done' && sg.proposals.length === 3, `suggest #${rid1}: 안 ${sg.proposals.length}개, 상태 ${sg.request.status}`);
  ok(sg.proposals.every((p) => p.gid === rid1 && p.memo === false && p.find === sel) && sg.proposals.map((p) => p.option).join() === '1,2,3', '같은 gid, option 1..3, 제안 메모 없음');
  ok(sg.proposals.every((p) => p.replace !== sel && !/\(안\s*\d\)/.test(p.replace)), `안 글: ${sg.proposals.map((p) => p.replace).join(' / ')}`);
  ok(sg.request.summary.startsWith('(모의 AI)') && sg.request.summaryBy === 'ai', `AI 요약: ${sg.request.summary}`);
  let rm = await memoOf(doc1, sg.request.memoId);
  ok(rm && rm.link?.type === 'request' && rm.link.rid === rid1 && rm.text.startsWith(`[AI 작업 #${rid1}] 문장 제안 · 요청 ${A.name} · 처리 모의 AI`), `작업 기록 메모 ${rm.id}: ${rm.text.split('\n')[0]}`);
  ok(rm.text.includes(`\n요약: ${sg.request.summary}`) && rm.text.includes('\n결과: 안 3개') && /\n이력: \d\d-\d\d \d\d:\d\d 요청\(/.test(rm.text) && !rm.text.includes('지시:') && !rm.text.includes('더 매끄럽게'), '메모에 요약·결과·이력, 지시 원문은 없음');
  ok(rm.start === s0 && rm.end === s0 + cp(sel) && rm.body === sg.request.summary && rm.editable === true, `메모 범위 ${rm.start}..${rm.end}, body=요약, editable`);
  const [o1, o2, o3] = sg.proposals;
  const ap = await api(`/api/docs/${doc1}/proposals/${o2.pid}/apply`, { method: 'POST' });
  ok(ap.status === 'applied' && (await textOf(doc1, 's0/p0')).includes(o2.replace), `안 2 적용 → ${await textOf(doc1, 's0/p0')}`);
  let props = await api(`/api/docs/${doc1}/proposals`);
  ok(props.filter((p) => p.gid === rid1 && p.pid !== o2.pid).every((p) => p.status === 'superseded' && p.supersededBy === o2.pid), '나머지 안 superseded');
  ok((await call(`/api/docs/${doc1}/proposals/${o1.pid}/apply`, { method: 'POST' })).status === 409, '대체된 안 적용 → 409');
  // 작업 기록 메모(V3 §9.3): 반영한 것만 적고(안 2), 마지막 남은 항목을 정했으니 해결 줄 — 이력 줄은 요청 생애 기록만(제안 하나하나의 적용·복구는 요청 log 에만)
  rm = await memoOf(doc1, sg.request.memoId);
  ok(rm.text.includes('결과: 안 3개 중 안 2 반영') && rm.text.includes('\n · 안 2: 「') && rm.text.includes(`\n✓ 해결 · ${A.name} `) && rm.text.includes(`해결(${A.name})`) && !rm.text.includes('안 2 적용('), '메모: 안 2 반영 결과 + 해결 줄(이력에 제안 적용은 없음)');
  const ud = await api(`/api/docs/${doc1}/proposals/${o2.pid}/undo`, { method: 'POST' });
  props = await api(`/api/docs/${doc1}/proposals`);
  ok(ud.status === 'undone' && (await textOf(doc1, 's0/p0')) === p0 && props.filter((p) => p.gid === rid1 && p.pid !== o2.pid).every((p) => p.status === 'pending'), '복구 → 원문, 나머지 안 다시 pending');
  const rmU = (await memoOf(doc1, sg.request.memoId)).text;
  ok(rmU.includes('결과: 안 3개 — 고르는 중') && rmU.includes(`다시 열림(${A.name})`) && !rmU.includes('✓ 해결') && (await api(`/api/docs/${doc1}/requests/${rid1}`)).log.some((l) => l.action === 'undo' && l.detail === '안 2 복구'),
    '복구 → 해결 풀림(메모 이력: 다시 열림, 결과: 고르는 중), 안 2 복구는 요청 log 에');
  const ro = await api(`/api/docs/${doc1}/proposals/${o2.pid}/reopen`, { method: 'POST' });
  ok(ro.status === 'pending', '다시 열기 → pending');
  const edited3 = `${sel.replace('.', '')}(고친 안).`;
  const pt = await api(`/api/docs/${doc1}/proposals/${o3.pid}`, { method: 'PATCH', body: { replace: edited3 } });
  ok(pt.replace === edited3 && pt.log.some((l) => l.action === 'edit'), '안 3 고치기(PATCH replace)');
  await api(`/api/docs/${doc1}/proposals/${o3.pid}/apply`, { method: 'POST' });
  ok((await textOf(doc1, 's0/p0')).includes('(고친 안)'), '고쳐서 적용 → 본문 반영');
  ok((await call(`/api/docs/${doc1}/proposals/${o3.pid}`, { method: 'PATCH', body: { replace: 'x' } })).status === 409, '적용된 제안의 replace 고치기 → 409');
  await api(`/api/docs/${doc1}/proposals/${o3.pid}/undo`, { method: 'POST' });
  ok((await textOf(doc1, 's0/p0')) === p0, '안 3 복구 → 원문');
  const ap1 = await api(`/api/docs/${doc1}/proposals/${o1.pid}/apply`, { method: 'POST' });
  for (const cid of [...ap1.changeIds].sort((a, b) => b - a)) await api(`/api/docs/${doc1}/changes/${cid}/reject`, { method: 'POST' });
  props = await api(`/api/docs/${doc1}/proposals`);
  ok(props.find((p) => p.pid === o1.pid).status === 'undone' && props.find((p) => p.pid === o2.pid).status === 'pending' && props.find((p) => p.pid === o3.pid).status === 'undone' && (await textOf(doc1, 's0/p0')) === p0, '변경 탭에서 안 1 의 변경을 거절 → 안 1 복구 상태, 대체됐던 안 2 다시 대기(안 3 은 그대로 복구)');

  // ───────── 검토·다듬기·지시·문단 추가 ─────────
  section('검토·다듬기·지시·문단 추가 + 참조 재매김(§2.3)');
  const rv = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' } } });
  ok(rv.request.status === 'done' && rv.comments.length === 1 && rv.proposals.length === 1 && rv.proposals[0].memo === false, `review #${rv.request.rid}: 의견 ${rv.comments.length}, 제안 ${rv.proposals.length}(대상 문단이라 제안 메모 없음)`);
  const cm = rv.comments[0];
  ok(cm.link?.type === 'comment' && cm.text.startsWith(`[AI 의견 · 작업 #${rv.request.rid}] ${A.name}(모의 AI)`), `AI 의견 메모: ${cm.text.split('\n')[0]}`);
  ok((await memoOf(doc1, rv.request.memoId)).text.includes('결과: 남은 제안 1건 · 의견 1건'), '작업 기록: 남은 제안 1건 · 의견 1건');
  const pl = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'polish', preset: 'concise', target: { ref: 's0/p2' } } });
  ok(pl.request.label === '다듬기(간결하게)' && pl.proposals.length === 1, `polish(${pl.request.label}) 제안 ${pl.proposals.length}건: 「${pl.proposals[0]?.find}」→「${pl.proposals[0]?.replace}」`);
  const fc = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'polish', preset: 'factcheck', target: { ref: 's0/p1' } } });
  ok(fc.comments.length === 1 && fc.proposals.length === 0, 'polish(factcheck) → 의견 위주');
  const ins = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '이 문단 뒤에 설명 문단을 추가해 주세요 (비공개 메모)', target: { ref: 's0/p2' }, options: { includeInstruction: true } } });
  ok(ins.proposals.some((p) => p.type === 'insert') && ins.comments.length === 1, `instruct: ${ins.proposals.map((p) => p.type).join(',')} + 의견 ${ins.comments.length}`);
  const insMemo = await memoOf(doc1, ins.request.memoId);
  ok(insMemo.text.includes('지시: 이 문단 뒤에 설명 문단을 추가해 주세요'), '지시 원문 공유(includeInstruction) → 메모에 지시 줄');
  const listB = await api(`/api/docs/${doc1}/requests`, { token: B.token });
  const insB = listB.find((r) => r.rid === ins.request.rid);
  ok(insB.instruction === null && insB.instructionHidden === true, '다른 사람의 요청 목록: instruction 숨김');
  ok((await api(`/api/docs/${doc1}/requests`, { token: admin.token })).find((r) => r.rid === ins.request.rid).instruction.includes('비공개'), '관리자는 지시 원문을 본다');
  ok((await api(`/api/docs/${doc1}/requests?status=done`)).length >= 5, 'GET requests?status=done');
  // 문단 추가 + 참조 재매김: 뒤 문단의 대기 제안(메모 없음)이 문단 추가 적용 뒤에도 맞는 글에 적용되는지
  const later = await api(`/api/docs/${doc1}/proposals`, { method: 'POST', body: { ref: 's0/p2', find: '셋째 문단은', replace: '셋째 문단은 이제', memo: false } });
  ok(later.memo === false && !later.memoId, `뒤 문단 대기 제안 #${later.pid}(메모 없음) @${later.ref}`);
  const insq = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'insert', target: { ref: 's0/p0' } } });
  const ip = insq.proposals.find((p) => p.type === 'insert');
  ok(ip && ip.afterRef === 's0/p0', `insert 요청 → 문단 추가 제안 #${ip?.pid} after ${ip?.afterRef}`);
  const nBefore = (await paras(doc1)).filter((p) => p.where === '본문').length;
  const ipa = await api(`/api/docs/${doc1}/proposals/${ip.pid}/apply`, { method: 'POST' });
  const bodyNow = (await paras(doc1)).filter((p) => p.where === '본문');
  ok(ipa.insertedRef === 's0/p1' && bodyNow.length === nBefore + 1 && bodyNow[1].text === ip.text, `문단 추가 적용 → ${ipa.insertedRef} 「${bodyNow[1].text}」`);
  const later2 = (await api(`/api/docs/${doc1}/proposals`)).find((p) => p.pid === later.pid);
  ok(later2.ref === 's0/p3', `뒤 문단 제안 ref 재매김 s0/p2 → ${later2.ref}`);
  ok((await api(`/api/docs/${doc1}/requests`)).find((r) => r.rid === ins.request.rid).target.ref === 's0/p3', '요청 target.ref 도 재매김');
  await api(`/api/docs/${doc1}/proposals/${later.pid}/apply`, { method: 'POST' });
  ok((await textOf(doc1, 's0/p3')).startsWith('셋째 문단은 이제 AI 제안대로'), '재매김된 제안이 맞는 문단에 적용');
  const ipu = await api(`/api/docs/${doc1}/proposals/${ip.pid}/undo`, { method: 'POST' });
  ok(ipu.status === 'undone' && (await paras(doc1)).filter((p) => p.where === '본문').length === nBefore, '문단 추가 복구 → 빈 문단 지움');
  ok((await api(`/api/docs/${doc1}/proposals`)).find((p) => p.pid === later.pid).ref === 's0/p2', '문단을 지운 뒤 ref 다시 s0/p2');

  // ───────── 직접 고쳐 쓰기(applyNow) ─────────
  section('직접 고쳐 쓰기(applyNow) → 복구');
  const p1t = await textOf(doc1, 's0/p1'); const at1 = cpIndex(p1t, '있던');
  const dn = await api(`/api/docs/${doc1}/proposals`, { method: 'POST', body: { ref: 's0/p1', start: at1, end: at1 + 2, replace: '남아 있던', applyNow: true } });
  ok(dn.status === 'applied' && dn.memo === false && dn.find === '있던' && (await textOf(doc1, 's0/p1')).includes('남아 있던'), `applyNow → 적용 #${dn.pid}, 메모 없음`);
  await api(`/api/docs/${doc1}/proposals/${dn.pid}/undo`, { method: 'POST' });
  ok((await textOf(doc1, 's0/p1')) === p1t, '직접 고침 복구 → 원문');
  const ef = await api(`/api/docs/${doc1}/proposals`, { method: 'POST', body: { ref: 's0/p1', start: cp(p1t), end: cp(p1t), replace: ' 끝.', applyNow: true } });
  ok(ef.find === '' && (await textOf(doc1, 's0/p1')).endsWith(' 끝.'), '빈 범위(find="") 삽입 applyNow');
  await api(`/api/docs/${doc1}/proposals/${ef.pid}/undo`, { method: 'POST' });

  // ───────── 메모 고치기·권한 ─────────
  section('메모 PATCH(§3.6) + 권한');
  const pm = await api(`/api/docs/${doc1}/memos/${sg.request.memoId}`, { method: 'PATCH', body: { text: '사람이 고친 공유 요약' } });
  ok(pm.link.type === 'request' && pm.body === '사람이 고친 공유 요약' && pm.text.includes('\n요약: 사람이 고친 공유 요약\n'), '요청 메모 PATCH → 요약 = 사람 글');
  ok((await api(`/api/docs/${doc1}/requests`)).find((r) => r.rid === rid1).summaryBy === 'user', 'summaryBy = user');
  const rq2 = await api(`/api/docs/${doc1}/requests/${rv.request.rid}`, { method: 'PATCH', body: { summary: '검토 요약(사람)', includeInstruction: false } });
  ok(rq2.summary === '검토 요약(사람)' && rq2.summaryBy === 'user', 'PATCH requests/:rid summary');
  ok((await call(`/api/docs/${doc1}/requests/${rv.request.rid}`, { method: 'PATCH', body: { summary: '남이 고침' }, token: B.token })).status === 403, '남의 요청 PATCH → 403');
  ok((await call(`/api/docs/${doc1}/memos/${sg.request.memoId}`, { method: 'PATCH', body: { text: '남이 고침' }, token: B.token })).status === 403, '남의 요청 메모 PATCH → 403');
  const pp = await api(`/api/docs/${doc1}/proposals`, { method: 'POST', body: { ref: 's0/p1', find: '낱말을 지우고', replace: '단어를 지우고', reason: '용어 통일' } });
  ok(pp.memo === true && pp.memoId, `일반 제안 #${pp.pid} 메모 ${pp.memoId}`);
  const ppm = await api(`/api/docs/${doc1}/memos/${pp.memoId}`, { method: 'PATCH', body: { text: '사람 메모입니다' } });
  ok(ppm.link.type === 'proposal' && ppm.body === '사람 메모입니다' && ppm.text.startsWith(`[제안 ${pp.pid}] ${A.name}\n「낱말을 지우고」\n→ 「단어를 지우고」\n이유: 용어 통일\n메모: 사람 메모입니다`), '제안 메모 PATCH → note');
  await api(`/api/docs/${doc1}/proposals/${pp.pid}/reject`, { method: 'POST' });
  ok((await memoOf(doc1, pp.memoId)).text.includes(`상태: 거절 ✗ ${A.name}`), '거절 → 제안 메모 상태 줄');
  const plain = await api(`/api/docs/${doc1}/memos`, { method: 'POST', body: { ref: 's0/p2', text: '사람 메모 원문' } });
  ok((await call(`/api/docs/${doc1}/memos/${plain.id}`, { method: 'PATCH', body: { text: '남이 고침' }, token: B.token })).status === 403, '남의 일반 메모 PATCH → 403');
  ok((await api(`/api/docs/${doc1}/memos`, { token: B.token })).find((m) => m.id === plain.id).editable === false, 'B 에게 editable=false');
  const plain2 = await api(`/api/docs/${doc1}/memos/${plain.id}`, { method: 'PATCH', body: { text: '고친 사람 메모\n둘째 줄' } });
  ok(plain2.text === '고친 사람 메모\n둘째 줄' && plain2.link === null, '일반 메모 PATCH → 글 전체');
  ok((await api(`/api/docs/${doc1}/memos/${plain.id}`, { method: 'PATCH', body: { text: '관리자가 고침' }, token: admin.token })).text === '관리자가 고침', '관리자는 고칠 수 있음');
  const cmHead = cm.text.split('\n')[0];
  ok(cm.body === cm.text.slice(cmHead.length + 1), 'AI 의견 메모 body = 머리줄을 뺀 글');
  const cm2 = await api(`/api/docs/${doc1}/memos/${cm.id}`, { method: 'PATCH', body: { text: '사람이 다듬은 의견\n둘째 줄' } });
  ok(cm2.link.type === 'comment' && cm2.text === `${cmHead}\n사람이 다듬은 의견\n둘째 줄` && cm2.body === '사람이 다듬은 의견\n둘째 줄', 'AI 의견 메모 PATCH → 머리줄은 두고 본문만');
  const cm3 = await api(`/api/docs/${doc1}/memos/${cm.id}`, { method: 'PATCH', body: { text: `${cmHead}\n글 전체로 보냄` } });
  ok(cm3.text === `${cmHead}\n글 전체로 보냄`, 'AI 의견 메모 PATCH: 머리줄째 보내도 겹치지 않음');
  ok((await api(`/api/docs/${doc1}/requests/${rv.request.rid}`)).log.some((l) => l.action === 'edit' && l.detail === '의견 수정') && !(await memoOf(doc1, rv.request.memoId)).text.includes('의견 수정('),
    '의견 수정은 요청 기록(log)에 — 작업 기록 메모 이력 줄은 요청 생애만(§9.3)');

  // 사람이 고친 요약은 AI 가 다시 처리해도 남는다
  const rt = await api(`/api/docs/${doc1}/requests/${rid1}/retry`, { method: 'POST' });
  ok(rt.request.status === 'done' && rt.request.summary === '사람이 고친 공유 요약' && rt.request.aiSummary.startsWith('(모의 AI)'), '다시 요청(서버 AI) 뒤에도 사람 요약 유지');
  ok((await call(`/api/docs/${doc1}/requests/${rid1}/cancel`, { method: 'POST' })).status === 409, '완료된 요청 취소 → 409');
  const fl = await call(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '#모의실패 확인', target: { ref: 's0/p2' } } });
  ok(fl.status === 502 && fl.data.error === 'AI_FAILED' && fl.data.request?.status === 'failed', `AI 실패 → 502 AI_FAILED, 요청 ${fl.data.request?.status}`);
  const flm = await memoOf(doc1, fl.data.request.memoId);
  ok(flm && flm.text.includes('결과: 실패 — 모의 AI 실패') && flm.text.includes('실패(모의 AI)'), '실패 메모: 결과·이력');
  const flr = await call(`/api/docs/${doc1}/requests/${fl.data.request.rid}/retry`, { method: 'POST' });
  ok(flr.status === 502 && (await waitUp()).version === PKG_VERSION, '다시 요청도 실패(502) — 서버는 살아 있음');

  // ───────── 표 채우기·표 만들기(경영대학) ─────────
  section('표 채우기·표 만들기(fill_table / make_table)');
  // 빈 칸을 만든다: 268 → '' (직접 고침) — 빈 칸 채우기는 find='' 로
  const del = await api(`/api/docs/${doc2}/proposals`, { method: 'POST', body: { ref: 's0/p3/n8', find: '268', replace: '', applyNow: true } });
  ok(del.status === 'applied' && (await textOf(doc2, 's0/p3/n8')) === '', '셀 s0/p3/n8 비움(직접 고침)');
  const ft = await api(`/api/docs/${doc2}/requests`, { method: 'POST', body: { kind: 'fill_table', instruction: '첨부 수치로 빈 칸을 채워 주세요', target: { ref: 's0/p3/n8' }, attachments: [xlsx.aid] } });
  ok(ft.request.target.tableKey === 's0/p3#t0' && ft.proposals.length === 1 && ft.proposals[0].ref === 's0/p3/n8' && ft.proposals[0].find === '' && ft.proposals[0].replace === '1268', `fill_table → 표 ${ft.request.target.tableKey}, 제안 「${ft.proposals[0]?.find}」→「${ft.proposals[0]?.replace}」 @${ft.proposals[0]?.ref}`);
  ok(ft.proposals[0].memo === false, '대상 칸의 제안은 따로 메모 없음');
  const ftm = await memoOf(doc2, ft.request.memoId);
  ok(ftm.text.includes('첨부: 2025_응답률.xlsx') && ftm.text.includes('[AI 작업 #') && ftm.text.includes('표 채우기'), '작업 기록 메모: 첨부 이름');
  await api(`/api/docs/${doc2}/proposals/${ft.proposals[0].pid}/apply`, { method: 'POST' });
  ok((await textOf(doc2, 's0/p3/n8')) === '1268', '빈 칸 채우기 적용 → 1268');
  const mk = await api(`/api/docs/${doc2}/requests`, { method: 'POST', body: { kind: 'make_table', target: { ref: 's0/p2' }, attachments: [xlsx.aid, csv.aid] } });
  const tp = mk.proposals.find((p) => p.type === 'table');
  ok(tp && tp.table.rows.length === 5 && tp.table.rows[0].length === 6 && tp.table.caption === '응답률' && tp.afterRef === 's0/p2', `make_table → 표 제안 #${tp?.pid} ${tp?.table.rows.length}×${tp?.table.rows[0].length} 「${tp?.table.caption}」`);
  ok((await memoOf(doc2, mk.request.memoId)).text.includes('결과: 남은 제안 1건') && !(await memoOf(doc2, mk.request.memoId)).text.includes('표 5×6') && (await memoOf(doc2, mk.request.memoId)).text.includes('첨부: 2025_응답률.xlsx, 기준.csv'), '작업 기록 메모: 남은 제안 1건(대기 표는 목록에 없음) + 첨부 두 개');
  const pend = await api(`/api/docs/${doc2}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '경영대학 소계는', replace: '경영대학 소계는(학부+대학원)', memo: false } });
  const tpa = await api(`/api/docs/${doc2}/proposals/${tp.pid}/apply`, { method: 'POST' });
  const t2 = await api(`/api/docs/${doc2}/tables`);
  ok(tpa.insertedRef === 's0/p3' && tpa.captionRef === 's0/p3/n0' && t2.length === 6 && t2.some((t) => t.key === 's0/p3#t0' && t.rows === 5 && t.cols === 6), `표 적용 → ${tpa.insertedRef}(캡션 ${tpa.captionRef}), 표 ${t2.length}개`);
  ok((await textOf(doc2, 's0/p3/n0')) === '[표 ] 응답률', '표 안 자동 번호 캡션 글(사람이 적은 번호 「표.」는 뗌)');
  ok((await api(`/api/docs/${doc2}/requests`)).find((r) => r.rid === ft.request.rid).target.ref === 's0/p4/n8', 'fill_table 요청 target 재매김 s0/p3/n8 → s0/p4/n8');
  const pend2 = (await api(`/api/docs/${doc2}/proposals`)).find((p) => p.pid === pend.pid);
  ok(pend2.ref === 's0/p5', `뒤 문단 대기 제안 재매김 s0/p4 → ${pend2.ref}`);
  await api(`/api/docs/${doc2}/proposals/${pend.pid}/apply`, { method: 'POST' });
  ok((await textOf(doc2, 's0/p5')).includes('(학부+대학원)'), '재매김된 제안 적용');
  fs.writeFileSync(path.join(root, 'tests/out/api_v2_table_tracked.hwpx'), await api(`/api/docs/${doc2}/file?kind=tracked`));
  const mkMemo = await memoOf(doc2, mk.request.memoId);
  ok(mkMemo.text.includes('결과: 반영 1건') && mkMemo.text.includes('\n · 표 5×6 「응답률」\n') && mkMemo.text.includes('\n✓ 해결 · '), '작업 기록: 표 반영(목록) + 해결');
  const tpu = await api(`/api/docs/${doc2}/proposals/${tp.pid}/undo`, { method: 'POST' });
  ok(tpu.status === 'undone' && (await api(`/api/docs/${doc2}/tables`)).length === 5 && (await textOf(doc2, 's0/p3')) === '', '표 복구 → 표 문단(캡션 포함) 지움');
  ok((await textOf(doc2, 's0/p3/n8')) === '1268' && (await textOf(doc2, 's0/p4')).includes('(학부+대학원)'), '표를 지운 뒤 셀 주소 원래대로, 그 뒤 문단은 남음');
  ok((await api(`/api/docs/${doc2}/requests`)).find((r) => r.rid === ft.request.rid).target.ref === 's0/p3/n8', '요청 target 다시 s0/p3/n8');
  const direct = await api(`/api/docs/${doc2}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p15', table: { rows: [['구분', '2025'], ['학부', '1,234']], headerRows: 1, caption: '' } } });
  ok(direct.memo === true && (await memoOf(doc2, direct.memoId)).text.startsWith(`[제안 ${direct.pid} · 표 삽입] ${A.name}\n이 문단 뒤에 2×2 표`), '요청 없는 표 제안 → 표 삽입 메모');
  const da = await api(`/api/docs/${doc2}/proposals/${direct.pid}/apply`, { method: 'POST' });
  ok(da.captionRef === null && da.insertedRef === 's0/p16', `캡션 없는 표 → ${da.insertedRef}`);

  // ───────── 편집본 병합(편집기 직접 타이핑) ─────────
  section('편집본 병합(uploadEdited)');
  const info1 = await api(`/api/docs/${doc1}`);
  const wc = await HwpxDoc.load(await api(`/api/docs/${doc1}/file?kind=working`));
  ok(wc.sections[0].xml.includes('첫째 문단'), '최종본 내려받기');
  wc.sections[0].load(wc.sections[0].xml.replace('첫째 문단', '첫 번째 문단'));
  const up = await api(`/api/docs/${doc1}/upload?base=${info1.version}`, { method: 'PUT', body: await wc.save(), raw: true });
  ok(up.report.changed.includes('s0/p0') && up.report.bodyMap && up.version === info1.version + 1, `편집본 병합 v${up.version} changed=${up.report.changed}`);
  ok((await textOf(doc1, 's0/p0')).startsWith('첫 번째 문단'), '병합 반영(변경 추적)');

  // ───────── 버전 복구 ─────────
  section('버전 복구(§3.7)');
  const before1 = await api(`/api/docs/${doc1}`);
  const rs = await api(`/api/docs/${doc1}/versions/1/restore`, { method: 'POST' });
  const after = (await paras(doc1)).filter((p) => p.where === '본문').map((p) => p.text);
  ok(!rs.unchanged && rs.version === before1.version + 1, `v1 복구 → v${rs.version} (바뀐 ${rs.report.changed.length}, 되돌린 제안 ${rs.report.undone.length}, 거절 ${rs.report.rejected})`);
  ok(JSON.stringify(after) === JSON.stringify(origTexts), '복구 뒤 최종본 글 = v1 최종본 글');
  const chs = await api(`/api/docs/${doc1}/changes`);
  ok(chs.filter((c) => c.author === 'Nag' || c.author === 'AI 검토자').length === 4, `v1 에 있던 한글 변경 4건은 남음(전체 변경 ${chs.length}건)`);
  ok((await api(`/api/docs/${doc1}/memos`)).some((m) => m.text.startsWith('[복구] v1(') && m.text.includes(`— ${A.name}\n바뀐 문단 `)), '복구 메모 [복구] v1(…)');
  const later3 = (await api(`/api/docs/${doc1}/proposals`)).find((p) => p.pid === later.pid);
  ok(later3.status === 'undone', `v1 뒤에 적용된 제안 #${later.pid} → ${later3.status}`);
  const rs2 = await api(`/api/docs/${doc1}/versions/1/restore`, { method: 'POST' });
  ok(rs2.unchanged === true, '다시 복구 → unchanged');
  ok((await call(`/api/docs/${doc1}/versions/999/restore`, { method: 'POST' })).status === 404, '없는 버전 → 404');
  const rs3 = await api(`/api/docs/${doc2}/versions/1/restore`, { method: 'POST' });
  ok((await textOf(doc2, 's0/p3/n8')) === '268' && (await api(`/api/docs/${doc2}/tables`)).length === 5, `doc2 v1 복구 → 셀 268, 표 5개 (되돌린 제안 ${rs3.report.undone.join(',')})`);

  // ───────── 표 셀 편집 병합 ─────────
  section('편집본 병합: 표 셀(중첩 문단)');
  const info2 = await api(`/api/docs/${doc2}`);
  const wc2 = await HwpxDoc.load(await api(`/api/docs/${doc2}/file?kind=working`));
  const cellP = wc2.sections[0].byRef('s0/p3/n9');
  const xml2 = wc2.sections[0].xml;
  wc2.sections[0].load(xml2.slice(0, cellP.start) + xml2.slice(cellP.start, cellP.end).replace('>205<', '>206<') + xml2.slice(cellP.end));
  const up2 = await api(`/api/docs/${doc2}/upload?base=${info2.version}`, { method: 'PUT', body: await wc2.save(), raw: true });
  ok(up2.report.changed.includes('s0/p3/n9') && (await textOf(doc2, 's0/p3/n9')) === '206', `표 셀 편집 병합 → changed ${up2.report.changed}`);
  ok((await paras(doc2, 'markup')).find((p) => p.ref === 's0/p3/n9').text.includes('{+'), '셀 편집이 변경 추적으로');

  // ───────── 옛 meta.json(사용자 문서 사본) ─────────
  if (oldId) {
    section('옛 meta.json 문서(사용자 문서 사본)');
    const list = await api('/api/docs');
    const od = list.find((d) => d.id === oldId);
    ok(od && od.attachments === 0, `목록에 보임: ${od?.title}`);
    ok(Array.isArray(await api(`/api/docs/${oldId}/attachments`)) && Array.isArray(await api(`/api/docs/${oldId}/requests`)) && Array.isArray(await api(`/api/docs/${oldId}/memos`)), '첨부·요청·메모 목록');
    const ot = await api(`/api/docs/${oldId}/tables`);
    const op = (await paras(oldId)).find((p) => p.where === '본문' && p.text.length > 30);
    const t0 = Date.now();
    const os2 = await api(`/api/docs/${oldId}/requests`, { method: 'POST', body: { kind: 'suggest', target: { ref: op.ref } } });
    ok(os2.proposals.length >= 1 && os2.request.memoId, `큰 문서(표 ${ot.length}개)에서 suggest ${os2.proposals.length}안, ${Date.now() - t0}ms`);
    const pa = await api(`/api/docs/${oldId}/proposals/${os2.proposals[0].pid}/apply`, { method: 'POST' });
    ok(pa.status === 'applied', '적용');
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'docs', oldId, 'meta.json'), 'utf-8'));
    ok(meta.seq.attachment === 0 && Array.isArray(meta.attachments), '옛 meta 에 기본값 채워 저장');
  }

  // ───────── WebSocket 알림 ─────────
  section('WebSocket 알림(§3.8)');
  await new Promise((r) => setTimeout(r, 300));
  const has = (msgs, f) => msgs.some(f);
  ok(has(w1.msgs, (m) => m.type === 'request' && m.action === 'add') && has(w1.msgs, (m) => m.type === 'request' && m.action === 'done') && has(w1.msgs, (m) => m.type === 'memo' && m.action === 'edit'), 'doc1: request add/done, memo edit');
  ok(has(w2.msgs, (m) => m.type === 'attachment' && m.action === 'add') && has(w2.msgs, (m) => m.type === 'attachment' && m.action === 'delete'), 'doc2: attachment add/delete');
  w1.close(); w2.close();

  // ═════════ 2부: 서버 AI 끔 → 대기열 + MCP ═════════
  await stopServer();
  startServer(false);
  const conf2 = await waitUp();
  section('2부: AI 끔 → 대기열 + MCP(§5)');
  ok(conf2.aiEnabled === false && conf2.aiMock === false, '다시 띄움(AI 끔), 같은 data 폴더');
  ok((await api(`/api/docs/${doc1}/requests`)).length >= 6, '요청 기록 유지');
  const txt = await upload(doc1, '참고.txt', Buffer.from('참고 자료: 2025년 응답률은 47.8% 이다.'));
  const q1 = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'suggest', instruction: '비공개 지시: 부드럽게', target: { ref: 's0/p0', start: s0, end: s0 + cp(sel), text: sel }, attachments: [txt.aid], options: { count: 2 } } });
  ok(q1.queued === true && q1.request.status === 'pending' && q1.request.memoId, `대기열 #${q1.request.rid} + 작업 기록 메모`);
  ok((await memoOf(doc1, q1.request.memoId)).text.includes('요약: 문장 제안 요청 — AI 처리 대기') && (await memoOf(doc1, q1.request.memoId)).text.includes('첨부: 참고.txt'), '대기 중 기본 요약 + 첨부 이름');
  const q2 = await api(`/api/docs/${doc2}/requests`, { method: 'POST', body: { kind: 'make_table', target: { ref: 's0/p2' }, attachments: [xlsx.aid, png.aid] } });
  const q3 = await api(`/api/docs/${doc2}/requests`, { method: 'POST', body: { kind: 'fill_table', target: { ref: 's0/p3/n9' }, attachments: [xlsx.aid] } });
  const q4 = await api(`/api/docs/${doc1}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p1' } } });
  const cq = await api(`/api/docs/${doc1}/requests/${q4.request.rid}/cancel`, { method: 'POST' });
  const cqm = await memoOf(doc1, q4.request.memoId);
  ok(cq.status === 'cancelled' && cqm.text.includes('취소(') && cqm.text.includes('요약: AI 검토 요청 — 취소됨') && cqm.text.includes('결과: 취소됨'), '취소 → 메모 요약·결과·이력');
  const rq = await api(`/api/docs/${doc1}/requests/${q4.request.rid}/retry`, { method: 'POST' });
  ok(rq.queued === true && rq.request.status === 'pending', '다시 요청 → 대기열');

  const m = await mcpClient(A);
  const tools = (await m.client.listTools()).tools.map((t) => t.name);
  const need = ['list_documents', 'read_document', 'search_document', 'list_memos', 'add_memo', 'delete_memo', 'propose_change', 'propose_changes', 'list_proposals', 'apply_proposal', 'reject_proposal', 'undo_proposal', 'list_changes', 'accept_change', 'reject_change', 'list_requests', 'complete_request', 'get_history',
    'get_request', 'start_request', 'list_attachments', 'read_attachment', 'propose_alternatives', 'propose_insert', 'propose_table', 'update_memo'];
  ok(need.every((n) => tools.includes(n)), `MCP 도구 ${tools.length}개(기존 18 + 새 도구)`);
  const lr = await m.json('list_requests', {});
  ok([q1.request.rid, q4.request.rid].every((r) => lr.some((x) => x.docId === doc1 && x.rid === r)) && lr.some((x) => x.docId === doc2 && x.rid === q2.request.rid) && lr.every((x) => x.by === A.name), `list_requests(내 것, 대기·처리 중) ${lr.length}건`);
  const lq1 = lr.find((x) => x.rid === q1.request.rid && x.docId === doc1);
  ok(lq1.instruction === '비공개 지시: 부드럽게' && lq1.attachments[0].name === '참고.txt' && lq1.attachments[0].chars > 0 && lq1.target.text === sel, 'list_requests 항목: 지시·첨부(이름·글자 수)·대상');
  const g3 = await m.json('get_request', { doc_id: doc2, request_id: q3.request.rid });
  ok(g3.tables.length === 1 && g3.tables[0].key === 's0/p3#t0' && g3.context.includes('*[s0/p3/n9]') && g3.howTo.includes('complete_request'), 'get_request: 표 구조 + 문맥(* 대상) + 안내');
  const ra = await m.tool('read_attachment', { doc_id: doc2, attachment_id: xlsx.aid, max_chars: 2000 });
  ok(ra.content[0].text.includes('<attachment name="2025_응답률.xlsx"') && ra.content[0].text.includes('## 시트: 응답률'), 'read_attachment(xlsx) → 시트 글');
  const ri = await m.tool('read_attachment', { doc_id: doc2, attachment_id: png.aid });
  ok(ri.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'), 'read_attachment(png) → image content');
  const la = await m.json('list_attachments', { doc_id: doc2 });
  ok(la.find((a) => a.aid === xlsx.aid).usedBy.includes(q3.request.rid), 'list_attachments: usedBy');
  const st = await m.json('start_request', { doc_id: doc2, request_id: q3.request.rid });
  ok(st.status === 'working' && st.handledBy === 'Claude', 'start_request → working, 처리 Claude');
  const pc = await m.json('propose_changes', { doc_id: doc2, request_id: q3.request.rid, proposals: [{ ref: 's0/p3/n9', find: '206', replace: '1205', reason: '첨부 수치' }] });
  ok(pc[0].ok && pc[0].proposal.rid === q3.request.rid && pc[0].proposal.memo === false, 'propose_changes(request_id) → 요청에 묶임(대상 칸이라 메모 없음)');
  const done3 = await m.json('complete_request', { doc_id: doc2, request_id: q3.request.rid, summary: '첨부 수치로 표 칸 1개를 고치도록 제안함', instruction_summary: '표 칸 채우기' });
  ok(done3.status === 'done' && done3.summary === '첨부 수치로 표 칸 1개를 고치도록 제안함' && done3.summaryBy === 'ai', 'complete_request(summary) → done, 요약 = AI 요약');
  const m3 = await memoOf(doc2, q3.request.memoId);
  ok(m3.text.includes('· 처리 Claude') && m3.text.includes('요약: 첨부 수치로 표 칸 1개를') && m3.text.includes('결과: 남은 제안 1건') && m3.text.includes('처리 시작(Claude)') && m3.text.includes('완료(Claude)'), '작업 기록 메모: 처리자·요약·결과·이력');
  const alt = await m.json('propose_alternatives', { doc_id: doc1, request_id: q1.request.rid, ref: 's0/p0', find: sel, options: [{ text: '메모 대상 문장이 이곳에 있습니다.', reason: '어휘' }, { text: '메모를 달 문장이 여기 있습니다.', reason: '명확히' }] });
  ok(alt.gid === q1.request.rid && alt.results.length === 2 && alt.results.every((x) => x.ok && x.proposal.gid === q1.request.rid), `propose_alternatives → gid ${alt.gid}, 안 ${alt.results.length}개`);
  const um = await m.json('update_memo', { doc_id: doc1, memo_id: q1.request.memoId, text: '사람이 MCP 로 고친 요약' });
  ok(um.body === '사람이 MCP 로 고친 요약', 'update_memo(요청 메모) → 요약');
  const d1 = await m.json('complete_request', { doc_id: doc1, request_id: q1.request.rid, summary: 'AI 가 덮어쓰려는 요약' });
  ok(d1.summary === '사람이 MCP 로 고친 요약' && d1.summaryBy === 'user' && d1.aiSummary === 'AI 가 덮어쓰려는 요약', '사람이 고친 요약은 complete_request 가 덮어쓰지 않음');
  const tbl = await m.json('propose_table', { doc_id: doc2, request_id: q2.request.rid, after_ref: 's0/p2', rows: [['구분', '2025년'], ['학부', '1098']], header_rows: 1, caption: '표. 첨부 요약' });
  ok(tbl.type === 'table' && tbl.rid === q2.request.rid && tbl.table.rows.length === 2, 'propose_table(request_id)');
  const ins2 = await m.json('propose_insert', { doc_id: doc2, request_id: q2.request.rid, after_ref: 's0/p4', text: '위 표는 첨부 자료를 바탕으로 정리함.', reason: '설명 보완' });
  ok(ins2.type === 'insert' && ins2.memo === false && !ins2.memoId, 'propose_insert(대상과 다른 문단) → 제안 메모 없음(요청 제안은 작업 기록 메모 하나에 — §9.3)');
  const am = await m.json('add_memo', { doc_id: doc2, request_id: q2.request.rid, ref: 's0/p2', text: '첨부 그림은 표에 넣지 않았습니다.' });
  ok(am.link?.type === 'comment' && am.text.startsWith(`[AI 의견 · 작업 #${q2.request.rid}] ${A.name}(Claude)`), 'add_memo(request_id) → AI 의견으로 묶임');
  await m.json('complete_request', { doc_id: doc2, request_id: q2.request.rid, summary: '첨부 표로 2×2 표와 설명 문단을 제안함' });
  const m2 = await memoOf(doc2, q2.request.memoId);
  ok(m2.text.includes('첨부: 2025_응답률.xlsx, 그림.png') && m2.text.includes('결과: 남은 제안 2건 · 의견 1건') && !m2.text.includes('표 2×2'), '작업 기록 메모: 첨부·남은 제안(표·문단 추가 — 대기는 목록에 없음)·의견');
  const mb = await mcpClient(B);
  const lrB = await mb.json('list_requests', { mine: false, status: 'all', doc_id: doc1 });
  ok(lrB.length >= 6 && lrB.filter((x) => x.by === A.name).every((x) => x.instruction === null && x.instructionHidden), 'list_requests(mine=false) → 남의 지시 원문 숨김');
  const gB = await mb.json('get_request', { doc_id: doc1, request_id: q1.request.rid });
  ok(gB.instruction === null, 'get_request(남의 요청) → 지시 숨김');
  const umB = await mb.tool('update_memo', { doc_id: doc1, memo_id: q1.request.memoId, text: '남이 고침' }).catch((e) => e);
  ok(umB instanceof Error && /FORBIDDEN/.test(umB.message), 'update_memo(남의 요청 메모) → FORBIDDEN');
  await m.client.close(); await mb.client.close();

  // 한글 확인용 파일(작업 기록 메모·제안 메모·AI 의견·변경 추적이 든 것)
  fs.writeFileSync(path.join(root, 'tests/out/api_v2_mcp_tracked.hwpx'), await api(`/api/docs/${doc2}/file?kind=tracked`));
  fs.writeFileSync(path.join(root, 'tests/out/api_v2_doc1_tracked.hwpx'), await api(`/api/docs/${doc1}/file?kind=tracked`));
  console.log('  → tests/out/api_v2_table_tracked.hwpx, api_v2_mcp_tracked.hwpx, api_v2_doc1_tracked.hwpx');
  // 한글에서 보일 메모 글 하나를 출력(눈으로 확인용)
  console.log('\n[작업 기록 메모 예]\n' + m2.text);
  console.log(`\nAPI V2 OK (${passed} checks)`);
} catch (e) {
  console.error('\nAPI V2 FAILED:', e.stack || e.message);
  try { console.error(fs.readFileSync(logFile, 'utf-8').slice(-3000)); } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  await stopServer();
  process.exit(process.exitCode || 0);
}
