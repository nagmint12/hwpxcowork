// 서버 연기 시험: 서버를 띄우고 REST + MCP 로 문서 올리기 → 읽기 → 메모·제안 → 적용·되돌리기 → 편집본 병합까지 돌려 본다.
// 저장소의 사용자 config 파일·data/ 는 읽지도 쓰지도 않는다 — 임시 폴더에 data 와 임시 config(관리자 + 편집자 2, 토큰은 매번 새로)를
// 만들어 HWPX_COWORK_CONFIG 로 띄운다(받침 tests/helpers/server.mjs 와 같은 꼴, 포트는 고정 8799).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HwpxDoc } from '../engine/doc.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = 8799; const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-smoke-'));
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir);
const users = [{ name: '관리자', role: 'admin' }, { name: '홍길동', role: 'editor' }, { name: '김검토', role: 'editor' }]
  .map((u) => ({ ...u, token: crypto.randomBytes(16).toString('hex') }));
const configPath = path.join(tmpDir, 'config.json');
// changeRequests 구역은 일부러 두지 않는다: v0.2 설정 → 편집자도 '기준에 바로 적용'·편집본 올리기(이 시험이 확인하는 v0.2 계약).
// AI 키 파일은 없는 경로 — 실제 API 를 부르지 않는다(서버 AI 꺼짐 → 검토 요청은 대기열)
fs.writeFileSync(configPath, JSON.stringify({
  host: '127.0.0.1', port: PORT, dataDir: './data', allowAgentApply: true, users,
  ai: { enabled: false, mock: false, keyFile: path.join(tmpDir, 'no-such-key.txt'), model: 'claude-opus-5-5', effort: 'medium', maxProposals: 10 },
  // v0.4: 기본 편집 방식은 실시간(V4 §1) — 이 시험은 v0.2 계약(변경 추적으로 적용·되돌리기·편집본 병합 마크업·자세한 작업 기록 메모)을 보므로
  // 문서 기본값을 승인 방식·자세한 메모로 둔다(실시간 문서는 tests/api_live.mjs)
  documents: { defaultEditMode: 'review', defaultAiMemo: 'detail' },
  // MCP 기본 연결: 운영 기본은 새 연결(v2 — 2026-11-17)이지만 이 시험은 예전 연결 도구(read_document·propose_changes 등)의 계약을 잰다 — tests/helpers/server.mjs 와 같다
  mcp: { defaultSurface: 'v1' },
}, null, 1));
const admin = users[0]; const editor = users[1];

fs.mkdirSync(path.join(root, 'tests/out'), { recursive: true });
const log = fs.openSync(path.join(root, 'tests/out/server.log'), 'w');
// 밖(process.env)의 HWPX_COWORK_*(CONFIG·AI_MOCK·AI 등)는 넘기지 않는다
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HWPX_COWORK_/i.test(k)));
Object.assign(env, { HWPX_COWORK_CONFIG: configPath, HWPX_COWORK_PORT: String(PORT), HWPX_COWORK_DATA_DIR: dataDir });
const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', log, log] });
const kill = () => { try { child.kill(); } catch { /* ignore */ } };
const cleanup = () => { kill(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } };
process.on('exit', cleanup);

async function waitUp() { for (let i = 0; i < 60; i++) { try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return r.json(); } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error('서버가 뜨지 않음'); }
const api = async (p, { method = 'GET', body, raw, token = editor.token, headers = {} } = {}) => {
  const h = { Authorization: `Bearer ${token}`, ...headers };
  if (body && !raw) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  if (raw) h['Content-Type'] = 'application/octet-stream';
  const r = await fetch(`${BASE}${p}`, { method, headers: h, body });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓', msg); };

try {
  const conf = await waitUp(); console.log('server up', conf.version, 'ai', conf.aiEnabled);
  const me = await api('/api/me'); ok(me.name === editor.name, `로그인 ${me.name}`);
  const fx = fs.readFileSync(path.join(root, 'tests/fixtures/tool_memo_tracked.hwpx'));
  const created = await api('/api/docs', { method: 'POST', body: fx, raw: true, headers: { 'x-file-name': encodeURIComponent('시험문서.hwpx') } });
  ok(created.id && created.version === 1, `문서 올림 ${created.id}`);
  const id = created.id;
  const info = await api(`/api/docs/${id}`); ok(info.changes === 4 && info.memos === 1, `문서 정보 changes=${info.changes} memos=${info.memos} tracking=${info.tracking}`);
  const paras = await api(`/api/docs/${id}/paragraphs?view=markup`); ok(paras.length === 3 && paras[2].text.includes('{+'), `문단 ${paras.length}개, 마크업 보기`);
  const memo = await api(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '메모 대상', text: '웹에서 단 메모' } });
  ok(memo.id === 'memo2' && memo.anchorText === '메모 대상', `메모 추가 ${memo.id} anchor=${memo.anchorText}`);
  const prop = await api(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: 's0/p0', find: '여기 있습니다', replace: '이곳에 있습니다', reason: '어투 통일' } });
  ok(prop.pid === 1 && prop.status === 'pending' && prop.memoId, `제안 #${prop.pid} 메모 ${prop.memoId}`);
  const applied = await api(`/api/docs/${id}/proposals/1/apply`, { method: 'POST' });
  ok(applied.status === 'applied' && applied.changeIds.length === 2, `제안 적용 changeIds=${applied.changeIds}`);
  let p2 = (await api(`/api/docs/${id}/paragraphs`))[0]; ok(p2.text.includes('이곳에 있습니다') && !p2.text.includes('여기 있습니다'), `최종본 반영: ${p2.text}`);
  const undone = await api(`/api/docs/${id}/proposals/1/undo`, { method: 'POST' }); ok(undone.status === 'undone', '되돌리기');
  p2 = (await api(`/api/docs/${id}/paragraphs`))[0]; ok(p2.text.includes('여기 있습니다'), `되돌린 뒤: ${p2.text}`);
  const changes = await api(`/api/docs/${id}/changes`); ok(changes.length === 4, `변경 ${changes.length}건`);
  await api(`/api/docs/${id}/changes/${changes[0].id}/accept`, { method: 'POST' }); ok((await api(`/api/docs/${id}/changes`)).length === 3, '변경 1건 수락');

  // 편집본 병합: 최종본을 받아 글을 바꿔 다시 올린다(편집기 역할)
  const wc = await api(`/api/docs/${id}/file?kind=working`);
  const edited = await HwpxDoc.load(wc); const sec = edited.sections[0];
  const t = edited.text('s0/p1'); ok(!t.includes('{+'), `최종본 문단: ${t}`);
  sec.load(sec.xml.replace('낱말을 넣습니다', '단어를 넣습니다(편집기)'));
  const up = await api(`/api/docs/${id}/upload?base=${info.version}`, { method: 'PUT', body: await edited.save(), raw: true });
  ok(up.report.changed.includes('s0/p1') && up.version > info.version, `편집본 병합 v${up.version} changed=${up.report.changed}`);
  const mk = await api(`/api/docs/${id}/paragraphs?view=markup`); ok(mk[1].text.includes('{+') && mk[1].text.includes('(편집기)'), `병합 마크업: ${mk[1].text}`);

  // 검토 요청(서버 AI 꺼짐 → 대기열)
  const rq = await api(`/api/docs/${id}/requests`, { method: 'POST', body: { instruction: '문체를 공문서체로 다듬어 줘' } });
  ok(rq.queued === true || rq.queued === false, `검토 요청 queued=${rq.queued}`);

  // MCP
  const client = new Client({ name: 'claude-ai', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?agent=Claude`), { requestInit: { headers: { Authorization: `Bearer ${editor.token}` } } }));
  const tools = await client.listTools(); ok(tools.tools.length >= 17, `MCP 도구 ${tools.tools.length}개`);
  const rd = await client.callTool({ name: 'read_document', arguments: { doc_id: id, view: 'markup' } });
  ok(rd.content[0].text.includes('[s0/p1]'), 'MCP read_document');
  const pm = await client.callTool({ name: 'propose_changes', arguments: { doc_id: id, proposals: [{ ref: 's0/p2', find: '둡니다', replace: '유지합니다', reason: '표현' }, { ref: 's0/p2', find: '없는글', replace: 'x' }] } });
  const pmj = JSON.parse(pm.content[0].text); ok(pmj[0].ok && !pmj[1].ok, `MCP 제안 2건(1 성공, 1 실패): ${pmj[1].error}`);
  ok(String(pmj[1].error).includes('「없는글」을 찾지 못했습니다'), '실패 안내의 조사는 끝소리로 고름(「없는글」을 — 「…」를 로 박지 않음)');
  ok(pmj[0].proposal.by === `${editor.name}(Claude)`, `제안자 표기 ${pmj[0].proposal.by}`);
  const lp = await client.callTool({ name: 'list_proposals', arguments: { doc_id: id, status: 'pending' } }); ok(JSON.parse(lp.content[0].text).length === 1, 'MCP list_proposals');
  const lr = await client.callTool({ name: 'list_requests', arguments: {} }); ok(JSON.parse(lr.content[0].text).length >= (rq.queued ? 1 : 0), 'MCP list_requests');
  const tokenUrl = new Client({ name: 'chatgpt', version: '1' }); await tokenUrl.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/t/${editor.token}`)));
  ok((await tokenUrl.listTools()).tools.length >= 17, 'MCP 토큰 경로(/mcp/t/<token>) 연결');
  await client.close(); await tokenUrl.close();

  const hist = await api(`/api/docs/${id}/history`); ok(hist.versions.length >= 5 && hist.activity.length >= 5, `이력 v${hist.versions.length} 활동 ${hist.activity.length}`);
  const tracked = await api(`/api/docs/${id}/file?kind=tracked`); fs.writeFileSync(path.join(root, 'tests/out/api_tracked.hwpx'), tracked);
  ok(tracked.length > 1000, `변경추적본 내려받음 ${tracked.length}B → tests/out/api_tracked.hwpx`);
  await api(`/api/docs/${id}`, { method: 'DELETE', token: admin.token }); ok(!(await api('/api/docs')).some((d) => d.id === id), '문서 삭제');
  console.log('API SMOKE OK');
} catch (e) {
  console.error('API SMOKE FAILED:', e.message); console.error(fs.readFileSync(path.join(root, 'tests/out/server.log'), 'utf-8').slice(-2000)); process.exitCode = 1;
} finally { kill(); await new Promise((r) => setTimeout(r, 300)); process.exit(process.exitCode || 0); }
