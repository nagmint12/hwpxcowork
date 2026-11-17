// Typed page editing, preserving unrelated XML and document text.
import crypto from 'node:crypto';
import { scan, attrs, escapeAttr, escapeText, decodeEntities } from './xmlscan.js';
import { Section } from './section.js';
import { imageInfo, pictureXml, MM, PX } from './picture.js';
import { docBytesSync } from './toc.js';
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
  if (r.kept) parts.push(`남긴 개체 ${n(r.kept)}개`);
  return `개체 → 본문: ${parts.join(' · ')}`;
}

/** Returns reversible address maps; callers remap proposals/requests/memo threads. */
export function editPageLayout(doc, ops, { attachmentBytes = () => { throw fail('BAD_IMAGE', '그림 첨부가 필요합니다.'); }, author = null } = {}) {
  const beforeNested = nestedSnapshot(doc);
  const mapping = doc.sections.map((s, si) => s.bodyParas.map((_, i) => ({ old: [si, i], to: [si, i] }))).flat();
  // 지워진 문단(to = null — 개체 → 본문이 비게 된 문단을 지운다)은 그대로 둔다
  const move = fn => { for (const m of mapping) if (m.to) m.to = fn(...m.to); };
  const reports = new Map();
  for (const op of ops) {
    if (op.op === 'objects_to_body') {
      // 개체 → 본문(engine/flow.js): 문단을 넣고 지우고 구역을 합친다 — 그 옮김표를 지금까지의 옮김표에 잇는다
      const out = objectsToBody(doc, { refs: structureRefs(doc, op.at), joinPages: op.join_pages, keepPageNumbers: op.keep_page_numbers, drop: op.drop, headerRows: op.header_rows,
        wrap: op.wrap, margins: op.margins ?? 'auto', mergeSections: op.merge_sections, removeRest: op.remove_rest, author });
      rebuild(doc);
      const moved = new Map(out.mapping.map(m => [m.old.join('/'), m.to]));
      for (const m of mapping) if (m.to) m.to = moved.get(m.to.join('/')) ?? null;
      reports.set(op, out.report);
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
    const next = old.kind === 'body' ? candidates[old.slot] : candidates.find(q => q.xml === old.xml);
    return { old: old.ref, to: next?.ref || null };
  });
  return { mapping, refMapping, reports: ops.filter(op => reports.has(op)).map(op => reports.get(op)), labels: ops.map(op => {
    if (op.op === 'objects_to_body') return structureLabel(reports.get(op));
    const name = ({ paper:'용지·여백', section:'구역 설정', split_section:'구역 나누기', merge_section:'구역 합치기', header:'머리말', footer:'꼬리말', page_number:'쪽 번호', master_page:'바탕쪽' })[op.op];
    if (op.op === 'split_section') return `${op.before_ref} 앞에서 구역 나누기`;
    const extra = op.clear ? '삭제' : [op.orientation === 'landscape' ? '가로' : op.orientation === 'portrait' ? '세로' : '', op.width_mm ? `${op.width_mm}×${op.height_mm || '기존'}mm` : '', op.margins ? Object.entries(op.margins).map(([k,v]) => `${({left:'왼쪽',right:'오른쪽',top:'위',bottom:'아래',header:'머리말',footer:'꼬리말',gutter:'제본'})[k]} ${v}mm`).join(' · ') : '', op.text?.slice(0,40), op.position, op.start != null ? `${op.start}부터` : '', op.attachment_id ? '배경 그림' : ''].filter(Boolean).join(' · ');
    return `구역 ${op.section+1} ${name}${extra ? ': '+extra : ''}`;
  }) };
}
