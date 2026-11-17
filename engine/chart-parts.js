// [hwpx-cowork] 차트 꾸러미 부분(Chart/chartN.xml) — HWPX 차트는 본문의 <hp:chart chartIDRef="Chart/chartN.xml"> 와 꾸러미의
// OOXML 차트 부분 한 쌍이다. 한/글 저장본 실측(한글 COM 2026-10-30):
//  - 본문: <hp:switch><hp:case hp:required-namespace="…/ooxmlchart"><hp:chart …/></hp:case><hp:default><hp:ole binaryItemIDRef="oleN" …/></hp:default></hp:switch>
//  - 꾸러미: Chart/chartN.xml(content.hpf 매니페스트에는 올리지 않는다) + 대체 OLE BinData/oleN.ole(매니페스트에 올린다)
//  - 차트를 지우고 저장하면 두 부분 모두 빠진다(남은 차트의 번호는 그대로)
// 서버 문서(HwpxDoc)로 차트를 옮기거나 지울 때 Chart 부분도 따라 옮기고 거둔다(engine/doc.js _importShapeParts·_releaseShapeParts 갈고리).
// 대체 OLE 는 BinData 라 그림 파일 경로(_importBinary·removeUnusedBinary)가 맡는다.
import { createHash } from 'node:crypto';
import { Section } from './section.js';

const PART = /^Chart\/chart(\d+)\.xml$/;

/** XML 조각이 가리키는 차트 부분 경로들(차례대로) */
export function chartRefs(xml) {
  return [...String(xml || '').matchAll(/chartIDRef="([^"]+)"/g)].map((m) => m[1]);
}

/** 차트 부분의 내용 열쇠(도형 지문용 — 편집기에서 값만 바꿔도 지문이 달라진다). 없으면 missing:경로 */
export function chartPartKey(doc, ref) {
  const b = doc.container.getBytes(ref);
  return b ? `chart:${createHash('sha1').update(b).digest('hex').slice(0, 20)}` : `missing:${ref}`;
}

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** 이 문서 구역들이 chartIDRef 로 가리키는 횟수 */
function useCount(doc, ref) {
  const needle = `chartIDRef="${ref}"`;
  let n = 0;
  for (const s of doc.sections) { let i = -1; while ((i = s.xml.indexOf(needle, i + 1)) >= 0) n++; }
  return n;
}

/** 아직 쓰지 않는 차트 부분 경로(있는 번호 다음) */
function freePart(doc) {
  let max = 0;
  for (const n of doc.container.order) { const m = PART.exec(n); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `Chart/chart${max + 1}.xml`;
}

/**
 * source(편집기 내보내기)의 도형 XML 이 가리키는 차트 부분을 target(서버 문서)으로 옮기고 참조를 고친 XML 을 돌려준다.
 *  - 바꿔 끼우는 차트(keep = target 의 원래 XML): 내용이 같으면 원래 부분 그대로, 다르면 새 번호에 새 내용(참조가 바뀌어야
 *    copyObjectsFrom 이 바뀐 도형으로 친다 — 원래 부분은 저장할 때 아무도 안 쓰면 거둔다, pruneChartParts)
 *  - 새 차트: 같은 경로가 비어 있으면 그 경로, 아니면 다음 번호(두 차트가 한 부분을 같이 쓰지 않게 — 한/글도 차트마다 따로 쓴다)
 * source 에 그 부분이 없으면 참조를 그대로 둔다.
 */
export function importChartParts(target, source, xml, keep = null) {
  const keptRefs = chartRefs(keep);
  let k = 0;
  return String(xml).replace(/(chartIDRef=")([^"]+)(")/g, (m, a, ref, b) => {
    const bytes = source.container.getBytes(ref);
    const old = keptRefs[k++];
    if (!bytes) return m;
    if (old && PART.test(old) && same(target.container.getBytes(old), bytes)) return `${a}${old}${b}`;
    const mine = target.container.getBytes(ref);
    if (PART.test(ref) && (!mine || (same(mine, bytes) && useCount(target, ref) === 0))) {
      if (!mine) target.container.setBytes(ref, bytes);
      return m;
    }
    const name = freePart(target);
    target.container.setBytes(name, bytes);
    return `${a}${name}${b}`;
  });
}

/**
 * 한/글식 차트 switch(안의 hp:chart 와 대체 hp:ole — 한/글은 둘에 같은 id 를 쓴다)의 id 를 이 문서에 맞춘다:
 * 바꿔 끼우는 차트(keep)는 원래 id, 새 차트는 0 이거나 이 문서(all = 구역 XML 들)에 이미 있는 id 면 새 id. switch 가 아니면 그대로
 */
export function fixSwitchIds(xml, keep, all = '') {
  const s = String(xml);
  if (!s.startsWith('<hp:switch')) return s;
  const idOf = (x, tag) => (new RegExp(`<${tag}\\b[^>]*?\\sid="([^"]*)"`).exec(x || '') || [])[1] ?? null;
  const cur = idOf(s, 'hp:chart');
  if (cur == null) return s;
  let want = keep ? (idOf(keep, 'hp:chart') ?? cur) : cur;
  if (!keep && (cur === '0' || all.includes(` id="${cur}"`))) {
    for (let i = 0; i < 50; i++) { const n = String(100000000 + Math.floor(Math.random() * 2000000000)); if (!all.includes(`="${n}"`)) { want = n; break; } }
  }
  if (want === cur) return s;
  return s.replace(/<hp:(chart|ole)\b[^>]*>/g, (open) => open.replace(/(\sid=")[^"]*(")/, `$1${want}$2`));
}

/**
 * 저장 전 정리: 아무도 안 가리키는 차트 부분(Chart/chartN.xml)과 차트 대체 OLE(BinData/*.ole 매니페스트 항목)를 거둔다 — 한/글은
 * 저장할 때 살아 있는 차트의 부분만 쓴다. (바꿔 끼운 차트의 옛 부분, 문단째 지운 차트 등) → 거둔 수
 */
export function pruneChartParts(doc) {
  let n = 0;
  const secXml = doc.sections.map((s) => s.xml).join('');
  for (const name of [...doc.container.order]) {
    if (PART.test(name) && !secXml.includes(`chartIDRef="${name}"`)) { doc.container.remove(name); n++; }
  }
  const hpf = doc.container.getText('Contents/content.hpf') || '';
  for (const m of hpf.matchAll(/<opf:item\b[^>]*\bid="([^"]+)"[^>]*\bhref="BinData\/[^"]+\.ole"[^>]*\/>/gi)) {
    if (!secXml.includes(`binaryItemIDRef="${m[1]}"`) && doc.removeUnusedBinary(m[1])) n++;
  }
  renumberChartParts(doc);
  return n;
}

/**
 * 한/글처럼 차트 부분을 문서 차례대로 chart1·chart2… 로 다시 매긴다(한/글은 chart1 을 지우고 저장하면 남은 chart2 를 chart1 로 쓴다 —
 * 한글 COM 실측 2026-10-30). 이미 그 차례면 아무것도 안 한다. 구역 XML 의 chartIDRef 만 바꾼다 → 바꿨는가
 */
export function renumberChartParts(doc) {
  const order = [];
  for (const s of doc.sections) for (const r of chartRefs(s.xml)) if (PART.test(r) && !order.includes(r) && doc.container.has(r)) order.push(r);
  const map = new Map(order.map((r, i) => [r, `Chart/chart${i + 1}.xml`]));
  if ([...map].every(([a, b]) => a === b)) return false;
  const bytes = new Map(order.map((r) => [r, doc.container.getBytes(r)]));
  for (const r of order) doc.container.remove(r);
  for (const r of order) doc.container.setBytes(map.get(r), bytes.get(r));
  for (const s of doc.sections) {
    const xml = s.xml.replace(/(chartIDRef=")([^"]+)(")/g, (m, a, r, b) => (map.has(r) ? `${a}${map.get(r)}${b}` : m));
    if (xml !== s.xml) s.load(xml);
  }
  return true;
}

/** 지운 도형 XML 이 가리키던 차트 부분을 이 문서에서 아무도 안 쓰면 거둔다 → 거둔 수 */
export function releaseChartParts(doc, xml) {
  let n = 0;
  for (const ref of new Set(chartRefs(xml))) {
    if (!PART.test(ref) || !doc.container.has(ref) || useCount(doc, ref) > 0) continue;
    doc.container.remove(ref); n++;
  }
  return n;
}

/** 문서 꾸러미의 차트 부분 점검 → { parts, refs, orphans(아무도 안 쓰는 부분), dangling(없는 부분을 가리킴) } */
export function chartPartReport(doc) {
  const parts = doc.container.order.filter((n) => PART.test(n));
  const refs = doc.sections.flatMap((s) => chartRefs(s.xml));
  return { parts, refs, orphans: parts.filter((p) => !refs.includes(p)), dangling: [...new Set(refs.filter((r) => !doc.container.has(r)))] };
}

/**
 * [hwpx-cowork] 2026-11-17 hp:switch 대체 갈래 사본 맞추기(저장 전): 한/글 차트는 같은 캡션을 첫 갈래(hp:case 의 hp:chart)와 대체 갈래(hp:default 의
 * hp:ole)에 두 벌 쓴다. 엔진은 첫 갈래 캡션만 보이고 고치므로(engine/section.js alt) 캡션 글을 고치면 대체 사본이 옛 글로 남는다. 한/글 2022 COM 실측:
 * 대체 사본만 다른 글인 파일을 열면 글·PDF 모두 첫 갈래 글이고 다시 저장하면 대체 사본을 첫 갈래에서 새로 쓴다. 대체 사본에 첫 갈래와 같은 문단
 * (같은 변경 표식 번호 포함)을 넣은 파일도 한/글은 변경 하나·글 한 번으로 연다. 그래서 두 갈래 캡션의 최종본 글이 다를 때만 대체 사본 캡션의 문단들을
 * 첫 갈래 캡션 문단 XML 로 바꾼다(캡션·subList 속성은 그대로) — 글이 같으면(한/글 저장본 그대로) 한 바이트도 바꾸지 않는다.
 * 대체 사본에 캡션이 없으면(첫 갈래에만 캡션을 단 경우) 넣지 않는다 — 한/글이 다시 저장할 때 새로 쓴다 → 바꾼 대체 사본 수
 */
export function syncSwitchCopies(doc) {
  let n = 0;
  for (const sec of doc.sections) {
    if (!sec.xml.includes('<hp:switch') || !sec.paras.some((p) => p.alt)) continue;
    const xml = sec.xml; const edits = [];
    // 문단들이 한 hp:caption > hp:subList 의 문단 전부로 잇닿아 있는가
    const capRun = (ps) => ps.length > 0 && ps.every((q, i) => i === 0 || ps[i - 1].end === q.start)
      && /<hp:caption\b[^>]*><hp:subList\b[^>]*>$/.test(xml.slice(Math.max(0, ps[0].start - 1500), ps[0].start))
      && xml.startsWith('</hp:subList></hp:caption>', ps[ps.length - 1].end);
    const text = (ps) => ps.map((q) => Section.text(q, 'final')).join('\n');
    for (const p of sec.paras) {
      if (p.alt || !p.children.some((c) => c.alt)) continue;
      for (const a of p.anchors) {
        if (a.kind !== 'ctrl' || a.name !== 'hp:switch' || a.end == null) continue;
        const kids = p.children.filter((c) => a.start <= c.start && c.end <= a.end);
        const main = kids.filter((c) => !c.alt); const alt = kids.filter((c) => c.alt);
        if (!capRun(main) || !capRun(alt) || text(main) === text(alt)) continue;
        edits.push({ start: alt[0].start, end: alt[alt.length - 1].end, insert: xml.slice(main[0].start, main[main.length - 1].end) });
      }
    }
    if (!edits.length) continue;
    let out = xml;
    for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
    sec.load(out); n += edits.length;
  }
  return n;
}
