// 글 범위 반영 검사(2026-11-20 — docs/MCP_REDESIGN_2026-11-16.md §19, server/mcp2/apply-check.js).
// 11-20 실제 Codex 실행(65쪽 보고서 오탈자 고치기)에서 replace_all 의 일치가 같은 호출 replace 범위 안에 들어 [모두 반영]에서 STALE 로 실패할 제안 11건이 생겼는데,
// 사본 반영 흉내는 시간 한도(6초)로 멈춰 apply_failed 가 비어 보였고 dry_run 응답은 '반영해 보았습니다'라고 했다. 모델이 dry_run 을 거듭해 찾느라 호출 13번을 썼다.
//  · 판정 규칙이 실제 반영(server/service.js _orderedApplier)과 같은가 — 겹치지 않는다고 본 바꿈은 [모두 반영]에서 모두 반영된다
//  · replace_all 의 일치가 같은 호출 replace 범위 안 → 그 replace 의 with 에 합침(따로 제안 안 함), 경계에 걸침·replace 끼리 겹침 → 저장 안 함
//  · 앞선 호출의 대기 제안과 겹치는 바꿈 → 저장 안 함(withdraw 와 함께 내면 된다), 앞선 대기 제안끼리 겹침 → apply_failed·완료 막기
//  · 영수증 맨 위 apply_check — 바꿈만이면 글 범위로 끝까지, 다른 종류가 섞이고 흉내가 멈추면 '끝까지 못 함'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { parseOps, prepareOps } from '../server/mcp2/ops.js';
import { laterFails, rangeConflicts, foldReplaceAll, replaceRange } from '../server/mcp2/apply-check.js';
import { codexExecArgs, codexMcpPromptV2, codexToolOutputTokens, CODEX_V3_TOOL_OUTPUT_TOKENS } from '../server/codex-ai.js';
import { taskEditorInstructions, V3_EDIT_NOTE } from '../server/editor-instructions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const AGENT = 'claude-code';
// 연습 보고서 s1/p5: '재수강' 3번
const P = 's1/p5';
// 새 검사는 v3(실험 연결)에서만 — v2 기본 연결의 계약은 그대로(아래 'v2 는 그대로' 시험)
const V3 = { textRanges: true };

function setup(t, verify = { pages: false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-apply-check-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, verify };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: 'report.hwpx', bytes: fs.readFileSync(REPORT), by: user.name }).id;
  return { store, service, docId };
}
async function request(service, docId) {
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction: '오탈자를 고쳐 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: r.rid });
  return r.rid;
}
const mine = async (service, docId, rid) => (await service.listProposals(docId)).filter((p) => p.rid === rid);

test('규칙: 뒤 제안이 앞 제안 범위와 겹치면 실패 — 실제 반영(_orderedApplier)의 판정과 같다', () => {
  const r = (start, end) => ({ ref: 'x', start, end });
  assert.equal(laterFails(r(5, 10), r(0, 5)), false, '앞에 닿기만');
  assert.equal(laterFails(r(5, 10), r(10, 12)), false, '뒤에 닿기만');
  assert.equal(laterFails(r(5, 10), r(9, 12)), true, '겹침');
  assert.equal(laterFails(r(5, 10), r(6, 8)), true, '안');
  assert.equal(laterFails(r(5, 10), r(5, 5)), true, '같은 시작의 빈 범위(넣기)는 실패 — _orderedApplier 의 예외');
  assert.equal(laterFails(r(5, 5), r(5, 9)), false, '빈 범위 뒤에서 시작');
  assert.equal(laterFails(r(20, 20), r(20, 20)), false, '문단 끝 넣기 둘');
  const c = rangeConflicts([r(0, 4), { ...r(2, 6), ref: 'y' }, r(3, 5)]);
  assert.equal(c.length, 1); assert.equal(c[0].later.start, 3);
  // 사슬(2026-11-20 검증 에이전트 지적): 실패할 b 는 반영되지 않으므로 c 는 a 하고만 견준다 — a 뒤라 남는다
  const chain = rangeConflicts([r(0, 5), r(3, 8), r(6, 9)]);
  assert.deepEqual(chain.map((x) => [x.first.start, x.later.start]), [[0, 3]]);
});

test('사슬 겹침: 글 범위 검사가 실패로 센 것 = 실제 [모두 반영]에서 실패한 것', { timeout: 120000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const tx = doc.text(P, 'final');
  // 문단 안 처음 나오는 자리가 그 자리인 조각만 쓴다(occurrence 1)
  const piece = (a, b) => { const s = tx.slice(a, b); assert.equal(tx.indexOf(s), a, `조각 「${s}」 가 앞에도 있다`); return s; };
  const [a, b, c] = [piece(10, 20), piece(15, 25), piece(22, 30)];   // a[10,20] · b[15,25] · c[22,30]
  for (const [find, replace] of [[a, 'A'], [b, 'B'], [c, 'C']]) await service.propose(docId, { type: 'replace', ref: P, find, replace, rid }, user, AGENT);
  const peek = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [] }, user, AGENT);
  assert.match(peek.apply_check, /^실패 — \[모두 반영\]에서 실패할 제안 1건/, peek.apply_check);
  const pend = await mine(service, docId, rid);
  assert.equal(peek.apply_failed.length, 1); assert.equal(peek.apply_failed[0].pid, pend[1].pid, 'b 만 실패');
  const res = await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  const after = await mine(service, docId, rid);
  assert.deepEqual(after.map((p) => p.status), ['applied', 'pending', 'applied'], `실제 반영: ${JSON.stringify(res.counts || res)}`);
});

test('replace_all 접어 넣기: with 글에도 같은 바꿈 — 낱말 단위·대소문자·이미 바꾼 글은 두 번 붙이지 않음', () => {
  assert.equal(foldReplaceAll('입학년도별 관측(입학년도)', { find: '입학년도', with: '입학 연도' }), '입학 연도별 관측(입학 연도)');
  assert.equal(foldReplaceAll('AI와 AI(인공지능)', { find: 'AI', with: 'AI(인공지능)' }), 'AI(인공지능)와 AI(인공지능)');
  assert.equal(foldReplaceAll('재수강·재수강생', { find: '재수강', with: '재이수', word: true }), '재이수·재수강생');
  assert.equal(foldReplaceAll('Gpa gpa GPA', { find: 'gpa', with: 'GPA', ignore_case: true }), 'GPA GPA GPA');
});

test('prepareOps: 같은 호출의 replace 범위 안 일치는 합치고, 경계에 걸침·replace 끼리 겹침은 오류', async () => {
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const t = doc.text(P, 'final');
  const i = t.indexOf('재수강');
  const span = t.slice(i - 3, i + 10);   // 첫 '재수강'을 품은 글
  // ① 합치기
  const ops = [{ op: 'replace', at: P, find: span, with: `${span}!` }, { op: 'replace_all', find: '재수강', with: '재이수' }];
  const prep = prepareOps(doc, parseOps(ops).ok, V3);
  assert.deepEqual(prep.errors, []);
  const items = prep.steps.filter((s) => s.kind === 'proposals').flatMap((s) => s.items);
  const host = items.find((x) => x.index === 0);
  assert.ok(host.input.replace.includes('재이수') && !host.input.replace.includes('재수강'), host.input.replace);
  // 그 문단의 나머지 일치(2곳)는 따로 제안, 범위 안 1곳은 빠짐
  assert.equal(items.filter((x) => x.index === 1 && x.input.ref === P).length, 2);
  assert.equal(prep.summaries[0].merged, 1);
  assert.match(prep.notes.find((n) => n.op === 1).note, /일치 1곳은 같은 호출 ops\[0\] replace/);
  // 남은 제안끼리는 겹치지 않는다
  const entries = items.filter((x) => x.input.type === 'replace').map((x) => ({ x, ref: x.input.ref, ...replaceRange(doc, x.input) }));
  assert.equal(rangeConflicts(entries).length, 0);
  // ② 경계에 걸침: find 가 '재수강'의 가운데에서 끝난다
  const cut = prepareOps(doc, parseOps([{ op: 'replace', at: P, find: t.slice(i - 3, i + 1), with: 'x' }, { op: 'replace_all', find: '재수강', with: '재이수' }]).ok, V3);
  assert.match(cut.errors[0]?.error || '', /ops\[1\] replace_all 의 일치.*ops\[0\] replace 가 고치는 글의 경계/);
  // ③ replace 끼리 겹침
  const both = prepareOps(doc, parseOps([{ op: 'replace', at: P, find: span, with: 'a' }, { op: 'replace', at: P, find: t.slice(i, i + 12), with: 'b' }]).ok, V3);
  assert.match(both.errors[0]?.error || '', /ops\[0\]·ops\[1\] replace 가 .* 함께 고칩니다/);
  // ④ 같은 문단의 떨어진 두 곳은 된다
  const j = t.indexOf('재수강', i + 3);
  const apart = prepareOps(doc, parseOps([{ op: 'replace', at: P, find: t.slice(i, i + 3), with: 'a' }, { op: 'replace', at: P, find: t.slice(j, j + 3), with: 'b', occurrence: 2 }]).ok, V3);
  assert.deepEqual(apart.errors, []);
});

test('합친 저장은 [모두 반영]에서 모두 반영되고, 앞선 대기 제안과 겹치는 바꿈은 저장하지 않는다(withdraw 와 함께면 된다)', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId);
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const tx = doc.text(P, 'final'); const i = tx.indexOf('재수강'); const span = tx.slice(i - 3, i + 10);
  // 합치는 저장 — 영수증: apply_check 통과, notes, merged
  const first = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'replace', at: P, find: span, with: `${span}!` }, { op: 'replace_all', find: '재수강', with: '재이수', at: P }] }, user, AGENT);
  assert.ok(!first.failed, JSON.stringify(first.failed));
  assert.match(first.apply_check, /^통과 — 이 요청의 바꿈 제안 3건을 글 범위로/);
  assert.ok(first.notes?.some((n) => /replace_all: 일치 1곳/.test(n.note)));
  const pend = await mine(service, docId, rid);
  assert.equal(pend.length, 3);
  // 앞선 대기 제안(#첫 제안)과 겹치는 바꿈 → 저장 안 함, withdraw 를 알려 준다
  const hostPid = first.saved[0].pid;
  const clash = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'replace', at: P, find: tx.slice(i, i + 12), with: '바뀜' }] }, user, AGENT);
  assert.equal(clash.saved.length, 0);
  assert.match(clash.failed[0].error, new RegExp(`대기 제안 #${hostPid} 와 같은 글을 고칩니다.*withdraw\\(pids:\\[${hostPid}\\]\\)`));
  assert.equal((await mine(service, docId, rid)).filter((p) => p.status === 'pending').length, 3);
  // dry_run 도 같은 것을 failed 로 알린다
  const dry = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'replace', at: P, find: tx.slice(i, i + 12), with: '바뀜' }] }, user, AGENT);
  assert.match(dry.failed?.[0]?.error || '', /같은 글을 고칩니다/);
  // withdraw 와 함께 내면 저장된다
  const fixed = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'withdraw', pids: [hostPid] }, { op: 'replace', at: P, find: span, with: `${span}?` }] }, user, AGENT);
  assert.ok(!fixed.failed, JSON.stringify(fixed.failed));
  // [모두 반영] — 글 범위 검사가 겹치지 않는다고 본 것은 실제로 모두 반영된다
  const res = await service.resolveRequest(docId, rid, { apply: 'rest' }, user);
  assert.ok(res);
  const after = await mine(service, docId, rid);
  const st = {}; for (const p of after) st[p.status] = (st[p.status] || 0) + 1;
  assert.equal(st.applied, 3, JSON.stringify(st));
  assert.ok(!after.some((p) => p.status === 'pending' || p.autoApplyError), JSON.stringify(after.map((p) => [p.pid, p.status])));
});

test('앞선 대기 제안끼리 겹침 → apply_failed·완료 막기, 다른 종류가 섞이고 흉내가 없으면 apply_check 가 그렇게 말한다', { timeout: 120000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const tx = doc.text(P, 'final'); const i = tx.indexOf('재수강');
  // 예전 서버가 저장했을 꼴 — 겹치는 바꿈 둘(서비스로 직접)
  const a = await service.propose(docId, { type: 'replace', ref: P, find: tx.slice(i - 3, i + 10), replace: 'A', rid }, user, AGENT);
  const b = await service.propose(docId, { type: 'replace', ref: P, find: tx.slice(i, i + 3), replace: 'B', rid }, user, AGENT);
  const peek = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [] }, user, AGENT);
  assert.match(peek.apply_check, /^실패 — \[모두 반영\]에서 실패할 제안 1건/);
  assert.equal(peek.apply_failed[0].pid, b.pid);
  assert.match(peek.apply_failed[0].error, new RegExp(`#${a.pid}`));
  // done 은 완료하지 않는다(메모는 저장된다)
  const done = await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'memo', at: 's1/p6', text: '확인 필요' }], done: '끝' }, user, AGENT);
  assert.equal(done.completed, false); assert.match(done.complete_note, /완료하지 않았습니다/);
  // 거두면 통과
  await service.agentEdit(docId, { surface: 'v3', rid, ops: [{ op: 'withdraw', pids: [b.pid] }] }, user, AGENT);
  const ok = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [] }, user, AGENT);
  assert.match(ok.apply_check, /^통과/);
  // 넣기(바꿈 아님)가 섞이고 쪽 수 어림이 꺼져 있으면 — 끝까지 검사했다고 하지 않는다
  const mixed = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'insert', after: 's1/p6', text: '새 문단' }] }, user, AGENT);
  assert.match(mixed.apply_check, /^하지 않음/);
});

test('사본 반영 흉내가 시간 한도로 멈추면: dry_run 은 반영해 보았다고 하지 않고 apply_check 가 끝까지 못 했다고 한다', { timeout: 180000 }, async (t) => {
  // 한도 1ms — 흉내는 바로 멈춘다(쪽 수 어림은 켜 둠: 지금 쪽 수는 조판 작업자가 잰다)
  const { service, docId } = setup(t, { pages: { budgetMs: 1, checkBudgetMs: 1 } });
  const rid = await request(service, docId);
  const mixed = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'insert', after: 's1/p6', text: '새 문단' }, { op: 'replace', at: 's1/p6', find: '꾸준이', with: '꾸준히' }] }, user, AGENT);
  assert.match(mixed.pages?.stopped || '', /시간 한도/);
  assert.match(mixed.note, /멈췄습니다/);
  assert.doesNotMatch(mixed.note, /반영해 보았습니다/);
  assert.match(mixed.apply_check, /^끝까지 못 함/);
  // 바꿈만이면 흉내가 멈춰도 반영 충돌은 글 범위로 끝까지 — 통과
  const text = await service.agentEdit(docId, { surface: 'v3', rid, dryRun: true, ops: [{ op: 'replace', at: 's1/p6', find: '꾸준이', with: '꾸준히' }] }, user, AGENT);
  assert.match(text.apply_check, /^통과 — 이 요청의 바꿈 제안 1건을 글 범위로/);
});

test('v2(기본 연결)는 그대로 — 합치기·저장 거절·apply_check 없음, 안내 글도 v3 에만', { timeout: 120000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  const doc = await HwpxDoc.load(fs.readFileSync(REPORT));
  const tx = doc.text(P, 'final'); const i = tx.indexOf('재수강'); const span = tx.slice(i - 3, i + 10);
  // prepareOps 기본(textRanges 없음): 합치지 않는다
  const prep = prepareOps(doc, parseOps([{ op: 'replace', at: P, find: span, with: 'x' }, { op: 'replace_all', find: '재수강', with: '재이수', at: P }]).ok);
  assert.equal(prep.steps.flatMap((s) => s.items || []).length, 4); assert.equal(prep.notes.length, 0);
  // v2 저장: 겹치는 둘도 저장된다(예전 계약 — 완료 막기가 잡는다), apply_check 칸 없음
  const out = await service.agentEdit(docId, { rid, ops: [{ op: 'replace', at: P, find: span, with: 'x' }, { op: 'replace', at: P, find: tx.slice(i, i + 12), with: 'y' }] }, user, AGENT);
  assert.ok(!out.failed, JSON.stringify(out)); assert.equal(out.apply_check, undefined);
  // 모델 안내: v3 지침에만 V3_EDIT_NOTE
  assert.ok(taskEditorInstructions('v3').includes(V3_EDIT_NOTE));
  assert.ok(!taskEditorInstructions('v2').includes(V3_EDIT_NOTE));
  assert.ok(!taskEditorInstructions('v2').includes('apply_check'));
});

test('하나씩 [반영]: replace_all 이 한 문단에 낸 occurrence 1·2·3 을 카드 차례로(또는 뒤부터) 반영해도 모두 반영된다', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  const rid = await request(service, docId);
  // 연습 보고서 s1/p5 의 '재수강' 3곳 — 연결과 상관없이(반영은 사람이 편집기에서) v2 로 낸다
  const saved = await service.agentEdit(docId, { rid, ops: [{ op: 'replace_all', find: '재수강', with: '재이수', at: P }] }, user, AGENT);
  assert.ok(!saved.failed, JSON.stringify(saved));
  const pend = (await mine(service, docId, rid)).filter((p) => p.ref === P);
  assert.deepEqual(pend.map((p) => p.occurrence), [1, 2, 3]);
  for (const p of pend) await service.applyProposal(docId, p.pid, user);   // 예전: 둘째부터 '찾지 못했습니다'
  const after = await mine(service, docId, rid);
  assert.ok(after.every((p) => p.status === 'applied'), JSON.stringify(after.map((p) => [p.pid, p.status])));
  const text = (await store.doc(docId)).text(P, 'final');
  assert.equal(text.split('재수강').length - 1, 0, text); assert.equal(text.split('재이수').length - 1, 3, text);
  // 가운데부터 반영해도(앞은 그대로·뒤는 옮김) — 다른 문단 s1/p6 의 '재수강' 2곳
  const rid2 = (await service.createRequest(docId, { kind: 'instruct', instruction: '고쳐', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request.rid;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: rid2 });
  const s2 = await service.agentEdit(docId, { rid: rid2, ops: [{ op: 'replace_all', find: '재수강', with: 'RR', at: 's1/p6' }] }, user, AGENT);
  assert.ok(!s2.failed, JSON.stringify(s2));
  const two = (await mine(service, docId, rid2)).filter((p) => p.ref === 's1/p6');
  assert.equal(two.length, 2);
  await service.applyProposal(docId, two[1].pid, user); await service.applyProposal(docId, two[0].pid, user);
  assert.ok((await mine(service, docId, rid2)).every((p) => p.status === 'applied'));
  // 문단을 실제로 나누는 바꿈 뒤의 하나씩 반영은 tests/split_chain.test.mjs 가 본다(꼬리 문단으로 옮김)
});

test('Codex v3 큰 읽기: tool_output_token_limit 와 첫 입력 안내는 v3 에만, 같은 값', () => {
  const base = { model: 'gpt-6.2-sol', effort: 'high', platform: 'win32', instructionsFile: 'x.txt' };
  const v3 = codexToolOutputTokens('v3', {}); const v2 = codexToolOutputTokens('v2', {});
  assert.equal(v3, CODEX_V3_TOOL_OUTPUT_TOKENS); assert.equal(v2, null);
  assert.ok(codexExecArgs({ ...base, toolOutputTokens: v3 }).includes(`tool_output_token_limit=${CODEX_V3_TOOL_OUTPUT_TOKENS}`));
  assert.ok(!codexExecArgs({ ...base, toolOutputTokens: v2 }).some((a) => /tool_output_token_limit/.test(a)));
  assert.ok(!codexExecArgs({ ...base, toolOutputTokens: v3, connectMcp: false }).some((a) => /tool_output_token_limit/.test(a)), '판단용 실행에는 넣지 않는다');
  assert.equal(codexToolOutputTokens('v3', { HWPX_COWORK_CODEX_TOOL_OUTPUT_TOKENS: '0' }), null, '0 = 끔');
  assert.equal(codexToolOutputTokens('v3', { HWPX_COWORK_CODEX_TOOL_OUTPUT_TOKENS: '60000' }), 60000);
  const job = { docId: 'd1', requestId: 1, attempt: 1 };
  const brief3 = { surface: 'v3', doc_id: 'd1', request_id: 1, attempt: 1, instruction: '고쳐', context: '<document_context>\n</document_context>' };
  const p3 = codexMcpPromptV2({ ...job, surface: 'v3' }, brief3, { toolOutputTokens: v3 });
  assert.match(p3, /max_chars:120000/); assert.match(p3, new RegExp(`"max_output_tokens": ${v3}`));
  const p2 = codexMcpPromptV2({ ...job, surface: 'v2' }, { doc_id: 'd1', request_id: 1, attempt: 1, instruction: '고쳐' }, { toolOutputTokens: v2 });
  assert.doesNotMatch(p2, /max_output_tokens|max_chars|yield_time_ms/);
  assert.match(p3, /yield_time_ms 를 짧게 주지 않습니다/);
  // 한도를 끈 v3 실행기는 큰 읽기를 안내하지 않는다(잘릴 테니)
  assert.doesNotMatch(codexMcpPromptV2({ ...job, surface: 'v3' }, brief3, { toolOutputTokens: null }), /max_output_tokens/);
});
