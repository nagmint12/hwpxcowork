// node --test tests/tutorial_ai_work.test.mjs — 'AI로 보고서 만들기' 튜토리얼(2026-11-12, docs/TUTORIAL_AI_WORK_2026-11-12.md).
// 코스 구성(AI 작업 카드 = 요청·반영 두 단계, 그림 장면 모듈), 요청 창에 첨부(엑셀·.skill)를 미리 붙이기,
// 예시 답변(주제 조사 R1 · 엑셀로 절 X1 · 내 skill 결론 K1)을 코스 순서대로 다시 냈을 때 모든 호출이 들어가고 첨부·스킬 읽기가 작업 기록에 남는지.
// 유료 호출 없음(예시 답변 실행기), 문서는 임시 사본.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../server/service.js';
import { TutorialStore as Store } from '../server/tutorial-store.js';
import { createTutorial } from '../server/tutorial.js';
import { resolveAnchors, answerFor } from '../server/tutorial-advanced.js';
import { AI_WORK_TASKS, TUTORIAL_AI_TASKS, ADVANCED_TASKS } from '../web/tutorial-advanced-tasks.js';
import { DEFAULT_TUTORIAL_DEFINITION, normalizeTutorialDefinition, TUTORIAL_MODULES } from '../web/tutorial-definition.js';
import { buildComposedTutorialSteps, validateTutorialStepReferences, describeTutorialModule } from '../web/tutorial-modules/compose.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRACTICE = path.join(ROOT, 'tutorial', 'AI 활용 심화 — 연습 보고서.hwpx');
const FILES = ['재수강 경험자 설문 결과(가상).xlsx', '보고서 작성 규칙(예시).skill'];
const admin = { name: '관리자', role: 'admin' };
const learner = { name: 'test1', role: 'editor' };
const course = () => DEFAULT_TUTORIAL_DEFINITION.courses.find((c) => c.id === 'ai-work');

const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [], attachments: [] }, ctx: {}, clipboard: { seq: 0 }, config: {},
  saveButton() {}, focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, locate() {}, phraseRect() {}, cw() {},
  selectFor: async (phrase) => ({ ref: 's1/p1', start: 0, end: 3, text: phrase, refs: ['s1/p1'] }), toolbarShown: () => false, selHas: () => false, motionReduced: () => true });

test('기본 구성: AI 작업 튜토리얼이 결과보고서 다음에 있고, 한/글 편집 소개는 AI 튜토리얼 뒤에 있다', () => {
  const ids = DEFAULT_TUTORIAL_DEFINITION.courses.map((c) => c.id);
  assert.equal(DEFAULT_TUTORIAL_DEFINITION.entryCourseId, 'report', '첫 접속 안내는 그대로 결과보고서');
  assert.equal(ids[1], 'ai-work');
  for (const editing of ['overview', 'clipboard']) for (const ai of ['report', 'ai-work', 'ai-requests', 'ai-connect', 'ai-advanced']) assert.ok(ids.indexOf(editing) > ids.indexOf(ai), `${editing} 은 ${ai} 뒤`);
  assert.equal(ids.at(-1), 'admin');
  const c = course();
  assert.equal(c.sourceId, 'ai-advanced');
  assert.deepEqual(c.modules.map((m) => m.moduleId), ['ai-place', 'topic-research', 'excel-report', 'document-proofread', 'skill-conclusion', 'hangul-export', 'own-ai']);
  validateTutorialStepReferences(normalizeTutorialDefinition(structuredClone(DEFAULT_TUTORIAL_DEFINITION)));
  // 그림 장면 모듈은 연습 문서에 기대지 않아 어느 튜토리얼에나 넣을 수 있다
  for (const id of ['ai-place', 'hangul-export', 'own-ai']) assert.equal(TUTORIAL_MODULES.find((m) => m.id === id).sourceId, null);
  const report = structuredClone(DEFAULT_TUTORIAL_DEFINITION);
  report.courses.find((x) => x.id === 'report').modules.push({ key: 'export', moduleId: 'hangul-export' }, { key: 'mine', moduleId: 'own-ai' });
  validateTutorialStepReferences(normalizeTutorialDefinition(report));
});

test('코스는 짧다: AI 작업마다 [보내기]·[모두 반영] 두 단계, 그림 장면은 영상 없이 한 단계', () => {
  const steps = buildComposedTutorialSteps(course(), environment());
  assert.ok(steps.length <= 14, `단계 ${steps.length}개`);
  for (const id of ['topic-research', 'excel-report', 'document-proofread', 'skill-conclusion']) {
    const mine = steps.filter((s) => s.moduleId === id);
    assert.equal(mine.length, 2, id);
    assert.equal(mine[0].press, '보내기');
    assert.equal(mine[1].press, '모두 반영');
  }
  const scenes = steps.filter((s) => s.scene);
  assert.deepEqual(scenes.map((s) => s.scene), ['ai-place', 'hangul-export', 'own-skills']);
  assert.ok(scenes.every((s) => typeof s.example === 'function' && s.next));
  assert.ok(!steps.some((s) => s.media), '촬영 영상 단계가 없다');
  const save = steps.find((s) => s.moduleId === 'hangul-export');
  assert.equal(save.nextPlain, true, '저장은 강요하지 않는다');
  for (const id of ['topic-research', 'excel-report', 'skill-conclusion']) {
    const d = describeTutorialModule(id); assert.equal(d.steps.length, 2); assert.deepEqual(d.steps[1].dependsOn, [d.steps[0].stepId]);
  }
});

test('AI 작업 카드: 요청 창을 열 때 그 작업의 첨부(엑셀·.skill)만 미리 붙이고, 첫 줄에 손으로 할 일(why)을 보여 준다', async () => {
  for (const [moduleId, want] of [['topic-research', []], ['excel-report', ['a1']], ['skill-conclusion', ['a2']]]) {
    const env = environment();
    env.s.attachments = [{ aid: 'a1', name: FILES[0] }, { aid: 'a2', name: FILES[1] }, { aid: 'a3', name: '다른 자료.pdf' }];
    let opened = null;
    env.d.openComposer = (target, kind, opts) => { opened = { target, kind, opts }; env.s.composer = { phase: 'edit', instruction: '', attachments: opts.attachments }; };
    const steps = buildComposedTutorialSteps({ sourceId: 'ai-advanced', modules: [{ key: moduleId, moduleId }] }, env);
    const ask = steps.find((s) => s.moduleId === moduleId);
    ask.enter();
    for (let k = 0; k < 50 && !opened; k++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(opened, moduleId);
    assert.deepEqual(opened.opts.attachments, want, moduleId);
    const task = AI_WORK_TASKS.find((t) => t.id === opened.opts.tutorialStep);
    assert.ok(task?.why); assert.ok(ask.text().startsWith(task.why), moduleId);
    if (want.length) assert.match(ask.text(), new RegExp(env.s.attachments.find((a) => a.aid === want[0]).name.replace(/[().]/g, '\\$&')));
  }
});

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-aiwork-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = { tutorialExampleDelayMs: 0, root: ROOT, configFile: path.join(tmp, 'config.json'), dataDir: path.join(tmp, 'data'), ai: {}, agents: { othersCanTake: true }, tutorial: { users: [learner.name], shareFrom: [admin.name] } };
  const store = new Store(path.join(tmp, 'store'));
  const service = new Service({ store, config, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  return { config, store, service };
}

test('예시 답변: 작업 번호가 겹치지 않고, X1·K1 은 첨부·스킬 읽기를 앞에 두며 @attach 는 이름으로 찾는다', async (t) => {
  const ids = TUTORIAL_AI_TASKS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length); assert.equal(ADVANCED_TASKS.length, 5, '예전 다섯 작업은 그대로');
  for (const task of AI_WORK_TASKS) assert.ok(answerFor(ROOT, task.id)?.calls.length, task.id);
  assert.deepEqual(answerFor(ROOT, 'X1').calls.slice(0, 2).map((c) => c.name), ['read_attachment', 'get_writing_guide']);
  assert.equal(answerFor(ROOT, 'K1').calls[0].name, 'read_skill_resource');
  assert.ok(answerFor(ROOT, 'K1').calls.some((c) => c.name === 'propose_toc_update'), 'skill 규칙 4 — 차례 새로 고침');
  const s = setup(t);
  const id = s.store.create({ fileName: 'p.hwpx', bytes: fs.readFileSync(PRACTICE), by: admin.name }).id;
  const d = await s.store.doc(id);
  const atts = [{ aid: 'a1', name: FILES[0] }, { aid: 'a2', name: FILES[1] }];
  assert.deepEqual(resolveAnchors(d, [], { attachment_id: '@attach:.xlsx' }, atts), { attachment_id: 'a1' });
  assert.deepEqual(resolveAnchors(d, [], { attachment_id: `@attach:${FILES[1]}` }, atts), { attachment_id: 'a2' });
  assert.equal(resolveAnchors(d, [], { attachment_id: '@attach:.pdf' }, atts), null, '없는 첨부는 그 호출을 건너뛴다');
  // 예시 skill 은 SKILL.md 하나짜리 묶음이고 시험용이라고 밝힌다
  const { skillText } = await import('../server/skill-archive.js');
  const skill = await skillText(fs.readFileSync(path.join(ROOT, 'tutorial', FILES[1])));
  assert.match(skill.text, /실제 기관의 규칙이 아닙니다/); assert.deepEqual(skill.resources.map((r) => r.path), ['SKILL.md']);
});

test('코스 순서대로(조사 → 엑셀 → 교정 → skill 결론) 다시 내면 모든 호출이 들어가고, 읽기 호출이 작업 기록에 남는다 — 새 문서·반영한 문서', { timeout: 120000 }, async (t) => {
  for (const applied of [false, true]) {
    const s = setup(t);
    const id = s.store.create({ fileName: 'p.hwpx', bytes: fs.readFileSync(PRACTICE), by: admin.name, extra: { tutorialOwnAi: true, tutorialId: 'ai-work' } }).id;
    for (const f of FILES) await s.service.addAttachment(id, { name: f, bytes: fs.readFileSync(path.join(ROOT, 'tutorial', f)) }, admin);
    const atts = s.service._meta(id).attachments;
    const counts = {};
    for (const step of ['R1', 'X1', 'S4', 'K1']) {
      const task = TUTORIAL_AI_TASKS.find((x) => x.id === step);
      const aids = atts.filter((a) => (task.attach || []).some((n) => a.name.includes(n))).map((a) => a.aid);
      const res = await s.service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: task.prompt, tutorialStep: step, attachments: aids }, admin);
      assert.equal(res.route, 'example', step);
      const r = s.service._meta(id).requests.at(-1);
      assert.equal(r.status, 'done', `${step} ${r.error}`);
      assert.doesNotMatch(r.summary, /넣지 못했습니다/, `${applied ? '반영한 문서' : '새 문서'}: ${step} 의 예시 일부가 들어가지 않음`);
      counts[step] = r.proposals.length;
      const tools = s.service.activity.list(id, r.rid).map((x) => x.tool);
      if (step === 'X1') { assert.ok(tools.includes('read_attachment') && tools.includes('get_writing_guide'), tools.join()); }
      if (step === 'K1') assert.ok(tools.includes('read_skill_resource'), tools.join());
      if (applied && r.proposals.length) {
        const out = await s.service.resolveRequest(id, r.rid, { apply: 'rest' }, admin);
        assert.equal(out.counts.failed, 0, `${step}: ${JSON.stringify(out.results.filter((x) => !x.ok))}`);
        assert.equal(out.counts.applied, r.proposals.length, `${step}: 모든 제안이 반영되어야 한다`);
      }
    }
    // C2 의 '표 뒤 빈 줄' 두 번이 같은 호출로 합쳐지지 않는다(14 = 제목·본문 5·단위 2·표 2·빈 줄 2·그래프·주석)
    assert.deepEqual([counts.R1, counts.X1, counts.K1], [1, 14, 11]);
    if (applied) {
      const text = (await s.store.doc(id)).paragraphs({ view: 'final' }).map((p) => p.text).join('\n');
      for (const want of ['(해석 시 유의점)', '5) 재수강 경험자 설문 결과', '2) 시사점 및 정책제언']) assert.ok(text.includes(want), want);
    }
  }
});

test('메뉴에서 시작하면 예시 답변 문서(tutorialOwnAi)에 7모듈 구성과 엑셀·예시 skill 첨부가 붙는다', async (t) => {
  const s = setup(t);
  const tut = createTutorial({ service: s.service, config: s.config });
  const item = tut.status(learner).items.find((x) => x.id === 'ai-work');
  assert.ok(item); assert.equal(item.number, 2); assert.ok(item.guided);
  const started = await tut.start(learner, { tutorialId: 'ai-work' });
  const meta = s.store.readMeta(started.docId);
  assert.equal(meta.tutorialOwnAi, true); assert.ok(!meta.tutorial); assert.equal(meta.tutorialSourceId, 'ai-advanced');
  assert.equal(meta.tutorialModules.length, 7);
  assert.deepEqual(meta.attachments.map((a) => a.name), FILES);
});
