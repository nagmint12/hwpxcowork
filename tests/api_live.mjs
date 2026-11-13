// v0.4 실시간 공동 편집·문서 설정 시험 — docs/V4_SPEC.md §1(문서 설정·수정 권한)·§2.2·§2.3(밀어 넣기·실시간 글 적용)·§2.6(기록 파일 정리)·
// §3(한글로 저장 kind=export)·§4.2~§4.4(실시간 문서의 AI 반영·글 되돌리기·작업 기록 메모 두 꼴)·§5(실시간 문서의 변경 요청 반영)·§6(시험 목록).
// 서버는 시험 받침(tests/helpers/server.mjs)으로 빈 포트·임시 data·임시 config·모의 AI 로 띄운다(실제 API 를 부르지 않는다 — 요청은 route 'queue'
// 로 만들고 에이전트 몫은 MCP 도구로 한다). 임시 config 에는 documents 구역이 없다(= 사용자 config 와 같다 → 새 문서·옛 문서 모두 실시간).
// 편집기가 보내는 문서(밀어 넣기 본문)는 시험 안에서 엔진으로 만든다: /file?kind=working(+ X-Doc-Version) → 복제본에 글 고치기 → flattened → save
// → PUT /live?base=<X-Doc-Version>. 동시 편집은 같은 기준 기록에서 두 개를 만든다.
//  1) 설정 기본값·GET /api/docs·/:id 의 settings·canEdit·canConfigure · GET /api/users(토큰 없음) · MCP list_documents·read_document
//  2) PATCH /settings: 권한(올린 사람·관리자만)·검사(BAD_SETTING)·editors 정리·WS doc settings·기록 없음(활동만)
//  3) canEdit: 편집자 모두·지정한 사람·viewer·관리자·에이전트 — 밀어 넣기·수정본·반영·거절·resolve·MCP apply 403, 메모·AI 요청은 됨
//  4) 밀어 넣기(고친 글만): 같은 기준 → clean·변경 추적 없음·WS doc changed live·기록 '실시간 편집'(버전 없음) · 바꿀 것 없음 → 커밋 없음
//  5) 옛 기준 3-way(다른 문단·같은 문단 안 겹치지 않음) → clean false · 겹침은 나중 것(겹치지 않은 남의 고침은 남김) + conflicts·WS live-overwrite
//  6) 문단 넣기·지우기(고친 글만 = 문단을 지움, 메모가 달린 문단은 글만) · 표 칸 · GONE · 오류(BAD_BASE·EMPTY·BAD_FILE·STALE_BASE·NOT_REALTIME·403)
//  7) 처리 안 된 변경 추적: 고친 글만 — OVERLAP 이면 그 문단 것 수락 뒤 다시, 안 겹치면 그대로 · 변경 추적으로 — 사람마다 그 문단 변경 하나로 모임·
//     남의 변경은 그대로 · OVERLAP 이면 남의 것 수락 뒤 다시
//  7-1) 변경 추적으로 문단 지우기: 내가 넣은 문단은 문단째 · 빈 문단·글 문단은 최종본에서 없어지고(빈 줄 없음) 앞 문단 끝 '문단 나눔 지움' +
//       지운 글(2026-10-30 — 문단은 따로) · 문단 합치기 — clean · 표 문단 지우기도 '표 지움' 변경 추적(2026-10-30)
//  7-2) 변경 추적으로 표·그림·차트·도형(2026-10-30): 그림 문단 넣기·지우기(내가 넣은 것은 문단째)·표 문단/표만 지우기·도형(선) 지우기·차트 넣기/지우기
//       (도형·차트는 편집기 엔진 rhwp 로) → 개체 변경 추적(label '그림 넣음'·'표 지움' …) · 손대지 않은 작업본 → 커밋 없음·clean·편집기 왕복 0 ·
//       REST 수락·거절(formatVersion 오름, 작업본·추적본·꾸러미) · 한글로 저장 두 꼴 · 변경 요청 반영 · 옛 기준의 남이 지운 표 칸을 고침 → GONE
//       (넣고 지운 문단의 나눔도 '문단 나눔 넣음/지움' — 개체 변경과 따로 센다)
//  7-3) 변경 추적으로 문단 나눔(2026-10-30, 한/글 paraend="1"): S1 문단 지움(같은 ref 의 변경 둘·clean·왕복 0) · S2 REST 로 둘 다 거절 → 제 줄로·
//       뒤 문단 ref +1 · S3 문단 넣기·거절 → 빈 줄 없음 · S4 내가 넣은 문단 지움 → 0 · S5 연속 다섯 → 변경 10 · S6 합침·가름 · S7 표 문단 ·
//       S8 한글로 저장 두 꼴 · S9 고친 글만은 그대로 · S10 변경 요청 반영 · S11 묶음 문서의 다시 맞추기 · S12 두 사람 → GONE
//       · (2단계) S13 가운데 Enter = 나눔 넣음 하나·거절 → 한 문단 · S14 Backspace = 나눔 지움 하나·거절 → 두 문단 · S15 AI 표 제안 = 표 넣음 + 나눔 넣음
//  8) 기록 파일 정리(10분 안 기록은 200개까지 — 넘으면 잘린 기록 파일 지움 — 기록 1·이정표·진행 중 변경 요청 기준은 남김)
//  9) 한글로 저장 kind=export: 보이는 그대로(+ 메모)·변경 추적 포함·최종본을 못 만들면 X-Export-Fallback · 검토 메모는 승인 방식에서만
// 10) 실시간 문서의 AI 반영: 수정 권한 문(편집자도 바로)·고친 글만 = 수락(변경 추적 없음)·글 되돌리기(바꿈·지우기·문단 추가)·STALE · aiMemo 두 꼴
// 11) 실시간 문서의 변경 요청 반영은 승인 없이(수정 중인 것도) · 승인 방식 문서는 v0.3 그대로(NEED_APPROVAL·DIRECT_APPLY_FORBIDDEN·NOT_REALTIME)
// 12) 옛 문서(settings 없음)·모르는 값 → 기본값 · config.documents.defaultEditMode
// 진짜 config.json·data/ 는 쓰지 않는다 — 끝에 config.json 의 시각·크기와 data/docs 목록이 그대로인지 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { startServer, uploadDoc, watchWs, fixture, root } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { charOps } from '../engine/diff.js';
import { escapeText } from '../engine/xmlscan.js';
import { Service } from '../server/service.js';
import { fmtTime } from '../server/memotext.js';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const indent = (t) => String(t).replace(/\n/g, '\n      ');

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
const NO_EDIT = '이 문서의 수정 권한이 없습니다(문서 설정)';

/** 시험 문서: 도구 메모 문서를 평탄화하고 문단 5개를 더한 깨끗한 문서(변경 추적 없음, 메모 1 — s0/p0)
 *  s0/p0 첫째(메모) · p1 둘째 · p2 셋째 · p3 넷째(사업 개요를) · p4 다섯째(3월부터) · p5 여섯째(총 1억 원) · p6 일곱째(기대 효과를) · p7 여덟째(맺음말) */
async function buildMainDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const extra = ['넷째 문단: 사업 개요를 적습니다.', '다섯째 문단: 추진 일정은 3월부터 12월까지입니다.', '여섯째 문단: 예산은 총 1억 원입니다.', '일곱째 문단: 기대 효과를 정리합니다.', '여덟째 문단: 맺음말입니다.'];
  extra.forEach((t, i) => d.insertParagraphAfter(0, 2 + i, t, PREP));
  d.acceptAll();
  return Buffer.from(await d.save());
}
/** 표 문서: 본문 문단 + p4 뒤에 표 3×2(구분·값/가·1/나·2) */
async function buildTableDoc() {
  const d = await HwpxDoc.load(await buildMainDoc());
  d.insertTableAfter(0, 3, { rows: [['구분', '값'], ['가', '1'], ['나', '2']] }, PREP);
  d.acceptAll();
  return Buffer.from(await d.save());
}
/**
 * 잇닿은 칸 문단들(refs — 같은 칸의 차례대로 문단)을 글 목록 parts 의 문단들로 바꾼다 — 편집기에서 칸 안 Enter(나눔)·Backspace(합침)한 모양
 * (첫 문단의 문단·글자 모양을 빌림; 엔진에는 칸 문단 나누기가 없어 구역 XML 을 고친다 — engine6 시험과 같음). 문서 d 를 그 자리에서 고친다
 */
function setCellParas(d, refs, parts) {
  const first = d.resolve(refs[0]); const last = d.resolve(refs[refs.length - 1]);
  const { sec } = first; const xml = sec.xml.slice(first.p.start, first.p.end);
  const open = /^<hp:p\b[^>]*>/.exec(xml)[0];
  const charPr = /<hp:run\b[^>]*?charPrIDRef="([^"]*)"/.exec(xml)?.[1] ?? '0';
  const paras = parts.map((t) => `${open}<hp:run charPrIDRef="${charPr}">${t ? `<hp:t>${escapeText(t)}</hp:t>` : ''}</hp:run></hp:p>`).join('');
  sec.load(sec.xml.slice(0, first.p.start) + paras + sec.xml.slice(last.p.end));
}
/**
 * 서식 문서(사용자 회의록처럼 내용이 큰 표 하나에 — 본문 문단 하나가 표, 글은 모두 칸 문단): s0/p0 첫째(메모) · s0/p1 = 표 3×2
 * (회의일시·값 / 참석·값 / 내용·[문단 둘]) · 그 뒤 원래 문단 둘. 칸 문단: n0 회의일시 · n1 일시 · n2 참석 · n3 사람 · n4 내용 · n5·n6 내용 칸(2,1)
 */
const FORM_CELL = ['□ 회의 목적', '  ㅇ 1차 설문 자료 검토'];
async function buildFormDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  d.insertTableAfter(0, 0, { rows: [['회의일시', '2026. 10. 21.(수) 11:00'], ['참석', '김민준, 이서연'], ['내용', FORM_CELL[0]]] }, PREP);
  d.acceptAll();
  const r = await HwpxDoc.load(await d.save());
  setCellParas(r, ['s0/p1/n5'], FORM_CELL);
  return Buffer.from(await r.save());
}

/** 문단 ref 의 글자 ci 앞·뒤 원문 자리에 xml 을 끼운다(엔진 규칙을 거치지 않는 시험용 — engine5 시험과 같음) */
function inject(d, ref, ci, side, xml) {
  const { sec, p } = d.resolve(ref);
  const pos = side === 'before' ? p.chars[ci].raw[0] : p.chars[ci].raw[1];
  sec.load(sec.xml.slice(0, pos) + xml + sec.xml.slice(pos));
}
/** 최종본을 엄격히 만들 수 없는 문서: s0/p1 에서 시작해 s0/p2 에서 끝나는 삭제(SPANS_PARAGRAPH — 한글이 만든 문단 경계 변경) */
async function buildSpanDoc() {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const del = d.header.addChange('Delete', d.header.ensureAuthor('한글'), new Date(Date.UTC(2026, 9, 22, 1, 2, 3)));
  inject(d, 's0/p2', 3, 'after', `<hp:deleteEnd Id="${del}" TcId="${del}" paraend="1"/>`);
  inject(d, 's0/p1', 10, 'before', `<hp:deleteBegin Id="${del}" TcId="${del}"/>`);
  return Buffer.from(await d.save());
}

/** MCP JSON-RPC 한 번(무상태) → 도구 결과 { isError, text, json } */
async function mcp(base, token, name, args = {}, { agent = 'Claude Code', session } = {}) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
  if (session) h['X-Hwpx-Agent-Session'] = session;
  const r = await fetch(`${base}/mcp?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  let msg = null;
  try { const line = raw.split(/\r?\n/).find((l) => l.startsWith('data:')); msg = JSON.parse(line ? line.slice(5) : raw); } catch { /* JSON 아님 */ }
  if (r.status !== 200 || !msg) return { isError: true, text: raw, json: null };
  if (msg.error) return { isError: true, text: msg.error.message, json: null };
  const text = msg.result?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* 글 */ }
  return { isError: !!msg.result?.isError, text, json };
}
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
/** 편집기 내보내기 자리: 지금 작업본(기준 기록 = X-Doc-Version)에 edit 를 해 최종본으로 → { bytes, version } */
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
const push = (C, id, head, { base = head.version, seq } = {}) => C.res(`/api/docs/${id}/live?base=${base}${seq != null ? `&seq=${seq}` : ''}`, { method: 'PUT', body: head.bytes });
const parasOf = async (C, id) => (await C(`/api/docs/${id}/paragraphs?view=final`));
const textOf = async (C, id, ref) => (await parasOf(C, id)).find((p) => p.ref === ref)?.text ?? null;
const bodyTexts = async (C, id) => (await parasOf(C, id)).filter((p) => !p.parent).map((p) => p.text);
const memoText = async (C, id, memoId) => (await C(`/api/docs/${id}/memos`)).find((m) => m.id === memoId)?.text ?? '';
/** 문단 글 바꾸기 편집 한 번에 생기는 변경 추적 수(엔진 mergeParagraphText 와 같은 charOps — 바꿈 = 삭제 + 삽입) */
const changeCount = (a, b) => charOps(a, b).reduce((n, o) => n + (o.start === o.end ? 1 : o.text ? 2 : 1), 0);

// ───────── 편집기 엔진(rhwp, vendor/rhwp/pkg — tests/shapes_sync·chart_fidelity 시험과 같은 받침): 도형·차트 편집을 편집기 그대로 만든다 ─────────
let rhMod = null;
async function rhwp() {
  if (rhMod) return rhMod;
  const pkgDir = path.join(root, 'vendor', 'rhwp', 'pkg');
  globalThis.measureTextWidth ??= (font, text) => text.length * 10;
  rhMod = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
  if (!(globalThis.__rhwpEngineReady ??= new Set()).has(pkgDir)) { rhMod.initSync({ module: fs.readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) }); globalThis.__rhwpEngineReady.add(pkgDir); }
  return rhMod;
}
/** 편집기 내보내기 자리(rhwp): 지금 작업본을 편집기 엔진으로 열어 edit 하고 내보낸다 → { bytes, version, base(작업본 바이트) } */
async function editorHead(C, id, edit) {
  const mod = await rhwp();
  const w = await C.res(`/api/docs/${id}/file?kind=working`);
  if (w.status !== 200) throw new Error(`working 사본 ${w.status}`);
  const d = new mod.HwpDocument(new Uint8Array(w.data));
  edit(d);
  return { bytes: Buffer.from(d.exportHwpx()), version: Number(w.headers.get('x-doc-version')), base: Buffer.from(w.data) };
}
/** 편집기 문서의 그리기 개체(그림 제외) [{ p, ci, sp }] — 본문 구역 0 */
function rhShapes(d) {
  const out = [];
  for (let p = 0; p < d.getParagraphCount(0); p++) for (let ci = 0; ci < 12; ci++) {
    try { const sp = JSON.parse(d.getShapeProperties(0, p, ci)); if (sp && sp.width != null) out.push({ p, ci, sp }); } catch { /* 도형 아님 */ }
  }
  return out;
}
/** 꾸러미 점검(차트 부분·대체 OLE·매니페스트 — chart_fidelity 시험과 같은 규칙) → { charts, bins, problems } */
async function pkgCheck(bytes) {
  const z = await JSZip.loadAsync(bytes);
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
  const hpf = await z.file('Contents/content.hpf').async('string');
  const sec = (await Promise.all(names.filter((n) => /^Contents\/section\d+\.xml$/.test(n)).map((n) => z.file(n).async('string')))).join('');
  const items = [...hpf.matchAll(/<opf:item [^>]*>/g)].map((m) => m[0]).filter((s) => /href="BinData\//.test(s));
  const refs = [...sec.matchAll(/chartIDRef="([^"]+)"/g)].map((m) => m[1]);
  const binRefs = [...sec.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]);
  const charts = names.filter((n) => /^Chart\//.test(n)).sort(); const bins = names.filter((n) => /^BinData\//.test(n)).sort();
  const problems = [];
  for (const r of refs) if (!names.includes(r)) problems.push(`없는 차트 부분: ${r}`);
  for (const c of charts) if (!refs.includes(c)) problems.push(`남은 차트 부분: ${c}`);
  for (const it of items) {
    const iid = /\bid="([^"]+)"/.exec(it)[1]; const href = /href="([^"]+)"/.exec(it)[1];
    if (!binRefs.includes(iid)) problems.push(`남은 매니페스트 항목: ${href}`);
    if (!names.includes(href)) problems.push(`파일 없는 매니페스트 항목: ${href}`);
  }
  for (const b of bins) if (!items.some((s) => s.includes(`href="${b}"`))) problems.push(`매니페스트에 없는 BinData: ${b}`);
  return { charts, bins, refs, problems, sec };
}

const USERS = [
  { name: '관리자', role: 'admin' },
  { name: '홍길동', role: 'editor' },
  { name: '김검토', role: 'editor' },
  { name: '박보기', role: 'viewer' },
  { name: '최편집', role: 'editor' },
];

const servers = [];
const sockets = [];
try {
  const srv = await startServer({ ai: 'mock', users: USERS }); servers.push(srv);
  const tok = (name) => srv.userList.find((u) => u.name === name).token;
  const A = srv.api('a'); const B = srv.api('b'); const ADM = srv.api('admin');
  const V = srv.api(tok('박보기')); const C = srv.api(tok('최편집'));
  const nameA = srv.users.a.name; const nameB = srv.users.b.name;
  const TA = srv.tokens.a; const TC = tok('최편집');
  const AG = { agent: 'Claude Code', session: 'liveA' };

  // ───────── 1. 설정 기본값 · 문서 정보 · 사람 목록 · MCP ─────────
  section('설정 기본값(사용자 config 처럼 documents 구역 없음 → 실시간) · GET /api/docs·/:id 의 settings·canEdit·canConfigure · GET /api/users · MCP');
  const dL = await uploadDoc(srv.base, TA, await buildMainDoc(), '실시간 회의록.hwpx');
  const DL = `/api/docs/${dL.id}`;
  const DEF = { editMode: 'realtime', editors: 'all', track: 'final', exportKind: 'final', aiMemo: 'summary', aiQuick: 'send', aiApply: 'manual' };
  ok(eq(dL.settings, DEF) && dL.canEdit === true && dL.canConfigure === true, `올린 응답: settings ${JSON.stringify(dL.settings)} · canEdit · canConfigure(올린 사람)`);
  const listAs = async (X) => (await X('/api/docs')).find((d) => d.id === dL.id);
  const [lB, lV, lC, lAdm] = [await listAs(B), await listAs(V), await listAs(C), await listAs(ADM)];
  ok(eq(lB.settings, DEF) && lB.canEdit && !lB.canConfigure && !lV.canEdit && !lV.canConfigure && lC.canEdit && !lC.canConfigure && lAdm.canEdit && lAdm.canConfigure,
    'GET /api/docs: 편집자 canEdit(설정은 못 바꿈) · viewer 읽기 전용 · 관리자 둘 다');
  const infoV = await V(DL);
  ok(eq(infoV.settings, DEF) && infoV.canEdit === false && infoV.canConfigure === false && infoV.version === 1, 'GET /api/docs/:id(viewer) 도 settings·canEdit·canConfigure');
  const users = await B('/api/users');
  const usersRaw = JSON.stringify(users);
  ok(eq(users, USERS.map((u) => ({ name: u.name, role: u.role }))) && users.every((u) => eq(Object.keys(u).sort(), ['name', 'role']))
    && srv.userList.every((u) => !usersRaw.includes(u.token)), `GET /api/users → [{ name, role }] ${users.length}명 — 토큰 없음`);
  ok((await srv.api(null).res('/api/users')).status === 401, 'GET /api/users 는 로그인해야');
  const ld = await mcpOk(srv.base, srv.tokens.b, 'list_documents', {});
  const ldL = ld.find((x) => x.id === dL.id);
  ok(eq(ldL.settings, DEF) && ldL.canEdit === true, 'MCP list_documents 에 settings·canEdit(부른 사람 기준)');
  const rd = await mcp(srv.base, tok('박보기'), 'read_document', { doc_id: dL.id });
  const rdLine = rd.text.split('\n')[1] || '';
  ok(!rd.isError && rdLine.startsWith('문서 정보: ') && eq(JSON.parse(rdLine.slice('문서 정보: '.length)), { settings: DEF, canEdit: false }) && rd.text.includes('[s0/p3] 넷째 문단'),
    `MCP read_document 둘째 줄: ${rdLine}`);

  // ───────── 2. PATCH /settings ─────────
  section('PATCH /settings: 올린 사람·관리자만 · 값 검사 400 BAD_SETTING · editors 정리 · WS doc settings · 기록·버전 없음(활동만)');
  const wsB = watchWs(srv.base, srv.tokens.b, dL.id); sockets.push(wsB); await wsB.ready;
  const wsA = watchWs(srv.base, TA, dL.id); sockets.push(wsA); await wsA.ready;
  const SET = `${DL}/settings`;
  const denied = [await B.res(SET, { method: 'PATCH', body: { track: 'tracked' } }), await V.res(SET, { method: 'PATCH', body: { track: 'tracked' } })];
  ok(denied.every((r) => r.status === 403 && r.data.error === 'FORBIDDEN'), '편집자(올린 사람 아님)·viewer → 403 FORBIDDEN');
  const badBodies = [{}, { foo: 1 }, { editMode: 'live' }, { track: 1 }, { exportKind: null }, { aiMemo: 'short' }, { aiQuick: 'auto' }, { aiQuick: true }, { editors: 'some' }, { editors: [1] },
    { editors: ['가'.repeat(101)] }, { editors: Array.from({ length: 201 }, (_, i) => `사람${i}`) }];
  const badRes = [];
  for (const body of badBodies) badRes.push(await A.res(SET, { method: 'PATCH', body }));
  ok(badRes.every((r) => r.status === 400 && r.data.error === 'BAD_SETTING'), `잘못된 값 ${badBodies.length}가지 → 400 BAD_SETTING(${badRes.map((r) => r.status).join(',')})`);
  ok(eq((await A(DL)).settings, DEF), '막힌 PATCH 는 아무것도 바꾸지 않음');
  const v0 = (await A(DL)).version; const hist0 = await A(`${DL}/history`);
  const ps1 = await A(SET, { method: 'PATCH', body: { editors: ['홍길동', ' 김검토 ', '홍길동', '', '없는 사람'], foo: 'bar' } });
  ok(eq(ps1.settings.editors, ['홍길동', '김검토', '없는 사람']) && ps1.settings.editMode === 'realtime', `editors 정리(앞뒤 공백·중복·빈 이름 — config 에 없는 이름도 받음, 모르는 키는 건너뜀): ${JSON.stringify(ps1.settings.editors)}`);
  const wsSet = await wsB.waitFor((m) => m.type === 'doc' && m.action === 'settings');
  ok(eq(wsSet.settings, ps1.settings) && wsSet.by === nameA, 'WS { type: doc, action: settings, settings, by }');
  const hist1 = await A(`${DL}/history`);
  ok((await A(DL)).version === v0 && hist1.versions.length === hist0.versions.length && hist1.milestones.length === hist0.milestones.length && hist1.activity[0]?.type === 'settings' && /수정 권한 지정한 사람 3명/.test(hist1.activity[0].detail),
    `설정 바꾸기는 기록·버전을 만들지 않음(활동 기록만: ${hist1.activity[0]?.detail})`);
  const ps2 = await ADM(SET, { method: 'PATCH', body: { editors: 'all' } });
  ok(eq(ps2.settings, DEF), '관리자도 바꿀 수 있음(editors → all)');
  const nWs = wsB.msgs.filter((m) => m.type === 'doc' && m.action === 'settings').length;
  const ps3 = await A(SET, { method: 'PATCH', body: { editMode: 'realtime' } });
  await new Promise((r) => setTimeout(r, 150));
  ok(eq(ps3.settings, DEF) && wsB.msgs.filter((m) => m.type === 'doc' && m.action === 'settings').length === nWs, '같은 값이면 { settings } 만(알림 없음)');
  // AI 빠른 작업(aiQuick): 'send'(기본, 누르면 바로 보내기) ↔ 'compose'(요청 창에서 확인 후) — 화면만 쓰는 설정. 활동 기록·WS 는 다른 설정과 같다
  const pq = await A(SET, { method: 'PATCH', body: { aiQuick: 'compose' } });
  const wsQ = await wsB.waitFor((m) => m.type === 'doc' && m.action === 'settings' && m.settings?.aiQuick === 'compose');
  const histQ = await A(`${DL}/history`);
  ok(eq(pq.settings, { ...DEF, aiQuick: 'compose' }) && wsQ.by === nameA && histQ.activity[0]?.type === 'settings' && histQ.activity[0].detail === 'AI 빠른 작업 누르면 바로 보내기 → 요청 창에서 확인 후 보내기',
    `aiQuick → compose: WS 로 열린 창들에 알림 · 활동 기록 「${histQ.activity[0]?.detail}」`);
  ok(eq((await B(DL)).settings.aiQuick, 'compose') && eq((await A(SET, { method: 'PATCH', body: { aiQuick: 'send' } })).settings, DEF), 'aiQuick 은 GET 에도 · 다시 send');

  // ───────── 3. canEdit ─────────
  section('canEdit: 편집자 모두 · 지정한 사람 · viewer(어디서나 읽기 전용) · 관리자(언제나) · 에이전트(그 사용자 권한)');
  await A(SET, { method: 'PATCH', body: { editors: ['홍길동', '김검토', '박보기'] } });
  const pC = await C(`${DL}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '맺는말' } });
  const headC = await makeHead(C, dL.id, (d) => replaceIn(d, 's0/p6', '정리합니다', '정리해 둡니다'));
  const cDenied = {
    live: await push(C, dL.id, headC),
    draft: await C.res(`${DL}/drafts/mine?base=${headC.version}`, { method: 'PUT', body: headC.bytes }),
    apply: await C.res(`${DL}/proposals/${pC.pid}/apply`, { method: 'POST' }),
    reject: await C.res(`${DL}/proposals/${pC.pid}/reject`, { method: 'POST' }),
    applyNow: await C.res(`${DL}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '끝말', applyNow: true } }),
    upload: await C.res(`${DL}/upload?base=${headC.version}`, { method: 'PUT', body: headC.bytes }),
  };
  ok(Object.values(cDenied).every((r) => r.status === 403 && r.data.error === 'FORBIDDEN' && r.data.message === NO_EDIT),
    `지정한 사람에 없는 편집자 → 밀어 넣기·수정본·적용·거절·applyNow·편집본 올리기 모두 403 FORBIDDEN 「${NO_EDIT}」`);
  const mcpC = await mcp(srv.base, TC, 'apply_proposal', { doc_id: dL.id, proposal_id: pC.pid });
  ok(mcpC.isError && mcpC.text.startsWith('오류(FORBIDDEN)'), `그 사람의 에이전트 MCP apply_proposal 도 막힘: ${mcpC.text.slice(0, 40)}`);
  const memoC = await C(`${DL}/memos`, { method: 'POST', body: { ref: 's0/p6', text: '최편집 의견' } });
  const reqC = await C(`${DL}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 주세요', target: { ref: 's0/p6' }, route: 'queue' } });
  ok(memoC.id && reqC.queued === true, '수정 권한이 없어도 메모·AI 요청은 됨');
  const vHead = await makeHead(V, dL.id, (d) => replaceIn(d, 's0/p6', '정리합니다', '정리해 둡니다'));
  const vLive = await push(V, dL.id, vHead);
  const vInfo = await V(DL);
  ok(vLive.status === 403 && vLive.data.error === 'FORBIDDEN' && vInfo.canEdit === false, 'viewer 는 지정한 사람 목록에 이름이 있어도 읽기 전용(403)');
  const admInfo = await ADM(DL); const cInfo = await C(DL); const bInfo = await B(DL);
  ok(admInfo.canEdit && !cInfo.canEdit && bInfo.canEdit, '관리자는 목록에 없어도 canEdit · 목록에 없는 편집자 false · 있는 편집자 true');
  await A(SET, { method: 'PATCH', body: { editors: 'all' } });
  ok((await C(DL)).canEdit === true, "다시 '편집자 모두' → canEdit");
  await A(`${DL}/memos/${memoC.id}`, { method: 'DELETE', token: srv.tokens.admin });
  await ADM(`${DL}/requests/${reqC.request.rid}/cancel`, { method: 'POST' });
  await A(`${DL}/proposals/${pC.pid}/reject`, { method: 'POST' });

  // ───────── 4. 밀어 넣기 — 같은 기준 ─────────
  section('밀어 넣기(고친 글만): 같은 기준 → clean · 변경 추적 없음 · WS doc changed live · 기록 \'실시간 편집\'(버전 없음) · 바꿀 것 없음 → 커밋 없음');
  const h1 = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을'));
  const ms0 = (await A(`${DL}/history`)).milestones.length;
  const r1 = await push(A, dL.id, h1, { seq: 1 });
  ok(r1.status === 200 && r1.data.version === h1.version + 1 && r1.data.clean === true && eq(r1.data.applied, { changed: ['s0/p3'], inserted: [], deleted: [] })
    && eq(r1.data.skipped, []) && eq(r1.data.conflicts, []) && r1.data.unsupported === 0 && r1.data.seq === 1,
  `PUT /live → ${JSON.stringify(r1.data)}`);
  ok(await textOf(B, dL.id, 's0/p3') === '넷째 문단: 사업 개요와 배경을 적습니다.' && (await A(`${DL}/changes`)).length === 0, '공유 문서에 바로 들어감 · 변경 추적 없음(고친 글만)');
  const wsCh = await wsB.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.version === r1.data.version);
  ok(wsCh.live === true && wsCh.by === nameA && eq(wsCh.changed, ['s0/p3']) && eq(wsCh.inserted, []) && eq(wsCh.deleted, []) && wsCh.seq === 1, 'WS doc changed { live: true, by, changed, inserted, deleted, seq }');
  const hist2 = await A(`${DL}/history`);
  ok(hist2.versions.at(-1).note === '실시간 편집' && hist2.versions.at(-1).by === nameA && hist2.milestones.length === ms0 && (await A(DL)).sinceMilestone === r1.data.version - 1,
    "기록 하나(note '실시간 편집') — 사람용 버전은 오르지 않음");
  const r1b = await push(A, dL.id, h1);
  ok(r1b.status === 200 && r1b.data.version === r1.data.version && r1b.data.clean === true && eq(r1b.data.applied, { changed: [], inserted: [], deleted: [] }), '같은 글을 다시 보내면 커밋 없이 { version: 지금, clean, applied: 빈 것 }');
  const hSame = await makeHead(A, dL.id, () => {});
  const r1c = await push(A, dL.id, hSame);
  ok(r1c.status === 200 && r1c.data.version === r1.data.version && r1c.data.clean === true, '고친 것 없는 밀어 넣기 → 커밋 없음');

  // ───────── 5. 옛 기준 3-way · 겹침 ─────────
  section('옛 기준 3-way: 다른 문단·같은 문단 안 겹치지 않는 고침은 합침(clean false) · 겹치면 나중 것(겹치지 않은 남의 고침은 남김) + conflicts·WS live-overwrite');
  let hA = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p4', '3월부터', '4월부터'));
  let hB = await makeHead(B, dL.id, (d) => replaceIn(d, 's0/p5', '1억 원', '1억 2천만 원'));
  const r2a = await push(A, dL.id, hA); const r2b = await push(B, dL.id, hB);
  ok(r2a.data.clean && r2b.status === 200 && r2b.data.version === r2a.data.version + 1 && r2b.data.clean === false && eq(r2b.data.applied.changed, ['s0/p5']),
    `같은 기준 두 편집기(다른 문단): 뒤에 보낸 쪽 clean false(남의 고침이 섞임) ${JSON.stringify(r2b.data.applied)}`);
  ok(await textOf(A, dL.id, 's0/p4') === '다섯째 문단: 추진 일정은 4월부터 12월까지입니다.' && await textOf(A, dL.id, 's0/p5') === '여섯째 문단: 예산은 총 1억 2천만 원입니다.', '두 고침 모두 문서에');
  hA = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p6', '일곱째', '일곱 번째'));
  hB = await makeHead(B, dL.id, (d) => replaceIn(d, 's0/p6', '정리합니다', '정리해 둡니다'));
  await push(A, dL.id, hA); const r3b = await push(B, dL.id, hB);
  ok(r3b.status === 200 && eq(r3b.data.conflicts, []) && r3b.data.clean === false && await textOf(A, dL.id, 's0/p6') === '일곱 번째 문단: 기대 효과를 정리해 둡니다.',
    '같은 문단 안 겹치지 않는 고침 → 글자 단위 3-way 로 둘 다(conflicts 없음)');
  hA = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p7', '맺음말입니다.', '맺는말입니다!'));
  hB = await makeHead(B, dL.id, (d) => replaceIn(d, 's0/p7', '맺음말', '맺을말'));
  const r4a = await push(A, dL.id, hA); const r4b = await push(B, dL.id, hB);
  ok(r4a.data.clean && r4b.status === 200 && eq(r4b.data.conflicts, [{ ref: 's0/p7', by: nameB, to: nameA }]) && r4b.data.version === r4a.data.version + 1,
    `겹침 → 보낸 글(나중에 친 사람)이 이김 · conflicts ${JSON.stringify(r4b.data.conflicts)}`);
  ok(await textOf(A, dL.id, 's0/p7') === '여덟째 문단: 맺을말입니다!', '겹친 자리만 나중 글(맺을말), 겹치지 않은 남의 고침(! )은 남음');
  const ov = await wsA.waitFor((m) => m.type === 'doc' && m.action === 'live-overwrite');
  ok(ov.ref === 's0/p7' && ov.by === nameB && ov.to === nameA, `WS live-overwrite { ref, by: 덮어쓴 사람, to: 그 문단을 친 사람 } → ${JSON.stringify({ ref: ov.ref, by: ov.by, to: ov.to })}`);
  // 같은 사람의 두 창: 겹쳐도 알림 받을 사람이 없음(to null)
  hA = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p7', '맺을말', '맺는말'));
  const hA2 = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p7', '맺을말', '맺힌말'));
  await push(A, dL.id, hA); const r5 = await push(A, dL.id, hA2);
  ok(r5.status === 200 && eq(r5.data.conflicts, [{ ref: 's0/p7', by: nameA, to: null }]) && await textOf(A, dL.id, 's0/p7') === '여덟째 문단: 맺힌말입니다!', '같은 사람의 두 창도 남과 같은 규칙(겹치면 나중 것) — 알릴 사람 없음(to null)');

  // ───────── 6. 문단 넣기·지우기 · 표 칸 · GONE · 오류 ─────────
  section('문단 넣기·지우기(고친 글만 = 문단째 지움, 메모가 달린 문단은 글만) · 표 칸 · GONE · 오류');
  // 지금 s0/p6(작업 기록 메모)·s0/p7(제안 메모)에는 3절에서 단 메모가 있다 — 메모 없는 s0/p4(다섯째)를 지운다
  const nBefore = (await bodyTexts(A, dL.id)).length;
  const h6 = await makeHead(A, dL.id, (d) => { d.removeBodyParagraph(0, 4); d.insertParagraphAfter(0, 2, '새로 넣은 문단입니다.', ED); });
  const r6 = await push(A, dL.id, h6);
  const after6 = await bodyTexts(A, dL.id);
  const ch6 = await A(`${DL}/changes`);
  ok(r6.status === 200 && r6.data.clean === true && eq(r6.data.applied.inserted, ['s0/p3']) && r6.data.applied.deleted.length === 1 && after6.length === nBefore
    && after6[3] === '새로 넣은 문단입니다.' && !after6.some((t) => t.startsWith('다섯째')) && ch6.length === 0,
  `문단 하나 넣고 하나 지움 → 문단 수 ${nBefore} 그대로, 지운 문단은 없어짐(변경 추적 없음) ${JSON.stringify(r6.data.applied)}`);
  const memoP = await B(`${DL}/memos`, { method: 'POST', body: { ref: 's0/p5', text: '예산 근거 확인' } });
  const h7 = await makeHead(A, dL.id, (d) => d.removeBodyParagraph(0, 5));
  const r7 = await push(A, dL.id, h7);
  const after7 = await bodyTexts(A, dL.id);
  // (2026-10-30 — 편집기에서 메모째 지운 문단은 메모도 지운다: 내용을 지우면 메모도. 종전에는 글만 지우고 빈 문단·메모를 남겨 clean false)
  ok(r7.status === 200 && r7.data.clean === true && eq(r7.data.applied.deleted, ['s0/p5']) && after7.length === nBefore - 1
    && !(await A(`${DL}/memos`)).some((m) => m.id === memoP.id),
  `메모가 달린 문단을 메모째 지우면 문단·메모 모두 지운다 — clean ${JSON.stringify(r7.data)}`);
  // 표 칸
  const dT = await uploadDoc(srv.base, TA, await buildTableDoc(), '표 실시간.hwpx');
  const cells = (await parasOf(A, dT.id)).filter((p) => p.cell && p.cell.row === 1 && p.cell.col === 1);
  const cellRef = cells[0]?.ref;
  const hT = await makeHead(A, dT.id, (d) => d.mergeParagraphText(cellRef, '10', ED));
  const rT = await push(A, dT.id, hT);
  ok(rT.status === 200 && rT.data.clean && eq(rT.data.applied.changed, [cellRef]) && await textOf(A, dT.id, cellRef) === '10' && (await A(`/api/docs/${dT.id}/changes`)).length === 0,
    `표 칸(${cellRef}) 글 바꿈 → 칸에 바로`);
  // GONE: B 가 고치는 사이 A 가 그 문단을 지움(지금 s0/p3 = 넣은 문단 — 메모 없음)
  const hG = await makeHead(B, dL.id, (d) => replaceIn(d, 's0/p3', '새로 넣은', '새로 끼운'));
  const hDel = await makeHead(A, dL.id, (d) => d.removeBodyParagraph(0, 3));
  const rDel = await push(A, dL.id, hDel); const rG = await push(B, dL.id, hG);
  ok(rDel.data.clean && rG.status === 200 && rG.data.version === rDel.data.version && rG.data.skipped.length === 1 && rG.data.skipped[0].reason === 'GONE'
    && rG.data.clean === false && eq(rG.data.applied, { changed: [], inserted: [], deleted: [] }),
  `남이 지운 문단을 고친 밀어 넣기 → skipped GONE · 커밋 없음 · clean false ${JSON.stringify(rG.data.skipped)}`);
  // 오류
  const hE = await makeHead(A, dL.id, (d) => replaceIn(d, 's0/p3', '배경을', '배경과 목적을'));
  const errs = {
    badBase: await A.res(`${DL}/live?base=abc`, { method: 'PUT', body: hE.bytes }),
    noBase: await A.res(`${DL}/live`, { method: 'PUT', body: hE.bytes }),
    future: await push(A, dL.id, hE, { base: 99999 }),
    empty: await A.res(`${DL}/live?base=${hE.version}`, { method: 'PUT', body: Buffer.alloc(0) }),
    badFile: await A.res(`${DL}/live?base=${hE.version}`, { method: 'PUT', body: Buffer.from('not a hwpx') }),
    noDoc: await A.res(`/api/docs/nosuchdoc/live?base=1`, { method: 'PUT', body: hE.bytes }),
  };
  ok(errs.badBase.status === 400 && errs.badBase.data.error === 'BAD_BASE' && errs.noBase.data.error === 'BAD_BASE' && errs.future.status === 400 && errs.future.data.error === 'BAD_BASE'
    && errs.empty.status === 400 && errs.empty.data.error === 'EMPTY' && errs.badFile.status === 400 && errs.badFile.data.error === 'BAD_FILE' && errs.noDoc.status === 404,
  `오류: base 숫자 아님·없음·지금보다 큼 → 400 BAD_BASE · 빈 본문 400 EMPTY · HWPX 아님 400 BAD_FILE · 없는 문서 404`);
  const vNow = (await A(DL)).version;
  const oldBase = (await A(`${DL}/history`)).versions.find((x) => x.n > 1 && x.n < vNow).n;
  const hOld = { bytes: hE.bytes, version: oldBase };
  fs.rmSync(path.join(srv.dataDir, 'docs', dL.id, 'versions', `${oldBase}.hwpx`));
  const rStale = await push(A, dL.id, hOld);
  ok(rStale.status === 409 && rStale.data.error === 'STALE_BASE' && rStale.data.baseVersion === vNow && (await A(DL)).version === vNow,
    `기준 기록 파일이 없으면 409 STALE_BASE { baseVersion: 지금 기록 ${rStale.data.baseVersion} }`);
  const rOk = await push(A, dL.id, hE);
  ok(rOk.status === 200 && rOk.data.clean, '(대조) 지금 기준이면 됨');

  // ───────── 7. 처리 안 된 변경 추적 ─────────
  section("처리 안 된 변경 추적: 고친 글만 — OVERLAP 이면 그 문단 것 수락 뒤 다시, 안 겹치면 그대로 · 변경 추적으로 — 사람마다 그 문단 변경 하나로 모임·OVERLAP 이면 남의 것 수락 뒤 다시");
  const dF = await uploadDoc(srv.base, TA, fs.readFileSync(FX), '옛 변경 추적(고친 글만).hwpx');
  const DF = `/api/docs/${dF.id}`;
  const chF0 = await A(`${DF}/changes`);
  ok(chF0.length === 4 && chF0.filter((c) => c.ref === 's0/p1').length === 2 && chF0.filter((c) => c.ref === 's0/p2').length === 2, '(전제) 옛 문서: s0/p1·s0/p2 에 처리 안 된 변경 추적 2건씩');
  const hF1 = await makeHead(A, dF.id, (d) => replaceIn(d, 's0/p1', '추가한', '더한'));
  const rF1 = await push(A, dF.id, hF1);
  const chF1 = await A(`${DF}/changes`);
  ok(rF1.status === 200 && rF1.data.clean && chF1.length === 2 && chF1.every((c) => c.ref === 's0/p2' && c.author === 'AI 검토자')
    && await textOf(A, dF.id, 's0/p1') === '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 더한 문장)',
  '남의 삽입 글 안을 고침(OVERLAP) → 그 문단 변경 추적을 먼저 수락하고 다시 — s0/p1 변경 추적 0, 다른 문단 것은 그대로');
  const hF2 = await makeHead(A, dF.id, (d) => replaceIn(d, 's0/p2', '둡니다.', '둡니다!'));
  const rF2 = await push(A, dF.id, hF2);
  const chF2 = await A(`${DF}/changes`);
  ok(rF2.status === 200 && chF2.length === 2 && chF2.every((c) => c.ref === 's0/p2' && c.author === 'AI 검토자') && await textOf(A, dF.id, 's0/p2') === '셋째 문단은 AI 제안대로 둡니다!',
    '안 겹치는 자리를 고치면 그 문단의 남의 변경 추적은 그대로(고친 글만 = 내 고침만 수락)');
  // 변경 추적으로
  const dK = await uploadDoc(srv.base, TA, fs.readFileSync(FX), '변경 추적 실시간.hwpx');
  const DK = `/api/docs/${dK.id}`;
  await A(`${DK}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const P0 = '첫째 문단입니다. 메모 대상 문장이 여기 있습니다.';
  const k1 = await makeHead(A, dK.id, (d) => replaceIn(d, 's0/p0', '여기 있습니다', '여기에 있습니다'));
  const rk1 = await push(A, dK.id, k1);
  const mineIn = (list, who, ref = 's0/p0') => list.filter((c) => c.ref === ref && c.author === who);
  ok(rk1.status === 200 && rk1.data.clean && mineIn(await A(`${DK}/changes`), nameA).length === changeCount(P0, '첫째 문단입니다. 메모 대상 문장이 여기에 있습니다.'), "변경 추적으로: 친 글이 변경 추적(작성자 = 친 사람)으로 들어감");
  const k2 = await makeHead(A, dK.id, (d) => replaceIn(d, 's0/p0', '여기에 있습니다', '여기에 모두 있습니다'));
  await push(A, dK.id, k2);
  const P0a = '첫째 문단입니다. 메모 대상 문장이 여기에 모두 있습니다.';
  const chK2 = mineIn(await A(`${DK}/changes`), nameA);
  ok(chK2.length === changeCount(P0, P0a) && chK2.filter((c) => c.type === 'Insert').sort((x, y) => x.start - y.start).map((c) => c.text).join('') === charOps(P0, P0a).map((o) => o.text).join(''),
    `같은 사람이 같은 문단을 또 고치면 그 사람의 변경이 '그 문단을 바꾼 전체' 하나로 모임(변경 ${chK2.length}건: ${chK2.map((c) => `${c.type} 「${c.text}」`).join(', ')})`);
  const k3 = await makeHead(B, dK.id, (d) => replaceIn(d, 's0/p0', '첫째 문단입니다.', '첫째 문단입니다!'));
  await push(B, dK.id, k3);
  const k4 = await makeHead(A, dK.id, (d) => replaceIn(d, 's0/p0', '모두', '전부'));
  const rk4 = await push(A, dK.id, k4);
  const chK4 = await A(`${DK}/changes`);
  const P0b = '첫째 문단입니다! 메모 대상 문장이 여기에 전부 있습니다.';
  const withB = '첫째 문단입니다! 메모 대상 문장이 여기 있습니다.';
  ok(rk4.status === 200 && await textOf(A, dK.id, 's0/p0') === P0b && mineIn(chK4, nameB).length === changeCount(P0, withB) && mineIn(chK4, nameA).length === changeCount(withB, P0b),
    `남(김검토)의 변경은 그대로, 내(홍길동) 것은 다시 하나로 — ${mineIn(chK4, nameA).length}건 + ${mineIn(chK4, nameB).length}건`);
  const k5 = await makeHead(B, dK.id, (d) => replaceIn(d, 's0/p2', '제안대로', '제안처럼'));
  const rk5 = await push(B, dK.id, k5);
  const chK5 = await A(`${DK}/changes`);
  ok(rk5.status === 200 && chK5.filter((c) => c.ref === 's0/p2').every((c) => c.author === nameB) && chK5.some((c) => c.ref === 's0/p2') && !chK5.some((c) => c.author === 'AI 검토자')
    && chK5.filter((c) => c.ref === 's0/p1').length === 2 && await textOf(A, dK.id, 's0/p2') === '셋째 문단은 AI 제안처럼 둡니다.',
  '남의 변경 글 안을 고침(OVERLAP) → 그 문단의 남의 변경을 수락하고 다시(내 고침만 변경 추적) · 다른 문단의 변경은 그대로');

  // ───────── 7-1. 변경 추적으로 — 문단 지우기 ─────────
  section('변경 추적으로 문단 지우기: 빈 문단·내가 넣은 문단은 문단째 · 글 문단은 지운 글(변경 추적)을 앞 문단 끝에 붙이고 문단은 없앰 · 문단 합치기 — 최종본에 빈 줄이 남지 않음(clean)');
  // 시험 문서 + 빈 문단 셋(s0/p5~p7, 변경 추적 없음): …p4 다섯째 · p5~p7 빈 줄 · p8 여섯째 · p9 일곱째 · p10 여덟째
  const eBase = await HwpxDoc.load(await buildMainDoc());
  for (let k = 0; k < 3; k++) eBase.insertParagraphAfter(0, 4, '', PREP);
  const dE = await uploadDoc(srv.base, TA, Buffer.from(await (await eBase.flattened()).save()), '변경 추적 문단 지우기.hwpx');
  const DE = `/api/docs/${dE.id}`;
  await A(`${DE}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const eTexts0 = await bodyTexts(A, dE.id);
  ok(eTexts0.length === 11 && eq(eTexts0.slice(5, 8), ['', '', '']) && (await A(`${DE}/changes`)).length === 0, '(전제) 빈 문단 셋이 든 변경 추적 문서');
  // 1) 빈 문단 셋을 한꺼번에 지움(편집기 끌어 지우기) — 전에는 남길 변경이 없어 아무것도 바뀌지 않고 맞추기로 되살아났다
  const re1 = await push(A, dE.id, await makeHead(A, dE.id, (d) => { for (const i of [7, 6, 5]) d.removeBodyParagraph(0, i); }));
  const eTexts1 = await bodyTexts(A, dE.id); const ch1 = await A(`${DE}/changes`);
  // (2026-10-30 문단 나눔 변경 추적) 빈 줄 지우기도 한/글처럼 '문단 나눔 지움' 셋으로 남는다(최종본에는 빈 줄 없음 — 빈 문단끼리는
  // 한/글처럼 빈 문단 자기 나눔을 지워 뒤 문단 속성이 남으므로 다섯째(s0/p4)·여섯째(s0/p5) 쪽에 나뉨)
  ok(re1.status === 200 && re1.data.clean === true && re1.data.applied.deleted.length >= 1 && eTexts1.length === 8 && !eTexts1.includes('')
    && ch1.length === 3 && ch1.every((c) => c.kind === 'para' && c.type === 'Delete' && c.author === nameA && (c.ref === 's0/p4' || c.ref === 's0/p5')),
    `빈 문단 셋 지움 → 최종본에서 없어짐(11 → ${eTexts1.length}) · 문단 나눔 지움 셋(${ch1.map((c) => `#${c.id} ${c.label || c.type} ${c.ref}@${c.start}`).join(", ")}) · clean ${JSON.stringify(re1.data.applied)}`);
  // 2) 글 문단(넷째, s0/p3)을 지움 → 지운 글은 변경 추적(작성자 = 친 사람)으로 남고 최종본에서는 앞 문단(셋째)과 한 문단 —
  //    (2026-10-30) 문단은 따로 남고 앞 문단 끝의 나눔이 지움 표식(같은 ref s0/p2 의 변경 둘: 나눔 지움 + 글 지움)
  const P3 = '넷째 문단: 사업 개요를 적습니다.';
  const re2 = await push(A, dE.id, await makeHead(A, dE.id, (d) => d.removeBodyParagraph(0, 3)));
  const eTexts2 = await bodyTexts(A, dE.id); const ch2all = await A(`${DE}/changes`); const ch2 = ch2all.filter((c) => c.ref === 's0/p2');
  const ch2t = ch2.find((c) => !c.kind);
  ok(re2.status === 200 && re2.data.clean === true && eq(re2.data.applied.deleted, ['s0/p3']) && eTexts2.length === 7 && !eTexts2.includes(P3) && !eTexts2.includes('')
    && eTexts2[2] === eTexts1[2] && ch2.length === 2 && ch2.every((c) => c.type === 'Delete' && c.author === nameA) && ch2.some((c) => c.kind === 'para')
    && ch2t?.text === P3 && ch2all.length === 5,
  `글 문단 지움 → 최종본에서 없어지고(빈 줄 없음) 지운 글은 같은 ref 의 나눔 지움 + 글 지움 「${ch2t?.text}」(${ch2t?.ref})`);
  const ex2 = await HwpxDoc.load((await A.res(`${DE}/file?kind=tracked`)).data);
  ok(ex2.text('s0/p2', 'final') === eTexts1[2] && ex2.text('s0/p2', 'markup') === `${eTexts1[2]}[-¶-][-${P3}-]` && (await ex2.flattened()).bodyTexts()[0].join('\n') === eTexts2.join('\n'),
    `변경 추적 포함 저장본: 앞 문단 = 「${ex2.text('s0/p2', 'markup')}」 · 최종본 = 지금 글`);
  // 3) 내가 넣은 문단(변경 추적 삽입)을 지움 → 내 삽입을 거두고 문단째 없어짐(남는 변경 없음)
  await push(A, dE.id, await makeHead(A, dE.id, (d) => d.insertParagraphAfter(0, 3, '잠깐 넣은 문단입니다.', ED)));
  const ch3a = await A(`${DE}/changes`); const eTexts3a = await bodyTexts(A, dE.id);
  const at3 = eTexts3a.indexOf('잠깐 넣은 문단입니다.');
  const re3 = await push(A, dE.id, await makeHead(A, dE.id, (d) => d.removeBodyParagraph(0, at3)));
  ok(at3 === 4 && ch3a.some((c) => c.type === 'Insert' && c.author === nameA) && re3.status === 200 && re3.data.clean === true
    && eq(await bodyTexts(A, dE.id), eTexts2) && eq((await A(`${DE}/changes`)).map((c) => c.id), ch2all.map((c) => c.id)),
  '내가 넣은 문단을 다시 지움 → 문단째 없어지고 내 삽입 변경(글·나눔)도 사라짐(앞의 지우기 변경만 그대로)');
  // 4) 문단 합치기(다섯째 문단 앞에서 Backspace): 편집기에는 한 문단 — 공유 문서도 한 문단(빈 줄이 남지 않음), 고침은 변경 추적
  const t3 = eTexts2[3]; const t4 = eTexts2[4];
  const re4 = await push(A, dE.id, await makeHead(A, dE.id, (d) => { d.mergeParagraphText('s0/p3', t3 + t4, ED); d.removeBodyParagraph(0, 4); }));
  const eTexts4 = await bodyTexts(A, dE.id);
  ok(re4.status === 200 && re4.data.clean === true && eTexts4.length === 6 && eTexts4.includes(t3 + t4) && !eTexts4.includes('') && !eTexts4.includes(t3) && !eTexts4.includes(t4),
    `문단 합치기 → 한 문단 「${(t3 + t4).slice(0, 24)}…」, 빈 줄 없음 · clean ${JSON.stringify(re4.data.applied)}`);
  const ex4 = await HwpxDoc.load((await A.res(`${DE}/file?kind=tracked`)).data);
  ok(ex4.changes().length > 1 && (await ex4.flattened()).bodyTexts()[0].join('\n') === eTexts4.join('\n'), `합친 뒤 변경 추적 포함 저장본도 최종본 = 지금 글(변경 ${ex4.changes().length}건)`);
  // 5) 표 문단과 그 뒤 글 문단을 함께 지움 → 표도 변경 추적(2026-10-30 — '표 지움'): 작업본(최종본)에서는 표가 없어지고, 뒤 문단의 지운 글과
  //    지운 표가 모두 표 앞 문단 끝에 남음(추적본에는 표 XML 이 Delete 표식 안에 그대로)
  const dE2 = await uploadDoc(srv.base, TA, await buildTableDoc(), '변경 추적 표 문단 지우기.hwpx');
  const DE2 = `/api/docs/${dE2.id}`;
  await A(`${DE2}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const P5 = '다섯째 문단: 추진 일정은 3월부터 12월까지입니다.';
  const tTexts0 = await bodyTexts(A, dE2.id);
  const re5 = await push(A, dE2.id, await makeHead(A, dE2.id, (d) => { d.removeBodyParagraph(0, 5); d.removeBodyParagraph(0, 4); }));
  const ex5 = await HwpxDoc.load((await A.res(`${DE2}/file?kind=tracked`)).data); const ch5 = ex5.changes();
  const wk5 = await HwpxDoc.load((await A.res(`${DE2}/file?kind=working`)).data);
  // (2026-10-30) + 문단 나눔 지움 둘. 지운 표 문단(남는 내용 없음) 뒤 문단도 통째로 지우면 한/글처럼 그 문단 자기 나눔을 지워(뒤 문단 속성이 남음)
  // 지운 글·나눔이 다음 문단(s0/p4 — 여섯째) 앞쪽 묶음에 든다 — 최종본은 같다
  const txt5 = ch5.filter((c) => !c.kind); const obj5 = ch5.filter((c) => c.kind === 'object'); const brk5 = ch5.filter((c) => c.kind === 'para');
  ok(tTexts0[5] === P5 && re5.status === 200 && re5.data.clean === true && re5.data.unsupported === 0 && ex5.tables().length === 0 && /<hp:tbl\b/.test(ex5.sections[0].xml)
    && !/<hp:tbl\b/.test(wk5.sections[0].xml) && ch5.length === 4 && brk5.length === 2 && brk5.every((c) => c.type === 'Delete' && (c.ref === 's0/p3' || c.ref === 's0/p4'))
    && txt5.length === 1 && txt5[0].type === 'Delete' && txt5[0].text === P5 && (txt5[0].ref === 's0/p3' || txt5[0].ref === 's0/p4')
    && obj5.length === 1 && obj5[0].kind === 'object' && obj5[0].type === 'Delete' && obj5[0].label === '표 지움' && obj5[0].ref === 's0/p3' && obj5[0].author === nameA
    && eq(await bodyTexts(A, dE2.id), [...tTexts0.slice(0, 4), ...tTexts0.slice(6)]),
  `표 문단 + 뒤 글 문단 지움 → 작업본에서 표는 없어지고, 지운 글과 지운 표가 표 앞 문단 끝의 변경 추적(${ch5.map((c) => `${c.type} ${c.ref} 「${c.label || c.text}」`).join(', ')})`);

  // ───────── 7-2. 변경 추적으로 — 표·그림·차트·도형(2026-10-30) ─────────
  {
  section('변경 추적으로 표·그림·차트·도형: 넣고 지운 개체도 변경 추적(그림 넣음·표 지움·도형 지움·차트 넣음/지움) · 작업본에서는 지운 개체가 안 보임 · 손대지 않은 작업본 → 커밋 없음·clean · REST 수락·거절은 개체째(formatVersion 오름) · 변경 요청 반영 · 두 사람');
  const info = (X, id) => X(`/api/docs/${id}`);
  const fileOf = async (X, id, kind) => HwpxDoc.load((await X.res(`/api/docs/${id}/file?kind=${kind}`)).data);
  const xmlOf = (d) => d.sections.map((s) => s.xml).join('');
  const count = (s, re) => (s.match(re) || []).length;
  const NO_APPLIED = { changed: [], inserted: [], deleted: [] };
  const brief = (cs) => cs.map((c) => `#${c.id} ${c.label || c.type} ${c.ref} ${c.author}`).join(', ');
  /** 서버 작업본을 편집기(rhwp)로 열어 그대로 내보낸 것과 견준 덩어리 수 — 0 이어야(아니면 편집기가 열 때마다 유령 덩어리 → 다시 열기 고리) */
  const roundTrip = async (X, id) => { const h = await editorHead(X, id, () => {}); return (await diffDocs(h.base, h.bytes)).hunks.length; };
  /** 손대지 않은 작업본(엔진 사본·편집기 내보내기 둘 다)을 다시 보냄 → 커밋 없음(버전 그대로·applied 빔·formatVersion 없음)·clean */
  const untouchedOk = async (X, id) => {
    const v = (await info(X, id)).version;
    const rs = [await push(X, id, await makeHead(X, id, () => {})), await push(X, id, await editorHead(X, id, () => {}))];
    const bad = rs.filter((r) => !(r.status === 200 && r.data.version === v && r.data.clean === true && eq(r.data.applied, NO_APPLIED) && r.data.formatVersion == null));
    if (bad.length) console.log('    (손대지 않은 작업본 응답)', JSON.stringify(bad.map((r) => r.data)));
    return !bad.length && (await info(X, id)).version === v;
  };

  // 1) 그림 문단 넣기(엔진 insertPictureAfter — 편집기 그림 넣기와 같은 꼴의 문단) → 문단 + '그림 넣음'
  const dP = await uploadDoc(srv.base, TA, await buildMainDoc(), '변경 추적 그림.hwpx');
  const DP = `/api/docs/${dP.id}`;
  await A(`${DP}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const pTexts0 = await bodyTexts(A, dP.id);
  const bins0 = (await pkgCheck(Buffer.from((await A.res(`${DP}/file?kind=tracked`)).data))).bins.length;
  // (2026-10-30 문단 나눔 변경 추적) 넣은 문단의 나눔도 '문단 나눔 넣음'(앞 문단 s0/p1 끝) — 개체 변경과 따로 센다
  const objOf = (cs) => cs.filter((c) => c.kind !== 'para'); const brkOf = (cs) => cs.filter((c) => c.kind === 'para');
  const rp1 = await push(A, dP.id, await makeHead(A, dP.id, (d) => d.insertPictureAfter(0, 1, { data: makePng(120, 60) }, ED)));
  const chp1all = await A(`${DP}/changes`); const chp1 = objOf(chp1all);
  ok(rp1.status === 200 && rp1.data.clean === true && rp1.data.unsupported === 0 && eq(rp1.data.applied.inserted, ['s0/p2']) && rp1.data.formatVersion === rp1.data.version
    && chp1.length === 1 && chp1[0].kind === 'object' && chp1[0].type === 'Insert' && chp1[0].label === '그림 넣음' && chp1[0].ref === 's0/p2' && chp1[0].author === nameA
    && brkOf(chp1all).length === 1 && brkOf(chp1all)[0].type === 'Insert' && brkOf(chp1all)[0].ref === 's0/p1'
    && chp1[0].objects?.[0]?.what === 'picture' && count(xmlOf(await fileOf(A, dP.id, 'working')), /<hp:pic\b/g) === 1
    && eq(await bodyTexts(A, dP.id), [...pTexts0.slice(0, 2), '', ...pTexts0.slice(2)]),
  `그림 문단 넣기 → 문단 + 그림 넣음 변경 추적(${brief(chp1all)}) · 서식 커밋(formatVersion)`);
  ok(await untouchedOk(A, dP.id) && await roundTrip(A, dP.id) === 0, '넣은 그림이 든 문서: 손대지 않은 작업본(엔진 사본·편집기 내보내기)을 다시 보냄 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  // 2) REST 거절 → 그림째 지움(작업본·추적본·그림 파일), 빈 문단은 남음 · formatVersion 오름(편집기 다시 열기) · 이어 나눔 넣음도 거절 → 빈 줄 없음
  const fvp1 = (await info(A, dP.id)).formatVersion;
  const rjp = await A(`${DP}/changes/${chp1[0].id}/reject`, { method: 'POST' });
  const ip2 = await info(A, dP.id); const kp2 = await pkgCheck(Buffer.from((await A.res(`${DP}/file?kind=tracked`)).data));
  const chp2 = await A(`${DP}/changes`);
  ok(rjp.ok === true && ip2.formatVersion === ip2.version && ip2.formatVersion > fvp1 && objOf(chp2).length === 0 && brkOf(chp2).length === 1
    && !/<hp:pic\b/.test(xmlOf(await fileOf(A, dP.id, 'working'))) && !/<hp:pic\b/.test(kp2.sec) && kp2.bins.length === bins0 && eq(kp2.problems, [])
    && eq(await bodyTexts(A, dP.id), [...pTexts0.slice(0, 2), '', ...pTexts0.slice(2)]),
  '그림 넣음 거절(REST) → 그림째 지움(작업본·추적본, 그림 파일도) · 빈 문단(나눔 넣음)은 남음 · formatVersion 오름');
  if (chp2.length) await A(`${DP}/changes/${chp2[0].id}/reject`, { method: 'POST' });
  ok((await A(`${DP}/changes`)).length === 0 && eq(await bodyTexts(A, dP.id), pTexts0), '이어 문단 나눔 넣음도 거절(REST) → 빈 줄 없이 원래 문단');
  // 3) 다시 넣고 REST 수락 → 그림은 남고 표식만 지움 · formatVersion 오름(나눔 넣음도 수락)
  const rp3 = await push(A, dP.id, await makeHead(A, dP.id, (d) => d.insertPictureAfter(0, 3, { data: makePng(80, 40) }, ED)));
  const chp3all = await A(`${DP}/changes`); const chp3 = objOf(chp3all); const fvp3 = (await info(A, dP.id)).formatVersion;
  const acp = chp3.length ? await A(`${DP}/changes/${chp3[0].id}/accept`, { method: 'POST' }) : null;
  for (const c of brkOf(chp3all)) await A(`${DP}/changes/${c.id}/accept`, { method: 'POST' });
  const ip3 = await info(A, dP.id); const tp3 = xmlOf(await fileOf(A, dP.id, 'tracked'));
  ok(rp3.status === 200 && chp3.length === 1 && chp3[0].label === '그림 넣음' && chp3[0].ref === 's0/p4' && brkOf(chp3all).length === 1 && acp?.ok === true && ip3.formatVersion === ip3.version && ip3.formatVersion > fvp3
    && (await A(`${DP}/changes`)).length === 0 && count(tp3, /<hp:pic\b/g) === 1 && !/<hp:(insert|delete)(Begin|End)\b/.test(tp3)
    && count(xmlOf(await fileOf(A, dP.id, 'working')), /<hp:pic\b/g) === 1,
  '그림 넣음 수락(REST) → 그림은 남고(추적본 표식 없음) 변경 없음 · formatVersion 오름');
  // 4) 남은 그림 문단을 지움 → 최종본에서는 앞 문단과 한 문단, '그림 지움' + '문단 나눔 지움'(작업본에서는 그림이 안 보임) → 그림만 REST 거절 →
  //    그림이 앞 문단 끝에 돌아옴(나눔 지움이 남은 동안) → 나눔도 거절 → 그림 문단이 제 줄로(2026-10-30)
  const pTexts4 = await bodyTexts(A, dP.id);
  const rp4 = await push(A, dP.id, await makeHead(A, dP.id, (d) => d.removeBodyParagraph(0, 4)));
  const chp4all = await A(`${DP}/changes`); const chp4 = objOf(chp4all);
  ok(pTexts4[4] === '' && rp4.status === 200 && rp4.data.clean === true && eq(rp4.data.applied.deleted, ['s0/p4'])
    && chp4.length === 1 && chp4[0].kind === 'object' && chp4[0].type === 'Delete' && chp4[0].label === '그림 지움' && chp4[0].ref === 's0/p3' && chp4[0].author === nameA
    && brkOf(chp4all).length === 1 && brkOf(chp4all)[0].type === 'Delete' && brkOf(chp4all)[0].ref === 's0/p3'
    && eq(await bodyTexts(A, dP.id), [...pTexts4.slice(0, 4), ...pTexts4.slice(5)])
    && !/<hp:pic\b/.test(xmlOf(await fileOf(A, dP.id, 'working'))) && count(xmlOf(await fileOf(A, dP.id, 'tracked')), /<hp:pic\b/g) === 1,
  `그림 문단 지움 → 최종본에서 없어지고 그림은 지움 변경 추적(${brief(chp4all)}) · 작업본에서는 안 보임`);
  ok(await untouchedOk(A, dP.id) && await roundTrip(A, dP.id) === 0, '지운 그림이 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  const rjp4 = chp4.length ? await A(`${DP}/changes/${chp4[0].id}/reject`, { method: 'POST' }) : null;
  const wp4 = await fileOf(A, dP.id, 'working');
  ok(rjp4?.ok === true && objOf(await A(`${DP}/changes`)).length === 0 && count(xmlOf(wp4), /<hp:pic\b/g) === 1 && wp4._objectInfo('s0/p3').pics.length === 1
    && eq(await bodyTexts(A, dP.id), [...pTexts4.slice(0, 4), ...pTexts4.slice(5)]),
  '그림 지움 거절(REST) → 그림이 앞 문단(s0/p3) 끝에 돌아옴(나눔 지움이 남은 동안)');
  const brk4 = brkOf(await A(`${DP}/changes`));
  if (brk4.length) await A(`${DP}/changes/${brk4[0].id}/reject`, { method: 'POST' });
  const wp4b = await fileOf(A, dP.id, 'working');
  ok(brk4.length === 1 && (await A(`${DP}/changes`)).length === 0 && wp4b._objectInfo('s0/p4').pics.length === 1 && wp4b._objectInfo('s0/p3').pics.length === 0 && eq(await bodyTexts(A, dP.id), pTexts4),
    '이어 문단 나눔 지움도 거절(REST) → 그림 문단이 제 줄(s0/p4)로 돌아옴');
  // 5) 내가 넣은(추적) 그림 문단을 다시 지움 → 내 넣음(그림·나눔)을 거둬 문단째 없어지고 변경도 그림 파일도 남지 않음
  const pTexts5 = await bodyTexts(A, dP.id);
  await push(A, dP.id, await makeHead(A, dP.id, (d) => d.insertPictureAfter(0, 5, { data: makePng(60, 30) }, ED)));
  const chp5 = objOf(await A(`${DP}/changes`));
  const rp5 = await push(A, dP.id, await makeHead(A, dP.id, (d) => d.removeBodyParagraph(0, 6)));
  const kp5 = await pkgCheck(Buffer.from((await A.res(`${DP}/file?kind=tracked`)).data));
  ok(chp5.length === 1 && chp5[0].label === '그림 넣음' && chp5[0].ref === 's0/p6' && rp5.status === 200 && rp5.data.clean === true
    && (await A(`${DP}/changes`)).length === 0 && eq(await bodyTexts(A, dP.id), pTexts5) && count(kp5.sec, /<hp:pic\b/g) === 1 && kp5.bins.length === bins0 + 1 && eq(kp5.problems, []),
  '내가 넣은 그림 문단을 다시 지움 → 문단째 없어지고 내 넣음 변경·그림 파일도 사라짐');

  // 6) 표 문단 지우기 + 두 사람: 옛 기준의 홍길동이 지운 표의 칸을 고쳐 보냄 → GONE(지운 표·변경은 그대로)
  const dTo = await uploadDoc(srv.base, TA, await buildTableDoc(), '변경 추적 표.hwpx');
  const DTo = `/api/docs/${dTo.id}`;
  await A(`${DTo}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const tT0 = await bodyTexts(A, dTo.id);
  const hBt = await makeHead(B, dTo.id, (d) => replaceIn(d, 's0/p4/n3', '1', '10'));
  const rt1 = await push(A, dTo.id, await makeHead(A, dTo.id, (d) => d.removeBodyParagraph(0, 4)));
  const cht1all = await A(`${DTo}/changes`); const cht1 = objOf(cht1all);
  ok(rt1.status === 200 && rt1.data.clean === true && eq(rt1.data.applied.deleted, ['s0/p4']) && cht1.length === 1 && cht1[0].kind === 'object' && cht1[0].type === 'Delete'
    && brkOf(cht1all).length === 1 && brkOf(cht1all)[0].ref === 's0/p3'
    && cht1[0].label === '표 지움' && cht1[0].ref === 's0/p3' && cht1[0].objects?.[0]?.what === 'table' && eq(await bodyTexts(A, dTo.id), [...tT0.slice(0, 4), ...tT0.slice(5)])
    && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dTo.id, 'working'))) && /<hp:tbl\b/.test(xmlOf(await fileOf(A, dTo.id, 'tracked'))),
  `표 문단 지움 → 표 지움 변경 추적(${brief(cht1)}) · 작업본에는 표 없음, 추적본에는 표 XML`);
  ok(await untouchedOk(A, dTo.id) && await roundTrip(A, dTo.id) === 0, '지운 표가 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  const vT1 = (await info(A, dTo.id)).version;
  const rt2 = await push(B, dTo.id, hBt);
  ok(rt2.status === 200 && rt2.data.version === vT1 && rt2.data.skipped.length === 1 && rt2.data.skipped[0].reason === 'GONE' && eq(await A(`${DTo}/changes`), cht1all),
    `옛 기준의 다른 사람이 지운 표의 칸을 고쳐 보냄 → GONE 으로 건너뜀(지운 표·변경은 그대로) ${JSON.stringify(rt2.data.skipped)}`);
  // 지운 표가 붙은 앞 문단의 글을 같은 사람이 두 번 고침(두 번째는 제 글 변경을 거절하고 다시 씀 — applyLiveText) → 표 지움은 그대로(되살아나지 않음)
  const dTj = await uploadDoc(srv.base, TA, await buildTableDoc(), '변경 추적 표 옆 글.hwpx');
  const DTj = `/api/docs/${dTj.id}`;
  await A(`${DTj}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  await push(A, dTj.id, await makeHead(A, dTj.id, (d) => d.removeBodyParagraph(0, 4)));
  const rj1 = await push(A, dTj.id, await makeHead(A, dTj.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을')));
  const rj2 = await push(A, dTj.id, await makeHead(A, dTj.id, (d) => replaceIn(d, 's0/p3', '적습니다', '정리합니다')));
  const chj = await A(`${DTj}/changes`);
  ok(rj1.status === 200 && rj2.status === 200 && rj2.data.clean === true && chj.filter((c) => c.kind === 'object').length === 1 && chj.find((c) => c.kind === 'object')?.label === '표 지움'
    && brkOf(chj).length === 1
    && chj.filter((c) => !c.kind).every((c) => c.author === nameA && c.ref === 's0/p3') && await textOf(A, dTj.id, 's0/p3') === '넷째 문단: 사업 개요와 배경을 정리합니다.'
    && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dTj.id, 'working'))) && /<hp:tbl\b/.test(xmlOf(await fileOf(A, dTj.id, 'tracked'))),
  `지운 표가 붙은 문단의 글을 같은 사람이 다시 고침 → 제 글 변경만 다시 쓰고 표 지움은 그대로(${brief(chj)})`);
  // 한글로 저장: 보이는 그대로 = 표 없음(최종본을 엄격히 만듦 — X-Export-Fallback 없음) · 변경 추적 포함 = 지운 표가 '표 지움' 변경으로
  const ext1 = await A.res(`${DTo}/file?kind=export`); const exd1 = await HwpxDoc.load(ext1.data);
  await A(`${DTo}/settings`, { method: 'PATCH', body: { exportKind: 'tracked' } });
  const ext2 = await A.res(`${DTo}/file?kind=export`); const exd2 = await HwpxDoc.load(ext2.data);
  await A(`${DTo}/settings`, { method: 'PATCH', body: { exportKind: 'final' } });
  ok(ext1.headers.get('x-export-kind') === 'final' && !ext1.headers.get('x-export-fallback') && !/<hp:tbl\b/.test(xmlOf(exd1)) && exd1.changes().length === 0
    && ext2.headers.get('x-export-kind') === 'tracked' && /<hp:tbl\b/.test(xmlOf(exd2)) && exd2.changes().some((c) => c.label === '표 지움'),
  '한글로 저장: 보이는 그대로 = 표 없음(X-Export-Fallback 없음) · 변경 추적 포함 = 지운 표가 표 지움 변경으로');
  // 7) REST 거절 → 표가 앞 문단 끝에 돌아옴(나눔 지움이 남은 동안 — 나눔까지 거절하면 제 문단으로는 7-3 S7) · 그 문단의 표만 다시 지움(object 덩어리)
  //    → REST 수락 → 추적본에서도 표째 지움
  const fvt = (await info(A, dTo.id)).formatVersion;
  await A(`${DTo}/changes/${cht1[0].id}/reject`, { method: 'POST' });
  const it3 = await info(A, dTo.id); const wt3 = await fileOf(A, dTo.id, 'working');
  ok(it3.formatVersion === it3.version && it3.formatVersion > fvt && wt3.tables().length === 1 && wt3._objectInfo('s0/p3').tables.length === 1 && objOf(await A(`${DTo}/changes`)).length === 0
    && eq(await bodyTexts(A, dTo.id), [...tT0.slice(0, 4), ...tT0.slice(5)]),
  '표 지움 거절(REST) → 표가 앞 문단(s0/p3) 끝에 돌아옴 · formatVersion 오름');
  const rt4 = await push(A, dTo.id, await makeHead(A, dTo.id, (d) => d.removeOwnObjects('s0/p3')));
  const cht4 = objOf(await A(`${DTo}/changes`));
  ok(rt4.status === 200 && rt4.data.clean === true && eq(rt4.data.applied.changed, ['s0/p3']) && rt4.data.formatVersion === rt4.data.version
    && cht4.length === 1 && cht4[0].label === '표 지움' && cht4[0].ref === 's0/p3' && (await fileOf(A, dTo.id, 'working')).tables().length === 0,
  `글 문단 안 표만 지움(object 덩어리) → 표 지움 변경 추적(${brief(cht4)})`);
  const fvt4 = (await info(A, dTo.id)).formatVersion;
  if (cht4.length) await A(`${DTo}/changes/${cht4[0].id}/accept`, { method: 'POST' });
  const it5 = await info(A, dTo.id);
  ok(it5.formatVersion === it5.version && it5.formatVersion > fvt4 && objOf(await A(`${DTo}/changes`)).length === 0 && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dTo.id, 'tracked')))
    && eq(await bodyTexts(A, dTo.id), [...tT0.slice(0, 4), ...tT0.slice(5)]),
  '표 지움 수락(REST) → 추적본에서도 표째 지움 · formatVersion 오름');

  // 8) 도형 지우기(편집기 rhwp — 한/글 도형 문서의 선) → 도형 지움 · 같은 문서를 다시 보내도 그대로 · 수락하면 추적본에서도 지움
  const dSh = await uploadDoc(srv.base, TA, fs.readFileSync(fixture('shapes_hangul.hwpx')), '변경 추적 도형.hwpx');
  const DSh = `/api/docs/${dSh.id}`;
  await A(`${DSh}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const hs1 = await editorHead(A, dSh.id, (d) => { const s = rhShapes(d).find((x) => x.p === 2); d.deleteShapeControl(0, s.p, s.ci); });
  const rs1 = await push(A, dSh.id, hs1);
  const chs1 = await A(`${DSh}/changes`);
  const rs1b = await push(A, dSh.id, { ...hs1, version: rs1.data.version });
  ok(rs1.status === 200 && rs1.data.clean === true && rs1.data.unsupported === 0 && eq(rs1.data.applied.changed, ['s0/p2']) && rs1.data.formatVersion === rs1.data.version
    && chs1.length === 1 && chs1[0].kind === 'object' && chs1[0].type === 'Delete' && /지움/.test(chs1[0].label) && /선/.test(chs1[0].label) && chs1[0].ref === 's0/p2'
    && !/<hp:line\b/.test(xmlOf(await fileOf(A, dSh.id, 'working'))) && /<hp:line\b/.test(xmlOf(await fileOf(A, dSh.id, 'tracked')))
    && rs1b.data.version === rs1.data.version && eq(rs1b.data.applied, NO_APPLIED),
  `도형(선) 지움 → ${brief(chs1)} · 작업본에는 선 없음, 추적본에는 선 XML · 같은 문서를 다시 보내도 그대로`);
  ok(await untouchedOk(A, dSh.id) && await roundTrip(A, dSh.id) === 0, '지운 도형이 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  if (chs1.length) await A(`${DSh}/changes/${chs1[0].id}/accept`, { method: 'POST' });
  ok((await A(`${DSh}/changes`)).length === 0 && !/<hp:line\b/.test(xmlOf(await fileOf(A, dSh.id, 'tracked'))), '도형 지움 수락(REST) → 추적본에서도 선째 지움');

  // 9) 차트 넣기·지우기(편집기 rhwp — 한/글 차트 문서) → 차트 넣음·차트 지움 · 꾸러미(차트 부분·대체 OLE)에 남는·없는 부분 0
  const dCh = await uploadDoc(srv.base, TA, fs.readFileSync(fixture('chart_hangul.hwpx')), '변경 추적 차트.hwpx');
  const DCh = `/api/docs/${dCh.id}`;
  await A(`${DCh}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const pkgOf = async (kind) => pkgCheck(Buffer.from((await A.res(`${DCh}/file?kind=${kind}`)).data));
  const rc1 = await push(A, dCh.id, await editorHead(A, dCh.id, (d) => { if (!JSON.parse(d.insertChart(0, 1, 0, '')).ok) throw new Error('insertChart 실패'); }));
  const chc1 = await A(`${DCh}/changes`);
  const kc1t = await pkgOf('tracked'); const kc1e = await pkgOf('export');
  ok(rc1.status === 200 && rc1.data.clean === true && rc1.data.unsupported === 0 && chc1.length === 1 && chc1[0].kind === 'object' && chc1[0].type === 'Insert' && chc1[0].label === '차트 넣음'
    && kc1t.refs.length === 2 && eq(kc1t.problems, []) && kc1e.refs.length === 2 && eq(kc1e.problems, []),
  `차트 넣기 → ${brief(chc1)} · 추적본·한글로 저장 꾸러미에 차트 둘(남는·없는 부분 0)`);
  ok(await untouchedOk(A, dCh.id) && await roundTrip(A, dCh.id) === 0, '넣은 차트가 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  if (chc1.length) await A(`${DCh}/changes/${chc1[0].id}/reject`, { method: 'POST' });
  const kc2 = await pkgOf('tracked');
  ok((await A(`${DCh}/changes`)).length === 0 && kc2.refs.length === 1 && kc2.charts.length === 1 && eq(kc2.problems, []), '차트 넣음 거절(REST) → 차트째 지움(차트 부분도 거둠 — 한/글 차트 하나만)');
  const rc3 = await push(A, dCh.id, await editorHead(A, dCh.id, (d) => { const c = JSON.parse(d.listCharts())[0]; d.deleteShapeControl(c.section, c.paragraph, c.control); }));
  const chc3 = await A(`${DCh}/changes`);
  const kc3t = await pkgOf('tracked'); const kc3e = await pkgOf('export');
  ok(rc3.status === 200 && rc3.data.clean === true && chc3.length === 1 && chc3[0].type === 'Delete' && chc3[0].label === '차트 지움'
    && kc3t.refs.length === 1 && kc3t.charts.length === 1 && eq(kc3t.problems, []) && kc3e.refs.length === 0 && kc3e.charts.length === 0 && eq(kc3e.problems, []),
  `차트 지움 → ${brief(chc3)} · 추적본에는 차트·차트 부분이 남고, 한글로 저장(보이는 그대로)에는 차트도 차트 부분도 없음`);
  ok(await untouchedOk(A, dCh.id) && await roundTrip(A, dCh.id) === 0, '지운 차트가 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 덩어리 0');
  if (chc3.length) await A(`${DCh}/changes/${chc3[0].id}/accept`, { method: 'POST' });
  const kc4 = await pkgOf('tracked');
  ok((await A(`${DCh}/changes`)).length === 0 && kc4.refs.length === 0 && kc4.charts.length === 0 && eq(kc4.problems, []), '차트 지움 수락(REST) → 추적본에서도 차트째 지움(차트 부분·대체 OLE 도 거둠)');

  // 10) 변경 추적 문서의 변경 요청 반영: 표 문단 지우기 + 그림 문단 넣기 → 표 지움·그림 넣음(작성자 = 변경 요청 작성자 — 반영은 빈 문단을 남긴다)
  const dCr = await uploadDoc(srv.base, TA, await buildTableDoc(), '변경 추적 반영.hwpx');
  const DCr = `/api/docs/${dCr.id}`;
  await A(`${DCr}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const hCr = await makeHead(B, dCr.id, (d) => { d.removeBodyParagraph(0, 4); d.insertPictureAfter(0, 1, { data: makePng(100, 50) }, ED); });
  const crO = (await B(`${DCr}/drafts/mine?base=${hCr.version}`, { method: 'PUT', body: hCr.bytes })).cr;
  const mO = await B(`${DCr}/change-requests/${crO.cid}/merge`, { method: 'POST' });
  const chCr = await A(`${DCr}/changes`); const wCr = await fileOf(A, dCr.id, 'working'); const iCr = await info(A, dCr.id);
  ok(mO.cr.status === 'merged' && chCr.filter((c) => c.kind === 'object').length === 2 && chCr.filter((c) => c.kind === 'para').length === 2 && chCr.filter((c) => c.kind === 'para').every((c) => c.author === nameB) && chCr.some((c) => c.label === '표 지움' && c.author === nameB) && chCr.some((c) => c.label === '그림 넣음' && c.author === nameB)
    && wCr.tables().length === 0 && count(xmlOf(wCr), /<hp:pic\b/g) === 1 && /<hp:tbl\b/.test(xmlOf(await fileOf(A, dCr.id, 'tracked'))) && iCr.formatVersion === iCr.version,
  `변경 추적 문서의 변경 요청 반영 → ${brief(chCr)} · 작업본에는 표 없음·그림 있음`);
  const acc = await A(`${DCr}/changes/accept-all`, { method: 'POST' });
  const iCr2 = await info(A, dCr.id); const tCr2 = xmlOf(await fileOf(A, dCr.id, 'tracked'));
  ok(acc.accepted === chCr.length && (await A(`${DCr}/changes`)).length === 0 && iCr2.formatVersion === iCr2.version && iCr2.formatVersion > iCr.formatVersion
    && !/<hp:tbl\b/.test(tCr2) && count(tCr2, /<hp:pic\b/g) === 1,
  '모두 수락(REST) → 표째 지움·그림은 남음 · formatVersion 오름');

  // 11) 한/글 2022 가 변경 추적으로 저장한 문서(tests/fixtures/hangul_trk_* — 한글 COM 실측): 한/글이 지운 표 = '표 지움'(작업본에 없음) ·
  //     손대지 않은 작업본 → 커밋 없음 · REST 거절 → 표가 작업본에 돌아옴
  const dHt = await uploadDoc(srv.base, TA, fs.readFileSync(fixture('hangul_trk_tbl_delete.hwpx')), '한글 표 지움.hwpx');
  const DHt = `/api/docs/${dHt.id}`;
  await A(`${DHt}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const chHt = await A(`${DHt}/changes`);
  ok(chHt.length === 1 && chHt[0].kind === 'object' && chHt[0].type === 'Delete' && chHt[0].label === '표 지움' && chHt[0].author === 'Nag' && chHt[0].ref === 's0/p2'
    && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dHt.id, 'working'))) && await untouchedOk(A, dHt.id) && await roundTrip(A, dHt.id) === 0,
  `한/글이 지운 표(변경 추적) → ${brief(chHt)} · 작업본에 표 없음 · 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0`);
  const fvHt = (await info(A, dHt.id)).formatVersion;
  await A(`${DHt}/changes/${chHt[0].id}/reject`, { method: 'POST' });
  const iHt = await info(A, dHt.id); const tHt = xmlOf(await fileOf(A, dHt.id, 'tracked'));
  ok(iHt.formatVersion === iHt.version && iHt.formatVersion > fvHt && (await A(`${DHt}/changes`)).length === 0 && (await fileOf(A, dHt.id, 'working')).tables().length === 1
    && /<hp:tbl\b/.test(tHt) && !/<hp:(insert|delete)(Begin|End)\b/.test(tHt),
  '한/글이 지운 표를 거절(REST) → 표가 작업본에 돌아오고 표식·변경 없음 · formatVersion 오름');
  // 12) 한/글이 넣은 글+그림(한 넣음 — kind 'mixed' '글과 그림 넣음')의 넣은 글 일부를 다른 사람이 지우고 바꿈 → OVERLAP → 남의 섞인 넣음을 수락
  //     (그림은 남음, 서식 커밋) 뒤 내 고침만 변경 추적
  const dHp = await uploadDoc(srv.base, TA, fs.readFileSync(fixture('hangul_trk_pic_insert_with_text.hwpx')), '한글 글과 그림 넣음.hwpx');
  const DHp = `/api/docs/${dHp.id}`;
  await A(`${DHp}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const chHp0 = await A(`${DHp}/changes`);
  const rHp = await push(A, dHp.id, await makeHead(A, dHp.id, (d) => replaceIn(d, 's0/p1', '가나', '가라')));
  const chHp = await A(`${DHp}/changes`);
  ok(chHp0.length === 1 && chHp0[0].kind === 'mixed' && chHp0[0].label === '글과 그림 넣음' && rHp.status === 200 && rHp.data.clean === true && rHp.data.formatVersion === rHp.data.version
    && chHp.length >= 1 && chHp.every((c) => !c.kind && c.author === nameA) && await textOf(A, dHp.id, 's0/p1') === '둘째 문단입니다. 가라여기에 개체를 넣습니다.'
    && count(xmlOf(await fileOf(A, dHp.id, 'working')), /<hp:pic\b/g) === 1,
  `남이 넣은 글+그림의 넣은 글을 고침(OVERLAP) → 그 섞인 넣음을 수락(그림 남음 · 서식 커밋) 뒤 내 고침만 변경 추적(${brief(chHp)})`);

  // 13) AI 표·그림 제안 적용(2026-10-30 2단계): 변경 추적 문서면 넣은 표·그림도 '표 넣음'·'그림 넣음'(작성자 = 제안자) · 되돌리기는 표째 지움 ·
  //     그림 넣음을 변경 추적 탭에서 거절하면 제안은 '복구'(그림째 지움)
  const dQ = await uploadDoc(srv.base, TA, await buildMainDoc(), '변경 추적 AI 표·그림.hwpx');
  const DQ = `/api/docs/${dQ.id}`;
  await A(`${DQ}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const qTexts0 = await bodyTexts(A, dQ.id);
  const pT = await B(`${DQ}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p1', table: { rows: [['구분', '값'], ['가', '1']], headerRows: 1, caption: '시험 표' } } });
  const apT = await A(`${DQ}/proposals/${pT.pid}/apply`, { method: 'POST' });
  const chQ1 = await A(`${DQ}/changes`); const tblQ = chQ1.filter((c) => c.kind === 'object');
  ok(apT.status === 'applied' && tblQ.length === 1 && tblQ[0].label === '표 넣음' && tblQ[0].author === nameB && tblQ[0].ref === apT.insertedRef
    && apT.changeIds.map(Number).includes(Number(tblQ[0].id)) && (await fileOf(A, dQ.id, 'working')).tables().length === 1,
  `표 제안 적용 → ${brief(chQ1)} · 제안 changeIds 에 표 넣음 id`);
  const unT = await A(`${DQ}/proposals/${pT.pid}/undo`, { method: 'POST' });
  ok(unT.status === 'undone' && (await A(`${DQ}/changes`)).length === 0 && (await fileOf(A, dQ.id, 'working')).tables().length === 0 && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dQ.id, 'tracked')))
    && eq(await bodyTexts(A, dQ.id), qTexts0),
  '표 제안 되돌리기 → 표 문단째 지움(변경·표 XML 없음, 본문 그대로)');
  const pF = await mcpOk(srv.base, TA, 'propose_figure', { doc_id: dQ.id, after_ref: 's0/p2', caption: '시험 그림', image_base64: makePng(90, 45).toString('base64'), file_name: 'q.png' }, AG);
  const apF = await A(`${DQ}/proposals/${pF.pid}/apply`, { method: 'POST' });
  const picQ = (await A(`${DQ}/changes`)).filter((c) => c.kind === 'object');
  ok(apF.status === 'applied' && picQ.length === 1 && picQ[0].label === '그림 넣음' && picQ[0].author === pF.by && picQ[0].ref === apF.insertedRef
    && count(xmlOf(await fileOf(A, dQ.id, 'working')), /<hp:pic\b/g) === 1,
  `그림 제안 적용 → ${brief(picQ)}(작성자 = 제안한 에이전트)`);
  // (2026-10-30) 변경 추적 탭의 '문단 넣음' 묶음(그림 넣음 + 문단 나눔 넣음)을 한 번에 거절
  const brkQ = (await A(`${DQ}/changes`)).filter((c) => c.kind === 'para' && apF.changeIds.map(Number).includes(Number(c.id)));
  await A(`${DQ}/changes/resolve`, { method: 'POST', body: { ids: [picQ[0].id, ...brkQ.map((c) => c.id)], mode: 'reject' } });
  const pF2 = (await A(`${DQ}/proposals`)).find((x) => x.pid === pF.pid);
  ok(pF2.status === 'undone' && (await A(`${DQ}/changes`)).length === 0 && !/<hp:pic\b/.test(xmlOf(await fileOf(A, dQ.id, 'tracked'))),
    '그림 넣음을 변경 추적 탭에서 거절 → 그림째 지움(캡션 변경도) · 제안은 복구(undone)');
  // 승인 방식 문서도 같다(글처럼 처리 안 된 변경으로 남는 문서) · 실시간 '고친 글만'은 종전대로 바로 수락(변경 추적 없음)
  const dQr = await uploadDoc(srv.base, TA, await buildMainDoc(), '승인 방식 AI 표.hwpx');
  const DQr = `/api/docs/${dQr.id}`;
  await A(`${DQr}/settings`, { method: 'PATCH', body: { editMode: 'review' } });
  const pTr = await B(`${DQr}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p1', table: { rows: [['가', '나']], headerRows: 1, caption: '' } } });
  await ADM(`${DQr}/proposals/${pTr.pid}/apply`, { method: 'POST' });
  const chQr = await A(`${DQr}/changes`);
  const dQf = await uploadDoc(srv.base, TA, await buildMainDoc(), '고친 글만 AI 표.hwpx');
  const DQf = `/api/docs/${dQf.id}`;
  const pTf = await B(`${DQf}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p1', table: { rows: [['가', '나']], headerRows: 1, caption: '' } } });
  const apTf = await A(`${DQf}/proposals/${pTf.pid}/apply`, { method: 'POST' });
  ok(chQr.filter((c) => c.kind === 'object').length === 1 && chQr.find((c) => c.kind === 'object')?.label === '표 넣음' && chQr.filter((c) => c.kind === 'para').length === 1 && chQr[0].author === nameB && chQr[0].author === nameB && (await A(DQf)).settings.track === 'final' && apTf.appliedFinal === true
    && (await A(`${DQf}/changes`)).length === 0 && (await fileOf(A, dQf.id, 'working')).tables().length === 1,
  `승인 방식 문서의 표 제안 적용도 ${brief(chQr)} · 실시간 고친 글만은 변경 추적 없이 바로`);

  // 14) 여러 변경을 한 번에 정하기(POST /changes/resolve { ids, mode } — 웹 묶음): 안에 남의 변경(작은 번호)이 든 표를 지운 변경(큰 번호)과 글 변경을
  //     함께 수락 — 표째 지우면 안쪽 번호가 지워져 뒤 번호가 밀리지만 서버가 따라간다(하나씩 큰 번호부터 부르면 엉뚱한 변경을 정한다) · 오류
  const dRs = await uploadDoc(srv.base, TA, await buildTableDoc(), '변경 추적 묶음 정하기.hwpx');
  const DRs = `/api/docs/${dRs.id}`;
  await A(`${DRs}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  await push(B, dRs.id, await makeHead(B, dRs.id, (d) => replaceIn(d, 's0/p4/n3', '1', '10')));
  await push(A, dRs.id, await makeHead(A, dRs.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을')));
  await push(A, dRs.id, await makeHead(A, dRs.id, (d) => d.removeBodyParagraph(0, 4)));
  const chRs = await A(`${DRs}/changes`);
  const objRs = chRs.find((c) => c.kind === 'object'); const txtRs = chRs.filter((c) => !c.kind && c.ref === 's0/p3');
  // (2026-10-30) 표 문단 지우기의 문단 나눔 지움도 함께 수락(수락은 최종본을 바꾸지 않는다)
  const brkRs = chRs.filter((c) => c.kind === 'para');
  // 지운 표 안 칸의 김검토 변경(숨은 문단 '…/dK' — 번호가 가장 작다): 표째 수락하면 함께 지워져 뒤 번호(글 변경·표 지움)가 하나씩 밀린다
  const innerRs = chRs.filter((c) => c.author === nameB);
  const nestedLow = innerRs.length === 1 && /\/d\d+$/.test(innerRs[0].ref) && txtRs.every((c) => innerRs[0].id < c.id && c.id < objRs.id);
  const bad1 = await A.res(`${DRs}/changes/resolve`, { method: 'POST', body: { ids: [], mode: 'accept' } });
  const bad2 = await A.res(`${DRs}/changes/resolve`, { method: 'POST', body: { ids: [objRs.id], mode: 'keep' } });
  const bad3 = await A.res(`${DRs}/changes/resolve`, { method: 'POST', body: { ids: [objRs.id, 999], mode: 'accept' } });
  const fvRs = (await info(A, dRs.id)).formatVersion;
  const rsAll = await A(`${DRs}/changes/resolve`, { method: 'POST', body: { ids: [objRs.id, ...txtRs.map((c) => c.id), ...brkRs.map((c) => c.id)], mode: 'accept' } });
  const iRs = await info(A, dRs.id);
  if (!nestedLow) console.log('    (변경 목록)', JSON.stringify(chRs.map((c) => [c.id, c.label || c.type, c.ref, c.author])));
  ok(objRs?.label === '표 지움' && txtRs.length >= 1 && nestedLow && bad1.status === 400 && bad1.data.error === 'BAD_ARGS' && bad2.status === 400 && bad3.status === 404 && bad3.data.error === 'NO_CHANGE'
    && rsAll.ok === true && rsAll.done.length === 1 + txtRs.length + brkRs.length && (await A(`${DRs}/changes`)).length === 0 && iRs.formatVersion === iRs.version && iRs.formatVersion > fvRs
    && await textOf(A, dRs.id, 's0/p3') === '넷째 문단: 사업 개요와 배경을 적습니다.' && !/<hp:tbl\b/.test(xmlOf(await fileOf(A, dRs.id, 'tracked'))),
  `표 지움(#${objRs?.id}, 안에 남의 칸 변경) + 글 변경(${txtRs.map((c) => `#${c.id}`).join('·')})을 한 번에 수락 → 모두 정함·표째 지움 · 오류 400 BAD_ARGS·404 NO_CHANGE`);
  }

  // ───────── 7-3. 변경 추적으로 — 문단 나눔(줄바꿈, 2026-10-30 — 한/글 paraend="1") ─────────
  {
  section('변경 추적으로 문단 나눔: 문단 지우기 = 앞 문단 끝 나눔 지움 + 그 문단 글 지움(문단은 따로) · 둘 다 거절 → 제 줄로 · 문단 넣기 = 나눔 넣음 + 글 넣음(거절 → 빈 줄 없음) · 내가 넣은 문단 · 연속 지우기 · 합침·가름 · 표 문단 · 한글로 저장 · 고친 글만은 그대로 · 변경 요청 반영·다시 맞추기 · 두 사람');
  const info = (X, id) => X(`/api/docs/${id}`);
  const fileOf = async (X, id, kind) => HwpxDoc.load((await X.res(`/api/docs/${id}/file?kind=${kind}`)).data);
  const xmlOf = (d) => d.sections.map((s) => s.xml).join('');
  const count = (s, re) => (s.match(re) || []).length;
  const NO_APPLIED = { changed: [], inserted: [], deleted: [] };
  const brief = (cs) => cs.map((c) => `#${c.id} ${c.label || c.type} ${c.ref}@${c.start}${c.scope ? ` ${c.scope}` : ''} ${c.author}`).join(', ');
  const roundTrip = async (X, id) => { const h = await editorHead(X, id, () => {}); return (await diffDocs(h.base, h.bytes)).hunks.length; };
  const untouchedOk = async (X, id) => {
    const v = (await info(X, id)).version;
    const rs = [await push(X, id, await makeHead(X, id, () => {})), await push(X, id, await editorHead(X, id, () => {}))];
    const bad = rs.filter((r) => !(r.status === 200 && r.data.version === v && r.data.clean === true && eq(r.data.applied, NO_APPLIED) && r.data.formatVersion == null));
    if (bad.length) console.log('    (손대지 않은 작업본 응답)', JSON.stringify(bad.map((r) => r.data)));
    return !bad.length && (await info(X, id)).version === v;
  };
  const DEL_BRK = /<hp:deleteEnd\b[^>]*\bparaend="1"/g; const INS_BRK = /<hp:insertEnd\b[^>]*\bparaend="1"/g;
  const MARKS = /<hp:(insert|delete)(Begin|End)\b/;
  const trackedDoc = async (name, bytes = null) => {
    const d = await uploadDoc(srv.base, TA, bytes || await buildMainDoc(), name);
    await A(`/api/docs/${d.id}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
    return d;
  };
  const resolveIds = (X, id, ids, mode) => X(`/api/docs/${id}/changes/resolve`, { method: 'POST', body: { ids, mode } });
  const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'docs', id, 'meta.json'), 'utf-8'));
  const N3 = '새로 넣은 문단입니다.';

  // S1 글 문단 지우기 → 최종본 한 문단 적게 · 같은 ref(앞 문단)의 변경 둘(나눔 지움 — 폭 0, 그 문단 끝 자리 · 글 지움 — scope paragraph) · clean ·
  //    손대지 않은 밀어 넣기는 커밋 없음 · 편집기 왕복 0
  const d1 = await trackedDoc('문단 나눔 지우기.hwpx'); const D1 = `/api/docs/${d1.id}`;
  const t0 = await bodyTexts(A, d1.id);
  const r1 = await push(A, d1.id, await makeHead(A, d1.id, (d) => d.removeBodyParagraph(0, 3)));
  const c1 = await A(`${D1}/changes`);
  const brk1 = c1.find((c) => c.kind === 'para'); const txt1 = c1.find((c) => !c.kind);
  const x1 = xmlOf(await fileOf(A, d1.id, 'tracked'));
  ok(t0.length === 8 && r1.status === 200 && r1.data.clean === true && eq(r1.data.applied.deleted, ['s0/p3']) && eq(await bodyTexts(A, d1.id), [...t0.slice(0, 3), ...t0.slice(4)])
    && c1.length === 2 && c1.every((c) => c.type === 'Delete' && c.author === nameA && c.ref === 's0/p2')
    && brk1?.paraEnd === true && brk1.label === '문단 나눔 지움' && brk1.start === [...t0[2]].length && (brk1.end ?? brk1.start) === brk1.start
    && txt1?.text === t0[3] && txt1.scope === 'paragraph' && count(x1, DEL_BRK) === 1,
  `S1 글 문단 지움 → 최종본 한 문단 적게(빈 줄 없음), 같은 ref 의 변경 둘(${brief(c1)}) · 추적본에 paraend="1" 지움 표식`);
  ok(await untouchedOk(A, d1.id) && await roundTrip(A, d1.id) === 0, 'S1 묶음이 든 문서: 손대지 않은 작업본(엔진 사본·편집기 내보내기) → 커밋 없음·clean · 편집기 왕복 덩어리 0');

  // S2 뒤 문단에 남의 실시간 고침(liveTouch)·제안·요청을 두고 REST 로 둘 다 거절 → 지운 문단이 제 줄로(앞 문단 끝이 아님) · 뒤 문단 ref +1 · formatVersion 오름
  await push(B, d1.id, await makeHead(B, d1.id, (d) => replaceIn(d, 's0/p5', '기대 효과를', '기대 효과와 성과를')));
  const pr2 = await B(`${D1}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '1억 원', replace: '9천만 원' } });
  await A(`${D1}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 주세요', target: { ref: 's0/p6' }, route: 'queue' } });
  const m2a = metaOf(d1.id); const rid2 = m2a.requests.at(-1)?.rid;
  const fv2 = (await info(A, d1.id)).formatVersion ?? 0;
  const rj2 = await resolveIds(A, d1.id, c1.map((c) => c.id), 'reject');
  const i2 = await info(A, d1.id); const m2 = metaOf(d1.id); const c2 = await A(`${D1}/changes`); const t2 = await bodyTexts(A, d1.id);
  ok(m2a.liveTouch?.['s0/p5']?.by === nameB && rj2.ok === true && t2.length === t0.length && eq(t2.slice(0, 6), t0.slice(0, 6)) && t2[6] === t0[6].replace('기대 효과를', '기대 효과와 성과를') && t2[7] === t0[7]
    && i2.formatVersion === i2.version && i2.formatVersion > fv2
    && m2.proposals.find((p) => p.pid === pr2.pid)?.ref === 's0/p5' && m2.requests.find((r) => r.rid === rid2)?.target?.ref === 's0/p7'
    && m2.liveTouch?.['s0/p6']?.by === nameB && !m2.liveTouch?.['s0/p5'] && c2.length >= 1 && c2.every((c) => c.author === nameB && c.ref === 's0/p6'),
  `S2 둘 다 거절(REST /changes/resolve) → 지운 문단이 제 줄(s0/p3)로 · 뒤 문단의 제안·요청·liveTouch ref +1 · formatVersion 오름 · 남은 변경 ${brief(c2)}`);

  // S3 문단 넣기 → 앞 문단 끝 나눔 넣음(폭 0) + 새 문단 글 넣음 · 둘 다 거절 → 빈 줄 없음, 뒤 문단 ref −1
  const d3 = await trackedDoc('문단 나눔 넣기.hwpx'); const D3 = `/api/docs/${d3.id}`;
  const r3 = await push(A, d3.id, await makeHead(A, d3.id, (d) => d.insertParagraphAfter(0, 3, N3, ED)));
  const c3 = await A(`${D3}/changes`); const brk3 = c3.find((c) => c.kind === 'para'); const txt3 = c3.find((c) => !c.kind);
  const x3 = xmlOf(await fileOf(A, d3.id, 'tracked'));
  ok(r3.status === 200 && r3.data.clean === true && eq(r3.data.applied.inserted, ['s0/p4']) && eq(await bodyTexts(A, d3.id), [...t0.slice(0, 4), N3, ...t0.slice(4)])
    && c3.length === 2 && c3.every((c) => c.type === 'Insert' && c.author === nameA)
    && brk3?.ref === 's0/p3' && brk3.paraEnd === true && brk3.label === '문단 나눔 넣음' && brk3.start === [...t0[3]].length
    && txt3?.ref === 's0/p4' && txt3.text === N3 && txt3.start === 0 && count(x3, INS_BRK) === 1,
  `S3 문단 넣기 → 앞 문단 끝 나눔 넣음 + 새 문단 글 넣음(${brief(c3)})`);
  ok(await untouchedOk(A, d3.id) && await roundTrip(A, d3.id) === 0, 'S3 넣은 나눔이 든 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0');
  const pr3 = await B(`${D3}/proposals`, { method: 'POST', body: { ref: 's0/p6', find: '1억 원', replace: '9천만 원' } });
  const rj3 = await resolveIds(A, d3.id, c3.map((c) => c.id), 'reject');
  const m3 = metaOf(d3.id);
  ok(rj3.ok === true && eq(await bodyTexts(A, d3.id), t0) && (await A(`${D3}/changes`)).length === 0 && !MARKS.test(xmlOf(await fileOf(A, d3.id, 'tracked')))
    && m3.proposals.find((p) => p.pid === pr3.pid)?.ref === 's0/p5',
  'S3 둘 다 거절 → 빈 줄 없이 원래 문단 · 표식 없음 · 뒤 문단의 제안 ref −1');

  // S4 내가 넣은 문단을 다시 지움 → 글 넣음·나눔 넣음 모두 거둠(변경 0)
  const r4a = await push(A, d3.id, await makeHead(A, d3.id, (d) => d.insertParagraphAfter(0, 2, N3, ED)));
  const r4 = await push(A, d3.id, await makeHead(A, d3.id, (d) => d.removeBodyParagraph(0, 3)));
  ok(r4a.status === 200 && r4.status === 200 && r4.data.clean === true && eq(await bodyTexts(A, d3.id), t0) && (await A(`${D3}/changes`)).length === 0
    && !MARKS.test(xmlOf(await fileOf(A, d3.id, 'tracked'))),
  'S4 내가 넣은 문단을 다시 지움 → 변경 0 · 표식 없음 · 빈 줄 없음');

  // S5 한 밀어 넣기에 연속 문단 다섯 지움 → 변경 10(나눔 지움 5 + 글 지움 5) · clean
  const d5 = await trackedDoc('연속 문단 지우기.hwpx'); const D5 = `/api/docs/${d5.id}`;
  const r5 = await push(A, d5.id, await makeHead(A, d5.id, (d) => { for (let k = 6; k >= 2; k--) d.removeBodyParagraph(0, k); }));
  const c5 = await A(`${D5}/changes`);
  ok(r5.status === 200 && r5.data.clean === true && eq(await bodyTexts(A, d5.id), [t0[0], t0[1], t0[7]]) && c5.length === 10
    && c5.every((c) => c.type === 'Delete' && c.author === nameA && (c.ref === 's0/p1' || c.ref === 's0/p2')) && c5.filter((c) => c.kind === 'para').length === 5
    && eq(c5.filter((c) => !c.kind).map((c) => c.text).sort(), t0.slice(2, 7).sort()) && c5.filter((c) => !c.kind).every((c) => c.scope === 'paragraph'),
  `S5 한 밀어 넣기에 연속 문단 다섯 지움 → 변경 10(나눔 지움 5 + 글 지움 5 — 빈 앞 문단은 한/글처럼 뒤 문단 쪽 나눔이라 s0/p1·s0/p2: ${brief(c5)}) · clean`);
  ok(await untouchedOk(A, d5.id) && await roundTrip(A, d5.id) === 0, 'S5 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0');

  // S6 합침(다섯째 앞에서 Backspace)·가름(여섯째 가운데 Enter) — 기본 규칙(글 바꿈 + 문단 지우기/넣기 — 어느 문단을 짝짓느냐는 정렬이 정함) →
  //    최종 글 그대로 · 모두 거절 → 원래
  const d6 = await trackedDoc('합침과 가름.hwpx'); const D6 = `/api/docs/${d6.id}`;
  const r6a = await push(A, d6.id, await makeHead(A, d6.id, (d) => { d.mergeParagraphText('s0/p3', t0[3] + t0[4], ED); d.removeBodyParagraph(0, 4); }));
  const t6a = await bodyTexts(A, d6.id);
  const cut = [...'여섯째 문단: '].length; const h6 = [...t0[5]].slice(0, cut).join(''); const k6 = [...t0[5]].slice(cut).join('');
  const r6b = await push(A, d6.id, await makeHead(A, d6.id, (d) => { d.mergeParagraphText('s0/p4', h6, ED); d.insertParagraphAfter(0, 4, k6, ED); }));
  const t6b = await bodyTexts(A, d6.id); const c6 = await A(`${D6}/changes`);
  ok(r6a.status === 200 && r6a.data.clean === true && eq(t6a, [...t0.slice(0, 3), t0[3] + t0[4], ...t0.slice(5)])
    && r6b.status === 200 && r6b.data.clean === true && eq(t6b, [...t0.slice(0, 3), t0[3] + t0[4], h6, k6, ...t0.slice(6)])
    && c6.some((c) => c.kind === 'para' && c.type === 'Delete') && c6.some((c) => c.kind === 'para' && c.type === 'Insert'),
  `S6 합침·가름 → 최종 글 그대로(${brief(c6)})`);
  const rj6 = await resolveIds(A, d6.id, c6.map((c) => c.id), 'reject');
  ok(rj6.ok === true && eq(await bodyTexts(A, d6.id), t0) && (await A(`${D6}/changes`)).length === 0 && !MARKS.test(xmlOf(await fileOf(A, d6.id, 'tracked'))),
    'S6 모두 거절 → 원래 문단·글(빈 줄 없음, 표식 없음)');

  // S7 표 문단 지움 → '표 지움' + '문단 나눔 지움' · 둘 다 거절 → 표가 제 문단(앞 문단 끝이 아님)
  const d7 = await trackedDoc('표 문단 나눔.hwpx', await buildTableDoc()); const D7 = `/api/docs/${d7.id}`;
  const t7 = await bodyTexts(A, d7.id);
  const r7 = await push(A, d7.id, await makeHead(A, d7.id, (d) => d.removeBodyParagraph(0, 4)));
  const c7 = await A(`${D7}/changes`); const w7 = await fileOf(A, d7.id, 'working');
  ok(r7.status === 200 && r7.data.clean === true && c7.length === 2 && c7.some((c) => c.kind === 'object' && c.label === '표 지움' && c.ref === 's0/p3')
    && c7.some((c) => c.kind === 'para' && c.type === 'Delete' && c.ref === 's0/p3') && w7.tables().length === 0 && eq(await bodyTexts(A, d7.id), [...t7.slice(0, 4), ...t7.slice(5)]),
  `S7 표 문단 지움 → 표 지움 + 문단 나눔 지움(${brief(c7)})`);
  ok(await untouchedOk(A, d7.id) && await roundTrip(A, d7.id) === 0, 'S7 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0');
  const rj7 = await resolveIds(A, d7.id, c7.map((c) => c.id), 'reject');
  const w7b = await fileOf(A, d7.id, 'working');
  ok(rj7.ok === true && (await A(`${D7}/changes`)).length === 0 && w7b.tables().length === 1 && w7b._objectInfo('s0/p4').tables.length === 1 && w7b._objectInfo('s0/p3').tables.length === 0
    && eq(await bodyTexts(A, d7.id), t7),
  'S7 둘 다 거절 → 표가 제 문단(s0/p4)으로 돌아옴');

  // S8 한글로 저장: 보이는 그대로 = 지운 문단 없음·빈 줄·표식 없음 · 변경 추적 포함 = 문단마다 paraend="1" 지움 표식(한/글이 기대하는 꼴)
  const ex8a = await A.res(`${D5}/file?kind=export`); const e8a = await HwpxDoc.load(ex8a.data); const xa = xmlOf(e8a);
  await A(`${D5}/settings`, { method: 'PATCH', body: { exportKind: 'tracked' } });
  const ex8b = await A.res(`${D5}/file?kind=export`); const xb = xmlOf(await HwpxDoc.load(ex8b.data));
  await A(`${D5}/settings`, { method: 'PATCH', body: { exportKind: 'final' } });
  ok(ex8a.headers.get('x-export-kind') === 'final' && !ex8a.headers.get('x-export-fallback') && !/paraend="1"/.test(xa) && !MARKS.test(xa) && eq(e8a.bodyTexts()[0], [t0[0], t0[1], t0[7]])
    && ex8b.headers.get('x-export-kind') === 'tracked' && count(xb, DEL_BRK) === 5,
  'S8 한글로 저장: 보이는 그대로 = 빈 줄·표식 없음 · 변경 추적 포함 = 문단마다 paraend="1" 지움 표식');

  // S9 고친 글만(기본) 문서: 문단 넣기·지우기는 예전 그대로(변경 추적·paraend="1" 없음, 지운 문단은 문단째)
  const d9 = await uploadDoc(srv.base, TA, await buildMainDoc(), '고친 글만 문단.hwpx'); const D9 = `/api/docs/${d9.id}`;
  const r9 = await push(A, d9.id, await makeHead(A, d9.id, (d) => { d.removeBodyParagraph(0, 5); d.insertParagraphAfter(0, 2, N3, ED); }));
  const f9 = await fileOf(A, d9.id, 'tracked'); const x9 = xmlOf(f9);
  const want9 = [...t0.slice(0, 3), N3, ...t0.slice(3, 5), ...t0.slice(6)];
  ok((await info(A, d9.id)).settings.track === 'final' && r9.status === 200 && r9.data.clean === true && eq(await bodyTexts(A, d9.id), want9)
    && (await A(`${D9}/changes`)).length === 0 && !/paraend="1"/.test(x9) && !MARKS.test(x9) && f9.bodyTexts()[0].length === want9.length,
  'S9 고친 글만 문서: 문단 넣기·지우기 → 변경 추적 없음 · paraend="1" 없음 · 지운 문단은 문단째(물리 문단 수 = 최종본)');

  // S10 변경 추적 문서의 변경 요청 반영: 문단 넣기 → 나눔 넣음 + 글 넣음(작성자 = 변경 요청 작성자) · 둘 다 거절 → 빈 줄 없음
  const d10 = await trackedDoc('반영 문단 나눔.hwpx'); const D10 = `/api/docs/${d10.id}`;
  const N10 = '변경 요청으로 넣은 문단입니다.';
  const h10 = await makeHead(B, d10.id, (d) => d.insertParagraphAfter(0, 2, N10, ED));
  const cr10 = (await B(`${D10}/drafts/mine?base=${h10.version}`, { method: 'PUT', body: h10.bytes })).cr;
  const mg10 = await B(`${D10}/change-requests/${cr10.cid}/merge`, { method: 'POST' });
  const c10 = await A(`${D10}/changes`);
  ok(mg10.cr.status === 'merged' && c10.length === 2 && c10.every((c) => c.type === 'Insert' && c.author === nameB)
    && c10.some((c) => c.kind === 'para' && c.ref === 's0/p2') && c10.some((c) => !c.kind && c.ref === 's0/p3' && c.text === N10)
    && eq(await bodyTexts(A, d10.id), [...t0.slice(0, 3), N10, ...t0.slice(3)]),
  `S10 변경 요청 반영의 문단 넣기 → ${brief(c10)}`);
  await resolveIds(A, d10.id, c10.map((c) => c.id), 'reject');
  ok(eq(await bodyTexts(A, d10.id), t0) && (await A(`${D10}/changes`)).length === 0, 'S10 둘 다 거절 → 빈 줄 없음');

  // S11 묶음이 든 문서의 변경 요청 다시 맞추기·반영: 남(A)이 문단을 지운(추적) 뒤 B 의 옛 기준 수정본을 다시 맞춤 → 덩어리·ref 가 최종 번호
  const d11 = await trackedDoc('묶음 다시 맞추기.hwpx'); const D11 = `/api/docs/${d11.id}`;
  const h11 = await makeHead(B, d11.id, (d) => replaceIn(d, 's0/p7', '맺음말', '맺는말'));
  await B(`${D11}/drafts/mine?base=${h11.version}`, { method: 'PUT', body: h11.bytes });
  await push(A, d11.id, await makeHead(A, d11.id, (d) => d.removeBodyParagraph(0, 3)));
  const rb11 = await B(`${D11}/drafts/mine/rebase`, { method: 'POST' });
  const v11 = (await info(A, d11.id)).version; const t11 = t0[7].replace('맺음말', '맺는말');
  const rbDoc11 = await HwpxDoc.load((await B.res(`${D11}/drafts/mine/file`)).data);
  ok(rb11.conflicts.length === 0 && rb11.cr.baseVersion === v11 && rb11.cr.hunks.length === 1 && rb11.cr.hunks[0].ref === 's0/p6' && rb11.cr.hunks[0].newText === t11
    && eq(rbDoc11.bodyTexts()[0], [...t0.slice(0, 3), ...t0.slice(4, 7), t11]),
  `S11 다시 맞추기 → 덩어리 하나 ${rb11.cr.hunks.map((h) => `${h.type} ${h.ref}`).join(', ')}(최종 번호) · 수정본 = 지금 최종본 + 내 글`);
  const mg11 = await B(`${D11}/change-requests/${rb11.cr.cid}/merge`, { method: 'POST' });
  const c11 = await A(`${D11}/changes`);
  ok(mg11.cr.status === 'merged' && await textOf(A, d11.id, 's0/p6') === t11 && eq(await bodyTexts(A, d11.id), [...t0.slice(0, 3), ...t0.slice(4, 7), t11])
    && c11.filter((c) => c.author === nameA).length === 2 && c11.filter((c) => c.author === nameB).every((c) => c.ref === 's0/p6'),
  `S11 반영 → 그 문단만 바뀌고 묶음(지움 둘)은 그대로(${brief(c11)})`);

  // S12 두 사람: A 가 문단을 지운(추적) 뒤 옛 기준의 B 가 그 문단을 고쳐 보냄 → GONE(지운 문단·변경 그대로)
  const d12 = await trackedDoc('두 사람 문단 나눔.hwpx'); const D12 = `/api/docs/${d12.id}`;
  const hB12 = await makeHead(B, d12.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 목적을'));
  await push(A, d12.id, await makeHead(A, d12.id, (d) => d.removeBodyParagraph(0, 3)));
  const c12 = await A(`${D12}/changes`); const v12 = (await info(A, d12.id)).version;
  const r12 = await push(B, d12.id, hB12);
  ok(r12.status === 200 && r12.data.version === v12 && r12.data.skipped.length === 1 && r12.data.skipped[0].reason === 'GONE' && eq(await A(`${D12}/changes`), c12)
    && eq(await bodyTexts(A, d12.id), [...t0.slice(0, 3), ...t0.slice(4)]),
  `S12 A 가 지운(추적) 문단을 옛 기준의 B 가 고침 → GONE(지운 문단·변경 그대로) ${JSON.stringify(r12.data.skipped)}`);

  // S13 (2단계) 가운데 Enter → 한/글 꼴 그대로: 앞쪽 반 끝 폭 0 나눔 넣음 하나뿐(글 지움·넣음 없음 — 꼬리는 추적 없이 새 문단으로) · 거절 → 원래 한 문단
  const d13 = await trackedDoc('가운데 Enter.hwpx'); const D13 = `/api/docs/${d13.id}`;
  const cps13 = [...t0[4]]; const cut13 = cps13.indexOf('추'); const h13 = cps13.slice(0, cut13).join(''); const k13 = cps13.slice(cut13).join('');
  const r13 = await push(A, d13.id, await makeHead(A, d13.id, (d) => { d.mergeParagraphText('s0/p4', h13, ED); d.insertParagraphAfter(0, 4, k13, ED); }));
  const c13 = await A(`${D13}/changes`); const x13 = xmlOf(await fileOf(A, d13.id, 'tracked'));
  ok(cut13 > 0 && r13.status === 200 && r13.data.clean === true && eq(await bodyTexts(A, d13.id), [...t0.slice(0, 4), h13, k13, ...t0.slice(5)])
    && c13.length === 1 && c13[0].kind === 'para' && c13[0].type === 'Insert' && c13[0].ref === 's0/p4' && c13[0].start === cut13 && c13[0].author === nameA
    && count(x13, INS_BRK) === 1 && count(x13, /<hp:insertBegin\b/g) === 1 && count(x13, /<hp:delete(Begin|End)\b/g) === 0,
  `S13 가운데 Enter → 나눔 넣음 하나(${brief(c13)}) · 글 변경 없음(한/글 꼴 P머리{+¶+} / P꼬리)`);
  ok(await untouchedOk(A, d13.id) && await roundTrip(A, d13.id) === 0, 'S13 가른 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0');
  await resolveIds(A, d13.id, c13.map((c) => c.id), 'reject');
  ok(eq(await bodyTexts(A, d13.id), t0) && (await A(`${D13}/changes`)).length === 0 && !MARKS.test(xmlOf(await fileOf(A, d13.id, 'tracked'))),
    'S13 나눔 넣음 거절 → 원래 한 문단(표식 없음)');

  // S14 (2단계) 다섯째 머리에서 Backspace(합침) → 한/글 꼴 그대로: 앞 문단 끝 폭 0 나눔 지움 하나뿐(글 지움·넣음 없음) · 거절 → 두 문단
  const d14 = await trackedDoc('Backspace 합침.hwpx'); const D14 = `/api/docs/${d14.id}`;
  const r14 = await push(A, d14.id, await makeHead(A, d14.id, (d) => { d.mergeParagraphText('s0/p3', t0[3] + t0[4], ED); d.removeBodyParagraph(0, 4); }));
  const c14 = await A(`${D14}/changes`); const x14 = xmlOf(await fileOf(A, d14.id, 'tracked'));
  ok(r14.status === 200 && r14.data.clean === true && eq(await bodyTexts(A, d14.id), [...t0.slice(0, 3), t0[3] + t0[4], ...t0.slice(5)])
    && c14.length === 1 && c14[0].kind === 'para' && c14[0].type === 'Delete' && c14[0].ref === 's0/p3' && c14[0].start === [...t0[3]].length && c14[0].author === nameA
    && count(x14, DEL_BRK) === 1 && count(x14, /<hp:deleteBegin\b/g) === 1 && count(x14, /<hp:insert(Begin|End)\b/g) === 0,
  `S14 Backspace 합침 → 나눔 지움 하나(${brief(c14)}) · 글 변경 없음(한/글 꼴 P{-¶-}Q)`);
  ok(await untouchedOk(A, d14.id) && await roundTrip(A, d14.id) === 0, 'S14 합친 문서: 손대지 않은 작업본 → 커밋 없음·clean · 편집기 왕복 0');
  await resolveIds(A, d14.id, c14.map((c) => c.id), 'reject');
  ok(eq(await bodyTexts(A, d14.id), t0) && (await A(`${D14}/changes`)).length === 0 && !MARKS.test(xmlOf(await fileOf(A, d14.id, 'tracked'))),
    'S14 나눔 지움 거절 → 두 문단으로(표식 없음)');

  // S15 (2단계) 변경 추적 문서의 AI 표 제안 적용 → '표 넣음' + 문단 나눔 넣음(둘 다 제안 changeIds) · 변경 추적 탭에서 함께 거절 → 빈 줄 없이 원래 · 제안은 복구
  const d15 = await trackedDoc('표 제안 나눔.hwpx'); const D15 = `/api/docs/${d15.id}`;
  const pT15 = await B(`${D15}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p1', table: { rows: [['구분', '값'], ['가', '1']], headerRows: 1, caption: '' } } });
  const ap15 = await A(`${D15}/proposals/${pT15.pid}/apply`, { method: 'POST' });
  const c15 = await A(`${D15}/changes`); const tb15 = c15.find((c) => c.kind === 'object'); const br15 = c15.find((c) => c.kind === 'para');
  ok(ap15.status === 'applied' && tb15?.label === '표 넣음' && tb15.ref === 's0/p2' && br15?.type === 'Insert' && br15.ref === 's0/p1' && c15.every((c) => c.author === nameB)
    && ap15.changeIds.map(Number).includes(Number(tb15.id)) && ap15.changeIds.map(Number).includes(Number(br15.id)) && (await fileOf(A, d15.id, 'working')).tables().length === 1,
  `S15 표 제안 적용 → ${brief(c15)} · 제안 changeIds 에 표 넣음·나눔 넣음`);
  await resolveIds(A, d15.id, [tb15.id, br15.id], 'reject');
  const p15 = (await A(`${D15}/proposals`)).find((x) => x.pid === pT15.pid);
  ok(p15?.status === 'undone' && (await A(`${D15}/changes`)).length === 0 && eq(await bodyTexts(A, d15.id), t0) && (await fileOf(A, d15.id, 'working')).tables().length === 0
    && !MARKS.test(xmlOf(await fileOf(A, d15.id, 'tracked'))),
  'S15 표 넣음 + 나눔 넣음 거절 → 빈 줄 없이 원래 문단 · 제안은 복구(undone)');
  }

  // ───────── 8. 기록 파일 정리 ─────────
  section('기록 파일 정리(§2.6): 10분 안 기록이 200개를 넘으면 잘린 기록의 파일을 지움 — 기록 1·이정표·진행 중 변경 요청 기준은 남김');
  const dG = await uploadDoc(srv.base, TA, await buildMainDoc(), '기록 정리.hwpx');
  const DG = `/api/docs/${dG.id}`;
  const g1 = await push(A, dG.id, await makeHead(A, dG.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 배경을')));
  const g2 = await push(A, dG.id, await makeHead(A, dG.id, (d) => replaceIn(d, 's0/p4', '3월부터', '4월부터')));
  const msG = (await A(`${DG}/milestones`, { method: 'POST', body: { note: '중간 저장' } })).milestone;
  const crHead = await makeHead(B, dG.id, (d) => replaceIn(d, 's0/p5', '1억 원', '9천만 원'));
  const crG = (await B(`${DG}/drafts/mine?base=${crHead.version}`, { method: 'PUT', body: crHead.bytes })).cr;
  const g3 = await push(A, dG.id, await makeHead(A, dG.id, (d) => replaceIn(d, 's0/p6', '정리합니다', '정리해 둡니다')));
  ok(msG.n === g2.data.version && crG.baseVersion === g2.data.version && g3.data.version === g2.data.version + 1, `(전제) 이정표 n=${msG.n} · 진행 중 변경 요청 기준 n=${crG.baseVersion}`);
  const memoG = await A(`${DG}/memos`, { method: 'POST', body: { ref: 's0/p7', text: '기록 늘리기 0' } });
  // (리뷰 고침) 닫힌 변경 요청의 기준 기록 파일도 남긴다 — 다시 열면 저장·다시 맞추기·반영이 그 파일을 읽는다
  const clHead = await makeHead(C, dG.id, (d) => replaceIn(d, 's0/p3', '넷째 문단', '4번째 문단'));
  const crCl = (await C(`${DG}/drafts/mine?base=${clHead.version}`, { method: 'PUT', body: clHead.bytes })).cr;
  await C(`${DG}/change-requests/${crCl.cid}/close`, { method: 'POST' });
  const t0 = Date.now();
  for (let i = 1; i <= 205; i++) await A(`${DG}/memos/${memoG.id}`, { method: 'PATCH', body: { text: `기록 늘리기 ${i}` } });
  const histG = await A(`${DG}/history`);
  const vdir = path.join(srv.dataDir, 'docs', dG.id, 'versions');
  const files = new Set(fs.readdirSync(vdir).filter((n) => /^\d+\.hwpx$/.test(n)).map((n) => Number(n.slice(0, -5))));
  // 최근 200개(모두 10분 안 — 그 밖이면 30개) + 그보다 오래된 것 중 기록 1·이정표(v)·10분 묶음마다 마지막 기록(이 시험은 몇 초라 묶음 경계가 끼면 많아야 하나)
  const recentG = histG.versions.slice(-200); const oldG = histG.versions.slice(0, -200);
  const oldest = recentG[0].n;
  const looseG = oldG.filter((x) => x.v == null && x.n !== 1);
  const removed = []; for (let n = 2; n < oldest; n++) if (!files.has(n)) removed.push(n);
  ok(recentG.length === 200 && oldest > g3.data.version && oldG.some((x) => x.n === 1) && oldG.some((x) => x.n === msG.n && x.v === msG.v) && looseG.length <= 1,
    `기록 목록 = 최근 200개 + 옛 기록 중 기록 1·이정표 v${msG.v}(n=${msG.n})${looseG.length ? `·10분 묶음 기록 n=${looseG[0].n}` : ''} (${Date.now() - t0}ms 동안 ${205 + 1}번 저장)`);
  ok(files.has(1) && files.has(msG.n) && files.has(crG.baseVersion) && histG.versions.every((x) => files.has(x.n)),
    `남긴 파일: 기록 1 · 이정표 n=${msG.n} · 변경 요청 기준 n=${crG.baseVersion} · 목록의 기록 모두`);
  const keepOld = new Set([1, msG.n, crG.baseVersion, crCl.baseVersion, ...looseG.map((x) => x.n)]);
  let expectRemoved = 0; for (let n = 2; n < oldest; n++) if (!keepOld.has(n)) expectRemoved++;
  ok(!files.has(g1.data.version) && !files.has(g3.data.version) && removed.length === expectRemoved && crCl.baseVersion > g3.data.version && crCl.baseVersion < oldest,
    `잘린 기록 파일은 지움(n=${g1.data.version}·${g3.data.version} 등 ${removed.length}개 — 이정표·변경 요청 기준·10분 묶음 기록 빼고 모두; 진행 중 변경 요청 기준과 이정표가 같은 기록)`);
  const crClR = await C(`${DG}/change-requests/${crCl.cid}/reopen`, { method: 'POST' });
  const crClV = await C(`${DG}/change-requests/${crCl.cid}`);
  ok(files.has(crCl.baseVersion) && crClR.status === 'draft' && crClV.hunks.length === 1 && crClV.hunks[0].state === 'ok' && crClV.hunks[0].curRef === 's0/p3',
    `(리뷰 고침) 닫힌 변경 요청의 기준 기록(n=${crCl.baseVersion}) 파일도 남김 — 다시 열면 그대로 보임(curRef·state ok)`);
  await C(`${DG}/change-requests/${crCl.cid}/close`, { method: 'POST' });
  const kv = await A.res(`${DG}/file?kind=version&n=${msG.n}`); const kg = await A.res(`${DG}/file?kind=version&n=${g1.data.version}`);
  ok(kv.status === 200 && kg.status === 404 && kg.data.error === 'NO_VERSION', '이정표 기록은 내려받기·복구 가능, 지운 기록은 404 NO_VERSION');
  // (리뷰 고침) 정리된 기록을 기준으로 연 오래된 창의 수정본 저장(승인 방식 편집기의 길)도 404 가 아니라 409 STALE_BASE([내 글 옮겨 넣기]로 풂)
  const oldDraft = await A.res(`${DG}/drafts/mine?base=${g1.data.version}`, { method: 'PUT', body: crHead.bytes });
  ok(oldDraft.status === 409 && oldDraft.data.error === 'STALE_BASE' && oldDraft.data.baseVersion === histG.versions.at(-1).n && !(await A(`${DG}/drafts/mine`)).cr,
    `정리된 기록(n=${g1.data.version})을 기준으로 수정본 저장 → 409 STALE_BASE { baseVersion: 지금 기록 } · 수정본 안 만듦`);
  const crGv = await B(`${DG}/change-requests/${crG.cid}`);
  ok(crGv.hunks.length === 1 && crGv.hunks[0].curRef === 's0/p5' && crGv.hunks[0].state === 'ok', '진행 중 변경 요청은 기준 파일이 남아 그대로 보임(curRef·state)');

  // ───────── 9. 한글로 저장 kind=export ─────────
  section('한글로 저장 kind=export(§3): 보이는 그대로 + 메모 · 변경 추적 포함 + 메모 · 최종본을 못 만들면 X-Export-Fallback · 검토 메모는 승인 방식에서만');
  const exp = async (X, id) => { const r = await X.res(`/api/docs/${id}/file?kind=export`); return { r, doc: r.status === 200 ? await HwpxDoc.load(r.data) : null }; };
  const e1 = await exp(A, dL.id);
  const fname = (r) => decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(r.headers.get('content-disposition') || '')?.[1] || '');
  const memosL = await A(`${DL}/memos`);
  ok(e1.r.status === 200 && e1.r.headers.get('x-export-kind') === 'final' && !e1.r.headers.get('x-export-fallback') && fname(e1.r) === '실시간 회의록.hwpx'
    && e1.doc.changes().length === 0 && e1.doc.memos().length === memosL.length && e1.r.headers.get('x-review-memos') === '0' && Number(e1.r.headers.get('x-doc-version')) === (await A(DL)).version,
  `보이는 그대로(final): 「${fname(e1.r)}」 변경 추적 0 · 메모 ${e1.doc.memos().length}개(문서 메모 전부) · X-Export-Kind final`);
  await A(`${DK}/settings`, { method: 'PATCH', body: { exportKind: 'tracked' } });
  const e2 = await exp(B, dK.id);
  const chK = await A(`${DK}/changes`);
  ok(e2.r.status === 200 && e2.r.headers.get('x-export-kind') === 'tracked' && e2.doc.changes().length === chK.length && chK.length > 0 && e2.doc.memos().length === (await A(`${DK}/memos`)).length,
    `변경 추적 포함(tracked): 변경 추적 ${e2.doc.changes().length}건 + 메모`);
  const dS = await uploadDoc(srv.base, TA, await buildSpanDoc(), '문단 경계 변경.hwpx');
  let strictFails = false; try { await (await HwpxDoc.load(await buildSpanDoc())).flattened(); } catch (e) { strictFails = e.code === 'SPANS_PARAGRAPH'; }
  const e3 = await exp(A, dS.id);
  ok(strictFails && e3.r.status === 200 && e3.r.headers.get('x-export-fallback') === 'tracked' && e3.r.headers.get('x-export-kind') === 'tracked' && e3.doc.changes().some((c) => c.spansParagraph),
    '최종본을 엄격히 만들 수 없는 문서(문단 경계에 걸친 변경) → 변경 추적 포함으로 바꿔 냄 + X-Export-Fallback: tracked');
  // 그 문서에서 문단 경계 변경의 끝 표식을 덮는 실시간 글(OVERLAP — 변경은 앞 문단 ref 로 나온다) → 그 변경을 tolerant 로 수락하고 다시
  const s1 = (await bodyTexts(A, dS.id))[1];
  const hS = await makeHead(A, dS.id, (d) => replaceIn(d, 's0/p2', '셋째 문단은', '셋째 항목은'));
  const rS = await push(A, dS.id, hS);
  const e3b = await exp(A, dS.id);
  ok(rS.status === 200 && rS.data.clean && (await A(`/api/docs/${dS.id}/changes`)).length === 0 && (await bodyTexts(A, dS.id))[1] === s1 && await textOf(A, dS.id, 's0/p2') === '셋째 항목은 AI 제안대로 둡니다.'
    && e3b.r.headers.get('x-export-kind') === 'final' && !e3b.r.headers.get('x-export-fallback'),
  `문단 경계 변경의 끝을 덮는 실시간 글(고친 글만) → 그 변경을 보이는 그대로 수락하고 넣음(앞 문단 「${s1}」 그대로) — 그 뒤 한글로 저장은 보이는 그대로`);
  const e4 = await exp(A, dG.id);
  ok(e4.r.headers.get('x-review-memos') === '0' && e4.doc.memos().length === (await A(`${DG}/memos`)).length, '실시간 문서는 진행 중 변경 요청이 있어도 검토 메모를 넣지 않음(문서 메모만)');
  await A(`${DG}/settings`, { method: 'PATCH', body: { editMode: 'review' } });
  const e5 = await exp(A, dG.id);
  ok(Number(e5.r.headers.get('x-review-memos')) === 1 && e5.doc.memos().some((m) => m.text.startsWith(`[변경 요청 #${crG.cid} · 수정 중] ${nameB}`)), '승인 방식이면 진행 중 변경 요청의 검토 메모를 더함(V3 §3.7)');
  const legacy = await A.res(`${DG}/file?kind=tracked&reviews=1`);
  ok(legacy.status === 200 && legacy.headers.get('x-review-memos') === '1', '옛 kind(tracked&reviews=1)도 그대로');

  // ───────── 10. 실시간 문서의 AI 반영 ─────────
  section('실시간 문서의 AI 반영(§4.2·§4.3): 수정 권한 문(편집자도 바로) · 고친 글만 = 수락 · 글 되돌리기(바꿈·지우기·문단 추가) · STALE · aiMemo 요약 꼴');
  const dR = await uploadDoc(srv.base, TA, await buildMainDoc(), 'AI 실시간.hwpx');
  const DR = `/api/docs/${dR.id}`;
  const q = await A(`${DR}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '회의록을 다듬어 주세요', target: { ref: 's0/p3' }, route: 'queue' } });
  const rid = q.request.rid;
  await mcpOk(srv.base, TA, 'start_request', { doc_id: dR.id, request_id: rid }, AG);
  const pc = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: dR.id, request_id: rid, proposals: [
    { ref: 's0/p3', find: '사업 개요를', replace: '사업 개요와 목적을' },
    { ref: 's0/p5', find: '총 ', replace: '' },
    { ref: 's0/p6', find: '기대 효과를', replace: '기대 효과를 구체적으로' },
  ] }, AG);
  const [pr3, pr5, pr6] = pc.map((x) => x.proposal);
  const pIns = await mcpOk(srv.base, TA, 'propose_insert', { doc_id: dR.id, request_id: rid, after_ref: 's0/p7', text: '덧붙인 문단입니다.' }, AG);
  await mcpOk(srv.base, TA, 'complete_request', { doc_id: dR.id, request_id: rid, summary: '회의록 표현 네 곳을 다듬고 맺음말 뒤에 문단을 덧붙이도록 제안함.' }, AG);
  // 요약 메모는 대기 때 만들지 않고 첫 결과부터 만든다. 최신 요청의 메모 id 를 읽는다.
  const requestMemoId = (await A(`${DR}/requests/${rid}`)).memoId;
  let memoR = await memoText(A, dR.id, requestMemoId);
  ok(memoR === `[AI 작업 #${rid}] ${nameA} · 처리 Claude Code\n회의록 표현 네 곳을 다듬고 맺음말 뒤에 문단을 덧붙이도록 제안함.\n결과: 남은 제안 4건`,
    `작업 기록 메모(요약 꼴 — 기본):\n      ${indent(memoR)}`);
  await A(`${DR}/settings`, { method: 'PATCH', body: { editors: ['홍길동', '김검토'] } });
  const cd = { apply: await C.res(`${DR}/proposals/${pr3.pid}/apply`, { method: 'POST' }), reject: await C.res(`${DR}/proposals/${pr3.pid}/reject`, { method: 'POST' }),
    resolve: await C.res(`${DR}/requests/${rid}/resolve`, { method: 'POST', body: { reject: 'rest' } }), adopt: await C.res(`${DR}/proposals/${pr3.pid}/adopt`, { method: 'POST', body: {} }),
    viewer: await V.res(`${DR}/requests/${rid}/resolve`, { method: 'POST', body: { apply: 'rest' } }) };
  ok(Object.values(cd).every((r) => r.status === 403 && r.data.error === 'FORBIDDEN'), '수정 권한이 없으면 실시간 문서에서도 반영·거절·일괄 해결·수정본 반영 기록 403 FORBIDDEN');
  await A(`${DR}/settings`, { method: 'PATCH', body: { editors: 'all' } });
  const a3 = await B(`${DR}/proposals/${pr3.pid}/apply`, { method: 'POST' });
  ok(a3.status === 'applied' && eq(a3.changeIds, []) && a3.appliedFinal === true && a3.appliedRange?.ref === 's0/p3' && a3.appliedRange.start === 7 && a3.appliedRange.end === 7 + [...'사업 개요와 목적을'].length
    && await textOf(A, dR.id, 's0/p3') === '넷째 문단: 사업 개요와 목적을 적습니다.' && (await A(`${DR}/changes`)).length === 0,
  `편집자(요청자·관리자 아님)도 실시간 문서에서는 '기준에 바로 적용'(수정 권한) · 고친 글만 = 변경 추적 없이 수락 · appliedRange ${JSON.stringify({ start: a3.appliedRange?.start, end: a3.appliedRange?.end })}`);
  memoR = await memoText(A, dR.id, requestMemoId);
  ok(memoR.endsWith('\n결과: 반영 1건 · 남은 제안 3건') && !memoR.includes(' · 「') && !memoR.includes('이력:'), '요약 꼴 결과 줄: 반영 1건 · 남은 제안 3건(반영 목록·이력 줄 없음)');
  const m6 = await mcp(srv.base, TA, 'apply_proposal', { doc_id: dR.id, proposal_id: pr6.pid }, AG);
  ok(!m6.isError && m6.json.status === 'applied' && (await A(`${DR}/changes`)).length === 0, '편집자의 에이전트 MCP apply_proposal 도 실시간 문서에서는 됨(수정 권한 + allowAgentApply)');
  // AI 작업 해결 버전은 마지막 버전에서 30분(config.documents.aiMilestoneMinutes 기본)이 지나야 생긴다(V4 §2.6) — 올림(v1) 시각을 31분 전으로
  { const mp = path.join(srv.dataDir, 'docs', dR.id, 'meta.json'); const mm = JSON.parse(fs.readFileSync(mp, 'utf-8')); mm.milestones.at(-1).at = new Date(Date.now() - 31 * 60000).toISOString(); fs.writeFileSync(mp, JSON.stringify(mm, null, 1)); }
  const res1 = await A(`${DR}/requests/${rid}/resolve`, { method: 'POST', body: { apply: 'rest' } });
  ok(eq(res1.counts, { adopted: 0, applied: 2, rejected: 0, failed: 0 }) && res1.request.outcome.resolved && res1.milestone?.kind === 'request' && res1.milestone.note === `AI 작업 #${rid} 해결 — 적용 4건` && (await A(`${DR}/changes`)).length === 0
    && await textOf(A, dR.id, 's0/p5') === '여섯째 문단: 예산은 1억 원입니다.' && await textOf(A, dR.id, 's0/p8') === '덧붙인 문단입니다.',
  `resolve { apply: 'rest' } → 나머지 2건 적용(지우기·문단 추가) · 해결 · 버전 v${res1.milestone?.v} · 변경 추적 없음`);
  memoR = await memoText(A, dR.id, requestMemoId);
  const rq1 = await A(`${DR}/requests/${rid}`);
  ok(memoR === `[AI 작업 #${rid}] ${nameA} · 처리 Claude Code\n회의록 표현 네 곳을 다듬고 맺음말 뒤에 문단을 덧붙이도록 제안함.\n결과: 반영 4건 · ✓ 해결 ${fmtTime(rq1.resolvedAt)}`,
    `해결 뒤 요약 꼴:\n      ${indent(memoR)}`);
  // 글 되돌리기
  const nR = (await bodyTexts(A, dR.id)).length;
  const u3 = await A(`${DR}/proposals/${pr3.pid}/undo`, { method: 'POST' });
  const u5 = await A(`${DR}/proposals/${pr5.pid}/undo`, { method: 'POST' });
  const uI = await A(`${DR}/proposals/${pIns.pid}/undo`, { method: 'POST' });
  ok(u3.status === 'undone' && await textOf(A, dR.id, 's0/p3') === '넷째 문단: 사업 개요를 적습니다.' && u5.status === 'undone' && await textOf(A, dR.id, 's0/p5') === '여섯째 문단: 예산은 총 1억 원입니다.'
    && uI.status === 'undone' && (await bodyTexts(A, dR.id)).length === nR - 1 && (await A(`${DR}/changes`)).length === 0 && !u3.appliedRange,
  '되돌리기 = 글 되돌리기: 바꿈(적용한 글 → 원문)·지우기(지운 자리 앞뒤 글로 찾아 다시 넣음)·문단 추가(넣은 글 그대로면 문단째 지움) — 변경 추적 없음');
  const hR = await makeHead(B, dR.id, (d) => replaceIn(d, 's0/p6', '구체적으로', '자세히'));
  await push(B, dR.id, hR);
  const u6 = await A.res(`${DR}/proposals/${pr6.pid}/undo`, { method: 'POST' });
  ok(u6.status === 409 && u6.data.error === 'STALE' && /이력 탭에서 그 시점으로 복구/.test(u6.data.message) && (await A(`${DR}/proposals`)).find((p) => p.pid === pr6.pid).status === 'applied',
    `적용한 글을 그 뒤 남이 고쳤으면 409 STALE 「${u6.data.message}」`);
  // aiMemo 자세히
  await A(`${DR}/settings`, { method: 'PATCH', body: { aiMemo: 'detail' } });
  await A(`${DR}/requests/${rid}`, { method: 'PATCH', body: { summary: '회의록 다듬기' } });
  memoR = await memoText(A, dR.id, requestMemoId);
  const lines = memoR.split('\n');
  ok(lines[0] === `[AI 작업 #${rid}] 지시 · 요청 ${nameA} · 처리 Claude Code` && lines[1] === '요약: 회의록 다듬기' && lines.some((l) => l.startsWith(' · 「')) && lines.some((l) => l.startsWith('이력: ')),
    `aiMemo 'detail' → 다음에 다시 쓸 때 v0.3.1 꼴(요약·결과·반영 목록·이력):\n      ${indent(memoR)}`);
  await A(`${DR}/settings`, { method: 'PATCH', body: { aiMemo: 'summary' } });
  const longSum = `첫 줄 요약입니다.\n둘째 줄도 있습니다.\n\n\n\n${'가'.repeat(700)}`;
  await A(`${DR}/requests/${rid}`, { method: 'PATCH', body: { summary: longSum } });
  memoR = await memoText(A, dR.id, requestMemoId);
  const sumPart = memoR.split('\n').slice(1, -1).join('\n');
  ok(memoR.startsWith(`[AI 작업 #${rid}] ${nameA} · 처리 Claude Code\n첫 줄 요약입니다.\n둘째 줄도 있습니다.\n\n가`) && [...sumPart].length === 601 && sumPart.endsWith('…') && /\n결과: 반영 \d건 · ✓ 해결 /.test(memoR),
    '요약 꼴: 요약의 줄바꿈은 그대로(빈 줄은 하나로), 600자까지(넘으면 …)');

  // ───────── 11. 변경 요청 반영 · 승인 방식 문서 ─────────
  section('실시간 문서의 변경 요청 반영은 승인 없이(수정 권한 — 수정 중인 것도) · 승인 방식 문서는 v0.3 그대로');
  const dM = await uploadDoc(srv.base, TA, await buildMainDoc(), '변경 요청 실시간.hwpx');
  const DM = `/api/docs/${dM.id}`;
  const hM = await makeHead(B, dM.id, (d) => replaceIn(d, 's0/p4', '3월부터', '4월부터'));
  const crM = (await B(`${DM}/drafts/mine?base=${hM.version}`, { method: 'PUT', body: hM.bytes })).cr;
  ok(crM.status === 'draft' && crM.canMerge === true && eq(crM.mergeBlockers, []), '실시간 문서: 수정 중(draft) 변경 요청도 작성자가 바로 반영 가능(mergeBlockers 없음 — NEED_APPROVAL·NOT_SUBMITTED 없음)');
  const mM = await B(`${DM}/change-requests/${crM.cid}/merge`, { method: 'POST' });
  ok(mM.cr.status === 'merged' && await textOf(A, dM.id, 's0/p4') === '다섯째 문단: 추진 일정은 4월부터 12월까지입니다.' && (await A(`${DM}/changes`)).length === 0,
    '작성자 반영(승인 없음) → 문서에 들어감 · 고친 글만이면 변경 추적 없이');
  await A(`${DM}/settings`, { method: 'PATCH', body: { editors: ['홍길동'] } });
  const hM2 = await makeHead(B, dM.id, (d) => replaceIn(d, 's0/p5', '1억 원', '2억 원'));
  const dM2 = await B.res(`${DM}/drafts/mine?base=${hM2.version}`, { method: 'PUT', body: hM2.bytes });
  ok(dM2.status === 403 && dM2.data.error === 'FORBIDDEN', '수정 권한이 없으면 수정본 저장(변경 요청 만들기)도 403');
  await A(`${DM}/settings`, { method: 'PATCH', body: { editors: 'all' } });
  const dW = await uploadDoc(srv.base, TA, await buildMainDoc(), '승인 방식.hwpx');
  const DW = `/api/docs/${dW.id}`;
  await A(`${DW}/settings`, { method: 'PATCH', body: { editMode: 'review' } });
  const hW = await makeHead(B, dW.id, (d) => replaceIn(d, 's0/p4', '3월부터', '4월부터'));
  const crW = (await B(`${DW}/drafts/mine?base=${hW.version}`, { method: 'PUT', body: hW.bytes })).cr;
  const mWd = await B.res(`${DW}/change-requests/${crW.cid}/merge`, { method: 'POST' });
  await B(`${DW}/change-requests/${crW.cid}/submit`, { method: 'POST', body: { title: '일정' } });
  const mWo = await B.res(`${DW}/change-requests/${crW.cid}/merge`, { method: 'POST' });
  const pW = await A(`${DW}/proposals`, { method: 'POST', body: { ref: 's0/p7', find: '맺음말', replace: '맺는말' } });
  const aW = await B.res(`${DW}/proposals/${pW.pid}/apply`, { method: 'POST' });
  const lW = await push(B, dW.id, hW);
  ok(crW.mergeBlockers.some((x) => x.code === 'NOT_SUBMITTED') && mWd.status === 409 && mWd.data.error === 'STATE' && mWo.status === 403 && mWo.data.error === 'NEED_APPROVAL'
    && aW.status === 403 && aW.data.error === 'DIRECT_APPLY_FORBIDDEN' && lW.status === 409 && lW.data.error === 'NOT_REALTIME',
  '승인 방식: 수정 중 반영 409 STATE · 검토 중 반영 403 NEED_APPROVAL · 편집자 기준에 바로 적용 403 DIRECT_APPLY_FORBIDDEN · 밀어 넣기 409 NOT_REALTIME');
  const aWa = await ADM(`${DW}/proposals/${pW.pid}/apply`, { method: 'POST' });
  ok(aWa.status === 'applied' && aWa.changeIds.length === 2 && !aWa.appliedFinal && (await A(`${DW}/changes`)).length === 2, '승인 방식: 관리자 적용은 v0.3 그대로 변경 추적(삭제 + 삽입)');

  // ───────── 12-1. 실시간 문서의 다른 길 ─────────
  section('실시간 문서의 다른 길: 변경 추적으로 적용한 제안을 같은 사람의 실시간 글이 거절·다시 넣음 → 글로 되돌리기 · 편집본 올리기·복구도 고친 글만 · 수정 권한 · 30분 지난 마지막 작성자');
  const dX = await uploadDoc(srv.base, TA, await buildMainDoc(), '다른 길.hwpx');
  const DX = `/api/docs/${dX.id}`;
  await A(`${DX}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const pX = await A(`${DX}/proposals`, { method: 'POST', body: { ref: 's0/p4', find: '3월부터', replace: '4월부터' } });
  const aX = await A(`${DX}/proposals/${pX.pid}/apply`, { method: 'POST' });
  ok(aX.status === 'applied' && aX.changeIds.length === 2 && !aX.appliedFinal && (await A(`${DX}/changes`)).filter((c) => c.author === nameA).length === 2,
    "실시간·변경 추적으로: 제안 적용은 v0.3 처럼 변경 추적(작성자 = 제안자)");
  const hX = await makeHead(A, dX.id, (d) => replaceIn(d, 's0/p4', '12월까지', '11월까지'));
  await push(A, dX.id, hX);
  const pX2 = (await A(`${DX}/proposals`)).find((p) => p.pid === pX.pid);
  ok(eq(pX2.changeIds, []) && pX2.appliedFinal === true && pX2.appliedRange?.ref === 's0/p4' && (await textOf(A, dX.id, 's0/p4')) === '다섯째 문단: 추진 일정은 4월부터 11월까지입니다.',
    "같은 사람(제안자)이 그 문단을 실시간으로 고치면 그 사람의 변경(제안 것 포함)을 거절하고 '그 문단을 바꾼 전체'로 다시 — 제안은 changeIds 를 잃고 글로 되돌릴 자리를 적어 둠");
  const uX = await A(`${DX}/proposals/${pX.pid}/undo`, { method: 'POST' });
  ok(uX.status === 'undone' && (await textOf(A, dX.id, 's0/p4')) === '다섯째 문단: 추진 일정은 3월부터 11월까지입니다.', '그 제안 되돌리기 = 글 되돌리기(다른 고침 11월은 남음)');
  await A(`${DX}/settings`, { method: 'PATCH', body: { track: 'final' } });
  const { doc: wX, version: vX } = await working(A, dX.id);
  const wXe = await wX.clone(); replaceIn(wXe, 's0/p7', '맺음말', '맺음말(올림)');
  const upX = await A(`${DX}/upload?base=${vX}`, { method: 'PUT', body: Buffer.from(await wXe.save()) });
  const chX = await A(`${DX}/changes`);
  ok(upX.version === vX + 1 && upX.v != null && (await textOf(A, dX.id, 's0/p7')) === '여덟째 문단: 맺음말(올림)입니다.' && !chX.some((c) => c.ref === 's0/p7'),
    '편집본 올리기(PUT /upload)도 실시간·고친 글만이면 만든 변경을 수락(버전은 v0.3.1 처럼 오름)');
  const vRes = await V.res(`${DX}/versions/1/restore`, { method: 'POST' });
  const vAcc = await V.res(`${DX}/changes/accept-all`, { method: 'POST' });
  ok(vRes.status === 403 && vRes.data.error === 'FORBIDDEN' && vAcc.status === 403 && vAcc.data.error === 'FORBIDDEN', '수정 권한이 없으면 버전 복구·변경 추적 수락도 403');
  const rsX = await A(`${DX}/versions/1/restore`, { method: 'POST' });
  ok(rsX.v != null && (await bodyTexts(A, dX.id)).join('\n') === (await HwpxDoc.load(await buildMainDoc())).bodyTexts()[0].join('\n') && (await A(`${DX}/changes`)).length === 0,
    `버전 복구(v1)도 실시간·고친 글만이면 변경 추적 없이 글만 되돌림(v${rsX.v})`);
  // 30분 지난 마지막 작성자는 잊는다(덮어써도 알릴 사람 없음)
  const hY1 = await makeHead(B, dX.id, (d) => replaceIn(d, 's0/p6', '기대 효과를', '기대 효과는'));
  const hY2 = await makeHead(A, dX.id, (d) => replaceIn(d, 's0/p6', '기대 효과를', '기대 효과도'));
  await push(B, dX.id, hY1);
  const metaX = path.join(srv.dataDir, 'docs', dX.id, 'meta.json');
  const mx = JSON.parse(fs.readFileSync(metaX, 'utf-8'));
  ok(mx.liveTouch?.['s0/p6']?.by === nameB, `(전제) meta.liveTouch 에 그 문단의 마지막 실시간 작성자 ${JSON.stringify(mx.liveTouch?.['s0/p6'])}`);
  mx.liveTouch['s0/p6'].at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  fs.writeFileSync(metaX, JSON.stringify(mx, null, 1));
  const rY = await push(A, dX.id, hY2);
  const mx2 = JSON.parse(fs.readFileSync(metaX, 'utf-8'));
  ok(eq(rY.data.conflicts, [{ ref: 's0/p6', by: nameA, to: null }]) && mx2.liveTouch['s0/p6'].by === nameA && Object.values(mx2.liveTouch).every((t) => Date.parse(t.at) > Date.now() - 30 * 60 * 1000),
    '30분 지난 실시간 기록은 잊음 — 겹쳐 덮어써도 알릴 사람 없음(to null) · 새 작성자로 바뀜');

  // ───────── 12. 옛 문서·config 기본값 ─────────
  section('옛 문서(settings 없음)·모르는 값 → 기본값 · config.documents.defaultEditMode');
  const metaPath = path.join(srv.dataDir, 'docs', dM.id, 'meta.json');
  const mj = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  delete mj.settings; delete mj.liveTouch;
  fs.writeFileSync(metaPath, JSON.stringify(mj, null, 1));
  ok(eq((await B(DM)).settings, DEF) && (await B(DM)).canEdit, '옛 문서(meta 에 settings 없음) → 기본값(실시간·편집자 모두 …)');
  mj.settings = { editMode: 'bogus', editors: 5, track: 'x', exportKind: 'tracked', aiMemo: null, aiQuick: 'maybe' };
  fs.writeFileSync(metaPath, JSON.stringify(mj, null, 1));
  ok(eq((await B(DM)).settings, { ...DEF, exportKind: 'tracked' }), '모르는 값만 기본값으로(아는 값은 그대로)');
  const hOldDoc = await makeHead(A, dM.id, (d) => replaceIn(d, 's0/p7', '맺음말', '맺는말'));
  ok((await push(A, dM.id, hOldDoc)).status === 200, '옛 문서도 실시간으로 밀어 넣기 됨');
  const svcDef = (documents) => new Service({ store: { dir: fs.mkdtempSync(path.join(srv.tmpDir, 'svc-')) }, hub: { broadcast() {} }, config: { documents }, ai: null })._settingDefaults();
  ok(svcDef(undefined).editMode === 'realtime' && svcDef({ defaultEditMode: 'review' }).editMode === 'review' && svcDef({ defaultEditMode: 'bogus' }).editMode === 'realtime'
    && eq(svcDef({ defaultAiMemo: 'detail', defaultTrack: 'tracked', defaultExportKind: 'tracked', defaultAiQuick: 'compose', defaultAiApply: 'auto' }), { editMode: 'realtime', editors: 'all', track: 'tracked', exportKind: 'tracked', aiMemo: 'detail', aiQuick: 'compose', aiApply: 'auto' })
    && svcDef({ defaultAiQuick: 'bogus' }).aiQuick === 'send' && svcDef({ defaultAiApply: 'bogus' }).aiApply === 'manual',
  'config.documents.defaultEditMode(없음·모르는 값 → realtime) · (서버 config 덧붙임) defaultTrack·defaultExportKind·defaultAiMemo·defaultAiQuick·defaultAiApply');
  const srvR = await startServer({ ai: 'off', config: { documents: { defaultEditMode: 'review' } } }); servers.push(srvR);
  const dRv = await uploadDoc(srvR.base, srvR.tokens.a, await buildMainDoc(), '기본 승인.hwpx');
  ok(dRv.settings.editMode === 'review' && eq({ ...dRv.settings, editMode: 'realtime' }, DEF), 'config documents.defaultEditMode = review → 새 문서는 승인 방식');
  await srvR.stop();

  // ───────── 13. 리뷰 고침(회귀) ─────────
  section('리뷰 고침: 옛 기준 다시 보내기(같은 창)는 문단을 두 번 넣지 않음 · 지워진 문단의 적용 제안 되돌리기 · 변경 추적으로 — 내 삽입 글 안 남의 메모 · 실시간 반영의 처리 안 된 변경 추적');
  /** 편집기 문서 d(기준 기록 version)에 더 고친 것 — 기준을 옮기지 않은 창(치는 중 · 응답을 못 받은 재시도) */
  const headFrom = async (d, version, edit) => { const w = await d.clone(); await edit(w); const flat = await w.flattened(); return { bytes: Buffer.from(await flat.save()), version, doc: flat }; };
  const zS = await uploadDoc(srv.base, TA, await buildMainDoc(), '옛 기준 다시 보내기.hwpx');
  const zW = await working(A, zS.id);
  const zA1 = await headFrom(zW.doc, zW.version, (d) => d.insertParagraphAfter(0, 3, '새 문', ED));
  await push(B, zS.id, await makeHead(B, zS.id, (d) => replaceIn(d, 's0/p6', '정리합니다', '정리해 둡니다')));
  const zr1 = await push(A, zS.id, zA1);
  const zr1b = await push(A, zS.id, zA1);   // 응답을 못 받은 재시도(같은 바이트·같은 기준)
  const zA2 = await headFrom(zA1.doc, zA1.version, (d) => d.mergeParagraphText('s0/p4', '새 문단을 계속 칩니다', ED));   // clean 이 아니라 기준을 못 옮긴 채 계속 침
  const zr2 = await push(A, zS.id, zA2);
  const zT1 = await bodyTexts(A, zS.id);
  ok(zr1.data.clean === false && zr1b.status === 200 && zr2.status === 200 && zT1.filter((t) => t.startsWith('새 문')).length === 1 && zT1[4] === '새 문단을 계속 칩니다'
    && zT1.includes('일곱째 문단: 기대 효과를 정리해 둡니다.') && zT1.length === 9 && eq(zr2.data.applied.changed, ['s0/p4']) && eq(zr2.data.applied.inserted, []),
  `옛 기준에서 다시 보낸 문서(재시도·계속 침) → 그 창이 앞서 넣은 문단을 고침(두 번 넣지 않음) ${JSON.stringify(zr2.data.applied)}`);
  await push(B, zS.id, await makeHead(B, zS.id, (d) => replaceIn(d, 's0/p4', '새 문단을', '새로운 문단을')));   // 맞춘 남(B)이 그 새 문단을 고침
  const zA3 = await headFrom(zA2.doc, zA2.version, (d) => d.mergeParagraphText('s0/p4', '새 문단을 계속 칩니다. 더 씁니다', ED));
  const zr3 = await push(A, zS.id, zA3);
  const zT2 = await bodyTexts(A, zS.id);
  ok(zr3.status === 200 && zT2.length === 9 && zT2[4] === '새로운 문단을 계속 칩니다. 더 씁니다' && eq(zr3.data.conflicts, []),
    `그새 남이 그 새 문단을 고쳤으면 3-way(그 창이 마지막에 보낸 글 기준)로 둘 다: 「${zT2[4]}」`);
  const zB4 = await makeHead(B, zS.id, (d) => d.insertParagraphAfter(0, 4, 'B 가 같은 자리에 넣은 문단', ED));
  await push(B, zS.id, zB4);
  const zA4 = await headFrom(zA3.doc, zA3.version, (d) => d.insertParagraphAfter(0, 4, 'A 가 더 넣은 문단', ED));
  await push(A, zS.id, zA4);
  const zT3 = await bodyTexts(A, zS.id);
  ok(zT3.length === 11 && zT3.filter((t) => t.includes('문단을 계속 칩니다')).length === 1 && zT3.includes('B 가 같은 자리에 넣은 문단') && zT3.indexOf('A 가 더 넣은 문단') === zT3.indexOf('새로운 문단을 계속 칩니다. 더 씁니다') + 1,
    '남이 같은 틈에 넣은 문단은 짝으로 삼지 않음(둘 다 남음) · 그 창의 새 문단은 그 창이 앞서 넣은 문단 바로 뒤에');
  // 같은 창 재시도(같은 바이트·같은 기준)가 그새 남이 바로 옆에 친 글을 지우지 않음 — 옛 기준과의 3-way 를 다시 하면 남의 글이 내 앞 고침과
  // 한 덩어리 편집으로 잡혀 겹침(보낸 글이 이김)이 되어 「사업 목적을 목적을」 같은 글이 된다 → 이미 보낸 글 그대로면 건너뜀(liveTouch pushed)
  const zF = await uploadDoc(srv.base, TA, await buildMainDoc(), '재시도 옆 글.hwpx');
  const zFa = await makeHead(A, zF.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 목적을'));
  const zFr1 = await push(A, zF.id, zFa);
  await push(B, zF.id, await makeHead(B, zF.id, (d) => replaceIn(d, 's0/p3', '사업 목적을', '사업 주요 목적을')));
  const zFr2 = await push(A, zF.id, zFa);
  ok(zFr1.data.clean && zFr2.status === 200 && zFr2.data.version === zFr1.data.version + 1 && eq(zFr2.data.applied, { changed: [], inserted: [], deleted: [] }) && eq(zFr2.data.conflicts, [])
    && await textOf(A, zF.id, 's0/p3') === '넷째 문단: 사업 주요 목적을 적습니다.',
  `같은 창 재시도 → 아무것도 바꾸지 않음(남이 바로 옆에 친 「주요 」 그대로): 「${await textOf(A, zF.id, 's0/p3')}」`);
  const zMeta = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'docs', zS.id, 'meta.json'), 'utf-8'));
  ok(Object.values(zMeta.liveTouch).some((t) => t.ins?.by === nameA && t.ins.base === zW.version && t.ins.text === '새 문단을 계속 칩니다. 더 씁니다'),
    'meta.liveTouch[ref].ins = { by, base, text } — 그 창이 넣은 문단(이 기준에서 다시 보내면 알아봄)');

  // 지워진 문단의 적용 제안: 되돌리기가 그 번호의 다른 문단을 고치거나 지우지 않음
  const zD = await uploadDoc(srv.base, TA, await buildMainDoc(), '지운 문단의 제안.hwpx');
  const ZD = `/api/docs/${zD.id}`;
  const zpT = await A(`${ZD}/proposals`, { method: 'POST', body: { type: 'table', afterRef: 's0/p3', table: { rows: [['가', '나'], ['1', '2']], caption: '표 캡션' } } });
  const zpTa = await A(`${ZD}/proposals/${zpT.pid}/apply`, { method: 'POST' });
  // 캡션은 표 안(…/n0)이라 따로 지울 캡션 문단이 없다. 실시간 밀어 넣기가 표 문단을 지운다(표·그림 지우기, 2026-10-28) →
  // 이미 없는 표의 되돌리기는 409 STATE 로 멈추고 그 번호의 다른 문단을 고치거나 지우지 않는다
  const zAt = Number(zpTa.insertedRef.split('/p')[1]);
  const zPush = await push(A, zD.id, await makeHead(A, zD.id, async (d) => d.removeBodyParagraph(0, zAt)));
  const zT4 = await bodyTexts(A, zD.id);
  const zuT = await A.res(`${ZD}/proposals/${zpT.pid}/undo`, { method: 'POST' });
  const zT5 = await bodyTexts(A, zD.id);
  ok(zpTa.captionRef === `${zpTa.insertedRef}/n0` && zPush.data.unsupported === 0 && eq(zPush.data.applied?.deleted, [zpTa.insertedRef])
    && zuT.status === 409 && zuT.data?.error === 'STATE' && eq(zT5, zT4) && zT5.includes('다섯째 문단: 추진 일정은 3월부터 12월까지입니다.'),
    `표 제안(표 안 캡션) — 실시간으로 표 문단을 지운 뒤 되돌리기 → 409, 다른 문단은 그대로(캡션 ${zpTa.captionRef} 은 표와 함께 지워짐) ${zT4.length} → ${zT5.length} · 되돌리기 ${zuT.status}`);
  const zq = await A(`${ZD}/requests`, { method: 'POST', body: { kind: 'instruct', instruction: '다듬어 주세요', target: { ref: 's0/p0' }, route: 'queue' } });
  // (표 문단을 지워 문단 번호는 처음과 같다: s0/p4 다섯째 · s0/p5 여섯째 · s0/p6 일곱째 · s0/p7 여덟째)
  const zpc = await mcpOk(srv.base, TA, 'propose_changes', { doc_id: zD.id, request_id: zq.request.rid, proposals: [{ ref: 's0/p5', find: '입니다', replace: '합니다' }, { ref: 's0/p7', find: '맺음말', replace: '맺는말' }] }, AG);
  const zpI = await mcpOk(srv.base, TA, 'propose_insert', { doc_id: zD.id, request_id: zq.request.rid, after_ref: 's0/p4', text: '넣은 문단' }, AG);
  const [zp6, zp8] = zpc.map((x) => x.proposal);
  await A(`${ZD}/proposals/${zp6.pid}/apply`, { method: 'POST' }); await A(`${ZD}/proposals/${zpI.pid}/apply`, { method: 'POST' });
  await A(`${ZD}/proposals/${zp8.pid}/reject`, { method: 'POST' });
  const zT6 = await bodyTexts(A, zD.id);
  // 바꿈 제안의 문단(여섯째 …합니다)·넣은 문단·거절한 제안의 문단(여덟째)을 실시간으로 통째로 지움(메모 없는 문단 — 요청 제안은 제안 메모가 없다)
  const zGone = ['여섯째 문단: 예산은 총 1억 원합니다.', '넣은 문단', '여덟째 문단: 맺음말입니다.'].map((t) => zT6.indexOf(t));
  await push(A, zD.id, await makeHead(A, zD.id, (d) => { for (const i of [...zGone].sort((x, y) => y - x)) d.removeBodyParagraph(0, i); }));
  const zT7 = await bodyTexts(A, zD.id);
  const zu6 = await A.res(`${ZD}/proposals/${zp6.pid}/undo`, { method: 'POST' });
  const zuI = await A.res(`${ZD}/proposals/${zpI.pid}/undo`, { method: 'POST' });
  const zo8 = await A.res(`${ZD}/proposals/${zp8.pid}/reopen`, { method: 'POST' });
  const za8 = await A.res(`${ZD}/proposals/${zp8.pid}/apply`, { method: 'POST' });
  ok(zGone.every((i) => i >= 0) && zu6.status === 409 && zu6.data.error === 'STALE' && zuI.status === 409 && zuI.data.error === 'STALE' && zo8.status === 200 && za8.status === 409 && za8.data.error === 'GONE'
    && eq(await bodyTexts(A, zD.id), zT7) && zT7.includes('일곱째 문단: 기대 효과를 정리합니다.'),
  `그 문단이 통째로 지워진 바꿈·문단 추가 제안 되돌리기 → 409 STALE · 거절 뒤 문단이 지워진 제안을 다시 열어 적용 → 409 GONE — 다음 문단(일곱째 …정리합니다)을 고치거나 빈 줄을 지우지 않음`);

  // 변경 추적으로: 내 처리 안 된 삽입 글 안에 남이 메모를 달아도 그 문단을 계속 밀어 넣을 수 있음(거절할 수 없는 내 변경은 수락하고 다시)
  const zK = await uploadDoc(srv.base, TA, await buildMainDoc(), '변경 추적 메모.hwpx');
  const ZK = `/api/docs/${zK.id}`;
  await A(`${ZK}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  await push(A, zK.id, await makeHead(A, zK.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와 추진 배경을')));
  await B(`${ZK}/memos`, { method: 'POST', body: { ref: 's0/p3', find: '추진 배경', text: '배경 근거?' } });
  const zrK = await push(A, zK.id, await makeHead(A, zK.id, (d) => replaceIn(d, 's0/p3', '적습니다', '적어 둡니다')));
  ok(zrK.status === 200 && await textOf(A, zK.id, 's0/p3') === '넷째 문단: 사업 개요와 추진 배경을 적어 둡니다.' && (await A(`${ZK}/changes`)).some((c) => c.ref === 's0/p3' && c.author === nameA),
    `내 삽입 글 안에 남의 메모 → 같은 문단 다음 밀어 넣기 ${zrK.status}(그전엔 400 CTRL_INSIDE 로 영영 막힘) · 새 고침은 변경 추적으로`);

  // 실시간(고친 글만) 문서의 변경 요청 반영: 덩어리가 처리 안 된 변경 추적과 겹치면 그 문단 것을 수락하고 반영(승인 방식 때 남은 수정본)
  const zP = await uploadDoc(srv.base, TA, fs.readFileSync(FX), '실시간 반영 변경 추적.hwpx');
  const ZP = `/api/docs/${zP.id}`;
  const zpP = await A(`${ZP}/proposals`, { method: 'POST', body: { ref: 's0/p1', find: '추가한', replace: '더한' } });
  const zhP = await makeHead(B, zP.id, (d) => replaceIn(d, 's0/p1', '추가한', '더한'));
  const zcr = (await B(`${ZP}/drafts/mine?base=${zhP.version}`, { method: 'PUT', body: zhP.bytes })).cr;
  await B(`${ZP}/proposals/${zpP.pid}/adopt`, { method: 'POST', body: { cid: zcr.cid } });
  const zcrV = await B(`${ZP}/change-requests/${zcr.cid}`);
  const zmP = await B.res(`${ZP}/change-requests/${zcr.cid}/merge`, { method: 'POST' });
  const zchP = await A(`${ZP}/changes`);
  const zpP2 = (await A(`${ZP}/proposals`)).find((x) => x.pid === zpP.pid);
  ok(zcrV.canMerge === true && zmP.status === 200 && !zchP.some((c) => c.ref === 's0/p1') && zchP.length === 2
    && await textOf(A, zP.id, 's0/p1') === '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 더한 문장)' && zpP2.status === 'applied' && zpP2.appliedFinal === true,
  `처리 안 된 변경 추적과 겹치는 덩어리(PENDING_TRACKED) → 실시간·고친 글만이면 그 문단 변경 추적을 수락하고 반영 ${zmP.status}(canMerge ${zcrV.canMerge}) · 다른 문단 것은 그대로`);
  const zuP = await A.res(`${ZP}/proposals/${zpP.pid}/undo`, { method: 'POST' });
  ok(zuP.status === 200 && await textOf(A, zP.id, 's0/p1') === '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)', '반영으로 적용된 제안 되돌리기 = 글 되돌리기');
  // 다시 맞추기로 글이 합쳐져 제 변경을 가려내지 못한 반영 제안도 글 되돌리기(그전엔 409 STATE '되돌릴 변경이 남아 있지 않습니다')
  const zR = await uploadDoc(srv.base, TA, await buildMainDoc(), '다시 맞춘 반영 제안.hwpx');
  const ZR = `/api/docs/${zR.id}`;
  const zpR = await A(`${ZR}/proposals`, { method: 'POST', body: { ref: 's0/p3', find: '사업 개요를', replace: '사업 내용을' } });
  const zhR = await makeHead(B, zR.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 내용을'));
  const zcrR = (await B(`${ZR}/drafts/mine?base=${zhR.version}`, { method: 'PUT', body: zhR.bytes })).cr;
  await B(`${ZR}/proposals/${zpR.pid}/adopt`, { method: 'POST', body: { cid: zcrR.cid } });
  await push(A, zR.id, await makeHead(A, zR.id, (d) => replaceIn(d, 's0/p3', '사업 개요를', '사업 개요와')));
  const zm1 = await B.res(`${ZR}/change-requests/${zcrR.cid}/merge`, { method: 'POST' });
  await B(`${ZR}/drafts/mine/rebase`, { method: 'POST' });
  const zm2 = await B.res(`${ZR}/change-requests/${zcrR.cid}/merge`, { method: 'POST' });
  const zpR2 = (await A(`${ZR}/proposals`)).find((x) => x.pid === zpR.pid);
  const zuR = await A.res(`${ZR}/proposals/${zpR.pid}/undo`, { method: 'POST' });
  ok(zm1.status === 409 && zm2.status === 200 && zpR2.status === 'applied' && eq(zpR2.changeIds, []) && zpR2.appliedFinal === true && zuR.status === 200
    && await textOf(A, zR.id, 's0/p3') === '넷째 문단: 사업 개요를 적습니다.',
  `충돌 → 다시 맞추기 → 반영으로 적용된 제안(변경 id 를 못 가림)도 appliedFinal → 되돌리기 ${zuR.status}(글 되돌리기)`);

  // ───────── 14. 표 칸 안 Enter·Backspace(칸 문단 수가 바뀜) — 글을 줄바꿈으로 접어 넣음(회귀) ─────────
  section('표 칸 안 Enter·Backspace: 칸 문단 수는 그대로, 친 글은 줄바꿈(\\n = <hp:lineBreak/>)으로 공유 문서에 — 같은 표 다른 칸 동시 편집 · 같은 칸 3-way · 변경 추적으로 · 격자 변경은 그대로 반영 안 됨');
  // (예전: 칸 문단 수가 바뀐 표는 칸 글을 하나도 비교하지 않아 밀어 넣기가 아무것도 넣지 못하고(unsupported) 편집기를 기준에 맞추면 그 표에 친 글이 모두 사라졌다)
  const fD = await uploadDoc(srv.base, TA, await buildFormDoc(), '회의록 서식.hwpx');
  const FD = `/api/docs/${fD.id}`;
  const wsF = watchWs(srv.base, srv.tokens.b, fD.id); sockets.push(wsF); await wsF.ready;
  const cellsOf = async (X, id, row, col) => (await parasOf(X, id)).filter((p) => p.cell && p.cell.row === row && p.cell.col === col);
  const fBase = await cellsOf(A, fD.id, 2, 1);
  const nNested = (await parasOf(A, fD.id)).filter((p) => p.parent).length;
  ok(eq(fBase.map((p) => [p.ref, p.text]), [['s0/p1/n5', FORM_CELL[0]], ['s0/p1/n6', FORM_CELL[1]]]) && (await bodyTexts(A, fD.id))[1] === '',
    `(전제) 서식 문서: 본문 s0/p1 = 표(글 없음), 내용 칸(2,1) = 문단 둘 ${JSON.stringify(fBase.map((p) => p.ref))}`);
  // A: 내용 칸 둘째 문단 끝에서 Enter 하고 새 줄에 이어 침(편집기 칸 문단 3개)
  const fW = await working(A, fD.id);
  const fA1 = await (async () => { const w = await fW.doc.clone(); setCellParas(w, ['s0/p1/n6'], [FORM_CELL[1], '  ㅇ 새로 친 줄']); return { bytes: Buffer.from(await (await w.flattened()).save()), version: fW.version, doc: w }; })();
  const fr1 = await push(A, fD.id, fA1, { seq: 41 });
  const fCell1 = await cellsOf(B, fD.id, 2, 1);
  ok(fr1.status === 200 && fr1.data.version === fW.version + 1 && eq(fr1.data.applied, { changed: ['s0/p1/n6'], inserted: [], deleted: [] }) && fr1.data.unsupported === 0
    && fr1.data.clean === false && eq(fr1.data.skipped, []),
  `칸 안 Enter + 이어 친 글 → 그 칸 문단에 접어 넣음(applied ${JSON.stringify(fr1.data.applied)} · unsupported 0 · 편집기 칸 문단 수가 달라 clean false → 편집기가 기준에 맞춤)`);
  ok(eq(fCell1.map((p) => p.text), [FORM_CELL[0], `${FORM_CELL[1]}\n  ㅇ 새로 친 줄`]) && (await parasOf(A, fD.id)).filter((p) => p.parent).length === nNested
    && (await A(`${FD}/changes`)).length === 0,
  `공유 문서: 칸 문단 수 그대로(${nNested}), 친 글은 줄바꿈으로 「${fCell1[1]?.text.replace(/\n/g, '⏎')}」 · 고친 글만(변경 추적 없음)`);
  const fXml = (await HwpxDoc.load((await A.res(`${FD}/file?kind=tracked`)).data)).sections[0].xml;
  ok(fXml.includes('납품자료 검토<hp:lineBreak/>  ㅇ 새로 친 줄'), '문서 XML 은 <hp:lineBreak/>(한글·편집기가 같은 문단 안 줄바꿈으로 읽음)');
  const fWs = await wsF.waitFor((m) => m.type === 'doc' && m.action === 'changed' && m.version === fr1.data.version);
  ok(fWs.live === true && eq(fWs.changed, ['s0/p1/n6']) && fWs.seq === 41, 'WS doc changed live — 바뀐 칸 ref(남의 편집기가 맞춤)');
  // A 가 맞추기 전에(옛 기준 그대로) 계속 침 — 글이 두 번 들어가지 않고 마지막 글로
  const fA2 = await headFrom(fA1.doc, fA1.version, (d) => setCellParas(d, ['s0/p1/n6', 's0/p1/n7'], [FORM_CELL[1], '  ㅇ 새로 친 줄을 계속 칩니다']));
  const fr2 = await push(A, fD.id, fA2);
  ok(fr2.status === 200 && eq(fr2.data.applied.changed, ['s0/p1/n6']) && fr2.data.conflicts.every((c) => c.to === null)
    && (await textOf(A, fD.id, 's0/p1/n6')) === `${FORM_CELL[1]}\n  ㅇ 새로 친 줄을 계속 칩니다`,
  `옛 기준에서 계속 친 글 → 마지막 글 그대로(두 번 들어가지 않음): 「${(await textOf(A, fD.id, 's0/p1/n6'))?.replace(/\n/g, '⏎')}」`);
  // B(같은 옛 기준): 같은 표 다른 칸(참석) + 같은 칸 앞부분(1차 → 2차) — 3-way 로 모두 남는다
  const fB = await headFrom(fW.doc, fW.version, (d) => { d.mergeParagraphText('s0/p1/n3', '김민준, 이서연, 박지호', ED); replaceIn(d, 's0/p1/n6', '1차', '2차'); });
  const frB = await push(B, fD.id, fB);
  ok(frB.status === 200 && eq(frB.data.applied.changed, ['s0/p1/n3', 's0/p1/n6']) && eq(frB.data.conflicts, [])
    && (await textOf(A, fD.id, 's0/p1/n3')) === '김민준, 이서연, 박지호' && (await textOf(A, fD.id, 's0/p1/n6')) === '  ㅇ 2차 설문 자료 검토\n  ㅇ 새로 친 줄을 계속 칩니다',
  'B 가 같은 표의 다른 칸·같은 칸 앞부분을 고침(옛 기준) → A 의 줄바꿈 글과 함께 3-way 로 합침(겹침 없음)');
  // Enter 두 번(빈 줄) · 가운데 Enter — 지금 기준에서
  const fW3 = await working(A, fD.id);
  const fA3 = await headFrom(fW3.doc, fW3.version, (d) => setCellParas(d, ['s0/p1/n5'], ['□ 회의', '', ' 목적']));
  const fr3 = await push(A, fD.id, fA3);
  ok(fr3.status === 200 && eq(fr3.data.applied.changed, ['s0/p1/n5']) && (await textOf(A, fD.id, 's0/p1/n5')) === '□ 회의\n\n 목적' && fr3.data.unsupported === 0,
    'Enter 두 번(가운데 빈 줄) → 「□ 회의⏎⏎ 목적」');
  // Backspace(칸 문단 합치기): 합친 글은 앞 문단에, 뒤 문단은 비움(문단은 남음 — 표 구조는 반영하지 않으므로)
  const fW4 = await working(A, fD.id);
  const n5 = await textOf(A, fD.id, 's0/p1/n5'); const n6 = await textOf(A, fD.id, 's0/p1/n6');
  const fA4 = await headFrom(fW4.doc, fW4.version, (d) => setCellParas(d, ['s0/p1/n5', 's0/p1/n6'], [`${n5}${n6}`]));
  const fr4 = await push(A, fD.id, fA4);
  ok(fr4.status === 200 && eq(fr4.data.applied.changed, ['s0/p1/n5', 's0/p1/n6']) && eq((await cellsOf(A, fD.id, 2, 1)).map((p) => p.text), [`${n5}${n6}`, ''])
    && (await parasOf(A, fD.id)).filter((p) => p.parent).length === nNested,
  'Backspace 로 칸 문단 합침 → 앞 문단에 합친 글, 뒤 문단은 빈 문단(칸 문단 수 그대로)');
  // 맞춘 편집기(공유 문서 그대로)의 다음 밀어 넣기는 깨끗(구조 같음)
  const fW5 = await working(A, fD.id);
  const fr5 = await push(A, fD.id, await headFrom(fW5.doc, fW5.version, (d) => replaceIn(d, 's0/p1/n1', '11:00', '11:30')));
  ok(fr5.status === 200 && fr5.data.clean === true && eq(fr5.data.applied.changed, ['s0/p1/n1']), '공유 문서로 다시 연 편집기(줄바꿈 글 그대로)의 다음 밀어 넣기 → clean(줄바꿈은 편집기·엔진이 같은 "\\n")');
  // 표 격자 변경(행 추가): 골격이 바뀐 표는 편집기 것으로 통째 바꾼다(표 줄·칸 반영, 2026-10-28) — 함께 친 칸 글도 들어간다
  const fW6 = await working(A, fD.id);
  const fA6 = await headFrom(fW6.doc, fW6.version, (d) => {
    d.removeBodyParagraph(0, 1);
    d.insertTableAfter(0, 0, { rows: [['회의일시', '바꾼 일시'], ['참석', '바꾼 사람'], ['내용', '바꾼 내용'], ['비고', '']] }, ED);
  });
  const fr6 = await push(A, fD.id, fA6);
  const fCells6 = (await parasOf(A, fD.id)).filter((p) => p.ref.startsWith('s0/p1/')).map((p) => p.text);
  ok(fr6.status === 200 && fr6.data.unsupported === 0 && eq(fr6.data.applied.changed, ['s0/p1'])
    && eq(fCells6, ['회의일시', '바꾼 일시', '참석', '바꾼 사람', '내용', '바꾼 내용', '비고', '']),
    `표 행 추가(격자 변경) → 표를 편집기 것으로 통째 바꿈(4줄, 칸 글 포함 — unsupported ${fr6.data.unsupported}): ${JSON.stringify(fCells6)}`);
  // 변경 추적으로(track tracked): 접은 글도 친 사람의 변경 추적 — 줄바꿈 글 그대로
  const fT = await uploadDoc(srv.base, TA, await buildFormDoc(), '회의록 서식(변경 추적).hwpx');
  await A(`/api/docs/${fT.id}/settings`, { method: 'PATCH', body: { track: 'tracked' } });
  const fTr = await push(A, fT.id, await makeHead(A, fT.id, (d) => setCellParas(d, ['s0/p1/n6'], [FORM_CELL[1], '  ㅇ 변경 추적 줄'])));
  const fTch = await A(`/api/docs/${fT.id}/changes`);
  ok(fTr.status === 200 && eq(fTr.data.applied.changed, ['s0/p1/n6']) && fTch.length === 1 && fTch[0].ref === 's0/p1/n6' && fTch[0].author === nameA && fTch[0].type === 'Insert'
    && fTch[0].text === '\n  ㅇ 변경 추적 줄' && (await textOf(A, fT.id, 's0/p1/n6')) === `${FORM_CELL[1]}\n  ㅇ 변경 추적 줄`,
  `변경 추적으로: 접은 글은 친 사람의 삽입 하나(글 「${fTch[0]?.text.replace(/\n/g, '⏎')}」)`);
  // 실시간 문서의 변경 요청(승인 없이 반영)도 같은 덩어리 — 칸 안 Enter 한 수정본
  const fC = await uploadDoc(srv.base, TA, await buildFormDoc(), '회의록 서식(변경 요청).hwpx');
  const fCh = await makeHead(B, fC.id, (d) => setCellParas(d, ['s0/p1/n5'], ['□ 회의', ' 목적']));
  const fCr = (await B(`/api/docs/${fC.id}/drafts/mine?base=${fCh.version}`, { method: 'PUT', body: fCh.bytes })).cr;
  const fCv = await B(`/api/docs/${fC.id}/change-requests/${fCr.cid}`);
  const fCm = await B(`/api/docs/${fC.id}/change-requests/${fCr.cid}/merge`, { method: 'POST' });
  ok(fCv.hunks.length === 1 && fCv.hunks[0].ref === 's0/p1/n5' && fCv.hunks[0].newText === '□ 회의\n 목적' && eq(fCv.unsupported, []) && fCm.cr.status === 'merged'
    && eq(fCm.report.cells, ['s0/p1/n5']) && (await textOf(A, fC.id, 's0/p1/n5')) === '□ 회의\n 목적',
  `실시간 문서의 변경 요청: 칸 안 Enter 한 수정본 → 접은 덩어리 하나(반영 안 되는 변경 없음) → 반영(cells ${JSON.stringify(fCm.report.cells)})`);

  // ───────── 진짜 설정·자료 ─────────
  section('진짜 config.json·data/ 그대로');
  ok(stamp(realCfg) === before.cfg, `config.json 시각·크기 그대로(${before.cfg})`);
  ok(dataListing() === before.data, 'data/docs 목록·meta.json 시각 그대로');
  console.log(`\nAPI LIVE OK — ${passed}개 확인`);
} catch (e) {
  console.error('\nAPI LIVE FAILED:', e.stack || e.message);
  for (const s of servers) if (s.output) console.error(`--- 서버 ${s.base} 출력(끝) ---\n${s.output().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  for (const w of sockets) { try { w.close(); } catch { /* ignore */ } }
  for (const s of servers) await s.stop().catch(() => {});
}
