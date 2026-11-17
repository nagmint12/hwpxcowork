// 실험 편집의 허용 동작. 모델은 XML/엔진 메서드 이름을 실행하지 않고 이 목록의 타입 검사만 통과한다.
import { z } from 'zod';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { listFields } from '../engine/fields.js';
import { EngineError } from '../engine/errors.js';
import { docBytesSync, containerFromBytesSync, tocRegions } from '../engine/toc.js';
import { importFormattingRefs, defineStyle, copyStyleDefinitionsFromSync } from '../engine/formatting.js';
import { editorEngine } from './toc-engine.js';
import { FormatSchema } from './format-schema.js';
import { TableOpSchema } from './table-schema.js';
import { PageLayoutOpSchema } from './page-layout-schema.js';
import { NativeChartSchema, ChartTableSourceSchema } from './native-chart.js';

const s = z.string(), ref = s.min(1), offset = z.number().int().min(0), reason = s.optional();
const object = shape => z.object(shape).strict();
const rich = { text: s };
const structureOps = ['delete_rows', 'delete_cols', 'insert_rows', 'insert_cols', 'merge', 'unmerge'];
const appearanceOps = ['border', 'fill', 'col_widths', 'row_height', 'cell_align', 'table'];
const structureOpSchema = TableOpSchema.extend({ op: z.enum(structureOps) });
const appearanceOpSchema = TableOpSchema.extend({ op: z.enum(appearanceOps) });
export const EDIT_OPERATIONS = Object.freeze({
  replace: { stage: 'content', schema: object({ ref: ref.optional(), table: ref.optional(), row: offset.optional(), col: offset.optional(), find: s, replace: s, occurrence: z.number().int().min(1).optional(), reason }) },
  insert: { stage: 'content', schema: object({ after_ref: ref, paragraphs: z.array(object(rich)).min(1).max(2000), reason }) },
  table: { stage: 'content', schema: object({ after_ref: ref, rows: z.array(z.array(s).min(1)).min(1), header_rows: offset.optional(), caption: s.optional(), reason }) },
  table_structure: { stage: 'content', schema: object({ table: ref, ops: z.array(structureOpSchema).min(1), reason }) },
  delete: { stage: 'content', schema: object({ ref, kinds: z.array(z.enum(['table', 'figure', 'shape', 'chart'])).optional(), reason }) },
  figure: { stage: 'content', schema: object({ after_ref: ref, attachment_id: s.optional(), svg: s.optional(), width_mm: z.number().positive().optional(), caption: s.optional(), reason }) },
  chart: { stage: 'content', schema: object({ after_ref: ref, chart: NativeChartSchema.partial({ categories: true, series: true }), source_table: ChartTableSourceSchema.optional(), width_mm: z.number().optional(), height_mm: z.number().optional(), reason }) },
  hyperlink: { stage: 'content', schema: object({ ref, start: offset, end: offset, uri: s.url(), reason }) },
  field: { stage: 'content', schema: object({ ref, offset, name: s.min(1).max(160), guide: s.max(2000).optional(), editable: z.boolean().optional(), reason }) },
  note: { stage: 'content', schema: object({ ref: ref.describe('각주·미주를 넣을 본문 문단 주소(표 셀/글상자 안은 현재 지원하지 않음)'), offset, kind: z.enum(['footnote', 'endnote']), text: s.min(1), reason }) },
  fill_field: { stage: 'content', schema: object({ name: s, occurrence: offset.optional(), value: s, reason }) },
  format: { stage: 'format', schema: object({ refs: z.array(ref).min(1).max(10000), style_name: s.optional(), format: FormatSchema.optional(), reason }) },
  table_edit: { stage: 'format', schema: object({ table: ref, ops: z.array(appearanceOpSchema).min(1), reason }) },
  page_layout: { stage: 'format', schema: object({ ops: z.array(PageLayoutOpSchema).min(1), reason }) },
  toc: { stage: 'format', schema: object({ ref: ref.optional(), create_if_missing: z.boolean().optional(), apply_styles: z.boolean().optional(), one_line: z.boolean().optional(), reason }) },
  import_styles: { stage: 'format', schema: object({ preset: z.literal('hwpx_standard'), reason }) },
  define_style: { stage: 'format', schema: object({ name: s.min(1).max(160), base_style: s.optional(), type: z.enum(['PARA', 'CHAR']).optional(), format: FormatSchema.optional(), reason }) },
});
export const OperationEnvelopeSchema = object({ op: s.min(1), args: z.record(s, z.unknown()) });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const documentEditHash = doc => sha(docBytesSync(doc));
export function editCapabilities(operations) {
  const names = operations?.length ? operations : Object.keys(EDIT_OPERATIONS);
  return names.map(op => {
    const entry = EDIT_OPERATIONS[op]; if (!entry) throw new EngineError('EDIT_OPERATION', `지원하지 않는 편집 동작: ${op}`);
    return { op, stage: entry.stage, ...(operations?.length ? { inputSchema: z.toJSONSchema(entry.schema) } : {}) };
  });
}
export function normalizeEditOperations(operations, stage) {
  if (!Array.isArray(operations) || operations.length > 2000 || JSON.stringify(operations).length > 4 * 1024 * 1024) throw new EngineError('EDIT_OPERATION', '편집 동작 수/크기를 확인하세요');
  return operations.map(input => {
    const envelope = OperationEnvelopeSchema.parse(input), entry = EDIT_OPERATIONS[envelope.op];
    if (!entry) throw new EngineError('EDIT_OPERATION', `지원하지 않는 편집 동작: ${envelope.op}`);
    if (stage && entry.stage !== stage) throw new EngineError('EDIT_STAGE', `${envelope.op}는 ${entry.stage} 단계 동작입니다`);
    const args = entry.schema.parse(envelope.args);
    return { op: envelope.op, args };
  });
}

/** 모델용 내용은 표의 글을 Markdown으로 한 번만 쓴다. 칸 ref/서식/XML은 요청할 때 별도로 읽는다. */
export function contentMarkdown(doc) {
  const tables = doc.tables(), byRef = new Map();
  for (const t of tables) { const list = byRef.get(t.ref) || []; list.push(t); byRef.set(t.ref, list); }
  const escape = text => String(text).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const tableRefs = new Set(tables.flatMap(t => [...t.cells.flatMap(c => c.refs), ...(t.caption ? [t.caption.ref] : [])]));
  for (const table of tables) for (const caption of doc._tableTarget(table.key).t.captionParas) tableRefs.add(caption.ref);
  const lines = [];
  const fields = listFields(doc);
  for (const p of doc.paragraphs({ view: 'final', nested: true })) {
    if (p.where === '메모') continue;
    if (!tableRefs.has(p.ref) && (p.text || p.where === '본문')) lines.push(`<!-- ${p.ref} -->\n${p.text}`);
    if (p.where === '본문') for (const object of doc.ownObjects(p.ref).filter(o => ['figure', 'chart'].includes(o.kind))) lines.push(`<!-- object ${object.kind}; ref ${p.ref} --> ${object.name || ''}`);
    for (const field of fields.filter(f => f.ref === p.ref)) lines.push(`<!-- field ${JSON.stringify(field.name)} occurrence ${field.occurrence}; ref ${p.ref}; guide ${JSON.stringify(field.guide)} -->`);
    for (const t of byRef.get(p.ref) || []) {
      lines.push(`<!-- table ${t.key}; ref ${t.ref}; ${t.rows}x${t.cols} -->`);
      if (t.caption?.text) lines.push(t.caption.text);
      const cells = new Map(t.cells.map(c => [`${c.row}/${c.col}`, c]));
      for (let r = 0; r < t.rows; r++) {
        lines.push('| ' + Array.from({ length: t.cols }, (_, c) => escape(cells.get(`${r}/${c}`)?.text || '')).join(' | ') + ' |');
        if (r === 0) lines.push('| ' + Array(t.cols).fill('---').join(' | ') + ' |');
      }
    }
  }
  return lines.join('\n\n');
}

/** 형식 단계의 본문 글 보존 검사. 메모와 새로 생성/갱신하는 차례 글은 제외한다. */
export function contentEditHash(doc) {
  const toc = tocRegions(doc);
  const texts = doc.paragraphs({ view: 'final', nested: true }).filter(p => p.where !== '메모' && p.text
    && (() => { let q = doc.resolve(p.ref).p; while (q) { if (['hp:header', 'hp:footer', 'hp:masterPage'].includes(q.container)) return false; q = q.parent; } return true; })()
    && !toc.some(t => p.section === t.sec && p.body != null && p.body >= t.start && p.body <= t.end))
    .map(p => [p.where, p.text]);
  return sha(JSON.stringify(texts));
}

let standard;
export function applyStyleOperation(doc, op, args) {
  if (op === 'define_style') return defineStyle(doc, { name: args.name, baseStyle: args.base_style, type: args.type, format: args.format });
  standard ||= new HwpxDoc(containerFromBytesSync(fs.readFileSync(new URL('./templates/blank.hwpx', import.meta.url))));
  return copyStyleDefinitionsFromSync(doc, standard);
}

/** 새 컨트롤만 WASM에서 만들고 원래 문단에는 그 조각만 넣는다. 전체 WASM export로 원문을 덮지 않는다. */
export function insertDocumentFeature(doc, op, args) {
  const { sec, p } = doc.resolve(args.ref), text = doc.text(args.ref), length = [...text].length;
  const start = op === 'hyperlink' ? args.start : args.offset, end = op === 'hyperlink' ? args.end : start;
  if (start > length || end > length || end < start || (op === 'hyperlink' && start === end)) throw new EngineError('RANGE', '문단의 코드포인트 범위를 확인하세요');
  const ctrls = Section.fieldCtrls(p);
  for (const a of ctrls.filter(a => a.inner === 'hp:fieldBegin')) {
    const b = ctrls.find(b => b.inner === 'hp:fieldEnd' && b.innerAttrs?.get('beginIDRef') === a.innerAttrs?.get('id'));
    const at = pos => Section.visibleChars(p, 'final').filter(c => p.chars.indexOf(c) < pos).length;
    if (b && (start < at(b.pos) && end > at(a.pos) || start === end && start > at(a.pos) && start < at(b.pos))) throw new EngineError('FIELD_OVERLAP', '기존 필드와 겹치는 범위입니다');
  }
  // 생성 전용 문단을 덧붙여 기존 본문/셀/글상자 주소와 변경 추적의 좌표 차이를 피한다.
  const seed = new HwpxDoc(containerFromBytesSync(docBytesSync(doc))); seed.acceptAll();
  let section, para;
  if (op === 'note') {
    const match = /^s(\d+)\/p(\d+)$/.exec(args.ref); if (!match) throw new EngineError('EDIT_TARGET', '각주·미주는 본문 문단에 넣어 주세요');
    section = +match[1]; para = +match[2];
  } else {
    section = seed.sections.length - 1; const after = seed.sections[section].bodyParas.length - 1;
    seed.insertParagraphAfter(section, after, text, { author: '편집 조각 생성' }); seed.acceptAll();
    para = seed.sections[section].bodyParas.length - 1;
  }
  const module = editorEngine(), engine = new module.HwpDocument(new Uint8Array(docBytesSync(seed)));
  let result, fieldId;
  try {
    if (op === 'hyperlink') fieldId = engine.insertHyperlinkEx(JSON.stringify({ target: { section, para, cellPath: [] }, start, end, uri: args.uri }));
    else if (op === 'field') { result = JSON.parse(engine.insertClickHereFieldEx(JSON.stringify({ sectionIdx: section, paraIdx: para, charOffset: start, guide: args.guide || '', name: args.name, editable: args.editable !== false }))); fieldId = result.fieldId; }
    else {
      result = JSON.parse(op === 'note' && args.kind === 'endnote' ? engine.insertEndnote(section, para, start) : engine.insertFootnote(section, para, start));
      engine.insertTextInFootnote(section, para, result.controlIdx, 0, 0, args.text);
    }
    const generated = new HwpxDoc(containerFromBytesSync(Buffer.from(engine.exportHwpx())));
    const target = generated.resolve(`s${section}/p${para}`);
    const anchors = target.p.anchors.filter(a => a.kind === 'ctrl');
    const begin = fieldId != null ? anchors.find(a => a.inner === 'hp:fieldBegin' && a.innerAttrs?.get('id') === String(fieldId))
      : anchors.find(a => a.inner === (args.kind === 'endnote' ? 'hp:endNote' : 'hp:footNote') && a.pos === start
        && a.innerAttrs?.get('number') === String(result.footnoteNumber ?? result.endnoteNumber));
    const finish = fieldId != null ? anchors.find(a => a.inner === 'hp:fieldEnd' && a.innerAttrs?.get('beginIDRef') === String(fieldId)) : null;
    if (!begin || fieldId != null && !finish) throw new EngineError('EDIT_ENGINE', '생성한 컨트롤을 확인하지 못했습니다');
    const fragment = a => a ? importFormattingRefs(doc, generated, target.sec.xml.slice(a.start, a.end)) : '';
    const children = p.children.map(c => sec.xml.slice(c.start, c.end));
    doc.insertControlFragment(args.ref, { start, end, beginXml: fragment(begin), endXml: fragment(finish) });
    const current = doc.resolve(args.ref); let next = 0;
    const mapping = children.map(xml => {
      for (; next < current.p.children.length; next++) { const c = current.p.children[next]; if (current.sec.xml.slice(c.start, c.end) === xml) return next++; }
      throw new EngineError('EDIT_PRESERVATION', '컨트롤 삽입 중 기존 중첩 문단이 달라졌습니다');
    });
    if (op === 'note') doc.syncNoteNumbersFrom(generated);
    return { ref: args.ref, ...(fieldId != null ? { fieldId } : { kind: args.kind }), nestedMapping: mapping };
  } finally { engine.free(); }
}
