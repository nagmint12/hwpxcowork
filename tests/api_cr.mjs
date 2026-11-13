// 수정본·변경 요청(CR)·메모 스레드·한글로 저장(검토 메모) 시험 — docs/V3_SPEC.md §3·§4.4·§6.
// 서버는 시험 받침(tests/helpers/server.mjs)으로 빈 포트·임시 data·임시 config·서버 AI 끔으로 띄운다.
// 수정본(편집기 내보내기 자리)은 시험 안에서 엔진으로 만든다:
//   /file?kind=working → HwpxDoc.load → 복제본에 글 고치기(mergeParagraphText·mergeBodyTexts·insertParagraphAfter·removeBodyParagraph)
//   → flattened() → save → PUT /drafts/mine?base=<X-Doc-Version>
// 2단계(서버 마무리): 요청·제안 메모의 스레드 블록(렌더러가 다시 써도 남음), MCP 변경 요청 도구(목록·자세히·의견·검토 — 승인 거절),
//   add_memo reply_to, 문서 목록 crs 수, REST 요청 보기의 세션 id 숨김, 서버 안내 길이(≤ 1456), XML 금지 제어 문자(v0.2 쓰기 경로·엔진 바탕).
// 2단계 검토 고침: get_change_request 쪽 나눔(from·limit·max_chars), 에이전트 검토는 사람 승인을 거두지 못함(승인 = 사람 검토),
//   제어 문자뿐인 바꿀 글은 지우기 제안이 아니라 EMPTY(POST·PATCH·여러 안·예전 제안 적용).
// 3단계(서버 마무리): 의견 스레드가 덩어리 자리를 따라감(같은 문단 거듭 저장·문단 끼우기·메모로 기준 바뀜·다시 맞추기 ref 밀림 → 한글로 저장·
//   MCP get_change_request 가 제 덩어리에, 되돌린 문단은 hid 없는 문단 의견, 옛 자료의 남은 hid 정리), 수정본 판(rev — 409 DRAFT_STALE),
//   제안 '기준에 바로 적용' 권한(allowDirectApply 기본 false, v0.2 설정 파일은 예전처럼).
// 3단계 검토 고침: 편집본 올리기(PUT /upload)·편집자의 에이전트 apply_proposal 도 같은 문, 승인은 승인한 내용에만(staleApprovals),
//   반영으로 적용된 제안의 changeIds 는 제안 자리만(복구해도 작성자 다른 고침은 남음), 사람별 반영 기록(adoptedBy),
//   문서 읽기는 문서 큐 안(반영 중에도 커밋된 상태만), MCP 스레드 curRef·문단 의견 context, 긴 문단 글자 차이 상한.
// 마무리(실사용 점검): 수정 중(draft) 변경 요청 승인 → 409 NOT_OPEN(의견·수정 요청·의견 스레드는 됨 · 판단 이름은 approve·changes·comment 뿐 —
//   'constructor'·'__proto__' 같은 원형 키는 400 BAD_VERDICT), 빈 대상 AI 요청(검토·문장 제안·다듬기)
//   → 400 EMPTY_TARGET, package.json 판 0.3.0(/api/config·서버 시작 줄), config.example.json 의 changeRequests·agents 구역.
// 진짜 config.json·data/ 는 쓰지 않는다 — 끝에 config.json 의 시각·크기와 data/docs 목록이 그대로인지 확인한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { startServer, uploadDoc, watchWs, fixture, root } from './helpers/server.mjs';
import { HwpxDoc } from '../engine/doc.js';
import { charOps, merge3, planBody } from '../engine/diff.js';
import { escapeText } from '../engine/xmlscan.js';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { serverInstructions, MAX_SERVER_INSTRUCTIONS } from '../server/mcp.js';
import { instructionsBudget } from '../server/bridge.js';

// 엄격한 XML 해석기(saxes — exceljs 가 쓰는 것, node_modules 에 있음). 없으면 금지 글자 검사만 한다(알림 한 줄)
let SaxesParser = null;
try { ({ SaxesParser } = await import('saxes')); } catch { console.log('  - saxes 를 찾지 못해 XML 은 금지 글자 검사만 합니다'); }

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
// v0.4: 기본 편집 방식은 실시간(V4 §1) — 이 시험은 v0.3 의 승인 방식 흐름(NEED_APPROVAL·'기준에 바로 적용' 403·변경 추적 반영·자세한 작업 기록 메모)을
// 보므로 임시 config 의 문서 기본값을 승인 방식·자세한 메모로 둔다(실시간 문서·실시간 문서의 변경 요청 반영은 tests/api_live.mjs)
const V3_DOCS = { documents: { defaultEditMode: 'review', defaultAiMemo: 'detail' } };

/** 시험 문서: 도구 메모 문서를 평탄화하고 문단 5개를 더한 깨끗한 문서(변경 추적 없음, 메모 1 — s0/p0) */
async function buildMainDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const extra = ['넷째 문단: 사업 개요를 적습니다.', '다섯째 문단: 추진 일정은 3월부터 12월까지입니다.', '여섯째 문단: 예산은 총 1억 원입니다.', '일곱째 문단: 기대 효과를 정리합니다.', '여덟째 문단: 맺음말입니다.'];
  extra.forEach((t, i) => d.insertParagraphAfter(0, 2 + i, t, PREP));
  d.acceptAll();
  return Buffer.from(await d.save());
}

/** 표 문서: [글(메모), 글, 표 3×2(칸 s0/p2/n0..n5), 글] */
async function buildTableDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  d.insertTableAfter(0, 1, { rows: [['구분', '값'], ['가', '1'], ['나', '2']] }, PREP);
  d.acceptAll();
  return Buffer.from(await d.save());
}

/**
 * 빈 대상 문서(EMPTY_TARGET): [글(메모), 글, 표 3×2(제 글 없음 — 칸 s0/p2/n0..n5, 값 칸 s0/p2/n3 비움), 글, 빈 문단 s0/p4,
 * 제어 문자와 공백뿐인 문단 s0/p5('\u0001\u0007 ' — XML 금지 글자를 빼면 빈 글)]
 */
async function buildBlankDoc() {
  const d = await HwpxDoc.load(await buildTableDoc());
  d.insertParagraphAfter(0, 3, '', PREP);
  d.insertParagraphAfter(0, 4, '제어 문자 자리표', PREP);
  d.mergeParagraphText('s0/p2/n3', '', PREP);
  d.acceptAll();
  const sec = d.sections[0];
  sec.load(sec.xml.replace('제어 문자 자리표', '&#x1;&#x7; '));   // 엔진을 거치지 않고 XML 에 바로(문자 참조)
  return Buffer.from(await d.save());
}

/**
 * 글이 표 앞에 있는 문단: [글(메모), 글, '표 머리 글' + 표 3×2(칸 s0/p2/n0..n5), 글] — 한글 문서에 흔한 모양.
 * 이 문단 자기 글에 메모를 달면 메모 본문 줄이 이 문단의 중첩 문단이 되어 칸 번호(n)가 밀린다.
 * (엔진 mergeParagraphText 는 글을 표 뒤에 넣으므로 표 run 앞에 글 run 을 XML 로 직접 넣는다)
 */
async function buildTextTableDoc() {
  const d = await HwpxDoc.load(await buildTableDoc());
  const sec = d.sections[0]; const p = sec.bodyParas[2];
  const open = sec.xml.indexOf('>', p.start) + 1;   // <hp:p …> 바로 뒤 = 표 run 앞
  sec.load(`${sec.xml.slice(0, open)}<hp:run charPrIDRef="0"><hp:t>표 머리 글</hp:t></hp:run>${sec.xml.slice(open)}`);
  return Buffer.from(await d.save());
}

/**
 * 잇닿은 칸 문단들(refs — 같은 칸의 차례대로 문단)을 글 목록 parts 의 문단들로 바꾼다 — 편집기에서 칸 안 Enter(나눔)·Backspace(합침)한 모양
 * (첫 문단의 문단·글자 모양을 빌림; 엔진에는 칸 문단 나누기가 없어 구역 XML 을 고친다 — engine6·api_live 시험과 같음)
 */
function setCellParas(d, refs, parts) {
  const first = d.resolve(refs[0]); const last = d.resolve(refs[refs.length - 1]);
  const { sec } = first; const xml = sec.xml.slice(first.p.start, first.p.end);
  const open = /^<hp:p\b[^>]*>/.exec(xml)[0];
  const charPr = /<hp:run\b[^>]*?charPrIDRef="([^"]*)"/.exec(xml)?.[1] ?? '0';
  const paras = parts.map((t) => `${open}<hp:run charPrIDRef="${charPr}">${t ? `<hp:t>${escapeText(t)}</hp:t>` : ''}</hp:run></hp:p>`).join('');
  sec.load(sec.xml.slice(0, first.p.start) + paras + sec.xml.slice(last.p.end));
}
/** 칸 문단이 여럿인 표 문서: buildTableDoc 의 값 칸 (1,1)을 문단 둘로 — 칸 s0/p2/n0 구분 · n1 값 · n2 가 · n3·n4 (1,1) · n5 나 · n6 2 */
const MULTI_CELL = ['첫째 줄 내용', '둘째 줄 내용'];
async function buildMultiCellDoc() {
  const d = await HwpxDoc.load(await buildTableDoc());
  setCellParas(d, ['s0/p2/n3'], MULTI_CELL);
  return Buffer.from(await d.save());
}

/**
 * 쪽 나눔 시험 문서: 도구 메모 문서(문단 3) 뒤에 'k번 긴 문단: …' n 개(약 len 자) + 아주 긴 문단 1개(huge 자) — 본문 s0/p3 … s0/p(3+n)
 */
async function buildLongDoc(n, len = 260, huge = 9000) {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const fill = (k, size) => `${k}번 긴 문단: ${'사업 추진 내용을 자세히 적은 문장입니다. '.repeat(Math.ceil(size / 24))}`.slice(0, size);
  for (let i = 0; i < n; i++) d.insertParagraphAfter(0, 2 + i, fill(i + 1, len), PREP);
  d.insertParagraphAfter(0, 2 + n, fill(n + 1, huge), PREP);
  d.acceptAll();
  return Buffer.from(await d.save());
}

/** HWPX 의 Contents/*.xml 에 든 XML 1.0 금지 글자(C0 제어 문자 — 탭·줄바꿈·CR 제외, U+FFFE·U+FFFF) → ['파일:U+xxxx', …] */
async function badXmlChars(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => /^Contents\/.+\.xml$/.test(n)).sort()) {
    const xml = await zip.file(name).async('string');
    for (const ch of xml.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u{FFFE}\u{FFFF}]/gu) || []) out.push(`${name}:U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
  }
  return out;
}

/** HWPX 의 Contents/*.xml 을 엄격한 XML 해석기로 읽어 본 오류 → ['파일: 오류', …](해석기가 없으면 []) */
async function xmlErrors(bytes) {
  if (!SaxesParser) return [];
  const zip = await JSZip.loadAsync(bytes);
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => /^Contents\/.+\.xml$/.test(n)).sort()) {
    const p = new SaxesParser({ xmlns: false });
    p.on('error', (e) => { out.push(`${name}: ${e.message}`); });
    try { p.write(await zip.file(name).async('string')).close(); } catch (e) { out.push(`${name}: ${e.message}`); }
  }
  return out;
}

/** MCP JSON-RPC 한 번(무상태 — initialize 없이도 됨) → { status, msg, raw }. agent = ?agent= 이름, session = X-Hwpx-Agent-Session */
async function rpc(base, token, body, { agent = 'Claude', session } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  if (session) h['X-Hwpx-Agent-Session'] = session;
  const r = await fetch(`${base}/mcp?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const raw = await r.text();
  let msg = null;
  try { const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:')); msg = JSON.parse(line ? line.slice(5) : raw); } catch { /* JSON 아님 */ }
  return { status: r.status, msg, raw };
}
/** MCP 도구 호출 → { isError, text, json }(오류도 던지지 않는다 — 오류 코드 확인용) */
async function mcp(base, token, name, args = {}, opts = {}) {
  const r = await rpc(base, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts);
  if (r.status !== 200 || !r.msg) return { status: r.status, isError: true, text: r.raw, json: null };
  if (r.msg.error) return { status: r.status, isError: true, text: r.msg.error.message, json: null };
  const text = r.msg.result?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { status: r.status, isError: !!r.msg.result?.isError, text, json };
}

async function working(C, id) {
  const r = await C.res(`/api/docs/${id}/file?kind=working`);
  if (r.status !== 200) throw new Error(`working 사본 ${r.status}`);
  return { doc: await HwpxDoc.load(r.data), version: Number(r.headers.get('x-doc-version')) };
}
/** 지금 기준 최종본(편집기가 여는 사본)을 edit 으로 고친 수정본 바이트 + 기준 버전 */
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
const putDraft = (C, id, head, base = head.version) => C(`/api/docs/${id}/drafts/mine?base=${base}`, { method: 'PUT', body: head.bytes });
const docOf = async (C, id, kind = 'tracked') => HwpxDoc.load((await C.res(`/api/docs/${id}/file?kind=${kind}`)).data);
const versionOf = async (C, id) => (await C(`/api/docs/${id}`)).version;
const strip = (h) => ({ type: h.type, ref: h.ref, afterRef: h.afterRef ?? undefined, baseText: h.baseText, newText: h.newText, cell: h.cell ?? null });
const memoSig = (m) => ({ id: m.id, author: m.author, ref: m.ref, start: m.start, end: m.end, text: m.text, created: m.created });

/**
 * 개인 에이전트 SSE(GET /api/agent/events, 에이전트 묶음이 만든 경로)를 듣는다 → { status, events, waitFor, close }.
 * 경로가 없으면(status ≠ 200) events 는 비어 있다.
 */
async function listenAgent(base, token, query) {
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/agent/events?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const events = []; const waiters = new Set();
  if (r.status === 200) {
    (async () => {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (ev) { let d = null; try { d = data ? JSON.parse(data) : null; } catch { d = data; } events.push({ event: ev, data: d }); for (const w of [...waiters]) w(); }
          }
        }
      } catch { /* 끊음 */ }
    })();
  } else { try { await r.body?.cancel(); } catch { /* ignore */ } }
  const waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const check = () => { const hit = events.find(pred); if (!hit) return false; clearTimeout(t); waiters.delete(check); resolve(hit); return true; };
    const t = setTimeout(() => { waiters.delete(check); reject(new Error('SSE 이벤트를 기다리다 시간 초과')); }, ms);
    if (!check()) waiters.add(check);
  });
  return { status: r.status, events, waitFor, close: () => ctrl.abort() };
}

const servers = [];
let ws = null;
let agentA = null;
try {
  const srv = await startServer({ ai: 'off', config: V3_DOCS }); servers.push(srv);
  const A = srv.api('a'); const B = srv.api('b'); const ADM = srv.api('admin');
  const nameA = srv.users.a.name; const nameB = srv.users.b.name; const nameAdm = srv.users.admin.name;

  // ───────── 1. 수정본 저장 → 덩어리 ─────────
  section('수정본 저장 → 덩어리(바꿈·문단 추가·문단 지움), 버전 안 만듦');
  const d1 = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '협업 시험.hwpx');
  const id = d1.id;
  ws = watchWs(srv.base, srv.tokens.b, id); await ws.ready;
  const v1 = await versionOf(A, id);
  const histBefore = (await A(`/api/docs/${id}/history`)).versions.length;
  const headA = await makeHead(A, id, (d) => {
    replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을');
    d.insertParagraphAfter(0, 4, '새로 넣은 문단입니다.', ED);   // 기준 s0/p4 뒤
    d.removeBodyParagraph(0, 7);                                  // 기준 s0/p6('일곱째 …') — 넣은 문단 때문에 지금은 p7
  });
  ok(headA.version === v1, `working 사본 X-Doc-Version = v${v1}`);
  const put1 = await putDraft(A, id, headA);
  const cr1 = put1.cr;
  ok(put1.unchanged === false && cr1 && cr1.cid === 1 && cr1.status === 'draft' && cr1.author === nameA && cr1.baseVersion === v1, `PUT → 변경 요청 #1(draft, ${cr1.author}, 기준 v${cr1.baseVersion})`);
  ok(eq(cr1.hunks.map(strip), [
    { type: 'replace', ref: 's0/p3', baseText: '넷째 문단: 사업 개요를 적습니다.', newText: '넷째 문단: 사업 개요와 배경을 적습니다.', cell: null },
    { type: 'insert', ref: 's0/p4', afterRef: 's0/p4', baseText: '', newText: '새로 넣은 문단입니다.', cell: null },
    { type: 'delete', ref: 's0/p6', baseText: '일곱째 문단: 기대 효과를 정리합니다.', newText: '', cell: null },
  ].map(strip)), `덩어리 3개: ${cr1.hunks.map((h) => `${h.type} ${h.ref}`).join(', ')}`);
  ok(cr1.hunks.every((h) => /^h[0-9a-z]{10}$/.test(h.hid)) && cr1.hunks.every((h) => h.state === 'ok' && h.curRef === (h.afterRef ?? h.ref)), '덩어리마다 hid, curRef = 기준 ref, state ok');
  ok(eq(cr1.stats, { changed: 1, inserted: 1, deleted: 1, cells: 0, chars: cr1.stats.chars }) && cr1.stats.chars > 0, `stats ${JSON.stringify(cr1.stats)}`);
  ok(cr1.hunkCount === 3 && cr1.behind === 0 && cr1.canMerge === false && cr1.mergeBlockers.some((b) => b.code === 'NOT_SUBMITTED'), 'CRView: hunkCount 3, behind 0, 막힘 NOT_SUBMITTED');
  ok(await versionOf(A, id) === v1 && (await A(`/api/docs/${id}/history`)).versions.length === histBefore, '수정본 저장은 버전을 만들지 않음');
  const wsDraft = await ws.waitFor((m) => m.type === 'cr' && m.action === 'draft' && m.cid === 1);
  ok(wsDraft.author === nameA && eq(wsDraft.refs, ['s0/p3', 's0/p4', 's0/p6']) && wsDraft.rev === put1.rev && put1.rev === 1, `WS cr draft(author ${wsDraft.author}, refs ${wsDraft.refs}, 판 ${wsDraft.rev})`);
  const mineA = await A(`/api/docs/${id}/drafts/mine`);
  ok(mineA.cr?.cid === 1 && mineA.file?.baseVersion === v1 && mineA.file.size === headA.bytes.length && !Number.isNaN(Date.parse(mineA.file.updatedAt)), 'GET /drafts/mine → cr + file{ baseVersion, size, updatedAt }');
  const fileA = await A.res(`/api/docs/${id}/drafts/mine/file`);
  ok(fileA.status === 200 && Buffer.compare(fileA.data, headA.bytes) === 0 && fileA.headers.get('x-base-version') === String(v1) && fileA.headers.get('x-cr') === '1', 'GET /drafts/mine/file → 올린 바이트 그대로 + X-Base-Version·X-CR');
  ok(eq(await B(`/api/docs/${id}/drafts/mine`), { cr: null, file: null, rev: 0 }) && (await B.res(`/api/docs/${id}/drafts/mine/file`)).status === 404, '남(김검토)의 /drafts/mine 은 자기 것 — 없음(cr null, 파일 404, 판 0)');
  const again = await putDraft(A, id, headA);
  ok(again.cr.cid === 1 && eq(again.cr.hunks.map((h) => h.hid), cr1.hunks.map((h) => h.hid)), '같은 수정본 다시 저장 → 같은 변경 요청·같은 hid');
  const list1 = await B(`/api/docs/${id}/change-requests`);
  ok(list1.length === 1 && list1[0].hunkCount === 3 && !('hunks' in list1[0]), '목록: hunks 없이 hunkCount 만');
  const list1h = await B(`/api/docs/${id}/change-requests?status=draft,open&hunks=1`);
  ok(list1h.length === 1 && list1h[0].hunks.length === 3 && list1h[0].hunks.every((h) => h.curRef && h.state === 'ok'), '목록 ?status=draft,open&hunks=1 → 덩어리 전부(curRef·state)');
  ok((await B(`/api/docs/${id}/change-requests?status=merged`)).length === 0, '?status=merged → 없음');
  // 잘못된 입력
  const r400 = await Promise.all([
    A.res(`/api/docs/${id}/drafts/mine?base=${v1}`, { method: 'PUT', body: Buffer.alloc(0) }),
    A.res(`/api/docs/${id}/drafts/mine?base=${v1}`, { method: 'PUT', body: Buffer.from('not a zip') }),
    A.res(`/api/docs/${id}/drafts/mine?base=abc`, { method: 'PUT', body: headA.bytes }),
    A.res(`/api/docs/${id}/drafts/mine?base=999`, { method: 'PUT', body: headA.bytes }),
  ]);
  ok(eq(r400.map((r) => `${r.status}:${r.data.error}`), ['400:EMPTY', '400:BAD_FILE', '400:BAD_BASE', '400:BAD_BASE']), `빈 본문·HWPX 아님·base=abc·base=999 → ${r400.map((r) => r.data.error).join(', ')}`);
  ok((await srv.api(null).res(`/api/docs/${id}/drafts/mine`)).status === 401 && (await A.res('/api/docs/nope/drafts/mine')).status === 404, '토큰 없음 401, 없는 문서 404');

  // 김검토의 수정본(지금 기준): 여덟째 문단 — 홍길동 반영 뒤 curRef 가 밀리는지 본다
  const headB = await makeHead(B, id, (d) => replaceIn(d, 's0/p7', '맺음말', '끝맺음말'));
  const putB = await putDraft(B, id, headB);
  ok(putB.cr.cid === 2 && putB.cr.author === nameB && eq(putB.cr.hunks.map((h) => [h.type, h.ref]), [['replace', 's0/p7']]), '김검토 수정본 → 변경 요청 #2(replace s0/p7)');

  // ───────── 2. 상태·권한·검토·스레드 ─────────
  section('상태 흐름·권한·검토·의견 스레드·승인 규칙');
  const R = (C, p, opts) => C.res(`/api/docs/${id}/change-requests${p}`, opts);
  // 작성자(홍길동)의 개인 에이전트 채널 — 남이 검토·의견·반영·닫기를 하면 cr_event(§2.1)
  agentA = await listenAgent(srv.base, srv.tokens.a, 'channel=1&session=crtestA&agent=Claude');
  if (agentA.status === 200) await agentA.waitFor((e) => e.event === 'hello');
  ok((await R(B, '/1', { method: 'PATCH', body: { title: '남이 고침' } })).status === 403, '남이 제목 고치기 → 403');
  ok((await R(B, '/1/submit', { method: 'POST', body: { title: 'x' } })).status === 403, '남이 검토 요청 → 403');
  const mDraft = await R(A, '/1/merge', { method: 'POST' });
  ok(mDraft.status === 409 && mDraft.data.error === 'STATE', 'draft 반영 → 409 STATE');
  const sub = await A(`/api/docs/${id}/change-requests/1/submit`, { method: 'POST', body: { title: '사업 개요 보강', description: '배경을 더합니다' } });
  ok(sub.status === 'open' && sub.title === '사업 개요 보강' && sub.description === '배경을 더합니다' && sub.submittedAt, `검토 요청 → open(「${sub.title}」)`);
  ok((await ws.waitFor((m) => m.type === 'cr' && m.action === 'open' && m.cid === 1)).by === nameA, 'WS cr open');
  const selfOk = await R(A, '/1/reviews', { method: 'POST', body: { verdict: 'approve' } });
  ok(selfOk.status === 403 && selfOk.data.error === 'SELF_APPROVE', '작성자 자기 승인 → 403 SELF_APPROVE');
  const noAppr = await R(A, '/1/merge', { method: 'POST' });
  ok(noAppr.status === 403 && noAppr.data.error === 'NEED_APPROVAL' && noAppr.data.required === 1, '승인 없이 작성자 반영 → 403 NEED_APPROVAL(필요 1)');
  ok((await R(B, '/1/reviews', { method: 'POST', body: { verdict: 'bogus' } })).data.error === 'BAD_VERDICT', '검토 결과 bogus → BAD_VERDICT');
  ok((await R(B, '/1/reviews', { method: 'POST', body: { verdict: 'comment' } })).data.error === 'EMPTY', '의견만(comment)인데 글 없음 → EMPTY');
  let cv = await B(`/api/docs/${id}/change-requests/1/reviews`, { method: 'POST', body: { verdict: 'changes', body: '근거를 더 적어 주세요' } });
  ok(cv.changesRequested === 1 && cv.approvals === 0, '김검토 수정 요청 → changesRequested 1');
  ok((await ws.waitFor((m) => m.type === 'cr' && m.action === 'review' && m.cid === 1)).verdict === 'changes', 'WS cr review(verdict changes)');
  if (agentA.status === 200) {
    const ce = await agentA.waitFor((e) => e.event === 'cr_event' && e.data?.action === 'review');
    ok(eq({ ...ce.data }, { docId: id, docTitle: '협업 시험', cid: 1, action: 'review', by: nameB }), `작성자 에이전트에 cr_event(review, by ${ce.data.by})`);
  } else console.log(`  - 에이전트 SSE 경로 없음(${agentA.status}) — cr_event 확인 건너뜀`);
  const repHid = cr1.hunks[0].hid;
  cv = await B(`/api/docs/${id}/change-requests/1/threads`, { method: 'POST', body: { hid: repHid, quote: '사업 개요와 배경을', text: '배경 근거는?' } });
  const th = cv.threads[0];
  ok(th && th.tid === 1 && th.hid === repHid && th.ref === 's0/p3' && th.quote === '사업 개요와 배경을' && th.comments[0].by === nameB, '의견 스레드 #1(덩어리·문단·인용)');
  ok((await R(B, '/1/threads', { method: 'POST', body: { hid: 'hnope', text: 'x' } })).data.error === 'NO_HUNK', '없는 덩어리에 의견 → NO_HUNK');
  cv = await A(`/api/docs/${id}/change-requests/1/threads/1/replies`, { method: 'POST', body: { text: '통계 자료를 붙였습니다' } });
  ok(cv.threads[0].comments.length === 2 && cv.threads[0].comments[1].by === nameA, '작성자 답글');
  ok((await R(A, '/1/threads/9/replies', { method: 'POST', body: { text: 'x' } })).status === 404, '없는 스레드 답글 → 404');
  cv = await B(`/api/docs/${id}/change-requests/1/threads/1/resolve`, { method: 'POST', body: { resolved: true } });
  ok(cv.threads[0].resolved?.by === nameB, '스레드 해결');
  cv = await B(`/api/docs/${id}/change-requests/1/threads/1/resolve`, { method: 'POST', body: { resolved: false } });
  ok(cv.threads[0].resolved === null, '스레드 다시 열기');
  await B(`/api/docs/${id}/change-requests/1/threads/1/resolve`, { method: 'POST', body: { resolved: true } });
  ok((await ws.waitFor((m) => m.type === 'cr' && m.action === 'thread' && m.cid === 1 && m.tid === 1)).author === nameA, 'WS cr thread');
  if (agentA.status === 200) {
    ok((await agentA.waitFor((e) => e.event === 'cr_event' && e.data?.action === 'thread')).data.by === nameB, '작성자 에이전트에 cr_event(thread)');
    ok(!agentA.events.some((e) => e.event === 'cr_event' && e.data?.by === nameA), '작성자 자신이 한 일(답글)은 알리지 않음');
  }
  agentA.close();
  cv = await B(`/api/docs/${id}/change-requests/1/reviews`, { method: 'POST', body: { verdict: 'approve', body: '좋습니다' } });
  ok(cv.approvals === 1 && cv.changesRequested === 0 && eq(cv.approvers, [nameB]), '김검토 승인 → approvals 1(마지막 판단이 승인), changesRequested 0');
  ok(cv.canMerge === false && cv.mergeBlockers.some((b) => b.code === 'FORBIDDEN'), '김검토가 보는 CRView: canMerge false(FORBIDDEN)');
  const viewA = await A(`/api/docs/${id}/change-requests/1`);
  ok(viewA.canMerge === true && viewA.mergeBlockers.length === 0 && viewA.hunks.length === 3, '홍길동이 보는 CRView: canMerge true');
  ok((await R(B, '/1/close', { method: 'POST' })).status === 403 && (await R(B, '/1/merge', { method: 'POST' })).status === 403, '남이 닫기·반영 → 403');
  ok((await R(A, '/99')).status === 404, '없는 변경 요청 → 404');

  // ───────── 3. 반영 ─────────
  section('반영(merge) — 변경 추적 작성자 = 변경 요청 작성자, 버전 하나, 기록 메모, 수정본 파일 지움');
  const memosBefore = (await A(`/api/docs/${id}/memos`)).length;
  const m1 = await A(`/api/docs/${id}/change-requests/1/merge`, { method: 'POST' });
  ok(m1.version === v1 + 1 && m1.cr.status === 'merged' && m1.cr.mergedBy === nameA && m1.cr.mergedVersion === v1 + 1, `반영 → v${m1.version}, merged(${m1.cr.mergedBy})`);
  ok(eq([m1.report.changed, m1.report.inserted, m1.report.deleted, m1.report.cells], [['s0/p3'], ['s0/p5'], ['s0/p7'], []]), `report: 바꿈 ${m1.report.changed} · 추가 ${m1.report.inserted} · 지움 ${m1.report.deleted}`);
  const after1 = await docOf(A, id);
  ok(after1.text('s0/p3') === '넷째 문단: 사업 개요와 배경을 적습니다.' && after1.text('s0/p5') === '새로 넣은 문단입니다.' && after1.text('s0/p7') === '여덟째 문단: 맺음말입니다.' && after1.paragraphs({ nested: false }).length === 8, '기준 문서 최종본: 바꿈·새 문단(p5)·지운 문단(2026-10-30 문단 나눔 변경 추적 — 최종본에서 없어지고 앞 문단 p6 과 한 문단, 빈 줄 없음)');
  ok(after1.text('s0/p3', 'markup').includes('{+') && after1.text('s0/p6', 'markup').endsWith('[-¶-][-일곱째 문단: 기대 효과를 정리합니다.-]'), '변경 추적으로 들어감(markup — 지운 문단은 앞 문단 끝 나눔 지움 + 그 글 지움)');
  const ch1 = await A(`/api/docs/${id}/changes`);
  ok(ch1.length > 0 && ch1.every((c) => c.author === nameA), `변경 추적 ${ch1.length}건 — 모두 작성자 ${nameA}`);
  const recMemo = after1.memos().find((m) => m.text.startsWith('[변경 요청 #1 반영]'));
  ok(recMemo && recMemo.ref === 's0/p3' && recMemo.text === `[변경 요청 #1 반영] ${nameA} — 사업 개요 보강 · 1문단 수정 · 1문단 추가 · 1문단 삭제 · 승인 ${nameB}`, `기록 메모(s0/p3): ${recMemo?.text}`);
  ok((await A(`/api/docs/${id}/memos`)).length === memosBefore + 1 && m1.report.memoId === recMemo.id, '메모 1개 늘어남(report.memoId)');
  const mineAfter1 = await A(`/api/docs/${id}/drafts/mine`);
  ok(mineAfter1.cr === null && mineAfter1.file === null && mineAfter1.rev > mineA.rev && (await A.res(`/api/docs/${id}/drafts/mine/file`)).status === 404, `반영 뒤 내 수정본 없음(파일 지움, 판 ${mineA.rev} → ${mineAfter1.rev})`);
  ok((await A(`/api/docs/${id}/history`)).versions.length === histBefore + 1, '버전 하나만 늘어남');
  const wsMerged = await ws.waitFor((m) => m.type === 'cr' && m.action === 'merged' && m.cid === 1);
  ok(wsMerged.version === m1.version && eq(wsMerged.refs, ['s0/p3', 's0/p5', 's0/p7']), `WS cr merged(v${wsMerged.version}, refs ${wsMerged.refs})`);
  ok(!!(await ws.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.version === m1.version)), 'WS doc changed');
  ok((await R(B, '/1/reviews', { method: 'POST', body: { verdict: 'approve' } })).status === 409, '반영된 변경 요청 검토 → 409');
  const cr2v = await B(`/api/docs/${id}/change-requests/2`);
  ok(cr2v.behind === 1 && cr2v.hunks[0].ref === 's0/p7' && cr2v.hunks[0].curRef === 's0/p7' && cr2v.hunks[0].state === 'ok', '김검토 #2: 기준 s0/p7 → 지금 curRef s0/p7(앞에 문단이 들어가고 하나는 지운 문단으로 앞 문단과 합쳐짐), state ok, behind 1');
  const listH = await A(`/api/docs/${id}/change-requests?status=draft,open&hunks=1`);
  ok(listH.length === 1 && listH[0].cid === 2 && listH[0].hunks[0].curRef === 's0/p7', '목록 hunks=1 도 curRef 를 옮김(남의 수정 중 표시용)');

  // ───────── 4. 충돌 → 409 → 다시 맞추기 → 반영 ─────────
  section('같은 문단 충돌: 남이 먼저 반영 → 409 MERGE_CONFLICT → rebase → (처리 안 된 변경 추적) → 반영');
  const v2 = await versionOf(A, id);
  const headA3 = await makeHead(A, id, (d) => replaceIn(d, 's0/p1', '있던 낱말을', '기존 낱말을'));
  const cr3 = (await putDraft(A, id, headA3)).cr;
  ok(cr3.cid === 3 && cr3.baseVersion === v2, `홍길동 새 변경 요청 #3(반영된 #1 다음, 기준 v${v2})`);
  const headB2 = await makeHead(B, id, (d) => { replaceIn(d, 's0/p7', '맺음말', '끝맺음말'); replaceIn(d, 's0/p1', '있던 낱말을', '예전 낱말을'); });
  const cr2b = (await putDraft(B, id, headB2)).cr;
  ok(cr2b.cid === 2 && cr2b.baseVersion === v2 && eq(cr2b.hunks.map((h) => h.ref), ['s0/p1', 's0/p7']), '김검토 #2 를 지금 기준으로 다시 저장(p1·p7)');
  await B(`/api/docs/${id}/change-requests/2/submit`, { method: 'POST', body: { title: '맺음말·낱말' } });
  await A(`/api/docs/${id}/change-requests/2/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const m2 = await B(`/api/docs/${id}/change-requests/2/merge`, { method: 'POST' });
  ok(m2.version === v2 + 1 && eq(m2.report.changed, ['s0/p1', 's0/p7']), `김검토 #2 반영 → v${m2.version}`);
  await A(`/api/docs/${id}/change-requests/3/submit`, { method: 'POST', body: { title: '낱말 고침' } });
  await B(`/api/docs/${id}/change-requests/3/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const cv3 = await A(`/api/docs/${id}/change-requests/3`);
  ok(cv3.hunks[0].state === 'conflict' && cv3.hunks[0].conflict?.reason === 'TEXT' && cv3.canMerge === false && cv3.mergeBlockers.some((b) => b.code === 'CONFLICT'), 'CRView 가 충돌을 미리 보여 줌(state conflict, conflict.reason TEXT, 막힘 CONFLICT)');
  const c409 = await A.res(`/api/docs/${id}/change-requests/3/merge`, { method: 'POST' });
  const cf = c409.data.conflicts?.[0];
  ok(c409.status === 409 && c409.data.error === 'MERGE_CONFLICT' && c409.data.conflicts.length === 1 && cf.hid === cr3.hunks[0].hid && cf.reason === 'TEXT'
    && cf.curRef === 's0/p1' && cf.currentText.includes('예전 낱말을') && cf.newText.includes('기존 낱말을'), '홍길동 #3 반영 → 409 MERGE_CONFLICT(hid·curRef·지금 글·내 글)');
  ok(await versionOf(A, id) === m2.version && (await docOf(A, id)).text('s0/p1').includes('예전 낱말을'), '충돌이면 아무것도 바꾸지 않음(버전·글 그대로)');
  const rb = await A(`/api/docs/${id}/drafts/mine/rebase`, { method: 'POST' });
  ok(rb.conflicts.length === 1 && rb.conflicts[0].reason === 'TEXT' && rb.cr.baseVersion === m2.version && rb.cr.behind === 0, `rebase → 기준 v${rb.cr.baseVersion}, 충돌 ${rb.conflicts.length}건(내 글 남김)`);
  ok(rb.cr.hunks.length === 1 && rb.cr.hunks[0].ref === 's0/p1' && rb.cr.hunks[0].baseText.includes('예전 낱말을') && rb.cr.hunks[0].newText.includes('기존 낱말을'), 'rebase 뒤 덩어리: 지금 글(예전) → 내 글(기존)');
  const rbFile = await A.res(`/api/docs/${id}/drafts/mine/file`);
  const rbDoc = await HwpxDoc.load(rbFile.data);
  ok(rbFile.headers.get('x-base-version') === String(m2.version) && rbDoc.text('s0/p1').includes('기존 낱말을') && rbDoc.text('s0/p7') === '여덟째 문단: 끝맺음말입니다.' && rbDoc.changes().length === 0, '수정본 파일 교체: 지금 기준 최종본(남의 p7 고침 포함) + 내 글, 변경 추적 없음');
  const wsRb = await ws.waitFor((m) => m.type === 'cr' && m.action === 'rebased' && m.cid === 3);
  ok(wsRb.conflicts === 1 && wsRb.rev === rb.rev && rb.rev === rb.cr.rev && rb.rev > 0, `WS cr rebased(충돌 1, 판 ${wsRb.rev} = 응답 rev = cr.rev)`);
  const stale = await A.res(`/api/docs/${id}/drafts/mine?base=${v2}`, { method: 'PUT', body: headA3.bytes });
  ok(stale.status === 409 && stale.data.error === 'STALE_BASE' && stale.data.baseVersion === m2.version && (await A(`/api/docs/${id}/drafts/mine`)).cr.baseVersion === m2.version, '다시 맞춘 뒤 옛 기준으로 저장(옛 편집기 창) → 409 STALE_BASE(수정본 그대로)');
  const pend = await A.res(`/api/docs/${id}/change-requests/3/merge`, { method: 'POST' });
  ok(pend.status === 409 && pend.data.conflicts?.[0]?.reason === 'PENDING_TRACKED', '그 문단에 김검토 변경 추적이 남아 있음 → 409 PENDING_TRACKED');
  ok((await A(`/api/docs/${id}/change-requests/3`)).mergeBlockers.some((b) => b.code === 'PENDING_TRACKED'), 'CRView 막힘 PENDING_TRACKED');
  await ADM(`/api/docs/${id}/changes/accept-all`, { method: 'POST' });
  const m3 = await A(`/api/docs/${id}/change-requests/3/merge`, { method: 'POST' });
  const after3 = await docOf(A, id);
  ok(m3.cr.status === 'merged' && after3.text('s0/p1').includes('기존 낱말을') && !after3.text('s0/p1').includes('예전 낱말을'), `변경 추적 수락 뒤 반영 → v${m3.version}, p1 = 내 글`);
  ok((await A(`/api/docs/${id}/changes`)).every((c) => c.author === nameA && c.ref === 's0/p1'), '새 변경 추적은 홍길동 것(p1)');

  // ───────── 5. 겹치지 않는 동시 수정(3-way) ─────────
  section('같은 문단의 다른 자리를 둘이 고침 → 나중 반영도 3-way 로 깔끔히 합침');
  const v5 = await versionOf(A, id);
  const cr4 = (await putDraft(A, id, await makeHead(A, id, (d) => replaceIn(d, 's0/p4', '3월부터', '4월부터')))).cr;
  const cr5 = (await putDraft(B, id, await makeHead(B, id, (d) => replaceIn(d, 's0/p4', '12월까지', '11월까지')))).cr;
  ok(cr4.cid === 4 && cr5.cid === 5 && cr4.baseVersion === v5 && cr5.baseVersion === v5, '둘 다 같은 기준에서 p4 를 고침(#4·#5)');
  await B(`/api/docs/${id}/change-requests/5/submit`, { method: 'POST', body: { title: '종료 달' } });
  await A(`/api/docs/${id}/change-requests/5/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  await B(`/api/docs/${id}/change-requests/5/merge`, { method: 'POST' });
  await A(`/api/docs/${id}/change-requests/4/submit`, { method: 'POST', body: { title: '시작 달' } });
  await B(`/api/docs/${id}/change-requests/4/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const cv4 = await A(`/api/docs/${id}/change-requests/4`);
  ok(cv4.hunks[0].state === 'conflict' && cv4.hunks[0].conflict === null && cv4.canMerge === true, '기준이 바뀌었지만(state conflict) 겹치지 않음(conflict null) → canMerge');
  const m4 = await A(`/api/docs/${id}/change-requests/4/merge`, { method: 'POST' });
  ok(m4.cr.status === 'merged' && (await docOf(A, id)).text('s0/p4') === '다섯째 문단: 추진 일정은 4월부터 11월까지입니다.', '3-way 합침: 「4월부터 11월까지」');
  const p4changes = (await A(`/api/docs/${id}/changes`)).filter((c) => c.ref === 's0/p4');
  ok(p4changes.some((c) => c.author === nameA) && p4changes.some((c) => c.author === nameB), 'p4 변경 추적: 두 사람 것이 함께');

  // ───────── 5b. 문단 넣기·지우기가 양쪽에 있는 다시 맞추기 ─────────
  section('다시 맞추기: 남이 맨 위에 문단을 넣어 번호가 밀린 뒤 — 내 문단 추가·지움·바꿈이 제자리로');
  const d4 = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '맞추기 시험.hwpx');
  const crR = (await putDraft(A, d4.id, await makeHead(A, d4.id, (d) => {
    d.insertParagraphAfter(0, 2, '홍길동이 넣은 문단', ED);   // 기준 p2(셋째) 뒤
    d.removeBodyParagraph(0, 7);                               // 기준 p6(일곱째) — 넣은 문단 때문에 p7
    replaceIn(d, 's0/p7', '맺음말', '끝말');                   // 기준 p7(여덟째) — 넣기 +1, 지우기 -1
  }))).cr;
  ok(eq(crR.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['insert', 's0/p2'], ['delete', 's0/p6'], ['replace', 's0/p7']]), '홍길동 수정본: 추가(p2 뒤)·지움(p6)·바꿈(p7)');
  const crRB = (await putDraft(B, d4.id, await makeHead(B, d4.id, (d) => {
    const sec = d.sections[0]; const p0 = sec.bodyParas[0];
    sec.load(`${sec.xml.slice(0, p0.start)}<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>김검토가 맨 위에 넣은 문단</hp:t></hp:run></hp:p>${sec.xml.slice(p0.start)}`);
    replaceIn(d, 's0/p5', '3월부터', '4월부터');                // 넣은 문단 때문에 기준 p4 가 p5
  }))).cr;
  await B(`/api/docs/${d4.id}/change-requests/${crRB.cid}/submit`, { method: 'POST', body: { title: '머리 문단·시작 달' } });
  await ADM(`/api/docs/${d4.id}/change-requests/${crRB.cid}/merge`, { method: 'POST' });
  const before4 = await A(`/api/docs/${d4.id}/change-requests/${crR.cid}`);
  ok(before4.behind === 1 && eq(before4.hunks.map((h) => [h.type, h.curRef, h.state]), [['insert', 's0/p3', 'ok'], ['delete', 's0/p7', 'ok'], ['replace', 's0/p8', 'ok']]), '김검토 반영 뒤 내 덩어리 curRef 가 한 칸씩 밀림(p3 뒤·p7·p8)');
  const rb4 = await A(`/api/docs/${d4.id}/drafts/mine/rebase`, { method: 'POST' });
  ok(rb4.conflicts.length === 0 && rb4.cr.behind === 0 && eq(rb4.cr.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['insert', 's0/p3'], ['delete', 's0/p7'], ['replace', 's0/p8']]), 'rebase → 충돌 없음, 덩어리를 지금 기준으로 다시 계산(p3 뒤·p7·p8)');
  const draft4 = await HwpxDoc.load((await A.res(`/api/docs/${d4.id}/drafts/mine/file`)).data);
  // 김검토의 맨 위 문단은 정말 맨 위에 들어간다(구역 첫머리 넣기 atStart — 구역 나누기는 새 첫 문단으로, 2026-10-29 구역 편집). 종전에는 첫 문단 뒤
  const want4 = ['김검토가 맨 위에 넣은 문단', '첫째 문단입니다. 메모 대상 문장이 여기 있습니다.', '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)', '셋째 문단은 AI 제안대로 둡니다.', '홍길동이 넣은 문단',
    '넷째 문단: 사업 개요를 적습니다.', '다섯째 문단: 추진 일정은 4월부터 12월까지입니다.', '여섯째 문단: 예산은 총 1억 원입니다.', '여덟째 문단: 끝말입니다.'];
  ok(eq(draft4.bodyTexts()[0], want4) && draft4.changes().length === 0, `새 수정본 = 지금 기준(남의 머리 문단·4월) + 내 추가·지움·바꿈(변경 추적 없음) ${JSON.stringify(draft4.bodyTexts()[0])}`);
  await A(`/api/docs/${d4.id}/change-requests/${crR.cid}/submit`, { method: 'POST', body: { title: '정리' } });
  const mR = await ADM(`/api/docs/${d4.id}/change-requests/${crR.cid}/merge`, { method: 'POST' });
  const final4 = (await docOf(A, d4.id)).bodyTexts()[0];
  ok(eq(mR.report.inserted, ['s0/p4']) && eq(final4, want4), `반영 → 기준 최종본 = 새 수정본 글(2026-10-30 — 지운 문단은 앞 문단 끝 나눔 지움으로 최종본에서 없어짐, 빈 줄 없음, 문단 ${final4.length}개)`);

  // ───────── 6. 메모 스레드 ─────────
  section('메모 스레드(답글·해결) — 사람 메모·AI 의견은 본문 + 블록, 요청·제안 메모는 렌더러 글 + 블록');
  const memo1 = (await A(`/api/docs/${id}/memos`)).find((m) => m.id === 'memo1');
  const memo1Text = memo1.text;
  ok(memo1.key === 's0:f900000001' && eq(memo1.thread, { replies: [], resolved: null }) && memo1.body === memo1Text && memo1.link === null, `메모 목록: key ${memo1.key}, 빈 스레드, body = 글`);
  const vm = await versionOf(A, id);
  let mr = await B(`/api/docs/${id}/memos/memo1/replies`, { method: 'POST', body: { text: '근거 확인했습니다' } });
  ok(mr.thread.replies.length === 1 && mr.thread.replies[0].by === nameB && mr.body === memo1Text && mr.text.startsWith(`${memo1Text}\n── 답글\n↳ ${nameB} `), '답글 → 메모 글 = 본문 + 블록, body 는 본문만');
  ok(await versionOf(A, id) === vm + 1, '사람 메모 답글 = 버전 하나');
  ok((await ws.waitFor((m) => m.type === 'memo' && m.action === 'reply' && m.memoId === 'memo1')).by === nameB, 'WS memo reply');
  mr = await A(`/api/docs/${id}/memos/memo1/replies`, { method: 'POST', body: { text: '고맙습니다' } });
  mr = await ADM(`/api/docs/${id}/memos/memo1/resolve`, { method: 'POST', body: { resolved: true } });
  ok(mr.thread.replies.length === 2 && mr.thread.resolved?.by === nameAdm, '두 번째 답글 + 관리자 해결');
  const inDoc = (await docOf(A, id)).memos().find((m) => m.id === 'memo1').text;
  const lines = inDoc.split('\n');
  ok(lines[0] === memo1Text && lines[1] === '── 답글' && /^↳ 김검토 \d\d-\d\d \d\d:\d\d: 근거 확인했습니다$/.test(lines[2]) && /^↳ 홍길동 \d\d-\d\d \d\d:\d\d: 고맙습니다$/.test(lines[3]) && /^✓ 해결됨 · 관리자 \d\d-\d\d \d\d:\d\d$/.test(lines[4]) && lines.length === 5, `문서 안 메모 글(한글에서 보임):\n      ${inDoc.replace(/\n/g, '\n      ')}`);
  mr = await ADM(`/api/docs/${id}/memos/memo1`, { method: 'PATCH', body: { text: '고친 본문입니다' } });
  ok(mr.body === '고친 본문입니다' && mr.text.startsWith('고친 본문입니다\n── 답글\n↳ 김검토') && mr.text.includes('✓ 해결됨'), '본문 고치기(PATCH) 뒤에도 답글 블록 유지');
  mr = await B(`/api/docs/${id}/memos/memo1/resolve`, { method: 'POST', body: { resolved: false } });
  ok(mr.thread.resolved === null && !mr.text.includes('✓ 해결됨') && mr.text.includes('↳ 홍길동'), '다시 열기 → ✓ 줄만 빠짐');
  ok((await B.res(`/api/docs/${id}/memos/memo1/replies`, { method: 'POST', body: { text: '  ' } })).data.error === 'EMPTY' && (await B.res(`/api/docs/${id}/memos/nomemo/replies`, { method: 'POST', body: { text: 'x' } })).status === 404, '빈 답글 400 EMPTY, 없는 메모 404');
  // AI 의견 메모(요청의 comment): 글이 렌더러로 다시 만들어지지 않으므로 사람 메모처럼 머리줄 + 본문 + 블록
  const rq = await A(`/api/docs/${id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p4' } } });
  const cmm = await B(`/api/docs/${id}/memos`, { method: 'POST', body: { ref: 's0/p4', text: '일정 근거가 필요합니다', rid: rq.request.rid } });
  const cmHead = `[AI 의견 · 작업 #${rq.request.rid}] ${nameB}`;
  let cr2m = await A(`/api/docs/${id}/memos/${cmm.id}/replies`, { method: 'POST', body: { text: '근거 표를 붙이겠습니다' } });
  ok(cr2m.link?.type === 'comment' && cr2m.body === '일정 근거가 필요합니다' && cr2m.text.startsWith(`${cmHead}\n일정 근거가 필요합니다\n── 답글\n↳ ${nameA} `), 'AI 의견 메모 답글 → 머리줄 + 본문 + 블록, body 는 본문만');
  cr2m = await A(`/api/docs/${id}/memos/${cmm.id}`, { method: 'PATCH', body: { text: '일정·예산 근거가 필요합니다' } });
  ok(cr2m.text.startsWith(`${cmHead}\n일정·예산 근거가 필요합니다\n── 답글\n↳ ${nameA} `) && cr2m.body === '일정·예산 근거가 필요합니다', 'AI 의견 본문 고치기 → 머리줄·블록 유지');
  // 제안 메모: 스레드 블록은 렌더러(renderProposalMemo)가 붙인다 — 글 = 렌더러 글 + 블록(버전 하나), body 는 사람 메모(note)
  const prop1 = await A(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: 's0/p6', find: '1억 원', replace: '1억 2천만 원', reason: '증액 반영' } });
  const pm = (await A(`/api/docs/${id}/memos`)).find((m) => m.id === prop1.memoId);
  const vp = await versionOf(A, id);
  const pmr = await B(`/api/docs/${id}/memos/${prop1.memoId}/replies`, { method: 'POST', body: { text: '증액 근거?' } });
  const REPLY_B1 = new RegExp(`^↳ ${nameB} \\d\\d-\\d\\d \\d\\d:\\d\\d: 증액 근거\\?$`);
  ok(pm.link?.type === 'proposal' && pmr.thread.replies[0].text === '증액 근거?' && pmr.text.startsWith(`${pm.text}\n── 답글\n`) && REPLY_B1.test(pmr.text.split('\n').at(-1))
    && pmr.body === '' && await versionOf(A, id) === vp + 1, '제안 메모 답글 → 렌더러 글 + 스레드 블록(버전 하나), body 는 사람 메모(note — 없음)');
  ok((await docOf(A, id)).memos().find((m) => m.id === prop1.memoId)?.text === pmr.text, '문서(한글에서 보이는 글)에도 블록');

  // ───────── 6b. 요청·제안 메모 스레드 블록 — 상태가 바뀌어 렌더러가 다시 써도 남음 ─────────
  section('요청·제안 메모의 답글·해결 블록: 제안 거절·다시 열기, 요청의 제안 생김·거절(메모 다시 씀) 뒤에도 그대로, body 는 요약·메모');
  // 제안 메모: 답글 + 해결 → 거절(상태 줄 생김) → 다시 열기(상태 줄 빠짐) — 블록은 언제나 글 끝
  const prop3 = await A(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '끝맺음말', replace: '맺는 말', reason: '표현' } });
  await B(`/api/docs/${id}/memos/${prop3.memoId}/replies`, { method: 'POST', body: { text: '이대로 좋습니다' } });
  await ADM(`/api/docs/${id}/memos/${prop3.memoId}/resolve`, { method: 'POST', body: { resolved: true } });
  const blockOf = (t) => { const ls = t.split('\n'); const i = ls.indexOf('── 답글'); return i < 0 ? null : ls.slice(i); };
  const BLOCK3 = (b) => !!b && b.length === 3 && new RegExp(`^↳ ${nameB} \\d\\d-\\d\\d \\d\\d:\\d\\d: 이대로 좋습니다$`).test(b[1]) && /^✓ 해결됨 · 관리자 \d\d-\d\d \d\d:\d\d$/.test(b[2]);
  const memoText = async (mid0) => (await docOf(A, id)).memos().find((m) => m.id === mid0)?.text || '';
  await A(`/api/docs/${id}/proposals/${prop3.pid}/reject`, { method: 'POST' });
  const t3r = await memoText(prop3.memoId);
  ok(t3r.includes('\n상태: 거절 ✗ ') && BLOCK3(blockOf(t3r)) && t3r.indexOf('상태: 거절') < t3r.indexOf('── 답글'), `제안 거절(메모 다시 씀) → 상태 줄 + 블록(답글·해결) 그대로:\n      ${t3r.replace(/\n/g, '\n      ')}`);
  await A(`/api/docs/${id}/proposals/${prop3.pid}/reopen`, { method: 'POST' });
  const t3o = await memoText(prop3.memoId);
  ok(!t3o.includes('상태: 거절') && t3o.includes('다시 열기') && BLOCK3(blockOf(t3o)), '다시 열기(메모 다시 씀) → 상태 줄 빠지고 블록 그대로');
  const pm3 = (await A(`/api/docs/${id}/memos`)).find((m) => m.id === prop3.memoId);
  ok(pm3.body === '' && pm3.thread.replies.length === 1 && pm3.thread.resolved?.by === nameAdm, '제안 메모 항목: body = 사람 메모(없음 — 블록 아님), thread = 답글 1·해결');
  const pn = await A(`/api/docs/${id}/memos/${prop3.memoId}`, { method: 'PATCH', body: { text: '표현만 바꿉니다' } });
  ok(pn.body === '표현만 바꿉니다' && pn.text.includes('\n메모: 표현만 바꿉니다\n') && BLOCK3(blockOf(pn.text)), '제안 메모 고치기(note) → 메모 줄 + 블록 그대로');

  // 작업 기록 메모(요청): 답글 + 해결 → 그 요청의 제안이 생기고(결과 줄) 거절되어도(결과 줄 바뀜) 블록 그대로. body = 공유 요약
  const rqMemoId = rq.request.memoId;
  let rqm = await B(`/api/docs/${id}/memos/${rqMemoId}/replies`, { method: 'POST', body: { text: '결과를 기다립니다' } });
  const rqNow = await A(`/api/docs/${id}/requests/${rq.request.rid}`);
  ok(rqm.link?.type === 'request' && rqm.link.rid === rq.request.rid && rqm.text.startsWith(`[AI 작업 #${rq.request.rid}] AI 검토 · 요청 ${nameA}`) && rqm.text.includes('\n── 답글\n↳ 김검토 ')
    && rqm.body === rqNow.summary && !rqm.body.includes('── 답글'), `작업 기록 메모 답글 → 렌더러 글 + 블록, body = 공유 요약(「${rqm.body}」)`);
  rqm = await ADM(`/api/docs/${id}/memos/${rqMemoId}/resolve`, { method: 'POST', body: { resolved: true } });
  // 요청 메모의 해결은 요청 해결(V3 §9.2 — '✓ 해결 · …' 줄)만: 스레드 해결 표시(✓ 해결됨)는 작업 기록 메모 글에 쓰지 않는다(§9.3-2 아래). 답글 블록은 그대로
  const BLOCKR = (b) => !!b && b.length === 2 && /^↳ 김검토 \d\d-\d\d \d\d:\d\d: 결과를 기다립니다$/.test(b[1]);
  ok(BLOCKR(blockOf(rqm.text)) && !rqm.text.includes('✓ 해결됨'), '요청 메모의 스레드 해결 → 글에는 쓰지 않음(요청 해결 줄로만), 답글 블록 그대로');
  // 요청에 딸린 제안은 제안 메모를 만들지 않는다(V3 §9.3) — 작업 기록 메모의 결과 줄만 바뀐다(남은 것은 목록에 적지 않음, 거절은 쓰지 않음)
  const rqp = await A(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '4월부터', replace: '5월부터', rid: rq.request.rid } });
  const trq1 = await memoText(rqMemoId);
  ok(rqp.memo === false && !rqp.memoId && trq1.includes('\n결과: 남은 제안 1건 · 의견 1건\n') && !trq1.includes('4월부터') && BLOCKR(blockOf(trq1)), `요청의 제안 생김(제안 메모 없음, 작업 기록 메모 다시 씀) → 결과 줄 + 블록 그대로:\n      ${trq1.replace(/\n/g, '\n      ')}`);
  await A(`/api/docs/${id}/proposals/${rqp.pid}/reject`, { method: 'POST' });
  const trq2 = await memoText(rqMemoId);
  ok(trq2.includes('\n결과: 반영한 제안 없음 · 의견 1건\n') && !trq2.includes('거절') && BLOCKR(blockOf(trq2)) && trq2.indexOf('이력: ') < trq2.indexOf('── 답글'), '그 제안 거절(메모 다시 씀) → 결과 줄 바뀌고(거절은 적지 않음) 블록은 이력 줄 뒤 그대로');
  const rqItem = (await A(`/api/docs/${id}/memos`)).find((m) => m.id === rqMemoId);
  ok(rqItem.body === (await A(`/api/docs/${id}/requests/${rq.request.rid}`)).summary && eq(rqItem.thread.replies.map((r) => r.text), ['결과를 기다립니다']) && rqItem.thread.resolved?.by === nameAdm, '작업 기록 메모 항목: body = 요약(블록 없음), thread 그대로');
  const rqPatched = await A(`/api/docs/${id}/memos/${rqMemoId}`, { method: 'PATCH', body: { text: '검토 결과를 공유합니다' } });
  ok(rqPatched.body === '검토 결과를 공유합니다' && rqPatched.text.includes('\n요약: 검토 결과를 공유합니다\n') && BLOCKR(blockOf(rqPatched.text)), '요약 고치기(PATCH) → 요약 줄 바뀌고 블록 그대로');

  // ───────── 7. 제안을 내 수정본에 반영(adopt) → 반영 때 applied ─────────
  section('제안 adopt → 변경 요청 반영 때 들어간 제안은 applied(via cid), 안 들어간 것은 대기 그대로');
  const prop2 = await B(`/api/docs/${id}/proposals`, { method: 'POST', body: { ref: 's0/p2', find: '둡니다', replace: '그대로 둡니다' } });
  const ad1 = await A(`/api/docs/${id}/proposals/${prop1.pid}/adopt`, { method: 'POST', body: {} });
  ok(ad1.proposal.adopted?.by === nameA && ad1.proposal.adopted.cid === null && ad1.cr === null && ad1.proposal.status === 'pending', '변경 요청이 아직 없을 때 adopt → 제안에만 기록(cid null, 대기 그대로)');
  const listedAd1 = (await A(`/api/docs/${id}/proposals`)).find((p) => p.pid === prop1.pid);
  ok(listedAd1.adopted?.by === nameA && listedAd1.adopted.cid === null && listedAd1.adopted.at === ad1.proposal.adopted.at, '제안 목록: adopted { by, cid: null(변경 요청 아직 없음), at }');
  await A(`/api/docs/${id}/proposals/${prop2.pid}/adopt`, { method: 'POST', body: {} });
  ok((await ws.waitFor((m) => m.type === 'proposal' && m.action === 'adopted' && m.pid === prop1.pid)).by === nameA, 'WS proposal adopted');
  const cr6 = (await putDraft(A, id, await makeHead(A, id, (d) => replaceIn(d, 's0/p6', '1억 원', '1억 2천만 원')))).cr;
  ok(cr6.cid === 6 && eq([...cr6.adopted].sort((a, b) => a - b), [prop1.pid, prop2.pid]), `수정본 저장으로 변경 요청 #6 생김 → 반영해 둔 제안 ${cr6.adopted} 묶음`);
  const adoptedList = (await B(`/api/docs/${id}/proposals?status=pending`)).filter((p) => p.adopted);
  ok(eq(adoptedList.map((p) => p.pid).sort((a, b) => a - b), [prop1.pid, prop2.pid]) && adoptedList.every((p) => eq(Object.keys(p.adopted).sort(), ['at', 'by', 'cid']) && p.adopted.by === nameA && p.adopted.cid === 6 && !Number.isNaN(Date.parse(p.adopted.at))),
    '제안 목록(남이 봐도): 반영해 둔 제안에 adopted { by, cid: 6, at }');
  ok((await A.res(`/api/docs/${id}/proposals/999/adopt`, { method: 'POST', body: {} })).status === 404, '없는 제안 adopt → 404');
  await A(`/api/docs/${id}/change-requests/6/submit`, { method: 'POST', body: { title: '예산 증액' } });
  await B(`/api/docs/${id}/change-requests/6/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const m6 = await A(`/api/docs/${id}/change-requests/6/merge`, { method: 'POST' });
  ok(eq(m6.report.adopted, { applied: [prop1.pid], released: [prop2.pid] }), `report.adopted: applied ${m6.report.adopted.applied}, released ${m6.report.adopted.released}`);
  const props = await A(`/api/docs/${id}/proposals`);
  const p1 = props.find((p) => p.pid === prop1.pid); const p2 = props.find((p) => p.pid === prop2.pid);
  ok(p1.status === 'applied' && eq(p1.via, { cid: 6 }) && p1.appliedVersion === m6.version && p1.appliedBy === nameA && !p1.adopted && p1.changeIds.length > 0, `제안 #${p1.pid} → applied(via #6, v${p1.appliedVersion}, 변경 ${p1.changeIds})`);
  ok(p2.status === 'pending' && !p2.adopted, `제안 #${p2.pid} → 대기 그대로(묶음 풂)`);
  const pmAfter = (await docOf(A, id)).memos().find((m) => m.id === prop1.memoId);
  ok(pmAfter && pmAfter.text.includes(`상태: 적용 ✓ ${nameA}`), '제안 메모에 적용 상태');
  const pmLines = pmAfter.text.split('\n');
  ok(pmLines.at(-2) === '── 답글' && REPLY_B1.test(pmLines.at(-1)) && pmAfter.text.indexOf('상태: 적용') < pmAfter.text.indexOf('── 답글'), '변경 요청 반영으로 적용(제안 메모 다시 씀) 뒤에도 앞서 단 답글 블록이 글 끝에 그대로');
  const listed = props.find((p) => p.pid === prop2.pid);
  ok(!('adopted' in listed) && !('adopted' in p1), '반영 뒤 제안 목록: 묶음(adopted)은 풀림(적용된 것은 via)');

  // ───────── 8. 한글로 저장 — 검토 메모 ─────────
  section('한글로 저장(?reviews=1): 진행 중인 변경 요청 덩어리마다 검토 메모 — 사본만, 두 번 받아도 같음');
  const headB7 = await makeHead(B, id, (d) => { replaceIn(d, 's0/p2', '셋째 문단은', '셋째 문단은 이제'); d.insertParagraphAfter(0, 2, '김검토가 넣은 문단', ED); });
  const cr7 = (await putDraft(B, id, headB7)).cr;
  await B(`/api/docs/${id}/change-requests/${cr7.cid}/submit`, { method: 'POST', body: { title: '셋째 문단 보강' } });
  const hidRep7 = cr7.hunks.find((h) => h.type === 'replace').hid;
  await A(`/api/docs/${id}/change-requests/${cr7.cid}/threads`, { method: 'POST', body: { hid: hidRep7, text: '왜 바꾸나요?' } });
  await A(`/api/docs/${id}/change-requests/${cr7.cid}/threads`, { method: 'POST', body: { text: '전체적으로 좋습니다' } });
  await A(`/api/docs/${id}/change-requests/${cr7.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const cr8 = (await putDraft(A, id, await makeHead(A, id, (d) => replaceIn(d, 's0/p0', '여기 있습니다', '이곳에 있습니다')))).cr;
  ok(cr7.cid === 7 && cr8.cid === 8 && cr7.hunks.length === 2 && cr8.hunks.length === 1, '검토 중 #7(김검토, 덩어리 2) · 수정 중 #8(홍길동, 덩어리 1)');
  const vE = await versionOf(A, id); const memosE = (await A(`/api/docs/${id}/memos`)).length;
  const trackedBefore = (await A.res(`/api/docs/${id}/file?kind=tracked`)).data;
  const ex1 = await B.res(`/api/docs/${id}/file?kind=tracked&reviews=1`);
  const cd = decodeURIComponent((ex1.headers.get('content-disposition') || '').replace(/^.*filename\*=UTF-8''/, ''));
  ok(ex1.status === 200 && cd === '협업 시험_검토본.hwpx' && ex1.headers.get('x-doc-version') === String(vE) && ex1.headers.get('x-review-memos') === '3', `검토본: ${cd}, X-Doc-Version ${vE}, 검토 메모 3`);
  const exDoc = await HwpxDoc.load(ex1.data);
  const REVIEW_RE = /^\[변경 요청 #\d+ · (검토 중|수정 중)\]/;   // 검토 메모(반영 기록 메모 '[변경 요청 #n 반영]' 은 원래 문서에 있다)
  const crMemos = exDoc.memos().filter((m) => REVIEW_RE.test(m.text));
  ok(crMemos.length === 3 && exDoc.memos().length === memosE + 3, `다시 읽힘(HwpxDoc): 메모 ${exDoc.memos().length}(원래 ${memosE} + 검토 3)`);
  const m7rep = crMemos.find((m) => m.text.startsWith('[변경 요청 #7 · 검토 중] 김검토 — 셋째 문단 보강\n「'));
  ok(m7rep && m7rep.ref === 's0/p2' && m7rep.author === nameB && m7rep.text.includes('→ 「셋째 문단은 이제') && m7rep.text.endsWith('의견: 홍길동: 왜 바꾸나요? · 홍길동: 전체적으로 좋습니다 · 승인 1'), `바꿈 메모(s0/p2):\n      ${m7rep?.text.replace(/\n/g, '\n      ')}`);
  const m7ins = crMemos.find((m) => m.text.includes('이 문단 뒤에 문단 추가'));
  ok(m7ins && m7ins.ref === 's0/p2' && m7ins.text === '[변경 요청 #7 · 검토 중] 김검토 — 셋째 문단 보강\n이 문단 뒤에 문단 추가: 「김검토가 넣은 문단」\n의견: 승인 1', `문단 추가 메모: ${m7ins?.text.replace(/\n/g, ' / ')}`);
  const m8 = crMemos.find((m) => m.text.startsWith('[변경 요청 #8 · 수정 중] 홍길동\n'));
  ok(m8 && m8.ref === 's0/p0' && m8.text.includes('「') && m8.text.includes('이곳에 있습니다'), `수정 중 메모(s0/p0): ${m8?.text.replace(/\n/g, ' / ')}`);
  ok(exDoc.changes().length === (await A(`/api/docs/${id}/changes`)).length, '검토본은 변경 추적 그대로');
  ok(await versionOf(A, id) === vE && (await A(`/api/docs/${id}/memos`)).length === memosE && Buffer.compare((await A.res(`/api/docs/${id}/file?kind=tracked`)).data, trackedBefore) === 0, '원본·버전·메모는 그대로(사본만)');
  const ex2 = await A.res(`/api/docs/${id}/file?kind=tracked&reviews=1`);
  const sigs = async (b) => (await HwpxDoc.load(b)).memos().map(memoSig);
  ok(eq(await sigs(ex2.data), await sigs(ex1.data)), '두 번 내려받아도 같은 메모(글·자리·작성자·시각)');
  const exF = await A.res(`/api/docs/${id}/file?kind=final&reviews=1`);
  const exFDoc = await HwpxDoc.load(exF.data);
  const cdF = decodeURIComponent((exF.headers.get('content-disposition') || '').replace(/^.*filename\*=UTF-8''/, ''));
  ok(cdF === '협업 시험_최종.hwpx' && exFDoc.changes().length === 0 && exFDoc.memos().filter((m) => REVIEW_RE.test(m.text)).length === 3 && exFDoc.text('s0/p4') === '다섯째 문단: 추진 일정은 4월부터 11월까지입니다.', `최종본 + 검토 메모: ${cdF}, 변경 추적 없음, 검토 메모 3`);
  const plainF = await A.res(`/api/docs/${id}/file?kind=final`);
  ok(decodeURIComponent((plainF.headers.get('content-disposition') || '').replace(/^.*filename\*=UTF-8''/, '')) === '협업 시험_최종.hwpx' && (await HwpxDoc.load(plainF.data)).memos().every((m) => !REVIEW_RE.test(m.text)), 'kind=final(검토 메모 없이) → _최종.hwpx');

  // ───────── 9. 버리기·닫기·다시 열기·변경 없음 ─────────
  section('내 수정 버리기(draft 지움 / open 닫음) · 다시 열기 · 바뀐 것 없는 저장');
  const dl = await A(`/api/docs/${id}/drafts/mine`, { method: 'DELETE' });
  ok(dl.ok === true && dl.cr === null && !(await A(`/api/docs/${id}/change-requests`)).some((c) => c.cid === 8), 'draft #8 버리기 → 변경 요청·파일 지움');
  ok(!!(await ws.waitFor((m) => m.type === 'cr' && m.action === 'deleted' && m.cid === 8)), 'WS cr deleted');
  const dl7 = await B(`/api/docs/${id}/drafts/mine`, { method: 'DELETE' });
  ok(dl7.cr.status === 'closed' && dl7.cr.closedBy === nameB, 'open #7 버리기 → closed');
  const ro = await B(`/api/docs/${id}/change-requests/7/reopen`, { method: 'POST' });
  ok(ro.status === 'draft' && (await B(`/api/docs/${id}/drafts/mine`)).cr?.cid === 7, '다시 열기 → draft(내 수정본으로 돌아옴)');
  const same = await putDraft(B, id, await makeHead(B, id, () => {}));
  ok(same.cr === null && same.unchanged === true && !(await B(`/api/docs/${id}/change-requests`)).some((c) => c.cid === 7), '기준과 같은 수정본 저장 → draft 변경 요청 지움(cr null, unchanged)');
  const none = await putDraft(A, id, await makeHead(A, id, () => {}));
  const mineNone = await A(`/api/docs/${id}/drafts/mine`);
  ok(none.cr === null && none.unchanged === true && mineNone.cr === null && mineNone.file === null && none.rev === mineNone.rev, '변경 요청 없이 바뀐 것 없는 저장 → 아무것도 안 만듦(판 그대로)');

  // ───────── 10. 타이핑 중 알림 ─────────
  section('타이핑 중 알림(POST /editing) — 저장 없이 WS 만');
  ok(eq(await A(`/api/docs/${id}/editing`, { method: 'POST', body: { ref: 's0/p3' } }), { ok: true }), 'POST /editing → { ok }');
  const ed = await ws.waitFor((m) => m.type === 'editing' && m.ref === 's0/p3');
  ok(ed.user === nameA, `WS editing(${ed.user}, ${ed.ref})`);
  await A(`/api/docs/${id}/editing`, { method: 'POST', body: { ref: null } });
  ok((await ws.waitFor((m) => m.type === 'editing' && m.ref === null)).user === nameA, 'ref null → 그만 씀');
  ok((await A.res(`/api/docs/${id}/editing`, { method: 'POST', body: { ref: '../x' } })).data.error === 'BAD_REF', '이상한 ref → 400 BAD_REF');

  // ───────── 11. 표 칸 덩어리·반영 안 되는 변경 ─────────
  section('표 칸 덩어리(cell) · 표 추가 반영(insert objects) · 글맵시는 반영 안 되는 변경(unsupported) · 맨 앞 문단 추가');
  const d2 = await uploadDoc(srv.base, srv.tokens.admin, await buildTableDoc(), '표 시험.hwpx');
  const tid2 = d2.id;
  const tables = await A(`/api/docs/${tid2}/tables`);
  const cellRef = tables[0].cells.find((c) => c.row === 1 && c.col === 1).refs[0];
  ok(cellRef === 's0/p2/n3', `값 칸(1,1) = ${cellRef}`);
  const paras = await A(`/api/docs/${tid2}/paragraphs`);
  const body = paras.filter((p) => !p.parent);
  ok(eq(body.map((p) => p.kind), ['text', 'text', 'table', 'text']) && body.every((p) => typeof p.sig === 'string') && body[2].sig !== '' && paras.filter((p) => p.parent).every((p) => p.kind === undefined), 'GET /paragraphs: 본문 문단에 kind·sig(표 문단 kind table)');
  const headT = await makeHead(A, tid2, (d) => {
    d.mergeParagraphText(cellRef, '10', ED);
    replaceIn(d, 's0/p3', '둡니다', '둡니다(표 아래)');
    // 글맵시(hp:textart — 편집기가 읽지 못하는 개체)는 공유 문서에 들어가지 않는다 — 표·그림은 2026-10-28, 도형·글상자는 2026-10-30 부터 들어간다
    const sec = d.sections[0]; const at = sec.tokens[sec.byRef('s0/p0').runs[0].openTok].end;
    sec.load(`${sec.xml.slice(0, at)}<hp:textart/>${sec.xml.slice(at)}`);
    d.insertTableAfter(0, 3, { rows: [['새', '표']] }, ED);
  });
  const crT = (await putDraft(A, tid2, headT)).cr;
  ok(eq(crT.hunks.slice(0, 2).map(strip), [
    { type: 'replace', ref: 's0/p2/n3', baseText: '1', newText: '10', cell: { table: 's0/p2#t0', row: 1, col: 1 } },
    { type: 'replace', ref: 's0/p3', baseText: '셋째 문단은 AI 제안대로 둡니다.', newText: '셋째 문단은 AI 제안대로 둡니다(표 아래).', cell: null },
  ].map(strip)) && crT.stats.cells === 1 && crT.stats.changed === 1, '칸 덩어리(cell 정보) + 본문 덩어리, stats.cells 1');
  ok(crT.hunks.length === 3 && crT.hunks[2].type === 'insert' && crT.hunks[2].objects === true && crT.hunks[2].afterRef === 's0/p3', `새 표 → 개체 문단 넣기 덩어리(${JSON.stringify(crT.hunks[2])})`);
  ok(crT.unsupported.length === 1 && crT.unsupported[0].what === 'object' && crT.unsupported[0].ref === 's0/p0', `반영 안 되는 변경 1건 = 글맵시(${crT.unsupported[0]?.what}: ${crT.unsupported[0]?.detail})`);
  await A(`/api/docs/${tid2}/change-requests/${crT.cid}/submit`, { method: 'POST', body: { title: '표 값' } });
  await B(`/api/docs/${tid2}/change-requests/${crT.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const mT = await A(`/api/docs/${tid2}/change-requests/${crT.cid}/merge`, { method: 'POST' });
  const afterT = await docOf(A, tid2);
  ok(eq(mT.report.cells, ['s0/p2/n3']) && eq(mT.report.changed, ['s0/p3']) && mT.report.unsupported === 1, 'report: 칸 1·문단 1, unsupported 1');
  ok(afterT.text('s0/p2/n3') === '10' && afterT.text('s0/p2/n3', 'markup') === '1{+0+}' && afterT.tables().length === 2 && !/<hp:textart\b/.test(afterT.sections[0].xml), `칸 글 '10'(변경 추적 ${afterT.text('s0/p2/n3', 'markup')}), 새 표는 들어가고 글맵시는 안 들어감(표 ${afterT.tables().length}개)`);
  ok(afterT.changes().filter((c) => c.ref === 's0/p2/n3').every((c) => c.author === nameA), '칸 변경 추적 작성자 = 홍길동');
  // 승인 방식 문서의 반영도 개체를 변경 추적으로(2026-10-30 — 글처럼 처리 안 된 변경으로 남김): 새 표 = '표 넣음'(작성자 = 변경 요청 작성자)
  const tblIns = afterT.changes().filter((c) => c.kind === 'object');
  ok(tblIns.length === 1 && tblIns[0].type === 'Insert' && tblIns[0].label === '표 넣음' && tblIns[0].author === nameA,
    `승인 방식 반영: 새 표도 변경 추적(${tblIns.map((c) => `${c.label} ${c.ref} ${c.author}`).join(', ')})`);
  // 맨 앞(첫 문단 앞)에 넣은 문단: afterRef null → 반영 때도 맨 앞(구역 첫머리 넣기 atStart — 구역 나누기는 새 첫 문단으로, 2026-10-29). 종전에는 첫 문단 뒤
  await ADM(`/api/docs/${tid2}/changes/accept-all`, { method: 'POST' });
  const headFront = await makeHead(B, tid2, (d) => {
    const sec = d.sections[0]; const p0 = sec.bodyParas[0];
    sec.load(`${sec.xml.slice(0, p0.start)}<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>맨 앞에 쓴 문단</hp:t></hp:run></hp:p>${sec.xml.slice(p0.start)}`);
  });
  const crF = (await putDraft(B, tid2, headFront)).cr;
  ok(crF.hunks.length === 1 && crF.hunks[0].type === 'insert' && crF.hunks[0].afterRef === null && crF.hunks[0].ref === 's0/p0', '첫 문단 앞에 넣은 문단 → insert afterRef null(보여 줄 자리 s0/p0)');
  await B(`/api/docs/${tid2}/change-requests/${crF.cid}/submit`, { method: 'POST', body: { title: '머리 문단' } });
  const mF = await ADM(`/api/docs/${tid2}/change-requests/${crF.cid}/merge`, { method: 'POST' });
  const afterF = await docOf(A, tid2);
  ok(eq(mF.report.inserted, ['s0/p0']) && afterF.text('s0/p0') === '맨 앞에 쓴 문단' && afterF.text('s0/p1').startsWith('첫째 문단입니다.'), `관리자 반영(승인 없이) → 맨 앞(s0/p0)에 들어감 ${JSON.stringify(mF.report.inserted)}`);
  ok(mF.cr.mergedBy === nameAdm && afterF.changes().filter((c) => c.ref === 's0/p0').every((c) => c.author === nameB) && afterF.memos().some((m) => m.text === `[변경 요청 #${crF.cid} 반영] ${nameB} — 머리 문단 · 1문단 추가 · 반영 ${nameAdm}`), '변경 추적 작성자 = 김검토(작성자), 기록 메모에 「반영 관리자」');
  // 승인 방식 반영의 표 문단 지우기(2026-10-30): 표는 '표 지움' 변경으로 남고(작업본에서는 안 보임) — 문단 나눔 변경 추적 2단계부터는 빈 문단도 남지 않는다
  // (앞 문단 끝 '문단 나눔 지움' — 표 지움·나눔 지움 모두 앞 문단 ref)
  await ADM(`/api/docs/${tid2}/changes/accept-all`, { method: 'POST' });
  const tblsD = (await docOf(A, tid2, 'working')).tables();
  const lastT = /^s0\/p(\d+)$/.exec(tblsD.at(-1)?.ref || '');
  const crD = (await putDraft(B, tid2, await makeHead(B, tid2, (d) => d.removeBodyParagraph(0, Number(lastT[1]))))).cr;
  await B(`/api/docs/${tid2}/change-requests/${crD.cid}/submit`, { method: 'POST', body: { title: '표 빼기' } });
  await ADM(`/api/docs/${tid2}/change-requests/${crD.cid}/merge`, { method: 'POST' });
  const chAll = await A(`/api/docs/${tid2}/changes`); const chD = chAll.filter((c) => c.kind === 'object'); const brD = chAll.filter((c) => c.kind === 'para');
  const wkD = await docOf(A, tid2, 'working'); const trD = await docOf(A, tid2);
  ok(tblsD.length === 2 && chD.length === 1 && chD[0].type === 'Delete' && chD[0].label === '표 지움' && chD[0].author === nameB && chD[0].ref === `s0/p${Number(lastT[1]) - 1}`
    && brD.length === 1 && brD[0].type === 'Delete' && brD[0].author === nameB && brD[0].ref === chD[0].ref
    && wkD.tables().length === 1 && (trD.sections[0].xml.match(/<hp:tbl\b/g) || []).length === 2,
  `승인 방식 반영의 표 문단 지우기 → ${chAll.filter((c) => c.kind).map((c) => `${c.label} ${c.ref} ${c.author}`).join(', ')} · 작업본 표 ${wkD.tables().length}개, 추적본 표 XML 2개`);
  await ADM(`/api/docs/${tid2}/changes/accept-all`, { method: 'POST' });

  // ───────── 11b. 글이 표 앞에 있는 문단 — 메모가 칸 번호를 밀어도 제 칸 ─────────
  section('글이 표 앞에 있는 문단: 본문 글·칸 덩어리(두 사람) — 검토본 메모·반영 보고·남의 curRef 가 제 칸을 가리킴');
  const d5 = await uploadDoc(srv.base, srv.tokens.admin, await buildTextTableDoc(), '표 앞 글.hwpx');
  const tt = d5.id;
  const wsT = watchWs(srv.base, srv.tokens.b, tt); await wsT.ready;
  const whereOf = (d, ref) => d.paragraphs({ nested: true }).find((p) => p.ref === ref)?.where ?? null;
  const crTA = (await putDraft(A, tt, await makeHead(A, tt, (d) => {
    replaceIn(d, 's0/p2', '표 머리 글', '표 머리 글 고침');
    d.mergeParagraphText('s0/p2/n3', '10', ED);
  }))).cr;
  ok(eq(crTA.hunks.map((h) => [h.type, h.ref, h.newText]), [['replace', 's0/p2', '표 머리 글 고침'], ['replace', 's0/p2/n3', '10']]), '홍길동: 표 앞 글(s0/p2) + 칸(s0/p2/n3) 덩어리');
  const crTB = (await putDraft(B, tt, await makeHead(B, tt, (d) => d.mergeParagraphText('s0/p2/n5', '20', ED)))).cr;
  ok(eq(crTB.hunks.map((h) => [h.type, h.ref, h.newText]), [['replace', 's0/p2/n5', '20']]), '김검토: 같은 문단의 다른 칸(s0/p2/n5) 덩어리');
  await B(`/api/docs/${tt}/change-requests/${crTA.cid}/threads`, { method: 'POST', body: { hid: crTA.hunks[0].hid, text: '머리 글은 왜 바꾸나요?' } });
  const exT = await A.res(`/api/docs/${tt}/file?kind=tracked&reviews=1`);
  ok(exT.status === 200 && exT.headers.get('x-review-memos') === '3', `검토본(본문 메모가 칸 메모보다 앞 차례) → ${exT.status}, 검토 메모 ${exT.headers.get('x-review-memos')}`);
  const exTDoc = await HwpxDoc.load(exT.data);
  const parasT = exTDoc.paragraphs({ nested: true });
  const targetOf = (m) => parasT.find((p) => p.ref === m.ref) || null;   // 메모 본문 줄은 paragraphs() 에 없다
  const rvT = exTDoc.memos().filter((m) => REVIEW_RE.test(m.text));
  const mBody = rvT.find((m) => m.text.includes('→ 「표 머리 글 고침」'));
  const m10 = rvT.find((m) => m.text.includes('→ 「10」'));
  const m20 = rvT.find((m) => m.text.includes('→ 「20」'));
  ok(rvT.length === 3 && mBody?.ref === 's0/p2' && mBody.where === '본문' && targetOf(mBody)?.text === '표 머리 글' && mBody.text.includes(`의견: ${nameB}: 머리 글은 왜 바꾸나요?`), '본문 글 메모 → s0/p2(본문 「표 머리 글」, 의견 줄)');
  ok(m10 && m10.where === '표' && targetOf(m10)?.where === '표' && targetOf(m10).text === '1' && m10.text.includes('「1」'), `칸 메모(1→10) → ${m10?.ref}(표 칸 「1」 — 다른 메모 본문 안이 아님)`);
  ok(m20 && m20.where === '표' && targetOf(m20)?.where === '표' && targetOf(m20).text === '2' && m20.author === nameB, `남의 칸 메모(2→20) → ${m20?.ref}(표 칸 「2」)`);
  ok(eq(exTDoc.bodyEntries()[0][2].nested.map((n) => n.text), ['구분', '값', '가', '1', '나', '2']), '검토본 표 칸 글 그대로');
  // 반영: 기록 메모가 s0/p2 자기 글(표 앞)에 달려 칸 번호가 밀려도 보고·WS refs 는 지금 문서의 그 칸
  await A(`/api/docs/${tt}/change-requests/${crTA.cid}/submit`, { method: 'POST', body: { title: '머리 글·값' } });
  await B(`/api/docs/${tt}/change-requests/${crTA.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const mTA = await A(`/api/docs/${tt}/change-requests/${crTA.cid}/merge`, { method: 'POST' });
  const afterTA = await docOf(A, tt);
  const cellA = mTA.report.cells[0];
  ok(eq(mTA.report.changed, ['s0/p2']) && mTA.report.cells.length === 1 && afterTA.text(cellA) === '10' && whereOf(afterTA, cellA) === '표', `반영 보고 칸 ${cellA} = 지금 문서의 그 칸(「10」, 표)`);
  ok(afterTA.memos().find((m) => m.id === mTA.report.memoId)?.ref === 's0/p2' && afterTA.text('s0/p2') === '표 머리 글 고침', '기록 메모는 첫 바뀐 문단(s0/p2 — 표 앞 글)');
  const wsTA = await wsT.waitFor((m) => m.type === 'cr' && m.action === 'merged' && m.cid === crTA.cid);
  ok(eq(wsTA.refs, ['s0/p2', cellA]), `WS cr merged refs ${wsTA.refs}`);
  const cvTB = await B(`/api/docs/${tt}/change-requests/${crTB.cid}`);
  ok(cvTB.hunks[0].state === 'ok' && afterTA.text(cvTB.hunks[0].curRef) === '2' && whereOf(afterTA, cvTB.hunks[0].curRef) === '표', `김검토 칸 덩어리 curRef ${cvTB.hunks[0].curRef}(지금 그 칸 「2」, state ok)`);
  await B(`/api/docs/${tt}/change-requests/${crTB.cid}/submit`, { method: 'POST', body: { title: '값 고침' } });
  const mTB = await ADM(`/api/docs/${tt}/change-requests/${crTB.cid}/merge`, { method: 'POST' });
  const afterTB = await docOf(A, tt);
  ok(afterTB.text(mTB.report.cells[0]) === '20' && whereOf(afterTB, mTB.report.cells[0]) === '표' && eq(afterTB.bodyEntries()[0][2].nested.map((n) => n.text), ['구분', '값', '가', '10', '나', '20']), `김검토 반영 → 제 칸(${mTB.report.cells[0]})에 「20」, 표 칸 글 [구분 값 가 10 나 20]`);
  wsT.close();

  // ───────── 11b2. 표 칸 안 Enter·Backspace(칸 문단 수가 바뀐 수정본) — 승인 방식 반영(회귀) ─────────
  section('표 칸 안 Enter·Backspace 한 수정본: 덩어리 = 칸 글을 줄바꿈(\\n)으로 접은 replace(table-structure 없음) → 승인 → 반영(변경 추적, 칸 문단 수 그대로) · 남이 같은 표 다른 칸을 먼저 반영해도 3-way');
  // (예전: 칸 문단 수가 바뀐 표는 칸 글을 하나도 비교하지 않아(unsupported table-structure) 그 표의 고침이 반영 때 모두 빠졌다)
  const d7 = await uploadDoc(srv.base, srv.tokens.admin, await buildMultiCellDoc(), '칸 여러 문단.hwpx');
  const t7 = d7.id; const T7 = `/api/docs/${t7}`;
  const cell11 = { table: 's0/p2#t0', row: 1, col: 1 };
  ok(eq((await A(`${T7}/paragraphs`)).filter((p) => p.cell?.row === 1 && p.cell?.col === 1).map((p) => p.ref), ['s0/p2/n3', 's0/p2/n4']), '(전제) 값 칸 (1,1) = 문단 둘(s0/p2/n3·n4)');
  // 홍길동: 둘째 줄 가운데에서 Enter 하고 새 줄에 이어 침 + 다른 칸(2,1) 고침
  const crE = (await putDraft(A, t7, await makeHead(A, t7, (d) => {
    setCellParas(d, ['s0/p2/n4'], ['둘째 줄', ' 내용(새 줄에 이어 친 글)']);
    if (d.text('s0/p2/n7') !== '2') throw new Error('나눈 뒤 칸 (2,1) 은 s0/p2/n7');
    d.mergeParagraphText('s0/p2/n7', '20', ED);   // 같은 표 다른 칸(2,1) — 수정본에서는 칸 문단이 하나 늘어 n7, 기준에서는 n6
  }))).cr;
  ok(eq(crE.hunks.map(strip), [
    { type: 'replace', ref: 's0/p2/n4', baseText: MULTI_CELL[1], newText: '둘째 줄\n 내용(새 줄에 이어 친 글)', cell: cell11 },
    { type: 'replace', ref: 's0/p2/n6', baseText: '2', newText: '20', cell: { table: 's0/p2#t0', row: 2, col: 1 } },
  ].map(strip)) && eq(crE.unsupported, []) && crE.hunks.every((h) => !h.structure) && crE.stats.cells === 2,
  `칸 안 Enter → 그 칸 문단(기준 s0/p2/n4) replace — 글은 줄바꿈으로 접힘 · 같은 표 다른 칸(기준 n6)도 그대로 비교 · 반영 안 되는 변경 없음 ${JSON.stringify(crE.hunks.map((h) => [h.ref, h.newText]))}`);
  // 김검토(같은 기준): 같은 표의 다른 칸 문단(첫째 줄)을 고쳐 먼저 반영
  const crO = (await putDraft(B, t7, await makeHead(B, t7, (d) => replaceIn(d, 's0/p2/n3', '첫째 줄 내용', '첫째 줄 내용(김검토)')))).cr;
  await B(`${T7}/change-requests/${crO.cid}/submit`, { method: 'POST', body: { title: '첫째 줄' } });
  await A(`${T7}/change-requests/${crO.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  await B(`${T7}/change-requests/${crO.cid}/merge`, { method: 'POST' });
  await A(`${T7}/change-requests/${crE.cid}/submit`, { method: 'POST', body: { title: '값 칸 줄 나눔' } });
  const viewE = await B(`${T7}/change-requests/${crE.cid}`);
  ok(viewE.canMerge === false && viewE.hunks.every((h) => h.state === 'ok' && h.conflict === null) && viewE.hunks[0].curRef === 's0/p2/n4',
    `남의 반영 뒤에도 칸 덩어리는 제자리(state ok · curRef ${viewE.hunks[0].curRef}) — 승인만 남음`);
  await B(`${T7}/change-requests/${crE.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const mE = await A(`${T7}/change-requests/${crE.cid}/merge`, { method: 'POST' });
  const afterE = await docOf(A, t7);
  const cellNow = afterE.paragraphs().filter((p) => p.cell?.row === 1 && p.cell?.col === 1);
  ok(mE.cr.status === 'merged' && eq(mE.report.cells, ['s0/p2/n4', 's0/p2/n6']) && mE.report.unsupported === 0 && afterE.text('s0/p2/n6') === '20'
    && eq(cellNow.map((p) => p.text), ['첫째 줄 내용(김검토)', '둘째 줄\n 내용(새 줄에 이어 친 글)']),
  `반영 → 칸 문단 수 그대로(${cellNow.length}), 친 글은 줄바꿈으로 · 먼저 반영된 남의 칸 고침도 그대로 ${JSON.stringify(cellNow.map((p) => p.text))}`);
  const insE = afterE.changes().filter((c) => c.ref === 's0/p2/n4');
  ok(insE.length >= 1 && insE.every((c) => c.author === nameA) && insE.some((c) => c.type === 'Insert' && c.text.includes('\n')) && afterE.sections[0].xml.includes('<hp:lineBreak/>'),
    `승인 방식 반영은 변경 추적(작성자 = 변경 요청 작성자) — 넣은 글에 줄바꿈(<hp:lineBreak/>) ${JSON.stringify(insE.map((c) => [c.type, c.text]))}`);
  // 김검토: Backspace 로 값 칸 두 문단을 합친 수정본 → 앞 문단에 합친 글 + 뒤 문단 비움(문단은 남음)
  const crJ = (await putDraft(B, t7, await makeHead(B, t7, (d) => setCellParas(d, ['s0/p2/n3', 's0/p2/n4'], [`${d.text('s0/p2/n3')}${d.text('s0/p2/n4')}`])))).cr;
  ok(eq(crJ.unsupported, []) && eq(crJ.hunks.map((h) => [h.ref, h.newText]), [['s0/p2/n3', '첫째 줄 내용(김검토)둘째 줄\n 내용(새 줄에 이어 친 글)'], ['s0/p2/n4', '']]),
    `Backspace 로 칸 문단 합침 → 앞 문단 replace(합친 글) + 뒤 문단 replace(빈 글) ${JSON.stringify(crJ.hunks.map((h) => [h.ref, h.newText]))}`);
  const exJ = await A.res(`${T7}/file?kind=tracked&reviews=1`);
  ok(exJ.status === 200 && Number(exJ.headers.get('x-review-memos')) >= 2, `한글로 저장(검토 메모) — 줄바꿈 든 덩어리도 메모로 ${exJ.headers.get('x-review-memos')}`);
  await B(`${T7}/change-requests/${crJ.cid}/submit`, { method: 'POST', body: { title: '값 칸 합침' } });
  await ADM(`${T7}/changes/accept-all`, { method: 'POST' });
  const mJ = await ADM(`${T7}/change-requests/${crJ.cid}/merge`, { method: 'POST' });
  const afterJ = await docOf(A, t7, 'final');
  ok(mJ.cr.status === 'merged' && eq(afterJ.paragraphs().filter((p) => p.cell?.row === 1 && p.cell?.col === 1).map((p) => p.text), ['첫째 줄 내용(김검토)둘째 줄\n 내용(새 줄에 이어 친 글)', '']),
    '반영(관리자) → 최종본 값 칸 = [합친 글, 빈 문단] — 글은 하나도 빠지지 않음');

  // ───────── 11c. XML 에 못 넣는 제어 문자 ─────────
  section('XML 금지 제어 문자(U+0001·U+000B …): 답글·제목·설명·의견·검토·수정본 글 — 저장 전에 빼고, 기준 문서·검토본 XML 에 안 들어감');
  const d6 = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '제어 문자.hwpx');
  const cc = d6.id;
  const rep = await B(`/api/docs/${cc}/memos/memo1/replies`, { method: 'POST', body: { text: '붙여 넣은\u000b글\u0001끝' } });
  ok(rep.thread.replies[0].text === '붙여 넣은\n글끝' && rep.text.split('\n').some((l) => l.endsWith(': 붙여 넣은 글끝')), `답글: U+000B → 줄바꿈(메모 글에서는 한 줄), U+0001 뺌 → 「${rep.thread.replies[0].text.replace(/\n/g, '⏎')}」`);
  const headC = await makeHead(A, cc, (d) => {
    // 편집기 내보내기에 제어 문자가 섞인 경우 — 엔진을 거치지 않고 XML 에 바로 넣는다
    d.insertParagraphAfter(0, 4, '새 문단 자리표', ED);
    const sec = d.sections[0];
    sec.load(sec.xml.replace('사업 개요를', '사업\u000b개요\u0002를').replace('새 문단 자리표', '새 문단\u0003입니다'));
  });
  ok((await badXmlChars(headC.bytes)).length === 3, '(전제) 수정본 XML 에 금지 글자 3개(U+000B·U+0002·U+0003)');
  const crC = (await putDraft(A, cc, headC)).cr;
  ok(eq(crC.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['replace', 's0/p3'], ['insert', 's0/p4']]), '수정본 덩어리: 바꿈 p3 · p4 뒤 추가');
  const subC = await A(`/api/docs/${cc}/change-requests/${crC.cid}/submit`, { method: 'POST', body: { title: '제목\u0007벨', description: '설명\u0000끝' } });
  ok(subC.title === '제목벨' && subC.description === '설명끝', `제목·설명에서 뺌(「${subC.title}」·「${subC.description}」)`);
  const thC = await B(`/api/docs/${cc}/change-requests/${crC.cid}/threads`, { method: 'POST', body: { hid: crC.hunks[0].hid, text: '의견\u0001입니다' } });
  const rvC = await B(`/api/docs/${cc}/change-requests/${crC.cid}/reviews`, { method: 'POST', body: { verdict: 'changes', body: '검토\u0008글' } });
  ok(thC.threads[0].comments[0].text === '의견입니다' && rvC.reviews[0].body === '검토글', '의견·검토 글에서 뺌');
  const exC = await A.res(`/api/docs/${cc}/file?kind=tracked&reviews=1`);
  ok(exC.status === 200 && exC.headers.get('x-review-memos') === '2' && eq(await badXmlChars(exC.data), []), '검토본(덩어리 글·제목·의견이 메모로 들어감) XML 에 금지 글자 없음');
  await B(`/api/docs/${cc}/change-requests/${crC.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  const mC = await A(`/api/docs/${cc}/change-requests/${crC.cid}/merge`, { method: 'POST' });
  const curC = (await A.res(`/api/docs/${cc}/file?kind=tracked`)).data;
  ok(eq(await badXmlChars(curC), []), '반영 뒤 기준 문서(답글·기록 메모·반영한 글) XML 에 금지 글자 없음');
  const docC = await HwpxDoc.load(curC);
  ok(docC.text('s0/p3') === '넷째 문단: 사업\n개요를 적습니다.' && eq(mC.report.inserted, ['s0/p5']) && docC.text('s0/p5') === '새 문단입니다', '반영한 글: U+000B → 줄바꿈(lineBreak), U+0002·U+0003 뺌');
  ok(docC.memos().some((m) => m.text === `[변경 요청 #${crC.cid} 반영] ${nameA} — 제목벨 · 1문단 수정 · 1문단 추가 · 승인 ${nameB}`), '기록 메모 제목도 깨끗함');

  // ───────── 11d. 제안 적용·되돌리기: 나뉜 삭제(deleteIds) ─────────
  // 제안 #2 의 찾을 글이 제안 #1 메모 끝을 품으면 엔진이 삭제를 개체 앞뒤로 나눈다(§4.3, replaceTracked → deleteIds).
  // 서비스가 첫 조각(deleteId)만 기억하면 되돌릴 때 나머지 삭제가 남아 글이 원래대로 돌아오지 않는다.
  section('제안 적용이 다른 제안 메모 끝을 건너면 삭제가 나뉨(§4.3) → 되돌리면 조각을 모두 거절(글·변경 추적 원래대로)');
  {
    const flatS = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
    const dS = await uploadDoc(srv.base, srv.tokens.a, Buffer.from(await flatS.save()), '나뉜 삭제.hwpx');
    const refS = 's0/p1';
    const textS = (await docOf(A, dS.id)).text(refS);
    const pS1 = await A(`/api/docs/${dS.id}/proposals`, { method: 'POST', body: { ref: refS, find: '문단입니다', replace: '단락입니다' } });
    const pS2 = await A(`/api/docs/${dS.id}/proposals`, { method: 'POST', body: { ref: refS, find: '입니다. 있던', replace: '바꾼 글' } });
    const apS = await ADM(`/api/docs/${dS.id}/proposals/${pS2.pid}/apply`, { method: 'POST' });   // 기준에 바로 적용은 관리자(allowDirectApply 기본 false)
    const chS = await A(`/api/docs/${dS.id}/changes`);
    const ids = (xs) => [...xs].map(Number).sort((a, b) => a - b);
    ok(apS.status === 'applied' && chS.filter((c) => c.type === 'Delete').length === 2 && eq(ids(apS.changeIds), ids(chS.map((c) => c.id))),
      `제안 #${pS2.pid} 적용: 삭제가 제안 #${pS1.pid} 메모 끝에서 둘로 나뉨 → changeIds 에 조각 모두(${apS.changeIds} / 변경 ${chS.map((c) => c.id)})`);
    const unS = await A(`/api/docs/${dS.id}/proposals/${pS2.pid}/undo`, { method: 'POST' });
    const docS = await docOf(A, dS.id);
    const leftS = await A(`/api/docs/${dS.id}/changes`);
    ok(unS.status === 'undone' && eq(leftS, []) && docS.text(refS) === textS, `되돌리기: 남은 변경 추적 없음(${leftS.map((c) => `${c.type} 「${c.text}」`).join(', ') || '0건'})·글 원래대로`);
    const pS1now = (await A(`/api/docs/${dS.id}/proposals`)).find((p) => p.pid === pS1.pid);
    ok(pS1now.status === 'pending' && docS.memos().some((m) => m.id === pS1now.memoId), `옆 제안 #${pS1.pid} 은 대기·메모 그대로`);
  }

  // ───────── 11e. 의견 스레드 = 덩어리 자리(hid 가 바뀌어도) ─────────
  // hid 는 새 글까지 넣어 셈한다(engine diffDocs) — 작성자가 같은 문단을 또 고칠 때마다 바뀐다. 서버(crs.js _rethread)가 스레드를
  // 같은 자리 덩어리에 다시 잇고 ref 도 덩어리 자리로 맞추는지, 덩어리가 없어지면 hid 없는 문단 의견으로 남기는지 본다.
  section('의견 스레드가 덩어리를 따라감: 같은 문단 세 번 더 저장·문단 끼우기·메모로 기준 바뀜·다시 맞추기(ref 밀림) → 한글로 저장·MCP 도 제 덩어리, 되돌리면 문단 의견');
  {
    const dT = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '스레드 자리.hwpx');
    const T = dT.id; const P = `/api/docs/${T}`; const TH = `${P}/change-requests`;
    // 홍길동 수정본: 편집기 자동 저장처럼 언제나 지금 기준 최종본에 같은 고침을 통째로 다시 얹는다(문단은 글로 찾는다 — 기준 ref 가 밀려도 같은 문단).
    // budget = 여섯째 문단(예산) 새 글(null 이면 되돌림), added = 일곱째 문단 뒤에 넣을 문단들, extra = 넷째 문단 뒤에 끼울 문단
    const at = (d, prefix) => { const i = d.bodyTexts()[0].findIndex((t) => t.startsWith(prefix)); if (i < 0) throw new Error(`「${prefix}」 문단이 없습니다`); return i; };
    const saveA = async ({ budget, added = [], extra = null }) => putDraft(A, T, await makeHead(A, T, (d) => {
      replaceIn(d, `s0/p${at(d, '넷째 문단')}`, '사업 개요를', '사업 개요(수정)를');
      if (budget) replaceIn(d, `s0/p${at(d, '여섯째 문단')}`, '1억 원', budget);
      let after = at(d, '일곱째 문단');
      for (const t of added) d.insertParagraphAfter(0, after++, t, ED);
      if (extra) d.insertParagraphAfter(0, at(d, '넷째 문단'), extra, ED);
    }));
    const hunkAt = (v, type, ref) => v.hunks.find((h) => h.type === type && (type === 'insert' ? h.afterRef === ref : h.ref === ref)) || null;
    const thr = (v, s) => v.threads.find((t) => t.comments[0].text.startsWith(s)) || {};
    const ADD1 = '덧붙인 문단: 성과 지표.'; const ADD2 = '덧붙인 문단: 성과 지표와 목표치.'; const ADD3 = '덧붙인 문단: 성과 지표와 목표치(연 2회).';
    let r = await saveA({ budget: '2억 원', added: [ADD1] });
    const cidT = r.cr.cid; const CRT = `${TH}/${cidT}`;
    ok(eq(r.cr.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['replace', 's0/p3'], ['replace', 's0/p5'], ['insert', 's0/p6']]), '홍길동 수정본: p3·p5 바꿈 + p6 뒤 문단 추가');
    await B(`${CRT}/threads`, { method: 'POST', body: { hid: hunkAt(r.cr, 'replace', 's0/p5').hid, quote: '예산', text: 'B1: 예산 근거는?' } });
    await B(`${CRT}/threads`, { method: 'POST', body: { hid: hunkAt(r.cr, 'insert', 's0/p6').hid, quote: '덧붙인', text: 'B2: 지표 출처는?' } });
    let v = await B(`${CRT}/threads`, { method: 'POST', body: { text: 'B4: 전체적으로 좋습니다' } });
    ok(thr(v, 'B1').ref === 's0/p5' && thr(v, 'B1').curRef === 's0/p5' && thr(v, 'B2').ref === 's0/p6' && thr(v, 'B4').hid === null && thr(v, 'B4').ref === null && thr(v, 'B4').curRef === null,
      '스레드 ref = 덩어리 자리(추가는 앞 문단), 보기에 curRef(지금 기준 자리) — 전체 의견은 둘 다 null');
    // 1) 같은 기준에서 같은 문단(예산)을 세 번 더 고쳐 저장 — 그때마다 p5 덩어리 hid 가 바뀐다
    const seen = [hunkAt(r.cr, 'replace', 's0/p5').hid];
    for (const [k, budget, add] of [[1, '2억 5천만 원', ADD2], [2, '2억 7천만 원', ADD2], [3, '3억 원', ADD3]]) {
      await saveA({ budget, added: [add] });
      v = await B(CRT);
      const h5 = hunkAt(v, 'replace', 's0/p5'); const h6 = hunkAt(v, 'insert', 's0/p6');
      ok(h5 && !seen.includes(h5.hid) && h5.newText.includes(budget) && thr(v, 'B1').hid === h5.hid && thr(v, 'B1').ref === 's0/p5'
        && h6?.newText === add && thr(v, 'B2').hid === h6.hid && thr(v, 'B2').ref === 's0/p6' && thr(v, 'B4').hid === null,
      `같은 기준 ${k}번째 다시 저장(예산 「${budget}」): p5 덩어리 hid 가 또 바뀌어도(${h5?.hid}) B1 은 그 덩어리, B2 는 추가 덩어리, B4 는 전체 의견 그대로`);
      seen.push(h5.hid);
    }
    // 2) 문단 끼우기: 넷째 문단 뒤에 하나, p6 뒤 덧붙인 문단 '앞'에 하나 — B2 는 자리 차례가 밀려도 덧붙인 문단(hid 그대로라 정확히)
    const ADDS = ['앞에 끼운 문단: 추진 체계.', ADD3]; const EXTRA = '개요 보충 문단.';
    await saveA({ budget: '3억 원', added: ADDS, extra: EXTRA });
    v = await B(CRT);
    let ins6 = v.hunks.filter((h) => h.type === 'insert' && h.afterRef === 's0/p6');
    ok(eq(v.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['replace', 's0/p3'], ['insert', 's0/p3'], ['replace', 's0/p5'], ['insert', 's0/p6'], ['insert', 's0/p6']])
      && ins6[1].newText === ADD3 && thr(v, 'B2').hid === ins6[1].hid && thr(v, 'B1').hid === hunkAt(v, 'replace', 's0/p5').hid,
    '문단을 끼워 넣음(p3 뒤·p6 뒤 덧붙인 문단 앞): B2 는 여전히 덧붙인 문단 덩어리(같은 자리 둘째), B1 은 p5');
    // 3) 메모만 더해 기준 버전이 바뀜(글 그대로) → 새 기준으로 저장(편집기가 조용히 기준을 올린 경우)
    const vT = await versionOf(A, T);
    await ADM(`${P}/memos`, { method: 'POST', body: { ref: 's0/p1', start: 0, end: 2, text: '관리자 메모' } });
    r = await saveA({ budget: '3억 2천만 원', added: ADDS, extra: EXTRA });
    v = await B(CRT);
    ins6 = v.hunks.filter((h) => h.type === 'insert' && h.afterRef === 's0/p6');
    ok(r.cr.baseVersion === vT + 1 && hunkAt(v, 'replace', 's0/p5')?.newText.includes('3억 2천만 원') && thr(v, 'B1').hid === hunkAt(v, 'replace', 's0/p5').hid && thr(v, 'B2').hid === ins6[1]?.hid,
      `기준이 메모로 바뀐 뒤(v${vT} → v${r.cr.baseVersion}) 새 기준으로 저장: B1·B2 그대로 제 덩어리`);
    // 4) 김검토가 위쪽(s0/p1 뒤)에 문단을 넣어 반영 → 홍길동 변경 요청은 1 뒤처짐(ref 가 한 칸씩 밀린 기준)
    await putDraft(B, T, await makeHead(B, T, (d) => d.insertParagraphAfter(0, 1, 'B 가 넣은 새 문단.', ED)));
    const crBT = (await B(`${P}/drafts/mine`)).cr;
    await B(`${TH}/${crBT.cid}/submit`, { method: 'POST', body: { title: 'B 문단 추가' } });
    await ADM(`${TH}/${crBT.cid}/merge`, { method: 'POST' });
    v = await B(CRT);
    const h5b = hunkAt(v, 'replace', 's0/p5');
    ok(v.behind === 1 && h5b?.curRef === 's0/p6' && thr(v, 'B1').curRef === 's0/p6' && thr(v, 'B1').ref === 's0/p5', '남의 반영 뒤(1 뒤처짐): p5 덩어리 curRef s0/p6, B1 의 curRef 도 s0/p6(ref 는 수정본 기준 s0/p5)');
    // 뒤처진 동안 다는 의견: 화면은 지금 기준 ref 를 보낸다 — 덩어리 의견은 덩어리 자리, 문단 의견은 수정본 기준 ref 로 옮겨 저장
    v = await B(`${CRT}/threads`, { method: 'POST', body: { hid: h5b.hid, ref: h5b.curRef, quote: '예산', text: 'B5: 단위도 적어 주세요' } });
    ok(thr(v, 'B5').hid === h5b.hid && thr(v, 'B5').ref === 's0/p5' && thr(v, 'B5').curRef === 's0/p6', '덩어리 의견(hid + 지금 ref s0/p6) → ref 는 덩어리 자리 s0/p5, curRef s0/p6');
    v = await B(`${CRT}/threads`, { method: 'POST', body: { ref: 's0/p8', quote: '맺음말', text: 'B3: 맺음말도 볼까요?' } });
    ok(thr(v, 'B3').hid === null && thr(v, 'B3').ref === 's0/p7' && thr(v, 'B3').curRef === 's0/p8', '문단 의견(hid 없음, 지금 ref s0/p8 = 여덟째 문단) → 수정본 기준 ref s0/p7 로 저장, curRef s0/p8');
    // MCP get_change_request 도 같은 기준: 스레드 ref = 수정본 기준 자리, curRef = 지금 기준 문서 자리(뒤처진 동안 둘이 다름).
    // 덩어리에서 먼 문단 의견(B6, 첫 문단)의 자리도 context 에 실림(* 없이)
    await B(`${CRT}/threads`, { method: 'POST', body: { ref: 's0/p0', quote: '첫째', text: 'B6: 첫 문단 표현도 맞춰 주세요' } });
    const gB = await mcp(srv.base, srv.tokens.b, 'get_change_request', { doc_id: T, cid: cidT });
    const gTh = (s) => (gB.json?.threads || []).find((t) => t.comments[0].text.startsWith(s)) || {};
    ok(!gB.isError && gTh('B3').hid === null && gTh('B3').ref === 's0/p7' && gTh('B3').curRef === 's0/p8' && gTh('B1').ref === 's0/p5' && gTh('B1').curRef === 's0/p6'
      && gTh('B6').ref === 's0/p0' && gTh('B6').curRef === 's0/p0' && /\n \[s0\/p0\] 첫째 문단/.test(gB.json.context) && !/\n\*\[s0\/p0\]/.test(gB.json.context),
    'MCP get_change_request(1 뒤처짐): 스레드 ref(수정본 기준 s0/p7·s0/p5)·curRef(지금 s0/p8·s0/p6) — 덩어리에서 먼 문단 의견 자리(s0/p0)도 context 에');
    // 5) 홍길동 다시 맞추기 → 덩어리 ref 가 한 칸씩 밀림 — 스레드 hid·ref 가 따라감
    const rbT = await A(`${P}/drafts/mine/rebase`, { method: 'POST' });
    v = await B(CRT);
    const h6 = hunkAt(v, 'replace', 's0/p6'); const ins7 = v.hunks.filter((h) => h.type === 'insert' && h.afterRef === 's0/p7');
    ok(rbT.conflicts.length === 0 && v.behind === 0 && h6?.newText.includes('3억 2천만 원') && ins7.length === 2 && ins7[1].newText === ADD3 && !!hunkAt(v, 'insert', 's0/p4'),
      '다시 맞추기: 충돌 없음, 덩어리가 한 칸씩 밀림(p4 바꿈·p4 뒤 추가·p6 바꿈·p7 뒤 추가 둘)');
    ok(thr(v, 'B1').hid === h6.hid && thr(v, 'B1').ref === 's0/p6' && thr(v, 'B5').hid === h6.hid && thr(v, 'B5').ref === 's0/p6'
      && thr(v, 'B2').hid === ins7[1].hid && thr(v, 'B2').ref === 's0/p7' && thr(v, 'B3').hid === null && thr(v, 'B3').ref === 's0/p8' && thr(v, 'B3').curRef === 's0/p8'
      && thr(v, 'B4').hid === null && thr(v, 'B4').ref === null,
    '다시 맞춘 뒤: B1·B5 → p6 덩어리(ref s0/p6), B2 → p7 뒤 덧붙인 문단(ref s0/p7), 문단 의견 B3 ref s0/p8, 전체 의견 B4 그대로');
    // 한글로 저장: 의견마다 제 문단 메모에
    let mm = [];
    const exportT = async () => { mm = (await HwpxDoc.load((await B.res(`${P}/file?kind=tracked&reviews=1`)).data)).memos().filter((m) => REVIEW_RE.test(m.text)); };
    const memoWith = (s) => mm.filter((m) => m.text.includes(s));
    await exportT();
    ok(memoWith('B1: 예산 근거는?').length === 1 && memoWith('B1: 예산 근거는?')[0].ref === 's0/p6' && memoWith('B1: 예산')[0].text.includes('B5: 단위도') && memoWith('B1: 예산')[0].text.includes('3억 2천만 원')
      && memoWith('B2: 지표 출처는?').length === 1 && memoWith('B2: 지표')[0].ref === 's0/p7' && memoWith('B2: 지표')[0].text.includes('이 문단 뒤에 문단 추가: 「덧붙인 문단')
      && memoWith('B3: 맺음말도').length === 1 && memoWith('B3: 맺음말도')[0].ref === 's0/p8' && memoWith('B3: 맺음말도')[0].text.includes('이 문단에 단 의견')
      && memoWith('B4: 전체적으로').length === 1 && memoWith('B4: 전체적으로')[0].ref === 's0/p4',
    `한글로 저장(다시 맞춘 뒤): B1·B5 → s0/p6 바꿈 메모, B2 → s0/p7 추가 메모, B3 → s0/p8 의견 메모, B4 → 첫 덩어리 메모(s0/p4) — ${mm.length}개`);
    // MCP get_change_request: 덩어리 스레드는 그 덩어리 hid(그 덩어리가 든 쪽), 문단 의견은 hid 없이 ref
    let gT = await mcp(srv.base, srv.tokens.b, 'get_change_request', { doc_id: T, cid: cidT });
    const gth = (s) => (gT.json?.threads || []).find((t) => t.comments[0].text.startsWith(s)) || {};
    ok(!gT.isError && gth('B1').hid === h6.hid && gth('B5').hid === h6.hid && gth('B2').hid === ins7[1].hid && gT.json.hunks.some((h) => h.hid === h6.hid) && gth('B3').hid === null && gth('B3').ref === 's0/p8',
      'MCP get_change_request: B1·B5·B2 는 제 덩어리 hid 로(덩어리와 같은 쪽), B3 는 hid 없이 ref s0/p8');
    // 6) 예산 문단을 되돌림 → 그 덩어리가 없어짐: B1·B5 는 hid 없는 문단 의견(ref·인용 그대로) — 남은 hid 없음
    await saveA({ budget: null, added: ADDS, extra: EXTRA });
    v = await B(CRT);
    ok(!hunkAt(v, 'replace', 's0/p6') && thr(v, 'B1').hid === null && thr(v, 'B1').ref === 's0/p6' && thr(v, 'B1').quote === '예산' && thr(v, 'B1').curRef === 's0/p6'
      && thr(v, 'B5').hid === null && thr(v, 'B5').ref === 's0/p6' && thr(v, 'B2').hid === ins7[1].hid && v.threads.every((t) => t.hid === null || v.hunks.some((h) => h.hid === t.hid)),
    '예산 문단 되돌림 → B1·B5 는 hid null, ref s0/p6·인용 「예산」 그대로(그 문단 의견), B2 는 그대로 — 남은 hid 없음');
    await exportT();
    ok(memoWith('B1: 예산 근거는?').length === 1 && memoWith('B1: 예산')[0].ref === 's0/p6' && memoWith('B1: 예산')[0].text.includes('이 문단에 단 의견') && memoWith('B1: 예산')[0].text.includes('B5: 단위도') && !memoWith('B1: 예산')[0].text.includes('→ 「'),
      '한글로 저장: 되돌린 문단의 의견은 그 문단(s0/p6)에 의견 메모로(첫 덩어리 메모로 가지 않음)');
    gT = await mcp(srv.base, srv.tokens.b, 'get_change_request', { doc_id: T, cid: cidT });
    ok(!gT.isError && gth('B1').hid === null && gth('B1').ref === 's0/p6' && gth('B1').quote === '예산', 'MCP get_change_request: 되돌린 문단 의견은 hid 없이 ref s0/p6·인용');
    // 7) 옛 자료에 남은 hid(지금 덩어리에 없음) → 다음 저장에서 정리(null)
    const metaT = path.join(srv.dataDir, 'docs', T, 'meta.json');
    const mt = JSON.parse(fs.readFileSync(metaT, 'utf-8'));
    mt.changeRequests.find((c) => c.cid === cidT).threads.find((t) => t.comments[0].text.startsWith('B4')).hid = 'hstale00000';
    fs.writeFileSync(metaT, JSON.stringify(mt, null, 1));
    await saveA({ budget: null, added: ADDS, extra: EXTRA });
    v = await B(CRT);
    ok(thr(v, 'B4').hid === null && thr(v, 'B4').ref === null && v.threads.every((t) => t.hid === null || v.hunks.some((h) => h.hid === t.hid)), '옛 자료의 남은 hid(hstale…) → 다음 저장에서 null(전체 의견)');
  }

  // ───────── 11f. 수정본 판(rev) ─────────
  section('수정본 판(rev): 같은 사람의 두 창 — ?rev= 가 낡으면 409 DRAFT_STALE(덮어쓰지 않음) · 저장·버리기·다시 맞추기·닫기·다시 열기·반영마다 +1 · rev 없으면 예전처럼');
  {
    const dR = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '판 시험.hwpx');
    const R = dR.id; const P = `/api/docs/${R}`;
    const putR = (C, head, rev) => C.res(`${P}/drafts/mine?base=${head.version}${rev == null ? '' : `&rev=${encodeURIComponent(rev)}`}`, { method: 'PUT', body: head.bytes });
    const headOf = (C, word) => makeHead(C, R, (d) => replaceIn(d, 's0/p3', '사업 개요를', `사업 개요(${word})를`));
    ok(eq(await A(`${P}/drafts/mine`), { cr: null, file: null, rev: 0 }), 'GET /drafts/mine(수정본 없음) → rev 0');
    let x = await putR(A, await headOf(A, '첫'), null);
    ok(x.status === 200 && x.data.rev === 1 && x.data.cr.rev === 1, 'rev 없이 PUT(예전 방식) → 저장, 판 1(응답 rev·cr.rev)');
    const m1 = await A(`${P}/drafts/mine`);
    ok(m1.rev === 1 && m1.cr.rev === 1 && (await A.res(`${P}/drafts/mine/file`)).headers.get('x-draft-rev') === '1', 'GET /drafts/mine → rev 1(cr.rev 도), /drafts/mine/file 머리글 X-Draft-Rev 1');
    // 창 1·창 2 가 판 1 을 읽음 → 창 1 저장(판 2) → 창 2 의 저장은 409(덮어쓰지 않음)
    const h1 = await headOf(A, '창1');
    x = await putR(A, h1, 1);
    ok(x.status === 200 && x.data.rev === 2, '창 1: ?rev=1 → 저장, 판 2');
    const stale = await putR(A, await headOf(A, '창2'), 1);
    ok(stale.status === 409 && stale.data.error === 'DRAFT_STALE' && stale.data.rev === 2 && !Number.isNaN(Date.parse(stale.data.updatedAt)), `창 2: 낡은 ?rev=1 → 409 DRAFT_STALE(rev 2, updatedAt ${stale.data.updatedAt})`);
    ok(Buffer.compare((await A.res(`${P}/drafts/mine/file`)).data, h1.bytes) === 0 && (await A(`${P}/drafts/mine`)).cr.hunks[0].newText.includes('창1'), '수정본은 창 1 것 그대로');
    // '수정본 없음'(판 0)을 읽은 창이 바뀐 것 없는 글을 저장해도 다른 창의 수정본을 지우지 않는다(rev 없이는 지웠을 것)
    const blank = await putR(A, await makeHead(A, R, () => {}), 0);
    ok(blank.status === 409 && blank.data.error === 'DRAFT_STALE' && (await A(`${P}/drafts/mine`)).cr?.rev === 2, '판 0 을 읽은 창이 빈 수정본 저장 → 409(다른 창 수정본을 지우지 않음)');
    const bad = await Promise.all(['abc', '-1', '1.5'].map((rv) => putR(A, h1, rv)));
    ok(bad.every((b) => b.status === 400 && b.data.error === 'BAD_REV'), '?rev=abc·-1·1.5 → 400 BAD_REV');
    ok((await B(`${P}/drafts/mine`)).rev === 0, '판은 사람마다(김검토는 0)');
    // 버리기 → 판 3. 옛 판으로는 저장 못 함, 판 3 으로 새로 만들면 판 4(0 으로 돌아가지 않음 — 옛 창의 판과 겹치지 않게)
    const dsc = await A(`${P}/drafts/mine`, { method: 'DELETE' });
    ok(dsc.rev === 3 && eq(await A(`${P}/drafts/mine`), { cr: null, file: null, rev: 3 }), '버리기 → 판 3(수정본 없음)');
    ok((await putR(A, await headOf(A, '옛창'), 2)).data.error === 'DRAFT_STALE', '버린 뒤 옛 판(2)으로 저장 → 409(버린 수정본을 되살리지 않음)');
    x = await putR(A, await headOf(A, '새로'), 3);
    ok(x.status === 200 && x.data.rev === 4 && x.data.cr.rev === 4, '판 3 으로 새 수정본 → 판 4(새 변경 요청도 이어서 셈)');
    // 다시 맞추기 → 판 +1(수정본 파일이 바뀜)
    await ADM(`${P}/memos`, { method: 'POST', body: { ref: 's0/p1', start: 0, end: 2, text: '기준을 올리는 메모' } });
    const rbR = await A(`${P}/drafts/mine/rebase`, { method: 'POST' });
    ok(rbR.rev === 5 && rbR.cr.rev === 5 && (await A.res(`${P}/drafts/mine/file`)).headers.get('x-draft-rev') === '5', '다시 맞추기 → 판 5(응답·cr.rev·X-Draft-Rev)');
    ok((await putR(A, await headOf(A, '옛창'), 4)).data.error === 'DRAFT_STALE', '다시 맞추기 전 판(4)으로 저장 → 409');
    // 검토 요청(제출)은 판 그대로, 닫기·다시 열기는 +1
    const cidR = rbR.cr.cid;
    await A(`${P}/change-requests/${cidR}/submit`, { method: 'POST', body: { title: '판 시험' } });
    ok((await A(`${P}/drafts/mine`)).rev === 5, '검토 요청은 판 그대로(5)');
    await A(`${P}/change-requests/${cidR}/close`, { method: 'POST' });
    ok((await A(`${P}/drafts/mine`)).rev === 6, '닫기 → 판 6');
    const ro = await A(`${P}/change-requests/${cidR}/reopen`, { method: 'POST' });
    ok(ro.rev === 7 && (await A(`${P}/drafts/mine`)).rev === 7, '다시 열기 → 판 7(cr.rev)');
    // 반영 → 판 +1: 반영 전 판의 옛 창이 반영된 글로 새 수정본을 만들지 못함
    const hm = await headOf(A, '반영할');
    x = await putR(A, hm, 7);
    ok(x.status === 200 && x.data.rev === 8, '다시 연 수정본 저장 → 판 8');
    await A(`${P}/change-requests/${cidR}/submit`, { method: 'POST', body: { title: '판 시험' } });
    await B(`${P}/change-requests/${cidR}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    await A(`${P}/change-requests/${cidR}/merge`, { method: 'POST' });
    ok(eq(await A(`${P}/drafts/mine`), { cr: null, file: null, rev: 9 }), '반영 → 판 9(수정본 없음)');
    const afterMerge = await putR(A, hm, 8);
    ok(afterMerge.status === 409 && afterMerge.data.error === 'DRAFT_STALE' && afterMerge.data.rev === 9 && !(await A(`${P}/change-requests`)).some((c) => c.status === 'draft'),
      '반영 전 판(8)의 옛 창 저장 → 409(반영된 글로 새 수정본을 만들지 않음)');
  }

  // ───────── 11g. 제안 '기준에 바로 적용' 권한 ─────────
  section("'기준에 바로 적용' 권한(allowDirectApply 기본 false): 편집자 REST apply·applyNow·편집본 올리기(PUT /upload, live 포함) 403 · 관리자 됨 · 편집자의 에이전트(MCP apply_proposal)도 403");
  {
    ok((await (await fetch(`${srv.base}/api/config`)).json()).allowDirectApply === false, '/api/config allowDirectApply false(시험 config 에 changeRequests 구역 있음 → 기본 false)');
    const dA = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '바로 적용.hwpx');
    const P = `/api/docs/${dA.id}/proposals`;
    const pA = await A(P, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을' } });
    const v0 = await versionOf(A, dA.id);
    const ap = await A.res(`${P}/${pA.pid}/apply`, { method: 'POST' });
    ok(ap.status === 403 && ap.data.error === 'DIRECT_APPLY_FORBIDDEN' && (await A(P)).find((p) => p.pid === pA.pid).status === 'pending' && await versionOf(A, dA.id) === v0,
      `편집자 REST apply → 403 ${ap.data.error}(제안 대기·버전 그대로)`);
    const nProps = (await A(P)).length;
    const an = await A.res(P, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터', applyNow: true } });
    ok(an.status === 403 && an.data.error === 'DIRECT_APPLY_FORBIDDEN' && (await A(P)).length === nProps, '편집자 POST /proposals applyNow(직접 고쳐 쓰기) → 403, 제안도 안 생김');
    const apAdm = await ADM(`${P}/${pA.pid}/apply`, { method: 'POST' });
    const anAdm = await ADM(P, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터', applyNow: true } });
    ok(apAdm.status === 'applied' && anAdm.status === 'applied', '관리자 apply·applyNow → 적용');
    // 에이전트는 사용자 권한을 넘지 못한다: 편집자의 에이전트 MCP apply_proposal 도 같은 문(관리자의 에이전트는 allowAgentApply 규칙대로 됨)
    const pB = await A(P, { method: 'POST', body: { ref: 's0/p5', find: '1억 원', replace: '1억 5천만 원' } });
    const vB = await versionOf(A, dA.id);
    const mcpAp = await mcp(srv.base, srv.tokens.a, 'apply_proposal', { doc_id: dA.id, proposal_id: pB.pid });
    ok(pB.status === 'pending' && mcpAp.isError && /DIRECT_APPLY_FORBIDDEN/.test(mcpAp.text) && (await A(P)).find((p) => p.pid === pB.pid).status === 'pending' && await versionOf(A, dA.id) === vB,
      `편집자 제안 만들기(applyNow 없이)는 됨 · 그 에이전트의 MCP apply_proposal → ${mcpAp.text.slice(0, 40)}…(제안 대기·버전 그대로)`);
    const mcpAdm = await mcp(srv.base, srv.tokens.admin, 'apply_proposal', { doc_id: dA.id, proposal_id: pB.pid });
    ok(!mcpAdm.isError && mcpAdm.json.status === 'applied', '관리자의 에이전트 MCP apply_proposal → 적용(allowAgentApply)');
    // 편집본 올리기(v0.2 PUT /upload — 기준 문서를 바로 고쳐 새 버전): 편집자 403(live=1 도), 관리자 됨
    const up = async (C, live) => {
      const { doc, version } = await working(C, dA.id);
      const w = await doc.clone(); replaceIn(w, 's0/p7', '맺음말', '맺음말(올림)');
      return C.res(`/api/docs/${dA.id}/upload?base=${version}${live ? '&live=1' : ''}`, { method: 'PUT', body: Buffer.from(await w.save()) });
    };
    const vU = await versionOf(A, dA.id);
    const upA = await up(A, false); const upAl = await up(A, true);
    ok(upA.status === 403 && upA.data.error === 'DIRECT_APPLY_FORBIDDEN' && upAl.status === 403 && upAl.data.error === 'DIRECT_APPLY_FORBIDDEN'
      && await versionOf(A, dA.id) === vU && !(await docOf(A, dA.id)).text('s0/p7').includes('(올림)'), `편집자 PUT /upload·?live=1 → 403 ${upA.data.error}(버전·글 그대로)`);
    const upAdm = await up(ADM, false);
    ok(upAdm.status === 200 && upAdm.data.version === vU + 1 && (await docOf(A, dA.id)).text('s0/p7').includes('맺음말(올림)'), `관리자 PUT /upload → 200(v${upAdm.data.version}, 기준 문서 직접 갱신)`);
  }

  // ───────── 11h. 승인은 승인한 내용에만 ─────────
  section('승인은 승인한 내용에만: 승인 뒤 수정본을 바꾸면 그 승인은 세지 않음(staleApprovals) → 반영 403 · 다시 승인하면 됨 · 같은 내용 다시 저장·번호만 밀린 다시 맞추기는 그대로 · 합쳐진 글이 되면 다시');
  {
    const dH = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '승인 묶기.hwpx');
    const H = dH.id; const P = `/api/docs/${H}`; const CRS = `${P}/change-requests`;
    const head1 = await makeHead(A, H, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 목적을'));
    const cH = (await putDraft(A, H, head1)).cr;
    await A(`${CRS}/${cH.cid}/submit`, { method: 'POST', body: { title: '개요 보강' } });
    let vH = await B(`${CRS}/${cH.cid}/reviews`, { method: 'POST', body: { verdict: 'approve', body: '좋습니다' } });
    ok(vH.approvals === 1 && vH.staleApprovals === 0 && (await A(`${CRS}/${cH.cid}`)).canMerge === true, '김검토 승인 → approvals 1(staleApprovals 0), 홍길동 canMerge');
    await putDraft(A, H, head1);
    ok((await A(`${CRS}/${cH.cid}`)).approvals === 1, '같은 수정본 다시 저장(자동 저장) → 승인 그대로');
    // 메모만 더해 기준 버전이 오른 뒤 같은 고침을 새 기준으로 저장(편집기가 조용히 기준을 올린 경우) → 승인 그대로
    await ADM(`${P}/memos`, { method: 'POST', body: { ref: 's0/p1', start: 0, end: 2, text: '기준만 올리는 메모' } });
    const re1 = (await putDraft(A, H, await makeHead(A, H, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 목적을')))).cr;
    ok(re1.baseVersion === head1.version + 1 && re1.approvals === 1 && re1.staleApprovals === 0, `메모로 기준만 오른 뒤(v${head1.version} → v${re1.baseVersion}) 같은 고침을 새 기준으로 저장 → 승인 그대로`);
    // 승인 뒤에 다른 문단을 더 고쳐 저장 → 그 승인은 낡음(승인한 내용이 아님)
    const head2 = await makeHead(A, H, (d) => { replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 목적을'); replaceIn(d, 's0/p7', '맺음말', '승인 뒤에 몰래 넣은 글: 예산 10억 원'); });
    const after2 = (await putDraft(A, H, head2)).cr;
    vH = await A(`${CRS}/${cH.cid}`);
    const blk = vH.mergeBlockers.find((b) => b.code === 'NEED_APPROVAL');
    const apr = vH.reviews.find((r) => r.verdict === 'approve');
    ok(after2.approvals === 0 && vH.approvals === 0 && vH.staleApprovals === 1 && apr?.stale?.by === nameA && !Number.isNaN(Date.parse(apr.stale.at)) && vH.canMerge === false && /다시 승인/.test(blk?.message || ''),
      `승인 뒤 수정본을 바꿈 → 승인 0, 낡은 승인 1(stale { by ${apr?.stale?.by} }) — 「${blk?.message}」`);
    const mH = await A.res(`${CRS}/${cH.cid}/merge`, { method: 'POST' });
    ok(mH.status === 403 && mH.data.error === 'NEED_APPROVAL' && mH.data.staleApprovals === 1 && !(await docOf(A, H)).text('s0/p7').includes('몰래'), '작성자 반영 → 403 NEED_APPROVAL(staleApprovals 1), 기준 문서 그대로');
    const gH = await mcp(srv.base, srv.tokens.b, 'get_change_request', { doc_id: H, cid: cH.cid });
    ok(!gH.isError && gH.json.approvals === 0 && gH.json.reviews.some((r) => r.verdict === 'approve' && r.stale === true), 'MCP get_change_request: approvals 0, 그 승인은 stale');
    vH = await B(`${CRS}/${cH.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    ok(vH.approvals === 1 && vH.staleApprovals === 0, '김검토가 바뀐 내용을 다시 승인 → approvals 1');
    const mH2 = await A(`${CRS}/${cH.cid}/merge`, { method: 'POST' });
    ok(mH2.cr.status === 'merged' && (await docOf(A, H)).text('s0/p7').includes('몰래'), '다시 승인받은 내용으로 반영');
    // 다시 맞추기: 번호만 밀린 같은 고침은 승인 그대로, 같은 문단을 남이 고쳐 글이 합쳐지면(3-way — 반영될 글이 바뀜) 다시
    const c3 = (await putDraft(A, H, await makeHead(A, H, (d) => replaceIn(d, 's0/p5', '1억 원', '1억 2천만 원')))).cr;
    await A(`${CRS}/${c3.cid}/submit`, { method: 'POST', body: { title: '예산' } });
    await B(`${CRS}/${c3.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const mergeB = async (edit, title) => {
      const cb = (await putDraft(B, H, await makeHead(B, H, edit))).cr;
      await B(`${CRS}/${cb.cid}/submit`, { method: 'POST', body: { title } });
      return ADM(`${CRS}/${cb.cid}/merge`, { method: 'POST' });
    };
    await mergeB((d) => d.insertParagraphAfter(0, 0, '김검토가 넣은 머리 문단', ED), '머리 문단');
    const rb1 = await A(`${P}/drafts/mine/rebase`, { method: 'POST' });
    ok(rb1.conflicts.length === 0 && rb1.cr.hunks[0].ref === 's0/p6' && rb1.cr.approvals === 1 && rb1.cr.staleApprovals === 0, '번호만 밀린 다시 맞추기(s0/p5 → s0/p6) → 승인 그대로(1)');
    await mergeB((d) => replaceIn(d, 's0/p6', '예산은', '총예산은'), '예산 표현');
    const rb2 = await A(`${P}/drafts/mine/rebase`, { method: 'POST' });
    ok(rb2.conflicts.length === 0 && rb2.cr.hunks[0].newText === '여섯째 문단: 총예산은 총 1억 2천만 원입니다.' && rb2.cr.approvals === 0 && rb2.cr.staleApprovals === 1,
      `같은 문단을 남이 고친 뒤 다시 맞춤 → 합쳐진 글(「${rb2.cr.hunks[0].newText}」) — 승인 낡음(다시 승인 필요)`);
  }

  // ───────── 11i. 변경 요청으로 적용된 제안 복구 — 같은 문단의 작성자 다른 고침은 남음 ─────────
  section('변경 요청 반영으로 적용된 제안의 변경(changeIds)은 제안 자리 것만 — 제안을 복구해도 같은 문단의 작성자 다른 고침은 남음');
  {
    const dI = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '제안 복구.hwpx');
    const I = dI.id; const P = `/api/docs/${I}`;
    const pI = await B(`${P}/proposals`, { method: 'POST', body: { ref: 's0/p5', find: '1억', replace: '2억' } });
    await A(`${P}/proposals/${pI.pid}/adopt`, { method: 'POST', body: {} });
    const cI = (await putDraft(A, I, await makeHead(A, I, (d) => replaceIn(d, 's0/p5', '여섯째 문단: 예산은 총 1억', '6번째 문단: 예산은 총 2억')))).cr;
    await A(`${P}/change-requests/${cI.cid}/submit`, { method: 'POST', body: { title: '예산' } });
    await B(`${P}/change-requests/${cI.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const mI = await A(`${P}/change-requests/${cI.cid}/merge`, { method: 'POST' });
    const pAfter = (await A(`${P}/proposals`)).find((p) => p.pid === pI.pid);
    const chI = (await A(`${P}/changes`)).filter((c) => c.ref === 's0/p5');
    const idsI = new Set(pAfter.changeIds);
    const kinds = (list) => list.map((c) => `${c.type}:${c.text}`).sort();
    ok(eq(mI.report.adopted.applied, [pI.pid]) && pAfter.status === 'applied' && eq(pAfter.via, { cid: cI.cid })
      && eq(kinds(chI.filter((c) => idsI.has(c.id))), ['Delete:1', 'Insert:2']) && eq(kinds(chI.filter((c) => !idsI.has(c.id))), ['Delete:여섯', 'Insert:6번']),
    `반영 → 제안 #${pI.pid} applied, changeIds ${pAfter.changeIds} = 제안 자리(「1」→「2」)만 — 같은 문단의 작성자 고침(「여섯」→「6번」)은 빠짐`);
    const un = await A(`${P}/proposals/${pI.pid}/undo`, { method: 'POST' });
    const tI = (await docOf(A, I)).text('s0/p5');
    ok(un.status === 'undone' && tI === '6번째 문단: 예산은 총 1억 원입니다.', `제안 복구 → 「${tI}」(작성자 고침 「6번째」는 남음)`);
  }

  // ───────── 11j. 같은 제안을 두 사람이 각자 수정본에 반영 ─────────
  section('같은 제안을 두 사람이 각자 수정본에 반영: 사람마다 기록(adoptedBy) — 남이 반영하거나 버려도 내 기록은 남음');
  {
    const dJ = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '두 사람 반영.hwpx');
    const J = dJ.id; const P = `/api/docs/${J}`;
    const pJ = await ADM(`${P}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을' } });
    const propJ = async () => (await A(`${P}/proposals`)).find((p) => p.pid === pJ.pid);
    const adoptEdit = (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 목적을');
    const cJ = (await putDraft(A, J, await makeHead(A, J, adoptEdit))).cr;
    await A(`${P}/proposals/${pJ.pid}/adopt`, { method: 'POST', body: {} });
    const adB = await B(`${P}/proposals/${pJ.pid}/adopt`, { method: 'POST', body: {} });
    let pj = await propJ();
    ok(adB.proposal.adopted.by === nameB && pj.adoptedBy?.[nameA]?.cid === cJ.cid && pj.adoptedBy?.[nameB]?.cid === null && pj.adopted.by === nameB && pj.adopted.cid === null,
      `두 사람이 반영 → adoptedBy { ${nameA}: 변경 요청 #${cJ.cid}, ${nameB}: (변경 요청 아직 없음) } · adopted(예전 모양) = 방금 반영한 ${nameB}`);
    const cJB = (await putDraft(B, J, await makeHead(B, J, adoptEdit))).cr;
    pj = await propJ();
    ok(eq(cJB.adopted, [pJ.pid]) && pj.adoptedBy[nameB].cid === cJB.cid && pj.adoptedBy[nameA].cid === cJ.cid, `김검토 수정본 저장 → 김검토 기록만 그 변경 요청(#${cJB.cid})에 묶임, 홍길동 기록 그대로`);
    await B(`${P}/drafts/mine`, { method: 'DELETE' });
    pj = await propJ();
    ok(pj.status === 'pending' && !pj.adoptedBy?.[nameB] && pj.adoptedBy?.[nameA]?.cid === cJ.cid && pj.adopted?.by === nameA && pj.adopted.cid === cJ.cid,
      '김검토가 수정을 버림 → 김검토 기록만 지움, 홍길동 기록은 남고 adopted 도 홍길동');
    await A(`${P}/change-requests/${cJ.cid}/submit`, { method: 'POST', body: { title: '개요' } });
    await B(`${P}/change-requests/${cJ.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const mJ = await A(`${P}/change-requests/${cJ.cid}/merge`, { method: 'POST' });
    pj = await propJ();
    ok(eq(mJ.report.adopted.applied, [pJ.pid]) && pj.status === 'applied' && !('adopted' in pj) && !('adoptedBy' in pj), '홍길동 반영 → 제안 applied, 반영 기록(adopted·adoptedBy) 끝');
  }

  // ───────── 11k. 반영하는 동안 읽어도 커밋된 상태만 ─────────
  section('반영(merge)이 문서를 저장하는 동안 읽은 문단·문서 정보는 커밋된 상태만 — 옛 버전 번호에 반영 중인 글이 섞이지 않음');
  {
    // 서비스 단독(같은 프로세스): _tx 가 캐시의 메모리 문서를 고친 채 기다리는(저장 중인) 동안 읽기 경로는 그 _tx 를 기다린다.
    // 큐 밖에서 캐시 문서를 바로 읽으면(예전 길) 커밋 안 된 글이 보인다 — 이 시험이 그 틈을 실제로 만드는지도 함께 본다
    const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-read-'));
    try {
      const svc = new Service({ store: new Store(tmpR), hub: { broadcast() {}, broadcastAll() {} }, config: {}, ai: null });
      const rid = svc.store.create({ fileName: '읽기.hwpx', bytes: await buildMainDoc(), by: '시험' }).id;
      const want = '넷째 문단: 사업 개요를 적습니다.';
      let open; const gate = new Promise((r) => { open = r; });
      let entered; const inTx = new Promise((r) => { entered = r; });
      const tx = svc._tx(rid, async () => {
        const { doc } = await svc._load(rid);
        doc.mergeParagraphText('s0/p3', '커밋 안 된 글', { author: '시험' });
        entered(); await gate;                 // 저장(doc.save)을 기다리는 동안처럼
        throw new Error('실패한 _tx');          // 커밋하지 않는다 → _tx 가 메모리 문서를 버림
      }).then(() => 'committed', () => 'failed');
      await inTx;
      const reads = Promise.all([svc.paragraphs(rid), svc.getDocument(rid), svc.memos(rid, null), svc.changes(rid), svc.search(rid, '커밋 안 된'), svc.readText(rid)]);
      const raw = (await svc.store.doc(rid)).text('s0/p3');   // 큐 밖에서 캐시 문서를 바로(예전 길)
      open();
      const [paras, info, memosR, changesR, found, text] = await reads;
      ok(raw === '커밋 안 된 글' && await tx === 'failed' && paras.find((p) => p.ref === 's0/p3')?.text === want && info.version === 1 && info.changes === 0
        && changesR.length === 0 && memosR.length === 1 && found.length === 0 && text.text.includes(want),
      '서비스 읽기(문단·문서 정보·메모·변경 추적·찾기·읽기)는 진행 중인 _tx 를 기다려 커밋된 글만 — 큐 밖 캐시 문서는 그 사이 「커밋 안 된 글」(틈이 실제로 있음)');
    } finally { try { fs.rmSync(tmpR, { recursive: true, force: true }); } catch { /* ignore */ } }
    const dK = await uploadDoc(srv.base, srv.tokens.admin, await buildLongDoc(400, 400, 2000), '반영 중 읽기.hwpx');
    const K = dK.id; const P = `/api/docs/${K}`; const target = 's0/p10'; const MARK = '[B 고침]';
    const cK = (await putDraft(B, K, await makeHead(B, K, (d) => d.mergeParagraphText(target, `${d.text(target)} ${MARK}`, ED)))).cr;
    await B(`${P}/change-requests/${cK.cid}/submit`, { method: 'POST', body: { title: 'B 고침' } });
    const V0 = await versionOf(A, K);
    let stop = false; let polls = 0; let tainted = 0; let during = 0;
    const poll = async () => {
      while (!stop) {
        const v1 = (await A(P)).version;
        const ps = await A(`${P}/paragraphs?view=final`);
        const v2 = (await A(P)).version;
        polls++; if (v1 === V0 && v2 === V0) during++;
        if (v1 === V0 && v2 === V0 && (ps.find((p) => p.ref === target)?.text || '').endsWith(MARK)) tainted++;
      }
    };
    const pollers = [poll(), poll(), poll()];
    await new Promise((r) => setTimeout(r, 150));
    const mK = await ADM(`${P}/change-requests/${cK.cid}/merge`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 150)); stop = true; await Promise.all(pollers);
    ok(mK.version === V0 + 1 && during > 0 && tainted === 0 && (await A(`${P}/paragraphs`)).find((p) => p.ref === target).text.endsWith(MARK),
      `반영(v${V0} → v${mK.version}) 앞뒤로 읽기 ${polls}번(옛 버전 ${during}번) — 옛 버전 번호에 반영 중인 글이 섞인 것 ${tainted}번`);
  }

  // ───────── 11l. 긴 문단을 통째로 바꾼 수정본 — 글자 차이 상한 ─────────
  section('긴 문단(12,000자)을 통째로 바꾼 수정본 저장이 서버를 멈추지 않음 — 글자 차이 상한(앞뒤 같은 부분을 뺀 가운데를 한 번에 바꿈)');
  {
    const rnd = (n) => { const b = crypto.randomBytes(n * 2); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0xac00 + (b.readUInt16LE(i * 2) % 2000)); return s; };
    const applyCp = (a, ops) => { const cp = Array.from(a); let out = ''; let pos = 0; for (const o of ops) { out += cp.slice(pos, o.start).join('') + o.text; pos = o.end; } return out + cp.slice(pos).join(''); };
    const a20 = `머리 ${rnd(20000)} 꼬리`; const b20 = `머리 ${rnd(20000)}😀 꼬리`;
    let t0 = performance.now(); const ops20 = charOps(a20, b20); const tOps = performance.now() - t0;
    ok(tOps < 1000 && ops20.length === 1 && ops20[0].start === 3 && applyCp(a20, ops20) === b20, `엔진 charOps: 서로 다른 2만 자 두 글 ${Math.round(tOps)}ms(1초 안) — 편집 하나(앞뒤 같은 부분 뺌), 적용하면 새 글`);
    // 글자 수는 같고 차례만 다른 두 글(아래 한계로 못 거름 → diff 가 상한까지 돌고 그만둠)
    const ab = Array.from({ length: 20000 }, () => 'abcd'[crypto.randomInt(4)]); const p20 = ab.join(''); const q20 = [...ab].sort(() => crypto.randomInt(3) - 1).join('');
    t0 = performance.now(); const opsP = charOps(p20, q20); const tP = performance.now() - t0;
    ok(tP < 1000 && applyCp(p20, opsP) === q20, `엔진 charOps: 글자 수가 같은 2만 자(차례만 다름) ${Math.round(tP)}ms(1초 안), 적용하면 새 글`);
    t0 = performance.now(); const m3 = merge3(a20, b20, `${a20}!`); const tM3 = performance.now() - t0;
    ok(tM3 < 1000 && m3.ok && m3.text === `${b20}!`, `엔진 merge3: 2만 자 ${Math.round(tM3)}ms, 겹치지 않는 편집은 합침`);
    const L1 = Array.from({ length: 3000 }, () => rnd(30)); const L2 = Array.from({ length: 3000 }, () => rnd(30));
    t0 = performance.now(); const pb = planBody(L1, L2); const tPb = performance.now() - t0;
    ok(tPb < 1000 && pb.pairs.length === 3000, `엔진 planBody: 서로 다른 문단 3000개 두 목록 ${Math.round(tPb)}ms`);
    // 서버: 12,000자 문단을 무작위 글로 바꾼 수정본 PUT — 그 사이 다른 요청(/api/config)도 곧바로 답함
    const dL = await uploadDoc(srv.base, srv.tokens.admin, await buildLongDoc(3, 200, 12000), '긴 문단.hwpx');
    const headL = await makeHead(A, dL.id, (d) => d.mergeParagraphText('s0/p6', rnd(12000), ED));
    t0 = performance.now();
    const putL = putDraft(A, dL.id, headL);
    await new Promise((r) => setTimeout(r, 50));   // 서버가 PUT 을 처리하는 중에(예전에는 40초 넘게 멈췄다)
    const c0 = performance.now(); const conf = await fetch(`${srv.base}/api/config`); await conf.json(); const tConf = performance.now() - c0;
    const crL = (await putL).cr; const tPut = performance.now() - t0;
    ok(crL.hunks.length === 1 && crL.hunks[0].type === 'replace' && crL.hunks[0].ref === 's0/p6' && crL.stats.chars > 12000 && tPut < 10000 && conf.ok && tConf < 3000,
      `긴 문단 통째 바꿈 PUT /drafts/mine ${Math.round(tPut)}ms · 그 사이 GET /api/config ${Math.round(tConf)}ms(서버가 멈추지 않음)`);
  }

  // ───────── 12. 옛 meta(새 필드 없음) ─────────
  section('옛 meta.json(changeRequests·memoThreads·seq.cr 없음)도 읽힘');
  const d3 = await uploadDoc(srv.base, srv.tokens.a, FX, '옛 문서.hwpx');
  const metaFile = path.join(srv.dataDir, 'docs', d3.id, 'meta.json');
  const old = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  delete old.changeRequests; delete old.memoThreads; delete old.seq.cr;
  fs.writeFileSync(metaFile, JSON.stringify(old, null, 1));
  ok(eq(await A(`/api/docs/${d3.id}/drafts/mine`), { cr: null, file: null, rev: 0 }) && eq(await A(`/api/docs/${d3.id}/change-requests`), []), '/drafts/mine(판 0)·/change-requests → 비어 있음');
  const oldMemos = await A(`/api/docs/${d3.id}/memos`);
  ok(oldMemos.length === 1 && oldMemos[0].key === 's0:f900000001' && eq(oldMemos[0].thread, { replies: [], resolved: null }), '메모 목록에 key·빈 스레드');
  const crOld = (await putDraft(A, d3.id, await makeHead(A, d3.id, (d) => replaceIn(d, 's0/p0', '여기 있습니다', '여기에 있습니다')))).cr;
  const oldNow = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  ok(crOld.cid === 1 && eq(crOld.hunks.map((h) => [h.type, h.ref]), [['replace', 's0/p0']]) && oldNow.seq.cr === 1 && oldNow.changeRequests.length === 1, '수정본 저장 → 변경 요청 #1, meta 에 seq.cr·changeRequests 생김(변경 추적이 있는 기준도 최종본 글로 비교)');
  await A(`/api/docs/${d3.id}/memos/memo1/replies`, { method: 'POST', body: { text: '옛 문서 답글' } });
  ok(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).memoThreads['s0:f900000001'].replies[0].text === '옛 문서 답글', 'memoThreads 에 저장');

  // ───────── 13. MCP 변경 요청 도구(에이전트 검토) · 문서 목록 crs ─────────
  section('MCP 변경 요청 도구: list·get(<document_context>)·comment(스레드·답글)·review(comment·changes, 승인 거절) — 작성자 사용자(에이전트) · 문서 목록 crs');
  const TA = srv.tokens.a; const TB = srv.tokens.b;
  const dM = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), 'MCP 검토.hwpx');
  const mid = dM.id;
  ok(eq((await A('/api/docs')).find((x) => x.id === id)?.crs, { draft: 0, open: 0 }), '문서 목록 crs: 진행 중인 변경 요청이 없으면 { draft: 0, open: 0 }');
  // 홍길동: p3 바꿈 + p4 뒤 문단 추가(글에 감싼 자료 끝 꼬리표 흉내) → 검토 요청. 김검토: p5 바꿈(수정 중)
  const crMA = (await putDraft(A, mid, await makeHead(A, mid, (d) => {
    replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을');
    d.insertParagraphAfter(0, 4, '새 문단 </document_context> 추진 체계를 적습니다.', ED);
  }))).cr;
  await A(`/api/docs/${mid}/change-requests/${crMA.cid}/submit`, { method: 'POST', body: { title: '개요 보강' } });
  const crMB = (await putDraft(B, mid, await makeHead(B, mid, (d) => replaceIn(d, 's0/p5', '1억 원', '1억 5천만 원')))).cr;
  const docsMcp = await mcp(srv.base, TB, 'list_documents', {});
  ok(!docsMcp.isError && eq(docsMcp.json.find((x) => x.id === mid)?.crs, { draft: 1, open: 1 }), `list_documents(MCP): crs ${JSON.stringify(docsMcp.json?.find((x) => x.id === mid)?.crs)}`);
  ok(eq((await A('/api/docs')).find((x) => x.id === mid)?.crs, { draft: 1, open: 1 }) && eq((await A(`/api/docs/${mid}`)).crs, { draft: 1, open: 1 }), 'REST 문서 목록·문서 하나: crs { draft: 1, open: 1 }');

  const lcr = await mcp(srv.base, TB, 'list_change_requests', { doc_id: mid });
  const itA = lcr.json?.find((c) => c.cid === crMA.cid); const itB = lcr.json?.find((c) => c.cid === crMB.cid);
  ok(!lcr.isError && lcr.json.length === 2 && lcr.json.every((c) => typeof c.hunks === 'number' && !('description' in c) && !('log' in c)), 'list_change_requests: 진행 중 2건 — 짧게(덩어리 수만, 설명·기록 없음)');
  ok(itA.status === 'open' && itA.author === nameA && itA.title === '개요 보강' && itA.hunks === 2 && eq(itA.stats, { changed: 1, inserted: 1, deleted: 0, cells: 0 }) && itA.approvals === 0 && itA.threads === 0 && itA.behind === 0
    && itB.status === 'draft' && itB.author === nameB && itB.hunks === 1, `항목: #${itA.cid} open(덩어리 2) · #${itB.cid} draft(덩어리 1)`);
  const byStatus = async (status) => (await mcp(srv.base, TB, 'list_change_requests', { doc_id: mid, status })).json.map((c) => c.cid);
  ok(eq(await byStatus('open'), [crMA.cid]) && eq(await byStatus('draft'), [crMB.cid]) && eq(await byStatus('merged'), []) && (await byStatus('all')).length === 2, 'status 거르기(open·draft·merged·all)');

  const g = await mcp(srv.base, TB, 'get_change_request', { doc_id: mid, cid: crMA.cid });
  const gh = g.json?.hunks || [];
  ok(!g.isError && gh.length === 2 && gh[0].type === 'replace' && gh[0].ref === 's0/p3' && gh[0].curRef === 's0/p3' && gh[0].state === 'ok' && /^h[0-9a-z]{10}$/.test(gh[0].hid)
    && gh[0].baseText === '넷째 문단: 사업 개요를 적습니다.' && gh[0].newText === '넷째 문단: 사업 개요와 배경을 적습니다.'
    && gh[1].type === 'insert' && gh[1].afterRef === 's0/p4' && gh[1].curRef === 's0/p4' && gh[1].baseText === '', 'get_change_request: 덩어리(hid·type·기준 ref → curRef·state·baseText→newText)');
  const ctxM = g.json.context;
  ok(ctxM.startsWith('<document_context>\n') && ctxM.endsWith('\n</document_context>') && ctxM.includes('\n*[s0/p3] 넷째 문단: 사업 개요를 적습니다.\n') && ctxM.includes('\n [s0/p2] ') && ctxM.includes('\n*[s0/p4] ') && ctxM.includes('\n [s0/p5] '),
    `context: 지금 기준 문서의 덩어리 자리(*)와 앞뒤 문단을 <document_context> 로 감쌈(${ctxM.split('\n').length}줄)`);
  ok(g.text.split('</document_context>').length === 2 && gh[1].newText === '새 문단 ＜/document_context> 추진 체계를 적습니다.', '수정본 글 안 </document_context> 꼬리표는 무디게(감싼 자료 밖으로 못 나옴 — 응답 전체에 닫는 꼬리표 하나)');
  ok(eq(g.json.threads, []) && eq(g.json.reviews, []) && g.json.title === '개요 보강' && g.json.author === nameA && g.json.status === 'open' && /comment_change_request/.test(g.json.howTo) && /review_change_request/.test(g.json.howTo) && /사람만/.test(g.json.howTo), 'threads·reviews·howTo(승인·반영은 사람만)');
  ok(g.json.hunkCount === 2 && g.json.from === 0 && g.json.to === 2 && g.json.nextFrom === null && g.json.truncated === false && !/이어 읽/.test(g.json.howTo) && g.text.length <= 20000,
    `작은 변경 요청은 한 쪽(hunkCount 2·to 2·nextFrom null·truncated false, ${g.text.length}자 ≤ 기본 한도 20000)`);
  ok((await mcp(srv.base, TB, 'get_change_request', { doc_id: mid, cid: 99 })).text.includes('NO_CR'), '없는 변경 요청 → NO_CR');

  // 의견: 김검토의 에이전트가 덩어리에 스레드, 작성자(홍길동)의 에이전트가 답글
  const hidM = gh[0].hid;
  const wsM = watchWs(srv.base, srv.tokens.a, mid); await wsM.ready;
  const c1 = await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, hid: hidM, text: '배경 근거 자료가 필요합니다', quote: '배경을' });
  ok(!c1.isError && c1.json.action === 'thread' && c1.json.tid === 1 && c1.json.hid === hidM && c1.json.ref === 's0/p3' && c1.json.by === `${nameB}(Claude)`, `comment_change_request → 스레드 #${c1.json?.tid}(덩어리 ${hidM}, ${c1.json?.by})`);
  ok((await wsM.waitFor((m) => m.type === 'cr' && m.action === 'thread' && m.cid === crMA.cid)).by === `${nameB}(Claude)`, 'WS cr thread(by 사용자(에이전트))');
  const c2 = await mcp(srv.base, TA, 'comment_change_request', { doc_id: mid, cid: crMA.cid, reply_to_thread: 1, text: '통계표를 붙이겠습니다' }, { agent: 'Claude Code' });
  ok(!c2.isError && c2.json.action === 'reply' && c2.json.tid === 1 && c2.json.comments === 2 && c2.json.by === `${nameA}(Claude Code)`, 'reply_to_thread → 그 스레드에 답글(작성자의 에이전트)');
  const c3 = await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, text: '전체적으로 읽기 쉬워졌습니다' });
  const cvM = await A(`/api/docs/${mid}/change-requests/${crMA.cid}`);
  ok(c3.json?.tid === 2 && c3.json.hid === null && eq(cvM.threads[0].comments.map((c) => c.by), [`${nameB}(Claude)`, `${nameA}(Claude Code)`]) && cvM.threads[0].quote === '배경을' && cvM.threads[1].hid === null,
    'REST 보기: 스레드 작성자 = 사용자(에이전트), hid 없는 의견 = 변경 요청 전체');
  const cBad = [
    await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, reply_to_thread: 1, hid: hidM, text: 'x' }),
    await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, hid: 'hnope', text: 'x' }),
    await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, reply_to_thread: 9, text: 'x' }),
    await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: crMA.cid, text: '  ' }),
    await mcp(srv.base, TB, 'comment_change_request', { doc_id: mid, cid: 99, text: 'x' }),
  ];
  ok(cBad.every((r) => r.isError) && /BAD_ARGS/.test(cBad[0].text) && /NO_HUNK/.test(cBad[1].text) && /NO_THREAD/.test(cBad[2].text) && /EMPTY/.test(cBad[3].text) && /NO_CR/.test(cBad[4].text)
    && (await A(`/api/docs/${mid}/change-requests/${crMA.cid}`)).threads.length === 2, '잘못된 의견(답글+hid·없는 덩어리·없는 스레드·빈 글·없는 변경 요청) → 오류, 아무것도 안 남음');

  // 검토: 승인은 거절(AGENT_CANNOT_APPROVE) — 의견만·수정 요청은 됨
  const rvApprove = await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'approve', body: '좋습니다' });
  const afterApprove = await A(`/api/docs/${mid}/change-requests/${crMA.cid}`);
  ok(rvApprove.isError && /AGENT_CANNOT_APPROVE/.test(rvApprove.text) && /승인·반영은 사람/.test(rvApprove.text) && afterApprove.reviews.length === 0 && afterApprove.approvals === 0,
    `에이전트 승인 → 거절(${rvApprove.text.slice(0, 48)}…), 검토 0건`);
  const rvCh = await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'changes', body: '배경 문장의 근거를 보강해 주세요' });
  ok(!rvCh.isError && rvCh.json.verdict === 'changes' && rvCh.json.by === `${nameB}(Claude)` && rvCh.json.changesRequested === 1 && rvCh.json.approvals === 0 && rvCh.json.reviews === 1, 'review_change_request(changes) → 수정 요청 1(사용자(에이전트))');
  const rvBad = [
    await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'comment', body: '  ' }),
    await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'lgtm', body: '좋아요' }),
    await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'APPROVE', body: '좋아요' }),
  ];
  ok(/EMPTY/.test(rvBad[0].text) && /BAD_VERDICT/.test(rvBad[1].text) && /AGENT_CANNOT_APPROVE/.test(rvBad[2].text) && rvBad.every((r) => r.isError), '빈 검토 글 EMPTY · 모르는 판단 BAD_VERDICT · 대문자 APPROVE 도 거절');
  const rvCm = await mcp(srv.base, TA, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'comment', body: '근거 표를 붙였습니다' }, { agent: 'Claude Code' });
  ok(!rvCm.isError && rvCm.json.reviews === 2 && rvCm.json.changesRequested === 1, '작성자의 에이전트도 의견(comment) 검토는 남김(승인 수에는 안 셈)');
  const tl = await rpc(srv.base, TB, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolNames = (tl.msg?.result?.tools || []).map((t) => t.name);
  ok(['list_change_requests', 'get_change_request', 'comment_change_request', 'review_change_request'].every((n) => toolNames.includes(n)) && !toolNames.some((n) => /merge|approve/.test(n)),
    `도구 목록 ${toolNames.length}개: 변경 요청 도구 4개, 승인·반영 도구 없음`);
  const g2 = await mcp(srv.base, TB, 'get_change_request', { doc_id: mid, cid: crMA.cid });
  ok(g2.json.threads.length === 2 && g2.json.threads[0].comments.length === 2 && eq(g2.json.reviews.map((r) => r.verdict), ['changes', 'comment']) && g2.json.changesRequested === 1, 'get_change_request 에 스레드·검토가 보임');
  // 사람(김검토)이 REST 로 승인 → 사람 단위 마지막 판단 = 승인 → 작성자가 반영(승인·반영은 사람의 일)
  const apv = await B(`/api/docs/${mid}/change-requests/${crMA.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  ok(apv.approvals === 1 && apv.changesRequested === 0, '사람(김검토)의 승인이 마지막 판단 → approvals 1, changesRequested 0');
  // 에이전트 검토는 승인 수를 바꾸지 못한다(승인 = 사람이 직접 남긴 마지막 판단) — 에이전트의 수정 요청은 사용자(에이전트)마다 따로 세고,
  // 그 사용자가 나중에 직접 판단하면 묻힌다. 작성자(와 그 에이전트) 것은 세지 않는다
  const rvAfter = await mcp(srv.base, TB, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'changes', body: '표 출처도 적어 주세요' });
  const vAfter = await A(`/api/docs/${mid}/change-requests/${crMA.cid}`);
  ok(!rvAfter.isError && rvAfter.json.approvals === 1 && rvAfter.json.changesRequested === 1 && vAfter.approvals === 1 && eq(vAfter.approvers, [nameB]) && vAfter.canMerge === true,
    '승인한 김검토의 에이전트가 수정 요청 → 승인 1 그대로(거두지 못함), 수정 요청 1, 작성자 canMerge');
  const rvAdm = await mcp(srv.base, srv.tokens.admin, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'changes', body: '용어를 통일해 주세요' });
  const rvSelf = await mcp(srv.base, TA, 'review_change_request', { doc_id: mid, cid: crMA.cid, verdict: 'changes', body: '내 수정을 다시 보겠습니다' }, { agent: 'Claude Code' });
  ok(rvAdm.json?.changesRequested === 2 && rvSelf.json?.changesRequested === 2 && rvSelf.json.approvals === 1, '관리자의 에이전트 수정 요청은 따로 셈(2) · 작성자의 에이전트 수정 요청은 세지 않음');
  const humanCh = await B(`/api/docs/${mid}/change-requests/${crMA.cid}/reviews`, { method: 'POST', body: { verdict: 'changes', body: '다시 보니 근거가 부족합니다' } });
  const vHuman = await A(`/api/docs/${mid}/change-requests/${crMA.cid}`);
  ok(humanCh.approvals === 0 && humanCh.changesRequested === 2 && vHuman.mergeBlockers.some((b) => b.code === 'NEED_APPROVAL'), '김검토가 직접 수정 요청 → 승인 0(반영 막힘), 수정 요청 2(김검토·관리자 에이전트 — 김검토 에이전트 것은 묻힘)');
  const reApv = await B(`/api/docs/${mid}/change-requests/${crMA.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
  ok(reApv.approvals === 1 && reApv.changesRequested === 1 && eq(reApv.approvers, [nameB]), '김검토 다시 승인 → 승인 1, 수정 요청 1(관리자 에이전트 것)');
  ok(reApv.reviews.every((r) => ('agent' in r) === /\)$/.test(r.by)) && reApv.reviews.filter((r) => r.agent).every((r) => r.by.endsWith(`(${r.agent})`)) && reApv.reviews.filter((r) => r.agent).length === 5,
    '검토 기록: 에이전트(MCP) 검토에만 agent 표시(작성자 표기 사용자(에이전트)와 같은 이름), 사람 검토에는 없음');
  const mM = await A(`/api/docs/${mid}/change-requests/${crMA.cid}/merge`, { method: 'POST' });
  ok(mM.cr.status === 'merged' && eq(mM.report.inserted, ['s0/p5']), `작성자 반영 → v${mM.version}`);
  const gB = await mcp(srv.base, TA, 'get_change_request', { doc_id: mid, cid: crMB.cid }, { agent: 'Claude Code' });
  const ctxB = gB.json?.context || '';
  ok(!gB.isError && gB.json.behind === 1 && gB.json.hunks[0].ref === 's0/p5' && gB.json.hunks[0].curRef === 's0/p6' && gB.json.hunks[0].state === 'ok' && ctxB.includes('\n*[s0/p6] 여섯째 문단: 예산은 총 1억 원입니다.'),
    '남의 수정 중(#B): 반영 뒤 curRef 가 밀림(s0/p5 → s0/p6), context 도 지금 기준 문서');
  ok(ctxB.includes('\n [s0/p5] 새 문단 ＜/document_context> 추진 체계를 적습니다.') && gB.text.split('</document_context>').length === 2, '기준 문서 글 안 꼬리표도 무디게(context 닫는 꼬리표 하나)');
  const docsAfter = await A('/api/docs');
  ok(eq(docsAfter.find((x) => x.id === mid)?.crs, { draft: 1, open: 0 }), '반영 뒤 문서 목록 crs { draft: 1, open: 0 }');
  wsM.close();

  // ───────── 13b. get_change_request 쪽 나눔(큰 변경 요청) ─────────
  section('MCP get_change_request 쪽 나눔(from·limit·max_chars): 쪽마다 한도 안, 덩어리는 빠짐·겹침 없이 차례대로, 덩어리 스레드는 그 쪽에, 설명·검토·전체 의견은 첫 쪽에');
  {
    const N = 16; const MAXC = 6000;
    const dP = await uploadDoc(srv.base, srv.tokens.admin, await buildLongDoc(N), '쪽 나눔.hwpx');
    const pdoc = dP.id;
    const crP = (await putDraft(A, pdoc, await makeHead(A, pdoc, (d) => {
      for (let i = 0; i <= N; i++) replaceIn(d, `s0/p${3 + i}`, '번 긴 문단', '번 고친 긴 문단');
    }))).cr;
    await A(`/api/docs/${pdoc}/change-requests/${crP.cid}/submit`, { method: 'POST', body: { title: '긴 문단 고침', description: '문단마다 낱말을 고쳤습니다' } });
    const hidsP = crP.hunks.map((h) => h.hid);
    const h10 = crP.hunks[10];
    await B(`/api/docs/${pdoc}/change-requests/${crP.cid}/threads`, { method: 'POST', body: { hid: h10.hid, text: '열한째 덩어리에 단 의견' } });
    await B(`/api/docs/${pdoc}/change-requests/${crP.cid}/threads`, { method: 'POST', body: { text: '변경 요청 전체에 단 의견' } });
    await B(`/api/docs/${pdoc}/change-requests/${crP.cid}/reviews`, { method: 'POST', body: { verdict: 'comment', body: '전체적으로 좋습니다' } });
    ok(hidsP.length === N + 1 && crP.hunks.every((h) => h.type === 'replace'), `덩어리 ${hidsP.length}개(긴 문단 ${N} + 아주 긴 문단 1)`);
    const pages = []; let from = 0;
    while (from != null && pages.length < 40) {
      const pg = await mcp(srv.base, TB, 'get_change_request', { doc_id: pdoc, cid: crP.cid, from, max_chars: MAXC });
      if (pg.isError || !pg.json) throw new Error(`get_change_request(from=${from}) 오류: ${pg.text.slice(0, 300)}`);
      pages.push(pg); from = pg.json.nextFrom;
    }
    const J = pages.map((p) => p.json);
    ok(pages.length >= 3 && pages.every((p) => p.text.length <= MAXC), `max_chars ${MAXC} → ${pages.length}쪽, 쪽마다 ${pages.map((p) => p.text.length).join('·')}자 ≤ ${MAXC}`);
    ok(eq(J.flatMap((j) => j.hunks.map((h) => h.hid)), hidsP), '모든 쪽의 덩어리를 이으면 덩어리 전부가 차례대로 한 번씩');
    ok(J.every((j, k) => j.hunkCount === N + 1 && j.from === (k ? J[k - 1].to : 0) && j.to === j.from + j.hunks.length && j.hunks.length >= 1
      && (k < J.length - 1 ? j.truncated === true && j.nextFrom === j.to && j.howTo.includes(`from=${j.nextFrom}`) : j.truncated === false && j.nextFrom === null)),
    '쪽 정보: from = 앞 쪽 to, to = from + 덩어리 수, 마지막 쪽 전까지 truncated·nextFrom(= to, howTo 에 from=…)');
    ok(J[0].description === '문단마다 낱말을 고쳤습니다' && J[0].reviews.length === 1 && J[0].reviewCount === 1 && J[0].threads.some((t) => t.hid === null && t.comments[0].text === '변경 요청 전체에 단 의견')
      && J.slice(1).every((j) => !('reviews' in j) && !('description' in j) && j.reviewCount === 1 && j.threads.every((t) => t.hid !== null) && j.howTo.includes('첫 쪽')),
    '설명·검토·전체 의견(덩어리 없는 스레드)은 첫 쪽에만, 다음 쪽은 reviewCount 와 첫 쪽 안내만');
    const withH10 = J.filter((j) => j.threads.some((t) => t.hid === h10.hid));
    ok(withH10.length === 1 && withH10[0].hunks.some((h) => h.hid === h10.hid) && J.every((j) => j.threadCount === 2 && j.threads.every((t) => t.hid === null || j.hunks.some((h) => h.hid === t.hid))),
      `덩어리 스레드는 그 덩어리가 든 쪽(${J.indexOf(withH10[0])}쪽)에만, 쪽마다 threadCount 2`);
    ok(pages.every((p) => {
      const stars = [...p.json.context.matchAll(/^\*\[([^\]]+)\]/gm)].map((m) => m[1]);
      return p.text.split('</document_context>').length === 2 && eq(stars.sort(), p.json.hunks.map((h) => h.curRef).sort());
    }), '쪽마다 context 는 그 쪽 덩어리 자리(*)만 — 감싼 꼬리표 하나');
    const big = J.flatMap((j) => j.hunks).find((h) => h.ref === `s0/p${3 + N}`);
    ok(big && /…\(8000자 줄임\)$/.test(big.baseText) && /…\(8003자 줄임\)$/.test(big.newText) && [...big.baseText].length < 1100, `아주 긴 문단(9000자) 덩어리 글은 한도에 맞춰 줄임(${[...big.baseText].length}자 — max_chars/6)`);
    const lim3 = await mcp(srv.base, TB, 'get_change_request', { doc_id: pdoc, cid: crP.cid, limit: 3 });
    const past = await mcp(srv.base, TB, 'get_change_request', { doc_id: pdoc, cid: crP.cid, from: 99 });
    const dflt = await mcp(srv.base, TB, 'get_change_request', { doc_id: pdoc, cid: crP.cid });
    ok(eq(lim3.json?.hunks.map((h) => h.hid), hidsP.slice(0, 3)) && lim3.json.nextFrom === 3 && lim3.json.truncated === true, 'limit 3 → 덩어리 3개, nextFrom 3');
    ok(past.json && past.json.from === N + 1 && eq(past.json.hunks, []) && past.json.nextFrom === null && past.json.truncated === false && /덩어리가 없다/.test(past.json.howTo), 'from 이 덩어리 수 이상 → 빈 쪽(nextFrom null, 안내)');
    ok(!dflt.isError && dflt.text.length <= 20000 && dflt.json.from === 0 && dflt.json.to === dflt.json.hunks.length && (dflt.json.nextFrom === null || dflt.json.nextFrom === dflt.json.to),
      `한도를 안 주면 기본 20000자(${dflt.text.length}자 · 덩어리 ${dflt.json?.hunks.length}/${N + 1})`);
    const tooSmall = await mcp(srv.base, TB, 'get_change_request', { doc_id: pdoc, cid: crP.cid, max_chars: 1000 });
    ok(tooSmall.isError, 'max_chars 1000(< 4000) → 입력 오류');
  }

  // ───────── 14. add_memo reply_to · 에이전트 이름 정리 ─────────
  section('MCP add_memo(reply_to) → 그 메모 스레드에 답글 · 에이전트 이름의 제어 문자·괄호 정리');
  const memosM = await A(`/api/docs/${mid}/memos`);
  const memo1M = memosM.find((m) => m.id === 'memo1');
  const ar = await mcp(srv.base, TB, 'add_memo', { doc_id: mid, reply_to: 'memo1', text: '에이전트가 확인했습니다' });
  ok(!ar.isError && ar.json.id === 'memo1' && ar.json.thread.replies.length === 1 && ar.json.thread.replies[0].by === `${nameB}(Claude)` && ar.json.text.startsWith(`${memo1M.text}\n── 답글\n↳ ${nameB}(Claude) `) && ar.json.body === memo1M.body,
    'add_memo(reply_to) → 새 메모 대신 그 메모의 답글(작성자 사용자(에이전트)), body 그대로');
  ok((await A(`/api/docs/${mid}/memos`)).length === memosM.length && (await docOf(A, mid)).memos().find((m) => m.id === 'memo1')?.text === ar.json.text, '새 메모는 생기지 않고 문서의 그 메모 글에 블록');
  const arBad = [
    await mcp(srv.base, TB, 'add_memo', { doc_id: mid, reply_to: 'memo1', text: 'x', request_id: 999999 }),
    await mcp(srv.base, TB, 'add_memo', { doc_id: mid, text: 'x' }),
    await mcp(srv.base, TB, 'add_memo', { doc_id: mid, reply_to: 'nomemo', text: 'x' }),
    await mcp(srv.base, TB, 'add_memo', { doc_id: mid, reply_to: 'memo1', text: '  ' }),
  ];
  ok(arBad.every((r) => r.isError) && /NO_REQUEST/.test(arBad[0].text) && /NO_REF/.test(arBad[1].text) && /NO_MEMO/.test(arBad[2].text) && /EMPTY/.test(arBad[3].text), 'reply_to + 없는 request_id → NO_REQUEST · ref 도 reply_to 도 없음 → NO_REF · 없는 메모 → NO_MEMO · 빈 글 → EMPTY');
  const am = await mcp(srv.base, TA, 'add_memo', { doc_id: mid, ref: 's0/p1', text: '이름 시험' }, { agent: 'Bad\u0001Agent\u0007(x)' });
  ok(!am.isError && am.json.author === `${nameA}(BadAgent x)`, `에이전트 이름 정리: 제어 문자·괄호 뺌 → 작성자 「${am.json?.author}」`);

  // ───────── 15. REST 요청 보기: 에이전트 세션 id 는 남에게 안 보임 ─────────
  section('REST 요청 보기: claim.session 은 맡은 사람에게만, delivery.session 은 요청자에게만(MCP 보기처럼)');
  agentA = await listenAgent(srv.base, srv.tokens.a, 'channel=1&session=crSessA&agent=Claude%20Code');
  if (agentA.status === 200) await agentA.waitFor((e) => e.event === 'hello');
  const rqS = await A(`/api/docs/${mid}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } });
  const ridS = rqS.request.rid;
  const stS = await mcp(srv.base, TA, 'start_request', { doc_id: mid, request_id: ridS }, { agent: 'Claude Code', session: 'crSessA' });
  ok(!stS.isError && stS.json.claim?.session === 'crSessA' && stS.json.claim.by === nameA, 'start_request 응답(맡은 사람 본인 보기) → claim.session 보임');
  const vA = await A(`/api/docs/${mid}/requests/${ridS}`); const vB = await B(`/api/docs/${mid}/requests/${ridS}`); const vAdm = await ADM(`/api/docs/${mid}/requests/${ridS}`);
  const lB = (await B(`/api/docs/${mid}/requests`)).find((r) => r.rid === ridS);
  ok(vA.claim?.session === 'crSessA' && [vB, vAdm, lB].every((v) => v.claim && !('session' in v.claim) && v.claim.by === nameA && v.claim.agent === 'Claude Code' && !Number.isNaN(Date.parse(v.claim.expires))),
    'claim: 맡은 사람(홍길동) 보기에만 session, 남·관리자 보기(하나·목록)에는 by·agent·expires 만');
  if (agentA.status === 200) {
    ok(rqS.route === 'agent' && rqS.request.delivery?.session === 'crSessA' && vA.delivery?.session === 'crSessA' && [vB, vAdm, lB].every((v) => v.delivery && !('session' in v.delivery) && v.delivery.agent === 'Claude Code'),
      'delivery: 요청자 보기에만 session(채널 세션), 남·관리자 보기에는 agent·at 만');
  } else console.log(`  - 에이전트 SSE 경로 없음(${agentA.status}) — delivery 확인 건너뜀`);
  agentA.close();

  // ───────── 16. 서버 안내(instructions) 길이 ─────────
  section('서버 instructions ≤ 1456자(브리지가 채널 안내 590자를 앞에 붙여 2048자 안) — 변경 요청 검토·reply_to 안내 포함');
  const insts = [];
  for (const who of ['admin', 'a', 'b']) {
    const init = await rpc(srv.base, srv.tokens[who], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'api-cr-test', version: '1' } } });
    insts.push(init.msg?.result?.instructions || '');
  }
  ok(insts.every((s) => s.length > 0 && s.length <= 1456 && ['list_change_requests', 'get_change_request', 'comment_change_request', 'review_change_request', 'reply_to', '<document_context>', 'claim_next_request'].every((k) => s.includes(k))),
    `MCP initialize instructions ${insts.map((s) => s.length).join('·')}자 ≤ 1456(변경 요청 도구·reply_to·<document_context> 포함)`);
  ok(MAX_SERVER_INSTRUCTIONS === 1456 && instructionsBudget(true) === MAX_SERVER_INSTRUCTIONS && serverInstructions('가'.repeat(60)).length <= instructionsBudget(true),
    `한도 = 브리지 예산(${instructionsBudget(true)}) — 긴 사용자 이름(60자 → 20자로 줄임)도 ${serverInstructions('가'.repeat(60)).length}자`);

  // ───────── 17. XML 금지 제어 문자 — 엔진 바탕(escapeText·escapeAttr)과 v0.2 쓰기 경로 ─────────
  section('XML 금지 제어 문자: 엔진 바탕(escapeText·escapeAttr) · 사람 메모·제안(적용)·옛 제안·에이전트 이름 → 작업본·기준 문서 XML 이 엄격한 해석기로 읽힘');
  {
    // (1) 엔진에 바로 제어 문자를 준다(서비스의 정리를 거치지 않음): 메모 글·작성자, 변경 추적 글·작성자
    const e = await HwpxDoc.load(await buildMainDoc());
    e.addMemo('s0/p1', { author: '작성\u0007자', text: '엔진\u0001메모\u000b둘째 줄' });
    e.insertTracked('s0/p2', 0, '넣은\u0002글 ', { author: '변경\u0003자' });
    const eb = Buffer.from(await e.save());
    ok(eq(await badXmlChars(eb), []) && eq(await xmlErrors(eb), []), `엔진 저장본: Contents/*.xml 에 금지 글자 없음${SaxesParser ? ', 엄격한 XML 해석기(saxes)로 읽힘' : ''}`);
    const re = await HwpxDoc.load(eb);
    const em = re.memos().find((m) => m.text.startsWith('엔진'));
    ok(em?.text === '엔진메모\n둘째 줄' && em.author === '작성자' && re.text('s0/p2').startsWith('넣은글 ') && re.changes().some((c) => c.author === '변경자' && c.text === '넣은글 ') && re.authors().some((a) => a.name === '변경자'),
      '다시 읽은 글 = 금지 글자 뺀 것(U+000B → 줄바꿈), 메모·변경 추적 작성자(속성)도 정리됨');
  }
  const dC = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '제어 문자 v02.hwpx');
  const cid0 = dC.id;
  const memoC = await A(`/api/docs/${cid0}/memos`, { method: 'POST', body: { ref: 's0/p1', text: '사람\u0001메모\u0007끝\u000b둘째 줄' } });
  ok(memoC.text === '사람메모끝\n둘째 줄', `사람 메모(POST /memos): 「${memoC.text.replace(/\n/g, '⏎')}」`);
  const onlyCtrl = await A.res(`/api/docs/${cid0}/memos`, { method: 'POST', body: { ref: 's0/p1', text: '\u0001\u0002 ' } });
  ok(onlyCtrl.status === 400 && onlyCtrl.data.error === 'EMPTY', '제어 문자뿐인 메모 → 400 EMPTY(빈 메모를 만들지 않음)');
  // 제어 문자뿐인 바꿀 글은 빈 글(= 지우기 제안)로 바뀌지 않는다 — 메모와 같은 EMPTY. 지우기 제안(replace "")은 그대로 됨
  {
    const P = `/api/docs/${cid0}/proposals`;
    const nProps = (await A(P)).length; const text2 = (await working(A, cid0)).doc.text('s0/p2');
    const ctl1 = await A.res(P, { method: 'POST', body: { ref: 's0/p2', find: 'AI 제안대로', replace: '\u0001\u0007' } });
    const ctl2 = await mcp(srv.base, TA, 'propose_change', { doc_id: cid0, ref: 's0/p2', find: 'AI 제안대로', replace: '\u0002' });
    ok(ctl1.status === 400 && ctl1.data.error === 'EMPTY' && ctl2.isError && /EMPTY/.test(ctl2.text) && (await A(P)).length === nProps, '제어 문자뿐인 바꿀 글(POST /proposals·MCP propose_change) → EMPTY, 제안 안 생김');
    const alt = await mcp(srv.base, TA, 'propose_alternatives', { doc_id: cid0, ref: 's0/p2', find: 'AI 제안대로', options: [{ text: '\u0003\u0004' }, { text: '처음 뜻대로' }] });
    ok(!alt.isError && alt.json.results[0].ok === false && /제어 문자뿐/.test(alt.json.results[0].error) && alt.json.results[1].ok === true && alt.json.results[1].proposal.replace === '처음 뜻대로',
      '여러 안: 제어 문자뿐인 안만 실패(EMPTY 글), 나머지 안은 만들어짐');
    const del = await A(P, { method: 'POST', body: { ref: 's0/p2', find: 'AI ', replace: '' } });
    const pat = await A.res(`${P}/${del.pid}`, { method: 'PATCH', body: { replace: '\u0005' } });
    const patOk = await A(`${P}/${del.pid}`, { method: 'PATCH', body: { replace: '사람 ' } });
    ok(del.replace === '' && pat.status === 400 && pat.data.error === 'EMPTY' && patOk.replace === '사람 ', '지우기 제안(replace "")은 됨 · PATCH replace 제어 문자뿐 → 400 EMPTY · 보통 글로 고치기는 됨');
    // 예전에 저장된 제어 문자뿐인 바꿀 글·넣을 문단 글(meta.json 에 그대로) → 적용하면 409 EMPTY(지우기·빈 문단으로 적용하지 않음)
    const legR = await A(P, { method: 'POST', body: { ref: 's0/p2', find: '둡니다', replace: '둡니다만' } });
    const legI = await A(P, { method: 'POST', body: { type: 'insert', afterRef: 's0/p2', text: '임시 문단' } });
    const metaL = path.join(srv.dataDir, 'docs', cid0, 'meta.json');
    const ml = JSON.parse(fs.readFileSync(metaL, 'utf-8'));
    ml.proposals.find((p) => p.pid === legR.pid).replace = '\u0001\u0002';
    ml.proposals.find((p) => p.pid === legI.pid).text = '\u0003 ';
    fs.writeFileSync(metaL, JSON.stringify(ml, null, 1));
    const apR = await ADM.res(`${P}/${legR.pid}/apply`, { method: 'POST' });
    const apI = await ADM.res(`${P}/${legI.pid}/apply`, { method: 'POST' });
    const stL = (await A(P)).filter((p) => p.pid === legR.pid || p.pid === legI.pid).map((p) => p.status);
    ok(apR.status === 409 && apR.data.error === 'EMPTY' && apI.status === 409 && apI.data.error === 'EMPTY' && eq(stL, ['pending', 'pending']) && (await working(A, cid0)).doc.text('s0/p2') === text2,
      '예전 제안(제어 문자뿐인 바꿀 글·넣을 글) 적용 → 409 EMPTY, 대기 그대로, 문단 글 그대로');
    for (const p of [del, legR, legI, alt.json.results[1].proposal]) await A(`${P}/${p.pid}/reject`, { method: 'POST' });
  }
  // 적용은 관리자의 에이전트(편집자의 에이전트는 allowDirectApply 가 꺼져 있어 403 — 11g). 변경 추적 작성자는 제안한 사람(홍길동(BadAgent))
  const agProp = await mcp(srv.base, TA, 'propose_change', { doc_id: cid0, ref: 's0/p5', find: '1억 원', replace: '1억\u0006 원 이상' }, { agent: 'Bad\u0001Agent\u0007' });
  const agApply = await mcp(srv.base, srv.tokens.admin, 'apply_proposal', { doc_id: cid0, proposal_id: agProp.json?.pid }, { agent: 'Bad\u0001Agent\u0007' });
  ok(!agProp.isError && agProp.json.by === `${nameA}(BadAgent)` && agProp.json.replace === '1억 원 이상' && !agApply.isError && agApply.json.status === 'applied', `에이전트 제안·적용(이름 「Bad·Agent·」 → ${agProp.json?.by})`);
  const propC = await A(`/api/docs/${cid0}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업\u0001 개요와\u0007 배경을', reason: '이유\u0002입니다', note: '메모\u0008입니다' } });
  ok(propC.replace === '사업 개요와 배경을' && propC.reason === '이유입니다' && propC.note === '메모입니다', '제안(POST /proposals): 바꿀 글·이유·메모에서 뺌');
  await ADM(`/api/docs/${cid0}/proposals/${propC.pid}/apply`, { method: 'POST' });
  const insC = await A(`/api/docs/${cid0}/proposals`, { method: 'POST', body: { type: 'insert', afterRef: 's0/p4', text: '넣을\u0003 문단\u000c끝' } });
  await ADM(`/api/docs/${cid0}/proposals/${insC.pid}/apply`, { method: 'POST' });
  // 예전(고치기 전)에 저장된 제안: meta.json 에 제어 문자가 든 글 그대로 → 적용해도 문서 XML 은 깨지지 않음
  // (위 문단 추가의 U+000C 는 줄바꿈 → 2026-10-31 부터 새 문단 — 뒤 문단이 한 칸 밀린다)
  const oldP = await A(`/api/docs/${cid0}/proposals`, { method: 'POST', body: { ref: 's0/p9', find: '맺음말', replace: '끝말' } });
  const metaC = path.join(srv.dataDir, 'docs', cid0, 'meta.json');
  const mc = JSON.parse(fs.readFileSync(metaC, 'utf-8'));
  mc.proposals.find((p) => p.pid === oldP.pid).replace = '끝\u0001말\u0002';
  fs.writeFileSync(metaC, JSON.stringify(mc, null, 1));
  await ADM(`/api/docs/${cid0}/proposals/${oldP.pid}/apply`, { method: 'POST' });
  for (const kind of ['working', 'tracked']) {
    const bytes = (await A.res(`/api/docs/${cid0}/file?kind=${kind}`)).data;
    const bad = await badXmlChars(bytes); const errs = await xmlErrors(bytes);
    ok(eq(bad, []) && eq(errs, []), `${kind} 사본: 금지 글자 없음${SaxesParser ? '·엄격한 XML 해석기로 읽힘' : ''}${bad.length || errs.length ? ` (${[...bad, ...errs].slice(0, 3).join(', ')})` : ''}`);
  }
  const wC = (await working(A, cid0)).doc;
  ok(wC.text('s0/p3') === '넷째 문단: 사업 개요와 배경을 적습니다.' && wC.text('s0/p5') === '넣을 문단' && wC.text('s0/p6') === '끝' && wC.text('s0/p7') === '여섯째 문단: 예산은 총 1억 원 이상입니다.' && wC.text('s0/p9') === '여덟째 문단: 끝말입니다.',
    '작업본(HwpxDoc 으로 다시 읽음) 글 = 금지 글자 뺀 것(U+000C → 줄바꿈 → 새 문단)');
  ok(wC.memos().some((m) => m.text === '사람메모끝\n둘째 줄') && wC.memos().some((m) => m.text.startsWith('[제안 ') && m.text.includes('메모: 메모입니다')), '작업본 메모: 사람 메모·제안 메모 글도 깨끗함');
  const tC = await docOf(A, cid0);
  ok(tC.changes().some((c) => c.author === `${nameA}(BadAgent)`) && tC.authors().every((a) => !/[\u0000-\u001f]/.test(a.name)) && !tC.changes().some((c) => c.text === '' && c.kind !== 'para'), '기준 문서 변경 추적: 작성자 이름에 제어 문자 없음, 빈 변경 없음(폭 0 문단 나눔 넣음 — 2026-10-30 — 은 빼고)');

  // ───────── 18. 수정 중(draft) 변경 요청은 승인할 수 없다 ─────────
  section("수정 중(draft) 변경 요청 승인 → 409 NOT_OPEN('검토 요청 후 승인') · 의견·수정 요청·의견 스레드는 됨 · 자기 승인은 SELF_APPROVE · MCP 승인은 AGENT_CANNOT_APPROVE · 검토 요청 뒤 승인 → 반영");
  {
    const dN = await uploadDoc(srv.base, srv.tokens.admin, await buildMainDoc(), '초안 승인.hwpx');
    const N = dN.id; const CRN = `/api/docs/${N}/change-requests`;
    const crN = (await putDraft(A, N, await makeHead(A, N, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 범위를')))).cr;
    const apB = await B.res(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'approve', body: '미리 승인합니다' } });
    const apAdm = await ADM.res(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const apSelf = await A.res(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'approve' } });
    const vN0 = await A(`${CRN}/${crN.cid}`);
    ok(crN.status === 'draft' && apB.status === 409 && apB.data.error === 'NOT_OPEN' && apB.data.message === '검토 요청 후 승인할 수 있습니다' && apAdm.status === 409 && apAdm.data.error === 'NOT_OPEN'
      && vN0.status === 'draft' && vN0.reviews.length === 0 && vN0.approvals === 0, `draft 승인(김검토·관리자) → 409 NOT_OPEN(「${apB.data.message}」), 검토 0건`);
    ok(apSelf.status === 403 && apSelf.data.error === 'SELF_APPROVE', '작성자 자기 승인은 draft 여도 403 SELF_APPROVE(먼저 봄 — 검토 요청해도 못 함)');
    // 판단 이름은 approve·changes·comment 셋뿐 — 객체 원형 키('constructor' 등)는 판단이 아니다(전에는 500 + 쓰레기 검토가 저장됨)
    const junkV = [];
    for (const v of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) junkV.push(await B.res(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: v, body: '이상한 판단' } }));
    const vNj = await A(`${CRN}/${crN.cid}`);
    ok(junkV.every((r) => r.status === 400 && r.data.error === 'BAD_VERDICT') && vNj.reviews.length === 0,
      `원형 키 판단(constructor·toString·__proto__·hasOwnProperty·valueOf) → 400 BAD_VERDICT(${junkV.map((r) => r.status).join(',')}), 검토 안 생김`);
    const chN = await B(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'changes', body: '범위를 구체적으로 적어 주세요' } });
    const cmN = await B(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'comment', body: '방향은 좋습니다' } });
    const thN = await B(`${CRN}/${crN.cid}/threads`, { method: 'POST', body: { hid: crN.hunks[0].hid, text: '범위는 어디까지인가요?' } });
    ok(chN.status === 'draft' && chN.changesRequested === 1 && eq(cmN.reviews.map((r) => r.verdict), ['changes', 'comment']) && thN.threads.length === 1 && thN.threads[0].hid === crN.hunks[0].hid,
      'draft 에도 수정 요청·의견(검토)·의견 스레드는 남김(수정 요청 1)');
    const mcpAp = await mcp(srv.base, TB, 'review_change_request', { doc_id: N, cid: crN.cid, verdict: 'approve', body: '좋습니다' });
    const mcpCh = await mcp(srv.base, TB, 'review_change_request', { doc_id: N, cid: crN.cid, verdict: 'changes', body: '근거 문장을 더해 주세요' });
    ok(mcpAp.isError && /AGENT_CANNOT_APPROVE/.test(mcpAp.text) && !mcpCh.isError && mcpCh.json.status === 'draft' && mcpCh.json.reviews === 3,
      'MCP review_change_request: draft 승인도 AGENT_CANNOT_APPROVE, 수정 요청(changes)은 됨(검토 3건)');
    const mDraftN = await A.res(`${CRN}/${crN.cid}/merge`, { method: 'POST' });
    ok(mDraftN.status === 409 && mDraftN.data.error === 'STATE' && vN0.mergeBlockers.some((b) => b.code === 'NOT_SUBMITTED'), 'draft 반영은 그대로 409 STATE(막힘 NOT_SUBMITTED)');
    await A(`${CRN}/${crN.cid}/submit`, { method: 'POST', body: { title: '범위 보강' } });
    const apOpen = await B(`${CRN}/${crN.cid}/reviews`, { method: 'POST', body: { verdict: 'approve', body: '고친 것 확인했습니다' } });
    const mN = await A(`${CRN}/${crN.cid}/merge`, { method: 'POST' });
    ok(apOpen.status === 'open' && apOpen.approvals === 1 && eq(apOpen.approvers, [nameB]) && apOpen.changesRequested === 0 && mN.cr.status === 'merged',
      '검토 요청(open) 뒤 승인 → 승인 1(앞선 수정 요청·에이전트 수정 요청은 묻힘) → 작성자 반영');
  }

  // ───────── 19. 빈 대상 AI 요청(EMPTY_TARGET) ─────────
  section('빈 대상 AI 요청 → 400 EMPTY_TARGET: 검토·문장 제안·다듬기의 대상에 글이 없음(빈 문단·빈 칸·캐럿만·공백만·여러 문단의 줄바꿈만·제어 문자뿐) — 요청·버전 안 생김 · 표 문단 검토·지시·문단 추가·표 채우기·문서 전체는 됨');
  {
    const dE = await uploadDoc(srv.base, srv.tokens.admin, await buildBlankDoc(), '빈 대상.hwpx');
    const E = dE.id; const RQ = `/api/docs/${E}/requests`;
    const docE = await docOf(A, E);
    ok(docE.text('s0/p4') === '' && docE.text('s0/p5') === '\u0001\u0007 ' && docE.text('s0/p2') === '' && docE.text('s0/p2/n2') === '가' && docE.text('s0/p2/n3') === '',
      '(전제) 빈 문단 s0/p4 · 제어 문자와 공백뿐인 문단 s0/p5 · 표 문단 s0/p2(제 글 없음, 칸 글 있음) · 빈 칸 s0/p2/n3');
    const vE = await versionOf(B, E); const nReqE = (await B(RQ)).length;
    const p1 = docE.text('s0/p1'); const sp = [...p1].indexOf(' '); const p3len = [...docE.text('s0/p3')].length;
    const bad = [
      ['검토 · 빈 문단(문단 전체)', { kind: 'review', target: { ref: 's0/p4' } }],
      ['문장 제안 · 공백 한 칸만 고름', { kind: 'suggest', target: { ref: 's0/p1', start: sp, end: sp + 1, text: ' ' } }],
      ['다듬기 · 캐럿만(빈 범위)', { kind: 'polish', preset: 'concise', target: { ref: 's0/p1', start: 3, end: 3 } }],
      ['다듬기 · 빈 표 칸', { kind: 'polish', preset: 'spelling', target: { ref: 's0/p2/n3' } }],
      ['검토 · 두 문단에 걸친 줄바꿈만', { kind: 'review', target: { ref: 's0/p3', refs: ['s0/p3', 's0/p4'], start: p3len, end: 0 } }],
      ['검토 · 제어 문자뿐(빼면 빈 글)', { kind: 'review', target: { ref: 's0/p5' } }],
    ];
    const badRes = [];
    for (const [, body] of bad) badRes.push(await B.res(RQ, { method: 'POST', body: { ...body, route: 'queue' } }));
    ok(badRes.every((r) => r.status === 400 && r.data.error === 'EMPTY_TARGET' && /대상에 글이 없습니다/.test(r.data.message)),
      `${bad.map(([w]) => w).join(' / ')} → 모두 400 EMPTY_TARGET(${badRes.map((r) => `${r.status} ${r.data.error}`).join(', ')})`);
    ok((await B(RQ)).length === nReqE && await versionOf(B, E) === vE, '막힌 요청은 아무것도 남기지 않음(요청 수·버전 그대로)');
    const good = [
      ['검토 · 표 문단(칸 글이 있음)', { kind: 'review', target: { ref: 's0/p2' } }],
      ['지시 · 빈 문단', { kind: 'instruct', instruction: '이 자리에 사업 목적을 한 문장으로 써 주세요', target: { ref: 's0/p4' } }],
      ['문단 추가 · 빈 문단 뒤', { kind: 'insert', target: { ref: 's0/p4' } }],
      ['표 채우기 · 빈 칸', { kind: 'fill_table', target: { ref: 's0/p2/n3' } }],
      ['검토 · 문서 전체', { kind: 'review', target: { scope: 'document' } }],
      ['다듬기 · 글 있는 문단', { kind: 'polish', preset: 'concise', target: { ref: 's0/p1' } }],
    ];
    const goodRes = [];
    for (const [, body] of good) goodRes.push(await B.res(RQ, { method: 'POST', body: { ...body, route: 'queue' } }));
    ok(goodRes.every((r) => r.status === 200 && r.data.queued === true && r.data.request?.rid > 0) && (await B(RQ)).length === nReqE + good.length,
      `${good.map(([w]) => w).join(' / ')} → 요청 생김(${goodRes.map((r) => r.status).join(', ')})`);
  }

  // ───────── 20. 판(0.5.0)·설정 예시 ─────────
  section('package.json 판 0.5.0 — /api/config·서버 시작 줄이 같은 판 · config.example.json 의 changeRequests·agents·documents 구역');
  {
    const pkgVer = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version;
    const confV = await (await fetch(`${srv.base}/api/config`)).json();
    ok(pkgVer === '0.5.0' && confV.version === pkgVer && confV.name === 'hwpx-cowork' && srv.lines.some((l) => l.startsWith(`[hwpx-cowork ${pkgVer}] `)),
      `판 ${pkgVer}: /api/config ${confV.version}, 서버 시작 줄 「${srv.lines.find((l) => l.startsWith('[hwpx-cowork '))}」`);
    const ex = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf-8'));
    ok(eq(ex.changeRequests, { requireApprovals: 1, allowDirectApply: false }) && eq(ex.agents, { leaseMinutes: 15, othersCanTake: false }) && eq(ex.documents, { defaultEditMode: 'realtime', aiMilestoneMinutes: 30 }),
      `config.example.json(올바른 JSON): changeRequests ${JSON.stringify(ex.changeRequests)} · agents ${JSON.stringify(ex.agents)} · documents ${JSON.stringify(ex.documents)}`);
  }

  ws.close(); ws = null;
  await srv.stop();

  // ───────── 승인 0 설정 ─────────
  section('config.changeRequests.requireApprovals = 0 → 작성자가 승인 없이 반영 · allowDirectApply = true → 편집자도 기준에 바로 적용');
  const srv0 = await startServer({ ai: 'off', config: { ...V3_DOCS, changeRequests: { requireApprovals: 0, allowDirectApply: true } } }); servers.push(srv0);
  const A0 = srv0.api('a');
  {
    const c0 = await (await fetch(`${srv0.base}/api/config`)).json();
    const d0 = await uploadDoc(srv0.base, srv0.tokens.a, await buildMainDoc(), '바로 적용 켬.hwpx');
    const p0 = await A0(`/api/docs/${d0.id}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을' } });
    const a0 = await A0(`/api/docs/${d0.id}/proposals/${p0.pid}/apply`, { method: 'POST' });
    const n0 = await A0(`/api/docs/${d0.id}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터', applyNow: true } });
    ok(c0.allowDirectApply === true && a0.status === 'applied' && n0.status === 'applied', '/api/config allowDirectApply true → 편집자 REST apply·applyNow 됨');
    const pm0 = await A0(`/api/docs/${d0.id}/proposals`, { method: 'POST', body: { ref: 's0/p5', find: '1억 원', replace: '1억 5천만 원' } });
    const am0 = await mcp(srv0.base, srv0.tokens.a, 'apply_proposal', { doc_id: d0.id, proposal_id: pm0.pid });
    const { doc: w0, version: v0w } = await working(A0, d0.id);
    const w0e = await w0.clone(); replaceIn(w0e, 's0/p7', '맺음말', '맺음말(올림)');
    const up0 = await A0.res(`/api/docs/${d0.id}/upload?base=${v0w}`, { method: 'PUT', body: Buffer.from(await w0e.save()) });
    ok(!am0.isError && am0.json.status === 'applied' && up0.status === 200 && up0.data.version === v0w + 1, '편집자의 에이전트 MCP apply_proposal·편집자 PUT /upload 도 됨');
  }
  const z = await uploadDoc(srv0.base, srv0.tokens.a, await buildMainDoc(), '승인 0.hwpx');
  // 이 수정본은 mergeBodyTexts(본문 글 목록 통째로 맞추기)로 만든다: p5 바꿈 + p5 뒤 새 문단
  const crZ = (await putDraft(A0, z.id, await makeHead(A0, z.id, (d) => {
    const texts = d.bodyTexts()[0];
    texts[5] = texts[5].replace('1억 원', '9천만 원'); texts.splice(6, 0, '예산 내역은 붙임을 봅니다.');
    d.mergeBodyTexts({ 0: texts }, ED);
  }))).cr;
  ok(eq(crZ.hunks.map((h) => [h.type, h.afterRef ?? h.ref]), [['replace', 's0/p5'], ['insert', 's0/p5']]), 'mergeBodyTexts 로 만든 수정본 → 바꿈 p5 + p5 뒤 추가');
  const crZo = await A0(`/api/docs/${z.id}/change-requests/${crZ.cid}/submit`, { method: 'POST', body: {} });
  const newZ = '여섯째 문단: 예산은 총 9천만 원입니다.';
  ok(crZo.title === `${[...newZ].slice(0, 20).join('')}…` && crZo.canMerge === true, `제목 없이 검토 요청 → 첫 덩어리 앞 20자 「${crZo.title}」, canMerge`);
  const mZ = await A0(`/api/docs/${z.id}/change-requests/${crZ.cid}/merge`, { method: 'POST' });
  const zDoc = await docOf(A0, z.id);
  ok(mZ.cr.status === 'merged' && zDoc.text('s0/p5') === '여섯째 문단: 예산은 총 9천만 원입니다.' && zDoc.text('s0/p6') === '예산 내역은 붙임을 봅니다.', '승인 없이 작성자 반영(바꿈 + 새 문단)');
  await srv0.stop();

  // ───────── v0.2 설정 파일(changeRequests 구역 없음) ─────────
  section('v0.2 때 만든 config(changeRequests 구역 없음) → 예전처럼 편집자도 기준에 바로 적용(allowDirectApply true) + 시작할 때 알림 한 줄');
  const srv2 = await startServer({ ai: 'off', config: { ...V3_DOCS, changeRequests: undefined } }); servers.push(srv2);   // undefined → JSON 에서 빠짐
  {
    const A2 = srv2.api('a');
    const c2 = await (await fetch(`${srv2.base}/api/config`)).json();
    const d2x = await uploadDoc(srv2.base, srv2.tokens.a, await buildMainDoc(), 'v02 설정.hwpx');
    const p2x = await A2(`/api/docs/${d2x.id}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을' } });
    const a2x = await A2(`/api/docs/${d2x.id}/proposals/${p2x.pid}/apply`, { method: 'POST' });
    ok(!('changeRequests' in JSON.parse(fs.readFileSync(srv2.configPath, 'utf-8'))) && c2.allowDirectApply === true && a2x.status === 'applied' && /changeRequests 구역이 없어/.test(srv2.output()),
      'config 에 changeRequests 없음 → allowDirectApply true, 편집자 REST apply 됨(v0.2 계약), 서버 로그에 알림');
    const { doc: w2, version: v2w } = await working(A2, d2x.id);
    const w2e = await w2.clone(); replaceIn(w2e, 's0/p7', '맺음말', '맺음말(올림)');
    const up2 = await A2.res(`/api/docs/${d2x.id}/upload?base=${v2w}`, { method: 'PUT', body: Buffer.from(await w2e.save()) });
    ok(up2.status === 200 && up2.data.version === v2w + 1, 'v0.2 설정: 편집자 PUT /upload 도 예전처럼 됨');
  }
  await srv2.stop();

  // ───────── 진짜 설정·자료 ─────────
  section('진짜 config.json·data/ 그대로');
  ok(stamp(realCfg) === before.cfg, `config.json 시각·크기 그대로(${before.cfg})`);
  ok(dataListing() === before.data, 'data/docs 목록·meta.json 시각 그대로');
  console.log(`\nAPI CR OK — ${passed}개 확인`);
} catch (e) {
  console.error('\nAPI CR FAILED:', e.stack || e.message);
  for (const s of servers) if (s.output) console.error(`--- 서버 ${s.base} 출력(끝) ---\n${s.output().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { agentA?.close(); } catch { /* ignore */ }
  for (const s of servers) await s.stop().catch(() => {});
}
