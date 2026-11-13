// node --test tests/engine5.test.mjs — v0.3 엔진 안전·메모 묶음(V3_SPEC §4.2·§4.3·§4.4·§3.6).
//  - tolerant 최종본: 수락할 수 없는 변경(개체를 품은 삭제 CTRL_INSIDE, 문단 경계에 걸친 변경 SPANS_PARAGRAPH, 짝 없는 표식)도
//    던지지 않고 표식만 지워 글을 최종본(paragraphs view final)과 같게 만든다. 기본(옵션 없음)은 예전 그대로 던진다.
//  - 개체를 품지 않는 삭제: deleteTracked·replaceTracked·mergeParagraphText·mergeBodyTexts 가 개체(메모 경계·표 등) 앞뒤로 나눠 지운다.
//  - addMemos: addMemo 를 차례로 부른 것과 결과(메모 id·번호·XML)가 같고(중첩 표·메모 본문 ref·뒤섞인 순서 포함), 큰 보고서 150개가 빠르며,
//    큰 표 문단과 그 칸이 함께 와도 바깥 문단을 항목마다 다시 읽지 않는다. 지금 문서 ref 로 만든 목록은 깊은 ref 먼저면 모두 제자리.
//  - replaceTracked 가 나눈 삭제는 deleteIds 를 모두 거절해야 되돌아간다(서비스 제안 되돌리기 계약).
//  - memos().key·memoKey, diffDocs 'format'(글이 같고 글자 모양만 바뀜 — charPr id 가 아니라 실제 속성 비교).
// 표본(tests/samples)·rhwp(vendor)·v0.2 엔진 사본(backups)은 없을 수 있다 — 없으면 그 시험만 건너뛴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpxDoc, diffDocs, memoKey } from '../engine/doc.js';
import { Section } from '../engine/section.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const BIG = path.join(here, 'samples', '2025년_전체종합보고서.hwpx'); // 구역 하나 2.4MB, 문단 4천여 개
const hasBig = fs.existsSync(BIG);
const BIZ = path.join(here, 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'); // 표 5개
const hasBiz = fs.existsSync(BIZ);
const OLD_ENGINE = path.join(here, '..', 'backups', 'v0.2.0_2026-10-22', 'engine', 'doc.js'); // v0.2 엔진 사본(잠김 재현·결과 대조)
const OldDoc = fs.existsSync(OLD_ENGINE) ? (await import(pathToFileURL(OLD_ENGINE).href)).HwpxDoc : null;
const RHWP = path.join(here, '..', 'vendor', 'rhwp', 'pkg'); // 편집기(rhwp WASM)
const hasRhwp = fs.existsSync(path.join(RHWP, 'rhwp_bg.wasm'));
let rhwpMod = null;
const rhwp = () => (rhwpMod ??= (async () => {
  globalThis.measureTextWidth ??= (font, text) => text.length * 10; // 레이아웃용 폭 측정 스텁(refmap·engine4 시험과 같음)
  const mod = await import(pathToFileURL(path.join(RHWP, 'rhwp.js')).href);
  const wasm = fs.readFileSync(path.join(RHWP, 'rhwp_bg.wasm'));
  if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });
  return mod;
})());
const author = '홍길동';
const DATE = new Date(Date.UTC(2026, 9, 22, 1, 2, 3));
const reload = async (d) => HwpxDoc.load(await d.save());

// ───────── 시험 도우미 ─────────

/** 고정 씨앗 난수(mulberry32) */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** fn 을 하는 동안만 Math.random 을 씨앗 난수로 바꾼다(메모 고유 번호가 같은 차례로 나오게) */
function withSeed(seed, fn) {
  const orig = Math.random; Math.random = seeded(seed);
  try { return fn(); } finally { Math.random = orig; }
}
const xmlOf = (d) => d.sections.map((s) => s.xml);
const marks = (d) => d.sections.reduce((n, s) => n + (s.xml.match(/<hp:(?:insert|delete)(?:Begin|End)\b/g) || []).length, 0);
const finalTexts = (d) => d.paragraphs().map((p) => [p.ref, p.text]);
const memoRows = (d) => d.memos().map((m) => [m.id, m.ref, m.start, m.end, m.text]);

/** 지운 범위가 개체(ctrl)를 품은 삭제 id — acceptChange 가 CTRL_INSIDE 를 내는 조건과 같다 */
function ctrlInsideDeletes(d) {
  const out = [];
  for (const sec of d.sections) {
    for (const p of sec.paras) {
      const ms = Section.changeMarks(p);
      for (const b of ms.filter((m) => m.name === 'hp:deleteBegin')) {
        const e = ms.find((m) => m.name === 'hp:deleteEnd' && m.id === b.id);
        if (!e) continue;
        const inside = (a) => a.kind === 'ctrl' && ((a.pos > b.pos && a.pos < e.pos) || (a.pos === b.pos && a.start > b.start) || (a.pos === e.pos && a.end < e.start));
        if (p.anchors.some(inside)) out.push(Number(b.id));
      }
    }
  }
  return out;
}

/** 문단 ref 의 글자 ci(p.chars 번호) 앞('before')·뒤('after') 원문 자리에 xml 을 그대로 끼운다(엔진 규칙을 거치지 않는 시험용) */
function inject(d, ref, ci, side, xml) {
  const { sec, p } = d.resolve(ref);
  const pos = side === 'before' ? p.chars[ci].raw[0] : p.chars[ci].raw[1];
  sec.load(sec.xml.slice(0, pos) + xml + sec.xml.slice(pos));
}

/** v0.2 엔진처럼 나누지 않은 삭제 하나(글자 a..b, p.chars 번호)를 만든다 → 변경 id */
function rawDelete(d, ref, a, b) {
  const id = d.header.addChange('Delete', d.header.ensureAuthor(author), DATE);
  inject(d, ref, b, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`);
  inject(d, ref, a, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
  return id;
}

/** 문단(중첩 문단 없는) 의 모든 run 글자 모양을 charPr id 로 바꾼다 */
function setRunCharPr(d, ref, id) {
  const { sec, p } = d.resolve(ref);
  assert.equal(p.children.length, 0, '중첩 문단 없는 문단만');
  const x = sec.xml.slice(p.start, p.end).replace(/(<hp:run\b[^>]*\bcharPrIDRef=")[^"]*(")/g, `$1${id}$2`);
  sec.load(sec.xml.slice(0, p.start) + x + sec.xml.slice(p.end));
}

/** 헤더에 charPr src 와 속성이 똑같고 id 만 다른 항목을 더한다(addItem 은 같은 내용이면 새로 만들지 않아 직접 붙인다) → 새 id */
function duplicateCharPr(d, src) {
  const h = d.header;
  const ids = [...h.xml.matchAll(/<hh:charPr id="(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const id = String(Math.max(...ids) + 1);
  const blk = h.block('charPr', src).replace(/^<hh:charPr id="\d+"/, `<hh:charPr id="${id}"`);
  h.xml = h.xml.replace('</hh:charProperties>', `${blk}</hh:charProperties>`).replace(/(<hh:charProperties\b[^>]*\bitemCnt=")\d+(")/, `$1${ids.length + 1}$2`);
  return id;
}

/** 표 문단 하나(가·나/다·라)를 s0/p1 에 넣고, 그 문단 run 안 표 앞뒤에 글을 둔 문서(본문 글 + 표 개체 + 글) */
async function textTableDoc({ before = '앞 글', after = '뒤 글' } = {}) {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const r = d.insertTableAfter(0, 0, { rows: [['가', '나'], ['다', '라']], headerRows: 1 }, { author });
  assert.equal(r.ref, 's0/p1');
  const { sec, p } = d.resolve(r.ref);
  const x = sec.xml.slice(p.start, p.end)
    .replace(/^(<hp:p\b[^>]*><hp:run\b[^>]*>)(<hp:tbl\b)/, `$1${before ? `<hp:t>${before}</hp:t>` : ''}$2`)
    .replace(/<\/hp:tbl><hp:t\/><\/hp:run>/, `</hp:tbl><hp:t>${after}</hp:t></hp:run>`);
  sec.load(sec.xml.slice(0, p.start) + x + sec.xml.slice(p.end));
  assert.equal(d.text(r.ref), before + after);
  return d;
}

/**
 * 중첩 표 문서: s0/p1 = '표 앞 글' + 표(가·나/다·라 = s0/p1/n0..n3) + '뒤 글', 칸 '라'(s0/p1/n3) 글 뒤에 2×2 표(마·바/사·아 = s0/p1/n3/n0..n3).
 * 표본에는 깊이 2 중첩 문단이 없어 둘째 표 XML 을 칸 안으로 옮겨 만든다(엔진 시험용 — 한글로 열어 보지 않음).
 */
async function nestedTableDoc() {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const r = d.insertTableAfter(0, 0, { rows: [['가', '나'], ['다', '라']], headerRows: 1 }, { author });
  const inner = d.insertTableAfter(0, 1, { rows: [['마', '바'], ['사', '아']], headerRows: 0 }, { author });
  const sec = d.sections[0];
  const ip = d.resolve(inner.ref).p;
  const tbl = /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(ip.start, ip.end))[0];
  sec.load(sec.xml.slice(0, ip.start) + sec.xml.slice(ip.end)); // 둘째 표 문단은 지운다
  const p = d.resolve(r.ref).p;
  const x = sec.xml.slice(p.start, p.end)
    .replace(/^(<hp:p\b[^>]*><hp:run\b[^>]*>)(<hp:tbl\b)/, '$1<hp:t>표 앞 글</hp:t>$2')
    .replace(/<\/hp:tbl><hp:t\/><\/hp:run>/, '</hp:tbl><hp:t>뒤 글</hp:t></hp:run>')
    .replace('<hp:t>라</hp:t>', `<hp:t>라</hp:t>${tbl}<hp:t/>`);
  sec.load(sec.xml.slice(0, p.start) + x + sec.xml.slice(p.end));
  const out = await reload(d);
  assert.deepEqual(out.paragraphs().filter((q) => q.ref.startsWith('s0/p1')).map((q) => [q.ref, q.text]), [
    ['s0/p1', '표 앞 글뒤 글'], ['s0/p1/n0', '가'], ['s0/p1/n1', '나'], ['s0/p1/n2', '다'], ['s0/p1/n3', '라'],
    ['s0/p1/n3/n0', '마'], ['s0/p1/n3/n1', '바'], ['s0/p1/n3/n2', '사'], ['s0/p1/n3/n3', '아'],
  ]);
  return out;
}

/** tool_memo 표본에 v0.2 엔진이 만들던 잠긴 삭제(메모 끝 컨트롤을 품음)를 넣은 문서 — s0/p0 '입니다. 메모 대상' */
async function lockedDoc() {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  assert.equal(d.text('s0/p0'), '첫째 문단입니다. 메모 대상 문장이 여기 있습니다.');
  const id = rawDelete(d, 's0/p0', 5, 14); // 메모 [0,10) 의 끝 컨트롤이 글자 9 와 10 사이
  return { doc: await reload(d), id };
}

// ───────── §4.3 tolerant 최종본 ─────────

test('tolerant: 메모 끝을 품은 삭제(v0.2 잠김) — 기본은 그대로 던지고, tolerant 는 표식만 지워 최종본 글을 맞춘다', async () => {
  const { doc: locked, id } = await lockedDoc();
  assert.equal(id, 5);
  assert.deepEqual(ctrlInsideDeletes(locked), [5]);
  const want = finalTexts(locked);
  await assert.rejects(locked.flattened(), (e) => e.code === 'CTRL_INSIDE');
  await assert.rejects(locked.viewerCopy(), (e) => e.code === 'CTRL_INSIDE');
  const f = await locked.flattened({ tolerant: true });
  assert.deepEqual(f.lastTolerantSkips, [5]);
  assert.deepEqual(locked.lastTolerantSkips, [5], '원본에도 남긴다');
  assert.deepEqual(f.lastTolerantDetail, [{ id: 5, type: 'Delete', ref: 's0/p0', code: 'CTRL_INSIDE' }]);
  assert.equal(marks(f), 0); assert.deepEqual(f.changes(), []); assert.equal(f.trackingEnabled(), false);
  assert.deepEqual(finalTexts(f), want, '사본 글 = 원본 최종본(편집기 정렬 기준과 같다)');
  assert.equal(f.text('s0/p0'), '첫째 문단 문장이 여기 있습니다.');
  // 메모는 남는다(끝 컨트롤 제자리) — 범위는 지운 글만큼 줄어든다
  assert.deepEqual(f.memos().map((m) => [m.id, m.ref, m.start, m.end, m.anchorText]), [['memo1', 's0/p0', 0, 5, '첫째 문단']]);
  // 나머지 변경(1~4)은 그대로 수락됐다
  assert.equal(f.text('s0/p1'), '둘째 문단입니다. 있던 낱말을 지우고 새 낱말을 넣습니다. (AI가 추가한 문장)');
  assert.equal(f.text('s0/p2'), '셋째 문단은 AI 제안대로 둡니다.');
  assert.equal(locked.changes().length, 5, '원본은 그대로');
  assert.deepEqual(finalTexts(await reload(f)), want);
  const v = await locked.viewerCopy({ tolerant: true });
  assert.equal(typeof v.layoutFixed, 'number');
  assert.deepEqual([v.lastTolerantSkips, finalTexts(v), marks(v)], [[5], want, 0]);
});

test('tolerant: v0.2 엔진의 deleteTracked 로 만든 잠김도 연다(사본 v0.2 엔진으로 재현)', { skip: !OldDoc && 'backups 의 v0.2 엔진 없음' }, async () => {
  const old = await OldDoc.load(fx('tool_memo_tracked.hwpx'));
  assert.deepEqual(old.deleteTracked('s0/p0', 5, 15, { author }), { deleteId: 5, insertId: null });
  await assert.rejects(old.flattened(), (e) => e.code === 'CTRL_INSIDE'); // 그때의 잠김
  const d = await HwpxDoc.load(await old.save());
  await assert.rejects(d.flattened(), (e) => e.code === 'CTRL_INSIDE');
  const f = await d.flattened({ tolerant: true });
  assert.deepEqual([f.lastTolerantSkips, marks(f), finalTexts(f)], [[5], 0, finalTexts(d)]);
  assert.deepEqual(f.memos().map((m) => [m.start, m.end]), [[0, 5]]);
});

test('tolerant: 문단 경계에 걸친 삭제·삽입(SPANS_PARAGRAPH)과 짝 없는 표식 — 던지지 않고 나머지는 그대로 수락', async () => {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const han = d.header.ensureAuthor('한글');
  // 삭제: s0/p1 글자 10('있') 앞에서 시작해 s0/p2 글자 3 뒤에서 끝남(한글처럼 끝 표식이 다음 문단에)
  const del = d.header.addChange('Delete', han, DATE);
  inject(d, 's0/p2', 3, 'after', `<hp:deleteEnd Id="${del}" TcId="${del}" paraend="1"/>`);
  inject(d, 's0/p1', 10, 'before', `<hp:deleteBegin Id="${del}" TcId="${del}"/>`);
  // 삽입: s0/p0 글자 20 앞에서 시작, 끝 표식 없음
  const ins = d.header.addChange('Insert', han, DATE);
  inject(d, 's0/p0', 20, 'before', `<hp:insertBegin Id="${ins}" TcId="${ins}"/>`);
  // 엔진이 만든 보통 변경(교체) 하나 + 짝 없는 끝 표식 하나
  assert.deepEqual(d.replaceTracked('s0/p2', 0, 2, '넷째', { author, date: DATE }), { deleteId: 3, insertId: 4 });
  inject(d, 's0/p2', 6, 'after', '<hp:insertEnd Id="9" TcId="9" paraend="0"/>');
  assert.deepEqual(d.changes().filter((c) => c.spansParagraph).map((c) => c.id), [1, 2]);
  const want = finalTexts(d);
  assert.equal(d.text('s0/p1'), '둘째 문단입니다. ');
  await assert.rejects(d.flattened(), (e) => e.code === 'SPANS_PARAGRAPH');
  const f = await d.flattened({ tolerant: true });
  assert.deepEqual(f.lastTolerantSkips, [1, 2]);
  const detail = f.lastTolerantDetail;
  assert.deepEqual(detail.filter((x) => x.id != null), [
    { id: 2, type: 'Insert', ref: 's0/p0', code: 'SPANS_PARAGRAPH' },
    { id: 1, type: 'Delete', ref: 's0/p1', code: 'SPANS_PARAGRAPH' },
  ]);
  assert.deepEqual(detail.filter((x) => x.id == null).map((x) => [x.code, x.type, x.ref]), [['ORPHAN_MARK', 'insertEnd', 's0/p2']]);
  assert.equal(marks(f), 0); assert.deepEqual(f.changes(), []);
  assert.deepEqual(finalTexts(f), want, '사본 글 = 원본 최종본: 시작 문단의 지운 꼬리만 빠지고, 끝 문단 글은 남는다(문단은 합치지 않음)');
  assert.deepEqual([f.text('s0/p0'), f.text('s0/p1'), f.text('s0/p2')], [d.text('s0/p0'), '둘째 문단입니다. ', '넷째 문단은 AI 제안대로 둡니다.']);
  assert.deepEqual(memoRows(f), memoRows(d));
});

test('tolerant: 수락할 수 있는 문서는 기본과 똑같다(XML·헤더·조판 보정), 건너뛴 것 없음', async () => {
  const docs = [fx('hangul_tracked.hwpx'), fx('tool_memo_tracked.hwpx'), fx('hangul_resaved_dedup.hwpx')];
  if (hasBiz) docs.push(fs.readFileSync(BIZ));
  for (const buf of docs) {
    const d = await HwpxDoc.load(buf);
    const a = await d.flattened(); const b = await d.flattened({ tolerant: true });
    assert.deepEqual(xmlOf(b), xmlOf(a)); assert.equal(b.header.xml, a.header.xml);
    assert.deepEqual([b.lastTolerantSkips, b.lastTolerantDetail, a.lastTolerantSkips], [[], [], undefined]);
    const va = await d.viewerCopy(); const vb = await d.viewerCopy({ tolerant: true });
    assert.deepEqual([xmlOf(vb), vb.layoutFixed], [xmlOf(va), va.layoutFixed]);
    assert.deepEqual(xmlOf(await d.flattened(null)), xmlOf(a), '옵션 자리에 null 이어도 기본');
  }
});

test('tolerant 사본은 편집기(rhwp)가 열고 같은 글로 내보낸다', { skip: !hasRhwp && 'rhwp 없음' }, async () => {
  const mod = await rhwp();
  const { doc: locked } = await lockedDoc();
  const v = await locked.viewerCopy({ tolerant: true });
  const r = new mod.HwpDocument(new Uint8Array(await v.save()));
  const back = await HwpxDoc.load(Buffer.from(r.exportHwpx()));
  assert.deepEqual(back.paragraphs({ nested: false }).map((p) => p.text), v.paragraphs({ nested: false }).map((p) => p.text));
  assert.deepEqual(back.memos().map((m) => [m.key, m.start, m.end]), v.memos().map((m) => [m.key, m.start, m.end]));
});

// ───────── §4.3 개체를 품지 않는 삭제 ─────────

test('deleteTracked: 메모 끝을 건너는 삭제는 개체 앞뒤 두 조각 — 기본 최종본이 열리고 거절하면 원래대로', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const r = d.deleteTracked('s0/p0', 5, 15, { author, date: DATE });
  assert.deepEqual(r, { deleteId: 5, insertId: null, deleteIds: [5, 6] });
  assert.deepEqual(ctrlInsideDeletes(d), []);
  assert.equal(d.text('s0/p0'), '첫째 문단 문장이 여기 있습니다.');
  assert.equal(d.text('s0/p0', 'original'), '첫째 문단입니다. 메모 대상 문장이 여기 있습니다.');
  assert.deepEqual(d.changes().filter((c) => c.ref === 's0/p0').map((c) => [c.id, c.type, c.text, c.start, c.end, c.author]),
    [[5, 'Delete', '입니다. ', 5, 5, author], [6, 'Delete', '메모 대상', 5, 5, author]]);
  // 메모 끝 컨트롤은 두 삭제 사이에 그대로
  const { sec, p } = d.resolve('s0/p0');
  assert.match(sec.xml.slice(p.start, p.end), /입니다\. <hp:deleteEnd Id="5" TcId="5" paraend="0"\/><\/hp:t><hp:ctrl><hp:fieldEnd [^>]*\/><\/hp:ctrl><hp:t><hp:deleteBegin Id="6" TcId="6"\/>메모 대상<hp:deleteEnd/);
  const f = await d.flattened(); // 옵션 없이도 열린다
  assert.equal(f.text('s0/p0'), '첫째 문단 문장이 여기 있습니다.');
  assert.deepEqual(f.memos().map((m) => [m.id, m.start, m.end, m.anchorText]), [['memo1', 0, 5, '첫째 문단']]);
  const g = await reload(d);
  g.rejectChange(6); g.rejectChange(5);
  assert.equal(g.text('s0/p0', 'markup'), '첫째 문단입니다. 메모 대상 문장이 여기 있습니다.');
  assert.deepEqual(g.memos().map((m) => [m.start, m.end]), [[0, 10]]);
});

test('replaceTracked: 메모를 통째로 품은 범위 — 세 조각 삭제, 넣는 글은 첫 조각 뒤에 한 번', async () => {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened(); // 변경 없음
  const t0 = d.text('s0/p1'); // '둘째 문단입니다. …'
  const m = d.addMemo('s0/p1', { start: 3, end: 6, author, text: '가운데 메모', date: DATE }); // '문단입'
  const r = d.replaceTracked('s0/p1', 1, 8, '★', { author, date: DATE }); // '째 문단입니다' → '★'
  assert.deepEqual(r, { deleteId: 1, insertId: 2, deleteIds: [1, 3, 4] }, '번호: 첫 삭제 → 삽입 → 나머지 삭제(문서 순서)');
  assert.deepEqual(ctrlInsideDeletes(d), []);
  assert.equal(d.text('s0/p1'), `둘★${t0.slice(8)}`);
  assert.equal(d.text('s0/p1', 'original'), t0);
  const { sec, p } = d.resolve('s0/p1');
  assert.equal((sec.xml.slice(p.start, p.end).match(/<hp:insertBegin\b/g) || []).length, 1);
  assert.deepEqual(d.changes().map((c) => [c.id, c.type, c.text, c.start, c.end]),
    [[1, 'Delete', '째 ', 1, 1], [2, 'Insert', '★', 1, 2], [3, 'Delete', '문단입', 2, 2], [4, 'Delete', '니다', 2, 2]]);
  assert.deepEqual(d.memos().filter((x) => x.id === m).map((x) => [x.start, x.end]), [[2, 2]], '메모는 남고(빈 범위) 새 글은 메모 앞');
  const f = await d.flattened();
  assert.equal(f.text('s0/p1'), `둘★${t0.slice(8)}`);
  assert.ok(f.memos().some((x) => x.id === m));
  const g = await d.clone(); g.rejectAll();
  assert.equal(g.text('s0/p1', 'markup'), t0);
  assert.deepEqual(g.memos().filter((x) => x.id === m).map((x) => [x.start, x.end, x.anchorText]), [[3, 6, '문단입']]);
  // 개체가 없으면 예전 모양 그대로(deleteIds 없음)
  assert.deepEqual(d.replaceTracked('s0/p2', 0, 2, '넷째', { author, date: DATE }), { deleteId: 5, insertId: 6 });
});

test('replaceTracked: 다른 제안 메모 끝을 건너는 교체(제안 적용) — deleteIds 의 모든 조각과 insertId 를 거절해야 원래 글·메모로 돌아간다', async () => {
  // 서비스 제안 적용(_applyCore)·되돌리기(_undoCore)가 기대는 계약: 적용 때 changeIds 에 deleteIds 를 모두 담아야 한다(deleteId 는 첫 조각뿐)
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const ref = 's0/p1'; const t0 = d.text(ref);
  d.addMemo(ref, { ...d.find(ref, '문단입니다'), author: 'AI', text: '[제안 #1]', date: DATE });
  const r2 = d.find(ref, '입니다. 있던'); // 제안 #1 메모 끝을 품는다
  d.addMemo(ref, { ...r2, author: 'AI', text: '[제안 #2]', date: DATE });
  const memosBefore = d.memos().map((m) => [m.id, m.start, m.end, m.anchorText]);
  const res = d.replaceTracked(ref, r2.start, r2.end, '바꾼 글', { author: 'AI', date: DATE });
  assert.deepEqual(res, { deleteId: 1, insertId: 2, deleteIds: [1, 3] });
  assert.deepEqual(ctrlInsideDeletes(d), []);
  assert.equal(d.text(ref), t0.replace('입니다. 있던', '바꾼 글'));
  const g = await d.clone();
  // 되돌리기: 큰 번호부터 거절(서비스 rejectIds 와 같은 차례)
  for (const id of [...res.deleteIds, res.insertId].sort((a, b) => b - a)) d.rejectChange(id);
  assert.equal(d.text(ref), t0);
  assert.deepEqual(d.changes(), []);
  assert.deepEqual(d.memos().map((m) => [m.id, m.start, m.end, m.anchorText]), memosBefore);
  // 첫 조각(deleteId)만 거절하면 둘째 조각이 남는다 — 예전(나누지 않던) 결과 모양만 믿으면 안 되는 까닭
  for (const id of [res.deleteId, res.insertId].sort((a, b) => b - a)) g.rejectChange(id);
  assert.notEqual(g.text(ref), t0);
  assert.deepEqual(g.changes().map((c) => [c.type, c.text]), [['Delete', '. 있던']]);
});

test('deleteTracked: 글 사이 표 개체를 건너는 삭제 — 표는 남고 앞뒤 글만 지운다', async () => {
  const d = await textTableDoc(); // s0/p1 = '앞 글' + 표 + '뒤 글'
  const r = d.deleteTracked('s0/p1', 1, 4, { author, date: DATE }); // ' 글' | 표 | '뒤'
  assert.deepEqual(r.deleteIds, [r.deleteId, r.deleteId + 1]);
  assert.deepEqual(ctrlInsideDeletes(d), []);
  assert.equal(d.text('s0/p1'), '앞 글');
  const f = await d.flattened();
  assert.equal(f.text('s0/p1'), '앞 글');
  assert.deepEqual(f.tables().map((t) => [t.ref, t.rows, t.cols, t.cells.map((c) => c.text).join('')]), [['s0/p1', 2, 2, '가나다라']]);
});

test('mergeParagraphText·mergeBodyTexts: 메모가 낀 글을 고치거나 문단을 지워도 개체를 품은 삭제가 생기지 않는다', async () => {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const old = d.text('s0/p1'); // '둘째 문단입니다. …'
  const m = d.addMemo('s0/p1', { start: 0, end: 4, author, text: '앞 메모', date: DATE }); // '둘째 문' — 끝이 '문'·'단' 사이
  const target = `${old.replace('문단', '')}!`; // '문단' 지움(메모 끝을 건넘) + 끝에 '!'
  const ids = d.mergeParagraphText('s0/p1', target, { author, date: DATE });
  assert.equal(d.text('s0/p1'), target);
  assert.deepEqual(ctrlInsideDeletes(d), []);
  assert.deepEqual(d.changes().map((c) => [c.type, c.text]), [['Insert', '!'], ['Delete', '문'], ['Delete', '단']], '메모 끝에서 나뉜 삭제 둘');
  assert.deepEqual([...ids].sort((a, b) => a - b), d.changes().map((c) => c.id), '나뉜 삭제 id 도 모두 돌려준다');
  const f = await d.flattened();
  assert.equal(f.text('s0/p1'), target);
  assert.deepEqual(f.memos().filter((x) => x.id === m).map((x) => [x.start, x.end, x.anchorText]), [[0, 3, '둘째 ']]);
  // 메모가 가운데 걸린 문단 통째로 지우기(변경 요청 반영의 delete 덩어리와 같은 길)
  const e = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  e.addMemo('s0/p2', { start: 2, end: 5, author, text: '지울 문단 메모', date: DATE });
  const texts = e.bodyTexts()[0];
  const rep = e.mergeBodyTexts({ 0: texts.slice(0, 2) }, { author, date: DATE });
  assert.deepEqual(rep.deleted, ['s0/p2']);
  assert.deepEqual(ctrlInsideDeletes(e), []);
  const ef = await e.flattened();
  assert.equal(ef.text('s0/p2'), '');
  assert.deepEqual(ef.memos().map((m) => [m.ref, m.text]), [['s0/p0', 'AI 제안: 이 문장을 두 문장으로 나누면 읽기 쉽습니다. [제안 #1]'], ['s0/p2', '지울 문단 메모']]);
});

/** 메모를 많이 단(같은 문단 여러 개) biz 표본 최종본 + 글 4자 이상 문단 목록 */
async function memoHeavyBiz(r) {
  let base = await (await HwpxDoc.load(fs.readFileSync(BIZ))).flattened();
  const ps = base.paragraphs().filter((p) => p.length >= 4);
  const items = [];
  for (let i = 0; i < 60; i++) {
    const p = ps[Math.floor(r() * ps.length)]; const a = Math.floor(r() * p.length); const b = a + Math.floor(r() * (p.length - a + 1));
    items.push({ ref: p.ref, start: a, end: b, author: 'm', text: `m${i}`, date: DATE });
  }
  base.addMemos(items);
  base = await reload(base);
  return { base, ps };
}

test('무작위 편집(메모 60개 문서): 지우기·바꾸기·글 맞추기 — 개체를 품은 삭제 없음, 기본 최종본 = 기대 글, 모두 거절 = 원래', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const r = seeded(3);
  const { base, ps } = await memoHeavyBiz(r);
  const memoRowsAt = (x) => x.memos().map((m) => [m.id, m.ref, m.start, m.end]);
  for (let round = 0; round < 8; round++) {
    const d = await base.clone();
    const before = finalTexts(d); const want = new Map(before); const used = new Set();
    for (let e = 0; e < 6; e++) {
      const p = ps[Math.floor(r() * ps.length)]; if (used.has(p.ref)) continue; used.add(p.ref);
      const t = Array.from(d.text(p.ref)); const n = t.length;
      const a = Math.floor(r() * n); const b = a + 1 + Math.floor(r() * (n - a));
      const kind = Math.floor(r() * 3);
      if (kind === 0) { d.deleteTracked(p.ref, a, b, { author }); want.set(p.ref, t.slice(0, a).join('') + t.slice(b).join('')); }
      else if (kind === 1) { d.replaceTracked(p.ref, a, b, '★새글', { author }); want.set(p.ref, `${t.slice(0, a).join('')}★새글${t.slice(b).join('')}`); }
      else { const nt = `${t.slice(0, a).join('')}바꿈${t.slice(b).join('')}!`; d.mergeParagraphText(p.ref, nt, { author }); want.set(p.ref, nt); }
    }
    assert.deepEqual(ctrlInsideDeletes(d), [], `round ${round}`);
    const f = await d.flattened();
    assert.deepEqual(finalTexts(f), [...want], `round ${round}: 최종본`);
    assert.equal(f.memos().length, base.memos().length);
    const g = await d.clone(); g.rejectAll();
    assert.deepEqual([finalTexts(g), memoRowsAt(g)], [before, memoRowsAt(base)], `round ${round}: 거절`);
  }
});

test('무작위 망가진 변경(개체를 품은 삭제·문단을 넘는 삭제/삽입 + 보통 교체): tolerant 는 던지지 않고 사본 글 = 원본 최종본', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const r = seeded(8);
  const { base, ps } = await memoHeavyBiz(r);
  let skipped = 0;
  for (let round = 0; round < 10; round++) {
    const d = await base.clone();
    const han = d.header.ensureAuthor('한글'); const used = new Set();
    const free = () => { for (let k = 0; k < 20; k++) { const p = ps[Math.floor(r() * ps.length)]; if (!used.has(p.ref)) { used.add(p.ref); return p.ref; } } return null; };
    for (let e = 0; e < 5; e++) {
      const ref = free(); if (!ref) continue;
      const n = d.resolve(ref).p.chars.length; const a = Math.floor(r() * n); const kind = Math.floor(r() * 4);
      if (kind === 0) {
        const id = d.header.addChange('Delete', han, DATE); const b = a + Math.floor(r() * (n - a));
        inject(d, ref, b, 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="0"/>`); inject(d, ref, a, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
      } else if (kind === 1) {
        const id = d.header.addChange('Delete', han, DATE); const ref2 = free();
        if (ref2) inject(d, ref2, Math.floor(r() * d.resolve(ref2).p.chars.length), 'after', `<hp:deleteEnd Id="${id}" TcId="${id}" paraend="1"/>`);
        inject(d, ref, a, 'before', `<hp:deleteBegin Id="${id}" TcId="${id}"/>`);
      } else if (kind === 2) {
        const id = d.header.addChange('Insert', han, DATE);
        inject(d, ref, a, 'before', `<hp:insertBegin Id="${id}" TcId="${id}"/>`);
      } else {
        d.replaceTracked(ref, a, Math.min(n, a + 1 + Math.floor(r() * 3)), 'X', { author }); // 엔진의 보통 교체(그대로 수락된다)
      }
    }
    const want = finalTexts(d);
    const f = await d.flattened({ tolerant: true });
    skipped += f.lastTolerantSkips.length;
    assert.deepEqual([marks(f), f.changes().length], [0, 0], `round ${round}`);
    assert.deepEqual(finalTexts(f), want, `round ${round}: 사본 글 = 원본 최종본`);
    assert.equal(f.memos().length, base.memos().length);
    const v = await d.viewerCopy({ tolerant: true });
    assert.deepEqual(finalTexts(await reload(v)), want);
  }
  assert.ok(skipped >= 10, `tolerant 로 처리한 변경 ${skipped}건`);
});

// ───────── §4.2 addMemos ─────────

/** 같은 목록을 addMemo 로 차례로 / addMemos 로 한 번에 — 같은 씨앗 난수 → [차례 문서, 묶음 문서, 차례 id, 묶음 id, 묶음 ms] */
async function seqVsBatch(buf, items, seed = 42) {
  const seq = await HwpxDoc.load(buf); const bat = await HwpxDoc.load(buf);
  const seqIds = withSeed(seed, () => items.map((it) => seq.addMemo(it.ref, it)));
  const t = performance.now();
  const batIds = withSeed(seed, () => bat.addMemos(items));
  return { seq, bat, seqIds, batIds, ms: performance.now() - t };
}

test('addMemos: addMemo 를 차례로 부른 것과 같다(같은 문단·맞닿은 범위·빈 범위·빈 문단·표 칸과 그 표 문단·특수 문자)', async () => {
  const d = await textTableDoc({ before: '표 앞 글', after: '' }); // s0/p1 = 글 + 표(칸 s0/p1/n0..n3)
  d.insertParagraphAfter(0, 2, '', { author, date: DATE }); // 빈 문단 s0/p3
  d.acceptAll();
  assert.equal(d.text('s0/p3'), '');
  const buf = await d.save();
  const items = [
    { ref: 's0/p2', author, text: '문단 전체', date: DATE },
    { ref: 's0/p2', start: 0, end: 3, author, text: '앞 셋', date: DATE },
    { ref: 's0/p2', start: 3, end: 6, author: '김검토', text: '맞닿은 범위\n둘째 줄', date: DATE },
    { ref: 's0/p2', start: 3, end: 3, author, text: '빈 범위', date: DATE },
    { ref: 's0/p2', start: 0, end: 3, author, text: '같은 범위 또', date: DATE },
    { ref: 's0/p3', author, text: '빈 문단 1', date: DATE },
    { ref: 's0/p3', author, text: '빈 문단 2', date: DATE },
    { ref: 's0/p1/n1', author, text: '칸 메모 1', date: DATE }, // '나'
    { ref: 's0/p1', start: 0, end: 2, author, text: '표 문단 글 메모', date: DATE }, // 표 앞 글 → 그 뒤 칸 번호가 하나 밀린다
    { ref: 's0/p1/n1', author, text: '칸 메모 2', date: DATE }, // 차례로 부를 때처럼 밀린 번호로 읽는다 → '가'
    { ref: 's0/p0', start: 12, end: 20, author: 'A&B <검토>', text: '특수 문자 <&> "따옴표"', date: DATE },
    { ref: 's0/p0', author, text: '메모가 이미 있는 문단 전체', date: DATE },
  ];
  const { seq, bat, seqIds, batIds } = await seqVsBatch(buf, items);
  assert.deepEqual(batIds, seqIds);
  assert.deepEqual(batIds, ['memo2', 'memo3', 'memo4', 'memo5', 'memo6', 'memo7', 'memo8', 'memo9', 'memo10', 'memo11', 'memo12', 'memo13']);
  assert.deepEqual(xmlOf(bat), xmlOf(seq), '구역 XML 이 글자 하나까지 같다');
  assert.equal(bat.header.xml, seq.header.xml);
  assert.deepEqual(bat.memos(), seq.memos());
  const byText = new Map(bat.memos().map((m) => [m.text, m]));
  assert.equal(bat.text(byText.get('칸 메모 1').ref), '나');
  assert.equal(bat.text(byText.get('칸 메모 2').ref), '가', 'ref 는 앞 메모를 단 뒤의 문서로 읽는다(차례로 부른 것과 같음)');
  assert.deepEqual(['빈 문단 1', '빈 문단 2'].map((t) => byText.get(t).ref), ['s0/p3', 's0/p3']);
  assert.equal(byText.get('특수 문자 <&> "따옴표"').author, 'A&B <검토>');
  assert.deepEqual(memoRows(await reload(bat)), memoRows(bat));
});

test('addMemos: 중첩 표·메모 본문 ref·되풀이·뒤섞인 순서 — 바깥 대상 안의 대상(조각 나무)도 차례로 단 것과 같다', async () => {
  const doc = await nestedTableDoc();
  const buf = await doc.save();
  const items = [
    { ref: 's0/p1/n3/n1', author, text: '깊은 칸 1', date: DATE }, // '바'
    { ref: 's0/p1/n3', start: 0, end: 1, author, text: '칸 라 메모', date: DATE }, // '라' 자기 글 → 그 안 중첩 칸 번호가 하나 밀린다
    { ref: 's0/p1/n3/n1', author, text: '깊은 칸 2', date: DATE }, // 밀린 번호로 읽는다 → '마'
    { ref: 's0/p1', start: 0, end: 2, author, text: '표 문단 메모\n둘째 줄', date: DATE }, // 두 줄 → 칸 번호가 둘 밀린다
    { ref: 's0/p1/n3', author, text: '칸 메모(밀림)', date: DATE }, // → 원래 n1 '나'
    { ref: 's0/p1/n5/n2', author, text: '깊은 칸 3', date: DATE }, // 원래 n3 '라' 의 [메모 본문, 마, 바 …] → '바'
    { ref: 's0/p1/n0', author, text: '메모 본문 문단에 메모', date: DATE }, // n0 = 표 문단 메모 본문 첫 줄(차례로 부를 때와 같은 문단)
    { ref: 's0/p1', start: 3, end: 5, author, text: '표 문단 둘째 메모', date: DATE },
    { ref: 's0/p0', author, text: '첫 문단', date: DATE },
    { ref: 's0/p1/n6', start: 0, end: 0, author, text: '빈 범위 칸', date: DATE },
    { ref: 's0/p1/n6/n3', author, text: '깊은 칸 4', date: DATE },
    { ref: 's0/p2', start: 1, end: 4, author, text: '셋째 문단', date: DATE },
  ];
  const { seq, bat, seqIds, batIds } = await seqVsBatch(buf, items);
  assert.deepEqual(batIds, seqIds);
  assert.deepEqual(xmlOf(bat), xmlOf(seq), '구역 XML 이 글자 하나까지 같다');
  assert.deepEqual(bat.memos(), seq.memos());
  const at = new Map(bat.memos().map((m) => [m.text, [m.where, bat.text(m.ref)]]));
  assert.deepEqual(['깊은 칸 1', '깊은 칸 2', '칸 메모(밀림)', '깊은 칸 3', '메모 본문 문단에 메모', '빈 범위 칸'].map((t) => at.get(t)),
    [['표', '바'], ['표', '마'], ['표', '나'], ['표', '바'], ['메모', '표 문단 메모'], ['표', '라']]);
  // 무작위: 차례로 단 문서의 그때 문단(표 문단 가중, 가끔 메모 본문)에서 고른 목록 — 묶음 결과가 같아야 한다
  for (let seed = 1; seed <= 25; seed++) {
    const r = seeded(seed);
    const seqD = await HwpxDoc.load(buf); const list = [];
    withSeed(seed * 7, () => {
      for (let i = 0; i < 40; i++) {
        const all = seqD.paragraphs();
        let ref = r() < 0.3 ? 's0/p1' : all[Math.floor(r() * all.length)].ref;
        if (r() < 0.1) { const kids = seqD.resolve('s0/p1').p.children; ref = kids[Math.floor(r() * kids.length)].ref; }
        const len = [...seqD.text(ref)].length;
        const a = Math.floor(r() * (len + 1)); const b = a + Math.floor(r() * (len - a + 1));
        const it = r() < 0.3 ? { ref, author, text: `m${i}`, date: DATE } : { ref, start: a, end: b, author, text: r() < 0.2 ? `m${i}\n둘째 줄` : `m${i}`, date: DATE };
        seqD.addMemo(ref, it); list.push(it);
      }
    });
    const batD = await HwpxDoc.load(buf);
    withSeed(seed * 7, () => batD.addMemos(list));
    assert.deepEqual(xmlOf(batD), xmlOf(seqD), `seed ${seed}`);
  }
});

test('addMemos: 큰 표 문단 + 그 칸 149개 — 바깥 문단을 항목마다 다시 읽지 않는다(읽는 XML 이 구역 몇 배 안쪽)', async (t) => {
  const d0 = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const rows = Array.from({ length: 300 }, (_, i) => Array.from({ length: 8 }, (_, c) => `칸 ${i}-${c} 내용 글`));
  const tr = d0.insertTableAfter(0, 0, { rows, headerRows: 1 }, { author });
  const buf = await d0.save();
  const probe = await HwpxDoc.load(buf);
  const secLen = probe.sections[0].xml.length;
  const tp = probe.resolve(tr.ref).p;
  assert.ok(tp.end - tp.start > 0.9 * secLen, '구역 대부분이 표 문단 하나');
  const cells = probe.paragraphs().filter((p) => p.parent === tr.ref).slice(0, 149);
  const cellItems = cells.map((c, i) => ({ ref: c.ref, start: 0, end: 2, author, text: `칸 메모 ${i}`, date: DATE }));
  const own = { ref: tr.ref, author, text: '표 문단 메모', date: DATE };
  // [이름, 목록, 읽어도 되는 XML(구역 배수)] — 표 문단 자기 메모마다 표 문단을 한두 번 더 읽는다(예전: 항목마다 = 150배쯤)
  const cases = [
    ['표 문단 먼저', [own, ...cellItems], 4],
    ['표 문단 나중', [...cellItems, own], 4],
    ['가운데 두 번', [...cellItems.slice(0, 70), own, ...cellItems.slice(70), { ...own, text: '표 문단 메모 둘' }], 6],
  ];
  const load = Section.prototype.load;
  for (const [name, list, limit] of cases) {
    const d = await HwpxDoc.load(buf);
    let read = 0;
    Section.prototype.load = function (x) { read += x.length; return load.call(this, x); };
    const t0 = performance.now();
    let ids;
    try { ids = d.addMemos(list); } finally { Section.prototype.load = load; }
    const ms = performance.now() - t0;
    t.diagnostic(`${name}: ${list.length}개 ${Math.round(ms)}ms, 읽은 XML = 구역 ${(read / secLen).toFixed(2)}배`);
    assert.ok(read <= limit * secLen, `${name}: 읽은 XML 이 구역의 ${(read / secLen).toFixed(1)}배`);
    assert.ok(ms < 2000, `${name}: ${Math.round(ms)}ms`);
    // 표 문단 메모는 표 뒤(글 없는 문단)라 칸 번호가 밀리지 않는다 → 칸 메모는 모두 그 칸 첫 두 글자
    const got = new Map(d.memos().map((m) => [m.id, m]));
    assert.equal(got.size, list.length + probe.memos().length);
    list.forEach((it, k) => {
      const m = got.get(ids[k]);
      if (it.ref === tr.ref) assert.deepEqual([m.ref, m.text], [tr.ref, it.text]);
      else assert.deepEqual([m.ref, m.anchorText, m.text], [it.ref, probe.text(it.ref).slice(0, 2), it.text]);
    });
  }
});

test('addMemos: 지금 문서 ref 로 미리 만든 목록은 깊은 ref 를 먼저 두면 모두 제자리(검토 메모 내보내기 — 메모는 자기 문단의 자식 번호만 민다)', async () => {
  const base = await nestedTableDoc();
  const depth = (ref) => ref.split('/n').length;
  // 문서 순서(본문 문단 → 그 칸) 그대로면 차례로 단 것과 같은 규칙으로 칸이 밀린다: 표 문단 전체 메모(표를 품음) 뒤 's0/p1/n3' 은 원래 '다'
  const plain = [{ ref: 's0/p1', start: 0, end: 8, author, text: '본문 검토', date: DATE }, { ref: 's0/p1/n3', start: 0, end: 1, author, text: '칸 검토', date: DATE }];
  const a = await base.clone(); a.addMemos(plain);
  assert.equal(a.memos().find((m) => m.text === '칸 검토').anchorText, '다');
  const b = await base.clone(); b.addMemos([...plain].sort((x, y) => depth(y.ref) - depth(x.ref)));
  assert.equal(b.memos().find((m) => m.text === '칸 검토').anchorText, '라');
  // 무작위 대상 묶음(본문·칸·중첩 칸, 문서 순서, 범위 = 지금 글 전체, 여러 줄 메모 섞음) → 깊은 것 먼저면 모두 제자리
  const r = seeded(5);
  const ps = base.paragraphs().filter((p) => p.text);
  for (let round = 0; round < 12; round++) {
    const items = ps.filter(() => r() < 0.6).map((p, i) => ({ ref: p.ref, start: 0, end: p.length, author, text: i % 3 ? `검토 ${i}` : `검토 ${i}\n둘째 줄`, date: DATE }));
    const want = new Map(items.map((it) => [it.text, base.text(it.ref)]));
    const d = await base.clone();
    d.addMemos([...items].sort((x, y) => depth(y.ref) - depth(x.ref)));
    const got = d.memos().filter((m) => want.has(m.text));
    assert.equal(got.length, items.length, `round ${round}`);
    for (const m of got) assert.deepEqual([m.text, m.anchorText, d.text(m.ref)], [m.text, want.get(m.text), want.get(m.text)], `round ${round}`);
  }
});

test('addMemos: v0.2 엔진의 addMemo 를 차례로 부른 것과 XML 이 같다(표본 표 칸·빈 문단 무작위)', { skip: !(OldDoc && hasBiz) && 'v0.2 엔진 또는 biz 표본 없음' }, async () => {
  const buf = fs.readFileSync(BIZ);
  const ps = (await HwpxDoc.load(buf)).paragraphs();
  const r = seeded(7); const items = [];
  for (let i = 0; i < 60; i++) {
    const p = ps[Math.floor(r() * ps.length)];
    const a = Math.floor(r() * (p.length + 1)); const b = a + Math.floor(r() * (p.length - a + 1));
    items.push(i % 4 === 0 ? { ref: p.ref, author, text: `메모 ${i}\n둘째 줄`, date: DATE } : { ref: p.ref, start: a, end: i % 4 === 1 ? a : b, author, text: `메모 ${i}`, date: DATE });
  }
  const old = await OldDoc.load(buf);
  const oldIds = withSeed(42, () => items.map((it) => old.addMemo(it.ref, it)));
  const { seq, bat, seqIds, batIds } = await seqVsBatch(buf, items);
  assert.deepEqual([seqIds, batIds], [oldIds, oldIds]);
  assert.deepEqual(xmlOf(seq), xmlOf(old), 'addMemo 는 v0.2 와 같은 XML');
  assert.deepEqual(xmlOf(bat), xmlOf(old), 'addMemos 도 같은 XML');
});

test('addMemos: 여러 구역 — 구역마다 한 번만 다시 읽고 차례로 단 것과 같다(번호는 문서 전체, zorder·고유 번호·열쇠는 구역마다)', async () => {
  // 메모리 안에서 둘째 구역(첫 구역 사본)을 붙인 문서 — 저장하지 않고 비교만
  const make = async () => {
    const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
    d.sections.push(new Section(d.sections[0].xml, 1)); d.sectionNames.push('Contents/section1.xml');
    return d;
  };
  const items = [
    { ref: 's1/p1', start: 0, end: 3, author, text: '둘째 구역 1', date: DATE },
    { ref: 's0/p1', start: 0, end: 3, author, text: '첫 구역 1', date: DATE },
    { ref: 's1/p1', start: 3, end: 6, author, text: '둘째 구역 2', date: DATE },
    { ref: 's1/p2', author, text: '둘째 구역 3', date: DATE },
  ];
  const seq = await make(); const bat = await make();
  const seqIds = withSeed(9, () => items.map((it) => seq.addMemo(it.ref, it)));
  const loads = bat.sections.map((s) => { let n = 0; const orig = s.load.bind(s); s.load = (x) => { n++; return orig(x); }; return () => n; });
  const batIds = withSeed(9, () => bat.addMemos(items));
  assert.deepEqual(batIds, seqIds);
  assert.deepEqual(batIds, ['memo2', 'memo3', 'memo4', 'memo5']);
  assert.deepEqual(loads.map((n) => n()), [1, 1], '구역마다 한 번');
  assert.deepEqual(xmlOf(bat), xmlOf(seq));
  assert.deepEqual(bat.memos(), seq.memos());
  assert.deepEqual(bat.memos().filter((m) => m.fieldId === '900000001').map((m) => m.key), ['s0:f900000001', 's1:f900000001'], '같은 fieldId 도 구역이 다르면 다른 열쇠');
});

test('addMemos: 하나라도 틀리면 아무것도 바꾸지 않고 던진다 · 빈 목록', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const before = xmlOf(d);
  assert.deepEqual(d.addMemos([]), []);
  const ok = { ref: 's0/p1', author, text: '좋은 메모' };
  const cases = [
    [{ ref: 's0/p1', start: 0, end: 999, author, text: '범위 밖' }, 'RANGE'],
    [{ ref: 's0/p9', author, text: '없는 문단' }, 'NO_PARAGRAPH'],
    [{ ref: 's3/p0', author, text: '없는 구역' }, 'NO_PARAGRAPH'],
    [{ ref: 's0/p2/n0', author, text: '없는 중첩' }, 'NO_PARAGRAPH'],
    [{ ref: 'x', author, text: '모양이 틀린 ref' }, 'NO_PARAGRAPH'],
    [{ ref: 's0/p1', text: '작성자 없음' }, 'NO_AUTHOR'],
    [{ ref: 's0/p1', author, text: '' }, 'EMPTY'],
  ];
  for (const [bad, code] of cases) {
    assert.throws(() => d.addMemos([ok, bad, ok]), (e) => e.code === code, code);
    assert.deepEqual(xmlOf(d), before, `${code}: 문서 그대로`);
  }
  assert.equal(d.memos().length, 1);
  // 숫자를 0 으로 채운 ref 도 같은 문단(차례로 부른 addMemo 와 같다)
  const ids = d.addMemos([{ ref: 's0/p01', start: 0, end: 2, author, text: 'a', date: DATE }, { ref: 's0/p1', start: 2, end: 4, author, text: 'b', date: DATE }]);
  assert.deepEqual(d.memos().filter((m) => ids.includes(m.id)).map((m) => [m.ref, m.start, m.end]), [['s0/p1', 0, 2], ['s0/p1', 2, 4]]);
});

test('addMemos: 큰 보고서에 150개 — 2초 안쪽, 모두 제자리 · 차례로 단 것과 같다(앞 20개)', { skip: !hasBig && '큰 보고서 표본 없음' }, async (t) => {
  const buf = fs.readFileSync(BIG);
  const probe = await HwpxDoc.load(buf);
  assert.equal(probe.memos().length, 0);
  // 서로 조상·자손이 아닌 글 있는 문단 150개(본문·표 칸 섞임)
  const r = seeded(11); const cand = probe.paragraphs().filter((p) => p.text);
  const chosen = [];
  while (chosen.length < 150) {
    const p = cand[Math.floor(r() * cand.length)];
    if (chosen.some((q) => q.ref === p.ref || p.ref.startsWith(`${q.ref}/`) || q.ref.startsWith(`${p.ref}/`))) continue;
    chosen.push(p);
  }
  assert.ok(chosen.some((p) => p.cell) && chosen.some((p) => !p.parent), '본문과 표 칸이 섞인다');
  const items = chosen.map((p, i) => {
    const a = Math.floor(r() * p.length); const b = a + 1 + Math.floor(r() * (p.length - a));
    return i % 5 === 0 ? { ref: p.ref, author, text: `메모 ${i}`, date: DATE } : { ref: p.ref, start: a, end: b, author: i % 2 ? '김검토' : author, text: `메모 ${i}`, date: DATE };
  });
  const d = await HwpxDoc.load(buf);
  const t0 = performance.now();
  const ids = d.addMemos(items);
  const ms = performance.now() - t0;
  t.diagnostic(`addMemos 150개(큰 보고서) ${Math.round(ms)}ms`);
  assert.ok(ms < 2000, `150개 ${Math.round(ms)}ms — 2초 안쪽이어야 한다`);
  assert.deepEqual(ids, items.map((_, i) => `memo${i + 1}`));
  const got = new Map(d.memos().map((m) => [m.id, m]));
  assert.equal(got.size, 150);
  items.forEach((it, i) => {
    const m = got.get(ids[i]);
    const len = probe.paragraphs().find((p) => p.ref === it.ref).length;
    assert.deepEqual([m.ref, m.start, m.end, m.text, m.number], [it.ref, it.start ?? 0, it.end ?? len, it.text, i + 1], it.ref);
  });
  assert.deepEqual(d.paragraphs().map((p) => p.text), probe.paragraphs().map((p) => p.text), '본문 글은 그대로');
  assert.deepEqual(memoRows(await reload(d)), memoRows(d));
  // 차례로 단 것과 같다(큰 구역은 addMemo 한 번에 수십 ms 라 앞 20개만)
  const few = items.slice(0, 20);
  const { seq, bat, seqIds, batIds } = await seqVsBatch(buf, few, 5);
  assert.deepEqual(batIds, seqIds);
  assert.ok(xmlOf(bat)[0] === xmlOf(seq)[0], '구역 XML 이 같다');
});

// ───────── §3.6 메모 열쇠 ─────────

test('memos().key = s{구역}:f{fieldId} · memoKey · 저장·최종본에도 같은 열쇠(나머지 필드는 그대로)', async () => {
  const d = await HwpxDoc.load(fx('tool_memo_tracked.hwpx'));
  const [m] = d.memos();
  assert.equal(m.key, 's0:f900000001');
  assert.equal(memoKey(m), m.key);
  assert.equal(memoKey({ ref: 's2/p3/n1', fieldId: '77' }), 's2:f77');
  assert.equal(memoKey({ section: 1, fieldId: 5 }), 's1:f5');
  assert.equal(memoKey({ key: 's0:f1' }), 's0:f1', '구역·fieldId 를 모르면 주어진 key');
  for (const x of [null, undefined, 'memo1', { ref: 's0/p1' }, { fieldId: '1' }, { ref: 'x', fieldId: '1' }]) assert.equal(memoKey(x), null);
  const id = d.addMemo('s0/p1', { start: 0, end: 4, author, text: '새 메모', date: DATE });
  const keys = d.memos().map((x) => x.key);
  const mine = d.memos().find((x) => x.id === id);
  assert.equal(mine.key, `s0:f${mine.fieldId}`);
  assert.equal(new Set(keys).size, keys.length, '구역 안에서 유일');
  assert.deepEqual((await reload(d)).memos().map((x) => x.key), keys);
  assert.deepEqual((await d.flattened()).memos().map((x) => x.key), keys);
  if (OldDoc) {
    // key 만 더했다: v0.2 엔진의 memos() 와 나머지가 같다
    const o = await OldDoc.load(await d.save());
    assert.deepEqual(d.memos().map(({ key, ...rest }) => rest), o.memos());
  }
});

test('memos().key: 편집기(rhwp) 내보내기에도 같은 열쇠', { skip: !hasRhwp && 'rhwp 없음' }, async () => {
  const mod = await rhwp();
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  d.addMemos([{ ref: 's0/p1', start: 0, end: 4, author, text: '가' }, { ref: 's0/p2', author, text: '나' }]);
  const r = new mod.HwpDocument(new Uint8Array(await d.save()));
  const back = await HwpxDoc.load(Buffer.from(r.exportHwpx()));
  assert.deepEqual(back.memos().map((m) => [m.key, m.ref, m.start, m.end]), d.memos().map((m) => [m.key, m.ref, m.start, m.end]));
});

// ───────── §4.4 diffDocs 'format' ─────────

test("diffDocs 'format': 글이 같고 글자 모양만 바뀐 문단 — charPr id 가 아니라 실제 속성(글꼴·굵게 …)을 본다", async () => {
  const base = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const fmt = (r) => r.hunks.filter((u) => u.type === 'format');
  // 글꼴만 다른 charPr(0: 함초롬바탕 → 1: 함초롬돋움)
  let head = await base.clone(); setRunCharPr(head, 's0/p1', '1');
  let r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map((u) => [u.ref, u.type]), [['s0/p1', 'format']]);
  assert.match(r.hunks[0].formatSummary, /글꼴/); assert.doesNotMatch(r.hunks[0].formatSummary, /굵게/);
  // 굵게 + 다른 문단 글자색
  head = await base.clone();
  setRunCharPr(head, 's0/p1', head.header.boldCharPr('0'));
  const red = head.header.addItem('charProperties', 'charPr', head.header.block('charPr', '0').replace('textColor="#000000"', 'textColor="#FF0000"'));
  setRunCharPr(head, 's0/p2', red);
  r = await diffDocs(base, head);
  assert.deepEqual(fmt(r).map((u) => [u.ref, u.formatSummary]), [
    ['s0/p1', '굵게'],
    ['s0/p2', '글자색'],
  ]);
  // id 만 다르고 속성이 같은 charPr → 서식 차이 아님(문서마다 header id 가 다르다)
  head = await base.clone(); setRunCharPr(head, 's0/p1', duplicateCharPr(head, '0'));
  assert.notEqual(head.resolve('s0/p1').p.runs[0].charPr, '0');
  assert.deepEqual(await diffDocs(base, head), { hunks: [], unsupported: [] });
  // 글도 바뀐 문단은 replace 덩어리에 서식 변경을 함께 표시한다.
  head = await base.clone(); setRunCharPr(head, 's0/p1', head.header.boldCharPr('0'));
  head.mergeParagraphText('s0/p1', `${base.text('s0/p1')} 덧붙임`, { author }); head.acceptAll();
  r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map((h) => [h.type, h.ref]), r.unsupported], [[['replace', 's0/p1']], []]);
  assert.equal(r.hunks[0].formatting, true);
  // 자기 자신·복제본은 차이 없음
  assert.deepEqual(await diffDocs(base, await base.clone()), { hunks: [], unsupported: [] });
});

test("diffDocs 'format': 표 칸 글자 모양만 바뀜 → 그 칸 ref 로 알린다", async () => {
  const base = await textTableDoc({ before: '', after: '' }); // s0/p1 = 표만(칸 가·나/다·라)
  const head = await base.clone();
  const cell = head.paragraphs().find((p) => p.cell && p.cell.row === 1 && p.cell.col === 1);
  assert.equal(cell.text, '라');
  setRunCharPr(head, cell.ref, head.header.boldCharPr(head.resolve(cell.ref).p.runs[0].charPr));
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map((u) => [u.ref, u.type, u.formatSummary]), [[cell.ref, 'format', '굵게']]);
});

test("diffDocs 'format': 편집기(rhwp)에서 굵게·글자색 — 알리고, 고치지 않은 내보내기는 차이 없음", { skip: !(hasBiz && hasRhwp) && 'biz 표본 또는 rhwp 없음' }, async () => {
  const mod = await rhwp();
  const base = await (await HwpxDoc.load(fs.readFileSync(BIZ))).flattened();
  const bytes = new Uint8Array(await base.save());
  const edit = async (fn) => { const d = new mod.HwpDocument(bytes.slice()); fn(d); return HwpxDoc.load(Buffer.from(d.exportHwpx())); };
  assert.deepEqual(await diffDocs(base, await edit(() => {})), { hunks: [], unsupported: [] });
  const head = await edit((d) => {
    d.applyCharFormat(0, 0, 0, 3, JSON.stringify({ bold: true }));
    d.applyCharFormat(0, 2, 1, 4, JSON.stringify({ textColor: '#FF0000' }));
  });
  const r = await diffDocs(base, head);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.hunks.map((u) => [u.ref, u.type, u.formatSummary]), [
    ['s0/p0', 'format', '굵게'],
    ['s0/p2', 'format', '글자색'],
  ]);
});
