// [hwpx-cowork] 서버의 차례(TABLEOFCONTENTS 필드) 다루기 — 차례 자리 찾기·차례 문단 바꿔 끼우기·차례 문단 역할(스타일 고르기).
// 차례를 다시 만드는 일(항목 모으기·쪽 번호)은 편집기 엔진(rhwp — vendor/rhwp/src/document_core/commands/toc.rs)이 한다 — server/toc-engine.js 가
// 이 문서의 HWPX 를 엔진에 넣어 새로 고친 뒤 차례 문단만 이 문서로 옮긴다(engine 쪽 서식 번호는 importFormattingRefs 로 이 문서 번호로).
import { Section } from './section.js';
import { HwpxContainer } from './container.js';
import { writeZipSync, readZipSync } from './zip-sync.js';
import { importFormattingRefs, characterShapeEdits, projectTextFormats } from './formatting.js';
import { decodeEntities, scan, attr, escapeAttr } from './xmlscan.js';

/** 구역의 최상위 물리 문단 [{ start, end, rec(본문 기록), k(기록 안 member 번호), last(기록의 마지막 member) }] — 편집기 엔진의 문단 번호와 같다 */
export function physicalParas(sec) {
  const out = [];
  for (const rec of sec.bodyParas) {
    const ms = Section.members(rec);
    ms.forEach((m, k) => out.push({ start: m.start, end: m.end, rec, k, last: k === ms.length - 1 }));
  }
  return out;
}

/**
 * 문서의 차례 목록 → [{ sec, start, end(물리 문단 번호 — 필드 시작·끝 문단), fieldId, command, startRef, endRef }].
 * 필드 끝을 못 찾은 차례는 뺀다
 */
export function tocRegions(doc) {
  const out = [];
  doc.sections.forEach((sec, si) => {
    const phys = physicalParas(sec);
    for (let i = 0; i < phys.length; i++) {
      const x = sec.xml.slice(phys[i].start, phys[i].end);
      const m = /<hp:fieldBegin\b[^>]*\btype="TABLEOFCONTENTS"[^>]*>/.exec(x);
      if (!m) continue;
      const fieldId = (/\bid="(\d+)"/.exec(m[0]) || [])[1];
      if (!fieldId) continue;
      const endRe = new RegExp(`<hp:fieldEnd\\b[^>]*\\bbeginIDRef="${fieldId}"`);
      let j = i;
      while (j < phys.length && !endRe.test(sec.xml.slice(phys[j].start, phys[j].end))) j++;
      if (j >= phys.length) continue;
      const cmd = /<hp:stringParam name="Command"[^>]*>([\s\S]*?)<\/hp:stringParam>/.exec(x);
      out.push({ sec: si, start: i, end: j, fieldId, command: cmd ? decodeEntities(cmd[1]) : '', startRef: phys[i].rec.ref, endRef: phys[j].rec.ref });
      i = j;
    }
  });
  return out;
}

/** 차례 자리의 XML(첫 문단 시작 ~ 마지막 문단 끝) */
export function regionXml(doc, reg) {
  const sec = doc.sections[reg.sec]; const phys = physicalParas(sec);
  return sec.xml.slice(phys[reg.start].start, phys[reg.end].end);
}

/** 차례 자리를 다른 문단 XML 로 바꿔 끼운다(구역을 다시 읽는다) */
export function replaceRegion(doc, reg, xml) {
  const sec = doc.sections[reg.sec]; const phys = physicalParas(sec);
  sec.load(sec.xml.slice(0, phys[reg.start].start) + xml + sec.xml.slice(phys[reg.end].end));
}

/** 이 문서의 지금 모습을 HWPX 바이트로(동기 — 무압축 ZIP). 편집기 엔진에 넣을 때 쓴다 */
export function docBytesSync(doc) {
  const files = new Map(doc.container.files);
  const enc = new TextEncoder();
  files.set('Contents/header.xml', enc.encode(doc.header.xml));
  doc.sections.forEach((s, i) => files.set(doc.sectionNames[i], enc.encode(s.xml)));
  return writeZipSync(new HwpxContainer(files, [...doc.container.order]));
}

/** HWPX 바이트 → 컨테이너(동기) */
export function containerFromBytesSync(bytes) { return readZipSync(bytes); }

/** 다른 문서(source — 편집기 엔진이 새로 고친 사본)의 차례 문단 XML 을 이 문서 서식 번호로 */
export function importRegionXml(doc, source, srcReg) {
  return importFormattingRefs(doc, source, regionXml(source, srcReg));
}

/**
 * 차례 문단 하나의 역할 — 한/글 표준서식 마무리(skill/hwpx-standard-report/scripts/hwpx_finalize.py)와 같은 규칙:
 * '<제목 차례>'·'<표 차례>'·'<그림 차례>'·'<수식 차례>' → head, 표·그림·수식 항목 → item, 장(1.·부록·제1장·I.) → l1, 절(1)·1.1) → l2,
 * 소절(가.·1.1.1·(1)) → l3, 빈 문단 → null. 항목 글은 탭 앞까지 본다
 */
export function tocRole(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/^<(제목|표|그림|수식)\s*차례>$/.test(t)) return 'head';
  const body = t.split('\t')[0].trim();
  if (/^[[<(]?\s*(표|그림|수식)\s*\d+/.test(body)) return 'item';
  if (/^(\d+\.(?!\d)|부록\.?|제\s*\d+\s*[장편부]|[IVX]+\.)(\s|$)/.test(body) || body === '부록') return 'l1';
  if (/^(\d+\)|\d+\.\d+\.?(?!\d)|제\s*\d+\s*절)(\s|$)/.test(body)) return 'l2';
  if (/^([가-하]\.|\d+\.\d+\.\d+\.?|\([가-하\d]+\)|[가-하]\))(\s|$)/.test(body)) return 'l3';
  return 'l1';
}

/** 차례 스타일 기본 이름(앞 것부터 찾는다 — 표준서식은 붙여 쓰고 한/글 기본은 띄어 쓴다) */
export const TOC_STYLE_NAMES = {
  title: ['차례제목', '차례 제목'], level1: ['차례1', '차례 1'], level2: ['차례2', '차례 2'], level3: ['차례3', '차례 3'],
};

const xmlAttr = (xml, key) => { const t = scan(xml).find(t => t.type === 'open' || t.type === 'selfclose'); return t && attr(xml, t, key); };
function setTocAttrs(tag, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) continue;
    const re = new RegExp(`\\s${key}="[^"]*"`); const valueXml = ` ${key}="${escapeAttr(String(value))}"`;
    tag = re.test(tag) ? tag.replace(re, () => valueXml) : tag.replace(/\/?>(?![\s\S])/, end => valueXml + end);
  }
  return tag;
}
const applyTocEdits = (xml, edits) => { for (const e of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, e.start) + e.text + xml.slice(e.end ?? e.start); return xml; };
function tocRows(xml) {
  const sec = new Section(`<hs:sec>${xml}</hs:sec>`, 0);
  return sec.bodyParas.map(p => {
    const text = Section.text(p); const x = sec.xml.slice(p.start, p.end);
    const tab = /<hp:tab\b[^>]*\/>/.exec(x)?.[0];
    const link = /<hp:stringParam\b[^>]*\bname="Command"[^>]*>\?#(\d+);0;(\d+);/.exec(x);
    return { sec, p, xml: x, text, body: text.split('\t')[0], role: tocRole(text), tab,
      key: link ? `${link[2]}:${link[1]}` : null,
      entry: !!tab && /\t[^\t\n]+$/.test(text),
      styleId: xmlAttr(x, 'styleIDRef'), paraPrId: xmlAttr(x, 'paraPrIDRef'),
      chars: Section.visibleChars(p).map(c => c.run?.charPr),
      charIds: [...new Set(p.runs.map(r => r.charPr))],
    };
  });
}
function namedTocStyle(doc, role) {
  const keys = { head: ['title'], l1: ['level1'], l2: ['level2', 'level1'], l3: ['level3', 'level2', 'level1'], item: ['level1'] };
  for (const key of keys[role] || []) for (const name of TOC_STYLE_NAMES[key]) {
    const s = doc.header.style({ name });
    if (s && doc.header.block('paraPr', s.paraPr) && doc.header.block('charPr', s.charPr)) return s;
  }
  return null;
}
function validRowFormat(doc, row) {
  return !!doc.header.block('style', row.styleId) && !!doc.header.block('paraPr', row.paraPrId)
    && row.charIds.every(id => !!doc.header.block('charPr', id));
}

/**
 * 새 차례를 원문 서식 번호로 가져온 뒤 기존 항목의 직접 서식을 보존한다.
 * 링크 대상/제목이 같은 항목 우선, 새 항목은 같은 역할의 기존 항목 또는 문서에 실제 정의된 차례 스타일을 쓴다.
 * 안내 문구(탭·쪽 번호 없는 일반 글)는 템플릿으로 쓰지 않는다. 원문 문단은 변경하지 않는다(헤더에는 가져온 정의만 추가).
 */
export function preserveTocFormatting(doc, beforeReg, source, srcReg) {
  const old = tocRows(regionXml(doc, beforeReg));
  const imported = importRegionXml(doc, source, srcReg); const rows = tocRows(imported);
  const receipt = { preserved: 0, inherited: 0, restored: 0, generated: 0 };
  const edits = [];
  for (const row of rows) {
    if (!row.role) continue;
    const candidates = old.filter(o => validRowFormat(doc, o) && (row.entry ? o.entry : o.role === 'head'));
    const same = candidates.find(o => row.key && o.key === row.key) || candidates.find(o => o.body === row.body);
    const template = same || candidates.find(o => o.role === row.role);
    const style = !template && namedTocStyle(doc, row.role);
    if (!template && !style) { receipt.generated++; continue; }
    receipt[same ? 'preserved' : template ? 'inherited' : 'restored']++;
    const p = row.p; const sec = row.sec; const t = sec.tokens[p.openTok];
    let paraPrId = template?.paraPrId ?? style.paraPr;
    // 이름으로 복구한 스타일에 탭 정의가 없으면 엔진이 만든 오른쪽 탭 정의만 이식한다.
    if (style && row.entry) {
      const pp = doc.header.block('paraPr', paraPrId); const tabId = xmlAttr(pp, 'tabPrIDRef');
      const tabDef = doc.header.block('tabPr', tabId) || '';
      if (!/type="RIGHT"|autoTabRight="1"/.test(tabDef)) {
        const generatedTab = xmlAttr(doc.header.block('paraPr', row.paraPrId), 'tabPrIDRef');
        if (doc.header.block('tabPr', generatedTab)) paraPrId = doc.header.addItem('paraProperties', 'paraPr', pp.replace(/^<hh:paraPr\b[^>]*>/, tag => setTocAttrs(tag, { tabPrIDRef: generatedTab })));
      }
    }
    const patch = { styleIDRef: template?.styleId ?? style.styleId, paraPrIDRef: paraPrId };
    if (same) for (const key of ['pageBreak', 'columnBreak']) patch[key] = xmlAttr(same.xml, key);
    const local = [{ start: t.start, end: t.end, text: setTocAttrs(sec.xml.slice(t.start, t.end), patch) }];
    const desired = template ? projectTextFormats(template.text, row.text,
      template.chars.map((charPrId, start) => ({ start, end: start + 1, charPrId })), template.chars[0]) : Array.from(row.text, () => style.charPr);
    local.push(...characterShapeEdits(sec, p, desired));
    let rewritten = applyTocEdits(row.xml, local.map(e => ({ ...e, start: e.start - p.start, end: (e.end ?? e.start) - p.start })));
    if (template?.tab && row.tab) rewritten = rewritten.replace(/<hp:tab\b[^>]*\/>/g, tab => setTocAttrs(tab, {
      leader: xmlAttr(template.tab, 'leader'), type: xmlAttr(template.tab, 'type'),
      ...(same?.text === row.text ? { width: xmlAttr(template.tab, 'width') } : {}),
    }));
    rewritten = rewritten.replace(/<hp:linesegarray\b[^>]*>[\s\S]*?<\/hp:linesegarray>/g, '');
    edits.push({ start: p.start - '<hs:sec>'.length, end: p.end - '<hs:sec>'.length, text: rewritten });
  }
  return { xml: applyTocEdits(imported, edits), receipt };
}

/** 구조·참조·탭 정렬을 실제 XML에서 검사한다. 화면/실제 인쇄 쪽수 검증을 대신하지 않는다. */
export function validateTocQuality(doc, reg, { expectedEntries = null, checkLinks = true } = {}) {
  const issues = []; const add = (code, paragraph) => { if (issues.length < 12) issues.push({ code, ...(paragraph == null ? {} : { paragraph }) }); };
  if (!reg) return { ok: false, paragraphs: 0, entries: 0, issues: [{ code: 'NO_TOC' }] };
  const xml = regionXml(doc, reg); const rows = tocRows(xml);
  const begin = [...xml.matchAll(/<hp:fieldBegin\b[^>]*\btype="TABLEOFCONTENTS"[^>]*>/g)];
  const fieldId = begin.length === 1 ? xmlAttr(begin[0][0], 'id') : null;
  if (!fieldId || [...xml.matchAll(/<hp:fieldEnd\b[^>]*>/g)].filter(m => xmlAttr(m[0], 'beginIDRef') === fieldId).length !== 1) add('FIELD_PAIR');
  const entries = rows.filter(r => r.entry).length;
  if (expectedEntries != null && entries !== expectedEntries) add('ENTRY_COUNT');
  const targets = new Set(checkLinks ? doc.sections.flatMap(s => [...s.xml.matchAll(/<hp:(?:p|tbl|pic|equation)\b[^>]*\bid="(\d+)"/g)].map(m => m[1])) : []);
  rows.forEach((row, i) => {
    if (!validRowFormat(doc, row)) add('FORMAT_REFERENCE', i);
    const pp = doc.header.block('paraPr', row.paraPrId); const tabId = pp && xmlAttr(pp, 'tabPrIDRef');
    const tab = tabId != null ? doc.header.block('tabPr', tabId) : null;
    if (tabId != null && !tab) add('TAB_REFERENCE', i);
    if (row.entry && (xmlAttr(row.tab, 'type') !== '2' || !/type="RIGHT"|autoTabRight="1"/.test(tab || ''))) add('PAGE_ALIGNMENT', i);
    if (row.entry && !/^\d+$/.test(xmlAttr(row.tab, 'leader') || '')) add('TAB_LEADER', i);
    if (checkLinks && row.key && !targets.has(row.key.split(':')[1])) add('LINK_TARGET', i);
  });
  return { ok: issues.length === 0, paragraphs: rows.length, entries, issues };
}
