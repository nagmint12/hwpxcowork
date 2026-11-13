// node --test tests/engine6.test.mjs — 칸 문단 수가 달라진 표 칸(칸 안에서 Enter·Backspace)의 diffDocs 접기(V4 §2.2 · V3 §3.2·§4.1)와
// 줄바꿈('\n' ↔ <hp:lineBreak/>) 왕복.
//  - 실시간 문서에서 칸 안 Enter 로 칸 문단이 하나 늘면 그 본문 문단의 중첩 구조(sig 목록)가 달라진다 — 예전 diffDocs 는 그 표의 칸 글을 하나도
//    비교하지 않아(unsupported table-structure) 밀어 넣기가 아무것도 넣지 못했고, 편집기를 기준에 맞추면(다시 열기) 그 표에 친 글이 모두 사라졌다.
//  - 이제 표 수·칸 묶음(표 순번·행·열) 차례가 같으면 칸마다 비교하고, 칸 문단 수만 다른 글 칸은 칸 문단 수를 그대로 두고 글을 '\n'(엔진은
//    <hp:lineBreak/>)으로 접은 replace 를 낸다(engine/diff.js foldOwners — 그대로인 글 문단은 그대로, Enter 조각은 나뉜 문단에, Backspace 로
//    합친 글은 앞 문단에, 받은 것이 없는 기준 문단은 글 비움, 빈 줄은 닻이 아님). 진짜 격자·표 수 변경, 칸 안 표·개체가 바뀐 칸,
//    캡션 문단 수 변경은 예전처럼 반영하지 않는다(unsupported). planBody 의 grid(칸 문단 수를 보지 않는 구조)도 본다.
// 칸을 나눈 수정본은 구역 XML 을 직접 고쳐 만든다(엔진에는 칸 문단 나누기가 없다) — 편집기(rhwp)의 실제 내보내기 모양도 따로 본다(있을 때).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpxDoc, diffDocs } from '../engine/doc.js';
import { planBody, foldOwners } from '../engine/diff.js';
import { escapeText } from '../engine/xmlscan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n));
const BIZ = path.join(here, 'samples', '경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'); // 표 5개
const hasBiz = fs.existsSync(BIZ);
const RHWP = path.join(here, '..', 'vendor', 'rhwp', 'pkg');
const hasRhwp = fs.existsSync(path.join(RHWP, 'rhwp_bg.wasm'));
let rhwpMod = null;
const rhwp = () => (rhwpMod ??= (async () => {
  globalThis.measureTextWidth ??= (font, text) => text.length * 10; // 레이아웃용 폭 측정 스텁(engine4 시험과 같음)
  const mod = await import(pathToFileURL(path.join(RHWP, 'rhwp.js')).href);
  const wasm = fs.readFileSync(path.join(RHWP, 'rhwp_bg.wasm'));
  if (typeof mod.initSync === 'function') mod.initSync({ module: wasm }); else await mod.default({ module_or_path: wasm });
  return mod;
})());
const author = '홍길동';
const DATE = new Date(Date.UTC(2026, 9, 23, 1, 2, 3));
const reload = async (d) => HwpxDoc.load(await d.save());
const strip = ({ hid, headRef, baseFormatFingerprint, newFormatFingerprint, formatting, ...rest }) => rest;
const ws = (u) => u.map(({ ref, what }) => [ref, what]);
const CELL11 = { table: 's0/p2#t0', row: 1, col: 1 };

/** 시험 문서: [글(메모), 빈 줄, 2×2 표(구분·값 / 가·첫째 칸 글), 글, 글] — 표 칸 (1,1) = s0/p2/n3 */
async function tableDoc(cell11 = '첫째 칸 글입니다') {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  d.insertParagraphAfter(0, 0, '', { author, date: DATE });
  d.insertTableAfter(0, 1, { rows: [['구분', '값'], ['가', cell11]] }, { author, date: DATE });
  d.acceptAll();
  return reload(d);
}

/**
 * 잇닿은 칸 문단들(refs — 같은 칸의 차례대로 문단)을 글 목록 parts 의 문단들로 바꾼다(편집기에서 Enter 로 나누거나 Backspace 로 합친 모양 —
 * 첫 문단의 문단 모양·글자 모양을 빌림). 바꾼 뒤 다시 읽은 문서를 돌려준다
 */
async function setCellParas(d, refs, parts) {
  const first = d.resolve(refs[0]); const last = d.resolve(refs[refs.length - 1]);
  const { sec } = first; const xml = sec.xml.slice(first.p.start, first.p.end);
  const open = /^<hp:p\b[^>]*>/.exec(xml)[0];
  const charPr = /<hp:run\b[^>]*?charPrIDRef="([^"]*)"/.exec(xml)?.[1] ?? '0';
  const paras = parts.map((t) => `${open}<hp:run charPrIDRef="${charPr}">${t ? `<hp:t>${escapeText(t)}</hp:t>` : ''}</hp:run></hp:p>`).join('');
  sec.load(sec.xml.slice(0, first.p.start) + paras + sec.xml.slice(last.p.end));
  return reload(d);
}

/** 문단 첫 run 맨 앞에 개체 요소를 끼운다(engine4 와 같음 — 그림 자료는 없다) */
function injectObject(d, ref, tag = 'hp:pic') {
  const { sec, p } = d.resolve(ref); const run = p.runs[0];
  assert.ok(run && !run.selfclose, `${ref} 에 열린 run 이 있어야 한다`);
  const at = sec.tokens[run.openTok].end;
  sec.load(`${sec.xml.slice(0, at)}<${tag}/>${sec.xml.slice(at)}`);
}

/** 덩어리를 기준 문서 사본에 그대로 적용(replace 만 — 칸 접기 확인용)하고 수락한 문서 */
async function applied(base, hunks) {
  const a = await base.clone();
  for (const h of hunks) { assert.equal(h.type, 'replace'); a.mergeParagraphText(h.ref, h.newText, { author, date: DATE }); }
  a.acceptAll();
  return reload(a);
}
/** 칸 (table key 끝 '#t<k>', row, col) 문단 글 목록(문서 순서) */
const cellTexts = (d, body, row, col, ord = 0) => d.paragraphs().filter((p) => p.cell && p.ref.startsWith(`${body}/`) && p.cell.table === `${body}#t${ord}` && p.cell.row === row && p.cell.col === col).map((p) => p.text);

// ───────── 줄바꿈 '\n' ↔ <hp:lineBreak/> ─────────

test('줄바꿈: insertTracked·replaceTracked·mergeParagraphText 가 "\\n" 을 <hp:lineBreak/> 로 쓰고 "\\n" 으로 다시 읽는다(본문·칸, 수락·거절·지우기)', async () => {
  const base = await tableDoc('칸 글');
  const d = await base.clone();
  // 칸: 넣기(수락 전 표식 안에도 lineBreak) → 다시 읽어도 '\n'
  const id = d.insertTracked('s0/p2/n3', 1, '\n둘째', { author, date: DATE });
  assert.equal(d.text('s0/p2/n3'), '칸\n둘째 글');
  assert.match(d.sections[0].xml, /<hp:insertBegin Id="\d+" TcId="\d+"\/><hp:lineBreak\/>둘째<hp:insertEnd /);
  let r = await reload(d);
  assert.deepEqual([r.text('s0/p2/n3'), r.text('s0/p2/n3', 'original')], ['칸\n둘째 글', '칸 글']);
  // 거절하면 lineBreak 요소째 없어진다
  const rej = await r.clone(); rej.rejectChange(id);
  assert.equal(rej.text('s0/p2/n3'), '칸 글');
  assert.ok(!(await reload(rej)).sections[0].xml.includes('<hp:lineBreak/>'));
  // 수락하면 표식만 지워지고 lineBreak 는 hp:t 안에 남는다
  r.acceptAll(); r = await reload(r);
  assert.equal(r.text('s0/p2/n3'), '칸\n둘째 글');
  assert.match(r.sections[0].xml, /<hp:t>칸<hp:lineBreak\/>둘째 글<\/hp:t>/);
  // 바꾸기(지움 + 넣음)에 '\n' 두 개, 탭도 함께
  const rp = await r.clone();
  rp.replaceTracked('s0/p2/n3', 0, 1, '첫\n\n둘\t셋', { author, date: DATE });
  rp.acceptAll();
  const rr = await reload(rp);
  assert.equal(rr.text('s0/p2/n3'), '첫\n\n둘\t셋\n둘째 글');
  assert.match(rr.sections[0].xml, /첫<hp:lineBreak\/><hp:lineBreak\/>둘<hp:tab\/>셋<hp:lineBreak\/>둘째 글/);
  // mergeParagraphText: '\n' 을 지우기(합침)·넣기 — 본문 문단도 같다
  const m = await rr.clone();
  m.mergeParagraphText('s0/p2/n3', '첫둘\t셋\n둘째 글', { author, date: DATE });
  m.mergeParagraphText('s0/p3', `${base.text('s0/p3')}\n본문 둘째 줄`, { author, date: DATE });
  m.acceptAll();
  const mm = await reload(m);
  assert.deepEqual([mm.text('s0/p2/n3'), mm.text('s0/p3').endsWith('\n본문 둘째 줄')], ['첫둘\t셋\n둘째 글', true]);
  assert.equal((mm.sections[0].xml.match(/<hp:lineBreak\/>/g) || []).length, 2);
  // 줄바꿈은 같은 문단 안 — 문단 수는 그대로
  assert.equal(mm.paragraphs().length, base.paragraphs().length);
});

// ───────── diffDocs 칸 접기 ─────────

test('diffDocs 칸 접기: 칸 안 Enter(가운데·두 번·끝 + 이어 치기·맨 앞) → 그 칸 첫 문단 replace 하나(글은 "\\n" 으로), table-structure 없음', async () => {
  const base = await tableDoc('첫째 칸 글입니다');
  const cases = [
    [['첫째 칸 ', '글입니다'], '첫째 칸 \n글입니다'],          // 가운데에서 Enter
    [['첫째 칸 ', '', '글입니다'], '첫째 칸 \n\n글입니다'],     // Enter 두 번
    [['첫째 칸 글입니다', '새 줄에 이어 친 글'], '첫째 칸 글입니다\n새 줄에 이어 친 글'], // 끝에서 Enter 하고 이어 치기
    [['', '첫째 칸 글입니다'], '\n첫째 칸 글입니다'],          // 맨 앞에서 Enter
    [['첫째 ', '칸 글', '입니다 고침'], '첫째 \n칸 글\n입니다 고침'], // 두 번 나누고 고침
  ];
  for (const [parts, want] of cases) {
    const head = await setCellParas(await base.clone(), ['s0/p2/n3'], parts);
    assert.deepEqual(cellTexts(head, 's0/p2', 1, 1), parts);
    const r = await diffDocs(base, head);
    assert.deepEqual([r.hunks.map(strip), r.unsupported], [[{ type: 'replace', ref: 's0/p2/n3', baseText: '첫째 칸 글입니다', newText: want, cell: CELL11 }], []], JSON.stringify(parts));
    assert.equal(want, parts.join('\n'), '이으면 수정본 칸 글 그대로(글 차례)');
    // 적용하면 칸 문단은 하나 그대로, 글은 줄바꿈으로 — XML 은 <hp:lineBreak/>
    const a = await applied(base, r.hunks);
    assert.deepEqual(cellTexts(a, 's0/p2', 1, 1), [want]);
    assert.equal((a.sections[0].xml.match(/<hp:lineBreak\/>/g) || []).length, parts.length - 1);
    // 같은 수정본은 다시 계산해도 같은 덩어리(hid 까지)
    assert.deepEqual(await diffDocs(base, head), r);
  }
});

test('diffDocs 칸 접기: Backspace 로 칸 문단을 합침 → 합친 글은 짝 문단에, 짝 없는 기준 문단은 비움(문단은 남음)', async () => {
  const base = await setCellParas(await tableDoc(), ['s0/p2/n3'], ['가나다', '라마바', '사아']);
  assert.deepEqual(cellTexts(base, 's0/p2', 1, 1), ['가나다', '라마바', '사아']);
  // 둘째 문단 맨 앞에서 Backspace(첫째와 합침)
  let head = await setCellParas(await base.clone(), ['s0/p2/n3', 's0/p2/n4'], ['가나다라마바']);
  let r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map(strip), r.unsupported], [[
    { type: 'replace', ref: 's0/p2/n3', baseText: '가나다', newText: '가나다라마바', cell: CELL11 },
    { type: 'replace', ref: 's0/p2/n4', baseText: '라마바', newText: '', cell: CELL11 },
  ], []]);
  let a = await applied(base, r.hunks);
  assert.deepEqual(cellTexts(a, 's0/p2', 1, 1), ['가나다라마바', '', '사아']);
  // 셋을 모두 합치고 고침 — 글 차례 그대로, 나머지 두 문단은 비움
  head = await setCellParas(await base.clone(), ['s0/p2/n3', 's0/p2/n4', 's0/p2/n5'], ['가나다라마바사아!']);
  r = await diffDocs(base, head);
  a = await applied(base, r.hunks);
  assert.deepEqual([cellTexts(a, 's0/p2', 1, 1).join(''), r.unsupported], ['가나다라마바사아!', []]);
  assert.equal(r.hunks.filter((h) => h.newText === '').length, 2);
});

test('diffDocs 칸 접기: 한 칸은 Enter, 다른 칸은 글만 고침 + 표 앞에 본문 문단을 넣어 번호가 밀려도 칸은 표 순번·행·열로 짝(덩어리 ref 는 기준)', async () => {
  const base = await tableDoc('값 칸');
  let head = await setCellParas(await base.clone(), ['s0/p2/n3'], ['값', ' 칸 둘째 줄']);
  head.mergeParagraphText('s0/p2/n0', '구분(고침)', { author });
  head.insertParagraphAfter(0, 0, '표 앞에 넣은 문단', { author }); // 수정본에서 표는 s0/p3
  head.acceptAll(); head = await reload(head);
  assert.equal(head.paragraphs().find((p) => p.cell && p.cell.row === 1 && p.cell.col === 1).ref, 's0/p3/n3');
  const r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map(strip), r.unsupported], [[
    { type: 'insert', ref: 's0/p0', afterRef: 's0/p0', baseText: '', newText: '표 앞에 넣은 문단', cell: null },
    { type: 'replace', ref: 's0/p2/n0', baseText: '구분', newText: '구분(고침)', cell: { table: 's0/p2#t0', row: 0, col: 0 } },
    { type: 'replace', ref: 's0/p2/n3', baseText: '값 칸', newText: '값\n 칸 둘째 줄', cell: CELL11 },
  ], []]);
  // 표만 있던 문단에 글도 씀(종류 table → text, 구조도 바뀜) — 짝이 되어 그 문단 replace 도 함께(structure 없음)
  let both = await setCellParas(await base.clone(), ['s0/p2/n3'], ['값 칸', '']);
  both.mergeParagraphText('s0/p2', '(단위: 명)', { author }); both.acceptAll(); both = await reload(both);
  const r2 = await diffDocs(base, both);
  assert.deepEqual([r2.hunks.map(strip), r2.unsupported], [[
    { type: 'replace', ref: 's0/p2', baseText: '', newText: '(단위: 명)', cell: null },
    { type: 'replace', ref: 's0/p2/n3', baseText: '값 칸', newText: '값 칸\n', cell: CELL11 },
  ], []]);
});

test('foldOwners: 칸 문단 주인 — 그대로인 문단은 그대로 · Enter 조각은 나뉜 문단으로 · Backspace 글은 앞 문단으로 · 빈 문단은 닻이 아님(서식의 빈 줄) · 거꾸로(플러그인 맞추기)도', () => {
  const X = 'ㅇ 납품자료 재검증 결과'; const Y = 'ㅇ 응답값 변경 없이 정리'; const H = '□ 안건 1.';
  // 가운데 Enter · 끝 Enter + 이어 침 · 맨 앞 Enter · Enter 두 번
  assert.deepEqual(foldOwners(['가나다라'], ['가나', '다라']), [0, 0]);
  assert.deepEqual(foldOwners([H, X, Y], [H, X, '새 줄', Y]), [0, 1, 1, 2]);
  assert.deepEqual(foldOwners([H, X, Y], [H, '', X, Y]), [0, 1, 1, 2]);
  assert.deepEqual(foldOwners([H, X, Y], [H, 'ㅇ 납품', '', '자료 재검증 결과', Y]), [0, 1, 1, 1, 2]);
  // Backspace(합침): 합친 글은 앞 문단 — 뒤 문단은 받은 것이 없다
  assert.deepEqual(foldOwners([H, 'ㅇ 납품', '자료 재검증 결과', Y], [H, X, Y]), [0, 1, 3]);
  assert.deepEqual(foldOwners(['첫째 ', '칸 글입니다'], ['첫째 칸 글입니다']), [0]);
  // 사용자 서식처럼 문단 사이에 빈 줄: X 맨 앞 Enter + 이어 침 — 빈 줄을 닻으로 삼으면 글이 다음 빈 문단으로 밀린다(예전 정렬)
  assert.deepEqual(foldOwners([H, X, '', Y], [H, '', `위 줄${X}`, '', Y]), [0, 1, 1, 2, 3]);
  assert.deepEqual(foldOwners([H, X, '', Y], [H, X, '새 줄', '', Y]), [0, 1, 1, 2, 3]);
  // 거꾸로(플러그인: 접힌 기준 ↔ 나뉜 편집기) — 같은 묶음
  assert.deepEqual(foldOwners([H, `\n위 줄${X}`, '', Y], [H, '', `위 줄${X}`, '', Y]), [0, 1, 1, 2, 3]);
  assert.deepEqual(foldOwners([H, `${X}\n새 줄`, '', Y], [H, X, '새 줄', '', Y]), [0, 1, 1, 2, 3]);
  assert.deepEqual(foldOwners([H, `${X}새`, '', Y], [H, X, '새', '', Y]), [0, 1, 1, 2, 3], '남의 고침이 섞여도(접힌 글과 다름) 같은 묶음');
  assert.deepEqual(foldOwners(['합친 글', ''], ['합친 글']), [0]);
  assert.deepEqual(foldOwners(['a'], []), []);
  // 어떤 경우에도 차례대로 늘기만 한다(무작위)
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const words = ['', '', 'ㅇ 가', '나다', ' ', '□ 라'];
  for (let n = 0; n < 500; n++) {
    const b = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => words[Math.floor(rnd() * words.length)]);
    const h = Array.from({ length: Math.floor(rnd() * 6) }, () => words[Math.floor(rnd() * words.length)]);
    const o = foldOwners(b, h);
    assert.equal(o.length, h.length);
    assert.ok(o.every((x, k) => x >= 0 && x < b.length && (k === 0 || x >= o[k - 1])), JSON.stringify([b, h, o]));
  }
});

test('diffDocs 칸 접기: 칸 안 빈 줄이 많은 서식 — 맨 앞 Enter 한 문단의 글은 그 문단에(다음 빈 문단으로 밀리지 않음)', async () => {
  const base = await setCellParas(await tableDoc(), ['s0/p2/n3'], ['□ 안건 1.', 'ㅇ 납품자료 재검증 결과', '', 'ㅇ 응답값 변경 없이 정리']);
  const head = await setCellParas(await base.clone(), ['s0/p2/n4'], ['', '위 줄ㅇ 납품자료 재검증 결과']);
  assert.deepEqual(cellTexts(head, 's0/p2', 1, 1), ['□ 안건 1.', '', '위 줄ㅇ 납품자료 재검증 결과', '', 'ㅇ 응답값 변경 없이 정리']);
  const r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map(strip), r.unsupported], [[{ type: 'replace', ref: 's0/p2/n4', baseText: 'ㅇ 납품자료 재검증 결과', newText: '\n위 줄ㅇ 납품자료 재검증 결과', cell: CELL11 }], []]);
  assert.deepEqual(cellTexts(await applied(base, r.hunks), 's0/p2', 1, 1), ['□ 안건 1.', '\n위 줄ㅇ 납품자료 재검증 결과', '', 'ㅇ 응답값 변경 없이 정리']);
});

test('planBody grid: 칸 문단 수를 보지 않는 구조(grid)가 같으면 종류·sig 가 달라도 짝 — 양쪽에 있을 때만, 같은 문단 판정에는 안 씀', async () => {
  const tbl = { text: '', kind: 'table', sig: 'S1', grid: 'G' };
  const txt = { text: '(단위: 명)', kind: 'text', sig: 'S2', grid: 'G' };
  const pre = [{ text: '앞 글', kind: 'text' }, { text: '', kind: 'empty' }];
  assert.deepEqual(planBody([...pre, tbl], [...pre, txt]).pairs, [[0, 0], [1, 1], [2, 2]]);
  // grid 가 한쪽에만 있거나 다르면 예전처럼(짝 없음 — 지움 + 넣음)
  assert.deepEqual(planBody([...pre, tbl], [...pre, { ...txt, grid: null }]).pairs, [[0, 0], [1, 1]]);
  assert.deepEqual(planBody([...pre, tbl], [...pre, { ...txt, grid: 'H' }]).pairs, [[0, 0], [1, 1]]);
  // 엔진: 칸 문단 수만 다른 같은 표 문단은 grid 가 같고 sig 는 다르다
  const base = await tableDoc();
  const head = await setCellParas(await base.clone(), ['s0/p2/n3'], ['첫째', ' 칸 글입니다']);
  const [b, h] = [base, head].map((d) => d._bodyInfo(d.sections[0], d.sections[0].bodyParas[2]));
  assert.deepEqual([b.grid === h.grid, b.sig === h.sig, !!b.grid], [true, false, true]);
  assert.ok(!('grid' in base.bodyEntries()[0][2]), 'bodyEntries 모양은 그대로');
});

test('diffDocs 칸 접기: 진짜 격자 변경(행·열)·표 수 변경은 표째 object 덩어리(2026-10-28 — 칸 글은 접지 않고 표와 함께 옮김)', async () => {
  const base = await tableDoc();
  // 2×2 → 2×3(같은 자리에 표를 바꿔 넣음) + 칸 문단 나눔 모양: 칸 묶음 차례가 달라 비교하지 않는다
  let reshaped = await base.clone();
  reshaped.removeBodyParagraph(0, 2); reshaped.insertTableAfter(0, 1, { rows: [['구분', '값', '비고'], ['가', '첫째 칸 글입니다', '']] }, { author });
  reshaped.acceptAll(); reshaped = await setCellParas(await reload(reshaped), ['s0/p2/n4'], ['첫째 칸', ' 글입니다']);
  const objs = (r) => r.hunks.map((h) => [h.type, h.ref, h.objectSummary ?? null]);
  let r = await diffDocs(base, reshaped);
  assert.deepEqual([objs(r), ws(r.unsupported)], [[['object', 's0/p2', '표 고침(크기·줄·칸)']], []]);
  // 행을 하나 더(3×2) — 마지막 행 칸이 늘어 차례가 다르다
  let rows = await base.clone();
  rows.removeBodyParagraph(0, 2); rows.insertTableAfter(0, 1, { rows: [['구분', '값'], ['가', '첫째 칸 글입니다'], ['나', '']] }, { author });
  rows.acceptAll(); rows = await reload(rows);
  r = await diffDocs(base, rows);
  assert.deepEqual([objs(r), ws(r.unsupported)], [[['object', 's0/p2', '표 고침(크기·줄·칸)']], []]);
  // 글 + 표 문단에서 표 하나를 더(표 수 변경) — 본문 replace + 표 넣음(object)
  const two = async (n, text) => {
    const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
    for (let k = 0; k < n; k++) d.insertTableAfter(0, 0, { rows: [['가', '나']] }, { author });
    d.acceptAll();
    const sec = d.sections[0];
    // 표 문단들을 첫 표 문단 하나로 모은다(한 본문 문단에 표 n개)
    const ps = sec.bodyParas.slice(1, 1 + n);
    const tbls = ps.map((p) => /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(p.start, p.end))[0]);
    const open = /^<hp:p\b[^>]*><hp:run\b[^>]*>/.exec(sec.xml.slice(ps[0].start, ps[0].end))[0];
    sec.load(sec.xml.slice(0, ps[0].start) + `${open}<hp:t>${text}</hp:t>${tbls.join('')}<hp:t/></hp:run></hp:p>` + sec.xml.slice(ps[n - 1].end));
    return reload(d);
  };
  const one = await two(1, '표 설명'); const pair = await two(2, '표 설명 고침');
  r = await diffDocs(one, pair);
  assert.deepEqual([objs(r), ws(r.unsupported)], [[['replace', 's0/p1', null], ['object', 's0/p1', '표 넣음']], []]);
});

test('diffDocs 칸 접기: 칸 안 Enter 로 표 높이 기록값(hp:tbl 의 hp:sz height)만 커지면 표 고침이 아니다 — 칸 크기(hp:cellSz)가 바뀌면 표 고침', async () => {
  // rhwp 0.9.0 편집기는 칸 글을 고친 표를 내보낼 때 표 높이를 내용 높이로 키워 적는다(grown_table_heights — 한/글도 다시 저장 때 실제 높이로
  // 고쳐 쓰고 조판에는 쓰지 않는다, docs/TABLE_VARIABLES_2026-11-04.md E1). 2026-11-10: 이 값을 뼈대로 봐서 실시간 칸 Enter 가 표째 옮김·다시 열기가 됐다
  const base = await tableDoc();
  const objs = (r) => r.hunks.map((h) => [h.type, h.ref, h.objectSummary ?? null]);
  const grow = async (d, re, fn) => { const c = await d.clone(); const sec = c.sections[0]; const was = sec.xml; sec.load(was.replace(re, fn)); assert.ok(sec.xml !== was, '고칠 자리'); return reload(c); };
  const split = await setCellParas(await base.clone(), ['s0/p2/n3'], ['첫째 칸', ' 글입니다']);
  const tall = await grow(split, /(<hp:tbl\b[^>]*>\s*<hp:sz\b[^>]*?\bheight=")(\d+)/, (_, a, h) => `${a}${Number(h) + 5000}`);
  let r = await diffDocs(base, tall);
  assert.deepEqual([objs(r), ws(r.unsupported)], [[['replace', 's0/p2/n3', null]], []]);
  assert.equal(r.hunks[0].newText, '첫째 칸\n 글입니다');
  // 줄 높이를 실제로 고침(칸 크기) — 그대로 표 고침
  const cellTall = await grow(split, /(<hp:cellSz\b[^>]*?\bheight=")(\d+)/, (_, a, h) => `${a}${Number(h) + 5000}`);
  r = await diffDocs(base, cellTall);
  assert.deepEqual(objs(r), [['object', 's0/p2', '표 고침(크기·줄·칸)']]);
});

/**
 * 중첩 표 문서(engine5 와 같은 모양): s0/p1 = '표 앞 글' + 표(가·나/다·라 = s0/p1/n0..n3) + '뒤 글', 칸 '라'(s0/p1/n3) 글 뒤에 2×2 표
 * (마·바/사·아 = s0/p1/n3/n0..n3) — 표본에 깊이 2 문단이 없어 둘째 표 XML 을 칸 안으로 옮겨 만든다
 */
async function nestedTableDoc() {
  const d = await (await HwpxDoc.load(fx('tool_memo_tracked.hwpx'))).flattened();
  const r = d.insertTableAfter(0, 0, { rows: [['가', '나'], ['다', '라']], headerRows: 1 }, { author });
  const inner = d.insertTableAfter(0, 1, { rows: [['마', '바'], ['사', '아']], headerRows: 0 }, { author });
  const sec = d.sections[0];
  const ip = d.resolve(inner.ref).p;
  const tbl = /<hp:tbl\b[\s\S]*<\/hp:tbl>/.exec(sec.xml.slice(ip.start, ip.end))[0];
  sec.load(sec.xml.slice(0, ip.start) + sec.xml.slice(ip.end));
  const p = d.resolve(r.ref).p;
  const x = sec.xml.slice(p.start, p.end)
    .replace(/^(<hp:p\b[^>]*><hp:run\b[^>]*>)(<hp:tbl\b)/, '$1<hp:t>표 앞 글</hp:t>$2')
    .replace(/<\/hp:tbl><hp:t\/><\/hp:run>/, '</hp:tbl><hp:t>뒤 글</hp:t></hp:run>')
    .replace('<hp:t>라</hp:t>', `<hp:t>라</hp:t>${tbl}<hp:t/>`);
  sec.load(sec.xml.slice(0, p.start) + x + sec.xml.slice(p.end));
  d.acceptAll();
  return reload(d);
}

test('diffDocs 칸 접기: 글만 든 칸이 아니면(칸 안 표·개체) 그 칸은 접지 않는다 — 다른 글 칸은 접고 table-structure 로 알림', async () => {
  const base = await nestedTableDoc();
  assert.deepEqual(base.paragraphs().filter((q) => q.ref.startsWith('s0/p1/')).map((q) => q.ref), ['s0/p1/n0', 's0/p1/n1', 's0/p1/n2', 's0/p1/n3', 's0/p1/n3/n0', 's0/p1/n3/n1', 's0/p1/n3/n2', 's0/p1/n3/n3']);
  // 칸 '가'(글만)는 나누고, 표를 품은 칸 '라'(기준 s0/p1/n3 — '가' 를 나눈 수정본에서는 s0/p1/n4)에도 문단을 하나 더 → '가' 만 접고 '라' 는 손대지 않는다
  let head = await setCellParas(await base.clone(), ['s0/p1/n0'], ['가', '가 둘째 줄']);
  assert.equal(head.text('s0/p1/n4'), '라');
  const { sec, p } = head.resolve('s0/p1/n4');
  const open = /^<hp:p\b[^>]*>/.exec(sec.xml.slice(p.start, p.end))[0];
  sec.load(sec.xml.slice(0, p.end) + `${open}<hp:run charPrIDRef="0"><hp:t>라 칸에 더한 문단</hp:t></hp:run></hp:p>` + sec.xml.slice(p.end));
  head = await reload(head);
  let r = await diffDocs(base, head);
  assert.deepEqual(r.hunks.map(strip), [{ type: 'replace', ref: 's0/p1/n0', baseText: '가', newText: '가\n가 둘째 줄', cell: { table: 's0/p1#t0', row: 0, col: 0 } }]);
  assert.deepEqual(ws(r.unsupported), [['s0/p1', 'table-structure']]);
  assert.match(r.unsupported[0].detail, /그 칸 글은 반영되지 않습니다/);
  // 본문 글도 고치면 그 replace 에 structure: true(일부 칸 글을 반영하지 못함)
  let head2 = await head.clone(); head2.mergeParagraphText('s0/p1', '표 앞 글(고침)뒤 글', { author }); head2.acceptAll(); head2 = await reload(head2);
  r = await diffDocs(base, head2);
  assert.deepEqual(r.hunks.map((h) => [h.ref, h.structure ?? false]), [['s0/p1', true], ['s0/p1/n0', false]]);
  // 칸 안 표의 칸(깊이 2)만 나누면: 바깥 칸 '라' 묶음의 모양이 달라 접지 않는다(바깥 칸 글 고침도 반영 안 됨) — 나머지 칸은 그대로
  const deep = await setCellParas(await base.clone(), ['s0/p1/n3/n1'], ['바', '바 둘째 줄']);
  r = await diffDocs(base, deep);
  assert.deepEqual([r.hunks, ws(r.unsupported)], [[], [['s0/p1', 'table-structure']]]);
  // 개체(그림)가 든 칸을 나누면 그 칸도 접지 않는다
  const plainBase = await tableDoc();
  let pic = await plainBase.clone(); injectObject(pic, 's0/p2/n3'); pic = await reload(pic);
  const picHead = await setCellParas(await pic.clone(), ['s0/p2/n3'], ['첫째 칸', ' 글입니다']);
  // (setCellParas 는 run 을 새로 써서 그림이 빠진다 — 그림을 첫 문단에 다시 넣어 '그림 + Enter' 모양으로)
  injectObject(picHead, 's0/p2/n3');
  const picHead2 = await reload(picHead);
  r = await diffDocs(pic, picHead2);
  assert.deepEqual([r.hunks, ws(r.unsupported)], [[], [['s0/p2', 'table-structure']]]);
});

test('diffDocs 칸 접기: 표 캡션(hp:caption — 칸이 아닌 중첩 문단) 문단 수가 바뀌면 예전처럼 반영하지 않는다(칸 글도 비교 없음)', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const base = await HwpxDoc.load(fs.readFileSync(BIZ));
  const cap = base.paragraphs().find((q) => q.ref === 's0/p3/n0');
  assert.ok(cap && !cap.cell, '표 캡션 문단(칸 아님)');
  let head = await setCellParas(await base.clone(), ['s0/p3/n0'], [cap.text, '캡션 둘째 문단']);
  head.mergeParagraphText('s0/p3/n9', '270', { author }); head.acceptAll(); head = await reload(head); // 칸 (1,1) 268 → 270(캡션이 늘어 n9)
  const r = await diffDocs(base, head);
  assert.deepEqual([r.hunks, ws(r.unsupported)], [[], [['s0/p3', 'table-structure']]]);
});

test('diffDocs 칸 접기: 무작위 칸 나누기·합치기·고치기 300번 — 적용한 칸 글을 이으면(줄바꿈 빼고) 수정본 칸 글과 같고 문단 수는 그대로', async () => {
  let seed = 20261023;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const words = ['가나', '다라마', '바사', '아자차카', '타파하', ' ', '1.', '(2)', ''];
  const base0 = await tableDoc();
  for (let n = 0; n < 300; n++) {
    const m = 1 + Math.floor(rnd() * 3);
    const bParts = Array.from({ length: m }, () => Array.from({ length: Math.floor(rnd() * 3) }, () => pick(words)).join(''));
    const base = await setCellParas(await base0.clone(), ['s0/p2/n3'], bParts);
    // 수정본: 기준 칸 글을 이은 뒤 무작위로 고치고 무작위 자리에서 나눈다(Enter)
    let all = bParts.join('\u0001');
    if (rnd() < 0.5) { const at = Math.floor(rnd() * (all.length + 1)); all = all.slice(0, at) + pick(words) + all.slice(at); }
    if (rnd() < 0.4) { const cut = all.indexOf('\u0001'); if (cut >= 0) all = all.slice(0, cut) + all.slice(cut + 1); } // Backspace 합침
    const k = Math.floor(rnd() * 3);
    for (let s = 0; s < k; s++) { const at = Math.floor(rnd() * (all.length + 1)); all = `${all.slice(0, at)}\u0001${all.slice(at)}`; }
    const hParts = all.split('\u0001');
    if (hParts.length === m && hParts.every((x, i) => x === bParts[i])) continue;
    const refs = Array.from({ length: m }, (_, i) => `s0/p2/n${3 + i}`);
    const head = await setCellParas(await base.clone(), refs, hParts);
    const r = await diffDocs(base, head);
    const label = JSON.stringify([bParts, hParts]);
    assert.deepEqual(r.unsupported, [], label);
    assert.ok(r.hunks.every((h) => h.type === 'replace' && h.cell && h.cell.row === 1 && h.cell.col === 1), label);
    const after = cellTexts(await applied(base, r.hunks), 's0/p2', 1, 1);
    assert.equal(after.length, m, `칸 문단 수 그대로 ${label}`);
    assert.equal(after.join('').replace(/\n/g, ''), hParts.join(''), `글 차례 그대로 ${label}`);
    // 줄(문단 경계 = '\n')도 차례 그대로 — 비운 기준 문단이 빈 줄을 더할 수 있어 빈 줄은 하나로 보고 맨 앞·끝 빈 줄은 뺀다
    const squash = (s) => s.replace(/\n+/g, '\n').replace(/^\n|\n$/g, '');
    assert.equal(squash(after.join('\n')), squash(hParts.join('\n')), `줄 ${label}`);
  }
});

test('diffDocs 칸 접기: 실제 보고서 표 칸을 나눔 — 다른 표·칸은 그대로', { skip: !hasBiz && 'biz 표본 없음' }, async () => {
  const base = await HwpxDoc.load(fs.readFileSync(BIZ));
  const cell = base.paragraphs().find((p) => p.ref === 's0/p3/n8');
  assert.deepEqual([cell.text, cell.cell.row, cell.cell.col], ['268', 1, 1]);
  const head = await setCellParas(await base.clone(), ['s0/p3/n8'], ['26', '8 (고침)']);
  const r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map(strip), r.unsupported], [[{ type: 'replace', ref: 's0/p3/n8', baseText: '268', newText: '26\n8 (고침)', cell: { table: 's0/p3#t0', row: 1, col: 1 } }], []]);
});

test('diffDocs 칸 접기: 편집기(rhwp) 내보내기 — 칸 안 Enter(splitParagraphInCell)·이어 치기·Backspace(mergeParagraphInCell), Shift+Enter 는 줄바꿈("\\n")', { skip: !hasRhwp && 'rhwp 없음' }, async () => {
  const mod = await rhwp();
  const base = await tableDoc('첫째 칸 글입니다'); // 편집기 작업본(최종본)
  const bytes = new Uint8Array(await base.save());
  const edit = async (fn) => { const d = new mod.HwpDocument(bytes.slice()); fn(d); return HwpxDoc.load(Buffer.from(d.exportHwpx())); };
  // 표 문단 = 본문 2, 표 = 컨트롤 0, 칸 (1,1) = 3번째 칸
  let head = await edit((d) => { d.splitParagraphInCell(0, 2, 0, 3, 0, 3); d.insertTextInCell(0, 2, 0, 3, 1, 0, '[이어 친 글]'); });
  assert.deepEqual(cellTexts(head, 's0/p2', 1, 1), ['첫째 ', '[이어 친 글]칸 글입니다']);
  let r = await diffDocs(base, head);
  assert.deepEqual([r.hunks.map(strip), r.unsupported], [[{ type: 'replace', ref: 's0/p2/n3', baseText: '첫째 칸 글입니다', newText: '첫째 \n[이어 친 글]칸 글입니다', cell: CELL11 }], []]);
  // 적용한 문서를 편집기가 읽으면 한 문단 안 '\n'(줄바꿈) — 다시 내보내도 같은 글
  const a = await applied(base, r.hunks);
  const ed = new mod.HwpDocument(new Uint8Array(await a.save()));
  const len = ed.getCellParagraphLength(0, 2, 0, 3, 0);
  assert.deepEqual([ed.getCellParagraphCount(0, 2, 0, 3), ed.getTextInCell(0, 2, 0, 3, 0, 0, len)], [1, '첫째 \n[이어 친 글]칸 글입니다']);
  const again = await HwpxDoc.load(Buffer.from(ed.exportHwpx()));
  assert.deepEqual(await diffDocs(a, again), { hunks: [], unsupported: [] });
  // Shift+Enter(insertText '\n')는 문단을 나누지 않는다 — 칸 글 replace(구조 그대로)
  head = await edit((d) => d.insertTextInCell(0, 2, 0, 3, 0, 3, '\n'));
  r = await diffDocs(base, head);
  assert.deepEqual(r.hunks.map((h) => [h.ref, h.newText]), [['s0/p2/n3', '첫째 \n칸 글입니다']]);
  // Backspace(칸 문단 합치기) — 나눈 기준에서
  const split = await edit((d) => d.splitParagraphInCell(0, 2, 0, 3, 0, 3));
  const sbytes = new Uint8Array(await split.save());
  const merged = new mod.HwpDocument(sbytes.slice()); merged.mergeParagraphInCell(0, 2, 0, 3, 1);
  r = await diffDocs(split, await HwpxDoc.load(Buffer.from(merged.exportHwpx())));
  // 합친 글은 앞 문단(Backspace 로 합친 자리)에 그대로, 뒤 문단은 비움
  assert.deepEqual([r.hunks.map((h) => [h.ref, h.newText]), r.unsupported], [[['s0/p2/n3', '첫째 칸 글입니다'], ['s0/p2/n4', '']], []]);
});
