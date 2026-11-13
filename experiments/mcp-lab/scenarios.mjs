// Repeatable, deterministic functional exercises. These are real MCP calls and
// real HWPX persistence checks, not an evaluation of a model's reasoning quality.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpxDoc } from '../../engine/doc.js';
import { createLabRuntime } from './runtime.mjs';
import { createLabConnection } from './gateway.mjs';
import { createInstructionStore } from './instructions.mjs';

const labRoot = fileURLToPath(new URL('./', import.meta.url));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const payloadChars = value => JSON.stringify(value).length;
const plainText = result => (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
function unpack(result, name) {
  assert.ok(!result.isError, `${name}: ${plainText(result)}`);
  const text = plainText(result);
  try { return JSON.parse(text); } catch { return text; }
}
const safeCall = async (connection, name, args) => unpack(await connection.call(name, args), name);
const load = async (runtime, docId) => HwpxDoc.load(runtime.service.store.currentBytes(docId));
const paragraphs = doc => doc.paragraphs({ nested: true, view: 'final' });
const lookup = (doc, text) => {
  const paragraph = paragraphs(doc).find(item => item.text === text);
  assert.ok(paragraph, `Saved paragraph is missing: ${text}`);
  return paragraph;
};

// Explicit scenario fixture, never presented as the user's installed skill.
export const EDUCATION_REVIEW_FIXTURE = Object.freeze({
  name: 'education-review-scenario-fixture', version: '1', source: 'fixture:deterministic-education-review',
  instructions: '교육 연구 검토 시험 지침입니다. 관측 결과와 인과 해석을 구분합니다. 주장에 필요한 비교집단·자료 기준·분모를 확인합니다. 필요한 근거가 없으면 확인 필요로 표시합니다. 검토 결과는 메모로 저장합니다.',
  references: [{ id: 'evidence-check', name: '근거 확인 시험 규칙', text: '만족도 평균만으로 프로그램의 인과 효과를 단정하지 않습니다. 비교집단이나 사전 측정이 없는 단일 사후 설문은 기술 결과로 보고합니다.' }],
});

async function makeDocument(connection, title, texts = []) {
  await safeCall(connection, 'enable_tools', { groups: ['writing', 'workflow', 'review'] });
  const made = await safeCall(connection, 'create_document', { title, space: 'private', review_required: false });
  assert.ok(made.id, 'create_document must return an actual document ID');
  if (texts.length) await safeCall(connection, 'propose_insert', { doc_id: made.id, after_ref: 's0/p0', paragraphs: texts.map(text => ({ text })) });
  return made.id;
}

async function startTask(runtime, connection, docId, instruction, target) {
  // This is the trusted test UI creating a queue item, never an API model call.
  const created = await runtime.service.createRequest(docId, { kind: 'instruct', route: 'queue', instruction, target }, runtime.users.owner);
  const requestId = created.request.rid;
  const context = await safeCall(connection, 'get_request', { doc_id: docId, request_id: requestId });
  const attempt = context.attempt ?? created.request.attempt ?? 1;
  await safeCall(connection, 'start_request', { doc_id: docId, request_id: requestId, expected_attempt: attempt });
  return { doc_id: docId, request_id: requestId, expected_attempt: attempt };
}
async function finishTask(runtime, connection, task, summary) {
  await safeCall(connection, 'complete_request', { ...task, summary, execution: 'deterministic' });
  assert.equal(runtime.service._meta(task.doc_id).requests.find(item => item.rid === task.request_id)?.status, 'done', 'Completion must be persisted');
}
function savedProposals(runtime, docId) {
  const proposals = runtime.service._meta(docId).proposals;
  assert.ok(proposals.length, 'The scenario must persist actual proposals');
  assert.ok(proposals.every(item => item.status === 'applied'), 'A pending or failed proposal is not a completed saved edit');
  return proposals.length;
}
async function readAllGuidance(connection, args) {
  let offset = 0, hash, text = '', pages = 0;
  do {
    const page = await safeCall(connection, 'get_task_guidance', { ...args, offset, limit: 80, ...(hash ? { expected_sha256: hash } : {}) });
    assert.equal(typeof page.text, 'string');
    hash = page.sha256; text += page.text; pages++;
    offset = page.next_offset;
    assert.equal(page.complete, offset === null, 'Continuation must be explicit');
  } while (offset !== null);
  return { text, pages, sha256: hash };
}

async function quickSentence({ runtime, connection }) {
  const source = '이번 프로그램은 학습 경험 향상에 도움을 주는 것으로 사료된다.';
  const replacement = '이번 프로그램은 학습 경험 향상에 도움이 될 수 있다.';
  const docId = await makeDocument(connection, '실험 1 문장 수정', [source]);
  const ref = lookup(await load(runtime, docId), source).ref;
  const task = await startTask(runtime, connection, docId, '문장의 불필요한 표현을 간결하게 고쳐 주세요.', { ref });
  await safeCall(connection, 'propose_changes', { ...task, proposals: [{ ref, find: source, replace: replacement, reason: '결정적 시험 문장 교체' }] });
  // Request-bound proposals are persisted first. In auto-apply documents the
  // existing service applies them during complete_request; verify bytes after it.
  await finishTask(runtime, connection, task, '실험 문장 한 개의 수정 제안을 저장했습니다.');
  const saved = await load(runtime, docId);
  lookup(saved, replacement);
  assert.ok(!paragraphs(saved).some(item => item.text === source));
  return { docId, checks: ['exact replacement persisted in final text', 'original final paragraph replaced', 'request completed after write'], proposals: savedProposals(runtime, docId) };
}

async function educationReview({ runtime, connection, instructionStore }) {
  const source = '가상 사후 설문에서 만족도 평균은 4.2점이었다. 따라서 프로그램의 학습 성과 향상 효과가 입증되었다.';
  const docId = await makeDocument(connection, '실험 2 교육 연구 검토', [source]);
  const ref = lookup(await load(runtime, docId), source).ref;
  const instruction = '교육 연구 검토 시험 지침을 선택하여 문장의 근거와 인과 표현을 검토하고 메모를 남겨 주세요.';
  const task = await startTask(runtime, connection, docId, instruction, { ref });
  const selected = instructionStore.registerClientSkill(runtime.users.owner.name, EDUCATION_REVIEW_FIXTURE);
  await instructionStore.setTaskGuidance(runtime.users.owner.name, { doc_id: docId, request_id: task.request_id,
    user_instruction: instruction, selected_skills: [selected.skill_id] });
  const scope = { doc_id: docId, request_id: task.request_id };
  const metadata = await safeCall(connection, 'get_task_guidance', scope);
  assert.equal(metadata.selected_skills[0].skill_id, selected.skill_id);
  const instructionRead = await readAllGuidance(connection, { ...scope, view: 'instruction' });
  const skillRead = await readAllGuidance(connection, { ...scope, view: 'skill', skill_id: selected.skill_id });
  const referenceRead = await readAllGuidance(connection, { ...scope, view: 'reference', skill_id: selected.skill_id, reference_id: 'evidence-check' });
  assert.equal(instructionRead.text, instruction);
  assert.equal(skillRead.text, EDUCATION_REVIEW_FIXTURE.instructions);
  assert.equal(referenceRead.text, EDUCATION_REVIEW_FIXTURE.references[0].text);
  const memo = '실험 검토: 단일 사후 만족도 설문은 기술 결과입니다. 비교집단·사전 측정 자료가 없어 학습 성과의 인과 효과는 확인 필요입니다.';
  await safeCall(connection, 'add_memo', { ...task, ref, text: memo });
  const memos = await runtime.service.memos(docId, runtime.users.owner);
  assert.ok(JSON.stringify(memos).includes(memo), 'The selected-guidance review memo must actually be saved');
  lookup(await load(runtime, docId), source);
  await finishTask(runtime, connection, task, '선택된 시험 지침과 참조를 읽고 근거 확인 메모를 저장했습니다.');
  return { docId, checks: ['explicit selected fixture skill discovered by ID', 'complete original instruction and skill/reference retrieved', 'review memo persisted', 'source paragraph preserved', 'no model reasoning quality claim'],
    guidance: { source: EDUCATION_REVIEW_FIXTURE.source, instructionSha256: instructionRead.sha256, skillSha256: skillRead.sha256,
      referenceSha256: referenceRead.sha256, fetchedPages: instructionRead.pages + skillRead.pages + referenceRead.pages }, proposals: savedProposals(runtime, docId) };
}

async function tableModify({ runtime, connection }) {
  const docId = await makeDocument(connection, '실험 3 표 수정');
  await safeCall(connection, 'enable_tools', { groups: ['tables'] });
  await safeCall(connection, 'propose_table', { doc_id: docId, after_ref: 's0/p0', rows: [['구분', '응답 수'], ['가상 A', '10'], ['가상 B', '20']], caption: '시험용 가상 집계' });
  let doc = await load(runtime, docId);
  const table = doc.tables()[0]; assert.ok(table);
  const cellRef = lookup(doc, '10').ref;
  const task = await startTask(runtime, connection, docId, '시험 표 A 응답 수를 12로 고치고 가상 합계 32 행을 넣어 주세요.', { ref: cellRef, tableKey: table.key });
  await safeCall(connection, 'propose_changes', { ...task, proposals: [{ ref: cellRef, find: '10', replace: '12', reason: '시험 입력 정정' }] });
  await safeCall(connection, 'propose_table_edit', { ...task, table: table.key, ops: [{ op: 'insert_rows', row: 2, values: [['가상 합계', '32']] }], reason: '시험 합계 행 추가' });
  await finishTask(runtime, connection, task, '시험 표 값과 합계 행 수정 제안을 저장했습니다.');
  doc = await load(runtime, docId);
  const saved = doc.tables()[0];
  assert.equal(saved.rows, 4); assert.equal(saved.cols, 2);
  assert.equal(saved.cells.find(cell => cell.row === 1 && cell.col === 1)?.text, '12');
  assert.equal(saved.cells.find(cell => cell.row === 3 && cell.col === 1)?.text, '32');
  return { docId, checks: ['cell replacement persisted', 'four-row two-column table persisted', 'inserted total row values verified'], proposals: savedProposals(runtime, docId) };
}

async function figureCreateReplace({ runtime, connection }) {
  const docId = await makeDocument(connection, '실험 4 그림 생성과 교체');
  await safeCall(connection, 'enable_tools', { groups: ['figures'] });
  const firstSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><rect x="10" y="10" width="220" height="80" fill="#2463a8"/></svg>';
  const secondSvg = firstSvg.replace('#2463a8', '#e58b24');
  const firstRaw = await connection.call('render_figure_preview', { doc_id: docId, after_ref: 's0/p0', width_mm: 100, svg: firstSvg });
  const first = unpack(firstRaw, 'render_figure_preview');
  assert.ok(firstRaw.content.some(block => block.type === 'image'), 'Actual image preview must be returned');
  assert.ok(first.artifact_id);
  const creationArgs = { doc_id: docId, artifact_id: first.artifact_id, caption: '시험 그림' };
  await safeCall(connection, 'propose_rendered_figure', creationArgs);
  const before = await load(runtime, docId), originalFigure = before.figures()[0];
  assert.equal(before.figures().length, 1);
  const oldImage = digest(Buffer.from(before.binaryItem(originalFigure.binId).bytes));
  const figures = await safeCall(connection, 'list_figures', { doc_id: docId });
  const figureKey = Array.isArray(figures) ? figures[0].figure : figures.figures?.[0]?.figure;
  assert.ok(figureKey, 'The actual saved figure address must be available');
  const secondRaw = await connection.call('render_figure_preview', { doc_id: docId, replace_ref: figureKey, svg: secondSvg });
  const second = unpack(secondRaw, 'render_figure_preview');
  const replacementArgs = { doc_id: docId, artifact_id: second.artifact_id, reason: '시험 그림 색상 교체' };
  await safeCall(connection, 'propose_rendered_figure', replacementArgs);
  const retry = await safeCall(connection, 'propose_rendered_figure', replacementArgs);
  assert.equal(retry.duplicate, true);
  const after = await load(runtime, docId), replaced = after.figures()[0];
  assert.equal(after.figures().length, 1);
  assert.notEqual(digest(Buffer.from(after.binaryItem(replaced.binId).bytes)), oldImage);
  assert.equal(replaced.caption?.text, originalFigure.caption?.text);
  assert.equal(replaced.width, originalFigure.width);
  assert.equal(runtime.service._meta(docId).proposals.length, 2, 'Retry must not create a third figure proposal');
  return { docId, checks: ['actual PNG preview returned', 'figure inserted through artifact ID', 'replacement changes saved image bytes', 'caption and width preserved', 'retry writes once'],
    payload: { firstSourceChars: firstSvg.length, secondSourceChars: secondSvg.length,
      creationArgumentsChars: payloadChars(creationArgs), replacementArgumentsChars: payloadChars(replacementArgs),
      avoidedRepeatedSourceChars: firstSvg.length + secondSvg.length }, proposals: savedProposals(runtime, docId) };
}

async function reportConclusion({ runtime, connection }) {
  const docId = await makeDocument(connection, '실험 5 보고서와 결론');
  const task = await startTask(runtime, connection, docId, '가상 자료를 사용한 짧은 시험 보고서를 작성하고 결론과 자료 한계를 포함해 주세요.', { scope: 'document' });
  const sections = ['1. 분석 목적', '시험용 가상 응답 30건의 만족도 기술 결과를 정리한다.', '2. 분석 결과', '가상 평균은 4.2점이며 인과 효과를 추정한 값이 아니다.', '3. 결론', '가상 기술 결과는 후속 조사 설계의 예시로만 사용한다.', '4. 자료의 한계', '모든 수치는 기능 검증을 위한 가상 입력이며 실제 기관의 분석 결과가 아니다.'];
  await safeCall(connection, 'propose_insert', { ...task, after_ref: 's0/p0', paragraphs: sections.map(text => ({ text })) });
  await finishTask(runtime, connection, task, '시험 보고서의 목적·결과·결론·자료 한계 문단 제안을 저장했습니다.');
  const saved = await load(runtime, docId), texts = paragraphs(saved).map(item => item.text);
  for (const text of sections) lookup(saved, text);
  const positions = sections.map(text => texts.indexOf(text));
  assert.ok(positions.every((position, index) => !index || position > positions[index - 1]), 'Report sections must retain input order');
  return { docId, checks: ['all eight requested paragraphs saved', 'conclusion and data limitations present', 'paragraph order preserved', 'completion applies stored proposals and final file is verified'], proposals: savedProposals(runtime, docId) };
}

async function comparePayloads(runtime, instructionStore, connections) {
  const full = await createLabConnection(runtime, { user: runtime.users.owner, profile: 'full', compact: false, instructionStore }); connections.push(full);
  const focused = await createLabConnection(runtime, { user: runtime.users.owner, profile: 'focused', compact: true, instructionStore }); connections.push(focused);
  const a = await full.client.listTools(), b = await focused.client.listTools();
  const made = await safeCall(full, 'create_document', { title: '응답 크기 비교용 가상 문서', space: 'private', review_required: false });
  await safeCall(full, 'propose_insert', { doc_id: made.id, after_ref: 's0/p0', paragraphs: Array.from({ length: 8 }, (_, i) => ({ text: `가상 비교 문단 ${i + 1}: 동일한 원문을 보존하면서 문맥 표현의 중복만 비교합니다.` })) });
  const request = await runtime.service.createRequest(made.id, { kind: 'instruct', route: 'queue', target: { scope: 'document' }, instruction: '가상 문서 전체의 표현을 검토해 주세요.' }, runtime.users.owner);
  const args = { doc_id: made.id, request_id: request.request.rid };
  const raw = await full.call('get_request', args), compact = await focused.call('get_request', args);
  const rawValue = unpack(raw, 'baseline get_request'), compactValue = unpack(compact, 'focused get_request');
  assert.deepEqual(compactValue.contextItems, rawValue.contextItems, 'Compaction must preserve all structured source paragraphs');
  assert.equal(compactValue.instruction, rawValue.instruction, 'Compaction must preserve the user instruction');
  return { measurement: 'JSON serialized characters; not billable model tokens',
    schemas: { baselineProfile: 'full lab gateway, compact=false', baselineTools: a.tools.length, baselineChars: payloadChars(a.tools),
      underlyingBaseTools: full.gateway.baseTools.length, underlyingBaseChars: payloadChars(full.gateway.baseTools),
      focusedProfile: 'focused lab gateway before enable_tools', focusedTools: b.tools.length, focusedChars: payloadChars(b.tools) },
    request: { baselineChars: payloadChars(raw), focusedChars: payloadChars(compact), sourceParagraphsPreserved: rawValue.contextItems.length,
      instructionPreserved: true }, modelTokens: null };
}

/** Writes artifacts only when outputPath is explicitly supplied inside this lab.
 * All document content is synthetic. Failure reports never count unfinished
 * writes as success, and runScenarios rejects if any scenario did not complete. */
export async function runScenarios({ outputPath } = {}) {
  let reportPath = null, artifactDir = null;
  if (outputPath) {
    reportPath = path.resolve(outputPath);
    const relative = path.relative(labRoot, reportPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Scenario output must stay inside experiments/mcp-lab.');
    artifactDir = path.join(path.dirname(reportPath), 'documents');
    await fs.mkdir(artifactDir, { recursive: true });
    const realLab = await fs.realpath(labRoot), realOut = await fs.realpath(artifactDir), realRelative = path.relative(realLab, realOut);
    if (realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) throw new Error('Scenario output resolves outside the laboratory.');
  }
  const runtime = createLabRuntime(), connections = [];
  const instructionStore = createInstructionStore({ authorizeScope: async (userId, scope) => {
    const user = Object.values(runtime.users).find(item => item.name === userId);
    if (!user) return false;
    try { runtime.service.assertDocRead(scope.doc_id, user); return runtime.service._meta(scope.doc_id).requests.some(item => item.rid === scope.request_id && item.by === user.name); }
    catch { return false; }
  } });
  const report = { version: 1, execution: 'deterministic MCP calls and actual HWPX persistence checks', sourceData: 'synthetic fixtures only',
    paidApiCalls: 0, modelReasoningEvaluated: false, modelTokens: null, scenarios: [] };
  try {
    report.comparison = await comparePayloads(runtime, instructionStore, connections);
    const scenarioFunctions = [['quick_sentence', quickSentence], ['education_review', educationReview], ['table_modify', tableModify], ['figure_create_replace', figureCreateReplace], ['report_conclusion', reportConclusion]];
    for (const [id, run] of scenarioFunctions) {
      const connection = await createLabConnection(runtime, { user: runtime.users.owner, profile: 'focused', compact: true, instructionStore });
      connections.push(connection);
      try {
        const result = await run({ runtime, connection, instructionStore });
        const bytes = runtime.service.store.currentBytes(result.docId);
        await HwpxDoc.load(bytes); // Verify the persisted package independently of service cache.
        const artifactPath = artifactDir ? path.join(artifactDir, `${id}.hwpx`) : null;
        if (artifactPath) await fs.writeFile(artifactPath, bytes);
        report.scenarios.push({ id, status: 'passed', checks: result.checks, proposals: result.proposals,
          ...(result.guidance ? { guidance: result.guidance } : {}), ...(result.payload ? { payload: result.payload } : {}),
          document: { persisted: true, bytes: bytes.length, sha256: digest(bytes), ...(artifactPath ? { path: artifactPath } : { retained: false }) },
          metrics: connection.metrics.snapshot() });
      } catch (error) {
        report.scenarios.push({ id, status: 'failed', error: { code: error.code || error.name, message: error.message }, metrics: connection.metrics.snapshot() });
      }
    }
    report.passed = report.scenarios.every(item => item.status === 'passed');
    if (reportPath) { report.path = reportPath; await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
    if (!report.passed) throw Object.assign(new Error('One or more MCP laboratory scenarios failed.'), { report });
    return report;
  } finally {
    for (const connection of connections.reverse()) await connection.close();
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runScenarios({ outputPath: process.argv[2] || path.join(labRoot, 'artifacts', 'scenarios-report.json') });
    console.log(JSON.stringify({ passed: report.passed, report: report.path, scenarios: report.scenarios.map(item => ({ id: item.id, status: item.status })) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, scenarios: error.report?.scenarios.filter(item => item.status !== 'passed') }, null, 2));
    process.exitCode = 1;
  }
}
