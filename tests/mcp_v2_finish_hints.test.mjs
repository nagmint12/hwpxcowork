// 새 연결의 작은 고침(2026-11-17 작업 Q — artifacts/mcp-round3-20261117/codex/REPORT-G3.md 문제 1·3·4, Z01 의 빈 dry_run, 문제 2). 모델을 부르지 않는다.
//  · finish: 결과 있음 + summary + error → 완료(요약 끝 '못 한 것: …') / 결과 없음 + summary + error → 실패 / error 만 → 실패
//  · delete_paragraphs·move_paragraphs: 범위 앞뒤가 모두 빈 줄이면 dry_run·저장 영수증 notes 에 한 줄(정상 대조군: 한쪽만 빈 줄이면 없음)
//  · edit 빈 ops: dry_run 이면 pages 만, 아니면 오류 · 도구 입력 스키마가 빈 배열을 받는다
//  · paper op 의 orientation 꼴(받는 값이 짧은 꼴에 있다)
//  · pages.sparse: 쪽 나눔으로 생긴 거의 빈 쪽(마지막 쪽 아님)을 쪽 번호·찬 비율로
//   node --test tests/mcp_v2_finish_hints.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { parseOps, OPS_BRIEF } from '../server/mcp2/ops.js';
import { registerV2Tools } from '../server/mcp2.js';
import { layoutChecker } from '../server/layout-check.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const BLANK = path.join(root, 'server', 'templates', 'blank.hwpx');
const user = { name: '시험 사용자', role: 'admin', agentSession: 'sess-1' };
const AGENT = 'claude-code';

function setup(t, { file = REPORT, pages = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-v2-hints-'));
  t.after(() => { assert.equal(path.dirname(tmp), os.tmpdir()); fs.rmSync(tmp, { recursive: true, force: true }); });
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, agents: { leaseMinutes: 10 }, ...(pages ? {} : { verify: { pages: false } }) };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, hub: { broadcast() {}, broadcastAll() {} }, config, ai: { enabled: false } });
  const docId = store.create({ fileName: path.basename(file), bytes: fs.readFileSync(file), by: user.name }).id;
  return { store, service, docId };
}
async function request(service, docId) {
  const r = (await service.createRequest(docId, { kind: 'instruct', instruction: '줄여 줘', target: { scope: 'document', ref: 's0/p0' }, route: 'queue' }, user)).request;
  await service.agentTake(user, AGENT, 'sess-1', { docId, rid: r.rid });
  return r.rid;
}
const reqOf = (store, docId, rid) => store.readMeta(docId).requests.find((r) => r.rid === rid);

test('finish: 결과가 있으면 summary+error 도 완료(요약 끝 「못 한 것」), 결과가 없거나 error 만이면 실패', { timeout: 120000 }, async (t) => {
  const { store, service, docId } = setup(t);
  // (1) 결과 있음 + summary + error → 완료
  const rid = await request(service, docId);
  const saved = await service.agentEdit(docId, { rid, ops: [{ op: 'memo', at: 's1/p1', text: '분량 의견' }] }, user, AGENT);
  assert.ok(!saved.failed, JSON.stringify(saved));
  const fin = await service.agentFinish(docId, rid, { summary: '본문을 줄여 10쪽을 9쪽으로 만들었습니다.', error: '6쪽 목표 미달 — 쪽 나눔을 지키면 7쪽이 최소' }, user, AGENT);
  assert.equal(fin.status, 'done'); assert.equal(fin.completed, true); assert.match(fin.note, /완료로 닫았습니다/);
  const r1 = reqOf(store, docId, rid);
  assert.equal(r1.status, 'done'); assert.equal(r1.error, null);
  assert.equal(r1.summary, '본문을 줄여 10쪽을 9쪽으로 만들었습니다. 못 한 것: 6쪽 목표 미달 — 쪽 나눔을 지키면 7쪽이 최소');
  // 긴 요약도 finish 의 summary 한도(2,000자) 안 — 못 한 것은 그대로 남는다
  const rid2 = await request(service, docId);
  await service.agentEdit(docId, { rid: rid2, ops: [{ op: 'memo', at: 's1/p2', text: '의견 둘' }] }, user, AGENT);
  const long = await service.agentFinish(docId, rid2, { summary: '가'.repeat(2000), error: '나'.repeat(500) }, user, AGENT);
  const s2 = reqOf(store, docId, rid2).summary;
  assert.equal(long.status, 'done'); assert.ok([...s2].length <= 2000, `${[...s2].length}자`); assert.ok(s2.endsWith(`못 한 것: ${'나'.repeat(500)}`));
  // (2) 결과 없음 + summary + error → 실패(예전 그대로)
  const rid3 = await request(service, docId);
  const none = await service.agentFinish(docId, rid3, { summary: '살펴보았습니다.', error: '목표를 맞출 방법이 없음' }, user, AGENT);
  assert.equal(none.status, 'failed'); assert.equal(none.completed, false); assert.ok(!none.note);
  assert.equal(reqOf(store, docId, rid3).error, '목표를 맞출 방법이 없음');
  // (3) summary 없이 error 만 → 결과가 있어도 실패(예전 그대로)
  const rid4 = await request(service, docId);
  await service.agentEdit(docId, { rid: rid4, ops: [{ op: 'memo', at: 's1/p3', text: '의견 셋' }] }, user, AGENT);
  const only = await service.agentFinish(docId, rid4, { error: '처리하지 못함' }, user, AGENT);
  assert.equal(only.status, 'failed'); assert.equal(reqOf(store, docId, rid4).status, 'failed');
});

test('delete_paragraphs·move_paragraphs: 범위 앞뒤가 모두 빈 줄이면 dry_run·영수증 notes 에 알림(더 지우지는 않는다)', { timeout: 120000 }, async (t) => {
  const { service, docId } = setup(t);
  const rid = await request(service, docId);
  // 연습 보고서 s1: p36(빈 줄) · p37(그림) · p38(빈 줄) — Z01 이 그림 문단만 지운 자리와 같은 꼴
  const dry = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'delete_paragraphs', at: 's1/p37' }] }, user, AGENT);
  assert.ok(!dry.failed, JSON.stringify(dry));
  assert.equal(dry.notes?.length, 1, JSON.stringify(dry));
  assert.match(dry.notes[0].note, /빈 줄 둘이 이어진다 — 하나만 남기려면 뒤 빈 줄 s1\/p38 을 범위에 넣는다/);
  // 정상 대조군: 빈 줄 p36 을 지우면 앞(p35 표)·뒤(p37 그림)가 빈 줄이 아니다 → 알림 없음. 범위에 뒤 빈 줄까지 넣어도 없음
  for (const at of ['s1/p36', 's1/p37..p38']) {
    const ok = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'delete_paragraphs', at }] }, user, AGENT);
    assert.ok(!ok.failed && !ok.notes, `${at}: ${JSON.stringify(ok.notes)}`);
  }
  // 옮기기: 원래 자리 앞뒤가 빈 줄
  const mv = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'move_paragraphs', at: 's1/p37', after: 's1/p53' }] }, user, AGENT);
  assert.equal(mv.notes?.length, 1, JSON.stringify(mv)); assert.match(mv.notes[0].note, /move_paragraphs: 옮긴 원래 자리 앞뒤/);
  // 저장 영수증에도 같은 알림 — 제안은 지시한 범위 그대로(빈 줄을 더 지우지 않는다)
  const real = await service.agentEdit(docId, { rid, ops: [{ op: 'delete_paragraphs', at: 's1/p37' }] }, user, AGENT);
  assert.ok(!real.failed, JSON.stringify(real));
  assert.equal(real.notes?.length, 1); assert.match(real.notes[0].note, /빈 줄 둘이 이어진다/);
  const p = (await service.listProposals(docId)).find((x) => x.rid === rid && x.type === 'para_delete');
  assert.equal(p.ref, 's1/p37'); assert.equal(p.paras.count, 1);
});

test('paper op 의 orientation: 받는 값이 짧은 꼴에 있다', () => {
  assert.match(OPS_BRIEF, /orientation\?:'portrait'\|'landscape'/);
  assert.equal(parseOps([{ op: 'paper', section: 0, orientation: 'landscape' }]).errors.length, 0);
  const bad = parseOps([{ op: 'paper', section: 0, orientation: 'PORTRAIT' }]).errors;
  assert.equal(bad.length, 1); assert.match(bad[0].error, /orientation\?:'portrait'\|'landscape'/);
});

test('edit 빈 ops: 도구 스키마는 빈 배열을 받고, dry_run 이면 쪽 수만 · 아니면 오류', { timeout: 120000 }, async (t) => {
  // 도구 입력 스키마(server/mcp2.js) — 빈 배열을 막지 않는다
  const reg = {};
  registerV2Tools({ register: (name, def, fn) => { reg[name] = def; }, service: {}, user, wrap: (f) => f, text: (v) => v, actor: () => user, agent: () => AGENT, sessionId: () => 'sess-1' });
  assert.ok(z.object(reg.edit.inputSchema).safeParse({ doc_id: 'd', ops: [], dry_run: true }).success);
  const { service, docId } = setup(t, { file: BLANK, pages: true });
  const rid = await request(service, docId);
  await service.agentEdit(docId, { rid, ops: [{ op: 'insert', after: 's0/p0', paragraphs: Array.from({ length: 40 }, (_, i) => ({ text: `${i + 1}번째 문단. `.repeat(30) })) }] }, user, AGENT);
  const dry = await service.agentEdit(docId, { rid, dryRun: true, ops: [] }, user, AGENT);
  assert.equal(dry.dry_run, true); assert.ok(!dry.failed, JSON.stringify(dry));
  assert.equal(dry.pages.now, 1, JSON.stringify(dry.pages)); assert.ok(dry.pages.all_applied > 1, JSON.stringify(dry.pages));
  const real = await service.agentEdit(docId, { rid, ops: [] }, user, AGENT);
  assert.deepEqual(real.saved, []); assert.match(real.failed[0].error, /쪽 수만 보려면 dry_run:true/);
  await layoutChecker().drain();
});

test('pages.sparse: 쪽 나눔으로 몇 줄만 남은 쪽(마지막 쪽 아님)을 쪽 번호·찬 비율로 알린다', { timeout: 120000 }, async (t) => {
  const { service, docId } = setup(t, { file: BLANK, pages: true });
  const rid = await request(service, docId);
  const long = (n) => Array.from({ length: n }, (_, i) => ({ text: `${i + 1}번째 문단. 쪽을 채우는 시험 글입니다. `.repeat(8) }));
  const brk = { paragraph: { pageBreakBefore: true } };
  // 1쪽: 긴 문단 · 2쪽: 짧은 한 줄(뒤 문단이 새 쪽에서 시작) · 3쪽: 긴 문단
  const ops = [{ op: 'insert', after: 's0/p0', paragraphs: [...long(8), { text: '짧은 끝 줄', format: brk }, { text: '새 장 제목', format: brk }, ...long(8)] }];
  const dry = await service.agentEdit(docId, { rid, dryRun: true, ops }, user, AGENT);
  assert.ok(!dry.failed, JSON.stringify(dry));
  const pg = dry.pages;
  assert.ok(pg.all_applied >= 3, JSON.stringify(pg));
  assert.ok(Array.isArray(pg.sparse) && pg.sparse.length >= 1, JSON.stringify(pg));
  const short = pg.sparse.find((x) => x.page === 2);
  assert.ok(short && short.fill < 0.15, JSON.stringify(pg.sparse));
  assert.ok(pg.sparse.every((x) => x.page < pg.all_applied && Object.keys(x).join() === 'page,fill'), '마지막 쪽은 빼고 쪽 번호·비율만');
  assert.match(pg.note, /2쪽이 거의 비었다/);
  // 정상 대조군: 쪽 나눔 없이 같은 글 → 거의 빈 쪽 없음
  const plain = await service.agentEdit(docId, { rid, dryRun: true, ops: [{ op: 'insert', after: 's0/p0', paragraphs: [...long(8), { text: '짧은 끝 줄' }, { text: '새 장 제목' }, ...long(8)] }] }, user, AGENT);
  assert.ok(!plain.pages.sparse, JSON.stringify(plain.pages));
  await layoutChecker().drain();
});
