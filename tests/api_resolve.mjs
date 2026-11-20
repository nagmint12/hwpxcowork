// AI 작업은 요청 단위로 해결 · 요청마다 메모 하나 · 사람용 버전(이정표) 시험 — docs/V3_SPEC.md §9(§9.2 해결 상태, §9.3 메모 하나,
// §9.4 이정표, §9.5 요청 단위 해결, §9.8 시험 목록).
// 서버는 시험 받침(tests/helpers/server.mjs)으로 빈 포트·임시 data·임시 config·모의 AI 로 띄운다(실제 API 를 부르지 않는다 —
// 요청은 route 'queue' 로 만들고 에이전트 몫은 MCP 도구로 한다). 임시 config 는 changeRequests.allowDirectApply 를 두지 않는다(= false):
// 편집자는 '기준에 바로 적용'을 못 하고 관리자는 한다.
//  1) 요청 제안에 메모 없음(대상 문단·다른 문단·문단 추가·표·여러 안·REST memo: true) · 요청 없는 제안은 제안 메모 · 작업 기록 메모 하나
//  2) 요청 보기 outcome(REST 하나·목록·MCP get_request·list_requests)
//  3) resolve 검사: NOTHING·BAD_ARGS·DIRECT_APPLY_FORBIDDEN(편집자 — 먼저 보고 아무것도 안 바꿈)·없는 요청 404
//  4) 섞음(거절 + 반영 기록) → 메모에는 반영만(꼬리 — 수정본), 거절 안 씀 · WS proposal adopted(pids)·batch·request update
//  5) 기준에 바로 적용: STALE 항목만 실패(그 항목의 문서 변경 없음)·NOT_IN_REQUEST
//  6) apply 'rest' — 여러 안 묶음은 빠짐(문단 추가·표는 적용)
//  7) reject 'rest' → 해결(적용 있음 + 마지막 버전에서 30분 지남 → 버전 request) · 메모(반영만·해결 줄·이력 = 요청 생애) · WS request update resolved·doc milestone · history·summary
//  8) 다시 열기 → 해결 풀림(reopen 기록) → 다시 거절 → 다시 해결 · AI 작업 해결 버전은 마지막 버전에서 30분 뒤에만(그 전 적용은 다음 버전에 함께)
//  9) 하나짜리 adopt 로 해결(반영 기록만 → 버전 없음) · 수정 버림·변경 요청 닫기 → 풀림 · 다시 열기 → 다시 해결 · 남의 cid 403 ·
//     변경 요청 반영 → v(응답·WS·CRView baseV/mergedV·기록 'v2로 반영') · 취소된 요청도 resolve
// 10) 버전: 올림 v1 · 메모·직접 고침·변경 수락은 기록만 · 버전 저장(편집자도)·NO_CHANGES·빈 메모·200자 · 복구 두 꼴(v / 기록 시각) · 편집본 올림(live 는 아님)
// 11) 옛 자료: milestones 없는 meta → versions note 로 만들기 · 옛 제안 메모 거두기(답글 있는 것은 남김, 작업 기록 메모가 지워진 요청도) ·
//     resolvedAt 없는 옛 요청은 처음 건드려도 해결 기록·버전을 만들지 않음
// 12) 중첩 문단 번호 지키기: 표를 품은 본문 문단(글이 표 앞) 대상 요청 + 그 표 칸 제안 → 작업 기록 메모가 여러 줄 늘어난 뒤 적용해도 제 칸
// 13) 중첩 문단 번호 지키기(_finish 밖 메모 쓰기): 표 앞 글에 사람 메모·답글·제안 메모 상태 줄·메모 지우기·옛 제안 메모(거절 + 거두기) →
//     요청 칸 제안(제안 메모가 없어 메모 자리로 스스로 고쳐지지 않음)이 제 칸에(숫자 칸이 겹쳐 틀린 칸이면 조용히 바뀌는 표)
// 14) 다시 연 제안: 거절 전의 낡은 반영 기록(adoptedBy)은 지운다 → 남음으로 세어 요청이 다시 열림
// 15) 기록 번호를 'v' 로 내지 않음: STALE_BASE·BAD_BASE·NO_VERSION 글 · 다시 맞추기 기록(사람용 버전) · 기록 내려받기 이름(_v3 / _MM-dd_HHmm)
// 16) 같은 문단의 여러 제안을 resolve apply 로 한 번에: 등록 순서로(n번째 등장이 밀려도 처음 고른 대상 유지)
// 진짜 config.json·data/ 는 쓰지 않는다 — 끝에 config.json 의 시각·크기와 data/docs 목록이 그대로인지 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, uploadDoc, watchWs, fixture, root } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { fmtTime } from '../server/memotext.js';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const indent = (t) => String(t).replace(/\n/g, '\n      ');
const TM = '(?:\\d\\d-\\d\\d )?\\d\\d:\\d\\d';   // 이력 줄 시각(날짜가 바뀌면 날짜도)

const realCfg = path.join(root, 'config.json');
const stamp = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };
function dataListing() {
  const d = path.join(root, 'data', 'docs');
  try { return fs.readdirSync(d).sort().map((id) => `${id}:${stamp(path.join(d, id, 'meta.json'))}`).join('|'); } catch { return 'none'; }
}
const before = { cfg: stamp(realCfg), data: dataListing() };

const FX = fixture('tool_memo_tracked.hwpx');
const PREP = { author: '준비' };
const ED = { author: '편집기' };

/** 시험 문서: 도구 메모 문서를 평탄화하고 문단 5개를 더한 깨끗한 문서(변경 추적 없음, 메모 1 — s0/p0)
 *  s0/p0 첫째(메모) · p1 둘째(있던 낱말을) · p2 셋째(둡니다) · p3 넷째(사업 개요를) · p4 다섯째(3월부터) · p5 여섯째(1억 원) · p6 일곱째(기대 효과를) · p7 여덟째(맺음말) */
async function buildMainDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const extra = ['넷째 문단: 사업 개요를 적습니다.', '다섯째 문단: 추진 일정은 3월부터 12월까지입니다.', '여섯째 문단: 예산은 총 1억 원입니다.', '일곱째 문단: 기대 효과를 정리합니다.', '여덟째 문단: 맺음말입니다.'];
  extra.forEach((t, i) => d.insertParagraphAfter(0, 2 + i, t, PREP));
  d.acceptAll();
  return Buffer.from(await d.save());
}

/** 글이 표 앞에 있는 문단: [글(메모), 글, '표 머리 글' + 표 3×2(칸 구분·값·가·1·나·2), 글] — 이 문단 글에 메모를 달면 칸 번호(n)가 밀린다.
 *  rows 를 주면 그 칸 글(숫자 칸이 겹치면 칸 ref 가 밀렸을 때 틀린 칸에 조용히 들어간다) */
async function buildTextTableDoc(rows = [['구분', '값'], ['가', '1'], ['나', '2']]) {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  d.insertTableAfter(0, 1, { rows }, PREP);
  d.acceptAll();
  const sec = d.sections[0]; const p = sec.bodyParas[2];
  const open = sec.xml.indexOf('>', p.start) + 1;   // <hp:p …> 바로 뒤 = 표 run 앞
  sec.load(`${sec.xml.slice(0, open)}<hp:run charPrIDRef="0"><hp:t>표 머리 글</hp:t></hp:run>${sec.xml.slice(open)}`);
  return Buffer.from(await d.save());
}

/** MCP JSON-RPC 한 번(무상태) → { status, msg, raw }. agent = ?agent= 이름, session = X-Hwpx-Agent-Session */
async function rpc(base, token, body, { agent = 'Claude', session } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  if (session) h['X-Hwpx-Agent-Session'] = session;
  const r = await fetch(`${base}/mcp?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const raw = await r.text();
  let msg = null;
  try { const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:')); msg = JSON.parse(line ? line.slice(5) : raw); } catch { /* JSON 아님 */ }
  return { status: r.status, msg, raw };
}
/** MCP 도구 호출 → { isError, text, json }(오류도 던지지 않는다) */
async function mcp(base, token, name, args = {}, opts = {}) {
  const r = await rpc(base, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts);
  if (r.status !== 200 || !r.msg) return { status: r.status, isError: true, text: r.raw, json: null };
  if (r.msg.error) return { status: r.status, isError: true, text: r.msg.error.message, json: null };
  const text = r.msg.result?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { status: r.status, isError: !!r.msg.result?.isError, text, json };
}
/** 도구가 성공해야 하는 호출 */
async function mcpOk(base, token, name, args, opts) {
  const r = await mcp(base, token, name, args, opts);
  if (r.isError) throw new Error(`MCP ${name}: ${r.text}`);
  return r.json;
}

async function working(C, id) {
  const r = await C.res(`/api/docs/${id}/file?kind=working`);
  if (r.status !== 200) throw new Error(`working 사본 ${r.status}`);
  return { doc: await HwpxDoc.load(r.data), version: Number(r.headers.get('x-doc-version')) };
}
async function makeHead(C, id, edit) {
  const { doc, version } = await working(C, id);
  const w = await doc.clone();
  await edit(w);
  const flat = await w.flattened();
  return { bytes: Buffer.from(await flat.save()), version };
}
function replaceIn(d, ref, from, to) {
  const t = d.text(ref);
  if (!t.includes(from)) throw new Error(`${ref} 에 「${from}」 이(가) 없습니다: ${t}`);
  d.mergeParagraphText(ref, t.replace(from, to), ED);
}
const putDraft = (C, id, head) => C(`/api/docs/${id}/drafts/mine?base=${head.version}`, { method: 'PUT', body: head.bytes });
/** 마지막 사람용 버전의 시각을 min 분 전으로(meta.json 을 직접 — 서버는 요청마다 meta 를 읽는다). AI 작업 해결 버전은 마지막 버전에서
 *  30분(config.documents.aiMilestoneMinutes 기본)이 지나야 생긴다(V4 §2.6) — 그 시간이 지난 것처럼 */
function ageLastMilestone(dataDir, id, min = 31) {
  const f = path.join(dataDir, 'docs', id, 'meta.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf-8'));
  m.milestones.at(-1).at = new Date(Date.now() - min * 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(m, null, 1));
}

// v0.4: 기본 편집 방식은 실시간(V4 §1) — 이 시험은 v0.3.1 의 승인 방식 흐름(편집자 '기준에 바로 적용' 403·변경 추적 적용·자세한 작업 기록 메모)을
// 보므로 임시 config 의 문서 기본값을 승인 방식·자세한 메모로 둔다(실시간 문서는 tests/api_live.mjs)
const V3_DOCS = { documents: { defaultEditMode: 'review', defaultAiMemo: 'detail' } };
const servers = [];
const sockets = [];
try {
  const srv = await startServer({ ai: 'mock', config: V3_DOCS }); servers.push(srv);
  const A = srv.api('a'); const B = srv.api('b'); const ADM = srv.api('admin');
  const nameA = srv.users.a.name; const nameB = srv.users.b.name; const nameAdm = srv.users.admin.name;
  const TA = srv.tokens.a;
  const AG = { agent: 'Claude Code', session: 'resolveA' };

  // ───────── 1. 요청 제안에 메모 없음 ─────────
  section('요청에 딸린 제안은 제안 메모를 만들지 않는다(대상 문단·다른 문단·문단 추가·표·여러 안·REST memo: true) · 요청 없는 제안은 제안 메모');
  const dA = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '요청 해결.hwpx');
  const DA = `/api/docs/${dA.id}`;
  const ws = watchWs(srv.base, srv.tokens.b, dA.id); sockets.push(ws); await ws.ready;
  const memosBefore = (await A(`${DA}/memos`)).length;
  const q = await A(`${DA}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '여러 곳을 다듬어 주세요', target: { ref: 's0/p3' }, route: 'queue' } });
  const rid = q.request.rid;
  ok(q.route === 'queue' && q.request.status === 'pending' && q.request.memoId && eq(q.request.outcome, { items: 0, accepted: 0, applied: 0, adopted: 0, declined: 0, open: 0, comments: 0, resolved: false, openPids: [] })
    && q.request.resolvedAt === null && q.request.resolvedBy === null, `요청 #${rid}(대기열) — 응답 보기에 outcome·resolvedAt·resolvedBy`);
  ok(!(await mcp(srv.base, TA, 'start_request', { doc_id: dA.id, request_id: rid }, AG)).isError, '에이전트 start_request');
  const pc = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dA.id, request_id: rid, proposals: [
    { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 배경을', reason: '대상 문단' },
    { ref: 's0/p4', find: '3월부터', replace: '4월부터', reason: '다른 문단' },
    { ref: 's0/p5', find: '1억 원', replace: '1억 2천만 원' },
    { ref: 's0/p6', find: '기대 효과를', replace: '기대 효과를 구체적으로' },
  ] }, AG);
  const [pP3, pP4, pP5, pP6] = pc.map((x) => x.proposal);
  const ins = await mcpOk(srv.base, TA, 'propose_insert', { doc_id: dA.id, request_id: rid, after_ref: 's0/p7', text: '덧붙인 문단입니다.' }, AG);
  const tbl = await mcpOk(srv.base, TA, 'propose_table', { doc_id: dA.id, request_id: rid, after_ref: 's0/p2', rows: [['구분', '값'], ['가', '1']], caption: '표. 시험' }, AG);
  const alt = await mcpOk(srv.base, TA, 'propose_alternatives', { doc_id: dA.id, request_id: rid, ref: 's0/p1', find: '있던 낱말을', options: [{ text: '기존 낱말을' }, { text: '예전 낱말을' }] }, AG);
  const [o1, o2] = alt.results.map((x) => x.proposal);
  const pP0 = await A(`${DA}/proposals`, { method: 'POST', body: { ref: 's0/p0', find: '여기 있습니다', replace: '이곳에 있습니다', rid, memo: true } });
  const all = [pP3, pP4, pP5, pP6, ins, tbl, o1, o2, pP0];
  ok(all.every((p) => p && p.rid === rid && p.memo === false && !p.memoId), `요청 제안 ${all.length}건(대상 문단·다른 문단·문단 추가·표·여러 안·REST memo: true) — 모두 제안 메모 없음`);
  const memos1 = await A(`${DA}/memos`);
  ok(memos1.length === memosBefore + 1 && !memos1.some((m) => m.text.startsWith('[제안 ')) && memos1.filter((m) => m.link?.type === 'request' && m.link.rid === rid).length === 1,
    `문서 메모 = 원래 ${memosBefore} + 작업 기록 메모 1(제안 메모 0)`);
  const pB = await B(`${DA}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '맺는말' } });
  const pBm = (await A(`${DA}/memos`)).find((m) => m.id === pB.memoId);
  ok(pB.memo === true && pB.memoId && pBm?.text.startsWith(`[제안 ${pB.pid}] ${nameB}\n`) && pBm.link?.type === 'proposal', `요청 없는 제안(사람이 직접 낸 것)은 예전처럼 제안 메모(${pB.memoId})`);
  ok((await mcpOk(srv.base, TA, 'complete_request', { doc_id: dA.id, request_id: rid, summary: '표현 여러 곳을 다듬도록 제안함' }, AG)).status === 'done', '에이전트 complete_request');

  // ───────── 2. 요청 보기 outcome ─────────
  section('요청 보기의 해결 상태 outcome(REST 하나·목록·MCP get_request·list_requests) · 작업 기록 메모 결과 줄');
  const rq0 = await A(`${DA}/requests/${rid}`);
  const pendAll = all.map((p) => p.pid).sort((x, y) => x - y);
  ok(rq0.status === 'done' && eq(rq0.outcome, { items: 8, accepted: 0, applied: 0, adopted: 0, declined: 0, open: 8, comments: 0, resolved: false, openPids: pendAll }) && rq0.resolvedAt === null,
    `GET /requests/${rid} outcome ${JSON.stringify(rq0.outcome)}(여러 안 묶음 = 항목 하나, openPids 는 묶음의 안까지)`);
  const listV = (await B(`${DA}/requests`)).find((r) => r.rid === rid);
  ok(eq(listV.outcome, rq0.outcome) && listV.resolvedAt === null && listV.resolvedBy === null, 'GET /requests 목록(남이 봐도) 같은 outcome·resolvedAt·resolvedBy');
  const gr = await mcpOk(srv.base, TA, 'get_request', { doc_id: dA.id, request_id: rid }, AG);
  const lr = await mcpOk(srv.base, TA, 'list_requests', { doc_id: dA.id, status: 'all' }, AG);
  ok(eq(gr.outcome, rq0.outcome) && gr.resolvedAt === null && eq(lr.find((x) => x.rid === rid)?.outcome, rq0.outcome), 'MCP get_request·list_requests 에도 outcome');
  const memoOf = async (D, mid) => (await A(`${D}/memos`)).find((m) => m.id === mid)?.text ?? '';
  let mt = await memoOf(DA, q.request.memoId);
  ok(mt.split('\n').includes('결과: 안 2개 — 고르는 중 · 남은 제안 7건') && !mt.includes(' · 「') && !mt.includes('✓ 해결'), `작업 기록 메모(남은 것은 목록에 없음):\n      ${indent(mt)}`);

  // ───────── 3. resolve 검사 ─────────
  section('resolve 검사: 400 NOTHING·BAD_ARGS · 403 DIRECT_APPLY_FORBIDDEN(편집자, allowDirectApply 끔 — 먼저 봄) · 없는 요청 404 — 아무것도 안 바뀜');
  const RS = `${DA}/requests/${rid}/resolve`;
  const vBefore = (await A(DA)).version;
  const bad = [
    [A, {}, 400, 'NOTHING'],
    [A, { adopt: [], apply: [], reject: [] }, 400, 'NOTHING'],
    [A, { reject: [pP5.pid], adopt: [pP5.pid] }, 400, 'BAD_ARGS'],
    [A, { adopt: 'rest' }, 400, 'BAD_ARGS'],
    [A, { reject: 'all' }, 400, 'BAD_ARGS'],
    [A, { reject: [0] }, 400, 'BAD_ARGS'],
    [A, { reject: [pP5.pid], cid: 'x' }, 400, 'BAD_ARGS'],
    [ADM, { apply: [pP3.pid], reject: [pP3.pid] }, 400, 'BAD_ARGS'],
    [A, { apply: 'rest' }, 403, 'DIRECT_APPLY_FORBIDDEN'],
    [B, { apply: [pP3.pid], reject: [pP3.pid] }, 403, 'DIRECT_APPLY_FORBIDDEN'],   // 문을 먼저 본다(BAD_ARGS 보다 먼저)
  ];
  const badRes = [];
  for (const [C, body] of bad) badRes.push(await C.res(RS, { method: 'POST', body }));
  ok(badRes.every((r, i) => r.status === bad[i][2] && r.data.error === bad[i][3]), `잘못된 본문 → ${badRes.map((r) => `${r.status} ${r.data.error}`).join(' · ')}`);
  ok((await A.res(`${DA}/requests/999/resolve`, { method: 'POST', body: { reject: [1] } })).status === 404, '없는 요청 → 404');
  ok((await A(DA)).version === vBefore && (await A(`${DA}/proposals?status=pending`)).length === all.length + 1, '막힌 resolve 는 아무것도 바꾸지 않음(기록·대기 제안 그대로)');

  // ───────── 4. 거절 + 반영 기록 ─────────
  section('섞음(거절 + 내 수정본에 반영 기록): 반영 기록만이면 버전 없음 · 메모에는 반영만(꼬리 — 수정본), 거절은 쓰지 않음 · WS');
  const r1 = await A(RS, { method: 'POST', body: { reject: [pP6.pid], adopt: [pP3.pid, pP4.pid] } });
  ok(eq(r1.counts, { adopted: 2, applied: 0, rejected: 1, failed: 0 }) && eq(r1.results.map((x) => [x.pid, x.action, x.ok]), [[pP6.pid, 'reject', true], [pP3.pid, 'adopt', true], [pP4.pid, 'adopt', true]])
    && r1.milestone === null && r1.version === vBefore + 1, `resolve { reject, adopt } → counts ${JSON.stringify(r1.counts)}, 기록 ${r1.version}(메모 다시 씀), 버전 없음`);
  ok(r1.request.outcome.accepted === 2 && r1.request.outcome.adopted === 2 && r1.request.outcome.declined === 1 && r1.request.outcome.open === 5 && !r1.request.outcome.resolved, `응답 request.outcome ${JSON.stringify(r1.request.outcome)}`);
  let props = await A(`${DA}/proposals`);
  const P_ = (pid) => props.find((p) => p.pid === pid);
  ok(P_(pP6.pid).status === 'rejected' && P_(pP3.pid).status === 'pending' && P_(pP3.pid).adoptedBy?.[nameA]?.cid === null && P_(pP3.pid).adopted?.by === nameA, '제안: 거절 · 반영 기록(대기 그대로, adoptedBy[홍길동] — 변경 요청 아직 없음)');
  mt = await memoOf(DA, q.request.memoId);
  ok(mt.split('\n').includes('결과: 반영 2건 · 안 2개 — 고르는 중 · 남은 제안 4건') && mt.includes('\n · 「사업 개요를」→「사업 개요와 배경을」 — 수정본\n · 「3월부터」→「4월부터」 — 수정본\n')
    && !mt.includes('기대 효과') && !mt.includes('거절'), `메모: 반영한 것만(꼬리 — 수정본), 거절한 것·거절 수 없음:\n      ${indent(mt)}`);
  const rlog1 = (await A(`${DA}/requests/${rid}`)).log;
  ok(rlog1.some((l) => l.action === 'adopt' && l.detail === `#${pP3.pid} 수정본에 반영` && l.by === nameA) && rlog1.some((l) => l.action === 'reject' && l.detail === `#${pP6.pid} 거절`), '요청 log: 반영 기록(adopt)·거절 — 하나하나는 log 에');
  const wsAd = await ws.waitFor((m) => m.type === 'proposal' && m.action === 'adopted' && Array.isArray(m.pids));
  ok(eq(wsAd.pids, [pP3.pid, pP4.pid]) && wsAd.pid === pP3.pid && wsAd.cid === null && wsAd.by === nameA, `WS proposal adopted(pid·pids·cid)`);
  ok(!!(await ws.waitFor((m) => m.type === 'proposal' && m.action === 'batch' && m.count === 3 && m.version === r1.version)), 'WS proposal batch(count 3)');
  const wsU1 = await ws.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === rid && m.version === r1.version);
  ok(!('resolved' in wsU1) && wsU1.owner === nameA, 'WS request update(해결 아님 — resolved 없음, owner)');

  // ───────── 5. 기준에 바로 적용: STALE·NOT_IN_REQUEST ─────────
  section('기준에 바로 적용(관리자): 찾을 글이 없어진 항목(STALE)만 실패 — 그 항목의 문서 변경 없음 · 요청 밖 제안 NOT_IN_REQUEST');
  await ADM(`${DA}/proposals`, { method: 'POST', body: { ref: 's0/p5', find: '1억 원', replace: '9천만 원', applyNow: true } });   // 요청 제안 p5 의 찾을 글이 없어짐
  const v5 = (await A(DA)).version;
  const r2 = await ADM(RS, { method: 'POST', body: { apply: [pP5.pid, pP0.pid, pB.pid] } });
  ok(eq(r2.results.map((x) => [x.pid, x.ok, x.code ?? null]), [[pP5.pid, false, 'STALE'], [pP0.pid, true, null], [pB.pid, false, 'NOT_IN_REQUEST']]) && r2.results[0].error && eq(r2.counts, { adopted: 0, applied: 1, rejected: 0, failed: 2 }) && r2.version === v5 + 1,
    `결과 ${r2.results.map((x) => `#${x.pid} ${x.ok ? 'ok' : x.code}`).join(' · ')} — 기록 하나(${r2.version})`);
  const w2 = (await working(A, dA.id)).doc;
  ok(w2.text('s0/p0').includes('이곳에 있습니다') && w2.text('s0/p5') === '여섯째 문단: 예산은 총 9천만 원입니다.', 'p0 적용 · 실패한 항목(p5)은 문서를 바꾸지 않음');
  props = await A(`${DA}/proposals`);
  ok(P_(pB.pid).status === 'pending' && P_(pP5.pid).status === 'pending' && P_(pP0.pid).status === 'applied', '요청 밖 제안·실패한 제안은 대기 그대로');
  ok(!!(await ws.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.version === r2.version && m.changed?.includes('s0/p0'))), 'WS doc changed(적용한 문단·기록)');
  ok((await A(RS, { method: 'POST', body: { reject: [pP5.pid] } })).counts.rejected === 1, '그 제안은 거절');

  // ───────── 6. apply 'rest' ─────────
  section("apply 'rest' — 남은 항목 중 여러 안 묶음은 빠짐(고르기는 사람이 하나씩) · 문단 추가·표는 적용(문서 순서 뒤에서부터)");
  const r3 = await ADM(RS, { method: 'POST', body: { apply: 'rest' } });
  ok(eq(r3.results.map((x) => [x.pid, x.action, x.ok]), [[ins.pid, 'apply', true], [tbl.pid, 'apply', true]]) && r3.request.outcome.open === 1 && eq(r3.request.outcome.openPids, [o1.pid, o2.pid]) && !r3.request.outcome.resolved && r3.milestone === null,
    `apply rest → 문단 추가·표만(묶음 안 #${o1.pid}·#${o2.pid} 은 남음)`);
  props = await A(`${DA}/proposals`);
  const w3 = (await working(A, dA.id)).doc;
  ok(w3.text(P_(ins.pid).insertedRef) === '덧붙인 문단입니다.' && w3.tables().some((t) => t.ref === P_(tbl.pid).insertedRef) && P_(o1.pid).status === 'pending' && P_(o2.pid).status === 'pending',
    `넣은 문단 ${P_(ins.pid).insertedRef}·표 ${P_(tbl.pid).insertedRef}(표가 앞에 들어가도 문단 추가 자리 맞음), 묶음 안은 대기`);

  // ───────── 7. reject 'rest' → 해결 ─────────
  section("reject 'rest' → 남은 것 없음 → 해결(적용 있음 + 마지막 버전에서 30분 지남 → 버전 request) · 메모 하나(반영만·해결 줄·이력 = 요청 생애) · WS · history·summary");
  ageLastMilestone(srv.dataDir, dA.id);   // 올림(v1)이 31분 전인 것처럼
  const r4 = await ADM(RS, { method: 'POST', body: { reject: 'rest' } });
  ok(eq(r4.results.map((x) => [x.pid, x.action, x.ok]), [[o1.pid, 'reject', true], [o2.pid, 'reject', true]]) && r4.request.outcome.resolved === true && r4.request.resolvedBy === nameAdm && !!r4.request.resolvedAt,
    `reject rest → 묶음 안 거절 → 해결(${r4.request.resolvedBy})`);
  ok(r4.milestone && r4.milestone.kind === 'request' && r4.milestone.v === 2 && r4.milestone.n === r4.version && r4.milestone.note === `AI 작업 #${rid} 해결 — 적용 3건` && r4.milestone.by === nameAdm,
    `응답 milestone ${JSON.stringify(r4.milestone)}`);
  const wsRes = await ws.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === rid && m.resolved === true);
  const wsMs = await ws.waitFor((m) => m.type === 'doc' && m.action === 'milestone' && m.kind === 'request');
  ok(wsRes.version === r4.version && wsMs.v === 2 && wsMs.n === r4.version && wsMs.by === nameAdm && eq(Object.keys(wsMs).sort(), ['action', 'at', 'by', 'kind', 'n', 'type', 'v']), 'WS request update(resolved: true) · doc milestone { v, n, by, kind }(+ 허브의 at)');
  mt = await memoOf(DA, q.request.memoId);
  const mls = mt.split('\n');
  ok(mls.includes('결과: 반영 5건') && eq(mls.filter((l) => l.startsWith(' · ')), [
    ' · 「여기 있습니다」→「이곳에 있습니다」', ' · 표 2×2 「시험」', ' · 「사업 개요를」→「사업 개요와 배경을」 — 수정본', ' · 「3월부터」→「4월부터」 — 수정본', ' · 문단 추가 「덧붙인 문단입니다.」',
  ]) && new RegExp(`^✓ 해결 · ${nameAdm} \\d\\d-\\d\\d \\d\\d:\\d\\d$`).test(mls.find((l) => l.startsWith('✓ ')) || '')
    && !mt.includes('거절') && !mt.includes('기대 효과') && !mt.includes('1억') && !mt.includes('기존 낱말'), `작업 기록 메모(한글에서 보이는 글 — 반영 5건만, 문서 순서):\n      ${indent(mt)}`);
  const hist = mls.find((l) => l.startsWith('이력: ')) || '';
  ok(new RegExp(`요청\\(${nameA}\\) · ${TM} 처리 시작\\(Claude Code\\) · ${TM} 완료\\(Claude Code\\) · ${TM} 해결\\(${nameAdm}\\)$`).test(hist) && !/적용|거절|제안|반영/.test(hist), `이력 줄 = 요청 생애만: ${hist}`);
  const rq7 = await A(`${DA}/requests/${rid}`);
  ok(rq7.log.filter((l) => l.action === 'resolve').length === 1 && rq7.log.find((l) => l.action === 'resolve').detail === '해결 — 반영 5 · 거절 3' && rq7.resolvedAt === r4.request.resolvedAt,
    '요청 log resolve(해결 — 반영 5 · 거절 3) · 저장된 resolvedAt');
  const h7 = await A(`${DA}/history`);
  ok(h7.milestones.length === 2 && h7.milestones[0].kind === 'upload' && h7.milestones[1].kind === 'request' && h7.versions.find((x) => x.n === r4.version)?.v === 2 && Array.isArray(h7.activity),
    'GET /history → { versions(이정표 기록에 v), activity, milestones }');
  const s7 = await A(DA);
  ok(s7.milestone?.v === 2 && s7.milestone.kind === 'request' && s7.milestone.n === r4.version && s7.sinceMilestone === 0 && s7.version === r4.version, 'GET /api/docs/:id → milestone(v2)·sinceMilestone 0·version 은 기록 n 그대로');
  ok((await A('/api/docs')).find((d) => d.id === dA.id)?.milestone?.v === 2, '문서 목록에도 milestone');
  const hm = await mcpOk(srv.base, TA, 'get_history', { doc_id: dA.id }, AG);
  ok(Array.isArray(hm.milestones) && hm.milestones.length === 2, 'MCP get_history 에도 milestones');

  // ───────── 8. 다시 열기 → 풀림 → 다시 해결 ─────────
  section('해결된 요청의 제안 다시 열기 → 해결 풀림(reopen 기록 — 제안의 다시 열기는 proposal-reopen) → 다시 거절 → 다시 해결');
  await A(`${DA}/proposals/${pP6.pid}/reopen`, { method: 'POST' });
  const rq8 = await A(`${DA}/requests/${rid}`);
  const tail = rq8.log.slice(-2);
  ok(rq8.outcome.resolved === false && rq8.resolvedAt === null && rq8.resolvedBy === null && tail[0].action === 'proposal-reopen' && tail[0].detail === `#${pP6.pid} 다시 열기` && tail[1].action === 'reopen' && tail[1].detail === '다시 열림 — 남은 1건',
    `log …${tail.map((l) => `${l.action}(${l.detail})`).join(' · ')} · resolvedAt·resolvedBy 비움`);
  mt = await memoOf(DA, q.request.memoId);
  ok(!mt.includes('✓ 해결') && new RegExp(`다시 열림\\(${nameA}\\)$`).test(mt.split('\n').find((l) => l.startsWith('이력: ')) || '') && mt.split('\n').includes('결과: 반영 5건 · 남은 제안 1건'), '메모: 해결 줄 빠짐, 이력 「다시 열림」, 남은 제안 1건');
  const msN = (await A(`${DA}/history`)).milestones.length;
  await A(`${DA}/proposals/${pP6.pid}/reject`, { method: 'POST' });
  const rq8b = await A(`${DA}/requests/${rid}`);
  ok(rq8b.outcome.resolved && rq8b.resolvedBy === nameA && (await A(`${DA}/history`)).milestones.length === msN, '다시 거절 → 다시 해결(홍길동) — 마지막 버전(v2) 뒤로 새로 적용한 것이 없어 버전은 그대로');
  ok(!!(await ws.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === rid && m.resolved === true && m.by === nameA)), 'WS request update(resolved: true) — 제안 하나의 거절로 해결');
  // 다시 열어 이번에는 기준에 적용 → 마지막 버전 뒤의 새 적용이 있지만 마지막 버전(v2)에서 30분이 안 지나 버전을 만들지 않는다(V4 §2.6)
  await A(`${DA}/proposals/${pP6.pid}/reopen`, { method: 'POST' });
  const r8c = await ADM(RS, { method: 'POST', body: { apply: [pP6.pid] } });
  ok(r8c.counts.applied === 1 && r8c.request.outcome.resolved && r8c.milestone === null && (await A(`${DA}/history`)).milestones.length === msN,
    '다시 열고 적용 → 다시 해결 — 새로 적용한 것이 있지만 마지막 버전(v2)에서 30분 안이라 버전 없음(다음 버전에 함께 담김)');
  // 30분이 지난 뒤 다른 AI 작업이 해결되면 버전 하나 — note 는 마지막 버전 뒤로 쌓인 적용 모두(앞서 해결된 요청 #rid 의 1건 + 이번 1건)
  const qZ = await A(`${DA}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '둘째 문단 다듬기', target: { ref: 's0/p1' }, route: 'queue' } });
  const ridZ = qZ.request.rid;
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dA.id, request_id: ridZ }, AG);
  const pZ = (await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dA.id, request_id: ridZ, proposals: [{ ref: 's0/p1', find: '있던 낱말을', replace: '있던 말을' }] }, AG))[0].proposal;
  await mcpOk(srv.base, TA, 'complete_request', { doc_id: dA.id, request_id: ridZ, summary: '둘째 문단 다듬기' }, AG);
  ageLastMilestone(srv.dataDir, dA.id);
  const r8d = await ADM(`${DA}/requests/${ridZ}/resolve`, { method: 'POST', body: { apply: [pZ.pid] } });
  ok(r8d.counts.applied === 1 && r8d.request.outcome.resolved && r8d.milestone?.kind === 'request' && r8d.milestone.v === msN + 1 && r8d.milestone.note === `AI 작업 #${rid}·#${ridZ} 해결 — 적용 2건`,
    `30분 지난 뒤 다른 AI 작업 해결 → 버전 하나(그동안 쌓인 적용 함께): ${JSON.stringify(r8d.milestone)}`);

  // ───────── 9. 반영 기록·변경 요청 ─────────
  section('하나짜리 adopt 로 해결(반영 기록만 → 버전 없음) · 수정 버림·변경 요청 닫기 → 풀림 · 다시 열기 → 다시 해결 · 반영 → v(baseV·mergedV)');
  const dB = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '반영 기록.hwpx');
  const DB = `/api/docs/${dB.id}`;
  const wsB = watchWs(srv.base, srv.tokens.b, dB.id); sockets.push(wsB); await wsB.ready;
  const qB = await A(`${DB}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '개요와 일정을 다듬어 주세요', target: { ref: 's0/p3' }, route: 'queue' } });
  const ridB = qB.request.rid;
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dB.id, request_id: ridB }, AG);
  const pcB = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dB.id, request_id: ridB, proposals: [{ ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목표를' }, { ref: 's0/p4', find: '3월부터', replace: '5월부터' }] }, AG);
  const [b1, b2] = pcB.map((x) => x.proposal);
  await mcpOk(srv.base, TA, 'complete_request', { doc_id: dB.id, request_id: ridB, summary: '개요·일정 다듬기' }, AG);
  const ad1 = await A(`${DB}/proposals/${b1.pid}/adopt`, { method: 'POST', body: {} });
  let rB = await A(`${DB}/requests/${ridB}`);
  ok(ad1.proposal.adopted?.by === nameA && ad1.cr === null && rB.outcome.accepted === 1 && rB.outcome.open === 1 && !rB.outcome.resolved && rB.log.some((l) => l.action === 'adopt' && l.detail === `#${b1.pid} 수정본에 반영`),
    '하나짜리 adopt → { proposal, cr } 그대로 + 요청 다시 셈(반영 1·남음 1), 요청 log adopt');
  const wsUB = await wsB.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === ridB && m.by === nameA);
  ok(!('resolved' in wsUB) && !!(await wsB.waitFor((m) => m.type === 'proposal' && m.action === 'adopted' && m.pid === b1.pid && m.cid === null)), 'WS proposal adopted + request update(요청에 딸린 제안)');
  const vB0 = (await A(DB)).version;
  await A(`${DB}/proposals/${b2.pid}/adopt`, { method: 'POST', body: {} });
  rB = await A(`${DB}/requests/${ridB}`);
  ok(rB.outcome.resolved && rB.outcome.adopted === 2 && rB.outcome.applied === 0 && rB.resolvedBy === nameA && rB.log.at(-1).action === 'resolve' && rB.log.at(-1).detail === '해결 — 반영 2', '마지막 남은 제안을 하나짜리 adopt → 해결(반영 2)');
  ok((await A(`${DB}/history`)).milestones.length === 1 && (await A(DB)).version === vB0 + 1, '반영 기록만으로 해결 → 버전 없음(기록 하나 — 작업 기록 메모)');
  ok((await wsB.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === ridB && m.resolved === true)).by === nameA, 'WS request update(resolved: true) — 하나짜리 adopt');
  let mtB = await memoOf(DB, qB.request.memoId);
  ok(mtB.includes(`\n · 「사업 개요를」→「사업 개요와 목표를」 — 수정본\n · 「3월부터」→「5월부터」 — 수정본\n✓ 해결 · ${nameA} `), `메모: 수정본에만 반영(— 수정본) + 해결 줄:\n      ${indent(mtB)}`);
  const headB = () => makeHead(A, dB.id, (d) => { replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 목표를'); replaceIn(d, 's0/p4', '3월부터', '5월부터'); });
  const crB1 = (await putDraft(A, dB.id, await headB())).cr;
  ok(crB1 && eq([...crB1.adopted].sort((x, y) => x - y), [b1.pid, b2.pid]) && crB1.baseV === 1 && crB1.mergedV === null, `수정본 저장 → 변경 요청 #${crB1.cid}(반영 기록 묶음, baseV 1·mergedV null)`);
  const vB1 = (await A(DB)).version;
  await A(`${DB}/drafts/mine`, { method: 'DELETE' });
  rB = await A(`${DB}/requests/${ridB}`);
  ok(!rB.outcome.resolved && rB.outcome.open === 2 && rB.resolvedAt === null && rB.log.at(-1).action === 'reopen' && rB.log.at(-1).detail === '다시 열림 — 남은 2건' && rB.log.at(-1).by === nameA,
    '수정 버림(draft 지움) → 반영 기록 풀림 → 해결 풀림(다시 열림 — 남은 2건)');
  mtB = await memoOf(DB, qB.request.memoId);
  ok(mtB.split('\n').includes('결과: 남은 제안 2건') && !mtB.includes('✓ 해결') && (await A(DB)).version === vB1 + 1, '작업 기록 메모 다시 씀(따로 _tx — 기록 하나)');
  const rrB = await A(`${DB}/requests/${ridB}/resolve`, { method: 'POST', body: { adopt: [b1.pid, b2.pid] } });
  ok(rrB.request.outcome.resolved && rrB.milestone === null && eq(rrB.counts, { adopted: 2, applied: 0, rejected: 0, failed: 0 }), 'resolve adopt 로 다시 해결(버전 없음)');
  const crB2 = (await putDraft(A, dB.id, await headB())).cr;
  await A(`${DB}/change-requests/${crB2.cid}/submit`, { method: 'POST', body: { title: '개요·일정' } });
  const crBb = (await putDraft(B, dB.id, await makeHead(B, dB.id, (d) => replaceIn(d, 's0/p7', '맺음말', '끝말')))).cr;
  const vB2 = (await A(DB)).version;
  const fb = await A.res(`${DB}/requests/${ridB}/resolve`, { method: 'POST', body: { adopt: [b1.pid], cid: crBb.cid } });
  ok(fb.status === 403 && fb.data.error === 'FORBIDDEN' && (await A(DB)).version === vB2, `남의 변경 요청(#${crBb.cid}) cid 로 반영 기록 → 403 FORBIDDEN(아무것도 안 바뀜)`);
  await B(`${DB}/drafts/mine`, { method: 'DELETE' });
  await A(`${DB}/change-requests/${crB2.cid}/close`, { method: 'POST' });
  rB = await A(`${DB}/requests/${ridB}`);
  ok(!rB.outcome.resolved && rB.outcome.open === 2 && rB.log.at(-1).action === 'reopen', `변경 요청 #${crB2.cid} 닫기 → 반영 기록 풀림 → 해결 풀림`);
  await A(`${DB}/change-requests/${crB2.cid}/reopen`, { method: 'POST' });
  rB = await A(`${DB}/requests/${ridB}`);
  mtB = await memoOf(DB, qB.request.memoId);
  ok(rB.outcome.resolved && rB.log.at(-1).action === 'resolve' && mtB.includes(`\n · 「사업 개요를」→「사업 개요와 목표를」 — 변경 요청 #${crB2.cid}\n · 「3월부터」→「5월부터」 — 변경 요청 #${crB2.cid}\n`),
    `변경 요청 다시 열기 → 반영 기록 되살아남 → 다시 해결, 메모 꼬리 「— 변경 요청 #${crB2.cid}」`);
  ok(!wsB.msgs.some((m) => m.type === 'doc' && m.action === 'milestone'), '여기까지(반영 기록·풀림·다시 해결) WS doc milestone 없음');
  await A(`${DB}/change-requests/${crB2.cid}/submit`, { method: 'POST', body: { title: '개요·일정' } });
  await B(`${DB}/change-requests/${crB2.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const mB = await A(`${DB}/change-requests/${crB2.cid}/merge`, { method: 'POST' });
  ok(mB.v === 2 && mB.cr.mergedV === 2 && mB.cr.baseV === 1 && mB.cr.mergedVersion === mB.version && eq([...mB.report.adopted.applied].sort((x, y) => x - y), [b1.pid, b2.pid]) && mB.cr.log.at(-1).action === 'merge' && mB.cr.log.at(-1).detail === 'v2로 반영',
    `반영 → { version ${mB.version}, v ${mB.v} } · cr.mergedV 2·baseV 1 · 기록 「${mB.cr.log.at(-1).detail}」(조사)`);
  const hB = await A(`${DB}/history`);
  ok(hB.milestones.length === 2 && hB.milestones[1].kind === 'merge' && hB.milestones[1].note === `변경 요청 #${crB2.cid} 반영 — 개요·일정` && hB.milestones[1].n === mB.version && hB.milestones[1].by === nameA, `이정표 merge 「${hB.milestones[1].note}」`);
  const wsM = await wsB.waitFor((m) => m.type === 'cr' && m.action === 'merged');
  const wsDC = await wsB.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.cr === crB2.cid);
  const wsMsB = await wsB.waitFor((m) => m.type === 'doc' && m.action === 'milestone');
  ok(wsM.v === 2 && wsDC.v === 2 && wsMsB.kind === 'merge' && wsMsB.v === 2 && wsMsB.n === mB.version, 'WS cr merged·doc changed 에 v, doc milestone(merge)');
  const cvB = await A(`${DB}/change-requests/${crB2.cid}`);
  ok(cvB.mergedV === 2 && cvB.baseV === 1, 'CRView(GET) baseV 1 · mergedV 2');
  rB = await A(`${DB}/requests/${ridB}`);
  mtB = await memoOf(DB, qB.request.memoId);
  ok(rB.outcome.resolved && rB.outcome.applied === 2 && rB.outcome.adopted === 0 && !mtB.includes(' — 변경 요청') && !mtB.includes(' — 수정본') && mtB.includes('\n · 「사업 개요를」→「사업 개요와 목표를」\n'),
    '반영으로 적용된 제안 → 요청은 해결 그대로(적용 2), 메모 꼬리 없음(기준에 들어감)');
  const crB4 = (await putDraft(B, dB.id, await makeHead(B, dB.id, (d) => replaceIn(d, 's0/p7', '맺음말', '맺는 말')))).cr;
  ok(crB4.baseV === 2 && crB4.baseVersion === mB.version, `반영 뒤 새 수정본 → baseV 2(기록 ${crB4.baseVersion})`);
  await B(`${DB}/drafts/mine`, { method: 'DELETE' });
  // 취소된 요청도 받는다: 남은 제안을 거절하면 해결(적용 없음 → 버전 없음)
  const qC = await A(`${DB}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '맺음말 다듬기', target: { ref: 's0/p7' }, route: 'queue' } });
  await mcpOk(srv.base, TA, 'propose_change', { doc_id: dB.id, request_id: qC.request.rid, ref: 's0/p7', find: '맺음말', replace: '맺는말' }, AG);
  const cq = await A(`${DB}/requests/${qC.request.rid}/cancel`, { method: 'POST' });
  const msB = (await A(`${DB}/history`)).milestones.length;
  const rC = await A(`${DB}/requests/${qC.request.rid}/resolve`, { method: 'POST', body: { reject: 'rest' } });
  ok(cq.status === 'cancelled' && !cq.outcome.resolved && rC.counts.rejected === 1 && rC.request.outcome.resolved && rC.milestone === null && (await A(`${DB}/history`)).milestones.length === msB,
    '취소된 요청도 resolve(reject rest) → 해결, 적용 없음 → 버전 없음');

  // ───────── 10. 버전(이정표) ─────────
  section('사람용 버전: 올림 v1 · 메모·직접 고침·변경 수락은 기록만 · [버전 저장](편집자도)·NO_CHANGES · 복구 두 꼴 · 편집본 올림(live 는 아님)');
  const dC = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '버전.hwpx');
  const DC = `/api/docs/${dC.id}`;
  const wsC = watchWs(srv.base, srv.tokens.a, dC.id); sockets.push(wsC); await wsC.ready;
  const sC0 = await A(DC);
  ok(eq(sC0.milestone, { v: 1, n: 1, at: sC0.milestone?.at, by: nameAdm, kind: 'upload', note: '올림' }) && !Number.isNaN(Date.parse(sC0.milestone.at)) && sC0.sinceMilestone === 0 && sC0.version === 1, `올림 → milestone ${JSON.stringify(sC0.milestone)}`);
  let hC = await A(`${DC}/history`);
  ok(hC.milestones.length === 1 && hC.versions[0].v === 1 && hC.versions[0].n === 1, 'history: 기록 n1 = v1');
  await A(`${DC}/memos`, { method: 'POST', body: { ref: 's0/p1', text: '메모 하나' } });
  await ADM(`${DC}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을', applyNow: true } });
  await ADM(`${DC}/changes/accept-all`, { method: 'POST' });
  let sC = await A(DC);
  ok(sC.version === 4 && sC.milestone.v === 1 && sC.sinceMilestone === 3 && (await A(`${DC}/history`)).milestones.length === 1 && !wsC.msgs.some((m) => m.action === 'milestone'),
    '메모 달기·직접 고침·변경 수락 → 기록만(버전 v1 그대로, 그 뒤 기록 3)');
  const ms2 = await B(`${DC}/milestones`, { method: 'POST', body: { note: '  1차 검토\n끝  ' } });
  ok(eq({ ...ms2.milestone, at: 0 }, { v: 2, n: 4, at: 0, by: nameB, kind: 'manual', note: '1차 검토 끝' }) && !Number.isNaN(Date.parse(ms2.milestone.at)), `버전 저장(편집자도) → ${JSON.stringify(ms2.milestone)}`);
  const wsMs2 = await wsC.waitFor((m) => m.type === 'doc' && m.action === 'milestone' && m.v === 2);
  ok(wsMs2.n === 4 && wsMs2.by === nameB && wsMs2.kind === 'manual', 'WS doc milestone(manual)');
  const nc = await A.res(`${DC}/milestones`, { method: 'POST', body: {} });
  ok(nc.status === 409 && nc.data.error === 'NO_CHANGES' && nc.data.message === '마지막 버전 뒤로 바뀐 것이 없습니다' && (await A(DC)).version === 4, '바뀐 것 없이 버전 저장 → 409 NO_CHANGES');
  hC = await A(`${DC}/history`);
  sC = await A(DC);
  ok(hC.versions.find((x) => x.n === 4)?.v === 2 && sC.sinceMilestone === 0 && sC.milestone.v === 2 && sC.version === 4, '그 기록(n4)에 v2 · summary milestone v2(문서는 그대로 — 기록 n4)');
  await A(`${DC}/memos`, { method: 'POST', body: { ref: 's0/p2', text: '메모 둘' } });
  const ms3 = await A(`${DC}/milestones`, { method: 'POST', body: { note: ' \u0001 ' } });
  ok(ms3.milestone.v === 3 && ms3.milestone.n === 5 && ms3.milestone.note === '버전 저장', '빈 메모(제어 문자·공백뿐)로 버전 저장 → note 「버전 저장」');
  await A(`${DC}/memos`, { method: 'POST', body: { ref: 's0/p2', text: '메모 셋' } });
  const ms4 = await A(`${DC}/milestones`, { method: 'POST', body: { note: '가'.repeat(250) } });
  ok(ms4.milestone.v === 4 && [...ms4.milestone.note].length === 200, '버전 메모는 200자까지');
  const vRs = (await A(DC)).version;
  const rs1 = await ADM(`${DC}/versions/1/restore`, { method: 'POST' });
  ok(rs1.version === vRs + 1 && rs1.v === 5, `이정표 v1(기록 1) 파일로 교체 → 기록 ${rs1.version}, 버전 v${rs1.v}`);
  const currentFile = () => A(`${DC}/file?kind=tracked`);
  const recordFile = n => A(`${DC}/file?kind=version&n=${n}`);
  ok((await currentFile()).equals(await recordFile(1)), '교체 뒤 파일은 v1과 바이트가 같다');
  hC = await A(`${DC}/history`);
  ok(hC.milestones.at(-1).kind === 'restore' && hC.milestones.at(-1).note === 'v1 파일로 교체' && hC.versions.find((x) => x.n === rs1.version)?.note === 'v1 파일로 교체', '버전과 기록의 메모 「v1 파일로 교체」');
  const wsRs = await wsC.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.restore === 1);
  ok(wsRs.v === 5 && !!(await wsC.waitFor((m) => m.type === 'doc' && m.action === 'milestone' && m.kind === 'restore')), 'WS doc changed(restore) 에 v · doc milestone(restore)');
  const n3 = hC.versions.find((x) => x.n === 3);
  const rs2 = await ADM(`${DC}/versions/3/restore`, { method: 'POST' });
  hC = await A(`${DC}/history`);
  ok(rs2.v === 6 && (await currentFile()).equals(await recordFile(3)) && hC.milestones.at(-1).note === `${fmtTime(n3.at)} 기록 파일로 교체`,
    `이정표 아닌 기록(n3) 파일로 교체 → v6, 이정표 「${hC.milestones.at(-1).note}」`);
  const rsSame = await ADM(`${DC}/versions/3/restore`, { method: 'POST' });
  ok(rsSame.unchanged === true && !('v' in rsSame) && (await A(`${DC}/history`)).milestones.length === hC.milestones.length, '바뀐 것 없는 복구 → unchanged, v 없음(버전 안 오름)');
  const { doc: wU, version: vU } = await working(ADM, dC.id);
  const wU2 = await wU.clone(); replaceIn(wU2, 's0/p7', '맺음말', '맺음말(올림)');
  const upR = await ADM(`${DC}/upload?base=${vU}`, { method: 'PUT', body: Buffer.from(await wU2.save()) });
  ok(upR.version === vU + 1 && upR.v === 7 && Array.isArray(upR.conflicts), `편집본 올림(관리자) → { version ${upR.version}, v ${upR.v} }`);
  const { doc: wL, version: vL } = await working(ADM, dC.id);
  const wL2 = await wL.clone(); replaceIn(wL2, 's0/p6', '기대 효과를', '기대 효과를(실시간)');
  const upL = await ADM(`${DC}/upload?base=${vL}&live=1`, { method: 'PUT', body: Buffer.from(await wL2.save()) });
  hC = await A(`${DC}/history`);
  ok(upL.version === vL + 1 && !('v' in upL) && eq(hC.milestones.map((m) => m.kind), ['upload', 'manual', 'manual', 'manual', 'restore', 'restore', 'upload']) && hC.milestones.at(-1).note === '편집본 올림',
    `실시간 편집(live=1) → 기록만(v 없음) · 이정표 ${hC.milestones.map((m) => `v${m.v} ${m.kind}`).join(' · ')}`);
  ok(hC.milestones.every((m, i) => m.v === i + 1) && hC.milestones.every((m) => hC.versions.find((x) => x.n === m.n)?.v === m.v), '이정표 v 는 1씩 늘고, 그 기록마다 v');

  // ───────── 11. 옛 자료 ─────────
  section('옛 자료: milestones 없는 meta → versions note 로 만들기 · 옛 제안 메모 거두기 · resolvedAt 없는 옛 요청');
  const dD = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '옛 자료.hwpx');
  const DD = `/api/docs/${dD.id}`;
  for (let i = 0; i < 4; i++) await A(`${DD}/memos`, { method: 'POST', body: { ref: `s0/p${i + 1}`, text: `옛 메모 ${i}` } });   // 기록 n2..n5
  const metaPath = path.join(srv.dataDir, 'docs', dD.id, 'meta.json');
  const readMeta = () => JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const writeMeta = (m) => fs.writeFileSync(metaPath, JSON.stringify(m, null, 1));
  const mm = readMeta();
  const legacyNotes = { 2: '변경 요청 #1 반영', 3: 'v1 내용으로 복구', 4: '편집본 올림', 5: '메모 memo5' };
  for (const x of mm.versions) { delete x.v; if (legacyNotes[x.n]) x.note = legacyNotes[x.n]; }
  delete mm.milestones;
  writeMeta(mm);
  const hD = await A(`${DD}/history`);
  ok(eq(hD.milestones.map((m) => [m.v, m.n, m.kind, m.note]), [[1, 1, 'upload', '올림'], [2, 2, 'merge', '변경 요청 #1 반영'], [3, 3, 'restore', 'v1 내용으로 복구'], [4, 4, 'upload', '편집본 올림']])
    && eq(hD.versions.map((x) => x.v ?? null), [1, 2, 3, 4, null]), `옛 meta(milestones 없음) → ${hD.milestones.map((m) => `v${m.v} ${m.kind}`).join(' · ')}(나머지는 기록)`);
  const sD = await A(DD);
  ok(sD.milestone?.v === 4 && sD.milestone.n === 4 && sD.sinceMilestone === 1, 'summary: milestone v4 · 그 뒤 기록 1');
  const msD = await A(`${DD}/milestones`, { method: 'POST', body: { note: '옛 자료 다음' } });
  ok(msD.milestone.v === 5 && msD.milestone.n === 5 && readMeta().milestones.length === 5, '그 뒤 버전 저장 → v5(만든 milestones 를 저장)');
  // 옛 제안 메모(v0.3.0 까지 요청 제안도 메모가 있었다): meta 를 고쳐 요청 없는 제안 3개를 요청에 묶는다
  const qL = await A(`${DD}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '옛 요청', target: { ref: 's0/p3' }, route: 'queue' } });
  const ridL = qL.request.rid;
  const l1 = await B(`${DD}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터' } });
  const l2 = await B(`${DD}/proposals`, { method: 'POST', body: { ref: 's0/p5', find: '1억 원', replace: '2억 원' } });
  const l3 = await B(`${DD}/proposals`, { method: 'POST', body: { ref: 's0/p6', find: '기대 효과를', replace: '기대 효과를 모두' } });
  const l4 = await B(`${DD}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '맺는말' } });
  ok([l1, l2, l3, l4].every((p) => p.memo && p.memoId), '(전제) 제안 메모 4개');
  await A(`${DD}/memos/${l2.memoId}/replies`, { method: 'POST', body: { text: '이 숫자 맞나요?' } });   // 사람의 대화 — 남긴다
  await ADM(`${DD}/memos/${l3.memoId}/resolve`, { method: 'POST', body: { resolved: true } });         // 해결만(답글 없음) — 거둔다
  await B(`${DD}/memos/${l4.memoId}`, { method: 'PATCH', body: { text: '용어집 표기 확인' } });         // 사람 메모 줄(note) — 남긴다
  const ml = readMeta();
  for (const p of ml.proposals) if ([l1.pid, l2.pid, l3.pid, l4.pid].includes(p.pid)) p.rid = ridL;
  ml.requests.find((r) => r.rid === ridL).proposals.push(l1.pid, l2.pid, l3.pid, l4.pid);
  writeMeta(ml);
  const memL = await A(`${DD}/memos`);
  const keyOf = (pid0) => memL.find((m) => m.proposal?.pid === pid0)?.key;
  const [k1, k2, k3] = [keyOf(l1.pid), keyOf(l2.pid), keyOf(l3.pid)];
  ok(k1 && k2 && k3 && k3 in readMeta().memoThreads && k2 in readMeta().memoThreads, '(전제) 옛 요청 제안 메모 3개 — 스레드: 답글 하나·해결만 하나');
  await A(`${DD}/memos/${qL.request.memoId}`, { method: 'DELETE' });   // 작업 기록 메모를 지운 요청(memoDeleted)이어도 거둔다
  const rL = await A(`${DD}/requests/${ridL}/resolve`, { method: 'POST', body: { reject: [l1.pid] } });   // 그 요청을 다시 셈 → 거두기
  const memL2 = await A(`${DD}/memos`);
  const propsL = await A(`${DD}/proposals`);
  const PL = (pid0) => propsL.find((p) => p.pid === pid0);
  ok(rL.counts.rejected === 1 && !memL2.some((m) => m.id === l1.memoId) && !memL2.some((m) => m.id === l3.memoId) && memL2.some((m) => m.id === l2.memoId && m.text.includes('\n── 답글\n')),
    '요청을 다시 셀 때 답글 없는 옛 제안 메모(거절한 것·해결만 된 것) 거둠, 답글 있는 것은 남김');
  ok(memL2.some((m) => m.id === l4.memoId && m.text.includes('\n메모: 용어집 표기 확인')) && propsL.find((p) => p.pid === l4.pid).memo === true,
    '사람 메모 줄(note)이 있는 옛 제안 메모도 남김(지우면 한글 문서에서 그 글이 사라진다)');
  const mlAfter = readMeta();
  ok(PL(l1.pid).memo === false && PL(l1.pid).memoId == null && PL(l3.pid).memo === false && PL(l3.pid).memoId == null && PL(l2.pid).memo === true && PL(l2.pid).memoId === l2.memoId
    && !(k1 in mlAfter.memoThreads) && !(k3 in mlAfter.memoThreads) && k2 in mlAfter.memoThreads, '제안 memo·memoId 와 meta.memoThreads 의 그 키도 정리(답글 있는 것은 그대로)');
  ok(!memL2.some((m) => m.link?.type === 'request' && m.link.rid === ridL) && mlAfter.requests.find((r) => r.rid === ridL).memoDeleted === true, '작업 기록 메모를 지운 요청은 메모를 다시 만들지 않음');
  // resolvedAt 없는 옛 요청: 이미 해결된 것이면 그 끝난 때 해결된 것으로 본다 — 처음 건드려도 해결 기록·버전을 새로 만들지 않는다
  const qM = await A(`${DD}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '옛 해결', target: { ref: 's0/p1' }, route: 'queue' } });
  const ridM = qM.request.rid;
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dD.id, request_id: ridM }, AG);
  const pM = await mcpOk(srv.base, TA, 'propose_change', { doc_id: dD.id, ref: 's0/p1', find: '있던 낱말을', replace: '기존 낱말을', request_id: ridM }, AG);
  await mcpOk(srv.base, TA, 'complete_request', { doc_id: dD.id, request_id: ridM, summary: '옛 해결' }, AG);
  await ADM(`${DD}/requests/${ridM}/resolve`, { method: 'POST', body: { apply: [pM.pid] } });
  const mlM = readMeta();
  const rM0 = mlM.requests.find((r) => r.rid === ridM);
  const appliedAt = mlM.proposals.find((p) => p.pid === pM.pid).appliedAt;
  ok(!!rM0.resolvedAt && rM0.log.some((l) => l.action === 'resolve'), '(전제) 적용으로 해결된 요청');
  delete rM0.resolvedAt; delete rM0.resolvedBy; rM0.log = rM0.log.filter((l) => l.action !== 'resolve');   // v0.3.0 때 모양
  writeMeta(mlM);
  const rMv = await A(`${DD}/requests/${ridM}`);
  ok(rMv.outcome.resolved && rMv.resolvedAt === appliedAt && rMv.resolvedBy === nameAdm && !rMv.log.some((l) => l.action === 'resolve'), `옛 요청(resolvedAt 없음) 보기 → 마지막 결정 때(${rMv.resolvedBy}) 해결된 것으로, 기록은 만들지 않음`);
  const nMs = (await A(`${DD}/history`)).milestones.length; const vM = (await A(DD)).version;
  await B(`${DD}/memos/${qM.request.memoId}/replies`, { method: 'POST', body: { text: '확인했습니다' } });   // 그 요청을 다시 셈(메모 다시 씀)
  const rMv2 = await A(`${DD}/requests/${ridM}`);
  ok(!rMv2.log.some((l) => l.action === 'resolve') && (await A(`${DD}/history`)).milestones.length === nMs && (await A(DD)).version === vM + 1 && rMv2.resolvedAt === appliedAt && readMeta().requests.find((r) => r.rid === ridM).resolvedAt === appliedAt,
    '옛 요청을 처음 건드려도(작업 기록 메모 답글) 해결 기록·버전을 새로 만들지 않음(resolvedAt 은 저장)');
  ok((await memoOf(DD, qM.request.memoId)).includes(`\n✓ 해결 · ${nameAdm} ${fmtTime(appliedAt)}\n`), '그 메모도 새 꼴(해결 줄)로 다시 씀');
  // v0.3.0 의 요청 메모 [해결](스레드 해결 표시)은 요청 해결과 따로 놀았다 — 요청 메모 글에는 요청 해결 줄만(옛 '✓ 해결됨' 줄은 쓰지 않음, 답글은 그대로)
  await ADM(`${DD}/memos/${qM.request.memoId}/resolve`, { method: 'POST', body: { resolved: true } });
  const tM = await memoOf(DD, qM.request.memoId);
  ok(!tM.includes('✓ 해결됨') && tM.includes(`\n✓ 해결 · ${nameAdm} `) && tM.includes('\n── 답글\n') && tM.includes('확인했습니다'), `요청 메모의 스레드 해결 표시는 쓰지 않음(요청 해결 줄·답글은 그대로):\n      ${indent(tM)}`);

  // ───────── 12. 중첩 문단 번호 지키기 ─────────
  section('중첩 문단 번호 지키기: 표를 품은 본문 문단(글이 표 앞) 대상 요청 + 그 표 칸 제안 → 작업 기록 메모가 여러 줄 늘어난 뒤 적용해도 제 칸');
  const dE = await uploadDoc(srv.base, srv.tokens.admin, await buildTextTableDoc(), '표 앞 글.hwpx');
  const DE = `/api/docs/${dE.id}`;
  const qE = await A(`${DE}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표 값과 글을 고쳐 주세요', target: { ref: 's0/p2' }, route: 'queue' } });
  const ridE = qE.request.rid;
  const cellRef = async (row, col) => (await A(`${DE}/tables`)).find((t) => t.key === 's0/p2#t0').cells.find((c) => c.row === row && c.col === col).refs[0];
  const memoE = (await A(`${DE}/memos`)).find((m) => m.id === qE.request.memoId);
  const c11a = await cellRef(1, 1); const c21a = await cellRef(2, 1);
  ok(memoE?.ref === 's0/p2' && c11a !== 's0/p2/n3', `(전제) 작업 기록 메모가 표 앞 글(s0/p2)에 달려 칸 번호가 밀림: 값 칸(1,1) = ${c11a}`);
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dE.id, request_id: ridE }, AG);
  const pcE = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dE.id, request_id: ridE, proposals: [
    { ref: c11a, find: '1', replace: '10' }, { ref: c21a, find: '2', replace: '20' },
    { ref: 's0/p0', find: '여기 있습니다', replace: '이곳에 있습니다' }, { ref: 's0/p1', find: '있던 낱말을', replace: '기존 낱말을' }, { ref: 's0/p3', find: '둡니다', replace: '그대로 둡니다' },
  ] }, AG);
  ok(pcE.every((x) => x.ok), '표 칸 제안 2 + 다른 문단 제안 3(request_id)');
  const [e11, e21, ...eOthers] = pcE.map((x) => x.proposal);
  const refNow = async (pid0) => (await A(`${DE}/proposals`)).find((p) => p.pid === pid0).ref;
  const c11m = await cellRef(1, 1);
  ok(await refNow(e11.pid) === c11m && await refNow(e21.pid) === await cellRef(2, 1), `제안과 함께 작업 기록 메모 줄이 늘어도(결과 줄) 칸 제안 ref = 지금 그 칸(${c11a} → ${c11m})`);
  for (const p of eOthers) await ADM(`${DE}/requests/${ridE}/resolve`, { method: 'POST', body: { apply: [p.pid] } });   // 하나씩 — 반영 목록이 한 줄씩 늘어 칸 번호가 밀림
  const c11b = await cellRef(1, 1);
  const shift = (r) => Number(/\/n(\d+)$/.exec(r)[1]);
  ok(shift(c11b) - shift(c11m) === 3 && await refNow(e11.pid) === c11b && await refNow(e21.pid) === await cellRef(2, 1), `메모가 3줄 늘어 칸 번호가 ${c11m} → ${c11b} 로 밀려도 칸 제안 ref 가 따라감`);
  const rE = await ADM(`${DE}/requests/${ridE}/resolve`, { method: 'POST', body: { apply: [e11.pid] } });
  const wE = (await working(A, dE.id)).doc;
  ok(rE.results[0].ok && eq(wE.bodyEntries()[0][2].nested.map((n) => n.text), ['구분', '값', '가', '10', '나', '2']) && wE.text('s0/p2') === '표 머리 글', '칸 제안 적용 → 제 칸(값 칸 1,1)에 「10」 — 다른 칸·표 앞 글은 그대로');
  ok(await refNow(e21.pid) === await cellRef(2, 1), '남은 칸 제안(2,1)도 지금 그 칸');
  const rE2 = await ADM(`${DE}/requests/${ridE}/resolve`, { method: 'POST', body: { apply: [e21.pid] } });
  const wE2 = (await working(A, dE.id)).doc;
  const reqE = await A(`${DE}/requests/${ridE}`);
  ok(rE2.results[0].ok && eq(wE2.bodyEntries()[0][2].nested.map((n) => n.text), ['구분', '값', '가', '10', '나', '20']) && reqE.target.ref === 's0/p2' && !reqE.outcome.resolved,
    '마지막 칸 제안도 제 칸에 「20」(요청 대상 s0/p2 그대로 — 처리 중이라 해결은 아님)');

  // ───────── 13. 중첩 문단 번호 지키기 — _finish 밖의 메모 쓰기 ─────────
  section('중첩 문단 번호 지키기(_finish 밖 메모 쓰기): 표 앞 글에 사람 메모·답글·제안 메모 상태 줄·메모 지우기·옛 제안 메모 거두기 → 요청 칸 제안이 제 칸에');
  const dF = await uploadDoc(srv.base, srv.tokens.admin, await buildTextTableDoc([['구분', '값'], ['1', '1'], ['2', '2']]), '표 앞 글 숫자.hwpx');
  const DF = `/api/docs/${dF.id}`;
  const qF = await A(`${DF}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '표 값 고치기', target: { ref: 's0/p0' }, route: 'queue' } });
  const ridF = qF.request.rid;
  const cellF = async (row, col) => (await A(`${DF}/tables`)).find((t) => t.key === 's0/p2#t0').cells.find((c) => c.row === row && c.col === col).refs[0];
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dF.id, request_id: ridF }, AG);
  const pcF = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dF.id, request_id: ridF, proposals: [{ ref: await cellF(1, 1), find: '1', replace: '10' }, { ref: await cellF(2, 1), find: '2', replace: '20' }] }, AG);
  const [f11, f21] = pcF.map((x) => x.proposal);
  ok(pcF.every((x) => x.ok) && !f11.memoId && !f21.memoId, `(전제) 요청 칸 제안 #${f11.pid}@${f11.ref}·#${f21.pid}@${f21.ref} — 제안 메모 없음(메모 자리로 스스로 고쳐지지 않는다)`);
  const refF = async (pid0) => (await A(`${DF}/proposals`)).find((p) => p.pid === pid0).ref;
  const followF = async () => (await refF(f11.pid)) === (await cellF(1, 1)) && (await refF(f21.pid)) === (await cellF(2, 1));
  const stepsF = [];
  const mF = await B(`${DF}/memos`, { method: 'POST', body: { ref: 's0/p2', start: 0, end: 5, text: '표 설명을 보태 주세요' } });
  stepsF.push(['사람 메모 달기', await followF(), await cellF(1, 1)]);
  await A(`${DF}/memos/${mF.id}/replies`, { method: 'POST', body: { text: '네, 보태겠습니다' } });
  stepsF.push(['답글', await followF(), await cellF(1, 1)]);
  const hF = await B(`${DF}/proposals`, { method: 'POST', body: { ref: 's0/p2', find: '표 머리', replace: '표 첫머리' } });
  stepsF.push(['사람 제안(제안 메모)', await followF(), await cellF(1, 1)]);
  await A(`${DF}/proposals/${hF.pid}/reject`, { method: 'POST' });
  stepsF.push(['그 제안 거절(제안 메모 상태 줄)', await followF(), await cellF(1, 1)]);
  const delA = await A.res(`${DF}/memos/${mF.id}`, { method: 'DELETE' });
  ok(delA.status === 403 && delA.data.error === 'FORBIDDEN' && (await A(`${DF}/memos`)).some((m) => m.id === mF.id), '남의 메모 지우기 → 403 FORBIDDEN(지우기도 고치기와 같은 권한 — 작성자·요청자·관리자)');
  await B(`${DF}/memos/${mF.id}`, { method: 'DELETE' });
  stepsF.push(['메모 지우기', await followF(), await cellF(1, 1)]);
  // 옛 자료(v0.3.0 까지 요청 제안도 메모가 있었다): 요청 없는 제안(메모 있음)을 meta 에서 이 요청에 묶고, 거절 → 제안 메모 상태 줄 + 거두기가 한 _tx 에
  const lF = await B(`${DF}/proposals`, { method: 'POST', body: { ref: 's0/p2', find: '머리 글', replace: '머리글' } });
  const metaF = path.join(srv.dataDir, 'docs', dF.id, 'meta.json');
  const mmF = JSON.parse(fs.readFileSync(metaF, 'utf-8'));
  mmF.proposals.find((p) => p.pid === lF.pid).rid = ridF; mmF.requests.find((r) => r.rid === ridF).proposals.push(lF.pid);
  fs.writeFileSync(metaF, JSON.stringify(mmF, null, 1));
  stepsF.push(['옛 요청 제안 메모', await followF(), await cellF(1, 1)]);
  const rlF = await A(`${DF}/requests/${ridF}/resolve`, { method: 'POST', body: { reject: [lF.pid] } });
  ok(rlF.counts.rejected === 1 && !(await A(`${DF}/memos`)).some((m) => m.id === lF.memoId), '(전제) 옛 요청 제안 거절 → 그 제안 메모 거둠');
  stepsF.push(['옛 제안 거절 + 거두기', await followF(), await cellF(1, 1)]);
  ok(stepsF.every((s) => s[1]), `칸 제안 ref 가 매번 지금 칸을 따라감: ${stepsF.map((s) => `${s[0]}(${s[2]}) ${s[1] ? 'ok' : '✗'}`).join(' · ')}`);
  const rF = await ADM(`${DF}/requests/${ridF}/resolve`, { method: 'POST', body: { apply: [f11.pid, f21.pid] } });
  const wF = (await working(A, dF.id)).doc;
  ok(rF.counts.applied === 2 && eq(wF.bodyEntries()[0][2].nested.map((n) => n.text), ['구분', '값', '1', '10', '2', '20']) && wF.text('s0/p2') === '표 머리 글',
    '두 칸 제안 적용 → 제 칸(1,1)·(2,1)에 「10」·「20」 — 같은 글(1·2)이 든 옆 칸은 그대로');

  // ───────── 14. 다시 연 제안의 낡은 반영 기록 ─────────
  section('다시 연 제안: 거절 전의 낡은 반영 기록(adoptedBy)은 지운다 → 남음으로 세어 요청이 다시 열림(메모에 반영으로 적지 않음)');
  const dG = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '다시 열기.hwpx');
  const DG = `/api/docs/${dG.id}`;
  const qG = await A(`${DG}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '두 곳 다듬기', target: { ref: 's0/p3' }, route: 'queue' } });
  const ridG = qG.request.rid;
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dG.id, request_id: ridG }, AG);
  const [g1, g2] = (await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dG.id, request_id: ridG, proposals: [{ ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 범위를' }, { ref: 's0/p4', find: '3월부터', replace: '6월부터' }] }, AG)).map((x) => x.proposal);
  await mcpOk(srv.base, TA, 'complete_request', { doc_id: dG.id, request_id: ridG, summary: '두 곳 다듬기' }, AG);
  await A(`${DG}/proposals/${g1.pid}/adopt`, { method: 'POST', body: {} });   // 내 수정본에 반영해 둠
  await A(`${DG}/proposals/${g1.pid}/reject`, { method: 'POST' });            // 그 뒤 거절(편집기 글은 웹이 먼저 되돌림, §9.7)
  await ADM(`${DG}/requests/${ridG}/resolve`, { method: 'POST', body: { apply: [g2.pid] } });
  const pG0 = (await A(`${DG}/proposals`)).find((p) => p.pid === g1.pid);
  ok((await A(`${DG}/requests/${ridG}`)).outcome.resolved && pG0.status === 'rejected' && !!pG0.adoptedBy?.[nameA], '(전제) 해결된 요청 · 거절한 제안에 반영 기록이 남아 있음(실제 문서 v0.3.0 자료 #7·#8·#10 과 같은 모양)');
  await A(`${DG}/proposals/${g1.pid}/reopen`, { method: 'POST' });
  const rG = await A(`${DG}/requests/${ridG}`);
  const pG1 = (await A(`${DG}/proposals`)).find((p) => p.pid === g1.pid);
  ok(pG1.status === 'pending' && !pG1.adopted && !pG1.adoptedBy && !rG.outcome.resolved && rG.outcome.open === 1 && eq(rG.outcome.openPids, [g1.pid]) && rG.resolvedAt === null && rG.log.at(-1).detail === '다시 열림 — 남은 1건',
    `다시 연 제안 → 반영 기록 지움, 요청 다시 열림(${rG.log.at(-1).detail}) — outcome ${JSON.stringify(rG.outcome)}`);
  const mtG = await memoOf(DG, qG.request.memoId);
  ok(mtG.split('\n').includes('결과: 반영 1건 · 남은 제안 1건') && !mtG.includes('사업 개요와 범위를') && !mtG.includes(' — 수정본') && !mtG.includes('✓ 해결'), `메모: 다시 연 제안은 남은 것(반영 목록에 없음):\n      ${indent(mtG)}`);

  // ───────── 15. 기록 번호를 'v' 로 내지 않음 ─────────
  section("기록 번호(내부 판)를 'v' 로 내지 않는다: STALE_BASE·BAD_BASE·NO_VERSION 글 · 다시 맞추기 기록(사람용 버전) · 기록 내려받기 이름");
  const dH = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '기록 이름.hwpx');
  const DH = `/api/docs/${dH.id}`;
  const hH = await makeHead(A, dH.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 범위를'));
  await putDraft(A, dH.id, hH);   // 홍길동 수정본(기준 = 기록 1 = v1)
  await ADM(`${DH}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '맺는말', applyNow: true } });   // 기준만 바뀜(기록 — 버전 아님)
  const rb1 = await A(`${DH}/drafts/mine/rebase`, { method: 'POST' });
  ok(rb1.cr.log.at(-1).action === 'rebase' && rb1.cr.log.at(-1).detail === '최신 기준 문서로 다시 맞춤(v1 기준)' && rb1.cr.baseV === 1, `다시 맞추기 기록(버전 그대로): 「${rb1.cr.log.at(-1).detail}」`);
  const stH = await A.res(`${DH}/drafts/mine?base=${hH.version}`, { method: 'PUT', body: hH.bytes });
  ok(stH.status === 409 && stH.data.error === 'STALE_BASE' && stH.data.baseVersion === rb1.cr.baseVersion && !/v\d/.test(stH.data.message), `옛 기준 저장 → 409 STALE_BASE { baseVersion } — 글에 기록 번호 없음: 「${stH.data.message}」`);
  const bbH = await A.res(`${DH}/drafts/mine?base=${rb1.cr.baseVersion + 5}`, { method: 'PUT', body: hH.bytes });
  const bfH = await A.res(`${DH}/drafts/mine?base=abc`, { method: 'PUT', body: hH.bytes });
  ok(bbH.status === 400 && bbH.data.error === 'BAD_BASE' && !/v\d/.test(bbH.data.message) && bfH.status === 400 && bfH.data.error === 'BAD_BASE' && !/버전/.test(bfH.data.message),
    `BAD_BASE 글: 「${bbH.data.message}」 · 「${bfH.data.message}」`);
  await ADM(`${DH}/proposals`, { method: 'POST', body: { ref: 's0/p6', find: '기대 효과를', replace: '기대 효과를 모두', applyNow: true } });
  const msH = await B(`${DH}/milestones`, { method: 'POST', body: { note: '중간 저장' } });
  const rb2 = await A(`${DH}/drafts/mine/rebase`, { method: 'POST' });
  ok(msH.milestone.v === 2 && rb2.cr.log.at(-1).detail === 'v1 기준 → v2 기준으로 다시 맞춤' && rb2.cr.baseV === 2, `다시 맞추기 기록(버전이 바뀜): 「${rb2.cr.log.at(-1).detail}」`);
  const histH = await A(`${DH}/history`);
  const dlName = async (n) => { const r = await A.res(`${DH}/file?kind=version&n=${n}`); return r.status === 200 ? decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(r.headers.get('content-disposition') || '')?.[1] || '') : `HTTP ${r.status}`; };
  const recH = histH.versions.find((x) => x.v == null);
  const stampH = fmtTime(recH.at).replace(' ', '_').replace(':', '');
  const namesH = [await dlName(1), await dlName(msH.milestone.n), await dlName(recH.n)];
  ok(eq(namesH, ['기록 이름_v1.hwpx', '기록 이름_v2.hwpx', `기록 이름_${stampH}.hwpx`]), `기록 내려받기 이름(웹 downloadName 과 같은 꼴): ${namesH.join(' · ')}`);
  const nvH = await A.res(`${DH}/file?kind=version&n=999`);
  ok(nvH.status === 404 && nvH.data.error === 'NO_VERSION' && !/버전/.test(nvH.data.message), `없는 기록 → 404 NO_VERSION 「${nvH.data.message}」`);

  // ───────── 16. 같은 문단의 여러 제안 — 등록 순서 ─────────
  section('같은 문단의 여러 제안을 한 번에 적용: 등록 순서(앞 바꿈이 뒤 제안의 n번째 등장을 밀어도 원래 대상 유지)');
  const dI = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '같은 문단.hwpx');
  const DI = `/api/docs/${dI.id}`;
  const qI = await A(`${DI}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '일정 고치기', target: { ref: 's0/p4' }, route: 'queue' } });
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dI.id, request_id: qI.request.rid }, AG);
  // 뒤쪽 제안(12월의 '월' = 둘째 등장)을 먼저 만들어 pid 가 작고, 앞쪽 제안('3월부터' → '봄부터' — 앞의 '월' 하나를 없앰)이 pid 가 크다
  const [iA, iB] = (await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dI.id, request_id: qI.request.rid, proposals: [{ ref: 's0/p4', find: '월', occurrence: 2, replace: '월 말' }, { ref: 's0/p4', find: '3월부터', replace: '봄부터' }] }, AG)).map((x) => x.proposal);
  const rI = await ADM(`${DI}/requests/${qI.request.rid}/resolve`, { method: 'POST', body: { apply: [iB.pid, iA.pid] } });
  const tI = (await working(A, dI.id)).doc.text('s0/p4');
  ok(rI.counts.applied === 2 && rI.counts.failed === 0 && tI === '다섯째 문단: 추진 일정은 봄부터 12월 말까지입니다.', `두 제안 모두 제자리에: 「${tI}」 (${rI.results.map((x) => `#${x.pid} ${x.ok ? 'ok' : x.code}`).join(' · ')})`);

  // ───────── 17. 옛 자료 한 번 정리 — 다시 셀 일이 없는 옛 요청도 다음 기준 저장 때 ─────────
  section('옛 자료 한 번 정리: 이미 다 정한 옛 요청(다시 셀 일 없음)의 제안 메모도 그 문서의 다음 기준 문서 저장(아무 메모 달기) 때 거둠');
  const dJ = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '한 번 정리.hwpx');
  const DJ = `/api/docs/${dJ.id}`;
  const qJ = await A(`${DJ}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '옛 요청', target: { ref: 's0/p3' }, route: 'queue' } });
  const j1 = await B(`${DJ}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터' } });
  const j2 = await B(`${DJ}/proposals`, { method: 'POST', body: { ref: 's0/p5', find: '1억 원', replace: '2억 원' } });
  await A(`${DJ}/proposals/${j2.pid}/reject`, { method: 'POST' });
  const metaJ = path.join(srv.dataDir, 'docs', dJ.id, 'meta.json');
  const mJ = JSON.parse(fs.readFileSync(metaJ, 'utf-8'));
  for (const p of mJ.proposals) if ([j1.pid, j2.pid].includes(p.pid)) p.rid = qJ.request.rid;   // v0.3.0 모양: 요청 제안에 제안 메모
  const rJ = mJ.requests.find((r) => r.rid === qJ.request.rid);
  rJ.proposals.push(j1.pid, j2.pid); rJ.status = 'done'; rJ.doneAt = new Date().toISOString();
  delete rJ.resolvedAt; delete rJ.resolvedBy; delete mJ.legacyProposalMemos;
  fs.writeFileSync(metaJ, JSON.stringify(mJ, null, 1));
  const memJ0 = await A(`${DJ}/memos`);
  ok(memJ0.some((m) => m.id === j1.memoId) && memJ0.some((m) => m.id === j2.memoId), '(전제) 옛 요청 제안 메모 2개(요청은 다시 셀 일이 없음)');
  const vJ = (await A(DJ)).version; const msJ = (await A(`${DJ}/history`)).milestones.length;
  await B(`${DJ}/memos`, { method: 'POST', body: { ref: 's0/p7', text: '맺음말 확인' } });   // 그 요청과 상관없는 메모 달기 = 다음 기준 저장
  const memJ1 = await A(`${DJ}/memos`);
  const rJv = await A(`${DJ}/requests/${qJ.request.rid}`);
  const tJ = memJ1.find((m) => m.link?.type === 'request' && m.link.rid === qJ.request.rid)?.text || '';
  ok(!memJ1.some((m) => m.id === j1.memoId) && !memJ1.some((m) => m.id === j2.memoId) && tJ.split('\n').includes('결과: 남은 제안 1건') && (await A(DJ)).version === vJ + 1 && (await A(`${DJ}/history`)).milestones.length === msJ && !rJv.log.some((l) => l.action === 'resolve' || l.action === 'reopen'),
    `다음 기준 저장(메모 달기) 한 번에 옛 제안 메모 거둠 → 작업 기록 메모 하나(기록 하나, 버전·해결 기록 없음):\n      ${indent(tJ)}`);
  ok(JSON.parse(fs.readFileSync(metaJ, 'utf-8')).legacyProposalMemos === 'done', '한 번 본 문서는 표시(meta.legacyProposalMemos)를 남겨 다음부터 훑지 않음');

  // ───────── 진짜 설정·자료 ─────────
  section('진짜 config.json·data/ 그대로');
  ok(stamp(realCfg) === before.cfg, `config.json 시각·크기 그대로(${before.cfg})`);
  ok(dataListing() === before.data, 'data/docs 목록·meta.json 시각 그대로');
  console.log(`\nAPI RESOLVE OK — ${passed}개 확인`);
} catch (e) {
  console.error('\nAPI RESOLVE FAILED:', e.stack || e.message);
  for (const s of servers) if (s.output) console.error(`--- 서버 ${s.base} 출력(끝) ---\n${s.output().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  for (const w of sockets) { try { w.close(); } catch { /* ignore */ } }
  for (const s of servers) await s.stop().catch(() => {});
}
