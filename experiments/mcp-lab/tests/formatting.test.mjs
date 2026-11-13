import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../server/mcp.js';
import { HwpxDoc } from '../../../engine/doc.js';
import { tocRegions, physicalParas } from '../../../engine/toc.js';
import { createTocInEngine } from '../../../server/toc-engine.js';
import { createLabRuntime } from '../runtime.mjs';
import { createFormattingTools, parseTocCommand } from '../formatting.mjs';

const fixture = name => fs.readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url));
const json = reply => JSON.parse(reply.content.find(item => item.type === 'text').text);
const okay = reply => { assert.ok(!reply.isError, JSON.stringify(reply)); return json(reply); };
const errorCode = reply => { assert.equal(reply.isError, true); return json(reply).error; };
const textMap = doc => doc.paragraphs({ nested: true }).map(p => [p.ref, p.text]);

async function setup(t, prepare, source = 'tool_memo_tracked.hwpx') {
  const runtime = createLabRuntime();
  let server, client, extension;
  t.after(async () => { extension?.close(); await client?.close(); await server?.close(); await runtime.close(); });
  const doc = await (await HwpxDoc.load(fixture(source))).flattened();
  const extras = await prepare?.(doc) || {};
  const bytes = extras.bytes || await doc.save();
  const imported = await runtime.service.createDocument({ fileName: 'lab-format.hwpx', bytes, user: runtime.users.owner, location: { space: 'private' } });
  const docId = imported.id, user = runtime.users.owner;
  server = createMcpServer({ service: runtime.service, user, session: 'lab-format-test', agentName: 'MCP Lab' });
  client = new Client({ name: 'lab-format-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const calls = [];
  const callBase = async (name, args) => { calls.push({ name, args }); return client.callTool({ name, arguments: args }); };
  extension = createFormattingTools({ service: runtime.service, user, callBase });
  const call = (name, args = {}) => runtime.runExclusive(() => extension.tools.find(tool => tool.name === name).handler({ doc_id: docId, ...args }));
  return { ...runtime, ...extras, docId, call, callBase, calls, doc: () => runtime.service.store.doc(docId) };
}
async function inconsistent(doc) {
  for (const ref of ['s0/p1', 's0/p2']) doc.formatRange(ref, { start: 0, end: [...doc.text(ref)].length, styleId: '0' });
  const normal = doc.formattingCatalog().styles.find(s => s.id === '0');
  const headingId = doc.header.addItem('styles', 'style', `<hh:style id="0" type="PARA" name="Lab Heading" engName="LabHeading" paraPrIDRef="${normal.paraPrId}" charPrIDRef="${normal.charPrId}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`);
  doc.formatRange('s0/p2', { start: 0, end: [...doc.text('s0/p2')].length, char: { bold: !doc.inspectFormatting('s0/p2').runs[0].char.bold }, paragraph: { align: 'CENTER' } });
  return { headingId };
}

test('real HWPX audit distinguishes semantic heading style and direct overrides; batch proposals stay pending and applied postcheck is clean', async t => {
  const env = await setup(t, inconsistent), before = await env.doc(), originalText = textMap(before), unrelated = before.inspectFormatting('s0/p0');
  const args = { refs: ['s0/p1', 's0/p2'], roles: [{ role: 'section_heading', refs: ['s0/p1'], style: { id: env.headingId } }] };
  const audit = okay(await env.call('audit_formatting', args));
  assert.equal(audit.inspected, 2); assert.equal(audit.repairable, 2);
  assert.ok(audit.groups.some(g => g.kind === 'semantic_style' && g.role === 'section_heading'));
  assert.ok(audit.groups.some(g => g.kind === 'paragraph_override'));
  assert.ok(audit.groups.some(g => g.kind === 'character_override'));
  assert.equal(errorCode(await env.call('propose_format_normalization', { audit_id: audit.audit_id })), 'DIRECT_OVERRIDE_CONFIRMATION');
  assert.equal(env.calls.length, 0);
  const receipt = okay(await env.call('propose_format_normalization', { audit_id: audit.audit_id, reset_direct_overrides: true }));
  assert.equal(receipt.delegated_to, 'propose_changes'); assert.equal(receipt.results.length, 2);
  assert.ok(receipt.results.every(item => item.ok && item.status === 'pending'));
  assert.equal((await env.doc()).inspectFormatting('s0/p1').styleId, '0', 'manual proposal did not silently apply');
  assert.equal(errorCode(await env.call('propose_format_normalization', { audit_id: audit.audit_id, reset_direct_overrides: true })), 'AUDIT_SUBMITTED');
  for (const item of receipt.results) await env.runExclusive(() => env.service.applyProposal(env.docId, item.pid, env.users.owner));
  const after = await env.doc();
  assert.equal(after.inspectFormatting('s0/p1').styleId, env.headingId);
  assert.deepEqual(textMap(after), originalText, 'formatting did not rewrite paragraph text');
  assert.equal(after.inspectFormatting('s0/p0').fingerprint, unrelated.fingerprint, 'unrelated paragraph preserved');
  const check = okay(await env.call('audit_formatting', args)); assert.equal(check.mismatched, 0);
  const reopened = await HwpxDoc.load(await after.save());
  assert.equal(reopened.inspectFormatting('s0/p1').styleId, env.headingId);
  assert.equal(reopened.inspectFormatting('s0/p2').paragraph.align, reopened.formattingCatalog().paragraphProperties.find(p => p.id === reopened.formattingCatalog().styles.find(s => s.id === '0').paraPrId).props.align);
});

test('reference baselines, explicit mapping and missing/ambiguous styles never choose a majority', async t => {
  const env = await setup(t, async doc => {
    await inconsistent(doc);
    const xml = '<hh:style id="0" type="PARA" name="Duplicate" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0"/>';
    doc.header.addItem('styles', 'style', xml); doc.header.addItem('styles', 'style', xml.replace('name="Duplicate"', 'name="Duplicate" engName="Different"'));
  });
  let audit = okay(await env.call('audit_formatting', { refs: ['s0/p2'], expected_style: { name: 'Duplicate' } }));
  assert.equal(audit.repairable, 0); assert.equal(audit.groups[0].kind, 'AMBIGUOUS_STYLE');
  audit = okay(await env.call('audit_formatting', { refs: ['s0/p2'], roles: [{ role: 'heading', refs: ['s0/p2'], style: { name: 'Missing Heading' } }] }));
  assert.equal(audit.groups[0].kind, 'MISSING_STYLE');
  audit = okay(await env.call('audit_formatting', { refs: ['s0/p2'], reference_ref: 's0/p1' }));
  assert.ok(audit.repairable > 0);
  const receipt = okay(await env.call('propose_format_normalization', { expected_fingerprint: audit.fingerprint, mappings: [{ refs: ['s0/p2'], format: { paragraph: { align: 'RIGHT' } } }] }));
  assert.equal(env.service._meta(env.docId).proposals.find(p => p.pid === receipt.results[0].pid).format.paragraph.align, 'RIGHT');
  assert.ok(!Object.hasOwn(receipt.results[0], 'format') && !Object.hasOwn(receipt.results[0], 'proposal'), 'receipts do not echo detailed formatting');
});

for (const mutation of ['content', 'style_definition', 'version']) test(`stale ${mutation} is rejected before any base write`, async t => {
  const env = await setup(t, inconsistent);
  const audit = okay(await env.call('audit_formatting', { refs: ['s0/p2'] }));
  const doc = await env.doc(), beforeVersion = env.service._meta(env.docId).version;
  if (mutation === 'content') { doc.insertTracked('s0/p2', 0, 'changed ', { author: 'lab' }); doc.acceptAll(); }
  else if (mutation === 'style_definition') doc.header.xml = doc.header.xml.replace('name="Lab Heading"', 'name="Changed Heading"');
  else { const meta = env.service._meta(env.docId); meta.version++; env.service.store.saveMeta(meta); }
  if (mutation !== 'version') assert.equal(env.service._meta(env.docId).version, beforeVersion, 'hash catches changes even without a metadata version bump');
  assert.equal(errorCode(await env.call('propose_format_normalization', { audit_id: audit.audit_id, reset_direct_overrides: true })), 'STALE_AUDIT');
  assert.equal(env.calls.length, 0);
});

test('audit uses authenticated document access and validates explicit ranges', async t => {
  const env = await setup(t, inconsistent);
  const unauthorized = createFormattingTools({ service: env.service, user: env.users.other, callBase: env.callBase });
  const denied = await unauthorized.tools[0].handler({ doc_id: env.docId, refs: ['s0/p1'] });
  assert.equal(denied.isError, true); assert.equal(env.calls.length, 0); unauthorized.close();
  assert.equal(errorCode(await env.call('audit_formatting', {})), 'SCOPE_REQUIRED');
  assert.equal(errorCode(await env.call('audit_formatting', { range: { from: 2, to: 1 } })), 'RANGE');
  const valid = okay(await env.call('audit_formatting', { range: { from: 1, to: 3 } }));
  assert.equal(valid.inspected, 2);
});

test('TOC command parser honors UTF-16 style length and never infers collection styles', () => {
  const names = 'Heading 😀;본문;';
  const parsed = parseTocCommand(`TableOfContents:set:0:ContentsMake:uint:33 ContentsStyles:wstring:${names.length}:${names} ContentsLevel:int:3`);
  assert.deepEqual(parsed.collected_styles, ['Heading 😀', '본문']); assert.equal(parsed.outline, false); assert.equal(parsed.use_styles, true);
  assert.equal(parseTocCommand('unknown').recognized, false);
});

test('TOC inspection, pending prerequisite block, dedicated refresh and reopened field preserve body', async t => {
  const env = await setup(t, async doc => {
    const heading = doc.formattingCatalog().styles.find(s => s.name === '개요 1');
    assert.ok(heading);
    doc.insertParagraphAfter(0, 0, '', { author: 'lab' }); doc.acceptAll();
    const created = createTocInEngine(await doc.save(), { sec: 0, para: 1, collectStyles: [heading.name] });
    return { bytes: created.bytes, headingId: heading.id, headingName: heading.name };
  }, 'toc_source.hwpx');
  let current = await env.doc(), region = tocRegions(current)[0]; assert.ok(region);
  const refs = new Set(physicalParas(current.sections[region.sec]).slice(region.start, region.end + 1).map(p => p.rec.ref));
  const bodyBefore = current.paragraphs({ nested: false }).filter(p => !refs.has(p.ref)).map(p => p.text);
  const heading = current.paragraphs({ nested: false }).find(p => !refs.has(p.ref) && current.inspectFormatting(p.ref).styleId === env.headingId);
  assert.ok(heading);
  const inspected = okay(await env.call('inspect_toc', { heading_roles: [{ role: 'heading', refs: [heading.ref], style: { id: env.headingId } }] }));
  assert.equal(inspected.fields.length, 1); assert.ok(inspected.fields[0].options.collected_styles.includes(env.headingName));
  const audit = okay(await env.call('audit_formatting', { refs: [region.startRef] }));
  assert.equal(audit.groups[0].kind, 'toc_dedicated_path'); assert.equal(audit.repairable, 0);
  const proposal = okay(await env.callBase('propose_format', { doc_id: env.docId, ref: heading.ref, find: heading.text, format: { char: { bold: true } } }));
  const withPending = okay(await env.call('inspect_toc'));
  assert.ok(withPending.pending_prerequisites.some(p => p.pid === proposal.pid));
  const beforeCount = env.calls.length;
  assert.equal(errorCode(await env.call('propose_safe_toc_refresh', { inspection_id: withPending.inspection_id, apply_now: true })), 'PENDING_PREREQUISITES');
  assert.equal(env.calls.length, beforeCount);
  await env.runExclusive(() => env.service.applyProposal(env.docId, proposal.pid, env.users.owner));
  const fresh = okay(await env.call('inspect_toc'));
  const refreshed = okay(await env.call('propose_safe_toc_refresh', { inspection_id: fresh.inspection_id, apply_now: false, prerequisite_pids: [proposal.pid] }));
  assert.equal(env.calls.at(-1).name, 'propose_toc_update'); assert.equal(refreshed.type, 'toc'); assert.equal(refreshed.status, 'pending');
  await env.runExclusive(() => env.service.applyProposal(env.docId, refreshed.pid, env.users.owner));
  current = await HwpxDoc.load(await (await env.doc()).save()); region = tocRegions(current)[0]; assert.ok(region);
  const newRefs = new Set(physicalParas(current.sections[region.sec]).slice(region.start, region.end + 1).map(p => p.rec.ref));
  assert.deepEqual(current.paragraphs({ nested: false }).filter(p => !newRefs.has(p.ref)).map(p => p.text), bodyBefore, 'refresh only replaces the TOC region');
});

test('TOC missing heading styles require correction and existing collection changes are explicit unsupported cases', async t => {
  const env = await setup(t, async doc => {
    doc.insertParagraphAfter(0, 0, '', { author: 'lab' }); doc.acceptAll();
    return { bytes: createTocInEngine(await doc.save(), { sec: 0, para: 1 }).bytes };
  }, 'toc_source.hwpx');
  const inspection = okay(await env.call('inspect_toc', { heading_roles: [{ role: 'heading', refs: ['s0/p0'], style: { name: 'absent' } }] }));
  assert.equal(inspection.heading_issues[0].kind, 'MISSING_STYLE');
  assert.equal(errorCode(await env.call('propose_safe_toc_refresh', { inspection_id: inspection.inspection_id })), 'HEADING_STYLE_UNRESOLVED');
  const clean = okay(await env.call('inspect_toc'));
  assert.equal(errorCode(await env.call('propose_safe_toc_refresh', { inspection_id: clean.inspection_id, collect_styles: ['개요 1'] })), 'EXISTING_TOC_SETTINGS_UNSUPPORTED');
});

test('all grouped refs remain retrievable through audit pagination', async t => {
  const env = await setup(t, doc => {
    for (const ref of ['s0/p1', 's0/p2']) {
      doc.formatRange(ref, { start: 0, end: [...doc.text(ref)].length, styleId: '0', paragraph: { align: 'RIGHT' } });
    }
  });
  const first = okay(await env.call('audit_formatting', { refs: ['s0/p1', 's0/p2'], components: ['paragraph'], max_refs_per_group: 1 }));
  const group = first.groups.find(g => g.kind === 'paragraph_override');
  assert.equal(group.count, 2); assert.equal(group.refs.length, 1); assert.equal(group.next_refs_from, 1);
  const next = okay(await env.call('audit_formatting', { audit_id: first.audit_id, group_ref_from: group.next_refs_from, max_refs_per_group: 1 }));
  assert.deepEqual([...group.refs, ...next.groups[0].refs].sort(), ['s0/p1', 's0/p2']);
});

test('corrupt TOC output style/direct overrides are detected, refreshed by exact mapping, and corrected in saved HWPX', async t => {
  const mapping = { title: '차례 제목', level1: '차례 1', level2: '차례 2', level3: '차례 3', captions: '차례 1' };
  const env = await setup(t, async doc => {
    doc.insertParagraphAfter(0, 0, '', { author: 'lab' }); doc.acceptAll();
    const created = createTocInEngine(await doc.save(), { sec: 0, para: 1 });
    const broken = await HwpxDoc.load(created.bytes), region = tocRegions(broken)[0];
    const head = physicalParas(broken.sections[region.sec]).slice(region.start, region.end + 1).map(p => p.rec.ref).find(ref => broken.text(ref).includes('제목 차례'));
    assert.ok(head);
    broken.formatRange(head, { start: 0, end: [...broken.text(head)].length, styleId: '0', paragraph: { align: 'CENTER' }, char: { sizePt: 31, bold: true } });
    return { bytes: await broken.save() };
  }, 'toc_source.hwpx');
  const before = okay(await env.call('inspect_toc', { toc_styles: mapping }));
  const findings = before.fields[0].formatting;
  assert.ok(findings.groups.some(g => g.kind === 'toc_semantic_style' && g.role === 'title'));
  assert.ok(findings.groups.some(g => g.kind === 'toc_character_override' && g.role === 'title'));
  const receipt = okay(await env.call('propose_safe_toc_refresh', { inspection_id: before.inspection_id, apply_styles: true, styles: mapping }));
  assert.equal(receipt.status, 'pending');
  assert.deepEqual(env.calls.at(-1).args.styles, mapping);
  await env.runExclusive(() => env.service.applyProposal(env.docId, receipt.pid, env.users.owner));
  const saved = await HwpxDoc.load(await (await env.doc()).save()), region = tocRegions(saved)[0];
  const head = physicalParas(saved.sections[region.sec]).slice(region.start, region.end + 1).map(p => p.rec.ref).find(ref => saved.text(ref).includes('제목 차례'));
  const style = saved.formattingCatalog().styles.find(s => s.name === mapping.title), actual = saved.inspectFormatting(head);
  assert.equal(actual.styleId, style.id);
  assert.ok(actual.runs.every(run => run.charPrId === style.charPrId), 'direct character overrides were reset to the declared TOC title style');
  assert.equal(actual.paraPrId, style.paraPrId);
  const after = okay(await env.call('inspect_toc', { toc_styles: mapping }));
  assert.ok(!after.fields[0].formatting.groups.some(g => g.kind === 'toc_semantic_style'));
  const canonical = okay(await env.call('inspect_toc', { use_canonical_styles: true }));
  assert.equal(canonical.fields[0].formatting.configured, true);
  assert.ok(!canonical.fields[0].formatting.mapping_issues.length);
});

for (const policy of ['auto', 'manual']) test(`single request deferred TOC follows inserted body and heading repair under ${policy} policy`, async t => {
  const env = await setup(t, doc => {
    const style = doc.formattingCatalog().styles.find(s => s.name === '개요 1');
    const paragraph = doc.paragraphs({ nested: false }).find(p => doc.inspectFormatting(p.ref).styleId === style.id);
    assert.ok(paragraph);
    doc.formatRange(paragraph.ref, { start: 0, end: [...paragraph.text].length, styleId: '0' });
    return { headingId: style.id, headingName: style.name, headingRef: paragraph.ref, headingText: paragraph.text };
  }, 'toc_source.hwpx');
  await env.service.patchSettings(env.docId, { aiApply: policy }, env.users.owner);
  const request = (await env.service.createRequest(env.docId, { kind: 'instruct', route: 'queue', target: { scope: 'document' }, instruction: '제목 스타일을 고치고 새 절과 본문을 작성한 다음 차례를 만듭니다.' }, env.users.owner)).request;
  const task = { doc_id: env.docId, request_id: request.rid, expected_attempt: request.attempt ?? 1 };
  okay(await env.callBase('start_request', task));
  const audit = okay(await env.call('audit_formatting', { refs: [env.headingRef], expected_style: { id: env.headingId } }));
  okay(await env.call('propose_format_normalization', { audit_id: audit.audit_id, request_id: request.rid, expected_attempt: task.expected_attempt, reset_direct_overrides: true }));
  const anchor = (await env.doc()).paragraphs({ nested: false }).at(-1).ref;
  okay(await env.callBase('propose_insert', { ...task, after_ref: anchor,
    paragraphs: [{ text: '복합 요청 새 절', format: { styleId: env.headingId } }, { text: '새 절의 실제 본문입니다.', format: { styleId: '0' } }] }));
  const prerequisites = env.service._meta(env.docId).proposals.filter(p => p.rid === request.rid && p.type !== 'toc');
  assert.ok(prerequisites.every(p => p.status === 'pending'));
  const inspection = okay(await env.call('inspect_toc', { heading_roles: [{ role: 'heading', refs: [env.headingRef], style: { id: env.headingId } }] }));
  assert.ok(inspection.heading_issues.some(issue => issue.kind === 'heading_wrong_style'));
  assert.equal(errorCode(await env.call('propose_safe_toc_refresh', { inspection_id: inspection.inspection_id, ...task,
    defer_until_applied: true, apply_now: true, prerequisite_pids: prerequisites.map(p => p.pid), create_if_missing: true })), 'DEFERRED_SCOPE_REQUIRED');
  const queued = okay(await env.call('propose_safe_toc_refresh', { inspection_id: inspection.inspection_id, ...task,
    defer_until_applied: true, prerequisite_pids: prerequisites.map(p => p.pid), create_if_missing: true,
    after_ref: 's0/p0', collect_styles: [env.headingName] }));
  assert.equal(queued.deferred, true); assert.equal(queued.refreshed, false); assert.equal(queued.status, 'pending');
  assert.equal(tocRegions(await env.doc()).length, 0, 'queuing did not claim to create a TOC');
  okay(await env.callBase('complete_request', { ...task, summary: '본문·제목 스타일·차례 제안을 저장했습니다.', execution: 'deterministic' }));
  const completed = env.service._meta(env.docId).proposals.filter(p => p.rid === request.rid);
  if (policy === 'manual') {
    assert.ok(completed.every(p => p.status === 'pending')); assert.equal(tocRegions(await env.doc()).length, 0);
    for (const p of completed.filter(p => p.type !== 'toc')) okay(await env.callBase('apply_proposal', { doc_id: env.docId, proposal_id: p.pid }));
    okay(await env.callBase('apply_proposal', { doc_id: env.docId, proposal_id: queued.pid }));
  } else assert.ok(completed.every(p => p.status === 'applied'), JSON.stringify(completed.map(p => ({ type: p.type, status: p.status, error: p.autoApplyError }))));
  const reopened = await HwpxDoc.load(env.service.store.currentBytes(env.docId));
  const regions = tocRegions(reopened); assert.equal(regions.length, 1);
  const toc = regions[0], tocTexts = physicalParas(reopened.sections[toc.sec]).slice(toc.start, toc.end + 1).map(p => reopened.text(p.rec.ref));
  assert.ok(tocTexts.some(text => text.includes('복합 요청 새 절')), 'TOC collected the newly inserted heading after body application');
  assert.ok(tocTexts.some(text => text.includes(env.headingText)), 'TOC collected the heading after semantic style repair');
  const bodyHeading = reopened.paragraphs({ nested: false }).find(p => p.text === env.headingText);
  assert.equal(reopened.inspectFormatting(bodyHeading.ref).styleId, env.headingId);
  assert.ok(reopened.paragraphs().some(p => p.text === '새 절의 실제 본문입니다.'));
});
