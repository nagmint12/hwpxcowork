// Deterministic gateway exercise with retained HWPX evidence. No model/API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { HwpxDoc } from '../../engine/doc.js';
import { tocRegions, physicalParas, tocRole } from '../../engine/toc.js';
import { createTocInEngine } from '../../server/toc-engine.js';
import { createLabRuntime } from './runtime.mjs';
import { createLabConnection } from './gateway.mjs';

const labRoot = fileURLToPath(new URL('./', import.meta.url));
const artifactDir = path.join(labRoot, 'artifacts', 'formatting-documents');
const reportPath = path.join(labRoot, 'artifacts', 'formatting-report.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = name => fs.readFile(new URL(`../../tests/fixtures/${name}`, import.meta.url));
const flatText = doc => doc.paragraphs({ nested: true, view: 'final' }).map(p => p.text);
const countDocument = doc => ({ sections: doc.sections.length, paragraphs: doc.paragraphs({ nested: true }).length,
  tables: doc.tables().length, figures: doc.figures().length, tocFields: tocRegions(doc).length });
function tocRefs(doc) {
  return tocRegions(doc).flatMap(region => physicalParas(doc.sections[region.sec]).slice(region.start, region.end + 1).map(item => item.rec.ref));
}
function nonTocText(doc) {
  const refs = tocRefs(doc);
  return doc.paragraphs({ nested: true, view: 'final' }).filter(p => !refs.some(ref => p.ref === ref || p.ref.startsWith(`${ref}/`))).map(p => p.text);
}
async function safeCall(connection, name, args) {
  const reply = await connection.call(name, args);
  const text = reply.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.ok(!reply.isError, `${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function retain(name, bytes) {
  const target = path.join(artifactDir, `${name}.hwpx`);
  await fs.writeFile(target, bytes);
  const reopened = await HwpxDoc.load(await fs.readFile(target));
  return { doc: reopened, artifact: { path: path.relative(labRoot, target).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes), ...countDocument(reopened) } };
}
async function importFixture(runtime, bytes, name) {
  const doc = await runtime.runExclusive(() => runtime.service.createDocument({ fileName: `${name}.hwpx`, bytes,
    title: name, user: runtime.users.owner, location: { space: 'private' } }));
  return doc.id;
}
const auditSummary = audit => ({ inspected: audit.inspected, mismatched: audit.mismatched, repairable: audit.repairable, groups: audit.groups });
const tocSummary = value => ({ fields: value.fields, heading_issues: value.heading_issues, pending_prerequisites: value.pending_prerequisites });

async function headingScenario(runtime, connection) {
  const seed = await (await HwpxDoc.load(await fixture('tool_memo_tracked.hwpx'))).flattened();
  const tail = seed.paragraphs({ nested: false }).at(-1), match = /^s(\d+)\/p(\d+)$/.exec(tail.ref);
  seed.insertParagraphAfter(Number(match[1]), Number(match[2]), '1. 명시적 역할 매핑 시험 제목', { author: '실험용 자료 준비' }); seed.acceptAll();
  const heading = seed.paragraphs({ nested: false }).find(p => p.text === '1. 명시적 역할 매핑 시험 제목');
  const bodyRef = 's0/p2';
  for (const ref of [heading.ref, bodyRef]) seed.formatRange(ref, { start: 0, end: [...seed.text(ref)].length, styleId: '0' });
  const normal = seed.formattingCatalog().styles.find(style => style.id === '0'), bold = seed.header.boldCharPr(normal.charPrId);
  const headingId = seed.header.addItem('styles', 'style', `<hh:style id="0" type="PARA" name="실험 제목 1" engName="LabHeadingOne" paraPrIDRef="${normal.paraPrId}" charPrIDRef="${bold}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`);
  seed.formatRange(bodyRef, { start: 0, end: [...seed.text(bodyRef)].length,
    char: { sizePt: 24 }, paragraph: { align: 'CENTER' } });
  const docId = await importFixture(runtime, await seed.save(), '역할 스타일 교정 실험');
  const before = await retain('heading-before', runtime.service.store.currentBytes(docId));
  const args = { doc_id: docId, refs: [heading.ref, bodyRef], roles: [{ role: 'section_heading', refs: [heading.ref], style: { id: headingId } }] };
  const initial = await safeCall(connection, 'audit_formatting', args);
  assert.ok(initial.groups.some(item => item.kind === 'semantic_style'));
  assert.ok(initial.groups.some(item => item.kind === 'character_override'));
  const proposed = await safeCall(connection, 'propose_format_normalization', { doc_id: docId, audit_id: initial.audit_id,
    reset_direct_overrides: true, reason: '실험에서 지정한 제목 역할과 본문 스타일 기준으로 교정' });
  assert.equal(proposed.failed, 0); assert.equal(proposed.succeeded, 2);
  assert.ok(proposed.results.every(item => item.status === 'pending'));
  const pending = await HwpxDoc.load(runtime.service.store.currentBytes(docId));
  assert.equal(pending.inspectFormatting(heading.ref).styleId, '0');
  for (const receipt of proposed.results) await safeCall(connection, 'apply_proposal', { doc_id: docId, proposal_id: receipt.pid });
  const after = await retain('heading-after', runtime.service.store.currentBytes(docId));
  const final = await safeCall(connection, 'audit_formatting', args);
  assert.equal(final.mismatched, 0);
  assert.deepEqual(flatText(after.doc), flatText(before.doc));
  assert.equal(after.doc.inspectFormatting(heading.ref).styleId, headingId);
  const actualBody = after.doc.inspectFormatting(bodyRef), catalog = after.doc.formattingCatalog(), style = catalog.styles.find(s => s.id === '0');
  assert.equal(actualBody.paraPrId, style.paraPrId);
  assert.ok(actualBody.runs.every(run => run.charPrId === style.charPrId));
  return { id: 'heading_role_and_direct_overrides', status: 'passed', source: 'controlled repository fixture; synthetic extra heading and deliberate style drift',
    before: before.artifact, after: after.artifact, beforeAudit: auditSummary(initial), afterAudit: auditSummary(final), receipts: proposed.results,
    verification: { pendingDidNotApply: true, fullTextPreserved: true, textSha256: digest(JSON.stringify(flatText(after.doc))),
      heading: { ref: heading.ref, expectedStyleId: headingId, actualStyleId: after.doc.inspectFormatting(heading.ref).styleId },
      body: { ref: bodyRef, expectedStyleId: '0', actualStyleId: actualBody.styleId, paragraphMatchesStyle: true, allCharactersMatchStyle: true },
      savedPackageReopened: true } };
}

async function tocScenario(runtime, connection) {
  const styles = { title: '차례 제목', level1: '차례 1', level2: '차례 2', level3: '차례 3', captions: '차례 1' };
  const seed = await (await HwpxDoc.load(await fixture('toc_source.hwpx'))).flattened();
  seed.insertParagraphAfter(0, 0, '', { author: '실험용 자료 준비' }); seed.acceptAll();
  const generated = createTocInEngine(await seed.save(), { sec: 0, para: 1 });
  const corrupted = await HwpxDoc.load(generated.bytes);
  const titleRef = tocRefs(corrupted).find(ref => corrupted.text(ref).includes('제목 차례'));
  assert.ok(titleRef);
  corrupted.formatRange(titleRef, { start: 0, end: [...corrupted.text(titleRef)].length,
    styleId: '0', char: { sizePt: 31, bold: true }, paragraph: { align: 'CENTER' } });
  const docId = await importFixture(runtime, await corrupted.save(), '차례 출력 서식 교정 실험');
  const before = await retain('toc-before', runtime.service.store.currentBytes(docId));
  const initial = await safeCall(connection, 'inspect_toc', { doc_id: docId, toc_styles: styles });
  assert.ok(initial.fields[0].formatting.groups.some(group => group.kind === 'toc_semantic_style' && group.role === 'title'));
  assert.ok(initial.fields[0].formatting.groups.some(group => group.kind === 'toc_character_override' && group.role === 'title'));
  const proposal = await safeCall(connection, 'propose_safe_toc_refresh', { doc_id: docId, inspection_id: initial.inspection_id,
    apply_styles: true, styles, reason: '실험에서 명시한 실제 차례 역할 스타일로 출력 서식을 복구' });
  assert.equal(proposal.status, 'pending');
  const pending = await HwpxDoc.load(runtime.service.store.currentBytes(docId));
  assert.equal(pending.inspectFormatting(titleRef).styleId, '0');
  await safeCall(connection, 'apply_proposal', { doc_id: docId, proposal_id: proposal.pid });
  const after = await retain('toc-after', runtime.service.store.currentBytes(docId));
  const final = await safeCall(connection, 'inspect_toc', { doc_id: docId, toc_styles: styles });
  assert.deepEqual(nonTocText(after.doc), nonTocText(before.doc));
  const fullTextPreserved = JSON.stringify(flatText(after.doc)) === JSON.stringify(flatText(before.doc));
  const catalog = after.doc.formattingCatalog(), roleKeys = { head: 'title', l1: 'level1', l2: 'level2', l3: 'level3', item: 'captions' };
  const roleChecks = tocRefs(after.doc).map(ref => {
    const role = roleKeys[tocRole(after.doc.text(ref))]; if (!role) return null;
    const style = catalog.styles.find(s => s.name === styles[role]), current = after.doc.inspectFormatting(ref);
    assert.equal(current.styleId, style.id, `${ref}: persisted TOC role style`);
    return { ref, role, expectedStyleId: style.id, actualStyleId: current.styleId };
  }).filter(Boolean);
  const newTitleRef = tocRefs(after.doc).find(ref => after.doc.text(ref).includes('제목 차례'));
  const titleStyle = catalog.styles.find(s => s.name === styles.title), title = after.doc.inspectFormatting(newTitleRef);
  assert.equal(title.paraPrId, titleStyle.paraPrId); assert.ok(title.runs.every(run => run.charPrId === titleStyle.charPrId));
  return { id: 'toc_output_style_and_direct_overrides', status: 'passed', source: 'controlled TOC fixture; deliberately corrupted title style and overrides',
    before: before.artifact, after: after.artifact, beforeAudit: tocSummary(initial), afterAudit: tocSummary(final),
    receipt: { pid: proposal.pid, initialStatus: proposal.status, finalStatus: runtime.service._meta(docId).proposals.find(p => p.pid === proposal.pid).status },
    verification: { pendingDidNotApply: true, bodyTextPreserved: true, fullTextPreserved,
      expectedGeneratedChanges: 'TOC entry text and page numbers may be recomputed; all text outside TOC fields is preserved.',
      fullTextSha256: digest(JSON.stringify(flatText(after.doc))), bodyTextSha256: digest(JSON.stringify(nonTocText(after.doc))),
      roleChecks, titleParagraphMatchesStyle: true, titleCharactersMatchStyle: true, savedPackageReopened: true } };
}

export async function runFormattingExperiment() {
  await fs.mkdir(artifactDir, { recursive: true });
  const relative = path.relative(await fs.realpath(labRoot), await fs.realpath(artifactDir));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact path must remain inside the laboratory.');
  const runtime = createLabRuntime(); let connection;
  const report = { version: 1, execution: 'real MCP gateway calls with deterministic inputs and persisted HWPX re-open checks',
    paidApiCalls: 0, modelReasoningEvaluated: false, modelTokens: null, measurement: 'serialized request/result bytes and file bytes; no invented token estimate', scenarios: [] };
  try {
    connection = await createLabConnection(runtime, { profile: 'focused' });
    await safeCall(connection, 'enable_tools', { groups: ['formatting', 'toc', 'workflow'] });
    await connection.client.listTools();
    for (const [id, scenario] of [['heading_role_and_direct_overrides', headingScenario], ['toc_output_style_and_direct_overrides', tocScenario]]) {
      const start = connection.metrics.snapshot().records.length;
      try { report.scenarios.push(await scenario(runtime, connection)); }
      catch (e) { report.scenarios.push({ id, status: 'failed', error: { code: e.code || e.name, message: e.message } }); }
      report.scenarios.at(-1).calls = connection.metrics.snapshot().records.slice(start).filter(record => record.kind === 'tools/call');
    }
    report.passed = report.scenarios.every(scenario => scenario.status === 'passed');
    report.metrics = connection.metrics.snapshot();
    const calls = report.metrics.records.filter(record => record.kind === 'tools/call');
    report.counters = { toolCalls: calls.length, serializedArgumentBytes: calls.reduce((n, item) => n + item.inputBytes, 0),
      serializedResultBytes: calls.reduce((n, item) => n + item.resultBytes, 0), imageBlocks: calls.reduce((n, item) => n + item.imageBlocks, 0) };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!report.passed) throw Object.assign(new Error('Formatting experiment failed; see retained report.'), { report });
    return { ...report, path: reportPath };
  } finally { await connection?.close(); await runtime.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = await runFormattingExperiment();
    console.log(JSON.stringify({ passed: report.passed, report: report.path, scenarios: report.scenarios.map(s => ({ id: s.id, status: s.status })), counters: report.counters }, null, 2));
  } catch (error) { console.error(JSON.stringify({ error: error.message, failed: error.report?.scenarios.filter(s => s.status === 'failed') }, null, 2)); process.exitCode = 1; }
}
