// 개체 → 본문(objects_to_body, 2026-11-16 — docs/MCP_REDESIGN_2026-11-16.md §4): 쪽 좌표에 놓인 글상자·괘선으로 그려진 문단을
// 진짜 본문 문단과 표로 옮기고 그 글상자·선·면을 지운다. 무엇을 어떻게 옮길지는 engine/layout.js 가 좌표로 정한다(모델이 글을 다시 치지 않는다).
// 변경 추적 없이 바로 고친다(쪽 구성 제안과 같은 길 — server/service.js 가 고치기 전 사본으로 되돌린다). 그림·표·차트와 안에 개체가 든 글상자는 그대로 둔다.
import { EngineError } from './errors.js';
import { analyzeLayout, inferMargins } from './layout.js';

const MM = 7200 / 25.4;
const units = (mm) => Math.round(Number(mm) * MM);
const MARGIN_KEYS = ['left', 'right', 'top', 'bottom', 'header', 'footer', 'gutter'];
/** 넣을 글에서 XML 에 둘 수 없는 제어 문자를 빼고 줄바꿈은 빈칸으로 */
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/\s*\r?\n\s*/g, ' ');

/** 문서의 보이는 글(메모 본문 빼고 — 본문·표 칸·글상자)에서 빈칸을 뺀 글자 수 세기 → Map(글자 → 수) */
export function textCount(doc) {
  const out = new Map();
  for (const p of doc.paragraphs({ view: 'final', nested: true })) for (const ch of p.text) { if (/\s/.test(ch)) continue; out.set(ch, (out.get(ch) || 0) + 1); }
  return out;
}
const countOf = (m) => { let n = 0; for (const v of m.values()) n += v; return n; };
function addText(m, s, sign = 1) { for (const ch of String(s)) { if (/\s/.test(ch)) continue; m.set(ch, (m.get(ch) || 0) + sign); } }

/** 구역의 쪽 여백(HWPUNIT) | null */
function sectionMargins(sec) {
  const m = /<hp:pagePr\b[^>]*>\s*(<hp:margin\b[^>]*>)/.exec(sec.xml);
  if (!m) return null;
  return Object.fromEntries(MARGIN_KEYS.map((k) => [k, Number((new RegExp(`\\s${k}="(-?\\d+)"`).exec(m[1]) || [])[1] || 0)]));
}
function setSectionMargins(sec, mm) {
  const m = /<hp:pagePr\b[^>]*>\s*(<hp:margin\b[^>]*>)/.exec(sec.xml);
  if (!m) return false;
  let tag = m[1];
  for (const k of MARGIN_KEYS) {
    if (mm[k] == null) continue;
    const re = new RegExp(`(\\s${k}=")-?\\d+(")`);
    tag = re.test(tag) ? tag.replace(re, `$1${units(mm[k])}$2`) : tag.replace(/\s*\/?>$/, (end) => ` ${k}="${units(mm[k])}"${end}`);
  }
  const at = m.index + m[0].length - m[1].length;
  sec.load(sec.xml.slice(0, at) + tag + sec.xml.slice(at + m[1].length));
  return true;
}
const paperKey = (sec) => { const m = /<hp:pagePr\b[^>]*>/.exec(sec.xml); return m ? ['width', 'height', 'landscape'].map((k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(m[0]) || [])[1]).join('/') : ''; };

/** 글도 개체도 부호도 없는 빈 문단인가(구역 나누기 부호 secPr·colPr 는 있어도 된다) */
function emptyParagraph(p) {
  return !p.chars.length && !p.children.length
    && p.anchors.every((a) => a.kind === 'ctrl' && (a.name === 'hp:secPr' || (a.name === 'hp:ctrl' && a.inner === 'hp:colPr')));
}
/** 글·개체는 없고 메모(필드)만 달린 문단인가 — 지우지는 않지만(메모가 사라진다) 바로 뒤 글 문단을 끌어올릴 수 있다(메모는 그 문단 머리에 남는다) */
function blankWithMemos(p) {
  return !p.chars.length && p.children.every((c) => c.container === 'hp:fieldBegin')
    && p.anchors.every((a) => a.kind === 'ctrl' && (a.name === 'hp:secPr' || (a.name === 'hp:ctrl' && ['hp:colPr', 'hp:fieldBegin', 'hp:fieldEnd'].includes(a.inner))));
}
const hasPageFurniture = (xml) => /<hp:(?:header|footer|pageNum)\b/.test(xml);

const OBJECT_KINDS = ['table', 'figure', 'shape', 'chart'];
/**
 * removeRest 옵션 → [{ kinds, refs(Set | null = 옮긴 문단 모두) }].
 * true = 모든 종류, ['shape', …] = 그 종류, [{ kinds?, at? }] = 문단(at — 옮기기 전 주소)마다 따로(같은 호출의 delete_objects 를 합칠 때 server/mcp2/ops.js 가 만든다)
 */
function restRules(v) {
  if (v == null || v === false) return [];
  if (v === true) return [{ kinds: OBJECT_KINDS, refs: null }];
  if (!Array.isArray(v) || !v.length) return [];
  if (typeof v[0] === 'string') return [{ kinds: v.filter((k) => OBJECT_KINDS.includes(k)), refs: null }];
  return v.map((r) => ({ kinds: Array.isArray(r?.kinds) && r.kinds.length ? r.kinds.filter((k) => OBJECT_KINDS.includes(k)) : OBJECT_KINDS, refs: Array.isArray(r?.at) && r.at.length ? new Set(r.at) : null }));
}

/**
 * 떠 있는 글상자·괘선을 본문 문단·표로 옮긴다.
 * opts: refs(대상 본문 문단들 — 없으면 문서 전체), joinPages·keepPageNumbers·drop·headerRows·wrap(engine/layout.js analyzeLayout),
 *       margins('auto' 기본 — 여백이 모두 0 인 구역만 조각 위치로 추정해 넣는다 | 'keep' | { left, right, top, bottom, header, footer } mm),
 *       mergeSections(기본 true — 비게 된 구역 첫 문단을 지워 앞 구역에 합친다. 용지가 같고 머리말·꼬리말·쪽 번호가 없는 구역만),
 *       removeRest(기본 없음 — 옮긴 문단에 남는 개체[옮기지 못한 그림·표·차트·회전한 도형·안에 개체가 든 글상자]도 지운다: true | 종류 목록 | [{ kinds?, at? }]), author
 * → { report, mapping: [{ old: [구역, 문단], to: [구역, 문단] | null }] }
 *   report: { tables: [{ ref, key, rows, cols, headerRows, merges, pages }], paragraphs, removed, removedRest, kept, dropped: [{ text, why }], sections: [전, 후], margins,
 *             text: { source, moved, dropped, removedWithObjects, lost, extra } }
 */
export function objectsToBody(doc, opts = {}) {
  const layoutOpts = { refs: opts.refs || null, joinPages: opts.joinPages !== false, keepPageNumbers: opts.keepPageNumbers === true, drop: opts.drop || null, headerRows: opts.headerRows ?? null, wrap: opts.wrap || 'auto' };
  const before = textCount(doc);
  let plan = analyzeLayout(doc, layoutOpts);
  if (!plan.hosts.some((h) => h.used.size)) throw new EngineError('NO_OBJECTS', '본문으로 옮길 글상자·도형이 없습니다(떠 있는 글상자·선이 있는 문단이 대상입니다)');
  const sectionsBefore = doc.sections.length;
  const sizes = doc.sections.map((s) => s.bodyParas.length);

  // 1) 여백: 표 폭은 본문 폭으로 잡으므로 표를 넣기 전에 정한다
  let margins = null;
  if (opts.margins !== 'keep') {
    const given = opts.margins && typeof opts.margins === 'object' ? opts.margins : null;
    const auto = inferMargins(plan.hosts.filter((h) => h.used.size));
    let changed = false;
    for (const si of [...new Set(plan.hosts.filter((h) => h.used.size).map((h) => h.sec))]) {
      const cur = sectionMargins(doc.sections[si]);
      if (!cur || !(given || MARGIN_KEYS.every((k) => !cur[k]))) continue;
      const want = given ? Object.fromEntries(MARGIN_KEYS.filter((k) => given[k] != null).map((k) => [k, given[k]])) : auto;
      if (setSectionMargins(doc.sections[si], want)) { margins = want; changed = true; }
    }
    if (changed) plan = analyzeLayout(doc, layoutOpts);   // 구역 XML 이 바뀌었다 — 개체 위치를 다시 읽는다
  }

  // 2) 문단마다(뒤에서부터 — 앞 문단 주소·위치가 흔들리지 않게) 옮긴 개체를 지우고 그 뒤에 문단·표를 넣는다
  const order = doc.sections.map((s, si) => s.bodyParas.map((_, i) => `${si}/${i}`));   // 본문 자리 추적(원래 문단 = '구역/번호', 새로 넣은 것 = 객체)
  const flowOf = new Map(plan.flow.map((f) => [f.host, f.items]));
  const made = []; let paragraphs = 0; let removed = 0; let kept = 0;
  const moved = new Map();
  for (const h of [...plan.hosts].reverse()) {
    const [si, bi] = h.ref.slice(1).split('/p').map(Number);
    kept += h.kept;
    if (h.used.size) removed += doc.removeOwnObjects(h.ref, { kinds: ['shape'], pick: (a) => h.used.has(a.start) });
    const items = flowOf.get(h.ref) || [];
    for (let k = items.length - 1; k >= 0;) {
      if (items[k].type === 'para') {
        let j = k; while (j > 0 && items[j - 1].type === 'para') j--;
        const texts = items.slice(j, k + 1).map((x) => clean(x.text));
        doc.insertFinalParagraphsAfter(si, bi, texts);
        order[si].splice(bi + 1, 0, ...texts.map(() => ({ kind: 'para' })));
        for (const t of texts) addText(moved, t);
        paragraphs += texts.length; k = j - 1;
      } else {
        const t = plan.tables[items[k].table];
        const rows = t.grid.map((r) => r.map(clean));
        const res = doc.insertTableAfter(si, bi, { rows, headerRows: t.headerRows, caption: '' }, { author: opts.author || 'AI' });
        const ops = [{ op: 'col_widths', widths: t.widths }, ...t.merges.map((m) => ({ op: 'merge', range: { row_from: m.r, row_to: m.r + m.rs - 1, col_from: m.c, col_to: m.c + m.cs - 1 } }))];
        for (let i = 0; i < ops.length; i += 40) doc.editTable(res.tableKey, ops.slice(i, i + 40));
        const token = { kind: 'table', rows: t.rows, cols: t.cols, headerRows: t.headerRows, merges: t.merges.length, pages: t.hosts.length };
        order[si].splice(bi + 1, 0, token); made.push(token);
        for (const r of rows) for (const c of r) addText(moved, c);
        k--;
      }
    }
  }

  const tokenOf = (h) => h.ref.slice(1).replace('/p', '/');
  const where = (token) => { for (let s = 0; s < order.length; s++) { const i = order[s].indexOf(token); if (i >= 0) return [s, i]; } return null; };
  const paraAt = (s, i) => doc.sections[s].bodyParas[i];

  // 2-1) 남는 개체도 지우기(removeRest — 같은 호출의 delete_objects 를 합친 것 포함): 옮긴 문단에 남은 개체(옮기지 못한 그림·표·차트·회전한 도형·안에 개체가 든 글상자)
  //      가운데 고른 종류를 지운다. 안에 든 글도 함께 사라지므로 그 글자를 따로 세어 결과에 적고 글 보존 검사에서 뺀다(조용히 잃지 않는다)
  const restText = new Map(); let removedRest = 0;
  const rules = restRules(opts.removeRest);
  if (rules.length) {
    const jobs = [];
    for (const h of plan.hosts) {
      if (!h.used.size) continue;
      const kinds = [...new Set(rules.filter((r) => !r.refs || r.refs.has(h.ref)).flatMap((r) => r.kinds))];
      const at = kinds.length ? where(tokenOf(h)) : null;
      if (!at) continue;
      const ref = `s${at[0]}/p${at[1]}`;
      if (doc.ownObjects(ref).some((o) => kinds.includes(o.kind))) jobs.push({ ref, kinds });
    }
    if (jobs.length) {
      const had = textCount(doc);
      for (const j of jobs) removedRest += doc.removeOwnObjects(j.ref, { kinds: j.kinds });
      const has = textCount(doc);
      for (const [ch, n] of had) { const d = n - (has.get(ch) || 0); if (d > 0) restText.set(ch, d); }
      kept = Math.max(0, kept - removedRest);
    }
  }

  // 3) 비게 된 문단 정리: 구역 첫 문단(구역 나누기)은 앞 구역과 용지가 같으면 지워 구역을 합치고, 그 밖의 빈 문단은 지운다.
  //    지울 수 없는 첫 문단(문서 맨 앞 등)은 바로 뒤에 넣은 글 문단을 끌어올려 빈 줄을 남기지 않는다
  const hostTokens = plan.hosts.filter((h) => h.used.size).map(tokenOf);
  if (opts.mergeSections !== false && doc.sections.length > 1) {
    const mergeable = hostTokens.filter((tok) => {
      const at = where(tok); if (!at || at[1] !== 0 || at[0] === 0) return false;
      const sec = doc.sections[at[0]]; const prev = doc.sections[at[0] - 1];
      return emptyParagraph(paraAt(at[0], 0)) && paperKey(sec) === paperKey(prev) && !hasPageFurniture(sec.xml)
        && JSON.stringify(sectionMargins(sec)) === JSON.stringify(sectionMargins(prev));
    });
    if (mergeable.length) {
      doc.flattenSections();
      const flat = order.flat(); order.length = 0; order.push(flat);
      for (const tok of mergeable.reverse()) {
        const i = flat.indexOf(tok);
        doc.removeBodyParagraph(0, i); flat.splice(i, 1);
      }
      const starts = [];
      for (let i = 1; i < doc.sections[0].bodyParas.length; i++) if (doc.hasSectionBreak(`s0/p${i}`)) starts.push(i);
      if (starts.length) {
        doc.splitSectionsAt(starts);
        const parts = []; let from = 0;
        for (const s of [...starts, flat.length]) { parts.push(flat.slice(from, s)); from = s; }
        order.length = 0; order.push(...parts);
      }
    }
  }
  for (const tok of [...hostTokens].reverse()) {
    const at = where(tok); if (!at) continue;
    const [s, i] = at; const p = paraAt(s, i);
    if (!p) continue;
    if (i > 0 && emptyParagraph(p)) { doc.removeBodyParagraph(s, i); order[s].splice(i, 1); continue; }
    // 남는 빈 문단(구역 첫 문단이거나 메모가 달린 문단): 바로 뒤에 넣은 글 문단을 끌어올린다
    const next = order[s][i + 1];
    if (blankWithMemos(p) && next && typeof next === 'object' && next.kind === 'para') { doc.joinBodyParagraph(s, i + 1); order[s].splice(i + 1, 1); }
  }

  // 4) 글 보존 검사: 옮기기 전 글 = 옮긴 뒤 글 + 버린 글(쪽 번호 등) + 남는 개체와 함께 지운 글(removeRest). 어긋나면 적용하지 않는다(부르는 쪽이 사본에서 돌렸거나 되돌린다)
  const after = textCount(doc);
  const droppedText = new Map(); for (const d of plan.dropped) addText(droppedText, d.text);
  let lost = 0; let extra = 0;
  for (const ch of new Set([...before.keys(), ...after.keys()])) {
    const d = (before.get(ch) || 0) - (after.get(ch) || 0) - (droppedText.get(ch) || 0) - (restText.get(ch) || 0);
    if (d > 0) lost += d; else extra -= d;
  }
  if (lost || extra) throw new EngineError('FLOW_VERIFY', `옮긴 글이 원문과 맞지 않아 적용하지 않았습니다(빠진 글자 ${lost}개 · 늘어난 글자 ${extra}개)`);

  // 5) 주소 옮김표와 결과
  const mapping = []; const final = new Map();
  order.forEach((list, s) => list.forEach((tok, i) => { if (typeof tok === 'string') final.set(tok, [s, i]); else tok.ref = `s${s}/p${i}`; }));
  for (let s = 0; s < sectionsBefore; s++) for (let i = 0; i < sizes[s]; i++) mapping.push({ old: [s, i], to: final.get(`${s}/${i}`) || null });
  const report = {
    tables: made.reverse().map((t) => ({ ref: t.ref, key: `${t.ref}#t0`, rows: t.rows, cols: t.cols, headerRows: t.headerRows, merges: t.merges, pages: t.pages })),
    paragraphs, removed, removedRest, kept,
    dropped: plan.dropped.map((d) => ({ text: d.text, why: d.why })),
    sections: [sectionsBefore, doc.sections.length], margins,
    text: { source: countOf(before), moved: countOf(moved), dropped: countOf(droppedText), removedWithObjects: countOf(restText), lost, extra },
  };
  return { report, mapping };
}
