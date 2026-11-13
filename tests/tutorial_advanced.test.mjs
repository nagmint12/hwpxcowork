// node --test tests/tutorial_advanced.test.mjs — 튜토리얼 6(AI 활용 심화, docs/TUTORIAL_AI_ADVANCED_PLAN_2026-11-04.md §8):
// 2026-11-04 부터 5작업(S1~S5)을 늘 예시 답변으로 — 개인 키·채널·관리자 공유 키 모두 쓰지 않는다. 작업은 예전 단계(A1~C5)의
// 준비된 예시 답변(tutorial/ai-advanced-answers.json)을 '예시 답변' 실행기가 MCP 도구로 넣는다. API 는 가짜 fetch, 문서는 임시 사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { TutorialStore as Store } from '../server/tutorial-store.js';
import { createPersonalAi } from '../server/personal-ai.js';
import { createTutorial } from '../server/tutorial.js';
import { resolveAnchors, loadAnswers, answerFor, EXAMPLE_AGENT } from '../server/tutorial-advanced.js';
import { ADVANCED_TASKS } from '../web/tutorial-advanced-tasks.js';
import { HwpxDoc } from '../engine/doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRACTICE = path.join(ROOT, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const admin = { name: '관리자', role: 'admin' };
const learner = { name: 'test1', role: 'editor' };
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
const finalJson = (v) => json({ status: 'completed', model: 'test-api', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(v) }] }], usage: { input_tokens: 5, output_tokens: 5 } });
const empty = { proposals: [], alternatives: [], comments: [], inserts: [], formats: [], tables: [], summary: '내 키로 처리함', instructionSummary: '처리' };

function setup(t, { root = ROOT } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-adv-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { tutorialExampleDelayMs: 0, root, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: {}, agents: { othersCanTake: true }, tutorial: { users: [learner.name], shareFrom: [admin.name] } };
  const seen = []; let online = false; const deliveries = [];
  const personal = createPersonalAi({ config, fetchImpl: async (url, init) => { seen.push(new Headers(init.headers).get('authorization')); return finalJson(empty); } });
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  service.personalAi = personal;
  service.agents = { online: () => online, deliver(name, type) { deliveries.push({ name, type }); return { session: 'learner-session', agent: 'Claude Code' }; } };
  const doc = (user = learner) => store.create({ fileName: 'practice.hwpx', bytes: fs.readFileSync(PRACTICE), by: user.name, extra: { tutorialOwnAi: true, tutorialId: 'ai-advanced' } }).id;   // 임시 연습 문서(tutorialSession)면 토큰 주인 검사가 붙는다 — 경로 시험에는 일반 문서로
  return { tmp, config, service, store, personal, seen, deliveries, doc, setOnline(v) { online = v; } };
}

/** 단계의 대상(화면이 고르는 캡션·문단·문서 전체) → 요청 대상 */
async function targetOf(service, store, id, task) {
  if (task.target.doc) return { scope: 'document' };
  const d = await store.doc(id); const want = task.target.table || task.target.figure || task.target.para;
  const p = d.paragraphs({ view: 'final', nested: true }).find((x) => String(x.text).includes(want));
  const text = service._text(d, p.ref); const k = text.indexOf(want); const start = [...text.slice(0, k)].length;
  return { ref: p.ref, start, end: start + [...want].length, text: want, refs: [p.ref] };
}

test('연습 보고서·엑셀·정답·예시 답변이 있고, 5작업 모두 준비된 도구 호출이 있다', () => {
  assert.ok(fs.existsSync(PRACTICE));
  assert.ok(fs.existsSync(path.join(ROOT, 'tutorial', '재수강 경험자 설문 결과(가상).xlsx')));
  const key = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'tutorial-assets', 'ai-advanced-key.json'), 'utf8'));
  assert.equal(key.typos.length, 15); assert.equal(key.mismatches.length, 3); assert.equal(key.overclaims.length, 3);
  const answers = loadAnswers(ROOT);
  assert.equal(ADVANCED_TASKS.length, 5);
  for (const task of ADVANCED_TASKS) {
    for (const p of task.presets) assert.ok(answers.steps[p.step], `${task.id}: ${p.step} 예시 답변 없음`);
    const a = answerFor(ROOT, task.id); assert.ok(a?.calls.length, `${task.id} 호출 없음`);
  }
  assert.equal(answerFor(ROOT, 'S4').calls.filter((c) => c.name === 'add_memo').length, 4, 'S4 = C3 메모 1 + 심어 둔 과도한 해석 메모 3');
  for (const [step, a] of Object.entries(answers.steps)) {
    assert.ok(a.calls.length, `${step} 호출 없음`);
    assert.ok(a.calls.every((c) => !c.name.startsWith('#')), `${step} 에 넣을 수 없는 호출`);
  }
});

test('예시 답변의 자리표시는 연습 보고서에서 모두 찾아진다(앞 단계 그림을 반영해 문단이 밀려도)', async (t) => {
  const s = setup(t); const id = s.doc();
  const answers = loadAnswers(ROOT);
  const check = async (label) => {
    const d = await s.store.doc(id); const figures = await s.service.listFigures(id);
    for (const [step, a] of Object.entries(answers.steps)) for (const c of a.calls) {
      const items = c.name === 'propose_changes' ? c.args.proposals : [c.args];
      for (const item of items) assert.ok(resolveAnchors(d, figures, item), `${label}: ${step} ${c.name} ${JSON.stringify(item).slice(0, 120)}`);
    }
  };
  await check('처음');
  // S1(표 도식) 그림을 반영하면 뒤 문단 주소가 밀린다 — 자리표시는 글·캡션으로 다시 찾는다
  const r = await s.service.createRequest(id, { kind: 'instruct', target: await targetOf(s.service, s.store, id, ADVANCED_TASKS[0]), instruction: ADVANCED_TASKS[0].prompt, tutorialStep: 'S1' }, learner);
  for (const pid of r.request.proposals) await s.service.applyProposal(id, pid, learner);
  await check('S1 반영 뒤');
});

test('연결이 없으면 단계의 예시 답변 — 체험 계정이어도 관리자 공유 키를 쓰지 않는다', async (t) => {
  const s = setup(t); s.personal.save(admin, { provider: 'openai', model: 'test-api', key: 'sk-admin-shared-000000' });
  const id = s.doc();
  const info = s.service._summary(s.service._meta(id), learner);
  assert.equal(info.tutorialOwnAi, true); assert.ok(!info.tutorialApiOnly); assert.deepEqual(info.ownAi.agent, false);
  const task = ADVANCED_TASKS.find((x) => x.id === 'S4');
  const done = await s.service.createRequest(id, { kind: 'instruct', target: await targetOf(s.service, s.store, id, task), instruction: task.prompt, tutorialStep: 'S4' }, learner);
  assert.equal(done.route, 'example'); assert.equal(done.request.status, 'done');
  assert.equal(s.seen.length, 0, '관리자 공유 키로 부르지 않는다');
  const r = s.service._meta(id).requests[0];
  assert.equal(r.example, true); assert.equal(r.handledBy, EXAMPLE_AGENT); assert.equal(r.tutorialStep, 'S4');
  assert.ok(r.comments.length + r.proposals.length > 0, `예시 답변이 들어간다: ${JSON.stringify(r.log)} ${r.summary}`);
  // 단계가 없는 자유 요청은 맞는 예시가 없어 문서를 고치지 않고 안내로 끝난다(2026-11-12 — 예전에는 대기열에 남아 연습 완료를 막았다)
  const free = await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '아무 요청' }, learner);
  assert.deepEqual([free.route, free.request.status], ['example', 'done']);
  assert.match(s.service._meta(id).requests.at(-1).noChangesReason, /미리 준비한 예시/);
  // 다시 요청도 예시 답변으로
  const again = await s.service.retryRequest(id, r.rid, learner);
  assert.equal(again.route, 'example');
});

test('내 AI 키·채널이 있어도 튜토리얼 6은 늘 예시 답변 — 개인 AI 를 부르지 않는다', async (t) => {
  const s = setup(t); const id = s.doc();
  s.personal.save(learner, { provider: 'openai', model: 'test-api', key: 'sk-learner-own-000000' });
  s.setOnline(true);
  const task = ADVANCED_TASKS.find((x) => x.id === 'S3');
  for (const route of [undefined, 'server', 'agent', 'queue']) {
    const res = await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: task.prompt, tutorialStep: 'S3', ...(route ? { route } : {}) }, learner);
    assert.equal(res.route, 'example', `고른 길 ${route}`);
  }
  assert.deepEqual(s.seen, [], '개인 키로 부르지 않는다'); assert.deepEqual(s.deliveries, [], '채널로 보내지 않는다');
});

test('튜토리얼 메뉴: AI 활용 심화(AI 연결 뒤, 관리자 참고 문서는 끝) — 시작하면 본인 연결 문서(tutorial 표시 없음)에 설문 엑셀·예시 skill이 첨부된다', async (t) => {
  const s = setup(t);
  const tut = createTutorial({ service: s.service, config: s.config });
  const status = tut.status(learner);
  const item = status.items.find((x) => x.id === 'ai-advanced');
  assert.ok(item); assert.equal(item.number, status.items.findIndex((x) => x.id === 'ai-connect') + 2); assert.equal(status.items.at(-1).id, 'admin'); assert.ok(!('attachments' in item) && !('file' in item));
  const started = await tut.start(learner, { tutorialId: 'ai-advanced' });
  const meta = s.store.readMeta(started.docId);
  assert.equal(meta.tutorialOwnAi, true); assert.ok(!meta.tutorial); assert.equal(meta.tutorialId, 'ai-advanced');
  assert.deepEqual(meta.attachments.map((a) => a.name), ['재수강 경험자 설문 결과(가상).xlsx', '보고서 작성 규칙(예시).skill']);
  // 변경 추적은 끈 채 시작한다(2026-11-04 되돌림)
  assert.equal(meta.settings.track, 'final');
  const { default: JSZip } = await import('jszip');
  const header = await (await JSZip.loadAsync(s.store.currentBytes(started.docId))).file('Contents/header.xml').async('string');
  assert.deepEqual(header.match(/<hh:trackchageConfig[^>]*>/g), ['<hh:trackchageConfig flags="56"/>']);
  const d = await HwpxDoc.load(s.store.currentBytes(started.docId));
  assert.ok(d.paragraphs({ view: 'final' }).some((p) => p.text.includes('연습용 가상 자료')));
});

test('propose_insert paragraphs — 절 하나(제목·본문·단위 줄·빈 줄)를 한 번의 도구 호출로, 문단마다 스타일, 같은 자리 뒤에 pid 차례로', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../server/mcp.js');
  const s = setup(t); const id = s.doc(admin);
  const server = createMcpServer({ service: s.service, user: admin, agentName: 'Claude Code' });
  const client = new Client({ name: 'test', version: '1' }); const [x, y] = InMemoryTransport.createLinkedPair();
  await server.connect(y); await client.connect(x);
  t.after(async () => { await client.close(); await server.close(); });
  const after = s.service._meta(id) && (await s.store.doc(id)).paragraphs({ view: 'final' }).find((p) => p.text.startsWith('4) 학기 유형별')).ref;
  const r = await client.callTool({ name: 'propose_insert', arguments: { doc_id: id, after_ref: after, paragraphs: [
    { text: '5) 새 절', format: { styleId: '7' } }, { text: '(개요) 첫 문단임.', format: { styleId: '1' } }, { blank: true }, { text: '(단위: 명)', format: { styleId: '11' } }] } });
  assert.ok(!r.isError, r.content[0].text.slice(0, 200));
  const made = s.service._meta(id).proposals;
  assert.deepEqual(made.map((p) => [p.type, p.afterRef, p.text, !!p.blank]), [['insert', after, '5) 새 절', false], ['insert', after, '(개요) 첫 문단임.', false], ['insert', after, '', true], ['insert', after, '(단위: 명)', false]]);
});

test('예시 답변 5작업을 그대로 다시 내면 모든 도구 호출이 들어간다 — 새 문서, 그리고 앞 단계(그림·오탈자·절 쓰기)를 모두 반영한 문서', { timeout: 120000 }, async (t) => {
  for (const applied of [false, true]) {
    const s = setup(t); const id = s.doc(admin);
    for (const task of ADVANCED_TASKS) {
      await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: task.prompt, tutorialStep: task.id }, admin);
      const r = s.service._meta(id).requests.at(-1);
      assert.equal(r.status, 'done', `${task.id} ${r.error}`);
      assert.doesNotMatch(r.summary, /넣지 못했습니다/, `${applied ? '반영한 문서' : '새 문서'}: ${task.id} 의 예시 일부가 들어가지 않음`);
      if (applied && r.proposals.length) {
        const out = await s.service.resolveRequest(id, r.rid, { apply: 'rest' }, admin);
        assert.equal(out.counts.failed, 0, `${task.id}: ${JSON.stringify(out.results.filter(x => !x.ok))}`);
        assert.equal(out.counts.applied, r.proposals.length, `${task.id}: 모든 제안이 반영되어야 한다`);
      }
    }
  }
});

test('예시 답변 경로는 튜토리얼 6 문서에서만 — 다른 문서는 BAD_ROUTE', async (t) => {
  const s = setup(t);
  const id = s.store.create({ fileName: 'n.hwpx', bytes: fs.readFileSync(PRACTICE), by: admin.name }).id;
  await assert.rejects(s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: 'x', route: 'example' }, admin), { code: 'BAD_ROUTE' });
});

test('B1·B4: 같은 통계량은 두 자리와 끝자리 0, 비율은 한 자리 — 단독 실행과 순서대로 반영 모두 값 보존', { timeout: 60000 }, async t => {
  for (const steps of [['B4'], ['B1', 'B4']]) {
    const s = setup(t); const id = s.doc(admin);
    const before = (await s.store.doc(id)).tables().find(t => t.caption?.text.includes('원 등급별 재수강 평점변화'));
    for (const step of steps) {
      await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: `${step} 숫자 표기`, tutorialStep: step, route: 'example' }, admin);
      const r = s.service._meta(id).requests.at(-1);
      assert.equal(r.status, 'done'); assert.doesNotMatch(r.summary, /넣지 못했습니다/);
      if (step === 'B4') assert.equal(r.proposals.length, steps.length === 1 ? 30 : 22, '이미 반영한 B1 자릿수 수정은 중복 제안하지 않는다');
      const out = await s.service.resolveRequest(id, r.rid, { apply: 'rest' }, admin);
      assert.equal(out.counts.failed, 0);
    }
    const doc = await s.store.doc(id);
    const table = doc.tables().find(t => t.caption?.text.includes('원 등급별 재수강 평점변화'));
    for (const c of table.cells.filter(c => c.row > 0 && c.col >= 2)) {
      assert.match(c.text, /^\d+\.\d{2}$/, `row ${c.row}, col ${c.col}`);
      assert.equal(Number(c.text), Number(before.cells.find(b => b.row === c.row && b.col === c.col).text));
    }
    assert.equal(table.cells.find(c => c.row === 5 && c.col === 4).text, '0.70');
    assert.ok(doc.paragraphs({ view: 'final' }).some(p => p.text.includes('모든 등급에서 p < .001')));
    const college = doc.tables().find(t => t.caption?.text.includes('소속대학별 재수강 현황'));
    assert.equal(college.cells.find(c => c.row === 3 && c.col === 4).text, '46.0');
  }
});

test('B1 자릿수 예시는 사용자가 고친 다른 값을 덮어쓰거나 일부 일치로 0을 끼워 넣지 않는다', async t => {
  const s = setup(t); const id = s.doc(admin);
  const d = await s.store.doc(id);
  const ref = d.tables().find(t => t.caption?.text.includes('원 등급별 재수강 평점변화')).cells.find(c => c.row === 5 && c.col === 4).refs[0];
  const p = await s.service.propose(id, { ref, find: '0.7', replace: '0.75', reason: '사용자의 별도 수정' }, admin);
  await s.service.applyProposal(id, p.pid, admin);
  await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '표 자릿수', tutorialStep: 'B1', route: 'example' }, admin);
  const r = s.service._meta(id).requests.at(-1);
  assert.match(r.summary, /넣지 못했습니다/);
  assert.ok(!s.service._meta(id).proposals.some(p => p.rid === r.rid && p.ref === ref));
  assert.equal((await s.store.doc(id)).text(ref, 'final'), '0.75');
});
