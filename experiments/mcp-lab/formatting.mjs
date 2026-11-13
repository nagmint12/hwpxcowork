// Experimental only. Read the existing HWPX engine; write through authorized base MCP tools.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FormatSchema, normalizeFormat } from '../../server/format-schema.js';
import { tocRegions, physicalParas, tocRole, TOC_STYLE_NAMES } from '../../engine/toc.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const unpack = value => {
  if (value?.isError) return null;
  try { return JSON.parse(value.content?.find(item => item.type === 'text')?.text); } catch { return null; }
};
const styleSelector = z.object({ id: z.string().optional(), name: z.string().optional() }).strict();
const roleSchema = z.object({ role: z.string().min(1), refs: z.array(z.string()).min(1), style: styleSelector }).strict();
const scopeShape = {
  refs: z.array(z.string()).min(1).optional(),
  range: z.object({ section: z.number().int().nonnegative().default(0), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).strict().optional(),
};
const shared = { doc_id: z.string().min(1) };
const requestShape = { request_id: z.number().int().positive().optional(), expected_attempt: z.number().int().positive().optional() };
const components = z.array(z.enum(['style', 'paragraph', 'character'])).min(1).default(['style', 'paragraph', 'character']);
const auditSchema = z.object({ ...shared, ...scopeShape,
  audit_id: z.string().optional(), group_ref_from: z.number().int().nonnegative().default(0),
  reference_ref: z.string().optional(), expected_style: styleSelector.optional(),
  roles: z.array(roleSchema).optional(), components,
  max_refs_per_group: z.number().int().min(1).max(200).default(20),
}).strict();
const normalizationSchema = z.object({ ...shared, ...requestShape,
  audit_id: z.string().optional(), refs: z.array(z.string()).min(1).optional(),
  mappings: z.array(z.object({ refs: z.array(z.string()).min(1), format: FormatSchema }).strict()).min(1).optional(),
  expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reset_direct_overrides: z.boolean().default(false), reason: z.string().optional(),
}).strict();
const tocStyleSchema = z.object({ title: z.string().optional(), level1: z.string().optional(), level2: z.string().optional(), level3: z.string().optional(), captions: z.string().optional() }).strict();
const tocSchema = z.object({ ...shared, heading_roles: z.array(roleSchema).optional(),
  toc_styles: tocStyleSchema.optional(), use_canonical_styles: z.boolean().default(false),
}).strict();
const refreshSchema = z.object({ ...shared, ...requestShape,
  inspection_id: z.string(), toc_ref: z.string().optional(),
  defer_until_applied: z.boolean().default(false),
  apply_now: z.boolean().default(false), apply_styles: z.boolean().default(false), one_line: z.boolean().default(false),
  create_if_missing: z.boolean().default(false), after_ref: z.string().optional(),
  collect_styles: z.array(z.string()).optional(),
  styles: tocStyleSchema.optional(),
  prerequisite_pids: z.array(z.number().int().positive()).optional(), reason: z.string().optional(),
}).strict();

function resolveStyle(catalog, selector) {
  if (!selector || (selector.id == null && selector.name == null)) throw error('STYLE_REQUIRED', '스타일 id 또는 name을 명시하세요.');
  const styles = catalog.styles.filter(style => selector.id != null ? style.id === selector.id : style.name === selector.name);
  if (!styles.length) throw error('MISSING_STYLE', `문서에 요청한 스타일이 없습니다: ${selector.id ?? selector.name}`);
  if (styles.length !== 1) throw error('AMBIGUOUS_STYLE', '같은 이름/ID의 스타일이 여럿입니다. 고유한 스타일 ID를 지정하세요.');
  const style = styles[0];
  if (selector.name != null && style.name !== selector.name) throw error('STYLE_SELECTOR_CONFLICT', '스타일 ID와 이름이 일치하지 않습니다.');
  if (['CHAR', 'CHARACTER'].includes(style.type)) throw error('NOT_PARAGRAPH_STYLE', '문단 역할에는 문단 스타일을 지정하세요.');
  if (!catalog.paragraphProperties.some(item => item.id === style.paraPrId) || !catalog.charProperties.some(item => item.id === style.charPrId)) {
    throw error('BROKEN_STYLE', '스타일이 없는 문단/글자모양을 참조합니다. 먼저 스타일 정의를 복구해야 합니다.');
  }
  return style;
}
function definition(doc, kind, id) {
  const xml = doc.header.block(kind, id);
  if (!xml) throw error('MISSING_DEFINITION', `${kind}=${id} 정의가 없습니다.`);
  // Preserve unparsed tabs/borders/numbering; only the definition's own numeric ID is immaterial.
  return xml.replace(/^(<[^>]*?)\s+id="[^"]*"/, '$1').replace(/>\s+</g, '><');
}
const differences = (have, want) => [...new Set([...Object.keys(have || {}), ...Object.keys(want || {})])]
  .filter(key => canonical(have?.[key]) !== canonical(want?.[key]));
function inToc(doc, ref, regions) {
  for (const region of regions) {
    const refs = physicalParas(doc.sections[region.sec]).slice(region.start, region.end + 1).map(item => item.rec.ref);
    if (refs.some(item => ref === item || ref.startsWith(`${item}/`))) return true;
  }
  return false;
}
function documentFingerprint(doc) {
  return hash(canonical({ header: doc.header.xml, sections: doc.sections.map(section => section.xml) }));
}
function scopeRefs(doc, args) {
  if (args.refs && args.range) throw error('SCOPE_CONFLICT', 'refs 또는 range 중 하나만 사용하세요.');
  if (args.range && args.range.to <= args.range.from) throw error('RANGE', 'range.to는 from보다 커야 합니다(to는 제외).');
  if (args.refs) return [...new Set(args.refs)];
  if (args.range) return doc.paragraphs({ nested: true, view: 'final' }).filter(item => {
    const match = /^s(\d+)\/p(\d+)/.exec(item.ref);
    return match && Number(match[1]) === args.range.section && Number(match[2]) >= args.range.from && Number(match[2]) < args.range.to;
  }).map(item => item.ref);
  if (args.roles?.length) return [...new Set(args.roles.flatMap(role => role.refs))];
  throw error('SCOPE_REQUIRED', '검사할 refs, range 또는 역할별 refs를 명시하세요.');
}
function groupFindings(findings, limit, from = 0) {
  const groups = new Map();
  for (const finding of findings) {
    const { ref, ...details } = finding, key = canonical(details);
    if (!groups.has(key)) groups.set(key, { ...details, count: 0, refs: [] });
    const group = groups.get(key); group.count++;
    if (group.count > from && group.refs.length < limit) group.refs.push(ref);
  }
  return [...groups.values()].map(group => ({ ...group, refs_from: from,
    ...(group.count > group.refs.length ? { refs_omitted: group.count - group.refs.length } : {}),
    ...(group.count > from + group.refs.length ? { next_refs_from: from + group.refs.length } : {}) }));
}
function collectAudit(doc, meta, args) {
  const catalog = doc.formattingCatalog(), refs = scopeRefs(doc, args), regions = tocRegions(doc), findings = [], plans = [], roles = new Map();
  for (const role of args.roles || []) for (const ref of role.refs) {
    if (!refs.includes(ref)) throw error('ROLE_OUTSIDE_SCOPE', `역할 주소가 검사 범위 밖입니다: ${ref}`);
    if (roles.has(ref)) throw error('ROLE_CONFLICT', `문단에 역할이 중복 지정되었습니다: ${ref}`);
    roles.set(ref, role);
  }
  if (args.reference_ref && args.expected_style) throw error('BASELINE_CONFLICT', 'reference_ref와 expected_style 중 하나를 선택하세요.');
  const reference = args.reference_ref ? doc.inspectFormatting(args.reference_ref) : null;
  if (reference && args.components.includes('character') && new Set(reference.runs.map(run => definition(doc, 'charPr', run.charPrId))).size > 1) {
    throw error('MIXED_REFERENCE', '기준 문단에 서로 다른 글자모양이 있습니다. 문자 구간 복사를 추측하지 않습니다. components에서 character를 빼거나 명시적 mappings를 사용하세요.');
  }
  for (const ref of refs) {
    if (inToc(doc, ref, regions)) { findings.push({ ref, kind: 'toc_dedicated_path', remedy: 'inspect_toc → propose_safe_toc_refresh' }); continue; }
    const current = doc.inspectFormatting(ref), role = roles.get(ref);
    const selector = role?.style || args.expected_style || (reference ? { id: reference.styleId } : { id: current.styleId });
    let style;
    try { style = resolveStyle(catalog, selector); }
    catch (e) { findings.push({ ref, kind: e.code, expected: selector, ...(role ? { role: role.role } : {}), remedy: '명시적 스타일 ID/정의를 확인하세요.' }); continue; }
    const source = reference && !role && !args.expected_style ? reference : null;
    const wantedPara = source?.paraPrId ?? style.paraPrId;
    const wantedChar = source ? source.runs[0]?.charPrId ?? source.emptyCharPrId : style.charPrId;
    const format = {}, issues = [], semanticMismatch = args.components.includes('style') && current.styleId !== style.id;
    if (semanticMismatch) { issues.push({ kind: 'semantic_style', actual: current.styleId, expected: style.id, name: style.name, ...(role ? { role: role.role } : {}) }); format.styleId = style.id; }
    const paraProps = catalog.paragraphProperties.find(item => item.id === wantedPara)?.props;
    const charProps = catalog.charProperties.find(item => item.id === wantedChar)?.props;
    if (args.components.includes('paragraph') && definition(doc, 'paraPr', current.paraPrId) !== definition(doc, 'paraPr', wantedPara)) {
      const fields = differences(current.paragraph, paraProps);
      issues.push({ kind: 'paragraph_override', actual: current.paraPrId, expected: wantedPara, fields: fields.length ? fields : ['unparsed_definition'] });
      format.paraPrId = wantedPara;
    }
    const runs = current.runs.length ? current.runs : [{ charPrId: current.emptyCharPrId, char: catalog.charProperties.find(item => item.id === current.emptyCharPrId)?.props }];
    const changedRuns = args.components.includes('character') ? runs.filter(run => definition(doc, 'charPr', run.charPrId) !== definition(doc, 'charPr', wantedChar)) : [];
    if (changedRuns.length) {
      const fields = [...new Set(changedRuns.flatMap(run => differences(run.char, charProps)))];
      issues.push({ kind: 'character_override', expected: wantedChar, actual: [...new Set(changedRuns.map(run => run.charPrId))], fields: fields.length ? fields : ['unparsed_definition'] });
      format.charPrId = wantedChar;
    }
    if (issues.length) {
      findings.push(...issues.map(issue => ({ ref, ...issue })));
      // A style assignment resets its paragraph/character bases. Preserve components the caller excluded.
      if (semanticMismatch) {
        if (!args.components.includes('paragraph')) format.paraPrId = current.paraPrId;
        if (!args.components.includes('character')) {
          if (new Set(runs.map(run => run.charPrId)).size > 1) {
            findings.push({ ref, kind: 'mixed_character_preservation', remedy: '문자 구간을 보존하는 명시적 별도 제안이 필요합니다.' });
            continue;
          }
          format.charPrId = runs[0].charPrId;
        }
      }
      plans.push({ ref, find: current.text, type: 'format', format,
        direct: changedRuns.length > 0 || 'paraPrId' in format, implicit: !role && !args.expected_style && !reference });
    }
  }
  return { doc_id: args.doc_id, version: meta.version, fingerprint: documentFingerprint(doc), refs, plans, findings,
    summary: { inspected: refs.length, mismatched: new Set(findings.map(item => item.ref)).size, repairable: plans.length },
    groups: groupFindings(findings, args.max_refs_per_group, args.group_ref_from),
    note: '직접 서식 차이는 의도적인 강조일 수도 있습니다. 다수결로 기준을 추정하지 않으며 차례 영역은 전용 경로를 사용합니다.' };
}

// ContentsStyles length is UTF-16 code units, matching JS slice and Hancom's field format.
export function parseTocCommand(command) {
  const bits = /ContentsMake:uint:(\d+)/.exec(command), styles = /ContentsStyles:wstring:(\d+):/.exec(command);
  if (!command.includes('TableOfContents') || !bits) return { recognized: false, collected_styles: [] };
  const mask = Number(bits[1]);
  return { recognized: true, title: !!(mask & 1), outline: !!(mask & 16), use_styles: !!(mask & 32),
    table: !!(mask & 2), picture: !!(mask & 4), equation: !!(mask & 8),
    collected_styles: styles ? command.slice(styles.index + styles[0].length, styles.index + styles[0].length + Number(styles[1])).split(';').map(s => s.trim()).filter(Boolean) : [],
    level: Number(/ContentsLevel:int:(\d+)/.exec(command)?.[1] ?? 2) };
}
function inspectToc(doc, meta, args) {
  const catalog = doc.formattingCatalog(), regions = tocRegions(doc), headingIssues = [];
  for (const role of args.heading_roles || []) {
    let style;
    try { style = resolveStyle(catalog, role.style); }
    catch (e) { headingIssues.push({ kind: e.code, role: role.role, expected: role.style, refs: role.refs }); continue; }
    for (const ref of role.refs) {
      const current = doc.inspectFormatting(ref);
      if (current.styleId !== style.id) headingIssues.push({ kind: 'heading_wrong_style', role: role.role, ref, actual: current.styleId, expected: style.id, name: style.name });
    }
  }
  const fields = regions.map(region => {
    const options = parseTocCommand(region.command);
    const missingStyles = [], ambiguousStyles = [];
    for (const name of options.collected_styles) {
      const found = catalog.styles.filter(s => s.name === name && !['CHAR', 'CHARACTER'].includes(s.type));
      if (!found.length) missingStyles.push(name);
      if (found.length > 1) ambiguousStyles.push(name);
    }
    const headingStyles = [...new Set((args.heading_roles || []).flatMap(role => {
      try { return [resolveStyle(catalog, role.style).name]; } catch { return []; }
    }))];
    const notCollected = options.use_styles ? headingStyles.filter(name => !options.collected_styles.includes(name)) : headingStyles;
    const formatting = tocFormatting(doc, region, catalog, args);
    return { field_id: region.fieldId, start_ref: region.startRef, end_ref: region.endRef,
      options, missing_styles: missingStyles, ambiguous_styles: ambiguousStyles, heading_styles_not_collected_by_style: notCollected,
      formatting,
      // Outline collection can independently include a heading; absence from style list is not a proven missing TOC entry.
      remedy: !options.recognized ? '차례 필드 설정을 해석할 수 없어 안전한 자동 갱신을 중단합니다.'
        : missingStyles.length || ambiguousStyles.length || notCollected.length ? '제목의 역할 스타일과 차례 수집 설정을 확인하세요. 기존 차례 수집 설정 변경은 기본 도구가 지원하지 않아 자동으로 바꾸지 않습니다.'
          : '본문·제목 스타일 제안을 반영한 뒤 기존 차례 전용 갱신을 제안할 수 있습니다.' };
  });
  const pending = (meta.proposals || []).filter(p => p.status === 'pending' && p.type !== 'toc').map(p => ({ pid: p.pid, type: p.type, ref: p.ref }));
  return { doc_id: args.doc_id, version: meta.version, fingerprint: documentFingerprint(doc), fields,
    heading_issues: headingIssues, pending_prerequisites: pending,
    remedy: !fields.length ? '차례 필드가 없습니다. 실제 제목 스타일을 지정한 create_if_missing 제안을 만들 수 있습니다.'
      : headingIssues.length ? '먼저 audit_formatting의 명시적 역할 매핑으로 제목 스타일을 교정하고 반영한 뒤 다시 검사하세요.'
        : pending.length ? '미반영 본문/서식 제안이 있습니다. 현재 문서 차례와 앞으로 반영할 문서를 구분하세요.' : 'propose_safe_toc_refresh로 전용 갱신을 제안하세요.' };
}

function tocFormatting(doc, region, catalog, args) {
  const mapping = {}, mappingIssues = [], findings = [];
  const requested = args.toc_styles || {};
  const roleKeys = { head: 'title', l1: 'level1', l2: 'level2', l3: 'level3', item: 'captions' };
  const paragraphs = physicalParas(doc.sections[region.sec]).slice(region.start, region.end + 1);
  const usedRoles = [...new Set(paragraphs.map(item => roleKeys[tocRole(doc.text(item.rec.ref))]).filter(Boolean))];
  for (const role of usedRoles) {
    let selector = requested[role];
    if (!selector && role === 'captions') selector = requested.level1; // Same documented captions→level1 mapping as base tool.
    if (!selector && args.use_canonical_styles) {
      const names = TOC_STYLE_NAMES[role === 'captions' ? 'level1' : role] || [];
      const matches = catalog.styles.filter(s => names.includes(s.name) && !['CHAR', 'CHARACTER'].includes(s.type));
      if (matches.length !== 1) {
        mappingIssues.push({ role, kind: matches.length ? 'AMBIGUOUS_STYLE' : 'MISSING_STYLE', candidates: names }); continue;
      }
      selector = matches[0].name;
    }
    if (!selector) { mappingIssues.push({ role, kind: 'TOC_STYLE_NOT_CONFIGURED' }); continue; }
    try { mapping[role] = resolveStyle(catalog, { name: selector }); }
    catch (e) { mappingIssues.push({ role, kind: e.code, expected: selector }); }
  }
  for (const item of paragraphs) {
    const ref = item.rec.ref, role = roleKeys[tocRole(doc.text(ref))], expected = mapping[role];
    if (!expected) continue;
    const current = doc.inspectFormatting(ref);
    if (current.styleId !== expected.id) findings.push({ ref, role, kind: 'toc_semantic_style', actual: current.styleId, expected: expected.id, name: expected.name });
    if (definition(doc, 'paraPr', current.paraPrId) !== definition(doc, 'paraPr', expected.paraPrId)) findings.push({ ref, role, kind: 'toc_paragraph_override', actual: current.paraPrId, expected: expected.paraPrId });
    const ids = current.runs.length ? [...new Set(current.runs.map(run => run.charPrId))] : [current.emptyCharPrId];
    const drift = ids.filter(id => definition(doc, 'charPr', id) !== definition(doc, 'charPr', expected.charPrId));
    if (drift.length) findings.push({ ref, role, kind: 'toc_character_override', actual: drift, expected: expected.charPrId });
  }
  return { configured: !!args.toc_styles || args.use_canonical_styles,
    resolved_styles: Object.fromEntries(Object.entries(mapping).map(([role, style]) => [role, style.name])),
    mapping_issues: mappingIssues, mismatched: new Set(findings.map(item => item.ref)).size,
    groups: groupFindings(findings, 20),
    remedy: findings.length ? 'propose_safe_toc_refresh(apply_styles=true, styles=검사한 실제 스타일 이름)로 차례 영역만 갱신합니다. 직접 서식 초기화가 포함됩니다.'
      : !args.toc_styles && !args.use_canonical_styles ? '차례 출력 서식을 검사하려면 toc_styles 또는 use_canonical_styles=true를 명시하세요.' : '검사한 차례 역할 스타일과 직접 서식 기준을 충족합니다.' };
}

/** Caller serializes this handler and all base writes (runtime.runExclusive); callBase must not reacquire that lock. */
export function createFormattingTools({ service, user, callBase }) {
  const audits = new Map(), inspections = new Map();
  const read = async (docId, fn) => {
    service.assertDocRead(docId, user);
    return service._read(docId, async () => {
      const doc = await service.store.doc(docId), meta = service._meta(docId);
      if (!doc) throw error('NO_DOC', '문서가 없습니다.');
      return fn(doc, meta);
    });
  };
  const remember = (map, value) => {
    for (const [id, old] of map) if (Date.now() - old.created > 30 * 60 * 1000) map.delete(id);
    const id = randomUUID(); map.set(id, { ...value, created: Date.now() }); return id;
  };
  const retrieve = (map, id, docId) => {
    const item = map.get(id);
    if (!item || item.doc_id !== docId || Date.now() - item.created > 30 * 60 * 1000) throw error('AUDIT_NOT_FOUND', '같은 연결에서 이 문서를 다시 검사하세요(검사 결과 30분 유효).');
    return item;
  };
  const check = (doc, meta, item) => {
    if (meta.version !== item.version || documentFingerprint(doc) !== item.fingerprint) throw error('STALE_AUDIT', '검사 뒤 문서 내용·스타일·버전이 바뀌었습니다. 다시 검사하세요.');
  };
  function tool(name, description, schema, fn) {
    return { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }), handler: async input => {
      try { return await fn(schema.parse(input)); }
      catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.code || (e instanceof z.ZodError ? 'INVALID_INPUT' : 'FORMAT_FAILED'), message: e instanceof z.ZodError ? '입력 형식을 확인하세요.' : e.message }) }] }; }
    } };
  }
  const tools = [
    tool('audit_formatting', '지정 문단/범위의 의미 스타일과 직접 문단·글자 서식 차이를 그룹으로 검사. 기준 문단, 명시적 스타일/역할 매핑 또는 현재 스타일 정의를 사용하며 다수결로 추측하지 않음. 차례 영역은 별도 안내.', auditSchema, async args => {
      if (args.audit_id && (args.refs || args.range || args.roles || args.reference_ref || args.expected_style)) throw error('AUDIT_VIEW_CONFLICT', 'audit_id 조회에는 새 검사 범위를 함께 지정하지 마세요.');
      const audit = args.audit_id ? retrieve(audits, args.audit_id, args.doc_id) : await read(args.doc_id, (doc, meta) => collectAudit(doc, meta, args));
      if (args.audit_id) await read(args.doc_id, (doc, meta) => check(doc, meta, audit));
      const audit_id = args.audit_id || remember(audits, audit);
      return result({ audit_id, doc_id: audit.doc_id, version: audit.version, fingerprint: audit.fingerprint, ...audit.summary,
        groups: groupFindings(audit.findings, args.max_refs_per_group, args.group_ref_from), note: audit.note,
        pagination: '그룹의 next_refs_from을 group_ref_from으로 주고 같은 audit_id로 이어 읽습니다. 원문 범위/전체 교정 계획은 서버에 보존됩니다.' });
    }),
    tool('propose_format_normalization', '현재 검사 audit_id의 교정을 기존 propose_changes로 일괄 제안. 직접 서식 초기화는 reset_direct_overrides=true 명시 필요. 또는 명시적 mappings와 직전 fingerprint. 본문 직접 적용·스타일 생성·차례 수정은 하지 않음; 기존 문서 제안 정책 유지.', normalizationSchema, async args => {
      if (!!args.audit_id === !!args.mappings) throw error('PLAN_REQUIRED', 'audit_id 또는 mappings 중 하나를 지정하세요.');
      if (args.mappings && args.refs) throw error('SCOPE_CONFLICT', '명시적 매핑의 범위는 mappings[].refs에 지정하세요.');
      const audit = args.audit_id ? retrieve(audits, args.audit_id, args.doc_id) : null;
      if (audit?.submitted) throw error('AUDIT_SUBMITTED', '이미 제안을 제출한 검사입니다. 새 상태를 검사하세요.');
      const proposals = await read(args.doc_id, (doc, meta) => {
        const regions = tocRegions(doc);
        if (audit) {
          check(doc, meta, audit);
          if (args.refs?.some(ref => !audit.refs.includes(ref))) throw error('SCOPE_CONFLICT', '교정 주소가 검사 범위 밖입니다.');
          const plans = audit.plans.filter(p => !args.refs || args.refs.includes(p.ref));
          if (plans.some(p => p.direct) && !args.reset_direct_overrides) throw error('DIRECT_OVERRIDE_CONFIRMATION', '문단/글자 직접 서식을 초기화하려면 reset_direct_overrides=true를 명시하세요.');
          return plans.map(({ direct, implicit, ...proposal }) => ({ ...proposal, reason: args.reason || '명시된 기준과 검사 결과에 따른 서식 교정' }));
        }
        if (!args.expected_fingerprint || documentFingerprint(doc) !== args.expected_fingerprint) throw error('STALE_AUDIT', '명시적 매핑에는 최신 audit/inspect의 expected_fingerprint가 필요합니다.');
        const seen = new Set();
        return args.mappings.flatMap(mapping => mapping.refs.map(ref => {
          if (seen.has(ref)) throw error('MAPPING_CONFLICT', `교정 문단이 중복되었습니다: ${ref}`); seen.add(ref);
          if (inToc(doc, ref, regions)) throw error('TOC_DEDICATED_PATH', '차례 문단에는 전용 갱신 도구를 사용하세요.');
          const current = doc.inspectFormatting(ref), format = normalizeFormat(mapping.format);
          service._formatSpec(doc, format, { ref, start: 0, end: current.length });
          return { ref, find: current.text, type: 'format', format, reason: args.reason || '명시적 서식 매핑에 따른 교정' };
        }));
      });
      if (!proposals.length) return result({ changed: false, proposal_count: 0, note: '지정한 범위에 교정할 차이가 없습니다.' });
      const reply = await callBase('propose_changes', { doc_id: args.doc_id, proposals, ...requestArgs(args) });
      if (reply.isError) return reply;
      if (audit) audit.submitted = true;
      const saved = unpack(reply), entries = Array.isArray(saved) ? saved : saved?.results || [];
      const receipts = entries.map(entry => entry.ok && entry.proposal ? { ok: true, pid: entry.proposal.pid, status: entry.proposal.status, ref: entry.proposal.ref, type: entry.proposal.type }
        : { ok: false, ref: entry.item?.ref, error: entry.error || entry.message || '제안 결과 형식을 확인하세요.' });
      return result({ delegated_to: 'propose_changes', requested_count: proposals.length, results: receipts,
        succeeded: receipts.filter(item => item.ok).length, failed: receipts.filter(item => !item.ok).length,
        note: 'status=pending이면 본문은 아직 바뀌지 않았습니다. 기존 자동 반영 정책이면 applied일 수 있습니다. 반영 뒤 다시 검사하세요.' });
    }),
    tool('inspect_toc', '차례 필드의 실제 수집 스타일/개요 설정, 없는·중복 스타일, 명시적 제목 역할 스타일 불일치와 미반영 선행 제안을 검사. 문서 전체 XML은 반환하지 않음.', tocSchema, async args => {
      const inspection = await read(args.doc_id, (doc, meta) => inspectToc(doc, meta, args));
      const inspection_id = remember(inspections, inspection);
      return result({ inspection_id, ...inspection });
    }),
    tool('propose_safe_toc_refresh', '직전 차례 검사와 선행 제안을 확인 후 기존 propose_toc_update만 호출. 미반영 상태의 즉시 갱신 금지. 같은 요청의 검증된 선행 제안 뒤에 예약하려면 defer_until_applied=true, request_id/expected_attempt/prerequisite_pids 지정. 예약은 갱신 완료가 아니며 완료/승인 후 결과 확인 필수.', refreshSchema, async args => {
      const inspection = retrieve(inspections, args.inspection_id, args.doc_id);
      if (inspection.submitted) throw error('AUDIT_SUBMITTED', '이미 갱신 제안을 제출한 검사입니다. 다시 검사하세요.');
      let inspectedStyles, deferredPrerequisites = [];
      await read(args.doc_id, (doc, meta) => {
        check(doc, meta, inspection);
        const pending = (meta.proposals || []).filter(p => p.status === 'pending' && p.type !== 'toc');
        const prereqs = (args.prerequisite_pids || []).map(pid => (meta.proposals || []).find(p => p.pid === pid));
        if (prereqs.some(p => !p || !['pending', 'applied', 'accepted'].includes(p.status))) throw error('PREREQUISITE_UNRESOLVED', '선행 제안이 없거나 거절/취소 상태입니다.');
        if (args.defer_until_applied) {
          if (args.apply_now || args.request_id == null || args.expected_attempt == null || !prereqs.length) throw error('DEFERRED_SCOPE_REQUIRED', '예약은 apply_now=false와 request_id·expected_attempt·prerequisite_pids가 필요합니다.');
          const request = (meta.requests || []).find(r => r.rid === args.request_id);
          if (!request || (request.attempt ?? 1) !== args.expected_attempt || !['pending', 'working'].includes(request.status)) throw error('REQUEST_CLOSED', '예약할 요청/시도가 현재 열린 요청과 일치하지 않습니다.');
          if (prereqs.some(p => p.rid !== args.request_id || p.type === 'toc') || pending.some(p => p.rid !== args.request_id || !args.prerequisite_pids.includes(p.pid))) throw error('PREREQUISITE_SCOPE', '미반영 선행 제안은 모두 같은 요청에 속하고 prerequisite_pids에 포함되어야 합니다.');
          const unproved = inspection.heading_issues.some(issue => issue.kind !== 'heading_wrong_style' || !prereqs.some(p =>
            p.type === 'format' && p.ref === issue.ref && p.format?.styleId === issue.expected && p.start === 0 && p.end === [...doc.text(issue.ref)].length));
          if (unproved) throw error('HEADING_STYLE_UNRESOLVED', '제목 역할 불일치를 정확히 교정하는 같은 요청의 전체 문단 스타일 제안이 필요합니다.');
          deferredPrerequisites = prereqs.map(p => ({ pid: p.pid, type: p.type, status: p.status }));
        } else {
          if (inspection.heading_issues.length) throw error('HEADING_STYLE_UNRESOLVED', '제목의 역할 스타일 문제를 먼저 교정·반영한 뒤 다시 검사하세요.');
          if (pending.length || prereqs.some(p => p.status === 'pending')) throw error('PENDING_PREREQUISITES', '본문·제목 서식 선행 제안을 먼저 반영하거나 같은 요청의 defer_until_applied 예약을 명시하세요.');
        }
        const fields = inspection.fields;
        if (!fields.length && !args.create_if_missing) throw error('NO_TOC', '차례가 없으므로 create_if_missing을 명시해야 합니다.');
        if (fields.length > 1 && !args.toc_ref) throw error('AMBIGUOUS_TOC', '차례가 여러 개입니다. toc_ref를 지정하세요.');
        const region = args.toc_ref ? tocRegions(doc).find(r => inToc(doc, args.toc_ref, [r])) : tocRegions(doc)[0];
        if (args.toc_ref && !region) throw error('NO_TOC', 'toc_ref가 차례 필드 안에 있지 않습니다.');
        const selected = region ? fields.find(f => f.field_id === region.fieldId) : null;
        if (selected && (!selected.options.recognized || selected.missing_styles.length || selected.ambiguous_styles.length)) throw error('TOC_SETTINGS_UNRESOLVED', '차례 필드의 미해석/없는/중복 스타일 설정을 먼저 확인하세요.');
        if (fields.length && args.collect_styles) throw error('EXISTING_TOC_SETTINGS_UNSUPPORTED', '기존 차례의 수집 스타일 변경은 기본 도구에서 지원하지 않습니다. 새 차례 생성 옵션을 갱신 옵션처럼 적용하지 않습니다.');
        if (args.apply_styles || args.styles) {
          const map = args.styles || selected?.formatting?.resolved_styles;
          if (!map || !Object.keys(map).length) throw error('TOC_STYLE_MAPPING_REQUIRED', '차례에 적용할 실제 styles를 명시하거나 toc_styles로 먼저 검사하세요.');
          const formatting = region ? tocFormatting(doc, region, doc.formattingCatalog(), { toc_styles: map }) : null;
          if (formatting?.mapping_issues.length) throw error('TOC_STYLE_MAPPING_REQUIRED', '차례에 쓰인 모든 역할에 고유한 실제 스타일 이름을 지정하세요.');
          for (const name of Object.values(map)) resolveStyle(doc.formattingCatalog(), { name });
          inspectedStyles = map;
        }
        for (const name of args.collect_styles || []) resolveStyle(doc.formattingCatalog(), { name });
      });
      const { inspection_id, prerequisite_pids, defer_until_applied, ...forward } = args;
      const reply = await callBase('propose_toc_update', { ...forward, ...(inspectedStyles ? { styles: inspectedStyles } : {}) });
      if (!reply.isError) inspection.submitted = true;
      if (!reply.isError && defer_until_applied) {
        const proposal = unpack(reply);
        return result({ pid: proposal?.pid, type: proposal?.type, status: proposal?.status, deferred: true, refreshed: false,
          prerequisites: deferredPrerequisites, requires_postcheck: true,
          note: '같은 요청의 차례 제안을 저장했습니다. 자동 반영은 complete_request에서 본문·서식 뒤 차례 순서이며, 수동 정책이면 선행 제안을 먼저 승인해야 합니다. 완료 후 모든 선행/차례 제안의 applied 상태와 차례 내용을 확인하세요.' });
      }
      return reply;
    }),
  ];
  return { tools, close() { audits.clear(); inspections.clear(); } };
}
function requestArgs(args) {
  return { ...(args.request_id != null ? { request_id: args.request_id } : {}), ...(args.expected_attempt != null ? { expected_attempt: args.expected_attempt } : {}) };
}
