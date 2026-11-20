// Typed page editing, preserving unrelated XML and document text.
import crypto from 'node:crypto';
import { scan, attrs, escapeAttr, escapeText, decodeEntities } from './xmlscan.js';
import { Section } from './section.js';
import { imageInfo, pictureXml, MM, PX } from './picture.js';
import fs from 'node:fs';
import { docBytesSync, containerFromBytesSync } from './toc.js';
import { formatParagraphs, copyStyleDefinitionsFromSync, defineStyle, formattingCatalog, formattingTransaction, namedStyle, styleUsage, styleDefinitions, styleDependencies } from './formatting.js';
import { objectsToBody } from './flow.js';
import { layoutFingerprint } from './layout.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

/** objects_to_body 의 at → 본문 문단 ref 목록 | null(문서 전체) */
export function structureRefs(doc, at) {
  if (at == null || at === '*') return null;
  if (Array.isArray(at)) return at;
  const sec = /^s(\d+)$/.exec(at);
  if (!sec) return [at];
  const s = doc.sections[Number(sec[1])];
  if (!s) throw fail('NO_SECTION', `구역이 없습니다: ${at}`);
  return s.bodyParas.map((p) => p.ref);
}
/** 쪽 구성 ops 가운데 개체 → 본문이 기대는 개체 상태 지문(제안한 뒤 그 개체가 바뀌었는지 — 메모·글 서식은 보지 않는다) | null */
export function structureObjectsFingerprint(doc, ops) {
  const list = (ops || []).filter((op) => op.op === 'objects_to_body');
  if (!list.length) return null;
  return crypto.createHash('sha256').update(list.map((op) => layoutFingerprint(doc, structureRefs(doc, op.at))).join('|')).digest('hex');
}
export function elements(xml, name) {
  const out = [], stack = [];
  for (const t of scan(xml)) {
    if (t.name !== name) continue;
    if (t.type === 'selfclose') out.push({ start: t.start, end: t.end, xml: xml.slice(t.start, t.end), attrs: Object.fromEntries(attrs(xml, t)) });
    else if (t.type === 'open') stack.push(t);
    else if (t.type === 'close') {
      const open = stack.pop();
      if (open) out.push({ start: open.start, end: t.end, xml: xml.slice(open.start, t.end), attrs: Object.fromEntries(attrs(xml, open)) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
export function removeElements(xml, name, predicate = () => true) {
  const spans = elements(xml, name).filter(predicate), outer = spans.filter(s => !spans.some(p => p !== s && p.start <= s.start && p.end >= s.end));
  for (const s of outer.reverse()) xml = xml.slice(0, s.start) + xml.slice(s.end);
  return xml;
}
function attrPatch(xml, name, values) {
  const tok = scan(xml).find(t => t.name === name && (t.type === 'open' || t.type === 'selfclose'));
  if (!tok) throw fail('PAGE_LAYOUT', `쪽 설정 요소가 없습니다: ${name}`);
  const a = attrs(xml, tok);
  for (const [k, v] of Object.entries(values)) if (v !== undefined) a.set(k, String(v));
  const tag = `<${name}${[...a].map(([k,v]) => ` ${k}="${escapeAttr(v)}"`).join('')}${tok.type === 'selfclose' ? '/>' : '>'}`;
  return xml.slice(0, tok.start) + tag + xml.slice(tok.end);
}
function updateSecPr(sec, fn) {
  const sp = elements(sec.xml, 'hp:secPr');
  if (sp.length !== 1) throw fail('PAGE_LAYOUT', '구역 정의가 하나인 구역만 편집할 수 있습니다. 문단 나눔 변경을 먼저 정리하세요.');
  sec.load(sec.xml.slice(0, sp[0].start) + fn(sp[0].xml) + sec.xml.slice(sp[0].end));
}
function firstRunInsert(sec, value) {
  const run = sec.bodyParas[0]?.runs[0];
  if (!run) throw fail('PAGE_LAYOUT', '구역 첫 문단에 run이 없습니다.');
  const existing = elements(sec.xml, 'hp:secPr').find(e => e.start >= run.start && e.end <= run.end);
  const at = existing ? run.end : run.start;
  const controlRun = `<hp:run charPrIDRef="${escapeAttr(run.charPr)}">${value}</hp:run>`;
  sec.load(sec.xml.slice(0, at) + controlRun + sec.xml.slice(at));
}
function clearControls(sec, tag, match = () => true) {
  sec.load(removeElements(sec.xml, `hp:${tag}`, match).replace(/<hp:ctrl\s*>\s*<\/hp:ctrl>/g, ''));
}
function styleFor(doc, wanted) {
  const named = doc.formattingCatalog().styles.find(s => s.name === String(wanted ?? '바탕글'));
  const hit = doc.header.style({ id: named?.id ?? String(wanted ?? '0') });
  if (!hit) throw fail('STYLE_MISSING', `문단 스타일을 찾지 못했습니다: ${wanted}`);
  return hit;
}
function paragraph(doc, text, wanted, content = '') {
  const s = styleFor(doc, wanted);
  return String(text || '').split(/\r?\n/).map((line, i) => `<hp:p id="0" paraPrIDRef="${escapeAttr(s.paraPr)}" styleIDRef="${escapeAttr(s.styleId)}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${escapeAttr(s.charPr)}">${i ? '' : content}<hp:t>${escapeText(line)}</hp:t></hp:run></hp:p>`).join('');
}
const subList = body => `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList>`;
const plain = xml => elements(xml, 'hp:t').map(t => decodeEntities(t.xml.replace(/<[^>]+>/g, ''))).join('\n');
const mm = n => Math.round(Number(n) / MM * 1000) / 1000;
const units = n => Math.round(n * MM);
export const pageLayoutFingerprint = doc => crypto.createHash('sha256').update(docBytesSync(doc)).digest('hex');
export const pageLayoutStateFingerprint = doc => crypto.createHash('sha256').update(JSON.stringify({
  sections: doc.sections.map(s => ({ size: s.bodyParas.length, parts: ['hp:secPr','hp:header','hp:footer','hp:pageNum'].map(tag => elements(s.xml, tag).map(e => e.xml)) })),
  masters: [...doc.container.files.keys()].filter(n => /^Contents\/masterpage\d+\.xml$/.test(n)).sort().map(n => [n, doc.container.getText(n)]),
})).digest('hex');

// ───────── [hwpx-cowork] 쪽 구성 제안이 '기대는 상태'만 보는 지문(2026-11-17) ─────────
// 예전 지문(pageLayoutStateFingerprint)은 구역마다 본문 문단 수를 넣어, 같은 요청의 문단 넣기·표 넣기를 먼저 반영하면 쪽 구성 제안이 언제나 STALE 이었다
// (실제 일: 24쪽 문서 제안 80건 — #80 용지·여백 + 구역 합치기 ×23 + 쪽 번호를 '마지막에 반영하라'고 냈는데 [모두 반영]에서 37건 뒤 실패, 빈 쪽 8쪽이 남음).
// op 마다 기대는 것을 가린다(editPageLayout 의 갈래):
//  - paper·section·header·footer·page_number·master_page: 구역 번호(op.section)의 구역 정의(hp:secPr)·머리말·꼬리말·쪽 번호 조판 부호·바탕쪽 파일.
//    머리말·꼬리말·쪽 번호는 구역 첫 문단 첫 run 에 넣는다(firstRunInsert — 구역 첫 문단은 문단 지우기가 고를 수 없다). 문단 수·차례와는 무관하다.
//  - merge_section: 구역 수와 다음 구역의 정의·머리말·꼬리말·쪽 번호(합칠 때 지운다) — 문단 수와 무관하다.
//  - split_section(before_ref)·objects_to_body(at·drop·remove_rest.at): 문단 주소를 쓴다. 주소를 바꾸는 op(구역 나누기·합치기·개체 → 본문) 앞에 있는 op 의
//    주소는 지금 문서의 주소라, 대기 중에는 서버가 문단을 넣고 지울 때 다른 제안 주소와 함께 옮긴다(remapLayoutOps — service._remapSectionsDeep).
//    그 뒤에 오는 op 의 주소는 앞 op 를 한 뒤의 문서 주소라 옮길 수 없다 — 그런 op 가 있으면 예전처럼 구역마다 문단 수도 지문에 넣는다(sizes).
//  - objects_to_body: 옮길 글상자·선(종류·자리·크기·글 — layoutFingerprint)과 그 개체 문단 자신의 글을 문단 번호 없이(구역 번호와 차례만) 본다.
//    앞에 문단이 들어와 주소만 밀려도 개체가 그대로면 같은 지문, 개체가 바뀌거나 생기거나 없어지면(개체 문단에 글이 들어가도) 다른 지문이다.
// → { v: 2, parts(구역 구성 — 구역 수 포함), sizes?(구역별 문단 수), objects?(옮길 개체) } — 반영 때 같은 ops 로 다시 재어 견준다(server/service.js _applyCore).
const REF_OPS = new Set(['split_section', 'objects_to_body', 'insert_document']);
// [hwpx-cowork] 여러 문단 서식(restyle — 2026-11-18)의 at 항목: 문단 주소(중첩 포함)·범위 's0/p3..p9'·표 열쇠 's0/p3#t0'·{ table }. 구역 's1'·'*' 는 주소가 아니다
const RESTYLE_ONE = /^(s\d+\/p\d+)((?:\/[nd]\d+)*(?:#.*)?)$/;
const RESTYLE_RANGE = /^s(\d+)\/p(\d+)\.\.(?:s(\d+)\/)?p(\d+)$/;
function restyleBodyRefs(op) {
  const out = [];
  for (const item of op?.at || []) {
    const v = typeof item === 'string' ? item : item?.table;
    if (typeof v !== 'string') continue;
    const r = RESTYLE_RANGE.exec(v);
    if (r) { out.push(`s${r[1]}/p${r[2]}`, `s${r[3] ?? r[1]}/p${r[4]}`); continue; }
    const m = RESTYLE_ONE.exec(v); if (m) out.push(m[1]);
  }
  return out;
}
const MOVES_REFS = new Set(['split_section', 'merge_section', 'objects_to_body', 'insert_document']);
const PARA_REF = /^(s\d+\/p\d+)(:L\d+)?$/;
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** op 안의 문단 주소 글('s1/p3', 'drop' 의 's1/p3:L2') — 주소를 쓰는 op(REF_OPS)만, 머리말 글 같은 사용자 글은 보지 않는다 */
function opRefs(op) {
  const out = [];
  const walk = (v) => { if (typeof v === 'string') { if (PARA_REF.test(v)) out.push(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  if (REF_OPS.has(op?.op)) walk(op);
  if (op?.op === 'restyle') out.push(...restyleBodyRefs(op));
  return out;
}
/** ops 의 문단 주소 쓰임: lead = 지금 문서 주소를 쓰는 op 차례(주소를 바꾸는 op 앞 — 그 op 자신 포함), trailing = 그 뒤 op 가 주소를 쓰는가 */
export function layoutOpsRefs(ops) {
  const lead = []; let moved = false; let trailing = false;
  (ops || []).forEach((op, i) => {
    if (opRefs(op).length) { if (moved) trailing = true; else lead.push(i); }
    if (MOVES_REFS.has(op?.op)) moved = true;
  });
  return { lead, trailing };
}
/** 쪽 구성 제안이 기대는 상태(위 머리 주석) */
export function pageLayoutState(doc, ops) {
  const { trailing } = layoutOpsRefs(ops);
  const out = { v: 2, parts: digest({
    sections: doc.sections.map(s => ['hp:secPr','hp:header','hp:footer','hp:pageNum'].map(tag => elements(s.xml, tag).map(e => e.xml))),
    masters: [...doc.container.files.keys()].filter(n => /^Contents\/masterpage\d+\.xml$/.test(n)).sort().map(n => [n, doc.container.getText(n)]),
  }) };
  if (trailing) out.sizes = digest(doc.sections.map(s => s.bodyParas.length));
  const watched = new Map();
  for (const op of ops || []) {
    if (op.op === 'styles') {
      for (const d of op.define || []) if (d.applyToBase) watched.set(d.base, true);
      for (const d of op.update || []) watched.set(d.name, true);
    } else if (op.op === 'restyle') {
      for (const a of op.at || []) if (a?.style) {
        watched.set(a.style, true);
        if (op.style && !watched.has(op.style)) watched.set(op.style, false);
      }
    }
  }
  if (watched.size) out.styles = digest(styleDependencies(doc, watched));
  const moves = (ops || []).filter((op) => op?.op === 'objects_to_body');
  if (moves.length) out.objects = digest(moves.map((op) => {
    // 앞 op 를 한 뒤에만 있는 구역('s3' — 구역 나누기 뒤) 등 지금 문서로 풀 수 없는 대상은 그 글 그대로(문단 수는 sizes 가 지킨다)
    let hosts; try { hosts = JSON.parse(layoutFingerprint(doc, structureRefs(doc, op.at))); } catch { return ['?', op.at ?? null]; }
    // 개체 문단 자신의 글도 본다 — 옮긴 뒤 비게 된 구역 첫 문단을 지워 구역을 합칠지(merge_sections)가 그 글에 달렸다(다른 제안이 그 문단에 글을 넣으면 STALE)
    const own = (ref) => { try { return doc.text(ref, 'final'); } catch { return null; } };
    return hosts.map(([ref, items]) => [Number(/^s(\d+)/.exec(ref)?.[1] ?? -1), own(ref), items]);
  }));
  return out;
}
/**
 * 대기 중인 쪽 구성 제안 ops 의 문단 주소를 옮긴다(service._remapSectionsDeep — 다른 제안 반영·사람 편집으로 문단이 들어가거나 빠질 때).
 * 주소를 바꾸는 op 앞의 op(layoutOpsRefs lead)만 옮긴다. mapRef(본문 ref) → 새 본문 ref | null(지워짐).
 * 목록(at·drop·remove_rest[].at) 안 주소가 지워지면 목록에서 빼고(지운 문단의 개체는 objects 지문이 잡는다), 목록이 비거나 하나뿐인 주소(at 문자열·before_ref)가
 * 지워지면 lost(그 제안을 반영하면 GONE). → { ops(바뀌었으면 새 배열, 아니면 그대로), changed, lost }
 */
export function remapLayoutOps(ops, mapRef) {
  if (!Array.isArray(ops)) return { ops, changed: false, lost: false };
  const { lead } = layoutOpsRefs(ops);
  if (!lead.length) return { ops, changed: false, lost: false };
  let changed = false; let lost = false;
  const one = (v) => {
    const m = PARA_REF.exec(v); if (!m) return v;
    const to = mapRef(m[1]);
    if (to == null) return null;
    if (to !== m[1]) changed = true;
    return to + (m[2] || '');
  };
  const fix = (v) => {
    if (typeof v === 'string') { const r = one(v); if (r == null) { lost = true; return v; } return r; }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) { if (typeof x === 'string') { const r = one(x); if (r == null) changed = true; else out.push(r); } else out.push(fix(x)); }
      if (v.length && !out.length) lost = true;
      return out;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'op' ? x : fix(x)]));
    return v;
  };
  // 여러 문단 서식(restyle)의 at: 문단·표 주소는 본문 번호만 옮기고(꼬리 '/n2'·'#t0' 는 그대로), 지워진 것은 목록에서 뺀다. 범위는 두 끝을 옮기고 끝이 지워졌으면 lost
  const restyle = (op) => {
    const move = (v) => {
      const r = RESTYLE_RANGE.exec(v);
      if (r) {
        const a = mapRef(`s${r[1]}/p${r[2]}`); const b = mapRef(`s${r[3] ?? r[1]}/p${r[4]}`);
        if (a == null || b == null) { lost = true; return v; }
        const ma = /^s(\d+)\/p(\d+)$/.exec(a); const mb = /^s(\d+)\/p(\d+)$/.exec(b);
        const to = ma[1] === mb[1] ? `${a}..p${mb[2]}` : `${a}..${b}`;
        if (to !== v) changed = true;
        return to;
      }
      const m = RESTYLE_ONE.exec(v); if (!m) return v;
      const to = mapRef(m[1]); if (to == null) return null;
      if (to !== m[1]) changed = true;
      return to + m[2];
    };
    const at = [];
    for (const item of op.at || []) {
      if (typeof item === 'string') { const v = move(item); if (v == null) changed = true; else at.push(v); }
      else if (item && typeof item.table === 'string') { const v = move(item.table); if (v == null) changed = true; else at.push(v === item.table ? item : { ...item, table: v }); }
      else at.push(item);
    }
    if ((op.at || []).length && !at.length) lost = true;
    return { ...op, at };
  };
  const next = ops.map((op, i) => (!lead.includes(i) ? op : op?.op === 'restyle' ? restyle(op) : fix(op)));
  return { ops: changed || lost ? next : ops, changed, lost };
}

export function getPageLayout(doc) {
  return { unit: 'mm', sections: doc.sections.map((sec, section) => {
    const prop = elements(sec.xml, 'hp:secPr')[0]?.xml || '', page = elements(prop, 'hp:pagePr')[0]?.attrs || {};
    return { section, first_ref: `s${section}/p0`, paragraphs: sec.bodyParas.length,
      paper: { width_mm: mm(page.width), height_mm: mm(page.height), orientation: page.landscape === 'NARROWLY' ? 'landscape' : 'portrait', margins: Object.fromEntries(Object.entries(elements(prop, 'hp:margin')[0]?.attrs || {}).map(([k,v]) => [k, mm(v)])) },
      start: elements(prop, 'hp:startNum')[0]?.attrs || {}, visibility: elements(prop, 'hp:visibility')[0]?.attrs || {},
      headers: elements(sec.xml, 'hp:header').map(e => ({ ...e.attrs, text: plain(e.xml) })),
      footers: elements(sec.xml, 'hp:footer').map(e => ({ ...e.attrs, text: plain(e.xml) })),
      page_numbers: elements(sec.xml, 'hp:pageNum').map(e => e.attrs),
      master_pages: elements(prop, 'hp:masterPage').map(e => {
        const xml = doc.container.getText(`Contents/${e.attrs.idRef}.xml`) || '';
        const a = elements(xml, 'masterPage')[0]?.attrs || {};
        return { id: e.attrs.idRef, type: a.type, pageNumber: a.pageNumber, pageDuplicate: a.pageDuplicate, pageFront: a.pageFront, text: plain(xml), images: elements(xml, 'hc:img').map(i => i.attrs.binaryItemIDRef) };
      }) };
  }) };
}

function rebuild(doc) {
  doc.sections = doc.sections.map((s, i) => new Section(s.xml, i));
  doc._rewriteSectionFiles();
  // Keep RDF section references aligned with the package manifest.
  const rdf = doc.container.getText('META-INF/container.rdf');
  if (rdf) doc.container.setText('META-INF/container.rdf', rdf.replace(/<rdf:Description\b[^>]*rdf:about="Contents\/section\d+\.xml"[\s\S]*?<\/rdf:Description>/g, '').replace('</rdf:RDF>', doc.sectionNames.map(n => `<rdf:Description rdf:about="${n}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2011/meta#Section"/></rdf:Description>`).join('') + '</rdf:RDF>'));
}

function nestedSnapshot(doc) {
  const out = [], counts = new Map();
  for (const sec of doc.sections) for (const p of sec.paras) {
    if (p.body != null) continue;
    let parent = p, kind = 'body';
    while (parent.parent) {
      if (['hp:header','hp:footer','hp:fieldBegin'].includes(parent.container)) kind = parent.container;
      parent = parent.parent;
    }
    const host = parent.ref;
    const key = host+'|'+kind, slot = counts.get(key) || 0; counts.set(key,slot+1);
    out.push({ ref: p.ref, host, kind, slot, xml: sec.xml.slice(p.start,p.end) });
  }
  return out;
}

/**
 * [hwpx-cowork] 여러 문단 서식(restyle)의 at → 문단 주소 목록(2026-11-18). 범위·구역·'*' 는 본문 문단만(표 칸·글상자 안은 표 주소로 따로 준다),
 * 표는 칸의 문단(캡션 제외) — { table, row_from?, row_to?, col_from?, col_to? } 는 그 범위에 걸친 칸만(합친 칸은 걸치면 든다, 0부터)
 */
export function restyleRefs(doc, at) {
  const out = []; let tables = null; let uses = null;
  const body = (si, from, to) => {
    const sec = doc.sections[si]; if (!sec) throw fail('NO_PARAGRAPH', `구역이 없습니다: s${si}`);
    if (from < 0 || to >= sec.bodyParas.length || from > to) throw fail('NO_PARAGRAPH', `문단 범위가 문서 밖입니다: s${si}/p${from}..p${to}(이 구역의 본문 문단은 p0~p${sec.bodyParas.length - 1})`);
    for (let i = from; i <= to; i++) out.push(`s${si}/p${i}`);
  };
  const table = (key, range = {}) => {
    tables ??= doc.tables();
    const t = tables.find((x) => x.key === key); if (!t) throw fail('NO_TABLE', `표를 찾지 못했습니다: ${key}(read view='tables')`);
    const r0 = range.row_from ?? 0; const r1 = Math.min(range.row_to ?? t.rows - 1, t.rows - 1); const c0 = range.col_from ?? 0; const c1 = Math.min(range.col_to ?? t.cols - 1, t.cols - 1);
    if (r0 > r1 || c0 > c1) throw fail('RANGE', `표 ${key} 의 칸 범위가 표 밖입니다(${t.rows}×${t.cols}, 0부터)`);
    for (const c of t.cells) if (c.row <= r1 && c.row + c.rowSpan - 1 >= r0 && c.col <= c1 && c.col + c.colSpan - 1 >= c0) out.push(...c.refs);
  };
  for (const item of at || []) {
    if (item?.style) {
      const source = namedStyle(doc, item.style);
      if (!source || source.type !== 'PARA') throw fail('NO_STYLE', `대상 문단 스타일 「${item.style}」을 찾지 못했습니다. read(view='styles')에서 이름을 확인하세요`);
      uses ??= styleUsage(doc);
      const refs = uses.get(source.id);
      if (!refs?.length) throw fail('NO_PARAGRAPH', `「${source.name}」을 쓰는 문단이 없습니다`);
      for (const ref of refs) out.push(ref);
      continue;
    }
    if (item && typeof item === 'object') { table(item.table, item); continue; }
    const v = String(item); let m;
    if (v === '*') { doc.sections.forEach((s, si) => { if (s.bodyParas.length) body(si, 0, s.bodyParas.length - 1); }); continue; }
    if ((m = /^s(\d+)$/.exec(v))) { const sec = doc.sections[Number(m[1])]; if (!sec) throw fail('NO_PARAGRAPH', `구역이 없습니다: ${v}`); if (sec.bodyParas.length) body(Number(m[1]), 0, sec.bodyParas.length - 1); continue; }
    if ((m = RESTYLE_RANGE.exec(v))) {
      const a = Number(m[1]); const b = Number(m[3] ?? m[1]);
      if (a > b || (a === b && Number(m[2]) > Number(m[4]))) throw fail('RANGE', `범위의 앞뒤가 바뀌었습니다: ${v}`);
      for (let si = a; si <= b; si++) {
        const sec = doc.sections[si]; if (!sec) throw fail('NO_PARAGRAPH', `구역이 없습니다: s${si}`);
        const from = si === a ? Number(m[2]) : 0; const to = si === b ? Number(m[4]) : sec.bodyParas.length - 1;
        if (to >= from) body(si, from, to);
      }
      continue;
    }
    if (v.includes('#')) { table(v); continue; }
    out.push(v);
  }
  return out;
}

// 표준서식 스타일 원본(새 문서 바탕 server/templates/blank.hwpx — '&본문 1.'·'&표내용__' 등 23개, 실험 편집 server/document-edit.js 의 import_styles 와 같은 원본).
// 한 번만 읽는다. 들여오기(copyStyleDefinitionsFromSync)는 받는 문서의 머리만 고친다
let standardSource = null;
function standardStyleSource(doc) {
  standardSource ??= new doc.constructor(containerFromBytesSync(fs.readFileSync(new URL('../server/templates/blank.hwpx', import.meta.url))));
  return standardSource;
}
// 들여온 결과는 받는 문서의 머리 글로 정해진다(표준서식 원본에는 포함 글꼴·그림 채움이 없다) — 같은 머리에는 다시 계산하지 않는다.
// 머리가 큰 문서(문단 모양 301개·453KB)에서 들여오기 한 번이 3.3초이고, 저장 한 번에 사전 검사 사본·제안 만들기·반영이 같은 머리로 되풀이한다
const importedHeaders = new Map();
function importStandardStyles(doc) {
  const before = doc.header.xml; const hit = importedHeaders.get(before);
  if (hit !== undefined) { doc.header.xml = hit; return; }
  copyStyleDefinitionsFromSync(doc, standardStyleSource(doc));
  importedHeaders.set(before, doc.header.xml);
  if (importedHeaders.size > 6) importedHeaders.delete(importedHeaders.keys().next().value);
}
/** 표준서식 스타일 이름들(들여올 수 있는 것 — read view='styles' 가 보인다) */
export function standardStyleNames(doc) { return formattingCatalog(standardStyleSource(doc)).styles.map((s) => ({ name: s.name, type: s.type })); }

/** 개체 → 본문 결과 한 줄(제안 카드·작업 기록 메모에 보인다) */
export function structureLabel(r) {
  if (!r) return '개체 → 본문';
  const n = (v) => Number(v).toLocaleString('ko-KR');
  const parts = [];
  if (r.tables.length) parts.push(`표 ${r.tables.length}개(${r.tables.slice(0, 4).map(t => `${t.rows}×${t.cols}`).join('·')}${r.tables.length > 4 ? ' …' : ''})`);
  if (r.paragraphs) parts.push(`문단 ${n(r.paragraphs)}개`);
  parts.push(`글상자·선 ${n(r.removed)}개 지움`);
  // 남는 개체도 지우기(remove_rest — 같은 호출의 개체 지우기를 합친 것 포함): 안에 든 글이 함께 사라졌으면 그 글자 수를 밝힌다
  if (r.removedRest) parts.push(`남은 개체 ${n(r.removedRest)}개도 지움${r.text?.removedWithObjects ? `(안의 글자 ${n(r.text.removedWithObjects)}자 포함)` : ''}`);
  if (r.dropped.length) parts.push(`${[...new Set(r.dropped.map(d => d.why))].join('·')} ${n(r.dropped.length)}줄 버림`);
  if (r.sections[0] !== r.sections[1]) parts.push(`구역 ${r.sections[0]}→${r.sections[1]}`);
  if (r.margins) parts.push(`여백 좌우 ${r.margins.left ?? '-'}mm`);
  // 쪽 배경 그림(2026-11-17 — engine/flow.js pageBackgrounds): 지운 수, 글 뒤로 보낸 수(내용으로 보여 지우지 않은 것 포함)
  const bg = r.backgrounds;
  if (bg?.removed) parts.push(`쪽 배경 그림 ${n(bg.removed)}장 지움`);
  if (bg?.behind) parts.push(`쪽 배경 그림 ${n(bg.behind)}장 글 뒤로${bg.content ? `(내용으로 보여 지우지 않음 ${n(bg.content)}장)` : ''}`);
  if (r.kept) parts.push(`남긴 개체 ${n(r.kept)}개`);
  // 옮긴 글 영역에 겹치는 글 앞 개체(알림 — engine/flow.js coveringObjects)
  if (r.covering?.count) parts.push(`⚠ 글 앞 개체 ${n(r.covering.count)}개가 옮긴 글 영역에 겹침`);
  return `개체 → 본문: ${parts.join(' · ')}`;
}

/** Returns reversible address maps; callers remap proposals/requests/memo threads. */
export function editPageLayout(doc, ops, options = {}) {
  const onlyStyles = ops.every(op => op.op === 'styles' || op.op === 'restyle');
  return onlyStyles ? formattingTransaction(doc, () => applyLayoutOps(doc, ops, options, true)) : applyLayoutOps(doc, ops, options, false);
}

function applyLayoutOps(doc, ops, { attachmentBytes = () => { throw fail('BAD_IMAGE', '그림 첨부가 필요합니다.'); }, documentOf = () => { throw fail('BAD_DOCUMENT', '끼워 넣을 문서 첨부가 필요합니다.'); }, author = null }, onlyStyles) {
  const beforeNested = onlyStyles ? [] : nestedSnapshot(doc);
  const mapping = doc.sections.map((s, si) => s.bodyParas.map((_, i) => ({ old: [si, i], to: [si, i] }))).flat();
  // 지워진 문단(to = null — 개체 → 본문이 비게 된 문단을 지운다)은 그대로 둔다
  const move = fn => { for (const m of mapping) if (m.to) m.to = fn(...m.to); };
  const reports = new Map();
  const notes = new Map();   // styles·restyle 의 결과(라벨에 쓴다)
  for (const op of ops) {
    // [hwpx-cowork] 스타일 들여오기·정의(2026-11-18): 머리(header.xml)에 정의만 더한다 — 본문·주소는 그대로
    if (op.op === 'styles') {
      if (!op.import && !op.define?.length && !op.update?.length) throw fail('PAGE_LAYOUT', "styles 는 import:'standard', define 또는 update가 필요합니다.");
      const labels = formattingTransaction(doc, () => {
        const result = [];
        if (op.import === 'standard') {
          const before = styleDefinitions(doc).length;
          importStandardStyles(doc);
          const added = styleDefinitions(doc).length - before;
          result.push(`표준서식 스타일 들여오기 ${added}개${added ? '' : '(이미 모두 있음)'}`);
        }
        for (const [definitions, update] of [[op.define || [], false], [op.update || [], true]]) {
          const names = [];
          for (const d of definitions) {
            const clean = v => Object.fromEntries(Object.entries(v || {}).filter(([, value]) => value != null));
            const char = clean(d.char); const paragraph = clean(d.paragraph);
            const format = { ...(Object.keys(char).length ? { char } : {}), ...(Object.keys(paragraph).length ? { paragraph } : {}) };
            const edit = defineStyle(doc, { name: d.name, baseStyle: d.base, type: d.type || 'PARA', format, applyToBase: d.applyToBase, update });
            names.push(`「${edit.name}」${edit.total == null ? '' : ` 사용 문단 ${edit.total}곳`}`);
          }
          if (names.length) result.push(`스타일 ${update ? '수정' : '정의'} ${names.join('·')}`);
        }
        return result.join(' · ');
      });
      notes.set(op, labels);
      continue;
    }
    // [hwpx-cowork] 여러 문단 서식(2026-11-18): 대상을 문단 주소로 풀어 한 번에(engine/formatting.js formatParagraphs). style 은 이름 — 앞 op 가 들여온 것도 된다
    if (op.op === 'restyle') {
      const refs = restyleRefs(doc, op.at);
      if (!refs.length) throw fail('NO_PARAGRAPH', '서식을 줄 문단이 없습니다.');
      let styleId;
      if (op.style != null) {
        const list = formattingCatalog(doc).styles; const hit = list.find((x) => x.name === op.style && x.type !== 'CHAR') || list.find((x) => x.name === op.style);
        if (!hit) throw fail('NO_STYLE', `스타일 「${op.style}」 이 문서에 없습니다(있는 스타일: ${list.filter((x) => x.type !== 'CHAR').slice(0, 30).map((x) => x.name).join(' · ')}) — 표준서식 스타일은 같은 호출에 {op:'styles', import:'standard'} 를 함께 내면 쓸 수 있습니다.`);
        styleId = hit.id;
      }
      const clean = (v) => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) : {});
      const char = clean(op.char); const paragraph = clean(op.paragraph);
      const out = formatParagraphs(doc, refs, { ...(styleId != null ? { styleId } : {}), ...(Object.keys(char).length ? { char } : {}), ...(Object.keys(paragraph).length ? { paragraph } : {}) });
      notes.set(op, { ...out, style: op.style ?? null, char: Object.keys(char).length > 0, paragraph: Object.keys(paragraph).length > 0 });
      continue;
    }
    if (op.op === 'objects_to_body') {
      // 개체 → 본문(engine/flow.js): 문단을 넣고 지우고 구역을 합친다 — 그 옮김표를 지금까지의 옮김표에 잇는다
      const out = objectsToBody(doc, { refs: structureRefs(doc, op.at), joinPages: op.join_pages, keepPageNumbers: op.keep_page_numbers, drop: op.drop, headerRows: op.header_rows,
        wrap: op.wrap, margins: op.margins ?? 'auto', mergeSections: op.merge_sections, removeRest: op.remove_rest, background: op.background, author });
      rebuild(doc);
      const moved = new Map(out.mapping.map(m => [m.old.join('/'), m.to]));
      for (const m of mapping) if (m.to) m.to = moved.get(m.to.join('/')) ?? null;
      reports.set(op, out.report);
      continue;
    }
    if (op.op === 'insert_document') {
      // [hwpx-cowork] 문서 끼워 넣기(MCP v3 실험 — 2026-11-20 §21): 첨부 HWPX 의 본문 문단을 after 뒤에(engine/doc.js insertDocumentAfter) — 뒤 문단 주소는 넣은 수만큼 민다
      const [, sn, pn] = /^s(\d+)\/p(\d+)$/.exec(op.after) || [], si = Number(sn), pi = Number(pn);
      if (!doc.sections[si]?.bodyParas[pi]) throw fail('PAGE_LAYOUT', `끼워 넣을 자리(after)가 본문 문단 범위 밖입니다: ${op.after}`);
      const out = doc.insertDocumentAfter(si, pi, documentOf(op.attachment_id));
      rebuild(doc);
      move((s, i) => (s === si && i > pi ? [s, i + out.count] : [s, i]));
      reports.set(op, { ...out.report, inserted: op.attachment_id, after: op.after });
      continue;
    }
    if (op.op === 'split_section') {
      const [, sn, pn] = /^s(\d+)\/p(\d+)$/.exec(op.before_ref) || [], si = Number(sn), pi = Number(pn), sec = doc.sections[si];
      if (!sec || !sec.bodyParas[pi] || pi < 1) throw fail('PAGE_LAYOUT', '구역 나눔 위치가 본문 문단 범위 밖입니다.');
      if (sec.bodyParas.some(p => p.members?.length > 1)) throw fail('PAGE_LAYOUT', '문단 나눔 변경을 먼저 정리하세요.');
      const props = elements(sec.xml, 'hp:secPr');
      if (props.length !== 1) throw fail('PAGE_LAYOUT', '구역 나눔 정의를 먼저 정리하세요.');
      const open = sec.xml.slice(0, sec.xml.indexOf('>', sec.xml.indexOf('<hs:sec')) + 1), tail = '</hs:sec>', cut = sec.bodyParas[pi].start;
      const left = new Section(sec.xml.slice(0, cut) + tail, si), right = new Section(open + sec.xml.slice(cut), si + 1);
      firstRunInsert(right, props[0].xml + '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>');
      doc.sections.splice(si, 1, left, right); rebuild(doc);
      move((s,i) => s > si ? [s+1,i] : s === si && i >= pi ? [s+1,i-pi] : [s,i]);
      continue;
    }
    const sec = doc.sections[op.section];
    if (!sec) throw fail('NO_SECTION', `구역이 없습니다: ${op.section}`);
    if (op.op === 'merge_section') {
      const si = op.section, next = doc.sections[si + 1], offset = sec.bodyParas.length;
      if (!next) throw fail('PAGE_LAYOUT', '합칠 다음 구역이 없습니다.');
      // Reuse field-ID collision handling in the document engine, retaining other boundaries.
      clearControls(next, 'header'); clearControls(next, 'footer'); clearControls(next, 'pageNum');
      const nextPr = elements(next.xml, 'hp:secPr')[0];
      if (!nextPr) throw fail('PAGE_LAYOUT', '합칠 구역 정의가 없습니다.');
      next.load(removeElements(next.xml, 'hp:secPr').replace(/<hp:ctrl>\s*<hp:colPr\b[^>]*\/>\s*<\/hp:ctrl>/g, ''));
      const sizes = doc.sectionSizes(), starts = []; let at = 0;
      sizes.forEach((n,s) => { if (s && s !== si+1) starts.push(at); at += n; });
      doc.flattenSections(); doc.splitSectionsAt(starts); rebuild(doc);
      move((s,i) => s === si+1 ? [si,offset+i] : s > si+1 ? [s-1,i] : [s,i]);
      continue;
    }
    if (op.op === 'paper') updateSecPr(sec, xml => {
      xml = attrPatch(xml, 'hp:pagePr', { width: op.width_mm == null ? undefined : units(op.width_mm), height: op.height_mm == null ? undefined : units(op.height_mm), landscape: op.orientation == null ? undefined : op.orientation === 'landscape' ? 'NARROWLY' : 'WIDELY' });
      if (op.margins) xml = attrPatch(xml, 'hp:margin', Object.fromEntries(Object.entries(op.margins).map(([k,v]) => [k, units(v)])));
      const page = elements(xml, 'hp:pagePr')[0]?.attrs, margin = elements(xml, 'hp:margin')[0]?.attrs;
      let w = Number(page.width), h = Number(page.height);
      if (page.landscape === 'NARROWLY') [w,h] = [h,w];
      if (Number(margin.left)+Number(margin.right)+Number(margin.gutter) >= w || Number(margin.top)+Number(margin.bottom) >= h) throw fail('PAGE_LAYOUT', '여백이 용지 크기보다 큽니다.');
      return xml;
    });
    else if (op.op === 'section') updateSecPr(sec, xml => {
      xml = attrPatch(xml, 'hp:startNum', { page: op.page_start, pageStartsOn: op.starts_on });
      const vis = {};
      for (const [key, attr] of Object.entries({ hide_first_header: 'hideFirstHeader', hide_first_footer: 'hideFirstFooter', hide_first_master: 'hideFirstMasterPage', hide_first_number: 'hideFirstPageNum' })) if (op[key] != null) vis[attr] = op[key] ? '1' : '0';
      return Object.keys(vis).length ? attrPatch(xml, 'hp:visibility', vis) : xml;
    });
    else if (op.op === 'header' || op.op === 'footer') {
      const apply = op.apply_to || 'BOTH';
      clearControls(sec, op.op, e => op.clear && !op.apply_to || !op.clear && apply === 'BOTH' || e.attrs.applyPageType === apply);
      if (!op.clear) {
        if (op.text == null) throw fail('PAGE_LAYOUT', '머리말·꼬리말 text 또는 clear가 필요합니다.');
        const ids = doc.sections.flatMap(s => [...s.xml.matchAll(/\bid="(\d+)"/g)].map(m => Number(m[1]))), id = Math.max(0,...ids) + 1;
        firstRunInsert(sec, `<hp:ctrl><hp:${op.op} id="${id}" applyPageType="${apply}">${subList(paragraph(doc, op.text, op.style))}</hp:${op.op}></hp:ctrl>`);
      }
    } else if (op.op === 'page_number') {
      const previous = elements(sec.xml, 'hp:pageNum')[0]?.attrs || {};
      clearControls(sec, 'pageNum');
      if (!op.clear && op.position !== 'NONE') firstRunInsert(sec, `<hp:ctrl><hp:pageNum pos="${escapeAttr(op.position || previous.pos || 'BOTTOM_CENTER')}" formatType="${escapeAttr(op.format || previous.formatType || 'DIGIT')}" sideChar="${escapeAttr(op.side_char ?? previous.sideChar ?? '')}"/></hp:ctrl>`);
      if (op.start != null) updateSecPr(sec, xml => attrPatch(xml, 'hp:startNum', { page: op.start }));
    } else if (op.op === 'master_page') {
      const apply = op.apply_to || 'BOTH';
      let refs = elements(elements(sec.xml, 'hp:secPr')[0]?.xml || '', 'hp:masterPage').map(e => e.attrs.idRef);
      refs = refs.filter(id => { const xml = doc.container.getText(`Contents/${id}.xml`) || ''; return !(op.clear && !op.apply_to || !op.clear && apply === 'BOTH' || elements(xml, 'masterPage')[0]?.attrs.type === apply); });
      if (!op.clear) {
        if (op.text == null && !op.attachment_id) throw fail('PAGE_LAYOUT', '바탕쪽 text·attachment_id 또는 clear가 필요합니다.');
        let n = 0; while (doc.container.has(`Contents/masterpage${n}.xml`)) n++;
        const id = `masterpage${n}`, name = `Contents/${id}.xml`;
        let content = '';
        if (op.attachment_id) {
          const data = attachmentBytes(op.attachment_id), info = imageInfo(data);
          if (!info) throw fail('BAD_IMAGE', '바탕쪽 그림을 읽지 못했습니다.');
          const page = getPageLayout(doc).sections[op.section].paper;
          let w = units(page.width_mm), h = units(page.height_mm); if (page.orientation === 'landscape') [w,h] = [h,w];
          const picAttrs = new Map(Object.entries({textWrap:'BEHIND_TEXT',textFlow:'BOTH_SIDES',lock:'0',dropcapstyle:'None',href:'',groupLevel:'0',reverse:'0'}));
          content = pictureXml({ id: 1, instid: 1, zOrder: 0, attrs: picAttrs, binId: doc._addBinary(data, info), org: { w: info.width*PX, h: info.height*PX }, cur: { w,h }, pos: '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>', outMargin: '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' });
        }
        const namespaces = /<hs:sec\b([^>]*)>/.exec(sec.xml)?.[1] || '';
        doc.container.setText(name, `<?xml version="1.0" encoding="UTF-8"?><masterPage${namespaces} id="${id}" type="${apply}" pageNumber="0" pageDuplicate="0" pageFront="0">${subList(paragraph(doc, op.text || '', op.style, content))}</masterPage>`);
        let hpf = doc.container.getText('Contents/content.hpf');
        doc.container.setText('Contents/content.hpf', hpf.replace('</opf:manifest>', `<opf:item id="${id}" href="${name}" media-type="application/xml"/></opf:manifest>`));
        refs.push(id);
      }
      updateSecPr(sec, xml => attrPatch(removeElements(xml, 'hp:masterPage'), 'hp:secPr', { masterPageCnt: refs.length }).replace('</hp:secPr>', refs.map(id => `<hp:masterPage idRef="${escapeAttr(id)}"/>`).join('') + '</hp:secPr>'));
    }
  }
  // 서식은 문단을 옮기지 않는다. 머리말·꼬리말 안의 XML이 바뀌어도 주소는 그대로이고 바탕쪽 파일도 정리할 이유가 없다.
  const formatLabel = op => {
    if (op.op === 'styles') return notes.get(op);
    const n = notes.get(op);
    const what = [n.style ? `스타일 「${n.style}」` : '', n.char ? '글자 모양' : '', n.paragraph ? '문단 모양' : ''].filter(Boolean).join('·');
    return `서식 ${n.total.toLocaleString('ko-KR')}곳: ${what}`;
  };
  if (onlyStyles) return { mapping, refMapping: doc.sections.flatMap(s => s.paras.filter(p => p.body == null).map(p => ({ old: p.ref, to: p.ref }))), reports: [], labels: ops.map(formatLabel) };
  // Remove unused master parts, leaving shared master pages and shared binary resources intact.
  const used = new Set(doc.sections.flatMap(s => elements(s.xml, 'hp:masterPage').map(e => `Contents/${e.attrs.idRef}.xml`)));
  for (const name of [...doc.container.files.keys()]) if (/^Contents\/masterpage\d+\.xml$/.test(name) && !used.has(name)) {
    doc.container.remove(name);
    doc.container.setText('Contents/content.hpf', removeElements(doc.container.getText('Contents/content.hpf'), 'opf:item', e => e.attrs.href === name));
  }
  const afterNested = nestedSnapshot(doc), hosts = new Map(mapping.map(m => [`s${m.old[0]}/p${m.old[1]}`, m.to ? `s${m.to[0]}/p${m.to[1]}` : null]));
  // 문단마다 한 번만 훑게 문단별로 모아 둔다(글상자 수천 개인 문서에서 문단 수 × 중첩 문단 수를 피한다)
  const byHost = new Map();
  for (const q of afterNested) { const k = `${q.host}|${q.kind}`; if (!byHost.has(k)) byHost.set(k, []); byHost.get(k).push(q); }
  const refMapping = beforeNested.map(old => {
    const candidates = byHost.get(`${hosts.get(old.host)}|${old.kind}`) || [];
    // [hwpx-cowork] 2026-11-18: 글이 같은 머리말·꼬리말 문단이 여럿이면 제자리 것을 먼저 고른다(예전에는 첫 번째 같은 글로 옮겨 가 — 아무것도 옮기지 않는 op 에서도 주소가 바뀌었다)
    const next = old.kind === 'body' ? candidates[old.slot] : (candidates.find(q => q.ref === old.ref && q.xml === old.xml) || candidates.find(q => q.xml === old.xml));
    return { old: old.ref, to: next?.ref || null };
  });
  return { mapping, refMapping, reports: ops.filter(op => reports.has(op)).map(op => reports.get(op)), labels: ops.map(op => {
    if (op.op === 'objects_to_body') return structureLabel(reports.get(op));
    if (op.op === 'insert_document') { const r = reports.get(op) || {}; return `문서 끼워 넣기(${op.after} 뒤): 문단 ${r.paragraphs ?? 0}개${r.tables ? ` · 표 ${r.tables}개` : ''}${r.figures ? ` · 그림 ${r.figures}개` : ''}${r.first ? ` — 「${r.first}」` : ''}`; }
    if (op.op === 'styles' || op.op === 'restyle') return formatLabel(op);
    const name = ({ paper:'용지·여백', section:'구역 설정', split_section:'구역 나누기', merge_section:'구역 합치기', header:'머리말', footer:'꼬리말', page_number:'쪽 번호', master_page:'바탕쪽' })[op.op];
    if (op.op === 'split_section') return `${op.before_ref} 앞에서 구역 나누기`;
    const extra = op.clear ? '삭제' : [op.orientation === 'landscape' ? '가로' : op.orientation === 'portrait' ? '세로' : '', op.width_mm ? `${op.width_mm}×${op.height_mm || '기존'}mm` : '', op.margins ? Object.entries(op.margins).map(([k,v]) => `${({left:'왼쪽',right:'오른쪽',top:'위',bottom:'아래',header:'머리말',footer:'꼬리말',gutter:'제본'})[k]} ${v}mm`).join(' · ') : '', op.text?.slice(0,40), op.position, op.start != null ? `${op.start}부터` : '', op.attachment_id ? '배경 그림' : ''].filter(Boolean).join(' · ');
    return `구역 ${op.section+1} ${name}${extra ? ': '+extra : ''}`;
  }) };
}
