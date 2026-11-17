// 편집 뒤 검증(2026-11-12 — research/edit-preservation-20261112/verify/ledger.md). 서버가 문서를 저장하기 직전에(_finish → store.commit)
// 그 저장 바이트를 다시 읽어 본다.
//   · V1 구조(막음): 저장할 바이트가 다시 열리는가(zip 목록·파일 이름, 구역·header·매니페스트 XML 짝 — 엔진 xmlscan·Section 은 던지지 않는
//     관대한 읽기라 더 엄격한 xmlProblem 으로 본다), ID 참조(charPrIDRef·paraPrIDRef·styleIDRef·borderFillIDRef 가
//     header 에 있음, binaryItemIDRef 가 매니페스트·파일에 있음), 변경 추적 표시(넣음·지움 시작/끝 Id 짝, 머리 항목), 필드(메모 등) fieldBegin/fieldEnd 짝.
//     '이번 편집이 새로 만든 문제'만 막는다(편집 전 문서에 이미 있던 문제는 세지 않는다 — 한/글이 만든 옛 문서의 짝 없는 표시 등). 실패면 저장하지 않는다.
//   · V2 의도(경고): 이번 커밋에서 적용된 제안이 실제로 문서에 들어갔고(바꿀 글·넣을 글·서식) 대상 밖 문단이 바뀌지 않았는가(편집 전후 —
//     바뀐 구역만 본문 문단 단위로 견주는 narrowDiff, 구역 수가 바뀌면 diffDocs 전체). 대기 제안만 만든 커밋(lean 의 보통 쓰기)에는 돌지 않는다.
//     결과는 제안 객체의 기호 키(VERIFY_NOTE)에만 싣는다 — JSON(기본 MCP 연결·REST·meta)에는 나오지 않고 lean 영수증만 읽는다(server/lean.js).
// 큰 문서: 전체 HwpxDoc.load(3.2MB 문서 ~130ms) 대신 부분(구역·header) 내용 지문(컨테이너가 저장하며 센 sha256)으로 앞서 본 부분의 요약을
// 다시 쓰고 바뀐 부분만 훑는다. 편집 전 문제 열쇠는 앞 커밋의 것을 기억해 쓴다(처음 한 번만 지금 기록 파일을 읽음).
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { diffArrays } from 'diff';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { Section } from '../engine/section.js';

/** 제안 객체에 V2 경고 글을 다는 기호 키(JSON 에 나오지 않는다). lean.js 는 엔진을 불러오지 않으려고 같은 Symbol.for 이름을 쓴다 */
export const VERIFY_NOTE = Symbol.for('hwpx-cowork.verifyNote');

const HEADER = 'Contents/header.xml';
const MANIFEST = 'Contents/content.hpf';
const SECTION_RE = /^Contents\/section\d+\.xml$/;
const ID_KINDS = { charPrIDRef: 'charPr', paraPrIDRef: 'paraPr', styleIDRef: 'style', borderFillIDRef: 'borderFill' };
const REF_RE = /\b(charPrIDRef|paraPrIDRef|styleIDRef|borderFillIDRef)="([^"]*)"/g;
const BIN_RE = /\bbinaryItemIDRef="([^"]*)"/g;
const MARK_RE = /<hp:(insert|delete)(Begin|End)\b([^>]*)>/g;
const FIELD_BEGIN_RE = /<hp:fieldBegin\b([^>]*)>/g;
const FIELD_END_RE = /<hp:fieldEnd\b([^>]*)>/g;
// '참조 없음' 값: 빈 값과 0xFFFFFFFF(한/글이 쓰는 -1 — 실제 문서 header 의 charPrIDRef="4294967295"·binaryItemIDRef="" 확인)
const NO_REF = new Set(['', '4294967295']);
const attrOf = (a, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(a)?.[1] ?? null;

// ───────── XML 짝(잘 짜인 XML) ─────────
// 태그 하나: 이름 + 속성(따옴표 안의 > 허용) + 빈 태그 / 주석·CDATA·처리 명령·DOCTYPE
const TAG_RE = /<(\/?)([A-Za-z_][\w:.\-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g;
const BAD_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/;
const BAD_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;
/** XML 이 잘 짜였는가 → null(문제 없음) | 첫 문제 설명. 한/글이 열지 못하는 꼴(짝 없는 태그·맨 & ·맨 < ·금지 제어 문자)만 본다 */
export function xmlProblem(xml) {
  const s = String(xml ?? '');
  const bad = BAD_CHAR.exec(s); if (bad) return `금지 제어 문자 U+${bad[0].charCodeAt(0).toString(16).padStart(4, '0')} (${bad.index}자)`;
  const stack = []; let last = 0; let root = 0;
  TAG_RE.lastIndex = 0;
  for (let m; (m = TAG_RE.exec(s));) {
    const between = s.slice(last, m.index);
    if (between.includes('<')) return `태그가 아닌 < (${last + between.indexOf('<')}자)`;
    if (BAD_AMP.test(between)) return `이스케이프 안 된 & (${last}자 뒤)`;
    last = TAG_RE.lastIndex;
    if (m[2] == null) continue;   // 주석·CDATA·처리 명령
    if (m[3] && (m[3].includes('<') || BAD_AMP.test(m[3]))) return `속성 값의 < 또는 & (<${m[2]}> ${m.index}자)`;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) return `닫는 태그 </${m[2]}> 가 <${open ?? '(없음)'}> 와 짝이 맞지 않음 (${m.index}자)`;
    } else if (!m[4]) { if (!stack.length) root++; stack.push(m[2]); } else if (!stack.length) root++;
  }
  const tail = s.slice(last);
  if (tail.includes('<')) return `태그가 아닌 < (${last + tail.indexOf('<')}자)`;
  if (stack.length) return `닫히지 않은 <${stack[stack.length - 1]}> (열린 태그 ${stack.length}개)`;
  if (root !== 1) return `뿌리 요소가 ${root}개`;
  return null;
}

// ───────── 부분 요약(지문으로 다시 씀) ─────────
/** 구역·header 한 부분의 요약: 참조한 번호들·변경 추적 표시·필드 짝 재료·XML 문제·(구역) 엔진 읽기 문제 */
function partSummary(name, xml, { parse = false } = {}) {
  const sum = { xml: xmlProblem(xml), read: null, refs: {}, bins: new Set(), marks: [], fieldBegins: [], fieldEnds: [] };
  for (const k of Object.keys(ID_KINDS)) sum.refs[k] = new Set();
  for (const m of xml.matchAll(REF_RE)) sum.refs[m[1]].add(m[2]);
  for (const m of xml.matchAll(BIN_RE)) sum.bins.add(m[1]);
  for (const m of xml.matchAll(MARK_RE)) sum.marks.push({ kind: m[1].toLowerCase(), end: m[2] === 'End', id: attrOf(m[3], 'Id'), tc: attrOf(m[3], 'TcId') });
  for (const m of xml.matchAll(FIELD_BEGIN_RE)) sum.fieldBegins.push(attrOf(m[1], 'id'));
  for (const m of xml.matchAll(FIELD_END_RE)) sum.fieldEnds.push(attrOf(m[1], 'beginIDRef'));
  if (name === HEADER) {
    sum.ids = {};
    for (const kind of Object.values(ID_KINDS)) sum.ids[kind] = new Set([...xml.matchAll(new RegExp(`<hh:${kind}\\b[^>]*?\\bid="([^"]*)"`, 'g'))].map((m) => m[1]));
    sum.changes = new Set([...xml.matchAll(/<hh:trackChange\b[^>]*?\bid="([^"]*)"/g)].map((m) => m[1]));
  }
  // 엔진이 이 구역을 다시 읽을 수 있는가(편집 직후 바뀐 구역만 — 앞서 본 내용은 지문으로 건너뛴다)
  if (parse && SECTION_RE.test(name)) { try { new Section(xml, 0); } catch (e) { sum.read = e.message || String(e); } }
  return sum;
}

// 지문 → 요약(모든 저장소 공용, 오래된 것부터 버림). 같은 내용이면 같은 요약이라 공유해도 된다.
// 지문은 컨테이너가 저장하며 이미 센 sha256(HwpxContainer._savedEntries)을 쓰고, 없으면 여기서 센다
const SUMMARY_MAX = 256;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');   // HwpxContainer 와 같은 지문
const summaries = new Map();
function cachedSummary(name, xml, hash, opts) {
  const key = `${name}\u0000${hash || sha256(Buffer.from(xml, 'utf8'))}`;
  const hit = summaries.get(key);
  if (hit) {
    // 앞서 '편집 전'으로 훑기만 한 부분을 이제 엔진으로 읽어 본다(요약은 같다)
    if (opts?.parse && !hit.parsed && SECTION_RE.test(name)) { try { new Section(xml, 0); } catch (e) { hit.sum = { ...hit.sum, read: e.message || String(e) }; } hit.parsed = true; }
    summaries.delete(key); summaries.set(key, hit); return hit.sum;
  }
  const sum = partSummary(name, xml, opts);
  summaries.set(key, { sum, parsed: !!opts?.parse });
  while (summaries.size > SUMMARY_MAX) summaries.delete(summaries.keys().next().value);
  return sum;
}

/** 저장 바이트(zip) → 부분 글 { names: zip 안 파일 이름, header, manifest, sections: [[이름, 글, 지문]] }. zip 이 깨졌으면 던진다 */
async function readParts(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  const dec = new TextDecoder('utf-8');
  const raw = async (n) => (names.has(n) ? zip.files[n].async('uint8array') : null);
  const text = async (n) => { const b = await raw(n); return b == null ? null : dec.decode(b); };
  const withHash = async (n) => { const b = await raw(n); return b == null ? [null, null] : [dec.decode(b), sha256(b)]; };
  const manifest = await text(MANIFEST);
  let order = [];
  if (manifest) for (const m of manifest.matchAll(/<opf:item\b[^>]*href="([^"]+)"[^>]*>/g)) if (SECTION_RE.test(m[1])) order.push(m[1]);
  if (!order.length) order = [...names].filter((n) => SECTION_RE.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const sections = [];
  for (const n of order) sections.push([n, ...(await withHash(n))]);
  const [header, headerHash] = await withHash(HEADER);
  return { names, header, headerHash, manifest, sections };
}

/**
 * 방금 저장한 문서(doc.save() 뒤) → 부분 글. 저장 바이트의 zip 목록을 다시 열어(깨졌으면 던짐) 파일 이름이 컨테이너와 같은지 보고,
 * 부분 글은 그 zip 에 들어간 컨테이너 글(같은 바이트)을 쓴다 — 큰 구역을 다시 풀지 않는다
 */
async function savedParts(doc, bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  const c = doc.container;
  const missing = [...c.files.keys()].filter((n) => !names.has(n));
  if (missing.length) throw new Error(`zip 에 빠진 파일: ${missing.slice(0, 3).join(', ')}`);
  const hash = (n) => c._savedEntries?.get?.(n)?.hash || null;
  const order = c.sectionNames();
  return { names, header: c.getText(HEADER), headerHash: hash(HEADER), manifest: c.getText(MANIFEST), sections: order.map((n) => [n, c.getText(n), hash(n)]) };
}

/**
 * 부분 글 → 구조 문제 { key → 설명 }. key 는 편집 전후를 견줄 열쇠(같은 문제는 같은 key).
 * parse: 엔진 Section 으로 다시 읽어 볼 부분(지문 캐시에 '읽어 봄'이 없을 때만 실제로 읽는다)
 */
export function structureIssues(parts, { parse = true } = {}) {
  const issues = new Map();
  const add = (key, text) => { if (!issues.has(key)) issues.set(key, text); };
  if (parts.header == null) add('part:header', `${HEADER} 가 없음`);
  const sums = [];
  if (parts.header != null) sums.push([HEADER, cachedSummary(HEADER, parts.header, parts.headerHash, { parse: false })]);
  for (const [n, xml, hash] of parts.sections) {
    if (xml == null) { add(`part:${n}`, `${n} 가 매니페스트에는 있는데 파일이 없음`); continue; }
    sums.push([n, cachedSummary(n, xml, hash, { parse })]);
  }
  if (!parts.sections.length) add('part:sections', '구역 파일이 없음');
  if (parts.manifest != null) { const p = xmlProblem(parts.manifest); if (p) add(`xml:${MANIFEST}`, `${MANIFEST} XML 오류: ${p}`); }
  const head = sums.find(([n]) => n === HEADER)?.[1];
  // 매니페스트 항목 id → 파일
  const items = new Map();
  for (const m of String(parts.manifest || '').matchAll(/<opf:item\b([^>]*)>/g)) { const id = attrOf(m[1], 'id'); if (id != null) items.set(id, attrOf(m[1], 'href')); }
  const marks = new Map(); const begins = new Map(); const ends = new Map();
  for (const [n, s] of sums) {
    if (s.xml) add(`xml:${n}`, `${n} XML 오류: ${s.xml}`);
    if (s.read) add(`read:${n}`, `${n} 를 엔진이 다시 읽지 못함: ${s.read}`);
    if (head?.ids) {
      for (const [attr, kind] of Object.entries(ID_KINDS)) for (const id of s.refs[attr]) if (!NO_REF.has(id) && !head.ids[kind].has(id)) add(`ref:${attr}:${id}`, `${attr}="${id}" 가 header 의 ${kind} 에 없음(${n})`);
    }
    for (const id of s.bins) {
      if (NO_REF.has(id)) continue;
      if (!items.has(id)) add(`bin:${id}`, `binaryItemIDRef="${id}" 가 매니페스트(content.hpf)에 없음(${n})`);
      else if (items.get(id) && !parts.names.has(items.get(id))) add(`binfile:${id}`, `binaryItemIDRef="${id}" 의 파일 ${items.get(id)} 가 없음`);
    }
    // 같은 Id 의 표시는 문서 차례(구역 차례 → XML 차례)로 시작 → 끝 짝을 맞춘다: 열린 것 없이 끝(nobegin), 열린 채 또 시작(nested), 끝까지 열림(noend).
    // 같은 Id 로 시작·끝 여러 쌍은 정상으로 둔다(2026-11-12 이 PC 의 HWPX 30,861개 중 표시가 있는 22개에는 여러 쌍·개수 다름이 없었다 — 막지 않는 쪽)
    for (const mk of s.marks) {
      const k = `${mk.kind}:${mk.id}`; const e = marks.get(k) || { depth: 0, nobegin: false, nested: false, tc: new Set() };
      if (mk.end) { if (e.depth) e.depth--; else e.nobegin = true; }
      else { if (e.depth) e.nested = true; e.depth++; }
      e.tc.add(mk.tc ?? mk.id); marks.set(k, e);
    }
    for (const id of s.fieldBegins) begins.set(id, (begins.get(id) || 0) + 1);
    for (const id of s.fieldEnds) ends.set(id, (ends.get(id) || 0) + 1);
  }
  const KIND = { insert: '넣음', delete: '지움' };
  for (const [k, e] of marks) {
    const [kind, id] = k.split(':');
    if (id === 'null') { add(`track:${kind}:noid`, `변경 추적 ${KIND[kind]} 표시에 Id 가 없음`); continue; }
    if (e.depth) add(`track:${k}:noend`, `변경 추적 ${KIND[kind]} 시작(Id=${id})의 끝 표시가 없음`);
    if (e.nobegin) add(`track:${k}:nobegin`, `변경 추적 ${KIND[kind]} 끝(Id=${id})의 시작 표시가 없음`);
    if (e.nested) add(`track:${k}:nested`, `변경 추적 ${KIND[kind]} 시작(Id=${id})이 끝나기 전에 같은 Id 로 다시 시작함`);
    if (head?.changes) for (const tc of e.tc) if (tc != null && !head.changes.has(tc)) add(`track:${k}:nohead:${tc}`, `변경 추적 ${KIND[kind]} 표시(Id=${id}) 의 머리 항목 trackChange id="${tc}" 가 header 에 없음`);
  }
  for (const [id, n] of begins) {
    if (n > 1) add(`field:${id}:dup`, `필드 시작 id="${id}" 가 ${n}번 있음`);
    if (!ends.has(id)) add(`field:${id}:noend`, `필드 시작(fieldBegin id="${id}" — 메모 등)의 끝(fieldEnd beginIDRef)이 없음`);
  }
  for (const id of ends.keys()) if (!begins.has(id)) add(`field:${id}:nobegin`, `필드 끝(fieldEnd beginIDRef="${id}")의 시작이 없음`);
  return issues;
}

// 저장소·문서별 '마지막으로 본 기록'의 문제 열쇠(편집 전 상태). 커밋 뒤 저장된 바이트로 채운다
const lastSeen = new WeakMap();
const seenOf = (store) => { let m = lastSeen.get(store); if (!m) { m = new Map(); lastSeen.set(store, m); } return m; };

/**
 * 이 커밋을 검사하는가: 서버가 문서를 고친 커밋만 — 통째 바꾸기(ctx.bytes)·편집기 밀어 넣기(server/live.js)·편집본 올림(uploadEdited)·
 * 변경 요청 반영(crs.js)은 사람이 만든 파일이 기준이라 그 자리에서 ctx.skipVerify 를 켠다(기록 note 글로 가르지 않는다).
 */
export function shouldVerify(ctx, note) { // eslint-disable-line no-unused-vars
  return !!ctx?.dirty && !ctx.bytes && ctx.liveSeq == null && !ctx.skipVerify;
}

/**
 * V1: 저장할 바이트 검사. before = 편집 전 문제 열쇠(Set) — 없으면 그 저장소의 지금 기록 파일(current.hwpx)로 센다.
 * → { ok, bytes, fresh: [{ key, text }](새 문제), all: Map, ms, parts }
 */
export async function verifyStructure(bytes, { doc = null, store = null, id = null, version = null, before = null, sections = null, parse = false } = {}) {
  const t0 = performance.now();
  let parts;
  try { parts = doc ? await savedParts(doc, bytes) : await readParts(bytes); }
  catch (e) { return { ok: false, bytes, fresh: [{ key: 'zip', text: `저장할 파일(zip)을 다시 열지 못함: ${e.message}` }], all: new Map(), ms: performance.now() - t0 }; }
  const all = structureIssues(parts, { parse });
  if (sections != null && parts.sections.length !== sections) all.set('part:count', `구역 수가 ${sections} → ${parts.sections.length}`);
  let base = before;
  if (!base && store && id != null) {
    const seen = seenOf(store).get(String(id));
    if (seen && seen.version === version) base = seen.keys;
    else {
      try { base = new Set(structureIssues(await readParts(store.currentBytes(id)), { parse: false }).keys()); }
      catch { base = new Set(); }
    }
  }
  base ||= new Set();
  const fresh = [...all].filter(([k]) => !base.has(k)).map(([key, text]) => ({ key, text }));
  return { ok: !fresh.length, bytes, fresh, all, ms: performance.now() - t0, parts };
}

/** 커밋한 뒤: 이 기록의 문제 열쇠를 다음 커밋의 '편집 전'으로 기억한다 */
export function rememberVerified(store, id, version, all) {
  if (!store || id == null || !all) return;
  seenOf(store).set(String(id), { version, keys: new Set(all.keys()) });
}

/** V1 실패 글(모델이 읽고 다음 할 일을 정한다) */
export function structureFailMessage(fresh, { max = 5 } = {}) {
  const list = fresh.slice(0, max).map((x) => x.text).join(' / ');
  const more = fresh.length > max ? ` 외 ${fresh.length - max}건` : '';
  return `저장하지 않았습니다 — 이번 편집 결과가 문서 구조 검사(V1)를 통과하지 못했습니다(새 문제 ${fresh.length}건: ${list}${more}). `
    + '문서는 이 호출 전 그대로입니다. read_document 로 대상 문단을 다시 읽고 같은 편집을 다시 내거나(서식·runs 를 빼고 글만 내 보기), '
    + '되풀이되면 그 요청은 fail_request(error 에 이 글)로 알리세요.';
}

// ───────── V2 의도 ─────────
const lines = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const under = (ref, set) => { if (!ref) return false; for (const r of set) if (ref === r || ref.startsWith(`${r}/`)) return true; return false; };
const bodyOf = (ref) => (/^s\d+\/p\d+/.exec(String(ref || ''))?.[0] ?? null);
// 판정하지 않는 종류: 차례·쪽 구성은 문서 여러 곳을 바꾸는 것이 의도다
// 문단 지우기·옮기기(para_delete·para_move — 2026-11-17)는 문단 차례가 바뀌어 덩어리 주소(옛 문서 차례)와 제안 주소(반영 뒤 자리)를 견줄 수 없다 —
// 대상 밖 경고가 늘 나므로 V2 에서 뺀다(V1 구조 검사는 그대로)
const V2_SKIP = new Set(['toc', 'page_layout', 'para_delete', 'para_move']);

/**
 * V2: 이번 커밋에서 적용된 제안들(applied) ↔ 편집 전후 덩어리(diffDocs). 제안마다 경고 글 목록 → Map(pid → [글]).
 * 대상 = 제안의 ref·afterRef·insertedRef·captionRef(+ 그 본문 문단과 안쪽 문단). 다른 문단 덩어리는 이 커밋의 어느 제안의 대상도 아니면 '대상 밖'.
 */
export function intentWarnings(applied, diff) {
  const out = new Map();
  const list = applied.filter((p) => !V2_SKIP.has(p.type));
  if (!list.length) return out;
  const hunks = diff?.hunks || []; const unsupported = diff?.unsupported || [];
  const targets = new Map(list.map((p) => {
    const s = new Set([p.ref, p.afterRef, p.insertedRef, p.captionRef, ...(Array.isArray(p.insertedRefs) ? p.insertedRefs : [])].filter(Boolean));
    for (const r of [...s]) { const b = bodyOf(r); if (b) s.add(b); }
    return [p.pid, s];
  }));
  const allTargets = new Set([...targets.values()].flatMap((s) => [...s]));
  const touches = (h, set) => under(h.ref, set) || under(h.headRef, set) || under(h.afterRef, set);
  const warn = (pid, text) => { const a = out.get(pid) || []; a.push(text); out.set(pid, a); };
  for (const p of list) {
    const set = targets.get(p.pid);
    const mine = hunks.filter((h) => touches(h, set));
    const newText = mine.map((h) => h.newText || '').join('\n');
    if (p.type === 'replace') {
      const missing = lines(p.replace).filter((l) => !newText.includes(l));
      if (p.replace !== '' && missing.length) warn(p.pid, `바꾼 글 「${missing[0].slice(0, 40)}」 이 결과 문단에 없음`);
      if (p.replace === '' && !mine.length) warn(p.pid, `지울 글 「${String(p.find || '').slice(0, 40)}」 이 그대로 있음`);
    } else if (p.type === 'insert') {
      const missing = lines(p.text).filter((l) => !newText.includes(l));
      if (missing.length) warn(p.pid, `넣은 글 「${missing[0].slice(0, 40)}」 이 결과에 없음`);
      else if (!p.text && !mine.length && !unsupported.some((u) => under(u.ref, set))) warn(p.pid, '넣은 빈 문단이 결과에 없음');
    } else if (p.type === 'format') {
      if (!mine.some((h) => h.type === 'format' || h.formatting)) warn(p.pid, '서식이 바뀌지 않음');
    } else if (!mine.length && !unsupported.some((u) => under(u.ref, set))) warn(p.pid, '결과 문서에서 바뀐 곳을 찾지 못함');
  }
  // 대상 밖: 어느 적용 제안의 대상에도 들지 않는 덩어리(글·서식·개체). 제안 하나면 그 제안에, 여럿이면 첫 제안에 단다.
  // (좁힌 비교는 메모·줄 배치만 다른 문단을 덩어리로 만들지 않는다 — formatPrint)
  const stray = hunks.filter((h) => !touches(h, allTargets));
  if (stray.length) {
    const where = [...new Set(stray.map((h) => h.ref || h.afterRef || h.headRef))].slice(0, 3).join('·');
    warn(list[0].pid, `대상 밖 문단도 바뀜(${where}${stray.length > 3 ? ` 등 ${stray.length}곳` : ''})`);
  }
  return out;
}

/** 구역 → 본문 문단 단위 [{ ref, text(본문 + 안쪽 문단 최종본 글 — 메모 본문·숨은 문단 빼고), xml(그 본문 문단 XML) }] */
function bodyUnits(sec) {
  const units = sec.bodyParas.map((p) => ({ ref: p.ref, texts: [], xml: sec.xml.slice(p.start, p.end) }));
  const byRef = new Map(units.map((u) => [u.ref, u]));
  for (const p of sec.paras) {
    if (p.container === 'hp:fieldBegin' || !Section.visibleParagraph(p, 'final')) continue;
    byRef.get(bodyOf(p.ref))?.texts.push(Section.text(p, 'final'));
  }
  return units.map((u) => ({ ref: u.ref, text: u.texts.join('\n'), xml: u.xml }));
}

/**
 * 본문 문단 XML → 서식·개체 지문(같은 글 문단의 '서식·개체가 바뀌었나'를 견줄 열쇠). 2026-11-12 검토 지적(대상 밖 서식 변화를 놓침)으로 넣었다.
 * 빼는 것(서식·개체가 아닌 차이): 메모 필드(시작 ctrl 통째 + 그 끝 ctrl — 작업 기록 메모가 대상 밖 문단에 붙는다), hp:linesegarray(줄 배치 정보),
 * run·hp:t 경계(같은 글자 모양 run 이 메모 자리에서 둘로 쪼개진다). 남기는 것: 글자 모양 번호별 글 조각(이어 붙임)과 다른 모든 요소·속성
 * (문단 모양·스타일·쪽 나누기·표·그림·도형 속성·변경 추적 표시 등)
 */
export function formatPrint(xml) {
  let x = String(xml);
  const memoIds = new Set();
  x = x.replace(/<hp:ctrl><hp:fieldBegin\b([^>]*)>[\s\S]*?<\/hp:fieldBegin><\/hp:ctrl>/g, (all, a) => {
    if (attrOf(a, 'type') !== 'MEMO') return all;
    memoIds.add(attrOf(a, 'id')); return '';
  });
  if (memoIds.size) x = x.replace(/<hp:ctrl><hp:fieldEnd\b([^>]*)\/><\/hp:ctrl>/g, (all, a) => (memoIds.has(attrOf(a, 'beginIDRef')) ? '' : all));
  x = x.replace(/<hp:linesegarray\b[^>]*\/>|<hp:linesegarray\b[^>]*>[\s\S]*?<\/hp:linesegarray>/g, '');
  const out = []; const runs = [];
  for (const m of x.matchAll(/<(\/?)([A-Za-z_][\w:.\-]*)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (m[5] != null) {
      const cp = runs.at(-1) ?? '';
      const last = out.at(-1);
      if (last && last.cp === cp) last.text += m[5]; else out.push({ cp, text: m[5] });
      continue;
    }
    const [, close, name, attrs, self] = m;
    if (name === 'hp:run') { if (close) runs.pop(); else if (!self) runs.push(attrOf(attrs, 'charPrIDRef') ?? ''); continue; }
    if (name === 'hp:t') continue;
    // 변경 추적 표시의 Id·TcId 는 '목록 위치'라 다른 곳에 변경이 생기면 다시 매겨진다(엔진 1:1 모형) — 번호는 빼고 자리만 견준다
    if (/^hp:(insert|delete)(Begin|End)$/.test(name)) { out.push(`<${name}${attrs.replace(/\s(?:Id|TcId)="[^"]*"/g, '')}>`); continue; }
    out.push(`<${close}${name}${attrs}${self}>`);
  }
  return out.map((o) => (typeof o === 'string' ? o : `[${o.cp}]${o.text}`)).join('\u0001');
}

/**
 * 좁힌 V2 비교(2026-11-12 측정: 3.2MB 문서에서 전체 diffDocs 는 편집 전 문서 읽기 포함 ~550ms, 이것은 바뀐 구역만 ~수십 ms).
 * 구역 글이 같은 구역은 건너뛰고, 바뀐 구역만 편집 전 구역을 엔진 Section 으로 읽어 본문 문단 단위 최종본 글을 견준다(diffArrays).
 * 덩어리 꼴은 diffDocs 와 같은 열쇠(ref = 편집 전 주소, headRef = 편집 뒤 주소, afterRef = 앞 공통 문단, newText)를 쓰고, 한 변경 묶음의
 * 덩어리는 모두 그 묶음의 첫 편집 전 문단(ref)을 단다(문단 나눔·합침). 글이 같고 서식·개체 지문(formatPrint)이 다른 문단은 type 'format'.
 * 구역 수가 다르면 null(→ diffDocs 전체)
 */
export async function narrowDiff(beforeBytes, head) {
  const before = await readParts(beforeBytes);
  const names = head.container.sectionNames();
  if (before.sections.length !== names.length) return null;
  const hunks = [];
  for (let i = 0; i < names.length; i++) {
    if (before.sections[i][1] === head.container.getText(names[i])) continue;
    const B = bodyUnits(new Section(before.sections[i][1], i)); const H = bodyUnits(head.sections[i]);
    let bi = 0; let hi = 0; let prev = null; let removed = []; let added = [];
    // 한 변경 묶음(이어진 지운·넣은 문단) 마무리: 지운 것이 있으면 모두 그 첫 편집 전 문단(ref)을, 넣은 것이 있으면 첫 편집 뒤 문단(headRef)을 함께 단다
    const flush = () => {
      const ref = removed[0]?.ref ?? null; const headRef = added[0]?.ref ?? null;
      for (const u of removed) hunks.push({ type: added.length ? 'replace' : 'delete', ref, headRef, baseText: u.text, newText: '' });
      for (const u of added) hunks.push(ref ? { type: 'replace', ref, headRef: u.ref, baseText: '', newText: u.text } : { type: 'insert', ref: null, headRef: u.ref, afterRef: prev, baseText: '', newText: u.text });
      removed = []; added = [];
    };
    for (const part of diffArrays(B.map((u) => u.text), H.map((u) => u.text))) {
      const n = part.count ?? part.value.length;
      if (part.removed) { for (let k = 0; k < n; k++) removed.push(B[bi++]); continue; }
      if (part.added) { for (let k = 0; k < n; k++) added.push(H[hi++]); continue; }
      flush();
      for (let k = 0; k < n; k++, bi++, hi++) {
        // 글이 같은 문단: XML 이 다르고 서식·개체 지문(formatPrint)도 다르면 서식·개체 덩어리(대상 밖이면 경고). 메모·줄 배치·run 쪼갬만 다르면 덩어리가 아니다
        if (B[bi].xml !== H[hi].xml && formatPrint(B[bi].xml) !== formatPrint(H[hi].xml)) hunks.push({ type: 'format', ref: B[bi].ref, headRef: H[hi].ref, baseText: B[bi].text, newText: H[hi].text, formatting: true });
        prev = B[bi].ref;
      }
    }
    flush();
  }
  return { hunks, unsupported: [] };
}

/**
 * V2 실행: 편집 전 기록(store.currentBytes) ↔ 저장할 문서(head — HwpxDoc 또는 바이트, diffDocs 는 고치지 않는다). 실패해도 던지지 않는다(경고일 뿐) → { warnings: Map, ms } | null
 */
export async function verifyIntent(store, id, head, applied) {
  if (!applied?.length || applied.every((p) => V2_SKIP.has(p.type))) return null;
  const t0 = performance.now();
  try {
    // 좁힌 비교(바뀐 구역만, 본문 문단 단위 글)를 먼저 — 구역 수가 바뀌었거나 head 가 문서가 아니면 diffDocs 전체
    const diff = (head instanceof HwpxDoc && await narrowDiff(store.currentBytes(id), head))
      || await diffDocs(await HwpxDoc.load(store.currentBytes(id)), head, { yieldEvery: 40 });
    return { warnings: intentWarnings(applied, diff), ms: performance.now() - t0 };
  } catch (e) {
    console.error('[편집 검증] V2:', e.message);
    return null;
  }
}

/** 제안 객체에 V2 경고를 단다(JSON 에 나오지 않는 기호 키) */
export function attachIntentNotes(applied, warnings, { store = null, id = null } = {}) {
  if (!warnings) return;
  for (const p of applied) {
    const w = warnings.get(p.pid);
    if (!w?.length) continue;
    p[VERIFY_NOTE] = `검증 경고: ${w.join(' / ')} — read_document 로 그 문단을 확인하세요`;
    if (store && id != null) noteRecent(store, id, p.pid, p[VERIFY_NOTE]);
  }
}

// 최근 V2 경고(저장소·문서별, 제안 번호 → { note, seq }) — 완료 때 자동 반영처럼 응답이 제안 객체를 싣지 않는 길(lean complete)이 읽는다.
// 2026-11-12 검토 지적: 경고는 완료 거래 안의 제안 객체에만 붙어 lean 영수증(완료 전에 만든 것)에서 사라졌다
let intentSeq = 0;
const recent = new WeakMap();
const RECENT_MAX = 100;
function noteRecent(store, id, pid, note) {
  let docs = recent.get(store); if (!docs) { docs = new Map(); recent.set(store, docs); }
  let m = docs.get(String(id)); if (!m) { m = new Map(); docs.set(String(id), m); }
  m.delete(pid); m.set(pid, { note, seq: ++intentSeq });
  while (m.size > RECENT_MAX) m.delete(m.keys().next().value);
}
/** 지금까지의 경고 차례(이 뒤에 난 경고만 고르려고 부르기 전에 잡는다) */
export const intentMark = () => intentSeq;
/** mark 뒤에 이 문서에서 난 V2 경고 → Map(pid → 글) */
export function intentNotesSince(store, id, mark) {
  const out = new Map();
  for (const [pid, x] of recent.get(store)?.get(String(id)) || []) if (x.seq > mark) out.set(pid, x.note);
  return out;
}

/**
 * _finish 가 커밋 직전에 부른다(server/service.js). 저장할 바이트를 만들어 V1 을 보고(새 문제면 makeError 로 던짐 — 저장하지 않음),
 * 이번 커밋에서 적용된 제안(appliedVersion = 다음 기록)이 있으면 V2 경고를 단다 → { bytes(그대로 기록), all(이 기록의 문제 열쇠), ms }
 */
export async function verifyBeforeCommit(store, ctx, makeError) {
  const { id, doc, meta } = ctx;
  const bytes = await doc.save();
  const v1 = await verifyStructure(bytes, { doc, store, id, version: meta.version });
  if (!v1.ok) throw makeError('VERIFY_STRUCTURE', structureFailMessage(v1.fresh), 422, { issues: v1.fresh.map((x) => x.text) });
  const applied = (meta.proposals || []).filter((p) => p.status === 'applied' && p.appliedVersion === meta.version + 1);
  const v2 = await verifyIntent(store, id, doc, applied);
  if (v2) attachIntentNotes(applied, v2.warnings, { store, id });
  return { bytes, all: v1.all, ms: { v1: v1.ms, v2: v2?.ms ?? 0 } };
}
