// [hwpx-cowork] 본문 문단 통째로 지우기·옮기기(2026-11-17 — docs/MCP_REDESIGN_2026-11-16.md §10.4 나-1).
// 새 MCP 연결의 delete_paragraphs·move_paragraphs op(server/mcp2/ops.js) → 제안 종류 para_delete·para_move(server/paragraph-ops.js)가 쓴다.
// 이 파일은 변경 추적 없이 하는 일(실시간 '고친 글만' 문서 — V4 §4.2)과 범위 검사만 맡는다. 변경 추적 문서의 지우기는 사람 편집 반영(server/live.js)과
// 같은 길(글·개체 지움 표식 → 앞 문단 끝 나눔 지움 — engine/track-objects.js BREAK_TRACK, 2026-10-30 한/글 2022 실측)을 서비스가 밟는다.
//  - 옮기기(추적 없음): 문단 XML 을 그대로 잘라 새 자리에 붙인다 — 표·그림·도형·메모·누름틀·각주가 원본 XML 그대로 따라간다(다시 만들지 않는다).
//    줄 정보(linesegarray)는 쪽 위치가 바뀌므로 옮긴 문단 것만 지운다(엔진·한/글이 다시 잰다 — 다른 편집 함수와 같은 규칙).
//  - 지우기(추적 없음): 문단마다 removeBodyParagraph(변경 표식·필드 짝 정리). 머리말·꼬리말 부호는 지우지 않고 앞 문단으로 옮긴다
//    (한/글은 조판 부호가 든 범위를 지우면 지울지 묻는다 — AI 의 절 지우기가 쪽 머리말을 함께 없애지 않게 '남김'을 고른 셈).
import crypto from 'node:crypto';
import { Section } from './section.js';
import { EngineError } from './errors.js';

const sectionBreakAt = (sec, p) => { const run = p.runs[0]; return !!run && sec.xml.slice(run.start, run.end).includes('<hp:secPr'); };
const FIELD_NAMES = { MEMO: '메모', CLICK_HERE: '누름틀', HYPERLINK: '하이퍼링크', TABLEOFCONTENTS: '차례', BOOKMARK: '책갈피', CROSSREF: '상호 참조' };

/**
 * 구역 secIndex 의 본문 문단 from..to(최종본 번호, 양끝 포함)가 통째로 지우거나 옮길 수 있는 범위인가 → { sec, recs, start, end }(XML 자리). 아니면 EngineError:
 *  NO_SECTION · NO_PARAGRAPH(범위 밖) · FIRST_PARAGRAPH(구역 첫 문단 — 구역 정의 secPr 를 품는다) · SECTION_BREAK(구역 가운데 구역 나누기 문단) ·
 *  FIELD_SPLIT(필드가 범위 안팎에 걸침 — 차례·누름틀·하이퍼링크 …; 메모는 지우기면 괜찮다: removeBodyParagraph 가 짝을 정리한다)
 */
export function paragraphRange(doc, secIndex, from, to, { move = false } = {}) {
  const sec = doc.sections[secIndex];
  if (!sec) throw new EngineError('NO_SECTION', `구역이 없습니다: s${secIndex}(구역은 0~${doc.sections.length - 1})`);
  const n = sec.bodyParas.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= n) throw new EngineError('NO_PARAGRAPH', `구역 ${secIndex} 의 본문 문단은 s${secIndex}/p0~p${n - 1} 입니다(받은 범위 p${from}~p${to})`);
  if (from === 0) throw new EngineError('FIRST_PARAGRAPH', `s${secIndex}/p0 은 구역의 첫 문단(구역 정의 — 용지·여백·쪽 번호를 품는다)이라 통째로 지우거나 옮길 수 없습니다. 그 글은 replace(whole:true, with:'')로 비우고, 나머지 문단(p1부터)만 고르세요`);
  const recs = sec.bodyParas.slice(from, to + 1);
  const brk = recs.find((p) => sectionBreakAt(sec, p));
  if (brk) throw new EngineError('SECTION_BREAK', `${brk.ref} 은 구역 나누기 문단이라 통째로 지우거나 옮길 수 없습니다(구역을 합치려면 merge_section op). 범위를 그 앞·뒤로 나누세요`);
  const start = recs[0].start; const end = recs[recs.length - 1].end;
  const begins = new Map(); const ends = new Map();
  for (const q of sec.paras) {
    for (const a of Section.fieldCtrls(q)) {
      const inside = a.start >= start && a.end <= end;
      if (a.inner === 'hp:fieldBegin') begins.set(a.innerAttrs?.get('id'), { inside, type: a.innerAttrs?.get('type') || '' });
      else ends.set(a.innerAttrs?.get('beginIDRef'), { inside });
    }
  }
  for (const [id, b] of begins) {
    const e = ends.get(id);
    if (!e || e.inside === b.inside) continue;
    if (b.type === 'MEMO' && !move) continue;
    throw new EngineError('FIELD_SPLIT', `${FIELD_NAMES[b.type] || '필드'}(${b.type || '?'})가 범위 안팎에 걸쳐 있습니다 — ${b.type === 'TABLEOFCONTENTS' ? '차례를 고치려면 toc op, 차례째 지우려면 차례 문단 모두를' : '그 필드의 시작·끝 문단을 모두'} 범위에 넣거나 빼세요`);
  }
  return { sec, recs, start, end };
}

/** 본문 문단 범위의 XML(지운 뒤 되살리기·미리 보기용) */
export function paragraphRangeXml(doc, secIndex, from, to) {
  const sec = doc.sections[secIndex];
  return sec.xml.slice(sec.bodyParas[from].start, sec.bodyParas[to].end);
}

/**
 * 변경 추적 없이 본문 문단 from..to 를 after 문단 뒤로 옮긴다(XML 그대로 — 위 머리 설명). after 는 옮기기 전 번호, 범위 앞(from−1)·안이면 던진다.
 * → { from, to }(옮긴 뒤 번호). 부르는 쪽 주소 옮김은 moveIndexMap(from, to, after)
 */
export function moveParagraphsRaw(doc, secIndex, from, to, after) {
  const { sec, recs, start, end } = paragraphRange(doc, secIndex, from, to, { move: true });
  if (!Number.isInteger(after) || after < 0 || after >= sec.bodyParas.length) throw new EngineError('NO_PARAGRAPH', `옮길 자리 s${secIndex}/p${after} 이 없습니다`);
  if (after >= from && after <= to) throw new EngineError('INSIDE', `옮길 자리(s${secIndex}/p${after})가 옮길 범위 안입니다`);
  if (after === from - 1) throw new EngineError('SAME_PLACE', `그 문단들은 이미 s${secIndex}/p${after} 바로 뒤에 있습니다`);
  const xml = sec.xml;
  const pos = sec.bodyParas[after].end;
  const drops = recs.flatMap((p) => Section.linesegs(p)).sort((x, y) => x.start - y.start);
  let moved = ''; let at = start;
  for (const ls of drops) { moved += xml.slice(at, ls.start); at = ls.end; }
  moved += xml.slice(at, end);
  sec.load(pos >= end ? xml.slice(0, start) + xml.slice(end, pos) + moved + xml.slice(pos) : xml.slice(0, pos) + moved + xml.slice(pos, start) + xml.slice(end));
  const count = to - from + 1;
  const nf = after > to ? after - count + 1 : after + 1;
  return { from: nf, to: nf + count - 1 };
}

/** moveParagraphsRaw(from, to, after) 뒤의 본문 번호 옮김 i → 새 번호(같은 구역 안의 자리 바꿈 — 없어지는 번호는 없다) */
export function moveIndexMap(from, to, after) {
  const count = to - from + 1;
  if (after > to) return (i) => (i >= from && i <= to ? i - from + after - count + 1 : i > to && i <= after ? i - count : i);
  return (i) => (i >= from && i <= to ? after + 1 + i - from : i > after && i < from ? i + count : i);
}

/**
 * 변경 추적 없이 본문 문단 from..to 를 통째로 지운다(문단마다 removeBodyParagraph — 뒤에서부터). 머리말·꼬리말 부호는 앞 문단(from−1)으로 옮기고,
 * 아무도 안 쓰게 된 그림 파일·차트 부분은 거둔다(server/live.js 의 문단 지우기와 같은 정리). → { removed, headerFooters }
 */
export function removeParagraphsRaw(doc, secIndex, from, to) {
  paragraphRange(doc, secIndex, from, to);
  const hfs = [];
  for (let i = from; i <= to; i++) hfs.push(...doc.takeHeaderFooters(`s${secIndex}/p${i}`));
  const gone = paragraphRangeXml(doc, secIndex, from, to);
  const bins = [...new Set([...gone.matchAll(/binaryItemIDRef="([^"]+)"/g)].map((m) => m[1]))];
  for (let i = to; i >= from; i--) doc.removeBodyParagraph(secIndex, i);
  if (hfs.length) doc.putHeaderFooters(`s${secIndex}/p${from - 1}`, hfs);
  for (const b of bins) doc.removeUnusedBinary(b);
  if (gone.includes('chartIDRef=') && typeof doc._releaseShapeParts === 'function') doc._releaseShapeParts(gone);
  return { removed: to - from + 1, headerFooters: hfs.length };
}

// ───────── 제안·미리 해 보기 공용(문서를 바꾸지 않는다 — server/paragraph-ops.js·server/mcp2/ops.js) ─────────

const BODY = /^s(\d+)\/p(\d+)$/;
const parseBody = (ref) => { const m = BODY.exec(String(ref || '')); return m ? { sec: Number(m[1]), body: Number(m[2]) } : null; };
const sig = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const PREVIEW_LINES = 3;

/** 본문 문단 하나의 지문(최종본 글 + 개체 종류) — 제안한 뒤 그 문단이 바뀌었는지 */
export function paragraphPrint(doc, ref) {
  let objs = [];
  try { objs = doc.ownObjects(ref).map((o) => o.name); } catch { objs = []; }
  return sig(`${doc.text(ref, 'final')}${String.fromCharCode(1)}${objs.join(',')}`);
}

/** 문단 한 줄 보기(제안 카드·미리 해 보기): 글 앞부분(개체가 있으면 [표] 머리), 비었으면 '(빈 줄)' */
export function paragraphLabel(doc, ref, max = 40) {
  let t = ''; try { t = doc.text(ref, 'final').replace(/\s+/g, ' ').trim(); } catch { return '(없음)'; }
  let objs = []; try { objs = doc.ownObjects(ref).map((o) => o.name); } catch { objs = []; }
  const head = objs.length ? `[${[...new Set(objs)].join('·')}] ` : '';
  if (!t) return head ? head.trim() : '(빈 줄)';
  const cps = [...t];
  return head + (cps.length > max ? `${cps.slice(0, max).join('')}…` : t);
}

/**
 * 지우기·옮기기 범위를 문서에 맞춰 검사하고 풀어 둔다(제안·미리 해 보기 공용).
 * spec: { ref, toRef?, afterRef?, beforeRef? } → { sec, from, to, count, after?, refs, first, last?, prints, dest? } | EngineError
 */
export function planParagraphs(doc, spec, { move = false } = {}) {
  const a = parseBody(spec.ref); const b = parseBody(spec.toRef || spec.ref);
  const bad = (code, msg) => new EngineError(code, msg);
  if (!a || !b) throw bad('BAD_REF', `본문 문단 주소가 필요합니다(예: s1/p8, 범위 s1/p8..p13): ${spec.ref}${spec.toRef ? `..${spec.toRef}` : ''} — 표 칸·글상자 안 문단은 통째로 지울 수 없습니다(그 글은 replace 로)`);
  if (a.sec !== b.sec) throw bad('CROSS_SECTION', `범위가 구역을 넘습니다(s${a.sec} → s${b.sec}) — 구역마다 op 를 나누세요`);
  const from = Math.min(a.body, b.body); const to = Math.max(a.body, b.body);
  paragraphRange(doc, a.sec, from, to, { move });
  const count = to - from + 1;
  const refs = Array.from({ length: count }, (_, k) => `s${a.sec}/p${from + k}`);
  const out = { sec: a.sec, from, to, count, refs, prints: refs.map((r) => paragraphPrint(doc, r)) };
  out.first = refs.slice(0, PREVIEW_LINES).map((r) => paragraphLabel(doc, r));
  if (count > PREVIEW_LINES) out.last = paragraphLabel(doc, refs[count - 1]);
  if (!move) return out;
  const other = '다른 구역으로는 아직 옮길 수 없습니다(같은 구역 안에서만) — 옮길 글을 insert 로 새로 넣고 원래 문단은 delete_paragraphs 로 지우세요';
  let after; let before = null;
  if (spec.beforeRef != null) {
    const d = parseBody(spec.beforeRef);
    if (!d) throw bad('BAD_REF', `옮길 자리(before)는 본문 문단 주소입니다: ${spec.beforeRef}`);
    if (d.sec !== a.sec) throw bad('CROSS_SECTION', other);
    if (d.body === 0) throw bad('FIRST_PARAGRAPH', `s${d.sec}/p0(구역 첫 문단) 앞으로는 옮길 수 없습니다 — after:'s${d.sec}/p0' 처럼 그 뒤로 고르세요`);
    after = d.body - 1; before = spec.beforeRef;
  } else {
    const d = parseBody(spec.afterRef);
    if (!d) throw bad('BAD_REF', `옮길 자리(after 또는 before)가 본문 문단 주소여야 합니다: ${spec.afterRef ?? '(없음)'}`);
    if (d.sec !== a.sec) throw bad('CROSS_SECTION', other);
    after = d.body;
  }
  const n = doc.sections[a.sec].bodyParas.length;
  if (after < 0 || after >= n) throw bad('NO_PARAGRAPH', `옮길 자리 s${a.sec}/p${after} 이 없습니다`);
  if (after >= from && after <= to) throw bad('INSIDE', `옮길 자리(${before ? `before ${before}` : `after s${a.sec}/p${after}`})가 옮길 범위 s${a.sec}/p${from}..p${to} 안입니다`);
  if (after === from - 1) throw bad('SAME_PLACE', `그 문단들은 이미 그 자리에 있습니다(s${a.sec}/p${after} 바로 뒤)`);
  out.after = after;
  out.dest = { ref: `s${a.sec}/p${after}`, text: paragraphLabel(doc, `s${a.sec}/p${after}`), ...(before ? { before: true, beforeText: paragraphLabel(doc, before) } : {}) };
  return out;
}

/** 미리 해 보기(dry_run)의 한 줄: 지울·옮길 문단 수와 첫 글, 결과 차례 */
export function paragraphsPreview(doc, plan, { move = false } = {}) {
  const q = (s) => `「${s}」`;
  const list = [...plan.first.map(q), ...(plan.last ? ['…', q(plan.last)] : [])].join(' · ');
  const range = `s${plan.sec}/p${plan.from}..p${plan.to}`;
  const n = doc.sections[plan.sec].bodyParas.length;
  const at = (i) => (i >= 0 && i < n ? q(paragraphLabel(doc, `s${plan.sec}/p${i}`, 24)) : '(구역 끝)');
  if (!move) return `문단 ${plan.count}개를 지운다(${range}: ${list}) → 결과: ${at(plan.from - 1)} 다음에 ${at(plan.to + 1)}`;
  const next = plan.after + 1 === plan.from ? plan.to + 1 : plan.after + 1;
  return `문단 ${plan.count}개를 옮긴다(${range}: ${list}) → 결과: ${at(plan.after)} 다음에 옮긴 ${plan.count}개, 그다음 ${at(next)} · 원래 자리는 ${at(plan.from - 1)} 다음에 ${at(plan.to + 1)}`;
}

const OBJECT_ID = /<hp:(?:tbl|pic|rect|line|ellipse|arc|polygon|curve|connectLine|container|equation|ole|textart)\b[^>]*?\sid="(\d+)"/g;
const FIELD_ID = /<hp:fieldBegin\b[^>]*?\sid="(\d+)"/g;

/**
 * 지운 문단을 사본(source — 지우기 직전 문서)의 XML 그대로 secIndex 의 after 문단 뒤에 다시 넣는다(실시간 '고친 글만' 지우기 되돌리기 — 그 뒤 문서가 바뀐 경우).
 * 메모·누름틀·각주·표·그림이 원본 그대로 돌아온다(그림 파일은 이 문서로 다시 옮긴다 — _importBinary). 차트가 들었거나(차트 부분 파일을 다시 들여야 한다)
 * 개체·필드 id 가 그새 이 문서의 다른 것과 겹치면 null — 부르는 쪽이 문단을 다시 만든다(copyObjectsFrom 길) → true | null
 */
export function insertParagraphsFrom(doc, secIndex, after, source, srcSec, from, to) {
  const sec = doc.sections[secIndex];
  if (!sec || !source.sections[srcSec] || after < 0 || after >= sec.bodyParas.length) return null;
  let x = paragraphRangeXml(source, srcSec, from, to);
  if (/chartIDRef=|<hp:secPr/.test(x)) return null;
  const all = doc.sections.map((s) => s.xml).join('');
  const taken = (re) => { const have = new Set([...all.matchAll(re)].map((m) => m[1])); return [...x.matchAll(re)].some((m) => have.has(m[1])); };
  if (taken(OBJECT_ID) || taken(FIELD_ID)) return null;
  const bins = new Map();
  for (const m of x.matchAll(/binaryItemIDRef="([^"]+)"/g)) if (!bins.has(m[1])) bins.set(m[1], doc._importBinary(source, m[1]));
  x = x.replace(/binaryItemIDRef="([^"]+)"/g, (m, id) => `binaryItemIDRef="${bins.get(id)}"`);
  const pos = sec.bodyParas[after].end;
  sec.load(sec.xml.slice(0, pos) + x + sec.xml.slice(pos));
  return true;
}
